// The product owner's rulings of 18 November 2026 on the PASS gate (A: a worker stop after the cut request; B: the gate
// verifies every piece of evidence itself; C: no evidence may change between the check and the stored PASS).
// Each case was written before its implementation and seen failing. HARNESS tests only: in-process recorders on
// temporary directories, loopback only. Nothing here is a power cut.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cycleView, registerVolume, runStatus } from '../recorder.mjs';
import { runTag } from '../lib/protocol.mjs';
import { classifyCycle } from '../lib/verdict.mjs';
import { savedResultProblem } from '../lib/attempts.mjs';
import { FACTS } from './helpers/qualifying.mjs';
import { FINAL, PG, STOP, recorder } from './helpers/gate.mjs';


describe('the baseline: complete evidence stores a PASS', () => {
  for (const model of ['HARNESS-SMOKE', 'POWER-CUT']) {
    test(`${model}: cut, confirmation, a running workload${model === 'POWER-CUT' ? ', the reboot, the approved settings and identity' : ''} and an unchanged evidence mark`, async () => {
      const x = await recorder(`base${model[0]}`, { model });
      await x.evidence();
      const r = await x.pass();
      assert.equal(r.status, 200, JSON.stringify(r.data));
      await x.close();
    });
  }
});

describe('Ruling A: a worker stop reported after the cut request makes the cycle INCONCLUSIVE', () => {
  test('a stop before the cut request: refused as before', async () => {
    const x = await recorder('a1');
    assert.equal((await STOP(x)).status, 200);
    await x.evidence();
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_whose_workload_stopped_before_the_cut');
    await x.close();
  });
  test('a stop after the cut request and before its confirmation (concurrent with it): kept, and no PASS', async () => {
    const x = await recorder('a2');
    x.cut();
    assert.equal((await STOP(x)).status, 200, 'the report is stored: its place in the ledger is the evidence');
    x.confirm();
    const v = await x.view();
    assert.deepEqual([v.workerStopsBeforeCut.length, v.workerStopsAfterCut.length], [0, 1]);
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_whose_worker_stopped_after_the_cut_request');
    assert.equal(x.store().result(1), null);
    await x.close();
  });
  test('a stop after the confirmation: no PASS either', async () => {
    const x = await recorder('a3');
    await x.evidence();
    assert.equal((await STOP(x)).status, 200);
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_whose_worker_stopped_after_the_cut_request');
    await x.close();
  });
  test('the boundary is the ledger position of the cut request, not a clock: a stop recorded with a clock an hour ahead just before it is BEFORE the cut', async () => {
    const x = await recorder('a4');
    const real = Date.now; Date.now = () => real() + 3_600_000;
    try { assert.equal((await STOP(x)).status, 200); } finally { Date.now = real; }
    x.cut();
    const v = await x.view();
    assert.deepEqual([v.workerStopsBeforeCut.length, v.workerStopsAfterCut.length], [1, 0]);
    await x.close();
  });
  test('check classifies a stop after the cut request as INCONCLUSIVE, and a saved PASS is not resent', () => {
    const cycle = { settings: { fsync: 'on', full_page_writes: 'on', synchronous_commit: 'on' }, cutSentAt: 'x', cutConfirmed: 'yes', workerStopsBeforeCut: [], workerStopsAfterCut: [{}], silentWorkerStops: [], rebootObservedAfterCut: true };
    const v = classifyCycle({ comparison: { findings: [], counts: { claimAcks: 1 }, needsRecovery: [], relation: 'equal' }, run: { failureModel: 'POWER-CUT', storage: {} }, cycle });
    assert.ok(v.inconclusive.includes('WORKER_STOPPED_AFTER_CUT_REQUEST'));
    assert.match(savedResultProblem({ verdict: 'PASS' }, { cutRequestedAt: 'x', cutConfirmed: 'yes', workerStopsBeforeCut: [], workerStopsAfterCut: [{}], silentWorkerStops: [] }), /stopped after the cut request/);
  });
});

describe('Ruling B: the gate verifies every piece of evidence itself', () => {
  test('no acknowledged claim before the cut: no PASS (a started worker without one is also silent, which is refused first)', async () => {
    const x = await recorder('b1');
    x.cut(); x.confirm();
    fs.writeFileSync(path.join(x.root, 'acks', 'cycle-0001.jsonl'), ''); // as if none had been acknowledged (the view is read afresh)
    const v = await x.view();
    assert.equal(v.claimAcksBeforeCut, 0);
    const r = await x.post('cycles/1/result', x.passBody(v));
    assert.deepEqual([r.status, r.data.error], [409, 'pass_for_a_cycle_whose_workload_stopped_before_the_cut']);
    assert.equal(x.store().result(1), null);
    await x.close();
  });
  test('contradictory confirmations (a "no" on record, a "yes" after it): no PASS', async () => {
    const x = await recorder('b2');
    x.cut(); x.confirm('no'); x.confirm('yes');
    assert.equal((await x.pass()).data.error, 'pass_for_a_cycle_with_contradictory_cut_confirmations');
    await x.close();
  });
  test('qualifying: no contact after the cut: no PASS', async () => {
    const x = await recorder('b3', { model: 'POWER-CUT' });
    x.cut(); x.confirm();
    assert.equal((await x.pass()).data.error, 'pass_without_contact_after_the_cut');
    await x.close();
  });
  test('qualifying: contact after the cut from the same boot as the start (no reboot): no PASS', async () => {
    const x = await recorder('b4', { model: 'POWER-CUT' });
    x.cut(); x.confirm(); await x.boot('boot-1');
    assert.equal((await x.pass({ reboot: { bootIdNow: 'boot-1' } })).data.error, 'pass_without_contact_after_the_cut');
    await x.close();
  });
  test('qualifying: a boot report BEFORE the cut is not contact after it', async () => {
    const x = await recorder('b5', { model: 'POWER-CUT' });
    await x.boot('boot-2'); x.cut(); x.confirm();
    assert.equal((await x.pass()).data.error, 'pass_without_contact_after_the_cut');
    await x.close();
  });
  // (each case on a recorder of its own: a refused PASS is itself a refusal in the cycle, and blocks every later PASS)
  const oneEach = async (name, cases, reason) => {
    for (const [i, over] of cases.entries()) {
      const x = await recorder(`${name}${i}`, { model: 'POWER-CUT' });
      await x.evidence();
      assert.equal((await x.pass(over)).data.error, reason, JSON.stringify(over));
      assert.equal(x.store().result(1), null);
      await x.close();
    }
  };
  test('qualifying: the boot the check reports is not the one the recorder was contacted from: no PASS', () => oneEach('b6', [{ reboot: { bootIdNow: 'boot-9' } }, { reboot: undefined }], 'pass_reboot_differs_from_the_contact_after_the_cut'));
  test('qualifying: durability settings missing, or not the approved configuration: no PASS', () => {
    const settings = FACTS(PG).settings;
    return oneEach('b7', [{ settings: undefined }, { settings: { ...settings, fsync: 'off' } }, { settings: { ...settings, wal_sync_method: 'open_datasync' } }], 'pass_settings_differ_from_the_qualifying_configuration');
  });
  test('qualifying: the start\'s own settings not durable: no PASS', async () => {
    const x = await recorder('b8', { model: 'POWER-CUT' });
    await x.evidence();
    const ev = path.join(x.root, 'events.jsonl');
    const lines = fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const start = lines.find((e) => e.kind === 'cycle_start');
    assert.deepEqual(start.settings, x.settings, 'the start records its settings');
    fs.writeFileSync(ev, `${lines.map((e) => JSON.stringify(e.kind === 'cycle_start' ? { ...e, settings: { ...e.settings, synchronous_commit: 'off' } } : e)).join('\n')}\n`);
    assert.equal((await x.pass()).data.error, 'pass_settings_differ_from_the_qualifying_configuration');
    await x.close();
  });
  test('qualifying: identity of the database cluster, the journal or the run not the verified one: no PASS', () => {
    const id = { pgSystemId: PG, journalMarkerSha256: 'aa'.repeat(32), installationId: 'inst-1' };
    return oneEach('b9', [{ identity: undefined }, { identity: { ...id, pgSystemId: '7199999999999999999' } }, { identity: { ...id, journalMarkerSha256: 'bb'.repeat(32) } }, { identity: { ...id, installationId: 'inst-2' } }, { run: 'another-run' }], 'pass_identity_differs_from_the_verified_run');
  });
  test('qualifying: the volume registry or the recorder\'s own binding changed since readiness: no PASS', async () => {
    const x = await recorder('b10', { model: 'POWER-CUT' });
    await x.evidence();
    registerVolume(x.dir, { pgSystemId: '7100000000000000099', run: 'someone-else', failureModel: 'HARNESS-SMOKE' }); // the registry the readiness bound has changed
    assert.equal((await x.pass()).data.error, 'pass_identity_differs_from_the_verified_run');
    await x.close();
  });
  test('non-qualifying runs (which never count) are not held to the reboot, settings and identity rules', async () => {
    const x = await recorder('b11');
    await x.evidence();
    assert.equal((await x.pass({ settings: undefined, identity: undefined, reboot: undefined })).status, 200);
    await x.close();
  });
});

describe('Ruling C: nothing changes between the check and the stored PASS', () => {
  test('an acknowledgement after the check read the view: the PASS is refused; the acknowledgement is kept', async () => {
    const x = await recorder('c1');
    await x.evidence();
    const v = await x.view();
    assert.match(v.evidenceMark, /^[0-9a-f]{64}$/);
    assert.equal((await x.ack(3, 'claim', 2)).status, 200);
    assert.equal((await x.post('cycles/1/result', x.passBody(v))).data.error, 'pass_evidence_changed_since_it_was_checked');
    assert.equal(x.store().acks(1).length, 3, 'the late acknowledgement is kept');
    await x.close();
  });
  for (const [what, act] of [
    ['an event (a worker stop)', (x) => STOP(x)],
    ['a refusal', (x) => x.post('ack', { cycle: 1, cycleId: 'f'.repeat(32), proc: 'a', worker: 1, n: 3, kind: 'claim', seq: 9, actionId: 'x' })],
    ['a cut confirmation by the operator', (x) => x.confirm('yes')],
    ['a boot report', (x) => x.boot('boot-3')],
  ]) {
    test(`${what} after the check read the view: the PASS is refused`, async () => {
      const x = await recorder(`c2${what.length}`);
      await x.evidence();
      const v = await x.view();
      await act(x);
      const r = await x.post('cycles/1/result', x.passBody(v));
      assert.equal(r.status, 409);
      assert.equal(x.store().result(1), null);
      await x.close();
    });
  }
  test('a PASS without an evidence mark is refused', async () => {
    const x = await recorder('c3');
    await x.evidence();
    assert.equal((await x.pass({ evidenceMark: undefined })).data.error, 'pass_without_the_evidence_mark_of_its_check');
    await x.close();
  });
  test('reading the view does not change the mark; a stored INCONCLUSIVE needs none', async () => {
    const x = await recorder('c4');
    await x.evidence();
    assert.equal((await x.view()).evidenceMark, (await x.view()).evidenceMark);
    assert.equal((await x.post('cycles/1/result', { cycleId: x.cycleId, verdict: 'INCONCLUSIVE', needsRecovery: [] })).status, 200);
    await x.close();
  });
  test('the recorder restarts between the check and the PASS: refused', async () => {
    const x = await recorder('c5');
    await x.evidence();
    const v = await x.view();
    await x.restart();
    const r = await x.post('cycles/1/result', x.passBody(v));
    assert.equal(r.status, 409);
    assert.equal(x.store().result(1), null);
    await x.close();
  });
  test('an acknowledgement and a PASS sent at the same moment: whichever wins, the cycle never ends as a PASS', async () => {
    for (let i = 0; i < 8; i += 1) {
      const x = await recorder(`c6${i}`);
      await x.evidence();
      const v = await x.view();
      const [, ack] = await Promise.all([x.post('cycles/1/result', x.passBody(v)), x.ack(3, 'claim', 2)]);
      await x.post('cycles/1/recovered', { cycleId: x.cycleId, finalState: FINAL });
      const after = cycleView(x.store(), 1);
      assert.notEqual(after.final, 'PASS', `trial ${i}: ack ${ack.status} ${ack.data?.error ?? ''}, result ${JSON.stringify(after.result?.verdict ?? null)}`);
      await x.close();
    }
  });
  test('a fresh acknowledgement for a cycle whose PASS is stored contradicts it: refused, on record, and the cycle ends INCONCLUSIVE, also in the run status', async () => {
    const x = await recorder('c7');
    await x.evidence();
    assert.equal((await x.pass()).status, 200);
    assert.equal((await x.ack(3, 'claim', 2)).data.error, 'cycle_not_open');
    assert.equal((await x.post('cycles/1/recovered', { cycleId: x.cycleId, finalState: FINAL })).data.final, 'INCONCLUSIVE');
    const v = cycleView(x.store(), 1);
    assert.deepEqual([v.result.verdict, v.contradictedAfterResult, v.final], ['PASS', 1, 'INCONCLUSIVE']);
    assert.deepEqual(runStatus(x.store()).cycles.map((c) => c.status), ['INCONCLUSIVE']);
    await x.close();
  });
  test('a REPLAYED acknowledgement after the PASS (anyone who captured it can send it) does not overturn it', async () => {
    const x = await recorder('c8');
    const text = JSON.stringify({ cycle: 1, cycleId: x.cycleId, proc: 'a', worker: 1, n: 3, kind: 'claim', seq: 2, actionId: `${runTag('c8')}c0001aw1-2` });
    const first = await x.raw('ack', text);
    assert.equal(first.status, 200);
    await x.evidence();
    assert.equal((await x.pass()).status, 200);
    const replay = await fetch(`${x.base}/runs/c8/ack`, { method: 'POST', headers: { 'content-type': 'application/json', ...first.headers }, body: text });
    assert.equal(replay.status, 401);
    assert.equal((await x.post('cycles/1/recovered', { cycleId: x.cycleId, finalState: FINAL })).data.final, 'PASS');
    await x.close();
  });
  test('a saved PASS is revalidated before it is resent: a changed mark makes it stale; once the recorder holds a result it is left to the recorder', () => {
    const view = { cutRequestedAt: 'x', cutConfirmed: 'yes', workerStopsBeforeCut: [], workerStopsAfterCut: [], silentWorkerStops: [], evidenceMark: 'b'.repeat(64), result: null };
    assert.match(savedResultProblem({ verdict: 'PASS', evidenceMark: 'a'.repeat(64) }, view), /changed since/);
    assert.equal(savedResultProblem({ verdict: 'PASS', evidenceMark: 'b'.repeat(64) }, view), null);
    assert.equal(savedResultProblem({ verdict: 'PASS', evidenceMark: 'a'.repeat(64) }, { ...view, result: { verdict: 'PASS' } }), null);
  });
});

// Findings of the independent review of the rulings (R1 to R5), each reproduced here before its fix.
describe('review of the rulings', () => {
  for (const [what, late] of [
    ['an acknowledgement whose cycle is a string', (x) => x.post('ack', { cycle: '1', cycleId: x.cycleId, proc: 'a', worker: 1, n: 3, kind: 'claim', seq: 2, actionId: 'x' })],
    ['an acknowledgement without its cycle', (x) => x.post('ack', { cycleId: x.cycleId, proc: 'a', worker: 1, n: 3, kind: 'claim', seq: 2, actionId: 'x' })],
    ['an acknowledgement naming another cycle with this cycle\'s id', (x) => x.post('ack', { cycle: 2, cycleId: x.cycleId, proc: 'a', worker: 1, n: 3, kind: 'claim', seq: 2, actionId: 'x' })],
    ['an acknowledgement whose body is not JSON', (x) => x.raw('ack', '{"cycle":1,')],
    ['a worker stop whose cycle is a string', (x) => x.post('event', { cycle: '1', cycleId: x.cycleId, kind: 'worker_stopped', proc: 'a', worker: 1 })],
    ['a journal write failure without a cycle', (x) => x.post('event', { kind: 'journal_write_failed', proc: 'a', worker: 1 })],
  ]) {
    test(`R1: ${what}, fresh, after the PASS was stored: the cycle ends INCONCLUSIVE`, async () => {
      const x = await recorder(`r1${what.length}`, { model: 'POWER-CUT' });
      await x.evidence();
      assert.equal((await x.pass()).status, 200);
      assert.ok((await late(x)).status >= 400);
      assert.equal((await x.post('cycles/1/recovered', { cycleId: x.cycleId, finalState: FINAL })).data.final, 'INCONCLUSIVE');
      assert.equal(runStatus(x.store()).streak.consecutivePhysicalPasses, 0);
      await x.close();
    });
  }
  test('R2: a boot already reported BEFORE the cut is not the reboot after it', async () => {
    const x = await recorder('r2', { model: 'POWER-CUT' });
    await x.boot('boot-2'); x.cut(); x.confirm(); await x.boot('boot-2');
    assert.equal((await x.pass()).data.error, 'pass_without_contact_after_the_cut');
    await x.close();
  });
  test('R3: a qualifying start without a boot id gives no reboot evidence', async () => {
    const x = await recorder('r3', { model: 'POWER-CUT', startBootId: '' });
    x.cut(); x.confirm(); await x.boot('boot-1');
    assert.equal((await x.pass({ reboot: { bootIdNow: 'boot-1' } })).data.error, 'pass_without_contact_after_the_cut');
    await x.close();
  });
  test('R4: a boot id longer than the start keeps is compared as the start kept it: the same boot is no reboot', async () => {
    const long = `b${'x'.repeat(80)}`;
    const x = await recorder('r4', { model: 'POWER-CUT', startBootId: long });
    x.cut(); x.confirm(); await x.boot(long);
    assert.equal((await x.pass({ reboot: { bootIdNow: long } })).data.error, 'pass_without_contact_after_the_cut');
    await x.close();
  });
  test('R5: an unsigned request between the check and its PASS does not change the evidence mark', async () => {
    const x = await recorder('r5');
    await x.evidence();
    const v = await x.view();
    assert.equal((await fetch(`${x.base}/runs/r5/ack`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await x.post('cycles/1/result', x.passBody(v))).status, 200);
    await x.close();
  });
  test('R5: a PASS refused only because the evidence changed is not a refusal held against the cycle: the next check can still store a PASS', async () => {
    const x = await recorder('r5b');
    await x.evidence();
    const v = await x.view();
    assert.equal((await x.boot('boot-2')).status, 200); // a late boot-probe report: a record, not a fault
    assert.equal((await x.post('cycles/1/result', x.passBody(v))).data.error, 'pass_evidence_changed_since_it_was_checked');
    assert.equal(cycleView(x.store(), 1).authenticatedRejections, 0);
    assert.equal((await x.pass()).status, 200, 'a fresh check reads the view again and stores its PASS');
    await x.close();
  });
});

// Findings of the review of the R fixes (S1, S2), each reproduced here before its fix.
import { LOCK_FILE } from '../lib/lock.mjs';
describe('review of the R fixes', () => {
  test('S1: a worker stop and a journal failure for a decided cycle answered "busy" still contradict its PASS', async () => {
    const x = await recorder('s1', { model: 'POWER-CUT', opts: { lockTimeoutMs: 200 } });
    await x.evidence();
    assert.equal((await x.pass()).status, 200);
    fs.writeFileSync(path.join(x.dir, LOCK_FILE), JSON.stringify({ pid: process.pid, at: Date.now() }));
    let a, b;
    try {
      a = await x.post('event', { cycle: 1, cycleId: x.cycleId, kind: 'worker_stopped', proc: 'a', worker: 1 });
      b = await x.post('event', { cycle: 1, cycleId: x.cycleId, kind: 'journal_write_failed', proc: 'a', worker: 1 });
    } finally { fs.rmSync(path.join(x.dir, LOCK_FILE), { force: true }); }
    assert.deepEqual([a.status, b.status], [503, 503]);
    assert.equal((await x.post('cycles/1/recovered', { cycleId: x.cycleId, finalState: FINAL })).data.final, 'INCONCLUSIVE');
    assert.equal(runStatus(x.store()).streak.consecutivePhysicalPasses, 0);
    await x.close();
  });
  test('S2: a fresh report that names no usable cycle while the NEXT cycle is open contradicts the last decided cycle too', async () => {
    const x = await recorder('s2');
    await x.evidence();
    assert.equal((await x.pass()).status, 200);
    assert.equal((await x.post('cycles/1/recovered', { cycleId: x.cycleId, finalState: FINAL })).data.final, 'PASS');
    const c2 = (await x.post('cycles/2/start', { pgSystemId: PG, proc: 'a', workers: 1, dbHead: 1, bootId: 'boot-2', sizing: { maxSeconds: 600 } })).data.cycleId;
    assert.match(String(c2), /^[0-9a-f]{32}$/);
    assert.ok((await x.post('event', { cycle: '1', kind: 'worker_stopped', proc: 'a', worker: 1 })).status >= 400);
    assert.equal(cycleView(x.store(), 1).final, 'INCONCLUSIVE');
    assert.equal(cycleView(x.store(), 2).authenticatedRejections, 1, 'and it still counts against the open cycle');
    await x.close();
  });
});
