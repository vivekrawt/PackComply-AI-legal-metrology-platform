import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import type {
  ComplianceCheck, ComplianceJudgeInput, ComplianceJudgeProvider,
  ComplianceStatus, ComplianceVerdict, RulesCorpus,
} from './types.js';

// Gemini compliance judge (Flash / Flash Lite). The statutory corpus goes in systemInstruction
// (a stable prefix, so repeat scans reuse the provider's implicit cache); the
// OCR text of the package goes in the user turn. Structured output is enforced
// with responseSchema rather than parsed out of prose.
//
// The model is asked to decide from the corpus, not from prior knowledge — the
// text of the 2011 Rules in front of it is the whole point of sending it.

const SYSTEM_PREAMBLE = `You are a Legal Metrology compliance analyst for India. You assess whether a
packaged commodity's label carries every declaration the Legal Metrology (Packaged Commodities)
Rules, 2011 require.

The complete statutory text you must apply is reproduced below. Decide ONLY from that text. If the
reproduced rules do not cover a point, say so in the relevant check rather than relying on outside
knowledge.

You are given text recovered by OCR from photographs of the package. OCR is imperfect: characters
may be dropped, merged or misread, and a face that was not photographed contributes no text at all.

Apply these rules when you judge:
- Mark a declaration "present" only when the OCR text actually contains it.
- Mark it "missing" only when the required declaration is genuinely absent from every face supplied.
- Mark it "unclear" when the OCR text is too garbled, or the necessary face was not captured, to tell
  the difference. Never guess a declaration into existence, and never report an OCR artefact as a
  legal violation.
- "overall" is "compliant" only when every mandatory declaration for this package is present.
  It is "non_compliant" when at least one mandatory declaration is missing or defective.
  It is "needs_review" when the deciding evidence is unclear rather than absent.
- Cite the specific provision (e.g. "Rule 6(1)(d)") in ruleReference for every check.
- Cover every mandatory declaration you assess, satisfied ones included: the officer needs to see
  what passed as well as what failed.
- "confidence" is your confidence in the assessment given OCR quality, from 0 to 1. It is not a
  compliance score.
- Leave "issue" and "remedy" as EMPTY STRINGS for a check whose status is "present". Do not write
  "None", "N/A" or any other filler — an empty string is the correct value when there is nothing
  to report. Likewise leave "observedText" empty when the declaration was not found at all.

You produce decision support for an authorised officer, who makes the final determination.

===== STATUTORY CORPUS BEGINS =====

`;

// OpenAPI-subset schema understood by generateContent's responseSchema.
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    overall: { type: 'STRING', enum: ['compliant', 'non_compliant', 'needs_review'] },
    summary: { type: 'STRING' },
    confidence: { type: 'NUMBER' },
    // The package's own identity, read off the label. Not part of the compliance
    // determination — it is how an officer finds this scan again in a list.
    productName: { type: 'STRING' },
    brand: { type: 'STRING' },
    checks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          parameter: { type: 'STRING' },
          ruleReference: { type: 'STRING' },
          status: { type: 'STRING', enum: ['present', 'missing', 'unclear'] },
          observedText: { type: 'STRING' },
          issue: { type: 'STRING' },
          remedy: { type: 'STRING' },
        },
        required: ['parameter', 'ruleReference', 'status', 'observedText', 'issue', 'remedy'],
      },
    },
  },
  required: ['overall', 'summary', 'confidence', 'checks'],
} as const;

function buildUserPrompt(input: ComplianceJudgeInput): string {
  const p = input.productContext;
  const context = [
    p?.brand ? `Brand as recorded by the officer: ${p.brand}` : null,
    p?.genericName ? `Common/generic name as recorded: ${p.genericName}` : null,
    p?.category ? `Commodity category: ${p.category}` : null,
    p?.importStatus ? `Import status: ${p.importStatus}` : null,
    p?.packSize ? `Declared pack size as recorded: ${p.packSize}` : null,
  ].filter(Boolean);

  const faces = input.faces.length
    ? input.faces
        .map((f) => `--- FACE: ${f.faceLabel ?? 'unlabelled'} ---\n${f.text.trim() || '(no text recovered from this face)'}`)
        .join('\n\n')
    : '(no OCR text was recovered from any face)';

  const engine = input.engineFindings.length
    ? input.engineFindings
        .map((f) => `- [${f.outcome}] ${f.ruleKey} — ${f.title}: ${f.explanation} (${f.citation})`)
        .join('\n')
    : '(the deterministic engine produced no findings)';

  return `Date of inspection (governs which version of the rules applies): ${input.eventDate}

OFFICER-RECORDED CONTEXT
${context.length ? context.join('\n') : '(none recorded)'}

FACES PHOTOGRAPHED: ${input.faces.length ? input.faces.map((f) => f.faceLabel ?? 'unlabelled').join(', ') : 'none'}

OCR TEXT RECOVERED FROM THE PACKAGE
${faces}

SECONDARY CROSS-CHECK — output of this system's deterministic pattern-matching rule engine.
It is keyword-based and frequently wrong about presence; treat it as a hint about what to look
for, never as evidence. Your own reading of the OCR text above governs.
${engine}

Also identify the package itself: productName is the common or generic name of the commodity as
declared on it (for example "Instant Noodles", "Refined Sunflower Oil"), and brand is the brand or
trade name if one is shown. These label the record so an officer can find it again; they are not part
of the compliance determination. Leave either empty if the package does not show it.

Assess this package against the statutory corpus and return the structured verdict.`;
}

// responseSchema makes issue/remedy required, so for a satisfied check the model
// has to put *something* there and reaches for a filler word. Rendering "To fix:
// None" under a requirement that passed is noise at best and confusing at worst,
// so normalise the fillers to empty here — at the boundary, once, rather than
// leaving every consumer to recognise them.
const FILLER = new Set(['none', 'n/a', 'na', 'null', 'nil', '-', '—', 'not applicable', 'no issue', 'no issues']);
const clean = (v: unknown): string => {
  const s = String(v ?? '').trim();
  return FILLER.has(s.toLowerCase().replace(/\.$/, '')) ? '' : s;
};

function coerceCheck(raw: unknown): ComplianceCheck | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const status = String(c.status ?? '');
  if (!['present', 'missing', 'unclear'].includes(status)) return null;
  return {
    parameter: String(c.parameter ?? 'Unnamed declaration').trim(),
    ruleReference: clean(c.ruleReference),
    status: status as ComplianceCheck['status'],
    observedText: clean(c.observedText),
    issue: clean(c.issue),
    remedy: clean(c.remedy),
  };
}

// The Flash endpoint returns 503 "high demand" and 429 often enough that a single
// attempt regularly loses a scan the officer has already spent time capturing.
// Retry those and 5xx with backoff; never retry a 4xx that means the request
// itself is wrong (bad key, unknown model, malformed body). The budget lives in
// config so it is readable per call rather than frozen at import.
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A 429 body carries a google.rpc.QuotaFailure naming the limit that was hit
// (e.g. "GenerateRequestsPerDayPerProjectPerModel-FreeTier", value 20). "Check
// your billing" is not actionable; "the limit is 20 requests per day" is.
function quotaDetail(body: string): string | null {
  try {
    const violation = JSON.parse(body)?.error?.details
      ?.find((d: any) => String(d['@type'] ?? '').endsWith('QuotaFailure'))
      ?.violations?.[0];
    if (!violation) return null;
    const id = String(violation.quotaId ?? '');
    const value = violation.quotaValue;
    const perDay = /PerDay/i.test(id);
    const perMinute = /PerMinute/i.test(id);
    const window = perDay ? 'per day' : perMinute ? 'per minute' : '';
    if (value && window) return `the limit is ${value} requests ${window} (${id})`;
    return id || null;
  } catch { return null; }
}

// Gemini reports how long to wait either in a standard Retry-After header or in a
// google.rpc.RetryInfo entry in the error body ("retryDelay": "31s"). Prefer what
// the service says over our own guess — on a per-minute quota, retrying three
// seconds later just spends another attempt on a window that has not reset.
function retryDelayMs(res: Response, body: string): number | null {
  const header = res.headers.get('retry-after');
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs)) return secs * 1000;
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.max(at - Date.now(), 0);
  }
  const m = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

export class GeminiComplianceProvider implements ComplianceJudgeProvider {
  readonly provider = 'gemini';
  readonly isMock = false;
  get modelVersion(): string { return config.gemini.model; }

  private async post(url: string, body: unknown): Promise<any> {
    let lastRetryable = '';
    let quotaMessage: string | null = null;
    const maxAttempts = Math.max(1, config.gemini.maxAttempts);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), config.gemini.timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
      } catch (err) {
        if (ac.signal.aborted) {
          throw new Error(`Gemini request timed out after ${config.gemini.timeoutMs}ms (GEMINI_TIMEOUT_MS)`);
        }
        throw new Error(`Could not reach the Gemini API: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) return res.json();

      // Keep the whole body: the RetryInfo and QuotaFailure details read below sit
      // at the end of it, so truncating first loses them. Only copies shown to a
      // human are shortened.
      const fullBody = await res.text().catch(() => '');
      const detail = fullBody.slice(0, 600);
      if (res.status === 404) {
        throw new Error(
          `Gemini model '${config.gemini.model}' is not available to this API key. `
          + `Set GEMINI_MODEL to a model the key can use. Response: ${detail}`,
        );
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Gemini rejected the API key (HTTP ${res.status}). Check GEMINI_API_KEY. ${detail}`);
      }
      if (!RETRY_STATUSES.has(res.status)) {
        throw new Error(`Gemini API error HTTP ${res.status}: ${detail}`);
      }

      // Keep the message short and specific — it is stored on the verdict and shown
      // to the officer, who needs to know whether to retry or to call someone.
      if (res.status === 429) {
        const detailText = quotaDetail(fullBody);
        // Never let a later, vaguer 429 overwrite a message that already names the
        // limit that was hit.
        if (detailText || !quotaMessage) {
          quotaMessage = 'The compliance assessment could not run: the Gemini API key quota is exhausted'
            + (detailText ? ` — ${detailText}` : '')
            + '. The captured images are saved. Raise the quota (or enable billing on the key), or set '
            + 'GEMINI_MODEL to a model with more headroom, then retry the analysis.';
        }
      }
      lastRetryable = res.status === 503 ? 'the model was overloaded (HTTP 503)'
        : res.status === 429 ? 'the API key quota is exhausted (HTTP 429)'
          : `HTTP ${res.status}`;

      if (attempt < maxAttempts) {
        // On a quota error the API says how long to wait; guessing shorter just
        // burns the remaining attempts against a window that has not reset.
        const advised = retryDelayMs(res, fullBody);
        const wait = Math.min(
          Math.max(advised ?? 0, config.gemini.backoffMs * 2 ** (attempt - 1)),
          config.gemini.backoffCapMs,
        );
        logger.warn('Gemini transient error, retrying', {
          attempt, of: maxAttempts, status: res.status, waitMs: wait,
          advisedMs: advised, detail: detail.slice(0, 300),
        });
        await sleep(wait);
      }
    }
    throw new Error(
      quotaMessage
      ?? `The compliance service was unavailable after ${maxAttempts} attempts — ${lastRetryable}. `
         + 'The captured images are saved; retry the analysis in a moment.',
    );
  }

  async judge(input: ComplianceJudgeInput, rules: RulesCorpus): Promise<ComplianceVerdict> {
    if (!config.gemini.apiKey) {
      throw new Error('PROVIDER_COMPLIANCE=gemini but GEMINI_API_KEY is not set.');
    }
    if (!rules.text) {
      throw new Error(
        `No statutory corpus found in ${config.rulesDir}. Place the Legal Metrology (Packaged `
        + 'Commodities) Rules, 2011 text there (node scripts/extract-rules.mjs) before scanning.',
      );
    }

    const url = `${config.gemini.baseUrl}/models/${encodeURIComponent(config.gemini.model)}:generateContent`;
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_PREAMBLE + rules.text }] },
      contents: [{ role: 'user', parts: [{ text: buildUserPrompt(input) }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    };

    const payload = await this.post(url, body);
    const candidate = payload?.candidates?.[0];
    // Flash Lite is a thinking model. Thought parts are only returned when
    // includeThoughts is set (it is not), but concatenating one into the JSON
    // would corrupt the parse, so drop anything flagged as a thought rather
    // than depending on that default holding.
    const text = candidate?.content?.parts
      ?.filter((p: any) => p?.thought !== true)
      .map((p: any) => p?.text ?? '').join('') ?? '';
    if (!text.trim()) {
      const reason = candidate?.finishReason ?? payload?.promptFeedback?.blockReason ?? 'unknown';
      throw new Error(`Gemini returned no content (finishReason: ${reason})`);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Gemini returned malformed JSON despite responseSchema: ${text.slice(0, 300)}`);
    }

    const checks = Array.isArray(parsed.checks)
      ? parsed.checks.map(coerceCheck).filter((c: ComplianceCheck | null): c is ComplianceCheck => c !== null)
      : [];
    const overall: ComplianceStatus =
      ['compliant', 'non_compliant', 'needs_review'].includes(parsed.overall)
        ? parsed.overall
        : 'needs_review';
    const confidence = Number(parsed.confidence);

    logger.info('compliance judged', {
      provider: this.provider, model: this.modelVersion, overall,
      checks: checks.length, rulesSha256: rules.sha256.slice(0, 12),
      usage: payload?.usageMetadata ?? null,
    });

    return {
      provider: this.provider,
      modelVersion: this.modelVersion,
      isMock: false,
      overall,
      summary: String(parsed.summary ?? ''),
      confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0.5,
      checks,
      productName: clean(parsed.productName) || null,
      brand: clean(parsed.brand) || null,
      raw: { usageMetadata: payload?.usageMetadata ?? null, finishReason: candidate?.finishReason ?? null },
    };
  }
}
