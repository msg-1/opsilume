#!/usr/bin/env node
// A small, reproducible load test against the isolated stack (scripts/isolated-stack.mjs).
//
//   npm run isolated:up && npm run loadtest            # prints a report; --json for raw numbers
//
// It measures; it does not judge. The workload is deliberately modest (it shares a laptop
// with everything else) and every number it prints is true only of the machine it ran on.
// It never addresses the default Compose project.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { PROJECT, URLS, compose, composeAsync, run } from './isolated-stack.mjs';

if (PROJECT === 'opspilot') throw new Error('Refusing to run against the default Compose project.');

const DEMO = { email: 'demo@example.com', password: 'OpsPilot-demo-1' };
const API = `${URLS.api}/api/v1`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line = '') => console.log(line);

// ── Workload (kept under the API's limit of 1,200 requests a minute per client address) ──
const W = {
  logs: { clients: 8, requestsEach: 50, linesPerRequest: 1000 },
  metrics: { clients: 8, requestsEach: 40, samplesPerRequest: 500 },
  duplicates: { keys: 20, copiesEach: 10, linesPerRequest: 50 },
  reads: { clients: 4, requestsEach: 30 },
  investigations: { total: 40, atOnce: 3 },
};
// The API allows one client address 1,200 requests a minute. Phases are spaced so that the
// test measures the application and not its rate limiter.
const BETWEEN_PHASES_MS = 40_000;

const cookies = new Map();
async function call(method, path, body, headers = {}) {
  const began = performance.now();
  let status = 0;
  let data = {};
  let replayed = false;
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: URLS.web, ...(headers['x-api-key'] ? {} : { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') }), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    status = res.status;
    replayed = res.headers.get('idempotent-replayed') === 'true';
    data = await res.json().catch(() => ({}));
  } catch {
    status = 0;
  }
  return { status, data, replayed, ms: performance.now() - began };
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
function summarise(samples) {
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const byStatus = {};
  for (const s of samples) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
  return { requests: samples.length, statuses: byStatus, p50: Math.round(quantile(ms, 0.5)), p95: Math.round(quantile(ms, 0.95)), p99: Math.round(quantile(ms, 0.99)), max: Math.round(ms.at(-1)) };
}
/** Runs `clients` loops side by side, each doing `requestsEach` calls one after another. */
async function concurrently(clients, requestsEach, make) {
  const began = performance.now();
  const samples = (await Promise.all(Array.from({ length: clients }, async (_, c) => {
    const mine = [];
    for (let i = 0; i < requestsEach; i++) mine.push(await make(c, i));
    return mine;
  }))).flat();
  return { ...summarise(samples), seconds: (performance.now() - began) / 1000, samples };
}

// The Async forms are for anything that runs while requests are being timed. A synchronous
// child process freezes this process; responses that arrive meanwhile wait unread and the
// wait is counted as latency. The first version of this script did exactly that with
// `docker stats` (about two seconds a call) and reported it as a two-second read stall.
const psqlAsync = async (query) => (await composeAsync(['exec', '-T', 'postgres', 'psql', '-U', 'opspilot', '-d', 'opspilot', '-At', '-c', query])).stdout.trim();
const redisAsync = async (...args) => (await composeAsync(['exec', '-T', 'redis', 'redis-cli', ...args])).stdout.trim();
const psql = (query) => compose(['exec', '-T', 'postgres', 'psql', '-U', 'opspilot', '-d', 'opspilot', '-At', '-c', query], { capture: true }).stdout.trim();
const redis = (...args) => compose(['exec', '-T', 'redis', 'redis-cli', ...args], { capture: true }).stdout.trim();

/** Samples what the database and the containers are doing while a phase runs. */
function monitor() {
  const seen = { connections: 0, active: 0, cpu: {}, memory: {} };
  let running = true;
  const loop = (async () => {
    while (running) {
      const [total, active] = (await psqlAsync(`SELECT count(*), count(*) FILTER (WHERE state = 'active') FROM pg_stat_activity WHERE datname = 'opspilot'`)).split('|').map(Number);
      seen.connections = Math.max(seen.connections, total || 0);
      seen.active = Math.max(seen.active, active || 0);
      const stats = (await run('docker', ['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'])).stdout;
      for (const line of stats.split('\n')) {
        const [name, cpu, mem] = line.split('\t');
        if (!name?.startsWith(`${PROJECT}-`)) continue;
        const service = name.replace(`${PROJECT}-`, '').replace(/-\d+$/, '');
        seen.cpu[service] = Math.max(seen.cpu[service] ?? 0, parseFloat(cpu));
        const mib = parseFloat(mem) * (/GiB/.test(mem.split('/')[0]) ? 1024 : 1);
        seen.memory[service] = Math.max(seen.memory[service] ?? 0, Math.round(mib));
      }
      await pause(1500);
    }
  })();
  return async () => {
    running = false;
    await loop;
    return seen;
  };
}

// ── Run ──
if (!compose(['ps', '--status', 'running', '-q'], { capture: true }).stdout.trim()) {
  console.error('The isolated stack is not running. Start it with: npm run isolated:up');
  process.exit(2);
}
const login = await call('POST', '/auth/login', DEMO);
if (login.status !== 200) {
  console.error(`sign-in failed (${login.status})`);
  process.exit(2);
}
const services = (await call('GET', '/services?pageSize=50')).data.data.map((s) => s.slug);
const incident = (await call('GET', '/incidents?pageSize=1')).data.data[0];
const key = (await call('POST', '/api-keys', { name: `load test ${Date.now()}`, scopes: ['ingest:logs', 'ingest:metrics'] })).data.secret;
const withKey = { 'x-api-key': key };
const count = (table) => Number(psql(`SELECT count(*) FROM "${table}"`));
const report = { environment: {}, workload: W, results: {} };

const dockerInfo = spawnSync('docker', ['info', '--format', '{{.NCPU}}\t{{.MemTotal}}\t{{.ServerVersion}}\t{{.OperatingSystem}}'], { encoding: 'utf8' }).stdout.trim().split('\t');
report.environment = {
  host: `${os.cpus()[0]?.model ?? 'unknown CPU'}, ${os.cpus().length} logical cores, ${Math.round(os.totalmem() / 1024 ** 3)} GB RAM, ${os.type()} ${os.release()}`,
  docker: `${dockerInfo[3]} ${dockerInfo[2]}: ${dockerInfo[0]} CPUs and ${(Number(dockerInfo[1]) / 1024 ** 3).toFixed(1)} GB available to containers`,
  node: process.version,
  postgres: psql('SHOW server_version'),
  postgresMaxConnections: Number(psql('SHOW max_connections')),
  redis: redis('info', 'server').match(/redis_version:(\S+)/)?.[1],
  note: 'One API process, one worker process, one AI service process, rule-based engine. The load generator ran on the same machine. Another copy of the application was running on the host at the time.',
};

log('Load test on the isolated stack\n');

// 1. Logs
{
  const before = count('LogEntry');
  const stop = monitor();
  const lines = (c, i) => Array.from({ length: W.logs.linesPerRequest }, (_, n) => ({ level: n % 10 === 0 ? 'error' : 'info', message: `load test request ${c}-${i} line ${n} for order ${1000 + n}`, timestamp: new Date(Date.now() - n * 100).toISOString() }));
  const r = await concurrently(W.logs.clients, W.logs.requestsEach, (c, i) => call('POST', '/logs', { service: services[c % services.length], logs: lines(c, i) }, withKey));
  const stored = count('LogEntry') - before;
  report.results.logs = { ...r, samples: undefined, linesSent: W.logs.clients * W.logs.requestsEach * W.logs.linesPerRequest, linesStored: stored, linesPerSecond: Math.round(stored / r.seconds), observed: await stop() };
  log(`Logs: ${r.requests} requests of ${W.logs.linesPerRequest} lines from ${W.logs.clients} clients in ${r.seconds.toFixed(1)}s → ${stored.toLocaleString('en-GB')} lines stored (${report.results.logs.linesPerSecond.toLocaleString('en-GB')}/s); request p50 ${r.p50} ms, p95 ${r.p95} ms, max ${r.max} ms; statuses ${JSON.stringify(r.statuses)}`);
}
await pause(BETWEEN_PHASES_MS);

// 2. Metrics
{
  const before = count('MetricSample');
  const stop = monitor();
  const samples = (c) => Array.from({ length: W.metrics.samplesPerRequest }, (_, n) => ({ service: services[(c + n) % services.length], metric: ['error_rate', 'latency_p95_ms', 'requests_per_min', 'cpu_percent'][n % 4], value: Math.round(Math.random() * 1000) / 10 }));
  const r = await concurrently(W.metrics.clients, W.metrics.requestsEach, (c) => call('POST', '/monitoring/metrics', { samples: samples(c) }, withKey));
  const stored = count('MetricSample') - before;
  report.results.metrics = { ...r, samples: undefined, samplesSent: W.metrics.clients * W.metrics.requestsEach * W.metrics.samplesPerRequest, samplesStored: stored, samplesPerSecond: Math.round(stored / r.seconds), observed: await stop() };
  log(`Metrics: ${r.requests} requests of ${W.metrics.samplesPerRequest} samples in ${r.seconds.toFixed(1)}s → ${stored.toLocaleString('en-GB')} samples stored (${report.results.metrics.samplesPerSecond.toLocaleString('en-GB')}/s); p50 ${r.p50} ms, p95 ${r.p95} ms, max ${r.max} ms; statuses ${JSON.stringify(r.statuses)}`);
}
await pause(BETWEEN_PHASES_MS);

// 3. Duplicate requests under one idempotency key, all copies at once
{
  const before = count('LogEntry');
  const stop = monitor();
  const began = performance.now();
  const stamp = Date.now().toString(36);
  const all = (await Promise.all(Array.from({ length: W.duplicates.keys }, (_, k) => {
    const body = { service: services[k % services.length], logs: Array.from({ length: W.duplicates.linesPerRequest }, (_, n) => ({ level: 'info', message: `duplicate test batch ${k} line ${n}` })) };
    return Promise.all(Array.from({ length: W.duplicates.copiesEach }, () => call('POST', '/logs', body, { ...withKey, 'idempotency-key': `loadtest-${stamp}-${k}` })));
  }))).flat();
  const stored = count('LogEntry') - before;
  const s = summarise(all);
  report.results.duplicates = { ...s, seconds: (performance.now() - began) / 1000, replayed: all.filter((x) => x.replayed).length, linesExpected: W.duplicates.keys * W.duplicates.linesPerRequest, linesStored: stored, observed: await stop() };
  log(`Duplicates: ${all.length} requests at once (${W.duplicates.keys} batches × ${W.duplicates.copiesEach} copies) → ${stored.toLocaleString('en-GB')} lines stored, ${report.results.duplicates.linesExpected.toLocaleString('en-GB')} expected; ${report.results.duplicates.replayed} answered as replays; p50 ${s.p50} ms, p95 ${s.p95} ms, max ${s.max} ms; statuses ${JSON.stringify(s.statuses)}`);
}
await pause(BETWEEN_PHASES_MS);

// 4. Reads while data is being written
{
  const stop = monitor();
  const writing = concurrently(4, 10, (c, i) => call('POST', '/logs', { service: services[c % services.length], logs: Array.from({ length: 300 }, (_, n) => ({ level: 'info', message: `background write ${c}-${i}-${n}` })) }, withKey));
  const paths = ['/incidents?pageSize=20', '/logs?from=1h&pageSize=50', '/logs?from=1h&q=order', '/logs/patterns?from=1h', '/integrations', '/dashboard', `/incidents/${incident.id}`];
  const byPath = {};
  const r = await concurrently(W.reads.clients, W.reads.requestsEach, async (c, i) => {
    const path = paths[(c + i) % paths.length];
    const res = await call('GET', path);
    (byPath[path.split('?')[0].replace(incident.id, ':id') + (path.includes('q=') ? ' (text search)' : '')] ??= []).push(res);
    return res;
  });
  await writing;
  report.results.reads = { ...r, samples: undefined, byPath: Object.fromEntries(Object.entries(byPath).map(([p, s]) => [p, summarise(s)])), observed: await stop() };
  log(`Reads during writes: ${r.requests} requests from ${W.reads.clients} clients; p50 ${r.p50} ms, p95 ${r.p95} ms, p99 ${r.p99} ms, max ${r.max} ms; statuses ${JSON.stringify(r.statuses)}`);
  for (const [p, s] of Object.entries(report.results.reads.byPath)) log(`  ${p.padEnd(34)} p50 ${String(s.p50).padStart(5)} ms   p95 ${String(s.p95).padStart(5)} ms   max ${String(s.max).padStart(5)} ms`);
}
await pause(BETWEEN_PHASES_MS);

// 5. Investigations: as many at once as an organisation is allowed, until the total is done
{
  const stop = monitor();
  const began = performance.now();
  const durations = [];
  let refusedAtLimit = 0;
  let queueMax = 0;
  const outcomes = {};
  let next = 0;
  const runOne = async () => {
    while (next < W.investigations.total) {
      const n = next++;
      let started = await call('POST', '/investigations', { question: `Load test ${n}: what is wrong with this service?`, incidentId: incident.id });
      while (started.status === 429) {
        refusedAtLimit++;
        await pause(500);
        started = await call('POST', '/investigations', { question: `Load test ${n}: what is wrong with this service?`, incidentId: incident.id });
      }
      if (started.status !== 202) {
        outcomes[`refused ${started.status}`] = (outcomes[`refused ${started.status}`] ?? 0) + 1;
        continue;
      }
      const t0 = performance.now();
      let inv;
      do {
        await pause(400);
        inv = (await call('GET', `/investigations/${started.data.id}`)).data;
        const waiting = Number(await redisAsync('llen', 'bull:investigation:wait')) || 0;
        queueMax = Math.max(queueMax, waiting);
      } while (inv.status === 'QUEUED' || inv.status === 'RUNNING');
      durations.push(performance.now() - t0);
      outcomes[inv.status] = (outcomes[inv.status] ?? 0) + 1;
    }
  };
  // One more submitter than the limit, so the limit itself is exercised.
  await Promise.all(Array.from({ length: W.investigations.atOnce + 1 }, runOne));
  const seconds = (performance.now() - began) / 1000;
  const sorted = durations.sort((a, b) => a - b);
  report.results.investigations = { total: W.investigations.total, outcomes, seconds, perMinute: Math.round((durations.length / seconds) * 60), p50: Math.round(quantile(sorted, 0.5)), p95: Math.round(quantile(sorted, 0.95)), max: Math.round(sorted.at(-1)), refusedAtLimit, queueMax, observed: await stop() };
  log(`Investigations: ${durations.length} of ${W.investigations.total} finished in ${seconds.toFixed(1)}s (${report.results.investigations.perMinute}/min); each took p50 ${(report.results.investigations.p50 / 1000).toFixed(1)}s, p95 ${(report.results.investigations.p95 / 1000).toFixed(1)}s, max ${(report.results.investigations.max / 1000).toFixed(1)}s; outcomes ${JSON.stringify(outcomes)}; refused at the concurrency limit ${refusedAtLimit} times; most waiting in the queue ${queueMax}`);
}

// 6. After the run
const failed = Number(redis('zcard', 'bull:investigation:failed')) || 0;
report.results.after = {
  redisMemory: redis('info', 'memory').match(/used_memory_human:(\S+)/)?.[1],
  failedInvestigationJobs: failed,
  databaseSize: psql(`SELECT pg_size_pretty(pg_database_size('opspilot'))`),
  ready: (await fetch(`${URLS.api}/ready`).then((r) => r.status, () => 0)) === 200,
};
const peak = (name) => Math.max(...Object.values(report.results).map((r) => r.observed?.[name] ?? 0));
report.results.peaks = {
  databaseConnections: peak('connections'),
  databaseActive: peak('active'),
  cpuPercent: Object.fromEntries(['api', 'worker', 'postgres', 'redis', 'ai'].map((s) => [s, Math.max(...Object.values(report.results).map((r) => r.observed?.cpu?.[s] ?? 0))])),
  memoryMiB: Object.fromEntries(['api', 'worker', 'postgres', 'redis', 'ai'].map((s) => [s, Math.max(...Object.values(report.results).map((r) => r.observed?.memory?.[s] ?? 0))])),
};
log(`\nPeaks: ${report.results.peaks.databaseConnections} database connections (${report.results.peaks.databaseActive} active) of ${report.environment.postgresMaxConnections} allowed`);
log(`  CPU %  ${JSON.stringify(report.results.peaks.cpuPercent)}`);
log(`  MiB    ${JSON.stringify(report.results.peaks.memoryMiB)}`);
log(`After: database ${report.results.after.databaseSize}, Redis ${report.results.after.redisMemory}, failed investigation jobs ${failed}, API ready ${report.results.after.ready}`);
log(`\nEnvironment: ${report.environment.host}\n  ${report.environment.docker}\n  PostgreSQL ${report.environment.postgres}, Redis ${report.environment.redis}, Node ${report.environment.node}\n  ${report.environment.note}`);
if (process.argv.includes('--json')) log(`\n${JSON.stringify(report, null, 2)}`);
const errors = Object.values(report.results).flatMap((r) => Object.entries(r.statuses ?? {}).filter(([s]) => Number(s) === 0 || Number(s) >= 500));
process.exit(errors.length || !report.results.after.ready ? 1 : 0);
