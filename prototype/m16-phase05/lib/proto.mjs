// Phase 0.5 prototype of the revised lifecycle (design §6, §6.1-6.4, §9.1). Its own schema in its own database.
// NOT production code. The application's schema, routes and remediation logic are untouched.
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import { Journal, freshState, headHash, sha, trustProblem, verifyRange } from './journal.mjs';

const { PrismaClient } = createRequire('/app/apps/api/package.json')('@prisma/client');
export const db = (url = process.env.PROTO_DATABASE_URL) => new PrismaClient({ datasourceUrl: url });
export const direct = () => db(process.env.PROTO_DIRECT_URL ?? process.env.PROTO_DATABASE_URL); // bypasses the fault proxy
export const journalAt = (dir = process.env.PROTO_STATE_DIR ?? '/state') => new Journal(dir);
export const now = () => Number(process.hrtime.bigint()) / 1e6;

export const SCHEMA = [
  'DROP TABLE IF EXISTS audit, approval, action, org, installation_state CASCADE',
  'DROP FUNCTION IF EXISTS require_journal_claim CASCADE',
  'CREATE TABLE org (id text PRIMARY KEY)',
  "CREATE TABLE action (id text PRIMARY KEY, org_id text NOT NULL REFERENCES org, status text NOT NULL, attempts int NOT NULL DEFAULT 0, outcome text, note text, updated_at timestamptz NOT NULL DEFAULT now())",
  'CREATE INDEX ON action (status)',
  'CREATE TABLE approval (id bigserial PRIMARY KEY, action_id text NOT NULL REFERENCES action ON DELETE CASCADE, superseded_at timestamptz)',
  'CREATE INDEX ON approval (action_id)',
  // DEFERRABLE so that a violation can be made to surface only at COMMIT (P5 scenario: rolled back at commit).
  'CREATE TABLE audit (id bigserial PRIMARY KEY, org_id text NOT NULL REFERENCES org DEFERRABLE INITIALLY DEFERRED, action text NOT NULL, ref text, meta jsonb, at timestamptz NOT NULL DEFAULT clock_timestamp())',
  // Created EMPTY. head_hash anchors the journal record at journal_seq (P4).
  'CREATE TABLE installation_state (id int PRIMARY KEY CHECK (id = 1), installation_id text, journal_seq int NOT NULL DEFAULT 0, head_hash text)',
];
/** The downgrade guard proposed in the Phase 0.5 report: a database trigger that refuses a claim not made through the journal protocol. */
export const GUARD = [
  `CREATE FUNCTION require_journal_claim() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NEW.status = 'EXECUTING' AND OLD.status IS DISTINCT FROM 'EXECUTING' THEN
       IF coalesce(current_setting('opsilume.claim_seq', true), '') IS DISTINCT FROM (SELECT journal_seq::text FROM installation_state WHERE id = 1) THEN
         RAISE EXCEPTION 'remediation claim without a journal record: refused (is an older application running?)' USING ERRCODE = 'P0001';
       END IF;
     END IF;
     RETURN NEW;
   END $$`,
  'CREATE TRIGGER require_journal_claim BEFORE UPDATE OF status ON action FOR EACH ROW EXECUTE FUNCTION require_journal_claim()',
];
export async function resetSchema(p, { guard = false } = {}) {
  for (const s of SCHEMA) await p.$executeRawUnsafe(s);
  if (guard) for (const s of GUARD) await p.$executeRawUnsafe(s);
}
export async function init(p, j) {
  return p.$transaction(async (tx) => {
    const [{ n }] = await tx.$queryRaw`SELECT (SELECT count(*) FROM org) + (SELECT count(*) FROM installation_state) AS n`;
    if (Number(n)) throw new Error('init refused: not an empty database');
    const id = j.create();
    await tx.$executeRaw`INSERT INTO installation_state (id, installation_id, journal_seq, head_hash) VALUES (1, ${id}, 0, ${'0'.repeat(64)})`;
    return id;
  });
}
const lockState = (tx) => tx.$queryRaw`SELECT installation_id, journal_seq, head_hash FROM installation_state WHERE id = 1 FOR UPDATE`;
export const appendLocked = (p, j, entry) => p.$transaction(async (tx) => { await lockState(tx); return j.append(entry); });
export function crashpoint(at, opts) {
  if (opts?.crashAt === at) process.kill(process.pid, 'SIGKILL');
}

/**
 * The claim (design §6): state lock first (N5); incremental trust check (P4); action lock; SAVEPOINT; claim record
 * (bytes checked, P2); database writes incl. head hash and the downgrade-guard setting; on a failed write roll back to
 * the savepoint and append void under the lock (P1). A failure at COMMIT is reported as `uncertain` (P5), never as failed.
 */
export async function claim(p, j, actionId, opts = {}) {
  const t0 = now();
  const timing = {};
  let appended = null;
  let callbackDone = false;
  try {
    const r = await p.$transaction(
      async (tx) => {
        const tl = now();
        const [row] = await lockState(tx);
        timing.lockWait = now() - tl;
        const tv = now();
        const js = j.state();
        timing.verify = now() - tv;
        timing.verifyMode = js.mode;
        const problem = trustProblem(row, js);
        if (problem) return { claimed: false, reason: 'quarantined', problem };
        const [a] = await tx.$queryRaw`SELECT status, attempts, org_id FROM action WHERE id = ${actionId} FOR UPDATE`;
        if (!a || a.status !== 'APPROVED') return { claimed: false, reason: 'moved_on' };
        const seq = row.journal_seq + 1;
        await tx.$executeRawUnsafe('SAVEPOINT claim_writes');
        const hash = j.append({ type: 'claim', seq, actionId, org: a.org_id, attempt: a.attempts + 1, at: new Date().toISOString() });
        appended = { seq, hash, actionId, attempt: a.attempts + 1, org: a.org_id };
        crashpoint('after_claim_append', opts);
        try {
          await tx.$executeRaw`UPDATE installation_state SET journal_seq = ${seq}, head_hash = ${hash} WHERE id = 1`;
          await tx.$queryRaw`SELECT set_config('opsilume.claim_seq', ${String(seq)}, true)`;
          await tx.$executeRaw`UPDATE action SET status = 'EXECUTING', attempts = attempts + 1, updated_at = now() WHERE id = ${actionId}`;
          const org = opts.deferredAuditFailure ? 'no-such-organisation' : a.org_id; // deferred FK: fails only at COMMIT
          await tx.$executeRaw`INSERT INTO audit (org_id, action, ref, meta) VALUES (${org}, 'execute_start', ${actionId}, ${JSON.stringify({ seq })}::jsonb)`;
        } catch (err) {
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT claim_writes');
          j.append({ type: 'void', seq, at: new Date().toISOString() });
          appended = null;
          throw err;
        }
        callbackDone = true;
        return { claimed: true, ...appended };
      },
      { timeout: 60_000, maxWait: 60_000 },
    );
    return { ...r, timing: { ...timing, total: now() - t0 } };
  } catch (err) {
    // The callback finished and the claim record is on disk, but COMMIT didn't confirm: the result is unknown (P5).
    if (callbackDone && appended) return { claimed: false, reason: 'uncertain', uncertain: appended, error: String(err.message).split('\n').filter(Boolean).at(-1).slice(0, 160), timing: { ...timing, total: now() - t0 } };
    throw err;
  }
}

/**
 * P5 resolution (design §6.3): lock the state row and read it. Committed: leave the action EXECUTING, undispatched.
 * Not committed and nothing else moved: void under the lock. Anything else, or the database unreachable: do nothing.
 */
export async function resolveUncertain(p, j, u) {
  try {
    return await p.$transaction(async (tx) => {
      const [row] = await lockState(tx);
      const [a] = await tx.$queryRaw`SELECT status, attempts FROM action WHERE id = ${u.actionId}`;
      const js = j.state();
      if (row.journal_seq === u.seq && row.head_hash === u.hash && a.status === 'EXECUTING' && a.attempts === u.attempt) return { resolved: 'committed', action: 'left EXECUTING, not dispatched' };
      if (row.journal_seq === u.seq - 1 && js.head === u.seq && js.headHash === u.hash && a.status === 'APPROVED' && a.attempts === u.attempt - 1) {
        j.append({ type: 'void', seq: u.seq, at: new Date().toISOString() });
        return { resolved: 'not committed', action: 'voided under the lock' };
      }
      return { resolved: 'unclear', action: 'left for the comparison and a person' };
    }, { timeout: 15_000, maxWait: 5_000 });
  } catch (e) {
    return { resolved: 'unreachable', action: 'nothing changed', error: String(e.message).split('\n').filter(Boolean).at(-1).slice(0, 120) };
  }
}

/** An application from before this feature: no journal, no state row, just the status claim and the dispatch. */
export async function legacyClaim(p, actionId) {
  return p.$transaction(async (tx) => {
    const [a] = await tx.$queryRaw`SELECT status, org_id FROM action WHERE id = ${actionId} FOR UPDATE`;
    if (a?.status !== 'APPROVED') return { claimed: false, reason: 'moved_on' };
    await tx.$executeRaw`UPDATE action SET status = 'EXECUTING', attempts = attempts + 1 WHERE id = ${actionId}`;
    await tx.$executeRaw`INSERT INTO audit (org_id, action, ref) VALUES (${a.org_id}, 'execute_start', ${actionId})`;
    return { claimed: true };
  });
}

export function send(url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

/** Claim, then only if it certainly committed: dispatch record, request. An uncertain claim is never dispatched. */
export async function execute(p, j, actionId, url, opts = {}) {
  const c = await claim(p, j, actionId, opts);
  if (!c.claimed) return c;
  await appendLocked(p, j, { type: 'dispatch', seq: c.seq, at: new Date().toISOString() });
  const status = await send(url, { actionId, seq: c.seq });
  return { ...c, receiverStatus: status };
}

export const sweep = (p) => p.$executeRaw`UPDATE action SET status = 'FAILED', outcome = 'unknown', note = 'interrupted: outcome unknown' WHERE status = 'EXECUTING'`;

// ───────────────────────── Bounded-memory inspection and clearance (P6, design §9.1) ─────────────────────────

/** Streams the journal once: trust state plus the claims after `dbHead` (with dispatch/outcome/reconciled flags). Memory grows with those claims only. */
export function journalAfter(j, dbHead) {
  const after = new Map();
  const fd = fs.openSync(j.file, 'r');
  let r;
  try {
    r = verifyRange(fd, 0, fs.fstatSync(fd).size, freshState(), (e) => {
      if (!(e.seq > dbHead)) return;
      if (e.type === 'claim') after.set(e.seq, { actionId: e.actionId, org: e.org, dispatched: false, outcome: null, reconciled: null });
      else if (e.type === 'void') after.delete(e.seq);
      else if (after.has(e.seq)) {
        const c = after.get(e.seq);
        if (e.type === 'dispatch') c.dispatched = true;
        if (e.type === 'outcome') c.outcome = e.outcome;
        if (e.type === 'reconciled') c.reconciled = e.outcome;
      }
    });
  } finally {
    fs.closeSync(fd);
  }
  const status = r.status === 'corrupt' ? 'corrupt' : r.status === 'torn_tail' ? 'torn_tail' : r.st.records ? 'ok' : 'empty';
  return { st: { status, problem: r.problem, head: r.st.head, headHash: headHash(r.st), lastHash: r.st.prev }, after };
}

const AFFECTED = `a.status IN ('APPROVED', 'PENDING_APPROVAL', 'EXECUTING') OR (a.status = 'FAILED' AND a.outcome IN ('unknown', 'not_applied')) OR a.id IN (SELECT action_id FROM after_claims)`;

/** Loads the post-head claims into a temporary table in chunks, so the database, not the process, holds them. */
async function stageAfter(q, after) {
  await q.$executeRawUnsafe('CREATE TEMP TABLE IF NOT EXISTS after_claims (seq int, action_id text, note text) ON COMMIT DROP');
  await q.$executeRawUnsafe('TRUNCATE after_claims');
  const rows = [...after.entries()];
  for (let i = 0; i < rows.length; i += 5000) {
    const part = rows.slice(i, i + 5000);
    await q.$executeRaw`INSERT INTO after_claims SELECT * FROM unnest(${part.map((r) => r[0])}::int[], ${part.map((r) => r[1].actionId)}::text[], ${part.map((r) => (r[1].dispatched ? 'may have been sent: check the target system' : 'not sent (no dispatch record)'))}::text[])`;
  }
}

/** The inspection digest, computed by the database over the affected rows (no rows are loaded into the process). */
async function dbDigest(q) {
  const [r] = await q.$queryRawUnsafe(`
    WITH ap AS (SELECT action_id, count(*) AS c FROM approval WHERE superseded_at IS NULL GROUP BY action_id)
    SELECT encode(sha256(convert_to(coalesce(string_agg(a.id || '|' || a.status || '|' || a.attempts || '|' || coalesce(a.outcome, '') || '|' || coalesce(ap.c, 0), ',' ORDER BY a.id), ''), 'UTF8')), 'hex') AS d, count(*)::int AS n
    FROM action a LEFT JOIN ap ON ap.action_id = a.id WHERE ${AFFECTED}`);
  return r;
}

/** Inspection inside one transaction (the temp table needs it). Returns the digest and counts, not the rows. */
export async function inspect(p, j) {
  return p.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw`SELECT installation_id, journal_seq, head_hash FROM installation_state WHERE id = 1`;
    const dbHead = row?.journal_seq ?? 0;
    const { st, after } = journalAfter(j, dbHead);
    await stageAfter(tx, after);
    const d = await dbDigest(tx);
    const afterKey = sha(JSON.stringify([...after.entries()].map(([s, c]) => [s, c.actionId, c.dispatched, c.outcome, c.reconciled])));
    const digest = sha(JSON.stringify({ row: [row?.installation_id ?? null, dbHead, row?.head_hash ?? null], journal: [j.identity(), st.status, st.head, st.lastHash], db: d.d, afterKey }));
    return { digest, affected: d.n, after: after.size, dbHead, journalHead: st.head, journalStatus: st.status, problem: trustProblem(row, { installationId: j.identity(), ...st }) };
  }, { timeout: 600_000, maxWait: 60_000 });
}

/** Clearance as ONE transaction, set-based, bounded in process memory (P6). `onBackend` receives the transaction's backend pid. */
export async function clear(p, j, { digest, reason, crashAt, onBackend } = {}) {
  const t0 = now();
  const out = await p.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO installation_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
    const [row] = await lockState(tx);
    if (onBackend) await onBackend((await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid);
    const dbHead = row.journal_seq;
    const { st, after } = journalAfter(j, dbHead);
    await stageAfter(tx, after);
    const d = await dbDigest(tx);
    const afterKey = sha(JSON.stringify([...after.entries()].map(([s, c]) => [s, c.actionId, c.dispatched, c.outcome, c.reconciled])));
    const now2 = sha(JSON.stringify({ row: [row.installation_id ?? null, dbHead, row.head_hash ?? null], journal: [j.identity(), st.status, st.head, st.lastHash], db: d.d, afterKey }));
    if (now2 !== digest) return { cleared: false, reason: 'the state changed since inspection' };
    if (st.status === 'corrupt' || st.status === 'missing') return { cleared: false, reason: `journal ${st.status}` };
    const superseded = await tx.$executeRawUnsafe(`UPDATE approval p SET superseded_at = now() FROM action a WHERE p.action_id = a.id AND p.superseded_at IS NULL AND a.status IN ('APPROVED', 'PENDING_APPROVAL')`);
    const toProposed = await tx.$executeRawUnsafe(`UPDATE action SET status = 'PROPOSED' WHERE status IN ('APPROVED', 'PENDING_APPROVAL') AND id NOT IN (SELECT action_id FROM after_claims)`);
    const toUnknown = await tx.$executeRawUnsafe(`UPDATE action a SET status = 'FAILED', outcome = 'unknown', note = 'journal: ' || t.note FROM (SELECT DISTINCT ON (action_id) action_id, note FROM after_claims ORDER BY action_id, seq DESC) t WHERE a.id = t.action_id`);
    const executing = await tx.$executeRawUnsafe(`UPDATE action SET status = 'FAILED', outcome = 'unknown', note = 'executing at restore' WHERE status = 'EXECUTING'`);
    const [{ unmatched }] = await tx.$queryRawUnsafe(`SELECT count(*)::int AS unmatched FROM after_claims t WHERE NOT EXISTS (SELECT 1 FROM action a WHERE a.id = t.action_id)`);
    const audits = await tx.$executeRaw`INSERT INTO audit (org_id, action, meta) SELECT id, 'recovery_cleared', ${JSON.stringify({ digest, reason, unmatched })}::jsonb FROM org`;
    const hash = j.append({ type: 'cleared', digest, reason, at: new Date().toISOString() });
    crashpoint('after_cleared_record', { crashAt });
    await tx.$executeRaw`UPDATE installation_state SET installation_id = ${j.identity()}, journal_seq = ${st.head}, head_hash = ${st.headHash} WHERE id = 1`;
    return { cleared: true, superseded, toProposed, toUnknown, executing, audits, unmatched, clearedRecord: hash.slice(0, 12) };
  }, { timeout: 1_800_000, maxWait: 600_000 });
  return { ...out, ms: now() - t0 };
}
