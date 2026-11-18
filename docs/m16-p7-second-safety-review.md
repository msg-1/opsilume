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
