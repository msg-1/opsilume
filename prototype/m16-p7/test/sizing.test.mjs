// Workload sizing tests (pure). HARNESS tests only.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { measuredRate, sizePool } from '../lib/sizing.mjs';

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
});
