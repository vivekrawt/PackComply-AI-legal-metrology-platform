import { describe, it, expect, vi, afterEach } from 'vitest';
import { GeminiComplianceProvider } from '../src/providers/gemini.js';
import { config } from '../src/core/config.js';
import type { ComplianceJudgeInput, RulesCorpus } from '../src/providers/types.js';

// The Gemini adapter with the network stubbed. What matters here is everything
// that happens around the model call: that provenance is stamped, that filler
// values are normalised, that transient failures are retried and permanent ones
// are not, and that a malformed response never becomes a silent "compliant".

const RULES: RulesCorpus = {
  text: '6. Declarations to be made on every package.', sha256: 'abc', sources: ['lmpc-2011.txt'], chars: 44,
};

const INPUT: ComplianceJudgeInput = {
  eventDate: '2026-09-04',
  ocrText: '[top]\nNet Quantity: 150 g',
  faces: [{ faceLabel: 'top', text: 'Net Quantity: 150 g' }],
  engineFindings: [],
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function verdictReply(verdict: unknown) {
  return reply({
    candidates: [{ content: { parts: [{ text: JSON.stringify(verdict) }] }, finishReason: 'STOP' }],
    usageMetadata: { totalTokenCount: 1234 },
  });
}

const withKey = async (fn: () => Promise<void>) => {
  const prev = config.gemini.apiKey;
  config.gemini.apiKey = 'test-key';
  try { await fn(); } finally { config.gemini.apiKey = prev; }
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('Gemini compliance judge', () => {
  it('parses a verdict and stamps provenance', async () => {
    const fetchMock = vi.fn().mockResolvedValue(verdictReply({
      overall: 'non_compliant', summary: 'Consumer care details absent.', confidence: 0.9,
      checks: [{
        parameter: 'Net quantity', ruleReference: 'Rule 6(1)(c)', status: 'present',
        observedText: 'Net Quantity: 150 g', issue: '', remedy: '',
      }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await withKey(async () => {
      const v = await new GeminiComplianceProvider().judge(INPUT, RULES);
      expect(v.overall).toBe('non_compliant');
      expect(v.confidence).toBe(0.9);
      expect(v.checks).toHaveLength(1);
      expect(v.provider).toBe('gemini');
      expect(v.isMock).toBe(false);
    });

    // The statutory text must actually be sent, in the cacheable system slot.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.systemInstruction.parts[0].text).toContain(RULES.text);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.contents[0].parts[0].text).toContain('Net Quantity: 150 g');
  });

  it('normalises filler values so a satisfied check renders clean', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(verdictReply({
      overall: 'compliant', summary: 'All present.', confidence: 0.8,
      checks: [{
        parameter: 'Net quantity', ruleReference: 'Rule 6(1)(c)', status: 'present',
        observedText: 'Net Quantity: 150 g', issue: 'None', remedy: 'N/A.',
      }],
    })));
    await withKey(async () => {
      const v = await new GeminiComplianceProvider().judge(INPUT, RULES);
      expect(v.checks[0].issue).toBe('');
      expect(v.checks[0].remedy).toBe('');
      expect(v.checks[0].observedText).toBe('Net Quantity: 150 g');
    });
  });

  it('ignores thought parts so a thinking model still parses', async () => {
    // Flash Lite reasons before answering. A thought part landing next to the
    // JSON must not be concatenated into it.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({
      candidates: [{
        content: {
          parts: [
            { text: 'Weighing whether the net quantity declaration is legible...', thought: true },
            { text: JSON.stringify({ overall: 'compliant', summary: 'ok', confidence: 0.7, checks: [] }) },
          ],
        },
        finishReason: 'STOP',
      }],
    })));
    await withKey(async () => {
      const v = await new GeminiComplianceProvider().judge(INPUT, RULES);
      expect(v.overall).toBe('compliant');
      expect(v.confidence).toBe(0.7);
    });
  });

  it('falls back to needs_review rather than inventing an outcome', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(verdictReply({
      overall: 'definitely-fine', summary: 's', confidence: 'not-a-number', checks: 'not-an-array',
    })));
    await withKey(async () => {
      const v = await new GeminiComplianceProvider().judge(INPUT, RULES);
      expect(v.overall).toBe('needs_review');
      expect(v.checks).toEqual([]);
      expect(v.confidence).toBe(0.5);
    });
  });

  it('retries a 503 and succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ error: { code: 503 } }, 503))
      .mockResolvedValueOnce(verdictReply({ overall: 'compliant', summary: 'ok', confidence: 1, checks: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await withKey(async () => {
      const v = await new GeminiComplianceProvider().judge(INPUT, RULES);
      expect(v.overall).toBe('compliant');
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honours the delay the API asks for on a quota error, and names it', async () => {
    const body = {
      error: {
        code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [{
              quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
              quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
              quotaValue: '20',
            }],
          },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' },
        ],
      },
    };
    const fetchMock = vi.fn().mockImplementation(() => reply(body, 429));
    vi.stubGlobal('fetch', fetchMock);

    // Shrink the budget so the assertion is about behaviour, not wall-clock.
    const prev = { ...config.gemini };
    Object.assign(config.gemini, { maxAttempts: 3, backoffMs: 1, backoffCapMs: 20 });
    try {
      await withKey(async () => {
        // The message must name the actual limit, not just say "check your billing".
        await expect(new GeminiComplianceProvider().judge(INPUT, RULES))
          .rejects.toThrow(/quota is exhausted — the limit is 20 requests per day/i);
      });
      // Retried through the whole budget rather than giving up on the first 429.
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally { Object.assign(config.gemini, prev); }
  });

  it('prefers the advised retry delay over its own backoff', async () => {
    // Retry-After of 0.2s must win over a 1ms backoff; the elapsed time proves it.
    const fetchMock = vi.fn().mockImplementation(() =>
      new Response(JSON.stringify({ error: { code: 429 } }), { status: 429, headers: { 'retry-after': '0.2' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const prev = { ...config.gemini };
    Object.assign(config.gemini, { maxAttempts: 2, backoffMs: 1, backoffCapMs: 5000 });
    try {
      const started = Date.now();
      await withKey(async () => {
        await expect(new GeminiComplianceProvider().judge(INPUT, RULES)).rejects.toThrow();
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    } finally { Object.assign(config.gemini, prev); }
  });

  it('does not retry a bad key or an unknown model', async () => {
    for (const [status, pattern] of [[403, /GEMINI_API_KEY/], [404, /GEMINI_MODEL/]] as const) {
      const fetchMock = vi.fn().mockResolvedValue(reply({ error: { code: status } }, status));
      vi.stubGlobal('fetch', fetchMock);
      await withKey(async () => {
        await expect(new GeminiComplianceProvider().judge(INPUT, RULES)).rejects.toThrow(pattern);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses to judge without a statutory corpus', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await withKey(async () => {
      await expect(
        new GeminiComplianceProvider().judge(INPUT, { text: '', sha256: '', sources: [], chars: 0 }),
      ).rejects.toThrow(/No statutory corpus/);
    });
  });

  it('refuses to judge without an API key', async () => {
    const prev = config.gemini.apiKey;
    config.gemini.apiKey = '';
    try {
      await expect(new GeminiComplianceProvider().judge(INPUT, RULES)).rejects.toThrow(/GEMINI_API_KEY is not set/);
    } finally { config.gemini.apiKey = prev; }
  });
});
