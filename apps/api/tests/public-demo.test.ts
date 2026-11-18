import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { createApp } from '../src/app';
import { aiService } from '../src/integrations/aiService';
import { DEMO_PASSWORD, DEMO_VISITOR_EMAIL } from '../src/lib/demo';
import { type TestOrg, app, createOrg, prisma } from './helpers';

// The public demonstration (docs/deployment/PUBLIC_DEMO_MODE.md): the security boundary of the
// visitor, the refusals that hold for everyone in demo mode, and the setup and reset tooling, run as
// operators run it (scripts/public-demo.ts) against the test database. Nothing leaves this machine:
// the AI service URL points at a closed local port, and no webhook is configured.

const SLUG = 'acme-commerce-demo';
const TSX = resolve(__dirname, '../../../node_modules/.bin/tsx');
const scriptEnv = (over: Record<string, string> = {}) => ({ ...process.env, PUBLIC_DEMO_MODE: 'true', ...over });

function demoScript(...args: string[]) {
  const run = spawnSync(TSX, ['scripts/public-demo.ts', ...args], { cwd: resolve(__dirname, '..'), env: scriptEnv(), encoding: 'utf8', timeout: 180_000 });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}
function demoScriptAsync(...args: string[]): Promise<{ status: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(TSX, ['scripts/public-demo.ts', ...args], { cwd: resolve(__dirname, '..'), env: scriptEnv() });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (status) => done({ status, out }));
  });
}

const demoOrg = () => prisma.organization.findUniqueOrThrow({ where: { slug: SLUG } });

async function visitor() {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/demo').expect(200);
  // The session this entry created (the newest visitor session); it owns what the visitor starts.
  const session = (await prisma.refreshToken.findFirstOrThrow({ where: { user: { email: DEMO_VISITOR_EMAIL } }, orderBy: { createdAt: 'desc' } })).demoSessionId!;
  return { agent, res, session };
}

/** Runs something as it would be outside the public demonstration (e.g. an owner elsewhere checking a route exists). */
async function outsideDemo<T>(work: () => Promise<T>): Promise<T> {
  env.PUBLIC_DEMO_MODE = false;
  try {
    return await work();
  } finally {
    env.PUBLIC_DEMO_MODE = true;
  }
}

const heuristic = { llm: { provider: 'heuristic', model: null, available: false }, embeddings: { provider: 'local', model: 'l', dimensions: 768 } } as never;

let other: TestOrg;
let otherIncident: string;

beforeAll(async () => {
  // An ordinary organisation, created before demo mode is on (registration is refused in demo mode).
  other = await createOrg('Private Org');
  otherIncident = (await other.owner.post('/api/v1/incidents').send({ title: 'Private incident', severity: 'SEV3' }).expect(201)).body.id;
  // Start from a clean demonstration organisation (another suite may have left the manual dataset).
  const existing = await prisma.organization.findUnique({ where: { slug: SLUG } });
  if (existing) expect(demoScript('reset').status).toBe(0);
  else expect(demoScript('setup').status).toBe(0);
  env.PUBLIC_DEMO_MODE = true;
}, 300_000);

afterAll(() => {
  env.PUBLIC_DEMO_MODE = false;
  env.COOKIE_SECURE = false;
});

describe('the demo-mode flag', () => {
  const load = (value: string | undefined) =>
    spawnSync('npx', ['tsx', '-e', "const {env}=require('./src/config/env'); process.stdout.write(String(env.PUBLIC_DEMO_MODE))"], {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, PUBLIC_DEMO_MODE: value },
      encoding: 'utf8',
    });
  it('is off unless set to exactly "true"; any other value stops the process', () => {
    const unset = spawnSync('npx', ['tsx', '-e', "const {env}=require('./src/config/env'); process.stdout.write(String(env.PUBLIC_DEMO_MODE))"], {
      cwd: resolve(__dirname, '..'),
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'PUBLIC_DEMO_MODE')),
      encoding: 'utf8',
    });
    expect(unset.stdout).toBe('false');
    expect(load('false').stdout).toBe('false');
    expect(load('true').stdout).toBe('true');
    for (const bad of ['yes', '1', 'TRUE', 'on', ' true']) {
      const run = load(bad);
      expect(run.status, bad).not.toBe(0);
      expect(run.stderr, bad).toMatch(/PUBLIC_DEMO_MODE must be "true" or "false"/);
    }
  });
});

describe('visitor authentication', () => {
  it('enters without a password, as a VIEWER of the demonstration organisation with read and investigation rights only', async () => {
    expect((await request(app).get('/api/v1/auth/demo').expect(200)).body).toEqual({ enabled: true });
    const { res } = await visitor();
    expect(res.body.user.email).toBe(DEMO_VISITOR_EMAIL);
    expect(res.body.organization.slug).toBe(SLUG);
    expect(res.body.role).toBe('VIEWER');
    expect(res.body.demoVisitor).toBe(true);
    expect(res.body.permissions).toEqual(['read', 'investigation:run']);
    expect(res.body.organizations).toHaveLength(1);
    // Session cookies as everywhere: HttpOnly, SameSite=Lax.
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    expect(cookies.length).toBeGreaterThan(0);
    for (const c of cookies) expect(c).toMatch(/HttpOnly/i);
    for (const c of cookies) expect(c).toMatch(/SameSite=Lax/i);
  });

  it('with COOKIE_SECURE the session cookies are Secure', async () => {
    env.COOKIE_SECURE = true;
    try {
      const res = await request(app).post('/api/v1/auth/demo').expect(200);
      for (const c of ([] as string[]).concat(res.headers['set-cookie'] ?? [])) expect(c).toMatch(/;\s*Secure/i);
    } finally {
      env.COOKIE_SECURE = false;
    }
  });

  it('nobody signs in with a password: not the visitor, not the documented password, not an owner with their real password', async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: 'demo@example.com' } });
    const saved = owner.passwordHash;
    // Even an owner persona that really has the documented password (a database seeded locally, then put online).
    await prisma.user.update({ where: { id: owner.id }, data: { passwordHash: await bcrypt.hash(DEMO_PASSWORD, 4) } });
    try {
      for (const [email, password] of [[DEMO_VISITOR_EMAIL, 'anything-1234'], ['demo@example.com', DEMO_PASSWORD], [(await prisma.user.findUniqueOrThrow({ where: { id: other.ownerId } })).email, 'Sup3r-secret-pw']]) {
        const res = await request(app).post('/api/v1/auth/login').send({ email, password });
        expect(res.status, email).toBe(403);
        expect(res.body.error.code).toBe('demo_restricted');
        expect(res.headers['set-cookie']).toBeUndefined();
      }
    } finally {
      await prisma.user.update({ where: { id: owner.id }, data: { passwordHash: saved } });
    }
  });

  it('invitations can be neither previewed nor accepted, so no account joins the demonstration that way', async () => {
    const invite = await outsideDemo(() => other.owner.post('/api/v1/members/invitations').send({ email: 'joiner@example.com', role: 'ADMIN' }).expect(201));
    expect((await request(app).get(`/api/v1/auth/invitations/${invite.body.token}`)).status).toBe(403);
    expect((await request(app).post('/api/v1/auth/accept-invitation').send({ token: invite.body.token, name: 'J', password: 'Sup3r-secret-pw' })).status).toBe(403);
    expect(await prisma.user.findUnique({ where: { email: 'joiner@example.com' } })).toBeNull();
  });

  it('setup refuses to run when the retired PUBLIC_DEMO_OWNER_PASSWORD is set', () => {
    const run = spawnSync(TSX, ['scripts/public-demo.ts', 'setup'], { cwd: resolve(__dirname, '..'), env: scriptEnv({ PUBLIC_DEMO_OWNER_PASSWORD: 'a-long-operator-password-1' }), encoding: 'utf8', timeout: 120_000 });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/no longer supported/);
  });

  it('the persona accounts created by the setup have passwords nobody knows', async () => {
    for (const email of ['demo@example.com', 'marcus@example.com', 'lena@example.com', 'tomas@example.com', 'aiko@example.com', DEMO_VISITOR_EMAIL]) {
      const u = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(await bcrypt.compare(DEMO_PASSWORD, u.passwordHash), email).toBe(false);
    }
  });

  it('registration is refused, for everyone', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({ email: 'new@example.com', password: 'Sup3r-secret-pw', name: 'New', organizationName: 'New Org' }).expect(403);
    expect(res.body.error.code).toBe('demo_restricted');
    expect(await prisma.user.findUnique({ where: { email: 'new@example.com' } })).toBeNull();
  });

  it('an invalid or missing visitor session is rejected', async () => {
    await request(app).get('/api/v1/incidents').expect(401);
    await request(app).get('/api/v1/incidents').set('Cookie', 'op_access=not-a-token').expect(401);
  });

  it('without demo mode the visitor entry does not exist and the flag is reported off', async () => {
    env.PUBLIC_DEMO_MODE = false;
    try {
      expect((await request(app).get('/api/v1/auth/demo').expect(200)).body).toEqual({ enabled: false });
      await request(app).post('/api/v1/auth/demo').expect(404);
    } finally {
      env.PUBLIC_DEMO_MODE = true;
    }
  });
});

describe('what the visitor can do', () => {
  it('reads the demonstration organisation: dashboard, services, incidents, logs, deployments, changes, knowledge, remediation, investigations', async () => {
    const { agent } = await visitor();
    for (const path of ['/dashboard', '/services', '/services/graph', '/incidents', '/logs', '/deployments', '/service-events', '/github/commits', '/knowledge/documents', '/remediations', '/investigations', '/monitoring/overview', '/analytics/overview', '/members', '/settings']) {
      await agent.get(`/api/v1${path}`).expect(200);
    }
    const incidents = (await agent.get('/api/v1/incidents').expect(200)).body.data as { title: string }[];
    expect(incidents.length).toBeGreaterThanOrEqual(5);
    expect(incidents.map((i) => i.title)).not.toContain('Private incident');
    await agent.post('/api/v1/knowledge/search').send({ query: 'redis' }).expect(200);
  });

  it('never sees another organisation: a private incident by id is not found', async () => {
    const { agent } = await visitor();
    await agent.get(`/api/v1/incidents/${otherIncident}`).expect(404);
  });

  it('starts an investigation only when the analysis service runs the rule-based engine', async () => {
    const { agent } = await visitor();
    const incident = (await prisma.incident.findFirstOrThrow({ where: { organizationId: (await demoOrg()).id, status: { not: 'CLOSED' } } })).id;
    // The analysis service cannot be reached here: nothing starts.
    const unreachable = await agent.post('/api/v1/investigations').send({ incidentId: incident, question: 'What happened?' }).expect(503);
    expect(unreachable.body.error.code).toBe('demo_engine_unavailable');
    // Configured with a model: nothing starts either.
    const spy = vi.spyOn(aiService, 'status').mockResolvedValue({ llm: { provider: 'anthropic', model: 'x', available: true }, embeddings: { provider: 'local', model: 'l', dimensions: 768 } } as never);
    try {
      await agent.post('/api/v1/investigations').send({ incidentId: incident, question: 'What happened?' }).expect(503);
      expect(await prisma.investigation.count({ where: { incidentId: incident, question: 'What happened?' } })).toBe(0);
      spy.mockResolvedValue(heuristic);
      const started = await agent.post('/api/v1/investigations').send({ incidentId: incident, question: 'What happened?' });
      expect(started.status).toBe(202);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('what the visitor cannot do, even by calling the API directly', () => {
  const refused: [method: 'post' | 'patch' | 'put' | 'delete' | 'get', path: string, body?: object][] = [
    ['post', '/incidents', { title: 'x', severity: 'SEV3' }],
    ['post', '/services', { name: 'x', slug: 'x' }],
    ['post', '/deployments', {}],
    ['post', '/service-events', { service: 'x', type: 'restart', title: 'x' }],
    ['post', '/logs', { entries: [{ service: 'x', message: 'x' }] }],
    ['post', '/monitoring/metrics', { samples: [] }],
    ['post', '/monitoring/evaluate', {}],
    ['post', '/monitoring/alert-rules', { name: 'x' }],
    ['post', '/knowledge/documents', { title: 'x', content: 'x' }],
    ['post', '/knowledge/reindex', {}],
    ['post', '/members/invitations', { email: 'x@example.com', role: 'ADMIN' }],
    ['post', '/teams', { name: 'x' }],
    ['patch', '/settings', { remediationWebhookUrl: 'https://example.com/hook' }],
    ['get', '/api-keys'],
    ['post', '/api-keys', { name: 'x', scopes: ['ingest:logs'] }],
    ['get', '/audit-logs'],
    ['put', '/github/integration', { token: 'ghp_x' }],
    ['post', '/github/repositories', { owner: 'x', name: 'y' }],
    ['post', '/github/sync', {}],
    ['post', '/integrations/github/check', {}],
    ['post', '/integrations/remediation-webhook/check', {}],
    ['post', '/integrations/unresolved-services/link', {}],
    ['post', '/remediations', { title: 'x', type: 'manual', risk: 'LOW' }],
    ['patch', '/auth/profile', { name: 'Hijacked' }],
    ['post', '/auth/switch-organization', { organizationId: 'x' }],
  ];
  it.each(refused)('%s %s is refused', async (method, path, body) => {
    // The route exists (an owner elsewhere, outside demo mode, is not told "not found"), so the refusal is the guard's, not a typo's.
    expect((await outsideDemo(() => other.owner[method](`/api/v1${path}`).send(body ?? {}))).status, 'route exists').not.toBe(404);
    const { agent } = await visitor();
    const res = await agent[method](`/api/v1${path}`).send(body ?? {});
    expect(res.status).toBe(403);
    // No implementation detail in the answer.
    expect(JSON.stringify(res.body)).not.toMatch(/stack|prisma|sql/i);
  });

  it('a path is matched as the API routes it: a fragment or query cannot make one request look like another', async () => {
    const { visitorMayRequest } = await import('../src/lib/demo');
    expect(visitorMayRequest('POST', '/api/v1/investigations/a#b/cancel')).toBe(false);
    expect(visitorMayRequest('POST', '/api/v1/incidents?x=/api/v1/investigations')).toBe(false);
    expect(visitorMayRequest('POST', '/api/v1/investigations/x/cancel?y=1')).toBe(true);
    expect(visitorMayRequest('DELETE', '/api/v1/investigations')).toBe(false);
  });

  it('cannot approve, reject, execute, retry, reconcile, cancel or edit a pending remediation of the demonstration', async () => {
    const { agent } = await visitor();
    const action = await prisma.remediationAction.findFirstOrThrow({ where: { organizationId: (await demoOrg()).id, status: 'PENDING_APPROVAL' } });
    for (const step of ['approve', 'reject', 'execute', 'retry', 'reconcile', 'cancel', 'request-approval']) {
      expect((await agent.post(`/api/v1/remediations/${action.id}/${step}`).send({ comment: 'x' })).status, step).toBe(403);
    }
    expect((await agent.patch(`/api/v1/remediations/${action.id}`).send({ title: 'x' })).status).toBe(403);
    const after = await prisma.remediationAction.findUniqueOrThrow({ where: { id: action.id } });
    expect([after.status, after.title]).toEqual([action.status, action.title]);
  });

  it('cannot modify members, teams, documents, incidents or services through their item routes either', async () => {
    const { agent } = await visitor();
    const orgId = (await demoOrg()).id;
    const member = await prisma.membership.findFirstOrThrow({ where: { organizationId: orgId, role: 'OWNER' } });
    const team = await prisma.team.findFirstOrThrow({ where: { organizationId: orgId } });
    const doc = await prisma.knowledgeDocument.findFirstOrThrow({ where: { organizationId: orgId } });
    const incident = await prisma.incident.findFirstOrThrow({ where: { organizationId: orgId } });
    const service = await prisma.service.findFirstOrThrow({ where: { organizationId: orgId } });
    for (const [method, path] of [
      ['patch', `/members/${member.id}`], ['delete', `/members/${member.id}`], ['delete', `/teams/${team.id}`], ['patch', `/knowledge/documents/${doc.id}`],
      ['delete', `/knowledge/documents/${doc.id}`], ['patch', `/incidents/${incident.id}`], ['post', `/incidents/${incident.id}/comments`], ['post', `/incidents/${incident.id}/postmortem`],
      ['delete', `/services/${service.id}`], ['put', `/services/${service.id}/dependencies`], ['put', `/incidents/${incident.id}`],
    ] as const) {
      expect((await agent[method](`/api/v1${path}`).send({ role: 'OWNER', status: 'RESOLVED', body: 'x', dependsOn: [] })).status, `${method} ${path}`).toBe(403);
    }
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: member.id } })).role).toBe('OWNER');
  });

  it('the GitHub webhook entry does not exist in demo mode', async () => {
    expect((await request(app).post(`/api/v1/webhooks/github/${SLUG}`).set('x-github-event', 'ping').send({})).status).toBe(404);
    expect((await request(app).post('/api/v1/webhooks/github/no-such-org').send({})).status).toBe(404);
  });

  it('in demo mode only the visitor is signed in: an existing session of anyone else and every API key are refused', async () => {
    const key = await outsideDemo(async () => (await other.owner.post('/api/v1/api-keys').send({ name: 'ingest', scopes: ['ingest:logs', 'tools:read'] }).expect(201)).body.secret as string);
    await other.owner.get('/api/v1/incidents').expect(401);
    await other.owner.post('/api/v1/incidents').send({ title: 'Refused', severity: 'SEV4' }).expect(401);
    await request(app).get('/api/v1/tools/services').set('x-api-key', key).expect(401);
    await request(app).post('/api/v1/logs').set('Authorization', `Bearer ${key}`).send({ entries: [{ service: 'x', message: 'x' }] }).expect(401);
    // Outside demo mode the same owner and key work as ever: nothing about them was changed.
    await outsideDemo(async () => {
      await other.owner.post('/api/v1/incidents').send({ title: 'Still allowed', severity: 'SEV4' }).expect(201);
      await request(app).get('/api/v1/tools/services').set('x-api-key', key).expect(200);
    });
  });
});

describe('visitor sessions are kept apart, and bounded', () => {
  let spy: ReturnType<typeof vi.spyOn>;
  const limits = { session: env.DEMO_SESSION_INVESTIGATION_LIMIT, address: env.DEMO_ADDRESS_DAILY_INVESTIGATION_LIMIT };
  beforeEach(async () => {
    spy = vi.spyOn(aiService, 'status').mockResolvedValue(heuristic);
    // Every test here starts from no visitor investigation (they all come from the same test address).
    await prisma.investigation.deleteMany({ where: { organizationId: (await demoOrg()).id, demoSessionId: { not: null } } });
    env.DEMO_SESSION_INVESTIGATION_LIMIT = 3;
    env.DEMO_ADDRESS_DAILY_INVESTIGATION_LIMIT = 10;
  });
  afterEach(() => {
    spy.mockRestore();
    env.DEMO_SESSION_INVESTIGATION_LIMIT = limits.session;
    env.DEMO_ADDRESS_DAILY_INVESTIGATION_LIMIT = limits.address;
  });
  const openIncident = async () => (await prisma.incident.findFirstOrThrow({ where: { organizationId: (await demoOrg()).id, status: { not: 'CLOSED' } }, orderBy: { number: 'asc' } })).id;
  /** A run as the worker leaves it while it is still going (the inline test queue would finish it at once). */
  const running = async (demoSessionId: string | null, question = 'Seeded question') =>
    prisma.investigation.create({ data: { organizationId: (await demoOrg()).id, incidentId: await openIncident(), question, status: 'RUNNING', demoSessionId } });

  it("a visitor sees the seeded investigations and its own session's, never another visitor's: list, detail, incident, dashboard", async () => {
    const a = await visitor();
    const b = await visitor();
    const incidentId = await openIncident();
    const mine = (await a.agent.post('/api/v1/investigations').send({ incidentId, question: 'Private question of visitor A' }).expect(202)).body.id as string;
    const seeded = (await running(null)).id;
    const listed = async (agent: typeof a.agent) => ((await agent.get('/api/v1/investigations').expect(200)).body.data as { id: string }[]).map((i) => i.id);
    expect(await listed(a.agent)).toEqual(expect.arrayContaining([mine, seeded]));
    expect(await listed(b.agent)).toContain(seeded);
    expect(await listed(b.agent)).not.toContain(mine);
    await a.agent.get(`/api/v1/investigations/${mine}`).expect(200);
    await b.agent.get(`/api/v1/investigations/${mine}`).expect(404);
    const incident = (await b.agent.get(`/api/v1/incidents/${incidentId}`).expect(200)).body;
    expect(incident.investigations.map((i: { id: string }) => i.id)).not.toContain(mine);
    // The question is written nowhere another visitor can read it.
    expect(JSON.stringify(incident)).not.toContain('Private question of visitor A');
    expect(JSON.stringify((await b.agent.get('/api/v1/dashboard').expect(200)).body)).not.toContain(mine);
    expect(await prisma.notification.count({ where: { user: { email: DEMO_VISITOR_EMAIL } } })).toBe(0);
    // Outside the demo, nothing is hidden from members (the column is null for every ordinary run).
    expect(await prisma.investigation.count({ where: { organizationId: other.organizationId, demoSessionId: { not: null } } })).toBe(0);
  });

  it('remediation actions proposed by another visitor session are hidden too', async () => {
    const a = await visitor();
    const b = await visitor();
    const run = await running(a.session);
    const action = await prisma.remediationAction.create({ data: { organizationId: run.organizationId, investigationId: run.id, incidentId: run.incidentId, title: 'Proposal from visitor A', type: 'manual', risk: 'LOW', description: 'd', proposedByType: 'ai_agent' } });
    const titles = async (agent: typeof a.agent) => ((await agent.get('/api/v1/remediations?pageSize=100').expect(200)).body.data as { id: string }[]).map((r) => r.id);
    expect(await titles(a.agent)).toContain(action.id);
    expect(await titles(b.agent)).not.toContain(action.id);
    await a.agent.get(`/api/v1/remediations/${action.id}`).expect(200);
    await b.agent.get(`/api/v1/remediations/${action.id}`).expect(404);
    expect(JSON.stringify((await b.agent.get(`/api/v1/incidents/${run.incidentId}`).expect(200)).body)).not.toContain(action.id);
  });

  it("a visitor cancels only its own session's runs: not another visitor's, not a seeded one", async () => {
    const a = await visitor();
    const b = await visitor();
    const theirs = await running(a.session);
    const seeded = await running(null);
    expect((await b.agent.post(`/api/v1/investigations/${theirs.id}/cancel`)).status).toBe(409);
    expect((await a.agent.post(`/api/v1/investigations/${seeded.id}/cancel`)).status).toBe(409);
    expect((await prisma.investigation.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe('RUNNING');
    expect((await prisma.investigation.findUniqueOrThrow({ where: { id: seeded.id } })).status).toBe('RUNNING');
    await a.agent.post(`/api/v1/investigations/${theirs.id}/cancel`).expect(200);
    expect((await prisma.investigation.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe('CANCELLED');
    await prisma.investigation.update({ where: { id: seeded.id }, data: { status: 'COMPLETED' } });
  });

  it('one session may start a limited number of investigations', async () => {
    env.DEMO_SESSION_INVESTIGATION_LIMIT = 2;
    const { agent } = await visitor();
    const incidentId = await openIncident();
    await agent.post('/api/v1/investigations').send({ incidentId, question: 'Why did checkout fail, first?' }).expect(202);
    await agent.post('/api/v1/investigations').send({ incidentId, question: 'Why did checkout fail, second?' }).expect(202);
    const third = await agent.post('/api/v1/investigations').send({ incidentId, question: 'Why did checkout fail, third?' }).expect(429);
    expect(third.body.error.code).toBe('limit_reached');
  });

  it('a fresh session from the same address does not reset the limits: one running at a time, and a daily count per address', async () => {
    const a = await visitor();
    await running(a.session);
    const b = await visitor();
    const incidentId = await openIncident();
    expect((await b.agent.post('/api/v1/investigations').send({ incidentId, question: 'What caused this incident?' })).status).toBe(429);
    await prisma.investigation.updateMany({ where: { demoSessionId: a.session }, data: { status: 'COMPLETED' } });
    env.DEMO_ADDRESS_DAILY_INVESTIGATION_LIMIT = 2;
    await b.agent.post('/api/v1/investigations').send({ incidentId, question: 'What caused this incident?' }).expect(202);
    const c = await visitor();
    const refused = await c.agent.post('/api/v1/investigations').send({ incidentId, question: 'What caused this incident?' }).expect(429);
    expect(refused.body.error.message).toMatch(/from your address/);
  });

  it('behind a trusted proxy the per-address limit follows the forwarded client address, and a forged one changes nothing', async () => {
    // Supertest connects from loopback; trusting loopback makes it play the proxy (in the demo, Nginx and the web app).
    env.TRUST_PROXY = 'loopback';
    const proxied = createApp();
    env.TRUST_PROXY = 'false';
    env.DEMO_ADDRESS_DAILY_INVESTIGATION_LIMIT = 1;
    const incidentId = await openIncident();
    const enter = async (address: string) => {
      const agent = request.agent(proxied);
      await agent.post('/api/v1/auth/demo').set('X-Forwarded-For', address).expect(200);
      return agent;
    };
    const start = async (agent: Awaited<ReturnType<typeof enter>>, address: string) =>
      (await agent.post('/api/v1/investigations').set('X-Forwarded-For', address).send({ incidentId, question: 'What caused this incident?' })).status;
    expect(await start(await enter('203.0.113.10'), '203.0.113.10')).toBe(202);
    expect((await prisma.refreshToken.findFirstOrThrow({ where: { user: { email: DEMO_VISITOR_EMAIL } }, orderBy: { createdAt: 'desc' } })).ip).toBe('203.0.113.10');
    // A new session from the same client is refused ...
    expect(await start(await enter('203.0.113.10'), '203.0.113.10')).toBe(429);
    // ... also when it puts a forged address in front of its own (the right-most untrusted one counts).
    expect(await start(await enter('198.51.100.66, 203.0.113.10'), '198.51.100.66, 203.0.113.10')).toBe(429);
    // Another client is not affected.
    expect(await start(await enter('203.0.113.20'), '203.0.113.20')).toBe(202);
  });

  it('sessions entered from one address and used from another still count for the first', async () => {
    env.TRUST_PROXY = 'loopback';
    const proxied = createApp();
    env.TRUST_PROXY = 'false';
    env.DEMO_ADDRESS_DAILY_INVESTIGATION_LIMIT = 1;
    const incidentId = await openIncident();
    const enterFrom = async (address: string) => {
      const agent = request.agent(proxied);
      await agent.post('/api/v1/auth/demo').set('X-Forwarded-For', address).expect(200);
      return agent;
    };
    const first = await enterFrom('203.0.113.30');
    await first.post('/api/v1/investigations').set('X-Forwarded-For', '203.0.113.30').send({ incidentId, question: 'What caused this incident?' }).expect(202);
    // Entered from the same address, used from a fresh one: still that address's quota.
    const second = await enterFrom('203.0.113.30');
    expect((await second.post('/api/v1/investigations').set('X-Forwarded-For', '203.0.113.31').send({ incidentId, question: 'What caused this incident?' })).status).toBe(429);
  });

  it("a visitor run's proposed actions reach no shared timeline", async () => {
    const { persistFinal } = await import('../src/modules/investigations/persistence');
    const a = await visitor();
    const run = await running(a.session);
    const report = {
      summary: 'Rule-based summary', confidence: 0.4, hypotheses: [], analysisMode: 'heuristic',
      recommendedActions: [{ type: 'manual', title: 'Visitor-run proposal', description: 'd', rationale: 'r', risk: 'LOW', evidenceRefs: [], serviceSlug: null, parameters: null }],
    } as never;
    expect(await persistFinal(run.id, report)).toBe(true);
    const action = await prisma.remediationAction.findFirstOrThrow({ where: { investigationId: run.id } });
    expect(await prisma.incidentEvent.count({ where: { incidentId: run.incidentId!, message: { contains: 'Visitor-run proposal' } } })).toBe(0);
    expect(await prisma.incidentEvent.count({ where: { incidentId: run.incidentId!, metadata: { path: ['investigationId'], equals: run.id } } })).toBe(0);
    expect(action.title).toBe('Visitor-run proposal');
  });

  it("after another visitor's run completes, no read a visitor may make shows it", async () => {
    const { persistFinal } = await import('../src/modules/investigations/persistence');
    const a = await visitor();
    const b = await visitor();
    const question = 'Sweep question of visitor A, never shown to B';
    const run = await prisma.investigation.create({ data: { organizationId: (await demoOrg()).id, incidentId: await openIncident(), question, status: 'RUNNING', demoSessionId: a.session } });
    const report = {
      summary: 'Sweep summary of visitor A', confidence: 0.4, hypotheses: [], analysisMode: 'heuristic',
      recommendedActions: [{ type: 'manual', title: 'Sweep proposal of visitor A', description: 'd', rationale: 'r', risk: 'LOW', evidenceRefs: [], serviceSlug: null, parameters: null }],
    } as never;
    expect(await persistFinal(run.id, report)).toBe(true);
    const action = await prisma.remediationAction.findFirstOrThrow({ where: { investigationId: run.id } });
    const incident = run.incidentId!;
    const secrets = [run.id, action.id, question, 'Sweep summary of visitor A', 'Sweep proposal of visitor A'];
    const reads = [
      '/auth/me', '/dashboard', '/incidents', `/incidents/${incident}`, `/incidents/${incident}/context`, '/services', '/services/graph', '/deployments',
      '/service-events', '/logs', '/monitoring/overview', '/monitoring/alerts', '/github/commits', '/integrations', '/knowledge/documents',
      '/investigations', '/investigations?pageSize=200', '/investigations/ai-status', '/remediations?pageSize=200', `/remediations?incidentId=${incident}`,
      `/remediations?investigationId=${run.id}`, '/analytics/overview', '/analytics/incidents.csv', '/members', '/teams', '/settings', '/notifications',
      '/system/status', '/tools/incidents', `/tools/incidents/${incident}/context`,
    ];
    for (const path of reads) {
      const res = await b.agent.get(`/api/v1${path}`);
      expect(res.status, path).toBeLessThan(500);
      const body = res.text;
      for (const secret of secrets) expect(body.includes(secret), `${path} shows ${secret}`).toBe(false);
    }
    // A sees its own run, without the session id that owns it.
    const detail = (await a.agent.get(`/api/v1/investigations/${run.id}`).expect(200)).body;
    expect(detail.question).toBe(question);
    expect('demoSessionId' in detail).toBe(false);
  });

  it('a CSV export by the visitor writes no audit row', async () => {
    const { agent } = await visitor();
    const orgId = (await demoOrg()).id;
    const before = await prisma.auditLog.count({ where: { organizationId: orgId, action: 'report.export' } });
    await agent.get('/api/v1/analytics/incidents.csv').expect(200);
    expect(await prisma.auditLog.count({ where: { organizationId: orgId, action: 'report.export' } })).toBe(before);
  });

  it('the visitor gets no upstream error text from the status endpoints', async () => {
    spy.mockRejectedValue(new Error('AI service returned 502: upstream body naming http://ai:8000'));
    const { agent } = await visitor();
    for (const path of ['/investigations/ai-status', '/system/status']) {
      const body = JSON.stringify((await agent.get(`/api/v1${path}`).expect(200)).body);
      expect(body, path).not.toMatch(/upstream body|ai:8000|502/);
      expect(body, path).toMatch(/not reachable/);
    }
  });

  it('parallel starts cannot pass the limits together', async () => {
    env.DEMO_SESSION_INVESTIGATION_LIMIT = 1;
    const { agent } = await visitor();
    const incidentId = await openIncident();
    const results = await Promise.all(Array.from({ length: 6 }, () => agent.post('/api/v1/investigations').send({ incidentId, question: 'What caused this incident?' })));
    expect(results.map((r) => r.status).sort()).toEqual([202, 429, 429, 429, 429, 429]);
  });

  it('the organisation-wide concurrency limit holds against parallel starts from many visitors', async () => {
    const saved = env.INVESTIGATION_MAX_CONCURRENT;
    env.INVESTIGATION_MAX_CONCURRENT = 1;
    const incidentId = await openIncident();
    // The test queue runs each investigation inline and to its end; a run held open here occupies the one slot.
    const holder = await running(null);
    try {
      const visitors = await Promise.all(Array.from({ length: 4 }, () => visitor()));
      const results = await Promise.all(visitors.map((v) => v.agent.post('/api/v1/investigations').send({ incidentId, question: 'What caused this incident?' })));
      expect(results.map((r) => r.status)).toEqual([429, 429, 429, 429]);
    } finally {
      env.INVESTIGATION_MAX_CONCURRENT = saved;
      await prisma.investigation.update({ where: { id: holder.id }, data: { status: 'COMPLETED' } });
    }
  });

  it('a session keeps its runs across a refresh; replaying an old refresh token ends that session only, not every visitor', async () => {
    const a = await visitor();
    const b = await visitor();
    const mine = await running(a.session);
    const oldRefresh = ([] as string[]).concat(a.res.headers['set-cookie'] ?? []).find((c) => c.startsWith('op_refresh='))!.split(';')[0]!;
    await a.agent.post('/api/v1/auth/refresh').expect(200);
    await a.agent.get(`/api/v1/investigations/${mine.id}`).expect(200);
    // Replayed: the theft response ends A's session family ...
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', oldRefresh)).status).toBe(401);
    await a.agent.get('/api/v1/incidents').expect(401);
    // ... and B, the same account, is still signed in.
    await b.agent.get('/api/v1/incidents').expect(200);
    await prisma.investigation.update({ where: { id: mine.id }, data: { status: 'COMPLETED' } });
  });
});

describe('a reset that removes a run while it is in flight', () => {
  it("leaves nothing behind: the worker's final writes find no run and create nothing", async () => {
    const { persistFinal, markFailed, markInterrupted } = await import('../src/modules/investigations/persistence');
    const orgId = (await demoOrg()).id;
    const run = await prisma.investigation.create({ data: { organizationId: orgId, question: 'In flight during a reset', status: 'RUNNING', demoSessionId: 'gone-session' } });
    // What the reset's transaction does to it.
    await prisma.investigation.delete({ where: { id: run.id } });
    const report = { summary: 's', confidence: 0.5, hypotheses: [], recommendedActions: [], analysisMode: 'heuristic' } as never;
    await expect(persistFinal(run.id, report)).rejects.toThrow();
    expect((await markFailed(run.id, 'x')).count).toBe(0);
    expect(await markInterrupted(run.id)).toBe(false);
    expect(await prisma.investigation.count({ where: { id: run.id } })).toBe(0);
    expect(await prisma.remediationAction.count({ where: { investigationId: run.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { link: `/investigations/${run.id}` } })).toBe(0);
  });
});

describe('the analysis engine in demo mode', () => {
  it('a run whose analysis service reports a model provider is stopped before it does anything', async () => {
    const { eventConsumer } = await import('../src/modules/investigations/stream');
    const run = await prisma.investigation.create({ data: { organizationId: other.organizationId, question: 'q', status: 'RUNNING' } });
    const abort = new AbortController();
    const consumer = eventConsumer(run.id, abort) as unknown as { onEvent?: (e: unknown) => Promise<void> } | ((e: unknown) => Promise<void>);
    const onEvent = typeof consumer === 'function' ? consumer : consumer.onEvent!;
    await expect(onEvent({ type: 'meta', provider: 'anthropic', model: 'x' })).rejects.toThrow(/rule-based engine only/);
    expect(abort.signal.aborted).toBe(true);
  });
});

describe('setup and reset', () => {
  const outside = async () =>
    JSON.stringify({
      incidents: await prisma.incident.count({ where: { organizationId: other.organizationId } }),
      members: await prisma.membership.count({ where: { organizationId: other.organizationId } }),
      users: (await prisma.user.findMany({ where: { email: { not: DEMO_VISITOR_EMAIL } }, select: { email: true, passwordHash: true }, orderBy: { email: 'asc' } })).map((u) => `${u.email}:${u.passwordHash}`),
    });

  it('setup is idempotent: run again, it creates nothing new', async () => {
    const before = await demoOrg();
    const incidents = await prisma.incident.count({ where: { organizationId: before.id } });
    expect(demoScript('setup').status).toBe(0);
    const after = await demoOrg();
    expect(after.id).toBe(before.id);
    expect(await prisma.incident.count({ where: { organizationId: after.id } })).toBe(incidents);
    expect(await prisma.membership.count({ where: { user: { email: DEMO_VISITOR_EMAIL } } })).toBe(1);
  });

  it('reset rebuilds the demonstration organisation only; every other organisation and every account is unchanged; the visitor can enter again', async () => {
    const snapshot = await outside();
    const before = await demoOrg();
    const { agent: earlier } = await visitor();
    const run = demoScript('reset');
    expect(run.status, run.out).toBe(0);
    const after = await demoOrg();
    expect(after.id).not.toBe(before.id);
    expect(await outside()).toBe(snapshot);
    // Sessions, and with them the visitors' quotas, are gone: an earlier visitor is signed out cleanly.
    await earlier.get('/api/v1/incidents').expect(401);
    expect((await earlier.post('/api/v1/auth/refresh')).status).toBe(401);
    expect(await prisma.refreshToken.count({ where: { organizationId: before.id } })).toBe(0);
    expect(await prisma.investigation.count({ where: { organizationId: before.id } })).toBe(0);
    const { res } = await visitor();
    expect(res.body.organization.id).toBe(after.id);
    expect(await prisma.auditLog.count({ where: { organizationId: after.id, action: 'public_demo.reset' } })).toBe(1);
  }, 300_000);

  it('two resets at the same time: one runs, the other stops without doing anything', async () => {
    const [a, b] = await Promise.all([demoScriptAsync('reset'), demoScriptAsync('reset')]);
    const statuses = [a.status, b.status].sort();
    expect(statuses, `${a.out}\n---\n${b.out}`).toEqual([0, 3]);
    expect(await prisma.organization.count({ where: { slug: SLUG } })).toBe(1);
  }, 300_000);

  it('refuses to run without PUBLIC_DEMO_MODE=true', () => {
    const run = spawnSync(TSX, ['scripts/public-demo.ts', 'setup'], { cwd: resolve(__dirname, '..'), env: { ...process.env, PUBLIC_DEMO_MODE: 'false' }, encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/only with PUBLIC_DEMO_MODE=true/);
  });
});
