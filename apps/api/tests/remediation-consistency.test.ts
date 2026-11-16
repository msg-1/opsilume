import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { netConfig } from '../src/lib/netguard';
import { invalidateApproval, supersedeExpired } from '../src/modules/remediation/approvals';
import { networkFailure } from '../src/modules/remediation/execution';
import { createOrg, createService, prisma } from './helpers';

// Milestone 11: audit records that match what happened, one lock order for approvals, webhook
// failures that never name the destination, and an approval threshold that only goes up.
// Webhooks are local stand-ins and DNS is stubbed; nothing leaves this machine.

type Org = Awaited<ReturnType<typeof createOrg>>;
const HOUR = 3_600_000;
const path = (id: string) => `/api/v1/remediations/${id}`;
const auditOf = async (id: string) => (await prisma.auditLog.findMany({ where: { resourceId: id }, orderBy: { createdAt: 'asc' } })).map((a) => ({ action: a.action, meta: (a.metadata ?? {}) as Record<string, unknown> }));
const row = (id: string) => prisma.remediationAction.findUniqueOrThrow({ where: { id }, include: { approvals: true } });

/** A person's configuration change, carried out by hand; submitted for approval unless `submit` is false. */
async function proposal(org: Org, risk: 'MEDIUM' | 'HIGH' = 'MEDIUM', submit = true) {
  const service = await createService(org.owner, `Svc ${Math.random().toString(36).slice(2, 7)}`);
  const action = (await org.owner.post('/api/v1/remediations').send({ type: 'config_change', title: 'Raise the pool size', description: 'Set DB_POOL_MAX=40.', risk, serviceId: service.id }).expect(201)).body;
  if (submit) await org.owner.post(`${path(action.id)}/request-approval`).send({}).expect(200);
  return action.id as string;
}

/** Approvals recorded directly, as they would stand after people approved (`at` in the past for expired ones). */
async function approve(id: string, approvers: { userId: string; at?: Date }[], status: 'APPROVED' | 'PENDING_APPROVAL' = 'APPROVED') {
  const action = await prisma.remediationAction.findUniqueOrThrow({ where: { id } });
  for (const a of approvers) await prisma.approval.create({ data: { actionId: id, approverId: a.userId, decision: 'approved', contentHash: action.contentHash, createdAt: a.at ?? new Date() } });
  await prisma.remediationAction.update({ where: { id }, data: { status } });
}

const settings = (org: Org, body: Record<string, unknown>) => org.owner.patch('/api/v1/settings').send(body).expect(200);

// ───────────────────────── 1. Audit records match what happened ─────────────────────────

describe('audit records match the transitions that happened', () => {
  it('a transition that happens is audited with what it actually superseded', async () => {
    const org = await createOrg();
    const [a, b] = [await org.member('ADMIN'), await org.member('ADMIN')];
    const id = await proposal(org);
    await approve(id, [{ userId: a.userId }, { userId: b.userId }]);
    // Stored below the floor by an earlier version: execution raises it and sends it back.
    await prisma.remediationAction.update({ where: { id }, data: { risk: 'LOW' } });
    expect((await org.owner.post(`${path(id)}/execute`).send({ confirmManual: true })).status).toBe(409);
    const after = await row(id);
    expect(after.status).toBe('PROPOSED');
    expect((await auditOf(id)).find((x) => x.action === 'remediation.risk_raised')!.meta).toMatchObject({ previousStatus: 'APPROVED', supersededApprovals: 2 });
    expect(after.approvals.every((x) => x.supersededAt)).toBe(true);
  });

  it('when several requests find the same reason at once, one transition happens and one is audited', async () => {
    const org = await createOrg();
    const a = await org.member('ADMIN');
    const id = await proposal(org);
    await approve(id, [{ userId: a.userId }]);
    await prisma.remediationAction.update({ where: { id }, data: { risk: 'LOW' } });
    const runs = await Promise.all([1, 2, 3, 4].map(() => org.owner.post(`${path(id)}/execute`).send({ confirmManual: true })));
    expect(runs.every((r) => r.status === 409)).toBe(true);
    const raised = (await auditOf(id)).filter((x) => x.action === 'remediation.risk_raised');
    expect(raised).toHaveLength(1);
    expect(raised[0]!.meta).toMatchObject({ supersededApprovals: 1 });
    expect((await row(id)).status).toBe('PROPOSED');
  });

  it('a repeated request after the transition changes and audits nothing more', async () => {
    const org = await createOrg();
    const a = await org.member('ADMIN');
    const id = await proposal(org);
    await approve(id, [{ userId: a.userId }]);
    await prisma.remediationAction.update({ where: { id }, data: { risk: 'LOW' } });
    await org.owner.post(`${path(id)}/execute`).send({ confirmManual: true });
    const before = (await auditOf(id)).length;
    const again = await org.owner.post(`${path(id)}/execute`).send({ confirmManual: true });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toContain('Only approved actions can be executed');
    expect((await auditOf(id)).length).toBe(before);
  });

  it('an action that moved on before the transition is not sent back, keeps its approvals, and nothing is audited for it', async () => {
    const org = await createOrg();
    const a = await org.member('ADMIN');
    for (let round = 0; round < 4; round++) {
      const id = await proposal(org);
      await approve(id, [{ userId: a.userId }]);
      await prisma.remediationAction.update({ where: { id }, data: { risk: 'LOW' } });
      // Cancelled at the same moment as an execution that wants to send it back for review.
      await Promise.all([org.owner.post(`${path(id)}/execute`).send({ confirmManual: true }), org.owner.post(`${path(id)}/cancel`).send({})]);
      const after = await row(id);
      const raised = (await auditOf(id)).filter((x) => x.action === 'remediation.risk_raised');
      if (after.status === 'CANCELLED' && !raised.length) {
        // The cancel came first: nothing was superseded or claimed.
        expect(after.approvals.every((x) => !x.supersededAt)).toBe(true);
      } else {
        // The transition came first, then the cancel: it is audited once, with what it superseded.
        expect(raised).toHaveLength(1);
        expect(after.approvals.filter((x) => x.supersededAt)).toHaveLength(raised[0]!.meta.supersededApprovals as number);
      }
    }
  });
});

// ───────────────────────── 2. One lock order for approvals ─────────────────────────

describe('approving, rejecting, editing and expiring under one lock', () => {
  it('an approval and a rejection at the same moment: one wins, the other is refused, and the state agrees with the winner', async () => {
    const org = await createOrg();
    for (let round = 0; round < 4; round++) {
      const [a, b] = [await org.member('ADMIN'), await org.member('ADMIN')];
      const id = await proposal(org);
      const { currentHash } = (await org.owner.get(path(id))).body;
      const [ok, no] = await Promise.all([a.agent.post(`${path(id)}/approve`).send({ expectedHash: currentHash }), b.agent.post(`${path(id)}/reject`).send({ comment: 'Not this way.' })]);
      expect([ok.status, no.status].sort()).toEqual([200, 409]);
      const after = await row(id);
      expect(after.status).toBe(ok.status === 200 ? 'APPROVED' : 'REJECTED');
      expect(after.approvals.filter((x) => x.decision === 'rejected')).toHaveLength(no.status === 200 ? 1 : 0);
    }
  });

  it('two rejections at once record one', async () => {
    const org = await createOrg();
    const [a, b] = [await org.member('ADMIN'), await org.member('ADMIN')];
    const id = await proposal(org);
    const results = await Promise.all([a.agent.post(`${path(id)}/reject`).send({ comment: 'No.' }), b.agent.post(`${path(id)}/reject`).send({ comment: 'Also no.' })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await row(id)).approvals.filter((x) => x.decision === 'rejected')).toHaveLength(1);
  });

  it('a rejection and an edit at once: one wins, and the rejection is never recorded against content it did not see', async () => {
    const org = await createOrg();
    for (let round = 0; round < 4; round++) {
      const a = await org.member('ADMIN');
      const id = await proposal(org);
      const [no, edited] = await Promise.all([a.agent.post(`${path(id)}/reject`).send({ comment: 'No.' }), org.owner.patch(path(id)).send({ description: `Set DB_POOL_MAX=${50 + round}.` })]);
      expect([no.status, edited.status].sort()).toEqual([200, 409]);
      const after = await row(id);
      expect(after.status).toBe(no.status === 200 ? 'REJECTED' : 'PROPOSED');
    }
  });

  it('expired approvals are superseded only while the action is still in the expected state', async () => {
    const org = await createOrg();
    const a = await org.member('ADMIN');
    const id = await proposal(org);
    await approve(id, [{ userId: a.userId, at: new Date(Date.now() - (env.REMEDIATION_APPROVAL_VALIDITY_HOURS + 1) * HOUR) }]);
    await prisma.remediationAction.update({ where: { id }, data: { status: 'EXECUTING' } });
    expect((await supersedeExpired(id, 'APPROVED')).count).toBe(0);
    expect((await row(id)).approvals[0]!.supersededAt).toBeNull();
    await prisma.remediationAction.update({ where: { id }, data: { status: 'APPROVED' } });
    expect((await supersedeExpired(id, 'APPROVED')).count).toBe(1);
  });

  it('an invalidation changes nothing for an action that is no longer approved', async () => {
    const org = await createOrg();
    const a = await org.member('ADMIN');
    const id = await proposal(org);
    await approve(id, [{ userId: a.userId }]);
    await prisma.remediationAction.update({ where: { id }, data: { status: 'EXECUTING' } });
    expect(await invalidateApproval(id)).toBe(false);
    expect(await row(id)).toMatchObject({ status: 'EXECUTING' });
    expect((await row(id)).approvals[0]!.supersededAt).toBeNull();
    await prisma.remediationAction.update({ where: { id }, data: { status: 'APPROVED' } });
    expect(await invalidateApproval(id)).toBe(true);
    expect(await row(id)).toMatchObject({ status: 'PROPOSED', contentHash: null });
  });

  it('expiry at execution and a cancel at once: approvals are superseded only if the expiry came first, and its audit says where the action went', async () => {
    const org = await createOrg();
    for (let round = 0; round < 4; round++) {
      const [a, b] = [await org.member('ADMIN'), await org.member('ADMIN')];
      const id = await proposal(org, 'HIGH');
      await approve(id, [{ userId: a.userId }, { userId: b.userId, at: new Date(Date.now() - (env.REMEDIATION_APPROVAL_VALIDITY_HOURS + 1) * HOUR) }]);
      await Promise.all([org.owner.post(`${path(id)}/execute`).send({ confirmManual: true }), org.owner.post(`${path(id)}/cancel`).send({})]);
      const after = await row(id);
      const expired = (await auditOf(id)).filter((x) => x.action === 'remediation.approval_expired');
      expect(after.status).not.toBe('EXECUTED');
      expect(expired.length).toBeLessThanOrEqual(1);
      expect(after.approvals.filter((x) => x.supersededAt).length).toBe(expired.length ? (expired[0]!.meta.expired as number) : 0);
      if (expired.length) expect(['PENDING_APPROVAL', 'PROPOSED']).toContain(expired[0]!.meta.newStatus);
    }
  });

  it('rejected, expired and invalidated approvals stay distinguishable', async () => {
    const org = await createOrg();
    const [a, b] = [await org.member('ADMIN'), await org.member('ADMIN')];
    const rejected = await proposal(org);
    await b.agent.post(`${path(rejected)}/reject`).send({ comment: 'No.' }).expect(200);
    expect((await row(rejected)).approvals[0]).toMatchObject({ decision: 'rejected', supersededAt: null });

    const expiring = await proposal(org);
    await approve(expiring, [{ userId: a.userId, at: new Date(Date.now() - (env.REMEDIATION_APPROVAL_VALIDITY_HOURS + 1) * HOUR) }], 'PENDING_APPROVAL');
    const { currentHash } = (await org.owner.get(path(expiring))).body;
    await a.agent.post(`${path(expiring)}/approve`).send({ expectedHash: currentHash }).expect(200);
    expect((await auditOf(expiring)).map((x) => x.action)).toContain('remediation.approval_expired');

    const changed = await proposal(org);
    await approve(changed, [{ userId: a.userId }]);
    await prisma.remediationAction.update({ where: { id: changed }, data: { description: 'Set DB_POOL_MAX=400.' } });
    await org.owner.post(`${path(changed)}/execute`).send({ confirmManual: true }).expect(409);
    expect((await auditOf(changed)).at(-1)!.action).toBe('remediation.approval_invalid');
  });
});

// ───────────────────────── 3. Webhook failures never name the destination ─────────────────────────

describe('webhook failures are described by category only', () => {
  const SECRETS = ['secret-host', 'hooks.internal', 'token=', 'abc123', 'user:pw', '127.0.0.1', '10.1.2.3', 'internal.example'];
  const leak = (value: unknown) => SECRETS.filter((s) => JSON.stringify(value).includes(s));
  const err = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), extra);

  it.each([
    ['DNS resolution failure', err('getaddrinfo ENOTFOUND hooks.internal.secret-host', { code: 'ENOTFOUND', hostname: 'hooks.internal.secret-host' }), 'resolve'],
    ['connection refusal', err('connect ECONNREFUSED 10.1.2.3:443', { code: 'ECONNREFUSED', address: '10.1.2.3' }), 'refused'],
    ['timeout', err('The operation was aborted due to timeout', { name: 'TimeoutError' }), 'timeout'],
    ['TLS certificate failure', err("Hostname/IP does not match certificate's altnames: Host: secret-host. is not in the cert's altnames", { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), 'tls'],
    ['TLS protocol failure', err('write EPROTO 80:error:0A00010B:SSL routines:wrong version number', { code: 'EPROTO' }), 'tls'],
    ['a nested cause', new Error('fetch failed', { cause: err('connect ECONNREFUSED 10.1.2.3:443', { code: 'ECONNREFUSED' }) }), 'refused'],
    ['an aggregate of attempts', Object.assign(new AggregateError([err('connect ETIMEDOUT 10.1.2.3:443', { code: 'ETIMEDOUT' })], 'all failed'), {}), 'timeout'],
    ['an unexpected error naming the URL', err('request to https://user:pw@secret-host/hook?token=abc123 failed, reason: something odd'), 'other'],
  ])('%s', (_label, error, expected) => {
    expect(networkFailure(error)).toBe(expected);
  });

  let server: Server;
  let closedPort = 0;
  let respond: (res: import('node:http').ServerResponse) => void = (res) => res.writeHead(200).end();
  beforeAll(async () => {
    netConfig.allowPrivate = true;
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => respond(res));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    // A port that was just free: connecting to it is refused. (Port 9 would be refused by fetch itself, as a blocked port.)
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    closedPort = (probe.address() as AddressInfo).port;
    await new Promise((resolve) => probe.close(resolve));
  });
  afterAll(async () => {
    netConfig.allowPrivate = false;
    await new Promise((resolve) => server.close(resolve));
  });
  const realResolve = netConfig.resolve;
  afterEach(() => {
    netConfig.resolve = realResolve;
    env.REMEDIATION_WEBHOOK_TIMEOUT_MS = 30_000;
    respond = (res) => res.writeHead(200).end();
  });
  const port = () => (server.address() as AddressInfo).port;

  /** Executes an approved action against `url` (written straight to the settings, as an operator could have saved it) and returns everything stored about it. */
  async function executeAgainst(url: string) {
    const org = await createOrg();
    const a = await org.member('ADMIN');
    const id = await proposal(org);
    await prisma.organizationSettings.update({ where: { organizationId: org.organizationId }, data: { remediationWebhookUrl: url } });
    // Approved under the current target: re-read the fingerprint the page would show, then approve.
    await prisma.remediationAction.update({ where: { id }, data: { status: 'PROPOSED', contentHash: null } });
    await org.owner.post(`${path(id)}/request-approval`).send({}).expect(200);
    const { currentHash } = (await org.owner.get(path(id))).body;
    await a.agent.post(`${path(id)}/approve`).send({ expectedHash: currentHash }).expect(200);
    const result = (await org.owner.post(`${path(id)}/execute`).send({})).body;
    const audits = await auditOf(id);
    const events = await prisma.incidentEvent.findMany({ where: { metadata: { path: ['actionId'], equals: id } } });
    return { result, audits, events, stored: (await row(id)).executionResult as { summary: string; outcome: string; detail?: { failure?: string } } };
  }

  it.each([
    ['DNS resolution failure', () => {
      netConfig.resolve = async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND hooks.internal.secret-host'), { code: 'ENOTFOUND' });
      };
      return 'https://hooks.internal.secret-host/hook?token=abc123';
    }, 'resolve', 'not_applied'],
    ['connection refusal', () => `http://127.0.0.1:${closedPort}/hook?token=abc123`, 'refused', 'unknown'],
    ['TLS failure', () => `https://127.0.0.1:${port()}/hook?token=abc123`, 'tls', 'unknown'],
    ['timeout', () => {
      env.REMEDIATION_WEBHOOK_TIMEOUT_MS = 150;
      respond = (res) => setTimeout(() => res.writeHead(200).end(), 1_000);
      return `http://127.0.0.1:${port()}/hook?token=abc123`;
    }, 'timeout', 'unknown'],
    ['a URL carrying credentials', () => `http://user:pw@127.0.0.1:${closedPort}/hook?token=abc123`, 'invalid', 'not_applied'],
  ])('%s: the summary, audit and timeline name a category, never the host, address, URL or credentials', async (_label, setUp, failure, outcome) => {
    const url = setUp();
    const { stored, audits, events } = await executeAgainst(url);
    expect(stored).toMatchObject({ outcome, detail: { failure } });
    expect(leak(stored)).toEqual([]);
    expect(leak(audits)).toEqual([]);
    expect(leak(events)).toEqual([]);
  });

  it('a redirect is not followed, and where it pointed is not recorded', async () => {
    respond = (res) => res.writeHead(302, { location: 'https://internal.example/elsewhere?token=abc123' }).end();
    const { stored, audits } = await executeAgainst(`http://127.0.0.1:${port()}/hook`);
    expect(stored.summary).toContain('HTTP 302');
    expect(leak(stored)).toEqual([]);
    expect(leak(audits)).toEqual([]);
  });

  it('saving a webhook address records that it changed, not the address', async () => {
    const org = await createOrg();
    await settings(org, { remediationWebhookUrl: `http://127.0.0.1:${port()}/hook?token=abc123` });
    await settings(org, { remediationWebhookUrl: null });
    const trail = await prisma.auditLog.findMany({ where: { organizationId: org.organizationId, action: 'settings.update' }, orderBy: { createdAt: 'asc' } });
    expect(trail.map((t) => (t.metadata as Record<string, unknown>).remediationWebhookUrl)).toEqual(['[changed]', '[removed]']);
    expect(leak(trail.map((t) => t.metadata))).toEqual([]);
  });
});

// ───────────────────────── 4. The approval threshold only goes up ─────────────────────────

describe('the number of approvals an action needs never goes down', () => {
  it('raised in the settings after submission: the higher number applies at approval and execution', async () => {
    const org = await createOrg();
    const [a, b] = [await org.member('ADMIN'), await org.member('ADMIN')];
    const id = await proposal(org);
    expect((await row(id)).requiredApprovals).toBe(1);
    await settings(org, { approvalsMediumRisk: 2 });
    const { currentHash } = (await org.owner.get(path(id))).body;
    expect((await a.agent.post(`${path(id)}/approve`).send({ expectedHash: currentHash }).expect(200)).body.status).toBe('PENDING_APPROVAL');
    expect((await row(id)).requiredApprovals).toBe(2);
    await b.agent.post(`${path(id)}/approve`).send({ expectedHash: currentHash }).expect(200);
    expect((await org.owner.post(`${path(id)}/execute`).send({ confirmManual: true }).expect(200)).body.status).toBe('EXECUTED');
  });

  it('lowered in the settings after submission: the action keeps needing what it needed', async () => {
    const org = await createOrg();
    const a = await org.member('ADMIN');
    const id = await proposal(org, 'HIGH');
    expect((await row(id)).requiredApprovals).toBe(2);
    await settings(org, { approvalsHighRisk: 1 });
    const { currentHash } = (await org.owner.get(path(id))).body;
    expect((await a.agent.post(`${path(id)}/approve`).send({ expectedHash: currentHash }).expect(200)).body.status).toBe('PENDING_APPROVAL');
    expect((await row(id)).requiredApprovals).toBe(2);
  });

  it('an unchanged edit leaves the number alone, also after the settings were lowered', async () => {
    const org = await createOrg();
    const id = await proposal(org, 'HIGH');
    await settings(org, { approvalsHighRisk: 1 });
    const before = await row(id);
    await org.owner.patch(path(id)).send({ title: before.title, description: before.description }).expect(200);
    expect(await row(id)).toMatchObject({ requiredApprovals: 2, status: 'PENDING_APPROVAL' });
  });

  it('a content edit sends it back for approval and keeps the number, through resubmission', async () => {
    const org = await createOrg();
    const id = await proposal(org, 'HIGH');
    await settings(org, { approvalsHighRisk: 1 });
    await org.owner.patch(path(id)).send({ description: 'Set DB_POOL_MAX=60.' }).expect(200);
    expect(await row(id)).toMatchObject({ requiredApprovals: 2, status: 'PROPOSED' });
    await org.owner.post(`${path(id)}/request-approval`).send({}).expect(200);
    expect((await row(id)).requiredApprovals).toBe(2);
  });

  it('a risk increase raises the number and needs fresh approval; the risk cannot be lowered back', async () => {
    const org = await createOrg();
    const a = await org.member('ADMIN');
    const id = await proposal(org);
    await approve(id, [{ userId: a.userId }]);
    const raised = (await org.owner.patch(path(id)).send({ risk: 'HIGH' }).expect(200)).body;
    expect(raised).toMatchObject({ risk: 'HIGH', status: 'PROPOSED', requiredApprovals: 2, approvalsGranted: 0 });
    expect((await org.owner.patch(path(id)).send({ risk: 'MEDIUM' })).status).toBe(400);
  });

  it('lowering the settings while the action is edited never lowers the number', async () => {
    const org = await createOrg();
    for (let round = 0; round < 4; round++) {
      await settings(org, { approvalsHighRisk: 2 });
      const id = await proposal(org, 'HIGH');
      const before = await row(id);
      await Promise.all([settings(org, { approvalsHighRisk: 1 }), org.owner.patch(path(id)).send({ title: before.title }), org.owner.patch(path(id)).send({ description: `Set DB_POOL_MAX=${70 + round}.` })]);
      expect((await row(id)).requiredApprovals).toBeGreaterThanOrEqual(2);
    }
  });

  it('at execution the higher of the recorded and the current number applies', async () => {
    const org = await createOrg();
    const [a, b] = [await org.member('ADMIN'), await org.member('ADMIN')];
    // Lowered after approval: the two approvals it was approved with still suffice, and are required.
    const lowered = await proposal(org, 'HIGH');
    await approve(lowered, [{ userId: a.userId }, { userId: b.userId }]);
    await settings(org, { approvalsHighRisk: 1 });
    expect((await org.owner.post(`${path(lowered)}/execute`).send({ confirmManual: true }).expect(200)).body.status).toBe('EXECUTED');
    // Raised after approval: refused until the extra approval is given.
    await settings(org, { approvalsHighRisk: 2 });
    const raised = await proposal(org, 'HIGH');
    await approve(raised, [{ userId: a.userId }, { userId: b.userId }]);
    await settings(org, { approvalsHighRisk: 3 });
    const run = await org.owner.post(`${path(raised)}/execute`).send({ confirmManual: true });
    expect(run.status).toBe(409);
    expect(run.body.error.message).toContain('needs 3 approvals and has 2');
    expect(await row(raised)).toMatchObject({ status: 'PENDING_APPROVAL', requiredApprovals: 3 });
    expect((await auditOf(raised)).at(-1)).toMatchObject({ action: 'remediation.approval_insufficient', meta: { newStatus: 'PENDING_APPROVAL', required: 3 } });
  });
});
