import React from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, ROLE_META, type AttentionCase, type ScanSummary, type User } from '../api';
import { AuthContext } from '../App';
import { WhoBadge } from '../components/common';
import {
  IconArrowUpRight, IconBook, IconChain, IconCheckSquare, IconGrid, IconPeople,
  IconPerson, IconQueue, IconSignOut, IconTarget, IconTrash, ShieldMark,
} from '../components/icons';
import { ReviewQueue } from './ReviewQueue';
import { ScanReview } from './ScanReview';
import { SuperDashboard } from './SuperDashboard';
import { AttentionPage } from './AttentionPage';
import { TeamsList, TeamDetail } from './TeamsPage';
import { AdminsList, AdminDetail, AuditorsList, AuditorDetail } from './PeoplePage';
import { MyTeam } from './MyTeam';
import { AuditLog } from '../pages/AuditLog';
import { RuleLibrary } from '../pages/RuleLibrary';
import { Trash } from '../pages/Trash';

// Two consoles behind one shell, because the two roles do genuinely different jobs:
//
//   admin        reviews its own team's work. Its landing page is the queue, because
//                the queue is the job. It sees its team, and nothing outside it.
//   super_admin  runs the organization. Its landing page is performance across every
//                team, admin and auditor — not a list of individual scans, which
//                belong to the admins. It can still reach any case, and the cases
//                that specifically need it are gathered under "Referred to you".
//
// Neither console carries the capture surface: no new inspection, no upload, no
// camera, no calibration, no declaration editing. That is the auditor's work, and
// since the permission matrix refuses all of it to both roles, offering it here
// would only be a button that returns 403.

export function ReviewShell({ user, demo, mockComponents }: {
  user: User; demo: boolean; mockComponents: string[];
}) {
  const nav = useNavigate();
  const { refresh, can } = React.useContext(AuthContext);
  const isSuper = user.role === 'super_admin';
  const [badge, setBadge] = React.useState<number | null>(null);
  const logout = async () => { await api.post('/auth/logout'); refresh(); nav('/'); };

  // The one number each role opens the app to find out: for an admin, how much work
  // is waiting; for a super administrator, how much needs them specifically.
  React.useEffect(() => {
    let alive = true;
    const tick = () => {
      const p = isSuper
        ? api.get<{ cases: AttentionCase[] }>('/performance/attention').then((r) => r.cases.length)
        : api.get<{ scans: ScanSummary[] }>('/scans?limit=200')
          .then((r) => r.scans.filter((s) => s.verdict && s.submittedAt && !s.review).length);
      p.then((n) => { if (alive) setBadge(n); }).catch(() => { /* the rail shows no count */ });
    };
    tick();
    const t = setInterval(tick, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [isSuper]);

  const count = (n: number | null) =>
    (n != null && n > 0 ? <span className="rv-count">{n}</span> : null);
  const ico = (node: React.ReactNode) => <span className="rv-nav-ico">{node}</span>;

  return (
    <div className="rv-app">
      <nav className="rv-rail" aria-label="Main navigation">
        <NavLink to="/app" className="rv-brand" end>
          <span className="pc-mark"><ShieldMark /></span>
          <b>PackComply</b>
        </NavLink>
        <div className="rv-role">{isSuper ? 'Super administrator' : 'Reviewer'}</div>

        {isSuper ? (
          <>
            <div className="rv-nav">
              <NavLink to="/app" end>{ico(<IconTarget />)}Overview</NavLink>
              <NavLink to="/app/attention">{ico(<IconArrowUpRight />)}Referred to you{count(badge)}</NavLink>
              <NavLink to="/app/all-scans">{ico(<IconQueue />)}All scans</NavLink>
              <NavLink to="/app/teams">{ico(<IconPeople />)}Teams</NavLink>
              <NavLink to="/app/admins">{ico(<IconPerson />)}Admins</NavLink>
              <NavLink to="/app/auditors">{ico(<IconPeople />)}Auditors</NavLink>
            </div>
          </>
        ) : (
          <div className="rv-nav">
            <NavLink to="/app" end>{ico(<IconQueue />)}Review queue{count(badge)}</NavLink>
            <NavLink to="/app/signed-off">{ico(<IconCheckSquare />)}Signed off</NavLink>
            <NavLink to="/app/my-team">{ico(<IconPeople />)}My team</NavLink>
          </div>
        )}

        <div className="rv-section">Governance</div>
        <div className="rv-nav">
          {can('rule.read') && <NavLink to="/app/rules">{ico(<IconBook />)}Rule library</NavLink>}
          {can('inspection.delete') && <NavLink to="/app/deleted">{ico(<IconTrash />)}Deleted records</NavLink>}
          {can('audit.read') && <NavLink to="/app/audit">{ico(<IconChain />)}Audit trail</NavLink>}
        </div>

        <div className="rv-spacer" />
        <div className="rv-who">
          <WhoBadge name={user.name} role={ROLE_META[user.role]?.short ?? user.role} email={user.email} />
          <button className="rv-signout" onClick={logout}><IconSignOut />Sign out</button>
        </div>
      </nav>

      <div className="rv-main">
        {demo && (
          <div className="demo-banner" role="note">
            Demo environment · {mockComponents.length ? mockComponents.join(', ') : 'some processing'} uses
            simulated providers — these outputs are deterministic mocks, not production AI.
          </div>
        )}
        <Routes>
          <Route index element={isSuper ? <SuperDashboard /> : <ReviewQueue mode="queue" />} />
          <Route path="attention" element={<AttentionPage />} />
          <Route path="all-scans" element={<ReviewQueue mode="all" />} />
          <Route path="signed-off" element={<ReviewQueue mode="signed" />} />
          <Route path="my-team" element={<MyTeam />} />
          <Route path="teams" element={<TeamsList />} />
          <Route path="teams/:id" element={<TeamDetail />} />
          <Route path="admins" element={<AdminsList />} />
          <Route path="admins/:id" element={<AdminDetail />} />
          <Route path="auditors" element={<AuditorsList />} />
          <Route path="auditors/:id" element={<AuditorDetail />} />
          <Route path="scan/:id" element={<ScanReview />} />
          <Route path="audit" element={<AuditLog />} />
          <Route path="rules" element={<RuleLibrary />} />
          <Route path="deleted" element={<Trash />} />
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
      </div>
    </div>
  );
}
