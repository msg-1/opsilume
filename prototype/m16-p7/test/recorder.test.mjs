// Deterministic tests of the P7 recorder protocol and state machine (in-process server, temporary directories).
// HARNESS tests only: they say nothing about durability. Run: node --test prototype/m16-p7/test/
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { keyFromHex, makeClient, nextStream, signRequest, verifyRequest, WINDOW_MS } from '../lib/protocol.mjs';
import { finalStatus, physicalStreak } from '../lib/verdict.mjs';
import { createRecorder, createRun, cycleView, runStore } from '../recorder.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-recorder-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const STORAGE = { writeCache: 'write back', flushHonoured: 'yes', fua: 'yes', plp: 'unknown' };
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
    const a = (n, kind, seq, actionId = `c0001aw1-${seq}`) => ({ proc: 'a', worker: 1, n, kind, seq, actionId });
    let st = nextStream(undefined, a(1, 'claim', 5), 1).st;
    assert.equal(nextStream(st, a(1, 'claim', 6), 1).error, 'duplicate_or_replayed');
    assert.equal(nextStream(st, a(3, 'dispatch', 5), 1).error, 'out_of_order');
    assert.equal(nextStream(st, a(2, 'claim', 6), 1).error, 'out_of_order', 'a claim before the previous dispatch intent');
    assert.equal(nextStream(st, a(2, 'dispatch', 4), 1).error, 'mismatched_dispatch');
    st = nextStream(st, a(2, 'dispatch', 5), 1).st;
    assert.equal(nextStream(st, a(3, 'claim', 5), 1).error, 'out_of_order', 'claims strictly increase per stream');
    assert.equal(nextStream(st, a(3, 'claim', 9, 'c0001bw1-9'), 1).error, 'action_does_not_belong_to_this_stream');
    assert.equal(nextStream(st, a(3, 'claim', 9, 'c0002aw1-9'), 1).error, 'action_does_not_belong_to_this_stream');
    assert.ok(nextStream(st, a(3, 'claim', 9), 1).st);
  });
});

describe('createRun (decision 4)', () => {
  const dir = path.join(tmp, 'create');
  test('a qualifying run with unknown flush or FUA behaviour is refused; a smoke run is not', () => {
    assert.throws(() => createRun(dir, { run: 'q1', failureModel: 'POWER-CUT', ...STORAGE, flushHonoured: 'unknown' }), /decision 4/);
    assert.throws(() => createRun(dir, { run: 'q2', failureModel: 'POWER-CUT', ...STORAGE, fua: undefined }), /decision 4/);
    assert.throws(() => createRun(dir, { run: 'q3', failureModel: 'VM-CRASH', ...STORAGE, writeCache: 'unknown' }), /decision 4/);
    assert.ok(createRun(dir, { run: 's1', failureModel: 'HARNESS-SMOKE' }).keyFile);
    assert.ok(!fs.existsSync(runStore(dir, 'q1').root), 'nothing is created for a refused run');
  });
  test('the key is 256 bits, mode 0600, outside the run record, and a run id cannot be reused', () => {
    const { keyFile, run } = createRun(dir, { run: 'p1', failureModel: 'POWER-CUT', ...STORAGE });
    assert.match(fs.readFileSync(keyFile, 'utf8'), /^[0-9a-f]{64}\n$/);
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(run).includes(fs.readFileSync(keyFile, 'utf8').trim()));
    assert.throws(() => createRun(dir, { run: 'p1', failureModel: 'POWER-CUT', ...STORAGE }), /already exists/);
  });
});

describe('recorder protocol and state machine', () => {
  const dir = path.join(tmp, 'rec');
  let srv, call, cycleId;
  const ack = (body) => call('POST', '/runs/p/ack', { cycle: 1, cycleId, ...body });
  const act = (proc, w, k) => `c0001${proc}w${w}-${k}`;
  before(async () => {
    createRun(dir, { run: 'p', failureModel: 'POWER-CUT', ...STORAGE });
    createRun(dir, { run: 'other', failureModel: 'POWER-CUT', ...STORAGE });
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
    assert.equal((await call('POST', '/runs/p/cycles/2/start', { proc: 'a', workers: 1, dbHead: 0 })).status, 409);
    const a = await call('POST', '/runs/p/cycles/1/start', { proc: 'a', workers: 2, dbHead: 0, bootId: 'boot-1' });
    assert.match(a.data.cycleId, /^[0-9a-f]{32}$/);
    cycleId = a.data.cycleId;
    assert.equal((await call('POST', '/runs/p/cycles/1/start', { proc: 'a', workers: 1, dbHead: 0 })).data.error, 'process_already_started_in_cycle');
    assert.equal((await call('POST', '/runs/p/cycles/1/start', { proc: 'b', workers: 1, dbHead: 3 })).data.cycleId, cycleId);
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
    assert.equal((await call('POST', '/runs/p/cycles/2/start', { proc: 'a', workers: 1, dbHead: 9 })).data.error, 'previous_cycle_not_recovered');
    assert.equal((await call('POST', '/runs/p/cycles/1/recovered', { cycleId, cleared: true, uncommitted: result.uncommitted })).data.error, 'quarantine_not_observed');
    assert.equal((await call('POST', '/runs/p/event', { cycle: 1, cycleId, kind: 'quarantine_observed', detail: 'database head 8 is behind the journal head 9' })).status, 200);
    assert.equal((await call('POST', '/runs/p/cycles/1/recovered', { cycleId, cleared: false })).data.error, 'clearance_not_shown');
    assert.equal((await call('POST', '/runs/p/cycles/1/recovered', { cycleId, cleared: true, uncommitted: { seq: 8, actionId: 'x' } })).data.error, 'clearance_not_shown');
    const ok = await call('POST', '/runs/p/cycles/1/recovered', { cycleId, cleared: true, uncommitted: result.uncommitted, digest: 'd' });
    assert.equal(ok.data.final, 'PASS');
    assert.equal((await call('POST', '/runs/p/cycles/1/recovered', { cycleId, cleared: true, uncommitted: result.uncommitted })).data.error, 'already_recovered', 'repeated recovery');
    assert.deepEqual(runStore(dir, 'p').accepted().map((u) => [u.seq, u.actionId]), [[9, act('a', 1, 9)]]);
    assert.equal((await call('POST', '/runs/p/cycles/1/result', { cycleId, verdict: 'PASS' })).data.error, 'cycle_not_open', 'a result is write-once');
  });

  test('decision 1: an INCONCLUSIVE cycle in a qualifying run stops it and breaks the series', async () => {
    const c2 = (await call('POST', '/runs/p/cycles/2/start', { proc: 'a', workers: 1, dbHead: 9 })).data.cycleId;
    assert.equal((await call('POST', '/runs/p/cycles/2/result', { cycleId: c2, verdict: 'INCONCLUSIVE', inconclusive: ['POWER_LOSS_NOT_CONFIRMED'], needsRecovery: [] })).data.stopped, true);
    assert.equal((await call('POST', '/runs/p/cycles/3/start', { proc: 'a', workers: 1, dbHead: 9 })).data.error, 'run_stopped');
    assert.equal((await call('POST', '/runs/p/cycles/2/recovered', { cycleId: c2 })).data.error, 'run_stopped');
    const st = (await call('GET', '/runs/p')).data;
    assert.match(st.stopped.reason, /series broken/);
    assert.deepEqual([st.streak.consecutivePhysicalPasses, st.streak.brokenAtCycle, st.streak.brokenBy, st.streak.met], [1, 2, 'INCONCLUSIVE', false]);
  });
});

describe('recorder: FAIL, evidence retention, damage and boot evidence', () => {
  const dir = path.join(tmp, 'fail');
  let srv, call;
  before(async () => {
    createRun(dir, { run: 'f', failureModel: 'POWER-CUT', ...STORAGE });
    createRun(dir, { run: 'smoke', failureModel: 'HARNESS-SMOKE' });
    createRun(dir, { run: 'torn', failureModel: 'HARNESS-SMOKE' });
    srv = await serve(dir, { silentStopMs: 1000 });
    call = callerFor(srv.base, dir, 'f');
  });
  after(() => srv.close());

  test('a FAIL stops the run; nothing afterwards changes the recorded evidence; the rejection log only grows', async () => {
    const id = (await call('POST', '/runs/f/cycles/1/start', { proc: 'a', workers: 1, dbHead: 0 })).data.cycleId;
    assert.equal((await call('POST', '/runs/f/ack', { cycle: 1, cycleId: id, proc: 'a', worker: 1, n: 1, kind: 'claim', seq: 1, actionId: 'c0001aw1-1' })).status, 200);
    assert.equal((await call('POST', '/runs/f/cycles/1/result', { cycleId: id, verdict: 'FAIL', fails: ['ACKNOWLEDGED_CLAIM_MISSING_FROM_JOURNAL'] })).data.stopped, true);
    const root = runStore(dir, 'f').root;
    const frozen = Object.fromEntries(listFiles(root).filter((f) => f !== 'rejections.jsonl').map((f) => [f, sha(path.join(root, f))]));
    const rejFile = path.join(root, 'rejections.jsonl');
    const rejBefore = fs.existsSync(rejFile) ? fs.readFileSync(rejFile, 'utf8') : '';
    for (const [m, p, b] of [
      ['POST', '/runs/f/cycles/2/start', { proc: 'a', workers: 1, dbHead: 1 }],
      ['POST', '/runs/f/ack', { cycle: 1, cycleId: id, proc: 'a', worker: 1, n: 2, kind: 'dispatch', seq: 1, actionId: 'c0001aw1-1' }],
      ['POST', '/runs/f/cycles/1/result', { cycleId: id, verdict: 'PASS' }],
      ['POST', '/runs/f/cycles/1/recovered', { cycleId: id }],
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
    const id = (await c('POST', '/runs/smoke/cycles/1/start', { proc: 'a', workers: 1, dbHead: 0 })).data.cycleId;
    assert.equal((await c('POST', '/runs/smoke/cycles/1/result', { cycleId: id, verdict: 'INCONCLUSIVE', needsRecovery: [] })).data.stopped, false);
    assert.equal((await c('POST', '/runs/smoke/cycles/1/recovered', { cycleId: id })).status, 200);
    assert.equal((await c('POST', '/runs/smoke/cycles/2/start', { proc: 'a', workers: 1, dbHead: 0 })).status, 200);
  });

  test('a torn line in the recorder\'s own acknowledgement file blocks further acknowledgements for that cycle', async () => {
    const c = callerFor(srv.base, dir, 'torn');
    const id = (await c('POST', '/runs/torn/cycles/1/start', { proc: 'a', workers: 1, dbHead: 0 })).data.cycleId;
    assert.equal((await c('POST', '/runs/torn/ack', { cycle: 1, cycleId: id, proc: 'a', worker: 1, n: 1, kind: 'claim', seq: 1, actionId: 'c0001aw1-1' })).status, 200);
    fs.appendFileSync(path.join(runStore(dir, 'torn').root, 'acks', 'cycle-0001.jsonl'), '{"cycle":1,"ki');
    await srv.close();
    srv = await serve(dir, { silentStopMs: 1000 });
    const c2 = callerFor(srv.base, dir, 'torn');
    assert.equal((await c2('POST', '/runs/torn/ack', { cycle: 1, cycleId: id, proc: 'a', worker: 1, n: 2, kind: 'dispatch', seq: 1, actionId: 'c0001aw1-1' })).data.error, 'recorder_ack_file_damaged');
    call = callerFor(srv.base, dir, 'f');
  });

  test('cut bounds, boot reports and silent worker stops are recorded by the recorder\'s own clock', async () => {
    const c = callerFor(srv.base, dir, 'smoke');
    const s = runStore(dir, 'smoke');
    const id = cycleView(s, 2).cycleId;
    assert.equal((await c('POST', '/runs/smoke/ack', { cycle: 2, cycleId: id, proc: 'a', worker: 1, n: 1, kind: 'claim', seq: 1, actionId: 'c0002aw1-1' })).status, 200);
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
