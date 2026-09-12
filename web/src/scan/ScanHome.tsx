import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, VERDICT_META, type ScanCapability, type ScanSummary, type VerdictOverall } from '../api';
import { useAsync } from '../components/common';

// The first screen after sign-in: one action, what it will do, and what the
// officer scanned before.
//
// The hero states the three steps before the officer commits to anything, because
// the cost of a scan is walking to a shelf and photographing a packet — knowing
// what happens next is worth more here than another button.

export function ScanHome() {
  const nav = useNavigate();
  const cap = useAsync(() => api.get<ScanCapability>('/scans/capability'), []);
  const recent = useAsync(() => api.get<{ scans: ScanSummary[] }>('/scans?limit=5'), []);
  const scans = recent.data?.scans ?? [];

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

  return (
    <div className="field-page">
      <section className="scan-hero">
        <div className="scan-hero-copy">
          <span className="scan-hero-badge">
            <span className="dot" aria-hidden="true" />
            Legal Metrology (Packaged Commodities) Rules, 2011
          </span>
          <h1>Check a product for compliance</h1>
          <p>
            Photograph the package. PackComply reads the label and checks it against the 2011 Rules,
            then shows you exactly where each declaration was found — or was not.
          </p>
          <button className="scan-button" onClick={() => nav('/app/scan/new')}>
            <span className="scan-button-ico" aria-hidden="true">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                <path d="M3 8V5.5A1.5 1.5 0 014.5 4H8M16 4h3.5A1.5 1.5 0 0121 5.5V8M21 16v2.5a1.5 1.5 0 01-1.5 1.5H16M8 20H4.5A1.5 1.5 0 013 18.5V16"
                  stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                <path d="M3 12h18" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
              </svg>
            </span>
            Scan the product
          </button>
          <ol className="scan-steps">
            <li><b>Photograph</b><span>One side is enough; more is better</span></li>
            <li><b>Read</b><span>Text is lifted off the label</span></li>
            <li><b>Check</b><span>Every mandatory declaration, cited</span></li>
          </ol>
        </div>

        <aside className="scan-hero-side">
          <div className={`scan-status-card ${ready === null ? '' : ready ? 'ok' : 'warn'}`}>
            <b>
              {ready === null ? 'Checking this device…'
                : ready ? 'Ready to scan' : 'Limited assessment'}
            </b>
            {cap.data && (
              <ul>
                <li className={cap.data.rules.available ? 'yes' : 'no'}>
                  <span aria-hidden="true">{cap.data.rules.available ? '✓' : '✕'}</span>
                  {cap.data.rules.available
                    ? `Statutory text loaded (${cap.data.rules.sources.length} source${cap.data.rules.sources.length === 1 ? '' : 's'})`
                    : 'Statutory text not loaded on this server'}
                </li>
                <li className={cap.data.judge.isMock ? 'no' : 'yes'}>
                  <span aria-hidden="true">{cap.data.judge.isMock ? '✕' : '✓'}</span>
                  {cap.data.judge.isMock
                    ? 'No AI model configured — pattern matcher only'
                    : `Assessed by ${cap.data.judge.modelVersion}`}
                </li>
              </ul>
            )}
          </div>

          {scans.length > 0 && (
            <div className="scan-tally-card">
              <h2>Your last {scans.length} scan{scans.length === 1 ? '' : 's'}</h2>
              <div className="scan-tally">
                <div className="ok"><b>{tally.ok}</b><span>ready</span></div>
                <div className="bad"><b>{tally.bad}</b><span>not ready</span></div>
                <div className="warn"><b>{tally.review}</b><span>review</span></div>
              </div>
            </div>
          )}
        </aside>
      </section>

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

      <section className="field-panel">
        <div className="field-panel-head">
          <h2>Recent scans</h2>
          <Link to="/app/history">View all</Link>
        </div>
        {recent.loading && <p className="muted">Loading…</p>}
        {!recent.loading && scans.length === 0 && (
          <div className="scan-empty">
            <span aria-hidden="true">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
                <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
                <path d="M3 15l4.5-4.5L12 15l3-3 6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <b>No scans yet</b>
            <p>Scan a packet and it will appear here with its verdict and report.</p>
          </div>
        )}
        <ul className="scan-list">
          {scans.map((s) => <ScanRow key={s.scanId} scan={s} />)}
        </ul>
      </section>
    </div>
  );
}

export function ScanRow({ scan }: { scan: ScanSummary }) {
  const v = scan.verdict ? VERDICT_META[scan.verdict as VerdictOverall] : null;
  const title = scan.brand || scan.genericName || 'Unnamed product';
  return (
    <li>
      <Link to={`/app/scan/${scan.scanId}`} className="scan-row">
        <span className={`chip ${v ? v.tone : 'neutral'}`}>
          <span className="ico" aria-hidden="true">{v ? v.icon : '·'}</span>
          {v ? v.label : scan.status === 'processing' ? 'Analysing' : 'Not analysed'}
        </span>
        <span className="scan-row-main">
          <b>{title}</b>
          <small>
            {new Date(scan.createdAt).toLocaleString()} · {scan.imageCount} image{scan.imageCount === 1 ? '' : 's'}
            {scan.verdictIsMock ? ' · rule engine only' : ''}
          </small>
        </span>
        <span className="scan-row-go" aria-hidden="true">→</span>
      </Link>
    </li>
  );
}
