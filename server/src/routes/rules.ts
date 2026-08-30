import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import {
  listRuleSets, listRuleVersions, getRuleVersion, createDraft, updateDraft,
  submitVersion, approveVersion, publishVersion, retireVersion, rollbackToVersion,
  runTestPack, compareVersions, addRuleTest, listRuleSources,
} from '../modules/rules/service.js';

export const rulesRouter = Router();

rulesRouter.get('/rules/sets', requireAuth, requirePerm('rule.read'), (_req, res) => {
  res.json({ ruleSets: listRuleSets(getDb()) });
});

rulesRouter.get('/rules/sources', requireAuth, requirePerm('rule.read'), (_req, res) => {
  res.json({ sources: listRuleSources(getDb()) });
});

rulesRouter.get('/rules/versions', requireAuth, requirePerm('rule.read'), (req, res) => {
  const q = req.query as Record<string, string>;
  res.json({ versions: listRuleVersions(getDb(), { ruleKey: q.ruleKey, status: q.status }) });
});

rulesRouter.get('/rules/versions/:id', requireAuth, requirePerm('rule.read'), (req, res) => {
  res.json(getRuleVersion(getDb(), req.params.id));
});

const draftSchema = z.object({
  ruleSetId: z.string(), ruleKey: z.string().min(3), title: z.string().min(3),
  citation: z.string().min(3), sourceId: z.string().optional(), jurisdiction: z.string().optional(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), effectiveTo: z.string().optional(),
  applicability: z.record(z.unknown()), inputs: z.record(z.unknown()),
  logic: z.object({ checks: z.array(z.record(z.unknown())).min(1) }),
  outcome: z.record(z.unknown()), legalStatus: z.enum(['APPROVED', 'REQUIRES_LEGAL_APPROVAL']).optional(),
  changeNote: z.string().optional(),
});

rulesRouter.post('/rules/versions', requireAuth, requirePerm('rule.draft'), validateBody(draftSchema), (req, res) => {
  res.status(201).json(createDraft(getDb(), req.user!, req.body as any));
});

rulesRouter.patch('/rules/versions/:id', requireAuth, requirePerm('rule.draft'), (req, res) => {
  res.json(updateDraft(getDb(), req.user!, req.params.id, req.body));
});

rulesRouter.post('/rules/versions/:id/submit', requireAuth, requirePerm('rule.submit'), (req, res) => {
  res.json(submitVersion(getDb(), req.user!, req.params.id));
});
rulesRouter.post('/rules/versions/:id/approve', requireAuth, requirePerm('rule.approve'), (req, res) => {
  res.json(approveVersion(getDb(), req.user!, req.params.id));
});
rulesRouter.post('/rules/versions/:id/publish', requireAuth, requirePerm('rule.publish'), (req, res) => {
  res.json(publishVersion(getDb(), req.user!, req.params.id));
});
rulesRouter.post('/rules/versions/:id/retire', requireAuth, requirePerm('rule.publish'), (req, res) => {
  res.json(retireVersion(getDb(), req.user!, req.params.id));
});
rulesRouter.post('/rules/versions/:id/rollback', requireAuth, requirePerm('rule.rollback'), (req, res) => {
  res.json(rollbackToVersion(getDb(), req.user!, req.params.id));
});

rulesRouter.post('/rules/versions/:id/test', requireAuth, requirePerm('rule.test'), (req, res) => {
  const rv = getRuleVersion(getDb(), req.params.id);
  res.json(runTestPack(getDb(), rv.ruleKey, req.params.id));
});

rulesRouter.get('/rules/compare', requireAuth, requirePerm('rule.read'), (req, res) => {
  const q = req.query as Record<string, string>;
  res.json(compareVersions(getDb(), q.ruleKey, q.versionA, q.versionB));
});

rulesRouter.post(
  '/rules/tests',
  requireAuth, requirePerm('rule.test'),
  validateBody(z.object({
    ruleKey: z.string(), name: z.string(), fixture: z.record(z.unknown()),
    expectedOutcome: z.enum(['passed', 'failed', 'needs_review', 'not_applicable', 'not_assessable']),
  })),
  (req, res) => {
    res.status(201).json({ testId: addRuleTest(getDb(), req.user!, req.body as any) });
  },
);
