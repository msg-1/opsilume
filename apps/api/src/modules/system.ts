import { Router } from 'express';
import { aiService } from '../integrations/aiService';
import { env } from '../config/env';
import { auditIn } from '../lib/audit';
import { purgeExpiredIdempotencyKeys } from '../lib/idempotency';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { requirePermission } from '../middleware/auth';
import { enqueue, queueStats, redisPing, registerProcessor } from '../queues';
import { addIncidentEvent } from './incidents';
import { markInterrupted } from './investigations/persistence';
import { enqueueInvestigation } from './investigations/runner';
import { evaluateAlerts } from './monitoring';

// ───────────────────────── Scheduled jobs ─────────────────────────

registerProcessor('alert-eval', async () => {
  await evaluateAlerts();
  // The same once-a-minute tick sweeps up work stranded by a worker that died mid-job.
  await reapStranded();
});

// Longer than any job can legitimately take (the AI call itself times out after INVESTIGATION_TIMEOUT_MS).
const STALE = { runningInvestigation: env.INVESTIGATION_TIMEOUT_MS + 5 * 60_000, queuedInvestigation: 60 * 60_000, orphanedInvestigation: 2 * 60_000, executingRemediation: env.REMEDIATION_EXECUTION_STALE_MINUTES * 60_000, indexingDocument: 10 * 60_000 };

/**
 * A job that dies with its process leaves its row in an in-progress state that no retry will
 * ever revisit. This finds such rows and moves them to an honest terminal (or retryable) state.
 */
export async function reapStranded(now = new Date()) {
  const before = (ms: number) => new Date(now.getTime() - ms);
  const investigations = await prisma.investigation.findMany({
    where: { OR: [{ status: 'RUNNING', startedAt: { lt: before(STALE.runningInvestigation) } }, { status: 'QUEUED', createdAt: { lt: before(STALE.queuedInvestigation) } }] },
    select: { id: true },
  });
  for (const inv of investigations) await markInterrupted(inv.id, now);

  // An investigation that has waited for minutes may have lost its job (Redis lost its data).
  // Its job is put on the queue again under the same id: if the job is still there this adds
  // nothing, and since the investigation never started, running it now runs it once.
  const waiting = await prisma.investigation.findMany({
    where: { status: 'QUEUED', createdAt: { lt: before(STALE.orphanedInvestigation), gte: before(STALE.queuedInvestigation) } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  for (const inv of waiting) await enqueueInvestigation(inv.id).catch(() => undefined);

  // An execution whose process stopped: the request may or may not have been sent, and may or may
  // not have been applied. Its outcome is recorded as unknown for a person to reconcile; it is
  // never assumed to have failed and never sent again by itself (remediation/routes.ts, reconcile).
  const unknown = 'Execution was interrupted and its outcome is unknown. A person must check the target system and record what happened before it can be retried: the change may or may not have been applied.';
  const actions = await prisma.remediationAction.findMany({ where: { status: 'EXECUTING', updatedAt: { lt: before(STALE.executingRemediation) } }, select: { id: true, organizationId: true, incidentId: true, title: true, attempts: true, contentHash: true, updatedAt: true } });
  for (const action of actions) {
    // Only this attempt, only while still in progress: two workers sweeping at once record it once.
    const record = { mode: 'unknown', success: false, outcome: 'unknown', summary: unknown, interrupted: true, attempt: action.attempts, contentHash: action.contentHash, startedAt: action.updatedAt.toISOString(), idempotencyKey: action.id };
    // The state change and its audit row commit together. If the audit cannot be written, the action
    // stays EXECUTING and the next sweep tries again; the other actions are still swept now.
    const claimed = await prisma
      .$transaction(async (tx) => {
        const done = await tx.remediationAction.updateMany({ where: { id: action.id, status: 'EXECUTING', attempts: action.attempts, updatedAt: action.updatedAt }, data: { status: 'FAILED', executedAt: now, executionResult: record } });
        if (done.count) await auditIn(tx, { organizationId: action.organizationId, actorType: 'system', actorLabel: 'OPSILUME worker', action: 'remediation.execute_interrupted', resourceType: 'remediation_action', resourceId: action.id, metadata: { attempt: action.attempts, contentHash: action.contentHash, startedAt: action.updatedAt.toISOString(), staleMinutes: env.REMEDIATION_EXECUTION_STALE_MINUTES } });
        return done.count;
      })
      .catch((err) => (logger.error({ err, actionId: action.id }, 'could not record an interrupted execution; retried on the next sweep'), 0));
    if (!claimed) continue;
    if (action.incidentId) await addIncidentEvent(action.incidentId, 'remediation', `Remediation outcome unknown: ${action.title} — ${unknown}`, { kind: 'system', label: 'OPSILUME worker' }, { actionId: action.id });
  }

  const documents = await prisma.knowledgeDocument.findMany({ where: { indexStatus: 'indexing', updatedAt: { lt: before(STALE.indexingDocument) } }, select: { id: true } });
  for (const doc of documents) {
    await prisma.knowledgeDocument.update({ where: { id: doc.id }, data: { indexStatus: 'pending' } });
    await enqueue('knowledge-index', { documentId: doc.id }).catch(() => undefined);
  }

  const result = { investigations: investigations.length, remediations: actions.length, documents: documents.length };
  if (result.investigations || result.remediations || result.documents) logger.warn(result, 'recovered stranded work');
  return result;
}

/** Deletes logs and metric samples older than each organisation's retention period. */
export async function applyRetention() {
  const orgs = await prisma.organization.findMany({ select: { id: true, settings: { select: { logRetentionDays: true } } } });
  let logs = 0;
  let metrics = 0;
  for (const org of orgs) {
    const cutoff = new Date(Date.now() - (org.settings?.logRetentionDays ?? 30) * 86_400_000);
    logs += (await prisma.logEntry.deleteMany({ where: { organizationId: org.id, timestamp: { lt: cutoff } } })).count;
    metrics += (await prisma.metricSample.deleteMany({ where: { organizationId: org.id, timestamp: { lt: cutoff } } })).count;
  }
  await prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  await purgeExpiredIdempotencyKeys();
  if (logs || metrics) logger.info({ logs, metrics }, 'retention applied');
  return { logs, metrics };
}

registerProcessor('log-retention', async () => {
  await applyRetention();
});

// ───────────────────────── Health & status ─────────────────────────

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'opsilume-api', time: new Date().toISOString() });
});

healthRouter.get('/ready', async (_req, res) => {
  const [database, redis] = await Promise.all([
    prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
    redisPing(),
  ]);
  res.status(database && redis ? 200 : 503).json({ status: database && redis ? 'ready' : 'not_ready', database, redis });
});

export const systemRouter = Router();

systemRouter.get('/status', requirePermission('read'), async (_req, res) => {
  const [database, redis, queues, ai] = await Promise.all([
    prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
    redisPing(),
    queueStats().catch(() => []),
    aiService.status().then((s) => ({ reachable: true as const, ...s })).catch((err: Error) => ({ reachable: false as const, detail: err.message })),
  ]);
  res.json({ database, redis, queues, ai });
});
