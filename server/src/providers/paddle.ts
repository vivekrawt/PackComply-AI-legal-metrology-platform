// ============================================================================
// REAL PROVIDER — OCR via PaddleOCR, with OpenCV/Pillow image preparation.
//
// PaddleOCR, OpenCV and Pillow are Python, so they run in the sidecar service in
// ocr-service/ and this adapter speaks HTTP to it. Evidence still never leaves
// the deployment: the sidecar is stateless, writes nothing to disk, and is
// reached over loopback (or the compose network) — not a third-party API.
//
// One call does preparation and recognition together and returns both the text
// and the prepared image. That is deliberate: the image handed back is the exact
// input the recogniser read, so storing it as a derivative gives a report a
// truthful "this is what the model saw" rather than a re-run that might differ.
//
// Enable with PROVIDER_OCR=paddle (the default) and PADDLE_OCR_URL.
// This is demo-grade real OCR: it has NOT been benchmarked against the PRD
// acceptance corpus — release gates in docs/REQUIREMENTS.md still apply.
// ============================================================================
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import type { AssetInput, OcrBlock, OCRProvider, OcrResult } from './types.js';

const SUPPORTED_MIME = ['image/jpeg', 'image/png', 'image/bmp', 'image/webp'];

// The sidecar loads its models on first use, so an early request can sit for a
// while; and a six-face scan queues behind one CPU-bound engine. Retry the
// statuses that mean "not ready yet" or "busy", never a 4xx that means the
// request itself is wrong.
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PaddleBlock {
  text: string;
  bbox: { x: number; y: number; w: number; h: number };
  readingOrder: number;
  script: string;
  lang: string;
  confidence: number;
}

interface PaddleResponse {
  provider: string;
  modelVersion: string;
  blocks: PaddleBlock[];
  preprocessing: {
    ops: unknown[];
    inputSize: { w: number; h: number };
    outputSize: { w: number; h: number };
  };
  processedImage?: { mime: string; bytes: number; sha256: string; base64: string };
  timings?: Record<string, number>;
}

export class PaddleOCRProvider implements OCRProvider {
  provider = 'paddleocr';
  // Filled in from the service's own /health or response, so the version stamped
  // on an OCR row names the models that actually ran rather than a guess made
  // here. Until the first call we can only report what is configured.
  modelVersion = 'paddleocr-3/pending';
  isMock = false;

  async recognize(input: AssetInput): Promise<OcrResult> {
    // Structured listing evidence has no pixels: reflect fields as visible text
    // (same contract as the mock and tesseract adapters) so extraction can run
    // uniformly across physical and listing channels.
    if (input.structuredJson && typeof input.structuredJson === 'object') {
      const blocks: OcrBlock[] = Object.entries(input.structuredJson as Record<string, unknown>)
        .map(([k, v], i) => ({
          text: `${k}: ${String(v)}`,
          bbox: { x: 0.05, y: 0.05 + i * 0.08, w: 0.9, h: 0.06 },
          readingOrder: i,
          script: scriptOf(String(v)), lang: scriptOf(String(v)) === 'devanagari' ? 'hi' : 'en',
          confidence: 0.99,
        }));
      return { provider: this.provider, modelVersion: this.modelVersion, isMock: false, blocks };
    }

    if (!input.loadContent) {
      logger.warn('paddle: no content loader for asset; returning empty OCR', { assetId: input.assetId });
      return this.empty();
    }
    if (!SUPPORTED_MIME.includes(input.mime)) {
      // HEIC/PDF need a raster conversion step (documented limitation).
      logger.warn('paddle: unsupported mime for direct OCR', { assetId: input.assetId, mime: input.mime });
      return this.empty();
    }

    const payload = await this.post(input.loadContent(), input.mime);
    this.modelVersion = payload.modelVersion || this.modelVersion;

    const blocks: OcrBlock[] = (payload.blocks ?? [])
      .filter((b) => b.text?.trim())
      .map((b, i) => ({
        text: b.text.replace(/\s+/g, ' ').trim(),
        bbox: {
          x: clamp01(b.bbox?.x ?? 0), y: clamp01(b.bbox?.y ?? 0),
          w: clamp01(b.bbox?.w ?? 0), h: clamp01(b.bbox?.h ?? 0),
        },
        readingOrder: Number.isFinite(b.readingOrder) ? b.readingOrder : i,
        // Trust our own classification of the returned text over a label: the
        // two must agree for downstream language routing to mean anything.
        script: scriptOf(b.text),
        lang: langOf(scriptOf(b.text)),
        confidence: clamp01(b.confidence ?? 0),
      }));

    const derived = payload.processedImage
      ? {
          bytes: Buffer.from(payload.processedImage.base64, 'base64'),
          mime: payload.processedImage.mime,
          ops: payload.preprocessing?.ops ?? [],
          inputSize: payload.preprocessing?.inputSize,
          outputSize: payload.preprocessing?.outputSize,
        }
      : undefined;

    logger.info('paddle: recognized', {
      assetId: input.assetId, blocks: blocks.length, modelVersion: this.modelVersion,
      ops: (payload.preprocessing?.ops ?? []).length, timings: payload.timings ?? null,
    });

    return {
      provider: this.provider, modelVersion: this.modelVersion, isMock: false, blocks, derived,
    };
  }

  private async post(image: Buffer, mime: string): Promise<PaddleResponse> {
    const url = `${config.paddle.baseUrl.replace(/\/$/, '')}/ocr`;
    const maxAttempts = Math.max(1, config.paddle.maxAttempts);
    let lastError = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const form = new FormData();
      // Re-created per attempt: a FormData holding a Blob cannot be replayed
      // once its stream has been consumed by a failed request.
      form.append('image', new Blob([image], { type: mime }), 'evidence');
      form.append('deskew', String(config.paddle.deskew));
      form.append('crop', String(config.paddle.crop));
      form.append('enhance', String(config.paddle.enhance));
      form.append('include_image', String(config.paddle.storeProcessedImage));

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), config.paddle.timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, { method: 'POST', body: form, signal: ac.signal });
      } catch (err) {
        if (ac.signal.aborted) {
          lastError = `timed out after ${config.paddle.timeoutMs}ms (PADDLE_TIMEOUT_MS)`;
        } else {
          // Connection refused is the common case and has one likely cause, so
          // say what to do about it rather than surfacing a bare ECONNREFUSED.
          lastError = `could not reach the OCR service at ${config.paddle.baseUrl} `
            + `(${err instanceof Error ? err.message : String(err)}). Is it running? `
            + 'Start it with `npm run ocr` (see ocr-service/README.md).';
        }
        if (attempt < maxAttempts) { await this.backoff(attempt, lastError); continue; }
        throw new Error(`PaddleOCR service unavailable: ${lastError}`);
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) return await res.json() as PaddleResponse;

      const detail = (await res.text().catch(() => '')).slice(0, 400);
      if (!RETRY_STATUSES.has(res.status)) {
        throw new Error(`PaddleOCR service rejected the image (HTTP ${res.status}): ${detail}`);
      }
      lastError = `HTTP ${res.status}: ${detail}`;
      if (attempt < maxAttempts) { await this.backoff(attempt, lastError); continue; }
    }
    throw new Error(
      `PaddleOCR service failed after ${maxAttempts} attempts — ${lastError}. `
      + 'The evidence is saved; re-run processing once the service is healthy.',
    );
  }

  private async backoff(attempt: number, detail: string) {
    const wait = Math.min(config.paddle.backoffMs * 2 ** (attempt - 1), config.paddle.backoffCapMs);
    logger.warn('paddle: transient failure, retrying', { attempt, waitMs: wait, detail: detail.slice(0, 200) });
    await sleep(wait);
  }

  private empty(): OcrResult {
    return { provider: this.provider, modelVersion: this.modelVersion, isMock: false, blocks: [] };
  }

  /** Readiness probe used by the health endpoint; never throws. */
  async health(): Promise<{ reachable: boolean; detail: string }> {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      try {
        const res = await fetch(`${config.paddle.baseUrl.replace(/\/$/, '')}/health`, { signal: ac.signal });
        if (!res.ok) return { reachable: false, detail: `HTTP ${res.status}` };
        const body = await res.json() as { engine?: { modelVersion?: string; ready?: boolean } };
        if (body.engine?.modelVersion) this.modelVersion = body.engine.modelVersion;
        return { reachable: true, detail: body.engine?.ready ? 'models loaded' : 'models load on first use' };
      } finally { clearTimeout(timer); }
    } catch (err) {
      return { reachable: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

function scriptOf(text: string): 'latin' | 'devanagari' | 'mixed' {
  const dev = /[ऀ-ॿ]/.test(text);
  const lat = /[A-Za-z]/.test(text);
  return dev && lat ? 'mixed' : dev ? 'devanagari' : 'latin';
}
const langOf = (script: string): 'en' | 'hi' | 'mixed' =>
  script === 'devanagari' ? 'hi' : script === 'mixed' ? 'mixed' : 'en';
const clamp01 = (n: number) => Math.max(0, Math.min(1, Math.round(n * 10000) / 10000));
