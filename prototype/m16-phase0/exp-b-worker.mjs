// Experiment B worker: claims a list of actions (each followed by a dispatch record), recording latency and lock wait.
//   node exp-b-worker.mjs <label> <first> <last> [shared] [failEvery] [procs]
import fs from 'node:fs';
import { fork } from 'node:child_process';
import { appendLocked, claim, db, journalAt } from './lib/proto.mjs';

const [label, first, last, shared = '0', failEvery = '0', procs = '1'] = process.argv.slice(2);
if (Number(procs) > 1 && !process.env.CHILD) {
  // Several processes in this container, splitting the range.
  const a = Number(first), b = Number(last), k = Number(procs), size = Math.ceil((b - a + 1) / k);
  await Promise.all(Array.from({ length: k }, (_, i) => new Promise((r) => fork(new URL(import.meta.url).pathname, [`${label}.${i}`, String(a + i * size), String(Math.min(b, a + (i + 1) * size - 1)), shared, failEvery, '1'], { env: { ...process.env, CHILD: '1' } }).on('exit', r))));
  process.exit(0);
}
const p = db();
const j = journalAt();
const ids = [];
for (let i = Number(first); i <= Number(last); i++) ids.push(`a-1-${i}`);
for (let i = 1; i <= Number(shared); i++) ids.push(`s-1-${i}`);
const rows = [];
const t0 = Date.now();
for (const [n, id] of ids.entries()) {
  const failAudit = Number(failEvery) > 0 && n % Number(failEvery) === 0 && !id.startsWith('s-');
  try {
    const r = await claim(p, j, id, { failAudit });
    if (r.claimed) await appendLocked(p, j, { type: 'dispatch', seq: r.seq, at: new Date().toISOString() });
    rows.push({ id, claimed: r.claimed, reason: r.reason ?? null, seq: r.seq ?? null, lockWait: r.lockWait, latency: r.latency });
  } catch (e) {
    rows.push({ id, claimed: false, reason: failAudit ? 'injected_rollback' : `error: ${String(e.message).split('\n').at(-1).slice(0, 100)}` });
  }
}
fs.writeFileSync(`/results/exp-b-${label}.json`, JSON.stringify({ label, ms: Date.now() - t0, rows }));
await p.$disconnect();
