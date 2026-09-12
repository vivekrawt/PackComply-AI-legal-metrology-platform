import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  api, SIDE_LABELS, VERDICT_META,
  type ComplianceCheck, type Scan, type ScanOcr,
} from '../api';
import { ErrorText } from '../components/common';
import { EvidenceStrip, EvidenceViewer } from './EvidenceViewer';
import { CheckGroup, EngineCrossCheck } from './ChecksView';

// Analysis progress, then the verdict. Satisfied requirements are shown as
// prominently as failures: an officer needs to see what the package got right in
// order to write the notice for what it got wrong.
//
// Every finding is checkable against the photographs. "Show on image" opens the
// evidence viewer with the text the model quoted highlighted where it was read
// from — the officer confirms the finding by looking at the package, which is the
// only way decision support stays support rather than substitution.

const POLL_MS = 2000;

export function ScanResult() {
  const { id } = useParams();
  const nav = useNavigate();
  const [scan, setScan] = React.useState<Scan | null>(null);
  const [ocr, setOcr] = React.useState<ScanOcr | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [retrying, setRetrying] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const [viewer, setViewer] = React.useState<{ at: number; check?: ComplianceCheck } | null>(null);

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

  // The boxes are only meaningful once OCR has run, so they are fetched when the
  // scan settles rather than on every poll.
  React.useEffect(() => {
    if (!scan || scan.status === 'analyzing' || scan.status === 'capturing') return;
    let alive = true;
    api.get<ScanOcr>(`/scans/${id}/ocr`)
      .then((o) => { if (alive) setOcr(o); })
      .catch(() => { /* the viewer degrades to plain images */ });
    return () => { alive = false; };
  }, [id, scan?.status, attempt]);

  // Re-analysing is normally deduplicated by the evidence-set idempotency key, so
  // a retry after a service outage needs `force` to actually queue fresh work.
  const retry = async () => {
    setRetrying(true); setError(null);
    try {
      await api.post(`/scans/${id}/analyze`, { force: true });
      setScan(null); setOcr(null);
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
    const reasons = scan.verdict?.error ? [scan.verdict.error] : scan.progress.errors;
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
  const openViewer = (at: number, check?: ComplianceCheck) => setViewer({ at, check });

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

      <p className="verdict-product">
        {product} · scanned {new Date(scan.createdAt).toLocaleString()} · {scan.images.length} image
        {scan.images.length === 1 ? '' : 's'}
      </p>

      {v.isMock && (
        <p className="warn-box">
          <b>No AI assessment was performed.</b> {v.summary}
        </p>
      )}
      {!v.isMock && v.summary && <p className="verdict-summary">{v.summary}</p>}

      <div className="verdict-tally">
        <div className="ok"><b>{satisfied.length}</b><span>met</span></div>
        <div className="bad"><b>{missing.length}</b><span>missing</span></div>
        <div className="warn"><b>{unclear.length}</b><span>unclear</span></div>
      </div>

      <EvidenceStrip images={scan.images} ocr={ocr?.images ?? null} onOpen={(i) => openViewer(i)} />

      {missing.length > 0 && (
        <CheckGroup kind="missing" checks={missing} images={scan.images.length} onVerify={(c) => openViewer(0, c)} />
      )}
      {unclear.length > 0 && (
        <CheckGroup kind="unclear" checks={unclear} images={scan.images.length} onVerify={(c) => openViewer(0, c)} />
      )}
      {satisfied.length > 0 && (
        <CheckGroup kind="present" checks={satisfied} images={scan.images.length} onVerify={(c) => openViewer(0, c)} />
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

      {scan.engineFindings.length > 0 && <EngineCrossCheck findings={scan.engineFindings} />}

      <ApprovalPanel scan={scan} onChanged={() => setAttempt((n) => n + 1)} />

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

      {viewer && (
        <EvidenceViewer
          images={scan.images}
          ocr={ocr?.images ?? null}
          startAt={viewer.at}
          highlight={viewer.check ? { check: viewer.check } : null}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}

// What the admin did with this scan, and what the auditor can do next.
//
// Analysis finishing does not mean the auditor is finished: they may want another
// face of the package first. So handing it over is an explicit act, and until they
// do, the scan reaches no review queue. When it comes back — sent back for
// re-photographing — this is where that instruction is delivered, with the way to
// act on it attached rather than merely described.
function ApprovalPanel({ scan, onChanged }: { scan: Scan; onChanged: () => void }) {
  const nav = useNavigate();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);

  // A decision taken against an earlier analysis no longer describes this scan.
  const review = scan.review && !scan.review.stale ? scan.review : null;
  const submitted = !!scan.submittedAt;
  const sentBack = review?.decision === 'recapture_requested';
  const decided = review?.decision === 'accepted' || review?.decision === 'rejected';

  const send = async () => {
    setBusy(true); setError(null);
    try { await api.post(`/scans/${scan.scanId}/submit`); onChanged(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };

  const status = !submitted ? { tone: 'neutral', icon: '·', label: 'Not sent yet' }
    : sentBack ? { tone: 'needs_review', icon: '↺', label: 'Sent back to you' }
      : review?.decision === 'accepted' ? { tone: 'passed', icon: '✓', label: 'Approved' }
        : review?.decision === 'rejected' ? { tone: 'failed', icon: '✕', label: 'Rejected' }
          : review?.decision === 'escalated'
            ? { tone: 'not_assessable', icon: '↑', label: 'With the super administrator' }
            : { tone: 'needs_review', icon: '…', label: 'Awaiting your admin' };

  return (
    <section className="field-panel approval">
      <div className="field-panel-head">
        <h2>Admin approval</h2>
        <span className={`chip ${status.tone}`}>
          <span className="ico" aria-hidden="true">{status.icon}</span>{status.label}
        </span>
      </div>

      {review && (
        <div className={`approval-note ${review.decision}`}>
          <b>{review.reviewerName ?? 'Your admin'} said:</b>
          <p>{review.reason}</p>
          <small>{new Date(review.createdAt).toLocaleString()}</small>
        </div>
      )}

      {!submitted && (
        <p className="muted approval-hint">
          Your admin does not see this scan until you send it. Add another face of the package
          first if anything above reads &ldquo;could not be determined&rdquo;.
        </p>
      )}
      {submitted && !review && (
        <p className="muted approval-hint">
          Sent for review. Your admin decides it from here — the outcome appears on this screen
          and on your home page.
        </p>
      )}
      {sentBack && (
        <p className="muted approval-hint">
          Photograph the package again — the faces that could not be read are the ones to
          retake — then send it back for review.
        </p>
      )}
      {decided && (
        <p className="muted approval-hint">
          This scan has been decided. Scanning the package again starts a fresh case.
        </p>
      )}

      <ErrorText error={error} />

      {(!submitted || sentBack) && (
        <div className="approval-actions">
          {sentBack && (
            <button className="secondary" onClick={() => nav(`/app/scan/new?scan=${scan.scanId}`)}>
              ＋ Photograph it again
            </button>
          )}
          <button className="primary" onClick={send} disabled={busy}>
            {busy ? 'Sending…' : sentBack ? 'Send to admin again' : 'Send to admin for approval'}
          </button>
        </div>
      )}
    </section>
  );
}

