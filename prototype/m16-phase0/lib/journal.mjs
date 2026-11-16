// Phase 0 prototype of the external execution journal (docs/post-restore-remediation-safety-design.md §6).
// NOT production code: nothing in apps/ imports this, and it runs only in the isolated prototype stack.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const sha = (s) => createHash('sha256').update(s).digest('hex');
export const GENESIS = '0'.repeat(64);

/** One record: the entry, the previous record's hash, and its own hash over both. Ends with a newline. */
export function serialize(entry, prev) {
  const body = { ...entry, prev };
  return `${JSON.stringify({ ...body, hash: sha(JSON.stringify(body)) })}\n`;
}

/**
 * Reads a journal and decides whether it can be trusted. Rules (design §6, N1):
 * - every complete line is a record whose `prev` is the previous record's hash and whose hash is correct;
 * - claim sequences go head+1; a void cancels the most recent claim; dispatch/outcome/reconciled/cleared never move the head;
 * - a final segment with no newline is a torn tail: it was never fsynced, so never committed. It is ignored, not removed;
 * - an unparseable complete line is accepted only when the next line is a `repair` record that names its exact length
 *   (the tooling's acknowledgement of an earlier torn tail). Anything else anywhere is corruption.
 */
export function parse(text) {
  if (text === null) return { status: 'missing', head: null };
  const segments = text.split('\n');
  const tail = segments.pop();
  let prev = GENESIS;
  let head = 0;
  const entries = [];
  const corrupt = (line, problem) => ({ status: 'corrupt', head: null, line, problem, entries });
  for (let i = 0; i < segments.length; i++) {
    const raw = segments[i];
    let e;
    try {
      e = JSON.parse(raw);
      if (!e || typeof e !== 'object' || typeof e.hash !== 'string') throw new Error('not a record');
    } catch {
      let next;
      try {
        next = JSON.parse(segments[i + 1] ?? '');
      } catch {}
      if (next?.type === 'repair' && next.ignoredBytes === Buffer.byteLength(raw) && next.prev === prev) continue;
      return corrupt(i + 1, 'line is not a record');
    }
    const { hash, ...body } = e;
    if (body.prev !== prev) return corrupt(i + 1, 'previous-record hash does not match');
    if (sha(JSON.stringify(body)) !== hash) return corrupt(i + 1, 'record hash does not match its content');
    if (e.type === 'claim') {
      if (e.seq !== head + 1) return corrupt(i + 1, `claim sequence ${e.seq}, expected ${head + 1}`);
      head = e.seq;
    } else if (e.type === 'void') {
      if (e.seq !== head || head === 0) return corrupt(i + 1, `void of ${e.seq}, but the latest claim is ${head}`);
      head -= 1;
    } else if (['dispatch', 'outcome', 'reconciled'].includes(e.type)) {
      if (!Number.isInteger(e.seq) || e.seq < 1 || e.seq > head) return corrupt(i + 1, `${e.type} for unknown claim ${e.seq}`);
    } else if (!['cleared', 'repair', 'genesis'].includes(e.type)) {
      return corrupt(i + 1, `unknown record type ${e.type}`);
    }
    prev = hash;
    entries.push(e);
  }
  if (tail.length) return { status: 'torn_tail', head, lastHash: prev, entries, tornBytes: Buffer.byteLength(tail) };
  return { status: entries.length ? 'ok' : 'empty', head, lastHash: prev, entries };
}

export class Journal {
  constructor(dir, { fsync = 'fsync' } = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'journal.log');
    this.idFile = path.join(dir, 'installation.json');
    this.fsync = fsync; // 'fsync' | 'fdatasync' | 'none' (the last only for latency comparison)
  }
  read() {
    try {
      return fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }
  identity() {
    try {
      return JSON.parse(fs.readFileSync(this.idFile, 'utf8')).installationId;
    } catch {
      return null;
    }
  }
  state() {
    return { installationId: this.identity(), ...parse(this.read()) };
  }
  /** Provisioning: both files created, fsynced, and the directory fsynced so the new entries survive a power loss. */
  create() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(this.file) || fs.existsSync(this.idFile)) throw new Error('state directory is not empty');
    const installationId = randomUUID();
    for (const [file, content] of [[this.idFile, `${JSON.stringify({ installationId, createdAt: new Date().toISOString() })}\n`], [this.file, '']]) {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    }
    const dfd = fs.openSync(this.dir, 'r');
    fs.fsyncSync(dfd);
    fs.closeSync(dfd);
    return installationId;
  }
  /**
   * Appends one record with a single O_APPEND write, then flushes it. The caller must hold the journal
   * mutex (in this prototype, the InstallationState row lock). Refuses to append after a torn tail or
   * to a corrupt journal: the new record would be unreadable or chained to nothing.
   */
  append(entry) {
    const current = parse(this.read());
    if (current.status === 'missing') throw Object.assign(new Error('journal missing'), { code: 'JOURNAL_MISSING' });
    if (current.status === 'corrupt') throw Object.assign(new Error(`journal corrupt: ${current.problem}`), { code: 'JOURNAL_CORRUPT' });
    if (current.status === 'torn_tail') throw Object.assign(new Error('journal has a torn tail; run the repair tool'), { code: 'JOURNAL_TORN' });
    const line = serialize(entry, current.lastHash);
    const fd = fs.openSync(this.file, 'a');
    try {
      // A short write (a full disk returns one instead of an error) is a failure: the record is torn.
      const written = fs.writeSync(fd, line);
      if (written !== Buffer.byteLength(line)) throw Object.assign(new Error(`short write: ${written} of ${Buffer.byteLength(line)} bytes`), { code: 'JOURNAL_SHORT_WRITE' });
      if (this.fsync === 'fsync') fs.fsyncSync(fd);
      else if (this.fsync === 'fdatasync') fs.fdatasyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return line;
  }
  /** Tooling only (N1): ends a torn tail with a newline and a `repair` record naming its length. Nothing is truncated or rewritten. */
  repair() {
    const text = this.read();
    const p = parse(text);
    if (p.status !== 'torn_tail') return { repaired: false, status: p.status };
    const fd = fs.openSync(this.file, 'a');
    fs.writeSync(fd, `\n${serialize({ type: 'repair', ignoredBytes: p.tornBytes, at: new Date().toISOString() }, p.lastHash)}`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    return { repaired: true, ignoredBytes: p.tornBytes };
  }
}

/** Why history can't be trusted, or null. The comparison of design §6, step 3. */
export function trustProblem(row, j) {
  if (!j.installationId) return 'installation identity file missing';
  if (j.status === 'missing') return 'journal missing';
  if (j.status === 'corrupt') return `journal corrupt (${j.problem})`;
  if (!row) return 'database has no installation state (never provisioned, or a pre-feature backup)';
  if (!row.installation_id) return 'database has no installation identity';
  if (row.installation_id !== j.installationId) return 'installation identity differs';
  if (row.journal_seq < j.head) return `database head ${row.journal_seq} is behind the journal head ${j.head}`;
  if (row.journal_seq > j.head) return `database head ${row.journal_seq} is ahead of the journal head ${j.head}`;
  return null;
}
