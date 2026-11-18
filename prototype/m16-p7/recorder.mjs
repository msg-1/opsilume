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
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appendDurable, fsyncDir, fsyncFile, readLedger, writeOnce } from './lib/ledger.mjs';
import { monoMs } from './lib/protocol.mjs';
import { WINDOW_MS, keyFromHex, newKeyHex, nextStream, signResponse, streamKey, verifyRequest } from './lib/protocol.mjs';
import { FAILURE_MODELS, QUALIFYING_MODELS, STORAGE_FIELDS, durableSettings, finalStatus, physicalStreak, storageProblems, storageQualifies } from './lib/verdict.mjs';
import { REQUIRED_ATTESTATIONS, freshVolumeProblems } from './lib/preflight.mjs';
import { CLEARANCE_ENVELOPE, DOCKER_ARCH, SILENT_STOP_MS, seriesPlanOf, bindingDiff, digestOf, identityProblems, qualifyingWorkloadProblems, recorderBinding, vetTestBinding } from './lib/readiness.mjs';
import { LOCK_FILE, alive, withDirLock } from './lib/lock.mjs';
import { sourceDigest, sourceDigestOfFiles } from './lib/source.mjs';
import { readPackage } from './lib/package.mjs';
import { throughputReport } from './lib/measure.mjs';

const PROTO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const isCycle = (n) => Number.isInteger(n) && n >= 1 && n <= 10000;
const pad = (n) => String(n).padStart(4, '0');
export { SILENT_STOP_MS }; // a stream with no acknowledgement for this long before the cut had stopped (lib/readiness.mjs)
const EVENT_KINDS = ['worker_stopped', 'journal_write_failed', 'volume_claimed', 'initialised', 'adopted', 'quarantine_observed', 'netcheck'];

// Volume registry: every database cluster a run was ever initialised on, by PostgreSQL's system identifier (unique per
// initdb). A cluster belongs to the run that claimed it and to the runs that continue it; nothing else may use it.
const registryFile = (dir) => path.join(dir, 'volumes.jsonl');
/**
 * The registry is append-only and is never rebuilt. Every run that claimed volumes must still be in it,
 * with the cluster its own ledger recorded: a registry that was deleted, truncated, replaced or edited is refused
 * everywhere it is consulted (claim, start, adopt, volume-check, create-run) instead of being read as "no history".
 * The registry line is written before the run's event, so a crash between the two never trips this.
 */
export function registryProblem(dir) {
  let entries;
  try { entries = readLedger(registryFile(dir)).entries; } catch (e) { return String(e.message); }
  const ids = entries.map((v) => v.pgSystemId);
  if (new Set(ids).size !== ids.length) return 'a database cluster is registered more than once';
  const runsDir = path.join(dir, 'runs');
  for (const run of fs.existsSync(runsDir) ? fs.readdirSync(runsDir).sort() : []) {
    let events;
    try { events = readLedger(path.join(runsDir, run, 'events.jsonl')).entries; } catch (e) { return `run ${run}: ${e.message}`; }
    const claim = events.find((e) => e.kind === 'volume_claimed'); // recorded by every run since the registry exists
    if (!claim) continue;
    const mine = entries.filter((v) => v.run === run);
    if (mine.length !== 1) return `run ${run} claimed volumes but has ${mine.length} registry entries`;
    const recorded = claim.pgSystemId;
    if (recorded && recorded !== mine[0].pgSystemId) return `run ${run} claimed cluster ${recorded}, but the registry says ${mine[0].pgSystemId}`;
  }
  return null;
}
function registry(dir) {
  const problem = registryProblem(dir);
  if (problem) throw Object.assign(new Error(`volume_registry_inconsistent: ${problem}. The registry (volumes.jsonl) was reset, replaced or edited; nothing proceeds until it is restored`), { status: 409 });
  return readLedger(registryFile(dir)).entries;
}
export const volumeOwner = (dir, pgSystemId) => registry(dir).find((v) => v.pgSystemId === String(pgSystemId)) ?? null;
export const volumeOf = (dir, run) => registry(dir).find((v) => v.run === run) ?? null;

// Recorder identity: one random id per recorder directory, written once when the directory's first run is created and
// never rewritten. A directory that already holds runs but no identity (it predates this, or the file was removed) is
// never given one: it can serve smoke runs, but no qualifying run is created or made ready on it.
const idFile = (dir) => path.join(dir, 'recorder-id.json');
export function recorderId(dir) {
  try { const id = JSON.parse(fs.readFileSync(idFile(dir), 'utf8')).id; return /^[0-9a-f]{32}$/.test(id) ? id : null; } catch { return null; }
}
function ensureRecorderId(dir) {
  const runsDir = path.join(dir, 'runs');
  if (fs.existsSync(idFile(dir)) || (fs.existsSync(runsDir) && fs.readdirSync(runsDir).length)) return;
  fs.mkdirSync(dir, { recursive: true });
  writeOnce(idFile(dir), { id: randomBytes(16).toString('hex'), createdAt: new Date().toISOString() });
}
/** The recorder's half of a readiness record, as things are now. The registry is bound byte for byte. */
export function recorderBindingOf(dir, run) {
  const s = runStore(dir, run);
  const bytes = fs.existsSync(registryFile(dir)) ? fs.readFileSync(registryFile(dir)) : Buffer.alloc(0);
  return recorderBinding({ run: s.run(), recorderId: recorderId(dir), registry: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, attestations: s.events().filter((e) => e.kind === 'attestation') });
}
/** The run's readiness record: the FIRST one in its ledger. It is never replaced; a later line changes nothing. */
export const acceptedReadiness = (events) => events.find((e) => e.kind === 'readiness') ?? null;
/**
 * Why this test-machine configuration cannot run under this run's declared identity (null = it can). The source is
 * compared by content with the recorder's own copy; the image architecture with what the container itself reports.
 * The image id is declared and bound, but nothing inside a container can observe it (README, "Source and image identity").
 */
export function identityRefusal(run0, test, own = sourceDigest(PROTO_ROOT)) {
  if (identityProblems(run0.identity).length) return 'identity_missing';
  // The source that was checked against the package at create-run is the run's source for good. The recorder's own copy
  // must still be it (so the two hosts can't both move to other code), and the test machine's must be it as well.
  const pinned = run0.sourceTree;
  if (!/^[0-9a-f]{64}$/.test(pinned?.sha256 ?? '')) return 'identity_missing';
  if (own.sha256 !== pinned.sha256 || own.files !== pinned.files) return 'recorder_source_changed_since_create_run';
  if (test.source.treeSha256 !== pinned.sha256 || test.source.files !== pinned.files) return 'source_differs_from_the_recorder';
  if (DOCKER_ARCH[test.runtime.arch] !== run0.identity.imageArch) return 'image_architecture_differs_from_declared';
  return null;
}

export function registerVolume(dir, entry) { fs.mkdirSync(dir, { recursive: true }); appendDurable(registryFile(dir), { ...entry, at: new Date().toISOString() }); }
const validState = (f) => !!f && typeof f.installationId === 'string' && f.installationId.length > 0 && Number.isInteger(f.head) && f.head >= 0 && /^[0-9a-f]{64}$/.test(f.headHash ?? '');
const sameState = (f, g) => validState(f) && validState(g) && f.installationId === g.installationId && f.head === g.head && f.headHash === g.headHash;

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
    // `mono`: the host's monotonic clock (the same for every process on the host until it reboots). Durations that
    // decide something are measured with it, never with the wall clock, which can be set.
    event: (e) => appendDurable(f('events.jsonl'), { ...e, at: new Date().toISOString(), atMs: Date.now(), mono: monoMs() }),
    ack: (a) => { fs.mkdirSync(f('acks'), { recursive: true }); appendDurable(f(`acks/cycle-${pad(a.cycle)}.jsonl`), { ...a, at: new Date().toISOString(), atMs: Date.now(), mono: monoMs() }); },
    reject: (r) => appendDurable(f('rejections.jsonl'), { ...r, at: new Date().toISOString(), atMs: Date.now(), mono: monoMs() }),
    accept: (u) => appendDurable(f('accepted.jsonl'), { ...u, at: new Date().toISOString() }),
    stop: (s) => { if (!store.stopped()) writeOnce(f('STOPPED.json'), { ...s, at: new Date().toISOString() }); },
    saveResult: (n, r) => { fs.mkdirSync(f('results'), { recursive: true }); writeOnce(f(`results/cycle-${pad(n)}.json`), r); },
    create: (meta) => { fs.mkdirSync(root, { recursive: true }); writeOnce(f('run.json'), meta); fsyncDir(path.dirname(root)); },
  };
  return store;
}

/** Operator command (recorder host). Decision 4: a qualifying run with unknown flush or FUA behaviour is refused. */
// ───────────────────────────── the recorder directory: one for the whole experiment ─────────────────────────────
const filesOf = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).filter((f) => !path.basename(f).startsWith(LOCK_FILE) && fs.statSync(path.join(d, f)).isFile()).map((f) => f.split(path.sep).join('/')).sort() : []);
/** 'missing', 'empty', 'recorder' (it holds runs or an identity), or 'damaged' (recorder files, but no runs and no identity). */
export function dirState(dir) {
  if (!fs.existsSync(dir)) return 'missing';
  const runsDir = path.join(dir, 'runs');
  if (fs.existsSync(idFile(dir)) || (fs.existsSync(runsDir) && fs.readdirSync(runsDir).length)) return 'recorder';
  // A registry or keys without runs and identity is what is left of a recorder whose history was removed, not a new one.
  return fs.readdirSync(dir).some((f) => !f.startsWith('.') && !['runs', 'rejections.jsonl'].includes(f)) ? 'damaged' : 'empty';
}
/** What is wrong with one ledger file, in words that carry no path: null, 'ends in an incomplete line', or 'cannot be read (CODE or reason)'. Read-only. */
export function ledgerProblemOf(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { return e.code === 'ENOENT' ? null : `cannot be read (${e.code ?? 'error'})`; }
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return null;
    const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, size - 1);
    return b[0] !== 0x0a ? 'ends in an incomplete line' : null;
  } catch (e) { return `cannot be read (${e.code ?? 'error'})`; } finally { fs.closeSync(fd); }
}
/**
 * The same, and further: a complete line that is not a record. That cannot come from an interrupted append (someone
 * or something changed the file), and every reader of the ledger fails on it, so `verify-dir` and the run's own
 * ledger check name it. (The volume registry has its own, stricter checks and keeps the plain one.)
 */
function runLedgerProblemOf(file) {
  const p = ledgerProblemOf(file);
  if (p) return p;
  try { readLedger(file); return null; } catch (e) { return `cannot be read (${/ is not a record$/.test(e.message ?? '') ? 'a line is not a record' : e.code ?? 'error'})`; }
}
/** Every ledger (.jsonl) in the directory that has a problem: [{ file (relative), problem }]. Read-only; never throws for one file. */
export function ledgerProblems(dir) {
  let files;
  try { files = filesOf(dir); } catch (e) { return [{ file: '(a directory of the recorder)', problem: `cannot be read (${e.code ?? 'error'})` }]; }
  return files.filter((f) => f.endsWith('.jsonl')).map((f) => ({ file: f, problem: (f === 'volumes.jsonl' ? ledgerProblemOf : runLedgerProblemOf)(path.join(dir, f)) })).filter((x) => x.problem);
}
/**
 * The ledgers a run's cycles depend on: its events, its rejections and its accepted claims. (Acknowledgement files
 * belong to one cycle each and are judged with that cycle; the recorder-wide rejection log holds unauthenticated
 * noise and is nobody's cycle record.) Returns the first problem as "<file> <problem>", or null.
 */
export function runLedgerDamage(s) {
  for (const f of ['events.jsonl', 'rejections.jsonl', 'accepted.jsonl']) { const p = runLedgerProblemOf(path.join(s.root, f)); if (p) return `${f} ${p}`; }
  return null;
}
/** The cut's command: nothing (the manual prompt), or a non-empty array of non-empty strings. Checked BEFORE a cut is scheduled. */
export function parseCutCommand(json) {
  if (json === undefined || json === null) return null;
  let v;
  try { v = JSON.parse(json); } catch { v = undefined; }
  if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === 'string' && x.length)) throw new Error('--command-json must be a JSON array of strings, the command and its arguments, for example \'["curl","-s","http://plug.local/off"]\'. Nothing was scheduled');
  return v;
}
/** What an operator checks before and during the experiment. `problems` empty = identity present and history consistent. */
export function dirReport(dir) {
  const state = dirState(dir);
  if (state !== 'recorder') return { dir, state, problems: [`the recorder directory is ${state}: if this should be the experiment's recorder, STOP; it has no history`] };
  const bytes = fs.existsSync(registryFile(dir)) ? fs.readFileSync(registryFile(dir)) : Buffer.alloc(0);
  const runsDir = path.join(dir, 'runs');
  const runs = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).sort() : [];
  const problems = [];
  if (!recorderId(dir)) problems.push('recorder-id.json is missing or unreadable: no qualifying run can be created or made ready here');
  const rp = registryProblem(dir);
  if (rp) problems.push(`volume registry: ${rp}`);
  for (const r of runs) if (!fs.existsSync(path.join(dir, 'keys', `${r}.key`))) problems.push(`run ${r} has no key file`);
  // Readers skip a final line without its newline (a writer died mid-line) and writers refuse to append after it.
  // Say so here, where the operator looks: it is never repaired, and the run it belongs to should not go on.
  for (const { file, problem } of ledgerProblems(dir)) problems.push(`${file} ${problem}${problem.startsWith('ends') ? ': nothing more can be appended to it' : ''}. Do not edit it; stop and report`);
  return { dir, state, recorderId: recorderId(dir), runs: runs.length, registry: { entries: bytes.toString().split('\n').filter(Boolean).length, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, problems };
}
/**
 * Compares a backup with the live directory, byte for byte. Exact: the two hold the same files with the same content
 * (right after the backup was made). allowGrowth: the live directory may have moved on, but only by growing: every
 * backed-up file is still there, ledgers (.jsonl) still begin with their backed-up bytes, everything else is unchanged.
 */
export function compareBackup(live, backup, { allowGrowth = false } = {}) {
  const problems = [];
  const real = (d) => (fs.existsSync(d) ? fs.realpathSync(d) : null);
  const rl = real(live), rb = real(backup);
  // Comparing a directory with itself always matches, and a copy inside the live directory is lost with it.
  const same = (x, y) => { const a = fs.statSync(x), b = fs.statSync(y); return a.dev === b.dev && a.ino === b.ino; };
  if (rl && rb && (rl === rb || same(rl, rb) || rb.startsWith(rl + path.sep) || rl.startsWith(rb + path.sep))) return { files: 0, newerFiles: 0, problems: ['the backup is the live directory itself, or one is inside the other: that is not an independent copy'] };
  const b = filesOf(backup), l = new Set(filesOf(live));
  if (!b.length) problems.push('the backup is empty or missing');
  for (const f of b) {
    if (!l.has(f)) { problems.push(`${f}: in the backup, missing from the live directory`); continue; }
    if (same(path.join(backup, f), path.join(live, f))) { problems.push(`${f}: the backup and the live file are one file (a hard link), not a copy`); continue; }
    const x = fs.readFileSync(path.join(backup, f)), y = fs.readFileSync(path.join(live, f));
    if (x.equals(y)) continue;
    if (allowGrowth && f.endsWith('.jsonl') && y.length > x.length && y.subarray(0, x.length).equals(x)) continue;
    problems.push(`${f}: differs from the backup${f.endsWith('.jsonl') ? ' (earlier records were changed, not just appended to)' : ''}`);
  }
  const extra = [...l].filter((f) => !b.includes(f));
  if (!allowGrowth) for (const f of extra) problems.push(`${f}: in the live directory, not in the backup`);
  // Reported, not refused: the tool cannot tell an independent disk from a second partition. The operator must.
  const sameFilesystem = rl && rb ? fs.statSync(rl).dev === fs.statSync(rb).dev : null;
  return { files: b.length, newerFiles: extra.length, sameFilesystem, problems };
}

/**
 * Operator command after a failed or uncertain `init` (or any run that must never start): marks the run stopped, for
 * good. Nothing is removed or reset: its record, key, registry line and volumes stay, so the volumes can never be
 * used by any run and the run id can never be used again. Only for a run that has not started a cycle.
 */
export function abandonRun(s, reason) {
  if (!String(reason ?? '').trim()) throw new Error('--reason is required: what happened, and where its output is kept');
  if (s.events().some((e) => e.kind === 'cycle_start')) throw new Error('refused: this run has started a cycle. Abandon is for a run that never started one; a cycle ends through check and recover');
  if (s.stopped()) throw new Error(`refused: the run is already stopped (${s.stopped().kind})`);
  // The stop marker first: if this process dies between the two writes, the run is stopped and only the note is missing.
  s.stop({ kind: 'abandoned', cycle: null, reason: String(reason).slice(0, 500) });
  s.event({ cycle: null, kind: 'abandoned', reason: String(reason).slice(0, 500), attestation: 'operator' });
}

/**
 * Why a source package file does not back the declared identity (empty = it does): its SHA-256 is the declared one, the
 * commit `git archive` embedded in it is the declared one, and the harness source in it is, file for file, the source
 * this recorder is running. What this can't show: that the package was really made from the repository's commit (an
 * archive can be hand-made with any commit id in it), or which image was built from it.
 */
export function packageProblems(file, identity, own = sourceDigest(PROTO_ROOT)) {
  let pkg;
  try { pkg = readPackage(file); } catch (e) { return [`the package could not be read (${String(e.message).slice(0, 120)})`]; }
  const out = [];
  if (pkg.sha256 !== identity.packageSha256) out.push(`its SHA-256 is ${pkg.sha256}, not the declared ${identity.packageSha256}`);
  if (!pkg.commit) out.push('it carries no commit id: it was not made by `git archive` from a commit');
  else if (pkg.commit !== identity.sourceCommit) out.push(`it was archived from commit ${pkg.commit}, not the declared ${identity.sourceCommit}`);
  const inside = sourceDigestOfFiles(pkg.files);
  if (inside.sha256 !== own.sha256 || inside.files !== own.files) out.push(`the harness source in it (${inside.files} files) is not the source this recorder is running (${own.files} files): the recorder host must run the packaged commit, with nothing changed`);
  return out;
}
export function createRun(dir, o) { return withDirLock(dir, () => createRunLocked(dir, o)); }
function createRunLocked(dir, o) {
  if (!FAILURE_MODELS.includes(o.failureModel)) throw new Error(`failure model must be one of ${FAILURE_MODELS.join(', ')}`);
  const s = runStore(dir, o.run);
  if (s.exists() || fs.existsSync(s.keyFile)) throw new Error('run already exists');
  registry(dir); // no new run beside a registry that lost history
  // The three run types never share state: a run continues only a run of its own type (decision: a POWER-CUT series
  // starts on fresh volumes and never adopts HARNESS-SMOKE or VM-CRASH state).
  if (o.continues) {
    const old = runStore(dir, o.continues);
    if (!old.exists()) throw new Error('refused: unknown earlier run');
    if (old.run().failureModel !== o.failureModel) throw new Error(`refused: a ${o.failureModel} run cannot continue ${old.run().failureModel} state (run ${o.continues}). A qualifying series starts on fresh, dedicated volumes`);
  }
  // Storage evidence: the operator's checklist (storage-evidence.template.json). Refused for a qualifying run if any
  // critical item is unknown.
  const raw = o.storage && typeof o.storage === 'object' ? o.storage : {};
  const storage = Object.fromEntries([...STORAGE_FIELDS, 'writeCache', 'fua', 'flushSupported', 'flushesObserved', 'vendorFlushSemantics', 'plp'].map((k) => [k, typeof raw[k] === 'string' ? raw[k].slice(0, 400) : 'unknown']));
  storage.attestedBy = 'operator, from the recorded device evidence and the vendor documentation';
  if (QUALIFYING_MODELS.includes(o.failureModel)) {
    const problems = storageProblems(storage);
    if (problems.length) throw new Error(`refused: the storage evidence does not allow a qualifying run:\n- ${problems.join('\n- ')}`);
  }
  // What the operator declares about the source package and the image built on the test machine. Fixed here, in the
  // run's write-once record, and bound by the readiness record. Required before a qualifying run exists at all.
  const identity = Object.fromEntries(['sourceCommit', 'packageSha256', 'imageId', 'imageArch'].map((k) => [k, typeof o.identity?.[k] === 'string' ? o.identity[k].slice(0, 100) : '']));
  if (o.failureModel === 'POWER-CUT' && identityProblems(identity).length) throw new Error(`refused: the source and image identity is incomplete:\n- ${identityProblems(identity).join('\n- ')}`);
  // The declared commit and checksum are checked against the source package itself, and the package's contents against
  // the code this recorder is running. Without the package a qualifying run is not created.
  let identityVerification = 'none: not a qualifying run', sourceTree = null;
  if (o.failureModel === 'POWER-CUT') {
    if (!o.package) throw new Error('refused: --package <the source package .tar.gz> is required for a qualifying run, so the declared commit and checksum can be checked against it');
    sourceTree = sourceDigest(PROTO_ROOT); // what the package was checked against: pinned in the run's record
    const why = packageProblems(o.package, identity, sourceTree);
    if (why.length) throw new Error(`refused: the source package does not match what was declared:\n- ${why.join('\n- ')}`);
    identityVerification = 'source commit, package SHA-256 and package contents: checked by the recorder against the package file and its own copy at create-run. Image id and architecture: declared by the operator';
  }
  // After the run-type and storage refusals, so those keep their own messages.
  if (o.failureModel === 'POWER-CUT' && dirState(dir) === 'recorder' && !recorderId(dir)) throw new Error('refused: this recorder directory holds runs but has no identity (recorder-id.json). It predates readiness records, or the file was removed. A qualifying run needs a recorder directory with its identity intact')
  // Continuing an earlier run's database and journal (same volumes, nothing reset): only from a run that did not fail,
  // whose last cycle was checked and recovered, and that no other run already continues. The new run must then `adopt`
  // exactly the state the recorder holds for the predecessor.
  let continues = null;
  if (o.continues) {
    const old = runStore(dir, o.continues);
    if (!old.exists()) throw new Error('refused: unknown earlier run');
    const st = old.stopped();
    const events = old.events();
    if (old.results().some((r) => r.verdict === 'FAIL') || (st && st.kind !== 'inconclusive') || events.some((e) => e.kind === 'recovery_failed')) throw new Error('refused: the earlier run failed, or its recovery failed. Its state must not be continued');
    // Only a run that can never resume: otherwise two runs could advance the same database, each with its own count.
    if (!st) throw new Error('refused: the earlier run is not stopped. Only a run stopped by an INCONCLUSIVE cycle can be continued');
    const { last, open } = openCycle(old, events);
    if (!last) throw new Error('refused: the earlier run never ran a cycle');
    if (open) throw new Error(`refused: cycle ${open} of the earlier run has not been checked`);
    const done = recoveryOf(events, last);
    if (!validState(done?.finalState)) throw new Error(`refused: cycle ${last} of the earlier run has not been recovered (run "recover" there first; quarantine and clearance are not skipped)`);
    const runsDir = path.join(dir, 'runs');
    for (const other of fs.readdirSync(runsDir)) {
      const f = path.join(runsDir, other, 'run.json');
      if (fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8')).continues?.run === o.continues) throw new Error(`refused: run ${other} already continues ${o.continues}`);
    }
    continues = { run: o.continues, failureModel: old.run().failureModel, lastCycle: last, finalState: done.finalState, stopped: st ? { kind: st.kind, cycle: st.cycle } : null };
  }
  ensureRecorderId(dir); // only now: a refused run leaves nothing behind, not even a new directory's identity
  fs.mkdirSync(path.dirname(s.keyFile), { recursive: true, mode: 0o700 });
  writeOnce(s.keyFile, `${newKeyHex()}\n`, 0o600); // created private: never readable by others, even for a moment
  fs.chmodSync(s.keyFile, 0o600);
  s.create({ run: o.run, failureModel: o.failureModel, createdAt: new Date().toISOString(), machine: o.machine ?? null, operator: o.operator ?? null, storage, identity, identityVerification, sourceTree, continues,
    rootRun: continues ? (runStore(dir, o.continues).run().rootRun ?? o.continues) : o.run, // the run whose `init` created the volumes
    stopOnInconclusive: QUALIFYING_MODELS.includes(o.failureModel) || o.stopOnInconclusive === true, protocol: 'P7-REQ-1/P7-RES-1 HMAC-SHA256' });
  // Claims an earlier clearance accepted as never committed stay excluded from every later history comparison.
  if (continues) for (const u of runStore(dir, o.continues).accepted()) s.accept({ ...u, fromRun: u.fromRun ?? o.continues, acceptedAt: u.acceptedAt ?? u.at });
  return { run: s.run(), keyFile: s.keyFile };
}

const startsOf = (events, n) => events.filter((e) => e.cycle === n && e.kind === 'cycle_start');
/**
 * Whether an authenticated refusal counts against cycle n. Decided by what the recorder stamped on the record when it
 * refused the request, never by a clock: `open` is the cycle that was open then (null: none; 'unknown': the recorder
 * could not tell), `named` the cycle the request named (the path's; the body's only where the path names none; null:
 * none it could use) and `contradicts` whether path and body named different cycles.
 *  - refused while cycle n was open: it counts if it named n, named no usable cycle, contradicted itself, or was a
 *    report of a journal write failure or a worker stop (`signal`: those are facts about the machine under test,
 *    whatever cycle they name). Any other request that consistently named ANOTHER cycle is on record but not counted
 *    (as before: it belongs to no open cycle);
 *  - refused while the open cycle could not be determined: it counts against EVERY cycle of the run, for good (the
 *    run has to be replaced). The count of a cycle therefore never changes once its result is stored;
 *  - refused while no cycle, or another cycle, was open: it does not count against n.
 * A record written before the stamp existed (no `open` field) is counted as it was then: by its cycle and its time.
 */
function countsAgainst(n, { authenticated, open, named, contradicts, signal, atMs, reason }, startMs) {
  if (!authenticated) return false;
  // A PASS refused only because records were added after its check read the view is no fault of anything: the next
  // check reads the view again and is held to every rule afresh.
  if (reason === 'pass_evidence_changed_since_it_was_checked') return false;
  if (open === undefined) return named === n && atMs >= startMs;
  if (open === 'unknown') return true;
  return open === n && (named === n || named === null || contradicts || !!signal);
}
const RESTARTED = 'the recorder restarted while this cycle was open';
/**
 * Ruling C: a mark of everything the recorder holds that a cycle's verdict rests on, as it is now: the size of each
 * of the run's ledgers, of the cycle's acknowledgement file, of the stop marker and of the volume registry. Every
 * ledger is append-only, so any record added since changes the mark. `check` sends back the mark of the view it
 * verified; the recorder stores a PASS only if the mark is still the same, in the same synchronous step as the store.
 */
function evidenceMarkOf(s, n, rejections) {
  const dir = path.dirname(path.dirname(s.root));
  const files = [...['events.jsonl', 'accepted.jsonl', `acks/cycle-${pad(n)}.jsonl`, 'STOPPED.json'].map((f) => path.join(s.root, f)), registryFile(dir)];
  const sizes = files.map((f) => { try { return fs.statSync(f).size; } catch (e) { return e.code === 'ENOENT' ? -1 : `error:${e.code ?? 'unknown'}`; } });
  // Of the rejection log, only the AUTHENTICATED refusals: an unsigned request from anyone on the network must not be
  // able to make a PASS stale. (The log's damage is covered by `damage.runLedgers`.)
  return createHash('sha256').update(JSON.stringify([...sizes, rejections.filter((r) => r.authenticated).length])).digest('hex');
}
/** How many fresh acknowledgements or worker reports for cycle n arrived after its result was stored (each contradicts a PASS). */
// ('*': a contradiction whose cycle could not be determined, because the run's ledgers could not be read when it
// arrived. It counts against every decided cycle.)
const contradicts = (x, n) => x.afterResultOf === '*' || [].concat(x.afterResultOf ?? []).includes(n);
/**
 * The third place a contradiction after a result is kept when neither of the run's ledgers can take it: a write-once
 * file of its own per request (`<recorder dir>/contradictions/<run>/contradiction-<nonce>.json`), outside the run's
 * directory. Read by every view. A marker that cannot be read counts against every decided cycle (fail closed).
 */
const contradictionsDir = (dir, run) => path.join(dir, 'contradictions', run);
function writeContradictionMarker(dir, run, rec) {
  const d = contradictionsDir(dir, run), file = path.join(d, `contradiction-${rec.nonce}.json`);
  // Never creates the recorder directory itself (an unmounted disk leaves an empty mount point, or nothing): only the
  // two levels below it.
  for (const x of [path.dirname(d), d]) { try { fs.mkdirSync(x); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
  // Durable only when every directory entry on the way is: the run's marker directory, `contradictions`, the recorder
  // directory. A file an earlier attempt left behind is synced again before it is taken as kept.
  let written = file;
  try { writeOnce(file, rec); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let same = false;
    try { same = JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))) === JSON.stringify(rec); } catch { same = false; }
    if (same) { fsyncFile(file); fsyncDir(d); } else { written = path.join(d, `contradiction-${rec.nonce}-${randomBytes(8).toString('hex')}.json`); writeOnce(written, rec); } // another record has that name: this one gets its own
  }
  fsyncDir(path.dirname(d)); fsyncDir(dir);
  return written;
}
export const writeContradictionMarkerForTest = writeContradictionMarker;
function markerContradictions(s, n) {
  const d = contradictionsDir(path.dirname(path.dirname(s.root)), path.basename(s.root));
  let files;
  try { files = fs.readdirSync(d); } catch (e) { return e.code === 'ENOENT' ? 0 : 1; }
  return files.filter((f) => { try { return contradicts(JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')), n); } catch { return true; } }).length;
}
const contradictionsAfterResult = (n, rejections, events, s, held = []) => rejections.filter((r) => contradicts(r, n)).length + events.filter((e) => e.kind === 'refusal_not_recorded' && contradicts(e, n)).length
  + (s ? markerContradictions(s, n) : 0) + held.filter((h) => contradicts(h, n)).length;
const finalOf = (result, recovered, contradicted) => (result?.verdict === 'PASS' && contradicted ? 'INCONCLUSIVE' : finalStatus(result, recovered));
/**
 * Ruling B: why the recorder's own records, and what `check` reports it observed after the reboot, do not support a
 * PASS (null: they do). Checked after the damage, refusal, cut and silence rules, in the same synchronous step that
 * stores the result. The reboot, settings and identity rules apply to the qualifying failure models only: a PASS of
 * any other run never counts toward the series (`physicalStreak`).
 */
function passEvidenceProblem({ dir, run0, view, body, allEvents }) {
  if (view.workerStopsAfterCut.length) return 'pass_for_a_cycle_whose_worker_stopped_after_the_cut_request';
  if (!view.claimAcksBeforeCut) return 'pass_for_a_cycle_without_an_acknowledged_claim';
  if (view.events.some((e) => e.kind === 'cut_confirmed' && e.powerWasCut !== 'yes')) return 'pass_for_a_cycle_with_contradictory_cut_confirmations';
  if (QUALIFYING_MODELS.includes(run0.failureModel)) {
    // A reboot after the cut: contact from a boot other than every boot the cycle started on, reported after the cut
    // request in the ledger, and the one `check` itself ran on.
    // Boot ids are compared as the start keeps them (64 characters). Every start must name its boot; no boot reported
    // before the cut request (in the run's ledger) is a reboot after it.
    const bid = (x) => (typeof x === 'string' ? x.slice(0, 64) : '');
    if (!view.starts.every((x) => bid(x.bootId))) return 'pass_without_contact_after_the_cut';
    const cutAt = allEvents.findIndex((e) => e.cycle === view.cycle && e.kind === 'cut_sent');
    const known = new Set([...view.starts.map((x) => bid(x.bootId)), ...allEvents.slice(0, Math.max(cutAt, 0)).filter((e) => e.kind === 'boot_report').map((e) => bid(e.bootId))]);
    const rebooted = view.bootReportsAfterCut.filter((b) => bid(b.bootId) && !known.has(bid(b.bootId)));
    if (!rebooted.length) return 'pass_without_contact_after_the_cut';
    if (!rebooted.some((b) => bid(b.bootId) === bid(body.reboot?.bootIdNow))) return 'pass_reboot_differs_from_the_contact_after_the_cut';
    // The durability settings: on, and (for a POWER-CUT run) exactly the configuration readiness approved, both as
    // every process reported them at its start and as `check` found them after the reboot.
    const ready = run0.failureModel === 'POWER-CUT' ? acceptedReadiness(allEvents) : null;
    if (run0.failureModel === 'POWER-CUT' && !ready) return 'pass_identity_differs_from_the_verified_run';
    const approved = ready?.binding?.test?.postgresql?.settings ?? null; // (the bound settings, as strings: lib/readiness.mjs)
    const settingsOk = (x) => durableSettings(x) && (!approved || Object.entries(approved).every(([k, v]) => String(x?.[k] ?? '') === v));
    if (!settingsOk(body.settings) || !view.starts.every((x) => settingsOk(x.settings))) return 'pass_settings_differ_from_the_qualifying_configuration';
    // The identity: the run, the database cluster (as registered for the series and as every start reported it), and
    // for a POWER-CUT run the journal, the registry and the recorder exactly as readiness bound them.
    const id = body.identity ?? {};
    let vol = null;
    try { vol = volumeOf(dir, run0.rootRun ?? run0.run); } catch { vol = null; }
    if (body.run !== run0.run || !vol || id.pgSystemId !== vol.pgSystemId || !view.starts.every((x) => x.pgSystemId === vol.pgSystemId)) return 'pass_identity_differs_from_the_verified_run';
    if (ready) {
      const t = ready.binding.test;
      if (id.pgSystemId !== t.pgSystemId || id.journalMarkerSha256 !== t.journal?.markerSha256 || id.installationId !== t.journal?.installationId) return 'pass_identity_differs_from_the_verified_run';
      if (!view.starts.every((x) => x.bindingDigest === ready.digest)) return 'pass_identity_differs_from_the_verified_run';
      let now;
      try { now = digestOf(recorderBindingOf(dir, run0.run)); } catch { now = null; }
      if (now !== digestOf(ready.binding.recorder)) return 'pass_identity_differs_from_the_verified_run';
    }
  }
  // Ruling C, last: nothing the verdict rests on was added since `check` read the view it verified.
  if (typeof body.evidenceMark !== 'string') return 'pass_without_the_evidence_mark_of_its_check';
  if (body.evidenceMark !== view.evidenceMark) return 'pass_evidence_changed_since_it_was_checked';
  return null;
}
function openCycle(s, events = s.events()) {
  const started = [...new Set(events.filter((e) => e.kind === 'cycle_start').map((e) => e.cycle))].sort((a, b) => a - b);
  const last = started.at(-1) ?? 0;
  return { last, open: last && !s.result(last) ? last : null };
}
function recoveryOf(events, n) {
  const rec = events.find((e) => e.cycle === n && e.kind === 'recovered');
  return rec ? { ...rec, quarantineObserved: events.some((e) => e.cycle === n && e.kind === 'quarantine_observed') } : null;
}

/**
 * Replays one cycle's acknowledgement ledger: the stream states, the claim sequences, and why the file cannot be
 * relied on (`damaged`): it ends in a fragment, a line does not follow its stream, or it cannot be read. Read-only.
 */
export function replayAcks(s, n) {
  const c = { streams: new Map(), claimSeqs: new Set(), damaged: null };
  let file;
  // (an error code or the ledger reader's own words: never an operating-system message, which carries a path)
  try { file = s.ackFile(n); } catch (e) { c.damaged = `recorder acknowledgement file cannot be read (${e.code ?? (/ is not a record$/.test(e.message) ? e.message : 'unreadable')})`; return c; }
  if (file.tornBytes) c.damaged = 'recorder acknowledgement file has a torn final line';
  const run = s.run().run;
  for (const a of file.entries) {
    const r = nextStream(c.streams.get(streamKey(a)), a, n, run);
    if (r.error) { c.damaged = `recorder acknowledgement file is inconsistent (${r.error})`; break; }
    c.streams.set(streamKey(a), r.st);
    if (a.kind === 'claim') c.claimSeqs.add(a.seq);
  }
  return c;
}

/**
 * Everything about one cycle as recorded on THIS host and by its clock. `memoryDamage` is what only the running server
 * knows about the cycle (an acknowledgement it could not store, an authenticated refusal it could record nowhere);
 * the server passes it when it serves the view. A view computed by another process cannot know it.
 */
export function cycleView(s, n, { silentStopMs = SILENT_STOP_MS, memoryDamage = null, held = [] } = {}) {
  const all = s.events();
  const events = all.filter((e) => e.cycle === n);
  const starts = startsOf(events, n);
  // A recorder process that took this cycle over while it was open: whatever the earlier process knew only in its
  // memory (a refusal it could record nowhere) is lost, so the cycle's records cannot be relied on for a PASS.
  const restarted = events.filter((e) => e.kind === 'recorder_restarted').length;
  const restartDamage = restarted ? `${RESTARTED} (${restarted} time${restarted > 1 ? 's' : ''}): what the earlier process knew only in memory is lost` : null;
  const ackDamage = replayAcks(s, n).damaged;
  const runLedgers = runLedgerDamage(s);
  const acks = ackDamage?.includes('cannot be read') ? [] : s.acks(n);
  const cut = events.find((e) => e.kind === 'cut_sent');
  const cutAt = cut ? events.indexOf(cut) : -1; // its place in the ledger: events are ordered by where they stand, not by the clock
  const confirm = events.filter((e) => e.kind === 'cut_confirmed').at(-1);
  const lastByStream = new Map();
  // Only acknowledgements that arrived before the cut was requested say whether a worker was running then: one that
  // arrives afterwards is kept as evidence and changes nothing about a silence before the cut.
  const beforeCut = (a) => !cut || (Number.isFinite(a.mono) && Number.isFinite(cut.mono) ? a.mono <= cut.mono : a.atMs <= cut.atMs);
  for (const a of acks) if (beforeCut(a)) lastByStream.set(streamKey(a), a);
  // How long before the cut a worker last acknowledged: by the host's monotonic clock when both records carry it (a
  // wall clock set back before the cut would hide a silent worker; set ahead, it would invent one). Records written
  // before the monotonic stamp existed are compared by their wall-clock time, as they always were. A host reboot
  // resets the monotonic clock, and with it restarts the recorder: that cycle is damaged in any case.
  // BOTH clocks must agree that the worker was recent: the monotonic clock stands still while a host is suspended, so
  // by itself it would call a worker recent that died during the pause. A wall clock set AHEAD between the last
  // acknowledgement and the cut therefore reports a silent worker that was not one (INCONCLUSIVE, never PASS).
  const recentEnough = (a) => !!a && a.atMs >= cut.atMs - silentStopMs && (!(Number.isFinite(a.mono) && Number.isFinite(cut.mono)) || a.mono >= cut.mono - silentStopMs);
  const silentWorkerStops = cut ? starts.flatMap((st) => Array.from({ length: st.workers }, (_, i) => ({ proc: st.proc, worker: i + 1 })))
    .filter((w) => !recentEnough(lastByStream.get(`${w.proc}/${w.worker}`)))
    .map((w) => ({ ...w, lastAckAtMs: lastByStream.get(`${w.proc}/${w.worker}`)?.atMs ?? null })) : [];
  const result = s.result(n);
  const recovered = recoveryOf(events, n);
  const boots = events.filter((e) => e.kind === 'boot_report');
  const claimAcksBeforeCut = acks.filter((a) => a.kind === 'claim' && beforeCut(a)).length;
  const startMs = starts[0]?.atMs;
  let rejections = [];
  let rejectionsUnreadable = 0;
  try { rejections = s.rejections(); } catch { rejectionsUnreadable = 1; /* reported as damage.runLedgers */ }
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
    // What the operator says about when the power went. An attestation: never an independent observation.
    operatorAttestedCut: confirm?.operatorAttestedCut ?? null,
    // Nothing on this host observes the cut itself; the cut lies between the last acknowledgement and the first contact after it.
    independentlyObservedCutAt: null,
    firstContactAfterCut: cut ? (boots.find((b) => events.indexOf(b) > cutAt) ?? null) : null,
    bootReports: boots,
    workerStopsBeforeCut: events.filter((e, i) => e.kind === 'worker_stopped' && (!cut || i < cutAt)),
    // Ruling A: a stop reported after the cut REQUEST (its place in the same ledger decides, not a clock) counts too.
    workerStopsAfterCut: cut ? events.filter((e, i) => e.kind === 'worker_stopped' && i > cutAt) : [],
    bootReportsAfterCut: cut ? boots.filter((b) => events.indexOf(b) > cutAt) : [],
    claimAcksBeforeCut,
    // Ruling C: see evidenceMarkOf. Fresh acknowledgements or worker reports refused after the result: each one
    // contradicts a stored PASS, and the cycle's final status is then INCONCLUSIVE.
    evidenceMark: evidenceMarkOf(s, n, rejections),
    contradictedAfterResult: contradictionsAfterResult(n, rejections, all, s, held),
    // A journal write or sync that failed on the test machine, as a worker reported it. Unlike an ordinary worker stop
    // it counts whenever it arrived, before or after the cut was requested: the cycle saw a storage or harness error.
    journalWriteFailures: events.filter((e) => e.kind === 'journal_write_failed'),
    // Whether this cycle's acknowledgement records can be relied on. The recorder stores no PASS for a damaged cycle, so
    // `check` must know before it decides: any damage makes the cycle INCONCLUSIVE. Reasons only; nothing secret.
    // `runLedgers`: one of the run's own ledgers ends in a fragment or cannot be read, so refusals or events of this
    // cycle may be missing. It is read from the files, so a restarted recorder reports it as well.
    // `recorderRestarted` is present only when it happened (read from the ledger, so any process reports it).
    damage: { acknowledgementLedger: ackDamage, recorderMemory: memoryDamage, runLedgers, ...(restartDamage ? { recorderRestarted: restartDamage } : {}) },
    damaged: !!(ackDamage || memoryDamage || runLedgers || restartDamage),
    silentWorkerStops,
    // Only refusals made while the cycle was open count against it: a refused start (e.g. a forgotten recover) must not
    // poison the cycle. Which cycle was open is what the recorder stamped on each refusal (`countsAgainst`), not a time.
    // (and the refusals the rejection log could not take, which the server keeps as events: `refusal_not_recorded`)
    // (a rejection log that cannot be read is damage already, `runLedgers`: the view is served, and counts what it can)
    authenticatedRejections: starts.length ? rejections.filter((r) => countsAgainst(n, { ...r, named: r.cycle, contradicts: 'claimedCycle' in r }, startMs)).length
      + all.filter((e) => e.kind === 'refusal_not_recorded' && countsAgainst(n, { ...e, named: e.open === undefined ? e.cycle : e.named, contradicts: 'claimedCycle' in e }, startMs)).length : 0,
    result,
    recovered,
    // (a rejection log that cannot be read may hold a contradiction: a stored PASS is not final while it cannot)
    final: finalOf(result, recovered, contradictionsAfterResult(n, rejections, all, s, held) + rejectionsUnreadable),
  };
}

export function runStatus(s, { held = [] } = {}) {
  const events = s.events();
  // Read once; a log that cannot be read may hold a contradiction, so no stored PASS is final while it cannot.
  let rejections = [], unreadable = 0;
  try { rejections = s.rejections(); } catch { unreadable = 1; }
  const finals = s.results().map((r) => ({ cycle: r.cycle, verdict: r.verdict, status: finalOf(r, recoveryOf(events, r.cycle), contradictionsAfterResult(r.cycle, rejections, events, s, held) + unreadable) }));
  const { run, ...rest } = s.run();
  const attestations = events.filter((e) => e.kind === 'attestation').map((e) => ({ item: e.item, evidence: e.evidence, at: e.at, attestation: 'operator' }));
  const ready = acceptedReadiness(events);
  return { run: { run, ...rest }, readiness: ready ? { digest: ready.digest, at: ready.at, workload: ready.binding.test.workload, plan: ready.plan ?? null } : null, attestations, cyclesStarted: new Set(events.filter((e) => e.kind === 'cycle_start').map((e) => e.cycle)).size, stopped: s.stopped(), accepted: s.accepted(), cycles: finals, streak: physicalStreak(finals, s.run().failureModel), rejections: unreadable ? null : rejections.length };
}

// ───────────────────────────────────────────── server ─────────────────────────────────────────────
/**
 * The server's time for the protocol (the time window, the time it gives clients to sign with): the wall clock as it
 * was when the server started, plus what the host's monotonic clock has counted since. Setting the host's clock while
 * the server runs therefore changes nothing for requests in flight or for clients that already asked for the time.
 */
const steadyNow = () => { const wall = Date.now(), mono = monoMs(); return () => wall + (monoMs() - mono); };
export function createRecorder(dir, { now = steadyNow(), silentStopMs = SILENT_STOP_MS, lockTimeoutMs = 8000, beforeStartWrite = null, unauthenticatedLogCapBytes = 16 << 20 } = {}) {
  const cache = new Map(); // run -> { key, nonces: Map(nonce -> ts), cycles: Map(n -> { streams, claimSeqs, damaged }) }
  const startedAtMs = now(); // requests signed before this are not this server's (F16)
  // Contradictions held for a run this server could not load (its records could not be read): moved into the run's
  // own hold as soon as it loads, and counted by `heldContradictions` meanwhile.
  const orphanHeld = new Map();
  // Requests `rescueReport` has kept, by run and nonce, with their timestamps. An entry older than the time window is
  // dropped: such a request is refused as stale before it gets here.
  const rescued = new Map();
  // Every run key this server has seen (read at start and whenever one is read): a report can still be authenticated
  // while the recorder's disk, with its `keys/` directory, is gone or replaced.
  const keys = new Map();
  try { for (const f of fs.readdirSync(path.join(dir, 'keys'))) if (f.endsWith('.key')) { try { keys.set(f.slice(0, -4), keyFromHex(fs.readFileSync(path.join(dir, 'keys', f), 'utf8'))); } catch { /* read when needed */ } } } catch { /* no keys yet */ }
  // The recorder directory's identity as this server first saw it: a marker written where that identity is not found
  // (an empty mount point, a replaced disk) proves nothing, and what it holds stays held.
  let knownId = null;
  try { knownId = recorderId(dir); } catch { knownId = null; }
  const onOwnDisk = () => { let id = null; try { id = recorderId(dir); } catch { return false; } knownId ??= id; return !!id && id === knownId; };
  // A marker counts as kept on the recorder's own disk only if, AFTER the identity was read, the file is still found
  // at its path and lies on the same device as the identity file (a disk mounted back over an empty mount point in
  // between hides it).
  const keptOnOwnDisk = (file) => { if (!onOwnDisk()) return false; try { return fs.statSync(file).dev === fs.statSync(path.join(dir, 'recorder-id.json')).dev; } catch { return false; } };
  /**
   * A FRESH, signed report of work (an acknowledgement, a worker stop, a journal failure) that arrives while the run's
   * records cannot be read (the run cannot be loaded, or its directory cannot be found). It may contradict a stored
   * result, and nothing else would keep it: it is kept as contradicting every decided cycle ('*'), in a marker, or
   * failing that in memory (`hold`). An unsigned, stale or pre-start request, or one this server knows as replayed,
   * is not.
   */
  const rescueReport = ({ run, key, seen, req, url, raw, hold, alwaysHold = false }) => {
    const rest = url.pathname.replace(/^\/runs\/[^/]+\/?/, '');
    let body = null;
    try { body = JSON.parse(raw); } catch { body = null; }
    if (!(rest === 'ack' || (rest === 'event' && ['worker_stopped', 'journal_write_failed'].includes(body?.kind)))) return;
    const headers = req.headers;
    if (verifyRequest(key, { method: req.method, path: url.pathname, run, headers, body: raw, now: now(), seen: seen ?? new Map() }) !== null || Number(headers['x-p7-ts']) < startedAtMs) return;
    // One request is kept once, however often it is sent (a captured request must not write markers without end).
    const id = `${run}:${headers['x-p7-nonce']}`;
    if (rescued.has(id)) return;
    for (const [k, t] of rescued) if (Math.abs(now() - t) > WINDOW_MS) rescued.delete(k);
    rescued.set(id, Number(headers['x-p7-ts']));
    const rec = { kind: 'contradiction_after_result', afterResultOf: '*', reason: 'the run\'s records could not be read', path: url.pathname.slice(0, 120), authenticated: true, nonce: headers['x-p7-nonce'], ts: Number(headers['x-p7-ts']), at: new Date().toISOString(), atMs: Date.now(), mono: monoMs() };
    // `alwaysHold`: the run's directory could not be found, so the recorder directory itself may not be the right one
    // (an unmounted disk): a marker written now proves nothing. It is held as well, and written again once the run is found.
    let written = null;
    try { written = writeContradictionMarker(dir, run, rec); } catch { /* held below */ }
    if (written && (!alwaysHold || keptOnOwnDisk(written))) return;
    hold(rec);
    if (!written) { console.error(`recorder: a report of work for run ${run} arrived while its records could not be read, and could be written NOWHERE. It is held in memory only and counts against every decided cycle. A RESTART NOW LOSES IT. Stop and report`); }
  };
  // A rejection that cannot be written to its log (the log ends in a fragment, the disk is full, the file is not
  // writable) must never end the server or change what the request is answered: the request is refused all the same.
  // It is counted and reported on stderr; `verify-dir` names a ledger that ends in a fragment. Nothing repairs the log.
  let unrecorded = 0;
  const noteUnrecorded = (where, e) => {
    unrecorded += 1;
    if (e?.code === 'LOG_AT_ITS_LIMIT') { if (unrecorded === 1 || unrecorded % 100 === 0) console.error(`recorder: ${where} has reached its size limit for unauthenticated requests; such requests are still refused but no longer written there (${unrecorded} rejections not written since this server started). Authenticated refusals are always written`); return; }
    if (unrecorded === 1 || unrecorded % 100 === 0) console.error(`recorder: a rejection could not be written to ${where} (${String(e?.code ?? 'error')}); ${unrecorded} since this server started. The request was refused all the same. Stop and report: run verify-dir, and do not edit the ledger`);
  };
  // An error no handler foresaw is answered 500 and named here: never swallowed, and never fatal. Only its name and
  // code are printed (a message can carry a path; nothing here can carry a key).
  const noteHandlerError = (e) => console.error(`recorder: a request could not be handled (${String(e?.name ?? 'Error')}${e?.code ? ` ${e.code}` : ''}). It was answered with an error. What it had written before the error, if anything, is in the ledgers; it was not answered as accepted. Stop and report if this repeats`);
  // An UNAUTHENTICATED request must not be able to grow a log without limit: each line is a synced append, and a run's
  // log is read for every cycle view. Once a log is larger than the cap, unauthenticated refusals are counted (stderr)
  // and no longer written to it. Authenticated refusals are always written: they decide cycles.
  const logFull = (file) => { try { return fs.statSync(file).size > unauthenticatedLogCapBytes; } catch { return false; } };
  // (never creates the recorder directory: if it is missing, nothing is written there)
  const globalReject = (r) => { const file = path.join(dir, 'rejections.jsonl'); if (logFull(file)) return noteUnrecorded('rejections.jsonl', { code: 'LOG_AT_ITS_LIMIT' }); try { if (!fs.existsSync(dir)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); appendDurable(file, { ...r, at: new Date().toISOString() }); } catch (e) { noteUnrecorded('rejections.jsonl', e); } };

  function runState(s, run) {
    if (cache.has(run)) return cache.get(run);
    let key;
    try { key = keyFromHex(fs.readFileSync(s.keyFile, 'utf8')); } catch (e) { throw Object.assign(e, { keyUnreadable: true }); }
    keys.set(run, key);
    // Rebuild the nonces accepted within the window from what was persisted (survives a recorder restart).
    const nonces = new Map();
    const t = now();
    const remember = (x) => { if (x?.nonce && Math.abs(t - Number(x.ts)) <= WINDOW_MS) nonces.set(x.nonce, Number(x.ts)); };
    const events = s.events();
    events.forEach(remember);
    // (A ledger with a complete line that is not a record makes this throw: the run is then unusable for this
    // server, visibly, and no verdict of any kind is stored. Pinned by test/recorder-availability.test.mjs.)
    s.rejections().forEach(remember);
    s.results().forEach(remember);
    const { open } = openCycle(s, events);
    if (open) s.ackFile(open).entries.forEach(remember);
    // `lost`: this server knows that something about the run reached no ledger and cannot say which cycle it
    // concerns. In memory only; while it is set, no PASS is stored for any cycle of the run and every view says so.
    // `held`: contradictions after a result that no place could take (in memory only; see refuse). While any is held
    // this server stores no PASS, records no recovery and starts no cycle for the run, and it tries to write them
    // again at every request.
    const st = { key, nonces, cycles: new Map(), tookOver: open, lost: null, held: [] };
    // This process did not start the cycle that is open: it took it over from one that is gone, and cannot know what
    // that one kept only in memory (an authenticated refusal it could record nowhere). So it says so, once, as an
    // event of that cycle, and no PASS is stored for the cycle, by this process (`tookOver`) or a later one (the
    // event). If the event cannot be written, this process still refuses, and says so in the view it serves; the next
    // process that takes the cycle over writes its own. Acknowledgements are not affected: the streams continue.
    if (open) {
      const record = () => s.event({ cycle: open, kind: 'recorder_restarted' });
      try { try { withDirLock(dir, record, { timeoutMs: Math.min(lockTimeoutMs, 250) }); } catch (e) { if (e?.status !== 503) throw e; record(); } }
      catch (e) { cycleState(s, st, open).memoryDamage = `${RESTARTED} and could not record it`; console.error(`recorder: this server took over cycle ${open} of a run and could not record that (${String(e?.code ?? 'error')}). No PASS will be stored for the cycle`); }
    }
    cache.set(run, st);
    return st;
  }
  function cycleState(s, rs, n) {
    if (rs.cycles.has(n)) return rs.cycles.get(n);
    // `damaged`: any reason nothing more is accepted in this cycle. `memoryDamage`: the part of it that is not in the
    // ledger, known only to this server while it runs; it is reported in the cycle view it serves.
    const c = { ...replayAcks(s, n), memoryDamage: null };
    rs.cycles.set(n, c);
    return c;
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > 1 << 20) req.destroy(); });
    // No request may end the server: whatever goes wrong while one is handled is answered, not thrown.
    req.on('end', () => {
      try { handle(); } catch (e) { noteHandlerError(e); if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'recorder_error' })); else res.end(); }
    });
    const handle = () => {
      const plain = (status, error) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error }));
      // A request target that is not a URL at all (for example `http://[`) is refused before anything is read or
      // written: no ledger, no rejection line.
      let url;
      try { url = new URL(req.url, 'http://x'); } catch { return plain(400, 'bad request target'); }
      const info = { method: req.method, path: url.pathname.slice(0, 120), remote: req.socket.remoteAddress };
      const m = /^\/runs\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
      if (!m || !RUN_ID.test(m[1])) { globalReject({ ...info, reason: 'bad_path', authenticated: false }); return plain(404, 'not found'); }
      const run = m[1];
      const s = runStore(dir, run);
      // The recorder's time (see below, `time`) needs only the run's key: it is answered even while the run's ledgers
      // cannot be read, so a client can still sign, and what it then reports reaches `rescueReport`.
      // What is held for a run this server has not loaded is written again first, and released once it is on the
      // recorder's own disk.
      if (orphanHeld.has(run)) {
        const left = orphanHeld.get(run).filter((h) => { try { return !keptOnOwnDisk(writeContradictionMarker(dir, run, h)); } catch { return true; } });
        if (left.length) orphanHeld.set(run, left); else orphanHeld.delete(run);
      }
      if (m[2] === 'time' && req.method === 'POST' && (keys.has(run) || fs.existsSync(s.keyFile))) {
        let key = keys.get(run);
        if (!key) { try { key = keyFromHex(fs.readFileSync(s.keyFile, 'utf8')); keys.set(run, key); } catch { return plain(500, 'recorder key unreadable'); } }
        const t = verifyRequest(key, { method: req.method, path: url.pathname, run, headers: req.headers, body: raw, now: now(), seen: new Map() });
        if (t === null || t === 'stale_timestamp') {
          const body = '{}', time = String(now());
          return res.writeHead(200, { 'content-type': 'application/json', 'x-p7-time': time, 'x-p7-mac': signResponse(key, { nonce: req.headers['x-p7-nonce'], status: 200, body, time }) }).end(body);
        }
      }
      if (!s.exists() || !fs.existsSync(s.keyFile)) {
        // A run this server has served that cannot be found now: whatever this request was, it leaves no trace in the run.
        if (cache.has(run)) {
          const c = cache.get(run);
          c.lost ??= 'a request arrived while the run could not be found, and could not be recorded';
          try { rescueReport({ run, key: c.key, seen: c.nonces, req, url, raw, hold: (rec) => c.held.push(rec), alwaysHold: true }); } catch { /* answered below all the same */ }
        } else if (keys.has(run) || fs.existsSync(s.keyFile)) {
          // A run this server has not loaded whose directory is missing (moved, unmounted) and whose key it knows.
          try { rescueReport({ run, key: keys.get(run) ?? keyFromHex(fs.readFileSync(s.keyFile, 'utf8')), seen: null, req, url, raw, hold: (rec) => orphanHeld.set(run, [...(orphanHeld.get(run) ?? []), rec]), alwaysHold: true }); } catch { /* answered below all the same */ }
        }
        globalReject({ ...info, run, reason: 'unknown_run', authenticated: false }); return plain(404, 'unknown run');
      }
      let rs;
      try { rs = runState(s, run); } catch (e) {
        noteHandlerError(e);
        // (the key this server already holds authenticates the report even when the key file cannot be read now)
        const known = keys.get(run) ?? (e?.keyUnreadable ? null : (() => { try { return keyFromHex(fs.readFileSync(s.keyFile, 'utf8')); } catch { return null; } })());
        if (known) {
          try { rescueReport({ run, key: known, seen: null, req, url, raw, hold: (rec) => orphanHeld.set(run, [...(orphanHeld.get(run) ?? []), rec]) }); } catch { /* answered below all the same */ }
        }
        return plain(500, e?.keyUnreadable ? 'recorder key unreadable' : 'a ledger of this run cannot be read');
      }
      if (orphanHeld.has(run)) { rs.held.push(...orphanHeld.get(run)); orphanHeld.delete(run); }
      // What this server holds in memory only (contradictions after a result) is written as soon as a place takes it.
      rs.held = rs.held.filter((h) => { try { writeContradictionMarker(dir, run, h); return false; } catch { try { s.event({ ...h, cycle: null, kind: 'refusal_not_recorded' }); return false; } catch { return true; } } });
      const headers = req.headers;
      const verified = verifyRequest(rs.key, { method: req.method, path: url.pathname, run, headers, body: raw, now: now(), seen: rs.nonces });
      const nonce = headers['x-p7-nonce'];
      const ts = headers['x-p7-ts'];
      // F16: a nonce is persisted only with what a request wrote. A request the earlier server answered with an error
      // would be new to this one; so nothing signed before this server started is accepted. (Clients sign in this
      // host's time: see `time` below.)
      const why = verified ?? (m[2] !== 'time' && Number(ts) < startedAtMs ? 'signed_before_this_server_started' : null);
      const authenticated = why === null || why === 'stale_timestamp' || why === 'replayed_nonce' || why === 'signed_before_this_server_started';
      const reply = (status, obj) => {
        const body = JSON.stringify(obj ?? {});
        const time = String(now());
        res.writeHead(status, { 'content-type': 'application/json', 'x-p7-time': time, 'x-p7-mac': signResponse(rs.key, { nonce, status, body, time }) }).end(body);
      };
      let body = {};
      let malformed = false;
      try { body = raw ? JSON.parse(raw) : {}; } catch { malformed = true; }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) { body = {}; malformed = true; }
      // Which cycle a refused request is about: the path's cycle; the body's only where the path names none. A body
      // that names a different cycle than the path is kept as a claim (`claimedCycle`) and never decides.
      // A path that has a cycle which is not a usable cycle number (`cycles/2x`, `cycles/0`, `cycles/99999`) names no
      // cycle at all: the body does not decide in its place.
      const pathPart = /^cycles\/([^/]*)/.exec(m[2] ?? '')?.[1];
      const pathCycle = pathPart !== undefined && /^\d{1,5}$/.test(pathPart) && isCycle(Number(pathPart)) ? Number(pathPart) : null;
      const cycleOf = pathPart !== undefined ? pathCycle : (isCycle(body?.cycle) ? body.cycle : null);
      // The recorder's time, for a client to sign with (lib/protocol.mjs, makeClient). Read-only and exempt from the
      // time window and the nonce memory: it needs a valid MAC, writes nothing, remembers nothing, and answers a
      // replay the same way. What it gives away is this host's clock.
      if (m[2] === 'time' && req.method === 'POST' && authenticated) return reply(200, {});
      // A report of a journal write failure or a worker stop is a fact about the machine under test: refused, it counts
      // against the cycle that is open whatever cycle it names.
      const signal = m[2] === 'event' && ['journal_write_failed', 'worker_stopped'].includes(body?.kind) ? { signal: body.kind } : {};
      // What an authenticated request left in no ledger is held in memory: against the open cycle, or, when that
      // cannot be determined, against the whole run (`lost`).
      const markLost = (reason, stopAcks = false) => {
        try { const { open } = openCycle(s); if (open) { const c = cycleState(s, rs, open); c.memoryDamage ??= reason; if (stopAcks) c.damaged ??= c.memoryDamage; } } catch { rs.lost ??= reason; }
      };
      const contradiction = pathCycle !== null && body?.cycle !== undefined && body.cycle !== null && body.cycle !== pathCycle ? { claimedCycle: isCycle(body.cycle) ? body.cycle : String(body.cycle).slice(0, 40) } : {};
      const refuse = (status, reason) => {
        // An authenticated refusal is stamped with the cycle that is open as the recorder refuses it: that stamp, not
        // the request's own words and not a clock, decides which cycle it counts against (`countsAgainst`).
        let attribution = {};
        if (authenticated) {
          let openNow; try { openNow = openCycle(s).open; } catch { openNow = 'unknown'; }
          // A FRESH acknowledgement or worker report (signed now: only the holder of the key can make one; a replay
          // cannot) for a cycle that already has its result contradicts that result: the workload was still running.
          // Which decided cycle it is about: the cycle it names, the cycle whose id it carries, and, when no cycle is
          // open, the last cycle that started (a request whose cycle cannot be read is still a sign of a running workload).
          let decided = [];
          if (why === null && (m[2] === 'ack' || (m[2] === 'event' && ['journal_write_failed', 'worker_stopped'].includes(body?.kind)))) {
            // The cycle it names is checked on its own (its result file alone decides), so it is found even when the
            // ledgers cannot be read; if they cannot, the request counts against every decided cycle ('*').
            try { if (isCycle(cycleOf) && s.result(cycleOf)) decided.push(cycleOf); } catch { decided = '*'; }
            if (decided !== '*') try {
              const ev = s.events();
              const started = ev.filter((e) => e.kind === 'cycle_start');
              const byId = started.find((e) => typeof body?.cycleId === 'string' && e.cycleId === body.cycleId)?.cycle;
              const last = started.at(-1)?.cycle;
              for (const c of [cycleOf, byId, openNow === null ? last : undefined]) if (isCycle(c) && !decided.includes(c) && s.result(c)) decided.push(c);
              // A report that names no usable cycle and carries no known cycle id, while another cycle is open: it may
              // be about the last decided cycle as well (it also counts against the open one).
              if (!isCycle(cycleOf) && !isCycle(byId) && openNow !== null) { const lastDecided = started.map((e) => e.cycle).filter((c, i, a) => a.indexOf(c) === i && c !== openNow && s.result(c)).at(-1); if (isCycle(lastDecided) && !decided.includes(lastDecided)) decided.push(lastDecided); }
            } catch { decided = '*'; }
          }
          attribution = { open: openNow, ...contradiction, ...signal, ...(decided === '*' || decided.length ? { afterResultOf: decided } : {}) };
        }
        if (!authenticated && logFull(path.join(s.root, 'rejections.jsonl'))) { noteUnrecorded(`runs/${run}/rejections.jsonl`, { code: 'LOG_AT_ITS_LIMIT' }); return plain(status, reason); }
        // Nor can a replayed, stale or pre-restart request (anyone who captured a signed request can send those without
        // limit): past the cap it is refused as before and not written, and what it would have counted against is held
        // in this server's memory instead, so the open cycle gets no PASS. A refusal of a request signed NOW, which
        // only the holder of the key can produce, is always written.
        if (authenticated && why !== null && logFull(path.join(s.root, 'rejections.jsonl'))) {
          noteUnrecorded(`runs/${run}/rejections.jsonl`, { code: 'LOG_AT_ITS_LIMIT' });
          markLost('replayed or stale requests were refused and not written: the rejection log is at its size limit');
          return why === 'stale_timestamp' ? plain(status, reason) : reply(status, { error: reason });
        }
        // Persisting the nonce with the rejection means even a refused request can't be replayed after a restart.
        let recorded = true;
        try { s.reject({ ...info, run, reason, authenticated, cycle: cycleOf, ...attribution, ...(authenticated ? { nonce, ts } : {}) }); } catch (e) { recorded = false; noteUnrecorded(`runs/${run}/rejections.jsonl`, e); }
        // An unauthenticated request is answered exactly as before (the network check expects its 401): nothing about it
        // is claimed to be recorded, and it must not be able to write anywhere else.
        if (recorded || !authenticated) return authenticated && why !== 'stale_timestamp' ? reply(status, { error: reason }) : plain(status, reason);
        // An AUTHENTICATED refusal that the rejection log did not take. It counts against its cycle (INCONCLUSIVE), so it
        // must not be lost: it is kept as an event in the run's ledger instead. If that fails too, the open cycle
        // accepts nothing more from this server. Either way the answer is an error that says the refusal was not
        // recorded as usual; it is never answered as an ordinary refusal.
        // A replayed or stale request (anyone who captured a signed request can send those) gets no such event: it
        // must not be able to write to the run's event ledger. A rejection log that ends in a fragment or cannot be
        // read already makes the cycle INCONCLUSIVE (`damage.runLedgers`), also after a restart; for any other
        // reason the log could not be written (a full disk, a read-only file) only this server's memory holds it.
        let fallback = 'none';
        // (filed under the cycle that is open, so it is in that cycle's view; `named` is what the request named)
        const record = () => s.event({ cycle: isCycle(attribution.open) ? attribution.open : null, named: cycleOf, ...attribution, kind: 'refusal_not_recorded', reason, authenticated: true, nonce, ts: Number(ts) });
        if (why === null) {
          try {
            // Under the lock when it can be had; without it otherwise: it is one append, like an acknowledgement.
            // (a short wait only: this may run outside the lock, on the acknowledgement path, and must not hold the server)
            try { withDirLock(dir, record, { timeoutMs: Math.min(lockTimeoutMs, 250) }); } catch (e) { if (e?.status !== 503) throw e; record(); }
            fallback = 'event';
          } catch { /* the event ledger cannot take it either */ }
        }
        // A contradiction after a result (see `afterResultOf`) that neither ledger took goes to a place of its own, and
        // failing that is held in this server's memory (never described as recorded).
        if (fallback === 'none' && attribution.afterResultOf?.length) {
          const rec = { kind: 'contradiction_after_result', afterResultOf: attribution.afterResultOf, reason, path: info.path, authenticated: true, nonce, ts: Number(ts), at: new Date().toISOString(), atMs: Date.now(), mono: monoMs() };
          try { writeContradictionMarker(dir, run, rec); fallback = 'contradiction_marker'; } catch { rs.held.push(rec); console.error(`recorder: a contradiction of a stored result could be written NOWHERE (${String(attribution.afterResultOf)}). It is held in memory only: this server stores no PASS, records no recovery and starts no cycle for the run until it is written. A RESTART NOW LOSES IT. Stop and report; do not restart the recorder until it is written`); }
        }
        if (fallback === 'none') {
          markLost('an authenticated refusal could not be recorded', true);
        }
        return why === 'stale_timestamp' ? plain(500, 'refusal_not_recorded') : reply(500, { error: 'refusal_not_recorded', refused: reason, fallback });
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
        if (req.method === 'GET' && rest === '') return reply(200, runStatus(s, { held: rs.held }));
        if (req.method === 'GET' && cm && !cm[2]) return isCycle(n) ? reply(200, cycleView(s, n, { silentStopMs, memoryDamage: rs.cycles.get(n)?.memoryDamage ?? rs.lost ?? null, held: rs.held })) : refuse(400, 'invalid_cycle');
        if (req.method !== 'POST') return refuse(405, 'method_not_allowed');
        // Read, decide and write as one step with respect to the operator commands (attest, create-run, abandon, cut):
        // they take the same lock. Acknowledgements only append to their own stream and stay outside it.
        const post = () => {
        const run0 = s.run();
        const events = s.events();
        const { last, open } = openCycle(s, events);

        if (cm?.[2] === 'start') {
          if (!isCycle(n)) return refuse(400, 'invalid_cycle');
          if (rs.held.length) return refuse(409, 'contradiction_after_a_result_not_recorded');
          if (s.stopped()) return refuse(409, 'run_stopped');
          // No cycle starts beside a ledger that ends in a fragment (a writer died mid-line): nothing more can be appended
          // to it, so the cycle would depend on records this recorder cannot write. Found here, before anything is seeded.
          // Which ledgers: the run's own (events, rejections, accepted claims) and the volume registry. Not another
          // cycle's acknowledgement file (that cycle was judged with it) and not the recorder-wide rejection log
          // (unauthenticated noise): `verify-dir` reports those too, but they stop no cycle.
          const blocking = [...['events.jsonl', 'rejections.jsonl', 'accepted.jsonl'].map((f) => [`runs/${run}/${f}`, runLedgerProblemOf(path.join(s.root, f))]), ['volumes.jsonl', ledgerProblemOf(registryFile(dir))]].find(([, problem]) => problem);
          if (blocking) return refuse(409, `${blocking[1].startsWith('ends') ? 'recorder_ledger_ends_in_a_fragment' : 'recorder_ledger_cannot_be_read'}: ${blocking[0]}`);
          // The result and the stop marker are two writes. If the recorder died between them, the result still decides.
          if (s.results().some((r) => r.verdict === 'FAIL' || (r.verdict === 'INCONCLUSIVE' && (run0.stopOnInconclusive ?? QUALIFYING_MODELS.includes(run0.failureModel))))) return refuse(409, 'run_has_a_result_that_stops_it');
          if (QUALIFYING_MODELS.includes(run0.failureModel) && !storageQualifies(run0.storage)) return refuse(409, 'storage_not_qualifying');
          if (run0.continues && !events.some((e) => e.kind === 'adopted')) return refuse(409, 'not_adopted');
          // A run never starts on volumes it neither created (init, which refuses a non-empty database) nor adopted.
          if (!run0.continues && !events.some((e) => e.kind === 'initialised')) return refuse(409, 'not_initialised');
          // Every cycle runs on the volumes the series started on.
          if (volumeOf(dir, run0.rootRun ?? run0.run)?.pgSystemId !== String(body.pgSystemId ?? '')) return refuse(409, 'volume_differs_from_series');
          if (run0.failureModel === 'POWER-CUT') {
            const have = new Set(events.filter((e) => e.kind === 'attestation').map((e) => e.item));
            if (REQUIRED_ATTESTATIONS.some((x) => !have.has(x))) return refuse(409, 'attestations_missing');
          }
          // A qualifying cycle starts only on exactly the configuration a successful preflight recorded for THIS run.
          // The recorder's half is recomputed now; the test machine's half is what it reports for this start.
          let bindingDigest = null, noted = null, sizing = body.sizing ?? null;
          if (run0.failureModel === 'POWER-CUT') {
            const ready = acceptedReadiness(events);
            if (!ready) return refuse(409, 'readiness_missing');
            const { test, problems } = vetTestBinding(body.readiness);
            if (problems.length) return refuse(409, `readiness_not_ready: ${problems[0]}`.slice(0, 200));
            const idw = identityRefusal(run0, test);
            if (idw) return refuse(409, idw);
            const current = { test, recorder: recorderBindingOf(dir, run0.run) };
            const changed = bindingDiff(ready.binding, current);
            if (changed.length || digestOf(current) !== ready.digest) return refuse(409, `readiness_stale: ${changed.join(', ') || 'digest'}`.slice(0, 200));
            const w = test.workload;
            // Decision B1 again, at every start and not only when the record was accepted: one process, one worker, a
            // burst pattern. A record that says otherwise (it could only have been written into the ledger by hand)
            // starts nothing.
            const shape = qualifyingWorkloadProblems(w);
            if (shape.length) return refuse(409, `readiness_not_ready: workload: ${shape[0]}`.slice(0, 200));
            if (body.workers !== w.workers || !/^[a-z]$/.test(body.proc ?? '') || body.proc.charCodeAt(0) - 97 >= w.procs) return refuse(409, 'start_differs_from_ready_workload');
            // The backstop of the series plan: the test machine counts what clearance would have to process NOW and what
            // this start would seed, refuses by itself before it seeds anything (p7.mjs), and reports both numbers. This
            // host cannot see the database, so it checks what is reported: a count that is malformed, that is not for
            // the recorded pool, or that passes the envelope starts nothing. `p7.mjs` always reports it.
            const cap = body.capacity;
            if (cap !== undefined && cap !== null) {
              if (!Number.isInteger(cap.affected) || cap.affected < 0 || !Number.isInteger(cap.adding)) return refuse(409, 'capacity_malformed');
              if (cap.adding !== w.workers * w.poolPerWorker) return refuse(409, 'capacity_differs_from_ready_workload');
              if (cap.affected + cap.adding > CLEARANCE_ENVELOPE) return refuse(409, 'series_capacity_exceeded');
            }
            bindingDigest = ready.digest;
            // What the recorder keeps as this start's sizing is the bound workload, whatever else the request says: the
            // cut's timing limit and the throughput report are computed from it.
            sizing = { ...(sizing && typeof sizing === 'object' ? sizing : {}), workers: w.workers, maxSeconds: w.maxSeconds, headroom: w.headroom, ratePerWorker: w.ratePerWorker, targetRate: w.targetRate, poolPerWorker: w.poolPerWorker, burstPeriodSeconds: w.burstPeriodSeconds, burstSeconds: w.burstSeconds, quietRate: w.quietRate };
          } else if (body.readiness) { noted = vetTestBinding(body.readiness).test; bindingDigest = `unenforced:${digestOf(noted)}`; } // a rehearsal shows what stays the same across reboots
          if (run0.continues && body.dbHead < run0.continues.finalState.head) return refuse(409, 'head_below_predecessor');
          if (!/^[a-z]$/.test(body.proc ?? '') || !Number.isInteger(body.workers) || body.workers < 1 || body.workers > 12 || !Number.isInteger(body.dbHead) || body.dbHead < 0) return refuse(400, 'invalid_start');
          if (open && open !== n) return refuse(409, `cycle_${open}_is_open`);
          if (!open && n !== last + 1) return refuse(409, 'cycles_must_be_consecutive');
          if (!open && n > 1) {
            const prev = cycleView(s, n - 1, { silentStopMs });
            if (!prev.recovered) return refuse(409, 'previous_cycle_not_recovered');
          }
          if (events.some((e) => e.cycle === n && e.kind === 'cut_sent')) return refuse(409, 'cycle_already_cut');
          if (startsOf(events, n).some((e) => e.proc === body.proc)) return refuse(409, 'process_already_started_in_cycle');
          // `vet`: every check above, nothing recorded. The harness asks this before it seeds a single action, so a refusal
          // leaves the database untouched and the same start can be retried.
          if (body.vet === true) return reply(200, { vetted: true });
          const cycleId = startsOf(events, n)[0]?.cycleId ?? randomBytes(16).toString('hex');
          if (beforeStartWrite) beforeStartWrite(); // tests only: the lock is held here
          s.event({ cycle: n, kind: 'cycle_start', cycleId, pgSystemId: String(body.pgSystemId ?? ''), startId: typeof body.startId === 'string' ? body.startId.slice(0, 64) : null, proc: body.proc, workers: body.workers, dbHead: body.dbHead, capacity: body.capacity && Number.isInteger(body.capacity.affected) && Number.isInteger(body.capacity.adding) ? { affected: body.capacity.affected, adding: body.capacity.adding } : null, journalHead: body.journalHead ?? null, settings: body.settings ?? null, sizing, bindingDigest, ...(noted ? { bindingNoted: noted } : {}), bootId: String(body.bootId ?? '').slice(0, 64), clockOffsetMs: body.clockOffsetMs ?? null, ...stamp });
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
          const next = nextStream(c.streams.get(streamKey(a)), a, n, run0.run);
          if (next.error) return refuse(409, next.error);
          if (a.kind === 'claim' && c.claimSeqs.has(a.seq)) return refuse(409, 'duplicate_claim_seq');
          // If the write or its sync fails, what is in the file is unknown to this process (the line may be there,
          // whole or in part). The cycle's acknowledgement file is then damaged for good: nothing more is accepted in
          // this cycle, so no line can be written twice. The worker gets an error and stops; the cycle is inconclusive.
          try { s.ack({ ...a, ...stamp }); } catch (e) { c.damaged = c.memoryDamage = `an acknowledgement could not be stored (${String(e.code ?? e.message).slice(0, 60)})`; throw e; }
          c.streams.set(streamKey(a), next.st);
          if (a.kind === 'claim') c.claimSeqs.add(a.seq);
          return reply(200, { ok: true }); // only after the fsync in s.ack
        }

        if (rest === 'event') {
          if (!EVENT_KINDS.includes(body.kind)) return refuse(400, 'invalid_event');
          // A journal write failure is always a fact about the cycle that is open (started, not yet checked).
          if (body.kind === 'journal_write_failed' && !(isCycle(n) && n === open)) return refuse(400, 'journal_write_failed_needs_its_cycle');
          // An event that names a cycle belongs to a cycle that HAS STARTED, and says so with that cycle's own id, as a
          // string. Without this an event sent ahead of a cycle (no id: `undefined` equals `undefined`) was stored and
          // later counted against the real cycle. A worker stop is, further, only a fact about the cycle that is open.
          if (body.kind === 'worker_stopped' && (body.cycle === null || body.cycle === undefined)) return refuse(400, 'worker_stopped_needs_its_cycle');
          if (body.cycle !== null && body.cycle !== undefined) {
            const actual = isCycle(n) ? startsOf(events, n)[0]?.cycleId : undefined;
            if (typeof actual !== 'string') return refuse(409, 'cycle_not_started');
            if (typeof body.cycleId !== 'string' || body.cycleId !== actual) return refuse(409, 'wrong_cycle_id');
            if (body.kind === 'worker_stopped' && n !== open) return refuse(409, 'cycle_not_open');
          }
          // A stopped run (failed, inconclusive or abandoned) never claims, initialises or adopts anything.
          if (['volume_claimed', 'initialised', 'adopted'].includes(body.kind) && s.stopped()) return refuse(409, 'run_stopped');
          if (['volume_claimed', 'initialised'].includes(body.kind) && run0.continues) return refuse(409, 'continuing_run_uses_adopt');
          if (body.kind === 'volume_claimed') {
            // Before `init` creates anything: the volumes must be new to the recorder and, for a qualifying run, empty and unused.
            if (volumeOf(dir, run0.run)) return refuse(409, 'already_claimed');
            const vol = body.volume ?? {};
            if (!/^\d{10,24}$/.test(String(vol.pgSystemId ?? ''))) return refuse(400, 'volume_identity_missing');
            const owner = volumeOwner(dir, vol.pgSystemId);
            if (owner) return refuse(409, `volume_already_used_by_${owner.run}`);
            if (QUALIFYING_MODELS.includes(run0.failureModel) && freshVolumeProblems(vol).length) return refuse(409, 'volume_not_fresh');
            registerVolume(dir, { pgSystemId: String(vol.pgSystemId), run: run0.run, failureModel: run0.failureModel, emptyStateEvidence: { publicRelations: vol.publicRelations ?? null, stateEntries: vol.stateEntries ?? null, walLsnBytes: vol.walLsnBytes ?? null, serverVersion: String(vol.serverVersion ?? '').slice(0, 40) } });
          }
          if (body.kind === 'initialised' && !volumeOf(dir, run0.run)) return refuse(409, 'volume_not_claimed');
          if (body.kind === 'initialised' && events.some((e) => e.kind === 'initialised')) return refuse(409, 'already_initialised');
          if (body.kind === 'adopted') {
            if (!run0.continues) return refuse(409, 'not_a_continuing_run');
            if (events.some((e) => e.kind === 'adopted')) return refuse(409, 'already_adopted');
            if (!sameState(run0.continues.finalState, body.finalState)) return refuse(409, 'state_differs_from_predecessor');
            if (volumeOf(dir, run0.rootRun)?.pgSystemId !== String(body.pgSystemId ?? '')) return refuse(409, 'volume_differs_from_series');
          }
          if (body.kind === 'quarantine_observed') {
            const r = s.result(n);
            if (!r?.quarantineRequired || recoveryOf(events, n)) return refuse(409, 'no_quarantine_expected');
          }
          s.event({ cycle: body.cycle ?? null, cycleId: body.cycleId ?? null, kind: body.kind, detail: String(body.detail ?? '').slice(0, 500), proc: String(body.proc ?? ''), worker: body.worker ?? null, ...(body.kind === 'adopted' ? { finalState: body.finalState } : {}), ...(body.kind === 'volume_claimed' ? { pgSystemId: String(body.volume.pgSystemId) } : {}), ...(body.kind === 'initialised' ? { installationId: String(body.installationId ?? '').slice(0, 64) } : {}), ...stamp });
          return reply(200, { ok: true });
        }

        if (rest === 'readiness') {
          // Sent by `p7.mjs preflight` when its own verdict is ready. The recorder checks everything it can itself and
          // stores the record in this run's ledger. It is never taken on the test machine's word, and never for another run.
          if (run0.failureModel !== 'POWER-CUT') return refuse(409, 'readiness_is_for_power_cut_runs');
          if (s.stopped()) return refuse(409, 'run_stopped');
          if (events.some((e) => e.kind === 'cycle_start')) return refuse(409, 'readiness_only_before_the_first_cycle');
          if (!recorderId(dir)) return refuse(409, 'recorder_identity_missing');
          if (!storageQualifies(run0.storage)) return refuse(409, 'storage_not_qualifying');
          if (!events.some((e) => e.kind === (run0.continues ? 'adopted' : 'initialised'))) return refuse(409, run0.continues ? 'not_adopted' : 'not_initialised');
          const have = new Set(events.filter((e) => e.kind === 'attestation').map((e) => e.item));
          if (REQUIRED_ATTESTATIONS.some((x) => !have.has(x))) return refuse(409, 'attestations_missing');
          const { test, problems } = vetTestBinding(body.test);
          if (problems.length) return refuse(409, `readiness_not_ready: ${problems.join('; ')}`.slice(0, 300));
          const shape = qualifyingWorkloadProblems(test.workload);
          if (shape.length) return refuse(409, `readiness_not_ready: workload: ${shape.join('; ')}`.slice(0, 300));
          const idw = identityRefusal(run0, test);
          if (idw) return refuse(409, idw);
          if (volumeOf(dir, run0.rootRun ?? run0.run)?.pgSystemId !== test.pgSystemId) return refuse(409, 'volume_differs_from_series');
          const binding = { test, recorder: recorderBindingOf(dir, run0.run) };
          const digest = digestOf(binding);
          // The first accepted record is the run's configuration for good. The same configuration again is confirmed
          // and nothing is written; anything else is refused, and the record that exists stays as it is.
          const prior = acceptedReadiness(events);
          if (prior) {
            const changed = bindingDiff(prior.binding, binding);
            if (!changed.length && prior.digest === digest) return reply(200, { digest, binding, unchanged: true });
            return refuse(409, `readiness_already_recorded: ${changed.join(', ') || 'digest'}`.slice(0, 300));
          }
          // The calculation of the series plan is stored with the record (it follows from the bound workload).
          s.event({ cycle: null, kind: 'readiness', binding, digest, plan: seriesPlanOf(test.workload), ...stamp });
          return reply(200, { digest, binding });
        }

        if (rest === 'volume-check') {
          // Read-only (preflight): who, if anyone, these volumes are registered to. Nothing is recorded.
          const owner = volumeOwner(dir, body.pgSystemId);
          return reply(200, { registeredTo: owner?.run ?? null, registeredModel: owner?.failureModel ?? null });
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
          // What this host was told about the cycle decides with the check: a cycle in which a worker reported a journal
          // write failure is never recorded as a PASS, whatever the test machine concludes (its marker may be gone).
          if (body.verdict === 'PASS' && events.some((e) => e.cycle === n && e.kind === 'journal_write_failed')) return refuse(409, 'pass_contradicts_a_recorded_journal_write_failure');
          // Nor beside what the check itself found: the marker of a failed journal write, or the reports it was shown.
          const reportsNone = (v) => v === undefined || v === null || (Array.isArray(v) && v.length === 0); // anything else is a report, whatever its type
          if (body.verdict === 'PASS' && (body.journalWriteFailure || !reportsNone(body.journalWriteFailuresReported))) return refuse(409, 'pass_reports_a_journal_write_failure');
          // Nor beside a torn final journal line the check found it cannot repair: that cycle is INCONCLUSIVE.
          if (body.verdict === 'PASS' && body.tornTailRepairProblem) return refuse(409, 'pass_reports_a_torn_tail_that_cannot_be_repaired');
          // Nor for a cycle this server marked damaged (an acknowledgement or an authenticated refusal it could not store).
          // Nor for a cycle a recorder process took over while it was open (this one: `tookOver`; an earlier one: its
          // event, which the view reads): what the process before it knew only in memory is lost.
          const view = body.verdict === 'PASS' ? cycleView(s, n, { silentStopMs, memoryDamage: cycleState(s, rs, n).memoryDamage ?? rs.lost ?? (rs.held.length ? 'a contradiction after a result is held in memory only' : null), held: rs.held }) : null;
          if (view && (cycleState(s, rs, n).damaged || rs.tookOver === n || view.damaged)) return refuse(409, 'pass_for_a_cycle_the_recorder_marked_damaged');
          // Nor for a cycle in which this recorder refused an authenticated request while the cycle was open (approved
          // by the product owner as the gate behind `check`, which makes such a cycle INCONCLUSIVE when it computes a
          // verdict and re-vets a saved PASS before sending it). A refusal that is on record (in the rejection log, or
          // in the event kept in its place) is counted by any recorder process. One that could be recorded nowhere
          // is known only to the process that made it; a process that restarts with the cycle open therefore stores
          // no PASS for it at all (above), whether or not such a refusal happened.
          if (view && view.authenticatedRejections > 0) return refuse(409, 'pass_for_a_cycle_with_authenticated_rejections');
          // Nor against what this host itself holds about the cut and the workers (each makes the cycle INCONCLUSIVE
          // when `check` computes the verdict; a PASS that was computed earlier, or by anything else, is held to it):
          // no cut on record, a cut whose LAST confirmation is not "yes", a worker that reported a stop before the cut
          // or went silent before it.
          if (view && !view.cutRequestedAt) return refuse(409, 'pass_for_a_cycle_without_a_recorded_cut');
          if (view && view.cutConfirmed !== 'yes') return refuse(409, 'pass_for_a_cycle_whose_cut_is_not_confirmed');
          if (view && (view.workerStopsBeforeCut.length || view.silentWorkerStops.length)) return refuse(409, 'pass_for_a_cycle_whose_workload_stopped_before_the_cut');
          // Rulings A, B and C (passEvidenceProblem). Everything from the view above to the store below runs in one
          // synchronous step of this process, under the directory lock: no other request of this server and no
          // operator command can add a record in between. What arrived since `check` read its view is caught by the
          // evidence mark; what arrives after the store contradicts the stored PASS (contradictionsAfterResult).
          const evidenceProblem = view ? passEvidenceProblem({ dir, run0, view, body, allEvents: events }) : null;
          if (evidenceProblem) return refuse(409, evidenceProblem);
          // The failure model comes from THIS host's run record, never from the test machine.
          s.saveResult(n, { ...body, cycle: n, failureModel: run0.failureModel, reportedFailureModel: body.failureModel ?? null, countsTowardPhysicalPowerLoss: false, recordedAt: new Date().toISOString(), ...stamp });
          if (body.verdict === 'FAIL') s.stop({ kind: 'fail', cycle: n, reason: 'cycle failed', fails: body.fails });
          else if (body.verdict === 'INCONCLUSIVE' && (run0.stopOnInconclusive ?? QUALIFYING_MODELS.includes(run0.failureModel))) {
            s.stop({ kind: 'inconclusive', cycle: n, reason: 'series broken: INCONCLUSIVE. Recover this cycle, investigate and resolve the cause, then create a new run that continues this one (the count restarts at zero; the database and journal are kept)', inconclusive: body.inconclusive });
          }
          return reply(200, { ok: true, stopped: !!s.stopped() });
        }

        if (cm?.[2] === 'recovered') {
          if (rs.held.some((h) => contradicts(h, n))) return refuse(409, 'contradiction_after_a_result_not_recorded');
          // Nor while the rejection log cannot be read (it may hold a contradiction), or, for a PASS, while this server
          // knows of something it could record nowhere.
          try { s.rejections(); } catch { return refuse(409, 'recorder_ledger_cannot_be_read: rejections.jsonl'); }
          if (rs.lost && s.result(n)?.verdict === 'PASS') return refuse(409, 'recorder_holds_an_unrecorded_refusal');
          // A run stopped by an INCONCLUSIVE cycle may still recover that cycle (so its state can be continued); nothing else.
          const stp = s.stopped();
          if (stp && !(stp.kind === 'inconclusive' && stp.cycle === n)) return refuse(409, 'run_stopped');
          if (events.some((e) => e.kind === 'recovery_failed')) return refuse(409, 'recovery_failed_earlier');
          // The same known failure ends recovery: nothing is repaired, cleared or continued on top of a journal write
          // whose outcome is unknown (`p7.mjs recover` stops for the same reason, before it changes anything).
          if (events.some((e) => e.cycle === n && e.kind === 'journal_write_failed')) return refuse(409, 'journal_write_failed_in_this_cycle');
          // ... or that the check itself recorded with its result: the marker may be gone by the time recovery runs.
          const stored = s.result(n);
          if (stored && (stored.journalWriteFailure || !(stored.journalWriteFailuresReported === undefined || stored.journalWriteFailuresReported === null || (Array.isArray(stored.journalWriteFailuresReported) && stored.journalWriteFailuresReported.length === 0)))) return refuse(409, 'journal_write_failed_in_this_cycle');
          if (!validState(body.finalState)) return refuse(400, 'final_state_missing');
          const r = s.result(n);
          if (!r || r.verdict === 'FAIL') return refuse(409, 'nothing_to_recover');
          // A cycle whose torn final line cannot be repaired is never recorded as recovered: nothing was repaired.
          if (r.tornTailRepairProblem) return refuse(409, 'torn_tail_cannot_be_repaired');
          if (body.cycleId !== startsOf(events, n)[0]?.cycleId) return refuse(409, 'wrong_cycle_id');
          if (recoveryOf(events, n)) return refuse(409, 'already_recovered');
          if (r.quarantineRequired) {
            if (!events.some((e) => e.cycle === n && e.kind === 'quarantine_observed')) return refuse(409, 'quarantine_not_observed');
            if (body.cleared !== true || body.uncommitted?.seq !== r.uncommitted?.seq || body.uncommitted?.actionId !== r.uncommitted?.actionId) return refuse(409, 'clearance_not_shown');
            // Once: a report repeated after its event could not be written must not record the accepted claim again.
            if (!s.accepted().some((u) => u.cycle === n && u.seq === r.uncommitted.seq && u.actionId === r.uncommitted.actionId && !u.fromRun)) s.accept({ cycle: n, seq: r.uncommitted.seq, actionId: r.uncommitted.actionId, digest: body.digest ?? null });
          }
          s.event({ cycle: n, kind: 'recovered', cycleId: body.cycleId, steps: body.steps ?? [], cleared: body.cleared === true, finalState: body.finalState, summary: body.summary ?? null, ...stamp });
          return reply(200, { ok: true, final: cycleView(s, n, { silentStopMs, held: rs.held }).final });
        }

        if (rest === 'stop') {
          // The stop marker is write-once (the run may already be stopped as inconclusive), so the failure is also an event.
          // The marker first: it is a file of its own, so the run is stopped even when the event ledger cannot be
          // written (the request is then answered with that error, and the stop stands).
          s.stop({ kind: 'recovery-failed', cycle: Number.isInteger(body.cycle) ? body.cycle : null, reason: String(body.reason ?? 'stopped').slice(0, 300), ...stamp });
          s.event({ cycle: Number.isInteger(body.cycle) ? body.cycle : null, kind: 'recovery_failed', detail: String(body.reason ?? '').slice(0, 300), ...stamp });
          return reply(200, { ok: true });
        }
        return refuse(404, 'not_found');
        };
        return rest === 'ack' ? post() : withDirLock(dir, post, { timeoutMs: lockTimeoutMs });
      } catch (e) {
        // (an error with a status, like "busy", is an answer, not a fault: nothing was decided or written for it)
        // An acknowledgement or a worker's report that was not handled is refused here instead: on record with its
        // attribution, so it counts against the open cycle and contradicts a decided cycle it is about.
        const reportOfWork = m[2] === 'ack' || !!signal.signal;
        if (!e.status) { noteHandlerError(e); markLost('an authenticated request could not be handled, and what it reported could not be recorded'); if (reportOfWork) return refuse(500, 'recorder_error'); }
        // "Busy" (an operator command holds the lock) is repeated by the sender, except that a worker's report of its
        // stop is sent once and a journal failure only for about a minute: such a report that was answered "busy" is
        // held in memory against the open cycle, so it is not lost if it never arrives again.
        else if (e.status === 503) { if (signal.signal) { markLost(`a ${signal.signal} report was answered "busy" and not recorded`); return refuse(503, 'recorder_busy'); } }
        // Any other error with a status (an inconsistent volume registry) refused the request outside the ordinary
        // path: nothing is written to the run while the registry is in that state, so it is held in memory against
        // the open cycle.
        else markLost('a request was refused because the volume registry is inconsistent, and the refusal was not recorded');
        // An operating-system error message carries a path of this host: only its code is answered.
        return reply(e.status ?? 500, { error: e.path ? `recorder file error (${e.code ?? 'error'})` : String(e.message).slice(0, 200) });
      }
    };
  });
  /** How many contradictions after a result this server holds in memory only (none may be lost by stopping it). */
  server.heldContradictions = () => [...cache.values()].reduce((sum, r) => sum + r.held.length, 0) + [...orphanHeld.values()].reduce((sum, l) => sum + l.length, 0);
  return server;
}

/** The cut must come within the time every process sized its action pool for (run --max-seconds). */
export function cutRefusal(view, maxDelayMs, nowMs) {
  const sized = view.starts.filter((x) => Number.isFinite(x.sizing?.maxSeconds));
  if (sized.length !== view.starts.length) return 'refused: a process in this cycle did not report its workload sizing';
  const latest = Math.max(...view.starts.map((x) => (nowMs - x.atMs + maxDelayMs) / 1000));
  const sizedFor = Math.min(...sized.map((x) => x.sizing.maxSeconds));
  return latest > sizedFor ? `refused: the cut could come ${Math.ceil(latest)} s after a process started, but its action pool was sized for ${sizedFor} s (run --max-seconds). Use a shorter --max-seconds here, or check and restart the cycle with a larger one` : null;
}

// ───────────────────────────── operator commands (run on the recorder host) ─────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const { values: a } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string' }, run: { type: 'string' }, cycle: { type: 'string' }, host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '8787' },
      'failure-model': { type: 'string' }, machine: { type: 'string' }, operator: { type: 'string' },
      'min-seconds': { type: 'string' }, 'max-seconds': { type: 'string' }, 'command-json': { type: 'string' }, 'power-was-cut': { type: 'string' }, evidence: { type: 'string' }, 'attested-from': { type: 'string' }, 'attested-to': { type: 'string' },
      'storage-json': { type: 'string' }, item: { type: 'string' }, continues: { type: 'string' }, 'stop-on-inconclusive': { type: 'boolean' },
      'new-directory': { type: 'boolean' }, backup: { type: 'string' }, 'allow-growth': { type: 'boolean' }, reason: { type: 'string' }, 'source-commit': { type: 'string' }, 'package-sha256': { type: 'string' }, 'image-id': { type: 'string' }, 'image-arch': { type: 'string' }, package: { type: 'string' },
    },
  });
  if (!a.dir) throw new Error('--dir is required');
  if (cmd === 'verify-dir') {
    // Read-only. Exit 1 on any problem: the operator stops (README, "The recorder directory").
    const report = dirReport(a.dir);
    if (a.backup) report.backup = { dir: a.backup, mode: a['allow-growth'] ? 'the live directory may only have grown' : 'exact copy', ...compareBackup(a.dir, a.backup, { allowGrowth: a['allow-growth'] }) };
    console.log(JSON.stringify(report, null, 2));
    if (report.problems.length || report.backup?.problems.length) process.exit(1);
    return;
  }
  // A recorder directory is never created by accident: a missing or empty one means the experiment's history is not
  // here (wrong path, unmounted disk, replaced directory). Only --new-directory starts a new one, and only when empty.
  const state = dirState(a.dir);
  if (state === 'damaged') throw new Error(`refused: ${a.dir} holds recorder files (a registry or keys) but no runs and no identity. Its history was removed. STOP: change nothing and restore nothing over it (see README)`);
  if (a['new-directory'] && state === 'recorder') throw new Error(`refused: --new-directory, but ${a.dir} already holds a recorder. Use it without that flag`);
  if (state !== 'recorder' && !(a['new-directory'] && ['serve', 'create-run'].includes(cmd))) throw new Error(`refused: the recorder directory ${a.dir} is ${state}. If it should hold this experiment's runs, STOP: it is missing or was replaced (restore nothing over it; see README). To start a new recorder, pass --new-directory to serve and to the first create-run`);
  if (cmd === 'serve') {
    // One server per directory: each keeps the accepted nonces and the acknowledgement streams of open cycles in memory.
    const serving = path.join(a.dir, `${LOCK_FILE}.serving`);
    fs.mkdirSync(a.dir, { recursive: true });
    withDirLock(a.dir, () => {
      let pid = null;
      try { pid = Number(fs.readFileSync(serving, 'utf8')); } catch { /* none */ }
      let running = false;
      if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); running = true; } catch (e) { running = e.code === 'EPERM'; } }
      if (running) throw new Error(`refused: a recorder (process ${pid}) is already serving ${a.dir}. One server per directory`);
      fs.writeFileSync(serving, String(process.pid));
    });
    process.on('exit', () => { try { if (Number(fs.readFileSync(serving, 'utf8')) === process.pid) fs.unlinkSync(serving); } catch { /* nothing to remove */ } });
    const server = createRecorder(a.dir);
    // A contradiction of a stored result that could be written nowhere lives only in this process: it does not stop on
    // an ordinary signal while it holds one (it keeps trying to write it at every request). SIGKILL still ends it, and
    // then the contradiction is lost (README, "Limits").
    // Every catchable signal whose default is to end the process. Not: SIGKILL and SIGSTOP (cannot be caught), SIGUSR1
    // (reserved by Node for its debugger), and the fatal ones (a crash). Names a platform lacks are skipped.
    // (Not SIGPIPE: Node ignores it, and a handler would let a broken connection end the server. Not SIGPROF or SIGTRAP:
    // profilers and debuggers send them.)
    process.stderr.on('error', () => { /* a closed stderr must not end a server that holds something */ });
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGUSR2', 'SIGALRM', 'SIGVTALRM', 'SIGXCPU', 'SIGXFSZ', 'SIGIO', 'SIGPOLL', 'SIGPWR', 'SIGSTKFLT', 'SIGSYS']) {
      try {
        process.on(sig, () => {
          const held = server.heldContradictions();
          if (!held) process.exit(0);
          console.error(`recorder: NOT stopping on ${sig}: ${held} contradiction(s) of a stored result are held in memory only and would be lost. Restore the recorder's storage; they are written at the next request. Stop and report`);
        });
      } catch { /* not a signal on this platform */ }
    }
    // An error of the listening socket (for example too many open files) is reported, never fatal once listening.
    server.on('error', (e) => { console.error(`recorder: server error (${String(e?.code ?? e?.name ?? 'error')})`); if (!server.listening) process.exit(1); });
    server.listen(Number(a.port), a.host, () => console.log(`P7 recorder on ${a.host}:${a.port}, storing in ${a.dir}`));
    return;
  }
  if (cmd === 'create-run') {
    const storage = a['storage-json'] ? JSON.parse(fs.readFileSync(a['storage-json'], 'utf8')) : undefined;
    const r = createRun(a.dir, { run: a.run, failureModel: a['failure-model'], storage, continues: a.continues, stopOnInconclusive: a['stop-on-inconclusive'], machine: a.machine, operator: a.operator,
      identity: { sourceCommit: a['source-commit'], packageSha256: a['package-sha256'], imageId: a['image-id'], imageArch: a['image-arch'] }, package: a.package });
    // The key itself is never printed: copy the file to the test machine (P7_KEY_FILE_HOST), mode 0600.
    console.log(JSON.stringify({ run: r.run, keyFile: r.keyFile }, null, 2));
    return;
  }
  const s = runStore(a.dir, a.run);
  if (!s.exists()) throw new Error('unknown run');
  const n = Number(a.cycle);
  const locked = (fn) => withDirLock(a.dir, fn); // the same lock as the server's handlers: read, decide, write
  if (cmd === 'cut') {
    if (!isCycle(n)) throw new Error('--cycle');
    const cmdArgv = parseCutCommand(a['command-json']); // understood before anything is scheduled
    const delayMs = locked(() => {
    if (s.stopped()) throw new Error('run is stopped');
    const v = cycleView(s, n);
    if (!v.starts.length) throw new Error(`cycle ${n} has not started`);
    if (v.result) throw new Error(`cycle ${n} was already checked`);
    if (v.cutRequestedAt) throw new Error(`cycle ${n} was already cut`);
    // One cut per cycle. A cut that is still waiting for its moment (its process is running) blocks another; one whose
    // process is gone never sent anything, so its schedule is void.
    const pending = s.events().filter((e) => e.cycle === n && e.kind === 'cut_scheduled').at(-1);
    if (pending && alive(pending.pid)) throw new Error(`cycle ${n} already has a cut scheduled (process ${pending.pid}, still waiting for its moment). It was not scheduled again`);
    const lo = Math.round(Number(a['min-seconds']) * 1000), hi = Math.round(Number(a['max-seconds']) * 1000);
    if (!(lo >= 0 && hi >= lo)) throw new Error('--min-seconds and --max-seconds are required');
    const why = cutRefusal(v, hi, Date.now());
    if (why) throw new Error(why);
    const d = randomInt(lo, hi + 1);
    s.event({ cycle: n, kind: 'cut_scheduled', delayMs: d, pid: process.pid });
    return d;
    });
    console.log(`cycle ${n}: cut in ${(delayMs / 1000).toFixed(1)} s`);
    await sleep(delayMs);
    // The wait is over, and the cycle may have moved on meanwhile. Check again, and record the cut, as one step.
    locked(() => {
      if (s.stopped()) throw new Error(`the run was stopped while the cut was waiting: nothing was cut`);
      const now = cycleView(s, n);
      if (now.result) throw new Error(`cycle ${n} was checked while the cut was waiting: nothing was cut`);
      if (now.cutRequestedAt) throw new Error(`cycle ${n} was already cut`);
      s.event({ cycle: n, kind: 'cut_sent', how: cmdArgv ? 'command' : 'manual prompt' });
    });
    if (cmdArgv) {
      // The command line is not recorded (a plug's local URL may carry a token); only its exit status.
      const r = spawnSync(cmdArgv[0], cmdArgv.slice(1), { timeout: 30_000, stdio: 'ignore' });
      s.event({ cycle: n, kind: 'cut_command_finished', status: r.status, error: r.error ? String(r.error.code ?? 'error') : null });
      console.log(`cut command exited with ${r.status}`);
    } else {
      console.log(`\n*** CUT THE POWER NOW ***  (requested at ${new Date().toISOString()})\n`);
      console.log('Note the time you cut it. Afterwards: confirm-cut --power-was-cut yes --attested-from <ISO time> [--attested-to <ISO time>] --evidence "<what you saw>"');
    }
  } else if (cmd === 'confirm-cut') {
    if (!['yes', 'no'].includes(a['power-was-cut'])) throw new Error('--power-was-cut yes|no');
    locked(() => {
    if (!cycleView(s, n).cutRequestedAt) throw new Error('no cut recorded for this cycle');
    // The result was decided with the confirmation as it stood: afterwards it is not changed (a "no" recorded after a
    // stored PASS would leave that PASS standing). If the confirmation was wrong, stop and report; do not edit the ledger.
    if (s.result(n)) throw new Error('refused: this cycle already has its result; the confirmation of its cut can no longer be changed. Nothing was recorded');
    // An operator attestation, recorded as such. It is not independent evidence of the cut.
    // Optional: when the operator saw the power go, as one instant (--attested-from only) or an interval.
    let attested = null;
    if (a['attested-from']) {
      const from = new Date(a['attested-from']), to = new Date(a['attested-to'] ?? a['attested-from']);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) throw new Error('--attested-from / --attested-to must be ISO times, from <= to');
      attested = { from: from.toISOString(), to: to.toISOString(), label: 'operator attestation, not an independent observation' };
    }
    s.event({ cycle: n, kind: 'cut_confirmed', powerWasCut: a['power-was-cut'], operatorEvidence: (a.evidence ?? '').slice(0, 500), operatorAttestedCut: attested, attestation: 'operator' });
    });
  } else if (cmd === 'attest') {
    // What the operator did on the actual Linux host. Recorded as an attestation; the recorder cannot observe it.
    if (!REQUIRED_ATTESTATIONS.includes(a.item)) throw new Error(`--item must be one of ${REQUIRED_ATTESTATIONS.join(', ')}`);
    if (!(a.evidence ?? '').trim()) throw new Error('--evidence is required: what was done, when, and where its output is kept');
    locked(() => {
      // What was attested is part of the readiness record. Recording anything after it would end the run's validity for
      // good (the record is never replaced), so it is refused here instead.
      if (acceptedReadiness(s.events())) throw new Error('refused: this run already has its readiness record, which binds what was attested. Attesting again would invalidate it for good. If an attestation is no longer true, the run must not continue: abandon it or stop, and report');
      s.event({ cycle: null, kind: 'attestation', item: a.item, evidence: a.evidence.slice(0, 500), attestation: 'operator' });
    });
    console.log(`recorded operator attestation: ${a.item}`);
  } else if (cmd === 'abandon') {
    locked(() => abandonRun(s, a.reason));
    console.log(`run ${a.run} is abandoned: stopped for good. Nothing was removed; its volumes stay registered to it and can never be used by another run`);
  } else if (cmd === 'measure') {
    // Read-only. What one cycle really did, from the acknowledgement ledger, beside what its start declared.
    if (!isCycle(n)) throw new Error('--cycle');
    const starts = startsOf(s.events().filter((e) => e.cycle === n), n);
    if (!starts.length) throw new Error(`cycle ${n} has not started`);
    console.log(JSON.stringify({ run: a.run, cycle: n, failureModel: s.run().failureModel, ...throughputReport({ acks: s.acks(n), starts }) }, null, 2));
  } else if (cmd === 'status') {
    // Another process than the server: it cannot see what a running server holds in memory only (a contradiction it
    // could write nowhere), which that server's own views include.
    let pid = null;
    try { pid = Number(fs.readFileSync(path.join(a.dir, `${LOCK_FILE}.serving`), 'utf8')); } catch { /* none */ }
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) console.error(`note: a recorder (process ${pid}) is serving this directory. This status is read from the files: it does not include what that server holds in memory only. Ask the server (GET /runs/<run>) for its own view`);
    console.log(JSON.stringify(runStatus(s), null, 2));
  } else throw new Error('commands: serve, create-run, attest, abandon, cut, confirm-cut, status, measure, verify-dir');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(String(e.message)); process.exit(1); });
