import type { DB } from '../../db/index.js';
import { scopeWhere, type SessionUser } from '../auth/service.js';

// FTS5-backed repository search (REP-02). Results always pass the same scope
// filter as transactional queries (IAM-03, UAT-10).

export function refreshSearchIndexForInspection(db: DB, inspectionId: string) {
  const i = db.prepare('SELECT * FROM inspections WHERE id = ?').get(inspectionId) as any;
  if (!i) return;
  db.prepare("DELETE FROM search_index WHERE inspection_id = ?").run(inspectionId);
  const product = db.prepare('SELECT * FROM products WHERE inspection_id = ?').get(inspectionId) as any;
  const decls = db.prepare('SELECT * FROM declarations WHERE inspection_id = ?').all(inspectionId) as any[];
  const ocr = db.prepare(
    `SELECT o.text FROM ocr_blocks o JOIN evidence_assets a ON a.id = o.asset_id WHERE a.inspection_id = ?`,
  ).all(inspectionId) as any[];
  const seller = i.seller_entity_id
    ? (db.prepare('SELECT name FROM entities WHERE id = ?').get(i.seller_entity_id) as any)
    : null;

  const content = [
    i.id, i.type, i.location, seller?.name,
    product?.brand, product?.generic_name, product?.category, product?.gtin, product?.sku, product?.batch_lot,
    ...decls.map((d) => `${d.decl_type} ${d.verbatim_text}`),
    ...ocr.map((o) => o.text),
  ].filter(Boolean).join(' \n ');

  db.prepare(
    `INSERT INTO search_index (doc_id, doc_type, org_id, state, district, office, inspection_id, content)
     VALUES (?, 'inspection', ?, ?, ?, ?, ?, ?)`,
  ).run(i.id, i.org_id, i.state, i.district, i.office, i.id, content);
}

export function searchRepository(db: DB, user: SessionUser, q: string, limit = 25) {
  const started = Date.now();
  const safe = q.replace(/["'*^]/g, ' ').trim();
  if (!safe) return { results: [], tookMs: 0 };
  const match = safe.split(/\s+/).map((t) => `"${t}"`).join(' ');
  const rows = db.prepare(
    `SELECT s.doc_id, s.doc_type, s.inspection_id, snippet(search_index, 7, '[', ']', '…', 18) AS snippet
     FROM search_index s WHERE s.content MATCH ? LIMIT ?`,
  ).all(match, limit * 4) as any[];

  // Enforce scope on the hydrated records, not just index columns.
  const w = scopeWhere(user, 'i');
  const results: any[] = [];
  for (const r of rows) {
    const insp = db.prepare(
      `SELECT i.*, p.brand, p.generic_name, p.category, p.gtin
       FROM inspections i LEFT JOIN products p ON p.inspection_id = i.id
       WHERE i.id = ? AND ${w.sql}`,
    ).get(r.inspection_id, ...w.params) as any;
    if (!insp) continue;
    results.push({
      inspectionId: insp.id, type: insp.type, status: insp.status, eventDate: insp.event_date,
      brand: insp.brand, genericName: insp.generic_name, category: insp.category, gtin: insp.gtin,
      location: insp.location, snippet: r.snippet,
    });
    if (results.length >= limit) break;
  }
  return { results, tookMs: Date.now() - started };
}
