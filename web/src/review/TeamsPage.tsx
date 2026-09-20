import React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type ScanStats, type TeamRow } from '../api';
import { AuthContext } from '../App';
import { Avatar, ErrorText, Modal, useAsync } from '../components/common';
import { IconArchive, IconPencil, IconPlus } from '../components/icons';
import { MagnitudeBar, StatTiles, StatusChip, scanStatTiles } from './widgets';

// Teams — the unit an admin reviews and an auditor works in.
//
// Membership is the consequential part of this screen: moving someone between
// teams changes whose queue their work lands in, so every control here says what it
// will do before it does it.

export function TeamsList() {
  const nav = useNavigate();
  const { can } = React.useContext(AuthContext);
  const teams = useAsync(() => api.get<{ teams: TeamRow[] }>('/performance/teams'), []);
  const [creating, setCreating] = React.useState(false);
  const [form, setForm] = React.useState({ name: '', description: '' });
  const [error, setError] = React.useState<unknown>(null);
  const rows = teams.data?.teams ?? [];
  const max = Math.max(...rows.map((t) => t.stats.total), 1);
  const mayManage = can('team.manage');

  const create = async (e?: React.FormEvent) => {
    e?.preventDefault(); setError(null);
    try {
      await api.post('/teams', { name: form.name, description: form.description || undefined });
      setForm({ name: '', description: '' }); setCreating(false); teams.reload();
    } catch (err) { setError(err); }
  };

  return (
    <>
      <header className="rv-head">
        <div>
          <h1>Teams</h1>
          <p>Manage who captures and reviews each team&rsquo;s work.</p>
        </div>
        {mayManage && (
          <div className="rv-head-actions">
            <button className="primary" onClick={() => setCreating(true)}><IconPlus />New team</button>
          </div>
        )}
      </header>

      <div className="rv-body">
        <ErrorText error={teams.error} />

        {rows.length === 0 && !teams.loading && (
          <div className="rv-empty">
            <div>
              <b>No teams yet</b>
              <p>Create a team, then assign an admin and the auditors who report to them.</p>
            </div>
          </div>
        )}

        {rows.length > 0 && (
          <div className="table-wrap">
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Team</th><th className="num">Admins</th><th className="num">Auditors</th>
                    <th className="num">Cases</th><th className="num">Awaiting</th><th>Status</th>
                    <th className="go"><span className="sr-only">Open</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <tr key={t.id} className="clickable" onClick={() => nav(`/app/teams/${t.id}`)}>
                      <td>
                        <Link className="row-link" to={`/app/teams/${t.id}`} onClick={(e) => e.stopPropagation()}>
                          {t.name}
                        </Link>
                        {/* A team nobody reviews is a team whose work stops here. */}
                        {t.adminCount === 0 && t.status === 'active' && (
                          <span className="cell-sub" style={{ color: 'var(--red-ink)' }}>
                            No admin — nothing this team captures will be reviewed
                          </span>
                        )}
                        <MagnitudeBar value={t.stats.total} max={max} />
                      </td>
                      <td className="num">{t.adminCount}</td>
                      <td className="num">{t.auditorCount}</td>
                      <td className="num">{t.stats.total}</td>
                      <td className="num">{t.stats.awaitingReview}</td>
                      <td>
                        <span className={`chip ${t.status === 'active' ? 'passed' : 'neutral'}`}>
                          <span className="ico" aria-hidden="true">{t.status === 'active' ? '✓' : '—'}</span>
                          {t.status === 'active' ? 'Active' : 'Archived'}
                        </span>
                      </td>
                      <td className="go" />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <p className="note-line left">Each team has one reviewing admin.</p>
      </div>

      {creating && mayManage && (
        <Modal
          title="New team" onClose={() => setCreating(false)}
          footer={
            <>
              <button className="quiet" onClick={() => setCreating(false)}>Cancel</button>
              <button className="primary" disabled={!form.name.trim()} onClick={() => create()}>Create team</button>
            </>
          }
        >
          <form onSubmit={create}>
            <label className="field">Name
              <input required autoFocus value={form.name} maxLength={120}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Team name" />
            </label>
            <label className="field">Description <span className="optional">(optional)</span>
              <textarea value={form.description} maxLength={600}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="What this team covers" />
            </label>
            <ErrorText error={error} />
          </form>
        </Modal>
      )}
    </>
  );
}

interface TeamDetailData {
  team: { id: string; name: string; description: string | null; status: string; createdAt: string };
  stats: ScanStats;
  admins: any[];
  auditors: any[];
}

export function TeamDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { can } = React.useContext(AuthContext);
  const detail = useAsync(() => api.get<TeamDetailData>(`/performance/teams/${id}`), [id]);
  const everyone = useAsync(
    () => (can('admin.users')
      ? api.get<{ users: any[] }>('/admin/users')
      : Promise.resolve({ users: [] })),
    [],
  );
  const [error, setError] = React.useState<unknown>(null);
  const [pick, setPick] = React.useState('');
  const [editing, setEditing] = React.useState(false);
  const [form, setForm] = React.useState({ name: '', description: '' });

  const mayManage = can('team.manage');
  const d = detail.data;

  React.useEffect(() => {
    if (d) setForm({ name: d.team.name, description: d.team.description ?? '' });
  }, [d?.team.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!d) return <div className="rv-body"><ErrorText error={detail.error} />{!detail.error && <p className="muted">Loading…</p>}</div>;

  const act = (fn: () => Promise<unknown>) => async () => {
    setError(null);
    try { await fn(); detail.reload(); everyone.reload(); } catch (e) { setError(e); }
  };

  const outsiders = (everyone.data?.users ?? []).filter(
    (u: any) => u.role !== 'super_admin' && u.team_id !== id && u.status !== 'offboarded',
  );

  return (
    <>
      <header className="rv-head">
        <div>
          <nav className="rv-crumbs" aria-label="Breadcrumb">
            <Link to="/app/teams">Teams</Link>
            <span className="sep" aria-hidden="true">/</span>
            <span>{d.team.name}</span>
          </nav>
          <h1>{d.team.name}</h1>
          <p>
            {d.team.description || 'No description.'}
            {d.team.status === 'archived' && ' · archived'}
          </p>
        </div>
        {mayManage && (
          <div className="rv-head-actions">
            <button className="secondary" onClick={() => setEditing(true)}><IconPencil />Rename</button>
            {d.team.status === 'active' ? (
              <button className="secondary" onClick={act(async () => {
                if (!window.confirm(
                  `Archive "${d.team.name}"?\n\nIt must have no members. Archived teams keep their `
                  + 'casework and history; they simply stop receiving new work.',
                )) return;
                await api.patch(`/teams/${id}`, { status: 'archived' });
              })}><IconArchive />Archive</button>
            ) : (
              <button className="secondary" onClick={act(() => api.patch(`/teams/${id}`, { status: 'active' }))}>
                Reactivate
              </button>
            )}
          </div>
        )}
      </header>

      <div className="rv-body">
        <ErrorText error={error} />

        <StatTiles tiles={scanStatTiles(d.stats)} />

        <h2 className="rv-section-title">Members</h2>
        <MemberTable
          title="Admin" people={d.admins} mayManage={mayManage} linkBase="/app/admins"
          emptyWarning="Nothing this team captures will be reviewed until it has an admin."
          onRemove={(uid) => act(() => api.del(`/teams/${id}/members/${uid}`))()}
        />
        <MemberTable
          title="Auditors" people={d.auditors} mayManage={mayManage} linkBase="/app/auditors"
          onRemove={(uid) => act(() => api.del(`/teams/${id}/members/${uid}`))()}
        />

        {mayManage && (
          <section className="rv-panel">
            <h2>Add someone to this team</h2>
            <p className="muted rv-sub">
              Moving someone changes their future review queue. Existing cases stay with their
              current team.
            </p>
            <div className="btn-row">
              <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Person to add"
                style={{ flex: 1, minWidth: 240, padding: '10px 13px', borderRadius: 8, border: '1px solid var(--line)' }}>
                <option value="">Choose a person…</option>
                {outsiders.map((u: any) => (
                  <option key={u.id} value={u.id}>
                    {u.name} — {u.role === 'admin' ? 'Admin' : 'Auditor'}
                    {u.team_name ? ` (currently ${u.team_name})` : ' (no team)'}
                  </option>
                ))}
              </select>
              <button className="primary" disabled={!pick}
                onClick={act(async () => { await api.post(`/teams/${id}/members`, { userId: pick }); setPick(''); })}>
                Add to team
              </button>
            </div>
            {outsiders.length === 0 && <p className="muted">Everyone in the organization is already on this team.</p>}
          </section>
        )}

        <p className="note-line left">A team can have one admin.</p>
      </div>

      {editing && mayManage && (
        <Modal
          title="Rename team" onClose={() => setEditing(false)}
          footer={
            <>
              <button className="quiet" onClick={() => setEditing(false)}>Cancel</button>
              <button className="primary" onClick={act(async () => {
                await api.patch(`/teams/${id}`, { name: form.name, description: form.description });
                setEditing(false);
              })}>Save</button>
            </>
          }
        >
          <label className="field">Name
            <input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="field">Description <span className="optional">(optional)</span>
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
        </Modal>
      )}
    </>
  );
}

// Members read as a roster, not as a card list: the same four facts about each
// person, in the same four places, whichever role they hold.
function MemberTable({ title, people, mayManage, onRemove, linkBase, emptyWarning }: {
  title: string; people: any[]; mayManage: boolean;
  onRemove: (id: string) => void; linkBase: string; emptyWarning?: string;
}) {
  return (
    <section className="rv-panel">
      <h2>{title} <span className="check-count">{people.length}</span></h2>
      {people.length === 0 ? (
        emptyWarning
          ? <p className="warn-box" style={{ marginBottom: 0 }}>{emptyWarning}</p>
          : <p className="muted">Nobody yet.</p>
      ) : (
        <div className="table-wrap">
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr><th>Name</th><th>Email</th><th>Status</th>{mayManage && <th>Action</th>}</tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                        <Avatar name={p.name} />
                        <Link to={`${linkBase}/${p.id}`}>{p.name}</Link>
                      </span>
                    </td>
                    <td className="muted">{p.email}</td>
                    <td><StatusChip status={p.status} /></td>
                    {mayManage && (
                      <td>
                        <button className="link-btn" onClick={() => onRemove(p.id)}
                          title="Remove from this team; they keep their account but land in no queue">
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
