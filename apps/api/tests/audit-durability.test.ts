import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditIn } from '../src/lib/audit';
import { netConfig } from '../src/lib/netguard';
import { claimExecution, recordApproval } from '../src/modules/remediation/approvals';
import { executionTarget } from '../src/modules/remediation/content';
import { reapStranded } from '../src/modules/system';
import { createOrg, createService, prisma } from './helpers';

// Milestone 14: a critical remediation transition commits with its audit row or not at all.
// Audit writes are made to fail for real: a PostgreSQL trigger on "AuditLog" refuses one action
// name for one organisation, so the transaction really aborts. A local stand-in webhook counts
// what it receives. Nothing leaves this machine.

type Org = Awaited<ReturnType<typeof createOrg>>;
const path = (id: string) => `/api/v1/remediations/${id}`;
const row = (id: string) => prisma.remediationAction.findUniqueOrThrow({ where: { id }, include: { approvals: true } });
const audits = async (id: string, action: string) => prisma.auditLog.count({ where: { resourceId: id, action } });
const HOUR = 3_600_000;

/** Every audit insert of `action` for this organisation fails, inside whatever transaction makes it. */
async function failAudit(org: Org, action: string) {
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION audit_refused() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit write refused (test)'; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER audit_refused BEFORE INSERT ON "AuditLog" FOR EACH ROW WHEN (NEW."organizationId" = '${org.organizationId}' AND NEW.action = '${action}') EXECUTE FUNCTION audit_refused()`);
}
const allowAudits = async () => {
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS audit_refused ON "AuditLog"');
  await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS audit_refused()');
};
afterEach(allowAudits);

const hook = { server: null as unknown as Server, hits: 0, status: 200 };
const hookUrl = () => `http://127.0.0.1:${(hook.server.address() as AddressInfo).port}/hook`;
beforeAll(async () => {
  netConfig.allowPrivate = true;
  hook.server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hook.hits++;
      res.writeHead(hook.status).end();
    });
  });
  await new Promise<void>((resolve) => hook.server.listen(0, '127.0.0.1', resolve));
});
afterAll(async () => {
  netConfig.allowPrivate = false;
  await allowAudits();
  await new Promise((resolve) => hook.server.close(resolve));
});
beforeEach(() => Object.assign(hook, { hits: 0, status: 200 }));

/** A person's medium-risk restart, submitted for approval; approved by one admin unless `approve` is false. */
async function action(org: Org, approve = true) {
  const service = await createService(org.owner);
  const id = (await org.owner.post('/api/v1/remediations').send({ type: 'restart_service', title: 'Restart orders', description: 'Restart the orders pods.', risk: 'MEDIUM', serviceId: service.id }).expect(201)).body.id as string;
  await org.owner.post(`${path(id)}/request-approval`).send({}).expect(200);
  const admin = await org.member('ADMIN');
  if (approve) await admin.agent.post(`${path(id)}/approve`).send({}).expect(200);
  return { id, admin };
}
const webhook = (org: Org) => org.owner.patch('/api/v1/settings').send({ remediationWebhookUrl: hookUrl() }).expect(200);
const backdate = (id: string) => prisma.$executeRaw`UPDATE "Approval" SET "createdAt" = now() - interval '25 hours' WHERE "actionId" = ${id}`;

describe('critical transitions roll back when their audit row cannot be written', () => {
  it('submission', async () => {
    const org = await createOrg();
    const service = await createService(org.owner);
    const id = (await org.owner.post('/api/v1/remediations').send({ type: 'restart_service', title: 'Restart', description: 'Restart it.', risk: 'MEDIUM', serviceId: service.id }).expect(201)).body.id;
    await failAudit(org, 'remediation.request_approval');
    expect((await org.owner.post(`${path(id)}/request-approval`).send({})).status).toBe(500);
    expect(await row(id)).toMatchObject({ status: 'PROPOSED', contentHash: null, requestedById: null });
    await allowAudits();
    await org.owner.post(`${path(id)}/request-approval`).send({}).expect(200);
    expect(await audits(id, 'remediation.request_approval')).toBe(1);
  });

  it('approval', async () => {
    const org = await createOrg();
    const { id, admin } = await action(org, false);
    await failAudit(org, 'remediation.approve');
    expect((await admin.agent.post(`${path(id)}/approve`).send({})).status).toBe(500);
    expect(await row(id)).toMatchObject({ status: 'PENDING_APPROVAL', approvals: [] });
    expect(await audits(id, 'remediation.approve')).toBe(0);
    await allowAudits();
    await admin.agent.post(`${path(id)}/approve`).send({}).expect(200);
    expect((await row(id)).status).toBe('APPROVED');
    expect(await audits(id, 'remediation.approve')).toBe(1);
  });

  it('rejection', async () => {
    const org = await createOrg();
    const { id, admin } = await action(org, false);
    await failAudit(org, 'remediation.reject');
    expect((await admin.agent.post(`${path(id)}/reject`).send({ comment: 'Not now.' })).status).toBe(500);
    expect(await row(id)).toMatchObject({ status: 'PENDING_APPROVAL', approvals: [] });
    await allowAudits();
    await admin.agent.post(`${path(id)}/reject`).send({ comment: 'Not now.' }).expect(200);
    expect(await row(id)).toMatchObject({ status: 'REJECTED' });
    expect(await audits(id, 'remediation.reject')).toBe(1);
  });

  it('expiry found at approval', async () => {
    const org = await createOrg();
    await org.owner.patch('/api/v1/settings').send({ approvalsMediumRisk: 2 }).expect(200);
    const { id, admin } = await action(org);
    expect((await row(id)).status).toBe('PENDING_APPROVAL');
    await backdate(id);
    const second = await org.member('ADMIN');
    await failAudit(org, 'remediation.approval_expired');
    expect((await second.agent.post(`${path(id)}/approve`).send({})).status).toBe(500);
    const kept = await row(id);
    expect(kept.approvals.map((a) => [a.approverId, a.supersededAt])).toEqual([[admin.userId, null]]);
    await allowAudits();
    await second.agent.post(`${path(id)}/approve`).send({}).expect(200);
    const after = await row(id);
    expect(after.approvals.find((a) => a.approverId === admin.userId)!.supersededAt).not.toBeNull();
    expect(after.status).toBe('PENDING_APPROVAL');
    expect(await audits(id, 'remediation.approval_expired')).toBe(1);
  });

  it('expiry found at execution: superseding and stepping back are one transaction with the audit', async () => {
    const org = await createOrg();
    const { id } = await action(org);
    await backdate(id);
    await failAudit(org, 'remediation.approval_expired');
    expect((await org.owner.post(`${path(id)}/execute`).send({ confirmManual: true })).status).toBe(500);
    expect(await row(id)).toMatchObject({ status: 'APPROVED', attempts: 0 });
    expect((await row(id)).approvals.every((a) => a.supersededAt === null)).toBe(true);
    await allowAudits();
    expect((await org.owner.post(`${path(id)}/execute`).send({ confirmManual: true })).status).toBe(409);
    const after = await row(id);
    expect(after.status).toBe('PENDING_APPROVAL');
    expect(after.approvals.every((a) => a.supersededAt !== null)).toBe(true);
    expect(await audits(id, 'remediation.approval_expired')).toBe(1);
  });

  it('invalidation by an edit', async () => {
    const org = await createOrg();
    const { id } = await action(org);
    await failAudit(org, 'remediation.edit');
    expect((await org.owner.patch(path(id)).send({ description: 'Restart only the canary.' })).status).toBe(500);
    const kept = await row(id);
    expect(kept).toMatchObject({ status: 'APPROVED', description: 'Restart the orders pods.' });
    expect(kept.approvals.every((a) => a.supersededAt === null)).toBe(true);
    await allowAudits();
    await org.owner.patch(path(id)).send({ description: 'Restart only the canary.' }).expect(200);
    expect(await row(id)).toMatchObject({ status: 'PROPOSED', contentHash: null });
    expect(await audits(id, 'remediation.edit')).toBe(1);
  });

  it('invalidation because the destination changed after approval: nothing is sent either way', async () => {
    const org = await createOrg();
    const { id } = await action(org);
    await webhook(org);
    await failAudit(org, 'remediation.approval_invalid');
    expect((await org.owner.post(`${path(id)}/execute`).send({})).status).toBe(500);
    expect(await row(id)).toMatchObject({ status: 'APPROVED', attempts: 0 });
    expect((await row(id)).approvals.every((a) => a.supersededAt === null)).toBe(true);
    await allowAudits();
    expect((await org.owner.post(`${path(id)}/execute`).send({})).status).toBe(409);
    expect(await row(id)).toMatchObject({ status: 'PROPOSED' });
    expect(await audits(id, 'remediation.approval_invalid')).toBe(1);
    expect(hook.hits).toBe(0);
  });

  it('execution claim: no claim, no attempt and no dispatch without its audit row', async () => {
    const org = await createOrg();
    await webhook(org);
    const { id } = await action(org);
    await failAudit(org, 'remediation.execute_start');
    expect((await org.owner.post(`${path(id)}/execute`).send({})).status).toBe(500);
    expect(await row(id)).toMatchObject({ status: 'APPROVED', attempts: 0, executedById: null });
    expect(hook.hits).toBe(0);
    await allowAudits();
    await org.owner.post(`${path(id)}/execute`).send({}).expect(200);
    expect(await row(id)).toMatchObject({ status: 'EXECUTED', attempts: 1 });
    expect([await audits(id, 'remediation.execute_start'), await audits(id, 'remediation.execute_success'), hook.hits]).toEqual([1, 1, 1]);
  });

  it('execution outcome: without its audit row the outcome is not recorded, and the sweep records it as unknown, never as done', async () => {
    const org = await createOrg();
    await webhook(org);
    const { id } = await action(org);
    await failAudit(org, 'remediation.execute_success');
    expect((await org.owner.post(`${path(id)}/execute`).send({})).status).toBe(500);
    // The request was sent; its outcome, not being audited, was not stored.
    expect(hook.hits).toBe(1);
    expect(await row(id)).toMatchObject({ status: 'EXECUTING', attempts: 1, executionResult: null });
    expect(await audits(id, 'remediation.execute_start')).toBe(1);
    await allowAudits();

    // The sweep: also atomic. While its audit cannot be written the action stays as it is.
    const later = new Date(Date.now() + 2 * HOUR);
    await failAudit(org, 'remediation.execute_interrupted');
    await reapStranded(later);
    expect((await row(id)).status).toBe('EXECUTING');
    await allowAudits();
    await reapStranded(later);
    expect(await row(id)).toMatchObject({ status: 'FAILED', executionResult: expect.objectContaining({ outcome: 'unknown', interrupted: true }) });
    expect(await audits(id, 'remediation.execute_interrupted')).toBe(1);
    expect(hook.hits).toBe(1);
  });

  it('reconciliation', async () => {
    const org = await createOrg();
    await webhook(org);
    const { id } = await action(org);
    hook.status = 503; // outcome unknown
    await org.owner.post(`${path(id)}/execute`).send({}).expect(200);
    const decision = { attempt: 1, outcome: 'applied', notes: 'Checked the pods: restarted.' };
    await failAudit(org, 'remediation.reconcile');
    expect((await org.owner.post(`${path(id)}/reconcile`).send(decision)).status).toBe(500);
    const kept = await row(id);
    expect(kept.status).toBe('FAILED');
    expect(kept.executionResult).toMatchObject({ outcome: 'unknown' });
    expect((kept.executionResult as { reconciliations?: unknown }).reconciliations).toBeUndefined();
    await allowAudits();
    await org.owner.post(`${path(id)}/reconcile`).send(decision).expect(200);
    expect((await row(id)).status).toBe('EXECUTED');
    expect(await audits(id, 'remediation.reconcile')).toBe(1);
  });

  it('retry: a failed audit write authorises nothing', async () => {
    const org = await createOrg();
    await webhook(org);
    const { id } = await action(org);
    hook.status = 422; // refused: not applied
    await org.owner.post(`${path(id)}/execute`).send({}).expect(200);
    await failAudit(org, 'remediation.retry');
    expect((await org.owner.post(`${path(id)}/retry`).send({ attempt: 1 })).status).toBe(500);
    expect((await row(id)).status).toBe('FAILED');
    await allowAudits();
    await org.owner.post(`${path(id)}/retry`).send({ attempt: 1 }).expect(200);
    expect((await row(id)).status).toBe('APPROVED');
    expect(await audits(id, 'remediation.retry')).toBe(1);
    expect(hook.hits).toBe(1);
  });

  it('cancellation', async () => {
    const org = await createOrg();
    const { id } = await action(org);
    await failAudit(org, 'remediation.cancel');
    expect((await org.owner.post(`${path(id)}/cancel`).send({})).status).toBe(500);
    expect((await row(id)).status).toBe('APPROVED');
    await allowAudits();
    await org.owner.post(`${path(id)}/cancel`).send({}).expect(200);
    expect((await row(id)).status).toBe('CANCELLED');
    expect(await audits(id, 'remediation.cancel')).toBe(1);
  });

  it('remediation settings (destination, thresholds)', async () => {
    const org = await createOrg();
    const settings = () => prisma.organizationSettings.findUniqueOrThrow({ where: { organizationId: org.organizationId } });
    await failAudit(org, 'settings.update');
    expect((await org.owner.patch('/api/v1/settings').send({ approvalsMediumRisk: 3, remediationWebhookUrl: hookUrl() })).status).toBe(500);
    expect(await settings()).toMatchObject({ approvalsMediumRisk: 1, remediationWebhookUrl: null });
    await allowAudits();
    await org.owner.patch('/api/v1/settings').send({ approvalsMediumRisk: 3, remediationWebhookUrl: hookUrl() }).expect(200);
    expect(await settings()).toMatchObject({ approvalsMediumRisk: 3, remediationWebhookUrl: hookUrl() });
    expect(await prisma.auditLog.count({ where: { organizationId: org.organizationId, action: 'settings.update' } })).toBe(1);
  });
});

describe('informational events stay best-effort', () => {
  it('a proposal is created even when its audit row cannot be written', async () => {
    const org = await createOrg();
    const service = await createService(org.owner);
    await failAudit(org, 'remediation.propose');
    const res = await org.owner.post('/api/v1/remediations').send({ type: 'restart_service', title: 'Restart', description: 'Restart it.', risk: 'MEDIUM', serviceId: service.id });
    expect(res.status).toBe(201);
    expect((await row(res.body.id)).status).toBe('PROPOSED');
    expect(await audits(res.body.id, 'remediation.propose')).toBe(0);
  });
});

describe('an audit error caught inside its transaction (the mistake CLAUDE.md forbids)', () => {
  // PostgreSQL aborts the transaction at the failed insert and turns its COMMIT into a ROLLBACK.
  // If the callback swallows the error, Prisma resolves the transaction as if it had committed.
  // Nothing is stored, so atomicity holds, but the caller is told the opposite: code that trusted
  // the resolved value would dispatch a webhook for an action that was never claimed. The routes
  // never catch inside these transactions, so the error reaches them and nothing is dispatched.
  const swallowing = <T,>(work: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>, org: Org, action: string, id: string) =>
    prisma.$transaction(async (tx) => {
      const result = await work(tx);
      try {
        await auditIn(tx, { organizationId: org.organizationId, actorType: 'user', action, resourceType: 'remediation_action', resourceId: id });
      } catch {
        // swallowed: the mistake under test
      }
      return result;
    });

  it('a swallowed failure resolves as a successful claim, yet the claim was rolled back: dispatch must not follow it', async () => {
    const org = await createOrg();
    await webhook(org);
    const { id } = await action(org);
    const stored = await row(id);
    await failAudit(org, 'remediation.execute_start');
    const settings = await prisma.organizationSettings.findUniqueOrThrow({ where: { organizationId: org.organizationId } });
    const claim = await swallowing((tx) => claimExecution(id, org.organizationId, 'APPROVED', stored.contentHash!, org.ownerId, executionTarget(settings), tx), org, 'remediation.execute_start', id);
    // What the caller is told: claimed, with a destination to dispatch to.
    expect(claim).toMatchObject({ claimed: true, destination: { url: hookUrl() } });
    // What is stored: nothing. The action is not executing and no attempt was counted.
    expect(await row(id)).toMatchObject({ status: 'APPROVED', attempts: 0, executedById: null });
    expect(await audits(id, 'remediation.execute_start')).toBe(0);
    expect(hook.hits).toBe(0);
    // The route, which lets the error through, refuses and dispatches nothing (see the claim case above).
    expect((await org.owner.post(`${path(id)}/execute`).send({})).status).toBe(500);
    expect(await row(id)).toMatchObject({ status: 'APPROVED', attempts: 0 });
    expect(hook.hits).toBe(0);
  });

  it('a swallowed failure resolves as a recorded approval, yet no approval was stored', async () => {
    const org = await createOrg();
    const { id, admin } = await action(org, false);
    const stored = await row(id);
    await failAudit(org, 'remediation.approve');
    const result = await swallowing((tx) => recordApproval({ id, requiredApprovals: 1 }, admin.userId, stored.contentHash!, undefined, tx), org, 'remediation.approve', id);
    expect(result).toMatchObject({ approved: true, granted: 1 });
    expect(await row(id)).toMatchObject({ status: 'PENDING_APPROVAL', approvals: [] });
    expect(await audits(id, 'remediation.approve')).toBe(0);
  });
});
