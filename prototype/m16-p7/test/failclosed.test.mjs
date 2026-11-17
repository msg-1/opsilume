// A failed journal write fails closed (product-owner decision of 18 November 2026). The reused Phase 0.5 journal throws
// on a failed fsync but does not remember it (journal-failures.test.mjs, "characterisation"); the harness wraps it in
// lib/failclosed.mjs, which does. HARNESS tests with a file system that fails on demand: they show what the code does
// when a sync fails, not what a real disk does.
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { trustProblem } from '../../m16-phase05/lib/journal.mjs';
import { FailClosedJournal, WRITE_FAILED_FILE } from '../lib/failclosed.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-failclosed-'));
function withFs(name, impl, fn) {
  const original = fs[name];
  fs[name] = (...args) => impl(original, ...args);
  try { return fn(); } finally { fs[name] = original; }
}
const EIO = () => Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
/** Runs `fn` with the first `times` fsync calls failing (the journal's own; the marker's, if it comes later, works). */
const failingFsync = (fn, times = Infinity) => { let n = 0; return withFs('fsyncSync', (real, fd) => { if (n++ < times) throw EIO(); return real(fd); }, fn); };
const claimEntry = (seq) => ({ type: 'claim', seq, actionId: `a${seq}`, org: 'org-p7', attempt: 1, at: '2026-11-18T00:00:00.000Z' });
const REFUSED = (e) => e.code === 'JOURNAL_WRITE_FAILED_EARLIER';
const LIB = new URL('../lib/failclosed.mjs', import.meta.url).href;
/** A RESTARTED process: a new Node process with nothing in memory, appending one record to the journal in `d`. */
function restartedProcessAppends(d, entry) {
  const code = `import { FailClosedJournal } from ${JSON.stringify(LIB)}; const j = new FailClosedJournal(${JSON.stringify(d)});
    try { j.append(${JSON.stringify(entry)}); console.log(JSON.stringify({ appended: true, status: j.state().status })); }
    catch (e) { console.log(JSON.stringify({ appended: false, code: e.code, status: j.state().status, failure: j.writeFailure() })); }`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', cwd: path.dirname(fileURLToPath(import.meta.url)) });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
let j, dir, hashes;
const row = (seq) => ({ installation_id: 'inst-1', journal_seq: seq, head_hash: seq ? hashes[seq - 1] : '0'.repeat(64) });
const marker = () => path.join(dir, WRITE_FAILED_FILE);
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(tmp, 'j-'));
  j = new FailClosedJournal(dir);
  j.create('inst-1');
  hashes = [1, 2, 3].map((n) => j.append(claimEntry(n)));
});

describe('a failed journal sync fails closed, for every later writer', () => {
  test('without a failure it is the journal it wraps: appends, trust and no marker', () => {
    assert.equal(trustProblem(row(3), j.state()), null);
    assert.equal(j.writeFailure(), null);
    assert.equal(fs.existsSync(marker()), false);
    assert.deepEqual([j.state({ forceFull: true }).status, j.state().head], ['ok', 3]);
  });

  test('after a failed fsync, ANOTHER journal object on the same directory refuses to append and is not trusted', () => {
    assert.throws(() => failingFsync(() => j.append(claimEntry(4)), 1), /EIO/);
    const bytes = fs.readFileSync(j.file);
    const other = new FailClosedJournal(dir); // another worker of the same process (a restarted process: see below)
    for (const entry of [{ type: 'void', seq: 4, at: 'x' }, { type: 'dispatch', seq: 3, at: 'x' }, { type: 'cleared', digest: 'd', reason: 'r', at: 'x' }, claimEntry(5)]) {
      assert.throws(() => other.append(entry), REFUSED, `${entry.type} is refused`);
      assert.throws(() => j.append(entry), REFUSED, `${entry.type} is refused by the journal object that saw the failure, too`);
    }
    assert.ok(fs.readFileSync(j.file).equals(bytes), 'nothing was written on top of the unconfirmed record');
    // Not trusted whatever the database says: neither as "one claim ahead" (row 3) nor as if the claim had committed (row 4).
    const h4 = JSON.parse(bytes.toString().trim().split('\n').at(-1)).hash;
    for (const r of [row(3), { ...row(3), journal_seq: 4, head_hash: h4 }]) {
      for (const st of [other.state(), other.state({ forceFull: true }), j.state()]) {
        assert.equal(st.status, 'corrupt');
        assert.match(trustProblem(r, st), /a journal write failed earlier \(claim, EIO\)/);
      }
    }
  });

  test('the memory is a marker beside the journal: what failed and when, private, written once, and the journal itself is untouched', () => {
    assert.throws(() => failingFsync(() => j.append({ type: 'dispatch', seq: 3, at: 'x' }), 1), /EIO/);
    const m = JSON.parse(fs.readFileSync(marker(), 'utf8'));
    assert.deepEqual([Object.keys(m).sort(), m.what, m.code], [['at', 'code', 'what'], 'dispatch', 'EIO']);
    assert.equal(fs.statSync(marker()).mode & 0o777, 0o600);
    assert.deepEqual(j.writeFailure(), { ...m, marker: 'written' }, 'the failure says whether its marker was written');
    const first = fs.readFileSync(marker());
    assert.throws(() => j.append(claimEntry(4)), REFUSED);
    assert.ok(fs.readFileSync(marker()).equals(first), 'a refused append does not rewrite the marker');
  });

  test('when the marker\'s own sync fails as well, the marker is still there for every other process of this boot', () => {
    assert.throws(() => failingFsync(() => j.append(claimEntry(4))), /EIO/); // every fsync fails, the marker's too
    assert.equal(fs.existsSync(marker()), true);
    assert.throws(() => new FailClosedJournal(dir).append({ type: 'void', seq: 4, at: 'x' }), REFUSED);
  });

  const withoutMarker = (fn) => withFs('openSync', (real, file, ...rest) => { if (String(file).endsWith(WRITE_FAILED_FILE)) throw Object.assign(new Error('EROFS'), { code: 'EROFS' }); return real(file, ...rest); }, fn);
  test('when the marker cannot be written at all, THIS PROCESS still refuses, in every journal object it has', () => {
    assert.throws(() => withoutMarker(() => failingFsync(() => j.append(claimEntry(4)), 1)), /EIO/);
    assert.equal(fs.existsSync(marker()), false);
    assert.throws(() => j.append({ type: 'void', seq: 4, at: 'x' }), REFUSED);
    assert.equal(j.state().status, 'corrupt');
    // p7.mjs builds one journal object per worker: another worker of the same process must stop too.
    const otherWorker = new FailClosedJournal(dir);
    assert.throws(() => otherWorker.append({ type: 'dispatch', seq: 3, at: 'x' }), REFUSED);
    assert.equal(otherWorker.state().status, 'corrupt');
    assert.match(j.writeFailure().marker, /^NOT written \(EROFS\)/, 'and the failure says its marker is missing, so check can show it');
  });

  test('THE STATED LIMIT: when the marker could not be written, a restarted process does not know, and appends', () => {
    assert.throws(() => withoutMarker(() => failingFsync(() => j.append(claimEntry(4)), 1)), /EIO/);
    // This is what the code does, and why the documents make no unconditional claim across processes.
    assert.deepEqual(restartedProcessAppends(dir, { type: 'void', seq: 4, at: 'x' }), { appended: true, status: 'ok' });
  });

  test('restart detection: with the marker on the volume, a restarted process refuses and reports why', () => {
    assert.throws(() => failingFsync(() => j.append(claimEntry(4)), 1), /EIO/);
    const bytes = fs.readFileSync(j.file);
    const r = restartedProcessAppends(dir, { type: 'void', seq: 4, at: 'x' });
    assert.deepEqual([r.appended, r.code, r.status, r.failure.what, r.failure.code, r.failure.marker], [false, 'JOURNAL_WRITE_FAILED_EARLIER', 'corrupt', 'claim', 'EIO', 'found']);
    assert.ok(fs.readFileSync(j.file).equals(bytes));
  });

  test('a marker whose own sync failed is reported as unconfirmed: it serves this boot and may be gone after the next', () => {
    assert.throws(() => failingFsync(() => j.append(claimEntry(4))), /EIO/);
    assert.match(j.writeFailure().marker, /^written, but not confirmed on disk/);
    assert.equal(restartedProcessAppends(dir, claimEntry(5)).appended, false, 'while the file is there, a restarted process refuses');
  });

  test('a marker that is torn, empty, not an object, or cannot be read counts as a failure: never as "no failure"', () => {
    for (const content of ['{"what":"cl', '', 'null', '7', '[]']) {
      const d = fs.mkdtempSync(path.join(tmp, 'm-'));
      const fresh = new FailClosedJournal(d);
      fresh.create('inst-1');
      fresh.append(claimEntry(1));
      fs.writeFileSync(path.join(d, WRITE_FAILED_FILE), content);
      assert.equal(restartedProcessAppends(d, claimEntry(2)).appended, false, `marker content ${JSON.stringify(content)}`);
    }
    // A read error that is not "no such file" (here: the marker is a directory) is a failure too.
    const d = fs.mkdtempSync(path.join(tmp, 'm-'));
    const fresh = new FailClosedJournal(d);
    fresh.create('inst-1');
    fs.mkdirSync(path.join(d, WRITE_FAILED_FILE));
    assert.throws(() => fresh.append(claimEntry(1)), REFUSED);
    assert.match(trustProblem({ installation_id: 'inst-1', journal_seq: 0, head_hash: '0'.repeat(64) }, fresh.state()), /a journal write failed earlier \(unknown, marker unreadable\)/);
  });

  test('nothing in the wrapper removes or rewrites the marker: refused appends, state checks and new objects leave it byte for byte', () => {
    assert.throws(() => failingFsync(() => j.append(claimEntry(4)), 1), /EIO/);
    const first = fs.readFileSync(marker()), ino = fs.statSync(marker()).ino;
    for (let i = 0; i < 3; i++) { assert.throws(() => new FailClosedJournal(dir).append(claimEntry(5)), REFUSED); j.state({ forceFull: true }); assert.throws(() => j.appendBytes('x\n', 'repair'), REFUSED); }
    restartedProcessAppends(dir, claimEntry(5));
    assert.ok(fs.readFileSync(marker()).equals(first));
    assert.equal(fs.statSync(marker()).ino, ino, 'the same file, not a rewritten one');
  });

  test('a short write is a journal write failure like any other: remembered, and refused by every later writer', () => {
    // Zero bytes written: the journal file is exactly as it was, so only the wrapper can remember that a write failed.
    const before = fs.readFileSync(j.file);
    assert.throws(() => withFs('writeSync', () => 0, () => j.append(claimEntry(4))), (e) => e.code === 'JOURNAL_SHORT_WRITE');
    assert.ok(fs.readFileSync(j.file).equals(before));
    // (The failing write call of this test hits the marker's own write as well, as a full disk would: the marker is
    // there but empty, which counts as a failure for everyone who finds it.)
    assert.deepEqual([j.writeFailure().what, j.writeFailure().code], ['claim', 'JOURNAL_SHORT_WRITE']);
    assert.match(j.writeFailure().marker, /^written, but not confirmed on disk/);
    assert.throws(() => new FailClosedJournal(dir).append(claimEntry(4)), REFUSED, 'another journal object');
    assert.equal(restartedProcessAppends(dir, claimEntry(4)).appended, false, 'a restarted process');
    // Some bytes written: a torn tail AND the marker. The tail is not repaired past the marker.
    const d = fs.mkdtempSync(path.join(tmp, 's-'));
    const k = new FailClosedJournal(d);
    k.create('inst-1');
    k.append(claimEntry(1));
    assert.throws(() => withFs('writeSync', (real, fd, data) => real(fd, Buffer.from(data).subarray(0, 10)), () => k.append(claimEntry(2))), (e) => e.code === 'JOURNAL_SHORT_WRITE');
    assert.equal(k.state().statusOnDisk, 'torn_tail');
    assert.throws(() => k.appendBytes('{"type":"repair-stand-in"}\n', 'repair'), REFUSED);
  });

  test('only a refusal made before any byte is written sets no marker: a torn tail found (as a power cut leaves it), a corrupt or a missing journal', () => {
    const all = fs.readFileSync(j.file);
    fs.truncateSync(j.file, all.length - 40); // what a crash mid-write leaves: nobody saw a write fail
    assert.throws(() => j.append(claimEntry(4)), (e) => e.code === 'JOURNAL_TORN');
    assert.equal(j.state().status, 'torn_tail', 'the design\'s own rule (N1) applies: repaired only by the recovery tooling');
    fs.writeFileSync(j.file, 'not a journal\n{}\n');
    assert.throws(() => j.append(claimEntry(4)), (e) => e.code === 'JOURNAL_CORRUPT');
    fs.rmSync(j.file);
    assert.throws(() => j.append(claimEntry(4)), (e) => e.code === 'JOURNAL_MISSING');
    assert.equal(fs.existsSync(marker()), false);
    assert.equal(j.writeFailure(), null);
  });

  test('a write call that throws (the bytes on disk are unknown) is remembered like a failed sync', () => {
    assert.throws(() => withFs('writeSync', () => { throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' }); }, () => j.append(claimEntry(4))), /EIO/);
    assert.throws(() => new FailClosedJournal(dir).append(claimEntry(4)), REFUSED);
  });

  test('the repair record the harness writes itself goes through the same rule', () => {
    const bytes = '{"type":"repair-stand-in"}\n';
    const before = fs.readFileSync(j.file);
    j.appendBytes(bytes, 'repair');
    assert.equal(fs.readFileSync(j.file).subarray(before.length).toString(), bytes, 'exactly the bytes, appended');
    assert.throws(() => failingFsync(() => j.appendBytes(bytes, 'repair'), 1), /EIO/);
    assert.equal(JSON.parse(fs.readFileSync(marker(), 'utf8')).what, 'repair');
    assert.throws(() => new FailClosedJournal(dir).appendBytes(bytes, 'repair'), REFUSED, 'a rerun cannot take the unconfirmed repair for applied and carry on');
    // A short repair write is a failed write too.
    const d = fs.mkdtempSync(path.join(tmp, 'r-'));
    const k = new FailClosedJournal(d);
    k.create('inst-1');
    assert.throws(() => withFs('writeSync', (real, fd, data) => real(fd, Buffer.from(data).subarray(0, 5)), () => k.appendBytes(bytes, 'repair')), (e) => e.code === 'JOURNAL_SHORT_WRITE');
    assert.deepEqual([k.writeFailure().what, k.writeFailure().code], ['repair', 'JOURNAL_SHORT_WRITE']);
    assert.throws(() => k.appendBytes(bytes, 'repair'), REFUSED);
  });
});
