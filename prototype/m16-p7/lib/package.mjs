// Reads a source package (the .tar.gz that `git archive` makes) without extracting it anywhere: its SHA-256, the
// commit id git embedded in it, and the content of every file. The recorder uses it at create-run to check what the
// operator declares, instead of taking the commit and the checksum on their word (lib/source.mjs, README).
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

const text = (b) => { const z = b.indexOf(0); return b.subarray(0, z < 0 ? b.length : z).toString('utf8'); };
/** pax records: "<length> <key>=<value>\n", repeated. */
function pax(b) {
  const out = {};
  for (let i = 0; i < b.length;) {
    const sp = b.indexOf(0x20, i);
    const len = Number(b.subarray(i, sp).toString());
    if (sp < 0 || !Number.isInteger(len) || len <= 0) break;
    const rec = b.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * Returns { sha256, bytes, commit, prefix, files }: `commit` is the id in the archive's global header (null when the
 * archive was not made by `git archive` from a commit), `files` maps each path below the single top-level directory
 * to its content. Throws on anything that is not a plain archive of regular files under one top-level directory.
 */
export function readPackage(file) {
  const gz = fs.readFileSync(file);
  if (gz.length > 64 * 1024 * 1024) throw new Error('package: larger than 64 MiB; this is not a source package');
  const tar = zlib.gunzipSync(gz, { maxOutputLength: 512 * 1024 * 1024 }); // bounded: a crafted archive can't exhaust memory
  const files = new Map();
  let commit = null, longName = null, prefix = null;
  for (let off = 0; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = parseInt(text(h.subarray(124, 136)).trim() || '0', 8);
    if (!Number.isInteger(size) || size < 0) throw new Error('package: unreadable entry size');
    const type = String.fromCharCode(h[156] || 0x30);
    const data = tar.subarray(off + 512, off + 512 + size);
    if (data.length !== size) throw new Error('package: truncated archive');
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'g') { commit = pax(data).comment ?? commit; continue; }
    if (type === 'x') { longName = pax(data).path ?? null; continue; }
    const name = longName ?? [text(h.subarray(345, 500)), text(h.subarray(0, 100))].filter(Boolean).join('/');
    longName = null;
    if (type === '5') continue; // a directory
    if (type !== '0') throw new Error(`package: entry ${name} is not a regular file (type ${type})`);
    const parts = name.split('/');
    if (parts.length < 2 || parts.some((p) => p === '' || p === '.' || p === '..')) throw new Error(`package: unexpected path ${name}`);
    if (prefix !== null && parts[0] !== prefix) throw new Error('package: more than one top-level directory');
    prefix = parts[0];
    const rel = parts.slice(1).join('/');
    if (files.has(rel)) throw new Error(`package: ${rel} appears twice`);
    files.set(rel, Buffer.from(data));
  }
  if (!files.size) throw new Error('package: no files');
  return { sha256: createHash('sha256').update(gz).digest('hex'), bytes: gz.length, commit: /^[0-9a-f]{40}$/.test(commit ?? '') ? commit : null, prefix, files };
}
