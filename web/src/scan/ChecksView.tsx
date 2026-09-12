import React from 'react';
import type { ComplianceCheck, Scan } from '../api';

// How a compliance assessment is presented, shared by the officer's result screen
// and the reviewer's sign-off screen.
//
// Both audiences need the same thing from it — what the package is missing, what
// could not be determined, and what it got right — so they read one implementation.
// A reviewer judging an officer's scan must be looking at exactly what the officer
// was shown, or the sign-off is about a different document than the one that was
// produced.

export const GROUPS = {
  missing: {
    title: 'Missing for compliance',
    hint: 'Required by the Rules and not found on the package. These are what a notice would cite.',
    tone: 'failed', icon: '✕',
  },
  unclear: {
    title: 'Could not be determined',
    hint: 'The images do not settle these — re-photograph the relevant face before concluding anything.',
    tone: 'needs_review', icon: '?',
  },
  present: {
    title: 'Compliance requirements met',
    hint: 'Found on the package. Recorded so the assessment can be checked in both directions.',
    tone: 'passed', icon: '✓',
  },
} as const;

export function CheckGroup({ kind, checks, images, onVerify }: {
  kind: keyof typeof GROUPS;
  checks: ComplianceCheck[];
  images: number;
  onVerify: (c: ComplianceCheck) => void;
}) {
  const g = GROUPS[kind];
  return (
    <section className={`check-group ${g.tone}`}>
      <header className="check-group-head">
        <span className="check-group-ico" aria-hidden="true">{g.icon}</span>
        <div>
          <h2>{g.title} <span className="check-count">{checks.length}</span></h2>
          <p className="muted">{g.hint}</p>
        </div>
      </header>
      <ul>
        {checks.map((c, i) => (
          <li key={`${c.parameter}-${i}`}>
            <div className="check-head">
              <b>{c.parameter}</b>
              {c.ruleReference && <span className="rule-ref">{c.ruleReference}</span>}
            </div>
            {/* For a satisfied check this is the declaration itself; for a failed
                one it is whatever partial text the model found, which is not the
                same claim — so the label follows the status. */}
            {c.observedText && (
              <p className="observed">
                <span className="observed-label">
                  {c.status === 'present' ? 'Found on the package' : 'Related text on the package'}
                </span>
                “{c.observedText}”
              </p>
            )}
            {c.issue && <p className="issue">{c.issue}</p>}
            {c.remedy && <p className="remedy"><b>To fix:</b> {c.remedy}</p>}
            {images > 0 && (
              <button type="button" className="verify-link" onClick={() => onVerify(c)}>
                <span aria-hidden="true">◎</span>
                {c.observedText ? 'Show this on the image' : 'Check the images yourself'}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// The deterministic engine's own reading, kept visually distinct from the AI
// verdict above it. Two assessments, separately attributable — a reader must never
// have to guess which one produced a line.
export function EngineCrossCheck({ findings }: { findings: Scan['engineFindings'] }) {
  const tone = (o: string) => (o === 'pass' ? 'passed' : o === 'fail' ? 'failed' : 'needs_review');
  const icon = (o: string) => (o === 'pass' ? '✓' : o === 'fail' ? '✕' : '?');
  const counts = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.outcome] = (acc[f.outcome] ?? 0) + 1;
    return acc;
  }, {});
  return (
    <details className="field-panel engine-panel">
      <summary>
        <b>Rule-engine cross-check</b>
        <span className="engine-summary-counts">
          {Object.entries(counts).map(([outcome, n]) => (
            <span key={outcome} className={`chip ${tone(outcome)}`}>
              <span className="ico" aria-hidden="true">{icon(outcome)}</span>
              {n} {outcome.replace(/_/g, ' ')}
            </span>
          ))}
        </span>
      </summary>
      <p className="muted engine-note">
        This system's deterministic pattern-matching engine, run separately from the AI assessment
        above. It matches keywords rather than reading the Rules, so it is frequently wrong about
        presence. Shown for comparison; the two are never merged.
      </p>
      <ul className="engine-list">
        {findings.map((f) => (
          <li key={f.ruleKey} className={tone(f.outcome)}>
            <span className={`chip ${tone(f.outcome)}`}>
              <span className="ico" aria-hidden="true">{icon(f.outcome)}</span>
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
    </details>
  );
}
