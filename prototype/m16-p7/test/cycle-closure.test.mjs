// Finding A of the second safety review: a cycle that could never be closed. The recorder refused a PASS for a cycle
// whose acknowledgement records were damaged, but its cycle view said nothing about the damage, so `check` computed
// PASS, saved it write-once, and re-sent the same refused result on every run.
// Part 1: the served cycle view says what is damaged (in the ledger, and what only the running server knows), and that
//         makes the cycle INCONCLUSIVE before a result is saved.
// Part 2: a saved result the recorder refused is kept as evidence, is never sent again, and does not block a fresh
//         attempt in a directory of its own.
// `p7.mjs check` only loads inside the image, so the sequence below is driven with the same library functions it uses
// (lib/attempts.mjs, lib/verdict.mjs) against a real in-process recorder. HARNESS tests only.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecorder, createRun, runStore } from '../recorder.mjs';
import { keyFromHex, makeClient, runTag } from '../lib/protocol.mjs';
import { classifyCycle, finalStatus } from '../lib/verdict.mjs';
import { writeOnce } from '../lib/ledger.mjs';
import { attemptIdentity, isRefusal, planAttempt, recordRefusal } from '../lib/attempts.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-closure-'));
const RUN = { failureModel: 'POWER-CUT', storage: { driveModel: 'Example SSD 1TB', firmware: '1B2QEXM7', controller: 'NVMe (PCIe)', dbDevice: 'nvme0n1p2', journalDevice: 'nvme0n1p2', filesystem: 'ext4 rw,relatime', vendorDoc: 'vendor datasheet rev 3, section 4.2', evidenceFiles: 'host/baseline/*', writeCache: 'write back', fua: 'yes', flushSupported: 'yes', flushesObserved: 'yes', vendorFlushSemantics: 'yes', plp: 'unknown' } };
const CYCLE = { settings: { fsync: 'on', full_page_writes: 'on', synchronous_commit: 'on' }, cutSentAt: '2026-11-18T10:00:00.000Z', cutConfirmed: 'yes', workerStopsBeforeCut: [], silentWorkerStops: [], rebootObservedAfterCut: true, authenticatedRejections: 0 };
const OK = { findings: [], counts: { claimAcks: 1 }, needsRecovery: [], relation: 'equal' }; // a comparison that verified

/** A recorder on a temporary directory with cycle 1 open and one claim acknowledged. `restart` is a new server process's view. */
async function openCycle(run) {
  const dir = fs.mkdtempSync(path.join(tmp, 'r-'));
  createRun(dir, { run, failureModel: 'HARNESS-SMOKE' });
  let server;
  const key = () => keyFromHex(fs.readFileSync(path.join(dir, 'keys', `${run}.key`), 'utf8'));
  const x = { dir, run, store: () => runStore(dir, run) };
  const listen = async () => {
    server = createRecorder(dir);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    x.call = makeClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, key: key(), run });
    x.post = (p, body) => x.call('POST', `/runs/${run}/${p}`, body).then((r) => ({ status: 200, data: r.data }), (e) => ({ status: e.status, data: e.data }));
    x.view = async () => (await x.call('GET', `/runs/${run}/cycles/1`)).data;
  };
  x.restart = async () => { await new Promise((r) => server.close(r)); await listen(); };
  x.close = () => new Promise((r) => server.close(r));
  await listen();
  const pg = '7000000000000000001';
  await x.post('event', { kind: 'volume_claimed', volume: { pgSystemId: pg, publicRelations: 0, stateEntries: 0, walLsnBytes: 1, serverVersion: '16.14' } });
  await x.post('event', { kind: 'initialised', installationId: 'inst-1' });
  x.cycleId = (await x.post('cycles/1/start', { pgSystemId: pg, proc: 'a', workers: 1, dbHead: 0, sizing: { maxSeconds: 600 } })).data.cycleId;
  x.actionId = `${runTag(run)}c0001aw1-1`;
  x.ack = (n, kind) => x.post('ack', { cycle: 1, cycleId: x.cycleId, proc: 'a', worker: 1, n, kind, seq: 1, actionId: x.actionId });
  assert.equal((await x.ack(1, 'claim')).status, 200);
  x.ackFile = path.join(dir, 'runs', run, 'acks', 'cycle-0001.jsonl');
  return x;
}

describe('Finding A, part 1: the cycle view says what is damaged', () => {
  test('a clean cycle: no damage, in a fixed shape', async () => {
    const x = await openCycle('c0');
    const v = await x.view();
    assert.deepEqual([v.damaged, v.damage], [false, { acknowledgementLedger: null, recorderMemory: null, runLedgers: null }]);
    await x.close();
  });

  test('an acknowledgement file that ends in a fragment: ledger damage, seen by any server that reads the file', async () => {
    const x = await openCycle('c1');
    fs.appendFileSync(x.ackFile, '{"cycle":1,"kind":"disp'); // the recorder died mid-line
    await x.restart();
    const v = await x.view();
    assert.equal(v.damaged, true);
    assert.match(v.damage.acknowledgementLedger, /torn final line/);
    assert.equal(v.damage.recorderMemory, null);
    assert.equal(v.acks.length, 1, 'the complete acknowledgement is still read; the fragment is not counted as one');
    await x.close();
  });

  test('an acknowledgement file that is inconsistent (a line out of order): ledger damage too', async () => {
    const x = await openCycle('c2');
    const line = JSON.parse(fs.readFileSync(x.ackFile, 'utf8').trim());
    fs.appendFileSync(x.ackFile, `${JSON.stringify({ ...line, n: 5 })}\n`); // n jumps from 1 to 5
    await x.restart();
    const v = await x.view();
    assert.equal(v.damaged, true);
    assert.match(v.damage.acknowledgementLedger, /inconsistent \(out_of_order\)/);
    await x.close();
  });

  test('an acknowledgement the server could not store: damage only the running server knows, reported as such', async () => {
    const x = await openCycle('c3');
    fs.chmodSync(x.ackFile, 0o444); // the next append fails
    const failed = await x.ack(2, 'dispatch');
    assert.equal(failed.status, 500);
    fs.chmodSync(x.ackFile, 0o644);
    const v = await x.view();
    assert.equal(v.damaged, true);
    assert.equal(v.damage.acknowledgementLedger, null, 'the file itself is whole');
    assert.match(v.damage.recorderMemory, /^an acknowledgement could not be stored \(EACCES\)$/);
    assert.equal((await x.post('cycles/1/result', { cycleId: x.cycleId, verdict: 'PASS', needsRecovery: [] })).data.error, 'pass_for_a_cycle_the_recorder_marked_damaged');
    await x.close();
  });

  test('an authenticated refusal that could be recorded nowhere: the same, and nothing secret is in the view', async () => {
    const x = await openCycle('c4');
    fs.writeFileSync(path.join(x.dir, 'runs', x.run, 'rejections.jsonl'), '{"re');
    fs.appendFileSync(path.join(x.dir, 'runs', x.run, 'events.jsonl'), '{"kind":"frag');
    const refused = await x.post('ack', { cycle: 1, cycleId: 'f'.repeat(32), proc: 'a', worker: 1, n: 2, kind: 'dispatch', seq: 1, actionId: x.actionId });
    assert.deepEqual(refused.data, { error: 'refusal_not_recorded', refused: 'wrong_cycle_id', fallback: 'none' });
    const v = await x.view();
    assert.deepEqual([v.damaged, v.damage.acknowledgementLedger, v.damage.recorderMemory], [true, null, 'an authenticated refusal could not be recorded']);
    assert.match(v.damage.runLedgers, /^events\.jsonl ends in an incomplete line$/, 'and the damaged ledger is named, by file name only');
    const text = JSON.stringify(v);
    assert.ok(!text.includes(fs.readFileSync(path.join(x.dir, 'keys', `${x.run}.key`), 'utf8').trim()), 'the run key is not in the view');
    assert.ok(!/"mac"|x-p7-mac/i.test(text), 'no MAC is in the view');
    await x.close();
  });

  test('the verdict: any recorder damage makes the cycle INCONCLUSIVE, and never softens a FAIL', () => {
    assert.equal(classifyCycle({ comparison: OK, run: RUN, cycle: CYCLE }).verdict, 'PASS');
    for (const recorderDamage of [{ acknowledgementLedger: 'recorder acknowledgement file has a torn final line', recorderMemory: null }, { acknowledgementLedger: null, recorderMemory: 'an acknowledgement could not be stored (EIO)' }]) {
      const r = classifyCycle({ comparison: OK, run: RUN, cycle: { ...CYCLE, recorderDamage } });
      assert.deepEqual([r.verdict, r.inconclusive], ['INCONCLUSIVE', ['RECORDER_CYCLE_RECORDS_DAMAGED']]);
      assert.equal(finalStatus({ verdict: r.verdict }, { cleared: false }), 'INCONCLUSIVE', 'recovered or not, it is never a PASS');
    }
    assert.equal(classifyCycle({ comparison: OK, run: RUN, cycle: { ...CYCLE, recorderDamage: { acknowledgementLedger: null, recorderMemory: null } } }).verdict, 'PASS', 'no damage, no reason');
    const failed = classifyCycle({ comparison: { ...OK, findings: [{ severity: 'fail', code: 'JOURNAL_CORRUPT' }] }, run: RUN, cycle: { ...CYCLE, recorderDamage: { acknowledgementLedger: 'x', recorderMemory: null } } });
    assert.deepEqual([failed.verdict, failed.inconclusive], ['FAIL', ['RECORDER_CYCLE_RECORDS_DAMAGED']]);
  });
});

describe('Finding A, part 2: a refused result is evidence, not a dead end', () => {
  const base = 'cycle-0001';
  /** What `p7.mjs check` does with a verdict: a directory of its own, the result written once, then posted. */
  async function attempt(x, evidence, { verdict, ...rest }) {
    const plan = planAttempt(evidence, base);
    assert.ok(plan.fresh, `expected a fresh attempt, got ${JSON.stringify(plan)}`);
    const dir = path.join(evidence, plan.fresh);
    fs.mkdirSync(dir);
    const result = { cycleId: x.cycleId, verdict, needsRecovery: [], attempt: attemptIdentity(plan), ...rest };
    writeOnce(path.join(dir, 'result.json'), result);
    const posted = await x.call('POST', `/runs/${x.run}/cycles/1/result`, result).then(() => null, (e) => e);
    if (posted && isRefusal(posted)) recordRefusal(dir, posted);
    return { name: plan.fresh, dir, result, error: posted };
  }
  const resend = async (x, evidence, name) => {
    const saved = JSON.parse(fs.readFileSync(path.join(evidence, name, 'result.json'), 'utf8'));
    const e = await x.call('POST', `/runs/${x.run}/cycles/1/result`, saved).then(() => null, (err) => err);
    if (e && isRefusal(e)) recordRefusal(path.join(evidence, name), e);
    return e;
  };

  test('the whole sequence: PASS saved and refused, the repeated check, then a fresh attempt that closes the cycle', async () => {
    const x = await openCycle('d1');
    const evidence = fs.mkdtempSync(path.join(tmp, 'evidence-'));
    fs.appendFileSync(x.ackFile, '{"cycle":1,"kind":"disp');
    await x.restart();

    // 1. As before the fix: `check` did not know about the damage, computed PASS, saved it, and the recorder refused it.
    const first = planAttempt(evidence, base);
    assert.deepEqual(first, { fresh: base, earlierAttempts: [], refusedEarlier: [] });
    fs.mkdirSync(path.join(evidence, base));
    const stale = { cycleId: x.cycleId, verdict: 'PASS', needsRecovery: [] };
    writeOnce(path.join(evidence, base, 'result.json'), stale);
    const savedBytes = fs.readFileSync(path.join(evidence, base, 'result.json'));
    // 2. The repeated check: the saved result is still the one to send (it may simply not have been delivered) ...
    assert.deepEqual(planAttempt(evidence, base), { resend: base });
    const refusal = await resend(x, evidence, base);
    assert.deepEqual([refusal.status, refusal.data.error, isRefusal(refusal)], [409, 'pass_for_a_cycle_the_recorder_marked_damaged', true]);
    assert.equal(x.store().result(1), null, 'the recorder stored nothing: a refused PASS is not an accepted PASS');
    // ... and once it was refused, it is marked, kept, and never sent again.
    const markers = fs.readdirSync(path.join(evidence, base)).filter((f) => f.startsWith('result-refused-'));
    assert.equal(markers.length, 1);
    const marker = JSON.parse(fs.readFileSync(path.join(evidence, base, markers[0]), 'utf8'));
    assert.deepEqual([marker.refusedBy, marker.status, marker.error, marker.verdictOfTheRefusedResult === undefined], ['recorder', 409, 'pass_for_a_cycle_the_recorder_marked_damaged', true]);
    const next = planAttempt(evidence, base, 1794900000000);
    assert.deepEqual(next, { fresh: `${base}-attempt-1794900000000`, earlierAttempts: [base], refusedEarlier: [{ attempt: base, marker: markers[0], error: 'pass_for_a_cycle_the_recorder_marked_damaged' }] });

    // 3. The fresh attempt: `check` reads the view, which now shows the damage, and classifies before it saves anything.
    const v = await x.view();
    const verdict = classifyCycle({ comparison: OK, run: { ...RUN, failureModel: 'HARNESS-SMOKE' }, cycle: { ...CYCLE, recorderDamage: v.damage } });
    assert.ok(verdict.verdict === 'INCONCLUSIVE' && verdict.inconclusive.includes('RECORDER_CYCLE_RECORDS_DAMAGED'));
    const fresh = await attempt(x, evidence, { verdict: verdict.verdict, inconclusive: verdict.inconclusive });
    assert.equal(fresh.error, null, 'the recorder accepts it');
    // The cycle is closed, with the fresh attempt's result and nothing of the refused one.
    const stored = x.store().result(1);
    assert.deepEqual([stored.verdict, stored.attempt.dir, stored.attempt.refusedEarlier.map((r) => r.attempt)], ['INCONCLUSIVE', fresh.name, [base]]);
    assert.match(stored.attempt.id, /^[0-9a-f-]{36}$/);
    assert.notEqual(fresh.name, base, 'its own directory');
    assert.equal((await x.view()).final, 'INCONCLUSIVE');
    // The refused result is still there, byte for byte, beside its marker.
    assert.ok(fs.readFileSync(path.join(evidence, base, 'result.json')).equals(savedBytes));
    assert.deepEqual(fs.readdirSync(path.join(evidence, base)).sort(), ['result.json', markers[0]].sort());
    await x.close();
  });

  test('every attempt has its own identity, and a refused PASS can be followed by another refused PASS without either being sent twice', async () => {
    const x = await openCycle('d2');
    const evidence = fs.mkdtempSync(path.join(tmp, 'evidence-'));
    fs.appendFileSync(x.ackFile, '{"frag');
    await x.restart();
    const a = await attempt(x, evidence, { verdict: 'PASS' });
    const b = await attempt(x, evidence, { verdict: 'PASS' }); // a check that still computed PASS: refused again, in its own directory
    assert.ok(isRefusal(a.error) && isRefusal(b.error));
    assert.notEqual(a.name, b.name);
    assert.notEqual(a.result.attempt.id, b.result.attempt.id);
    assert.deepEqual(b.result.attempt.refusedEarlier.map((r) => r.attempt), [a.name]);
    assert.deepEqual(b.result.attempt.earlierAttempts, [a.name]);
    const plan = planAttempt(evidence, base);
    assert.ok(plan.fresh && plan.refusedEarlier.length === 2 && !plan.resend, 'neither refused result is offered for sending again');
    assert.equal(x.store().result(1), null);
    await x.close();
  });

  test('only a refusal by the recorder releases a saved result: an undelivered one is still re-sent, as it is', async () => {
    const evidence = fs.mkdtempSync(path.join(tmp, 'evidence-'));
    fs.mkdirSync(path.join(evidence, base));
    writeOnce(path.join(evidence, base, 'result.json'), { verdict: 'INCONCLUSIVE' });
    assert.deepEqual(planAttempt(evidence, base), { resend: base });
    for (const e of [
      Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
      new Error('fetch failed'),
      Object.assign(new Error('not authenticated'), { status: 409, unauthenticated: true }),
      Object.assign(new Error('500'), { status: 500, data: { error: 'events.jsonl ends in an incomplete line' } }),
      Object.assign(new Error('503'), { status: 503, data: { error: 'recorder_busy' } }),
    ]) assert.equal(isRefusal(e), false, e.message);
    assert.deepEqual(planAttempt(evidence, base), { resend: base }, 'nothing was marked, so the same result is sent again next time');
    // What does count: an authenticated 4xx with a reason, and a refusal the recorder could not log as usual.
    assert.equal(isRefusal(Object.assign(new Error('409'), { status: 409, data: { error: 'pass_reports_a_journal_write_failure' } })), true);
    assert.equal(isRefusal(Object.assign(new Error('500'), { status: 500, data: { error: 'refusal_not_recorded', refused: 'pass_for_a_cycle_the_recorder_marked_damaged', fallback: 'event' } })), true);
    // An attempt directory an earlier check left without a result (it died) is neither sent nor reused.
    fs.mkdirSync(path.join(evidence, `${base}-attempt-5`));
    recordRefusal(path.join(evidence, base), Object.assign(new Error('409'), { status: 409, data: { error: 'x' } }), 7);
    assert.deepEqual(planAttempt(evidence, base, 9), { fresh: `${base}-attempt-9`, earlierAttempts: [base, `${base}-attempt-5`], refusedEarlier: [{ attempt: base, marker: 'result-refused-7.json', error: 'x' }] });
    assert.throws(() => recordRefusal(path.join(evidence, base), Object.assign(new Error('409'), { status: 409, data: { error: 'x' } }), 7), /EEXIST/, 'a marker is written once, never over another');
  });
});
