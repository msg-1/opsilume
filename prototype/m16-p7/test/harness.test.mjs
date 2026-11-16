// Deterministic tests of the P7 harness logic: journal scan, torn-tail repair, comparison, classification, streak,
// ledger and recorder. They need only Node (no Docker, no PostgreSQL, no Prisma). These are HARNESS tests: they
// say nothing about durability. Run: node --test prototype/m16-p7/test/
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GENESIS, serialize } from '../../m16-phase05/lib/journal.mjs';
import { addFp, fp, hex, repairAppliedAt, repairBytes, scanJournal } from '../lib/scan.mjs';
import { classifyCycle, compareCycle, physicalStreak } from '../lib/verdict.mjs';
import { appendDurable, readLedger, writeOnce } from '../lib/ledger.mjs';
import { createRecorder, runStore } from '../recorder.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-harness-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let fileNo = 0;
const AT = '2026-11-17T00:00:00.000Z';

/** Writes a journal from records (each chained to the previous); returns { file, hashes }. */
function journalOf(entries, { tail = '' } = {}) {
  const file = path.join(tmp, `journal-${++fileNo}.log`);
  let prev = GENESIS, text = '';
  const hashes = [];
  for (const e of entries) {
    const line = serialize({ at: AT, ...e }, prev);
    prev = JSON.parse(line).hash;
    hashes.push(prev);
    text += line;
  }
  fs.writeFileSync(file, text + tail);
  return { file, hashes, lastHash: prev };
}
const claimsAndDispatches = (from, to, id = (s) => `a-${s}`) => Array.from({ length: to - from + 1 }, (_, i) => from + i).flatMap((seq) => [{ type: 'claim', seq, actionId: id(seq), org: 'org-p7', attempt: 1 }, { type: 'dispatch', seq, synthetic: true }]);
const sumFp = (pairs) => hex(pairs.reduce((s, [seq, id]) => addFp(s, fp(seq, id)), 0n));

/** A consistent cycle: journal and database agree on claims 1..n, all acknowledged. */
function scenario({ n = 5, windowFrom = 0, journalEntries, dbClaims, dbHead, acks } = {}) {
  const entries = journalEntries ?? claimsAndDispatches(1, n);
  const j = journalOf(entries);
  const journal = { ...scanJournal(j.file, { windowFrom }), installationId: 'inst-1' };
  const committed = dbClaims ?? Array.from({ length: n }, (_, i) => [i + 1, `a-${i + 1}`]);
  const head = dbHead ?? (committed.length ? Math.max(...committed.map((c) => c[0])) : 0);
  const claimHash = new Map(entries.map((e, i) => [e, j.hashes[i]]).filter(([e]) => e.type === 'claim').map(([e, h]) => [e.seq, h]));
  const db = {
    installationId: 'inst-1', head, headHash: head === 0 ? GENESIS : claimHash.get(head) ?? 'unknown',
    count: committed.length, fingerprint: sumFp(committed), duplicates: 0,
    claims: new Map(committed.filter(([s]) => s > windowFrom).map(([s, id]) => [s, { actionId: id }])),
  };
  const ackList = acks ?? committed.filter(([s]) => s > windowFrom).flatMap(([seq, actionId]) => [{ kind: 'claim', seq, actionId }, { kind: 'dispatch', seq, actionId }]);
  return { journal, db, acks: ackList, windowFrom };
}
const codes = (c) => c.findings.filter((f) => f.severity === 'fail').map((f) => f.code).sort();
const RUN = { failureModel: 'POWER-CUT', storage: { writeCache: 'write back', flushHonoured: 'yes', plp: 'unknown' } };
const CYCLE = { settings: { fsync: 'on', full_page_writes: 'on', synchronous_commit: 'on', wal_sync_method: 'fdatasync' }, cutSentAt: AT, cutConfirmed: 'yes', workerStopsBeforeCut: [] };

describe('journal scan', () => {
  test('claims and dispatch intents: head, count, fingerprint and the cycle window', () => {
    const j = journalOf(claimsAndDispatches(1, 3));
    const s = scanJournal(j.file, { windowFrom: 1 });
    assert.equal(s.status, 'ok');
    assert.equal(s.head, 3);
    assert.equal(s.count, 3);
    assert.equal(s.fingerprint, sumFp([[1, 'a-1'], [2, 'a-2'], [3, 'a-3']]));
    assert.deepEqual([...s.claims.keys()], [2, 3]);
    assert.deepEqual([...s.dispatches], [2, 3]);
    assert.equal(s.claims.get(3).dispatched, true);
  });
  test('a void removes the latest claim from the fingerprint and the window; its sequence number is reused', () => {
    const j = journalOf([{ type: 'claim', seq: 1, actionId: 'a' }, { type: 'claim', seq: 2, actionId: 'b' }, { type: 'void', seq: 2 }, { type: 'claim', seq: 2, actionId: 'c' }]);
    const s = scanJournal(j.file);
    assert.equal(s.count, 2);
    assert.equal(s.fingerprint, sumFp([[1, 'a'], [2, 'c']]));
    assert.equal(s.claims.get(2).actionId, 'c');
  });
  test('missing file', () => assert.equal(scanJournal(path.join(tmp, 'nope.log')).status, 'missing'));
  test('torn final line is reported with its length, not as corruption', () => {
    const j = journalOf(claimsAndDispatches(1, 2), { tail: '{"type":"claim","seq":3' });
    const s = scanJournal(j.file);
    assert.equal(s.status, 'torn_tail');
    assert.equal(s.tornBytes, 23);
    assert.equal(s.head, 2);
  });
  test('a complete final line with a bad hash is corrupt, and the evidence says it is the final line (N1 gap)', () => {
    const j = journalOf(claimsAndDispatches(1, 2));
    fs.writeFileSync(j.file, fs.readFileSync(j.file, 'utf8').replace(/"synthetic":true(?=[^\n]*\n$)/, '"synthetic":false'));
    const s = scanJournal(j.file);
    assert.equal(s.status, 'corrupt');
    assert.equal(s.corruptIsFinalLine, true);
  });
  test('an edit in the middle is corrupt and not the final line', () => {
    const j = journalOf(claimsAndDispatches(1, 3));
    fs.writeFileSync(j.file, fs.readFileSync(j.file, 'utf8').replace('"a-2"', '"a-X"'));
    const s = scanJournal(j.file);
    assert.equal(s.status, 'corrupt');
    assert.equal(s.corruptIsFinalLine, false);
  });
});

describe('torn-tail repair (N1)', () => {
  for (const [name, frag] of [['a partial record', '{"type":"claim","seq":3,"act'], ['a complete record missing only its newline', null]]) {
    test(`${name}: the repaired journal verifies and the torn claim is NOT resurrected`, () => {
      const base = journalOf(claimsAndDispatches(1, 2));
      const fragment = frag ?? serialize({ type: 'claim', seq: 3, actionId: 'a-3', at: AT }, base.lastHash).trimEnd();
      fs.appendFileSync(base.file, fragment);
      const torn = scanJournal(base.file);
      assert.equal(torn.status, 'torn_tail');
      fs.appendFileSync(base.file, repairBytes(torn.tornBytes, torn.lastHash, AT));
      const s = scanJournal(base.file);
      assert.equal(s.status, 'ok');
      assert.equal(s.head, 2);
      assert.equal(s.count, 2);
      assert.equal(s.types.repair, 1);
    });
  }
});

describe('comparison', () => {
  test('consistent cycle: no failures, heads equal', () => {
    const c = compareCycle(scenario());
    assert.deepEqual(codes(c), []);
    assert.equal(c.relation, 'equal');
    assert.equal(c.counts.claimAcks, 5);
  });
  test('an acknowledged claim missing from the journal and the database fails', () => {
    const s = scenario();
    s.acks.push({ kind: 'claim', seq: 6, actionId: 'a-6' });
    assert.deepEqual(codes(compareCycle(s)), ['ACKNOWLEDGED_CLAIM_MISSING_FROM_DATABASE', 'ACKNOWLEDGED_CLAIM_MISSING_FROM_JOURNAL']);
  });
  test('an acknowledged claim present in the journal but not committed fails', () => {
    const s = scenario({ journalEntries: claimsAndDispatches(1, 6), dbClaims: [1, 2, 3, 4, 5].map((i) => [i, `a-${i}`]) });
    s.acks.push({ kind: 'claim', seq: 6, actionId: 'a-6' });
    assert.ok(codes(compareCycle(s)).includes('ACKNOWLEDGED_CLAIM_MISSING_FROM_DATABASE'));
  });
  test('an acknowledgement with a different action id fails', () => {
    const s = scenario();
    s.acks[0] = { kind: 'claim', seq: 1, actionId: 'other' };
    assert.deepEqual(codes(compareCycle(s)), ['ACKNOWLEDGED_CLAIM_MISSING_FROM_DATABASE', 'ACKNOWLEDGED_CLAIM_MISSING_FROM_JOURNAL']);
  });
  test('a committed claim missing from the journal fails (database ahead)', () => {
    const s = scenario({ dbClaims: [1, 2, 3, 4, 5, 6].map((i) => [i, `a-${i}`]), acks: [] });
    assert.deepEqual(codes(compareCycle(s)), ['COMMITTED_CLAIM_MISSING_FROM_JOURNAL', 'DATABASE_AHEAD_OF_JOURNAL', 'HISTORY_DIFFERS']);
  });
  test('journal exactly one claim ahead, unacknowledged and uncommitted: not a failure, clearance needed', () => {
    const s = scenario({ journalEntries: [...claimsAndDispatches(1, 5), { type: 'claim', seq: 6, actionId: 'a-6' }], dbClaims: [1, 2, 3, 4, 5].map((i) => [i, `a-${i}`]) });
    const c = compareCycle(s);
    assert.deepEqual(codes(c), []);
    assert.equal(c.relation, 'journal-one-ahead');
    assert.deepEqual(c.uncommitted, { seq: 6, actionId: 'a-6' });
    assert.deepEqual(c.needsRecovery, ['clear']);
  });
  test('journal one ahead WITH a dispatch intent for that claim fails', () => {
    const s = scenario({ journalEntries: claimsAndDispatches(1, 6), dbClaims: [1, 2, 3, 4, 5].map((i) => [i, `a-${i}`]) });
    assert.deepEqual(codes(compareCycle(s)), ['DISPATCH_INTENT_WITHOUT_COMMITTED_CLAIM']);
  });
  test('journal two claims ahead fails', () => {
    const s = scenario({ journalEntries: claimsAndDispatches(1, 7), dbClaims: [1, 2, 3, 4, 5].map((i) => [i, `a-${i}`]) });
    assert.ok(codes(compareCycle(s)).includes('JOURNAL_AHEAD_BY_MORE_THAN_ONE'));
  });
  test('an uncommitted claim below the head fails', () => {
    const s = scenario({ dbClaims: [1, 2, 4, 5].map((i) => [i, `a-${i}`]), acks: [] });
    assert.deepEqual(codes(compareCycle(s)), ['DISPATCH_INTENT_WITHOUT_COMMITTED_CLAIM', 'HISTORY_DIFFERS', 'JOURNAL_CLAIM_NOT_COMMITTED']);
  });
  test('equal heads with different head hashes fail', () => {
    const s = scenario();
    s.db.headHash = 'f'.repeat(64);
    assert.deepEqual(codes(compareCycle(s)), ['HEAD_HASH_DIFFERS']);
  });
  test('an acknowledged dispatch intent missing from the journal fails', () => {
    const entries = claimsAndDispatches(1, 5).filter((e) => !(e.type === 'dispatch' && e.seq === 5));
    assert.deepEqual(codes(compareCycle(scenario({ journalEntries: entries }))), ['ACKNOWLEDGED_DISPATCH_INTENT_MISSING_FROM_JOURNAL']);
  });
  test('duplicate and out-of-cycle acknowledgements fail', () => {
    const s = scenario({ windowFrom: 2 });
    s.acks.push({ ...s.acks[0] }, { kind: 'claim', seq: 1, actionId: 'a-1' });
    assert.deepEqual(codes(compareCycle(s)), ['ACKNOWLEDGEMENT_OUTSIDE_CYCLE', 'DUPLICATE_ACKNOWLEDGEMENT']);
  });
  test('history: an earlier committed claim lost from the database fails even outside this cycle', () => {
    const s = scenario({ windowFrom: 3, dbClaims: [2, 3, 4, 5].map((i) => [i, `a-${i}`]) });
    assert.deepEqual(codes(compareCycle(s)), ['HISTORY_DIFFERS']);
  });
  test('history: a claim accepted as never committed by an earlier clearance is subtracted', () => {
    const s = scenario({ windowFrom: 3, dbClaims: [1, 2, 4, 5].map((i) => [i, `a-${i}`]) });
    s.journal.claims.delete(3); // outside the window anyway
    assert.deepEqual(codes(compareCycle({ ...s, accepted: [{ seq: 3, actionId: 'a-3' }] })), []);
  });
  test('torn final line: informational, repair needed', () => {
    const j = journalOf(claimsAndDispatches(1, 5), { tail: '{"type":"cl' });
    const s = scenario();
    s.journal = { ...scanJournal(j.file), installationId: 'inst-1' };
    const c = compareCycle(s);
    assert.deepEqual(codes(c), []);
    assert.deepEqual(c.needsRecovery, ['repair-torn-tail']);
  });
  test('missing or corrupt journal and a different installation identity fail', () => {
    assert.deepEqual(codes(compareCycle({ ...scenario(), journal: { status: 'missing' } })), ['JOURNAL_MISSING']);
    assert.deepEqual(codes(compareCycle({ ...scenario(), journal: { status: 'corrupt', problem: 'x' } })), ['JOURNAL_CORRUPT']);
    const s = scenario();
    s.db.installationId = 'inst-2';
    assert.deepEqual(codes(compareCycle(s)), ['INSTALLATION_IDENTITY_DIFFERS']);
  });
});

describe('classification', () => {
  const ok = () => compareCycle(scenario());
  test('everything verified: PASS, and it counts toward the physical requirement', () => {
    const r = classifyCycle({ comparison: ok(), run: RUN, cycle: CYCLE });
    assert.equal(r.verdict, 'PASS');
    assert.equal(r.countsTowardPhysicalPowerLoss, true);
  });
  for (const [name, run, cycle, code] of [
    ['write cache unknown', { ...RUN, storage: { writeCache: 'unknown', flushHonoured: 'yes' } }, CYCLE, 'STORAGE_FLUSH_BEHAVIOUR_UNVERIFIED'],
    ['flush behaviour unknown', { ...RUN, storage: { writeCache: 'write back', flushHonoured: 'unknown' } }, CYCLE, 'STORAGE_FLUSH_BEHAVIOUR_UNVERIFIED'],
    ['synchronous_commit off', RUN, { ...CYCLE, settings: { ...CYCLE.settings, synchronous_commit: 'off' } }, 'POSTGRESQL_DURABILITY_SETTINGS_NOT_ON'],
    ['no cut recorded', RUN, { ...CYCLE, cutSentAt: null }, 'NO_CUT_RECORDED'],
    ['power loss not confirmed', RUN, { ...CYCLE, cutConfirmed: 'no' }, 'POWER_LOSS_NOT_CONFIRMED'],
    ['a worker stopped before the cut', RUN, { ...CYCLE, workerStopsBeforeCut: [{ kind: 'worker_stopped' }] }, 'WORKLOAD_STOPPED_BEFORE_CUT'],
    ['a harness smoke run', { ...RUN, failureModel: 'HARNESS-SMOKE' }, CYCLE, 'NOT_A_DURABILITY_RUN'],
  ]) {
    test(`${name}: INCONCLUSIVE`, () => {
      const r = classifyCycle({ comparison: ok(), run, cycle });
      assert.equal(r.verdict, 'INCONCLUSIVE');
      assert.ok(r.inconclusive.includes(code), r.inconclusive.join());
      assert.equal(r.countsTowardPhysicalPowerLoss, false);
    });
  }
  test('no acknowledged claims: INCONCLUSIVE', () => {
    const r = classifyCycle({ comparison: compareCycle(scenario({ acks: [] })), run: RUN, cycle: CYCLE });
    assert.deepEqual(r.inconclusive, ['NO_ACKNOWLEDGED_CLAIMS']);
  });
  test('FAIL outranks INCONCLUSIVE, and a failed cycle asks for no recovery', () => {
    const s = scenario();
    s.acks.push({ kind: 'claim', seq: 9, actionId: 'a-9' });
    const r = classifyCycle({ comparison: compareCycle(s), run: { ...RUN, storage: {} }, cycle: CYCLE });
    assert.equal(r.verdict, 'FAIL');
    assert.deepEqual(r.needsRecovery, []);
  });
  test('a VM crash can pass but never counts toward the physical power-loss requirement', () => {
    const r = classifyCycle({ comparison: ok(), run: { ...RUN, failureModel: 'VM-CRASH' }, cycle: CYCLE });
    assert.equal(r.verdict, 'PASS');
    assert.equal(r.countsTowardPhysicalPowerLoss, false);
  });
});

describe('physical streak', () => {
  const pass = (cycle) => ({ cycle, verdict: 'PASS', countsTowardPhysicalPowerLoss: true });
  test('20 consecutive physical passes meet the requirement; 19 do not', () => {
    assert.equal(physicalStreak(Array.from({ length: 20 }, (_, i) => pass(i + 1))).met, true);
    assert.equal(physicalStreak(Array.from({ length: 19 }, (_, i) => pass(i + 1))).met, false);
  });
  test('an inconclusive cycle resets the streak', () => {
    const rs = Array.from({ length: 21 }, (_, i) => pass(i + 1));
    rs[1] = { cycle: 2, verdict: 'INCONCLUSIVE', countsTowardPhysicalPowerLoss: false };
    assert.deepEqual(physicalStreak(rs), { consecutivePhysicalPasses: 19, required: 20, met: false, stoppedAtCycle: null });
  });
  test('a failure stops the run whatever came before', () => {
    const rs = [...Array.from({ length: 25 }, (_, i) => pass(i + 1)), { cycle: 26, verdict: 'FAIL' }];
    assert.deepEqual(physicalStreak(rs), { consecutivePhysicalPasses: 0, required: 20, met: false, stoppedAtCycle: 26 });
  });
});

describe('ledger', () => {
  test('a torn last line is ignored and reported; an unreadable complete line is an error', () => {
    const f = path.join(tmp, 'ledger.jsonl');
    appendDurable(f, { a: 1 });
    fs.appendFileSync(f, '{"a":');
    assert.deepEqual(readLedger(f), { entries: [{ a: 1 }], tornBytes: 5 });
    fs.appendFileSync(f, '\n{"b":2}\n');
    assert.throws(() => readLedger(f), /line 2 is not a record/);
  });
  test('writeOnce never overwrites', () => {
    const f = path.join(tmp, 'once.json');
    writeOnce(f, { x: 1 });
    assert.throws(() => writeOnce(f, { x: 2 }), { code: 'EEXIST' });
    assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { x: 1 });
  });
});

describe('recorder', () => {
  const dir = path.join(tmp, 'recorder');
  let server, base;
  before(async () => {
    server = createRecorder(dir);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    for (const run of ['r1', 'r2']) runStore(dir, run).create({ run, failureModel: 'POWER-CUT', storage: RUN.storage });
  });
  after(() => server.close());
  const call = async (method, p, body) => {
    const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };

  test('an acknowledgement is on disk before the reply, and only for a started cycle', async () => {
    assert.equal((await call('POST', '/runs/r1/ack', { cycle: 1, kind: 'claim', seq: 1, actionId: 'a-1' })).status, 409);
    assert.equal((await call('POST', '/runs/r1/cycles/1/start', { proc: 'a', dbHead: 0, journalHead: 0, workers: 1 })).status, 200);
    assert.equal((await call('POST', '/runs/r1/ack', { cycle: 1, kind: 'claim', seq: 1, actionId: 'a-1' })).status, 200);
    assert.deepEqual(runStore(dir, 'r1').acks(1).map((a) => [a.cycle, a.kind, a.seq, a.actionId]), [[1, 'claim', 1, 'a-1']]);
    assert.equal((await call('POST', '/runs/r1/ack', { cycle: 1, kind: 'claim', seq: '2', actionId: 'a-2' })).status, 400);
    assert.equal((await call('POST', '/runs/r1/event', { cycle: 1, kind: 'cut_sent' })).status, 400, 'cut events only from the operator command');
  });
  test('the next cycle cannot start before this one is checked; a result is write-once', async () => {
    assert.equal((await call('POST', '/runs/r1/cycles/2/start', { dbHead: 1 })).status, 409);
    assert.equal((await call('POST', '/runs/r1/cycles/1/result', { verdict: 'PASS', needsRecovery: ['clear'], countsTowardPhysicalPowerLoss: true })).status, 200);
    assert.equal((await call('POST', '/runs/r1/cycles/1/result', { verdict: 'PASS' })).status, 409);
    assert.equal((await call('POST', '/runs/r1/ack', { cycle: 1, kind: 'claim', seq: 2, actionId: 'a-2' })).status, 409, 'no acknowledgements after the check');
  });
  test('recovery gates the next cycle and records the uncommitted claim it accepted', async () => {
    assert.match((await call('POST', '/runs/r1/cycles/2/start', { dbHead: 1 })).body.error, /needs recovery/);
    assert.equal((await call('POST', '/runs/r1/cycles/1/recovered', { uncommitted: { seq: 2, actionId: 'a-2' }, digest: 'd', steps: [] })).status, 200);
    assert.equal((await call('POST', '/runs/r1/cycles/2/start', { dbHead: 2 })).status, 200);
    assert.deepEqual((await call('GET', '/runs/r1')).body.accepted.map((u) => [u.seq, u.actionId]), [[2, 'a-2']]);
  });
  test('a FAIL stops the run: no further starts or acknowledgements', async () => {
    assert.equal((await call('POST', '/runs/r2/cycles/1/start', { dbHead: 0 })).status, 200);
    const r = await call('POST', '/runs/r2/cycles/1/result', { verdict: 'FAIL', fails: ['ACKNOWLEDGED_CLAIM_MISSING_FROM_JOURNAL'] });
    assert.equal(r.body.stopped, true);
    assert.equal((await call('POST', '/runs/r2/ack', { cycle: 1, kind: 'claim', seq: 1, actionId: 'a' })).status, 409);
    assert.equal((await call('POST', '/runs/r2/cycles/2/start', { dbHead: 0 })).status, 409);
    assert.equal((await call('GET', '/runs/r2')).body.streak.stoppedAtCycle, 1);
  });
  test('run ids cannot escape the storage directory', async () => {
    assert.equal((await call('GET', '/runs/..%2Fx')).status, 400);
    assert.equal((await call('GET', '/runs/unknown')).status, 404);
  });
});

describe('review fixes', () => {
  test('repair detection: a second recovery call sees the repair already applied (re-entrancy)', () => {
    const base = journalOf(claimsAndDispatches(1, 2), { tail: '{"type":"claim","seq":3' });
    const torn = scanJournal(base.file);
    const end = torn.fileBytes;
    assert.equal(repairAppliedAt(base.file, end, torn.tornBytes), false);
    fs.appendFileSync(base.file, repairBytes(torn.tornBytes, torn.lastHash, AT));
    assert.equal(repairAppliedAt(base.file, end, torn.tornBytes), true);
    assert.equal(repairAppliedAt(base.file, end, torn.tornBytes + 1), false, 'a different fragment length is not this repair');
  });

  describe('recorder at volume and recorder-owned labels', () => {
    const dir = path.join(tmp, 'recorder-2');
    let server, base;
    before(async () => {
      server = createRecorder(dir);
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${server.address().port}`;
      runStore(dir, 'vol').create({ run: 'vol', failureModel: 'POWER-CUT', storage: RUN.storage });
      runStore(dir, 'vm').create({ run: 'vm', failureModel: 'VM-CRASH', storage: RUN.storage });
    });
    after(() => server.close());
    const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

    test('3,000 acknowledgements over two cycles are all stored, each cycle in its own file', async () => {
      await post('/runs/vol/cycles/1/start', { dbHead: 0 });
      for (let seq = 1; seq <= 1500; seq++) assert.equal((await post('/runs/vol/ack', { cycle: 1, kind: 'claim', seq, actionId: `a-${seq}` })).status, 200);
      await post('/runs/vol/cycles/1/result', { verdict: 'PASS', needsRecovery: [] });
      await post('/runs/vol/cycles/2/start', { dbHead: 1500 });
      for (let seq = 1501; seq <= 3000; seq++) assert.equal((await post('/runs/vol/ack', { cycle: 2, kind: 'claim', seq, actionId: `a-${seq}` })).status, 200);
      const s = runStore(dir, 'vol');
      assert.equal(s.acks(1).length, 1500);
      assert.equal(s.acks(2).length, 1500);
      assert.deepEqual(s.acks(2).slice(0, 1).map((a) => a.seq), [1501]);
    });
    test('the recorder, not the test machine, decides the failure model and whether a PASS counts', async () => {
      await post('/runs/vm/cycles/1/start', { dbHead: 0 });
      await post('/runs/vm/cycles/1/result', { verdict: 'PASS', failureModel: 'POWER-CUT', countsTowardPhysicalPowerLoss: true, needsRecovery: [] });
      const r = runStore(dir, 'vm').result(1);
      assert.equal(r.failureModel, 'VM-CRASH');
      assert.equal(r.reportedFailureModel, 'POWER-CUT');
      assert.equal(r.countsTowardPhysicalPowerLoss, false);
    });
  });
});
