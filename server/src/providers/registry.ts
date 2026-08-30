import { config } from '../core/config.js';
import {
  MockImageQualityProvider, MockLayoutProvider, MockOCRProvider,
  HeuristicExtractionProvider, MockFontMeasurementProvider, NoopMalwareScanner,
} from './mock.js';
import { TesseractOCRProvider } from './tesseract.js';
import type {
  DeclarationExtractionProvider, FontMeasurementProvider, ImageQualityProvider,
  LayoutProvider, MalwareScanner, OCRProvider,
} from './types.js';

// Explicit provider selection. Unknown names fail fast — the system never
// silently falls back from a configured real provider to a mock.
function pick<T>(kind: string, name: string, table: Record<string, () => T>): T {
  const f = table[name];
  if (!f) throw new Error(`Unknown ${kind} provider '${name}'. Configure PROVIDER_* env correctly.`);
  return f();
}

export const providers = {
  quality: pick<ImageQualityProvider>('quality', config.providers.quality, {
    mock: () => new MockImageQualityProvider(),
  }),
  layout: pick<LayoutProvider>('layout', config.providers.layout, {
    mock: () => new MockLayoutProvider(),
  }),
  ocr: pick<OCRProvider>('ocr', config.providers.ocr, {
    mock: () => new MockOCRProvider(),
    // REAL self-hosted OCR (tesseract.js WASM, eng+hin). Language data caches
    // to disk on first use; evidence never leaves the process.
    tesseract: () => new TesseractOCRProvider(),
  }),
  extraction: pick<DeclarationExtractionProvider>('extraction', config.providers.extraction, {
    mock: () => new HeuristicExtractionProvider(),
  }),
  font: pick<FontMeasurementProvider>('font', config.providers.font, {
    mock: () => new MockFontMeasurementProvider(),
  }),
  malware: pick<MalwareScanner>('malware', config.providers.malwareScanner, {
    noop: () => new NoopMalwareScanner(),
  }),
};

export function providerModelVersions() {
  return {
    quality: providers.quality.modelVersion,
    layout: providers.layout.modelVersion,
    ocr: providers.ocr.modelVersion,
    extraction: providers.extraction.modelVersion,
    font: providers.font.modelVersion,
  };
}

// Exactly which components are demo providers — never reported as a blanket
// "everything is mocked", which would misstate the real OCR now in use.
export function mockComponents(): string[] {
  return Object.entries({
    'image quality': providers.quality,
    layout: providers.layout,
    OCR: providers.ocr,
    'declaration extraction': providers.extraction,
    'font measurement': providers.font,
  }).filter(([, p]) => p.isMock).map(([name]) => name);
}

export function anyMock(): boolean {
  return mockComponents().length > 0;
}
