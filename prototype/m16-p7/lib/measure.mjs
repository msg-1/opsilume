// Throughput of one cycle, MEASURED from the recorder's acknowledgement ledger (pure). Every figure under `measured`
// comes from the times the recorder stored acknowledged claims at, on its own clock; every figure under `configured`
// is what the cycle's start declared. The two are never mixed: a configured rate is a limit, not an observation.
// Deterministic: the same ledger gives the same report.
import { burstSecondsWithin, hasBurst, inQuietPhase } from './sizing.mjs';

const round = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const rate = (n, seconds) => (seconds > 0 ? round(n / seconds) : null);

/**
 * acks: the cycle's acknowledgement entries ({ kind, atMs, proc, worker }). starts: its cycle_start events.
 * The pattern is anchored at the first acknowledged claim. The harness counts it from the moment claiming began, which
 * is earlier by one claim's duration and its acknowledgement's latency: `slackSeconds` allows for that at the edges.
 */
export function throughputReport({ acks = [], starts = [], windowSeconds = 10, slackSeconds = 0.5 } = {}) {
  const claims = acks.filter((a) => a.kind === 'claim' && Number.isFinite(a.atMs)).sort((x, y) => x.atMs - y.atMs);
  const s0 = starts[0]?.sizing ?? {};
  const w = { ratePerWorker: s0.ratePerWorker ?? null, targetRate: s0.targetRate ?? null, burstPeriodSeconds: s0.burstPeriodSeconds ?? null, burstSeconds: s0.burstSeconds ?? null, quietRate: s0.quietRate ?? null };
  const workers = starts.reduce((n, s) => n + (Number.isInteger(s.workers) ? s.workers : 0), 0);
  const configured = {
    note: 'declared at the cycle start: limits and sizing, not observations',
    processes: starts.length, workersPerProcess: starts.map((s) => s.workers ?? null), workers,
    maximumBurstRatePerWorker: hasBurst(w) ? w.ratePerWorker : null, quietRatePerWorker: w.quietRate, burstPeriodSeconds: w.burstPeriodSeconds, burstSeconds: w.burstSeconds,
    constantThrottlePerWorker: w.targetRate, sizingRatePerWorker: w.ratePerWorker, maxSeconds: s0.maxSeconds ?? null, headroom: s0.headroom ?? null, poolPerWorker: s0.poolPerWorker ?? null,
    paced: hasBurst(w) || !!w.targetRate,
  };
  const streams = [...new Set(claims.map((a) => `${a.proc}/${a.worker}`))].sort();
  if (!claims.length) return { configured, measured: { note: 'no acknowledged claims in this cycle', totalAcknowledgedClaims: 0, streams, durationSeconds: 0, windows: [] }, withinConfiguredLimits: null };
  const t0 = claims[0].atMs;
  const at = claims.map((a) => (a.atMs - t0) / 1000);
  const duration = at.at(-1);
  const n = Math.max(1, workers); // every worker follows the same pattern, so the limits scale with the worker count
  const limitOver = (from, to) => {
    if (hasBurst(w)) { const b = burstSecondsWithin(to, w) - burstSecondsWithin(from, w); return n * (w.ratePerWorker * b + w.quietRate * (to - from - b)); }
    return w.targetRate ? n * w.targetRate * (to - from) : null;
  };
  const peak = hasBurst(w) ? w.ratePerWorker : w.targetRate;
  const windows = [];
  for (let i = 0; i * windowSeconds <= duration; i++) {
    const from = i * windowSeconds, to = from + windowSeconds;
    const count = at.filter((t) => t >= from && t < to).length;
    const full = to <= duration;
    const allowed = limitOver(from, to);
    // The most this window may hold: the pattern's allowance, one claim for the boundary, and the anchoring slack.
    const limit = allowed === null ? null : Math.floor(allowed) + n + Math.ceil(n * peak * slackSeconds);
    windows.push({ fromSeconds: from, toSeconds: to, complete: full, claims: count, claimsPerSecond: full ? round(count / windowSeconds) : null,
      burstSecondsInWindow: hasBurst(w) ? round(burstSecondsWithin(to, w) - burstSecondsWithin(from, w), 3) : null, configuredLimit: limit, overConfiguredLimit: limit === null ? null : count > limit });
  }
  const perSecond = new Map();
  for (const t of at) perSecond.set(Math.floor(t), (perSecond.get(Math.floor(t)) ?? 0) + 1);
  const completeWindows = windows.filter((x) => x.complete);
  const phase = (quiet) => {
    if (!hasBurst(w)) return null;
    const count = at.filter((t) => inQuietPhase(t, w) === quiet).length;
    const b = burstSecondsWithin(duration, w), seconds = quiet ? duration - b : b;
    return { claims: count, seconds: round(seconds, 3), claimsPerSecond: rate(count, seconds) };
  };
  const measured = {
    note: 'from the times the recorder stored each acknowledged claim (its own clock); the pattern is anchored at the first of them',
    totalAcknowledgedClaims: claims.length, acknowledgedDispatchIntents: acks.filter((a) => a.kind === 'dispatch').length,
    streams, processes: new Set(claims.map((a) => a.proc)).size, workers: streams.length,
    firstClaimAt: new Date(t0).toISOString(), durationSeconds: round(duration, 3),
    averageClaimsPerSecond: rate(claims.length - 1, duration),
    maximumClaimsInOneSecond: Math.max(...perSecond.values()),
    maximumWindowClaimsPerSecond: completeWindows.length ? Math.max(...completeWindows.map((x) => x.claimsPerSecond)) : null,
    burstPeriods: phase(false), quietPeriods: phase(true),
    windowSeconds, windows,
  };
  const over = windows.filter((x) => x.overConfiguredLimit);
  return { configured, measured,
    withinConfiguredLimits: configured.paced ? over.length === 0 : null,
    ...(over.length ? { windowsOverLimit: over.map((x) => `${x.fromSeconds}-${x.toSeconds} s: ${x.claims} claims, limit ${x.configuredLimit}`) } : {}),
    ...(configured.paced ? {} : { unpaced: 'this cycle had no burst pattern and no throttle: the measured rate is what the machine reached, and there is no limit to compare it with' }) };
}
