# Post-restore remediation safety: final readiness report

Milestone 16, final approval preparation (16 November 2026). This states where the recovery-safety architecture stands before any production implementation decision.

**It does not authorise production implementation.**

**Result classes:** Passed · Failed · Partially passed · Not tested · Inconclusive.

## 1. PR #41 merge

| Item | Value |
|---|---|
| PR | #41, "docs: final recovery-safety design revision after Phase 0.5" |
| Head merged | `948b0161c3ae4167146d59c789a80dfb7165690a` |
| Checks before merge | All 7 passed |
| Files | Exactly four documents (design, decision review, Phase 0 report with erratum, Phase 0.5 report); no prototype or production code |
| Merge | Normal merge commit `85eec9e63958fa10721ed7c0e2a15692df104fe2`, 16 November 2026 18:19 UTC; parents `ce875f7` (previous `develop`) and `948b016` |
| Afterwards | `develop` contains the four documents. `main` is unchanged (`aed4476`). Both prototype branches are intact: `prototype/m16-recovery-safety-phase0` at `cced3e1`, `prototype/m16-phase05-validation` at `761d6e5` |

## 2. Native Linux environment

**Discovery** (read-only, on the machine available to this work):

| Item | Found |
|---|---|
| Host OS | macOS 26.2 (build 25C56), Darwin 25.2.0, arm64 (Apple silicon) |
| Host filesystem | APFS on an internal solid-state device |
| Linux available | Only Docker Desktop's own Linux VM: engine 29.2.1, kernel `6.12.76-linuxkit`, overlayfs. Named volumes are ext4 on the VM's virtual disk. **Excluded by the brief** as a substitute for native Linux |
| Hypervisor tooling | **None found** (Lima, Colima, Multipass, QEMU, UTM, Parallels, VMware, VirtualBox, OrbStack, Tart, libvirt) |
| Other Linux hosts | None known to this work; none contacted |
| PostgreSQL | 16.14 (`postgres:16-alpine`). Neither prototype overrode the durability defaults (`fsync`, `full_page_writes` and `synchronous_commit` are on by default); their Compose files set only connection and memory options. The live values weren't queried |

**Result: no suitable native Linux environment exists here.** Following the brief, the durability experiment was **not** started, and Docker Desktop was not used in its place.

**Infrastructure needed to proceed**, in the order recommended:
1. **A spare physical Linux machine** (the only option that can test a real power cut):
   - Linux with a local ext4 or XFS filesystem on a local disk;
   - Docker Engine, the isolated Compose stack, PostgreSQL 16 with the default durability settings;
   - the disk's write-cache setting recorded;
   - the ability to cut its power, for example through a smart plug.
2. **A Linux VM on a Linux host** (KVM, libvirt): `virsh destroy` or `virsh reset` gives a **VM crash** model, not a power-loss model. The VM's disk cache mode (`none` or `directsync`) must be recorded, because the host's page cache can otherwise absorb flushes.
3. **A full Linux VM on this Mac** (UTM or QEMU, which would need installing; that wasn't done without approval): a VM crash model only. The hypervisor's flush behaviour on macOS has to be recorded, and it can't stand in for a power-loss test.
4. **A cloud VM:** paid infrastructure, which needs explicit approval. Forced stop or reset gives a VM crash model; the provider's storage semantics apply.

**In every case:**
- an **acknowledgement recorder outside the machine being tested** (another host, or the Mac when a VM is under test);
- a local deterministic receiver;
- no production credentials or destinations.

## 3. P7 test methodology (specified, not executed)

The procedure is in design §16.1:
1. Claims run in a loop on the system under test. After each claim commits, its sequence number is sent to the off-machine recorder.
2. The machine is crashed at a random moment (power cut, or VM hard reset, depending on the environment).
3. The machine restarts: PostgreSQL recovers, a full journal verification runs, and the trust comparison runs.
4. Acknowledged claims are compared with both the journal and the database.
5. At least 20 cycles, including some during bursts of claims.

**Recorded per cycle:**
- the cycle number;
- claims attempted and acknowledged;
- the journal's state after recovery (ok, torn tail, or corrupt);
- the database's state after recovery;
- acknowledged claims missing from either;
- duplicates;
- corruption;
- recovery duration;
- anything inconclusive.

**Pass criteria:**
- every acknowledged claim is in the journal **and** committed in the database;
- **never** a claim committed in the database but missing from the journal;
- the journal head equals the database head, or is one claim ahead (quarantine);
- any torn tail follows N1.

**The failure model must be stated for every run:** power cut against VM crash. A process kill, a container kill and a graceful shutdown are **not** power-loss tests.

## 4. Durability test results

| Test | Classification | Evidence |
|---|---|---|
| Power loss on native Linux | **Not tested** | No native Linux environment (section 2) |
| VM crash or hard reset on native Linux | **Not tested** | No native Linux environment and no hypervisor |
| Physical durability of `fsync` | **Not tested** | — |
| Process kill during claims (Docker Desktop, Phase 0.5) | Passed, as **not** a durability test | 2,171 committed claims, none missing from the journal, heads equal. A process kill doesn't touch the page cache |
| Container kill during claims (Docker Desktop, Phase 0.5) | Passed, as **not** a durability test | 2,169 committed, none missing, heads equal |
| `fsync` latency (Docker Desktop, Phase 0) | Inconclusive as durability evidence | p50 0.26 ms; the flush may stop at the host cache |

**P7 was not genuinely tested.** Physical durability remains a production blocker.

## 5. V1–V3 decision status

| Decision | Exact definition (from the merged design, §18) | Status |
|---|---|---|
| V1 | "Bounded void memory: 64 remembered claims; fail closed beyond (section 6.2.1)" | **Awaiting approval.** The bound was used in Phase 0.5; **the overflow path is not tested** |
| V2 | "The full-verification schedule (section 6.2.2)" | **24 hours proposed by the product owner, awaiting confirmation.** Full verification also runs at start-up, before clearance and after any identity or replacement inconsistency, with immediate quarantine on failure. The quarantine column and the locked confirmation step are specified, **not prototyped** |
| V3 | "Clearance supersedes every current approval, whatever the action's status (section 9)" | **Pending your decision.** The brief follows |

### V3 decision brief

**Exact question.** Should recovery clearance supersede **every** current approval in the installation, whatever the status of its action, rather than only the approvals of `APPROVED` and `PENDING_APPROVAL` actions?

**Alternatives:**
- **A. Every current approval** (V3 as proposed).
- **B. Only the approvals of `APPROVED` and `PENDING_APPROVAL` actions** (the rule as prototyped in Phase 0 and 0.5).
- **C. Only the approvals of actions in statuses that can lead to execution:** `APPROVED`, `PENDING_APPROVAL`, and `FAILED` with outcome `not_applied` (retryable).

**Security impact:**
- **A:** no approval survives recovery, whatever an action's status. [Phase 0.5 evidence] Under B, an action whose status had been set to `PROPOSED` by hand kept 2 current approvals through clearance.
- **B** leaves approvals on actions in unexpected statuses. Today's routes supersede approvals whenever an action leaves an approvable state, so this needs a hand edit or a future bug to matter. But if one occurs, a restored approval could count again.
- **C** covers the retry path, but still depends on listing every status that can lead to execution correctly, now and in future.

**Operational impact:**
- **A:** every retry after a restore needs fresh approval. That includes `FAILED`/`not_applied` actions whose approval was given before the restore. The extra work is proportional to the uncertain actions, and is consistent with D2.
- **B:** retries of `not_applied` actions keep their approvals (less work).
- **C:** the same work as A for retries, more rules to maintain.

**Recommendation:** **A**, every current approval. It is the simplest rule, has no status list to keep right, and matches D2's intent that nothing approved before a restore counts after it.

**Consequences of choosing wrongly:**
- **Choosing B or C when A was needed:** an approval kept by an unexpected status, from a hand edit, a future route or a bug, could let a restored action run again without anyone deciding afresh. That is C1 reopened in a narrow case.
- **Choosing A when B would have done:** some extra approvals after a restore; nothing unsafe.

**Final decision: pending your approval.**

## 6. P1–P8 and P8a status

| Item | Product-owner status | Design | Prototype validation | Production integration |
|---|---|---|---|---|
| P1: savepoint-held void | Awaiting approval | Specified | Passed (Phase 0) | Not done |
| P2: short-write handling | Awaiting approval | Specified | Passed (Phase 0) | Not done |
| P3: row lock as the journal mutex | Awaiting approval | Specified | Passed (Phase 0 and 0.5, one host) | Not done |
| P4: incremental verification | Awaiting approval | Specified, with content re-hash | Passed up to 1,000,000 records (Phase 0.5) | Not done |
| P5: unknown `COMMIT` resolution | Awaiting approval | Specified, with failure classification | Passed, 5 wire-protocol scenarios (Phase 0.5) | Not done (the real driver mapping) |
| P6: clearance | Awaiting approval | Specified | Passed up to 1,000,000 actions (Phase 0.5) | Not done |
| P7: native Linux durability | Awaiting approval | Specified | **Not tested** | **Not tested** |
| P8: database guard | **Approved in principle** (16 November 2026) | Specified (§6.5) | Passed as a demonstration trigger (Phase 0.5) | Not done; the integration tests are listed |
| P8a: separate migration and runtime roles | **Approved in principle** (16 November 2026) | Specified (§6.5), with the required refusal checks | Not tested | Not done |
| P8b: emergency guard removal | **Rejected** (16 November 2026) | — | — | — |

**Reviewed for P8 and P8a** (design §6.5): trigger enforcement; the role separation, including the runtime role's inability to disable or drop the trigger; and how each of these behaves:
- an older API and an older worker;
- direct database transitions;
- retry and reconcile;
- mixed-version deployments;
- a partly applied migration, which fails closed;
- downgrade and rollback.

Both remain **approved in principle, not production-validated.** Production migrations and database roles were not changed.

## 7. Backup retention

- **Proposed: 30 days.** A **proposal only, not approved.**
- Journal retention stays at least as long as the oldest restorable backup.
- The off-host journal copy is read-only.
- The journal and the database are never restored from the same recovery set.

## 8. Accepted risks (acceptance pending explicit approval)

- **Coordinated database and journal snapshot rollback:** undetected. A snapshot or clone of both volumes from the same moment leaves both sides agreeing.
- **Journal truncation to a trusted head:** undetected. [Phase 0 evidence] Case 15 shows it trusted.
- **No external cryptographic anchor:** D3 (off-host anchor) and N7 (keyed integrity) are deferred.
- **No multi-host guarantee:** N10. One API host only.

## 9. Maximum installation size: proposal

**Evidence:** clearance passed up to **1,000,000 actions, 2,000 organisations and 1,400,000 approvals**, on one development machine (Docker Desktop, Apple silicon):
- 10.3 s in one transaction;
- 246 MB peak in the process;
- claims waited for the whole clearance, and routes on affected rows waited at most 2.9 s.

Nothing was measured on the supported platform.

**Proposal** (awaiting your decision):
- **Treat 1,000,000 actions as the tested envelope, not a capacity guarantee.**
- **Confirm or revise it** by repeating the P6 clearance tests on the supported Linux platform, at **at least twice** the largest installation you expect. Record the clearance time, memory, and claim and route lock waits.
- **Set the supported maximum from those results.** Recommended criteria: clearance completes in one transaction within a duration you're willing to accept during a recovery, and route waits stay below an agreed bound.

## 10. Remaining production blockers

1. **P7, native Linux durability:** not tested (section 2 lists the infrastructure needed).
2. **Product-owner decisions:**
   - V2 (24 hours, to confirm);
   - V3 (pending);
   - V1, P1–P7 (awaiting approval);
   - the backup retention duration (30 days proposed);
   - acceptance of the risks in section 8;
   - the maximum installation size (section 9);
   - final approval of the revised design;
   - the production implementation scope.
3. **Production integration testing** of everything, since nothing is implemented. That includes:
   - the P8 and P8a integration tests;
   - the P5 driver mapping;
   - the V1 overflow path;
   - V2's quarantine column and locked confirmation;
   - V3.
4. **Phase 0 evidence:** the 11 exact original inputs and 4 post-experiment files exist only locally. Committing them needs authorisation (see the Phase 0 report's erratum).

## 11. Recommendation

**Proceed with the remaining decisions and the native Linux durability test. Do not start production implementation yet.**

The design is complete enough to take the decisions above:
- P4, P5 and P6 passed in prototypes up to 1,000,000 records and actions;
- the downgrade gap has an approved-in-principle remedy (P8, P8a).

Nothing found argues for stopping or for another design revision. Physical durability (P7), though, is untested, and the readiness gate makes it a precondition of production authorisation.

---

**Files changed** (documentation only):
- `docs/post-restore-remediation-safety-design.md`: V2 proposal, P8, P8a, P8b statuses, retention proposal, named risks;
- `docs/post-restore-remediation-safety-decision-review.md`: the dated product-owner statuses;
- this report.

**What was not done:**
- no production code, schema, migration, role or infrastructure change;
- no backup or restore;
- no webhook or model call;
- no deployment;
- `main` is untouched.

This is not a claim of pilot or production readiness.
