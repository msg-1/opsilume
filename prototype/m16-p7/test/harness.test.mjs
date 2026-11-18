// Deterministic tests of the P7 harness logic: journal scan, torn-tail repair, comparison, classification, streak,
// ledger and recorder. They need only Node (no Docker, no PostgreSQL, no Prisma). These are HARNESS tests: they
// say nothing about durability. Run: node --test prototype/m16-p7/test/
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GENESIS, serialize } from '../../m16-phase05/lib/journal.mjs';
import { addFp, fp, hex, repairAppliedAt, repairBytes, scanJournal, repairProblem } from '../lib/scan.mjs';
import { classifyCycle, compareCycle, finalStatus } from '../lib/verdict.mjs';
import { appendDurable, readLedger, writeOnce } from '../lib/ledger.mjs';

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
const RUN = { failureModel: 'POWER-CUT', storage: { driveModel: 'Example SSD 1TB', firmware: '1B2QEXM7', controller: 'NVMe (PCIe)', dbDevice: 'nvme0n1p2', journalDevice: 'nvme0n1p2', filesystem: 'ext4 rw,relatime', vendorDoc: 'vendor datasheet rev 3, section 4.2', evidenceFiles: 'host/baseline/*', writeCache: 'write back', fua: 'yes', flushSupported: 'yes', flushesObserved: 'yes', vendorFlushSemantics: 'yes', plp: 'unknown' } };
const CYCLE = { settings: { fsync: 'on', full_page_writes: 'on', synchronous_commit: 'on', wal_sync_method: 'fdatasync' }, cutSentAt: AT, cutConfirmed: 'yes', workerStopsBeforeCut: [], silentWorkerStops: [], rebootObservedAfterCut: true, authenticatedRejections: 0 };

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
  test('everything verified: PASS, provisional (the recorder decides whether it counts, after recovery)', () => {
    const r = classifyCycle({ comparison: ok(), run: RUN, cycle: CYCLE });
    assert.equal(r.verdict, 'PASS');
    assert.equal(r.quarantineRequired, false);
    assert.equal(r.countsTowardPhysicalPowerLoss, false);
  });
  for (const [name, run, cycle, code] of [
    ['write cache unknown', { ...RUN, storage: { ...RUN.storage, writeCache: 'unknown' } }, CYCLE, 'STORAGE_FLUSH_OR_FUA_BEHAVIOUR_UNVERIFIED'],
    ['vendor flush semantics unknown', { ...RUN, storage: { ...RUN.storage, vendorFlushSemantics: 'unknown' } }, CYCLE, 'STORAGE_FLUSH_OR_FUA_BEHAVIOUR_UNVERIFIED'],
    ['FUA behaviour unknown', { ...RUN, storage: { ...RUN.storage, fua: 'unknown' } }, CYCLE, 'STORAGE_FLUSH_OR_FUA_BEHAVIOUR_UNVERIFIED'],
    ['FUA not advertised and flushes not observed', { ...RUN, storage: { ...RUN.storage, fua: 'not-advertised', flushesObserved: 'no' } }, CYCLE, 'STORAGE_FLUSH_OR_FUA_BEHAVIOUR_UNVERIFIED'],
    ['no vendor documentation named', { ...RUN, storage: { ...RUN.storage, vendorDoc: '' } }, CYCLE, 'STORAGE_FLUSH_OR_FUA_BEHAVIOUR_UNVERIFIED'],
    ['synchronous_commit off', RUN, { ...CYCLE, settings: { ...CYCLE.settings, synchronous_commit: 'off' } }, 'POSTGRESQL_DURABILITY_SETTINGS_NOT_ON'],
    ['no cut recorded', RUN, { ...CYCLE, cutSentAt: null }, 'NO_CUT_RECORDED'],
    ['power loss not confirmed', RUN, { ...CYCLE, cutConfirmed: 'no' }, 'POWER_LOSS_NOT_CONFIRMED'],
    ['no reboot observed after the cut', RUN, { ...CYCLE, rebootObservedAfterCut: false }, 'REBOOT_AFTER_CUT_NOT_OBSERVED'],
    ['a worker reported stopping before the cut', RUN, { ...CYCLE, workerStopsBeforeCut: [{ kind: 'worker_stopped' }] }, 'WORKLOAD_STOPPED_BEFORE_CUT'],
    ['a worker went silent before the cut', RUN, { ...CYCLE, silentWorkerStops: [{ proc: 'b', worker: 1 }] }, 'WORKLOAD_STOPPED_BEFORE_CUT'],
    ['the recorder rejected an authenticated message', RUN, { ...CYCLE, authenticatedRejections: 1 }, 'RECORDER_REJECTED_AUTHENTICATED_MESSAGES'],
    ['a harness smoke run', { ...RUN, failureModel: 'HARNESS-SMOKE' }, CYCLE, 'NOT_A_DURABILITY_RUN'],
  ]) {
    test(`${name}: INCONCLUSIVE`, () => {
      const r = classifyCycle({ comparison: ok(), run, cycle });
      assert.equal(r.verdict, 'INCONCLUSIVE');
      assert.ok(r.inconclusive.includes(code), r.inconclusive.join());
    });
  }
  test('FUA not advertised is acceptable only with flushes observed on the actual path', () => {
    const r = classifyCycle({ comparison: ok(), run: { ...RUN, storage: { ...RUN.storage, fua: 'not-advertised', flushesObserved: 'yes' } }, cycle: CYCLE });
    assert.equal(r.verdict, 'PASS');
  });
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
  test('decision 2: a journal one claim ahead is a provisional PASS that requires quarantine and clearance', () => {
    const s = scenario({ journalEntries: [...claimsAndDispatches(1, 5), { type: 'claim', seq: 6, actionId: 'a-6' }], dbClaims: [1, 2, 3, 4, 5].map((i) => [i, `a-${i}`]) });
    const r = classifyCycle({ comparison: compareCycle(s), run: RUN, cycle: CYCLE });
    assert.equal(r.verdict, 'PASS');
    assert.equal(r.quarantineRequired, true);
    assert.deepEqual(r.needsRecovery, ['clear']);
  });
  test('the same action claimed under two sequence numbers fails', () => {
    const s = scenario({ journalEntries: [...claimsAndDispatches(1, 2), { type: 'claim', seq: 3, actionId: 'a-1' }, { type: 'dispatch', seq: 3 }], dbClaims: [[1, 'a-1'], [2, 'a-2'], [3, 'a-1']] });
    assert.ok(codes(compareCycle(s)).includes('DUPLICATE_ACTION_CLAIM'));
  });
  test('a VM crash can pass but is never counted here', () => {
    const r = classifyCycle({ comparison: ok(), run: { ...RUN, failureModel: 'VM-CRASH' }, cycle: CYCLE });
    assert.equal(r.verdict, 'PASS');
    assert.equal(r.countsTowardPhysicalPowerLoss, false);
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

describe('torn-tail repair re-entrancy', () => {
  test('a second recovery call sees the repair already applied', () => {
    const base = journalOf(claimsAndDispatches(1, 2), { tail: '{"type":"claim","seq":3' });
    const torn = scanJournal(base.file);
    const end = torn.fileBytes;
    assert.equal(repairAppliedAt(base.file, end, torn.tornBytes), false);
    fs.appendFileSync(base.file, repairBytes(torn.tornBytes, torn.lastHash, AT));
    assert.equal(repairAppliedAt(base.file, end, torn.tornBytes), true);
    assert.equal(repairAppliedAt(base.file, end, torn.tornBytes + 1), false, 'a different fragment length is not this repair');
  });
  test('decision 3: a complete final line with an invalid hash is never treated as a torn tail', () => {
    const j = journalOf(claimsAndDispatches(1, 2));
    const text = fs.readFileSync(j.file, 'utf8');
    fs.writeFileSync(j.file, text.replace(/"hash":"([0-9a-f])(?=[0-9a-f]{63}"\}\n$)/, (m0, c) => `"hash":"${c === 'a' ? 'b' : 'a'}`));
    const s = scanJournal(j.file);
    assert.equal(s.status, 'corrupt');
    assert.equal(s.corruptIsFinalLine, true);
    assert.equal(s.tornBytes, undefined, 'no torn bytes: nothing for the repair path to act on');
    assert.equal(repairAppliedAt(j.file, s.fileBytes, 0), false);
    const c = compareCycle({ ...scenario(), journal: { ...s, installationId: 'inst-1' } });
    assert.deepEqual(codes(c), ['JOURNAL_CORRUPT']);
    assert.deepEqual(classifyCycle({ comparison: c, run: RUN, cycle: CYCLE }).needsRecovery, []);
  });
});

// Finding F4 of the post-commit review of 462f5d4: `check` recorded a journal write failure but its verdict ignored it.
describe('classification: a known journal write failure is never a PASS', () => {
  const ok = () => compareCycle(scenario());
  const MARKER = { what: 'dispatch', code: 'EIO', at: '2026-11-18T10:00:00.000Z', marker: 'found' };
  const REPORTED = [{ kind: 'journal_write_failed', proc: 'a', worker: 1, detail: 'claim, EIO; marker NOT written (EROFS)', atMs: 5 }];
  test('the marker is present when the cycle is checked: INCONCLUSIVE, though everything else verified', () => {
    assert.equal(classifyCycle({ comparison: ok(), run: RUN, cycle: CYCLE }).verdict, 'PASS', '(the same cycle without the failure passes)');
    const r = classifyCycle({ comparison: ok(), run: RUN, cycle: { ...CYCLE, journalWriteFailure: MARKER } });
    assert.deepEqual([r.verdict, r.inconclusive], ['INCONCLUSIVE', ['JOURNAL_WRITE_FAILED']]);
  });
  test('a marker that cannot be read counts the same', () => {
    const r = classifyCycle({ comparison: ok(), run: RUN, cycle: { ...CYCLE, journalWriteFailure: { what: 'unknown', code: 'marker unreadable', at: null, marker: 'found' } } });
    assert.equal(r.verdict, 'INCONCLUSIVE');
  });
  test('the marker is gone (lost with the reboot) but the worker reported the failure to the recorder: INCONCLUSIVE, whenever it was reported', () => {
    const r = classifyCycle({ comparison: ok(), run: RUN, cycle: { ...CYCLE, journalWriteFailure: null, journalWriteFailures: REPORTED } });
    assert.deepEqual([r.verdict, r.inconclusive], ['INCONCLUSIVE', ['JOURNAL_WRITE_FAILED']]);
    assert.equal(classifyCycle({ comparison: ok(), run: RUN, cycle: { ...CYCLE, journalWriteFailures: [] } }).verdict, 'PASS');
  });
  test('it never softens a FAIL: a failed comparison stays FAIL, and names the write failure as well', () => {
    const bad = compareCycle({ ...scenario(), journal: { status: 'corrupt', problem: 'x' } });
    const r = classifyCycle({ comparison: bad, run: RUN, cycle: { ...CYCLE, journalWriteFailure: MARKER } });
    assert.deepEqual([r.verdict, r.fails], ['FAIL', ['JOURNAL_CORRUPT']]);
    assert.ok(r.inconclusive.includes('JOURNAL_WRITE_FAILED'), 'beside whatever else the failed comparison leaves inconclusive');
  });
  test('and it is one reason among the others in a smoke run, which is INCONCLUSIVE anyway', () => {
    const r = classifyCycle({ comparison: ok(), run: { ...RUN, failureModel: 'HARNESS-SMOKE' }, cycle: { ...CYCLE, journalWriteFailure: MARKER } });
    assert.ok(r.inconclusive.includes('JOURNAL_WRITE_FAILED') && r.inconclusive.includes('NOT_A_DURABILITY_RUN'));
  });
});

// Product-owner decision of 18 November 2026 on finding F3: the Phase 0.5 verifier stays unchanged, so a torn final
// line that is not valid UTF-8 cannot be repaired. Such a cycle is INCONCLUSIVE, never a provisional PASS.
describe('a torn final line that is not valid UTF-8: INCONCLUSIVE, no repair, the journal as found', () => {
  /** A consistent cycle (claims 1..5, all acknowledged) whose journal file ends in `tail`, as a power cut left it. */
  function cycleWithTail(tail) {
    const j = journalOf(claimsAndDispatches(1, 5));
    fs.appendFileSync(j.file, tail);
    const journal = { ...scanJournal(j.file), installationId: 'inst-1' };
    const comparison = compareCycle({ ...scenario(), journal });
    const tornTailRepairProblem = journal.status === 'torn_tail' ? repairProblem(j.file, journal.tornBytes) : null; // as `p7.mjs check` computes it
    return { file: j.file, journal, comparison, tornTailRepairProblem, verdict: classifyCycle({ comparison, run: RUN, cycle: { ...CYCLE, tornTailRepairProblem } }) };
  }
  const REPORTED = Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x80, 0x41]); // the exact bytes of the review report

  test('the exact bytes 7b 22 ff fe 80 41: check says INCONCLUSIVE, and the final status is INCONCLUSIVE whatever follows', () => {
    const c = cycleWithTail(REPORTED);
    assert.deepEqual([c.journal.status, c.journal.tornBytes], ['torn_tail', 6]);
    assert.deepEqual(codes(c.comparison), [], 'the comparison itself finds nothing wrong: every acknowledged claim is there');
    assert.match(c.tornTailRepairProblem, /6 bytes\) is not valid UTF-8/);
    assert.deepEqual([c.verdict.verdict, c.verdict.inconclusive], ['INCONCLUSIVE', ['TORN_TAIL_NOT_REPAIRABLE']]);
    // Before the decision this was a provisional PASS:
    assert.equal(classifyCycle({ comparison: c.comparison, run: RUN, cycle: CYCLE }).verdict, 'PASS', '(what the classifier says when it is not told)');
    // The final status never becomes PASS, with or without a recovery record.
    const result = { verdict: c.verdict.verdict, quarantineRequired: c.verdict.quarantineRequired };
    assert.equal(finalStatus(result, null), 'INCONCLUSIVE');
    assert.equal(finalStatus(result, { quarantineObserved: true, cleared: true }), 'INCONCLUSIVE');
  });

  test('nothing is written for it: the journal is byte for byte as found, its invalid bytes included, and still a torn tail', () => {
    const j = journalOf(claimsAndDispatches(1, 5));
    fs.appendFileSync(j.file, REPORTED);
    const asFound = fs.readFileSync(j.file);
    const scan = scanJournal(j.file);
    // What `p7.mjs recover` does at its repair step: ask first, and write only if there is no problem.
    const problem = repairProblem(j.file, scan.tornBytes);
    if (!problem) fs.appendFileSync(j.file, repairBytes(scan.tornBytes, scan.lastHash, AT));
    assert.ok(problem, 'recovery stops here');
    assert.ok(fs.readFileSync(j.file).equals(asFound));
    assert.ok(fs.readFileSync(j.file).subarray(-6).equals(REPORTED), 'not replaced, not normalised');
    assert.equal(scanJournal(j.file).status, 'torn_tail', 'not corrupt');
    assert.equal(repairAppliedAt(j.file, scan.fileBytes, scan.tornBytes), false, 'and no repair record follows it');
  });

  test('it never softens a FAIL', () => {
    const j = journalOf(claimsAndDispatches(1, 5));
    fs.appendFileSync(j.file, REPORTED);
    const journal = { ...scanJournal(j.file), installationId: 'inst-2' }; // another installation: a real failure
    const comparison = compareCycle({ ...scenario(), journal });
    const r = classifyCycle({ comparison, run: RUN, cycle: { ...CYCLE, tornTailRepairProblem: repairProblem(j.file, journal.tornBytes) } });
    assert.equal(r.verdict, 'FAIL');
    assert.ok(r.inconclusive.includes('TORN_TAIL_NOT_REPAIRABLE'));
  });

  for (const [name, tail] of [['an ASCII fragment', Buffer.from('{"type":"claim","seq":6')], ['zero bytes (a block never written)', Buffer.alloc(16)], ['valid multi-byte text', Buffer.from('{"x":"é')]]) {
    test(`unchanged for a torn tail that IS valid UTF-8 (${name}): provisional PASS, repaired by recovery, PASS once recovered`, () => {
      const c = cycleWithTail(tail);
      assert.deepEqual([c.journal.status, c.tornTailRepairProblem], ['torn_tail', null]);
      assert.deepEqual([c.verdict.verdict, c.verdict.inconclusive, c.verdict.needsRecovery], ['PASS', [], ['repair-torn-tail']]);
      assert.equal(finalStatus({ verdict: 'PASS', quarantineRequired: false }, null), 'PENDING_RECOVERY');
      fs.appendFileSync(c.file, repairBytes(c.journal.tornBytes, c.journal.lastHash, AT));
      assert.deepEqual([scanJournal(c.file).status, scanJournal(c.file).head], ['ok', 5], 'the repair verifies');
      assert.equal(finalStatus({ verdict: 'PASS', quarantineRequired: false }, { cleared: false }), 'PASS');
    });
  }
});
