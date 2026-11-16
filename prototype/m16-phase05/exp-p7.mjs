// P7 on Docker Desktop ONLY (not native Linux, not a power loss): claims are killed mid-run by a process kill or a
// container kill; afterwards every claim the database committed must be in the journal, the chain intact (a torn
// tail allowed), and the heads either equal or the journal one claim ahead.
import fs from 'node:fs';
import os from 'node:os';
import { claim, db, direct, journalAt } from './lib/proto.mjs';
import { fresh, seed, write } from './lib/fixtures.mjs';
import { trustProblem } from './lib/journal.mjs';
const [mode, label] = process.argv.slice(2);
if (mode === 'setup') { const { p } = await fresh(); await seed(p, { orgs: 1, perOrg: 20000 }); await p.$disconnect(); }
else if (mode === 'run') { const p = db(); const j = journalAt(); for (let i = 1; i <= 20000; i++) await claim(p, j, `a-1-${i}`); }
else if (mode === 'check') {
  const o = direct(); const j = journalAt();
  const s = j.state({ forceFull: true });
  const [row] = await o.$queryRaw`SELECT installation_id, journal_seq, head_hash FROM installation_state WHERE id = 1`;
  const committed = (await o.$queryRaw`SELECT id FROM action WHERE status = 'EXECUTING'`).map((r) => r.id);
  const recs = fs.readFileSync(j.file, 'utf8').split('\n').filter((l) => { try { JSON.parse(l); return true; } catch { return false; } }).map((l) => JSON.parse(l));
  const inJournal = new Set(recs.filter((e) => e.type === 'claim').map((e) => e.actionId));
  const res = { label, journalStatus: s.status, tornBytes: s.tornBytes ?? 0, journalHead: s.head, databaseHead: row.journal_seq, committedClaims: committed.length,
    committedClaimsMissingFromJournal: committed.filter((id) => !inJournal.has(id)).length, trust: trustProblem(row, { installationId: j.identity(), ...s }) ?? 'trusted',
    environment: { kernel: os.release(), stateMount: fs.readFileSync('/proc/mounts', 'utf8').split('\n').find((l) => / \/state /.test(l)) } };
  write(`p7-${label}.json`, res); console.log(JSON.stringify(res)); await o.$disconnect();
}
