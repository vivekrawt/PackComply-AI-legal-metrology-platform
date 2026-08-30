import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { ErrorText, OutcomeChip, Section, SeverityChip, useAsync } from '../components/common';

export function ReportView() {
  const { id } = useParams<{ id: string }>();
  const report = useAsync(() => api.get<any>(`/inspections/${id}/report`).catch((e) => { throw e; }), [id]);
  const [error, setError] = React.useState<unknown>(null);
  const [verify, setVerify] = React.useState<any>(null);
  const [amendReason, setAmendReason] = React.useState('');

  if (report.error) {
    return (
      <div className="content">
        <Section title="Report">
          <p className="muted">No report yet — finalize the inspection from the workbench first.</p>
          <Link className="btn secondary" to={`/app/inspections/${id}/workbench`}>← Back to workbench</Link>
        </Section>
      </div>
    );
  }
  const r = report.data;
  if (!r) return <div className="content muted">Loading…</div>;
  const s = r.snapshot;

  const doVerify = async () => {
    setError(null);
    try { setVerify(await api.get(`/reports/${r.reportId}/verify?version=${r.version}`)); } catch (e) { setError(e); }
  };
  const amend = async () => {
    setError(null);
    try { await api.post(`/reports/${r.reportId}/amend`, { reason: amendReason }); setAmendReason(''); report.reload(); } catch (e) { setError(e); }
  };
  const dl = (fmt: string) => window.open(`/api/v1/reports/${r.reportId}/export/${fmt}?version=${r.version}`, '_blank');

  return (
    <>
      <div className="topbar">
        <h1>Compliance report</h1>
        <span className="mono muted">{r.reportId} · v{r.version}/{r.currentVersion}</span>
        <span className="who"><Link to={`/app/inspections/${id}`}>← inspection</Link></span>
      </div>
      <div className="content">
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <button className="primary" onClick={() => dl('pdf')}>⭳ PDF</button>
          <button className="secondary" onClick={() => dl('docx')}>⭳ DOCX (editable)</button>
          <button className="secondary" onClick={() => dl('csv')}>⭳ CSV</button>
          <button className="secondary" onClick={() => dl('json')}>⭳ JSON</button>
          <button className="secondary" onClick={() => dl('manifest')}>⭳ Evidence manifest</button>
          <button className="quiet" onClick={doVerify}>Verify integrity</button>
          {verify && (verify.valid
            ? <span className="ok-text">✓ hash verified: {verify.storedSha256.slice(0, 16)}…</span>
            : <span className="error-text">✕ HASH MISMATCH — report content altered!</span>)}
        </div>
        <ErrorText error={error} />
        {s.appliedLegalContext.usesMockProviders && (
          <p className="warn-box">◌ DEMO NOTICE: declaration extraction used a mock provider that has not been benchmarked. OCR text itself came from the real self-hosted engine.</p>
        )}

        <div className="grid2">
          <Section title="1 · Identification">
            <table className="data"><tbody>
              <tr><td className="muted">Inspection</td><td className="mono">{s.identification.inspectionId}</td></tr>
              <tr><td className="muted">Type / event date</td><td>{s.identification.inspectionType} · {s.identification.eventDate}</td></tr>
              <tr><td className="muted">Location</td><td>{s.identification.location ?? '—'}</td></tr>
              <tr><td className="muted">Generated</td><td>{s.identification.generatedAt} by {s.identification.generatedBy.name}</td></tr>
            </tbody></table>
          </Section>
          <Section title="2 · Product & parties">
            {s.productAndParties.product ? (
              <table className="data"><tbody>
                <tr><td className="muted">Product</td><td>{s.productAndParties.product.brand} — {s.productAndParties.product.genericName}</td></tr>
                <tr><td className="muted">Category / GTIN</td><td>{s.productAndParties.product.category} · <span className="mono">{s.productAndParties.product.gtin ?? '—'}</span></td></tr>
                <tr><td className="muted">Import</td><td>{s.productAndParties.product.importStatus}</td></tr>
                <tr><td className="muted">Seller</td><td>{s.productAndParties.seller?.name ?? '—'}</td></tr>
              </tbody></table>
            ) : <p className="muted">No product context.</p>}
          </Section>
        </div>

        <Section title="3 · Evidence manifest (hashes preserved)">
          <table className="data">
            <thead><tr><th>Face</th><th>File / URL</th><th>SHA-256</th><th>Source</th><th>Received</th></tr></thead>
            <tbody>{s.evidenceManifest.assets.map((a: any) => (
              <tr key={a.id}><td>{a.faceLabel ?? a.kind}</td><td>{a.originalName ?? a.url ?? a.id}</td>
                <td className="mono" title={a.sha256}>{a.sha256?.slice(0, 20)}…</td><td>{a.source}</td><td className="muted">{a.receivedAt}</td></tr>
            ))}</tbody>
          </table>
        </Section>

        <Section title="4 · Applied legal context (version-pinned)">
          <p className="muted">Engine {s.appliedLegalContext.engineVersion} · models <span className="mono">{JSON.stringify(s.appliedLegalContext.modelVersions)}</span></p>
          <table className="data">
            <thead><tr><th>Rule</th><th>Version</th><th>Citation</th><th>Legal status</th></tr></thead>
            <tbody>{s.appliedLegalContext.ruleVersions.map((rv: any) => (
              <tr key={rv.ruleVersionId}><td>{rv.title}</td><td className="mono">{rv.ruleKey} v{rv.version}</td>
                <td className="muted">{rv.citation}</td>
                <td>{rv.legalStatus === 'REQUIRES_LEGAL_APPROVAL' ? <span className="legal-flag">REQUIRES LEGAL APPROVAL</span> : 'approved'}</td></tr>
            ))}</tbody>
          </table>
          {s.appliedLegalContext.exclusions?.length > 0 && (
            <>
              <h3>Excluded / displaced rules</h3>
              {s.appliedLegalContext.exclusions.map((e: any, i: number) => <p key={i} className="muted">• {e.ruleKey}: {e.reason}</p>)}
            </>
          )}
        </Section>

        <Section title="5 · Declaration results">
          <table className="data">
            <thead><tr><th>Declaration</th><th>Verbatim</th><th>Normalized</th><th>Model conf.</th><th>Corrections</th></tr></thead>
            <tbody>{s.declarationResults.map((d: any) => (
              <tr key={d.declarationId}>
                <td>{d.declType} {d.sourceChannel === 'listing' && <span className="chip neutral">listing</span>}</td>
                <td className="verbatim">{d.verbatim}</td>
                <td className="mono">{d.normalized?.value != null ? JSON.stringify(d.normalized.value) : '—'}</td>
                <td>{d.confidence != null ? `${Math.round(d.confidence * 100)}%` : '—'}</td>
                <td className="muted">{d.corrections.map((c: any, i: number) => <div key={i}>{c.field}: “{c.original}” → “{c.corrected}” ({c.reason})</div>)}</td>
              </tr>
            ))}</tbody>
          </table>
        </Section>

        <Section title="6 · Violations / observations">
          {s.violationsAndObservations.length === 0 && <p className="ok-text">No open violations or observations.</p>}
          {s.violationsAndObservations.map((f: any) => (
            <div key={f.findingId} className="decl-card">
              <div className="head"><b>{f.ruleTitle}</b><span><OutcomeChip outcome={f.outcome} /> <SeverityChip severity={f.severity} /></span></div>
              <p>{f.explanation}</p>
              <p className="muted">Citation: {f.citation} · rule {f.ruleKey} v{f.ruleVersion}</p>
            </div>
          ))}
        </Section>

        <div className="grid2">
          <Section title="7 · Officer conclusion">
            <p>Overall: <OutcomeChip outcome={s.officerConclusion.overallStatus === 'compliant' ? 'passed' : s.officerConclusion.overallStatus === 'non_compliant' ? 'failed' : 'needs_review'} /></p>
            <table className="data">
              <thead><tr><th>Rule</th><th>System</th><th>Officer</th><th>Status</th></tr></thead>
              <tbody>{s.officerConclusion.findings.map((f: any) => (
                <tr key={f.ruleKey}><td className="mono">{f.ruleKey}</td>
                  <td><OutcomeChip outcome={f.evaluationOutcome} /></td>
                  <td><OutcomeChip outcome={f.effectiveOutcome} /></td>
                  <td>{f.status}{f.overrides.map((o: any, i: number) => <div key={i} className="muted">override: {o.reason}</div>)}</td></tr>
              ))}</tbody>
            </table>
          </Section>
          <Section title="8 · Audit & verification">
            <p className="muted">Report SHA-256:</p><p className="mono">{r.sha256}</p>
            <h3>Version history</h3>
            {r.versions.map((v: any) => (
              <p key={v.version} className="muted">v{v.version} · {v.created_at} · {v.reason} · <span className="mono">{v.sha256.slice(0, 16)}…</span></p>
            ))}
            <h3>Amend (creates a new version; prior versions retained)</h3>
            <div className="btn-row">
              <input placeholder="amendment reason" value={amendReason} onChange={(e) => setAmendReason(e.target.value)} />
              <button className="secondary" disabled={amendReason.length < 3} onClick={amend}>Create amended version</button>
            </div>
          </Section>
        </div>
      </div>
    </>
  );
}
