// inspect, then clear with the inspected digest (optionally holding the state lock for a while inside the clearance).
import fs from 'node:fs';
import { clear, db, inspect, journalAt } from './lib/proto.mjs';
const [name, holdMs = '0'] = process.argv.slice(2);
const p = db(); const j = journalAt();
const v = await inspect(p, j);
const r = await clear(p, j, { digest: v.digest, reason: `prototype ${name}`, holdMs: Number(holdMs) });
const after = await inspect(p, j);
const out = { before: { problem: v.problem, dbHead: v.dbHead, journalHead: v.journalHead, after: v.after.map((c) => ({ seq: c.seq, actionId: c.actionId, dispatched: c.dispatched })) }, clear: r, afterProblem: after.problem };
fs.writeFileSync(`/results/exp-b-${name}-recover.json`, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out));
await p.$disconnect();
