import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { openDb, setDb, getDb } from '../src/db/index.js';
import { seed } from '../src/db/seed.js';
import { createApp } from '../src/app.js';
import { registerPipelineHandlers } from '../src/modules/processing/pipeline.js';
import { registerComplianceHandlers } from '../src/modules/compliance/jobs.js';
import { backoffFor, drainJobs, reclaimStaleJobs } from '../src/modules/processing/queue.js';
import { TransientError, isTransient } from '../src/core/errors.js';
import { sha256Hex } from '../src/core/crypto.js';
import { loadRulesCorpus } from '../src/modules/compliance/rulesContext.js';
import { loadScanImages, requireScanReport, scanReportPdf } from '../src/modules/compliance/scanReport.js';
import { withholdAbsenceOnUnreadFaces } from '../src/modules/compliance/service.js';

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
  it('publishes the sides to ask for, the image floor and the ceiling', async () => {
    const res = await officer.get('/api/v1/scans/capability').set(H);
    expect(res.status).toBe(200);
    expect(res.body.minImages).toBe(1);
    expect(res.body.maxImages).toBe(8);
    // Three faces are on screen from the start; the rest are offered as the
    // officer fills them. The two lists together are exactly the ceiling, so a
    // face can never be offered that the scan has no room for.
    expect(res.body.sides).toEqual(['front', 'back', 'top']);
    expect(res.body.extraSides).toContain('other');
    expect(res.body.sides.length + res.body.extraSides.length).toBe(res.body.maxImages);
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

  it('holds eight images, and refuses a ninth face', async () => {
    const scan = (await officer.post('/api/v1/scans').set(H).send({})).body.scanId;
    const faces = ['front', 'back', 'top', 'bottom', 'left', 'right', 'closeup', 'other'];
    for (const side of faces) {
      const res = await officer.post(`/api/v1/scans/${scan}/images`).set(H)
        .attach('file', png(`${scan}-${side}`), { filename: `${side}.png`, contentType: 'image/png' })
        .field('side', side);
      expect(res.status).toBe(201);
      expect(res.body.maxImages).toBe(8);
    }
    expect((await officer.get(`/api/v1/scans/${scan}`).set(H)).body.images).toHaveLength(8);

    // 'side' is a face the evidence store knows but the scan flow does not offer,
    // so it is refused on the vocabulary before the ceiling is even consulted.
    const ninth = await officer.post(`/api/v1/scans/${scan}/images`).set(H)
      .attach('file', png(`${scan}-ninth`), { filename: 'ninth.png', contentType: 'image/png' })
      .field('side', 'side');
    expect(ninth.status).toBe(400);
  });

  it('retakes a face instead of stacking a second image on it', async () => {
    const scan = (await officer.post('/api/v1/scans').set(H).send({})).body.scanId;
    const shoot = (side: string, salt: string) => officer.post(`/api/v1/scans/${scan}/images`).set(H)
      .attach('file', png(salt), { filename: `${side}.png`, contentType: 'image/png' })
      .field('side', side);

    const blurry = await shoot('front', `${scan}-blurry`);
    expect(blurry.status).toBe(201);
    const sharp = await shoot('front', `${scan}-sharp`);
    expect(sharp.status).toBe(201);

    // One face, one image: the first attempt is retired rather than sent to OCR
    // alongside the one the officer decided to keep.
    const images = (await officer.get(`/api/v1/scans/${scan}`).set(H)).body.images;
    expect(images).toHaveLength(1);
    expect(images[0].id).toBe(sharp.body.assetId);
    expect(images[0].side).toBe('front');

    // And the retake costs nothing against the ceiling: seven more faces still fit.
    for (const side of ['back', 'top', 'bottom', 'left', 'right', 'closeup', 'other']) {
      expect((await shoot(side, `${scan}-${side}`)).status).toBe(201);
    }
    expect((await officer.get(`/api/v1/scans/${scan}`).set(H)).body.images).toHaveLength(8);
  });

  it('gives the slot back when the auditor discards a capture', async () => {
    const scan = (await officer.post('/api/v1/scans').set(H).send({})).body.scanId;
    const shot = await officer.post(`/api/v1/scans/${scan}/images`).set(H)
      .attach('file', png(`${scan}-discard`), { filename: 'front.png', contentType: 'image/png' })
      .field('side', 'front');
    expect(shot.status).toBe(201);

    const gone = await officer.delete(`/api/v1/scans/${scan}/images/${shot.body.assetId}`).set(H);
    expect(gone.status).toBe(200);
    expect(gone.body.images).toHaveLength(0);
    expect(gone.body.readyToAnalyze).toBe(false);

    // Someone else's capture is not theirs to discard, even inside the same scope.
    const other = (await signup('discarder@packcomply.test', 'Other Officer')).agent;
    const second = await officer.post(`/api/v1/scans/${scan}/images`).set(H)
      .attach('file', png(`${scan}-kept`), { filename: 'back.png', contentType: 'image/png' })
      .field('side', 'back');
    const denied = await other.delete(`/api/v1/scans/${scan}/images/${second.body.assetId}`).set(H);
    expect(denied.status).toBeGreaterThanOrEqual(403);
    expect((await officer.get(`/api/v1/scans/${scan}`).set(H)).body.images).toHaveLength(1);
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

// What a killed worker leaves behind. runPendingJobs only ever selects 'queued', so
// a job the process died holding is invisible to every later worker, and GET /scans
// counts it as pending - which outranks an existing verdict. One orphaned row is
// enough to report 'analyzing' for the life of a scan whose verdict was written
// minutes earlier and is sitting in the database unread.
// An OCR outage must never be reported as a legal violation.
//
// Drawn from a real scan: five faces photographed, the OCR sidecar died after two,
// and the judge - shown the other three as simply carrying no text - returned
// "non_compliant, 0.95 confident, net quantity and manufacturer details missing".
// The face it never read held the ingredients and nutrition panel.
// A dependency being down is not the image's fault, and must not be paid for out of
// the image's retry budget. The Ching's Secret scan burned three attempts in about
// forty seconds against an OCR sidecar that needs tens of seconds just to load its
// models, and three faces of a package were dead-lettered for it.
// The judge must not overtake the OCR it is supposed to read.
//
// From a real scan: six faces, the recogniser down, every OCR job correctly waiting
// out its backoff - and the judge, which had no reason to wait, ran 50 seconds in
// and wrote "6 of 6 faces could not be read". The faces were all read four minutes
// later, perfectly, with nobody left to tell. Enqueue order had been doing this job,
// and enqueue order stops being execution order the moment a job can be rescheduled.
describe('the judge waits for the faces to be read', () => {
  it('defers instead of assessing a package whose text has not arrived', async () => {
    const db = getDb();
    const scan = (await officer.post('/api/v1/scans').set(H).send({ product: { brand: 'Overtake' } })).body.scanId;
    for (const side of ['front', 'back']) {
      await officer.post(`/api/v1/scans/${scan}/images`).set(H)
        .attach('file', png(`overtake-${side}`), { filename: `${side}.png`, contentType: 'image/png' })
        .field('side', side);
    }
    await officer.post(`/api/v1/scans/${scan}/analyze`).set(H);

    // One face is still being read - exactly the state a transient OCR failure
    // leaves behind while it waits out its backoff.
    const held = db.prepare(
      `SELECT id FROM processing_jobs WHERE type = 'process_evidence'
         AND target_id IN (SELECT id FROM evidence_assets WHERE inspection_id = ?) LIMIT 1`,
    ).get(scan) as { id: string };
    db.prepare("UPDATE processing_jobs SET status = 'queued', next_attempt_at = ? WHERE id = ?")
      .run(new Date(Date.now() + 60_000).toISOString(), held.id);

    await drainJobs(db);

    const judge = db.prepare(
      "SELECT status, attempts, error FROM processing_jobs WHERE type = 'judge_compliance' AND target_id = ?",
    ).get(scan) as any;
    expect(judge.status).toBe('queued');
    expect(judge.error).toMatch(/still being read/);
    // Deferring is not attempting: waiting must not spend the retry budget.
    expect(judge.attempts).toBe(0);
    // And no verdict was written about a package nobody had finished reading.
    expect((await officer.get(`/api/v1/scans/${scan}`).set(H)).body.verdict).toBeNull();

    // Once the face is read the judge runs and the scan completes normally. Both
    // waits are released here: the OCR job's backoff, and the three seconds the
    // judge had scheduled itself to ask again after.
    db.prepare("UPDATE processing_jobs SET next_attempt_at = NULL WHERE id = ?").run(held.id);
    await drainJobs(db);
    db.prepare(
      `UPDATE processing_jobs SET next_attempt_at = NULL
        WHERE target_id = ? AND status = 'queued'`,
    ).run(scan);
    await drainJobs(db);
    const done = await officer.get(`/api/v1/scans/${scan}`).set(H);
    expect(done.body.status).toBe('ready');
    expect(done.body.verdict).toBeTruthy();
    expect(done.body.verdict.summary).not.toMatch(/could not be read/);
  });
});

// The recheck is the capturing auditor's, and theirs alone: `evaluation.run` keeps
// both review roles out, and ownership keeps other auditors out.
describe('who may re-run an analysis', () => {
  it('refuses another auditor, and allows the one who captured it', async () => {
    const scan = (await officer.post('/api/v1/scans').set(H).send({ product: { brand: 'Mine' } })).body.scanId;
    await officer.post(`/api/v1/scans/${scan}/images`).set(H)
      .attach('file', png('mine-front'), { filename: 'front.png', contentType: 'image/png' })
      .field('side', 'front');
    await officer.post(`/api/v1/scans/${scan}/analyze`).set(H);
    await drainJobs(getDb());

    const other = (await signup('recheck-other@packcomply.test', 'Other Auditor')).agent;
    const denied = await other.post(`/api/v1/scans/${scan}/analyze`).set(H).send({ force: true });
    expect(denied.status).toBeGreaterThanOrEqual(403);

    const mine = await officer.post(`/api/v1/scans/${scan}/analyze`).set(H).send({ force: true });
    expect(mine.status).toBe(202);
  });
});

describe('backoff for a dependency that is down', () => {
  it('waits far longer for a transient failure than a real one', () => {
    // A job that failed on its own merits is retried briskly - waiting changes
    // nothing about a corrupt image.
    expect(backoffFor(1, false)).toBe(1_000);
    expect(backoffFor(2, false)).toBe(2_000);

    // A service that is down gets long enough to actually come back.
    expect(backoffFor(1, true)).toBe(15_000);
    expect(backoffFor(2, true)).toBe(30_000);
    expect(backoffFor(3, true)).toBe(60_000);
    expect(backoffFor(9, true)).toBe(60_000); // capped, not unbounded

    // The whole transient ladder has to outlast a sidecar restart. Under the old
    // behaviour the three attempts were spent inside about a second.
    const total = [1, 2, 3, 4, 5, 6, 7].reduce((n, a) => n + backoffFor(a, true), 0);
    expect(total).toBeGreaterThan(120_000);
  });

  it('marks an unreachable OCR service transient', () => {
    expect(isTransient(new TransientError('PaddleOCR service unavailable: ...'))).toBe(true);
    // A rejected image is the image's problem and stays a normal failure.
    expect(isTransient(new Error('PaddleOCR service rejected the image (HTTP 415)'))).toBe(false);
  });

  it('holds a backed-off job back from the worker, and releases it when asked again', async () => {
    const db = getDb();
    const scan = (await officer.post('/api/v1/scans').set(H).send({ product: { brand: 'Backoff' } })).body.scanId;
    await officer.post(`/api/v1/scans/${scan}/images`).set(H)
      .attach('file', png('backoff-front'), { filename: 'front.png', contentType: 'image/png' })
      .field('side', 'front');
    await officer.post(`/api/v1/scans/${scan}/analyze`).set(H);
    await drainJobs(db);

    const job = db.prepare(
      `SELECT id, idempotency_key FROM processing_jobs
        WHERE type = 'process_evidence'
          AND target_id IN (SELECT id FROM evidence_assets WHERE inspection_id = ?) LIMIT 1`,
    ).get(scan) as { id: string; idempotency_key: string };

    // A job queued but not yet due is invisible to the worker rather than spun on.
    const later = new Date(Date.now() + 60_000).toISOString();
    db.prepare("UPDATE processing_jobs SET status = 'queued', next_attempt_at = ? WHERE id = ?")
      .run(later, job.id);
    await drainJobs(db);
    expect((db.prepare('SELECT status FROM processing_jobs WHERE id = ?').get(job.id) as any).status)
      .toBe('queued');

    // Asking for the work again cancels the wait: someone who has just restarted
    // the service should not sit out a minute meant to spare a dead one.
    await officer.post(`/api/v1/scans/${scan}/analyze`).set(H).send({ force: true });
    expect((db.prepare('SELECT next_attempt_at FROM processing_jobs WHERE id = ?').get(job.id) as any)
      .next_attempt_at).toBeNull();
    await drainJobs(db);
    expect((db.prepare('SELECT status FROM processing_jobs WHERE id = ?').get(job.id) as any).status)
      .toBe('completed');
  });
});

// The officer was never told. progress.errors carried every dead-lettered OCR job,
// but it was only rendered on the "analysis did not complete" screen - so a scan
// that produced a verdict from two of five faces showed a confident result and no
// sign at all that the other three had been skipped.
describe('unread faces are visible to the officer', () => {
  it('reports per-image whether the recogniser actually read it', async () => {
    const db = getDb();
    const scan = (await officer.post('/api/v1/scans').set(H).send({ product: { brand: 'Unread' } })).body.scanId;
    for (const side of ['front', 'back']) {
      await officer.post(`/api/v1/scans/${scan}/images`).set(H)
        .attach('file', png(`unread-${side}`), { filename: `${side}.png`, contentType: 'image/png' })
        .field('side', side);
    }
    await officer.post(`/api/v1/scans/${scan}/analyze`).set(H);
    await drainJobs(db);

    const before = await officer.get(`/api/v1/scans/${scan}`).set(H);
    expect(before.body.images.every((i: any) => i.read)).toBe(true);

    // Now the Ching's Secret shape: one face dead-lettered by a service outage.
    const back = before.body.images.find((i: any) => i.side === 'back');
    db.prepare(
      "UPDATE processing_jobs SET status = 'dead_letter', error = ? WHERE type = 'process_evidence' AND target_id = ?",
    ).run('PaddleOCR service unavailable: could not reach the OCR service', back.id);

    const after = await officer.get(`/api/v1/scans/${scan}`).set(H);
    const faces = Object.fromEntries(after.body.images.map((i: any) => [i.side, i.read]));
    expect(faces).toEqual({ front: true, back: false });
    // The verdict still stands, so the screen shows it - which is exactly why the
    // unread face has to be reported alongside rather than instead of it.
    expect(after.body.status).toBe('ready');
    expect(after.body.progress.errors.join(' ')).toMatch(/service unavailable/);
  });
});

describe('absence withheld while a face is unread', () => {
  const check = (parameter: string, status: 'present' | 'missing' | 'unclear') => ({
    parameter, ruleReference: 'Rule 6(1)(c)', status, observedText: '', issue: 'Not found.', remedy: 'Declare it.',
  });
  const verdict = (overall: any, checks: any[], confidence = 0.95) => ({
    provider: 'gemini', modelVersion: 'test', isMock: false,
    overall, summary: 'Mandatory declarations absent.', confidence, checks,
  });
  const chings = [
    { faceLabel: 'front', read: true },
    { faceLabel: 'back', read: true },
    { faceLabel: 'top', read: false },
    { faceLabel: 'bottom', read: false },
    { faceLabel: 'left', read: false },
  ];

  it('turns missing into unclear and non_compliant into needs_review', () => {
    const out = withholdAbsenceOnUnreadFaces(
      verdict('non_compliant', [check('Net quantity', 'missing'), check('Manufacturer', 'missing')]),
      chings,
    );
    expect(out.overall).toBe('needs_review');
    expect(out.checks.every((c) => c.status === 'unclear')).toBe(true);
    expect(out.checks[0].issue).toMatch(/never read/);
    expect(out.summary).toMatch(/^3 of 5 photographed faces \(top, bottom, left\) could not be read/);
    // "Reading confidence" cannot stay at 0.95 when three fifths of the label was
    // never read: it is scaled by the share that was.
    expect(out.confidence).toBe(0.38);
  });

  it('leaves a defect that was actually read standing', () => {
    // Non-compliance resting on something observed, not on an absence, survives:
    // an unread face cannot excuse a declaration that was read and is wrong.
    const out = withholdAbsenceOnUnreadFaces(
      verdict('non_compliant', [{ ...check('Net quantity', 'present'), issue: 'Printed smaller than Rule 9 allows.' }]),
      chings,
    );
    expect(out.overall).toBe('non_compliant');
    expect(out.checks[0].status).toBe('present');
  });

  it('changes nothing when every face was read', () => {
    const all = [{ faceLabel: 'front', read: true }, { faceLabel: 'back', read: true }];
    const given = verdict('non_compliant', [check('Net quantity', 'missing')]);
    const out = withholdAbsenceOnUnreadFaces(given, all);
    expect(out).toEqual(given);
    expect(out.overall).toBe('non_compliant');
    expect(out.confidence).toBe(0.95);
  });

  it('does not promote a compliant verdict, which unread faces cannot undermine', () => {
    // Every mandatory declaration found on the faces that were read is still found,
    // whatever the unread ones say - so the outcome stands, with the caveat added.
    const out = withholdAbsenceOnUnreadFaces(verdict('compliant', [check('Net quantity', 'present')]), chings);
    expect(out.overall).toBe('compliant');
    expect(out.summary).toMatch(/could not be read/);
  });
});

describe('jobs interrupted by a dying worker', () => {
  const ocrJobOf = (scan: string) => getDb().prepare(
    `SELECT id FROM processing_jobs
      WHERE type = 'process_evidence'
        AND target_id IN (SELECT id FROM evidence_assets WHERE inspection_id = ?)
      LIMIT 1`,
  ).get(scan) as { id: string };

  const analysedScan = async (brand: string) => {
    const scan = (await officer.post('/api/v1/scans').set(H).send({ product: { brand } })).body.scanId;
    await officer.post(`/api/v1/scans/${scan}/images`).set(H)
      .attach('file', png(`${brand}-front`), { filename: 'front.png', contentType: 'image/png' })
      .field('side', 'front');
    await officer.post(`/api/v1/scans/${scan}/analyze`).set(H);
    await drainJobs(getDb());
    return scan;
  };

  it('requeues the orphan, and the scan reports its verdict again', async () => {
    const db = getDb();
    const scan = await analysedScan('Interrupted Butter');
    expect((await officer.get(`/api/v1/scans/${scan}`).set(H)).body.status).toBe('ready');

    // Exactly the row a killed process leaves: 'processing', one attempt spent,
    // no error, and nothing anywhere still running it.
    const job = ocrJobOf(scan);
    db.prepare("UPDATE processing_jobs SET status = 'processing', attempts = 1, progress = 10, error = NULL WHERE id = ?")
      .run(job.id);
    const stuck = await officer.get(`/api/v1/scans/${scan}`).set(H);
    expect(stuck.body.status).toBe('analyzing');
    expect(stuck.body.verdict).toBeTruthy(); // the verdict was there all along

    expect(reclaimStaleJobs(db)).toBe(1);
    const back = db.prepare('SELECT status, attempts, error FROM processing_jobs WHERE id = ?')
      .get(job.id) as any;
    expect(back.status).toBe('queued');
    expect(back.attempts).toBe(1); // the attempt was spent; it is not charged twice
    expect(back.error).toMatch(/Interrupted/);

    await drainJobs(db);
    expect((await officer.get(`/api/v1/scans/${scan}`).set(H)).body.status).toBe('ready');
  });

  it('dead-letters a job that has already spent its attempts', async () => {
    const db = getDb();
    const scan = await analysedScan('Poison Butter');
    const job = ocrJobOf(scan);
    // A handler that kills the process never reaches the catch in runJob, so it
    // never dead-letters itself. Without this check the same image would be picked
    // up and crash the server again on every boot, for ever.
    db.prepare("UPDATE processing_jobs SET status = 'processing', attempts = 3, progress = 10 WHERE id = ?")
      .run(job.id);

    expect(reclaimStaleJobs(db)).toBe(1);
    const parked = db.prepare('SELECT status FROM processing_jobs WHERE id = ?').get(job.id) as any;
    expect(parked.status).toBe('dead_letter');

    // Parked, not pending: the scan stops claiming work is in flight and shows the
    // verdict it already has.
    expect((await officer.get(`/api/v1/scans/${scan}`).set(H)).body.status).toBe('ready');
  });

  it('leaves a healthy queue alone', () => {
    expect(reclaimStaleJobs(getDb())).toBe(0);
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
    // Mirror the real flow: a scan reaches a reviewer only once its auditor sends it.
    await agent.post(`/api/v1/scans/${scanId}/submit`).set(H);
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

  it('lets an admin refer a case up, and only a super administrator can clear it', async () => {
    const scanId = await analysedScan(demoOfficer, 'Referred Case');

    const up = await reviewer.post(`/api/v1/scans/${scanId}/review`).set(H)
      .send({ decision: 'escalated', reason: 'The importer declaration is ambiguous; this needs your authority.' });
    expect(up.status).toBe(201);
    expect(up.body.decision).toBe('escalated');
    expect(up.body.awaitingSuperAdmin).toBe(true);

    // Having handed the case over, the admin cannot quietly decide it anyway —
    // otherwise referring it upward would mean nothing.
    const retry = await reviewer.post(`/api/v1/scans/${scanId}/review`).set(H)
      .send({ decision: 'accepted', reason: 'Changed my mind after referring it upward.' });
    expect(retry.status).toBe(403);
    expect(retry.body.error.message).toMatch(/referred/i);

    // It reaches the super administrator with who raised it and why.
    const { agent: sa } = await signIn('superadmin@demo.gov.example');
    const att = await sa.get('/api/v1/performance/attention').set(H);
    const row = att.body.cases.find((c: any) => c.scanId === scanId);
    expect(row).toBeTruthy();
    expect(row.escalatedBy).toMatch(/Rohan/);
    expect(row.escalationReason).toMatch(/ambiguous/i);

    // Their decision clears it, outranks the admin, and takes it off the list.
    const cleared = await sa.post(`/api/v1/scans/${scanId}/review`).set(H)
      .send({ decision: 'rejected', reason: 'Reviewed the importer question; the declaration is defective.' });
    expect(cleared.status).toBe(201);
    expect(cleared.body.final).toBe(true);
    const after = await sa.get('/api/v1/performance/attention').set(H);
    expect(after.body.cases.some((c: any) => c.scanId === scanId)).toBe(false);
  });

  it('has nobody above a super administrator to refer a case to', async () => {
    const scanId = await analysedScan(demoOfficer, 'No Higher Authority');
    const { agent: sa } = await signIn('superadmin@demo.gov.example');
    const res = await sa.post(`/api/v1/scans/${scanId}/review`).set(H)
      .send({ decision: 'escalated', reason: 'There is nobody above me to refer this to.' });
    expect(res.status).toBe(400);
  });

  it('allows only one admin per team', async () => {
    const { agent: sa } = await signIn('superadmin@demo.gov.example');
    const team = await sa.post('/api/v1/teams').set(H).send({ name: `Solo Team ${Date.now()}` });
    expect(team.status).toBe(201);

    const users = (await sa.get('/api/v1/admin/users').set(H)).body.users;
    const pune = users.find((u: any) => u.email === 'admin@demo.gov.example');
    const blr = users.find((u: any) => u.email === 'admin.ka@demo.gov.example');
    const puneHome = pune.team_id;

    expect((await sa.post(`/api/v1/teams/${team.body.id}/members`).set(H)
      .send({ userId: pune.id })).status).toBe(200);

    const second = await sa.post(`/api/v1/teams/${team.body.id}/members`).set(H)
      .send({ userId: blr.id });
    expect(second.status).toBe(409);
    expect(second.body.error.message).toMatch(/one admin/i);

    // Put the reviewer back so the rest of the suite sees the seeded arrangement.
    expect((await sa.post(`/api/v1/teams/${puneHome}/members`).set(H)
      .send({ userId: pune.id })).status).toBe(200);
  });

  it('keeps a scan out of the review queue until the auditor sends it', async () => {
    const scanId = (await demoOfficer.post('/api/v1/scans').set(H).send({ product: { brand: 'Unsent' } })).body.scanId;
    await demoOfficer.post(`/api/v1/scans/${scanId}/images`).set(H)
      .attach('file', png('unsent-top'), { filename: 'top.png', contentType: 'image/png' })
      .field('side', 'top');

    // Nothing to send before it has been analysed.
    const early = await demoOfficer.post(`/api/v1/scans/${scanId}/submit`).set(H);
    expect(early.status).toBe(422);

    await demoOfficer.post(`/api/v1/scans/${scanId}/analyze`).set(H);
    await drainJobs(getDb());

    // Analysis finishing is the machine being done, not the auditor.
    const beforeSend = await reviewer.get('/api/v1/scans?limit=200').set(H);
    expect(beforeSend.body.scans.find((s: any) => s.scanId === scanId).submittedAt).toBeNull();

    // Only the auditor who captured it can hand it over.
    expect((await reviewer.post(`/api/v1/scans/${scanId}/submit`).set(H)).status).toBe(403);

    const sent = await demoOfficer.post(`/api/v1/scans/${scanId}/submit`).set(H);
    expect(sent.status).toBe(200);
    expect(sent.body.submittedAt).toBeTruthy();

    const afterSend = await reviewer.get('/api/v1/scans?limit=200').set(H);
    expect(afterSend.body.scans.find((s: any) => s.scanId === scanId).submittedAt).toBeTruthy();
  });

  it('leaves a super administrator’s send-back open for the admin and the auditor', async () => {
    const scanId = await analysedScan(demoOfficer, 'Send Back Case');
    const { agent: sa } = await signIn('superadmin@demo.gov.example');

    const back = await sa.post(`/api/v1/scans/${scanId}/review`).set(H)
      .send({ decision: 'recapture_requested', reason: 'The back face is unreadable; photograph it again.' });
    expect(back.status).toBe(201);
    // Sending a package back is an instruction to go and re-photograph it, so the
    // work continues — locking it would strand the case with nobody able to move it.
    expect(back.body.final).toBe(false);

    const adminActs = await reviewer.post(`/api/v1/scans/${scanId}/review`).set(H)
      .send({ decision: 'accepted', reason: 'Re-read the close-up; the declaration is legible after all.' });
    expect(adminActs.status).toBe(201);
  });

  it('refuses a sign-off on a scan that has never been analysed', async () => {
    const empty = (await demoOfficer.post('/api/v1/scans').set(H).send({})).body.scanId;
    const res = await reviewer.post(`/api/v1/scans/${empty}/review`).set(H)
      .send({ decision: 'accepted', reason: 'There is nothing here to accept.' });
    expect(res.status).toBe(422);
  });
});
