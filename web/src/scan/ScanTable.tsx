import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { VERDICT_META, type ScanSummary, type VerdictOverall } from '../api';

// The officer's list of packages, as a table.
//
// One implementation behind the home page and the history page, because they are
// the same list at two lengths — and a scan that reads one way on the dashboard and
// another way in history would be two records as far as the reader is concerned.
//
// In a table the assessment is a column, so it is stated in the shortest words that
// remain true: "Ready" and "Not ready" are the same judgements the result screen
// spells out in full, not softer ones.
const SHORT: Record<VerdictOverall, string> = {
  compliant: 'Ready',
  non_compliant: 'Not ready',
  needs_review: 'Needs review',
};

export function scanTitle(s: ScanSummary) {
  return s.brand || s.genericName || 'Unnamed product';
}

export function AssessmentCell({ scan }: { scan: ScanSummary }) {
  const v = scan.verdict ? VERDICT_META[scan.verdict as VerdictOverall] : null;
  const label = v
    ? SHORT[scan.verdict as VerdictOverall]
    : scan.status === 'analyzing' ? 'Analysing' : 'Not analysed';
  return (
    <span className={`chip ${v ? v.tone : 'neutral'}`} role="status">
      <span className="ico" aria-hidden="true">{v ? v.icon : '·'}</span>{label}
    </span>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

export function ScanTable({ scans }: { scans: ScanSummary[] }) {
  const nav = useNavigate();
  return (
    <div className="table-wrap">
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>Product</th>
              <th className="when">Scanned</th>
              <th className="imgs num">Images</th>
              <th>Assessment</th>
              <th className="go">Action</th>
            </tr>
          </thead>
          <tbody>
            {scans.map((s) => (
              <tr key={s.scanId} className="clickable" onClick={() => nav(`/app/scan/${s.scanId}`)}>
                <td>
                  {/* The link carries the row for anyone not using a pointer. */}
                  <Link className="row-link" to={`/app/scan/${s.scanId}`} onClick={(e) => e.stopPropagation()}>
                    {scanTitle(s)}
                  </Link>
                  {/* On a phone there is no room for a "Scanned" column, and a date
                      squeezed into one wraps to four lines. It folds under the product
                      instead — the same two facts, in the space actually available. */}
                  <span className="cell-sub only-narrow">
                    {when(s.createdAt)} · {s.imageCount} image{s.imageCount === 1 ? '' : 's'}
                  </span>
                </td>
                <td className="when nowrap">{when(s.createdAt)}</td>
                <td className="imgs num">{s.imageCount}</td>
                <td><AssessmentCell scan={s} /></td>
                <td className="go" />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
