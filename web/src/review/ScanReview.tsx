import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  api, REVIEW_META, SIDE_LABELS, VERDICT_META,
  type ComplianceCheck, type ReviewDecision, type Scan, type ScanOcr, type ScanReview as Review,
} from '../api';
import { AuthContext } from '../App';
import { ErrorText } from '../components/common';
import { EvidenceStrip, EvidenceViewer } from '../scan/EvidenceViewer';
import { CheckGroup, EngineCrossCheck } from '../scan/ChecksView';

// One scan, as the reviewer has to judge it.
//
// The left column is exactly what the field officer was shown — same verdict, same
// grouped checks, same evidence viewer. That is deliberate: a sign-off has to be a
// decision about the document that was actually produced, not about a reviewer-only
// summary of it. The right column is the part the officer never sees: the decision,
// its mandatory reason, and the history of every decision taken before it.

// An admin can refer a case upward instead of settling it. A super administrator
// cannot — there is nobody above them, so the option would go nowhere.
const ADMIN_DECISIONS: ReviewDecision[] = ['accepted', 'rejected', 'recapture_requested', 'escalated'];
const SUPER_DECISIONS: ReviewDecision[] = ['accepted', 'rejected', 'recapture_requested'];

export function ScanReview() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can, user } = React.useContext(AuthContext);
  const [scan, setScan] = React.useState<Scan | null>(null);
  const [ocr, setOcr] = React.useState<ScanOcr | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [viewer, setViewer] = React.useState<{ at: number; check?: ComplianceCheck } | null>(null);

  const load = React.useCallback(async () => {
    try {
      const s = await api.get<Scan>(`/scans/${id}`);
      setScan(s);
      if (s.status !== 'analyzing' && s.status !== 'capturing') {
        api.get<ScanOcr>(`/scans/${id}/ocr`).then(setOcr).catch(() => { /* viewer degrades to plain images */ });
      }
    } catch (err) { setError(err); }
  }, [id]);

  React.useEffect(() => { load(); }, [load]);

  if (error && !scan) return <div className="rv-body"><ErrorText error={error} /></div>;
  if (!scan) return <div className="rv-body"><p className="muted">Loading…</p></div>;

  const v = scan.verdict;
  const meta = v ? VERDICT_META[v.overall] : null;
  const satisfied = v?.checks.filter((c) => c.status === 'present') ?? [];
  const missing = v?.checks.filter((c) => c.status === 'missing') ?? [];
  const unclear = v?.checks.filter((c) => c.status === 'unclear') ?? [];
  const product = scan.product?.brand || scan.product?.genericName || 'Unnamed product';
  const openViewer = (at: number, check?: ComplianceCheck) => setViewer({ at, check });

  const remove = async () => {
    const reason = window.prompt('Why is this scan being deleted? (recorded in the audit log)');
    if (!reason) return;
    setError(null);
    try {
      await api.del(`/inspections/${id}`, { reason });
      nav('/app');
    } catch (err) { setError(err); }
  };

  return (
    <>
      <header className="rv-head">
        <div>
          <button className="rv-back" onClick={() => nav('/app')}>← Review queue</button>
          <h1>{product}</h1>
          <p>
            Captured by {scan.officer?.name ?? 'an unknown auditor'}
            {scan.team ? ` · ${scan.team.name}` : ''} ·{' '}
            {new Date(scan.createdAt).toLocaleString()} · {scan.images.length} image
            {scan.images.length === 1 ? '' : 's'}
            {scan.location ? ` · ${scan.location}` : ''}
          </p>
        </div>
        <div className="rv-head-actions">
          <a className="btn secondary" href={`/api/v1/scans/${scan.scanId}/report.pdf`} target="_blank" rel="noreferrer">
            ⭳ Report (PDF)
          </a>
          {can('inspection.delete') && <button className="danger" onClick={remove}>Delete scan</button>}
        </div>
      </header>

      <div className="rv-body">
        <ErrorText error={error} />

        {!v || scan.status === 'analyzing' || scan.status === 'capturing' ? (
          <div className="rv-empty">
            <b>{scan.status === 'analyzing' ? 'Still being analysed' : 'Not analysed yet'}</b>
            <p>There is no assessment to review until the officer has captured and analysed this package.</p>
          </div>
        ) : (
          <div className="rv-detail">
            <div>
              <div className={`verdict-banner ${meta!.tone}`}>
                <span className="verdict-ico" aria-hidden="true">{meta!.icon}</span>
                <div>
                  <h1>{meta!.label}</h1>
                  <p>{meta!.blurb}</p>
                </div>
              </div>

              {v.error && (
                <p className="warn-box">
                  <b>The analysis did not complete.</b> {v.error} — there is no assessment to accept;
                  send the scan back for re-capture instead.
                </p>
              )}
              {/* The reviewer's signature is the regulatory act, so they of all people
                  must not sign off on a package the system only partly read. */}
              {scan.images.some((i) => !i.read) && (
                <p className="warn-box" role="alert">
                  <b>
                    {scan.images.filter((i) => !i.read).length} of {scan.images.length} images were
                    never read.
                  </b>{' '}
                  The {scan.images.filter((i) => !i.read)
                    .map((i) => (SIDE_LABELS[i.side ?? ''] ?? i.side ?? 'unlabelled').toLowerCase())
                    .join(', ')} face(s) were photographed but the text recogniser never ran on them.
                  This assessment was made without them, so nothing in it establishes that a
                  declaration is absent from the package. Send it back to be read again rather than
                  deciding on it.
                </p>
              )}
              {v.isMock && !v.error && (
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

              {scan.engineFindings.length > 0 && <EngineCrossCheck findings={scan.engineFindings} />}
            </div>

            <aside className="rv-side">
              <SignOff scan={scan} onDone={load} canReview={can('scan.review')}
                isSuper={user?.role === 'super_admin'} />

              <section className="rv-panel">
                <h2>Provenance</h2>
                <dl className="rv-facts">
                  <dt>Assessed by</dt>
                  <dd>{v.provider} · {v.modelVersion}{v.isMock ? ' (not an AI assessment)' : ''}</dd>
                  <dt>Statutory text</dt>
                  <dd>
                    {v.rulesSources.length ? v.rulesSources.join(', ') : 'none'}
                    {v.rulesSha256 ? <><br /><code className="mono">sha256 {v.rulesSha256.slice(0, 20)}…</code></> : null}
                  </dd>
                  <dt>Faces captured</dt>
                  <dd>{scan.images.map((i) => SIDE_LABELS[i.side ?? ''] ?? i.side ?? 'unlabelled').join(', ') || 'none'}</dd>
                  <dt>Reading confidence</dt>
                  <dd>{v.confidence != null ? `${Math.round(v.confidence * 100)}%` : 'not reported'}</dd>
                  <dt>Event date</dt>
                  <dd>{scan.eventDate}</dd>
                </dl>
                <p className="rv-note">
                  Confidence reflects OCR legibility, not a degree of legal compliance.
                </p>
              </section>
            </aside>
          </div>
        )}
      </div>

      {viewer && (
        <EvidenceViewer
          images={scan.images}
          ocr={ocr?.images ?? null}
          startAt={viewer.at}
          highlight={viewer.check ? { check: viewer.check } : null}
          onClose={() => setViewer(null)}
        />
      )}
    </>
  );
}

function SignOff({ scan, onDone, canReview, isSuper }: {
  scan: Scan; onDone: () => void; canReview: boolean; isSuper: boolean;
}) {
  const [decision, setDecision] = React.useState<ReviewDecision | null>(null);
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);

  const current = scan.review;
  const prior = scan.reviews.filter((r) => r.id !== current?.id);
  // A verdict carrying an error records that the judge never ran, and the API
  // refuses acceptance of one. Offering the button anyway would be offering a
  // control the server will reject, so it is disabled with the reason attached —
  // sending the scan back stays available, because that is the right answer here.
  const noAssessment = !!scan.verdict?.error;
  // Decision precedence: a super administrator's decision is final. The server
  // refuses an admin's attempt to replace it, so the form is closed here rather
  // than offering a control that would be rejected.
  const lockedBySuper = !!current?.final && !isSuper;
  // Referred upward: the admin who raised it has handed the case over and cannot
  // decide it further until a super administrator answers.
  const referredUp = !!current?.awaitingSuperAdmin && !isSuper;
  const decisions = isSuper ? SUPER_DECISIONS : ADMIN_DECISIONS;
  // Re-deciding is legitimate — a package re-analysed after a send-back needs a
  // fresh decision — so the form stays available with the standing decision shown
  // above it rather than being locked away behind an edit button.
  const submit = async () => {
    if (!decision) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/scans/${scan.scanId}/review`, { decision, reason });
      setDecision(null); setReason('');
      onDone();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  if (!canReview || lockedBySuper || referredUp) {
    return (
      <section className="rv-panel">
        <h2>Reviewer decision</h2>
        {current ? <CurrentDecision review={current} /> : <p className="muted">No decision has been recorded yet.</p>}
        {lockedBySuper && (
          <p className="warn-box">
            This case was decided by a super administrator. That decision is final and cannot be
            changed at admin level — raise it with them if you believe it should be revisited.
          </p>
        )}
        {referredUp && (
          <p className="warn-box">
            You referred this case to a super administrator. It is waiting on their decision and
            cannot be decided here until they have answered it.
          </p>
        )}
        {prior.length > 0 && (
          <>
            <h2 style={{ margin: '18px 0 0' }}>Earlier decisions</h2>
            <ul className="rv-history">
              {prior.map((r) => (
                <li key={r.id} className={r.decision}>
                  <b>{REVIEW_META[r.decision].label}</b>{' '}
                  <small>by {r.reviewerName ?? 'unknown'} · {new Date(r.createdAt).toLocaleString()}</small>
                  <p>{r.reason}</p>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    );
  }

  return (
    <section className="rv-panel rv-signoff">
      <h2 className="tight">Reviewer decision</h2>
      <p className="muted" style={{ margin: '0 0 12px', fontSize: '0.8rem' }}>
        Your decision and its reason are written to the tamper-evident audit log.
      </p>

      {current && <CurrentDecision review={current} />}

      {isSuper && current?.awaitingSuperAdmin && (
        <p className="warn-box">
          <b>{current.reviewerName ?? 'An admin'} referred this case to you.</b> Their reason is
          above — your decision clears it, and cannot be changed at admin level afterwards.
        </p>
      )}

      <div className="rv-decisions" role="group" aria-label="Decision">
        {decisions.map((d) => {
          const m = REVIEW_META[d];
          const blocked = noAssessment && d === 'accepted';
          return (
            <button
              key={d}
              type="button"
              className={`rv-decision ${d} ${decision === d ? 'on' : ''}`}
              aria-pressed={decision === d}
              disabled={blocked}
              title={blocked ? 'The analysis did not complete, so there is no assessment to accept.' : undefined}
              onClick={() => setDecision(decision === d ? null : d)}
            >
              <span className="rv-decision-ico" aria-hidden="true">{m.icon}</span>
              <span>
                {m.verb}
                <small>{blocked ? 'Unavailable — the analysis did not complete.' : m.blurb}</small>
              </span>
            </button>
          );
        })}
      </div>

      <label className="field">
        Reason {decision ? '(required)' : ''}
        <textarea
          className="rv-reason"
          value={reason}
          disabled={!decision}
          onChange={(e) => setReason(e.target.value)}
          placeholder={decision
            ? 'What did you check, and why does it support this decision?'
            : 'Choose a decision first'}
        />
      </label>

      <ErrorText error={error} />
      <button
        className="primary wide"
        disabled={busy || !decision || reason.trim().length < 5}
        onClick={submit}
      >
        {busy ? 'Recording…' : current ? 'Record new decision' : 'Record decision'}
      </button>

      {prior.length > 0 && (
        <>
          <h2 style={{ margin: '18px 0 0' }}>Earlier decisions</h2>
          <ul className="rv-history">
            {prior.map((r) => (
              <li key={r.id} className={r.decision}>
                <b>{REVIEW_META[r.decision].label}</b>{' '}
                <small>by {r.reviewerName ?? 'unknown'} · {new Date(r.createdAt).toLocaleString()}</small>
                <p>{r.reason}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function CurrentDecision({ review }: { review: Review }) {
  const m = REVIEW_META[review.decision];
  return (
    <div className={`rv-current ${review.decision}`}>
      <b>{m.icon} {m.label}</b> by {review.reviewerName ?? 'unknown'}
      {review.final && <span className="rv-final-tag" title="A super administrator's decision outranks an admin's">final</span>}
      <p>{review.reason}</p>
      <small>{new Date(review.createdAt).toLocaleString()}</small>
      {review.stale && (
        <small>
          ⚠ This package has been re-analysed since — the decision above was taken against an
          earlier assessment and needs to be made again.
        </small>
      )}
    </div>
  );
}
