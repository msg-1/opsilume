// The C1 scenario with a real pg_dump / pg_restore of the prototype database (run-exp-c-restore.sh drives the phases).
import fs from 'node:fs';
import { claim, clear, db, execute, inspect, journalAt } from './lib/proto.mjs';
import { fresh, seed } from './lib/fixtures.mjs';
const phase = process.argv[2];
const R = process.env.RECEIVER_URL;
const hits = async () => (await (await fetch(R.replace('/hook', '/hits'))).json()).length;
const file = '/results/exp-c-restore.json';
const out = fs.existsSync(file) && phase !== 'setup' ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
if (phase === 'setup') {
  await fetch(R.replace('/hook', '/reset'), { method: 'POST' });
  const { p, j } = await fresh();
  await seed(p, { orgs: 2, perOrg: 5 });
  for (const id of ['a-1-1', 'a-1-2']) await execute(p, j, id, R);
  out.beforeBackup = { executed: ['a-1-1', 'a-1-2'], receiverHits: await hits(), journalHead: j.state().head };
} else if (phase === 'after-backup') {
  const p = db(); const j = journalAt();
  for (const id of ['a-1-3', 'a-1-4', 'a-2-1']) await execute(p, j, id, R);
  out.afterBackup = { executed: ['a-1-3', 'a-1-4', 'a-2-1'], receiverHits: await hits(), journalHead: j.state().head };
} else if (phase === 'after-restore') {
  const p = db(); const j = journalAt();
  const [a] = await p.$queryRaw`SELECT status FROM action WHERE id = 'a-1-3'`;
  const r = await claim(p, j, 'a-1-3');
  const v = await inspect(p, j);
  out.afterRestore = { restoredStatusOfA13: a.status, claimAttempt: { claimed: r.claimed, reason: r.reason, problem: r.problem }, receiverHits: await hits(),
    inspection: { problem: v.problem, dbHead: v.dbHead, journalHead: v.journalHead, ranAfterBackup: v.after.map((c) => ({ seq: c.seq, actionId: c.actionId, dispatched: c.dispatched, outcome: c.outcome })), digest: v.digest.slice(0, 16) } };
  const c = await clear(p, j, { digest: v.digest, reason: 'prototype: restored from pg_dump' });
  const states = await p.$queryRaw`SELECT id, status, outcome, note FROM action WHERE id IN ('a-1-1','a-1-2','a-1-3','a-1-4','a-2-1','a-1-5') ORDER BY id`;
  const again = await claim(p, j, 'a-1-3');
  out.clearance = { result: c, actions: states, claimA13Again: { claimed: again.claimed, reason: again.reason }, receiverHits: await hits(), trustedAfter: (await inspect(p, j)).problem === null };
}
fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(phase, JSON.stringify(out[{ setup: 'beforeBackup', 'after-backup': 'afterBackup', 'after-restore': 'afterRestore' }[phase]]));
if (phase === 'after-restore') console.log('clearance', JSON.stringify(out.clearance));
