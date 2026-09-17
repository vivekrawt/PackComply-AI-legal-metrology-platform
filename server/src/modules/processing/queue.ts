import type { DB } from '../../db/index.js';
import { now } from '../../db/index.js';
import { newId } from '../../core/ids.js';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { recordAudit } from '../audit/service.js';

// DB-backed async job queue (NFR-RELIAB-01): queued → processing → completed |
// failed (retry w/ backoff) → dead_letter. Idempotency keys make resubmission safe.

export type JobHandler = (db: DB, job: JobRow) => Promise<void>;
export interface JobRow {
  id: string; type: string; target_id: string; status: string; attempts: number;
  max_attempts: number; idempotency_key: string; correlation_id: string;
}

const handlers = new Map<string, JobHandler>();
export function registerHandler(type: string, h: JobHandler) {
  handlers.set(type, h);
}

export function enqueueJob(
  db: DB,
  j: { type: string; targetId: string; idempotencyKey: string; correlationId?: string; requestedBy?: string },
): { jobId: string; deduplicated: boolean } {
  const existing = db
    .prepare("SELECT id, status FROM processing_jobs WHERE idempotency_key = ?")
    .get(j.idempotencyKey) as any;
  if (existing && existing.status !== 'failed' && existing.status !== 'dead_letter' && existing.status !== 'cancelled') {
    return { jobId: existing.id, deduplicated: true }; // refresh/retry never duplicates work
  }
  const id = newId('job');
  const t = now();
  db.prepare(
    `INSERT INTO processing_jobs (id, type, target_id, status, attempts, max_attempts, idempotency_key,
       correlation_id, requested_by, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(idempotency_key) DO UPDATE SET status='queued', attempts=0, error=NULL, updated_at=excluded.updated_at`,
  ).run(id, j.type, j.targetId, config.jobs.maxAttempts, j.idempotencyKey,
    j.correlationId ?? newId('cor'), j.requestedBy ?? null, t, t);
  return { jobId: existing?.id ?? id, deduplicated: false };
}

export async function runPendingJobs(db: DB): Promise<number> {
  const jobs = db
    .prepare("SELECT * FROM processing_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 5")
    .all() as JobRow[];
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
  set("status = 'processing', attempts = attempts + 1, progress = 10");
  try {
    await h(db, job);
    set("status = 'completed', progress = 100, error = NULL");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = (db.prepare('SELECT attempts, max_attempts FROM processing_jobs WHERE id = ?').get(job.id) as any);
    if (attempts.attempts >= attempts.max_attempts) {
      set("status = 'dead_letter', error = ?", message);
      recordAudit(db, {
        actorLabel: 'system', action: 'processing.job_dead_letter', objectType: 'processing_job',
        objectId: job.id, after: { type: job.type, error: message }, outcome: 'failure',
        correlationId: job.correlation_id,
      });
    } else {
      set("status = 'queued', error = ?", message); // simple retry; backoff via poll interval
    }
    logger.error('job failed', { jobId: job.id, type: job.type, error: message });
  }
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
