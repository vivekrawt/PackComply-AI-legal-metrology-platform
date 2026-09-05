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
  orgId: string; state: string | null; district: string | null; office: string | null;
}

// Display metadata only. Authority lives in the server's role→permission matrix, which
// arrives with /auth/me; the UI never decides what a role may do.
export const ROLE_META: Record<Role, { label: string; short: string; hint: string }> = {
  user: {
    label: 'User (field officer)', short: 'User',
    hint: 'Runs inspections: open a case, capture the package, check the product, correct declarations.',
  },
  admin: {
    label: 'Admin (reviewer)', short: 'Admin',
    hint: 'Reviews the work: dispose findings, approve overrides, finalize reports, issue notices, read the audit log.',
  },
  super_admin: {
    label: 'Super administrator', short: 'Super admin',
    hint: 'Full write and delete: rule publication, user and configuration administration, record deletion.',
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

export interface Scan {
  scanId: string; status: ScanStatus; createdAt: string; eventDate: string;
  product: Record<string, any> | null; location: string | null; minImages: number;
  images: ScanImage[];
  progress: { total: number; done: number; pending: number; errors: string[] };
  verdict: Verdict | null;
  engineFindings: { ruleKey: string; title: string; outcome: string; severity: string | null; explanation: string; citation: string }[];
  ruleVersions: { ruleKey: string; version: number; citation: string; legalStatus: string }[];
  reportId: string | null;
}

export interface ScanSummary {
  scanId: string; status: string; eventDate: string; createdAt: string;
  location: string | null; brand: string | null; genericName: string | null; category: string | null;
  imageCount: number; verdict: VerdictOverall | null; verdictIsMock: boolean | null; reportId: string | null;
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
