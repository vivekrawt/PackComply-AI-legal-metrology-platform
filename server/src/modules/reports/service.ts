import type { DB } from '../../db/index.js';
import { now } from '../../db/index.js';
import { newId } from '../../core/ids.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { canonicalJson, sha256Hex } from '../../core/crypto.js';
import { recordAudit } from '../audit/service.js';
import type { SessionUser } from '../auth/service.js';
import { getInspection, coverageStatus } from '../inspections/service.js';
import { listDeclarations, listCorrections } from '../declarations/service.js';
import { listFindings, finalizationBlockers } from '../findings/service.js';
import { listInspectionAssets } from '../evidence/service.js';
import { listEvaluations } from '../evaluation/service.js';
import { getFinalizationPolicy } from '../admin/configService.js';
import { refreshSearchIndexForInspection } from '../search/service.js';

// Build the 8-section report model (PRD §15) from pinned data only.
export function buildReportModel(db: DB, inspectionId: string, reportId: string, version: number, generatedBy: SessionUser) {
  const insp = getInspection(db, inspectionId);
  const assets = listInspectionAssets(db, inspectionId);
  const declarations = listDeclarations(db, inspectionId);
  const findings = listFindings(db, inspectionId);
  const { runId, evaluations } = listEvaluations(db, inspectionId);
  const coverage = coverageStatus(db, inspectionId);
  const annotations = db.prepare('SELECT * FROM annotations WHERE inspection_id = ?').all(inspectionId) as any[];
  const corrections = declarations.flatMap((d: any) => listCorrections(db, d.id).map((c) => ({
    declarationId: d.id, declType: d.declType, field: c.field, original: c.original_value,
    corrected: c.new_value, actorId: c.actor_id, reason: c.reason, at: c.created_at,
  })));
  const calibrations = db.prepare(
    `SELECT c.* FROM calibrations c JOIN evidence_assets a ON a.id = c.asset_id WHERE a.inspection_id = ?`,
  ).all(inspectionId) as any[];
  const modelVersions = evaluations[0]?.modelVersions ?? {};
  const usesMockProviders = declarations.some((d: any) => d.isMock);

  return {
    identification: {
      reportId, reportVersion: version, inspectionId,
      jurisdiction: { orgId: insp.orgId, state: insp.state, district: insp.district, office: insp.office },
      inspectionType: insp.type, eventDate: insp.eventDate, location: insp.location,
      officerId: insp.assignedTo ?? insp.createdBy, generatedBy: { id: generatedBy.id, name: generatedBy.name },
      generatedAt: now(),
    },
    productAndParties: {
      product: insp.product, seller: insp.sellerEntity,
    },
    evidenceManifest: {
      coverage,
      assets: assets.map((a: any) => ({
        id: a.id, kind: a.kind, faceLabel: a.faceLabel, sha256: a.sha256, mime: a.mime,
        originalName: a.originalName, source: a.source, url: a.url, marketplace: a.marketplace,
        capturedAt: a.capturedAt, receivedAt: a.receivedAt, uploaderId: a.uploaderId,
      })),
      annotations: annotations.map((an) => ({
        id: an.id, assetId: an.asset_id, kind: an.kind, geometry: an.geometry_json ? JSON.parse(an.geometry_json) : null,
        text: an.text, actorId: an.actor_id, at: an.created_at,
      })),
      calibrations: calibrations.map((c) => ({
        assetId: c.asset_id, method: c.method, mmPerPx: c.mm_per_px, uncertaintyPct: c.uncertainty_pct,
        instrument: c.instrument, enteredBy: c.entered_by,
      })),
    },
    appliedLegalContext: {
      eventDate: insp.eventDate, evaluationRunId: runId,
      ruleVersions: evaluations.map((e: any) => ({
        ruleKey: e.ruleKey, title: e.ruleTitle, version: e.ruleVersion, ruleVersionId: e.ruleVersionId,
        citation: e.citation, legalStatus: e.ruleLegalStatus,
      })),
      exclusions: evaluations[0] ? (JSON.parse(
        (db.prepare('SELECT input_snapshot_json FROM evaluations WHERE id = ?').get(evaluations[0].id) as any)
          ?.input_snapshot_json ?? '{}',
      ).exclusions ?? []) : [],
      modelVersions, engineVersion: evaluations[0]?.engineVersion ?? null,
      usesMockProviders,
      disclaimer: 'This report is decision support. The authorized officer remains responsible for the final finding. '
        + (usesMockProviders
          ? 'Declaration extraction used a DEMO/MOCK provider that has not been benchmarked; treat extracted field classifications as unverified.'
          : ''),
    },
    declarationResults: declarations.map((d: any) => ({
      declarationId: d.id, declType: d.declType, verbatim: d.verbatimText, normalized: d.normalized,
      confidence: d.confidence, needsReview: d.needsReview, evidenceRegions: d.evidenceRegions,
      sourceChannel: d.sourceChannel, corrections: corrections.filter((c) => c.declarationId === d.id),
    })),
    violationsAndObservations: findings
      .filter((f: any) => ['failed', 'needs_review', 'not_assessable'].includes(f.effectiveOutcome))
      .map((f: any) => ({
        findingId: f.id, ruleKey: f.ruleKey, ruleTitle: f.ruleTitle, ruleVersion: f.ruleVersion,
        severity: f.severity, outcome: f.effectiveOutcome, evaluationOutcome: f.evaluationOutcome,
        explanation: f.explanation, citation: f.citation, evidenceRefs: f.evidenceRefs,
        dispositions: f.dispositions,
      })),
    officerConclusion: {
      findings: findings.map((f: any) => ({
        ruleKey: f.ruleKey, evaluationOutcome: f.evaluationOutcome, effectiveOutcome: f.effectiveOutcome,
        status: f.status,
        overrides: f.dispositions.filter((dd: any) => dd.action === 'override')
          .map((dd: any) => ({ reason: dd.reason, actorId: dd.actorId, toOutcome: dd.toOutcome, approvedBy: dd.approvedBy })),
      })),
      overallStatus: findings.some((f: any) => f.effectiveOutcome === 'failed')
        ? 'non_compliant'
        : findings.some((f: any) => ['needs_review', 'not_assessable'].includes(f.effectiveOutcome))
          ? 'review_required'
          : 'compliant',
      notes: insp.notes,
    },
    auditAndVerification: {
      // Report hash is computed over this snapshot at save time and stored alongside.
      generatedAt: now(), inspectionCreatedAt: insp.createdAt,
      evidenceHashes: assets.map((a: any) => a.sha256).filter(Boolean),
    },
  };
}

export function finalizeInspection(db: DB, user: SessionUser, inspectionId: string, correlationId?: string) {
  const insp = db.prepare('SELECT * FROM inspections WHERE id = ?').get(inspectionId) as any;
  if (!insp) throw notFound('Inspection not found');
  if (insp.status === 'finalized' || insp.status === 'closed') throw conflict('Inspection already finalized');

  const policy = getFinalizationPolicy(db);
  if (user.role === 'inspector' && !policy.inspectorCanFinalize) {
    throw forbidden('Finalization by inspectors is disabled by policy; route to a reviewing officer');
  }
  const evalCount = (db.prepare('SELECT COUNT(*) AS c FROM evaluations WHERE inspection_id = ?').get(inspectionId) as any).c;
  if (evalCount === 0) throw unprocessable('Cannot finalize: no rule evaluation has been run');
  const blockers = finalizationBlockers(db, inspectionId);
  if (blockers.length > 0) throw unprocessable('Finalization blocked: material findings need officer review', blockers);

  const t = now();
  const reportId = newId('rpt');
  db.prepare('INSERT INTO reports (id, inspection_id, current_version, created_at) VALUES (?, ?, 1, ?)')
    .run(reportId, inspectionId, t);
  const snapshot = buildReportModel(db, inspectionId, reportId, 1, user);
  const canonical = canonicalJson(snapshot);
  const hash = sha256Hex(canonical);
  db.prepare(
    `INSERT INTO report_versions (id, report_id, version, snapshot_json, sha256, reason, generated_by, created_at)
     VALUES (?, ?, 1, ?, ?, 'initial finalization', ?, ?)`,
  ).run(newId('rpv'), reportId, canonical, hash, user.id, t);

  db.prepare('UPDATE findings SET finalized = 1, updated_at = ? WHERE inspection_id = ?').run(t, inspectionId);
  db.prepare("UPDATE inspections SET status = 'finalized', updated_at = ? WHERE id = ?").run(t, inspectionId);
  refreshSearchIndexForInspection(db, inspectionId);

  recordAudit(db, {
    actorId: user.id, actorLabel: user.email, action: 'inspection.finalize',
    objectType: 'inspection', objectId: inspectionId,
    after: { reportId, reportVersion: 1, reportHash: hash }, correlationId,
  });
  return { reportId, version: 1, sha256: hash };
}

// REV-08: amendment creates a new version; prior versions retained + verifiable.
export function amendReport(db: DB, user: SessionUser, reportId: string, reason: string, correlationId?: string) {
  if (!reason?.trim()) throw badRequest('An amendment requires a reason');
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId) as any;
  if (!report) throw notFound('Report not found');
  const newVersion = report.current_version + 1;
  const snapshot = buildReportModel(db, report.inspection_id, reportId, newVersion, user);
  const canonical = canonicalJson(snapshot);
  const hash = sha256Hex(canonical);
  const t = now();
  db.prepare(
    `INSERT INTO report_versions (id, report_id, version, snapshot_json, sha256, reason, generated_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId('rpv'), reportId, newVersion, canonical, hash, reason, user.id, t);
  db.prepare('UPDATE reports SET current_version = ? WHERE id = ?').run(newVersion, reportId);
  recordAudit(db, {
    actorId: user.id, actorLabel: user.email, action: 'report.amend',
    objectType: 'report', objectId: reportId, after: { version: newVersion, reason, hash }, correlationId,
  });
  return { reportId, version: newVersion, sha256: hash };
}

export function getReport(db: DB, reportId: string, version?: number) {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId) as any;
  if (!report) throw notFound('Report not found');
  const v = version ?? report.current_version;
  const rv = db.prepare('SELECT * FROM report_versions WHERE report_id = ? AND version = ?').get(reportId, v) as any;
  if (!rv) throw notFound(`Report version ${v} not found`);
  return {
    reportId, inspectionId: report.inspection_id, version: v, currentVersion: report.current_version,
    sha256: rv.sha256, reason: rv.reason, generatedBy: rv.generated_by, createdAt: rv.created_at,
    snapshot: JSON.parse(rv.snapshot_json),
    versions: (db.prepare('SELECT version, sha256, reason, created_at FROM report_versions WHERE report_id = ? ORDER BY version').all(reportId) as any[]),
  };
}

export function getReportByInspection(db: DB, inspectionId: string) {
  const report = db.prepare('SELECT id FROM reports WHERE inspection_id = ?').get(inspectionId) as any;
  if (!report) return null;
  return getReport(db, report.id);
}

// UAT-12: verify stored snapshot hash (report integrity).
export function verifyReport(db: DB, reportId: string, version?: number) {
  const r = getReport(db, reportId, version);
  const recomputed = sha256Hex(canonicalJson(r.snapshot));
  return { reportId, version: r.version, storedSha256: r.sha256, recomputedSha256: recomputed, valid: recomputed === r.sha256 };
}
