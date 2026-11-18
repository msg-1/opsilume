# M16 P7: post-commit review of the durability harness

**Date:** 18 November 2026. **Reviewed commit:** `462f5d432024166c3a5a73c2a3024ef011ad8133` on `prototype/m16-p7-durability-harness` (parent `a12e6156033a8ea240cef7d007357cc10e2a277e`).

**P7 remains NOT TESTED and NOT PASSED.** This is a review of source code, with unit-level reproductions on a development machine. Nothing ran in Docker, on a Linux host, or under a power cut. No production recovery implementation is authorised.

All paths are relative to `prototype/m16-p7/` unless they start with `../`.

## 1. Executive summary

- **No Critical finding.** No path was found that writes to the journal after a remembered write failure, touches a protected volume, or sends a request to a remediation destination.
- **Two recorder availability defects, demonstrated.** One unauthenticated request can end the recorder process (F1); so can any rejected request once a rejection log cannot be appended to (F2). Neither changes a ledger. Seven new regression tests fail against this commit because of them. They are not fixed.
- **One repair defect, demonstrated, that matters for physical cycles (F3).** If a torn final journal line holds bytes that are not valid UTF-8, `recover`'s own repair record leaves the journal corrupt. A power cut is what produces such tails. The cause is in the reused Phase 0.5 verifier.
- **One evidence gap in the verdict (F4).** `check` records a journal write failure but does not use it. A cycle can be reported PASS with the marker present, and can count if the marker is lost and the failure came after the cut was requested.
- **Stop condition:** not met. It asks for a Critical or High issue that could invalidate the harness's safety assumptions. F1 is rated High for availability, but no finding lets a cycle pass without the comparison of journal, database and acknowledgements, and none breaks fail-closed behaviour (section 4.1).
- **Recommendation:** do not run a Docker smoke on this commit. Fix F1 to F4 first, with their tests, in a local step without Docker; then the isolated smoke (section 7).

## 2. Commit and branch identity

Verified at the start and again at the end of the review:

| Item | Value |
|---|---|
| Branch | `prototype/m16-p7-durability-harness` |
| HEAD | `462f5d432024166c3a5a73c2a3024ef011ad8133` |
| Parent | `a12e6156033a8ea240cef7d007357cc10e2a277e` |
| Staged files | 0 |
| Tracked files changed | 0 |
| Untracked files | 2, both from this review: this report, and `test/recorder-availability.test.mjs` (added at the product owner's request) |

The worktree is therefore **not clean for packaging**: a source package must be made from a commit, and the two untracked files are not in one.

## 3. Files and execution paths reviewed

Three readers, working separately. Two were independent reviewers who were given the commit and questions, not conclusions; every finding of theirs that is reported here as confirmed was re-read in the code by the author of this report.

| Reader | Read in full |
|---|---|
| Reviewer A (test-machine side) | `p7.mjs`; `lib/failclosed.mjs`, `worker.mjs`, `pacer.mjs`, `sizing.mjs`, `scan.mjs`, `verdict.mjs`, `preflight.mjs`, `ledger.mjs`, `protocol.mjs`, `readiness.mjs`, `source.mjs`, `netcheck.mjs`, `gateway.mjs`; `../m16-phase05/lib/journal.mjs`, `proto.mjs`; three test files |
| Reviewer B (recorder, network, scripts) | `recorder.mjs`; `lib/protocol.mjs`, `ledger.mjs`, `lock.mjs`, `readiness.mjs`, `sizing.mjs`, `package.mjs`, `source.mjs`, `measure.mjs`, `gateway.mjs`, `netcheck.mjs`; `gateway.mjs`; `firewall/p7-firewall.sh`; both Compose files; `smoke-containers-down.sh`, `smoke-teardown.sh`, `host-evidence.sh`, `test-teardown-with-stubs.sh` |
| This report's author | `lib/protocol.mjs` and `lib/netcheck.mjs` in full; the recorder's request handler; every line cited in section 4 |

**Read in part only:** `smoke-docker-desktop.sh` (long lines cut), `test-containers-down-with-stubs.sh`, `test/recorder.test.mjs`, `test/harness.test.mjs`, `test/pacer.test.mjs`. **Not read in this review:** the README and checklist beyond the passages cited.

**Paths traced:**
- a journal write failure, through claim, void, dispatch intent, clearance record and the repair record, in the same worker, another worker, another process and after a reboot;
- `check` and `recover`, including re-runs after each possible stop;
- a request through authentication, the lock, each handler and each ledger write;
- sizing, pacing and what is reported to the recorder;
- the package check at `create-run` and the identity check at every start;
- every command in the scripts that can create, stop or remove something, with what selects its target.

## 4. Findings

Severity is for the harness as a test instrument. Basis is one of: **committed test**, **new test** (`test/recorder-availability.test.mjs`), **scratch reproduction** (described in the finding), **read in code**, **reported, not verified** (by a reviewer; not re-read by this author), **needs Docker or Linux**.

### 4.1 What each finding can and cannot cause

| | Counted PASS that should not count | Journal write after a remembered failure | Protected volume touched | Request to a real destination |
|---|---|---|---|---|
| F1, F2 | No | No | No | No |
| F3 | No (the run stops) | No (the write is the repair itself) | No | No |
| F4 | **Possible, narrowly** (see F4) | No | No | No |
| F5 to F9 | No | F5: yes, **after a recorded recovery failure**, not after a write failure | No | No |
| F10 to F24 | No | No | F12: the smoke state volume is mounted read-only by a dry run | No |

**On F4 and the stop condition.** In the one case that ends in a counted PASS, the comparison still ran in full: every acknowledged claim was found in the journal and the database after the reboot, and each was acknowledged only after its own sync succeeded. The PASS is not false about those claims. What is missing is that the cycle saw a storage error, which should make it INCONCLUSIVE. That is an evidence gap, not a breach of a safety assumption, so the stop condition is not met. It must still be fixed before any qualifying cycle.

### 4.2 High

**F1. One unauthenticated request ends the recorder process.**
- **Where:** `recorder.mjs:408`, `new URL(req.url, 'http://x')`. It is the first statement of the request handler; the `try` begins at `:442`; there is no process-level handler.
- **Scenario:** any client that can reach the recorder's port sends `GET http://[ HTTP/1.1`. Also `GET //[` and `GET http://x:99999/`. `TypeError: Invalid URL` (`ERR_INVALID_URL`) is thrown at `recorder.mjs:408` and the process exits. Targets such as `/%ZZ`, `*` and `/runs/s1?%` are answered normally.
- **Basis:** new test (three tests, failing); scratch reproduction with a real server in its own process on the loopback address; found independently by Reviewer B with `GET //`.
- **Impact:** no ledger changes (every file was byte for byte the same). While the recorder is down, acknowledgements fail, the worker stops and the cycle is INCONCLUSIVE, which ends a qualifying series. The gateway forwards raw TCP, so anything on the harness's internal network can send it too.
- **Severity note:** Reviewer B rated this High. This author first reported it as an availability defect without a rating. It is High for availability: trivial, unauthenticated, and enough to end a series. It does not invalidate a safety assumption (section 4.1).
- **Correction (not implemented):** put the whole handler in one `try`; answer 400 for a target that is not a valid URL and write nothing. No process-wide catch-all: that would hide other faults.

### 4.3 Medium

**F2. Any rejected request ends the recorder process when a rejection log cannot be appended to.**
- **Where:** `lib/ledger.mjs:27` throws `LEDGER_TORN`; it is reached from `recorder.mjs:132` via `:435`, called at `:438` (unsigned, bad MAC, stale, replayed) and `:441` (an authenticated request with a malformed body); and from `recorder.mjs:370`, called at `:412` (unknown path) and `:415` (unknown run). All four call sites are before the `try` at `:442`.
- **The condition, exactly:** the log's final line has no newline (a writer died mid-line). It is not a parsing problem: an empty log is fine, and a complete line that is not JSON does not crash (every request for that run is then answered 500, valid ones included). It is also broader than a fragment: any failed append crashes the same way. A read-only log file (`EACCES`) was reproduced; a full disk would take the same path and was not reproduced.
- **Basis:** new test (four tests, failing); scratch reproduction; found independently by Reviewer B.
- **Impact:**
  - It persists: after a restart the next rejected request ends the process again.
  - `p7.mjs netcheck` sends an unsigned request on purpose at every preflight and every cycle start, so the harness itself triggers it.
  - **Evidence is preserved:** the fragment is byte for byte the same after the crash and after a restart; nothing is appended, removed or rewritten (new test, passing).
  - **One effect on evidence:** with the log unwritable, a refusal of an authenticated request inside the `try` is answered 500 and is not recorded (new test, passing as a characterisation). The count of authenticated refusals is what makes a cycle INCONCLUSIVE.
  - Reads skip a fragment silently, so `status` and `verify-dir` do not show that a ledger is damaged.
- **Correction (not implemented), with its safety implications:** catch a failed rejection write, answer the request, keep serving. Three conditions: (a) if an authenticated refusal cannot be recorded while a cycle is open, mark that cycle damaged in memory, as `recorder.mjs:533` already does for a failed acknowledgement write, so the refusal is not silently lost; (b) never repair, truncate or rewrite the fragment; (c) make `verify-dir` and `status` report a ledger that ends in a fragment.

**F3. The torn-tail repair makes the journal corrupt when the fragment is not valid UTF-8.**
- **Where:** `lib/scan.mjs:101` writes `ignoredBytes: tornBytes + 1`, the raw byte count. `../m16-phase05/lib/journal.mjs:72` measures the same line as `Buffer.byteLength` of the decoded text, where each invalid byte has become three; `:76` then refuses the repair record. `p7.mjs:605` writes the repair.
- **Scenario and reproduction:** a journal with one claim, then a fragment, then `repairBytes(...)` appended, then a full verification.

  | Fragment | Before | After the repair |
  |---|---|---|
  | `{"type":"cla` (ASCII, 12 bytes) | `torn_tail` | `ok` |
  | `7b 22 ff fe 80 41` (6 bytes) | `torn_tail` | **`corrupt`: line is not a record** |
  | a two-byte character cut in half (7 bytes) | `torn_tail` | **`corrupt`: line is not a record** |
  | 16 zero bytes | `torn_tail` | `ok` |

- **Basis:** scratch reproduction at library level, by Reviewer A and repeated by this author. That `recover` then stops the run (`p7.mjs:608`) is read in code.
- **Impact:** the harness's own write turns a repairable journal into a corrupt one. It fails closed, and `check` has already copied the journal as found. But a block of garbage at the tail is what a power cut can leave, so this would end a physical series for a reason the harness created. No committed test covers a non-ASCII fragment.
- **Correction:** verify the repair in memory (journal bytes plus repair bytes through the verifier) before writing anything, and refuse a fragment the verifier would not accept afterwards. The length mismatch itself is in the Phase 0.5 verifier, which is reused unchanged by decision: **where to fix it is the product owner's decision,** and it is also a finding for the production design's repair rule (N1).
- **Blocks:** physical cycles. It does not block a Mac smoke.

**F4. `check` does not use a journal write failure in its verdict.**
- **Where:** `p7.mjs:535` stores `journalWriteFailure` in the result; `p7.mjs:511` builds the verdict without it. The worker's stop event is best effort (`p7.mjs:434`, errors ignored) and counts only before the cut (`recorder.mjs:348`).
- **Scenarios:**
  1. The marker is present after the reboot: `check` can still say PASS and exit 0. `recover` then stops the run (`p7.mjs:586`), so the cycle stays `PENDING_RECOVERY` and never counts. Misleading, not wrong.
  2. A journal write fails after the cut was requested and before the power goes, and the marker does not survive (on a device that is failing a sync, the marker's own sync is likely to fail too). Nothing then knows: the cycle can be recovered and counted.
- **Basis:** read in code.
- **Impact:** see section 4.1.
- **Correction:** make a remembered failure an INCONCLUSIVE reason in `check`; have the worker report a journal write failure as its own event kind, sent before anything else, and count it whatever its time relative to the cut.

**F5. `recover` can be run again after a recorded recovery failure.**
- **Where:** `p7.mjs:569` only looks at the stop marker. The marker is write-once (`recorder.mjs:134`), so for a run already stopped as inconclusive it stays `inconclusive`; a failed recovery adds only an event. The recorder checks that event at the final report (`recorder.mjs:635`), not before.
- **Scenario:** `recover` stops the run ("state changed since the check"). Run again, it can probe, repair, clear and retire locally before its report is refused with `recovery_failed_earlier`.
- **Basis:** read in code.
- **Impact:** the journal and database are changed after a recorded failure. Nothing is reported as recovered, and such a run cannot be continued.
- **Correction:** refuse in `recover` when the cycle's events include `recovery_failed`.

**F6. A re-run after a committed clearance loses the clearance evidence.**
- **Where:** `p7.mjs:630` (clearance), `:617` (the "already applied" branch), `:664` (report), `:665` (summary written after the report).
- **Scenario:** clearance commits, then a later step fails. The re-run infers "already applied" from trust alone and reports `cleared: true` with `digest: null`; the recorder stores the null (`recorder.mjs:644`). If writing the summary fails after the report, it is never written.
- **Basis:** read in code.
- **Correction:** write a clearance evidence file as soon as `clear` returns; in the re-run read the digest back from the journal's `cleared` record and require it; write the summary before the report.

**F7. The size check before a cycle counts only waiting actions.**
- **Where:** `p7.mjs:418`; `../m16-phase05/lib/proto.mjs:191`.
- **Scenario:** nothing moves a claimed action out of `EXECUTING`, and after a clearance those rows are still in the affected set. Over a series the set is every claim so far plus the waiting actions, which can exceed the 1,000,000 that clearance was validated at.
- **Basis:** read in code.
- **Correction:** count the affected set in the check, not only `APPROVED`.

**F8. A lost answer to the cycle start leaves a cycle that cannot start.**
- **Where:** `p7.mjs:428` (the start, after seeding), `:430` (an event that is not best effort).
- **Scenario:** the start request times out. If it was not recorded, a retry is refused because the actions exist; if it was, the process exits with no worker. Partly documented in the README for the "busy" case only.
- **Basis:** read in code. Fails closed (INCONCLUSIVE, or no start).

**F9. The dry run of `smoke-teardown.sh` is not free of side effects.**
- **Where:** `smoke-teardown.sh:48`, before the dry-run exit at `:58`.
- **Scenario:** the dry run starts a temporary container that mounts the smoke state volume read-only, and would try to pull the image if it were missing. The stub test excludes `run` from what it calls destructive.
- **Basis:** read in code. The script is disabled for removal and was not run.
- **Correction:** add `--pull never`; say so in the header, or move the marker read behind the confirmation.

### 4.4 Low

| # | Where | Finding | Basis |
|---|---|---|---|
| F10 | `p7.mjs:434`, `lib/failclosed.mjs` | The worker never reports the marker's state. `check` runs in a new process, so its `journalWriteFailure.marker` can only be `found` or absent; `NOT written` and "not confirmed" are never recorded anywhere | Read in code |
| F11 | `smoke-containers-down.sh:72, 77, 84`; `smoke-teardown.sh:42` | `for x in $(docker ...)`: if the docker call fails, the loop is empty and that check is skipped without an error. Docker itself refuses to remove a network with attached containers | Read in code |
| F12 | `smoke-teardown.sh:59` | `docker compose -p ... down` has no `-f`. From the harness directory it needs the run's variables and otherwise fails before any removal; from elsewhere it works by label. It also stops running containers | Needs Docker |
| F13 | `recorder.mjs:756` | `--command-json` is parsed after the random wait and its shape is not checked: bad JSON fails after the delay; a non-array records the cut and then fails to run it | Read in code |
| F14 | `recorder.mjs:542` | An event that names a cycle that has not started, with no cycle id, is accepted (`undefined` equals `undefined`). A `worker_stopped` stored that way later counts against the real cycle. Needs the run key; fails closed | Read in code |
| F15 | `recorder.mjs:644` | In `recovered`, the accepted-claim line is written before the event; a failure between them and a retry writes the line twice | Read in code |
| F16 | `recorder.mjs:439` | A nonce is remembered in memory at once but persisted only by handlers that write. A signed request answered 503 or 500 can be replayed after a recorder restart within five minutes | Read in code |
| F17 | `recorder.mjs:412, 415, 435` | Every unauthenticated request causes a synced append, without limit, and the rejection log is re-read in full for each cycle view | Read in code |
| F18 | `lib/netcheck.mjs:98` | Strict mode needs only one gateway bridge probe, though the gateway is on two bridges | Read in code |
| F19 | `lib/netcheck.mjs:7, 64` | With a hostname as the recorder target, a name-resolution error counts as "blocked" in strict mode, so the direct-route probes pass without testing a route | Reported, not verified |
| F20 | `firewall/p7-firewall.sh` | Re-applying leaves a moment without rules; a failure mid-way leaves a partial set; an earlier rollback timer can remove newer rules | Reported, not verified; needs Linux |
| F21 | `smoke-docker-desktop.sh:44` | Its exit trap stops only the recorder. Any failure leaves the three containers running, and the containers-down script refuses running containers, so the operator must type a Compose command by hand | Read in code |
| F22 | `p7.mjs` flag parsing | In a smoke run, `--target-rate 0` or a non-number falls through to an unthrottled run, and `--workers 1.5` is accepted. A qualifying run is not affected: its flags come from the readiness record | Reported, not verified |
| F23 | `lib/protocol.mjs:56` | No `fetch` sets `redirect: 'error'`. The gateway is a raw TCP pipe to one address and cannot redirect by itself | Read in code |
| F24 | `lib/failclosed.mjs:72` | An error before any byte is written (opening or reading the file) is remembered as a permanent write failure. Conservative, and stated in the README | Read in code |

**By design, for the product owner to confirm:** the readiness record binds the registry byte for byte, so a volume claim by any other run on the same recorder directory ends every existing qualifying run for good (`recorder.mjs:482-484`). The README says so.

### 4.5 Where committed documents are contradicted

These documents were not edited.

| Document | It says | The code |
|---|---|---|
| `README.md:243` and the commit-readiness report, section 5 | `journalWriteFailure.marker` in the check result is `written`, `found`, "not confirmed" or `NOT written` | `check` is a new process: it can only read `found`, or nothing (F10) |
| `smoke-containers-down.sh:7` | "It refuses unless ALL of this holds" | A check is skipped if its docker call fails (F11) |
| `smoke-teardown.sh` header | The dry run "checks everything, prints what would be removed" | It also starts a container on the smoke state volume (F9) |
| Commit-readiness report, section 5 | "`recover` stops the run" on a remembered failure | True. But `check` before it can say PASS (F4) |

## 5. Test evidence versus code-based inference

| Evidence | What it shows |
|---|---|
| **Committed unit tests:** the ten committed test files, run by name: 229 tests, 229 pass | The libraries behave as their tests say. None imports `p7.mjs` or `gateway.mjs` |
| **New tests,** `test/recorder-availability.test.mjs`: 12 tests, 7 fail, 5 pass | The 7 failures are F1 (3) and F2 (4), each because the server process died. The 5 passes pin that nothing is rewritten or discarded |
| **Scratch reproductions** (outside the repository; not kept) | F1, F2, F3, and the neighbouring conditions of F2 |
| **Read in code only** | F4 to F18, F21, F23, F24, and everything said about `p7.mjs` |
| **Not verified by this author** | F19, F20, F22 |
| **Cannot be settled without Docker or Linux** | F12, F20; the gateway's interface choice; what Compose does with a named, labelled volume; the firewall rules |

**Checked and found sound, by reading:**
- Every journal append goes through the wrapper: claim and void (`../m16-phase05/lib/proto.mjs:85, 96`), dispatch intent (`:54`), clearance record (`:248`), repair (`p7.mjs:605`). `p7.mjs` has no other write to the journal file.
- All workers of a process share a remembered failure; another process re-reads the marker at every `state()` and `append()`; an empty, torn or unreadable marker counts as a failure.
- Nothing deletes, renames or rewrites the marker.
- The request MAC covers method, path, run, timestamp, nonce and body hash, is compared in constant time, and is checked before staleness and replay. The client verifies the response MAC before parsing.
- A start on a qualifying run re-checks the test half, the identity, the whole binding and its digest, and the workload shape. The quiet-rate floor is enforced in sizing (`lib/sizing.mjs`) and again in the recorder's rule.
- The gateway's destination is fixed at start; it listens only on its chosen address and exits if that is ambiguous. `compose.yml` publishes no port.
- With the smoke override and a generation, the volume names always carry the generation; an empty generation is refused.
- The containers-and-networks script removes by container id and by exact network name, selected by exact project label. No selector can match the qualifying project or the default project.
- `send` and `execute` in the reused library are not imported by `p7.mjs`. Every request URL is the recorder's, or the gateway's fixed self-check address. **No path sends a remediation request.** The network check does open TCP connections, with no payload, to four fixed internet addresses and looks up `example.com`, by design (`lib/netcheck.mjs:10, 67`).

## 6. Unresolved risks and limitations

The ten limitations named for this review, each against the code:

| Limitation | What the code does | Worse than stated? |
|---|---|---|
| The journal failure marker may fail to persist | Written once, best effort, to the volume whose write failed | **Yes, in one respect:** when it is not written, nothing durable records that (F10) |
| The fail-closed guarantee is not unconditional across processes | A restarted process without a marker appends; pinned by a committed test | As stated |
| Recorder ledgers are not covered by the journal wrapper | Acknowledgement failures damage the cycle; other ledger failures answer 500 | **Yes:** a failed rejection write ends the process (F2) and can lose a refusal |
| The P7 runtime wiring has not been executed | `p7.mjs` and `gateway.mjs` are syntax-checked only. Reviewer A compared every import and call by reading and found no mismatch | As stated |
| Generation-named volumes have not been rendered or exercised | True; Compose's handling of an existing named volume was not verified | As stated |
| A hand-typed smoke Compose command without the override resolves the smoke-39 volume names | True. F21 makes a hand-typed command more likely after a failed smoke | **Slightly:** the smoke script's failure path leads to one |
| Image identity is declared, not verified | True | As stated |
| The source digest is not recursive | True; the package parser also stops at the first zero block and lets the last global header win | As stated |
| The recorder checks files on disk, not the running process | True | As stated |
| No native Linux durability or physical power-cut test has occurred | True | As stated |

Other open risks: the bridge subnets are not fixed (deferred by decision); the cut-once unit test depends on a two-second window; some committed tests are weaker than their names (listed in the commit-readiness report).

## 7. Recommended next steps, in dependency order

1. **Decide where F3 is fixed** (the Phase 0.5 verifier, or a check in the harness before it writes a repair). Product-owner decision.
2. **Fix F1 and F2 in the recorder,** under the three conditions in F2. Their regression tests exist and fail today.
3. **Fix F3 and F4,** each with a test written first. F4 needs the worker to report a journal write failure as its own event.
4. **Fix F5 and F6** (recovery re-run and clearance evidence), then F7.
5. **Correct the documents** listed in section 4.5, and decide whether the low findings F9 to F18 are fixed now or recorded.
6. **Re-run the local checks and review the fixes.** Commit only on the product owner's authorisation.
7. **Only then, the isolated Docker smoke on the development machine,** which needs its own authorisations. Not executed and not recommended on this commit.
   - **Prerequisites:** steps 2 to 6 done and committed; the earlier smoke's stopped containers and networks removed with `smoke-containers-down.sh` (dry run first; a separate authorisation); a new `P7_SMOKE_GENERATION`; the image present locally, so that nothing is pulled.
   - **Risks:** it is the first execution of `p7.mjs`, the gateway's listener binding and the generation-named volumes, so plain bugs are likely; the gateway's self-check opens connections to four fixed internet addresses and the harness looks up `example.com`; a failed run leaves containers running (F21); a Compose command typed by hand without the override resolves the preserved smoke-39 volume names; `up` would pull a missing image.
8. **Physical cycles** stay unauthorised, and additionally need F3 fixed and the host preparation completed.

## 8. Tests and commands not run

- No `docker` or `docker compose` command, including rendering a Compose file.
- No `p7.mjs` command: `init`, `run`, `check`, `recover`, `adopt`, `preflight`, `netcheck`, `boot-probe`. No `gateway.mjs`.
- No `recorder.mjs` operator command. The recorder's server code was started only in scratch and test processes, on temporary directories and the loopback address.
- No teardown or volume-removal script, and **not the two stub suites either** (`test-containers-down-with-stubs.sh`, `test-teardown-with-stubs.sh`): they execute the teardown scripts against a stub, which this review's restrictions exclude.
- No firewall script, no `host-evidence.sh`, no smoke script.
- No request to any external service.
- The whole test directory as one glob was not used as a result: it now includes the new file and shows its 7 intended failures. The ten committed files were run by name.

What was run: `git` read commands; `cat`, `sed`, `grep`; `node --check`; `node --test` on test files; scratch scripts outside the repository that import the libraries read-only and write only to temporary directories. The two independent reviewers were instructed to the same limits and reported keeping to them; one imported `recorder.mjs` into a scratch script, with no socket.

## 9. Status

**P7 remains NOT TESTED and NOT PASSED.** This review found defects in the harness and fixed none. It establishes nothing about native Linux durability, physical power-loss safety or production readiness, and it is not approval to implement the production recovery mechanism.

## 10. Resolution of F1 to F4 (added 18 November 2026, after the review)

Sections 1 to 9 are left as written: they describe commit `462f5d4`. This section records what was changed afterwards, in the working tree, uncommitted. **P7 remains NOT TESTED and NOT PASSED.**

| Finding | Status | What was done |
|---|---|---|
| **F1** (malformed target ends the recorder) | **Fixed** | The handler runs inside an error boundary. A target that is not a URL is answered `400 bad request target`; nothing is read or written for it, not even a rejection line. `recorder.mjs` |
| **F2** (failed rejection write ends the recorder) | **Fixed,** with one stated limit | A rejection that cannot be logged no longer ends the server. Unauthenticated requests are answered as before (the network check's unsigned probe still gets 401). An authenticated refusal is answered `500 refusal_not_recorded` and kept as an event in the run's ledger, where it still counts against its cycle; if that fails too, the server accepts no further acknowledgement and no PASS for the open cycle. `verify-dir` reports a ledger that ends in a fragment, and a cycle start is refused beside one. **Limit:** the "no further acknowledgement" flag is in memory and does not survive a recorder restart; an unauthenticated rejection that cannot be logged leaves only a stderr line |
| **F3** (non-UTF-8 torn tail made corrupt by the repair) | **Mitigated, NOT resolved** | The harness no longer writes a repair the verifier would refuse: the journal is left byte for byte as found, still a torn tail (`lib/scan.mjs`, `repairProblem`; `p7.mjs recover` exits 8 without stopping the run). **Open:** such a cycle cannot be recovered at all, so a series would end there; and `check` can still give a provisional PASS for it while `recover` refuses (final status `PENDING_RECOVERY`, never PASS). Both need the decision below |
| **F4** (`check` ignored a journal write failure) | **Fixed,** with the wrapper's stated limit | A marker, or a failure a worker reported to the recorder at any time in the cycle, makes the cycle INCONCLUSIVE (`JOURNAL_WRITE_FAILED`); a failed comparison stays FAIL. The worker reports the failure as its own event with the marker's state (this also answers F10). The recorder refuses a PASS and a recovery for such a cycle, and a PASS whose result carries the marker. **Limit, unchanged:** a failure whose marker is lost and whose report never arrived is known to nobody |

**Decision needed for F3 (Phase 0.5 was not modified).** The cause is one expression in the reused verifier, `../m16-phase05/lib/journal.mjs:72`: the ignored line is measured as `Buffer.byteLength` of its decoded text. Measuring its raw bytes instead would let a repair record describe any fragment.
- *What it changes:* for a fragment that is valid UTF-8 the two measures are equal, so every journal that verifies today verifies the same. Only fragments that are not valid UTF-8 are affected: they would become repairable.
- *What it touches:* the Phase 0.5 library is "reused unchanged" by decision; its own results were produced with the current rule; the harness's source digest changes, so both hosts need the same new commit; every statement that Phase 0.5 is unchanged would have to be corrected. The production design's repair rule (N1) should say in which unit the length is counted.
- *If it is not changed:* a torn tail with invalid bytes ends a series, without damage to the journal. In that case `check` should also report such a cycle as INCONCLUSIVE instead of a provisional PASS; that was not done here, because it would be recorded for good while the decision is open.

**Tests.** `test/recorder-availability.test.mjs` was extended after sections 1 to 9 were written: it now holds 18 tests. The seven that failed against `462f5d4` pass. One test of the original twelve was replaced: the characterisation "an authenticated refusal is answered 500 and is NOT recorded" became "…kept as an event instead", because the fix changed that behaviour on purpose. New files: `test/repair-utf8.test.mjs` (11 tests), `test/journal-failure-verdict.test.mjs` (5 tests); five tests were added to `test/harness.test.mjs`. No committed assertion was removed or changed. Whole unit suite: 268 tests, 268 pass.

**Section 4.5, documents contradicted by the code:** the README sentence about `journalWriteFailure.marker` is corrected. The other three rows (the containers-down header, the teardown dry run, and `check` saying PASS before `recover` stops) are as follows: the last is resolved by F4; the two script rows are **unchanged**, because no script was edited.

**Not addressed here:** F5 to F9 and the low findings, except F10. `p7.mjs` has still never run: its part of F3 and F4 is syntax-checked only.

## 11. Product-owner decision on F3, and what followed (added 18 November 2026)

**Decision:** `prototype/m16-phase05/lib/journal.mjs` stays unchanged. The mitigation of section 10 is accepted temporarily: the invalid bytes are preserved exactly as found, no repair record is written that the verifier would classify as corrupt, recovery stops safely, and such a cycle must not count as PASS. The harness was then changed so that the condition is INCONCLUSIVE instead of a provisional PASS. Still uncommitted.

| Part | Behaviour for a torn final line that is not valid UTF-8 |
|---|---|
| `check` | INCONCLUSIVE, reason `TORN_TAIL_NOT_REPAIRABLE` (`lib/verdict.mjs`, `classifyCycle`; `p7.mjs` passes it `repairProblem`'s answer). A failed comparison stays FAIL |
| `recover` | Stops before it probes, repairs, clears or retires anything: evidence file `recovery-not-possible-*.json`, exit 8, no repair record, journal byte for byte as found |
| Recorder | Stores no PASS for such a result (`pass_reports_a_torn_tail_that_cannot_be_repaired`); accepts no recovery for the cycle (`torn_tail_cannot_be_repaired`) |
| Final status | INCONCLUSIVE, with or without a recovery record |

- **This supersedes** the sentence in section 10 that `check` can still give a provisional PASS for such a cycle: it no longer can.
- **A torn tail that is valid UTF-8 is unchanged:** provisional PASS, repaired by recovery, PASS once recovered.
- **Tests:** the exact bytes `7b 22 ff fe 80 41` in `test/harness.test.mjs` (classification, final status, nothing written, no repair record) and `test/journal-failure-verdict.test.mjs` (the recorder's two refusals); three kinds of valid UTF-8 tail for the unchanged behaviour. Written first; three failed before the change.
- **Consequence, stated plainly:** in a qualifying run INCONCLUSIVE ends the series, and since the cycle cannot be recovered, nothing can continue from that database and journal. **Physical power-cut testing cannot proceed through this condition** until the verifier's length rule is resolved in a separately approved change. A power cut can produce such a tail.
- **F3 is therefore handled safely but not resolved:** the limitation is still in the verifier.
- **Never executed:** `p7.mjs check` and `recover`; their part of this is syntax-checked only.

**P7 remains NOT TESTED and NOT PASSED.**

## 12. Second safety review: F14 and one new finding, fixed (added 18 November 2026)

Sections 1 to 11 are unchanged. A second safety review is in progress; its own report will list every remaining finding. Two findings from it were confirmed and, by the product owner's authorisation, fixed in the working tree. Still uncommitted. **P7 remains NOT TESTED and NOT PASSED.**

| Finding | Status | What was done |
|---|---|---|
| **F14** (section 4.4): an event naming a cycle that had not started, with no cycle id, was accepted | **Fixed** | It was more than a stray record: a `worker_stopped` stored that way later appeared in the real cycle's `workerStopsBeforeCut` and made it INCONCLUSIVE (reproduced). Now an event that names a cycle is accepted only for a cycle that has started, with that cycle's id as a string, exactly; a `worker_stopped` must name its cycle and only the open one. `recorder.mjs`; `test/cycle-events.test.mjs` (7 tests, 4 of them failing before the change) |
| **New, finding A of the second review:** a cycle that could never be closed (Medium) | **Fixed,** with one stated limit | Introduced by a guard added in section 10: the recorder refused a PASS for a cycle with damaged acknowledgement records, but its cycle view did not show the damage, so `check` computed PASS, saved it write-once and re-sent the same refused result on every run (reproduced at the recorder). Part 1: the served cycle view reports `damage` (the acknowledgement ledger, and what only the running server knows), and `check` makes any damage INCONCLUSIVE (`RECORDER_CYCLE_RECORDS_DAMAGED`) before it saves a result. Part 2: a saved result the recorder refuses is marked, kept and never re-sent, and the next `check` makes a fresh attempt in its own directory, with its own identity (`lib/attempts.mjs`). `recorder.mjs`, `lib/verdict.mjs`, `p7.mjs`; `test/cycle-closure.test.mjs` (9 tests). **Limit:** the server-memory part of the damage is lost if the recorder restarts before the check |

**Not proven by tests:** `p7.mjs check` cannot be run outside the image. The sequence test drives the same library functions against a real in-process recorder; the lines in `p7.mjs` that call them are syntax-checked and read, not executed.

Whole unit suite after these changes: 291 tests, 291 pass. F5 to F9 and the other low findings of section 4.4 are not addressed.

## 13. Status of every finding of section 4 after the hardening mission (added 18 November 2026)

Sections 1 to 12 are unchanged. The complete register, with the findings of the second safety review and of the final review of the fixes, is in `docs/m16-p7-second-safety-review.md` and `docs/m16-p7-hardening-progress.md`. Still uncommitted. **P7 remains NOT TESTED and NOT PASSED.**

| Finding | Status |
|---|---|
| F1, F2, F4 | Fixed (sections 10 and 12, extended since) |
| F3 | Mitigated: INCONCLUSIVE, never repaired; the verifier is unchanged by decision (section 11) |
| F5, F6 | Fixed: the rule and the evidence helpers are in `lib/recovery.mjs` and tested; their calls in `p7.mjs` have never run |
| F7 | Fixed by the product owner's decision: the 20-cycle series is planned before it starts, bound in the readiness record, and the actual count is checked before every cycle |
| F8 | Mitigated: a lost note after the start no longer leaves a started cycle without workers; a lost start answer is still a stop |
| F9, F11, F12, F20, F21 | **Open.** The scripts were not changed, because they cannot be exercised under the restrictions these changes were made under |
| F10, F13, F14, F15, F18, F19, F23 | Fixed, each with a test |
| F16, F17, F22 | Open, recorded with reasons |
| F24 | By design |

Section 4.5 (documents contradicted by the code): the README sentence is corrected; the two script rows are unchanged, because no script was edited.
