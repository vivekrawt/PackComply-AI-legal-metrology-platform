import type { DB } from '../../db/index.js';
import { now } from '../../db/index.js';
import { newId } from '../../core/ids.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { recordAudit } from '../audit/service.js';
import { scopeWhere, type SessionUser } from '../auth/service.js';
import { assertMutableInspection } from '../evidence/service.js';
import { getConfigItem } from '../admin/configService.js';

export const INSPECTION_TYPES = ['physical_retail', 'warehouse_import', 'back_office', 'complaint', 'ecommerce'] as const;

// Required package views per inspection type (INS-02/04/12) — configuration, not code.
export const DEFAULT_CHECKLISTS: Record<string, string[]> = {
  physical_retail: ['front', 'back'],
  warehouse_import: ['front', 'back', 'side'],
  back_office: ['front', 'back'],
  complaint: ['front'],
  ecommerce: ['listing'],
};

export function requiredViews(db: DB, type: string): string[] {
  const cfg = getConfigItem<Record<string, string[]>>(db, 'checklists') ?? DEFAULT_CHECKLISTS;
  return cfg[type] ?? [];
}

export interface CreateInspectionInput {
  type: string;
  clientRef?: string; // offline-sync idempotency key (client-generated)
  eventDate?: string;
  location?: string;
  state?: string; district?: string; office?: string;
  sellerName?: string;
  assignedTo?: string;
  dueDate?: string;
  priority?: string;
  notes?: string;
  parentInspectionId?: string;
  reinspectionOfFindingId?: string;
  product?: {
    brand?: string; genericName?: string; category?: string; gtin?: string; sku?: string;
    batchLot?: string; packageForm?: string; packageType?: string; packSize?: string;
    importStatus?: string; presentationMode?: string;
  };
}

export function createInspection(db: DB, user: SessionUser, input: CreateInspectionInput, correlationId?: string) {
  if (!INSPECTION_TYPES.includes(input.type as any)) throw badRequest(`Invalid inspection type '${input.type}'`);
  // Idempotent offline sync: same creator + clientRef returns the existing record.
  if (input.clientRef) {
    const existing = db
      .prepare('SELECT id FROM inspections WHERE created_by = ? AND client_ref = ?')
      .get(user.id, input.clientRef) as any;
    if (existing) return getInspection(db, existing.id);
  }
  const id = newId('insp');
  const t = now();
  const eventDate = input.eventDate ?? t.slice(0, 10);

  let sellerEntityId: string | null = null;
  if (input.sellerName) {
    sellerEntityId = newId('ent');
    db.prepare('INSERT INTO entities (id, role, name, created_at) VALUES (?, ?, ?, ?)')
      .run(sellerEntityId, 'seller', input.sellerName, t);
  }

  db.prepare(
    `INSERT INTO inspections (id, type, status, event_date, org_id, state, district, office, location,
       seller_entity_id, assigned_to, due_date, priority, checklist_json, parent_inspection_id,
       reinspection_of_finding_id, notes, created_by, client_ref, created_at, updated_at)
     VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.type, eventDate, user.orgId,
    input.state ?? user.state, input.district ?? user.district, input.office ?? user.office,
    input.location ?? null, sellerEntityId, input.assignedTo ?? user.id,
    input.dueDate ?? null, input.priority ?? 'normal',
    JSON.stringify({ required: requiredViews(db, input.type) }),
    input.parentInspectionId ?? null, input.reinspectionOfFindingId ?? null,
    input.notes ?? null, user.id, input.clientRef ?? null, t, t,
  );

  if (input.product) upsertProduct(db, user, id, input.product);

  recordAudit(db, {
    actorId: user.id, actorLabel: user.email, action: 'inspection.create',
    objectType: 'inspection', objectId: id, after: { type: input.type, eventDate }, correlationId,
  });
  return getInspection(db, id);
}

export function upsertProduct(db: DB, user: SessionUser, inspectionId: string, p: NonNullable<CreateInspectionInput['product']>) {
  assertMutableInspection(db, inspectionId);
  const existing = db.prepare('SELECT id FROM products WHERE inspection_id = ?').get(inspectionId) as any;
  const t = now();
  if (existing) {
    db.prepare(
      `UPDATE products SET brand=?, generic_name=?, category=?, gtin=?, sku=?, batch_lot=?,
       package_form=?, package_type=?, pack_size=?, import_status=?, presentation_mode=?, updated_at=? WHERE id=?`,
    ).run(
      p.brand ?? null, p.genericName ?? null, p.category ?? null, p.gtin ?? null, p.sku ?? null,
      p.batchLot ?? null, p.packageForm ?? null, p.packageType ?? 'retail', p.packSize ?? null,
      p.importStatus ?? 'domestic', p.presentationMode ?? 'printed', t, existing.id,
    );
  } else {
    db.prepare(
      `INSERT INTO products (id, inspection_id, brand, generic_name, category, gtin, sku, batch_lot,
        package_form, package_type, pack_size, import_status, presentation_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId('prd'), inspectionId, p.brand ?? null, p.genericName ?? null, p.category ?? null,
      p.gtin ?? null, p.sku ?? null, p.batchLot ?? null, p.packageForm ?? null,
      p.packageType ?? 'retail', p.packSize ?? null, p.importStatus ?? 'domestic',
      p.presentationMode ?? 'printed', t, t,
    );
  }
  recordAudit(db, {
    actorId: user.id, actorLabel: user.email, action: 'inspection.product_updated',
    objectType: 'inspection', objectId: inspectionId, after: p,
  });
}

export function updateInspection(
  db: DB, user: SessionUser, id: string,
  patch: Partial<{ location: string; notes: string; assignedTo: string; dueDate: string; priority: string; status: string; eventDate: string }>,
) {
  const before = db.prepare('SELECT * FROM inspections WHERE id = ?').get(id) as any;
  if (!before) throw notFound('Inspection not found');
  assertMutableInspection(db, id);
  const allowedStatus = ['draft', 'capturing', 'processing', 'review', 'pending_approval'];
  if (patch.status && !allowedStatus.includes(patch.status)) {
    throw badRequest('Status transition not allowed through this endpoint (finalization has its own flow)');
  }
  db.prepare(
    `UPDATE inspections SET location = COALESCE(?, location), notes = COALESCE(?, notes),
       assigned_to = COALESCE(?, assigned_to), due_date = COALESCE(?, due_date),
       priority = COALESCE(?, priority), status = COALESCE(?, status),
       event_date = COALESCE(?, event_date), updated_at = ? WHERE id = ?`,
  ).run(patch.location ?? null, patch.notes ?? null, patch.assignedTo ?? null, patch.dueDate ?? null,
    patch.priority ?? null, patch.status ?? null, patch.eventDate ?? null, now(), id);
  recordAudit(db, {
    actorId: user.id, actorLabel: user.email, action: 'inspection.update',
    objectType: 'inspection', objectId: id,
    before: { status: before.status, assignedTo: before.assigned_to, location: before.location },
    after: patch,
  });
  return getInspection(db, id);
}

export function waiveView(db: DB, user: SessionUser, id: string, view: string, reason: string) {
  assertMutableInspection(db, id);
  if (!reason?.trim()) throw badRequest('A waiver requires a reason');
  const insp = db.prepare('SELECT waivers_json FROM inspections WHERE id = ?').get(id) as any;
  const waivers = JSON.parse(insp.waivers_json || '[]');
  waivers.push({ view, reason, actorId: user.id, at: now() });
  db.prepare('UPDATE inspections SET waivers_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(waivers), now(), id);
  recordAudit(db, {
    actorId: user.id, actorLabel: user.email, action: 'inspection.view_waived',
    objectType: 'inspection', objectId: id, after: { view, reason },
  });
}

export function coverageStatus(db: DB, id: string) {
  const insp = db.prepare('SELECT * FROM inspections WHERE id = ?').get(id) as any;
  if (!insp) throw notFound('Inspection not found');
  const required: string[] = JSON.parse(insp.checklist_json || '{}').required ?? [];
  const waived = new Set((JSON.parse(insp.waivers_json || '[]') as any[]).map((w) => w.view));
  const have = new Set(
    (db.prepare('SELECT DISTINCT face_label FROM evidence_assets WHERE inspection_id = ?').all(id) as any[])
      .map((r) => r.face_label),
  );
  const missing = required.filter((v) => !have.has(v) && !waived.has(v));
  return { required, captured: [...have].filter(Boolean), waived: [...waived], missing, complete: missing.length === 0 };
}

// Deletion (super_admin only, DEL-01). Soft delete: the row stays so the audit chain,
// evidence hashes and any finalized report remain verifiable, but the record is gone
// from every list, search result, dashboard and scope check. Deleting a finalized
// inspection needs an explicit acknowledgement — a signed report is a legal artefact.
export function deleteInspection(
  db: DB, user: SessionUser, id: string,
  opts: { reason: string; force?: boolean }, correlationId?: string,
) {
  const insp = db.prepare('SELECT * FROM inspections WHERE id = ?').get(id) as any;
  if (!insp) throw notFound('Inspection not found');
  if (insp.deleted_at) throw conflict('Inspection is already deleted');
  if (!opts.reason?.trim()) throw badRequest('Deletion requires a reason (it is written to the audit log)');
  if ((insp.status === 'finalized' || insp.status === 'closed') && !opts.force) {
    throw conflict(
      'This inspection carries a finalized report. Re-send with { force: true } to acknowledge deleting a signed record.',
    );
  }
  const t = now();
  db.transaction(() => {
    db.prepare('UPDATE inspections SET deleted_at = ?, deleted_by = ?, deleted_reason = ?, updated_at = ? WHERE id = ?')
      .run(t, user.id, opts.reason, t, id);
    db.prepare('UPDATE evidence_assets SET deleted_at = ?, deleted_by = ?, deleted_reason = ? WHERE inspection_id = ? AND deleted_at IS NULL')
      .run(t, user.id, 'parent inspection deleted', id);
    db.prepare('DELETE FROM search_index WHERE inspection_id = ?').run(id);
  })();
  recordAudit(db, {
    actorId: user.id, actorLabel: user.email, action: 'inspection.delete',
    objectType: 'inspection', objectId: id,
    before: { status: insp.status, eventDate: insp.event_date },
    after: { deletedAt: t, reason: opts.reason, force: !!opts.force },
    correlationId,
  });
  return { id, deletedAt: t };
}

export function restoreInspection(db: DB, user: SessionUser, id: string, correlationId?: string) {
  const insp = db.prepare('SELECT * FROM inspections WHERE id = ?').get(id) as any;
  if (!insp) throw notFound('Inspection not found');
  if (!insp.deleted_at) throw conflict('Inspection is not deleted');
  const t = now();
  db.transaction(() => {
    db.prepare('UPDATE inspections SET deleted_at = NULL, deleted_by = NULL, deleted_reason = NULL, updated_at = ? WHERE id = ?').run(t, id);
    db.prepare("UPDATE evidence_assets SET deleted_at = NULL, deleted_by = NULL, deleted_reason = NULL WHERE inspection_id = ? AND deleted_reason = 'parent inspection deleted'").run(id);
  })();
  recordAudit(db, {
    actorId: user.id, actorLabel: user.email, action: 'inspection.restore',
    objectType: 'inspection', objectId: id, before: { deletedAt: insp.deleted_at }, correlationId,
  });
  return getInspection(db, id);
}

// Recycle bin for super_admin: the only view in the product that shows deleted rows.
export function listDeletedInspections(db: DB, user: SessionUser, limit = 100) {
  return (db.prepare(
    `SELECT i.id, i.type, i.status, i.event_date, i.location, i.deleted_at, i.deleted_reason, u.email AS deleted_by_email
     FROM inspections i LEFT JOIN users u ON u.id = i.deleted_by
     WHERE i.org_id = ? AND i.deleted_at IS NOT NULL ORDER BY i.deleted_at DESC LIMIT ?`,
  ).all(user.orgId, limit) as any[]).map((i) => ({
    id: i.id, type: i.type, status: i.status, eventDate: i.event_date, location: i.location,
    deletedAt: i.deleted_at, deletedReason: i.deleted_reason, deletedBy: i.deleted_by_email,
  }));
}

export function getInspection(db: DB, id: string) {
  const i = db.prepare('SELECT * FROM inspections WHERE id = ? AND deleted_at IS NULL').get(id) as any;
  if (!i) throw notFound('Inspection not found');
  const product = db.prepare('SELECT * FROM products WHERE inspection_id = ?').get(id) as any;
  const seller = i.seller_entity_id
    ? (db.prepare('SELECT * FROM entities WHERE id = ?').get(i.seller_entity_id) as any)
    : null;
  return {
    id: i.id, type: i.type, status: i.status, eventDate: i.event_date,
    orgId: i.org_id, state: i.state, district: i.district, office: i.office,
    location: i.location, sellerEntity: seller ? { id: seller.id, name: seller.name } : null,
    assignedTo: i.assigned_to, dueDate: i.due_date, priority: i.priority,
    checklist: JSON.parse(i.checklist_json || '{}'), waivers: JSON.parse(i.waivers_json || '[]'),
    parentInspectionId: i.parent_inspection_id, reinspectionOfFindingId: i.reinspection_of_finding_id,
    notes: i.notes, createdBy: i.created_by, createdAt: i.created_at, updatedAt: i.updated_at,
    product: product
      ? {
          id: product.id, brand: product.brand, genericName: product.generic_name, category: product.category,
          gtin: product.gtin, sku: product.sku, batchLot: product.batch_lot, packageForm: product.package_form,
          packageType: product.package_type, packSize: product.pack_size, importStatus: product.import_status,
          presentationMode: product.presentation_mode,
        }
      : null,
  };
}

export function listInspections(
  db: DB, user: SessionUser,
  f: { status?: string; type?: string; assignedTo?: string; q?: string; limit?: number; offset?: number },
) {
  const w = scopeWhere(user, 'i');
  const clauses = [w.sql];
  const params: unknown[] = [...w.params];
  if (f.status) { clauses.push('i.status = ?'); params.push(f.status); }
  if (f.type) { clauses.push('i.type = ?'); params.push(f.type); }
  if (f.assignedTo) { clauses.push('i.assigned_to = ?'); params.push(f.assignedTo); }
  if (f.q) { clauses.push('(i.id LIKE ? OR i.location LIKE ?)'); params.push(`%${f.q}%`, `%${f.q}%`); }
  const rows = db.prepare(
    `SELECT i.*, p.brand, p.generic_name, p.category, p.gtin
     FROM inspections i LEFT JOIN products p ON p.inspection_id = i.id
     WHERE ${clauses.join(' AND ')} ORDER BY i.created_at DESC LIMIT ? OFFSET ?`,
  ).all(...params, f.limit ?? 50, f.offset ?? 0) as any[];
  return rows.map((i) => ({
    id: i.id, type: i.type, status: i.status, eventDate: i.event_date, location: i.location,
    assignedTo: i.assigned_to, dueDate: i.due_date, priority: i.priority,
    brand: i.brand, genericName: i.generic_name, category: i.category, gtin: i.gtin,
    createdAt: i.created_at,
  }));
}

// INS-10: duplicate suggestions by GTIN/brand within scope, and lineage links.
export function duplicateSuggestions(db: DB, user: SessionUser, inspectionId: string) {
  const p = db.prepare('SELECT * FROM products WHERE inspection_id = ?').get(inspectionId) as any;
  if (!p) return [];
  const w = scopeWhere(user, 'i');
  const rows = db.prepare(
    `SELECT i.id, i.status, i.event_date, p2.brand, p2.gtin, p2.generic_name
     FROM inspections i JOIN products p2 ON p2.inspection_id = i.id
     WHERE ${w.sql} AND i.id != ? AND (
       (p2.gtin IS NOT NULL AND p2.gtin = ?) OR (p2.brand IS NOT NULL AND p2.brand = ? AND p2.generic_name = ?)
     ) ORDER BY i.event_date DESC LIMIT 10`,
  ).all(...w.params, inspectionId, p.gtin ?? '', p.brand ?? '', p.generic_name ?? '') as any[];
  return rows;
}

export function caseTimeline(db: DB, inspectionId: string) {
  const audit = db.prepare(
    `SELECT id, actor_label, action, object_type, object_id, outcome, created_at
     FROM audit_events WHERE (object_type = 'inspection' AND object_id = ?)
        OR object_id IN (SELECT id FROM evidence_assets WHERE inspection_id = ?)
        OR object_id IN (SELECT id FROM findings WHERE inspection_id = ?)
        OR object_id IN (SELECT id FROM notices WHERE inspection_id = ?)
     ORDER BY seq ASC`,
  ).all(inspectionId, inspectionId, inspectionId, inspectionId) as any[];
  const notices = db.prepare('SELECT * FROM notices WHERE inspection_id = ? ORDER BY created_at').all(inspectionId) as any[];
  const children = db.prepare('SELECT id, type, status, event_date FROM inspections WHERE parent_inspection_id = ?').all(inspectionId) as any[];
  return { audit, notices, linkedInspections: children };
}
