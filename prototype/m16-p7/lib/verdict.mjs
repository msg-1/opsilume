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

/**
 * run: { failureModel, storage: { writeCache, flushHonoured } } (fixed when the run is created).
 * cycle: { settings, cutSentAt, cutConfirmed: 'yes' | 'no' | undefined, workerStopsBeforeCut: [...] }.
 */
export function classifyCycle({ comparison, run, cycle }) {
  const fails = comparison.findings.filter((f) => f.severity === 'fail').map((f) => f.code);
  const inconclusive = [];
  if (!FAILURE_MODELS.includes(run.failureModel)) inconclusive.push('UNKNOWN_FAILURE_MODEL');
  if (run.failureModel === 'HARNESS-SMOKE') inconclusive.push('NOT_A_DURABILITY_RUN');
  if (run.storage?.flushHonoured !== 'yes' || !['write back', 'write through'].includes(run.storage?.writeCache)) inconclusive.push('STORAGE_FLUSH_BEHAVIOUR_UNVERIFIED');
  if (!durableSettings(cycle.settings)) inconclusive.push('POSTGRESQL_DURABILITY_SETTINGS_NOT_ON');
  if (!cycle.cutSentAt) inconclusive.push('NO_CUT_RECORDED');
  if (cycle.cutConfirmed !== 'yes') inconclusive.push(run.failureModel === 'VM-CRASH' ? 'CRASH_NOT_CONFIRMED' : 'POWER_LOSS_NOT_CONFIRMED');
  if (cycle.workerStopsBeforeCut?.length) inconclusive.push('WORKLOAD_STOPPED_BEFORE_CUT');
  if (!comparison.counts?.claimAcks) inconclusive.push('NO_ACKNOWLEDGED_CLAIMS');
  const verdict = fails.length ? 'FAIL' : inconclusive.length ? 'INCONCLUSIVE' : 'PASS';
  return {
    verdict,
    failureModel: run.failureModel,
    fails,
    inconclusive,
    countsTowardPhysicalPowerLoss: verdict === 'PASS' && run.failureModel === 'POWER-CUT',
    needsRecovery: verdict === 'FAIL' ? [] : comparison.needsRecovery,
  };
}

/** Consecutive passing POWER-CUT cycles, ending at the latest. INCONCLUSIVE resets the streak (conservative); FAIL stops the run. */
export function physicalStreak(results) {
  let streak = 0;
  let stopped = null;
  for (const r of [...results].sort((a, b) => a.cycle - b.cycle)) {
    if (r.verdict === 'FAIL') { stopped = r.cycle; streak = 0; break; }
    streak = r.countsTowardPhysicalPowerLoss ? streak + 1 : 0;
  }
  return { consecutivePhysicalPasses: streak, required: REQUIRED_CONSECUTIVE, met: !stopped && streak >= REQUIRED_CONSECUTIVE, stoppedAtCycle: stopped };
}
