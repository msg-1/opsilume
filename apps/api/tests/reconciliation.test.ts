import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// An execution whose process stops, and what happens next: the worker records the outcome as
// unknown, a person checks the target system and records what happened, and only then can it be
// retried. Process deaths are simulated by making the execution or the recording step throw;
// the webhook is a local stand-in. Nothing is ever sent anywhere else.

const crash = vi.hoisted(() => ({ afterSend: false, beforePersist: false }));
vi.mock('../src/modules/remediation/execution', async (original) => {
  const actual = await original<typeof import('../src/modules/remediation/execution')>();
  return {
    ...actual,
    execute: async (...args: Parameters<typeof actual.execute>) => {
      const result = await actual.execute(...args);
      // The request went out; the process stopped before it could record the response.
      if (crash.afterSend) throw new Error('process stopped after sending');
      return result;
    },
  };
});
vi.mock('../src/modules/remediation/recording', async (original) => {
  const actual = await original<typeof import('../src/modules/remediation/recording')>();
  return {
    ...actual,
    recordOutcome: async (...args: Parameters<typeof actual.recordOutcome>) => {
      // The response came back; the process stopped before the outcome was stored.
      if (crash.beforePersist) throw new Error('process stopped before persisting');
      return actual.recordOutcome(...args);
    },
  };
});

import { env } from '../src/config/env';
import { netConfig } from '../src/lib/netguard';
import { reapStranded } from '../src/modules/system';
import { createOrg, createService, prisma } from './helpers';

type Org = Awaited<ReturnType<typeof createOrg>>;

let hook: Server;
let received: { attempt: number; key: string }[] = [];
let respond: { status: number; delayMs: number; before?: () => Promise<void> } = { status: 200, delayMs: 0 };

beforeAll(async () => {
  netConfig.allowPrivate = true;
  hook = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const parsed = JSON.parse(body) as { attempt: number; idempotencyKey: string };
      received.push({ attempt: parsed.attempt, key: parsed.idempotencyKey });
      if (respond.before) await respond.before();
      setTimeout(() => res.writeHead(respond.status).end('{}'), respond.delayMs);
    });
  });
  await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
});
afterAll(async () => {
  netConfig.allowPrivate = false;
  await new Promise((resolve) => hook.close(resolve));
});
beforeEach(() => {
  received = [];
  respond = { status: 200, delayMs: 0 };
  crash.afterSend = false;
  crash.beforePersist = false;
  env.REMEDIATION_WEBHOOK_TIMEOUT_MS = 30_000;
});

const auditOf = async (id: string) => (await prisma.auditLog.findMany({ where: { resourceId: id }, orderBy: { createdAt: 'asc' } })).map((a) => ({ action: a.action, meta: a.metadata as Record<string, unknown> | null }));

/** A restart, approved by an admin, in an organisation whose actions are carried out by the stand-in webhook. */
async function approvedAction(org: Org) {
  await org.owner.patch('/api/v1/settings').send({ remediationWebhookUrl: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook` }).expect(200);
  const approver = await org.member('ADMIN');
  const service = await createService(org.owner, `Orders ${Math.random().toString(36).slice(2, 7)}`);
  const action = (await org.owner.post('/api/v1/remediations').send({ type: 'restart_service', title: 'Restart orders', description: 'Restart the orders pods.', risk: 'MEDIUM', serviceId: service.id }).expect(201)).body;
  const base = `/api/v1/remediations/${action.id}`;
  await org.owner.post(`${base}/request-approval`).send({}).expect(200);
  const { currentHash } = (await org.owner.get(base)).body;
  await approver.agent.post(`${base}/approve`).send({ expectedHash: currentHash }).expect(200);
  return { id: action.id as string, base, serviceId: service.id as string };
}

/** As if the attempt had started an hour ago and its process had stopped. */
const age = (id: string) => prisma.$executeRaw`UPDATE "RemediationAction" SET "updatedAt" = now() - interval '1 hour' WHERE id = ${id}`;
const row = (id: string) => prisma.remediationAction.findUniqueOrThrow({ where: { id } });

describe('an execution whose process stops', () => {
  it.each([
    ['before sending the webhook', async (org: Org, a: { id: string }) => {
      // The claim was made and nothing else: the row says EXECUTING, the webhook never heard of it.
      await prisma.remediationAction.update({ where: { id: a.id }, data: { status: 'EXECUTING', attempts: 1, executedById: org.ownerId } });
    }, 0],
    ['after sending the webhook, before any response', async (org: Org, a: { base: string }) => {
      crash.afterSend = true;
      expect((await org.owner.post(`${a.base}/execute`).send({})).status).toBe(500);
    }, 1],
    ['after a success response, before it was stored', async (org: Org, a: { base: string }) => {
      crash.beforePersist = true;
      expect((await org.owner.post(`${a.base}/execute`).send({})).status).toBe(500);
    }, 1],
  ])('%s is recorded as unknown, keeps its attempt, and is never sent again by itself', async (_label, stop, sent) => {
    const org = await createOrg();
    const a = await approvedAction(org);
    await stop(org, a);
    expect(await row(a.id)).toMatchObject({ status: 'EXECUTING', attempts: 1 });
    expect(received).toHaveLength(sent);

    // Not stale yet: the sweep leaves it alone.
    await reapStranded();
    expect((await row(a.id)).status).toBe('EXECUTING');

    await age(a.id);
    const stuck = await row(a.id);
    await reapStranded();
    const after = await row(a.id);
    expect(after).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(after.executionResult).toMatchObject({ outcome: 'unknown', success: false, interrupted: true, attempt: 1, contentHash: stuck.contentHash, idempotencyKey: a.id });
    expect((await auditOf(a.id)).find((x) => x.action === 'remediation.execute_interrupted')!.meta).toMatchObject({ attempt: 1, contentHash: stuck.contentHash, staleMinutes: env.REMEDIATION_EXECUTION_STALE_MINUTES });

    // Nothing retries it: not the sweep, not a plain retry request.
    await reapStranded();
    expect((await org.owner.post(`${a.base}/retry`).send({})).status).toBe(409);
    expect((await org.owner.post(`${a.base}/execute`).send({})).status).toBe(409);
    expect(received).toHaveLength(sent);
  });

  it('two sweeps at the same moment record it once', async () => {
    const org = await createOrg();
    const a = await approvedAction(org);
    await prisma.remediationAction.update({ where: { id: a.id }, data: { status: 'EXECUTING', attempts: 1 } });
    await age(a.id);
    await Promise.all([reapStranded(), reapStranded(), reapStranded()]);
    expect((await auditOf(a.id)).filter((x) => x.action === 'remediation.execute_interrupted')).toHaveLength(1);
  });

  it('an outcome that arrives after the attempt was recorded as interrupted does not overwrite it', async () => {
    const org = await createOrg();
    const a = await approvedAction(org);
    // While the webhook is answering, the worker decides the attempt is stuck.
    respond.before = async () => {
      await age(a.id);
      await reapStranded();
    };
    const late = await org.owner.post(`${a.base}/execute`).send({});
    expect(late.status).toBe(409);
    expect(late.body.error.message).toContain('arrived after the attempt had been recorded as interrupted');
    expect(await row(a.id)).toMatchObject({ status: 'FAILED', executionResult: expect.objectContaining({ outcome: 'unknown', interrupted: true }) });
    expect((await auditOf(a.id)).find((x) => x.action === 'remediation.outcome_after_interruption')!.meta).toMatchObject({ attempt: 1, outcome: 'applied', success: true });
    expect(await prisma.serviceEvent.count({ where: { serviceId: a.serviceId } })).toBe(0);
  });
});

describe('an outcome the webhook could not confirm', () => {
  it.each([
    ['a timeout', () => { env.REMEDIATION_WEBHOOK_TIMEOUT_MS = 150; respond.delayMs = 1_000; }],
    ['an HTTP 5xx', () => { respond.status = 503; }],
  ])('%s is recorded as unknown and is not retried by itself', async (_label, setUp) => {
    const org = await createOrg();
    const a = await approvedAction(org);
    setUp();
    const failed = (await org.owner.post(`${a.base}/execute`).send({}).expect(200)).body;
    expect(failed).toMatchObject({ status: 'FAILED', executionResult: { outcome: 'unknown' } });
    await new Promise((r) => setTimeout(r, 1_100));
    await reapStranded();
    expect((await org.owner.post(`${a.base}/retry`).send({})).status).toBe(409);
    expect(received).toHaveLength(1);
  });
});

describe('a person reconciling an unknown outcome', () => {
  async function unknownOutcome(org: Org) {
    const a = await approvedAction(org);
    respond.status = 503;
    await org.owner.post(`${a.base}/execute`).send({}).expect(200);
    respond.status = 200;
    return a;
  }

  it('confirms it was applied: the action is executed, the effect is on the service history, nothing is sent', async () => {
    const org = await createOrg();
    const a = await unknownOutcome(org);
    const done = (await org.owner.post(`${a.base}/reconcile`).send({ outcome: 'applied', notes: 'Pods show the restart at 10:02.', attempt: 1 }).expect(200)).body;
    expect(done).toMatchObject({ status: 'EXECUTED', executionResult: { outcome: 'applied', success: true, reconciliations: [expect.objectContaining({ outcome: 'applied', previousOutcome: 'unknown', notes: 'Pods show the restart at 10:02.' })] } });
    expect(await prisma.serviceEvent.count({ where: { serviceId: a.serviceId } })).toBe(1);
    expect((await auditOf(a.id)).at(-1)).toMatchObject({ action: 'remediation.reconcile', meta: { attempt: 1, outcome: 'applied', previousOutcome: 'unknown' } });
    expect((await org.owner.post(`${a.base}/retry`).send({ confirmNotApplied: true })).status).toBe(409);
    expect(received).toHaveLength(1);
  });

  it('confirms it was not applied: it may then be retried explicitly, once, with the same idempotency key', async () => {
    const org = await createOrg();
    const a = await unknownOutcome(org);
    expect((await org.owner.post(`${a.base}/reconcile`).send({ outcome: 'not_applied', notes: 'No restart in the pod events.', attempt: 1 }).expect(200)).body).toMatchObject({ status: 'FAILED', executionResult: { outcome: 'not_applied' } });
    expect(received).toHaveLength(1);
    await org.owner.post(`${a.base}/retry`).send({}).expect(200);
    const retried = (await org.owner.post(`${a.base}/execute`).send({}).expect(200)).body;
    expect(retried).toMatchObject({ status: 'EXECUTED', attempts: 2 });
    expect(received.map((r) => [r.attempt, r.key])).toEqual([[1, a.id], [2, a.id]]);
  });

  it('records that it is still unknown: it stays blocked, and can be reconciled again later', async () => {
    const org = await createOrg();
    const a = await unknownOutcome(org);
    const still = (await org.owner.post(`${a.base}/reconcile`).send({ outcome: 'unknown', notes: 'The target logs are not available yet.', attempt: 1 }).expect(200)).body;
    expect(still).toMatchObject({ status: 'FAILED', executionResult: { outcome: 'unknown', reconciliations: [expect.objectContaining({ outcome: 'unknown' })] } });
    expect((await org.owner.post(`${a.base}/retry`).send({})).status).toBe(409);
    await org.owner.post(`${a.base}/reconcile`).send({ outcome: 'not_applied', notes: 'Logs show no restart.', attempt: 1 }).expect(200);
    expect((await row(a.id)).executionResult).toMatchObject({ outcome: 'not_applied', reconciliations: [expect.objectContaining({ outcome: 'unknown' }), expect.objectContaining({ outcome: 'not_applied' })] });
  });

  it('two decisions at the same moment: one is recorded, the other is refused', async () => {
    const org = await createOrg();
    const a = await unknownOutcome(org);
    const [first, second] = await Promise.all([
      org.owner.post(`${a.base}/reconcile`).send({ outcome: 'applied', notes: 'Saw the restart.', attempt: 1 }),
      org.owner.post(`${a.base}/reconcile`).send({ outcome: 'not_applied', notes: 'Saw nothing.', attempt: 1 }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect((await auditOf(a.id)).filter((x) => x.action === 'remediation.reconcile')).toHaveLength(1);
  });

  it('is refused for an attempt that is not the latest, for an outcome that is known, and without notes', async () => {
    const org = await createOrg();
    const a = await unknownOutcome(org);
    expect((await org.owner.post(`${a.base}/reconcile`).send({ outcome: 'applied', notes: 'Saw it.', attempt: 2 })).status).toBe(409);
    expect((await org.owner.post(`${a.base}/reconcile`).send({ outcome: 'applied', notes: '', attempt: 1 })).status).toBe(400);
    const viewer = await org.member('VIEWER');
    expect((await viewer.agent.post(`${a.base}/reconcile`).send({ outcome: 'applied', notes: 'Saw it.', attempt: 1 })).status).toBe(403);
    const fresh = await approvedAction(org);
    await org.owner.post(`${fresh.base}/execute`).send({}).expect(200);
    expect((await org.owner.post(`${fresh.base}/reconcile`).send({ outcome: 'not_applied', notes: 'Checked.', attempt: 1 })).status).toBe(409);
  });

  it('a retry that confirms "not applied" is recorded as a reconciliation too', async () => {
    const org = await createOrg();
    const a = await unknownOutcome(org);
    await org.owner.post(`${a.base}/retry`).send({ confirmNotApplied: true }).expect(200);
    const trail = await auditOf(a.id);
    expect(trail.slice(-2).map((x) => x.action)).toEqual(['remediation.reconcile', 'remediation.retry']);
    expect(trail.at(-2)!.meta).toMatchObject({ outcome: 'not_applied', via: 'retry', attempt: 1 });
    expect((await row(a.id)).executionResult).toMatchObject({ outcome: 'not_applied', reconciliations: [expect.objectContaining({ via: 'retry' })] });
  });
});
