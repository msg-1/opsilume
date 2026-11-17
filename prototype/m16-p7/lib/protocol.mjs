// P7 recorder protocol (test-only). Minimal and documented in README.md ("Recorder protocol"):
// - one random 256-bit key per run, created on the recorder host and copied to the test machine by the operator;
// - every request carries the run id, a millisecond timestamp, a random nonce and an HMAC-SHA256 over
//   method, path, run, timestamp, nonce and the SHA-256 of the body; the recorder rejects a bad MAC, a timestamp
//   outside the window, and a nonce it has already accepted;
// - every response is MACed over the request nonce, status, recorder time and body hash, so the test machine can't be
//   fed a forged acknowledgement or a forged view of a cycle;
// - acknowledgements additionally form one ordered stream per (process, worker) inside a recorder-issued cycle id.
// Integrity and authenticity only: the data is synthetic, so there is no encryption. Keys are never logged.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const WINDOW_MS = 300_000; // clocks are NTP-synchronised; a machine that just lost power may need a moment to sync
export const sha256 = (s) => createHash('sha256').update(s ?? '').digest('hex');
const hmac = (key, text) => createHmac('sha256', key).update(text).digest('hex');
const requestText = (p) => ['P7-REQ-1', p.method, p.path, p.run, p.ts, p.nonce, p.bodyHash].join('\n');
const responseText = (p) => ['P7-RES-1', p.nonce, p.status, p.time, p.bodyHash].join('\n');

export const newKeyHex = () => randomBytes(32).toString('hex');
export function keyFromHex(hex) {
  if (!/^[0-9a-f]{64}$/.test(String(hex).trim())) throw new Error('invalid key file');
  return Buffer.from(String(hex).trim(), 'hex');
}
export function equalHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !/^[0-9a-f]+$/.test(a) || !/^[0-9a-f]+$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function signRequest(key, { method, path, run, body = '', now = Date.now(), nonce = randomBytes(16).toString('hex') }) {
  const ts = String(now);
  return { 'x-p7-run': run, 'x-p7-ts': ts, 'x-p7-nonce': nonce, 'x-p7-mac': hmac(key, requestText({ method, path, run, ts, nonce, bodyHash: sha256(body) })) };
}

/** Returns null when authentic and fresh, or the reason. The MAC is checked first, so junk is always 'bad_mac'. */
export function verifyRequest(key, { method, path, run, headers, body = '', now = Date.now(), seen }) {
  const ts = headers['x-p7-ts'], nonce = headers['x-p7-nonce'];
  if (!/^\d{1,16}$/.test(ts ?? '') || !/^[0-9a-f]{32}$/.test(nonce ?? '')) return 'malformed_authentication';
  if (headers['x-p7-run'] !== run) return 'run_mismatch';
  if (!equalHex(headers['x-p7-mac'], hmac(key, requestText({ method, path, run, ts, nonce, bodyHash: sha256(body) })))) return 'bad_mac';
  if (Math.abs(now - Number(ts)) > WINDOW_MS) return 'stale_timestamp';
  if (seen?.has(nonce)) return 'replayed_nonce';
  return null;
}

export const signResponse = (key, { nonce, status, body, time }) => hmac(key, responseText({ nonce, status: String(status), time: String(time), bodyHash: sha256(body) }));
export function verifyResponse(key, { nonce, status, body, headers }) {
  const time = headers.get('x-p7-time');
  return /^\d{1,16}$/.test(time ?? '') && equalHex(headers.get('x-p7-mac') ?? '', signResponse(key, { nonce, status, body, time })) ? Number(time) : null;
}

/** The test machine's client. Throws on an unauthenticated response; never retries (the caller decides). */
export function makeClient({ baseUrl, key, run, timeoutMs = 10_000 }) {
  return async function call(method, path, payload) {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const headers = signRequest(key, { method, path, run, body });
    const sentAt = Date.now();
    const r = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body || undefined, signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    const receivedAt = Date.now();
    const serverTime = verifyResponse(key, { nonce: headers['x-p7-nonce'], status: r.status, body: text, headers: r.headers });
    if (serverTime === null) throw Object.assign(new Error(`recorder response to ${method} ${path} is not authenticated (status ${r.status})`), { status: r.status, unauthenticated: true });
    const data = text ? JSON.parse(text) : null;
    if (!r.ok) throw Object.assign(new Error(`recorder ${method} ${path}: ${r.status} ${data?.error ?? ''}`), { status: r.status, data });
    return { data, serverTime, clockOffsetMs: Math.round(serverTime - (sentAt + receivedAt) / 2), roundTripMs: receivedAt - sentAt };
  };
}

// ─────────────────────────────── acknowledgement streams (one per process and worker) ───────────────────────────────
export const actionPrefix = (cycle, proc, worker) => `c${String(cycle).padStart(4, '0')}${proc}w${worker}-`;
export const streamKey = (a) => `${a.proc}/${a.worker}`;

/**
 * The next state of one (process, worker) stream, or the reason the acknowledgement is refused. A worker sends, in
 * order: claim(seq) as n, dispatch(seq) as n+1, the next claim as n+2, ... with its own claims strictly increasing.
 */
export function nextStream(st, a, cycle) {
  const cur = st ?? { n: 0, lastClaimSeq: 0, pending: null };
  if (!Number.isInteger(a.n) || a.n < 1 || !Number.isInteger(a.seq) || a.seq < 1 || typeof a.actionId !== 'string') return { error: 'malformed' };
  if (a.n <= cur.n) return { error: 'duplicate_or_replayed' };
  if (a.n !== cur.n + 1) return { error: 'out_of_order' };
  if (!a.actionId.startsWith(actionPrefix(cycle, a.proc, a.worker))) return { error: 'action_does_not_belong_to_this_stream' };
  if (a.kind === 'claim') {
    if (cur.pending) return { error: 'out_of_order' }; // the previous claim's dispatch intent was never acknowledged
    if (a.seq <= cur.lastClaimSeq) return { error: 'out_of_order' };
    return { st: { n: a.n, lastClaimSeq: a.seq, pending: { seq: a.seq, actionId: a.actionId } } };
  }
  if (a.kind === 'dispatch') {
    if (!cur.pending || cur.pending.seq !== a.seq || cur.pending.actionId !== a.actionId) return { error: 'mismatched_dispatch' };
    return { st: { n: a.n, lastClaimSeq: cur.lastClaimSeq, pending: null } };
  }
  return { error: 'malformed' };
}
