import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, VERDICT_META, type ScanCapability, type ScanSummary, type VerdictOverall } from '../api';
import { useAsync } from '../components/common';

// The first screen after sign-in: one action, and what the officer scanned before.

export function ScanHome() {
  const nav = useNavigate();
  const cap = useAsync(() => api.get<ScanCapability>('/scans/capability'), []);
  const recent = useAsync(() => api.get<{ scans: ScanSummary[] }>('/scans?limit=5'), []);
  const scans = recent.data?.scans ?? [];

  return (
    <div className="field-page">
      <section className="scan-cta">
        <h1>Check a product for compliance</h1>
        <p>
          Photograph the package, and PackComply reads the label and checks it against the
          Legal Metrology (Packaged Commodities) Rules, 2011.
        </p>
        <button className="scan-button" onClick={() => nav('/app/scan/new')}>
          <span className="scan-button-ico" aria-hidden="true">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
              <path d="M3 8V5.5A1.5 1.5 0 014.5 4H8M16 4h3.5A1.5 1.5 0 0121 5.5V8M21 16v2.5a1.5 1.5 0 01-1.5 1.5H16M8 20H4.5A1.5 1.5 0 013 18.5V16"
                stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
              <path d="M3 12h18" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
            </svg>
          </span>
          Scan the product
        </button>
        {cap.data && !cap.data.rules.available && (
          <p className="warn-box" style={{ maxWidth: 520, margin: '16px auto 0' }}>
            The statutory rules text has not been loaded on this server, so a compliance
            assessment cannot be produced yet.
          </p>
        )}
        {cap.data?.judge.isMock && (
          <p className="warn-box" style={{ maxWidth: 520, margin: '16px auto 0' }}>
            No AI model is configured on this server. Scans will fall back to the built-in
            pattern-matching rule engine, which does not read the 2011 Rules.
          </p>
        )}
      </section>

      <section className="field-panel">
        <div className="field-panel-head">
          <h2>Recent scans</h2>
          <Link to="/app/history">View all</Link>
        </div>
        {recent.loading && <p className="muted">Loading…</p>}
        {!recent.loading && scans.length === 0 && (
          <p className="muted">No scans yet. Your scanned products will appear here.</p>
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
