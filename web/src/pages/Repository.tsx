import React from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Section } from '../components/common';

export function Repository() {
  const [q, setQ] = React.useState('');
  const [result, setResult] = React.useState<any>(null);
  const [busy, setBusy] = React.useState(false);
  const [history, setHistory] = React.useState<any>(null);

  const search = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    try { setResult(await api.get(`/search?q=${encodeURIComponent(q)}`)); } finally { setBusy(false); }
  };
  const loadHistory = async (gtin?: string, brand?: string) => {
    const p = new URLSearchParams(); if (gtin) p.set('gtin', gtin); if (brand) p.set('brand', brand);
    setHistory(await api.get(`/products/history?${p}`));
  };

  return (
    <>
      <div className="topbar"><h1>Repository & search</h1></div>
      <div className="content">
        <Section title="Full-text search (OCR text, declarations, products, entities — scope-enforced)">
          <form className="btn-row" onSubmit={search}>
            <input style={{ flex: 1, minWidth: 240, padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 6 }}
              value={q} onChange={(e) => setQ(e.target.value)} placeholder="brand, GTIN, declaration text, location…" aria-label="Search query" />
            <button className="primary" disabled={busy}>Search</button>
            {result && <span className="muted">{result.results.length} result(s) in {result.tookMs} ms</span>}
          </form>
          {result && (
            <table className="data" style={{ marginTop: 10 }}>
              <thead><tr><th>Inspection</th><th>Product</th><th>Status</th><th>Event date</th><th>Match</th><th>History</th></tr></thead>
              <tbody>
                {result.results.map((r: any) => (
                  <tr key={r.inspectionId}>
                    <td><Link className="mono" to={`/app/inspections/${r.inspectionId}`}>{r.inspectionId.slice(0, 18)}…</Link></td>
                    <td>{[r.brand, r.genericName].filter(Boolean).join(' — ') || '—'}</td>
                    <td><span className="chip neutral">{r.status}</span></td>
                    <td>{r.eventDate}</td>
                    <td className="muted">…{r.snippet}…</td>
                    <td>{(r.gtin || r.brand) && <button className="quiet" onClick={() => loadHistory(r.gtin, r.brand)}>timeline</button>}</td>
                  </tr>
                ))}
                {result.results.length === 0 && <tr><td colSpan={6} className="muted">No matches within your authorized scope.</td></tr>}
              </tbody>
            </table>
          )}
        </Section>

        {history && (
          <Section title="Product / entity history">
            <table className="data">
              <thead><tr><th>Inspection</th><th>Type</th><th>Status</th><th>Event date</th><th>Failed findings</th></tr></thead>
              <tbody>{history.history.map((h: any) => (
                <tr key={h.id}>
                  <td><Link className="mono" to={`/app/inspections/${h.id}`}>{h.id.slice(0, 18)}…</Link></td>
                  <td>{h.type}</td><td><span className="chip neutral">{h.status}</span></td>
                  <td>{h.event_date}</td>
                  <td>{h.failed_findings > 0 ? <span className="chip failed"><span className="ico">✕</span>{h.failed_findings}</span> : <span className="chip passed"><span className="ico">✓</span>0</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </Section>
        )}
      </div>
    </>
  );
}
