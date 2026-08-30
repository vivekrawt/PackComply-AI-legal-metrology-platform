// ============================================================================
// MOCK / DEMO PROVIDERS — NOT PRODUCTION AI.
// Deterministic implementations seeded by the evidence SHA-256 so the same
// input always produces the same output (idempotent pipeline, testable engine).
// Every result carries isMock: true and the UI displays a demo banner.
// Real providers (e.g. self-hosted OCR) implement the same interfaces and are
// selected explicitly via PROVIDER_* env config — never silently.
// ============================================================================
import type {
  AssetInput, DeclarationExtractionProvider, ExtractionCandidate, ExtractionResult,
  FontMeasurementProvider, FontMeasurementResult, ImageQualityProvider, LayoutProvider,
  LayoutResult, MalwareScanner, OcrBlock, OCRProvider, OcrResult, QualityResult, BBox,
} from './types.js';

function seedInt(sha256: string, offset = 0): number {
  return parseInt(sha256.slice(offset, offset + 6) || 'abcdef', 16);
}
const frac = (n: number, lo: number, hi: number) => lo + (n % 1000) / 1000 * (hi - lo);

// ---------------------------------------------------------------------------
export class MockImageQualityProvider implements ImageQualityProvider {
  provider = 'mock-quality';
  modelVersion = 'mock-quality-1.0.0';
  isMock = true;

  async assess(input: AssetInput): Promise<QualityResult> {
    const s = seedInt(input.sha256);
    const scores = {
      blur: frac(s, 0.55, 0.98),
      glare: frac(s >> 2, 0.5, 0.98),
      occlusion: frac(s >> 4, 0.6, 1),
      resolution: frac(s >> 6, 0.6, 1),
      textScale: frac(s >> 8, 0.5, 1),
      curvature: frac(s >> 10, 0.5, 1),
      clipping: frac(s >> 12, 0.7, 1),
      completeness: frac(s >> 14, 0.7, 1),
    };
    const reasonCodes: string[] = [];
    const guidance: string[] = [];
    if (scores.blur < 0.65) { reasonCodes.push('BLUR_HIGH'); guidance.push('Hold the camera steady and refocus on the label.'); }
    if (scores.glare < 0.6) { reasonCodes.push('GLARE_HIGH'); guidance.push('Tilt the package away from direct light to remove glare.'); }
    if (scores.occlusion < 0.7) { reasonCodes.push('PARTIAL_OCCLUSION'); guidance.push('Ensure no fingers or stickers cover the declarations.'); }
    if (scores.clipping < 0.75) { reasonCodes.push('EDGE_CLIPPED'); guidance.push('Include all edges of this package face in the frame.'); }
    if (scores.completeness < 0.75) { reasonCodes.push('FACE_INCOMPLETE'); guidance.push('Capture the full package face, then add close-ups.'); }
    const overall = Object.values(scores).reduce((a, b) => a + b, 0) / Object.keys(scores).length;
    return {
      provider: this.provider, modelVersion: this.modelVersion, isMock: true,
      scores, overall: Math.round(overall * 100) / 100,
      reasonCodes,
      recapture: { recommended: reasonCodes.length > 0, guidance },
    };
  }
}

// ---------------------------------------------------------------------------
export class MockLayoutProvider implements LayoutProvider {
  provider = 'mock-layout';
  modelVersion = 'mock-layout-1.0.0';
  isMock = true;

  async detect(input: AssetInput): Promise<LayoutResult> {
    const regions = [
      { kind: 'package_face' as const, bbox: { x: 0.02, y: 0.02, w: 0.96, h: 0.96 }, confidence: 0.97 },
      ...(input.faceLabel === 'front'
        ? [{ kind: 'pdp' as const, bbox: { x: 0.08, y: 0.08, w: 0.84, h: 0.55 }, confidence: 0.9 }]
        : []),
      { kind: 'declaration_cluster' as const, bbox: { x: 0.08, y: 0.62, w: 0.84, h: 0.33 }, confidence: 0.88 },
    ];
    return { provider: this.provider, modelVersion: this.modelVersion, isMock: true, regions };
  }
}

// ---------------------------------------------------------------------------
// The mock OCR synthesizes a plausible label from the inspection's product
// context. Variant (seeded by hash) intentionally produces some non-compliant
// labels so rule findings can be demonstrated. Clearly demo data.
export class MockOCRProvider implements OCRProvider {
  provider = 'mock-ocr';
  modelVersion = 'mock-ocr-1.0.0';
  isMock = true;

  async recognize(input: AssetInput): Promise<OcrResult> {
    // Structured listing evidence: reflect the listing fields as visible text.
    if (input.structuredJson && typeof input.structuredJson === 'object') {
      const blocks: OcrBlock[] = [];
      let i = 0;
      for (const [k, v] of Object.entries(input.structuredJson as Record<string, unknown>)) {
        blocks.push(this.block(`${k}: ${String(v)}`, i++, 0.95));
      }
      return { provider: this.provider, modelVersion: this.modelVersion, isMock: true, blocks };
    }

    const seed = seedInt(input.sha256);
    const variant = seed % 4; // 0 complete · 1 no consumer care · 2 bad MRP phrase · 3 qty conflict + no origin
    const brand = input.productContext?.brand || 'Demo Brand';
    const name = input.productContext?.genericName || 'Packaged Food Product';
    const imported = input.productContext?.importStatus === 'imported';
    const qty = input.productContext?.packSize || '500 g';
    const face = input.faceLabel ?? 'front';
    const lines: { text: string; lang?: 'hi'; conf?: number }[] = [];

    if (face === 'front' || face === 'listing') {
      lines.push({ text: brand }, { text: name });
      lines.push({ text: `Net Quantity: ${qty}` });
      lines.push({ text: `नेट मात्रा: ${qty}`, lang: 'hi', conf: 0.86 });
      lines.push(
        variant === 2
          ? { text: `₹ 99.00` } // missing required retail-price wording
          : { text: `MRP ₹ 99.00 (Inclusive of all taxes)` },
      );
    } else if (face === 'back') {
      lines.push({ text: variant === 3 ? `Net Qty: 450 g` : `Net Qty: ${qty}` });
      lines.push({ text: `Mfd. by: Demo Foods Pvt Ltd, Plot 12, Industrial Area, Pune 411001, Maharashtra` });
      lines.push({ text: `Date of Manufacture: 03/2026` });
      lines.push({ text: `Best Before: 12 months from manufacture` });
      if (variant !== 1) {
        lines.push({ text: `Consumer Care: care@demofoods.example, 1800 000 1234` });
      }
      if (imported && variant !== 3) lines.push({ text: `Country of Origin: Malaysia` });
      if (!imported) lines.push({ text: `Marketed in India` });
    } else {
      lines.push({ text: `${brand} — see front and back panels for declarations` });
    }

    const blocks = lines.map((l, i) =>
      this.block(l.text, i, l.conf ?? frac(seed >> (i + 2), 0.78, 0.99), l.lang),
    );
    return { provider: this.provider, modelVersion: this.modelVersion, isMock: true, blocks };
  }

  private block(text: string, order: number, confidence: number, lang?: 'hi'): OcrBlock {
    const y = 0.08 + order * 0.09;
    const isHi = lang === 'hi' || /[ऀ-ॿ]/.test(text);
    return {
      text,
      bbox: { x: 0.1, y: Math.min(y, 0.9), w: 0.8, h: 0.055 },
      readingOrder: order,
      script: isHi ? 'devanagari' : 'latin',
      lang: isHi ? 'hi' : 'en',
      confidence: Math.round(confidence * 100) / 100,
    };
  }
}

// ---------------------------------------------------------------------------
// Deterministic keyword/regex declaration extraction over OCR blocks.
export class HeuristicExtractionProvider implements DeclarationExtractionProvider {
  provider = 'heuristic-extractor';
  modelVersion = 'heuristic-extractor-1.0.0';
  isMock = true; // demo-grade, not a benchmarked production model

  async extract(input: AssetInput, ocr: OcrResult): Promise<ExtractionResult> {
    const channel: 'physical' | 'listing' =
      input.faceLabel === 'listing' || input.structuredJson ? 'listing' : 'physical';
    const candidates: ExtractionCandidate[] = [];
    const push = (declType: string, b: OcrBlock, idx: number) => {
      if (declType !== 'product_name') claimed.add(idx);
      candidates.push({
        declType, verbatimText: b.text, bbox: b.bbox, ocrBlockIndexes: [idx],
        lang: b.lang, script: b.script, confidence: b.confidence, sourceChannel: channel,
      });
    };

    const isFace = input.faceLabel === 'front' || input.faceLabel === 'listing';
    // Blocks already classified as a specific declaration cannot also be the
    // product name (a Devanagari net-quantity line is not a product name).
    const claimed = new Set<number>();

    ocr.blocks.forEach((b, idx) => {
      const t = b.text;
      // Responsible-entity wording is matched first: "Mfd. by: …, Pune 411001"
      // also contains digits and must not be mistaken for a date declaration.
      const isEntity = /(Mfd\.? by|Mfg\.? by|Manufactured by|Packed by|Imported by|Marketed by)/i.test(t);
      if (isEntity) push('responsible_entity', b, idx);

      if (/\b(MRP|M\.R\.P|Maximum Retail Price|₹|Rs\.?\s?\d)/i.test(t) && /\d/.test(t)) push('mrp', b, idx);
      if (/(Net\s?(Quantity|Qty|Wt|Weight)|नेट\s?मात्रा)/i.test(t)) push('net_quantity', b, idx);
      if (/(Unit Sale Price|USP)/i.test(t)) push('unit_sale_price', b, idx);
      if (!isEntity && /\d/.test(t)) {
        if (/(Date of Import|Imported on)/i.test(t)) push('import_date', b, idx);
        else if (/(Date of (Manufacture|Packing)|Manufactured on|Packed on|Mfd\.? on|Mfg\.? on)/i.test(t)) push('mfg_date', b, idx);
      }
      if (/(Best Before|Use By|Expiry|Exp\.? Date)/i.test(t)) push('best_before', b, idx);
      if (/(Consumer Care|Customer Care|Complaints?|care@|@\S+\.\S+|1800[\s-]?\d)/i.test(t)) push('consumer_care', b, idx);
      if (/(Country of Origin|Made in|Product of)/i.test(t)) push('country_of_origin', b, idx);
    });

    // Product name: exactly one candidate per face. Structured listings name it
    // explicitly; on a package face it is the largest confidently-read line that
    // is not already a declaration and not the brand mark.
    const brand = (input.productContext?.brand ?? '').trim().toUpperCase();
    const isBrandMark = (text: string) =>
      brand.length > 2 && text.toUpperCase().replace(/[^A-Z ]/g, ' ').includes(brand);

    const titleIdx = ocr.blocks.findIndex((b) => /listing_title/i.test(b.text));
    let nameIdx = titleIdx;
    if (nameIdx < 0 && isFace) {
      let bestHeight = 0;
      ocr.blocks.forEach((b, idx) => {
        if (claimed.has(idx) || b.confidence < 0.8 || isBrandMark(b.text)) return;
        if (b.bbox.h > bestHeight) { bestHeight = b.bbox.h; nameIdx = idx; }
      });
    }
    if (nameIdx >= 0) push('product_name', ocr.blocks[nameIdx], nameIdx);

    return { provider: this.provider, modelVersion: this.modelVersion, isMock: true, candidates };
  }
}

// ---------------------------------------------------------------------------
export class MockFontMeasurementProvider implements FontMeasurementProvider {
  provider = 'mock-font';
  modelVersion = 'mock-font-1.0.0';
  isMock = true;

  // Returns PIXEL measurements only. Conversion to millimetres happens in the
  // rule engine and ONLY when a valid calibration exists (FNT-01).
  // Uses the real image height when known (e.g. real OCR bboxes); otherwise a
  // nominal height — still pixels, never millimetres.
  async measure(input: AssetInput, candidates: ExtractionCandidate[]): Promise<FontMeasurementResult> {
    const imageHeightPx = input.imageSize?.h ?? 1200;
    const measurements = candidates.map((c) => ({
      declType: c.declType,
      charHeightPx: Math.round(c.bbox.h * imageHeightPx * 0.62 * 10) / 10,
      widthHeightRatio: 0.42,
      lineSpacingPx: Math.round(c.bbox.h * imageHeightPx * 0.3),
      sampleChars: c.verbatimText.slice(0, 12),
      confidence: 0.8,
    }));
    return { provider: this.provider, modelVersion: this.modelVersion, isMock: true, measurements };
  }
}

// ---------------------------------------------------------------------------
export class NoopMalwareScanner implements MalwareScanner {
  name = 'noop-scanner'; // integration point (INS-03); wire a real engine (e.g. ClamAV) in deployment
  async scan(buf: Buffer, filename: string): Promise<{ clean: boolean; threat?: string }> {
    // EICAR test string support so the integration point is testable.
    if (buf.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')) return { clean: false, threat: 'EICAR-Test-File' };
    void filename;
    return { clean: true };
  }
}
