# M16 P7: second safety review of the durability harness

**Date:** 18 November 2026. **Branch:** `prototype/m16-p7-durability-harness`. **HEAD:** `462f5d432024166c3a5a73c2a3024ef011ad8133`. Everything reviewed and changed since is in the working tree, uncommitted.

**P7 remains NOT TESTED and NOT PASSED.** This is a review of source code with unit-level reproductions on a development machine. Nothing ran in Docker, on a Linux host, or under a power cut. `p7.mjs` and `gateway.mjs` have never been executed.

All paths are relative to `prototype/m16-p7/` unless they start with `../` or `docs/`. Line numbers are those of the working tree when this report was written.

## 1. Executive summary

- **No Critical or High defect is open.** No path was found to a stored PASS for a cycle with a known journal write failure, an unrepairable torn tail or damaged recorder records; none that loses an acknowledged claim; none that sends a request to a remediation destination.
- **This review found two defects of its own and an independent reviewer found twelve more** (C1 to C12), none above Medium. Two of the Medium ones were gaps left by the previous round of fixes: a cycle that could never be closed (A), and a recovery that was accepted after the failure marker had disappeared (C1).
- **By the product owner's authorisation, the confirmed findings that could be fixed and tested without Docker were fixed,** each with a test written first. Section 3 gives every finding's status.
- **Still open, with reasons:** the script findings (F9, F11, F12, F20, F21), because the scripts cannot be exercised under the restrictions; four low findings (F16, F17, F22, C6); part of F8; and one decision (the D1 recorder gate, section 8). F7 was decided and implemented (end of section 3.4).
- **The stop condition was not met** at any point.

## 2. Branch and commit verification

| Item | Value |
|---|---|
| Branch | `prototype/m16-p7-durability-harness` |
| HEAD | `462f5d432024166c3a5a73c2a3024ef011ad8133` (parent `a12e6156033a8ea240cef7d007357cc10e2a277e`) |
| Staged | Nothing |
| `prototype/m16-phase05/`, `apps/`, `services/` | No change |
| Scripts and Compose files | No change |

## 3. Finding register

Severity is for the harness as a test instrument. **Affects:** I integrity, A availability, D durability, S security, O operator safety. Basis: *test* (a unit test exercises the real code), *scratch* (reproduced in a scratch process on temporary directories), *read* (read in code only).

### 3.1 Findings of the post-commit review (F)

| ID | Sev | Affects | Finding | Status | Where; evidence |
|---|---|---|---|---|---|
| F1 | High | A | Malformed request target ended the recorder | FIXED | `recorder.mjs` handler boundary; test `recorder-availability` (real server in its own process) |
| F2 | Med | A, I | Failed rejection write ended the recorder | FIXED | `recorder.mjs` `refuse`, `globalReject`; test `recorder-availability`, `recorder-hardening` |
| F3 | Med | I, O | Torn tail the verifier cannot accept a repair for was made corrupt | MITIGATED: INCONCLUSIVE, no repair, journal as found. The verifier is unchanged by decision, so such a cycle cannot be recovered | `lib/scan.mjs` `repairCheck`; tests `repair-utf8`, `harness` |
| F4 | Med | I | `check` ignored a journal write failure | FIXED | `lib/verdict.mjs`; recorder refusals; tests `harness`, `journal-failure-verdict` |
| F5 | Med | I, O | `recover` could run again after a recorded recovery failure | FIXED in the rule (`lib/recovery.mjs`, test `recovery`); its call in `p7.mjs:612-615` is unexecuted |
| F6 | Med | I | Clearance evidence lost on a re-run | FIXED: evidence file written as soon as a clearance commits and read back by a re-run; summary written before the report | `lib/recovery.mjs` (test `recovery`); `p7.mjs` calls unexecuted |
| F7 | Med | A | The size check before a cycle counted only waiting actions, while the affected set grows over a series | FIXED by the product owner's decision: the series is planned before it starts and the actual count is checked before every cycle (see the end of section 3.4) | `lib/sizing.mjs`; test `series-plan`; the count in `p7.mjs` is unexecuted |
| F8 | Med | A, O | A lost answer to the cycle start left a cycle that cannot start, or a started cycle without workers | MITIGATED: the note after the start is best effort, so workers run. A lost start answer is still a stop | `p7.mjs:429-433`; read; no test (p7 only) |
| F9 | Med | O | The dry run of `smoke-teardown.sh` starts a container on the smoke state volume | OPEN: script not changed | `smoke-teardown.sh:48, 58`; read |
| F10 | Low | I | The marker's state was never recorded | FIXED with F4: the worker reports it | `p7.mjs:435-444`; recorder side tested; p7 side unexecuted |
| F11 | Low | O | `for x in $(docker ...)` skips a check when the call fails | OPEN: script not changed | `smoke-containers-down.sh:72, 77, 84`; `smoke-teardown.sh:42`; read |
| F12 | Low | O | `compose down` without `-f` in the teardown | OPEN: script; needs Docker | `smoke-teardown.sh:59`; read |
| F13 | Low | O | `--command-json` was parsed after the wait | FIXED | `recorder.mjs` `parseCutCommand`; test `recorder-hardening` |
| F14 | Low | I | An event for a cycle that had not started was stored | FIXED (finding B below) | test `cycle-events` |
| F15 | Low | I | Accepted-claim line written twice on a retry | FIXED | `recorder.mjs` `recovered`; test `recorder-hardening` |
| F16 | Low | S | A nonce is persisted only by handlers that write: a request answered 503 or 500 can be replayed after a recorder restart within five minutes | OPEN. The simple correction (refuse timestamps older than the server's start) would refuse honest requests after a restart and make their cycle INCONCLUSIVE | `recorder.mjs:509`; read |
| F17 | Low | A | Unbounded synced appends for unauthenticated requests | OPEN | `recorder.mjs` `globalReject`, `refuse`; read |
| F18 | Low | S | Strict network check needed only one gateway bridge probe | FIXED | `lib/netcheck.mjs`; test `netcheck` |
| F19 | Low | S | A host name as target passed the strict route probes | FIXED | `lib/netcheck.mjs`; test `netcheck` |
| F20 | Low | S, O | Firewall re-apply window and partial rule sets | OPEN: script; needs Linux; not verified by this review | `firewall/p7-firewall.sh` |
| F21 | Low | O | The smoke script leaves containers running after a failure | OPEN: script not changed | `smoke-docker-desktop.sh:44`; read |
| F22 | Low | O | Smoke-run flag parsing (`--target-rate 0`, `--workers 1.5`) | OPEN; a qualifying run takes its flags from the readiness record | `p7.mjs:362, 376`; read |
| F23 | Low | S | The client followed redirects | FIXED. Reproduced first: a 307 made the client send the signed request to the redirect's target | `lib/protocol.mjs:56`; test `client`; three `fetch` calls in `p7.mjs` unexecuted |
| F24 | Low | A | An error before any byte is written is remembered as a write failure | BY DESIGN, stated in the README | `lib/failclosed.mjs:72` |

### 3.2 Findings of this review

| ID | Sev | Affects | Finding | Status | Where; evidence |
|---|---|---|---|---|---|
| A | Med | A, O | **A cycle could never be closed.** The recorder refused a PASS for a damaged cycle, its view did not show the damage, `check` saved PASS write-once and re-sent it on every run | FIXED. The view reports `damage` in three parts (acknowledgement ledger, the server's memory, the run's ledgers); any damage is INCONCLUSIVE before a result is saved; a refused result is marked, kept and never re-sent, and the next `check` makes a fresh attempt in its own directory | `recorder.mjs` `replayAcks`, `cycleView`; `lib/verdict.mjs`; `lib/attempts.mjs`; test `cycle-closure` (real recorder; the sequence is driven with the library functions `check` uses) |
| B (= F14) | Low | I | **A stray event contaminated a later cycle.** A `worker_stopped` sent before a cycle started, without an id, was stored and later made the real cycle INCONCLUSIVE. It could not affect an acknowledgement or produce a PASS | FIXED. An event that names a cycle needs a started cycle and that cycle's id as a string; `worker_stopped` must name its cycle and only the open one | `recorder.mjs:617-626`; test `cycle-events` |

### 3.3 Findings of the independent reviewer (C)

Each was re-read in the code by this report's author before anything was done.

| ID | Sev | Affects | Finding | Status | Where; evidence |
|---|---|---|---|---|---|
| C1 | Med | I, O | `check` found the marker and recorded it; if the marker was gone when `recover` ran, the recovery was accepted and a new run could continue that journal | FIXED: the recorder and `recover` also use what the check recorded | `recorder.mjs` `recovered`; `lib/recovery.mjs`; tests `recorder-hardening`, `recovery` |
| C2 | Med | I | With the directory lock busy, an authenticated refusal was kept nowhere but in memory; after a recorder restart the cycle could pass | FIXED: the event is appended without the lock when the lock is busy; a damaged run ledger is damage the view reports from the files, so a restart does not forget it and no PASS is stored | `recorder.mjs` `refuse`, `runLedgerDamage`; test `recorder-hardening` |
| C3 | Med | S, A | With the rejection log damaged, anyone who had captured a signed request could append lines to the run's event ledger by replaying it | FIXED: no event for a replayed or stale request | `recorder.mjs` `refuse`; test `recorder-hardening` |
| C4 | Med | A, O | The start refusal introduced earlier also looked at closed cycles' acknowledgement files and the recorder-wide rejection log: a smoke run could be left unable to start and unable to be abandoned | FIXED: only the run's events, rejections and accepted claims, and the volume registry, stop a start | `recorder.mjs:532-536`; test `recorder-hardening` |
| C5 | Low | I | A journal failure report for a cycle already checked is refused; a comment said it counts "whenever it arrives" | FIXED (comment and README). The refusal is intended: a recorded result is not contradicted afterwards | `recorder.mjs:616`; test `journal-failure-verdict` |
| C6 | Low | I | An acknowledgement file with an unreadable complete line is served as a view with no acknowledgements; the cycle is INCONCLUSIVE, not FAIL, and can be recovered | OPEN, documented. The cycle cannot pass | `recorder.mjs:349`; read |
| C7 | Low | I | A PASS whose list of reports was not an array was stored | FIXED | `recorder.mjs:709-710`; test `recorder-hardening` |
| C8 | Low | O | A second "not possible" exit in `recover` came after the quarantine probe and told the recorder nothing | FIXED: that case means the journal changed since the check, and stops the run | `p7.mjs`, repair step; read; unexecuted |
| C9 | Low | A | A size cap or a read error was recorded as "cannot be repaired", for good | FIXED: "would not verify" and "could not be determined" are separate answers; `check` saves nothing for the second | `lib/scan.mjs` `repairCheck`; test `repair-utf8` |
| C10 | Low | O | The ledger scan threw on an unreadable ledger, and a start answered with a full path | FIXED | `recorder.mjs` `ledgerProblemOf`; test `recorder-hardening` |
| C11 | Low | O | The stderr line said "nothing was accepted" though a handler can fail after a write | FIXED (wording) | `recorder.mjs:422` |
| C12 | Info | O | An unreadable ledger was answered "recorder key unreadable" | FIXED | `recorder.mjs:473`; test `recorder-hardening` |

The reviewer also showed that the repair check predicts the verifier exactly (19 named fragments and 4,000 random ones, no disagreement), and that "not valid UTF-8" is inexact wording: a few invalid sequences decode to the same length and are repairable. The code was right; the comments, messages and documents were corrected, and a test pins the exception.

### 3.4 Findings of the final independent review of the hardening diff (D)

One further reviewer read the changes made for sections 3.1 to 3.3. Each finding was re-read in the code, reproduced where it could be, and fixed in one remediation round, tests first.

| ID | Sev | Affects | Finding | Status | Where; evidence |
|---|---|---|---|---|---|
| D1 | Med | I | **The only path to a stored PASS that should not be one.** `check` re-sent a saved result as it was: (a) a PASS saved but not delivered, then an authenticated refusal in the cycle, then a re-run; (b) a PASS refused for damage held in memory, the answer lost, the recorder restarted, then a re-run. The recorder does not consult the cycle's refusals when it stores a result. Present before this review as well | FIXED in `check`: a saved PASS is checked against the cycle view before it is sent, and is marked and replaced if the view shows damage, a refusal or a journal failure report. **Open decision:** the recorder itself still stores such a PASS; a gate there conflicts with a committed test | `lib/attempts.mjs` `savedResultProblem`; `p7.mjs` resend branch (unexecuted); test `final-review` (the rule against real cycle views; the limit is pinned by a test) |
| D2 | Med | O, A | With a run ledger damaged, `recover` repaired, cleared and retired locally, and then could never report it; `/stop` answered 500 and left no stop marker | FIXED: `recover` is refused before it changes anything; `/stop` writes the marker first | `lib/recovery.mjs`; `recorder.mjs` `stop`; test `final-review` |
| D3 | Med | I | A journal write that failed inside the clearance left no stop on the recorder; the worker's failure report was sent once | FIXED | `p7.mjs` (unexecuted); read |
| D4 | Low-Med | I, O | A result that arrived late was marked "the recorder stored nothing" | FIXED: recognised by its attempt id | `lib/attempts.mjs` `sameAttempt`; test `final-review` |
| D5 | Low-Med | O | The client's error showed `refusal_not_recorded`, not what was refused | FIXED | `lib/protocol.mjs`; test `final-review` |
| D6 | Low | S | A path of the recorder host in a damage reason and in an error answer | FIXED | `recorder.mjs`; test `final-review` |
| D7 | Low | A, O | `verify-dir` threw on an unreadable directory | FIXED | `recorder.mjs` `ledgerProblems`; test `final-review` |
| D8 | Low | A | A fragment over 64 MiB could never be checked; "nothing was saved" was inexact; `recover` took a read error for a changed tail | FIXED | `lib/scan.mjs`; `p7.mjs`; test `final-review` |
| D9 | Low | A | An unparseable `result.json` was selected for re-sending for ever | FIXED | `lib/attempts.mjs`; test `final-review` |
| D10 | Low | A | A refusal on the acknowledgement path could hold the server for eight seconds | FIXED (250 ms) | `recorder.mjs` `refuse` |
| D11 | Low | I | A saved clearance was read back without checking its cycle and claim | FIXED | `lib/recovery.mjs` `clearanceMatches`; test `final-review` |
| D12 | Low | O | `run` ended with 0 after a journal write failure; `999.999.999.999` passed as an address | FIXED | `p7.mjs`; `lib/netcheck.mjs`; test `final-review` |

The reviewer read `cmdRun`, `cmdCheck` and `cmdRecover` "as if compiling them" and found every identifier defined, every argument in order, and every early return disconnecting. That is reading, not execution.

**F7, decided and implemented after section 3.1 was written:** the series is planned before it starts and the actual count is checked before every cycle (`lib/sizing.mjs` `seriesPlan`, `capacityRefusal`; the readiness record binds the planned cycles and stores the calculation; test `series-plan`). The count's SQL and its call are in `p7.mjs` and unexecuted; the recorder checks the count the test machine reports and does not refuse a start that reports none.

## 4. The four previously addressed findings

| Finding | Holds? | What the tests prove, and what they do not |
|---|---|---|
| F1 | Yes | A real server in a process of its own survives three invalid targets, an oversized body and an aborted request, answers 400, writes nothing, and serves a valid request afterwards. The outermost catch itself is not reached by any test; the inner one is |
| F2 | Yes, extended by C2, C3, C4 | The server survives a fragment, a read-only log and an unknown path or run; the unsigned probe still gets 401; the damaged log is byte for byte unchanged. An authenticated refusal is kept as an event and counts against its cycle |
| F3 | Yes, as a mitigation | At library level against the real verifier: the exact bytes `7b 22 ff fe 80 41` stay a torn tail, nothing is written, the cycle is INCONCLUSIVE, the recorder accepts no PASS and no recovery for it. Not proven: that `p7.mjs recover` takes that path, since it never ran |
| F4 | Yes, extended by C1, C7 | The classification rule, and the recorder's refusals of PASS and recovery, through the real handler. Not proven: that `p7.mjs check` passes those fields |

## 5. Disagreements with the independent reviewer

| Point | Reviewer | This report |
|---|---|---|
| C3 | Medium | Low to Medium: it needs a damaged rejection log and a captured request, and the party could already make a cycle INCONCLUSIVE by replaying. Fixed regardless |
| C4 | Medium | Agreed after re-reading: `abandon` is refused once a cycle has started, so the smoke run really was stuck. It had first been judged "by design" here |
| C5 | Suggests accepting late reports for a closed cycle | Not adopted: a stored result is never contradicted afterwards. The report is refused and logged; a worker cannot be alive after a real cut and a check |
| C6 | Suggests refusing recovery or a FAIL-class reason | Left open: the cycle is INCONCLUSIVE and cannot pass; whether an unreadable acknowledgement file should block continuing the state is a judgement for the product owner |

## 6. Test coverage gaps

- **`p7.mjs` is not executed by any test.** Every claim about `check`, `recover` and `run` is proven for the library function or the recorder handler they call. The calls themselves were read, syntax-checked, and their imports checked against the libraries' exports.
- **`gateway.mjs`** likewise.
- The sequence test for finding A uses helpers that stand in for the corresponding lines of `cmdCheck`.
- The recorder's outermost error boundary is not reached by a test.
- `verify-dir` is tested through `dirReport`; its exit status is not.
- No test covers the 64 MiB limit of the repair check.
- Some assertions on `finalStatus` use literal objects and prove only the function's rule.
- The scripts are covered only by their stub suites, which were not run in this review.

## 7. Safety guarantees: supported, conditional, unsupported

**Supported by code and tests**
- The recorder stores no PASS for a cycle with a reported journal write failure, a marker in the result, a torn tail the check found unrepairable, or damaged records.
- No request ends the recorder process; an invalid target writes nothing.
- A damaged ledger is never repaired, truncated or rewritten.
- A refused result is never re-sent and never counts; each attempt has its own directory and identity.
- An event cannot be stored against a cycle that has not started, or with another id.
- The client sends nothing to a redirect's target.

**Conditional**
- *A journal write failure stops everything that follows:* only if it is known. A failure whose marker is lost **and** whose report never reaches the recorder is known to nobody.
- *The recorder accepts nothing more for a damaged cycle:* the part held in memory is lost when the recorder restarts. What survives a restart is what is in the files: a damaged acknowledgement file, and a damaged run ledger.
- *An unrecorded authenticated refusal still makes its cycle INCONCLUSIVE:* through the fallback event, or through the damaged ledger itself. If the rejection log is healthy but a single append fails for another reason (a full disk that then recovers) and the event ledger cannot be written either, only the in-memory flag remains.
- *`check`, `recover` and the recorder agree:* shown for the rules and the recorder. For `p7.mjs` it rests on unexecuted lines.
- *Strict network isolation:* shown with fake probes. The firewall and the gateway's interface choice have never run.

**Unsupported until something is executed**
- That `p7.mjs` and `gateway.mjs` run at all.
- That Compose creates generation-named volumes as written.
- Anything about native Linux durability or a physical power cut.

**Limitations that stand**
- A journal failure marker that cannot be written, or whose own sync fails, may not be there after a restart.
- A torn final line the unchanged Phase 0.5 verifier cannot accept a repair for cannot be recovered; a series ends there, safely. Physical power-cut testing cannot proceed through that condition.
- The image identity is declared, not verified; the source digest is not recursive; the recorder checks files on disk, not its running process.
- A Compose command typed by hand for the smoke project without the override resolves the preserved smoke-39 volume names.

## 8. Recommended order for what remains

1. **Product-owner decision on the D1 recorder gate:** should the recorder itself refuse a PASS for a cycle with authenticated refusals on record? It is defence in depth behind `check`; adopting it means rewriting a chain of committed recorder tests that store a PASS in such a cycle.
2. **The script findings** F9, F11, F12, F21, and F20, in a step where the stub suites may be run, and for F12 and F20 where Docker or Linux is available.
3. **F8 (a lost start answer), F16, F17, F22, C6:** fix or accept.
4. **Isolated Docker smoke,** under its own authorisation. It is the first execution of `p7.mjs` and `gateway.mjs`. No open finding is Critical or High; F21 and the hand-typed-command risk make its failure path awkward, and a great deal of `p7.mjs` has changed without ever running.
5. **Physical cycles** stay unauthorised.

## 9. Commands and tests not run

- No `docker` or `docker compose` command, including rendering a Compose file.
- No `p7.mjs` command and no `gateway.mjs`. No `recorder.mjs` operator command; the recorder's server code ran only inside unit tests and scratch scripts, on temporary directories and the loopback address.
- No smoke, teardown, firewall or host-preparation script, and not the two stub suites: they execute the teardown scripts against a stub.
- No request to any external service.

Run: `git` read commands, `node --check`, `bash -n`, a YAML parse of the Compose files, `git diff --check`, and the unit suite.

## 10. State

- Branch `prototype/m16-p7-durability-harness`, HEAD `462f5d432024166c3a5a73c2a3024ef011ad8133`. Nothing staged; nothing committed since.
- Unit suite after the last change: 338 tests, 338 pass, 0 skipped. The process-spawning file passed three times in a row.
- No file under `prototype/m16-phase05/`, `apps/` or `services/` changed, and no script or Compose file.
- Protected state (smoke evidence and recorder directory, bundles, evaluation files, refs, tags, the main checkout and its plan) was verified unchanged by hash after the last change.

**P7 remains NOT TESTED and NOT PASSED.**

## 11. After the checkpoint commit: the recorder-side gate for D1 (added 18 November 2026)

Sections 1 to 10 describe the state committed as `4516256eb20e1b43cdc201fe88c07a974ed6535e`. This change came afterwards, by the product owner's approval, and is uncommitted.

- **The gate:** the recorder stores no PASS for a cycle in which it refused an authenticated request after the cycle began (`pass_for_a_cycle_with_authenticated_rejections`). ~~It reads the refusals from the ledgers, so a restarted recorder refuses as well.~~ **Corrected, see section 12:** that sentence was true only for a refusal that is on record. One that could be recorded nowhere was forgotten by a restart, and the PASS was then stored. INCONCLUSIVE is accepted and closes the cycle. This closes D1 on the recorder as well as in `check`, and replaces item 1 of section 8.
- **What it does not count:** a refusal that names another cycle, one made before the cycle began, and refusals after the cycle's result is stored (during its recovery).
- **The existing tests that stored such a PASS.** One chain of committed tests did: on the qualifying run `p`, cycle 1 is refused three starts on purpose (a second start of the process, a second process, more workers), and the tests of decisions 1 and 2 then stored a PASS for that same cycle. Their intent is the quarantine and clearance rule and the broken series, not the refusals. They now run on a second qualifying run whose first cycle has no refusal on record. Compared line by line with the committed version, their assertions differ only in the run's name. A new test in the same chain asserts that the PASS for cycle 1 of `p` is refused and that INCONCLUSIVE is accepted and ends the series.
- **The safety model is unchanged:** an authenticated refusal in a cycle already made it INCONCLUSIVE whenever `check` computed the verdict. The gate makes the recorder hold to the same rule for a result it is sent.
- **Tests:** `test/final-review.test.mjs` (the gate, a restart, and what is not counted; two failed before the gate was added), `test/recorder.test.mjs`. Whole unit suite: 340 tests, 340 pass.

## 12. Remediation of the D1 gate after its independent review (18 November 2026, later; uncommitted)

The review of section 11 found that the gate could be bypassed (findings G1 to G3) and that three texts claimed more than the code kept. A second adversarial review of the remediation found two further paths to a stored PASS (H1, H2) and smaller items. All were reproduced as failing tests before their fix (`test/d1-gate.test.mjs`), except where noted in the progress register.

| ID | Finding | State |
|---|---|---|
| G1 | A refusal recorded nowhere was forgotten by a recorder restart; the PASS was then stored | FIXED: a server that takes over an open cycle records `recorder_restarted` (or holds it in memory if it cannot) and stores no PASS for that cycle |
| G2 | The count depended on the recorder's clock | FIXED: each refusal is stamped with the open cycle; no time comparison for new records |
| G3 | The body's cycle decided before the path; a request naming no cycle was counted nowhere | FIXED: path first; a contradiction, an unusable or missing cycle counts against the open cycle |
| G4 | The ledgers are not protected against removal of lines or files | NOT FIXED, documented: no hash chain, no second copy |
| G5 | A complete non-record line left the run unusable without saying why | PARTLY: named by `verify-dir`, the view and the start refusal; after a restart the run is still unusable (pinned by a committed test) |
| G6 | Replay as a way to force INCONCLUSIVE | By design, documented |
| G7 | Misnamed test; false restart claim in three places | FIXED |
| H1 | Refusal while the event ledger was unreadable and the rejection log unwritable: forgotten by the same process | FIXED: held in memory against the run (`lost`) |
| H2 | An authenticated request that failed outside a refusal left no trace; PASS stored | FIXED: same memory flag, set by the handler's error path and for a run that cannot be found |
| H3 | An `unknown` refusal dropped out of a closed cycle's count | FIXED: it counts against every cycle of the run, permanently |
| H6 | The exemption for "names another cycle" is controlled by the sender | NARROWED: an unusable path cycle and a refused journal-write-failure or worker-stop report now count; other requests naming another cycle still do not (pinned by committed tests): OWNER DECISION |

**What the guarantee is, exactly.** No recorder process stores a PASS for a cycle if (a) a counted authenticated refusal for it is on record, or (b) that process knows of a request it could record nowhere, or (c) that process, or an earlier one whose event is on record, took the cycle over while it was open. What is NOT guaranteed: protection against someone editing the recorder's files; correctness if the recorder's clock is set back between a worker's last acknowledgement and the cut (silent-stop detection).

**Behaviour changes that need the product owner's attention:**
- A recorder restart while a cycle is open makes that cycle INCONCLUSIVE; in a POWER-CUT run that ends the series.
- A request refused while a cycle is open that names no usable cycle counts against it. This includes a boot report from a test machine whose clock is more than five minutes off after power returns.
- Two assertions committed in `test/final-review.test.mjs` at `4516256` were inverted on purpose (a restarted recorder's view is now damaged; a PASS in a cycle with a refusal is refused). The decision 1 and 2 tests moved to a second run with only names changed.

**Validation:** unit suite 379 tests, 379 pass, three consecutive runs. Both removal stub suites and the firewall stub suite pass. An isolated HARNESS-SMOKE run on a scratch Compose project passed before the H fixes were made; it has not been repeated since. It is not a durability result.

## 13. Final verification mission (18 November 2026, uncommitted)

Three further independent reviews were started against the tree after section 12. The first did not complete (the reviewing agent stopped on a usage limit and delivered nothing). The second and third completed; their scripts are in the session scratchpad (`review-h/`, `review-i/`). Every fix below was reproduced as a failing test first (`test/final-verification.test.mjs`).

| ID | Finding | State |
|---|---|---|
| J1 | A saved PASS was resent after the operator withdrew the cut confirmation | FIXED (`savedResultProblem`), and K2 |
| J2 | The gate ignored the recorder's own record of the cut and the workers | FIXED: no PASS without a recorded cut whose last confirmation is `yes`, or with a stop or silence before the cut |
| J3 | A stop or journal-failure report answered "busy" was counted nowhere | FIXED: held in memory against the open cycle |
| J4 | A refusal caused by an inconsistent volume registry was counted nowhere | FIXED: held in memory (nothing is written to the run in that state; a committed test pins that) |
| K1 | An acknowledgement after the cut request erased a silence before it | FIXED |
| K2 | `confirm-cut no` after a stored PASS left the PASS standing | FIXED: refused once the cycle has a result |
| K3 | `startCycle` could adopt a start it did not send | FIXED: per-invocation `startId` |
| Clock | Silent-stop detection compared wall clocks across two files | FIXED: monotonic stamp, both clocks must agree |
| Clock | A test machine more than five minutes off was refused, which counted against the cycle | FIXED: recorder-time signing through `/time` |
| F16 | A request answered 500/503 could be replayed after a restart | FIXED: `signed_before_this_server_started` |
| F8 | A lost answer to the cycle start left a cycle that could not start | FIXED (`startCycle`); executed in a smoke only on the path where no answer is lost |
| Log | Replays could grow the rejection log without limit | FIXED past the 16 MiB cap |
| Smoke | Two processes of one cycle wrote the same evidence file name | FIXED (found by smoke 2) |

**Open, and why:**
- **A worker stop reported after the cut request is not counted (review 3, High by its rubric).** Pinned as intended by `test/journal-failure-verdict.test.mjs`. The cut request is not the power loss, so such a report shows the worker stopped while the machine still had power. OWNER RULING. Changing it means changing that committed assertion.
- **The gate does not check contact after the cut or the durability settings**; only `check` does. Adding the first would need the two POWER-CUT fixtures to record a boot report.
- **"Busy" for a request that is not a stop or failure report** leaves no record (the sender repeats it six times).
- **A late acknowledgement** between `check` reading the view and its PASS being stored is not bound to the result.
- **F16** can refuse an honest client that spans a restart, for as long as the old server's clock lagged (counted).
- **A result file that cannot be parsed**, or a non-record line in `events.jsonl`, leaves the run unusable (no PASS possible).
- **Ledger integrity** (no hash chain), **requests that consistently name another cycle** (not counted), **a paused recorder host** (both clocks stand still), **C6**, **F20** (needs Linux), **F12** (never run against real Docker).

**Committed test fixtures changed, assertions unchanged.** Six committed tests stored a PASS with no cut on record. Under J2 that is refused, so each now records the cut first (`test/helpers/cut.mjs`), and two also record one acknowledgement.

**No Critical or High finding is open in the tested scope except the first item above, which is a recorded design choice awaiting a ruling.** Review 3's fixes (K1 to K3) have not themselves been reviewed again.

## 14. Product-owner rulings A, B and C (18 November 2026, uncommitted)

**Rulings accepted as requirements:** A, a worker stop reported after the cut request makes the cycle INCONCLUSIVE. B, the PASS gate verifies all mandatory evidence itself. C, no evidence may change between `check` and the stored PASS.

**Implementation.** `passEvidenceProblem`, `evidenceMarkOf`, `contradictionsAfterResult` and `finalOf` in `recorder.mjs`; `classifyCycle` (`WORKER_STOPPED_AFTER_CUT_REQUEST`); `savedResultProblem`; `p7.mjs check` sends `identity` and `evidenceMark`; the cycle start records `pgSystemId`. The README section "A damaged cycle is INCONCLUSIVE" lists every rule.

**The evidence boundary.** The gate reads the view, checks it and stores the result in one synchronous step of the server process, under the directory lock. The other writers are acknowledgements of the same process, which cannot interleave a synchronous step, and operator commands, which take the same lock. Anything added after `check` read its view changes the mark, and the PASS is refused. Anything that arrives after the store and shows the workload still ran contradicts the PASS: the final status becomes INCONCLUSIVE.

**Tests.** `test/gate-closure.test.mjs`: 43 tests, of which 35 failed before their fix and 8 were controls. They cover worker stops before, after and concurrent with the cut request; missing and invalid contact after the cut; missing and inconsistent settings; identity, registry and binding changes; evidence changing after the check; late acknowledgements before and after the store; saved PASS revalidation; a restart between check and PASS; a concurrent PASS and acknowledgement (8 trials); and contradictory evidence and stale run identity.

**Reviews.** Three independent reviews ran after the implementation.

| Review | Finding | State |
|---|---|---|
| 1 | R1, High: a late acknowledgement or report escaped when its cycle was not a number, was missing, was contradicted by its cycle id, or its body was not JSON | FIXED |
| 1 | R2, High: a boot reported before the cut counted as the reboot after it | FIXED |
| 1 | R3, High (needs a start without a boot id) | FIXED |
| 1 | R4, Low: 64-character truncation | FIXED |
| 1 | R5, Medium: an unsigned request made a PASS stale, and the stale PASS counted against the cycle for good | FIXED |
| 2 | S1, High: a worker-stop or journal-failure report about a decided cycle answered "busy" was lost | FIXED: refused on record |
| 2 | S2, Low: a report naming no usable cycle while the next cycle is open | FIXED: attributed to the last decided cycle as well |
| 3 | No Critical or High. Two comments overstated "busy" | FIXED (comments) |
| 3 | A stall of up to 250 ms when a busy report's rejection cannot be written | Accepted, documented |

**Committed tests changed.** Assertions were kept and fixtures added; Git history is untouched.
- `test/journal-failure-verdict.test.mjs`: the comment that pinned "a stop after the cut does not count" was rewritten for ruling A. Its assertion is kept (still true), and one assertion was added.
- `test/final-review.test.mjs` d1b: the expected refusal count rose from 1 to 2. The acknowledgement the recorder could not store is now refused on record, which is stricter.
- Every test that stores a PASS now sends what `check` sends, through `test/helpers/cut.mjs`. The qualifying starts in `recorder.test.mjs` report settings and a boot id.

**Validation.**
- Unit suite: 446 of 446, three consecutive runs.
- Stub suites: removal and firewall both passed.
- Compose: both configurations render.
- Isolated smokes on new projects: 5, 6 and 7, all passed. Smoke 7 ran against the final code; only comments changed afterwards.

**Still open.**
- Ledger integrity: there is no hash chain.
- A paused recorder host stops both clocks.
- F20 needs Linux, and F12 has never run against real Docker.
- An unparseable result file, or a non-record line in the event ledger, leaves the run unusable (no PASS is possible).
- A contradiction after the result that reaches no ledger is lost.
- Requests that consistently name another cycle are not counted.
- "Busy" for ordinary requests leaves no record.
- VM-CRASH journal identity is not checked.

**No Critical or High finding is open in the tested scope.**

### 14.1 A contradiction after a stored PASS that no ledger can take (18 November 2026, later)

**Owner decisions recorded.** A recorder restart during an open cycle makes it INCONCLUSIVE and ends a POWER-CUT series (approved). The seven scratch Docker projects are preserved. No commit yet.

**Reproduction on the code before the fix** (scratch script `contradiction/repro.test.mjs`, outputs `before-fix.txt` and `after-fix.txt`). Steps:
1. A qualifying cycle with its PASS stored.
2. The rejection log and the event ledger made unwritable.
3. A fresh acknowledgement, or a `worker_stopped` report, for the cycle.
4. Storage restored, then a recorder restart.
5. `recovered` sent.

Results on the code before the fix:

| Point | Result |
|---|---|
| Answer to the contradiction | `500 refusal_not_recorded, fallback none` |
| The running server's view | `PENDING_RECOVERY` (nothing held) |
| After the restart, `recovered` | `final PASS` |
| Streak | **1** |

**An unsafe PASS after a restart was possible**, for both variants.

**The correction.**
- A third durable place: write-once marker files under `contradictions/<run>/`, with the file and its parent directories synced. A name collision with another record writes a second file.
- When nothing can be written, a hold in memory. It refuses recovery, cycle starts and PASS, shows the cycle as INCONCLUSIVE, is written again at every request, and keeps the server from stopping on ordinary signals.
- Attribution checks the named cycle through its result file alone. When the ledgers cannot be read it uses `'*'`, which counts against every decided cycle.
- A rejection log that cannot be read makes a stored PASS non-final, in both the cycle view and the run status. `recovered` is refused while that log cannot be read, and, for a PASS, while the server holds an unrecorded refusal.

**Tests.** `test/post-result-contradiction.test.mjs`, 20 tests. They cover:
- the exact sequence, for an acknowledgement and for a worker report;
- each ledger failing alone, and both ending in a fragment;
- a restart before the contradiction;
- duplicates and replays (a replay does not contradict, by design);
- the hold in memory, its later flush, and the refusal of recovery and start while held;
- concurrent PASS and contradiction (6 trials);
- unreadable ledgers, with and without a restart;
- the marker's fsyncs and name collisions;
- the run status during a one-off read fault;
- `serve` ignoring SIGTERM while holding, in a real process;
- THE STATED LIMIT, pinned.

Status of these tests before their fixes:
- Failed before their fix: 6 of the first 12, the 5 found by review 1, and the 2 found by review 2.
- Pass by design, as controls: two ledger-failure cases, the replay case, the restart before the contradiction, the stated limit and the concurrency trials.
- The `serve` signal test was written with its change.

**Reviews.**

| Review | Finding | State |
|---|---|---|
| 1 | High: a contradiction received while the event ledger could not be read was recorded without attribution; final PASS, also without a restart | FIXED (`'*'`, the named cycle through its result file) |
| 1 | High: the view showed final PASS while the rejection log could not be read | FIXED |
| 1 | Medium: the marker's parent directories were not synced, and a leftover file was not synced again | FIXED |
| 2 | High (narrow): a one-off read failure let the run status count a contradicted PASS | FIXED |
| 2 | Medium: `'*'` invalidates earlier recovered PASSes after a transient fault | ACCEPTED as fail-closed, documented |
| 2 | Medium: the README limits were out of date | FIXED |
| 2 | Low: SIGHUP/SIGQUIT | FIXED |
| 2 | Low: marker name collision | FIXED |

The fixes for review 2's findings were not reviewed again.

**The guarantee, exactly.** A contradiction the recorder receives is kept in the rejection log, the event ledger or a marker file. If none can be written, it is held, and the server refuses to progress or stop on ordinary signals until it is written.

**What is not guaranteed.** If no file can be written and the process is killed before any write succeeds, the contradiction is lost and a restarted recorder can record the PASS as final. **Post-result contradiction handling is therefore NOT restart-safe when the recorder host's storage is entirely unwritable.** The recorder-side guarantee ends there; closing it would need a second, independent storage device or host.

**Validation.** Unit suite 466 of 466, three consecutive runs. Removal stub suites pass. `git diff --check` is clean. No Docker smoke was run: only the recorder's failure paths and the `serve` signal handling changed, and those are exercised by the unit tests, including a real `serve` process.

### 14.2 Final independent review before the commit decision (18 November 2026)

**Owner ruling.** The total recorder-storage-failure limitation is ACCEPTED for the prototype as an explicit boundary. Restart safety is not claimed under total storage failure. The server must fail closed while a contradiction is held, and must never discard a held contradiction silently on normal shutdown or recovery.

**Review rounds after section 14.1.** Four independent reviews ran, each against the fixes of the one before. Every finding was reproduced as a failing test before its fix (`test/post-result-contradiction.test.mjs`, now 31 tests).

| Round | Finding | State |
|---|---|---|
| 1 | High: the first request after a server start with a ledger unreadable never reached attribution; the PASS ended final | FIXED (`rescueReport`, `'*'`) |
| 1 | High: a run directory that could not be read set only `lost`; SIGTERM and a restart discarded it | FIXED (marker or hold) |
| 1 | Medium: other signals ended a holding server | FIXED |
| 1 | Medium: `status` could not see a hold | FIXED (warns), documented |
| 2 | High: a replaced recorder disk took a marker on the empty mount point as kept | FIXED (held as well; the recorder directory is never created) |
| 2 | High (Linux socket path not reproduced): handling SIGPIPE turned a broken connection into a clean exit | FIXED (SIGPIPE, SIGPROF and SIGTRAP not taken over; stderr errors ignored) |
| 2 | Low: an unloaded run whose directory is missing; the time request skipping the retry; README wording | FIXED or documented |
| 3 | High: after a restart, with the disk replaced, the keys were gone with it, so nothing was authenticated and nothing held | FIXED (keys kept in memory) |
| 3 | Medium: a hold whose marker was safe blocked shutdown while the run directory stayed away | FIXED (released once on the recorder's own disk) |
| 4 | High (narrow race): the disk mounted back between the marker write and the identity check released the hold while the marker was hidden | FIXED (the marker must still be found on the identity file's device) |
| 4 | Low: a server started on an empty directory with `--new-directory`; a cloned directory; key memory; `globalReject` on an empty mount point | DOCUMENTED (stated limits) or no effect |

The fix for round 4 was not reviewed again.

**The storage-failure matrix.** Each line is covered by tests; the signal and `status` cases run in a real `serve` process.

| Case | Result |
|---|---|
| Both ledgers unavailable | Marker written, final INCONCLUSIVE after restart |
| Marker location alone unavailable | The rejection log takes it |
| All three unavailable | Held. INCONCLUSIVE in the server's views; recovery, start and PASS refused; catchable signals refused |
| Storage returns | Written at the next request; then the server stops normally |
| Killed while holding, then restarted | **The accepted loss:** final PASS (pinned as THE STATED LIMIT) |

**Validation.** Unit suite 477 of 477, three consecutive runs. Removal stub suites pass. `git diff --check` is clean.

A new Docker smoke (project `opsilume-m16-p7-scratch8`) could not run. Docker refused to create its third network, because all predefined address pools are taken by the preserved scratch projects. It left two empty networks, `opsilume-m16-p7-scratch8_p7db` and `opsilume-m16-p7-scratch8_p7gw`; nothing was removed. The last smoke that ran (7) predates the changes of sections 14.1 and 14.2. Those changes are in the recorder, and the time request now takes an earlier path. They are covered by the unit tests, including real `serve` processes, but not by a container smoke.

**Remaining limits:**
- the accepted total-storage-failure loss;
- a server started on an empty directory with `--new-directory`;
- a cloned recorder directory;
- `'*'` ending a run's series after a storage fault;
- no ledger integrity protection;
- a paused recorder host stops both clocks;
- VM-CRASH journal identity is not checked;
- F20 (Linux) and F12 (real Docker) have never run.

### 14.3 Final bounded review and smoke validation (18 November 2026)

**Owner rulings.**
- **A:** replacing or remounting the recorder disk underneath a running recorder is outside the supported failure envelope. The recorder assumes its designated storage identity is stable while it runs. No protection against physical storage substitution is claimed. The fail-closed behaviour where an identity inconsistency is detected is kept (README, "Supported storage failure envelope").
- **B:** exactly one final review of the round-4 fix, plus a review of any correction it requires.
- **C:** removal of the two empty networks left by smoke 8 only, after inspection.

**The final review, within the envelope (stable disk).**

| Finding | State |
|---|---|
| High: after a restart, a run key file that cannot be read dropped a fresh contradiction, and the PASS became final | FIXED: the key held in memory authenticates it (test Z1) |
| Low: one signed request kept as many markers as it was sent | FIXED: kept once (Z2) |
| Low: an `rs.held` record is released after a marker write without the identity check | ACCEPTED: on a stable disk a loaded run directory is enough; checking identity there could hold forever where `recorder-id.json` is missing |
| Low: `'*'` invalidates earlier PASSes after a storage fault | Documented |

**The review of that correction.** No Critical or High.

| Finding | State |
|---|---|
| Medium: the rescued-request set was keyed by nonce alone, so a request of another run with the same nonce was dropped | FIXED: keyed by run and nonce (Z3) |
| Low: the set was never pruned | FIXED: entries older than the time window are dropped |
| Low: a stale in-memory key after a run id is reused | Conservative only (false contradictions); documented |
| Low: a run created after the server started, whose key was never read and is unreadable now | Documented; nothing can authenticate it |

**Docker resources (ruling C).** Inspected first; the record is saved in the session scratchpad (`scratch-smoke8/networks-before-removal.json`). Then removed by id:
- `opsilume-m16-p7-scratch8_p7db` (`f8b5dee2…`, subnet 192.168.224.0/20)
- `opsilume-m16-p7-scratch8_p7gw` (`4622ee45…`, subnet 192.168.240.0/20)

Both carried the Compose labels of project `opsilume-m16-p7-scratch8` and its bridge names `p7zdb0`/`p7zgw0`. Neither had a container attached. The project had no containers and no volumes. The network lists before and after differ by exactly those two. Containers (24) and volumes (16) are unchanged.

**The final smoke: BLOCKED by the environment.**
- **Run:** project `opsilume-m16-p7-scratch9`, generation `m1118i`, port 8815, against tree hash `039bb35cdd315770` (unchanged afterwards).
- **What happened:** Docker created one network (`opsilume-m16-p7-scratch9_p7db`, 192.168.240.0/20) and then refused the second with "all predefined address pools have been fully subnetted". Exit 1, before any container started.
- **Why:** the two other blocks that looked free (192.168.64.0/20 and 192.168.224.0/20) were not allocatable; Docker Desktop presumably reserves them.
- **Not done, per the ruling:** no global configuration was changed and nothing unrelated was removed.
- **Left behind:** one empty network, `opsilume-m16-p7-scratch9_p7db`. It was not removed, because its removal is not authorised.
- **Consequence:** the last container smoke that ran (smoke 7) predates sections 14.1 to 14.3. The recorder changes since then, including the signed time request taking an earlier path, are covered by unit tests, including real `serve` processes, but by no container smoke.
- **To unblock:** the owner's approval to remove the networks of some stopped scratch projects, or explicit subnets in the scratch Compose override (a project-level setting, not global).

**Validation.**
- Unit suite: 480 of 480, three consecutive runs. This includes the recorder process tests, the signal tests in a real `serve`, and the storage-failure tests.
- Stub suites: removal and firewall both pass.
- Compose: both configurations render.
- Syntax checks of every `.mjs` and `.sh` file pass, and `git diff --check` is clean.

**Remaining limitations.**
- Accepted: total recorder-storage failure followed by a kill loses a held contradiction.
- Unsupported: disk replacement or remounting under a running recorder; a server started on an empty directory with `--new-directory`; a cloned recorder directory.
- `'*'` ends a run's series after a storage fault.
- No ledger integrity protection.
- A paused recorder host stops both clocks.
- VM-CRASH journal identity is not checked.
- The SIGPIPE change is not verified on Linux.
- F20 (Linux firewall) and F12 (real Docker teardown) have never run.
- The final source tree has had no container smoke.

**Native Linux requirements (unchanged).**
- A native Linux test machine and a separate recorder host.
- Storage flush behaviour verified.
- The firewall applied and verified.
- A rehearsal to measure the workload.
- The cut procedure.
- The physical 20-cycle series, with independent review of its evidence.

**P7 remains NOT TESTED and NOT PASSED.**
