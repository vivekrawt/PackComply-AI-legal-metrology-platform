import type { DB } from '../../db/index.js';
import { now } from '../../db/index.js';
import { recordAudit } from '../audit/service.js';
import type { SessionUser } from '../auth/service.js';

// Versioned key/value configuration (NFR-MAINT-01): checklists, finalization
// policy, units, severity policy, retention, crawl policy — editable without redeploy.

export function getConfigItem<T>(db: DB, key: string): T | null {
  const row = db.prepare('SELECT value_json FROM config_items WHERE key = ?').get(key) as any;
  return row ? (JSON.parse(row.value_json) as T) : null;
}

export function setConfigItem(db: DB, key: string, value: unknown, user?: SessionUser) {
  const before = getConfigItem(db, key);
  db.prepare(
    `INSERT INTO config_items (key, value_json, version, updated_by, updated_at) VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, version = version + 1,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), user?.id ?? null, now());
  if (user) {
    recordAudit(db, {
      actorId: user.id, actorLabel: user.email, action: 'config.update',
      objectType: 'config_item', objectId: key, before, after: value,
    });
  }
}

export interface FinalizationPolicy {
  userCanFinalize: boolean;               // PRD: "policy based" — open decision, configurable
  secondApprovalSeverities: string[];     // overrides at these severities need independent approval
}

export function getFinalizationPolicy(db: DB): FinalizationPolicy {
  const stored = getConfigItem<Partial<FinalizationPolicy> & { inspectorCanFinalize?: boolean }>(
    db, 'finalization_policy',
  );
  return {
    // DOCUMENTED ASSUMPTION — see docs/ASSUMPTIONS.md (reversible config). Set this
    // false to force every report through an `admin` reviewer before it is signed.
    // `inspectorCanFinalize` is the pre-three-role key name, still honoured on read.
    userCanFinalize: stored?.userCanFinalize ?? stored?.inspectorCanFinalize ?? true,
    secondApprovalSeverities: stored?.secondApprovalSeverities ?? ['high'],
  };
}
