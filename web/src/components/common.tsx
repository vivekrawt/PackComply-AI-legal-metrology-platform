import React from 'react';
import { OUTCOME_META } from '../api';

// Status = text + icon + colour together (never colour alone).
export function OutcomeChip({ outcome }: { outcome: string }) {
  const m = OUTCOME_META[outcome] ?? { label: outcome, icon: '·' };
  return (
    <span className={`chip ${outcome}`} role="status">
      <span className="ico" aria-hidden="true">{m.icon}</span>
      {m.label}
    </span>
  );
}

export function SeverityChip({ severity }: { severity: string | null }) {
  if (!severity) return null;
  return <span className={`chip severity-${severity}`}>severity: {severity}</span>;
}

export function Confidence({ value }: { value: number | null | undefined }) {
  if (value == null) return null;
  return (
    <span className="confidence" title="Model confidence is assistive only — never a legal compliance score.">
      {(value * 100).toFixed(0)}%
    </span>
  );
}

export function LegalFlag({ status }: { status?: string }) {
  if (status !== 'REQUIRES_LEGAL_APPROVAL') return null;
  return <span className="legal-flag" title="Rule parameters are placeholders pending legal certification">REQUIRES LEGAL APPROVAL</span>;
}

export function MockBadge({ isMock }: { isMock?: boolean }) {
  if (!isMock) return null;
  return <span className="chip neutral" title="Deterministic demo provider — not production AI"><span className="ico" aria-hidden="true">◌</span>MOCK</span>;
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  const details = (error as any)?.details;
  return (
    <div className="error-text" role="alert">
      {msg}
      {Array.isArray(details) && (
        <ul>{details.map((d: any, i: number) => <li key={i}>{typeof d === 'string' ? d : `${d.path ?? ''} ${d.message ?? JSON.stringify(d)}`}</li>)}</ul>
      )}
    </div>
  );
}

export function Section({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h2>{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [loading, setLoading] = React.useState(true);
  const reload = React.useCallback(() => {
    setLoading(true);
    fn().then((d) => { setData(d); setError(null); }).catch(setError).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  React.useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}
