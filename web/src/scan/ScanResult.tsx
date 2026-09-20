import React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api, SIDE_LABELS, VERDICT_META,
  type ComplianceCheck, type Scan, type ScanOcr,
} from '../api';
import { ErrorText } from '../components/common';
import { IconArrowLeft, IconDoc, IconDownload, IconGear, IconPeople, IconPlus } from '../components/icons';
import { EvidenceViewer, PackageFigure } from './EvidenceViewer';
import { DeclarationsPanel, EngineCrossCheck, engineSummary } from './ChecksView';

// Analysis progress, then the assessment. Satisfied requirements are shown as
// prominently as failures: an officer needs to see what the package got right in
// order to write the notice for what it got wrong.
//
// Every finding is checkable against the photographs. "Show on image" opens the
// evidence viewer with the text the model quoted highlighted where it was read
// from — the officer confirms the finding by looking at the package, which is the
// only way decision support stays support rather than substitution.

const POLL_MS = 2000;

const fmtWhen = (iso: string) => new Date(iso).toLocaleString(undefined, {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, {
  day: '2-digit', month: 'short', year: 'numeric',
});

export function ScanResult() {
  const { id } = useParams();
  const nav = useNavigate();
  const [scan, setScan] = React.useState<Scan | null>(null);
  const [ocr, setOcr] = React.useState<ScanOcr | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [retrying, setRetrying] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const [viewer, setViewer] = React.useState<{ at: number; check?: ComplianceCheck } | null>(null);
  // The two footers open in place rather than navigating: the workings belong to
  // the assessment above them, not to a screen of their own.
  const [drawer, setDrawer] = React.useState<'provenance' | 'engine' | null>(null);

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

  if (error && !scan) return <div className="field-page"><ErrorText error={error} /></div>;
  if (!scan) return <div className="field-page"><p className="muted">Loading…</p></div>;

  if (scan.status === 'analyzing' || scan.status === 'capturing') {
    const pct = scan.progress.total > 0
      ? Math.round((scan.progress.done / scan.progress.total) * 100)
      : 0;
    return (
      <div className="field-page narrow">
        <h1>Analysing the package</h1>
        <p className="page-sub">Reading the label text, then checking it against the 2011 Rules.</p>
        <div className="analysing">
          <div className="progress-track"><div className="progress-fill" style={{ width: `${Math.max(pct, 8)}%` }} /></div>
          <p className="muted" role="status" aria-live="polite">
            {scan.progress.done} of {scan.progress.total} steps complete
          </p>
          <ul className="step-list">
            <li className={scan.progress.done > 0 ? 'done' : 'active'}>Reading text from each image (OCR)</li>
            <li className={scan.progress.pending <= 1 ? 'done' : ''}>Extracting the declarations</li>
            <li className={scan.progress.pending === 0 ? 'done' : ''}>Checking against the Legal Metrology Rules, 2011</li>
          </ul>
        </div>
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
        <button className="link-back" onClick={() => nav('/app')}><IconArrowLeft />Back</button>
        <h1>Analysis did not complete</h1>
        <p className="page-sub">
          No compliance assessment was produced for this package. Your images are saved.
        </p>
        <div className="error-text" role="alert" style={{ margin: '18px 0' }}>
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
  // Faces the officer photographed that the recogniser never read. The assessment
  // above was made without them, and saying so is not a detail: a verdict drawn
  // from three of five faces is a different thing from a verdict on the package.
  const unread = scan.images.filter((i) => !i.read);
  // "Needs review" is the verdict for evidence that did not settle the question, and
  // an obstacle on the way - a recogniser that was down, a model call that failed -
  // lands here looking exactly like a genuinely unclear label. The officer is the
  // only one who can tell the difference, by running it again now that whatever was
  // broken may not be. Offered only while the case is still theirs: once an
  // administrator has decided it, re-running only marks that decision stale.
  const decidedReview = scan.review && !scan.review.stale ? scan.review : null;
  const settled = decidedReview?.decision === 'accepted' || decidedReview?.decision === 'rejected';
  // When faces went unread, the banner below already says so and offers the same
  // action with the better explanation, so this would only repeat it.
  const offerRecheck = v.overall === 'needs_review' && unread.length === 0 && !settled;
  const openViewer = (at: number, check?: ComplianceCheck) => setViewer({ at, check });

  return (
    <div className="field-page">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/app/history">History</Link>
        <span className="sep" aria-hidden="true">/</span>
        <span>{product}</span>
      </nav>

      <div className="verdict-head">
        <div className="verdict-title">
          <h1>{product}</h1>
          <p className="meta">
            {fmtDay(scan.createdAt)} · {scan.images.length} image{scan.images.length === 1 ? '' : 's'}
            {v.isMock ? ' · rule engine only' : ''}
          </p>
        </div>
        <div className="verdict-state">
          <span className={`chip pill ${meta.tone}`} role="status">
            <span className="ico" aria-hidden="true">{meta.icon}</span>{meta.label}
          </span>
          <small>AI assessment — officer verification required</small>
        </div>
        <div className="page-head-actions">
          {/* The report is built on demand from the stored verdict and evidence, so
              the link is always live — there is no separate "generate" step to get
              out of step with the scan. */}
          <a className="btn secondary" href={`/api/v1/scans/${scan.scanId}/report.pdf`} target="_blank" rel="noreferrer">
            <IconDownload />Download PDF
          </a>
          <button className="primary" onClick={() => nav('/app/scan/new')}>Scan another product</button>
        </div>
      </div>

      <div className="verdict-line">
        <p className="verdict-summary">
          {v.isMock
            ? <><b>No AI assessment was performed.</b> {v.summary}</>
            : v.summary || meta.blurb}
        </p>
        <div className="verdict-tally">
          <div><b>{satisfied.length}</b><span>Met</span></div>
          <div><b>{missing.length}</b><span>Missing</span></div>
          <div><b>{unclear.length}</b><span>Unclear</span></div>
        </div>
      </div>

      {offerRecheck && (
        <div className="warn-box unread-faces">
          <b>Not a conclusion about the package.</b>{' '}
          The check did not settle the question — that can be the label itself, or it can be
          something that went wrong on the way: a face the recogniser could not reach, or an
          assessment that never came back. If you think the package is readable, run it again.
          <button className="secondary" onClick={retry} disabled={retrying}>
            {retrying ? 'Rechecking…' : 'Recheck this package'}
          </button>
        </div>
      )}

      {unread.length > 0 && (
        <div className="warn-box unread-faces" role="alert">
          <b>
            {unread.length} of {scan.images.length} image{scan.images.length === 1 ? '' : 's'} could
            not be read.
          </b>{' '}
          The {unread.map((i) => (SIDE_LABELS[i.side ?? ''] ?? i.side ?? 'unlabelled').toLowerCase())
            .join(', ')} {unread.length === 1 ? 'face was' : 'faces were'} photographed, but the text
          recogniser never ran on {unread.length === 1 ? 'it' : 'them'} — so this assessment was made
          without whatever {unread.length === 1 ? 'it says' : 'they say'}. Nothing here can be taken
          as absent from the package.
          {scan.progress.errors.length > 0 && (
            <ul className="unread-why">
              {[...new Set(scan.progress.errors)].map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
          <button className="secondary" onClick={retry} disabled={retrying}>
            {retrying ? 'Re-analysing…' : 'Read them and analyse again'}
          </button>
        </div>
      )}

      <div className="result-cols">
        <PackageFigure images={scan.images} ocr={ocr?.images ?? null} onOpen={(i) => openViewer(i)} />
        <DeclarationsPanel checks={v.checks} images={scan.images.length} onVerify={(c) => openViewer(0, c)} />
      </div>

      <div className="result-links">
        <button
          className="result-link" aria-expanded={drawer === 'provenance'}
          onClick={() => setDrawer(drawer === 'provenance' ? null : 'provenance')}
        >
          <span className="result-link-ico"><IconDoc /></span>
          <span className="result-link-body">
            <b>Evidence &amp; provenance</b>
            <small>{scan.images.length} image{scan.images.length === 1 ? '' : 's'} · {fmtWhen(scan.createdAt)}</small>
          </span>
        </button>
        {scan.engineFindings.length > 0 && (
          <button
            className="result-link" aria-expanded={drawer === 'engine'}
            onClick={() => setDrawer(drawer === 'engine' ? null : 'engine')}
          >
            <span className="result-link-ico"><IconGear /></span>
            <span className="result-link-body">
              <b>Rule-engine cross-check</b>
              <small>{engineSummary(scan.engineFindings)}</small>
            </span>
          </button>
        )}
      </div>

      {drawer === 'provenance' && (
        <section className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head">
            <h2>Evidence &amp; provenance</h2>
            <button className="link-btn" onClick={() => setDrawer(null)}>Close</button>
          </div>
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
            <dt>Reading confidence</dt>
            <dd>
              {v.confidence != null ? `${Math.round(v.confidence * 100)}%` : 'not reported'}
              <small> — reflects OCR legibility, not a degree of legal compliance.</small>
            </dd>
          </dl>
          <h3>Text read from the package</h3>
          <pre className="ocr-dump">{v.ocrText || '(no text was recovered)'}</pre>
        </section>
      )}

      {drawer === 'engine' && (
        <div style={{ marginTop: 16 }}>
          <EngineCrossCheck findings={scan.engineFindings} onClose={() => setDrawer(null)} />
        </div>
      )}

      <ApprovalPanel scan={scan} onChanged={() => setAttempt((n) => n + 1)} />

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
          confidence={v.confidence}
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
            ? { tone: 'not_assessable', icon: '↑', label: 'Referred to super administrator' }
            : { tone: 'needs_review', icon: '…', label: 'Awaiting your admin' };

  const hint = !submitted
    ? 'Your admin does not see this scan until you send it. Add another face first if anything above could not be determined.'
    : sentBack
      ? 'Photograph the package again — retake the faces that could not be read — then send it back for review.'
      : decided
        ? 'This scan has been decided. Scanning the package again starts a fresh case.'
        : 'Your admin decides it from here — the outcome appears on this screen and on your home page.';

  return (
    <section className="approval">
      <span className="approval-ico"><IconPeople size={20} /></span>
      <div className="approval-main">
        <b>Admin approval</b>
        <p className="approval-hint">{hint}</p>
      </div>
      <span className={`chip ${status.tone}`}>
        <span className="ico" aria-hidden="true">{status.icon}</span>{status.label}
      </span>

      {(!submitted || sentBack) && (
        <div className="approval-actions">
          {sentBack && (
            <button className="secondary" onClick={() => nav(`/app/scan/new?scan=${scan.scanId}`)}>
              <IconPlus />Photograph it again
            </button>
          )}
          <button className="primary" onClick={send} disabled={busy}>
            {busy ? 'Sending…' : sentBack ? 'Send to admin again' : 'Send for approval'}
          </button>
        </div>
      )}

      {review && (
        <div className={`approval-note ${review.decision}`}>
          <b>{review.reviewerName ?? 'Your admin'} said:</b>
          <p>{review.reason}</p>
          <small>{fmtWhen(review.createdAt)}</small>
        </div>
      )}

      {error != null && <div style={{ width: '100%' }}><ErrorText error={error} /></div>}
    </section>
  );
}
