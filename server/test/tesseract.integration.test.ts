import { describe, it, expect } from 'vitest';
import { TesseractOCRProvider } from '../src/providers/tesseract.js';
import { imageSize } from '../src/core/imageSize.js';

// REAL-OCR integration test. Gated because it needs network on first run
// (~15 MB language data + a public sample image) and takes ~10-30 s.
//   RUN_TESSERACT_TESTS=1 npm test -- tesseract
const enabled = !!process.env.RUN_TESSERACT_TESTS;

describe.skipIf(!enabled)('tesseract OCR adapter (real provider)', () => {
  it('recognizes English text with normalized bounding boxes', async () => {
    const res = await fetch('https://tesseract.projectnaptha.com/img/eng_bw.png');
    expect(res.ok).toBe(true);
    const buf = Buffer.from(await res.arrayBuffer());
    const size = imageSize(buf);
    expect(size).not.toBeNull();

    const provider = new TesseractOCRProvider('eng');
    try {
      const out = await provider.recognize({
        assetId: 'test', sha256: 'test', mime: 'image/png', faceLabel: 'front',
        loadContent: () => buf, imageSize: size,
      });
      expect(out.isMock).toBe(false);
      expect(out.provider).toBe('tesseract');
      expect(out.blocks.length).toBeGreaterThan(2);
      const all = out.blocks.map((b) => b.text).join(' ');
      expect(all.toLowerCase()).toContain('night'); // sample poem text
      for (const b of out.blocks) {
        expect(b.bbox.x).toBeGreaterThanOrEqual(0);
        expect(b.bbox.y).toBeGreaterThanOrEqual(0);
        expect(b.bbox.x + b.bbox.w).toBeLessThanOrEqual(1.001);
        expect(b.bbox.y + b.bbox.h).toBeLessThanOrEqual(1.001);
        expect(b.confidence).toBeGreaterThan(0);
      }
    } finally {
      await provider.terminate();
    }
  }, 120_000);

  it('returns empty output (not a fake result) for unsupported formats', async () => {
    const provider = new TesseractOCRProvider('eng');
    const out = await provider.recognize({
      assetId: 'x', sha256: 'x', mime: 'application/pdf', faceLabel: 'front',
      loadContent: () => Buffer.from('%PDF-1.4'), imageSize: null,
    });
    expect(out.blocks).toHaveLength(0);
    expect(out.isMock).toBe(false);
    await provider.terminate();
  });
});
