// Experiment D: the execution lifecycle with the process killed at every boundary.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { db, inspect, journalAt, reconcile, retryAllowed, sweep } from './lib/proto.mjs';
import { fresh, seed } from './lib/fixtures.mjs';

const R = process.env.RECEIVER_URL;
const hitsFor = async (id) => (await (await fetch(R.replace('/hook', '/hits'))).json()).filter((h) => h.body.actionId === id).length;
const scenarios = [
  ['baseline: no failure', {}],
  ['crash before the claim', { crashAt: 'before_claim' }],
  ['crash after the claim record, before the database commit', { crashAt: 'after_claim_append' }],
  ['S1: claim record appended, database transaction rolls back', { failAudit: true }],
  ['S2: database commit succeeds, crash before dispatch', { crashAt: 'after_commit' }],
  ['S3: dispatch record written, crash before sending a byte', { crashAt: 'after_dispatch_record' }],
  ['S4: request sent, crash before the response', { crashAt: 'after_send', receiverDelayMs: 500 }],
  ['S5: receiver completes, crash before the outcome is recorded', { crashAt: 'after_response' }],
  ['S6a: outcome database transaction fails (design order: database first, then journal)', { failOutcomeDb: true }],
  ['S6b: journal records the outcome, then the database transaction fails (reversed order)', { failOutcomeDb: true, journalFirst: true }],
  ['crash after the outcome commits, before the outcome record', { crashAt: 'after_outcome_db' }],
];

const out = [];
for (const [name, opts] of scenarios) {
  await fetch(R.replace('/hook', '/reset'), { method: 'POST' });
  const { p, j } = await fresh();
  await seed(p, { orgs: 1, perOrg: 1 });
  const id = 'a-1-1';
  const run = spawnSync(process.execPath, ['exp-d-child.mjs', id, JSON.stringify(opts)], { encoding: 'utf8', env: process.env });
  await new Promise((r) => setTimeout(r, (opts.receiverDelayMs ?? 0) + 200)); // let a request still in flight reach the receiver
  const entries = j.state().entries ?? [];
  const types = entries.map((e) => (e.type === 'outcome' ? `outcome:${e.outcome}` : e.type));
  const [before] = await p.$queryRaw`SELECT status, attempts, outcome FROM action WHERE id = ${id}`;
  const trustBefore = (await inspect(p, j)).problem;
  await sweep(p, 0); // the stranded-execution sweep, as if the attempt had gone stale
  const [after] = await p.$queryRaw`SELECT status, attempts, outcome FROM action WHERE id = ${id}`;
  const v = await inspect(p, j);
  const claimRec = entries.find((e) => e.type === 'claim' && !entries.some((x) => x.type === 'void' && x.seq === e.seq));
  const dispatched = !!claimRec && entries.some((e) => e.type === 'dispatch' && e.seq === claimRec.seq);
  const hits = await hitsFor(id);
  out.push({
    scenario: name,
    process: run.signal === 'SIGKILL' ? 'killed (SIGKILL)' : `exited ${run.status}${run.stderr ? `: ${run.stderr.trim().slice(0, 100)}` : ''}`,
    journal: types,
    databaseAtCrash: before,
    trustAfterCrash: trustBefore ?? 'trusted',
    databaseAfterSweep: after,
    receiverRequests: hits,
    dispatchPossible: dispatched ? 'yes: a dispatch record exists (intent only)' : 'no: no dispatch record, so nothing was sent',
    externalOutcome: after.status === 'EXECUTED' ? 'known: applied (recorded in the database)' : after.outcome === 'not_applied' ? 'known: not applied' : claimRec ? 'unknown' : 'nothing attempted',
    journalEvidence: entries.filter((e) => e.type === 'outcome').map((e) => e.outcome),
    automaticRetryPermitted: retryAllowed(after),
    humanReconciliationRequired: after.status === 'FAILED' && after.outcome === 'unknown',
    nextClaimTrusted: v.problem === null,
  });
}

// Reconciliation completes the lifecycle: S5's unknown outcome reconciled as applied by a person, journalled afterwards.
{
  await fetch(R.replace('/hook', '/reset'), { method: 'POST' });
  const { p, j } = await fresh();
  await seed(p, { orgs: 1, perOrg: 1 });
  spawnSync(process.execPath, ['exp-d-child.mjs', 'a-1-1', JSON.stringify({ crashAt: 'after_response' })], { encoding: 'utf8', env: process.env });
  await sweep(p, 0);
  await reconcile(p, j, 'a-1-1', 'applied');
  const [a] = await p.$queryRaw`SELECT status, outcome FROM action WHERE id = 'a-1-1'`;
  out.push({ scenario: 'reconciliation after S5 (a person records applied)', journal: j.state().entries.map((e) => (e.outcome ? `${e.type}:${e.outcome}` : e.type)), databaseAfter: a, automaticRetryPermitted: retryAllowed(a), nextClaimTrusted: (await inspect(p, j)).problem === null });
}
fs.writeFileSync('/results/exp-d.json', `${JSON.stringify(out, null, 2)}\n`);
for (const r of out) console.log(JSON.stringify(r));
