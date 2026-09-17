export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', msg, details);
export const unauthorized = (msg = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'Not permitted') => new AppError(403, 'FORBIDDEN', msg);
export const notFound = (msg = 'Not found') => new AppError(404, 'NOT_FOUND', msg);
export const conflict = (msg: string) => new AppError(409, 'CONFLICT', msg);
export const unprocessable = (msg: string, details?: unknown) => new AppError(422, 'UNPROCESSABLE', msg, details);

// A failure of the world around the work rather than of the work itself: a service
// that is down or restarting, a timeout, a rate limit. The distinction matters to
// the job queue, which must not spend a job's retry budget in a few seconds on a
// dependency that takes a minute to come back - the image was always fine, and
// dead-lettering it loses a face of a package for good.
export class TransientError extends Error {
  readonly transient = true;
  constructor(message: string) { super(message); this.name = 'TransientError'; }
}

export const isTransient = (err: unknown): boolean =>
  !!err && typeof err === 'object' && (err as { transient?: unknown }).transient === true;
