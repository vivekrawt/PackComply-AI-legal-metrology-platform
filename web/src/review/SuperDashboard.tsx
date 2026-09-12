import React from 'react';
import { Link } from 'react-router-dom';
import { api, type AttentionCase, type OrgOverview } from '../api';
import { ErrorText, useAsync } from '../components/common';
import { MonthlyThroughput, StatTiles, fmtWhen } from './widgets';

// The super administrator's landing page.
//
// It answers "how is the organization doing" and "what needs me" — nothing else.
// Per-team, per-admin and per-auditor performance lives in the Organization
// sections, where each has room to be read properly; repeating leaderboards here
// only made the page longer without making it more answerable.
//
// There is deliberately no org-wide "awaiting review" figure. Undecided work is an
// admin's queue, not the super administrator's; the number that belongs to them is
// what has actually been referred up.

export function SuperDashboard() {
  const overview = useAsync(() => api.get<OrgOverview>('/performance/overview'), []);
  const attention = useAsync(() => api.get<{ cases: AttentionCase[] }>('/performance/attention'), []);

  const o = overview.data;
  const cases = attention.data?.cases ?? [];

  return (
    <>
      <header className="rv-head">
        <div>
          <h1>Organization overview</h1>
          <p>Compliance throughput across every team, and the cases waiting on you.</p>
        </div>
      </header>

      <div className="rv-body">
        <ErrorText error={overview.error} />
        {!o && <p className="muted">Loading…</p>}

        {o && (
          <>
            <StatTiles tiles={[
              { label: 'Cases', value: o.scans.total },
              { label: 'In progress', value: o.scans.inProgress, hint: 'Auditors still capturing or analysing' },
              { label: 'Referred to you', value: o.attention, tone: o.attention > 0 ? 'bad' : undefined },
              { label: 'Accepted', value: o.scans.accepted, tone: 'ok' },
              { label: 'Rejected', value: o.scans.rejected, tone: 'bad' },
              { label: 'Sent back', value: o.scans.sentBack, tone: 'warn' },
            ]} />

            {cases.length > 0 && (
              <section className="rv-panel rv-alert">
                <h2>
                  {cases.length} case{cases.length === 1 ? '' : 's'} referred to you
                </h2>
                <p className="muted">
                  An admin judged each of these beyond their authority to settle. Only your
                  decision clears them.
                </p>
                <ul className="rv-attention">
                  {cases.slice(0, 4).map((c) => (
                    <li key={c.scanId}>
                      <span className="rv-badge escalated">↑ Awaiting you</span>
                      <Link to={`/app/scan/${c.scanId}`}>{c.product ?? 'Unnamed product'}</Link>
                      <small>
                        {c.escalatedBy ?? 'An admin'} · {c.teamName ?? 'No team'} ·{' '}
                        {fmtWhen(c.escalatedAt)} — &ldquo;{c.escalationReason}&rdquo;
                      </small>
                    </li>
                  ))}
                </ul>
                {cases.length > 4 && (
                  <Link className="btn secondary" to="/app/attention">
                    See all {cases.length} →
                  </Link>
                )}
              </section>
            )}

            <div className="rv-two-col">
              <section className="rv-panel">
                <h2>Casework opened per month</h2>
                <MonthlyThroughput data={o.byMonth} />
              </section>

              <section className="rv-panel">
                <h2>People and teams</h2>
                <StatTiles tiles={[
                  { label: 'Teams', value: o.teams.active },
                  { label: 'Admins', value: o.people.admins },
                  { label: 'Auditors', value: o.people.auditors },
                  { label: 'Suspended', value: o.people.suspended, tone: o.people.suspended > 0 ? 'warn' : undefined },
                ]} />
                <p className="rv-note">
                  Each team has one admin. Per-team, per-admin and per-auditor figures are in the
                  Organization sections — <Link to="/app/teams">Teams</Link>,{' '}
                  <Link to="/app/admins">Admins</Link> and <Link to="/app/auditors">Auditors</Link>.
                </p>
              </section>
            </div>
          </>
        )}
      </div>
    </>
  );
}
