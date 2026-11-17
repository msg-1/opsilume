// Workload sizing tests (pure). HARNESS tests only.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { burstProblem, burstSecondsWithin, hasBurst, inQuietPhase, measuredRate, sizePlan, sizePool, MIN_QUIET_RATE, SILENT_STOP_MS } from '../lib/sizing.mjs';

describe('workload sizing', () => {
  test('required pool = rate x longest planned wait x headroom (at least 2)', () => {
    assert.deepEqual(sizePool({ ratePerWorker: 250, maxSeconds: 600 }), { ok: true, required: 300000, pool: 300000 });
    assert.equal(sizePool({ ratePerWorker: 250, maxSeconds: 600, headroom: 3 }).required, 450000);
    assert.equal(sizePool({ ratePerWorker: 0.5, maxSeconds: 7 }).required, 7);
  });
  test('a pool that is too small is refused, with the numbers; an adequate one is kept', () => {
    const r = sizePool({ ratePerWorker: 250, maxSeconds: 600, pool: 50000 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /too small.*needs 300000/);
    assert.equal(sizePool({ ratePerWorker: 250, maxSeconds: 600, pool: 300000 }).ok, true);
    assert.equal(sizePool({ ratePerWorker: 250, maxSeconds: 600, pool: 299999 }).ok, false);
  });
  test('headroom below 2, and missing or non-positive inputs, are refused', () => {
    assert.match(sizePool({ ratePerWorker: 250, maxSeconds: 600, headroom: 1.5 }).reason, /at least 2/);
    for (const bad of [{ maxSeconds: 600 }, { ratePerWorker: 250 }, { ratePerWorker: 0, maxSeconds: 600 }, { ratePerWorker: 250, maxSeconds: NaN }, { ratePerWorker: -1, maxSeconds: 1 }]) assert.equal(sizePool(bad).ok, false);
    assert.equal(sizePool({ ratePerWorker: 1, maxSeconds: 1, pool: 2.5 }).ok, false);
  });
  test('measured rate: per stream from the recorder clock; the total bounds a single worker', () => {
    const acks = [];
    for (let i = 0; i < 101; i++) acks.push({ kind: 'claim', proc: 'a', worker: 1, atMs: 1000 + i * 10 }, { kind: 'dispatch', proc: 'a', worker: 1, atMs: 1005 + i * 10 });
    for (let i = 0; i < 51; i++) acks.push({ kind: 'claim', proc: 'b', worker: 1, atMs: 1000 + i * 20 });
    assert.deepEqual(measuredRate(acks), { streams: 2, totalPerSecond: 150, maxPerWorker: 100, minPerWorker: 50 });
    assert.equal(measuredRate(acks.slice(0, 10)), null, 'too few acknowledgements to measure');
    assert.equal(measuredRate([]), null);
  });
  test('the planned cycle: workers and processes must be whole numbers, and all of them count against the envelope', () => {
    const base = { envelope: 1_000_000, ratePerWorker: 250, maxSeconds: 600 };
    assert.deepEqual(sizePlan({ ...base, workers: 2 }), { ok: true, required: 300000, pool: 300000, workers: 2, procs: 1, total: 600000 });
    for (const workers of [NaN, 0, -1, 1.5, 13, undefined]) assert.match(sizePlan({ ...base, workers }).reason, /--workers must be a whole number/, String(workers));
    for (const procs of [NaN, 0, 1.5, 27]) assert.match(sizePlan({ ...base, workers: 1, procs }).reason, /--procs must be a whole number/, String(procs));
    assert.match(sizePlan({ ...base, workers: 2, procs: 2 }).reason, /2 process\(es\) x 2 worker\(s\) x 300000 actions = 1200000 exceeds the 1000000/);
    assert.match(sizePlan({ ...base, workers: 1, ratePerWorker: NaN }).reason, /ratePerWorker must be a positive number/, 'no rate given');
    assert.match(sizePlan({ ...base, workers: 1, pool: 1000 }).reason, /too small/);
  });
});

describe('burst pattern (decision B1): one worker, bursts at fixed times, the same in every cycle', () => {
  const B = { burstPeriodSeconds: 60, burstSeconds: 10, quietRate: 20 };
  test('the phase of a claim depends only on the time since claiming started', () => {
    for (const [t, quiet] of [[0, false], [9.999, false], [10, true], [59.999, true], [60, false], [69.9, false], [70, true], [600, false], [615, true]]) assert.equal(inQuietPhase(t, B), quiet, `t=${t}`);
  });
  test('burst seconds within the planned time: whole periods, plus the part of the last one', () => {
    assert.equal(burstSecondsWithin(600, B), 100);
    assert.equal(burstSecondsWithin(660, B), 110);
    assert.equal(burstSecondsWithin(605, B), 105, 'a partial period starts with its burst');
    assert.equal(burstSecondsWithin(5, B), 5);
    assert.equal(burstSecondsWithin(59, B), 10);
  });
  test('the pool covers the burst rate in the bursts and the throttled rate between them, with headroom', () => {
    assert.deepEqual(sizePool({ ratePerWorker: 100, maxSeconds: 600, ...B }), { ok: true, required: 40000, pool: 40000 });
    assert.equal(sizePool({ ratePerWorker: 100, maxSeconds: 600, headroom: 3, ...B }).required, 60000);
    assert.equal(sizePool({ ratePerWorker: 100, maxSeconds: 600, pool: 39999, ...B }).ok, false);
    assert.match(sizePool({ ratePerWorker: 100, maxSeconds: 600, pool: 39999, ...B }).reason, /100\/s for 100 burst s and 20\/s for 500 quiet s x 2 headroom needs 40000/);
    assert.ok(sizePool({ ratePerWorker: 100, maxSeconds: 600, ...B }).required < sizePool({ ratePerWorker: 100, maxSeconds: 600 }).required, 'never more than running flat out');
    // Without a pattern nothing changes; null (a flag that was not given) means the same as absent.
    assert.deepEqual(sizePool({ ratePerWorker: 250, maxSeconds: 600, burstPeriodSeconds: null, burstSeconds: null, quietRate: null }), { ok: true, required: 300000, pool: 300000 });
  });
  test('a pattern is all three values, positive, a burst shorter than its period, a quiet rate below the burst rate', () => {
    assert.equal(hasBurst({}), false);
    assert.equal(hasBurst({ quietRate: 5 }), true);
    assert.equal(burstProblem({ ratePerWorker: 100, ...B }), null);
    assert.match(sizePool({ ratePerWorker: 100, maxSeconds: 600, burstPeriodSeconds: 60 }).reason, /together/);
    assert.match(sizePool({ ratePerWorker: 100, maxSeconds: 600, ...B, burstSeconds: 60 }).reason, /shorter than the burst period/);
    assert.match(sizePool({ ratePerWorker: 100, maxSeconds: 600, ...B, quietRate: 100 }).reason, /below the burst rate/);
    for (const bad of [{ burstSeconds: 0 }, { burstPeriodSeconds: -60 }, { quietRate: NaN }, { quietRate: Infinity }]) assert.match(sizePool({ ratePerWorker: 100, maxSeconds: 600, ...B, ...bad }).reason, /positive numbers/);
  });
  test('the clearance envelope still bounds the whole plan: one worker, one process', () => {
    const plan = (rate) => sizePlan({ workers: 1, procs: 1, envelope: 1_000_000, ratePerWorker: rate, maxSeconds: 660, burstPeriodSeconds: 60, burstSeconds: 10, quietRate: 50 });
    assert.equal(plan(757).total, (757 * 110 + 50 * 550) * 2);
    assert.equal(plan(4000).ok, true, '(4000 x 110 + 50 x 550) x 2 = 935,000');
    assert.match(plan(4400).reason, /exceeds the 1000000/);
  });
});

describe('the quiet-rate floor (accepted 18 November 2026): an eligibility floor, enforced where the workload is sized', () => {
  const P = { ratePerWorker: 100, maxSeconds: 600, burstPeriodSeconds: 60, burstSeconds: 10 };
  test('a burst pattern with a quiet rate below 0.2 claims per second is not sized: neither the pool nor the plan', () => {
    assert.equal(SILENT_STOP_MS, 10_000, 'the recorder counts a stream that was silent this long before the cut as stopped');
    assert.equal(MIN_QUIET_RATE, 0.2, 'quiet claims at most half that window apart');
    for (const q of [0.01, 0.1, 0.19, 0.1999]) {
      assert.match(sizePool({ ...P, quietRate: q }).reason, /quiet rate must be at least 0\.2 claims per second/, `pool, ${q}`);
      assert.match(sizePlan({ workers: 1, procs: 1, envelope: 1_000_000, ...P, quietRate: q }).reason, /quiet rate must be at least 0\.2 claims per second/, `plan, ${q}`);
    }
  });
  test('0.2 itself is eligible, and the floor selects nothing: any higher quiet rate below the burst rate is sized as before', () => {
    assert.deepEqual(sizePool({ ...P, quietRate: 0.2 }), { ok: true, required: (100 * 100 + 0.2 * 500) * 2, pool: (100 * 100 + 0.2 * 500) * 2 });
    for (const q of [0.25, 2, 20, 99]) assert.equal(sizePool({ ...P, quietRate: q }).ok, true, String(q));
  });
  test('a workload without a burst pattern has no quiet rate, and is sized as before', () => {
    assert.equal(sizePool({ ratePerWorker: 0.05, maxSeconds: 600 }).ok, true);
  });
});
