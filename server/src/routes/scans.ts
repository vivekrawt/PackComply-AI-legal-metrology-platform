import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { getDb, now } from '../db/index.js';
import { config } from '../core/config.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../core/errors.js';
import { sha256Hex } from '../core/crypto.js';
import { requireAuth, requirePerm, SESSION_COOKIE } from '../middleware/auth.js';
import { rateLimit } from '../middleware/security.js';
import { validateBody } from '../middleware/validate.js';
import { assertInScope, scopeWhere, signup } from '../modules/auth/service.js';
import { anyMock, mockComponents, providers } from '../providers/registry.js';
import { createInspection, getInspection, upsertProduct } from '../modules/inspections/service.js';
import { deleteAsset, ingestFileEvidence, listInspectionAssets } from '../modules/evidence/service.js';
import { enqueueJob } from '../modules/processing/queue.js';
import { listFindings } from '../modules/findings/service.js';
import { listEvaluations } from '../modules/evaluation/service.js';
import { getReportByInspection } from '../modules/reports/service.js';
import { recordAudit } from '../modules/audit/service.js';
import { assertScannable, latestVerdict } from '../modules/compliance/service.js';
import { loadScanImages, requireScanReport, scanReportPdf } from '../modules/compliance/scanReport.js';
import { rulesCorpusStatus } from '../modules/compliance/rulesContext.js';
import {
  REVIEW_DECISIONS, latestScanReview, listScanReviews, recordScanReview,
} from '../modules/compliance/reviewService.js';

const ah = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res, next).catch(next); };

export const scanRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.upload.maxBytes } });

// Minimum images before a package can be analysed. One is the floor: an officer
// holding a small packet whose whole label is on one face should not be blocked
// from scanning it. It is a floor, not a recommendation — the capture screen
// still asks for every side, because a declaration missing from a face that was
// never photographed is not a missing declaration, and the judge is told which
// faces it did and did not see so it can answer 'unclear' rather than 'missing'.
export const MIN_SCAN_IMAGES = 1;

// Ceiling on one package. Eight faces is past what any retail package physically
// has, so it does not cut an honest capture short; it is here because every image
// is an OCR pass and a slice of the judge's context, and a scan carrying thirty
// photos of the same carton costs both without telling anyone anything new.
export const MAX_SCAN_IMAGES = 8;

// The scan flow's own vocabulary for package faces, in the order the capture
// screen asks for them. The first three are on screen from the start — front, back
// and top are where the declarations sit on almost every package — and the rest are
// offered one at a time as the officer fills what is already there. The two lists
// together are exactly MAX_SCAN_IMAGES faces, so the ceiling and the vocabulary
// cannot drift apart. They map onto the evidence store's face labels 1:1.
export const SCAN_SIDES = ['front', 'back', 'top'] as const;
export const EXTRA_SIDES = ['bottom', 'left', 'right', 'closeup', 'other'] as const;
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
    maxImages: MAX_SCAN_IMAGES,
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

    // A face is photographed once. Sending a second image for a face the scan
    // already holds is a retake — the officer decided the first one was no good —
    // so the old capture is retired rather than stacked alongside the new one.
    // Without that, a blurry first attempt would still reach OCR and the judge,
    // and three retakes of one face would eat three of the eight slots.
    const before = listInspectionAssets(db, req.params.id).filter((a: any) => a.kind === 'image');
    const replacing = before.filter((a: any) => a.faceLabel === side && !a.legalHold);
    if (before.length - replacing.length >= MAX_SCAN_IMAGES) {
      throw conflict(
        `This scan already holds ${MAX_SCAN_IMAGES} package images, which is the limit. `
        + `Remove one of the captured faces before adding another.`,
      );
    }

    const assetId = await ingestFileEvidence(db, req.user!, req.params.id, file, {
      faceLabel: side,
      source: req.body.source === 'camera' ? 'camera' : 'upload',
      capturedAt: new Date().toISOString(),
    }, req.correlationId);
    // Retire the old capture only once the new one is safely stored: a replacement
    // the content checks refuse must not cost the officer the image they had.
    for (const old of replacing) {
      deleteAsset(db, req.user!, old.id, `Replaced by a newer ${side} capture`, req.correlationId);
    }

    const images = listInspectionAssets(db, req.params.id).filter((a: any) => a.kind === 'image');
    res.status(201).json({
      assetId,
      images: images.map((a: any) => ({ id: a.id, side: a.faceLabel, name: a.originalName, sha256: a.sha256 })),
      readyToAnalyze: images.length >= MIN_SCAN_IMAGES,
      minImages: MIN_SCAN_IMAGES,
      maxImages: MAX_SCAN_IMAGES,
    });
  }),
);

// Discarding a capture the officer does not want to send. Soft delete, like every
// other route into the evidence store: the SHA-256 stays on the row, so a report
// that already cited the image still verifies against what it cited. Deleting
// evidence off someone else's case stays super_admin work (DEL-01) — this is the
// narrow case of the auditor dropping a face from a package they are still
// photographing, which is what makes a freed slot mean a freed slot.
scanRouter.delete(
  '/scans/:id/images/:assetId',
  requireAuth, requirePerm('evidence.upload'),
  (req, res) => {
    const db = getDb();
    assertInScope(db, req.user!, req.params.id);
    const insp = db.prepare('SELECT created_by FROM inspections WHERE id = ?')
      .get(req.params.id) as { created_by: string } | undefined;
    if (!insp) throw notFound('Scan not found');
    if (insp.created_by !== req.user!.id) {
      throw forbidden('Only the auditor who captured a scan can discard its images');
    }
    const asset = listInspectionAssets(db, req.params.id).find((a: any) => a.id === req.params.assetId);
    if (!asset) throw notFound('Image not found on this scan');

    deleteAsset(db, req.user!, req.params.assetId, 'Discarded by the auditor during capture', req.correlationId);
    const images = listInspectionAssets(db, req.params.id).filter((a: any) => a.kind === 'image');
    res.json({
      images: images.map((a: any) => ({ id: a.id, side: a.faceLabel, name: a.originalName, sha256: a.sha256 })),
      readyToAnalyze: images.length >= MIN_SCAN_IMAGES,
      minImages: MIN_SCAN_IMAGES,
      maxImages: MAX_SCAN_IMAGES,
    });
  },
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
  // A dead-lettered OCR job is re-queued by enqueueJob on its own, so re-analysing
  // after the recogniser comes back does read the faces it missed. Those faces are
  // new input the extractor never saw, so `force` has to redo extraction as well —
  // otherwise the declarations would stay frozen at what two of five faces said.
  const retryKey = req.body?.force ? `:retry:${Date.now()}` : '';
  jobs.push(enqueueJob(db, {
    type: 'extract_declarations', targetId: req.params.id,
    idempotencyKey: `ex:${req.params.id}:${setHash}${retryKey}`,
    correlationId: req.correlationId, requestedBy: req.user!.id,
  }));
  // That same deduplication would make "Retry analysis" a silent no-op after the
  // judge job completed with an error verdict — the evidence set has not changed,
  // so the key matches an already-completed job. `force` mints a fresh key, and is
  // scoped to the judge alone: OCR of unchanged images does not need redoing.
  const judgeKey = `jc:${req.params.id}:${setHash}${retryKey}`;
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

  // Which faces the recogniser actually got through. An image the officer took and
  // the system never read is not the same as one read and found bare, and until now
  // only the judge was told the difference - the officer saw a finished verdict with
  // no sign that a third of their photographs had been skipped.
  const ocrDone = new Set((db.prepare(
    `SELECT target_id FROM processing_jobs
      WHERE type = 'process_evidence' AND status = 'completed'
        AND target_id IN (SELECT id FROM evidence_assets WHERE inspection_id = ?)`,
  ).all(req.params.id) as any[]).map((r) => r.target_id));

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
    maxImages: MAX_SCAN_IMAGES,
    images: images.map((a: any) => ({
      id: a.id, side: a.faceLabel, name: a.originalName, sha256: a.sha256,
      sizeBytes: a.sizeBytes, capturedAt: a.capturedAt, source: a.source,
      read: ocrDone.has(a.id),
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
    // Who captured this, for the reviewer who has to judge it. A sign-off is a
    // statement about another officer's work, so that officer is named.
    officer: db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(insp.createdBy) ?? null,
    team: db.prepare(
      'SELECT t.id, t.name FROM teams t JOIN inspections i2 ON i2.team_id = t.id WHERE i2.id = ?',
    ).get(req.params.id) ?? null,
    // Null until the auditor hands it over; a scan reaches no review queue before that.
    submittedAt: (db.prepare('SELECT submitted_at FROM inspections WHERE id = ?')
      .get(req.params.id) as any)?.submitted_at ?? null,
    review: latestScanReview(db, req.params.id, verdict?.id ?? null),
    reviews: listScanReviews(db, req.params.id, verdict?.id ?? null),
  });
});

// Per-image OCR boxes, for the evidence viewer on the result screen.
//
// The officer taps an image and sees the text the recogniser actually read, drawn
// where it was read from. That is how a verdict becomes checkable: a declaration
// reported missing can be confirmed genuinely absent rather than merely unread,
// and one reported present can be seen on the package. Boxes are normalised
// fractions of the ORIGINAL photograph (the sidecar maps them back out of its
// prepared image), so they line up on the picture the officer took.
scanRouter.get('/scans/:id/ocr', requireAuth, requirePerm('inspection.read'), (req, res) => {
  const db = getDb();
  assertInScope(db, req.user!, req.params.id);
  const images = listInspectionAssets(db, req.params.id).filter((a: any) => a.kind === 'image');
  const rows = db.prepare(
    `SELECT asset_id, text, bbox_json, reading_order, script, lang, confidence, provider, model_version, is_mock
       FROM ocr_blocks WHERE asset_id IN (SELECT id FROM evidence_assets WHERE inspection_id = ?)
      ORDER BY asset_id, reading_order`,
  ).all(req.params.id) as any[];

  const byAsset = new Map<string, any[]>();
  for (const r of rows) {
    if (!byAsset.has(r.asset_id)) byAsset.set(r.asset_id, []);
    byAsset.get(r.asset_id)!.push({
      text: r.text, bbox: JSON.parse(r.bbox_json), readingOrder: r.reading_order,
      script: r.script, lang: r.lang, confidence: r.confidence,
    });
  }
  res.json({
    images: images.map((a: any) => ({
      assetId: a.id,
      side: a.faceLabel,
      mime: a.mime,
      // An image with no blocks is not the same as one that was never read: the
      // viewer says which, so 'nothing found here' cannot be mistaken for
      // 'not looked at here'.
      processed: byAsset.has(a.id),
      blocks: byAsset.get(a.id) ?? [],
    })),
    readBy: rows.length
      ? { provider: rows[0].provider, modelVersion: rows[0].model_version, isMock: !!rows[0].is_mock }
      : null,
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
            (SELECT v.id FROM compliance_verdicts v
              WHERE v.inspection_id = i.id ORDER BY v.created_at DESC, v.rowid DESC LIMIT 1) AS verdict_id,
            (SELECT sr.decision FROM scan_reviews sr
              WHERE sr.inspection_id = i.id ORDER BY sr.created_at DESC, sr.rowid DESC LIMIT 1) AS review_decision,
            (SELECT sr.created_at FROM scan_reviews sr
              WHERE sr.inspection_id = i.id ORDER BY sr.created_at DESC, sr.rowid DESC LIMIT 1) AS reviewed_at,
            (SELECT sr.verdict_id FROM scan_reviews sr
              WHERE sr.inspection_id = i.id ORDER BY sr.created_at DESC, sr.rowid DESC LIMIT 1) AS review_verdict_id,
            (SELECT ru.name FROM users ru WHERE ru.id = (
               SELECT sr.reviewer_id FROM scan_reviews sr
                WHERE sr.inspection_id = i.id ORDER BY sr.created_at DESC, sr.rowid DESC LIMIT 1
             )) AS reviewer_name,
            ou.name AS officer_name,
            i.team_id, tm.name AS team_name, i.submitted_at,
            (SELECT r.id FROM reports r WHERE r.inspection_id = i.id) AS report_id
     FROM inspections i LEFT JOIN products p ON p.inspection_id = i.id
     LEFT JOIN users ou ON ou.id = i.created_by
     LEFT JOIN teams tm ON tm.id = i.team_id
     WHERE ${w.sql} ORDER BY i.created_at DESC LIMIT ?`,
  ).all(...w.params, limit) as any[];

  res.json({
    scans: rows.map((r) => ({
      scanId: r.id, status: r.status, eventDate: r.event_date, createdAt: r.created_at,
      location: r.location, brand: r.brand, genericName: r.generic_name, category: r.category,
      imageCount: r.image_count, verdict: r.verdict,
      verdictIsMock: r.verdict_is_mock === null ? null : !!r.verdict_is_mock,
      reportId: r.report_id,
      officerName: r.officer_name ?? null,
      teamId: r.team_id ?? null,
      teamName: r.team_name ?? null,
      submittedAt: r.submitted_at ?? null,
      // Null means nobody has signed this off yet — which is what puts it in the
      // reviewer's queue. `stale` marks a decision taken against an earlier
      // verdict, i.e. one the package has since been re-analysed past.
      review: r.review_decision
        ? {
            decision: r.review_decision,
            reviewerName: r.reviewer_name ?? null,
            createdAt: r.reviewed_at,
            stale: r.review_verdict_id != null && r.verdict_id != null
              && r.review_verdict_id !== r.verdict_id,
          }
        : null,
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

// ---- Handing a finished scan to the admin -----------------------------------
// Submission is an explicit act. Analysis finishing means the machine is done, not
// that the auditor is: they may still want another face of the package. Until they
// send it, the scan is theirs and reaches no review queue.
scanRouter.post('/scans/:id/submit', requireAuth, requirePerm('scan.submit'), (req, res) => {
  const db = getDb();
  assertInScope(db, req.user!, req.params.id);
  const insp = db.prepare('SELECT created_by FROM inspections WHERE id = ?')
    .get(req.params.id) as { created_by: string } | undefined;
  if (!insp) throw notFound('Scan not found');
  if (insp.created_by !== req.user!.id) {
    throw forbidden('Only the auditor who captured a scan can send it for review');
  }
  const verdict = latestVerdict(db, req.params.id);
  if (!verdict) {
    throw unprocessable('Analyse this scan before sending it for review — there is nothing to review yet.');
  }

  const t = now();
  db.prepare('UPDATE inspections SET submitted_at = ?, submitted_by = ?, updated_at = ? WHERE id = ?')
    .run(t, req.user!.id, t, req.params.id);

  recordAudit(db, {
    actorId: req.user!.id, actorLabel: req.user!.email, action: 'scan.submitted',
    objectType: 'inspection', objectId: req.params.id,
    after: { verdictId: verdict.id, overall: verdict.overall },
    correlationId: req.correlationId,
  });
  res.json({ submittedAt: t });
});

// ---- Reviewer sign-off ------------------------------------------------------
// The `admin` role's job, made into a record. A reason is mandatory on every
// decision including acceptance: "approved, no comment" is not reviewable by
// anyone who comes after, and this row is what a later challenge is answered with.
scanRouter.post(
  '/scans/:id/review',
  requireAuth, requirePerm('scan.review'),
  validateBody(z.object({
    decision: z.enum(REVIEW_DECISIONS),
    reason: z.string().min(5).max(2000),
  })),
  (req, res) => {
    const db = getDb();
    assertInScope(db, req.user!, req.params.id);
    res.status(201).json(
      recordScanReview(db, req.user!, req.params.id, req.body, req.correlationId),
    );
  },
);

scanRouter.get('/scans/:id/report.pdf', requireAuth, requirePerm('report.export'), ah(async (req, res) => {
  const db = getDb();
  assertInScope(db, req.user!, req.params.id);
  const report = requireScanReport(db, req.params.id, req.user!);
  // The package images ride along in the PDF: an assessment of a package that
  // does not show the package is hard to act on and harder to challenge.
  const pdf = await scanReportPdf(report, loadScanImages(db, req.params.id));
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
