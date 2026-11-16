// P6: bounded-memory, single-transaction clearance at scale (design §9.1).
//   build <actions> <orgs> | measure <label> | probe-row <label> | probe-claim <label> | clear-once <label> [crashAt] [digest] | digest | kill-db <label> | state
import fs from 'node:fs';
import { GENESIS, serialize } from './lib/journal.mjs';
import { claim, clear, db, direct, inspect, journalAt, now } from './lib/proto.mjs';
import { fresh, write } from './lib/fixtures.mjs';

const [mode, a1, a2, a3] = process.argv.slice(2);
const maxRss = () => Math.round(process.resourceUsage().maxRSS / 1024);
const snapshotStats = async (o) => (await o.$queryRaw`SELECT xact_commit::bigint, tup_inserted::bigint, tup_updated::bigint, blks_read::bigint, blks_hit::bigint, temp_bytes::bigint FROM pg_stat_database WHERE datname = current_database()`)[0];
const delta = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, Number(b[k] - a[k])]));

if (mode === 'build') {
  const actions = Number(a1), orgs = Number(a2);
  const t0 = now();
  const { p: o, j } = await fresh();
  await o.$executeRawUnsafe(`INSERT INTO org (id) SELECT 'org-' || g FROM generate_series(1, ${orgs}) g`);
  await o.$executeRawUnsafe(`INSERT INTO action (id, org_id, status, attempts, outcome)
    SELECT 'a-' || g, 'org-' || (1 + g % ${orgs}),
      CASE WHEN g % 10 < 4 THEN 'APPROVED' WHEN g % 10 < 7 THEN 'PENDING_APPROVAL' WHEN g % 10 = 7 THEN 'EXECUTED' WHEN g % 10 = 8 THEN 'FAILED' ELSE 'PROPOSED' END,
      CASE WHEN g % 10 IN (7, 8) THEN 1 ELSE 0 END, CASE WHEN g % 10 = 7 THEN 'applied' WHEN g % 10 = 8 THEN 'unknown' END
    FROM generate_series(1, ${actions}) g`);
  await o.$executeRawUnsafe(`INSERT INTO approval (action_id) SELECT id FROM action, generate_series(1, 2) WHERE status IN ('APPROVED', 'PENDING_APPROVAL')`);
  await o.$executeRawUnsafe('ANALYZE');
  // Journal: claims 1..H = executions the restored database knows; then 5% of actions executed after the backup (distinct
  // approved actions; a quarter undispatched, some with outcomes or reconciliations), and 1% claims for ids the database lacks.
  const fd = fs.openSync(j.file, 'a');
  let prev = GENESIS, seq = 0, buf = '', headHash = null;
  const at = '2026-11-16T12:00:00.000Z';
  const add = (e) => { const l = serialize(e, prev); prev = JSON.parse(l).hash; buf += l; if (e.type === 'claim') headHash = prev; if (buf.length > 4 << 20) { fs.writeSync(fd, buf); buf = ''; } };
  for (let g = 7; g <= actions; g += 10) { add({ type: 'claim', seq: ++seq, actionId: `a-${g}`, org: 'org-x', attempt: 1, at }); add({ type: 'dispatch', seq, at }); add({ type: 'outcome', seq, outcome: 'applied', at }); }
  const backupHead = seq, backupHash = headHash;
  const after = Math.round(actions * 0.05);
  for (let k = 0, g = 10; k < after; k++, g += 20) {
    add({ type: 'claim', seq: ++seq, actionId: `a-${g}`, org: 'org-x', attempt: 1, at });
    if (k % 4) add({ type: 'dispatch', seq, at });
    if (k % 4 === 2) add({ type: 'outcome', seq, outcome: 'applied', at });
    if (k % 4 === 3) add({ type: 'reconciled', seq, outcome: 'not_applied', at });
  }
  for (let k = 0; k < Math.round(actions * 0.01); k++) { add({ type: 'claim', seq: ++seq, actionId: `gone-${k}`, org: 'org-1', attempt: 1, at }); add({ type: 'dispatch', seq, at }); }
  fs.writeSync(fd, buf); fs.fsyncSync(fd); fs.closeSync(fd);
  await o.$executeRaw`UPDATE installation_state SET journal_seq = ${backupHead}, head_hash = ${backupHash}`;
  const [{ approvals }] = await o.$queryRaw`SELECT count(*)::int AS approvals FROM approval`;
  const res = { actions, orgs, approvals, journalBytes: fs.statSync(j.file).size, backupHead, journalHead: seq, ranAfterBackup: after, buildSeconds: Math.round((now() - t0) / 1000) };
  console.log(JSON.stringify(res));
  await o.$disconnect();
} else if (mode === 'measure') {
  const p = db(), o = direct(), j = journalAt();
  const s0 = await snapshotStats(o);
  const ti = now(); const v = await inspect(p, j); const inspectMs = now() - ti;
  const ti2 = now(); const v2 = await inspect(p, j); const inspectAgainMs = now() - ti2;
  const s1 = await snapshotStats(o);
  fs.writeFileSync('/results/p6-clear-started', String(Date.now()));
  const c = await clear(p, j, { digest: v.digest, reason: `phase 0.5 P6 ${a1}` });
  fs.writeFileSync('/results/p6-clear-finished', String(Date.now()));
  const s2 = await snapshotStats(o);
  const [{ audits }] = await o.$queryRaw`SELECT count(*)::int AS audits FROM audit WHERE action = 'recovery_cleared'`;
  const [{ orgs }] = await o.$queryRaw`SELECT count(*)::int AS orgs FROM org`;
  const [{ live }] = await o.$queryRaw`SELECT count(*)::int AS live FROM approval WHERE superseded_at IS NULL`;
  const [{ executable }] = await o.$queryRaw`SELECT count(*)::int AS executable FROM action WHERE status IN ('APPROVED', 'PENDING_APPROVAL', 'EXECUTING')`;
  const after = await inspect(p, j);
  const res = { label: a1, inspectMs: Math.round(inspectMs), inspectAgainMs: Math.round(inspectAgainMs), digestStable: v.digest === v2.digest, affected: v.affected, ranAfterBackup: v.after,
    clear: { ...c, ms: Math.round(c.ms) }, auditRows: audits, organisations: orgs, approvalsStillCurrent: live, actionsStillExecutable: executable, trustedAfter: after.problem === null,
    processMaxRssMB: maxRss(), databaseLoadDuringInspection: delta(s0, s1), databaseLoadDuringClearance: delta(s1, s2) };
  write(`p6-measure-${a1}.json`, res);
  console.log(JSON.stringify(res));
  await p.$disconnect(); await o.$disconnect();
} else if (mode === 'probe-row' || mode === 'probe-claim') {
  // Started while a clearance runs: how long does a route touching an affected action, or a claim, wait?
  const p = db(); const t = now();
  let result;
  if (mode === 'probe-row') { await p.$transaction(async (tx) => { await tx.$queryRaw`SELECT 1 FROM action WHERE id = 'a-1' FOR UPDATE`; }, { timeout: 1_800_000, maxWait: 60_000 }); result = 'row lock acquired'; }
  else { const r = await claim(p, journalAt(), 'a-1'); result = r.reason ?? (r.claimed ? 'claimed (WRONG)' : 'refused'); }
  const res = { label: a1, probe: mode, waitedMs: Math.round(now() - t), result };
  write(`p6-${mode}-${a1}.json`, res);
  console.log(JSON.stringify(res));
  await p.$disconnect();
} else if (mode === 'probe-row-loop') {
  // Locks an affected action row again and again until the clearance finishes: the longest wait is what a route would see.
  const p = db(); const waits = [];
  while (!fs.existsSync('/results/p6-clear-finished')) {
    const t = now();
    await p.$transaction(async (tx) => { await tx.$queryRaw`SELECT 1 FROM action WHERE id = 'a-1' FOR UPDATE`; }, { timeout: 1_800_000, maxWait: 60_000 });
    waits.push(now() - t);
    await new Promise((r) => setTimeout(r, 50));
  }
  const res = { label: a1, attempts: waits.length, maxWaitMs: Math.round(Math.max(...waits)), medianWaitMs: Math.round(waits.sort((x, y) => x - y)[Math.floor(waits.length / 2)]) };
  write(`p6-probe-row-loop-${a1}.json`, res);
  console.log(JSON.stringify(res));
  await p.$disconnect();
} else if (mode === 'digest') {
  const p = db(); console.log((await inspect(p, journalAt())).digest); await p.$disconnect();
} else if (mode === 'clear-once') {
  const p = db(); const j = journalAt();
  fs.writeFileSync(`/results/p6-nodepid-${a1}`, String(process.pid));
  const digest = a3 && a3 !== '-' ? a3 : (await inspect(p, j)).digest;
  let r;
  try { r = await clear(p, j, { digest, reason: `phase 0.5 ${a1}`, crashAt: a2 && a2 !== '-' ? a2 : undefined, onBackend: async (pid) => fs.writeFileSync(`/results/p6-backend-${a1}`, String(pid)) }); } catch (e) { r = { error: String(e.message).split('\n').filter(Boolean).at(-1).slice(0, 160) }; }
  write(`p6-clear-${a1}.json`, r);
  console.log(JSON.stringify({ label: a1, ...r }));
  await p.$disconnect();
} else if (mode === 'kill-db') {
  // Terminates the clearing transaction's backend from another session once it has run for a while (a database interruption).
  const o = direct();
  for (let i = 0; i < 400 && !fs.existsSync(`/results/p6-backend-${a1}`); i++) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, Number(a2 ?? 1500)));
  const pid = Number(fs.readFileSync(`/results/p6-backend-${a1}`, 'utf8'));
  const [{ t }] = await o.$queryRaw`SELECT pg_terminate_backend(${pid}::int) AS t`;
  console.log(JSON.stringify({ terminatedBackend: pid, ok: t }));
  await o.$disconnect();
} else if (mode === 'state') {
  const o = direct();
  const [r] = await o.$queryRaw`SELECT (SELECT journal_seq FROM installation_state) AS db_head, (SELECT count(*)::int FROM approval WHERE superseded_at IS NULL) AS live_approvals, (SELECT count(*)::int FROM audit WHERE action = 'recovery_cleared') AS cleared_audits, (SELECT count(*)::int FROM action WHERE status = 'PROPOSED') AS proposed`;
  const cleared = fs.readFileSync(journalAt().file, 'utf8').split('\n').filter((l) => l.includes('"type":"cleared"')).length;
  console.log(JSON.stringify({ label: a1, ...r, clearedRecordsInJournal: cleared }));
  await o.$disconnect();
}
