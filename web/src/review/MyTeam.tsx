import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
  const nav = useNavigate();
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
            <div>
              <b>You are not assigned to a team</b>
              <p>
                Your review queue will stay empty until a super administrator puts you on one —
                an admin reviews their own team&rsquo;s work, so with no team there is nothing to review.
              </p>
            </div>
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
          <p>{team.description || 'Your team’s casework and field officers.'}</p>
        </div>
      </header>

      <div className="rv-body">
        <StatTiles tiles={scanStatTiles(stats)} />

        <h2 className="rv-section-title">Auditors on your team</h2>

        {auditors.length === 0 ? (
          <p className="warn-box">
            No auditors are assigned to your team yet, so nothing will reach your queue. A super
            administrator assigns them.
          </p>
        ) : (
          <div className="table-wrap">
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Name</th><th>Email</th><th>Status</th><th className="num">Cases</th>
                    <th className="go"><span className="sr-only">Open</span></th>
                  </tr>
                </thead>
                <tbody>
                  {auditors.map((a) => {
                    const s = byId.get(a.id)?.stats;
                    return (
                      <tr key={a.id} className="clickable" onClick={() => nav(`/app/auditors/${a.id}`)}>
                        <td>
                          <Link className="row-link" to={`/app/auditors/${a.id}`} onClick={(e) => e.stopPropagation()}>
                            {a.name}
                          </Link>
                          {s && <MagnitudeBar value={s.total} max={max} />}
                        </td>
                        <td className="muted">{a.email}</td>
                        <td><StatusChip status={a.status} /></td>
                        <td className="num">{s ? `${s.total} case${s.total === 1 ? '' : 's'}` : '—'}</td>
                        <td className="go" />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {stats.awaitingReview > 0 && (
          <p className="warn-box">
            {stats.awaitingReview} case{stats.awaitingReview === 1 ? ' is' : 's are'} waiting for
            your decision. <Link to="/app">Open the review queue</Link>.
          </p>
        )}

        <p className="rv-note">
          Team membership is managed by a super administrator.
        </p>
      </div>
    </>
  );
}
