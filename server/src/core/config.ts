import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Minimal .env loader (no external dep). Values already in process.env win.
function loadDotEnv() {
  const p = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

const dataDir = process.env.PACKCOMPLY_DATA_DIR ?? path.resolve(process.cwd(), 'data');

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4000),
  dataDir,
  dbPath: process.env.PACKCOMPLY_DB_PATH ?? path.join(dataDir, 'packcomply.db'),
  evidenceDir: process.env.PACKCOMPLY_EVIDENCE_DIR ?? path.join(dataDir, 'evidence'),
  // Secret for session + signed asset URLs. MUST be set in production.
  secret: process.env.PACKCOMPLY_SECRET ?? 'dev-only-insecure-secret-change-me',
  session: {
    inactivityMinutes: Number(process.env.SESSION_INACTIVITY_MINUTES ?? 60),
    absoluteHours: Number(process.env.SESSION_ABSOLUTE_HOURS ?? 12),
    maxConcurrent: Number(process.env.SESSION_MAX_CONCURRENT ?? 3),
  },
  upload: {
    maxBytes: Number(process.env.UPLOAD_MAX_BYTES ?? 25 * 1024 * 1024),
    allowedMime: ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'application/pdf'],
  },
  providers: {
    // OCR defaults to the REAL self-hosted tesseract adapter; the remaining
    // components are deterministic mocks (labeled as such everywhere they
    // surface). The system never silently substitutes one for the other.
    quality: process.env.PROVIDER_QUALITY ?? 'mock',
    ocr: process.env.PROVIDER_OCR ?? 'tesseract',
    layout: process.env.PROVIDER_LAYOUT ?? 'mock',
    extraction: process.env.PROVIDER_EXTRACTION ?? 'mock',
    font: process.env.PROVIDER_FONT ?? 'mock',
    malwareScanner: process.env.PROVIDER_MALWARE ?? 'noop',
    // Compliance judge: the LLM that reads the OCR text against the LMPC 2011
    // corpus. 'gemini' when a key is configured, otherwise the deterministic
    // rule engine — which is labeled isMock so its output can never be mistaken
    // for an AI reading of the statute.
    compliance: process.env.PROVIDER_COMPLIANCE
      ?? (process.env.GEMINI_API_KEY ? 'gemini' : 'rule_engine'),
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? '',
    // Flash-family alias that tracks the current Flash release; pin a specific id
    // via GEMINI_MODEL if a scan must be reproducible against one model version.
    model: process.env.GEMINI_MODEL ?? 'gemini-flash-latest',
    baseUrl: process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta',
    timeoutMs: Number(process.env.GEMINI_TIMEOUT_MS ?? 90_000),
    // Retry budget for transient failures (503 overload, 429 quota). Generous
    // because the judge runs in a background job behind a progress bar, not in a
    // request the officer is blocking on.
    maxAttempts: Number(process.env.GEMINI_MAX_ATTEMPTS ?? 6),
    backoffMs: Number(process.env.GEMINI_BACKOFF_MS ?? 1500),
    backoffCapMs: Number(process.env.GEMINI_BACKOFF_CAP_MS ?? 30_000),
  },
  // Statutory corpus the compliance judge reads. Every .txt/.md file in this
  // directory is concatenated; the SHA-256 of the result is recorded on each
  // verdict so a report always names the exact text the model was shown.
  rulesDir: process.env.PACKCOMPLY_RULES_DIR
    ?? path.resolve(fileURLToPath(new URL('../../assets/rules', import.meta.url))),
  jobs: {
    pollMs: Number(process.env.JOB_POLL_MS ?? 400),
    maxAttempts: Number(process.env.JOB_MAX_ATTEMPTS ?? 3),
  },
  rateLimit: {
    windowMs: 60_000,
    max: Number(process.env.RATE_LIMIT_MAX ?? 600),
    loginMax: Number(process.env.RATE_LIMIT_LOGIN_MAX ?? 10),
  },
  assetUrlTtlSeconds: Number(process.env.ASSET_URL_TTL_SECONDS ?? 300),
};

export function ensureDirs() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.evidenceDir, { recursive: true });
}
