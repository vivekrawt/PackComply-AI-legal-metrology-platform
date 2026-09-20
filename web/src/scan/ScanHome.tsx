import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type ScanCapability, type ScanSummary } from '../api';
import { useAsync } from '../components/common';
import { IconImage, IconRefresh } from '../components/icons';
import { ScanTable } from './ScanTable';

// The first screen after sign-in: one action, what it will do, and what the
// officer scanned before.
//
// The three steps sit under the heading because the cost of a scan is walking to a
// shelf and photographing a packet — knowing what happens next is worth more here
// than a second button. Whether this device can actually produce an assessment is
// stated on the same line, before the officer commits to the walk rather than after.

const STEPS = [
  { title: 'Photograph', hint: 'Capture every visible side' },
  { title: 'Read', hint: 'Read the label text' },
  { title: 'Check', hint: 'Review each declaration' },
];

export function ScanHome() {
  const nav = useNavigate();
  const cap = useAsync(() => api.get<ScanCapability>('/scans/capability'), []);
  const recent = useAsync(() => api.get<{ scans: ScanSummary[] }>('/scans?limit=50'), []);
  const all = recent.data?.scans ?? [];
  const scans = all.slice(0, 5);
  // Packages a reviewer has handed back. This is work assigned to this officer, so
  // it sits above everything else — a re-check that is never noticed is the same as
  // one that was never asked for.
  const needsRecheck = all.filter(
    (s) => s.review?.decision === 'recapture_requested' && !s.review.stale,
  );

  // Counts over the recent window only — labelled as such, never presented as
  // enforcement statistics.
  const tally = scans.reduce(
    (acc, s) => {
      if (s.verdict === 'compliant') acc.ok += 1;
      else if (s.verdict === 'non_compliant') acc.bad += 1;
      else if (s.verdict === 'needs_review') acc.review += 1;
      return acc;
    },
    { ok: 0, bad: 0, review: 0 },
  );
  const ready = cap.data ? cap.data.rules.available && !cap.data.judge.isMock : null;
  const sources = cap.data?.rules.sources.length ?? 0;

  return (
    <div className="field-page">
      {needsRecheck.length > 0 && (
        <section className="recheck-banner">
          <h2>
            <IconRefresh size={18} />
            {needsRecheck.length} product{needsRecheck.length === 1 ? '' : 's'} to check again
          </h2>
          <p>
            Your admin sent {needsRecheck.length === 1 ? 'this one' : 'these'} back — photograph
            the package again and send it for review.
          </p>
          <ScanTable scans={needsRecheck} />
        </section>
      )}

      <p className="field-eyebrow">Legal Metrology (Packaged Commodities) Rules, 2011</p>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Check a product for compliance</h1>
          <p className="page-sub">Photograph the package. Review the declarations. Keep the evidence.</p>
        </div>
        <div className="page-head-actions">
          <button className="primary" onClick={() => nav('/app/scan/new')}>Scan the product</button>
        </div>
      </div>

      <ol className="pc-steps">
        {STEPS.map((s, i) => (
          <React.Fragment key={s.title}>
            {i > 0 && <li className="pc-step-line" aria-hidden="true" />}
            <li className="pc-step off">
              <span className="pc-step-num">{i + 1}</span>
              <span className="pc-step-text"><b>{s.title}</b><small>{s.hint}</small></span>
            </li>
          </React.Fragment>
        ))}
      </ol>

      <div className="ready-line">
        <span className={`chip ${ready === null ? 'neutral' : ready ? 'passed' : 'needs_review'}`} role="status">
          <span className="ico" aria-hidden="true">·</span>
          {ready === null ? 'Checking this device…' : ready ? 'Ready to scan' : 'Limited assessment'}
        </span>
        {cap.data && (
          <>
            <span className="divider" aria-hidden="true" />
            <span className="fact">
              {cap.data.rules.available
                ? `${sources} statutory source${sources === 1 ? '' : 's'} loaded`
                : 'No statutory source loaded'}
            </span>
            {cap.data.judge.isMock && (
              <>
                <span className="divider" aria-hidden="true" />
                <span className="fact">Pattern matcher only — no AI model configured</span>
              </>
            )}
          </>
        )}
      </div>

      {cap.data && !cap.data.rules.available && (
        <p className="warn-box">
          The statutory rules text has not been loaded on this server, so a compliance
          assessment cannot be produced yet.
        </p>
      )}
      {cap.data?.judge.isMock && (
        <p className="warn-box">
          No AI model is configured on this server. Scans will fall back to the built-in
          pattern-matching rule engine, which does not read the 2011 Rules.
        </p>
      )}

      {scans.length > 0 && (
        <>
          <h2 className="section-title">Last {scans.length} scan{scans.length === 1 ? '' : 's'}</h2>
          <div className="pc-stats">
            <div className="pc-stat"><b>{tally.ok}</b><span>Ready</span></div>
            <div className="pc-stat"><b>{tally.bad}</b><span>Not ready</span></div>
            <div className="pc-stat"><b>{tally.review}</b><span>Needs review</span></div>
          </div>
        </>
      )}

      <h2 className="section-title">Recent scans</h2>
      {recent.loading && <p className="muted">Loading…</p>}
      {!recent.loading && scans.length === 0 && (
        <div className="scan-empty">
          <span aria-hidden="true"><IconImage size={30} /></span>
          <b>No scans yet</b>
          <p>Scan a packet and it will appear here with its assessment and report.</p>
        </div>
      )}
      {scans.length > 0 && (
        <>
          <ScanTable scans={scans} />
          <p style={{ margin: '18px 0 0' }}><Link to="/app/history">View all scans</Link></p>
        </>
      )}
    </div>
  );
}
