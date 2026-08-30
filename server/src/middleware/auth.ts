import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index.js';
import { resolveSession } from '../modules/auth/service.js';
import { roleHas, type Permission } from '../modules/auth/permissions.js';
import { unauthorized, forbidden } from '../core/errors.js';
import { recordAudit } from '../modules/audit/service.js';

export const SESSION_COOKIE = 'packcomply_session';

export function loadSession(req: Request, _res: Response, next: NextFunction) {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (sid) {
    const user = resolveSession(getDb(), sid);
    if (user) {
      req.user = user;
      req.sessionId = sid;
    }
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  next();
}

// Server-side permission enforcement (IAM-02). Denials are audited (IAM-07).
export function requirePerm(perm: Permission) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roleHas(req.user.role, perm)) {
      recordAudit(getDb(), {
        actorId: req.user.id, actorLabel: req.user.email, action: 'authz.denied',
        objectType: 'permission', objectId: perm, outcome: 'denied',
        sourceIp: req.ip, correlationId: req.correlationId,
      });
      return next(forbidden(`Permission '${perm}' is required`));
    }
    next();
  };
}

// CSRF defence: mutations must carry a custom header (paired with SameSite=Lax cookie).
export function csrfHeader(req: Request, _res: Response, next: NextFunction) {
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (mutating && req.headers['x-requested-with'] !== 'packcomply') {
    return next(forbidden('Missing X-Requested-With header'));
  }
  next();
}
