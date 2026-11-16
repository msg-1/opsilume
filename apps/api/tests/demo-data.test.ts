import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvalHash, contentHash, executionTarget } from '../src/modules/remediation/content';
import { sourceRequired } from '../src/modules/remediation/source';
import { PASSWORD, app, prisma } from './helpers';

// The manual-testing dataset (scripts/demo-data.ts), run as people run it, against the test
// database. Its pending actions must be approvable through the normal application path.
// Nothing leaves this machine: the AI service URL points at a closed local port and no webhook is set.

const SLUG = 'acme-commerce-demo';
const ACCOUNTS = [
  ['demo@example.com', 'Priya Raman'],
  ['marcus@example.com', 'Marcus Oyelaran'],
  ['lena@example.com', 'Lena Fischer'],
  ['tomas@example.com', 'Tomás Herrera'],
  ['aiko@example.com', 'Aiko Tanaka'],
] as const;

function script(...args: string[]) {
  const run = spawnSync(resolve(__dirname, '../../../node_modules/.bin/tsx'), ['scripts/demo-data.ts', ...args], { cwd: resolve(__dirname, '..'), env: process.env, encoding: 'utf8', timeout: 180_000 });
  if (run.status !== 0) throw new Error(`demo-data ${args.join(' ')} failed (${run.status}): ${run.stderr}`);
  return run.stdout;
}

const demoOrg = () => prisma.organization.findUniqueOrThrow({ where: { slug: SLUG } });
const pending = async () => prisma.remediationAction.findMany({ where: { organizationId: (await demoOrg()).id, status: 'PENDING_APPROVAL' }, orderBy: { risk: 'asc' } });

async function signIn(email: string) {
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD, organizationId: (await demoOrg()).id }).expect(200);
  return agent;
}

beforeAll(async () => {
  // The standard demo accounts the script attaches to its organisation (npm run db:seed creates them elsewhere).
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  for (const [email, name] of ACCOUNTS) await prisma.user.upsert({ where: { email }, create: { email, name, passwordHash }, update: { passwordHash, isActive: true } });
  script('reset', '--yes');
  script('seed');
}, 400_000);

afterAll(() => {
  script('reset', '--yes');
}, 200_000);

describe('the demo dataset submits its actions with the fingerprint the application checks', () => {
  it('stores the approval fingerprint (content, manual target, no source review), not the content fingerprint', async () => {
    const actions = await pending();
    expect(actions.map((a) => [a.risk, a.requiredApprovals])).toEqual([['MEDIUM', 1], ['HIGH', 2]]);
    const settings = await prisma.organizationSettings.findUniqueOrThrow({ where: { organizationId: (await demoOrg()).id } });
    expect(executionTarget(settings)).toBe('manual');
    for (const a of actions) {
      // People's proposals with no source investigation: no source review is part of the fingerprint.
      expect(sourceRequired(a)).toBe(false);
      expect(a.contentHash).toBe(approvalHash(a, { unverifiedSource: false, executionTarget: 'manual' }));
      expect(a.contentHash).not.toBe(contentHash(a));
      expect(a.contentHash).not.toBe(approvalHash(a, { unverifiedSource: false, executionTarget: executionTarget({ remediationWebhookUrl: 'https://hooks.example.invalid/x' }) }));
      expect(a.contentHash).not.toBe(approvalHash(a, { unverifiedSource: true, executionTarget: 'manual' }));
    }
  });

  it('the application agrees: the action is shown with the fingerprint it was submitted under', async () => {
    const owner = await signIn('demo@example.com');
    for (const a of await pending()) expect((await owner.get(`/api/v1/remediations/${a.id}`).expect(200)).body.currentHash).toBe(a.contentHash);
  });

  it('the medium-risk restart is approved by the owner on the first attempt and can then be carried out by hand', async () => {
    const [restart] = await pending();
    const owner = await signIn('demo@example.com');
    const { currentHash } = (await owner.get(`/api/v1/remediations/${restart!.id}`)).body;
    const approved = await owner.post(`/api/v1/remediations/${restart!.id}/approve`).send({ expectedHash: currentHash });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('APPROVED');
    const done = await owner.post(`/api/v1/remediations/${restart!.id}/execute`).send({ confirmManual: true, notes: 'Restarted by hand in the demo.' });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('EXECUTED');
    const trail = await prisma.auditLog.findMany({ where: { resourceId: restart!.id }, select: { action: true } });
    expect(trail.map((t) => t.action)).not.toContain('remediation.approval_invalid');
  });

  it('the high-risk change needs and gets two approvals, by the owner and the admin', async () => {
    const [resize] = await pending();
    expect(resize!.risk).toBe('HIGH');
    for (const [email, status] of [['demo@example.com', 'PENDING_APPROVAL'], ['marcus@example.com', 'APPROVED']] as const) {
      const agent = await signIn(email);
      const { currentHash } = (await agent.get(`/api/v1/remediations/${resize!.id}`)).body;
      const res = await agent.post(`/api/v1/remediations/${resize!.id}/approve`).send({ expectedHash: currentHash });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(status);
    }
  });

  it('seeding again changes nothing', async () => {
    const before = await prisma.remediationAction.findMany({ where: { organizationId: (await demoOrg()).id }, select: { id: true, status: true, contentHash: true }, orderBy: { id: 'asc' } });
    expect(script('seed')).toContain('already exists; nothing was created');
    expect(await prisma.remediationAction.findMany({ where: { organizationId: (await demoOrg()).id }, select: { id: true, status: true, contentHash: true }, orderBy: { id: 'asc' } })).toEqual(before);
  });

  it('after a reset, seeding again gives pending actions that are approvable again', async () => {
    script('reset', '--yes');
    script('seed');
    const actions = await pending();
    expect(actions).toHaveLength(2);
    for (const a of actions) expect(a.contentHash).toBe(approvalHash(a, { unverifiedSource: false, executionTarget: 'manual' }));
    const owner = await signIn('demo@example.com');
    const { currentHash } = (await owner.get(`/api/v1/remediations/${actions[0]!.id}`)).body;
    expect((await owner.post(`/api/v1/remediations/${actions[0]!.id}/approve`).send({ expectedHash: currentHash })).body.status).toBe('APPROVED');
  }, 400_000);
});
