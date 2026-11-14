import { describe, expect, it } from 'vitest';
import { fingerprint } from '../src/lib/logParsing';
import { LOG_COUNT_CAP, logAnomalies, logHistogram, logPatterns } from '../src/modules/logs';
import { api, createApiKey, createOrg, createService, prisma } from './helpers';

// The log queries that were rewritten for speed (docs/performance-investigation.md) must
// return exactly what they returned before. Each is checked against the answer worked out
// here from the rows themselves, not against the query's own earlier output.
type Org = Awaited<ReturnType<typeof createOrg>>;
const MIN = 60_000;
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * MIN);

async function seed(org: Org) {
  const [checkout, payments] = [await createService(org.owner, 'Checkout'), await createService(org.owner, 'Payments')];
  const line = (serviceId: string | null, level: 'INFO' | 'WARN' | 'ERROR' | 'FATAL', message: string, minutesAgo: number) => ({ organizationId: org.organizationId, serviceId, level, message, timestamp: at(minutesAgo), fingerprint: fingerprint(message) });
  const rows = [
    // One pattern in two services, one of them with mixed levels.
    ...Array.from({ length: 12 }, (_, i) => line(checkout.id, i % 4 === 0 ? 'FATAL' : 'ERROR', `timeout acquiring connection after ${3000 + i}ms`, 5 + i)),
    ...Array.from({ length: 7 }, (_, i) => line(payments.id, 'ERROR', `timeout acquiring connection after ${2000 + i}ms`, 8 + i)),
    ...Array.from({ length: 20 }, (_, i) => line(checkout.id, 'INFO', `request served in ${10 + i}ms`, 1 + i)),
    ...Array.from({ length: 5 }, (_, i) => line(payments.id, 'WARN', `retrying upstream call attempt ${i + 1}`, 20 + i)),
    // Lines that belong to no service.
    ...Array.from({ length: 3 }, (_, i) => line(null, 'ERROR', `unhandled rejection in worker ${i}`, 30 + i)),
    // Outside the window.
    ...Array.from({ length: 9 }, (_, i) => line(checkout.id, 'ERROR', `timeout acquiring connection after ${i}ms`, 200 + i)),
  ];
  await prisma.logEntry.createMany({ data: rows });
  return { checkout, payments, rows };
}

/** What the patterns of a set of rows are, worked out the slow, obvious way. */
function expectedPatterns(rows: Awaited<ReturnType<typeof seed>>['rows'], names: Record<string, { name: string; slug: string }>) {
  const groups = new Map<string, typeof rows>();
  for (const r of rows) groups.set(`${r.fingerprint}|${r.serviceId}`, [...(groups.get(`${r.fingerprint}|${r.serviceId}`) ?? []), r]);
  return [...groups.values()]
    .map((g) => ({
      fingerprint: g[0]!.fingerprint,
      serviceId: g[0]!.serviceId,
      serviceName: g[0]!.serviceId ? names[g[0]!.serviceId]!.name : null,
      serviceSlug: g[0]!.serviceId ? names[g[0]!.serviceId]!.slug : null,
      count: g.length,
      sample: g.map((r) => r.message).sort()[0],
      level: g.map((r) => r.level as string).sort().at(-1),
      firstSeen: new Date(Math.min(...g.map((r) => r.timestamp.getTime()))),
      lastSeen: new Date(Math.max(...g.map((r) => r.timestamp.getTime()))),
    }))
    .sort((a, b) => b.count - a.count || a.fingerprint.localeCompare(b.fingerprint));
}

describe('log patterns', () => {
  it('are exactly the groups of the lines in the window, with their service, whatever the limit and filter', async () => {
    const org = await createOrg();
    const { checkout, payments, rows } = await seed(org);
    const names = { [checkout.id]: { name: 'Checkout', slug: 'checkout' }, [payments.id]: { name: 'Payments', slug: 'payments' } };
    const window = { organizationId: org.organizationId, from: at(120), to: new Date() };
    const inWindow = rows.filter((r) => r.timestamp >= window.from);

    const all = await logPatterns(window, 100);
    const expected = expectedPatterns(inWindow, names);
    // The same pattern in two services is two entries; lines without a service are an entry without one.
    expect(all).toHaveLength(5);
    expect(all.map((p) => ({ ...p, sample: p.sample }))).toEqual(expected);
    expect(all.find((p) => p.serviceId === null)).toMatchObject({ count: 3, serviceName: null, serviceSlug: null });
    // A limit keeps the most frequent.
    expect(await logPatterns(window, 2)).toEqual(expected.slice(0, 2));
    // Filters: level, service, text.
    expect(await logPatterns({ ...window, levels: ['ERROR', 'FATAL'] }, 100)).toEqual(expectedPatterns(inWindow.filter((r) => r.level === 'ERROR' || r.level === 'FATAL'), names));
    expect(await logPatterns({ ...window, levels: ['WARN'] }, 100)).toEqual(expectedPatterns(inWindow.filter((r) => r.level === 'WARN'), names));
    expect(await logPatterns({ ...window, serviceIds: [payments.id] }, 100)).toEqual(expectedPatterns(inWindow.filter((r) => r.serviceId === payments.id), names));
    expect(await logPatterns({ ...window, q: 'RETRYING' }, 100)).toEqual(expectedPatterns(inWindow.filter((r) => r.message.includes('retrying')), names));
    expect(await logPatterns({ ...window, from: at(2000), to: at(190) }, 100)).toEqual(expectedPatterns(rows.filter((r) => r.timestamp < at(190)), names));

    // Another organisation's lines are never part of it, and it sees none of these.
    const other = await createOrg();
    const theirs = await createService(other.owner, 'Checkout');
    await prisma.logEntry.create({ data: { organizationId: other.organizationId, serviceId: theirs.id, level: 'ERROR', message: 'timeout acquiring connection after 3000ms', timestamp: at(5), fingerprint: fingerprint('timeout acquiring connection after 3000ms') } });
    expect(await logPatterns(window, 100)).toEqual(expected);
    expect((await logPatterns({ ...window, organizationId: other.organizationId }, 100)).map((p) => [p.count, p.serviceSlug])).toEqual([[1, 'checkout']]);
    // Through the API, for a viewer.
    const viaApi = (await (await org.member('VIEWER')).agent.get('/api/v1/logs/patterns?from=2h').expect(200)).body.data as { fingerprint: string; count: number; serviceSlug: string | null }[];
    expect(viaApi.map((p) => [p.fingerprint, p.count, p.serviceSlug])).toEqual(expected.map((p) => [p.fingerprint, p.count, p.serviceSlug]));
  });

  it('feed the same anomalies and histogram as before when filtered by level', async () => {
    const org = await createOrg();
    const { rows } = await seed(org);
    const window = { organizationId: org.organizationId, from: at(60), to: new Date() };
    // New in the window: every WARN/ERROR/FATAL pattern with at least three lines (the old timeouts are in the baseline for checkout).
    const anomalies = await logAnomalies(window);
    expect(anomalies.map((a) => [a.kind, a.count, a.serviceSlug]).sort()).toEqual([['new', 3, null], ['new', 5, 'payments'], ['new', 7, 'payments'], ['spike', 12, 'checkout']].sort());
    const histogram = await logHistogram({ ...window, levels: ['ERROR', 'FATAL'] });
    const inWindow = rows.filter((r) => r.timestamp >= window.from && (r.level === 'ERROR' || r.level === 'FATAL'));
    expect(histogram.buckets.reduce((a, b) => a + Number(b.total), 0)).toBe(inWindow.length);
    expect(histogram.buckets.reduce((a, b) => a + Number(b.FATAL), 0)).toBe(inWindow.filter((r) => r.level === 'FATAL').length);
    expect(histogram.buckets.every((b) => Number(b.INFO) === 0 && Number(b.WARN) === 0)).toBe(true);
    // The level filter of the list is unchanged too, in any spelling the API accepts.
    const listed = (await org.owner.get('/api/v1/logs?from=1h&level=error,fatal&pageSize=500').expect(200)).body;
    expect(listed.meta).toMatchObject({ total: inWindow.length, totalIsLowerBound: false });
    expect(new Set(listed.data.map((l: { level: string }) => l.level))).toEqual(new Set(['ERROR', 'FATAL']));
  });
});

describe('counting log lines', () => {
  it('is exact up to the cap, says "at least" beyond it, and stays exact for investigations', async () => {
    const org = await createOrg();
    const service = await createService(org.owner, 'Checkout');
    const extra = 57;
    await prisma.logEntry.createMany({
      data: Array.from({ length: LOG_COUNT_CAP + extra }, (_, i) => ({ organizationId: org.organizationId, serviceId: service.id, level: i % 100 === 0 ? ('ERROR' as const) : ('INFO' as const), message: i % 100 === 0 ? `payment declined for order ${i}` : `request served in ${i}ms`, timestamp: at(1 + (i % 50)), fingerprint: i % 100 === 0 ? 'declined' : 'served' })),
    });
    const errors = Math.ceil((LOG_COUNT_CAP + extra) / 100);

    // More matches than the cap: the page is right, and the total is honestly a lower bound.
    const everything = (await org.owner.get('/api/v1/logs?from=2h&pageSize=50').expect(200)).body;
    expect(everything.data).toHaveLength(50);
    expect(everything.meta).toEqual({ page: 1, pageSize: 50, total: LOG_COUNT_CAP, totalPages: LOG_COUNT_CAP / 50, totalIsLowerBound: true });
    // The last reachable page still holds real lines.
    expect((await org.owner.get(`/api/v1/logs?from=2h&pageSize=50&page=${LOG_COUNT_CAP / 50}`).expect(200)).body.data).toHaveLength(50);
    // Text search over many matches behaves the same.
    // Text search: every message contains an "e"; only some contain "served", just under the cap.
    expect((await org.owner.get('/api/v1/logs?from=2h&q=e').expect(200)).body.meta).toMatchObject({ total: LOG_COUNT_CAP, totalIsLowerBound: true });
    expect((await org.owner.get('/api/v1/logs?from=2h&q=served').expect(200)).body.meta).toMatchObject({ total: LOG_COUNT_CAP + extra - errors, totalIsLowerBound: false });

    // Fewer matches than the cap: exact, and said to be.
    expect((await org.owner.get('/api/v1/logs?from=2h&level=error').expect(200)).body.meta).toMatchObject({ total: errors, totalIsLowerBound: false });
    expect((await org.owner.get('/api/v1/logs?from=2h&q=declined').expect(200)).body.meta).toMatchObject({ total: errors, totalIsLowerBound: false });
    expect((await org.owner.get('/api/v1/logs?from=2h&q=no-such-text').expect(200)).body.meta).toMatchObject({ total: 0, totalPages: 0, totalIsLowerBound: false });

    // An investigation cites the number it is given, so the tool API counts every line.
    const key = await createApiKey(org.owner, ['tools:read']);
    const tool = (await api().get('/api/v1/tools/logs/search?from=2h&service=checkout&limit=5').set('x-api-key', key).expect(200)).body;
    expect(tool.totalMatching).toBe(LOG_COUNT_CAP + extra);
    expect(tool.returned).toBe(5);

    // Another organisation counts none of them.
    const other = await createOrg();
    expect((await other.owner.get('/api/v1/logs?from=2h').expect(200)).body.meta).toMatchObject({ total: 0, totalIsLowerBound: false });
  });
});
