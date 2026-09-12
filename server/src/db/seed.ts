// Seed data — SYNTHETIC / FICTIONAL demo content only. Nothing here represents
// a real enforcement decision, real entity, or certified legal parameters.
// All seeded rule versions carry legal_status = REQUIRES_LEGAL_APPROVAL:
// the structure follows the PRD's declaration catalogue; exact statutory
// parameters must be certified by the legal domain owner before real use.
import type { DB } from './index.js';
import { getDb, now } from './index.js';
import { newId } from '../core/ids.js';
import { createUser, syncRolePermissions } from '../modules/auth/service.js';
import type { SessionUser } from '../modules/auth/service.js';
import { createInspection } from '../modules/inspections/service.js';
import { ingestFileEvidence, ingestUrlEvidence, addCalibration } from '../modules/evidence/service.js';
import { enqueueJob, drainJobs } from '../modules/processing/queue.js';
import { registerPipelineHandlers } from '../modules/processing/pipeline.js';
import { runEvaluation } from '../modules/evaluation/service.js';
import { listFindings, disposeFinding } from '../modules/findings/service.js';
import { finalizeInspection } from '../modules/reports/service.js';
import { logger } from '../core/logger.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'PackComply#2026';

// Synthetic demo package labels — real, legible PNG artwork of clearly
// FICTIONAL products (see scripts/generate-demo-labels.mjs). Real OCR reads
// these end to end; the mock provider ignores their pixels by design.
const LABEL_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'demo-labels',
);

function labelImage(name: string): Buffer {
  const p = path.join(LABEL_DIR, name);
  if (!fs.existsSync(p)) {
    throw new Error(`Demo label asset missing: ${p} — run "node scripts/generate-demo-labels.mjs"`);
  }
  return fs.readFileSync(p);
}

export function seedIfEmpty(db: DB = getDb()) {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as any).c;
  if (count > 0) return;
  logger.info('seeding demo data (synthetic/fictional only)');
  seed(db);
}

export function seed(db: DB) {
  const t = now();

  // --- Permissions matrix -> table (informational mirror; checks use code matrix)
  syncRolePermissions(db);

  // --- Organization tree (fictional)
  const orgId = 'org_demo';
  db.prepare("INSERT INTO organizations (id, name, kind, created_at) VALUES (?, 'Demo Legal Metrology Directorate (FICTIONAL)', 'agency', ?)").run(orgId, t);

  // --- Users (demo accounts: one per role, plus a second super admin so the
  //     maker-checker rule on rule publication can be demonstrated, plus a
  //     different-state user account that proves scope isolation).
  // --- Teams. Two of them, each with its own admin and auditor, so the hierarchy is
  //     visible in the demo rather than theoretical: the Pune admin sees only Pune's
  //     scans, the Bengaluru admin only Bengaluru's, and the super administrator sees
  //     both. A one-team demo would make team scoping look like it does nothing.
  const puneTeamId = 'team_pune';
  const blrTeamId = 'team_blr';
  const mkTeam = (id: string, name: string, description: string) =>
    db.prepare(
      `INSERT INTO teams (id, org_id, name, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    ).run(id, orgId, name, description, t, t);
  mkTeam(puneTeamId, 'Pune Field Team', 'Packaged commodity inspections across Pune district.');
  mkTeam(blrTeamId, 'Bengaluru Field Team', 'Packaged commodity inspections across Bengaluru Urban.');

  const mkUser = (
    email: string, name: string, role: any,
    teamId: string | null, state?: string, district?: string,
  ) => createUser(db, { email, name, password: DEMO_PASSWORD, role, orgId, teamId, state, district });

  const userId = mkUser('user@demo.gov.example', 'Asha Kulkarni (Demo Auditor)', 'user', puneTeamId, 'Maharashtra', 'Pune');
  const adminId = mkUser('admin@demo.gov.example', 'Rohan Mehta (Demo Admin / Pune)', 'admin', puneTeamId, 'Maharashtra');
  // A super administrator sits above the teams, so it is deliberately team-less.
  const superAdminId = mkUser('superadmin@demo.gov.example', 'Priya Nair (Demo Super Administrator)', 'super_admin', null);
  const superAdmin2Id = mkUser('superadmin2@demo.gov.example', 'Vikram Rao (Demo Super Administrator, second approver)', 'super_admin', null);
  mkUser('user.ka@demo.gov.example', 'Kiran Rao (Demo Auditor / Bengaluru)', 'user', blrTeamId, 'Karnataka', 'Bengaluru Urban');
  mkUser('admin.ka@demo.gov.example', 'Meera Iyer (Demo Admin / Bengaluru)', 'admin', blrTeamId, 'Karnataka');

  const ruleAdminId = superAdminId;
  const ruleAdmin2Id = superAdmin2Id;
  const inspector: SessionUser = { id: userId, email: 'user@demo.gov.example', name: 'Asha Kulkarni', role: 'user', orgId, teamId: puneTeamId, state: 'Maharashtra', district: 'Pune', office: null };
  const reviewer: SessionUser = { id: adminId, email: 'admin@demo.gov.example', name: 'Rohan Mehta', role: 'admin', orgId, teamId: puneTeamId, state: 'Maharashtra', district: null, office: null };

  // --- Model registry (mock components clearly labeled)
  const insModel = db.prepare(
    `INSERT INTO model_versions (id, component, name, version, is_mock, status, benchmark_json, deployed_at, created_at)
     VALUES (?, ?, ?, ?, 1, 'deployed', ?, ?, ?)`,
  );
  for (const [component, name] of [
    ['quality', 'mock-quality'], ['layout', 'mock-layout'], ['ocr', 'mock-ocr'],
    ['extraction', 'heuristic-extractor'], ['font', 'mock-font'],
  ] as const) {
    insModel.run(newId('mdl'), component, name, '1.0.0',
      JSON.stringify({ note: 'MOCK provider — no benchmark; not production AI' }), t, t);
  }

  // --- Rule sources (metadata per PRD Appendix B; files/hashes to be attached by legal owner)
  const insSource = db.prepare(
    `INSERT INTO rule_sources (id, title, citation, publisher, publication_date, legal_status, created_at)
     VALUES (?, ?, ?, ?, ?, 'REQUIRES_LEGAL_APPROVAL', ?)`,
  );
  const src = (id: string, title: string, citation: string, date: string) => {
    insSource.run(id, title, citation, 'Department of Consumer Affairs (per PRD reference list)', date, t);
    return id;
  };
  const R1 = src('src_r1', 'Legal Metrology Act, 2009', 'Legal Metrology Act, 2009 [PRD ref R1]', '2009-01-01');
  const R2 = src('src_r2', 'Legal Metrology (Packaged Commodities) Rules, 2011 (consolidated)', 'LMPC Rules, 2011 [PRD ref R2]', '2011-03-31');
  const R3 = src('src_r3', 'LMPC Amendment Rules, 2023', 'LMPC Amendment Rules, 2023 [PRD ref R3]', '2023-01-01');
  const R4 = src('src_r4', 'Medical device packaging amendment, 2025', 'DoCA medical-device amendment 2025 [PRD ref R4]', '2025-01-01');
  const R5 = src('src_r5', 'Pan masala declaration amendment', 'DoCA pan masala amendment, effective 2026-02-01 [PRD ref R5]', '2025-12-01');
  const R6 = src('src_r6', 'LMPC First Amendment Rules, 2026', 'Country-of-origin filter for imported e-commerce products, effective 2026-07-01 [PRD ref R6]', '2026-01-01');
  const R9 = src('src_r9', 'Edible-oil standard pack-size SOP amendment, 2026', 'DoCA edible-oil SOP amendment 2026 [PRD ref R9]', '2026-06-01');
  void R1; void R3;

  // --- Rule sets
  const insSet = db.prepare("INSERT INTO rule_sets (id, name, layer, category_scope_json, created_at) VALUES (?, ?, ?, ?, ?)");
  insSet.run('rs_base', 'General LMPC declarations', 'base_lmpc', '["*"]', t);
  insSet.run('rs_ecom', 'E-commerce channel rules', 'channel', '["*"]', t);
  insSet.run('rs_md', 'Medical devices overlay', 'overlay', '["medical_devices"]', t);
  insSet.run('rs_pm', 'Pan masala overlay', 'overlay', '["pan_masala"]', t);
  insSet.run('rs_eo', 'Edible oils overlay', 'overlay', '["edible_oil"]', t);

  // --- Category routing (REG-12) per PRD baseline examples
  const insRoute = db.prepare(
    `INSERT INTO category_routes (id, category, overlay_rule_set_id, specialist_review, excluded_rule_keys_json, citation, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insRoute.run(newId('cr'), 'medical_devices', 'rs_md', 1,
    JSON.stringify(['lmpc.font_size.rule7', 'lmpc.pdp_placement']),
    'PRD ref R4 (Medical Devices Rules, 2017 govern location/font dimensions)',
    'Do not apply ordinary location/font logic; specialist overlay review required.', t);
  insRoute.run(newId('cr'), 'pan_masala', 'rs_pm', 0, '[]', 'PRD ref R5', 'No small-pack bypass from 2026-02-01.', t);
  insRoute.run(newId('cr'), 'edible_oil', 'rs_eo', 0, '[]', 'PRD ref R9', 'Standard pack-size SOP overlay with transition.', t);

  // --- Rule versions (published; author/approver are distinct rule admins)
  const insRV = db.prepare(
    `INSERT INTO rule_versions (id, rule_set_id, rule_key, version, title, status, source_id, citation,
       jurisdiction, effective_from, effective_to, applicability_json, inputs_json, logic_json, outcome_json,
       legal_status, author_id, approver_id, approved_at, published_at, change_note, created_at)
     VALUES (?, ?, ?, ?, ?, 'published', ?, ?, 'IN', ?, ?, ?, ?, ?, ?, 'REQUIRES_LEGAL_APPROVAL', ?, ?, ?, ?, ?, ?)`,
  );
  const rv = (
    setId: string, ruleKey: string, version: number, title: string, sourceId: string, citation: string,
    effFrom: string, effTo: string | null, applicability: unknown, inputs: unknown, logic: unknown, outcome: unknown,
    note = 'seeded baseline',
  ) => {
    const id = newId('rv');
    insRV.run(id, setId, ruleKey, version, title, sourceId, citation, effFrom, effTo,
      JSON.stringify(applicability), JSON.stringify(inputs), JSON.stringify(logic), JSON.stringify(outcome),
      ruleAdminId, ruleAdmin2Id, t, t, note, t);
    return id;
  };
  const anyApp = { categories: ['*'], channels: ['*'], importStatus: ['*'] };
  const sev = (severityOnFail: string, remediation: string, reportWording?: string) =>
    ({ severityOnFail, remediation, reportWording });

  rv('rs_base', 'lmpc.responsible_entity', 1, 'Responsible entity name and address declared', R2,
    'LMPC Rules, 2011 — responsible-entity declaration family [R2]', '2011-04-01', null, anyApp,
    { declTypes: ['responsible_entity'] },
    { checks: [{ type: 'presence', declType: 'responsible_entity' }, { type: 'format', declType: 'responsible_entity', expect: 'entity' }] },
    sev('high', 'Declare the name and complete address of the manufacturer/packer/importer as applicable.'));

  rv('rs_base', 'lmpc.product_name', 1, 'Common or generic product name declared', R2,
    'LMPC Rules, 2011 — product identity declaration family [R2]', '2011-04-01', null, anyApp,
    { declTypes: ['product_name'] },
    { checks: [{ type: 'presence', declType: 'product_name' }] },
    sev('medium', 'Declare the common or generic name of the commodity.'));

  rv('rs_base', 'lmpc.net_quantity', 1, 'Net quantity declared with permitted unit', R2,
    'LMPC Rules, 2011 — net quantity declaration family [R2]', '2011-04-01', null, anyApp,
    { declTypes: ['net_quantity'] },
    { checks: [
      { type: 'presence', declType: 'net_quantity' },
      { type: 'format', declType: 'net_quantity', expect: 'value_unit', allowedUnits: ['g', 'kg', 'mg', 'ml', 'l', 'N', 'm', 'cm'] },
      { type: 'conflict', declType: 'net_quantity' },
    ] },
    sev('high', 'Declare net quantity using a permitted unit; remove conflicting values.'));

  rv('rs_base', 'lmpc.mrp', 1, 'Retail sale price declared in Indian currency with required wording', R2,
    'LMPC Rules, 2011 — retail sale price declaration family [R2]', '2011-04-01', null, anyApp,
    { declTypes: ['mrp'] },
    { checks: [
      { type: 'presence', declType: 'mrp' },
      { type: 'format', declType: 'mrp', expect: 'currency_inr', requirePhrase: 'inclusive of all taxes' },
    ] },
    sev('high', 'Declare the retail sale price in Indian currency with the required tax-inclusive wording.'));

  rv('rs_base', 'lmpc.dates', 1, 'Manufacture/packing date declared with consistent chronology', R2,
    'LMPC Rules, 2011 — month and year declaration family [R2]', '2011-04-01', null, anyApp,
    { declTypes: ['mfg_date', 'import_date', 'best_before'] },
    { checks: [
      // PRD declaration catalogue: "Manufacture, packing or import date".
      { type: 'presence_any', declTypes: ['mfg_date', 'import_date'] },
      { type: 'chronology', earlier: 'mfg_date', later: 'best_before' },
    ] },
    sev('medium', 'Declare the month and year of manufacture/packing/import; ensure date chronology is possible.'));

  rv('rs_base', 'lmpc.consumer_care', 1, 'Consumer-care details declared', R2,
    'LMPC Rules, 2011 — consumer care declaration family [R2]', '2011-04-01', null, anyApp,
    { declTypes: ['consumer_care'] },
    { checks: [
      { type: 'presence', declType: 'consumer_care' },
      { type: 'format', declType: 'consumer_care', expect: 'contact' },
    ] },
    // Severity values are demo policy config, adjustable by the agency (REV-05).
    sev('high', 'Declare consumer-care name/address and telephone or e-mail.'));

  rv('rs_base', 'lmpc.country_of_origin', 1, 'Country of origin declared for imported products', R2,
    'LMPC Rules, 2011 — country of origin declaration family [R2]', '2011-04-01', null,
    { categories: ['*'], channels: ['*'], importStatus: ['imported'] },
    { declTypes: ['country_of_origin'] },
    { checks: [
      { type: 'cross_field', kind: 'origin_required_if_imported' },
      { type: 'format', declType: 'country_of_origin', expect: 'country' },
    ] },
    sev('high', 'Declare the country of origin/manufacture for the imported product.'));

  rv('rs_base', 'lmpc.font_size.rule7', 1,
    'Rule 7 character height (DEMO thresholds — REQUIRES LEGAL APPROVAL)', R2,
    'LMPC Rules, 2011, Rule 7 table — thresholds are DEMO placeholders pending legal certification [R2]',
    '2011-04-01', null, anyApp,
    { declTypes: ['net_quantity'], requiresCalibration: true },
    { checks: [{
      type: 'calibrated_font_size', declType: 'net_quantity',
      // DEMO placeholder values — NOT the statutory Rule 7 table. Structure only.
      thresholdTable: [
        { presentationMode: 'printed', minHeightMm: 2 },
        { presentationMode: 'molded_embossed_perforated', minHeightMm: 4 },
        { presentationMode: '*', minHeightMm: 2 },
      ],
    }] },
    sev('medium', 'Increase declaration character height to the applicable Rule 7 minimum.'),
    'DEMO threshold values pending certified Rule 7 table');

  rv('rs_base', 'lmpc.pdp_placement', 1, 'Declarations appear on/with the principal display panel', R2,
    'LMPC Rules, 2011 — presentation and placement provisions [R2]', '2011-04-01', null, anyApp,
    { declTypes: ['net_quantity'], requiresGeometry: true },
    { checks: [{ type: 'placement', declType: 'net_quantity', requires: 'pdp' }] },
    sev('medium', 'Place the declaration on or grouped with the principal display panel.'));

  rv('rs_ecom', 'ecom.listing_declarations', 1, 'Required declarations visible on the e-commerce listing', R3,
    'LMPC Amendment Rules, 2023 — e-commerce declaration duties [R3]', '2023-01-01', null,
    { categories: ['*'], channels: ['ecommerce'], importStatus: ['*'] },
    { declTypes: ['mrp', 'net_quantity', 'responsible_entity'] },
    { checks: [
      { type: 'presence', declType: 'mrp', channel: 'listing' },
      { type: 'presence', declType: 'net_quantity', channel: 'listing' },
      { type: 'presence', declType: 'responsible_entity', channel: 'listing' },
    ] },
    sev('high', 'Display the required declarations on the product listing.'));

  rv('rs_ecom', 'ecom.origin_filter', 1,
    'Country-of-origin visibility for imported products on e-commerce (effective 2026-07-01)', R6,
    'LMPC First Amendment Rules, 2026 — searchable/sortable country-of-origin duties from 2026-07-01 [R6]',
    '2026-07-01', null,
    { categories: ['*'], channels: ['ecommerce'], importStatus: ['imported'] },
    { declTypes: ['country_of_origin'] },
    { checks: [
      { type: 'presence', declType: 'country_of_origin', channel: 'listing' },
      { type: 'always', outcome: 'needs_review', reasonCode: 'MANUAL_FILTER_TEST',
        explanation: 'Record the searchable/sortable country-of-origin filter test manually (query, selected value, observed behavior, screenshot) — automated marketplace-experience testing is not enabled.' },
    ] },
    sev('high', 'Ensure the listing displays country of origin and the marketplace provides the required filter experience.'));

  rv('rs_ecom', 'ecom.listing_consistency', 1, 'Online listing consistent with the physical package', R3,
    'LMPC Rules — consistency of declared information across channels [R2/R3]', '2023-01-01', null,
    { categories: ['*'], channels: ['*'] },
    { declTypes: ['mrp', 'net_quantity', 'country_of_origin'] },
    { checks: [{ type: 'listing_comparison', declTypes: ['mrp', 'net_quantity', 'country_of_origin'] }] },
    sev('medium', 'Align the listing with the physical package declarations.'));

  rv('rs_md', 'md.specialist_review', 1, 'Medical device package — specialist overlay review', R4,
    'DoCA 2025 amendment: declaration location and font dimensions governed by Medical Devices Rules, 2017 [R4]',
    '2025-01-01', null,
    { categories: ['medical_devices'], channels: ['*'] }, {},
    { checks: [{ type: 'always', outcome: 'needs_review', reasonCode: 'SPECIALIST_OVERLAY',
      explanation: 'Medical-device packaging is routed to specialist review: location and font dimensions follow the Medical Devices Rules, 2017; ordinary LMPC location/font logic is not applied.' }] },
    sev('medium', 'Route to the medical-devices specialist reviewer.'));

  rv('rs_pm', 'pm.rsp_required', 1, 'Pan masala: retail sale price and mandatory declarations on all pack sizes', R5,
    'DoCA pan masala amendment — mandatory declarations incl. small packs, effective 2026-02-01 [R5]',
    '2026-02-01', null,
    { categories: ['pan_masala'], channels: ['*'] },
    { declTypes: ['mrp'] },
    { checks: [{ type: 'presence', declType: 'mrp' }] },
    sev('high', 'Declare retail sale price and mandatory declarations on every pack size; no small-pack exemption.'));

  rv('rs_eo', 'eo.pack_size_review', 1, 'Edible oil: standard pack-size and dual volume/weight review', R9,
    'DoCA edible-oil SOP amendment 2026 — standard pack sizes and equivalent weight, with transition [R9]',
    '2026-06-01', null,
    { categories: ['edible_oil'], channels: ['*'] }, {},
    { checks: [{ type: 'always', outcome: 'needs_review', reasonCode: 'PACK_SIZE_TABLE_REVIEW',
      explanation: 'Edible-oil overlay: verify pack size against the SOP standard pack-size table and equivalent-weight declaration; certified table pending legal approval.' }] },
    sev('medium', 'Verify pack size and dual volume/weight declaration against the SOP table.'));

  // --- Rule test packs (executable fixtures; used by publish gate + regression)
  const insTest = db.prepare(
    'INSERT INTO rule_tests (id, rule_key, name, fixture_json, expected_outcome, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const baseCtx = (over: Record<string, unknown> = {}) => JSON.stringify({
    eventDate: '2026-08-01', inspectionType: 'physical_retail', jurisdiction: 'IN',
    product: { category: 'packaged_food', packageType: 'retail', importStatus: 'domestic', presentationMode: 'printed' },
    declarations: [], coverage: { complete: true, missing: [] },
    calibrations: [], fontMeasurements: [], pdpAssets: [], frontAssets: [], ...over,
  });
  const decl = (declType: string, verbatim: string, normalized: unknown, extra: Record<string, unknown> = {}) => ({
    id: `fix_${declType}`, declType, verbatimText: verbatim, normalized,
    confidence: 0.95, needsReview: false, reviewReasons: [], sourceChannel: 'physical',
    presentationMode: 'printed', evidenceRegions: [{ assetId: 'fix_asset', bbox: { x: 0, y: 0, w: 0.5, h: 0.05 } }], ...extra,
  });
  const qty = decl('net_quantity', 'Net Quantity: 500 g', { value: { quantity: 500, baseQuantity: 500, baseUnit: 'g' }, unit: 'g', ambiguous: false });

  insTest.run(newId('rt'), 'lmpc.mrp', 'MRP present with phrase → passed',
    baseCtx({ declarations: [decl('mrp', 'MRP ₹ 99.00 (Inclusive of all taxes)', { value: { amount: 99, currency: 'INR', taxInclusivePhrasePresent: true }, ambiguous: false })] }),
    'passed', t);
  insTest.run(newId('rt'), 'lmpc.mrp', 'MRP missing with full coverage → failed', baseCtx(), 'failed', t);
  insTest.run(newId('rt'), 'lmpc.mrp', 'MRP missing with incomplete coverage → not_assessable',
    baseCtx({ coverage: { complete: false, missing: ['back'] } }), 'not_assessable', t);
  insTest.run(newId('rt'), 'lmpc.mrp', 'MRP without required phrase → failed',
    baseCtx({ declarations: [decl('mrp', '₹ 99.00', { value: { amount: 99, currency: 'INR', taxInclusivePhrasePresent: false }, ambiguous: false })] }),
    'failed', t);

  insTest.run(newId('rt'), 'lmpc.net_quantity', 'Quantity with permitted unit → passed', baseCtx({ declarations: [qty] }), 'passed', t);
  insTest.run(newId('rt'), 'lmpc.net_quantity', 'Quantity missing → failed', baseCtx(), 'failed', t);

  const mfg = decl('mfg_date', 'Date of Manufacture: 03/2026', { value: { year: 2026, month: 3, iso: '2026-03' }, ambiguous: false });
  const impDate = decl('import_date', 'Date of Import: 04/2026', { value: { year: 2026, month: 4, iso: '2026-04' }, ambiguous: false });
  const bestBefore = decl('best_before', 'Best Before: 12 months from manufacture', { value: { relativeMonths: 12 }, ambiguous: false });
  insTest.run(newId('rt'), 'lmpc.dates', 'Manufacture date + relative best-before → passed',
    baseCtx({ declarations: [mfg, bestBefore] }), 'passed', t);
  insTest.run(newId('rt'), 'lmpc.dates', 'Import date alone satisfies the date family (chronology not assessable)',
    baseCtx({ declarations: [impDate] }), 'not_assessable', t);
  insTest.run(newId('rt'), 'lmpc.dates', 'No date declaration with complete coverage → failed', baseCtx(), 'failed', t);

  // CRITICAL TEST PAIR (UAT-03 / UAT-04): same declaration, with vs without calibration.
  insTest.run(newId('rt'), 'lmpc.font_size.rule7', 'Case A: calibrated, below threshold → failed',
    baseCtx({ declarations: [qty], calibrations: [{ assetId: 'fix_asset', mmPerPx: 0.02, uncertaintyPct: 5, method: 'marker' }],
      fontMeasurements: [{ declType: 'net_quantity', charHeightPx: 50, sampleChars: '500 g' }] }), // 1.0 mm < 2 mm demo threshold
    'failed', t);
  insTest.run(newId('rt'), 'lmpc.font_size.rule7', 'Case A2: calibrated, above threshold → passed',
    baseCtx({ declarations: [qty], calibrations: [{ assetId: 'fix_asset', mmPerPx: 0.06, uncertaintyPct: 5, method: 'marker' }],
      fontMeasurements: [{ declType: 'net_quantity', charHeightPx: 50, sampleChars: '500 g' }] }), // 3.0 mm >= 2 mm
    'passed', t);
  insTest.run(newId('rt'), 'lmpc.font_size.rule7', 'Case B: NO calibration → MUST be not_assessable',
    baseCtx({ declarations: [qty], calibrations: [],
      fontMeasurements: [{ declType: 'net_quantity', charHeightPx: 50, sampleChars: '500 g' }] }),
    'not_assessable', t);

  insTest.run(newId('rt'), 'lmpc.country_of_origin', 'Imported without origin → failed',
    baseCtx({ product: { category: 'packaged_food', packageType: 'retail', importStatus: 'imported', presentationMode: 'printed' } }),
    'failed', t);
  insTest.run(newId('rt'), 'lmpc.country_of_origin', 'Domestic product → not_applicable',
    baseCtx(), 'not_applicable', t);
  insTest.run(newId('rt'), 'pm.rsp_required', 'Pan masala small pack without MRP → failed',
    baseCtx({ product: { category: 'pan_masala', packageType: 'retail', importStatus: 'domestic', presentationMode: 'printed' } }),
    'failed', t);
  insTest.run(newId('rt'), 'md.specialist_review', 'Medical device → needs_review',
    baseCtx({ product: { category: 'medical_devices', packageType: 'retail', importStatus: 'domestic', presentationMode: 'printed' } }),
    'needs_review', t);

  // --- Config
  db.prepare("INSERT INTO config_items (key, value_json, version, updated_at) VALUES ('finalization_policy', ?, 1, ?)")
    .run(JSON.stringify({ userCanFinalize: true, secondApprovalSeverities: ['high'] }), t);

  logger.info('seed: users, rules and tests created');
}

// Demo inspections exercised through the REAL service flow (not fabricated rows).
export async function seedDemoInspections(db: DB) {
  const already = (db.prepare('SELECT COUNT(*) AS c FROM inspections').get() as any).c;
  if (already > 0) return;
  registerPipelineHandlers();
  const u = (email: string): SessionUser => {
    const r = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
    return { id: r.id, email: r.email, name: r.name, role: r.role, orgId: r.org_id, teamId: r.team_id ?? null, state: r.state, district: r.district, office: r.office };
  };
  const inspector = u('user@demo.gov.example');
  const reviewer = u('admin@demo.gov.example');

  // 1) Complete physical inspection → processed → evaluated → dispositioned → finalized.
  const i1 = createInspection(db, inspector, {
    type: 'physical_retail', location: 'Demo Bazaar, FC Road, Pune (FICTIONAL)',
    sellerName: 'Demo Retail Mart (FICTIONAL)', eventDate: '2026-08-10',
    product: { brand: 'Demo Brand', genericName: 'Instant Noodles', category: 'packaged_food', gtin: '8901234567890', packSize: '500 g' },
  });
  const front1 = await ingestFileEvidence(db, inspector, i1.id,
    { buffer: labelImage('noodles-front.png'), originalname: 'noodles-front.png', mimetype: 'image/png' },
    { faceLabel: 'front', source: 'camera' });
  await ingestFileEvidence(db, inspector, i1.id,
    { buffer: labelImage('noodles-back.png'), originalname: 'noodles-back.png', mimetype: 'image/png' },
    { faceLabel: 'back', source: 'camera' });
  // Known-dimension calibration: the synthetic label is 1100 px wide and
  // represents a 120 mm package face → ≈0.11 mm/px.
  addCalibration(db, inspector, front1, {
    method: 'known_dimension', mmPerPx: 0.11, uncertaintyPct: 4,
    notes: 'Demo: package face width measured at 120 mm across 1100 px',
  });
  await runPipeline(db, i1.id);
  await runEvaluation(db, inspector, i1.id);
  for (const f of listFindings(db, i1.id)) {
    if (['failed', 'needs_review', 'not_assessable'].includes(f.effectiveOutcome)) {
      disposeFinding(db, reviewer, f.id, { action: 'confirm', reason: 'Demo seed: reviewed and confirmed system result' });
    }
  }
  finalizeInspection(db, reviewer, i1.id);

  // 2) Open inspection with a non-compliant demo label (missing consumer care), no calibration.
  const i2 = createInspection(db, inspector, {
    type: 'physical_retail', location: 'Demo Super Store, Aundh, Pune (FICTIONAL)',
    sellerName: 'Demo Super Store (FICTIONAL)', eventDate: '2026-08-25',
    product: { brand: 'Sample Snacks', genericName: 'Potato Chips', category: 'packaged_food', gtin: '8909999912345', packSize: '90 g' },
  });
  await ingestFileEvidence(db, inspector, i2.id,
    { buffer: labelImage('chips-front.png'), originalname: 'chips-front.png', mimetype: 'image/png' },
    { faceLabel: 'front', source: 'camera' });
  await ingestFileEvidence(db, inspector, i2.id,
    { buffer: labelImage('chips-back.png'), originalname: 'chips-back.png', mimetype: 'image/png' },
    { faceLabel: 'back', source: 'camera' });
  await runPipeline(db, i2.id);
  await runEvaluation(db, inspector, i2.id);

  // 3) E-commerce imported product with structured listing evidence.
  const i3 = createInspection(db, inspector, {
    type: 'ecommerce', location: 'Online — Demo Marketplace (FICTIONAL)', eventDate: '2026-08-20',
    product: { brand: 'Importo', genericName: 'Chocolate Wafers', category: 'packaged_food', importStatus: 'imported', packSize: '150 g' },
  });
  ingestUrlEvidence(db, inspector, i3.id, {
    url: 'https://demo-marketplace.example/product/importo-wafers',
    marketplace: 'Demo Marketplace (FICTIONAL)', seller: 'Demo Seller 42 (FICTIONAL)',
    structured: {
      listing_title: 'Importo Chocolate Wafers 150 g',
      // Demo scenario: the listing price contradicts the physical pack (Rs. 249)
      // and the listing omits country of origin for an imported product.
      mrp: 'MRP Rs. 279.00 (Inclusive of all taxes)',
      net_quantity: 'Net Quantity: 150 g',
      seller_panel: 'Sold by Demo Seller 42',
    },
  });
  // Physical pack images for the same SKU, so online-vs-physical comparison runs.
  await ingestFileEvidence(db, inspector, i3.id,
    { buffer: labelImage('wafers-front.png'), originalname: 'wafers-front.png', mimetype: 'image/png' },
    { faceLabel: 'front', source: 'camera' });
  await ingestFileEvidence(db, inspector, i3.id,
    { buffer: labelImage('wafers-back.png'), originalname: 'wafers-back.png', mimetype: 'image/png' },
    { faceLabel: 'back', source: 'camera' });
  await runPipeline(db, i3.id);
  await runEvaluation(db, inspector, i3.id);

  logger.info('seed: demo inspections created', { finalized: i1.id, open: i2.id, ecommerce: i3.id });
}

async function runPipeline(db: DB, inspectionId: string) {
  const assets = db.prepare(
    'SELECT id, sha256 FROM evidence_assets WHERE inspection_id = ?',
  ).all(inspectionId) as any[];
  for (const a of assets) {
    enqueueJob(db, { type: 'process_evidence', targetId: a.id, idempotencyKey: `seed:pe:${a.id}` });
  }
  enqueueJob(db, { type: 'extract_declarations', targetId: inspectionId, idempotencyKey: `seed:ex:${inspectionId}` });
  await drainJobs(db);
}

// CLI entry: npm run seed
const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('db/seed.ts');
if (isMain) {
  const db = getDb();
  seedIfEmpty(db);
  seedDemoInspections(db).then(() => {
    logger.info('seed complete');
    process.exit(0);
  }).catch((e) => { logger.error('seed failed', { error: String(e?.stack ?? e) }); process.exit(1); });
}
