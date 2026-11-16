import fs from 'node:fs';
import { GENESIS, serialize } from './journal.mjs';
import { db, init, journalAt, resetSchema } from './proto.mjs';

export async function fresh({ guard = false, provision = true } = {}) {
  const p = db(process.env.PROTO_DIRECT_URL);
  await resetSchema(p, { guard });
  const dir = process.env.PROTO_STATE_DIR ?? '/state';
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.rmSync(`${dir}/${f}`, { recursive: true, force: true });
  const j = journalAt(dir);
  if (provision) await init(p, j);
  return { p, j };
}
export async function seed(p, { orgs = 1, perOrg = 1, status = 'APPROVED', approvals = 1, prefix = 'a' } = {}) {
  await p.$executeRawUnsafe(`INSERT INTO org (id) SELECT 'org-' || g FROM generate_series(1, ${orgs}) g ON CONFLICT DO NOTHING`);
  await p.$executeRawUnsafe(`INSERT INTO action (id, org_id, status) SELECT '${prefix}-' || o || '-' || g, 'org-' || o, '${status}' FROM generate_series(1, ${orgs}) o, generate_series(1, ${perOrg}) g`);
  if (approvals) await p.$executeRawUnsafe(`INSERT INTO approval (action_id) SELECT a.id FROM action a, generate_series(1, ${approvals}) WHERE a.id LIKE '${prefix}-%'`);
}
/** Writes a valid journal of `claims` claims (each with a dispatch record) by streaming; returns { head, headHash, bytes }. */
export function writeJournal(file, claims, { actionPrefix = 'h', from = 1, prev = GENESIS, append = false, claimsOnly = false } = {}) {
  const fd = fs.openSync(file, append ? 'a' : 'w');
  let buf = '', head = from - 1, headHash = null, bytes = 0;
  const at = '2026-11-16T12:00:00.000Z';
  for (let i = 0; i < claims; i++) {
    const seq = from + i;
    const c = serialize({ type: 'claim', seq, actionId: `${actionPrefix}-${seq}`, org: 'org-1', attempt: 1, at }, prev);
    headHash = prev = JSON.parse(c).hash;
    buf += c;
    if (!claimsOnly) { const d = serialize({ type: 'dispatch', seq, at }, prev); prev = JSON.parse(d).hash; buf += d; }
    head = seq;
    if (buf.length > 4 << 20) { bytes += fs.writeSync(fd, buf); buf = ''; }
  }
  bytes += fs.writeSync(fd, buf);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  return { head, headHash, lastHash: prev, bytes };
}
export const write = (name, data) => fs.writeFileSync(`/results/${name}`, `${JSON.stringify(data, null, 2)}\n`);
export const stats = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
  const r = (v) => Math.round(v * 1000) / 1000;
  return { n: s.length, p50: r(q(0.5)), p95: r(q(0.95)), p99: r(q(0.99)), max: r(s.at(-1)), mean: r(s.reduce((a, b) => a + b, 0) / s.length) };
};
export const rssMB = () => Math.round(process.memoryUsage().rss / 1048576);
