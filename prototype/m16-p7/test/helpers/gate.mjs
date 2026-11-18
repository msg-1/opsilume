// The harness of test/gate-closure.test.mjs, shared: an in-process recorder on a temporary directory with cycle 1
// open, one claim acknowledged and its dispatch; HARNESS-SMOKE or a qualifying POWER-CUT run. Tests only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecorder, createRun, recorderBindingOf, registerVolume, runStore } from '../../recorder.mjs';
import { keyFromHex, makeClient, runTag, signRequest } from '../../lib/protocol.mjs';
import { digestOf, testBinding } from '../../lib/readiness.mjs';
import { REQUIRED_ATTESTATIONS } from '../../lib/preflight.mjs';
import { FACTS, IDENTITY, PACKAGE, STORAGE } from './qualifying.mjs';

export const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-gate-'));
export const PG = '7100000000000000001';
export const FINAL = { installationId: 'inst-1', head: 1, headHash: 'ab'.repeat(32) };

/**
 * A recorder with cycle 1 open, one claim acknowledged and its dispatch. `model`: 'HARNESS-SMOKE' (default) or
 * 'POWER-CUT' (a qualifying run: readiness recorded, the start bound to it). `x.evidence()` completes what a PASS
 * needs (cut, confirmation, and for a qualifying run the boot report of the reboot); `x.pass()` sends a PASS with
 * what `check` would send, the evidence mark taken from the view it read.
 */
export async function recorder(run, { model = 'HARNESS-SMOKE', opts = {}, startBootId = 'boot-1' } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'r-'));
  const qualifying = model === 'POWER-CUT';
  createRun(dir, { run, failureModel: model, ...(qualifying ? { storage: STORAGE, identity: IDENTITY, package: PACKAGE } : {}) });
  const st = runStore(dir, run);
  const facts = FACTS(PG);
  const test = testBinding(facts);
  if (qualifying) {
    registerVolume(dir, { pgSystemId: PG, run, failureModel: model });
    st.event({ cycle: null, kind: 'initialised', detail: 'test' });
    for (const item of REQUIRED_ATTESTATIONS) st.event({ cycle: null, kind: 'attestation', item, evidence: 'test', attestation: 'operator' });
    const binding = { test, recorder: recorderBindingOf(dir, run) };
    st.event({ cycle: null, kind: 'readiness', binding, digest: digestOf(binding) });
  }
  const key = keyFromHex(fs.readFileSync(path.join(dir, 'keys', `${run}.key`), 'utf8'));
  const x = { dir, run, test, settings: facts.settings, store: () => runStore(dir, run), root: st.root };
  let server;
  const listen = async () => {
    server = createRecorder(dir, opts);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    x.base = `http://127.0.0.1:${server.address().port}`;
    x.call = makeClient({ baseUrl: x.base, key, run });
  };
  x.restart = async () => { await new Promise((r) => server.close(r)); await listen(); };
  x.server = () => server;
  x.close = () => new Promise((r) => server.close(r));
  x.post = (p, body) => x.call('POST', `/runs/${run}/${p}`, body).then((r) => ({ status: 200, data: r.data }), (e) => ({ status: e.status, data: e.data }));
  x.raw = async (p, text, sign) => {
    const headers = signRequest(key, { method: 'POST', path: `/runs/${run}/${p}`, run, body: text, ...sign });
    const r = await fetch(`${x.base}/runs/${run}/${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: text });
    return { status: r.status, data: await r.json().catch(() => null), headers };
  };
  x.view = async () => (await x.call('GET', `/runs/${run}/cycles/1`)).data;
  await listen();
  if (!qualifying) {
    await x.post('event', { kind: 'volume_claimed', volume: { pgSystemId: PG, publicRelations: 0, stateEntries: 0, walLsnBytes: 1, serverVersion: '16.14' } });
    await x.post('event', { kind: 'initialised', installationId: 'inst-1' });
  }
  const started = await x.post('cycles/1/start', { pgSystemId: PG, proc: 'a', workers: 1, dbHead: 0, bootId: startBootId, settings: facts.settings, sizing: { maxSeconds: 600 }, ...(qualifying ? { readiness: test } : {}) });
  x.cycleId = started.data?.cycleId;
  assert.match(String(x.cycleId), /^[0-9a-f]{32}$/, JSON.stringify(started));
  x.ack = (n, kind, seq, over = {}) => x.post('ack', { cycle: 1, cycleId: x.cycleId, proc: 'a', worker: 1, n, kind, seq, actionId: `${runTag(run)}c0001aw1-${seq}`, ...over });
  assert.equal((await x.ack(1, 'claim', 1)).status, 200);
  assert.equal((await x.ack(2, 'dispatch', 1)).status, 200);
  x.cut = () => st.event({ cycle: 1, kind: 'cut_sent', how: 'manual prompt' }); // as `recorder.mjs cut` writes it
  x.confirm = (yes = 'yes') => st.event({ cycle: 1, kind: 'cut_confirmed', powerWasCut: yes, attestation: 'operator' }); // as `confirm-cut` writes it
  x.boot = (bootId = 'boot-2') => x.post('boot', { bootId });
  x.evidence = async () => { x.cut(); x.confirm(); if (qualifying) assert.equal((await x.boot()).status, 200); };
  /** What `check` sends: the verdict, what it observed after the reboot, and the evidence mark of the view it read. */
  x.passBody = (view, over = {}) => ({ run, cycleId: x.cycleId, verdict: 'PASS', needsRecovery: [], settings: facts.settings,
    identity: { pgSystemId: PG, journalMarkerSha256: test.journal.markerSha256, installationId: test.journal.installationId },
    reboot: { bootIdNow: 'boot-2' }, evidenceMark: view.evidenceMark, ...over });
  x.pass = async (over = {}) => x.post('cycles/1/result', x.passBody(await x.view(), over));
  return x;
}
export const STOP = (x) => x.post('event', { cycle: 1, cycleId: x.cycleId, kind: 'worker_stopped', proc: 'a', worker: 1, detail: 'claim_error' });
