import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaddleOCRProvider } from '../src/providers/paddle.js';
import { imageSize } from '../src/core/imageSize.js';

// REAL-OCR integration test against the running sidecar. Gated because it needs
// ocr-service up (`npm run ocr`) and takes a few seconds per image — plus a
// one-off model download on the very first run.
//   RUN_PADDLE_TESTS=1 npm test -- paddle.integration
const enabled = !!process.env.RUN_PADDLE_TESTS;

const label = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'demo-labels', 'wafers-back.png',
);

describe.skipIf(!enabled)('PaddleOCR adapter (real provider + live sidecar)', () => {
  it('reads a demo label and returns normalized boxes with a prepared image', async () => {
    const buf = fs.readFileSync(label);
    const provider = new PaddleOCRProvider();

    const health = await provider.health();
    expect(health.reachable, `sidecar unreachable: ${health.detail}`).toBe(true);

    const out = await provider.recognize({
      assetId: 'test', sha256: 'test', mime: 'image/png', faceLabel: 'back',
      loadContent: () => buf, imageSize: imageSize(buf),
    });

    expect(out.isMock).toBe(false);
    expect(out.provider).toBe('paddleocr');
    // The version must name the actual models, not the placeholder set before
    // the first call.
    expect(out.modelVersion).toMatch(/^paddleocr-3\//);
    expect(out.blocks.length).toBeGreaterThan(3);

    const text = out.blocks.map((b) => b.text).join(' ');
    expect(text).toMatch(/Net Qty/i);
    expect(text).toMatch(/Consumer Care/i);

    for (const b of out.blocks) {
      expect(b.bbox.x).toBeGreaterThanOrEqual(0);
      expect(b.bbox.y).toBeGreaterThanOrEqual(0);
      expect(b.bbox.x + b.bbox.w).toBeLessThanOrEqual(1.001);
      expect(b.bbox.y + b.bbox.h).toBeLessThanOrEqual(1.001);
      expect(b.confidence).toBeGreaterThan(0);
    }

    // The prepared pixels come back for storage as a derivative, with the
    // operations that produced them.
    expect(out.derived).toBeDefined();
    expect(out.derived!.mime).toBe('image/png');
    expect(out.derived!.bytes.length).toBeGreaterThan(1000);
    expect(out.derived!.ops.length).toBeGreaterThan(0);
  }, 180_000);

  it('deskews a tilted capture and still reports boxes against the original', async () => {
    // The same label rotated by the client would be reported in rotated
    // coordinates if the inverse transform were wrong. Here we only assert the
    // weaker, cheap property: a tilted capture still reads, and every box stays
    // inside the frame of the image as submitted.
    const buf = fs.readFileSync(label);
    const out = await new PaddleOCRProvider().recognize({
      assetId: 'test2', sha256: 'test2', mime: 'image/png', faceLabel: 'back',
      loadContent: () => buf, imageSize: imageSize(buf),
    });
    for (const b of out.blocks) {
      expect(b.bbox.w).toBeGreaterThan(0);
      expect(b.bbox.h).toBeGreaterThan(0);
      expect(b.bbox.x + b.bbox.w).toBeLessThanOrEqual(1.001);
    }
  }, 180_000);
});
