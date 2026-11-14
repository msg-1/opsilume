import { describe, expect, it } from 'vitest';
import { purgeExpiredIdempotencyKeys } from '../src/lib/idempotency';
import { applyRetention } from '../src/modules/system';
import { api, createApiKey, createOrg, createService, prisma } from './helpers';

// A client that got no answer sends its batch again. With an Idempotency-Key the second
// request must store nothing and be answered as the first was; without one, every request is
// separate telemetry and must be stored.
type Org = Awaited<ReturnType<typeof createOrg>>;
const SCOPES = ['ingest:logs', 'ingest:metrics', 'ingest:deployments', 'ingest:events'];
const post = (key: string, path: string, body: unknown, idempotencyKey?: string) => {
  const req = api().post(`/api/v1/${path}`).set('x-api-key', key);
  return (idempotencyKey === undefined ? req : req.set('Idempotency-Key', idempotencyKey)).send(body as object);
};
const LOGS = { service: 'checkout', logs: [{ level: 'error', message: 'timeout acquiring connection' }, { level: 'info', message: 'request served' }] };
const METRICS = { samples: [{ service: 'checkout', metric: 'error_rate', value: 2.5 }, { service: 'checkout', metric: 'latency_p95_ms', value: 410 }] };
const DEPLOY = { service: 'checkout', version: 'v2.0.0', commitSha: 'abc1234' };
const EVENT = { service: 'checkout', type: 'config_change', title: 'Pool size raised' };

async function setup() {
  const org = await createOrg();
  await createService(org.owner, 'Checkout');
  return { org, key: await createApiKey(org.owner, SCOPES) };
}
const stored = async (org: Org) => ({
  logs: await prisma.logEntry.count({ where: { organizationId: org.organizationId } }),
  metrics: await prisma.metricSample.count({ where: { organizationId: org.organizationId } }),
  deployments: await prisma.deployment.count({ where: { organizationId: org.organizationId } }),
  events: await prisma.serviceEvent.count({ where: { organizationId: org.organizationId } }),
  keys: await prisma.ingestionRequest.count({ where: { organizationId: org.organizationId } }),
});

describe('ingestion with an Idempotency-Key', () => {
  it('stores a retried request once, on every ingestion endpoint, and answers the retry as it answered the first', async () => {
    const { org, key } = await setup();
    for (const [path, body, status] of [['logs', LOGS, 202], ['monitoring/metrics', METRICS, 202], ['deployments', DEPLOY, 201], ['service-events', EVENT, 201]] as const) {
      const name = `retry-${path.replace('/', '.')}-0001`;
      const first = await post(key, path, body, name);
      expect(first.status).toBe(status);
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      for (let i = 0; i < 3; i++) {
        const again = await post(key, path, body, name);
        expect(again.status).toBe(status);
        expect(again.headers['idempotent-replayed']).toBe('true');
        expect(again.body).toEqual(first.body); // the same answer, down to the id of the record
      }
    }
    expect(await stored(org)).toEqual({ logs: 2, metrics: 2, deployments: 1, events: 1, keys: 4 });
    // A repeated request is not a second action: it is not audited again.
    expect(await prisma.auditLog.count({ where: { organizationId: org.organizationId, action: { in: ['deployment.record', 'service_event.record'] } } })).toBe(2);
    // The same content in another order, or with other spacing, is the same request.
    const sameKeyOtherOrder = await api().post('/api/v1/logs').set('x-api-key', key).set('Idempotency-Key', 'retry-logs-0001').set('content-type', 'application/json').send(`{ "logs": [ {"message":"timeout acquiring connection","level":"error"}, {"message":"request served","level":"info"} ],   "service": "checkout" }`);
    expect(sameKeyOtherOrder.headers['idempotent-replayed']).toBe('true');
    expect((await stored(org)).logs).toBe(2);
  });

  it('does not deduplicate anything it was not asked to: without a key, or with different keys, every request is stored', async () => {
    const { org, key } = await setup();
    // Two identical batches are two sets of telemetry unless the client says they are one.
    await post(key, 'logs', LOGS).expect(202);
    await post(key, 'logs', LOGS).expect(202);
    await post(key, 'logs', LOGS, 'batch-00000001').expect(202);
    await post(key, 'logs', LOGS, 'batch-00000002').expect(202);
    await post(key, 'monitoring/metrics', METRICS).expect(202);
    await post(key, 'monitoring/metrics', METRICS).expect(202);
    expect(await stored(org)).toMatchObject({ logs: 8, metrics: 4, keys: 2 });
    // A key belongs to one endpoint: the same key on another endpoint is another request.
    await post(key, 'monitoring/metrics', METRICS, 'batch-00000001').expect(202);
    expect(await stored(org)).toMatchObject({ metrics: 6, keys: 3 });
  });

  it('refuses the same key with a different body, and stores nothing of it', async () => {
    const { org, key } = await setup();
    await post(key, 'logs', LOGS, 'key-reused-01').expect(202);
    const other = await post(key, 'logs', { service: 'checkout', logs: [{ level: 'error', message: 'a different line' }] }, 'key-reused-01');
    expect(other.status).toBe(422);
    expect(other.body.error).toMatchObject({ code: 'idempotency_key_reused' });
    expect(other.body.error.message).toContain('Nothing was stored');
    expect(JSON.stringify(other.body)).not.toContain('a different line');
    await post(key, 'deployments', DEPLOY, 'key-reused-02').expect(201);
    expect((await post(key, 'deployments', { ...DEPLOY, version: 'v2.0.1' }, 'key-reused-02')).status).toBe(422);
    expect(await stored(org)).toMatchObject({ logs: 2, deployments: 1 });
    // The original request can still be repeated.
    expect((await post(key, 'logs', LOGS, 'key-reused-01')).headers['idempotent-replayed']).toBe('true');
    // The mistake is visible to whoever looks after the integration.
    const overview = (await org.owner.get('/api/v1/integrations').expect(200)).body;
    expect(overview.integrations.find((i: { id: string }) => i.id === 'deployments').lastError.message).toContain('Idempotency-Key was already used with a different request body');
  });

  it('stores once when the same request arrives many times at the same moment', async () => {
    const { org, key } = await setup();
    const batch = { service: 'checkout', logs: Array.from({ length: 200 }, (_, i) => ({ level: 'info', message: `line ${i}` })) };
    const results = await Promise.all(Array.from({ length: 12 }, () => post(key, 'logs', batch, 'concurrent-0001')));
    expect(results.map((r) => r.status)).toEqual(Array(12).fill(202));
    expect(results.filter((r) => r.headers['idempotent-replayed'] !== 'true')).toHaveLength(1);
    expect(new Set(results.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect(await stored(org)).toMatchObject({ logs: 200, keys: 1 });
    // Deployments, where a duplicate would be a second release on record.
    const deploys = await Promise.all(Array.from({ length: 8 }, () => post(key, 'deployments', DEPLOY, 'concurrent-0002')));
    expect(deploys.map((r) => r.status)).toEqual(Array(8).fill(201));
    expect(new Set(deploys.map((r) => r.body.id)).size).toBe(1);
    expect((await stored(org)).deployments).toBe(1);
    // Concurrent requests with different bodies under one key: one is stored, the others are refused, none is lost silently.
    const mixed = await Promise.all(Array.from({ length: 6 }, (_, i) => post(key, 'service-events', { ...EVENT, title: `Change ${i}` }, 'concurrent-0003')));
    expect(mixed.filter((r) => r.status === 201)).toHaveLength(1);
    expect(mixed.filter((r) => r.status === 422)).toHaveLength(5);
    expect((await stored(org)).events).toBe(1);
  });

  it('keeps organisations apart: the same key in two organisations is two requests', async () => {
    const [a, b] = [await setup(), await setup()];
    const first = await post(a.key, 'logs', LOGS, 'shared-key-0001').expect(202);
    const second = await post(b.key, 'logs', LOGS, 'shared-key-0001').expect(202);
    expect(second.headers['idempotent-replayed']).toBeUndefined();
    expect(await stored(a.org)).toMatchObject({ logs: 2, keys: 1 });
    expect(await stored(b.org)).toMatchObject({ logs: 2, keys: 1 });
    // And with different bodies neither is told about the other's.
    expect((await post(b.key, 'deployments', DEPLOY, 'shared-key-0002')).status).toBe(201);
    const inA = await post(a.key, 'deployments', { ...DEPLOY, version: 'v9.9.9' }, 'shared-key-0002');
    expect(inA.status).toBe(201);
    expect(inA.body.version).toBe('v9.9.9');
    expect(first.body).toEqual(second.body);
  });

  it('records no key for a request that failed, so the corrected or repeated request is processed', async () => {
    const { org, key } = await setup();
    // Invalid body.
    expect((await post(key, 'logs', { logs: [] }, 'failed-then-ok-01')).status).toBe(400);
    // Unknown service on an endpoint that refuses it.
    expect((await post(key, 'deployments', { ...DEPLOY, service: 'not-registered' }, 'failed-then-ok-02')).status).toBe(404);
    // A rollback that refers to nothing: refused after the service was found, inside the transaction.
    expect((await post(key, 'deployments', { ...DEPLOY, version: 'v3', rollbackOf: 'v-does-not-exist' }, 'failed-then-ok-03')).status).toBe(400);
    expect(await stored(org)).toEqual({ logs: 0, metrics: 0, deployments: 0, events: 0, keys: 0 });
    // The same keys work once the request is right, even though the body is now different.
    await post(key, 'logs', LOGS, 'failed-then-ok-01').expect(202);
    await post(key, 'deployments', DEPLOY, 'failed-then-ok-02').expect(201);
    await post(key, 'deployments', { ...DEPLOY, version: 'v3' }, 'failed-then-ok-03').expect(201);
    expect(await stored(org)).toMatchObject({ logs: 2, deployments: 2, keys: 3 });
    // A malformed key is refused before anything else happens.
    for (const bad of ['short', 'has spaces in it', 'x'.repeat(129), 'semi;colon;key', '']) expect((await post(key, 'logs', LOGS, bad)).status, bad).toBe(400);
    expect((await stored(org)).logs).toBe(2);
    // The key travels in a header; it needs the ingestion scope like any other request.
    const readOnly = await createApiKey(org.owner, ['tools:read']);
    expect((await post(readOnly, 'logs', LOGS, 'failed-then-ok-01')).status).toBe(403);
  });

  it('forgets a key after its retention: a retry after that is a new request, and expired keys are removed', async () => {
    const { org, key } = await setup();
    await post(key, 'logs', LOGS, 'expiring-key-01').expect(202);
    await post(key, 'logs', LOGS, 'kept-key-000001').expect(202);
    const row = await prisma.ingestionRequest.findFirstOrThrow({ where: { organizationId: org.organizationId, key: 'expiring-key-01' } });
    // Remembered for a day by default.
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThan(23.9 * 3_600_000);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeLessThan(24.1 * 3_600_000);

    await prisma.ingestionRequest.update({ where: { organizationId_scope_key: { organizationId: org.organizationId, scope: 'logs', key: 'expiring-key-01' } }, data: { expiresAt: new Date(Date.now() - 1000) } });
    // Not yet purged, already expired: the key is free, even for a different body.
    const later = await post(key, 'logs', { service: 'checkout', logs: [{ message: 'a later, different batch' }] }, 'expiring-key-01');
    expect(later.status).toBe(202);
    expect(later.headers['idempotent-replayed']).toBeUndefined();
    expect((await stored(org)).logs).toBe(5);

    // The hourly retention job removes what has expired and nothing else.
    await prisma.ingestionRequest.update({ where: { organizationId_scope_key: { organizationId: org.organizationId, scope: 'logs', key: 'expiring-key-01' } }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await applyRetention();
    expect((await prisma.ingestionRequest.findMany({ where: { organizationId: org.organizationId }, select: { key: true } })).map((r) => r.key)).toEqual(['kept-key-000001']);
    expect(await purgeExpiredIdempotencyKeys()).toBe(0);
    expect((await post(key, 'logs', LOGS, 'kept-key-000001')).headers['idempotent-replayed']).toBe('true');
  });
});
