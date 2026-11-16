// Experiment B checks: journal integrity, unique contiguous sequences, database head = journal head, nothing claimed twice.
import fs from 'node:fs';
import { db, journalAt } from './lib/proto.mjs';
import { stats } from './lib/fixtures.mjs';
const [name, ...labels] = process.argv.slice(2);
const p = db();
const j = journalAt();
const s = j.state();
const [row] = await p.$queryRaw`SELECT journal_seq FROM installation_state WHERE id = 1`;
const live = new Map();
let voids = 0;
for (const e of s.entries ?? []) {
  if (e.type === 'claim') live.set(e.seq, e.actionId);
  if (e.type === 'void') { live.delete(e.seq); voids++; }
}
const claimedIds = [...live.values()];
const [{ executing }] = await p.$queryRaw`SELECT count(*)::int AS executing FROM action WHERE status = 'EXECUTING'`;
const [{ deadlocks }] = await p.$queryRaw`SELECT deadlocks::int FROM pg_stat_database WHERE datname = current_database()`;
const rows = labels.flatMap((l) => { try { return JSON.parse(fs.readFileSync(`/results/exp-b-${l}.json`, 'utf8')).rows; } catch { return []; } });
const ok = rows.filter((r) => r.claimed);
const result = {
  journalStatus: s.status, journalProblem: s.problem ?? null, journalHead: s.head, databaseHead: row?.journal_seq,
  liveClaims: live.size, voids, sequencesContiguous: [...live.keys()].every((k, i, a) => i === 0 || k === a[i - 1] + 1),
  duplicateActionClaims: claimedIds.length - new Set(claimedIds).size, actionsExecuting: executing, workerClaims: ok.length,
  sharedActionsClaimed: claimedIds.filter((x) => x.startsWith('s-')).length,
  refusals: rows.reduce((m, r) => (r.claimed ? m : ((m[r.reason] = (m[r.reason] ?? 0) + 1), m)), {}),
  lockWaitMs: ok.length ? stats(ok.map((r) => r.lockWait)) : null, claimLatencyMs: ok.length ? stats(ok.map((r) => r.latency)) : null,
  workerWallMs: labels.map((l) => { try { return JSON.parse(fs.readFileSync(`/results/exp-b-${l}.json`, 'utf8')).ms; } catch { return null; } }),
  postgresDeadlocksTotal: deadlocks,
};
fs.writeFileSync(`/results/exp-b-${name}-verify.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
await p.$disconnect();
