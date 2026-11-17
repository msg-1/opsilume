// The readiness binding (pure). HARNESS tests only.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bindingDiff, canon, digestOf, recorderBinding, testBinding, vetTestBinding } from '../lib/readiness.mjs';

const FACTS = {
  pgSystemId: '7111111111111111111', journal: { markerSha256: 'aa'.repeat(32), installationId: 'inst-1' },
  settings: { fsync: 'on', full_page_writes: 'on', synchronous_commit: 'on', wal_sync_method: 'fdatasync', data_checksums: 'off', server_version: '16.14' },
  netcheck: { strict: true, ok: true, bridges: ['172.23.0.1', '172.22.0.1'], probes: [{ name: 'b', outcome: 'timeout' }, { name: 'a', outcome: 'error:ENETUNREACH' }] },
  workload: { procs: 2, workers: 2, maxSeconds: 600, headroom: 2, ratePerWorker: 100, targetRate: null, poolPerWorker: 120000 },
};

describe('readiness binding', () => {
  test('one normal form: key order, flag strings and probe order never change the digest', () => {
    assert.equal(canon({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } }), '{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}');
    const t = testBinding(FACTS);
    const shuffled = testBinding({ workload: { poolPerWorker: '120000', targetRate: undefined, ratePerWorker: '100', headroom: '2', maxSeconds: '600', workers: '2', procs: '2' },
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
    assert.deepEqual(Object.keys(t).sort(), ['firewall', 'journal', 'pgSystemId', 'postgresql', 'workload']);
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
