import type { DB } from '../../db/index.js';
import { now } from '../../db/index.js';
import { newId } from '../../core/ids.js';
import { canonicalJson, sha256Hex } from '../../core/crypto.js';

// Append-only, hash-chained audit trail (IAM-07, NFR-AUD-01).
// There is deliberately no update or delete function in this module.

export interface AuditInput {
  actorId?: string | null;
  actorLabel: string; // user email or 'system'
  action: string;
  objectType?: string;
  objectId?: string;
  before?: unknown;
  after?: unknown;
  outcome?: 'success' | 'denied' | 'failure';
  sourceIp?: string;
  correlationId?: string;
}

export function recordAudit(db: DB, e: AuditInput): string {
  const id = newId('aud');
  const createdAt = now();
  const prev = db
    .prepare('SELECT event_hash FROM audit_events ORDER BY seq DESC LIMIT 1')
    .get() as { event_hash: string } | undefined;
  const prevHash = prev?.event_hash ?? 'genesis';
  const payload = {
    id,
    actorId: e.actorId ?? null,
    actorLabel: e.actorLabel,
    action: e.action,
    objectType: e.objectType ?? null,
    objectId: e.objectId ?? null,
    before: e.before ?? null,
    after: e.after ?? null,
    outcome: e.outcome ?? 'success',
    sourceIp: e.sourceIp ?? null,
    correlationId: e.correlationId ?? null,
    createdAt,
  };
  const eventHash = sha256Hex(prevHash + canonicalJson(payload));
  db.prepare(
    `INSERT INTO audit_events (id, actor_id, actor_label, action, object_type, object_id,
      before_json, after_json, outcome, source_ip, correlation_id, created_at, prev_hash, event_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, payload.actorId, payload.actorLabel, payload.action, payload.objectType, payload.objectId,
    payload.before === null ? null : JSON.stringify(payload.before),
    payload.after === null ? null : JSON.stringify(payload.after),
    payload.outcome, payload.sourceIp, payload.correlationId, createdAt, prevHash, eventHash,
  );
  return id;
}

// Recompute the chain to detect tampering (UAT-12 support for audit records).
export function verifyAuditChain(db: DB): { ok: boolean; brokenAtSeq?: number } {
  const rows = db.prepare('SELECT * FROM audit_events ORDER BY seq ASC').all() as any[];
  let prevHash = 'genesis';
  for (const r of rows) {
    const payload = {
      id: r.id,
      actorId: r.actor_id,
      actorLabel: r.actor_label,
      action: r.action,
      objectType: r.object_type,
      objectId: r.object_id,
      before: r.before_json ? JSON.parse(r.before_json) : null,
      after: r.after_json ? JSON.parse(r.after_json) : null,
      outcome: r.outcome,
      sourceIp: r.source_ip,
      correlationId: r.correlation_id,
      createdAt: r.created_at,
    };
    const expected = sha256Hex(prevHash + canonicalJson(payload));
    if (expected !== r.event_hash || r.prev_hash !== prevHash) return { ok: false, brokenAtSeq: r.seq };
    prevHash = r.event_hash;
  }
  return { ok: true };
}
