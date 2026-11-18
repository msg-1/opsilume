import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The API's own rate limiters, as configured for one API process (docs/deployment/PUBLIC_DEMO_MODE.md,
// "API rate limits"). They are switched off in every other test file. Counts live in the process's memory:
// a new process (here: the modules loaded afresh) starts from zero, and two processes count separately.
// Clients are told apart by the forwarded address, through an app that trusts loopback as its proxy.
vi.hoisted(() => {
  process.env.OPSILUME_TEST_RATE_LIMITS = 'on';
});

type App = ReturnType<(typeof import('../src/app'))['createApp']>;

/** The API as a freshly started process would build it. */
async function freshProcess(): Promise<App> {
  vi.resetModules();
  const { env } = await import('../src/config/env');
  const { createApp } = await import('../src/app');
  const trust = env.TRUST_PROXY;
  env.TRUST_PROXY = 'loopback';
  try {
    return createApp();
  } finally {
    env.TRUST_PROXY = trust;
  }
}

const from = (app: App, address: string) => ({
  get: (path: string) => request(app).get(path).set('X-Forwarded-For', address),
  post: (path: string, body: object = {}) => request(app).post(path).set('X-Forwarded-For', address).send(body),
});
let n = 0;
const email = () => `nobody-${process.pid}-${++n}@example.com`;

afterAll(() => {
  delete process.env.OPSILUME_TEST_RATE_LIMITS;
  vi.resetModules();
});

describe('the sign-in endpoints: 20 requests a minute per address, one count for all of them', () => {
  let app: App;
  beforeAll(async () => {
    app = await freshProcess();
  });

  it('allows the 20th request and refuses the 21st, whichever sign-in endpoint it goes to', async () => {
    const a = from(app, '198.51.100.1');
    for (let i = 0; i < 10; i++) expect((await a.post('/api/v1/auth/login', { email: email(), password: 'wrong-password-1' })).status).toBe(401);
    for (let i = 0; i < 9; i++) expect((await a.post('/api/v1/auth/refresh')).status).toBe(401);
    const twentieth = await a.post('/api/v1/auth/refresh');
    expect(twentieth.status).toBe(401);
    expect(twentieth.headers.ratelimit).toMatch(/limit=20, remaining=0/);
    const refused = await a.post('/api/v1/auth/register', { email: email(), password: 'Sup3r-secret-pw', name: 'X', organizationName: 'X' });
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('rate_limited');
  });

  it('another address is counted on its own', async () => {
    expect((await from(app, '198.51.100.2').post('/api/v1/auth/refresh')).status).toBe(401);
  });

  it('a forged address in front of the real one does not open a new count', async () => {
    expect((await from(app, '6.6.6.6, 198.51.100.1').post('/api/v1/auth/refresh')).status).toBe(429);
  });
});

describe('failed sign-ins: 10 per account in 15 minutes, from any number of addresses', () => {
  it('the 11th failure for one account is refused even from a new address', async () => {
    const app = await freshProcess();
    const target = email();
    for (let i = 0; i < 10; i++) expect((await from(app, `198.51.100.${100 + i}`).post('/api/v1/auth/login', { email: target, password: 'wrong-password-1' })).status).toBe(401);
    const refused = await from(app, '198.51.100.150').post('/api/v1/auth/login', { email: target, password: 'wrong-password-1' });
    expect(refused.status).toBe(429);
    expect(refused.body.error.message).toMatch(/this account/);
  });
});

describe('every /api/v1 request: 1200 a minute per address', () => {
  it('allows the 1200th request and refuses the 1201st; another address is unaffected', async () => {
    const app = await freshProcess();
    const a = from(app, '198.51.100.200');
    const statuses = new Map<number, number>();
    for (let i = 0; i < 1200; i++) {
      const s = (await a.get('/api/v1/incidents')).status;
      statuses.set(s, (statuses.get(s) ?? 0) + 1);
    }
    expect(Object.fromEntries(statuses)).toEqual({ 401: 1200 });
    expect((await a.get('/api/v1/incidents')).status).toBe(429);
    expect((await from(app, '198.51.100.201').get('/api/v1/incidents')).status).toBe(401);
  }, 120_000);
});

describe('counts are per process and are lost on restart', () => {
  it('after a restart an address that was refused is allowed again', async () => {
    const before = await freshProcess();
    const a = from(before, '198.51.100.250');
    for (let i = 0; i < 20; i++) await a.post('/api/v1/auth/refresh');
    expect((await a.post('/api/v1/auth/refresh')).status).toBe(429);
    const after = await freshProcess();
    expect((await from(after, '198.51.100.250').post('/api/v1/auth/refresh')).status).toBe(401);
  });

  it('two API processes would each allow the full limit: the counts are not shared', async () => {
    const one = await freshProcess();
    const two = await freshProcess();
    for (let i = 0; i < 20; i++) await from(one, '198.51.100.251').post('/api/v1/auth/refresh');
    expect((await from(one, '198.51.100.251').post('/api/v1/auth/refresh')).status).toBe(429);
    expect((await from(two, '198.51.100.251').post('/api/v1/auth/refresh')).status).toBe(401);
  });
});
