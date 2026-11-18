// Finding F3 of the post-commit review of 462f5d4: a torn final journal line whose bytes are not valid UTF-8.
// The reused Phase 0.5 verifier measures a line by the length of its DECODED text; the repair record (N1) names the
// raw byte count. For a fragment that is not valid UTF-8 the two differ, and a repair written for it turns a
// repairable journal (`torn_tail`) into a `corrupt` one. The verifier is not changed here (Phase 0.5 is reused
// unchanged); the harness refuses to write a repair the verifier would not accept, and leaves the journal as it is.
// HARNESS tests only, on temporary files.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Journal } from '../../m16-phase05/lib/journal.mjs';
import { repairBytes, repairCheck, repairProblem, scanJournal } from '../lib/scan.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-repair-utf8-'));
function journalWithTail(fragment) {
  const j = new Journal(fs.mkdtempSync(path.join(tmp, 'j-')));
  j.create('inst-1');
  j.append({ type: 'claim', seq: 1, actionId: 'a1', org: 'org-p7', attempt: 1, at: '2026-11-18T00:00:00.000Z' });
  fs.appendFileSync(j.file, fragment);
  return j;
}
const REPORTED = Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x80, 0x41]); // the exact sequence of the review report
const CUT_CHARACTER = Buffer.from('{"x":"é').subarray(0, 7);         // a two-byte character with its second byte missing
const NOT_UTF8 = [['the reported bytes 7b 22 ff fe 80 41', REPORTED], ['a multi-byte character cut in half', CUT_CHARACTER], ['a lone continuation byte', Buffer.from([0x80])]];
const REPAIRABLE = [['an ASCII fragment', Buffer.from('{"type":"cla')], ['zero bytes (a block never written)', Buffer.alloc(16)], ['a complete record without its newline', Buffer.from('{"type":"claim","seq":2}')], ['valid multi-byte text', Buffer.from('{"x":"é')]];

describe('F3: the defect, as the reused verifier behaves (characterisation; Phase 0.5 is not modified)', () => {
  for (const [name, fragment] of NOT_UTF8) {
    test(`a repair written for ${name} turns torn_tail into corrupt`, () => {
      const j = journalWithTail(fragment);
      const before = j.state({ forceFull: true });
      assert.deepEqual([before.status, before.tornBytes, scanJournal(j.file).status], ['torn_tail', fragment.length, 'torn_tail'], 'found as a torn tail, counted in raw bytes');
      fs.appendFileSync(j.file, repairBytes(before.tornBytes, before.lastHash)); // what recover did before the fix
      const after = j.state({ forceFull: true });
      assert.deepEqual([after.status, after.problem], ['corrupt', 'line is not a record']);
    });
  }
});

describe('F3: the harness does not write a repair the verifier would refuse', () => {
  for (const [name, fragment] of NOT_UTF8) {
    test(`${name}: recognised before anything is written, and the journal is left byte for byte as found`, () => {
      const j = journalWithTail(fragment);
      const asFound = fs.readFileSync(j.file);
      const before = j.state({ forceFull: true });
      const problem = repairProblem(j.file, before.tornBytes);
      assert.match(problem, /not valid UTF-8/);
      assert.match(problem, new RegExp(`${fragment.length} bytes`), 'it says how long the fragment is, in raw bytes');
      assert.ok(fs.readFileSync(j.file).equals(asFound), 'the check reads; it changes nothing');
      assert.ok(fs.readFileSync(j.file).subarray(asFound.length - fragment.length).equals(fragment), 'the invalid bytes are still there, not replaced or normalised');
      assert.equal(j.state({ forceFull: true }).status, 'torn_tail', 'still a torn tail: repairable once the length rule is settled, never made corrupt');
    });
  }
  for (const [name, fragment] of REPAIRABLE) {
    test(`${name}: no problem is reported, and the repair verifies`, () => {
      const j = journalWithTail(fragment);
      const before = j.state({ forceFull: true });
      assert.equal(repairProblem(j.file, before.tornBytes), null);
      fs.appendFileSync(j.file, repairBytes(before.tornBytes, before.lastHash));
      const after = j.state({ forceFull: true });
      assert.deepEqual([after.status, after.head], ['ok', 1]);
    });
  }
  test('a fragment length that does not fit the file is a problem too, never a guess', () => {
    const j = journalWithTail(Buffer.from('{"a'));
    assert.match(repairProblem(j.file, 0), /no torn fragment/);
    assert.match(repairProblem(j.file, 10_000_000), /longer than the file/);
    assert.match(repairProblem(path.join(tmp, 'missing.log'), 3), /could not be read/);
  });
});

// Second safety review, C9 and the reviewer's note on wording.
describe('the repair check says exactly what it knows', () => {
  test('"would not verify" and "could not be determined" are different answers', () => {
    const j = journalWithTail(REPORTED);
    assert.deepEqual(Object.keys(repairCheck(j.file, 6)), ['wouldNotVerify']);
    assert.deepEqual(repairCheck(journalWithTail(Buffer.from('{"a')).file, 3), { verifiable: true });
    for (const [file, bytes, why] of [[path.join(tmp, 'missing.log'), 3, /could not be read/], [j.file, 10_000_000, /longer than the file/], [j.file, 0, /no torn fragment/]]) {
      const c = repairCheck(file, bytes);
      assert.deepEqual(Object.keys(c), ['undetermined']);
      assert.match(c.undetermined, why);
    }
    // Recovery writes no repair in either case; only `wouldNotVerify` is a fact about the journal that check records.
    assert.ok(repairProblem(j.file, 6) && repairProblem(j.file, 10_000_000));
  });
  test('the rule is the verifier\'s measure, not "valid UTF-8": a four-byte character cut short decodes to the same length and IS repairable', () => {
    for (const fragment of [Buffer.from([0xf0, 0x9f, 0x98]), Buffer.from([0x7b, 0xf4, 0x8f, 0xbf])]) {
      const j = journalWithTail(fragment);
      const before = j.state({ forceFull: true });
      assert.deepEqual(repairCheck(j.file, before.tornBytes), { verifiable: true });
      fs.appendFileSync(j.file, repairBytes(before.tornBytes, before.lastHash));
      assert.equal(j.state({ forceFull: true }).status, 'ok', 'and the repair does verify');
    }
  });
});
