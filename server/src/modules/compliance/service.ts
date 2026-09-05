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
  const assets = db.prepare(
    `SELECT id, face_label FROM evidence_assets
     WHERE inspection_id = ? AND deleted_at IS NULL ORDER BY created_at`,
  ).all(inspectionId) as any[];

  const faces: { faceLabel: string | null; text: string }[] = [];
  for (const a of assets) {
    const blocks = db.prepare(
      'SELECT text FROM ocr_blocks WHERE asset_id = ? ORDER BY reading_order',
    ).all(a.id) as any[];
    faces.push({
      faceLabel: a.face_label,
      text: blocks.map((b) => b.text).join('\n').trim(),
    });
  }
  const ocrText = faces
    .map((f) => `[${f.faceLabel ?? 'unlabelled'}]\n${f.text}`)
    .join('\n\n')
    .trim();
  return { faces, ocrText };
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
