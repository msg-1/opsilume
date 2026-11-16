// Experiment C: torn tails and corruption. Each case gets its own state directory and a fresh database whose
// installation state is set to match the case; then the trust check runs and a real claim is attempted.
// Inputs (journal.log, installation.json) and the outcome are kept under /results/exp-c/<case>/.
import fs from 'node:fs';
import { GENESIS, Journal, parse, serialize } from './lib/journal.mjs';
import { claim, db, resetSchema } from './lib/proto.mjs';

const ID = '11111111-2222-4333-8444-555555555555';
const at = '2026-11-16T12:00:00.000Z';
const base = [
  { type: 'claim', seq: 1, actionId: 'x-1', org: 'org-1', attempt: 1, at }, { type: 'dispatch', seq: 1, at }, { type: 'outcome', seq: 1, outcome: 'applied', at },
  { type: 'claim', seq: 2, actionId: 'x-2', org: 'org-1', attempt: 1, at }, { type: 'dispatch', seq: 2, at },
  { type: 'claim', seq: 3, actionId: 'x-3', org: 'org-1', attempt: 1, at }, { type: 'void', seq: 3, at },
  { type: 'claim', seq: 3, actionId: 'x-4', org: 'org-1', attempt: 1, at }, { type: 'dispatch', seq: 3, at },
];
const chain = (entries) => { let prev = GENESIS, text = ''; for (const e of entries) { const l = serialize(e, prev); prev = JSON.parse(l).hash; text += l; } return text; };
const lines = (t) => t.split('\n').filter(Boolean);
const valid = chain(base);

const cases = {
  '01-valid': { journal: valid, dbHead: 3, expect: 'trusted' },
  '02-incomplete-final-line': { journal: valid + serialize({ type: 'claim', seq: 4, actionId: 'x-5', org: 'org-1', attempt: 1, at }, JSON.parse(lines(valid).at(-1)).hash).slice(0, 60), dbHead: 3, expect: 'torn tail ignored; appends refused until repaired' },
  '03-truncated-final-record-with-newline': { journal: [...lines(valid).slice(0, -1), lines(valid).at(-1).slice(0, 50)].join('\n') + '\n', dbHead: 3, expect: 'quarantined (complete line that is not a record)' },
  '04-corrupted-record-in-middle': { journal: lines(valid).map((l, i) => (i === 3 ? l.replace('"x-2"', '"x-9"') : l)).join('\n') + '\n', dbHead: 3, expect: 'quarantined (hash mismatch)' },
  '05-invalid-sequence-number': { journal: chain(base.map((e, i) => (i === 3 ? { ...e, seq: 7 } : e))), dbHead: 3, expect: 'quarantined (sequence)' },
  '06-invalid-previous-record-hash': { journal: (() => { const ls = lines(valid); const e = JSON.parse(ls[4]); const { hash, ...body } = e; body.prev = 'f'.repeat(64); ls[4] = serialize(Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'prev')), body.prev).trimEnd(); return ls.join('\n') + '\n'; })(), dbHead: 3, expect: 'quarantined (previous hash)' },
  '07-duplicate-sequence-number': { journal: chain([...base.slice(0, 5), { type: 'claim', seq: 2, actionId: 'x-7', org: 'org-1', attempt: 1, at }]), dbHead: 2, expect: 'quarantined (duplicate claim sequence)' },
  '08-missing-journal': { journal: null, dbHead: 3, expect: 'quarantined (missing)' },
  '09a-empty-journal-db-has-history': { journal: '', dbHead: 3, expect: 'quarantined (database ahead)' },
  '09b-empty-journal-fresh-install': { journal: '', dbHead: 0, expect: 'trusted (fresh provisioning)' },
  '10-journal-head-older-than-db': { journal: chain(base.slice(0, 5)), dbHead: 3, expect: 'quarantined (database ahead of journal)' },
  '11-journal-head-newer-than-db': { journal: valid, dbHead: 2, expect: 'quarantined (database behind journal: restore)' },
  '12-installation-file-missing': { journal: valid, dbHead: 3, noIdFile: true, expect: 'quarantined' },
  '13-installation-id-mismatch': { journal: valid, dbHead: 3, dbId: '99999999-0000-4000-8000-000000000000', expect: 'quarantined' },
  '14-database-row-missing-pre-feature': { journal: valid, dbHead: null, expect: 'quarantined' },
  '15-truncated-exactly-to-db-head-after-restore': { journal: chain(base.slice(0, 5)), dbHead: 2, expect: 'NOT detected (accepted risk: truncation to the database head)' },
};

const p = db();
const out = {};
for (const [name, c] of Object.entries(cases)) {
  const dir = `/results/exp-c/${name}`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  if (!c.noIdFile) fs.writeFileSync(`${dir}/installation.json`, `${JSON.stringify({ installationId: ID })}\n`);
  if (c.journal !== null) fs.writeFileSync(`${dir}/journal.log`, c.journal);
  const inputBytes = c.journal === null ? null : Buffer.byteLength(c.journal);
  await resetSchema(p);
  await p.$executeRawUnsafe(`INSERT INTO org (id) VALUES ('org-1')`);
  await p.$executeRawUnsafe(`INSERT INTO action (id, org_id, status) VALUES ('next', 'org-1', 'APPROVED')`);
  if (c.dbHead !== null) await p.$executeRaw`INSERT INTO installation_state (id, installation_id, journal_seq) VALUES (1, ${c.dbId ?? ID}, ${c.dbHead})`;
  const j = new Journal(dir);
  const st = j.state();
  let r;
  try { r = await claim(p, j, 'next'); } catch (e) { r = { claimed: false, reason: 'error', error: String(e.message).split('\n').filter(Boolean).at(-1).slice(0, 140) }; }
  const after = j.read();
  const result = { expect: c.expect, journalStatus: st.status, journalProblem: st.problem ?? null, journalHead: st.head, databaseHead: c.dbHead, claim: { claimed: r.claimed, reason: r.reason, problem: r.problem ?? null, error: r.error ?? null },
    inputUnchangedByFailedClaim: !r.claimed ? (after === null ? c.journal === null : Buffer.byteLength(after) === inputBytes) : null };
  if (name === '02-incomplete-final-line') {
    const rep = j.repair();
    const repaired = j.state();
    const r2 = await claim(p, j, 'next');
    result.repair = { ...rep, statusAfterRepair: repaired.status, headAfterRepair: repaired.head, fragmentPreserved: j.read().includes(c.journal.slice(-30)), bytesBefore: inputBytes, bytesAfter: Buffer.byteLength(j.read()), claimAfterRepair: { claimed: r2.claimed, seq: r2.seq ?? null } };
  }
  out[name] = result;
  fs.writeFileSync(`${dir}/result.json`, `${JSON.stringify(result, null, 2)}\n`);
}
fs.writeFileSync('/results/exp-c.json', `${JSON.stringify(out, null, 2)}\n`);
for (const [k, v] of Object.entries(out)) console.log(k.padEnd(48), v.journalStatus.padEnd(10), `claimed=${v.claim.claimed}`.padEnd(14), (v.claim.problem ?? v.claim.error ?? v.claim.reason ?? '').slice(0, 90), v.repair ? JSON.stringify(v.repair) : '');
await p.$disconnect();
