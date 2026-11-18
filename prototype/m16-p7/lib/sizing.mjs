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

/** The cycles of a qualifying series (decision 9: 20 consecutive passes). The series is planned for all of them. */
export const QUALIFYING_CYCLES = 20;

/**
 * The whole series, planned before it starts (product-owner decision of 18 November 2026 on finding F7).
 * Clearance was validated for `envelope` affected actions. A claimed action stays affected for the rest of the series
 * (the harness never moves it out of EXECUTING, by decision), so every cycle's claims accumulate. The plan therefore is:
 *   cycles x (the most claims that can START in one cycle within maxSeconds, for every worker of every process)
 *   + the pool of one cycle (which already holds headroom x the allowance, headroom >= 2)
 * and it must not exceed the envelope. Nothing is reduced to make it fit: a workload that does not fit is refused.
 * `maxClaimsPerCyclePermitted` is derived from this calculation for the given pool; it is not a fixed figure.
 * The bound is for the planned time: a cut that comes later than planned lets a worker claim more (up to its pool),
 * which the count before every cycle (capacityRefusal) catches.
 */
export function seriesPlan({ cycles, workers, procs = 1, envelope, ...size }) {
  if (!(Number.isInteger(cycles) && cycles >= 1)) return { ok: false, reason: 'the planned number of cycles must be a whole number of at least 1' };
  const burst = { burstPeriodSeconds: size.burstPeriodSeconds, burstSeconds: size.burstSeconds, quietRate: size.quietRate };
  if (!hasBurst(burst)) return { ok: false, reason: 'a series can be planned only for a paced workload (a burst pattern): without one the claims of a cycle have no bound' };
  const plan = sizePlan({ workers, procs, envelope, ...size });
  if (!plan.ok) return plan;
  const tb = burstSecondsWithin(size.maxSeconds, burst);
  // The pacer's own bound (lib/pacer.mjs, maxClaimsWithin): the allowance, and at most one claim more.
  const perWorker = Math.floor(size.ratePerWorker * tb + size.quietRate * (size.maxSeconds - tb)) + 1;
  const claimsPerCycle = procs * workers * perWorker;
  const poolTotal = procs * workers * plan.pool;
  const total = cycles * claimsPerCycle + poolTotal;
  const calculation = `${cycles} cycles x ${claimsPerCycle} claims + ${poolTotal} pooled actions = ${total} of ${envelope}`;
  const out = { cycles, claimsPerCycle, poolTotal, total, envelope, headroom: size.headroom ?? MIN_HEADROOM, maxClaimsPerCyclePermitted: Math.floor((envelope - poolTotal) / cycles), calculation };
  return total <= envelope ? { ok: true, ...out } : { ok: false, ...out, reason: `${calculation}: the series does not fit the number of affected actions clearance was validated at. The workload is not reduced to fit: decide another one` };
}

/**
 * Before every cycle, on the ACTUAL count (the backstop): `affected` is what clearance would have to process now,
 * `adding` what this start would seed. Returns why the start is refused (before anything is seeded), or null.
 */
export function capacityRefusal({ affected, adding, envelope }) {
  if (!(Number.isInteger(affected) && affected >= 0 && Number.isInteger(adding) && adding >= 1)) return 'the number of affected actions could not be established: nothing is seeded without it';
  return affected + adding > envelope ? `${affected} actions are already affected (claimed in earlier cycles, or waiting) and this start would add ${adding}: ${affected + adding} exceeds the ${envelope} clearance was validated at. Nothing was seeded, and nothing is reduced to fit` : null;
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

/**
 * Why the `run` flags cannot be used as given, or null. A flag that is given must be a usable number: it is never
 * ignored. (Before: `--target-rate 0` or a word fell through to another rate, unthrottled, and `--workers 1.5` passed.)
 */
export function runFlagProblem(a) {
  const workers = a.workers === undefined ? 1 : Number(a.workers);
  if (!Number.isInteger(workers) || workers < 1 || workers > 12) return '--workers must be a whole number from 1 to 12';
  for (const k of ['rate', 'target-rate']) if (a[k] !== undefined && !(Number.isFinite(Number(a[k])) && Number(a[k]) > 0)) return `--${k} must be a number above zero`;
  return null;
}
