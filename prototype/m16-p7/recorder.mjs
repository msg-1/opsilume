#!/usr/bin/env node
// P7 acknowledgement recorder. Runs on a host OTHER than the machine under test (never on its switched outlet).
// - Every request is authenticated (lib/protocol.mjs): per-run key, HMAC, timestamp window, single-use nonce. Every
//   response is MACed. Rejections are logged (without secrets) and an authenticated rejection makes its cycle INCONCLUSIVE.
// - Each acknowledgement belongs to the run's open cycle (recorder-issued cycle id) and to one ordered stream per
//   (process, worker); duplicates, replays, out-of-order and mismatched acknowledgements are refused. An accepted
//   acknowledgement is on disk (one write, fsync) BEFORE the reply.
// - It holds the failure model, the storage attestation, the cut times (its own clock), results, recoveries and the stop
//   marker. FAIL stops the run; in a POWER-CUT or VM-CRASH run so does INCONCLUSIVE (decision 1: a new series is a new run).
// Plain Node, no dependencies. Synthetic data only; it never contacts a remediation destination. NOT production code.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { appendDurable, fsyncDir, readLedger, writeOnce } from './lib/ledger.mjs';
import { WINDOW_MS, keyFromHex, newKeyHex, nextStream, signResponse, streamKey, verifyRequest } from './lib/protocol.mjs';
import { FAILURE_MODELS, QUALIFYING_MODELS, finalStatus, physicalStreak, storageQualifies } from './lib/verdict.mjs';

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const isCycle = (n) => Number.isInteger(n) && n >= 1 && n <= 10000;
const pad = (n) => String(n).padStart(4, '0');
export const SILENT_STOP_MS = 10_000; // a stream with no acknowledgement for this long before the cut had stopped
const EVENT_KINDS = ['worker_stopped', 'initialised', 'quarantine_observed', 'netcheck'];

export function runStore(dir, run) {
  if (!RUN_ID.test(run ?? '')) throw Object.assign(new Error('invalid run id'), { status: 400 });
  const root = path.join(dir, 'runs', run);
  const f = (name) => path.join(root, name);
  const store = {
    root,
    keyFile: path.join(dir, 'keys', `${run}.key`),
    exists: () => fs.existsSync(f('run.json')),
    run: () => JSON.parse(fs.readFileSync(f('run.json'), 'utf8')),
    stopped: () => (fs.existsSync(f('STOPPED.json')) ? JSON.parse(fs.readFileSync(f('STOPPED.json'), 'utf8')) : null),
    events: () => readLedger(f('events.jsonl')).entries,
    ackFile: (n) => readLedger(f(`acks/cycle-${pad(n)}.jsonl`)),
    acks: (n) => readLedger(f(`acks/cycle-${pad(n)}.jsonl`)).entries,
    accepted: () => readLedger(f('accepted.jsonl')).entries,
    rejections: () => readLedger(f('rejections.jsonl')).entries,
    result: (n) => (fs.existsSync(f(`results/cycle-${pad(n)}.json`)) ? JSON.parse(fs.readFileSync(f(`results/cycle-${pad(n)}.json`), 'utf8')) : null),
    results: () => (fs.existsSync(f('results')) ? fs.readdirSync(f('results')).sort().map((x) => JSON.parse(fs.readFileSync(f(`results/${x}`), 'utf8'))) : []),
    event: (e) => appendDurable(f('events.jsonl'), { ...e, at: new Date().toISOString(), atMs: Date.now() }),
    ack: (a) => { fs.mkdirSync(f('acks'), { recursive: true }); appendDurable(f(`acks/cycle-${pad(a.cycle)}.jsonl`), { ...a, at: new Date().toISOString(), atMs: Date.now() }); },
    reject: (r) => appendDurable(f('rejections.jsonl'), { ...r, at: new Date().toISOString(), atMs: Date.now() }),
    accept: (u) => appendDurable(f('accepted.jsonl'), { ...u, at: new Date().toISOString() }),
    stop: (s) => { if (!store.stopped()) writeOnce(f('STOPPED.json'), { ...s, at: new Date().toISOString() }); },
    saveResult: (n, r) => { fs.mkdirSync(f('results'), { recursive: true }); writeOnce(f(`results/cycle-${pad(n)}.json`), r); },
    create: (meta) => { fs.mkdirSync(root, { recursive: true }); writeOnce(f('run.json'), meta); fsyncDir(path.dirname(root)); },
  };
  return store;
}

/** Operator command (recorder host). Decision 4: a qualifying run with unknown flush or FUA behaviour is refused. */
export function createRun(dir, o) {
  if (!FAILURE_MODELS.includes(o.failureModel)) throw new Error(`failure model must be one of ${FAILURE_MODELS.join(', ')}`);
  const s = runStore(dir, o.run);
  if (s.exists() || fs.existsSync(s.keyFile)) throw new Error('run already exists');
  const pick = (v, allowed) => (allowed.includes(v) ? v : 'unknown');
  const storage = {
    writeCache: pick(o.writeCache, ['write back', 'write through']),
    flushHonoured: pick(o.flushHonoured, ['yes', 'no']),
    fua: pick(o.fua, ['yes', 'no', 'not-advertised']),
    plp: pick(o.plp, ['yes', 'no']),
    attestedBy: 'operator, from the recorded device evidence',
  };
  if (QUALIFYING_MODELS.includes(o.failureModel) && !storageQualifies(storage)) {
    throw new Error('refused: flush or FUA behaviour is not verified (write cache known, flush honoured "yes", FUA "yes" or "not-advertised"). Qualifying cycles must not run (decision 4)');
  }
  fs.mkdirSync(path.dirname(s.keyFile), { recursive: true, mode: 0o700 });
  writeOnce(s.keyFile, `${newKeyHex()}\n`);
  fs.chmodSync(s.keyFile, 0o600);
  s.create({ run: o.run, failureModel: o.failureModel, createdAt: new Date().toISOString(), machine: o.machine ?? null, operator: o.operator ?? null, storage, protocol: 'P7-REQ-1/P7-RES-1 HMAC-SHA256' });
  return { run: s.run(), keyFile: s.keyFile };
}

const startsOf = (events, n) => events.filter((e) => e.cycle === n && e.kind === 'cycle_start');
function openCycle(s, events = s.events()) {
  const started = [...new Set(events.filter((e) => e.kind === 'cycle_start').map((e) => e.cycle))].sort((a, b) => a - b);
  const last = started.at(-1) ?? 0;
  return { last, open: last && !s.result(last) ? last : null };
}
function recoveryOf(events, n) {
  const rec = events.find((e) => e.cycle === n && e.kind === 'recovered');
  return rec ? { ...rec, quarantineObserved: events.some((e) => e.cycle === n && e.kind === 'quarantine_observed') } : null;
}

/** Everything about one cycle as recorded on THIS host and by its clock. */
export function cycleView(s, n, { silentStopMs = SILENT_STOP_MS } = {}) {
  const events = s.events().filter((e) => e.cycle === n);
  const starts = startsOf(events, n);
  const acks = s.acks(n);
  const cut = events.find((e) => e.kind === 'cut_sent');
  const confirm = events.filter((e) => e.kind === 'cut_confirmed').at(-1);
  const lastByStream = new Map();
  for (const a of acks) lastByStream.set(streamKey(a), a.atMs);
  const silentWorkerStops = cut ? starts.flatMap((st) => Array.from({ length: st.workers }, (_, i) => ({ proc: st.proc, worker: i + 1 })))
    .filter((w) => !((lastByStream.get(`${w.proc}/${w.worker}`) ?? 0) >= cut.atMs - silentStopMs))
    .map((w) => ({ ...w, lastAckAtMs: lastByStream.get(`${w.proc}/${w.worker}`) ?? null })) : [];
  const result = s.result(n);
  const recovered = recoveryOf(events, n);
  const boots = events.filter((e) => e.kind === 'boot_report');
  const last = acks.at(-1);
  return {
    run: s.run().run,
    cycle: n,
    cycleId: starts[0]?.cycleId ?? null,
    failureModel: s.run().failureModel,
    starts,
    acks,
    events,
    lastDurableAck: last ? { seq: last.seq, kind: last.kind, proc: last.proc, worker: last.worker, at: last.at, atMs: last.atMs } : null,
    cutRequestedAt: cut?.at ?? null,
    cutRequestedAtMs: cut?.atMs ?? null,
    cutHow: cut?.how ?? null,
    cutCommandStatus: events.find((e) => e.kind === 'cut_command_finished')?.status ?? null,
    cutConfirmed: confirm?.powerWasCut,
    operatorEvidence: confirm?.operatorEvidence ?? null,
    // Nothing on this host observes the cut itself; the cut lies between the last acknowledgement and the first contact after it.
    independentlyObservedCutAt: null,
    firstContactAfterCut: cut ? (boots.find((b) => b.atMs > cut.atMs) ?? null) : null,
    bootReports: boots,
    workerStopsBeforeCut: events.filter((e) => e.kind === 'worker_stopped' && (!cut || e.atMs < cut.atMs)),
    silentWorkerStops,
    // Only refusals after the cycle began count against it: a refused start (e.g. a forgotten recover) must not poison the cycle.
    authenticatedRejections: starts.length ? s.rejections().filter((r) => r.authenticated && r.cycle === n && r.atMs >= starts[0].atMs).length : 0,
    result,
    recovered,
    final: finalStatus(result, recovered),
  };
}

export function runStatus(s) {
  const events = s.events();
  const finals = s.results().map((r) => ({ cycle: r.cycle, verdict: r.verdict, status: finalStatus(r, recoveryOf(events, r.cycle)) }));
  const { run, ...rest } = s.run();
  return { run: { run, ...rest }, stopped: s.stopped(), accepted: s.accepted(), cycles: finals, streak: physicalStreak(finals, s.run().failureModel), rejections: s.rejections().length };
}

// ───────────────────────────────────────────── server ─────────────────────────────────────────────
export function createRecorder(dir, { now = () => Date.now(), silentStopMs = SILENT_STOP_MS } = {}) {
  const cache = new Map(); // run -> { key, nonces: Map(nonce -> ts), cycles: Map(n -> { streams, claimSeqs, damaged }) }
  const globalReject = (r) => { fs.mkdirSync(dir, { recursive: true }); appendDurable(path.join(dir, 'rejections.jsonl'), { ...r, at: new Date().toISOString() }); };

  function runState(s, run) {
    if (cache.has(run)) return cache.get(run);
    const key = keyFromHex(fs.readFileSync(s.keyFile, 'utf8'));
    // Rebuild the nonces accepted within the window from what was persisted (survives a recorder restart).
    const nonces = new Map();
    const t = now();
    const remember = (x) => { if (x?.nonce && Math.abs(t - Number(x.ts)) <= WINDOW_MS) nonces.set(x.nonce, Number(x.ts)); };
    const events = s.events();
    events.forEach(remember);
    s.rejections().forEach(remember);
    s.results().forEach(remember);
    const { open } = openCycle(s, events);
    if (open) s.ackFile(open).entries.forEach(remember);
    const st = { key, nonces, cycles: new Map() };
    cache.set(run, st);
    return st;
  }
  function cycleState(s, rs, n) {
    if (rs.cycles.has(n)) return rs.cycles.get(n);
    const { entries, tornBytes } = s.ackFile(n);
    const c = { streams: new Map(), claimSeqs: new Set(), damaged: tornBytes ? 'recorder acknowledgement file has a torn final line' : null };
    for (const a of entries) {
      const r = nextStream(c.streams.get(streamKey(a)), a, n);
      if (r.error) { c.damaged = `recorder acknowledgement file is inconsistent (${r.error})`; break; }
      c.streams.set(streamKey(a), r.st);
      if (a.kind === 'claim') c.claimSeqs.add(a.seq);
    }
    rs.cycles.set(n, c);
    return c;
  }

  return http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > 1 << 20) req.destroy(); });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const plain = (status, error) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error }));
      const info = { method: req.method, path: url.pathname.slice(0, 120), remote: req.socket.remoteAddress };
      const m = /^\/runs\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
      if (!m || !RUN_ID.test(m[1])) { globalReject({ ...info, reason: 'bad_path', authenticated: false }); return plain(404, 'not found'); }
      const run = m[1];
      const s = runStore(dir, run);
      if (!s.exists() || !fs.existsSync(s.keyFile)) { globalReject({ ...info, run, reason: 'unknown_run', authenticated: false }); return plain(404, 'unknown run'); }
      let rs;
      try { rs = runState(s, run); } catch { return plain(500, 'recorder key unreadable'); }
      const headers = req.headers;
      const why = verifyRequest(rs.key, { method: req.method, path: url.pathname, run, headers, body: raw, now: now(), seen: rs.nonces });
      const authenticated = why === null || why === 'stale_timestamp' || why === 'replayed_nonce';
      const nonce = headers['x-p7-nonce'];
      const ts = headers['x-p7-ts'];
      const reply = (status, obj) => {
        const body = JSON.stringify(obj ?? {});
        const time = String(now());
        res.writeHead(status, { 'content-type': 'application/json', 'x-p7-time': time, 'x-p7-mac': signResponse(rs.key, { nonce, status, body, time }) }).end(body);
      };
      let body = {};
      let malformed = false;
      try { body = raw ? JSON.parse(raw) : {}; } catch { malformed = true; }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) { body = {}; malformed = true; }
      const cycleOf = Number.isInteger(body?.cycle) ? body.cycle : Number(/^cycles\/(\d+)/.exec(m[2] ?? '')?.[1]) || null;
      const refuse = (status, reason) => {
        // Persisting the nonce with the rejection means even a refused request can't be replayed after a restart.
        s.reject({ ...info, run, reason, authenticated, cycle: cycleOf, ...(authenticated ? { nonce, ts } : {}) });
        return authenticated && why !== 'stale_timestamp' ? reply(status, { error: reason }) : plain(status, reason);
      };
      if (why) return refuse(401, why);
      rs.nonces.set(nonce, Number(ts));
      if (rs.nonces.size > 50_000) for (const [k, v] of rs.nonces) if (Math.abs(now() - v) > WINDOW_MS) rs.nonces.delete(k);
      if (malformed) return refuse(400, 'malformed_body');
      try {
        const rest = m[2] ?? '';
        const cm = /^cycles\/(\d+)(?:\/(start|result|recovered))?$/.exec(rest);
        const n = cm ? Number(cm[1]) : body.cycle;
        const stamp = { nonce, ts: Number(ts) };
        if (req.method === 'GET' && rest === '') return reply(200, runStatus(s));
        if (req.method === 'GET' && cm && !cm[2]) return isCycle(n) ? reply(200, cycleView(s, n, { silentStopMs })) : refuse(400, 'invalid_cycle');
        if (req.method !== 'POST') return refuse(405, 'method_not_allowed');
        const run0 = s.run();
        const events = s.events();
        const { last, open } = openCycle(s, events);

        if (cm?.[2] === 'start') {
          if (!isCycle(n)) return refuse(400, 'invalid_cycle');
          if (s.stopped()) return refuse(409, 'run_stopped');
          if (QUALIFYING_MODELS.includes(run0.failureModel) && !storageQualifies(run0.storage)) return refuse(409, 'storage_not_qualifying');
          if (!/^[a-z]$/.test(body.proc ?? '') || !Number.isInteger(body.workers) || body.workers < 1 || body.workers > 12 || !Number.isInteger(body.dbHead) || body.dbHead < 0) return refuse(400, 'invalid_start');
          if (open && open !== n) return refuse(409, `cycle_${open}_is_open`);
          if (!open && n !== last + 1) return refuse(409, 'cycles_must_be_consecutive');
          if (!open && n > 1) {
            const prev = cycleView(s, n - 1, { silentStopMs });
            if (!prev.recovered) return refuse(409, 'previous_cycle_not_recovered');
          }
          if (events.some((e) => e.cycle === n && e.kind === 'cut_sent')) return refuse(409, 'cycle_already_cut');
          if (startsOf(events, n).some((e) => e.proc === body.proc)) return refuse(409, 'process_already_started_in_cycle');
          const cycleId = startsOf(events, n)[0]?.cycleId ?? randomBytes(16).toString('hex');
          s.event({ cycle: n, kind: 'cycle_start', cycleId, proc: body.proc, workers: body.workers, dbHead: body.dbHead, journalHead: body.journalHead ?? null, settings: body.settings ?? null, bootId: String(body.bootId ?? '').slice(0, 64), clockOffsetMs: body.clockOffsetMs ?? null, ...stamp });
          return reply(200, { cycleId });
        }

        if (rest === 'ack') {
          if (s.stopped()) return refuse(409, 'run_stopped');
          if (!isCycle(n) || n !== open) return refuse(409, 'cycle_not_open');
          const starts = startsOf(events, n);
          if (body.cycleId !== starts[0]?.cycleId) return refuse(409, 'wrong_cycle_id');
          const started = starts.find((e) => e.proc === body.proc);
          if (!started || !Number.isInteger(body.worker) || body.worker < 1 || body.worker > started.workers) return refuse(409, 'stream_not_started');
          const c = cycleState(s, rs, n);
          if (c.damaged) return refuse(409, 'recorder_ack_file_damaged');
          const a = { cycle: n, cycleId: body.cycleId, proc: body.proc, worker: body.worker, n: body.n, kind: body.kind, seq: body.seq, actionId: body.actionId };
          if (!(a.seq > Math.min(...starts.map((e) => e.dbHead)))) return refuse(409, 'outside_cycle');
          const next = nextStream(c.streams.get(streamKey(a)), a, n);
          if (next.error) return refuse(409, next.error);
          if (a.kind === 'claim' && c.claimSeqs.has(a.seq)) return refuse(409, 'duplicate_claim_seq');
          s.ack({ ...a, ...stamp });
          c.streams.set(streamKey(a), next.st);
          if (a.kind === 'claim') c.claimSeqs.add(a.seq);
          return reply(200, { ok: true }); // only after the fsync in s.ack
        }

        if (rest === 'event') {
          if (!EVENT_KINDS.includes(body.kind)) return refuse(400, 'invalid_event');
          if (body.cycle !== null && body.cycle !== undefined) {
            if (!isCycle(n) || body.cycleId !== startsOf(events, n)[0]?.cycleId) return refuse(409, 'wrong_cycle_id');
          }
          if (body.kind === 'quarantine_observed') {
            const r = s.result(n);
            if (!r?.quarantineRequired || recoveryOf(events, n)) return refuse(409, 'no_quarantine_expected');
          }
          s.event({ cycle: body.cycle ?? null, cycleId: body.cycleId ?? null, kind: body.kind, detail: String(body.detail ?? '').slice(0, 500), proc: String(body.proc ?? ''), worker: body.worker ?? null, ...stamp });
          return reply(200, { ok: true });
        }

        if (rest === 'boot') {
          const fields = ['bootId', 'bootTime', 'containerStartedAt', 'postmasterStartedAt', 'databaseReachableAt'];
          const rec = Object.fromEntries(fields.map((k) => [k, typeof body[k] === 'string' || Number.isFinite(body[k]) ? body[k] : null]));
          s.event({ cycle: open ?? null, kind: 'boot_report', ...rec, clockOffsetMs: body.clockOffsetMs ?? null, ...stamp });
          return reply(200, { ok: true, cycle: open ?? null });
        }

        if (cm?.[2] === 'result') {
          if (!isCycle(n) || n !== open) return refuse(409, 'cycle_not_open');
          if (body.cycleId !== startsOf(events, n)[0]?.cycleId) return refuse(409, 'wrong_cycle_id');
          if (!['PASS', 'FAIL', 'INCONCLUSIVE'].includes(body.verdict)) return refuse(400, 'invalid_verdict');
          // The failure model comes from THIS host's run record, never from the test machine.
          s.saveResult(n, { ...body, cycle: n, failureModel: run0.failureModel, reportedFailureModel: body.failureModel ?? null, countsTowardPhysicalPowerLoss: false, recordedAt: new Date().toISOString(), ...stamp });
          if (body.verdict === 'FAIL') s.stop({ cycle: n, reason: 'cycle failed', fails: body.fails });
          else if (body.verdict === 'INCONCLUSIVE' && QUALIFYING_MODELS.includes(run0.failureModel)) {
            s.stop({ cycle: n, reason: 'series broken: INCONCLUSIVE (decision 1). Investigate and resolve the cause, then start a new run at cycle 1', inconclusive: body.inconclusive });
          }
          return reply(200, { ok: true, stopped: !!s.stopped() });
        }

        if (cm?.[2] === 'recovered') {
          if (s.stopped()) return refuse(409, 'run_stopped');
          const r = s.result(n);
          if (!r || r.verdict === 'FAIL') return refuse(409, 'nothing_to_recover');
          if (body.cycleId !== startsOf(events, n)[0]?.cycleId) return refuse(409, 'wrong_cycle_id');
          if (recoveryOf(events, n)) return refuse(409, 'already_recovered');
          if (r.quarantineRequired) {
            if (!events.some((e) => e.cycle === n && e.kind === 'quarantine_observed')) return refuse(409, 'quarantine_not_observed');
            if (body.cleared !== true || body.uncommitted?.seq !== r.uncommitted?.seq || body.uncommitted?.actionId !== r.uncommitted?.actionId) return refuse(409, 'clearance_not_shown');
            s.accept({ cycle: n, seq: r.uncommitted.seq, actionId: r.uncommitted.actionId, digest: body.digest ?? null });
          }
          s.event({ cycle: n, kind: 'recovered', cycleId: body.cycleId, steps: body.steps ?? [], cleared: body.cleared === true, summary: body.summary ?? null, ...stamp });
          return reply(200, { ok: true, final: cycleView(s, n, { silentStopMs }).final });
        }

        if (rest === 'stop') {
          s.stop({ cycle: Number.isInteger(body.cycle) ? body.cycle : null, reason: String(body.reason ?? 'stopped').slice(0, 300), ...stamp });
          return reply(200, { ok: true });
        }
        return refuse(404, 'not_found');
      } catch (e) {
        return reply(e.status ?? 500, { error: String(e.message).slice(0, 200) });
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
      'failure-model': { type: 'string' }, 'write-cache': { type: 'string' }, 'flush-honoured': { type: 'string' }, fua: { type: 'string' }, plp: { type: 'string' }, machine: { type: 'string' }, operator: { type: 'string' },
      'min-seconds': { type: 'string' }, 'max-seconds': { type: 'string' }, 'command-json': { type: 'string' }, 'power-was-cut': { type: 'string' }, evidence: { type: 'string' },
    },
  });
  if (!a.dir) throw new Error('--dir is required');
  if (cmd === 'serve') {
    createRecorder(a.dir).listen(Number(a.port), a.host, () => console.log(`P7 recorder on ${a.host}:${a.port}, storing in ${a.dir}`));
    return;
  }
  if (cmd === 'create-run') {
    const r = createRun(a.dir, { run: a.run, failureModel: a['failure-model'], writeCache: a['write-cache'], flushHonoured: a['flush-honoured'], fua: a.fua, plp: a.plp, machine: a.machine, operator: a.operator });
    // The key itself is never printed: copy the file to the test machine (P7_KEY_FILE_HOST), mode 0600.
    console.log(JSON.stringify({ run: r.run, keyFile: r.keyFile }, null, 2));
    return;
  }
  const s = runStore(a.dir, a.run);
  if (!s.exists()) throw new Error('unknown run');
  const n = Number(a.cycle);
  if (cmd === 'cut') {
    if (!isCycle(n)) throw new Error('--cycle');
    if (s.stopped()) throw new Error('run is stopped');
    const v = cycleView(s, n);
    if (!v.starts.length) throw new Error(`cycle ${n} has not started`);
    if (v.result) throw new Error(`cycle ${n} was already checked`);
    if (v.cutRequestedAt) throw new Error(`cycle ${n} was already cut`);
    const lo = Math.round(Number(a['min-seconds']) * 1000), hi = Math.round(Number(a['max-seconds']) * 1000);
    if (!(lo >= 0 && hi >= lo)) throw new Error('--min-seconds and --max-seconds are required');
    const delayMs = randomInt(lo, hi + 1);
    s.event({ cycle: n, kind: 'cut_scheduled', delayMs });
    console.log(`cycle ${n}: cut in ${(delayMs / 1000).toFixed(1)} s`);
    await sleep(delayMs);
    const cmdArgv = a['command-json'] ? JSON.parse(a['command-json']) : null;
    s.event({ cycle: n, kind: 'cut_sent', how: cmdArgv ? 'command' : 'manual prompt' });
    if (cmdArgv) {
      // The command line is not recorded (a plug's local URL may carry a token); only its exit status.
      const r = spawnSync(cmdArgv[0], cmdArgv.slice(1), { timeout: 30_000, stdio: 'ignore' });
      s.event({ cycle: n, kind: 'cut_command_finished', status: r.status, error: r.error ? String(r.error.code ?? 'error') : null });
      console.log(`cut command exited with ${r.status}`);
    } else console.log('\n*** CUT THE POWER NOW ***\n');
  } else if (cmd === 'confirm-cut') {
    if (!['yes', 'no'].includes(a['power-was-cut'])) throw new Error('--power-was-cut yes|no');
    if (!cycleView(s, n).cutRequestedAt) throw new Error('no cut recorded for this cycle');
    // An operator attestation, recorded as such. It is not independent evidence of the cut.
    s.event({ cycle: n, kind: 'cut_confirmed', powerWasCut: a['power-was-cut'], operatorEvidence: (a.evidence ?? '').slice(0, 500), attestation: 'operator' });
  } else if (cmd === 'status') {
    console.log(JSON.stringify(runStatus(s), null, 2));
  } else throw new Error('commands: serve, create-run, cut, confirm-cut, status');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(String(e.message)); process.exit(1); });
