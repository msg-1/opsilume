#!/usr/bin/env node
// P7 acknowledgement recorder. Runs on a host OTHER than the machine under test (never on its switched outlet).
// It stores each acknowledgement with fsync BEFORE replying, so an acknowledged claim is one the recorder holds.
// It also holds the run's failure model (fixed at creation), the cut times (its own clock), the cycle results and
// the stop marker: a FAIL stops the run and every later start or acknowledgement is refused.
// Plain Node (no dependencies). Synthetic data only; it never contacts a remediation destination.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { appendDurable, fsyncDir, readLedger, writeOnce } from './lib/ledger.mjs';
import { FAILURE_MODELS, physicalStreak } from './lib/verdict.mjs';

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const isCycle = (n) => Number.isInteger(n) && n >= 1 && n <= 10000;
const pad = (n) => String(n).padStart(4, '0');

export function runStore(dir, run) {
  if (!RUN_ID.test(run)) throw Object.assign(new Error('invalid run id'), { status: 400 });
  const root = path.join(dir, 'runs', run);
  const f = (name) => path.join(root, name);
  const store = {
    root,
    exists: () => fs.existsSync(f('run.json')),
    run: () => JSON.parse(fs.readFileSync(f('run.json'), 'utf8')),
    stopped: () => (fs.existsSync(f('STOPPED.json')) ? JSON.parse(fs.readFileSync(f('STOPPED.json'), 'utf8')) : null),
    events: () => readLedger(f('events.jsonl')).entries,
    acks: () => readLedger(f('acks.jsonl')).entries,
    accepted: () => readLedger(f('accepted.jsonl')).entries,
    result: (n) => (fs.existsSync(f(`results/cycle-${pad(n)}.json`)) ? JSON.parse(fs.readFileSync(f(`results/cycle-${pad(n)}.json`), 'utf8')) : null),
    results: () => (fs.existsSync(f('results')) ? fs.readdirSync(f('results')).sort().map((x) => JSON.parse(fs.readFileSync(f(`results/${x}`), 'utf8'))) : []),
    event: (e) => appendDurable(f('events.jsonl'), { ...e, at: new Date().toISOString(), atMs: Date.now() }),
    ack: (a) => appendDurable(f('acks.jsonl'), { ...a, at: new Date().toISOString() }),
    accept: (u) => appendDurable(f('accepted.jsonl'), { ...u, at: new Date().toISOString() }),
    stop: (s) => { if (!store.stopped()) writeOnce(f('STOPPED.json'), { ...s, at: new Date().toISOString() }); },
    saveResult: (n, r) => { fs.mkdirSync(f('results'), { recursive: true }); writeOnce(f(`results/cycle-${pad(n)}.json`), r); },
    create: (meta) => {
      fs.mkdirSync(root, { recursive: true });
      writeOnce(f('run.json'), meta);
      fsyncDir(path.dirname(root));
    },
  };
  return store;
}

/** Everything the test machine needs to judge a cycle, as recorded on THIS host and by its clock. */
export function cycleView(s, n) {
  const events = s.events().filter((e) => e.cycle === n);
  const cut = events.find((e) => e.kind === 'cut_sent');
  const confirm = events.filter((e) => e.kind === 'cut_confirmed').at(-1);
  return {
    cycle: n,
    starts: events.filter((e) => e.kind === 'cycle_start'),
    acks: s.acks().filter((a) => a.cycle === n),
    events,
    cutSentAt: cut?.at ?? null,
    cutConfirmed: confirm?.powerWasCut,
    // A worker that stopped before the cut means the crash didn't land on a running workload.
    workerStopsBeforeCut: events.filter((e) => e.kind === 'worker_stopped' && (!cut || e.atMs < cut.atMs)),
    recovered: events.some((e) => e.kind === 'recovered'),
    result: s.result(n),
  };
}

function startRefusal(s, n) {
  if (s.stopped()) return 'the run is stopped after a failure';
  if (s.result(n)) return `cycle ${n} has already been checked`;
  if (n > 1) {
    const prev = cycleView(s, n - 1);
    if (!prev.result) return `cycle ${n - 1} has not been checked`;
    if (prev.result.verdict === 'FAIL') return `cycle ${n - 1} failed`;
    if (prev.result.needsRecovery?.length && !prev.recovered) return `cycle ${n - 1} needs recovery first (${prev.result.needsRecovery.join(', ')})`;
  }
  if (s.events().some((e) => e.cycle === n && e.kind === 'cut_sent')) return `cycle ${n} has already been cut`;
  return null;
}

export function createRecorder(dir) {
  return http.createServer((req, res) => {
    const reply = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body ?? {}));
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > 1 << 20) req.destroy(); });
    req.on('end', () => {
      try {
        const m = /^\/runs\/([^/]+)(?:\/(.*))?$/.exec(new URL(req.url, 'http://x').pathname);
        if (!m) return reply(404, { error: 'not found' });
        const s = runStore(dir, m[1]);
        if (!s.exists()) return reply(404, { error: 'unknown run' });
        const rest = m[2] ?? '';
        const body = raw ? JSON.parse(raw) : {};
        const cm = /^cycles\/(\d+)(?:\/(start|result|recovered))?$/.exec(rest);
        const n = cm ? Number(cm[1]) : body.cycle;
        if (req.method === 'GET' && rest === '') {
          const results = s.results();
          return reply(200, { run: s.run(), stopped: s.stopped(), accepted: s.accepted(), results: results.map((r) => ({ cycle: r.cycle, verdict: r.verdict, countsTowardPhysicalPowerLoss: r.countsTowardPhysicalPowerLoss })), streak: physicalStreak(results) });
        }
        if (req.method === 'GET' && cm && !cm[2]) return reply(200, cycleView(s, n));
        if (req.method !== 'POST') return reply(405, { error: 'method not allowed' });
        if ((cm || ['ack', 'event'].includes(rest)) && !isCycle(n)) return reply(400, { error: 'invalid cycle' });
        if (cm?.[2] === 'start') {
          const why = startRefusal(s, n);
          if (why) return reply(409, { error: why });
          s.event({ cycle: n, kind: 'cycle_start', proc: String(body.proc ?? ''), dbHead: body.dbHead, journalHead: body.journalHead, workers: body.workers, settings: body.settings });
          return reply(200, { ok: true });
        }
        if (rest === 'ack') {
          if (s.stopped()) return reply(409, { error: 'the run is stopped' });
          if (!['claim', 'dispatch'].includes(body.kind) || !Number.isInteger(body.seq) || typeof body.actionId !== 'string') return reply(400, { error: 'invalid acknowledgement' });
          const v = cycleView(s, n);
          // Accepted after `cut_sent` too: the power may take a moment to go (a manual cut), and the machine is still running.
          if (!v.starts.length || v.result) return reply(409, { error: 'cycle not accepting acknowledgements' });
          s.ack({ cycle: n, kind: body.kind, seq: body.seq, actionId: body.actionId, proc: String(body.proc ?? ''), worker: body.worker });
          return reply(200, { ok: true }); // sent only after the fsync above
        }
        if (rest === 'event') {
          if (typeof body.kind !== 'string' || body.kind.length > 64 || ['cycle_start', 'cut_sent', 'cut_confirmed', 'recovered'].includes(body.kind)) return reply(400, { error: 'invalid event' });
          s.event({ cycle: n, kind: body.kind, detail: String(body.detail ?? '').slice(0, 300), proc: String(body.proc ?? ''), worker: body.worker });
          return reply(200, { ok: true });
        }
        if (cm?.[2] === 'result') {
          if (s.result(n)) return reply(409, { error: 'result already recorded' });
          if (!['PASS', 'FAIL', 'INCONCLUSIVE'].includes(body.verdict)) return reply(400, { error: 'invalid verdict' });
          s.saveResult(n, { ...body, cycle: n, recordedAt: new Date().toISOString() });
          if (body.verdict === 'FAIL') s.stop({ cycle: n, reason: 'cycle failed', fails: body.fails });
          return reply(200, { ok: true, stopped: !!s.stopped() });
        }
        if (cm?.[2] === 'recovered') {
          const v = cycleView(s, n);
          if (!v.result || v.result.verdict === 'FAIL' || s.stopped()) return reply(409, { error: 'nothing to recover' });
          if (body.uncommitted) s.accept({ cycle: n, seq: body.uncommitted.seq, actionId: body.uncommitted.actionId, digest: body.digest });
          s.event({ cycle: n, kind: 'recovered', steps: body.steps });
          return reply(200, { ok: true });
        }
        if (rest === 'stop') {
          s.stop({ cycle: n ?? null, reason: String(body.reason ?? 'stopped').slice(0, 300) });
          return reply(200, { ok: true });
        }
        return reply(404, { error: 'not found' });
      } catch (e) {
        return reply(e.status ?? (e instanceof SyntaxError ? 400 : 500), { error: String(e.message).slice(0, 200) });
      }
    });
  });
}

// ───────────────────────────── operator commands (run on the recorder host) ─────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const { values: a } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string' }, run: { type: 'string' }, cycle: { type: 'string' }, host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '8787' },
      'failure-model': { type: 'string' }, 'write-cache': { type: 'string' }, 'flush-honoured': { type: 'string' }, plp: { type: 'string' }, machine: { type: 'string' }, operator: { type: 'string' },
      'min-seconds': { type: 'string' }, 'max-seconds': { type: 'string' }, 'command-json': { type: 'string' }, 'power-was-cut': { type: 'string' }, note: { type: 'string' },
    },
  });
  if (!a.dir) throw new Error('--dir is required');
  if (cmd === 'serve') {
    createRecorder(a.dir).listen(Number(a.port), a.host, () => console.log(`P7 recorder on http://${a.host}:${a.port}, storing in ${a.dir}`));
    return;
  }
  const s = runStore(a.dir, a.run ?? '');
  const n = Number(a.cycle);
  if (cmd === 'create-run') {
    if (!FAILURE_MODELS.includes(a['failure-model'])) throw new Error(`--failure-model must be one of ${FAILURE_MODELS.join(', ')}`);
    if (s.exists()) throw new Error('run already exists');
    const yn = (v) => (['yes', 'no'].includes(v) ? v : 'unknown');
    s.create({
      run: a.run, failureModel: a['failure-model'], createdAt: new Date().toISOString(), machine: a.machine ?? null, operator: a.operator ?? null,
      // Operator's attestation from the recorded evidence. Anything but writeCache known AND flushHonoured 'yes' makes every cycle INCONCLUSIVE.
      storage: { writeCache: ['write back', 'write through'].includes(a['write-cache']) ? a['write-cache'] : 'unknown', flushHonoured: yn(a['flush-honoured']), plp: yn(a.plp) },
    });
    console.log(JSON.stringify(s.run(), null, 2));
  } else if (cmd === 'cut') {
    if (!s.exists() || !isCycle(n)) throw new Error('unknown run or cycle');
    if (s.stopped()) throw new Error('run is stopped');
    const v = cycleView(s, n);
    if (!v.starts.length) throw new Error(`cycle ${n} has not started`);
    if (v.cutSentAt) throw new Error(`cycle ${n} was already cut`);
    const lo = Math.round(Number(a['min-seconds']) * 1000), hi = Math.round(Number(a['max-seconds']) * 1000);
    if (!(lo >= 0 && hi >= lo)) throw new Error('--min-seconds and --max-seconds are required');
    const delayMs = randomInt(lo, hi + 1);
    s.event({ cycle: n, kind: 'cut_scheduled', delayMs });
    console.log(`cycle ${n}: cut in ${(delayMs / 1000).toFixed(1)} s`);
    await sleep(delayMs);
    const cmdArgv = a['command-json'] ? JSON.parse(a['command-json']) : null;
    s.event({ cycle: n, kind: 'cut_sent', how: cmdArgv ? 'command' : 'manual prompt' });
    if (cmdArgv) {
      // The command line itself is not recorded (a plug's local URL may carry a token); only its exit status.
      const r = spawnSync(cmdArgv[0], cmdArgv.slice(1), { timeout: 30_000, stdio: 'ignore' });
      s.event({ cycle: n, kind: 'cut_command_finished', status: r.status, error: r.error ? String(r.error.code ?? 'error') : null });
      console.log(`cut command exited with ${r.status}`);
    } else console.log('\n*** CUT THE POWER NOW ***\n');
    console.log(`After the machine is back, confirm: recorder.mjs confirm-cut --dir ${a.dir} --run ${a.run} --cycle ${n} --power-was-cut yes|no`);
  } else if (cmd === 'confirm-cut') {
    if (!['yes', 'no'].includes(a['power-was-cut'])) throw new Error('--power-was-cut yes|no');
    if (!cycleView(s, n).cutSentAt) throw new Error('no cut recorded for this cycle');
    s.event({ cycle: n, kind: 'cut_confirmed', powerWasCut: a['power-was-cut'], note: (a.note ?? '').slice(0, 300) });
  } else if (cmd === 'status') {
    const results = s.results();
    console.log(JSON.stringify({ run: s.run(), stopped: s.stopped(), cycles: results.map((r) => [r.cycle, r.verdict, r.failureModel]), streak: physicalStreak(results) }, null, 2));
  } else throw new Error('commands: serve, create-run, cut, confirm-cut, status');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(String(e.message)); process.exit(1); });
