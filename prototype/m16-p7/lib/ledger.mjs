// Durable, append-only and write-once files for the P7 harness (recorder and evidence). Pure Node, no dependencies.
import fs from 'node:fs';
import path from 'node:path';

export function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** One JSON line, one write, byte count checked, fsync. Throws on a short write. */
export function appendDurable(file, obj) {
  const line = `${JSON.stringify(obj)}\n`;
  const fd = fs.openSync(file, 'a', 0o644);
  try {
    const n = fs.writeSync(fd, line);
    if (n !== Buffer.byteLength(line)) throw new Error(`short write: ${n} of ${Buffer.byteLength(line)} bytes`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Creates a file that must not exist yet (evidence is never overwritten), fsyncs it and its directory. */
export function writeOnce(file, data) {
  const text = typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`;
  const fd = fs.openSync(file, 'wx', 0o644);
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
