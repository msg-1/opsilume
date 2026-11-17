// Workload sizing for a P7 cycle (pure). The action pool must outlast the longest planned wait for the cut with at
// least 2x headroom, so a cycle is never stopped because the harness ran out of synthetic actions.
export const MIN_HEADROOM = 2;

/**
 * ratePerWorker: expected claims per second per worker (measured in an earlier cycle or a rehearsal, or the throttle).
 * maxSeconds: the longest planned time from the start of claiming to the cut (the cut's --max-seconds plus start-up slack).
 * Returns the actions each worker needs, and whether a given pool is enough.
 */
export function sizePool({ ratePerWorker, maxSeconds, headroom = MIN_HEADROOM, pool }) {
  for (const [k, v] of Object.entries({ ratePerWorker, maxSeconds, headroom })) if (!(Number.isFinite(v) && v > 0)) return { ok: false, reason: `${k} must be a positive number` };
  if (headroom < MIN_HEADROOM) return { ok: false, reason: `headroom must be at least ${MIN_HEADROOM}` };
  const required = Math.ceil(ratePerWorker * maxSeconds * headroom);
  if (pool === undefined) return { ok: true, required, pool: required };
  if (!(Number.isInteger(pool) && pool >= 1)) return { ok: false, reason: 'pool must be a positive integer' };
  return pool >= required ? { ok: true, required, pool } : { ok: false, required, pool, reason: `pool ${pool} per worker is too small: ${ratePerWorker}/s x ${maxSeconds} s x ${headroom} headroom needs ${required}` };
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
