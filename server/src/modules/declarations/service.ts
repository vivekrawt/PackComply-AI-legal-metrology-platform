import type { DB } from '../../db/index.js';
import { now } from '../../db/index.js';
import { newId } from '../../core/ids.js';
import { badRequest, notFound } from '../../core/errors.js';
import { recordAudit } from '../audit/service.js';
import type { SessionUser } from '../auth/service.js';
import { assertMutableInspection } from '../evidence/service.js';
import { normalizeDeclaration } from './normalize.js';

export function listDeclarations(db: DB, inspectionId: string) {
  const rows = db.prepare('SELECT * FROM declarations WHERE inspection_id = ? ORDER BY decl_type').all(inspectionId) as any[];
  return rows.map(declRowToDto);
}

export function declRowToDto(d: any) {
  return {
    id: d.id, inspectionId: d.inspection_id, declType: d.decl_type,
    verbatimText: d.verbatim_text,
    normalized: d.normalized_json ? JSON.parse(d.normalized_json) : null,
    unit: d.unit, lang: d.lang, script: d.script, confidence: d.confidence,
    needsReview: !!d.needs_review, reviewReasons: JSON.parse(d.review_reasons_json || '[]'),
    evidenceRegions: JSON.parse(d.evidence_regions_json || '[]'),
    presentationMode: d.presentation_mode, sourceChannel: d.source_channel,
    provider: d.provider, modelVersion: d.model_version, isMock: !!d.is_mock,
    version: d.version, createdAt: d.created_at, updatedAt: d.updated_at,
  };
}

// EXT-06: officer corrections with full before/after trail.
const CORRECTABLE = ['verbatim_text', 'decl_type', 'normalized_value', 'lang', 'bbox', 'grouping'] as const;

export function correctDeclaration(
  db: DB, user: SessionUser, declarationId: string,
  patch: { field: string; newValue: unknown; reason: string },
  correlationId?: string,
) {
  const d = db.prepare('SELECT * FROM declarations WHERE id = ?').get(declarationId) as any;
  if (!d) throw notFound('Declaration not found');
  assertMutableInspection(db, d.inspection_id);
  if (!CORRECTABLE.includes(patch.field as any)) throw badRequest(`Field '${patch.field}' is not correctable`);
  if (!patch.reason?.trim()) throw badRequest('A correction requires a reason');
  const t = now();

  let original: unknown;
  switch (patch.field) {
    case 'verbatim_text': {
      original = d.verbatim_text;
      const newText = String(patch.newValue);
      const normalized = normalizeDeclaration(d.decl_type, newText);
      db.prepare(
        `UPDATE declarations SET verbatim_text = ?, normalized_json = ?, unit = ?,
           needs_review = ?, review_reasons_json = ?, version = version + 1, updated_at = ? WHERE id = ?`,
      ).run(newText, JSON.stringify(normalized), normalized.unit ?? null,
        normalized.ambiguous ? 1 : 0, JSON.stringify(normalized.ambiguous ? ['AMBIGUOUS_PARSE'] : []), t, declarationId);
      break;
    }
    case 'decl_type': {
      original = d.decl_type;
      const newType = String(patch.newValue);
      const normalized = normalizeDeclaration(newType, d.verbatim_text);
      db.prepare(
        `UPDATE declarations SET decl_type = ?, normalized_json = ?, unit = ?, version = version + 1, updated_at = ? WHERE id = ?`,
      ).run(newType, JSON.stringify(normalized), normalized.unit ?? null, t, declarationId);
      break;
    }
    case 'normalized_value': {
      original = d.normalized_json;
      const prev = d.normalized_json ? JSON.parse(d.normalized_json) : {};
      db.prepare(
        `UPDATE declarations SET normalized_json = ?, needs_review = 0, review_reasons_json = '[]',
           version = version + 1, updated_at = ? WHERE id = ?`,
      ).run(JSON.stringify({ ...prev, value: patch.newValue, ambiguous: false, officerSet: true }), t, declarationId);
      break;
    }
    case 'lang': {
      original = d.lang;
      db.prepare('UPDATE declarations SET lang = ?, version = version + 1, updated_at = ? WHERE id = ?')
        .run(String(patch.newValue), t, declarationId);
      break;
    }
    case 'bbox':
    case 'grouping': {
      original = d.evidence_regions_json;
      db.prepare('UPDATE declarations SET evidence_regions_json = ?, version = version + 1, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(patch.newValue), t, declarationId);
      break;
    }
  }

  db.prepare(
    `INSERT INTO declaration_corrections (id, declaration_id, field, original_value, new_value, actor_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId('cor'), declarationId, patch.field,
    typeof original === 'string' ? original : JSON.stringify(original ?? null),
    typeof patch.newValue === 'string' ? patch.newValue : JSON.stringify(patch.newValue),
    user.id, patch.reason, t);

  recordAudit(db, {
    actorId: user.id, actorLabel: user.email, action: 'declaration.corrected',
    objectType: 'declaration', objectId: declarationId,
    before: { field: patch.field, value: original }, after: { value: patch.newValue, reason: patch.reason },
    correlationId,
  });
  return declRowToDto(db.prepare('SELECT * FROM declarations WHERE id = ?').get(declarationId));
}

export function listCorrections(db: DB, declarationId: string) {
  return db.prepare(
    'SELECT * FROM declaration_corrections WHERE declaration_id = ? ORDER BY created_at',
  ).all(declarationId) as any[];
}
