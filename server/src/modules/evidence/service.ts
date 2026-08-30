import type { DB } from '../../db/index.js';
import { now } from '../../db/index.js';
import { newId } from '../../core/ids.js';
import { badRequest, conflict, notFound, unprocessable } from '../../core/errors.js';
import { config } from '../../core/config.js';
import { objectStore } from '../../providers/objectStore.js';
import { providers } from '../../providers/registry.js';
import { recordAudit } from '../audit/service.js';
import type { SessionUser } from '../auth/service.js';
import { sha256Hex } from '../../core/crypto.js';

const FACE_LABELS = ['front', 'back', 'side', 'top', 'bottom', 'closeup', 'listing', 'other'];

function detectMagic(buf: Buffer): string | null {
  if (buf.length < 8) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (buf.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return 'image/heic';
  return null;
}

export async function ingestFileEvidence(
  db: DB,
  user: SessionUser,
  inspectionId: string,
  file: { buffer: Buffer; originalname: string; mimetype: string },
  meta: { faceLabel?: string; source?: string; capturedAt?: string; device?: unknown; gps?: unknown },
  correlationId?: string,
): Promise<string> {
  assertMutableInspection(db, inspectionId);
  if (file.buffer.length > config.upload.maxBytes) throw badRequest('File exceeds the configured size limit');
  const magic = detectMagic(file.buffer);
  if (!magic || !config.upload.allowedMime.includes(magic === 'image/heic' ? 'image/heic' : magic)) {
    throw unprocessable(`File content is not an allowed type (JPEG, PNG, HEIC, PDF). Detected: ${magic ?? 'unknown'}`);
  }
  if (meta.faceLabel && !FACE_LABELS.includes(meta.faceLabel)) throw badRequest('Invalid face label');

  const scan = await providers.malware.scan(file.buffer, file.originalname);
  if (!scan.clean) {
    recordAudit(db, {
      actorId: user.id, actorLabel: user.email, action: 'evidence.upload', outcome: 'denied',
      objectType: 'inspection', objectId: inspectionId,
      after: { reason: 'malware_detected', threat: scan.threat, filename: file.originalname },
      correlationId,
    });
    throw unprocessable(`Upload rejected by malware scan (${scan.threat})`);
  }

  // Immutable original: content-addressed write-once storage + hash (VIS-01).
  const { sha256, storageKey } = objectStore.put(file.buffer);
  const id = newId('ev');
  const t = now();
  db.prepare(
    `INSERT INTO evidence_assets (id, inspection_id, kind, face_label, sha256, size_bytes, mime, storage_key,
      original_name, source, captured_at, received_at, uploader_id, device_json, gps_json, upload_state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?)`,
  ).run(
    id, inspectionId, magic === 'application/pdf' ? 'pdf' : 'image',
    meta.faceLabel ?? null, sha256, file.buffer.length, magic, storageKey,
    file.originalname, meta.source ?? 'upload', meta.capturedAt ?? null, t, user.id,
    meta.device ? JSON.stringify(meta.device) : null, meta.gps ? JSON.stringify(meta.gps) : null, t,
  );
  recordAudit(db, {
    actorId: user.id, actorLabel: user.email, action: 'evidence.upload',
    objectType: 'evidence_asset', objectId: id,
    after: { inspectionId, sha256, faceLabel: meta.faceLabel, name: file.originalname },
    correlationId,
  });
  return id;
}

export function ingestUrlEvidence(
  db: DB, user: SessionUser, inspectionId: string,
  data: { url: string; marketplace?: string; seller?: string; structured?: unknown },
  correlationId?: string,
): string {
  assertMutableInspection(db, inspectionId);
  // MVP e-commerce policy (ECM-07): no automated crawling at all. The URL and
  // structured fields entered by the officer are preserved as evidence; page
  // captures arrive via the screenshot/PDF upload path.
  const id = newId('ev');
  const t = now();
  const structuredStr = data.structured ? JSON.stringify(data.structured) : null;
  db.prepare(
    `INSERT INTO evidence_assets (id, inspection_id, kind, face_label, sha256, source, url, marketplace, seller,
      structured_json, received_at, uploader_id, upload_state, created_at)
     VALUES (?, ?, ?, 'listing', ?, 'url', ?, ?, ?, ?, ?, ?, 'synced', ?)`,
  ).run(
    id, inspectionId, data.structured ? 'structured_listing' : 'url',
    structuredStr ? sha256Hex(structuredStr) : sha256Hex(data.url),
    data.url, data.marketplace ?? null, data.seller ?? null, structuredStr, t, user.id, t,
  );
  recordAudit(db, {
    actorId: user.id, actorLabel: user.email, action: 'evidence.url_added',
    objectType: 'evidence_asset', objectId: id, after: { inspectionId, url: data.url }, correlationId,
  });
  return id;
}

export function addCalibration(
  db: DB, user: SessionUser, assetId: string,
  c: { method: string; mmPerPx: number; uncertaintyPct?: number; instrument?: string; notes?: string },
): string {
  const asset = db.prepare('SELECT * FROM evidence_assets WHERE id = ?').get(assetId) as any;
  if (!asset) throw notFound('Evidence asset not found');
  assertMutableInspection(db, asset.inspection_id);
  if (!['marker', 'known_dimension', 'device', 'manual'].includes(c.method)) throw badRequest('Invalid calibration method');
  if (!(c.mmPerPx > 0 && c.mmPerPx < 100)) throw badRequest('mm-per-pixel value out of plausible range');
  const id = newId('cal');
  db.prepare(
    `INSERT INTO calibrations (id, asset_id, method, mm_per_px, uncertainty_pct, instrument, notes, entered_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, assetId, c.method, c.mmPerPx, c.uncertaintyPct ?? null, c.instrument ?? null, c.notes ?? null, user.id, now());
  recordAudit(db, {
    actorId: user.id, actorLabel: user.email, action: 'evidence.calibration_added',
    objectType: 'evidence_asset', objectId: assetId, after: c,
  });
  return id;
}

export function getAssetContent(db: DB, assetId: string): { buf: Buffer; mime: string; name: string } {
  const asset = db.prepare('SELECT * FROM evidence_assets WHERE id = ?').get(assetId) as any;
  if (!asset || !asset.storage_key) throw notFound('Evidence content not found');
  const buf = objectStore.get(asset.storage_key);
  // Chain-of-custody integrity check on every read (UAT-12).
  if (sha256Hex(buf) !== asset.sha256) {
    throw conflict('EVIDENCE INTEGRITY FAILURE: stored content does not match the recorded hash');
  }
  return { buf, mime: asset.mime ?? 'application/octet-stream', name: asset.original_name ?? asset.id };
}

export function listInspectionAssets(db: DB, inspectionId: string) {
  return (db.prepare('SELECT * FROM evidence_assets WHERE inspection_id = ? ORDER BY created_at').all(inspectionId) as any[])
    .map(assetRowToDto);
}

export function assetRowToDto(a: any) {
  return {
    id: a.id, inspectionId: a.inspection_id, kind: a.kind, faceLabel: a.face_label,
    sha256: a.sha256, sizeBytes: a.size_bytes, mime: a.mime, originalName: a.original_name,
    source: a.source, url: a.url, marketplace: a.marketplace, seller: a.seller,
    structured: a.structured_json ? JSON.parse(a.structured_json) : null,
    capturedAt: a.captured_at, receivedAt: a.received_at, uploaderId: a.uploader_id,
    device: a.device_json ? JSON.parse(a.device_json) : null,
    gps: a.gps_json ? JSON.parse(a.gps_json) : null,
    uploadState: a.upload_state, legalHold: !!a.legal_hold, createdAt: a.created_at,
  };
}

export function assertMutableInspection(db: DB, inspectionId: string) {
  const insp = db.prepare('SELECT status FROM inspections WHERE id = ?').get(inspectionId) as any;
  if (!insp) throw notFound('Inspection not found');
  if (insp.status === 'finalized' || insp.status === 'closed') {
    throw conflict('Inspection is finalized; records are immutable. Create an amendment or linked re-inspection.');
  }
}
