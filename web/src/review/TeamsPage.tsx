import React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type ScanStats, type TeamRow } from '../api';
import { AuthContext } from '../App';
import { ErrorText, useAsync } from '../components/common';
import { MagnitudeBar, StatTiles, StatusChip, scanStatTiles } from './widgets';

// Teams — the unit an admin reviews and an auditor works in.
//
// Membership is the consequential part of this screen: moving someone between
// teams changes whose queue their work lands in, so every control here says what it
// will do before it does it.

export function TeamsList() {
  const { can } = React.useContext(AuthContext);
  const teams = useAsync(() => api.get<{ teams: TeamRow[] }>('/performance/teams'), []);
  const [creating, setCreating] = React.useState(false);
  const [form, setForm] = React.useState({ name: '', description: '' });
  const [error, setError] = React.useState<unknown>(null);
  const rows = teams.data?.teams ?? [];
  const max = Math.max(...rows.map((t) => t.stats.total), 1);
  const mayManage = can('team.manage');

  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
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
          <p>Each team has its own admins, its own auditors and its own queue.</p>
        </div>
        {mayManage && (
          <div className="rv-head-actions">
            <button className="primary" onClick={() => setCreating(!creating)}>
              {creating ? 'Cancel' : '＋ New team'}
            </button>
          </div>
        )}
      </header>

      <div className="rv-body">
        <ErrorText error={teams.error} />

        {creating && mayManage && (
          <form className="rv-panel" onSubmit={create}>
            <h2>New team</h2>
            <label className="field">Name
              <input required value={form.name} maxLength={120}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Nashik Field Team" />
            </label>
            <label className="field">Description <span className="optional">(optional)</span>
              <input value={form.description} maxLength={600}
                onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </label>
            <ErrorText error={error} />
            <button className="primary" disabled={!form.name.trim()}>Create team</button>
          </form>
        )}

        {rows.length === 0 && !teams.loading && (
          <div className="rv-empty">
            <b>No teams yet</b>
            <p>Create a team, then assign an admin and the auditors who report to them.</p>
          </div>
        )}

        <ul className="rv-queue">
          {rows.map((t) => (
            <li key={t.id}>
              <Link to={`/app/teams/${t.id}`} className="rv-row">
                <span className="rv-row-main">
                  <b>{t.name}</b>
                  <span className="rv-row-meta">
                    <span>{t.adminCount} admin{t.adminCount === 1 ? '' : 's'}</span>
                    <span className="sep">·</span>
                    <span>{t.auditorCount} auditor{t.auditorCount === 1 ? '' : 's'}</span>
                    {t.status === 'archived' && <><span className="sep">·</span><span>archived</span></>}
                  </span>
                  <MagnitudeBar value={t.stats.total} max={max} />
                </span>
                <span className="rv-row-end">
                  {t.adminCount === 0 && t.status === 'active' && (
                    <span className="rv-badge rejected" title="Nothing in this team will be reviewed">
                      ! No admin
                    </span>
                  )}
                  <span className="rv-mini-stats">
                    <span><b>{t.stats.total}</b> cases</span>
                    <span><b>{t.stats.awaitingReview}</b> awaiting</span>
                  </span>
                  <span className="rv-row-go" aria-hidden="true">→</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
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
          <button className="rv-back" onClick={() => nav('/app/teams')}>← Teams</button>
          <h1>{d.team.name}</h1>
          <p>
            {d.team.description || 'No description.'}
            {d.team.status === 'archived' && ' · archived'}
          </p>
        </div>
        {mayManage && (
          <div className="rv-head-actions">
            <button className="secondary" onClick={() => setEditing(!editing)}>
              {editing ? 'Cancel' : '✎ Rename'}
            </button>
            {d.team.status === 'active' ? (
              <button className="danger" onClick={act(async () => {
                if (!window.confirm(
                  `Archive "${d.team.name}"?\n\nIt must have no members. Archived teams keep their `
                  + 'casework and history; they simply stop receiving new work.',
                )) return;
                await api.patch(`/teams/${id}`, { status: 'archived' });
              })}>Archive</button>
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

        {editing && mayManage && (
          <form className="rv-panel" onSubmit={(e) => { e.preventDefault(); act(async () => {
            await api.patch(`/teams/${id}`, { name: form.name, description: form.description });
            setEditing(false);
          })(); }}>
            <label className="field">Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="field">Description<input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
            <button className="primary">Save</button>
          </form>
        )}

        <StatTiles tiles={scanStatTiles(d.stats)} />

        <div className="rv-two-col">
          <MemberPanel
            title="Admin"
            blurb="One per team — they review everything this team captures."
            people={d.admins}
            emptyWarning="Nothing this team captures will be reviewed until it has an admin."
            mayManage={mayManage}
            onRemove={(uid) => act(() => api.del(`/teams/${id}/members/${uid}`))()}
            linkBase="/app/admins"
          />
          <MemberPanel
            title="Auditors"
            blurb="They capture and check packages in the field."
            people={d.auditors}
            mayManage={mayManage}
            onRemove={(uid) => act(() => api.del(`/teams/${id}/members/${uid}`))()}
            linkBase="/app/auditors"
          />
        </div>

        {mayManage && (
          <section className="rv-panel">
            <h2>Add someone to this team</h2>
            <p className="muted rv-sub">
              Moving a person here changes whose queue their work reaches. Their existing cases
              stay with the team that owned them. A team takes one admin — move the sitting one
              off first to replace them.
            </p>
            <div className="btn-row">
              <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Person to add">
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

        <p className="rv-note">
          Compliance rules assigned per team are a planned capability — today every team is
          assessed against the same published rule set.
        </p>
      </div>
    </>
  );
}

function MemberPanel({ title, blurb, people, mayManage, onRemove, linkBase, emptyWarning }: {
  title: string; blurb: string; people: any[]; mayManage: boolean;
  onRemove: (id: string) => void; linkBase: string; emptyWarning?: string;
}) {
  return (
    <section className="rv-panel">
      <h2>{title} <span className="check-count">{people.length}</span></h2>
      <p className="muted rv-sub">{blurb}</p>
      {people.length === 0 && (
        emptyWarning
          ? <p className="warn-box">{emptyWarning}</p>
          : <p className="muted">Nobody yet.</p>
      )}
      <ul className="rv-people">
        {people.map((p) => (
          <li key={p.id}>
            <Link to={`${linkBase}/${p.id}`}>
              <b>{p.name}</b>
              <small>{p.email}</small>
            </Link>
            <StatusChip status={p.status} />
            {mayManage && (
              <button className="quiet" onClick={() => onRemove(p.id)}
                title="Remove from this team; they keep their account but land in no queue">
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
