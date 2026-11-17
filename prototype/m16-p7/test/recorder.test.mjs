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
import { createRecorder, createRun, cutRefusal, cycleView, registerVolume, registryProblem, runStore, volumeOf, volumeOwner } from '../recorder.mjs';
import { REQUIRED_ATTESTATIONS } from '../lib/preflight.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-recorder-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const STORAGE = { driveModel: 'Example SSD 1TB', firmware: '1B2QEXM7', controller: 'NVMe (PCIe)', dbDevice: 'nvme0n1p2', journalDevice: 'nvme0n1p2', filesystem: 'ext4 rw,relatime', vendorDoc: 'vendor datasheet rev 3, section 4.2', evidenceFiles: 'host/baseline/*', writeCache: 'write back', fua: 'yes', flushSupported: 'yes', flushesObserved: 'yes', vendorFlushSemantics: 'yes', plp: 'unknown' };
const FS = { installationId: 'inst-1', head: 9, headHash: 'ab'.repeat(32) };
/** A run whose volumes were initialised (what `p7.mjs init` reports after creating the schema on an empty database). */
const pg = (run) => String(7000000000000000000n + BigInt(`0x${createHash('sha256').update(run).digest('hex').slice(0, 12)}`)); // a system identifier per test run
const mk = (dir, o) => {
  const r = createRun(dir, o);
  registerVolume(dir, { pgSystemId: pg(o.run), run: o.run, failureModel: o.failureModel });
  const st = runStore(dir, o.run);
  st.event({ cycle: null, kind: 'initialised', detail: 'test' });
  if (o.failureModel === 'POWER-CUT') for (const item of REQUIRED_ATTESTATIONS) st.event({ cycle: null, kind: 'attestation', item, evidence: 'test', attestation: 'operator' });
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
    assert.equal((await call('POST', '/runs/p/cycles/2/start', { pgSystemId: pg('p'), proc: 'a', workers: 1, dbHead: 0 })).status, 409);
    const a = await call('POST', '/runs/p/cycles/1/start', { pgSystemId: pg('p'), proc: 'a', workers: 2, dbHead: 0, bootId: 'boot-1' });
    assert.match(a.data.cycleId, /^[0-9a-f]{32}$/);
    cycleId = a.data.cycleId;
    assert.equal((await call('POST', '/runs/p/cycles/1/start', { pgSystemId: pg('p'), proc: 'a', workers: 1, dbHead: 0 })).data.error, 'process_already_started_in_cycle');
    assert.equal((await call('POST', '/runs/p/cycles/1/start', { pgSystemId: pg('p'), proc: 'b', workers: 1, dbHead: 3 })).data.cycleId, cycleId);
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
    assert.equal((await call('POST', '/runs/p/cycles/2/start', { pgSystemId: pg('p'), proc: 'a', workers: 1, dbHead: 9 })).data.error, 'previous_cycle_not_recovered');
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
    const r = run('create-run', '--run', 'pc', '--failure-model', 'POWER-CUT', '--storage-json', template);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /driveModel is missing or unknown[\s\S]*vendorDoc is missing[\s\S]*writeCache must be/);
    assert.ok(!fs.existsSync(path.join(dir, 'keys', 'pc.key')));
    const filled = path.join(tmp, 'storage-filled.json');
    fs.writeFileSync(filled, JSON.stringify({ ...JSON.parse(fs.readFileSync(template, 'utf8')), ...STORAGE }));
    const ok = run('create-run', '--run', 'pc', '--failure-model', 'POWER-CUT', '--storage-json', filled);
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
