import { spawn, spawnSync } from 'node:child_process';
import type { ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import IORedis from 'ioredis';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_REPORT, aiStub, until } from './faults';

// The lifecycle of visitor investigations in the public demonstration (docs/deployment/PUBLIC_DEMO_MODE.md,
// section 6): the time limit, cancellation, the release of concurrency slots, runs side by side, a reset
// while a run is in flight, and what a visitor is told when a run fails. Real BullMQ on Redis and a real
// worker; the AI service is a scripted stub (no model is called). Each visitor comes from its own
// forwarded address, through an app that trusts loopback as its proxy, as Nginx and the web app are trusted.
const settings = vi.hoisted(() => {
  const port = 21_000 + ((process.pid * 11 + 977) % 20_000);
  process.env.QUEUE_INLINE = 'false';
  process.env.QUEUE_PREFIX = `opsilume-demo-lifecycle-${process.pid}-${Date.now()}`;
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${port}`;
  return { aiPort: port, redis: process.env.REDIS_URL ?? 'redis://localhost:6379', prefix: process.env.QUEUE_PREFIX };
});

import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { VISITOR_FAILURE } from '../src/lib/demo';
import { closeQueues, startWorkers } from '../src/queues';
import { prisma } from './helpers';

const SLUG = 'acme-commerce-demo';
const TSX = resolve(__dirname, '../../../node_modules/.bin/tsx');
const scriptEnv = () => ({ ...process.env, PUBLIC_DEMO_MODE: 'true' });
const ai = aiStub(settings.aiPort);

const redisAvailable = await (async () => {
  const probe = new IORedis(settings.redis, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 1500, retryStrategy: () => null });
  probe.on('error', () => undefined);
  try {
    await probe.connect();
    return (await probe.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
})();
if (!redisAvailable && process.env.CI) throw new Error(`Lifecycle tests need Redis at ${settings.redis}`);

const saved = { trust: env.TRUST_PROXY, timeout: env.INVESTIGATION_TIMEOUT_MS, concurrent: env.INVESTIGATION_MAX_CONCURRENT };
let app: ReturnType<typeof createApp>;
let address = 0;
const QUESTION = 'What caused this incident?';

/** A visitor from its own address. */
async function visitor() {
  const from = `203.0.113.${++address}`;
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/demo').set('X-Forwarded-For', from).expect(200);
  const start = () => agent.post('/api/v1/investigations').set('X-Forwarded-For', from).send({ incidentId, question: QUESTION });
  const read = async (id: string) => (await agent.get(`/api/v1/investigations/${id}`).set('X-Forwarded-For', from).expect(200)).body;
  const cancel = (id: string) => agent.post(`/api/v1/investigations/${id}/cancel`).set('X-Forwarded-For', from);
  return { agent, from, start, read, cancel };
}
const status = async (id: string) => (await prisma.investigation.findUnique({ where: { id }, select: { status: true } }))?.status ?? 'GONE';
const ended = (id: string, timeoutMs = 15_000) => until(() => status(id), (s) => !['QUEUED', 'RUNNING'].includes(s), 'the investigation to end', timeoutMs);
/** Running, and its request has reached the analysis service. */
const isRunning = async (id: string) => {
  await until(() => status(id), (s) => s === 'RUNNING', 'the investigation to run');
  if (ai.state.onRun === holding) await until(async () => open.has(id), Boolean, 'the request to reach the analysis service');
};
const demoOrgId = async () => (await prisma.organization.findUniqueOrThrow({ where: { slug: SLUG } })).id;
let incidentId: string;

/** The stub holds every run open until the test answers it: open.get(investigationId) is its response. */
const open = new Map<string, { res: ServerResponse; line: (e: unknown) => void }>();
const holding: typeof ai.state.onRun = (_req, res, { body, line }) => {
  line({ type: 'meta', provider: 'heuristic', model: null });
  open.set(String(body.investigationId), { res, line });
};
const holdRuns = () => {
  ai.state.onRun = holding;
};
const finish = (id: string) => {
  const run = open.get(id)!;
  run.line({ type: 'final', report: EMPTY_REPORT });
  run.res.end();
};

describe.skipIf(!redisAvailable)('visitor investigations from start to end', () => {
  let stop: ((options?: { graceMs?: number }) => Promise<void>) | undefined;

  beforeAll(async () => {
    const existing = await prisma.organization.findUnique({ where: { slug: SLUG } });
    const run = spawnSync(TSX, ['scripts/public-demo.ts', existing ? 'reset' : 'setup'], { cwd: resolve(__dirname, '..'), env: scriptEnv(), encoding: 'utf8', timeout: 240_000 });
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
    env.PUBLIC_DEMO_MODE = true;
    env.TRUST_PROXY = 'loopback';
    app = createApp();
    env.TRUST_PROXY = saved.trust;
    incidentId = (await prisma.incident.findFirstOrThrow({ where: { organizationId: await demoOrgId(), status: { not: 'CLOSED' } }, orderBy: { number: 'asc' } })).id;
    await ai.start();
  }, 300_000);
  beforeEach(async () => {
    ai.reset();
    open.clear();
    env.INVESTIGATION_TIMEOUT_MS = 60_000;
    env.INVESTIGATION_MAX_CONCURRENT = 2;
    stop = await startWorkers({ schedulers: false });
  });
  afterEach(async () => {
    for (const run of open.values()) run.res.destroy();
    await stop?.({ graceMs: 200 });
    stop = undefined;
    await prisma.investigation.updateMany({ where: { status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'CANCELLED' } });
  });
  afterAll(async () => {
    env.PUBLIC_DEMO_MODE = false;
    env.INVESTIGATION_TIMEOUT_MS = saved.timeout;
    env.INVESTIGATION_MAX_CONCURRENT = saved.concurrent;
    await closeQueues();
    await ai.stop();
    const redis = new IORedis(settings.redis);
    const keys = await redis.keys(`${settings.prefix}:*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });

  it('a run that goes past the time limit is stopped, recorded as failed, concludes nothing, and frees its slot', async () => {
    env.INVESTIGATION_MAX_CONCURRENT = 1;
    env.INVESTIGATION_TIMEOUT_MS = 800;
    holdRuns();
    const a = await visitor();
    const id = (await a.start().expect(202)).body.id as string;
    await isRunning(id);
    // The one slot is taken: another visitor waits.
    const b = await visitor();
    expect((await b.start()).status).toBe(429);
    const began = Date.now();
    expect(await ended(id)).toBe('FAILED');
    expect(Date.now() - began).toBeLessThan(5000);
    const failed = await a.read(id);
    expect(failed.error).toMatch(/^The investigation did not finish within 800 ms and was stopped\. No conclusions were recorded\.$/);
    expect(failed.remediations).toEqual([]);
    expect(await prisma.remediationAction.count({ where: { investigationId: id } })).toBe(0);
    expect(await prisma.notification.count({ where: { link: `/investigations/${id}` } })).toBe(0);
    await until(async () => ai.state.abandoned, (n) => n >= 1, 'the request to the AI service to be closed');
    // The slot is free again.
    env.INVESTIGATION_TIMEOUT_MS = 60_000;
    const next = (await b.start().expect(202)).body.id as string;
    await isRunning(next);
    finish(next);
    expect(await ended(next)).toBe('COMPLETED');
  });

  it("cancelling stops the run within seconds even when the stream is silent, and leaves another visitor's run alone", async () => {
    holdRuns();
    const a = await visitor();
    const b = await visitor();
    const mine = (await a.start().expect(202)).body.id as string;
    const theirs = (await b.start().expect(202)).body.id as string;
    await Promise.all([isRunning(mine), isRunning(theirs)]);
    expect((await b.cancel(mine)).status).toBe(409);
    await a.cancel(mine).expect(200);
    expect(await status(mine)).toBe('CANCELLED');
    // The worker lets go of the silent stream without waiting for the time limit (60 s here).
    await until(async () => ai.state.abandoned, (n) => n === 1, 'the cancelled run to close its request', 8000);
    expect(await status(theirs)).toBe('RUNNING');
    finish(theirs);
    expect(await ended(theirs)).toBe('COMPLETED');
    expect(await status(mine)).toBe('CANCELLED');
    expect(await prisma.remediationAction.count({ where: { investigationId: mine } })).toBe(0);
  });

  it('runs side by side up to the limit; the next start is refused until one ends, then accepted', async () => {
    holdRuns();
    const [a, b, c] = [await visitor(), await visitor(), await visitor()];
    const first = (await a.start().expect(202)).body.id as string;
    const second = (await b.start().expect(202)).body.id as string;
    await Promise.all([isRunning(first), isRunning(second)]);
    expect((await c.start()).status).toBe(429);
    finish(first);
    expect(await ended(first)).toBe('COMPLETED');
    const third = (await c.start().expect(202)).body.id as string;
    await isRunning(third);
    expect(await status(second)).toBe('RUNNING');
    finish(second);
    finish(third);
    expect([await ended(second), await ended(third)]).toEqual(['COMPLETED', 'COMPLETED']);
    // Every slot is free.
    expect(await prisma.investigation.count({ where: { organizationId: await demoOrgId(), status: { in: ['QUEUED', 'RUNNING'] } } })).toBe(0);
  });

  it('a failure is shown to the visitor in plain words, never with internal addresses, credentials, paths or upstream text', async () => {
    const leak = 'connect ECONNREFUSED 10.0.3.7:5432 postgresql://opsilume:s3cret@postgres:5432/opsilume at /app/dist/src/worker.js:12 token=eyJhbGciOiJIUzI1NiJ9.x.y';
    const leaky = /10\.0\.3\.7|postgres(ql)?:|s3cret|\/app\/dist|eyJhbGci|ai:8000|127\.0\.0\.1|ECONNREFUSED/;
    const cases: [string, (line: (e: unknown) => void, res: ServerResponse) => void][] = [
      ['an error event from the analysis service', (line, res) => (line({ type: 'error', message: `Investigation failed: ${leak}` }), res.end())],
      ['an upstream error page', (_line, res) => res.writeHead(502, { 'content-type': 'text/html' }).end(`<html>bad gateway ${leak}</html>`)],
      ['a failed tool step, then an error', (line, res) => {
        line({ type: 'meta', provider: 'heuristic', model: null });
        line({ type: 'step', step: { type: 'tool_call', title: 'search_logs', toolName: 'search_logs', status: 'failed', detail: leak, output: { error: `OPSILUME API is not reachable: ${leak}` } } });
        line({ type: 'error', message: leak });
        res.end();
      }],
    ];
    for (const [name, answer] of cases) {
      ai.state.onRun = (_req, res, { line }) => answer(line, res);
      const v = await visitor();
      const id = (await v.start().expect(202)).body.id as string;
      expect(await ended(id), name).toBe('FAILED');
      const shown = await v.read(id);
      expect(shown.error, name).toBe(VISITOR_FAILURE);
      expect(JSON.stringify(shown), name).not.toMatch(leaky);
      const listed = (await v.agent.get('/api/v1/investigations').set('X-Forwarded-For', v.from).expect(200)).body;
      expect(JSON.stringify(listed), name).not.toMatch(leaky);
      // The detail is kept for the operator: it is in the worker's log (not asserted here), not in what visitors read.
    }
    // A dependency that is down: in demo mode the answer names nothing internal; the detail goes to the log.
    const { errorHandler } = await import('../src/middleware/error');
    const { serviceUnavailable } = await import('../src/lib/errors');
    const sent: { status?: number; body?: unknown } = {};
    const res = { status: (s: number) => ((sent.status = s), res), json: (b: unknown) => ((sent.body = b), res), setHeader: () => res };
    errorHandler(serviceUnavailable('AI service is not reachable at http://ai:8000 (connect ECONNREFUSED 10.0.3.7:8000)'), { path: '/knowledge/search', method: 'POST' } as never, res as never, () => undefined);
    expect(sent.status).toBe(503);
    expect(JSON.stringify(sent.body)).not.toMatch(leaky);
    expect(JSON.stringify(sent.body)).toMatch(/not available right now/);
  });

  it('a reset while a run is in flight closes the demo, stops the run, removes it, and nothing comes back', async () => {
    holdRuns();
    const a = await visitor();
    const id = (await a.start().expect(202)).body.id as string;
    await isRunning(id);
    const reset = await new Promise<{ status: number | null; out: string }>((done) => {
      const child = spawn(TSX, ['scripts/public-demo.ts', 'reset'], { cwd: resolve(__dirname, '..'), env: scriptEnv() });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('close', (code) => done({ status: code, out }));
    });
    expect(reset.status, reset.out).toBe(0);
    // The run was cancelled first, so the worker let go of it; then it was removed with its organisation.
    await until(async () => ai.state.abandoned, (n) => n === 1, 'the run to close its request', 8000);
    expect(await status(id)).toBe('GONE');
    // A late answer from the analysis service changes nothing.
    if (!open.get(id)!.res.destroyed) finish(id);
    await new Promise((r) => setTimeout(r, 500));
    expect(await prisma.investigation.count({ where: { id } })).toBe(0);
    expect(await prisma.remediationAction.count({ where: { investigationId: id } })).toBe(0);
    // The visitor's session went with the old organisation; entering again works, with a fresh quota.
    await a.agent.get('/api/v1/incidents').set('X-Forwarded-For', a.from).expect(401);
    incidentId = (await prisma.incident.findFirstOrThrow({ where: { organizationId: await demoOrgId(), status: { not: 'CLOSED' } }, orderBy: { number: 'asc' } })).id;
    const again = await visitor();
    const fresh = (await again.start().expect(202)).body.id as string;
    await isRunning(fresh);
    finish(fresh);
    expect(await ended(fresh)).toBe('COMPLETED');
  }, 300_000);
});
