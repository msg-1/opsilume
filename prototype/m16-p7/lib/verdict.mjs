// The P7 comparison and classification (plan §5). Pure functions over plain data, so they are tested without a
// database. Fail closed: anything not positively a pass is FAIL or INCONCLUSIVE, and FAIL outranks INCONCLUSIVE.
import { fp, hex, subFp } from './scan.mjs';

export const FAILURE_MODELS = ['POWER-CUT', 'VM-CRASH', 'HARNESS-SMOKE'];
export const REQUIRED_CONSECUTIVE = 20;
const LIMIT = 20; // discrepancies listed per kind in the evidence; the counts are always complete

function finding(list, severity, code, detail) {
  list.push({ severity, code, ...(detail === undefined ? {} : { detail }) });
}

/**
 * journal: scanJournal() result plus { installationId }.
 * db: { installationId, head, headHash, count, fingerprint, claims: Map(seq -> { actionId }), duplicates }.
 * acks: this cycle's recorder entries [{ kind: 'claim' | 'dispatch', seq, actionId }].
 * accepted: claims accepted as never committed by an earlier recovery [{ seq, actionId }].
 * windowFrom: the database head when the cycle started; this cycle's claims have larger sequence numbers.
 */
export function compareCycle({ journal, db, acks, accepted = [], windowFrom }) {
  const findings = [];
  const out = { findings, relation: null, uncommitted: null, needsRecovery: [], counts: {} };
  if (journal.status === 'missing') return finding(findings, 'fail', 'JOURNAL_MISSING'), out;
  if (journal.status === 'corrupt') {
    finding(findings, 'fail', 'JOURNAL_CORRUPT', { problem: journal.problem, atByte: journal.corruptAtByte, finalLine: journal.corruptIsFinalLine });
    return out;
  }
  if (!journal.installationId || journal.installationId !== db.installationId) finding(findings, 'fail', 'INSTALLATION_IDENTITY_DIFFERS');
  if (!journal.fingerprintKnown) finding(findings, 'fail', 'JOURNAL_FINGERPRINT_UNKNOWN', 'more consecutive voids than can be followed');

  // Heads: equal (hash too), or the journal exactly one claim ahead with that claim neither committed nor acknowledged.
  if (journal.head === db.head) {
    if (journal.headHash !== db.headHash) finding(findings, 'fail', 'HEAD_HASH_DIFFERS', { head: db.head });
    else out.relation = 'equal';
  } else if (journal.head === db.head + 1) {
    const c = journal.claims.get(journal.head);
    if (!c) finding(findings, 'fail', 'JOURNAL_AHEAD_OUTSIDE_WINDOW', { journalHead: journal.head, windowFrom });
    else {
      out.relation = 'journal-one-ahead';
      out.uncommitted = { seq: journal.head, actionId: c.actionId };
      out.needsRecovery.push('clear');
    }
  } else if (journal.head > db.head) finding(findings, 'fail', 'JOURNAL_AHEAD_BY_MORE_THAN_ONE', { journalHead: journal.head, databaseHead: db.head });
  else finding(findings, 'fail', 'DATABASE_AHEAD_OF_JOURNAL', { journalHead: journal.head, databaseHead: db.head });
  if (journal.status === 'torn_tail') {
    finding(findings, 'info', 'TORN_FINAL_LINE', { bytes: journal.tornBytes, rule: 'N1: never committed, treated as absent' });
    out.needsRecovery.unshift('repair-torn-tail');
  }

  // This cycle, claim by claim.
  const dbMissing = [], notCommitted = [], dispatchUncommitted = [];
  for (const [seq, d] of db.claims) if (journal.claims.get(seq)?.actionId !== d.actionId) dbMissing.push(seq);
  for (const [seq] of journal.claims) if (!db.claims.has(seq) && seq !== out.uncommitted?.seq) notCommitted.push(seq);
  if (out.uncommitted && db.claims.has(out.uncommitted.seq)) finding(findings, 'fail', 'COMMITTED_CLAIM_BEYOND_DATABASE_HEAD', { seq: out.uncommitted.seq });
  for (const seq of journal.dispatches) if (!db.claims.has(seq)) dispatchUncommitted.push(seq);
  if (dbMissing.length) finding(findings, 'fail', 'COMMITTED_CLAIM_MISSING_FROM_JOURNAL', { count: dbMissing.length, seqs: dbMissing.slice(0, LIMIT) });
  if (notCommitted.length) finding(findings, 'fail', 'JOURNAL_CLAIM_NOT_COMMITTED', { count: notCommitted.length, seqs: notCommitted.slice(0, LIMIT) });
  if (dispatchUncommitted.length) finding(findings, 'fail', 'DISPATCH_INTENT_WITHOUT_COMMITTED_CLAIM', { count: dispatchUncommitted.length, seqs: dispatchUncommitted.slice(0, LIMIT) });
  if (db.duplicates) finding(findings, 'fail', 'DUPLICATE_COMMITTED_CLAIM', { count: db.duplicates });
  // One action claimed under two sequence numbers would mean two workers (or processes) both claimed it.
  for (const [where, m] of [['journal', journal.claims], ['database', db.claims]]) {
    const ids = [...m.values()].map((c) => c.actionId);
    const dup = ids.length - new Set(ids).size;
    if (dup) finding(findings, 'fail', 'DUPLICATE_ACTION_CLAIM', { where, count: dup });
  }

  // Acknowledgements: each one must be durable in the journal AND (for claims) committed in the database.
  const seen = new Map();
  const bad = { outside: [], journal: [], database: [], dispatch: [], malformed: 0 };
  for (const a of acks) {
    if (!['claim', 'dispatch'].includes(a.kind) || !Number.isInteger(a.seq)) { bad.malformed += 1; continue; }
    const key = `${a.kind}:${a.seq}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (a.seq <= windowFrom) { bad.outside.push(a.seq); continue; }
    if (a.kind === 'claim') {
      if (journal.claims.get(a.seq)?.actionId !== a.actionId) bad.journal.push(a.seq);
      if (db.claims.get(a.seq)?.actionId !== a.actionId) bad.database.push(a.seq);
    } else if (!journal.dispatches.has(a.seq)) bad.dispatch.push(a.seq);
  }
  const dupAcks = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
  if (bad.malformed) finding(findings, 'fail', 'MALFORMED_ACKNOWLEDGEMENT', { count: bad.malformed });
  if (dupAcks.length) finding(findings, 'fail', 'DUPLICATE_ACKNOWLEDGEMENT', { count: dupAcks.length, keys: dupAcks.slice(0, LIMIT) });
  if (bad.outside.length) finding(findings, 'fail', 'ACKNOWLEDGEMENT_OUTSIDE_CYCLE', { count: bad.outside.length, seqs: bad.outside.slice(0, LIMIT) });
  if (bad.journal.length) finding(findings, 'fail', 'ACKNOWLEDGED_CLAIM_MISSING_FROM_JOURNAL', { count: bad.journal.length, seqs: bad.journal.slice(0, LIMIT) });
  if (bad.database.length) finding(findings, 'fail', 'ACKNOWLEDGED_CLAIM_MISSING_FROM_DATABASE', { count: bad.database.length, seqs: bad.database.slice(0, LIMIT) });
  if (bad.dispatch.length) finding(findings, 'fail', 'ACKNOWLEDGED_DISPATCH_INTENT_MISSING_FROM_JOURNAL', { count: bad.dispatch.length, seqs: bad.dispatch.slice(0, LIMIT) });

  // Whole history, in bounded memory: journal claims minus those accepted as never committed must equal the database's.
  let expected = BigInt(`0x${journal.fingerprint}`);
  let expectedCount = journal.count;
  for (const u of [...accepted, ...(out.uncommitted ? [out.uncommitted] : [])]) {
    expected = subFp(expected, fp(u.seq, u.actionId));
    expectedCount -= 1;
  }
  if (hex(expected) !== db.fingerprint || expectedCount !== db.count) {
    finding(findings, 'fail', 'HISTORY_DIFFERS', { journalClaims: journal.count, accepted: accepted.length, expected: expectedCount, databaseClaims: db.count });
  }
  out.counts = {
    windowFrom,
    journalHead: journal.head,
    databaseHead: db.head,
    cycleJournalClaims: journal.claims.size,
    cycleCommittedClaims: db.claims.size,
    cycleDispatchIntents: journal.dispatches.size,
    claimAcks: acks.filter((a) => a.kind === 'claim').length,
    dispatchAcks: acks.filter((a) => a.kind === 'dispatch').length,
    historyJournalClaims: journal.count,
    historyCommittedClaims: db.count,
  };
  return out;
}

const DURABLE = { fsync: 'on', full_page_writes: 'on', synchronous_commit: 'on' };
export const durableSettings = (s) => Object.entries(DURABLE).every(([k, v]) => s?.[k] === v);

export const QUALIFYING_MODELS = ['POWER-CUT', 'VM-CRASH'];
export const STORAGE_FIELDS = ['driveModel', 'firmware', 'controller', 'dbDevice', 'journalDevice', 'filesystem', 'vendorDoc', 'evidenceFiles'];
const known = (v) => typeof v === 'string' && v.trim().length > 0 && !/^(unknown|n\/a|tbd|\?+)$/i.test(v.trim());

/**
 * Why the operator's storage evidence does not allow a qualifying run (empty = it does). Five separate things, never
 * merged: the device's cache configuration; whether the device reports flush support; whether the kernel was OBSERVED
 * issuing flushes on this path; what the VENDOR documents about flush/FUA durability; and FUA. None of them is a
 * measurement of PostgreSQL's or the journal's durability: only the power-cut cycles test that.
 */
export function storageProblems(st) {
  const out = [];
  for (const k of STORAGE_FIELDS) if (!known(st?.[k])) out.push(`${k} is missing or unknown`);
  if (!['write back', 'write through'].includes(st?.writeCache)) out.push('writeCache must be "write back" or "write through"');
  if (!['yes', 'no', 'not-advertised'].includes(st?.fua)) out.push('fua must be "yes", "no" or "not-advertised"');
  if (!['yes', 'no'].includes(st?.flushSupported)) out.push('flushSupported (device reports flush support) must be "yes" or "no"');
  if (!['yes', 'no'].includes(st?.flushesObserved)) out.push('flushesObserved (kernel flush requests seen in the flush probe) must be "yes" or "no"');
  if (st?.vendorFlushSemantics !== 'yes') out.push('vendorFlushSemantics must be "yes": the vendor documentation named in vendorDoc must support flush/FUA durability');
  if (out.length) return out;
  if (st.fua === 'no') out.push('FUA is advertised but reported as not working');
  if (st.writeCache === 'write back') {
    // A volatile cache: durability depends on flushes. They must be supported by the device AND seen from the kernel.
    if (st.flushSupported !== 'yes') out.push('write-back cache, but the device does not report flush support');
    if (st.flushesObserved !== 'yes') out.push('write-back cache, but no kernel flush requests were observed on this path');
  } else if (st.fua !== 'yes' && st.flushesObserved !== 'yes') {
    out.push('write-through drive without FUA and without demonstrable flushes: not approved for qualifying testing');
  }
  return out;
}
export const storageQualifies = (st) => storageProblems(st).length === 0;

/**
 * run: { failureModel, storage } (fixed on the recorder when the run is created).
 * cycle: { settings, cutSentAt, cutConfirmed, workerStopsBeforeCut, silentWorkerStops, rebootObservedAfterCut, authenticatedRejections,
 *          journalWriteFailure (what the journal's failure marker says now, or null), journalWriteFailures (the failures
 *          workers reported to the recorder in this cycle, at any time), tornTailRepairProblem (why the torn final
 *          line cannot be repaired, from lib/scan.mjs repairProblem, or null), recorderDamage (the `damage` of the
 *          recorder's cycle view: { acknowledgementLedger, recorderMemory, runLedgers }, each a reason or null) }.
 * A known journal write failure is never a PASS: the comparison may still verify, but the cycle saw a storage or
 * harness error. It is INCONCLUSIVE, and it never softens a FAIL.
 * A torn final line that cannot be repaired (not valid UTF-8; the reused verifier would refuse its repair record, and
 * the verifier stays unchanged by decision) is INCONCLUSIVE too: recovery writes nothing for it, so the cycle can
 * never be recovered, and it must not stand as a provisional PASS.
 * Damage to the recorder's records of the cycle (its acknowledgement ledger, or what its running server could not
 * store) is INCONCLUSIVE as well: the acknowledgements the comparison rests on cannot be relied on, and the recorder
 * stores no PASS for such a cycle.
 * A PASS here is provisional when recovery is needed: it becomes final only when the recorder holds a verified recovery
 * (finalStatus). A journal one claim ahead is never an unconditional pass (decision 2).
 */
export function classifyCycle({ comparison, run, cycle }) {
  const fails = comparison.findings.filter((f) => f.severity === 'fail').map((f) => f.code);
  const inconclusive = [];
  if (!FAILURE_MODELS.includes(run.failureModel)) inconclusive.push('UNKNOWN_FAILURE_MODEL');
  if (run.failureModel === 'HARNESS-SMOKE') inconclusive.push('NOT_A_DURABILITY_RUN');
  if (!storageQualifies(run.storage)) inconclusive.push('STORAGE_FLUSH_OR_FUA_BEHAVIOUR_UNVERIFIED');
  if (!durableSettings(cycle.settings)) inconclusive.push('POSTGRESQL_DURABILITY_SETTINGS_NOT_ON');
  if (!cycle.cutSentAt) inconclusive.push('NO_CUT_RECORDED');
  if (cycle.cutConfirmed !== 'yes') inconclusive.push(run.failureModel === 'VM-CRASH' ? 'CRASH_NOT_CONFIRMED' : 'POWER_LOSS_NOT_CONFIRMED');
  if (QUALIFYING_MODELS.includes(run.failureModel) && cycle.rebootObservedAfterCut !== true) inconclusive.push('REBOOT_AFTER_CUT_NOT_OBSERVED');
  if (cycle.workerStopsBeforeCut?.length || cycle.silentWorkerStops?.length) inconclusive.push('WORKLOAD_STOPPED_BEFORE_CUT');
  // Product-owner ruling A (18 November 2026): the cut REQUEST is not the power loss. A worker that reported its stop
  // after the request stopped while the machine still had power.
  if (cycle.workerStopsAfterCut?.length) inconclusive.push('WORKER_STOPPED_AFTER_CUT_REQUEST');
  if (cycle.authenticatedRejections) inconclusive.push('RECORDER_REJECTED_AUTHENTICATED_MESSAGES');
  if (cycle.journalWriteFailure || cycle.journalWriteFailures?.length) inconclusive.push('JOURNAL_WRITE_FAILED');
  if (cycle.tornTailRepairProblem) inconclusive.push('TORN_TAIL_NOT_REPAIRABLE');
  if (cycle.recorderDamage && Object.values(cycle.recorderDamage).some(Boolean)) inconclusive.push('RECORDER_CYCLE_RECORDS_DAMAGED'); // any reason, in any of its parts
  if (!comparison.counts?.claimAcks) inconclusive.push('NO_ACKNOWLEDGED_CLAIMS');
  const verdict = fails.length ? 'FAIL' : inconclusive.length ? 'INCONCLUSIVE' : 'PASS';
  const needsRecovery = verdict === 'FAIL' ? [] : comparison.needsRecovery;
  return {
    verdict,
    failureModel: run.failureModel,
    fails,
    inconclusive,
    quarantineRequired: verdict !== 'FAIL' && comparison.relation === 'journal-one-ahead',
    needsRecovery,
    countsTowardPhysicalPowerLoss: false, // decided by the recorder after recovery (finalStatus)
  };
}

/**
 * The cycle's final status on the recorder: FAIL, INCONCLUSIVE, PENDING_RECOVERY (checked, recovery not yet verified)
 * or PASS. `recovered` is the recorder's record of a verified recovery; for a journal one claim ahead it must show
 * that quarantine was observed and clearance completed.
 */
export function finalStatus(result, recovered) {
  if (!result) return 'NOT_CHECKED';
  if (result.verdict !== 'PASS') return result.verdict;
  if (!recovered) return 'PENDING_RECOVERY';
  if (result.quarantineRequired && !(recovered.quarantineObserved && recovered.cleared)) return 'PENDING_RECOVERY';
  return 'PASS';
}

/**
 * Decision 1 and 9: the qualifying series is the run's cycles from cycle 1, in order, each with final status PASS in a
 * POWER-CUT run. The first cycle that isn't (FAIL, INCONCLUSIVE, pending) ends the count; the recorder stops the run
 * on FAIL or INCONCLUSIVE, so a new series is a new run starting at cycle 1.
 */
export function physicalStreak(finals, failureModel) {
  let count = 0;
  let brokenAt = null, brokenBy = null;
  const sorted = [...finals].sort((a, b) => a.cycle - b.cycle);
  for (const [i, f] of sorted.entries()) {
    if (f.cycle !== i + 1 || f.status !== 'PASS' || failureModel !== 'POWER-CUT') { brokenAt = f.cycle; brokenBy = f.cycle !== i + 1 ? 'gap' : failureModel !== 'POWER-CUT' ? `not a POWER-CUT run (${failureModel})` : f.status; break; }
    count += 1;
  }
  // 20 from cycle 1 meet the requirement; any FAIL anywhere in the run (even after 20 passes) means it is not met.
  const anyFail = sorted.some((f) => f.status === 'FAIL');
  return { consecutivePhysicalPasses: count, required: REQUIRED_CONSECUTIVE, met: !anyFail && count >= REQUIRED_CONSECUTIVE, brokenAtCycle: brokenAt, brokenBy, anyFail };
}
