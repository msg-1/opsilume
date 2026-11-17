// Identity of the harness source, by content: one digest over every file the harness executes on either host. The test
// machine reports it (from the read-only mount of the source package) and the recorder compares it with its own copy,
// so a qualifying cycle runs only while both sides hold exactly the same code. Tests and documents are not part of it.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Directories under the `prototype` root (not recursive) and the files in them that count. */
export const SOURCE_SETS = [['m16-p7', /\.(mjs|yml|sh)$/], ['m16-p7/lib', /\.mjs$/], ['m16-p7/firewall', /\.sh$/], ['m16-phase05/lib', /\.mjs$/]];
const sha = (b) => createHash('sha256').update(b).digest('hex');
const digestOf = (entries) => { const lines = entries.map(([name, content]) => `${name}\0${sha(content)}`); return { sha256: sha(lines.join('\n')), files: lines.length }; };

/** From a directory: `protoRoot` is the `prototype` directory. */
export function sourceDigest(protoRoot) {
  const entries = [];
  for (const [dir, pattern] of SOURCE_SETS) {
    const d = path.join(protoRoot, dir);
    for (const name of fs.readdirSync(d).filter((n) => pattern.test(n) && fs.statSync(path.join(d, n)).isFile()).sort()) entries.push([`${dir}/${name}`, fs.readFileSync(path.join(d, name))]);
  }
  return digestOf(entries);
}
/** The same digest from a package's files (a Map of path -> content, paths starting at the repository root). */
export function sourceDigestOfFiles(files) {
  const entries = [];
  for (const [dir, pattern] of SOURCE_SETS) {
    const at = `prototype/${dir}/`;
    for (const name of [...files.keys()].filter((f) => f.startsWith(at) && !f.slice(at.length).includes('/') && pattern.test(f.slice(at.length))).sort()) entries.push([`${dir}/${name.slice(at.length)}`, files.get(name)]);
  }
  return digestOf(entries);
}

/**
 * A fingerprint of the runtime the harness was started in: the given files' contents (the Node binary, the installed
 * dependency lock, the API package manifest). It is what a container can say about its own image. It is NOT the image
 * id: nothing inside a container can read that. A file that can't be read is recorded as such, never skipped.
 */
export function runtimeFingerprint(paths) {
  return sha(paths.map((p) => { try { return `${p}\0${sha(fs.readFileSync(p))}`; } catch { return `${p}\0unreadable`; } }).join('\n'));
}
