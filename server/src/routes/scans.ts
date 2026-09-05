import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { getDb } from '../db/index.js';
import { config } from '../core/config.js';
import { badRequest } from '../core/errors.js';
import { sha256Hex } from '../core/crypto.js';
import { requireAuth, requirePerm, SESSION_COOKIE } from '../middleware/auth.js';
import { rateLimit } from '../middleware/security.js';
import { validateBody } from '../middleware/validate.js';
import { assertInScope, scopeWhere, signup } from '../modules/auth/service.js';
import { anyMock, mockComponents, providers } from '../providers/registry.js';
import { createInspection, getInspection, upsertProduct } from '../modules/inspections/service.js';
import { ingestFileEvidence, listInspectionAssets } from '../modules/evidence/service.js';
import { enqueueJob } from '../modules/processing/queue.js';
import { listFindings } from '../modules/findings/service.js';
import { listEvaluations } from '../modules/evaluation/service.js';
import { getReportByInspection } from '../modules/reports/service.js';
import { recordAudit } from '../modules/audit/service.js';
import { assertScannable, latestVerdict } from '../modules/compliance/service.js';
import { requireScanReport, scanReportPdf } from '../modules/compliance/scanReport.js';
import { rulesCorpusStatus } from '../modules/compliance/rulesContext.js';

const ah = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res, next).catch(next); };

export const scanRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.upload.maxBytes } });

// Minimum images before a package can be analysed. One face is never enough to
// conclude a declaration is absent — the officer would be reporting "missing" on
// a face they simply did not photograph.
export const MIN_SCAN_IMAGES = 2;

// The scan flow's own vocabulary for package faces, in the order the capture
// screen asks for them. They map onto the evidence store's face labels 1:1.
export const SCAN_SIDES = ['top', 'bottom', 'left', 'right'] as const;
export const EXTRA_SIDES = ['front', 'back', 'closeup', 'other'] as const;
const ALL_SIDES = [...SCAN_SIDES, ...EXTRA_SIDES] as const;

// ---- Registration -----------------------------------------------------------
scanRouter.post(
  '/auth/signup',
  rateLimit(config.rateLimit.loginMax, 'signup'),
  validateBody(z.object({
    email: z.string().email(),
    name: z.string().min(2).max(120),
    // Long enough to matter, matching the floor /admin/users already enforces.
    password: z.string().min(10).max(200),
    organizationName: z.string().max(160).optional(),
  })),
  (req, res) => {
    const { sessionId, user } = signup(getDb(), req.body, req.ip, req.correlationId);
    res.cookie(SESSION_COOKIE, sessionId, {
      httpOnly: true, sameSite: 'lax', secure: config.env === 'production',
      maxAge: config.session.absoluteHours * 3600_000, path: '/',
    });
    res.status(201).json({ user, demoProviders: anyMock(), mockComponents: mockComponents() });
  },
);

// ---- Scan capability --------------------------------------------------------
// What the capture screen needs to know before it asks for anything: which faces
// to request, how many are required, and whether an AI verdict is actually
// available. The client never guesses at the last of those.
scanRouter.get('/scans/capability', requireAuth, (_req, res) => {
  const rules = rulesCorpusStatus();
  res.json({
    minImages: MIN_SCAN_IMAGES,
    sides: SCAN_SIDES,
    extraSides: EXTRA_SIDES,
    judge: {
      provider: providers.compliance.provider,
      modelVersion: providers.compliance.modelVersion,
      isMock: providers.compliance.isMock,
    },
    rules: { available: rules.available, sources: rules.sources, sha256: rules.sha256 },
  });
});

// ---- Scans ------------------------------------------------------------------
const productBody = z.object({
  brand: z.string().max(160).optional(),
  genericName: z.string().max(160).optional(),
  category: z.string().max(60).optional(),
  packSize: z.string().max(60).optional(),
  importStatus: z.enum(['domestic', 'imported']).optional(),
}).optional();

scanRouter.post(
  '/scans',
  requireAuth, requirePerm('inspection.create'),
  validateBody(z.object({ product: productBody, location: z.string().max(200).optional() })),
  (req, res) => {
    const db = getDb();
    const insp = createInspection(db, req.user!, {
      type: 'physical_retail',
      location: req.body.location,
      product: req.body.product,
    }, req.correlationId);
    res.status(201).json({ scanId: insp.id, createdAt: insp.createdAt });
  },
);

scanRouter.put(
  '/scans/:id/product',
  requireAuth, requirePerm('inspection.edit'),
  validateBody(productBody.unwrap()),
  (req, res) => {
    const db = getDb();
    assertInScope(db, req.user!, req.params.id);
    upsertProduct(db, req.user!, req.params.id, req.body);
    res.json({ ok: true });
  },
);

// One face per request: the officer captures sides one at a time, and a failure
// on the third image must not discard the first two.
scanRouter.post(
  '/scans/:id/images',
  requireAuth, requirePerm('evidence.upload'),
  upload.single('file'),
  ah(async (req, res) => {
    const db = getDb();
    assertInScope(db, req.user!, req.params.id);
    const file = req.file;
    if (!file) throw badRequest('No image supplied (multipart field name: file)');
    const side = String(req.body.side ?? 'other');
    if (!ALL_SIDES.includes(side as any)) {
      throw badRequest(`Unknown package side '${side}'. Expected one of: ${ALL_SIDES.join(', ')}`);
    }
    const assetId = await ingestFileEvidence(db, req.user!, req.params.id, file, {
      faceLabel: side,
      source: req.body.source === 'camera' ? 'camera' : 'upload',
      capturedAt: new Date().toISOString(),
    }, req.correlationId);
    const images = listInspectionAssets(db, req.params.id).filter((a: any) => a.kind === 'image');
    res.status(201).json({
      assetId,
      images: images.map((a: any) => ({ id: a.id, side: a.faceLabel, name: a.originalName, sha256: a.sha256 })),
      readyToAnalyze: images.length >= MIN_SCAN_IMAGES,
      minImages: MIN_SCAN_IMAGES,
    });
  }),
);

// Kick off OCR → declaration extraction → rule evaluation → AI compliance judge.
// Asynchronous by design: OCR on several images takes longer than a request
// should be held open, so the client polls GET /scans/:id.
scanRouter.post(
  '/scans/:id/analyze',
  requireAuth, requirePerm('evaluation.run'),
  validateBody(z.object({ force: z.boolean().optional() })),
  (req, res) => {
  const db = getDb();
  assertInScope(db, req.user!, req.params.id);
  assertScannable(db, req.params.id, MIN_SCAN_IMAGES);

  const assets = db.prepare(
    "SELECT id, sha256 FROM evidence_assets WHERE inspection_id = ? AND deleted_at IS NULL AND storage_key IS NOT NULL",
  ).all(req.params.id) as any[];

  // Idempotency keys are derived from the evidence set, so a double-tap on
  // "Analyze" re-uses the running jobs instead of paying for a second AI call.
  const setHash = sha256Hex(assets.map((a) => a.sha256).sort().join(','));
  const jobs = assets.map((a) => enqueueJob(db, {
    type: 'process_evidence', targetId: a.id,
    idempotencyKey: `pe:${a.id}:${a.sha256}`,
    correlationId: req.correlationId, requestedBy: req.user!.id,
  }));
  jobs.push(enqueueJob(db, {
    type: 'extract_declarations', targetId: req.params.id,
    idempotencyKey: `ex:${req.params.id}:${setHash}`,
    correlationId: req.correlationId, requestedBy: req.user!.id,
  }));
  // That same deduplication would make "Retry analysis" a silent no-op after the
  // judge job completed with an error verdict — the evidence set has not changed,
  // so the key matches an already-completed job. `force` mints a fresh key, and is
  // scoped to the judge alone: OCR of unchanged images does not need redoing.
  const judgeKey = req.body?.force
    ? `jc:${req.params.id}:${setHash}:retry:${Date.now()}`
    : `jc:${req.params.id}:${setHash}`;
  jobs.push(enqueueJob(db, {
    type: 'judge_compliance', targetId: req.params.id,
    idempotencyKey: judgeKey,
    correlationId: req.correlationId, requestedBy: req.user!.id,
  }));

  db.prepare(
    "UPDATE inspections SET status = 'processing', updated_at = datetime('now') WHERE id = ? AND status IN ('draft','capturing')",
  ).run(req.params.id);

  res.status(202).json({ scanId: req.params.id, jobs, imageCount: assets.length });
  },
);

// Poll target. Returns capture state, pipeline progress and — once the judge has
// run — the verdict.
scanRouter.get('/scans/:id', requireAuth, requirePerm('inspection.read'), (req, res) => {
  const db = getDb();
  assertInScope(db, req.user!, req.params.id);
  const insp = getInspection(db, req.params.id);
  const images = listInspectionAssets(db, req.params.id).filter((a: any) => a.kind === 'image');
  const verdict = latestVerdict(db, req.params.id);

  const jobs = db.prepare(
    `SELECT type, status, error FROM processing_jobs
     WHERE target_id = ? OR target_id IN (SELECT id FROM evidence_assets WHERE inspection_id = ?)`,
  ).all(req.params.id, req.params.id) as any[];

  const failed = jobs.filter((j) => j.status === 'dead_letter');
  const pending = jobs.filter((j) => j.status === 'queued' || j.status === 'processing');
  // Work in flight wins over an existing verdict: after a retry the previous
  // (possibly failed) verdict row is still the latest, and reporting 'ready' would
  // show the officer the stale result while the new analysis is still running.
  const status = pending.length > 0 ? 'analyzing'
    : verdict ? 'ready'
      : failed.length > 0 ? 'failed'
        : jobs.length > 0 ? 'analyzing'
          : 'capturing';

  const report = getReportByInspection(db, req.params.id);
  res.json({
    scanId: insp.id,
    status,
    createdAt: insp.createdAt,
    eventDate: insp.eventDate,
    product: insp.product,
    location: insp.location,
    minImages: MIN_SCAN_IMAGES,
    images: images.map((a: any) => ({
      id: a.id, side: a.faceLabel, name: a.originalName, sha256: a.sha256,
      sizeBytes: a.sizeBytes, capturedAt: a.capturedAt, source: a.source,
    })),
    progress: {
      total: jobs.length,
      done: jobs.filter((j) => j.status === 'completed').length,
      pending: pending.length,
      errors: failed.map((j) => `${j.type}: ${j.error}`),
    },
    verdict,
    // The deterministic engine's findings, shown beside the AI verdict rather
    // than merged into it — two assessments, separately attributable.
    engineFindings: listFindings(db, req.params.id).map((f: any) => ({
      ruleKey: f.ruleKey, title: f.ruleTitle, outcome: f.effectiveOutcome,
      severity: f.severity, explanation: f.explanation, citation: f.citation,
    })),
    ruleVersions: listEvaluations(db, req.params.id).evaluations.map((e: any) => ({
      ruleKey: e.ruleKey, version: e.ruleVersion, citation: e.citation, legalStatus: e.ruleLegalStatus,
    })),
    reportId: report?.reportId ?? null,
  });
});

// Scan history for the signed-in officer.
scanRouter.get('/scans', requireAuth, requirePerm('inspection.read'), (req, res) => {
  const db = getDb();
  const w = scopeWhere(req.user!, 'i');
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const rows = db.prepare(
    `SELECT i.id, i.status, i.event_date, i.created_at, i.location,
            p.brand, p.generic_name, p.category,
            (SELECT COUNT(*) FROM evidence_assets e
              WHERE e.inspection_id = i.id AND e.deleted_at IS NULL AND e.kind = 'image') AS image_count,
            (SELECT v.overall FROM compliance_verdicts v
              WHERE v.inspection_id = i.id ORDER BY v.created_at DESC, v.rowid DESC LIMIT 1) AS verdict,
            (SELECT v.is_mock FROM compliance_verdicts v
              WHERE v.inspection_id = i.id ORDER BY v.created_at DESC, v.rowid DESC LIMIT 1) AS verdict_is_mock,
            (SELECT r.id FROM reports r WHERE r.inspection_id = i.id) AS report_id
     FROM inspections i LEFT JOIN products p ON p.inspection_id = i.id
     WHERE ${w.sql} ORDER BY i.created_at DESC LIMIT ?`,
  ).all(...w.params, limit) as any[];

  res.json({
    scans: rows.map((r) => ({
      scanId: r.id, status: r.status, eventDate: r.event_date, createdAt: r.created_at,
      location: r.location, brand: r.brand, genericName: r.generic_name, category: r.category,
      imageCount: r.image_count, verdict: r.verdict,
      verdictIsMock: r.verdict_is_mock === null ? null : !!r.verdict_is_mock,
      reportId: r.report_id,
    })),
  });
});

// The scan report. Built on demand from the stored verdict and evidence — it does
// NOT finalize the inspection. Finalization is a legal act gated on officer review
// of every material finding (see finalizationBlockers); a field officer who has
// just photographed a shelf has reviewed nothing, and a flow that quietly waived
// that gate would turn an unreviewed AI output into a signed enforcement record.
// Formal finalization stays where it belongs, in the reviewer's workbench.
scanRouter.get('/scans/:id/report', requireAuth, requirePerm('report.read'), (req, res) => {
  const db = getDb();
  assertInScope(db, req.user!, req.params.id);
  const report = requireScanReport(db, req.params.id, req.user!);
  recordAudit(db, {
    actorId: req.user!.id, actorLabel: req.user!.email, action: 'scan.report_generated',
    objectType: 'inspection', objectId: req.params.id,
    after: { sha256: report.sha256, overall: report.assessment.overall, format: 'json' },
    correlationId: req.correlationId,
  });
  res.json(report);
});

scanRouter.get('/scans/:id/report.pdf', requireAuth, requirePerm('report.export'), ah(async (req, res) => {
  const db = getDb();
  assertInScope(db, req.user!, req.params.id);
  const report = requireScanReport(db, req.params.id, req.user!);
  const pdf = await scanReportPdf(report);
  recordAudit(db, {
    actorId: req.user!.id, actorLabel: req.user!.email, action: 'scan.report_generated',
    objectType: 'inspection', objectId: req.params.id,
    after: { sha256: report.sha256, overall: report.assessment.overall, format: 'pdf' },
    correlationId: req.correlationId,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="scan-${req.params.id}.pdf"`);
  res.send(pdf);
}));
