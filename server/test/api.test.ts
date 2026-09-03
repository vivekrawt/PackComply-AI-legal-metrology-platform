import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, setDb, getDb } from '../src/db/index.js';
import { seed } from '../src/db/seed.js';
import { createApp } from '../src/app.js';
import { registerPipelineHandlers } from '../src/modules/processing/pipeline.js';
import { drainJobs } from '../src/modules/processing/queue.js';
import { sha256Hex } from '../src/core/crypto.js';
import { config } from '../src/core/config.js';

const PNG_BASE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
function pngVariant(variant: number, salt: string): Buffer {
  for (let i = 0; i < 4096; i++) {
    const buf = Buffer.concat([PNG_BASE, Buffer.from(`${salt}:${i}`)]);
    if (parseInt(sha256Hex(buf).slice(0, 6), 16) % 4 === variant) return buf;
  }
  return PNG_BASE;
}

let app: ReturnType<typeof createApp>;
const agents: Record<string, request.Agent> = {};
const H = { 'X-Requested-With': 'packcomply' };

// Shared across suites: the vertical-slice case and its finalized report are reused by
// the role and deletion suites, which act on an already-signed record.
let inspectionId: string;
let reportId: string;

async function loginAgent(email: string, password = 'PackComply#2026') {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/login').set(H).send({ email, password });
  expect(res.status).toBe(200);
  return agent;
}

beforeAll(async () => {
  const db = openDb(process.env.PACKCOMPLY_DB_PATH!);
  setDb(db);
  seed(db);
  registerPipelineHandlers();
  app = createApp();
  agents.user = await loginAgent('user@demo.gov.example');
  agents.admin = await loginAgent('admin@demo.gov.example');
  agents.ka = await loginAgent('user.ka@demo.gov.example');
  agents.superadmin = await loginAgent('superadmin@demo.gov.example');
  agents.superadmin2 = await loginAgent('superadmin2@demo.gov.example');
});

describe('authentication (IAM-01/05/07)', () => {
  it('rejects wrong password and audits the failure', async () => {
    const res = await request(app).post('/api/v1/auth/login').set(H)
      .send({ email: 'user@demo.gov.example', password: 'wrong-password' });
    expect(res.status).toBe(401);
    const audit = getDb().prepare(
      "SELECT * FROM audit_events WHERE action = 'auth.login' AND outcome = 'denied' ORDER BY seq DESC LIMIT 1",
    ).get() as any;
    expect(audit).toBeTruthy();
  });

  it('rejects mutations without the CSRF header', async () => {
    const res = await agents.user.post('/api/v1/inspections').send({ type: 'physical_retail' });
    expect(res.status).toBe(403);
  });
});

describe('UAT-01/02/08/12 — complete vertical slice', () => {

  it('creates an inspection with product context (INS-01/07)', async () => {
    const res = await agents.user.post('/api/v1/inspections').set(H).send({
      type: 'physical_retail', eventDate: '2026-08-15', location: 'Test Store, Pune',
      sellerName: 'Test Seller', product: {
        brand: 'TestBrand', genericName: 'Biscuits', category: 'packaged_food',
        gtin: '8901111111111', packSize: '500 g',
      },
    });
    expect(res.status).toBe(201);
    inspectionId = res.body.id;
    expect(res.body.checklist.required).toContain('front');
  });

  it('uploads immutable evidence with hashes (VIS-01, INS-03)', async () => {
    // Variant 1 = demo label missing consumer care → expect a failed finding.
    for (const face of ['front', 'back']) {
      const res = await agents.user.post(`/api/v1/inspections/${inspectionId}/evidence`).set(H)
        .field('faceLabel', face)
        .attach('files', pngVariant(1, `t1-${face}`), { filename: `${face}.png`, contentType: 'image/png' });
      expect(res.status).toBe(201);
    }
    const detail = await agents.user.get(`/api/v1/inspections/${inspectionId}`);
    expect(detail.body.assets).toHaveLength(2);
    expect(detail.body.assets[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.body.coverage.complete).toBe(true);
  });

  it('rejects disallowed file content (magic-byte validation)', async () => {
    const res = await agents.user.post(`/api/v1/inspections/${inspectionId}/evidence`).set(H)
      .field('faceLabel', 'side')
      .attach('files', Buffer.from('#!/bin/sh evil'), { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(422);
  });

  it('runs the async pipeline (quality → OCR → extraction) idempotently', async () => {
    const res = await agents.user.post(`/api/v1/inspections/${inspectionId}/process`).set(H).send();
    expect(res.status).toBe(202);
    await drainJobs(getDb());
    // Re-submit: must deduplicate, not duplicate results (NFR-RELIAB-01).
    await agents.user.post(`/api/v1/inspections/${inspectionId}/process`).set(H).send();
    await drainJobs(getDb());
    const decls = await agents.user.get(`/api/v1/inspections/${inspectionId}/declarations`);
    expect(decls.body.declarations.length).toBeGreaterThan(3);
    const types = decls.body.declarations.map((d: any) => d.declType);
    expect(new Set(types).size).toBe(types.length); // no duplicates
    expect(types).toContain('mrp');
    expect(types).not.toContain('consumer_care'); // variant 1 omits it
  });

  it('officer corrects a declaration with reason (EXT-06, UAT-08)', async () => {
    const decls = await agents.user.get(`/api/v1/inspections/${inspectionId}/declarations`);
    const mrp = decls.body.declarations.find((d: any) => d.declType === 'mrp');
    const res = await agents.user.post(`/api/v1/declarations/${mrp.id}/correct`).set(H)
      .send({ field: 'verbatim_text', newValue: 'MRP ₹ 105.00 (Inclusive of all taxes)', reason: 'Officer read the label directly' });
    expect(res.status).toBe(200);
    expect(res.body.normalized.value.amount).toBe(105);
    const hist = await agents.user.get(`/api/v1/declarations/${mrp.id}/corrections`);
    expect(hist.body.corrections).toHaveLength(1);
    expect(hist.body.corrections[0].reason).toContain('Officer');
  });

  it('evaluates versioned rules — missing consumer care fails with citation (UAT-02)', async () => {
    const res = await agents.user.post(`/api/v1/inspections/${inspectionId}/evaluate`).set(H).send();
    expect(res.status).toBe(200);
    expect(res.body.engineVersion).toBe('engine-1.0.0');
    const care = res.body.results.find((r: any) => r.ruleKey === 'lmpc.consumer_care');
    expect(care.outcome).toBe('failed');
    expect(care.citation).toContain('LMPC');
    // No calibration → font rule is Not Assessable (UAT-04 within the flow).
    const font = res.body.results.find((r: any) => r.ruleKey === 'lmpc.font_size.rule7');
    expect(font.outcome).toBe('not_assessable');
  });

  it('blocks finalization while material findings are unreviewed (review safety)', async () => {
    const res = await agents.user.post(`/api/v1/inspections/${inspectionId}/finalize`).set(H).send();
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toContain('not been reviewed');
  });

  it('high-severity override requires second-level approval by a DIFFERENT officer (REV-03)', async () => {
    const findings = await agents.user.get(`/api/v1/inspections/${inspectionId}/findings`);
    const care = findings.body.findings.find((f: any) => f.ruleKey === 'lmpc.consumer_care');
    const disp = await agents.user.post(`/api/v1/findings/${care.id}/disposition`).set(H)
      .send({ action: 'override', toOutcome: 'passed', reason: 'Care details verified on secondary sticker' });
    expect(disp.body.requiresApproval).toBe(true);
    // Same officer cannot approve — and the `user` role lacks the permission entirely.
    const self = await agents.user.post(`/api/v1/dispositions/${disp.body.dispositionId}/approve`).set(H).send();
    expect(self.status).toBe(403);
    const ok = await agents.admin.post(`/api/v1/dispositions/${disp.body.dispositionId}/approve`).set(H).send();
    expect(ok.status).toBe(200);
  });

  it('finalizes after all material findings are dispositioned', async () => {
    const findings = await agents.admin.get(`/api/v1/inspections/${inspectionId}/findings`);
    for (const f of findings.body.findings) {
      if (['failed', 'needs_review', 'not_assessable'].includes(f.effectiveOutcome) && f.status === 'open') {
        await agents.admin.post(`/api/v1/findings/${f.id}/disposition`).set(H)
          .send({ action: 'confirm', reason: 'Reviewed and confirmed' }).expect(200);
      }
    }
    const res = await agents.admin.post(`/api/v1/inspections/${inspectionId}/finalize`).set(H).send();
    expect(res.status).toBe(200);
    reportId = res.body.reportId;
    expect(res.body.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('finalized records are immutable (REV-08)', async () => {
    const patch = await agents.user.patch(`/api/v1/inspections/${inspectionId}`).set(H).send({ location: 'changed' });
    expect(patch.status).toBe(409);
    const findings = await agents.admin.get(`/api/v1/inspections/${inspectionId}/findings`);
    const anyF = findings.body.findings[0];
    const disp = await agents.admin.post(`/api/v1/findings/${anyF.id}/disposition`).set(H)
      .send({ action: 'dismiss', reason: 'attempt after finalization' });
    expect(disp.status).toBe(409);
  });

  it('report verifies, exports and pins versions (RPT-02/04, UAT-12)', async () => {
    const verify = await agents.admin.get(`/api/v1/reports/${reportId}/verify`);
    expect(verify.body.valid).toBe(true);
    const json = await agents.admin.get(`/api/v1/reports/${reportId}/export/json`);
    expect(json.status).toBe(200);
    const snapshot = (Buffer.isBuffer(json.body) ? JSON.parse(json.body.toString()) : json.body).snapshot;
    expect(snapshot.appliedLegalContext.ruleVersions.length).toBeGreaterThan(3);
    expect(snapshot.appliedLegalContext.modelVersions.ocr).toBe('mock-ocr-1.0.0');
    expect(snapshot.appliedLegalContext.usesMockProviders).toBe(true);
    const binary = (res: any, cb: any) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    };
    const pdf = await agents.admin.get(`/api/v1/reports/${reportId}/export/pdf`).buffer(true).parse(binary);
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    const docx = await agents.admin.get(`/api/v1/reports/${reportId}/export/docx`).buffer(true).parse(binary);
    expect(docx.status).toBe(200);
    expect((docx.body as Buffer).subarray(0, 2).toString()).toBe('PK'); // zip container
  });

  it('amendment creates a new version and retains the prior one', async () => {
    const res = await agents.admin.post(`/api/v1/reports/${reportId}/amend`).set(H)
      .send({ reason: 'Clerical amendment for test' });
    expect(res.body.version).toBe(2);
    const v1 = await agents.admin.get(`/api/v1/reports/${reportId}/verify?version=1`);
    expect(v1.body.valid).toBe(true);
  });

  it('repository search finds the finalized inspection (REP-02)', async () => {
    const res = await agents.user.get('/api/v1/search?q=TestBrand');
    expect(res.body.results.some((r: any) => r.inspectionId === inspectionId)).toBe(true);
  });

  it('detects evidence tampering on read (UAT-12)', async () => {
    const detail = await agents.user.get(`/api/v1/inspections/${inspectionId}`);
    const asset = detail.body.assets[0];
    const file = path.join(config.evidenceDir, asset.sha256.slice(0, 2), asset.sha256);
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.concat([original, Buffer.from('tamper')]));
    const res = await agents.user.get(`/api/v1/assets/${asset.id}/content`);
    expect(res.status).toBe(409);
    fs.writeFileSync(file, original); // restore
    await agents.user.get(`/api/v1/assets/${asset.id}/content`).expect(200);
  });

  it('audit chain verifies end-to-end (IAM-07)', async () => {
    const res = await agents.admin.get('/api/v1/audit/verify');
    expect(res.body.ok).toBe(true);
  });

  it('UAT-10: out-of-scope user cannot read, search or export the record', async () => {
    const direct = await agents.ka.get(`/api/v1/inspections/${inspectionId}`);
    expect(direct.status).toBe(403);
    const search = await agents.ka.get('/api/v1/search?q=TestBrand');
    expect(search.body.results).toHaveLength(0);
    const report = await agents.ka.get(`/api/v1/reports/${reportId}/export/json`);
    expect(report.status).toBe(403);
  });
});

describe('UAT-05 — historical rule replay (effective dates)', () => {
  async function evaluatePanMasala(eventDate: string) {
    const created = await agents.user.post('/api/v1/inspections').set(H).send({
      type: 'physical_retail', eventDate, location: 'Replay test',
      product: { brand: 'PM Brand', genericName: 'Pan Masala Sachet', category: 'pan_masala', packSize: '5 g' },
    });
    const res = await agents.user.post(`/api/v1/inspections/${created.body.id}/evaluate`).set(H).send();
    return res.body.results.map((r: any) => r.ruleKey);
  }

  it('pan masala rule applies only on/after its 2026-02-01 effective date', async () => {
    const before = await evaluatePanMasala('2026-01-15');
    const after = await evaluatePanMasala('2026-03-01');
    expect(before).not.toContain('pm.rsp_required');
    expect(after).toContain('pm.rsp_required');
  });
});

describe('UAT-07 — special category routing (REG-12)', () => {
  it('medical devices route to specialist overlay and displace font/placement rules', async () => {
    const created = await agents.user.post('/api/v1/inspections').set(H).send({
      type: 'physical_retail', eventDate: '2026-08-01',
      product: { brand: 'MedCo', genericName: 'Digital Thermometer', category: 'medical_devices' },
    });
    const res = await agents.user.post(`/api/v1/inspections/${created.body.id}/evaluate`).set(H).send();
    const keys = res.body.results.map((r: any) => r.ruleKey);
    expect(keys).toContain('md.specialist_review');
    expect(keys).not.toContain('lmpc.font_size.rule7');
    expect(keys).not.toContain('lmpc.pdp_placement');
    expect(res.body.exclusions.map((e: any) => e.ruleKey)).toContain('lmpc.font_size.rule7');
    const md = res.body.results.find((r: any) => r.ruleKey === 'md.specialist_review');
    expect(md.outcome).toBe('needs_review');
  });
});

describe('rule governance (ADM-01, IAM-06)', () => {
  let draftId: string;

  it('rule admin drafts a version (marked REQUIRES LEGAL APPROVAL by default)', async () => {
    const sets = await agents.superadmin.get('/api/v1/rules/sets');
    const base = sets.body.ruleSets.find((s: any) => s.id === 'rs_base');
    const res = await agents.superadmin.post('/api/v1/rules/versions').set(H).send({
      ruleSetId: base.id, ruleKey: 'lmpc.test_governance', title: 'Governance test rule',
      citation: 'Test citation', effectiveFrom: '2026-09-01',
      applicability: { categories: ['*'], channels: ['*'] }, inputs: {},
      logic: { checks: [{ type: 'presence', declType: 'mrp' }] },
      outcome: { severityOnFail: 'low' },
    });
    expect(res.status).toBe(201);
    expect(res.body.legalStatus).toBe('REQUIRES_LEGAL_APPROVAL');
    draftId = res.body.id;
  });

  it('inspector cannot draft rules; author cannot approve their own version', async () => {
    const forb = await agents.user.post('/api/v1/rules/versions').set(H).send({});
    expect(forb.status).toBe(403);
    await agents.superadmin.post(`/api/v1/rules/versions/${draftId}/submit`).set(H).send().expect(200);
    const selfApprove = await agents.superadmin.post(`/api/v1/rules/versions/${draftId}/approve`).set(H).send();
    expect(selfApprove.status).toBe(403); // segregation of duties
  });

  it('independent approver approves and publishes; regression pack gate runs', async () => {
    await agents.superadmin2.post(`/api/v1/rules/versions/${draftId}/approve`).set(H).send().expect(200);
    const pub = await agents.superadmin2.post(`/api/v1/rules/versions/${draftId}/publish`).set(H).send();
    expect(pub.status).toBe(200); // no tests registered for this key → vacuous pass
    expect(pub.body.status).toBe('published');
  });

  it('rollback re-publishes prior content as a NEW version, preserving history', async () => {
    const versions = await agents.superadmin.get('/api/v1/rules/versions?ruleKey=lmpc.mrp');
    const v1 = versions.body.versions.find((v: any) => v.version === 1);
    const rb = await agents.superadmin.post(`/api/v1/rules/versions/${v1.id}/rollback`).set(H).send();
    expect(rb.status).toBe(200);
    expect(rb.body.version).toBeGreaterThan(1);
    expect(rb.body.rollbackOf).toBe(v1.id);
    const after = await agents.superadmin.get('/api/v1/rules/versions?ruleKey=lmpc.mrp');
    expect(after.body.versions.length).toBeGreaterThan(versions.body.versions.length); // nothing deleted
  });

  it('published rule test pack passes, including the critical calibration pair', async () => {
    const versions = await agents.superadmin.get('/api/v1/rules/versions?ruleKey=lmpc.font_size.rule7');
    const v = versions.body.versions[0];
    const res = await agents.superadmin.post(`/api/v1/rules/versions/${v.id}/test`).set(H).send();
    expect(res.body.total).toBeGreaterThanOrEqual(3);
    expect(res.body.passed).toBe(res.body.total);
  });
});

describe('e-commerce flow (ECM, UAT-06 partial)', () => {
  it('preserves listing evidence, extracts declarations and applies channel rules', async () => {
    const created = await agents.user.post('/api/v1/inspections').set(H).send({
      type: 'ecommerce', eventDate: '2026-08-01',
      product: { brand: 'Importo', genericName: 'Wafers', category: 'packaged_food', importStatus: 'imported' },
    });
    const id = created.body.id;
    await agents.user.post(`/api/v1/inspections/${id}/evidence/url`).set(H).send({
      url: 'https://demo-marketplace.example/p/1', marketplace: 'DemoMkt',
      structured: { listing_title: 'Importo Wafers', mrp: 'MRP ₹ 249.00 (Inclusive of all taxes)', net_quantity: 'Net Qty: 150 g' },
    }).expect(201);
    await agents.user.post(`/api/v1/inspections/${id}/process`).set(H).send().expect(202);
    await drainJobs(getDb());
    const evalRes = await agents.user.post(`/api/v1/inspections/${id}/evaluate`).set(H).send();
    const keys = evalRes.body.results.map((r: any) => r.ruleKey);
    expect(keys).toContain('ecom.listing_declarations');
    expect(keys).toContain('ecom.origin_filter'); // imported + after 2026-07-01
    const listing = evalRes.body.results.find((r: any) => r.ruleKey === 'ecom.listing_declarations');
    expect(listing.outcome).toBe('failed'); // responsible_entity missing from listing
  });
});

describe('offline draft sync idempotency (MOB-01/02, UAT-11)', () => {
  it('same creator + clientRef returns the existing inspection — retried sync never duplicates', async () => {
    const body = {
      type: 'physical_retail', eventDate: '2026-08-05', clientRef: 'local_uat11_abc',
      product: { brand: 'OfflineBrand', genericName: 'Salt', category: 'packaged_food' },
    };
    const first = await agents.user.post('/api/v1/inspections').set(H).send(body);
    expect(first.status).toBe(201);
    const retry = await agents.user.post('/api/v1/inspections').set(H).send(body);
    expect(retry.body.id).toBe(first.body.id);
    // A different user with the same clientRef gets their own record.
    const other = await agents.superadmin.post('/api/v1/inspections').set(H).send(body);
    expect(other.body.id).not.toBe(first.body.id);
  });
});

describe('notices and re-inspection lineage (REV-06/07, UAT-09 basic)', () => {
  it('issues an improvement notice and creates a linked re-inspection without overwriting', async () => {
    const created = await agents.user.post('/api/v1/inspections').set(H).send({
      type: 'physical_retail', eventDate: '2026-08-01',
      product: { brand: 'NoticeCo', genericName: 'Tea', category: 'packaged_food' },
    });
    const id = created.body.id;
    const notice = await agents.admin.post(`/api/v1/inspections/${id}/notices`).set(H)
      .send({ kind: 'improvement', dueDate: '2026-09-30' });
    expect(notice.status).toBe(201);
    await agents.admin.patch(`/api/v1/notices/${notice.body.noticeId}`).set(H)
      .send({ status: 'responded', response: { note: 'seller replied' } }).expect(200);
    const re = await agents.admin.post(`/api/v1/inspections/${id}/reinspect`).set(H).send({});
    expect(re.status).toBe(201);
    expect(re.body.parentInspectionId).toBe(id);
    expect(re.body.id).not.toBe(id);
    const timeline = await agents.admin.get(`/api/v1/inspections/${id}/timeline`);
    expect(timeline.body.notices).toHaveLength(1);
    expect(timeline.body.linkedInspections.map((l: any) => l.id)).toContain(re.body.id);
  });
});

describe('three-role model (IAM-02/06)', () => {
  it('exposes exactly three roles, and only super_admin holds a destructive permission', async () => {
    const res = await agents.superadmin.get('/api/v1/roles');
    expect(res.body.roles.map((r: any) => r.role)).toEqual(['user', 'admin', 'super_admin']);
    const byRole = Object.fromEntries(res.body.roles.map((r: any) => [r.role, r.permissions]));
    for (const perm of ['inspection.delete', 'evidence.delete', 'rule.delete', 'admin.users.delete']) {
      expect(byRole.super_admin).toContain(perm);
      expect(byRole.user).not.toContain(perm);
      expect(byRole.admin).not.toContain(perm);
    }
  });

  it('user does the work but cannot approve overrides, draft rules, administer or delete', async () => {
    const created = await agents.user.post('/api/v1/inspections').set(H).send({
      type: 'physical_retail', eventDate: '2026-08-10',
      product: { brand: 'RoleCo', genericName: 'Biscuits', category: 'packaged_food' },
    });
    expect(created.status).toBe(201);
    await agents.user.post(`/api/v1/inspections/${created.body.id}/evaluate`).set(H).send().expect(200);

    expect((await agents.user.get('/api/v1/admin/users')).status).toBe(403);
    expect((await agents.user.get('/api/v1/audit')).status).toBe(403);
    expect((await agents.user.post('/api/v1/rules/versions').set(H).send({})).status).toBe(403);
    const del = await agents.user.delete(`/api/v1/inspections/${created.body.id}`).set(H)
      .send({ reason: 'should be refused' });
    expect(del.status).toBe(403);
  });

  it('admin reviews only: no create, no upload, no delete — but every review verb', async () => {
    const create = await agents.admin.post('/api/v1/inspections').set(H).send({ type: 'physical_retail' });
    expect(create.status).toBe(403);
    const upload = await agents.admin.post(`/api/v1/inspections/${inspectionId}/evidence`).set(H)
      .field('faceLabel', 'front').attach('file', pngVariant(0, 'admin-upload'), 'x.png');
    expect(upload.status).toBe(403);
    const del = await agents.admin.delete(`/api/v1/inspections/${inspectionId}`).set(H)
      .send({ reason: 'no authority' });
    expect(del.status).toBe(403);

    expect((await agents.admin.get('/api/v1/audit')).status).toBe(200);
    expect((await agents.admin.get(`/api/v1/inspections/${inspectionId}/findings`)).status).toBe(200);
    expect((await agents.admin.get(`/api/v1/reports/${reportId}/verify`)).status).toBe(200);
  });

  it('legacy role names are migrated away and are no longer accepted on write', async () => {
    const res = await agents.superadmin.post('/api/v1/admin/users').set(H).send({
      email: 'legacy@demo.gov.example', name: 'Legacy', password: 'LongEnoughPass1', role: 'inspector',
    });
    expect(res.status).toBe(400);
    const stale = getDb().prepare(
      "SELECT COUNT(*) AS c FROM users WHERE role NOT IN ('user','admin','super_admin')",
    ).get() as any;
    expect(stale.c).toBe(0);
  });
});

describe('super_admin deletion (DEL-01)', () => {
  let victimId: string;

  it('soft-deletes an inspection with a mandatory reason and hides it everywhere', async () => {
    const created = await agents.user.post('/api/v1/inspections').set(H).send({
      type: 'physical_retail', eventDate: '2026-08-12', location: 'Delete me',
      product: { brand: 'DeleteCo', genericName: 'Sugar', category: 'packaged_food' },
    });
    victimId = created.body.id;

    const noReason = await agents.superadmin.delete(`/api/v1/inspections/${victimId}`).set(H).send({});
    expect(noReason.status).toBe(400); // the reason is written to the audit log

    const del = await agents.superadmin.delete(`/api/v1/inspections/${victimId}`).set(H)
      .send({ reason: 'Duplicate record created during training' });
    expect(del.status).toBe(200);

    expect((await agents.user.get(`/api/v1/inspections/${victimId}`)).status).toBe(404);
    const list = await agents.user.get('/api/v1/inspections');
    expect(list.body.inspections.map((i: any) => i.id)).not.toContain(victimId);
    const search = await agents.superadmin.get('/api/v1/search?q=DeleteCo');
    expect(JSON.stringify(search.body.results)).not.toContain(victimId);

    const audit = getDb().prepare(
      "SELECT * FROM audit_events WHERE action = 'inspection.delete' AND object_id = ?",
    ).get(victimId) as any;
    expect(audit).toBeTruthy();
  });

  it('lists deleted records in the recycle bin and restores one', async () => {
    const bin = await agents.superadmin.get('/api/v1/inspections/deleted');
    const row = bin.body.inspections.find((i: any) => i.id === victimId);
    expect(row).toBeTruthy();
    expect(row.deletedReason).toContain('Duplicate');

    await agents.superadmin.post(`/api/v1/inspections/${victimId}/restore`).set(H).send().expect(200);
    expect((await agents.user.get(`/api/v1/inspections/${victimId}`)).status).toBe(200);
  });

  it('refuses to delete a finalized inspection without an explicit acknowledgement', async () => {
    const res = await agents.superadmin.delete(`/api/v1/inspections/${inspectionId}`).set(H)
      .send({ reason: 'attempt on a signed record' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('force');

    const forced = await agents.superadmin.delete(`/api/v1/inspections/${inspectionId}`).set(H)
      .send({ reason: 'ordered by the directorate', force: true });
    expect(forced.status).toBe(200);
    // The append-only audit chain still verifies after a destructive action.
    expect((await agents.superadmin.get('/api/v1/audit/verify')).body.ok).toBe(true);
    await agents.superadmin.post(`/api/v1/inspections/${inspectionId}/restore`).set(H).send().expect(200);
  });

  it('deleting a user offboards and signs them out rather than dropping the row', async () => {
    const created = await agents.superadmin.post('/api/v1/admin/users').set(H).send({
      email: 'temp@demo.gov.example', name: 'Temporary', password: 'LongEnoughPass1', role: 'user',
    });
    expect(created.status).toBe(201);
    const tempAgent = await loginAgent('temp@demo.gov.example', 'LongEnoughPass1');

    await agents.superadmin.delete(`/api/v1/admin/users/${created.body.id}`).set(H).send().expect(200);

    expect((await tempAgent.get('/api/v1/auth/me')).status).toBe(401);
    const relogin = await request(app).post('/api/v1/auth/login').set(H)
      .send({ email: 'temp@demo.gov.example', password: 'LongEnoughPass1' });
    expect(relogin.status).toBe(401);
    const row = getDb().prepare('SELECT status FROM users WHERE id = ?').get(created.body.id) as any;
    expect(row.status).toBe('offboarded'); // retained: the audit chain references this actor
  });

  it('deletes an unused draft rule version but never a published one', async () => {
    const sets = await agents.superadmin.get('/api/v1/rules/sets');
    const base = sets.body.ruleSets.find((s: any) => s.id === 'rs_base');
    const draft = await agents.superadmin.post('/api/v1/rules/versions').set(H).send({
      ruleSetId: base.id, ruleKey: 'lmpc.disposable_draft', title: 'Disposable draft',
      citation: 'Test', effectiveFrom: '2026-09-01',
      applicability: { categories: ['*'], channels: ['*'] }, inputs: {},
      logic: { checks: [{ type: 'presence', declType: 'mrp' }] }, outcome: { severityOnFail: 'low' },
    });
    expect(draft.status).toBe(201);
    await agents.superadmin.delete(`/api/v1/rules/versions/${draft.body.id}`).set(H)
      .send({ reason: 'drafted in error' }).expect(200);

    const published = (await agents.superadmin.get('/api/v1/rules/versions?ruleKey=lmpc.mrp')).body
      .versions.find((v: any) => v.status === 'published');
    const res = await agents.superadmin.delete(`/api/v1/rules/versions/${published.id}`).set(H)
      .send({ reason: 'should be refused' });
    expect(res.status).toBe(409);
  });
});

describe('capture quality gate (field-officer flow)', () => {
  let caseId: string;

  it('accepts the six package faces', async () => {
    const created = await agents.user.post('/api/v1/inspections').set(H).send({
      type: 'physical_retail', eventDate: '2026-08-20',
      product: { brand: 'FaceCo', genericName: 'Rice', category: 'packaged_food' },
    });
    caseId = created.body.id;
    for (const face of ['front', 'back', 'top', 'bottom', 'left', 'right']) {
      const res = await agents.user.post(`/api/v1/inspections/${caseId}/evidence`).set(H)
        .field('faceLabel', face)
        .attach('files', pngVariant(1, `faces-${face}`), { filename: `${face}.png`, contentType: 'image/png' });
      expect(res.status).toBe(201);
    }
    const detail = await agents.user.get(`/api/v1/inspections/${caseId}`);
    expect(detail.body.assets.map((a: any) => a.faceLabel).sort())
      .toEqual(['back', 'bottom', 'front', 'left', 'right', 'top']);
  });

  it('refuses a duplicate image and names the face it was already captured as', async () => {
    const dupe = await agents.user.post(`/api/v1/inspections/${caseId}/evidence`).set(H)
      .field('faceLabel', 'closeup')
      .attach('files', pngVariant(1, 'faces-front'), { filename: 'again.png', contentType: 'image/png' });
    expect(dupe.status).toBe(409);
    expect(dupe.body.error.message).toContain('Duplicate image');
    expect(dupe.body.error.message).toContain('front');

    // The refusal is audited, and no second asset was created for those bytes.
    const denied = getDb().prepare(
      "SELECT after_json FROM audit_events WHERE action = 'evidence.upload' AND outcome = 'denied' ORDER BY seq DESC LIMIT 1",
    ).get() as any;
    expect(JSON.parse(denied.after_json).reason).toBe('duplicate_image');
    const detail = await agents.user.get(`/api/v1/inspections/${caseId}`);
    expect(detail.body.assets).toHaveLength(6);
  });

  it('the same image on a different case is not a duplicate', async () => {
    const other = await agents.user.post('/api/v1/inspections').set(H).send({
      type: 'physical_retail', eventDate: '2026-08-20',
    });
    const res = await agents.user.post(`/api/v1/inspections/${other.body.id}/evidence`).set(H)
      .field('faceLabel', 'front')
      .attach('files', pngVariant(1, 'faces-front'), { filename: 'front.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
  });

  it('grades every capture-quality dimension in the officer flow', async () => {
    await agents.user.post(`/api/v1/inspections/${caseId}/process`).set(H).send().expect(202);
    await drainJobs(getDb());
    const detail = await agents.user.get(`/api/v1/inspections/${caseId}`);
    const asset = await agents.user.get(`/api/v1/assets/${detail.body.assets[0].id}`);
    const q = asset.body.quality;
    // Blur, darkness, label visibility and orientation are all assessed per image.
    for (const dim of ['blur', 'exposure', 'orientation', 'labelVisibility', 'occlusion']) {
      expect(typeof q.scores[dim]).toBe('number');
    }
    expect(q.recapture).toHaveProperty('recommended');
    // Quality codes never leak into legal vocabulary.
    for (const code of q.reasonCodes) {
      expect(['passed', 'failed', 'needs_review', 'not_applicable', 'not_assessable']).not.toContain(code);
    }
  });
});

describe('compliance report summary (EXT-07: counts, never a score)', () => {
  it('reports outcome counts and the failed rules, with no numeric compliance score', async () => {
    const json = await agents.admin.get(`/api/v1/reports/${reportId}/export/json`);
    const body = Buffer.isBuffer(json.body) ? JSON.parse(json.body.toString()) : json.body;
    const c = body.snapshot.officerConclusion;

    expect(['compliant', 'non_compliant', 'review_required']).toContain(c.overallStatus);
    // Counts add up to the rules applied.
    const { total, passed, failed, needsReview, notAssessable, notApplicable } = c.summary;
    expect(passed + failed + needsReview + notAssessable + notApplicable).toBe(total);
    expect(total).toBeGreaterThan(0);

    // Every failed rule is listed with the citation and evidence the officer needs.
    expect(c.failedRules).toHaveLength(failed);
    for (const f of c.failedRules) {
      expect(f.ruleKey).toBeTruthy();
      expect(f.citation).toBeTruthy();
      expect(f).toHaveProperty('evidenceRefs');
    }
    // A failed rule anywhere means non-compliant — no partial-credit percentage exists.
    if (failed > 0) expect(c.overallStatus).toBe('non_compliant');
    expect(JSON.stringify(c)).not.toMatch(/"(score|percentage|percent|compliancePct)"/i);
  });
});
