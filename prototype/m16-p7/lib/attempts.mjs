// Attempts of `p7.mjs check` for one cycle (file-system logic only, so it is tested without the image).
// Each attempt has a directory of its own under the run's evidence: `cycle-0001`, then `cycle-0001-attempt-<ms>`.
// Evidence is never overwritten:
//   - a result that was saved but perhaps not delivered is sent again, exactly as saved;
//   - a result the RECORDER REFUSED is marked beside itself (`result-refused-<ms>.json`), kept as evidence, never
//     sent again, and does not block a fresh attempt in a new directory. A refused result was never accepted: the
//     recorder stored nothing for it, and the marker says so on the test machine.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeOnce } from './ledger.mjs';

const REFUSED = /^result-refused-\d+\.json$/;

/**
 * Whether an error from the recorder client is the recorder REFUSING the request: an authenticated answer that says
 * why. A timeout, a lost connection, an unauthenticated answer, "busy" or a server fault is not: the result may still
 * be deliverable, and is sent again as it is.
 */
export function isRefusal(e) {
  if (!e || e.unauthenticated === true || typeof e.data?.error !== 'string') return false;
  if (e.status === 500) return e.data.error === 'refusal_not_recorded' && typeof e.data.refused === 'string'; // refused, though the recorder could not log it as usual
  return Number.isInteger(e.status) && e.status >= 400 && e.status < 500;
}

/** The attempts that exist for `base` (e.g. "cycle-0001") under `parent`, oldest first. Never throws for one entry. */
export function attemptsOf(parent, base) {
  const names = fs.existsSync(parent) ? fs.readdirSync(parent).filter((d) => d === base || d.startsWith(`${base}-attempt-`)).sort() : [];
  return names.map((name) => {
    const dir = path.join(parent, name);
    let files = [];
    try { if (fs.statSync(dir).isDirectory()) files = fs.readdirSync(dir); } catch { /* a dangling link or an unreadable entry: an attempt with nothing in it */ }
    // A result counts only if it can be read: one that `check` died writing is a dead attempt, not something to send.
    let hasResult = false;
    if (files.includes('result.json')) { try { const r = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')); hasResult = !!r && typeof r === 'object'; } catch { hasResult = false; } }
    return { name, hasResult, refusals: files.filter((f) => REFUSED.test(f)).sort() };
  });
}

/**
 * What `check` does next: `{ resend: name }` for the oldest saved result that the recorder has not refused, or
 * `{ fresh: name, earlierAttempts, refusedEarlier }` for a new attempt directory (which the caller creates).
 */
export function planAttempt(parent, base, now = Date.now()) {
  const attempts = attemptsOf(parent, base);
  const pending = attempts.find((a) => a.hasResult && !a.refusals.length);
  if (pending) return { resend: pending.name };
  const refusedEarlier = attempts.filter((a) => a.refusals.length).map((a) => {
    const marker = a.refusals.at(-1);
    let error = null;
    try { error = JSON.parse(fs.readFileSync(path.join(parent, a.name, marker), 'utf8')).error ?? null; } catch { /* an unreadable marker is still a marker */ }
    return { attempt: a.name, marker, error };
  });
  return { fresh: attempts.length ? `${base}-attempt-${now}` : base, earlierAttempts: attempts.map((a) => a.name), refusedEarlier };
}

/** Marks the saved result in `dir` as refused by the recorder. Written once; the result itself is not touched. */
export function recordRefusal(dir, e, now = Date.now()) {
  const file = `result-refused-${now}.json`;
  writeOnce(path.join(dir, file), { refusedBy: 'recorder', status: e.status, error: e.data?.refused ?? e.data?.error ?? null, at: new Date(now).toISOString(), note: 'The recorder stored nothing for this result. It is kept as evidence and is never sent again.' });
  return file;
}

/** The identity an attempt's result carries, so one attempt is never taken for another. */
export const attemptIdentity = (plan) => ({ dir: plan.fresh, id: randomUUID(), earlierAttempts: plan.earlierAttempts, refusedEarlier: plan.refusedEarlier });

/**
 * Why a SAVED result must not be sent as it is: it is a PASS, and the recorder's cycle view now shows something that
 * makes the cycle INCONCLUSIVE (it was computed before that was known). Null for anything else: a saved FAIL or
 * INCONCLUSIVE is sent as saved.
 */
export function savedResultProblem(saved, view) {
  if (saved?.verdict !== 'PASS') return null;
  // Once the recorder holds a result for the cycle, nothing more can be stored: a resend is answered "not open", and
  // `check` recognises its own result by its attempt id. Marking it here could mark a result the recorder did store.
  if (view?.result) return null;
  // Ruling C: the PASS was computed from one state of the recorder's records; if anything was added since, it is stale.
  if (typeof saved.evidenceMark === 'string' && typeof view?.evidenceMark === 'string' && saved.evidenceMark !== view.evidenceMark) return 'the recorder\'s records of the cycle changed since this result was computed';
  if (view?.damaged) return `the recorder's records of the cycle are damaged (${Object.values(view.damage ?? {}).filter(Boolean).join('; ') || 'no detail'})`;
  if (view?.authenticatedRejections > 0) return `the cycle view shows ${view.authenticatedRejections} authenticated refusal(s) by the recorder`;
  if (view?.journalWriteFailures?.length) return 'the cycle view shows a reported journal write failure';
  // What the recorder holds about the cut and the workers may have changed since the PASS was computed (the operator
  // withdrew the confirmation; a stop was reported late). Only for a real cycle view, which always says whether a cut
  // was requested.
  if (view && 'cutRequestedAt' in view) {
    if (!view.cutRequestedAt) return 'the cycle view shows no cut';
    if (view.cutConfirmed !== 'yes') return 'the cycle view shows a cut that is not confirmed';
  }
  if (view?.workerStopsBeforeCut?.length || view?.silentWorkerStops?.length) return 'the cycle view shows a workload that stopped before the cut';
  if (view?.workerStopsAfterCut?.length) return 'the cycle view shows a worker that stopped after the cut request';
  return null;
}
/** Marks a saved result that `check` itself will not send (see savedResultProblem). Same marker family as a refusal. */
export function recordSuperseded(dir, why, now = Date.now()) {
  const file = `result-refused-${now}.json`;
  writeOnce(path.join(dir, file), { refusedBy: 'check', status: null, error: String(why), at: new Date(now).toISOString(), note: 'This saved result was not sent: it was computed before the recorder showed what is named above. It is kept as evidence and is never sent.' });
  return file;
}
/** Whether the result the recorder holds is this saved result (by the attempt's own id; never by content). */
export const sameAttempt = (stored, saved) => typeof stored?.attempt?.id === 'string' && stored.attempt.id === saved?.attempt?.id;
