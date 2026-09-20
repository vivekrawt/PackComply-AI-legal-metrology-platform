import React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api, REVIEW_META, ROLE_META,
  type AdminRow, type AuditorRow, type AuditorPeriods, type DecisionStats, type ScanStats, type Team,
} from '../api';
import { AuthContext } from '../App';
import { Avatar, ErrorText, Modal, useAsync } from '../components/common';
import { IconEye, IconPause, IconPlus, IconTrash } from '../components/icons';
import {
  MagnitudeBar, PeriodPanel, RowMenu, StatTiles, StatusChip, fmtDay, scanStatTiles,
} from './widgets';

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

// Everything that can be done to a person, folded into one control per row.
// Suspension and deletion are consequential enough that each states its effect
// before it happens; deletion additionally keeps the row, because the audit log
// references this person and accountability has to outlive the account.
function PersonActions({ person, run, canDelete, profileHref, onDeleted }: {
  person: { id: string; name: string; email: string; status: string };
  run: (fn: () => Promise<unknown>) => () => Promise<void>;
  canDelete: boolean;
  profileHref: string;
  onDeleted?: () => void;
}) {
  return (
    <RowMenu label={`Actions for ${person.name}`}>
      <Link to={profileHref}><IconEye />View profile</Link>
      {person.status === 'active' ? (
        <button onClick={run(() => api.patch(`/admin/users/${person.id}`, { status: 'suspended' }))}
          title="Signs them out immediately and blocks sign-in until reactivated">
          <IconPause />Suspend access
        </button>
      ) : person.status !== 'offboarded' ? (
        <button onClick={run(() => api.patch(`/admin/users/${person.id}`, { status: 'active' }))}>
          <IconPause />Restore access
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
        })}><IconTrash size={15} />Delete account</button>
      )}
    </RowMenu>
  );
}

function CreatePersonModal({ role, teams, onClose, onDone }: {
  role: 'user' | 'admin'; teams: Team[]; onClose: () => void; onDone: () => void;
}) {
  const blank = { email: '', name: '', password: '', teamId: teams[0]?.id ?? '', state: '', district: '' };
  const [f, setF] = React.useState(blank);
  const [error, setError] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState(false);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault(); setError(null); setBusy(true);
    try {
      await api.post('/admin/users', {
        email: f.email, name: f.name, password: f.password, role,
        teamId: f.teamId || null,
        state: f.state || undefined, district: f.district || undefined,
      });
      setF(blank); onDone();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <Modal
      title={role === 'admin' ? 'Add admin' : 'Add auditor'}
      blurb={role === 'admin'
        ? 'Reviews the work captured by their assigned team.'
        : 'Captures and checks packages in the field. Their scans reach the queue of whichever admin runs their team.'}
      onClose={onClose}
      footer={
        <>
          <button className="quiet" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !f.teamId || !f.name || !f.email || f.password.length < 10}
            onClick={() => submit()}>
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </>
      }
    >
      <form onSubmit={submit}>
        <label className="field">Name
          <input required autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <label className="field">E-mail
          <input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </label>
        <label className="field">Password
          <input type="password" required minLength={10} value={f.password}
            onChange={(e) => setF({ ...f, password: e.target.value })} />
          <span className="hint">At least 10 characters</span>
        </label>
        <label className="field">Team
          <select value={f.teamId} onChange={(e) => setF({ ...f, teamId: e.target.value })}>
            {teams.length === 0 && <option value="">No teams yet — create one first</option>}
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <div className="rv-form-grid">
          <label className="field">State <span className="optional">(optional)</span>
            <input value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} />
          </label>
          <label className="field">District <span className="optional">(optional)</span>
            <input value={f.district} onChange={(e) => setF({ ...f, district: e.target.value })} />
          </label>
        </div>
        <ErrorText error={error} />
      </form>
    </Modal>
  );
}

// The head of a profile screen: who, under what authority, and what may be done
// to the account — all before a single number about their work.
function ProfileHead({ person, crumb, crumbHref, subtitle, actions }: {
  person: { name: string; email: string; status: string; role?: string };
  crumb: string; crumbHref: string; subtitle: React.ReactNode; actions?: React.ReactNode;
}) {
  return (
    <header className="rv-head">
      <div style={{ flex: 1, minWidth: 280 }}>
        <nav className="rv-crumbs" aria-label="Breadcrumb">
          <Link to={crumbHref}>{crumb}</Link>
          <span className="sep" aria-hidden="true">/</span>
          <span>{person.name}</span>
        </nav>
        <div className="rv-profile">
          <Avatar name={person.name} large />
          <div className="rv-profile-text">
            <h1>{person.name}</h1>
            <p><StatusChip status={person.status} /></p>
            <p>{subtitle}</p>
          </div>
        </div>
      </div>
      {actions && <div className="rv-head-actions">{actions}</div>}
    </header>
  );
}

// ---- Auditors ---------------------------------------------------------------
export function AuditorsList() {
  const nav = useNavigate();
  const { can } = React.useContext(AuthContext);
  const list = useAsync(() => api.get<{ auditors: AuditorRow[] }>('/performance/auditors'), []);
  const teams = useAsync(() => api.get<{ teams: Team[] }>('/teams'), []);
  const [adding, setAdding] = React.useState(false);
  const [q, setQ] = React.useState('');
  const { error, run } = useLifecycle(list.reload);

  const all = list.data?.auditors ?? [];
  const needle = q.trim().toLowerCase();
  const rows = all.filter((a) => !needle
    || [a.name, a.email, a.teamName].some((v) => v?.toLowerCase().includes(needle)));
  const max = Math.max(...all.map((a) => a.stats.total), 1);
  const mayAdmin = can('admin.users');

  return (
    <>
      <header className="rv-head">
        <div>
          <h1>Auditors</h1>
          <p>Field officers who capture and check packages.</p>
        </div>
        {mayAdmin && (
          <div className="rv-head-actions">
            <button className="primary" onClick={() => setAdding(true)}><IconPlus />Add auditor</button>
          </div>
        )}
      </header>

      <div className="rv-body">
        <ErrorText error={list.error} />
        <ErrorText error={error} />

        <div className="rv-toolbar">
          <span className="muted">{all.length} auditor{all.length === 1 ? '' : 's'}</span>
          <div className="search-field">
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search auditors…" aria-label="Search auditors" />
          </div>
        </div>

        {all.length === 0 && !list.loading && (
          <div className="rv-empty">
            <div><b>No auditors yet</b><p>Add one and assign them to a team.</p></div>
          </div>
        )}

        {rows.length > 0 && (
          <div className="table-wrap">
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Name</th><th>Team</th><th>Status</th>
                    <th className="num">Cases</th><th className="num">In progress</th>
                    <th className="num">Accepted</th>
                    {mayAdmin && <th>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id} className="clickable" onClick={() => nav(`/app/auditors/${a.id}`)}>
                      <td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                          <Avatar name={a.name} />
                          <span>
                            <Link className="row-link" to={`/app/auditors/${a.id}`} onClick={(e) => e.stopPropagation()}>
                              {a.name}
                            </Link>
                            <span className="cell-sub">{a.email}</span>
                          </span>
                        </span>
                        <MagnitudeBar value={a.stats.total} max={max} />
                      </td>
                      <td className="muted">{a.teamName ?? 'No team'}</td>
                      <td><StatusChip status={a.status} /></td>
                      <td className="num">{a.stats.total}</td>
                      <td className="num">{a.stats.inProgress}</td>
                      <td className="num">{a.stats.accepted}</td>
                      {mayAdmin && (
                        <td>
                          <PersonActions person={a} run={run} canDelete={can('admin.users.delete')}
                            profileHref={`/app/auditors/${a.id}`} />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <p className="note-line left">Open a profile to see daily, weekly and monthly activity.</p>
      </div>

      {adding && mayAdmin && (
        <CreatePersonModal role="user" teams={teams.data?.teams ?? []}
          onClose={() => setAdding(false)}
          onDone={() => { setAdding(false); list.reload(); }} />
      )}
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
  const { can, user } = React.useContext(AuthContext);
  const d = useAsync(() => api.get<AuditorDetailData>(`/performance/auditors/${id}`), [id]);
  const { error, run } = useLifecycle(d.reload);

  if (!d.data) {
    return <div className="rv-body"><ErrorText error={d.error} />{!d.error && <p className="muted">Loading…</p>}</div>;
  }
  const { person, stats, periods, recent } = d.data;
  // An admin reaches an auditor through their own team; a super administrator
  // through the directory. The crumb should lead back the way they came.
  const viaTeam = user?.role === 'admin';

  return (
    <>
      <ProfileHead
        person={person}
        crumb={viaTeam ? 'My team' : 'Auditors'}
        crumbHref={viaTeam ? '/app/my-team' : '/app/auditors'}
        subtitle={<>
          {ROLE_META.user.short} · {person.teamName ?? 'no team'}
          {person.scope ? ` · ${person.scope}` : ''}
        </>}
        actions={can('admin.users') && (
          <PersonActions person={person} run={run} canDelete={can('admin.users.delete')}
            profileHref={`/app/auditors/${person.id}`} onDeleted={() => nav('/app/auditors')} />
        )}
      />

      <div className="rv-body">
        <ErrorText error={error} />

        <PeriodPanel periods={periods} />
        <p className="muted" style={{ marginTop: -14 }}>
          {stats.total} total case{stats.total === 1 ? '' : 's'} · {stats.inProgress} in progress ·{' '}
          {stats.awaitingReview} awaiting review
        </p>

        <h2 className="rv-section-title">Recent cases</h2>
        {recent.length === 0 ? (
          <div className="rv-empty"><div><b>Nothing captured yet</b><p>This auditor has not captured a package.</p></div></div>
        ) : (
          <div className="table-wrap">
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr><th>Product</th><th>Decision</th><th>Date</th><th className="go"><span className="sr-only">Open</span></th></tr>
                </thead>
                <tbody>
                  {recent.map((r) => {
                    const dec = r.decision ? REVIEW_META[r.decision as keyof typeof REVIEW_META] : null;
                    return (
                      <tr key={r.scanId} className="clickable" onClick={() => nav(`/app/scan/${r.scanId}`)}>
                        <td>
                          <Link className="row-link" to={`/app/scan/${r.scanId}`} onClick={(e) => e.stopPropagation()}>
                            {r.product ?? 'Unnamed product'}
                          </Link>
                        </td>
                        <td>
                          {dec
                            ? <span className={`chip ${dec.tone}`}><span className="ico" aria-hidden="true">{dec.icon}</span>{dec.label}</span>
                            : <span className="chip needs_review"><span className="ico" aria-hidden="true">●</span>Awaiting review</span>}
                        </td>
                        <td>{fmtDay(r.createdAt)}</td>
                        <td className="go" />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <p className="rv-note">
          These counts describe workload, not quality. Whether a rejected case reflects a careless
          capture or a genuinely unreadable package is a question for the evidence, which each case
          above links to.
        </p>
      </div>
    </>
  );
}

// ---- Admins -----------------------------------------------------------------
export function AdminsList() {
  const nav = useNavigate();
  const { can } = React.useContext(AuthContext);
  const list = useAsync(() => api.get<{ admins: AdminRow[] }>('/performance/admins'), []);
  const teams = useAsync(() => api.get<{ teams: Team[] }>('/teams'), []);
  const [adding, setAdding] = React.useState(false);
  const [q, setQ] = React.useState('');
  const { error, run } = useLifecycle(list.reload);

  const all = list.data?.admins ?? [];
  const needle = q.trim().toLowerCase();
  const rows = all.filter((a) => !needle
    || [a.name, a.email, a.teamName].some((v) => v?.toLowerCase().includes(needle)));
  const max = Math.max(...all.map((a) => a.decisions.decisions), 1);

  return (
    <>
      <header className="rv-head">
        <div>
          <h1>Admins</h1>
          <p>Reviewers responsible for their team&rsquo;s work.</p>
        </div>
        <div className="rv-head-actions">
          <button className="primary" onClick={() => setAdding(true)}><IconPlus />Add admin</button>
        </div>
      </header>

      <div className="rv-body">
        <ErrorText error={list.error} />
        <ErrorText error={error} />

        <div className="rv-toolbar">
          <span className="muted">{all.length} admin{all.length === 1 ? '' : 's'}</span>
          <div className="search-field">
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search admins…" aria-label="Search admins" />
          </div>
        </div>

        {all.length === 0 && !list.loading && (
          <div className="rv-empty">
            <div><b>No admins yet</b><p>Without one, no team&rsquo;s work gets reviewed.</p></div>
          </div>
        )}

        {rows.length > 0 && (
          <div className="table-wrap">
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Name</th><th>Team</th><th>Status</th>
                    <th className="num">Decisions</th><th className="num">In queue</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id} className="clickable" onClick={() => nav(`/app/admins/${a.id}`)}>
                      <td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                          <Avatar name={a.name} />
                          <span>
                            <Link className="row-link" to={`/app/admins/${a.id}`} onClick={(e) => e.stopPropagation()}>
                              {a.name}
                            </Link>
                            <span className="cell-sub">{a.email}</span>
                          </span>
                        </span>
                        <MagnitudeBar value={a.decisions.decisions} max={max} />
                      </td>
                      <td className="muted">
                        {a.teamName ?? 'No team'}
                        <span className="cell-sub">{a.teamSize} auditor{a.teamSize === 1 ? '' : 's'}</span>
                      </td>
                      <td><StatusChip status={a.status} /></td>
                      <td className="num">{a.decisions.decisions}</td>
                      <td className="num">{a.queueAwaiting}</td>
                      <td>
                        <PersonActions person={a} run={run} canDelete={can('admin.users.delete')}
                          profileHref={`/app/admins/${a.id}`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {adding && (
        <CreatePersonModal role="admin" teams={teams.data?.teams ?? []}
          onClose={() => setAdding(false)}
          onDone={() => { setAdding(false); list.reload(); }} />
      )}
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
      <ProfileHead
        person={person}
        crumb="Admins" crumbHref="/app/admins"
        subtitle={<>
          {person.email} ·{' '}
          {person.teamId
            ? <Link to={`/app/teams/${person.teamId}`}>{person.teamName}</Link>
            : 'no team — this admin has no queue'}
        </>}
        actions={can('admin.users') && (
          <PersonActions person={person} run={run} canDelete={can('admin.users.delete')}
            profileHref={`/app/admins/${person.id}`} onDeleted={() => nav('/app/admins')} />
        )}
      />

      <div className="rv-body">
        <ErrorText error={error} />

        <h2 className="rv-section-title">Decisions taken</h2>
        <StatTiles tiles={[
          { label: 'Decisions', value: decisions.decisions },
          { label: 'Accepted', value: decisions.accepted, tone: 'ok' },
          { label: 'Rejected', value: decisions.rejected, tone: 'bad' },
          { label: 'Sent back', value: decisions.sentBack, tone: 'warn' },
          { label: 'Last decision', value: fmtDay(decisions.lastDecisionAt) },
        ]} />

        <div className="rv-two-col">
          <section className="rv-panel">
            <h2>Team casework</h2>
            <StatTiles plain tiles={scanStatTiles(teamStats).slice(0, 3)} />
          </section>

          <section className="rv-panel">
            <h2>Auditors on this team <span className="check-count">{teamMembers.length}</span></h2>
            {teamMembers.length === 0 ? (
              <p className="muted">Nobody reports to this admin yet.</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Name</th><th>Status</th></tr></thead>
                  <tbody>
                    {teamMembers.map((m) => (
                      <tr key={m.id}>
                        <td>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                            <Avatar name={m.name} />
                            <Link to={`/app/auditors/${m.id}`}>{m.name}</Link>
                          </span>
                        </td>
                        <td><StatusChip status={m.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {coAdmins.length > 0 && (
              <>
                <h3 style={{ marginTop: 16 }}>Sharing the team with</h3>
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
        </div>

        <h2 className="rv-section-title">Recent decisions</h2>
        {recent.length === 0 ? (
          <div className="rv-empty"><div><b>No decisions yet</b><p>Nothing has been signed off by this admin.</p></div></div>
        ) : (
          <div className="table-wrap">
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr><th>Product</th><th>Decision</th><th>Date</th><th className="go"><span className="sr-only">Open</span></th></tr>
                </thead>
                <tbody>
                  {recent.map((r) => {
                    const m = REVIEW_META[r.decision as keyof typeof REVIEW_META];
                    return (
                      <tr key={`${r.scanId}-${r.createdAt}`} className="clickable" onClick={() => nav(`/app/scan/${r.scanId}`)}>
                        <td>
                          <Link className="row-link" to={`/app/scan/${r.scanId}`} onClick={(e) => e.stopPropagation()}>
                            {r.product ?? 'a scan'}
                          </Link>
                          <span className="cell-sub">&ldquo;{r.reason}&rdquo;</span>
                        </td>
                        <td>
                          {m
                            ? <span className={`chip ${m.tone}`}><span className="ico" aria-hidden="true">{m.icon}</span>{m.label}</span>
                            : r.decision}
                        </td>
                        <td>{fmtDay(r.createdAt)}</td>
                        <td className="go" />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
