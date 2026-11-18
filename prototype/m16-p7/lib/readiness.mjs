// The readiness record of a qualifying run (pure). A POWER-CUT cycle starts only while the configuration it runs on is
// exactly the one a successful preflight recorded. The record has two halves:
//   test:     what the test machine reports (database cluster, journal volume, PostgreSQL settings, the strict network
//             check, the workload). `p7.mjs` gathers it read-only, at preflight and again at every cycle start.
//   recorder: what the recorder itself holds (run, run type, its own identity, the registry, the storage evidence, the
//             operator attestations). The recorder computes it; the test machine cannot assert it.
// Only things that must stay the same for the whole series are bound: no heads, boot ids, WAL positions or times.
import { createHash } from 'node:crypto';
import { durableSettings } from './verdict.mjs';
import { MIN_QUIET_RATE, QUALIFYING_CYCLES, SILENT_STOP_MS, hasBurst, seriesPlan, sizePlan } from './sizing.mjs';
import { HARNESS_BRIDGES } from './netcheck.mjs';

export const CLEARANCE_ENVELOPE = 1_000_000; // waiting actions clearance was validated at (Phase 0.5)
export { MIN_QUIET_RATE, SILENT_STOP_MS }; // defined once, in lib/sizing.mjs, where the workload is sized
const PG_KEYS = ['fsync', 'full_page_writes', 'synchronous_commit', 'wal_sync_method', 'data_checksums', 'server_version'];
const WORKLOAD_KEYS = ['procs', 'workers', 'cycles', 'maxSeconds', 'headroom', 'ratePerWorker', 'targetRate', 'poolPerWorker', 'burstPeriodSeconds', 'burstSeconds', 'quietRate'];
/** process.arch of the harness container -> the Docker architecture name the operator declares for the image. */
export const DOCKER_ARCH = { x64: 'amd64', arm64: 'arm64' };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const sorted = (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x);
export const canon = (v) => JSON.stringify(v, sorted);
export const digestOf = (v) => sha(canon(v));
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v)); // flags arrive as strings
const HEX = /^[0-9a-f]{64}$/;

/** The test-machine half, from gathered facts, in one normal form (so "2" and 2 never differ). */
export function testBinding(f) {
  const settings = Object.fromEntries(PG_KEYS.map((k) => [k, String(f?.settings?.[k] ?? '')]));
  const names = [...new Set((f?.netcheck?.probes ?? []).map((p) => String(p.name)))].sort();
  return {
    pgSystemId: String(f?.pgSystemId ?? ''),
    journal: { markerSha256: String(f?.journal?.markerSha256 ?? ''), installationId: String(f?.journal?.installationId ?? '') },
    postgresql: { settings, digest: digestOf(settings) },
    // The firewall as observed from inside: which destinations were probed (names carry the bridge addresses) and that
    // every probe passed in strict mode. Outcomes themselves are not bound: "timeout" and "unreachable" both mean blocked.
    firewall: { strict: f?.netcheck?.strict === true, passed: f?.netcheck?.ok === true, bridges: [...(f?.netcheck?.bridges ?? [])].map(String).sort(), probes: names.length, digest: digestOf(names) },
    workload: Object.fromEntries(WORKLOAD_KEYS.map((k) => [k, num(f?.workload?.[k])])),
    // What runs: the harness source by content (lib/source.mjs), and the runtime of the image it runs in.
    source: { treeSha256: String(f?.source?.sha256 ?? f?.source?.treeSha256 ?? ''), files: Number(f?.source?.files ?? 0) },
    runtime: { arch: String(f?.runtime?.arch ?? ''), node: String(f?.runtime?.node ?? ''), fingerprint: String(f?.runtime?.fingerprint ?? '') },
  };
}

/** Rebuilds a submitted test half field by field (nothing extra is stored) and says why it cannot be a ready one. */
export function vetTestBinding(t) {
  const settings = Object.fromEntries(PG_KEYS.map((k) => [k, String(t?.postgresql?.settings?.[k] ?? '')]));
  const test = {
    pgSystemId: String(t?.pgSystemId ?? ''),
    journal: { markerSha256: String(t?.journal?.markerSha256 ?? ''), installationId: String(t?.journal?.installationId ?? '') },
    postgresql: { settings, digest: digestOf(settings) },
    firewall: { strict: t?.firewall?.strict === true, passed: t?.firewall?.passed === true, bridges: (Array.isArray(t?.firewall?.bridges) ? t.firewall.bridges : []).map(String).sort(), probes: Number(t?.firewall?.probes), digest: String(t?.firewall?.digest ?? '') },
    workload: Object.fromEntries(WORKLOAD_KEYS.map((k) => [k, num(t?.workload?.[k])])),
    source: { treeSha256: String(t?.source?.treeSha256 ?? ''), files: Number(t?.source?.files ?? 0) },
    runtime: { arch: String(t?.runtime?.arch ?? ''), node: String(t?.runtime?.node ?? ''), fingerprint: String(t?.runtime?.fingerprint ?? '') },
  };
  const problems = [];
  if (!HEX.test(test.source.treeSha256)) problems.push('the harness source digest is missing');
  if (!test.runtime.arch) problems.push('the runtime architecture is missing');
  if (!HEX.test(test.runtime.fingerprint)) problems.push('the runtime fingerprint is missing');
  if (!/^\d{10,24}$/.test(test.pgSystemId)) problems.push('the database cluster identifier is missing');
  if (!HEX.test(test.journal.markerSha256) || !test.journal.installationId) problems.push('the journal volume has no identity (run init or adopt first)');
  if (!durableSettings(settings)) problems.push('fsync, full_page_writes and synchronous_commit are not all on');
  if (t?.postgresql?.digest !== test.postgresql.digest) problems.push('the PostgreSQL configuration digest does not match the settings');
  if (!test.firewall.strict) problems.push('the network check did not run in strict mode');
  if (!test.firewall.passed) problems.push('the strict network check did not pass');
  if (test.firewall.bridges.length !== HARNESS_BRIDGES) problems.push(`the network check probed ${test.firewall.bridges.length} bridge address(es), not ${HARNESS_BRIDGES}`);
  if (!(Number.isInteger(test.firewall.probes) && test.firewall.probes > 0) || !HEX.test(test.firewall.digest)) problems.push('the network check has no probes');
  const w = test.workload;
  const plan = sizePlan({ workers: w.workers, procs: w.procs, envelope: CLEARANCE_ENVELOPE, ratePerWorker: w.ratePerWorker, maxSeconds: w.maxSeconds, headroom: w.headroom, pool: w.poolPerWorker ?? NaN, burstPeriodSeconds: w.burstPeriodSeconds, burstSeconds: w.burstSeconds, quietRate: w.quietRate });
  if (!plan.ok) problems.push(`workload: ${plan.reason}`);
  if (w.targetRate !== null && w.targetRate !== w.ratePerWorker) problems.push('workload: the throttle differs from the rate the pool was sized for');
  if (w.targetRate !== null && hasBurst(w)) problems.push('workload: a burst pattern cannot be combined with a constant throttle');
  return { test, problems };
}

/**
 * Decision B1: what the workload of a qualifying (POWER-CUT) series must be, beyond being well sized. One process, one
 * worker, and a burst pattern that completes at least one period before the latest cut and whose quiet part never
 * leaves the worker silent for long enough to be counted as stopped.
 */
export function qualifyingWorkloadProblems(w) {
  const out = [];
  if (w?.procs !== 1) out.push(`a qualifying series runs one process, not ${w?.procs}`);
  if (w?.workers !== 1) out.push(`a qualifying series runs one worker, not ${w?.workers}`);
  if (!hasBurst(w)) out.push('a qualifying series needs a burst pattern (burst period, burst seconds, quiet rate)');
  else if (!(w.burstPeriodSeconds <= w.maxSeconds)) out.push('the burst period is longer than the time to the cut: no cycle would complete a period');
  // A paced worker must never look stopped: quiet claims are 1/quietRate seconds apart, and the recorder counts a stream
  // that was silent for SILENT_STOP_MS before the cut as stopped (INCONCLUSIVE). The gap may be at most half of that.
  if (hasBurst(w) && !(w.quietRate >= MIN_QUIET_RATE)) out.push(`the quiet rate must be at least ${MIN_QUIET_RATE} claims per second: at ${w.quietRate} the worker is silent for longer than half the ${SILENT_STOP_MS / 1000} s after which the recorder counts it as stopped`);
  // The whole series is planned before it starts (finding F7): 20 cycles, bound in the record, fitting the envelope.
  if (w?.cycles !== QUALIFYING_CYCLES) out.push(`a qualifying series plans ${QUALIFYING_CYCLES} cycles, not ${w?.cycles ?? 'an unstated number'}`);
  else { const plan = seriesPlanOf(w); if (!plan.ok) out.push(plan.reason); }
  return out;
}

/** What the operator declares at create-run about the source package and the image. Declared, bound, never rewritten. */
export function identityProblems(id) {
  const out = [];
  if (!/^[0-9a-f]{40}$/.test(id?.sourceCommit ?? '')) out.push('--source-commit must be the 40-character commit the source package was made from');
  if (!HEX.test(id?.packageSha256 ?? '')) out.push('--package-sha256 must be the SHA-256 of the source package');
  if (!/^sha256:[0-9a-f]{64}$/.test(id?.imageId ?? '')) out.push('--image-id must be the harness image id (sha256:...) built on the test machine');
  if (!Object.values(DOCKER_ARCH).includes(id?.imageArch)) out.push(`--image-arch must be one of ${Object.values(DOCKER_ARCH).join(', ')}`);
  return out;
}

/** The recorder half. `attestations` are the run's attestation events; re-attesting anything changes the digest. */
export function recorderBinding({ run, recorderId, registry, attestations }) {
  const att = (attestations ?? []).map((e) => ({ item: String(e.item), evidence: String(e.evidence ?? ''), at: String(e.at ?? '') }));
  return {
    run: String(run?.run ?? ''), failureModel: String(run?.failureModel ?? ''), rootRun: String(run?.rootRun ?? ''), continues: run?.continues?.run ?? null,
    recorderId: String(recorderId ?? ''),
    registry: { bytes: Number(registry?.bytes), sha256: String(registry?.sha256 ?? '') },
    storageDigest: digestOf(run?.storage ?? null),
    identity: { sourceCommit: String(run?.identity?.sourceCommit ?? ''), packageSha256: String(run?.identity?.packageSha256 ?? ''), imageId: String(run?.identity?.imageId ?? ''), imageArch: String(run?.identity?.imageArch ?? ''), sourceTreeSha256: String(run?.sourceTree?.sha256 ?? '') },
    attestations: { items: [...new Set(att.map((a) => a.item))].sort(), digest: digestOf(att) },
  };
}

/** Dotted paths at which two bindings differ (empty = the same configuration). */
export function bindingDiff(a, b, at = '') {
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap((k) => bindingDiff(a[k], b[k], at ? `${at}.${k}` : k));
  }
  return canon(a) === canon(b) ? [] : [at];
}

/** The series plan of a bound workload (lib/sizing.mjs, seriesPlan): what the readiness record stores as its calculation. */
export const seriesPlanOf = (w) => seriesPlan({ cycles: w?.cycles, workers: w?.workers, procs: w?.procs, envelope: CLEARANCE_ENVELOPE, ratePerWorker: w?.ratePerWorker, maxSeconds: w?.maxSeconds, headroom: w?.headroom, pool: w?.poolPerWorker ?? NaN, burstPeriodSeconds: w?.burstPeriodSeconds, burstSeconds: w?.burstSeconds, quietRate: w?.quietRate });
