import type { DB } from '../../db/index.js';
import { now } from '../../db/index.js';
import { newId } from '../../core/ids.js';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { isTransient } from '../../core/errors.js';
import { recordAudit } from '../audit/service.js';

// DB-backed async job queue (NFR-RELIAB-01): queued → processing → completed |
// failed (retry w/ backoff) → dead_letter. Idempotency keys make resubmission safe.

export type JobHandler = (db: DB, job: JobRow) => Promise<void>;
export interface JobRow {
  id: string; type: string; target_id: string; status: string; attempts: number;
  max_attempts: number; idempotency_key: string; correlation_id: string;
  created_at: string;
}

// A job may depend on other jobs having settled first. Enqueue order used to be
// enough - the OCR jobs were created before the judge and ran in creation order -
// but a job that can be rescheduled can be overtaken, and a judge that overtakes
// the OCR it is supposed to read assesses a package nobody has read yet.
//
// `ready` is asked before the job is marked 'processing'. Returning a reason defers
// it without spending an attempt: the work has not failed, it is simply not due.
export interface HandlerOptions {
  ready?: (db: DB, job: JobRow) => string | null;
  // How long to wait before asking again, and how long to keep asking. The ceiling
  // matters: whatever it is waiting for may never settle, and a verdict that is
  // late is better than a scan that is never assessed at all.
  deferMs?: number;
  maxDeferMs?: number;
}

const handlers = new Map<string, JobHandler>();
const handlerOptions = new Map<string, HandlerOptions>();
export function registerHandler(type: string, h: JobHandler, opts?: HandlerOptions) {
  handlers.set(type, h);
  if (opts) handlerOptions.set(type, opts);
}

export function enqueueJob(
  db: DB,
  j: { type: string; targetId: string; idempotencyKey: string; correlationId?: string; requestedBy?: string },
): { jobId: string; deduplicated: boolean } {
  const existing = db
    .prepare("SELECT id, status FROM processing_jobs WHERE idempotency_key = ?")
    .get(j.idempotencyKey) as any;
  if (existing && existing.status !== 'failed' && existing.status !== 'dead_letter' && existing.status !== 'cancelled') {
    // Asking for the work again cancels any backoff it is sitting out. Someone who
    // has just restarted the OCR service and pressed re-analyse should not wait out
    // a minute that was only ever there to avoid hammering a service that was down.
    if (existing.status === 'queued') {
      db.prepare('UPDATE processing_jobs SET next_attempt_at = NULL, updated_at = ? WHERE id = ?')
        .run(now(), existing.id);
    }
    return { jobId: existing.id, deduplicated: true }; // refresh/retry never duplicates work
  }
  const id = newId('job');
  const t = now();
  db.prepare(
    `INSERT INTO processing_jobs (id, type, target_id, status, attempts, max_attempts, idempotency_key,
       correlation_id, requested_by, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(idempotency_key) DO UPDATE SET status='queued', attempts=0, error=NULL,
       next_attempt_at=NULL, updated_at=excluded.updated_at`,
  ).run(id, j.type, j.targetId, config.jobs.maxAttempts, j.idempotencyKey,
    j.correlationId ?? newId('cor'), j.requestedBy ?? null, t, t);
  return { jobId: existing?.id ?? id, deduplicated: false };
}

export async function runPendingJobs(db: DB): Promise<number> {
  // next_attempt_at is when a failed job becomes runnable again; NULL is now.
  const jobs = db
    .prepare(
      `SELECT * FROM processing_jobs
        WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY created_at LIMIT 5`,
    )
    .all(now()) as JobRow[];
  for (const job of jobs) {
    await runJob(db, job);
  }
  return jobs.length;
}

async function runJob(db: DB, job: JobRow) {
  const h = handlers.get(job.type);
  const set = (fields: string, ...params: unknown[]) =>
    db.prepare(`UPDATE processing_jobs SET ${fields}, updated_at = ? WHERE id = ?`).run(...params, now(), job.id);
  if (!h) {
    set("status = 'dead_letter', error = ?", `No handler for job type ${job.type}`);
    return;
  }
  const opts = handlerOptions.get(job.type);
  const waitingFor = opts?.ready?.(db, job) ?? null;
  if (waitingFor) {
    const age = Date.now() - Date.parse(job.created_at);
    const ceiling = opts?.maxDeferMs ?? 20 * 60_000;
    if (age < ceiling) {
      // Not an attempt: nothing was tried, so nothing is spent.
      set(
        "status = 'queued', error = ?, next_attempt_at = ?",
        `Waiting: ${waitingFor}`,
        new Date(Date.now() + (opts?.deferMs ?? 3_000)).toISOString(),
      );
      return;
    }
    logger.warn('job waited long enough; running anyway', {
      jobId: job.id, type: job.type, waitingFor, waitedMs: age,
    });
  }

  set("status = 'processing', attempts = attempts + 1, progress = 10, next_attempt_at = NULL");
  try {
    await h(db, job);
    set("status = 'completed', progress = 100, error = NULL");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A dependency being down is not this job's fault and says nothing about
    // whether the work can succeed, so it is given a longer rope and a longer
    // wait: retrying a restarting OCR service every 400ms only spends the budget
    // without ever giving it a chance to answer.
    const transient = isTransient(err);
    const { attempts, max_attempts: max } = db
      .prepare('SELECT attempts, max_attempts FROM processing_jobs WHERE id = ?')
      .get(job.id) as { attempts: number; max_attempts: number };
    const limit = transient ? Math.max(max, config.jobs.transientMaxAttempts) : max;

    if (attempts >= limit) {
      set("status = 'dead_letter', error = ?", message);
      recordAudit(db, {
        actorLabel: 'system', action: 'processing.job_dead_letter', objectType: 'processing_job',
        objectId: job.id, after: { type: job.type, error: message, transient }, outcome: 'failure',
        correlationId: job.correlation_id,
      });
    } else {
      const waitMs = backoffFor(attempts, transient);
      set(
        "status = 'queued', error = ?, next_attempt_at = ?",
        message, new Date(Date.now() + waitMs).toISOString(),
      );
      logger.warn('job retry scheduled', {
        jobId: job.id, type: job.type, attempt: attempts, of: limit, transient, waitMs,
      });
    }
    logger.error('job failed', { jobId: job.id, type: job.type, transient, error: message });
  }
}

// Exponential, doubling per attempt, capped. Exported so the schedule can be
// asserted rather than inferred from wall-clock timing in a test.
export function backoffFor(attempts: number, transient: boolean): number {
  const base = transient ? config.jobs.transientBackoffMs : config.jobs.backoffMs;
  const cap = transient ? config.jobs.transientBackoffCapMs : config.jobs.backoffCapMs;
  return Math.min(base * 2 ** Math.max(0, attempts - 1), cap);
}

// Jobs the last process died holding. One worker runs at a time and it marks a job
// 'processing' only while it is actually in the handler, so nothing can legitimately
// be in that state at startup - every such row belongs to a process that is gone.
// Left alone they are invisible forever: runPendingJobs only ever selects 'queued',
// and a scan with one orphan reports 'analyzing' for the rest of its life even when
// its verdict was written.
//
// The attempt is already spent, so it is not re-counted. A job whose handler kills
// the process never reaches the catch in runJob, so it never dead-letters on its
// own; checking the count here is what stops a poison image from crash-looping the
// server on every boot.
export function reclaimStaleJobs(db: DB): number {
  const stale = db.prepare(
    "SELECT id, type, target_id, attempts, max_attempts FROM processing_jobs WHERE status = 'processing'",
  ).all() as Pick<JobRow, 'id' | 'type' | 'target_id' | 'attempts' | 'max_attempts'>[];
  for (const job of stale) {
    const spent = job.attempts >= job.max_attempts;
    const error = `Interrupted: the worker process ended while this job was running (attempt ${job.attempts} of ${job.max_attempts})`;
    db.prepare(
      `UPDATE processing_jobs SET status = ?, error = ?, progress = 0, updated_at = ? WHERE id = ?`,
    ).run(spent ? 'dead_letter' : 'queued', error, now(), job.id);
    logger.warn('reclaimed interrupted job', {
      jobId: job.id, type: job.type, targetId: job.target_id,
      attempts: job.attempts, outcome: spent ? 'dead_letter' : 'requeued',
    });
    if (spent) {
      recordAudit(db, {
        actorLabel: 'system', action: 'processing.job_dead_letter', objectType: 'processing_job',
        objectId: job.id, after: { type: job.type, error }, outcome: 'failure',
      });
    }
  }
  return stale.length;
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startWorker(db: DB) {
  if (timer) return;
  reclaimStaleJobs(db);
  let busy = false;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await runPendingJobs(db); } finally { busy = false; }
  }, config.jobs.pollMs);
  timer.unref?.();
  logger.info('job worker started', { pollMs: config.jobs.pollMs });
}
export function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

// Test/synchronous helper: drain the queue completely.
export async function drainJobs(db: DB, maxRounds = 20) {
  for (let i = 0; i < maxRounds; i++) {
    const n = await runPendingJobs(db);
    if (n === 0) return;
  }
}
