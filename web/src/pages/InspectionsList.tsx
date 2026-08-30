import React from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Section, useAsync } from '../components/common';

export function InspectionsList() {
  const [status, setStatus] = React.useState('');
  const [type, setType] = React.useState('');
  const [q, setQ] = React.useState('');
  const list = useAsync(
    () => api.get<any>(`/inspections?${new URLSearchParams({ ...(status && { status }), ...(type && { type }), ...(q && { q }) })}`),
    [status, type, q],
  );
  return (
    <>
      <div className="topbar"><h1>Inspections</h1></div>
      <div className="content">
        <Section title="Queue" actions={<Link to="/app/inspections/new" className="btn primary">＋ New inspection</Link>}>
          <div className="btn-row" style={{ marginBottom: 12 }}>
            <label className="field" style={{ margin: 0 }}>Status
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">all</option>
                {['draft', 'capturing', 'processing', 'review', 'pending_approval', 'finalized', 'closed'].map((s) => <option key={s}>{s}</option>)}
              </select>
            </label>
            <label className="field" style={{ margin: 0 }}>Type
              <select value={type} onChange={(e) => setType(e.target.value)}>
                <option value="">all</option>
                {['physical_retail', 'warehouse_import', 'back_office', 'complaint', 'ecommerce'].map((s) => <option key={s}>{s}</option>)}
              </select>
            </label>
            <label className="field" style={{ margin: 0 }}>Search
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ID or location" />
            </label>
          </div>
          <table className="data">
            <thead><tr><th>ID</th><th>Type</th><th>Product</th><th>Category</th><th>Status</th><th>Event date</th><th>Priority</th></tr></thead>
            <tbody>
              {list.data?.inspections?.map((i: any) => (
                <tr key={i.id}>
                  <td><Link to={`/app/inspections/${i.id}`} className="mono">{i.id.slice(0, 20)}…</Link></td>
                  <td>{i.type}</td>
                  <td>{[i.brand, i.genericName].filter(Boolean).join(' — ') || '—'}</td>
                  <td>{i.category ?? '—'}</td>
                  <td><span className="chip neutral">{i.status}</span></td>
                  <td>{i.eventDate}</td>
                  <td>{i.priority}</td>
                </tr>
              ))}
              {list.data?.inspections?.length === 0 && <tr><td colSpan={7} className="muted">No inspections in scope.</td></tr>}
            </tbody>
          </table>
        </Section>
      </div>
    </>
  );
}
