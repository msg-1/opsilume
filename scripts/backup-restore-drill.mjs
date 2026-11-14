#!/usr/bin/env node
// Backup and restore, exercised end to end on the isolated stack (scripts/isolated-stack.mjs).
//
//   npm run isolated:up && npm run drill:backup
//
// What it does, in order:
//   1. creates some state through the API (ingested telemetry, an investigation, a remediation
//      action submitted for approval), so the backup holds more than the seed;
//   2. takes a backup of the isolated database with pg_dump (custom format);
//   3. restores it into a SECOND database, opspilot_restore, next to the first;
//   4. compares the two: every table's row count, every foreign key, the indexes, the
//      extensions and the migration history;
//   5. starts a second API and worker against the restored database, signs in, reads the
//      data created in step 1 and runs a new investigation to a stored report;
//   6. removes the second API, worker and database again.
//
// It never touches the default Compose project or its database, and never restores over a
// database that is in use. It does not test point-in-time recovery: there is none.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT, URLS, compose } from './isolated-stack.mjs';

if (PROJECT === 'opspilot') throw new Error('Refusing to run against the default Compose project.');

const SOURCE = 'opspilot';
const RESTORED = 'opspilot_restore';
const RESTORED_API_PORT = 14100;
const DEMO = { email: 'demo@example.com', password: 'OpsPilot-demo-1' };
const log = (line = '') => console.log(line);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const dc = (args, { input, allowFail = false } = {}) => {
  const res = compose(args, { capture: true });
  if (res.status !== 0 && !allowFail) throw new Error(`docker compose ${args.slice(0, 6).join(' ')} failed: ${res.stderr.trim().split('\n').slice(-2).join(' ')}`);
  void input;
  return res.stdout.trim();
};
/** SQL against one database of the isolated PostgreSQL. Returns rows as arrays of strings. */
const sql = (database, query) =>
  dc(['exec', '-T', 'postgres', 'psql', '-U', 'opspilot', '-d', database, '-AtF', '\t', '-v', 'ON_ERROR_STOP=1', '-c', query])
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));

class Session {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }
  async request(method, path, body) {
    const headers = { 'content-type': 'application/json', origin: URLS.web, connection: 'close' };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${this.base}/api/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) }).catch((err) => ({ status: 0, headers: new Headers(), text: async () => JSON.stringify({ error: { message: err.message } }) }));
    for (const cookie of res.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(';');
      const i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    try {
      return { status: res.status, data: JSON.parse(text) };
    } catch {
      return { status: res.status, data: {} };
    }
  }
  get = (path) => this.request('GET', path);
  post = (path, body) => this.request('POST', path, body ?? {});
  async login() {
    const res = await this.post('/auth/login', DEMO);
    assert(res.status === 200, `sign-in failed at ${this.base} (${res.status})`);
  }
}

async function until(read, done, what, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await pause(500);
  }
}
const completed = async (session, id) => until(async () => (await session.get(`/investigations/${id}`)).data, (i) => i.status && !['QUEUED', 'RUNNING'].includes(i.status), 'the investigation to end');

/** Everything about a database that a restore must reproduce. */
function fingerprint(database) {
  const tables = sql(database, `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`).map(([t]) => t);
  const counts = Object.fromEntries(tables.map((t) => [t, Number(sql(database, `SELECT count(*) FROM "${t}"`)[0][0])]));
  const indexes = sql(database, `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`).map(([i]) => i);
  const extensions = sql(database, `SELECT extname FROM pg_extension ORDER BY 1`).map(([e]) => e);
  const migrations = sql(database, `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY 1`).map(([m]) => m);
  const foreignKeys = sql(
    database,
    `SELECT c.conname, c.conrelid::regclass::text, a.attname, c.confrelid::regclass::text, af.attname
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = c.confkey[1]
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace AND array_length(c.conkey, 1) = 1 ORDER BY 1`,
  );
  // A row whose parent is missing: a relationship the restore broke. Counted per foreign key.
  const orphans = foreignKeys
    .map(([name, child, column, parent, parentColumn]) => [name, Number(sql(database, `SELECT count(*) FROM ${child} c WHERE c."${column}" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${parent} p WHERE p."${parentColumn}" = c."${column}")`)[0][0])])
    .filter(([, n]) => n > 0);
  // Content, not only quantity: a digest over the columns that matter of a few central tables.
  const digest = (query) => sql(database, `SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) FROM (${query}) q(x)`)[0][0];
  const content = {
    incidents: digest(`SELECT id || title || status::text || severity::text FROM "Incident"`),
    investigations: digest(`SELECT id || status::text || coalesce(outcome::text, '') || coalesce(md5(report::text), '') FROM "Investigation"`),
    evidence: digest(`SELECT id || ref || kind || title FROM "Evidence"`),
    approvals: digest(`SELECT a.id || a.decision || coalesce(a."contentHash", '') FROM "Approval" a`),
    remediations: digest(`SELECT id || status::text || risk::text || coalesce("contentHash", '') FROM "RemediationAction"`),
    users: digest(`SELECT id || email || "passwordHash" FROM "User"`),
    embeddings: digest(`SELECT id || md5(embedding::text) FROM "KnowledgeChunk" WHERE embedding IS NOT NULL`),
  };
  return { tables: tables.length, counts, indexes, extensions, migrations, foreignKeys: foreignKeys.length, orphans, content };
}

function cleanup() {
  for (const name of ['opspilot-restored-api', 'opspilot-restored-worker']) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  dc(['exec', '-T', 'postgres', 'psql', '-U', 'opspilot', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${RESTORED} WITH (FORCE)`], { allowFail: true });
}

const results = [];
const step = async (title, run) => {
  const began = Date.now();
  const detail = await run();
  results.push({ title, detail, ms: Date.now() - began });
  log(`  ✓ ${title} (${((Date.now() - began) / 1000).toFixed(1)}s)${detail ? `: ${detail}` : ''}`);
};

try {
  assert(compose(['ps', '--status', 'running', '-q'], { capture: true }).stdout.trim(), 'The isolated stack is not running. Start it with: npm run isolated:up');
  cleanup();
  const live = new Session(URLS.api);
  await live.login();
  let marker;

  await step('Create state worth backing up', async () => {
    const stamp = Date.now().toString(36);
    const incident = (await live.get('/incidents?pageSize=1')).data.data[0];
    const key = (await live.post('/api-keys', { name: `backup drill ${stamp}`, scopes: ['ingest:logs'] })).data;
    const service = (await live.get('/services?pageSize=1')).data.data[0];
    const ingest = await fetch(`${URLS.api}/api/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key.secret, 'idempotency-key': `backup-drill-${stamp}` }, body: JSON.stringify({ service: service.slug, logs: [{ level: 'error', message: `backup drill marker ${stamp}` }] }) });
    assert(ingest.status === 202, `ingestion failed (${ingest.status})`);
    const started = await live.post('/investigations', { question: `Backup drill ${stamp}: what is wrong with this service?`, incidentId: incident.id });
    assert(started.status === 202, `could not start an investigation (${started.status})`);
    const investigation = await completed(live, started.data.id);
    assert(investigation.status === 'COMPLETED', `the investigation ended ${investigation.status}`);
    const action = (await live.post('/remediations', { type: 'restart_service', title: `Restart for backup drill ${stamp}`, description: 'Rolling restart of the service.', risk: 'MEDIUM', incidentId: incident.id })).data;
    await live.post(`/remediations/${action.id}/request-approval`);
    marker = { stamp, investigationId: investigation.id, evidence: investigation.evidence.length, summary: investigation.summary, actionId: action.id, keyPrefix: key.prefix, keySecret: key.secret, serviceSlug: service.slug };
    return `1 log line, 1 investigation (${investigation.evidence.length} evidence items), 1 action awaiting approval, 1 API key`;
  });

  let before;
  const dir = mkdtempSync(join(tmpdir(), 'opspilot-backup-'));
  const file = join(dir, 'opspilot.dump');
  await step('Back up with pg_dump (custom format)', async () => {
    // Quiet the writers that would change counts between the dump and the comparison.
    dc(['stop', 'worker']);
    before = fingerprint(SOURCE);
    dc(['exec', '-T', 'postgres', 'sh', '-c', `pg_dump -U opspilot -d ${SOURCE} --format=custom --file=/tmp/opspilot.dump`]);
    const id = dc(['ps', '-q', 'postgres']);
    const copy = spawnSync('docker', ['cp', `${id}:/tmp/opspilot.dump`, file], { encoding: 'utf8' });
    assert(copy.status === 0, `could not copy the backup out of the container: ${copy.stderr}`);
    dc(['start', 'worker']);
    return `${(statSync(file).size / 1024 / 1024).toFixed(1)} MB, ${before.tables} tables, ${Object.values(before.counts).reduce((a, b) => a + b, 0).toLocaleString('en-GB')} rows`;
  });

  await step('Restore into a separate database', async () => {
    const id = dc(['ps', '-q', 'postgres']);
    assert(spawnSync('docker', ['cp', file, `${id}:/tmp/restore.dump`]).status === 0, 'could not copy the backup into the container');
    dc(['exec', '-T', 'postgres', 'psql', '-U', 'opspilot', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${RESTORED}`]);
    dc(['exec', '-T', 'postgres', 'sh', '-c', `pg_restore -U opspilot -d ${RESTORED} --no-owner --exit-on-error /tmp/restore.dump`]);
    return `database ${RESTORED}; the source database was not touched`;
  });

  await step('Compare the restored database with the source', async () => {
    const after = fingerprint(RESTORED);
    const different = Object.keys(before.counts).filter((t) => before.counts[t] !== after.counts[t]);
    assert(after.tables === before.tables, `tables: ${before.tables} before, ${after.tables} after`);
    assert(!different.length, `row counts differ in: ${different.map((t) => `${t} (${before.counts[t]} → ${after.counts[t]})`).join(', ')}`);
    assert(JSON.stringify(after.indexes) === JSON.stringify(before.indexes), `indexes differ: missing ${before.indexes.filter((i) => !after.indexes.includes(i)).join(', ') || 'none'}`);
    assert(after.indexes.includes('KnowledgeChunk_embedding_hnsw_idx'), 'the vector index is missing from the restored database');
    assert(JSON.stringify(after.extensions) === JSON.stringify(before.extensions), `extensions differ: ${before.extensions} / ${after.extensions}`);
    assert(JSON.stringify(after.migrations) === JSON.stringify(before.migrations), 'the migration history differs');
    assert(after.foreignKeys === before.foreignKeys, `foreign keys: ${before.foreignKeys} before, ${after.foreignKeys} after`);
    assert(!after.orphans.length, `rows without their parent after restore: ${JSON.stringify(after.orphans)}`);
    const changed = Object.keys(before.content).filter((k) => before.content[k] !== after.content[k]);
    assert(!changed.length, `content differs in: ${changed.join(', ')}`);
    return `${after.tables} tables with identical row counts, ${after.indexes.length} indexes (vector index included), ${after.extensions.length} extensions, ${after.migrations.length} migrations, ${after.foreignKeys} foreign keys with no orphaned row, content digests of 7 tables identical`;
  });

  await step('Run the application against the restored copy', async () => {
    const url = `postgresql://opspilot:opspilot@postgres:5432/${RESTORED}?schema=public`;
    // Its own queue prefix, so the two installations share Redis without sharing work.
    const env = ['-e', `DATABASE_URL=${url}`, '-e', 'QUEUE_PREFIX=restored', '-e', 'API_URL=http://opspilot-restored-api:4000', '-e', 'SEED_DEMO_DATA=false'];
    dc(['run', '-d', '--no-deps', '--name', 'opspilot-restored-api', '-p', `127.0.0.1:${RESTORED_API_PORT}:4000`, ...env, 'api']);
    dc(['run', '-d', '--no-deps', '--name', 'opspilot-restored-worker', ...env, 'worker']);
    const base = `http://localhost:${RESTORED_API_PORT}`;
    await until(() => fetch(`${base}/ready`).then((r) => r.status, () => 0), (s) => s === 200, 'the restored API to be ready');
    const restored = new Session(base);
    await restored.login(); // the same accounts, the same password hashes
    const inv = (await restored.get(`/investigations/${marker.investigationId}`)).data;
    assert(inv.status === 'COMPLETED' && inv.summary === marker.summary && inv.evidence.length === marker.evidence, 'the investigation created before the backup is not the same in the restored copy');
    const action = (await restored.get(`/remediations/${marker.actionId}`)).data;
    assert(action.status === 'PENDING_APPROVAL' && action.currentHash, 'the action awaiting approval is not the same in the restored copy');
    const logs = (await restored.get(`/logs?q=${encodeURIComponent(`backup drill marker ${marker.stamp}`)}&from=1h`)).data;
    assert(logs.data?.length === 1, 'the log line ingested before the backup is not in the restored copy');
    // Credentials survive as they were stored: the API key (a hash) still authenticates, and its
    // idempotency key is still remembered, so a client retrying across a restore does not duplicate.
    const again = await fetch(`${base}/api/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': marker.keySecret, 'idempotency-key': `backup-drill-${marker.stamp}` }, body: JSON.stringify({ service: marker.serviceSlug, logs: [{ level: 'error', message: `backup drill marker ${marker.stamp}` }] }) });
    assert(again.status === 202 && again.headers.get('idempotent-replayed') === 'true', `the retried ingestion was not recognised in the restored copy (${again.status})`);
    // And it does new work: an investigation through the restored API, worker and database.
    const incident = (await restored.get('/incidents?pageSize=1')).data.data[0];
    const started = await restored.post('/investigations', { question: 'After the restore: what is wrong with this service?', incidentId: incident.id });
    assert(started.status === 202, `the restored copy refused a new investigation (${started.status})`);
    const fresh = await completed(restored, started.data.id);
    assert(fresh.status === 'COMPLETED' && fresh.report?.summary && fresh.evidence.length > 0, `the new investigation on the restored copy ended ${fresh.status}: ${fresh.error}`);
    // The live installation knows nothing of it: the two databases are separate.
    assert((await live.get(`/investigations/${started.data.id}`)).status === 404, 'work done on the restored copy appeared in the source database');
    return `signed in with the existing accounts; the earlier investigation, action, log line, API key and idempotency key are intact; a new investigation completed (${fresh.evidence.length} evidence items) and is absent from the source database`;
  });
} catch (err) {
  log(`  ✗ ${err.message}`);
  process.exitCode = 1;
} finally {
  cleanup();
  compose(['start', 'worker'], { capture: true });
}

log(process.exitCode ? '\nBackup and restore drill FAILED.' : `\nBackup and restore drill passed (${results.length} steps, ${(results.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(0)}s).`);
