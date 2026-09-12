import React from 'react';
import type { ScanStats } from '../api';

// Shared presentation for the console's numbers.
//
// A deliberate constraint runs through this file: the app's status colours (teal /
// red / amber / blue) are safe as STATUS, where every one of them carries an icon
// and a word, but they fail as a categorical chart palette — amber and red are
// ΔE 0.8 apart under deuteranopia and 12.3 apart even in normal vision. So nothing
// here distinguishes two quantities by colour alone: tiles are labelled, and the
// one time-series uses a single hue against a neutral track.

export const fmtWhen = (iso: string | null) =>
  (iso ? new Date(iso).toLocaleString() : '—');
export const fmtDay = (iso: string | null) =>
  (iso ? new Date(iso).toLocaleDateString() : '—');

export interface Tile {
  label: string;
  value: number | string;
  tone?: 'ok' | 'bad' | 'warn' | 'awaiting';
  hint?: string;
}

export function StatTiles({ tiles }: { tiles: Tile[] }) {
  return (
    <div className="rv-stats">
      {tiles.map((t) => (
        <div key={t.label} className={`rv-stat ${t.tone ?? ''}`} title={t.hint}>
          <b>{t.value}</b>
          <span>{t.label}</span>
        </div>
      ))}
    </div>
  );
}

// The standard read of a body of casework, in the order a reviewer asks about it:
// how much is there, how much is still moving, and how it was decided.
export function scanStatTiles(s: ScanStats): Tile[] {
  return [
    { label: 'Cases', value: s.total, hint: 'Every scan captured' },
    { label: 'In progress', value: s.inProgress, hint: 'Captured but not yet analysed' },
    { label: 'Awaiting review', value: s.awaitingReview, tone: 'awaiting', hint: 'Analysed, no decision yet' },
    { label: 'Accepted', value: s.accepted, tone: 'ok' },
    { label: 'Rejected', value: s.rejected, tone: 'bad' },
    { label: 'Sent back', value: s.sentBack, tone: 'warn' },
  ];
}

// A magnitude bar for a table row. One hue, always beside its own number, so the
// bar is a reading aid and never the only way to get the value.
export function MagnitudeBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <span className="rv-mag" aria-hidden="true">
      <span className="rv-mag-fill" style={{ width: `${Math.max(pct, value > 0 ? 3 : 0)}%` }} />
    </span>
  );
}

export function StatusChip({ status }: { status: string }) {
  const tone = status === 'active' ? 'passed'
    : status === 'suspended' ? 'failed'
      : status === 'offboarded' ? 'not_applicable' : 'needs_review';
  const icon = status === 'active' ? '✓' : status === 'suspended' ? '⊘' : '—';
  return (
    <span className={`chip ${tone}`}>
      <span className="ico" aria-hidden="true">{icon}</span>{status}
    </span>
  );
}

// Casework opened per month, and how much of it has been decided.
//
// Two series, so a legend is present; they are separated by hue AND by position
// (decided sits at the base of its own column), and every column carries its month
// under it. A table view sits behind the disclosure for anyone the bars fail.
export function MonthlyThroughput({ data }: {
  data: { month: string; total: number; decided: number }[];
}) {
  const rows = [...data].reverse(); // server returns newest first; read left to right
  if (rows.length === 0) return <p className="muted">No casework recorded yet.</p>;
  const max = Math.max(...rows.map((r) => r.total), 1);

  return (
    <figure className="rv-chart">
      <figcaption>
        <span className="rv-legend">
          <span className="rv-legend-item"><i className="sw decided" />Decided</span>
          <span className="rv-legend-item"><i className="sw open" />Still open</span>
        </span>
      </figcaption>
      <div
        className="rv-bars"
        role="img"
        aria-label={`Cases opened per month over ${rows.length} months, with the decided share of each.`}
      >
        {rows.map((r) => {
          const colH = (r.total / max) * 100;
          const decidedShare = r.total > 0 ? (r.decided / r.total) * 100 : 0;
          return (
            <div className="rv-bar-col" key={r.month}>
              <div
                className="rv-bar-stack"
                style={{ height: `${Math.max(colH, r.total > 0 ? 4 : 0)}%` }}
                title={`${r.month}: ${r.total} opened, ${r.decided} decided`}
              >
                {/* Each segment renders only when it has a value, so the 2px surface
                    gap between them never shows as a notch on a single-segment bar. */}
                {decidedShare < 100 && (
                  <span className="rv-bar-open" style={{ height: `${100 - decidedShare}%` }} />
                )}
                {decidedShare > 0 && (
                  <span className="rv-bar-decided" style={{ height: `${decidedShare}%` }} />
                )}
              </div>
              <small>{r.month.slice(5)}</small>
            </div>
          );
        })}
      </div>
      <details className="rv-table-view">
        <summary>Show as a table</summary>
        <table className="data">
          <thead><tr><th>Month</th><th>Opened</th><th>Decided</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.month}><td>{r.month}</td><td>{r.total}</td><td>{r.decided}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
