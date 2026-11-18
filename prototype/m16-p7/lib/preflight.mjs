// Qualifying-run preflight verdict (pure). `p7.mjs preflight` gathers the facts read-only and prints this verdict.
// It never starts a workload or a cut: READY_FOR_OPERATOR_REVIEW only means nothing checked here is blocking.
export const REQUIRED_ATTESTATIONS = ['firewall-verified-on-host', 'manual-cut-rehearsed-on-host', 'host-evidence-reviewed'];
export const FRESH_WAL_LIMIT_BYTES = 64 * 1024 * 1024; // a new cluster sits near 24-26 MiB of WAL; anything far beyond was used

/** Why volumes are not fresh for a first qualifying run (empty = fresh). */
export function freshVolumeProblems(v) {
  const out = [];
  if (!/^\d{10,24}$/.test(String(v?.pgSystemId ?? ''))) out.push('the PostgreSQL system identifier could not be read');
  if (v?.publicRelations !== 0) out.push(`the database is not empty (${v?.publicRelations ?? 'unknown'} relations in the public schema)`);
  if (v?.stateEntries !== 0) out.push(`the journal volume is not empty (${v?.stateEntries ?? 'unknown'} entries)`);
  if (!(Number.isFinite(v?.walLsnBytes) && v.walLsnBytes < FRESH_WAL_LIMIT_BYTES)) out.push(`the database cluster is not new (WAL position ${v?.walLsnBytes ?? 'unknown'} bytes; a new cluster is below ${FRESH_WAL_LIMIT_BYTES})`);
  return out;
}

export function preflightVerdict(f) {
  const checks = [];
  const add = (name, problems) => checks.push({ name, ok: problems.length === 0, problems });
  const r = f.run ?? {};
  add('run type and run id', [
    ...(r.failureModel === 'POWER-CUT' ? [] : [`this is a ${r.failureModel ?? 'unknown'} run: only a POWER-CUT run can qualify`]),
    ...(r.stopped ? ['the run is stopped'] : []),
    ...(r.cyclesStarted ? [`the run already started ${r.cyclesStarted} cycle(s): preflight is for before the first`] : []),
  ]);
  const v = f.volume ?? {};
  if (r.continues) {
    add('continued volumes (same qualifying series)', [
      ...(r.continues.failureModel === 'POWER-CUT' ? [] : [`the earlier run ${r.continues.run} is ${r.continues.failureModel ?? 'unknown'}: a POWER-CUT run never continues other state`]),
      ...(v.trusted ? [] : [`the state is not trusted (${v.problem ?? 'unknown'})`]),
      ...(v.matchesPredecessor ? [] : ['the database and journal are not in the state recorded at the end of the earlier run']),
      ...(v.registeredTo === r.rootRun ? [] : [`these volumes are not the ones the series started on (registered to ${v.registeredTo ?? 'no run'})`]),
    ]);
  } else if (v.initialisedByThisRun) {
    add('fresh volumes (initialised by this run)', [
      ...(v.registeredTo === r.run ? [] : [`these volumes are registered to ${v.registeredTo ?? 'no run'}, not to this run`]),
      ...(v.head === 0 && ['ok', 'empty'].includes(v.journalStatus) ? [] : [`the journal is not at its initial state (head ${v.head}, ${v.journalStatus})`]),
      ...(v.trusted ? [] : [`the state is not trusted (${v.problem ?? 'unknown'})`]),
    ]);
  } else {
    add('fresh, dedicated volumes', [
      ...freshVolumeProblems(v),
      ...(v.registeredTo ? [`these volumes were already used by run ${v.registeredTo}`] : []),
    ]);
  }
  add('storage evidence', f.storageProblems ?? ['not checked']);
  add('PostgreSQL durability settings', f.settingsDurable ? [] : ['fsync, full_page_writes and synchronous_commit are not all on']);
  const n = f.netcheck ?? {};
  add('network isolation and host firewall (strict)', [
    ...(n.strict ? [] : ['the check did not run in strict mode']),
    ...(n.ok ? [] : (n.failed?.length ? n.failed : ['netcheck failed'])),
  ]);
  const c = f.recorder ?? {};
  add('recorder reachability and authentication', [
    ...(c.authenticated ? [] : ['the recorder did not answer an authenticated request']),
    ...(c.unsignedRejected ? [] : ['the recorder did not reject an unauthenticated request']),
  ]);
  add('workload sizing', f.sizing?.ok ? [] : [f.sizing?.reason ?? 'not sized: give --max-seconds and --rate or --target-rate']);
  // The whole series must fit before it starts (lib/sizing.mjs, seriesPlan). `p7.mjs preflight` always supplies it.
  if (f.series !== undefined) add('series plan', f.series?.ok ? [] : [f.series?.reason ?? 'the series could not be planned']);
  const have = new Set(r.attestations ?? []);
  add('operator attestations (not independent observations)', REQUIRED_ATTESTATIONS.filter((a) => !have.has(a)).map((a) => `missing operator attestation: ${a}`));
  const reasons = checks.flatMap((x) => x.problems.map((p) => `${x.name}: ${p}`));
  return { status: reasons.length ? 'BLOCKED' : 'READY_FOR_OPERATOR_REVIEW', reasons, checks,
    note: 'READY_FOR_OPERATOR_REVIEW is not approval and starts nothing. P7 remains untested until the physical experiment is complete and independently reviewed.' };
}
