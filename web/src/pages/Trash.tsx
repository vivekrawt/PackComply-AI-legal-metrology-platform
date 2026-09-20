import React from 'react';
import { api } from '../api';
import { ErrorText, useAsync } from '../components/common';
import { IconTrash } from '../components/icons';

// Recycle bin (DEL-01) — visible only to super_admin, the only role holding
// 'inspection.delete'. Deletion in PackComply is a soft delete: the row and its
// evidence hashes stay so the append-only audit chain and any already-issued report
// remain verifiable, and a record deleted in error can be put back.
//
// Every row names the officer who deleted it and the reason they gave, because a
// deletion without an author is the one thing this table must never show.

const fmtDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, {
    day: '2-digit', month: 'short', year: 'numeric',
  });
};

export function Trash() {
  const deleted = useAsync(() => api.get<any>('/inspections/deleted'));
  const [error, setError] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<string | null>(null);

  const restore = async (id: string) => {
    setBusy(id); setError(null);
    try { await api.post(`/inspections/${id}/restore`); deleted.reload(); }
    catch (e) { setError(e); } finally { setBusy(null); }
  };

  const rows: any[] = deleted.data?.inspections ?? [];

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Deleted records</h1>
          <p className="muted">{rows.length} deleted inspection{rows.length === 1 ? '' : 's'}</p>
        </div>
      </div>
      <div className="content">
        <ErrorText error={error} />

        <div className="rv-verify">
          <span className="rv-verify-ico"><IconTrash size={20} /></span>
          <div className="rv-verify-body">
            <b>Deletion is reversible</b>
            <small>
              The actor, the reason and the evidence hashes are retained, so a report issued before
              the deletion still verifies.
            </small>
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="rv-empty"><div><b>Nothing has been deleted</b><p>Deleted inspections would be listed here, ready to restore.</p></div></div>
        ) : (
          <div className="table-wrap">
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Inspection</th><th>Status at deletion</th><th>Deleted</th>
                    <th>Deleted by</th><th>Reason</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((i) => (
                    <React.Fragment key={i.id}>
                      <tr>
                        <td className="mono">{i.id.slice(0, 14)}…</td>
                        <td>
                          <span className="chip neutral"><span className="ico" aria-hidden="true">—</span>{i.status}</span>
                        </td>
                        <td>{fmtDay(i.deletedAt)}</td>
                        <td>{i.deletedBy ?? 'unknown'}</td>
                        <td>{i.deletedReason}</td>
                        <td>
                          <span className="btn-row">
                            <button className="secondary" disabled={busy === i.id} onClick={() => restore(i.id)}>
                              {busy === i.id ? 'Restoring…' : 'Restore'}
                            </button>
                            <button className="link-btn" onClick={() => setDetail(detail === i.id ? null : i.id)}>
                              View details
                            </button>
                          </span>
                        </td>
                      </tr>
                      {detail === i.id && (
                        <tr className="decl-detail">
                          <td colSpan={6}>
                            <div className="decl-detail-box">
                              <div className="decl-detail-text">
                                <p><b>Full identifier:</b> <span className="mono">{i.id}</span></p>
                                <p>
                                  {i.type}{i.location ? ` · ${i.location}` : ''} · deleted{' '}
                                  {new Date(i.deletedAt).toLocaleString()}
                                </p>
                                <p>&ldquo;{i.deletedReason}&rdquo;</p>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {rows.length > 0 && (
          <p className="rv-note">Showing {rows.length} record{rows.length === 1 ? '' : 's'}.</p>
        )}
      </div>
    </>
  );
}
