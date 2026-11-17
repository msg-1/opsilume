// Durable, append-only and write-once files for the P7 harness (recorder and evidence). Pure Node, no dependencies.
import fs from 'node:fs';
import path from 'node:path';

export function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function fsyncFile(file) {
  const fd = fs.openSync(file, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** One JSON line, one write, byte count checked, fsync. Throws on a short write. */
export function appendDurable(file, obj) {
  const line = `${JSON.stringify(obj)}\n`;
  const isNew = !fs.existsSync(file);
  const fd = fs.openSync(file, 'a+', 0o644);
  try {
    // A ledger that ends in a fragment (a writer died mid-line) is never appended to: the new record would fuse with
    // the fragment into one unreadable line, and every later read of the ledger would fail. It is left as it is.
    const size = fs.fstatSync(fd).size;
    if (size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) throw Object.assign(new Error(`${path.basename(file)} ends in an incomplete line: nothing was appended. Stop and report; do not edit the ledger`), { code: 'LEDGER_TORN' });
    }
    const n = fs.writeSync(fd, line);
    if (n !== Buffer.byteLength(line)) throw new Error(`short write: ${n} of ${Buffer.byteLength(line)} bytes`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (isNew) fsyncDir(path.dirname(file)); // a new ledger's directory entry is made durable too
}

/** Creates a file that must not exist yet (evidence is never overwritten), fsyncs it and its directory. */
export function writeOnce(file, data, mode = 0o644) {
  const text = typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`;
  const fd = fs.openSync(file, 'wx', mode);
  try {
    if (fs.writeSync(fd, text) !== Buffer.byteLength(text)) throw new Error(`short write to ${file}`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDir(path.dirname(file));
}

/**
 * Reads a JSON-lines ledger. A final line without its newline (the process died mid-write) is reported as
 * `tornBytes` and ignored; an unreadable complete line is an error, never skipped.
 */
export function readLedger(file) {
  if (!fs.existsSync(file)) return { entries: [], tornBytes: 0 };
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const tail = lines.pop();
  const entries = lines.map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      throw new Error(`${path.basename(file)} line ${i + 1} is not a record`);
    }
  });
  return { entries, tornBytes: Buffer.byteLength(tail) };
}
