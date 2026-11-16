// P4: incremental journal verification (design §6.2). Modes: correctness | perf <records> | multi <label> <first> <last> | concurrent-reader | multi-verify
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { Journal, serialize, trustProblem } from './lib/journal.mjs';
import { appendLocked, claim, db, direct, journalAt, now } from './lib/proto.mjs';
import { fresh, rssMB, seed, stats, write, writeJournal } from './lib/fixtures.mjs';

const mode = process.argv[2];
const row = async (o) => (await o.$queryRaw`SELECT installation_id, journal_seq, head_hash FROM installation_state WHERE id = 1`)[0];
const trust = async (o, j, opts) => { const s = j.state(opts); return { status: s.status, mode: s.mode, reason: s.reason ?? null, head: s.head, problem: trustProblem(await row(o), s) }; };

if (mode === 'correctness') {
  const { p: o, j } = await fresh();
  await seed(o, { orgs: 1, perOrg: 3000 });
  const p = db();
  const out = {};
  // a. sequential claims: one full verification, then incremental
  const modes = {};
  for (let i = 1; i <= 2000; i++) { const r = await claim(p, j, `a-1-${i}`); modes[r.timing.verifyMode] = (modes[r.timing.verifyMode] ?? 0) + 1; if (!r.claimed) throw new Error(JSON.stringify(r)); }
  out['a: 2000 sequential claims'] = { verifyModes: modes, ...await trust(o, j) };
  // c. restart: a new process has no cache, so its first check is a full verification
  out['c: new process'] = { ...await trust(o, new Journal(j.dir)) };
  const snapshot = fs.readFileSync(j.file);
  const backupOlder = snapshot.subarray(0, snapshot.lastIndexOf('\n', snapshot.length - 2) + 1); // without the last record
  // d. replaced by an identical copy (new inode): full verification, still trusted
  fs.writeFileSync(`${j.dir}/copy.log`, snapshot); fs.renameSync(`${j.dir}/copy.log`, j.file);
  out['d1: replaced by identical copy (new inode)'] = await trust(o, j);
  // d2. replaced by an older copy: behind the database
  fs.writeFileSync(`${j.dir}/copy.log`, backupOlder); fs.renameSync(`${j.dir}/copy.log`, j.file);
  out['d2: replaced by an older copy'] = await trust(o, j);
  fs.writeFileSync(j.file, snapshot); j.verifier.cache = null; await trust(o, j);
  // d3. replaced by a different journal of the same size and head (another chain): only the head-hash anchor catches it
  const other = writeJournal(`${j.dir}/other.log`, 2000, { actionPrefix: 'x', claimsOnly: true }); // same head (2000) as the database
  const sameSize = fs.statSync(`${j.dir}/other.log`).size;
  out['d3: replaced by a different chain with the same head'] = { otherHead: other.head, ...await (async () => { fs.renameSync(`${j.dir}/other.log`, j.file); return trust(o, j); })(), note: `other journal ${sameSize} bytes` };
  fs.writeFileSync(`${j.dir}/copy.log`, snapshot); fs.renameSync(`${j.dir}/copy.log`, j.file); await trust(o, j);
  // e. shrunk in place (same inode)
  fs.truncateSync(j.file, backupOlder.length);
  out['e: shrunk in place'] = await trust(o, j);
  fs.writeFileSync(j.file, snapshot); j.verifier.cache = null; await trust(o, j);
  // f. last record rewritten in place, same length, same inode
  { const fd = fs.openSync(j.file, 'r+'); const lastStart = snapshot.lastIndexOf('\n', snapshot.length - 2) + 1; const b = Buffer.from(snapshot.subarray(lastStart)); const k = b.indexOf('"at":"') + 10; b[k] = b[k] === 0x31 ? 0x32 : 0x31; fs.writeSync(fd, b, 0, b.length, lastStart); fs.closeSync(fd); }
  out['f: last record rewritten in place'] = await trust(o, j);
  fs.writeFileSync(j.file, snapshot); j.verifier.cache = null; await trust(o, j);
  // g. torn final record
  fs.appendFileSync(j.file, '{"type":"claim","seq":20');
  out['g: torn final record'] = await trust(o, j);
  try { j.append({ type: 'claim', seq: 9999 }); out['g: torn final record'].appendAfter = 'allowed (WRONG)'; } catch (e) { out['g: torn final record'].appendAfter = `refused: ${e.code}`; }
  fs.writeFileSync(j.file, snapshot); j.verifier.cache = null; await trust(o, j);
  // h. an EARLIER record edited in place, same length: invisible to the incremental check, caught by a full one
  { const fd = fs.openSync(j.file, 'r+'); const pos = snapshot.indexOf('"at":"', 1000) + 10; fs.writeSync(fd, Buffer.from([snapshot[pos] === 0x31 ? 0x32 : 0x31]), 0, 1, pos); fs.closeSync(fd); }
  out['h: earlier record edited in place'] = { incremental: await trust(o, j), scheduledFull: await trust(o, j, { forceFull: true }) };
  fs.writeFileSync(j.file, snapshot); j.verifier.cache = null; await trust(o, j);
  // i. database head mismatch
  await o.$executeRaw`UPDATE installation_state SET journal_seq = journal_seq - 1`;
  out['i: database head behind'] = await trust(o, j);
  await o.$executeRaw`UPDATE installation_state SET journal_seq = journal_seq + 1`;
  // j. stale cache: B appends; A's cache must see the new bytes, not keep the old head
  const A = new Journal(j.dir), B = new Journal(j.dir);
  await trust(o, A);
  for (let i = 2001; i <= 2010; i++) await claim(p, B, `a-1-${i}`);
  out['j: another process appended 10 claims'] = await trust(o, A);
  fs.writeFileSync(`${j.dir}/copy.log`, snapshot); fs.renameSync(`${j.dir}/copy.log`, j.file);
  out['j: another process replaced the file with an older copy'] = await trust(o, A);
  out.fullVerificationCounts = { mainProcess: j.verifier.counts, A: A.verifier.counts, B: B.verifier.counts };
  write('p4-correctness.json', out);
  for (const [k, v] of Object.entries(out)) console.log(k.padEnd(56), JSON.stringify(v));
  await p.$disconnect(); await o.$disconnect();
} else if (mode === 'concurrent-reader') {
  // k. unlocked verification while another process appends: a reader may see a partial record, never a corrupt one
  const { p: o, j } = await fresh();
  await seed(o, { orgs: 1, perOrg: 2500 });
  const writer = spawn(process.execPath, ['exp-p4.mjs', 'writer'], { env: process.env, stdio: 'inherit' });
  const reader = new Journal(j.dir);
  const seen = { ok: 0, torn_tail: 0, corrupt: 0, empty: 0, other: 0 };
  let done = false; writer.on('exit', () => (done = true));
  while (!done) { const s = reader.state(); seen[s.status] = (seen[s.status] ?? 0) + 1; if (s.status === 'corrupt') seen.lastCorrupt = s.problem; await new Promise((r) => setImmediate(r)); }
  const final = reader.state();
  write('p4-concurrent-reader.json', { readerChecks: seen, final: { status: final.status, head: final.head }, readerCounts: reader.verifier.counts });
  console.log(JSON.stringify({ readerChecks: seen, final: { status: final.status, head: final.head }, readerCounts: reader.verifier.counts }));
  await o.$disconnect();
} else if (mode === 'writer') {
  const p = db(); const j = journalAt();
  for (let i = 1; i <= 2000; i++) await claim(p, j, `a-1-${i}`);
  await p.$disconnect();
} else if (mode === 'perf') {
  // Performance at a journal size: cold full verification (new process), then 1000 claims with incremental checks.
  const n = Number(process.argv[3]);
  const { p: o, j } = await fresh();
  const w = writeJournal(j.file, n / 2, { actionPrefix: 'h' }); // n/2 claims + n/2 dispatch records = n records
  await o.$executeRaw`UPDATE installation_state SET journal_seq = ${w.head}, head_hash = ${w.headHash}`;
  await seed(o, { orgs: 1, perOrg: 1000, prefix: 'p' });
  const cold = new Journal(j.dir);
  const rss0 = rssMB(); let peak = rss0; const sampler = setInterval(() => (peak = Math.max(peak, rssMB())), 2);
  const t0 = now(); const s = cold.state(); const coldMs = now() - t0;
  clearInterval(sampler);
  const forced = []; for (let i = 0; i < 3; i++) { const t = now(); cold.state({ forceFull: true }); forced.push(now() - t); }
  const p = db(); const verify = [], total = [], modes = {};
  for (let i = 1; i <= 1000; i++) { const r = await claim(p, cold, `p-1-${i}`); if (!r.claimed) throw new Error(JSON.stringify(r)); verify.push(r.timing.verify); total.push(r.timing.total); modes[r.timing.verifyMode] = (modes[r.timing.verifyMode] ?? 0) + 1; }
  const res = { records: n, bytes: w.bytes, coldFullVerifyMs: Math.round(coldMs), coldStatus: s.status, fullVerifyMs: stats(forced), rssBeforeMB: rss0, rssPeakDuringFullMB: peak, perClaimVerifyMs: stats(verify), perClaimTotalMs: stats(total), verifyModes: modes };
  write(`p4-perf-${n}.json`, res);
  console.log(JSON.stringify(res));
  await p.$disconnect(); await o.$disconnect();
} else if (mode === 'multi-setup') {
  const { p: o } = await fresh();
  await seed(o, { orgs: 1, perOrg: 1000 });
  await o.$disconnect();
} else if (mode === 'multi') {
  const [label, a, b] = process.argv.slice(3);
  const p = db(); const j = journalAt(); const verify = [], modes = {};
  for (let i = Number(a); i <= Number(b); i++) { const r = await claim(p, j, `a-1-${i}`); if (r.claimed) await appendLocked(p, j, { type: 'dispatch', seq: r.seq, at: new Date().toISOString() }); verify.push(r.timing.verify); modes[r.timing.verifyMode] = (modes[r.timing.verifyMode] ?? 0) + 1; }
  write(`p4-multi-${label}.json`, { verify: stats(verify), modes, counts: j.verifier.counts });
  await p.$disconnect();
} else if (mode === 'multi-verify') {
  const o = direct(); const j = journalAt();
  const r = await row(o); const s = j.state({ forceFull: true });
  const [{ ex }] = await o.$queryRaw`SELECT count(*)::int AS ex FROM action WHERE status = 'EXECUTING'`;
  const recs = fs.readFileSync(j.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const seqs = recs.filter((e) => e.type === 'claim').map((e) => e.seq);
  const res = { journalStatus: s.status, journalHead: s.head, databaseHead: r.journal_seq, headHashMatches: r.head_hash === s.headHash, claims: seqs.length, uniqueSeqs: new Set(seqs).size, executing: ex, problem: trustProblem(r, { installationId: j.identity(), ...s }), a: JSON.parse(fs.readFileSync('/results/p4-multi-a.json')), b: JSON.parse(fs.readFileSync('/results/p4-multi-b.json')) };
  write('p4-multi.json', res);
  console.log(JSON.stringify(res));
  await o.$disconnect();
}

if (mode === 'verify-mem') {
  // Peak memory of a cold full verification, measured by the OS (maxRSS) in a process that does nothing else.
  const n = Number(process.argv[3]);
  const { p: o, j } = await fresh();
  writeJournal(j.file, n / 2, { actionPrefix: 'h' });
  await o.$disconnect();
  const { spawnSync } = await import('node:child_process');
  const base = spawnSync(process.execPath, ['-e', 'console.log(process.resourceUsage().maxRSS)'], { encoding: 'utf8' });
  const r = spawnSync(process.execPath, ['-e', `import('/proto/lib/journal.mjs').then(({ Journal }) => { const t = performance.now(); const s = new Journal('${j.dir}').state(); console.log(JSON.stringify({ status: s.status, head: s.head, ms: Math.round(performance.now() - t), maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024) })); })`], { encoding: 'utf8' });
  const res = { records: n, bytes: fs.statSync(j.file).size, emptyNodeMaxRssMB: Math.round(Number(base.stdout) / 1024), ...JSON.parse(r.stdout.trim()) };
  write(`p4-mem-${n}.json`, res);
  console.log(JSON.stringify(res));
}
