// What `p7.mjs recover` decides before it probes, repairs, clears or retires anything, and the evidence it keeps of a
// clearance. Pure (plus two small file helpers), so the rules are tested without the image.
import fs from 'node:fs';
import path from 'node:path';
import { writeOnce } from './ledger.mjs';

const reportsNone = (v) => v === undefined || v === null || (Array.isArray(v) && v.length === 0);

/**
 * stopped: the run's stop marker or null. cycle: the cycle number. view: the recorder's cycle view ({ result,
 * recovered, events }). writeFailure: what the journal's failure marker says NOW (FailClosedJournal.writeFailure()).
 * Returns null (go on), or { how, why }:
 *   'refuse'        nothing to do here; the command ends with the reason and changes nothing;
 *   'stop-the-run'  a journal write failure is known: the run is stopped on the recorder, nothing is repaired or
 *                   cleared. Known from any of: the marker now, a worker's report the recorder holds, or the marker
 *                   or a report as `check` recorded them with its result (the marker may be gone by now);
 *   'not-possible'  the torn final line cannot be repaired by this harness: nothing is written, the cycle stays
 *                   INCONCLUSIVE and not recovered.
 */
export function recoverRefusal({ stopped, cycle, view, writeFailure }) {
  // A run stopped by an INCONCLUSIVE cycle may still recover that cycle, so a new run can continue its state.
  if (stopped && !(stopped.kind === 'inconclusive' && stopped.cycle === cycle)) return { how: 'refuse', why: 'run is stopped' };
  const r = view?.result;
  if (!r || r.verdict === 'FAIL') return { how: 'refuse', why: 'nothing to recover: no non-failing result for this cycle' };
  if (view.recovered) return { how: 'refuse', why: 'already recovered' };
  // The recorder could not record a recovery (nor a stop) while one of the run's ledgers is damaged: nothing is
  // repaired, cleared or retired that it could then never be told about.
  if (view.damage?.runLedgers) return { how: 'refuse', why: `the recorder cannot record a recovery now: ${view.damage.runLedgers}. Nothing was changed. Stop and report (recorder host: verify-dir)` };
  // The stop marker is write-once, so for a run already stopped as inconclusive a failed recovery leaves only an event.
  const failedEarlier = (view.events ?? []).find((e) => e.kind === 'recovery_failed');
  if (failedEarlier) return { how: 'refuse', why: `a recovery of this cycle failed earlier (${failedEarlier.detail ?? 'no detail'}). Nothing is tried again and nothing was changed; the recorder accepts no recovery for it` };
  if (writeFailure) return { how: 'stop-the-run', why: `a journal write failed earlier (${writeFailure.what}, ${writeFailure.code}); nothing is repaired or cleared after it` };
  const reported = (view.events ?? []).find((e) => e.kind === 'journal_write_failed');
  if (reported) return { how: 'stop-the-run', why: `a journal write failure was reported in this cycle (${reported.detail}); nothing is repaired or cleared after it` };
  if (r.journalWriteFailure) return { how: 'stop-the-run', why: `the check of this cycle found a journal write failure (${r.journalWriteFailure.what}, ${r.journalWriteFailure.code}); its marker is gone now, the failure is not. Nothing is repaired or cleared after it` };
  if (!reportsNone(r.journalWriteFailuresReported)) return { how: 'stop-the-run', why: 'the check of this cycle was shown a reported journal write failure; nothing is repaired or cleared after it' };
  if (r.tornTailRepairProblem) return { how: 'not-possible', why: r.tornTailRepairProblem };
  return null;
}

const CLEARANCE = /^clearance-(\d+)\.json$/;
/** Written as soon as a clearance committed, before anything else can fail: its digest and counts are not in memory only. */
export function saveClearance(dir, data, now = Date.now()) {
  const file = `clearance-${now}.json`;
  writeOnce(path.join(dir, file), data);
  return file;
}
/** The latest saved clearance of this cycle's evidence directory (with `file`), `{ unreadable, file }`, or null. */
export function savedClearance(dir) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => CLEARANCE.test(f)).sort((a, b) => Number(CLEARANCE.exec(a)[1]) - Number(CLEARANCE.exec(b)[1])) : [];
  const file = files.at(-1);
  if (!file) return null;
  try { return { ...JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')), file }; } catch { return { unreadable: true, file }; }
}

/** Whether a saved clearance is THIS cycle's clearance of THIS claim (a readable record that names both). */
export const clearanceMatches = (saved, cycle, uncommitted) => !!saved && !saved.unreadable && saved.cycle === cycle && saved.uncommitted?.seq === uncommitted?.seq && saved.uncommitted?.actionId === uncommitted?.actionId;
