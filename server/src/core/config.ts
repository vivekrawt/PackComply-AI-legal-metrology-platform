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
    // PaddleOCR (via the Python sidecar in ocr-service/) is the default engine;
    // 'tesseract' remains a supported in-process alternative for a deployment
    // that cannot run the sidecar. Neither is ever substituted for the other
    // silently — an unreachable sidecar fails the job, it does not downgrade.
    ocr: process.env.PROVIDER_OCR ?? 'paddle',
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
  // PaddleOCR sidecar (ocr-service/). Python holds the models; this process
  // talks HTTP to it over loopback, so evidence stays inside the deployment.
  paddle: {
    baseUrl: process.env.PADDLE_OCR_URL ?? 'http://127.0.0.1:8100',
    // Generous: the first call after a cold start pays for model loading, and a
    // multi-face scan queues behind one CPU-bound engine.
    timeoutMs: Number(process.env.PADDLE_TIMEOUT_MS ?? 120_000),
    maxAttempts: Number(process.env.PADDLE_MAX_ATTEMPTS ?? 3),
    backoffMs: Number(process.env.PADDLE_BACKOFF_MS ?? 1500),
    backoffCapMs: Number(process.env.PADDLE_BACKOFF_CAP_MS ?? 15_000),
    // Image preparation (OpenCV/Pillow) toggles, passed through per request so
    // they can be turned off without redeploying the sidecar.
    deskew: process.env.PADDLE_DESKEW !== 'false',
    crop: process.env.PADDLE_CROP !== 'false',
    enhance: process.env.PADDLE_ENHANCE !== 'false',
    // Keep the prepared image as a derivative of the original asset. On by
    // default: without it a report cannot show what the recogniser actually
    // read. Turn off to save roughly one image's storage per capture.
    storeProcessedImage: process.env.PADDLE_STORE_PROCESSED_IMAGE !== 'false',
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? '',
    // Pinned to a specific release rather than a moving 'latest' alias: a scan
    // report names the model version it was judged by, and that claim has to
    // stay true. Flash Lite is the cheapest tier that still takes the whole
    // statutory corpus (1M-token input window) and honours responseSchema.
    // Override with GEMINI_MODEL for a larger model or a newer release.
    model: process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite',
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
    // Wait between attempts, doubling each time up to the cap. A job that failed
    // on its own merits is retried briskly, because waiting changes nothing.
    backoffMs: Number(process.env.JOB_BACKOFF_MS ?? 1_000),
    backoffCapMs: Number(process.env.JOB_BACKOFF_CAP_MS ?? 30_000),
    // A dependency being down is different. PaddleOCR needs tens of seconds just
    // to load its models, so retrying four hundred milliseconds later only spends
    // the budget without ever giving it a chance to answer. These numbers are set
    // to outlast a sidecar restart: 15s, 30s, 60s, 60s... across eight attempts.
    transientBackoffMs: Number(process.env.JOB_TRANSIENT_BACKOFF_MS ?? 15_000),
    transientBackoffCapMs: Number(process.env.JOB_TRANSIENT_BACKOFF_CAP_MS ?? 60_000),
    transientMaxAttempts: Number(process.env.JOB_TRANSIENT_MAX_ATTEMPTS ?? 8),
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
