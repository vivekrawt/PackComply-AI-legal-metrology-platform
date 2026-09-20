import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type AttentionCase } from '../api';
import { ErrorText, useAsync } from '../components/common';
import { fmtDay } from './widgets';

// Cases an admin has referred upward.
//
// This is the only way anything reaches this list. Nothing arrives because the
// system inferred it was interesting — every entry is a named person asking for a
// decision they judged beyond their authority, and their reason travels with it,
// under the row rather than in a column that would truncate it.
// A super administrator's answer clears the case and cannot be changed at admin
// level afterwards.

export function AttentionPage() {
  const nav = useNavigate();
  const [q, setQ] = React.useState('');
  const { data, error, loading } = useAsync(
    () => api.get<{ cases: AttentionCase[] }>('/performance/attention'), [],
  );
  const all = data?.cases ?? [];
  const needle = q.trim().toLowerCase();
  const cases = all.filter((c) => !needle
    || [c.product, c.teamName, c.officerName, c.escalatedBy, c.escalationReason]
      .some((v) => v?.toLowerCase().includes(needle)));

  return (
    <>
      <header className="rv-head">
        <div>
          <h1>Needs your decision</h1>
          <p>Cases referred by a reviewer.</p>
        </div>
        {all.length > 0 && (
          <div className="rv-head-actions">
            <div className="search-field">
              <input
                value={q} onChange={(e) => setQ(e.target.value)}
                placeholder="Search referred cases…" aria-label="Search referred cases"
              />
            </div>
          </div>
        )}
      </header>

      <div className="rv-body">
        <ErrorText error={error} />
        {loading && <p className="muted">Loading…</p>}

        {!loading && all.length === 0 && (
          <div className="rv-empty">
            <div>
              <b>Nothing has been referred to you</b>
              <p>
                Admins are settling their own teams&rsquo; cases. When one decides a case needs your
                authority, it appears here with their reason for raising it.
              </p>
            </div>
          </div>
        )}

        {!loading && all.length > 0 && cases.length === 0 && (
          <div className="rv-empty">
            <div><b>No referred cases match</b><p>Clear the search to see all {all.length}.</p></div>
          </div>
        )}

        {cases.length > 0 && (
          <div className="table-wrap">
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Product</th><th>Team</th><th>Referred by</th><th>Date</th><th>Status</th>
                    <th className="go"><span className="sr-only">Open</span></th>
                  </tr>
                </thead>
                <tbody>
                  {cases.map((c) => (
                    <React.Fragment key={c.scanId}>
                      <tr className="clickable" onClick={() => nav(`/app/scan/${c.scanId}`)}>
                        <td>
                          <Link className="row-link" to={`/app/scan/${c.scanId}`} onClick={(e) => e.stopPropagation()}>
                            {c.product ?? 'Unnamed product'}
                          </Link>
                          <span className="cell-sub">captured by {c.officerName ?? 'unknown auditor'}</span>
                        </td>
                        <td className="muted">{c.teamName ?? 'No team'}</td>
                        <td>{c.escalatedBy ?? 'An admin'}</td>
                        <td>{fmtDay(c.escalatedAt)}</td>
                        <td>
                          <span className="chip needs_review">
                            <span className="ico" aria-hidden="true">↑</span>Awaiting you
                          </span>
                        </td>
                        <td className="go" />
                      </tr>
                      {/* The reason they raised it, whole. Truncating the one sentence
                          that explains why this is on the screen would defeat the list. */}
                      <tr className="decl-detail">
                        <td colSpan={6}>
                          <div className="decl-detail-box">
                            <div className="decl-detail-text">
                              <p><b>Referral reason:</b> &ldquo;{c.escalationReason}&rdquo;</p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
