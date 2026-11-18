import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Request } from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { env } from '../src/config/env';

// How the API decides who a client is behind the public demo's proxies (docs/deployment/PUBLIC_DEMO_MODE.md,
// "Client addresses"): Nginx (deploy/public-demo/nginx.conf.template) overwrites X-Forwarded-For with the
// address it was connected from; the web app passes that header to the API unchanged (Next.js rewrites add
// none of their own; checked against a running build); the API, with TRUST_PROXY=uniquelocal, takes the
// right-most address that is not a private one. These tests pin the API's part and the proxy configuration.
// They are not a test of a running deployment.

const saved = { trust: env.TRUST_PROXY, demo: env.PUBLIC_DEMO_MODE };
afterAll(() => {
  env.TRUST_PROXY = saved.trust;
  env.PUBLIC_DEMO_MODE = saved.demo;
});

function appWith(over: { trust?: string; demo?: boolean }) {
  env.TRUST_PROXY = over.trust ?? saved.trust;
  env.PUBLIC_DEMO_MODE = over.demo ?? false;
  try {
    return createApp();
  } finally {
    env.TRUST_PROXY = saved.trust;
    env.PUBLIC_DEMO_MODE = saved.demo;
  }
}

/** req.ip as Express computes it for a connection from `peer` carrying `forwarded`. */
function clientAddress(app: ReturnType<typeof createApp>, peer: string, forwarded?: string) {
  const socket = { remoteAddress: peer };
  const req = Object.create(app.request) as Request;
  Object.assign(req, { app, headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded }, socket, connection: socket });
  return req.ip;
}

describe('the client address behind the demo proxies (TRUST_PROXY=uniquelocal)', () => {
  const app = appWith({ trust: 'uniquelocal' });
  const WEB = '172.18.0.5'; // the web container, the API's only peer in the demo's Compose network

  it('is the address Nginx recorded', () => {
    expect(clientAddress(app, WEB, '203.0.113.9')).toBe('203.0.113.9');
  });

  it('a forged address in front of it is ignored, even if a proxy appended instead of overwriting', () => {
    expect(clientAddress(app, WEB, '6.6.6.6, 203.0.113.9')).toBe('203.0.113.9');
    expect(clientAddress(app, WEB, '10.0.0.1, 203.0.113.9')).toBe('203.0.113.9');
  });

  it('private hops after the client are skipped', () => {
    expect(clientAddress(app, WEB, '203.0.113.9, 172.18.0.2')).toBe('203.0.113.9');
  });

  it('a connection that does not come from a private address cannot claim another one', () => {
    expect(clientAddress(app, '198.51.100.4', '203.0.113.9')).toBe('198.51.100.4');
    expect(clientAddress(app, '127.0.0.1', '203.0.113.9')).toBe('127.0.0.1');
  });

  it('with no forwarded address every request looks like the web container: per-address limits then act as one shared limit, never as none', () => {
    expect(clientAddress(app, WEB)).toBe(WEB);
  });

  it('without TRUST_PROXY (the default) the header is never believed', () => {
    expect(clientAddress(appWith({ trust: 'false' }), WEB, '203.0.113.9')).toBe(WEB);
  });
});

describe('request size', () => {
  const body = JSON.stringify({ question: 'x'.repeat(300 * 1024) });
  it('in demo mode the API refuses a body over 256 KB before anything reads it', async () => {
    const res = await request(appWith({ demo: true })).post('/api/v1/auth/demo').set('content-type', 'application/json').send(body);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });
  it('outside demo mode the usual limit applies', async () => {
    const res = await request(appWith({ demo: false })).post('/api/v1/auth/login').set('content-type', 'application/json').send(body);
    expect(res.status).not.toBe(413);
  });
});

describe('the demo proxy configuration', () => {
  const nginx = readFileSync(resolve(__dirname, '../../../deploy/public-demo/nginx.conf.template'), 'utf8');
  const locations = [...nginx.matchAll(/location\s+(?:~\*\s+)?([^\s{]+)\s*\{([^}]*)\}/g)].map(([, path, body]) => ({ path: path!, body: body! }));

  it('every location that forwards to the web app overwrites X-Forwarded-For with the connecting address', () => {
    const proxied = locations.filter((l) => l.body.includes('proxy_pass'));
    expect(proxied.map((l) => l.path)).toEqual(['^/api/v1/auth/', '^/api/', '/']);
    for (const l of proxied) expect(l.body, l.path).toMatch(/proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/);
    expect(nginx).not.toMatch(/proxy_add_x_forwarded_for/);
  });

  it("refuses a path that climbs out of /api, so the API's unauthenticated /metrics, /ready and /health stay internal", () => {
    // This checks the rule's presence and its pattern, not Nginx itself. Nginx's behaviour (400 before the upstream
    // for these forms, normal paths passed) was checked against a running proxy: DEPLOYMENT_READINESS_REPORT.md.
    const guard = nginx.match(/if \(\$request_uri ~\* "([^"]+)"\) \{ return 400; \}/);
    expect(guard, 'the path guard').not.toBeNull();
    const refused = new RegExp(guard![1]!, 'i');
    for (const uri of ['/api/../metrics', '/api/v1/../../ready', '/api/v1/%2e%2e/%2e%2e/metrics', '/api/v1/%2E%2E/health', '/api/v1/%252e%252e/metrics', '/api/v1/.%2e/x']) expect(refused.test(uri), uri).toBe(true);
    for (const uri of ['/login', '/api/v1/incidents/cmwmd9xt30xdpn22jwsekmt7a', '/_next/static/chunks/app.js', '/api/v1/logs?query=a..b%2e']) expect(refused.test(uri), uri).toBe(false);
  });

  it('limits request bodies, request rates and connections per address, and answers a refusal with 429', () => {
    expect(nginx).toMatch(/client_max_body_size\s+256k;/);
    expect(nginx).toMatch(/limit_req_zone\s+\$binary_remote_addr/);
    expect(nginx).toMatch(/limit_req_status\s+429;/);
    for (const l of locations.filter((x) => x.path.startsWith('^/api/'))) expect(l.body, l.path).toMatch(/limit_req\s+zone=/);
    // Matched without regard to case, as the web app routes them: /API/... gets the same limits.
    expect(nginx).toMatch(/location ~\* \^\/api\/v1\/auth\/ \{/);
    expect(nginx).toMatch(/location ~\* \^\/api\/ \{/);
    expect(nginx).toMatch(/limit_conn\s+demo_conn/);
  });
});
