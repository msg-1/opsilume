// Shared helpers for the experiments: a fresh database and state directory, and synthetic organisations and actions.
import fs from 'node:fs';
import { db, init, journalAt, resetSchema } from './proto.mjs';

/** A fresh schema and an empty state directory, provisioned with `init`. Returns the client and journal. */
export async function fresh(stateDir = process.env.PROTO_STATE_DIR ?? '/state', { provision = true, fsync } = {}) {
  const p = db();
  await resetSchema(p);
  fs.mkdirSync(stateDir, { recursive: true });
  for (const f of fs.readdirSync(stateDir)) fs.rmSync(`${stateDir}/${f}`, { recursive: true, force: true });
  const j = journalAt(stateDir, { fsync });
  if (provision) await init(p, j);
  return { p, j };
}

/** `orgs` organisations, each with `perOrg` actions in `status`, each with `approvals` current approvals. */
export async function seed(p, { orgs = 1, perOrg = 1, status = 'APPROVED', approvals = 1, prefix = 'a' } = {}) {
  await p.$executeRawUnsafe(`INSERT INTO org (id) SELECT 'org-' || g FROM generate_series(1, ${orgs}) g ON CONFLICT DO NOTHING`);
  await p.$executeRawUnsafe(`INSERT INTO action (id, org_id, status) SELECT '${prefix}-' || o || '-' || g, 'org-' || o, '${status}' FROM generate_series(1, ${orgs}) o, generate_series(1, ${perOrg}) g`);
  if (approvals) await p.$executeRawUnsafe(`INSERT INTO approval (action_id) SELECT a.id FROM action a, generate_series(1, ${approvals}) WHERE a.id LIKE '${prefix}-%'`);
}

export const write = (name, data) => fs.writeFileSync(`/results/${name}`, `${JSON.stringify(data, null, 2)}\n`);
export const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
  const r = (v) => Math.round(v * 1000) / 1000;
  return { n: s.length, p50: r(q(0.5)), p95: r(q(0.95)), p99: r(q(0.99)), max: r(s.at(-1)), mean: r(s.reduce((a, b) => a + b, 0) / s.length) };
};
