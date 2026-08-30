import type { DB } from '../../db/index.js';
import { now } from '../../db/index.js';
import { newId } from '../../core/ids.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { recordAudit } from '../audit/service.js';
import type { SessionUser } from '../auth/service.js';
import { assertMutableInspection } from '../evidence/service.js';
import { getFinalizationPolicy } from '../admin/configService.js';

const ACTIONS = ['confirm', 'dismiss', 'defer', 'override', 'not_applicable', 'not_assessable'] as const;
const OUTCOMES = ['passed', 'failed', 'needs_review', 'not_applicable', 'not_assessable'];

export function listFindings(db: DB, inspectionId: string) {
  const rows = db.prepare(
    `SELECT f.*, e.outcome AS eval_outcome, e.reason_code, e.explanation, e.citation, e.evidence_refs_json,
            e.rule_version_id, e.model_versions_json, e.engine_version,
            rv.title AS rule_title, rv.version AS rule_version, rv.legal_status AS rule_legal_status
     FROM findings f
     JOIN evaluations e ON e.id = f.evaluation_id
     JOIN rule_versions rv ON rv.id = e.rule_version_id
     WHERE f.inspection_id = ? ORDER BY
       CASE f.effective_outcome WHEN 'failed' THEN 0 WHEN 'not_assessable' THEN 1 WHEN 'needs_review' THEN 2 WHEN 'passed' THEN 3 ELSE 4 END,
       f.rule_key`,
  ).all(inspectionId) as any[];
  return rows.map((f) => ({
    id: f.id, inspectionId: f.inspection_id, ruleKey: f.rule_key, ruleTitle: f.rule_title,
    ruleVersion: f.rule_version, ruleVersionId: f.rule_version_id, ruleLegalStatus: f.rule_legal_status,
    status: f.status, evaluationOutcome: f.eval_outcome, effectiveOutcome: f.effective_outcome,
    severity: f.severity, reasonCode: f.reason_code, explanation: f.explanation, citation: f.citation,
    evidenceRefs: JSON.parse(f.evidence_refs_json || '[]'),
    modelVersions: JSON.parse(f.model_versions_json || '{}'), engineVersion: f.engine_version,
    finalized: !!f.finalized,
    dispositions: listDispositions(db, f.id),
  }));
}

export function listDispositions(db: DB, findingId: string) {
  return (db.prepare('SELECT * FROM finding_dispositions WHERE finding_id = ? ORDER BY created_at').all(findingId) as any[])
    .map((d) => ({
      id: d.id, action: d.action, fromOutcome: d.from_outcome, toOutcome: d.to_outcome,
      reason: d.reason, actorId: d.actor_id, requiresApproval: !!d.requires_approval,
      approvedBy: d.approved_by, approvedAt: d.approved_at, createdAt: d.created_at,
    }));
}

// REV-02/03: officer disposition with mandatory reason; overrides of configured
// high-risk severities require independent second-level approval.
export function disposeFinding(
  db: DB, user: SessionUser, findingId: string,
  input: { action: string; toOutcome?: string; reason: string },
  correlationId?: string,
) {
  const f = db.prepare('SELECT * FROM findings WHERE id = ?').get(findingId) as any;
  if (!f) throw notFound('Finding not found');
  if (f.finalized) throw conflict('Finding is finalized and immutable; amend via a new report version.');
  assertMutableInspection(db, f.inspection_id);
  if (!ACTIONS.includes(input.action as any)) throw badRequest('Invalid disposition action');
  if (!input.reason?.trim()) throw badRequest('A disposition requires a reason');

  let toOutcome = f.effective_outcome;
  let status = f.status;
  switch (input.action) {
    case 'confirm': status = 'confirmed'; break;
    case 'dismiss': status = 'dismissed'; toOutcome = 'passed'; break;
    case 'defer': status = 'deferred'; break;
    case 'not_applicable': status = 'not_applicable'; toOutcome = 'not_applicable'; break;
    case 'not_assessable': status = 'not_assessable'; toOutcome = 'not_assessable'; break;
    case 'override': {
      if (!input.toOutcome || !OUTCOMES.includes(input.toOutcome)) throw badRequest('Override requires a valid target outcome');
      status = 'overridden'; toOutcome = input.toOutcome;
      break;
    }
  }

  const policy = getFinalizationPolicy(db);
  // High-risk change: overriding/dismissing a finding whose severity is configured for second-level approval.
  const isHighRiskChange =
    (input.action === 'override' || input.action === 'dismiss') &&
    f.severity != null && policy.secondApprovalSeverities.includes(f.severity) &&
    f.effective_outcome === 'failed' && toOutcome !== 'failed';

  const t = now();
  const dispId = newId('dsp');
  db.prepare(
    `INSERT INTO finding_dispositions (id, finding_id, action, from_outcome, to_outcome, reason, actor_id,
       requires_approval, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(dispId, findingId, input.action, f.effective_outcome, toOutcome, input.reason, user.id,
    isHighRiskChange ? 1 : 0, t);
  db.prepare('UPDATE findings SET status = ?, effective_outcome = ?, updated_at = ? WHERE id = ?')
    .run(status, toOutcome, t, findingId);

  recordAudit(db, {
    actorId: user.id, actorLabel: user.email, action: `finding.${input.action}`,
    objectType: 'finding', objectId: findingId,
    before: { outcome: f.effective_outcome, status: f.status },
    after: { outcome: toOutcome, status, reason: input.reason, requiresApproval: isHighRiskChange },
    correlationId,
  });
  return { dispositionId: dispId, requiresApproval: isHighRiskChange };
}

// Second-level approval (REV-03): must be a different actor.
export function approveDisposition(db: DB, user: SessionUser, dispositionId: string, correlationId?: string) {
  const d = db.prepare('SELECT * FROM finding_dispositions WHERE id = ?').get(dispositionId) as any;
  if (!d) throw notFound('Disposition not found');
  if (!d.requires_approval) throw badRequest('This disposition does not require approval');
  if (d.approved_by) throw conflict('Disposition already approved');
  if (d.actor_id === user.id) throw forbidden('Second-level approval must come from a different officer (segregation of duties)');
  db.prepare('UPDATE finding_dispositions SET approved_by = ?, approved_at = ? WHERE id = ?')
    .run(user.id, now(), dispositionId);
  recordAudit(db, {
    actorId: user.id, actorLabel: user.email, action: 'finding.approve_override',
    objectType: 'finding_disposition', objectId: dispositionId, correlationId,
  });
}

// Findings that block finalization: material findings without officer decision,
// or high-risk overrides awaiting second-level approval (review-safety metric).
export function finalizationBlockers(db: DB, inspectionId: string): string[] {
  const blockers: string[] = [];
  const findings = db.prepare('SELECT * FROM findings WHERE inspection_id = ?').all(inspectionId) as any[];
  for (const f of findings) {
    const material = ['failed', 'needs_review', 'not_assessable'].includes(f.effective_outcome) || f.severity === 'high';
    if (material && f.status === 'open') {
      blockers.push(`Finding ${f.rule_key} (${f.effective_outcome}) has not been reviewed by an officer`);
    }
    const pending = db.prepare(
      'SELECT COUNT(*) AS c FROM finding_dispositions WHERE finding_id = ? AND requires_approval = 1 AND approved_by IS NULL',
    ).get(f.id) as any;
    if (pending.c > 0) blockers.push(`Finding ${f.rule_key} has an override awaiting second-level approval`);
  }
  return blockers;
}
