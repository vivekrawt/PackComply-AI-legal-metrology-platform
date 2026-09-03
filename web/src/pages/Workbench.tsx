import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { AuthContext } from '../App';
import { Confidence, ErrorText, LegalFlag, MockBadge, OutcomeChip, Section, SeverityChip, useAsync } from '../components/common';

// Analysis Workbench: evidence viewer + OCR overlay (left) · declarations,
// findings, legal explanations and officer decisions (right). Clicking a
// declaration or finding highlights its evidence region (EXT-02).
export function Workbench() {
  const { id } = useParams<{ id: string }>();
  const { user, can } = React.useContext(AuthContext);
  const detail = useAsync(() => api.get<any>(`/inspections/${id}`), [id]);
  const decls = useAsync(() => api.get<any>(`/inspections/${id}/declarations`), [id]);
  const findings = useAsync(() => api.get<any>(`/inspections/${id}/findings`), [id]);
  const [activeAsset, setActiveAsset] = React.useState<string | null>(null);
  const [highlight, setHighlight] = React.useState<{ assetId: string; bboxes: any[] } | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState(false);

  const imageAssets = (detail.data?.assets ?? []).filter((a: any) => a.kind === 'image' || a.kind === 'pdf');
  const currentAsset = activeAsset ?? imageAssets[0]?.id ?? null;
  const assetDetail = useAsync(
    () => currentAsset ? api.get<any>(`/assets/${currentAsset}`) : Promise.resolve(null),
    [currentAsset, decls.data],
  );

  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true); setError(null);
    try { await fn(); decls.reload(); findings.reload(); detail.reload(); } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const focusRegion = (regions: any[]) => {
    if (!regions?.length) return;
    const r = regions.find((x) => x.assetId === currentAsset) ?? regions[0];
    setActiveAsset(r.assetId);
    setHighlight({ assetId: r.assetId, bboxes: regions.filter((x) => x.assetId === r.assetId).map((x) => x.bbox) });
  };

  const insp = detail.data?.inspection;
  if (!insp) return <div className="content muted">Loading…</div>;
  const finalized = ['finalized', 'closed'].includes(insp.status);

  return (
    <>
      <div className="topbar">
        <h1>Analysis workbench</h1>
        <span className="mono muted">{insp.id.slice(0, 22)}…</span>
        <span className="chip neutral">{insp.status}</span>
        <span className="who">
          <Link to={`/app/inspections/${id}`}>← inspection</Link> · <Link to={`/app/inspections/${id}/report`}>report →</Link>
        </span>
      </div>
      <div className="content">
        <div className="btn-row" style={{ marginBottom: 12 }}>
          {!finalized && (
            <button className="primary" disabled={busy}
              onClick={act(() => api.post(`/inspections/${id}/evaluate`))}>
              ⚖ Apply versioned rules (event date {insp.eventDate})
            </button>
          )}
          {!finalized && (
            <button className="secondary" disabled={busy}
              onClick={act(() => api.post(`/inspections/${id}/finalize`))}>
              🔒 Finalize inspection
            </button>
          )}
          <span className="muted">Model confidence is assistive only — legal status comes from the deterministic rule engine.</span>
        </div>
        <ErrorText error={error} />

        <div className="workbench">
          {/* LEFT: evidence viewer */}
          <div className="evidence-viewer">
            <div className="face-tabs" role="tablist" aria-label="Evidence faces">
              {imageAssets.map((a: any) => (
                <button key={a.id} role="tab" aria-selected={a.id === currentAsset}
                  className={a.id === currentAsset ? 'on quiet' : 'quiet'}
                  onClick={() => { setActiveAsset(a.id); setHighlight(null); }}>
                  {a.faceLabel ?? a.kind}
                </button>
              ))}
            </div>
            {currentAsset ? (
              <div className="evidence-stage">
                <img src={`/api/v1/assets/${currentAsset}/content`} alt={`Evidence ${assetDetail.data?.asset?.faceLabel ?? ''} view (original preserved)`} />
                {(assetDetail.data?.layoutRegions ?? []).filter((r: any) => r.kind === 'pdp').map((r: any) => (
                  <div key={r.id} className="ocr-box pdp" title="Likely principal display panel (editable geometry)"
                    style={boxStyle(r.bbox)} />
                ))}
                {(assetDetail.data?.ocrBlocks ?? []).map((b: any) => {
                  const hl = highlight != null && highlight.assetId === currentAsset &&
                    highlight.bboxes.some((h) => h && Math.abs(h.x - b.bbox.x) < 0.02 && Math.abs(h.y - b.bbox.y) < 0.02);
                  return (
                    <button key={b.id} className={`ocr-box${hl ? ' highlight' : ''}`} style={boxStyle(b.bbox)}
                      title={`"${b.text}" · ${b.script}/${b.lang} · confidence ${b.confidence}`}
                      aria-label={`OCR text: ${b.text}`}
                      onClick={() => setHighlight({ assetId: currentAsset, bboxes: [b.bbox] })} />
                  );
                })}
              </div>
            ) : <p className="muted card">No image evidence. Structured listing evidence appears in declarations.</p>}
            {assetDetail.data?.quality && (
              <div className="card" style={{ marginTop: 8 }}>
                <b>Image quality</b> {Math.round(assetDetail.data.quality.overall * 100)}% <MockBadge isMock={assetDetail.data.quality.isMock} />
                <div className="muted">
                  {assetDetail.data.quality.reasonCodes.length ? assetDetail.data.quality.reasonCodes.join(', ') : 'no quality issues flagged'}
                  {' · '}quality scores are capture guidance, not legal compliance.
                </div>
                {assetDetail.data.calibrations?.length > 0
                  ? <div className="ok-text">✓ calibration: {assetDetail.data.calibrations[0].method}, {assetDetail.data.calibrations[0].mmPerPx} mm/px</div>
                  : <div className="muted">no calibration on this asset — physical font size will be Not Assessable</div>}
              </div>
            )}
            <div className="card" style={{ marginTop: 8 }}>
              <b>OCR text (verbatim)</b>
              {(assetDetail.data?.ocrBlocks ?? []).map((b: any) => (
                <div key={b.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <button className="quiet" style={{ padding: '1px 6px' }} onClick={() => setHighlight({ assetId: currentAsset!, bboxes: [b.bbox] })} aria-label={`Highlight region for: ${b.text}`}>◉</button>
                  <span className="verbatim" lang={b.lang}>{b.text}</span>
                  <Confidence value={b.confidence} /><MockBadge isMock={b.isMock} />
                </div>
              ))}
              {(assetDetail.data?.ocrBlocks ?? []).length === 0 && <p className="muted">No OCR yet — run evidence processing.</p>}
            </div>
          </div>

          {/* RIGHT: declarations + findings */}
          <div>
            <Section title={`Extracted declarations (${decls.data?.declarations?.length ?? 0})`}>
              {(decls.data?.declarations ?? []).map((d: any) => (
                <DeclarationCard key={d.id} d={d} onFocus={() => focusRegion(d.evidenceRegions)}
                  editable={!finalized && can('declaration.edit')} onChanged={() => { decls.reload(); }} />
              ))}
              {(decls.data?.declarations ?? []).length === 0 && <p className="muted">No declarations extracted yet.</p>}
            </Section>

            <Section title={`Compliance findings (${findings.data?.findings?.length ?? 0})`}>
              {(findings.data?.findings ?? []).map((f: any) => (
                <FindingCard key={f.id} f={f} finalized={finalized} busy={busy}
                  onFocus={() => focusRegion(f.evidenceRefs)}
                  act={act} canDispose={can('finding.disposition')} canApprove={can('finding.approve_override')} />
              ))}
              {(findings.data?.findings ?? []).length === 0 && <p className="muted">Run the rule evaluation to generate findings.</p>}
            </Section>
          </div>
        </div>
      </div>
    </>
  );
}

function boxStyle(b: { x: number; y: number; w: number; h: number }): React.CSSProperties {
  return { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` };
}

function DeclarationCard({ d, onFocus, editable, onChanged }: {
  d: any; onFocus: () => void; editable: boolean; onChanged: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(d.verbatimText);
  const [declType, setDeclType] = React.useState(d.declType);
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<unknown>(null);

  const save = async () => {
    setError(null);
    try {
      if (text !== d.verbatimText) await api.post(`/declarations/${d.id}/correct`, { field: 'verbatim_text', newValue: text, reason });
      if (declType !== d.declType) await api.post(`/declarations/${d.id}/correct`, { field: 'decl_type', newValue: declType, reason });
      setEditing(false); setReason(''); onChanged();
    } catch (e) { setError(e); }
  };

  return (
    <div className="decl-card">
      <div className="head">
        <span>
          <button className="quiet" style={{ padding: '0 6px', marginRight: 6 }} onClick={onFocus} aria-label={`Highlight evidence for ${d.declType}`}>◉</button>
          <span className="decl-type">{d.declType.replace(/_/g, ' ')}</span>
          {d.sourceChannel === 'listing' && <span className="chip neutral" style={{ marginLeft: 6 }}>listing</span>}
        </span>
        <span><Confidence value={d.confidence} /> <MockBadge isMock={d.isMock} /></span>
      </div>
      <div className="verbatim" lang={d.lang}>{d.verbatimText}</div>
      {d.normalized?.value != null && (
        <div className="muted">normalized: <span className="mono">{JSON.stringify(d.normalized.value)}</span>{d.unit ? ` (${d.unit})` : ''}</div>
      )}
      {d.needsReview && <div className="warn-box">⚠ Needs review: {d.reviewReasons.join(', ')}</div>}
      {editable && !editing && <button className="quiet" onClick={() => setEditing(true)}>✎ Correct</button>}
      {editing && (
        <div style={{ marginTop: 8 }}>
          <label className="field">Verbatim text<input value={text} onChange={(e) => setText(e.target.value)} /></label>
          <label className="field">Declaration type
            <select value={declType} onChange={(e) => setDeclType(e.target.value)}>
              {['responsible_entity', 'product_name', 'net_quantity', 'mrp', 'unit_sale_price', 'mfg_date', 'best_before', 'expiry', 'consumer_care', 'country_of_origin', 'dimensions'].map((tp) => <option key={tp}>{tp}</option>)}
            </select>
          </label>
          <label className="field">Reason for correction (required)
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <ErrorText error={error} />
          <div className="btn-row">
            <button className="primary" onClick={save} disabled={reason.length < 3}>Save correction</button>
            <button className="quiet" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function FindingCard({ f, finalized, busy, onFocus, act, canDispose, canApprove }: {
  f: any; finalized: boolean; busy: boolean; onFocus: () => void;
  act: (fn: () => Promise<unknown>) => () => Promise<void>;
  canDispose: boolean; canApprove: boolean;
}) {
  const [showOverride, setShowOverride] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [toOutcome, setToOutcome] = React.useState('passed');
  const overridden = f.effectiveOutcome !== f.evaluationOutcome;
  const pendingApproval = f.dispositions.some((d: any) => d.requiresApproval && !d.approvedBy);
  const mayDispose = !finalized && canDispose;

  return (
    <div className="decl-card">
      <div className="head">
        <span>
          <button className="quiet" style={{ padding: '0 6px', marginRight: 6 }} onClick={onFocus} aria-label={`Highlight evidence for ${f.ruleTitle}`}>◉</button>
          <b>{f.ruleTitle}</b> <span className="muted mono">{f.ruleKey} v{f.ruleVersion}</span> <LegalFlag status={f.ruleLegalStatus} />
        </span>
        <span><OutcomeChip outcome={f.effectiveOutcome} /> <SeverityChip severity={f.severity} /></span>
      </div>
      <p style={{ margin: '6px 0' }}>{f.explanation}</p>
      <p className="muted">Citation: {f.citation} · engine {f.engineVersion} · models {Object.values(f.modelVersions).join(', ')}</p>
      {overridden && (
        <p className="warn-box">Officer decision: system said <b>{f.evaluationOutcome}</b> → recorded as <b>{f.effectiveOutcome}</b> ({f.status}).
          {f.dispositions.filter((d: any) => d.reason).map((d: any) => ` Reason: ${d.reason}`).join(' ')}</p>
      )}
      {pendingApproval && <p className="warn-box">⚠ High-risk override awaiting independent second-level approval — finalization is blocked.
        {canApprove && f.dispositions.filter((d: any) => d.requiresApproval && !d.approvedBy).map((d: any) => (
          <button key={d.id} className="secondary" style={{ marginLeft: 8 }} disabled={busy}
            onClick={act(() => api.post(`/dispositions/${d.id}/approve`))}>Approve override</button>
        ))}</p>}
      {mayDispose && (
        <div className="btn-row" style={{ marginTop: 6 }}>
          <button className="secondary" disabled={busy}
            onClick={act(async () => {
              const r = prompt('Reason for confirming this finding:');
              if (!r) throw new Error('A reason is required');
              await api.post(`/findings/${f.id}/disposition`, { action: 'confirm', reason: r });
            })}>Confirm</button>
          <button className="quiet" disabled={busy}
            onClick={act(async () => {
              const r = prompt('Reason for dismissing this finding:');
              if (!r) throw new Error('A reason is required');
              await api.post(`/findings/${f.id}/disposition`, { action: 'dismiss', reason: r });
            })}>Dismiss</button>
          <button className="quiet" onClick={() => setShowOverride(!showOverride)}>Override…</button>
        </div>
      )}
      {showOverride && mayDispose && (
        <div style={{ marginTop: 8 }}>
          <label className="field">Override outcome to
            <select value={toOutcome} onChange={(e) => setToOutcome(e.target.value)}>
              {['passed', 'failed', 'needs_review', 'not_applicable', 'not_assessable'].map((o) => <option key={o}>{o}</option>)}
            </select>
          </label>
          <label className="field">Override reason (required, audited)
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button className="danger" disabled={busy || reason.length < 3}
            onClick={act(async () => {
              await api.post(`/findings/${f.id}/disposition`, { action: 'override', toOutcome, reason });
              setShowOverride(false); setReason('');
            })}>Record override</button>
        </div>
      )}
    </div>
  );
}
