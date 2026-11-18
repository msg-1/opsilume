// A contradiction that arrives after a PASS was stored (a fresh acknowledgement or worker report about the decided
// cycle) while the recorder cannot write it where it normally goes. Product-owner mission of 18 November 2026: the
// stored PASS must not become valid again because the contradiction could not be recorded, also after a restart, as far
// as the recorder's storage allows. Each case was written before its implementation and seen failing, except those
// marked as controls or as THE STATED LIMIT. HARNESS tests only: in-process recorders, loopback only.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRun, cycleView, runStatus } from '../recorder.mjs';
import { FINAL, recorder } from './helpers/gate.mjs';

/** A qualifying cycle with its PASS stored (not yet recovered). */
async function decided(name) {
  const x = await recorder(name, { model: 'POWER-CUT' });
  await x.evidence();
  const r = await x.pass();
  assert.equal(r.status, 200, JSON.stringify(r.data));
  x.events = path.join(x.root, 'events.jsonl');
  x.rejections = path.join(x.root, 'rejections.jsonl');
  x.markers = path.join(x.dir, 'contradictions');
  /** Makes the given places unwritable: 'rejections', 'events', 'markers' (the third place, below). */
  x.fail = (...what) => {
    if (what.includes('rejections')) { if (!fs.existsSync(x.rejections)) fs.writeFileSync(x.rejections, ''); fs.chmodSync(x.rejections, 0o444); }
    if (what.includes('events')) fs.chmodSync(x.events, 0o444);
    if (what.includes('markers')) { fs.mkdirSync(x.markers, { recursive: true }); fs.chmodSync(x.markers, 0o555); }
  };
  x.heal = () => { for (const f of [x.rejections, x.events]) if (fs.existsSync(f)) fs.chmodSync(f, 0o644); if (fs.existsSync(x.markers)) fs.chmodSync(x.markers, 0o755); };
  x.lateAck = () => x.ack(3, 'claim', 2);
  x.lateStop = () => x.post('event', { cycle: 1, cycleId: x.cycleId, kind: 'worker_stopped', proc: 'a', worker: 1, detail: 'claim_error' });
  x.recover = () => x.post('cycles/1/recovered', { cycleId: x.cycleId, finalState: FINAL });
  x.final = () => cycleView(x.store(), 1).final;
  x.streak = () => runStatus(x.store()).streak.consecutivePhysicalPasses;
  return x;
}

describe('the exact sequence: PASS stored, contradiction, both ledgers unavailable, restart', () => {
  for (const [variant, send] of [['an acknowledgement', (x) => x.lateAck()], ['a worker report', (x) => x.lateStop()]]) {
    test(`${variant}: written to the third place; after the restart the PASS does not become valid again`, async () => {
      const x = await decided(`seq${variant.length}`);
      x.fail('rejections', 'events');
      const r = await send(x);
      assert.equal(r.status, 500);
      assert.deepEqual([r.data.error, r.data.fallback], ['refusal_not_recorded', 'contradiction_marker'], 'not recorded in a ledger, but in a place of its own, and the answer says which');
      assert.equal(fs.readdirSync(path.join(x.markers, x.run)).length, 1);
      x.heal();
      await x.restart();
      assert.equal((await x.recover()).data.final, 'INCONCLUSIVE');
      assert.deepEqual([x.final(), x.streak()], ['INCONCLUSIVE', 0]);
      assert.equal(cycleView(x.store(), 1).contradictedAfterResult, 1);
      await x.close();
    });
  }
});

describe('every way of losing the ordinary records', () => {
  for (const [what, setup] of [
    ['the rejection log fails (control: the fallback event takes it)', (x) => x.fail('rejections')],
    ['the event ledger fails (control: the rejection log takes it)', (x) => x.fail('events')],
    ['both ledgers end in a fragment (an interrupted write)', (x) => { fs.appendFileSync(x.events, '{"kind":"frag'); fs.writeFileSync(x.rejections, '{"reason":"frag'); }],
  ]) {
    test(`${what}: after a restart the cycle ends INCONCLUSIVE`, async () => {
      const x = await decided(`lose${what.length}`);
      setup(x);
      assert.ok((await x.lateAck()).status >= 400);
      x.heal();
      for (const f of [x.events, x.rejections]) { const t = fs.readFileSync(f, 'utf8'); if (!t.endsWith('\n') && t.length) fs.writeFileSync(f, t.slice(0, t.lastIndexOf('\n') + 1)); } // the operator restores complete ledgers
      await x.restart();
      await x.recover();
      assert.deepEqual([x.final(), x.streak()], ['INCONCLUSIVE', 0]);
      await x.close();
    });
  }
  test('a restart BEFORE the contradiction changes nothing: it is recorded and decides', async () => {
    const x = await decided('before');
    await x.restart();
    x.fail('rejections', 'events');
    assert.equal((await x.lateStop()).data.fallback, 'contradiction_marker');
    x.heal();
    assert.equal((await x.recover()).data.final, 'INCONCLUSIVE');
    await x.close();
  });
  test('duplicate contradictions: each is kept, each in a file of its own', async () => {
    const x = await decided('dup');
    x.fail('rejections', 'events');
    await x.lateAck(); await x.lateAck();
    x.heal();
    assert.equal(fs.readdirSync(path.join(x.markers, x.run)).length, 2);
    assert.equal(cycleView(x.store(), 1).contradictedAfterResult, 2);
    await x.close();
  });
  test('a REPLAYED contradiction (anyone who captured a signed request can send it) is not one: the PASS stands (control: by design)', async () => {
    const x = await decided('replay');
    const text = JSON.stringify({ cycle: 1, cycleId: x.cycleId, proc: 'a', worker: 1, n: 3, kind: 'claim', seq: 2, actionId: 'x' });
    const first = await x.raw('ack', text);
    assert.equal(first.status, 409);
    const rec = x.store().rejections().at(-1);
    assert.deepEqual(rec.afterResultOf, [1], 'the original, fresh, contradicts');
    x.fail('rejections', 'events');
    const replay = await fetch(`${x.base}/runs/${x.run}/ack`, { method: 'POST', headers: { 'content-type': 'application/json', ...first.headers }, body: text });
    assert.equal(replay.status, 500);
    x.heal();
    assert.equal(fs.existsSync(path.join(x.markers, x.run)), false, 'a replay writes no marker');
    assert.equal(cycleView(x.store(), 1).contradictedAfterResult, 1, 'only the original counts');
    await x.close();
  });
});

describe('when nothing at all can be written', () => {
  test('the running server holds it: the cycle reads INCONCLUSIVE, recovery and the next start are refused, and it is written as soon as a place can take it', async () => {
    const x = await decided('mem');
    x.fail('rejections', 'events', 'markers');
    const r = await x.lateAck();
    assert.deepEqual([r.status, r.data.fallback], [500, 'none']);
    const v = (await x.call('GET', `/runs/${x.run}/cycles/1`)).data;
    assert.deepEqual([v.final, v.contradictedAfterResult], ['INCONCLUSIVE', 1]);
    assert.equal((await x.call('GET', `/runs/${x.run}`)).data.cycles[0].status, 'INCONCLUSIVE');
    const refused = await x.recover(); // (that refusal cannot be logged either: the answer says what was refused)
    assert.deepEqual([refused.status, refused.data.refused ?? refused.data.error], [500, 'contradiction_after_a_result_not_recorded']);
    assert.equal(x.store().events().some((e) => e.kind === 'recovered'), false);
    x.heal();
    // the next request of any kind writes what this server holds, and recovery then records the cycle as INCONCLUSIVE
    assert.equal((await x.recover()).data.final, 'INCONCLUSIVE');
    assert.equal(fs.readdirSync(path.join(x.markers, x.run)).length, 1);
    await x.restart();
    assert.deepEqual([x.final(), x.streak()], ['INCONCLUSIVE', 0]);
    await x.close();
  });
  test('the next cycle does not start while a contradiction is held only in memory', async () => {
    const x = await decided('memstart');
    x.fail('rejections', 'events', 'markers');
    await x.lateStop();
    const start = await x.post('cycles/2/start', { pgSystemId: '7100000000000000001', proc: 'a', workers: 1, dbHead: 1, bootId: 'boot-2' });
    assert.ok(start.status >= 400);
    assert.match(JSON.stringify(start.data), /contradiction_after_a_result_not_recorded|refusal_not_recorded/);
    await x.close();
  });
  test('THE STATED LIMIT: if no place can be written until the recorder restarts, the restarted recorder does not know, and recovery records a PASS', async () => {
    const x = await decided('limit');
    x.fail('rejections', 'events', 'markers');
    assert.equal((await x.lateAck()).data.fallback, 'none');
    await x.restart(); // still nothing written: this server's memory is gone with it
    x.heal();
    assert.equal((await x.recover()).data.final, 'PASS');
    assert.equal(x.final(), 'PASS');
    await x.close();
  });
});

describe('a contradiction concurrent with the result', () => {
  test('a PASS and a contradicting acknowledgement at the same moment, the ledgers failing: the cycle never ends as a PASS', async () => {
    for (let i = 0; i < 6; i += 1) {
      const x = await recorder(`conc${i}`, { model: 'POWER-CUT' });
      await x.evidence();
      const v = await x.view();
      const root = x.root;
      fs.writeFileSync(path.join(root, 'rejections.jsonl'), ''); fs.chmodSync(path.join(root, 'rejections.jsonl'), 0o444);
      const [pass] = await Promise.all([x.post('cycles/1/result', x.passBody(v)), x.ack(3, 'claim', 2)]);
      fs.chmodSync(path.join(root, 'rejections.jsonl'), 0o644);
      await x.post('cycles/1/recovered', { cycleId: x.cycleId, finalState: FINAL });
      assert.notEqual(cycleView(x.store(), 1).final, 'PASS', `trial ${i}: PASS answered ${pass.status}`);
      await x.close();
    }
  });
});

// Findings of the independent review of the correction (T1 to T3), each reproduced here before its fix.
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { keyFromHex, makeClient } from '../lib/protocol.mjs';
describe('review of the correction', () => {
  for (const [variant, send] of [['an acknowledgement', (x) => x.lateAck()], ['a worker report', (x) => x.lateStop()]]) {
    test(`T1: ${variant} while the event ledger cannot be READ: it still contradicts the PASS, with and without a restart`, async () => {
      for (const restart of [false, true]) {
        const x = await decided(`t1${variant.length}${restart}`);
        fs.chmodSync(x.events, 0o000);
        let r;
        try { r = await send(x); } finally { fs.chmodSync(x.events, 0o644); }
        assert.ok(r.status >= 400);
        if (restart) await x.restart();
        const rec = await x.recover();
        assert.notEqual(rec.data.final, 'PASS', JSON.stringify(rec.data));
        assert.deepEqual([x.final(), x.streak()], ['INCONCLUSIVE', 0], `restart ${restart}`);
        await x.close();
      }
    });
  }
  test('T1: the same with the rejection log unwritable as well: the marker takes it', async () => {
    const x = await decided('t1c');
    x.fail('rejections');
    fs.chmodSync(x.events, 0o000);
    let r;
    try { r = await x.lateAck(); } finally { fs.chmodSync(x.events, 0o644); }
    assert.equal(r.data.fallback, 'contradiction_marker');
    x.heal();
    await x.restart();
    await x.recover();
    assert.deepEqual([x.final(), x.streak()], ['INCONCLUSIVE', 0]);
    await x.close();
  });
  test('T2: while the rejection log cannot be read, a stored PASS is never shown as final PASS, and recovery is refused', async () => {
    const x = await decided('t2');
    assert.equal((await x.lateAck()).status, 409); // the contradiction IS in the rejection log
    fs.chmodSync(x.rejections, 0o000);
    let rec, view;
    try { rec = await x.recover(); view = cycleView(x.store(), 1); } finally { fs.chmodSync(x.rejections, 0o644); }
    assert.notEqual(rec.data.final, 'PASS');
    assert.equal(view.final, 'INCONCLUSIVE');
    assert.equal(x.final(), 'INCONCLUSIVE');
    await x.close();
  });
  test('T3: the marker\'s directories are made durable, also when an earlier attempt left the file behind', async () => {
    const x = await decided('t3');
    x.fail('rejections', 'events');
    const calls = [];
    const real = fs.fsyncSync;
    fs.fsyncSync = (fd) => { calls.push(fd); return real(fd); };
    try { assert.equal((await x.lateAck()).data.fallback, 'contradiction_marker'); } finally { fs.fsyncSync = real; }
    assert.ok(calls.length >= 4, `the file, its directory and the two directories above it: ${calls.length} fsyncs`);
    x.heal();
    await x.close();
  });
  test('`serve` does not stop on SIGTERM while it holds a contradiction; once it is written, it does', async () => {
    const x = await decided('sig');
    await x.close(); // the in-process server stops; `recorder.mjs serve` takes over the same directory
    const port = await new Promise((r) => { const t = net.createServer().listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => r(p)); }); });
    const child = spawn(process.execPath, [fileURLToPath(new URL('../recorder.mjs', import.meta.url)), 'serve', '--dir', x.dir, '--port', String(port), '--host', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    await new Promise((r) => child.stdout.once('data', r));
    const call = makeClient({ baseUrl: `http://127.0.0.1:${port}`, key: keyFromHex(fs.readFileSync(path.join(x.dir, 'keys', `${x.run}.key`), 'utf8')), run: x.run });
    x.fail('rejections', 'events', 'markers');
    const r = await call('POST', `/runs/${x.run}/ack`, { cycle: 1, cycleId: x.cycleId, proc: 'a', worker: 1, n: 3, kind: 'claim', seq: 2, actionId: 'x' }).then(() => null, (e) => e);
    assert.equal(r?.data?.fallback, 'none');
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGUSR2', 'SIGALRM', 'SIGVTALRM']) {
      child.kill(sig);
      await new Promise((res) => setTimeout(res, 250));
      assert.equal(child.exitCode, null, `still running after ${sig}`);
    }
    assert.match(err, /NOT stopping on SIGTERM: 1 contradiction/);
    // `status` is another process: it cannot see what the server holds, and says so.
    const st = spawnSync(process.execPath, [fileURLToPath(new URL('../recorder.mjs', import.meta.url)), 'status', '--dir', x.dir, '--run', x.run], { encoding: 'utf8' });
    assert.match(st.stderr, /a recorder \(process \d+\) is serving this directory/);
    x.heal();
    await call('GET', `/runs/${x.run}`); // any request: what it holds is written
    assert.equal(fs.readdirSync(path.join(x.markers, x.run)).length, 1);
    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
  });
});

// Findings of the second review of the correction (U1, U5), reproduced here before their fix.
import { runStore } from '../recorder.mjs';
describe('second review of the correction', () => {
  test('U1: a rejection log that cannot be read ONCE does not let the run status show a final PASS', async () => {
    const x = await decided('u1');
    assert.equal((await x.lateAck()).status, 409);
    await x.recover();
    const s = runStore(x.dir, x.run);
    let failed = false;
    const flaky = { ...s, rejections: () => { if (!failed) { failed = true; throw Object.assign(new Error('EIO'), { code: 'EIO' }); } return s.rejections(); } };
    const st = runStatus(flaky);
    assert.deepEqual([st.cycles[0].status, st.streak.consecutivePhysicalPasses], ['INCONCLUSIVE', 0]);
    await x.close();
  });
  test('U5: a marker file that already exists with ANOTHER record does not swallow the new one', async () => {
    const x = await decided('u5');
    x.fail('rejections', 'events');
    const r = await x.lateAck();
    assert.equal(r.data.fallback, 'contradiction_marker');
    const d = path.join(x.markers, x.run);
    const [name] = fs.readdirSync(d);
    fs.writeFileSync(path.join(d, name), JSON.stringify({ kind: 'contradiction_after_result', afterResultOf: [99], nonce: 'x' })); // as if another record had been kept under that name
    const { writeContradictionMarkerForTest } = await import('../recorder.mjs');
    writeContradictionMarkerForTest(x.dir, x.run, { kind: 'contradiction_after_result', afterResultOf: [1], nonce: name.replace(/^contradiction-|\.json$/g, '') });
    assert.equal(fs.readdirSync(d).length, 2, 'the new record is kept beside it');
    x.heal();
    await x.close();
  });
});

// Findings of the final independent review (V1, V2), reproduced here before their fix.
describe('final review', () => {
  for (const [ledger, variant, send] of [
    ['rejections.jsonl', 'a worker report', (x) => x.lateStop()],
    ['events.jsonl', 'an acknowledgement', (x) => x.lateAck()],
  ]) {
    test(`V1: ${variant} as the FIRST request after a server start, with ${ledger} unreadable: kept, and the PASS does not become final`, async () => {
      const x = await decided(`v1${ledger.length}`);
      await x.restart(); // a server that has not loaded the run yet
      const f = path.join(x.root, ledger);
      if (!fs.existsSync(f)) fs.writeFileSync(f, '');
      fs.chmodSync(f, 0o000);
      let r;
      try { r = await send(x); } finally { fs.chmodSync(f, 0o644); }
      assert.equal(r.status, 500);
      const kept = fs.readdirSync(path.join(x.markers, x.run)).map((n) => JSON.parse(fs.readFileSync(path.join(x.markers, x.run, n), 'utf8')));
      assert.deepEqual(kept.map((k) => k.afterResultOf), ['*']);
      await x.restart();
      await x.recover();
      assert.deepEqual([x.final(), x.streak()], ['INCONCLUSIVE', 0]);
      await x.close();
    });
  }
  test('V1: the same with the marker location unavailable too: held, and the server does not count it as nothing', async () => {
    const x = await decided('v1held');
    await x.restart();
    x.fail('markers');
    x.rejections = path.join(x.root, 'rejections.jsonl');
    if (!fs.existsSync(x.rejections)) fs.writeFileSync(x.rejections, '');
    fs.chmodSync(x.rejections, 0o000);
    try { assert.equal((await x.lateStop()).status, 500); } finally { fs.chmodSync(x.rejections, 0o644); }
    assert.equal(x.server().heldContradictions(), 1);
    x.heal();
    await x.view(); // the next request for the run writes it
    assert.equal(x.server().heldContradictions(), 0);
    assert.equal(fs.readdirSync(path.join(x.markers, x.run)).length, 1);
    await x.close();
  });
  test('V2: a report while the run directory cannot be read: kept, and the PASS does not become final after a restart', async () => {
    const x = await decided('v2');
    await x.view(); // the server has loaded the run
    fs.chmodSync(x.root, 0o000);
    let r;
    try { r = await x.lateStop(); } finally { fs.chmodSync(x.root, 0o755); }
    assert.equal(r.status, 404);
    assert.equal(fs.readdirSync(path.join(x.markers, x.run)).length, 1);
    await x.restart();
    await x.recover();
    assert.deepEqual([x.final(), x.streak()], ['INCONCLUSIVE', 0]);
    await x.close();
  });
  test('V1/V2: an unsigned or replayed request in the same situation writes nothing', async () => {
    const x = await decided('v12neg');
    await x.restart();
    if (!fs.existsSync(path.join(x.root, 'rejections.jsonl'))) fs.writeFileSync(path.join(x.root, 'rejections.jsonl'), '');
    fs.chmodSync(path.join(x.root, 'rejections.jsonl'), 0o000);
    try {
      assert.equal((await fetch(`${x.base}/runs/${x.run}/ack`, { method: 'POST', body: '{}' })).status, 500);
      const stale = await x.raw('ack', JSON.stringify({ cycle: 1 }), { now: Date.now() - 3_600_000 });
      assert.equal(stale.status, 500);
    } finally { fs.chmodSync(path.join(x.root, 'rejections.jsonl'), 0o644); }
    assert.equal(fs.existsSync(path.join(x.markers, x.run)), false);
    await x.close();
  });
});

// Findings of the recheck of the final review's fixes (W1, W2, W3), reproduced here before their fix.
describe('recheck of the final fixes', () => {
  test('W1: the recorder directory replaced by an empty one while a report arrives: held, never taken as kept on the wrong disk', async () => {
    const x = await decided('w1');
    await x.recover();
    assert.equal(x.final(), 'PASS');
    const away = `${x.dir}.away`;
    fs.renameSync(x.dir, away); fs.mkdirSync(x.dir); // the disk is gone; an empty mount point is left
    let r;
    try { r = await x.lateAck(); } finally { fs.rmSync(x.dir, { recursive: true, force: true }); fs.renameSync(away, x.dir); }
    assert.equal(r.status, 404);
    assert.equal(x.server().heldContradictions(), 1);
    await x.view(); // the disk is back: the next request writes it where it belongs
    assert.equal(x.server().heldContradictions(), 0);
    await x.restart();
    assert.deepEqual([x.final(), x.streak()], ['INCONCLUSIVE', 0]);
    await x.close();
  });
  test('W2: a run whose directory is missing after a restart (its key is there): a report of work is kept in a marker on the recorder\'s own disk, so nothing need be held', async () => {
    const x = await decided('w2');
    await x.restart();
    const away = `${x.root}.away`;
    fs.renameSync(x.root, away);
    let r;
    try { r = await x.lateStop(); } finally { fs.renameSync(away, x.root); }
    assert.equal(r.status, 404);
    // (the review of 18 November 2026, M1: a hold whose marker is safe on the recorder's own disk blocked shutdown for as
    // long as the run directory stayed away. The disk is recognised by the recorder's identity file.)
    assert.equal(x.server().heldContradictions(), 0);
    assert.equal(fs.readdirSync(path.join(x.markers, x.run)).length, 1);
    await x.restart();
    await x.recover();
    assert.deepEqual([x.final(), x.streak()], ['INCONCLUSIVE', 0]);
    await x.close();
  });
  test('W3: `serve` holding nothing ignores SIGPIPE (Node\'s own behaviour) and stops on SIGTERM', async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'p7-pipe-'));
    const port = await new Promise((r) => { const t = net.createServer().listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => r(p)); }); });
    const child = spawn(process.execPath, [fileURLToPath(new URL('../recorder.mjs', import.meta.url)), 'serve', '--dir', dir, '--port', String(port), '--host', '127.0.0.1', '--new-directory'], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((r) => child.stdout.once('data', r));
    child.kill('SIGPIPE');
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(child.exitCode, null, 'SIGPIPE does not end the recorder');
    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
  });
});

// Findings of the last recheck (X1, X2), reproduced here before their fix.
describe('last recheck', () => {
  test('X1: after a restart, the recorder disk replaced by an empty one (keys gone with it): a report of work is still held, and written when the disk returns', async () => {
    const x = await decided('x1');
    await x.recover();
    await x.restart();
    await x.call('GET', `/runs/${x.run}/cycles/1`); // (the client syncs its time with the new server; the run is loaded)
    await x.restart(); // a server that has not loaded the run
    await x.call('POST', `/runs/${x.run}/time`).catch(() => null);
    const away = `${x.dir}.away`;
    fs.renameSync(x.dir, away); fs.mkdirSync(x.dir);
    let r;
    try { r = await x.lateAck(); } finally { fs.rmSync(x.dir, { recursive: true, force: true }); fs.renameSync(away, x.dir); }
    assert.equal(r.status, 404);
    assert.equal(x.server().heldContradictions(), 1);
    await x.view(); // the disk is back
    assert.equal(x.server().heldContradictions(), 0);
    await x.restart();
    assert.deepEqual([x.final(), x.streak()], ['INCONCLUSIVE', 0]);
    await x.close();
  });
  test('X1: nothing is created at the recorder directory\'s path when it is missing', async () => {
    const x = await decided('x1b');
    const away = `${x.dir}.away`;
    fs.renameSync(x.dir, away);
    try { await fetch(`${x.base}/runs/${x.run}/ack`, { method: 'POST', body: '{}' }); await x.lateAck(); assert.equal(fs.existsSync(x.dir), false); } finally { fs.rmSync(x.dir, { recursive: true, force: true }); fs.renameSync(away, x.dir); }
    await x.close();
  });
});

// Finding of the recheck of the key and identity fixes (Y1), reproduced here before its fix.
describe('identity recheck', () => {
  test('Y1: the disk mounted back between the marker write and the identity check: the marker is hidden, so the report stays held', async () => {
    const x = await decided('y1');
    await x.recover();
    const away = `${x.dir}.away`;
    fs.renameSync(x.dir, away); fs.mkdirSync(x.dir); // an empty mount point
    const real = fs.readFileSync;
    let swapped = false;
    // the real disk comes back at the worst moment: just as its identity is read after the marker was written
    fs.readFileSync = function (f, ...rest) {
      if (!swapped && String(f) === path.join(x.dir, 'recorder-id.json') && fs.existsSync(path.join(x.dir, 'contradictions'))) { swapped = true; fs.rmSync(x.dir, { recursive: true, force: true }); fs.renameSync(away, x.dir); }
      return real.call(this, f, ...rest);
    };
    let r;
    try { r = await x.lateAck(); } finally { fs.readFileSync = real; if (!swapped) { fs.rmSync(x.dir, { recursive: true, force: true }); fs.renameSync(away, x.dir); } }
    assert.equal(r.status, 404);
    assert.ok(swapped, 'the race was produced');
    assert.equal(x.server().heldContradictions(), 1, 'the marker is not on the disk that is mounted now: still held');
    await x.view();
    assert.equal(x.server().heldContradictions(), 0);
    await x.restart();
    assert.deepEqual([x.final(), x.streak()], ['INCONCLUSIVE', 0]);
    await x.close();
  });
});

// Findings of the final bounded review (Z1, Z2), reproduced here before their fix. (Supported envelope: a stable disk.)
describe('final bounded review', () => {
  test('Z1: after a restart, the run key unreadable while a report arrives: kept with the key in memory, and the PASS does not become final', async () => {
    const x = await decided('z1');
    await x.restart();
    const keyFile = path.join(x.dir, 'keys', `${x.run}.key`);
    fs.chmodSync(keyFile, 0o000);
    let r;
    try { r = await x.lateStop(); } finally { fs.chmodSync(keyFile, 0o600); }
    assert.equal(r.status, 500);
    assert.equal(fs.readdirSync(path.join(x.markers, x.run)).length, 1);
    await x.restart();
    await x.recover();
    assert.deepEqual([x.final(), x.streak()], ['INCONCLUSIVE', 0]);
    await x.close();
  });
  test('Z2: one signed report sent again and again while the run cannot be loaded is kept once', async () => {
    const x = await decided('z2');
    await x.restart();
    const away = `${x.root}.away`;
    fs.renameSync(x.root, away);
    try {
      const first = await x.raw('event', JSON.stringify({ cycle: 1, cycleId: x.cycleId, kind: 'worker_stopped', proc: 'a', worker: 1 }));
      for (let i = 0; i < 5; i += 1) await fetch(`${x.base}/runs/${x.run}/event`, { method: 'POST', headers: { 'content-type': 'application/json', ...first.headers }, body: JSON.stringify({ cycle: 1, cycleId: x.cycleId, kind: 'worker_stopped', proc: 'a', worker: 1 }) });
    } finally { fs.renameSync(away, x.root); }
    assert.equal(fs.readdirSync(path.join(x.markers, x.run)).length, 1);
    await x.close();
  });
});

describe('review of the key-memory correction', () => {
  test('Z3: a report kept for one run does not suppress a report with the same nonce for ANOTHER run', async () => {
    const x = await decided('z3');
    await x.restart();
    const away = `${x.root}.away`;
    fs.renameSync(x.root, away);
    const nonce = 'cd'.repeat(16);
    try {
      // another run, signed with its own key, using the same nonce first (only a key holder can do this)
      const other = createRun(x.dir, { run: 'z3other', failureModel: 'HARNESS-SMOKE' });
      const otherKey = (await import('../lib/protocol.mjs')).keyFromHex(fs.readFileSync(other.keyFile, 'utf8'));
      const { signRequest } = await import('../lib/protocol.mjs');
      const body = JSON.stringify({ cycle: 1, kind: 'worker_stopped', proc: 'a', worker: 1 });
      await x.restart(); // the server now knows both keys
      fs.renameSync(path.join(x.dir, 'runs', 'z3other'), `${path.join(x.dir, 'runs', 'z3other')}.away`);
      const h1 = signRequest(otherKey, { method: 'POST', path: '/runs/z3other/event', run: 'z3other', body, now: Date.now(), nonce });
      await fetch(`${x.base}/runs/z3other/event`, { method: 'POST', headers: { 'content-type': 'application/json', ...h1 }, body });
      const mine = await x.raw('event', JSON.stringify({ cycle: 1, cycleId: x.cycleId, kind: 'worker_stopped', proc: 'a', worker: 1 }), { nonce });
      assert.equal(mine.status, 404);
    } finally { fs.renameSync(away, x.root); }
    assert.equal(fs.readdirSync(path.join(x.markers, x.run)).length, 1, 'kept for its own run');
    await x.close();
  });
});
