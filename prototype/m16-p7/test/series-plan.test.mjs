// F7 (product-owner decision of 18 November 2026): the whole planned series must fit the envelope clearance was
// validated at before it starts (option 3), and the actual number of affected actions is checked again before every
// cycle (option 2). Nothing is reduced to fit, and claimed actions are not moved out of EXECUTING to make room.
// HARNESS tests only.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QUALIFYING_CYCLES, capacityRefusal, seriesPlan } from '../lib/sizing.mjs';
import { maxClaimsWithin } from '../lib/pacer.mjs';
import { CLEARANCE_ENVELOPE, qualifyingWorkloadProblems, testBinding, vetTestBinding } from '../lib/readiness.mjs';
import { createRecorder, createRun, registerVolume, runStore } from '../recorder.mjs';
import { keyFromHex, makeClient } from '../lib/protocol.mjs';

const W = { procs: 1, workers: 1, maxSeconds: 600, headroom: 2, ratePerWorker: 100, targetRate: null, poolPerWorker: 40000, burstPeriodSeconds: 60, burstSeconds: 10, quietRate: 20 };
const plan = (over = {}) => seriesPlan({ cycles: 20, envelope: CLEARANCE_ENVELOPE, workers: W.workers, procs: W.procs, ratePerWorker: W.ratePerWorker, maxSeconds: W.maxSeconds, headroom: W.headroom, pool: W.poolPerWorker, burstPeriodSeconds: W.burstPeriodSeconds, burstSeconds: W.burstSeconds, quietRate: W.quietRate, ...over });

describe('option 3: the whole series is planned before it starts', () => {
  test('the calculation: every cycle\'s claims accumulate, plus the pool, against the envelope', () => {
    assert.equal(QUALIFYING_CYCLES, 20);
    const p = plan();
    // 100 burst seconds at 100/s and 500 quiet seconds at 20/s allow 20,000 claims; at most one more can start.
    assert.equal(p.claimsPerCycle, 20001);
    assert.equal(p.claimsPerCycle, maxClaimsWithin(600, W), 'the same bound the pacer enforces');
    assert.deepEqual([p.ok, p.cycles, p.poolTotal, p.total, p.envelope], [true, 20, 40000, 20 * 20001 + 40000, 1_000_000]);
    assert.equal(p.maxClaimsPerCyclePermitted, Math.floor((1_000_000 - 40000) / 20), 'derived from the calculation, not a fixed figure');
    assert.match(p.calculation, /^20 cycles x 20001 claims \+ 40000 pooled actions = 440020 of 1000000$/);
  });
  test('a workload that cannot finish the series is refused, with the numbers; nothing is reduced to fit', () => {
    // 300/s bursts and 30/s between allow 45,000 claims per cycle: with its pool of 90,000 that is 990,020, which fits.
    const big = plan({ ratePerWorker: 300, quietRate: 30, pool: 90000 });
    assert.deepEqual([big.ok, big.claimsPerCycle, big.total], [true, 45001, 990020]);
    // A little more does not, though one cycle's pool alone would.
    const tooBig = plan({ ratePerWorker: 320, quietRate: 30, pool: 94000 });
    assert.equal(tooBig.ok, false);
    assert.match(tooBig.reason, /= 1034020 of 1000000: the series does not fit/);
    assert.equal(tooBig.pool ?? 94000, 94000, 'the pool is what was asked for, never adjusted');
  });
  test('the boundary: exactly the envelope fits, one more does not', () => {
    const exact = plan({ ratePerWorker: 100, quietRate: 20, pool: 1_000_000 - 20 * 20001 });
    assert.deepEqual([exact.ok, exact.total], [true, 1_000_000]);
    assert.equal(plan({ pool: 1_000_000 - 20 * 20001 + 1 }).ok, false);
  });
  test('it needs a plan it can bound: cycles, a burst pattern, a pool with headroom of at least 2', () => {
    assert.match(plan({ cycles: 0 }).reason, /planned number of cycles/);
    assert.match(plan({ cycles: 2.5 }).reason, /planned number of cycles/);
    assert.match(plan({ burstPeriodSeconds: null, burstSeconds: null, quietRate: null, pool: 120000 }).reason, /only for a paced workload/);
    assert.match(plan({ headroom: 1.5 }).reason, /headroom must be at least 2/);
    assert.match(plan({ pool: 100 }).reason, /too small/);
    assert.equal(plan({ workers: 2 }).claimsPerCycle, 2 * 20001, 'every worker of every process counts');
  });
});

describe('the readiness record binds the plan', () => {
  test('a qualifying workload names 20 cycles and must fit as a series', () => {
    assert.deepEqual(qualifyingWorkloadProblems({ ...W, cycles: 20 }), []);
    assert.match(qualifyingWorkloadProblems({ ...W }).join(), /plans 20 cycles/);
    assert.match(qualifyingWorkloadProblems({ ...W, cycles: 10 }).join(), /plans 20 cycles, not 10/);
    assert.match(qualifyingWorkloadProblems({ ...W, cycles: 20, ratePerWorker: 320, quietRate: 30, poolPerWorker: 94000 }).join(), /the series does not fit/);
  });
  test('the planned cycles are part of the bound workload: another number is another configuration', () => {
    const a = testBinding({ workload: { ...W, cycles: 20 } }), b = testBinding({ workload: { ...W, cycles: 19 } });
    assert.equal(a.workload.cycles, 20);
    assert.notDeepEqual(a.workload, b.workload);
    assert.equal(vetTestBinding({ workload: { ...W, cycles: '20' } }).test.workload.cycles, 20, 'normalised like every other number');
  });
});

describe('option 2: the actual count is checked again before every cycle', () => {
  test('refused before seeding once what is affected plus what would be added exceeds the envelope', () => {
    assert.equal(capacityRefusal({ affected: 0, adding: 40000, envelope: 1_000_000 }), null);
    assert.equal(capacityRefusal({ affected: 960000, adding: 40000, envelope: 1_000_000 }), null, 'exactly the envelope');
    assert.match(capacityRefusal({ affected: 960001, adding: 40000, envelope: 1_000_000 }), /960001 actions are already affected .* would add 40000: 1000001 exceeds the 1000000/);
    for (const bad of [{ affected: -1, adding: 1 }, { affected: 1.5, adding: 1 }, { affected: null, adding: 1 }, { affected: 1, adding: 0 }, {}]) assert.match(capacityRefusal({ envelope: 1_000_000, ...bad }), /could not be established/, JSON.stringify(bad));
  });
  test('accumulation over a series: each cycle leaves its claims affected; the cycle that would overflow is refused, not shrunk', () => {
    const firstRefusedCycle = (claimsPerCycle, pool) => {
      let affected = 0;
      for (let cycle = 1; cycle <= 20; cycle++) {
        if (capacityRefusal({ affected, adding: pool, envelope: 1_000_000 })) return cycle;
        affected += claimsPerCycle; // what the cycle claimed stays EXECUTING; the unclaimed rest was retired
      }
      return null;
    };
    assert.equal(firstRefusedCycle(45001, 90000), null, 'a series the plan accepts is never stopped by the backstop');
    // 50,001 claims per cycle with a pool of 100,000: 18 cycles leave 900,018 affected, and the 19th would pass the limit.
    assert.equal(firstRefusedCycle(50001, 100000), 19, 'a series the plan would refuse (1,100,020) is stopped before seeding its 19th cycle');
    assert.equal(seriesPlan({ cycles: 20, envelope: 1_000_000, workers: 1, procs: 1, ratePerWorker: 400, maxSeconds: 600, headroom: 2, pool: 100000, burstPeriodSeconds: 60, burstSeconds: 10, quietRate: 20 }).ok, false);
  });
});

describe('the recorder: the plan is in the readiness record, and a qualifying start reports its count', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-series-'));
  test('the stored record carries the calculation; a reported count that is malformed, for another pool, or over the envelope starts nothing', async () => {
    const { PACKAGE, IDENTITY, STORAGE, FACTS } = await import('./helpers/qualifying.mjs');
    const dir = fs.mkdtempSync(path.join(tmp, 'r-'));
    createRun(dir, { run: 's1', failureModel: 'POWER-CUT', storage: STORAGE, identity: IDENTITY, package: PACKAGE });
    const pg = '6700000000000000001';
    const server = createRecorder(dir); await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const call = makeClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, key: keyFromHex(fs.readFileSync(path.join(dir, 'keys', 's1.key'), 'utf8')), run: 's1' });
    const post = (p, body) => call('POST', `/runs/s1/${p}`, body).then((r) => ({ status: 200, data: r.data }), (e) => ({ status: e.status, data: e.data }));
    await post('event', { kind: 'volume_claimed', volume: { pgSystemId: pg, publicRelations: 0, stateEntries: 0, walLsnBytes: 1, serverVersion: '16.14' } });
    await post('event', { kind: 'initialised', installationId: 'inst-1' });
    const s = runStore(dir, 's1');
    for (const item of ['firewall-verified-on-host', 'manual-cut-rehearsed-on-host', 'host-evidence-reviewed']) s.event({ cycle: null, kind: 'attestation', item, evidence: 'test', attestation: 'operator' });
    const test1 = testBinding(FACTS(pg));
    const ready = await post('readiness', { test: test1 });
    assert.equal(ready.status, 200, JSON.stringify(ready.data));
    const record = s.events().find((e) => e.kind === 'readiness');
    assert.deepEqual([record.plan.ok, record.plan.cycles, record.plan.total], [true, 20, 20 * 20001 + 40000]);
    assert.match(record.plan.calculation, /^20 cycles x 20001 claims/);
    assert.equal((await call('GET', '/runs/s1')).data.readiness.plan.total, 440020, 'and status shows it');
    const start = (capacity) => post('cycles/1/start', { pgSystemId: pg, proc: 'a', workers: 1, dbHead: 0, vet: true, readiness: test1, ...(capacity === undefined ? {} : { capacity }) }).then((r) => r.data.error ?? 'vetted');
    assert.equal(await start({ affected: 'many', adding: 40000 }), 'capacity_malformed');
    assert.equal(await start({ affected: -1, adding: 40000 }), 'capacity_malformed');
    assert.equal(await start({ affected: 0, adding: 39999 }), 'capacity_differs_from_ready_workload', 'what would be added is the recorded pool, nothing else');
    assert.equal(await start({ affected: 960001, adding: 40000 }), 'series_capacity_exceeded');
    assert.equal(await start({ affected: 960000, adding: 40000 }), 'vetted');
    assert.equal(await start({ affected: 0, adding: 40000 }), 'vetted');
    // STATED LIMIT: this host cannot count the database. A start that reports no count is not refused here; the count
    // is made, and enforced before seeding, by `p7.mjs`, which always reports it.
    assert.equal(await start(), 'vetted');
    const started = await post('cycles/1/start', { pgSystemId: pg, proc: 'a', workers: 1, dbHead: 0, readiness: test1, capacity: { affected: 12, adding: 40000 } });
    assert.equal(started.status, 200);
    assert.deepEqual(s.events().find((e) => e.kind === 'cycle_start').capacity, { affected: 12, adding: 40000 }, 'what was reported is kept with the start');
    await new Promise((r) => server.close(r));
  });
});
