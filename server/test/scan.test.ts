import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { openDb, setDb, getDb } from '../src/db/index.js';
import { seed } from '../src/db/seed.js';
import { createApp } from '../src/app.js';
import { registerPipelineHandlers } from '../src/modules/processing/pipeline.js';
import { registerComplianceHandlers } from '../src/modules/compliance/jobs.js';
import { drainJobs } from '../src/modules/processing/queue.js';
import { sha256Hex } from '../src/core/crypto.js';
import { loadRulesCorpus } from '../src/modules/compliance/rulesContext.js';

// Field-officer scan flow. The compliance judge is pinned to 'rule_engine' by
// test/setup.ts, so nothing here makes a live API call; what is exercised is the
// route contract, the capture rules and the provenance the verdict must carry.

const PNG_BASE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
// Distinct bytes per side — identical bytes are refused by the duplicate gate.
const png = (salt: string) => Buffer.concat([PNG_BASE, Buffer.from(salt)]);

const H = { 'X-Requested-With': 'packcomply' };
let app: ReturnType<typeof createApp>;
let officer: request.Agent;

async function signup(email: string, name = 'Scan Tester', password = 'ScanTester#2026') {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/signup').set(H).send({ email, name, password });
  return { agent, res };
}

beforeAll(async () => {
  const db = openDb(process.env.PACKCOMPLY_DB_PATH!);
  setDb(db);
  seed(db);
  registerPipelineHandlers();
  registerComplianceHandlers();
  app = createApp();
  officer = (await signup('scanner@packcomply.test')).agent;
});

describe('self-registration', () => {
  it('creates a field-officer account and signs it in', async () => {
    const { res } = await signup('newbie@packcomply.test', 'New Officer');
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('user');
  });

  it('never lets a registrant claim review or administrative authority', async () => {
    const agent = request.agent(app);
    const res = await agent.post('/api/v1/auth/signup').set(H).send({
      email: 'climber@packcomply.test', name: 'Privilege Climber',
      password: 'Climber#2026x', role: 'super_admin',
    });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('user');
    // And the granted permissions are the field-officer set, not the admin one.
    const me = await agent.get('/api/v1/auth/me').set(H);
    expect(me.body.permissions).not.toContain('admin.users');
    expect(me.body.permissions).not.toContain('inspection.delete');
  });

  it('rejects a short password and a duplicate address', async () => {
    const weak = await request(app).post('/api/v1/auth/signup').set(H)
      .send({ email: 'weak@packcomply.test', name: 'Weak Pass', password: 'short' });
    expect(weak.status).toBe(400);

    const dupe = await request(app).post('/api/v1/auth/signup').set(H)
      .send({ email: 'scanner@packcomply.test', name: 'Dupe', password: 'ScanTester#2026' });
    expect(dupe.status).toBe(409);
  });

  it('isolates each self-registered officer in their own organization', async () => {
    const a = await signup('iso-a@packcomply.test');
    const b = await signup('iso-b@packcomply.test');
    expect(a.res.body.user.orgId).not.toBe(b.res.body.user.orgId);

    const scan = await a.agent.post('/api/v1/scans').set(H).send({});
    const seen = await b.agent.get(`/api/v1/scans/${scan.body.scanId}`).set(H);
    expect(seen.status).toBe(403);
  });
});

describe('capture rules', () => {
  it('publishes the sides to ask for and the image floor', async () => {
    const res = await officer.get('/api/v1/scans/capability').set(H);
    expect(res.status).toBe(200);
    expect(res.body.minImages).toBe(2);
    expect(res.body.sides).toEqual(['top', 'bottom', 'left', 'right']);
    expect(res.body.extraSides).toContain('other');
    // Whether an AI verdict is actually available is the server's answer, not a
    // client guess — here it is the pinned deterministic fallback.
    expect(res.body.judge.isMock).toBe(true);
  });

  it('refuses analysis below two images, and accepts it at two', async () => {
    const scan = (await officer.post('/api/v1/scans').set(H).send({
      product: { brand: 'Test Bar' },
    })).body.scanId;

    const none = await officer.post(`/api/v1/scans/${scan}/analyze`).set(H);
    expect(none.status).toBe(422);
    expect(none.body.error.message).toMatch(/at least 2/i);

    const first = await officer.post(`/api/v1/scans/${scan}/images`).set(H)
      .attach('file', png('top'), { filename: 'top.png', contentType: 'image/png' })
      .field('side', 'top');
    expect(first.status).toBe(201);
    expect(first.body.readyToAnalyze).toBe(false);

    const one = await officer.post(`/api/v1/scans/${scan}/analyze`).set(H);
    expect(one.status).toBe(422);

    const second = await officer.post(`/api/v1/scans/${scan}/images`).set(H)
      .attach('file', png('bottom'), { filename: 'bottom.png', contentType: 'image/png' })
      .field('side', 'bottom');
    expect(second.body.readyToAnalyze).toBe(true);

    const go = await officer.post(`/api/v1/scans/${scan}/analyze`).set(H);
    expect(go.status).toBe(202);
  });

  it('accepts an extra side when one of the four is unavailable', async () => {
    const scan = (await officer.post('/api/v1/scans').set(H).send({})).body.scanId;
    for (const side of ['left', 'closeup']) {
      const res = await officer.post(`/api/v1/scans/${scan}/images`).set(H)
        .attach('file', png(`${scan}-${side}`), { filename: `${side}.png`, contentType: 'image/png' })
        .field('side', side);
      expect(res.status).toBe(201);
    }
    expect((await officer.post(`/api/v1/scans/${scan}/analyze`).set(H)).status).toBe(202);
  });

  it('rejects an unknown package side', async () => {
    const scan = (await officer.post('/api/v1/scans').set(H).send({})).body.scanId;
    const res = await officer.post(`/api/v1/scans/${scan}/images`).set(H)
      .attach('file', png('weird'), { filename: 'x.png', contentType: 'image/png' })
      .field('side', 'diagonal');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Unknown package side/);
  });
});

describe('analysis and verdict', () => {
  let scanId: string;

  beforeAll(async () => {
    scanId = (await officer.post('/api/v1/scans').set(H).send({
      product: { brand: 'Verdict Test', category: 'packaged_food' },
    })).body.scanId;
    for (const side of ['top', 'bottom']) {
      await officer.post(`/api/v1/scans/${scanId}/images`).set(H)
        .attach('file', png(`verdict-${side}`), { filename: `${side}.png`, contentType: 'image/png' })
        .field('side', side);
    }
    await officer.post(`/api/v1/scans/${scanId}/analyze`).set(H);
    await drainJobs(getDb());
  });

  it('produces a verdict carrying full provenance', async () => {
    const res = await officer.get(`/api/v1/scans/${scanId}`).set(H);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');

    const v = res.body.verdict;
    expect(v).toBeTruthy();
    expect(['compliant', 'non_compliant', 'needs_review']).toContain(v.overall);
    // Provenance is the point: without these a verdict cannot be reproduced or
    // challenged, and a fallback verdict could pass as an AI reading of the law.
    expect(v.provider).toBe('rule_engine');
    expect(v.isMock).toBe(true);
    expect(v.summary).toMatch(/GEMINI_API_KEY/);
    expect(typeof v.ocrText).toBe('string');
    expect(v.rulesSha256).toBe(loadRulesCorpus().sha256);
  });

  it('keeps the deterministic engine findings separate from the verdict', async () => {
    const res = await officer.get(`/api/v1/scans/${scanId}`).set(H);
    expect(Array.isArray(res.body.engineFindings)).toBe(true);
    expect(res.body.engineFindings.length).toBeGreaterThan(0);
    expect(res.body.engineFindings[0]).toHaveProperty('citation');
  });

  const countJudgeJobs = (id: string) => (getDb().prepare(
    "SELECT COUNT(*) AS c FROM processing_jobs WHERE type = 'judge_compliance' AND target_id = ?",
  ).get(id) as any).c as number;

  it('re-analysing the same evidence set does not queue duplicate work', async () => {
    const before = countJudgeJobs(scanId);
    await officer.post(`/api/v1/scans/${scanId}/analyze`).set(H);
    expect(countJudgeJobs(scanId)).toBe(before);
  });

  it('force re-queues the judge so a retry after an outage is not a silent no-op', async () => {
    const before = countJudgeJobs(scanId);
    const res = await officer.post(`/api/v1/scans/${scanId}/analyze`).set(H).send({ force: true });
    expect(res.status).toBe(202);
    expect(countJudgeJobs(scanId)).toBe(before + 1);

    // While that retry is queued the scan must not report the previous verdict as
    // the current result.
    expect((await officer.get(`/api/v1/scans/${scanId}`).set(H)).body.status).toBe('analyzing');
    await drainJobs(getDb());
    expect((await officer.get(`/api/v1/scans/${scanId}`).set(H)).body.status).toBe('ready');
  });

  it('records the verdict in the audit chain', async () => {
    const audit = getDb().prepare(
      "SELECT * FROM audit_events WHERE action = 'compliance.judged' AND object_id = ? ORDER BY seq DESC LIMIT 1",
    ).get(scanId) as any;
    expect(audit).toBeTruthy();
    const after = JSON.parse(audit.after_json);
    expect(after.rulesSha256).toBe(loadRulesCorpus().sha256);
    expect(after.isMock).toBe(true);
  });

  it('serves a scan report without finalizing the inspection', async () => {
    const before = (getDb().prepare('SELECT status FROM inspections WHERE id = ?').get(scanId) as any).status;

    const json = await officer.get(`/api/v1/scans/${scanId}/report`).set(H);
    expect(json.status).toBe(200);
    expect(json.body.documentType).toBe('scan_report');
    expect(json.body.sha256).toHaveLength(64);
    expect(json.body.evidence).toHaveLength(2);
    expect(json.body.evidence[0].sha256).toBeTruthy();
    expect(json.body.assessment.statutoryText.sha256).toBe(loadRulesCorpus().sha256);
    expect(json.body.disclaimer).toMatch(/not a finalized enforcement report/i);

    const pdf = await officer.get(`/api/v1/scans/${scanId}/report.pdf`).set(H);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');

    // Producing the document must not have signed anything.
    const after = (getDb().prepare('SELECT status FROM inspections WHERE id = ?').get(scanId) as any).status;
    expect(after).toBe(before);
    expect(after).not.toBe('finalized');
    expect((getDb().prepare('SELECT COUNT(*) AS c FROM reports WHERE inspection_id = ?').get(scanId) as any).c).toBe(0);
  });

  it('refuses a report for a scan that was never analysed', async () => {
    const fresh = (await officer.post('/api/v1/scans').set(H).send({})).body.scanId;
    const res = await officer.get(`/api/v1/scans/${fresh}/report`).set(H);
    expect(res.status).toBe(422);
  });
});

describe('scan history', () => {
  it('lists the officer own scans with their outcome, and nobody else', async () => {
    const res = await officer.get('/api/v1/scans').set(H);
    expect(res.status).toBe(200);
    expect(res.body.scans.length).toBeGreaterThan(0);
    const analysed = res.body.scans.find((s: any) => s.verdict !== null);
    expect(analysed).toBeTruthy();
    expect(analysed.verdictIsMock).toBe(true);
    expect(analysed.imageCount).toBeGreaterThanOrEqual(2);

    const other = (await signup('history-other@packcomply.test')).agent;
    expect((await other.get('/api/v1/scans').set(H)).body.scans).toHaveLength(0);
  });
});

describe('PDF text encoding', () => {
  it('keeps Latin text, substitutes the rupee sign, and counts dropped script', async () => {
    const { toWinAnsi } = await import('../src/modules/compliance/scanReport.js');

    expect(toWinAnsi('Net Quantity: 150 g').dropped).toBe(0);
    expect(toWinAnsi('“quoted” — dashed • bulleted…').dropped).toBe(0);

    // The rupee sign is outside WinAnsi but has a faithful equivalent, so it is
    // substituted rather than dropped — an MRP must not lose its currency.
    const rupee = toWinAnsi('MRP ₹249');
    expect(rupee.text).toBe('MRP Rs.249');
    expect(rupee.dropped).toBe(0);

    // Devanagari has no equivalent: it is dropped, but counted so the reader is told.
    const hindi = toWinAnsi('Net: 150 g / शुद्ध वजन');
    expect(hindi.dropped).toBeGreaterThan(0);
    expect(hindi.text).toContain('Net: 150 g');
    expect(hindi.text).not.toMatch(/[ऀ-ॿ]/);
  });
});

describe('statutory corpus', () => {
  it('loads the 2011 Rules and hashes them for provenance', () => {
    const corpus = loadRulesCorpus();
    expect(corpus.sources).toContain('lmpc-2011.txt');
    expect(corpus.chars).toBeGreaterThan(50_000);
    expect(corpus.sha256).toBe(sha256Hex(corpus.text));
    // Spot-check that the declaration rule the judge relies on is actually present.
    expect(corpus.text).toMatch(/Declarations to be made on every package/i);
    expect(corpus.text).toMatch(/principal display panel/i);
  });
});
