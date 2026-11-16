// Experiment E: inspection and clearance on synthetic restored databases of increasing size.
//   node exp-e.mjs build <actions> <orgs>   - a "restored" database whose journal ran on past it
//   node exp-e.mjs measure <label>          - inspect + clear in one process, sampling memory
//   node exp-e.mjs clear <label> [crashAt]  - inspect + clear (used for the concurrent and interrupted runs)
//   node exp-e.mjs claim <label> <id>       - one claim attempt, recording lock wait and result
import fs from 'node:fs';
import { GENESIS, serialize } from './lib/journal.mjs';
import { claim, clear, db, inspect, journalAt, now } from './lib/proto.mjs';
import { fresh } from './lib/fixtures.mjs';

const [mode, a1, a2, a3] = process.argv.slice(2);
const save = (name, data) => fs.writeFileSync(`/results/exp-e-${name}.json`, `${JSON.stringify(data, null, 2)}\n`);

if (mode === 'build') {
  const actions = Number(a1), orgs = Number(a2);
  const { p, j } = await fresh();
  const id = j.identity();
  // Statuses at "backup time": 40% approved, 30% awaiting approval, 10% executed, 10% failed/unknown, 10% proposed.
  await p.$executeRawUnsafe(`INSERT INTO org (id) SELECT 'org-' || g FROM generate_series(1, ${orgs}) g`);
  await p.$executeRawUnsafe(`INSERT INTO action (id, org_id, status, attempts, outcome)
    SELECT 'a-' || g, 'org-' || (1 + g % ${orgs}),
      CASE WHEN g % 10 < 4 THEN 'APPROVED' WHEN g % 10 < 7 THEN 'PENDING_APPROVAL' WHEN g % 10 = 7 THEN 'EXECUTED' WHEN g % 10 = 8 THEN 'FAILED' ELSE 'PROPOSED' END,
      CASE WHEN g % 10 IN (7, 8) THEN 1 ELSE 0 END, CASE WHEN g % 10 = 7 THEN 'applied' WHEN g % 10 = 8 THEN 'unknown' END
    FROM generate_series(1, ${actions}) g`);
  await p.$executeRawUnsafe(`INSERT INTO approval (action_id) SELECT id FROM action WHERE status IN ('APPROVED', 'PENDING_APPROVAL')`);
  // Journal: claims 1..H are the executions the backup knows about; H+1.. ran after the backup:
  // 5% of actions (approved at backup time) were executed afterwards, plus 1% of ids the restored database doesn't have.
  const executed = Math.round(actions * 0.1), after = Math.round(actions * 0.05), unknownIds = Math.round(actions * 0.01);
  let prev = GENESIS, text = '', seq = 0;
  const add = (e) => { const l = serialize(e, prev); prev = JSON.parse(l).hash; text += l; };
  const at = '2026-11-16T12:00:00.000Z';
  for (let g = 7, k = 0; k < executed; g += 10, k++) { add({ type: 'claim', seq: ++seq, actionId: `a-${g}`, org: 'org-x', attempt: 1, at }); add({ type: 'dispatch', seq, at }); add({ type: 'outcome', seq, outcome: 'applied', at }); }
  const head = seq;
  for (let g = 0, k = 0; k < after; g += 10, k++) {
    add({ type: 'claim', seq: ++seq, actionId: `a-${g || 10}`, org: 'org-x', attempt: 1, at });
    if (k % 4 !== 0) add({ type: 'dispatch', seq, at }); // a quarter were never dispatched
    if (k % 4 === 2) add({ type: 'outcome', seq, outcome: 'applied', at });
    if (k % 4 === 3) add({ type: 'reconciled', seq, outcome: 'not_applied', at });
  }
  for (let k = 0; k < unknownIds; k++) { add({ type: 'claim', seq: ++seq, actionId: `gone-${k}`, org: 'org-1', attempt: 1, at }); add({ type: 'dispatch', seq, at }); }
  fs.writeFileSync(j.file, text);
  await p.$executeRaw`UPDATE installation_state SET installation_id = ${id}, journal_seq = ${head} WHERE id = 1`;
  const out = { actions, orgs, journalRecords: text.split('\n').length - 1, journalBytes: Buffer.byteLength(text), backupHead: head, journalHead: seq, ranAfterBackup: after, unmatched: unknownIds };
  console.log(JSON.stringify(out));
  await p.$disconnect();
} else if (mode === 'measure') {
  const p = db(); const j = journalAt();
  let peak = process.memoryUsage().rss;
  const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5);
  const rss0 = process.memoryUsage().rss;
  const t0 = now(); const v = await inspect(p, j); const inspectMs = now() - t0;
  const t1 = now(); const v2 = await inspect(p, j); const digestRepeatMs = now() - t1;
  const c = await clear(p, j, { digest: v.digest, reason: `prototype exp-e ${a1}` });
  clearInterval(sampler);
  const [{ audits }] = await p.$queryRaw`SELECT count(*)::int AS audits FROM audit WHERE action = 'recovery_cleared'`;
  const [{ orgs }] = await p.$queryRaw`SELECT count(*)::int AS orgs FROM org`;
  const [{ live }] = await p.$queryRaw`SELECT count(*)::int AS live FROM approval WHERE superseded_at IS NULL`;
  const [{ approved }] = await p.$queryRaw`SELECT count(*)::int AS approved FROM action WHERE status IN ('APPROVED', 'PENDING_APPROVAL', 'EXECUTING')`;
  const out = { label: a1, inspectMs: Math.round(inspectMs), inspectAgainMs: Math.round(digestRepeatMs), digestStable: v.digest === v2.digest, affectedActions: v.actions.length, ranAfterBackup: v.after.length, unmatched: v.unmatched.length,
    clear: c, auditRowsCreated: audits, organisations: orgs, approvalsStillCurrent: live, actionsStillExecutable: approved, trustedAfter: (await inspect(p, j)).problem === null,
    rssStartMB: Math.round(rss0 / 1048576), rssPeakMB: Math.round(peak / 1048576) };
  save(`measure-${a1}`, out);
  console.log(JSON.stringify(out));
  await p.$disconnect();
} else if (mode === 'clear') {
  const p = db(); const j = journalAt();
  const digest = a3 ?? (await inspect(p, j)).digest;
  let r;
  try { r = await clear(p, j, { digest, reason: `prototype ${a1}`, crashAt: a2 && a2 !== '-' ? a2 : undefined }); } catch (e) { r = { error: String(e.message).split('\n').filter(Boolean).at(-1).slice(0, 160) }; }
  save(`clear-${a1}`, r);
  console.log(JSON.stringify({ label: a1, ...r }));
  await p.$disconnect();
} else if (mode === 'claim') {
  const p = db(); const j = journalAt();
  const r = await claim(p, j, a2);
  save(`claim-${a1}`, r);
  console.log(JSON.stringify({ label: a1, ...r }));
  await p.$disconnect();
} else if (mode === 'digest') {
  const p = db(); const j = journalAt();
  console.log((await inspect(p, j)).digest);
  await p.$disconnect();
}
