// Streams a journal once, in bounded memory, using the Phase 0.5 verifier (unchanged), and returns what the P7
// comparison needs: the trust state, an order-independent fingerprint of every effective claim (full history), and
// the claims and dispatch-intent records after `windowFrom` (this cycle). Pure: no database, no Prisma.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { freshState, headHash, serialize, sha, verifyRange } from '../../m16-phase05/lib/journal.mjs';

const MOD = 1n << 64n;
const STACK = 64; // the same depth as the Phase 0.5 verifier: more consecutive voids than this can't be followed

/** Fingerprint of one committed claim. Summed mod 2^64, so the order rows are read in doesn't matter. */
export const fp = (seq, actionId) => BigInt(`0x${sha(`${seq}|${actionId}`).slice(0, 16)}`);
export const addFp = (a, b) => (a + b) % MOD;
export const subFp = (a, b) => (((a - b) % MOD) + MOD) % MOD;
export const hex = (n) => n.toString(16).padStart(16, '0');

export function sha256File(file) {
  const h = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(4 << 20);
  try {
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

export function scanJournal(file, { windowFrom = 0 } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (e) {
    if (e.code === 'ENOENT') return { status: 'missing' };
    throw e;
  }
  const claims = new Map(); // seq > windowFrom -> { actionId, hash, dispatched }
  const dispatches = new Set();
  const stack = [];
  const types = {};
  let count = 0;
  let sum = 0n;
  let fingerprintKnown = true;
  let size;
  let r;
  try {
    size = fs.fstatSync(fd).size;
    r = verifyRange(fd, 0, size, freshState(), (e) => {
      types[e.type] = (types[e.type] ?? 0) + 1;
      if (e.type === 'claim') {
        stack.push({ seq: e.seq, actionId: e.actionId });
        if (stack.length > STACK) stack.shift();
        count += 1;
        sum = addFp(sum, fp(e.seq, e.actionId));
        if (e.seq > windowFrom) claims.set(e.seq, { actionId: e.actionId, hash: e.hash, dispatched: false });
      } else if (e.type === 'void') {
        const c = stack.pop();
        if (!c || c.seq !== e.seq) fingerprintKnown = false;
        else {
          count -= 1;
          sum = subFp(sum, fp(c.seq, c.actionId));
        }
        claims.delete(e.seq);
      } else if (e.type === 'dispatch' && e.seq > windowFrom) {
        dispatches.add(e.seq);
        const c = claims.get(e.seq);
        if (c) c.dispatched = true;
      }
    });
  } finally {
    fs.closeSync(fd);
  }
  const base = { fileBytes: size, verifiedBytes: r.verified, head: r.st.head, records: r.st.records, types };
  if (r.status === 'corrupt') {
    // N1 calls a damaged FINAL line "torn"; the Phase 0.5 verifier reports a complete final line that fails its hash
    // as corrupt. Record whether that is the case, so the evidence shows it (it is still a failure here).
    const rest = fs.readFileSync(file).subarray(r.verified);
    const nl = rest.indexOf(10);
    return { ...base, status: 'corrupt', problem: r.problem, corruptAtByte: r.verified, corruptIsFinalLine: nl === rest.length - 1 };
  }
  return {
    ...base,
    status: r.status === 'torn_tail' ? 'torn_tail' : 'ok',
    tornBytes: r.tornBytes ?? 0,
    headHash: headHash(r.st),
    lastHash: r.st.prev,
    count,
    fingerprint: hex(sum),
    fingerprintKnown,
    claims,
    dispatches,
  };
}

/**
 * The bytes that repair a torn final line under N1: '#' and a newline end the fragment as a line that can never parse
 * as a record (even when the fragment is a complete record missing only its newline, so nothing is resurrected), and
 * a `repair` record names that line's length. Appended once, under the state-row lock, by `p7.mjs recover`.
 */
export function repairBytes(tornBytes, lastHash, at = new Date().toISOString()) {
  return `#\n${serialize({ type: 'repair', ignoredBytes: tornBytes + 1, reason: 'P7: torn final line (N1)', at }, lastHash)}`;
}
