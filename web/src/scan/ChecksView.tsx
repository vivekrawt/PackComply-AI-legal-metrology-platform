import React from 'react';
import type { ComplianceCheck, Scan } from '../api';
import { IconGear } from '../components/icons';

// How a compliance assessment is presented, shared by the officer's result screen
// and the reviewer's sign-off screen.
//
// Both audiences need the same thing from it — what the package is missing, what
// could not be determined, and what it got right — so they read one implementation.
// A reviewer judging an officer's scan must be looking at exactly what the officer
// was shown, or the sign-off is about a different document than the one that was
// produced.
//
// It is a table rather than three stacked cards because a declaration is a row in a
// statute: a name, the rule that requires it, and whether it is there. The reasoning
// behind a row — what was read, what is wrong with it, how to fix it — opens under
// the row itself, so the detail is always attached to the claim it explains.

export const STATUS_META: Record<string, { label: string; tone: string; icon: string }> = {
  present: { label: 'Met', tone: 'passed', icon: '✓' },
  missing: { label: 'Missing', tone: 'failed', icon: '✕' },
  unclear: { label: 'Unclear', tone: 'needs_review', icon: '?' },
};

type Filter = 'all' | 'missing' | 'unclear' | 'present';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'missing', label: 'Missing' },
  { key: 'unclear', label: 'Unclear' },
  { key: 'present', label: 'Met' },
];

export function DeclarationsPanel({ checks, images, onVerify }: {
  checks: ComplianceCheck[];
  images: number;
  onVerify: (c: ComplianceCheck) => void;
}) {
  const [filter, setFilter] = React.useState<Filter>('all');
  // Anything unsettled is worth reading first, so the row that needs the officer
  // is open when the screen arrives rather than one click away.
  const firstOpen = checks.findIndex((c) => c.status !== 'present');
  const [open, setOpen] = React.useState<number | null>(firstOpen >= 0 ? firstOpen : null);

  const count = (f: Filter) => (f === 'all' ? checks.length : checks.filter((c) => c.status === f).length);
  const rows = checks
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => filter === 'all' || c.status === filter);

  if (checks.length === 0) {
    return (
      <section className="panel">
        <h2>Declarations</h2>
        <p className="muted">No declarations were assessed for this package.</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Declarations</h2>

      <div className="pc-filters" role="group" aria-label="Filter declarations by status">
        {FILTERS.filter((f) => count(f.key) > 0).map((f) => (
          <button
            key={f.key}
            className={`filter-chip ${filter === f.key ? 'on' : ''}`}
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            {f.label} ({count(f.key)})
          </button>
        ))}
      </div>

      <div className="table-wrap">
        <div className="table-scroll">
          <table className="data decl-table">
            <thead>
              <tr>
                <th style={{ width: 34 }}><span className="sr-only">Expand</span></th>
                <th>Declaration</th>
                <th>Rule</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ c, i }) => {
                const m = STATUS_META[c.status] ?? { label: c.status, tone: 'neutral', icon: '·' };
                const isOpen = open === i;
                return (
                  <React.Fragment key={`${c.parameter}-${i}`}>
                    <tr className={isOpen ? `open ${m.tone}` : ''}>
                      <td>
                        <button
                          type="button" className="decl-toggle"
                          aria-expanded={isOpen}
                          aria-label={`${isOpen ? 'Hide' : 'Show'} the finding for ${c.parameter}`}
                          onClick={() => setOpen(isOpen ? null : i)}
                        >
                          {isOpen ? '⌄' : '›'}
                        </button>
                      </td>
                      <td className="decl-name">{c.parameter}</td>
                      <td className="rule">{c.ruleReference || '—'}</td>
                      <td>
                        <span className={`chip ${m.tone}`}>
                          <span className="ico" aria-hidden="true">{m.icon}</span>{m.label}
                        </span>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className={`decl-detail ${m.tone}`}>
                        <td colSpan={4}>
                          <div className={`decl-detail-box ${m.tone}`}>
                            <div className="decl-detail-text">
                              {/* For a satisfied check the quote is the declaration
                                  itself; for a failed one it is whatever partial text
                                  was found, which is not the same claim — so the label
                                  follows the status. */}
                              {c.observedText && (
                                <p>
                                  {c.status === 'present' ? 'Found on the package:' : 'Related text on the package:'}
                                  <span className="decl-quote">&ldquo;{c.observedText}&rdquo;</span>
                                </p>
                              )}
                              {c.issue && <p>{c.issue}</p>}
                              {c.remedy && <p className="decl-remedy"><b>To fix:</b> {c.remedy}</p>}
                              {!c.observedText && !c.issue && !c.remedy && (
                                <p className="muted">Nothing further was recorded for this declaration.</p>
                              )}
                            </div>
                            {images > 0 && (
                              <button type="button" className="link-btn verify-link" onClick={() => onVerify(c)}>
                                {c.observedText ? 'Show on image' : 'Check the images'}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// The findings a reviewer needs beside their decision: the unsettled ones, named,
// each linked to the photograph it was drawn from. The full table is still on the
// same screen; this is the short read that a sign-off actually turns on.
export function KeyFindings({ checks, onVerify }: {
  checks: ComplianceCheck[];
  onVerify: (c: ComplianceCheck) => void;
}) {
  const notable = checks.filter((c) => c.status !== 'present');
  if (notable.length === 0) return null;
  return (
    <div>
      <h2 className="tight">Key findings</h2>
      <ul className="rv-findings">
        {notable.map((c, i) => {
          const m = STATUS_META[c.status] ?? { label: c.status, tone: 'neutral', icon: '·' };
          return (
            <li key={`${c.parameter}-${i}`}>
              <span className={`chip ${m.tone}`}>
                <span className="ico" aria-hidden="true">{m.icon}</span>
                {c.parameter} — {m.label}
              </span>
              <button type="button" className="link-btn verify-link" onClick={() => onVerify(c)}>
                View evidence
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const engineTone = (o: string) => (o === 'pass' ? 'passed' : o === 'fail' ? 'failed' : 'needs_review');
const engineIcon = (o: string) => (o === 'pass' ? '✓' : o === 'fail' ? '✕' : '?');

export function engineSummary(findings: Scan['engineFindings']) {
  const counts = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.outcome] = (acc[f.outcome] ?? 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts).map(([outcome, n]) => `${n} ${outcome.replace(/_/g, ' ')}`).join(' · ');
}

// The deterministic engine's own reading, kept visually distinct from the AI
// verdict above it. Two assessments, separately attributable — a reader must never
// have to guess which one produced a line.
export function EngineCrossCheck({ findings, onClose }: {
  findings: Scan['engineFindings']; onClose: () => void;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2><IconGear size={17} /> Rule-engine cross-check</h2>
        <button className="link-btn" onClick={onClose}>Close</button>
      </div>
      <p className="muted engine-note">
        This system&rsquo;s deterministic pattern-matching engine, run separately from the AI
        assessment. It matches keywords rather than reading the Rules, so it is frequently wrong
        about presence. Shown for comparison; the two are never merged.
      </p>
      <ul className="engine-list">
        {findings.map((f) => (
          <li key={f.ruleKey}>
            <span className={`chip ${engineTone(f.outcome)}`}>
              <span className="ico" aria-hidden="true">{engineIcon(f.outcome)}</span>
              {f.outcome.replace(/_/g, ' ')}
            </span>
            <div className="engine-body">
              <b>{f.title}</b>
              {f.explanation && <p>{f.explanation}</p>}
              <small><code>{f.ruleKey}</code> · {f.citation}</small>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
