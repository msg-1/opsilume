// Final verification mission: decisions that must not depend on a wall clock, a bounded log under replay, a replay after
// a recorder restart (F16) and a lost answer to the cycle start (F8). Each reproduced here before its fix.
// HARNESS tests only: in-process recorders on temporary directories, loopback only. Nothing here is a power cut.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecorder, createRun, cycleView, runStore } from '../recorder.mjs';
import { keyFromHex, makeClient, runTag, signRequest } from '../lib/protocol.mjs';
import { startCycle } from '../lib/worker.mjs';
import { markOf } from './helpers/cut.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-fv-'));
const PG = '6950000000000000001';
const realNow = Date.now.bind(Date);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withClock = async (shiftMs, fn) => { const real = Date.now; Date.now = () => real() + shiftMs; try { return await fn(); } finally { Date.now = real; } };

async function recorder(run, { open = true, opts = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'r-'));
  createRun(dir, { run, failureModel: 'HARNESS-SMOKE' });
  const root = path.join(dir, 'runs', run);
  const key = keyFromHex(fs.readFileSync(path.join(dir, 'keys', `${run}.key`), 'utf8'));
  const x = { dir, run, root, key, store: () => runStore(dir, run), rejections: path.join(root, 'rejections.jsonl') };
  let server;
  const listen = async () => {
    server = createRecorder(dir, opts);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    x.base = `http://127.0.0.1:${server.address().port}`;
    x.call = makeClient({ baseUrl: x.base, key, run });
  };
  x.post = (p, body) => x.call('POST', `/runs/${run}/${p}`, body).then((r) => ({ status: 200, data: r.data }), (e) => ({ status: e.status, data: e.data }));
  x.raw = async (method, p, text = '', sign = {}) => {
    const headers = signRequest(key, { method, path: `/runs/${run}/${p}`, run, body: text, ...sign });
    const r = await fetch(`${x.base}/runs/${run}/${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: text || undefined });
    return { status: r.status, data: await r.json().catch(() => null), headers };
  };
  x.restart = async () => { await new Promise((r) => server.close(r)); await listen(); };
  x.close = () => new Promise((r) => server.close(r));
  x.startBody = (dbHead = 0) => ({ pgSystemId: PG, proc: 'a', workers: 1, dbHead, sizing: { maxSeconds: 600 } });
  x.ack = (n, kind, seq) => x.post('ack', { cycle: 1, cycleId: x.cycleId, proc: 'a', worker: 1, n, kind, seq, actionId: `${runTag(run)}c0001aw1-${seq}` });
  x.pass = () => x.post('cycles/1/result', { cycleId: x.cycleId, verdict: 'PASS', needsRecovery: [], ...markOf(x.store()) });
  x.count = () => cycleView(x.store(), 1).authenticatedRejections;
  await listen();
  await x.post('event', { kind: 'volume_claimed', volume: { pgSystemId: PG, publicRelations: 0, stateEntries: 0, walLsnBytes: 1, serverVersion: '16.14' } });
  await x.post('event', { kind: 'initialised', installationId: 'inst-1' });
  if (open) { x.cycleId = (await x.post('cycles/1/start', x.startBody())).data.cycleId; assert.match(x.cycleId, /^[0-9a-f]{32}$/); }
  return x;
}

describe('silent-stop detection does not depend on the recorder\'s wall clock', () => {
  test('a worker silent before the cut is found although the clock was set back a minute before the cut', async () => {
    const x = await recorder('m1');
    assert.equal((await x.ack(1, 'claim', 1)).status, 200);
    await sleep(450);
    await withClock(-60_000, () => x.store().event({ cycle: 1, kind: 'cut_sent', how: 'manual' }));
    const v = cycleView(x.store(), 1, { silentStopMs: 200 });
    assert.equal(v.silentWorkerStops.length, 1, 'its last acknowledgement was 450 ms before the cut; the limit is 200 ms');
    await x.close();
  });
  test('every acknowledgement, event and rejection carries the recorder host\'s monotonic time', async () => {
    const x = await recorder('m3');
    await x.ack(1, 'claim', 1); await x.ack(9, 'claim', 9);
    const all = [...x.store().events(), ...x.store().acks(1), ...x.store().rejections()];
    assert.ok(all.length >= 5 && all.every((r) => Number.isFinite(r.mono)), 'mono on every record');
    await x.close();
  });
});

describe('a test machine whose clock is wrong is not refused for it', () => {
  test('a client whose clock is an hour ahead: its boot report is accepted, and nothing counts against the open cycle', async () => {
    const x = await recorder('t1', { opts: { now: realNow } });
    await withClock(+3_600_000, async () => {
      const late = makeClient({ baseUrl: x.base, key: x.key, run: 't1' }); // a client that starts with the wrong clock, as after a power cut
      const r = await late('POST', '/runs/t1/boot', { bootId: 'b1' });
      assert.equal(r.data.ok, true);
    });
    assert.equal(x.count(), 0);
    await x.ack(1, 'claim', 1); cut(x);
    assert.equal((await x.pass()).status, 200);
    await x.close();
  });
  test('a clock that is corrected by an hour AFTER the client started changes nothing either', async () => {
    const x = await recorder('t2', { opts: { now: realNow } });
    assert.equal((await x.ack(1, 'claim', 1)).status, 200);
    await withClock(-3_600_000, async () => { assert.equal((await x.ack(2, 'dispatch', 1)).status, 200); });
    assert.equal(x.count(), 0);
    await x.close();
  });
  test('the time request is read-only: nothing is written for it, a replay of it is answered again, and a bad MAC is refused', async () => {
    const x = await recorder('t3');
    const before = fs.readdirSync(x.root, { recursive: true }).map((f) => [f, fs.statSync(path.join(x.root, f)).size]);
    const first = await x.raw('POST', 'time');
    assert.equal(first.status, 200);
    const replay = await fetch(`${x.base}/runs/t3/time`, { method: 'POST', headers: first.headers });
    assert.equal(replay.status, 200);
    assert.equal((await x.raw('POST', 'time', '', { now: 1 })).status, 200, 'whatever the sender\'s clock says');
    assert.deepEqual(fs.readdirSync(x.root, { recursive: true }).map((f) => [f, fs.statSync(path.join(x.root, f)).size]), before);
    assert.equal((await fetch(`${x.base}/runs/t3/time`, { method: 'POST', headers: { ...first.headers, 'x-p7-mac': '0'.repeat(64) } })).status, 401);
    assert.equal(x.count(), 0);
    await x.close();
  });
  test('a raw request with a timestamp an hour old is still refused as stale, and counts (a replay cannot be told from it)', async () => {
    const x = await recorder('t4');
    assert.equal((await x.raw('POST', 'boot', '{}', { now: Date.now() - 3_600_000 })).status, 401);
    assert.equal(x.count(), 1);
    await x.close();
  });
});

describe('F16: a signed request from before a recorder restart is not accepted by the restarted recorder', () => {
  test('a request the earlier server answered with an error (nothing persisted) is refused when replayed after the restart', async () => {
    const x = await recorder('f16', { open: false });
    const body = JSON.stringify({ ...x.startBody(), vet: true });
    const sign = { now: Date.now(), nonce: 'ab'.repeat(16) };
    await sleep(5);
    await x.restart(); // the first server never saw this request: it stands for one answered 503 or 500, whose nonce was not persisted
    const replay = await x.raw('POST', 'cycles/1/start', body, sign);
    assert.deepEqual([replay.status, replay.data.error], [401, 'signed_before_this_server_started']);
    assert.equal((await x.post('cycles/1/start', { ...x.startBody(), vet: true })).data.vetted, true, 'a request signed now is served');
    await x.close();
  });
});

describe('replayed and stale requests cannot grow the run\'s rejection log without limit', () => {
  test('past the cap they are refused as before, not written, and held against the open cycle in memory', async () => {
    const x = await recorder('rg', { opts: { unauthenticatedLogCapBytes: 900 } });
    const stale = () => x.raw('POST', 'boot', '{}', { now: Date.now() - 3_600_000 });
    for (let i = 0; i < 12; i += 1) assert.equal((await stale()).status, 401);
    const size = fs.statSync(x.rejections).size;
    assert.ok(size > 900 && size < 1500, `stopped just past the cap: ${size}`);
    for (let i = 0; i < 5; i += 1) assert.equal((await stale()).status, 401);
    assert.equal(fs.statSync(x.rejections).size, size);
    assert.ok(x.count() >= 1);
    const view = (await x.call('GET', '/runs/rg/cycles/1')).data;
    assert.match(view.damage.recorderMemory, /not written/);
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_the_recorder_marked_damaged');
    assert.ok(fs.statSync(x.rejections).size > size, 'a refusal of a request signed now is always written');
    await x.close();
  });
});

describe('F8: a lost answer to the cycle start does not leave a cycle that cannot start', () => {
  const lostOnce = (x, { deliver }) => {
    let lost = false;
    return async (method, p, body) => {
      if (!lost && /\/start$/.test(p) && !body.vet) { lost = true; if (deliver) await x.call(method, p, body); throw new Error('The operation was aborted due to timeout'); }
      return x.call(method, p, body);
    };
  };
  test('the start was recorded and its answer lost: the process continues with the recorded cycle id; nothing is recorded twice', async () => {
    const x = await recorder('f8a', { open: false });
    const r = await startCycle({ call: lostOnce(x, { deliver: true }), run: 'f8a', cycle: 1, proc: 'a', body: x.startBody() });
    const starts = x.store().events().filter((e) => e.kind === 'cycle_start');
    assert.equal(starts.length, 1);
    assert.deepEqual([r.cycleId, r.answerLost], [starts[0].cycleId, true]);
    assert.equal(cycleView(x.store(), 1).authenticatedRejections, 0);
    await x.close();
  });
  test('the start never arrived: it is sent once more and recorded once', async () => {
    const x = await recorder('f8b', { open: false });
    const r = await startCycle({ call: lostOnce(x, { deliver: false }), run: 'f8b', cycle: 1, proc: 'a', body: x.startBody() });
    assert.equal(x.store().events().filter((e) => e.kind === 'cycle_start').length, 1);
    assert.match(r.cycleId, /^[0-9a-f]{32}$/);
    await x.close();
  });
  test('a refusal is a refusal: thrown as it is, never sent again', async () => {
    const x = await recorder('f8c', { open: false });
    let sent = 0;
    const call = (m, p, b) => { sent += 1; return x.call(m, p, b); };
    await assert.rejects(startCycle({ call, run: 'f8c', cycle: 1, proc: 'a', body: { ...x.startBody(), workers: 99 } }), (e) => e.status === 400 && e.data.error === 'invalid_start');
    assert.equal(sent, 1);
    await x.close();
  });
  test('if the recorder cannot be asked either, the original failure is thrown and nothing is sent again', async () => {
    const x = await recorder('f8d', { open: false });
    const call = async () => { throw new Error('timeout'); };
    await assert.rejects(startCycle({ call, run: 'f8d', cycle: 1, proc: 'a', body: x.startBody() }), /timeout/);
    await x.close();
  });
});

// Findings of the final independent review (J1 to J4 and smaller ones), each reproduced here before its fix.
import { savedResultProblem } from '../lib/attempts.mjs';
import { LOCK_FILE } from '../lib/lock.mjs';
const cut = (x, confirmed = 'yes') => { x.store().event({ cycle: 1, kind: 'cut_sent', how: 'manual' }); if (confirmed) x.store().event({ cycle: 1, kind: 'cut_confirmed', powerWasCut: confirmed }); };

describe('J2: the recorder stores no PASS against what it holds itself about the cut and the workers', () => {
  test('no cut on record: PASS refused; INCONCLUSIVE stored', async () => {
    const x = await recorder('j2a');
    await x.ack(1, 'claim', 1);
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_without_a_recorded_cut');
    assert.equal((await x.post('cycles/1/result', { cycleId: x.cycleId, verdict: 'INCONCLUSIVE', needsRecovery: [] })).status, 200);
    await x.close();
  });
  test('a cut that is not confirmed, or whose confirmation was withdrawn: PASS refused', async () => {
    const x = await recorder('j2b');
    await x.ack(1, 'claim', 1); cut(x, null);
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_whose_cut_is_not_confirmed');
    const y = await recorder('j2bw'); // confirmed, then withdrawn: the last confirmation decides
    await y.ack(1, 'claim', 1); cut(y);
    y.store().event({ cycle: 1, kind: 'cut_confirmed', powerWasCut: 'no' });
    assert.equal((await y.pass()).data.error, 'pass_for_a_cycle_whose_cut_is_not_confirmed');
    assert.deepEqual([x.store().result(1), y.store().result(1)], [null, null]);
    await x.close(); await y.close();
  });
  test('a worker stop on record before the cut, or a worker silent before it: PASS refused', async () => {
    const x = await recorder('j2c');
    await x.ack(1, 'claim', 1);
    assert.equal((await x.post('event', { cycle: 1, cycleId: x.cycleId, kind: 'worker_stopped', proc: 'a', worker: 1 })).status, 200);
    cut(x);
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_whose_workload_stopped_before_the_cut');
    const y = await recorder('j2d', { opts: { silentStopMs: 100 } });
    await y.ack(1, 'claim', 1); await sleep(250); cut(y);
    assert.equal((await y.pass()).data.error, 'pass_for_a_cycle_whose_workload_stopped_before_the_cut');
    await x.close(); await y.close();
  });
  test('a cycle with a confirmed cut and a worker that acknowledged just before it: PASS stored', async () => {
    const x = await recorder('j2e');
    await x.ack(1, 'claim', 1); cut(x);
    assert.equal((await x.pass()).status, 200);
    await x.close();
  });
});

describe('J1: a saved PASS is not sent again when the view no longer shows a confirmed cut and a running workload', () => {
  test('savedResultProblem names it', () => {
    const saved = { verdict: 'PASS' };
    const ok = { damaged: false, authenticatedRejections: 0, journalWriteFailures: [], cutRequestedAt: 'x', cutConfirmed: 'yes', workerStopsBeforeCut: [], silentWorkerStops: [] };
    assert.equal(savedResultProblem(saved, ok), null);
    assert.match(savedResultProblem(saved, { ...ok, cutConfirmed: 'no' }), /not confirmed/);
    assert.match(savedResultProblem(saved, { ...ok, cutRequestedAt: null }), /no cut/);
    assert.match(savedResultProblem(saved, { ...ok, silentWorkerStops: [{}] }), /stopped before the cut/);
    assert.match(savedResultProblem(saved, { ...ok, workerStopsBeforeCut: [{}] }), /stopped before the cut/);
  });
});

describe('J3/J4: a request answered outside the ordinary refusal still counts', () => {
  test('J3: a worker stop report answered "busy" (the lock is held): no PASS for the open cycle afterwards', async () => {
    const x = await recorder('j3', { opts: { lockTimeoutMs: 200 } });
    await x.ack(1, 'claim', 1);
    fs.writeFileSync(path.join(x.dir, LOCK_FILE), JSON.stringify({ pid: process.pid, at: Date.now() }));
    let r;
    try { r = await x.post('event', { cycle: 1, cycleId: x.cycleId, kind: 'worker_stopped', proc: 'a', worker: 1 }); } finally { fs.rmSync(path.join(x.dir, LOCK_FILE), { force: true }); }
    assert.equal(r.status, 503);
    cut(x);
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_the_recorder_marked_damaged');
    await x.close();
  });
  test('J4: a request refused because the volume registry is inconsistent is held against the open cycle: no PASS afterwards', async () => {
    const x = await recorder('j4');
    await x.ack(1, 'claim', 1);
    const reg = path.join(x.dir, 'volumes.jsonl');
    fs.appendFileSync(reg, fs.readFileSync(reg, 'utf8')); // a duplicated line
    const r = await x.post('event', { kind: 'initialised', installationId: 'again' });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /volume_registry_inconsistent/);
    assert.equal(x.count(), 0, 'the run\'s records are not touched while the registry is inconsistent (a committed test pins that)');
    cut(x);
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_the_recorder_marked_damaged', 'it is held in this server\'s memory against the open cycle');
    await x.close();
  });
});

describe('smaller findings of the final review', () => {
  test('a worker is called silent if EITHER clock says so: a host that was suspended (the monotonic clock stands still) hides nothing', async () => {
    const x = await recorder('k1');
    await x.ack(1, 'claim', 1);
    await withClock(+60_000, () => x.store().event({ cycle: 1, kind: 'cut_sent', how: 'manual' }));
    assert.equal(cycleView(x.store(), 1, { silentStopMs: 5000 }).silentWorkerStops.length, 1);
    await x.close();
  });
  test('startCycle continues only with its OWN recorded start (same boot id and head), never with another process\'s', async () => {
    const x = await recorder('k2', { open: false });
    await x.post('cycles/1/start', { ...x.startBody(), bootId: 'other-boot' }); // someone else's start for proc a
    let lost = false;
    const call = async (m, p, b) => { if (!lost && /\/start$/.test(p)) { lost = true; throw new Error('timeout'); } return x.call(m, p, b); };
    await assert.rejects(startCycle({ call, run: 'k2', cycle: 1, proc: 'a', body: { ...x.startBody(), bootId: 'mine' } }), (e) => e.data?.error === 'process_already_started_in_cycle');
    await x.close();
  });
});

// Findings of the last review round (K1 to K3), each reproduced here before its fix.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const CLI = fileURLToPath(new URL('../recorder.mjs', import.meta.url));
describe('last review round', () => {
  test('K1: an acknowledgement AFTER the cut was requested does not undo a worker\'s silence before it', async () => {
    const x = await recorder('k1b', { opts: { silentStopMs: 200 } });
    await x.ack(1, 'claim', 1);
    await sleep(450);
    x.store().event({ cycle: 1, kind: 'cut_sent', how: 'manual' });
    assert.equal(cycleView(x.store(), 1, { silentStopMs: 200 }).silentWorkerStops.length, 1);
    assert.equal((await x.ack(2, 'dispatch', 1)).status, 200, 'the late acknowledgement is still stored as evidence');
    assert.equal(cycleView(x.store(), 1, { silentStopMs: 200 }).silentWorkerStops.length, 1, 'and changes nothing about the silence before the cut');
    x.store().event({ cycle: 1, kind: 'cut_confirmed', powerWasCut: 'yes' });
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_whose_workload_stopped_before_the_cut');
    await x.close();
  });
  test('K2: the cut confirmation cannot be changed once the cycle has its result', async () => {
    const x = await recorder('k2b');
    await x.ack(1, 'claim', 1); cut(x);
    assert.equal((await x.pass()).status, 200);
    const r = spawnSync(process.execPath, [CLI, 'confirm-cut', '--dir', x.dir, '--run', 'k2b', '--cycle', '1', '--power-was-cut', 'no'], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /already has its result/);
    assert.equal(cycleView(x.store(), 1).cutConfirmed, 'yes');
    await x.close();
  });
  test('K3: startCycle sends an id of its own with the start and continues only with the start that carries it', async () => {
    const x = await recorder('k3', { open: false });
    await x.post('cycles/1/start', { ...x.startBody(), bootId: 'same-boot' }); // an earlier invocation's start: same letter, boot and head
    let lost = false;
    const call = async (m, p, b) => { if (!lost && /\/start$/.test(p)) { lost = true; throw new Error('timeout'); } return x.call(m, p, b); };
    await assert.rejects(startCycle({ call, run: 'k3', cycle: 1, proc: 'a', body: { ...x.startBody(), bootId: 'same-boot' } }), (e) => e.data?.error === 'process_already_started_in_cycle');
    const y = await recorder('k3b', { open: false });
    let dropped = false;
    const lossy = async (m, p, b) => { if (!dropped && /\/start$/.test(p)) { dropped = true; await y.call(m, p, b); throw new Error('timeout'); } return y.call(m, p, b); };
    const r = await startCycle({ call: lossy, run: 'k3b', cycle: 1, proc: 'a', body: y.startBody() });
    const starts = y.store().events().filter((e) => e.kind === 'cycle_start');
    assert.deepEqual([starts.length, r.cycleId, r.answerLost, typeof starts[0].startId], [1, starts[0].cycleId, true, 'string']);
    await x.close(); await y.close();
  });
});
