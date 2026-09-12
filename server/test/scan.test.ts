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
import { loadScanImages, requireScanReport, scanReportPdf } from '../src/modules/compliance/scanReport.js';

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
    expect(res.body.minImages).toBe(1);
    expect(res.body.sides).toEqual(['top', 'bottom', 'left', 'right']);
    expect(res.body.extraSides).toContain('other');
    // Whether an AI verdict is actually available is the server's answer, not a
    // client guess — here it is the pinned deterministic fallback.
    expect(res.body.judge.isMock).toBe(true);
  });

  it('refuses analysis with no images, and accepts it at one', async () => {
    const scan = (await officer.post('/api/v1/scans').set(H).send({
      product: { brand: 'Test Bar' },
    })).body.scanId;

    // Nothing photographed is still nothing to assess.
    const none = await officer.post(`/api/v1/scans/${scan}/analyze`).set(H);
    expect(none.status).toBe(422);
    expect(none.body.error.message).toMatch(/at least 1/i);

    // One face is the floor: a small packet can carry its whole label on one side.
    const first = await officer.post(`/api/v1/scans/${scan}/images`).set(H)
      .attach('file', png('top'), { filename: 'top.png', contentType: 'image/png' })
      .field('side', 'top');
    expect(first.status).toBe(201);
    expect(first.body.readyToAnalyze).toBe(true);
    expect(first.body.minImages).toBe(1);

    const go = await officer.post(`/api/v1/scans/${scan}/analyze`).set(H);
    expect(go.status).toBe(202);
    expect(go.body.imageCount).toBe(1);
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

  it('serves the OCR boxes the evidence viewer draws on the images', async () => {
    const res = await officer.get(`/api/v1/scans/${scanId}/ocr`).set(H);
    expect(res.status).toBe(200);
    expect(res.body.images).toHaveLength(2);

    for (const img of res.body.images) {
      expect(img.assetId).toBeTruthy();
      // An image the recogniser read is distinguishable from one it never saw:
      // "found nothing here" and "did not look here" must never render the same.
      expect(img.processed).toBe(true);
      for (const b of img.blocks) {
        expect(typeof b.text).toBe('string');
        // Fractions of the ORIGINAL photograph, or the boxes land in the wrong
        // place on the officer's picture.
        for (const k of ['x', 'y', 'w', 'h'] as const) {
          expect(b.bbox[k]).toBeGreaterThanOrEqual(0);
          expect(b.bbox[k]).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('serves an evidence image to a plain <img> tag: cookie only, no custom header', async () => {
    // The viewer renders images with <img src>, which cannot carry the
    // X-Requested-With header the mutation routes demand. If that header ever
    // became mandatory on reads, every image on the result screen would silently
    // fail to load.
    const assetId = (getDb().prepare(
      "SELECT id FROM evidence_assets WHERE inspection_id = ? AND kind = 'image' LIMIT 1",
    ).get(scanId) as any).id;
    const res = await officer.get(`/api/v1/assets/${assetId}/content`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\//);
  });

  it('will not hand another officer the OCR boxes for this scan', async () => {
    const other = request(app);
    const signup = await other.post('/api/v1/auth/signup').set(H).send({
      email: `nosy-${Date.now()}@packcomply.test`, name: 'Nosy Officer', password: 'PackComply#2026',
    });
    const cookie = signup.headers['set-cookie'];
    const res = await other.get(`/api/v1/scans/${scanId}/ocr`).set(H).set('Cookie', cookie);
    expect([403, 404]).toContain(res.status);
  });

  it('puts the package images in the PDF, and stays a PDF when one cannot be embedded', async () => {
    const images = loadScanImages(getDb(), scanId);
    expect(images).toHaveLength(2);
    expect(images.every((i) => i.buf !== null)).toBe(true);
    expect(images.every((i) => i.sha256.length === 64)).toBe(true);

    const report = requireScanReport(getDb(), scanId, {
      id: 'usr_test', name: 'Test Officer', email: 'officer@packcomply.test',
    } as any);
    const withImages = await scanReportPdf(report, images);
    const without = await scanReportPdf(report, []);
    expect(withImages.subarray(0, 5).toString()).toBe('%PDF-');
    // The plates are the point: a report that shows the package is materially
    // larger than one that only describes it.
    expect(withImages.length).toBeGreaterThan(without.length);

    // A face the PDF cannot reproduce (HEIC, say) must not take the document down.
    const unembeddable = await scanReportPdf(report, [
      { ...images[0], mime: 'image/heic', buf: null },
    ]);
    expect(unembeddable.subarray(0, 5).toString()).toBe('%PDF-');
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

// The reviewer's side of the segregation of duties: `admin` judges work it did not
// do, and the judgement is a record rather than a click that leaves no trace.
describe('reviewer sign-off', () => {
  const DEMO_PASSWORD = 'PackComply#2026';
  let reviewer: request.Agent;       // admin@demo.gov.example
  let demoOfficer: request.Agent;    // user@demo.gov.example, same organization
  let reviewedScan: string;

  async function signIn(email: string, password = DEMO_PASSWORD) {
    const agent = request.agent(app);
    const res = await agent.post('/api/v1/auth/login').set(H).send({ email, password });
    return { agent, res };
  }

  async function analysedScan(agent: request.Agent, brand: string) {
    const scanId = (await agent.post('/api/v1/scans').set(H).send({ product: { brand } })).body.scanId;
    await agent.post(`/api/v1/scans/${scanId}/images`).set(H)
      .attach('file', png(`${brand}-top`), { filename: 'top.png', contentType: 'image/png' })
      .field('side', 'top');
    await agent.post(`/api/v1/scans/${scanId}/analyze`).set(H);
    await drainJobs(getDb());
    return scanId;
  }

  beforeAll(async () => {
    reviewer = (await signIn('admin@demo.gov.example')).agent;
    demoOfficer = (await signIn('user@demo.gov.example')).agent;
    reviewedScan = await analysedScan(demoOfficer, 'Review Me');
  });

  it('gives the reviewer the organization’s scans, named with the officer who captured them', async () => {
    const res = await reviewer.get('/api/v1/scans?limit=200').set(H);
    expect(res.status).toBe(200);
    const row = res.body.scans.find((s: any) => s.scanId === reviewedScan);
    expect(row).toBeTruthy();
    // A sign-off is a statement about someone else's work, so that someone is named.
    expect(row.officerName).toMatch(/Asha/);
    expect(row.review).toBeNull();
  });

  it('refuses a field officer the review verb entirely', async () => {
    const res = await demoOfficer.post(`/api/v1/scans/${reviewedScan}/review`).set(H)
      .send({ decision: 'accepted', reason: 'Looks fine to me.' });
    expect(res.status).toBe(403);

    const me = await demoOfficer.get('/api/v1/auth/me').set(H);
    expect(me.body.permissions).not.toContain('scan.review');
  });

  it('demands a reason on every decision, including acceptance', async () => {
    const res = await reviewer.post(`/api/v1/scans/${reviewedScan}/review`).set(H)
      .send({ decision: 'accepted', reason: 'ok' });
    expect(res.status).toBe(400);
  });

  it('rejects a decision that is not one of the three', async () => {
    const res = await reviewer.post(`/api/v1/scans/${reviewedScan}/review`).set(H)
      .send({ decision: 'approved_with_love', reason: 'Not a real decision.' });
    expect(res.status).toBe(400);
  });

  it('records the decision, pins it to the verdict, and writes it to the audit chain', async () => {
    const res = await reviewer.post(`/api/v1/scans/${reviewedScan}/review`).set(H)
      .send({ decision: 'rejected', reason: 'The net quantity finding is not supported by the top face.' });
    expect(res.status).toBe(201);
    expect(res.body.decision).toBe('rejected');
    expect(res.body.stale).toBe(false);
    expect(res.body.verdictId).toBeTruthy();

    const scan = await reviewer.get(`/api/v1/scans/${reviewedScan}`).set(H);
    expect(scan.body.review.decision).toBe('rejected');
    expect(scan.body.review.reviewerName).toMatch(/Rohan/);
    expect(scan.body.reviews).toHaveLength(1);

    const audit = getDb().prepare(
      "SELECT * FROM audit_events WHERE action = 'scan.reviewed' AND object_id = ? ORDER BY seq DESC LIMIT 1",
    ).get(reviewedScan) as any;
    expect(audit).toBeTruthy();
    const after = JSON.parse(audit.after_json);
    expect(after.decision).toBe('rejected');
    expect(after.reason).toMatch(/net quantity/i);
  });

  it('keeps every decision, newest first, so the path to the outcome survives', async () => {
    await reviewer.post(`/api/v1/scans/${reviewedScan}/review`).set(H)
      .send({ decision: 'accepted', reason: 'Re-read the close-up; the declaration is legible after all.' });

    const scan = await reviewer.get(`/api/v1/scans/${reviewedScan}`).set(H);
    expect(scan.body.review.decision).toBe('accepted');
    expect(scan.body.reviews).toHaveLength(2);
    expect(scan.body.reviews[1].decision).toBe('rejected');
  });

  it('marks a decision stale once the package is re-analysed past it', async () => {
    const fresh = await reviewer.get(`/api/v1/scans/${reviewedScan}`).set(H);
    expect(fresh.body.review.stale).toBe(false);

    // A new verdict means the standing sign-off was taken against a reading that is
    // no longer current — it must not silently carry forward onto the new one.
    await demoOfficer.post(`/api/v1/scans/${reviewedScan}/analyze`).set(H).send({ force: true });
    await drainJobs(getDb());

    const after = await reviewer.get(`/api/v1/scans/${reviewedScan}`).set(H);
    expect(after.body.review.stale).toBe(true);

    const list = await reviewer.get('/api/v1/scans?limit=200').set(H);
    expect(list.body.scans.find((s: any) => s.scanId === reviewedScan).review.stale).toBe(true);
  });

  it('does not let a super administrator perform the auditing work at all', async () => {
    const { agent: superAdmin } = await signIn('superadmin@demo.gov.example');
    // The hierarchy is enforced in the permission matrix, not merely hidden in the UI.
    expect((await superAdmin.post('/api/v1/scans').set(H).send({})).status).toBe(403);

    const me = await superAdmin.get('/api/v1/auth/me').set(H);
    for (const p of ['inspection.create', 'evidence.upload', 'evaluation.run', 'declaration.edit']) {
      expect(me.body.permissions).not.toContain(p);
    }
    // It keeps every authority that actually is its job.
    expect(me.body.permissions).toContain('scan.review');
    expect(me.body.permissions).toContain('team.manage');
    expect(me.body.permissions).toContain('inspection.delete');
  });

  it('refuses a sign-off from whoever captured the scan', async () => {
    // No role can both capture and review through the API any more, so this guard is
    // asserted directly against the service that enforces it — it is defence in
    // depth for the day someone widens the matrix again.
    const { recordScanReview } = await import('../src/modules/compliance/reviewService.js');
    const r = getDb().prepare('SELECT * FROM users WHERE email = ?')
      .get('user@demo.gov.example') as any;
    const capturer = {
      id: r.id, email: r.email, name: r.name, role: r.role,
      orgId: r.org_id, teamId: r.team_id, state: r.state, district: r.district, office: r.office,
    };
    expect(() => recordScanReview(getDb(), capturer as any, reviewedScan, {
      decision: 'accepted', reason: 'Signing off my own capture should not be possible.',
    })).toThrow(/captured this scan/i);
  });

  it('shows an admin only their own team, and the super administrator everything', async () => {
    const { agent: blrOfficer } = await signIn('user.ka@demo.gov.example');
    const blrScan = await analysedScan(blrOfficer, 'Bengaluru Packet');

    // The Pune admin must not see another team's case, in the list or by direct id.
    const puneList = await reviewer.get('/api/v1/scans?limit=200').set(H);
    expect(puneList.body.scans.some((s: any) => s.scanId === blrScan)).toBe(false);
    expect(puneList.body.scans.some((s: any) => s.scanId === reviewedScan)).toBe(true);
    expect((await reviewer.get(`/api/v1/scans/${blrScan}`).set(H)).status).toBe(403);

    // The Bengaluru admin must.
    const { agent: blrAdmin } = await signIn('admin.ka@demo.gov.example');
    const blrList = await blrAdmin.get('/api/v1/scans?limit=200').set(H);
    expect(blrList.body.scans.some((s: any) => s.scanId === blrScan)).toBe(true);
    expect(blrList.body.scans.some((s: any) => s.scanId === reviewedScan)).toBe(false);

    // The super administrator sees across every team in the organization.
    const { agent: sa } = await signIn('superadmin@demo.gov.example');
    const saList = await sa.get('/api/v1/scans?limit=200').set(H);
    const ids = saList.body.scans.map((s: any) => s.scanId);
    expect(ids).toContain(blrScan);
    expect(ids).toContain(reviewedScan);
  });

  it('makes a super administrator’s decision final against an admin', async () => {
    const scanId = await analysedScan(demoOfficer, 'Precedence Case');
    const { agent: sa } = await signIn('superadmin@demo.gov.example');

    const decided = await sa.post(`/api/v1/scans/${scanId}/review`).set(H)
      .send({ decision: 'rejected', reason: 'Escalated: the missing declaration is material, the case stands rejected.' });
    expect(decided.status).toBe(201);
    expect(decided.body.final).toBe(true);
    expect(decided.body.reviewerRole).toBe('super_admin');

    // The admin whose team owns the case cannot overturn it.
    const attempt = await reviewer.post(`/api/v1/scans/${scanId}/review`).set(H)
      .send({ decision: 'accepted', reason: 'Attempting to overturn the super administrator.' });
    expect(attempt.status).toBe(403);
    expect(attempt.body.error.message).toMatch(/final/i);

    // The super administrator may still revisit its own decision.
    const again = await sa.post(`/api/v1/scans/${scanId}/review`).set(H)
      .send({ decision: 'accepted', reason: 'Reconsidered after reviewing the close-up face.' });
    expect(again.status).toBe(201);
  });

  it('refuses a sign-off on a scan that has never been analysed', async () => {
    const empty = (await demoOfficer.post('/api/v1/scans').set(H).send({})).body.scanId;
    const res = await reviewer.post(`/api/v1/scans/${empty}/review`).set(H)
      .send({ decision: 'accepted', reason: 'There is nothing here to accept.' });
    expect(res.status).toBe(422);
  });
});
