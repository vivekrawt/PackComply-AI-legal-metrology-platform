import type { DB } from '../../db/index.js';
import { now } from '../../db/index.js';
import { newId } from '../../core/ids.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { recordAudit } from '../audit/service.js';
import type { SessionUser } from '../auth/service.js';

// Teams: the unit an admin reviews and an auditor works in.
//
// An organization is the tenant. A team is a group of auditors with one or more
// admins over them, and it is what routes a captured scan to the right reviewer.
// Only super_admin creates teams or moves people between them; an admin may read
// its own team so it can see who reports to it.

export interface TeamInput {
  name: string;
  description?: string | null;
}

export function teamRowToDto(t: any) {
  return {
    id: t.id,
    orgId: t.org_id,
    name: t.name,
    description: t.description ?? null,
    status: t.status,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    adminCount: t.admin_count ?? undefined,
    auditorCount: t.auditor_count ?? undefined,
  };
}

const MEMBER_COUNTS = `
  (SELECT COUNT(*) FROM users mu WHERE mu.team_id = t.id AND mu.role = 'admin'
     AND mu.status != 'offboarded') AS admin_count,
  (SELECT COUNT(*) FROM users mu WHERE mu.team_id = t.id AND mu.role = 'user'
     AND mu.status != 'offboarded') AS auditor_count`;

export function listTeams(db: DB, user: SessionUser) {
  // An admin sees the team it belongs to and nothing else, matching the scope its
  // queue already enforces.
  if (user.role === 'admin') {
    if (!user.teamId) return [];
    const row = db.prepare(
      `SELECT t.*, ${MEMBER_COUNTS} FROM teams t WHERE t.id = ? AND t.org_id = ?`,
    ).get(user.teamId, user.orgId) as any;
    return row ? [teamRowToDto(row)] : [];
  }
  const rows = db.prepare(
    `SELECT t.*, ${MEMBER_COUNTS} FROM teams t WHERE t.org_id = ? ORDER BY t.status, t.name`,
  ).all(user.orgId) as any[];
  return rows.map(teamRowToDto);
}

export function getTeam(db: DB, user: SessionUser, teamId: string) {
  const row = db.prepare(
    `SELECT t.*, ${MEMBER_COUNTS} FROM teams t WHERE t.id = ? AND t.org_id = ?`,
  ).get(teamId, user.orgId) as any;
  if (!row) throw notFound('Team not found');
  if (user.role === 'admin' && user.teamId !== teamId) {
    throw forbidden('You can only view your own team');
  }
  return teamRowToDto(row);
}

export function teamMembers(db: DB, orgId: string, teamId: string) {
  const rows = db.prepare(
    `SELECT id, email, name, role, status, state, district, office, created_at
       FROM users WHERE team_id = ? AND org_id = ? AND status != 'offboarded'
      ORDER BY role, name`,
  ).all(teamId, orgId) as any[];
  return {
    admins: rows.filter((r) => r.role === 'admin'),
    auditors: rows.filter((r) => r.role === 'user'),
  };
}

export function createTeam(db: DB, actor: SessionUser, input: TeamInput, correlationId?: string) {
  const name = input.name.trim();
  if (!name) throw badRequest('A team name is required');
  const clash = db.prepare(
    'SELECT id FROM teams WHERE org_id = ? AND lower(name) = lower(?)',
  ).get(actor.orgId, name);
  if (clash) throw conflict(`A team named '${name}' already exists`);

  const id = newId('team');
  const t = now();
  db.prepare(
    `INSERT INTO teams (id, org_id, name, description, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
  ).run(id, actor.orgId, name, input.description?.trim() || null, actor.id, t, t);

  recordAudit(db, {
    actorId: actor.id, actorLabel: actor.email, action: 'team.created',
    objectType: 'team', objectId: id, after: { name, description: input.description ?? null },
    correlationId,
  });
  return getTeam(db, actor, id);
}

export function updateTeam(
  db: DB, actor: SessionUser, teamId: string,
  patch: { name?: string; description?: string | null; status?: string },
  correlationId?: string,
) {
  const before = db.prepare('SELECT * FROM teams WHERE id = ? AND org_id = ?')
    .get(teamId, actor.orgId) as any;
  if (!before) throw notFound('Team not found');
  if (patch.status && !['active', 'archived'].includes(patch.status)) {
    throw badRequest("Team status must be 'active' or 'archived'");
  }
  // Archiving a team that still has people in it would hide their work from every
  // queue while leaving them able to produce more of it.
  if (patch.status === 'archived') {
    const members = (db.prepare(
      "SELECT COUNT(*) AS c FROM users WHERE team_id = ? AND status != 'offboarded'",
    ).get(teamId) as any).c as number;
    if (members > 0) {
      throw conflict(
        `This team still has ${members} member(s). Move them to another team before archiving it.`,
      );
    }
  }
  db.prepare(
    `UPDATE teams SET name = COALESCE(?, name), description = COALESCE(?, description),
       status = COALESCE(?, status), updated_at = ? WHERE id = ?`,
  ).run(patch.name?.trim() ?? null, patch.description ?? null, patch.status ?? null, now(), teamId);

  recordAudit(db, {
    actorId: actor.id, actorLabel: actor.email, action: 'team.updated',
    objectType: 'team', objectId: teamId,
    before: { name: before.name, description: before.description, status: before.status },
    after: patch, correlationId,
  });
  return getTeam(db, actor, teamId);
}

// Moving someone between teams changes whose queue their work lands in, so it is
// audited like any other authority change.
export function assignUserToTeam(
  db: DB, actor: SessionUser, userId: string, teamId: string | null, correlationId?: string,
) {
  const target = db.prepare('SELECT id, role, org_id, team_id, name FROM users WHERE id = ?')
    .get(userId) as any;
  if (!target) throw notFound('User not found');
  if (target.org_id !== actor.orgId) throw forbidden('That user is in another organization');
  if (target.role === 'super_admin') {
    throw badRequest('A super administrator sits above the teams and is not assigned to one');
  }
  if (teamId) {
    const team = db.prepare('SELECT id FROM teams WHERE id = ? AND org_id = ?')
      .get(teamId, actor.orgId);
    if (!team) throw notFound('Team not found');
    // A team has exactly one admin, so "the admin of this team" is always an
    // unambiguous person and an auditor always knows who reviews their work.
    if (target.role === 'admin') {
      const sitting = db.prepare(
        `SELECT name FROM users WHERE team_id = ? AND role = 'admin' AND id <> ?
           AND status != 'offboarded'`,
      ).get(teamId, userId) as { name: string } | undefined;
      if (sitting) {
        throw conflict(
          `${sitting.name} already runs this team, and a team has one admin. `
          + 'Move them off it first, or choose another team.',
        );
      }
    }
  }
  db.prepare('UPDATE users SET team_id = ?, updated_at = ? WHERE id = ?')
    .run(teamId, now(), userId);

  recordAudit(db, {
    actorId: actor.id, actorLabel: actor.email, action: 'team.member_assigned',
    objectType: 'user', objectId: userId,
    before: { teamId: target.team_id }, after: { teamId },
    correlationId,
  });
  return { ok: true };
}
