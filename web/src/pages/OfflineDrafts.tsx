import React from 'react';
import { Link } from 'react-router-dom';
import { Section, ErrorText } from '../components/common';
import { listDrafts, deleteDraft, syncDrafts, type OfflineDraft } from '../offline';

const STATE_CHIP: Record<string, { cls: string; ico: string; label: string }> = {
  local: { cls: 'neutral', ico: '⛁', label: 'local (encrypted)' },
  pending: { cls: 'needs_review', ico: '…', label: 'pending' },
  uploading: { cls: 'needs_review', ico: '⟳', label: 'uploading' },
  synced: { cls: 'passed', ico: '✓', label: 'synced' },
  failed: { cls: 'failed', ico: '✕', label: 'failed' },
};

export function OfflineDrafts() {
  const [drafts, setDrafts] = React.useState<OfflineDraft[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [lastSync, setLastSync] = React.useState<string | null>(null);

  const reload = React.useCallback(() => { listDrafts().then(setDrafts).catch(setError); }, []);
  React.useEffect(reload, [reload]);

  const sync = async () => {
    setBusy(true); setError(null);
    try {
      const r = await syncDrafts();
      setLastSync(`${r.synced} synced, ${r.failed} failed`);
      reload();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="topbar"><h1>Offline drafts</h1>
        <span className="who">{navigator.onLine ? 'online' : '⚠ offline — sync will resume when connectivity returns'}</span>
      </div>
      <div className="content">
        <Section title={`Locally stored drafts (${drafts.length})`} actions={
          <div className="btn-row">
            {lastSync && <span className="muted">last sync: {lastSync}</span>}
            <button className="primary" onClick={sync} disabled={busy || !navigator.onLine}>⇅ Sync now</button>
          </div>
        }>
          <p className="muted">
            Drafts and queued photos are AES-GCM encrypted at rest in this browser (non-extractable key).
            Sync is idempotent — an interrupted upload resumes without creating duplicates. Failed items stay
            here with their error; nothing is resolved silently.
          </p>
          <ErrorText error={error} />
          <table className="data">
            <thead><tr><th>Created</th><th>Type</th><th>Product</th><th>Photos</th><th>State</th><th></th></tr></thead>
            <tbody>
              {drafts.map((d) => {
                const chip = STATE_CHIP[d.syncState] ?? STATE_CHIP.local;
                return (
                  <tr key={d.localId}>
                    <td className="muted">{d.createdAt.slice(0, 19).replace('T', ' ')}</td>
                    <td>{d.payload.type}</td>
                    <td>{[d.payload.product?.brand, d.payload.product?.genericName].filter(Boolean).join(' — ') || d.payload.location || '—'}</td>
                    <td>{d.evidenceCount}</td>
                    <td>
                      <span className={`chip ${chip.cls}`}><span className="ico">{chip.ico}</span>{chip.label}</span>
                      {d.error && <div className="error-text">{d.error}</div>}
                      {d.serverId && <div><Link className="mono" to={`/app/inspections/${d.serverId}`}>{d.serverId.slice(0, 18)}…</Link></div>}
                    </td>
                    <td>
                      <button className="danger" onClick={async () => {
                        if (d.syncState !== 'synced' && !confirm('Delete this unsynced draft permanently? Its queued photos will be lost.')) return;
                        await deleteDraft(d.localId); reload();
                      }}>Delete</button>
                    </td>
                  </tr>
                );
              })}
              {drafts.length === 0 && <tr><td colSpan={6} className="muted">No offline drafts. Create one from “New Inspection” while offline — or it saves locally automatically if the network drops mid-save.</td></tr>}
            </tbody>
          </table>
        </Section>
      </div>
    </>
  );
}
