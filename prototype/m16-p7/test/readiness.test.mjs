// The readiness binding (pure). HARNESS tests only.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DOCKER_ARCH, SILENT_STOP_MS, bindingDiff, canon, digestOf, identityProblems, qualifyingWorkloadProblems, recorderBinding, testBinding, vetTestBinding } from '../lib/readiness.mjs';

const FACTS = {
  pgSystemId: '7111111111111111111', journal: { markerSha256: 'aa'.repeat(32), installationId: 'inst-1' },
  settings: { fsync: 'on', full_page_writes: 'on', synchronous_commit: 'on', wal_sync_method: 'fdatasync', data_checksums: 'off', server_version: '16.14' },
  netcheck: { strict: true, ok: true, bridges: ['172.23.0.1', '172.22.0.1'], probes: [{ name: 'b', outcome: 'timeout' }, { name: 'a', outcome: 'error:ENETUNREACH' }] },
  workload: { procs: 2, workers: 2, maxSeconds: 600, headroom: 2, ratePerWorker: 100, targetRate: null, poolPerWorker: 120000 },
  source: { sha256: 'cc'.repeat(32), files: 25 }, runtime: { arch: 'x64', node: 'v22.0.0', fingerprint: 'f1'.repeat(32) },
};

describe('readiness binding', () => {
  test('one normal form: key order, flag strings and probe order never change the digest', () => {
    assert.equal(canon({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } }), '{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}');
    const t = testBinding(FACTS);
    const shuffled = testBinding({ runtime: { fingerprint: 'f1'.repeat(32), node: 'v22.0.0', arch: 'x64' }, source: { files: 25, sha256: 'cc'.repeat(32) }, workload: { poolPerWorker: '120000', targetRate: undefined, ratePerWorker: '100', headroom: '2', maxSeconds: '600', workers: '2', procs: '2' },
      netcheck: { ok: true, strict: true, bridges: ['172.22.0.1', '172.23.0.1'], probes: [{ name: 'a' }, { name: 'b' }, { name: 'a' }] }, settings: { ...FACTS.settings }, journal: { installationId: 'inst-1', markerSha256: 'aa'.repeat(32) }, pgSystemId: 7111111111111111111n });
    assert.equal(digestOf(shuffled), digestOf(t));
    assert.deepEqual(vetTestBinding(t), { test: t, problems: [] });
    assert.deepEqual(vetTestBinding(JSON.parse(JSON.stringify(t))).test, t, 'survives the wire');
  });
  test('only what must stay the same for the series is bound: outcomes, heads, boot ids and times are not', () => {
    const t = testBinding(FACTS);
    const later = testBinding({ ...FACTS, bootId: 'another-boot', dbHead: 41234, journalHead: 41234, walLsnBytes: 9e9, at: '2027-01-01T00:00:00Z',
      netcheck: { ...FACTS.netcheck, at: 'later', bootId: 'another-boot', probes: [{ name: 'a', outcome: 'timeout' }, { name: 'b', outcome: 'error:EHOSTUNREACH' }] } });
    assert.equal(digestOf(later), digestOf(t));
    assert.deepEqual(Object.keys(t).sort(), ['firewall', 'journal', 'pgSystemId', 'postgresql', 'runtime', 'source', 'workload']);
    assert.ok(!canon(t).includes('timeout'));
  });
  test('a submitted half is rebuilt field by field: extras are dropped and a digest that does not match its settings is refused', () => {
    const t = testBinding(FACTS);
    assert.deepEqual(vetTestBinding({ ...t, status: 'READY_FOR_OPERATOR_REVIEW', approved: true }).test, t);
    assert.match(vetTestBinding({ ...t, postgresql: { ...t.postgresql, settings: { ...t.postgresql.settings, server_version: '17.0' } } }).problems.join(), /configuration digest does not match/);
    assert.ok(vetTestBinding(undefined).problems.length >= 6 && vetTestBinding({}).problems.length >= 6);
  });
  test('the recorder half binds the run, its type, the recorder, the registry, the storage evidence and what was attested', () => {
    const run = { run: 'p7-1', failureModel: 'POWER-CUT', rootRun: 'p7-1', continues: null, storage: { driveModel: 'X', fua: 'yes' } };
    const base = { run, recorderId: 'ab'.repeat(16), registry: { bytes: 300, sha256: 'cd'.repeat(32) }, attestations: [{ item: 'b', evidence: 'e2', at: 't2' }, { item: 'a', evidence: 'e1', at: 't1' }] };
    const r = recorderBinding(base);
    assert.deepEqual(r.attestations.items, ['a', 'b']);
    const changes = {
      run: { run: { ...run, run: 'p7-2' } }, failureModel: { run: { ...run, failureModel: 'VM-CRASH' } }, rootRun: { run: { ...run, rootRun: 'p7-0' } }, continues: { run: { ...run, continues: { run: 'p7-0' } } },
      recorderId: { recorderId: 'ef'.repeat(16) }, 'registry.bytes': { registry: { ...base.registry, bytes: 301 } }, 'registry.sha256': { registry: { ...base.registry, sha256: '00'.repeat(32) } },
      storageDigest: { run: { ...run, storage: { driveModel: 'X', fua: 'no' } } }, 'attestations.digest': { attestations: [base.attestations[0], { ...base.attestations[1], evidence: 'other words' }] },
    };
    for (const [pathName, over] of Object.entries(changes)) assert.deepEqual(bindingDiff(r, recorderBinding({ ...base, ...over })), [pathName]);
    assert.deepEqual(bindingDiff({ test: testBinding(FACTS), recorder: r }, { test: testBinding(FACTS), recorder: recorderBinding(base) }), []);
    assert.deepEqual(bindingDiff({ a: [1, 2] }, { a: [2, 1] }), ['a'], 'arrays are compared whole');
  });
});

describe('decision B1 and the declared identity (pure)', () => {
  const B1 = { procs: 1, workers: 1, maxSeconds: 660, headroom: 2, ratePerWorker: 300, targetRate: null, poolPerWorker: 99000, burstPeriodSeconds: 60, burstSeconds: 10, quietRate: 30 };
  test('a qualifying workload is one process, one worker, with a burst pattern that fits before the cut', () => {
    assert.deepEqual(qualifyingWorkloadProblems(B1), []);
    assert.deepEqual(vetTestBinding(testBinding({ ...FACTS, workload: B1 })).problems, [], '(300 x 110 + 30 x 550) x 2 = 99,000 actions for 660 s');
    assert.match(qualifyingWorkloadProblems({ ...B1, procs: 2 }).join(), /one process, not 2/);
    assert.match(qualifyingWorkloadProblems({ ...B1, workers: 8 }).join(), /one worker, not 8/);
    assert.match(qualifyingWorkloadProblems({ ...B1, burstPeriodSeconds: null, burstSeconds: null, quietRate: null }).join(), /needs a burst pattern/);
    assert.match(qualifyingWorkloadProblems({ ...B1, burstPeriodSeconds: 661 }).join(), /longer than the time to the cut/);
    assert.equal(qualifyingWorkloadProblems(undefined).length, 3);
  });
  test('the quiet rate must keep the worker inside the silent-stop window: a paced worker must never look stopped', () => {
    // The recorder counts a stream with no acknowledgement in the last SILENT_STOP_MS before the cut as stopped, which
    // makes the cycle INCONCLUSIVE. Quiet claims are 1/quietRate seconds apart, so that gap must stay well inside it.
    assert.equal(SILENT_STOP_MS, 10_000);
    assert.match(qualifyingWorkloadProblems({ ...B1, quietRate: 0.05 }).join(), /quiet rate .* at least 0\.2 /, 'one claim every 20 s: every cut in a quiet part would be inconclusive');
    assert.match(qualifyingWorkloadProblems({ ...B1, quietRate: 0.19 }).join(), /at least 0\.2 /);
    assert.deepEqual(qualifyingWorkloadProblems({ ...B1, quietRate: 0.2 }), [], 'a gap of half the window is allowed');
  });
  test('the declared identity: a full commit, a SHA-256, an image id and a known architecture', () => {
    const ID = { sourceCommit: 'ab'.repeat(20), packageSha256: 'cd'.repeat(32), imageId: `sha256:${'ef'.repeat(32)}`, imageArch: 'amd64' };
    assert.deepEqual(identityProblems(ID), []);
    for (const [k, v] of [['sourceCommit', 'abc1234'], ['sourceCommit', ''], ['packageSha256', 'cd'.repeat(31)], ['imageId', 'ef'.repeat(32)], ['imageId', 'opspilot-isolated-api:latest'], ['imageArch', 'x64'], ['imageArch', undefined]]) {
      assert.equal(identityProblems({ ...ID, [k]: v }).length, 1, `${k}=${v}`);
    }
    assert.equal(identityProblems(undefined).length, 4);
    assert.deepEqual(DOCKER_ARCH, { x64: 'amd64', arm64: 'arm64' });
  });
});
