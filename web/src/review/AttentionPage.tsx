import React from 'react';
import { Link } from 'react-router-dom';
import { api, ATTENTION_META, type AttentionCase, type AttentionReason } from '../api';
import { ErrorText, useAsync } from '../components/common';
import { fmtWhen } from './widgets';

// Cases that need super-administrator intervention.
//
// Every entry here is a case no admin queue will resolve on its own — a decision
// overtaken by a re-analysis, a team with nobody to review it, or work that has sat
// undecided past the point where "busy" is the explanation. Each row says which of
// the three it is, in words, rather than sorting them by an invented urgency score.

const REASON_HELP: Record<AttentionReason, string> = {
  stale_decision:
    'The package was re-analysed after a reviewer decided it. The standing decision was taken '
    + 'against a reading that is no longer current, so it needs to be made again.',
  no_active_admin:
    'The team that owns this case has no active admin, so it will never surface in anyone’s '
    + 'queue. Assign an admin to the team, or move the case to a team that has one.',
  awaiting_too_long:
    'Analysed and still undecided after seven days. Nothing is wrong with it structurally — it '
    + 'is simply not being picked up.',
};

export function AttentionPage() {
  const [filter, setFilter] = React.useState<AttentionReason | 'all'>('all');
  const { data, error, loading } = useAsync(
    () => api.get<{ cases: AttentionCase[] }>('/performance/attention'), [],
  );
  const all = data?.cases ?? [];
  const cases = filter === 'all' ? all : all.filter((c) => c.reason === filter);

  const counts = (r: AttentionReason) => all.filter((c) => c.reason === r).length;

  return (
    <>
      <header className="rv-head">
        <div>
          <h1>Needs attention</h1>
          <p>Cases that no admin queue resolves on its own.</p>
        </div>
      </header>

      <div className="rv-body">
        <ErrorText error={error} />

        <div className="rv-toolbar" role="group" aria-label="Filter by reason">
          <button
            className={`filter-chip ${filter === 'all' ? 'on' : ''}`}
            aria-pressed={filter === 'all'}
            onClick={() => setFilter('all')}
          >
            All ({all.length})
          </button>
          {(Object.keys(ATTENTION_META) as AttentionReason[]).map((r) => (
            <button
              key={r}
              className={`filter-chip ${filter === r ? 'on' : ''}`}
              aria-pressed={filter === r}
              onClick={() => setFilter(r)}
            >
              {ATTENTION_META[r].label} ({counts(r)})
            </button>
          ))}
        </div>

        {loading && <p className="muted">Loading…</p>}

        {!loading && all.length === 0 && (
          <div className="rv-empty">
            <b>Nothing needs your intervention</b>
            <p>
              Every analysed case is either decided or sitting in a team queue that has an
              active admin to work it.
            </p>
          </div>
        )}

        {!loading && all.length > 0 && cases.length === 0 && (
          <div className="rv-empty"><b>No cases of this kind</b><p>Try another filter.</p></div>
        )}

        {filter !== 'all' && cases.length > 0 && (
          <p className="warn-box">{REASON_HELP[filter]}</p>
        )}

        <ul className="rv-queue">
          {cases.map((c) => (
            <li key={c.scanId}>
              <Link to={`/app/scan/${c.scanId}`} className="rv-row">
                <span className={`chip ${ATTENTION_META[c.reason].tone}`}>
                  <span className="ico" aria-hidden="true">!</span>
                  {ATTENTION_META[c.reason].label}
                </span>
                <span className="rv-row-main">
                  <b>{c.product ?? 'Unnamed product'}</b>
                  <span className="rv-row-meta">
                    <span>{c.teamName ?? 'No team'}</span>
                    <span className="sep">·</span>
                    <span>{c.officerName ?? 'Unknown auditor'}</span>
                    <span className="sep">·</span>
                    <span>opened {fmtWhen(c.createdAt)}</span>
                  </span>
                  <span className="rv-row-detail">{c.detail}</span>
                </span>
                <span className="rv-row-end"><span className="rv-row-go" aria-hidden="true">→</span></span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
