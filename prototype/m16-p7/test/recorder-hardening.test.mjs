// Second safety review, independent reviewer's findings C1 to C12 and F13, F15 of the post-commit review: recorder side.
// HARNESS tests only: an in-process recorder on a temporary directory, loopback only.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecorder, createRun, cycleView, dirReport, ledgerProblems, parseCutCommand, runStore } from '../recorder.mjs';
import { keyFromHex, makeClient, runTag, signRequest } from '../lib/protocol.mjs';
import { classifyCycle } from '../lib/verdict.mjs';
import { LOCK_FILE } from '../lib/lock.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-hardening-'));
const FRAGMENT = '{"reason":"bad_mac","at":"2026-11-18T0';
async function openCycle(run, opts) {
  const dir = fs.mkdtempSync(path.join(tmp, 'r-'));
  createRun(dir, { run, failureModel: 'HARNESS-SMOKE' });
  const x = { dir, run, store: () => runStore(dir, run), root: path.join(dir, 'runs', run) };
  let server;
  const listen = async () => {
    server = createRecorder(dir, opts);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    x.base = `http://127.0.0.1:${server.address().port}`;
    x.key = keyFromHex(fs.readFileSync(path.join(dir, 'keys', `${run}.key`), 'utf8'));
    x.call = makeClient({ baseUrl: x.base, key: x.key, run });
    x.post = (p, body) => x.call('POST', `/runs/${run}/${p}`, body).then((r) => ({ status: 200, data: r.data }), (e) => ({ status: e.status, data: e.data }));
    x.view = async (n = 1) => (await x.call('GET', `/runs/${run}/cycles/${n}`)).data;
  };
  x.restart = async () => { await new Promise((r) => server.close(r)); await listen(); };
  x.close = () => new Promise((r) => server.close(r));
  await listen();
  x.pg = '6900000000000000001';
  await x.post('event', { kind: 'volume_claimed', volume: { pgSystemId: x.pg, publicRelations: 0, stateEntries: 0, walLsnBytes: 1, serverVersion: '16.14' } });
  await x.post('event', { kind: 'initialised', installationId: 'inst-1' });
  x.start = (n, dbHead = 0, over = {}) => x.post(`cycles/${n}/start`, { pgSystemId: x.pg, proc: 'a', workers: 1, dbHead, sizing: { maxSeconds: 600 }, ...over });
  x.cycleId = (await x.start(1)).data.cycleId;
  x.actionId = `${runTag(run)}c0001aw1-1`;
  x.ack = (n, kind, over = {}) => x.post('ack', { cycle: 1, cycleId: x.cycleId, proc: 'a', worker: 1, n, kind, seq: 1, actionId: x.actionId, ...over });
  assert.equal((await x.ack(1, 'claim')).status, 200);
  assert.equal((await x.ack(2, 'dispatch')).status, 200);
  return x;
}
const FINAL = { installationId: 'inst-1', head: 1, headHash: 'ab'.repeat(32) };
const MARKER = { what: 'dispatch', code: 'EIO', at: '2026-11-18T10:00:00.000Z', marker: 'found' };

describe('C1: a journal write failure the check recorded ends recovery, even when the marker is gone by then', () => {
  for (const [name, extra] of [['the marker, in the stored result', { journalWriteFailure: MARKER }], ['a worker\'s report listed in the stored result', { journalWriteFailuresReported: [{ kind: 'journal_write_failed' }] }]]) {
    test(`${name}: the recorder accepts no recovery for that cycle`, async () => {
      const x = await openCycle(`c1${name.length}`);
      assert.equal((await x.post('cycles/1/result', { cycleId: x.cycleId, verdict: 'INCONCLUSIVE', inconclusive: ['JOURNAL_WRITE_FAILED'], needsRecovery: [], ...extra })).status, 200);
      const rec = await x.post('cycles/1/recovered', { cycleId: x.cycleId, finalState: FINAL });
      assert.deepEqual([rec.status, rec.data.error], [409, 'journal_write_failed_in_this_cycle']);
      assert.equal(cycleView(x.store(), 1).recovered, null);
      await x.close();
    });
  }
  test('C7: a PASS whose list of reports is anything but empty or absent is refused, whatever its type', async () => {
    const x = await openCycle('c7');
    for (const journalWriteFailuresReported of ['one', { 0: 'x' }, 1, [{}], true]) {
      const r = await x.post('cycles/1/result', { cycleId: x.cycleId, verdict: 'PASS', needsRecovery: [], journalWriteFailuresReported });
      assert.deepEqual([r.status, r.data.error], [409, 'pass_reports_a_journal_write_failure'], JSON.stringify(journalWriteFailuresReported));
    }
    await x.close();
    // An empty list, or none, is not a report: in a cycle with no refusal on record such a PASS is stored.
    const y = await openCycle('c7ok');
    assert.equal((await y.post('cycles/1/result', { cycleId: y.cycleId, verdict: 'PASS', needsRecovery: [], journalWriteFailuresReported: [], journalWriteFailure: null })).status, 200);
    await y.close();
  });
});

describe('C2 and C3: an authenticated refusal the rejection log cannot take', () => {
  test('C2: it is kept as an event even while another process holds the directory lock', async () => {
    const x = await openCycle('c2a', { lockTimeoutMs: 60 });
    fs.writeFileSync(path.join(x.root, 'rejections.jsonl'), FRAGMENT);
    fs.writeFileSync(path.join(x.dir, LOCK_FILE), JSON.stringify({ pid: process.ppid, at: new Date().toISOString() })); // a live owner that is not this process
    const before = x.store().events().length;
    const refused = await x.ack(3, 'claim', { cycleId: 'f'.repeat(32) }); // the acknowledgement path runs outside the lock
    fs.rmSync(path.join(x.dir, LOCK_FILE));
    assert.deepEqual(refused.data, { error: 'refusal_not_recorded', refused: 'wrong_cycle_id', fallback: 'event' });
    assert.deepEqual(x.store().events().slice(before).map((e) => [e.kind, e.reason]), [['refusal_not_recorded', 'wrong_cycle_id']]);
    await x.close();
  });

  test('C2: a ledger of the run that ends in a fragment is damage the view shows and a restart does not forget: no PASS, INCONCLUSIVE', async () => {
    const x = await openCycle('c2b');
    assert.deepEqual((await x.view()).damage, { acknowledgementLedger: null, recorderMemory: null, runLedgers: null });
    fs.writeFileSync(path.join(x.root, 'rejections.jsonl'), FRAGMENT);
    await x.restart(); // nothing is in memory any more
    const v = await x.view();
    assert.equal(v.damaged, true);
    assert.match(v.damage.runLedgers, /^rejections\.jsonl ends in an incomplete line/);
    const verdict = classifyCycle({ comparison: { findings: [], counts: { claimAcks: 1 }, needsRecovery: [], relation: 'equal' }, run: { failureModel: 'HARNESS-SMOKE', storage: {} }, cycle: { settings: {}, cutSentAt: 'x', cutConfirmed: 'yes', recorderDamage: v.damage } });
    assert.ok(verdict.inconclusive.includes('RECORDER_CYCLE_RECORDS_DAMAGED'));
    const pass = await x.post('cycles/1/result', { cycleId: x.cycleId, verdict: 'PASS', needsRecovery: [] });
    assert.equal(pass.data.refused ?? pass.data.error, 'pass_for_a_cycle_the_recorder_marked_damaged');
    assert.equal(x.store().result(1), null);
    await x.close();
  });

  test('C3: a replayed or stale request is refused without writing to the run\'s event ledger, however often it is sent', async () => {
    const x = await openCycle('c3');
    const body = JSON.stringify({ kind: 'netcheck', detail: 'x' });
    const headers = signRequest(x.key, { method: 'POST', path: `/runs/${x.run}/event`, run: x.run, body });
    const send = (h) => fetch(`${x.base}/runs/${x.run}/event`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal((await send(headers)).status, 200);
    fs.writeFileSync(path.join(x.root, 'rejections.jsonl'), FRAGMENT);
    const events = fs.readFileSync(path.join(x.root, 'events.jsonl'));
    for (let i = 0; i < 6; i++) assert.deepEqual(await send(headers), { status: 500, body: { error: 'refusal_not_recorded', refused: 'replayed_nonce', fallback: 'none' } });
    const stale = signRequest(x.key, { method: 'POST', path: `/runs/${x.run}/event`, run: x.run, body, now: Date.now() - 3_600_000 });
    assert.equal((await send(stale)).status, 500);
    assert.ok(fs.readFileSync(path.join(x.root, 'events.jsonl')).equals(events), 'the event ledger is byte for byte as it was');
    // The cycle is not left looking clean: the damaged ledger itself makes it INCONCLUSIVE, and this server takes nothing more.
    const v = await x.view();
    assert.equal(v.damaged, true);
    assert.match(v.damage.recorderMemory, /refusal could not be recorded/);
    await x.close();
  });
});

describe('C4: what stops a cycle from starting', () => {
  test('a torn ledger the cycle depends on does; a closed cycle\'s acknowledgement file and the recorder-wide rejection log do not', async () => {
    const x = await openCycle('c4');
    assert.equal((await x.post('cycles/1/result', { cycleId: x.cycleId, verdict: 'INCONCLUSIVE', inconclusive: ['NOT_A_DURABILITY_RUN'], needsRecovery: [] })).status, 200);
    assert.equal((await x.post('cycles/1/recovered', { cycleId: x.cycleId, finalState: FINAL })).status, 200);
    const vet = () => x.start(2, 1, { vet: true }).then((r) => (r.status === 200 ? 'vetted' : `${r.status} ${r.data.refused ?? r.data.error}`));
    assert.equal(await vet(), 'vetted');
    fs.appendFileSync(path.join(x.root, 'acks', 'cycle-0001.jsonl'), '{"frag');
    fs.writeFileSync(path.join(x.dir, 'rejections.jsonl'), FRAGMENT);
    assert.equal(await vet(), 'vetted', 'cycle 1 is closed and was judged with what it had; unauthenticated noise is not this run\'s record');
    assert.match(dirReport(x.dir).problems.join(' | '), /acks\/cycle-0001\.jsonl ends in an incomplete line.*\| rejections\.jsonl ends in an incomplete line|rejections\.jsonl ends.*acks\/cycle-0001/, 'verify-dir still reports both');
    for (const [file, where] of [['accepted.jsonl', x.root], ['volumes.jsonl', x.dir]]) {
      const f = path.join(where, file), had = fs.existsSync(f) ? fs.readFileSync(f) : null;
      fs.appendFileSync(f, '{"frag');
      assert.match(await vet(), new RegExp(`^409 recorder_ledger_ends_in_a_fragment: .*${file.replace('.', '\\.')}$`), file);
      if (had) fs.writeFileSync(f, had); else fs.rmSync(f); // (a test may; an operator never edits a ledger)
    }
    assert.equal(await vet(), 'vetted');
    await x.close();
  });
});

describe('C10 and C12: a ledger that cannot be read is reported, by name, without a path and without a throw', () => {
  test('verify-dir lists it; a request for the run is answered with the cause', async () => {
    const x = await openCycle('c10');
    const f = path.join(x.root, 'accepted.jsonl');
    fs.writeFileSync(f, '{"a":1}\n');
    fs.chmodSync(f, 0o000);
    try {
      assert.deepEqual(ledgerProblems(x.dir).map((p) => [p.file, p.problem]), [[`runs/${x.run}/accepted.jsonl`, 'cannot be read (EACCES)']]);
      assert.match(dirReport(x.dir).problems.join(' | '), /accepted\.jsonl cannot be read \(EACCES\)/);
      const started = await x.start(2, 1, { vet: true });
      assert.ok(started.status >= 400 && !JSON.stringify(started.data).includes(x.dir), 'refused, and the answer carries no path of the recorder host');
    } finally { fs.chmodSync(f, 0o644); }
    await x.close();
  });
  test('C12: an unreadable ledger is called that, not "recorder key unreadable"', async () => {
    const x = await openCycle('c12');
    fs.appendFileSync(path.join(x.root, 'events.jsonl'), 'garbage\n');
    await x.restart();
    const r = await fetch(`${x.base}/runs/${x.run}`).then(async (res) => ({ status: res.status, body: await res.json() }));
    assert.deepEqual(r, { status: 500, body: { error: 'a ledger of this run cannot be read' } });
    await x.close();
  });
});

describe('F13: the cut command is understood before anything is scheduled', () => {
  test('only a non-empty array of strings, or nothing', () => {
    assert.equal(parseCutCommand(undefined), null, 'no command: the manual prompt');
    assert.deepEqual(parseCutCommand('["curl","-s","http://plug.local/off"]'), ['curl', '-s', 'http://plug.local/off']);
    for (const bad of ['{not json', '"curl http://plug"', '{"cmd":"x"}', '[]', '[""]', '["ok", 5]', 'null', '7']) assert.throws(() => parseCutCommand(bad), /--command-json must be/, bad);
  });
});

describe('F15: a recovery report that is repeated after a failed write does not record the accepted claim twice', () => {
  test('the accepted line is written once', async () => {
    const x = await openCycle('f15');
    const uncommitted = { seq: 2, actionId: `${runTag('f15')}c0001aw1-2` };
    assert.equal((await x.post('cycles/1/result', { cycleId: x.cycleId, verdict: 'INCONCLUSIVE', inconclusive: ['NOT_A_DURABILITY_RUN'], needsRecovery: ['clear'], quarantineRequired: true, uncommitted })).status, 200);
    assert.equal((await x.post('event', { cycle: 1, cycleId: x.cycleId, kind: 'quarantine_observed', detail: 'ahead' })).status, 200);
    const events = path.join(x.root, 'events.jsonl'), whole = fs.readFileSync(events);
    fs.appendFileSync(events, '{"kind":"frag'); // the event that completes the recovery cannot be written
    const body = { cycleId: x.cycleId, finalState: { ...FINAL, head: 2 }, cleared: true, uncommitted, digest: 'd'.repeat(64) };
    assert.equal((await x.post('cycles/1/recovered', body)).status, 500);
    fs.writeFileSync(events, whole); // (a test may)
    assert.equal((await x.post('cycles/1/recovered', body)).status, 200);
    assert.deepEqual(x.store().accepted().map((u) => [u.cycle, u.seq, u.digest]), [[1, 2, 'd'.repeat(64)]]);
    await x.close();
  });
});
