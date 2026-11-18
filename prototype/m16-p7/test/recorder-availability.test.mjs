// Regression tests for two availability defects of the recorder server found in the post-commit review of 462f5d4
// (docs/m16-p7-post-commit-review.md, F1 and F2). The tests under "must survive" were written failing against that
// commit (the server process died) and pass with the fix. The tests under "evidence" pin what must hold before and
// after: a damaged ledger is never rewritten, repaired or discarded, and a refusal is never reported as recorded
// when it was not.
// Each scenario runs a real recorder server in its OWN process, on a temporary directory and the loopback address,
// because the defect is that the process dies. HARNESS tests only.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRun, cycleView, dirReport, runStore } from '../recorder.mjs';
import { keyFromHex, makeClient, signRequest } from '../lib/protocol.mjs';

const RECORDER = new URL('../recorder.mjs', import.meta.url).href;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-availability-'));
// The server each scenario runs: a script of its own (recorder.mjs looks at process.argv[1], so it can't be run with -e).
const SERVER = path.join(tmp, 'serve.mjs');
fs.writeFileSync(SERVER, `import { createRecorder } from ${JSON.stringify(RECORDER)};\nconst s = createRecorder(process.argv[2]);\ns.listen(0, '127.0.0.1', () => console.log(s.address().port));\n`);
const children = [];
after(() => { for (const c of children) c.kill(); });

const tree = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => fs.statSync(path.join(d, f)).isFile()).sort()
  .map((f) => `${f} ${createHash('sha256').update(fs.readFileSync(path.join(d, f))).digest('hex')}`);
/** One raw request line, exactly as sent on the wire; resolves with the status line of the answer ('' if none came). */
const rawRequest = (port, line) => new Promise((resolve) => {
  let got = '';
  const s = net.connect(port, '127.0.0.1', () => s.write(`${line}\r\nhost: recorder\r\n\r\n`));
  s.on('data', (d) => { got += d; });
  s.on('error', () => {});
  s.on('close', () => resolve(got.split('\r\n')[0]));
  setTimeout(() => s.destroy(), 700);
});
/** A recorder directory with one smoke run, then a server on it in a process of its own. */
async function recorder(prepare) {
  const dir = fs.mkdtempSync(path.join(tmp, 'r-'));
  createRun(dir, { run: 's1', failureModel: 'HARNESS-SMOKE' });
  prepare?.(dir);
  const start = () => {
    const child = spawn(process.execPath, [SERVER, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const started = Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error(`the test's recorder server did not start: ${stderr.slice(0, 300)}`); })]);
    return started.then(([line]) => {
      const port = Number(String(line).trim());
      const key = keyFromHex(fs.readFileSync(path.join(dir, 'keys', 's1.key'), 'utf8'));
      const call = makeClient({ baseUrl: `http://127.0.0.1:${port}`, key, run: 's1', timeoutMs: 3000 });
      return {
        port, key, call,
        raw: (line2) => rawRequest(port, line2),
        /** Whether the server process is still running a moment later, and what it wrote to stderr if not. */
        settled: async () => { await new Promise((r) => setTimeout(r, 300)); return { alive: child.exitCode === null && child.signalCode === null, stderr }; },
        validGet: () => call('GET', '/runs/s1').then((r) => r.data.run.run, (e) => `failed: ${e.status ?? e.message}`),
        stop: () => child.kill(),
      };
    });
  };
  return { dir, start, ...(await start()) };
}
const runRejections = (d) => path.join(d, 'runs', 's1', 'rejections.jsonl');
const globalRejections = (d) => path.join(d, 'rejections.jsonl');
const FRAGMENT = '{"reason":"bad_mac","at":"2026-11-18T0'; // a line whose writer died: no final newline

describe('must survive: no request may end the recorder process', () => {
  for (const target of ['http://[', '//[', 'http://x:99999/']) {
    test(`defect 1: an unauthenticated request whose target is not a valid URL (${target}) is answered, and the server keeps serving`, async () => {
      const r = await recorder();
      const before = tree(r.dir);
      const answer = await r.raw(`GET ${target} HTTP/1.1`);
      const { alive, stderr } = await r.settled();
      assert.equal(alive, true, `the recorder process died: ${stderr.split('\n').find((l) => /Error/.test(l)) ?? ''}`);
      assert.match(answer, /^HTTP\/1\.1 400 /, 'the request is refused as a bad request');
      assert.equal(await r.validGet(), 's1', 'a valid, signed request is served afterwards');
      assert.deepEqual(tree(r.dir), before, 'nothing at all was written: no ledger, and no rejection line either');
    });
  }

  test('the same class of input: a body over the limit, and a client that goes away mid-body, change nothing and end nothing', async () => {
    const r = await recorder();
    const before = tree(r.dir);
    const send = (head, body, end) => new Promise((resolve) => {
      const s = net.connect(r.port, '127.0.0.1', () => { s.write(head); s.write(body, () => { if (end) s.destroy(); }); });
      s.on('error', () => {}); s.on('close', resolve); setTimeout(() => s.destroy(), 1500);
    });
    await send('POST /runs/s1/event HTTP/1.1\r\nhost: x\r\ncontent-length: 3000000\r\n\r\n', Buffer.alloc(2_000_000, 0x61), false); // over 1 MiB
    await send('POST /runs/s1/event HTTP/1.1\r\nhost: x\r\ncontent-length: 5000\r\n\r\n', Buffer.alloc(100, 0x61), true);            // disconnects after 100 of 5000 bytes
    assert.equal((await r.settled()).alive, true, 'the recorder process died');
    assert.equal(await r.validGet(), 's1');
    assert.deepEqual(tree(r.dir), before, 'neither request was handled, so nothing was written');
  });

  test('a handler error that nothing foresaw is answered 500 and named on stderr, never swallowed and never fatal', async () => {
    // The run's record is made unreadable after the server knows the run: every handler then fails on reading it.
    const r = await recorder();
    assert.equal(await r.validGet(), 's1');
    fs.writeFileSync(path.join(r.dir, 'runs', 's1', 'run.json'), '{not json');
    const err = await r.call('GET', '/runs/s1').then(() => null, (e) => e);
    assert.equal(err?.status, 500);
    const { alive, stderr } = await r.settled();
    assert.equal(alive, true);
    assert.match(stderr, /recorder: a request could not be handled \(SyntaxError/, 'the operator can see that it happened');
  });

  test('a cycle does not START while one of the run\'s ledgers ends in a fragment: the damage is found before a cycle depends on it', async () => {
    const r = await recorder();
    const pg = '7400000000000000003';
    await r.call('POST', '/runs/s1/event', { kind: 'volume_claimed', volume: { pgSystemId: pg, publicRelations: 0, stateEntries: 0, walLsnBytes: 1, serverVersion: '16.14' } });
    await r.call('POST', '/runs/s1/event', { kind: 'initialised', installationId: 'inst-1' });
    const start = () => r.call('POST', '/runs/s1/cycles/1/start', { pgSystemId: pg, proc: 'a', workers: 1, dbHead: 0, sizing: { maxSeconds: 600 }, vet: true }).then((x) => x.data, (e) => `${e.status} ${e.data?.refused ?? e.data?.error}`);
    assert.deepEqual(await start(), { vetted: true });
    fs.writeFileSync(runRejections(r.dir), FRAGMENT);
    assert.equal(await start(), '500 recorder_ledger_ends_in_a_fragment: runs/s1/rejections.jsonl', 'refused (and the refusal itself could only be kept as an event)');
    fs.rmSync(runRejections(r.dir)); // (a test may; an operator never edits a ledger)
    // The recorder-wide rejection log is unauthenticated noise, not this run's record: it stops no cycle (verify-dir
    // still reports it). The volume registry does.
    fs.writeFileSync(globalRejections(r.dir), FRAGMENT);
    assert.deepEqual(await start(), { vetted: true });
    fs.appendFileSync(path.join(r.dir, 'volumes.jsonl'), '{"frag');
    assert.equal(await start(), '409 recorder_ledger_ends_in_a_fragment: volumes.jsonl');
  });

  test('defect 2: an unsigned request while the run\'s rejection log ends in a fragment is answered, and the server keeps serving', async () => {
    const r = await recorder((d) => fs.writeFileSync(runRejections(d), `{"reason":"earlier"}\n${FRAGMENT}`));
    const before = fs.readFileSync(runRejections(r.dir));
    const answer = await r.raw('GET /runs/s1 HTTP/1.1'); // what `p7.mjs netcheck` sends on purpose at every preflight and cycle start
    const { alive, stderr } = await r.settled();
    assert.equal(alive, true, `the recorder process died: ${stderr.split('\n').find((l) => /Error/.test(l)) ?? ''}`);
    assert.match(answer, /^HTTP\/1\.1 401 /, 'still refused as unauthenticated: the network check expects exactly 401');
    assert.equal(await r.validGet(), 's1');
    assert.ok(fs.readFileSync(runRejections(r.dir)).equals(before), 'the damaged log is left byte for byte as it was');
  });

  test('defect 2: the same for the recorder-wide rejection log (unknown path, unknown run)', async () => {
    for (const line of ['GET /nothing HTTP/1.1', 'GET /runs/no-such-run HTTP/1.1']) {
      const r = await recorder((d) => fs.writeFileSync(globalRejections(d), FRAGMENT));
      const answer = await r.raw(line);
      const { alive, stderr } = await r.settled();
      assert.equal(alive, true, `${line}: the recorder process died: ${stderr.split('\n').find((l) => /Error/.test(l)) ?? ''}`);
      assert.match(answer, /^HTTP\/1\.1 404 /);
      assert.equal(fs.readFileSync(globalRejections(r.dir), 'utf8'), FRAGMENT);
      r.stop();
    }
  });

  test('defect 2: an AUTHENTICATED request with a malformed body, with the log ending in a fragment, does not end the process either', async () => {
    const r = await recorder((d) => fs.writeFileSync(runRejections(d), FRAGMENT));
    const headers = signRequest(r.key, { method: 'POST', path: '/runs/s1/event', run: 's1', body: '{not json' });
    const answer = await fetch(`http://127.0.0.1:${r.port}/runs/s1/event`, { method: 'POST', headers, body: '{not json', signal: AbortSignal.timeout(3000) }).then(async (x) => ({ status: x.status, body: await x.json() }), (e) => ({ status: `no answer (${e.cause?.code ?? e.name})` }));
    const { alive } = await r.settled();
    assert.equal(alive, true, 'the recorder process died');
    assert.deepEqual(answer, { status: 500, body: { error: 'refusal_not_recorded', refused: 'malformed_body', fallback: 'event' } });
  });

  test('defect 2: a rejection log that cannot be written at all (read-only file) does not end the process', async () => {
    const r = await recorder((d) => { fs.writeFileSync(runRejections(d), ''); fs.chmodSync(runRejections(d), 0o444); });
    assert.match(await r.raw('GET /runs/s1 HTTP/1.1'), /^HTTP\/1\.1 401 /);
    assert.equal((await r.settled()).alive, true, 'the recorder process died');
    assert.equal(await r.validGet(), 's1');
  });
});

describe('evidence (these pass today and must keep passing): a damaged ledger is never rewritten, repaired or discarded', () => {
  test('defect 1: a request with an invalid target writes nothing at all', async () => {
    const r = await recorder();
    const before = tree(r.dir);
    await r.raw('GET http://[ HTTP/1.1');
    await r.settled();
    assert.deepEqual(tree(r.dir), before);
  });

  test('defect 2: the fragment survives a rejected request and a restart byte for byte, and a valid request is served after the restart', async () => {
    const content = `{"reason":"earlier"}\n${FRAGMENT}`;
    const r = await recorder((d) => fs.writeFileSync(runRejections(d), content));
    const before = tree(r.dir);
    await r.raw('GET /runs/s1 HTTP/1.1');
    await r.settled();
    assert.deepEqual(tree(r.dir), before, 'nothing in the directory changed: no line added, none removed, no file rewritten');
    const again = await r.start(); // the operator starts `serve` again
    assert.equal(await again.validGet(), 's1', 'reading skips the fragment; earlier records are still read');
    assert.equal(fs.readFileSync(runRejections(r.dir), 'utf8'), content);
  });

  test('what "fragment" means: only a final line without its newline. An empty log is fine; a complete line that is not a record is an error, not a crash', async () => {
    const empty = await recorder((d) => fs.writeFileSync(runRejections(d), ''));
    assert.match(await empty.raw('GET /runs/s1 HTTP/1.1'), /^HTTP\/1\.1 401 /);
    assert.equal((await empty.settled()).alive, true);
    assert.equal(fs.readFileSync(runRejections(empty.dir), 'utf8').trim().split('\n').length, 1, 'the rejection was logged');

    const garbage = await recorder((d) => fs.writeFileSync(runRejections(d), 'not a record\n'));
    assert.match(await garbage.raw('GET /runs/s1 HTTP/1.1'), /^HTTP\/1\.1 500 /);
    assert.equal((await garbage.settled()).alive, true);
    assert.equal(fs.readFileSync(runRejections(garbage.dir), 'utf8'), 'not a record\n', 'left as it is');
    assert.match(await garbage.validGet(), /^failed: /, 'and every request for that run now fails, valid ones included: the run is unusable, visibly');
  });

  test('a fragment at the end of the run\'s EVENT ledger: a valid write is refused with a signed error, nothing is appended, reads still work', async () => {
    const r = await recorder((d) => fs.appendFileSync(path.join(d, 'runs', 's1', 'events.jsonl'), '{"kind":"netch'));
    const before = tree(r.dir);
    const err = await r.call('POST', '/runs/s1/event', { kind: 'netcheck', detail: 'x' }).then(() => null, (e) => e);
    assert.equal(err?.status, 500);
    assert.match(err.data.error, /ends in an incomplete line: nothing was appended/);
    assert.equal((await r.settled()).alive, true);
    assert.deepEqual(tree(r.dir), before);
    assert.equal(await r.validGet(), 's1');
  });

  test('an authenticated refusal that cannot be written to the rejection log: refused, said NOT to be recorded there, and kept as an event instead', async () => {
    const r = await recorder((d) => fs.writeFileSync(runRejections(d), FRAGMENT));
    const eventsBefore = runStore(r.dir, 's1').events().length;
    const err = await r.call('POST', '/runs/s1/event', { kind: 'no-such-kind' }).then(() => null, (e) => e);
    // Not the 400 invalid_event it would otherwise be: the answer never passes for a refusal that was recorded as usual.
    assert.deepEqual([err?.status, err?.data], [500, { error: 'refusal_not_recorded', refused: 'invalid_event', fallback: 'event' }]);
    assert.equal((await r.settled()).alive, true);
    assert.equal(fs.readFileSync(runRejections(r.dir), 'utf8'), FRAGMENT, 'the damaged log is as it was');
    const added = runStore(r.dir, 's1').events().slice(eventsBefore);
    assert.deepEqual(added.map((e) => [e.kind, e.reason, e.authenticated]), [['refusal_not_recorded', 'invalid_event', true]], 'one line in the run\'s event ledger says what was refused');
    assert.match(added[0].nonce, /^[0-9a-f]{32}$/, 'with its nonce, so the request cannot be replayed after a restart');
  });

  test('that event still counts against its cycle: the refusal is not lost as a reason for INCONCLUSIVE', async () => {
    const r = await recorder();
    const pg = '7400000000000000001';
    await r.call('POST', '/runs/s1/event', { kind: 'volume_claimed', volume: { pgSystemId: pg, publicRelations: 0, stateEntries: 0, walLsnBytes: 1, serverVersion: '16.14' } });
    await r.call('POST', '/runs/s1/event', { kind: 'initialised', installationId: 'inst-1' });
    const { cycleId } = (await r.call('POST', '/runs/s1/cycles/1/start', { pgSystemId: pg, proc: 'a', workers: 1, dbHead: 0, sizing: { maxSeconds: 600 } })).data;
    assert.match(cycleId, /^[0-9a-f]{32}$/);
    assert.equal(cycleView(runStore(r.dir, 's1'), 1).authenticatedRejections, 0);
    fs.writeFileSync(runRejections(r.dir), FRAGMENT); // the rejection log is damaged while the cycle is open
    const refused = await r.call('POST', '/runs/s1/ack', { cycle: 1, cycleId: 'f'.repeat(32), proc: 'a', worker: 1, n: 1, kind: 'claim', seq: 1, actionId: 'x' }).then(() => null, (e) => e);
    assert.deepEqual([refused?.status, refused?.data], [500, { error: 'refusal_not_recorded', refused: 'wrong_cycle_id', fallback: 'event' }]);
    assert.equal(cycleView(runStore(r.dir, 's1'), 1).authenticatedRejections, 1, 'counted from the event ledger');
    assert.equal(runStore(r.dir, 's1').acks(1).length, 0, 'and nothing was accepted');
  });

  test('when the event ledger cannot be written either: the answer says so, and the open cycle accepts nothing more from this server', async () => {
    const r = await recorder();
    const pg = '7400000000000000002';
    await r.call('POST', '/runs/s1/event', { kind: 'volume_claimed', volume: { pgSystemId: pg, publicRelations: 0, stateEntries: 0, walLsnBytes: 1, serverVersion: '16.14' } });
    await r.call('POST', '/runs/s1/event', { kind: 'initialised', installationId: 'inst-1' });
    const { cycleId } = (await r.call('POST', '/runs/s1/cycles/1/start', { pgSystemId: pg, proc: 'a', workers: 1, dbHead: 0, sizing: { maxSeconds: 600 } })).data;
    const events = path.join(r.dir, 'runs', 's1', 'events.jsonl');
    fs.writeFileSync(runRejections(r.dir), FRAGMENT);
    fs.appendFileSync(events, '{"kind":"frag');
    const before = tree(r.dir);
    const refused = await r.call('POST', '/runs/s1/ack', { cycle: 1, cycleId: 'f'.repeat(32), proc: 'a', worker: 1, n: 1, kind: 'claim', seq: 1, actionId: 'x' }).then(() => null, (e) => e);
    assert.deepEqual([refused?.status, refused?.data], [500, { error: 'refusal_not_recorded', refused: 'wrong_cycle_id', fallback: 'none' }]);
    // A perfectly valid acknowledgement is no longer accepted in this cycle: the refusal nobody could record must not
    // be followed by a cycle that looks clean.
    const { runTag } = await import('../lib/protocol.mjs');
    const valid = await r.call('POST', '/runs/s1/ack', { cycle: 1, cycleId, proc: 'a', worker: 1, n: 1, kind: 'claim', seq: 1, actionId: `${runTag('s1')}c0001aw1-1` }).then(() => null, (e) => e);
    assert.equal(valid?.status, 500);
    assert.equal(valid.data.refused, 'recorder_ack_file_damaged');
    // And this server does not store a PASS for that cycle. (The flag is in memory: a restarted server no longer has
    // it; `verify-dir` and the refused start are what remain then.)
    const pass = await r.call('POST', '/runs/s1/cycles/1/result', { cycleId, verdict: 'PASS', needsRecovery: [] }).then(() => null, (e) => e);
    assert.equal(pass?.data.refused, 'pass_for_a_cycle_the_recorder_marked_damaged');
    assert.equal((await r.settled()).alive, true);
    assert.deepEqual(tree(r.dir), before, 'no ledger changed');
  });

  test('verify-dir names a ledger that ends in a fragment, instead of reading past it silently', async () => {
    const r = await recorder((d) => fs.writeFileSync(runRejections(d), `{"reason":"earlier"}\n${FRAGMENT}`));
    fs.writeFileSync(globalRejections(r.dir), FRAGMENT);
    const problems = dirReport(r.dir).problems.join(' | ');
    assert.match(problems, /runs\/s1\/rejections\.jsonl ends in an incomplete line/);
    assert.match(problems, /(^| )rejections\.jsonl ends in an incomplete line/);
    const clean = await recorder();
    assert.deepEqual(dirReport(clean.dir).problems, []);
  });
});
