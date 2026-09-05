import type { DB } from '../../db/index.js';
import { now } from '../../db/index.js';
import { newId } from '../../core/ids.js';
import { hashPassword, verifyPassword, randomToken } from '../../core/crypto.js';
import { config } from '../../core/config.js';
import { recordAudit } from '../audit/service.js';
import { unauthorized, forbidden, notFound, conflict } from '../../core/errors.js';
import { ROLE_PERMISSIONS, type Role } from './permissions.js';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  orgId: string;
  state: string | null;
  district: string | null;
  office: string | null;
}

export function createUser(
  db: DB,
  u: {
    email: string; name: string; password: string; role: Role; orgId: string;
    state?: string | null; district?: string | null; office?: string | null; status?: string;
  },
): string {
  const id = newId('usr');
  const t = now();
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, role, org_id, state, district, office, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, u.email.toLowerCase(), u.name, hashPassword(u.password), u.role, u.orgId,
    u.state ?? null, u.district ?? null, u.office ?? null, u.status ?? 'active', t, t);
  return id;
}

// Self-registration for field officers (the scan flow's entry point). Two
// deliberate constraints:
//
//   Role is always 'user'. Nobody can register themselves into review or
//   administrative authority — admin and super_admin accounts are created by an
//   existing super_admin through /admin/users.
//
//   Each signup gets its own organization. scopeWhere() widens to the whole org
//   for a user with no state/district/office set, so placing self-registered
//   accounts in a shared org would let every one of them read every other's
//   scans. A one-account org is the isolating default; an administrator can move
//   the account into the real agency org afterwards.
export function signup(
  db: DB,
  input: { email: string; name: string; password: string; organizationName?: string },
  ip?: string,
  correlationId?: string,
): { sessionId: string; user: SessionUser } {
  const email = input.email.toLowerCase().trim();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) throw conflict('An account already exists for this e-mail address');

  const orgId = newId('org');
  const t = now();
  db.transaction(() => {
    db.prepare('INSERT INTO organizations (id, name, kind, created_at) VALUES (?, ?, ?, ?)')
      .run(orgId, input.organizationName?.trim() || `${input.name} (self-registered)`, 'field', t);
    createUser(db, {
      email, name: input.name, password: input.password, role: 'user', orgId,
    });
  })();

  recordAudit(db, {
    actorLabel: email, action: 'auth.signup', outcome: 'success',
    objectType: 'user', objectId: email, after: { role: 'user', orgId },
    sourceIp: ip, correlationId,
  });
  // Sign the new officer straight in — the flow is signup, then scan.
  return login(db, email, input.password, ip, correlationId);
}

export function login(db: DB, email: string, password: string, ip?: string, correlationId?: string) {
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as any;
  const fail = () => {
    recordAudit(db, {
      actorLabel: email, action: 'auth.login', outcome: 'denied', sourceIp: ip, correlationId,
    });
    throw unauthorized('Invalid email or password');
  };
  if (!row || row.status !== 'active') fail();
  if (!verifyPassword(password, row.password_hash)) fail();

  // Concurrent-session limit (IAM-05): revoke oldest active sessions beyond the limit.
  const active = db
    .prepare('SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC')
    .all(row.id) as { id: string }[];
  for (const s of active.slice(config.session.maxConcurrent - 1)) {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(now(), s.id);
  }

  const sessionId = randomToken(32);
  const t = now();
  const absExp = new Date(Date.now() + config.session.absoluteHours * 3600_000).toISOString();
  db.prepare(
    'INSERT INTO sessions (id, user_id, created_at, last_seen_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(sessionId, row.id, t, t, absExp);
  recordAudit(db, {
    actorId: row.id, actorLabel: row.email, action: 'auth.login', outcome: 'success',
    sourceIp: ip, correlationId,
  });
  return { sessionId, user: toSessionUser(row) };
}

export function logout(db: DB, sessionId: string, user?: SessionUser) {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(now(), sessionId);
  if (user) recordAudit(db, { actorId: user.id, actorLabel: user.email, action: 'auth.logout' });
}

// Mirror the code-side permission matrix into role_permissions on every boot. The
// table is informational (checks use the code matrix) but must not drift after a
// role-model migration, so it is rebuilt rather than inserted-if-missing.
export function syncRolePermissions(db: DB) {
  db.transaction(() => {
    db.prepare('DELETE FROM role_permissions').run();
    const ins = db.prepare('INSERT OR IGNORE INTO role_permissions (role, permission) VALUES (?, ?)');
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) for (const p of perms) ins.run(role, p);
  })();
}

// Account removal (super_admin only). Users are referenced by inspections, findings,
// dispositions and the audit chain, so a hard DELETE would either fail on the foreign
// keys or orphan accountability. Offboarding is the delete: the account is
// deactivated, anonymised for sign-in, and every session is cut immediately.
export function deleteUser(db: DB, actor: SessionUser, userId: string) {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
  if (!target) throw notFound('User not found');
  if (target.id === actor.id) throw forbidden('You cannot delete your own account');
  if (target.status === 'offboarded') throw conflict('User is already offboarded');
  const t = now();
  db.transaction(() => {
    db.prepare(
      `UPDATE users SET status = 'offboarded', email = ?, password_hash = ?, updated_at = ? WHERE id = ?`,
    ).run(`deleted+${target.id}@invalid.local`, hashPassword(randomToken(24)), t, userId);
    revokeUserSessions(db, userId);
  })();
  recordAudit(db, {
    actorId: actor.id, actorLabel: actor.email, action: 'user.deleted',
    objectType: 'user', objectId: userId,
    before: { email: target.email, role: target.role, status: target.status },
    after: { status: 'offboarded' },
  });
}

export function revokeUserSessions(db: DB, userId: string) {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now(), userId);
}

export function resolveSession(db: DB, sessionId: string): SessionUser | null {
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as any;
  if (!s || s.revoked_at) return null;
  const t = Date.now();
  if (t > Date.parse(s.absolute_expires_at)) return null;
  if (t - Date.parse(s.last_seen_at) > config.session.inactivityMinutes * 60_000) return null;
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now(), sessionId);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id) as any;
  if (!u || u.status !== 'active') return null;
  return toSessionUser(u);
}

function toSessionUser(u: any): SessionUser {
  return {
    id: u.id, email: u.email, name: u.name, role: u.role,
    orgId: u.org_id, state: u.state, district: u.district, office: u.office,
  };
}

// Scope predicate (IAM-03): a `user` sees records within their own
// org/state/district/office hierarchy plus inspections assigned to them; `admin` and
// `super_admin` need the whole organization tree to review and administer it. Every
// caller of this predicate also excludes soft-deleted records, so a deleted inspection
// disappears from lists, search, analytics and scope checks in one place.
export function scopeWhere(user: SessionUser, alias = 'i'): { sql: string; params: unknown[] } {
  const live = `${alias}.deleted_at IS NULL`;
  if (user.role === 'admin' || user.role === 'super_admin') {
    return { sql: `(${alias}.org_id = ? AND ${live})`, params: [user.orgId] };
  }
  const clauses: string[] = [`${alias}.org_id = ?`];
  const params: unknown[] = [user.orgId];
  if (user.state) { clauses.push(`${alias}.state = ?`); params.push(user.state); }
  if (user.district) { clauses.push(`${alias}.district = ?`); params.push(user.district); }
  if (user.office) { clauses.push(`${alias}.office = ?`); params.push(user.office); }
  return {
    sql: `(((${clauses.join(' AND ')}) OR ${alias}.assigned_to = ?) AND ${live})`,
    params: [...params, user.id],
  };
}

export function assertInScope(db: DB, user: SessionUser, inspectionId: string) {
  const w = scopeWhere(user);
  const row = db
    .prepare(`SELECT i.id FROM inspections i WHERE i.id = ? AND ${w.sql}`)
    .get(inspectionId, ...w.params);
  if (row) return;
  // A soft-deleted record reads as gone, not as forbidden — otherwise the officer who
  // created it is told they lack authority over their own case. Out-of-scope records
  // still answer 403, which is what the scope-isolation tests assert.
  const deleted = db
    .prepare('SELECT deleted_at FROM inspections WHERE id = ?')
    .get(inspectionId) as { deleted_at: string | null } | undefined;
  if (deleted?.deleted_at) throw notFound('Inspection not found');
  throw forbidden('Record is outside your authorized scope');
}
