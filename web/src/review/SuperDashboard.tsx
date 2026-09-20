import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type AttentionCase, type OrgOverview } from '../api';
import { ErrorText, useAsync } from '../components/common';
import { IconPause, IconPeople, IconPerson } from '../components/icons';
import { MonthlyThroughput, StatTiles } from './widgets';

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
  const nav = useNavigate();
  const overview = useAsync(() => api.get<OrgOverview>('/performance/overview'), []);
  const attention = useAsync(() => api.get<{ cases: AttentionCase[] }>('/performance/attention'), []);

  const o = overview.data;
  const cases = attention.data?.cases ?? [];
  const first = cases[0];

  return (
    <>
      <header className="rv-head">
        <div>
          <h1>Organization overview</h1>
          <p>Cases, people and activity across your organization.</p>
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
              { label: 'Referred', value: o.attention, tone: o.attention > 0 ? 'bad' : undefined, hint: 'Referred to you by an admin' },
              { label: 'Accepted', value: o.scans.accepted, tone: 'ok' },
              { label: 'Rejected', value: o.scans.rejected, tone: 'bad' },
              { label: 'Sent back', value: o.scans.sentBack, tone: 'warn' },
            ]} />

            {/* Nothing reaches this callout because the system found it interesting.
                Every case in it is a named admin asking for a decision. */}
            {first && (
              <div className="rv-callout">
                <span className="rv-callout-ico" aria-hidden="true">i</span>
                <div className="rv-callout-body">
                  <b>
                    {cases.length} case{cases.length === 1 ? '' : 's'} need
                    {cases.length === 1 ? 's' : ''} your decision
                  </b>
                  <small>
                    {first.product ?? 'Unnamed product'} · {first.teamName ?? 'No team'} ·{' '}
                    {first.escalatedBy ?? 'an admin'}
                    {cases.length > 1 ? ` · and ${cases.length - 1} more` : ''}
                  </small>
                </div>
                <button className="primary" onClick={() => nav(cases.length > 1 ? '/app/attention' : `/app/scan/${first.scanId}`)}>
                  {cases.length > 1 ? 'See all' : 'Review case'}
                </button>
              </div>
            )}

            <h2 className="rv-section-title">People and teams</h2>
            <StatTiles tiles={[
              { label: 'team', value: o.teams.active, icon: <IconPeople size={20} /> },
              { label: 'admins', value: o.people.admins, icon: <IconPerson size={20} /> },
              { label: 'auditors', value: o.people.auditors, icon: <IconPeople size={20} /> },
              { label: 'suspended', value: o.people.suspended, icon: <IconPause size={20} />, tone: o.people.suspended > 0 ? 'warn' : undefined },
            ]} />

            <h2 className="rv-section-title">Casework opened per month</h2>
            <MonthlyThroughput data={o.byMonth} />

            <p className="rv-note">
              Each team has one admin. Per-team, per-admin and per-auditor figures are in{' '}
              <Link to="/app/teams">Teams</Link>, <Link to="/app/admins">Admins</Link> and{' '}
              <Link to="/app/auditors">Auditors</Link>.
            </p>
          </>
        )}
      </div>
    </>
  );
}
