import type { DB } from '../../db/index.js';
import { now } from '../../db/index.js';
import { newId } from '../../core/ids.js';
import { providers } from '../../providers/registry.js';
import type { AssetInput, ExtractionCandidate } from '../../providers/types.js';
import { registerHandler, type JobRow } from './queue.js';
import { normalizeDeclaration } from '../declarations/normalize.js';
import { recordAudit } from '../audit/service.js';
import { refreshSearchIndexForInspection } from '../search/service.js';
import { objectStore } from '../../providers/objectStore.js';
import { imageSize } from '../../core/imageSize.js';

// Asynchronous evidence pipeline (VIS-02..04, EXT-01..05).
// process_evidence  (target = evidence asset): quality → layout → OCR (idempotent upsert by asset)
// extract_declarations (target = inspection): candidates → merge → normalize → declarations

export function assetInput(db: DB, asset: any): AssetInput {
  const product = db
    .prepare('SELECT * FROM products WHERE inspection_id = ?')
    .get(asset.inspection_id) as any;
  const loadContent = asset.storage_key ? () => objectStore.get(asset.storage_key) : undefined;
  let size: { w: number; h: number } | null = null;
  if (loadContent && asset.kind === 'image') {
    try { size = imageSize(loadContent()); } catch { size = null; }
  }
  return {
    assetId: asset.id,
    sha256: asset.sha256 ?? '',
    mime: asset.mime ?? 'application/octet-stream',
    faceLabel: asset.face_label,
    structuredJson: asset.structured_json ? JSON.parse(asset.structured_json) : undefined,
    productContext: product
      ? {
          brand: product.brand, genericName: product.generic_name, category: product.category,
          importStatus: product.import_status, packSize: product.pack_size,
        }
      : undefined,
    loadContent,
    imageSize: size,
  };
}

async function processEvidence(db: DB, job: JobRow) {
  const asset = db.prepare('SELECT * FROM evidence_assets WHERE id = ?').get(job.target_id) as any;
  if (!asset) throw new Error(`Asset ${job.target_id} not found`);
  const input = assetInput(db, asset);
  const t = now();

  // Idempotent: replace this asset's machine-generated rows on re-run (no duplicate finals).
  db.prepare('DELETE FROM quality_assessments WHERE asset_id = ?').run(asset.id);
  db.prepare('DELETE FROM layout_regions WHERE asset_id = ? AND edited_by IS NULL').run(asset.id);
  db.prepare('DELETE FROM ocr_blocks WHERE asset_id = ?').run(asset.id);

  const q = await providers.quality.assess(input);
  db.prepare(
    `INSERT INTO quality_assessments (id, asset_id, provider, model_version, is_mock, scores_json,
       reason_codes_json, recapture_json, overall, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId('qa'), asset.id, q.provider, q.modelVersion, q.isMock ? 1 : 0,
    JSON.stringify(q.scores), JSON.stringify(q.reasonCodes), JSON.stringify(q.recapture), q.overall, t);

  const layout = await providers.layout.detect(input);
  const insLayout = db.prepare(
    `INSERT INTO layout_regions (id, asset_id, kind, bbox_json, confidence, provider, model_version, is_mock, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of layout.regions) {
    insLayout.run(newId('lay'), asset.id, r.kind, JSON.stringify(r.bbox), r.confidence,
      layout.provider, layout.modelVersion, layout.isMock ? 1 : 0, t);
  }

  const ocr = await providers.ocr.recognize(input);
  const insOcr = db.prepare(
    `INSERT INTO ocr_blocks (id, asset_id, block_type, text, bbox_json, reading_order, script, lang,
       confidence, provider, model_version, is_mock, created_at) VALUES (?, ?, 'line', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const blockIds: string[] = [];
  for (const b of ocr.blocks) {
    const id = newId('ocr');
    blockIds.push(id);
    insOcr.run(id, asset.id, b.text, JSON.stringify(b.bbox), b.readingOrder, b.script, b.lang,
      b.confidence, ocr.provider, ocr.modelVersion, ocr.isMock ? 1 : 0, t);
  }

  recordAudit(db, {
    actorLabel: 'system', action: 'processing.evidence_processed', objectType: 'evidence_asset',
    objectId: asset.id, correlationId: job.correlation_id,
    after: { quality: q.overall, reasonCodes: q.reasonCodes, ocrBlocks: ocr.blocks.length,
      modelVersions: { quality: q.modelVersion, layout: layout.modelVersion, ocr: ocr.modelVersion }, isMock: q.isMock },
  });
}

async function extractDeclarations(db: DB, job: JobRow) {
  const inspectionId = job.target_id;
  const assets = db.prepare('SELECT * FROM evidence_assets WHERE inspection_id = ?').all(inspectionId) as any[];
  const t = now();

  interface Cand extends ExtractionCandidate { assetId: string; ocrBlockIds: string[] }
  const all: Cand[] = [];
  let extractionMeta = { provider: 'none', modelVersion: 'none', isMock: true };

  for (const asset of assets) {
    const blocks = db
      .prepare('SELECT * FROM ocr_blocks WHERE asset_id = ? ORDER BY reading_order')
      .all(asset.id) as any[];
    if (blocks.length === 0 && !asset.structured_json) continue;
    const ocrResult = {
      provider: blocks[0]?.provider ?? 'none', modelVersion: blocks[0]?.model_version ?? 'none',
      isMock: !!(blocks[0]?.is_mock ?? 1),
      blocks: blocks.map((b) => ({
        text: b.text, bbox: JSON.parse(b.bbox_json), readingOrder: b.reading_order,
        script: b.script, lang: b.lang, confidence: b.confidence,
      })),
    };
    const res = await providers.extraction.extract(assetInput(db, asset), ocrResult as any);
    extractionMeta = { provider: res.provider, modelVersion: res.modelVersion, isMock: res.isMock };
    for (const c of res.candidates) {
      all.push({ ...c, assetId: asset.id, ocrBlockIds: c.ocrBlockIndexes.map((i) => blocks[i]?.id).filter(Boolean) });
    }
  }

  // Idempotent re-run: preserve officer-corrected declarations, replace machine ones.
  const corrected = new Set(
    (db.prepare(
      `SELECT DISTINCT d.id FROM declarations d
       JOIN declaration_corrections c ON c.declaration_id = d.id WHERE d.inspection_id = ?`,
    ).all(inspectionId) as any[]).map((r) => r.id),
  );
  const existing = db.prepare('SELECT id FROM declarations WHERE inspection_id = ?').all(inspectionId) as any[];
  for (const d of existing) {
    if (!corrected.has(d.id)) db.prepare('DELETE FROM declarations WHERE id = ?').run(d.id);
  }
  const correctedTypes = new Set(
    (db.prepare('SELECT decl_type, source_channel FROM declarations WHERE inspection_id = ?').all(inspectionId) as any[])
      .map((r) => `${r.decl_type}|${r.source_channel}`),
  );

  // Merge per (declType, channel) across faces (EXT-05); detect value conflicts.
  const groups = new Map<string, Cand[]>();
  for (const c of all) {
    const key = `${c.declType}|${c.sourceChannel}`;
    if (correctedTypes.has(key)) continue; // officer-corrected declaration wins
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  const ins = db.prepare(
    `INSERT INTO declarations (id, inspection_id, decl_type, verbatim_text, normalized_json, unit, lang, script,
       confidence, needs_review, review_reasons_json, evidence_regions_json, presentation_mode, source_channel,
       provider, model_version, is_mock, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  const product = db.prepare('SELECT * FROM products WHERE inspection_id = ?').get(inspectionId) as any;

  for (const [key, cands] of groups) {
    const [declType, channel] = key.split('|');
    const primary = cands.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    const normalized = normalizeDeclaration(declType, primary.verbatimText);
    const reviewReasons: string[] = [];
    if (normalized.ambiguous) reviewReasons.push('AMBIGUOUS_PARSE');
    if (primary.confidence < 0.7) reviewReasons.push('LOW_CONFIDENCE');

    // Conflict detection across faces (REG-05 input): differing normalized values.
    const values = new Set(
      cands.map((c) => JSON.stringify(normalizeDeclaration(declType, c.verbatimText).value)),
    );
    const conflict = values.size > 1;
    if (conflict) reviewReasons.push('CONFLICTING_VALUES_ACROSS_FACES');

    const regions = cands.map((c) => ({ assetId: c.assetId, bbox: c.bbox, ocrBlockIds: c.ocrBlockIds, verbatim: c.verbatimText }));
    ins.run(
      newId('dec'), inspectionId, declType, primary.verbatimText,
      JSON.stringify({ ...normalized, conflictingValues: conflict ? cands.map((c) => c.verbatimText) : undefined }),
      normalized.unit ?? null, primary.lang, primary.script, primary.confidence,
      reviewReasons.length > 0 ? 1 : 0, JSON.stringify(reviewReasons), JSON.stringify(regions),
      product?.presentation_mode ?? 'printed', channel,
      extractionMeta.provider, extractionMeta.modelVersion, extractionMeta.isMock ? 1 : 0, t, t,
    );
  }

  db.prepare("UPDATE inspections SET status = CASE WHEN status IN ('draft','capturing','processing') THEN 'review' ELSE status END, updated_at = ? WHERE id = ?")
    .run(t, inspectionId);
  refreshSearchIndexForInspection(db, inspectionId);
  recordAudit(db, {
    actorLabel: 'system', action: 'processing.declarations_extracted', objectType: 'inspection',
    objectId: inspectionId, correlationId: job.correlation_id,
    after: { declarations: groups.size, provider: extractionMeta.provider, modelVersion: extractionMeta.modelVersion, isMock: extractionMeta.isMock },
  });
}

export function registerPipelineHandlers() {
  registerHandler('process_evidence', processEvidence);
  registerHandler('extract_declarations', extractDeclarations);
}
