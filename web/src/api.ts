// API client. Every mutation carries the CSRF header; errors are normalized.
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, form?: FormData): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: {
      'X-Requested-With': 'packcomply',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    credentials: 'same-origin',
  });
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    let payload: any = null;
    try { payload = ct.includes('json') ? await res.json() : await res.text(); } catch { /* ignore */ }
    const err = payload?.error;
    throw new ApiError(res.status, err?.code ?? 'ERROR', err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return ct.includes('json') ? res.json() : (res.blob() as Promise<T>);
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  postForm: <T>(path: string, form: FormData) => request<T>('POST', path, undefined, form),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
};

export type Role = 'user' | 'admin' | 'super_admin';

export interface User {
  id: string; email: string; name: string; role: Role;
  orgId: string; teamId: string | null;
  state: string | null; district: string | null; office: string | null;
}

// ---- Organization structure and performance ---------------------------------
export interface Team {
  id: string; orgId: string; name: string; description: string | null;
  status: 'active' | 'archived'; createdAt: string; updatedAt: string;
  adminCount?: number; auditorCount?: number;
}

export interface Person {
  id: string; email: string; name: string; role: Role; status: string;
}

// Workload and throughput for a person, a team or the whole organization.
// Counts, never a score: these describe how much work moved, not how well.
export interface ScanStats {
  total: number; analysed: number; inProgress: number; awaitingReview: number;
  accepted: number; rejected: number; sentBack: number;
  compliant: number; nonCompliant: number; needsReview: number;
  staleDecisions: number; lastActivityAt: string | null;
}

export interface DecisionStats {
  decisions: number; accepted: number; rejected: number; sentBack: number;
  lastDecisionAt: string | null;
}

export interface TeamRow {
  id: string; name: string; description: string | null; status: string;
  adminCount: number; auditorCount: number; stats: ScanStats;
}

export interface AuditorRow {
  id: string; name: string; email: string; status: string;
  teamId: string | null; teamName: string | null; createdAt: string; stats: ScanStats;
}

export interface AdminRow {
  id: string; name: string; email: string; status: string;
  teamId: string | null; teamName: string | null; teamSize: number;
  createdAt: string; queueAwaiting: number; decisions: DecisionStats;
}

export type AttentionReason = 'stale_decision' | 'no_active_admin' | 'awaiting_too_long';

export interface AttentionCase {
  scanId: string; reason: AttentionReason; detail: string; createdAt: string;
  teamId: string | null; teamName: string | null; officerName: string | null;
  product: string | null; verdict: VerdictOverall | null; decision: ReviewDecision | null;
}

export const ATTENTION_META: Record<AttentionReason, { label: string; tone: string }> = {
  stale_decision: { label: 'Decision superseded', tone: 'needs_review' },
  no_active_admin: { label: 'No admin to review it', tone: 'failed' },
  awaiting_too_long: { label: 'Waiting too long', tone: 'needs_review' },
};

export interface OrgOverview {
  scans: ScanStats;
  people: { admins: number; auditors: number; superAdmins: number; suspended: number };
  teams: { active: number; archived: number };
  byMonth: { month: string; total: number; decided: number }[];
  attention: number;
}

// Display metadata only. Authority lives in the server's role→permission matrix, which
// arrives with /auth/me; the UI never decides what a role may do.
export const ROLE_META: Record<Role, { label: string; short: string; hint: string }> = {
  user: {
    label: 'Auditor (field agent)', short: 'Auditor',
    hint: 'Does the auditing: open a case, capture the package, check the product, correct declarations.',
  },
  admin: {
    label: 'Admin (team reviewer)', short: 'Admin',
    hint: 'Reviews their own team’s work: sign off scans, dispose findings, approve overrides, finalize reports.',
  },
  super_admin: {
    label: 'Super administrator', short: 'Super admin',
    hint: 'Runs the system: teams, people, rules, configuration and deletion — everything except the auditing itself.',
  },
};

export const roleLabel = (role: string) => ROLE_META[role as Role]?.label ?? role;

// ---- Field-officer scan flow -----------------------------------------------
export type ScanStatus = 'capturing' | 'analyzing' | 'ready' | 'failed';
export type VerdictOverall = 'compliant' | 'non_compliant' | 'needs_review';

export interface ComplianceCheck {
  parameter: string; ruleReference: string;
  status: 'present' | 'missing' | 'unclear';
  observedText: string; issue: string; remedy: string;
}

export interface Verdict {
  id: string; provider: string; modelVersion: string; isMock: boolean;
  rulesSources: string[]; rulesSha256: string | null; ocrText: string;
  overall: VerdictOverall; summary: string; confidence: number | null;
  checks: ComplianceCheck[]; error: string | null; createdAt: string;
}

export interface ScanImage {
  id: string; side: string | null; name: string | null; sha256: string;
  sizeBytes: number | null; capturedAt: string | null; source: string | null;
}

// Per-image OCR boxes for the evidence viewer. `processed` distinguishes an image
// the recogniser read and found nothing on from one it never read - which are very
// different things to tell an officer.
export interface ScanOcrBlock {
  text: string; bbox: { x: number; y: number; w: number; h: number };
  readingOrder: number; script: string; lang: string; confidence: number;
}
export interface ScanOcrImage {
  assetId: string; side: string | null; mime: string; processed: boolean; blocks: ScanOcrBlock[];
}
export interface ScanOcr {
  images: ScanOcrImage[];
  readBy: { provider: string; modelVersion: string; isMock: boolean } | null;
}

// ---- Reviewer sign-off ------------------------------------------------------
// A decision is recorded against the verdict it was taken on. `stale` means the
// package has been re-analysed since, so the decision stands against a reading
// that is no longer the current one — never silently carried forward.
export type ReviewDecision = 'accepted' | 'rejected' | 'recapture_requested';

export interface ScanReview {
  id: string; decision: ReviewDecision; reason: string;
  reviewerId: string; reviewerName: string | null;
  // The authority the decision was taken under, as it stood at the time.
  // `final` means a super administrator decided it: no admin can replace it.
  reviewerRole: Role | null; final: boolean;
  verdictId: string | null; stale: boolean; createdAt: string;
}

export interface ScanReviewSummary {
  decision: ReviewDecision; reviewerName: string | null; createdAt: string; stale: boolean;
}

export const REVIEW_META: Record<ReviewDecision, {
  label: string; icon: string; tone: string; verb: string; blurb: string;
}> = {
  accepted: {
    label: 'Accepted', icon: '✓', tone: 'passed', verb: 'Accept',
    blurb: 'The assessment is sound and the evidence supports it.',
  },
  rejected: {
    label: 'Rejected', icon: '✕', tone: 'failed', verb: 'Reject',
    blurb: 'The assessment is not supported by the evidence captured.',
  },
  recapture_requested: {
    label: 'Sent back', icon: '↺', tone: 'needs_review', verb: 'Send back',
    blurb: 'The images cannot settle the question — the officer must re-photograph the package.',
  },
};

export interface Scan {
  scanId: string; status: ScanStatus; createdAt: string; eventDate: string;
  product: Record<string, any> | null; location: string | null; minImages: number;
  images: ScanImage[];
  progress: { total: number; done: number; pending: number; errors: string[] };
  verdict: Verdict | null;
  engineFindings: { ruleKey: string; title: string; outcome: string; severity: string | null; explanation: string; citation: string }[];
  ruleVersions: { ruleKey: string; version: number; citation: string; legalStatus: string }[];
  reportId: string | null;
  officer: { id: string; name: string; email: string } | null;
  team: { id: string; name: string } | null;
  review: ScanReview | null;
  reviews: ScanReview[];
}

export interface ScanSummary {
  scanId: string; status: string; eventDate: string; createdAt: string;
  location: string | null; brand: string | null; genericName: string | null; category: string | null;
  imageCount: number; verdict: VerdictOverall | null; verdictIsMock: boolean | null; reportId: string | null;
  officerName: string | null;
  teamId: string | null;
  teamName: string | null;
  review: ScanReviewSummary | null;
}

export interface ScanCapability {
  minImages: number; sides: string[]; extraSides: string[];
  judge: { provider: string; modelVersion: string; isMock: boolean };
  rules: { available: boolean; sources: string[]; sha256: string };
}

// Verdict presentation. Status is text + icon + colour together, never colour alone.
export const VERDICT_META: Record<VerdictOverall, { label: string; icon: string; tone: string; blurb: string }> = {
  compliant: {
    label: 'Compliance ready', icon: '✓', tone: 'passed',
    blurb: 'Every mandatory declaration assessed was found on the package.',
  },
  non_compliant: {
    label: 'Not compliance ready', icon: '✕', tone: 'failed',
    blurb: 'At least one mandatory declaration is missing or defective.',
  },
  needs_review: {
    label: 'Needs review', icon: '⚠', tone: 'needs_review',
    blurb: 'The captured images do not settle the question — more evidence is needed.',
  },
};

export const SIDE_LABELS: Record<string, string> = {
  top: 'Top', bottom: 'Bottom', left: 'Left', right: 'Right',
  front: 'Front', back: 'Back', closeup: 'Close-up', other: 'Other side',
};

export const OUTCOME_META: Record<string, { label: string; icon: string }> = {
  passed: { label: 'Compliant', icon: '✓' },
  failed: { label: 'Non-compliant', icon: '✕' },
  needs_review: { label: 'Needs Review', icon: '⚠' },
  not_applicable: { label: 'Not Applicable', icon: '—' },
  not_assessable: { label: 'Not Assessable', icon: '?' },
};
