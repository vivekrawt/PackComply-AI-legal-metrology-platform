import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../core/errors.js';
import { logger } from '../core/logger.js';

// Central structured error handler (INT-01 structured errors).
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details ?? undefined },
      correlationId: req.correlationId,
    });
    return;
  }
  logger.error('unhandled error', {
    correlationId: req.correlationId,
    path: req.path,
    error: err instanceof Error ? err.stack : String(err),
  });
  res.status(500).json({
    error: { code: 'INTERNAL', message: 'Internal server error' },
    correlationId: req.correlationId,
  });
}
