import React from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ErrorText, Section, useAsync } from '../components/common';

// Recycle bin (DEL-01) — visible only to super_admin, the only role holding
// 'inspection.delete'. Deletion in PackComply is a soft delete: the row and its
// evidence hashes stay so the append-only audit chain and any already-issued report
// remain verifiable, and a record deleted in error can be put back.
export function Trash() {
  const deleted = useAsync(() => api.get<any>('/inspections/deleted'));
  const [error, setError] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const restore = async (id: string) => {
    setBusy(id); setError(null);
    try { await api.post(`/inspections/${id}/restore`); deleted.reload(); }
    catch (e) { setError(e); } finally { setBusy(null); }
  };

  const rows = deleted.data?.inspections ?? [];

  return (
    <>
      <div className="topbar"><h1>Deleted records</h1>
        <span className="who">super administrator only</span>
      </div>
      <div className="content">
        <ErrorText error={error} />
        <p className="warn-box">
          Deletion here is reversible and always attributed. Every entry below carries the officer who
          deleted it and the reason they gave; both are written to the tamper-evident audit log, and the
          evidence hashes are retained so a report issued before the deletion still verifies.
        </p>
        <Section title={`Deleted inspections (${rows.length})`}>
          {rows.length === 0 && <p className="muted">Nothing has been deleted.</p>}
          {rows.length > 0 && (
            <table className="data">
              <thead><tr><th>Inspection</th><th>Status when deleted</th><th>Deleted</th><th>By</th><th>Reason</th><th></th></tr></thead>
              <tbody>
                {rows.map((i: any) => (
                  <tr key={i.id}>
                    <td><span className="mono">{i.id}</span><div className="muted">{i.type}{i.location ? ` · ${i.location}` : ''}</div></td>
                    <td><span className="chip not_applicable"><span className="ico">—</span>{i.status}</span></td>
                    <td className="muted">{new Date(i.deletedAt).toLocaleString()}</td>
                    <td className="muted">{i.deletedBy ?? 'unknown'}</td>
                    <td>{i.deletedReason}</td>
                    <td className="btn-row">
                      <button className="secondary" disabled={busy === i.id} onClick={() => restore(i.id)}>
                        {busy === i.id ? '⟳ Restoring…' : 'Restore'}
                      </button>
                      <Link className="quiet" to={`/app/inspections/${i.id}`}>Open</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      </div>
    </>
  );
}
