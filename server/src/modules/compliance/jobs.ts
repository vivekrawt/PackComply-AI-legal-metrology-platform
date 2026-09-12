import type { DB } from '../../db/index.js';
import { registerHandler, type JobRow } from '../processing/queue.js';
import { runEvaluation } from '../evaluation/service.js';
import type { SessionUser } from '../auth/service.js';
import { logger } from '../../core/logger.js';
import { judgeCompliance } from './service.js';

// The final job in the scan pipeline. It is enqueued after the per-image OCR jobs
// and the declaration extraction job, so by the time it runs the OCR text exists.
//
// Two assessments run here, in order and both retained:
//   1. the deterministic rule engine, which produces the citation-backed findings
//      the report and the admin workbench are built on;
//   2. the compliance judge (LLM), which reads the OCR text against the statutory
//      corpus and produces the officer-facing verdict.
// The judge sees the engine's output as labeled cross-check material. Neither
// overwrites the other.

function actorFor(db: DB, userId: string | null): SessionUser | null {
  if (!userId) return null;
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
  if (!u) return null;
  return {
    id: u.id, email: u.email, name: u.name, role: u.role,
    orgId: u.org_id, teamId: u.team_id ?? null,
    state: u.state, district: u.district, office: u.office,
  };
}

async function judgeComplianceJob(db: DB, job: JobRow) {
  const inspectionId = job.target_id;
  const requestedBy = (db.prepare('SELECT requested_by FROM processing_jobs WHERE id = ?')
    .get(job.id) as any)?.requested_by ?? null;
  const actor = actorFor(db, requestedBy);

  // The deterministic engine must not be able to fail the whole scan: its findings
  // are supporting material here, and the officer still needs the AI verdict on the
  // evidence they captured.
  if (actor) {
    try {
      await runEvaluation(db, actor, inspectionId, job.correlation_id);
    } catch (err) {
      logger.error('rule evaluation failed during scan; continuing to compliance judge', {
        inspectionId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await judgeCompliance(db, inspectionId, actor, job.correlation_id);
}

export function registerComplianceHandlers() {
  registerHandler('judge_compliance', judgeComplianceJob);
}
