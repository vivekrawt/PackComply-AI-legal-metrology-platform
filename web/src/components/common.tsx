import React from 'react';
import { OUTCOME_META } from '../api';
import { IconClose } from './icons';

// Initials for an identity badge. Two letters at most — a longer run stops being a
// mark and starts being unreadable text in a 38px circle.
//
// A parenthetical is a qualifier, not part of the name: "Asha Kulkarni (Demo
// Inspector)" is AK, not AI.
export function initials(name: string | null | undefined): string {
  const parts = (name ?? '').replace(/\([^)]*\)/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({ name, large }: { name: string | null | undefined; large?: boolean }) {
  return <span className={`pc-avatar${large ? ' lg' : ''}`} aria-hidden="true">{initials(name)}</span>;
}

// Who is acting, and under what authority. Shown wherever the app is signed in,
// because an officer should never have to remember which role they are holding.
export function WhoBadge({ name, role, email }: { name: string; role: string; email?: string }) {
  return (
    <span className="pc-who">
      <Avatar name={name} />
      <span className="pc-who-text">
        <b title={email}>{name}</b>
        <small>{role}</small>
      </span>
    </span>
  );
}

// A dialog that owns the screen: escape closes it, the backdrop closes it, and the
// page behind it is inert to a pointer.
export function Modal({ title, blurb, onClose, children, footer }: {
  title: string; blurb?: string; onClose: () => void;
  children: React.ReactNode; footer?: React.ReactNode;
}) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="pc-backdrop" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="pc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pc-modal-head">
          <div>
            <h2>{title}</h2>
            {blurb && <p>{blurb}</p>}
          </div>
          <button className="pc-modal-close" onClick={onClose} aria-label="Close"><IconClose /></button>
        </div>
        {children}
        {footer && <div className="pc-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// Status = a coloured dot beside the word it stands for (never colour alone).
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
