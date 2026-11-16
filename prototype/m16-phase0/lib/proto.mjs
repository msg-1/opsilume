// Phase 0 prototype: a stand-in for the remediation lifecycle around the journal. Its own tiny schema in its
// own database; it shares nothing with the application's schema, routes or remediation logic.
import { createRequire } from 'node:module';
import http from 'node:http';
import { Journal, sha, trustProblem } from './journal.mjs';

const { PrismaClient } = createRequire('/app/apps/api/package.json')('@prisma/client');
export const db = (url = process.env.PROTO_DATABASE_URL) => new PrismaClient({ datasourceUrl: url });
export const journalAt = (dir = process.env.PROTO_STATE_DIR ?? '/state', opts) => new Journal(dir, opts);
export const now = () => Number(process.hrtime.bigint()) / 1e6; // ms

export const SCHEMA = [
  'DROP TABLE IF EXISTS audit, approval, action, org, installation_state CASCADE',
  'CREATE TABLE org (id text PRIMARY KEY)',
  "CREATE TABLE action (id text PRIMARY KEY, org_id text NOT NULL REFERENCES org, status text NOT NULL, attempts int NOT NULL DEFAULT 0, outcome text, note text, updated_at timestamptz NOT NULL DEFAULT now())",
  'CREATE TABLE approval (id bigserial PRIMARY KEY, action_id text NOT NULL REFERENCES action ON DELETE CASCADE, superseded_at timestamptz)',
  'CREATE INDEX ON approval (action_id)',
  'CREATE TABLE audit (id bigserial PRIMARY KEY, org_id text NOT NULL REFERENCES org, action text NOT NULL, ref text, meta jsonb, at timestamptz NOT NULL DEFAULT clock_timestamp())',
  // Created EMPTY: no row means untrusted (design §4F, §6).
  'CREATE TABLE installation_state (id int PRIMARY KEY CHECK (id = 1), installation_id text, journal_seq int NOT NULL DEFAULT 0)',
];
export async function resetSchema(p) {
  for (const stmt of SCHEMA) await p.$executeRawUnsafe(stmt);
}

/** `recovery init` (design §7, D9): only on an empty database and an empty state directory, row created in the same transaction as the check. */
export async function init(p, j) {
  return p.$transaction(async (tx) => {
    const [{ n }] = await tx.$queryRaw`SELECT count(*)::int AS n FROM org`;
    const [{ s }] = await tx.$queryRaw`SELECT count(*)::int AS s FROM installation_state`;
    if (n || s) throw new Error('init refused: the database already holds organisations or an installation state');
    const id = j.create();
    await tx.$executeRaw`INSERT INTO installation_state (id, installation_id, journal_seq) VALUES (1, ${id}, 0)`;
    return id;
  });
}

const lockState = (tx) => tx.$queryRaw`SELECT installation_id, journal_seq FROM installation_state WHERE id = 1 FOR UPDATE`;

/** Appends a non-claim record under the same mutex as claims (the state row lock). */
export const appendLocked = (p, j, entry) =>
  p.$transaction(async (tx) => {
    await lockState(tx);
    j.append(entry);
  });

/** Kills this process on the spot when `at` is the configured crash point: no cleanup, sockets closed by the kernel. */
export function crashpoint(at, opts) {
  if (opts?.crashAt !== at) return;
  // Optionally hold everything (locks included) for a while first, so a concurrent process can be shown waiting.
  if (opts.pauseMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, opts.pauseMs);
  process.kill(process.pid, 'SIGKILL');
}

/**
 * The execution claim (design §6): InstallationState locked FIRST (N5); trust compared; action locked; the claim
 * record appended and flushed while the transaction is open; then the database writes. If a database write
 * fails, the transaction is rolled back to a savepoint and `void` is appended while the lock is still held
 * (a plain failed statement would already have released it), then the error is rethrown.
 */
export async function claim(p, j, actionId, opts = {}) {
  const t0 = now();
  let lockWait = 0;
  const result = await p.$transaction(
    async (tx) => {
      const tl = now();
      const [row] = await lockState(tx);
      lockWait = now() - tl;
      const problem = trustProblem(row, j.state());
      if (problem) {
        await tx.$executeRaw`INSERT INTO audit (org_id, action, ref, meta) SELECT org_id, 'claim_refused', id, ${JSON.stringify({ problem })}::jsonb FROM action WHERE id = ${actionId}`;
        return { claimed: false, reason: 'quarantined', problem };
      }
      const [a] = await tx.$queryRaw`SELECT status, attempts, org_id FROM action WHERE id = ${actionId} FOR UPDATE`;
      if (!a || a.status !== 'APPROVED') return { claimed: false, reason: 'moved_on' };
      const seq = row.journal_seq + 1;
      // PostgreSQL aborts the whole transaction, and releases its locks, at the first failed statement. A
      // savepoint keeps the locks taken before it, so the void below is appended while the lock is still held.
      await tx.$executeRawUnsafe('SAVEPOINT claim_writes');
      j.append({ type: 'claim', seq, actionId, org: a.org_id, attempt: a.attempts + 1, at: new Date().toISOString() });
      crashpoint('after_claim_append', opts);
      try {
        await tx.$executeRaw`UPDATE action SET status = 'EXECUTING', attempts = attempts + 1, updated_at = now() WHERE id = ${actionId}`;
        await tx.$executeRaw`UPDATE installation_state SET journal_seq = ${seq} WHERE id = 1`;
        // Injected failure: an audit row for an organisation that doesn't exist violates its foreign key.
        const org = opts.failAudit ? 'no-such-organisation' : a.org_id;
        await tx.$executeRaw`INSERT INTO audit (org_id, action, ref, meta) VALUES (${org}, 'execute_start', ${actionId}, ${JSON.stringify({ seq })}::jsonb)`;
      } catch (err) {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT claim_writes');
        j.append({ type: 'void', seq, at: new Date().toISOString() });
        throw err; // the whole transaction still rolls back: nothing commits after an error
      }
      return { claimed: true, seq, org: a.org_id, attempt: a.attempts + 1 };
    },
    { timeout: 60_000, maxWait: 60_000 },
  );
  return { ...result, lockWait, latency: now() - t0 };
}

/** POST to the local stand-in receiver. Crash points: after the request is fully sent, and after the response arrives. */
function send(url, body, opts) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-delay-ms': String(opts.receiverDelayMs ?? 0) } }, (res) => {
      res.resume();
      res.on('end', () => {
        crashpoint('after_response', opts);
        resolve(res.statusCode);
      });
    });
    req.on('error', reject);
    req.on('finish', () => crashpoint('after_send', opts));
    req.end(JSON.stringify(body));
  });
}

/** Claim → dispatch record → send → outcome, with a crash point at every boundary (experiment D). */
export async function execute(p, j, actionId, receiverUrl, opts = {}) {
  crashpoint('before_claim', opts);
  const c = await claim(p, j, actionId, opts);
  if (!c.claimed) return c;
  crashpoint('after_commit', opts);
  await appendLocked(p, j, { type: 'dispatch', seq: c.seq, at: new Date().toISOString() });
  crashpoint('after_dispatch_record', opts);
  let outcome;
  try {
    const status = await send(receiverUrl, { actionId, seq: c.seq, attempt: c.attempt }, opts);
    outcome = status >= 200 && status < 300 ? 'applied' : status >= 400 && status < 500 ? 'not_applied' : 'unknown';
  } catch {
    outcome = 'unknown';
  }
  await recordOutcome(p, j, actionId, c, outcome, opts);
  return { ...c, outcome };
}

/** Design order: the outcome commits in the database first (with its audit row), then the outcome record is appended. `journalFirst` is the reverse order, for scenario 6. */
export async function recordOutcome(p, j, actionId, c, outcome, opts = {}) {
  const writeDb = () =>
    p.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE action SET status = ${outcome === 'applied' ? 'EXECUTED' : 'FAILED'}, outcome = ${outcome}, updated_at = now() WHERE id = ${actionId} AND status = 'EXECUTING' AND attempts = ${c.attempt}`;
      if (opts.failOutcomeDb) throw new Error('injected: outcome transaction failed');
      await tx.$executeRaw`INSERT INTO audit (org_id, action, ref, meta) VALUES (${c.org}, 'execute_outcome', ${actionId}, ${JSON.stringify({ outcome })}::jsonb)`;
    });
  const writeJournal = () => appendLocked(p, j, { type: 'outcome', seq: c.seq, outcome, at: new Date().toISOString() });
  if (opts.journalFirst) {
    await writeJournal();
    await writeDb();
  } else {
    await writeDb();
    crashpoint('after_outcome_db', opts);
    await writeJournal();
  }
}

/** The stranded-execution sweep (as in apps/api/src/modules/system.ts): EXECUTING older than `staleMs` becomes FAILED/unknown. Never dispatches. */
export const sweep = (p, staleMs = 0) =>
  p.$executeRaw`UPDATE action SET status = 'FAILED', outcome = 'unknown', note = 'interrupted: outcome unknown', updated_at = now() WHERE status = 'EXECUTING' AND updated_at <= now() - make_interval(secs => ${staleMs / 1000})`;

/** A person's reconciliation (existing route semantics), journalled afterwards (N2). */
export async function reconcile(p, j, actionId, outcome) {
  const [a] = await p.$queryRaw`SELECT org_id, attempts FROM action WHERE id = ${actionId}`;
  await p.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE action SET status = ${outcome === 'applied' ? 'EXECUTED' : 'FAILED'}, outcome = ${outcome} WHERE id = ${actionId} AND status = 'FAILED' AND outcome = 'unknown'`;
    await tx.$executeRaw`INSERT INTO audit (org_id, action, ref, meta) VALUES (${a.org_id}, 'reconcile', ${actionId}, ${JSON.stringify({ outcome })}::jsonb)`;
  });
  const seq = j.state().entries.filter((e) => e.type === 'claim' && e.actionId === actionId).at(-1)?.seq;
  if (seq) await appendLocked(p, j, { type: 'reconciled', seq, outcome, at: new Date().toISOString() });
}

/** Retry rule (unchanged): only FAILED with an outcome known to be not applied. */
export const retryAllowed = (a) => a?.status === 'FAILED' && a?.outcome === 'not_applied';

// ───────────────────────── Inspection and clearance (design §9-§11, N4) ─────────────────────────

/** What recovery must decide about. Reads through `q` (a client or a transaction). */
export async function inspect(q, j) {
  const js = j.state();
  const [row] = await q.$queryRaw`SELECT installation_id, journal_seq FROM installation_state WHERE id = 1`;
  const dbHead = row?.journal_seq ?? 0;
  const live = new Map(); // claim seq -> claim, minus voided
  for (const e of js.entries ?? []) {
    if (e.type === 'claim') live.set(e.seq, { ...e, dispatched: false, outcome: null, reconciled: null });
    else if (e.type === 'void') live.delete(e.seq);
    else if (e.type === 'dispatch' && live.has(e.seq)) live.get(e.seq).dispatched = true;
    else if (e.type === 'outcome' && live.has(e.seq)) live.get(e.seq).outcome = e.outcome;
    else if (e.type === 'reconciled' && live.has(e.seq)) live.get(e.seq).reconciled = e.outcome;
  }
  const after = [...live.values()].filter((c) => c.seq > dbHead);
  const actions = await q.$queryRaw`
    SELECT a.id, a.org_id, a.status, a.attempts, a.outcome, (SELECT count(*)::int FROM approval p WHERE p.action_id = a.id AND p.superseded_at IS NULL) AS approvals
    FROM action a
    WHERE a.status IN ('APPROVED', 'PENDING_APPROVAL', 'EXECUTING') OR (a.status = 'FAILED' AND a.outcome IN ('unknown', 'not_applied')) OR a.id = ANY(${after.map((c) => c.actionId)})
    ORDER BY a.id`;
  const known = new Set(actions.map((a) => a.id));
  const unmatched = after.filter((c) => !known.has(c.actionId));
  const digest = sha(JSON.stringify({ installation: [row?.installation_id ?? null, js.installationId], dbHead, journalHead: js.head, lastHash: js.lastHash ?? null, journalStatus: js.status, actions: actions.map((a) => [a.id, a.status, a.attempts, a.outcome, a.approvals]), after: after.map((c) => [c.seq, c.actionId, c.dispatched, c.outcome, c.reconciled]) }));
  return { digest, dbHead, journalHead: js.head, journalStatus: js.status, problem: trustProblem(row, js), actions, after, unmatched, installationId: js.installationId };
}

/**
 * `recovery clear` (design §9, §11; N4; D5): one transaction with the state row locked first; the digest is
 * recomputed inside it and must match; then the rules apply, an audit row goes to every organisation, and the
 * `cleared` record is appended and flushed BEFORE commit.
 */
export async function clear(p, j, { digest, reason, crashAt, holdMs = 0 } = {}) {
  if (!reason) throw new Error('a reason is required');
  const t0 = now();
  const out = await p.$transaction(
    async (tx) => {
      await tx.$executeRaw`INSERT INTO installation_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
      await lockState(tx);
      if (holdMs) await new Promise((r) => setTimeout(r, holdMs));
      const view = await inspect(tx, j);
      if (view.digest !== digest) return { cleared: false, reason: 'the state changed since inspection' };
      if (view.journalStatus === 'corrupt' || view.journalStatus === 'missing') return { cleared: false, reason: `journal ${view.journalStatus}: needs the explicit unreadable-journal path (N1), not prototyped` };
      const afterIds = view.after.map((c) => c.actionId);
      const sentNote = new Map(view.after.map((c) => [c.actionId, c.dispatched ? 'may have been sent: check the target system' : 'not sent (no dispatch record)']));
      const superseded = await tx.$executeRaw`UPDATE approval SET superseded_at = now() WHERE superseded_at IS NULL AND action_id IN (SELECT id FROM action WHERE status IN ('APPROVED', 'PENDING_APPROVAL'))`;
      const toProposed = await tx.$executeRaw`UPDATE action SET status = 'PROPOSED' WHERE status IN ('APPROVED', 'PENDING_APPROVAL') AND NOT (id = ANY(${afterIds}))`;
      let toUnknown = 0;
      for (const [id, note] of sentNote) toUnknown += await tx.$executeRaw`UPDATE action SET status = 'FAILED', outcome = 'unknown', note = ${`journal: ${note}`} WHERE id = ${id}`;
      const executing = await tx.$executeRaw`UPDATE action SET status = 'FAILED', outcome = 'unknown', note = 'executing at restore' WHERE status = 'EXECUTING'`;
      const meta = JSON.stringify({ digest, reason, by: process.env.USER ?? 'prototype', unmatched: view.unmatched.map((c) => [c.seq, c.actionId, c.org]) });
      const audits = await tx.$executeRaw`INSERT INTO audit (org_id, action, meta) SELECT id, 'recovery_cleared', ${meta}::jsonb FROM org`;
      j.append({ type: 'cleared', digest, reason, at: new Date().toISOString() });
      crashpoint('after_cleared_record', { crashAt });
      await tx.$executeRaw`UPDATE installation_state SET installation_id = ${view.installationId}, journal_seq = ${view.journalHead} WHERE id = 1`;
      return { cleared: true, superseded, toProposed, toUnknown, executing, audits, unmatched: view.unmatched.length };
    },
    { timeout: 600_000, maxWait: 600_000 },
  );
  return { ...out, ms: now() - t0 };
}
