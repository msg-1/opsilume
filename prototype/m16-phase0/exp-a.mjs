// Experiment A: append + flush latency and throughput, parse cost, full disk, unavailable storage.
// Run in its own container (see run-exp-a.sh) with: /vol (a named Docker volume), /mem (tmpfs), /full (64 KiB tmpfs), /ro (read-only tmpfs).
import fs from 'node:fs';
import os from 'node:os';
import { fork, spawnSync } from 'node:child_process';
import { Journal, parse, serialize, GENESIS } from './lib/journal.mjs';
import { stats } from './lib/fixtures.mjs';

const role = process.argv[2];
const line = (i, w = 0) => `${JSON.stringify({ type: 'claim', seq: i, actionId: `a-${w}-${i}`, org: 'org-1', attempt: 1, at: new Date().toISOString(), pad: 'x'.repeat(120) })}\n`;

// Child: one concurrent writer appending `n` lines with O_APPEND + fsync.
if (role === 'writer') {
  const [, , , file, w, n] = process.argv;
  for (let i = 1; i <= Number(n); i++) {
    const fd = fs.openSync(file, 'a');
    fs.writeSync(fd, line(i, w));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  }
  process.exit(0);
}
// Child: tries the journal as an unprivileged user.
if (role === 'unprivileged') {
  const j = new Journal(process.argv[3]);
  try {
    j.append({ type: 'claim', seq: 1 });
    console.log(JSON.stringify({ ok: true }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, code: e.code, message: e.message }));
  }
  process.exit(0);
}

const out = { environment: {}, latency: {}, journalAppend: {}, throughput: {}, parse: {}, diskFull: {}, unavailable: {} };
out.environment = {
  kernel: os.release(), arch: os.arch(), cpus: os.cpus().length, node: process.version,
  mounts: fs.readFileSync('/proc/mounts', 'utf8').split('\n').filter((l) => / \/(vol|mem|full|ro|tmp) /.test(l) || / \/ overlay/.test(l)),
};
const N = Number(process.env.N ?? 2000);
const time = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };

// 1. Raw primitive: one O_APPEND write of a ~220-byte line, then nothing / fdatasync / fsync.
for (const [target, dir] of [['docker-volume', '/vol/a'], ['container-overlay', '/tmp/a'], ['tmpfs', '/mem/a']]) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  out.latency[target] = {};
  for (const mode of ['none', 'fdatasync', 'fsync']) {
    const file = `${dir}/${mode}.log`;
    const xs = [];
    for (let i = 1; i <= N; i++) {
      xs.push(time(() => {
        const fd = fs.openSync(file, 'a');
        fs.writeSync(fd, line(i));
        if (mode === 'fsync') fs.fsyncSync(fd);
        if (mode === 'fdatasync') fs.fdatasyncSync(fd);
        fs.closeSync(fd);
      }));
    }
    out.latency[target][mode] = stats(xs);
  }
}

// 2. The prototype's Journal.append (parse the whole file to find the tail hash, then append + fsync), as the journal grows.
{
  const dir = '/vol/journal-append';
  fs.rmSync(dir, { recursive: true, force: true });
  const j = new Journal(dir);
  j.create();
  const xs = { '1-250': [], '251-500': [], '501-1000': [] };
  for (let i = 1; i <= 1000; i++) {
    const ms = time(() => j.append({ type: 'claim', seq: i, actionId: `a-${i}`, org: 'org-1', attempt: 1, at: new Date().toISOString() }));
    xs[i <= 250 ? '1-250' : i <= 500 ? '251-500' : '501-1000'].push(ms);
  }
  for (const k of Object.keys(xs)) out.journalAppend[`lines ${k}`] = stats(xs[k]);
  out.journalAppend.finalStatus = parse(j.read()).status;
}

// 3. Throughput and integrity with k concurrent writer processes appending to one file (no lock, O_APPEND only).
for (const k of [1, 2, 4, 8]) {
  const file = `/vol/concurrent-${k}.log`;
  fs.rmSync(file, { force: true });
  const per = Math.floor(2000 / k);
  const t = process.hrtime.bigint();
  await Promise.all(Array.from({ length: k }, (_, w) => new Promise((r) => fork(new URL(import.meta.url).pathname, ['writer', file, String(w), String(per)]).on('exit', r))));
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let intact = 0;
  for (const l of lines) try { JSON.parse(l); intact++; } catch {}
  out.throughput[`${k} writer(s)`] = { appends: k * per, ms: Math.round(ms), perSecond: Math.round((k * per) / (ms / 1000)), linesFound: lines.length, linesIntact: intact };
}

// 4. Parse (verification) cost as the journal grows: the trust check reads the whole file in this prototype.
for (const n of [1_000, 10_000, 100_000]) {
  let prev = GENESIS;
  let text = '';
  for (let i = 1; i <= n; i++) {
    const l = serialize({ type: 'claim', seq: i, actionId: `a-${i}`, org: 'org-1', attempt: 1, at: '2026-11-16T00:00:00.000Z' }, prev);
    prev = JSON.parse(l).hash;
    text += l;
  }
  fs.writeFileSync(`/vol/parse-${n}.log`, text);
  const xs = [];
  for (let r = 0; r < 5; r++) xs.push(time(() => parse(fs.readFileSync(`/vol/parse-${n}.log`, 'utf8'))));
  out.parse[`${n} records`] = { bytes: Buffer.byteLength(text), ...stats(xs) };
}

// 5. Full disk: a 64 KiB tmpfs; append until the filesystem refuses.
{
  const j = new Journal('/full/j');
  j.create();
  let appended = 0;
  let error = null;
  for (let i = 1; i < 10_000; i++) {
    try {
      j.append({ type: 'claim', seq: i, actionId: `a-${i}`, org: 'org-1', attempt: 1, at: new Date().toISOString(), pad: 'x'.repeat(200) });
      appended++;
    } catch (e) {
      error = { code: e.code, message: e.message.slice(0, 120) };
      break;
    }
  }
  const after = parse(j.read());
  let next = null;
  try { j.append({ type: 'claim', seq: appended + 1 }); } catch (e) { next = { code: e.code, message: e.message.slice(0, 120) }; }
  out.diskFull = { appended, firstError: error, journalStatusAfter: after.status, head: after.head, tornBytes: after.tornBytes ?? 0, nextAppend: next };
}

// 6. Unavailable storage.
{
  // a) read-only filesystem
  const ro = new Journal('/ro/j');
  try { ro.create(); out.unavailable.readOnlyCreate = { ok: true }; } catch (e) { out.unavailable.readOnlyCreate = { ok: false, code: e.code }; }
  // b) the journal file deleted while in use: the next append must refuse, not recreate it
  const j = new Journal('/vol/deleted');
  fs.rmSync('/vol/deleted', { recursive: true, force: true });
  j.create();
  j.append({ type: 'claim', seq: 1, actionId: 'a', org: 'o', attempt: 1 });
  fs.rmSync(j.file);
  try { j.append({ type: 'claim', seq: 2 }); out.unavailable.fileDeleted = { appended: true }; } catch (e) { out.unavailable.fileDeleted = { appended: false, code: e.code, recreated: fs.existsSync(j.file) }; }
  // c) permission denied: a root-owned journal opened by uid 1000
  const dir = '/vol/rootonly';
  fs.rmSync(dir, { recursive: true, force: true });
  new Journal(dir).create();
  fs.chmodSync(dir, 0o755);
  fs.chmodSync(`${dir}/journal.log`, 0o644);
  const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname, 'unprivileged', dir], { uid: 1000, gid: 1000, encoding: 'utf8' });
  out.unavailable.permissionDenied = JSON.parse(r.stdout.trim().split('\n').at(-1));
}

fs.writeFileSync('/results/exp-a.json', `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ latency: out.latency, journalAppend: out.journalAppend, throughput: out.throughput, parse: out.parse, diskFull: out.diskFull, unavailable: out.unavailable }, null, 1));
