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

let timer: ReturnType<typeof setInterval> | null = null;
export function startWorker(db: DB) {
  if (timer) return;
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
