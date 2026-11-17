// One lock per recorder directory, for everything that reads a ledger, decides, and then writes (the server's request
// handlers and the operator commands run in different processes). Without it a cycle start could read the attestations
// or the readiness record, another process could change them, and the start would still be written.
// A lock whose owner is still running is never taken over: the caller waits, then fails ("recorder busy").
import fs from 'node:fs';
import path from 'node:path';

export const LOCK_FILE = '.recorder.lock';
export class LockBusy extends Error {
  constructor(detail) { super('recorder_busy'); this.status = 503; this.detail = detail; }
}
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Whether a process with this id exists ON THIS HOST. The recorder directory must be local to the one host that uses it. */
export const alive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const ownerOf = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const held = new Set(); // directories this process holds: a nested call in the same process runs straight through

export function withDirLock(dir, fn, { timeoutMs = Number(process.env.P7_LOCK_TIMEOUT_MS ?? 10_000) } = {}) {
  const key = path.resolve(dir);
  // A directory that does not exist yet holds no history and no other process can be working in it: nothing to serialise
  // against, and a refused command must not leave an empty directory behind.
  if (held.has(key) || !fs.existsSync(dir)) return fn();
  const f = path.join(dir, LOCK_FILE), guard = `${f}.takeover`, mine = `${f}.${process.pid}.${Date.now()}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // The lock appears with its owner already written (link is atomic), so a reader never sees an empty lock.
    fs.writeFileSync(mine, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 });
    try { fs.linkSync(mine, f); fs.unlinkSync(mine); break; } catch (e) { fs.unlinkSync(mine); if (e.code !== 'EEXIST') throw e; }
    const o = ownerOf(f);
    if (o && Number.isInteger(o.pid) && !alive(o.pid)) {
      // The owner is gone (it was killed while holding the lock). Only the holder of the takeover guard may remove
      // the lock, and only after seeing the same dead owner again, so a lock that is held is never removed.
      try { fs.closeSync(fs.openSync(guard, 'wx')); } catch { if (Date.now() > deadline) throw new LockBusy(`a takeover of ${f} did not finish`); nap(10); continue; }
      try { const again = ownerOf(f); if (again && again.pid === o.pid && again.at === o.at) fs.unlinkSync(f); } finally { fs.unlinkSync(guard); }
      continue;
    }
    if (Date.now() > deadline) throw new LockBusy(`${f} is held by ${o ? `process ${o.pid} since ${o.at}` : 'an unknown owner'}`);
    nap(10);
  }
  held.add(key);
  try { return fn(); } finally { held.delete(key); try { fs.unlinkSync(f); } catch { /* already gone: nothing to release */ } }
}
