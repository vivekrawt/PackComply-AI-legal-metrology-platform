// ============================================================================
// Deterministic legal rule engine (REG-*). Pure functions — no DB, no I/O —
// interpreting VERSIONED rule configuration. Legal logic is data, not code.
// Outcomes are exactly: passed | failed | needs_review | not_applicable |
// not_assessable (REG-13). Uncertainty is never forced into pass/fail.
// ============================================================================

export const ENGINE_VERSION = 'engine-1.0.0';

export type Outcome = 'passed' | 'failed' | 'needs_review' | 'not_applicable' | 'not_assessable';

export interface RuleVersionData {
  id: string;
  ruleKey: string;
  version: number;
  title: string;
  citation: string;
  legalStatus: string; // 'APPROVED' | 'REQUIRES_LEGAL_APPROVAL'
  applicability: {
    categories?: string[];        // ['*'] or explicit list
    excludeCategories?: string[];
    channels?: string[];          // inspection types; ['*'] = all
    packageTypes?: string[];
    importStatus?: string[];      // ['*'] | ['imported'] | ['domestic']
    jurisdictions?: string[];
  };
  inputs: { declTypes?: string[]; requiresCalibration?: boolean; requiresGeometry?: boolean };
  logic: { checks: Check[] };
  outcome: { severityOnFail?: string; remediation?: string; reportWording?: string };
}

export type Check =
  | { type: 'always'; outcome: Outcome; reasonCode: string; explanation: string }
  | { type: 'presence'; declType: string; channel?: 'physical' | 'listing' }
  // A declaration family satisfied by any one of several types — e.g. the PRD's
  // date family: "manufacture, packing or import date".
  | { type: 'presence_any'; declTypes: string[]; channel?: 'physical' | 'listing' }
  | { type: 'format'; declType: string; expect: 'currency_inr' | 'value_unit' | 'date' | 'contact' | 'country' | 'entity'; requirePhrase?: string; allowedUnits?: string[] }
  | { type: 'conflict'; declType: string }
  | { type: 'chronology'; earlier: string; later: string }
  | { type: 'cross_field'; kind: 'origin_required_if_imported' }
  | { type: 'calibrated_font_size'; declType: string; thresholdTable: { presentationMode: string; minHeightMm: number }[] }
  | { type: 'placement'; declType: string; requires: 'pdp' }
  | { type: 'listing_comparison'; declTypes: string[] };

export interface DeclInput {
  id: string;
  declType: string;
  verbatimText: string;
  normalized: { value: unknown; unit?: string; ambiguous?: boolean; conflictingValues?: string[] } | null;
  confidence: number | null;
  needsReview: boolean;
  reviewReasons: string[];
  sourceChannel: 'physical' | 'listing';
  presentationMode: string;
  evidenceRegions: { assetId: string; bbox: unknown; ocrBlockIds?: string[]; verbatim?: string }[];
}

export interface EngineContext {
  eventDate: string;                       // inspection/event date for rule selection & evaluation
  inspectionType: string;
  jurisdiction: string;
  product: {
    category: string | null; packageType: string | null; importStatus: string | null;
    presentationMode: string | null;
  } | null;
  declarations: DeclInput[];
  coverage: { complete: boolean; missing: string[] };
  calibrations: { assetId: string; mmPerPx: number; uncertaintyPct: number | null; method: string }[];
  fontMeasurements: { declType: string; charHeightPx: number; sampleChars?: string }[]; // PIXELS only
  pdpAssets: string[];                     // asset ids that have a detected/edited PDP region
  frontAssets: string[];
}

export interface EvalResult {
  outcome: Outcome;
  reasonCode: string;
  explanation: string;
  severity: string | null;
  evidenceRefs: { assetId?: string; declarationId?: string; bbox?: unknown }[];
}

const OUTCOME_RANK: Record<Outcome, number> = {
  failed: 4, not_assessable: 3, needs_review: 2, passed: 1, not_applicable: 0,
};

function matches(list: string[] | undefined, value: string | null | undefined): boolean {
  if (!list || list.length === 0 || list.includes('*')) return true;
  return value != null && list.includes(value);
}

export function isApplicable(rule: RuleVersionData, ctx: EngineContext): { applicable: boolean; reason: string } {
  const a = rule.applicability;
  const cat = ctx.product?.category ?? null;
  if (a.excludeCategories?.length && cat && a.excludeCategories.includes(cat)) {
    return { applicable: false, reason: `Category '${cat}' is excluded by this rule's applicability` };
  }
  if (!matches(a.categories, cat)) return { applicable: false, reason: `Category '${cat ?? 'unspecified'}' is outside this rule's category scope` };
  if (!matches(a.channels, ctx.inspectionType)) return { applicable: false, reason: `Channel '${ctx.inspectionType}' is outside this rule's channel scope` };
  if (!matches(a.packageTypes, ctx.product?.packageType)) return { applicable: false, reason: `Package type is outside this rule's scope` };
  if (!matches(a.importStatus, ctx.product?.importStatus)) return { applicable: false, reason: `Import status '${ctx.product?.importStatus ?? 'unspecified'}' is outside this rule's scope` };
  if (!matches(a.jurisdictions, ctx.jurisdiction)) return { applicable: false, reason: 'Jurisdiction is outside this rule\'s scope' };
  return { applicable: true, reason: 'Applicability conditions satisfied' };
}

export function evaluateRule(rule: RuleVersionData, ctx: EngineContext): EvalResult {
  const app = isApplicable(rule, ctx);
  if (!app.applicable) {
    return { outcome: 'not_applicable', reasonCode: 'NOT_APPLICABLE', explanation: app.reason, severity: null, evidenceRefs: [] };
  }
  const results = rule.logic.checks.map((c) => evaluateCheck(rule, c, ctx));
  // Worst outcome wins: failed > not_assessable > needs_review > passed.
  let worst = results[0] ?? {
    outcome: 'not_assessable' as Outcome, reasonCode: 'NO_CHECKS',
    explanation: 'Rule version has no executable checks', severity: null, evidenceRefs: [],
  };
  for (const r of results) if (OUTCOME_RANK[r.outcome] > OUTCOME_RANK[worst.outcome]) worst = r;
  if (worst.outcome === 'failed') worst.severity = rule.outcome.severityOnFail ?? 'medium';
  return worst;
}

function decls(ctx: EngineContext, declType: string, channel?: 'physical' | 'listing'): DeclInput[] {
  return ctx.declarations.filter((d) => d.declType === declType && (!channel || d.sourceChannel === channel));
}
const refs = (ds: DeclInput[]) =>
  ds.flatMap((d) => d.evidenceRegions.map((r) => ({ assetId: r.assetId, declarationId: d.id, bbox: r.bbox })));

function evaluateCheck(rule: RuleVersionData, check: Check, ctx: EngineContext): EvalResult {
  const ok = (explanation: string, evidenceRefs: EvalResult['evidenceRefs'] = []): EvalResult =>
    ({ outcome: 'passed', reasonCode: 'OK', explanation, severity: null, evidenceRefs });
  const fail = (reasonCode: string, explanation: string, evidenceRefs: EvalResult['evidenceRefs'] = []): EvalResult =>
    ({ outcome: 'failed', reasonCode, explanation, severity: rule.outcome.severityOnFail ?? 'medium', evidenceRefs });
  const review = (reasonCode: string, explanation: string, evidenceRefs: EvalResult['evidenceRefs'] = []): EvalResult =>
    ({ outcome: 'needs_review', reasonCode, explanation, severity: null, evidenceRefs });
  const notAssessable = (reasonCode: string, explanation: string): EvalResult =>
    ({ outcome: 'not_assessable', reasonCode, explanation, severity: null, evidenceRefs: [] });

  switch (check.type) {
    case 'always':
      return { outcome: check.outcome, reasonCode: check.reasonCode, explanation: check.explanation, severity: null, evidenceRefs: [] };

    case 'presence': {
      const found = decls(ctx, check.declType, check.channel);
      if (found.length > 0) {
        const flagged = found.filter((d) => d.needsReview);
        if (flagged.length > 0) {
          return review('EXTRACTION_UNCERTAIN',
            `A '${check.declType}' declaration was detected but extraction is uncertain (${flagged[0].reviewReasons.join(', ')}). Officer confirmation required.`,
            refs(found));
        }
        return ok(`Declaration '${check.declType}' is present.`, refs(found));
      }
      if (!ctx.coverage.complete) {
        return notAssessable('EVIDENCE_INCOMPLETE',
          `Declaration '${check.declType}' was not found, but required package views are missing (${ctx.coverage.missing.join(', ')}). ` +
          `Absence cannot be established from incomplete evidence — capture the missing views or record a waiver.`);
      }
      return fail('DECLARATION_MISSING', `Mandatory declaration '${check.declType}' was not found on any captured package face.`);
    }

    case 'presence_any': {
      const found = check.declTypes.flatMap((dt) => decls(ctx, dt, check.channel));
      const label = check.declTypes.join(' / ');
      if (found.length > 0) {
        const flagged = found.filter((d) => d.needsReview);
        if (flagged.length > 0) {
          return review('EXTRACTION_UNCERTAIN',
            `A declaration in the '${label}' family was detected but extraction is uncertain (${flagged[0].reviewReasons.join(', ')}). Officer confirmation required.`,
            refs(found));
        }
        return ok(`Declaration family '${label}' is satisfied by '${found[0].declType}'.`, refs(found));
      }
      if (!ctx.coverage.complete) {
        return notAssessable('EVIDENCE_INCOMPLETE',
          `No declaration in the '${label}' family was found, but required package views are missing (${ctx.coverage.missing.join(', ')}). ` +
          `Absence cannot be established from incomplete evidence — capture the missing views or record a waiver.`);
      }
      return fail('DECLARATION_MISSING', `No declaration from the mandatory '${label}' family was found on any captured package face.`);
    }

    case 'format': {
      const found = decls(ctx, check.declType);
      if (found.length === 0) return notAssessable('DECLARATION_ABSENT', `No '${check.declType}' declaration available to validate.`);
      const d = found[0];
      const n = d.normalized;
      if (!n || n.ambiguous) {
        return review('AMBIGUOUS_VALUE', `The '${check.declType}' value "${d.verbatimText}" could not be unambiguously parsed. Officer review required.`, refs([d]));
      }
      const v: any = n.value;
      switch (check.expect) {
        case 'currency_inr': {
          if (!v || v.currency !== 'INR' || !(v.amount > 0)) return fail('INVALID_CURRENCY', `"${d.verbatimText}" does not contain a valid Indian-currency amount.`, refs([d]));
          if (check.requirePhrase && !v.taxInclusivePhrasePresent) {
            return fail('REQUIRED_PHRASE_MISSING', `Retail price "${d.verbatimText}" lacks the required wording ("${check.requirePhrase}").`, refs([d]));
          }
          return ok(`Price value ₹${v.amount} parsed with required form.`, refs([d]));
        }
        case 'value_unit': {
          if (!v || !(v.quantity > 0)) return fail('INVALID_QUANTITY', `"${d.verbatimText}" does not contain a valid quantity value.`, refs([d]));
          if (check.allowedUnits && n.unit && !check.allowedUnits.includes(n.unit)) {
            return fail('UNIT_NOT_ALLOWED', `Unit '${n.unit}' is not in the permitted unit list for this declaration.`, refs([d]));
          }
          if (!n.unit) return review('UNIT_UNRECOGNIZED', `Unit in "${d.verbatimText}" was not recognized against the approved unit table.`, refs([d]));
          return ok(`Quantity ${v.quantity} ${n.unit} parsed and unit permitted.`, refs([d]));
        }
        case 'date': {
          if (!v || (!v.iso && !v.relativeMonths)) return fail('INVALID_DATE', `"${d.verbatimText}" is not a recognizable date declaration.`, refs([d]));
          return ok(`Date declaration parsed (${v.iso ?? v.relativeMonths + ' months relative'}).`, refs([d]));
        }
        case 'contact': {
          if (!v || (!v.email && !v.phone)) return fail('CONTACT_MISSING', `"${d.verbatimText}" contains no valid telephone or e-mail contact.`, refs([d]));
          return ok(`Consumer-care contact parsed (${[v.email, v.phone].filter(Boolean).join(', ')}).`, refs([d]));
        }
        case 'country': {
          if (!v || !v.country) return review('COUNTRY_UNRECOGNIZED', `Country value "${d.verbatimText}" was not matched to the approved country table.`, refs([d]));
          return ok(`Country of origin normalized to ${v.country}.`, refs([d]));
        }
        case 'entity': {
          if (!v || !v.nameAndAddress) return fail('ENTITY_INCOMPLETE', `Responsible-entity declaration lacks a name and address.`, refs([d]));
          if (!v.hasAddressStructure) return review('ADDRESS_STRUCTURE_UNCERTAIN', `Responsible-entity address in "${d.verbatimText}" lacks a recognizable PIN code; verify completeness.`, refs([d]));
          return ok(`Responsible entity (${v.role}) with structured address present.`, refs([d]));
        }
      }
      return review('UNKNOWN_FORMAT_CHECK', 'Unknown format expectation in rule configuration.');
    }

    case 'conflict': {
      const found = decls(ctx, check.declType);
      const withConflict = found.filter((d) => d.normalized?.conflictingValues?.length);
      if (withConflict.length > 0) {
        const vals = withConflict[0].normalized!.conflictingValues!.join('" vs "');
        return fail('CONFLICTING_VALUES', `Conflicting '${check.declType}' values across package faces: "${vals}".`, refs(withConflict));
      }
      if (found.length === 0) return notAssessable('DECLARATION_ABSENT', `No '${check.declType}' declaration available for conflict checking.`);
      return ok(`No conflicting '${check.declType}' values detected across faces.`, refs(found));
    }

    case 'chronology': {
      const e = decls(ctx, check.earlier)[0];
      const l = decls(ctx, check.later)[0];
      if (!e || !l) return notAssessable('DATES_INCOMPLETE', `Both '${check.earlier}' and '${check.later}' are needed for chronology validation.`);
      const ev: any = e.normalized?.value; const lv: any = l.normalized?.value;
      if (lv?.relativeMonths) return ok(`'${check.later}' is declared relative to manufacture (${lv.relativeMonths} months); chronology consistent.`, refs([e, l]));
      if (!ev?.iso || !lv?.iso) return review('DATE_UNPARSED', 'One of the dates could not be parsed for chronology validation.', refs([e, l]));
      if (lv.iso < ev.iso) return fail('IMPOSSIBLE_CHRONOLOGY', `'${check.later}' (${lv.iso}) precedes '${check.earlier}' (${ev.iso}).`, refs([e, l]));
      return ok(`Chronology consistent: ${ev.iso} → ${lv.iso}.`, refs([e, l]));
    }

    case 'cross_field': {
      if (check.kind === 'origin_required_if_imported') {
        if (ctx.product?.importStatus !== 'imported') {
          return { outcome: 'not_applicable', reasonCode: 'NOT_IMPORTED', explanation: 'Product is not declared as imported.', severity: null, evidenceRefs: [] };
        }
        const found = decls(ctx, 'country_of_origin');
        if (found.length > 0) return ok('Country of origin declared for imported product.', refs(found));
        if (!ctx.coverage.complete) return notAssessable('EVIDENCE_INCOMPLETE', 'Country of origin not found, but package coverage is incomplete.');
        return fail('ORIGIN_MISSING', 'Imported product has no country-of-origin declaration on captured evidence.');
      }
      return review('UNKNOWN_CROSS_FIELD', 'Unknown cross-field kind in rule configuration.');
    }

    case 'calibrated_font_size': {
      // FNT-01 HARD GATE: physical size is evaluated ONLY with a valid calibration.
      // Millimetres are never inferred from pixels alone.
      const found = decls(ctx, check.declType);
      if (found.length === 0) return notAssessable('DECLARATION_ABSENT', `No '${check.declType}' declaration to measure.`);
      const calib = ctx.calibrations.find((c) => c.mmPerPx > 0);
      if (!calib) {
        return notAssessable('NO_VALID_SCALE',
          'No valid physical scale is available (no calibration marker, known dimension or approved measurement). ' +
          'Physical character-size compliance is Not Assessable; capture with a calibration reference to evaluate.');
      }
      const meas = ctx.fontMeasurements.find((m) => m.declType === check.declType);
      if (!meas) return notAssessable('NO_MEASUREMENT', `No character measurement is available for '${check.declType}'.`);
      const mode = found[0].presentationMode || ctx.product?.presentationMode || 'printed';
      const row = check.thresholdTable.find((r) => r.presentationMode === mode) ?? check.thresholdTable.find((r) => r.presentationMode === '*');
      if (!row) return notAssessable('NO_THRESHOLD_FOR_MODE', `No approved threshold row exists for presentation mode '${mode}'.`);
      const heightMm = Math.round(meas.charHeightPx * calib.mmPerPx * 100) / 100;
      const unc = calib.uncertaintyPct != null ? ` (±${calib.uncertaintyPct}%)` : '';
      if (heightMm < row.minHeightMm) {
        return fail('CHAR_HEIGHT_BELOW_MIN',
          `Measured character height ${heightMm} mm${unc} for '${check.declType}' is below the configured minimum ${row.minHeightMm} mm ` +
          `(calibration: ${calib.method}, ${calib.mmPerPx} mm/px; sample "${meas.sampleChars ?? ''}").`, refs(found));
      }
      return ok(`Measured character height ${heightMm} mm${unc} meets the configured minimum ${row.minHeightMm} mm (calibration: ${calib.method}).`, refs(found));
    }

    case 'placement': {
      const found = decls(ctx, check.declType);
      if (found.length === 0) return notAssessable('DECLARATION_ABSENT', `No '${check.declType}' declaration to locate.`);
      if (ctx.pdpAssets.length === 0) return notAssessable('GEOMETRY_UNAVAILABLE', 'No principal display panel geometry is available (detect or mark the PDP to evaluate placement).');
      const onPdp = found.some((d) => d.evidenceRegions.some((r) => ctx.pdpAssets.includes(r.assetId)));
      if (!onPdp) return fail('NOT_ON_PDP', `'${check.declType}' does not appear on any face containing the principal display panel.`, refs(found));
      return ok(`'${check.declType}' appears on a face containing the principal display panel.`, refs(found));
    }

    case 'listing_comparison': {
      if (ctx.inspectionType !== 'ecommerce' && !ctx.declarations.some((d) => d.sourceChannel === 'listing')) {
        return { outcome: 'not_applicable', reasonCode: 'NO_LISTING', explanation: 'No online listing evidence to compare.', severity: null, evidenceRefs: [] };
      }
      const problems: string[] = [];
      const evidence: EvalResult['evidenceRefs'] = [];
      for (const t of check.declTypes) {
        const phys = decls(ctx, t, 'physical');
        const list = decls(ctx, t, 'listing');
        if (phys.length && list.length) {
          const pv = JSON.stringify(phys[0].normalized?.value ?? phys[0].verbatimText);
          const lv = JSON.stringify(list[0].normalized?.value ?? list[0].verbatimText);
          if (pv !== lv) {
            problems.push(`'${t}' contradicts: physical "${phys[0].verbatimText}" vs listing "${list[0].verbatimText}"`);
            evidence.push(...refs([phys[0], list[0]]));
          }
        } else if (phys.length && !list.length) {
          problems.push(`'${t}' present on the physical pack but missing from the listing`);
          evidence.push(...refs(phys));
        }
      }
      if (problems.length > 0) return fail('LISTING_MISMATCH', `Online listing differs from the physical package: ${problems.join('; ')}.`, evidence);
      return ok('Online listing declarations are consistent with the physical package for the compared fields.');
    }
  }
}
