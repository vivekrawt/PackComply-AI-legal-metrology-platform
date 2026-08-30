import type { DB } from '../../db/index.js';
import { now } from '../../db/index.js';
import { newId } from '../../core/ids.js';
import { notFound } from '../../core/errors.js';
import { recordAudit } from '../audit/service.js';
import type { SessionUser } from '../auth/service.js';
import { assertMutableInspection } from '../evidence/service.js';
import { coverageStatus, getInspection } from '../inspections/service.js';
import { listDeclarations } from '../declarations/service.js';
import { providers, providerModelVersions } from '../../providers/registry.js';
import { assetInput } from '../processing/pipeline.js';
import {
  ENGINE_VERSION, evaluateRule, type EngineContext, type RuleVersionData,
} from './engine.js';

export function ruleVersionRowToData(rv: any): RuleVersionData {
  return {
    id: rv.id, ruleKey: rv.rule_key, version: rv.version, title: rv.title, citation: rv.citation,
    legalStatus: rv.legal_status,
    applicability: JSON.parse(rv.applicability_json),
    inputs: JSON.parse(rv.inputs_json),
    logic: JSON.parse(rv.logic_json),
    outcome: JSON.parse(rv.outcome_json),
  };
}

// Select the published rule versions effective on the event date (REG-01/02),
// applying category overlay routing (REG-12).
export function selectRuleVersions(db: DB, eventDate: string, category: string | null) {
  const route = category
    ? (db.prepare('SELECT * FROM category_routes WHERE category = ?').get(category) as any)
    : null;
  const excluded: string[] = route ? JSON.parse(route.excluded_rule_keys_json || '[]') : [];

  const rows = db.prepare(
    `SELECT rv.*, rs.layer FROM rule_versions rv
     JOIN rule_sets rs ON rs.id = rv.rule_set_id
     WHERE rv.status = 'published' AND rv.effective_from <= ?
       AND (rv.effective_to IS NULL OR rv.effective_to > ?)
     ORDER BY rv.rule_key, rv.version DESC`,
  ).all(eventDate, eventDate) as any[];

  // Highest published version per rule_key effective on the date.
  const byKey = new Map<string, any>();
  for (const r of rows) if (!byKey.has(r.rule_key)) byKey.set(r.rule_key, r);

  const selected: any[] = [];
  const exclusions: { ruleKey: string; reason: string; citation: string }[] = [];
  for (const rv of byKey.values()) {
    const inOverlaySet = route?.overlay_rule_set_id && rv.rule_set_id === route.overlay_rule_set_id;
    if (rv.layer === 'overlay' && !inOverlaySet) continue; // other categories' overlays don't apply
    if (excluded.includes(rv.rule_key) && !inOverlaySet) {
      exclusions.push({
        ruleKey: rv.rule_key,
        reason: `Displaced for category '${category}' by an approved overlay (${route.citation ?? 'category route'})`,
        citation: rv.citation,
      });
      continue;
    }
    selected.push(rv);
  }
  return { selected, exclusions, route };
}

export async function buildContext(db: DB, inspectionId: string): Promise<EngineContext> {
  const insp = getInspection(db, inspectionId);
  const declarations = listDeclarations(db, inspectionId).map((d: any) => ({
    id: d.id, declType: d.declType, verbatimText: d.verbatimText, normalized: d.normalized,
    confidence: d.confidence, needsReview: d.needsReview, reviewReasons: d.reviewReasons,
    sourceChannel: d.sourceChannel, presentationMode: d.presentationMode, evidenceRegions: d.evidenceRegions,
  }));
  const coverage = coverageStatus(db, inspectionId);
  const calibrations = (db.prepare(
    `SELECT c.* FROM calibrations c JOIN evidence_assets a ON a.id = c.asset_id
     WHERE a.inspection_id = ? ORDER BY c.created_at DESC`,
  ).all(inspectionId) as any[]).map((c) => ({
    assetId: c.asset_id, mmPerPx: c.mm_per_px, uncertaintyPct: c.uncertainty_pct, method: c.method,
  }));
  const pdpAssets = (db.prepare(
    `SELECT DISTINCT l.asset_id FROM layout_regions l JOIN evidence_assets a ON a.id = l.asset_id
     WHERE a.inspection_id = ? AND l.kind = 'pdp'`,
  ).all(inspectionId) as any[]).map((r) => r.asset_id);
  const frontAssets = (db.prepare(
    `SELECT id FROM evidence_assets WHERE inspection_id = ? AND face_label = 'front'`,
  ).all(inspectionId) as any[]).map((r) => r.id);

  // Font measurement (pixel-level) from the configured provider. Conversion to mm
  // happens exclusively inside the engine and only with a valid calibration (FNT-01).
  const candidates = declarations
    .filter((d: any) => d.sourceChannel === 'physical')
    .map((d: any) => ({
      declType: d.declType, verbatimText: d.verbatimText,
      bbox: d.evidenceRegions[0]?.bbox ?? { x: 0, y: 0, w: 0.5, h: 0.05 },
      ocrBlockIndexes: [], lang: 'en', script: 'latin', confidence: d.confidence ?? 0.8,
      sourceChannel: 'physical' as const,
    }));
  const asset = db.prepare('SELECT * FROM evidence_assets WHERE inspection_id = ? LIMIT 1').get(inspectionId) as any;
  const fontMeasurements = asset
    ? (await providers.font.measure(assetInput(db, asset), candidates)).measurements
    : [];

  return {
    eventDate: insp.eventDate,
    inspectionType: insp.type,
    jurisdiction: 'IN',
    product: insp.product
      ? {
          category: insp.product.category, packageType: insp.product.packageType,
          importStatus: insp.product.importStatus, presentationMode: insp.product.presentationMode,
        }
      : null,
    declarations, coverage: { complete: coverage.complete, missing: coverage.missing },
    calibrations, fontMeasurements, pdpAssets, frontAssets,
  };
}

// Run a full evaluation (REG-*): pins rule versions + model versions + inputs,
// inserts immutable evaluation rows and syncs findings.
export async function runEvaluation(db: DB, user: SessionUser, inspectionId: string, correlationId?: string) {
  assertMutableInspection(db, inspectionId);
  const insp = getInspection(db, inspectionId);
  const ctx = await buildContext(db, inspectionId);
  const { selected, exclusions } = selectRuleVersions(db, ctx.eventDate, ctx.product?.category ?? null);

  const runId = newId('run');
  const t = now();
  const modelVersions = providerModelVersions();
  const inputSnapshot = {
    declarations: ctx.declarations.map((d) => ({ id: d.id, declType: d.declType, verbatim: d.verbatimText, normalized: d.normalized })),
    coverage: ctx.coverage,
    calibrations: ctx.calibrations,
    exclusions,
  };

  const insEval = db.prepare(
    `INSERT INTO evaluations (id, inspection_id, run_id, rule_version_id, rule_key, event_date, outcome,
       reason_code, explanation, citation, severity, evidence_refs_json, input_snapshot_json,
       model_versions_json, engine_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const results: any[] = [];
  for (const rv of selected) {
    const rule = ruleVersionRowToData(rv);
    const res = evaluateRule(rule, ctx);
    const evalId = newId('evl');
    const legalNote = rule.legalStatus === 'REQUIRES_LEGAL_APPROVAL'
      ? ' [Rule configuration pending legal approval — demo parameters, not certified statutory values.]'
      : '';
    insEval.run(
      evalId, inspectionId, runId, rv.id, rv.rule_key, ctx.eventDate, res.outcome,
      res.reasonCode, res.explanation + legalNote, rule.citation, res.severity,
      JSON.stringify(res.evidenceRefs), JSON.stringify(inputSnapshot), JSON.stringify(modelVersions),
      ENGINE_VERSION, t,
    );
    syncFinding(db, inspectionId, evalId, rv.rule_key, res.outcome, res.severity, t);
    results.push({
      evaluationId: evalId, ruleKey: rv.rule_key, ruleTitle: rv.title, ruleVersion: rv.version,
      ruleVersionId: rv.id, outcome: res.outcome, reasonCode: res.reasonCode,
      explanation: res.explanation + legalNote, citation: rv.citation, severity: res.severity,
      legalStatus: rv.legal_status,
    });
  }

  db.prepare("UPDATE inspections SET status = 'review', updated_at = ? WHERE id = ? AND status NOT IN ('finalized','closed')")
    .run(t, inspectionId);
  recordAudit(db, {
    actorId: user.id, actorLabel: user.email, action: 'evaluation.run',
    objectType: 'inspection', objectId: inspectionId, correlationId,
    after: { runId, rules: results.length, engineVersion: ENGINE_VERSION, modelVersions, eventDate: insp.eventDate },
  });
  return { runId, engineVersion: ENGINE_VERSION, modelVersions, results, exclusions };
}

// One finding per (inspection, rule_key). Re-runs refresh open findings only;
// officer-dispositioned or finalized findings are never silently changed.
function syncFinding(db: DB, inspectionId: string, evaluationId: string, ruleKey: string, outcome: string, severity: string | null, t: string) {
  const existing = db.prepare(
    'SELECT * FROM findings WHERE inspection_id = ? AND rule_key = ?',
  ).get(inspectionId, ruleKey) as any;
  if (!existing) {
    db.prepare(
      `INSERT INTO findings (id, inspection_id, evaluation_id, rule_key, status, effective_outcome, severity, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
    ).run(newId('fnd'), inspectionId, evaluationId, ruleKey, outcome, severity, t, t);
    return;
  }
  if (existing.finalized) return;
  if (existing.status === 'open') {
    db.prepare('UPDATE findings SET evaluation_id = ?, effective_outcome = ?, severity = ?, updated_at = ? WHERE id = ?')
      .run(evaluationId, outcome, severity, t, existing.id);
  } else {
    // Officer already dispositioned: link the newest evaluation but keep the decision.
    db.prepare('UPDATE findings SET evaluation_id = ?, updated_at = ? WHERE id = ?')
      .run(evaluationId, t, existing.id);
  }
}

export function listEvaluations(db: DB, inspectionId: string, runId?: string) {
  const latestRun = runId ?? (db.prepare(
    'SELECT run_id FROM evaluations WHERE inspection_id = ? ORDER BY created_at DESC LIMIT 1',
  ).get(inspectionId) as any)?.run_id;
  if (!latestRun) return { runId: null, evaluations: [] };
  const rows = db.prepare(
    `SELECT e.*, rv.title AS rule_title, rv.version AS rule_version, rv.legal_status AS rule_legal_status
     FROM evaluations e JOIN rule_versions rv ON rv.id = e.rule_version_id
     WHERE e.inspection_id = ? AND e.run_id = ? ORDER BY e.rule_key`,
  ).all(inspectionId, latestRun) as any[];
  return {
    runId: latestRun,
    evaluations: rows.map((e) => ({
      id: e.id, ruleKey: e.rule_key, ruleTitle: e.rule_title, ruleVersion: e.rule_version,
      ruleVersionId: e.rule_version_id, ruleLegalStatus: e.rule_legal_status,
      eventDate: e.event_date, outcome: e.outcome, reasonCode: e.reason_code,
      explanation: e.explanation, citation: e.citation, severity: e.severity,
      evidenceRefs: JSON.parse(e.evidence_refs_json || '[]'),
      modelVersions: JSON.parse(e.model_versions_json || '{}'),
      engineVersion: e.engine_version, createdAt: e.created_at,
    })),
  };
}
