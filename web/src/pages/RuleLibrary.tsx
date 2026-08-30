import React from 'react';
import { api } from '../api';
import { AuthContext } from '../App';
import { ErrorText, LegalFlag, Section, useAsync } from '../components/common';

// Legal rule library + governance workbench (ADM-01). Draft → test → submit →
// independent approve → publish → rollback; published versions are immutable.
export function RuleLibrary() {
  const { user } = React.useContext(AuthContext);
  const isAdmin = user?.role === 'rule_admin';
  const versions = useAsync(() => api.get<any>('/rules/versions'));
  const sets = useAsync(() => api.get<any>('/rules/sets'));
  const dash = useAsync(() => api.get<any>('/dashboards/rule-admin'));
  const [sel, setSel] = React.useState<any>(null);
  const [testResult, setTestResult] = React.useState<any>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [showDraft, setShowDraft] = React.useState(false);

  const act = (fn: () => Promise<unknown>) => async () => {
    setError(null);
    try { await fn(); versions.reload(); dash.reload(); } catch (e) { setError(e); }
  };
  const runTests = async (v: any) => {
    setError(null);
    try { setTestResult(await api.post(`/rules/versions/${v.id}/test`)); } catch (e) { setError(e); }
  };

  const statusChip = (s: string) => (
    <span className={`chip ${s === 'published' ? 'passed' : s === 'retired' ? 'not_applicable' : 'needs_review'}`}>
      <span className="ico">{s === 'published' ? '✓' : s === 'retired' ? '—' : '…'}</span>{s}
    </span>
  );

  return (
    <>
      <div className="topbar"><h1>Legal rule library</h1>
        <span className="who">{isAdmin ? 'rule administration enabled (maker-checker enforced)' : 'read-only view'}</span>
      </div>
      <div className="content">
        <ErrorText error={error} />
        {dash.data?.requiresLegal?.length > 0 && (
          <p className="warn-box">⚠ {dash.data.requiresLegal.length} published rule version(s) carry placeholder parameters marked <b>REQUIRES LEGAL APPROVAL</b>. Certify sources and thresholds with the legal domain owner before enforcement use.</p>
        )}

        <Section title="Rule versions" actions={isAdmin && <button className="primary" onClick={() => setShowDraft(!showDraft)}>＋ New draft version</button>}>
          {showDraft && isAdmin && <DraftForm sets={sets.data?.ruleSets ?? []} onDone={() => { setShowDraft(false); versions.reload(); }} />}
          <table className="data">
            <thead><tr><th>Rule</th><th>Version</th><th>Status</th><th>Effective</th><th>Citation</th><th>Legal</th><th></th></tr></thead>
            <tbody>
              {versions.data?.versions?.map((v: any) => (
                <tr key={v.id} className="clickable" onClick={() => { setSel(v); setTestResult(null); }}>
                  <td><b>{v.title}</b><div className="mono muted">{v.ruleKey}</div></td>
                  <td>v{v.version}</td>
                  <td>{statusChip(v.status)}</td>
                  <td className="muted">{v.effectiveFrom} → {v.effectiveTo ?? 'open'}</td>
                  <td className="muted">{v.citation.slice(0, 60)}…</td>
                  <td><LegalFlag status={v.legalStatus} /></td>
                  <td><button className="quiet" onClick={(e) => { e.stopPropagation(); runTests(v); setSel(v); }}>▶ tests</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        {sel && (
          <Section title={`${sel.title} — ${sel.ruleKey} v${sel.version}`} actions={
            isAdmin && (
              <div className="btn-row">
                {sel.status === 'draft' && <button className="secondary" onClick={act(() => api.post(`/rules/versions/${sel.id}/submit`))}>Submit for approval</button>}
                {sel.status === 'submitted' && <button className="secondary" onClick={act(() => api.post(`/rules/versions/${sel.id}/approve`))}>Approve (independent approver)</button>}
                {sel.status === 'approved' && <button className="primary" onClick={act(() => api.post(`/rules/versions/${sel.id}/publish`))}>Publish (runs regression pack)</button>}
                {sel.status === 'published' && <button className="danger" onClick={act(() => api.post(`/rules/versions/${sel.id}/retire`))}>Retire</button>}
                {sel.status === 'retired' && <button className="secondary" onClick={act(() => api.post(`/rules/versions/${sel.id}/rollback`))}>Roll back to this version</button>}
              </div>
            )
          }>
            <div className="grid2">
              <div>
                <h3>Governance</h3>
                <p className="muted">Author {sel.authorId?.slice(0, 14)}… · approver {sel.approverId ? sel.approverId.slice(0, 14) + '…' : 'pending'} · {sel.changeNote ?? ''}</p>
                <h3>Applicability</h3><pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(sel.applicability, null, 1)}</pre>
                <h3>Outcome policy</h3><pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(sel.outcome, null, 1)}</pre>
              </div>
              <div>
                <h3>Deterministic logic (versioned configuration)</h3>
                <pre className="mono" style={{ whiteSpace: 'pre-wrap', background: '#f3f6fb', padding: 10, borderRadius: 6 }}>{JSON.stringify(sel.logic, null, 1)}</pre>
              </div>
            </div>
            {testResult && (
              <>
                <h3>Regression test pack — {testResult.passed}/{testResult.total} passed</h3>
                <table className="data">
                  <thead><tr><th>Test</th><th>Expected</th><th>Actual</th><th>Result</th></tr></thead>
                  <tbody>{testResult.results.map((r: any) => (
                    <tr key={r.testId}><td>{r.name}</td><td className="mono">{r.expected}</td><td className="mono">{r.actual}</td>
                      <td>{r.pass ? <span className="ok-text">✓ pass</span> : <span className="error-text">✕ fail</span>}</td></tr>
                  ))}</tbody>
                </table>
              </>
            )}
          </Section>
        )}

        <div className="grid2">
          <Section title="Upcoming effective dates">
            {dash.data?.upcoming?.length ? dash.data.upcoming.map((u: any) => (
              <p key={u.rule_key + u.version} className="muted">• {u.effective_from}: {u.title} (<span className="mono">{u.rule_key} v{u.version}</span>)</p>
            )) : <p className="muted">None scheduled.</p>}
          </Section>
          <Section title="Drafts in progress">
            {dash.data?.drafts?.length ? dash.data.drafts.map((d: any) => (
              <p key={d.rule_key + d.version} className="muted">• {d.title} — <span className="mono">{d.rule_key} v{d.version}</span> ({d.status})</p>
            )) : <p className="muted">No open drafts.</p>}
          </Section>
        </div>
      </div>
    </>
  );
}

function DraftForm({ sets, onDone }: { sets: any[]; onDone: () => void }) {
  const [error, setError] = React.useState<unknown>(null);
  const [f, setF] = React.useState({
    ruleSetId: sets[0]?.id ?? '', ruleKey: '', title: '', citation: '',
    effectiveFrom: new Date().toISOString().slice(0, 10),
    applicability: '{"categories":["*"],"channels":["*"],"importStatus":["*"]}',
    inputs: '{"declTypes":[]}',
    logic: '{"checks":[{"type":"presence","declType":"mrp"}]}',
    outcome: '{"severityOnFail":"medium","remediation":""}',
  });
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    try {
      await api.post('/rules/versions', {
        ruleSetId: f.ruleSetId, ruleKey: f.ruleKey, title: f.title, citation: f.citation,
        effectiveFrom: f.effectiveFrom,
        applicability: JSON.parse(f.applicability), inputs: JSON.parse(f.inputs),
        logic: JSON.parse(f.logic), outcome: JSON.parse(f.outcome),
      });
      onDone();
    } catch (err) { setError(err); }
  };
  return (
    <form onSubmit={submit} className="card" style={{ background: '#f8fafc' }}>
      <div className="grid2">
        <label className="field">Rule set
          <select value={f.ruleSetId} onChange={(e) => set('ruleSetId', e.target.value)}>
            {sets.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.layer})</option>)}
          </select>
        </label>
        <label className="field">Rule key<input required value={f.ruleKey} onChange={(e) => set('ruleKey', e.target.value)} placeholder="lmpc.my_rule" /></label>
        <label className="field">Title<input required value={f.title} onChange={(e) => set('title', e.target.value)} /></label>
        <label className="field">Citation / source reference<input required value={f.citation} onChange={(e) => set('citation', e.target.value)} /></label>
        <label className="field">Effective from<input type="date" value={f.effectiveFrom} onChange={(e) => set('effectiveFrom', e.target.value)} /></label>
      </div>
      <label className="field">Applicability (JSON)<textarea value={f.applicability} onChange={(e) => set('applicability', e.target.value)} /></label>
      <label className="field">Logic — checks (JSON)<textarea value={f.logic} onChange={(e) => set('logic', e.target.value)} /></label>
      <label className="field">Outcome policy (JSON)<textarea value={f.outcome} onChange={(e) => set('outcome', e.target.value)} /></label>
      <ErrorText error={error} />
      <p className="muted">New drafts are created as REQUIRES LEGAL APPROVAL until the legal owner certifies parameters. Publication requires an independent approver and a passing regression pack.</p>
      <button className="primary">Create draft</button>
    </form>
  );
}
