// Workload sizing for a P7 cycle (pure). The action pool must outlast the longest planned wait for the cut with at
// least 2x headroom, so a cycle is never stopped because the harness ran out of synthetic actions.
export const MIN_HEADROOM = 2;
// The recorder counts a stream with no acknowledgement for SILENT_STOP_MS before the cut as stopped, which makes the
// cycle INCONCLUSIVE (recorder.mjs, cycleView). Quiet claims are 1/quietRate seconds apart, so a pattern is eligible
// only if that gap is at most half the window: a quiet rate of at least MIN_QUIET_RATE. An eligibility floor (accepted
// by the product owner on 18 November 2026), not a workload: the rates themselves are decided separately.
export const SILENT_STOP_MS = 10_000;
export const MIN_QUIET_RATE = 2 / (SILENT_STOP_MS / 1000);

// A burst pattern (decision B1): from the start of claiming, every `burstPeriodSeconds` begins with `burstSeconds` in
// which claims start at no more than ratePerWorker per second (the maximum burst rate), followed by claims at no more
// than `quietRate` per second. Both limits are enforced by lib/pacer.mjs, so the pool below is an upper bound: at most
// (allowance + 1) claims can start within maxSeconds, and headroom >= 2 makes the pool at least that.
// The same pattern in every cycle. All three values, or none.
const given = (v) => v !== null && v !== undefined;
export const hasBurst = (b) => given(b?.burstPeriodSeconds) || given(b?.burstSeconds) || given(b?.quietRate);
export function burstProblem({ ratePerWorker, burstPeriodSeconds: p, burstSeconds: b, quietRate: q }) {
  if (!hasBurst({ burstPeriodSeconds: p, burstSeconds: b, quietRate: q })) return null;
  if (![p, b, q].every(given)) return 'a burst pattern needs the burst period, the burst seconds and the quiet rate together';
  if (![p, b, q].every((v) => Number.isFinite(v) && v > 0)) return 'the burst period, the burst seconds and the quiet rate must be positive numbers';
  if (!(b < p)) return 'the burst seconds must be shorter than the burst period';
  if (!(q < ratePerWorker)) return 'the quiet rate must be below the burst rate (ratePerWorker)';
  if (!(q >= MIN_QUIET_RATE)) return `the quiet rate must be at least ${MIN_QUIET_RATE} claims per second: at ${q} the worker is silent for longer than half the ${SILENT_STOP_MS / 1000} s after which the recorder counts it as stopped`;
  return null;
}
/** Seconds of the first `maxSeconds` that fall in a burst: the pattern starts with a burst and repeats every period. */
export const burstSecondsWithin = (maxSeconds, { burstPeriodSeconds: p, burstSeconds: b }) => Math.floor(maxSeconds / p) * b + Math.min(maxSeconds % p, b);
/** Whether a claim `elapsedSeconds` after the start of claiming falls in the throttled part of its period. */
export const inQuietPhase = (elapsedSeconds, { burstPeriodSeconds: p, burstSeconds: b }) => elapsedSeconds % p >= b;

/**
 * ratePerWorker: expected claims per second per worker (measured in an earlier cycle or a rehearsal, or the throttle).
 * maxSeconds: the longest planned time from the start of claiming to the cut (the cut's --max-seconds plus start-up slack).
 * Returns the actions each worker needs, and whether a given pool is enough.
 */
export function sizePool({ ratePerWorker, maxSeconds, headroom = MIN_HEADROOM, pool, burstPeriodSeconds, burstSeconds, quietRate }) {
  for (const [k, v] of Object.entries({ ratePerWorker, maxSeconds, headroom })) if (!(Number.isFinite(v) && v > 0)) return { ok: false, reason: `${k} must be a positive number` };
  if (headroom < MIN_HEADROOM) return { ok: false, reason: `headroom must be at least ${MIN_HEADROOM}` };
  const burst = { burstPeriodSeconds, burstSeconds, quietRate };
  const bp = burstProblem({ ratePerWorker, ...burst });
  if (bp) return { ok: false, reason: bp };
  // With a burst pattern: the burst rate for the burst seconds that fit in maxSeconds, the throttled quiet rate otherwise.
  const tb = hasBurst(burst) ? burstSecondsWithin(maxSeconds, burst) : maxSeconds;
  const required = Math.ceil((ratePerWorker * tb + (hasBurst(burst) ? quietRate * (maxSeconds - tb) : 0)) * headroom);
  if (pool === undefined) return { ok: true, required, pool: required };
  if (!(Number.isInteger(pool) && pool >= 1)) return { ok: false, reason: 'pool must be a positive integer' };
  return pool >= required ? { ok: true, required, pool } : { ok: false, required, pool, reason: `pool ${pool} per worker is too small: ${hasBurst(burst) ? `${ratePerWorker}/s for ${tb} burst s and ${quietRate}/s for ${maxSeconds - tb} quiet s` : `${ratePerWorker}/s x ${maxSeconds} s`} x ${headroom} headroom needs ${required}` };
}

/**
 * The whole planned cycle (preflight): every process's workers count against the number of waiting actions clearance
 * was validated at. `run` enforces the same bound per start, on what is actually waiting.
 */
export function sizePlan({ workers, procs = 1, envelope, ...size }) {
  if (!(Number.isInteger(workers) && workers >= 1 && workers <= 12)) return { ok: false, reason: '--workers must be a whole number from 1 to 12' };
  if (!(Number.isInteger(procs) && procs >= 1 && procs <= 26)) return { ok: false, reason: '--procs must be a whole number from 1 to 26' };
  const s = sizePool(size);
  if (!s.ok) return s;
  const total = procs * workers * s.pool;
  return total > envelope ? { ok: false, reason: `${procs} process(es) x ${workers} worker(s) x ${s.pool} actions = ${total} exceeds the ${envelope} actions clearance was validated at` } : { ...s, workers, procs, total };
}

/** Claims per second per stream, from the recorder's acknowledgements of one cycle (its own clock). */
export function measuredRate(acks) {
  const by = new Map();
  for (const a of acks) if (a.kind === 'claim' && Number.isFinite(a.atMs)) {
    const k = `${a.proc}/${a.worker}`;
    const s = by.get(k) ?? { n: 0, first: a.atMs, last: a.atMs };
    s.n += 1; s.first = Math.min(s.first, a.atMs); s.last = Math.max(s.last, a.atMs);
    by.set(k, s);
  }
  const rates = [...by.values()].filter((s) => s.n >= 20 && s.last > s.first).map((s) => (s.n - 1) / ((s.last - s.first) / 1000));
  // totalPerSecond bounds what ONE worker could reach alone: claims are serialised by the state-row lock.
  return rates.length ? { streams: rates.length, totalPerSecond: Math.round(rates.reduce((x, y) => x + y, 0) * 10) / 10, maxPerWorker: Math.round(Math.max(...rates) * 10) / 10, minPerWorker: Math.round(Math.min(...rates) * 10) / 10 } : null;
}
