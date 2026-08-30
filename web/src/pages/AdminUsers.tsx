import React from 'react';
import { api } from '../api';
import { ErrorText, Section, useAsync } from '../components/common';

const ROLES = ['inspector', 'reviewer', 'rule_admin', 'analyst', 'sys_admin', 'auditor'];

export function AdminUsers() {
  const users = useAsync(() => api.get<any>('/admin/users'));
  const [error, setError] = React.useState<unknown>(null);
  const [f, setF] = React.useState({ email: '', name: '', password: '', role: 'inspector', state: '', district: '' });

  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    try {
      await api.post('/admin/users', {
        ...f, state: f.state || undefined, district: f.district || undefined,
      });
      setF({ email: '', name: '', password: '', role: 'inspector', state: '', district: '' });
      users.reload();
    } catch (err) { setError(err); }
  };
  const patch = async (id: string, body: any) => {
    setError(null);
    try { await api.patch(`/admin/users/${id}`, body); users.reload(); } catch (err) { setError(err); }
  };

  return (
    <>
      <div className="topbar"><h1>User & role administration</h1></div>
      <div className="content">
        <Section title="Create user">
          <form onSubmit={create} className="grid3">
            <label className="field">E-mail<input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
            <label className="field">Name<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label className="field">Password (min 10 chars)<input type="password" required minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
            <label className="field">Role<select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></label>
            <label className="field">State scope<input value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} placeholder="(empty = org-wide per role)" /></label>
            <label className="field">District scope<input value={f.district} onChange={(e) => setF({ ...f, district: e.target.value })} /></label>
            <div><button className="primary">Create</button></div>
          </form>
          <ErrorText error={error} />
        </Section>
        <Section title="Users">
          <table className="data">
            <thead><tr><th>E-mail</th><th>Name</th><th>Role</th><th>Scope</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {users.data?.users?.map((u: any) => (
                <tr key={u.id}>
                  <td className="mono">{u.email}</td><td>{u.name}</td><td>{u.role}</td>
                  <td className="muted">{[u.state, u.district, u.office].filter(Boolean).join(' / ') || 'org-wide'}</td>
                  <td><span className={`chip ${u.status === 'active' ? 'passed' : 'not_applicable'}`}><span className="ico">{u.status === 'active' ? '✓' : '—'}</span>{u.status}</span></td>
                  <td className="btn-row">
                    {u.status === 'active'
                      ? <button className="danger" onClick={() => patch(u.id, { status: 'suspended' })}>Suspend</button>
                      : <button className="secondary" onClick={() => patch(u.id, { status: 'active' })}>Activate</button>}
                    <button className="quiet" onClick={() => api.post(`/admin/users/${u.id}/revoke-sessions`).then(users.reload)}>Revoke sessions</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">Note: system administrators manage accounts and configuration but cannot alter inspections, findings or finalized reports (segregation of duties).</p>
        </Section>
      </div>
    </>
  );
}
