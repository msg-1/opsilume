// Throughput measurement (pure, and through the recorder's read-only `measure` command). HARNESS tests only: the
// acknowledgement times are synthetic. They show that the report is computed correctly, not what any machine does.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { throughputReport } from '../lib/measure.mjs';
import { nextStart } from '../lib/pacer.mjs';
import { createRun, runStore } from '../recorder.mjs';

const W = { ratePerWorker: 20, targetRate: null, burstPeriodSeconds: 60, burstSeconds: 10, quietRate: 2 };
const START = (over = {}) => ({ proc: 'a', workers: 1, sizing: { ...W, maxSeconds: 120, headroom: 2, poolPerWorker: 6000, ...over } });
const T0 = Date.parse('2026-11-18T10:00:00.000Z');
/** Acknowledgements as the recorder would store them for a worker that claims `speed` times as fast as allowed. */
function ledger(w, seconds, { latencyMs = 20, speed = 1, proc = 'a', worker = 1 } = {}) {
  const out = [];
  // (the tiny margin keeps floating-point drift from adding a claim exactly at the end)
  for (let t = 0, k = 1; t < seconds - 1e-6; t += (nextStart(t, w) - t) / speed, k++) {
    const atMs = Math.round(T0 + t * 1000 + latencyMs);
    out.push({ kind: 'claim', seq: k, proc, worker, atMs }, { kind: 'dispatch', seq: k, proc, worker, atMs: atMs + 5 });
  }
  return out;
}

describe('throughput report: measured from acknowledgements, beside what was configured', () => {
  test('a worker at its limits: totals, 10-second windows, burst and quiet rates, maximum and average', () => {
    const r = throughputReport({ acks: ledger(W, 120), starts: [START()] });
    assert.equal(r.measured.totalAcknowledgedClaims, 2 * (200 + 100));
    assert.equal(r.measured.acknowledgedDispatchIntents, 600);
    assert.deepEqual([r.measured.processes, r.measured.workers, r.measured.streams], [1, 1, ['a/1']]);
    assert.deepEqual(r.measured.windows.filter((x) => x.complete).map((x) => x.claims), [200, 20, 20, 20, 20, 20, 200, 20, 20, 20, 20]);
    assert.deepEqual(r.measured.windows.map((x) => x.burstSecondsInWindow).slice(0, 7), [10, 0, 0, 0, 0, 0, 10]);
    assert.equal(r.measured.burstPeriods.claimsPerSecond, 20);
    assert.ok(Math.abs(r.measured.quietPeriods.claimsPerSecond - 2) < 0.05);
    assert.equal(r.measured.maximumClaimsInOneSecond, 20);
    assert.equal(r.measured.maximumWindowClaimsPerSecond, 20);
    assert.ok(Math.abs(r.measured.averageClaimsPerSecond - 599 / r.measured.durationSeconds) < 0.01);
    assert.ok(r.measured.durationSeconds > 119 && r.measured.durationSeconds < 120);
    assert.equal(r.measured.firstClaimAt, '2026-11-18T10:00:00.020Z');
    assert.equal(r.withinConfiguredLimits, true);
    // Configured values are reported apart and named as declarations.
    assert.deepEqual([r.configured.maximumBurstRatePerWorker, r.configured.quietRatePerWorker, r.configured.burstPeriodSeconds, r.configured.burstSeconds, r.configured.processes, r.configured.workers, r.configured.poolPerWorker, r.configured.maxSeconds], [20, 2, 60, 10, 1, 1, 6000, 120]);
    assert.match(r.configured.note, /not observations/);
    assert.match(r.measured.note, /recorder stored/);
  });

  test('a slower machine: the measured burst rate is below the configured maximum, and is reported as measured', () => {
    const slow = ledger({ ...W, ratePerWorker: 8 }, 120); // the machine reaches 8/s where 20/s is allowed
    const r = throughputReport({ acks: slow, starts: [START()] });
    assert.equal(r.measured.burstPeriods.claimsPerSecond, 8);
    assert.equal(r.configured.maximumBurstRatePerWorker, 20);
    assert.equal(r.withinConfiguredLimits, true);
  });

  test('claims faster than the configured limits are flagged, window by window', () => {
    const r = throughputReport({ acks: ledger({ ...W, ratePerWorker: 40, quietRate: 6 }, 120), starts: [START()] });
    assert.equal(r.withinConfiguredLimits, false);
    assert.equal(r.windowsOverLimit.length, 11 + 1, 'every window is over: the burst and the quiet ones');
    assert.match(r.windowsOverLimit[0], /^0-10 s: 400 claims, limit 211$/);
    assert.match(r.windowsOverLimit[1], /^10-20 s: 60 claims, limit 31$/);
    // Just the quiet rate ignored, the burst respected.
    const q = throughputReport({ acks: ledger({ ...W, quietRate: 5 }, 120), starts: [START()] });
    assert.deepEqual(q.windowsOverLimit.map((x) => x.split(' s')[0]).slice(0, 3), ['10-20', '20-30', '30-40']);
  });

  test('acknowledgement latency moves the anchor a little: the slack covers it, and no more', () => {
    for (const latencyMs of [0, 150, 400]) assert.equal(throughputReport({ acks: ledger(W, 120, { latencyMs }), starts: [START()] }).withinConfiguredLimits, true, `${latencyMs} ms`);
    // A second worker the start never declared doubles the claims: the limit is for the declared workers.
    const two = [...ledger(W, 120), ...ledger(W, 120, { worker: 2 })];
    const r = throughputReport({ acks: two, starts: [START()] });
    assert.deepEqual([r.measured.workers, r.configured.workers, r.withinConfiguredLimits], [2, 1, false]);
    assert.equal(throughputReport({ acks: two, starts: [START(), { ...START(), proc: 'b' }] }).configured.workers, 2);
  });

  test('an unpaced measurement cycle has no limit to compare with; an empty cycle says so', () => {
    const free = { ratePerWorker: 150, targetRate: null };
    const acks = [];
    for (let k = 0; k < 900; k++) acks.push({ kind: 'claim', seq: k + 1, proc: 'a', worker: 1, atMs: T0 + k * 12 });
    const r = throughputReport({ acks, starts: [{ proc: 'a', workers: 1, sizing: { ...free, maxSeconds: 40, headroom: 2, poolPerWorker: 12000 } }] });
    assert.equal(r.withinConfiguredLimits, null);
    assert.match(r.unpaced, /what the machine reached/);
    assert.ok(Math.abs(r.measured.averageClaimsPerSecond - 83.33) < 0.05, 'measured: about 83 claims/s');
    assert.equal(r.configured.sizingRatePerWorker, 150, 'configured: 150/s was only the sizing figure');
    assert.deepEqual([r.configured.maximumBurstRatePerWorker, r.configured.paced, r.measured.burstPeriods, r.measured.quietPeriods], [null, false, null, null]);
    assert.ok(r.measured.windows.every((x) => x.configuredLimit === null && x.overConfiguredLimit === null));
    const none = throughputReport({ acks: [{ kind: 'dispatch', atMs: T0 }], starts: [START()] });
    assert.deepEqual([none.measured.totalAcknowledgedClaims, none.withinConfiguredLimits, none.measured.windows], [0, null, []]);
    assert.deepEqual(throughputReport().measured.totalAcknowledgedClaims, 0);
  });

  test('the same ledger always gives the same report, whatever order its lines are read in', () => {
    const acks = ledger(W, 70);
    const a = JSON.stringify(throughputReport({ acks, starts: [START()] }));
    assert.equal(JSON.stringify(throughputReport({ acks: [...acks].reverse(), starts: [START()] })), a);
  });
});

describe('recorder.mjs measure: read-only', () => {
  test('prints the report for one cycle from the recorder directory and writes nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-measure-'));
    const rec = path.join(dir, 'recorder');
    createRun(rec, { run: 'm1', failureModel: 'HARNESS-SMOKE' });
    const s = runStore(rec, 'm1');
    s.event({ cycle: 2, kind: 'cycle_start', cycleId: 'c'.repeat(32), ...START() });
    fs.mkdirSync(path.join(s.root, 'acks'));
    fs.writeFileSync(path.join(s.root, 'acks', 'cycle-0002.jsonl'), ledger(W, 70).map((x) => JSON.stringify({ ...x, cycle: 2 })).join('\n') + '\n');
    const files = () => fs.readdirSync(rec, { recursive: true }).filter((f) => fs.statSync(path.join(rec, f)).isFile()).map((f) => `${f}:${fs.statSync(path.join(rec, f)).size}`).sort();
    const before = files();
    const cli = fileURLToPath(new URL('../recorder.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [cli, 'measure', '--dir', rec, '--run', 'm1', '--cycle', '2'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual([out.run, out.cycle, out.failureModel, out.measured.totalAcknowledgedClaims, out.withinConfiguredLimits], ['m1', 2, 'HARNESS-SMOKE', 500, true]);
    assert.deepEqual(out.measured.windows.filter((x) => x.complete).map((x) => x.claims), [200, 20, 20, 20, 20, 20]);
    assert.deepEqual(files(), before, 'nothing was written');
    assert.match(spawnSync(process.execPath, [cli, 'measure', '--dir', rec, '--run', 'm1', '--cycle', '3'], { encoding: 'utf8' }).stderr, /cycle 3 has not started/);
    fs.rmSync(dir, { recursive: true });
  });
});
