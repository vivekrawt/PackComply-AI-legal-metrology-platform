import type { DB } from '../../db/index.js';
import { now } from '../../db/index.js';
import { newId } from '../../core/ids.js';
import { hashPassword, verifyPassword, randomToken } from '../../core/crypto.js';
import { config } from '../../core/config.js';
import { recordAudit } from '../audit/service.js';
import { unauthorized, forbidden } from '../../core/errors.js';
import type { Role } from './permissions.js';

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

// Scope predicate (IAM-03): a user sees records within their org/state/district/office
// hierarchy, plus inspections assigned to them. Broad-scope roles (analyst broad scope,
// auditor approved scope, rule_admin, sys_admin) see the whole organization tree here;
// finer approved-scope configuration is a config_item.
export function scopeWhere(user: SessionUser, alias = 'i'): { sql: string; params: unknown[] } {
  if (user.role === 'sys_admin' || user.role === 'auditor' || user.role === 'analyst' || user.role === 'rule_admin') {
    return { sql: `${alias}.org_id = ?`, params: [user.orgId] };
  }
  const clauses: string[] = [`${alias}.org_id = ?`];
  const params: unknown[] = [user.orgId];
  if (user.state) { clauses.push(`${alias}.state = ?`); params.push(user.state); }
  if (user.district) { clauses.push(`${alias}.district = ?`); params.push(user.district); }
  if (user.office) { clauses.push(`${alias}.office = ?`); params.push(user.office); }
  return { sql: `((${clauses.join(' AND ')}) OR ${alias}.assigned_to = ?)`, params: [...params, user.id] };
}

export function assertInScope(db: DB, user: SessionUser, inspectionId: string) {
  const w = scopeWhere(user);
  const row = db
    .prepare(`SELECT i.id FROM inspections i WHERE i.id = ? AND ${w.sql}`)
    .get(inspectionId, ...w.params);
  if (!row) throw forbidden('Record is outside your authorized scope');
}
