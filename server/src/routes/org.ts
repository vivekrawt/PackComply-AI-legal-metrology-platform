import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { forbidden } from '../core/errors.js';
import {
  assignUserToTeam, createTeam, getTeam, listTeams, teamMembers, updateTeam,
} from '../modules/teams/service.js';
import {
  adminDetail, adminPerformance, attentionCases, auditorDetail, auditorPerformance,
  orgOverview, teamDetail, teamPerformance,
} from '../modules/analytics/performance.js';

export const orgRouter = Router();

// Organization structure and performance.
//
// Two audiences with deliberately different reach:
//   super_admin  the whole organization — every team, every admin, every auditor.
//   admin        its own team only, which is the same boundary its review queue
//                already enforces. The scoping is applied here as well as in
//                scopeWhere(), because these endpoints read the people tables
//                rather than the inspections table.
//
// Endpoints that expose the organization as a whole are gated on 'admin.users',
// which only super_admin holds — rather than on a role name, so the matrix stays
// the single source of authority.

// ---- Teams ------------------------------------------------------------------
orgRouter.get('/teams', requireAuth, requirePerm('team.read'), (req, res) => {
  res.json({ teams: listTeams(getDb(), req.user!) });
});

orgRouter.post(
  '/teams',
  requireAuth, requirePerm('team.manage'),
  validateBody(z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(600).optional(),
  })),
  (req, res) => {
    res.status(201).json(createTeam(getDb(), req.user!, req.body, req.correlationId));
  },
);

orgRouter.get('/teams/:id', requireAuth, requirePerm('team.read'), (req, res) => {
  const db = getDb();
  const team = getTeam(db, req.user!, req.params.id);
  res.json({ team, members: teamMembers(db, req.user!.orgId, req.params.id) });
});

orgRouter.patch(
  '/teams/:id',
  requireAuth, requirePerm('team.manage'),
  validateBody(z.object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(600).nullable().optional(),
    status: z.enum(['active', 'archived']).optional(),
  })),
  (req, res) => {
    res.json(updateTeam(getDb(), req.user!, req.params.id, req.body, req.correlationId));
  },
);

orgRouter.post(
  '/teams/:id/members',
  requireAuth, requirePerm('team.manage'),
  validateBody(z.object({ userId: z.string().min(1) })),
  (req, res) => {
    res.json(assignUserToTeam(
      getDb(), req.user!, req.body.userId, req.params.id, req.correlationId,
    ));
  },
);

// Removing someone from a team leaves them unassigned: their work then reaches no
// admin queue, which is why the super administrator is the only role that can do it.
orgRouter.delete('/teams/:id/members/:userId', requireAuth, requirePerm('team.manage'), (req, res) => {
  res.json(assignUserToTeam(getDb(), req.user!, req.params.userId, null, req.correlationId));
});

// ---- Performance ------------------------------------------------------------
// Org-wide: super administrator only.
orgRouter.get('/performance/overview', requireAuth, requirePerm('admin.users'), (req, res) => {
  res.json(orgOverview(getDb(), req.user!.orgId));
});

orgRouter.get('/performance/attention', requireAuth, requirePerm('admin.users'), (req, res) => {
  res.json({ cases: attentionCases(getDb(), req.user!.orgId) });
});

orgRouter.get('/performance/admins', requireAuth, requirePerm('admin.users'), (req, res) => {
  res.json({ admins: adminPerformance(getDb(), req.user!.orgId) });
});

orgRouter.get('/performance/admins/:id', requireAuth, requirePerm('admin.users'), (req, res) => {
  res.json(adminDetail(getDb(), req.user!.orgId, req.params.id));
});

// Team-aware: an admin sees its own team and the auditors in it; a super
// administrator sees all of them.
orgRouter.get('/performance/teams', requireAuth, requirePerm('team.read'), (req, res) => {
  const all = teamPerformance(getDb(), req.user!.orgId);
  const teams = req.user!.role === 'admin'
    ? all.filter((t) => t.id === req.user!.teamId)
    : all;
  res.json({ teams });
});

orgRouter.get('/performance/teams/:id', requireAuth, requirePerm('team.read'), (req, res) => {
  if (req.user!.role === 'admin' && req.user!.teamId !== req.params.id) {
    throw forbidden('You can only view your own team');
  }
  res.json(teamDetail(getDb(), req.user!.orgId, req.params.id));
});

orgRouter.get('/performance/auditors', requireAuth, requirePerm('team.read'), (req, res) => {
  const all = auditorPerformance(getDb(), req.user!.orgId);
  const auditors = req.user!.role === 'admin'
    ? all.filter((a) => a.teamId === req.user!.teamId)
    : all;
  res.json({ auditors });
});

orgRouter.get('/performance/auditors/:id', requireAuth, requirePerm('team.read'), (req, res) => {
  const detail = auditorDetail(getDb(), req.user!.orgId, req.params.id);
  if (req.user!.role === 'admin' && detail.person.teamId !== req.user!.teamId) {
    throw forbidden('That auditor is not on your team');
  }
  res.json(detail);
});
