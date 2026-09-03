import React from 'react';
import { Link } from 'react-router-dom';
import { api, roleLabel } from '../api';
import { AuthContext } from '../App';
import { Section, useAsync, OutcomeChip } from '../components/common';

export function Dashboard() {
  const { user } = React.useContext(AuthContext);
  const overview = useAsync(() => api.get<any>('/dashboards/enforcement'));
  const ops = useAsync(() => api.get<any>('/dashboards/operations'));
  const mine = useAsync(() => api.get<any>('/inspections?assignedTo=me&limit=8'));

  return (
    <>
      <div className="topbar">
        <h1>Dashboard</h1>
        <span className="who">{user?.name} · {user ? roleLabel(user.role) : ''} · {[user?.state, user?.district].filter(Boolean).join(' / ') || 'organization-wide scope'}</span>
      </div>
      <div className="content">
        <div className="grid3">
          <div className="card"><h2>Inspections by status</h2>
            {overview.data?.byStatus?.map((s: any) => (
              <div key={s.status} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="muted">{s.status}</span><b>{s.c}</b>
              </div>
            )) ?? <span className="muted">Loading…</span>}
          </div>
          <div className="card"><h2>Finding outcomes</h2>
            {overview.data?.outcomes?.map((o: any) => (
              <div key={o.outcome} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <OutcomeChip outcome={o.outcome} /><b>{o.c}</b>
              </div>
            )) ?? <span className="muted">Loading…</span>}
            <p className="muted" style={{ marginTop: 8 }}>High-severity failed findings: <b>{overview.data?.highSeverity ?? '–'}</b></p>
          </div>
          <div className="card"><h2>Operations</h2>
            <p className="muted">Overdue: <b>{ops.data?.overdue ?? '–'}</b> · Review backlog: <b>{ops.data?.backlog ?? '–'}</b></p>
            <h3>Processing jobs</h3>
            {ops.data?.jobStats?.map((j: any) => (
              <div key={j.status} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="muted">{j.status}</span><b>{j.c}</b>
              </div>
            )) ?? <span className="muted">–</span>}
          </div>
        </div>

        <Section title="My assigned work" actions={<Link className="btn primary" to="/app/inspections/new">＋ New inspection</Link>}>
          <table className="data">
            <thead><tr><th>ID</th><th>Type</th><th>Product</th><th>Status</th><th>Event date</th><th>Due</th></tr></thead>
            <tbody>
              {mine.data?.inspections?.map((i: any) => (
                <tr key={i.id}>
                  <td><Link to={`/app/inspections/${i.id}`} className="mono">{i.id.slice(0, 18)}…</Link></td>
                  <td>{i.type}</td>
                  <td>{[i.brand, i.genericName].filter(Boolean).join(' — ') || <span className="muted">no product yet</span>}</td>
                  <td><span className="chip neutral">{i.status}</span></td>
                  <td>{i.eventDate}</td>
                  <td>{i.dueDate ?? '—'}</td>
                </tr>
              ))}
              {mine.data?.inspections?.length === 0 && <tr><td colSpan={6} className="muted">Nothing assigned to you.</td></tr>}
            </tbody>
          </table>
        </Section>

        <Section title="Inspections by district (scope-filtered)">
          <table className="data"><tbody>
            {overview.data?.byDistrict?.map((d: any) => (
              <tr key={d.district}><td>{d.district}</td><td style={{ textAlign: 'right' }}><b>{d.c}</b></td></tr>
            ))}
          </tbody></table>
          <p className="muted">Aggregates reconcile with the repository and honor your data scope. Risk indicators prioritize work — they are not proof of a contravention.</p>
        </Section>
      </div>
    </>
  );
}
