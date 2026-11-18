// Finding B of the second safety review (F14 of the post-commit review): an event that named a cycle which had not
// started, without a cycle id, was stored, and later counted against the real cycle (a `worker_stopped` made it
// INCONCLUSIVE). An event that names a cycle is accepted only for a cycle that has started, with that cycle's own id
// as a string; a `worker_stopped` only for the cycle that is open. HARNESS tests only: an in-process recorder on a
// temporary directory.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecorder, createRun, cycleView, runStore } from '../recorder.mjs';
import { keyFromHex, makeClient, runTag } from '../lib/protocol.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-events-'));
async function recorder(run) {
  const dir = fs.mkdtempSync(path.join(tmp, 'r-'));
  createRun(dir, { run, failureModel: 'HARNESS-SMOKE' });
  const server = createRecorder(dir);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const call = makeClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, key: keyFromHex(fs.readFileSync(path.join(dir, 'keys', `${run}.key`), 'utf8')), run });
  const post = (p, body) => call('POST', `/runs/${run}/${p}`, body).then((r) => ({ status: 200, data: r.data }), (e) => ({ status: e.status, data: e.data }));
  const pg = '7100000000000000001';
  assert.equal((await post('event', { kind: 'volume_claimed', volume: { pgSystemId: pg, publicRelations: 0, stateEntries: 0, walLsnBytes: 1, serverVersion: '16.14' } })).status, 200);
  assert.equal((await post('event', { kind: 'initialised', installationId: 'inst-1' })).status, 200);
  const store = () => runStore(dir, run);
  const start = async (n, dbHead = 0) => (await post(`cycles/${n}/start`, { pgSystemId: pg, proc: 'a', workers: 1, dbHead, sizing: { maxSeconds: 600 } })).data.cycleId;
  const ev = (body) => post('event', { proc: 'a', worker: 1, detail: 'test', ...body }).then((r) => (r.status === 200 ? 'stored' : `${r.status} ${r.data.error}`));
  const kinds = (n) => store().events().filter((e) => e.cycle === n).map((e) => e.kind);
  return { dir, run, post, store, start, ev, kinds, close: () => new Promise((r) => server.close(r)) };
}
/** Takes cycle `n` from an open cycle to checked and recovered (a closed cycle). */
async function close(r, n, cycleId, seq) {
  const actionId = `${runTag(r.run)}c${String(n).padStart(4, '0')}aw1-1`;
  for (const [k, kind] of [[1, 'claim'], [2, 'dispatch']]) assert.equal((await r.post('ack', { cycle: n, cycleId, proc: 'a', worker: 1, n: k, kind, seq, actionId })).status, 200);
  assert.equal((await r.post(`cycles/${n}/result`, { cycleId, verdict: 'INCONCLUSIVE', inconclusive: ['NOT_A_DURABILITY_RUN'], needsRecovery: [], quarantineRequired: false })).status, 200);
  assert.equal((await r.post(`cycles/${n}/recovered`, { cycleId, finalState: { installationId: 'inst-1', head: seq, headHash: 'ab'.repeat(32) } })).status, 200);
}

describe('an event that names a cycle belongs to a cycle that has started, by that cycle\'s own id', () => {
  test('1 and 2: before the cycle starts, with or without a cycle id, it is refused; nothing is stored, and the real cycle is clean', async () => {
    const r = await recorder('e1');
    assert.equal(await r.ev({ cycle: 1, kind: 'worker_stopped' }), '409 cycle_not_started', 'no cycle id');
    assert.equal(await r.ev({ cycle: 1, cycleId: 'f'.repeat(32), kind: 'worker_stopped' }), '409 cycle_not_started', 'a made-up id');
    assert.equal(await r.ev({ cycle: 1, kind: 'netcheck' }), '409 cycle_not_started');
    assert.deepEqual(r.kinds(1), [], 'nothing was stored for cycle 1');
    // The real cycle then starts with nothing held against it.
    await r.start(1);
    r.store().event({ cycle: 1, kind: 'cut_sent', how: 'manual prompt' });
    assert.deepEqual(cycleView(r.store(), 1).workerStopsBeforeCut, [], 'no stray stop makes it INCONCLUSIVE');
    await r.close();
  });

  test('2 and 3: for a started cycle, a missing cycle id, an id of another type, or another id is refused', async () => {
    const r = await recorder('e2');
    const cycleId = await r.start(1);
    assert.equal(await r.ev({ cycle: 1, kind: 'worker_stopped' }), '409 wrong_cycle_id', 'missing');
    assert.equal(await r.ev({ cycle: 1, cycleId: null, kind: 'worker_stopped' }), '409 wrong_cycle_id', 'null');
    assert.equal(await r.ev({ cycle: 1, cycleId: 7, kind: 'netcheck' }), '409 wrong_cycle_id', 'a number');
    assert.equal(await r.ev({ cycle: 1, cycleId: [cycleId], kind: 'netcheck' }), '409 wrong_cycle_id', 'an array holding the right id is not the id');
    assert.equal(await r.ev({ cycle: 1, cycleId: 'f'.repeat(32), kind: 'worker_stopped' }), '409 wrong_cycle_id', 'mismatched');
    assert.equal(await r.ev({ cycle: 1, cycleId: cycleId.toUpperCase(), kind: 'worker_stopped' }), '409 wrong_cycle_id', 'not exactly the id');
    assert.deepEqual(r.kinds(1), ['cycle_start'], 'none of them was stored');
    await r.close();
  });

  test('4: an unknown cycle (never started, far ahead, or not a cycle number) is refused', async () => {
    const r = await recorder('e3');
    const cycleId = await r.start(1);
    for (const cycle of [2, 5, 9999]) assert.equal(await r.ev({ cycle, cycleId, kind: 'worker_stopped' }), '409 cycle_not_started', `cycle ${cycle}, with cycle 1's id`);
    for (const cycle of [0, -1, 1.5, 10001, 'one']) assert.equal(await r.ev({ cycle, cycleId, kind: 'netcheck' }), '409 cycle_not_started', `cycle ${JSON.stringify(cycle)}`);
    assert.deepEqual(r.store().events().filter((e) => e.cycle !== 1 && e.cycle !== null).length, 0);
    await r.close();
  });

  test('5 and 6: a worker stop is only for the OPEN cycle: refused for a closed one, even with its right id; and it never lands in the next cycle', async () => {
    const r = await recorder('e4');
    const id1 = await r.start(1);
    await close(r, 1, id1, 1);
    assert.equal(await r.ev({ cycle: 1, cycleId: id1, kind: 'worker_stopped' }), '409 cycle_not_open', 'cycle 1 is checked and recovered');
    const id2 = await r.start(2, 1);
    assert.equal(await r.ev({ cycle: 1, cycleId: id1, kind: 'worker_stopped' }), '409 cycle_not_open', 'cycle 2 is the open one now');
    assert.equal(await r.ev({ cycle: 2, cycleId: id1, kind: 'worker_stopped' }), '409 wrong_cycle_id', 'cycle 1\'s id does not open cycle 2');
    assert.equal(await r.ev({ kind: 'worker_stopped' }), '400 worker_stopped_needs_its_cycle', 'a worker stop that names no cycle at all');
    r.store().event({ cycle: 2, kind: 'cut_sent', how: 'manual prompt' });
    assert.deepEqual(cycleView(r.store(), 2).workerStopsBeforeCut, []);
    assert.deepEqual(cycleView(r.store(), 1).workerStopsBeforeCut, [], 'and the closed cycle\'s record did not change either');
    assert.match(id2, /^[0-9a-f]{32}$/);
    await r.close();
  });

  test('7: a valid worker stop for the open cycle is stored, and counts against that cycle only', async () => {
    const r = await recorder('e5');
    const cycleId = await r.start(1);
    assert.equal(await r.ev({ cycle: 1, cycleId, kind: 'worker_stopped', detail: 'pool_exhausted' }), 'stored');
    r.store().event({ cycle: 1, kind: 'cut_sent', how: 'manual prompt' });
    assert.deepEqual(cycleView(r.store(), 1).workerStopsBeforeCut.map((e) => [e.cycleId, e.proc, e.worker, e.detail]), [[cycleId, 'a', 1, 'pool_exhausted']]);
    await r.close();
  });

  test('8: the other kinds are accepted as before: run-level events without a cycle, and cycle events with the right id, also for a checked cycle', async () => {
    const r = await recorder('e6'); // volume_claimed and initialised were accepted in the set-up, without a cycle
    assert.equal(await r.ev({ kind: 'netcheck', detail: 'isolation checks passed' }), 'stored', 'a network check outside any cycle');
    const cycleId = await r.start(1);
    assert.equal(await r.ev({ cycle: 1, cycleId, kind: 'netcheck', detail: 'clock offset' }), 'stored');
    assert.equal(await r.ev({ cycle: 1, cycleId, kind: 'journal_write_failed', detail: 'claim, EIO; marker written' }), 'stored', 'for the open cycle');
    // quarantine_observed is sent by `recover`, after the cycle was checked: a closed cycle, the right id.
    const actionId = `${runTag('e6')}c0001aw1-1`;
    for (const [k, kind] of [[1, 'claim'], [2, 'dispatch']]) await r.post('ack', { cycle: 1, cycleId, proc: 'a', worker: 1, n: k, kind, seq: 1, actionId });
    assert.equal((await r.post('cycles/1/result', { cycleId, verdict: 'INCONCLUSIVE', inconclusive: ['JOURNAL_WRITE_FAILED'], needsRecovery: ['clear'], quarantineRequired: true, uncommitted: { seq: 2, actionId: 'x' } })).status, 200);
    assert.equal(await r.ev({ cycle: 1, cycleId, kind: 'quarantine_observed', detail: 'journal ahead' }), 'stored');
    assert.equal(await r.ev({ cycle: 1, cycleId: 'f'.repeat(32), kind: 'quarantine_observed' }), '409 wrong_cycle_id');
    assert.equal(await r.ev({ cycle: 1, cycleId, kind: 'netcheck' }), 'stored', 'a note about a checked cycle, with its id, is still a note about that cycle');
    assert.deepEqual(r.kinds(1), ['cycle_start', 'netcheck', 'journal_write_failed', 'quarantine_observed', 'netcheck']);
    await r.close();
  });

  test('a refused event is refused through the ordinary path: authenticated, logged as a rejection, and it changes no cycle', async () => {
    const r = await recorder('e7');
    const before = r.store().events().length;
    assert.equal(await r.ev({ cycle: 3, kind: 'worker_stopped' }), '409 cycle_not_started');
    assert.equal(r.store().events().length, before);
    assert.deepEqual(r.store().rejections().map((x) => [x.reason, x.authenticated, x.cycle]), [['cycle_not_started', true, 3]]);
    await r.close();
  });
});
