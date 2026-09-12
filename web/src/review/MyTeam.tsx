import React from 'react';
import { Link } from 'react-router-dom';
import { api, type ScanStats } from '../api';
import { AuthContext } from '../App';
import { ErrorText, useAsync } from '../components/common';
import { MagnitudeBar, StatTiles, StatusChip, scanStatTiles } from './widgets';

// An admin's view of their own team: the auditors reporting to them.
//
// It does not list the admin. A team has exactly one, you are signed in as them,
// and a panel telling you who you are is noise. Membership is the super
// administrator's authority, so this screen reads rather than edits — open an
// auditor to see what they have got through today, this week and this month.

interface TeamDetailData {
  team: { id: string; name: string; description: string | null; status: string; createdAt: string };
  stats: ScanStats;
  admins: any[];
  auditors: any[];
}

export function MyTeam() {
  const { user } = React.useContext(AuthContext);
  const teamId = user?.teamId ?? null;
  const d = useAsync(
    () => (teamId ? api.get<TeamDetailData>(`/performance/teams/${teamId}`) : Promise.resolve(null)),
    [teamId],
  );
  const auditorStats = useAsync(
    () => api.get<{ auditors: any[] }>('/performance/auditors'), [],
  );

  if (!teamId) {
    return (
      <>
        <header className="rv-head"><div><h1>My team</h1></div></header>
        <div className="rv-body">
          <div className="rv-empty">
            <b>You are not assigned to a team</b>
            <p>
              Your review queue will stay empty until a super administrator puts you on one —
              an admin reviews their own team&rsquo;s work, so with no team there is nothing to review.
            </p>
          </div>
        </div>
      </>
    );
  }

  if (!d.data) {
    return <div className="rv-body"><ErrorText error={d.error} />{!d.error && <p className="muted">Loading…</p>}</div>;
  }
  const { team, stats, auditors } = d.data;
  const byId = new Map((auditorStats.data?.auditors ?? []).map((a) => [a.id, a]));
  const max = Math.max(...(auditorStats.data?.auditors ?? []).map((a) => a.stats.total), 1);

  return (
    <>
      <header className="rv-head">
        <div>
          <h1>{team.name}</h1>
          <p>{team.description || 'Your team and everything it has captured.'}</p>
        </div>
      </header>

      <div className="rv-body">
        <StatTiles tiles={scanStatTiles(stats)} />

        <section className="rv-panel">
          <div className="rv-panel-head">
            <h2>Auditors on your team <span className="check-count">{auditors.length}</span></h2>
          </div>
          <p className="muted rv-sub">
            Open anyone to see what they have completed today, this week and this month.
          </p>

          {auditors.length === 0 && (
            <p className="warn-box">
              No auditors are assigned to your team yet, so nothing will reach your queue. A super
              administrator assigns them.
            </p>
          )}

          <ul className="rv-queue">
            {auditors.map((a) => {
              const s = byId.get(a.id)?.stats;
              return (
                <li key={a.id}>
                  <Link to={`/app/auditors/${a.id}`} className="rv-row">
                    <span className="rv-row-main">
                      <b>{a.name}</b>
                      <span className="rv-row-meta"><span>{a.email}</span></span>
                      {s && <MagnitudeBar value={s.total} max={max} />}
                    </span>
                    <span className="rv-row-end">
                      {s && (
                        <span className="rv-mini-stats">
                          <span><b>{s.total}</b> cases</span>
                          <span><b>{s.inProgress}</b> in progress</span>
                        </span>
                      )}
                      <StatusChip status={a.status} />
                      <span className="rv-row-go" aria-hidden="true">→</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>

        {stats.awaitingReview > 0 && (
          <p className="warn-box">
            {stats.awaitingReview} case{stats.awaitingReview === 1 ? ' is' : 's are'} waiting for
            your decision. <Link to="/app">Open the review queue →</Link>
          </p>
        )}

        <p className="rv-note">
          Team membership is set by a super administrator. Ask them to add or move someone.
        </p>
      </div>
    </>
  );
}
