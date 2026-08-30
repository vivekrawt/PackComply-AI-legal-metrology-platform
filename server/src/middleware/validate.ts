import type { Request, Response, NextFunction } from 'express';
import type { ZodSchema } from 'zod';
import { badRequest } from '../core/errors.js';

export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return next(badRequest('Validation failed', parsed.error.issues.map((i) => ({
        path: i.path.join('.'), message: i.message,
      }))));
    }
    req.body = parsed.data;
    next();
  };
}
