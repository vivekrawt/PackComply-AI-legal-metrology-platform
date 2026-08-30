import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { ErrorText, MockBadge, Section, useAsync } from '../components/common';
import { CameraCapture } from '../components/CameraCapture';

const FACES = ['front', 'back', 'side', 'top', 'bottom', 'closeup', 'listing', 'other'];

export function InspectionDetail() {
  const { id } = useParams<{ id: string }>();
  const detail = useAsync(() => api.get<any>(`/inspections/${id}`), [id]);
  const jobs = useAsync(() => api.get<any>(`/inspections/${id}/jobs`), [id]);
  const [error, setError] = React.useState<unknown>(null);
  const [faceLabel, setFaceLabel] = React.useState('front');
  const [files, setFiles] = React.useState<FileList | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [urlForm, setUrlForm] = React.useState({ url: '', marketplace: '', seller: '', structured: '' });
  const [calAsset, setCalAsset] = React.useState('');
  const [cal, setCal] = React.useState({ method: 'known_dimension', mmPerPx: '', uncertaintyPct: '', notes: '' });
  const [waive, setWaive] = React.useState({ view: '', reason: '' });
  const [camera, setCamera] = React.useState(false);

  const insp = detail.data?.inspection;
  const processing = jobs.data?.jobs?.some((j: any) => ['queued', 'processing'].includes(j.status));

  React.useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => { jobs.reload(); detail.reload(); }, 1500);
    return () => clearInterval(t);
  }, [processing]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true); setError(null);
    try { await fn(); detail.reload(); jobs.reload(); } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const upload = act(async () => {
    if (!files || files.length === 0) throw new Error('Choose at least one file');
    const form = new FormData();
    for (const f of Array.from(files)) form.append('files', f);
    form.append('faceLabel', faceLabel);
    form.append('capturedAt', new Date().toISOString());
    await api.postForm(`/inspections/${id}/evidence`, form);
    setFiles(null);
  });

  const addUrl = act(async () => {
    let structured: any;
    if (urlForm.structured.trim()) {
      try { structured = JSON.parse(urlForm.structured); } catch { throw new Error('Structured listing fields must be valid JSON'); }
    }
    await api.post(`/inspections/${id}/evidence/url`, {
      url: urlForm.url, marketplace: urlForm.marketplace || undefined, seller: urlForm.seller || undefined, structured,
    });
    setUrlForm({ url: '', marketplace: '', seller: '', structured: '' });
  });

  const addCalibration = act(async () => {
    await api.post(`/assets/${calAsset}/calibration`, {
      method: cal.method, mmPerPx: Number(cal.mmPerPx),
      uncertaintyPct: cal.uncertaintyPct ? Number(cal.uncertaintyPct) : undefined,
      notes: cal.notes || undefined,
    });
    setCal({ method: 'known_dimension', mmPerPx: '', uncertaintyPct: '', notes: '' });
  });

  if (!insp) return <div className="content muted">{detail.error ? String((detail.error as any).message) : 'Loading…'}</div>;
  const cov = detail.data.coverage;
  const finalized = ['finalized', 'closed'].includes(insp.status);

  return (
    <>
      <div className="topbar">
        <h1>Inspection <span className="mono">{insp.id.slice(0, 22)}…</span></h1>
        <span className="chip neutral">{insp.status}</span>
        <span className="who">{insp.type} · event date {insp.eventDate}</span>
      </div>
      <div className="content">
        <div className="btn-row" style={{ marginBottom: 16 }}>
          <button className="primary" disabled={busy || detail.data.assets.length === 0}
            onClick={act(() => api.post(`/inspections/${id}/process`))}>
            ▶ Run evidence processing (quality → OCR → extraction)
          </button>
          <Link className="btn secondary" to={`/app/inspections/${id}/workbench`}>Open analysis workbench →</Link>
          <Link className="btn secondary" to={`/app/inspections/${id}/report`}>Report</Link>
          {processing && <span className="chip needs_review"><span className="ico">⟳</span>processing…</span>}
        </div>
        <ErrorText error={error} />

        <div className="grid2">
          <Section title="Product & parties">
            {insp.product ? (
              <table className="data"><tbody>
                <tr><td className="muted">Brand / name</td><td>{insp.product.brand} — {insp.product.genericName}</td></tr>
                <tr><td className="muted">Category</td><td>{insp.product.category}</td></tr>
                <tr><td className="muted">GTIN / pack</td><td className="mono">{insp.product.gtin ?? '—'} · {insp.product.packSize ?? '—'}</td></tr>
                <tr><td className="muted">Import / presentation</td><td>{insp.product.importStatus} · {insp.product.presentationMode}</td></tr>
                <tr><td className="muted">Seller</td><td>{insp.sellerEntity?.name ?? '—'}</td></tr>
              </tbody></table>
            ) : <p className="muted">No product context recorded.</p>}
            {detail.data.duplicates?.length > 0 && (
              <>
                <h3>Possible duplicates / prior inspections</h3>
                {detail.data.duplicates.map((d: any) => (
                  <div key={d.id}><Link to={`/app/inspections/${d.id}`} className="mono">{d.id.slice(0, 20)}…</Link> <span className="muted">{d.event_date} · {d.status}</span></div>
                ))}
              </>
            )}
          </Section>

          <Section title="Coverage checklist">
            <p>
              Required views: {cov.required.map((v: string) => (
                <span key={v} className={`chip ${cov.captured.includes(v) || cov.waived.includes(v) ? 'passed' : 'needs_review'}`} style={{ marginRight: 6 }}>
                  <span className="ico">{cov.captured.includes(v) ? '✓' : cov.waived.includes(v) ? '~' : '…'}</span>{v}{cov.waived.includes(v) ? ' (waived)' : ''}
                </span>
              ))}
            </p>
            {cov.missing.length > 0 && !finalized && (
              <div className="btn-row">
                <select value={waive.view} onChange={(e) => setWaive({ ...waive, view: e.target.value })}>
                  <option value="">waive a view…</option>
                  {cov.missing.map((v: string) => <option key={v}>{v}</option>)}
                </select>
                <input placeholder="reason (required)" value={waive.reason} onChange={(e) => setWaive({ ...waive, reason: e.target.value })} />
                <button className="quiet" disabled={!waive.view || waive.reason.length < 3}
                  onClick={act(() => api.post(`/inspections/${id}/waive-view`, waive))}>Waive with reason</button>
              </div>
            )}
            <p className="muted">{cov.complete ? '✓ Coverage complete — absence of a declaration can be assessed.' : '… Coverage incomplete — missing declarations will evaluate as Not Assessable, not Failed.'}</p>
          </Section>
        </div>

        {!finalized && camera && (
          <CameraCapture inspectionId={id!} onClose={() => setCamera(false)}
            onCaptured={() => { detail.reload(); jobs.reload(); }} />
        )}

        {!finalized && (
          <div className="grid2">
            <Section title="Add package evidence (camera / JPEG / PNG / HEIC / PDF)">
              <div className="btn-row" style={{ marginBottom: 10 }}>
                <button className="secondary" onClick={() => setCamera(!camera)}>
                  📷 {camera ? 'Hide guided camera' : 'Capture with guided camera'}
                </button>
              </div>
              <div className="btn-row">
                <select value={faceLabel} onChange={(e) => setFaceLabel(e.target.value)} aria-label="Package face label">
                  {FACES.map((fc) => <option key={fc}>{fc}</option>)}
                </select>
                <input type="file" multiple accept="image/jpeg,image/png,image/heic,application/pdf" capture="environment"
                  onChange={(e) => setFiles(e.target.files)} aria-label="Evidence files" />
                <button className="primary" onClick={upload} disabled={busy}>Upload</button>
              </div>
              <p className="muted">Originals are preserved immutably with a SHA-256 hash; uploads are validated and scanned.</p>
            </Section>

            <Section title="E-commerce listing evidence">
              <label className="field">Listing URL<input value={urlForm.url} onChange={(e) => setUrlForm({ ...urlForm, url: e.target.value })} placeholder="https://…" /></label>
              <div className="grid2">
                <label className="field">Marketplace<input value={urlForm.marketplace} onChange={(e) => setUrlForm({ ...urlForm, marketplace: e.target.value })} /></label>
                <label className="field">Seller<input value={urlForm.seller} onChange={(e) => setUrlForm({ ...urlForm, seller: e.target.value })} /></label>
              </div>
              <label className="field">Structured listing fields (JSON, optional)
                <textarea value={urlForm.structured} onChange={(e) => setUrlForm({ ...urlForm, structured: e.target.value })}
                  placeholder='{"listing_title":"…","mrp":"MRP ₹ 249.00 …"}' />
              </label>
              <button className="secondary" onClick={addUrl} disabled={busy || !urlForm.url}>Preserve listing evidence</button>
              <p className="muted">No automated crawling — officer-captured evidence only (screenshots go through the upload panel with face label “listing”).</p>
            </Section>
          </div>
        )}

        <Section title={`Evidence (${detail.data.assets.length})`}>
          <table className="data">
            <thead><tr><th>Face</th><th>Kind</th><th>Name / URL</th><th>SHA-256</th><th>Quality</th><th>State</th></tr></thead>
            <tbody>
              {detail.data.assets.map((a: any) => <AssetRow key={a.id} asset={a} />)}
              {detail.data.assets.length === 0 && <tr><td colSpan={6} className="muted">No evidence yet.</td></tr>}
            </tbody>
          </table>

          {!finalized && detail.data.assets.length > 0 && (
            <>
              <h3>Physical scale / calibration (required for character-height checks)</h3>
              <div className="btn-row">
                <select value={calAsset} onChange={(e) => setCalAsset(e.target.value)} aria-label="Asset to calibrate">
                  <option value="">choose asset…</option>
                  {detail.data.assets.filter((a: any) => a.kind === 'image').map((a: any) => (
                    <option key={a.id} value={a.id}>{a.faceLabel} — {a.originalName}</option>
                  ))}
                </select>
                <select value={cal.method} onChange={(e) => setCal({ ...cal, method: e.target.value })}>
                  {['marker', 'known_dimension', 'device', 'manual'].map((m) => <option key={m}>{m}</option>)}
                </select>
                <input placeholder="mm per pixel (e.g. 0.08)" value={cal.mmPerPx} onChange={(e) => setCal({ ...cal, mmPerPx: e.target.value })} style={{ width: 160 }} />
                <input placeholder="± uncertainty %" value={cal.uncertaintyPct} onChange={(e) => setCal({ ...cal, uncertaintyPct: e.target.value })} style={{ width: 130 }} />
                <button className="secondary" onClick={addCalibration} disabled={busy || !calAsset || !cal.mmPerPx}>Record calibration</button>
              </div>
              <p className="warn-box">Without a valid calibration, physical character-size results are <b>Not Assessable</b> — millimetres are never inferred from pixels alone.</p>
            </>
          )}
        </Section>

        <Section title="Processing jobs">
          <table className="data">
            <thead><tr><th>Type</th><th>Status</th><th>Attempts</th><th>Error</th><th>Updated</th></tr></thead>
            <tbody>
              {jobs.data?.jobs?.map((j: any) => (
                <tr key={j.id}>
                  <td>{j.type}</td>
                  <td><span className={`chip ${j.status === 'completed' ? 'passed' : j.status === 'dead_letter' || j.status === 'failed' ? 'failed' : 'needs_review'}`}>
                    <span className="ico">{j.status === 'completed' ? '✓' : j.status === 'processing' ? '⟳' : '…'}</span>{j.status}</span></td>
                  <td>{j.attempts}</td>
                  <td className="muted">{j.error ?? ''}</td>
                  <td className="muted">{j.updated_at}</td>
                </tr>
              ))}
              {(!jobs.data || jobs.data.jobs.length === 0) && <tr><td colSpan={5} className="muted">No jobs yet — upload evidence and run processing.</td></tr>}
            </tbody>
          </table>
        </Section>

        <Timeline id={id!} />
      </div>
    </>
  );
}

function AssetRow({ asset }: { asset: any }) {
  const detail = useAsync(() => api.get<any>(`/assets/${asset.id}`), [asset.id]);
  const q = detail.data?.quality;
  return (
    <tr>
      <td><span className="chip neutral">{asset.faceLabel ?? '—'}</span></td>
      <td>{asset.kind}</td>
      <td>{asset.originalName ?? asset.url ?? '—'}</td>
      <td className="mono" title={asset.sha256}>{asset.sha256?.slice(0, 14)}…</td>
      <td>
        {q ? (
          <>
            <b>{Math.round(q.overall * 100)}%</b> <MockBadge isMock={q.isMock} />
            {q.reasonCodes.length > 0 && (
              <div className="muted">{q.reasonCodes.join(', ')}{q.recapture.recommended && ' — recapture recommended'}
                {q.recapture.guidance.map((g: string, i: number) => <div key={i}>↳ {g}</div>)}
              </div>
            )}
          </>
        ) : <span className="muted">not processed</span>}
      </td>
      <td><span className="chip passed"><span className="ico">✓</span>{asset.uploadState}</span></td>
    </tr>
  );
}

function Timeline({ id }: { id: string }) {
  const tl = useAsync(() => api.get<any>(`/inspections/${id}/timeline`), [id]);
  return (
    <Section title="Case timeline (audit-linked)">
      {tl.data?.linkedInspections?.length > 0 && (
        <p>Linked inspections: {tl.data.linkedInspections.map((l: any) => (
          <Link key={l.id} to={`/app/inspections/${l.id}`} className="mono" style={{ marginRight: 8 }}>{l.id.slice(0, 16)}… ({l.status})</Link>
        ))}</p>
      )}
      <table className="data">
        <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Object</th><th>Outcome</th></tr></thead>
        <tbody>
          {tl.data?.audit?.slice(-25).reverse().map((e: any) => (
            <tr key={e.id}>
              <td className="muted">{e.created_at}</td><td>{e.actor_label}</td><td>{e.action}</td>
              <td className="mono">{e.object_id?.slice(0, 16) ?? ''}</td><td>{e.outcome}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}
