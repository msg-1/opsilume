// Pacing of one worker's claims (pure; the clock and the sleep are injected, so the rules are tested without waiting).
// The rule is an instantaneous rate limit, not a budget: after a claim starts, the next may start only once the
// allowed rate, integrated over the time in between, reaches one claim. With a burst pattern the allowed rate is the
// maximum burst rate (ratePerWorker) in the burst part of each period and the quiet rate in the rest.
//   - A worker that falls behind never catches up: time it did not use is gone, in the burst and in the quiet part.
//   - Starts in any interval number at most (allowed rate integrated over it) + 1. From the start of claiming to T
//     seconds that is maxClaimsWithin(T): the figure the pool is sized against (lib/sizing.mjs).
import { burstSecondsWithin, hasBurst } from './sizing.mjs';

/** The allowed rate integrated from 0 to `seconds`: claims the pattern permits, as a real number. */
export function allowedClaims(seconds, w) {
  if (hasBurst(w)) { const tb = burstSecondsWithin(seconds, w); return w.ratePerWorker * tb + w.quietRate * (seconds - tb); }
  return w.targetRate ? w.targetRate * seconds : Infinity;
}
/** The most claims one worker can START within `seconds` of the start of claiming (the first starts at 0). */
export const maxClaimsWithin = (seconds, w) => Math.floor(allowedClaims(seconds, w)) + 1;

/** Earliest start (seconds since claiming began) of the claim after one that started at `s`. */
export function nextStart(s, w) {
  if (!hasBurst(w)) return w.targetRate ? s + 1 / w.targetRate : s;
  const p = w.burstPeriodSeconds, b = w.burstSeconds;
  let n = Math.floor(s / p), inBurst = s - n * p < b, t = s, need = 1;
  for (let i = 0; i < 1_000_000; i++) {
    const end = inBurst ? n * p + b : (n + 1) * p; // segment ends are computed from the period index, never accumulated
    const rate = inBurst ? w.ratePerWorker : w.quietRate;
    const room = rate * Math.max(0, end - t);
    if (room >= need) return t + need / rate;
    need -= room; t = end;
    if (inBurst) inBurst = false; else { n += 1; inBurst = true; }
  }
  throw new Error('pacer: no next start found (the workload has no positive rate)');
}

/**
 * `since` is when claiming began (ms); every worker of a process shares it, so the pattern is the same for all.
 * wait() resolves when this worker may start its next claim, and records when it really did.
 */
export function createPacer(w, { since, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last = null; // start of this worker's previous claim, seconds since `since`
  return {
    async wait() {
      if (last !== null) {
        const due = since + nextStart(last, w) * 1000;
        for (let left = due - now(); left > 0; left = due - now()) await sleep(left); // a timer may fire early: wait again
      }
      last = Math.max(0, (now() - since) / 1000);
      return last;
    },
  };
}
