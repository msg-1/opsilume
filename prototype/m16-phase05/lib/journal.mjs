// Phase 0.5 prototype of the execution journal: P2 (short writes), P4 (incremental verification) and the
// head-hash anchor of design §6.2. NOT production code: nothing in apps/ or services/ imports it.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const sha = (s) => createHash('sha256').update(s).digest('hex');
export const GENESIS = '0'.repeat(64);
const STACK = 64; // live claims remembered for void handling; deeper than that fails closed (headHash null)

export const serialize = (entry, prev) => {
  const body = { ...entry, prev };
  return `${JSON.stringify({ ...body, hash: sha(JSON.stringify(body)) })}\n`;
};

/** Verification state. Plain data, so a copy can be advanced over new bytes without touching the original. */
export const freshState = () => ({ prev: GENESIS, head: 0, claims: [], records: 0, lastStart: 0, pendingFragment: null });
const clone = (st) => ({ ...st, claims: st.claims.slice() });
export const headHash = (st) => (st.head === 0 ? GENESIS : st.claims.at(-1)?.seq === st.head ? st.claims.at(-1).hash : null);

/** Applies one complete record to the state; returns a problem string or null. Same rules as Phase 0, plus the head-hash stack. */
function apply(st, e) {
  const { hash, ...body } = e;
  if (body.prev !== st.prev) return 'previous-record hash does not match';
  if (sha(JSON.stringify(body)) !== hash) return 'record hash does not match its content';
  if (e.type === 'claim') {
    if (e.seq !== st.head + 1) return `claim sequence ${e.seq}, expected ${st.head + 1}`;
    st.head = e.seq;
    st.claims.push({ seq: e.seq, hash });
    if (st.claims.length > STACK) st.claims.shift();
  } else if (e.type === 'void') {
    if (e.seq !== st.head || st.head === 0) return `void of ${e.seq}, but the latest claim is ${st.head}`;
    st.head -= 1;
    st.claims.pop();
  } else if (['dispatch', 'outcome', 'reconciled'].includes(e.type)) {
    if (!Number.isInteger(e.seq) || e.seq < 1 || e.seq > st.head) return `${e.type} for unknown claim ${e.seq}`;
  } else if (!['cleared', 'repair'].includes(e.type)) return `unknown record type ${e.type}`;
  st.prev = hash;
  st.records += 1;
  return null;
}

/**
 * Verifies bytes [start, end) of an open journal in bounded memory (4 MiB reads), continuing from `st`.
 * Returns the state advanced over every complete valid record, the offset just after the last one, and
 * whether a torn (newline-less) tail follows. `onRecord` sees each valid record (used by inspection).
 */
export function verifyRange(fd, start, end, st, onRecord) {
  const CHUNK = 4 << 20;
  const buf = Buffer.alloc(CHUNK);
  let pos = start;
  let carry = Buffer.alloc(0);
  let offset = start; // byte offset of the start of `carry`
  let verified = start;
  while (pos < end) {
    const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, end - pos), pos);
    if (n <= 0) break;
    pos += n;
    let data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
    let from = 0;
    for (let nl = data.indexOf(10, from); nl !== -1; nl = data.indexOf(10, from)) {
      const raw = data.toString('utf8', from, nl);
      const lineStart = offset + from;
      from = nl + 1;
      let e;
      try {
        e = JSON.parse(raw);
        if (!e || typeof e !== 'object' || typeof e.hash !== 'string') throw new Error();
      } catch {
        // An unparseable complete line is allowed only if the very next record is a `repair` naming its length.
        if (st.pendingFragment) return { status: 'corrupt', problem: 'two unrepaired fragments', st, verified };
        st.pendingFragment = { bytes: Buffer.byteLength(raw), prev: st.prev };
        continue;
      }
      if (st.pendingFragment) {
        if (e.type !== 'repair' || e.ignoredBytes !== st.pendingFragment.bytes) return { status: 'corrupt', problem: 'line is not a record', st, verified };
        st.pendingFragment = null;
      }
      const problem = apply(st, e);
      if (problem) return { status: 'corrupt', problem, st, verified };
      st.lastStart = lineStart;
      verified = offset + from;
      onRecord?.(e);
    }
    carry = Buffer.from(data.subarray(from));
    offset += from;
  }
  if (st.pendingFragment) return { status: 'corrupt', problem: 'line is not a record', st, verified };
  return { status: carry.length ? 'torn_tail' : 'ok', st, verified, tornBytes: carry.length };
}

/**
 * The per-process cache of design §6.2. Never shared or persisted; it only decides how much to read.
 * Full verification on: no cache, a forced check, a new device/inode, a shrunk file, or a changed last record.
 * Otherwise only the bytes after the verified offset are read. A corrupt result is never cached, and is
 * confirmed by a full verification before it is reported.
 */
export class Verifier {
  constructor(file) {
    this.file = file;
    this.cache = null;
    this.counts = { full: 0, incremental: 0 };
  }
  check({ forceFull = false } = {}) {
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
    } catch (e) {
      if (e.code === 'ENOENT') return (this.cache = null), { status: 'missing', head: null };
      throw e;
    }
    try {
      const s = fs.fstatSync(fd);
      const c = this.cache;
      let reason = forceFull ? 'forced' : !c ? 'no cache' : s.dev !== c.dev || s.ino !== c.ino ? 'file replaced (device or inode changed)' : s.size < c.verified ? 'file shrank' : null;
      if (!reason && c.verified > c.st.lastStart) {
        const len = c.verified - c.st.lastStart;
        const b = Buffer.alloc(len);
        fs.readSync(fd, b, 0, len, c.st.lastStart);
        // Re-hash the record's CONTENT: comparing only its stored hash field would miss an edit of any other field.
        let ok = false;
        try {
          const { hash, ...body } = JSON.parse(b.toString('utf8').trimEnd());
          ok = hash === c.st.prev && sha(JSON.stringify(body)) === hash;
        } catch {}
        if (!ok) reason = 'last verified record changed';
      }
      let r;
      if (reason) {
        this.counts.full++;
        r = verifyRange(fd, 0, s.size, freshState());
      } else {
        this.counts.incremental++;
        r = verifyRange(fd, c.verified, s.size, clone(c.st));
        if (r.status === 'corrupt') {
          this.counts.full++;
          reason = 'incremental check failed; confirmed by a full verification';
          r = verifyRange(fd, 0, s.size, freshState());
        }
      }
      if (r.status === 'corrupt') {
        this.cache = null;
        return { status: 'corrupt', problem: r.problem, head: null, mode: 'full', reason };
      }
      this.cache = { dev: s.dev, ino: s.ino, verified: r.verified, st: r.st };
      return { status: r.status === 'torn_tail' ? 'torn_tail' : r.st.records ? 'ok' : 'empty', head: r.st.head, headHash: headHash(r.st), lastHash: r.st.prev, tornBytes: r.tornBytes, mode: reason ? 'full' : 'incremental', reason };
    } finally {
      fs.closeSync(fd);
    }
  }
}

export class Journal {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'journal.log');
    this.idFile = path.join(dir, 'installation.json');
    this.verifier = new Verifier(this.file);
  }
  identity() {
    try { return JSON.parse(fs.readFileSync(this.idFile, 'utf8')).installationId; } catch { return null; }
  }
  state(opts) {
    return { installationId: this.identity(), ...this.verifier.check(opts) };
  }
  create(installationId = randomUUID()) {
    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(this.file) || fs.existsSync(this.idFile)) throw new Error('state directory is not empty');
    for (const [file, content] of [[this.idFile, `${JSON.stringify({ installationId })}\n`], [this.file, '']]) {
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
  /** One record, one write, byte count checked (P2), fsync. Caller holds the journal mutex (the state row lock, P3). Returns the record's hash. */
  append(entry) {
    const cur = this.verifier.check();
    if (cur.status === 'missing') throw Object.assign(new Error('journal missing'), { code: 'JOURNAL_MISSING' });
    if (cur.status === 'corrupt') throw Object.assign(new Error(`journal corrupt: ${cur.problem}`), { code: 'JOURNAL_CORRUPT' });
    if (cur.status === 'torn_tail') throw Object.assign(new Error('journal has a torn tail; run the repair tool'), { code: 'JOURNAL_TORN' });
    const line = serialize(entry, cur.lastHash);
    const fd = fs.openSync(this.file, 'a');
    try {
      const written = fs.writeSync(fd, line);
      if (written !== Buffer.byteLength(line)) throw Object.assign(new Error(`short write: ${written} of ${Buffer.byteLength(line)} bytes`), { code: 'JOURNAL_SHORT_WRITE' });
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return JSON.parse(line).hash;
  }
}

/** Why history can't be trusted, or null. Design §6 step 3, with the head hash anchored in the database (P4). */
export function trustProblem(row, j) {
  if (!j.installationId) return 'installation identity file missing';
  if (j.status === 'missing') return 'journal missing';
  if (j.status === 'corrupt') return `journal corrupt (${j.problem})`;
  if (!row) return 'database has no installation state';
  if (!row.installation_id) return 'database has no installation identity';
  if (row.installation_id !== j.installationId) return 'installation identity differs';
  if (row.journal_seq < j.head) return `database head ${row.journal_seq} is behind the journal head ${j.head}`;
  if (row.journal_seq > j.head) return `database head ${row.journal_seq} is ahead of the journal head ${j.head}`;
  if (j.headHash === null) return 'journal head hash unknown (more voids than the remembered claims)';
  if (row.head_hash !== j.headHash) return 'head hash differs between database and journal';
  return null;
}
