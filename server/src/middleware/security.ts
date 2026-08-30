import type { Request, Response, NextFunction } from 'express';
import { config } from '../core/config.js';
import { AppError } from '../core/errors.js';

// Simple in-memory sliding-window rate limiter (swap for a shared store when scaled out).
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(max: number, keyPrefix = 'g') {
  return (req: Request, _res: Response, next: NextFunction) => {
    const key = `${keyPrefix}:${req.ip}`;
    const nowMs = Date.now();
    let b = buckets.get(key);
    if (!b || nowMs > b.resetAt) {
      b = { count: 0, resetAt: nowMs + config.rateLimit.windowMs };
      buckets.set(key, b);
    }
    b.count++;
    if (b.count > max) return next(new AppError(429, 'RATE_LIMITED', 'Too many requests, slow down'));
    next();
  };
}
