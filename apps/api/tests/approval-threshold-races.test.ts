import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Races on an action's risk and on the number of approvals it needs (review of PR #34).
// The execution claim is wrapped so that a test can change the organisation's settings at the
// exact moment between the route's own checks and the claim; nothing else is mocked.

const hooks = vi.hoisted(() => ({ beforeClaim: null as null | (() => Promise<void>) }));
vi.mock('../src/modules/remediation/approvals', async (original) => {
  const actual = await original<typeof import('../src/modules/remediation/approvals')>();
  return {
    ...actual,
    claimExecution: async (...args: Parameters<typeof actual.claimExecution>) => {
      if (hooks.beforeClaim) await hooks.beforeClaim();
      return actual.claimExecution(...args);
    },
  };
});

import { awaitMoreApprovals } from '../src/modules/remediation/approvals';
import { getSettings } from '../src/modules/organization';
import { load } from '../src/modules/remediation/presenter';
import { raiseRisk } from '../src/modules/remediation/safeguards';
import { createOrg, createService, prisma } from './helpers';

type Org = Awaited<ReturnType<typeof createOrg>>;
const path = (id: string) => `/api/v1/remediations/${id}`;
const row = (id: string) => prisma.remediationAction.findUniqueOrThrow({ where: { id }, include: { approvals: true } });
const auditOf = async (id: string) => (await prisma.auditLog.findMany({ where: { resourceId: id }, orderBy: { createdAt: 'asc' } })).map((a) => ({ action: a.action, meta: (a.metadata ?? {}) as Record<string, unknown> }));
const settings = (org: Org, body: Record<string, unknown>) => org.owner.patch('/api/v1/settings').send(body).expect(200);

beforeEach(() => {
  hooks.beforeClaim = null;
});

/** A person's configuration change on a fresh service, PROPOSED (and submitted if `submit`). */
async function proposal(org: Org, risk: 'MEDIUM' | 'HIGH' = 'MEDIUM', submit = false) {
  const service = await createService(org.owner, `Svc ${Math.random().toString(36).slice(2, 7)}`);
  const action = (await org.owner.post('/api/v1/remediations').send({ type: 'config_change', title: 'Raise the pool size', description: 'Set DB_POOL_MAX=40.', risk, serviceId: service.id }).expect(201)).body;
  if (submit) await org.owner.post(`${path(action.id)}/request-approval`).send({}).expect(200);
  return action.id as string;
}

/** An older PROPOSED action stored below today's floor (LOW for a configuration change), so submitting it raises its risk. */
async function storedBelowFloor(org: Org) {
  const id = await proposal(org);
  await prisma.remediationAction.update({ where: { id }, data: { risk: 'LOW', requiredApprovals: 1 } });
  return id;
}

// ───────────────────────── 1. A PROPOSED action's risk ─────────────────────────

describe('raising the risk of a PROPOSED action', () => {
  it('a normal submission raises it to the floor, and the audit says from what to what', async () => {
    const org = await createOrg();
    const id = await storedBelowFloor(org);
    await org.owner.post(`${path(id)}/request-approval`).send({}).expect(200);
    expect(await row(id)).toMatchObject({ risk: 'MEDIUM', status: 'PENDING_APPROVAL' });
    expect((await auditOf(id)).find((a) => a.action === 'remediation.risk_raised')!.meta).toMatchObject({ previousRisk: 'LOW', newRisk: 'MEDIUM', previousStatus: 'PROPOSED' });
  });

  it('a raise computed from a copy read before an edit is refused, and changes nothing', async () => {
    const org = await createOrg();
    const id = await storedBelowFloor(org);
    const stale = await load(org.organizationId, id);
    // Someone raises it to HIGH in the meantime.
    await org.owner.patch(path(id)).send({ risk: 'HIGH' }).expect(200);
    const req = {} as Request; // no session: nothing would be audited even if it were reached
    await expect(raiseRisk(req, { kind: 'user', organizationId: org.organizationId, actorId: org.ownerId, label: 'Olivia Owner' } as never, stale, 'MEDIUM', await getSettings(org.organizationId))).rejects.toMatchObject({ status: 409 });
    expect(await row(id)).toMatchObject({ risk: 'HIGH', status: 'PROPOSED' });
    expect((await auditOf(id)).filter((a) => a.action === 'remediation.risk_raised')).toHaveLength(0);
  });

  it('asked to apply a lower risk, it keeps the higher one', async () => {
    const org = await createOrg();
    const id = await proposal(org, 'HIGH');
    const fresh = await load(org.organizationId, id);
    await raiseRisk({} as Request, { kind: 'user', organizationId: org.organizationId, actorId: org.ownerId, label: 'Olivia Owner' } as never, fresh, 'MEDIUM', await getSettings(org.organizationId));
    expect(await row(id)).toMatchObject({ risk: 'HIGH', status: 'PROPOSED' });
  });

  it('a submission racing an edit to HIGH never leaves the risk below HIGH', async () => {
    const org = await createOrg();
    for (let round = 0; round < 6; round++) {
      const id = await storedBelowFloor(org);
      const [submitted, edited] = await Promise.all([org.owner.post(`${path(id)}/request-approval`).send({}), org.owner.patch(path(id)).send({ risk: 'HIGH' })]);
      const after = await row(id);
      if (edited.status === 200) expect(after.risk).toBe('HIGH');
      expect(['MEDIUM', 'HIGH']).toContain(after.risk);
      // Every audited raise names the risk it found and the one it left, never a lowering.
      for (const a of (await auditOf(id)).filter((x) => x.action === 'remediation.risk_raised')) expect(['LOW', 'MEDIUM']).toContain(a.meta.previousRisk);
      expect([200, 409]).toContain(submitted.status);
    }
  });
});

// ───────────────────────── 2. Every threshold write keeps the higher number ─────────────────────────

describe('the stored number of approvals never decreases', () => {
  it('approvals racing settings that go low, high, low again', async () => {
    const org = await createOrg();
    for (let round = 0; round < 4; round++) {
      const [a, b] = [await org.member('ADMIN'), await org.member('ADMIN')];
      await settings(org, { approvalsMediumRisk: 1 });
      const id = await proposal(org, 'MEDIUM', true);
      const { currentHash } = (await org.owner.get(path(id))).body;
      const seen: number[] = [];
      await Promise.all([
        a.agent.post(`${path(id)}/approve`).send({ expectedHash: currentHash }),
        settings(org, { approvalsMediumRisk: 3 }),
        b.agent.post(`${path(id)}/approve`).send({ expectedHash: currentHash }),
        settings(org, { approvalsMediumRisk: 1 }),
      ]);
      for (const x of await auditOf(id)) if (typeof x.meta.required === 'number') seen.push(x.meta.required as number);
      const stored = (await row(id)).requiredApprovals;
      expect(stored).toBeGreaterThanOrEqual(Math.max(1, ...seen));
    }
  });

  it('an approval after the settings were lowered keeps the stored number and does not approve early', async () => {
    const org = await createOrg();
    const a = await org.member('ADMIN');
    await settings(org, { approvalsMediumRisk: 3 });
    const id = await proposal(org, 'MEDIUM', true);
    await settings(org, { approvalsMediumRisk: 1 });
    const { currentHash } = (await org.owner.get(path(id))).body;
    await a.agent.post(`${path(id)}/approve`).send({ expectedHash: currentHash }).expect(200);
    expect(await row(id)).toMatchObject({ requiredApprovals: 3, status: 'PENDING_APPROVAL' });
    expect((await auditOf(id)).find((x) => x.action === 'remediation.approve')!.meta).toMatchObject({ granted: 1, required: 3 });
  });

  it('two waits for more approvals at once: the higher number stays', async () => {
    const org = await createOrg();
    const a = await org.member('ADMIN');
    const id = await proposal(org, 'MEDIUM', true);
    const hash = (await row(id)).contentHash!;
    await prisma.approval.create({ data: { actionId: id, approverId: a.userId, decision: 'approved', contentHash: hash } });
    await prisma.remediationAction.update({ where: { id }, data: { status: 'APPROVED' } });
    const results = await Promise.all([awaitMoreApprovals(id, hash, 3), awaitMoreApprovals(id, hash, 2)]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect((await row(id)).requiredApprovals).toBe(results.find((r) => r !== null));
    // Waiting again with a lower number does not lower it.
    await prisma.remediationAction.update({ where: { id }, data: { status: 'APPROVED' } });
    const before = (await row(id)).requiredApprovals;
    expect(await awaitMoreApprovals(id, hash, 1)).toBe(before);
    expect((await row(id)).requiredApprovals).toBe(before);
  });

  it('a raise in the settings racing an approval: the action is never executed with fewer approvals than the settings require at the claim', async () => {
    const org = await createOrg();
    for (let round = 0; round < 4; round++) {
      const a = await org.member('ADMIN');
      await settings(org, { approvalsMediumRisk: 1 });
      const id = await proposal(org, 'MEDIUM', true);
      const { currentHash } = (await org.owner.get(path(id))).body;
      await Promise.all([a.agent.post(`${path(id)}/approve`).send({ expectedHash: currentHash }), settings(org, { approvalsMediumRisk: 2 })]);
      await org.owner.post(`${path(id)}/execute`).send({ confirmManual: true });
      const after = await row(id);
      expect(after.status).not.toBe('EXECUTED');
      expect(after.requiredApprovals).toBeGreaterThanOrEqual(after.status === 'APPROVED' ? 1 : 2);
    }
  });

  it('a lowering of the settings racing a submission never lowers the number', async () => {
    const org = await createOrg();
    for (let round = 0; round < 4; round++) {
      await settings(org, { approvalsHighRisk: 2 });
      const id = await proposal(org, 'HIGH');
      await Promise.all([settings(org, { approvalsHighRisk: 1 }), org.owner.post(`${path(id)}/request-approval`).send({})]);
      expect((await row(id)).requiredApprovals).toBeGreaterThanOrEqual(2);
    }
  });

  it('execution requires the stored number even after the settings were lowered', async () => {
    const org = await createOrg();
    const [a, b] = [await org.member('ADMIN'), await org.member('ADMIN')];
    await settings(org, { approvalsMediumRisk: 3 });
    const id = await proposal(org, 'MEDIUM', true);
    expect((await row(id)).requiredApprovals).toBe(3);
    await settings(org, { approvalsMediumRisk: 1 });
    const hash = (await row(id)).contentHash!;
    for (const who of [a, b]) await prisma.approval.create({ data: { actionId: id, approverId: who.userId, decision: 'approved', contentHash: hash } });
    await prisma.remediationAction.update({ where: { id }, data: { status: 'APPROVED' } });
    const run = await org.owner.post(`${path(id)}/execute`).send({ confirmManual: true });
    expect(run.status).toBe(409);
    expect(run.body.error.message).toContain('needs 3 approvals and has 2');
    expect(await row(id)).toMatchObject({ status: 'PENDING_APPROVAL', requiredApprovals: 3 });
  });
});

// ───────────────────────── 3. The threshold at the execution claim ─────────────────────────

describe('the execution claim', () => {
  it('a raise in the settings between the route checks and the claim refuses the claim until the new number is met', async () => {
    const org = await createOrg();
    const [a, b] = [await org.member('ADMIN'), await org.member('ADMIN')];
    await settings(org, { approvalsMediumRisk: 1 });
    const id = await proposal(org, 'MEDIUM', true);
    const { currentHash } = (await org.owner.get(path(id))).body;
    await a.agent.post(`${path(id)}/approve`).send({ expectedHash: currentHash }).expect(200);
    expect((await row(id)).status).toBe('APPROVED');

    // The route has checked one approval against a threshold of one; then, before the claim, the settings change.
    hooks.beforeClaim = async () => {
      hooks.beforeClaim = null;
      await settings(org, { approvalsMediumRisk: 2 });
    };
    const run = await org.owner.post(`${path(id)}/execute`).send({ confirmManual: true });
    expect(run.status).toBe(409);
    expect(run.body.error.message).toContain('needs 2 approvals and has 1');
    const after = await row(id);
    expect(after).toMatchObject({ status: 'PENDING_APPROVAL', requiredApprovals: 2, attempts: 0, executedAt: null });
    // The approval given still counts: it is not superseded.
    expect(after.approvals.filter((x) => !x.supersededAt)).toHaveLength(1);
    expect((await auditOf(id)).at(-1)).toMatchObject({ action: 'remediation.approval_insufficient', meta: { stage: 'claim', required: 2, validApprovals: 1, newStatus: 'PENDING_APPROVAL' } });

    // Once the new number is met, it runs.
    await b.agent.post(`${path(id)}/approve`).send({ expectedHash: currentHash }).expect(200);
    expect((await org.owner.post(`${path(id)}/execute`).send({ confirmManual: true }).expect(200)).body.status).toBe('EXECUTED');
  });

  it('a settings change and an execution at once: if it ran, it had the approvals the settings required when it was claimed', async () => {
    const org = await createOrg();
    for (let round = 0; round < 4; round++) {
      const a = await org.member('ADMIN');
      await settings(org, { approvalsMediumRisk: 1 });
      const id = await proposal(org, 'MEDIUM', true);
      const { currentHash } = (await org.owner.get(path(id))).body;
      await a.agent.post(`${path(id)}/approve`).send({ expectedHash: currentHash }).expect(200);
      const [run] = await Promise.all([org.owner.post(`${path(id)}/execute`).send({ confirmManual: true }), settings(org, { approvalsMediumRisk: 2 })]);
      const start = (await auditOf(id)).find((x) => x.action === 'remediation.execute_start');
      if (run.status === 200) {
        // The claim committed before the change: one approval met the one the settings then required.
        expect(start!.meta.approvedBy).toHaveLength(1);
      } else {
        expect(start).toBeUndefined();
        expect((await row(id)).status).toBe('PENDING_APPROVAL');
      }
    }
  });
});
