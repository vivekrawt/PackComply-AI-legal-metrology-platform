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
};

export interface User {
  id: string; email: string; name: string; role: string;
  orgId: string; state: string | null; district: string | null; office: string | null;
}

export const OUTCOME_META: Record<string, { label: string; icon: string }> = {
  passed: { label: 'Compliant', icon: '✓' },
  failed: { label: 'Non-compliant', icon: '✕' },
  needs_review: { label: 'Needs Review', icon: '⚠' },
  not_applicable: { label: 'Not Applicable', icon: '—' },
  not_assessable: { label: 'Not Assessable', icon: '?' },
};
