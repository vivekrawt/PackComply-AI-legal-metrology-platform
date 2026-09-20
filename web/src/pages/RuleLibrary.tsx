import React from 'react';
import { api } from '../api';
import { usePerm } from '../App';
import { ErrorText, LegalFlag, useAsync } from '../components/common';
import { IconCalendar, IconDoc, IconPlus } from '../components/icons';

// Legal rule library + governance workbench (ADM-01). Draft → test → submit →
// independent approve → publish → rollback; published versions are immutable.
//
// The banner at the top is the whole point of the screen: "published" is a state of
// this system, and it is not the same thing as "legally approved". Anything that
// blurred the two would be the single most dangerous piece of UI in the product.

export function RuleLibrary() {
  // Rule authoring is a super_admin permission; every other role gets the read-only view.
  const can = usePerm();
  const isAdmin = can('rule.draft');
  const versions = useAsync(() => api.get<any>('/rules/versions'));
  const sets = useAsync(() => api.get<any>('/rules/sets'));
  const dash = useAsync(() => api.get<any>('/dashboards/rule-admin'));
  const [sel, setSel] = React.useState<any>(null);
  const [testResult, setTestResult] = React.useState<any>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [drafting, setDrafting] = React.useState(false);

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
      <span className="ico" aria-hidden="true">{s === 'published' ? '✓' : s === 'retired' ? '—' : '…'}</span>
      {s.charAt(0).toUpperCase() + s.slice(1)}
    </span>
  );

  if (drafting && isAdmin) {
    return (
      <DraftForm
        sets={sets.data?.ruleSets ?? []}
        onCancel={() => setDrafting(false)}
        onDone={() => { setDrafting(false); versions.reload(); }}
      />
    );
  }

  const needsLegal = dash.data?.requiresLegal?.length ?? 0;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Legal rule library</h1>
          <p className="muted">{isAdmin ? 'Administration — maker-checker enforced' : 'Read-only view'}</p>
        </div>
        {isAdmin && (
          <div className="rv-head-actions">
            <button className="primary" onClick={() => setDrafting(true)}><IconPlus />New draft</button>
          </div>
        )}
      </div>

      <div className="content">
        <ErrorText error={error} />

        {needsLegal > 0 && (
          <p className="warn-box">
            <b>{needsLegal} published version{needsLegal === 1 ? '' : 's'} require legal approval.</b>{' '}
            Placeholder parameters are not certified for enforcement.
            <br />
            <small>Important: published does not equal legally approved.</small>
          </p>
        )}

        <div className="table-wrap">
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Rule</th><th>Version</th><th>Status</th><th>Effective</th>
                  <th>Legal status</th><th>Tests</th>
                </tr>
              </thead>
              <tbody>
                {versions.data?.versions?.map((v: any) => (
                  <tr key={v.id} className="clickable" onClick={() => { setSel(v); setTestResult(null); }}>
                    <td>
                      <b>{v.title}</b>
                      <span className="cell-sub mono">{v.ruleKey}</span>
                    </td>
                    <td>v{v.version}</td>
                    <td>{statusChip(v.status)}</td>
                    <td className="muted nowrap">{v.effectiveFrom}{v.effectiveTo ? ` → ${v.effectiveTo}` : ''}</td>
                    <td>
                      {v.legalStatus === 'REQUIRES_LEGAL_APPROVAL'
                        ? <span className="chip needs_review"><span className="ico" aria-hidden="true">!</span>Approval required</span>
                        : <span className="chip passed"><span className="ico" aria-hidden="true">✓</span>Certified</span>}
                    </td>
                    <td>
                      <button className="link-btn" onClick={(e) => { e.stopPropagation(); runTests(v); setSel(v); }}>
                        Run tests
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {sel && (
          <section className="rv-panel" style={{ marginTop: 18 }}>
            <div className="rv-panel-head">
              <h2>{sel.title} — <span className="mono">{sel.ruleKey}</span> v{sel.version} <LegalFlag status={sel.legalStatus} /></h2>
              <button className="link-btn" onClick={() => { setSel(null); setTestResult(null); }}>Close</button>
            </div>
            {isAdmin && (
              <div className="btn-row" style={{ marginBottom: 14 }}>
                {sel.status === 'draft' && <button className="secondary" onClick={act(() => api.post(`/rules/versions/${sel.id}/submit`))}>Submit for approval</button>}
                {sel.status === 'submitted' && <button className="secondary" onClick={act(() => api.post(`/rules/versions/${sel.id}/approve`))}>Approve (independent approver)</button>}
                {sel.status === 'approved' && <button className="primary" onClick={act(() => api.post(`/rules/versions/${sel.id}/publish`))}>Publish (runs regression pack)</button>}
                {sel.status === 'published' && <button className="danger" onClick={act(() => api.post(`/rules/versions/${sel.id}/retire`))}>Retire</button>}
                {sel.status === 'retired' && <button className="secondary" onClick={act(() => api.post(`/rules/versions/${sel.id}/rollback`))}>Roll back to this version</button>}
                {can('rule.delete') && ['draft', 'submitted', 'approved'].includes(sel.status) && (
                  <button className="danger" onClick={act(async () => {
                    const reason = prompt('Why is this unpublished version being deleted?');
                    if (!reason) throw new Error('A reason is required');
                    await api.del(`/rules/versions/${sel.id}`, { reason });
                    setSel(null);
                  })}>Delete draft</button>
                )}
              </div>
            )}

            <dl className="rv-facts" style={{ marginBottom: 16 }}>
              <dt>Citation</dt><dd>{sel.citation}</dd>
              <dt>Author</dt><dd className="mono">{sel.authorId?.slice(0, 16) ?? '—'}</dd>
              <dt>Approver</dt><dd className="mono">{sel.approverId ? `${sel.approverId.slice(0, 16)}…` : 'pending'}</dd>
              {sel.changeNote && <><dt>Change note</dt><dd>{sel.changeNote}</dd></>}
            </dl>

            <div className="grid2">
              <div>
                <h3>Applicability</h3>
                <pre className="ocr-dump">{JSON.stringify(sel.applicability, null, 1)}</pre>
                <h3>Outcome policy</h3>
                <pre className="ocr-dump">{JSON.stringify(sel.outcome, null, 1)}</pre>
              </div>
              <div>
                <h3>Deterministic logic (versioned configuration)</h3>
                <pre className="ocr-dump">{JSON.stringify(sel.logic, null, 1)}</pre>
              </div>
            </div>

            {testResult && (
              <>
                <h3>Regression test pack — {testResult.passed}/{testResult.total} passed</h3>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Test</th><th>Expected</th><th>Actual</th><th>Result</th></tr></thead>
                    <tbody>
                      {testResult.results.map((r: any) => (
                        <tr key={r.testId}>
                          <td>{r.name}</td>
                          <td className="mono">{r.expected}</td>
                          <td className="mono">{r.actual}</td>
                          <td>
                            <span className={`chip ${r.pass ? 'passed' : 'failed'}`}>
                              <span className="ico" aria-hidden="true">{r.pass ? '✓' : '✕'}</span>
                              {r.pass ? 'Pass' : 'Fail'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        )}

        <div className="result-links" style={{ marginTop: 18 }}>
          <div className="result-link static">
            <span className="result-link-ico"><IconCalendar /></span>
            <span className="result-link-body">
              <b>Upcoming effective dates</b>
              <small>
                {dash.data?.upcoming?.length
                  ? dash.data.upcoming.map((u: any) => `${u.effective_from}: ${u.title}`).join(' · ')
                  : 'None scheduled'}
              </small>
            </span>
          </div>
          <div className="result-link static">
            <span className="result-link-ico"><IconDoc /></span>
            <span className="result-link-body">
              <b>Drafts in progress</b>
              <small>
                {dash.data?.drafts?.length
                  ? dash.data.drafts.map((d: any) => `${d.title} (${d.status})`).join(' · ')
                  : 'No open drafts'}
              </small>
            </span>
          </div>
        </div>

        {!isAdmin && <p className="rv-note">Reviewers have read-only access.</p>}
      </div>
    </>
  );
}

// A draft is a screen of its own, not a form unfolding above the table it will join:
// it asks for nine fields including three JSON documents, and publication turns on
// an independent approver and a passing regression pack.
function DraftForm({ sets, onDone, onCancel }: { sets: any[]; onDone: () => void; onCancel: () => void }) {
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
    <>
      <div className="topbar">
        <div>
          <nav className="rv-crumbs" aria-label="Breadcrumb">
            <button className="link-btn" onClick={onCancel}>Rule library</button>
            <span className="sep" aria-hidden="true">/</span>
            <span>New draft</span>
          </nav>
          <h1>New rule draft</h1>
        </div>
      </div>

      <div className="content">
        <p className="warn-box">
          Drafts require legal approval. Publication needs an independent approver and passing
          regression tests.
        </p>

        <form onSubmit={submit}>
          <div className="rv-form-grid two">
            <label className="field">Rule set
              <select value={f.ruleSetId} onChange={(e) => set('ruleSetId', e.target.value)}>
                {sets.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.layer})</option>)}
              </select>
            </label>
            <label className="field">Rule key
              <input required value={f.ruleKey} onChange={(e) => set('ruleKey', e.target.value)} placeholder="lmpc.my_rule" />
            </label>
            <label className="field">Title
              <input required value={f.title} onChange={(e) => set('title', e.target.value)} />
            </label>
            <label className="field">Citation / source reference
              <input required value={f.citation} onChange={(e) => set('citation', e.target.value)} />
            </label>
            <label className="field">Effective from
              <input type="date" value={f.effectiveFrom} onChange={(e) => set('effectiveFrom', e.target.value)} />
            </label>
          </div>

          <div className="rv-form-grid">
            <label className="field">Applicability (JSON)
              <textarea className="mono" value={f.applicability} onChange={(e) => set('applicability', e.target.value)} />
            </label>
            <label className="field">Checks (JSON)
              <textarea className="mono" value={f.logic} onChange={(e) => set('logic', e.target.value)} />
            </label>
            <label className="field">Outcome policy (JSON)
              <textarea className="mono" value={f.outcome} onChange={(e) => set('outcome', e.target.value)} />
            </label>
          </div>

          <ErrorText error={error} />
          <p className="note-line left">
            New drafts are created as REQUIRES LEGAL APPROVAL until the legal owner certifies
            their parameters.
          </p>

          <div className="pc-modal-foot">
            <button type="button" className="quiet" onClick={onCancel}>Cancel</button>
            <button className="primary">Create draft</button>
          </div>
        </form>
      </div>
    </>
  );
}
