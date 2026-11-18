#!/usr/bin/env node
// Diagnoses what reads wait for while logs are being ingested. Isolated stack only.
//
//   node scripts/perf-probe.mjs [--seconds 20] [--lines 1000] [--writers 8] [--readers 4] [--label name]
//
// It runs writers and readers side by side and, four times a second, samples the API's own
// event-loop lag and what every PostgreSQL connection of the application is doing. Slow reads
// are then set beside what was happening at that moment. Used for docs/performance-investigation.md.
import { PROJECT, URLS, compose, composeAsync } from './isolated-stack.mjs';

if (PROJECT === 'opsilume') throw new Error('Refusing to run against the default Compose project.');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const SECONDS = Number(arg('seconds', 20));
const LINES = Number(arg('lines', 1000));
const WRITERS = Number(arg('writers', 8));
const READERS = Number(arg('readers', 4));
const WRITE_EVERY_MS = Number(arg('write-every', 320));
const READ_EVERY_MS = Number(arg('read-every', 400));
const API = `${URLS.api}/api/v1`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const cookies = new Map();
async function call(method, path, body, headers = {}) {
  const began = performance.now();
  let status = 0;
  try {
    const res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', origin: URLS.web, ...(headers['x-api-key'] ? {} : { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') }), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      cookies.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1));
    }
    status = res.status;
    var data = await res.json().catch(() => ({}));
  } catch {
    status = 0;
  }
  return { status, data, at: began, ms: performance.now() - began };
}
// Sampling while requests are in flight must not block this process (see isolated-stack.mjs).
const psqlAsync = async (q) => (await composeAsync(['exec', '-T', 'postgres', 'psql', '-U', 'opsilume', '-d', 'opsilume', '-AtF', '\t', '-c', q])).stdout.trim();
const psql = (q) => compose(['exec', '-T', 'postgres', 'psql', '-U', 'opsilume', '-d', 'opsilume', '-AtF', '\t', '-c', q], { capture: true }).stdout.trim();
const q = (sorted, p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0);
const stats = (all) => {
  // Only answered requests have a latency worth reporting; the rest are counted beside it.
  const samples = all.filter((s) => s.status >= 200 && s.status < 300);
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  return { n: ms.length, p50: q(ms, 0.5), p95: q(ms, 0.95), p99: q(ms, 0.99), max: Math.round(ms.at(-1) ?? 0), errors: all.filter((s) => s.status === 0 || s.status >= 500).length, refused: all.filter((s) => s.status === 429).length };
};

await call('POST', '/auth/login', { email: 'demo@example.com', password: 'Opsilume-demo-1' });
const services = (await call('GET', '/services?pageSize=50')).data.data.map((s) => s.slug);
const incident = (await call('GET', '/incidents?pageSize=1')).data.data[0];
const key = (await call('POST', '/api-keys', { name: `probe ${Date.now()}`, scopes: ['ingest:logs'] })).data.secret;
// A fixed starting point, so that two runs can be compared: --reset empties the isolated log
// table, --preload N fills it through the API (so fingerprints, redaction and indexes are what
// the application produces) at a pace under the API's rate limit, then waits a minute.
if (process.argv.includes('--reset')) psql('TRUNCATE "LogEntry"');
const PRELOAD = Number(arg('preload', 0));
if (PRELOAD) {
  let have = Number(psql('SELECT count(*) FROM "LogEntry"'));
  const began = performance.now();
  for (let i = 0; have < PRELOAD; i++) {
    await Promise.all(Array.from({ length: 5 }, (_, c) => call('POST', '/logs', { service: services[(i + c) % services.length], logs: Array.from({ length: 1000 }, (_, n) => ({ level: n % 10 === 0 ? 'error' : n % 25 === 0 ? 'warn' : 'info', message: `preload ${['request served in', 'cache miss for key', 'timeout acquiring connection after', 'payment declined for order', 'retrying upstream call attempt'][(n + c) % 5]} ${1000 + n}`, timestamp: new Date(Date.now() - ((n * 2971 + i * 7919) % 3_000_000)).toISOString() })) }, { 'x-api-key': key })));
    have += 5000;
    await pause(350);
  }
  psql('VACUUM (ANALYZE) "LogEntry"');
  console.log(`Preloaded to ${Number(psql('SELECT count(*) FROM "LogEntry"')).toLocaleString('en-GB')} lines in ${((performance.now() - began) / 1000).toFixed(0)} s; waiting 65 s for the rate limit window`);
  await pause(65_000);
}
const rowsBefore = Number(psql('SELECT count(*) FROM "LogEntry"'));

/** The API's own record of how long it took to answer, which no client-side effect can distort. */
async function serverSide() {
  const text = await fetch(`${URLS.api}/metrics`).then((r) => r.text(), () => '');
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^opsilume_http_request_duration_seconds_bucket\{le="([^"]+)",method="(GET|POST)",route="(\/api\/v1\/[^"]*)",status="2\d\d"\} (\S+)/);
    if (!m || m[3].includes('/auth/') || m[3].includes('/api-keys')) continue;
    const kind = m[2] === 'POST' ? 'writes' : 'reads';
    (out[kind] ??= {})[m[1]] = (out[kind][m[1]] ?? 0) + Number(m[4]);
  }
  return out;
}
const fromBuckets = (before, after, kind) => {
  const d = Object.fromEntries(Object.keys(after[kind] ?? {}).map((le) => [le, after[kind][le] - (before[kind]?.[le] ?? 0)]));
  const n = d['+Inf'] ?? 0;
  // The smallest bucket boundary that holds the given share of requests: an upper bound on the percentile.
  const upper = (p) => Object.keys(d).filter((le) => le !== '+Inf').map(Number).sort((a, b) => a - b).find((le) => d[String(le)] >= p * n);
  return { n, over250ms: n - (d['0.25'] ?? 0), over1s: n - (d['1'] ?? 0), p50Under: upper(0.5), p95Under: upper(0.95), p99Under: upper(0.99) };
};
const serverBefore = await serverSide();
const deadline = performance.now() + SECONDS * 1000;
const t0 = performance.now();
const writes = [];
const reads = [];
const samples = [];
const READ_PATHS = ['/incidents?pageSize=20', `/incidents/${incident.id}`, '/logs?from=1h&pageSize=50', '/logs?from=1h&q=order', '/logs/patterns?from=1h', '/dashboard', '/integrations', '/services?pageSize=50'];

const writer = async (c) => {
  for (let i = 0; performance.now() < deadline; i++) {
    const logs = Array.from({ length: LINES }, (_, n) => ({ level: n % 10 === 0 ? 'error' : 'info', message: `probe request ${c}-${i} line ${n} for order ${1000 + n}`, timestamp: new Date(Date.now() - n * 100).toISOString() }));
    const sent = performance.now();
    writes.push(await call('POST', '/logs', { service: services[c % services.length], logs }, { 'x-api-key': key }));
    // A fixed rate, whatever the latency: each writer starts a request every WRITE_EVERY_MS. A
    // probe that sends "as fast as answers come" sends more when the server gets faster, runs
    // into the API's rate limit, and then compares two different workloads.
    await pause(Math.max(0, WRITE_EVERY_MS - (performance.now() - sent)));
  }
};
const reader = async (c) => {
  for (let i = 0; performance.now() < deadline; i++) {
    const path = READ_PATHS[(c + i) % READ_PATHS.length];
    const sent = performance.now();
    reads.push({ path: path.split('?')[0].replace(incident.id, ':id') + (path.includes('q=') ? '?q' : ''), ...(await call('GET', path)) });
    await pause(Math.max(0, READ_EVERY_MS - (performance.now() - sent)));
  }
};
const sampler = async () => {
  while (performance.now() < deadline) {
    const at = performance.now();
    const [metrics, activity] = await Promise.all([
      fetch(`${URLS.api}/metrics`).then((r) => r.text(), () => ''),
      psqlAsync(`SELECT state, coalesce(wait_event_type, '-'), coalesce(wait_event, '-'), round(extract(epoch FROM now() - query_start) * 1000), left(regexp_replace(query, '\\s+', ' ', 'g'), 60) FROM pg_stat_activity WHERE datname = 'opsilume' AND pid <> pg_backend_pid() AND application_name <> 'psql'`),
    ]);
    const lag = (name) => (Number(metrics.match(new RegExp(`opsilume_api_nodejs_eventloop_lag_${name}seconds (\\S+)`))?.[1]) || 0) * 1000;
    const rows = activity.split('\n').filter(Boolean).map((l) => l.split('\t'));
    samples.push({ at, sampleMs: performance.now() - at, lagMs: lag(''), lagP99Ms: lag('p99_'), lagMaxMs: lag('max_'), connections: rows.length, active: rows.filter((r) => r[0] === 'active'), waiting: rows.filter((r) => r[0] === 'active' && r[1] !== '-') });
    await pause(250);
  }
};
await Promise.all([...Array.from({ length: WRITERS }, (_, c) => writer(c)), ...Array.from({ length: READERS }, (_, c) => reader(c)), sampler()]);
const seconds = (performance.now() - t0) / 1000;
const serverAfter = await serverSide();
const serverReads = fromBuckets(serverBefore, serverAfter, 'reads');
const stored = Number(psql('SELECT count(*) FROM "LogEntry"')) - rowsBefore;

const out = (line = '') => console.log(line);
out(`Probe${arg('label') ? ` [${arg('label')}]` : ''}: ${WRITERS} writers × ${LINES} lines, ${READERS} readers, ${seconds.toFixed(0)} s; table had ${rowsBefore.toLocaleString('en-GB')} lines before`);
const w = stats(writes);
out(`  writes  ${w.n} requests, ${stored.toLocaleString('en-GB')} lines stored (${Math.round(stored / seconds).toLocaleString('en-GB')}/s): p50 ${w.p50} ms, p95 ${w.p95} ms, p99 ${w.p99} ms, max ${w.max} ms, errors ${w.errors}; statuses ${JSON.stringify(Object.fromEntries([...new Set(writes.map((x) => x.status))].map((s) => [s, writes.filter((x) => x.status === s).length])))}`);
const r = stats(reads);
out(`  reads   ${r.n} requests: p50 ${r.p50} ms, p95 ${r.p95} ms, p99 ${r.p99} ms, max ${r.max} ms, errors ${r.errors}, refused by the rate limit ${r.refused}`);
out(`  reads, as the API itself timed them: ${serverReads.n} requests; p50 ≤ ${serverReads.p50Under * 1000} ms, p95 ≤ ${serverReads.p95Under * 1000} ms, p99 ≤ ${serverReads.p99Under * 1000} ms; over 250 ms: ${serverReads.over250ms}; over 1 s: ${serverReads.over1s}`);
for (const path of [...new Set(reads.map((x) => x.path))].sort()) {
  const s = stats(reads.filter((x) => x.path === path));
  out(`    ${path.padEnd(22)} n ${String(s.n).padStart(3)}  p50 ${String(s.p50).padStart(5)}  p95 ${String(s.p95).padStart(5)}  max ${String(s.max).padStart(5)} ms`);
}
const lagMax = Math.max(...samples.map((s) => s.lagMaxMs));
out(`  API event loop lag: sampled mean ${Math.round(samples.reduce((a, s) => a + s.lagMs, 0) / samples.length)} ms, highest p99 ${Math.round(Math.max(...samples.map((s) => s.lagP99Ms)))} ms, highest max ${Math.round(lagMax)} ms`);
out(`  database connections: peak ${Math.max(...samples.map((s) => s.connections))}, peak active ${Math.max(...samples.map((s) => s.active.length))}, peak waiting on something ${Math.max(...samples.map((s) => s.waiting.length))}`);
const waits = {};
for (const s of samples) for (const a of s.waiting) waits[`${a[1]}:${a[2]}`] = (waits[`${a[1]}:${a[2]}`] ?? 0) + 1;
out(`  wait events seen on active connections (samples): ${JSON.stringify(Object.fromEntries(Object.entries(waits).sort((a, b) => b[1] - a[1]).slice(0, 8)))}`);
const longest = samples.flatMap((s) => s.active.map((a) => ({ ms: Number(a[3]), wait: `${a[1]}:${a[2]}`, query: a[4] }))).sort((a, b) => b.ms - a.ms).slice(0, 6);
out('  longest-running statements seen:');
for (const l of longest) out(`    ${String(l.ms).padStart(6)} ms  ${l.wait.padEnd(24)} ${l.query}`);
// What was happening while the slowest reads were in flight.
const slow = [...reads].sort((a, b) => b.ms - a.ms).slice(0, 5);
out('  slowest reads, and what was going on while they waited:');
for (const s of slow) {
  const during = samples.filter((x) => x.at >= s.at - 300 && x.at <= s.at + s.ms);
  const writesDuring = writes.filter((x) => x.at < s.at + s.ms && x.at + x.ms > s.at);
  out(`    ${String(Math.round(s.ms)).padStart(5)} ms ${s.path.padEnd(18)} at +${((s.at - t0) / 1000).toFixed(1)}s: event-loop max ${Math.round(Math.max(0, ...during.map((d) => d.lagMaxMs)))} ms, active db ${Math.max(0, ...during.map((d) => d.active.length))}, waits ${[...new Set(during.flatMap((d) => d.waiting.map((a) => `${a[1]}:${a[2]}`)))].join(',') || 'none'}; overlapping writes ${writesDuring.length} (slowest ${Math.round(Math.max(0, ...writesDuring.map((x) => x.ms)))} ms)`);
}
if (process.argv.includes('--json')) out(JSON.stringify({ label: arg('label'), writers: WRITERS, readers: READERS, lines: LINES, seconds, rowsBefore, stored, writes: w, reads: r, serverReads, lagMax, byPath: Object.fromEntries([...new Set(reads.map((x) => x.path))].sort().map((p) => [p, stats(reads.filter((x) => x.path === p))])) }));
