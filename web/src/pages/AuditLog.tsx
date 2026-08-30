import React from 'react';
import { api } from '../api';
import { Section, useAsync } from '../components/common';

export function AuditLog() {
  const events = useAsync(() => api.get<any>('/audit?limit=200'));
  const [chain, setChain] = React.useState<any>(null);
  return (
    <>
      <div className="topbar"><h1>Audit log (append-only, hash-chained)</h1></div>
      <div className="content">
        <Section title="Integrity" actions={
          <button className="secondary" onClick={async () => setChain(await api.get('/audit/verify'))}>Verify hash chain</button>
        }>
          {chain && (chain.ok
            ? <span className="ok-text">✓ Audit chain verified — no tampering detected.</span>
            : <span className="error-text">✕ Chain broken at seq {chain.brokenAtSeq} — records altered!</span>)}
        </Section>
        <Section title="Events">
          <table className="data">
            <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Object</th><th>Outcome</th><th>Correlation</th></tr></thead>
            <tbody>
              {events.data?.events?.map((e: any) => (
                <tr key={e.id}>
                  <td className="muted">{e.created_at}</td>
                  <td>{e.actor_label}</td>
                  <td>{e.action}</td>
                  <td className="mono">{e.object_type ? `${e.object_type}:${(e.object_id ?? '').slice(0, 14)}` : ''}</td>
                  <td>{e.outcome === 'success' ? '✓' : <span className="error-text">{e.outcome}</span>}</td>
                  <td className="mono muted">{(e.correlation_id ?? '').slice(0, 12)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      </div>
    </>
  );
}
