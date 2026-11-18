import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { aiService } from '../../integrations/aiService';
import { audit } from '../../lib/audit';
import { annotate } from '../../lib/tracing';
import { AppError, conflict, notFound } from '../../lib/errors';
import { env } from '../../config/env';
import { paged, paginate, param } from '../../lib/http';
import { prisma } from '../../lib/prisma';
import { assertVisitorQuota, visibleInvestigations } from '../../lib/demo';
import { authOf, can, requirePermission } from '../../middleware/auth';
import { enqueueInvestigation } from './runner';
import { addIncidentEvent, incidentKey, requireIncident } from '../incidents';
import { assertWithinLimits, organizationLimits, usageToday } from './limits';
import { createBody, listQuery } from './validation';
import { applyViews, legacyViews, presentDetail } from './legacy';

/** HTTP routes under /api/v1/investigations. Starting one only queues it; the worker runs it. */
/**
 * The public demonstration analyses with the rule-based engine only. If the analysis service is
 * configured with a model (or cannot be asked), no investigation starts: nothing is billed and no
 * output is presented as something it is not.
 */
async function assertDemoEngine() {
  if (!env.PUBLIC_DEMO_MODE) return;
  let provider: string;
  try {
    provider = (await aiService.status()).llm.provider;
  } catch {
    throw new AppError(503, 'demo_engine_unavailable', 'The demo analysis engine is not available right now. Try again in a minute.');
  }
  if (provider !== 'heuristic') throw new AppError(503, 'demo_engine_unavailable', 'The public demo runs the rule-based engine only, and the analysis service is configured otherwise. No investigation was started.');
}

export const investigationsRouter = Router();

const listSelect = {
  id: true,
  question: true,
  status: true,
  provider: true,
  model: true,
  analysisMode: true,
  attemptedProvider: true,
  estimatedCostUsd: true,
  summary: true,
  confidence: true,
  outcome: true,
  error: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  createdById: true,
  incident: { select: { id: true, number: true, title: true, severity: true } },
  _count: { select: { evidence: true, hypotheses: true, steps: true } },
} satisfies Prisma.InvestigationSelect;

investigationsRouter.get('/', requirePermission('read'), async (req, res) => {
  const auth = authOf(req);
  const { organizationId } = auth;
  const q = listQuery.parse(req.query);
  const where: Prisma.InvestigationWhereInput = { AND: [{ organizationId, ...(q.status ? { status: { in: q.status } } : {}), ...(q.incidentId ? { incidentId: q.incidentId } : {}) }, visibleInvestigations(auth)] };
  const [rows, total] = await Promise.all([
    prisma.investigation.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(q), select: listSelect }),
    prisma.investigation.count({ where }),
  ]);
  res.json(paged(applyViews(rows, await legacyViews(organizationId, rows.map((r) => r.id))), total, q));
});

/** Which model will run the next investigation; shown in the workspace before submitting. */
investigationsRouter.get('/ai-status', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  // ?verify=true asks the provider to confirm the key and model (a free metadata lookup).
  const verify = req.query.verify === 'true' && can(authOf(req), 'investigation:run');
  const usage = await usageToday(organizationId);
  const limits = organizationLimits();
  try {
    res.json({ reachable: true, ...(await aiService.status(verify)), usageToday: usage, organizationLimits: limits });
  } catch (err) {
    res.json({ reachable: false, detail: authOf(req).demoVisitor ? 'The analysis service is not reachable.' : (err as Error).message, usageToday: usage, organizationLimits: limits });
  }
});

investigationsRouter.post('/', requirePermission('investigation:run'), async (req, res) => {
  const auth = authOf(req);
  const body = createBody.parse(req.body);
  await assertDemoEngine();
  const incident = body.incidentId ? await requireIncident(auth.organizationId, body.incidentId) : null;
  const investigation = await prisma.$transaction(async (tx) => {
    // One start at a time per organisation, so parallel requests cannot all pass the limits.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'investigation-start:' + auth.organizationId}))`;
    await assertWithinLimits(auth.organizationId, tx);
    if (auth.demoVisitor) await assertVisitorQuota(tx, auth, req.ip);
    return tx.investigation.create({
      data: {
        organizationId: auth.organizationId,
        incidentId: incident?.id,
        question: body.question,
        timeWindowStart: body.timeWindow?.from,
        timeWindowEnd: body.timeWindow?.to,
        createdById: auth.userId,
        // A visitor's run belongs to its session, and only that session sees it (lib/demo.ts).
        demoSessionId: auth.demoVisitor ? auth.demoSession : null,
      },
      select: listSelect,
    });
  });
  await audit(req, 'investigation.start', 'investigation', investigation.id, { incident: incident ? incidentKey(incident.number) : null });
  // A visitor's question is never written where other visitors can read it, such as the incident timeline.
  if (incident && !auth.demoVisitor) await addIncidentEvent(incident.id, 'investigation', `AI investigation started: "${body.question.slice(0, 200)}"`, auth, { investigationId: investigation.id });
  annotate({ 'opsilume.investigation.id': investigation.id });
  try {
    await enqueueInvestigation(investigation.id);
  } catch (err) {
    // Never leave a row that looks queued when nothing will ever pick it up.
    await prisma.investigation.update({ where: { id: investigation.id }, data: { status: 'FAILED', error: (err as Error).message, completedAt: new Date() } });
    throw err;
  }
  res.status(202).json(await prisma.investigation.findUnique({ where: { id: investigation.id }, select: listSelect }));
});

investigationsRouter.get('/:id', requirePermission('read'), async (req, res) => {
  const auth = authOf(req);
  const investigation = await prisma.investigation.findFirst({
    where: { AND: [{ id: param(req.params.id), organizationId: auth.organizationId }, visibleInvestigations(auth)] },
    include: {
      incident: { select: { id: true, number: true, title: true, severity: true, status: true } },
      steps: { orderBy: { index: 'asc' } },
      evidence: { orderBy: { createdAt: 'asc' } },
      hypotheses: { orderBy: { rank: 'asc' } },
      remediations: { orderBy: { createdAt: 'asc' }, select: { id: true, title: true, type: true, risk: true, status: true, effect: true } },
    },
  });
  if (!investigation) throw notFound('Investigation');
  const creator = investigation.createdById ? await prisma.user.findUnique({ where: { id: investigation.createdById }, select: { id: true, name: true } }) : null;
  // Which visitor session started a run is internal: it is never returned.
  const { demoSessionId: _session, ...shown } = investigation;
  res.json({ ...presentDetail(shown), createdBy: creator });
});

investigationsRouter.post('/:id/cancel', requirePermission('investigation:run'), async (req, res) => {
  const auth = authOf(req);
  // A visitor cancels only what its own session started; every visitor is the same account.
  if (auth.demoVisitor && !auth.demoSession) throw notFound('Investigation');
  const updated = await prisma.investigation.updateMany({
    where: { id: param(req.params.id), organizationId: auth.organizationId, status: { in: ['QUEUED', 'RUNNING'] }, ...(auth.demoVisitor ? { demoSessionId: auth.demoSession } : {}) },
    data: { status: 'CANCELLED', completedAt: new Date() },
  });
  if (!updated.count) throw conflict('Only queued or running investigations can be cancelled');
  await audit(req, 'investigation.cancel', 'investigation', param(req.params.id));
  res.json({ id: param(req.params.id), status: 'CANCELLED' });
});
