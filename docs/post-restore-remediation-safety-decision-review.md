# Post-restore remediation safety: decision review

Milestone 16, design review. An independent review of [post-restore-remediation-safety-design.md](post-restore-remediation-safety-design.md) (referred to below as **the design**). It prepares the product-owner decisions and challenges the proposed external execution journal.

The initial review was made against the **original design**, read in full (SHA-256 `baf0a298…d231522`). The design has since been revised to take in the review's findings and the product owner's decisions. Where this document describes a finding, it is a finding against the original design; section 1 states where each one stands in the revised design.

Nothing here is implemented or prototyped. Decisions were recorded **in principle** on 16 November 2026 (see "Decision outcome"). That is approval of design direction, not authorisation to implement in production.

**Tags used throughout:**
- **[Repo]:** verified behaviour of the repository at `develop` `11cf150`.
- **[Design]:** what the design proposes.
- **[Assessment]:** this review's technical judgement.
- **[Unverified]:** an assumption that needs a prototype or a test.

## 1. Executive recommendation

**Keep the direction.** [Assessment] The design's core idea is right: a record of executions outside PostgreSQL, compared at every execution claim, failing closed on any disagreement. It is the only candidate that addresses scenario A2 (an action proposed before the backup and executed after it). [Design] Approval invalidation alone cannot.

**Findings of the initial review (against the original design).** [Assessment] The original design was not ready to implement as written. The initial review found seven gaps that would have made it either bypassable or unworkable in practice. They are kept here as review history.

The table gives each finding and the **revised design's current position**. "Addressed" means the revised design specifies a rule for it; nothing is implemented. "Accepted risk" means the limit remains and is documented.

| # | Initial finding (original design) | Current position in the revised design |
|---|---|---|
| 1 | **Bypass: truncation defeats detection.** Cutting the journal back to the database's head leaves a valid hash chain and matching heads (section 4) | **Accepted risk, still undetected.** The overstatement is corrected and the limit documented; only an off-host anchor (D3, deferred) detects it. Design §12, §17 |
| 2 | **Bypass: a clone that copies both volumes is never quarantined,** and can dispatch to production's webhook (section 6) | **Accepted risk, still undetected.** Operator rule N8: never copy the state volume into a clone. Design §7, §17 |
| 3 | **Missing information: after a restore, a `claim` line alone cannot say whether the request was sent,** so every such entry needs manual reconciliation (section 4, D) | **Addressed by the `dispatch` line (N2).** A claim without a `dispatch` line was certainly not sent. A `dispatch` line records **dispatch intent, not confirmed external execution.** Design §6 |
| 4 | **Rule not specified: the clearance compare-and-set does not cover changes made between inspection and clearance** (section 7) | **Addressed by the inspection digest (N4),** recomputed inside the clearance transaction. Design §11, step 7 |
| 5 | **Rule not specified: torn trailing lines,** and a commit whose result is unknown (section 4) | **Addressed:** the torn-tail rule (N1) and the unknown-commit rule (no `void`, no dispatch). Design §6 |
| 6 | **Rule not specified: taking the new lock last creates a claim/clearance deadlock** that taking it first would avoid (section 5) | **Superseded.** The revised design takes `InstallationState` **first** in every claim and in clearance (N5), so the two can't deadlock. The deadlock described applied only to the original lock order. Design §6, step 1; §13 |
| 7 | **Rollout: the phases as ordered would quarantine every test, stack and upgraded installation** before any way to clear exists (section 9) | **Addressed:** provisioning moved into phase 1, and a release gate makes phases 1 to 3 ship together. Design §19 |

Sections 3 to 9 below keep the initial review's analysis as it was written. Read them with this table, the "Decision outcome" section, and design §18 and §19 for the current position.

**Next step.** [Assessment] Suitable to proceed to a **time-boxed prototype on the isolated stack** (Phase 0, design §19). The owner has now decided D1–D11 and N1–N11 (see "Decision outcome"). The prototype should establish:
- the `fsync` cost;
- locking behaviour;
- torn-tail handling;
- the dispatch marker.

The revised design now contains these changes. It should not proceed to production implementation until the Phase 0 results are in, and the product owner has approved the design as revised by them.

## Decision outcome (16 November 2026)

The product owner decided as follows. Both documents were updated to match; the design's section 18 holds the full record.

| Status | Decisions |
|---|---|
| **Approved in principle, with the conditions discussed** | D1, D2, D4, D5, D6, D7, D8, D9; N1, N2, N4, N5, N6, N8, N9 |
| **Deferred, with the accepted risks documented** | D3, D10, D11 |
| **Deferred** | N3, N7 |
| **Enforcement deferred:** two-container locking is prototyped on one host, and no multi-host support is claimed | N10 |
| **Deferred:** no broad durability claim until tested | N11 |
| **Journal retention** | At least as long as the oldest restorable database backup; an off-host read-only copy; never restored together with the database |
| **Backup retention duration** | **Requires product-owner selection:** no absolute duration is chosen |

**Changes made to the design as a result:**
- the hash-chain overstatement is corrected;
- the claim about uncommitted claims is corrected;
- the two required failure scenarios are added to its crash table;
- the `dispatch` line is defined as **dispatch intent, not confirmed external execution**;
- the lock order is changed to `InstallationState` first;
- the inspection digest, required reason and mandatory settings checklist are added;
- provisioning moves into phase 1, with a release gate for phases 1 to 3;
- the Phase 0 prototype is added with its acceptance criteria.

## Phase 0 evidence and revised recommendations (16 November 2026)

The isolated prototype was run, and its results are in [post-restore-remediation-safety-phase0-prototype-report.md](post-restore-remediation-safety-phase0-prototype-report.md). This section records, for each decision it touched:
- what was previously approved in principle;
- what Phase 0 showed;
- the revised **engineering** recommendation.

**No status changes here.** Every decision keeps the status given in "Decision outcome" above, and every new decision awaits explicit product-owner approval. Phase 0 ran on one Docker Desktop installation on Apple silicon; nothing below is production-validated.

### Decisions affected by Phase 0

| Decision | Previously (in principle) | New evidence from Phase 0 | Revised recommendation | Status |
|---|---|---|---|---|
| N1 (torn tail and corruption) | Approved | 13 of the 14 damage cases refused the claim; the 14th (case 15, a journal truncated exactly to a restored database's head) was trusted, which is the accepted risk. A torn tail was ignored, appends were refused until repair, and repair kept the fragment (nothing truncated). A full disk produced a torn tail by a **short write** | Keep N1. Define the repair record format (design §6), and add P2 | Unchanged: approved in principle |
| N2 (dispatch record, outcomes, reconciliations) | Approved | S3: a dispatch record with **no** request received. S6b: a journal `applied` while the database was `unknown` | Keep: dispatch is intent, outcomes are evidence only (design §6.4) | Unchanged: approved in principle |
| N4 (inspection digest) | Approved | A stale digest was refused; two concurrent clearances resulted in one success; an interrupted clearance invalidated the old digest | Keep. Include the journal's last record hash in the digest (design §6, §9.1) | Unchanged: approved in principle |
| N5 (`InstallationState` locked first) | Approved | No deadlocks: claims against claims, and claims against a clearance holding the lock 3 s (B5) | Keep, and make the same lock the single journal mutex (P3) | Unchanged: approved in principle |
| N10 (single API host) | Enforcement deferred | Two containers on **one** host were correct with the row lock. `flock` releases only if no child inherited the descriptor | Keep deferred. No multi-host claim | Unchanged: enforcement deferred |
| N11 (durability claims) | Deferred | `fsync` p50 0.26 ms on Docker Desktop. **Inconclusive:** it may stop at the host cache | Keep deferred, and make native Linux plus a power-loss or VM-crash test a precondition (P7) | Unchanged: deferred |
| D3 and N7 (off-host anchor; keyed integrity) | Deferred, accepted risks | Case 15: a journal truncated exactly to a restored database's head was **trusted**. That is the accepted risk, shown in practice | Keep deferred; the accepted risk is now demonstrated, not just argued | Unchanged: deferred |
| N8 (no state volume in clones) | Approved | Not tested (equivalent to case 15) | Keep | Unchanged: approved in principle |

### New technical decisions raised by Phase 0

Each is an engineering recommendation awaiting explicit product-owner approval. The details are in the design sections cited.

| # | Decision | Phase 0 basis | Recommendation | Status |
|---|---|---|---|---|
| P1 | Savepoint-based `void` handling | A failed statement released the lock. The chain forked in both first two-container runs, and B1 saw 266 spurious refusals. With the savepoint, both runs were clean | Adopt (design §6, step 5) | **Awaiting approval** |
| P2 | Short-write protection | `fs.writeSync` wrote 343 of 461 bytes on a full disk without throwing | Adopt (design §6) | **Awaiting approval** |
| P3 | Journal mutex | Row lock: 626 claims, intact, no deadlocks. `flock`: the inherited-descriptor hazard | The `InstallationState` row lock; no `flock` (design §6.1) | **Awaiting approval** |
| P4 | Incremental verification | Full verification took 162 ms per claim at 100,000 records | Per-process cache, inode and shrink checks, re-hash of the last record, mandatory full checks, the head hash anchored in the database (design §6.2) | **Awaiting approval** (not prototyped) |
| P5 | Unknown commit result | Not tested | Resolve by reading the locked database state; otherwise fail closed; never dispatch after an uncertain commit; no automatic "heal" (design §6.3) | **Awaiting approval** (needs fault-proxy testing) |
| P6 | Large-installation clearance | 100,000 actions: 1.7 s, 389 MB in one transaction | One transaction, bounded in memory (digest in the database, set-based updates, journal streamed in chunks); batching as a fallback; no maximum size chosen (design §9.1) | **Awaiting approval** |
| P7 | Native Linux durability validation | Docker Desktop only; inconclusive | A native Linux, local-filesystem, power-loss or VM-crash test before any durability claim (design §16.1) | **Awaiting approval** |

**Accepted risks and deferred items, unchanged:**
- **Coordinated snapshot or journal truncation:** undetected, now demonstrated (case 15).
- **Off-host journal anchor (D3):** deferred. The off-host read-only copy (N6) informs recovery after host loss. It doesn't detect anything.
- **Keyed integrity (N7):** deferred.
- **No multi-host guarantee (N10).**

**Retention:** unchanged.
- The journal is kept at least as long as the oldest restorable database backup.
- The off-host copy is read-only.
- The journal is never restored together with the database.
- The **absolute backup retention duration is still awaiting product-owner selection.**

**Readiness gate:** design §19, "Production readiness gate".

## 2. D1–D11 decision table

The decision wording is quoted exactly from the design's section 18. "Alternatives" are those the design itself describes. Each **Final decision** line records the product owner's decision of 16 November 2026. "Approved in principle" means approved as design direction, with conditions; nothing is implemented, and Phase 0 must confirm the technical assumptions first.

### D1. "Disable all remediation execution installation-wide while history is untrusted"
- **Recommendation (design):** Yes.
- **Alternatives (design):** none stated. An organisation-level quarantine is implied against: the design calls the scope installation-wide because "a restore affects every organisation at once" (§9).
- **Security impact:**
  - Yes keeps the core invariant.
  - Any narrower scope needs a per-organisation history, which the design doesn't have.
- **Operational impact:** every organisation loses execution (webhook and manual) until clearance. Teams carry out urgent changes outside OPSILUME and reconcile afterwards.
- **If wrong:** a narrower scope would let a restored organisation re-dispatch (C1 reopened). Too wide only costs time.
- **Assessment:** Accept.
- **Final decision:** **Approved in principle** (16 November 2026).

### D2. "At clearance, supersede all approvals and return `APPROVED`/`PENDING_APPROVAL` actions to `PROPOSED`; allow submission during quarantine"
- **Recommendation (design):** "Yes; yes, superseded at clearance".
- **Alternatives (design):** §9 marks submission during quarantine as unresolved. The implied alternative is to refuse submission.
- **Security impact:** superseding everything is the conservative choice. Approvals given before the restore can't count after it, without knowing which were acted on.
- **Operational impact:**
  - every pending approval must be given again;
  - submission during quarantine lets work queue up, but those approvals are superseded too, so the work is redone.
- **If wrong:** keeping restored approvals reopens scenario A.
- **Assessment:** Accept the supersession. **Modify** submission: allowing it is fine, but the interface must say any approval gathered now will be discarded. Otherwise approvers waste effort.
- **Final decision:** **Approved in principle**, with the condition that the interface warns approvals gathered during quarantine are discarded.

### D3. "Require an off-host or external journal (protects against host loss and full snapshots; adds a dependency)"
- **Recommendation (design):** "Not now: local volume first, revisit after the RPO decision (audit M1)".
- **Alternatives (design):** a local volume (recommended) or an off-host store (§5 table).
- **Security impact:**
  - **Without it, three cases stay undetected:**
    - snapshots that roll back both volumes;
    - full-volume clones (section 6);
    - deliberate truncation by someone with host access.
  - **And host loss erases the list of what ran after the backup.**
  - **With it:** each execution depends on a reachable external store. If it is down, executions are refused, which fails closed.
- **Operational impact:** an extra service to run and secure. The design also states that it needs explicit approval.
- **If wrong:** with local-only, the undetected cases remain silent rather than failing closed.
- **Assessment:** **Defer**, as recommended, but record the gaps this leaves as **accepted risks**, not mitigated ones.
- **Final decision:** **Deferred.** The gaps it leaves are recorded as accepted risks (design §17).

### D4. "Store the installation identity on a dedicated Docker volume (rather than `.env` or Redis)"
- **Recommendation (design):** Yes.
- **Alternatives (design):** `.env`, Redis or off-host (§5).
- **Security impact:**
  - **Redis:** a routine loss would quarantine (verified as routine and drilled).
  - **`.env`:** static; it travels with clones as readily as volumes do.
  - **A volume:** copied by any full-volume clone.
- **Operational impact:** one more volume to provision and to back up deliberately (N6).
- **If wrong:** identity alone never decides trust; the journal comparison does. So the choice mostly affects clone handling.
- **Assessment:** Accept, with the clone limitation in section 6 recorded.
- **Final decision:** **Approved in principle**, with the clone limitation documented.

### D5. "Who may clear: host operators by command only, or also a signed-in confirmation"
- **Recommendation (design):** "Host command only, until an installation-level role exists".
- **Alternatives (design):** adding a signed-in confirmation.
- **Security impact:** [Repo] there is no installation-wide role (`lib/permissions.ts:38-52`). With a host command, accountability is the host user plus a typed name, which is self-asserted.
- **Operational impact:** recovery needs someone with host access; consistent with `org:remove` and `backup`.
- **If wrong:** a single person with host access can clear alone. But that person can also edit the database, so a second factor in the application adds accountability, not prevention.
- **Assessment:** Accept, and **modify:** have the command require a reason text, and record the host user, the reason and the inspection digest (N4) in every organisation's audit log and in the journal.
- **Final decision:** **Approved in principle:** host command only, with a required reason and the host user, reason and inspection digest recorded.

### D6. "Allow read-only diagnostics and the webhook ping during quarantine"
- **Recommendation (design):** Yes.
- **Alternatives (design):** refuse them (§9 marks both unresolved).
- **Security impact:**
  - [Repo] the ping carries no action (`integrations.ts:441-470`);
  - diagnostics are recorded by a person and never dispatched (`execution.ts:33-37`).
- **Operational impact:** helps recovery: checking the receiver is reachable, and recording findings.
- **If wrong:** negligible.
- **Assessment:** Accept.
- **Final decision:** **Approved in principle.**

### D7. "Any emergency execution during quarantine"
- **Recommendation (design):** No.
- **Alternatives (design):** none described. A break-glass path is implied against.
- **Security impact:** any break-glass path is a bypass of the invariant, and would be the one most likely to be used under pressure on exactly the uncertain actions.
- **Operational impact:** urgent changes are made outside OPSILUME, then reconciled.
- **If wrong:** a re-dispatch during recovery.
- **Assessment:** Accept.
- **Final decision:** **Approved in principle:** no emergency execution.

### D8. "Treat "new installation / clone" differently from "same installation recovered" (new id; webhook addresses removed)"
- **Recommendation (design):** Yes.
- **Alternatives (design):** clear clones like any other installation.
- **Security impact:**
  - Removing webhook addresses prevents a test clone from sending signed requests to production.
  - **It only applies to clones that are quarantined.** A clone made by copying both volumes is never quarantined (section 6), so the operator must choose the path deliberately.
- **Operational impact:** webhook addresses and secrets must be re-entered on the new installation.
- **If wrong:** a clone left with production addresses can change production.
- **Assessment:** Accept, and **modify:** document "never copy `opspilot-state` into a clone" as an operator rule, and say plainly that a copy-everything clone isn't detected (N8).
- **Final decision:** **Approved in principle**, with operator rule N8.

### D9. "Auto-provision a truly fresh install (empty database, empty volume) in `migrate`; require an explicit step on upgrade"
- **Recommendation (design):** "Yes; yes".
- **Alternatives (design):** always require an explicit step (implied by §7, where provisioning is "never run by the application on its own" except under D9).
- **Security impact:** auto-provisioning is safe only on a database that has never held an organisation. [Design] §7 conditions it on exactly that.
  - [Assessment] The condition must be checked in the same transaction that creates the `InstallationState` row. Otherwise a restore and an auto-provision could interleave.
- **Operational impact:** upgrading an installation that has history makes it quarantined until an operator adopts it. That one-time step must be in the release notes.
- **If wrong:** auto-provisioning a restored database would trust it silently (C1 reopened).
- **Assessment:** Accept, with the same-transaction check.
- **Final decision:** **Approved in principle**, with the emptiness check and row creation in one transaction.

### D10. "Also journal settings changes (webhook address, thresholds) so a restore's rollback of them can be listed"
- **Recommendation (design):** "Later: useful, not needed for C1".
- **Alternatives (design):** journal them now.
- **Security impact:** [Repo] a restore brings back old webhook addresses, thresholds and memberships. Destination binding still passes because both roll back together. Without journaling, the operator reviews them by hand.
- **Operational impact:** more journal line types, and a larger inspection.
- **If wrong:** a revoked person or an old address stays active after recovery until someone notices.
- **Assessment:** Defer, but make the manual review of settings and memberships a **required** runbook step with a checklist, not an optional one.
- **Final decision:** **Deferred.** Accepted risk; the settings checklist is mandatory.

### D11. "Send the journal sequence and installation id to receivers"
- **Recommendation (design):** "Later: it changes the receiver contract".
- **Alternatives (design):** send them now.
- **Security impact:** it would let a receiver that keeps state refuse a repeat across installations. It is defence in depth that OPSILUME can't rely on.
- **Operational impact:** a contract change for every receiver; versioning needed.
- **If wrong:** none for OPSILUME's own guarantee.
- **Assessment:** Defer.
- **Final decision:** **Deferred.** Accepted risk.

### Retention: "Retention of the journal and of clearance records"
- **Recommendation (design):** keep indefinitely (small). Decide alongside backup retention (audit M3).
- **Assessment:** **modify** into N6 (section 8).
  - The journal must cover at least the age of the oldest backup that might be restored. Otherwise a restore of a very old backup finds the journal's early lines already removed.
  - Removing lines also breaks a simple hash chain unless the cut is anchored.
  - So: keep it indefinitely, or compact it only with a signed checkpoint.
- **Final decision:** **Decided as N6:** journal history kept at least as long as the oldest restorable backup; an off-host read-only copy; never restored together with the database.

### Backup retention (audit M3, referenced by the design)
- **Assessment:** not decided by the design. It interacts with journal retention (above) and with organisation removal (audit M3).
- **Final decision:** **Requires product-owner selection.** No absolute duration is chosen.

## 3. Detailed security review

**Existing guarantees kept.** [Design §13] No existing check is removed. [Assessment] Confirmed against the claim path as it is today ([Repo] `approvals.ts:196-224`, `routes.ts:276-302`): the journal check is purely additive. That includes the destination comparison and the approval recount at the claim, and the transactional `execute_start` audit.

**New attack surface:**
- **The state volume.** Anyone who can write to it can:
  - truncate the journal to the database's head, which defeats detection (section 4);
  - delete it, which causes quarantine (fail closed).
- **The recovery command.** Anyone who can run it can clear quarantine. That is the same trust level as access to the database: host compromise is out of scope in the design, and remains so.
- **Journal contents.** [Design] ids, fingerprints, destination digests, attempts and outcomes, no addresses. [Assessment] That is consistent with span scrubbing. Encryption isn't needed for confidentiality (N7 covers integrity).

**Bypasses that need no host access:**
- **Running older application code.** [Assessment] Code from before this feature ignores the journal entirely. A rollback of the application, deliberate or as part of a recovery, removes the protection. [Repo] Downgrades are already unsupported for the database (`docs/backup-and-restore.md:107`). The policy needs to cover this too (N9).
- **Re-proposal** of a change under a new id (design §17): unchanged.

**Two parts of the original design overstated.** Both are corrected in the design as of 16 November 2026:
- §12: "editing a line breaks the hash chain, so quarantined". True for an edit in the middle. Truncating the tail, or rewriting the chain from the cut onwards, passes. An unkeyed hash chain detects accidents, not an adversary.
- §6 crash table: "Recovery sees a claim line with no committed claim: certainly not sent". True only while the original database exists. After a restore, the database can't tell "never committed" apart from "committed, then erased by the restore" (section 4, D).

## 4. Journal durability assessment

| Concern | Design | Assessment | Needs proof |
|---|---|---|---|
| Append-only | "appended and `fsync`ed" | The application must open the file `O_APPEND` and never seek or rewrite it; tooling must never rewrite it in place | — |
| `fsync` of the file | Per line | Needed before commit. `fdatasync` would also cover the size | [Unverified] on Docker Desktop (macOS), where the volume sits inside a virtual machine, whether `fsync` reaches the physical disk. Linux hosts: standard semantics. Platform support needs stating (N11) |
| Directory `fsync` | Not mentioned | Needed once, when `journal.log` and `installation.json` are created (create, `fsync` the file, `fsync` the directory). Without it a power loss can lose a just-created file | — |
| Partial or torn line | Not mentioned | A crash mid-write leaves a line without its newline, or with a bad hash. Because commit only follows a successful `fsync`, **a torn final line was never committed.** Treating it as absent is therefore safe. Treating it as corruption quarantines falsely. Needs a rule (N1) | Prototype: kill during append |
| Corruption in the middle | Chain check → quarantine | Correct to fail closed. But the design has no recovery path for a corrupted journal other than clearance, which then re-baselines on a journal it can't fully read (N1) | — |
| Disk full | Not mentioned | The append fails, then the transaction rolls back, and nothing is sent. The `void` write probably fails too, but nothing was appended, so the heads stay equal. Safe. A partial append on `ENOSPC` is a torn tail (N1) | Prototype |
| Power loss right after `fsync` | Crash table: "after the append, before commit" → quarantine | Correct and safe (a false positive) | — |
| Commit result unknown (connection lost during `COMMIT`) | Not covered | The code must neither dispatch nor write `void`. If the commit did happen and `void` is written, the database is ahead, so quarantine (safe). If it didn't happen and nothing is written, the journal is ahead, so quarantine (safe). Either way, never dispatch. Must be specified | Test with the TCP fault proxy (`apps/api/tests/faults.ts`) |
| Replacement or tampering | Older copy → behind → quarantine; edit → chain broken | **Truncation to the database's head passes.** A keyed hash (HMAC with a key outside the volume) prevents silent edits, not truncation. Only an external anchor (D3) detects truncation | — |
| Sequence consistency | The database allocates `seq` under the row lock; the head is the last non-voided claim | Sound, provided the head is computed over `claim` and `void` lines only. `outcome` and `cleared` lines must not move the head, and a failure to write them must not affect trust | — |

**Is write-before-commit sufficient?** [Assessment] Yes for the invariant "never sent without an outside record", because dispatch follows commit, which follows the `fsync`. It isn't sufficient for the recovery question "was it sent?", which needs one more record (section 4, D).

### D. Execution lifecycle: what the journal can tell apart

| Event | Design records it? | Knowable after a restore? |
|---|---|---|
| Claim recorded | Yes (`claim`) | Yes |
| Database claim committed | No | **No.** The database that knew is gone |
| Dispatch started | **No** | **No** |
| External outcome known | `outcome` line (timing unspecified) | Only if the `outcome` line was written |
| External outcome unknown | Not distinguished from "no outcome line" | No |
| Reconciliation completed | **No** | **No.** It is lost with the database (scenario D) |

[Assessment] As designed, every claim after the database head becomes "unknown, reconcile by hand", including claims that were never sent. **Recommendation (N2):**
- Append a `dispatch` line (with `fsync`) after commit and immediately before the first byte is sent, or before a manual attestation is recorded. Then a `claim` with no `dispatch` is certainly not sent, whatever the database says.
- Also journal `outcome` and `reconciled` events, after their database transactions commit. They are best-effort for the trust check, but give recovery the answer when present.
- The cost is a second `fsync` per execution [Unverified].
- A claim never proves the external action happened, and the review keeps that position. Only an `outcome` of `applied` or a person's reconciliation says so.

## 5. Concurrency and performance assessment

- **Allocating sequence numbers:** [Design] through a single-row lock. [Assessment] Correct: sequence numbers are contiguous, with gaps only where a line is voided.
- **Lock order.** [Design] The new lock is taken **last** in the claim, and **first** in clearance. That is a reversed order, which the design notes as a deadlock PostgreSQL resolves.

  [Assessment] **Recommend taking `InstallationState` first in every claim** (N5):
  - it is then a single global order, with no deadlock against clearance;
  - the cost is serialising the whole claim (a few queries) instead of its tail;
  - at the expected volume, a few executions per incident [Unverified], the difference shouldn't matter, and the code is simpler to reason about.
- **The approve and retry quarantine checks** (design §9) should be **unlocked reads**, for an early, clear refusal. The authoritative refusal stays at the claim. An approval that slips in just before clearance is superseded by it; one just after is legitimately fresh.
- **Multiple API processes on one host:** the row lock orders claims, and an advisory file lock (`flock`) prevents interleaved lines. [Assessment] `flock` works between containers sharing a Docker volume on one Linux kernel, including Docker Desktop's single virtual machine. [Unverified] It needs a prototype test with two API containers.
- **Multiple hosts:** unsupported (design §12). The installation must enforce one API host, or document the limit (N10).
- **Per-claim latency:** one or two `fsync`s while holding the global lock. [Unverified] No measurement exists. The prototype should measure p50/p99 claim latency with one and two `fsync`s on Linux and on Docker Desktop, and the claim throughput with two API processes.
- **The worker:** doesn't dispatch, so it is unaffected. [Repo] `system.ts:50-66`.

## 6. Restore and snapshot threat matrix

| Event | Database | Journal | Detected? | Result |
|---|---|---|---|---|
| Restore PostgreSQL only (the normal procedure) | Older | Current | **Yes**: database behind | Quarantine |
| State volume lost, deleted or new | Current | Missing | **Yes** | Quarantine. Recovery has no list (manual review of everything) |
| State volume restored from an older copy | Current | Older | **Yes**: database ahead | Quarantine |
| Journal truncated to below the database's head | Current | Shorter | **Yes** | Quarantine |
| **Journal truncated exactly to the database's head** (after a restore) | Older | Cut to match | **No** | Trusted. Requires write access to the volume |
| **Both volumes restored from the same snapshot** (VM, host backup) | Older | Same moment | **No** | Trusted. External changes made after the snapshot can be repeated |
| Both volumes restored from different moments | Mixed | Mixed | Yes (heads differ) | Quarantine |
| New host, database only | Restored | Missing | **Yes** | Quarantine. New-installation path (D8) |
| **New host, both volumes copied together** | Restored | Copied | **No** | Trusted, as above |
| **Clone that copies both volumes** | Copy | Copy | **No** | **Both instances trusted, same id, diverging journals.** The clone can dispatch to production's webhook |
| Clone of the database only | Copy | Missing | Yes | Quarantine. Then D8 |
| Ids differ | Another installation's | — | Yes | Quarantine |
| Pre-feature backup under new code | No row | Present | Yes (row missing) | Quarantine (design §4F) |
| **New database under old code (downgrade)** | Any | Ignored | **No** | Unprotected (N9) |

**What the architecture can't detect without an external anchor (D3):**
- any rollback that takes the journal back to the same point as the database;
- any copy that duplicates both.

[Assessment] A local volume protects against an **accidental PostgreSQL-only restore** and against **loss of the database volume while the state volume survives**. It is **not a disaster-recovery copy:** on host loss it is lost too. Then the installation fails closed, but recovery has to examine every target system with no list.

## 7. Recovery clearance assessment

| Question | Design | Assessment |
|---|---|---|
| Is inspection bound to a stable snapshot? | `clear --expect <journal head>` | **No.** During quarantine the database head can't change (no claims), but reconcile, submit, propose, edit and cancel are allowed (D2, §9). The set of actions the operator reviewed can change before `clear`. **Recommend (N4):** `inspect` prints a digest of exactly what it showed (journal head, database head, and every affected action's id, status, attempts and outcome). `clear` recomputes it inside its transaction and refuses on any difference |
| Changes between inspection and clearance | Only the journal head is checked | As above |
| Two operators clearing at once | Row lock plus compare-and-set | Sound. With N4 the digest makes the second refusal explicit |
| Approvals invalidated atomically | One transaction | Sound. [Unverified] Duration of one transaction over every organisation's actions; the prototype should measure it at a realistic size |
| An interrupted clearance repeated safely | Yes. Partial crash: the `cleared` line is "appended by the next `recovery status`" | Mostly sound. **Modify:** `status` should stay read-only. Write the `cleared` line before commit, like a claim, so it is never missing after a commit |
| Can a compromised operator bypass it? | Out of scope (host compromise) | Agreed, but note that bypassing needs only write access to the volume (truncation), not to the database (section 6) |
| Audit in every relevant organisation | Yes, in the same transaction | Sound. **Modify (D5):** include the host user, the typed reason and the inspection digest. An installation-level record exists only in the journal (`cleared`), because [Repo] `AuditLog` requires an organisation (`schema.prisma`, `organizationId` required) |
| Organisations removed after the backup | Runbook: re-run `org:remove` | Manual and easy to forget. Add it to the `inspect` checklist (with D10) |

## 8. Additional decisions required

**Essential before prototyping:**

| # | Decision | Recommendation |
|---|---|---|
| N1 | How to treat a torn final line, and how to recover from a corrupted journal | Treat a torn final line as never written (it was never committed), repaired only by tooling. Corruption earlier in the file means quarantine, recovered only through clearance with an explicit "journal unreadable" acknowledgement and a full manual review |
| N2 | Add a `dispatch` line before the first byte is sent, and journal outcomes and reconciliations | Yes: it turns "unknown" into "certainly not sent" for every claim that never dispatched |
| N4 | Bind clearance to an inspection digest, not only the journal head | Yes |
| N5 | Take `InstallationState` first in every claim (one lock order) | Yes |
| N6 | Back up the journal, and how far back it must reach | Copy it off the host for inspection after host loss, read-only. **Never restore it over a newer one,** and never restore it together with the database (that defeats detection). Keep it for at least as long as the oldest retained backup |
| N9 | Policy on running older code after this feature (downgrade) | Unsupported: state it in the release notes and the runbook. [Unverified] whether a startup check of the database's migration level could refuse older code |

**Optional or later:**

| # | Decision | Note |
|---|---|---|
| N3 | Allowing a deliberate break-glass re-baseline when the journal is unreadable | Covered by N1's acknowledgement; separate only if the owner wants a stricter path |
| N7 | A keyed integrity check for the journal (HMAC, with a key outside the volume) | Detects silent edits, not truncation; modest value without D3 |
| N8 | Treating a copy-everything clone as an operator-policy matter | Document "never copy `opspilot-state` into a clone". Detection needs D3 |
| N10 | Enforcing a single API host | A start-up check is impossible without shared state; document it |
| N11 | Supported platforms for the durability claim | Linux with a local filesystem; Docker Desktop for development only, until measured |
| — | Encrypting the journal | Not needed: no sensitive values (design §13) |
| — | Replacing the installation identity | Covered by D8's new-installation path |

## 9. Recommended implementation sequence

The design's phases are:
1. journal and detection;
2. quarantine across routes, status endpoint, banner;
3. inspection and clearance;
4. drill and runbook.

[Assessment] Two dependency problems:

- **Provisioning must come in phase 1, not phase 4.**
  - [Repo] 11 API test files, the browser tests (`apps/web/e2e/opspilot.spec.ts:110-133`), the demo (`demo/scripts/e2e.mjs:271,344`) and both drills execute remediations on fresh databases.
  - As soon as phase 1 adds the check, all of them fail unless `init` exists and they call it.
- **Phases 1–3 must be released together.**
  - After phase 1, an upgraded installation is quarantined (D9), and nothing can clear it until phase 3.
  - They can be merged separately to `develop`, but no release may contain phase 1 without phase 3.

**Recommended order:**
- **Phase 0: prototype on the isolated stack.**
  - Covers: `fsync` cost, `flock` between two API containers, torn-tail handling, the dispatch marker, and how long a large clearance transaction takes.
  - Delivers numbers and a revised design, no production code.
- **Phase 1: journal, detection and provisioning.**
  - The journal (with N1, N2, N5) and `installation.json`.
  - `InstallationState`, the claim check, and `recovery init` and `status`.
  - Provisioning in tests, the isolated stack, the demo and the browser tests.
- **Phase 2: quarantine across routes,** with the status endpoint and banner.
- **Phase 3: inspection and clearance,** with the digest (N4), the new-installation path (D8) and the audit fields (D5).
- **Release gate:** phases 1–3 together.
- **Phase 4: the extended restore drill and the runbook** (including N6, N8, N9 and the settings checklist from D10).

## 10. Acceptance criteria

**Phase 0:**
- Measured claim latency (p50 and p99) with one and two `fsync`s, on Linux and Docker Desktop.
- `flock` shown correct with two API containers.
- A kill during append leaves a torn tail that the rule in N1 handles.
- A written decision on each N item.

**Phase 1:**
- Every case of the design's test 6 quarantines (the files missing, the row missing, the ids different, a truncation below the head, an edit in the middle).
- A torn tail is handled per N1.
- **No request reaches the local stand-in webhook** in any quarantined state.
- A crash injected after append and before commit leaves the journal ahead, so quarantine, and nothing is sent.
- A commit with an unknown result (through the fault proxy) neither dispatches nor wrongly voids.
- Two concurrent claims produce contiguous sequences and an ordered journal (shown with barriers and `pg_locks`).
- The migration on a pre-feature database leaves it quarantined.
- The whole existing suite, browser tests and drills pass with provisioning.
- No added test sleeps.

**Phase 2:**
- Approve and retry are refused during quarantine, server-side. Reconcile, propose, cancel and ping are allowed (per D6).
- The status endpoint and banner reflect the state and contain no secret or address.

**Phase 3:**
- **Clearance:**
  - refused if the inspection digest changed;
  - concurrent clearances: one succeeds;
  - an interrupted clearance can be repeated safely.
- **The A2 case:** after clearance, an action claimed after the database head is `FAILED`/`unknown` (or "not sent" when there is a claim without a `dispatch` line), and never retryable automatically.
- **The D8 case:** the new-installation path removes webhook addresses and secrets, audited.
- **Audit:** an audit row in every organisation with the user, reason and digest.

**Phase 4, the drill on the isolated stack:**
1. back up;
2. execute against a stand-in;
3. restore the database only;
4. refused;
5. inspect;
6. reconcile;
7. clear;
8. approve again;
9. execute once.

The stand-in's request count is exactly as expected. A second drill restores both volumes from the same moment and documents that this is **not** detected, as an accepted-risk record.

## 11. Unresolved risks

Even after the design and this review:
- A rollback or copy of **both** volumes (snapshot, clone, host backup) is undetected (section 6). Mitigated only by D3, or by operator policy (N6, N8).
- **Host loss** removes the list of what ran after the backup; recovery is a full manual review.
- **Truncation by someone with host access** defeats detection.
- **Downgrades** remove the protection (N9).
- **Re-proposal** of the same change under a new id (design §17).
- **Settings and memberships** rolled back by a restore are found only by manual review (D10).
- **Receivers that don't deduplicate** remain exposed to any repeat that gets past OPSILUME.
- **Durability on Docker Desktop** is unverified (N11).
- **Every claim is serialised.** [Unverified] It is acceptable at the expected volume.

## 12. Decisions requiring explicit product-owner approval

**Decided on 16 November 2026:** see "Decision outcome" above.

**Still open:**
- the absolute backup retention duration;
- the new Phase 0 decisions P1 to P7 (above);
- approval of the design as revised after Phase 0;
- explicit approval of the production implementation scope (design §19, readiness gate).

**As originally listed for decision:**
- **From the design:** D1–D11, journal retention and backup retention (section 2).
- **Essential new decisions:** N1, N2, N4, N5, N6 and N9 (section 8).
- **Optional new decisions:** N3, N7, N8, N10 and N11.
- **Approach:** whether to proceed to the Phase 0 prototype (section 9).

---

**Files read for this review:**
- `docs/post-restore-remediation-safety-design.md` (in full);
- `docs/recovery-readiness-audit.md`;
- the repository code and documents the design cites, as previously inspected at `11cf150`: the remediation module, `system.ts`, `integrations.ts`, `lib/permissions.ts`, `schema.prisma`, the backup scripts, `docker-compose.yml`, the browser and demo test scripts.

**What was not done:** nothing was implemented, executed, restored or prototyped. The design document was not modified. This is not a claim of pilot or production readiness.
