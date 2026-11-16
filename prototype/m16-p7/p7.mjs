#!/usr/bin/env node
// P7 harness, test-machine side. Runs inside the `harness` container of compose.yml (Node 22 + Prisma runtime).
// Commands: init, run, check, recover. It reuses the Phase 0.5 prototype library unchanged (claim, appendLocked,
// inspect, clear, the journal and its verifier); it connects to PostgreSQL directly (no fault proxy); and it never
// sends a request to a remediation destination: a dispatch is only a synthetic `dispatch` intent record.
//
// NOT production code, and NOT a durability result by itself: see README.md and docs/p7-physical-linux-test-plan.md.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { GUARD, SCHEMA, appendLocked, claim, clear, db, init, inspect, journalAt } from '../m16-phase05/lib/proto.mjs';
import { trustProblem } from '../m16-phase05/lib/journal.mjs';
import { writeOnce } from './lib/ledger.mjs';
import { addFp, fp, hex, repairBytes, scanJournal, sha256File } from './lib/scan.mjs';
import { classifyCycle, compareCycle, durableSettings } from './lib/verdict.mjs';

const REC = process.env.P7_RECORDER_URL;
const EVIDENCE = process.env.P7_EVIDENCE_DIR ?? '/evidence';
const pad = (n) => String(n).padStart(4, '0');
const lastLine = (e) => String(e?.message ?? e).split('\n').filter(Boolean).at(-1)?.slice(0, 200);

async function rec(method, p, body) {
  if (!REC) throw new Error('P7_RECORDER_URL is not set');
  const r = await fetch(`${REC}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`recorder ${method} ${p}: ${r.status} ${text.slice(0, 200)}`), { status: r.status });
  return text ? JSON.parse(text) : null;
}

async function settings(p) {
  const out = {};
  for (const k of ['fsync', 'full_page_writes', 'synchronous_commit', 'wal_sync_method', 'data_checksums', 'server_version']) {
    const [row] = await p.$queryRawUnsafe(`SHOW ${k}`);
    out[k] = Object.values(row)[0];
  }
  return out;
}
const stateRow = async (q) => (await q.$queryRaw`SELECT installation_id, journal_seq, head_hash FROM installation_state WHERE id = 1`)[0];

/** Streams the committed claims (the `execute_start` audit rows, which survive clearance) in pages: bounded memory. */
async function scanDatabase(p, windowFrom) {
  let last = 0n, count = 0, sum = 0n, duplicates = 0;
  const claims = new Map();
  for (;;) {
    const rows = await p.$queryRaw`SELECT id, ref, (meta->>'seq')::int AS seq FROM audit WHERE action = 'execute_start' AND id > ${last} ORDER BY id LIMIT 10000`;
    if (!rows.length) break;
    for (const r of rows) {
      count += 1;
      sum = addFp(sum, fp(r.seq, r.ref));
      if (r.seq > windowFrom) {
        if (claims.has(r.seq)) duplicates += 1;
        else claims.set(r.seq, { actionId: r.ref });
      }
      last = r.id;
    }
  }
  return { count, fingerprint: hex(sum), claims, duplicates };
}

// ─────────────────────────────────────────────── init ───────────────────────────────────────────────
/** Once per run. Refuses a non-empty database or state directory: it never wipes anything. */
async function cmdInit(a) {
  const st = await rec('GET', `/runs/${a.run}`);
  if (st.stopped) throw new Error('run is stopped');
  const p = db();
  const j = journalAt();
  const [{ t }] = await p.$queryRaw`SELECT to_regclass('installation_state')::text AS t`;
  if (t) throw new Error('init refused: the database already has the prototype schema (this harness never resets state)');
  if (fs.existsSync(j.dir) && fs.readdirSync(j.dir).length) throw new Error('init refused: the state directory is not empty');
  const s = await settings(p);
  if (!durableSettings(s)) throw new Error(`init refused: PostgreSQL durability settings are not all on: ${JSON.stringify(s)}`);
  for (const q of SCHEMA.filter((x) => !/^DROP /.test(x))) await p.$executeRawUnsafe(q);
  for (const q of GUARD) await p.$executeRawUnsafe(q);
  const id = await init(p, j);
  await p.$executeRawUnsafe(`INSERT INTO org (id) VALUES ('org-p7')`);
  await rec('POST', `/runs/${a.run}/event`, { cycle: 1, kind: 'initialised', detail: `installation ${id}` });
  console.log(JSON.stringify({ initialised: id, settings: s }));
  await p.$disconnect();
}

// ─────────────────────────────────────────────── run ────────────────────────────────────────────────
/**
 * Claims in a loop until the machine loses power. After a claim CERTAINLY committed: acknowledge it to the recorder,
 * append a synthetic dispatch-intent record under the lock, acknowledge that. Anything else (uncertain commit,
 * quarantine, an error, the recorder unreachable) stops that worker: an ambiguous claim is never retried or acknowledged.
 */
async function cmdRun(a) {
  const cycle = Number(a.cycle);
  const workers = Number(a.workers ?? 1);
  const pool = Number(a.pool ?? 50000); // per worker; an exhausted pool before the cut makes the cycle INCONCLUSIVE
  const proc = a.proc ?? 'a';
  if (!/^[a-z]$/.test(proc) || !(workers >= 1 && workers <= 12) || !(pool >= 1)) throw new Error('bad --proc, --workers (1-12) or --pool');
  const st = await rec('GET', `/runs/${a.run}`);
  if (st.stopped) throw new Error(`run is stopped: ${JSON.stringify(st.stopped)}`);
  const smokeCrash = a['smoke-crash-after-claim-append'];
  if (smokeCrash && st.run.failureModel !== 'HARNESS-SMOKE') throw new Error('--smoke-crash-after-claim-append is only for HARNESS-SMOKE runs');
  const p = db();
  const s = await settings(p);
  if (!durableSettings(s)) throw new Error(`refused: PostgreSQL durability settings are not all on: ${JSON.stringify(s)}`);
  const j0 = journalAt();
  const row = await stateRow(p);
  const js = j0.state({ forceFull: true });
  const problem = trustProblem(row, js);
  if (problem || !['ok', 'empty'].includes(js.status)) throw new Error(`refused: history is not trusted (${problem ?? js.status}); run "recover" for the previous cycle first`);
  const prefix = `c${pad(cycle)}${proc}`;
  const [{ n }] = await p.$queryRaw`SELECT count(*)::int AS n FROM action WHERE id LIKE ${`${prefix}w%`}`;
  if (n) throw new Error(`refused: actions with prefix ${prefix} already exist`);
  for (let w = 1; w <= workers; w++) {
    await p.$executeRawUnsafe(`INSERT INTO action (id, org_id, status) SELECT '${prefix}w${w}-' || g, 'org-p7', 'APPROVED' FROM generate_series(1, ${pool}) g`);
    await p.$executeRawUnsafe(`INSERT INTO approval (action_id) SELECT id FROM action WHERE id LIKE '${prefix}w${w}-%'`);
  }
  await rec('POST', `/runs/${a.run}/cycles/${cycle}/start`, { proc, dbHead: row.journal_seq, journalHead: js.head, workers, settings: s });
  console.log(`cycle ${cycle} (${proc}): ${workers} worker(s) claiming from head ${row.journal_seq}; waiting for the cut`);
  const ack = (body) => rec('POST', `/runs/${a.run}/ack`, { cycle, proc, ...body });
  const stop = async (worker, kind, detail) => {
    console.log(`worker ${worker} stopped: ${kind} ${detail ?? ''}`);
    await rec('POST', `/runs/${a.run}/event`, { cycle, kind: 'worker_stopped', proc, worker, detail: `${kind}${detail ? `: ${detail}` : ''}` }).catch(() => {});
  };
  await Promise.all(Array.from({ length: workers }, async (_, i) => {
    const w = i + 1;
    const j = journalAt();
    for (let k = 1; k <= pool; k++) {
      const actionId = `${prefix}w${w}-${k}`;
      let c;
      try {
        c = await claim(p, j, actionId, smokeCrash && w === 1 && k === 3 ? { crashAt: 'after_claim_append' } : {});
      } catch (e) {
        return stop(w, 'claim_error', lastLine(e));
      }
      if (!c.claimed) return stop(w, `claim_${c.reason}`, c.problem ?? c.error); // includes 'uncertain': never retried
      try { await ack({ kind: 'claim', seq: c.seq, actionId, worker: w }); } catch (e) { return stop(w, 'ack_failed', lastLine(e)); }
      try { await appendLocked(p, j, { type: 'dispatch', seq: c.seq, synthetic: true, at: new Date().toISOString() }); } catch (e) { return stop(w, 'dispatch_intent_failed', lastLine(e)); }
      try { await ack({ kind: 'dispatch', seq: c.seq, actionId, worker: w }); } catch (e) { return stop(w, 'ack_failed', lastLine(e)); }
    }
    return stop(w, 'pool_exhausted');
  }));
  await p.$disconnect();
}

// ─────────────────────────────────────────────── check ──────────────────────────────────────────────
/** After the crash and reboot: preserve, compare, classify, report to the recorder. Changes nothing in the state. */
async function cmdCheck(a) {
  const cycle = Number(a.cycle);
  const st = await rec('GET', `/runs/${a.run}`);
  const v = await rec('GET', `/runs/${a.run}/cycles/${cycle}`);
  if (v.result) throw new Error(`cycle ${cycle} was already checked`);
  if (!v.starts.length) throw new Error(`cycle ${cycle} never started`);
  const windowFrom = Math.min(...v.starts.map((x) => x.dbHead));
  const dir = path.join(EVIDENCE, a.run, `cycle-${pad(cycle)}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.mkdirSync(dir); // throws if it exists: evidence is never overwritten
  const j = journalAt();
  // 1. Preserve the journal exactly as found, before anything else reads or repairs it.
  const files = {};
  for (const [src, name] of [[j.file, 'journal-as-found.jsonl'], [j.idFile, 'installation-as-found.json']]) {
    if (!fs.existsSync(src)) { files[name] = null; continue; }
    fs.copyFileSync(src, path.join(dir, name), fs.constants.COPYFILE_EXCL);
    files[name] = { bytes: fs.statSync(src).size, sha256: sha256File(path.join(dir, name)), sourceSha256: sha256File(src) };
  }
  const p = db();
  const s = await settings(p);
  const row = await stateRow(p);
  const journal = { ...scanJournal(j.file, { windowFrom }), installationId: j.identity() };
  const dbs = { ...(await scanDatabase(p, windowFrom)), installationId: row?.installation_id ?? null, head: row?.journal_seq ?? null, headHash: row?.head_hash ?? null };
  const comparison = compareCycle({ journal, db: dbs, acks: v.acks, accepted: st.accepted, windowFrom });
  const verdict = classifyCycle({ comparison, run: st.run, cycle: { ...v, settings: s } });
  const result = {
    run: a.run, cycle, failureModel: st.run.failureModel, ...verdict,
    findings: comparison.findings, relation: comparison.relation, uncommitted: comparison.uncommitted, counts: comparison.counts,
    journal: { status: journal.status, head: journal.head, headHash: journal.headHash ?? null, tornBytes: journal.tornBytes ?? 0, fileBytes: journal.fileBytes, records: journal.records, fingerprint: journal.fingerprint ?? null },
    database: { head: dbs.head, headHash: dbs.headHash, committedClaims: dbs.count, fingerprint: dbs.fingerprint },
    settings: s, storage: st.run.storage, cut: { sentAt: v.cutSentAt, confirmed: v.cutConfirmed ?? null }, workerStopsBeforeCut: v.workerStopsBeforeCut,
    files, checkedAt: new Date().toISOString(),
  };
  writeOnce(path.join(dir, 'recorder-cycle.json'), v);
  writeOnce(path.join(dir, 'result.json'), result);
  await rec('POST', `/runs/${a.run}/cycles/${cycle}/result`, result); // a FAIL stops the run on the recorder
  console.log(JSON.stringify({ cycle, verdict: result.verdict, fails: result.fails, inconclusive: result.inconclusive, relation: result.relation, needsRecovery: result.needsRecovery, counts: result.counts }));
  await p.$disconnect();
  process.exitCode = { PASS: 0, FAIL: 2, INCONCLUSIVE: 3 }[result.verdict];
}

// ────────────────────────────────────────────── recover ─────────────────────────────────────────────
/**
 * Only after a non-failing check that asked for it. Repairs a torn final line (N1) under the state-row lock, then, if
 * the journal is one claim ahead, clears through the prototype's inspect -> clear(digest): the operator must pass the
 * digest printed by the first call. Any surprise stops the run.
 */
async function cmdRecover(a) {
  const cycle = Number(a.cycle);
  const st = await rec('GET', `/runs/${a.run}`);
  if (st.stopped) throw new Error('run is stopped');
  const v = await rec('GET', `/runs/${a.run}/cycles/${cycle}`);
  const r = v.result;
  if (!r || r.verdict === 'FAIL') throw new Error('nothing to recover: no non-failing result for this cycle');
  if (v.recovered) throw new Error('already recovered');
  const dir = path.join(EVIDENCE, a.run, `cycle-${pad(cycle)}`);
  const p = db();
  const j = journalAt();
  const steps = [];
  const fail = async (why) => {
    await rec('POST', `/runs/${a.run}/stop`, { cycle, reason: `recovery: ${why}` });
    writeOnce(path.join(dir, `recovery-stopped-${Date.now()}.json`), { why, steps });
    throw new Error(`recovery stopped the run: ${why}`);
  };
  if (r.needsRecovery.includes('repair-torn-tail')) {
    const done = await p.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM installation_state WHERE id = 1 FOR UPDATE`;
      const before = j.state({ forceFull: true });
      if (before.status !== 'torn_tail' || before.tornBytes !== r.journal.tornBytes) return { ok: false, before };
      const bytes = repairBytes(before.tornBytes, before.lastHash);
      const fd = fs.openSync(j.file, 'a');
      try {
        if (fs.writeSync(fd, bytes) !== Buffer.byteLength(bytes)) return { ok: false, short: true };
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true, after: j.state({ forceFull: true }), head: before.head };
    }, { timeout: 120_000 });
    if (!done.ok || done.after.status !== 'ok' || done.after.head !== done.head) await fail(`torn-tail repair did not verify (${JSON.stringify(done).slice(0, 200)})`);
    steps.push({ step: 'repair-torn-tail', ignoredBytes: r.journal.tornBytes + 1, journalHead: done.after.head });
  }
  let uncommitted = null, digest = null;
  const problem = trustProblem(await stateRow(p), j.state({ forceFull: true }));
  if (problem) {
    if (r.relation !== 'journal-one-ahead') await fail(`history not trusted after repair: ${problem}`);
    const ins = await inspect(p, j);
    if (ins.journalHead !== r.uncommitted.seq || ins.dbHead !== r.uncommitted.seq - 1) await fail('state changed since the check');
    if (!a['clear-digest']) {
      writeOnce(path.join(dir, `inspection-${Date.now()}.json`), ins);
      console.log(JSON.stringify({ inspection: ins, next: `recover --run ${a.run} --cycle ${cycle} --clear-digest ${ins.digest}` }));
      process.exitCode = 4;
      return p.$disconnect();
    }
    if (a['clear-digest'] !== ins.digest) throw new Error('digest does not match the current inspection');
    const cl = await clear(p, j, { digest: ins.digest, reason: `P7 cycle ${cycle}: journal one claim ahead after the crash` });
    if (!cl.cleared) await fail(`clearance refused: ${cl.reason}`);
    steps.push({ step: 'clear', digest: ins.digest, ...cl });
    uncommitted = r.uncommitted;
    digest = ins.digest;
    const again = trustProblem(await stateRow(p), j.state({ forceFull: true }));
    if (again) await fail(`not trusted after clearance: ${again}`);
  }
  writeOnce(path.join(dir, 'recovery.json'), { steps, uncommitted, at: new Date().toISOString() });
  await rec('POST', `/runs/${a.run}/cycles/${cycle}/recovered`, { steps, uncommitted, digest });
  console.log(JSON.stringify({ recovered: cycle, steps }));
  await p.$disconnect();
}

const [cmd, ...argv] = process.argv.slice(2);
const { values } = parseArgs({ args: argv, options: { run: { type: 'string' }, cycle: { type: 'string' }, workers: { type: 'string' }, pool: { type: 'string' }, proc: { type: 'string' }, 'clear-digest': { type: 'string' }, 'smoke-crash-after-claim-append': { type: 'boolean' } } });
const commands = { init: cmdInit, run: cmdRun, check: cmdCheck, recover: cmdRecover };
if (!commands[cmd] || !/^[A-Za-z0-9_-]{1,64}$/.test(values.run ?? '') || (cmd !== 'init' && !(Number(values.cycle) >= 1))) {
  console.error('usage: p7.mjs init|run|check|recover --run <id> [--cycle <n>] [--workers k] [--pool n] [--proc a] [--clear-digest d]');
  process.exit(1);
}
commands[cmd](values).catch((e) => { console.error(lastLine(e)); process.exit(1); });
