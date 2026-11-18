// Findings of the final independent review of the hardening diff (D1 to D12), each reproduced here before its fix.
// HARNESS tests only: in-process recorders on temporary directories, loopback only.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmedCut, markOf } from './helpers/cut.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecorder, createRun, cycleView, dirReport, ledgerProblems, runStore } from '../recorder.mjs';
import { keyFromHex, makeClient, runTag } from '../lib/protocol.mjs';
import { recoverRefusal, clearanceMatches } from '../lib/recovery.mjs';
import { planAttempt, recordSuperseded, savedResultProblem, sameAttempt } from '../lib/attempts.mjs';
import { repairCheck } from '../lib/scan.mjs';
import { writeOnce } from '../lib/ledger.mjs';
import { runNetcheck } from '../lib/netcheck.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-final-'));
async function openCycle(run) {
  const dir = fs.mkdtempSync(path.join(tmp, 'r-'));
  createRun(dir, { run, failureModel: 'HARNESS-SMOKE' });
  const x = { dir, run, store: () => runStore(dir, run), root: path.join(dir, 'runs', run) };
  let server;
  const listen = async () => {
    server = createRecorder(dir);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    x.call = makeClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, key: keyFromHex(fs.readFileSync(path.join(dir, 'keys', `${run}.key`), 'utf8')), run });
    x.post = (p, body) => x.call('POST', `/runs/${run}/${p}`, body).then((r) => ({ status: 200, data: r.data }), (e) => ({ status: e.status, data: e.data, message: e.message }));
    x.view = async () => (await x.call('GET', `/runs/${run}/cycles/1`)).data;
  };
  x.restart = async () => { await new Promise((r) => server.close(r)); await listen(); };
  x.close = () => new Promise((r) => server.close(r));
  await listen();
  const pg = '6800000000000000001';
  await x.post('event', { kind: 'volume_claimed', volume: { pgSystemId: pg, publicRelations: 0, stateEntries: 0, walLsnBytes: 1, serverVersion: '16.14' } });
  await x.post('event', { kind: 'initialised', installationId: 'inst-1' });
  x.cycleId = (await x.post('cycles/1/start', { pgSystemId: pg, proc: 'a', workers: 1, dbHead: 0, sizing: { maxSeconds: 600 } })).data.cycleId;
  x.actionId = `${runTag(run)}c0001aw1-1`;
  x.ack = (n, kind, over = {}) => x.post('ack', { cycle: 1, cycleId: x.cycleId, proc: 'a', worker: 1, n, kind, seq: 1, actionId: x.actionId, ...over });
  await x.ack(1, 'claim'); await x.ack(2, 'dispatch');
  return x;
}
const FINAL = { installationId: 'inst-1', head: 1, headHash: 'ab'.repeat(32) };

describe('D1: a saved PASS is not sent again once the cycle view no longer supports it', () => {
  test('after an authenticated refusal in the cycle, the view the recorder serves makes a saved PASS stale', async () => {
    const x = await openCycle('d1a');
    confirmedCut(x.store()); // (a PASS presupposes a recorded, confirmed cut)
    const saved = { cycleId: x.cycleId, verdict: 'PASS', needsRecovery: [], attempt: { id: 'a1' } }; // saved, not yet delivered
    assert.equal(savedResultProblem(saved, await x.view()), null, 'while nothing was refused it may be sent');
    assert.equal((await x.ack(3, 'claim', { cycleId: 'f'.repeat(32) })).data.error, 'wrong_cycle_id'); // an authenticated refusal in this cycle
    assert.match(savedResultProblem(saved, await x.view()), /1 authenticated refusal/, 'check will not send it; it marks it and decides afresh');
    await x.close();
  });
  test('a refused PASS whose answer was lost: after a recorder restart the takeover and the refusal are on record, and the saved PASS is stale', async () => {
    const x = await openCycle('d1b');
    fs.chmodSync(path.join(x.root, 'acks', 'cycle-0001.jsonl'), 0o444);
    await x.ack(3, 'claim', { seq: 2, actionId: `${runTag('d1b')}c0001aw1-2` }); // cannot be stored: damage in memory only
    fs.chmodSync(path.join(x.root, 'acks', 'cycle-0001.jsonl'), 0o644);
    const saved = { cycleId: x.cycleId, verdict: 'PASS', needsRecovery: [], attempt: { id: 'a1' } };
    assert.equal((await x.post('cycles/1/result', saved)).data.error, 'pass_for_a_cycle_the_recorder_marked_damaged'); // ... and suppose this answer never reached the test machine
    await x.restart(); // what the earlier server knew only in memory is gone
    const v = await x.view();
    // The reason is forgotten; the refusals are not: the refused PASS and (since the review of 18 November 2026: an
    // acknowledgement the recorder could not handle is refused on record) the acknowledgement that could not be stored.
    assert.deepEqual([v.damage.recorderMemory, v.authenticatedRejections], [null, 2], 'the reason is forgotten; the refusals are not');
    // ... and the server that took the cycle over says so, which is damage of its own: it cannot know what was forgotten.
    assert.equal(v.damaged, true);
    assert.match(savedResultProblem(saved, v), /restarted while this cycle was open/);
    assert.match(savedResultProblem(saved, { ...v, damaged: false }), /2 authenticated refusal/, 'the refusals on record would be enough by themselves');
    // And if the saved PASS were sent all the same, the recorder refuses it.
    assert.equal((await x.post('cycles/1/result', saved)).data.error, 'pass_for_a_cycle_the_recorder_marked_damaged');
    assert.equal(x.store().result(1), null);
    await x.close();
  });
  test('the recorder itself refuses a PASS for a cycle with an authenticated refusal on record (the gate behind `check`)', async () => {
    const x = await openCycle('d1c');
    assert.equal((await x.ack(3, 'claim', { cycleId: 'f'.repeat(32) })).data.error, 'wrong_cycle_id');
    const pass = await x.post('cycles/1/result', { cycleId: x.cycleId, verdict: 'PASS', needsRecovery: [] });
    assert.deepEqual([pass.status, pass.data.error], [409, 'pass_for_a_cycle_with_authenticated_rejections']);
    assert.equal(x.store().result(1), null, 'nothing was stored');
    // A restarted recorder refuses as well. It reads the refusals from the ledger (the count is unchanged), and it
    // stores no PASS for a cycle it took over in any case: that is the reason it gives.
    await x.restart();
    assert.equal(cycleView(x.store(), 1).authenticatedRejections, 2, 'the refused request and the refused PASS');
    assert.equal((await x.post('cycles/1/result', { cycleId: x.cycleId, verdict: 'PASS', needsRecovery: [] })).data.error, 'pass_for_a_cycle_the_recorder_marked_damaged');
    // The cycle is not a dead end: the verdict the refusals call for is accepted, and closes it.
    assert.equal((await x.post('cycles/1/result', { cycleId: x.cycleId, verdict: 'INCONCLUSIVE', inconclusive: ['RECORDER_REJECTED_AUTHENTICATED_MESSAGES'], needsRecovery: [] })).status, 200);
    assert.equal((await x.view()).final, 'INCONCLUSIVE');
    await x.close();
  });
  test('a refusal that consistently names another cycle does not block the PASS of the open cycle, and refusals after the result change nothing stored', async () => {
    const x = await openCycle('d1d');
    confirmedCut(x.store());
    // a refusal that names another cycle (cycle 2 has not started): it is logged as naming cycle 2, and not counted against cycle 1
    // (refusals before the start, in another cycle, or by a wrong clock: test/d1-gate.test.mjs)
    assert.equal((await x.post('cycles/2/start', { pgSystemId: '6800000000000000001', proc: 'a', workers: 1, dbHead: 1 })).data.error, 'cycle_1_is_open');
    assert.equal((await x.view()).authenticatedRejections, 0);
    assert.equal((await x.post('cycles/1/result', { cycleId: x.cycleId, verdict: 'PASS', needsRecovery: [], ...markOf(x.store()) })).status, 200);
    // refusals during the recovery of a cycle that already has its result change nothing that was stored
    assert.equal((await x.post('cycles/1/recovered', { cycleId: x.cycleId })).data.error, 'final_state_missing');
    assert.equal((await x.post('cycles/1/recovered', { cycleId: x.cycleId, finalState: FINAL })).data.final, 'PASS');
    await x.close();
  });
  test('check re-vets a saved PASS against the cycle view before it re-sends it', () => {
    const saved = { verdict: 'PASS', attempt: { id: 'a1' } };
    const clean = { damaged: false, authenticatedRejections: 0, journalWriteFailures: [] };
    assert.equal(savedResultProblem(saved, clean), null);
    assert.match(savedResultProblem(saved, { ...clean, authenticatedRejections: 2 }), /2 authenticated refusal/);
    assert.match(savedResultProblem(saved, { ...clean, damaged: true, damage: { runLedgers: 'rejections.jsonl ends in an incomplete line' } }), /damaged/);
    assert.match(savedResultProblem(saved, { ...clean, journalWriteFailures: [{}] }), /journal write failure/);
    assert.equal(savedResultProblem({ verdict: 'INCONCLUSIVE' }, { ...clean, authenticatedRejections: 2 }), null, 'only a PASS can be made stale by the view');
    // A stale saved PASS is marked by check itself, kept, and replaced by a fresh attempt.
    const evidence = fs.mkdtempSync(path.join(tmp, 'ev-'));
    fs.mkdirSync(path.join(evidence, 'cycle-0001'));
    writeOnce(path.join(evidence, 'cycle-0001', 'result.json'), saved);
    assert.deepEqual(planAttempt(evidence, 'cycle-0001'), { resend: 'cycle-0001' });
    const marker = recordSuperseded(path.join(evidence, 'cycle-0001'), 'the cycle view shows 2 authenticated refusals', 5);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(evidence, 'cycle-0001', marker), 'utf8')).refusedBy, 'check');
    assert.equal(planAttempt(evidence, 'cycle-0001', 9).fresh, 'cycle-0001-attempt-9');
  });
});

describe('D2: recovery does not start what the recorder cannot record, and a stop is recorded even then', () => {
  test('recover is refused, before anything is changed, while a ledger of the run is damaged', () => {
    const view = { result: { verdict: 'INCONCLUSIVE' }, recovered: null, events: [], damage: { acknowledgementLedger: null, recorderMemory: null, runLedgers: 'events.jsonl ends in an incomplete line' } };
    const r = recoverRefusal({ stopped: null, cycle: 1, view, writeFailure: null });
    assert.equal(r.how, 'refuse');
    assert.match(r.why, /events\.jsonl ends in an incomplete line/);
    assert.equal(recoverRefusal({ stopped: null, cycle: 1, view: { ...view, damage: { ...view.damage, runLedgers: null } }, writeFailure: null }), null);
  });
  test('/stop writes the stop marker even when its event cannot be written', async () => {
    const x = await openCycle('d2');
    fs.appendFileSync(path.join(x.root, 'events.jsonl'), '{"kind":"frag');
    const r = await x.post('stop', { cycle: 1, reason: 'recovery: test' });
    assert.equal(r.status, 500, 'the event could not be written, and the answer says so');
    assert.equal(x.store().stopped()?.kind, 'recovery-failed', 'but the run IS stopped');
    await x.close();
  });
});

describe('D4: a result the recorder did store is not marked as refused', () => {
  test('the stored result is recognised by its attempt id', () => {
    assert.equal(sameAttempt({ attempt: { id: 'abc' } }, { attempt: { id: 'abc' } }), true);
    assert.equal(sameAttempt({ attempt: { id: 'abc' } }, { attempt: { id: 'xyz' } }), false);
    assert.equal(sameAttempt(null, { attempt: { id: 'abc' } }), false);
    assert.equal(sameAttempt({ verdict: 'PASS' }, { verdict: 'PASS' }), false, 'results without an identity are never taken for one another');
  });
});

describe('D5 to D12: smaller corrections', () => {
  test('D5: the client\'s error names what was refused, not only that the refusal could not be logged', async () => {
    const x = await openCycle('d5');
    fs.writeFileSync(path.join(x.root, 'rejections.jsonl'), '{"re');
    const r = await x.post('cycles/2/start', { pgSystemId: '6800000000000000001', proc: 'a', workers: 1, dbHead: 0, vet: true });
    assert.match(r.message, /500 refusal_not_recorded \(recorder_ledger_ends_in_a_fragment: runs\/d5\/rejections\.jsonl\)/, 'the operator sees why the start was refused');
    await x.close();
  });
  test('D6: an unreadable acknowledgement file is reported without a path of the recorder host', async () => {
    const x = await openCycle('d6');
    const f = path.join(x.root, 'acks', 'cycle-0001.jsonl');
    fs.chmodSync(f, 0o000);
    try {
      const v = cycleView(x.store(), 1);
      assert.match(v.damage.acknowledgementLedger, /cannot be read \(EACCES\)$/);
      assert.ok(!JSON.stringify(v.damage).includes(x.dir));
      const served = await x.call('GET', `/runs/${x.run}/cycles/1`).then((r) => JSON.stringify(r.data), (e) => JSON.stringify(e.data));
      assert.ok(!served.includes(x.dir), 'nor in what the server answers');
    } finally { fs.chmodSync(f, 0o644); }
    await x.close();
  });
  test('D7: verify-dir reports a directory it cannot read instead of throwing', async () => {
    const x = await openCycle('d7');
    const acks = path.join(x.root, 'acks');
    fs.chmodSync(acks, 0o000);
    try {
      assert.match(ledgerProblems(x.dir).map((p) => `${p.file} ${p.problem}`).join(' | '), /cannot be read \(EACCES\)/);
      assert.match(dirReport(x.dir).problems.join(' | '), /cannot be read \(EACCES\)/);
    } finally { fs.chmodSync(acks, 0o755); }
    await x.close();
  });
  test('D8: a fragment too long to be a torn line is a fact about the journal (the cycle can be closed as INCONCLUSIVE), not an endless "undetermined"', () => {
    const f = path.join(fs.mkdtempSync(path.join(tmp, 'big-')), 'journal.log');
    const fd = fs.openSync(f, 'w'); fs.ftruncateSync(fd, 64 * 1024 * 1024 + 2); fs.closeSync(fd); // sparse: no real 64 MiB written
    assert.deepEqual(Object.keys(repairCheck(f, 64 * 1024 * 1024 + 1)), ['wouldNotVerify']);
  });
  test('D9: an attempt whose result.json is not readable JSON is a dead attempt: neither re-sent for ever nor reused', () => {
    const evidence = fs.mkdtempSync(path.join(tmp, 'ev-'));
    fs.mkdirSync(path.join(evidence, 'cycle-0001'));
    fs.writeFileSync(path.join(evidence, 'cycle-0001', 'result.json'), '{"verdict":"PA'); // check died while writing it
    fs.symlinkSync(path.join(evidence, 'nowhere'), path.join(evidence, 'cycle-0001-attempt-3')); // a dangling link named like an attempt
    const plan = planAttempt(evidence, 'cycle-0001', 7);
    assert.equal(plan.fresh, 'cycle-0001-attempt-7');
    assert.ok(plan.earlierAttempts.includes('cycle-0001'));
  });
  test('D11: a saved clearance is used only if it is this cycle\'s clearance of this claim', () => {
    const saved = { cycle: 3, digest: 'd'.repeat(64), uncommitted: { seq: 9, actionId: 'a9' } };
    assert.equal(clearanceMatches(saved, 3, { seq: 9, actionId: 'a9' }), true);
    assert.equal(clearanceMatches(saved, 4, { seq: 9, actionId: 'a9' }), false);
    assert.equal(clearanceMatches(saved, 3, { seq: 10, actionId: 'a9' }), false);
    assert.equal(clearanceMatches({ unreadable: true }, 3, { seq: 9, actionId: 'a9' }), false);
    assert.equal(clearanceMatches(null, 3, { seq: 9, actionId: 'a9' }), false);
  });
  test('D12: the strict target rule takes a real IPv4 address only', async () => {
    const deps = { tcp: async () => 'timeout', interfaces: {}, resolves: async () => 'error:EAI_AGAIN', authenticated: async () => null, unsigned: async () => 401, egress: async () => ({ probes: [], listeners: [] }) };
    const probe = async (target) => (await runNetcheck({ strict: true, ...deps, target })).probes.find((p) => p.name === 'recorder target is an IPv4 address').ok;
    assert.equal(await probe('192.168.1.20:8787'), true);
    assert.equal(await probe('999.999.999.999:8787'), false);
    assert.equal(await probe('192.168.1.256:8787'), false);
  });
});
