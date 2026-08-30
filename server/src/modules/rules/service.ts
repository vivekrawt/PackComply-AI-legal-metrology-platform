import type { DB } from '../../db/index.js';
import { now } from '../../db/index.js';
import { newId } from '../../core/ids.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { recordAudit } from '../audit/service.js';
import type { SessionUser } from '../auth/service.js';
import { evaluateRule, type EngineContext } from '../evaluation/engine.js';
import { ruleVersionRowToData } from '../evaluation/service.js';

// Rule governance (ADM-01, REG-01, IAM-06):
// draft → submitted → approved (independent approver) → published → retired.
// Published versions are immutable; rollback re-publishes a prior version as a
// new version pointing at its target. Historical evaluations stay pinned.

export function listRuleSets(db: DB) {
  return db.prepare('SELECT * FROM rule_sets ORDER BY layer, name').all() as any[];
}

export function listRuleVersions(db: DB, f: { ruleKey?: string; status?: string } = {}) {
  const clauses: string[] = ['1=1'];
  const params: unknown[] = [];
  if (f.ruleKey) { clauses.push('rv.rule_key = ?'); params.push(f.ruleKey); }
  if (f.status) { clauses.push('rv.status = ?'); params.push(f.status); }
  const rows = db.prepare(
    `SELECT rv.*, rs.name AS set_name, rs.layer, src.title AS source_title
     FROM rule_versions rv
     JOIN rule_sets rs ON rs.id = rv.rule_set_id
     LEFT JOIN rule_sources src ON src.id = rv.source_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY rv.rule_key, rv.version DESC`,
  ).all(...params) as any[];
  return rows.map(ruleVersionDto);
}

export function ruleVersionDto(rv: any) {
  return {
    id: rv.id, ruleSetId: rv.rule_set_id, setName: rv.set_name, layer: rv.layer,
    ruleKey: rv.rule_key, version: rv.version, title: rv.title, status: rv.status,
    sourceId: rv.source_id, sourceTitle: rv.source_title, citation: rv.citation,
    jurisdiction: rv.jurisdiction, effectiveFrom: rv.effective_from, effectiveTo: rv.effective_to,
    applicability: JSON.parse(rv.applicability_json), inputs: JSON.parse(rv.inputs_json),
    logic: JSON.parse(rv.logic_json), outcome: JSON.parse(rv.outcome_json),
    legalStatus: rv.legal_status, authorId: rv.author_id, approverId: rv.approver_id,
    publishedAt: rv.published_at, retiredAt: rv.retired_at, rollbackOf: rv.rollback_of,
    changeNote: rv.change_note, createdAt: rv.created_at,
  };
}

export interface DraftRuleInput {
  ruleSetId: string; ruleKey: string; title: string; citation: string; sourceId?: string;
  jurisdiction?: string; effectiveFrom: string; effectiveTo?: string;
  applicability: unknown; inputs: unknown; logic: unknown; outcome: unknown;
  legalStatus?: string; changeNote?: string;
}

export function createDraft(db: DB, user: SessionUser, input: DraftRuleInput): any {
  const set = db.prepare('SELECT id FROM rule_sets WHERE id = ?').get(input.ruleSetId);
  if (!set) throw notFound('Rule set not found');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) throw badRequest('effectiveFrom must be YYYY-MM-DD');
  const logic: any = input.logic;
  if (!logic || !Array.isArray(logic.checks) || logic.checks.length === 0) {
    throw badRequest('Rule logic must contain at least one check');
  }
  const maxV = (db.prepare('SELECT MAX(version) AS v FROM rule_versions WHERE rule_key = ?').get(input.ruleKey) as any)?.v ?? 0;
  const id = newId('rv');
  db.prepare(
    `INSERT INTO rule_versions (id, rule_set_id, rule_key, version, title, status, source_id, citation,
       jurisdiction, effective_from, effective_to, applicability_json, inputs_json, logic_json, outcome_json,
       legal_status, author_id, change_note, created_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.ruleSetId, input.ruleKey, maxV + 1, input.title, input.sourceId ?? null, input.citation,
    input.jurisdiction ?? 'IN', input.effectiveFrom, input.effectiveTo ?? null,
    JSON.stringify(input.applicability ?? {}), JSON.stringify(input.inputs ?? {}),
    JSON.stringify(input.logic), JSON.stringify(input.outcome ?? {}),
    input.legalStatus ?? 'REQUIRES_LEGAL_APPROVAL', user.id, input.changeNote ?? null, now(),
  );
  recordAudit(db, {
    actorId: user.id, actorLabel: user.email, action: 'rule.draft_created',
    objectType: 'rule_version', objectId: id, after: { ruleKey: input.ruleKey, version: maxV + 1 },
  });
  return getRuleVersion(db, id);
}

export function getRuleVersion(db: DB, id: string) {
  const rv = db.prepare(
    `SELECT rv.*, rs.name AS set_name, rs.layer, src.title AS source_title
     FROM rule_versions rv JOIN rule_sets rs ON rs.id = rv.rule_set_id
     LEFT JOIN rule_sources src ON src.id = rv.source_id WHERE rv.id = ?`,
  ).get(id) as any;
  if (!rv) throw notFound('Rule version not found');
  return ruleVersionDto(rv);
}

export function updateDraft(db: DB, user: SessionUser, id: string, patch: Partial<DraftRuleInput>) {
  const rv = db.prepare('SELECT * FROM rule_versions WHERE id = ?').get(id) as any;
  if (!rv) throw notFound('Rule version not found');
  if (rv.status !== 'draft') throw conflict('Only draft versions can be edited; create a new version instead');
  db.prepare(
    `UPDATE rule_versions SET title = COALESCE(?, title), citation = COALESCE(?, citation),
       effective_from = COALESCE(?, effective_from), effective_to = COALESCE(?, effective_to),
       applicability_json = COALESCE(?, applicability_json), inputs_json = COALESCE(?, inputs_json),
       logic_json = COALESCE(?, logic_json), outcome_json = COALESCE(?, outcome_json),
       legal_status = COALESCE(?, legal_status), change_note = COALESCE(?, change_note)
     WHERE id = ?`,
  ).run(
    patch.title ?? null, patch.citation ?? null, patch.effectiveFrom ?? null, patch.effectiveTo ?? null,
    patch.applicability ? JSON.stringify(patch.applicability) : null,
    patch.inputs ? JSON.stringify(patch.inputs) : null,
    patch.logic ? JSON.stringify(patch.logic) : null,
    patch.outcome ? JSON.stringify(patch.outcome) : null,
    patch.legalStatus ?? null, patch.changeNote ?? null, id,
  );
  recordAudit(db, {
    actorId: user.id, actorLabel: user.email, action: 'rule.draft_updated',
    objectType: 'rule_version', objectId: id, after: patch,
  });
  return getRuleVersion(db, id);
}

export function submitVersion(db: DB, user: SessionUser, id: string) {
  const rv = db.prepare('SELECT * FROM rule_versions WHERE id = ?').get(id) as any;
  if (!rv) throw notFound('Rule version not found');
  if (rv.status !== 'draft') throw conflict('Only draft versions can be submitted');
  db.prepare("UPDATE rule_versions SET status = 'submitted', submitted_at = ? WHERE id = ?").run(now(), id);
  recordAudit(db, { actorId: user.id, actorLabel: user.email, action: 'rule.submitted', objectType: 'rule_version', objectId: id });
  return getRuleVersion(db, id);
}

// IAM-06: the approver must be a different actor than the author (maker-checker).
export function approveVersion(db: DB, user: SessionUser, id: string) {
  const rv = db.prepare('SELECT * FROM rule_versions WHERE id = ?').get(id) as any;
  if (!rv) throw notFound('Rule version not found');
  if (rv.status !== 'submitted') throw conflict('Only submitted versions can be approved');
  if (rv.author_id === user.id) throw forbidden('Segregation of duties: the author cannot approve their own rule version');
  db.prepare("UPDATE rule_versions SET status = 'approved', approver_id = ?, approved_at = ? WHERE id = ?")
    .run(user.id, now(), id);
  recordAudit(db, { actorId: user.id, actorLabel: user.email, action: 'rule.approved', objectType: 'rule_version', objectId: id });
  return getRuleVersion(db, id);
}

export function publishVersion(db: DB, user: SessionUser, id: string) {
  const rv = db.prepare('SELECT * FROM rule_versions WHERE id = ?').get(id) as any;
  if (!rv) throw notFound('Rule version not found');
  if (rv.status !== 'approved') throw conflict('Only approved versions can be published');
  if (rv.author_id === user.id && !rv.approver_id) throw forbidden('Segregation of duties violation');
  const failing = runTestPack(db, rv.rule_key, id).results.filter((r) => !r.pass);
  if (failing.length > 0) {
    throw conflict(`Cannot publish: ${failing.length} regression test(s) fail (${failing.map((f) => f.name).join(', ')})`);
  }
  db.prepare("UPDATE rule_versions SET status = 'published', published_at = ? WHERE id = ?").run(now(), id);
  recordAudit(db, { actorId: user.id, actorLabel: user.email, action: 'rule.published', objectType: 'rule_version', objectId: id });
  return getRuleVersion(db, id);
}

export function retireVersion(db: DB, user: SessionUser, id: string) {
  const rv = db.prepare('SELECT * FROM rule_versions WHERE id = ?').get(id) as any;
  if (!rv) throw notFound('Rule version not found');
  if (rv.status !== 'published') throw conflict('Only published versions can be retired');
  db.prepare("UPDATE rule_versions SET status = 'retired', retired_at = ? WHERE id = ?").run(now(), id);
  recordAudit(db, { actorId: user.id, actorLabel: user.email, action: 'rule.retired', objectType: 'rule_version', objectId: id });
  return getRuleVersion(db, id);
}

// Rollback: retire the current published version and re-publish the target's
// content as a NEW version (history is preserved; nothing is rewritten).
export function rollbackToVersion(db: DB, user: SessionUser, targetVersionId: string) {
  const target = db.prepare('SELECT * FROM rule_versions WHERE id = ?').get(targetVersionId) as any;
  if (!target) throw notFound('Target rule version not found');
  const current = db.prepare(
    "SELECT * FROM rule_versions WHERE rule_key = ? AND status = 'published' ORDER BY version DESC LIMIT 1",
  ).get(target.rule_key) as any;
  const t = now();
  if (current) db.prepare("UPDATE rule_versions SET status = 'retired', retired_at = ? WHERE id = ?").run(t, current.id);
  const maxV = (db.prepare('SELECT MAX(version) AS v FROM rule_versions WHERE rule_key = ?').get(target.rule_key) as any).v;
  const id = newId('rv');
  db.prepare(
    `INSERT INTO rule_versions (id, rule_set_id, rule_key, version, title, status, source_id, citation,
       jurisdiction, effective_from, effective_to, applicability_json, inputs_json, logic_json, outcome_json,
       legal_status, author_id, approver_id, published_at, rollback_of, change_note, created_at)
     VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, target.rule_set_id, target.rule_key, maxV + 1, target.title, target.source_id, target.citation,
    target.jurisdiction, target.effective_from, target.effective_to, target.applicability_json,
    target.inputs_json, target.logic_json, target.outcome_json, target.legal_status,
    target.author_id, user.id, t, targetVersionId,
    `Rollback to ${target.rule_key} v${target.version}`, t,
  );
  recordAudit(db, {
    actorId: user.id, actorLabel: user.email, action: 'rule.rollback',
    objectType: 'rule_version', objectId: id,
    before: { retired: current?.id }, after: { rollbackOf: targetVersionId, newVersion: maxV + 1 },
  });
  return getRuleVersion(db, id);
}

// Regression test pack (REG-15): fixtures stored per rule_key, runnable against any version.
export function runTestPack(db: DB, ruleKey: string, ruleVersionId: string) {
  const rv = db.prepare('SELECT * FROM rule_versions WHERE id = ?').get(ruleVersionId) as any;
  if (!rv) throw notFound('Rule version not found');
  const rule = ruleVersionRowToData(rv);
  const tests = db.prepare('SELECT * FROM rule_tests WHERE rule_key = ?').all(ruleKey) as any[];
  const results = tests.map((t) => {
    const fixture = JSON.parse(t.fixture_json) as EngineContext;
    const res = evaluateRule(rule, fixture);
    return {
      testId: t.id, name: t.name, expected: t.expected_outcome, actual: res.outcome,
      pass: res.outcome === t.expected_outcome, explanation: res.explanation,
    };
  });
  return { ruleKey, ruleVersionId, total: results.length, passed: results.filter((r) => r.pass).length, results };
}

// Version comparison / simulation: same test pack under two versions, diff outcomes.
export function compareVersions(db: DB, ruleKey: string, versionIdA: string, versionIdB: string) {
  const a = runTestPack(db, ruleKey, versionIdA);
  const b = runTestPack(db, ruleKey, versionIdB);
  const diffs = a.results
    .map((ra) => {
      const rb = b.results.find((x) => x.testId === ra.testId);
      return rb && rb.actual !== ra.actual ? { name: ra.name, versionA: ra.actual, versionB: rb.actual } : null;
    })
    .filter(Boolean);
  return { ruleKey, versionA: versionIdA, versionB: versionIdB, diffs, aSummary: { passed: a.passed, total: a.total }, bSummary: { passed: b.passed, total: b.total } };
}

export function addRuleTest(db: DB, user: SessionUser, input: { ruleKey: string; name: string; fixture: unknown; expectedOutcome: string }) {
  const id = newId('rt');
  db.prepare('INSERT INTO rule_tests (id, rule_key, name, fixture_json, expected_outcome, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, input.ruleKey, input.name, JSON.stringify(input.fixture), input.expectedOutcome, now());
  recordAudit(db, { actorId: user.id, actorLabel: user.email, action: 'rule.test_added', objectType: 'rule_test', objectId: id });
  return id;
}

export function listRuleSources(db: DB) {
  return db.prepare('SELECT * FROM rule_sources ORDER BY publication_date DESC').all() as any[];
}
