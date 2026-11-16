import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Milestone 12: what was approved is what is executed, where it was approved to go.
// Two local stand-in webhooks, a hook just before and just after the execution claim, and real
// PostgreSQL transactions held open behind explicit barriers. Nothing leaves this machine.

const hooks = vi.hoisted(() => ({ beforeClaim: null as null | (() => Promise<void>), afterClaim: null as null | (() => Promise<void>) }));
vi.mock('../src/modules/remediation/approvals', async (original) => {
  const actual = await original<typeof import('../src/modules/remediation/approvals')>();
  return {
    ...actual,
    claimExecution: async (...args: Parameters<typeof actual.claimExecution>) => {
      if (hooks.beforeClaim) await hooks.beforeClaim();
      const claim = await actual.claimExecution(...args);
      // The claim has committed; the dispatch has not started.
      if (hooks.afterClaim) await hooks.afterClaim();
      return claim;
    },
  };
});

import { netConfig } from '../src/lib/netguard';
import { claimExecution, submitForApproval } from '../src/modules/remediation/approvals';
import { load } from '../src/modules/remediation/presenter';
import { createOrg, createService, prisma } from './helpers';

type Org = Awaited<ReturnType<typeof createOrg>>;
const path = (id: string) => `/api/v1/remediations/${id}`;
const row = (id: string) => prisma.remediationAction.findUniqueOrThrow({ where: { id }, include: { approvals: true } });
const auditOf = async (id: string) => (await prisma.auditLog.findMany({ where: { resourceId: id }, orderBy: { createdAt: 'asc' } })).map((a) => ({ action: a.action, meta: (a.metadata ?? {}) as Record<string, unknown> }));

// ───────────────────────── Two destinations ─────────────────────────

const servers: Record<'a' | 'b', { server: Server; hits: number; status: number }> = { a: { server: null as never, hits: 0, status: 200 }, b: { server: null as never, hits: 0, status: 200 } };
const url = (which: 'a' | 'b') => `http://127.0.0.1:${(servers[which].server.address() as AddressInfo).port}/hook?token=abc123`;
beforeAll(async () => {
  netConfig.allowPrivate = true;
  for (const s of Object.values(servers)) {
    s.server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        s.hits++;
        res.writeHead(s.status).end();
      });
    });
    await new Promise<void>((resolve) => s.server.listen(0, '127.0.0.1', resolve));
  }
});
afterAll(async () => {
  netConfig.allowPrivate = false;
  for (const s of Object.values(servers)) await new Promise((resolve) => s.server.close(resolve));
});
beforeEach(() => {
  hooks.beforeClaim = null;
  hooks.afterClaim = null;
  for (const s of Object.values(servers)) Object.assign(s, { hits: 0, status: 200 });
});

const pointAt = (org: Org, which: 'a' | 'b' | null) => org.owner.patch('/api/v1/settings').send({ remediationWebhookUrl: which ? url(which) : null }).expect(200);

/** A person's restart, submitted (and approved by one admin unless `approve` is false) under the destination set at that moment. */
async function action(org: Org, approve = true) {
  const service = await createService(org.owner, `Svc ${Math.random().toString(36).slice(2, 7)}`);
  const created = (await org.owner.post('/api/v1/remediations').send({ type: 'restart_service', title: 'Restart orders', description: 'Restart the orders pods.', risk: 'MEDIUM', serviceId: service.id }).expect(201)).body;
  await org.owner.post(`${path(created.id)}/request-approval`).send({}).expect(200);
  const admin = await org.member('ADMIN');
  if (approve) {
    const { currentHash } = (await org.owner.get(path(created.id))).body;
    await admin.agent.post(`${path(created.id)}/approve`).send({ expectedHash: currentHash }).expect(200);
  }
  return { id: created.id as string, admin };
}

describe('the destination an action was approved for is the one it is sent to', () => {
  it('changed before approval: the approval is refused and the action is submitted again', async () => {
    const org = await createOrg();
    await pointAt(org, 'a');
    const { id, admin } = await action(org, false);
    await pointAt(org, 'b');
    const res = await admin.agent.post(`${path(id)}/approve`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('where it would be carried out');
    expect((await row(id)).status).toBe('PROPOSED');
  });

  it('changed after approval: execution is refused, the approvals stop counting, and nothing is sent anywhere', async () => {
    const org = await createOrg();
    await pointAt(org, 'a');
    const { id } = await action(org);
    await pointAt(org, 'b');
    expect((await org.owner.post(`${path(id)}/execute`).send({})).status).toBe(409);
    const after = await row(id);
    expect(after.status).toBe('PROPOSED');
    expect(after.approvals.every((x) => x.supersededAt)).toBe(true);
    expect([servers.a.hits, servers.b.hits]).toEqual([0, 0]);
  });

  it.each([
    ['another webhook', 'a', 'b'],
    ['by hand, to a webhook', null, 'a'],
    ['a webhook, to by hand', 'a', null],
  ] as const)('changed at the moment of the claim (%s): the claim is refused, nothing is sent, and fresh approval is needed', async (_label, from, to) => {
    const org = await createOrg();
    await pointAt(org, from);
    const { id } = await action(org);
    // The route has checked everything against the first destination; then the address changes.
    hooks.beforeClaim = async () => {
      hooks.beforeClaim = null;
      await pointAt(org, to);
    };
    const run = await org.owner.post(`${path(id)}/execute`).send({ confirmManual: true });
    expect(run.status).toBe(409);
    expect(run.body.error.message).toContain('where it would be carried out');
    const after = await row(id);
    expect(after).toMatchObject({ status: 'PROPOSED', attempts: 0, executedAt: null });
    expect(after.approvals.every((x) => x.supersededAt)).toBe(true);
    expect([servers.a.hits, servers.b.hits]).toEqual([0, 0]);
    const trail = await auditOf(id);
    expect(trail.at(-1)).toMatchObject({ action: 'remediation.approval_invalid', meta: { reason: 'destination_changed', stage: 'claim' } });
    // The audit says that it changed, not from or to what.
    expect(JSON.stringify(trail)).not.toMatch(/127\.0\.0\.1|token=|abc123|\/hook/);
  });

  it('changed after the claim, before the dispatch: this attempt still goes to the approved destination, and only there', async () => {
    const org = await createOrg();
    await pointAt(org, 'a');
    const { id } = await action(org);
    hooks.afterClaim = async () => {
      hooks.afterClaim = null;
      await pointAt(org, 'b');
    };
    const done = (await org.owner.post(`${path(id)}/execute`).send({}).expect(200)).body;
    expect(done.status).toBe('EXECUTED');
    expect([servers.a.hits, servers.b.hits]).toEqual([1, 0]);
  });

  it('a retry cannot move to a new destination without fresh approval', async () => {
    const org = await createOrg();
    await pointAt(org, 'a');
    const { id } = await action(org);
    servers.a.status = 422; // refused: certainly not applied
    await org.owner.post(`${path(id)}/execute`).send({}).expect(200);
    await pointAt(org, 'b');
    await org.owner.post(`${path(id)}/retry`).send({ attempt: 1 }).expect(200);
    expect((await org.owner.post(`${path(id)}/execute`).send({})).status).toBe(409);
    expect((await row(id)).status).toBe('PROPOSED');
    expect([servers.a.hits, servers.b.hits]).toEqual([1, 0]);
  });

  it('unchanged: it is sent once, to the approved destination', async () => {
    const org = await createOrg();
    await pointAt(org, 'a');
    const { id } = await action(org);
    await org.owner.post(`${path(id)}/execute`).send({}).expect(200);
    expect([servers.a.hits, servers.b.hits]).toEqual([1, 0]);
  });
});

// ───────────────────────── Submission ─────────────────────────

describe('submitting an action for approval', () => {
  const proposed = async (org: Org) => {
    const service = await createService(org.owner, `Svc ${Math.random().toString(36).slice(2, 7)}`);
    return (await org.owner.post('/api/v1/remediations').send({ type: 'config_change', title: 'Raise the pool size', description: 'Set DB_POOL_MAX=40.', risk: 'MEDIUM', serviceId: service.id }).expect(201)).body.id as string;
  };

  it('a submission computed from a copy read before an edit is refused, and no fingerprint is stored', async () => {
    const org = await createOrg();
    const id = await proposed(org);
    const stale = await load(org.organizationId, id);
    await org.owner.patch(path(id)).send({ description: 'Set DB_POOL_MAX=400.' }).expect(200);
    await expect(submitForApproval(stale, org.ownerId, 1, 'f'.repeat(64))).rejects.toMatchObject({ status: 409 });
    expect(await row(id)).toMatchObject({ status: 'PROPOSED', contentHash: null, requestedById: null });
  });

  it.each([
    ['its description', (round: number) => ({ description: `Set DB_POOL_MAX=${50 + round}.` })],
    ['its risk', () => ({ risk: 'HIGH' })],
  ])('a submission racing an edit of %s never stores a fingerprint for content the action no longer has', async (_label, patch) => {
    const org = await createOrg();
    for (let round = 0; round < 6; round++) {
      const id = await proposed(org);
      const [submitted] = await Promise.all([org.owner.post(`${path(id)}/request-approval`).send({}), org.owner.patch(path(id)).send(patch(round))]);
      expect([200, 409]).toContain(submitted.status);
      const after = await row(id);
      if (after.status === 'PENDING_APPROVAL') {
        // What is stored is the fingerprint of the action as it is now.
        expect(after.contentHash).toBe((await org.owner.get(path(id))).body.currentHash);
        if (after.risk === 'HIGH') expect(after.requiredApprovals).toBeGreaterThanOrEqual(2);
      } else {
        expect(after).toMatchObject({ status: 'PROPOSED', contentHash: null });
      }
    }
  });

  it('an unchanged action is submitted as before', async () => {
    const org = await createOrg();
    const id = await proposed(org);
    await org.owner.post(`${path(id)}/request-approval`).send({}).expect(200);
    const after = await row(id);
    expect(after.status).toBe('PENDING_APPROVAL');
    expect(after.contentHash).toBe((await org.owner.get(path(id))).body.currentHash);
  });
});

// ───────────────────────── PostgreSQL locking, with barriers ─────────────────────────

describe('the execution claim and a change of the settings, in both orders (real PostgreSQL locks)', () => {
  /** Sessions of this database waiting for a lock. */
  const waiting = async () => Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.datname = current_database()`)[0]!.n);
  const openTransactions = async () => Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE state = 'idle in transaction' AND datname = current_database() AND pid <> pg_backend_pid()`)[0]!.n);
  /** Waits until the database itself reports the state; the assertion is on that state, not on elapsed time. */
  const until = async (state: () => Promise<boolean>) => {
    for (let i = 0; i < 200; i++) {
      if (await state()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('the database never reached the expected lock state');
  };
  const barrier = () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    return { gate, release };
  };
  const tracked = <T,>(p: Promise<T>) => {
    const state = { settled: false };
    return { state, promise: p.finally(() => (state.settled = true)) };
  };

  /** An action approved by one admin, carried out by hand, in an organisation whose medium-risk threshold is 1. */
  async function approved() {
    const org = await createOrg();
    const { id } = await action(org);
    const stored = await row(id);
    return { org, id, claim: () => claimExecution(id, org.organizationId, 'APPROVED', stored.contentHash!, org.ownerId, 'manual') };
  }
  const medium = (org: Org) => prisma.organizationSettings.findUniqueOrThrow({ where: { organizationId: org.organizationId } }).then((s) => s.approvalsMediumRisk);

  it('a settings change held open first: the claim waits for it, and once it commits the claim enforces the new number', async () => {
    const { org, id, claim } = await approved();
    const hold = barrier();
    const updated = barrier();
    const change = prisma.$transaction(
      async (tx) => {
        await tx.organizationSettings.update({ where: { organizationId: org.organizationId }, data: { approvalsMediumRisk: 2 } });
        updated.release();
        await hold.gate; // uncommitted, row lock held
      },
      { timeout: 20_000 },
    );
    await updated.gate;
    const claiming = tracked(claim());
    await until(async () => (await waiting()) >= 1); // the claim is blocked on the settings row
    expect(claiming.state.settled).toBe(false);
    expect((await row(id)).status).toBe('APPROVED');

    hold.release();
    await change;
    expect(await claiming.promise).toMatchObject({ claimed: false, reason: 'insufficient', required: 2, valid: 1, newStatus: 'PENDING_APPROVAL' });
    expect(await row(id)).toMatchObject({ status: 'PENDING_APPROVAL', requiredApprovals: 2, attempts: 0 });
    expect(await waiting()).toBe(0);
  });

  it('a settings change held open first and then rolled back: the claim waits, then proceeds under the number that still stands', async () => {
    const { org, id, claim } = await approved();
    const hold = barrier();
    const updated = barrier();
    const change = prisma
      .$transaction(
        async (tx) => {
          await tx.organizationSettings.update({ where: { organizationId: org.organizationId }, data: { approvalsMediumRisk: 2 } });
          updated.release();
          await hold.gate;
          throw new Error('rolled back');
        },
        { timeout: 20_000 },
      )
      .catch(() => 'rolled back');
    await updated.gate;
    const claiming = tracked(claim());
    await until(async () => (await waiting()) >= 1);
    expect(claiming.state.settled).toBe(false);

    hold.release();
    expect(await change).toBe('rolled back');
    expect(await claiming.promise).toMatchObject({ claimed: true });
    expect(await row(id)).toMatchObject({ status: 'EXECUTING', attempts: 1 });
    expect(await medium(org)).toBe(1);
    expect(await waiting()).toBe(0);
  });

  it('the claim holding the settings row first: a settings change waits until the claim commits, and applies to the next claim', async () => {
    const { org, id, claim } = await approved();
    const second = await action(org);
    const secondStored = await row(second.id);
    // Hold the claim open after it has share-locked the settings row: its next step reads the
    // approvals, and that read waits while this transaction holds the table.
    const hold = barrier();
    const held = barrier();
    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`LOCK TABLE "Approval" IN ACCESS EXCLUSIVE MODE`;
        held.release();
        await hold.gate;
      },
      { timeout: 20_000 },
    );
    await held.gate;
    const order: string[] = [];
    const claiming = tracked(claim().then((c) => (order.push('claim'), c)));
    await until(async () => (await waiting()) >= 1); // the claim holds the action row and the settings row, and waits for the approvals
    const change = tracked(prisma.organizationSettings.update({ where: { organizationId: org.organizationId }, data: { approvalsMediumRisk: 2 } }).then((s) => (order.push('settings'), s)));
    await until(async () => (await waiting()) >= 2); // the settings change waits for the claim's share lock
    expect([claiming.state.settled, change.state.settled]).toEqual([false, false]);
    expect(await medium(org)).toBe(1);

    hold.release();
    await blocker;
    // The claim was decided under the number in force while it held the row: one approval, one needed.
    expect(await claiming.promise).toMatchObject({ claimed: true });
    await change.promise;
    expect(order).toEqual(['claim', 'settings']);
    expect(await row(id)).toMatchObject({ status: 'EXECUTING', attempts: 1 });
    expect(await medium(org)).toBe(2);
    // The next claim, after the change committed, is held to the new number.
    expect(await claimExecution(second.id, org.organizationId, 'APPROVED', secondStored.contentHash!, org.ownerId, 'manual')).toMatchObject({ claimed: false, reason: 'insufficient', required: 2, valid: 1 });
    expect(await waiting()).toBe(0);
  });

  it('leaves no lock waiting and no transaction open behind', async () => {
    await until(async () => (await waiting()) === 0 && (await openTransactions()) === 0);
    expect([await waiting(), await openTransactions()]).toEqual([0, 0]);
  });
});
