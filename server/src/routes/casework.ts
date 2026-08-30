import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import multer from 'multer';

// Express 4 does not forward async rejections — wrap async handlers explicitly.
const ah = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res, next).catch(next); };
import { getDb } from '../db/index.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { config } from '../core/config.js';
import { badRequest, forbidden, notFound } from '../core/errors.js';
import { signAssetUrl, verifyAssetSig, sha256Hex } from '../core/crypto.js';
import { assertInScope, scopeWhere } from '../modules/auth/service.js';
import {
  createInspection, updateInspection, getInspection, listInspections, upsertProduct,
  waiveView, coverageStatus, duplicateSuggestions, caseTimeline, INSPECTION_TYPES,
} from '../modules/inspections/service.js';
import {
  ingestFileEvidence, ingestUrlEvidence, addCalibration, getAssetContent,
  listInspectionAssets, assetRowToDto,
} from '../modules/evidence/service.js';
import { enqueueJob } from '../modules/processing/queue.js';
import { listDeclarations, correctDeclaration, listCorrections } from '../modules/declarations/service.js';
import { runEvaluation, listEvaluations } from '../modules/evaluation/service.js';
import { listFindings, disposeFinding, approveDisposition } from '../modules/findings/service.js';
import {
  finalizeInspection, amendReport, getReport, getReportByInspection, verifyReport,
} from '../modules/reports/service.js';
import { exportCsv, exportDocx, exportJson, exportManifest, exportPdf } from '../modules/reports/exporters.js';
import { searchRepository } from '../modules/search/service.js';
import {
  enforcementOverview, operationsDashboard, violationIntelligence,
  modelQualityDashboard, ruleAdminDashboard,
} from '../modules/analytics/service.js';
import { createNotice, updateNotice, createReinspection, addAnnotation } from '../modules/cases/service.js';
import { recordAudit } from '../modules/audit/service.js';

export const caseworkRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.upload.maxBytes } });

// ---- Inspections (INS) ------------------------------------------------------
const productSchema = z.object({
  brand: z.string().optional(), genericName: z.string().optional(), category: z.string().optional(),
  gtin: z.string().optional(), sku: z.string().optional(), batchLot: z.string().optional(),
  packageForm: z.string().optional(), packageType: z.string().optional(), packSize: z.string().optional(),
  importStatus: z.enum(['domestic', 'imported']).optional(),
  presentationMode: z.enum(['printed', 'molded_embossed_perforated']).optional(),
}).optional();

caseworkRouter.post(
  '/inspections',
  requireAuth, requirePerm('inspection.create'),
  validateBody(z.object({
    type: z.enum(INSPECTION_TYPES), eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    clientRef: z.string().max(80).optional(),
    location: z.string().optional(), sellerName: z.string().optional(),
    dueDate: z.string().optional(), priority: z.string().optional(), notes: z.string().optional(),
    parentInspectionId: z.string().optional(), reinspectionOfFindingId: z.string().optional(),
    product: productSchema,
  })),
  (req, res) => {
    res.status(201).json(createInspection(getDb(), req.user!, req.body, req.correlationId));
  },
);

caseworkRouter.get('/inspections', requireAuth, requirePerm('inspection.read'), (req, res) => {
  const q = req.query as Record<string, string>;
  res.json({
    inspections: listInspections(getDb(), req.user!, {
      status: q.status, type: q.type, assignedTo: q.assignedTo === 'me' ? req.user!.id : q.assignedTo,
      q: q.q, limit: q.limit ? Number(q.limit) : undefined, offset: q.offset ? Number(q.offset) : undefined,
    }),
  });
});

caseworkRouter.get('/inspections/:id', requireAuth, requirePerm('inspection.read'), (req, res) => {
  const db = getDb();
  assertInScope(db, req.user!, req.params.id);
  const inspection = getInspection(db, req.params.id);
  res.json({
    inspection,
    coverage: coverageStatus(db, req.params.id),
    assets: listInspectionAssets(db, req.params.id),
    duplicates: duplicateSuggestions(db, req.user!, req.params.id),
  });
});

caseworkRouter.patch(
  '/inspections/:id',
  requireAuth, requirePerm('inspection.edit'),
  validateBody(z.object({
    location: z.string().optional(), notes: z.string().optional(), assignedTo: z.string().optional(),
    dueDate: z.string().optional(), priority: z.string().optional(), status: z.string().optional(),
    eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })),
  (req, res) => {
    const db = getDb();
    assertInScope(db, req.user!, req.params.id);
    res.json(updateInspection(db, req.user!, req.params.id, req.body));
  },
);

caseworkRouter.put(
  '/inspections/:id/product',
  requireAuth, requirePerm('inspection.edit'),
  validateBody(productSchema.unwrap()),
  (req, res) => {
    const db = getDb();
    assertInScope(db, req.user!, req.params.id);
    upsertProduct(db, req.user!, req.params.id, req.body);
    res.json(getInspection(db, req.params.id));
  },
);

caseworkRouter.post(
  '/inspections/:id/waive-view',
  requireAuth, requirePerm('inspection.edit'),
  validateBody(z.object({ view: z.string(), reason: z.string().min(3) })),
  (req, res) => {
    const db = getDb();
    assertInScope(db, req.user!, req.params.id);
    waiveView(db, req.user!, req.params.id, req.body.view, req.body.reason);
    res.json(coverageStatus(db, req.params.id));
  },
);

caseworkRouter.get('/inspections/:id/timeline', requireAuth, requirePerm('inspection.read'), (req, res) => {
  const db = getDb();
  assertInScope(db, req.user!, req.params.id);
  res.json(caseTimeline(db, req.params.id));
});

caseworkRouter.post('/inspections/:id/reinspect', requireAuth, requirePerm('inspection.create'), (req, res) => {
  const db = getDb();
  assertInScope(db, req.user!, req.params.id);
  res.status(201).json(createReinspection(db, req.user!, req.params.id, req.body?.findingId));
});

// ---- Evidence (VIS / ECM) ---------------------------------------------------
caseworkRouter.post(
  '/inspections/:id/evidence',
  requireAuth, requirePerm('evidence.upload'),
  upload.array('files', 20),
  ah(async (req, res) => {
    const db = getDb();
    assertInScope(db, req.user!, req.params.id);
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (files.length === 0) throw badRequest('No files supplied (multipart field name: files)');
    const ids: string[] = [];
    for (const f of files) {
      ids.push(await ingestFileEvidence(db, req.user!, req.params.id, f, {
        faceLabel: req.body.faceLabel, source: req.body.source, capturedAt: req.body.capturedAt,
        device: req.body.device ? JSON.parse(req.body.device) : undefined,
        gps: req.body.gps ? JSON.parse(req.body.gps) : undefined,
      }, req.correlationId));
    }
    res.status(201).json({ assetIds: ids, coverage: coverageStatus(db, req.params.id) });
  }),
);

caseworkRouter.post(
  '/inspections/:id/evidence/url',
  requireAuth, requirePerm('evidence.upload'),
  validateBody(z.object({
    url: z.string().url(), marketplace: z.string().optional(), seller: z.string().optional(),
    structured: z.record(z.unknown()).optional(),
  })),
  (req, res) => {
    const db = getDb();
    assertInScope(db, req.user!, req.params.id);
    const id = ingestUrlEvidence(db, req.user!, req.params.id, req.body, req.correlationId);
    res.status(201).json({ assetId: id });
  },
);

caseworkRouter.post(
  '/assets/:id/calibration',
  requireAuth, requirePerm('evidence.upload'),
  validateBody(z.object({
    method: z.enum(['marker', 'known_dimension', 'device', 'manual']),
    mmPerPx: z.number().positive(), uncertaintyPct: z.number().min(0).max(100).optional(),
    instrument: z.string().optional(), notes: z.string().optional(),
  })),
  (req, res) => {
    const db = getDb();
    const asset = db.prepare('SELECT inspection_id FROM evidence_assets WHERE id = ?').get(req.params.id) as any;
    if (!asset) throw notFound('Asset not found');
    assertInScope(db, req.user!, asset.inspection_id);
    res.status(201).json({ calibrationId: addCalibration(db, req.user!, req.params.id, req.body) });
  },
);

caseworkRouter.get('/assets/:id', requireAuth, requirePerm('evidence.read'), (req, res) => {
  const db = getDb();
  const a = db.prepare('SELECT * FROM evidence_assets WHERE id = ?').get(req.params.id) as any;
  if (!a) throw notFound('Asset not found');
  assertInScope(db, req.user!, a.inspection_id);
  const quality = db.prepare('SELECT * FROM quality_assessments WHERE asset_id = ? ORDER BY created_at DESC LIMIT 1').get(req.params.id) as any;
  const ocrBlocks = db.prepare('SELECT * FROM ocr_blocks WHERE asset_id = ? ORDER BY reading_order').all(req.params.id) as any[];
  const layout = db.prepare('SELECT * FROM layout_regions WHERE asset_id = ?').all(req.params.id) as any[];
  const calibrations = db.prepare('SELECT * FROM calibrations WHERE asset_id = ? ORDER BY created_at DESC').all(req.params.id) as any[];
  res.json({
    asset: assetRowToDto(a),
    quality: quality ? {
      provider: quality.provider, modelVersion: quality.model_version, isMock: !!quality.is_mock,
      scores: JSON.parse(quality.scores_json), reasonCodes: JSON.parse(quality.reason_codes_json),
      recapture: JSON.parse(quality.recapture_json), overall: quality.overall,
    } : null,
    ocrBlocks: ocrBlocks.map((b) => ({
      id: b.id, text: b.text, bbox: JSON.parse(b.bbox_json), readingOrder: b.reading_order,
      script: b.script, lang: b.lang, confidence: b.confidence,
      provider: b.provider, modelVersion: b.model_version, isMock: !!b.is_mock,
    })),
    layoutRegions: layout.map((l) => ({ id: l.id, kind: l.kind, bbox: JSON.parse(l.bbox_json), confidence: l.confidence, isMock: !!l.is_mock })),
    calibrations: calibrations.map((c) => ({ id: c.id, method: c.method, mmPerPx: c.mm_per_px, uncertaintyPct: c.uncertainty_pct, instrument: c.instrument })),
  });
});

// Signed, expiring retrieval (no public predictable URLs). Access via session
// (scope-checked) or a short-lived signature minted by an authorized user.
caseworkRouter.post('/assets/:id/signed-url', requireAuth, requirePerm('evidence.read'), (req, res) => {
  const db = getDb();
  const a = db.prepare('SELECT inspection_id FROM evidence_assets WHERE id = ?').get(req.params.id) as any;
  if (!a) throw notFound('Asset not found');
  assertInScope(db, req.user!, a.inspection_id);
  const exp = Math.floor(Date.now() / 1000) + config.assetUrlTtlSeconds;
  res.json({ url: `/api/v1/assets/${req.params.id}/content?exp=${exp}&sig=${signAssetUrl(req.params.id, exp)}` });
});

caseworkRouter.get('/assets/:id/content', (req, res) => {
  const db = getDb();
  const { exp, sig } = req.query as Record<string, string>;
  const signedOk = exp && sig && verifyAssetSig(req.params.id, Number(exp), sig);
  if (!signedOk) {
    if (!req.user) throw forbidden('Authentication or a valid signed URL is required');
    const a = db.prepare('SELECT inspection_id FROM evidence_assets WHERE id = ?').get(req.params.id) as any;
    if (!a) throw notFound('Asset not found');
    assertInScope(db, req.user, a.inspection_id);
  }
  const { buf, mime, name } = getAssetContent(db, req.params.id);
  recordAudit(db, {
    actorId: req.user?.id ?? null, actorLabel: req.user?.email ?? 'signed-url', action: 'evidence.read',
    objectType: 'evidence_asset', objectId: req.params.id, correlationId: req.correlationId,
  });
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(name)}"`);
  res.send(buf);
});

// ---- Processing (async pipeline) -------------------------------------------
caseworkRouter.post('/inspections/:id/process', requireAuth, requirePerm('processing.run'), (req, res) => {
  const db = getDb();
  assertInScope(db, req.user!, req.params.id);
  const assets = db.prepare(
    "SELECT id, sha256 FROM evidence_assets WHERE inspection_id = ? AND (storage_key IS NOT NULL OR structured_json IS NOT NULL)",
  ).all(req.params.id) as any[];
  if (assets.length === 0) throw badRequest('No processable evidence on this inspection');
  const clientKey = (req.headers['idempotency-key'] as string) || '';
  const jobs: any[] = [];
  for (const a of assets) {
    jobs.push(enqueueJob(db, {
      type: 'process_evidence', targetId: a.id,
      idempotencyKey: clientKey ? `${clientKey}:pe:${a.id}` : `pe:${a.id}:${a.sha256}`,
      correlationId: req.correlationId, requestedBy: req.user!.id,
    }));
  }
  const setHash = sha256Hex(assets.map((a) => a.id).sort().join(','));
  jobs.push(enqueueJob(db, {
    type: 'extract_declarations', targetId: req.params.id,
    idempotencyKey: clientKey ? `${clientKey}:ex` : `ex:${req.params.id}:${setHash}`,
    correlationId: req.correlationId, requestedBy: req.user!.id,
  }));
  db.prepare("UPDATE inspections SET status = 'processing', updated_at = datetime('now') WHERE id = ? AND status IN ('draft','capturing')")
    .run(req.params.id);
  res.status(202).json({ jobs });
});

caseworkRouter.get('/inspections/:id/jobs', requireAuth, requirePerm('inspection.read'), (req, res) => {
  const db = getDb();
  assertInScope(db, req.user!, req.params.id);
  const jobs = db.prepare(
    `SELECT id, type, target_id, status, attempts, progress, error, correlation_id, created_at, updated_at
     FROM processing_jobs WHERE target_id = ? OR target_id IN (SELECT id FROM evidence_assets WHERE inspection_id = ?)
     ORDER BY created_at DESC LIMIT 50`,
  ).all(req.params.id, req.params.id);
  res.json({ jobs });
});

// ---- Declarations (EXT) -----------------------------------------------------
caseworkRouter.get('/inspections/:id/declarations', requireAuth, requirePerm('inspection.read'), (req, res) => {
  const db = getDb();
  assertInScope(db, req.user!, req.params.id);
  res.json({ declarations: listDeclarations(db, req.params.id) });
});

caseworkRouter.post(
  '/declarations/:id/correct',
  requireAuth, requirePerm('declaration.edit'),
  validateBody(z.object({ field: z.string(), newValue: z.unknown(), reason: z.string().min(3) })),
  (req, res) => {
    const db = getDb();
    const d = db.prepare('SELECT inspection_id FROM declarations WHERE id = ?').get(req.params.id) as any;
    if (!d) throw notFound('Declaration not found');
    assertInScope(db, req.user!, d.inspection_id);
    res.json(correctDeclaration(db, req.user!, req.params.id, req.body as any, req.correlationId));
  },
);

caseworkRouter.get('/declarations/:id/corrections', requireAuth, requirePerm('inspection.read'), (req, res) => {
  res.json({ corrections: listCorrections(getDb(), req.params.id) });
});

// ---- Evaluation (REG) -------------------------------------------------------
caseworkRouter.post('/inspections/:id/evaluate', requireAuth, requirePerm('evaluation.run'), ah(async (req, res) => {
  const db = getDb();
  assertInScope(db, req.user!, req.params.id);
  res.json(await runEvaluation(db, req.user!, req.params.id, req.correlationId));
}));

caseworkRouter.get('/inspections/:id/evaluations', requireAuth, requirePerm('inspection.read'), (req, res) => {
  const db = getDb();
  assertInScope(db, req.user!, req.params.id);
  res.json(listEvaluations(db, req.params.id, (req.query.runId as string) || undefined));
});

// ---- Findings & dispositions (REV) -----------------------------------------
caseworkRouter.get('/inspections/:id/findings', requireAuth, requirePerm('inspection.read'), (req, res) => {
  const db = getDb();
  assertInScope(db, req.user!, req.params.id);
  res.json({ findings: listFindings(db, req.params.id) });
});

caseworkRouter.post(
  '/findings/:id/disposition',
  requireAuth, requirePerm('finding.disposition'),
  validateBody(z.object({
    action: z.enum(['confirm', 'dismiss', 'defer', 'override', 'not_applicable', 'not_assessable']),
    toOutcome: z.enum(['passed', 'failed', 'needs_review', 'not_applicable', 'not_assessable']).optional(),
    reason: z.string().min(3),
  })),
  (req, res) => {
    const db = getDb();
    const f = db.prepare('SELECT inspection_id FROM findings WHERE id = ?').get(req.params.id) as any;
    if (!f) throw notFound('Finding not found');
    assertInScope(db, req.user!, f.inspection_id);
    if (req.body.action === 'override' && !['inspector', 'reviewer'].includes(req.user!.role)) {
      throw forbidden('Only inspecting/reviewing officers may override findings');
    }
    res.json(disposeFinding(db, req.user!, req.params.id, req.body, req.correlationId));
  },
);

caseworkRouter.post('/dispositions/:id/approve', requireAuth, requirePerm('finding.approve_override'), (req, res) => {
  approveDisposition(getDb(), req.user!, req.params.id, req.correlationId);
  res.json({ ok: true });
});

// ---- Annotations & notices --------------------------------------------------
caseworkRouter.post(
  '/inspections/:id/annotations',
  requireAuth, requirePerm('inspection.edit'),
  validateBody(z.object({
    assetId: z.string().optional(), kind: z.enum(['rect', 'note', 'measure']),
    geometry: z.unknown().optional(), text: z.string().optional(),
  })),
  (req, res) => {
    const db = getDb();
    assertInScope(db, req.user!, req.params.id);
    res.status(201).json({ annotationId: addAnnotation(db, req.user!, req.params.id, req.body as any) });
  },
);

caseworkRouter.post(
  '/inspections/:id/notices',
  requireAuth, requirePerm('notice.manage'),
  validateBody(z.object({ kind: z.enum(['warning', 'improvement']), templateKey: z.string().optional(), dueDate: z.string().optional() })),
  (req, res) => {
    const db = getDb();
    assertInScope(db, req.user!, req.params.id);
    res.status(201).json({ noticeId: createNotice(db, req.user!, req.params.id, req.body) });
  },
);

caseworkRouter.patch(
  '/notices/:id',
  requireAuth, requirePerm('notice.manage'),
  validateBody(z.object({ status: z.string().optional(), response: z.unknown().optional() })),
  (req, res) => {
    updateNotice(getDb(), req.user!, req.params.id, req.body as any);
    res.json({ ok: true });
  },
);

// ---- Finalization & reports (RPT) ------------------------------------------
caseworkRouter.post('/inspections/:id/finalize', requireAuth, requirePerm('report.finalize'), (req, res) => {
  const db = getDb();
  assertInScope(db, req.user!, req.params.id);
  res.json(finalizeInspection(db, req.user!, req.params.id, req.correlationId));
});

caseworkRouter.get('/inspections/:id/report', requireAuth, requirePerm('report.read'), (req, res) => {
  const db = getDb();
  assertInScope(db, req.user!, req.params.id);
  const r = getReportByInspection(db, req.params.id);
  if (!r) throw notFound('No report exists for this inspection yet');
  res.json(r);
});

caseworkRouter.post(
  '/reports/:id/amend',
  requireAuth, requirePerm('report.finalize'),
  validateBody(z.object({ reason: z.string().min(3) })),
  (req, res) => {
    const db = getDb();
    const report = db.prepare('SELECT inspection_id FROM reports WHERE id = ?').get(req.params.id) as any;
    if (!report) throw notFound('Report not found');
    assertInScope(db, req.user!, report.inspection_id);
    res.json(amendReport(db, req.user!, req.params.id, req.body.reason, req.correlationId));
  },
);

caseworkRouter.get('/reports/:id/verify', requireAuth, requirePerm('report.read'), (req, res) => {
  res.json(verifyReport(getDb(), req.params.id, req.query.version ? Number(req.query.version) : undefined));
});

caseworkRouter.get('/reports/:id/export/:format', requireAuth, requirePerm('report.export'), ah(async (req, res) => {
  const db = getDb();
  const report = db.prepare('SELECT inspection_id FROM reports WHERE id = ?').get(req.params.id) as any;
  if (!report) throw notFound('Report not found');
  assertInScope(db, req.user!, report.inspection_id);
  const r = getReport(db, req.params.id, req.query.version ? Number(req.query.version) : undefined);
  const bundle = { reportId: r.reportId, inspectionId: r.inspectionId, version: r.version, sha256: r.sha256, snapshot: r.snapshot };
  const fmt = req.params.format;
  let buf: Buffer; let mime: string; let ext: string;
  if (fmt === 'json') { buf = exportJson(bundle); mime = 'application/json'; ext = 'json'; }
  else if (fmt === 'csv') { buf = exportCsv(bundle); mime = 'text/csv; charset=utf-8'; ext = 'csv'; }
  else if (fmt === 'manifest') { buf = exportManifest(bundle); mime = 'application/json'; ext = 'manifest.json'; }
  else if (fmt === 'pdf') { buf = await exportPdf(bundle); mime = 'application/pdf'; ext = 'pdf'; }
  else if (fmt === 'docx') { buf = await exportDocx(bundle); mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; ext = 'docx'; }
  else throw badRequest(`Unknown export format '${fmt}' (pdf, docx, csv, json, manifest)`);
  recordAudit(db, {
    actorId: req.user!.id, actorLabel: req.user!.email, action: 'report.export',
    objectType: 'report', objectId: req.params.id, after: { format: fmt, version: r.version },
    correlationId: req.correlationId,
  });
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename="${r.reportId}-v${r.version}.${ext}"`);
  res.send(buf);
}));

// ---- Search & history (REP) -------------------------------------------------
caseworkRouter.get('/search', requireAuth, requirePerm('search.read'), (req, res) => {
  res.json(searchRepository(getDb(), req.user!, String(req.query.q ?? ''), Number(req.query.limit ?? 25)));
});

caseworkRouter.get('/products/history', requireAuth, requirePerm('search.read'), (req, res) => {
  const db = getDb();
  const { gtin, brand } = req.query as Record<string, string>;
  if (!gtin && !brand) throw badRequest('Provide gtin or brand');
  const w = scopeWhere(req.user!, 'i');
  const rows = db.prepare(
    `SELECT i.id, i.type, i.status, i.event_date, i.location, p.brand, p.generic_name, p.gtin,
       (SELECT COUNT(*) FROM findings f WHERE f.inspection_id = i.id AND f.effective_outcome = 'failed') AS failed_findings
     FROM inspections i JOIN products p ON p.inspection_id = i.id
     WHERE ${w.sql} AND (p.gtin = ? OR p.brand = ?) ORDER BY i.event_date DESC LIMIT 50`,
  ).all(...w.params, gtin ?? '', brand ?? '') as any[];
  res.json({ history: rows });
});

// ---- Dashboards (DASH) ------------------------------------------------------
caseworkRouter.get('/dashboards/enforcement', requireAuth, requirePerm('analytics.view'), (req, res) => {
  res.json(enforcementOverview(getDb(), req.user!));
});
caseworkRouter.get('/dashboards/operations', requireAuth, requirePerm('analytics.view'), (req, res) => {
  res.json(operationsDashboard(getDb(), req.user!));
});
caseworkRouter.get('/dashboards/violations', requireAuth, requirePerm('analytics.view'), (req, res) => {
  res.json(violationIntelligence(getDb(), req.user!));
});
caseworkRouter.get('/dashboards/model-quality', requireAuth, requirePerm('analytics.view'), (req, res) => {
  res.json(modelQualityDashboard(getDb(), req.user!));
});
caseworkRouter.get('/dashboards/rule-admin', requireAuth, requirePerm('rule.read'), (_req, res) => {
  res.json(ruleAdminDashboard(getDb()));
});
