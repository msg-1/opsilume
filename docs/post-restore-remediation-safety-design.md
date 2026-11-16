# Post-restore remediation safety: design

Milestone 16, phase 1. A design for closing critical finding **C1** of [recovery-readiness-audit.md](recovery-readiness-audit.md): after an older PostgreSQL backup is restored, a remediation that was already carried out on an external system can be carried out again.

This is a design only. Nothing described as **proposed** exists. Every statement carries one of these tags:
- **[Verified]:** current behaviour, read in the code at `develop` `11cf150`, with a file reference.
- **[Proposed]:** behaviour this design recommends.
- **[Assumption]:** something taken as true without proof.
- **[Unresolved]:** a choice left open, listed for a decision in section 18.

**Decision status (16 November 2026).** The product owner has approved the main decisions in principle, with conditions, and deferred others. Section 18 records each one, and the review ([post-restore-remediation-safety-decision-review.md](post-restore-remediation-safety-decision-review.md)) gives the reasoning. "Approved in principle" means approved as design direction: nothing is implemented, and Phase 0 (section 19) must confirm the technical assumptions first.

**Revision after Phase 0 (16 November 2026).** The isolated prototype ([post-restore-remediation-safety-phase0-prototype-report.md](post-restore-remediation-safety-phase0-prototype-report.md)) supported the architecture and exposed two defects in this design. This revision takes in its evidence:
- the void is appended under a savepoint (section 6);
- a short write is a journal failure (section 6);
- one journal mutex (section 6.1);
- incremental verification (section 6.2);
- an unknown commit result (section 6.3);
- the dispatch lifecycle (section 6.4);
- clearance at scale (section 9.1);
- durability and supported platforms (section 16.1).

The new technical decisions are P1 to P7 (section 18), and a production readiness gate follows in section 19.

**Revision after Phase 0.5 (16 November 2026).** A second isolated prototype ([post-restore-remediation-safety-phase05-validation-report.md](post-restore-remediation-safety-phase05-validation-report.md); code on the branch `prototype/m16-phase05-validation`, not merged) validated P4, P5 and P6 up to 1,000,000 records and actions. It also found that an **older application can execute remediation while ignoring the journal**. This revision adds:
- **P8,** database-enforced downgrade protection (section 6.5);
- the full-verification schedule options (section 6.2);
- the bounded void memory (section 6.2.1);
- the `COMMIT` failure classification (section 6.3);
- superseding **every** current approval at clearance (section 9);
- the native Linux test specification (section 16.1);
- the 15-item readiness gate (section 19).

Throughout this revision:
- **[Phase 0 evidence]** marks what the prototype showed, on one Docker Desktop installation on Apple silicon only.
- **[Phase 0.5 evidence]** marks the same for the second prototype, in the same environment. None of it generalises to production.
- **Nothing here is production-validated.** Production implementation is **not** authorised.

## 1. Executive summary

**Root cause.** [Verified] Everything OPSILUME knows about what it has executed lives in the same PostgreSQL database that a restore replaces. A restore therefore erases the memory of every execution made after the backup, while the external systems keep the changes.

**Why invalidating approvals is not enough.** [Verified] The danger is wider than "a restored approval is still valid". Consider an action that, at backup time, was:
- only proposed or awaiting approval;
- or failed and marked "not applied".

If it was approved and executed after the backup, it comes back un-executed. It then passes every existing check legitimately: a person approves it again and it is dispatched again. Nothing inside the restored database can tell those actions apart. So no rule that only rewrites the restored database (Option D) can close C1 alone.

**Recommendation.** [Proposed] Keep a small record of executions outside PostgreSQL that a database restore does not roll back: an append-only, hash-chained **execution journal** on its own Docker volume, plus a counter in the database. At every execution claim:
- if the database and the journal disagree, or either is missing, **remediation is quarantined** for the whole installation;
- nothing can be dispatched until an operator runs a host-level recovery command;
- that command lists what the journal says ran after the backup, sends every uncertain action to reconciliation or fresh approval, and records the clearance in both places.

Each execution is journalled twice before any byte is sent: a `claim` line inside the claim transaction, and a `dispatch` line after the commit. A `dispatch` line records the **intent to send**, not that the external change happened (section 6).

**Trade-off.** This turns "restore and carry on" into "restore, review, then clear", and adds one volume and a global ordering of execution claims.

**Known limits.** It does not detect:
- a snapshot that rolls back the journal and the database together;
- a clone that copies both volumes;
- a journal truncated back to the database's head by someone with write access to the volume.

These are accepted risks while an off-host anchor (D3) is deferred (section 17).

The decisions are recorded in section 18. Phase 0 changed the design in two places that its guarantees depend on (P1, P2) and added five further requirements (P3 to P7). See the revision note above.

## 2. Current remediation lifecycle

| Step | What happens | Where it is recorded | Evidence |
|---|---|---|---|
| Propose | An action is created `PROPOSED`, by a person or the AI agent, with a computed effect and risk floor | `RemediationAction` row | [Verified] `modules/remediation/proposals.ts`; `routes.ts:86-92` |
| Submit | Under the row lock: content re-checked; status → `PENDING_APPROVAL`; the approval fingerprint (content, execution target, source review) stored in `contentHash` | `RemediationAction`, `AuditLog` (same transaction) | [Verified] `approvals.ts` `submitForApproval`; `routes.ts` request-approval |
| Approve or reject | Under the row lock: an `Approval` row bound to the fingerprint; `APPROVED` once enough distinct approvers count. Approvals expire after `REMEDIATION_APPROVAL_VALIDITY_HOURS` (default 24) by the database clock | `Approval`, `AuditLog` | [Verified] `approvals.ts:26,93-120` |
| Claim | One transaction under the action row lock plus a share lock on the settings row: approvals recounted, destination digest compared, status → `EXECUTING`, `attempts + 1`; `execute_start` audited in the same transaction | `RemediationAction`, `AuditLog` | [Verified] `approvals.ts:196-224`; `routes.ts:276-290` |
| Dispatch | After the claim commits, inside the HTTP request: a webhook POST, or a person attesting a manual change | Nothing until the outcome | [Verified] `routes.ts:302`; `execution.ts:33-99` |
| Outcome | Conditional update to `EXECUTED` or `FAILED` with `applied`, `not_applied` or `unknown`, audited in the same transaction; then the effect is copied to the service history | `RemediationAction.executionResult`, `AuditLog`, `ServiceEvent`/`Deployment` | [Verified] `recording.ts:21-24`; `routes.ts:305-318` |
| Stranded execution | The worker's sweep (in the `alert-eval` schedule) marks `EXECUTING` older than `REMEDIATION_EXECUTION_STALE_MINUTES` as `FAILED`/`unknown` | Same, audited | [Verified] `system.ts:17-21,50-66` |
| Reconcile | A person records `applied`, `not_applied` or still `unknown` for the latest attempt; the history is kept in `executionResult.reconciliations` | `RemediationAction`, `AuditLog` | [Verified] `routes.ts` reconcile |
| Retry | Only `FAILED` with `not_applied`, only the named attempt: status → `APPROVED`, then execution checks everything again | `RemediationAction`, `AuditLog` | [Verified] `routes.ts:381-399` |

**What reaches the external system.** [Verified] (`execution.ts:43-71`)
- **Payload:** the action id, `idempotencyKey` (= action id), `attempt` (= `attempts` after the claim), the type, parameters, the approval fingerprint, the approvers, and `approvedAt` set to the time of sending.
- **Headers:** `idempotency-key: <action id>` and `x-opspilot-attempt: <attempt>`, plus an HMAC signature when a secret is set.
- **What a receiver can recognise:** the idempotency key is the same for every attempt, including legitimate retries. A receiver that stored `(idempotency key, attempt)` could recognise a repeated attempt.
- **What a receiver can't rely on:** the signature differs each time because `approvedAt` changes. OPSILUME doesn't control or know whether any receiver keeps such a record.
- **Manual mode** sends nothing; a person attests that they made the change.

**Other outbound request.** [Verified] The only other request to the webhook address is the reachability check (`integrations.ts:441-470`). It sends `event: "ping"` with no action and changes nothing.

## 3. Root cause of C1

**What a restore loses.** [Verified] A restore replaces every table. Everything written after the backup is lost:
- `RemediationAction` status, `attempts`, `executedAt`, `executionResult` and its reconciliation history;
- `Approval` rows, including rejections and supersessions;
- the `AuditLog` entries for all of the above;
- the incident timeline (`IncidentEvent`);
- the service-history records written by executions (`ServiceEvent`, rollback `Deployment` rows);
- actions created after the backup, which no longer exist at all.

Settings and people roll back too:
- webhook address and secret;
- approval thresholds and self-approval;
- memberships, revoked API keys and invited users.

**Protections that depend on those records:**

| Protection | Depends on | After a restore |
|---|---|---|
| Single dispatch per attempt (status `EXECUTING` claim) | `status`, `attempts` | Reset to the backup's values: a second claim of the same attempt number succeeds |
| No retry of an unknown outcome | `executionResult.outcome` | An action that became `unknown` after the backup is back to `APPROVED` or `PENDING_APPROVAL` |
| Retry only after not applied | `executionResult` and its reconciliations | A later "applied" reconciliation is lost; an earlier `not_applied` permits a retry |
| Approval expiry | `Approval.createdAt` against the database clock | Still enforced, so approvals older than the validity window stop counting. That helps only for backups older than 24 h |
| Destination binding | Settings row and stored fingerprint | Both roll back together, so they still match |
| Idempotency key at the receiver | The receiver's own storage | Unknown; outside OPSILUME |

**Root cause, stated precisely.** [Verified] OPSILUME's record of external side effects is stored only in the database whose state a restore rewinds. There is no record of executions that survives a restore, and no way for the application to notice that its database is older than the last execution it performed.

**Restoring has no hook to attach to.** [Verified] There is no restore command. Restoring is a hand-run `pg_restore` into a new database, then pointing `DATABASE_URL` at it (`docs/backup-and-restore.md:88-109`; `scripts/backup.mjs` offers only `create`, `verify` and `status`). So **no protection may rely on the restore procedure leaving a marker.** The application has to notice by itself.

## 4. Threat model

Each scenario below assumes the protections of section 2, with nothing proposed.

**A. Approved before the backup, executed after it.**
- [Verified] It comes back `APPROVED` with valid approvals if the backup is less than 24 h old. Execution claims it as attempt 1 again and dispatches; nothing stops it.
- **Variant A2:** the action was `PROPOSED` or `PENDING_APPROVAL` at backup time. It comes back needing approval. A person approves it in good faith, and it is dispatched again. Approval invalidation does nothing here.
- **Variant A3:** the action was created after the backup. It doesn't exist after the restore, and the same change can be proposed again under a new id (by a person, or by the agent from the same evidence).

**B. Restored during an execution.**
- [Verified] A webhook may have been sent, or may still be in flight, from the old installation, while the backup shows the action `APPROVED`, or `EXECUTING` if the backup caught it mid-attempt.
- `EXECUTING` is settled by the sweep as `unknown` once stale, which is correct.
- `APPROVED` is executable again (as A). The original request may still be processing, so the two can overlap.

**C. Applied, but the outcome or its audit row was not stored.**
- [Verified] Since Milestone 14, a failed outcome write leaves the action `EXECUTING`, and the sweep later records `unknown` for a person to reconcile. That is correct while the database survives.
- If a restore lands before the claim, the case reduces to A.

**D. Reconciled after the backup.**
- [Verified] A person recorded `applied` or `not_applied` after checking the target system; the restore loses that decision.
- The action returns to `FAILED`/`unknown`, which is safe: it needs reconciling again.
- Or it returns to `APPROVED`, which is unsafe, as in A. Or, unsafely, to `FAILED`/`not_applied`, so that a retry is permitted although a later retry was in fact applied.

**E. Restored onto another host.**
- [Verified] Nothing identifies an installation today. A disaster-recovery replacement, a deliberate clone for testing and the original are indistinguishable.
- A test clone keeps the production webhook address and secret. Executing there sends a real, signed request to production.

**F. An old backup under newer software.**
- [Verified] `migrate deploy` applies newer migrations to an older restored database (`docker-compose.yml:78-89`).
- [Proposed constraint] Any new column or table that marks history as trustworthy must have a default that means **untrusted**. Otherwise a migration run on a pre-feature backup would silently mark it trusted.

**Also in scope.** [Verified]
- Settings and memberships roll back (section 3). An address or a person removed after the backup is back.
- Destination binding still holds, because the address and the fingerprint agree with each other. That doesn't make the address the right one today.

**The test every option must pass.** Scenario A2 (and A3, as far as possible) must not be executable again after a restore, **without relying on the receiver**.

## 5. Candidate architecture comparison

**Where state can live outside PostgreSQL:**

| Location | Survives a `pg_restore` | On host loss | On a snapshot of everything | Notes |
|---|---|---|---|---|
| A file on a separate Docker volume | Yes | Lost: must mean closed | Rolled back with the database: **undetected** | Single host only, without shared storage |
| Redis | Yes (not restored with PostgreSQL) | Lost | Rolled back | [Verified] Losing Redis is routine and drilled (`queue-wiped`); every loss would quarantine. Not authoritative by design |
| `.env` / environment | Yes | Kept only if the operator keeps it | Rolled back if the file is in the snapshot | Static: suits an identity, can't hold a moving counter |
| Off-host store (second host, object storage) | Yes | Yes | Not rolled back | An external service: **needs explicit approval**. Adds a dependency on every execution |

**The options:**

| Option | What it is | Passes A | Passes A2 | Passes A3 | Host loss | Clone (E) | Cost | Verdict |
|---|---|---|---|---|---|---|---|---|
| **A. Installation identity** | A random id stored outside the database, and copied into it | No: a restore on the same host keeps the same id | No | No | Detects the new host (id missing) | Detects it | Low | Necessary for E; not sufficient |
| **B. External execution journal** | An append-only record of each claim, outside the database | Yes: the journal is ahead of the database | Yes | Partly: it lists action ids the database lacks; can't stop a new proposal | Journal lost: must fail closed | Journal absent on the clone: closed | Medium: a volume, an fsync per claim, a global claim order | **The core** |
| **C. Restore marker** | A flag the restore procedure writes | Only if the operator writes it | Same | Same | — | — | Low | Rejected as the primary signal: [Verified] there is no restore tool to write it. Usable as a reminder in the runbook |
| **D. Restore-time invalidation** | A command that supersedes approvals and marks uncertain executions | Yes, if run | **No**: nothing tells it which actions ran after the backup | No | — | — | Low | Necessary at clearance; useless alone |
| **E. Combined** | A + B + D + operator clearance | Yes | Yes | Lists it | Closed | Closed | Medium | **Recommended** |

**The automatic signal is a comparison, not a flag.** [Proposed] The database's journal head and the external journal's head are compared, rather than reading a marker someone must set. A marker can be forgotten, deleted or never written. A comparison reflects the actual state every time it is made.

## 6. Recommended architecture

[Proposed] Installation identity plus an external execution journal, with automatic detection, installation-wide quarantine, and recovery and clearance by a host command (Option E).

**Components** [all Proposed]:
- **A state volume** `opspilot-state`, mounted into the API container only. Nothing else dispatches: the worker's sweep never sends anything ([Verified] `system.ts:50-66`). Also mounted into the one-off container that runs the recovery command.
- **`installation.json`** on that volume: a random `installationId` and the time it was created. Written once by provisioning; never by the application during normal work.
- **`journal.log`** on that volume: one line per event, opened append-only (`O_APPEND`), never rewritten in place. Each line is written with **one** `write` call whose returned byte count is checked (P2), then `fsync`ed. Line types:
  - `claim`: sequence number, action id, organisation id, attempt, approval fingerprint, destination digest, time. Written inside the claim transaction, before commit.
  - `void`: a sequence number whose claim transaction is known to have rolled back.
  - `dispatch` (N2): sequence number and time. Written after the claim commits and **before the first byte is sent**, or before a manual attestation is recorded. It records the **intent to dispatch**. It does **not** show that the request reached the receiver or that the external change happened.
  - `outcome` (N2): sequence number and the outcome stored in the database (`applied`, `not_applied` or `unknown`). Written after the outcome transaction commits.
  - `reconciled` (N2): sequence number and a person's recorded outcome. Written after the reconcile transaction commits.
  - `cleared`: a recovery clearance, with the inspection digest (N4).

  Each line carries the SHA-256 of the previous line (a hash chain). The chain detects accidental corruption and edits in the middle of the file. It does **not** detect truncation of the tail, or a chain recomputed by someone with write access to the volume (section 12).
- **The journal head** is the last `claim` sequence that has no `void`. `dispatch`, `outcome`, `reconciled` and `cleared` lines never move the head, and failing to write them never affects trust; they inform recovery only.
- **The files are created once** at provisioning: write `installation.json` and an empty `journal.log`, `fsync` each, then `fsync` the directory, so that a power loss can't lose a file that was just created.
- **A database row** `InstallationState` (a single row): `installationId` (nullable), `journalSeq` (the last claimed sequence), and timestamps. A migration creates it **empty**, so the absence of the row means untrusted (Scenario F).

**Where the check happens.** [Proposed] Inside the claim transaction (`claimExecution`):
1. Lock the `InstallationState` row `FOR UPDATE` **first, before the action row** (N5). Every claim and every clearance then takes the locks in the same order, so the two can't deadlock. Section 13 covers lock order.
2. Read `installation.json` and the journal head from the volume. Then run the existing action and settings checks, unchanged.
3. **Trusted only if all hold:**
   - both files exist and parse;
   - the hash chain is intact up to the head;
   - `installationId` is equal in the file and the row;
   - the row's `journalSeq` equals the journal head.

   Anything else returns a new claim result, `quarantined`, with a reason. Nothing is claimed, the action is unchanged, and the refusal is audited in the transaction.
4. If trusted: `seq = journalSeq + 1`. **Take a savepoint** (P1). **Append the `claim` line for `seq`, check that every byte was written (P2), and `fsync` it while the transaction is still open.** Then update the row, write the audit row, and commit.
5. **If a database statement after the savepoint fails** (an audit insert, a constraint, a lock timeout):
   1. roll back **to the savepoint**;
   2. append `void seq`, while the `InstallationState` lock is still held;
   3. rethrow, so that the whole transaction still rolls back.

   **Why the savepoint.** [Phase 0 evidence] PostgreSQL aborts a transaction, **and releases its locks,** at the first failed statement. Without the savepoint the `void` was written without the lock. With two API containers that forked the hash chain: the journal was corrupt in both first runs, and B1 had 266 spurious quarantine refusals. Rolling back to a savepoint taken after the lock keeps the lock; the runs after this fix were clean. [Unverified in production] It must be tested again in the implementation.

   **If something in step 5 itself fails** [Proposed]:
   - **The rollback to the savepoint fails:** the connection is unusable. Do not append `void`; rethrow. The journal is then one claim ahead, so the next comparison quarantines (safe).
   - **The `void` append fails** (including a short write): rethrow. The journal is ahead, or has a torn tail, so it quarantines or refuses appends (safe).

   **In every case,** nothing is dispatched, and nothing commits after an error: the Milestone 14 rule is kept.
6. **If the result of the commit is unknown** (the connection drops during `COMMIT`), see section 6.3. **Correction:** the original text said the journal and the database "disagree whichever way it went". They do not when the commit did happen: the heads are then equal and the claim is trusted. That is still safe, because nothing has been dispatched, but recovery must not rely on a mismatch to notice it.
7. After a commit that is known to have succeeded: append and `fsync` the `dispatch` line (bytes checked), then send. If the `dispatch` line can't be written completely, nothing is sent. The action stays `EXECUTING` until the sweep records `unknown`, and the journal shows a claim with no dispatch, meaning not sent.

Dispatch starts only after a commit known to have succeeded, and after the `dispatch` line is completely on disk. The journal writes are not database statements, and nothing commits after a database error, so the Milestone 14 rule (never catch a database error inside the transaction and carry on) is kept. A failed `claim` write throws, the transaction rolls back, and nothing is sent.

**Short writes (P2).** [Phase 0 evidence] On a full 64 KiB filesystem, Node's `fs.writeSync` returned 343 of 461 bytes **without throwing**. The prototype's append first counted that as a success, leaving a torn record behind a "successful" append. Required [Proposed]:
- the byte count of every journal write is compared with the record's length, and any difference is a **journal failure**;
- nothing is dispatched after one;
- a failed `claim` append rolls the transaction back (no `void` is needed: the claim never became a complete record);
- the partial bytes are a torn tail (N1). Further appends are refused until the repair tool records them;
- the file is **never** truncated, rewritten or recreated to "fix" it. [Phase 0 evidence] A deleted journal was refused (`JOURNAL_MISSING`), not recreated.

**Crash windows and failures** [Proposed analysis]. Two guarantees hold:
- no request is sent without a `claim` line on disk;
- no request is sent before its `dispatch` line is on disk.

A claim alone never proves that anything was sent, and a `dispatch` line never proves that anything happened externally.

| Event | State left | Effect |
|---|---|---|
| Crash before the `claim` append | Nothing changed | None |
| **Failure 1: the journal append succeeds, then the database transaction rolls back** (an audit insert fails, a lock times out) | `claim seq` on disk, then `void seq` | Heads equal (the voided claim doesn't count): trusted. Nothing was sent. If the `void` write also fails, the journal is ahead, so quarantine (safe) |
| Crash after the `claim` append, before commit | Journal head `seq`, database `seq-1` | Mismatch, so quarantine: a false positive, rare and safe. **While the original database still exists**, recovery sees the action not claimed, so the claim was never committed and nothing was sent. **After a restore** that can't be told apart from a claim that committed and was then erased; the absence of a `dispatch` line is what shows nothing was sent |
| Commit result unknown | If the commit did **not** happen: journal ahead. If it **did**: heads equal, action `EXECUTING`, no `dispatch` line | No `void`, no dispatch. The first case quarantines; the second is trusted, and the action is settled by the sweep as `unknown` (journal: not sent). Section 6.3 |
| **Failure 2: the database commit succeeds, then the process crashes before dispatch** | Equal heads; action `EXECUTING`; `claim` without `dispatch` | Trusted (heads equal). The sweep records `unknown` once stale. Recovery can say **certainly not sent**, because there is no `dispatch` line, so a person can reconcile it as `not_applied` |
| Crash after the `dispatch` line, before or during sending | `claim` and `dispatch`, no `outcome` | The sweep records `unknown`. The request may or may not have reached the receiver: a person must check the target system |
| After sending | As today, plus an `outcome` line if it was written | As today |
| A torn final line (crash or a full disk during an append) | A last line without its newline, or with a bad hash | **N1:** because commit only follows a successful `fsync`, a torn final line was never committed. It is treated as absent and repaired only by the recovery tooling. Corruption anywhere else means quarantine |

**Why the journal is written before commit and not after.** [Proposed] Writing after commit would leave a window in which a second API process sees the database ahead of the journal and quarantines falsely. Holding the `InstallationState` lock through append and commit orders all claims.

### 6.1 The journal mutex (P3)

**Recommendation** [Proposed; P3, awaiting approval]: one authoritative mutex for **every** journal append, namely the PostgreSQL `InstallationState` row lock (`SELECT … FOR UPDATE`).
- **Claims** append inside their own transaction while holding it.
- **Every other record** (`dispatch`, `outcome`, `reconciled`, `cleared`, `repair`) is appended in a short transaction that takes the same lock, appends, `fsync`s and closes the file before commit.
- **`flock` is not used.**

**Evidence** [Phase 0 evidence]:
- **The row lock:**
  - 626 claims from two containers, and from eight processes, gave an intact chain with no duplicate sequences;
  - the journal head equalled the database head;
  - there were no deadlocks.
- **`flock(1)`:** it also kept 1,000 cross-container appends intact. But killing the lock holder did **not** release the lock while a child process that had inherited the locked descriptor was alive. It was released only when the descriptor was not inherited.

**Why the row lock:**

| Concern | Row lock | `flock` |
|---|---|---|
| Lock order | One lock, already taken **first** by claims and clearance (N5): no second lock to order against it | A second lock whose order against the row lock would need defining everywhere |
| Claim and clearance | Serialised by the same lock that also protects the sequence | Needs both locks; a wrong order risks deadlock |
| Transaction failure | Held through the savepoint rollback and the `void` append (P1) | Independent of the transaction; doesn't cover the sequence |
| Process or container killed | PostgreSQL ends the session and releases it ([Phase 0 evidence] B3, B4) | Released only if no child inherited the descriptor; needs `O_CLOEXEC` and no child processes as a permanent invariant |
| Operations | Nothing new to run | Lock files on the volume, inheritance rules |

**Consequences of choosing the row lock:**
- **When the database is unavailable,** no journal record can be appended. Claims need the database anyway. A `dispatch` record that can't be appended means the request is **not sent**: the action stays `EXECUTING` and the sweep later records `unknown` (not sent). `outcome` and `reconciled` records are evidence only; when they can't be written, recovery has less evidence but trust is unaffected.
- **The repair tool and clearance** must also take the row lock.
- **The file is opened, written, `fsync`ed and closed inside the lock.** No process keeps a journal descriptor open between appends.
- **No multi-host support.** The row lock is global, but the journal file isn't shared between hosts. Two API hosts would each write their own journal and quarantine each other. Only one API host is supported (N10).

### 6.2 Incremental verification (P4)

**The problem.** [Phase 0 evidence] Verifying the whole journal on every claim took about 162 ms at 100,000 records (25.6 MB), and the prototype's append (which re-parses to find the last hash) grew from 0.43 ms to 1.19 ms p50 over the first 1,000 records. That cost grows without bound.

**Proposed strategy** [Proposed; P4, awaiting approval; **not prototyped**]:
- **A per-process cache,** never shared between processes and never persisted:
  - the file's device and inode;
  - the verified byte offset;
  - the hash of the last verified record and that record's start offset;
  - the head and the last claim (sequence and action).
- **At each check, under the row lock:**
  1. `fstat` the journal.
  2. **A different device or inode** (the file was replaced): full verification.
  3. **The file is smaller than the verified offset** (it shrank): full verification. That will normally end in quarantine.
  4. **Otherwise,** re-read the **last verified record** (from its start offset to the verified offset), **recompute its hash from its content,** and check that the result equals both its stored hash and the cached one. **Never trust the stored hash field alone.** [Phase 0.5 evidence] The prototype's first implementation compared only the stored `hash` field and **missed an in-place rewrite** of the last record (case f), because editing another field leaves that field unchanged. Recomputing from the content caught it.
  5. Then read and verify **only the bytes after the verified offset,** with the normal rules: the chain continues from the cached hash, the sequence follows, and a torn tail is not counted. Advance the cache only over complete, valid records.
- **Anchor the head hash in the database too** [Proposed]: `InstallationState` stores the hash of the claim record at the database head, not only its sequence number. The trust comparison then checks the sequence and the hash. [Phase 0.5 evidence] A replacement journal with a valid chain and **the same head** was caught **only** by this anchor (case d3). It is a schema addition, so it needs approval.
- **Several API processes:** each has its own cache. Another process's appends simply appear as new bytes after this process's offset, and are verified like any others. A cache is a performance aid, never a source of trust: a cache that disagrees with the file is discarded and verification starts over.

**When a complete verification is mandatory:**
- at process start;
- when the cache is empty or invalid;
- on a device or inode change, or when the file shrank;
- after any verification failure, before reporting corruption;
- before `inspect` and `clear`, which always verify from the start;
- after a torn-tail repair;
- on a schedule (section 6.2.2). This catches in-place edits **in the middle** of the file, which the incremental check can't see.

**Limit.** Between scheduled full checks, an in-place edit of an earlier record that changes neither the size nor the last record is not seen. That requires write access to the volume, which is already an accepted risk (section 12). [Phase 0.5 evidence] Confirmed: an edit of an earlier record (case h) passed the incremental check and was caught by a full one.

**Measured** [Phase 0.5 evidence; Docker Desktop, Apple silicon only]:

| Records (journal size) | Per-claim incremental verification p50 / p99 | Full verification | Peak memory of a full verification (an empty Node process is 41 MB) |
|---|---|---|---|
| 100,000 (23.4 MB) | 0.064 / 0.398 ms | 135 ms | 82 MB |
| 500,000 (117 MB) | 0.061 / 0.410 ms | 687 ms | 99 MB |
| 1,000,000 (235 MB) | 0.052 / 0.450 ms | 1,372 ms | 106 MB |

**Other evidence:**
- Two containers (1,000 claims) ended with matching heads, matching head hashes and unique sequences.
- An unlocked reader running 95,890 checks during 2,000 appends saw 1 torn tail and 0 corrupt states.
- A process's cache picked up another process's appends without going stale.

**Full verification is streamed** in fixed-size reads, so its memory doesn't grow with the journal.

**Restart behaviour:** a new process has no cache, so its first check is a full verification (1.4 s at 1,000,000 records in this environment). A large journal therefore slows the first claim after a start-up. [Proposed] Run the start-up verification before the API reports ready, so the first request doesn't pay for it.

**Corruption and torn tails:** unchanged (N1).
- A torn tail is ignored for trust, and appends are refused until the repair tool records it.
- Corruption anywhere is quarantine.
- A corrupt result is never cached, and is confirmed by a full verification before being reported.

#### 6.2.1 Bounded void memory

**The problem.** After a `void`, the verifier needs the hash of the claim that becomes the head again, to compare with the database anchor. Keeping every claim's hash costs memory in proportion to the journal.

**Proposed** [Proposed; awaiting approval]:
- **The bound:** the verifier remembers the hashes of the last **64** live claims (a stack). A `claim` pushes; a `void` pops.
- **When the bound is exceeded:** a `void` that would need a hash no longer remembered makes the head hash **unknown**. The trust comparison then **fails closed** with an explicit reason ("journal head hash unknown"). Nothing is discarded silently: the journal itself still holds every record, and clearance re-establishes the anchor from a full verification.
- **Why 64 is ample** [Assessment]. Under P1, a void follows its own claim under the same lock. Under P5, a void is written only when the database is one claim behind. So a correct journal never needs more than one remembered claim beyond the head. 64 leaves margin for implementation surprises, at negligible memory cost (64 hashes).
- **Alternative considered:** each `void` record also carries the head hash it restores. That removes the bound, but it puts trust in a value the verifier can't cross-check beyond its memory. It is not recommended now.

[Phase 0.5 evidence] The prototype used this bound. No test exceeded it, so the fail-closed path is **specified but not exercised**.

#### 6.2.2 Full-verification schedule (pending decision)

The interval is **not decided**. The options:

| Option | Detection delay for a middle edit | Cost | Notes |
|---|---|---|---|
| Mandatory events only (no schedule) | Until the next restart, `inspect` or `clear` | None extra | Weakest; an edit can go unseen for weeks |
| Time-based, in the background (for example daily) | Up to the interval | One full read per interval (1.4 s and about 106 MB at 1,000,000 records, measured on Docker Desktop) | Predictable; independent of load |
| Claim-count-based (for example every N claims) | Up to N claims | One full read per N claims | Follows activity; idle installations are never checked |
| Time-based **or** claim-count-based, whichever comes first | The smaller of the two | As above | The two combined |

**Recommendation** [Proposed; **awaiting product-owner approval**]:
- a background full verification at a fixed time interval, **plus** the mandatory events;
- run **outside** the claim lock, as an unlocked reader ([Phase 0.5 evidence]: unlocked reads never saw a corrupt state);
- **a failure invalidates every cache and quarantines** until a person reviews it;
- a **daily** interval is suggested as a starting point, to be confirmed against measurements on the supported platform. The interval is **not** chosen here.

### 6.3 Unknown commit result (P5)

**Status:** validated in the Phase 0.5 prototype. **Still to be tested in the application's real integration.**

[Phase 0.5 evidence] Five scenarios passed, with the faults injected by a proxy at the PostgreSQL wire protocol (the `COMMIT` cut before forwarding, or its answer swallowed after the server replied):
- committed, answer lost;
- rolled back at `COMMIT` (a deferred foreign key), answer lost;
- connection dropped during `COMMIT`;
- database unavailable straight after `COMMIT`, then available again;
- the process restarted before resolving.

Each was correctly recognised, or left uncertain while the database was unreachable. In none was anything dispatched, and the journal was only appended to.

**Situation.** The `claim` record for `seq` is on disk, `COMMIT` was sent, and the connection dropped before the reply. PostgreSQL may or may not have committed. **A missing confirmation is never taken to mean "failed".**

**Proposed handling** [Proposed; P5, awaiting approval]:
1. **Do not dispatch, and do not write `void`.** The request ends with an error saying the outcome of the claim is uncertain.
2. **Resolve it now, if the database is reachable:** reconnect and, in a new transaction, lock `InstallationState` and read `journalSeq` and the action's status and attempts.
   - **`journalSeq = seq` and the action is `EXECUTING` with this attempt:** the claim **committed**. It stays undispatched: the action is left `EXECUTING`, and the sweep records `unknown`, with the journal showing no `dispatch`, meaning not sent. A person can then reconcile it as `not_applied` and retry.
   - **`journalSeq = seq - 1` and the action is unchanged:** the claim **did not commit**. Append `void seq` while holding the lock. The heads are then equal again.
   - **Anything else** (another sequence, a changed action): leave it alone. The comparison will quarantine, and a person resolves it.
3. **If the database stays unreachable:** do nothing more. The journal keeps the `claim` with no `dispatch`. When the database returns, either the heads differ (quarantine) or they are equal with the action `EXECUTING` (the sweep records `unknown`, not sent).
4. **After a process restart,** there is no in-memory state to recover: the same rules apply. A start-up check may run step 2 for a last claim that has no `dispatch` and no `void`. **It must not void automatically on any other evidence.**

**Classifying the failure** [Proposed; must be tested against the real driver]:
- **Before `COMMIT`:** an error raised by any statement **inside** the transaction callback. The transaction certainly did not commit. If it happened after the `claim` append, the P1 path applies (roll back to the savepoint, then `void`). If it happened before the append, nothing was written.
- **During `COMMIT`:** the callback **returned**, and the transaction call then failed: a connection loss, a timeout, a server error. The result is **uncertain**. The prototype marked "callback finished" as the callback's last action and treated any later failure as uncertain. That is conservative: a failure that is really a rollback (a deferred constraint, Prisma's own transaction timeout) is resolved as "not committed" by step 2 below, never assumed.
- **Not every connection failure is a failed `COMMIT`.** A connection failure **before** the callback ran (for example, acquiring a connection) means no claim was attempted. One **inside** the callback means "not committed". Only one **after** the callback means "uncertain".
- **The driver detail must be confirmed in implementation tests.** The evidence is for Prisma 6.19.3, which sent `COMMIT` as a simple query in every scenario. Error codes and timeouts (including the interactive-transaction timeout) must be mapped in tests against the version in use. Where they can't be mapped, the result stays **uncertain**.

**Rejected: automatically healing any "journal one ahead".** [Assessment] A restored database that is behind by exactly one undispatched claim looks the same. Healing it would hide the restore, and with it the settings and memberships the restore rolled back.

**Not chosen: dispatching after confirming that the commit happened.** [Assessment] The claim is ours and nothing was sent, so this would be safe in principle. But the request has already failed for the user, and an uncertain commit should be rare. Leaving it for reconciliation is the conservative choice. [Unresolved, P5] Recorded for the owner.

### 6.4 Dispatch lifecycle

What each stage records, and what it proves. [Proposed; the distinctions confirmed by Phase 0 experiment D]

| Stage | Recorded as | Proves |
|---|---|---|
| Claim recorded | `claim` record, before commit | Only that a claim was attempted. Not that it committed or was sent |
| Claim committed | `journalSeq` and the action `EXECUTING`, in the database | The attempt is ours; nothing sent yet |
| Dispatch intent | `dispatch` record, before the first byte | Intent only. [Phase 0 evidence] S3: a `dispatch` record existed and the receiver received **nothing** |
| Request sent | Nothing on its own (the receiver's records) | Not knowable to OPSILUME after a crash: S4 and S5 left identical journals |
| Response observed | The outcome in the database | What the receiver answered, not what it did |
| Outcome recorded | Database first, then the `outcome` record | The recorded outcome. [Phase 0 evidence] In the reversed order (S6b), the journal said `applied` while the database stayed `unknown`; the journal is evidence only |
| Human reconciliation | Database, then the `reconciled` record | A person's finding |

**Unknown outcomes are never retried automatically.** [Phase 0 evidence] No crash at any of the 11 tested boundaries made a retry possible. A retry still requires `not_applied`.

### 6.5 Database-enforced downgrade protection (P8)

**The gap.** [Phase 0.5 evidence] An older application, written before this feature, knows nothing of the journal. Against a database that has the feature, its claim **succeeded and dispatched**. The journal never saw it, the heads still matched, and the installation still looked trusted, so a later restore would not reveal that execution. The no-downgrade **policy** (N9) does nothing against this, and **a version check in application code can't help either:** the older application doesn't have that check.

**The guard** [Proposed; P8, **awaiting approval**; the prototype trigger is **not** production-ready]:
- **What it does:** a PostgreSQL trigger on the remediation action table, `BEFORE INSERT OR UPDATE`, refuses any row **entering** `EXECUTING` (from any other status, or inserted as `EXECUTING`) unless the transaction has proved it followed the journal protocol.
- **The proof** [Proposed]: the claim transaction sets a transaction-local setting, `set_config('opsilume.claim_seq', <seq>, true)`, **after** advancing `InstallationState.journalSeq` to `<seq>` in the same transaction. The trigger requires the setting to equal the current `journalSeq`.
  - The setting is transaction-local, so it can't leak to another transaction or session.
  - A stronger variant also checks that the `InstallationState` row was modified by the current transaction (its `xmin`). [Unverified] Not prototyped.
- **The read-only exemption** (consistent with D6): an action whose stored effect is `read_only`, before and after the update, is exempt. The application never changes a state-changing action to read-only. Whether the trigger should also forbid that change is part of the integration design.
- **Failure mode: closed.** Any doubt raises an error with a dedicated SQLSTATE, and the transaction rolls back, so nothing is claimed and nothing is dispatched.

[Phase 0.5 evidence] With the guard: the older application's claim was refused (`P0001`) and nothing was sent; the newer application's claims and the sweep (`EXECUTING` → `FAILED`) still worked.

**Installation and activation:**
- **The same migration that creates `InstallationState`** also creates the guard, so any database that has the feature has the guard.
- **Order inside the migration:** the trigger function and trigger first, then the table. If the migration were applied only partly, a guard that references a missing table raises an error on every claim, which fails closed.
- [Unverified] Whether `prisma migrate deploy` applies a migration atomically on PostgreSQL must be confirmed by a test. The order above is the safety net if it doesn't.
- **The guard is active immediately.** No setting enables it, and none disables it.

**How each component behaves:**

| Component | With the guard |
|---|---|
| Newer API | Claims set the proof in the claim transaction; unaffected otherwise |
| Older API (pre-feature) | Every state-changing claim is refused at the database: an error, nothing dispatched. Its other routes (propose, approve, reject, edit, cancel, reconcile, retry, reads) keep working, because none moves an action into `EXECUTING` |
| Older worker | Unaffected: the worker never claims. Its sweep moves `EXECUTING` → `FAILED`, which the guard allows |
| Retry (`FAILED` → `APPROVED`) | Allowed. Execution afterwards goes through the guarded claim |
| Reconcile (`FAILED` → `EXECUTED`/`FAILED`) | Allowed; nothing is dispatched. An older application's reconciliation isn't journalled, which costs recovery evidence, not safety |
| Direct SQL by a person | A person can set the session setting themselves, or disable the trigger, if their role permits. The guard stops **older application code**, not a privileged person |
| Mixed versions during an upgrade | Once the migration has run, older API instances can't execute until they are replaced. Execution is unavailable from them in the meantime; that is the intended fail-closed behaviour |

**Privilege boundary** [Verified for the current deployment, then proposed]:
- [Verified] The application connects as the same database role that owns the tables (`docker-compose.yml`: one `opspilot` role, used both for migrations and at runtime). The table owner can `ALTER TABLE … DISABLE TRIGGER` or drop the trigger.
- [Proposed; pending decision] Separate a **migration role** (owner) from a **runtime role** (not the owner). Then the running application, any version, can't disable or drop the guard.
- Until then, the guard protects against older application code, **not** against a compromised application or a person with the owner role.

**Migration rollback and downgrade:**
- Prisma migrations are forward-only.
- Removing the guard means a person deliberately dropping it with owner rights. That isn't a supported downgrade path; it would need to be audited and is a decision in its own right (below).
- Running an older application against a newer database leaves the guard in place, so remediation execution is unavailable until the application is upgraded again.
- **Recovery when the guard exists but the application is incompatible:** upgrade the application. A documented, audited "remove the guard" procedure for emergencies is a decision for the product owner (recommended: none, consistent with D7).

**Limitations:**
- it relies on the migration having run;
- an owner-role connection can bypass it;
- it guards claims, not reads;
- a trigger runs on every action update, and the overhead hasn't been measured on the real table.

**Integration tests required** (none done):
- a real older API build against a newer database: claim refused, every other route working;
- a newer API: claims pass; diagnostics exempt;
- the worker of each version;
- migration atomicity, including a partly applied migration failing closed;
- inserts made directly as `EXECUTING` are refused;
- disabling the trigger with the runtime role is refused, once roles are separated;
- the overhead on a realistic table;
- error mapping in the newer API (a clear message, never a generic 500).

## 7. Installation identity strategy

**Provisioning** [Proposed]: a host command, `npm run recovery -- init`, never run by the application on its own.

**Fresh installation** [Unresolved, decision D9; recommendation below]. `init` may run unattended in the `migrate` step only if all of these hold:
- the state volume is empty;
- `InstallationState` has no row;
- the database has **no organisation** before seeding.

A restored backup always contains organisations, so it never qualifies. **Condition (D9):** the emptiness check and the creation of the `InstallationState` row happen in the same transaction, so a restore can't slip in between them.

**Every other case:**
- a first upgrade of an installation with history;
- a restore onto a new host;
- a clone.

These need the explicit clearance in section 11. `init` refuses when the database contains any organisation.

**Tests and the isolated stack.** [Proposed] They run the same `init`, in global setup and in the isolated stack's startup, against a fresh database and a temporary state directory. They get no switch that production could also set. Some suites deliberately exercise quarantine; those skip `init` or tamper with the files.

**Identity behaviour:**

| Situation | Result |
|---|---|
| `installation.json` missing | Quarantined |
| Database row missing (pre-feature or never provisioned) | Quarantined |
| Ids differ (a database from another installation, or a clone) | Quarantined |
| Both present and equal, heads equal | Trusted |

**Clones** [Unresolved, decision D8]. A clone for testing can be cleared like any other installation, but it should not keep production's webhook address. Approved in principle (D8): clearance asks whether this is the same installation recovering, or a new one. "New installation" generates a new id and removes every organisation's webhook address and secret, audited.

**Operator rule (N8):** never copy `opspilot-state` into a clone. A clone that copies both volumes carries the same id and the same journal head. It is **never quarantined**, so it can dispatch to production's webhook. Only an off-host anchor (D3, deferred) could detect it.

## 8. Restore detection strategy

[Proposed] Detection is the comparison in section 6, made:
- inside every execution claim (authoritative);
- at API start-up (logged, and shown on a read-only status endpoint and a banner in the interface);
- by `recovery status` on the host.

**Interpreting the result** [Proposed]:

| Result | Likely cause |
|---|---|
| Database head behind the journal | A restore (or a crash between append and commit) |
| Database head ahead of the journal | The state volume was replaced, truncated or rolled back |
| Ids differ | Another installation's database |
| A file missing | A new host, a new volume, or never provisioned |

All of them are treated the same way: quarantined.

**Out of scope.** [Assumption] PostgreSQL's own identifiers (the cluster's system identifier, a database OID) also change on a logical restore, but a physical snapshot keeps them. They add nothing the journal comparison doesn't already catch, so they aren't used.

## 9. Quarantine and approval invalidation rules

**Scope.** [Proposed] Installation-wide: a restore affects every organisation at once.

| Operation during quarantine | Proposed | Reason |
|---|---|---|
| Execute (webhook) | **Refused** (409, with the reason) | The invariant |
| Execute (manual attestation) | **Refused** | A person could redo a change already made |
| Record a read-only diagnostic | Allowed (D6) | It changes nothing |
| Retry | **Refused** | It re-enables execution |
| Approve | **Refused** | Any approval given now is superseded at clearance, so recording it would mislead |
| Submit for approval | Allowed, and superseded at clearance (D2). **Condition:** the interface warns that approvals gathered during quarantine will be discarded | Lets work continue |
| Propose, edit, cancel, reject | Allowed | Nothing reaches an external system |
| Reconcile | **Allowed** | It is part of recovery and records a person's finding. "Applied" writes service history only |
| Webhook reachability check (ping) | Allowed (D6) | It carries no action |
| Reads | Allowed | — |

**Where it is enforced.** [Proposed] On the server:
- in the claim transaction, for execution: authoritative;
- in the approve and retry routes, through an **unlocked** read of the same comparison. This gives an early, clear refusal; the claim remains the authoritative check.

The interface only shows it; there is no frontend-only control.

**At clearance, in one transaction per installation** [Proposed; the exact rules are decision D2]:
1. **Every current approval in the installation is superseded,** whatever the status of its action. Every `APPROVED` and `PENDING_APPROVAL` action returns to `PROPOSED`, so a fresh review is needed.
   - **Why every approval.** [Phase 0.5 evidence] The prototype's rule superseded only the approvals of `APPROVED` and `PENDING_APPROVAL` actions. An action whose status had been changed by hand to `PROPOSED`, with its approvals left current, kept 2 current approvals through clearance. The application's own routes can't produce that state, but **no approval may survive recovery merely because its action has an unexpected status.**
   - **Consequence:** a `FAILED`/`not_applied` action that is retried after recovery needs fresh approval, because its earlier approvals are superseded too. That is consistent with D2.
2. Every action the journal shows claimed **after the database head** that exists in the database becomes `FAILED` with outcome `unknown`, and a note citing the journal entries. It needs reconciliation, and is never retried automatically.
   - A claim with no `dispatch` line is noted as "not sent", so a person can reconcile it as `not_applied` without checking the target.
   - A claim with a `dispatch` line is noted as "may have been sent: check the target system".
   - A journalled `outcome` or `reconciled` line is shown as evidence for the person. It is never applied automatically.
3. Every `EXECUTING` action becomes `FAILED`/`unknown`.
4. Every `FAILED`/`not_applied` action with a later journal claim becomes `unknown`.
5. Journal claims for action ids the database doesn't have are listed in the clearance audit, with their organisation id, attempt and time. They can't be attached to anything.
6. `InstallationState` is set to the journal's id and head. The `cleared` line is appended and `fsync`ed **before** the transaction commits, so it is never missing after a commit. The audit rows are written in the same transaction.

### 9.1 Clearance at scale (P6)

**Measured** [Phase 0 evidence], with one transaction and the prototype's implementation:

| Actions | Clearance | Inspection | Peak process memory |
|---|---|---|---|
| 1,000 | 33 ms | 49 ms | 87 MB |
| 10,000 | 160 ms | 78 ms | 117 MB |
| 100,000 | 1,693 ms | 519 ms | 389 MB |

Memory grew with size, because inspection loads every affected action into the process, and the actions that ran after the backup were updated one by one.

**Options:**

| | One atomic transaction | Several digest-bound batches |
|---|---|---|
| Atomicity | All rules and every audit row commit together, or nothing does | Each batch commits on its own. Needs a persisted "clearance in progress" record (digest, cursor) and must **block** submit, edit and reconcile until it finishes. Otherwise the inspected state changes between batches |
| Digest consistency | Recomputed once, inside the transaction | Must stay valid across batches. Every route that could change it must be refused for the duration |
| Crash recovery | Nothing changed; run it again ([Phase 0 evidence] E, interrupted) | Resume from the cursor; partial states are visible meanwhile |
| Lock duration | The `InstallationState` lock and the touched action rows, for the whole transaction. During quarantine no claim runs anyway, but other routes touching those rows wait | Short locks per batch |
| Complexity | Low | High: a new blocking state across routes |

**Recommendation** [Proposed; P6, awaiting approval]: **keep one atomic transaction, and make it bounded in memory:**
- compute the inspection digest **in the database** (an ordered, server-side hash over the affected rows) instead of loading them into the process;
- apply every rule as a **set-based** update. The actions that ran after the backup come from the journal, which is streamed into a temporary table in fixed-size chunks;
- audit rows: one per organisation, as now, inserted with one statement.

The process's memory is then bounded by the chunk size, not the installation size. The transaction duration still grows with the number of affected rows.

**Measured with the bounded-memory version** [Phase 0.5 evidence; Docker Desktop, Apple silicon only]. One transaction; the digest computed by PostgreSQL; set-based updates; the journal streamed; two approvals per pending action:

| Actions / organisations | Clearance (one transaction) | Inspection | Process peak memory | A claim attempted during clearance |
|---|---|---|---|---|
| 100,000 / 200 | 0.92 s | 0.18 s | 147 MB | waited 116 ms, then refused |
| 250,000 / 500 | 3.0 s | 0.38 s | 172 MB | waited 2.0 s, then refused |
| 500,000 / 1,000 | 5.5 s | 0.90 s | 197 MB | waited 4.7 s, then refused |
| 1,000,000 / 2,000 | 10.3 s | 1.41 s | 246 MB | waited 9.9 s, then refused |

**Afterwards, at every size:**
- one audit row per organisation, in the same transaction;
- no approval still current, and nothing executable;
- trust restored.

**Waits during the 1,000,000-action clearance:**
- **Claims** wait for the whole clearance.
- **A route** repeatedly locking an affected row waited at most **2.9 s** (median 2 ms).

**Failure tests:** all six scenarios left the database either fully cleared or unchanged:
- killed early;
- killed after the `cleared` record, before commit;
- database session terminated;
- two clearances at once;
- changed after inspection;
- repeated with a used digest.

**Assessment** [Assessment]:
- **Atomicity holds** at every tested size.
- **Process memory** grows with the claims made after the backup, not with the installation.
- **Transaction duration and lock waits** grow roughly linearly. During a quarantine claims are refused anyway, so the main cost is routes on affected rows waiting up to seconds.
- **Organisation count** (tested up to 2,000) costs one audit insert statement.

**One transaction remains the recommendation.** Batching stays the fallback, if production-scale tests show the transaction or lock waits are unacceptable.

**Maximum supported size: not chosen** [pending a product-owner decision]. One million actions is **the largest size tested on one development machine**, not a capacity guarantee. A limit must come from tests on the supported platform, at sizes above the largest expected installation.

## 10. Execution reconciliation workflow

[Proposed] Reconciliation stays the existing per-attempt route. Nothing new decides an outcome automatically.

`recovery inspect` produces, per organisation:
- **Ran after the backup:** journal claims after the database head, with the action, attempt, time and destination digest.
- **Unknown or in flight:** actions `EXECUTING`, or `FAILED` with `unknown`.
- **Ready to run:** actions that were `APPROVED` or retryable at backup time.
- **Unmatched:** journal entries for actions the database lacks.

A person checks each target system and records `applied` or `not_applied` with the existing reconcile route.

Unknown outcomes are never retried automatically; a retry still requires `not_applied`. This is unchanged and verified in `routes.ts:381-399`.

## 11. Operator recovery runbook

1. **Restore** into a new database, as today (`docs/backup-and-restore.md`).
   - Start only PostgreSQL and the API with the state volume attached.
   - Keep the original `.env`.
2. **Execution stays disabled by itself.** [Proposed] The first claim, or the start-up check, finds the mismatch.
3. **Confirm the state:** `npm run recovery -- status` gives the reason and both heads.
4. **Inspect:** `npm run recovery -- inspect` (section 10). It prints an **inspection digest** (N4): the journal head, the database head, and every affected action's id, status, attempts and outcome.

   Then work through the **required settings checklist** (D10 deferred: the journal records none of these, so the review is manual and mandatory):
   - webhook addresses and secrets;
   - approval thresholds and self-approval;
   - memberships, API keys and invitations;
   - organisations removed after the backup (re-run `org:remove`).
5. **Reconcile** every uncertain attempt against the target systems. [Assumption] This needs access to those systems' own logs.
6. **Re-run nothing yet.** Approvals and retries are still refused.
7. **Clear:** `npm run recovery -- clear --digest <inspection digest> --confirm <installation id> --reason "<text>" [--new-installation]`.
   - It is a host command, like `org:remove` (D5). [Verified] There is no installation-wide role in the application (`lib/permissions.ts:38-52`): every permission belongs to one organisation.
   - It recomputes the inspection digest inside its transaction and refuses on **any** difference (N4). That catches reconciliations, submissions and edits made since `inspect`, not only a moved journal head.
   - It applies section 9's rules in one transaction.
   - It records the host user, the reason and the digest in every organisation's audit log and in the `cleared` journal line (D5). The installation-level record is the journal line: [Verified] `AuditLog` requires an organisation.
8. **Verify:** `recovery status` reports trusted. Actions needing approval are visible as `PROPOSED`.
9. **Fresh approval:** people review and approve again; then execution works normally.

**If recovery is interrupted** [Proposed]:
- Nothing before step 7 changes state.
- Step 7 is one database transaction followed by one journal append.
  - If it crashes before commit, nothing changed.
  - The `cleared` line is written before commit. If the process crashes after writing it but before commit, nothing changed in the database and the journal shows an uncommitted clearance; `status` reports it, and `clear` can be run again.
- `status` and `inspect` never write.
- Running `clear` again after a successful clearance is refused by the digest compare-and-set.

**What a person decides and what is automated** [Proposed]:
- **Automated:** detection, refusal, listing, and the state changes at clearance.
- **Human:** whether each external change happened, whether to clear, whether this is a new installation, and every new approval.

## 12. Concurrency and two API instances

Proposed analysis:
- **Claims are serialised** through the `InstallationState` row lock. Execution volume is low: a few per incident. [Assumption] The cost is negligible at that volume.
- **Two API processes on one host** share the volume; the row lock orders their appends.
  - Every journal append happens under the `InstallationState` row lock (P3, section 6.1), so a line is never interleaved and the chain never forks. `flock` is not used. [Phase 0 evidence] Shown with two containers on one host, 626 claims each in two configurations.
  - **Two hosts are not supported** (N10, enforcement deferred): the volume is not shared. Phase 0 tests two containers on one host only, and nothing claims multi-host support.
- **The worker** doesn't dispatch and doesn't need the volume. Starting it during quarantine changes nothing: the sweep still settles `EXECUTING` as `unknown`, which is safe.
- **Recovery against execution:** `clear` takes the same row lock, so a claim and a clearance never interleave.
- **Two operators** running `clear` at once: the compare-and-set lets one succeed and refuses the other.
- **The journal deleted, replaced or altered:**
  - deleting `journal.log` makes it missing, so quarantined;
  - replacing it with a copy older than the database puts it behind, so quarantined;
  - editing a line in the middle breaks the hash chain, so quarantined.
  - **Correction:** truncating the tail back to exactly the database's head after a restore leaves a valid chain and matching heads. It is **not detected**. So is a chain recomputed from the cut onwards. Both need only write access to the state volume, not to the database.
  - A keyed check (N7, deferred) would catch silent edits, not truncation. Only an off-host anchor (D3, deferred) detects truncation.
- **Organisation versus installation:** detection and quarantine are installation-wide. Inspection and audit are per organisation.

## 13. Security analysis

**Every existing guarantee is kept.** [Proposed] The journal check is added to the claim; no existing check is removed or reordered:
- fingerprint validation;
- monotonic risk;
- approval expiry;
- distinct approvers;
- source review;
- destination binding;
- single dispatch;
- unknown handling;
- not-applied before retry;
- transactional audit.

**Lock order.** [Proposed]
- **Today** [Verified]: the action row, then the settings row (shared), then approvals, then the audit insert.
- **Proposed (N5):** **`InstallationState` first**, then the action row, then the settings row (shared), then approvals, then the audit insert.
- **Clearance:** `InstallationState` first, then action rows in a fixed order (by id).
- Claims and clearance take the locks in the same order, so they can't deadlock. The cost is serialising the whole claim installation-wide. [Unverified] Acceptable at the expected volume; Phase 0 measures it.
- Other paths that lock action rows (approve, reject, edit, submit) don't take `InstallationState`. Their quarantine checks are unlocked reads, so they add no new lock order.

**Nothing sensitive in the journal.** [Proposed] It holds ids, fingerprints, destination digests (never addresses), attempts and outcomes. The same rules as span and audit scrubbing apply (`docs/tracing.md`).

**Who can clear (D5).** Whoever can run commands on the host, as for `org:remove` and `backup`. A reason is required, and the host user, reason and digest are recorded. Accountability rests on a self-asserted typed name; there is no installation-wide role in the application to give it to.

**Emergency execution during quarantine (D7).** None. Carry out the change outside OPSILUME and reconcile it afterwards.

**Downgrades (N9).** Code from before this feature ignores the journal entirely. Running older code against the database after this feature is **unsupported**: it removes the protection. This goes in the release notes and the runbook. [Unverified] Whether a start-up check could refuse older code.

## 14. Test plan

[Proposed] All of these use the isolated stack or the API test database, local stand-in webhooks, and temporary state directories.

**API (Vitest, real PostgreSQL):**
1. A backup taken before execution (simulated by copying the database state, or by restoring a dump into a new test database), with the journal kept: claim refused, nothing sent, reason "database behind journal".
2. **A2:** the action `PROPOSED` at backup time, executed after it, then restored. Approve again: refused during quarantine. After clearance, the action is `FAILED`/`unknown` (it is in the journal), not `PROPOSED`.
3. Restore during an in-flight execution: the claim is in the journal, the database is behind, so quarantined. Clearance makes it `unknown`.
4. Restore after an external success: the stand-in received exactly one request, before and after recovery.
5. Restore after a reconciliation: the lost reconciliation leads back to `unknown`, not to retryable.
6. `installation.json` missing; the database row missing; the ids different; the journal truncated **below** the database's head; a line in the middle edited: each quarantined. A truncation exactly to the database's head is **not** detected, and the test documents that (section 12).
7. The two required failure scenarios (section 6):
   - the `claim` append succeeds and the transaction rolls back (a failing audit trigger): `void` written, heads equal, trusted, nothing sent;
   - the commit succeeds and the process is killed before dispatch: `claim` with no `dispatch`, the sweep records `unknown`, and `inspect` reports "not sent".

   Also: a process killed between append and commit is quarantined, then cleared, and a torn final line is handled per N1.
8. Two concurrent claims on two actions: sequences contiguous and the journal ordered, using barriers and `pg_locks` as in `execution-integrity.test.ts`.
9. Two concurrent clearances: one succeeds, one is refused by the compare-and-set.
10. A claim racing a clearance: either order is safe, and nothing is dispatched until trusted.
11. Approve, retry and execute refused during quarantine. Reconcile, propose and cancel allowed.
12. After clearance: a fresh approval executes once. Retry after an explicit `not_applied` works.
13. Migration on a pre-feature database: quarantined, never trusted by default.

**Added after Phase 0** [Proposed]:
14. **P1:** a statement fails after the `claim` append; the `void` is written while the lock is held; no other process can append in between (two processes, barriers); and the chain stays intact.
15. **P2:** a short write on a bounded filesystem leads to no dispatch, a torn tail and refused appends; nothing is truncated or recreated.
16. **P4:** incremental verification detects:
    - a replaced file (new inode);
    - a shrunk file;
    - an edit of the last record;
    - a torn tail;
    - corruption in new bytes;
    - a stale cache in a second process.

    A scheduled full check detects an edit in the middle.
17. **P5:** using the fault proxy, the connection is cut during `COMMIT`, both after a real commit and without one. There is no dispatch in either case. Resolution gives committed (left for the sweep) or not committed (voided). With the database unreachable, the state is left for the comparison.
18. **P6:** clearance runs bounded in memory at sizes above the largest expected installation, on the supported platform, with the lock waits of other routes measured.
19. **P7:** the durability test on native Linux, with a hard reset (section 16.1).
20. **P8:** the integration tests in section 6.5.
21. **Bounded void memory:** a journal with more consecutive voids than the bound fails closed with "head hash unknown"; clearance re-establishes the anchor.
22. **Every approval superseded:** after clearance, no current approval remains on an action in any status.
23. **`COMMIT` classification:** failures before, inside and after the callback are classified as no claim, not committed, and uncertain, against the real driver version.

**Isolated-stack drill (`npm run drill:backup`, extended):**
- back up;
- execute against a stand-in;
- restore into a new database and point the API at it;
- check that execution is refused;
- run `recovery inspect` and `clear`;
- approve again and execute;
- check that the stand-in received exactly the expected requests.

**Worker started during quarantine:** it runs and the sweep works. Nothing is dispatched.

## 15. Migration and backward compatibility

[Proposed]
- **One migration:** the `InstallationState` table, created empty. Nothing else in the schema changes.
- **Upgrading an existing installation** leaves it quarantined until the operator runs `recovery clear --new-installation` or `adopt`. That is a deliberate, one-time step on upgrade (D9). It goes in the release notes.
- **Phases 1 to 3 (section 19) must be released together.** A release containing the check without clearance would quarantine upgraded installations with no way out.
- **A pre-feature backup restored under the new version** is quarantined (Scenario F).
- **The webhook payload is unchanged.** D11 (deferred): adding the journal sequence and installation id to the payload and headers would let receivers detect repeats across installations. It would be a contract change for receivers.
- **Tests, the isolated stack, the demo and the browser tests** provision with `init`.
- **The seed** runs on an empty database, so a fresh Compose install can auto-provision if D9 allows it.

## 16. Operational dependencies and costs

[Proposed]
- **One Docker volume** (`opspilot-state`), mounted into the API and the recovery command.
- **Retention and copies (N6):**
  - journal history is kept for at least as long as the oldest restorable database backup;
  - an **off-host, read-only copy** of the journal is maintained, so that after host loss recovery still has a list of what ran;
  - that copy is used for inspection only. The journal is **never restored together with the database,** and never over a newer journal. Doing either defeats detection.
  - The absolute duration of **backup retention** (and therefore journal retention) is **not chosen here**: it needs product-owner selection.
- **Durability claims (N11, deferred):** see section 16.1. No durability claim is made yet.
- **Losing it means quarantine:** no data is lost, but everything is reviewed.
- **Per execution:** two `fsync`ed appends (`claim` and `dispatch`), plus best-effort `outcome` lines. [Phase 0 evidence] On Docker Desktop (Apple silicon), one append and `fsync` on a Docker volume took p50 0.26 ms and p99 0.56 ms. Claim latency was p50 4.8 ms with two containers and p50 19.2 ms with eight processes; the single lock is the bottleneck. These numbers are not a production estimate.
- **Claims run one at a time** installation-wide.
- **Operator time:** one recovery review per restore, and one clearance on the first upgrade and on every new host.
- **No external service and no paid infrastructure** in the recommended form. An off-host journal (D3) would add one.

### 16.1 Durability and supported platforms (P7)

**What has been measured** [Phase 0 evidence]: `fsync` **latency** only, on Docker Desktop on Apple silicon, where a named volume is ext4 on the virtual machine's virtual disk (`/dev/vda1`).

**What remains unverified:** whether an acknowledged `fsync` reaches stable storage there. A p50 of 0.26 ms through a virtual disk is consistent with the flush stopping at the host's cache. The prototype's own result is **inconclusive**.

**Required before any durability claim** [Proposed; P7, awaiting approval]:
- a test on **native Linux**, with the journal on a **local** filesystem (ext4 or XFS) on a named volume or bind mount, never the container's writable layer;
- a **power-loss or VM-crash test:** append and `fsync` acknowledged, then a hard reset of the machine (not a process kill). Every acknowledged record must be present and the chain intact; any torn tail must follow N1;
- the result recorded with the kernel, filesystem, mount options and storage.

**Status after Phase 0.5:**
- **Native Linux: NOT TESTED.**
- **Power loss or VM crash: NOT TESTED.**
- **Docker Desktop only:** a process kill and a container kill each ended consistent (every committed claim in the journal, heads equal). Neither touches the page cache, so **they prove nothing about physical durability.** A Linux container inside Docker Desktop is not a native Linux test.

**The test still required** [Proposed]:
- **Environment:**
  - a native Linux host, bare metal or a VM whose hypervisor can hard-reset it;
  - the journal on a local ext4 or XFS filesystem (a named volume or bind mount, never the overlay layer);
  - PostgreSQL with `fsync=on` and `full_page_writes=on`.
- **Recorded:** the distribution, kernel, filesystem, mount options, storage device, write-cache setting and Docker version.
- **Procedure:**
  1. Run claims in a loop. After each claim commits, send its sequence number to a recorder **off the machine** (another host), so acknowledgements survive the crash.
  2. Cut power at a random moment: the hypervisor's hard reset or power-off, or on bare metal a power cut. `echo b > /proc/sysrq-trigger` is only an approximation, because it skips power loss to the disk cache.
  3. Reboot, start PostgreSQL and the application, and run a full verification.
  4. Repeat at least 20 times, including during a burst of claims.
- **Expected results:**
  - every claim acknowledged off the machine is present in the journal **and** committed in the database;
  - the journal's chain is valid, and a torn tail, if any, follows N1;
  - the heads are equal, or the journal is one claim ahead (quarantine, per the crash table);
  - nothing is ever "committed in the database but missing from the journal".

**Physical durability remains a production blocker until this passes.**

**Claims that can't be made yet:**
- durability on any platform;
- support for network filesystems (NFS, SMB);
- Docker Desktop (macOS or Windows) as anything but development;
- the container overlay as journal storage;
- multi-host.

## 17. Remaining risks

**Accepted risks** (from the deferred decisions D3, D10 and D11; the owner has accepted them, not mitigated them):
- **D3:** without an off-host anchor, a rollback or copy of both volumes, or a truncation by someone with host access, is undetected.
- **D10:** settings and memberships rolled back by a restore are found only by the manual checklist in section 11.
- **D11:** receivers get no installation id or journal sequence to detect repeats themselves.

**Other risks:**
- **A snapshot that rolls back the database volume and the state volume together** (a VM snapshot, a host-level backup of all volumes) is **not detected**. Both sides agree. [Proposed] Mitigations:
  - the runbook forbids restoring `opspilot-state` from the same snapshot as `pgdata`;
  - an off-host copy of the journal head (D3).
- **Re-proposal (A3).** An action created and executed after the backup is gone. The same change can be proposed again under a new id. The journal lists the old id at inspection, but nothing prevents a person from proposing and approving the same change. [Unresolved] Matching by content fingerprint was considered: it would refuse legitimate repeats.
- **Host loss** loses the local journal: quarantine. The off-host read-only copy (N6) gives a list of what ran, up to the time of its last copy. Executions after that copy need a full manual reconciliation against external systems.
- **A clone that copies both volumes** is never quarantined (N8 operator rule; detection needs D3).
- **Truncation** of the journal back to the database's head is undetected (section 12).
- **Downgrades** remove the protection (N9), unless the proposed database guard (P8) is adopted. Even with it, an owner-role connection can bypass it (section 6.5).
- **Receivers** that don't deduplicate stay exposed to any repeat that gets past OPSILUME.
- **Settings and memberships rolled back by a restore** are not detected by the journal (D10).
- **False quarantines:** a crash between the `claim` append and commit, an unknown commit result, or a failed `void` write. They are safe but cost an operator review.
- **Single host only** (D3).

## 18. Decisions

Recorded on 16 November 2026. "Approved in principle" means approved as design direction, with the conditions shown. Nothing is implemented, and Phase 0 must confirm the technical assumptions first. The decision wording in the first column is unchanged from the original design. N-items come from the decision review.

| # | Decision | Status | Conditions or accepted risk |
|---|---|---|---|
| D1 | Disable all remediation execution installation-wide while history is untrusted | **Approved in principle** | — |
| D2 | At clearance, supersede all approvals and return `APPROVED`/`PENDING_APPROVAL` actions to `PROPOSED`; allow submission during quarantine | **Approved in principle** | The interface warns that approvals gathered during quarantine are discarded at clearance |
| D3 | Require an off-host or external journal (protects against host loss and full snapshots; adds a dependency) | **Deferred** | Accepted risk: snapshot and clone rollback, and truncation, are undetected (section 17). Revisit after the RPO decision (audit M1) |
| D4 | Store the installation identity on a dedicated Docker volume (rather than `.env` or Redis) | **Approved in principle** | The clone limitation (N8) is documented |
| D5 | Who may clear: host operators by command only, or also a signed-in confirmation | **Approved in principle:** host command only | A required reason; the host user, reason and inspection digest recorded in every organisation's audit and the journal |
| D6 | Allow read-only diagnostics and the webhook ping during quarantine | **Approved in principle** | — |
| D7 | Any emergency execution during quarantine | **Approved in principle:** none | — |
| D8 | Treat "new installation / clone" differently from "same installation recovered" (new id; webhook addresses removed) | **Approved in principle** | Operator rule N8 |
| D9 | Auto-provision a truly fresh install (empty database, empty volume) in `migrate`; require an explicit step on upgrade | **Approved in principle** | The emptiness check and the row creation are in one transaction; the upgrade step goes in the release notes |
| D10 | Also journal settings changes (webhook address, thresholds) so a restore's rollback of them can be listed | **Deferred** | Accepted risk; the settings checklist in the runbook is mandatory |
| D11 | Send the journal sequence and installation id to receivers | **Deferred** | Accepted risk; no receiver contract change |
| N1 | Torn final line and corrupted journal handling | **Approved in principle** | A torn final line is treated as absent and repaired only by tooling; earlier corruption means quarantine, recovered only through clearance with an explicit "journal unreadable" acknowledgement and a full manual review |
| N2 | A `dispatch` line before the first byte is sent; journal outcomes and reconciliations | **Approved in principle** | `dispatch` records intent, not external execution; `outcome` and `reconciled` are evidence, never applied automatically |
| N3 | A separate break-glass re-baseline for an unreadable journal | **Deferred** | N1's acknowledgement covers it for now |
| N4 | Bind clearance to an inspection digest | **Approved in principle** | — |
| N5 | `InstallationState` locked first in every claim | **Approved in principle** | Phase 0 measures the cost of serialising whole claims |
| N6 | Journal retention and copies | **Approved in principle** | Kept at least as long as the oldest restorable backup; an off-host read-only copy; never restored with the database. Backup retention duration: **requires product-owner selection** |
| N7 | Keyed integrity check (HMAC) for the journal | **Deferred** | — |
| N8 | Never copy the state volume into a clone | **Approved in principle** | An operator rule; detection needs D3 |
| N9 | Downgrades after this feature unsupported | **Approved in principle** | Release notes and runbook; a start-up refusal is to be investigated |
| N10 | Enforcing a single API host | **Enforcement deferred** | Phase 0 prototypes two-container locking on one host; no multi-host support is claimed |
| N11 | Supported platforms for the durability claim | **Deferred** | No broad durability claim until tested |
| — | Retention of the journal and of clearance records | See N6 | — |
| — | Backup retention duration | **Requires product-owner selection** | No absolute duration is chosen here |

**New technical decisions raised by Phase 0.** These are engineering recommendations, **not approvals:**

| # | Decision | Status | Recommendation |
|---|---|---|---|
| P1 | Append `void` under a savepoint taken after the `InstallationState` lock (section 6, step 5) | **Awaiting approval** | Adopt: required for the chain to stay intact (Phase 0 B1) |
| P2 | Treat every short write as a journal failure, with no dispatch and no truncation (section 6) | **Awaiting approval** | Adopt: required (Phase 0 A) |
| P3 | The single journal mutex: the `InstallationState` row lock, not `flock` (section 6.1) | **Awaiting approval** | The row lock |
| P4 | Incremental verification, with the head hash anchored in the database (section 6.2) | **Awaiting approval** | Adopt; design to be tested; the database anchor is a schema addition |
| P5 | Unknown commit handling: resolve when reachable, otherwise fail closed; never dispatch after an uncertain commit (section 6.3) | **Awaiting approval** | Adopt; fault-proxy testing required |
| P6 | Clearance in one bounded-memory transaction; batching only as a fallback; maximum size not yet chosen (section 9.1) | **Awaiting approval** | Adopt; measure on the supported platform |
| P7 | Durability: native Linux, a local filesystem, and a power-loss or VM-crash test before any claim (section 16.1) | **Awaiting approval** | Adopt |

**Raised by Phase 0.5.** These are also engineering recommendations, **not approvals:**

| # | Decision | Status | Recommendation |
|---|---|---|---|
| P8 | A database guard refusing any entry into `EXECUTING` not made through the journal protocol, created in the same migration as `InstallationState` (section 6.5) | **Awaiting approval** | Adopt. The prototype trigger is a demonstration; production needs the integration tests in section 6.5 |
| P8a | Separate the migration (owner) role from the runtime role, so the application can't disable the guard | **Awaiting approval** | Adopt, as part of, or before, P8 |
| P8b | An audited emergency procedure to remove the guard when the application is incompatible | **Awaiting approval** | None (consistent with D7): upgrade the application instead |
| V1 | Bounded void memory: 64 remembered claims; fail closed beyond (section 6.2.1) | **Awaiting approval** | Adopt |
| V2 | The full-verification schedule (section 6.2.2) | **Awaiting product-owner decision** | Background, time-based, plus mandatory events; daily suggested as a starting point, not chosen |
| V3 | Clearance supersedes every current approval, whatever the action's status (section 9) | **Awaiting approval** | Adopt |

**Still awaiting the product owner:**
- the backup retention duration;
- acceptance of the coordinated-snapshot and truncation risks;
- the maximum supported installation size;
- the full-verification interval (V2);
- final approval of this revised design;
- the production implementation scope.

## 19. Implementation milestones

[Proposed] Order and scope only; nothing started.

### Phase 0: prototype on the isolated stack

**Status: run on 16 November 2026.** Results: [post-restore-remediation-safety-phase0-prototype-report.md](post-restore-remediation-safety-phase0-prototype-report.md). The prototype code is on the branch `prototype/m16-recovery-safety-phase0` and is not merged. Its findings are taken into this revision (P1 to P7).

The scope it was run against, kept as written:

A time-boxed prototype in a throwaway branch, on the isolated stack only, against local stand-in webhooks. It produces measurements and a revised design, **not production code**. Nothing from it is merged.

**Scope and what each measurement must produce:**

| Measurement | Method | Output |
|---|---|---|
| `fsync` latency | Claim latency with zero, one and two `fsync`ed appends, on Linux (CI runner) and on Docker Desktop (macOS) | p50, p95 and p99 per platform, and the number of runs. No conclusion beyond the platforms measured (N11) |
| Two-container file locking | Two API containers on one host sharing the state volume, concurrent claims, `flock` around appends | Contiguous sequences, no interleaved or torn lines over many concurrent claims, and claim throughput with two containers. One host only (N10) |
| Torn-tail handling | The writer is killed mid-append, and the disk is filled during an append | The N1 rule handles both: the torn line is treated as absent, nothing was committed for it, and the next claim proceeds or quarantines as the rule says |
| Dispatch lifecycle | Faults injected at each point: before `claim`, between `claim` and commit, an unknown commit result (TCP fault proxy), between commit and `dispatch`, between `dispatch` and sending, after sending | For each: the journal lines present, the database state, whether quarantine follows, and that a request is never sent without both a `claim` and a `dispatch` line |
| Large clearance duration | A clearance over a database with many organisations and actions (the sizes are recorded with the result) | Transaction duration and lock wait for concurrent claims; whether one transaction is acceptable |

**Acceptance criteria for Phase 0:**
- every measurement above is recorded, with the method and environment;
- no request reaches the stand-in webhook without a `claim` and a `dispatch` line, in any injected fault;
- the two required failure scenarios (section 6) behave as the crash table says;
- the design is revised where a measurement contradicts it;
- the prototype branch is discarded.

### Phase 0.5: validation on the isolated stack

**Status: run on 16 November 2026.** Results: [post-restore-remediation-safety-phase05-validation-report.md](post-restore-remediation-safety-phase05-validation-report.md); code on `prototype/m16-phase05-validation`, not merged.
- **P4, P5, P6: passed** in the prototype, up to 1,000,000 records and actions.
- **Downgrade:** a gap was found (P8).
- **P7: native Linux and power loss NOT TESTED.**

### Phases 1 to 4

1. **Journal, detection and provisioning.**
   - The volume, and `installation.json` and `journal.log`, with the hash chain, file lock, directory `fsync`, torn-tail rule (N1) and the `dispatch`, `outcome` and `reconciled` lines (N2).
   - The `InstallationState` migration (created empty), with the lock taken first (N5).
   - The check inside `claimExecution`, a new `quarantined` claim result, and the refusal audit.
   - `recovery init` and `status`.
   - **Provisioning** in the API tests, the isolated stack, the demo, the browser tests and the drills. They all execute remediations on fresh databases and would otherwise be quarantined.
   - Tests 1, 6, 7, 8 and 13.
2. **Quarantine across routes.**
   - The approve and retry refusals (unlocked reads).
   - The start-up check, the read-only status endpoint and the interface banner, with the D2 warning.
   - Tests 2 and 11.
3. **Inspection and clearance.**
   - `recovery inspect` with the inspection digest (N4), and `clear` with the digest compare-and-set, the required reason (D5) and the section 9 rules.
   - The new-installation path (D8).
   - Tests 3, 4, 5, 9, 10 and 12.
4. **Drill and runbook.**
   - The extended backup drill on the isolated stack.
   - A second drill that restores both volumes from the same moment and records that it is **not** detected (an accepted-risk record).
   - The runbook in `docs/backup-and-restore.md`: the settings checklist (D10), the clone rule (N8), journal copies and retention (N6), and the downgrade policy (N9).

**Release gate.** Phases 1 to 3 may merge to `develop` separately, but no release may contain phase 1 without phase 3.

**Phase 1 now includes:**
- P1 to P5: the savepoint and void, the short-write check, the row-lock mutex for every append, incremental verification with the database head anchor, and the unknown-commit handling;
- the bounded void memory (V1);
- the P8 guard, in the same migration as `InstallationState`, with role separation (P8a) if approved.

**Phase 3 includes:**
- P6, with every approval superseded (V3);
- the scheduled full verification (V2), once its interval is chosen.

**Optional, after decisions:**
- an off-host journal anchor (D3);
- settings journaling (D10);
- receiver headers (D11);
- a keyed integrity check (N7);
- a break-glass re-baseline (N3).

### Production readiness gate

Production implementation can't be authorised until every item is complete. Three things are tracked separately:
- **Design:** is it specified?
- **Prototype:** was it validated in Phase 0 or 0.5? Docker Desktop on Apple silicon only.
- **Production integration:** was it tested in the real application? Nothing has been, since nothing is implemented.

| # | Gate | Design | Prototype validation | Production integration testing |
|---|---|---|---|---|
| 1 | Final design approved | Revised (this document) | — | — (**awaiting the product owner**) |
| 2 | P1: savepoint behaviour | Specified (§6) | Passed (Phase 0, two containers) | Not done |
| 3 | P2: short-write handling | Specified (§6) | Passed (Phase 0, full disk) | Not done |
| 4 | P3: database row lock as the journal mutex | Specified (§6.1) | Passed (Phase 0 and 0.5, one host) | Not done |
| 5 | P4: incremental verification, and the full-verification schedule | Specified (§6.2); **schedule pending (V2)** | Passed up to 1,000,000 records (Phase 0.5) | Not done |
| 6 | P5: unknown `COMMIT` resolution | Specified (§6.3), with failure classification | Passed, 5 wire-protocol scenarios (Phase 0.5) | Not done (the real driver mapping) |
| 7 | P6: clearance, and invalidating every approval | Specified (§9, §9.1) | Clearance passed up to 1,000,000 actions; the every-approval rule (V3) **not yet tested** | Not done |
| 8 | P7: native Linux durability | Specified (§16.1) | **NOT TESTED** | **NOT TESTED** |
| 9 | P8: database-enforced downgrade protection | Specified (§6.5); **awaiting approval** | Passed as a demonstration trigger (Phase 0.5) | Not done (integration tests listed in §6.5) |
| 10 | Bounded void memory (V1) | Specified (§6.2.1) | Bound used; the fail-closed path **not exercised** | Not done |
| 11 | Recovery and clone restrictions (D8, N8) | Specified (§7, §11) | Not tested (the new-installation path wasn't built) | Not done |
| 12 | Backup retention selected | — | — | — (**awaiting the product owner**) |
| 13 | Accepted risks explicitly approved: coordinated snapshot, truncation | Documented (§17) | Truncation shown undetected (Phase 0, case 15) | — (**awaiting the product owner**) |
| 14 | Maximum installation size selected | — | Evidence up to 1,000,000 actions on one development machine | — (**awaiting the product owner**) |
| 15 | Production implementation scope explicitly approved | — | — | — (**awaiting the product owner**) |

---

**Files read for this design:**
- `apps/api/src/modules/remediation/` (`approvals.ts`, `routes.ts`, `execution.ts`, `recording.ts`, `safeguards.ts`, `content.ts`, `source.ts`, `proposals.ts`);
- `apps/api/src/lib/audit.ts`, `lib/permissions.ts`, `lib/removeOrganization.ts`;
- `apps/api/src/modules/system.ts`, `modules/integrations.ts`;
- `apps/api/src/queues/index.ts`, `src/worker.ts`, `src/server.ts`;
- `apps/api/prisma/schema.prisma`;
- `scripts/backup.mjs`, `backup-restore-drill.mjs`, `reliability-drills.mjs`;
- `docker-compose.yml`;
- `docs/backup-and-restore.md`, `docs/recovery-readiness-audit.md`;
- `apps/web/e2e/opspilot.spec.ts`, `demo/scripts/e2e.mjs`.

**What was not done:** nothing was executed, restored or changed. This is not a claim of pilot or production readiness.
