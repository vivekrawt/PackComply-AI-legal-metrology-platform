// Role → permission matrix, mirroring PRD §04 role capability table.
// Seeded into role_permissions and enforced server-side on every route (IAM-02).

export const ROLES = ['inspector', 'reviewer', 'rule_admin', 'analyst', 'sys_admin', 'auditor'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'inspection.create',
  'inspection.read',
  'inspection.edit',
  'inspection.assign',
  'evidence.upload',
  'evidence.read',
  'processing.run',
  'declaration.edit',
  'evaluation.run',
  'finding.disposition', // confirm/dismiss/defer
  'finding.override',
  'finding.approve_override', // second-level approval
  'report.finalize',
  'report.read',
  'report.export',
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
  'admin.users',
  'admin.config',
  'models.read',
  'models.manage',
  'audit.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  inspector: [
    'inspection.create', 'inspection.read', 'inspection.edit',
    'evidence.upload', 'evidence.read', 'processing.run',
    'declaration.edit', 'evaluation.run',
    'finding.disposition', 'finding.override',
    'report.finalize', // gated further by finalization policy config (PRD: "policy based")
    'report.read', 'report.export',
    'search.read', 'analytics.view', 'rule.read', 'models.read',
  ],
  reviewer: [
    'inspection.create', 'inspection.read', 'inspection.edit', 'inspection.assign',
    'evidence.upload', 'evidence.read', 'processing.run',
    'declaration.edit', 'evaluation.run',
    'finding.disposition', 'finding.override', 'finding.approve_override',
    'report.finalize', 'report.read', 'report.export',
    'notice.manage', 'search.read', 'analytics.view', 'rule.read', 'models.read', 'audit.read',
  ],
  rule_admin: [
    'rule.read', 'rule.draft', 'rule.submit', 'rule.approve', 'rule.publish', 'rule.rollback', 'rule.test',
    'search.read', 'analytics.view', 'models.read', 'audit.read',
    'inspection.read', 'report.read',
  ],
  analyst: [
    'inspection.read', 'report.read', 'evidence.read',
    'search.read', 'analytics.view', 'rule.read', 'models.read',
  ],
  sys_admin: [
    'admin.users', 'admin.config', 'models.read', 'models.manage',
    'analytics.view', 'rule.read', 'audit.read', 'search.read',
    // NOTE (IAM-06): sys_admin intentionally has no permission that can alter
    // inspections, declarations, findings or reports.
  ],
  auditor: [
    'inspection.read', 'evidence.read', 'report.read', 'report.export',
    'search.read', 'analytics.view', 'rule.read', 'models.read', 'audit.read',
  ],
};

export function roleHas(role: Role, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(perm) ?? false;
}
