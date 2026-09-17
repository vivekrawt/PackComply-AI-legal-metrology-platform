import type { DB } from '../../db/index.js';
import { now } from '../../db/index.js';
import { newId } from '../../core/ids.js';
import { logger } from '../../core/logger.js';
import { unprocessable } from '../../core/errors.js';
import { providers } from '../../providers/registry.js';
import type { ComplianceJudgeInput, ComplianceVerdict } from '../../providers/types.js';
import { recordAudit } from '../audit/service.js';
import type { SessionUser } from '../auth/service.js';
import { getInspection } from '../inspections/service.js';
import { listEvaluations } from '../evaluation/service.js';
import { loadRulesCorpus } from './rulesContext.js';

// Assemble the OCR text of every captured face, hand it to the compliance judge
// together with the statutory corpus, and persist the verdict.
//
// The OCR text is stored verbatim on the verdict row. That is the whole input the
// model saw, so a later reviewer can tell an actual missing declaration apart from
// a declaration OCR simply failed to recover — the distinction the officer's
// determination turns on.

export function collectOcrText(db: DB, inspectionId: string) {
  // The OCR job's own outcome for each face travels with the text. A face the
  // recogniser read and found bare yields the same empty string as a face it never
  // reached because the service was down, and only the job row separates them.
  // Collapsed into one, an outage is indistinguishable from a missing declaration.
  const assets = db.prepare(
    `SELECT a.id, a.face_label,
            (SELECT j.status FROM processing_jobs j
              WHERE j.target_id = a.id AND j.type = 'process_evidence'
              ORDER BY j.created_at DESC LIMIT 1) AS ocr_job
       FROM evidence_assets a
      WHERE a.inspection_id = ? AND a.deleted_at IS NULL ORDER BY a.created_at`,
  ).all(inspectionId) as any[];

  const faces: { faceLabel: string | null; text: string; read: boolean }[] = [];
  for (const a of assets) {
    const blocks = db.prepare(
      'SELECT text FROM ocr_blocks WHERE asset_id = ? ORDER BY reading_order',
    ).all(a.id) as any[];
    faces.push({
      faceLabel: a.face_label,
      read: a.ocr_job === 'completed',
      text: blocks.map((b) => b.text).join('\n').trim(),
    });
  }
  const ocrText = faces
    .map((f) => (f.read
      ? `[${f.faceLabel ?? 'unlabelled'}]\n${f.text}`
      : `[${f.faceLabel ?? 'unlabelled'} — NOT READ: the recogniser never ran on this face]`))
    .join('\n\n')
    .trim();
  return { faces, ocrText };
}

// The same guard the prompt asks the model for, enforced rather than requested.
//
// A declaration cannot be shown to be absent from a package that was only partly
// examined: it may be printed on a face nothing ever read. The model is told which
// faces those are and instructed to answer 'unclear', but a finding of
// non-compliance against a label nobody finished reading is not a thing to leave to
// instruction-following. Only findings of ABSENCE are withheld - a declaration that
// was read and is itself defective stands, because unread faces cannot excuse it.
//
// Nothing is hidden: what the model actually returned stays on the row in raw_json,
// and the summary says plainly that the determination was held back and why.
export function withholdAbsenceOnUnreadFaces(
  verdict: ComplianceVerdict,
  faces: { faceLabel: string | null; read: boolean }[],
): ComplianceVerdict {
  const unread = faces.filter((f) => !f.read).map((f) => f.faceLabel ?? 'unlabelled');
  if (unread.length === 0 || faces.length === 0) return verdict;

  const names = unread.join(', ');
  const plural = unread.length > 1;
  let withheld = 0;
  const checks = verdict.checks.map((c) => {
    if (c.status !== 'missing') return c;
    withheld += 1;
    return {
      ...c,
      status: 'unclear' as const,
      issue: `${c.issue} (Recorded as unclear rather than missing: the ${names} `
        + `${plural ? 'faces were' : 'face was'} photographed but never read, so this `
        + `declaration may be printed there.)`.trim(),
    };
  });

  // "Reading confidence" is how well the label was read, so it cannot survive
  // untouched when part of the label was not read at all. Scaling by the share of
  // faces actually read keeps the number the model's own, told honestly.
  const readShare = faces.filter((f) => f.read).length / faces.length;
  return {
    ...verdict,
    checks,
    confidence: Math.round(verdict.confidence * readShare * 100) / 100,
    overall: withheld > 0 && verdict.overall === 'non_compliant' ? 'needs_review' : verdict.overall,
    summary: `${unread.length} of ${faces.length} photographed `
      + `${faces.length > 1 ? 'faces' : 'face'} (${names}) could not be read, so nothing can be `
      + `shown to be absent from this package. ${verdict.summary}`,
  };
}

export async function judgeCompliance(
  db: DB, inspectionId: string, actor?: SessionUser | null, correlationId?: string,
): Promise<ComplianceVerdict & { id: string; rulesSha256: string; rulesSources: string[] }> {
  const insp = getInspection(db, inspectionId);
  const { faces, ocrText } = collectOcrText(db, inspectionId);
  const rules = loadRulesCorpus();

  const { evaluations } = listEvaluations(db, inspectionId);
  const input: ComplianceJudgeInput = {
    eventDate: insp.eventDate,
    ocrText,
    faces,
    productContext: insp.product
      ? {
          brand: insp.product.brand, genericName: insp.product.genericName,
          category: insp.product.category, importStatus: insp.product.importStatus,
          packSize: insp.product.packSize,
        }
      : undefined,
    engineFindings: evaluations.map((e: any) => ({
      ruleKey: e.ruleKey, title: e.ruleTitle, outcome: e.outcome,
      explanation: e.explanation, citation: e.citation,
    })),
  };

  const judge = providers.compliance;
  let verdict: ComplianceVerdict;
  let error: string | null = null;
  try {
    verdict = await judge.judge(input, rules);
  } catch (err) {
    // A judge failure is recorded as a verdict row with the error on it rather than
    // discarded: the officer needs to see that the AI step did not run, and the
    // captured evidence must not be silently left without an outcome.
    error = err instanceof Error ? err.message : String(err);
    logger.error('compliance judge failed', { inspectionId, provider: judge.provider, error });
    verdict = {
      provider: judge.provider, modelVersion: judge.modelVersion, isMock: judge.isMock,
      overall: 'needs_review',
      summary: `The compliance assessment could not be completed: ${error}`,
      confidence: 0,
      checks: [],
    };
  }

  verdict = withholdAbsenceOnUnreadFaces(verdict, faces);

  const id = newId('cv');
  const t = now();
  db.prepare(
    `INSERT INTO compliance_verdicts (id, inspection_id, provider, model_version, is_mock,
       rules_sources_json, rules_sha256, ocr_text, overall, summary, confidence, checks_json,
       raw_json, error, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, inspectionId, verdict.provider, verdict.modelVersion, verdict.isMock ? 1 : 0,
    JSON.stringify(rules.sources), rules.sha256 || null, ocrText,
    verdict.overall, verdict.summary, verdict.confidence, JSON.stringify(verdict.checks),
    verdict.raw ? JSON.stringify(verdict.raw) : null, error,
    actor?.id ?? null, t,
  );

  // Name the package from what was read off it, if nobody has named it already.
  nameProduct(db, inspectionId, verdict);

  recordAudit(db, {
    actorId: actor?.id ?? null, actorLabel: actor?.email ?? 'system',
    action: 'compliance.judged', objectType: 'inspection', objectId: inspectionId,
    outcome: error ? 'failure' : 'success',
    after: {
      verdictId: id, overall: verdict.overall, provider: verdict.provider,
      modelVersion: verdict.modelVersion, isMock: verdict.isMock,
      rulesSha256: rules.sha256, rulesSources: rules.sources,
      checks: verdict.checks.length, error,
    },
    correlationId,
  });

  return { ...verdict, id, rulesSha256: rules.sha256, rulesSources: rules.sources };
}

// Give the scan a name, so it can be found again in a list.
//
// Order of authority: what the auditor typed wins outright, then what the judge
// read off the label, then the extracted product-name declaration — which is what
// names a scan when no AI model is configured and the deterministic fallback ran.
// A name is a label for locating the record; it is never part of the compliance
// determination, and it never overwrites one a person entered.
function nameProduct(db: DB, inspectionId: string, verdict: ComplianceVerdict) {
  const existing = db.prepare(
    'SELECT id, brand, generic_name FROM products WHERE inspection_id = ?',
  ).get(inspectionId) as any;
  if (existing?.generic_name || existing?.brand) return;

  const declared = db.prepare(
    `SELECT verbatim_text FROM declarations
      WHERE inspection_id = ? AND decl_type = 'product_name'
      ORDER BY confidence DESC LIMIT 1`,
  ).get(inspectionId) as any;

  const name = (verdict.productName ?? '').trim() || (declared?.verbatim_text ?? '').trim();
  const brand = (verdict.brand ?? '').trim();
  if (!name && !brand) return;

  const t = now();
  if (existing) {
    db.prepare(
      `UPDATE products SET generic_name = COALESCE(NULLIF(?, ''), generic_name),
         brand = COALESCE(NULLIF(?, ''), brand), updated_at = ? WHERE id = ?`,
    ).run(name, brand, t, existing.id);
  } else {
    db.prepare(
      `INSERT INTO products (id, inspection_id, brand, generic_name, package_type,
         import_status, presentation_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'retail', 'domestic', 'printed', ?, ?)`,
    ).run(newId('prd'), inspectionId, brand || null, name || null, t, t);
  }
}

export function verdictRowToDto(v: any) {
  return {
    id: v.id,
    inspectionId: v.inspection_id,
    provider: v.provider,
    modelVersion: v.model_version,
    isMock: !!v.is_mock,
    rulesSources: JSON.parse(v.rules_sources_json || '[]'),
    rulesSha256: v.rules_sha256,
    ocrText: v.ocr_text,
    overall: v.overall,
    summary: v.summary,
    confidence: v.confidence,
    checks: JSON.parse(v.checks_json || '[]'),
    error: v.error,
    createdAt: v.created_at,
  };
}

export function latestVerdict(db: DB, inspectionId: string) {
  const row = db.prepare(
    'SELECT * FROM compliance_verdicts WHERE inspection_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
  ).get(inspectionId) as any;
  return row ? verdictRowToDto(row) : null;
}

export function assertScannable(db: DB, inspectionId: string, minImages: number) {
  const c = (db.prepare(
    "SELECT COUNT(*) AS c FROM evidence_assets WHERE inspection_id = ? AND deleted_at IS NULL AND kind = 'image'",
  ).get(inspectionId) as any).c as number;
  if (c < minImages) {
    throw unprocessable(
      `At least ${minImages} package images are required before analysis; ${c} captured. `
      + 'Add another side image.',
    );
  }
  return c;
}
