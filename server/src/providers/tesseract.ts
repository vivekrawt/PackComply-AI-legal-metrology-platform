// ============================================================================
// REAL PROVIDER — self-hosted OCR via tesseract.js (WASM, runs fully locally,
// free/open-source). No evidence ever leaves this process (AI data boundary).
//
// English + Hindi (Devanagari) by default. Language data (~15 MB) is fetched
// once from the public tessdata CDN on first use and cached on disk at
// TESSERACT_CACHE_PATH; after that the provider works fully offline.
// Enable with PROVIDER_OCR=tesseract. This is demo-grade real OCR: it has NOT
// been benchmarked against the PRD acceptance corpus — release gates in
// docs/REQUIREMENTS.md still apply before any enforcement use.
// ============================================================================
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createWorker, type Worker } from 'tesseract.js';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import type { AssetInput, OcrBlock, OCRProvider, OcrResult } from './types.js';

const SUPPORTED_MIME = ['image/jpeg', 'image/png', 'image/bmp'];

export class TesseractOCRProvider implements OCRProvider {
  provider = 'tesseract';
  modelVersion: string;
  isMock = false;

  private workerPromise: Promise<Worker> | null = null;
  private langs: string[];

  constructor(langs = process.env.TESSERACT_LANGS ?? 'eng+hin') {
    this.langs = langs.split('+').filter(Boolean);
    this.modelVersion = `tesseract.js-5/${this.langs.join('+')}`;
  }

  private getWorker(): Promise<Worker> {
    if (!this.workerPromise) {
      // Language data ships in server/assets/tessdata so a fresh clone works
      // offline; tesseract.js only reaches the network if a file is absent.
      const bundled = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'tessdata',
      );
      const cachePath = process.env.TESSERACT_CACHE_PATH
        ?? (fs.existsSync(bundled) ? bundled : path.join(config.dataDir, 'tessdata'));
      fs.mkdirSync(cachePath, { recursive: true });
      logger.info('tesseract: initializing worker', { langs: this.langs, cachePath });
      this.workerPromise = createWorker(this.langs, 1 /* OEM.LSTM_ONLY */, { cachePath })
        .catch((err) => {
          this.workerPromise = null; // allow retry on next job
          throw err;
        });
    }
    return this.workerPromise;
  }

  async recognize(input: AssetInput): Promise<OcrResult> {
    // Structured listing evidence has no pixels: reflect fields as visible text
    // (same contract as the mock) so extraction can run uniformly.
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
      logger.warn('tesseract: no content loader for asset; returning empty OCR', { assetId: input.assetId });
      return this.empty();
    }
    if (!SUPPORTED_MIME.includes(input.mime)) {
      // HEIC/PDF need a raster conversion step (documented limitation of this adapter).
      logger.warn('tesseract: unsupported mime for direct OCR', { assetId: input.assetId, mime: input.mime });
      return this.empty();
    }
    const buf = input.loadContent();
    const size = input.imageSize;
    if (!size || size.w < 8 || size.h < 8) {
      logger.warn('tesseract: image too small or dimensions unknown', { assetId: input.assetId, size });
      return this.empty();
    }

    const worker = await this.getWorker();
    const { data } = await worker.recognize(buf);
    const blocks: OcrBlock[] = (data.lines ?? [])
      .filter((l) => l.text.trim().length > 0)
      .map((l, i) => {
        const text = l.text.replace(/\s+/g, ' ').trim();
        const script = scriptOf(text);
        return {
          text,
          bbox: {
            x: clamp01(l.bbox.x0 / size.w),
            y: clamp01(l.bbox.y0 / size.h),
            w: clamp01((l.bbox.x1 - l.bbox.x0) / size.w),
            h: clamp01((l.bbox.y1 - l.bbox.y0) / size.h),
          },
          readingOrder: i,
          script,
          lang: script === 'devanagari' ? 'hi' : script === 'mixed' ? 'mixed' : 'en',
          confidence: Math.round(l.confidence) / 100,
        } satisfies OcrBlock;
      });
    return { provider: this.provider, modelVersion: this.modelVersion, isMock: false, blocks };
  }

  private empty(): OcrResult {
    return { provider: this.provider, modelVersion: this.modelVersion, isMock: false, blocks: [] };
  }

  async terminate() {
    if (this.workerPromise) {
      const w = await this.workerPromise.catch(() => null);
      await w?.terminate();
      this.workerPromise = null;
    }
  }
}

function scriptOf(text: string): 'latin' | 'devanagari' | 'mixed' {
  const dev = /[ऀ-ॿ]/.test(text);
  const lat = /[A-Za-z]/.test(text);
  return dev && lat ? 'mixed' : dev ? 'devanagari' : 'latin';
}
const clamp01 = (n: number) => Math.max(0, Math.min(1, Math.round(n * 10000) / 10000));
