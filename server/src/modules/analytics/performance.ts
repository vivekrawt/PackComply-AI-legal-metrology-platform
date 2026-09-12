import type { DB } from '../../db/index.js';
import { notFound } from '../../core/errors.js';

// Performance aggregation for the super administrator's console.
//
// Everything here is computed from the same tables the casework itself lives in —
// there is no shadow counter that can drift from the records. Counts describe
// workload and throughput; none of them is a quality score for a person, and the
// console says so where it shows them.

// The standing decision and the current verdict for each scan. "Standing" is the
// newest decision, which is the one in force; older ones are history.
const SCAN_JOINS = `
  FROM inspections i
  LEFT JOIN scan_reviews sr ON sr.id = (
    SELECT s2.id FROM scan_reviews s2 WHERE s2.inspection_id = i.id
     ORDER BY s2.created_at DESC, s2.rowid DESC LIMIT 1)
  LEFT JOIN compliance_verdicts cv ON cv.id = (
    SELECT v2.id FROM compliance_verdicts v2 WHERE v2.inspection_id = i.id
     ORDER BY v2.created_at DESC, v2.rowid DESC LIMIT 1)`;

// A scan is only review work once it has been analysed — before that the auditor
// has not finished, and it belongs in their workload rather than an admin's queue.
const SCAN_STATS = `
  COUNT(*) AS total,
  COALESCE(SUM(cv.id IS NOT NULL), 0) AS analysed,
  COALESCE(SUM(cv.id IS NULL), 0) AS in_progress,
  COALESCE(SUM(cv.id IS NOT NULL AND sr.id IS NULL), 0) AS awaiting_review,
  COALESCE(SUM(sr.decision = 'accepted'), 0) AS accepted,
  COALESCE(SUM(sr.decision = 'rejected'), 0) AS rejected,
  COALESCE(SUM(sr.decision = 'recapture_requested'), 0) AS sent_back,
  COALESCE(SUM(sr.decision = 'escalated'), 0) AS escalated,
  COALESCE(SUM(cv.overall = 'compliant'), 0) AS compliant,
  COALESCE(SUM(cv.overall = 'non_compliant'), 0) AS non_compliant,
  COALESCE(SUM(cv.overall = 'needs_review'), 0) AS needs_review,
  COALESCE(SUM(sr.id IS NOT NULL AND cv.id IS NOT NULL AND sr.verdict_id <> cv.id), 0) AS stale_decisions,
  MAX(i.created_at) AS last_activity_at`;

function statsRowToDto(r: any) {
  return {
    total: r?.total ?? 0,
    analysed: r?.analysed ?? 0,
    inProgress: r?.in_progress ?? 0,
    awaitingReview: r?.awaiting_review ?? 0,
    accepted: r?.accepted ?? 0,
    rejected: r?.rejected ?? 0,
    sentBack: r?.sent_back ?? 0,
    escalated: r?.escalated ?? 0,
    compliant: r?.compliant ?? 0,
    nonCompliant: r?.non_compliant ?? 0,
    needsReview: r?.needs_review ?? 0,
    staleDecisions: r?.stale_decisions ?? 0,
    lastActivityAt: r?.last_activity_at ?? null,
  };
}

const EMPTY_STATS = statsRowToDto(null);

// ---- Organization overview (the super administrator's landing page) ----------
export function orgOverview(db: DB, orgId: string) {
  const scans = statsRowToDto(db.prepare(
    `SELECT ${SCAN_STATS} ${SCAN_JOINS} WHERE i.org_id = ? AND i.deleted_at IS NULL`,
  ).get(orgId));

  const people = db.prepare(
    `SELECT
       COALESCE(SUM(role = 'admin'), 0) AS admins,
       COALESCE(SUM(role = 'user'), 0) AS auditors,
       COALESCE(SUM(role = 'super_admin'), 0) AS super_admins,
       COALESCE(SUM(status = 'suspended'), 0) AS suspended
     FROM users WHERE org_id = ? AND status != 'offboarded'`,
  ).get(orgId) as any;

  const teams = db.prepare(
    `SELECT COALESCE(SUM(status = 'active'), 0) AS active,
            COALESCE(SUM(status = 'archived'), 0) AS archived
       FROM teams WHERE org_id = ?`,
  ).get(orgId) as any;

  // Throughput over the last 12 months, by the month the case was opened.
  const byMonth = db.prepare(
    `SELECT substr(i.created_at, 1, 7) AS month, COUNT(*) AS total,
            COALESCE(SUM(sr.id IS NOT NULL), 0) AS decided
       ${SCAN_JOINS}
      WHERE i.org_id = ? AND i.deleted_at IS NULL
      GROUP BY month ORDER BY month DESC LIMIT 12`,
  ).all(orgId) as any[];

  return {
    scans,
    people: {
      admins: people.admins, auditors: people.auditors,
      superAdmins: people.super_admins, suspended: people.suspended,
    },
    teams: { active: teams.active, archived: teams.archived },
    byMonth: byMonth.map((m) => ({ month: m.month, total: m.total, decided: m.decided })),
    attention: attentionCases(db, orgId).length,
  };
}

// ---- Cases referred up to the super administrator ---------------------------
// Exactly one thing lands here: a case an admin has explicitly referred upward
// because they judged it beyond their authority to settle. Nothing arrives by an
// inferred urgency rule, so this list is a queue of asks from named people rather
// than a pile the system decided was interesting.
export function attentionCases(db: DB, orgId: string) {
  const rows = db.prepare(
    `SELECT i.id, i.created_at, i.team_id, t.name AS team_name,
            p.brand, p.generic_name, ou.name AS officer_name,
            cv.overall AS verdict,
            sr.reason AS escalation_reason, sr.created_at AS escalated_at,
            ru.name AS escalated_by
       ${SCAN_JOINS}
       LEFT JOIN teams t ON t.id = i.team_id
       LEFT JOIN products p ON p.inspection_id = i.id
       LEFT JOIN users ou ON ou.id = i.created_by
       LEFT JOIN users ru ON ru.id = sr.reviewer_id
      WHERE i.org_id = ? AND i.deleted_at IS NULL AND sr.decision = 'escalated'
      ORDER BY sr.created_at ASC`,
  ).all(orgId) as any[];

  return rows.map((r) => ({
    scanId: r.id,
    createdAt: r.created_at,
    teamId: r.team_id, teamName: r.team_name ?? null,
    officerName: r.officer_name ?? null,
    product: r.brand || r.generic_name || null,
    verdict: r.verdict ?? null,
    escalatedBy: r.escalated_by ?? null,
    escalatedAt: r.escalated_at,
    escalationReason: r.escalation_reason,
  }));
}

// ---- Teams ------------------------------------------------------------------
export function teamPerformance(db: DB, orgId: string) {
  const teams = db.prepare(
    `SELECT t.id, t.name, t.description, t.status,
            (SELECT COUNT(*) FROM users u WHERE u.team_id = t.id AND u.role = 'admin'
               AND u.status != 'offboarded') AS admin_count,
            (SELECT COUNT(*) FROM users u WHERE u.team_id = t.id AND u.role = 'user'
               AND u.status != 'offboarded') AS auditor_count
       FROM teams t WHERE t.org_id = ? ORDER BY t.status, t.name`,
  ).all(orgId) as any[];

  const stats = db.prepare(
    `SELECT i.team_id, ${SCAN_STATS} ${SCAN_JOINS}
      WHERE i.org_id = ? AND i.deleted_at IS NULL GROUP BY i.team_id`,
  ).all(orgId) as any[];
  const byTeam = new Map(stats.map((s) => [s.team_id, statsRowToDto(s)]));

  return teams.map((t) => ({
    id: t.id, name: t.name, description: t.description ?? null, status: t.status,
    adminCount: t.admin_count, auditorCount: t.auditor_count,
    stats: byTeam.get(t.id) ?? EMPTY_STATS,
  }));
}

export function teamDetail(db: DB, orgId: string, teamId: string) {
  const team = db.prepare('SELECT * FROM teams WHERE id = ? AND org_id = ?')
    .get(teamId, orgId) as any;
  if (!team) throw notFound('Team not found');

  const stats = statsRowToDto(db.prepare(
    `SELECT ${SCAN_STATS} ${SCAN_JOINS}
      WHERE i.org_id = ? AND i.team_id = ? AND i.deleted_at IS NULL`,
  ).get(orgId, teamId));

  const members = db.prepare(
    `SELECT id, email, name, role, status, created_at FROM users
      WHERE team_id = ? AND org_id = ? AND status != 'offboarded' ORDER BY role, name`,
  ).all(teamId, orgId) as any[];

  return {
    team: {
      id: team.id, name: team.name, description: team.description ?? null,
      status: team.status, createdAt: team.created_at,
    },
    stats,
    admins: members.filter((m) => m.role === 'admin'),
    auditors: members.filter((m) => m.role === 'user'),
  };
}

// ---- Auditors (the people who do the work) ----------------------------------
export function auditorPerformance(db: DB, orgId: string) {
  const rows = db.prepare(
    `SELECT u.id, u.name, u.email, u.status, u.team_id, t.name AS team_name, u.created_at
       FROM users u LEFT JOIN teams t ON t.id = u.team_id
      WHERE u.org_id = ? AND u.role = 'user' AND u.status != 'offboarded'
      ORDER BY u.name`,
  ).all(orgId) as any[];

  const stats = db.prepare(
    `SELECT i.created_by, ${SCAN_STATS} ${SCAN_JOINS}
      WHERE i.org_id = ? AND i.deleted_at IS NULL GROUP BY i.created_by`,
  ).all(orgId) as any[];
  const byUser = new Map(stats.map((s) => [s.created_by, statsRowToDto(s)]));

  return rows.map((u) => ({
    id: u.id, name: u.name, email: u.email, status: u.status,
    teamId: u.team_id, teamName: u.team_name ?? null, createdAt: u.created_at,
    stats: byUser.get(u.id) ?? EMPTY_STATS,
  }));
}

// Calendar boundaries, not rolling windows: "this week" has to mean the week the
// reader is standing in, or a Monday morning would show a full week of someone
// else's work. Computed in UTC to match how every timestamp is stored.
function periodBounds() {
  const now = new Date();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const mondayOffset = (day.getUTCDay() + 6) % 7; // Monday = 0
  return {
    today: day.toISOString(),
    week: new Date(day.getTime() - mondayOffset * 86_400_000).toISOString(),
    month: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
  };
}

// What one auditor got through in a period. "Completed" is when the analysis
// finished, not when the case was opened — a scan captured last week and analysed
// today is today's work.
function auditorPeriod(db: DB, orgId: string, userId: string, since: string) {
  const captured = (db.prepare(
    `SELECT COUNT(*) AS c FROM inspections
      WHERE org_id = ? AND created_by = ? AND deleted_at IS NULL AND created_at >= ?`,
  ).get(orgId, userId, since) as any).c as number;

  const completed = (db.prepare(
    `SELECT COUNT(*) AS c FROM inspections i
      JOIN compliance_verdicts cv ON cv.id = (
        SELECT v2.id FROM compliance_verdicts v2 WHERE v2.inspection_id = i.id
         ORDER BY v2.created_at DESC, v2.rowid DESC LIMIT 1)
     WHERE i.org_id = ? AND i.created_by = ? AND i.deleted_at IS NULL AND cv.created_at >= ?`,
  ).get(orgId, userId, since) as any).c as number;

  const d = db.prepare(
    `SELECT COALESCE(SUM(sr.decision = 'accepted'), 0) AS accepted,
            COALESCE(SUM(sr.decision = 'rejected'), 0) AS rejected,
            COALESCE(SUM(sr.decision = 'recapture_requested'), 0) AS sent_back
       FROM scan_reviews sr JOIN inspections i ON i.id = sr.inspection_id
      WHERE i.org_id = ? AND i.created_by = ? AND i.deleted_at IS NULL AND sr.created_at >= ?`,
  ).get(orgId, userId, since) as any;

  return {
    captured, completed,
    accepted: d?.accepted ?? 0, rejected: d?.rejected ?? 0, sentBack: d?.sent_back ?? 0,
  };
}

export function auditorPeriods(db: DB, orgId: string, userId: string) {
  const b = periodBounds();
  return {
    today: auditorPeriod(db, orgId, userId, b.today),
    week: auditorPeriod(db, orgId, userId, b.week),
    month: auditorPeriod(db, orgId, userId, b.month),
  };
}

export function auditorDetail(db: DB, orgId: string, userId: string) {
  const u = db.prepare(
    `SELECT u.id, u.name, u.email, u.status, u.role, u.team_id, t.name AS team_name,
            u.state, u.district, u.office, u.created_at
       FROM users u LEFT JOIN teams t ON t.id = u.team_id
      WHERE u.id = ? AND u.org_id = ?`,
  ).get(userId, orgId) as any;
  if (!u) throw notFound('Auditor not found');

  const stats = statsRowToDto(db.prepare(
    `SELECT ${SCAN_STATS} ${SCAN_JOINS}
      WHERE i.org_id = ? AND i.created_by = ? AND i.deleted_at IS NULL`,
  ).get(orgId, userId));

  const recent = db.prepare(
    `SELECT i.id, i.created_at, p.brand, p.generic_name,
            cv.overall AS verdict, sr.decision
       ${SCAN_JOINS}
       LEFT JOIN products p ON p.inspection_id = i.id
      WHERE i.org_id = ? AND i.created_by = ? AND i.deleted_at IS NULL
      ORDER BY i.created_at DESC LIMIT 20`,
  ).all(orgId, userId) as any[];

  return {
    person: {
      id: u.id, name: u.name, email: u.email, status: u.status, role: u.role,
      teamId: u.team_id, teamName: u.team_name ?? null,
      scope: [u.state, u.district, u.office].filter(Boolean).join(' / ') || null,
      createdAt: u.created_at,
    },
    stats,
    periods: auditorPeriods(db, orgId, userId),
    recent: recent.map((r) => ({
      scanId: r.id, createdAt: r.created_at,
      product: r.brand || r.generic_name || null,
      verdict: r.verdict ?? null, decision: r.decision ?? null,
    })),
  };
}

// ---- Admins (the people who review the work) --------------------------------
// An admin's numbers are decisions taken, not scans captured — a different unit of
// work from an auditor's, and conflating the two would misrepresent both.
const DECISION_STATS = `
  COUNT(*) AS decisions,
  COALESCE(SUM(decision = 'accepted'), 0) AS accepted,
  COALESCE(SUM(decision = 'rejected'), 0) AS rejected,
  COALESCE(SUM(decision = 'recapture_requested'), 0) AS sent_back,
  MAX(created_at) AS last_decision_at`;

function decisionRowToDto(r: any) {
  return {
    decisions: r?.decisions ?? 0,
    accepted: r?.accepted ?? 0,
    rejected: r?.rejected ?? 0,
    sentBack: r?.sent_back ?? 0,
    lastDecisionAt: r?.last_decision_at ?? null,
  };
}

export function adminPerformance(db: DB, orgId: string) {
  const rows = db.prepare(
    `SELECT u.id, u.name, u.email, u.status, u.team_id, t.name AS team_name, u.created_at,
            (SELECT COUNT(*) FROM users m WHERE m.team_id = u.team_id AND m.role = 'user'
               AND m.status != 'offboarded') AS team_size
       FROM users u LEFT JOIN teams t ON t.id = u.team_id
      WHERE u.org_id = ? AND u.role = 'admin' AND u.status != 'offboarded'
      ORDER BY u.name`,
  ).all(orgId) as any[];

  const decisions = db.prepare(
    `SELECT reviewer_id, ${DECISION_STATS} FROM scan_reviews
      WHERE inspection_id IN (SELECT id FROM inspections WHERE org_id = ? AND deleted_at IS NULL)
      GROUP BY reviewer_id`,
  ).all(orgId) as any[];
  const byUser = new Map(decisions.map((d) => [d.reviewer_id, decisionRowToDto(d)]));

  // What is still waiting in each admin's own queue.
  const queues = db.prepare(
    `SELECT i.team_id, COALESCE(SUM(cv.id IS NOT NULL AND sr.id IS NULL), 0) AS awaiting
       ${SCAN_JOINS}
      WHERE i.org_id = ? AND i.deleted_at IS NULL GROUP BY i.team_id`,
  ).all(orgId) as any[];
  const byTeam = new Map(queues.map((q) => [q.team_id, q.awaiting as number]));

  return rows.map((u) => ({
    id: u.id, name: u.name, email: u.email, status: u.status,
    teamId: u.team_id, teamName: u.team_name ?? null, teamSize: u.team_size,
    createdAt: u.created_at,
    queueAwaiting: u.team_id ? (byTeam.get(u.team_id) ?? 0) : 0,
    decisions: byUser.get(u.id) ?? decisionRowToDto(null),
  }));
}

export function adminDetail(db: DB, orgId: string, userId: string) {
  const u = db.prepare(
    `SELECT u.id, u.name, u.email, u.status, u.role, u.team_id, t.name AS team_name, u.created_at
       FROM users u LEFT JOIN teams t ON t.id = u.team_id
      WHERE u.id = ? AND u.org_id = ?`,
  ).get(userId, orgId) as any;
  if (!u) throw notFound('Admin not found');

  const decisions = decisionRowToDto(db.prepare(
    `SELECT ${DECISION_STATS} FROM scan_reviews
      WHERE reviewer_id = ?
        AND inspection_id IN (SELECT id FROM inspections WHERE org_id = ? AND deleted_at IS NULL)`,
  ).get(userId, orgId));

  const teamStats = u.team_id
    ? statsRowToDto(db.prepare(
      `SELECT ${SCAN_STATS} ${SCAN_JOINS}
        WHERE i.org_id = ? AND i.team_id = ? AND i.deleted_at IS NULL`,
    ).get(orgId, u.team_id))
    : EMPTY_STATS;

  const team = u.team_id
    ? db.prepare(
      `SELECT id, email, name, role, status FROM users
        WHERE team_id = ? AND org_id = ? AND status != 'offboarded' ORDER BY role, name`,
    ).all(u.team_id, orgId) as any[]
    : [];

  const recent = db.prepare(
    `SELECT r.inspection_id, r.decision, r.reason, r.created_at, p.brand, p.generic_name
       FROM scan_reviews r
       LEFT JOIN products p ON p.inspection_id = r.inspection_id
      WHERE r.reviewer_id = ? ORDER BY r.created_at DESC LIMIT 20`,
  ).all(userId) as any[];

  return {
    person: {
      id: u.id, name: u.name, email: u.email, status: u.status, role: u.role,
      teamId: u.team_id, teamName: u.team_name ?? null, createdAt: u.created_at,
    },
    decisions,
    teamStats,
    teamMembers: team.filter((m) => m.role === 'user'),
    coAdmins: team.filter((m) => m.role === 'admin' && m.id !== userId),
    recent: recent.map((r) => ({
      scanId: r.inspection_id, decision: r.decision, reason: r.reason,
      createdAt: r.created_at, product: r.brand || r.generic_name || null,
    })),
  };
}
