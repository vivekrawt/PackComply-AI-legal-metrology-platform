import React from 'react';
import type { AuditorPeriods, PeriodStats, ScanStats } from '../api';

// Shared presentation for the console's numbers.
//
// A deliberate constraint runs through this file: the app's status colours (green /
// red / amber / blue) are safe as STATUS, where every one of them carries a word,
// but they fail as a categorical chart palette — amber and red are ΔE 0.8 apart
// under deuteranopia and 12.3 apart even in normal vision. So nothing here
// distinguishes two quantities by colour alone: tiles are labelled, and the one
// time-series separates its two series by position as well as by hue.

export const fmtWhen = (iso: string | null) =>
  (iso ? new Date(iso).toLocaleString(undefined, {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }) : '—');
export const fmtDay = (iso: string | null) =>
  (iso ? new Date(iso).toLocaleDateString(undefined, {
    day: '2-digit', month: 'short', year: 'numeric',
  }) : '—');

export interface Tile {
  label: string;
  value: number | string;
  tone?: 'ok' | 'bad' | 'warn' | 'awaiting';
  hint?: string;
  // Only where the row counts different kinds of thing — people, teams — and the
  // glyph does the sorting the eye would otherwise do by reading every label.
  icon?: React.ReactNode;
}

// Big number over its label, divided by hairlines: one sentence about a body of
// work, rather than a row of cards competing to be read first.
export function StatTiles({ tiles, plain }: { tiles: Tile[]; plain?: boolean }) {
  return (
    <div className={`rv-stats${plain ? ' plain' : ''}`}>
      {tiles.map((t) => (
        <div key={t.label} className={`rv-stat ${t.tone ?? ''} ${t.icon ? 'iconed' : ''}`} title={t.hint}>
          {t.icon && <span className="rv-stat-ico" aria-hidden="true">{t.icon}</span>}
          <div>
            <b>{t.value}</b>
            <span>{t.label}</span>
          </div>
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
    { label: 'Awaiting', value: s.awaitingReview, tone: 'awaiting', hint: 'Analysed, no decision yet' },
    { label: 'Accepted', value: s.accepted, tone: 'ok' },
    { label: 'Rejected', value: s.rejected, tone: 'bad' },
    { label: 'Sent back', value: s.sentBack, tone: 'warn' },
    { label: 'Referred', value: s.escalated, hint: 'Passed to a super administrator to decide' },
  ];
}

// What an auditor got through today, this week and this month. Calendar periods,
// so "this week" means the week the reader is standing in.
const PERIOD_LABELS: { key: keyof AuditorPeriods; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
];

export function PeriodPanel({ periods, detail }: { periods: AuditorPeriods; detail?: boolean }) {
  const cols: { key: keyof PeriodStats; label: string }[] = [
    { key: 'captured', label: 'Captured' },
    { key: 'accepted', label: 'Accepted' },
    { key: 'rejected', label: 'Rejected' },
    { key: 'sentBack', label: 'Sent back' },
  ];
  return (
    <div className="rv-periods">
      {PERIOD_LABELS.map(({ key, label }) => {
        const p = periods[key];
        return (
          <div className="rv-period" key={key}>
            <h3>{label}</h3>
            <b className="rv-period-hero">{p.completed}</b>
            <span className="rv-period-hero-label">completed</span>
            {detail && (
              <dl>
                {cols.map((c) => (
                  <React.Fragment key={c.key}>
                    <dt>{c.label}</dt><dd>{p[c.key]}</dd>
                  </React.Fragment>
                ))}
              </dl>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Row actions, folded into one control.
//
// A people table carries three or four verbs per row — open, suspend, delete —
// and spelling them all out turns every row into a control panel. Folded away,
// the row is a person again, and the destructive verb is one deliberate step
// further from the pointer than the safe one.
export function RowMenu({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [open]);

  return (
    <div className="rv-menu" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button
        className="rv-menu-btn" aria-haspopup="menu" aria-expanded={open}
        aria-label={label} onClick={() => setOpen(!open)}
      >
        •••
      </button>
      {open && (
        <div className="rv-menu-list" role="menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
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
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span className={`chip ${tone}`}>
      <span className="ico" aria-hidden="true">{icon}</span>{label}
    </span>
  );
}

// Casework opened per month, and how much of it has been decided.
//
// Two series, so a legend is present; they are separated by hue AND by position
// (each month's pair sits side by side in a fixed order), and every column carries
// its month under it. A table view sits behind the disclosure for anyone the bars
// fail — including a screen reader, which gets the numbers rather than a picture.
export function MonthlyThroughput({ data }: {
  data: { month: string; total: number; decided: number }[];
}) {
  const rows = [...data].reverse(); // server returns newest first; read left to right
  if (rows.length === 0) return <p className="muted">No casework recorded yet.</p>;

  const peak = Math.max(...rows.map((r) => r.total), 1);
  // A round ceiling, so the gridline labels are numbers a reader recognises.
  const step = peak <= 5 ? 1 : peak <= 15 ? 5 : Math.ceil(peak / 15) * 5;
  const top = Math.ceil(peak / step) * step;
  const lines = Array.from({ length: top / step + 1 }, (_, i) => i * step).reverse();

  return (
    <figure className="rv-chart">
      <div className="rv-plot">
        {lines.map((value) => (
          <div
            key={value} className="rv-grid-line" aria-hidden="true"
            style={{ top: `${(1 - value / top) * 150}px` }}
          >
            <span>{value}</span>
          </div>
        ))}
        <div
          className="rv-bars"
          role="img"
          aria-label={`Cases opened per month over ${rows.length} months, with the decided share of each.`}
        >
          {rows.map((r) => (
            <div className="rv-bar-col" key={r.month}>
              <div className="rv-bar-stack" title={`${r.month}: ${r.total} opened, ${r.decided} decided`}>
                <span className="rv-bar-decided" style={{ height: `${(r.decided / top) * 100}%` }} />
                <span className="rv-bar-open" style={{ height: `${((r.total - r.decided) / top) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
        <div className="rv-months" aria-hidden="true">
          {rows.map((r) => <small key={r.month}>{monthLabel(r.month)}</small>)}
        </div>
      </div>

      <figcaption>
        <span className="rv-legend">
          <span className="rv-legend-item"><i className="sw decided" />Decided</span>
          <span className="rv-legend-item"><i className="sw open" />Still open</span>
        </span>
      </figcaption>

      <details className="rv-table-view">
        <summary>Show as a table</summary>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Month</th><th className="num">Opened</th><th className="num">Decided</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.month}><td>{r.month}</td><td className="num">{r.total}</td><td className="num">{r.decided}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

// "2026-09" reads as a month, not as a number, once it carries its name.
function monthLabel(month: string) {
  const [y, m] = month.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return Number.isNaN(d.getTime())
    ? month
    : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}
