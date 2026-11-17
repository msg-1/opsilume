// A minimal tar.gz writer for tests: regular files under one top-level directory, with the pax global header that
// `git archive` writes for a commit. Nothing outside the tests uses it.
import zlib from 'node:zlib';

function header(name, size, type) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0' + '00', 257);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}
const padded = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
const paxRecord = (k, v) => { const body = ` ${k}=${v}\n`; let len = body.length + 1; while (String(len).length + body.length !== len) len = String(len).length + body.length; return Buffer.from(`${len}${body}`); };

/** entries: [path, content][]. commit: written as the archive's global `comment`, as git does (omit for none). */
export function tarGz(entries, { commit, prefix = 'opspilot-p7-test' } = {}) {
  const parts = [];
  if (commit) { const g = paxRecord('comment', commit); parts.push(header('pax_global_header', g.length, 'g'), padded(g)); }
  for (const [name, content] of entries) {
    const data = Buffer.from(content);
    const full = prefix === null ? name : `${prefix}/${name}`;
    if (Buffer.byteLength(full) > 100) { const x = paxRecord('path', full); parts.push(header('PaxHeader', x.length, 'x'), padded(x)); }
    parts.push(header(full.slice(0, 100), data.length, '0'), padded(data));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}
