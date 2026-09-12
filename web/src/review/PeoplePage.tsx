import React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api, REVIEW_META, VERDICT_META,
  type AdminRow, type AuditorRow, type DecisionStats, type ScanStats, type Team,
} from '../api';
import { AuthContext } from '../App';
import { ErrorText, useAsync } from '../components/common';
import type { AuditorPeriods } from '../api';
import { MagnitudeBar, PeriodPanel, StatTiles, StatusChip, fmtWhen, scanStatTiles } from './widgets';

// The people sections: Auditors do the work, Admins review it.
//
// They are separate screens rather than one user table because the two roles are
// measured in different units — an auditor's output is cases captured, an admin's is
// decisions taken — and showing both in one grid would invite comparing numbers that
// do not mean the same thing.

// ---- Shared: create + lifecycle controls ------------------------------------
function useLifecycle(reload: () => void) {
  const [error, setError] = React.useState<unknown>(null);
  const run = (fn: () => Promise<unknown>) => async () => {
    setError(null);
    try { await fn(); reload(); } catch (e) { setError(e); }
  };
  return { error, run, setError };
}

function LifecycleButtons({ person, run, canDelete, onDeleted }: {
  person: { id: string; email: string; status: string };
  run: (fn: () => Promise<unknown>) => () => Promise<void>;
  canDelete: boolean;
  onDeleted?: () => void;
}) {
  return (
    <span className="btn-row">
      {person.status === 'active' ? (
        <button className="quiet" onClick={run(() => api.patch(`/admin/users/${person.id}`, { status: 'suspended' }))}
          title="Signs them out immediately and blocks sign-in until reactivated">
          Suspend
        </button>
      ) : person.status !== 'offboarded' ? (
        <button className="secondary" onClick={run(() => api.patch(`/admin/users/${person.id}`, { status: 'active' }))}>
          Activate
        </button>
      ) : null}
      {canDelete && person.status !== 'offboarded' && (
        <button className="danger" onClick={run(async () => {
          if (!window.confirm(
            `Delete ${person.email}?\n\nThe account is offboarded and signed out immediately. The row is `
            + 'kept (anonymised) because the audit log references this person — accountability for past '
            + 'decisions must survive the deletion.',
          )) return;
          await api.del(`/admin/users/${person.id}`);
          onDeleted?.();
        })}>Delete</button>
      )}
    </span>
  );
}

function CreatePersonForm({ role, teams, onDone }: {
  role: 'user' | 'admin'; teams: Team[]; onDone: () => void;
}) {
  const blank = { email: '', name: '', password: '', teamId: teams[0]?.id ?? '', state: '', district: '' };
  const [f, setF] = React.useState(blank);
  const [error, setError] = React.useState<unknown>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    try {
      await api.post('/admin/users', {
        email: f.email, name: f.name, password: f.password, role,
        teamId: f.teamId || null,
        state: f.state || undefined, district: f.district || undefined,
      });
      setF(blank); onDone();
    } catch (err) { setError(err); }
  };

  return (
    <form className="rv-panel" onSubmit={submit}>
      <h2>Add {role === 'admin' ? 'an admin' : 'an auditor'}</h2>
      <p className="muted rv-sub">
        {role === 'admin'
          ? 'They will review everything their team captures, and nothing outside it.'
          : 'Their scans go to the queue of whichever admin runs their team.'}
      </p>
      <div className="rv-form-grid">
        <label className="field">Name<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field">E-mail<input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        <label className="field">Password <span className="optional">(min 10 characters)</span>
          <input type="password" required minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        </label>
        <label className="field">Team
          <select value={f.teamId} onChange={(e) => setF({ ...f, teamId: e.target.value })}>
            {teams.length === 0 && <option value="">No teams yet — create one first</option>}
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="field">State <span className="optional">(optional)</span>
          <input value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} />
        </label>
        <label className="field">District <span className="optional">(optional)</span>
          <input value={f.district} onChange={(e) => setF({ ...f, district: e.target.value })} />
        </label>
      </div>
      <ErrorText error={error} />
      <button className="primary" disabled={!f.teamId}>Create account</button>
    </form>
  );
}

// ---- Auditors ---------------------------------------------------------------
export function AuditorsList() {
  const { can } = React.useContext(AuthContext);
  const list = useAsync(() => api.get<{ auditors: AuditorRow[] }>('/performance/auditors'), []);
  const teams = useAsync(() => api.get<{ teams: Team[] }>('/teams'), []);
  const [adding, setAdding] = React.useState(false);
  const { error, run } = useLifecycle(list.reload);

  const rows = list.data?.auditors ?? [];
  const max = Math.max(...rows.map((a) => a.stats.total), 1);
  const mayAdmin = can('admin.users');

  return (
    <>
      <header className="rv-head">
        <div>
          <h1>Auditors</h1>
          <p>The field agents who capture and check packages.</p>
        </div>
        {mayAdmin && (
          <div className="rv-head-actions">
            <button className="primary" onClick={() => setAdding(!adding)}>
              {adding ? 'Cancel' : '＋ Add auditor'}
            </button>
          </div>
        )}
      </header>

      <div className="rv-body">
        <ErrorText error={list.error} />
        <ErrorText error={error} />
        {adding && mayAdmin && (
          <CreatePersonForm role="user" teams={teams.data?.teams ?? []}
            onDone={() => { setAdding(false); list.reload(); }} />
        )}

        {rows.length === 0 && !list.loading && (
          <div className="rv-empty"><b>No auditors yet</b><p>Add one and assign them to a team.</p></div>
        )}

        {rows.length > 0 && (
          <section className="rv-panel">
            <div className="rv-scroll">
              <table className="data rv-perf">
                <thead>
                  <tr>
                    <th>Auditor</th><th>Team</th><th>Status</th>
                    <th className="num">Cases</th><th className="num">In progress</th>
                    <th className="num">Accepted</th><th className="num">Rejected</th>
                    <th className="num">Sent back</th>
                    {mayAdmin && <th>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <Link to={`/app/auditors/${a.id}`}><b>{a.name}</b></Link>
                        <div className="muted rv-row-sub">{a.email}</div>
                        <MagnitudeBar value={a.stats.total} max={max} />
                      </td>
                      <td>{a.teamName ?? <span className="muted">no team</span>}</td>
                      <td><StatusChip status={a.status} /></td>
                      <td className="num">{a.stats.total}</td>
                      <td className="num">{a.stats.inProgress}</td>
                      <td className="num">{a.stats.accepted}</td>
                      <td className="num">{a.stats.rejected}</td>
                      <td className="num">{a.stats.sentBack}</td>
                      {mayAdmin && (
                        <td><LifecycleButtons person={a} run={run} canDelete={can('admin.users.delete')} /></td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </>
  );
}

interface AuditorDetailData {
  person: {
    id: string; name: string; email: string; status: string; role: string;
    teamId: string | null; teamName: string | null; scope: string | null; createdAt: string;
  };
  stats: ScanStats;
  periods: AuditorPeriods;
  recent: { scanId: string; createdAt: string; product: string | null; verdict: string | null; decision: string | null }[];
}

export function AuditorDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { can } = React.useContext(AuthContext);
  const d = useAsync(() => api.get<AuditorDetailData>(`/performance/auditors/${id}`), [id]);
  const { error, run } = useLifecycle(d.reload);

  if (!d.data) {
    return <div className="rv-body"><ErrorText error={d.error} />{!d.error && <p className="muted">Loading…</p>}</div>;
  }
  const { person, stats, periods, recent } = d.data;

  return (
    <>
      <header className="rv-head">
        <div>
          <button className="rv-back" onClick={() => nav('/app/auditors')}>← Auditors</button>
          <h1>{person.name}</h1>
          <p>
            {person.email} · {person.teamName ?? 'no team'}
            {person.scope ? ` · ${person.scope}` : ''} · joined {fmtWhen(person.createdAt)}
          </p>
        </div>
        <div className="rv-head-actions">
          <StatusChip status={person.status} />
          {can('admin.users') && (
            <LifecycleButtons person={person} run={run} canDelete={can('admin.users.delete')}
              onDeleted={() => nav('/app/auditors')} />
          )}
        </div>
      </header>

      <div className="rv-body">
        <ErrorText error={error} />

        <h2 className="rv-section-title">Throughput</h2>
        <PeriodPanel periods={periods} />

        <h2 className="rv-section-title">All time</h2>
        <StatTiles tiles={scanStatTiles(stats)} />

        <section className="rv-panel">
          <h2>Recent cases</h2>
          {recent.length === 0 && <p className="muted">This auditor has not captured anything yet.</p>}
          <ul className="rv-queue">
            {recent.map((r) => {
              const v = r.verdict ? VERDICT_META[r.verdict as keyof typeof VERDICT_META] : null;
              const dec = r.decision ? REVIEW_META[r.decision as keyof typeof REVIEW_META] : null;
              return (
                <li key={r.scanId}>
                  <Link to={`/app/scan/${r.scanId}`} className="rv-row">
                    <span className={`chip ${v ? v.tone : 'neutral'}`}>
                      <span className="ico" aria-hidden="true">{v ? v.icon : '·'}</span>
                      {v ? v.label : 'Not analysed'}
                    </span>
                    <span className="rv-row-main">
                      <b>{r.product ?? 'Unnamed product'}</b>
                      <span className="rv-row-meta"><span>{fmtWhen(r.createdAt)}</span></span>
                    </span>
                    <span className="rv-row-end">
                      {dec
                        ? <span className={`rv-badge ${r.decision}`}>{dec.icon} {dec.label}</span>
                        : <span className="rv-badge awaiting">● Awaiting review</span>}
                      <span className="rv-row-go" aria-hidden="true">→</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>

        <p className="rv-note">
          These counts describe workload, not quality. Whether a rejected case reflects a
          careless capture or a genuinely unreadable package is a question for the evidence,
          which each case above links to.
        </p>
      </div>
    </>
  );
}

// ---- Admins -----------------------------------------------------------------
export function AdminsList() {
  const { can } = React.useContext(AuthContext);
  const list = useAsync(() => api.get<{ admins: AdminRow[] }>('/performance/admins'), []);
  const teams = useAsync(() => api.get<{ teams: Team[] }>('/teams'), []);
  const [adding, setAdding] = React.useState(false);
  const { error, run } = useLifecycle(list.reload);

  const rows = list.data?.admins ?? [];
  const max = Math.max(...rows.map((a) => a.decisions.decisions), 1);

  return (
    <>
      <header className="rv-head">
        <div>
          <h1>Admins</h1>
          <p>Team reviewers. Each one signs off the work of their own team only.</p>
        </div>
        <div className="rv-head-actions">
          <button className="primary" onClick={() => setAdding(!adding)}>
            {adding ? 'Cancel' : '＋ Add admin'}
          </button>
        </div>
      </header>

      <div className="rv-body">
        <ErrorText error={list.error} />
        <ErrorText error={error} />
        {adding && (
          <CreatePersonForm role="admin" teams={teams.data?.teams ?? []}
            onDone={() => { setAdding(false); list.reload(); }} />
        )}

        {rows.length === 0 && !list.loading && (
          <div className="rv-empty"><b>No admins yet</b><p>Without one, no team&rsquo;s work gets reviewed.</p></div>
        )}

        {rows.length > 0 && (
          <section className="rv-panel">
            <div className="rv-scroll">
              <table className="data rv-perf">
                <thead>
                  <tr>
                    <th>Admin</th><th>Team</th><th>Status</th>
                    <th className="num">Decisions</th><th className="num">In queue</th>
                    <th className="num">Accepted</th><th className="num">Rejected</th>
                    <th className="num">Sent back</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <Link to={`/app/admins/${a.id}`}><b>{a.name}</b></Link>
                        <div className="muted rv-row-sub">{a.email}</div>
                        <MagnitudeBar value={a.decisions.decisions} max={max} />
                      </td>
                      <td>
                        {a.teamName ?? <span className="muted">no team</span>}
                        <div className="muted rv-row-sub">{a.teamSize} auditor{a.teamSize === 1 ? '' : 's'}</div>
                      </td>
                      <td><StatusChip status={a.status} /></td>
                      <td className="num">{a.decisions.decisions}</td>
                      <td className="num">{a.queueAwaiting}</td>
                      <td className="num">{a.decisions.accepted}</td>
                      <td className="num">{a.decisions.rejected}</td>
                      <td className="num">{a.decisions.sentBack}</td>
                      <td><LifecycleButtons person={a} run={run} canDelete={can('admin.users.delete')} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </>
  );
}

interface AdminDetailData {
  person: {
    id: string; name: string; email: string; status: string; role: string;
    teamId: string | null; teamName: string | null; createdAt: string;
  };
  decisions: DecisionStats;
  teamStats: ScanStats;
  teamMembers: any[];
  coAdmins: any[];
  recent: { scanId: string; decision: string; reason: string; createdAt: string; product: string | null }[];
}

export function AdminDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { can } = React.useContext(AuthContext);
  const d = useAsync(() => api.get<AdminDetailData>(`/performance/admins/${id}`), [id]);
  const { error, run } = useLifecycle(d.reload);

  if (!d.data) {
    return <div className="rv-body"><ErrorText error={d.error} />{!d.error && <p className="muted">Loading…</p>}</div>;
  }
  const { person, decisions, teamStats, teamMembers, coAdmins, recent } = d.data;

  return (
    <>
      <header className="rv-head">
        <div>
          <button className="rv-back" onClick={() => nav('/app/admins')}>← Admins</button>
          <h1>{person.name}</h1>
          <p>
            {person.email} ·{' '}
            {person.teamId
              ? <Link to={`/app/teams/${person.teamId}`}>{person.teamName}</Link>
              : 'no team — this admin has no queue'}
            {' '}· joined {fmtWhen(person.createdAt)}
          </p>
        </div>
        <div className="rv-head-actions">
          <StatusChip status={person.status} />
          {can('admin.users') && (
            <LifecycleButtons person={person} run={run} canDelete={can('admin.users.delete')}
              onDeleted={() => nav('/app/admins')} />
          )}
        </div>
      </header>

      <div className="rv-body">
        <ErrorText error={error} />

        <h2 className="rv-section-title">Decisions taken</h2>
        <StatTiles tiles={[
          { label: 'Decisions', value: decisions.decisions },
          { label: 'Accepted', value: decisions.accepted, tone: 'ok' },
          { label: 'Rejected', value: decisions.rejected, tone: 'bad' },
          { label: 'Sent back', value: decisions.sentBack, tone: 'warn' },
          { label: 'Last decision', value: decisions.lastDecisionAt ? fmtWhen(decisions.lastDecisionAt).split(',')[0] : '—' },
        ]} />

        <h2 className="rv-section-title">Their team&rsquo;s casework</h2>
        <StatTiles tiles={scanStatTiles(teamStats)} />

        <div className="rv-two-col">
          <section className="rv-panel">
            <h2>Auditors under them <span className="check-count">{teamMembers.length}</span></h2>
            {teamMembers.length === 0 && <p className="muted">Nobody reports to this admin yet.</p>}
            <ul className="rv-people">
              {teamMembers.map((m) => (
                <li key={m.id}>
                  <Link to={`/app/auditors/${m.id}`}><b>{m.name}</b><small>{m.email}</small></Link>
                  <StatusChip status={m.status} />
                </li>
              ))}
            </ul>
            {coAdmins.length > 0 && (
              <>
                <h3>Sharing the team with</h3>
                <ul className="rv-people">
                  {coAdmins.map((m) => (
                    <li key={m.id}>
                      <Link to={`/app/admins/${m.id}`}><b>{m.name}</b><small>{m.email}</small></Link>
                      <StatusChip status={m.status} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section className="rv-panel">
            <h2>Recent decisions</h2>
            {recent.length === 0 && <p className="muted">No decisions recorded yet.</p>}
            <ul className="rv-history">
              {recent.map((r) => (
                <li key={`${r.scanId}-${r.createdAt}`} className={r.decision}>
                  <b>{REVIEW_META[r.decision as keyof typeof REVIEW_META]?.label ?? r.decision}</b>{' '}
                  <small>
                    on <Link to={`/app/scan/${r.scanId}`}>{r.product ?? 'a scan'}</Link> · {fmtWhen(r.createdAt)}
                  </small>
                  <p>{r.reason}</p>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </>
  );
}
