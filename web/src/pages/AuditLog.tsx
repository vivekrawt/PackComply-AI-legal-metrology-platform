import React from 'react';
import { api } from '../api';
import { useAsync } from '../components/common';
import { IconDatabase } from '../components/icons';

// The append-only event history, and the one control that matters on it: proving
// the chain has not been altered.
//
// Verification is an action a person takes, not a badge the page asserts. A green
// tick rendered on load would be a claim about integrity that nothing had checked.

const fmt = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
};

export function AuditLog() {
  const events = useAsync(() => api.get<any>('/audit?limit=200'));
  const [chain, setChain] = React.useState<any>(null);
  const [busy, setBusy] = React.useState(false);

  const verify = async () => {
    setBusy(true);
    try { setChain(await api.get('/audit/verify')); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Audit trail</h1>
          <p className="muted">Append-only event history</p>
        </div>
      </div>
      <div className="content">
        <div className="rv-verify">
          <span className="rv-verify-ico"><IconDatabase size={20} /></span>
          <div className="rv-verify-body">
            <b>Hash-chain verification</b>
            <small>
              {chain == null
                ? 'Verify the integrity of the audit log using the stored hash chain.'
                : chain.ok
                  ? 'Audit chain verified — no tampering detected.'
                  : `Chain broken at sequence ${chain.brokenAtSeq} — records have been altered.`}
            </small>
          </div>
          {chain != null && (
            <span className={`chip ${chain.ok ? 'passed' : 'failed'}`}>
              <span className="ico" aria-hidden="true">{chain.ok ? '✓' : '✕'}</span>
              {chain.ok ? 'Verified' : 'Broken'}
            </span>
          )}
          <button className="secondary" onClick={verify} disabled={busy}>
            {busy ? 'Verifying…' : 'Verify integrity'}
          </button>
        </div>

        <div className="table-wrap">
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Date &amp; time</th><th>Actor</th><th>Action</th><th>Object</th><th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {events.data?.events?.map((e: any) => (
                  <tr key={e.id}>
                    <td>{fmt(e.created_at)}</td>
                    <td>
                      {e.actor_label}
                      {e.actor_id && <span className="cell-sub mono">ID: {String(e.actor_id).slice(0, 16)}</span>}
                    </td>
                    <td>{e.action}</td>
                    <td className="mono muted">
                      {e.object_type ? `${e.object_type}:${(e.object_id ?? '').slice(0, 12)}` : '—'}
                    </td>
                    <td>
                      <span className={`chip ${e.outcome === 'success' ? 'passed' : 'failed'}`}>
                        <span className="ico" aria-hidden="true">{e.outcome === 'success' ? '✓' : '✕'}</span>
                        {e.outcome === 'success' ? 'Success' : e.outcome}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <p className="rv-note">Original event IDs and correlation details remain available.</p>
      </div>
    </>
  );
}
