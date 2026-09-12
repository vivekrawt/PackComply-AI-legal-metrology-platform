import React from 'react';
import { Link } from 'react-router-dom';
import {
  api, ATTENTION_META,
  type AdminRow, type AttentionCase, type AuditorRow, type OrgOverview, type TeamRow,
} from '../api';
import { ErrorText, useAsync } from '../components/common';
import { MagnitudeBar, MonthlyThroughput, StatTiles, fmtWhen } from './widgets';

// The super administrator's landing page.
//
// It answers "how is the organization doing", not "what is in my queue" — the
// queue belongs to the admins. Individual scans are reachable from here, but they
// are never the point of the page: teams, admins and auditors are.

export function SuperDashboard() {
  const overview = useAsync(() => api.get<OrgOverview>('/performance/overview'), []);
  const teams = useAsync(() => api.get<{ teams: TeamRow[] }>('/performance/teams'), []);
  const admins = useAsync(() => api.get<{ admins: AdminRow[] }>('/performance/admins'), []);
  const auditors = useAsync(() => api.get<{ auditors: AuditorRow[] }>('/performance/auditors'), []);
  const attention = useAsync(() => api.get<{ cases: AttentionCase[] }>('/performance/attention'), []);

  const o = overview.data;
  const teamRows = teams.data?.teams ?? [];
  const adminRows = admins.data?.admins ?? [];
  const auditorRows = auditors.data?.auditors ?? [];
  const cases = attention.data?.cases ?? [];

  return (
    <>
      <header className="rv-head">
        <div>
          <h1>Organization overview</h1>
          <p>Compliance throughput across every team, admin and auditor.</p>
        </div>
      </header>

      <div className="rv-body">
        <ErrorText error={overview.error} />
        {!o && <p className="muted">Loading…</p>}

        {o && (
          <>
            <StatTiles tiles={[
              { label: 'Cases', value: o.scans.total },
              { label: 'Awaiting review', value: o.scans.awaitingReview, tone: 'awaiting' },
              { label: 'Accepted', value: o.scans.accepted, tone: 'ok' },
              { label: 'Rejected', value: o.scans.rejected, tone: 'bad' },
              { label: 'Sent back', value: o.scans.sentBack, tone: 'warn' },
              { label: 'Needs attention', value: o.attention, tone: o.attention > 0 ? 'bad' : undefined },
            ]} />

            {cases.length > 0 && (
              <section className="rv-panel rv-alert">
                <h2>{cases.length} case{cases.length === 1 ? '' : 's'} need your attention</h2>
                <p className="muted">
                  These do not resolve themselves in any admin&rsquo;s queue, which is what makes
                  them yours.
                </p>
                <ul className="rv-attention">
                  {cases.slice(0, 4).map((c) => (
                    <li key={c.scanId}>
                      <span className={`chip ${ATTENTION_META[c.reason].tone}`}>
                        <span className="ico" aria-hidden="true">!</span>
                        {ATTENTION_META[c.reason].label}
                      </span>
                      <Link to={`/app/scan/${c.scanId}`}>{c.product ?? 'Unnamed product'}</Link>
                      <small>{c.teamName ?? 'No team'} · {c.detail}</small>
                    </li>
                  ))}
                </ul>
                <Link className="btn secondary" to="/app/attention">Review all {cases.length} →</Link>
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
                  A super administrator is not counted in a team: it sits above them.
                </p>
              </section>
            </div>
          </>
        )}

        <PerformanceTable
          title="Team performance"
          href="/app/teams"
          empty="No teams yet."
          rows={teamRows.map((t) => ({
            key: t.id,
            to: `/app/teams/${t.id}`,
            name: t.name,
            meta: `${t.adminCount} admin${t.adminCount === 1 ? '' : 's'} · ${t.auditorCount} auditor${t.auditorCount === 1 ? '' : 's'}${t.status === 'archived' ? ' · archived' : ''}`,
            magnitude: t.stats.total,
            cells: [t.stats.total, t.stats.awaitingReview, t.stats.accepted, t.stats.rejected, t.stats.sentBack],
          }))}
          headers={['Cases', 'Awaiting', 'Accepted', 'Rejected', 'Sent back']}
        />

        <PerformanceTable
          title="Admin performance"
          href="/app/admins"
          empty="No admins yet."
          note="An admin's unit of work is decisions taken, not scans captured."
          rows={adminRows.map((a) => ({
            key: a.id,
            to: `/app/admins/${a.id}`,
            name: a.name,
            meta: `${a.teamName ?? 'No team'} · ${a.teamSize} auditor${a.teamSize === 1 ? '' : 's'} · last decided ${fmtWhen(a.decisions.lastDecisionAt)}`,
            magnitude: a.decisions.decisions,
            cells: [a.decisions.decisions, a.queueAwaiting, a.decisions.accepted, a.decisions.rejected, a.decisions.sentBack],
          }))}
          headers={['Decisions', 'In queue', 'Accepted', 'Rejected', 'Sent back']}
        />

        <PerformanceTable
          title="Auditor performance"
          href="/app/auditors"
          empty="No auditors yet."
          rows={auditorRows.map((a) => ({
            key: a.id,
            to: `/app/auditors/${a.id}`,
            name: a.name,
            meta: `${a.teamName ?? 'No team'} · last active ${fmtWhen(a.stats.lastActivityAt)}`,
            magnitude: a.stats.total,
            cells: [a.stats.total, a.stats.inProgress, a.stats.accepted, a.stats.rejected, a.stats.sentBack],
          }))}
          headers={['Cases', 'In progress', 'Accepted', 'Rejected', 'Sent back']}
        />

        <p className="rv-note">
          Counts describe how much work moved, not how well anyone did it. A high rejection
          count can mean a careful reviewer or a difficult shelf; it is a prompt to look, never
          a verdict on a person.
        </p>
      </div>
    </>
  );
}

interface PerfRow {
  key: string; to: string; name: string; meta: string;
  magnitude: number; cells: number[];
}

function PerformanceTable({ title, href, headers, rows, empty, note }: {
  title: string; href: string; headers: string[]; rows: PerfRow[]; empty: string; note?: string;
}) {
  const max = Math.max(...rows.map((r) => r.magnitude), 1);
  return (
    <section className="rv-panel">
      <div className="rv-panel-head">
        <h2>{title}</h2>
        <Link to={href}>View all →</Link>
      </div>
      {note && <p className="muted rv-sub">{note}</p>}
      {rows.length === 0 ? <p className="muted">{empty}</p> : (
        <div className="rv-scroll">
          <table className="data rv-perf">
            <thead>
              <tr>
                <th>Name</th>
                {headers.map((h) => <th key={h} className="num">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 8).map((r) => (
                <tr key={r.key}>
                  <td>
                    <Link to={r.to}><b>{r.name}</b></Link>
                    <div className="muted rv-row-sub">{r.meta}</div>
                    <MagnitudeBar value={r.magnitude} max={max} />
                  </td>
                  {r.cells.map((c, i) => <td key={i} className="num">{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
