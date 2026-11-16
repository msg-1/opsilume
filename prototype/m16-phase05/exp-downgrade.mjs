// No-downgrade policy (N9): a newer application has journal state; an older one (no journal) then claims.
import { claim, direct, journalAt, legacyClaim, send, sweep } from './lib/proto.mjs';
import { fresh, seed, write } from './lib/fixtures.mjs';
import { trustProblem } from './lib/journal.mjs';

const R = process.env.RECEIVER_URL;
const hits = async () => (await (await fetch(R.replace('/hook', '/hits'))).json()).length;
const out = {};
for (const guard of [false, true]) {
  await fetch(R.replace('/hook', '/reset'), { method: 'POST' });
  const { p, j } = await fresh({ guard });
  await seed(p, { orgs: 1, perOrg: 4 });
  const newer = await claim(p, j, 'a-1-1'); // the newer application, with the journal
  let older;
  try {
    older = await legacyClaim(p, 'a-1-2'); // an older application: no journal record, no state row
    if (older.claimed) await send(R, { actionId: 'a-1-2', from: 'older application' });
  } catch (e) {
    older = { claimed: false, error: String(e.message).split('\n').filter(Boolean).at(-1).slice(0, 160) };
  }
  const [a] = await p.$queryRaw`SELECT status FROM action WHERE id = 'a-1-2'`;
  const journal = j.state({ forceFull: true });
  const [row] = await p.$queryRaw`SELECT installation_id, journal_seq, head_hash FROM installation_state WHERE id = 1`;
  const newerAfter = await claim(p, j, 'a-1-3');
  await sweep(p); // the guard must not block other transitions (EXECUTING -> FAILED)
  const [swept] = await p.$queryRaw`SELECT count(*)::int AS n FROM action WHERE status = 'FAILED'`;
  out[guard ? 'with the database guard' : 'without a guard (the design as approved)'] = {
    newerApplicationClaim: newer.claimed, olderApplicationClaim: older, olderActionStatus: a.status,
    olderActionInJournal: (journal.status === 'ok') && false, journalHead: journal.head, databaseHead: row.journal_seq,
    trustAfterOlderClaim: trustProblem(row, { installationId: j.identity(), ...journal }) ?? 'trusted (the older execution is invisible)',
    receiverRequests: await hits(), newerClaimAfterwards: newerAfter.claimed, sweepStillWorks: swept.n > 0,
  };
  await p.$disconnect();
}
write('downgrade.json', out);
for (const [k, v] of Object.entries(out)) console.log(k, JSON.stringify(v));
