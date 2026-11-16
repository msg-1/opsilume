import { describe, expect, it } from 'vitest';
import { auditIn } from '../src/lib/audit';
import { removeOrganization } from '../src/lib/removeOrganization';
import { recordRejection } from '../src/modules/remediation/approvals';
import { createOrg, createService, prisma } from './helpers';

// Removing an organisation while one of its remediation transitions is in flight. The transition
// locks its action row, then its audit insert needs a key-share lock on the organisation row; the
// removal locks the organisation row, then its cascade needs the action row. Real transactions,
// held open behind barriers; the assertions are on what PostgreSQL reports and stores. Each test
// releases its barriers and settles its transactions in `finally`, so a failed assertion never
// leaves a transaction or a lock behind for the next test. Lock waits are counted across the
// database: this relies on API test files running one at a time (vitest.config.ts).

type Org = Awaited<ReturnType<typeof createOrg>>;
const waiting = async () => Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.datname = current_database()`)[0]!.n);
const openTransactions = async () => Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE state LIKE 'idle in transaction%' AND datname = current_database() AND pid <> pg_backend_pid()`)[0]!.n);
const until = async (state: () => Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
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

/** A person's restart awaiting approval, and an admin who may reject it. */
async function pending(org: Org) {
  const service = await createService(org.owner);
  const id = (await org.owner.post('/api/v1/remediations').send({ type: 'restart_service', title: 'Restart orders', description: 'Restart the orders pods.', risk: 'MEDIUM', serviceId: service.id }).expect(201)).body.id as string;
  await org.owner.post(`/api/v1/remediations/${id}/request-approval`).send({}).expect(200);
  const admin = await org.member('ADMIN');
  return { action: await prisma.remediationAction.findUniqueOrThrow({ where: { id } }), adminId: admin.userId };
}

/** The reject route's transaction (routes.ts): the rejection under the row lock, then its audit row. `between` runs in the middle. */
const reject = (org: Org, action: Awaited<ReturnType<typeof pending>>['action'], adminId: string, between: () => Promise<void> = async () => {}) =>
  prisma.$transaction(
    async (tx) => {
      await recordRejection(action, adminId, 'Not now.', tx);
      await between();
      await auditIn(tx, { organizationId: org.organizationId, actorType: 'user', actorId: adminId, action: 'remediation.reject', resourceType: 'remediation_action', resourceId: action.id, metadata: { comment: 'Not now.' } });
    },
    { timeout: 20_000 },
  );

const state = async (org: Org, actionId: string) => ({
  organization: await prisma.organization.count({ where: { id: org.organizationId } }),
  action: (await prisma.remediationAction.findUnique({ where: { id: actionId } }))?.status ?? null,
  rejections: await prisma.approval.count({ where: { actionId, decision: 'rejected' } }),
  audits: await prisma.auditLog.count({ where: { resourceId: actionId, action: 'remediation.reject' } }),
});

describe('removing an organisation during one of its remediation transitions', () => {
  it('the transition holds the action row first: the cycle is broken by PostgreSQL, one side commits whole, the other changes nothing', async () => {
    const org = await createOrg();
    const { action, adminId } = await pending(org);
    const locked = barrier();
    const go = barrier();
    const transition = reject(org, action, adminId, async () => {
      locked.release();
      await go.gate; // the action row is locked and the rejection written, uncommitted
    });
    await locked.gate;
    const removal = removeOrganization(org.slug, { confirm: org.slug });
    let t: PromiseSettledResult<unknown>;
    let r: PromiseSettledResult<unknown>;
    try {
      await until(async () => (await waiting()) >= 1); // the removal's cascade waits for the action row
    } finally {
      go.release(); // the audit insert now needs the organisation row the removal holds
      [t, r] = await Promise.allSettled([transition, removal]);
    }

    // Exactly one side was aborted, as a deadlock; the other completed.
    const failed = [t, r].filter((x) => x.status === 'rejected') as PromiseRejectedResult[];
    expect(failed).toHaveLength(1);
    expect(String(failed[0]!.reason?.message ?? failed[0]!.reason)).toMatch(/deadlock/i);
    const after = await state(org, action.id);
    if (t.status === 'fulfilled') {
      // The rejection committed whole; the organisation is untouched and can be removed afterwards.
      expect(after).toEqual({ organization: 1, action: 'REJECTED', rejections: 1, audits: 1 });
      await removeOrganization(org.slug, { confirm: org.slug });
      expect(await state(org, action.id)).toEqual({ organization: 0, action: null, rejections: 0, audits: 0 });
    } else {
      // The organisation was removed whole; nothing of the rejection exists.
      expect(after).toEqual({ organization: 0, action: null, rejections: 0, audits: 0 });
    }
    await until(async () => (await waiting()) === 0 && (await openTransactions()) === 0);
  });

  it('the removal holds the organisation first: the transition waits, then finds nothing to change', async () => {
    const org = await createOrg();
    const { action, adminId } = await pending(org);
    const deleted = barrier();
    const hold = barrier();
    // The removal's own first write (removeOrganization), held open before it commits.
    const removal = prisma.$transaction(
      async (tx) => {
        await tx.organization.delete({ where: { id: org.organizationId } });
        deleted.release();
        await hold.gate;
      },
      { timeout: 20_000 },
    );
    await deleted.gate;
    const transition = reject(org, action, adminId);
    let outcome: PromiseSettledResult<unknown>[];
    try {
      await until(async () => (await waiting()) >= 1); // the rejection waits for the action row
    } finally {
      hold.release();
      outcome = await Promise.allSettled([removal, transition]);
    }
    expect(outcome[0]!.status).toBe('fulfilled');
    expect(outcome[1]).toMatchObject({ status: 'rejected', reason: { status: 409 } });
    expect(await state(org, action.id)).toEqual({ organization: 0, action: null, rejections: 0, audits: 0 });
    await until(async () => (await waiting()) === 0 && (await openTransactions()) === 0);
  });

  it('the removal holds the organisation first and rolls back: the transition then commits whole', async () => {
    const org = await createOrg();
    const { action, adminId } = await pending(org);
    const deleted = barrier();
    const hold = barrier();
    const removal = prisma
      .$transaction(
        async (tx) => {
          await tx.organization.delete({ where: { id: org.organizationId } });
          deleted.release();
          await hold.gate;
          throw new Error('removal abandoned');
        },
        { timeout: 20_000 },
      )
      .catch(() => 'rolled back');
    await deleted.gate;
    const transition = reject(org, action, adminId);
    let outcome: PromiseSettledResult<unknown>[];
    try {
      await until(async () => (await waiting()) >= 1);
    } finally {
      hold.release();
      outcome = await Promise.allSettled([removal, transition]);
    }
    expect(outcome).toMatchObject([{ status: 'fulfilled', value: 'rolled back' }, { status: 'fulfilled' }]);
    expect(await state(org, action.id)).toEqual({ organization: 1, action: 'REJECTED', rejections: 1, audits: 1 });
    await until(async () => (await waiting()) === 0 && (await openTransactions()) === 0);
  });
});
