// The claim loop and its pacing (pure). HARNESS tests only: the clock is a fake, nothing sleeps, no database and no
// recorder are involved. They show what the loop does with the answers it is given, not how fast a real machine is.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedClaims, createPacer, maxClaimsWithin, nextStart } from '../lib/pacer.mjs';
import { runWorker, whileBusy } from '../lib/worker.mjs';
import { sizePool } from '../lib/sizing.mjs';

// Synthetic values for tests only: 20 claims/s for 10 s in every 60 s, 2 claims/s otherwise.
const W = { ratePerWorker: 20, targetRate: null, burstPeriodSeconds: 60, burstSeconds: 10, quietRate: 2 };

/**
 * Runs the real worker loop on a fake clock until `seconds` have passed. `claimMs(k, t)` is how long claim k takes
 * (the machine's speed); `timer` is how much of a requested sleep the fake timer really sleeps (1 = exactly).
 */
async function simulate(w, seconds, { claimMs = () => 0, pool = 1_000_000, timer = 1, since = 1_000_000 } = {}) {
  let clock = since;
  const starts = [], calls = [];
  const now = () => clock;
  const sleep = async (ms) => { clock += ms * timer; };
  let stopped = null;
  await runWorker({
    pool, actionIdOf: (k) => `a${k}`, pacer: createPacer(w, { since, now, sleep }),
    claim: async (id, k) => {
      const t = (clock - since) / 1000;
      if (t >= seconds) return { claimed: false, reason: 'test_over' };
      starts.push(t); calls.push(`claim ${id}`);
      clock += claimMs(k, t);
      return { claimed: true, seq: k };
    },
    ack: async (kind, seq) => { calls.push(`ack ${kind} ${seq}`); },
    appendDispatch: async (seq) => { calls.push(`append ${seq}`); },
    stop: (kind, detail) => { stopped = { kind, detail }; },
  });
  const windows = Array.from({ length: Math.ceil(seconds / 10) }, (_, i) => starts.filter((t) => t >= i * 10 && t < (i + 1) * 10).length);
  return { starts, windows, calls, stopped };
}
const gaps = (starts) => starts.slice(1).map((t, i) => t - starts[i]);
const inBurst = (t) => t % 60 < 10;

describe('pacer: the configured maximum burst rate and the quiet rate are limits, not targets', () => {
  test('a machine faster than the limits: the burst runs at the maximum burst rate and the quiet part at the quiet rate, never above', async () => {
    const r = await simulate(W, 180);
    assert.deepEqual(r.windows, [200, 20, 20, 20, 20, 20, 200, 20, 20, 20, 20, 20, 200, 20, 20, 20, 20, 20]);
    for (const [i, n] of r.windows.entries()) assert.ok(n <= (i % 6 === 0 ? 20 : 2) * 10 + 1, `window ${i}: ${n}`);
    // No two starts closer than the limit of the phase they are in (a gap across a boundary is between the two).
    const g = gaps(r.starts);
    for (const [i, d] of g.entries()) {
      const a = r.starts[i], b = r.starts[i + 1];
      if (inBurst(a) && inBurst(b)) assert.ok(d >= 1 / 20 - 1e-9, `burst gap ${d} at ${a}`);
      else if (!inBurst(a) && !inBurst(b)) assert.ok(d >= 1 / 2 - 1e-9, `quiet gap ${d} at ${a}`);
      else assert.ok(d >= 1 / 20 - 1e-9 && d <= 1 / 2 + 1e-9, `boundary gap ${d} at ${a}`);
    }
    assert.equal(r.starts.length, 3 * (200 + 5 * 20));
    assert.ok(r.starts.length <= maxClaimsWithin(180, W));
  });

  test('a machine slower than the maximum burst rate: it claims as fast as it can in the burst and does not make up for it afterwards', async () => {
    const r = await simulate(W, 120, { claimMs: () => 100 }); // 10 claims/s at best
    assert.deepEqual(r.windows.filter((_, i) => i % 6 === 0), [100, 100], 'the burst is limited by the machine, below the configured maximum');
    for (const [i, n] of r.windows.entries()) if (i % 6 !== 0) assert.ok(n <= 21 && n >= 19, `quiet window ${i}: ${n}: the quiet rate is still the limit`);
  });

  test('a worker that stalls does not catch up: unused time is gone, in the burst and in the quiet part', async () => {
    // Claim 30 hangs for 45 s (from inside the first burst to 15 s before the next one).
    const r = await simulate(W, 130, { claimMs: (k) => (k === 30 ? 45_000 : 0) });
    const stallAt = r.starts[29];
    const after = r.starts.filter((t) => t > stallAt);
    assert.ok(after[0] >= stallAt + 45 - 1e-9);
    assert.ok(after.filter((t) => t < 60).length <= Math.floor((60 - after[0]) * 2) + 1, 'back at the quiet rate, not faster');
    assert.equal(r.starts.filter((t) => t >= 60 && t < 70).length, 200, 'the next burst is an ordinary burst, not a bigger one');
    assert.ok(r.starts.length < maxClaimsWithin(130, W) - 150, 'the claims the stall cost were never made up');
  });

  test('a timer that fires early does not let a claim start early', async () => {
    const r = await simulate(W, 70, { timer: 0.6 });
    assert.deepEqual(r.windows, [200, 20, 20, 20, 20, 20, 200]);
    for (const [i, d] of gaps(r.starts).entries()) assert.ok(d >= 1 / 20 - 1e-9, `gap ${d} at ${r.starts[i]}`);
  });

  test('every worker of a process counts the pattern from the same moment', async () => {
    const [a, b] = await Promise.all([simulate(W, 70), simulate(W, 70, { claimMs: () => 30 })]);
    assert.deepEqual([a.windows[6], b.windows[6]], [200, 200], 'both are in their burst from second 60');
    assert.ok(a.windows[5] <= 21 && b.windows[5] <= 21);
  });

  test('next start: within a phase, across the end of a burst, across the end of a period, and with no pattern', () => {
    assert.equal(nextStart(0, W), 0.05);
    assert.equal(nextStart(30, W), 30.5);
    // 9.98 s: 0.02 s of burst is left, worth 0.4 of a claim; the other 0.6 takes 0.3 s of the quiet part.
    assert.ok(Math.abs(nextStart(9.98, W) - 10.3) < 1e-9);
    // 59.9 s: 0.1 s of quiet is worth 0.2 of a claim; the other 0.8 takes 0.04 s of the next burst.
    assert.ok(Math.abs(nextStart(59.9, W) - 60.04) < 1e-9);
    assert.equal(nextStart(10, W), 10.5, 'the boundary itself belongs to the quiet part');
    assert.equal(nextStart(60, W), 60.05);
    assert.equal(nextStart(5, { ratePerWorker: 100, targetRate: 4 }), 5.25, 'a constant throttle');
    assert.equal(nextStart(5, { ratePerWorker: 100, targetRate: null }), 5, 'no pattern and no throttle: not paced (smoke measurement only)');
    assert.throws(() => nextStart(0, { ...W, ratePerWorker: 0, quietRate: 0 }), /no positive rate/);
  });
});

describe('the pool is a genuine upper bound for the configured duration', () => {
  const patterns = [
    [W, 600], [W, 660], [W, 605], [W, 59], [W, 5],
    [{ ...W, ratePerWorker: 150, quietRate: 50 }, 660],
    [{ ...W, ratePerWorker: 7.5, quietRate: 0.3, burstPeriodSeconds: 45, burstSeconds: 7 }, 333],
    [{ ...W, ratePerWorker: 1, quietRate: 0.2, burstPeriodSeconds: 600, burstSeconds: 1 }, 660], // the lowest eligible quiet rate (lib/sizing.mjs)
  ];
  test('allowed claims are the two rates over the burst and quiet seconds, and the sized pool is never below what can start', () => {
    assert.equal(allowedClaims(600, W), 20 * 100 + 2 * 500);
    assert.equal(maxClaimsWithin(600, W), 3001);
    for (const [w, seconds] of patterns) {
      const size = sizePool({ ...w, maxSeconds: seconds });
      assert.ok(size.ok, JSON.stringify(w));
      assert.ok(maxClaimsWithin(seconds, w) <= size.required, `${JSON.stringify(w)} for ${seconds} s: ${maxClaimsWithin(seconds, w)} can start, ${size.required} sized`);
    }
  });
  test('the fastest possible worker starts no more claims than that within the duration, and never runs out of its pool', async () => {
    for (const [w, seconds] of patterns) {
      const size = sizePool({ ...w, maxSeconds: seconds });
      const r = await simulate(w, seconds, { pool: size.pool });
      assert.ok(r.starts.length <= maxClaimsWithin(seconds, w), `${r.starts.length} started, bound ${maxClaimsWithin(seconds, w)}`);
      assert.ok(r.starts.length >= Math.floor(allowedClaims(seconds, w)) - 1, 'and the bound is tight: a fast machine reaches it');
      assert.equal(r.stopped.kind, 'claim_test_over', 'the duration ended first: the pool was not exhausted');
    }
  });
  test('without a pattern or a throttle nothing is bounded: that mode is for measuring a machine, never for a qualifying run', async () => {
    assert.equal(maxClaimsWithin(10, { ratePerWorker: 100, targetRate: null }), Infinity);
    const r = await simulate({ ratePerWorker: 100, targetRate: null }, 10, { claimMs: () => 1, pool: 500 });
    assert.equal(r.stopped.kind, 'pool_exhausted');
  });
});

describe('worker loop: one outcome continues, every other stops for good, and nothing is retried', () => {
  const free = { ratePerWorker: 1000, targetRate: null };
  async function drive(over, pool = 5) {
    const calls = [];
    let stopped = null;
    const deps = {
      pool, actionIdOf: (k) => `a${k}`, pacer: createPacer(free, { since: 0, now: () => 0, sleep: async () => {} }),
      claim: async (id, k) => { calls.push(`claim ${id}`); return { claimed: true, seq: 100 + k }; },
      ack: async (kind, seq, id) => { calls.push(`ack ${kind} ${seq} ${id}`); },
      appendDispatch: async (seq) => { calls.push(`append ${seq}`); },
      stop: (kind, detail) => { stopped = { kind, detail }; return 'stopped'; },
      ...over(calls),
    };
    const result = await runWorker(deps);
    return { calls, stopped, result };
  }
  test('the order for every claim: claim, acknowledge it, append the dispatch intent, acknowledge that; then the pool ends the worker', async () => {
    const r = await drive(() => ({}), 2);
    assert.deepEqual(r.calls, ['claim a1', 'ack claim 101 a1', 'append 101', 'ack dispatch 101 a1', 'claim a2', 'ack claim 102 a2', 'append 102', 'ack dispatch 102 a2']);
    assert.deepEqual(r.stopped, { kind: 'pool_exhausted', detail: 'after 2 actions' });
  });
  test('an uncertain commit: the worker stops; the claim is not acknowledged, not retried, and no other action is claimed', async () => {
    const r = await drive((calls) => ({ claim: async (id, k) => { calls.push(`claim ${id}`); return k === 2 ? { claimed: false, reason: 'uncertain', error: 'connection lost at COMMIT' } : { claimed: true, seq: 100 + k }; } }));
    assert.deepEqual(r.calls, ['claim a1', 'ack claim 101 a1', 'append 101', 'ack dispatch 101 a1', 'claim a2']);
    assert.deepEqual(r.stopped, { kind: 'claim_uncertain', detail: 'connection lost at COMMIT' });
    assert.equal(r.calls.filter((c) => c === 'claim a2').length, 1, 'asked exactly once');
  });
  test('a quarantine, a refused claim, a claim that throws or returns nothing: the same', async () => {
    for (const [answer, kind] of [[{ claimed: false, reason: 'quarantined', problem: 'journal ahead' }, 'claim_quarantined'], [{ claimed: false, reason: 'moved_on' }, 'claim_moved_on'], [undefined, 'claim_undefined'], [{ seq: 7 }, 'claim_undefined']]) {
      const r = await drive((calls) => ({ claim: async (id) => { calls.push(`claim ${id}`); return answer; } }));
      assert.deepEqual([r.calls, r.stopped.kind], [['claim a1'], kind]);
    }
    const thrown = await drive((calls) => ({ claim: async (id) => { calls.push(`claim ${id}`); throw new Error('first line\nJOURNAL_SHORT_WRITE: short write: 10 of 200 bytes'); } }));
    assert.deepEqual([thrown.calls, thrown.stopped], [['claim a1'], { kind: 'claim_error', detail: 'JOURNAL_SHORT_WRITE: short write: 10 of 200 bytes' }]);
  });
  test('a lost acknowledgement of a committed claim: the worker stops; no dispatch intent is written for it and nothing else is claimed', async () => {
    const r = await drive((calls) => ({ ack: async (kind, seq, id) => { calls.push(`ack ${kind} ${seq} ${id}`); if (seq === 102 && kind === 'claim') throw new Error('recorder POST /ack: fetch failed'); } }));
    assert.deepEqual(r.calls.slice(4), ['claim a2', 'ack claim 102 a2']);
    assert.deepEqual(r.stopped, { kind: 'ack_failed', detail: 'recorder POST /ack: fetch failed' });
    assert.ok(!r.calls.includes('append 102') && !r.calls.includes('claim a3'));
    assert.equal(r.calls.filter((c) => c.startsWith('ack claim 102')).length, 1, 'the acknowledgement is not sent again');
  });
  test('a dispatch intent that cannot be appended, or whose acknowledgement is lost: the worker stops there', async () => {
    const noAppend = await drive((calls) => ({ appendDispatch: async (seq) => { calls.push(`append ${seq}`); throw new Error('journal has a torn tail; run the repair tool'); } }));
    assert.deepEqual([noAppend.calls, noAppend.stopped.kind], [['claim a1', 'ack claim 101 a1', 'append 101'], 'dispatch_intent_failed']);
    const noAck = await drive((calls) => ({ ack: async (kind, seq, id) => { calls.push(`ack ${kind} ${seq} ${id}`); if (kind === 'dispatch') throw new Error('timeout'); } }));
    assert.deepEqual([noAck.calls, noAck.stopped.kind], [['claim a1', 'ack claim 101 a1', 'append 101', 'ack dispatch 101 a1'], 'ack_failed']);
  });
  test('never more claims than the pool, and the worker returns what stop returns', async () => {
    const r = await drive(() => ({}), 3);
    assert.equal(r.calls.filter((c) => c.startsWith('claim ')).length, 3);
    assert.equal(r.result, 'stopped');
    const none = await drive(() => ({}), 0);
    assert.deepEqual([none.calls, none.stopped.kind], [[], 'pool_exhausted']);
  });
});

describe('whileBusy: the one answer that may be repeated', () => {
  const busy = () => Object.assign(new Error('recorder POST /start: 503 recorder_busy'), { status: 503, data: { error: 'recorder_busy' } });
  const run = async (answers, opts = {}) => {
    let calls = 0; const slept = [];
    const request = async () => { const a = answers[calls++]; if (a instanceof Error) throw a; return a; };
    try { return { result: await whileBusy(request, { sleep: async (ms) => { slept.push(ms); }, ...opts }), calls, slept }; } catch (error) { return { error, calls, slept }; }
  };
  test('a busy recorder is asked again, and the first real answer is returned', async () => {
    const r = await run([busy(), busy(), { cycleId: 'c1' }]);
    assert.deepEqual([r.result, r.calls, r.slept], [{ cycleId: 'c1' }, 3, [2000, 2000]]);
  });
  test('it gives up after the configured number of attempts, with the busy answer', async () => {
    const r = await run([busy(), busy(), busy(), busy()], { tries: 3 });
    assert.deepEqual([r.error.status, r.calls], [503, 3]);
  });
  test('anything else is never repeated: a timeout, a lost connection, a refusal, an unauthenticated answer, another 503', async () => {
    const others = [
      Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
      new Error('fetch failed'),
      Object.assign(new Error('409 readiness_stale'), { status: 409, data: { error: 'readiness_stale: digest' } }),
      Object.assign(new Error('not authenticated'), { status: 503, unauthenticated: true }),
      Object.assign(new Error('503'), { status: 503, data: { error: 'something_else' } }),
      Object.assign(new Error('500'), { status: 500, data: { error: 'recorder_busy' } }),
    ];
    for (const e of others) {
      const r = await run([e, { cycleId: 'never reached' }]);
      assert.deepEqual([r.error, r.calls, r.slept], [e, 1, []], e.message);
    }
  });
});
