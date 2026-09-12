import React from 'react';
import { Link } from 'react-router-dom';
import { api, VERDICT_META, type AttentionCase, type VerdictOverall } from '../api';
import { ErrorText, useAsync } from '../components/common';
import { fmtWhen } from './widgets';

// Cases an admin has referred upward.
//
// This is the only way anything reaches this list. Nothing arrives because the
// system inferred it was interesting — every entry is a named person asking for a
// decision they judged beyond their authority, and their reason is shown with it.
// A super administrator's answer clears the case and cannot be changed at admin
// level afterwards.

export function AttentionPage() {
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
          <p>Cases an admin referred to you because they judged them beyond their authority.</p>
        </div>
      </header>

      <div className="rv-body">
        <ErrorText error={error} />

        {all.length > 0 && (
          <div className="rv-toolbar">
            <input
              className="rv-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search product, team, auditor or admin…"
              aria-label="Search referred cases"
            />
          </div>
        )}

        {loading && <p className="muted">Loading…</p>}

        {!loading && all.length === 0 && (
          <div className="rv-empty">
            <b>Nothing has been referred to you</b>
            <p>
              Admins are settling their own teams&rsquo; cases. When one decides a case needs your
              authority, it appears here with their reason for raising it.
            </p>
          </div>
        )}

        {!loading && all.length > 0 && cases.length === 0 && (
          <div className="rv-empty"><b>No referred cases match</b><p>Clear the search to see all {all.length}.</p></div>
        )}

        <ul className="rv-queue">
          {cases.map((c) => {
            const v = c.verdict ? VERDICT_META[c.verdict as VerdictOverall] : null;
            return (
              <li key={c.scanId}>
                <Link to={`/app/scan/${c.scanId}`} className="rv-row">
                  <span className={`chip ${v ? v.tone : 'neutral'}`}>
                    <span className="ico" aria-hidden="true">{v ? v.icon : '·'}</span>
                    {v ? v.label : 'Not analysed'}
                  </span>
                  <span className="rv-row-main">
                    <b>{c.product ?? 'Unnamed product'}</b>
                    <span className="rv-row-meta">
                      <span>referred by {c.escalatedBy ?? 'an admin'}</span>
                      <span className="sep">·</span>
                      <span>{c.teamName ?? 'No team'}</span>
                      <span className="sep">·</span>
                      <span>captured by {c.officerName ?? 'unknown auditor'}</span>
                      <span className="sep">·</span>
                      <span>{fmtWhen(c.escalatedAt)}</span>
                    </span>
                    <span className="rv-row-detail">&ldquo;{c.escalationReason}&rdquo;</span>
                  </span>
                  <span className="rv-row-end">
                    <span className="rv-badge escalated">↑ Awaiting you</span>
                    <span className="rv-row-go" aria-hidden="true">→</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
