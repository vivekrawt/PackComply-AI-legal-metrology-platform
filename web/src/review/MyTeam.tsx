import React from 'react';
import { Link } from 'react-router-dom';
import { api, type ScanStats } from '../api';
import { AuthContext } from '../App';
import { ErrorText, useAsync } from '../components/common';
import { StatTiles, StatusChip, scanStatTiles } from './widgets';

// An admin's view of their own team.
//
// Read-only by design: an admin monitors the auditors under them, but moving people
// between teams changes whose queue work lands in, and that is the super
// administrator's authority. The screen says so rather than showing disabled buttons.

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
    () => (teamId
      ? api.get<TeamDetailData>(`/performance/teams/${teamId}`)
      : Promise.resolve(null)),
    [teamId],
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
  const { team, stats, admins, auditors } = d.data;

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

        <div className="rv-two-col">
          <section className="rv-panel">
            <h2>Auditors on this team <span className="check-count">{auditors.length}</span></h2>
            {auditors.length === 0 && <p className="muted">No auditors are assigned to your team yet.</p>}
            <ul className="rv-people">
              {auditors.map((a) => (
                <li key={a.id}>
                  <span><b>{a.name}</b><small>{a.email}</small></span>
                  <StatusChip status={a.status} />
                </li>
              ))}
            </ul>
          </section>

          <section className="rv-panel">
            <h2>Admins <span className="check-count">{admins.length}</span></h2>
            <ul className="rv-people">
              {admins.map((a) => (
                <li key={a.id}>
                  <span>
                    <b>{a.name}{a.id === user?.id ? ' (you)' : ''}</b>
                    <small>{a.email}</small>
                  </span>
                  <StatusChip status={a.status} />
                </li>
              ))}
            </ul>
            <p className="rv-note">
              Team membership is set by a super administrator. Ask them to add or move someone.
            </p>
          </section>
        </div>

        {stats.awaitingReview > 0 && (
          <p className="warn-box">
            {stats.awaitingReview} case{stats.awaitingReview === 1 ? ' is' : 's are'} waiting for
            your decision. <Link to="/app">Open the review queue →</Link>
          </p>
        )}
      </div>
    </>
  );
}
