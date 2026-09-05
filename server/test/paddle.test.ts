import { describe, it, expect, vi, afterEach } from 'vitest';
import { PaddleOCRProvider } from '../src/providers/paddle.js';
import { config } from '../src/core/config.js';
import type { AssetInput } from '../src/providers/types.js';

// The PaddleOCR adapter with the sidecar stubbed. What matters here is
// everything around the model call: that provenance is stamped, that the
// prepared image comes back as a storable derivative, that an unreachable
// service fails loudly instead of quietly degrading to another engine, and that
// a transient fault is retried while a bad request is not.

const IMAGE: AssetInput = {
  assetId: 'ast_1', sha256: 'abc', mime: 'image/jpeg', faceLabel: 'back',
  loadContent: () => Buffer.from('fake-jpeg-bytes'),
  imageSize: { w: 1200, h: 900 },
};

function ocrReply(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function serviceReply(overrides: Record<string, unknown> = {}) {
  return ocrReply({
    provider: 'paddleocr',
    modelVersion: 'paddleocr-3/PP-OCRv5/en+devanagari',
    blocks: [
      { text: 'Net Qty: 150 g', bbox: { x: 0.04, y: 0.5, w: 0.22, h: 0.04 }, readingOrder: 0,
        script: 'latin', lang: 'en', confidence: 0.99 },
      { text: 'शुद्ध मात्रा: 150 ग्राम', bbox: { x: 0.04, y: 0.56, w: 0.3, h: 0.04 }, readingOrder: 1,
        script: 'devanagari', lang: 'hi', confidence: 0.91 },
    ],
    preprocessing: {
      ops: [{ op: 'rotate', reason: 'deskew', degrees: -6 }, { op: 'clahe', clipLimit: 2 }],
      inputSize: { w: 1200, h: 900 }, outputSize: { w: 1100, h: 820 },
    },
    processedImage: {
      mime: 'image/png', bytes: 9,
      sha256: 'deadbeef', base64: Buffer.from('processed').toString('base64'),
    },
    ...overrides,
  });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('PaddleOCR provider', () => {
  it('parses blocks and stamps the model version the service reported', async () => {
    const fetchMock = vi.fn().mockResolvedValue(serviceReply());
    vi.stubGlobal('fetch', fetchMock);

    const result = await new PaddleOCRProvider().recognize(IMAGE);

    expect(result.provider).toBe('paddleocr');
    expect(result.isMock).toBe(false);
    // Stamped from the service, not guessed here: an OCR row names the models
    // that actually ran.
    expect(result.modelVersion).toBe('paddleocr-3/PP-OCRv5/en+devanagari');
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0].text).toBe('Net Qty: 150 g');
    expect(result.blocks[0].bbox).toEqual({ x: 0.04, y: 0.5, w: 0.22, h: 0.04 });
  });

  it('classifies script and language from the text itself', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serviceReply()));
    const result = await new PaddleOCRProvider().recognize(IMAGE);
    expect(result.blocks[0].script).toBe('latin');
    expect(result.blocks[0].lang).toBe('en');
    expect(result.blocks[1].script).toBe('devanagari');
    expect(result.blocks[1].lang).toBe('hi');
  });

  it('returns the prepared image and its operations for storage as a derivative', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serviceReply()));
    const result = await new PaddleOCRProvider().recognize(IMAGE);

    expect(result.derived).toBeDefined();
    expect(result.derived!.mime).toBe('image/png');
    expect(result.derived!.bytes.toString()).toBe('processed');
    // The audit trail needs the operations, not just the pixels.
    expect(result.derived!.ops).toHaveLength(2);
    expect(result.derived!.inputSize).toEqual({ w: 1200, h: 900 });
  });

  it('sends the configured preparation toggles with the image', async () => {
    const fetchMock = vi.fn().mockResolvedValue(serviceReply());
    vi.stubGlobal('fetch', fetchMock);
    await new PaddleOCRProvider().recognize(IMAGE);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${config.paddle.baseUrl}/ocr`);
    const form = init.body as FormData;
    expect(form.get('deskew')).toBe('true');
    expect(form.get('crop')).toBe('true');
    expect(form.get('enhance')).toBe('true');
    expect(form.get('image')).toBeInstanceOf(Blob);
  });

  it('reflects structured listing evidence without calling the service', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await new PaddleOCRProvider().recognize({
      ...IMAGE, structuredJson: { net_quantity: '150 g', mrp: 'Rs. 20' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.blocks.map((b) => b.text)).toEqual(['net_quantity: 150 g', 'mrp: Rs. 20']);
  });

  it('skips a format it cannot read rather than sending it', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // HEIC and PDF need a raster conversion step that is not bundled.
    const result = await new PaddleOCRProvider().recognize({ ...IMAGE, mime: 'image/heic' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.blocks).toEqual([]);
  });

  it('retries a 503 from a still-loading service and succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ocrReply({ detail: 'loading' }, 503))
      .mockResolvedValueOnce(serviceReply());
    vi.stubGlobal('fetch', fetchMock);
    const prev = { ...config.paddle };
    Object.assign(config.paddle, { backoffMs: 1, backoffCapMs: 5 });
    try {
      const result = await new PaddleOCRProvider().recognize(IMAGE);
      expect(result.blocks).toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { Object.assign(config.paddle, prev); }
  });

  it('does not retry a rejected image', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ocrReply({ detail: 'could not decode image' }, 400));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new PaddleOCRProvider().recognize(IMAGE)).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails loudly when the service is down, naming how to start it', async () => {
    // The whole point of a configured real provider: it must never quietly
    // become a different engine because a process was not running.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    const prev = { ...config.paddle };
    Object.assign(config.paddle, { maxAttempts: 2, backoffMs: 1, backoffCapMs: 5 });
    try {
      await expect(new PaddleOCRProvider().recognize(IMAGE))
        .rejects.toThrow(/npm run ocr/);
    } finally { Object.assign(config.paddle, prev); }
  });
});
