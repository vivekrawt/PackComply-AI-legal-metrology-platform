import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  api, REVIEW_META, VERDICT_META,
  type ReviewDecision, type ScanSummary, type VerdictOverall,
} from '../api';
import { AuthContext } from '../App';
import { ErrorText, useAsync } from '../components/common';
import { fmtDay } from './widgets';

// Scans, filtered three ways for three jobs:
//
//   queue    an admin's worklist — analysed cases their team captured, undecided
//            first, because this screen is opened to find work rather than to browse.
//   signed   what has already been decided.
//   all      the complete list, including cases still being captured. Reachable
//            when it is needed; never the landing page, because a list of every
//            individual scan is not how an organization is run.
//
// Each mode shows the columns its job turns on — a worklist needs the assessment, a
// decision log needs who decided and when — rather than one wide table that every
// reader has to filter with their eyes.
//
// Scope is the server's: an admin's request returns their team, a super
// administrator's returns the organization. This component never filters by team.

type Mode = 'queue' | 'signed' | 'all';
type Filter = 'awaiting' | ReviewDecision | 'unanalysed' | 'all';

const FILTERS: Record<Mode, { key: Filter; label: string }[]> = {
  queue: [
    { key: 'awaiting', label: 'Awaiting review' },
    { key: 'all', label: 'All analysed' },
  ],
  signed: [
    { key: 'all', label: 'All decisions' },
    { key: 'accepted', label: 'Accepted' },
    { key: 'rejected', label: 'Rejected' },
    { key: 'recapture_requested', label: 'Sent back' },
    { key: 'escalated', label: 'Referred up' },
  ],
  all: [
    { key: 'all', label: 'Everything' },
    { key: 'awaiting', label: 'Awaiting review' },
    { key: 'accepted', label: 'Accepted' },
    { key: 'rejected', label: 'Rejected' },
    { key: 'recapture_requested', label: 'Sent back' },
    { key: 'escalated', label: 'Referred up' },
    { key: 'unanalysed', label: 'Still capturing' },
  ],
};

const TITLES: Record<Mode, { title: string; blurb: string }> = {
  queue: { title: 'Review queue', blurb: 'Cases from your team, ready for a decision.' },
  signed: { title: 'Signed off', blurb: 'Cases your team has already decided.' },
  all: { title: 'All scans', blurb: 'Every case in the organization, including those still being captured.' },
};

const SHORT_VERDICT: Record<VerdictOverall, string> = {
  compliant: 'Ready', non_compliant: 'Not ready', needs_review: 'Needs review',
};

export function Assessment({ scan }: { scan: ScanSummary }) {
  const v = scan.verdict ? VERDICT_META[scan.verdict as VerdictOverall] : null;
  return (
    <span className={`chip ${v ? v.tone : 'neutral'}`}>
      <span className="ico" aria-hidden="true">{v ? v.icon : '·'}</span>
      {v ? SHORT_VERDICT[scan.verdict as VerdictOverall] : 'Not analysed'}
    </span>
  );
}

// Where the case stands with a human, as distinct from what the machine made of it.
export function Decision({ scan }: { scan: ScanSummary }) {
  if (scan.review?.stale) {
    return (
      <span className="chip not_assessable" title="Decided against an earlier analysis of this package">
        <span className="ico" aria-hidden="true">↻</span>Re-analysed since
      </span>
    );
  }
  const r = scan.review ? REVIEW_META[scan.review.decision] : null;
  if (r) {
    return <span className={`chip ${r.tone}`}><span className="ico" aria-hidden="true">{r.icon}</span>{r.label}</span>;
  }
  if (!scan.verdict) return <span className="chip not_assessable"><span className="ico">◌</span>Still capturing</span>;
  return <span className="chip needs_review"><span className="ico">●</span>Awaiting review</span>;
}

export function ReviewQueue({ mode }: { mode: Mode }) {
  const nav = useNavigate();
  const { user } = React.useContext(AuthContext);
  const isSuper = user?.role === 'super_admin';
  const [filter, setFilter] = React.useState<Filter>(mode === 'queue' ? 'awaiting' : 'all');
  const [q, setQ] = React.useState('');
  const { data, error, loading } = useAsync(
    () => api.get<{ scans: ScanSummary[] }>('/scans?limit=200'), [],
  );

  React.useEffect(() => { setFilter(mode === 'queue' ? 'awaiting' : 'all'); }, [mode]);

  const all = data?.scans ?? [];
  // Review work is what an auditor has analysed AND handed over. A scan they are
  // still working on is theirs, not a reviewer's, however far the machine has got.
  const submitted = all.filter((s) => s.verdict != null && s.submittedAt);
  // "All scans" is the only view that admits work the auditor has not sent yet.
  const pool = mode === 'all' ? all
    : mode === 'signed' ? submitted.filter((s) => s.review)
      : submitted;

  const tally = {
    awaiting: submitted.filter((s) => !s.review).length,
    accepted: submitted.filter((s) => s.review?.decision === 'accepted').length,
    rejected: submitted.filter((s) => s.review?.decision === 'rejected').length,
    recapture: submitted.filter((s) => s.review?.decision === 'recapture_requested').length,
  };

  const needle = q.trim().toLowerCase();
  const scans = pool
    .filter((s) => {
      if (filter === 'all') return true;
      if (filter === 'awaiting') return s.verdict != null && s.submittedAt != null && !s.review;
      if (filter === 'unanalysed') return s.verdict == null;
      return s.review?.decision === filter;
    })
    .filter((s) => !needle || [s.brand, s.genericName, s.officerName, s.teamName, s.location]
      .some((v) => v?.toLowerCase().includes(needle)));

  const { title, blurb } = TITLES[mode];
  const title_ = (s: ScanSummary) => s.brand || s.genericName || 'Unnamed product';

  return (
    <>
      <header className="rv-head">
        <div>
          <h1>{title}</h1>
          <p>{blurb}</p>
        </div>
      </header>

      <div className="rv-body">
        {mode === 'queue' && (
          <div className="rv-stats">
            <div className="rv-stat awaiting"><b>{tally.awaiting}</b><span>Awaiting</span></div>
            <div className="rv-stat"><b>{tally.accepted}</b><span>Accepted</span></div>
            <div className="rv-stat"><b>{tally.rejected}</b><span>Rejected</span></div>
            <div className="rv-stat"><b>{tally.recapture}</b><span>Sent back</span></div>
          </div>
        )}

        {/* A worklist has two states and switches between them; a log is sliced many
            ways. Underlined tabs for the first, pills for the second. */}
        {mode === 'queue' ? (
          <div className="rv-toolbar">
            <div className="rv-tabs" role="group" aria-label="Filter scans">
              {FILTERS.queue.map((f) => (
                <button key={f.key} className={filter === f.key ? 'on' : ''}
                  aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
                  {f.label}
                </button>
              ))}
            </div>
            <SearchBox q={q} setQ={setQ} isSuper={isSuper} />
          </div>
        ) : (
          <div className="rv-toolbar">
            <div className="pc-filters" role="group" aria-label="Filter scans">
              {FILTERS[mode].map((f) => (
                <button key={f.key} className={`filter-chip ${filter === f.key ? 'on' : ''}`}
                  aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
                  {f.label}
                </button>
              ))}
            </div>
            <SearchBox q={q} setQ={setQ} isSuper={isSuper} />
          </div>
        )}

        <ErrorText error={error} />
        {loading && <p className="muted">Loading…</p>}

        {!loading && scans.length === 0 && (
          <div className="rv-empty">
            <div>
              <b>
                {pool.length === 0
                  ? mode === 'queue' ? 'No cases waiting for review' : 'Nothing here yet'
                  : 'No scans match this filter'}
              </b>
              <p>
                {pool.length > 0
                  ? 'Try a different filter or clear the search.'
                  : mode === 'queue'
                    ? 'Your team is all caught up.'
                    : isSuper
                      ? 'Cases appear once an auditor in your organization captures and analyses a package.'
                      : 'Cases appear once an auditor on your team captures and analyses a package.'}
              </p>
            </div>
          </div>
        )}

        {scans.length > 0 && (
          <div className="table-wrap">
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Product</th>
                    {mode === 'all' && <th>Team</th>}
                    {mode !== 'signed' && <th>Assessment</th>}
                    <th>Decision</th>
                    {mode === 'signed' && <th>Decided by</th>}
                    {mode === 'signed' && <th>Date</th>}
                    {mode === 'all' && <th className="num">Images</th>}
                    <th className="go"><span className="sr-only">Open</span></th>
                  </tr>
                </thead>
                <tbody>
                  {scans.map((s) => (
                    <tr key={s.scanId} className="clickable" onClick={() => nav(`/app/scan/${s.scanId}`)}>
                      <td>
                        <Link className="row-link" to={`/app/scan/${s.scanId}`} onClick={(e) => e.stopPropagation()}>
                          {title_(s)}
                        </Link>
                        {mode !== 'all' && (
                          <span className="cell-sub">
                            {s.officerName ?? 'Unknown auditor'}
                            {isSuper && s.teamName ? ` · ${s.teamName}` : ''}
                            {s.location ? ` · ${s.location}` : ''}
                          </span>
                        )}
                      </td>
                      {mode === 'all' && <td className="muted">{s.teamName ?? 'No team'}</td>}
                      {mode !== 'signed' && <td><Assessment scan={s} /></td>}
                      <td><Decision scan={s} /></td>
                      {mode === 'signed' && <td>{s.review?.reviewerName ?? '—'}</td>}
                      {mode === 'signed' && <td>{fmtDay(s.review?.createdAt ?? null)}</td>}
                      {mode === 'all' && <td className="num">{s.imageCount}</td>}
                      <td className="go" />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!loading && scans.length > 0 && (
          <p className="rv-note">
            Showing {scans.length} of {pool.length} case{pool.length === 1 ? '' : 's'}
            {isSuper ? ' across your organization.' : ' on your team.'}
          </p>
        )}
      </div>
    </>
  );
}

function SearchBox({ q, setQ, isSuper }: { q: string; setQ: (v: string) => void; isSuper: boolean }) {
  return (
    <div className="search-field">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={isSuper ? 'Search product, auditor or team…' : 'Search products…'}
        aria-label="Search scans"
      />
    </div>
  );
}
