import type { DB } from '../../db/index.js';
import { now } from '../../db/index.js';
import { newId } from '../../core/ids.js';
import { forbidden, notFound, unprocessable } from '../../core/errors.js';
import { recordAudit } from '../audit/service.js';
import type { SessionUser } from '../auth/service.js';
import { latestVerdict } from './service.js';

// Reviewer sign-off on a field officer's scan.
//
// This is the `admin` role's whole job made recordable. Until it existed the
// reviewer could read a scan but leave no trace of having judged it, which makes
// "who approved this" unanswerable — the one question an enforcement record has to
// be able to answer.

export const REVIEW_DECISIONS = ['accepted', 'rejected', 'recapture_requested'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export interface ScanReviewInput {
  decision: ReviewDecision;
  reason: string;
}

// A decision is reported against the verdict it was taken on. When a scan is
// re-analysed afterwards the stored verdict id no longer matches the current one,
// and the decision is surfaced as stale rather than silently carried forward onto
// an assessment the reviewer never read.
function rowToDto(row: any, currentVerdictId: string | null) {
  return {
    id: row.id,
    decision: row.decision as ReviewDecision,
    reason: row.reason,
    reviewerId: row.reviewer_id,
    reviewerName: row.reviewer_name ?? null,
    // The authority the decision was taken under, as it was at the time. Roles
    // change; what a past decision carried must not change with them.
    reviewerRole: row.reviewer_role ?? null,
    // A super administrator's decision is final — no admin can replace it.
    final: row.reviewer_role === 'super_admin',
    verdictId: row.verdict_id,
    stale: row.verdict_id != null && currentVerdictId != null && row.verdict_id !== currentVerdictId,
    createdAt: row.created_at,
  };
}

const SELECT_REVIEWS = `
  SELECT r.id, r.decision, r.reason, r.reviewer_id, r.reviewer_role, r.verdict_id, r.created_at,
         u.name AS reviewer_name
    FROM scan_reviews r LEFT JOIN users u ON u.id = r.reviewer_id
   WHERE r.inspection_id = ?
   ORDER BY r.created_at DESC, r.rowid DESC`;

export function latestScanReview(db: DB, inspectionId: string, currentVerdictId: string | null) {
  const row = db.prepare(`${SELECT_REVIEWS} LIMIT 1`).get(inspectionId) as any;
  return row ? rowToDto(row, currentVerdictId) : null;
}

export function listScanReviews(db: DB, inspectionId: string, currentVerdictId: string | null) {
  const rows = db.prepare(SELECT_REVIEWS).all(inspectionId) as any[];
  return rows.map((r) => rowToDto(r, currentVerdictId));
}

export function recordScanReview(
  db: DB, user: SessionUser, inspectionId: string, input: ScanReviewInput, correlationId?: string,
) {
  const insp = db
    .prepare('SELECT created_by, status FROM inspections WHERE id = ?')
    .get(inspectionId) as { created_by: string; status: string } | undefined;
  if (!insp) throw notFound('Scan not found');

  // Segregation of duties: the officer who captured the evidence cannot be the one
  // who signs it off. `admin` cannot create a scan at all, so this only bites a
  // super_admin reviewing their own capture — which is exactly the case the
  // separation exists to prevent.
  if (insp.created_by === user.id) {
    throw forbidden(
      'You captured this scan, so you cannot also sign it off. '
      + 'Review is a second pair of eyes — ask another reviewer to take it.',
    );
  }

  // Decision precedence. The hierarchy runs one way: once a super administrator has
  // decided a case, an admin cannot overturn, replace or re-open it. Read from the
  // stored reviewer_role rather than the reviewer's role today, so demoting someone
  // never retroactively unlocks the cases they finalised.
  const standing = db.prepare(
    `SELECT reviewer_role, decision FROM scan_reviews
      WHERE inspection_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(inspectionId) as { reviewer_role: string | null; decision: string } | undefined;
  if (standing?.reviewer_role === 'super_admin' && user.role !== 'super_admin') {
    throw forbidden(
      `A super administrator has already decided this case (${standing.decision.replace(/_/g, ' ')}). `
      + 'That decision is final and cannot be changed at admin level.',
    );
  }

  const verdict = latestVerdict(db, inspectionId);
  if (!verdict) {
    throw unprocessable(
      'This scan has not been analysed yet, so there is no assessment to sign off.',
    );
  }
  // A verdict row carrying an error records that the judge never ran. Accepting it
  // would put a reviewer's name against an assessment that does not exist; sending
  // it back or rejecting it remains a legitimate — indeed the correct — response.
  if (verdict.error && input.decision === 'accepted') {
    throw unprocessable(
      'The analysis of this scan did not complete, so there is no assessment to accept. '
      + 'Send it back for re-capture instead.',
    );
  }

  const id = newId('svw');
  const t = now();
  db.prepare(
    `INSERT INTO scan_reviews (id, inspection_id, verdict_id, decision, reason, reviewer_id,
       reviewer_role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, inspectionId, verdict.id, input.decision, input.reason, user.id, user.role, t);

  recordAudit(db, {
    actorId: user.id, actorLabel: user.email, action: 'scan.reviewed',
    objectType: 'inspection', objectId: inspectionId,
    after: {
      reviewId: id, decision: input.decision, reason: input.reason, reviewerRole: user.role,
      verdictId: verdict.id, verdictOverall: verdict.overall, verdictIsMock: verdict.isMock,
    },
    correlationId,
  });

  return latestScanReview(db, inspectionId, verdict.id)!;
}
