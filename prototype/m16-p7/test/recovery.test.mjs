// What `p7.mjs recover` decides before it touches anything, and the evidence it keeps of a clearance (post-commit
// review F5 and F6; second safety review C1). `p7.mjs` only loads inside the image, so these rules live in
// lib/recovery.mjs, where they are tested. HARNESS tests only.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recoverRefusal, saveClearance, savedClearance } from '../lib/recovery.mjs';

const RESULT = { verdict: 'INCONCLUSIVE', cycleId: 'c'.repeat(32), quarantineRequired: false, needsRecovery: [] };
const view = (over = {}) => ({ result: RESULT, recovered: null, events: [], ...over });
const ask = (o = {}) => recoverRefusal({ stopped: null, cycle: 3, view: view(), writeFailure: null, ...o });

describe('recover: refused before anything is probed, repaired, cleared or retired', () => {
  test('nothing in the way: null', () => assert.equal(ask(), null));
  test('a stopped run, except the run an INCONCLUSIVE result of THIS cycle stopped', () => {
    assert.deepEqual(ask({ stopped: { kind: 'fail', cycle: 3 } }), { how: 'refuse', why: 'run is stopped' });
    assert.deepEqual(ask({ stopped: { kind: 'inconclusive', cycle: 2 } }), { how: 'refuse', why: 'run is stopped' });
    assert.equal(ask({ stopped: { kind: 'inconclusive', cycle: 3 } }), null);
  });
  test('no result, a FAIL, or already recovered', () => {
    assert.equal(ask({ view: view({ result: null }) }).how, 'refuse');
    assert.equal(ask({ view: view({ result: { ...RESULT, verdict: 'FAIL' } }) }).how, 'refuse');
    assert.deepEqual(ask({ view: view({ recovered: { cleared: false } }) }), { how: 'refuse', why: 'already recovered' });
  });
  test('F5: a recovery of this cycle that failed earlier is not tried again, even though the run is "only" stopped as inconclusive', () => {
    const r = ask({ stopped: { kind: 'inconclusive', cycle: 3 }, view: view({ events: [{ kind: 'recovery_failed', detail: 'recovery: state changed since the check' }] }) });
    assert.equal(r.how, 'refuse');
    assert.match(r.why, /recovery of this cycle failed earlier \(recovery: state changed since the check\)/);
  });
  test('C1: a journal write failure that is known from ANY of four places stops the run', () => {
    const marker = { what: 'claim', code: 'EIO', marker: 'found' };
    for (const [name, o] of [
      ['the marker, now', { writeFailure: marker }],
      ['a worker\'s report held by the recorder', { view: view({ events: [{ kind: 'journal_write_failed', detail: 'claim, EIO; marker NOT written' }] }) }],
      ['the marker as the check recorded it (it may be gone now)', { view: view({ result: { ...RESULT, journalWriteFailure: marker } }) }],
      ['a report as the check recorded it', { view: view({ result: { ...RESULT, journalWriteFailuresReported: [{ kind: 'journal_write_failed', detail: 'x' }] } }) }],
    ]) {
      const r = ask(o);
      assert.equal(r?.how, 'stop-the-run', name);
      assert.match(r.why, /journal write/, name);
    }
    assert.equal(ask({ view: view({ result: { ...RESULT, journalWriteFailure: null, journalWriteFailuresReported: [] } }) }), null);
  });
  test('a torn tail the check found it cannot repair: not possible, nothing written, the run not stopped again', () => {
    assert.deepEqual(ask({ view: view({ result: { ...RESULT, tornTailRepairProblem: 'the torn final line (6 bytes) is not valid UTF-8' } }) }), { how: 'not-possible', why: 'the torn final line (6 bytes) is not valid UTF-8' });
  });
  test('the order: a journal write failure outranks a torn tail, and a stopped run outranks both', () => {
    const both = view({ result: { ...RESULT, journalWriteFailure: { what: 'x', code: 'EIO' }, tornTailRepairProblem: 'y' } });
    assert.equal(ask({ view: both }).how, 'stop-the-run');
    assert.equal(ask({ view: both, stopped: { kind: 'fail', cycle: 3 } }).how, 'refuse');
  });
});

describe('F6: the evidence of a clearance is written when it happens, and read back by a re-run', () => {
  test('saved once per clearance; the latest is found again; nothing is overwritten', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-clearance-'));
    assert.equal(savedClearance(dir), null);
    const file = saveClearance(dir, { digest: 'd'.repeat(64), cleared: true, toUnknown: 1, clearedRecord: 'abc' }, 100);
    assert.equal(file, 'clearance-100.json');
    assert.deepEqual(savedClearance(dir), { digest: 'd'.repeat(64), cleared: true, toUnknown: 1, clearedRecord: 'abc', file: 'clearance-100.json' });
    assert.throws(() => saveClearance(dir, { digest: 'x' }, 100), /EEXIST/);
    fs.writeFileSync(path.join(dir, 'clearance-200.json'), '{torn');
    assert.deepEqual(savedClearance(dir), { unreadable: true, file: 'clearance-200.json' }, 'an unreadable record is said to be unreadable, not skipped for an older one');
    assert.equal(savedClearance(path.join(dir, 'nowhere')), null);
  });
});
