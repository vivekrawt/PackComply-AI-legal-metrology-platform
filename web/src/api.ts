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

export const OUTCOME_META: Record<string, { label: string; icon: string }> = {
  passed: { label: 'Compliant', icon: '✓' },
  failed: { label: 'Non-compliant', icon: '✕' },
  needs_review: { label: 'Needs Review', icon: '⚠' },
  not_applicable: { label: 'Not Applicable', icon: '—' },
  not_assessable: { label: 'Not Assessable', icon: '?' },
};
