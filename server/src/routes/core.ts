import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { now } from '../db/index.js';
import { login, logout, createUser, revokeUserSessions, deleteUser } from '../modules/auth/service.js';
import { SESSION_COOKIE, requireAuth, requirePerm } from '../middleware/auth.js';
import { rateLimit } from '../middleware/security.js';
import { validateBody } from '../middleware/validate.js';
import { config } from '../core/config.js';
import { recordAudit, verifyAuditChain } from '../modules/audit/service.js';
import { badRequest, forbidden, notFound } from '../core/errors.js';
import { ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, ROLE_PERMISSIONS } from '../modules/auth/permissions.js';
import { getConfigItem, setConfigItem } from '../modules/admin/configService.js';
import { anyMock, mockComponents, providerModelVersions } from '../providers/registry.js';

export const coreRouter = Router();

// ---- Auth -------------------------------------------------------------------
coreRouter.post(
  '/auth/login',
  rateLimit(config.rateLimit.loginMax, 'login'),
  validateBody(z.object({ email: z.string().email(), password: z.string().min(1) })),
  (req, res) => {
    const { sessionId, user } = login(getDb(), req.body.email, req.body.password, req.ip, req.correlationId);
    res.cookie(SESSION_COOKIE, sessionId, {
      httpOnly: true, sameSite: 'lax', secure: config.env === 'production',
      maxAge: config.session.absoluteHours * 3600_000, path: '/',
    });
    res.json({ user, demoProviders: anyMock(), mockComponents: mockComponents() });
  },
);

coreRouter.post('/auth/logout', (req, res) => {
  if (req.sessionId) logout(getDb(), req.sessionId, req.user);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

coreRouter.get('/auth/me', requireAuth, (req, res) => {
  res.json({
    user: req.user, demoProviders: anyMock(), mockComponents: mockComponents(),
    modelVersions: providerModelVersions(),
    // The client renders navigation from the server's matrix rather than a second
    // hard-coded copy of it; server-side requirePerm remains the actual gate.
    permissions: ROLE_PERMISSIONS[req.user!.role] ?? [],
  });
});

// Role catalogue for the admin UI (labels, descriptions, permission sets).
coreRouter.get('/roles', requireAuth, (_req, res) => {
  res.json({
    roles: ROLES.map((r) => ({
      role: r, label: ROLE_LABELS[r], description: ROLE_DESCRIPTIONS[r], permissions: ROLE_PERMISSIONS[r],
    })),
  });
});

// ---- User administration (IAM-04) ------------------------------------------
coreRouter.get('/admin/users', requireAuth, requirePerm('admin.users'), (req, res) => {
  const rows = getDb().prepare(
    `SELECT u.id, u.email, u.name, u.role, u.org_id, u.team_id, t.name AS team_name,
            u.state, u.district, u.office, u.status, u.created_at
       FROM users u LEFT JOIN teams t ON t.id = u.team_id
      WHERE u.org_id = ? ORDER BY u.created_at`,
  ).all(req.user!.orgId);
  res.json({ users: rows });
});

coreRouter.post(
  '/admin/users',
  requireAuth, requirePerm('admin.users'),
  validateBody(z.object({
    email: z.string().email(), name: z.string().min(1), password: z.string().min(10),
    role: z.enum(ROLES), teamId: z.string().nullable().optional(),
    state: z.string().optional(), district: z.string().optional(), office: z.string().optional(),
  })),
  (req, res) => {
    const db = getDb();
    // A super administrator is above the teams; anyone else needs one, or their work
    // (or their queue) reaches nobody.
    const teamId = req.body.role === 'super_admin' ? null : (req.body.teamId ?? null);
    if (teamId) {
      const team = db.prepare('SELECT id FROM teams WHERE id = ? AND org_id = ?')
        .get(teamId, req.user!.orgId);
      if (!team) throw badRequest('That team does not exist in your organization');
    }
    const id = createUser(db, { ...req.body, teamId, orgId: req.user!.orgId });
    recordAudit(db, {
      actorId: req.user!.id, actorLabel: req.user!.email, action: 'user.created',
      objectType: 'user', objectId: id, after: { email: req.body.email, role: req.body.role, teamId },
      correlationId: req.correlationId,
    });
    res.status(201).json({ id });
  },
);

coreRouter.patch(
  '/admin/users/:id',
  requireAuth, requirePerm('admin.users'),
  validateBody(z.object({
    status: z.enum(['active', 'suspended', 'offboarded']).optional(),
    role: z.enum(ROLES).optional(),
    state: z.string().nullable().optional(), district: z.string().nullable().optional(), office: z.string().nullable().optional(),
  })),
  (req, res) => {
    const db = getDb();
    const before = db.prepare('SELECT id, role, status, state, district, office FROM users WHERE id = ?').get(req.params.id) as any;
    if (!before) throw notFound('User not found');
    db.prepare(
      `UPDATE users SET status = COALESCE(?, status), role = COALESCE(?, role),
         state = COALESCE(?, state), district = COALESCE(?, district), office = COALESCE(?, office), updated_at = ?
       WHERE id = ?`,
    ).run(req.body.status ?? null, req.body.role ?? null, req.body.state ?? null,
      req.body.district ?? null, req.body.office ?? null, now(), req.params.id);
    if (req.body.status === 'suspended' || req.body.status === 'offboarded') {
      revokeUserSessions(db, req.params.id); // MOB-02: remote sign-out
    }
    recordAudit(db, {
      actorId: req.user!.id, actorLabel: req.user!.email, action: 'user.updated',
      objectType: 'user', objectId: req.params.id, before, after: req.body, correlationId: req.correlationId,
    });
    res.json({ ok: true });
  },
);

// Account deletion (DEL-01, super_admin only). Offboards and anonymises rather than
// dropping the row — see deleteUser(): the account is referenced by the audit chain.
coreRouter.delete('/admin/users/:id', requireAuth, requirePerm('admin.users.delete'), (req, res) => {
  deleteUser(getDb(), req.user!, req.params.id);
  res.json({ ok: true });
});

coreRouter.post('/admin/users/:id/revoke-sessions', requireAuth, requirePerm('admin.users'), (req, res) => {
  revokeUserSessions(getDb(), req.params.id);
  recordAudit(getDb(), {
    actorId: req.user!.id, actorLabel: req.user!.email, action: 'user.sessions_revoked',
    objectType: 'user', objectId: req.params.id, correlationId: req.correlationId,
  });
  res.json({ ok: true });
});

// ---- Config (ADM-02, NFR-MAINT-01) -----------------------------------------
coreRouter.get('/admin/config/:key', requireAuth, requirePerm('admin.config'), (req, res) => {
  res.json({ key: req.params.key, value: getConfigItem(getDb(), req.params.key) });
});
coreRouter.put('/admin/config/:key', requireAuth, requirePerm('admin.config'), (req, res) => {
  if (req.body?.value === undefined) throw badRequest('Body must contain { value }');
  setConfigItem(getDb(), req.params.key, req.body.value, req.user);
  res.json({ ok: true });
});

// ---- Model registry (ADM-03) ------------------------------------------------
coreRouter.get('/models', requireAuth, requirePerm('models.read'), (_req, res) => {
  res.json({ models: getDb().prepare('SELECT * FROM model_versions ORDER BY component, version').all() });
});

// ---- Audit log (IAM-07) -----------------------------------------------------
coreRouter.get('/audit', requireAuth, requirePerm('audit.read'), (req, res) => {
  const db = getDb();
  const { objectType, objectId, actorId, limit } = req.query as Record<string, string>;
  const clauses = ['1=1'];
  const params: unknown[] = [];
  if (objectType) { clauses.push('object_type = ?'); params.push(objectType); }
  if (objectId) { clauses.push('object_id = ?'); params.push(objectId); }
  if (actorId) { clauses.push('actor_id = ?'); params.push(actorId); }
  const rows = db.prepare(
    `SELECT seq, id, actor_id, actor_label, action, object_type, object_id, before_json, after_json,
       outcome, source_ip, correlation_id, created_at, event_hash
     FROM audit_events WHERE ${clauses.join(' AND ')} ORDER BY seq DESC LIMIT ?`,
  ).all(...params, Math.min(Number(limit ?? 200), 1000));
  // Reads of the audit log are themselves auditable administrative access.
  recordAudit(db, {
    actorId: req.user!.id, actorLabel: req.user!.email, action: 'audit.read',
    after: { filter: { objectType, objectId, actorId } }, correlationId: req.correlationId,
  });
  res.json({ events: rows });
});

coreRouter.get('/audit/verify', requireAuth, requirePerm('audit.read'), (_req, res) => {
  res.json(verifyAuditChain(getDb()));
});

// ---- Health / metrics -------------------------------------------------------
coreRouter.get('/health', (_req, res) => res.json({ ok: true, ts: now() }));
coreRouter.get('/admin/metrics', requireAuth, requirePerm('admin.config'), (_req, res) => {
  const db = getDb();
  res.json({
    inspections: (db.prepare('SELECT COUNT(*) c FROM inspections').get() as any).c,
    jobs: db.prepare('SELECT status, COUNT(*) c FROM processing_jobs GROUP BY status').all(),
    audit: (db.prepare('SELECT COUNT(*) c FROM audit_events').get() as any).c,
  });
});

// Explicit deny helper for probing users (mirrors UAT-10 expectations).
coreRouter.get('/admin', requireAuth, (_req, _res) => { throw forbidden(); });
