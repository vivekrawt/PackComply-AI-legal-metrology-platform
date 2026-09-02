import React from 'react';
import { api, roleLabel } from '../api';
import { AuthContext } from '../App';
import { ErrorText, Section, useAsync } from '../components/common';

// User & role administration (IAM-04). The role catalogue — names, descriptions and
// the permissions each one carries — is fetched from the server so this screen shows
// the matrix the API actually enforces, never a second copy of it.
export function AdminUsers() {
  const { user: me, can } = React.useContext(AuthContext);
  const users = useAsync(() => api.get<any>('/admin/users'));
  const roles = useAsync(() => api.get<any>('/roles'));
  const [error, setError] = React.useState<unknown>(null);
  const [showMatrix, setShowMatrix] = React.useState(false);
  const blank = { email: '', name: '', password: '', role: 'user', state: '', district: '' };
  const [f, setF] = React.useState(blank);

  const roleList: { role: string; label: string; description: string; permissions: string[] }[] =
    roles.data?.roles ?? [];
  const selected = roleList.find((r) => r.role === f.role);

  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    try {
      await api.post('/admin/users', {
        ...f, state: f.state || undefined, district: f.district || undefined,
      });
      setF(blank);
      users.reload();
    } catch (err) { setError(err); }
  };
  const patch = async (id: string, body: any) => {
    setError(null);
    try { await api.patch(`/admin/users/${id}`, body); users.reload(); } catch (err) { setError(err); }
  };
  const remove = async (u: any) => {
    setError(null);
    const ok = window.confirm(
      `Delete ${u.email}?\n\nThe account is offboarded and signed out immediately. The row is retained ` +
      `(anonymised) because the audit log references this officer — accountability for past decisions ` +
      `must survive the deletion.`,
    );
    if (!ok) return;
    try { await api.del(`/admin/users/${u.id}`); users.reload(); } catch (err) { setError(err); }
  };

  return (
    <>
      <div className="topbar"><h1>User &amp; role administration</h1></div>
      <div className="content">
        <Section
          title="Roles"
          actions={<button className="quiet" onClick={() => setShowMatrix(!showMatrix)} aria-expanded={showMatrix}>
            {showMatrix ? 'Hide' : 'Show'} permission matrix
          </button>}
        >
          <div className="grid3">
            {roleList.map((r) => (
              <div key={r.role} className="decl-card">
                <div className="head"><b>{r.label}</b><span className="mono muted">{r.role}</span></div>
                <p style={{ margin: '6px 0' }}>{r.description}</p>
                <p className="muted">{r.permissions.length} permissions</p>
              </div>
            ))}
          </div>
          {showMatrix && (
            <div style={{ overflowX: 'auto' }}>
              <table className="data">
                <thead><tr><th>Permission</th>{roleList.map((r) => <th key={r.role}>{r.role}</th>)}</tr></thead>
                <tbody>
                  {[...new Set(roleList.flatMap((r) => r.permissions))].sort().map((perm) => (
                    <tr key={perm}>
                      <td className="mono">{perm}</td>
                      {roleList.map((r) => (
                        <td key={r.role} style={{ textAlign: 'center' }}>
                          {r.permissions.includes(perm)
                            ? <span className="chip passed"><span className="ico">✓</span></span>
                            : <span className="muted">—</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section title="Create user">
          <form onSubmit={create} className="grid3">
            <label className="field">E-mail<input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
            <label className="field">Name<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label className="field">Password (min 10 chars)<input type="password" required minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
            <label className="field">Role
              <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
                {roleList.map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
              </select>
            </label>
            <label className="field">State scope<input value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} placeholder="(empty = org-wide per role)" /></label>
            <label className="field">District scope<input value={f.district} onChange={(e) => setF({ ...f, district: e.target.value })} /></label>
            <div><button className="primary">Create</button></div>
          </form>
          {selected && <p className="muted">{selected.description}</p>}
          <ErrorText error={error} />
        </Section>

        <Section title="Users">
          <table className="data">
            <thead><tr><th>E-mail</th><th>Name</th><th>Role</th><th>Scope</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {users.data?.users?.map((u: any) => (
                <tr key={u.id}>
                  <td className="mono">{u.email}</td><td>{u.name}</td>
                  <td>
                    <select value={u.role} disabled={u.id === me?.id || u.status === 'offboarded'}
                      onChange={(e) => patch(u.id, { role: e.target.value })}
                      title={u.id === me?.id ? 'You cannot change your own role' : roleLabel(u.role)}>
                      {roleList.map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
                    </select>
                  </td>
                  <td className="muted">{[u.state, u.district, u.office].filter(Boolean).join(' / ') || 'org-wide'}</td>
                  <td><span className={`chip ${u.status === 'active' ? 'passed' : 'not_applicable'}`}><span className="ico">{u.status === 'active' ? '✓' : '—'}</span>{u.status}</span></td>
                  <td className="btn-row">
                    {u.status === 'active'
                      ? <button className="danger" onClick={() => patch(u.id, { status: 'suspended' })}>Suspend</button>
                      : u.status !== 'offboarded'
                        ? <button className="secondary" onClick={() => patch(u.id, { status: 'active' })}>Activate</button>
                        : null}
                    <button className="quiet" onClick={() => api.post(`/admin/users/${u.id}/revoke-sessions`).then(users.reload)}>Revoke sessions</button>
                    {can('admin.users.delete') && u.status !== 'offboarded' && u.id !== me?.id && (
                      <button className="danger" onClick={() => remove(u)}>Delete</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            Segregation of duties: <b>user</b> does the inspection work, <b>admin</b> reviews and signs it off
            without being able to create or alter the record it reviews, and <b>super&nbsp;admin</b> is the only
            role that can delete. Deleting an account offboards it — the row is kept so past decisions in the
            audit log stay attributable.
          </p>
        </Section>
      </div>
    </>
  );
}
