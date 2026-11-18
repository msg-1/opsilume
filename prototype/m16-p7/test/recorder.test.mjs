// Deterministic tests of the P7 recorder protocol and state machine (in-process server, temporary directories).
// HARNESS tests only: they say nothing about durability. Run: node --test prototype/m16-p7/test/
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { keyFromHex, makeClient, nextStream, runTag, signRequest, verifyRequest, WINDOW_MS } from '../lib/protocol.mjs';
import { finalStatus, physicalStreak } from '../lib/verdict.mjs';
import { abandonRun, compareBackup, createRecorder, identityRefusal, packageProblems, createRun, cutRefusal, cycleView, dirReport, dirState, recorderBindingOf, recorderId, registerVolume, registryProblem, runStore, volumeOf, volumeOwner } from '../recorder.mjs';
import { bindingDiff, digestOf, testBinding, vetTestBinding } from '../lib/readiness.mjs';
import { SOURCE_SETS, runtimeFingerprint, sourceDigest, sourceDigestOfFiles } from '../lib/source.mjs';
import { readPackage } from '../lib/package.mjs';
import { tarGz } from './helpers/tar.mjs';
import { appendDurable, readLedger } from '../lib/ledger.mjs';
import { LOCK_FILE, withDirLock } from '../lib/lock.mjs';
import { REQUIRED_ATTESTATIONS } from '../lib/preflight.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-recorder-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const STORAGE = { driveModel: 'Example SSD 1TB', firmware: '1B2QEXM7', controller: 'NVMe (PCIe)', dbDevice: 'nvme0n1p2', journalDevice: 'nvme0n1p2', filesystem: 'ext4 rw,relatime', vendorDoc: 'vendor datasheet rev 3, section 4.2', evidenceFiles: 'host/baseline/*', writeCache: 'write back', fua: 'yes', flushSupported: 'yes', flushesObserved: 'yes', vendorFlushSemantics: 'yes', plp: 'unknown' };
const FS = { installationId: 'inst-1', head: 9, headHash: 'ab'.repeat(32) };
/** A run whose volumes were initialised (what `p7.mjs init` reports after creating the schema on an empty database). */
const pg = (run) => String(7000000000000000000n + BigInt(`0x${createHash('sha256').update(run).digest('hex').slice(0, 12)}`)); // a system identifier per test run
/** What the operator declares at create-run about the source package and the image built on the test machine. */
/** The harness source as the recorder itself sees it: a test machine running the same code reports the same digest. */
const PROTO = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE = sourceDigest(PROTO);
/** The files of that source as a source package holds them (paths from the repository root). */
const sourceEntries = () => SOURCE_SETS.flatMap(([d, pattern]) => fs.readdirSync(path.join(PROTO, d)).filter((n) => pattern.test(n) && fs.statSync(path.join(PROTO, d, n)).isFile()).sort().map((n) => [`prototype/${d}/${n}`, fs.readFileSync(path.join(PROTO, d, n))]));
const COMMIT = 'c0'.repeat(20);
const writePackage = (name, entries, opts = { commit: COMMIT }) => { const f = path.join(PKG_DIR, name); fs.writeFileSync(f, tarGz(entries, opts)); return f; };
const PKG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-package-'));
/** A source package of exactly this source, as `git archive` would make it from commit COMMIT. */
const PACKAGE = writePackage('opspilot-p7-test.tar.gz', sourceEntries());
const IDENTITY = { sourceCommit: COMMIT, packageSha256: createHash('sha256').update(fs.readFileSync(PACKAGE)).digest('hex'), imageId: `sha256:${'e2'.repeat(32)}`, imageArch: 'amd64' };
const IDENTITY_FLAGS = ['--source-commit', IDENTITY.sourceCommit, '--package-sha256', IDENTITY.packageSha256, '--image-id', IDENTITY.imageId, '--image-arch', IDENTITY.imageArch, '--package', PACKAGE];
const FP = 'f1'.repeat(32);
const RT = (arch = 'x64', node = 'v22.0.0', fingerprint = FP) => ({ arch, node, fingerprint });
/** What the test machine reports for a ready configuration (p7.mjs gathers these facts read-only). */
const FACTS = (pgSystemId, workers = 1, over = {}) => ({
  pgSystemId, journal: { markerSha256: 'aa'.repeat(32), installationId: 'inst-1' },
  settings: { fsync: 'on', full_page_writes: 'on', synchronous_commit: 'on', wal_sync_method: 'fdatasync', data_checksums: 'off', server_version: '16.14' },
  netcheck: { strict: true, ok: true, bridges: ['172.22.0.1', '172.23.0.1'], probes: [{ name: 'host or bridge 172.22.0.1:22' }, { name: 'host or bridge 172.23.0.1:22' }] },
  // Decision B1's shape: one process, a burst pattern (10 s at 100/s in every 60 s, 20/s otherwise: 40,000 actions with headroom 2).
  workload: { procs: 1, workers, cycles: 20, maxSeconds: 600, headroom: 2, ratePerWorker: 100, targetRate: null, poolPerWorker: 40000, burstPeriodSeconds: 60, burstSeconds: 10, quietRate: 20 },
  source: SOURCE, runtime: RT('x64', 'v22.0.0'), ...over,
});
const TB = (pgSystemId, workers, over) => testBinding(FACTS(pgSystemId, workers, over));
/** Writes the readiness record a successful preflight leaves in the run's ledger (the endpoint itself has its own tests). */
const makeReady = (dir, run, workers = 1, pgSystemId = pg(run)) => {
  const binding = { test: TB(pgSystemId, workers), recorder: recorderBindingOf(dir, run) };
  runStore(dir, run).event({ cycle: null, kind: 'readiness', binding, digest: digestOf(binding) });
};
const mk = (dir, o) => {
  const r = createRun(dir, o);
  registerVolume(dir, { pgSystemId: pg(o.run), run: o.run, failureModel: o.failureModel });
  const st = runStore(dir, o.run);
  st.event({ cycle: null, kind: 'initialised', detail: 'test' });
  if (o.failureModel === 'POWER-CUT') { for (const item of REQUIRED_ATTESTATIONS) st.event({ cycle: null, kind: 'attestation', item, evidence: 'test', attestation: 'operator' }); }
  return r;
};
const T = (run, rest) => `${runTag(run)}${rest}`; // action ids carry the run's tag
const sha = (f) => (fs.existsSync(f) ? createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null);
const listFiles = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => fs.statSync(path.join(d, f)).isFile()).sort();

async function serve(dir, opts) {
  const server = createRecorder(dir, opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
const keyOf = (dir, run) => keyFromHex(fs.readFileSync(runStore(dir, run).keyFile, 'utf8'));
/** Signed call that returns { status, data } instead of throwing on a refusal. */
const callerFor = (base, dir, run, key = keyOf(dir, run)) => {
  const c = makeClient({ baseUrl: base, key, run });
  return async (method, p, body) => {
    // A start reports the test machine's current configuration; these tests report the ready one unless they say otherwise.
    // Like the operator, they run "preflight" right before the first cycle of a qualifying run (once it is attested).
    if (/\/start$/.test(p) && body && body.readiness === undefined) {
      const st = runStore(dir, run), ev = st.events();
      if (st.run().failureModel === 'POWER-CUT' && !ev.some((e) => e.kind === 'readiness' || e.kind === 'cycle_start') && REQUIRED_ATTESTATIONS.every((i) => ev.some((e) => e.kind === 'attestation' && e.item === i))) makeReady(dir, run, body.workers, body.pgSystemId);
      body = { ...body, readiness: TB(body.pgSystemId, body.workers) };
    }
    try { const r = await c(method, p, body); return { status: 200, data: r.data }; } catch (e) { return { status: e.status, data: e.data, unauthenticated: e.unauthenticated }; }
  };
};
/** Sends exactly the given headers (to replay or forge a request). */
const rawSend = (base, method, p, headers, body = '') => fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body || undefined }).then(async (r) => ({ status: r.status, data: await r.json() }));

describe('protocol', () => {
  const key = keyFromHex('11'.repeat(32));
  const req = (over = {}) => ({ method: 'POST', path: '/runs/r/ack', run: 'r', body: '{"a":1}', ...over });
  test('a signed request verifies; any change to method, path, run, body or key does not', () => {
    const h = signRequest(key, req());
    assert.equal(verifyRequest(key, { ...req(), headers: h }), null);
    assert.equal(verifyRequest(key, { ...req({ body: '{"a":2}' }), headers: h }), 'bad_mac');
    assert.equal(verifyRequest(key, { ...req({ path: '/runs/r/event' }), headers: h }), 'bad_mac');
    assert.equal(verifyRequest(key, { ...req({ method: 'GET' }), headers: h }), 'bad_mac');
    assert.equal(verifyRequest(keyFromHex('22'.repeat(32)), { ...req(), headers: h }), 'bad_mac');
    assert.equal(verifyRequest(key, { ...req({ run: 'other' }), headers: h }), 'run_mismatch');
  });
  test('stale timestamps and reused nonces are refused', () => {
    const old = signRequest(key, { ...req(), now: Date.now() - WINDOW_MS - 1000 });
    assert.equal(verifyRequest(key, { ...req(), headers: old }), 'stale_timestamp');
    const h = signRequest(key, req());
    assert.equal(verifyRequest(key, { ...req(), headers: h, seen: new Set([h['x-p7-nonce']]) }), 'replayed_nonce');
    assert.equal(verifyRequest(key, { ...req(), headers: {} }), 'malformed_authentication');
  });
  test('the client refuses a response that is not authenticated by the run key', async () => {
    const fake = http.createServer((q, s) => s.writeHead(200, { 'x-p7-time': String(Date.now()), 'x-p7-mac': 'ab'.repeat(32) }).end('{"acks":[]}'));
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const c = makeClient({ baseUrl: `http://127.0.0.1:${fake.address().port}`, key, run: 'r' });
    await assert.rejects(c('GET', '/runs/r/cycles/1'), /not authenticated/);
    await new Promise((r) => fake.close(r));
  });
  test('acknowledgement streams: in order, claim then its dispatch, own actions only', () => {
    const a = (n, kind, seq, actionId = T('r', `c0001aw1-${seq}`)) => ({ proc: 'a', worker: 1, n, kind, seq, actionId });
    let st = nextStream(undefined, a(1, 'claim', 5), 1, 'r').st;
    assert.equal(nextStream(st, a(1, 'claim', 6), 1, 'r').error, 'duplicate_or_replayed');
    assert.equal(nextStream(st, a(3, 'dispatch', 5), 1, 'r').error, 'out_of_order');
    assert.equal(nextStream(st, a(2, 'claim', 6), 1, 'r').error, 'out_of_order', 'a claim before the previous dispatch intent');
    assert.equal(nextStream(st, a(2, 'dispatch', 4), 1, 'r').error, 'mismatched_dispatch');
    st = nextStream(st, a(2, 'dispatch', 5), 1, 'r').st;
    assert.equal(nextStream(st, a(3, 'claim', 5), 1, 'r').error, 'out_of_order', 'claims strictly increase per stream');
    assert.equal(nextStream(st, a(3, 'claim', 9, T('r', 'c0001bw1-9')), 1, 'r').error, 'action_does_not_belong_to_this_stream');
    assert.equal(nextStream(st, a(3, 'claim', 9, T('r', 'c0002aw1-9')), 1, 'r').error, 'action_does_not_belong_to_this_stream');
    assert.ok(nextStream(st, a(3, 'claim', 9), 1, 'r').st);
  });
});

describe('createRun (decision 4)', () => {
  const dir = path.join(tmp, 'create');
  test('a qualifying run with unknown flush or FUA behaviour is refused; a smoke run is not', () => {
    const bad = (run, over, pattern, model = 'POWER-CUT') => assert.throws(() => createRun(dir, { run, failureModel: model, identity: IDENTITY, package: PACKAGE, storage: { ...STORAGE, ...over } }), pattern);
    bad('q1', { vendorFlushSemantics: 'unknown' }, /vendorFlushSemantics/);
    bad('q2', { fua: undefined }, /fua must be/);
    bad('q3', { writeCache: 'unknown' }, /writeCache must be/, 'VM-CRASH');
    bad('q4', { vendorDoc: '' }, /vendorDoc is missing/);
    bad('q4b', { firmware: 'unknown' }, /firmware is missing or unknown/);
    bad('q4c', { controller: undefined }, /controller is missing/);
    bad('q4d', { dbDevice: '', journalDevice: '' }, /dbDevice is missing[\s\S]*journalDevice is missing/);
    // FUA not advertised: only with flushes observed on the actual path. A missing flag alone proves nothing.
    bad('q5', { fua: 'not-advertised', flushesObserved: 'no' }, /no kernel flush requests were observed/);
    bad('q6', { writeCache: 'write through', fua: 'not-advertised', flushesObserved: 'no' }, /write-through drive without FUA and without demonstrable flushes: not approved/);
    bad('q6b', { flushSupported: 'no' }, /does not report flush support/);
    assert.throws(() => createRun(dir, { run: 'q6c', failureModel: 'POWER-CUT' }), /driveModel is missing/, 'no evidence at all');
    assert.equal(createRun(dir, { run: 'q7', failureModel: 'POWER-CUT', identity: IDENTITY, package: PACKAGE, storage: { ...STORAGE, fua: 'not-advertised' } }).run.storage.flushesObserved, 'yes');
    assert.equal(createRun(dir, { run: 'q8', failureModel: 'POWER-CUT', identity: IDENTITY, package: PACKAGE, storage: { ...STORAGE, writeCache: 'write through', flushesObserved: 'no' } }).run.storage.fua, 'yes', 'write through with working FUA');
    assert.ok(createRun(dir, { run: 's1', failureModel: 'HARNESS-SMOKE' }).keyFile);
    assert.ok(!fs.existsSync(runStore(dir, 'q1').root), 'nothing is created for a refused run');
  });
  test('the key is 256 bits, mode 0600, outside the run record, and a run id cannot be reused', () => {
    const { keyFile, run } = createRun(dir, { run: 'p1', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    assert.match(fs.readFileSync(keyFile, 'utf8'), /^[0-9a-f]{64}\n$/);
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(run).includes(fs.readFileSync(keyFile, 'utf8').trim()));
    assert.throws(() => createRun(dir, { run: 'p1', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE }), /already exists/);
  });
});

describe('recorder protocol and state machine', () => {
  const dir = path.join(tmp, 'rec');
  // 'p' is a qualifying run: one process and one worker, as decision B1 requires. Everything about several streams
  // (two processes, three workers) is the same protocol for every run type and is exercised on the smoke run 'pm'.
  let srv, call, callM, cycleId, cycleM;
  const ack = (body) => callM('POST', '/runs/pm/ack', { cycle: 1, cycleId: cycleM, ...body });
  const act = (proc, w, k) => T('pm', `c0001${proc}w${w}-${k}`);
  const actP = (k) => T('p', `c0001aw1-${k}`);
  before(async () => {
    mk(dir, { run: 'p', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    createRun(dir, { run: 'other', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    mk(dir, { run: 'pm', failureModel: 'HARNESS-SMOKE' });
    srv = await serve(dir);
    call = callerFor(srv.base, dir, 'p');
    callM = callerFor(srv.base, dir, 'pm');
  });
  after(() => srv.close());

  test('unauthenticated, wrong-key and wrong-run requests are refused and logged without secrets', async () => {
    assert.equal((await rawSend(srv.base, 'GET', '/runs/p', {})).status, 401);
    assert.equal((await callerFor(srv.base, dir, 'p', keyOf(dir, 'other'))('GET', '/runs/p')).status, 401);
    const h = signRequest(keyOf(dir, 'p'), { method: 'GET', path: '/runs/other', run: 'p' });
    assert.equal((await rawSend(srv.base, 'GET', '/runs/other', h)).status, 401, 'run in the header differs from the path');
    const log = fs.readFileSync(path.join(runStore(dir, 'p').root, 'rejections.jsonl'), 'utf8');
    assert.ok(!log.includes(fs.readFileSync(runStore(dir, 'p').keyFile, 'utf8').trim()) && !log.includes('x-p7-mac'));
    assert.ok(runStore(dir, 'p').rejections().every((r) => r.authenticated === false));
  });

  test('cycle ids: one per cycle, shared by processes; a process cannot start twice; cycles are consecutive', async () => {
    assert.equal((await call('POST', '/runs/p/cycles/2/start', { pgSystemId: pg('p'), proc: 'a', workers: 1, dbHead: 0 })).status, 409);
    const a = await call('POST', '/runs/p/cycles/1/start', { pgSystemId: pg('p'), proc: 'a', workers: 1, dbHead: 0, bootId: 'boot-1' });
    assert.match(a.data.cycleId, /^[0-9a-f]{32}$/);
    cycleId = a.data.cycleId;
    assert.equal((await call('POST', '/runs/p/cycles/1/start', { pgSystemId: pg('p'), proc: 'a', workers: 1, dbHead: 0 })).data.error, 'process_already_started_in_cycle');
    // A qualifying run has one process and one worker: a second process, or more workers, never starts.
    assert.equal((await call('POST', '/runs/p/cycles/1/start', { pgSystemId: pg('p'), proc: 'b', workers: 1, dbHead: 3 })).data.error, 'start_differs_from_ready_workload');
    assert.equal((await call('POST', '/runs/p/cycles/1/start', { pgSystemId: pg('p'), proc: 'a', workers: 2, dbHead: 0 })).data.error, 'readiness_stale: test.workload.workers');
    // Other run types may: both processes of a smoke cycle share its one cycle id.
    cycleM = (await callM('POST', '/runs/pm/cycles/1/start', { pgSystemId: pg('pm'), proc: 'a', workers: 2, dbHead: 0 })).data.cycleId;
    assert.match(cycleM, /^[0-9a-f]{32}$/);
    assert.equal((await callM('POST', '/runs/pm/cycles/1/start', { pgSystemId: pg('pm'), proc: 'b', workers: 2, dbHead: 3 })).data.cycleId, cycleM);
  });

  test('two processes and three workers acknowledging concurrently: all accepted, each stream in order', async () => {
    // Sequence numbers as the database lock would hand them out, interleaved across streams.
    const plan = [['a', 1, 1, 4], ['a', 2, 2, 5], ['b', 1, 3, 6]];
    const streams = plan.map(([proc, w, s1, s2]) => async () => {
      let n = 0;
      for (const seq of [s1, s2]) {
        assert.equal((await ack({ proc, worker: w, n: ++n, kind: 'claim', seq, actionId: act(proc, w, seq) })).status, 200);
        assert.equal((await ack({ proc, worker: w, n: ++n, kind: 'dispatch', seq, actionId: act(proc, w, seq) })).status, 200);
      }
    });
    await Promise.all(streams.map((f) => f()));
    const acks = runStore(dir, 'pm').acks(1);
    assert.equal(acks.length, 12);
    for (const [proc, w] of plan) assert.deepEqual(acks.filter((x) => x.proc === proc && x.worker === w).map((x) => x.n), [1, 2, 3, 4]);
  });

  test('duplicate, replayed, out-of-order, mismatched and foreign acknowledgements are refused and leave the file unchanged', async () => {
    const file = path.join(runStore(dir, 'pm').root, 'acks', 'cycle-0001.jsonl');
    const before = sha(file);
    const cases = [
      [{ proc: 'a', worker: 1, n: 4, kind: 'dispatch', seq: 4, actionId: act('a', 1, 4) }, 'duplicate_or_replayed'],
      [{ proc: 'a', worker: 1, n: 6, kind: 'claim', seq: 7, actionId: act('a', 1, 7) }, 'out_of_order'],
      [{ proc: 'a', worker: 1, n: 5, kind: 'dispatch', seq: 7, actionId: act('a', 1, 7) }, 'mismatched_dispatch'],
      [{ proc: 'a', worker: 1, n: 5, kind: 'claim', seq: 6, actionId: act('a', 1, 6) }, 'duplicate_claim_seq'],
      [{ proc: 'a', worker: 1, n: 5, kind: 'claim', seq: 9, actionId: act('b', 1, 9) }, 'action_does_not_belong_to_this_stream'],
      [{ proc: 'a', worker: 3, n: 1, kind: 'claim', seq: 9, actionId: act('a', 3, 9) }, 'stream_not_started'],
      [{ proc: 'c', worker: 1, n: 1, kind: 'claim', seq: 9, actionId: act('c', 1, 9) }, 'stream_not_started'],
    ];
    for (const [body, reason] of cases) assert.equal((await ack(body)).data.error, reason, reason);
    assert.equal((await callM('POST', '/runs/pm/ack', { cycle: 1, cycleId: 'f'.repeat(32), proc: 'a', worker: 1, n: 5, kind: 'claim', seq: 9, actionId: act('a', 1, 9) })).data.error, 'wrong_cycle_id');
    assert.equal((await callM('POST', '/runs/pm/ack', { cycle: 2, cycleId: cycleM, proc: 'a', worker: 1, n: 5, kind: 'claim', seq: 9, actionId: act('a', 1, 9) })).data.error, 'cycle_not_open');
    assert.equal(sha(file), before);
    // Every refusal above that names cycle 1 counts against it (the one sent for cycle 2 belongs to no open cycle).
    assert.equal(cycleView(runStore(dir, 'pm'), 1).authenticatedRejections, cases.length + 1);
  });

  test('a byte-for-byte replay of an accepted request is refused, also after the recorder restarts', async () => {
    const body = JSON.stringify({ cycle: 1, cycleId: cycleM, proc: 'a', worker: 1, n: 5, kind: 'claim', seq: 7, actionId: act('a', 1, 7) });
    const h = signRequest(keyOf(dir, 'pm'), { method: 'POST', path: '/runs/pm/ack', run: 'pm', body });
    assert.equal((await rawSend(srv.base, 'POST', '/runs/pm/ack', h, body)).status, 200);
    assert.equal((await rawSend(srv.base, 'POST', '/runs/pm/ack', h, body)).data.error, 'replayed_nonce');
    await srv.close();
    srv = await serve(dir); // restart: state comes back from disk
    call = callerFor(srv.base, dir, 'p');
    callM = callerFor(srv.base, dir, 'pm');
    assert.equal((await rawSend(srv.base, 'POST', '/runs/pm/ack', h, body)).data.error, 'replayed_nonce');
    assert.equal((await ack({ proc: 'a', worker: 1, n: 5, kind: 'claim', seq: 8, actionId: act('a', 1, 8) })).data.error, 'duplicate_or_replayed', 'the stream position survived the restart');
    assert.equal((await ack({ proc: 'a', worker: 1, n: 6, kind: 'dispatch', seq: 7, actionId: act('a', 1, 7) })).status, 200);
  });

  test('an acknowledgement at or below the cycle start head is refused', async () => {
    // The cycle's window starts at the lowest head any process reported at its start (0 here).
    assert.equal((await ack({ proc: 'b', worker: 1, n: 5, kind: 'claim', seq: 0, actionId: act('b', 1, 0) })).data.error, 'outside_cycle');
  });

  test('decision 2: a PASS with the journal one claim ahead counts only after observed quarantine and clearance', async () => {
    const result = { cycleId, verdict: 'PASS', quarantineRequired: true, uncommitted: { seq: 9, actionId: actP(9) }, needsRecovery: ['clear'] };
    assert.equal((await call('POST', '/runs/p/cycles/1/result', result)).status, 200);
    assert.equal(cycleView(runStore(dir, 'p'), 1).final, 'PENDING_RECOVERY');
    assert.equal((await call('POST', '/runs/p/cycles/2/start', { pgSystemId: pg('p'), proc: 'a', workers: 1, dbHead: 9 })).data.error, 'previous_cycle_not_recovered');
    assert.equal((await call('POST', '/runs/p/cycles/1/recovered', { finalState: FS, cycleId, cleared: true, uncommitted: result.uncommitted })).data.error, 'quarantine_not_observed');
    assert.equal((await call('POST', '/runs/p/event', { cycle: 1, cycleId, kind: 'quarantine_observed', detail: 'database head 8 is behind the journal head 9' })).status, 200);
    assert.equal((await call('POST', '/runs/p/cycles/1/recovered', { finalState: FS, cycleId, cleared: false })).data.error, 'clearance_not_shown');
    assert.equal((await call('POST', '/runs/p/cycles/1/recovered', { finalState: FS, cycleId, cleared: true, uncommitted: { seq: 8, actionId: 'x' } })).data.error, 'clearance_not_shown');
    const ok = await call('POST', '/runs/p/cycles/1/recovered', { finalState: FS, cycleId, cleared: true, uncommitted: result.uncommitted, digest: 'd' });
    assert.equal(ok.data.final, 'PASS');
    assert.equal((await call('POST', '/runs/p/cycles/1/recovered', { finalState: FS, cycleId, cleared: true, uncommitted: result.uncommitted })).data.error, 'already_recovered', 'repeated recovery');
    assert.deepEqual(runStore(dir, 'p').accepted().map((u) => [u.seq, u.actionId]), [[9, actP(9)]]);
    assert.equal((await call('POST', '/runs/p/cycles/1/result', { cycleId, verdict: 'PASS' })).data.error, 'cycle_not_open', 'a result is write-once');
  });

  test('decision 1: an INCONCLUSIVE cycle in a qualifying run stops it and breaks the series', async () => {
    const c2 = (await call('POST', '/runs/p/cycles/2/start', { pgSystemId: pg('p'), proc: 'a', workers: 1, dbHead: 9 })).data.cycleId;
    assert.equal((await call('POST', '/runs/p/cycles/2/result', { cycleId: c2, verdict: 'INCONCLUSIVE', inconclusive: ['POWER_LOSS_NOT_CONFIRMED'], needsRecovery: [] })).data.stopped, true);
    assert.equal((await call('POST', '/runs/p/cycles/3/start', { pgSystemId: pg('p'), proc: 'a', workers: 1, dbHead: 9 })).data.error, 'run_stopped');
    assert.equal((await call('POST', '/runs/p/cycles/1/recovered', { finalState: FS, cycleId })).data.error, 'run_stopped', 'only the inconclusive cycle may still be recovered');
    assert.equal((await call('POST', '/runs/p/cycles/2/recovered', { cycleId: c2 })).data.error, 'final_state_missing');
    assert.equal((await call('POST', '/runs/p/cycles/2/recovered', { finalState: FS, cycleId: c2 })).status, 200, 'so that a new run can continue this state');
    assert.equal((await call('POST', '/runs/p/cycles/3/start', { pgSystemId: pg('p'), proc: 'a', workers: 1, dbHead: 9 })).data.error, 'run_stopped', 'still stopped');
    const st = (await call('GET', '/runs/p')).data;
    assert.match(st.stopped.reason, /series broken/);
    assert.equal(st.stopped.kind, 'inconclusive');
    assert.deepEqual([st.streak.consecutivePhysicalPasses, st.streak.brokenAtCycle, st.streak.brokenBy, st.streak.met], [1, 2, 'INCONCLUSIVE', false]);
  });
});

describe('recorder: replay from a previous cycle, and refusals before a cycle starts', () => {
  const dir = path.join(tmp, 'replay');
  let srv, call;
  before(async () => { mk(dir, { run: 'rp', failureModel: 'HARNESS-SMOKE' }); srv = await serve(dir); call = callerFor(srv.base, dir, 'rp'); });
  after(() => srv.close());
  test('cycle-1 acknowledgements cannot be replayed into cycle 2, by body or byte for byte', async () => {
    const id1 = (await call('POST', '/runs/rp/cycles/1/start', { pgSystemId: pg('rp'), proc: 'a', workers: 1, dbHead: 0 })).data.cycleId;
    const old = { cycle: 1, cycleId: id1, proc: 'a', worker: 1, n: 1, kind: 'claim', seq: 1, actionId: T('rp', 'c0001aw1-1') };
    const body = JSON.stringify(old);
    const h = signRequest(keyOf(dir, 'rp'), { method: 'POST', path: '/runs/rp/ack', run: 'rp', body });
    assert.equal((await rawSend(srv.base, 'POST', '/runs/rp/ack', h, body)).status, 200);
    assert.equal((await call('POST', '/runs/rp/cycles/1/result', { cycleId: id1, verdict: 'INCONCLUSIVE', needsRecovery: [] })).status, 200);
    // A start refused because the operator forgot `recover` must not count against cycle 2.
    assert.equal((await call('POST', '/runs/rp/cycles/2/start', { pgSystemId: pg('rp'), proc: 'a', workers: 1, dbHead: 1 })).data.error, 'previous_cycle_not_recovered');
    assert.equal((await call('POST', '/runs/rp/cycles/1/recovered', { finalState: FS, cycleId: id1 })).status, 200);
    const id2 = (await call('POST', '/runs/rp/cycles/2/start', { pgSystemId: pg('rp'), proc: 'a', workers: 1, dbHead: 1 })).data.cycleId;
    assert.notEqual(id2, id1);
    assert.equal(cycleView(runStore(dir, 'rp'), 2).authenticatedRejections, 0);
    assert.equal((await call('POST', '/runs/rp/ack', old)).data.error, 'cycle_not_open', 'a cycle-1 acknowledgement, freshly signed');
    assert.equal((await call('POST', '/runs/rp/ack', { ...old, cycle: 2, actionId: T('rp', 'c0002aw1-1'), seq: 2 })).data.error, 'wrong_cycle_id', 'cycle 2 with cycle 1\'s id');
    assert.equal((await rawSend(srv.base, 'POST', '/runs/rp/ack', h, body)).data.error, 'replayed_nonce', 'the original request, byte for byte');
    assert.equal(runStore(dir, 'rp').acks(2).length, 0);
    assert.equal(runStore(dir, 'rp').acks(1).length, 1);
    assert.equal(cycleView(runStore(dir, 'rp'), 2).authenticatedRejections, 1, 'only the refusal that named cycle 2 after it started');
  });
});

describe('recorder: FAIL, evidence retention, damage and boot evidence', () => {
  const dir = path.join(tmp, 'fail');
  let srv, call;
  before(async () => {
    mk(dir, { run: 'f', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    mk(dir, { run: 'smoke', failureModel: 'HARNESS-SMOKE' });
    mk(dir, { run: 'torn', failureModel: 'HARNESS-SMOKE' });
    srv = await serve(dir, { silentStopMs: 1000 });
    call = callerFor(srv.base, dir, 'f');
  });
  after(() => srv.close());

  test('a FAIL stops the run; nothing afterwards changes the recorded evidence; the rejection log only grows', async () => {
    const id = (await call('POST', '/runs/f/cycles/1/start', { pgSystemId: pg('f'), proc: 'a', workers: 1, dbHead: 0 })).data.cycleId;
    assert.equal((await call('POST', '/runs/f/ack', { cycle: 1, cycleId: id, proc: 'a', worker: 1, n: 1, kind: 'claim', seq: 1, actionId: T('f', 'c0001aw1-1') })).status, 200);
    assert.equal((await call('POST', '/runs/f/cycles/1/result', { cycleId: id, verdict: 'FAIL', fails: ['ACKNOWLEDGED_CLAIM_MISSING_FROM_JOURNAL'] })).data.stopped, true);
    const root = runStore(dir, 'f').root;
    const frozen = Object.fromEntries(listFiles(root).filter((f) => f !== 'rejections.jsonl').map((f) => [f, sha(path.join(root, f))]));
    const rejFile = path.join(root, 'rejections.jsonl');
    const rejBefore = fs.existsSync(rejFile) ? fs.readFileSync(rejFile, 'utf8') : '';
    for (const [m, p, b] of [
      ['POST', '/runs/f/cycles/2/start', { pgSystemId: pg('f'), proc: 'a', workers: 1, dbHead: 1 }],
      ['POST', '/runs/f/ack', { cycle: 1, cycleId: id, proc: 'a', worker: 1, n: 2, kind: 'dispatch', seq: 1, actionId: T('f', 'c0001aw1-1') }],
      ['POST', '/runs/f/cycles/1/result', { cycleId: id, verdict: 'PASS' }],
      ['POST', '/runs/f/cycles/1/recovered', { finalState: FS, cycleId: id }],
    ]) assert.equal((await call(m, p, b)).status, 409, p);
    assert.deepEqual(Object.fromEntries(listFiles(root).filter((f) => f !== 'rejections.jsonl').map((f) => [f, sha(path.join(root, f))])), frozen);
    const rejAfter = fs.readFileSync(rejFile, 'utf8');
    assert.ok(rejAfter.startsWith(rejBefore) && rejAfter.length > rejBefore.length, 'append-only, and the refusals were logged');
    const st = (await call('GET', '/runs/f')).data;
    assert.equal(st.streak.anyFail, true);
    assert.equal(st.streak.met, false);
  });

  test('an INCONCLUSIVE smoke cycle does not stop a HARNESS-SMOKE run', async () => {
    const c = callerFor(srv.base, dir, 'smoke');
    const id = (await c('POST', '/runs/smoke/cycles/1/start', { pgSystemId: pg('smoke'), proc: 'a', workers: 1, dbHead: 0 })).data.cycleId;
    assert.equal((await c('POST', '/runs/smoke/cycles/1/result', { cycleId: id, verdict: 'INCONCLUSIVE', needsRecovery: [] })).data.stopped, false);
    assert.equal((await c('POST', '/runs/smoke/cycles/1/recovered', { finalState: FS, cycleId: id })).status, 200);
    assert.equal((await c('POST', '/runs/smoke/cycles/2/start', { pgSystemId: pg('smoke'), proc: 'a', workers: 1, dbHead: 0 })).status, 200);
  });

  test('a torn line in the recorder\'s own acknowledgement file blocks further acknowledgements for that cycle', async () => {
    const c = callerFor(srv.base, dir, 'torn');
    const id = (await c('POST', '/runs/torn/cycles/1/start', { pgSystemId: pg('torn'), proc: 'a', workers: 1, dbHead: 0 })).data.cycleId;
    assert.equal((await c('POST', '/runs/torn/ack', { cycle: 1, cycleId: id, proc: 'a', worker: 1, n: 1, kind: 'claim', seq: 1, actionId: T('torn', 'c0001aw1-1') })).status, 200);
    fs.appendFileSync(path.join(runStore(dir, 'torn').root, 'acks', 'cycle-0001.jsonl'), '{"cycle":1,"ki');
    await srv.close();
    srv = await serve(dir, { silentStopMs: 1000 });
    const c2 = callerFor(srv.base, dir, 'torn');
    assert.equal((await c2('POST', '/runs/torn/ack', { cycle: 1, cycleId: id, proc: 'a', worker: 1, n: 2, kind: 'dispatch', seq: 1, actionId: T('torn', 'c0001aw1-1') })).data.error, 'recorder_ack_file_damaged');
    call = callerFor(srv.base, dir, 'f');
  });

  test('cut bounds, boot reports and silent worker stops are recorded by the recorder\'s own clock', async () => {
    const c = callerFor(srv.base, dir, 'smoke');
    const s = runStore(dir, 'smoke');
    const id = cycleView(s, 2).cycleId;
    assert.equal((await c('POST', '/runs/smoke/ack', { cycle: 2, cycleId: id, proc: 'a', worker: 1, n: 1, kind: 'claim', seq: 1, actionId: T('smoke', 'c0002aw1-1') })).status, 200);
    await new Promise((r) => setTimeout(r, 1200));
    s.event({ cycle: 2, kind: 'cut_sent', how: 'command' }); // as `recorder.mjs cut` writes it
    assert.equal((await c('POST', '/runs/smoke/boot', { bootId: 'boot-2', bootTime: Date.now() - 500, databaseReachableAt: Date.now() })).data.cycle, 2);
    const v = cycleView(s, 2, { silentStopMs: 1000 });
    assert.equal(v.independentlyObservedCutAt, null);
    assert.ok(v.lastDurableAck.atMs < v.cutRequestedAtMs && v.firstContactAfterCut.atMs > v.cutRequestedAtMs);
    assert.deepEqual(v.silentWorkerStops.map((w) => [w.proc, w.worker]), [['a', 1]]);
  });
});

describe('final status and the qualifying series (decisions 1, 2, 9)', () => {
  const P = (cycle, status = 'PASS') => ({ cycle, status });
  test('finalStatus', () => {
    assert.equal(finalStatus(null, null), 'NOT_CHECKED');
    assert.equal(finalStatus({ verdict: 'FAIL' }, null), 'FAIL');
    assert.equal(finalStatus({ verdict: 'PASS' }, null), 'PENDING_RECOVERY');
    assert.equal(finalStatus({ verdict: 'PASS', quarantineRequired: true }, { quarantineObserved: true, cleared: false }), 'PENDING_RECOVERY');
    assert.equal(finalStatus({ verdict: 'PASS', quarantineRequired: true }, { quarantineObserved: true, cleared: true }), 'PASS');
    assert.equal(finalStatus({ verdict: 'PASS' }, { quarantineObserved: false, cleared: false }), 'PASS');
  });
  test('20 PASS cycles from cycle 1 meet it; 19 do not; a VM-CRASH run never does', () => {
    assert.equal(physicalStreak(Array.from({ length: 20 }, (_, i) => P(i + 1)), 'POWER-CUT').met, true);
    assert.equal(physicalStreak(Array.from({ length: 19 }, (_, i) => P(i + 1)), 'POWER-CUT').met, false);
    assert.equal(physicalStreak(Array.from({ length: 25 }, (_, i) => P(i + 1)), 'VM-CRASH').consecutivePhysicalPasses, 0);
  });
  test('an INCONCLUSIVE or pending cycle ends the series: later passes do not count', () => {
    const rs = Array.from({ length: 25 }, (_, i) => P(i + 1));
    rs[2] = P(3, 'INCONCLUSIVE');
    assert.deepEqual(physicalStreak(rs, 'POWER-CUT'), { consecutivePhysicalPasses: 2, required: 20, met: false, brokenAtCycle: 3, brokenBy: 'INCONCLUSIVE', anyFail: false });
    rs[2] = P(3, 'PENDING_RECOVERY');
    assert.equal(physicalStreak(rs, 'POWER-CUT').consecutivePhysicalPasses, 2);
  });
  test('a FAIL after 20 passes means the requirement is not met', () => {
    assert.equal(physicalStreak([...Array.from({ length: 20 }, (_, i) => P(i + 1)), P(21, 'FAIL')], 'POWER-CUT').met, false);
  });
});

describe('run lifecycle: a new run continues the same state after INCONCLUSIVE', () => {
  const dir = path.join(tmp, 'life');
  let srv;
  const S1 = { installationId: 'inst-9', head: 40, headHash: 'cd'.repeat(32) };
  const frozen = (run) => { const root = runStore(dir, run).root; return Object.fromEntries(listFiles(root).map((f) => [f, sha(path.join(root, f))])); };
  before(async () => { srv = await serve(dir); });
  after(() => srv.close());

  test('only a recovered, non-failed run can be continued, and only once', async () => {
    mk(dir, { run: 'a1', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    const call = callerFor(srv.base, dir, 'a1');
    assert.throws(() => createRun(dir, { run: 'a2', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE, continues: 'a1' }), /not stopped/, 'before any cycle');
    // cycle 1: PASS with the journal one claim ahead -> quarantine, clearance: one claim accepted as never committed
    const id1 = (await call('POST', '/runs/a1/cycles/1/start', { pgSystemId: pg('a1'), proc: 'a', workers: 1, dbHead: 0 })).data.cycleId;
    const unc = { seq: 31, actionId: T('a1', 'c0001aw1-31') };
    await call('POST', '/runs/a1/cycles/1/result', { cycleId: id1, verdict: 'PASS', quarantineRequired: true, uncommitted: unc, needsRecovery: ['clear'] });
    await call('POST', '/runs/a1/event', { cycle: 1, cycleId: id1, kind: 'quarantine_observed' });
    assert.equal((await call('POST', '/runs/a1/cycles/1/recovered', { cycleId: id1, cleared: true, uncommitted: unc, digest: 'd', finalState: { ...S1, head: 31 } })).data.final, 'PASS');
    // cycle 2: INCONCLUSIVE -> the run stops
    const id2 = (await call('POST', '/runs/a1/cycles/2/start', { pgSystemId: pg('a1'), proc: 'a', workers: 1, dbHead: 31 })).data.cycleId;
    assert.throws(() => createRun(dir, { run: 'a2', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE, continues: 'a1' }), /not stopped/, 'while a cycle is open');
    assert.equal((await call('POST', '/runs/a1/cycles/2/result', { cycleId: id2, verdict: 'INCONCLUSIVE', inconclusive: ['POWER_LOSS_NOT_CONFIRMED'], needsRecovery: [] })).data.stopped, true);
    assert.throws(() => createRun(dir, { run: 'a2', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE, continues: 'a1' }), /has not been recovered/, 'recovery is never skipped');
    assert.equal((await call('POST', '/runs/a1/cycles/2/recovered', { cycleId: id2, finalState: S1 })).status, 200);
    const before = frozen('a1');
    const { run } = createRun(dir, { run: 'a2', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE, continues: 'a1' });
    assert.deepEqual(run.continues, { run: 'a1', failureModel: 'POWER-CUT', lastCycle: 2, finalState: S1, stopped: { kind: 'inconclusive', cycle: 2 } });
    assert.deepEqual(runStore(dir, 'a2').accepted().map((u) => [u.seq, u.actionId, u.fromRun]), [[31, unc.actionId, 'a1']], 'accepted claims carry over');
    assert.notEqual(fs.readFileSync(runStore(dir, 'a2').keyFile, 'utf8'), fs.readFileSync(runStore(dir, 'a1').keyFile, 'utf8'), 'a new key');
    assert.throws(() => createRun(dir, { run: 'a3', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE, continues: 'a1' }), /already continues/);
    // The reverse direction: qualifying state is never continued by a smoke or supplementary run.
    assert.throws(() => createRun(dir, { run: 'a4', failureModel: 'HARNESS-SMOKE', continues: 'a1' }), /HARNESS-SMOKE run cannot continue POWER-CUT state/);
    assert.throws(() => createRun(dir, { run: 'a5', failureModel: 'VM-CRASH', storage: STORAGE, identity: IDENTITY, package: PACKAGE, continues: 'a1' }), /VM-CRASH run cannot continue POWER-CUT state/);
    assert.deepEqual(frozen('a1'), before, 'the earlier run\'s record is untouched');
  });

  test('the new run must adopt exactly the recorded state before its first cycle; the count restarts at zero', async () => {
    const before = frozen('a1');
    const call = callerFor(srv.base, dir, 'a2');
    assert.equal((await callerFor(srv.base, dir, 'a2', keyOf(dir, 'a1'))('GET', '/runs/a2')).status, 401, 'the earlier run\'s key does not open the new run');
    assert.equal((await call('POST', '/runs/a2/cycles/1/start', { pgSystemId: pg('a1'), proc: 'a', workers: 1, dbHead: 40 })).data.error, 'not_adopted');
    assert.equal((await call('POST', '/runs/a2/event', { kind: 'initialised' })).data.error, 'continuing_run_uses_adopt');
    assert.equal((await call('POST', '/runs/a2/event', { kind: 'adopted', finalState: { ...S1, head: 41 } })).data.error, 'state_differs_from_predecessor');
    assert.equal((await call('POST', '/runs/a2/event', { kind: 'adopted', finalState: { ...S1, headHash: 'ef'.repeat(32) } })).data.error, 'state_differs_from_predecessor');
    assert.equal((await call('POST', '/runs/a2/event', { kind: 'adopted' })).data.error, 'state_differs_from_predecessor');
    assert.equal((await call('POST', '/runs/a2/event', { kind: 'adopted', finalState: S1, pgSystemId: pg('a1') })).status, 200);
    assert.equal((await call('POST', '/runs/a2/event', { kind: 'adopted', finalState: S1, pgSystemId: pg('a1') })).data.error, 'already_adopted');
    // A new run of a qualifying series is attested again by the operator (the firewall is re-verified per boot anyway).
    assert.equal((await call('POST', '/runs/a2/cycles/1/start', { pgSystemId: pg('a1'), proc: 'a', workers: 1, dbHead: 40 })).data.error, 'attestations_missing');
    for (const item of REQUIRED_ATTESTATIONS) runStore(dir, 'a2').event({ cycle: null, kind: 'attestation', item, evidence: 'test', attestation: 'operator' });
    assert.equal((await call('POST', '/runs/a2/cycles/1/start', { pgSystemId: pg('a1'), proc: 'a', workers: 1, dbHead: 39 })).data.error, 'head_below_predecessor');
    const st = (await call('GET', '/runs/a2')).data;
    assert.deepEqual([st.cycles.length, st.streak.consecutivePhysicalPasses, st.stopped], [0, 0, null]);
    const id = (await call('POST', '/runs/a2/cycles/1/start', { pgSystemId: pg('a1'), proc: 'a', workers: 1, dbHead: 40 })).data.cycleId;
    // The same cycle number as the earlier run, but its own actions: an earlier run's action id is refused.
    assert.equal((await call('POST', '/runs/a2/ack', { cycle: 1, cycleId: id, proc: 'a', worker: 1, n: 1, kind: 'claim', seq: 41, actionId: T('a1', 'c0001aw1-41') })).data.error, 'action_does_not_belong_to_this_stream');
    assert.equal((await call('POST', '/runs/a2/ack', { cycle: 1, cycleId: id, proc: 'a', worker: 1, n: 1, kind: 'claim', seq: 41, actionId: T('a2', 'c0001aw1-41') })).status, 200);
    assert.deepEqual(frozen('a1'), before, 'nothing in the new run changed the earlier run\'s evidence');
    assert.equal((await callerFor(srv.base, dir, 'a1')('POST', '/runs/a1/cycles/3/start', { pgSystemId: pg('a1'), proc: 'a', workers: 1, dbHead: 40 })).data.error, 'run_stopped', 'the earlier run stays stopped');
  });

  test('a failed run, or one not recovered, can never be continued', async () => {
    mk(dir, { run: 'f1', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    let call = callerFor(srv.base, dir, 'f1');
    let id = (await call('POST', '/runs/f1/cycles/1/start', { pgSystemId: pg('f1'), proc: 'a', workers: 1, dbHead: 0 })).data.cycleId;
    await call('POST', '/runs/f1/cycles/1/result', { cycleId: id, verdict: 'FAIL', fails: ['JOURNAL_CORRUPT'] });
    assert.equal((await call('POST', '/runs/f1/cycles/1/recovered', { cycleId: id, finalState: S1 })).status, 409);
    assert.throws(() => createRun(dir, { run: 'f2', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE, continues: 'f1' }), /failed/);
    mk(dir, { run: 'g1', failureModel: 'HARNESS-SMOKE' });
    call = callerFor(srv.base, dir, 'g1');
    id = (await call('POST', '/runs/g1/cycles/1/start', { pgSystemId: pg('g1'), proc: 'a', workers: 1, dbHead: 0 })).data.cycleId;
    await call('POST', '/runs/g1/cycles/1/result', { cycleId: id, verdict: 'INCONCLUSIVE', needsRecovery: ['repair-torn-tail'] });
    await call('POST', '/runs/g1/stop', { cycle: 1, reason: 'recovery: torn-tail repair did not verify' });
    assert.equal(runStore(dir, 'g1').stopped().kind, 'recovery-failed');
    assert.throws(() => createRun(dir, { run: 'g2', failureModel: 'HARNESS-SMOKE', continues: 'g1' }), /recovery failed/);
  });
});

describe('run lifecycle: safeguards that cannot be bypassed', () => {
  const dir = path.join(tmp, 'guard');
  let srv;
  const S = { installationId: 'inst-3', head: 5, headHash: '12'.repeat(32) };
  before(async () => { srv = await serve(dir); });
  after(() => srv.close());

  test('a run cannot start on volumes it neither initialised nor adopted', async () => {
    createRun(dir, { run: 'z1', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE }); // a fresh run id pointed at existing volumes
    const call = callerFor(srv.base, dir, 'z1');
    assert.equal((await call('POST', '/runs/z1/cycles/1/start', { pgSystemId: pg('z1'), proc: 'a', workers: 1, dbHead: 500 })).data.error, 'not_initialised');
    assert.equal((await call('POST', '/runs/z1/event', { kind: 'adopted', finalState: S })).data.error, 'not_a_continuing_run');
    assert.equal((await call('POST', '/runs/z1/event', { kind: 'initialised' })).data.error, 'volume_not_claimed', 'init must claim the volumes first');
  });

  test('a run that is not stopped cannot be continued (it could resume beside its successor)', async () => {
    mk(dir, { run: 'n1', failureModel: 'HARNESS-SMOKE' });
    const call = callerFor(srv.base, dir, 'n1');
    const id = (await call('POST', '/runs/n1/cycles/1/start', { pgSystemId: pg('n1'), proc: 'a', workers: 1, dbHead: 0 })).data.cycleId;
    await call('POST', '/runs/n1/cycles/1/result', { cycleId: id, verdict: 'INCONCLUSIVE', needsRecovery: [] });
    assert.equal((await call('POST', '/runs/n1/cycles/1/recovered', { cycleId: id, finalState: S })).status, 200);
    assert.equal(runStore(dir, 'n1').stopped(), null);
    assert.throws(() => createRun(dir, { run: 'n2', failureModel: 'HARNESS-SMOKE', continues: 'n1' }), /not stopped/);
  });

  test('a failed recovery in an INCONCLUSIVE-stopped run is recorded, and ends recovery and continuation for good', async () => {
    mk(dir, { run: 'h1', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    const call = callerFor(srv.base, dir, 'h1');
    const id = (await call('POST', '/runs/h1/cycles/1/start', { pgSystemId: pg('h1'), proc: 'a', workers: 1, dbHead: 0 })).data.cycleId;
    await call('POST', '/runs/h1/cycles/1/result', { cycleId: id, verdict: 'INCONCLUSIVE', needsRecovery: ['repair-torn-tail'] });
    assert.equal(runStore(dir, 'h1').stopped().kind, 'inconclusive');
    assert.equal((await call('POST', '/runs/h1/stop', { cycle: 1, reason: 'recovery: torn-tail repair did not verify' })).status, 200);
    assert.equal(runStore(dir, 'h1').stopped().kind, 'inconclusive', 'the marker is write-once');
    assert.ok(runStore(dir, 'h1').events().some((e) => e.kind === 'recovery_failed'), 'but the failure is on record');
    assert.equal((await call('POST', '/runs/h1/cycles/1/recovered', { cycleId: id, finalState: S })).data.error, 'recovery_failed_earlier');
    assert.throws(() => createRun(dir, { run: 'h2', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE, continues: 'h1' }), /recovery failed/);
  });

  test('the cut must fall within the time every process sized its pool for', () => {
    const t0 = 1_000_000;
    const starts = [{ atMs: t0, sizing: { maxSeconds: 660 } }, { atMs: t0 + 5000, sizing: { maxSeconds: 660 } }];
    assert.equal(cutRefusal({ starts }, 600_000, t0 + 30_000), null);            // 30 s in, up to 600 s more: 630 <= 660
    assert.match(cutRefusal({ starts }, 600_000, t0 + 90_000), /sized for 660 s/); // 690 > 660
    assert.match(cutRefusal({ starts: [starts[0], { atMs: t0, sizing: { maxSeconds: 60 } }] }, 100_000, t0 + 1000), /sized for 60 s/);
    assert.match(cutRefusal({ starts: [{ atMs: t0 }] }, 1000, t0), /did not report/);
  });
});

describe('qualifying runs never share volumes or state with smoke or supplementary runs', () => {
  const dir = path.join(tmp, 'mix');
  let srv;
  const S = { installationId: 'inst-5', head: 12, headHash: '34'.repeat(32) };
  const EMPTY = (id) => ({ pgSystemId: id, publicRelations: 0, stateEntries: 0, walLsnBytes: 25 * 1024 * 1024, serverVersion: '16.14' });
  before(async () => { srv = await serve(dir); });
  after(() => srv.close());
  /** A HARNESS-SMOKE run stopped by an INCONCLUSIVE cycle and recovered: continuable by its own type only. */
  async function stoppedSmoke(run) {
    mk(dir, { run, failureModel: 'HARNESS-SMOKE', stopOnInconclusive: true });
    const call = callerFor(srv.base, dir, run);
    const id = (await call('POST', `/runs/${run}/cycles/1/start`, { pgSystemId: pg(run), proc: 'a', workers: 1, dbHead: 0 })).data.cycleId;
    await call('POST', `/runs/${run}/cycles/1/result`, { cycleId: id, verdict: 'INCONCLUSIVE', needsRecovery: [] });
    assert.equal((await call('POST', `/runs/${run}/cycles/1/recovered`, { cycleId: id, finalState: S })).status, 200);
  }

  test('a POWER-CUT or VM-CRASH run cannot continue HARNESS-SMOKE state, and the reverse', async () => {
    await stoppedSmoke('s1');
    assert.throws(() => createRun(dir, { run: 'p-bad', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE, continues: 's1' }), /POWER-CUT run cannot continue HARNESS-SMOKE state/);
    assert.throws(() => createRun(dir, { run: 'v-bad', failureModel: 'VM-CRASH', storage: STORAGE, identity: IDENTITY, package: PACKAGE, continues: 's1' }), /VM-CRASH run cannot continue HARNESS-SMOKE state/);
    assert.ok(!fs.existsSync(runStore(dir, 'p-bad').root) && !fs.existsSync(runStore(dir, 'p-bad').keyFile), 'nothing is created');
    assert.equal(createRun(dir, { run: 's2', failureModel: 'HARNESS-SMOKE', continues: 's1' }).run.rootRun, 's1', 'smoke continues smoke');
  });

  test('a POWER-CUT run cannot claim volumes any earlier run used, even after their contents were removed', async () => {
    createRun(dir, { run: 'pc1', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    const call = callerFor(srv.base, dir, 'pc1');
    // The database cluster of smoke run s1, emptied by hand: it looks empty, but the recorder knows the cluster.
    assert.equal((await call('POST', '/runs/pc1/event', { kind: 'volume_claimed', volume: EMPTY(pg('s1')) })).data.error, 'volume_already_used_by_s1');
    assert.equal((await call('POST', '/runs/pc1/volume-check', { pgSystemId: pg('s1') })).data.registeredTo, 's1');
    // Not fresh: relations present, journal volume not empty, or a cluster with a long WAL history.
    for (const over of [{ publicRelations: 3 }, { stateEntries: 1 }, { walLsnBytes: 900 * 1024 * 1024 }, { pgSystemId: 'x' }]) {
      const r = await call('POST', '/runs/pc1/event', { kind: 'volume_claimed', volume: { ...EMPTY('7111111111111111111'), ...over } });
      assert.ok(['volume_not_fresh', 'volume_identity_missing'].includes(r.data.error), JSON.stringify(over));
    }
    assert.equal(volumeOwner(dir, '7111111111111111111'), null, 'a refused claim registers nothing');
    assert.equal((await call('POST', '/runs/pc1/cycles/1/start', { pgSystemId: '7111111111111111111', proc: 'a', workers: 1, dbHead: 0 })).data.error, 'not_initialised');
    // Fresh volumes: claimed with the empty-state evidence, then initialised.
    assert.equal((await call('POST', '/runs/pc1/event', { kind: 'volume_claimed', volume: EMPTY('7111111111111111111') })).status, 200);
    const reg = volumeOwner(dir, '7111111111111111111');
    assert.deepEqual([reg.run, reg.failureModel, reg.emptyStateEvidence.publicRelations, reg.emptyStateEvidence.stateEntries], ['pc1', 'POWER-CUT', 0, 0]);
    assert.equal((await call('POST', '/runs/pc1/event', { kind: 'volume_claimed', volume: EMPTY('7222222222222222222') })).data.error, 'already_claimed');
    assert.equal((await call('POST', '/runs/pc1/event', { kind: 'initialised', installationId: 'inst-pc1' })).status, 200);
  });

  test('a qualifying cycle needs the operator attestations and the series\' own volumes', async () => {
    const call = callerFor(srv.base, dir, 'pc1');
    const start = (pgSystemId) => call('POST', '/runs/pc1/cycles/1/start', { pgSystemId, proc: 'a', workers: 1, dbHead: 0 });
    assert.equal((await start(pg('s1'))).data.error, 'volume_differs_from_series', 'pointed at the smoke volumes');
    assert.equal((await start('7111111111111111111')).data.error, 'attestations_missing');
    const st = runStore(dir, 'pc1');
    for (const item of REQUIRED_ATTESTATIONS.slice(0, 2)) st.event({ cycle: null, kind: 'attestation', item, evidence: 'done on the host', attestation: 'operator' });
    assert.equal((await start('7111111111111111111')).data.error, 'attestations_missing', 'all three are required');
    st.event({ cycle: null, kind: 'attestation', item: REQUIRED_ATTESTATIONS[2], evidence: 'reviewed', attestation: 'operator' });
    assert.equal((await start('7111111111111111111')).status, 200);
    const status = (await call('GET', '/runs/pc1')).data;
    assert.deepEqual(status.attestations.map((x) => x.attestation), ['operator', 'operator', 'operator']);
  });

  test('a smoke run cannot claim volumes a qualifying run used either, and a continuing run cannot claim or initialise', async () => {
    createRun(dir, { run: 's9', failureModel: 'HARNESS-SMOKE' });
    assert.equal((await callerFor(srv.base, dir, 's9')('POST', '/runs/s9/event', { kind: 'volume_claimed', volume: EMPTY('7111111111111111111') })).data.error, 'volume_already_used_by_pc1');
    const c = callerFor(srv.base, dir, 's2');
    assert.equal((await c('POST', '/runs/s2/event', { kind: 'volume_claimed', volume: EMPTY('7333333333333333333') })).data.error, 'continuing_run_uses_adopt');
    assert.equal((await c('POST', '/runs/s2/event', { kind: 'adopted', finalState: S, pgSystemId: pg('pc1') })).data.error, 'volume_differs_from_series');
    assert.equal((await c('POST', '/runs/s2/event', { kind: 'adopted', finalState: S, pgSystemId: pg('s1') })).status, 200);
  });
});

describe('start vetting and operator commands', () => {
  const dir = path.join(tmp, 'ops');
  const cli = fileURLToPath(new URL('../recorder.mjs', import.meta.url));
  const template = fileURLToPath(new URL('../storage-evidence.template.json', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--dir', dir], { encoding: 'utf8' });
  let srv;
  before(async () => { srv = await serve(dir); });
  after(() => srv.close());

  test('create-run --storage-json: the unfilled template is refused with every reason; a filled one is accepted', () => {
    const r = run('create-run', '--new-directory', '--run', 'pc', '--failure-model', 'POWER-CUT', '--storage-json', template, ...IDENTITY_FLAGS);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /driveModel is missing or unknown[\s\S]*vendorDoc is missing[\s\S]*writeCache must be/);
    assert.ok(!fs.existsSync(path.join(dir, 'keys', 'pc.key')));
    const filled = path.join(tmp, 'storage-filled.json');
    fs.writeFileSync(filled, JSON.stringify({ ...JSON.parse(fs.readFileSync(template, 'utf8')), ...STORAGE }));
    const ok = run('create-run', '--new-directory', '--run', 'pc', '--failure-model', 'POWER-CUT', '--storage-json', filled, ...IDENTITY_FLAGS);
    assert.equal(ok.status, 0, ok.stderr);
    const out = JSON.parse(ok.stdout);
    assert.equal(out.run.storage.firmware, STORAGE.firmware);
    assert.ok(!ok.stdout.includes(fs.readFileSync(out.keyFile, 'utf8').trim()), 'the key is not printed');
    assert.notEqual(run('create-run', '--run', 'no-evidence', '--failure-model', 'POWER-CUT').status, 0);
  });

  test('attest: only the three known items, with evidence; recorded as operator attestations', () => {
    assert.match(run('attest', '--run', 'pc', '--item', 'something-else', '--evidence', 'x').stderr, /--item must be one of/);
    assert.match(run('attest', '--run', 'pc', '--item', 'firewall-verified-on-host').stderr, /--evidence is required/);
    for (const item of REQUIRED_ATTESTATIONS) assert.equal(run('attest', '--run', 'pc', '--item', item, '--evidence', `done on the host, see host/${item}`).status, 0);
    const ev = runStore(dir, 'pc').events().filter((e) => e.kind === 'attestation');
    assert.deepEqual(ev.map((e) => [e.item, e.attestation]), REQUIRED_ATTESTATIONS.map((i) => [i, 'operator']));
  });

  test('a vetted start records nothing; a refused vet leaves the cycle clean and retryable', async () => {
    const call = callerFor(srv.base, dir, 'pc');
    const body = { pgSystemId: '7444444444444444444', proc: 'a', workers: 1, dbHead: 0 };
    // (It states its own half, so the helper's automatic preflight does not run before the volumes are even claimed.)
    assert.equal((await call('POST', '/runs/pc/cycles/1/start', { ...body, vet: true, readiness: TB(body.pgSystemId, 1) })).data.error, 'not_initialised');
    assert.equal((await call('POST', '/runs/pc/event', { kind: 'volume_claimed', volume: { pgSystemId: body.pgSystemId, publicRelations: 0, stateEntries: 0, walLsnBytes: 26_000_000 } })).status, 200);
    assert.equal((await call('POST', '/runs/pc/event', { kind: 'initialised', installationId: 'inst-pc' })).status, 200);
    makeReady(dir, 'pc', 1, body.pgSystemId); // preflight, after init
    const eventsBefore = runStore(dir, 'pc').events().length;
    assert.deepEqual((await call('POST', '/runs/pc/cycles/1/start', { ...body, vet: true })).data, { vetted: true });
    assert.deepEqual((await call('POST', '/runs/pc/cycles/1/start', { ...body, vet: true })).data, { vetted: true }, 'vetting twice is fine');
    assert.equal(runStore(dir, 'pc').events().length, eventsBefore, 'nothing was recorded');
    assert.equal(cycleView(runStore(dir, 'pc'), 1).starts.length, 0);
    assert.match((await call('POST', '/runs/pc/cycles/1/start', body)).data.cycleId, /^[0-9a-f]{32}$/);
    assert.equal(cycleView(runStore(dir, 'pc'), 1).authenticatedRejections, 0, 'the earlier refusal does not count against the cycle');
  });
});

describe('volume registry: preserved across runs, never reset, replaced or rebuilt', () => {
  const dir = path.join(tmp, 'registry');
  const reg = path.join(dir, 'volumes.jsonl');
  let srv;
  const [X1, X2, X3] = ['7111111111111111111', '7222222222222222222', '7333333333333333333'];
  const S = { installationId: 'inst-7', head: 5, headHash: 'ef'.repeat(32) };
  const EMPTY = (id) => ({ pgSystemId: id, publicRelations: 0, stateEntries: 0, walLsnBytes: 25 * 1024 * 1024, serverVersion: '16.14' });
  const frozen = (run) => { const root = runStore(dir, run).root; return Object.fromEntries(listFiles(root).map((f) => [f, sha(path.join(root, f))])); };
  const claim = (run, id) => callerFor(srv.base, dir, run)('POST', `/runs/${run}/event`, { kind: 'volume_claimed', volume: EMPTY(id) });
  before(async () => { srv = await serve(dir); });
  after(() => srv.close());

  test('it only grows: a smoke run, a new qualifying run and a recorder restart leave earlier entries byte-identical', async () => {
    createRun(dir, { run: 's1', failureModel: 'HARNESS-SMOKE' });
    assert.equal((await claim('s1', X1)).status, 200);
    assert.equal((await callerFor(srv.base, dir, 's1')('POST', '/runs/s1/event', { kind: 'initialised', installationId: 'inst-s1' })).status, 200);
    const afterSmoke = fs.readFileSync(reg, 'utf8');
    createRun(dir, { run: 'pc1', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    assert.equal(fs.readFileSync(reg, 'utf8'), afterSmoke, 'creating a qualifying run does not touch the registry');
    assert.equal((await claim('pc1', X1)).data.error, 'volume_already_used_by_s1');
    assert.equal((await claim('pc1', X2)).status, 200);
    const afterPc = fs.readFileSync(reg, 'utf8');
    assert.ok(afterPc.startsWith(afterSmoke) && afterPc.trim().split('\n').length === 2, 'one line appended; the smoke entry is untouched');
    assert.equal(runStore(dir, 'pc1').events().find((e) => e.kind === 'volume_claimed').pgSystemId, X2, 'the run\'s own ledger records the cluster too');
    await srv.close(); srv = await serve(dir); // a restarted recorder reads the same history
    assert.equal(fs.readFileSync(reg, 'utf8'), afterPc);
    createRun(dir, { run: 'pc2', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    for (const used of [X1, X2]) assert.match((await claim('pc2', used)).data.error, /^volume_already_used_by_/, 'a new run cannot bypass the history');
    assert.equal(fs.readFileSync(reg, 'utf8'), afterPc, 'refused claims add nothing');
    assert.equal(registryProblem(dir), null);
  });

  test('a deleted, truncated, emptied, replaced or edited registry is refused everywhere and never rebuilt', async () => {
    // pc1: one cycle with an acknowledgement, INCONCLUSIVE, recovered; pc1b continues it but has not adopted yet.
    const call = callerFor(srv.base, dir, 'pc1');
    assert.equal((await call('POST', '/runs/pc1/event', { kind: 'initialised', installationId: 'inst-7' })).status, 200);
    const st = runStore(dir, 'pc1');
    for (const item of REQUIRED_ATTESTATIONS) st.event({ cycle: null, kind: 'attestation', item, evidence: 'test', attestation: 'operator' });
    const id = (await call('POST', '/runs/pc1/cycles/1/start', { pgSystemId: X2, proc: 'a', workers: 1, dbHead: 0 })).data.cycleId;
    assert.equal((await call('POST', '/runs/pc1/ack', { cycle: 1, cycleId: id, proc: 'a', worker: 1, n: 1, kind: 'claim', seq: 1, actionId: T('pc1', 'c0001aw1-1') })).status, 200);
    await call('POST', '/runs/pc1/cycles/1/result', { cycleId: id, verdict: 'INCONCLUSIVE', inconclusive: ['POWER_LOSS_NOT_CONFIRMED'], needsRecovery: [] });
    assert.equal((await call('POST', '/runs/pc1/cycles/1/recovered', { cycleId: id, finalState: S })).status, 200);
    createRun(dir, { run: 'pc1b', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE, continues: 'pc1' });
    createRun(dir, { run: 'pc3', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    const original = fs.readFileSync(reg, 'utf8');
    const history = { s1: frozen('s1'), pc1: frozen('pc1') };
    const lines = original.trim().split('\n');
    const tampers = {
      deleted: () => fs.rmSync(reg),
      emptied: () => fs.writeFileSync(reg, ''),
      'truncated to its first entry': () => fs.writeFileSync(reg, `${lines[0]}\n`),
      'replaced by another registry': () => fs.writeFileSync(reg, `${JSON.stringify({ pgSystemId: X3, run: 'other', failureModel: 'HARNESS-SMOKE' })}\n`),
      'edited (a cluster id changed)': () => fs.writeFileSync(reg, `${original.replace(X2, X3)}`),
      'edited (an entry duplicated)': () => fs.writeFileSync(reg, `${original}${lines[0]}\n`),
      'damaged (a line is not a record)': () => fs.writeFileSync(reg, `${lines[0]}\nnot json\n`),
    };
    const refused = /^volume_registry_inconsistent/;
    for (const [how, tamper] of Object.entries(tampers)) {
      tamper();
      const tampered = fs.existsSync(reg) ? fs.readFileSync(reg, 'utf8') : null;
      assert.match((await claim('pc3', X2)).data.error, refused, `claim, registry ${how}`);
      assert.match((await claim('pc3', '7444444444444444444')).data.error, refused, `claim of an unseen cluster, registry ${how}`);
      assert.match((await callerFor(srv.base, dir, 'pc3')('POST', '/runs/pc3/volume-check', { pgSystemId: X2 })).data.error, refused, `volume-check, registry ${how}`);
      assert.match((await callerFor(srv.base, dir, 'pc1b')('POST', '/runs/pc1b/event', { kind: 'adopted', finalState: S, pgSystemId: X2 })).data.error, refused, `adopt, registry ${how}`);
      assert.match((await callerFor(srv.base, dir, 's1')('POST', '/runs/s1/cycles/1/start', { pgSystemId: X1, proc: 'a', workers: 1, dbHead: 0 })).data.error, refused, `start, registry ${how}`);
      assert.throws(() => createRun(dir, { run: 'pc9', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE }), /volume_registry_inconsistent/, `create-run, registry ${how}`);
      assert.throws(() => volumeOwner(dir, X2), /volume_registry_inconsistent/);
      assert.equal(fs.existsSync(reg) ? fs.readFileSync(reg, 'utf8') : null, tampered, `never rebuilt or repaired (${how})`);
      assert.ok(!fs.existsSync(runStore(dir, 'pc9').root) && !fs.existsSync(runStore(dir, 'pc9').keyFile), 'the refused run left nothing');
      fs.writeFileSync(reg, original); // the operator restores the original file
    }
    assert.equal(registryProblem(dir), null);
    assert.deepEqual({ s1: frozen('s1'), pc1: frozen('pc1') }, history, 'historical run records and acknowledgements are untouched');
  });

  test('an INCONCLUSIVE continuation keeps the series on its original volumes; nothing is re-registered or rewritten', async () => {
    const original = fs.readFileSync(reg, 'utf8');
    const history = frozen('pc1');
    const c = callerFor(srv.base, dir, 'pc1b');
    assert.equal((await c('POST', '/runs/pc1b/event', { kind: 'volume_claimed', volume: EMPTY(X3) })).data.error, 'continuing_run_uses_adopt');
    assert.equal((await c('POST', '/runs/pc1b/event', { kind: 'adopted', finalState: S, pgSystemId: X1 })).data.error, 'volume_differs_from_series', 'not the smoke volumes');
    assert.equal((await c('POST', '/runs/pc1b/event', { kind: 'adopted', finalState: { ...S, head: 4 }, pgSystemId: X2 })).data.error, 'state_differs_from_predecessor');
    assert.equal((await c('POST', '/runs/pc1b/event', { kind: 'adopted', finalState: S, pgSystemId: X2 })).status, 200);
    assert.equal((await c('POST', '/runs/pc1b/cycles/1/start', { pgSystemId: X3, proc: 'a', workers: 1, dbHead: 5 })).data.error, 'volume_differs_from_series');
    assert.equal((await c('POST', '/runs/pc1b/cycles/1/start', { pgSystemId: X2, proc: 'a', workers: 1, dbHead: 5 })).data.error, 'attestations_missing', 'right volumes; the new run still needs its own attestations');
    assert.equal(fs.readFileSync(reg, 'utf8'), original, 'the continuation registers nothing');
    assert.deepEqual([volumeOf(dir, 'pc1').pgSystemId, volumeOf(dir, 'pc1b')], [X2, null]);
    assert.deepEqual(frozen('pc1'), history, 'the original run\'s events, acknowledgements and results are unchanged');
    assert.equal(runStore(dir, 'pc1').acks(1).length, 1);
  });
});

describe('readiness record: a qualifying cycle starts only on the exact configuration a preflight recorded', () => {
  const dir = path.join(tmp, 'ready');
  let srv;
  const EMPTY = (id) => ({ pgSystemId: id, publicRelations: 0, stateEntries: 0, walLsnBytes: 25 * 1024 * 1024, serverVersion: '16.14' });
  const S = { installationId: 'inst-1', head: 3, headHash: '9a'.repeat(32) };
  const X = (n) => `75${String(n).padStart(17, '0')}`;
  // Decision B1: one process, one worker, one burst pattern. 10 burst seconds at 100/s in every 60, 20/s otherwise:
  // over 600 s that is (100 x 100 + 20 x 500) x 2 headroom = 40,000 actions.
  const B1 = { procs: 1, workers: 1, cycles: 20, maxSeconds: 600, headroom: 2, ratePerWorker: 100, targetRate: null, poolPerWorker: 40000, burstPeriodSeconds: 60, burstSeconds: 10, quietRate: 20 };
  const QB = (id, over = {}) => testBinding({ ...FACTS(id, 1), workload: B1, ...over });
  const W = (over) => ({ workload: { ...B1, ...over } });
  const post = (run, p, body) => callerFor(srv.base, dir, run)('POST', `/runs/${run}/${p}`, body);
  const attest = (run) => { for (const item of REQUIRED_ATTESTATIONS) runStore(dir, run).event({ cycle: null, kind: 'attestation', item, evidence: `done for ${run}`, attestation: 'operator' }); };
  const records = (run) => fs.readFileSync(path.join(runStore(dir, run).root, 'events.jsonl'), 'utf8').trim().split('\n').filter((l) => JSON.parse(l).kind === 'readiness');
  // Every start below states its own `readiness` half, so the helper's automatic "preflight" never runs here.
  const start = (run, id, over = {}, t = QB(id)) => post(run, 'cycles/1/start', { pgSystemId: id, proc: 'a', workers: 1, dbHead: 0, vet: true, readiness: t, ...over });
  /** claim, init, attest, then a real preflight record through the endpoint. */
  async function ready(run, id, o = {}) {
    createRun(dir, { run, failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE, ...o });
    assert.equal((await post(run, 'event', { kind: 'volume_claimed', volume: EMPTY(id) })).status, 200);
    assert.equal((await post(run, 'event', { kind: 'initialised', installationId: 'inst-1' })).status, 200);
    attest(run);
    const r = await post(run, 'readiness', { test: QB(id) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  }
  before(async () => { srv = await serve(dir); });
  after(() => srv.close());

  test('without a record a start is refused; the recorder records readiness only when it can confirm its own half', async () => {
    createRun(dir, { run: 'q1', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    assert.equal((await post('q1', 'readiness', { test: QB(X(1)) })).data.error, 'not_initialised');
    await post('q1', 'event', { kind: 'volume_claimed', volume: EMPTY(X(1)) });
    await post('q1', 'event', { kind: 'initialised', installationId: 'inst-1' });
    assert.equal((await post('q1', 'readiness', { test: QB(X(1)) })).data.error, 'attestations_missing');
    attest('q1');
    assert.equal((await start('q1', X(1))).data.error, 'readiness_missing', 'ready facts at start are not a record');
    const F = FACTS(X(1), 1);
    const bad = {
      'fsync, full_page_writes and synchronous_commit are not all on': { settings: { ...F.settings, fsync: 'off' } },
      'did not run in strict mode': { netcheck: { ...F.netcheck, strict: false } },
      'strict network check did not pass': { netcheck: { ...F.netcheck, ok: false } },
      'probed 1 bridge address\\(es\\), not 2': { netcheck: { ...F.netcheck, bridges: ['172.22.0.1'] } },
      'probed 0 bridge address': { netcheck: { ...F.netcheck, bridges: [] } },
      'network check has no probes': { netcheck: { ...F.netcheck, probes: [] } },
      'journal volume has no identity': { journal: { markerSha256: '', installationId: 'inst-1' } },
      'harness source digest is missing': { source: { sha256: '', files: 0 } },
      'runtime architecture is missing': { runtime: RT('', 'v22.0.0') },
      'runtime fingerprint is missing': { runtime: RT('x64', 'v22.0.0', '') },
      'workload: --workers must be a whole number': W({ workers: 0 }),
      'workload: pool 10 per worker is too small': W({ poolPerWorker: 10 }),
      'workload: ratePerWorker must be a positive number': W({ ratePerWorker: null }),
      'workload: pool must be a positive integer': W({ poolPerWorker: null }),
      // The burst pattern is part of the sizing: the pool must cover it, and it must stay inside the clearance envelope.
      'workload: pool 40000 per worker is too small: 100/s for 110 burst s and 20/s for 490 quiet s x 2 headroom needs 41600': W({ burstSeconds: 11 }),
      'workload: 1 process\\(es\\) x 1 worker\\(s\\) x 1220000 actions = 1220000 exceeds the 1000000': W({ ratePerWorker: 6000, poolPerWorker: 1220000 }),
      'workload: a burst pattern needs the burst period, the burst seconds and the quiet rate together': W({ quietRate: null }),
      'workload: the burst seconds must be shorter than the burst period': W({ burstSeconds: 60 }),
      'workload: the quiet rate must be below the burst rate': W({ quietRate: 100 }),
      'workload: the burst period, the burst seconds and the quiet rate must be positive numbers': W({ burstSeconds: 0 }),
      'workload: a burst pattern cannot be combined with a constant throttle': W({ targetRate: 100 }),
      // Decision B1, checked by the recorder: one process, one worker, with a burst pattern that fits before the cut.
      'workload: a qualifying series runs one process, not 2': W({ procs: 2 }),
      'workload: a qualifying series runs one worker, not 2': W({ workers: 2 }),
      'workload: a qualifying series runs one process, not 2; a qualifying series runs one worker, not 4': W({ procs: 2, workers: 4 }),
      'workload: a qualifying series needs a burst pattern': W({ burstPeriodSeconds: null, burstSeconds: null, quietRate: null, poolPerWorker: 120000 }),
      'workload: the burst period is longer than the time to the cut': W({ burstPeriodSeconds: 700 }),
    };
    for (const [why, over] of Object.entries(bad)) assert.match((await post('q1', 'readiness', { test: QB(X(1), over) })).data.error, new RegExp(`^readiness_not_ready: .*${why}`), why);
    for (const junk of [undefined, null, 'READY', { status: 'READY_FOR_OPERATOR_REVIEW' }, []]) assert.match((await post('q1', 'readiness', { test: junk })).data.error, /^readiness_not_ready/, 'a bare claim of readiness is nothing');
    // What runs: the same source as the recorder's own copy, in an image of the declared architecture.
    assert.equal((await post('q1', 'readiness', { test: QB(X(1), { source: { sha256: 'ab'.repeat(32), files: SOURCE.files } }) })).data.error, 'source_differs_from_the_recorder');
    assert.equal((await post('q1', 'readiness', { test: QB(X(1), { source: { sha256: SOURCE.sha256, files: SOURCE.files + 1 } }) })).data.error, 'source_differs_from_the_recorder');
    assert.equal((await post('q1', 'readiness', { test: QB(X(1), { runtime: RT('arm64', 'v22.0.0') }) })).data.error, 'image_architecture_differs_from_declared');
    assert.equal((await post('q1', 'readiness', { test: QB(X(9)) })).data.error, 'volume_differs_from_series');
    assert.equal(records('q1').length, 0, 'no refused attempt left a record');
    const rec = (await post('q1', 'readiness', { test: QB(X(1)) })).data;
    assert.match(rec.digest, /^[0-9a-f]{64}$/);
    const ev = runStore(dir, 'q1').events().filter((e) => e.kind === 'readiness');
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0].binding.recorder.run, ev[0].binding.recorder.failureModel, ev[0].binding.recorder.recorderId, ev[0].binding.test.pgSystemId], ['q1', 'POWER-CUT', recorderId(dir), X(1)]);
    assert.deepEqual(ev[0].binding.recorder.attestations.items, [...REQUIRED_ATTESTATIONS].sort());
    assert.deepEqual(ev[0].binding.recorder.identity, { ...IDENTITY, sourceTreeSha256: SOURCE.sha256 }, 'the declared commit, package checksum, image id and architecture are bound, with the source digest that was verified at create-run');
    assert.deepEqual(ev[0].binding.test.source, { treeSha256: SOURCE.sha256, files: SOURCE.files });
    assert.deepEqual(ev[0].binding.test.workload, B1, 'the complete workload, burst pattern included');
    assert.equal(ev[0].digest, digestOf(ev[0].binding));
    const status = (await callerFor(srv.base, dir, 'q1')('GET', '/runs/q1')).data;
    assert.deepEqual([status.readiness.digest, status.readiness.workload], [rec.digest, B1]);
    assert.deepEqual((await start('q1', X(1))).data, { vetted: true });
    assert.match((await start('q1', X(1), { vet: undefined })).data.cycleId, /^[0-9a-f]{32}$/);
    assert.equal(runStore(dir, 'q1').events().find((e) => e.kind === 'cycle_start').bindingDigest, rec.digest, 'the cycle records which readiness record it started under');
    assert.equal((await post('q1', 'readiness', { test: QB(X(1)) })).data.error, 'readiness_only_before_the_first_cycle');
  });

  test('any change to the bound configuration is refused at the start, naming what changed; undoing the change restores it', async () => {
    await ready('q2', X(2));
    const stale = async (over, paths, body = {}) => {
      const r = await start('q2', X(2), body, QB(X(2), over));
      assert.match(r.data.error ?? 'accepted', new RegExp(`^readiness_stale: ${paths}$`), JSON.stringify(over));
      assert.deepEqual((await start('q2', X(2))).data, { vetted: true }, 'the recorded configuration is still accepted');
    };
    const F = FACTS(X(2), 1);
    await stale({ journal: { markerSha256: 'bb'.repeat(32), installationId: 'inst-1' } }, 'test.journal.markerSha256');
    await stale({ journal: { markerSha256: 'aa'.repeat(32), installationId: 'inst-2' } }, 'test.journal.installationId');
    await stale({ settings: { ...F.settings, wal_sync_method: 'open_datasync' } }, 'test.postgresql.digest, test.postgresql.settings.wal_sync_method');
    await stale({ settings: { ...F.settings, server_version: '16.15' } }, 'test.postgresql.digest, test.postgresql.settings.server_version');
    await stale({ settings: { ...F.settings, data_checksums: 'on' } }, 'test.postgresql.digest, test.postgresql.settings.data_checksums');
    await stale({ netcheck: { ...F.netcheck, bridges: ['172.22.0.1', '172.29.0.1'], probes: [{ name: 'host or bridge 172.22.0.1:22' }, { name: 'host or bridge 172.29.0.1:22' }] } }, 'test.firewall.bridges, test.firewall.digest');
    await stale({ netcheck: { ...F.netcheck, probes: [...F.netcheck.probes, { name: 'one more destination' }] } }, 'test.firewall.digest, test.firewall.probes');
    await stale({ runtime: RT('x64', 'v22.9.9') }, 'test.runtime.node');
    await stale({ runtime: RT('x64', 'v22.0.0', 'ab'.repeat(32)) }, 'test.runtime.fingerprint'); // another Node binary or other installed dependencies
    // The complete workload is enforced, field by field: not only the worker count.
    await stale(W({ maxSeconds: 599 }), 'test.workload.maxSeconds');
    await stale(W({ headroom: 2.5, poolPerWorker: 50000 }), 'test.workload.headroom, test.workload.poolPerWorker');
    await stale(W({ ratePerWorker: 99 }), 'test.workload.ratePerWorker');
    await stale(W({ poolPerWorker: 40001 }), 'test.workload.poolPerWorker');
    await stale(W({ burstPeriodSeconds: 120 }), 'test.workload.burstPeriodSeconds');
    await stale(W({ burstSeconds: 9 }), 'test.workload.burstSeconds');
    await stale(W({ quietRate: 19 }), 'test.workload.quietRate');
    await stale(W({ burstPeriodSeconds: null, burstSeconds: null, quietRate: null, poolPerWorker: 120000 }), 'test.workload.burstPeriodSeconds, test.workload.burstSeconds, test.workload.poolPerWorker, test.workload.quietRate');
    await stale(W({ procs: 2 }), 'test.workload.procs');
    await stale(W({ workers: 3 }), 'test.workload.workers', { workers: 3 });
    // A configuration that is no longer ready at all is refused as such, whatever the record says.
    assert.match((await start('q2', X(2), {}, QB(X(2), { settings: { ...F.settings, synchronous_commit: 'off' } }))).data.error, /^readiness_not_ready: fsync/);
    assert.match((await start('q2', X(2), {}, QB(X(2), { netcheck: { ...F.netcheck, ok: false } }))).data.error, /^readiness_not_ready: the strict network check did not pass/);
    assert.match((await start('q2', X(2), {}, QB(X(2), W({ targetRate: 100 })))).data.error, /^readiness_not_ready: workload: a burst pattern cannot be combined/);
    assert.match((await post('q2', 'cycles/1/start', { pgSystemId: X(2), proc: 'a', workers: 1, dbHead: 0, vet: true, readiness: null })).data.error, /^readiness_not_ready/, 'a start that reports nothing is refused');
    assert.equal((await start('q2', X(9), {}, QB(X(9)))).data.error, 'volume_differs_from_series', 'another database cluster');
    // Other code than the recorder's own copy, or an image of another architecture, never starts a cycle.
    assert.equal((await start('q2', X(2), {}, QB(X(2), { source: { sha256: 'ab'.repeat(32), files: SOURCE.files } }))).data.error, 'source_differs_from_the_recorder');
    assert.equal((await start('q2', X(2), {}, QB(X(2), { runtime: RT('arm64', 'v22.0.0') }))).data.error, 'image_architecture_differs_from_declared');
    // The start itself must be the recorded workload: one worker, and only process a.
    assert.equal((await start('q2', X(2), { workers: 2 })).data.error, 'start_differs_from_ready_workload');
    assert.equal((await start('q2', X(2), { proc: 'b' })).data.error, 'start_differs_from_ready_workload', 'one process was recorded');

    // The recorder's own half. Each file is put back afterwards (a test may; an operator restores from the backup).
    const edit = async (file, change, expected) => {
      const original = fs.readFileSync(file);
      fs.writeFileSync(file, change(original.toString()));
      assert.match((await start('q2', X(2))).data.error ?? 'accepted', new RegExp(`^${expected}$`), file);
      fs.writeFileSync(file, original);
      assert.deepEqual((await start('q2', X(2))).data, { vetted: true }, 'restored');
    };
    const runJson = path.join(runStore(dir, 'q2').root, 'run.json');
    await edit(path.join(dir, 'recorder-id.json'), (t) => t.replace(/"id": "[0-9a-f]{4}/, '"id": "0000'), 'readiness_stale: recorder.recorderId');
    await edit(runJson, (t) => t.replace(STORAGE.firmware, 'OTHERFW1'), 'readiness_stale: recorder.storageDigest');
    await edit(path.join(dir, 'volumes.jsonl'), (t) => t.replace(/"at":"(\d{4})/, '"at":"1999'), 'readiness_stale: recorder.registry.sha256');
    // The declared identity is in the run's write-once record: another commit, package or image is another configuration.
    await edit(runJson, (t) => t.replace(IDENTITY.sourceCommit, '11'.repeat(20)), 'readiness_stale: recorder.identity.sourceCommit');
    await edit(runJson, (t) => t.replace(IDENTITY.packageSha256, '22'.repeat(32)), 'readiness_stale: recorder.identity.packageSha256');
    await edit(runJson, (t) => t.replace(IDENTITY.imageId, `sha256:${'33'.repeat(32)}`), 'readiness_stale: recorder.identity.imageId');
    await edit(runJson, (t) => t.replace('"imageArch": "amd64"', '"imageArch": "arm64"'), 'image_architecture_differs_from_declared');
    await edit(runJson, (t) => t.replace(IDENTITY.imageId, ''), 'identity_missing');
    // Creating another run on this recorder does not touch the registry, so the record stays valid.
    createRun(dir, { run: 'q2-beside', failureModel: 'HARNESS-SMOKE' });
    assert.deepEqual((await start('q2', X(2))).data, { vetted: true }, 'creating a run does not touch the registry');
    // An attestation recorded again (even the same words) is a change: what was attested is part of the record. And
    // the record is never replaced, so this ends the run's validity for good.
    const before = records('q2');
    runStore(dir, 'q2').event({ cycle: null, kind: 'attestation', item: 'firewall-verified-on-host', evidence: 'done for q2', attestation: 'operator' });
    assert.equal((await start('q2', X(2))).data.error, 'readiness_stale: recorder.attestations.digest');
    assert.equal((await post('q2', 'readiness', { test: QB(X(2)) })).data.error, 'readiness_already_recorded: recorder.attestations.digest');
    // The registry is bound byte for byte: any later claim on this recorder, by any run, does the same.
    createRun(dir, { run: 'q2-smoke', failureModel: 'HARNESS-SMOKE' });
    assert.equal((await post('q2-smoke', 'event', { kind: 'volume_claimed', volume: EMPTY(X(20)) })).status, 200);
    assert.equal((await start('q2', X(2))).data.error, 'readiness_stale: recorder.attestations.digest, recorder.registry.bytes, recorder.registry.sha256');
    assert.deepEqual(records('q2'), before, 'the record itself was never touched');
  });

  test('the first accepted readiness record is immutable: another preflight never replaces the workload or the configuration', async () => {
    const first = await ready('q5', X(5));
    const line = records('q5');
    assert.equal(line.length, 1);
    // The same configuration again is confirmed, and nothing is written.
    const same = await post('q5', 'readiness', { test: QB(X(5)) });
    assert.deepEqual([same.status, same.data.digest, same.data.unchanged], [200, first.digest, true]);
    assert.deepEqual(records('q5'), line);
    // Every workload field, changed to another value that would be acceptable on its own: refused, with the field named.
    const changes = {
      maxSeconds: [W({ maxSeconds: 599 }), 'test.workload.maxSeconds'],
      headroom: [W({ headroom: 2.5, poolPerWorker: 50000 }), 'test.workload.headroom, test.workload.poolPerWorker'],
      ratePerWorker: [W({ ratePerWorker: 99 }), 'test.workload.ratePerWorker'],
      poolPerWorker: [W({ poolPerWorker: 40001 }), 'test.workload.poolPerWorker'],
      burstPeriodSeconds: [W({ burstPeriodSeconds: 120 }), 'test.workload.burstPeriodSeconds'],
      burstSeconds: [W({ burstSeconds: 9 }), 'test.workload.burstSeconds'],
      quietRate: [W({ quietRate: 19 }), 'test.workload.quietRate'],
    };
    for (const [field, [over, paths]] of Object.entries(changes)) {
      assert.equal((await post('q5', 'readiness', { test: QB(X(5), over) })).data.error, `readiness_already_recorded: ${paths}`, field);
      assert.deepEqual(records('q5'), line, `${field}: the original record is unchanged`);
    }
    // The fields decision B1 fixes can't even be proposed; a throttle can't be added to a burst workload.
    for (const over of [W({ procs: 2 }), W({ workers: 2 }), W({ targetRate: 100 }), W({ burstPeriodSeconds: null, burstSeconds: null, quietRate: null, poolPerWorker: 120000 })]) {
      assert.match((await post('q5', 'readiness', { test: QB(X(5), over) })).data.error, /^readiness_not_ready: workload: /);
    }
    // The rest of the configuration is just as fixed.
    assert.equal((await post('q5', 'readiness', { test: QB(X(5), { settings: { ...FACTS().settings, wal_sync_method: 'open_datasync' } }) })).data.error, 'readiness_already_recorded: test.postgresql.digest, test.postgresql.settings.wal_sync_method');
    assert.equal((await post('q5', 'readiness', { test: QB(X(5), { runtime: RT('x64', 'v23.0.0') }) })).data.error, 'readiness_already_recorded: test.runtime.node');
    assert.deepEqual(records('q5'), line);
    assert.equal((await callerFor(srv.base, dir, 'q5')('GET', '/runs/q5')).data.readiness.digest, first.digest);
    // A second record written into the ledger by hand changes nothing either: the first one is the run's record.
    const forged = { test: QB(X(5), W({ quietRate: 5 })), recorder: recorderBindingOf(dir, 'q5') };
    runStore(dir, 'q5').event({ cycle: null, kind: 'readiness', binding: forged, digest: digestOf(forged) });
    assert.equal((await callerFor(srv.base, dir, 'q5')('GET', '/runs/q5')).data.readiness.workload.quietRate, 20);
    assert.equal((await start('q5', X(5), {}, QB(X(5), W({ quietRate: 5 })))).data.error, 'readiness_stale: test.workload.quietRate');
    assert.deepEqual((await start('q5', X(5))).data, { vetted: true }, 'the original configuration still starts');
    // The operator command that would invalidate the record is refused instead.
    const cli = fileURLToPath(new URL('../recorder.mjs', import.meta.url));
    const again = spawnSync(process.execPath, [cli, 'attest', '--dir', dir, '--run', 'q5', '--item', REQUIRED_ATTESTATIONS[0], '--evidence', 'again'], { encoding: 'utf8' });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already has its readiness record/);
    assert.deepEqual((await start('q5', X(5))).data, { vetted: true });
  });

  test('a record is never usable by another run, on another volume, or by the run that continues the series', async () => {
    const r3 = await ready('q3', X(3));
    const event3 = records('q3')[0];
    const id = (await start('q3', X(3), { vet: undefined })).data.cycleId; // q3's first cycle, before anything else claims volumes here
    // q4: initialised and attested on its own volumes, but never made ready.
    createRun(dir, { run: 'q4', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    await post('q4', 'event', { kind: 'volume_claimed', volume: EMPTY(X(4)) });
    await post('q4', 'event', { kind: 'initialised', installationId: 'inst-1' });
    attest('q4');
    assert.equal((await start('q4', X(4))).data.error, 'readiness_missing', 'q3 being ready says nothing about q4');
    assert.equal((await callerFor(srv.base, dir, 'q4', keyOf(dir, 'q3'))('POST', '/runs/q4/readiness', { test: QB(X(4)) })).status, 401, 'q3\'s key cannot record for q4');
    assert.equal((await post('q4', 'readiness', { test: QB(X(3)) })).data.error, 'volume_differs_from_series', 'q4 cannot be made ready on q3\'s volumes');
    // Someone copies q3's record into q4's ledger by hand: it names q3 and q3's volumes, so it never matches. It is
    // now q4's first record, so q4 can never be made ready either: fail closed.
    fs.appendFileSync(path.join(runStore(dir, 'q4').root, 'events.jsonl'), `${event3}\n`);
    assert.match((await start('q4', X(4))).data.error, /^readiness_stale: .*recorder\.run.*test\.pgSystemId/);
    assert.equal((await start('q4', X(3), {}, QB(X(3)))).data.error, 'volume_differs_from_series');
    assert.match((await post('q4', 'readiness', { test: QB(X(4)) })).data.error, /^readiness_already_recorded: /);

    // q3's cycle ends INCONCLUSIVE; q3b continues the same volumes. It needs its own attestations and its own record.
    await post('q3', 'cycles/1/result', { cycleId: id, verdict: 'INCONCLUSIVE', inconclusive: ['POWER_LOSS_NOT_CONFIRMED'], needsRecovery: [] });
    assert.equal((await post('q3', 'cycles/1/recovered', { cycleId: id, finalState: S })).status, 200);
    createRun(dir, { run: 'q3b', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE, continues: 'q3' });
    assert.equal((await post('q3b', 'readiness', { test: QB(X(3)) })).data.error, 'not_adopted');
    assert.equal((await post('q3b', 'event', { kind: 'adopted', finalState: S, pgSystemId: X(3) })).status, 200);
    assert.equal((await post('q3b', 'readiness', { test: QB(X(3)) })).data.error, 'attestations_missing');
    attest('q3b');
    const next = (over) => post('q3b', 'cycles/1/start', { pgSystemId: X(3), proc: 'a', workers: 1, dbHead: 3, vet: true, readiness: QB(X(3)), ...over });
    assert.equal((await next()).data.error, 'readiness_missing', 'same volumes, same configuration, another run');
    const own = await post('q3b', 'readiness', { test: QB(X(3)) });
    assert.equal(own.status, 200);
    assert.notEqual(own.data.digest, r3.digest);
    assert.deepEqual([own.data.binding.recorder.run, own.data.binding.recorder.rootRun, own.data.binding.recorder.continues], ['q3b', 'q3', 'q3']);
    assert.deepEqual((await next()).data, { vetted: true });
    // q3's record appended after q3b's own changes nothing: the first record is the run's record.
    fs.appendFileSync(path.join(runStore(dir, 'q3b').root, 'events.jsonl'), `${event3}\n`);
    assert.deepEqual((await next()).data, { vetted: true });
  });

  test('a continuing run whose FIRST record is its predecessor\'s, copied in by hand, never starts: the record names the other run', async () => {
    await ready('q6', X(16));
    const event6 = records('q6')[0];
    const id = (await start('q6', X(16), { vet: undefined })).data.cycleId;
    await post('q6', 'cycles/1/result', { cycleId: id, verdict: 'INCONCLUSIVE', inconclusive: ['POWER_LOSS_NOT_CONFIRMED'], needsRecovery: [] });
    assert.equal((await post('q6', 'cycles/1/recovered', { cycleId: id, finalState: S })).status, 200);
    createRun(dir, { run: 'q6b', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE, continues: 'q6' });
    assert.equal((await post('q6b', 'event', { kind: 'adopted', finalState: S, pgSystemId: X(16) })).status, 200);
    attest('q6b');
    fs.appendFileSync(path.join(runStore(dir, 'q6b').root, 'events.jsonl'), `${event6}\n`);
    const next = () => post('q6b', 'cycles/1/start', { pgSystemId: X(16), proc: 'a', workers: 1, dbHead: 3, vet: true, readiness: QB(X(16)) });
    assert.match((await next()).data.error, /^readiness_stale: .*recorder\.continues.*recorder\.run/, 'same volumes and configuration, but the record is q6\'s');
    // The record is never replaced, so q6b can never be made ready: fail closed.
    assert.match((await post('q6b', 'readiness', { test: QB(X(16)) })).data.error, /^readiness_already_recorded: /);
  });

  test('readiness is for POWER-CUT runs; other run types start without it and only note the binding they ran on', async () => {
    createRun(dir, { run: 'sm', failureModel: 'HARNESS-SMOKE' });
    await post('sm', 'event', { kind: 'volume_claimed', volume: EMPTY(X(6)) });
    await post('sm', 'event', { kind: 'initialised', installationId: 'inst-1' });
    assert.equal((await post('sm', 'readiness', { test: QB(X(6)) })).data.error, 'readiness_is_for_power_cut_runs');
    assert.match((await post('sm', 'cycles/1/start', { pgSystemId: X(6), proc: 'a', workers: 1, dbHead: 0, readiness: QB(X(6)) })).data.cycleId, /^[0-9a-f]{32}$/);
    assert.match((await post('sm', 'cycles/1/start', { pgSystemId: X(6), proc: 'b', workers: 1, dbHead: 0, readiness: null })).data.cycleId, /^[0-9a-f]{32}$/);
    const starts = runStore(dir, 'sm').events().filter((e) => e.kind === 'cycle_start');
    assert.match(starts[0].bindingDigest, /^unenforced:[0-9a-f]{64}$/);
    assert.deepEqual(starts[0].bindingNoted, QB(X(6)), 'the reported half is kept, burst pattern included, so a rehearsal shows which field moved');
    assert.equal(starts[1].bindingDigest, null);
  });
});

describe('recorder identity', () => {
  test('written once with the first run; a directory that has runs but no identity gets none and cannot hold a qualifying run', async () => {
    const dir = path.join(tmp, 'identity');
    assert.equal(recorderId(dir), null);
    createRun(dir, { run: 'i1', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    const id = recorderId(dir);
    assert.match(id, /^[0-9a-f]{32}$/);
    const bytes = fs.readFileSync(path.join(dir, 'recorder-id.json'), 'utf8');
    createRun(dir, { run: 'i2', failureModel: 'HARNESS-SMOKE' });
    assert.equal(fs.readFileSync(path.join(dir, 'recorder-id.json'), 'utf8'), bytes, 'never rewritten');
    registerVolume(dir, { pgSystemId: pg('i1'), run: 'i1', failureModel: 'POWER-CUT' });
    const st = runStore(dir, 'i1');
    st.event({ cycle: null, kind: 'initialised', detail: 'test' });
    for (const item of REQUIRED_ATTESTATIONS) st.event({ cycle: null, kind: 'attestation', item, evidence: 'test', attestation: 'operator' });
    makeReady(dir, 'i1', 1);
    const srv = await serve(dir);
    const go = (readiness = TB(pg('i1'), 1)) => callerFor(srv.base, dir, 'i1')('POST', '/runs/i1/cycles/1/start', { pgSystemId: pg('i1'), proc: 'a', workers: 1, dbHead: 0, vet: true, readiness });
    assert.deepEqual((await go()).data, { vetted: true });
    fs.rmSync(path.join(dir, 'recorder-id.json')); // the identity is lost (or this is a copy made without it)
    assert.equal((await go()).data.error, 'readiness_stale: recorder.recorderId');
    assert.equal((await callerFor(srv.base, dir, 'i1')('POST', '/runs/i1/readiness', { test: TB(pg('i1'), 1) })).data.error, 'recorder_identity_missing');
    assert.throws(() => createRun(dir, { run: 'i3', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE }), /holds runs but has no identity/);
    // The run-type and storage refusals keep their own messages there (the development smoke directory is such a directory).
    assert.throws(() => createRun(dir, { run: 'i3', failureModel: 'POWER-CUT' }), /driveModel is missing/);
    assert.throws(() => createRun(dir, { run: 'i3', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE, continues: 'i2' }), /POWER-CUT run cannot continue HARNESS-SMOKE state/);
    assert.ok(!fs.existsSync(runStore(dir, 'i3').root) && !fs.existsSync(runStore(dir, 'i3').keyFile));
    createRun(dir, { run: 'i4', failureModel: 'HARNESS-SMOKE' });
    assert.equal(recorderId(dir), null, 'no new identity is invented for a directory with history');
    await srv.close();
  });
});

describe('the recorder directory: one for the whole experiment, never created or replaced by accident', () => {
  const cli = fileURLToPath(new URL('../recorder.mjs', import.meta.url));
  const run = (dir, ...args) => spawnSync(process.execPath, [cli, ...args, '--dir', dir], { encoding: 'utf8', timeout: 20_000 });
  const live = path.join(tmp, 'expdir');

  test('a missing or empty directory is refused by every command unless a new recorder is asked for explicitly', () => {
    for (const d of [path.join(tmp, 'nowhere'), fs.mkdtempSync(path.join(tmp, 'emptydir-'))]) {
      for (const args of [['create-run', '--run', 'x1', '--failure-model', 'HARNESS-SMOKE'], ['serve', '--port', '0'], ['status', '--run', 'x1'], ['attest', '--run', 'x1', '--item', REQUIRED_ATTESTATIONS[0], '--evidence', 'e']]) {
        const r = run(d, ...args);
        assert.equal(r.status, 1, args[0]);
        assert.match(r.stderr, /recorder directory .* is (missing|empty)\. If it should hold this experiment's runs, STOP/);
      }
      assert.ok(['missing', 'empty'].includes(dirState(d)), 'nothing was created');
      assert.equal(run(d, 'verify-dir').status, 1);
      assert.match(dirReport(d).problems[0], /STOP; it has no history/);
    }
    assert.equal(run(live, 'create-run', '--new-directory', '--run', 'e1', '--failure-model', 'HARNESS-SMOKE').status, 0);
    assert.equal(dirState(live), 'recorder');
    assert.match(run(live, 'create-run', '--new-directory', '--run', 'e2', '--failure-model', 'HARNESS-SMOKE').stderr, /--new-directory, but .* already holds a recorder/);
    assert.equal(run(live, 'create-run', '--run', 'e2', '--failure-model', 'HARNESS-SMOKE').status, 0);
  });

  test('verify-dir: identity, registry and keys; an exact backup; later, a live directory that has only grown', () => {
    registerVolume(live, { pgSystemId: '7999999999999999991', run: 'e1', failureModel: 'HARNESS-SMOKE' });
    runStore(live, 'e1').event({ cycle: null, kind: 'volume_claimed', pgSystemId: '7999999999999999991' });
    const ok = JSON.parse(run(live, 'verify-dir').stdout);
    assert.deepEqual([ok.state, ok.runs, ok.registry.entries, ok.problems], ['recorder', 2, 1, []]);
    assert.equal(ok.recorderId, recorderId(live));
    const backup = path.join(tmp, 'expdir-backup');
    fs.cpSync(live, backup, { recursive: true });
    const exact = run(live, 'verify-dir', '--backup', backup);
    assert.equal(exact.status, 0, exact.stdout);
    assert.deepEqual(JSON.parse(exact.stdout).backup.problems, []);
    assert.ok(!exact.stdout.includes(fs.readFileSync(runStore(live, 'e1').keyFile, 'utf8').trim()), 'no key is printed');
    // The experiment goes on: a ledger grows and a new run appears. The backup is no longer exact, but nothing was rewritten.
    runStore(live, 'e1').event({ cycle: null, kind: 'netcheck', detail: 'later' });
    createRun(live, { run: 'e3', failureModel: 'HARNESS-SMOKE' });
    assert.equal(run(live, 'verify-dir', '--backup', backup).status, 1, 'no longer an exact copy');
    assert.equal(run(live, 'verify-dir', '--backup', backup, '--allow-growth').status, 0);
    assert.ok(compareBackup(live, backup, { allowGrowth: true }).newerFiles >= 2);
    // History rewritten, a file lost, the registry or the identity replaced: each is reported, in both modes.
    const damage = {
      'events.jsonl: differs from the backup \\(earlier records were changed': () => { const f = path.join(runStore(live, 'e1').root, 'events.jsonl'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('volume_claimed', 'volume_claimeD')); },
      'run.json: differs from the backup': () => { const f = path.join(runStore(live, 'e1').root, 'run.json'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('HARNESS-SMOKE', 'POWER-CUT')); },
      'volumes.jsonl: in the backup, missing from the live directory': () => fs.rmSync(path.join(live, 'volumes.jsonl')),
      'recorder-id.json: differs from the backup': () => fs.writeFileSync(path.join(live, 'recorder-id.json'), JSON.stringify({ id: '0'.repeat(32) })),
      'keys/e1.key: in the backup, missing': () => fs.rmSync(runStore(live, 'e1').keyFile),
    };
    for (const [expected, change] of Object.entries(damage)) {
      const saved = path.join(tmp, 'expdir-saved');
      fs.cpSync(live, saved, { recursive: true });
      change();
      const r = run(live, 'verify-dir', '--backup', backup, '--allow-growth');
      assert.equal(r.status, 1, expected);
      assert.match(JSON.stringify(JSON.parse(r.stdout)), new RegExp(expected));
      fs.rmSync(live, { recursive: true }); fs.cpSync(saved, live, { recursive: true }); fs.rmSync(saved, { recursive: true });
    }
    assert.equal(run(live, 'verify-dir', '--backup', backup, '--allow-growth').status, 0);
    assert.match(compareBackup(live, path.join(tmp, 'no-backup')).problems[0], /backup is empty or missing/);
    // The directory replaced by a new, empty one: there is nothing to verify against, and nothing may start on it.
    const replaced = fs.mkdtempSync(path.join(tmp, 'replaced-'));
    assert.equal(run(replaced, 'verify-dir', '--backup', backup).status, 1);
  });
});

describe('abandon: a failed or uncertain init fails closed, and nothing is removed or reset', () => {
  const dir = path.join(tmp, 'abandon');
  const cli = fileURLToPath(new URL('../recorder.mjs', import.meta.url));
  let srv;
  const EMPTY = (id) => ({ pgSystemId: id, publicRelations: 0, stateEntries: 0, walLsnBytes: 25 * 1024 * 1024, serverVersion: '16.14' });
  const X = (n) => `76${String(n).padStart(17, '0')}`;
  const post = (run, p, body) => callerFor(srv.base, dir, run)('POST', `/runs/${run}/${p}`, body);
  const snapshot = () => fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort();
  before(async () => { srv = await serve(dir); });
  after(() => srv.close());

  test('an init that failed after the claim: the volumes and the run id are used up, and abandoning changes neither', async () => {
    createRun(dir, { run: 'fq1', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    assert.equal((await post('fq1', 'event', { kind: 'volume_claimed', volume: EMPTY(X(1)) })).status, 200); // init stops here
    // Already fail closed before any operator action: no retry on these volumes, by this run or any other.
    assert.equal((await post('fq1', 'event', { kind: 'volume_claimed', volume: EMPTY(X(1)) })).data.error, 'already_claimed');
    createRun(dir, { run: 'fq2', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    assert.equal((await post('fq2', 'event', { kind: 'volume_claimed', volume: EMPTY(X(1)) })).data.error, 'volume_already_used_by_fq1');
    assert.equal((await post('fq1', 'cycles/1/start', { pgSystemId: X(1), proc: 'a', workers: 1, dbHead: 0, vet: true, readiness: TB(X(1), 1) })).data.error, 'not_initialised');

    const files = snapshot(), registry = fs.readFileSync(path.join(dir, 'volumes.jsonl'));
    const r = spawnSync(process.execPath, [cli, 'abandon', '--dir', dir, '--run', 'fq1', '--reason', 'init failed after the claim; output kept in evidence'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Nothing was removed/);
    const st = (await callerFor(srv.base, dir, 'fq1')('GET', '/runs/fq1')).data;
    assert.deepEqual([st.stopped.kind, st.cyclesStarted, st.readiness], ['abandoned', 0, null]);
    // Nothing was removed or reset: the same files plus the stop marker, the registry byte for byte, the claim still fq1's.
    assert.deepEqual(snapshot(), [...files, path.join('runs', 'fq1', 'STOPPED.json')].sort());
    assert.ok(fs.readFileSync(path.join(dir, 'volumes.jsonl')).equals(registry));
    assert.equal(volumeOwner(dir, X(1)).run, 'fq1');
    assert.equal(registryProblem(dir), null);
    assert.ok(runStore(dir, 'fq1').events().some((e) => e.kind === 'abandoned' && e.attestation === 'operator'));
    // And nothing can be done with the run any more.
    for (const [p, body] of [['event', { kind: 'initialised', installationId: 'inst-1' }], ['event', { kind: 'volume_claimed', volume: EMPTY(X(7)) }], ['readiness', { test: TB(X(1), 1) }], ['cycles/1/start', { pgSystemId: X(1), proc: 'a', workers: 1, dbHead: 0, vet: true, readiness: TB(X(1), 1) }]]) {
      assert.equal((await post('fq1', p, body)).data.error, 'run_stopped', p);
    }
    assert.throws(() => createRun(dir, { run: 'fq1', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE }), /run already exists/, 'the run id is never reused');
    assert.throws(() => createRun(dir, { run: 'fq1b', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE, continues: 'fq1' }), /refused/, 'an abandoned run is never continued');
    assert.throws(() => abandonRun(runStore(dir, 'fq1'), 'again'), /already stopped \(abandoned\)/);
    // The volumes stay unusable for every other run, as before.
    assert.equal((await post('fq2', 'event', { kind: 'volume_claimed', volume: EMPTY(X(1)) })).data.error, 'volume_already_used_by_fq1');
  });

  test('an uncertain init before any claim can be abandoned too; a run that started a cycle cannot; a reason is required', async () => {
    createRun(dir, { run: 'fq3', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    assert.throws(() => abandonRun(runStore(dir, 'fq3'), '  '), /--reason is required/);
    abandonRun(runStore(dir, 'fq3'), 'init outcome unknown: the command was interrupted');
    assert.equal((await post('fq3', 'event', { kind: 'volume_claimed', volume: EMPTY(X(3)) })).data.error, 'run_stopped');
    assert.equal(volumeOwner(dir, X(3)), null, 'nothing was claimed for it');
    // The run id is spent, but volumes that were never claimed are still new: after review, another run may claim them.
    assert.equal((await post('fq2', 'event', { kind: 'volume_claimed', volume: EMPTY(X(3)) })).status, 200);
    createRun(dir, { run: 'fsm', failureModel: 'HARNESS-SMOKE' });
    await post('fsm', 'event', { kind: 'volume_claimed', volume: EMPTY(X(4)) });
    await post('fsm', 'event', { kind: 'initialised', installationId: 'inst-1' });
    assert.match((await post('fsm', 'cycles/1/start', { pgSystemId: X(4), proc: 'a', workers: 1, dbHead: 0, readiness: null })).data.cycleId, /^[0-9a-f]{32}$/);
    assert.throws(() => abandonRun(runStore(dir, 'fsm'), 'no'), /has started a cycle/);
    assert.equal(runStore(dir, 'fsm').stopped(), null);
  });
});

describe('recorder directory guards: leftovers are not a new directory, and a backup must be another directory', () => {
  const cli = fileURLToPath(new URL('../recorder.mjs', import.meta.url));
  const run = (dir, ...args) => spawnSync(process.execPath, [cli, ...args, '--dir', dir], { encoding: 'utf8', timeout: 20_000 });

  test('a registry or keys without runs and identity is damaged: nothing starts there, not even with --new-directory', () => {
    const d = fs.mkdtempSync(path.join(tmp, 'leftover-'));
    fs.writeFileSync(path.join(d, '.DS_Store'), '');
    fs.writeFileSync(path.join(d, 'rejections.jsonl'), '');
    fs.mkdirSync(path.join(d, 'runs'));
    assert.equal(dirState(d), 'empty', 'a dot file, the rejection log and an empty runs directory are not history');
    fs.writeFileSync(path.join(d, 'volumes.jsonl'), '{"pgSystemId":"7999999999999999992","run":"gone","failureModel":"POWER-CUT"}\n');
    assert.equal(dirState(d), 'damaged');
    for (const args of [['create-run', '--new-directory', '--run', 'n1', '--failure-model', 'HARNESS-SMOKE'], ['serve', '--new-directory', '--port', '0'], ['create-run', '--run', 'n1', '--failure-model', 'HARNESS-SMOKE']]) {
      const r = run(d, ...args);
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, /history was removed\. STOP/);
    }
    assert.equal(run(d, 'verify-dir').status, 1);
    assert.deepEqual(fs.readdirSync(d).sort(), ['.DS_Store', 'rejections.jsonl', 'runs', 'volumes.jsonl'], 'nothing was created or removed');
    const k = fs.mkdtempSync(path.join(tmp, 'leftover-keys-'));
    fs.mkdirSync(path.join(k, 'keys'));
    assert.equal(dirState(k), 'damaged');
  });

  test('verify-dir refuses a backup that is the live directory or inside it, and says when both are on one filesystem', () => {
    const live = path.join(tmp, 'indep');
    createRun(live, { run: 'b1', failureModel: 'HARNESS-SMOKE' });
    for (const same of [live, path.join(live, 'runs'), path.dirname(live)]) {
      const r = run(live, 'verify-dir', '--backup', same);
      assert.equal(r.status, 1, same);
      assert.match(JSON.parse(r.stdout).backup.problems[0], /not an independent copy/);
    }
    const backup = path.join(tmp, 'indep-backup');
    fs.cpSync(live, backup, { recursive: true });
    const ok = run(live, 'verify-dir', '--backup', backup);
    assert.equal(ok.status, 0, ok.stdout);
    assert.equal(JSON.parse(ok.stdout).backup.sameFilesystem, true, 'reported for the operator; a second disk is theirs to confirm');
  });
});

describe('ledger concurrency: read, decide and write is one step across the server and the operator commands', () => {
  const cli = fileURLToPath(new URL('../recorder.mjs', import.meta.url));
  const lockUrl = new URL('../lib/lock.mjs', import.meta.url).href;
  const op = (dir, ...args) => spawnSync(process.execPath, [cli, ...args, '--dir', dir], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, P7_LOCK_TIMEOUT_MS: '150' } });
  /** Another process that takes the directory's lock and keeps it until told to let go. */
  async function holder(dir) {
    const script = "const fs=require('fs');import(process.argv[2]).then(({withDirLock})=>withDirLock(process.argv[1],()=>{fs.writeSync(1,'held\\n');try{fs.readSync(0,Buffer.alloc(1))}catch{}}))";
    const child = spawn(process.execPath, ['-e', script, dir, lockUrl], { stdio: ['pipe', 'pipe', 'inherit'] });
    await once(child.stdout, 'data');
    return { release: async () => { child.stdin.end(); await once(child, 'exit'); } };
  }
  const kinds = (dir, run) => runStore(dir, run).events().map((e) => e.kind);

  test('while another process holds the lock, nothing decides or writes: commands and the server answer busy, and reads still work', async () => {
    const dir = path.join(tmp, 'lock1');
    mk(dir, { run: 'L1', failureModel: 'HARNESS-SMOKE' });
    const srv = await serve(dir, { lockTimeoutMs: 150 });
    const call = callerFor(srv.base, dir, 'L1');
    const before = listFiles(dir).map((f) => [f, sha(path.join(dir, f))]);
    const h = await holder(dir);
    assert.throws(() => withDirLock(dir, () => 1, { timeoutMs: 100 }), /recorder_busy/);
    for (const args of [['attest', '--run', 'L1', '--item', REQUIRED_ATTESTATIONS[0], '--evidence', 'e'], ['abandon', '--run', 'L1', '--reason', 'r'], ['create-run', '--run', 'L2', '--failure-model', 'HARNESS-SMOKE']]) {
      const r = op(dir, ...args);
      assert.equal(r.status, 1, args[0]);
      assert.match(r.stderr, /recorder_busy/, args[0]);
    }
    const start = await call('POST', '/runs/L1/cycles/1/start', { pgSystemId: pg('L1'), proc: 'a', workers: 1, dbHead: 0, readiness: null });
    assert.deepEqual([start.status, start.data.error], [503, 'recorder_busy']);
    assert.equal((await call('POST', '/runs/L1/event', { kind: 'netcheck', detail: 'x' })).status, 503);
    assert.equal((await call('GET', '/runs/L1')).status, 200, 'reading the status takes no lock');
    assert.deepEqual(listFiles(dir).filter((f) => !f.startsWith(LOCK_FILE)).map((f) => [f, sha(path.join(dir, f))]), before, 'nothing was written by any refused attempt');
    await h.release();
    assert.ok(!fs.existsSync(path.join(dir, LOCK_FILE)), 'released');
    assert.equal(op(dir, 'attest', '--run', 'L1', '--item', REQUIRED_ATTESTATIONS[0], '--evidence', 'e').status, 0);
    assert.match((await call('POST', '/runs/L1/cycles/1/start', { pgSystemId: pg('L1'), proc: 'a', workers: 1, dbHead: 0, readiness: null })).data.cycleId, /^[0-9a-f]{32}$/);
    assert.deepEqual(kinds(dir, 'L1').slice(-2), ['attestation', 'cycle_start']);
    await srv.close();
  });

  test('a cycle start holds the lock from its checks to its write: no attestation, abandonment or new run can land in between', async () => {
    const dir = path.join(tmp, 'lock2');
    mk(dir, { run: 'L3', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    makeReady(dir, 'L3', 1);
    const tried = [];
    // Runs inside the start handler, after every check passed and before the cycle is written.
    const srv = await serve(dir, { beforeStartWrite: () => {
      tried.push(op(dir, 'attest', '--run', 'L3', '--item', REQUIRED_ATTESTATIONS[0], '--evidence', 'changed my mind'));
      tried.push(op(dir, 'abandon', '--run', 'L3', '--reason', 'stop it'));
      tried.push(op(dir, 'create-run', '--run', 'L4', '--failure-model', 'HARNESS-SMOKE'));
    } });
    const n = kinds(dir, 'L3').length;
    const r = await callerFor(srv.base, dir, 'L3')('POST', '/runs/L3/cycles/1/start', { pgSystemId: pg('L3'), proc: 'a', workers: 1, dbHead: 0, readiness: TB(pg('L3'), 1) });
    assert.match(r.data.cycleId, /^[0-9a-f]{32}$/);
    assert.equal(tried.length, 3);
    for (const t of tried) { assert.equal(t.status, 1); assert.match(t.stderr, /recorder_busy/); }
    assert.deepEqual(kinds(dir, 'L3').slice(n), ['cycle_start'], 'the start was written on exactly the snapshot it checked');
    assert.equal(runStore(dir, 'L3').stopped(), null);
    assert.ok(!runStore(dir, 'L4').exists());
    // Afterwards the same commands are decided on the new state: the cycle has started.
    assert.match(op(dir, 'abandon', '--run', 'L3', '--reason', 'stop it').stderr, /has started a cycle/);
    assert.match(op(dir, 'attest', '--run', 'L3', '--item', REQUIRED_ATTESTATIONS[0], '--evidence', 'x').stderr, /already has its readiness record/);
    await srv.close();
  });

  test('an attestation that lands first is seen by the start that follows: stale, never accepted on the old snapshot', async () => {
    const dir = path.join(tmp, 'lock3');
    mk(dir, { run: 'L5', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    makeReady(dir, 'L5', 1);
    const srv = await serve(dir);
    runStore(dir, 'L5').event({ cycle: null, kind: 'attestation', item: REQUIRED_ATTESTATIONS[1], evidence: 'written by another process', attestation: 'operator' });
    const r = await callerFor(srv.base, dir, 'L5')('POST', '/runs/L5/cycles/1/start', { pgSystemId: pg('L5'), proc: 'a', workers: 1, dbHead: 0, readiness: TB(pg('L5'), 1) });
    assert.equal(r.data.error, 'readiness_stale: recorder.attestations.digest');
    assert.ok(!kinds(dir, 'L5').includes('cycle_start'));
    await srv.close();
  });

  test('the lock itself: a dead owner is taken over, a live or unreadable one never is, and a missing directory is not created', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'lock4-'));
    const f = path.join(dir, LOCK_FILE);
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    fs.writeFileSync(f, JSON.stringify({ pid: dead, at: 'earlier' }));
    assert.equal(withDirLock(dir, () => JSON.parse(fs.readFileSync(f, 'utf8')).pid, { timeoutMs: 500 }), process.pid, 'the dead owner was replaced by this process');
    assert.ok(!fs.existsSync(f) && !fs.existsSync(`${f}.takeover`));
    fs.writeFileSync(f, JSON.stringify({ pid: process.ppid, at: 'now' })); // a process that is running
    assert.throws(() => withDirLock(dir, () => 1, { timeoutMs: 100 }), (e) => e.status === 503 && /held by process/.test(e.detail));
    fs.writeFileSync(f, 'not a lock record');
    assert.throws(() => withDirLock(dir, () => 1, { timeoutMs: 100 }), /recorder_busy/, 'unknown owner: fail closed');
    assert.equal(fs.readFileSync(f, 'utf8'), 'not a lock record', 'never removed');
    fs.rmSync(f);
    assert.equal(withDirLock(dir, () => withDirLock(dir, () => 'nested'), { timeoutMs: 100 }), 'nested', 'the same process is not locked out by itself');
    assert.throws(() => withDirLock(dir, () => { throw new Error('inside'); }), /inside/);
    assert.ok(!fs.existsSync(f), 'released after an error too');
    const nowhere = path.join(tmp, 'lock-nowhere');
    assert.equal(withDirLock(nowhere, () => 'ran'), 'ran');
    assert.ok(!fs.existsSync(nowhere));
    assert.deepEqual(fs.readdirSync(dir), [], 'no lock or temporary file is left behind');
  });
});

describe('one recorder server per directory', () => {
  const cli = fileURLToPath(new URL('../recorder.mjs', import.meta.url));
  test('a second serve on the same directory is refused while the first is running; a dead one does not block', async () => {
    const dir = path.join(tmp, 'serve1');
    createRun(dir, { run: 's1', failureModel: 'HARNESS-SMOKE' });
    const marker = path.join(dir, `${LOCK_FILE}.serving`);
    const up = async () => { const c = spawn(process.execPath, [cli, 'serve', '--dir', dir, '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] }); await once(c.stdout, 'data'); return c; };
    const first = await up();
    assert.equal(Number(fs.readFileSync(marker, 'utf8')), first.pid);
    const second = spawnSync(process.execPath, [cli, 'serve', '--dir', dir, '--port', '0'], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(second.status, 1);
    assert.match(second.stderr, /already serving/);
    first.kill('SIGTERM');
    await once(first, 'exit');
    assert.ok(!fs.existsSync(marker), 'removed when the server stops');
    fs.writeFileSync(marker, String(spawnSync(process.execPath, ['-e', '']).pid)); // a server that was killed outright
    const third = await up();
    assert.equal(Number(fs.readFileSync(marker, 'utf8')), third.pid);
    third.kill('SIGTERM');
    await once(third, 'exit');
    assert.equal(dirState(dir), 'recorder');
    assert.deepEqual(compareBackup(dir, dir).problems.length, 1, '(and the marker is never part of a backup comparison)');
  });
});

describe('B6: fail-stop after a claimed init. Abandoning preserves the journal, the registry, the database evidence and the volume identity', () => {
  const cli = fileURLToPath(new URL('../recorder.mjs', import.meta.url));
  const root = path.join(tmp, 'b6');
  const dir = path.join(root, 'recorder');
  const EMPTY = (id) => ({ pgSystemId: id, publicRelations: 0, stateEntries: 0, walLsnBytes: 25 * 1024 * 1024, serverVersion: '16.14' });
  const X = (n) => `77${String(n).padStart(17, '0')}`;
  const tree = (d) => Object.fromEntries(listFiles(d).map((f) => [f, sha(path.join(d, f))]));
  let srv;
  const post = (run, p, body) => callerFor(srv.base, dir, run)('POST', `/runs/${run}/${p}`, body);
  before(async () => { fs.mkdirSync(root, { recursive: true }); srv = await serve(dir); });
  after(() => srv.close());

  test('refused before the claim: nothing is registered; a new run id may claim only volumes that are demonstrably empty', async () => {
    createRun(dir, { run: 'r1', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    // init was refused on the test machine before it claimed anything. The failed run id is closed all the same.
    abandonRun(runStore(dir, 'r1'), 'init refused: network isolation not verified');
    assert.equal(volumeOf(dir, 'r1'), null);
    assert.throws(() => createRun(dir, { run: 'r1', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE }), /run already exists/);
    createRun(dir, { run: 'r2', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    for (const [why, vol] of [['relations', { ...EMPTY(X(1)), publicRelations: 3 }], ['journal entries', { ...EMPTY(X(1)), stateEntries: 1 }], ['a used cluster', { ...EMPTY(X(1)), walLsnBytes: 900 * 1024 * 1024 }], ['unknown facts', { pgSystemId: X(1) }]]) {
      assert.equal((await post('r2', 'event', { kind: 'volume_claimed', volume: vol })).data.error, 'volume_not_fresh', why);
    }
    assert.equal(volumeOwner(dir, X(1)), null, 'a refused claim registers nothing');
    assert.equal((await post('r2', 'event', { kind: 'volume_claimed', volume: EMPTY(X(1)) })).status, 200);
    assert.equal(volumeOwner(dir, X(1)).run, 'r2');
  });

  test('failed after the claim: abandon closes the run and touches nothing else, on the recorder or on the test machine', async () => {
    // What exists after an init that claimed the volumes and then failed: the journal volume with its marker, the
    // initial-state evidence, the database log captured as host evidence, and the recorder's registry line.
    const state = path.join(root, 'volume-state'), evidence = path.join(root, 'evidence', 'r3');
    fs.mkdirSync(path.join(evidence, 'init'), { recursive: true });
    fs.mkdirSync(path.join(evidence, 'host', 'init-failed'), { recursive: true });
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'journal.log'), '{"seq":0,"type":"genesis","hash":"00"}\n');
    fs.writeFileSync(path.join(state, 'p7-volume.json'), JSON.stringify({ pgSystemId: X(3), initialisedByRun: 'r3', failureModel: 'POWER-CUT' }));
    fs.writeFileSync(path.join(evidence, 'init', 'initial-empty-state-1.json'), JSON.stringify({ run: 'r3', volume: EMPTY(X(3)) }));
    fs.writeFileSync(path.join(evidence, 'host', 'init-failed', 'db-log.txt'), 'database system is ready to accept connections\n');
    createRun(dir, { run: 'r3', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    assert.equal((await post('r3', 'event', { kind: 'volume_claimed', volume: EMPTY(X(3)) })).status, 200);
    const claim = { ...volumeOwner(dir, X(3)) };
    const before = { recorder: tree(dir), state: tree(state), evidence: tree(evidence), registry: fs.readFileSync(path.join(dir, 'volumes.jsonl')), events: fs.readFileSync(path.join(runStore(dir, 'r3').root, 'events.jsonl')) };
    // A `docker` that would be noticed: abandon must never call it.
    const bin = path.join(root, 'bin'), calls = path.join(root, 'docker-calls.txt');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\necho "$@" >> "${calls}"\n`, { mode: 0o755 });
    const r = spawnSync(process.execPath, [cli, 'abandon', '--dir', dir, '--run', 'r3', '--reason', 'init failed after the claim'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(calls), 'docker was never invoked: no container or volume command of any kind');
    // The test machine's side: journal, volume marker, initial-state evidence, database log. Byte for byte.
    assert.deepEqual(tree(state), before.state);
    assert.deepEqual(tree(evidence), before.evidence);
    // The recorder's side: the registry byte for byte, the claim unchanged, and every earlier file unchanged except
    // the run's own ledger, which only grew by the abandonment note.
    assert.ok(fs.readFileSync(path.join(dir, 'volumes.jsonl')).equals(before.registry));
    assert.deepEqual({ ...volumeOwner(dir, X(3)) }, claim, 'the volume identity still belongs to the abandoned run');
    const after = tree(dir), ledger = path.join('runs', 'r3', 'events.jsonl'), stop = path.join('runs', 'r3', 'STOPPED.json');
    assert.deepEqual(Object.keys(after).sort(), [...Object.keys(before.recorder), stop].sort(), 'one new file: the stop marker');
    for (const f of Object.keys(before.recorder)) if (f !== ledger) assert.equal(after[f], before.recorder[f], f);
    const grown = fs.readFileSync(path.join(dir, ledger));
    assert.ok(grown.subarray(0, before.events.length).equals(before.events), 'earlier ledger records are untouched');
    assert.deepEqual(grown.subarray(before.events.length).toString().trim().split('\n').map((l) => JSON.parse(l).kind), ['abandoned']);
    assert.equal(registryProblem(dir), null);
    // Every way forward on this run or these volumes is closed; no command offers a reset.
    assert.deepEqual([(await post('r3', 'event', { kind: 'volume_claimed', volume: EMPTY(X(3)) })).data.error, (await post('r3', 'event', { kind: 'initialised', installationId: 'i' })).data.error], ['run_stopped', 'run_stopped']);
    createRun(dir, { run: 'r4', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    assert.equal((await post('r4', 'event', { kind: 'volume_claimed', volume: EMPTY(X(3)) })).data.error, 'volume_already_used_by_r3', 'no other run may use the claimed volumes, even if they look empty');
    assert.throws(() => createRun(dir, { run: 'r3', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE }), /run already exists/);
    assert.throws(() => createRun(dir, { run: 'r3c', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE, continues: 'r3' }), /refused/);
    assert.match(spawnSync(process.execPath, [cli, 'reset', '--dir', dir, '--run', 'r3'], { encoding: 'utf8' }).stderr, /commands: serve, create-run, attest, abandon, cut, confirm-cut, status, measure, verify-dir/);
  });

  test('a crash between the stop marker and the note leaves the run stopped', () => {
    createRun(dir, { run: 'r5', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    const s = runStore(dir, 'r5');
    assert.throws(() => abandonRun({ ...s, event: () => { throw new Error('killed'); } }, 'x'), /killed/);
    assert.equal(s.stopped().kind, 'abandoned', 'the stop marker is written first');
  });
});

describe('source and image identity', () => {
  const cli = fileURLToPath(new URL('../recorder.mjs', import.meta.url));
  test('a qualifying run cannot be created without the declared commit, package checksum, image id and architecture', () => {
    const dir = path.join(tmp, 'ident');
    createRun(dir, { run: 'seed', failureModel: 'HARNESS-SMOKE' });
    const filled = path.join(tmp, 'ident-storage.json');
    fs.writeFileSync(filled, JSON.stringify(STORAGE));
    const none = spawnSync(process.execPath, [cli, 'create-run', '--dir', dir, '--run', 'id1', '--failure-model', 'POWER-CUT', '--storage-json', filled], { encoding: 'utf8' });
    assert.equal(none.status, 1);
    for (const flag of ['--source-commit', '--package-sha256', '--image-id', '--image-arch']) assert.match(none.stderr, new RegExp(flag));
    const short = spawnSync(process.execPath, [cli, 'create-run', '--dir', dir, '--run', 'id1', '--failure-model', 'POWER-CUT', '--storage-json', filled, ...IDENTITY_FLAGS.map((v) => (v === IDENTITY.sourceCommit ? 'a12e615' : v))], { encoding: 'utf8' });
    assert.match(short.stderr, /--source-commit must be the 40-character commit/);
    assert.ok(!runStore(dir, 'id1').exists() && !fs.existsSync(runStore(dir, 'id1').keyFile), 'nothing was created');
    assert.equal(spawnSync(process.execPath, [cli, 'create-run', '--dir', dir, '--run', 'id1', '--failure-model', 'POWER-CUT', '--storage-json', filled, ...IDENTITY_FLAGS], { encoding: 'utf8' }).status, 0);
    assert.deepEqual(runStore(dir, 'id1').run().identity, IDENTITY);
    assert.equal(fs.statSync(runStore(dir, 'id1').keyFile).mode & 0o777, 0o600, 'the run key is private');
    assert.deepEqual(recorderBindingOf(dir, 'id1').identity, { ...IDENTITY, sourceTreeSha256: SOURCE.sha256 });
    assert.equal(spawnSync(process.execPath, [cli, 'create-run', '--dir', dir, '--run', 'sm2', '--failure-model', 'HARNESS-SMOKE'], { encoding: 'utf8' }).status, 0, 'a smoke run needs none');
  });

  test('the source digest covers exactly the files the harness executes, by content', () => {
    const r = fs.mkdtempSync(path.join(tmp, 'src-'));
    for (const d of ['m16-p7/lib', 'm16-p7/firewall', 'm16-p7/test', 'm16-phase05/lib']) fs.mkdirSync(path.join(r, d), { recursive: true });
    const w = (f, t) => fs.writeFileSync(path.join(r, f), t);
    w('m16-p7/p7.mjs', 'a'); w('m16-p7/compose.yml', 'b'); w('m16-p7/host-evidence.sh', 'c'); w('m16-p7/lib/x.mjs', 'd'); w('m16-p7/firewall/p7-firewall.sh', 'e'); w('m16-phase05/lib/proto.mjs', 'f');
    const base = sourceDigest(r);
    assert.equal(base.files, 6);
    w('m16-p7/README.md', 'docs'); w('m16-p7/test/x.test.mjs', 'tests'); w('m16-phase05/exp.mjs', 'not used'); fs.mkdirSync(path.join(r, 'm16-p7/evidence'));
    assert.deepEqual(sourceDigest(r), base, 'documents, tests, evidence and unused experiments are not part of it');
    for (const [f, t] of [['m16-p7/p7.mjs', 'A'], ['m16-p7/compose.yml', 'B'], ['m16-p7/lib/x.mjs', 'D'], ['m16-p7/firewall/p7-firewall.sh', 'E'], ['m16-phase05/lib/proto.mjs', 'F']]) {
      const original = fs.readFileSync(path.join(r, f));
      w(f, t);
      assert.notEqual(sourceDigest(r).sha256, base.sha256, f);
      w(f, original);
    }
    assert.deepEqual(sourceDigest(r), base);
    w('m16-p7/lib/extra.mjs', '');
    assert.deepEqual([sourceDigest(r).files, sourceDigest(r).sha256 === base.sha256], [7, false], 'an added file changes it');
    assert.equal(SOURCE.files, sourceDigest(fileURLToPath(new URL('../..', import.meta.url))).files);
  });
});

describe('backup independence: hard links', () => {
  test('a backup whose files are hard links to the live files is not a copy', () => {
    const live = path.join(tmp, 'hl');
    createRun(live, { run: 'h1', failureModel: 'HARNESS-SMOKE' });
    const backup = path.join(tmp, 'hl-backup');
    fs.cpSync(live, backup, { recursive: true });
    assert.deepEqual(compareBackup(live, backup).problems, []);
    fs.rmSync(path.join(backup, 'recorder-id.json'));
    fs.linkSync(path.join(live, 'recorder-id.json'), path.join(backup, 'recorder-id.json'));
    assert.match(compareBackup(live, backup).problems.join(), /recorder-id\.json: the backup and the live file are one file \(a hard link\)/);
  });
});

describe('source package: the recorder checks the declared commit and checksum against the package itself', () => {
  const cli = fileURLToPath(new URL('../recorder.mjs', import.meta.url));
  const shaOf = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const idFor = (f, over = {}) => ({ ...IDENTITY, packageSha256: shaOf(f), ...over });

  test('the package is read without extracting it: its checksum, the commit git embedded, and every file', () => {
    const pkg = readPackage(PACKAGE);
    assert.deepEqual([pkg.sha256, pkg.commit, pkg.prefix, pkg.files.size], [IDENTITY.packageSha256, COMMIT, 'opspilot-p7-test', SOURCE.files]);
    assert.deepEqual(sourceDigestOfFiles(pkg.files), SOURCE, 'the digest of the packaged source is the digest of the same files on disk');
    assert.deepEqual(packageProblems(PACKAGE, IDENTITY), []);
    // Documents, tests and other directories in a package are not part of the source digest; long paths are read.
    const long = `prototype/m16-p7/test/${'d'.repeat(120)}/x.test.mjs`;
    const more = readPackage(writePackage('more.tar.gz', [...sourceEntries(), ['prototype/m16-p7/README.md', 'docs'], ['apps/api/Dockerfile', 'FROM x'], [long, 'test']]));
    assert.ok(more.files.has(long));
    assert.deepEqual(sourceDigestOfFiles(more.files), SOURCE);
  });

  test('every way the package can fail to back the declaration is refused, each with its reason', () => {
    const changed = sourceEntries().map(([n, c]) => (n.endsWith('/p7.mjs') ? [n, Buffer.concat([c, Buffer.from('\n// edited')])] : [n, c]));
    const cases = {
      'its SHA-256 is .*, not the declared': [PACKAGE, { ...IDENTITY, packageSha256: 'd1'.repeat(32) }],
      'archived from commit c0c0.*, not the declared 1111': [PACKAGE, { ...IDENTITY, sourceCommit: '11'.repeat(20) }],
      'carries no commit id': [writePackage('nocommit.tar.gz', sourceEntries(), {}), null],
      'harness source in it .* is not the source this recorder is running': [writePackage('edited.tar.gz', changed), null],
      [`harness source in it \\(${SOURCE.files - 1} files\\)`]: [writePackage('missing.tar.gz', sourceEntries().slice(1)), null],
      [`harness source in it \\(${SOURCE.files + 1} files\\)`]: [writePackage('extra.tar.gz', [...sourceEntries(), ['prototype/m16-p7/lib/extra.mjs', '']]), null],
      'could not be read \\(package: unexpected path': [writePackage('traversal.tar.gz', [...sourceEntries(), ['prototype/../../etc/passwd', 'x']]), null],
      'could not be read \\(package: more than one top-level directory': [(() => { const f = path.join(PKG_DIR, 'two.tar.gz'); fs.writeFileSync(f, tarGz([['a/x.mjs', '1'], ['b/y.mjs', '2']], { commit: COMMIT, prefix: null })); return f; })(), null],
      'could not be read \\(package: no files': [writePackage('empty.tar.gz', []), null],
      'could not be read': [(() => { const f = path.join(PKG_DIR, 'garbage.tar.gz'); fs.writeFileSync(f, 'not an archive'); return f; })(), null],
      'could not be read \\(ENOENT': [path.join(PKG_DIR, 'absent.tar.gz'), IDENTITY],
    };
    for (const [why, [file, id]] of Object.entries(cases)) assert.match(packageProblems(file, id ?? idFor(file)).join(' | '), new RegExp(why), why);
    const truncated = path.join(PKG_DIR, 'truncated.tar.gz');
    fs.writeFileSync(truncated, fs.readFileSync(PACKAGE).subarray(0, 2000));
    assert.match(packageProblems(truncated, idFor(truncated)).join(), /could not be read/);
    // The recorder host running other code than the package holds (an uncommitted edit there): refused as well.
    assert.match(packageProblems(PACKAGE, IDENTITY, { sha256: 'ab'.repeat(32), files: SOURCE.files }).join(), /not the source this recorder is running/);
  });

  test('create-run: no qualifying run without the package, or with one that does not match; nothing is created', () => {
    const dir = path.join(tmp, 'pkgrun');
    createRun(dir, { run: 'seed', failureModel: 'HARNESS-SMOKE' });
    const filled = path.join(tmp, 'pkgrun-storage.json');
    fs.writeFileSync(filled, JSON.stringify(STORAGE));
    const create = (...flags) => spawnSync(process.execPath, [cli, 'create-run', '--dir', dir, '--run', 'k1', '--failure-model', 'POWER-CUT', '--storage-json', filled, ...flags], { encoding: 'utf8' });
    const declared = IDENTITY_FLAGS.slice(0, 8);
    assert.match(create(...declared).stderr, /--package <the source package .tar.gz> is required/);
    const other = writePackage('other-commit.tar.gz', sourceEntries(), { commit: '22'.repeat(20) });
    assert.match(create(...declared, '--package', other).stderr, /its SHA-256 is .*\n- it was archived from commit 2222/);
    assert.match(create(...declared, '--package', path.join(PKG_DIR, 'absent.tar.gz')).stderr, /could not be read/);
    assert.ok(!runStore(dir, 'k1').exists() && !fs.existsSync(runStore(dir, 'k1').keyFile));
    assert.equal(create(...IDENTITY_FLAGS).status, 0);
    assert.match(runStore(dir, 'k1').run().identityVerification, /checked by the recorder against the package file and its own copy.*Image id and architecture: declared by the operator/);
    assert.match(runStore(dir, 'seed').run().identityVerification, /not a qualifying run/);
    assert.throws(() => createRun(dir, { run: 'k2', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY }), /--package .* is required/, 'the function itself refuses too, not only the command');
  });

  test('a real `git archive` of this repository is read the same way, with the commit git put in it', (t) => {
    const repo = fileURLToPath(new URL('../../..', import.meta.url));
    const head = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (head.status !== 0) return t.skip('not a git checkout');
    const out = path.join(PKG_DIR, 'real.tar.gz');
    const made = spawnSync('git', ['-C', repo, 'archive', '--format=tar.gz', '--prefix=opspilot-p7-real/', '-o', out, 'HEAD', 'prototype/m16-p7/lib', 'prototype/m16-phase05/lib'], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const pkg = readPackage(out);
    assert.equal(pkg.commit, head.stdout.trim());
    assert.equal(pkg.prefix, 'opspilot-p7-real');
    assert.ok(pkg.files.has('prototype/m16-p7/lib/ledger.mjs') && pkg.files.has('prototype/m16-phase05/lib/journal.mjs'));
    const tracked = spawnSync('git', ['-C', repo, 'show', 'HEAD:prototype/m16-p7/lib/ledger.mjs'], { encoding: 'buffer' }).stdout;
    assert.ok(pkg.files.get('prototype/m16-p7/lib/ledger.mjs').equals(tracked), 'the content is the committed content, byte for byte');
  });

  test('the runtime fingerprint: the content of the named files; a file that cannot be read is recorded, never skipped', () => {
    const d = fs.mkdtempSync(path.join(tmp, 'rt-'));
    const a = path.join(d, 'node'), b = path.join(d, 'lock.json');
    fs.writeFileSync(a, 'binary'); fs.writeFileSync(b, '{}');
    const base = runtimeFingerprint([a, b]);
    assert.match(base, /^[0-9a-f]{64}$/);
    assert.equal(runtimeFingerprint([a, b]), base);
    fs.writeFileSync(b, '{"changed":true}');
    assert.notEqual(runtimeFingerprint([a, b]), base, 'other dependencies');
    fs.writeFileSync(b, '{}');
    assert.equal(runtimeFingerprint([a, b]), base);
    fs.rmSync(b);
    const missing = runtimeFingerprint([a, b]);
    assert.notEqual(missing, base);
    assert.notEqual(missing, runtimeFingerprint([a]), 'a missing file is not the same as a file never asked for');
  });
});

describe('failure boundaries of the recorder', () => {
  const cli = fileURLToPath(new URL('../recorder.mjs', import.meta.url));
  const lockUrl = new URL('../lib/lock.mjs', import.meta.url).href;
  const EMPTY = (id) => ({ pgSystemId: id, publicRelations: 0, stateEntries: 0, walLsnBytes: 25 * 1024 * 1024, serverVersion: '16.14' });
  const X = (n) => `78${String(n).padStart(17, '0')}`;

  test('an acknowledgement whose fsync fails is answered with an error, never with a success; what is on disk afterwards cannot be counted twice', async () => {
    const dir = path.join(tmp, 'ackfail');
    mk(dir, { run: 'f1', failureModel: 'HARNESS-SMOKE' });
    let srv = await serve(dir);
    const call = callerFor(srv.base, dir, 'f1');
    const cycleId = (await call('POST', '/runs/f1/cycles/1/start', { pgSystemId: pg('f1'), proc: 'a', workers: 1, dbHead: 0, readiness: null })).data.cycleId;
    const ack = (n, kind, seq) => call('POST', '/runs/f1/ack', { cycle: 1, cycleId, proc: 'a', worker: 1, n, kind, seq, actionId: T('f1', `c0001aw1-${seq}`) });
    assert.equal((await ack(1, 'claim', 1)).status, 200);
    // The recorder's disk fails the sync of the next acknowledgement (the server runs in this process).
    const real = fs.fsyncSync;
    let failed = 0;
    fs.fsyncSync = (fd) => { if (failed === 0) { failed = 1; throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }); } return real(fd); };
    let r;
    try { r = await ack(2, 'dispatch', 1); } finally { fs.fsyncSync = real; }
    assert.equal(failed, 1);
    assert.equal(r.status, 500, 'the worker is told it failed, so it stops (lib/worker.mjs): it never treats this as acknowledged');
    assert.notEqual(r.data?.ok, true);
    // The line reached the file all the same. The recorder holds it; nobody was told so. That is the safe direction:
    // a dispatch intent is acknowledged only after it was appended, so what the recorder holds is true.
    const file = path.join(runStore(dir, 'f1').root, 'acks', 'cycle-0001.jsonl');
    assert.deepEqual(readLedger(file).entries.map((a) => [a.n, a.kind]), [[1, 'claim'], [2, 'dispatch']]);
    // DEFECT FOUND HERE (fixed in recorder.mjs, "ack"): before the restart the server's memory did not know about the
    // line it had just written, so the same acknowledgement sent again was accepted and written a second time. Now a
    // failed write marks the cycle's acknowledgement file as damaged, and the cycle accepts nothing more.
    const sameProcess = await ack(2, 'dispatch', 1);
    assert.equal(sameProcess.data.error, 'recorder_ack_file_damaged', 'no second copy of the line is accepted by the same server');
    assert.equal((await ack(3, 'claim', 2)).data.error, 'recorder_ack_file_damaged', 'and nothing else in this cycle');
    assert.equal(readLedger(file).entries.length, 2);
    await srv.close(); srv = await serve(dir); // the recorder restarts and reads its ledger
    const again = callerFor(srv.base, dir, 'f1');
    const resend = await again('POST', '/runs/f1/ack', { cycle: 1, cycleId, proc: 'a', worker: 1, n: 2, kind: 'dispatch', seq: 1, actionId: T('f1', 'c0001aw1-1') });
    assert.equal(resend.data.error, 'duplicate_or_replayed', 'after the restart the stored line is the stream\'s position: it cannot be accepted a second time');
    assert.equal(cycleView(runStore(dir, 'f1'), 1).acks.length, 2);
    await srv.close();
  });

  test('a recorder that restarts in the middle of a cycle continues every stream exactly where its ledger ends', async () => {
    const dir = path.join(tmp, 'restart');
    mk(dir, { run: 'f2', failureModel: 'HARNESS-SMOKE' });
    let srv = await serve(dir);
    let call = callerFor(srv.base, dir, 'f2');
    const cycleId = (await call('POST', '/runs/f2/cycles/1/start', { pgSystemId: pg('f2'), proc: 'a', workers: 1, dbHead: 0, readiness: null })).data.cycleId;
    const ack = (n, kind, seq) => call('POST', '/runs/f2/ack', { cycle: 1, cycleId, proc: 'a', worker: 1, n, kind, seq, actionId: T('f2', `c0001aw1-${seq}`) });
    for (const [n, kind, seq] of [[1, 'claim', 1], [2, 'dispatch', 1], [3, 'claim', 2]]) assert.equal((await ack(n, kind, seq)).status, 200);
    await srv.close(); srv = await serve(dir); call = callerFor(srv.base, dir, 'f2');
    assert.equal((await ack(5, 'claim', 3)).data.error, 'out_of_order', 'a gap is still a gap');
    assert.equal((await ack(4, 'claim', 3)).data.error, 'out_of_order', 'claim 2 has no dispatch intent yet');
    assert.equal((await ack(4, 'dispatch', 2)).status, 200);
    assert.equal((await ack(3, 'claim', 2)).data.error, 'duplicate_or_replayed');
    // A ledger that ends in a fragment (the recorder died mid-write) is damaged: the cycle accepts nothing more.
    await srv.close();
    fs.appendFileSync(path.join(runStore(dir, 'f2').root, 'acks', 'cycle-0001.jsonl'), '{"cycle":1,"n":5,"ki');
    srv = await serve(dir); call = callerFor(srv.base, dir, 'f2');
    assert.equal((await ack(5, 'claim', 3)).data.error, 'recorder_ack_file_damaged');
    await srv.close();
  });

  test('a command killed while it holds the lock does not block the recorder: the next one takes over', async () => {
    const dir = path.join(tmp, 'killed');
    createRun(dir, { run: 'f3', failureModel: 'HARNESS-SMOKE' });
    const script = "const fs=require('fs');import(process.argv[2]).then(({withDirLock})=>withDirLock(process.argv[1],()=>{fs.writeSync(1,'held\\n');try{fs.readSync(0,Buffer.alloc(1))}catch{}}))";
    const child = spawn(process.execPath, ['-e', script, dir, lockUrl], { stdio: ['pipe', 'pipe', 'inherit'] });
    await once(child.stdout, 'data');
    assert.throws(() => withDirLock(dir, () => 1, { timeoutMs: 100 }), /recorder_busy/);
    child.kill('SIGKILL');
    await once(child, 'exit');
    assert.ok(fs.existsSync(path.join(dir, LOCK_FILE)), 'the killed process left its lock behind');
    const r = spawnSync(process.execPath, [cli, 'attest', '--dir', dir, '--run', 'f3', '--item', REQUIRED_ATTESTATIONS[0], '--evidence', 'after the crash'], { encoding: 'utf8', env: { ...process.env, P7_LOCK_TIMEOUT_MS: '2000' } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(path.join(dir, LOCK_FILE)));
    assert.equal(runStore(dir, 'f3').events().filter((e) => e.kind === 'attestation').length, 1);
  });

  test('concurrent attempts: one cluster claimed by two runs at once, one readiness record posted twice, one process started twice', async () => {
    const dir = path.join(tmp, 'race');
    for (const run of ['g1', 'g2']) createRun(dir, { run, failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    const srv = await serve(dir);
    const post = (run, p, body) => callerFor(srv.base, dir, run)('POST', `/runs/${run}/${p}`, body);
    const claims = await Promise.all(['g1', 'g2'].map((run) => post(run, 'event', { kind: 'volume_claimed', volume: EMPTY(X(1)) })));
    assert.deepEqual(claims.map((c) => c.status).sort(), [200, 409], 'exactly one run gets the cluster');
    const winner = claims[0].status === 200 ? 'g1' : 'g2', loser = winner === 'g1' ? 'g2' : 'g1';
    assert.equal(claims.find((c) => c.status === 409).data.error, `volume_already_used_by_${winner}`);
    assert.equal(fs.readFileSync(path.join(dir, 'volumes.jsonl'), 'utf8').trim().split('\n').length, 1, 'one registry line');
    assert.equal(volumeOf(dir, loser), null);
    await post(winner, 'event', { kind: 'initialised', installationId: 'inst-1' });
    for (const item of REQUIRED_ATTESTATIONS) runStore(dir, winner).event({ cycle: null, kind: 'attestation', item, evidence: 'e', attestation: 'operator' });
    const B1 = { procs: 1, workers: 1, cycles: 20, maxSeconds: 600, headroom: 2, ratePerWorker: 100, targetRate: null, poolPerWorker: 40000, burstPeriodSeconds: 60, burstSeconds: 10, quietRate: 20 };
    const test1 = testBinding({ ...FACTS(X(1), 1), workload: B1 });
    const records = await Promise.all([1, 2, 3].map(() => post(winner, 'readiness', { test: test1 })));
    assert.deepEqual(records.map((r) => r.status), [200, 200, 200]);
    assert.equal(records.filter((r) => r.data.unchanged === true).length, 2, 'written once; the other two were confirmations');
    assert.equal(runStore(dir, winner).events().filter((e) => e.kind === 'readiness').length, 1);
    const starts = await Promise.all([1, 2].map(() => post(winner, 'cycles/1/start', { pgSystemId: X(1), proc: 'a', workers: 1, dbHead: 0, readiness: test1 })));
    assert.deepEqual(starts.map((s) => s.data.error ?? 'started').sort(), ['process_already_started_in_cycle', 'started']);
    assert.equal(runStore(dir, winner).events().filter((e) => e.kind === 'cycle_start').length, 1);
    await srv.close();
  });

  test('a readiness record edited in the ledger: never silently accepted for the original configuration, and the backup shows the edit', async () => {
    const dir = path.join(tmp, 'tamper');
    mk(dir, { run: 't1', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    makeReady(dir, 't1', 1);
    const backup = path.join(tmp, 'tamper-backup');
    fs.cpSync(dir, backup, { recursive: true });
    const srv = await serve(dir);
    const go = (workers, t = TB(pg('t1'), workers)) => callerFor(srv.base, dir, 't1')('POST', '/runs/t1/cycles/1/start', { pgSystemId: pg('t1'), proc: 'a', workers, dbHead: 0, vet: true, readiness: t });
    assert.deepEqual((await go(1)).data, { vetted: true });
    const ledger = path.join(runStore(dir, 't1').root, 'events.jsonl');
    const original = fs.readFileSync(ledger, 'utf8');
    const rewrite = (change) => fs.writeFileSync(ledger, original.split('\n').map((l) => (l.includes('"kind":"readiness"') ? JSON.stringify(change(JSON.parse(l))) : l)).join('\n'));
    // 1. The stored workload is changed and the stored digest left alone.
    const forged = TB(pg('t1'), 1, { workload: { ...FACTS('', 1).workload, quietRate: 5 } });
    rewrite((e) => { e.binding.test.workload.quietRate = 5; return e; });
    assert.equal((await go(1)).data.error, 'readiness_stale: test.workload.quietRate', 'the original configuration no longer matches the record');
    assert.equal((await go(1, forged)).data.error, 'readiness_stale: digest', 'and the edited one does not match the stored digest');
    // 2. The digest is recomputed as well: a consistent forgery. The recorder cannot tell it from a real record (it
    //    has no secret the forger lacks), but it is still not the original configuration, and the backup shows the edit.
    rewrite((e) => { e.binding.test.workload.quietRate = 5; e.digest = digestOf(e.binding); return e; });
    assert.equal((await go(1)).data.error, 'readiness_stale: test.workload.quietRate');
    assert.deepEqual((await go(1, forged)).data, { vetted: true }, 'the stated trust limit: whoever can rewrite the ledger can make a matching record');
    // But not any record: one that leaves decision B1's shape starts nothing, however consistent it is made.
    rewrite((e) => { e.binding.test.workload.workers = 2; e.digest = digestOf(e.binding); return e; });
    assert.match((await go(2)).data.error, /^readiness_not_ready: workload: a qualifying series runs one worker, not 2/);
    rewrite((e) => { e.binding.test.workload.procs = 2; e.digest = digestOf(e.binding); return e; });
    assert.match((await go(1, TB(pg('t1'), 1, { workload: { ...FACTS('', 1).workload, procs: 2 } }))).data.error, /^readiness_not_ready: workload: a qualifying series runs one process, not 2/);
    const check = compareBackup(dir, backup, { allowGrowth: true });
    assert.match(check.problems.join(' | '), /runs\/t1\/events\.jsonl: differs from the backup \(earlier records were changed/, 'which is why the directory is backed up and compared');
    fs.writeFileSync(ledger, original);
    assert.deepEqual((await go(1)).data, { vetted: true });
    assert.deepEqual(compareBackup(dir, backup, { allowGrowth: true }).problems.filter((p) => p.includes('events.jsonl')), []);
    await srv.close();
  });

  test('backup verification: a ledger cut short, a key changed, and a file added are each reported', () => {
    const live = path.join(tmp, 'bk');
    mk(live, { run: 'b1', failureModel: 'HARNESS-SMOKE' });
    runStore(live, 'b1').event({ cycle: null, kind: 'netcheck', detail: 'one' });
    const backup = path.join(tmp, 'bk-backup');
    fs.cpSync(live, backup, { recursive: true });
    const ledger = path.join(runStore(live, 'b1').root, 'events.jsonl');
    const full = fs.readFileSync(ledger);
    fs.writeFileSync(ledger, full.subarray(0, full.length - 30));
    assert.match(compareBackup(live, backup, { allowGrowth: true }).problems.join(), /events\.jsonl: differs from the backup \(earlier records were changed/, 'shorter than the backup is not growth');
    fs.writeFileSync(ledger, full);
    const key = runStore(live, 'b1').keyFile, k = fs.readFileSync(key);
    fs.writeFileSync(key, `${'0'.repeat(64)}\n`);
    for (const allowGrowth of [false, true]) assert.match(compareBackup(live, backup, { allowGrowth }).problems.join(), /keys\/b1\.key: differs from the backup/);
    assert.ok(!JSON.stringify(compareBackup(live, backup)).includes('0'.repeat(64)), 'a changed key is reported by name, never by content');
    fs.writeFileSync(key, k);
    fs.writeFileSync(path.join(live, 'stray.txt'), 'x');
    assert.match(compareBackup(live, backup).problems.join(), /stray\.txt: in the live directory, not in the backup/);
    assert.deepEqual(compareBackup(live, backup, { allowGrowth: true }).problems, [], 'with growth allowed a new file is growth: only changes to what was backed up are problems');
  });

  test('an abandonment that was interrupted can only end one way: stopped', () => {
    const dir = path.join(tmp, 'interrupted');
    createRun(dir, { run: 'a1', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    const s = runStore(dir, 'a1');
    assert.throws(() => abandonRun({ ...s, event: () => { throw new Error('killed'); } }, 'first try'), /killed/);
    assert.equal(s.stopped().kind, 'abandoned');
    const again = spawnSync(process.execPath, [cli, 'abandon', '--dir', dir, '--run', 'a1', '--reason', 'second try'], { encoding: 'utf8' });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already stopped \(abandoned\)/);
    assert.equal(s.stopped().reason, 'first try', 'the stop marker is written once and never rewritten');
    assert.throws(() => createRun(dir, { run: 'a1', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE }), /run already exists/);
  });
});

describe('a qualifying run through the real endpoints and commands (no test shortcut writes its readiness record; the cut event alone is written directly, as `cut` writes it)', () => {
  const cli = fileURLToPath(new URL('../recorder.mjs', import.meta.url));
  test('create, claim, initialise, attest, preflight, then two cycles on the one recorded workload', async () => {
    const dir = path.join(tmp, 'e2e');
    const X = '7900000000000000001';
    const op = (...args) => spawnSync(process.execPath, [cli, ...args, '--dir', dir], { encoding: 'utf8', timeout: 20_000 });
    const storage = path.join(tmp, 'e2e-storage.json');
    fs.writeFileSync(storage, JSON.stringify(STORAGE));
    assert.equal(op('create-run', '--new-directory', '--run', 'e1', '--failure-model', 'POWER-CUT', '--storage-json', storage, ...IDENTITY_FLAGS).status, 0);
    const srv = await serve(dir);
    const post = (p, body) => callerFor(srv.base, dir, 'e1')('POST', `/runs/e1/${p}`, body);
    const status = async () => (await callerFor(srv.base, dir, 'e1')('GET', '/runs/e1')).data;
    assert.equal((await post('event', { kind: 'volume_claimed', volume: { pgSystemId: X, publicRelations: 0, stateEntries: 0, walLsnBytes: 25 * 1024 * 1024, serverVersion: '16.14' } })).status, 200);
    assert.equal((await post('event', { kind: 'initialised', installationId: 'inst-1' })).status, 200);
    for (const item of REQUIRED_ATTESTATIONS) assert.equal(op('attest', '--run', 'e1', '--item', item, '--evidence', `done: ${item}`).status, 0);
    const B1 = { procs: 1, workers: 1, cycles: 20, maxSeconds: 600, headroom: 2, ratePerWorker: 100, targetRate: null, poolPerWorker: 40000, burstPeriodSeconds: 60, burstSeconds: 10, quietRate: 20 };
    const binding = (over = {}) => testBinding({ ...FACTS(X, 1), workload: { ...B1, ...over } });
    const ready = await post('readiness', { test: binding() });
    assert.equal(ready.status, 200, JSON.stringify(ready.data));
    const sizing = { ...B1 };
    const start = (cycle, dbHead, over = {}) => post(`cycles/${cycle}/start`, { pgSystemId: X, proc: 'a', workers: 1, dbHead, sizing, readiness: binding(), ...over });

    async function cycle(n, head) {
      const cycleId = (await start(n, head)).data.cycleId;
      assert.match(cycleId ?? '', /^[0-9a-f]{32}$/, `cycle ${n} started`);
      const seq = head + 1, actionId = T('e1', `c${String(n).padStart(4, '0')}aw1-1`);
      for (const [k, kind] of [[1, 'claim'], [2, 'dispatch']]) assert.equal((await post('ack', { cycle: n, cycleId, proc: 'a', worker: 1, n: k, kind, seq, actionId })).status, 200);
      runStore(dir, 'e1').event({ cycle: n, kind: 'cut_sent', how: 'manual prompt' }); // as `recorder.mjs cut` writes it after its wait
      assert.equal(op('confirm-cut', '--run', 'e1', '--cycle', String(n), '--power-was-cut', 'yes', '--evidence', 'unit test: no power exists here').status, 0);
      assert.equal((await post(`cycles/${n}/result`, { cycleId, verdict: 'PASS', needsRecovery: [] })).status, 200);
      assert.equal((await post(`cycles/${n}/recovered`, { cycleId, finalState: { installationId: 'inst-1', head: seq, headHash: 'ab'.repeat(32) } })).status, 200);
      return seq;
    }
    const head1 = await cycle(1, 0);
    assert.equal((await status()).streak.consecutivePhysicalPasses, 1);
    // Cycle 2: the recorded workload is the only one that starts. Every other attempt is refused, and changes nothing.
    assert.equal((await start(2, head1, { readiness: binding({ quietRate: 19 }) })).data.error, 'readiness_stale: test.workload.quietRate');
    assert.equal((await start(2, head1, { readiness: binding({ ratePerWorker: 99 }) })).data.error, 'readiness_stale: test.workload.ratePerWorker');
    assert.equal((await start(2, head1, { workers: 2 })).data.error, 'start_differs_from_ready_workload');
    assert.equal((await start(2, head1, { proc: 'b' })).data.error, 'start_differs_from_ready_workload');
    assert.equal((await post('readiness', { test: binding({ quietRate: 19 }) })).data.error, 'readiness_only_before_the_first_cycle');
    assert.match(op('attest', '--run', 'e1', '--item', REQUIRED_ATTESTATIONS[0], '--evidence', 'again').stderr, /already has its readiness record/);
    await cycle(2, head1);
    const st = await status();
    assert.deepEqual([st.streak.consecutivePhysicalPasses, st.cyclesStarted, st.stopped, st.readiness.digest], [2, 2, null, ready.data.digest]);
    const starts = runStore(dir, 'e1').events().filter((e) => e.kind === 'cycle_start');
    assert.deepEqual(starts.map((e) => e.bindingDigest), [ready.data.digest, ready.data.digest], 'both cycles ran under the one record');
    // What the cycle did, measured, beside what it declared.
    const m = JSON.parse(op('measure', '--run', 'e1', '--cycle', '1').stdout);
    assert.deepEqual([m.measured.totalAcknowledgedClaims, m.measured.workers, m.configured.maximumBurstRatePerWorker, m.configured.quietRatePerWorker, m.configured.workers], [1, 1, 100, 20, 1]);
    assert.equal(JSON.parse(op('verify-dir').stdout).problems.length, 0);
    await srv.close();
  });
});

describe('findings of the independent review (each test was written failing, before its fix)', () => {
  const cli = fileURLToPath(new URL('../recorder.mjs', import.meta.url));

  test('H1: a cycle is cut at most once, and never after it was checked or the run stopped while the cut was waiting', async () => {
    const dir = path.join(tmp, 'cutonce');
    const marker = path.join(tmp, 'cutonce-fired.txt');
    const fire = JSON.stringify([process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(marker)}, 'x')`]);
    const cut = (run, cycle, seconds) => [cli, 'cut', '--dir', dir, '--run', run, '--cycle', String(cycle), '--min-seconds', String(seconds), '--max-seconds', String(seconds), '--command-json', fire];
    const waiting = async (args) => { const c = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let err = ''; c.stderr.on('data', (d) => { err += d; }); await once(c.stdout, 'data'); return { exit: async () => { const [code] = await once(c, 'exit'); return { code, err }; } }; };
    for (const run of ['x1', 'x2', 'x3', 'x4']) mk(dir, { run, failureModel: 'HARNESS-SMOKE' });
    const srv = await serve(dir);
    const begin = async (run) => (await callerFor(srv.base, dir, run)('POST', `/runs/${run}/cycles/1/start`, { pgSystemId: pg(run), proc: 'a', workers: 1, dbHead: 0, sizing: { maxSeconds: 600 }, readiness: null })).data.cycleId;
    const kinds = (run) => runStore(dir, run).events().filter((e) => e.cycle === 1).map((e) => e.kind);

    // 1. The operator runs `cut` again while the first is still waiting for its random moment.
    await begin('x1');
    const first = await waiting(cut('x1', 1, 2));
    const second = spawnSync(process.execPath, cut('x1', 1, 0), { encoding: 'utf8', timeout: 20_000 });
    assert.equal(second.status, 1, 'the second cut is refused');
    assert.match(second.stderr, /already has a cut scheduled/);
    assert.equal((await first.exit()).code, 0);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'x', 'the cut command ran exactly once');
    assert.equal(kinds('x1').filter((k) => k === 'cut_sent').length, 1);
    assert.match(spawnSync(process.execPath, cut('x1', 1, 0), { encoding: 'utf8' }).stderr, /already cut/);

    // 2. The cycle is checked while the cut is waiting: nothing is cut afterwards.
    fs.rmSync(marker);
    const id2 = await begin('x2');
    const late = await waiting(cut('x2', 1, 2));
    assert.equal((await callerFor(srv.base, dir, 'x2')('POST', '/runs/x2/cycles/1/result', { cycleId: id2, verdict: 'INCONCLUSIVE', inconclusive: ['NO_CUT_RECORDED'], needsRecovery: [] })).status, 200);
    const ended = await late.exit();
    assert.equal(ended.code, 1);
    assert.match(ended.err, /was checked while the cut was waiting: nothing was cut/);
    assert.ok(!fs.existsSync(marker), 'the cut command never ran');
    assert.ok(!kinds('x2').includes('cut_sent'));

    // 3. A cut whose process died while waiting does not block the cycle: its schedule is void.
    await begin('x3');
    runStore(dir, 'x3').event({ cycle: 1, kind: 'cut_scheduled', delayMs: 5000, pid: spawnSync(process.execPath, ['-e', '']).pid });
    assert.equal(spawnSync(process.execPath, cut('x3', 1, 0), { encoding: 'utf8', timeout: 20_000 }).status, 0);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'x');

    // 4. The run is stopped while the cut is waiting: nothing is cut afterwards.
    fs.rmSync(marker);
    await begin('x4');
    const stoppedMeanwhile = await waiting(cut('x4', 1, 2));
    runStore(dir, 'x4').stop({ kind: 'recovery-failed', cycle: 1, reason: 'unit test: stopped during the wait' });
    const refusedAfterStop = await stoppedMeanwhile.exit();
    assert.equal(refusedAfterStop.code, 1);
    assert.match(refusedAfterStop.err, /the run was stopped while the cut was waiting: nothing was cut/);
    assert.ok(!fs.existsSync(marker), 'the cut command never ran');
    assert.ok(!kinds('x4').includes('cut_sent'));
    await srv.close();
  });

  test('H2: the source the recorder verified at create-run is pinned to the run; both hosts changing to the same other code is refused', () => {
    const dir = path.join(tmp, 'pinned');
    createRun(dir, { run: 'h2', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    const run = runStore(dir, 'h2').run();
    assert.deepEqual(run.sourceTree, SOURCE, 'the verified digest is stored in the run\'s write-once record');
    assert.equal(recorderBindingOf(dir, 'h2').identity.sourceTreeSha256, SOURCE.sha256, 'and bound');
    const test0 = TB(pg('h2'), 1);
    assert.equal(identityRefusal(run, test0), null);
    const other = { sha256: 'ab'.repeat(32), files: SOURCE.files };
    const moved = TB(pg('h2'), 1, { source: other });
    assert.equal(identityRefusal(run, moved, other), 'recorder_source_changed_since_create_run', 'the two hosts agree with each other, but not with what was verified');
    assert.equal(identityRefusal(run, test0, other), 'recorder_source_changed_since_create_run');
    assert.equal(identityRefusal(run, moved), 'source_differs_from_the_recorder');
    assert.equal(identityRefusal({ ...run, sourceTree: undefined }, test0), 'identity_missing', 'a run with no pinned source cannot be made ready');
  });

  test('M4: nothing is appended to a ledger that ends in a fragment, so the fragment can never fuse with a new record', () => {
    const f = path.join(fs.mkdtempSync(path.join(tmp, 'torn-')), 'events.jsonl');
    appendDurable(f, { n: 1 });
    fs.appendFileSync(f, '{"n":2,"ki'); // the process died in the middle of a write
    const before = fs.readFileSync(f);
    assert.throws(() => appendDurable(f, { n: 3 }), /ends in an incomplete line/);
    assert.ok(fs.readFileSync(f).equals(before), 'the file is left exactly as it was found');
    assert.deepEqual(readLedger(f), { entries: [{ n: 1 }], tornBytes: 10 }, 'and stays readable: the fragment is reported, not parsed');
    // The registry: a torn tail there is refused the same way, instead of breaking every later read.
    const dir = path.join(tmp, 'tornreg');
    mk(dir, { run: 'tr', failureModel: 'HARNESS-SMOKE' });
    fs.appendFileSync(path.join(dir, 'volumes.jsonl'), '{"pgSystemId":"7');
    assert.throws(() => registerVolume(dir, { pgSystemId: '7999999999999999993', run: 'tr2', failureModel: 'HARNESS-SMOKE' }), /ends in an incomplete line/);
    assert.equal(volumeOwner(dir, pg('tr')).run, 'tr', 'what was recorded before is still readable');
  });

  test('M2: the sizing the recorder keeps for a qualifying start is the bound workload, whatever the request claims', async () => {
    const dir = path.join(tmp, 'sizing');
    mk(dir, { run: 'sz', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    makeReady(dir, 'sz', 1);
    const srv = await serve(dir);
    const r = await callerFor(srv.base, dir, 'sz')('POST', '/runs/sz/cycles/1/start', { pgSystemId: pg('sz'), proc: 'a', workers: 1, dbHead: 0, readiness: TB(pg('sz'), 1), sizing: { maxSeconds: 86400, ratePerWorker: 1, quietRate: 999, rateSource: 'as sent' } });
    assert.match(r.data.cycleId, /^[0-9a-f]{32}$/);
    const stored = runStore(dir, 'sz').events().find((e) => e.kind === 'cycle_start').sizing;
    assert.deepEqual([stored.maxSeconds, stored.ratePerWorker, stored.quietRate, stored.burstSeconds, stored.poolPerWorker, stored.workers, stored.rateSource], [600, 100, 20, 10, 40000, 1, 'as sent']);
    // The cut's timing limit comes from that: a cut that could come after the 600 seconds the pool was sized for is refused.
    assert.match(cutRefusal(cycleView(runStore(dir, 'sz'), 1), 700_000, Date.now()), /sized for 600 s/);
    assert.equal(cutRefusal(cycleView(runStore(dir, 'sz'), 1), 500_000, Date.now()), null);
    await srv.close();
  });

  test('a run whose stop marker was lost between the result and the stop is still stopped at the next start', async () => {
    const dir = path.join(tmp, 'halfstop');
    mk(dir, { run: 'hs', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    makeReady(dir, 'hs', 1);
    const srv = await serve(dir);
    const call = callerFor(srv.base, dir, 'hs');
    const go = (cycle, dbHead) => call('POST', `/runs/hs/cycles/${cycle}/start`, { pgSystemId: pg('hs'), proc: 'a', workers: 1, dbHead, readiness: TB(pg('hs'), 1) });
    const id = (await go(1, 0)).data.cycleId;
    // The recorder stored the INCONCLUSIVE result and died before it wrote the stop marker.
    runStore(dir, 'hs').saveResult(1, { cycleId: id, cycle: 1, verdict: 'INCONCLUSIVE', inconclusive: ['POWER_LOSS_NOT_CONFIRMED'], needsRecovery: [] });
    assert.equal(runStore(dir, 'hs').stopped(), null);
    assert.equal((await call('POST', '/runs/hs/cycles/1/recovered', { cycleId: id, finalState: FS })).status, 200);
    assert.equal((await go(2, 9)).data.error, 'run_has_a_result_that_stops_it', 'the series does not go on past an inconclusive cycle');
    await srv.close();
  });
});

describe('the quiet-rate floor at the recorder (accepted 18 November 2026: at least 0.2 claims per second)', () => {
  test('a readiness record is refused at 0.19 and accepted at 0.2, and a record written by hand below the floor starts nothing', async () => {
    const dir = path.join(tmp, 'quiet-floor');
    for (const run of ['qf1', 'qf2']) mk(dir, { run, failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    const srv = await serve(dir);
    const post = (run, p, body) => callerFor(srv.base, dir, run)('POST', `/runs/${run}/${p}`, body);
    const withQuiet = (run, q) => TB(pg(run), 1, { workload: { ...FACTS('', 1).workload, quietRate: q } });
    const readiness = (run) => runStore(dir, run).events().filter((e) => e.kind === 'readiness');

    // Through the real endpoint: below the floor nothing is recorded, whatever else is in place.
    for (const q of [0.01, 0.19]) {
      const low = await post('qf1', 'readiness', { test: withQuiet('qf1', q) });
      assert.equal(low.status, 409, `quiet rate ${q}`);
      assert.match(low.data.error, /^readiness_not_ready: workload: the quiet rate must be at least 0\.2 claims per second/);
    }
    assert.equal(readiness('qf1').length, 0, 'no refused attempt left a record');
    // The floor itself is eligible; it is recorded, and a start on it is vetted.
    const ok = await post('qf1', 'readiness', { test: withQuiet('qf1', 0.2) });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(readiness('qf1')[0].binding.test.workload.quietRate, 0.2);
    assert.deepEqual((await post('qf1', 'cycles/1/start', { pgSystemId: pg('qf1'), proc: 'a', workers: 1, dbHead: 0, vet: true, readiness: withQuiet('qf1', 0.2) })).data, { vetted: true });

    // A record below the floor can only get into the ledger by hand. It is consistent (its digest matches), and the
    // start reports exactly that workload, so it is not stale: the floor itself must refuse it, at the start.
    const binding = { test: withQuiet('qf2', 0.1), recorder: recorderBindingOf(dir, 'qf2') };
    runStore(dir, 'qf2').event({ cycle: null, kind: 'readiness', binding, digest: digestOf(binding) });
    const start = await post('qf2', 'cycles/1/start', { pgSystemId: pg('qf2'), proc: 'a', workers: 1, dbHead: 0, readiness: binding.test });
    assert.equal(start.status, 409);
    assert.match(start.data.error, /^readiness_not_ready: workload: the quiet rate must be at least 0\.2 claims per second/);
    assert.ok(!runStore(dir, 'qf2').events().some((e) => e.kind === 'cycle_start'), 'nothing was started');
    await srv.close();
  });
});
