import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, SIDE_LABELS, VERDICT_META, type ComplianceCheck, type Scan } from '../api';
import { ErrorText } from '../components/common';

// Analysis progress, then the verdict. Satisfied requirements are shown as
// prominently as failures: an officer needs to see what the package got right in
// order to write the notice for what it got wrong.

const POLL_MS = 2000;

export function ScanResult() {
  const { id } = useParams();
  const nav = useNavigate();
  const [scan, setScan] = React.useState<Scan | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [retrying, setRetrying] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const s = await api.get<Scan>(`/scans/${id}`);
        if (!alive) return;
        setScan(s);
        // Stop polling once there is nothing further to wait for.
        if (s.status === 'analyzing') timer = setTimeout(tick, POLL_MS);
      } catch (err) {
        if (alive) setError(err);
      }
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [id, attempt]);

  // Re-analysing is normally deduplicated by the evidence-set idempotency key, so
  // a retry after a service outage needs `force` to actually queue fresh work.
  const retry = async () => {
    setRetrying(true); setError(null);
    try {
      await api.post(`/scans/${id}/analyze`, { force: true });
      setScan(null);
      setAttempt((n) => n + 1);
    } catch (err) { setError(err); } finally { setRetrying(false); }
  };


  if (error && !scan) return <div className="field-page narrow"><ErrorText error={error} /></div>;
  if (!scan) return <div className="field-page narrow"><p className="muted">Loading…</p></div>;

  if (scan.status === 'analyzing' || scan.status === 'capturing') {
    const pct = scan.progress.total > 0
      ? Math.round((scan.progress.done / scan.progress.total) * 100)
      : 0;
    return (
      <div className="field-page narrow">
        <h1>Analysing the package</h1>
        <div className="analysing">
          <div className="progress-track"><div className="progress-fill" style={{ width: `${Math.max(pct, 8)}%` }} /></div>
          <p className="muted" role="status" aria-live="polite">
            {scan.progress.done} of {scan.progress.total} steps complete — reading the label text,
            then checking it against the 2011 Rules.
          </p>
        </div>
        <ul className="step-list">
          <li className={scan.progress.done > 0 ? 'done' : 'active'}>Reading text from each image (OCR)</li>
          <li className={scan.progress.pending <= 1 ? 'done' : ''}>Extracting the declarations</li>
          <li className={scan.progress.pending === 0 ? 'done' : ''}>Checking against the Legal Metrology Rules, 2011</li>
        </ul>
      </div>
    );
  }

  // Either no verdict at all, or a verdict row that only records why the judge
  // could not run. Both are a failed analysis, not a compliance outcome — showing
  // the second as "Needs review" would read as a judgement about the package.
  if (scan.status === 'failed' || !scan.verdict || scan.verdict.error) {
    const reasons = scan.verdict?.error
      ? [scan.verdict.error]
      : scan.progress.errors;
    return (
      <div className="field-page narrow">
        <button className="link-back" onClick={() => nav('/app')}>← Back</button>
        <h1>Analysis did not complete</h1>
        <p className="muted">
          No compliance assessment was produced for this package. Your images are saved.
        </p>
        <div className="error-text" role="alert">
          {reasons.length > 0
            ? <ul>{reasons.map((e, i) => <li key={i}>{e}</li>)}</ul>
            : 'The analysis produced no result.'}
        </div>
        <button className="primary" onClick={retry} disabled={retrying}>
          {retrying ? 'Retrying…' : 'Retry analysis'}
        </button>
        <ErrorText error={error} />
      </div>
    );
  }

  const v = scan.verdict;
  const meta = VERDICT_META[v.overall];
  const satisfied = v.checks.filter((c) => c.status === 'present');
  const missing = v.checks.filter((c) => c.status === 'missing');
  const unclear = v.checks.filter((c) => c.status === 'unclear');
  const product = scan.product?.brand || scan.product?.genericName || 'Scanned product';

  return (
    <div className="field-page narrow">
      <button className="link-back" onClick={() => nav('/app')}>← Back</button>

      <div className={`verdict-banner ${meta.tone}`}>
        <span className="verdict-ico" aria-hidden="true">{meta.icon}</span>
        <div>
          <h1>{meta.label}</h1>
          <p>{meta.blurb}</p>
        </div>
      </div>

      <p className="verdict-product">{product} · scanned {new Date(scan.createdAt).toLocaleString()}</p>

      {v.isMock && (
        <p className="warn-box">
          <b>No AI assessment was performed.</b> {v.summary}
        </p>
      )}
      {!v.isMock && v.summary && <p className="verdict-summary">{v.summary}</p>}

      <div className="verdict-tally">
        <div className="ok"><b>{satisfied.length}</b><span>satisfied</span></div>
        <div className="bad"><b>{missing.length}</b><span>missing</span></div>
        <div className="warn"><b>{unclear.length}</b><span>unclear</span></div>
      </div>

      {missing.length > 0 && (
        <CheckGroup
          title="Missing for compliance"
          hint="These declarations are required but were not found on the package."
          tone="failed" checks={missing}
        />
      )}
      {unclear.length > 0 && (
        <CheckGroup
          title="Could not be determined"
          hint="The captured images do not settle these — capture the relevant face again, more clearly."
          tone="needs_review" checks={unclear}
        />
      )}
      {satisfied.length > 0 && (
        <CheckGroup
          title="Compliance requirements met"
          hint="These declarations were found on the package."
          tone="passed" checks={satisfied}
        />
      )}

      <details className="field-panel">
        <summary><b>Evidence and provenance</b></summary>
        <dl className="provenance">
          <dt>Assessed by</dt>
          <dd>{v.provider} · {v.modelVersion}{v.isMock ? ' (not an AI assessment)' : ''}</dd>
          <dt>Statutory text applied</dt>
          <dd>
            {v.rulesSources.length ? v.rulesSources.join(', ') : 'none'}
            {v.rulesSha256 ? <><br /><code>sha256 {v.rulesSha256.slice(0, 24)}…</code></> : null}
          </dd>
          <dt>Images captured</dt>
          <dd>{scan.images.map((i) => SIDE_LABELS[i.side ?? ''] ?? i.side ?? 'unlabelled').join(', ') || 'none'}</dd>
          <dt>Confidence in the reading</dt>
          <dd>
            {v.confidence != null ? `${Math.round(v.confidence * 100)}%` : 'not reported'}
            <small> — reflects OCR legibility, not a degree of legal compliance.</small>
          </dd>
        </dl>
        <h3>Text read from the package</h3>
        <pre className="ocr-dump">{v.ocrText || '(no text was recovered)'}</pre>
      </details>

      {scan.engineFindings.length > 0 && (
        <details className="field-panel">
          <summary><b>Rule-engine cross-check ({scan.engineFindings.length} rules)</b></summary>
          <p className="muted">
            This system's deterministic pattern-matching engine, run separately from the AI
            assessment above. Shown for comparison; the two are not merged.
          </p>
          <ul className="engine-list">
            {scan.engineFindings.map((f) => (
              <li key={f.ruleKey}>
                <span className={`chip ${f.outcome}`}>{f.outcome.replace('_', ' ')}</span>
                <div><b>{f.title}</b><small>{f.citation}</small></div>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="verdict-actions">
        {/* The report is built on demand from the stored verdict and evidence, so
            the link is always live — there is no separate "generate" step to get
            out of step with the scan. */}
        <a className="btn primary" href={`/api/v1/scans/${scan.scanId}/report.pdf`} target="_blank" rel="noreferrer">
          Download report (PDF)
        </a>
        <button className="secondary" onClick={() => nav('/app/scan/new')}>Scan another product</button>
      </div>

      <ErrorText error={error} />

      <p className="disclaimer">
        Decision support for an authorised officer. It does not replace the officer, the
        notice process, or a judicial determination.
      </p>
    </div>
  );
}

function CheckGroup({ title, hint, tone, checks }: {
  title: string; hint: string; tone: string; checks: ComplianceCheck[];
}) {
  return (
    <section className={`check-group ${tone}`}>
      <h2>{title}</h2>
      <p className="muted">{hint}</p>
      <ul>
        {checks.map((c, i) => (
          <li key={`${c.parameter}-${i}`}>
            <div className="check-head">
              <b>{c.parameter}</b>
              {c.ruleReference && <span className="rule-ref">{c.ruleReference}</span>}
            </div>
            {/* For a satisfied check this is the declaration itself; for a failed
                one it is whatever partial text the model found, which is not the
                same claim — so the label follows the status. */}
            {c.observedText && (
              <p className="observed">
                {c.status === 'present' ? 'Found on the package' : 'Related text on the package'}: “{c.observedText}”
              </p>
            )}
            {c.issue && <p className="issue">{c.issue}</p>}
            {c.remedy && <p className="remedy"><b>To fix:</b> {c.remedy}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
