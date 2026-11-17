// Deterministic tests of the P7 recorder protocol and state machine (in-process server, temporary directories).
// HARNESS tests only: they say nothing about durability. Run: node --test prototype/m16-p7/test/
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { keyFromHex, makeClient, nextStream, runTag, signRequest, verifyRequest, WINDOW_MS } from '../lib/protocol.mjs';
import { finalStatus, physicalStreak } from '../lib/verdict.mjs';
import { compareBackup, createRecorder, createRun, cutRefusal, cycleView, dirReport, dirState, recorderBindingOf, recorderId, registerVolume, registryProblem, runStore, volumeOf, volumeOwner } from '../recorder.mjs';
import { bindingDiff, digestOf, testBinding, vetTestBinding } from '../lib/readiness.mjs';
import { REQUIRED_ATTESTATIONS } from '../lib/preflight.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-recorder-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const STORAGE = { driveModel: 'Example SSD 1TB', firmware: '1B2QEXM7', controller: 'NVMe (PCIe)', dbDevice: 'nvme0n1p2', journalDevice: 'nvme0n1p2', filesystem: 'ext4 rw,relatime', vendorDoc: 'vendor datasheet rev 3, section 4.2', evidenceFiles: 'host/baseline/*', writeCache: 'write back', fua: 'yes', flushSupported: 'yes', flushesObserved: 'yes', vendorFlushSemantics: 'yes', plp: 'unknown' };
const FS = { installationId: 'inst-1', head: 9, headHash: 'ab'.repeat(32) };
/** A run whose volumes were initialised (what `p7.mjs init` reports after creating the schema on an empty database). */
const pg = (run) => String(7000000000000000000n + BigInt(`0x${createHash('sha256').update(run).digest('hex').slice(0, 12)}`)); // a system identifier per test run
/** What the test machine reports for a ready configuration (p7.mjs gathers these facts read-only). */
const FACTS = (pgSystemId, workers = 1, over = {}) => ({
  pgSystemId, journal: { markerSha256: 'aa'.repeat(32), installationId: 'inst-1' },
  settings: { fsync: 'on', full_page_writes: 'on', synchronous_commit: 'on', wal_sync_method: 'fdatasync', data_checksums: 'off', server_version: '16.14' },
  netcheck: { strict: true, ok: true, bridges: ['172.22.0.1', '172.23.0.1'], probes: [{ name: 'host or bridge 172.22.0.1:22' }, { name: 'host or bridge 172.23.0.1:22' }] },
  workload: { procs: 2, workers, maxSeconds: 600, headroom: 2, ratePerWorker: 100, targetRate: null, poolPerWorker: 120000 }, ...over,
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
    const bad = (run, over, pattern, model = 'POWER-CUT') => assert.throws(() => createRun(dir, { run, failureModel: model, storage: { ...STORAGE, ...over } }), pattern);
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
    assert.equal(createRun(dir, { run: 'q7', failureModel: 'POWER-CUT', storage: { ...STORAGE, fua: 'not-advertised' } }).run.storage.flushesObserved, 'yes');
    assert.equal(createRun(dir, { run: 'q8', failureModel: 'POWER-CUT', storage: { ...STORAGE, writeCache: 'write through', flushesObserved: 'no' } }).run.storage.fua, 'yes', 'write through with working FUA');
    assert.ok(createRun(dir, { run: 's1', failureModel: 'HARNESS-SMOKE' }).keyFile);
    assert.ok(!fs.existsSync(runStore(dir, 'q1').root), 'nothing is created for a refused run');
  });
  test('the key is 256 bits, mode 0600, outside the run record, and a run id cannot be reused', () => {
    const { keyFile, run } = createRun(dir, { run: 'p1', failureModel: 'POWER-CUT', storage: STORAGE });
    assert.match(fs.readFileSync(keyFile, 'utf8'), /^[0-9a-f]{64}\n$/);
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(run).includes(fs.readFileSync(keyFile, 'utf8').trim()));
    assert.throws(() => createRun(dir, { run: 'p1', failureModel: 'POWER-CUT', storage: STORAGE }), /already exists/);
  });
});

describe('recorder protocol and state machine', () => {
  const dir = path.join(tmp, 'rec');
  let srv, call, cycleId;
  const ack = (body) => call('POST', '/runs/p/ack', { cycle: 1, cycleId, ...body });
  const act = (proc, w, k) => T('p', `c0001${proc}w${w}-${k}`);
  before(async () => {
    mk(dir, { run: 'p', failureModel: 'POWER-CUT', storage: STORAGE });
    createRun(dir, { run: 'other', failureModel: 'POWER-CUT', storage: STORAGE });
    srv = await serve(dir);
    call = callerFor(srv.base, dir, 'p');
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
    assert.equal((await call('POST', '/runs/p/cycles/2/start', { pgSystemId: pg('p'), proc: 'a', workers: 2, dbHead: 0 })).status, 409);
    const a = await call('POST', '/runs/p/cycles/1/start', { pgSystemId: pg('p'), proc: 'a', workers: 2, dbHead: 0, bootId: 'boot-1' });
    assert.match(a.data.cycleId, /^[0-9a-f]{32}$/);
    cycleId = a.data.cycleId;
    assert.equal((await call('POST', '/runs/p/cycles/1/start', { pgSystemId: pg('p'), proc: 'a', workers: 2, dbHead: 0 })).data.error, 'process_already_started_in_cycle');
    assert.equal((await call('POST', '/runs/p/cycles/1/start', { pgSystemId: pg('p'), proc: 'b', workers: 2, dbHead: 3 })).data.cycleId, cycleId);
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
    const acks = runStore(dir, 'p').acks(1);
    assert.equal(acks.length, 12);
    for (const [proc, w] of plan) assert.deepEqual(acks.filter((x) => x.proc === proc && x.worker === w).map((x) => x.n), [1, 2, 3, 4]);
  });

  test('duplicate, replayed, out-of-order, mismatched and foreign acknowledgements are refused and leave the file unchanged', async () => {
    const file = path.join(runStore(dir, 'p').root, 'acks', 'cycle-0001.jsonl');
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
    assert.equal((await call('POST', '/runs/p/ack', { cycle: 1, cycleId: 'f'.repeat(32), proc: 'a', worker: 1, n: 5, kind: 'claim', seq: 9, actionId: act('a', 1, 9) })).data.error, 'wrong_cycle_id');
    assert.equal((await call('POST', '/runs/p/ack', { cycle: 2, cycleId, proc: 'a', worker: 1, n: 5, kind: 'claim', seq: 9, actionId: act('a', 1, 9) })).data.error, 'cycle_not_open');
    assert.equal(sha(file), before);
    assert.ok(cycleView(runStore(dir, 'p'), 1).authenticatedRejections >= cases.length + 2);
  });

  test('a byte-for-byte replay of an accepted request is refused, also after the recorder restarts', async () => {
    const body = JSON.stringify({ cycle: 1, cycleId, proc: 'a', worker: 1, n: 5, kind: 'claim', seq: 7, actionId: act('a', 1, 7) });
    const h = signRequest(keyOf(dir, 'p'), { method: 'POST', path: '/runs/p/ack', run: 'p', body });
    assert.equal((await rawSend(srv.base, 'POST', '/runs/p/ack', h, body)).status, 200);
    assert.equal((await rawSend(srv.base, 'POST', '/runs/p/ack', h, body)).data.error, 'replayed_nonce');
    await srv.close();
    srv = await serve(dir); // restart: state comes back from disk
    call = callerFor(srv.base, dir, 'p');
    assert.equal((await rawSend(srv.base, 'POST', '/runs/p/ack', h, body)).data.error, 'replayed_nonce');
    assert.equal((await ack({ proc: 'a', worker: 1, n: 5, kind: 'claim', seq: 8, actionId: act('a', 1, 8) })).data.error, 'duplicate_or_replayed', 'the stream position survived the restart');
    assert.equal((await ack({ proc: 'a', worker: 1, n: 6, kind: 'dispatch', seq: 7, actionId: act('a', 1, 7) })).status, 200);
  });

  test('an acknowledgement at or below the cycle start head is refused', async () => {
    // The cycle's window starts at the lowest head any process reported at its start (0 here).
    assert.equal((await ack({ proc: 'b', worker: 1, n: 5, kind: 'claim', seq: 0, actionId: act('b', 1, 0) })).data.error, 'outside_cycle');
  });

  test('decision 2: a PASS with the journal one claim ahead counts only after observed quarantine and clearance', async () => {
    const result = { cycleId, verdict: 'PASS', quarantineRequired: true, uncommitted: { seq: 9, actionId: act('a', 1, 9) }, needsRecovery: ['clear'] };
    assert.equal((await call('POST', '/runs/p/cycles/1/result', result)).status, 200);
    assert.equal(cycleView(runStore(dir, 'p'), 1).final, 'PENDING_RECOVERY');
    assert.equal((await call('POST', '/runs/p/cycles/2/start', { pgSystemId: pg('p'), proc: 'a', workers: 2, dbHead: 9 })).data.error, 'previous_cycle_not_recovered');
    assert.equal((await call('POST', '/runs/p/cycles/1/recovered', { finalState: FS, cycleId, cleared: true, uncommitted: result.uncommitted })).data.error, 'quarantine_not_observed');
    assert.equal((await call('POST', '/runs/p/event', { cycle: 1, cycleId, kind: 'quarantine_observed', detail: 'database head 8 is behind the journal head 9' })).status, 200);
    assert.equal((await call('POST', '/runs/p/cycles/1/recovered', { finalState: FS, cycleId, cleared: false })).data.error, 'clearance_not_shown');
    assert.equal((await call('POST', '/runs/p/cycles/1/recovered', { finalState: FS, cycleId, cleared: true, uncommitted: { seq: 8, actionId: 'x' } })).data.error, 'clearance_not_shown');
    const ok = await call('POST', '/runs/p/cycles/1/recovered', { finalState: FS, cycleId, cleared: true, uncommitted: result.uncommitted, digest: 'd' });
    assert.equal(ok.data.final, 'PASS');
    assert.equal((await call('POST', '/runs/p/cycles/1/recovered', { finalState: FS, cycleId, cleared: true, uncommitted: result.uncommitted })).data.error, 'already_recovered', 'repeated recovery');
    assert.deepEqual(runStore(dir, 'p').accepted().map((u) => [u.seq, u.actionId]), [[9, act('a', 1, 9)]]);
    assert.equal((await call('POST', '/runs/p/cycles/1/result', { cycleId, verdict: 'PASS' })).data.error, 'cycle_not_open', 'a result is write-once');
  });

  test('decision 1: an INCONCLUSIVE cycle in a qualifying run stops it and breaks the series', async () => {
    const c2 = (await call('POST', '/runs/p/cycles/2/start', { pgSystemId: pg('p'), proc: 'a', workers: 2, dbHead: 9 })).data.cycleId;
    assert.equal((await call('POST', '/runs/p/cycles/2/result', { cycleId: c2, verdict: 'INCONCLUSIVE', inconclusive: ['POWER_LOSS_NOT_CONFIRMED'], needsRecovery: [] })).data.stopped, true);
    assert.equal((await call('POST', '/runs/p/cycles/3/start', { pgSystemId: pg('p'), proc: 'a', workers: 2, dbHead: 9 })).data.error, 'run_stopped');
    assert.equal((await call('POST', '/runs/p/cycles/1/recovered', { finalState: FS, cycleId })).data.error, 'run_stopped', 'only the inconclusive cycle may still be recovered');
    assert.equal((await call('POST', '/runs/p/cycles/2/recovered', { cycleId: c2 })).data.error, 'final_state_missing');
    assert.equal((await call('POST', '/runs/p/cycles/2/recovered', { finalState: FS, cycleId: c2 })).status, 200, 'so that a new run can continue this state');
    assert.equal((await call('POST', '/runs/p/cycles/3/start', { pgSystemId: pg('p'), proc: 'a', workers: 2, dbHead: 9 })).data.error, 'run_stopped', 'still stopped');
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
    mk(dir, { run: 'f', failureModel: 'POWER-CUT', storage: STORAGE });
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
    mk(dir, { run: 'a1', failureModel: 'POWER-CUT', storage: STORAGE });
    const call = callerFor(srv.base, dir, 'a1');
    assert.throws(() => createRun(dir, { run: 'a2', failureModel: 'POWER-CUT', storage: STORAGE, continues: 'a1' }), /not stopped/, 'before any cycle');
    // cycle 1: PASS with the journal one claim ahead -> quarantine, clearance: one claim accepted as never committed
    const id1 = (await call('POST', '/runs/a1/cycles/1/start', { pgSystemId: pg('a1'), proc: 'a', workers: 1, dbHead: 0 })).data.cycleId;
    const unc = { seq: 31, actionId: T('a1', 'c0001aw1-31') };
    await call('POST', '/runs/a1/cycles/1/result', { cycleId: id1, verdict: 'PASS', quarantineRequired: true, uncommitted: unc, needsRecovery: ['clear'] });
    await call('POST', '/runs/a1/event', { cycle: 1, cycleId: id1, kind: 'quarantine_observed' });
    assert.equal((await call('POST', '/runs/a1/cycles/1/recovered', { cycleId: id1, cleared: true, uncommitted: unc, digest: 'd', finalState: { ...S1, head: 31 } })).data.final, 'PASS');
    // cycle 2: INCONCLUSIVE -> the run stops
    const id2 = (await call('POST', '/runs/a1/cycles/2/start', { pgSystemId: pg('a1'), proc: 'a', workers: 1, dbHead: 31 })).data.cycleId;
    assert.throws(() => createRun(dir, { run: 'a2', failureModel: 'POWER-CUT', storage: STORAGE, continues: 'a1' }), /not stopped/, 'while a cycle is open');
    assert.equal((await call('POST', '/runs/a1/cycles/2/result', { cycleId: id2, verdict: 'INCONCLUSIVE', inconclusive: ['POWER_LOSS_NOT_CONFIRMED'], needsRecovery: [] })).data.stopped, true);
    assert.throws(() => createRun(dir, { run: 'a2', failureModel: 'POWER-CUT', storage: STORAGE, continues: 'a1' }), /has not been recovered/, 'recovery is never skipped');
    assert.equal((await call('POST', '/runs/a1/cycles/2/recovered', { cycleId: id2, finalState: S1 })).status, 200);
    const before = frozen('a1');
    const { run } = createRun(dir, { run: 'a2', failureModel: 'POWER-CUT', storage: STORAGE, continues: 'a1' });
    assert.deepEqual(run.continues, { run: 'a1', failureModel: 'POWER-CUT', lastCycle: 2, finalState: S1, stopped: { kind: 'inconclusive', cycle: 2 } });
    assert.deepEqual(runStore(dir, 'a2').accepted().map((u) => [u.seq, u.actionId, u.fromRun]), [[31, unc.actionId, 'a1']], 'accepted claims carry over');
    assert.notEqual(fs.readFileSync(runStore(dir, 'a2').keyFile, 'utf8'), fs.readFileSync(runStore(dir, 'a1').keyFile, 'utf8'), 'a new key');
    assert.throws(() => createRun(dir, { run: 'a3', failureModel: 'POWER-CUT', storage: STORAGE, continues: 'a1' }), /already continues/);
    // The reverse direction: qualifying state is never continued by a smoke or supplementary run.
    assert.throws(() => createRun(dir, { run: 'a4', failureModel: 'HARNESS-SMOKE', continues: 'a1' }), /HARNESS-SMOKE run cannot continue POWER-CUT state/);
    assert.throws(() => createRun(dir, { run: 'a5', failureModel: 'VM-CRASH', storage: STORAGE, continues: 'a1' }), /VM-CRASH run cannot continue POWER-CUT state/);
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
    mk(dir, { run: 'f1', failureModel: 'POWER-CUT', storage: STORAGE });
    let call = callerFor(srv.base, dir, 'f1');
    let id = (await call('POST', '/runs/f1/cycles/1/start', { pgSystemId: pg('f1'), proc: 'a', workers: 1, dbHead: 0 })).data.cycleId;
    await call('POST', '/runs/f1/cycles/1/result', { cycleId: id, verdict: 'FAIL', fails: ['JOURNAL_CORRUPT'] });
    assert.equal((await call('POST', '/runs/f1/cycles/1/recovered', { cycleId: id, finalState: S1 })).status, 409);
    assert.throws(() => createRun(dir, { run: 'f2', failureModel: 'POWER-CUT', storage: STORAGE, continues: 'f1' }), /failed/);
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
    createRun(dir, { run: 'z1', failureModel: 'POWER-CUT', storage: STORAGE }); // a fresh run id pointed at existing volumes
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
    mk(dir, { run: 'h1', failureModel: 'POWER-CUT', storage: STORAGE });
    const call = callerFor(srv.base, dir, 'h1');
    const id = (await call('POST', '/runs/h1/cycles/1/start', { pgSystemId: pg('h1'), proc: 'a', workers: 1, dbHead: 0 })).data.cycleId;
    await call('POST', '/runs/h1/cycles/1/result', { cycleId: id, verdict: 'INCONCLUSIVE', needsRecovery: ['repair-torn-tail'] });
    assert.equal(runStore(dir, 'h1').stopped().kind, 'inconclusive');
    assert.equal((await call('POST', '/runs/h1/stop', { cycle: 1, reason: 'recovery: torn-tail repair did not verify' })).status, 200);
    assert.equal(runStore(dir, 'h1').stopped().kind, 'inconclusive', 'the marker is write-once');
    assert.ok(runStore(dir, 'h1').events().some((e) => e.kind === 'recovery_failed'), 'but the failure is on record');
    assert.equal((await call('POST', '/runs/h1/cycles/1/recovered', { cycleId: id, finalState: S })).data.error, 'recovery_failed_earlier');
    assert.throws(() => createRun(dir, { run: 'h2', failureModel: 'POWER-CUT', storage: STORAGE, continues: 'h1' }), /recovery failed/);
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
    assert.throws(() => createRun(dir, { run: 'p-bad', failureModel: 'POWER-CUT', storage: STORAGE, continues: 's1' }), /POWER-CUT run cannot continue HARNESS-SMOKE state/);
    assert.throws(() => createRun(dir, { run: 'v-bad', failureModel: 'VM-CRASH', storage: STORAGE, continues: 's1' }), /VM-CRASH run cannot continue HARNESS-SMOKE state/);
    assert.ok(!fs.existsSync(runStore(dir, 'p-bad').root) && !fs.existsSync(runStore(dir, 'p-bad').keyFile), 'nothing is created');
    assert.equal(createRun(dir, { run: 's2', failureModel: 'HARNESS-SMOKE', continues: 's1' }).run.rootRun, 's1', 'smoke continues smoke');
  });

  test('a POWER-CUT run cannot claim volumes any earlier run used, even after their contents were removed', async () => {
    createRun(dir, { run: 'pc1', failureModel: 'POWER-CUT', storage: STORAGE });
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
    const r = run('create-run', '--new-directory', '--run', 'pc', '--failure-model', 'POWER-CUT', '--storage-json', template);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /driveModel is missing or unknown[\s\S]*vendorDoc is missing[\s\S]*writeCache must be/);
    assert.ok(!fs.existsSync(path.join(dir, 'keys', 'pc.key')));
    const filled = path.join(tmp, 'storage-filled.json');
    fs.writeFileSync(filled, JSON.stringify({ ...JSON.parse(fs.readFileSync(template, 'utf8')), ...STORAGE }));
    const ok = run('create-run', '--new-directory', '--run', 'pc', '--failure-model', 'POWER-CUT', '--storage-json', filled);
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
    assert.equal((await call('POST', '/runs/pc/cycles/1/start', { ...body, vet: true })).data.error, 'not_initialised');
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
    createRun(dir, { run: 'pc1', failureModel: 'POWER-CUT', storage: STORAGE });
    assert.equal(fs.readFileSync(reg, 'utf8'), afterSmoke, 'creating a qualifying run does not touch the registry');
    assert.equal((await claim('pc1', X1)).data.error, 'volume_already_used_by_s1');
    assert.equal((await claim('pc1', X2)).status, 200);
    const afterPc = fs.readFileSync(reg, 'utf8');
    assert.ok(afterPc.startsWith(afterSmoke) && afterPc.trim().split('\n').length === 2, 'one line appended; the smoke entry is untouched');
    assert.equal(runStore(dir, 'pc1').events().find((e) => e.kind === 'volume_claimed').pgSystemId, X2, 'the run\'s own ledger records the cluster too');
    await srv.close(); srv = await serve(dir); // a restarted recorder reads the same history
    assert.equal(fs.readFileSync(reg, 'utf8'), afterPc);
    createRun(dir, { run: 'pc2', failureModel: 'POWER-CUT', storage: STORAGE });
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
    createRun(dir, { run: 'pc1b', failureModel: 'POWER-CUT', storage: STORAGE, continues: 'pc1' });
    createRun(dir, { run: 'pc3', failureModel: 'POWER-CUT', storage: STORAGE });
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
      assert.throws(() => createRun(dir, { run: 'pc9', failureModel: 'POWER-CUT', storage: STORAGE }), /volume_registry_inconsistent/, `create-run, registry ${how}`);
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
  const post = (run, p, body) => callerFor(srv.base, dir, run)('POST', `/runs/${run}/${p}`, body);
  const attest = (run) => { for (const item of REQUIRED_ATTESTATIONS) runStore(dir, run).event({ cycle: null, kind: 'attestation', item, evidence: `done for ${run}`, attestation: 'operator' }); };
  // Every start below states its own `readiness` half, so the helper's automatic "preflight" never runs here.
  const start = (run, id, over = {}, t = TB(id, 2)) => post(run, 'cycles/1/start', { pgSystemId: id, proc: 'a', workers: 2, dbHead: 0, vet: true, readiness: t, ...over });
  /** claim, init, attest, then a real preflight record through the endpoint. */
  async function ready(run, id, o = {}) {
    createRun(dir, { run, failureModel: 'POWER-CUT', storage: STORAGE, ...o });
    assert.equal((await post(run, 'event', { kind: 'volume_claimed', volume: EMPTY(id) })).status, 200);
    assert.equal((await post(run, 'event', { kind: 'initialised', installationId: 'inst-1' })).status, 200);
    attest(run);
    const r = await post(run, 'readiness', { test: TB(id, 2) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  }
  before(async () => { srv = await serve(dir); });
  after(() => srv.close());

  test('without a record a start is refused; the recorder records readiness only when it can confirm its own half', async () => {
    createRun(dir, { run: 'q1', failureModel: 'POWER-CUT', storage: STORAGE });
    assert.equal((await post('q1', 'readiness', { test: TB(X(1), 2) })).data.error, 'not_initialised');
    await post('q1', 'event', { kind: 'volume_claimed', volume: EMPTY(X(1)) });
    await post('q1', 'event', { kind: 'initialised', installationId: 'inst-1' });
    assert.equal((await post('q1', 'readiness', { test: TB(X(1), 2) })).data.error, 'attestations_missing');
    attest('q1');
    assert.equal((await start('q1', X(1))).data.error, 'readiness_missing', 'ready facts at start are not a record');
    const bad = {
      'fsync, full_page_writes and synchronous_commit are not all on': { settings: { ...FACTS().settings, fsync: 'off' } },
      'did not run in strict mode': { netcheck: { ...FACTS().netcheck, strict: false } },
      'strict network check did not pass': { netcheck: { ...FACTS().netcheck, ok: false } },
      'probed 1 bridge address\\(es\\), not 2': { netcheck: { ...FACTS().netcheck, bridges: ['172.22.0.1'] } },
      'probed 0 bridge address': { netcheck: { ...FACTS().netcheck, bridges: [] } },
      'network check has no probes': { netcheck: { ...FACTS().netcheck, probes: [] } },
      'journal volume has no identity': { journal: { markerSha256: '', installationId: 'inst-1' } },
      'workload: --workers must be a whole number': { workload: { ...FACTS('', 0).workload } },
      'workload: pool 10 per worker is too small': { workload: { ...FACTS('', 2).workload, poolPerWorker: 10 } },
      'workload: .*exceeds the 1000000': { workload: { ...FACTS('', 12).workload } },
      'workload: ratePerWorker must be a positive number': { workload: { ...FACTS('', 2).workload, ratePerWorker: null } },
      'workload: pool must be a positive integer': { workload: { ...FACTS('', 2).workload, poolPerWorker: null } },
    };
    for (const [why, over] of Object.entries(bad)) assert.match((await post('q1', 'readiness', { test: TB(X(1), over.workload?.workers ?? 2, over) })).data.error, new RegExp(`^readiness_not_ready: .*${why}`), why);
    for (const junk of [undefined, null, 'READY', { status: 'READY_FOR_OPERATOR_REVIEW' }, []]) assert.match((await post('q1', 'readiness', { test: junk })).data.error, /^readiness_not_ready/, 'a bare claim of readiness is nothing');
    assert.equal((await post('q1', 'readiness', { test: TB(X(9), 2) })).data.error, 'volume_differs_from_series');
    assert.ok(!runStore(dir, 'q1').events().some((e) => e.kind === 'readiness'), 'no refused attempt left a record');
    const rec = (await post('q1', 'readiness', { test: TB(X(1), 2) })).data;
    assert.match(rec.digest, /^[0-9a-f]{64}$/);
    const ev = runStore(dir, 'q1').events().filter((e) => e.kind === 'readiness');
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0].binding.recorder.run, ev[0].binding.recorder.failureModel, ev[0].binding.recorder.recorderId, ev[0].binding.test.pgSystemId], ['q1', 'POWER-CUT', recorderId(dir), X(1)]);
    assert.deepEqual(ev[0].binding.recorder.attestations.items, [...REQUIRED_ATTESTATIONS].sort());
    assert.equal(ev[0].digest, digestOf(ev[0].binding));
    const status = (await callerFor(srv.base, dir, 'q1')('GET', '/runs/q1')).data;
    assert.deepEqual([status.readiness.digest, status.readiness.workload.workers, status.readiness.workload.poolPerWorker], [rec.digest, 2, 120000]);
    assert.deepEqual((await start('q1', X(1))).data, { vetted: true });
    assert.match((await start('q1', X(1), { vet: undefined })).data.cycleId, /^[0-9a-f]{32}$/);
    assert.equal(runStore(dir, 'q1').events().find((e) => e.kind === 'cycle_start').bindingDigest, rec.digest, 'the cycle records which readiness record it started under');
    assert.equal((await post('q1', 'readiness', { test: TB(X(1), 2) })).data.error, 'readiness_only_before_the_first_cycle');
  });

  test('any change to the bound configuration invalidates the record, naming what changed; undoing the change restores it', async () => {
    await ready('q2', X(2));
    const stale = async (over, paths, workers = 2) => {
      const r = await start('q2', X(2), { workers }, TB(X(2), workers, over));
      assert.match(r.data.error ?? 'accepted', new RegExp(`^readiness_stale: ${paths}$`), JSON.stringify(over));
      assert.deepEqual((await start('q2', X(2))).data, { vetted: true }, 'the recorded configuration is still accepted');
    };
    const F = FACTS(X(2), 2);
    await stale({ journal: { markerSha256: 'bb'.repeat(32), installationId: 'inst-1' } }, 'test.journal.markerSha256');
    await stale({ journal: { markerSha256: 'aa'.repeat(32), installationId: 'inst-2' } }, 'test.journal.installationId');
    await stale({ settings: { ...F.settings, wal_sync_method: 'open_datasync' } }, 'test.postgresql.digest, test.postgresql.settings.wal_sync_method');
    await stale({ settings: { ...F.settings, server_version: '16.15' } }, 'test.postgresql.digest, test.postgresql.settings.server_version');
    await stale({ settings: { ...F.settings, data_checksums: 'on' } }, 'test.postgresql.digest, test.postgresql.settings.data_checksums');
    await stale({ netcheck: { ...F.netcheck, bridges: ['172.22.0.1', '172.29.0.1'], probes: [{ name: 'host or bridge 172.22.0.1:22' }, { name: 'host or bridge 172.29.0.1:22' }] } }, 'test.firewall.bridges, test.firewall.digest');
    await stale({ netcheck: { ...F.netcheck, probes: [...F.netcheck.probes, { name: 'one more destination' }] } }, 'test.firewall.digest, test.firewall.probes');
    await stale({ workload: { ...F.workload, procs: 1 } }, 'test.workload.procs');
    await stale({ workload: { ...F.workload, maxSeconds: 599 } }, 'test.workload.maxSeconds');
    await stale({ workload: { ...F.workload, headroom: 2.5, poolPerWorker: 150000 } }, 'test.workload.headroom, test.workload.poolPerWorker');
    await stale({ workload: { ...F.workload, ratePerWorker: 99 } }, 'test.workload.ratePerWorker');
    await stale({ workload: { ...F.workload, poolPerWorker: 120001 } }, 'test.workload.poolPerWorker');
    await stale({ workload: { ...F.workload, targetRate: 100 } }, 'test.workload.targetRate');
    await stale({}, 'test.workload.workers', 3);
    // A configuration that is no longer ready at all is refused as such, whatever the record says.
    assert.match((await start('q2', X(2), {}, TB(X(2), 2, { settings: { ...F.settings, synchronous_commit: 'off' } }))).data.error, /^readiness_not_ready: fsync/);
    assert.match((await start('q2', X(2), {}, TB(X(2), 2, { netcheck: { ...F.netcheck, ok: false } }))).data.error, /^readiness_not_ready: the strict network check did not pass/);
    assert.equal((await start('q2', X(2), { readiness: undefined })).data.error ?? 'accepted', 'accepted', '(the helper supplies the recorded half when a test gives none)');
    assert.match((await post('q2', 'cycles/1/start', { pgSystemId: X(2), proc: 'a', workers: 2, dbHead: 0, vet: true, readiness: null })).data.error, /^readiness_not_ready/, 'a start that reports nothing is refused');
    assert.equal((await start('q2', X(9), {}, TB(X(9), 2))).data.error, 'volume_differs_from_series', 'another database cluster');
    // The start itself must be the recorded workload: this many workers, one of the recorded processes.
    assert.equal((await start('q2', X(2), { workers: 1 })).data.error, 'start_differs_from_ready_workload');
    assert.equal((await start('q2', X(2), { proc: 'c' })).data.error, 'start_differs_from_ready_workload', 'two processes were recorded: a and b');
    assert.deepEqual((await start('q2', X(2), { proc: 'b' })).data, { vetted: true });

    // The recorder's own half. Each file is put back afterwards (a test may; an operator restores from the backup).
    const edit = async (file, change, paths) => {
      const original = fs.readFileSync(file);
      fs.writeFileSync(file, change(original.toString()));
      assert.match((await start('q2', X(2))).data.error ?? 'accepted', new RegExp(`^readiness_stale: ${paths}$`), file);
      fs.writeFileSync(file, original);
      assert.deepEqual((await start('q2', X(2))).data, { vetted: true }, 'restored');
    };
    await edit(path.join(dir, 'recorder-id.json'), (t) => t.replace(/"id": "[0-9a-f]{4}/, '"id": "0000'), 'recorder.recorderId');
    await edit(path.join(runStore(dir, 'q2').root, 'run.json'), (t) => t.replace(STORAGE.firmware, 'OTHERFW1'), 'recorder.storageDigest');
    await edit(path.join(dir, 'volumes.jsonl'), (t) => t.replace(/"at":"(\d{4})/, '"at":"1999'), 'recorder.registry.sha256');
    // The registry is bound byte for byte: any later claim on this recorder, by any run, ends the validity for good.
    createRun(dir, { run: 'q2-smoke', failureModel: 'HARNESS-SMOKE' });
    assert.deepEqual((await start('q2', X(2))).data, { vetted: true }, 'creating a run does not touch the registry');
    assert.equal((await post('q2-smoke', 'event', { kind: 'volume_claimed', volume: EMPTY(X(20)) })).status, 200);
    assert.equal((await start('q2', X(2))).data.error, 'readiness_stale: recorder.registry.bytes, recorder.registry.sha256');
    assert.equal((await post('q2', 'readiness', { test: TB(X(2), 2) })).status, 200, 'before the first cycle, a new preflight records the new state');
    assert.deepEqual((await start('q2', X(2))).data, { vetted: true });
    // An attestation recorded again (even the same words) is a change: what was attested is part of the record.
    runStore(dir, 'q2').event({ cycle: null, kind: 'attestation', item: 'firewall-verified-on-host', evidence: 'done for q2', attestation: 'operator' });
    assert.equal((await start('q2', X(2))).data.error, 'readiness_stale: recorder.attestations.digest');
  });

  test('a record is never usable by another run, on another volume, or by the run that continues the series', async () => {
    const r3 = await ready('q3', X(3));
    const event3 = fs.readFileSync(path.join(runStore(dir, 'q3').root, 'events.jsonl'), 'utf8').trim().split('\n').find((l) => JSON.parse(l).kind === 'readiness');
    // q4: initialised and attested on its own volumes, but never made ready.
    createRun(dir, { run: 'q4', failureModel: 'POWER-CUT', storage: STORAGE });
    await post('q4', 'event', { kind: 'volume_claimed', volume: EMPTY(X(4)) });
    await post('q4', 'event', { kind: 'initialised', installationId: 'inst-1' });
    attest('q4');
    assert.equal((await start('q4', X(4))).data.error, 'readiness_missing', 'q3 being ready says nothing about q4');
    assert.equal((await callerFor(srv.base, dir, 'q4', keyOf(dir, 'q3'))('POST', '/runs/q4/readiness', { test: TB(X(4), 2) })).status, 401, 'q3\'s key cannot record for q4');
    assert.equal((await post('q4', 'readiness', { test: TB(X(3), 2) })).data.error, 'volume_differs_from_series', 'q4 cannot be made ready on q3\'s volumes');
    // Someone copies q3's record into q4's ledger by hand: it names q3 and q3's volumes, so it never matches.
    fs.appendFileSync(path.join(runStore(dir, 'q4').root, 'events.jsonl'), `${event3}\n`);
    assert.match((await start('q4', X(4))).data.error, /^readiness_stale: .*recorder\.run.*test\.pgSystemId/);
    assert.equal((await start('q4', X(3), {}, TB(X(3), 2))).data.error, 'volume_differs_from_series');
    assert.equal((await post('q4', 'readiness', { test: TB(X(4), 2) })).status, 200);
    assert.notEqual(runStore(dir, 'q4').events().filter((e) => e.kind === 'readiness').at(-1).digest, r3.digest);

    // q3 runs a cycle that ends INCONCLUSIVE; q3b continues the same volumes. It needs its own attestations and record.
    const again = await post('q3', 'readiness', { test: TB(X(3), 2) }); // q4's claim changed the registry since
    const id = (await start('q3', X(3), { vet: undefined })).data.cycleId;
    await post('q3', 'cycles/1/result', { cycleId: id, verdict: 'INCONCLUSIVE', inconclusive: ['POWER_LOSS_NOT_CONFIRMED'], needsRecovery: [] });
    assert.equal((await post('q3', 'cycles/1/recovered', { cycleId: id, finalState: S })).status, 200);
    createRun(dir, { run: 'q3b', failureModel: 'POWER-CUT', storage: STORAGE, continues: 'q3' });
    assert.equal((await post('q3b', 'readiness', { test: TB(X(3), 2) })).data.error, 'not_adopted');
    assert.equal((await post('q3b', 'event', { kind: 'adopted', finalState: S, pgSystemId: X(3) })).status, 200);
    assert.equal((await post('q3b', 'readiness', { test: TB(X(3), 2) })).data.error, 'attestations_missing');
    attest('q3b');
    const next = (over) => post('q3b', 'cycles/1/start', { pgSystemId: X(3), proc: 'a', workers: 2, dbHead: 3, vet: true, readiness: TB(X(3), 2), ...over });
    assert.equal((await next()).data.error, 'readiness_missing', 'same volumes, same configuration, another run');
    const eventAgain = fs.readFileSync(path.join(runStore(dir, 'q3').root, 'events.jsonl'), 'utf8').trim().split('\n').filter((l) => JSON.parse(l).kind === 'readiness').at(-1);
    fs.appendFileSync(path.join(runStore(dir, 'q3b').root, 'events.jsonl'), `${eventAgain}\n`);
    assert.match((await next()).data.error, /^readiness_stale: .*recorder\.continues.*recorder\.run/);
    const own = await post('q3b', 'readiness', { test: TB(X(3), 2) });
    assert.equal(own.status, 200);
    assert.notEqual(own.data.digest, again.data.digest);
    assert.deepEqual([own.data.binding.recorder.run, own.data.binding.recorder.rootRun, own.data.binding.recorder.continues], ['q3b', 'q3', 'q3']);
    assert.deepEqual((await next()).data, { vetted: true });
  });

  test('readiness is for POWER-CUT runs; other run types start without it and only note the binding they ran on', async () => {
    createRun(dir, { run: 'sm', failureModel: 'HARNESS-SMOKE' });
    await post('sm', 'event', { kind: 'volume_claimed', volume: EMPTY(X(5)) });
    await post('sm', 'event', { kind: 'initialised', installationId: 'inst-1' });
    assert.equal((await post('sm', 'readiness', { test: TB(X(5), 2) })).data.error, 'readiness_is_for_power_cut_runs');
    assert.match((await post('sm', 'cycles/1/start', { pgSystemId: X(5), proc: 'a', workers: 1, dbHead: 0, readiness: TB(X(5), 1) })).data.cycleId, /^[0-9a-f]{32}$/);
    assert.match((await post('sm', 'cycles/1/start', { pgSystemId: X(5), proc: 'b', workers: 1, dbHead: 0, readiness: null })).data.cycleId, /^[0-9a-f]{32}$/);
    const starts = runStore(dir, 'sm').events().filter((e) => e.kind === 'cycle_start');
    assert.match(starts[0].bindingDigest, /^unenforced:[0-9a-f]{64}$/);
    assert.deepEqual(starts[0].bindingNoted, TB(X(5), 1), 'the reported half is kept, so a rehearsal shows which field moved');
    assert.equal(starts[1].bindingDigest, null);
  });
});

describe('recorder identity', () => {
  test('written once with the first run; a directory that has runs but no identity gets none and cannot hold a qualifying run', async () => {
    const dir = path.join(tmp, 'identity');
    assert.equal(recorderId(dir), null);
    createRun(dir, { run: 'i1', failureModel: 'POWER-CUT', storage: STORAGE });
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
    assert.throws(() => createRun(dir, { run: 'i3', failureModel: 'POWER-CUT', storage: STORAGE }), /holds runs but has no identity/);
    // The run-type and storage refusals keep their own messages there (the development smoke directory is such a directory).
    assert.throws(() => createRun(dir, { run: 'i3', failureModel: 'POWER-CUT' }), /driveModel is missing/);
    assert.throws(() => createRun(dir, { run: 'i3', failureModel: 'POWER-CUT', storage: STORAGE, continues: 'i2' }), /POWER-CUT run cannot continue HARNESS-SMOKE state/);
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
