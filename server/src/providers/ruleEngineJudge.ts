import type {
  ComplianceCheck, ComplianceJudgeInput, ComplianceJudgeProvider,
  ComplianceStatus, ComplianceVerdict, RulesCorpus,
} from './types.js';

// Fallback compliance judge used when no LLM is configured. It does NOT read the
// statutory corpus — it reshapes this system's own deterministic rule engine
// output into the verdict the scan flow renders, and reports isMock: true so the
// UI and the report both state plainly that no model read the 2011 Rules.
//
// Keeping this on the same interface means the scan flow has one code path, and
// an unset GEMINI_API_KEY degrades to something honest rather than to an error
// screen — but it is never presented as an AI assessment.

const OUTCOME_TO_STATUS: Record<string, ComplianceCheck['status'] | 'skip'> = {
  passed: 'present',
  failed: 'missing',
  needs_review: 'unclear',
  not_assessable: 'unclear',
  not_applicable: 'skip',
};

export class RuleEngineComplianceProvider implements ComplianceJudgeProvider {
  readonly provider = 'rule_engine';
  readonly modelVersion = 'deterministic-1.0.0';
  readonly isMock = true;

  async judge(input: ComplianceJudgeInput, _rules: RulesCorpus): Promise<ComplianceVerdict> {
    const checks: ComplianceCheck[] = [];
    for (const f of input.engineFindings) {
      const status = OUTCOME_TO_STATUS[f.outcome] ?? 'unclear';
      if (status === 'skip') continue;
      checks.push({
        parameter: f.title,
        ruleReference: f.citation,
        status,
        observedText: '',
        issue: status === 'present' ? '' : f.explanation,
        remedy: '',
      });
    }

    const overall: ComplianceStatus = checks.some((c) => c.status === 'missing')
      ? 'non_compliant'
      : checks.some((c) => c.status === 'unclear') || checks.length === 0
        ? 'needs_review'
        : 'compliant';

    return {
      provider: this.provider,
      modelVersion: this.modelVersion,
      isMock: true,
      overall,
      summary:
        'No language model is configured, so this verdict comes from the built-in deterministic '
        + 'pattern-matching rule engine and NOT from a reading of the Legal Metrology (Packaged '
        + 'Commodities) Rules, 2011. Set GEMINI_API_KEY to enable the AI assessment.',
      confidence: 0,
      checks,
    };
  }
}
