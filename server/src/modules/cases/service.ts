import type { DB } from '../../db/index.js';
import { now } from '../../db/index.js';
import { newId } from '../../core/ids.js';
import { badRequest, notFound } from '../../core/errors.js';
import { recordAudit } from '../audit/service.js';
import type { SessionUser } from '../auth/service.js';
import { createInspection } from '../inspections/service.js';

// Notice / re-inspection lifecycle (REV-06, Journey C). Eligibility for an
// improvement notice is an OFFICER decision under agency policy — the system
// records the workflow, it does not determine legal eligibility.

export function createNotice(
  db: DB, user: SessionUser, inspectionId: string,
  input: { kind: string; templateKey?: string; dueDate?: string },
) {
  if (!['warning', 'improvement'].includes(input.kind)) throw badRequest('Invalid notice kind');
  const insp = db.prepare('SELECT id FROM inspections WHERE id = ?').get(inspectionId);
  if (!insp) throw notFound('Inspection not found');
  const id = newId('ntc');
  const t = now();
  db.prepare(
    `INSERT INTO notices (id, inspection_id, kind, template_key, served_at, due_date, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?)`,
  ).run(id, inspectionId, input.kind, input.templateKey ?? null, t, input.dueDate ?? null, user.id, t, t);
  recordAudit(db, {
    actorId: user.id, actorLabel: user.email, action: 'notice.issued',
    objectType: 'notice', objectId: id, after: { inspectionId, kind: input.kind, dueDate: input.dueDate },
  });
  return id;
}

export function updateNotice(
  db: DB, user: SessionUser, noticeId: string,
  input: { status?: string; response?: unknown },
) {
  const n = db.prepare('SELECT * FROM notices WHERE id = ?').get(noticeId) as any;
  if (!n) throw notFound('Notice not found');
  const allowed = ['issued', 'responded', 'cured', 'not_cured', 'escalated', 'closed'];
  if (input.status && !allowed.includes(input.status)) throw badRequest('Invalid notice status');
  db.prepare('UPDATE notices SET status = COALESCE(?, status), response_json = COALESCE(?, response_json), updated_at = ? WHERE id = ?')
    .run(input.status ?? null, input.response ? JSON.stringify(input.response) : null, now(), noticeId);
  recordAudit(db, {
    actorId: user.id, actorLabel: user.email, action: 'notice.updated',
    objectType: 'notice', objectId: noticeId, before: { status: n.status }, after: input,
  });
}

// Re-inspection preserves lineage (INS-10, REV-07): a NEW inspection linked to
// the original — nothing is overwritten.
export function createReinspection(db: DB, user: SessionUser, inspectionId: string, findingId?: string) {
  const orig = db.prepare('SELECT * FROM inspections WHERE id = ?').get(inspectionId) as any;
  if (!orig) throw notFound('Original inspection not found');
  const origProduct = db.prepare('SELECT * FROM products WHERE inspection_id = ?').get(inspectionId) as any;
  const created = createInspection(db, user, {
    type: orig.type,
    location: orig.location,
    state: orig.state, district: orig.district, office: orig.office,
    parentInspectionId: inspectionId,
    reinspectionOfFindingId: findingId,
    product: origProduct
      ? {
          brand: origProduct.brand, genericName: origProduct.generic_name, category: origProduct.category,
          gtin: origProduct.gtin, sku: origProduct.sku, packageForm: origProduct.package_form,
          packageType: origProduct.package_type, packSize: origProduct.pack_size,
          importStatus: origProduct.import_status, presentationMode: origProduct.presentation_mode,
        }
      : undefined,
  });
  return created;
}

export function addAnnotation(
  db: DB, user: SessionUser, inspectionId: string,
  input: { assetId?: string; kind: string; geometry?: unknown; text?: string },
) {
  if (!['rect', 'note', 'measure'].includes(input.kind)) throw badRequest('Invalid annotation kind');
  const id = newId('ann');
  db.prepare(
    `INSERT INTO annotations (id, inspection_id, asset_id, kind, geometry_json, text, actor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, inspectionId, input.assetId ?? null, input.kind,
    input.geometry ? JSON.stringify(input.geometry) : null, input.text ?? null, user.id, now());
  recordAudit(db, {
    actorId: user.id, actorLabel: user.email, action: 'annotation.added',
    objectType: 'inspection', objectId: inspectionId, after: input,
  });
  return id;
}
