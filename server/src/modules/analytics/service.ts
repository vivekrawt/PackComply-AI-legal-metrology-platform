import type { DB } from '../../db/index.js';
import { scopeWhere, type SessionUser } from '../auth/service.js';

// Dashboard aggregations (DASH-01..04). All queries are scope-filtered and
// reconcile with repository records (same tables, no shadow copies).
// Guardrail: these are resource-prioritization indicators, not proof of liability.

export function enforcementOverview(db: DB, user: SessionUser) {
  const w = scopeWhere(user, 'i');
  const byStatus = db.prepare(
    `SELECT i.status, COUNT(*) AS c FROM inspections i WHERE ${w.sql} GROUP BY i.status`,
  ).all(...w.params) as any[];
  const outcomes = db.prepare(
    `SELECT f.effective_outcome AS outcome, COUNT(*) AS c FROM findings f
     JOIN inspections i ON i.id = f.inspection_id WHERE ${w.sql} GROUP BY f.effective_outcome`,
  ).all(...w.params) as any[];
  const highSeverity = (db.prepare(
    `SELECT COUNT(*) AS c FROM findings f JOIN inspections i ON i.id = f.inspection_id
     WHERE ${w.sql} AND f.severity = 'high' AND f.effective_outcome = 'failed'`,
  ).get(...w.params) as any).c;
  const byMonth = db.prepare(
    `SELECT substr(i.event_date, 1, 7) AS month, COUNT(*) AS c FROM inspections i
     WHERE ${w.sql} GROUP BY month ORDER BY month DESC LIMIT 12`,
  ).all(...w.params) as any[];
  const byDistrict = db.prepare(
    `SELECT COALESCE(i.district, 'unspecified') AS district, COUNT(*) AS c FROM inspections i
     WHERE ${w.sql} GROUP BY i.district ORDER BY c DESC LIMIT 10`,
  ).all(...w.params) as any[];
  return { byStatus, outcomes, highSeverity, byMonth, byDistrict };
}

export function operationsDashboard(db: DB, user: SessionUser) {
  const w = scopeWhere(user, 'i');
  const today = new Date().toISOString().slice(0, 10);
  const assigned = db.prepare(
    `SELECT i.assigned_to, COUNT(*) AS c FROM inspections i
     WHERE ${w.sql} AND i.status NOT IN ('finalized','closed') GROUP BY i.assigned_to`,
  ).all(...w.params) as any[];
  const overdue = (db.prepare(
    `SELECT COUNT(*) AS c FROM inspections i WHERE ${w.sql} AND i.due_date < ? AND i.status NOT IN ('finalized','closed')`,
  ).get(...w.params, today) as any).c;
  const backlog = (db.prepare(
    `SELECT COUNT(*) AS c FROM inspections i WHERE ${w.sql} AND i.status = 'review'`,
  ).get(...w.params) as any).c;
  const jobStats = db.prepare(
    `SELECT status, COUNT(*) AS c FROM processing_jobs GROUP BY status`,
  ).all() as any[];
  return { assigned, overdue, backlog, jobStats };
}

export function violationIntelligence(db: DB, user: SessionUser) {
  const w = scopeWhere(user, 'i');
  const byRule = db.prepare(
    `SELECT f.rule_key, COUNT(*) AS c FROM findings f JOIN inspections i ON i.id = f.inspection_id
     WHERE ${w.sql} AND f.effective_outcome = 'failed' GROUP BY f.rule_key ORDER BY c DESC LIMIT 10`,
  ).all(...w.params) as any[];
  const byCategory = db.prepare(
    `SELECT COALESCE(p.category,'unspecified') AS category, COUNT(*) AS c FROM findings f
     JOIN inspections i ON i.id = f.inspection_id LEFT JOIN products p ON p.inspection_id = i.id
     WHERE ${w.sql} AND f.effective_outcome = 'failed' GROUP BY p.category ORDER BY c DESC LIMIT 10`,
  ).all(...w.params) as any[];
  const byBrand = db.prepare(
    `SELECT COALESCE(p.brand,'unspecified') AS brand, COUNT(*) AS c FROM findings f
     JOIN inspections i ON i.id = f.inspection_id LEFT JOIN products p ON p.inspection_id = i.id
     WHERE ${w.sql} AND f.effective_outcome = 'failed' GROUP BY p.brand ORDER BY c DESC LIMIT 10`,
  ).all(...w.params) as any[];
  // Repeat patterns: brands with failures across multiple inspections (explainable, not liability).
  const repeatBrands = db.prepare(
    `SELECT p.brand, COUNT(DISTINCT i.id) AS inspections FROM findings f
     JOIN inspections i ON i.id = f.inspection_id JOIN products p ON p.inspection_id = i.id
     WHERE ${w.sql} AND f.effective_outcome = 'failed' AND p.brand IS NOT NULL
     GROUP BY p.brand HAVING inspections > 1 ORDER BY inspections DESC LIMIT 10`,
  ).all(...w.params) as any[];
  return { byRule, byCategory, byBrand, repeatBrands };
}

export function modelQualityDashboard(db: DB, user: SessionUser) {
  void user;
  const ocrConfidence = db.prepare(
    `SELECT CASE WHEN confidence >= 0.9 THEN 'high' WHEN confidence >= 0.7 THEN 'medium' ELSE 'low' END AS band,
       COUNT(*) AS c FROM ocr_blocks GROUP BY band`,
  ).all() as any[];
  const byScript = db.prepare(
    `SELECT script, COUNT(*) AS c, ROUND(AVG(confidence), 3) AS avg_confidence FROM ocr_blocks GROUP BY script`,
  ).all() as any[];
  const corrections = (db.prepare('SELECT COUNT(*) AS c FROM declaration_corrections').get() as any).c;
  const declarations = (db.prepare('SELECT COUNT(*) AS c FROM declarations').get() as any).c;
  const overrides = (db.prepare(
    `SELECT COUNT(*) AS c FROM finding_dispositions WHERE action = 'override'`,
  ).get() as any).c;
  const recaptureRecommended = (db.prepare(
    `SELECT COUNT(*) AS c FROM quality_assessments WHERE json_extract(recapture_json, '$.recommended') = 1`,
  ).get() as any).c;
  const totalAssessments = (db.prepare('SELECT COUNT(*) AS c FROM quality_assessments').get() as any).c;
  const modelVersions = db.prepare('SELECT * FROM model_versions ORDER BY component').all() as any[];
  const mockInUse = modelVersions.some((m) => m.is_mock && m.status === 'deployed');
  return {
    ocrConfidence, byScript, corrections, declarations,
    correctionRate: declarations ? Math.round((corrections / declarations) * 1000) / 10 : 0,
    overrides, recaptureRecommended, totalAssessments,
    recaptureRate: totalAssessments ? Math.round((recaptureRecommended / totalAssessments) * 1000) / 10 : 0,
    modelVersions, mockInUse,
  };
}

export function ruleAdminDashboard(db: DB) {
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = db.prepare(
    `SELECT rule_key, version, title, effective_from FROM rule_versions
     WHERE status = 'published' AND effective_from > ? ORDER BY effective_from LIMIT 10`,
  ).all(today) as any[];
  const drafts = db.prepare(
    `SELECT rule_key, version, title, status FROM rule_versions WHERE status IN ('draft','submitted','approved') ORDER BY created_at DESC`,
  ).all() as any[];
  const requiresLegal = db.prepare(
    `SELECT rule_key, version, title FROM rule_versions WHERE status = 'published' AND legal_status = 'REQUIRES_LEGAL_APPROVAL'`,
  ).all() as any[];
  return { upcoming, drafts, requiresLegal };
}
