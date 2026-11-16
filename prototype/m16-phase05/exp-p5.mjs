// P5: unknown COMMIT result, injected at the PostgreSQL wire protocol by proxy.mjs (no simulated exceptions).
// The application talks to PostgreSQL through the proxy; observation uses a direct connection.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { claim, db, direct, execute, journalAt, resolveUncertain, sweep } from './lib/proto.mjs';
import { fresh, seed, write } from './lib/fixtures.mjs';
import { headHash } from './lib/journal.mjs';

const P = process.env.PROXY_URL, R = process.env.RECEIVER_URL;
const ctl = (path, body) => fetch(`${P}${path}`, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const hits = async () => (await (await fetch(R.replace('/hook', '/hits'))).json()).length;
const observe = async (o, j, id) => {
  const [row] = await o.$queryRaw`SELECT journal_seq, head_hash FROM installation_state WHERE id = 1`;
  const [a] = await o.$queryRaw`SELECT status, attempts FROM action WHERE id = ${id}`;
  const js = j.state({ forceFull: true });
  return { databaseHead: row.journal_seq, action: a, journalHead: js.head, journalRecords: fs.readFileSync(j.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).type) };
};
const prefixKept = (before, after) => after.subarray(0, before.length).equals(before);

if (process.argv[2] === 'child') {
  // Scenario 5's first process: the commit is cut, then this process exits without resolving.
  const r = await execute(db(), journalAt(), 'a-1-1', R);
  console.log(JSON.stringify({ reason: r.reason, uncertain: !!r.uncertain }));
  process.exit(0);
}

const out = [];
async function scenario(name, setup, run) {
  await ctl('/reset', {});
  await fetch(R.replace('/hook', '/reset'), { method: 'POST' });
  const { p: o, j } = await fresh();
  await seed(o, { orgs: 1, perOrg: 2 });
  const p = db();
  const before = fs.readFileSync(j.file);
  const res = await run({ p, o, j, before });
  res.journalOnlyAppended = prefixKept(before, fs.readFileSync(j.file));
  res.proxyEvents = (await ctl('/events')).map((e) => e.event + (e.mode ? ` (${e.mode})` : '') + (e.firstByte ? ` [${e.firstByte}]` : '') + (e.messageType ? ` via '${e.messageType}'` : ''));
  out.push({ scenario: name, ...res });
  console.log(JSON.stringify({ scenario: name, ...res }));
  await p.$disconnect().catch(() => {});
  await o.$disconnect();
}

// 1. The database commits; the client never receives the answer.
await scenario('1: committed, response lost', null, async ({ p, o, j }) => {
  await ctl('/arm', { mode: 'drop_after_commit_response' });
  const r = await execute(p, j, 'a-1-1', R);
  const atUncertain = await observe(o, j, 'a-1-1');
  const res = await resolveUncertain(db(), j, r.uncertain);
  await sweep(o);
  const [after] = await o.$queryRaw`SELECT status, outcome FROM action WHERE id = 'a-1-1'`;
  return { claimResult: r.reason, error: r.error, dispatchedRequests: await hits(), atUncertain, resolution: res, afterSweep: after, automaticRetryPermitted: after.status === 'FAILED' && after.outcome === 'not_applied' };
});

// 2. The transaction rolls back AT COMMIT (a deferred foreign key fails), and the client never receives the error.
await scenario('2: rolled back at commit, response lost', null, async ({ p, o, j }) => {
  await ctl('/arm', { mode: 'drop_after_commit_response' });
  const r = await execute(p, j, 'a-1-1', R, { deferredAuditFailure: true });
  const atUncertain = await observe(o, j, 'a-1-1');
  const res = await resolveUncertain(db(), j, r.uncertain);
  const afterRes = await observe(o, j, 'a-1-1');
  const next = await claim(db(), j, 'a-1-2');
  return { claimResult: r.reason, dispatchedRequests: await hits(), atUncertain, resolution: res, afterResolution: afterRes, nextClaimTrusted: next.claimed };
});

// 3. The connection drops during COMMIT: COMMIT never reaches the server, which rolls back on disconnect.
await scenario('3: connection dropped during COMMIT', null, async ({ p, o, j }) => {
  await ctl('/arm', { mode: 'drop_before_commit' });
  const r = await execute(p, j, 'a-1-1', R);
  const atUncertain = await observe(o, j, 'a-1-1');
  const res = await resolveUncertain(db(), j, r.uncertain);
  const afterRes = await observe(o, j, 'a-1-1');
  return { claimResult: r.reason, dispatchedRequests: await hits(), atUncertain, resolution: res, afterResolution: afterRes };
});

// 4 and 6. Committed, answer lost, and PostgreSQL unreachable straight afterwards; then reachable again.
await scenario('4+6: unavailable right after COMMIT, then available again', null, async ({ p, o, j }) => {
  await ctl('/arm', { mode: 'drop_after_commit_response' });
  const pending = execute(p, j, 'a-1-1', R);
  const r = await pending;
  await ctl('/refuse', { on: true });
  const whileDown = await resolveUncertain(db(), j, r.uncertain);
  let claimWhileDown;
  try { claimWhileDown = (await claim(db(), j, 'a-1-2')).reason; } catch (e) { claimWhileDown = `error: ${String(e.message).split('\n').filter(Boolean).at(-1).slice(0, 90)}`; }
  const atDown = await observe(o, j, 'a-1-1');
  await ctl('/refuse', { on: false });
  const afterUp = await resolveUncertain(db(), j, r.uncertain);
  return { claimResult: r.reason, resolutionWhileDown: whileDown, claimWhileDown, stateWhileDown: atDown, resolutionWhenBack: afterUp, dispatchedRequests: await hits() };
});

// 5. The application restarts before resolving: a new process resolves from the journal's last undispatched claim.
await scenario('5: process restarts before resolution', null, async ({ o, j }) => {
  await ctl('/arm', { mode: 'drop_before_commit' });
  const child = spawnSync(process.execPath, ['exp-p5.mjs', 'child'], { encoding: 'utf8', env: process.env });
  const firstProcess = JSON.parse(child.stdout.trim().split('\n').at(-1));
  const atRestart = await observe(o, j, 'a-1-1');
  // Start-up check (design §6.3 step 4): the last claim with no dispatch and no void.
  const recs = fs.readFileSync(j.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const last = recs.filter((e) => e.type === 'claim').at(-1);
  const undispatched = last && !recs.some((e) => e.seq === last.seq && (e.type === 'dispatch' || e.type === 'void'));
  const res = undispatched ? await resolveUncertain(db(), journalAt(), { seq: last.seq, hash: last.hash, actionId: last.actionId, attempt: last.attempt }) : null;
  return { firstProcess, atRestart, startupResolution: res, afterResolution: await observe(o, j, 'a-1-1'), dispatchedRequests: await hits() };
});

write('p5.json', out);
