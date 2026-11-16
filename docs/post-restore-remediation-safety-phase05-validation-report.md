# Post-restore remediation safety: Phase 0.5 validation report

Milestone 16, Phase 0.5. An isolated validation of the production blockers left by the revised design ([post-restore-remediation-safety-design.md](post-restore-remediation-safety-design.md), merged in PR #40):
- P4, incremental verification;
- P5, an unknown commit result;
- P6, clearance at scale;
- P7, durability;
- the no-downgrade policy (N9).

- **Code:** `prototype/m16-phase05/`, on branch `prototype/m16-phase05-validation`.
- **Raw results:** `prototype/m16-phase05/results/`.
- **Status:** this validates the design. **It does not authorise production implementation.**

**Result classes:** Passed · Failed · Partially passed · Not tested · Inconclusive. Every result below was run and measured, unless it says Not tested.

## 1. Executive summary

**Recommendation: revise, then request approval. Not ready for production approval yet.**

**P5, an unknown commit result, held in all five scenarios.** The faults were injected at the PostgreSQL wire protocol, not by throwing exceptions in the code:
- a committed claim was recognised as committed;
- a rolled-back claim was recognised and voided under the lock;
- an unreachable database left the state untouched, and it was resolved when the database returned;
- a restarted process resolved the claim from the journal;
- **nothing was dispatched in any of them,** nothing became automatically retryable, and the journal was only ever appended to.

**P4, incremental verification, holds at 1,000,000 records (235 MB of journal):**
- per-claim verification p50 0.05–0.06 ms and p99 ≤ 0.45 ms, flat from 100,000 to 1,000,000 records;
- full verification is bounded in memory: a peak of 106 MB at 1,000,000 records;
- **the head hash anchored in the database was the only thing that caught a replacement journal with the same head;**
- it exposed **one defect, in this prototype's code:** the last-record re-hash must recompute the hash from the record's content. It is fixed and retested.

**P6, single-transaction clearance bounded in memory, worked at every size tested:**

| Actions | Clearance | Process peak memory |
|---|---|---|
| 100,000 | 0.92 s | 147 MB |
| 1,000,000 | 10.3 s | 246 MB |

Every failure test (killed early, killed before commit, database session terminated, two at once, changed after inspection, repeated) left the database whole: either the clearance committed completely or nothing changed. During the 1,000,000-action clearance, a route locking an affected row waited at most 2.9 s, and claims waited for the whole clearance.

**Downgrade protection: a design gap, with a proposed correction.**
- **The gap:** with the design as approved, an older application ignores the journal. Its claim executed and dispatched, and the installation still looked trusted.
- **The proposed correction:** a database trigger, created by the same migration as `InstallationState`, that refuses any move to `EXECUTING` not made through the journal protocol. It blocked the older application, and the newer application and the sweep were unaffected.
- **Status:** a new decision (P8), not yet approved.

**P7, durability: native Linux and power loss are NOT TESTED.** Only Docker Desktop on macOS was available. Process-kill and container-kill runs were consistent there, but that is not a durability result.

## 2. Environment and isolation

| Item | Value |
|---|---|
| Host | macOS 26.2, Apple silicon (arm64), 10 CPUs |
| Docker | Docker Desktop, engine 29.2.1. Linux VM kernel `6.12.76-linuxkit`, 8 GB for the VM |
| Journal storage | A named Docker volume: `/dev/vda1` ext4 `rw,relatime,discard` (the VM's virtual disk) |
| Runtime | `opspilot-isolated-api:latest`, reused unchanged: Debian 12, Node 22.23.5, Prisma client 6.19.3 |
| Database | `postgres:16-alpine` (PostgreSQL 16.14), `max_connections=200`, `shared_buffers=512MB` |
| Isolation | Compose project `opspilot-m16-p05`: **internal** network, no published host ports, its own `pgdata` and `state` volumes. The prototype's own schema. The application's code, schema and Compose file are untouched. Your default project's containers were never touched |
| Fault injection | `proxy.mjs` on the internal network, between the prototype and PostgreSQL. It reads the frontend protocol; Prisma sent `COMMIT` as a simple query (`Q`) in every scenario. Observation uses a direct connection that bypasses the proxy |
| Receiver | `receiver.mjs`: a local stand-in that records requests only |

## 3. P4: incremental journal verification

**Correctness**, in one process with a 2,000-claim journal, plus a second and third process (`results/p4-correctness.json`):

| # | Case | What the verifier did | Trust | Result |
|---|---|---|---|---|
| a | 2,000 sequential claims | 1 full check, then 1,999 incremental | trusted | **Passed** |
| c | New process (restart) | Full check ("no cache") | trusted | **Passed** |
| d1 | Replaced by an identical copy (new inode) | Full check ("file replaced") | trusted (identical content) | **Passed** |
| d2 | Replaced by an older copy | Full check | refused: database ahead | **Passed** |
| d3 | Replaced by a **different chain with the same head** | Full check: the chain is valid and the head matches | refused: **"head hash differs between database and journal"** | **Passed.** Only the database head-hash anchor caught it |
| e | Shrunk in place | Full check ("file shrank") | refused | **Passed** |
| f | Last record rewritten in place (same length and inode) | Full check ("last verified record changed"), then corrupt | refused | **Passed after a fix;** see below |
| g | Torn final record | Incremental: torn tail ignored, head unchanged | trusted; **appends refused** (`JOURNAL_TORN`) | **Passed** |
| h | An **earlier** record edited in place (same length) | Incremental: **not detected**. A scheduled full check: corrupt | trusted until the full check | **Passed, as designed** (the documented limit, design §6.2) |
| i | Database head mismatch | Incremental | refused | **Passed** |
| j1 | Another process appended 10 claims | This process's cache read only the new bytes | trusted at the new head 2,010 | **Passed** (the cache was not stale) |
| j2 | Another process replaced the file with an older copy | Full check ("file replaced") | refused | **Passed** |

**Defect found in this prototype's verifier.** The first run of case f was **Failed**: the in-place rewrite was **not detected**. The code compared the record's stored `hash` field with the cached hash, and that field is unchanged when another field is edited. The fix recomputes the hash from the record's content, which is what design §6.2 says, so the design text needs only a clarification. The original run is kept as `results/p4-correctness-before-rehash-fix.json`.

**Concurrent verification and append (k).** One process checked the journal without the lock, as fast as possible, while another appended 2,000 claims:
- 95,890 checks: 94,624 ok, 1,265 empty (before the first append), **1 torn tail, 0 corrupt**;
- final state ok, head 2,000.

**Passed:** an unlocked reader can see a partial record, never a corrupt one.

**Two API containers** (`results/p4-multi.json`). 1,000 claims (500 each), each followed by a dispatch record:
- journal ok; journal head = database head = 1,000; head hash matches; 1,000 unique sequences;
- each process did 1 full check, then incremental checks only;
- verification p50 0.056 / 0.077 ms and p99 0.51 / 0.53 ms.

**Passed.**

**Performance.** Each size was verified cold in a new process, then 1,000 claims were made through the incremental path. n is 1,000 per claim row and 3 per full-verification row:

| Records (bytes) | Cold full verification | Full verification p50 | Peak memory of a full verification (OS maxRSS; an empty Node process is 41 MB) | Per-claim verification p50 / p95 / p99 / max (ms) | Whole claim p50 / p99 (ms) |
|---|---|---|---|---|---|
| 100,000 (23.4 MB) | 145 ms | 135 ms | 82 MB | 0.064 / 0.271 / 0.398 / 2.13 | 1.78 / 4.14 |
| 500,000 (117 MB) | 700 ms | 687 ms | 99 MB | 0.061 / 0.278 / 0.410 / 1.40 | 1.78 / 3.82 |
| 1,000,000 (235 MB) | 1,412 ms | 1,372 ms | 106 MB | 0.052 / 0.309 / 0.450 / 0.95 | 1.74 / 3.78 |

The first attempt at memory measurement used a timer-based sampler. It can't run during a synchronous verification, so it reported nothing useful and was replaced by the OS counter above.

| P4 item | Classification |
|---|---|
| Normal appends; several processes; concurrent appends; restart; replacement; shrinkage; inode change; torn tail; database head mismatch; stale cache; concurrent verification and append; full verification at the mandatory points | **Passed** |
| Corruption in an earlier record | **Passed as designed:** detected only by a full verification, not by the incremental check |
| Scale: 100,000, 500,000 and 1,000,000 records | **Passed** (this environment) |

## 4. P5: unknown database commit result

**Method.** The prototype connects through `proxy.mjs`. Before each scenario the proxy is armed for the next `COMMIT`:
- **`drop_after_commit_response`:** the `COMMIT` is forwarded, the server's answer is swallowed, and both sockets are closed. The proxy logged the answer's first byte: `C` for committed, `E` for an error.
- **`drop_before_commit`:** the `COMMIT` is never forwarded and both sockets are closed. The server rolls back on disconnect.

Scenario 2 uses a **deferred** foreign key, so the transaction genuinely fails at `COMMIT` on the server. The claim code reports `uncertain` when its transaction callback finished but `$transaction` then failed. Resolution follows design §6.3.

| # | Scenario | Proxy evidence | Claim result | State while uncertain (direct view) | Resolution | Dispatched | Result |
|---|---|---|---|---|---|---|---|
| 1 | Committed, answer lost | `COMMIT` via `Q`; server answered `C`; answer dropped | uncertain ("Server has closed the connection") | database head 1, action `EXECUTING`, journal: `claim` | **committed**: left `EXECUTING`, not dispatched. The sweep then gives `FAILED`/`unknown`; automatic retry not permitted | 0 | **Passed** |
| 2 | Rolled back at `COMMIT` (deferred foreign key), answer lost | server answered `E`; answer dropped | uncertain | database head 0, action `APPROVED`, journal: `claim` | **not committed**: `void` appended under the lock. Heads equal; the next claim was trusted | 0 | **Passed** |
| 3 | Connection dropped during `COMMIT` | `COMMIT` not forwarded; sockets closed | uncertain | database head 0, `APPROVED`, journal: `claim` | **not committed**: voided | 0 | **Passed** |
| 4 | Database unavailable straight after `COMMIT` (new connections refused) | `C` answered, then dropped; new connections refused | uncertain | database head 1, `EXECUTING` | **unreachable**: nothing changed. A claim attempt failed to connect | 0 | **Passed** |
| 6 | The database available again after scenario 4 | — | — | — | **committed**: left `EXECUTING`, not dispatched | 0 | **Passed** |
| 5 | Process exits before resolving (restart) | `COMMIT` not forwarded | the first process saw uncertain, then exited | database head 0, `APPROVED`, journal: `claim` (no `dispatch`, no `void`) | start-up check on the last undispatched claim: **not committed**, voided | 0 | **Passed** |

In all scenarios the journal file was only appended to: its earlier bytes were a prefix of its later bytes.

**P5 as a whole: Passed** in this environment.

**Not covered:** a crash *during* resolution, and the connection pool's behaviour under repeated faults.

## 5. P6: large-installation clearance

**Implementation tested** (design §9.1): **one transaction**, bounded in process memory.
- The journal is streamed in 4 MiB chunks.
- The claims after the database head go into a temporary table, inserted in chunks of 5,000.
- The digest is computed **by PostgreSQL** over the affected rows.
- Every rule is a set-based update.
- One audit row per organisation, inserted in one statement.
- The `cleared` record is appended before commit.

**Synthetic installations:**
- 40% approved, 30% awaiting approval, 10% executed, 10% failed/unknown, 10% proposed;
- **two approvals** per pending action;
- 5% of actions executed after the "backup" (a quarter undispatched; some with outcomes or reconciliations);
- 1% journal claims for actions the restored database lacks.

| Actions / orgs / approvals | Journal | Inspection (repeat) | Clearance: one transaction, wall clock | Claim attempted during clearance | Process peak memory | Database work during clearance (tuples updated / temp bytes) | Afterwards |
|---|---|---|---|---|---|---|---|
| 100,000 / 200 / 140,000 | 10.1 MB | 182 ms (131) | **922 ms** | waited 116 ms, then refused | 147 MB | 210,004 / 1.5 MB | 200 audit rows; 0 approvals current; 0 executable; trusted |
| 250,000 / 500 / 350,000 | 25.3 MB | 384 ms (329) | **3,037 ms** | waited 2,043 ms, then refused | 172 MB | 525,004 / 14.8 MB | 500 audit rows; 0 current; 0 executable; trusted |
| 500,000 / 1,000 / 700,000 | 50.6 MB | 896 ms (688) | **5,499 ms** | waited 4,654 ms, then refused | 197 MB | 1,050,002 / 40.7 MB | 1,000 audit rows; 0 current; 0 executable; trusted |
| 1,000,000 / 2,000 / 1,400,000 | 101 MB | 1,407 ms (1,326) | **10,348 ms** | waited 9,871 ms, then refused | 246 MB | 2,100,002 / 68.1 MB | 2,000 audit rows; 0 current; 0 executable; trusted |

The digest was stable between two inspections at every size. Peak memory grows with the claims made after the backup (5% of actions here), not with the installation as a whole.

**Lock duration seen by other operations:**
- **Claims** wait for the whole clearance, because they hold the installation lock (claim probes above).
- **A route repeatedly locking an affected action row** during the 1,000,000-action clearance (182 attempts): longest wait **2,866 ms**, median 2 ms (`results/p6-probe-row-loop-1000000.json`).
- **A single row-lock probe taken 1 s in** was not measuring the bulk update, which hadn't started yet: 45–95 ms. It is kept, but superseded by the repeated probe.

**Failure tests** (250,000 actions, `results/p6-failures.out`):

| Test | Evidence | Result |
|---|---|---|
| Process killed early (2.5 s in) | Afterwards: database head 25,000, 350,000 approvals current, 0 audit rows, 0 `cleared` records. Retried with the same digest: cleared | **Passed** |
| Process killed after the `cleared` record, before commit | Database unchanged; 1 orphan `cleared` record in the journal. The old digest was refused; a fresh inspection cleared (2 `cleared` records, 500 audit rows) | **Passed** |
| Database interruption (`pg_terminate_backend` of the clearing session, 1.5 s in) | Error 57P01; database unchanged; no `cleared` record | **Passed** |
| Two concurrent clearances, same digest | One cleared in 2.7 s; the other waited, then was refused ("the state changed since inspection") | **Passed** |
| Changed after inspection | Refused; a fresh digest cleared | **Passed** |
| Repeated clearance with an already-used digest | Refused | **Passed** |
| Many organisations and approvals | Up to 2,000 organisations and 1,400,000 approvals (table above) | **Passed** |

**Test artefact.** In the "changed after inspection" test, the change was made by hand in SQL: an approved action set to `PROPOSED` with its approvals left current. After clearance those 2 approvals were still current, because clearance supersedes the approvals of `APPROVED` and `PENDING_APPROVAL` actions only. The application's edit route always supersedes approvals, so it can't produce that state. Still, superseding every current approval at clearance would be the more conservative rule (section 11).

| P6 item | Classification |
|---|---|
| Clearance at 100,000 / 250,000 / 500,000 / 1,000,000 actions | **Passed** (this environment) |
| Atomicity under kill, database interruption, concurrency, changes and repetition | **Passed** |
| Maximum supported installation size | **Not decided:** evidence exists up to 1,000,000 actions on Docker Desktop only |

## 6. P7: native Linux durability

| Item | Classification |
|---|---|
| Native Linux host | **NOT TESTED:** only Docker Desktop on macOS is available. A Linux container in Docker Desktop's VM is not native Linux validation |
| Power loss, or a VM crash or hard reset | **NOT TESTED.** Restarting Docker Desktop's VM would also stop the default OPSILUME project, which is out of bounds |
| `fsync` reaching physical storage | **NOT TESTED** (Phase 0 called it inconclusive) |
| Process kill during claims (Docker Desktop) | Claims were running against a 20,000-action dataset; the claim process was killed with `SIGKILL` after ≈ 4 s. Afterwards: journal ok, no torn tail, journal head = database head = 2,171, **every one of the 2,171 committed claims in the journal**, trusted. **Passed,** but it is not a durability test (the page cache survives a process kill) |
| Container kill during claims (Docker Desktop) | `docker kill` of the container running the claims: 2,169 committed, all in the journal, heads equal, trusted. **Passed,** but not a durability test either |

**No durability claim is made** for native Linux, physical disks, Docker Desktop, network filesystems, the overlay filesystem or multi-host deployment.

## 7. Downgrade protection (N9)

**Method.** The newer application claims with the journal. Then an "older application" claims: a stand-in for code from before this feature, which knows nothing of the journal or `InstallationState`.

| | Without a guard (the design as approved) | With the proposed database guard |
|---|---|---|
| Newer application's claim | claimed | claimed |
| Older application's claim | **claimed, and dispatched** (the receiver got 1 request) | **refused at the database:** `P0001 remediation claim without a journal record: refused` |
| The older execution in the journal | no | — (nothing executed) |
| Trust afterwards | **"trusted"**: the older execution is invisible to the journal, so a later restore would not reveal it | trusted (no older execution happened) |
| Newer claims afterwards | work | work |
| The sweep (`EXECUTING` → `FAILED`) | works | works |

**The guard tested:**
- **What it is:** a `BEFORE UPDATE OF status` trigger on the action table. It refuses any transition **into** `EXECUTING` unless the transaction has set `opsilume.claim_seq` to `installation_state.journal_seq`, which only the journal claim path does, after advancing that sequence.
- **Where it would come from:** the same migration that creates `InstallationState`, so any database that has the feature has the guard.

| Item | Classification |
|---|---|
| Older application executing while ignoring the journal (as designed) | **Failed:** the policy alone doesn't prevent it. A design gap |
| Database guard refusing the older application's claim | **Passed** (prototype) |
| An older application starting against newer state | **Partially tested:** the stand-in starts and runs. The real older application's start-up isn't modelled |
| A migration or version mismatch with the real application (an older `prisma migrate deploy` against a newer database) | **Not tested:** it needs the real application at two versions |

**Limits of the guard:**
- a database owner can drop the trigger;
- it relies on the migration having run;
- it stops claims, not reads.

## 8. Failure-injection evidence

| Injection | Mechanism | Where |
|---|---|---|
| Committed, answer lost | Proxy forwards `COMMIT` and drops the server's `C` | P5 #1, #4 |
| Rolled back at commit, answer lost | Deferred foreign key; proxy drops the server's `E` | P5 #2 |
| Connection dropped during `COMMIT` | Proxy never forwards `COMMIT` | P5 #3, #5 |
| Database unavailable | Proxy refuses new connections | P5 #4 |
| Process killed | `SIGKILL` (by pid) | P5 #5, P6, P7 |
| Container killed | `docker kill` (prototype container only) | P7 |
| Database session terminated | `pg_terminate_backend` | P6 |
| File replaced, shrunk, rewritten, torn, edited in the middle | Direct file operations | P4 |
| Concurrent reader and writer | Two processes | P4 k |

## 9. Performance summary

Docker Desktop, Apple silicon. Not to be generalised.

| Measure | Value |
|---|---|
| Per-claim incremental verification at 1,000,000 records | p50 0.052 ms, p99 0.450 ms |
| Whole claim, through the prototype's lock and journal, at 1,000,000 records | p50 1.74 ms, p99 3.78 ms |
| Full verification at 1,000,000 records | 1.37 s, 106 MB peak |
| Clearance of 1,000,000 actions | 10.3 s in one transaction, 246 MB peak in the process |
| Longest wait for a route on an affected row during that clearance | 2.9 s |

## 10. Comparison with Phase 0

| Measure | Phase 0 | Phase 0.5 |
|---|---|---|
| Trust check per claim at 100,000 records | Whole-journal parse each time: 162 ms | Incremental: p50 0.064 ms, p99 0.398 ms |
| Full verification at 100,000 records | 162 ms, whole file in memory | 135 ms streaming; 82 MB peak (OS) |
| Largest journal verified | 100,000 records | 1,000,000 records (235 MB) |
| Clearance of 100,000 actions | 1,693 ms, 389 MB, rows loaded into the process | 922 ms, 147 MB, digest in the database, set-based |
| Largest clearance | 100,000 actions | 1,000,000 actions (10.3 s, 246 MB) |
| Unknown commit result | Not tested | Five scenarios passed, via a wire-protocol fault proxy |
| Replacement chain with the same head | Not tested | Caught only by the database head-hash anchor |
| Downgrade | Not tested | Gap found; guard prototyped |

## 11. Design defects and clarifications discovered

1. **No-downgrade enforcement is missing** (a design gap). Proposed decision **P8:** add the database guard trigger in the same migration as `InstallationState`.
2. **The last-record re-hash must recompute the hash from the record's content** (a clarification of design §6.2). Comparing the stored hash field misses in-place edits; the prototype's first implementation did exactly that.
3. **An in-place edit of an earlier record goes unseen until a full verification** (confirmed; the documented limit). The interval of the scheduled full verification is still undecided. Its cost here: 1.37 s at 1,000,000 records.
4. **The void head hash.** After a void, the verifier must know the hash of the previous live claim. The prototype keeps the last 64 claims and fails closed (head hash unknown, so quarantine) beyond that. The design should state this bound and the fail-closed rule.
5. **Detecting an unknown commit relies on knowing the failure came from `COMMIT`.** The prototype marks the end of the transaction callback. A production implementation must have an equally reliable signal; the evidence here is for Prisma 6.19.3.
6. **Clearance should supersede every current approval,** not only those of `APPROVED` and `PENDING_APPROVAL` actions (defence in depth; P6 artefact).
7. **Phase 0 evidence gap (found while committing Phase 0.5).** The Phase 0 report says each experiment-C case's inputs and outputs are kept under `results/exp-c/<case>/`. But the 15 input journals (`journal.log`) were never committed: `.gitignore` line 27 (`*.log`) excludes them. They exist only in the local working copy where Phase 0 ran. The branch `prototype/m16-recovery-safety-phase0` has the case outputs (`result.json`) and identity files, not the inputs. That branch was left unchanged as instructed. Adding the inputs (force-adding them, or renaming them) needs a separate decision. Phase 0.5 writes no `.log` files.
8. **Lock duration:** claims wait for the whole clearance (≈ 10 s at 1,000,000 actions), and routes on affected rows up to 2.9 s. That is acceptable during a quarantine; claims are refused afterwards in any case. It is recorded for the size decision.

## 12. Remaining production blockers

From the design's readiness gate (§19):

| Gate | After Phase 0.5 |
|---|---|
| 1. Revised design approved | Open: needs revisions 1, 2, 4, 5 and 6 above first |
| 2. Savepoint and short-write requirements | Specified; prototype evidence only |
| 3. Journal mutex | Recommended (row lock); prototype evidence, one host |
| 4. Incremental verification | **Designed and tested in the prototype** (P4 Passed). Still to be tested in the implementation |
| 5. Unknown commit handling | **Designed and fault-injection tested in the prototype** (P5 Passed). Still to be tested in the implementation |
| 6. Native Linux durability | **NOT TESTED:** still a blocker |
| 7. Large-installation clearance | **Validated in the prototype up to 1,000,000 actions** (P6 Passed). Maximum size not decided |
| 8. Backup retention duration | Open: awaiting the product owner |
| 9. Security and downgrade | **Gap found;** the guard prototyped; P8 awaiting approval |
| 10. Implementation scope | Open: awaiting the product owner |

**Pending product-owner decisions (not made here):**
- the absolute backup retention duration;
- acceptance of the residual risk of coordinated snapshots and journal truncation;
- final approval of the revised production design;
- the maximum supported installation size;
- the production implementation scope;
- P8, the downgrade guard.

## 13. Recommendation

**Revise, then request approval.** The prototype supports P4, P5 and P6 in this environment, and nothing here argues for stopping. Before production approval:
- revise the design with section 11's items: the P8 guard, the re-hash clarification, the void bound, the commit signal, and superseding all approvals;
- run the native Linux durability test (P7), which can't be done on this machine;
- get the product-owner decisions above.

---

**Files:**
- `prototype/m16-phase05/`: the prototype, experiments and results (branch `prototype/m16-phase05-validation`);
- this report.

**What was not done:**
- no production code, schema, migration or infrastructure was changed;
- no real webhook was called, and no model or paid service was used;
- the default OPSILUME project was never touched.

This is not a claim of pilot or production readiness.
