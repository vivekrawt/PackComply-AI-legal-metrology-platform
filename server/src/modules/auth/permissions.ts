// Role → permission matrix (IAM-02). Three roles, enforced server-side on every route.
//
//   user        — does the work: creates inspections, captures evidence, runs the
//                 checks on a product, corrects declarations. Cannot approve its own
//                 overrides, cannot delete anything.
//   admin       — reviews the work: read-only over casework plus the review verbs
//                 (disposition, second-level approval, finalization, notices, audit).
//                 Deliberately has no create/upload/edit/delete power, so "who did the
//                 work" and "who signed it off" stay separable (segregation of duties).
//   super_admin — full write AND delete: everything admin and user can do, plus rule
//                 authoring/publication, user & config administration, and the
//                 destructive verbs. The only role that can remove records.

export const ROLES = ['user', 'admin', 'super_admin'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  user: 'Auditor (field agent)',
  admin: 'Admin (team reviewer)',
  super_admin: 'Super administrator',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  user: 'Does the auditing: create a case, capture package images, run the compliance check, correct extracted declarations.',
  admin: 'Reviews their own team only: sign off scans, dispose findings, approve overrides, finalize reports, issue notices, read the audit log.',
  super_admin: 'Runs the system: teams, people, rules, configuration, retention and deletion — everything except performing the audit itself.',
};

export const PERMISSIONS = [
  'inspection.create',
  'inspection.read',
  'inspection.edit',
  'inspection.annotate',
  'inspection.assign',
  'inspection.reinspect',
  'inspection.delete',
  'evidence.upload',
  'evidence.read',
  'evidence.delete',
  'processing.run',
  'declaration.edit',
  'evaluation.run',
  'finding.disposition', // confirm/dismiss/defer
  'finding.override',
  'finding.approve_override', // second-level approval
  'scan.review', // reviewer sign-off on a field officer's scan
  'report.finalize',
  'report.read',
  'report.export',
  'report.amend',
  'notice.manage',
  'search.read',
  'analytics.view',
  'rule.read',
  'rule.draft',
  'rule.submit',
  'rule.approve',
  'rule.publish',
  'rule.rollback',
  'rule.test',
  'rule.delete',
  'team.read',   // see your own team and its members
  'team.manage', // create teams, rename them, move people between them
  'admin.users',
  'admin.users.delete',
  'admin.config',
  'models.read',
  'models.manage',
  'audit.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

// Every destructive verb in the system. Only super_admin holds these (DEL-01).
export const DESTRUCTIVE_PERMISSIONS: Permission[] = [
  'inspection.delete', 'evidence.delete', 'rule.delete', 'admin.users.delete',
];

const USER_PERMISSIONS: Permission[] = [
  'inspection.create', 'inspection.read', 'inspection.edit', 'inspection.annotate',
  'inspection.reinspect',
  'evidence.upload', 'evidence.read', 'processing.run',
  'declaration.edit', 'evaluation.run',
  'finding.disposition', 'finding.override',
  'report.finalize', // gated further by finalization policy config (PRD: "policy based")
  'report.read', 'report.export',
  'search.read', 'analytics.view', 'rule.read', 'models.read',
];

const ADMIN_PERMISSIONS: Permission[] = [
  // Review-only: read the casework, judge it, sign it off. No create/upload/delete.
  'inspection.read', 'inspection.annotate', 'inspection.assign', 'inspection.reinspect',
  'evidence.read',
  'finding.disposition', 'finding.override', 'finding.approve_override',
  'scan.review',
  'report.finalize', 'report.read', 'report.export', 'report.amend',
  'notice.manage',
  'search.read', 'analytics.view', 'rule.read', 'models.read', 'audit.read',
  'team.read',
];

// The work a super administrator does NOT do: the auditing itself.
//
// This is the one deliberate hole in "super_admin holds everything by
// construction". The hierarchy is super_admin → admin → auditor, and only the
// auditor captures evidence and runs the checks; an authority that can also
// manufacture the record it later signs off is not a separation of duties at all.
// Everything outside this list is still granted automatically, so a newly added
// permission is never accidentally left unassigned.
const CAPTURE_PERMISSIONS: Permission[] = [
  'inspection.create', 'inspection.edit', 'evidence.upload',
  'processing.run', 'declaration.edit', 'evaluation.run',
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  user: USER_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
  // Everything except the capture verbs — governance, administration and deletion
  // by construction, minus the auditing work itself.
  super_admin: PERMISSIONS.filter((p) => !CAPTURE_PERMISSIONS.includes(p)),
};

export function roleHas(role: Role, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(perm) ?? false;
}

export function isSuperAdmin(role: string): boolean {
  return role === 'super_admin';
}

// Legacy six-role model → three-role model (migration 003 and any stale session rows).
export const LEGACY_ROLE_MAP: Record<string, Role> = {
  inspector: 'user',
  reviewer: 'admin',
  auditor: 'admin',
  analyst: 'user',
  rule_admin: 'super_admin',
  sys_admin: 'super_admin',
};
