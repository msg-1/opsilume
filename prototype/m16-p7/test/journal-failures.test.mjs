// Failure boundaries of the journal the harness reuses unchanged (../m16-phase05/lib/journal.mjs), exercised with a
// file system that fails on demand. HARNESS tests only: they show what the code does when a write or a sync fails or
// the file is cut or replaced, not what a real disk does when the power goes.
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Journal, trustProblem } from '../../m16-phase05/lib/journal.mjs';
import { appendDurable, readLedger } from '../lib/ledger.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-journal-fail-'));
/** Replaces one fs function for the duration of `fn` (the journal and the ledger call fs through the same object). */
function withFs(name, impl, fn) {
  const original = fs[name];
  fs[name] = (...args) => impl(original, ...args);
  try { return fn(); } finally { fs[name] = original; }
}
const claimEntry = (seq) => ({ type: 'claim', seq, actionId: `a${seq}`, org: 'org-p7', attempt: 1, at: '2026-11-18T00:00:00.000Z' });
let j, dir, hashes;
const row = (seq) => ({ installation_id: 'inst-1', journal_seq: seq, head_hash: seq ? hashes[seq - 1] : '0'.repeat(64) });
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(tmp, 'j-'));
  j = new Journal(dir);
  j.create('inst-1');
  hashes = [1, 2, 3].map((n) => j.append(claimEntry(n)));
  assert.equal(trustProblem(row(3), j.state()), null);
});

describe('journal append: a short write or a failed sync is an error, and the journal then refuses to be trusted', () => {
  test('a short write throws, leaves a torn tail that is reported as such, and no later append hides it', () => {
    let wrote = 0;
    assert.throws(() => withFs('writeSync', (real, fd, data) => { wrote = Math.floor(Buffer.byteLength(data) / 2); return real(fd, Buffer.from(data).subarray(0, wrote)); }, () => j.append(claimEntry(4))), (e) => e.code === 'JOURNAL_SHORT_WRITE');
    const st = j.state();
    assert.deepEqual([st.status, st.head, st.tornBytes], ['torn_tail', 3, wrote], 'the three complete records are still verified; the fragment is counted');
    assert.throws(() => j.append(claimEntry(4)), (e) => e.code === 'JOURNAL_TORN', 'nothing is appended after a fragment');
    assert.throws(() => j.append({ type: 'void', seq: 4, at: 'x' }), (e) => e.code === 'JOURNAL_TORN');
    assert.equal(j.state({ forceFull: true }).head, 3);
  });

  test('a write that reports zero bytes is a short write too, and leaves the journal as it was', () => {
    const before = fs.readFileSync(j.file);
    assert.throws(() => withFs('writeSync', () => 0, () => j.append(claimEntry(4))), (e) => e.code === 'JOURNAL_SHORT_WRITE');
    assert.ok(fs.readFileSync(j.file).equals(before));
    assert.equal(trustProblem(row(3), j.state()), null);
  });

  test('a failed fsync throws; the record is in the file but was never confirmed, so the journal is ahead of the database and claims stop', () => {
    assert.throws(() => withFs('fsyncSync', () => { throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }); }, () => j.append(claimEntry(4))), /EIO/);
    const st = j.state();
    assert.deepEqual([st.status, st.head], ['ok', 4], 'the line is complete in the file');
    // The claim's transaction never committed (append threw inside it), so the database is still at 3.
    assert.equal(trustProblem(row(3), st), 'database head 3 is behind the journal head 4', 'quarantine: no further claim is made');
  });

  test('characterisation: the journal does not remember that an fsync failed; a later append is accepted on top of the unconfirmed record', () => {
    assert.throws(() => withFs('fsyncSync', () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); }, () => j.append(claimEntry(4))));
    // This is what the code does today. Whether the unconfirmed record reached the disk is unknown, and on Linux a
    // later successful fsync does not prove it did. The Phase 0.5 journal is left as it is; the harness wraps it in
    // lib/failclosed.mjs, which remembers the failure and refuses (failclosed.test.mjs).
    assert.doesNotThrow(() => j.append({ type: 'void', seq: 4, at: '2026-11-18T00:00:01.000Z' }));
    assert.equal(j.state({ forceFull: true }).status, 'ok');
  });
});

describe('journal truncation and replacement: every case is seen, none is trusted', () => {
  const lines = () => fs.readFileSync(j.file, 'utf8').split('\n').filter(Boolean);
  test('cut at a record boundary: the database is ahead of the journal', () => {
    fs.writeFileSync(j.file, `${lines().slice(0, 2).join('\n')}\n`);
    assert.equal(trustProblem(row(3), j.state()), 'database head 3 is ahead of the journal head 2');
  });
  test('cut in the middle of a record: a torn tail and a lower head, never a silent pass', () => {
    const all = fs.readFileSync(j.file);
    fs.truncateSync(j.file, all.length - 40);
    const st = j.state();
    assert.deepEqual([st.status, st.head], ['torn_tail', 2]);
    assert.equal(trustProblem(row(3), st), 'database head 3 is ahead of the journal head 2');
  });
  test('emptied, or removed: the database is ahead, or the journal is missing', () => {
    fs.writeFileSync(j.file, '');
    assert.equal(trustProblem(row(3), j.state()), 'database head 3 is ahead of the journal head 0');
    fs.rmSync(j.file);
    assert.equal(trustProblem(row(3), j.state()), 'journal missing');
  });
  test('replaced by another valid journal of the same length: the head hash anchored in the database does not match', () => {
    const other = new Journal(fs.mkdtempSync(path.join(tmp, 'other-')));
    other.create('inst-1');
    for (const n of [1, 2, 3]) other.append({ ...claimEntry(n), actionId: `other-${n}` });
    assert.equal(j.state().head, 3); // the verifier has the original cached
    fs.renameSync(other.file, j.file);
    const st = j.state();
    assert.deepEqual([st.status, st.head, st.mode], ['ok', 3, 'full'], 'a replaced file is verified in full, and is a valid chain');
    assert.equal(trustProblem(row(3), st), 'head hash differs between database and journal');
  });
  test('an earlier record edited in place: found by a full verification; the per-claim incremental check does not re-read it', () => {
    const l = lines();
    l[0] = l[0].replace('"actionId":"a1"', '"actionId":"aX"'); // same length, same file, last record untouched
    fs.writeFileSync(j.file, `${l.join('\n')}\n`);
    // Characterisation of the reused library: between full verifications it checks only what was appended since, and
    // that the last verified record is unchanged. That is why the harness forces a full verification at every cycle
    // start, at adopt, at preflight and in check (and check scans the file independently as well).
    assert.equal(j.state().status, 'ok', 'incremental: the edit to an earlier record is not seen');
    const full = j.state({ forceFull: true });
    assert.equal(full.status, 'corrupt');
    assert.match(trustProblem(row(3), full), /^journal corrupt/);
  });
  test('the identity file replaced or removed: another installation, or none', () => {
    fs.writeFileSync(j.idFile, `${JSON.stringify({ installationId: 'inst-2' })}\n`);
    assert.equal(trustProblem(row(3), j.state()), 'installation identity differs');
    fs.rmSync(j.idFile);
    assert.equal(trustProblem(row(3), j.state()), 'installation identity file missing');
  });
  test('a journal one claim ahead of the database is seen from the database side as well', () => {
    assert.equal(trustProblem(row(2), j.state()), 'database head 2 is behind the journal head 3');
  });
});

describe('recorder ledger: one line, one write, checked, synced', () => {
  const f = () => path.join(dir, 'ledger.jsonl');
  test('a short write throws and leaves a fragment that readers report as torn, never as a record', () => {
    appendDurable(f(), { n: 1 });
    assert.throws(() => withFs('writeSync', (real, fd, data) => real(fd, String(data).slice(0, 4)), () => appendDurable(f(), { n: 2 })), /short write: 4 of/);
    assert.deepEqual(readLedger(f()), { entries: [{ n: 1 }], tornBytes: 4 });
  });
  test('a failed fsync throws: the caller never learns of a success it cannot rely on', () => {
    assert.throws(() => withFs('fsyncSync', () => { throw new Error('EIO'); }, () => appendDurable(f(), { n: 1 })), /EIO/);
    assert.deepEqual(readLedger(f()).entries, [{ n: 1 }], 'the line is in the file all the same: see the recorder test for what follows from that');
  });
});
