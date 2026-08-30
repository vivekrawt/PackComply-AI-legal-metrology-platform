import type { Request, Response, NextFunction } from 'express';
import { newId } from '../core/ids.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      correlationId: string;
      user?: import('../modules/auth/service.js').SessionUser;
      sessionId?: string;
    }
  }
}

export function requestContext(req: Request, res: Response, next: NextFunction) {
  req.correlationId = (req.headers['x-correlation-id'] as string) || newId('cor');
  res.setHeader('X-Correlation-Id', req.correlationId);
  next();
}
