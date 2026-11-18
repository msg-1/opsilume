// Finding F4 of the post-commit review of 462f5d4, recorder side: a journal write failure the worker reported is kept
// with its cycle whatever its time relative to the cut, and the recorder itself refuses a PASS or a recovery for such
// a cycle, so `check`, `recover` and the recorder cannot disagree about a failure that is known.
// HARNESS tests only: an in-process recorder on a temporary directory.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmedCut, markOf } from './helpers/cut.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecorder, createRun, cycleView, runStore } from '../recorder.mjs';
import { keyFromHex, makeClient, runTag } from '../lib/protocol.mjs';
import { finalStatus } from '../lib/verdict.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-jwf-'));
async function openCycle(run) {
  const dir = fs.mkdtempSync(path.join(tmp, 'r-'));
  createRun(dir, { run, failureModel: 'HARNESS-SMOKE' });
  const server = createRecorder(dir);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const call = makeClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, key: keyFromHex(fs.readFileSync(path.join(dir, 'keys', `${run}.key`), 'utf8')), run });
  const post = (p, body) => call('POST', `/runs/${run}/${p}`, body).then((r) => ({ status: 200, data: r.data }), (e) => ({ status: e.status, data: e.data }));
  const pg = '7300000000000000001';
  await post('event', { kind: 'volume_claimed', volume: { pgSystemId: pg, publicRelations: 0, stateEntries: 0, walLsnBytes: 1, serverVersion: '16.14' } });
  await post('event', { kind: 'initialised', installationId: 'inst-1' });
  const cycleId = (await post('cycles/1/start', { pgSystemId: pg, proc: 'a', workers: 1, dbHead: 0, sizing: { maxSeconds: 600 } })).data.cycleId;
  const actionId = `${runTag(run)}c0001aw1-1`;
  for (const [n, kind] of [[1, 'claim'], [2, 'dispatch']]) assert.equal((await post('ack', { cycle: 1, cycleId, proc: 'a', worker: 1, n, kind, seq: 1, actionId })).status, 200);
  return { dir, post, cycleId, store: () => runStore(dir, run), close: () => new Promise((r) => server.close(r)) };
}
const FINAL = { installationId: 'inst-1', head: 1, headHash: 'ab'.repeat(32) };

describe('F4: a journal write failure reported by the worker belongs to its cycle', () => {
  test('it is an event kind of its own, and it is kept when it arrives AFTER the cut was requested', async () => {
    const r = await openCycle('j1');
    r.store().event({ cycle: 1, kind: 'cut_sent', how: 'manual prompt' }); // as `recorder.mjs cut` writes it
    const sent = await r.post('event', { cycle: 1, cycleId: r.cycleId, kind: 'journal_write_failed', proc: 'a', worker: 1, detail: 'dispatch, EIO; marker NOT written (EROFS)' });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    const v = cycleView(r.store(), 1);
    assert.deepEqual(v.journalWriteFailures.map((e) => [e.proc, e.worker, e.detail]), [['a', 1, 'dispatch, EIO; marker NOT written (EROFS)']]);
    // An ordinary worker stop sent after the cut request is stored, and is not a stop BEFORE the cut. Since the product
    // owner's ruling A (18 November 2026) it counts all the same, as a stop after the cut request: the request is not
    // the power loss. (Before the ruling this test said "not counted".)
    assert.equal((await r.post('event', { cycle: 1, cycleId: r.cycleId, kind: 'worker_stopped', proc: 'a', worker: 1, detail: 'claim_error' })).status, 200);
    assert.deepEqual(cycleView(r.store(), 1).workerStopsBeforeCut, [], 'the ordinary stop arrived after the cut request: not a stop before it');
    assert.deepEqual(cycleView(r.store(), 1).workerStopsAfterCut.map((e) => e.detail), ['claim_error'], 'ruling A: it is a stop after the cut request, and counts');
    assert.equal(cycleView(r.store(), 1).journalWriteFailures.length, 1);
    await r.close();
  });

  test('the recorder refuses a PASS for that cycle, accepts INCONCLUSIVE, and then refuses its recovery', async () => {
    const r = await openCycle('j2');
    await r.post('event', { cycle: 1, cycleId: r.cycleId, kind: 'journal_write_failed', proc: 'a', worker: 1, detail: 'claim, EIO; marker written' });
    const pass = await r.post('cycles/1/result', { cycleId: r.cycleId, verdict: 'PASS', needsRecovery: [] });
    assert.deepEqual([pass.status, pass.data.error], [409, 'pass_contradicts_a_recorded_journal_write_failure']);
    assert.equal(r.store().result(1), null, 'nothing was stored');
    const inc = await r.post('cycles/1/result', { cycleId: r.cycleId, verdict: 'INCONCLUSIVE', inconclusive: ['JOURNAL_WRITE_FAILED'], needsRecovery: [] });
    assert.equal(inc.status, 200);
    const rec = await r.post('cycles/1/recovered', { cycleId: r.cycleId, finalState: FINAL });
    assert.deepEqual([rec.status, rec.data.error], [409, 'journal_write_failed_in_this_cycle']);
    assert.equal(cycleView(r.store(), 1).recovered, null);
    assert.equal(finalStatus(r.store().result(1), null), 'INCONCLUSIVE');
    await r.close();
  });

  test('the worker\'s report was lost, but the check itself found the marker: a PASS that carries it is refused, whatever verdict was computed', async () => {
    // `p7.mjs check` cannot be run in a unit test. This is the guard that can: the result it posts carries what the
    // marker says, and the recorder does not store a PASS beside it.
    const r = await openCycle('j5');
    const marker = { what: 'dispatch', code: 'EIO', at: '2026-11-18T10:00:00.000Z', marker: 'found' };
    const pass = await r.post('cycles/1/result', { cycleId: r.cycleId, verdict: 'PASS', needsRecovery: [], journalWriteFailure: marker });
    assert.deepEqual([pass.status, pass.data.error], [409, 'pass_reports_a_journal_write_failure']);
    const listed = await r.post('cycles/1/result', { cycleId: r.cycleId, verdict: 'PASS', needsRecovery: [], journalWriteFailure: null, journalWriteFailuresReported: [{ kind: 'journal_write_failed' }] });
    assert.deepEqual([listed.status, listed.data.error], [409, 'pass_reports_a_journal_write_failure']);
    assert.equal(r.store().result(1), null);
    assert.equal((await r.post('cycles/1/result', { cycleId: r.cycleId, verdict: 'INCONCLUSIVE', inconclusive: ['JOURNAL_WRITE_FAILED'], needsRecovery: [], journalWriteFailure: marker })).status, 200);
    assert.deepEqual(r.store().result(1).journalWriteFailure, marker, 'kept with the result');
    await r.close();
  });

  test('a torn tail that cannot be repaired (not valid UTF-8): the recorder stores no PASS for it and accepts no recovery', async () => {
    const r = await openCycle('j6');
    const problem = 'the torn final line (6 bytes) is not valid UTF-8: the journal\'s verifier would count it as 12 bytes and refuse the repair record';
    const pass = await r.post('cycles/1/result', { cycleId: r.cycleId, verdict: 'PASS', needsRecovery: ['repair-torn-tail'], tornTailRepairProblem: problem });
    assert.deepEqual([pass.status, pass.data.error], [409, 'pass_reports_a_torn_tail_that_cannot_be_repaired']);
    assert.equal(r.store().result(1), null);
    const inc = await r.post('cycles/1/result', { cycleId: r.cycleId, verdict: 'INCONCLUSIVE', inconclusive: ['TORN_TAIL_NOT_REPAIRABLE'], needsRecovery: ['repair-torn-tail'], tornTailRepairProblem: problem });
    assert.equal(inc.status, 200);
    assert.equal(cycleView(r.store(), 1).final, 'INCONCLUSIVE');
    const rec = await r.post('cycles/1/recovered', { cycleId: r.cycleId, finalState: FINAL });
    assert.deepEqual([rec.status, rec.data.error], [409, 'torn_tail_cannot_be_repaired']);
    assert.equal(cycleView(r.store(), 1).recovered, null);
    assert.equal(cycleView(r.store(), 1).final, 'INCONCLUSIVE', 'and it stays that way');
    await r.close();
  });

  test('a cycle without such a report is unaffected: PASS and recovery are accepted as before', async () => {
    const r = await openCycle('j3');
    confirmedCut(r.store()); // (a PASS presupposes a recorded, confirmed cut)
    assert.deepEqual(cycleView(r.store(), 1).journalWriteFailures, []);
    assert.equal((await r.post('cycles/1/result', { cycleId: r.cycleId, verdict: 'PASS', needsRecovery: [], ...markOf(r.store()) })).status, 200);
    assert.equal((await r.post('cycles/1/recovered', { cycleId: r.cycleId, finalState: FINAL })).status, 200);
    // A report can only belong to the cycle that is open: one that arrives for a cycle already checked is refused,
    // so a recorded result is never contradicted after the fact.
    const late = await r.post('event', { cycle: 1, cycleId: r.cycleId, kind: 'journal_write_failed', proc: 'a', worker: 1, detail: 'late' });
    assert.deepEqual([late.status, late.data.error], [400, 'journal_write_failed_needs_its_cycle']);
    assert.deepEqual(cycleView(r.store(), 1).journalWriteFailures, []);
    await r.close();
  });

  test('the report needs its cycle: it is refused for a cycle id that is not the open cycle\'s', async () => {
    const r = await openCycle('j4');
    const wrong = await r.post('event', { cycle: 1, cycleId: 'f'.repeat(32), kind: 'journal_write_failed', proc: 'a', worker: 1, detail: 'x' });
    assert.deepEqual([wrong.status, wrong.data.error], [409, 'wrong_cycle_id']);
    const none = await r.post('event', { kind: 'journal_write_failed', proc: 'a', worker: 1, detail: 'x' });
    assert.deepEqual([none.status, none.data.error], [400, 'journal_write_failed_needs_its_cycle']);
    await r.close();
  });
});
