import React from 'react';
import { Link } from 'react-router-dom';
import {
  api, REVIEW_META, VERDICT_META,
  type ReviewDecision, type ScanSummary, type VerdictOverall,
} from '../api';
import { AuthContext } from '../App';
import { ErrorText, useAsync } from '../components/common';

// Scans, filtered three ways for three jobs:
//
//   queue    an admin's worklist — analysed cases their team captured, undecided
//            first, because this screen is opened to find work rather than to browse.
//   signed   what has already been decided.
//   all      the complete list, including cases still being captured. Reachable
//            when it is needed; never the landing page, because a list of every
//            individual scan is not how an organization is run.
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
  queue: {
    title: 'Review queue',
    blurb: 'Cases your team has captured and analysed, awaiting your decision.',
  },
  signed: {
    title: 'Signed off',
    blurb: 'Cases that have already been decided.',
  },
  all: {
    title: 'All scans',
    blurb: 'Every case in the organization, including those still being captured.',
  },
};

export function ReviewQueue({ mode }: { mode: Mode }) {
  const { user } = React.useContext(AuthContext);
  const isSuper = user?.role === 'super_admin';
  const [filter, setFilter] = React.useState<Filter>(mode === 'queue' ? 'awaiting' : 'all');
  const [q, setQ] = React.useState('');
  const { data, error, loading } = useAsync(
    () => api.get<{ scans: ScanSummary[] }>('/scans?limit=200'), [],
  );

  React.useEffect(() => { setFilter(mode === 'queue' ? 'awaiting' : 'all'); }, [mode]);

  const all = data?.scans ?? [];
  const assessed = all.filter((s) => s.verdict != null);
  // "All scans" is the only view that admits work the auditor has not finished.
  const pool = mode === 'all' ? all
    : mode === 'signed' ? assessed.filter((s) => s.review)
      : assessed;

  const tally = {
    awaiting: assessed.filter((s) => !s.review).length,
    accepted: assessed.filter((s) => s.review?.decision === 'accepted').length,
    rejected: assessed.filter((s) => s.review?.decision === 'rejected').length,
    recapture: assessed.filter((s) => s.review?.decision === 'recapture_requested').length,
  };

  const needle = q.trim().toLowerCase();
  const scans = pool
    .filter((s) => {
      if (filter === 'all') return true;
      if (filter === 'awaiting') return s.verdict != null && !s.review;
      if (filter === 'unanalysed') return s.verdict == null;
      return s.review?.decision === filter;
    })
    .filter((s) => !needle || [s.brand, s.genericName, s.officerName, s.teamName, s.location]
      .some((v) => v?.toLowerCase().includes(needle)));

  const { title, blurb } = TITLES[mode];

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
            <div className="rv-stat awaiting"><b>{tally.awaiting}</b><span>Awaiting review</span></div>
            <div className="rv-stat ok"><b>{tally.accepted}</b><span>Accepted</span></div>
            <div className="rv-stat bad"><b>{tally.rejected}</b><span>Rejected</span></div>
            <div className="rv-stat warn"><b>{tally.recapture}</b><span>Sent back</span></div>
          </div>
        )}

        <div className="rv-toolbar" role="group" aria-label="Filter scans">
          {FILTERS[mode].map((f) => (
            <button
              key={f.key}
              className={`filter-chip ${filter === f.key ? 'on' : ''}`}
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
          <input
            className="rv-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={isSuper ? 'Search product, auditor, team or location…' : 'Search product, auditor or location…'}
            aria-label="Search scans"
          />
        </div>

        <ErrorText error={error} />
        {loading && <p className="muted">Loading…</p>}

        {!loading && scans.length === 0 && (
          <div className="rv-empty">
            <b>{pool.length === 0 ? 'Nothing here yet' : 'No scans match this filter'}</b>
            <p>
              {pool.length > 0
                ? 'Try a different filter or clear the search.'
                : isSuper
                  ? 'Cases appear once an auditor in your organization captures and analyses a package.'
                  : 'Cases appear once an auditor on your team captures and analyses a package.'}
            </p>
          </div>
        )}

        <ul className="rv-queue">
          {scans.map((s) => <QueueRow key={s.scanId} scan={s} showTeam={isSuper} />)}
        </ul>

        {!loading && scans.length > 0 && (
          <p className="rv-note">
            Showing {scans.length} of {pool.length} case{pool.length === 1 ? '' : 's'}
            {isSuper ? ' across every team in your organization.' : ' on your team.'}
          </p>
        )}
      </div>
    </>
  );
}

function QueueRow({ scan, showTeam }: { scan: ScanSummary; showTeam: boolean }) {
  const v = scan.verdict ? VERDICT_META[scan.verdict as VerdictOverall] : null;
  const r = scan.review ? REVIEW_META[scan.review.decision] : null;
  const title = scan.brand || scan.genericName || 'Unnamed product';

  return (
    <li>
      <Link to={`/app/scan/${scan.scanId}`} className="rv-row">
        <span className={`chip ${v ? v.tone : 'neutral'}`}>
          <span className="ico" aria-hidden="true">{v ? v.icon : '·'}</span>
          {v ? v.label : 'Not analysed'}
        </span>

        <span className="rv-row-main">
          <b>{title}</b>
          <span className="rv-row-meta">
            <span>{scan.officerName ?? 'Unknown auditor'}</span>
            {showTeam && <><span className="sep">·</span><span>{scan.teamName ?? 'No team'}</span></>}
            <span className="sep">·</span>
            <span>{new Date(scan.createdAt).toLocaleString()}</span>
            <span className="sep">·</span>
            <span>{scan.imageCount} image{scan.imageCount === 1 ? '' : 's'}</span>
            {scan.location && <><span className="sep">·</span><span>{scan.location}</span></>}
            {scan.verdictIsMock && <><span className="sep">·</span><span>rule engine only</span></>}
          </span>
        </span>

        <span className="rv-row-end">
          {scan.review?.stale
            ? <span className="rv-badge stale" title="Decided against an earlier analysis of this package">↻ Re-analysed since</span>
            : r
              ? <span className={`rv-badge ${scan.review!.decision}`}>{r.icon} {r.label}</span>
              : scan.verdict
                ? <span className="rv-badge awaiting">● Awaiting review</span>
                : <span className="rv-badge capturing">◌ Still capturing</span>}
          <span className="rv-row-go" aria-hidden="true">→</span>
        </span>
      </Link>
    </li>
  );
}
