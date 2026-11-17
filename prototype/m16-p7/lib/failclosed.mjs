// A journal whose write may not have reached the disk is not written to again (product-owner decision, 18 November
// 2026: a failed journal fsync must fail closed). The Phase 0.5 journal (../../m16-phase05/lib/journal.mjs, reused
// unchanged) throws when a write or its fsync fails, but does not remember it: the next append, from this or any other
// process, lands on top of a record nobody confirmed, and on Linux a later successful fsync does not prove the earlier
// data reached the disk. This wrapper remembers the failure in two places:
//   - in this process, for every journal object on the same directory (p7.mjs builds one per worker). Always.
//   - in a marker file beside the journal, which is how ANOTHER or a RESTARTED process learns of it. Best effort only:
//     the marker goes to the very volume whose write just failed, so it may not be writable either. Without it a
//     restarted process does not know and will append. And a marker whose own sync failed can be gone after a reboot.
//     There is no unconditional guarantee across processes; writeFailure().marker says which case this is.
// While the failure is remembered, append() refuses and state() reports the journal as not trusted, so claim(),
// appendLocked() and clear() of the Phase 0.5 library, which only use those two, stop as well: after ANY failed
// journal write, a dispatch record included.
// Nothing here removes, rewrites or expires the marker, and nothing else in the harness does: the run cannot go on,
// and a person decides (README, "A failed journal write fails closed"). The journal file itself is never touched.
// NOT part of the Phase 0.5 design, which says a failed write throws and nothing commits; this is the harness's
// addition, accepted for the prototype by the product owner on 18 November 2026.
import fs from 'node:fs';
import path from 'node:path';
import { Journal } from '../../m16-phase05/lib/journal.mjs';
import { writeOnce } from './ledger.mjs';

export const WRITE_FAILED_FILE = 'journal-write-failed.json';
// The three refusals the journal makes BEFORE it writes a byte (the file is missing, corrupt, or ends in a torn line
// that an earlier crash left). Nothing was written, so no write failed; the design's own rules apply to them.
// Everything else that goes wrong in an append is a journal write failure and is remembered: a failed sync, a write
// call that throws, and a short write (even one that wrote nothing, which leaves no trace in the journal itself).
const REFUSED_BEFORE_ANY_WRITE = new Set(['JOURNAL_MISSING', 'JOURNAL_CORRUPT', 'JOURNAL_TORN']);
const FAILED = new Map(); // resolved journal directory -> the failure this process knows of; never cleared
const problemOf = (f) => `a journal write failed earlier (${f.what}, ${f.code}): whether it reached the disk is unknown, and nothing more is written to this journal`;

export class FailClosedJournal extends Journal {
  get #key() { return path.resolve(this.dir); }
  get #marker() { return path.join(this.dir, WRITE_FAILED_FILE); }

  /**
   * The remembered failure ({ what, code, at, marker }), or null. `marker` says where the memory is: 'written',
   * 'found' (left by another or an earlier process), 'written, but not confirmed on disk ...' or 'NOT written ...'
   * (then only this process knows). A marker that exists but can't be read or parsed is a failure too, never "none".
   */
  writeFailure() {
    const known = FAILED.get(this.#key);
    if (known) return known;
    const unreadable = { what: 'unknown', code: 'marker unreadable', at: null, marker: 'found' };
    let failure;
    try {
      const m = JSON.parse(fs.readFileSync(this.#marker, 'utf8'));
      failure = { what: String(m.what), code: String(m.code), at: m.at ?? null, marker: 'found' };
    } catch (e) {
      if (e.code === 'ENOENT') return null; // no marker: no failure that this process can know of
      failure = unreadable;
    }
    FAILED.set(this.#key, failure);
    return failure;
  }

  #remember(what, e) {
    const failure = { what: String(what), code: String(e?.code ?? 'error'), at: new Date().toISOString() };
    let marker = 'written';
    try { writeOnce(this.#marker, failure, 0o600); } catch (me) {
      const why = String(me?.code ?? 'error');
      // The marker is on the volume whose write just failed. Say exactly what became of it; never pretend.
      marker = why === 'EEXIST' ? 'found' : fs.existsSync(this.#marker) ? `written, but not confirmed on disk (${why}): it may be incomplete, or gone after a reboot` : `NOT written (${why}): only this process knows; a restarted process will not`;
    }
    FAILED.set(this.#key, { ...failure, marker });
  }

  #write(what, fn) {
    const f = this.writeFailure();
    if (f) throw Object.assign(new Error(`journal write refused: ${problemOf(f)}`), { code: 'JOURNAL_WRITE_FAILED_EARLIER' });
    try { return fn(); } catch (e) {
      if (!REFUSED_BEFORE_ANY_WRITE.has(e?.code)) this.#remember(what, e);
      throw e;
    }
  }

  /** As Journal.state(), except that a remembered failure is reported as a status trustProblem() refuses. */
  state(opts) {
    const s = super.state(opts);
    const f = this.writeFailure();
    return f ? { ...s, status: 'corrupt', problem: problemOf(f), head: null, statusOnDisk: s.status } : s;
  }

  append(entry) {
    return this.#write(entry?.type ?? 'record', () => super.append(entry));
  }

  /** Raw bytes (the torn-tail repair record, which the harness writes itself): one write, byte count checked, fsync. */
  appendBytes(bytes, what) {
    return this.#write(what, () => {
      const fd = fs.openSync(this.file, 'a');
      try {
        const n = fs.writeSync(fd, bytes);
        if (n !== Buffer.byteLength(bytes)) throw Object.assign(new Error(`short write: ${n} of ${Buffer.byteLength(bytes)} bytes`), { code: 'JOURNAL_SHORT_WRITE' });
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    });
  }
}
