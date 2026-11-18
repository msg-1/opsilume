// The recorder-side PASS gate (D1), after its independent review: findings G1 to G3, each reproduced here before its fix.
// HARNESS tests only: in-process recorders on temporary directories, loopback only. Nothing here is a power cut.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmedCut, markOf } from './helpers/cut.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecorder, createRun, cycleView, dirReport, runLedgerDamage, runStore } from '../recorder.mjs';
import { keyFromHex, makeClient, runTag, signRequest } from '../lib/protocol.mjs';
import { savedResultProblem } from '../lib/attempts.mjs';
import { runFlagProblem } from '../lib/sizing.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-d1-'));
const PG = '6900000000000000001';
const FINAL = { installationId: 'inst-1', head: 1, headHash: 'ab'.repeat(32) };
const FRAGMENT = '{"reason":"frag';

/** A recorder on a temporary directory, initialised; `open: true` (the default) starts cycle 1 with one claim and its dispatch. */
async function recorder(run, { open = true, cut = true, opts = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'r-'));
  createRun(dir, { run, failureModel: 'HARNESS-SMOKE' });
  const root = path.join(dir, 'runs', run);
  const key = keyFromHex(fs.readFileSync(path.join(dir, 'keys', `${run}.key`), 'utf8'));
  const x = { dir, run, root, store: () => runStore(dir, run), events: path.join(root, 'events.jsonl'), rejections: path.join(root, 'rejections.jsonl') };
  let server, base;
  const listen = async () => {
    server = createRecorder(dir, opts);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    x.call = makeClient({ baseUrl: base, key, run });
  };
  x.post = (p, body) => x.call('POST', `/runs/${run}/${p}`, body).then((r) => ({ status: 200, data: r.data }), (e) => ({ status: e.status, data: e.data }));
  x.view = async (n = 1) => (await x.call('GET', `/runs/${run}/cycles/${n}`)).data;
  // A request signed with the run's key and sent as given: any body text, any path, and its own clock or nonce.
  x.raw = async (method, p, text = '', sign = {}) => {
    const headers = signRequest(key, { method, path: `/runs/${run}/${p}`, run, body: text, ...sign });
    const r = await fetch(`${base}/runs/${run}/${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: text || undefined });
    return { status: r.status, data: await r.json(), headers };
  };
  x.base = () => base;
  x.restart = async () => { await new Promise((r) => server.close(r)); await listen(); };
  x.close = () => new Promise((r) => server.close(r));
  x.start = async (n, dbHead) => (await x.post(`cycles/${n}/start`, { pgSystemId: PG, proc: 'a', workers: 1, dbHead, sizing: { maxSeconds: 600 } })).data.cycleId;
  x.ack = (cycle, cycleId, n, kind, seq) => x.post('ack', { cycle, cycleId, proc: 'a', worker: 1, n, kind, seq, actionId: `${runTag(run)}c${String(cycle).padStart(4, '0')}aw1-${seq}` });
  x.pass = (n = 1, cycleId = x.cycleId) => x.post(`cycles/${n}/result`, { cycleId, verdict: 'PASS', needsRecovery: [], ...markOf(x.store(), n) });
  x.count = (n = 1) => cycleView(x.store(), n).authenticatedRejections;
  // Closes cycle 1 (INCONCLUSIVE, recovered) and opens cycle 2.
  x.second = async () => {
    await x.post('cycles/1/result', { cycleId: x.cycleId, verdict: 'INCONCLUSIVE', needsRecovery: [] });
    await x.post('cycles/1/recovered', { cycleId: x.cycleId, finalState: FINAL });
    x.cycleId2 = await x.start(2, 1);
    assert.match(x.cycleId2, /^[0-9a-f]{32}$/);
    assert.equal((await x.ack(2, x.cycleId2, 1, 'claim', 2)).status, 200);
    confirmedCut(x.store(), 2);
  };
  await listen();
  await x.post('event', { kind: 'volume_claimed', volume: { pgSystemId: PG, publicRelations: 0, stateEntries: 0, walLsnBytes: 1, serverVersion: '16.14' } });
  await x.post('event', { kind: 'initialised', installationId: 'inst-1' });
  if (open) {
    x.cycleId = await x.start(1, 0);
    await x.ack(1, x.cycleId, 1, 'claim', 1); await x.ack(1, x.cycleId, 2, 'dispatch', 1);
    if (cut) confirmedCut(x.store()); // (a PASS presupposes a recorded, confirmed cut)
  }
  return x;
}
const badAck = (x, cycle = 1, cycleId = 'f'.repeat(32)) => x.post('ack', { cycle, cycleId, proc: 'a', worker: 1, n: 3, kind: 'claim', seq: 9, actionId: 'x' }); // refused: wrong_cycle_id
const restarts = (x, n = 1) => x.store().events().filter((e) => e.kind === 'recorder_restarted' && e.cycle === n).length;
const withClock = async (shiftMs, fn) => { const real = Date.now; Date.now = () => real() + shiftMs; try { return await fn(); } finally { Date.now = real; } };

describe('G1: a refusal the recorder could record nowhere is not forgotten by a restart', () => {
  test('both ledgers unwritable when the request is refused, writable again later: after a restart the PASS is still not stored', async () => {
    const x = await recorder('g1a');
    fs.chmodSync(x.rejections.replace('rejections', 'events'), 0o444); fs.writeFileSync(x.rejections, ''); fs.chmodSync(x.rejections, 0o444);
    const refused = await badAck(x);
    assert.deepEqual([refused.status, refused.data], [500, { error: 'refusal_not_recorded', refused: 'wrong_cycle_id', fallback: 'none' }]);
    fs.chmodSync(x.events, 0o644); fs.chmodSync(x.rejections, 0o644); // the storage problem passes
    assert.equal(x.store().rejections().length + x.store().events().filter((e) => e.kind === 'refusal_not_recorded').length, 0, 'the refusal is in no ledger');
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_the_recorder_marked_damaged', 'this server remembers');
    await x.restart(); // its memory is gone
    const pass = await x.pass();
    assert.deepEqual([pass.status, pass.data.error], [409, 'pass_for_a_cycle_the_recorder_marked_damaged']);
    assert.equal(x.store().result(1), null);
    const v = await x.view();
    assert.equal(v.damaged, true);
    assert.match(v.damage.recorderRestarted, /restarted while this cycle was open/);
    assert.match(savedResultProblem({ verdict: 'PASS' }, v), /restarted while this cycle was open/, 'and check will not send a saved PASS');
    await x.close();
  });

  test('a replayed request refused while the rejection log cannot be written (memory only): a restart does not clear the cycle', async () => {
    const x = await recorder('g1b');
    const body = JSON.stringify({ cycle: 1, cycleId: x.cycleId, proc: 'a', worker: 1, n: 3, kind: 'claim', seq: 2, actionId: `${runTag('g1b')}c0001aw1-2` });
    const first = await x.raw('POST', 'ack', body);
    assert.equal(first.status, 200);
    fs.writeFileSync(x.rejections, ''); fs.chmodSync(x.rejections, 0o444);
    const replay = await x.raw('POST', 'ack', body, { now: Number(first.headers['x-p7-ts']), nonce: first.headers['x-p7-nonce'] });
    assert.deepEqual([replay.status, replay.data.error, replay.data.fallback], [500, 'refusal_not_recorded', 'none'], 'a replay never writes an event');
    fs.chmodSync(x.rejections, 0o644);
    await x.restart();
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_the_recorder_marked_damaged');
    assert.equal(x.store().result(1), null);
    await x.close();
  });

  test('the restart is recorded once per server, as an event of the open cycle; acknowledgements go on; INCONCLUSIVE closes the cycle', async () => {
    const x = await recorder('g1c');
    assert.equal(restarts(x), 0, 'the server that started the cycle records no restart');
    await x.restart();
    await x.view(); await x.view();
    assert.equal(restarts(x), 1);
    assert.equal((await x.ack(1, x.cycleId, 3, 'claim', 2)).status, 200, 'the streams continue where the ledger ends');
    await x.restart(); await x.view();
    assert.equal(restarts(x), 2, 'every server that takes over an open cycle says so');
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_the_recorder_marked_damaged');
    // Not a dead end, and recovery is as for any INCONCLUSIVE cycle.
    assert.equal((await x.post('cycles/1/recovered', { cycleId: x.cycleId, finalState: FINAL })).data.error, 'nothing_to_recover', 'no recovery while the cycle has no result');
    assert.equal((await x.post('cycles/1/result', { cycleId: x.cycleId, verdict: 'INCONCLUSIVE', inconclusive: ['RECORDER_CYCLE_RECORDS_DAMAGED'], needsRecovery: [] })).status, 200);
    assert.equal((await x.post('cycles/1/recovered', { cycleId: x.cycleId, finalState: FINAL })).data.final, 'INCONCLUSIVE');
    await x.close();
  });

  test('the restart cannot be recorded (the event ledger is not writable): that server refuses the PASS from memory, and the next one records its own restart', async () => {
    const x = await recorder('g1d');
    fs.chmodSync(x.events, 0o444);
    await x.restart(); // second server: cannot write its restart
    assert.equal((await x.view()).damage.recorderMemory, 'the recorder restarted while this cycle was open and could not record it');
    fs.chmodSync(x.events, 0o644);
    assert.equal(restarts(x), 0, 'nothing was claimed to be recorded');
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_the_recorder_marked_damaged');
    fs.chmodSync(x.events, 0o444);
    await x.restart(); // third server: still cannot
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_the_recorder_marked_damaged');
    fs.chmodSync(x.events, 0o644);
    await x.restart(); // fourth server: can
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_the_recorder_marked_damaged');
    assert.equal(restarts(x), 1);
    assert.equal(x.store().result(1), null);
    await x.close();
  });

  test('a restart record removed from the ledger by hand: the server that wrote it still refuses, and so does the next server', async () => {
    const x = await recorder('g1e');
    await x.restart(); await x.view();
    const without = fs.readFileSync(x.events, 'utf8').split('\n').filter((l) => !l.includes('recorder_restarted')).join('\n');
    fs.writeFileSync(x.events, without);
    assert.equal(restarts(x), 0);
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_the_recorder_marked_damaged', 'this server knows it took the cycle over');
    await x.restart();
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_the_recorder_marked_damaged');
    assert.equal(restarts(x), 1);
    await x.close();
  });

  test('a restart between two cycles is no restart of a cycle: the next cycle is clean and its PASS is stored', async () => {
    const x = await recorder('g1f', { open: false });
    await x.restart();
    x.cycleId = await x.start(1, 0);
    await x.ack(1, x.cycleId, 1, 'claim', 1); await x.ack(1, x.cycleId, 2, 'dispatch', 1); confirmedCut(x.store());
    assert.deepEqual([(await x.view()).damaged, x.store().events().some((e) => e.kind === 'recorder_restarted')], [false, false]);
    assert.equal((await x.pass()).status, 200);
    await x.close();
  });

  test('a restart event cannot be sent by the test machine', async () => {
    const x = await recorder('g1g');
    assert.equal((await x.post('event', { cycle: 1, cycleId: x.cycleId, kind: 'recorder_restarted' })).data.error, 'invalid_event');
    await x.close();
  });
});

describe('G2: which cycle a refusal counts against does not depend on the recorder\'s clock', () => {
  test('the clock is set back a minute while a request is refused: the refusal counts, and the PASS is not stored', async () => {
    const x = await recorder('g2a');
    assert.equal((await withClock(-60_000, () => badAck(x))).data.error, 'wrong_cycle_id');
    assert.equal(x.count(), 1);
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_with_authenticated_rejections');
    await x.close();
  });
  test('a refusal BEFORE the cycle starts, by a clock that runs ahead, does not count against the cycle', async () => {
    const x = await recorder('g2b', { open: false });
    const early = await withClock(+3_600_000, () => x.post('cycles/1/start', { pgSystemId: PG, proc: 'a', workers: 99, dbHead: 0 })); // recorded an hour ahead of the start that follows
    assert.equal(early.data.error, 'invalid_start');
    x.cycleId = await x.start(1, 0);
    assert.equal(x.count(), 0, 'it was refused when no cycle was open');
    await x.ack(1, x.cycleId, 1, 'claim', 1); confirmedCut(x.store());
    assert.equal((await x.pass()).status, 200);
    await x.close();
  });
  test('immediately before the start: not counted. Immediately after, and during: counted. After the result: the stored cycle is unchanged', async () => {
    const x = await recorder('g2c', { open: false });
    assert.equal((await x.post('ack', { cycle: 1, cycleId: 'f'.repeat(32), proc: 'a', worker: 1, n: 1, kind: 'claim', seq: 1, actionId: 'x' })).data.error, 'cycle_not_open');
    x.cycleId = await x.start(1, 0);
    assert.equal(x.count(), 0);
    assert.equal((await badAck(x)).data.error, 'wrong_cycle_id');
    assert.equal(x.count(), 1);
    await x.ack(1, x.cycleId, 1, 'claim', 1);
    assert.equal((await badAck(x)).data.error, 'wrong_cycle_id');
    assert.equal(x.count(), 2);
    assert.equal((await x.post('cycles/1/result', { cycleId: x.cycleId, verdict: 'INCONCLUSIVE', needsRecovery: [] })).status, 200);
    assert.equal((await badAck(x)).data.error, 'cycle_not_open');
    assert.equal(x.count(), 2, 'a refusal after the cycle was checked is not a refusal in the cycle');
    await x.close();
  });
  test('a refusal in cycle 1 never counts against cycle 2, whatever the clock said', async () => {
    const x = await recorder('g2d');
    await withClock(+3_600_000, () => badAck(x)); // recorded an hour ahead: later than the start of cycle 2
    assert.equal(x.count(1), 1);
    await x.second();
    assert.deepEqual([x.count(1), x.count(2)], [1, 0]);
    assert.equal((await x.pass(2, x.cycleId2)).status, 200);
    await x.close();
  });
});

describe('G3: a refusal is attributed by what the recorder knows, not by what the request says', () => {
  test('path says cycle 2, body says cycle 1, cycle 1 open: the contradiction counts against the cycle that is open', async () => {
    const x = await recorder('g3a');
    const r = await x.post('cycles/2/start', { cycle: 1, pgSystemId: PG, proc: 'a', workers: 1, dbHead: 1 });
    assert.equal(r.data.error, 'cycle_1_is_open');
    const rec = x.store().rejections().at(-1);
    assert.deepEqual([rec.cycle, rec.claimedCycle, rec.open], [2, 1, 1], 'the path names the cycle; the body is kept as a claim');
    assert.equal(x.count(1), 1);
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_with_authenticated_rejections');
    await x.close();
  });
  test('path says cycle 1, body says cycle 2, cycle 2 open: it counts against cycle 2 and not against cycle 1', async () => {
    const x = await recorder('g3b');
    await x.second();
    const before = x.count(1);
    assert.equal((await x.post('cycles/1/result', { cycle: 2, cycleId: x.cycleId, verdict: 'PASS' })).data.error, 'cycle_not_open');
    assert.deepEqual([x.count(1), x.count(2)], [before, 1]);
    await x.close();
  });
  test('path says cycle 2, body says cycle 1, cycle 2 open (cycle 1 checked): nothing is added to cycle 1', async () => {
    const x = await recorder('g3c');
    await x.second();
    assert.equal((await x.post('cycles/2/result', { cycle: 1, cycleId: 'f'.repeat(32), verdict: 'PASS' })).data.error, 'wrong_cycle_id');
    assert.deepEqual([x.count(1), x.count(2)], [0, 1]);
    await x.close();
  });
  for (const [what, send, reason] of [
    ['no cycle at all (an event of an unknown kind)', (x) => x.post('event', { kind: 'no-such-kind' }), 'invalid_event'],
    ['a cycle that is not a cycle number (a string)', (x) => x.post('ack', { cycle: '1', cycleId: x.cycleId, proc: 'a', worker: 1, n: 3, kind: 'claim', seq: 2, actionId: 'x' }), 'cycle_not_open'],
    ['a cycle that is not a cycle number (zero)', (x) => x.post('ack', { cycle: 0, cycleId: x.cycleId, proc: 'a', worker: 1, n: 3, kind: 'claim', seq: 2, actionId: 'x' }), 'cycle_not_open'],
    ['a body that is not JSON', (x) => x.raw('POST', 'ack', '{"cycle":1,'), 'malformed_body'],
    ['an acknowledgement without its cycle', (x) => x.post('ack', { cycleId: x.cycleId, proc: 'a', worker: 1, n: 3, kind: 'claim', seq: 2, actionId: 'x' }), 'cycle_not_open'],
    ['a request older than the time window (a boot report by a clock that is wrong)', (x) => x.raw('POST', 'boot', JSON.stringify({ bootId: 'b' }), { now: Date.now() - 3_600_000 }), 'stale_timestamp'],
    ['a method the recorder does not serve', (x) => x.raw('DELETE', 'cycles/1'), 'method_not_allowed'],
  ]) {
    test(`${what}, refused while cycle 1 is open: it counts against cycle 1, and the PASS is not stored`, async () => {
      const x = await recorder(`g3m${Math.random().toString(36).slice(2, 8)}`);
      assert.equal((await send(x)).data.error, reason);
      assert.equal(x.count(1), 1);
      assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_with_authenticated_rejections');
      await x.restart();
      assert.equal(x.count(1), 2, 'the attribution is in the ledger: a restart keeps it (and the refused PASS is a refusal in the cycle too)');
      assert.equal(x.store().result(1), null);
      await x.close();
    });
  }
  test('the same requests refused while NO cycle is open count against no cycle: the next cycle is clean', async () => {
    const x = await recorder('g3n', { open: false });
    assert.equal((await x.post('event', { kind: 'no-such-kind' })).data.error, 'invalid_event');
    assert.equal((await x.raw('POST', 'ack', '{"cycle":1,')).data.error, 'malformed_body');
    assert.deepEqual(x.store().rejections().map((r) => [r.cycle, r.open]), [[null, null], [null, null]]);
    x.cycleId = await x.start(1, 0);
    assert.equal(x.count(1), 0);
    await x.ack(1, x.cycleId, 1, 'claim', 1); confirmedCut(x.store());
    assert.equal((await x.pass()).status, 200);
    await x.close();
  });
  test('a refusal that names ANOTHER cycle consistently is on record with the open cycle, and (as before) is not counted against it', async () => {
    const x = await recorder('g3o');
    assert.equal((await badAck(x, 2)).data.error, 'cycle_not_open');
    const rec = x.store().rejections().at(-1);
    assert.deepEqual([rec.cycle, rec.open, 'claimedCycle' in rec], [2, 1, false]);
    assert.equal(x.count(1), 0);
    await x.close();
  });
  test('when the recorder cannot tell which cycle is open, the refusal blocks every cycle of the run', async () => {
    const x = await recorder('g3p');
    fs.chmodSync(x.events, 0o000);
    let r;
    try { r = await x.raw('DELETE', 'cycles/1'); } finally { fs.chmodSync(x.events, 0o644); }
    assert.equal(r.data.error, 'method_not_allowed');
    assert.equal(x.store().rejections().at(-1).open, 'unknown');
    assert.equal(x.count(1), 1);
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_with_authenticated_rejections');
    await x.second();
    assert.equal(x.count(2), 1, 'it is not known to belong to cycle 1, so it is held against the run');
    assert.equal((await x.pass(2, x.cycleId2)).data.error, 'pass_for_a_cycle_with_authenticated_rejections');
    await x.close();
  });
  test('an authenticated refusal kept as an event (the rejection log could not take it) follows the same rule', async () => {
    const x = await recorder('g3q');
    fs.writeFileSync(x.rejections, FRAGMENT);
    const r = await x.post('event', { kind: 'no-such-kind' });
    assert.deepEqual([r.status, r.data.fallback], [500, 'event']);
    const e = x.store().events().at(-1);
    assert.deepEqual([e.kind, e.cycle, e.named, e.open], ['refusal_not_recorded', 1, null, 1]);
    assert.equal(x.count(1), 1);
    await x.close();
  });
});

describe('the view orders what happened in one ledger by that ledger, not by the clock', () => {
  test('a worker stop reported before the cut is one, even if the clock went back in between', async () => {
    const x = await recorder('g2e', { cut: false });
    await withClock(+120_000, () => x.store().event({ cycle: 1, cycleId: x.cycleId, kind: 'worker_stopped', proc: 'a', worker: 1 }));
    x.store().event({ cycle: 1, kind: 'cut_sent', how: 'manual' });
    const v = cycleView(x.store(), 1);
    assert.equal(v.workerStopsBeforeCut.length, 1);
    await x.close();
  });
});

describe('F17: unauthenticated requests cannot grow a rejection log without limit', () => {
  test('past the cap, unsigned requests are still refused but no longer written; an authenticated refusal still is', async () => {
    const x = await recorder('f17', { opts: { unauthenticatedLogCapBytes: 600 } });
    const unsigned = (p) => fetch(`${x.base()}${p}`, { method: 'POST', body: '{}' }).then((r) => r.status);
    for (let i = 0; i < 12; i += 1) { assert.equal(await unsigned('/runs/f17/ack'), 401); assert.equal(await unsigned('/nowhere'), 404); }
    const sizes = () => [fs.statSync(x.rejections).size, fs.statSync(path.join(x.dir, 'rejections.jsonl')).size];
    const before = sizes();
    assert.ok(before.every((n) => n > 600 && n < 1200), `each log stopped just past its cap: ${before}`);
    for (let i = 0; i < 5; i += 1) { assert.equal(await unsigned('/runs/f17/ack'), 401); assert.equal(await unsigned('/nowhere'), 404); }
    assert.deepEqual(sizes(), before, 'nothing more was written for unauthenticated requests');
    assert.equal((await badAck(x)).data.error, 'wrong_cycle_id');
    assert.ok(fs.statSync(x.rejections).size > before[0], 'an authenticated refusal is always written');
    assert.equal(x.count(1), 1);
    await x.close();
  });
});

describe('F22: a run flag that is given is never ignored', () => {
  test('workers must be a whole number from 1 to 12; a rate that is given must be a number above zero', () => {
    for (const ok of [{}, { workers: '1' }, { workers: '12', rate: '250' }, { 'target-rate': '0.5' }]) assert.equal(runFlagProblem(ok), null, JSON.stringify(ok));
    for (const bad of [{ workers: '1.5' }, { workers: '0' }, { workers: '13' }, { workers: 'two' }]) assert.match(runFlagProblem(bad), /--workers/, JSON.stringify(bad));
    for (const bad of ['0', 'abc', '', '-3', 'Infinity']) { assert.match(runFlagProblem({ 'target-rate': bad }), /--target-rate/, bad); assert.match(runFlagProblem({ rate: bad }), /--rate/, bad); }
  });
});

describe('G5: a complete line that is not a record is named, not only failed on', () => {
  test('verify-dir and the run\'s ledger check name the file; no cycle starts beside it', async () => {
    const x = await recorder('g5', { open: false });
    fs.appendFileSync(x.rejections, 'garbage\n');
    assert.match(dirReport(x.dir).problems.join(' | '), /rejections\.jsonl cannot be read \(a line is not a record\)/);
    assert.equal(runLedgerDamage(x.store()), 'rejections.jsonl cannot be read (a line is not a record)');
    const started = await x.post('cycles/1/start', { pgSystemId: PG, proc: 'a', workers: 1, dbHead: 0 });
    assert.match(JSON.stringify(started.data), /recorder_ledger_cannot_be_read: runs\/g5\/rejections\.jsonl/);
    assert.equal(x.store().events().some((e) => e.kind === 'cycle_start'), false);
    await x.close();
  });
});

// Findings of the independent review of the remediation above (H1 to H6), each reproduced here before its fix.
describe('H1/H2: what an authenticated request left nowhere is remembered by the server for the whole run', () => {
  test('H1: a refusal while the event ledger is unreadable AND the rejection log unwritable: no PASS afterwards, without any restart', async () => {
    const x = await recorder('h1');
    fs.writeFileSync(x.rejections, ''); fs.chmodSync(x.rejections, 0o444); fs.chmodSync(x.events, 0o000);
    let r;
    try { r = await x.raw('DELETE', 'cycles/1'); } finally { fs.chmodSync(x.events, 0o644); fs.chmodSync(x.rejections, 0o644); }
    assert.deepEqual([r.status, r.data.fallback], [500, 'none']);
    assert.equal(x.store().rejections().length, 0, 'it is in no ledger');
    const v = await x.view();
    assert.equal(v.damaged, true);
    assert.match(v.damage.recorderMemory, /could not be recorded/);
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_the_recorder_marked_damaged');
    assert.equal(x.store().result(1), null);
    assert.equal((await x.post('cycles/1/result', { cycleId: x.cycleId, verdict: 'INCONCLUSIVE', needsRecovery: [] })).status, 200, 'the cycle can still be closed');
    await x.close();
  });
  for (const [what, breakIt, send] of [
    ['a journal write failure report that cannot be stored (event ledger not writable)', (x) => fs.chmodSync(x.events, 0o444), (x) => x.post('event', { cycle: 1, cycleId: x.cycleId, kind: 'journal_write_failed', proc: 'a', worker: 1 })],
    ['an acknowledgement while the event ledger cannot be read', (x) => fs.chmodSync(x.events, 0o000), (x) => x.ack(1, x.cycleId, 3, 'claim', 2)],
  ]) {
    test(`H2: ${what} is answered with an error, and no PASS is stored afterwards`, async () => {
      const x = await recorder(`h2${Math.random().toString(36).slice(2, 8)}`);
      breakIt(x);
      let r;
      try { r = await send(x); } finally { fs.chmodSync(x.events, 0o644); }
      assert.equal(r.status, 500);
      assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_the_recorder_marked_damaged');
      assert.equal((await x.view()).damaged, true);
      assert.equal(x.store().result(1), null);
      await x.close();
    });
  }
  test('H2: a run this server knows that cannot be found for a moment: the request is answered 404, and no PASS is stored afterwards', async () => {
    const x = await recorder('h2r');
    const moved = `${x.root}.away`;
    fs.renameSync(x.root, moved);
    let r;
    try { r = await x.raw('POST', 'event', JSON.stringify({ cycle: 1, cycleId: x.cycleId, kind: 'journal_write_failed' })); } finally { fs.renameSync(moved, x.root); }
    assert.equal(r.status, 404);
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_the_recorder_marked_damaged');
    assert.equal(x.store().result(1), null);
    await x.close();
  });
});

describe('H3 to H6', () => {
  test('H3: a refusal whose open cycle could not be determined counts the same before and after a result is stored', async () => {
    const x = await recorder('h3');
    fs.chmodSync(x.events, 0o000);
    try { await x.raw('DELETE', 'cycles/1'); } finally { fs.chmodSync(x.events, 0o644); }
    assert.equal(x.count(1), 1);
    assert.equal((await x.post('cycles/1/result', { cycleId: x.cycleId, verdict: 'INCONCLUSIVE', needsRecovery: [] })).status, 200);
    assert.equal(x.count(1), 1, 'the closed cycle still shows the reason for its verdict');
    await x.close();
  });
  test('H4: a line that is not a record in the rejection log while a cycle is open: the running server serves the view as damaged, stores no PASS, and INCONCLUSIVE closes the cycle', async () => {
    const x = await recorder('h4');
    fs.appendFileSync(x.rejections, 'garbage\n');
    const v = await x.view();
    assert.equal(v.damaged, true);
    assert.match(v.damage.runLedgers, /rejections\.jsonl cannot be read \(a line is not a record\)/);
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_the_recorder_marked_damaged');
    assert.equal((await x.post('cycles/1/result', { cycleId: x.cycleId, verdict: 'INCONCLUSIVE', needsRecovery: [] })).status, 200);
    await x.close();
  });
  test('H4, THE STATED LIMIT: after a recorder restart such a run is unusable: every request fails, and no verdict of any kind is stored', async () => {
    const x = await recorder('h4b');
    fs.appendFileSync(x.rejections, 'garbage\n');
    await x.restart();
    const pass = await x.raw('POST', 'cycles/1/result', JSON.stringify({ cycleId: x.cycleId, verdict: 'PASS', needsRecovery: [] }));
    const inconclusive = await x.raw('POST', 'cycles/1/result', JSON.stringify({ cycleId: x.cycleId, verdict: 'INCONCLUSIVE', needsRecovery: [] }));
    assert.deepEqual([pass.status, inconclusive.status, x.store().result(1)], [500, 500, null]);
    assert.match(dirReport(x.dir).problems.join(' | '), /rejections\.jsonl cannot be read \(a line is not a record\)/, 'verify-dir says why');
    await x.close();
  });
  test('H6: a path whose cycle is present but unusable names no cycle: the body does not decide, and the refusal counts against the open cycle', async () => {
    const x = await recorder('h6a');
    for (const p of ['cycles/99999/result', 'cycles/2x/result', 'cycles/0/start']) await x.post(p, { cycle: 2, cycleId: x.cycleId, verdict: 'PASS' });
    assert.deepEqual(x.store().rejections().map((r) => r.cycle), [null, null, null]);
    assert.equal(x.count(1), 3);
    await x.close();
  });
  test('H6: a refused journal write failure or worker stop counts against the open cycle whatever cycle it names', async () => {
    const x = await recorder('h6b');
    assert.equal((await x.post('event', { cycle: 2, cycleId: x.cycleId, kind: 'journal_write_failed' })).data.error, 'journal_write_failed_needs_its_cycle');
    assert.equal(x.count(1), 1);
    assert.equal((await x.post('event', { cycle: 2, cycleId: x.cycleId, kind: 'worker_stopped' })).data.error, 'cycle_not_started');
    assert.equal(x.count(1), 2);
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_with_authenticated_rejections');
    await x.close();
  });
  test('first contact after the cut is the first boot report that stands after the cut in the ledger, whatever the clock said', async () => {
    const x = await recorder('h9', { cut: false });
    x.store().event({ cycle: 1, kind: 'cut_sent', how: 'manual' });
    await withClock(-120_000, () => x.store().event({ cycle: 1, kind: 'boot_report', bootId: 'after' }));
    assert.equal(cycleView(x.store(), 1).firstContactAfterCut?.bootId, 'after');
    await x.close();
  });
});
