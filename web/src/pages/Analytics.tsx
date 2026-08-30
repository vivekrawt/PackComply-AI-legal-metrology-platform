import React from 'react';
import { api } from '../api';
import { MockBadge, Section, useAsync } from '../components/common';

export function Analytics() {
  const [tab, setTab] = React.useState<'violations' | 'model'>('violations');
  const viol = useAsync(() => api.get<any>('/dashboards/violations'));
  const model = useAsync(() => api.get<any>('/dashboards/model-quality'));

  const bar = (c: number, max: number) => (
    <span aria-hidden="true" style={{ display: 'inline-block', height: 10, width: `${Math.max(4, (c / Math.max(max, 1)) * 160)}px`, background: 'var(--blue)', borderRadius: 3, verticalAlign: 'middle' }} />
  );

  return (
    <>
      <div className="topbar">
        <h1>Analytics</h1>
        <div className="btn-row">
          <button className={tab === 'violations' ? 'primary' : 'quiet'} onClick={() => setTab('violations')}>Violation intelligence</button>
          <button className={tab === 'model' ? 'primary' : 'quiet'} onClick={() => setTab('model')}>Data / model quality</button>
        </div>
      </div>
      <div className="content">
        <p className="warn-box">Risk indicators prioritize inspection resources. They are <b>not</b> proof of a legal contravention; every aggregate drills down to reviewed records.</p>

        {tab === 'violations' && viol.data && (
          <div className="grid2">
            <Section title="Failed findings by rule">
              <table className="data"><tbody>{viol.data.byRule.map((r: any) => (
                <tr key={r.rule_key}><td className="mono">{r.rule_key}</td><td>{bar(r.c, viol.data.byRule[0]?.c)} <b>{r.c}</b></td></tr>
              ))}</tbody></table>
            </Section>
            <Section title="By category">
              <table className="data"><tbody>{viol.data.byCategory.map((r: any) => (
                <tr key={r.category}><td>{r.category}</td><td>{bar(r.c, viol.data.byCategory[0]?.c)} <b>{r.c}</b></td></tr>
              ))}</tbody></table>
            </Section>
            <Section title="By brand (demo data)">
              <table className="data"><tbody>{viol.data.byBrand.map((r: any) => (
                <tr key={r.brand}><td>{r.brand}</td><td>{bar(r.c, viol.data.byBrand[0]?.c)} <b>{r.c}</b></td></tr>
              ))}</tbody></table>
            </Section>
            <Section title="Repeat entities (pattern indicator only)">
              {viol.data.repeatBrands.length === 0 && <p className="muted">No repeat patterns in scope.</p>}
              <table className="data"><tbody>{viol.data.repeatBrands.map((r: any) => (
                <tr key={r.brand}><td>{r.brand}</td><td><b>{r.inspections}</b> inspections with failed findings</td></tr>
              ))}</tbody></table>
            </Section>
          </div>
        )}

        {tab === 'model' && model.data && (
          <div className="grid2">
            <Section title="Deployed model versions">
              {model.data.mockInUse && <p className="warn-box">◌ Mock providers deployed — metrics below describe DEMO output, not production models.</p>}
              <table className="data">
                <thead><tr><th>Component</th><th>Model</th><th>Version</th><th></th></tr></thead>
                <tbody>{model.data.modelVersions.map((m: any) => (
                  <tr key={m.id}><td>{m.component}</td><td className="mono">{m.name}</td><td>{m.version}</td><td><MockBadge isMock={!!m.is_mock} /></td></tr>
                ))}</tbody>
              </table>
            </Section>
            <Section title="OCR confidence & script segmentation">
              <table className="data"><tbody>
                {model.data.ocrConfidence.map((b: any) => <tr key={b.band}><td>confidence: {b.band}</td><td><b>{b.c}</b> blocks</td></tr>)}
                {model.data.byScript.map((s: any) => <tr key={s.script}><td>script: {s.script}</td><td><b>{s.c}</b> blocks · avg conf {s.avg_confidence}</td></tr>)}
              </tbody></table>
            </Section>
            <Section title="Human-in-the-loop signals">
              <table className="data"><tbody>
                <tr><td>Officer corrections</td><td><b>{model.data.corrections}</b> ({model.data.correctionRate}% of declarations)</td></tr>
                <tr><td>Finding overrides</td><td><b>{model.data.overrides}</b></td></tr>
                <tr><td>Recapture recommended</td><td><b>{model.data.recaptureRecommended}</b> / {model.data.totalAssessments} assets ({model.data.recaptureRate}%)</td></tr>
              </tbody></table>
              <p className="muted">Rising correction/override rates are drift indicators for the model owner — review before any model change.</p>
            </Section>
          </div>
        )}
      </div>
    </>
  );
}
