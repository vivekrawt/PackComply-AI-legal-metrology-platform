import { describe, it, expect } from 'vitest';
import { evaluateRule, type EngineContext, type RuleVersionData } from '../src/modules/evaluation/engine.js';

const ctxBase = (over: Partial<EngineContext> = {}): EngineContext => ({
  eventDate: '2026-08-01', inspectionType: 'physical_retail', jurisdiction: 'IN',
  product: { category: 'packaged_food', packageType: 'retail', importStatus: 'domestic', presentationMode: 'printed' },
  declarations: [], coverage: { complete: true, missing: [] },
  calibrations: [], fontMeasurements: [], pdpAssets: [], frontAssets: [], ...over,
});

const decl = (declType: string, verbatim: string, normalized: any, extra: any = {}) => ({
  id: `d_${declType}`, declType, verbatimText: verbatim, normalized,
  confidence: 0.95, needsReview: false, reviewReasons: [], sourceChannel: 'physical' as const,
  presentationMode: 'printed', evidenceRegions: [{ assetId: 'a1', bbox: { x: 0, y: 0, w: 0.5, h: 0.05 } }], ...extra,
});

const rule = (checks: any[], over: Partial<RuleVersionData> = {}): RuleVersionData => ({
  id: 'rv_test', ruleKey: 'test.rule', version: 1, title: 'Test rule', citation: 'Test citation',
  legalStatus: 'REQUIRES_LEGAL_APPROVAL',
  applicability: { categories: ['*'], channels: ['*'], importStatus: ['*'] },
  inputs: {}, logic: { checks }, outcome: { severityOnFail: 'high' }, ...over,
});

const qty = decl('net_quantity', 'Net Quantity: 500 g',
  { value: { quantity: 500, baseQuantity: 500, baseUnit: 'g' }, unit: 'g', ambiguous: false });

describe('rule engine — five outcomes (REG-13)', () => {
  it('presence passes when declaration exists', () => {
    const r = evaluateRule(rule([{ type: 'presence', declType: 'net_quantity' }]), ctxBase({ declarations: [qty] }));
    expect(r.outcome).toBe('passed');
  });

  it('presence fails only with complete coverage (missing declaration)', () => {
    const r = evaluateRule(rule([{ type: 'presence', declType: 'net_quantity' }]), ctxBase());
    expect(r.outcome).toBe('failed');
    expect(r.severity).toBe('high');
  });

  it('presence is NOT ASSESSABLE when coverage is incomplete — absence cannot be proven', () => {
    const r = evaluateRule(
      rule([{ type: 'presence', declType: 'net_quantity' }]),
      ctxBase({ coverage: { complete: false, missing: ['back'] } }),
    );
    expect(r.outcome).toBe('not_assessable');
    expect(r.reasonCode).toBe('EVIDENCE_INCOMPLETE');
  });

  it('uncertain extraction routes to needs_review, not pass/fail', () => {
    const flagged = { ...qty, needsReview: true, reviewReasons: ['LOW_CONFIDENCE'] };
    const r = evaluateRule(rule([{ type: 'presence', declType: 'net_quantity' }]), ctxBase({ declarations: [flagged] }));
    expect(r.outcome).toBe('needs_review');
  });

  it('rule outside applicability returns not_applicable with an explanation', () => {
    const r = evaluateRule(
      rule([{ type: 'presence', declType: 'net_quantity' }], { applicability: { categories: ['pan_masala'] } }),
      ctxBase({ declarations: [qty] }),
    );
    expect(r.outcome).toBe('not_applicable');
    expect(r.explanation).toContain('category');
  });
});

describe('CRITICAL: calibrated font size (FNT-01, UAT-03/04)', () => {
  const fontRule = rule([{
    type: 'calibrated_font_size', declType: 'net_quantity',
    thresholdTable: [{ presentationMode: 'printed', minHeightMm: 2 }],
  }]);
  const meas = [{ declType: 'net_quantity', charHeightPx: 50, sampleChars: '500 g' }];

  it('Case A: valid calibration + below threshold → FAILED with measurement in mm', () => {
    const r = evaluateRule(fontRule, ctxBase({
      declarations: [qty],
      calibrations: [{ assetId: 'a1', mmPerPx: 0.02, uncertaintyPct: 5, method: 'marker' }], // 1.0 mm
      fontMeasurements: meas,
    }));
    expect(r.outcome).toBe('failed');
    expect(r.explanation).toContain('1 mm');
  });

  it('Case A2: valid calibration + above threshold → PASSED', () => {
    const r = evaluateRule(fontRule, ctxBase({
      declarations: [qty],
      calibrations: [{ assetId: 'a1', mmPerPx: 0.06, uncertaintyPct: 5, method: 'marker' }], // 3.0 mm
      fontMeasurements: meas,
    }));
    expect(r.outcome).toBe('passed');
  });

  it('Case B: SAME measurement but NO calibration → MUST be not_assessable (never inferred from pixels)', () => {
    const r = evaluateRule(fontRule, ctxBase({ declarations: [qty], calibrations: [], fontMeasurements: meas }));
    expect(r.outcome).toBe('not_assessable');
    expect(r.reasonCode).toBe('NO_VALID_SCALE');
  });
});

describe('format / chronology / cross-field / conflict checks', () => {
  it('MRP without required phrase fails', () => {
    const mrp = decl('mrp', '₹ 99.00', { value: { amount: 99, currency: 'INR', taxInclusivePhrasePresent: false }, ambiguous: false });
    const r = evaluateRule(
      rule([{ type: 'format', declType: 'mrp', expect: 'currency_inr', requirePhrase: 'inclusive of all taxes' }]),
      ctxBase({ declarations: [mrp] }),
    );
    expect(r.outcome).toBe('failed');
    expect(r.reasonCode).toBe('REQUIRED_PHRASE_MISSING');
  });

  it('impossible chronology fails', () => {
    const mfg = decl('mfg_date', '03/2026', { value: { year: 2026, month: 3, iso: '2026-03' }, ambiguous: false });
    const exp = decl('best_before', '01/2026', { value: { year: 2026, month: 1, iso: '2026-01' }, ambiguous: false });
    const r = evaluateRule(rule([{ type: 'chronology', earlier: 'mfg_date', later: 'best_before' }]),
      ctxBase({ declarations: [mfg, exp] }));
    expect(r.outcome).toBe('failed');
    expect(r.reasonCode).toBe('IMPOSSIBLE_CHRONOLOGY');
  });

  it('origin required only for imported products', () => {
    const check = [{ type: 'cross_field', kind: 'origin_required_if_imported' }];
    const domestic = evaluateRule(rule(check as any), ctxBase());
    expect(domestic.outcome).toBe('not_applicable');
    const imported = evaluateRule(rule(check as any),
      ctxBase({ product: { category: 'x', packageType: 'retail', importStatus: 'imported', presentationMode: 'printed' } }));
    expect(imported.outcome).toBe('failed');
  });

  it('conflicting quantities across faces fail with both values named', () => {
    const conflicted = { ...qty, normalized: { ...qty.normalized, conflictingValues: ['500 g', '450 g'] } };
    const r = evaluateRule(rule([{ type: 'conflict', declType: 'net_quantity' }]), ctxBase({ declarations: [conflicted] }));
    expect(r.outcome).toBe('failed');
    expect(r.explanation).toContain('450 g');
  });

  it('listing comparison flags contradictions between channels', () => {
    const phys = qty;
    const list = decl('net_quantity', 'Net Quantity: 400 g',
      { value: { quantity: 400, baseQuantity: 400, baseUnit: 'g' }, unit: 'g', ambiguous: false }, { sourceChannel: 'listing' });
    const r = evaluateRule(rule([{ type: 'listing_comparison', declTypes: ['net_quantity'] }]),
      ctxBase({ inspectionType: 'ecommerce', declarations: [phys, list] }));
    expect(r.outcome).toBe('failed');
    expect(r.reasonCode).toBe('LISTING_MISMATCH');
  });
});
