#!/usr/bin/env node
// P7 harness, test-machine side. Runs inside the `harness` container of compose.yml (Node 22 + Prisma runtime).
// Commands: boot-probe (container entrypoint), netcheck, init, run, check, recover.
// - Reuses the Phase 0.5 prototype library unchanged (claim, appendLocked, inspect, clear, the journal and verifier).
//   The journal object it hands them is lib/failclosed.mjs: the same journal, which also remembers a failed write or
//   sync and then refuses every later append (a failed journal fsync fails closed).
// - Connects to PostgreSQL directly (no fault proxy). Never sends a request to a remediation destination: a dispatch is
//   only a synthetic `dispatch` intent record. The only outbound connection is the recorder, through the gateway.
// - Every recorder call is authenticated both ways (lib/protocol.mjs); the run key is read from P7_KEY_FILE and never
//   printed, logged or copied into evidence.
// NOT production code, and NOT a durability result by itself: see README.md and docs/p7-physical-linux-test-plan.md.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import dns from 'node:dns/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { GUARD, SCHEMA, appendLocked, claim, clear, db, init, inspect } from '../m16-phase05/lib/proto.mjs';
import { trustProblem } from '../m16-phase05/lib/journal.mjs';
import { fsyncDir, fsyncFile, writeOnce } from './lib/ledger.mjs';
import { FailClosedJournal, WRITE_FAILED_FILE } from './lib/failclosed.mjs';
import { attemptIdentity, isRefusal, planAttempt, recordRefusal, recordSuperseded, sameAttempt, savedResultProblem } from './lib/attempts.mjs';
import { clearanceMatches, recoverRefusal, saveClearance, savedClearance } from './lib/recovery.mjs';
import { keyFromHex, makeClient, runTag } from './lib/protocol.mjs';
import { QUALIFYING_CYCLES, capacityRefusal, measuredRate, seriesPlan, sizePool, sizePlan } from './lib/sizing.mjs';
import { createPacer } from './lib/pacer.mjs';
import { runWorker, whileBusy } from './lib/worker.mjs';
import { runtimeFingerprint, sourceDigest } from './lib/source.mjs';
import { preflightVerdict } from './lib/preflight.mjs';
import { runNetcheck } from './lib/netcheck.mjs';
import { CLEARANCE_ENVELOPE, testBinding } from './lib/readiness.mjs';
import { storageProblems } from './lib/verdict.mjs';
import { addFp, fp, hex, repairAppliedAt, repairBytes, repairCheck, repairProblem, scanJournal, sha256File } from './lib/scan.mjs';
import { classifyCycle, compareCycle, durableSettings } from './lib/verdict.mjs';

const EVIDENCE = process.env.P7_EVIDENCE_DIR ?? '/evidence';
/** Every journal object of the harness: the Phase 0.5 journal, failing closed after a failed write (lib/failclosed.mjs). */
const journalAt = (dir = process.env.PROTO_STATE_DIR ?? '/state') => new FailClosedJournal(dir);
const pad = (n) => String(n).padStart(4, '0');
const flag = (v) => (v === undefined ? null : Number(v));
/** The burst pattern from the flags (all null when none is given): lib/sizing.mjs. */
const burstOf = (a) => ({ burstPeriodSeconds: flag(a['burst-period']), burstSeconds: flag(a['burst-seconds']), quietRate: flag(a['quiet-rate']) });
/** What runs here: the harness source by content, and the runtime of the image this container was started from. */
// The fingerprint covers the Node binary and the installed dependencies of the image: what this container can say
// about its own image. It is not the image id, which nothing inside a container can read.
const RUNTIME_FILES = [process.execPath, '/app/node_modules/.package-lock.json', '/app/apps/api/package.json'];
const identityNow = () => ({ source: sourceDigest(fileURLToPath(new URL('..', import.meta.url))), runtime: { arch: process.arch, node: process.version, fingerprint: runtimeFingerprint(RUNTIME_FILES) } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastLine = (e) => String(e?.message ?? e).split('\n').filter(Boolean).at(-1)?.slice(0, 200);
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const diff = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? b - a : null);

let call; // signed recorder client, set in main()
const rec = async (method, p, body) => (await call(method, p, body)).data;

// Host facts. boot_id and btime are not namespaced: inside the container they are the machine's.
const bootId = () => fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const bootTimeMs = () => Number(/^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'))[1]) * 1000;

async function settings(p) {
  const out = {};
  for (const k of ['fsync', 'full_page_writes', 'synchronous_commit', 'wal_sync_method', 'data_checksums', 'server_version']) {
    const [row] = await p.$queryRawUnsafe(`SHOW ${k}`);
    out[k] = Object.values(row)[0];
  }
  return out;
}
/** Identity and emptiness of the volumes (read-only). The system identifier is unique per database cluster (initdb). */
async function volumeFacts(p, j) {
  const [{ id }] = await p.$queryRaw`SELECT system_identifier::text AS id FROM pg_control_system()`;
  const [{ n }] = await p.$queryRaw`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'public'`;
  const [{ lsn }] = await p.$queryRaw`SELECT (pg_current_wal_lsn() - '0/0'::pg_lsn)::text AS lsn`;
  const [{ v }] = await p.$queryRaw`SELECT current_setting('server_version') AS v`;
  const entries = fs.existsSync(j.dir) ? fs.readdirSync(j.dir) : [];
  return { pgSystemId: id, publicRelations: n, walLsnBytes: Number(lsn), serverVersion: v, stateEntries: entries.length, stateEntryNames: entries.slice(0, 10) };
}
const MARKER = 'p7-volume.json'; // in the journal volume: which database cluster this journal belongs to
function markerProblem(j, pgSystemId) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(j.dir, MARKER), 'utf8'));
    return m.pgSystemId === pgSystemId ? null : `the journal volume belongs to database cluster ${m.pgSystemId}, not ${pgSystemId}`;
  } catch { return 'the journal volume has no P7 volume marker'; }
}

/** sha256 of the marker `init` wrote into the journal volume: the journal volume's identity. '' when there is none. */
const markerSha = (j) => { try { return sha256File(path.join(j.dir, MARKER)); } catch { return ''; } };

const RETIRE_NOTE = 'p7: unclaimed, retired after its cycle';
/**
 * Retires ONLY this cycle's synthetic actions that were never claimed (attempts = 0, still APPROVED). In one
 * transaction it proves that every other action of the cycle and every audit row is byte-for-byte unchanged, and that
 * the journal file did not change; a second pass must find nothing left (idempotent).
 */
async function retireUnclaimed(p, j, run, cycle, { failInside = false } = {}) {
  const like = `${runTag(run)}c${pad(cycle)}%`;
  const jBefore = { bytes: fs.statSync(j.file).size, sha256: sha256File(j.file) };
  const digests = async (tx) => (await tx.$queryRaw`
    SELECT
      (SELECT count(*)::int FROM action WHERE id LIKE ${like} AND NOT (attempts = 0 AND (status = 'APPROVED' OR (status = 'PROPOSED' AND note IS NOT DISTINCT FROM ${RETIRE_NOTE})))) AS others,
      (SELECT md5(coalesce(string_agg(id || '|' || status || '|' || attempts || '|' || coalesce(outcome, '') || '|' || coalesce(note, ''), ',' ORDER BY id), '')) FROM action
        WHERE id LIKE ${like} AND NOT (attempts = 0 AND (status = 'APPROVED' OR (status = 'PROPOSED' AND note IS NOT DISTINCT FROM ${RETIRE_NOTE})))) AS others_digest,
      (SELECT count(*)::int FROM action WHERE id NOT LIKE ${like} AND status = 'APPROVED') AS approved_elsewhere,
      (SELECT count(*)::int FROM audit) AS audit_rows,
      (SELECT md5(coalesce(string_agg(id::text || '|' || action || '|' || coalesce(ref, '') || '|' || coalesce(meta::text, ''), ',' ORDER BY id), '')) FROM audit) AS audit_digest`)[0];
  const out = await p.$transaction(async (tx) => {
    const before = await digests(tx);
    const retired = await tx.$executeRaw`UPDATE action SET status = 'PROPOSED', note = ${RETIRE_NOTE} WHERE id LIKE ${like} AND status = 'APPROVED' AND attempts = 0`;
    if (failInside) throw new Error('smoke: failure injected inside the retirement transaction');
    const after = await digests(tx);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('retirement would have changed a claimed action or an audit row');
    return { retired, claimedOrOtherActionsUnchanged: before.others, auditRowsUnchanged: before.audit_rows, approvedElsewhereUntouched: before.approved_elsewhere };
  }, { timeout: 600_000, maxWait: 60_000 });
  // Idempotence, checked without changing anything: nothing is left for a second pass.
  const [{ left: secondPass }] = await p.$queryRaw`SELECT count(*)::int AS left FROM action WHERE id LIKE ${like} AND status = 'APPROVED' AND attempts = 0`;
  const jAfter = { bytes: fs.statSync(j.file).size, sha256: sha256File(j.file) };
  if (jAfter.bytes !== jBefore.bytes || jAfter.sha256 !== jBefore.sha256) throw Object.assign(new Error('the journal changed during retirement'), { journalChanged: true });
  if (secondPass !== 0) throw new Error(`a second retirement pass found ${secondPass} more actions`);
  return { ...out, secondPass, journalUnchanged: true };
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

function evidenceFile(run, sub, name, data) {
  const dir = path.join(EVIDENCE, run, sub);
  fs.mkdirSync(dir, { recursive: true });
  writeOnce(path.join(dir, name), data);
  return path.join(dir, name);
}

// ───────────────────────────────────────────── boot-probe ─────────────────────────────────────────────
/** Container entrypoint: records when this boot's database became reachable (crash recovery finished), then reports it. */
async function cmdBootProbe(a) {
  const startedAt = Date.now();
  const r = { bootId: bootId(), bootTime: bootTimeMs(), containerStartedAt: startedAt, postmasterStartedAt: null, databaseReachableAt: null };
  const p = db();
  for (const deadline = startedAt + 15 * 60_000; Date.now() < deadline; await sleep(200)) {
    try {
      const [row] = await p.$queryRaw`SELECT pg_postmaster_start_time() AS t`;
      r.postmasterStartedAt = new Date(row.t).getTime();
      r.databaseReachableAt = Date.now(); // PostgreSQL accepts connections only after crash recovery completed
      break;
    } catch { /* still starting or recovering */ }
  }
  await p.$disconnect().catch(() => {});
  evidenceFile(a.run, 'boots', `boot-${r.bootId}-${startedAt}.json`, r);
  console.log(`boot probe: ${JSON.stringify({ ...r, bootTime: iso(r.bootTime), databaseReachableAt: iso(r.databaseReachableAt) })}`);
  for (let i = 0; i < 120; i++) { // the recorder may not be up yet; each attempt is a new signed request
    try { const x = await call('POST', `/runs/${a.run}/boot`, r); console.log(`boot reported (cycle ${x.data.cycle})`); return; } catch (e) { if (e.status === 401 || e.status === 404) break; await sleep(5000); }
  }
  console.log('boot report not delivered to the recorder');
}

// ───────────────────────────────────────────── netcheck ─────────────────────────────────────────────
function tcp(host, port, ms = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (o) => { s.destroy(); resolve(o); };
    s.setTimeout(ms, () => done('timeout'));
    s.once('connect', () => done('connected'));
    s.once('error', (e) => done(e.code === 'ECONNREFUSED' ? 'refused' : `error:${e.code}`));
  });
}

/**
 * Verifies the isolation the compose file intends, from inside the harness: the recorder is reachable only through the
 * gateway and only with the protocol; PostgreSQL is reachable; nothing else is (internet addresses, external DNS, the
 * recorder host directly, the host or bridge gateways). `refused` from an internet address would mean a route exists.
 */
export async function netcheck(run, { strict = false } = {}) {
  const r = await runNetcheck({
    strict, tcp, interfaces: os.networkInterfaces(), target: process.env.P7_RECORDER_TARGET,
    resolves: (name) => dns.lookup(name).then((x) => `resolved:${x.address}`, (e) => `error:${e.code}`),
    authenticated: () => call('GET', `/runs/${run}`).then(() => null, (e) => lastLine(e)),
    unsigned: () => fetch(`${process.env.P7_RECORDER_URL}/runs/${run}`, { signal: AbortSignal.timeout(5000), redirect: 'error' }).then((x) => x.status, (e) => `error:${e.cause?.code ?? e.name}`),
    // The gateway's self-check port, on the internal network. It takes no input and probes a fixed list.
    egress: () => fetch('http://gateway:8788/', { signal: AbortSignal.timeout(60_000), redirect: 'error' }).then((x) => { if (!x.ok) throw new Error(`gateway self-check: HTTP ${x.status}`); return x.json(); }),
  });
  return { ...r, at: new Date().toISOString(), bootId: bootId() };
}
async function cmdNetcheck(a, { quiet = false } = {}) {
  const st = await rec('GET', `/runs/${a.run}`);
  const r = await netcheck(a.run, { strict: st.run.failureModel !== 'HARNESS-SMOKE' });
  evidenceFile(a.run, 'netcheck', `netcheck-${Date.now()}.json`, r);
  await rec('POST', `/runs/${a.run}/event`, { kind: 'netcheck', detail: r.ok ? `isolation checks passed (strict: ${r.strict}; host answers on the bridge address: ${r.hostAnswersOnBridge})` : `isolation FAILED: ${r.probes.filter((p) => !p.ok).map((p) => p.name).join('; ')}` }).catch(() => {});
  if (!quiet) console.log(JSON.stringify(r, null, 1));
  if (!r.ok) process.exitCode = 5;
  return r;
}

// ───────────────────────────────────────────── preflight ────────────────────────────────────────────
/**
 * Read-only. Gathers the facts for a qualifying run and prints READY_FOR_OPERATOR_REVIEW or BLOCKED with the exact
 * reasons. It changes nothing on the test machine, seeds nothing, and never starts a workload or a cut. On the recorder
 * it leaves the log of the unauthenticated probes it sends on purpose (rejections.jsonl) and, only when every check
 * passes, the run's readiness record: once, never replaced.
 */
async function cmdPreflight(a) {
  const f = { run: {}, volume: {}, recorder: { authenticated: false, unsignedRejected: false } };
  let st = null;
  try { st = await rec('GET', `/runs/${a.run}`); f.recorder.authenticated = true; } catch { /* reported below */ }
  f.recorder.unsignedRejected = (await fetch(`${process.env.P7_RECORDER_URL}/runs/${a.run}`, { signal: AbortSignal.timeout(5000), redirect: 'error' }).then((r) => r.status, () => null)) === 401;
  if (st) f.run = { run: st.run.run, failureModel: st.run.failureModel, continues: st.run.continues ?? null, rootRun: st.run.rootRun, stopped: !!st.stopped, cyclesStarted: st.cyclesStarted, attestations: st.attestations.map((x) => x.item) };
  f.storageProblems = st ? storageProblems(st.run.storage) : ['the run record could not be read from the recorder'];
  const p = db();
  const j = journalAt();
  try {
    f.settings = await settings(p);
    f.settingsDurable = durableSettings(f.settings);
    const vol = await volumeFacts(p, j);
    const owner = st ? await rec('POST', `/runs/${a.run}/volume-check`, { pgSystemId: vol.pgSystemId }) : { registeredTo: null };
    const [{ t }] = await p.$queryRaw`SELECT to_regclass('installation_state')::text AS t`;
    f.volume = { ...vol, registeredTo: owner.registeredTo, registeredModel: owner.registeredModel ?? null, initialisedByThisRun: !!t && !f.run.continues && owner.registeredTo === f.run.run };
    if (t) {
      const row = await stateRow(p); // plain reads: no lock is taken
      const js = j.state({ forceFull: true });
      const problem = trustProblem(row, js) ?? markerProblem(j, vol.pgSystemId);
      const c = f.run.continues?.finalState;
      Object.assign(f.volume, { installationId: row?.installation_id ?? '', markerSha256: markerSha(j), head: row?.journal_seq ?? null, journalStatus: js.status, trusted: !problem && ['ok', 'empty'].includes(js.status), problem,
        matchesPredecessor: !!c && row?.installation_id === c.installationId && row?.journal_seq === c.head && row?.head_hash === c.headHash });
    }
  } catch (e) {
    f.settingsDurable = false;
    f.volume.error = lastLine(e);
  }
  await p.$disconnect().catch(() => {});
  const n = await netcheck(a.run, { strict: true }).catch((e) => ({ ok: false, strict: true, probes: [{ ok: false, name: `netcheck error: ${lastLine(e)}`, outcome: '' }] }));
  f.netcheck = { ok: n.ok, strict: n.strict, hostAnswersOnBridge: n.hostAnswersOnBridge ?? null, failed: n.probes.filter((x) => !x.ok).map((x) => `${x.name} -> ${x.outcome}`) };
  const rate = a['target-rate'] ? Number(a['target-rate']) : a.rate ? Number(a.rate) : NaN;
  f.sizing = sizePlan({ workers: Number(a.workers ?? 1), procs: Number(a.procs ?? 1), envelope: CLEARANCE_ENVELOPE, ratePerWorker: rate, maxSeconds: Number(a['max-seconds']), headroom: Number(a.headroom ?? 2), pool: a.pool === undefined ? undefined : Number(a.pool), ...burstOf(a) });
  // The whole series, planned before it starts (F7): the planned cycles' claims plus one pool must fit the envelope
  // clearance was validated at. Nothing is reduced to fit; a workload that does not fit is BLOCKED here.
  const cycles = Number(a.cycles ?? QUALIFYING_CYCLES);
  f.series = seriesPlan({ cycles, workers: Number(a.workers ?? 1), procs: Number(a.procs ?? 1), envelope: CLEARANCE_ENVELOPE, ratePerWorker: rate, maxSeconds: Number(a['max-seconds']), headroom: Number(a.headroom ?? 2), pool: a.pool === undefined ? undefined : Number(a.pool), ...burstOf(a) });
  const verdict = preflightVerdict(f);
  // The readiness record. Nothing is written on the test machine; when (and only when) everything above is in place,
  // the configuration is sent to the recorder, which checks its own half and stores the record in this run's ledger.
  // Every qualifying cycle start is then refused unless the configuration is still exactly this one.
  const test = testBinding({ pgSystemId: f.volume.pgSystemId, journal: { markerSha256: f.volume.markerSha256, installationId: f.volume.installationId }, settings: f.settings, netcheck: n, ...identityNow(),
    workload: { procs: f.sizing.procs, workers: f.sizing.workers, cycles, maxSeconds: Number(a['max-seconds']), headroom: Number(a.headroom ?? 2), ratePerWorker: rate, targetRate: a['target-rate'] ? Number(a['target-rate']) : null, poolPerWorker: f.sizing.pool, ...burstOf(a) } });
  let readiness = { recorded: false, why: 'not sent: the checks above are not all in place' };
  if (verdict.status === 'READY_FOR_OPERATOR_REVIEW') {
    try {
      const r = await rec('POST', `/runs/${a.run}/readiness`, { test });
      // `unchanged`: this run already had exactly this record; nothing was written. A different one is refused below.
      readiness = { recorded: true, digest: r.digest, alreadyRecorded: r.unchanged === true };
    } catch (e) {
      const why = e.data?.error ?? lastLine(e);
      readiness = { recorded: false, why };
      verdict.status = 'BLOCKED';
      verdict.reasons.push(`readiness record: the recorder did not record it (${why})${/not_initialised|not_adopted/.test(why) ? `: run "${f.run.continues ? 'adopt' : 'init'}", then preflight again` : ''}${/readiness_already_recorded/.test(why) ? ': this run already has its readiness record, and it is never replaced. The configuration here differs from it in the fields named' : ''}`);
    }
  }
  console.log(JSON.stringify({ ...verdict, readiness, binding: { test }, facts: f, at: new Date().toISOString() }, null, 1));
  process.exitCode = verdict.status === 'READY_FOR_OPERATOR_REVIEW' ? 0 : 6;
}

// ─────────────────────────────────────────────── init ───────────────────────────────────────────────
/** Once per run. Refuses a non-empty database or state directory: it never wipes anything. */
async function cmdInit(a) {
  const st = await rec('GET', `/runs/${a.run}`);
  if (st.stopped) throw new Error('run is stopped');
  if (st.run.continues) throw new Error(`init refused: this run continues ${st.run.continues.run}; use "adopt" (the database and journal are kept)`);
  if (!(await cmdNetcheck(a, { quiet: true })).ok) throw new Error('init refused: network isolation not verified (see evidence/netcheck)');
  const p = db();
  const j = journalAt();
  const [{ t }] = await p.$queryRaw`SELECT to_regclass('installation_state')::text AS t`;
  if (t) throw new Error('init refused: the database already has the prototype schema (this harness never resets state)');
  if (fs.existsSync(j.dir) && fs.readdirSync(j.dir).length) throw new Error('init refused: the state directory is not empty');
  const s = await settings(p);
  if (!durableSettings(s)) throw new Error(`init refused: PostgreSQL durability settings are not all on: ${JSON.stringify(s)}`);
  // Before anything is created: the recorder must accept these volumes as new (never used by any run) and, for a
  // qualifying run, as empty and unused. A refusal leaves them untouched.
  const volume = await volumeFacts(p, j);
  if (volume.publicRelations !== 0) throw new Error(`init refused: the database is not empty (${volume.publicRelations} relations)`);
  await rec('POST', `/runs/${a.run}/event`, { kind: 'volume_claimed', volume });
  evidenceFile(a.run, 'init', `initial-empty-state-${Date.now()}.json`, { run: a.run, failureModel: st.run.failureModel, volume, settings: s, at: new Date().toISOString() });
  for (const q of SCHEMA.filter((x) => !/^DROP /.test(x))) await p.$executeRawUnsafe(q);
  for (const q of GUARD) await p.$executeRawUnsafe(q);
  const id = await init(p, j);
  await p.$executeRawUnsafe(`INSERT INTO org (id) VALUES ('org-p7')`);
  writeOnce(path.join(j.dir, MARKER), { pgSystemId: volume.pgSystemId, installationId: id, initialisedByRun: a.run, failureModel: st.run.failureModel, at: new Date().toISOString() });
  await rec('POST', `/runs/${a.run}/event`, { kind: 'initialised', installationId: id, detail: `installation ${id}` });
  console.log(JSON.stringify({ initialised: id, pgSystemId: volume.pgSystemId, settings: s }));
  await p.$disconnect();
}

// ─────────────────────────────────────────────── adopt ──────────────────────────────────────────────
/**
 * First step of a run that continues an earlier run (after an INCONCLUSIVE cycle): the database and journal are kept
 * exactly as they are. Refuses unless the state is trusted (full verification, under the lock) AND identical to the
 * state the recorder holds from the earlier run's last recovery. It changes nothing.
 */
async function cmdAdopt(a) {
  const st = await rec('GET', `/runs/${a.run}`);
  if (st.stopped) throw new Error('run is stopped');
  const c = st.run.continues;
  if (!c) throw new Error('adopt refused: this run does not continue an earlier run (use "init" on empty volumes)');
  if (!(await cmdNetcheck(a, { quiet: true })).ok) throw new Error('adopt refused: network isolation not verified (see evidence/netcheck)');
  const p = db();
  const s = await settings(p);
  if (!durableSettings(s)) throw new Error(`adopt refused: PostgreSQL durability settings are not all on: ${JSON.stringify(s)}`);
  const j = journalAt();
  const { row, js } = await p.$transaction(async (tx) => {
    const [r0] = await tx.$queryRaw`SELECT installation_id, journal_seq, head_hash FROM installation_state WHERE id = 1 FOR UPDATE`;
    return { row: r0, js: j.state({ forceFull: true }) };
  }, { timeout: 120_000, maxWait: 60_000 });
  const problem = trustProblem(row, js);
  if (problem || !['ok', 'empty'].includes(js.status)) throw new Error(`adopt refused: the state is not trusted (${problem ?? js.status}). Nothing was changed`);
  const state = { installationId: row.installation_id, head: row.journal_seq, headHash: row.head_hash };
  const f = c.finalState;
  if (state.installationId !== f.installationId || state.head !== f.head || state.headHash !== f.headHash) {
    throw new Error(`adopt refused: the database and journal are not in the state recorded at the end of run ${c.run} (head ${state.head}, recorded ${f.head}). Nothing was changed`);
  }
  const vol = await volumeFacts(p, j);
  const mp = markerProblem(j, vol.pgSystemId);
  if (mp) throw new Error(`adopt refused: ${mp}. Nothing was changed`);
  await rec('POST', `/runs/${a.run}/event`, { kind: 'adopted', finalState: state, pgSystemId: vol.pgSystemId, detail: `continues ${c.run} after cycle ${c.lastCycle}` });
  evidenceFile(a.run, 'adoption', `adoption-${Date.now()}.json`, { continues: c, state, journal: { status: js.status, head: js.head }, settings: s, at: new Date().toISOString() });
  console.log(JSON.stringify({ adopted: c.run, lastCycle: c.lastCycle, head: state.head, carriedOverAccepted: st.accepted.length }));
  await p.$disconnect();
}

// ─────────────────────────────────────────────── run ────────────────────────────────────────────────
/**
 * Claims in a loop until the machine loses power. After a claim CERTAINLY committed (claim() resolved claimed: true,
 * i.e. the transaction's COMMIT returned): acknowledge it, append a synthetic dispatch-intent record under the lock,
 * acknowledge that. Each worker is its own ordered stream (n = 1, 2, ...). Anything else stops that worker; an
 * ambiguous claim is never retried or acknowledged.
 */
async function cmdRun(a) {
  const st = await rec('GET', `/runs/${a.run}`);
  // A qualifying cycle runs the workload its readiness record names, and no other: the flags may be left out, and a
  // flag that differs is refused. (Other run types size the pool from the flags or the previous cycle's measured rate.)
  if (st.run.failureModel === 'POWER-CUT') {
    const w = st.readiness?.workload;
    if (!w) throw new Error('refused: this run has no readiness record. Run "preflight" first (after init or adopt, with the operator attestations recorded)');
    const recorded = { workers: w.workers, 'max-seconds': w.maxSeconds, headroom: w.headroom, pool: w.poolPerWorker, rate: w.targetRate === null ? w.ratePerWorker : undefined, 'target-rate': w.targetRate ?? undefined,
      'burst-period': w.burstPeriodSeconds ?? undefined, 'burst-seconds': w.burstSeconds ?? undefined, 'quiet-rate': w.quietRate ?? undefined };
    for (const [k, v] of Object.entries(recorded)) {
      if (a[k] !== undefined && Number(a[k]) !== v) throw new Error(`refused: --${k} ${a[k]} differs from the readiness record (${v ?? 'not used there'}). A qualifying cycle runs the recorded workload`);
      if (v === undefined) delete a[k]; else a[k] = String(v);
    }
  }
  const cycle = Number(a.cycle);
  const workers = Number(a.workers ?? 1);
  const proc = a.proc ?? 'a';
  if (!/^[a-z]$/.test(proc) || !(workers >= 1 && workers <= 12)) throw new Error('bad --proc or --workers (1-12)');
  if (st.stopped) throw new Error(`run is stopped: ${JSON.stringify(st.stopped)}`);
  const smokeCrash = a['smoke-crash-after-claim-append'];
  if (smokeCrash && st.run.failureModel !== 'HARNESS-SMOKE') throw new Error('--smoke-crash-after-claim-append is only for HARNESS-SMOKE runs');
  const net = await cmdNetcheck(a, { quiet: true });
  if (!net.ok) throw new Error('refused: network isolation not verified (see evidence/netcheck)');
  // Ask the recorder BEFORE seeding anything, so a refusal (e.g. the previous cycle was not recovered) leaves no trace
  // in the database and is not counted against the cycle.
  if (cycle > 1) {
    const prev = await rec('GET', `/runs/${a.run}/cycles/${cycle - 1}`);
    if (!prev.result) throw new Error(`refused: cycle ${cycle - 1} has not been checked`);
    if (!prev.recovered) throw new Error(`refused: run "recover" for cycle ${cycle - 1} first`);
  }
  // Sizing (never an arbitrary pool): the pool must outlast the longest planned wait for the cut with >= 2x headroom.
  const targetRate = a['target-rate'] ? Number(a['target-rate']) : null; // optional throttle, claims per second per worker
  let rate = targetRate ?? (a.rate ? Number(a.rate) : null);
  let rateSource = targetRate ? 'throttle (--target-rate)' : rate ? 'operator (--rate)' : null;
  if (!rate && cycle > 1) {
    const m = (await rec('GET', `/runs/${a.run}/cycles/${cycle - 1}`)).result?.measuredRate;
    if (m?.totalPerSecond) { rate = m.totalPerSecond; rateSource = `measured in cycle ${cycle - 1} (all workers together, an upper bound for one)`; }
  }
  if (!rate) throw new Error('refused: no claim rate to size the action pool. Give --rate <claims per second per worker> (from a rehearsal) or --target-rate');
  const burst = burstOf(a);
  if (targetRate && burst.burstPeriodSeconds !== null) throw new Error('refused: a burst pattern cannot be combined with --target-rate (the quiet rate is the throttle)');
  const size = sizePool({ ratePerWorker: rate, maxSeconds: Number(a['max-seconds']), headroom: Number(a.headroom ?? 2), pool: a.pool === undefined ? undefined : Number(a.pool), ...burst });
  if (!size.ok) throw new Error(`refused: ${size.reason}${a['max-seconds'] === undefined ? ' (--max-seconds is the longest planned time to the cut)' : ''}`);
  const pool = size.pool;
  const sizing = { ratePerWorker: rate, rateSource, maxSeconds: Number(a['max-seconds']), headroom: Number(a.headroom ?? 2), requiredPerWorker: size.required, poolPerWorker: pool, workers, targetRate, ...burst };
  const cur = await rec('GET', `/runs/${a.run}/cycles/${cycle}`);
  if (cur.result || cur.cutRequestedAt) throw new Error(`refused: cycle ${cycle} was already cut or checked`);
  if (cur.starts.some((x) => x.proc === proc)) throw new Error(`refused: process ${proc} already started in cycle ${cycle}`);
  const p = db();
  const s = await settings(p);
  if (!durableSettings(s)) throw new Error(`refused: PostgreSQL durability settings are not all on: ${JSON.stringify(s)}`);
  const j0 = journalAt();
  // Under the state-row lock: another process (--proc a) may be appending, and an unlocked read could see the journal
  // one record ahead of the row for a moment.
  const { row, js } = await p.$transaction(async (tx) => {
    const [r0] = await tx.$queryRaw`SELECT installation_id, journal_seq, head_hash FROM installation_state WHERE id = 1 FOR UPDATE`;
    return { row: r0, js: j0.state({ forceFull: true }) };
  }, { timeout: 120_000, maxWait: 60_000 });
  const problem = trustProblem(row, js);
  if (problem || !['ok', 'empty'].includes(js.status)) throw new Error(`refused: history is not trusted (${problem ?? js.status}); run "recover" for the previous cycle first`);
  const { pgSystemId } = await volumeFacts(p, j0);
  const mp = markerProblem(j0, pgSystemId);
  if (mp) throw new Error(`refused: ${mp}`);
  const prefix = `${runTag(a.run)}c${pad(cycle)}${proc}`;
  // The recorder vets the start (adoption, volumes, attestations, cycle order) BEFORE anything is seeded.
  // The configuration this start runs on, for the recorder to compare with the readiness record (enforced for a
  // POWER-CUT run; only noted for the others, so a rehearsal shows whether it stays the same across reboots).
  const readiness = testBinding({ pgSystemId, journal: { markerSha256: markerSha(j0), installationId: row.installation_id }, settings: s, netcheck: net, ...identityNow(),
    workload: { procs: st.readiness?.workload.procs ?? null, workers, cycles: st.readiness?.workload.cycles ?? null, maxSeconds: sizing.maxSeconds, headroom: sizing.headroom, ratePerWorker: rate, targetRate, poolPerWorker: pool, ...burst } });
  // The backstop of the series plan (F7), on the ACTUAL count, before the recorder is asked and before anything is
  // seeded: every action clearance would have to process now (claimed in earlier cycles and still EXECUTING, settled
  // as unknown, or waiting) plus what this start would add must stay inside the envelope clearance was validated at.
  // Nothing is reduced to fit, and no claimed action is moved out of EXECUTING to make room.
  const [{ affected }] = await p.$queryRaw`SELECT count(*)::int AS affected FROM action WHERE status IN ('APPROVED', 'PENDING_APPROVAL', 'EXECUTING') OR (status = 'FAILED' AND outcome IN ('unknown', 'not_applied'))`;
  const capacity = { affected, adding: workers * pool };
  const overCapacity = capacityRefusal({ ...capacity, envelope: CLEARANCE_ENVELOPE });
  if (overCapacity) throw new Error(`refused: ${overCapacity}`);
  const startBody = { pgSystemId, proc, dbHead: row.journal_seq, journalHead: js.head, workers, settings: s, sizing, readiness, capacity, bootId: bootId() };
  await rec('POST', `/runs/${a.run}/cycles/${cycle}/start`, { ...startBody, vet: true });
  const [{ n }] = await p.$queryRaw`SELECT count(*)::int AS n FROM action WHERE id LIKE ${`${prefix}w%`}`;
  if (n) throw new Error(`refused: actions with prefix ${prefix} already exist`);
  for (let w = 1; w <= workers; w++) {
    await p.$executeRawUnsafe(`INSERT INTO action (id, org_id, status) SELECT '${prefix}w${w}-' || g, 'org-p7', 'APPROVED' FROM generate_series(1, ${pool}) g`);
    await p.$executeRawUnsafe(`INSERT INTO approval (action_id) SELECT id FROM action WHERE id LIKE '${prefix}w${w}-%'`);
  }
  // The actions are seeded now. If an operator command holds the recorder's lock at this moment the recorder answers
  // "busy" without having done anything: only that answer is repeated (lib/worker.mjs, whileBusy).
  const started = await whileBusy(() => call('POST', `/runs/${a.run}/cycles/${cycle}/start`, startBody));
  const cycleId = started.data.cycleId;
  // A note only. The cycle is started: if this note is lost, the workers must still run (a lost answer here used to
  // end the process with a started cycle and no worker).
  await call('POST', `/runs/${a.run}/event`, { cycle, cycleId, kind: 'netcheck', proc, detail: `clock offset to recorder ${started.clockOffsetMs} ms` }).catch((e) => console.error(`note not recorded (${lastLine(e)}); claiming continues`));
  console.log(`cycle ${cycle} (${proc}): ${workers} worker(s) claiming from head ${row.journal_seq}; waiting for the cut`);
  const stop = async (worker, kind, detail, journal) => {
    console.log(`worker ${proc}/${worker} stopped: ${kind} ${detail ?? ''}`);
    // A journal write or sync that failed is reported on its own, first, and with what became of its marker: the
    // recorder then holds it for this cycle (it accepts it while the cycle is open: before or after the cut was
    // requested, not after the cycle was checked), and no PASS or recovery is accepted for the cycle, even if the
    // marker does not survive the reboot (lib/failclosed.mjs).
    const wf = journal?.writeFailure();
    if (wf) {
      console.error(`JOURNAL WRITE FAILED (${wf.what}, ${wf.code}); marker ${wf.marker}. Nothing more is written to this journal. Stop and report`);
      process.exitCode = 10; // `run` does not end with 0 after a journal write failure
      // "Busy" is answered before the recorder reads or writes anything, so that one answer is repeated (lib/worker.mjs).
      await whileBusy(() => call('POST', `/runs/${a.run}/event`, { cycle, cycleId, kind: 'journal_write_failed', proc, worker, detail: `${wf.what}, ${wf.code}; marker ${wf.marker}` }))
        .catch((e) => console.error(`the journal write failure could NOT be reported to the recorder (${lastLine(e)})`));
    }
    await rec('POST', `/runs/${a.run}/event`, { cycle, cycleId, kind: 'worker_stopped', proc, worker, detail: `${kind}${detail ? `: ${detail}` : ''}` }).catch(() => {});
  };
  // The burst pattern is counted from here, the same way in every cycle, on the monotonic clock: a wall-clock step
  // (time synchronisation after a boot) must not move the pattern or let a claim start early.
  const monotonic = () => performance.now();
  const claimingSince = monotonic();
  // The claim loop itself is lib/worker.mjs, paced by lib/pacer.mjs: both are pure and unit-tested. With a burst
  // pattern the burst part is limited to ratePerWorker and the quiet part to quietRate; with --target-rate, to that.
  const pace = { ratePerWorker: rate, targetRate, ...burst };
  await Promise.all(Array.from({ length: workers }, (_, i) => {
    const w = i + 1;
    const j = journalAt();
    let msg = 0;
    return runWorker({
      pool,
      actionIdOf: (k) => `${prefix}w${w}-${k}`,
      claim: (actionId, k) => claim(p, j, actionId, smokeCrash && w === 1 && k === 3 ? { crashAt: 'after_claim_append' } : {}),
      ack: (kind, seq, actionId) => rec('POST', `/runs/${a.run}/ack`, { cycle, cycleId, proc, worker: w, n: ++msg, kind, seq, actionId }),
      appendDispatch: (seq) => appendLocked(p, j, { type: 'dispatch', seq, synthetic: true, at: new Date().toISOString() }),
      pacer: createPacer(pace, { since: claimingSince, now: monotonic }),
      stop: (kind, detail) => stop(w, kind, kind === 'pool_exhausted' ? `${detail}; sized for ${rate}/s x ${sizing.maxSeconds} s x ${sizing.headroom}` : detail, j),
    });
  }));
  await p.$disconnect();
}

// ─────────────────────────────────────────────── check ──────────────────────────────────────────────
/** After the crash and reboot: preserve, compare, classify, report to the recorder. Changes nothing in the state. */
async function cmdCheck(a) {
  const cycle = Number(a.cycle);
  const st = await rec('GET', `/runs/${a.run}`);
  const got = await call('GET', `/runs/${a.run}/cycles/${cycle}`);
  const v = got.data;
  if (v.result) throw new Error(`cycle ${cycle} was already checked`);
  if (!v.starts.length) throw new Error(`cycle ${cycle} never started`);
  const windowFrom = Math.min(...v.starts.map((x) => x.dbHead));
  const base = path.join(EVIDENCE, a.run, `cycle-${pad(cycle)}`);
  fs.mkdirSync(path.dirname(base), { recursive: true });
  // Retryable, without ever overwriting evidence (lib/attempts.mjs): a result already written but not delivered is
  // re-sent as it is; an attempt that died earlier keeps its directory and this one gets its own. A saved result the
  // RECORDER REFUSED is marked beside itself, kept, never sent again, and does not block a fresh attempt.
  /** The recorder refused this attempt's result: mark it, say so, and leave the fresh attempt to the next run of `check`. */
  const refused = (attemptDir, e, verdictSent) => {
    const marker = recordRefusal(attemptDir, e);
    console.error(`the recorder REFUSED the ${verdictSent} result of ${path.basename(attemptDir)} (${e.data?.refused ?? e.data?.error}). It stored nothing. The result is kept as evidence beside ${marker} and will not be sent again. Run "check" again: it makes a fresh attempt in a directory of its own.`);
    process.exitCode = 9;
  };
  const plan = planAttempt(path.dirname(base), path.basename(base));
  if (plan.resend) {
    const d = plan.resend, attemptDir = path.join(path.dirname(base), d);
    const saved = JSON.parse(fs.readFileSync(path.join(attemptDir, 'result.json'), 'utf8'));
    // A saved PASS was computed before whatever the cycle view shows now. If the view no longer supports it (damage,
    // an authenticated refusal, a reported journal write failure), it is not sent: it is marked and kept, and the next
    // run of `check` decides afresh. (The recorder would refuse it as well; this spares the round trip and the doubt.)
    const stale = savedResultProblem(saved, v);
    if (stale) {
      const marker = recordSuperseded(attemptDir, stale);
      console.error(`the saved ${saved.verdict} result of ${d} was NOT sent: ${stale}. It is kept as evidence beside ${marker}. Run "check" again: it makes a fresh attempt in a directory of its own.`);
      process.exitCode = 9;
      return;
    }
    let posted;
    try { posted = await rec('POST', `/runs/${a.run}/cycles/${cycle}/result`, saved); } catch (e) {
      if (!isRefusal(e)) throw e;
      // "Not open" can also mean that this very result arrived after all (an answer lost earlier): then it is stored.
      const now = await rec('GET', `/runs/${a.run}/cycles/${cycle}`);
      if (!sameAttempt(now.result, saved)) return refused(attemptDir, e, saved.verdict);
      posted = { stopped: !!(await rec('GET', `/runs/${a.run}`)).stopped };
    }
    console.log(JSON.stringify({ cycle, verdict: saved.verdict, resent: d, runStopped: posted.stopped, fails: saved.fails, inconclusive: saved.inconclusive }));
    process.exitCode = { PASS: 0, FAIL: 2, INCONCLUSIVE: 3 }[saved.verdict];
    return;
  }
  const attempts = plan.earlierAttempts;
  const dir = path.join(path.dirname(base), plan.fresh);
  fs.mkdirSync(dir); // throws if it exists: evidence is never overwritten
  const j = journalAt();
  // 1. Preserve the journal exactly as found, on disk, before anything else reads or repairs it.
  const files = {};
  // The marker of a failed journal write (lib/failclosed.mjs), if there is one, is preserved with them.
  for (const [src, name] of [[j.file, 'journal-as-found.jsonl'], [j.idFile, 'installation-as-found.json'], [path.join(j.dir, WRITE_FAILED_FILE), 'journal-write-failed-as-found.json']]) {
    if (!fs.existsSync(src)) { files[name] = null; continue; }
    fs.copyFileSync(src, path.join(dir, name), fs.constants.COPYFILE_EXCL);
    fsyncFile(path.join(dir, name));
    files[name] = { bytes: fs.statSync(src).size, sha256: sha256File(path.join(dir, name)), sourceSha256: sha256File(src) };
  }
  fsyncDir(dir);
  const p = db();
  const s = await settings(p);
  const row = await stateRow(p);
  const journal = { ...scanJournal(j.file, { windowFrom }), installationId: j.identity() };
  const dbs = { ...(await scanDatabase(p, windowFrom)), installationId: row?.installation_id ?? null, head: row?.journal_seq ?? null, headHash: row?.head_hash ?? null };
  // 2. Reboot evidence: a different boot id than at the cycle's start, booted after the cut was requested (recorder clock).
  const offset = got.clockOffsetMs; // recorder minus this machine
  const nowBoot = { bootId: bootId(), bootTime: bootTimeMs() };
  const startBootIds = [...new Set(v.starts.map((x) => x.bootId))];
  const bootTimeOnRecorderClock = nowBoot.bootTime + offset;
  const rebootObservedAfterCut = Boolean(v.cutRequestedAtMs) && !startBootIds.includes(nowBoot.bootId) && bootTimeOnRecorderClock >= v.cutRequestedAtMs - 5000;
  const bootsDir = path.join(EVIDENCE, a.run, 'boots');
  const probe = (fs.existsSync(bootsDir) ? fs.readdirSync(bootsDir) : []).filter((f) => f.startsWith(`boot-${nowBoot.bootId}-`)).map((f) => JSON.parse(fs.readFileSync(path.join(bootsDir, f), 'utf8'))).sort((x, y) => x.containerStartedAt - y.containerStartedAt).at(-1) ?? null;
  const comparison = compareCycle({ journal, db: dbs, acks: v.acks, accepted: st.accepted, windowFrom });
  // A journal write failure that is known, from the marker beside the journal as it is now or from what a worker
  // reported to the recorder during the cycle, makes the cycle INCONCLUSIVE here, as it stops `recover` there.
  const journalWriteFailure = j.writeFailure();
  // A torn final line the verifier would not accept a repair for (not valid UTF-8) makes the cycle INCONCLUSIVE as
  // well: `recover` writes nothing for it (lib/scan.mjs, repairProblem), so it can never be a recovered PASS.
  const repair = journal.status === 'torn_tail' ? repairCheck(j.file, journal.tornBytes) : { verifiable: true };
  // (a check that could not be made is not a fact about the journal: nothing is saved, and `check` can be run again)
  if (repair.undetermined) throw new Error(`the torn final line could not be examined (${repair.undetermined}). No result was saved or sent (this attempt's directory holds the journal as found); run "check" again`);
  const tornTailRepairProblem = repair.wouldNotVerify ?? null;
  const verdict = classifyCycle({ comparison, run: st.run, cycle: { settings: s, cutSentAt: v.cutRequestedAt, cutConfirmed: v.cutConfirmed, workerStopsBeforeCut: v.workerStopsBeforeCut, silentWorkerStops: v.silentWorkerStops, rebootObservedAfterCut, authenticatedRejections: v.authenticatedRejections,
    journalWriteFailure, journalWriteFailures: v.journalWriteFailures ?? [], tornTailRepairProblem,
    // What the recorder says about its own records of this cycle (its acknowledgement ledger, and what its running
    // server could not store). Any damage: INCONCLUSIVE, decided here, before a result is saved or sent.
    recorderDamage: v.damage ?? null } });
  const verifiedAt = Date.now();
  const toRec = (ms) => (Number.isFinite(ms) ? ms + offset : null); // this machine's clock -> recorder clock
  const timeline = {
    clocks: 'recorder clock unless stated; clockOffsetMs = recorder minus test machine',
    clockOffsetMs: offset,
    cutRequestedAt: v.cutRequestedAt,
    independentlyObservedCutAt: null,
    cutBounds: { lastDurableAckAt: v.lastDurableAck?.at ?? null, firstContactAfterCutAt: v.firstContactAfterCut?.at ?? null, note: 'the cut lies between these recorder observations; no device observes the cut itself' },
    bootTime: iso(toRec(nowBoot.bootTime)),
    postgresStartedAt: iso(toRec(probe?.postmasterStartedAt)),
    databaseReachableAt: iso(toRec(probe?.databaseReachableAt)),
    verificationCompletedAt: iso(toRec(verifiedAt)),
    durationsMs: {
      cutToBoot: diff(v.cutRequestedAtMs, toRec(nowBoot.bootTime)),
      bootToDatabaseReachable: diff(nowBoot.bootTime, probe?.databaseReachableAt),
      postgresCrashRecovery: diff(probe?.postmasterStartedAt, probe?.databaseReachableAt),
      cutToVerificationCompleted: diff(v.cutRequestedAtMs, toRec(verifiedAt)),
    },
  };
  const result = {
    run: a.run, cycle, cycleId: v.cycleId, failureModel: st.run.failureModel, ...verdict,
    findings: comparison.findings, relation: comparison.relation, uncommitted: comparison.uncommitted, counts: comparison.counts,
    lastJournalSeq: journal.head ?? null, lastDatabaseSeq: dbs.head, lastDurableAck: v.lastDurableAck,
    journalWriteFailure, journalWriteFailuresReported: v.journalWriteFailures ?? [], // either makes the cycle INCONCLUSIVE; recovery refuses
    tornTailRepairProblem, // non-null: INCONCLUSIVE (TORN_TAIL_NOT_REPAIRABLE); recovery writes no repair for it
    recorderDamage: v.damage ?? null, // any reason in it: INCONCLUSIVE (RECORDER_CYCLE_RECORDS_DAMAGED)
    attempt: attemptIdentity(plan), // this attempt's own identity, and the earlier ones (refused ones named as such)
    journal: { status: journal.status, head: journal.head, headHash: journal.headHash ?? null, tornBytes: journal.tornBytes ?? 0, fileBytes: journal.fileBytes, records: journal.records, fingerprint: journal.fingerprint ?? null, corruptIsFinalLine: journal.corruptIsFinalLine ?? null },
    database: { head: dbs.head, headHash: dbs.headHash, committedClaims: dbs.count, fingerprint: dbs.fingerprint },
    reboot: { observedAfterCut: rebootObservedAfterCut, bootIdAtStart: startBootIds, bootIdNow: nowBoot.bootId, bootProbe: probe },
    settings: s, storage: st.run.storage,
    cut: { requestedAt: v.cutRequestedAt, how: v.cutHow, commandStatus: v.cutCommandStatus, operatorConfirmed: v.cutConfirmed ?? null, operatorEvidence: v.operatorEvidence, operatorAttestedCut: v.operatorAttestedCut ?? null,
      independentlyConfirmed: false, note: 'the confirmation and any cut time are the operator\'s attestation, not an independent observation' },
    measuredRate: measuredRate(v.acks), sizing: v.starts.map((x) => ({ proc: x.proc, ...x.sizing })),
    workerStopsBeforeCut: v.workerStopsBeforeCut, silentWorkerStops: v.silentWorkerStops, authenticatedRejections: v.authenticatedRejections,
    timeline, files, evidenceDir: path.basename(dir), earlierAttempts: attempts, checkedAt: new Date(verifiedAt).toISOString(),
  };
  writeOnce(path.join(dir, 'recorder-cycle.json'), v);
  writeOnce(path.join(dir, 'result.json'), result);
  if (a['smoke-fail-before-result-post']) { // HARNESS-SMOKE only: as if the recorder were unreachable at this moment
    if (st.run.failureModel !== 'HARNESS-SMOKE') throw new Error('--smoke-fail-before-result-post is only for HARNESS-SMOKE runs');
    throw new Error('smoke: stopped before the result was sent');
  }
  let posted;
  try { posted = await rec('POST', `/runs/${a.run}/cycles/${cycle}/result`, result); } // FAIL (and INCONCLUSIVE in a qualifying run) stops the run
  catch (e) {
    if (!isRefusal(e)) throw e;
    const now = await rec('GET', `/runs/${a.run}/cycles/${cycle}`);
    if (!sameAttempt(now.result, result)) { refused(dir, e, result.verdict); return p.$disconnect(); }
    posted = { stopped: !!(await rec('GET', `/runs/${a.run}`)).stopped }; // it is the stored result after all
  }
  console.log(JSON.stringify({ cycle, verdict: result.verdict, fails: result.fails, inconclusive: result.inconclusive, relation: result.relation, quarantineRequired: result.quarantineRequired, needsRecovery: result.needsRecovery, runStopped: posted.stopped, counts: result.counts }));
  await p.$disconnect();
  process.exitCode = { PASS: 0, FAIL: 2, INCONCLUSIVE: 3 }[result.verdict];
}

// ────────────────────────────────────────────── recover ─────────────────────────────────────────────
/**
 * Every cycle ends here (the recorder requires it before the next start). For a journal one claim ahead (decision 2):
 * show the quarantine holds (a claim is refused), repair a torn tail if any, inspect, and clear only with the digest
 * the operator passes from the inspection. A torn final line alone is repaired (N1). Nothing else is ever repaired:
 * a corrupt journal is a FAIL and the run is already stopped. Re-entrant. Any surprise stops the run.
 */
async function cmdRecover(a) {
  const cycle = Number(a.cycle);
  const st = await rec('GET', `/runs/${a.run}`);
  const v = await rec('GET', `/runs/${a.run}/cycles/${cycle}`);
  const r = v.result;
  // Everything that is decided before anything is probed, repaired, cleared or retired is one rule, tested in
  // lib/recovery.mjs: a stopped run, nothing to recover, a recovery that failed earlier, a known journal write
  // failure (the marker now, a worker's report, or what the check recorded), a torn tail that cannot be repaired.
  const refusalNow = (writeFailure) => recoverRefusal({ stopped: st.stopped, cycle, view: v, writeFailure });
  const early = refusalNow(null);
  if (early?.how === 'refuse') throw new Error(early.why);
  const startedAt = Date.now();
  const dir = path.join(EVIDENCE, a.run, r.evidenceDir ?? `cycle-${pad(cycle)}`);
  const p = db();
  const j = journalAt();
  const steps = [];
  const fail = async (why) => {
    await rec('POST', `/runs/${a.run}/stop`, { cycle, reason: `recovery: ${why}` });
    writeOnce(path.join(dir, `recovery-stopped-${Date.now()}.json`), { why, steps });
    throw new Error(`recovery stopped the run: ${why}`);
  };
  // A torn final line that cannot be repaired (not valid UTF-8; the reused verifier would refuse its repair record,
  // and it stays unchanged by decision). Nothing is written: no repair, no clearance, no retirement. The journal stays
  // byte for byte as found and the cycle stays INCONCLUSIVE and not recovered, here and on the recorder, which accepts
  // no recovery for it. Not a new stop of the run: nothing failed; this harness simply cannot recover the cycle.
  const notPossible = (why) => {
    writeOnce(path.join(dir, `recovery-not-possible-${Date.now()}.json`), { why, tornBytes: r.journal?.tornBytes ?? null, journalChanged: false, steps });
    console.error(`recovery of cycle ${cycle} is NOT possible with this harness: ${why}. Nothing was changed. The cycle is INCONCLUSIVE and stays not recovered. Stop and report.`);
    process.exitCode = 8;
    return p.$disconnect();
  };
  // A journal write or sync that failed earlier (lib/failclosed.mjs) ends the run here, before anything is probed,
  // repaired or cleared: what is on the disk under that write is unknown, and nothing is written on top of it.
  // (the same when the marker is gone but a worker reported the failure, or the check recorded it with its result)
  const decided = refusalNow(j.writeFailure());
  if (decided?.how === 'stop-the-run') await fail(decided.why);
  // What the check recorded about the torn tail decides before anything is probed, so check and recover agree.
  if (decided?.how === 'not-possible') return notPossible(decided.why);
  let quarantine = { required: !!r.quarantineRequired, observed: v.events.some((e) => e.kind === 'quarantine_observed') };
  if (r.quarantineRequired && !quarantine.observed) {
    // The probe goes through the real claim path: the trust check refuses before any write (no such action exists either).
    const probe = await claim(p, j, '__p7_quarantine_probe__');
    if (probe.claimed || probe.reason !== 'quarantined') await fail(`quarantine did not hold: a claim was not refused (${probe.reason})`);
    await rec('POST', `/runs/${a.run}/event`, { cycle, cycleId: r.cycleId, kind: 'quarantine_observed', detail: probe.problem });
    quarantine = { required: true, observed: true, refusal: probe.problem, at: new Date().toISOString() };
    steps.push({ step: 'quarantine-observed', refusal: probe.problem });
  }
  if (r.needsRecovery.includes('repair-torn-tail')) {
    const done = await p.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM installation_state WHERE id = 1 FOR UPDATE`;
      const before = j.state({ forceFull: true });
      if (before.status === 'ok' && before.head === r.journal.head && repairAppliedAt(j.file, r.journal.fileBytes, r.journal.tornBytes)) return { ok: true, after: before, head: before.head, alreadyApplied: true };
      if (before.status !== 'torn_tail' || before.tornBytes !== r.journal.tornBytes) return { ok: false, before };
      // A fragment the verifier would not accept a repair for (bytes that are not valid UTF-8) is left exactly as it
      // is: writing the repair would turn this repairable journal into a corrupt one (lib/scan.mjs, repairProblem).
      const repairNow = repairCheck(j.file, before.tornBytes);
      if (repairNow.undetermined) return { ok: false, undetermined: repairNow.undetermined };
      if (repairNow.wouldNotVerify) return { ok: false, unrepairable: repairNow.wouldNotVerify };
      // One write, byte count checked, fsync. A sync that fails is remembered (lib/failclosed.mjs): a rerun must not
      // find the unconfirmed repair "already applied" and carry on.
      try { j.appendBytes(repairBytes(before.tornBytes, before.lastHash), 'repair'); } catch (e) { return { ok: false, writeFailed: lastLine(e) }; }
      return { ok: true, after: j.state({ forceFull: true }), head: before.head };
    }, { timeout: 120_000 });
    // The check found this tail repairable (or recovery would have stopped above). If it is not so now, the journal
    // is not as the check found it: a surprise, and the run stops. Nothing was written.
    if (done.unrepairable) await fail(`the torn final line is not as the check found it (${done.unrepairable})`);
    // The fragment could not be read just now: nothing is known and nothing was written. Not a stop; run it again.
    if (done.undetermined) throw new Error(`the torn final line could not be examined (${done.undetermined}). Nothing was changed; run "recover" again`);
    if (!done.ok || done.after.status !== 'ok' || done.after.head !== done.head) await fail(`torn-tail repair did not verify (${JSON.stringify(done).slice(0, 200)})`);
    steps.push({ step: 'repair-torn-tail', ignoredBytes: r.journal.tornBytes + 1, journalHead: done.after.head, alreadyApplied: !!done.alreadyApplied });
  }
  let uncommitted = null, digest = null, cleared = false;
  const row = await stateRow(p);
  const problem = trustProblem(row, j.state({ forceFull: true }));
  if (!problem && r.quarantineRequired) {
    if (row.journal_seq < r.uncommitted.seq) await fail('trusted, but the database head is below the uncommitted claim');
    uncommitted = r.uncommitted; cleared = true;
    // A clearance an earlier run of this command committed: its digest and counts are read back from the evidence it
    // wrote at once (lib/recovery.mjs), instead of being reported as unknown.
    const earlier = savedClearance(dir);
    const mine = clearanceMatches(earlier, cycle, r.uncommitted); // only this cycle's clearance of this claim
    digest = mine ? earlier.digest ?? null : null;
    steps.push({ step: 'clear', alreadyApplied: true, evidence: earlier?.file ?? null, evidenceUsable: mine, ...(mine ? { digest: earlier.digest ?? null, clearedRecord: earlier.clearedRecord ?? null } : {}) });
  }
  if (problem) {
    if (!r.quarantineRequired) await fail(`history not trusted after repair: ${problem}`);
    const ins = await inspect(p, j);
    if (ins.journalHead !== r.uncommitted.seq || ins.dbHead !== r.uncommitted.seq - 1) await fail('state changed since the check');
    if (!a['clear-digest']) {
      writeOnce(path.join(dir, `inspection-${Date.now()}.json`), ins);
      console.log(JSON.stringify({ quarantine, inspection: ins, next: `recover --run ${a.run} --cycle ${cycle} --clear-digest ${ins.digest}` }));
      process.exitCode = 4;
      return p.$disconnect();
    }
    if (a['clear-digest'] !== ins.digest) throw new Error('digest does not match the current inspection');
    let cl;
    try { cl = await clear(p, j, { digest: ins.digest, reason: `P7 cycle ${cycle}: journal one claim ahead after the crash` }); } catch (e) {
      // The clearance writes one journal record. If that write failed, the run stops here, on the recorder as well:
      // the marker alone may not survive, and the next `recover` must not find a clean slate.
      const failedWrite = j.writeFailure();
      if (failedWrite) await fail(`a journal write failed during the clearance (${failedWrite.what}, ${failedWrite.code}); marker ${failedWrite.marker}`);
      throw e;
    }
    if (!cl.cleared) await fail(`clearance refused: ${cl.reason}`);
    saveClearance(dir, { cycle, digest: ins.digest, uncommitted: r.uncommitted, ...cl }); // at once: not in memory only
    steps.push({ step: 'clear', digest: ins.digest, ...cl });
    uncommitted = r.uncommitted; digest = ins.digest; cleared = true;
    const again = trustProblem(await stateRow(p), j.state({ forceFull: true }));
    if (again) await fail(`not trusted after clearance: ${again}`);
  }
  // Retire this cycle's unclaimed synthetic actions (approved harness housekeeping). One transaction with its own
  // invariant checks: if anything goes wrong it rolls back, nothing is reported to the recorder, and the cycle simply
  // stays not-recovered until `recover` is run again. The verdict is never left in between.
  let retirement;
  try {
    retirement = await retireUnclaimed(p, j, a.run, cycle, { failInside: a['smoke-fail-in-retirement'] && st.run.failureModel === 'HARNESS-SMOKE' });
  } catch (e) {
    if (e.journalChanged) await fail(e.message);
    console.error(`retirement did not complete and was rolled back (${lastLine(e)}). Nothing was recorded: recovery of cycle ${cycle} is NOT complete. Run "recover" again.`);
    process.exitCode = 7;
    return p.$disconnect();
  }
  steps.push({ step: 'retire-unclaimed-actions', ...retirement });
  // The state every later cycle (or a continuing run) starts from: verified trusted, in full, once more.
  const fin = await stateRow(p);
  const finJs = j.state({ forceFull: true });
  const finProblem = trustProblem(fin, finJs);
  if (finProblem || !['ok', 'empty'].includes(finJs.status)) await fail(`not trusted at the end of recovery: ${finProblem ?? finJs.status}`);
  const finalState = { installationId: fin.installation_id, head: fin.journal_seq, headHash: fin.head_hash };
  const completedAt = Date.now();
  const summary = {
    run: a.run, cycleId: r.cycleId, cycle, failureModel: r.failureModel,
    cut: r.cut, timeline: { ...r.timeline, recoveryStartedAt: new Date(startedAt).toISOString(), recoveryCompletedAt: new Date(completedAt).toISOString(), note: 'recovery times on the test machine clock' },
    lastDurableAck: r.lastDurableAck, lastJournalSeq: r.lastJournalSeq, lastDatabaseSeq: r.lastDatabaseSeq,
    reboot: r.reboot, quarantine, clearance: { required: !!r.quarantineRequired, cleared, digest, uncommitted }, steps,
    checkVerdict: r.verdict, fails: r.fails, inconclusive: r.inconclusive,
  };
  // The summary is evidence of what was done: it is written before the report, so a lost answer cannot lose it. What
  // the recorder then answered is written beside it.
  writeOnce(path.join(dir, `cycle-summary-${completedAt}.json`), summary);
  const posted = await rec('POST', `/runs/${a.run}/cycles/${cycle}/recovered`, { cycleId: r.cycleId, steps, uncommitted, digest, cleared, finalState, summary });
  writeOnce(path.join(dir, `recovery-recorded-${Date.now()}.json`), { cycle, cycleId: r.cycleId, finalStatus: posted.final, summary: `cycle-summary-${completedAt}.json` });
  console.log(JSON.stringify({ recovered: cycle, final: posted.final, steps }));
  await p.$disconnect();
}

const [cmd, ...argv] = process.argv.slice(2);
const { values } = parseArgs({ args: argv, options: { run: { type: 'string' }, cycle: { type: 'string' }, cycles: { type: 'string' }, workers: { type: 'string' }, procs: { type: 'string' }, pool: { type: 'string' }, proc: { type: 'string' }, rate: { type: 'string' }, 'target-rate': { type: 'string' }, 'burst-period': { type: 'string' }, 'burst-seconds': { type: 'string' }, 'quiet-rate': { type: 'string' }, 'max-seconds': { type: 'string' }, headroom: { type: 'string' }, 'clear-digest': { type: 'string' }, 'smoke-crash-after-claim-append': { type: 'boolean' }, 'smoke-fail-before-result-post': { type: 'boolean' }, 'smoke-fail-in-retirement': { type: 'boolean' } } });
values.run ??= process.env.P7_RUN;
if (process.env.P7_RUN && values.run !== process.env.P7_RUN) { console.error('--run differs from P7_RUN'); process.exit(1); }
const commands = { 'boot-probe': cmdBootProbe, netcheck: cmdNetcheck, preflight: cmdPreflight, init: cmdInit, adopt: cmdAdopt, run: cmdRun, check: cmdCheck, recover: cmdRecover };
if (!commands[cmd] || !/^[A-Za-z0-9_-]{1,64}$/.test(values.run ?? '') || (['run', 'check', 'recover'].includes(cmd) && !(Number(values.cycle) >= 1))) {
  console.error('usage: p7.mjs boot-probe|netcheck|preflight|init|adopt|run|check|recover [--run <id>] [--cycle <n>] [--proc a] [--workers k] --max-seconds s [--rate r | --target-rate r] [--burst-period s --burst-seconds s --quiet-rate r] [--pool n] [--headroom h] [--clear-digest d]');
  process.exit(1);
}
try {
  call = makeClient({ baseUrl: process.env.P7_RECORDER_URL, key: keyFromHex(fs.readFileSync(process.env.P7_KEY_FILE ?? '/run/p7/run.key', 'utf8')), run: values.run });
} catch {
  console.error('the run key file is missing or invalid (P7_KEY_FILE)');
  process.exit(1);
}
commands[cmd](values).catch((e) => { console.error(lastLine(e)); process.exit(1); });
