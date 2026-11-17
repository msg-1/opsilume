// Preflight verdict and storage-evidence rules (pure). HARNESS tests only.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FRESH_WAL_LIMIT_BYTES, REQUIRED_ATTESTATIONS, freshVolumeProblems, preflightVerdict } from '../lib/preflight.mjs';
import { storageProblems } from '../lib/verdict.mjs';

const STORAGE = { driveModel: 'Example SSD 1TB', firmware: '1B2QEXM7', controller: 'NVMe (PCIe)', dbDevice: 'nvme0n1p2', journalDevice: 'nvme0n1p2', filesystem: 'ext4 rw,relatime', vendorDoc: 'vendor datasheet rev 3, section 4.2', evidenceFiles: 'host/baseline/*', writeCache: 'write back', fua: 'yes', flushSupported: 'yes', flushesObserved: 'yes', vendorFlushSemantics: 'yes', plp: 'unknown' };
const ready = () => ({
  run: { run: 'p7-1', failureModel: 'POWER-CUT', continues: null, rootRun: 'p7-1', stopped: false, cyclesStarted: 0, attestations: [...REQUIRED_ATTESTATIONS] },
  volume: { pgSystemId: '7111111111111111111', publicRelations: 0, stateEntries: 0, walLsnBytes: 25 * 1024 * 1024, registeredTo: null },
  storageProblems: storageProblems(STORAGE), settingsDurable: true,
  netcheck: { ok: true, strict: true, failed: [] }, recorder: { authenticated: true, unsignedRejected: true }, sizing: { ok: true },
});
const blockedBy = (mutate) => { const f = ready(); mutate(f); const v = preflightVerdict(f); assert.equal(v.status, 'BLOCKED'); return v.reasons.join(' | '); };

describe('storage evidence', () => {
  test('complete evidence qualifies; each critical unknown is named', () => {
    assert.deepEqual(storageProblems(STORAGE), []);
    assert.deepEqual(storageProblems({}).slice(0, 3), ['driveModel is missing or unknown', 'firmware is missing or unknown', 'controller is missing or unknown']);
    assert.match(storageProblems({ ...STORAGE, firmware: 'TBD' }).join(), /firmware is missing or unknown/);
    assert.match(storageProblems({ ...STORAGE, flushSupported: 'unknown' }).join(), /flushSupported/);
  });
  test('decision 5: FUA not advertised needs observed flushes AND vendor-documented semantics', () => {
    assert.deepEqual(storageProblems({ ...STORAGE, fua: 'not-advertised' }), []);
    assert.match(storageProblems({ ...STORAGE, fua: 'not-advertised', flushesObserved: 'no' }).join(), /no kernel flush requests were observed/);
    assert.match(storageProblems({ ...STORAGE, fua: 'not-advertised', vendorFlushSemantics: 'unknown' }).join(), /vendorFlushSemantics/);
    assert.match(storageProblems({ ...STORAGE, fua: 'not-advertised', vendorDoc: '' }).join(), /vendorDoc is missing/);
  });
  test('decision 6: a write-through drive without FUA and without demonstrable flushes is not approved', () => {
    assert.match(storageProblems({ ...STORAGE, writeCache: 'write through', fua: 'not-advertised', flushesObserved: 'no' }).join(), /not approved for qualifying testing/);
    assert.deepEqual(storageProblems({ ...STORAGE, writeCache: 'write through', fua: 'yes', flushesObserved: 'no' }), []);
  });
  test('observed kernel flushes never stand in for the vendor documentation, or the reverse', () => {
    assert.ok(storageProblems({ ...STORAGE, flushesObserved: 'yes', vendorFlushSemantics: 'no' }).length);
    assert.ok(storageProblems({ ...STORAGE, flushesObserved: 'no', vendorFlushSemantics: 'yes' }).length);
  });
});

describe('fresh volumes', () => {
  test('empty and new: no problems; anything else is named', () => {
    assert.deepEqual(freshVolumeProblems(ready().volume), []);
    assert.match(freshVolumeProblems({ ...ready().volume, publicRelations: 9 }).join(), /database is not empty \(9 relations/);
    assert.match(freshVolumeProblems({ ...ready().volume, stateEntries: 2 }).join(), /journal volume is not empty/);
    assert.match(freshVolumeProblems({ ...ready().volume, walLsnBytes: FRESH_WAL_LIMIT_BYTES }).join(), /cluster is not new/);
    assert.equal(freshVolumeProblems({}).length, 4);
  });
});

describe('preflight verdict', () => {
  test('everything in place: READY_FOR_OPERATOR_REVIEW, which is not approval', () => {
    const v = preflightVerdict(ready());
    assert.equal(v.status, 'READY_FOR_OPERATOR_REVIEW');
    assert.deepEqual(v.reasons, []);
    assert.match(v.note, /not approval and starts nothing/);
  });
  test('each missing item blocks, with its exact reason', () => {
    assert.match(blockedBy((f) => { f.run.failureModel = 'HARNESS-SMOKE'; }), /HARNESS-SMOKE run: only a POWER-CUT run can qualify/);
    assert.match(blockedBy((f) => { f.run.failureModel = 'VM-CRASH'; }), /VM-CRASH run/);
    assert.match(blockedBy((f) => { f.run.stopped = true; }), /the run is stopped/);
    assert.match(blockedBy((f) => { f.run.cyclesStarted = 2; }), /already started 2 cycle/);
    assert.match(blockedBy((f) => { f.volume.registeredTo = 'harness-smoke-1'; }), /already used by run harness-smoke-1/);
    assert.match(blockedBy((f) => { f.volume.publicRelations = 6; }), /database is not empty/);
    assert.match(blockedBy((f) => { f.storageProblems = storageProblems({ ...STORAGE, firmware: '' }); }), /storage evidence: firmware is missing/);
    assert.match(blockedBy((f) => { f.settingsDurable = false; }), /synchronous_commit/);
    assert.match(blockedBy((f) => { f.netcheck = { ok: false, strict: true, failed: ['host or bridge 172.22.0.1:22 -> refused'] }; }), /172\.22\.0\.1:22 -> refused/);
    assert.match(blockedBy((f) => { f.netcheck.strict = false; }), /strict mode/);
    assert.match(blockedBy((f) => { f.recorder.authenticated = false; }), /did not answer an authenticated request/);
    assert.match(blockedBy((f) => { f.recorder.unsignedRejected = false; }), /did not reject an unauthenticated request/);
    assert.match(blockedBy((f) => { f.sizing = { ok: false, reason: 'pool 10 per worker is too small' }; }), /workload sizing: pool 10/);
    assert.match(blockedBy((f) => { f.run.attestations = ['firewall-verified-on-host']; }), /missing operator attestation: manual-cut-rehearsed-on-host.*missing operator attestation: host-evidence-reviewed/);
    assert.equal(preflightVerdict({}).status, 'BLOCKED', 'no facts at all');
  });
  test('after init by this run: ready only at the initial state on its own registered volumes', () => {
    const f = ready();
    f.volume = { ...f.volume, publicRelations: 6, stateEntries: 3, initialisedByThisRun: true, registeredTo: 'p7-1', head: 0, journalStatus: 'empty', trusted: true };
    assert.equal(preflightVerdict(f).status, 'READY_FOR_OPERATOR_REVIEW');
    f.volume.head = 4;
    assert.match(preflightVerdict(f).reasons.join(), /not at its initial state/);
  });
  test('a continuing run: only POWER-CUT state of the same series, trusted and unchanged', () => {
    const f = ready();
    f.run = { ...f.run, run: 'p7-2', rootRun: 'p7-1', continues: { run: 'p7-1', failureModel: 'POWER-CUT' } };
    f.volume = { ...f.volume, publicRelations: 6, stateEntries: 3, registeredTo: 'p7-1', trusted: true, matchesPredecessor: true };
    assert.equal(preflightVerdict(f).status, 'READY_FOR_OPERATOR_REVIEW');
    f.run.continues.failureModel = 'HARNESS-SMOKE';
    assert.match(preflightVerdict(f).reasons.join(), /never continues other state/);
    f.run.continues.failureModel = 'POWER-CUT'; f.volume.matchesPredecessor = false;
    assert.match(preflightVerdict(f).reasons.join(), /not in the state recorded/);
    f.volume.matchesPredecessor = true; f.volume.registeredTo = 'someone-else';
    assert.match(preflightVerdict(f).reasons.join(), /not the ones the series started on/);
  });
});
