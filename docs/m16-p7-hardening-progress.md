# M16 P7 hardening: finding register and progress notes

Working notes for the hardening mission of 18 November 2026, kept so the work can be resumed. Branch `prototype/m16-p7-durability-harness`, HEAD `462f5d432024166c3a5a73c2a3024ef011ad8133`, everything since is uncommitted. **P7 NOT TESTED and NOT PASSED.** No Docker, no operator command, no script run; Phase 0.5, `apps/`, `services/` untouched.

Sources: `docs/m16-p7-post-commit-review.md` (F1 to F24, sections 10 to 12), the second safety review (findings A, B and the independent reviewer's C1 to C12, recorded in `docs/m16-p7-second-safety-review.md`).

## Register

Status values: FIXED (code and test), MITIGATED, OPEN (with reason), BY DESIGN, DECISION (product owner).

| ID | Sev | Finding | Status | Test |
|---|---|---|---|---|
| F1 | High | Malformed request target ends the recorder | FIXED | recorder-availability |
| F2 | Med | Failed rejection write ends the recorder | FIXED | recorder-availability |
| F3 | Med | Non-UTF-8 torn tail made corrupt by the repair | MITIGATED: INCONCLUSIVE, no repair; verifier unchanged by decision | repair-utf8, harness |
| F4 | Med | `check` ignored a journal write failure | FIXED | harness, journal-failure-verdict |
| A | Med | Cycle could never be closed (refused PASS re-sent) | FIXED | cycle-closure |
| B / F14 | Low | Event for a cycle not started was stored | FIXED | cycle-events |
| F5 | Med | `recover` re-run after a recorded recovery failure | FIXED (`lib/recovery.mjs`; p7 wiring unexecuted) | recovery |
| F6 | Med | Clearance evidence lost on a re-run | FIXED (evidence file at once, summary before the report; p7 wiring unexecuted) | recovery |
| F7 | Med | Size check counts only waiting actions | FIXED by decision of 18 November: the series is planned before it starts (option 3) and the actual count is checked before every cycle (option 2). The count's SQL and call in `p7.mjs` are unexecuted | series-plan |
| F8 | Med | Lost answer to the cycle start | FIXED 18 Nov (final): `startCycle`, own `startId`; unit-tested; the lost-answer path itself has not run in `p7.mjs` | unit |
| F9 | Med | `smoke-teardown.sh` dry run starts a container | FIXED 18 Nov (later): `--pull never`, stated in the header, failed read refuses; stub suite | stub |
| F10 | Low | Marker state never reported | FIXED with F4 (worker report) | journal-failure-verdict |
| F11 | Low | `for x in $(docker ...)` skips a check on failure | FIXED 18 Nov (later): a failed listing refuses; stub suites | stub |
| F12 | Low | `compose down` without `-f` in teardown | CHANGED, NOT VALIDATED: runs from `/`; the stub cannot see the directory; the real teardown has never run | |
| F13 | Low | `--command-json` parsed after the wait | FIXED | recorder-hardening |
| F15 | Low | Accepted-claim line written twice on retry | FIXED | recorder-hardening |
| F16 | Low | Nonce persisted only by writing handlers | FIXED 18 Nov (final): requests signed before the server started are refused; made safe by recorder-time signing. Residual: a client spanning a restart can be refused for the old clock's lag | unit |
| F17 | Low | Unbounded rejection appends | PARTLY FIXED: unauthenticated lines stop at 16 MiB per log; authenticated (incl. replayed) refusals are always written | unit |
| F18 | Low | Strict netcheck needs only one gateway bridge probe | FIXED | netcheck |
| F19 | Low | Hostname target passes strict route probes | FIXED | netcheck |
| F20 | Low | Firewall re-apply window, partial rules | OPEN: script, needs Linux | |
| F21 | Low | Smoke script leaves containers running on failure | CHANGED, NOT VALIDATED: exit trap stops them on failure; the failure path was not exercised | |
| F22 | Low | Smoke flag parsing | FIXED: `runFlagProblem`; unit-tested; the `p7.mjs` call ran in the scratch smoke only on valid flags | unit |
| F23 | Low | `fetch` without `redirect: 'error'` (demonstrated: the signed request was re-sent to the redirect target) | FIXED | client |
| F24 | Low | Pre-write errors remembered as write failures | BY DESIGN | |
| C1 | Med | Marker known to check but gone at recover: recovery accepted | FIXED | recorder-hardening, recovery |
| C2 | Med | Fallback "none" when the lock is busy; lost after restart | FIXED (unlocked append; `damage.runLedgers` survives a restart) | recorder-hardening |
| C3 | Med | Replays write events while the rejection log is torn | FIXED | recorder-hardening |
| C4 | Med | Start refusal scans closed cycles' files and the global rejection log | FIXED | recorder-hardening |
| C5 | Low | Late journal failure report refused; comment says otherwise | FIXED (comment and README) | journal-failure-verdict |
| C6 | Low | Unreadable acknowledgement file: view with no acknowledgements | OPEN, documented | |
| C7 | Low | PASS with a non-array report list stored | FIXED | recorder-hardening |
| C8 | Low | Second "not possible" exit after the probe | FIXED (it stops the run; p7 only) | none (p7 only) |
| C9 | Low | Size cap or read error recorded as "cannot be repaired" | FIXED | repair-utf8 |
| C10 | Low | `tornLedgers` throws on an unreadable ledger | FIXED | recorder-hardening |
| C11 | Low | stderr says "nothing was accepted" | FIXED (wording) | |
| C12 | Info | "recorder key unreadable" for an unreadable ledger | FIXED | recorder-hardening |

### Final review of the hardening diff (D)

| ID | Sev | Finding | Status | Test |
|---|---|---|---|---|
| D1 | Med | A saved PASS could be re-sent and stored after the cycle got an authenticated refusal, or after a lost refusal and a recorder restart | FIXED in `check` (it re-vets a saved PASS against the cycle view) and, by the product owner's approval after commit `4516256`, in the recorder: no PASS is stored for a cycle with an authenticated refusal on record. The committed chain that stored such a PASS now runs on a qualifying run with a clean cycle; its assertions are unchanged | final-review, recorder |
| D2 | Med | `recover` changed local state the recorder could never record while a run ledger was damaged; `/stop` wrote no marker when its event failed | FIXED | final-review |
| D3 | Med | A journal write failing inside the clearance did not stop the run on the recorder; the worker's report was sent once | FIXED (p7 only, unexecuted) | none (p7 only) |
| D4 | Low-Med | A result stored late was marked "refused" | FIXED (recognised by attempt id; p7 call unexecuted) | final-review |
| D5 | Low-Med | The client's error hid what was refused | FIXED | final-review |
| D6 | Low | Host path in a damage reason and in a 500 body | FIXED | final-review |
| D7 | Low | `verify-dir` threw on an unreadable directory | FIXED | final-review |
| D8 | Low | Oversize fragment never checkable; misleading text; `recover` treated a read error as a changed tail | FIXED | final-review; p7 part unexecuted |
| D9 | Low | Unparseable `result.json` re-selected for ever; dangling link | FIXED | final-review |
| D10 | Low | Refusal on the acknowledgement path could hold the server 8 s; comment inexact | FIXED (250 ms, comment) | none |
| D11 | Low | Clearance read back not checked against cycle and claim | FIXED (`recovery-recorded` on "already recovered" not added) | final-review |
| D12 | Low | `run` exited 0 after a journal write failure; `999.999.999.999` accepted | FIXED | final-review; exit code unexecuted |

## Plan

1. Batch 1: recorder (C1, C2, C3, C4, C7, C10, C11, C12, F13, F15). Tests first.
2. Batch 2: libraries (F18, F19, F23, C9, a pure `lib/recovery.mjs` for recover's preconditions and clearance evidence).
3. Batch 3: `p7.mjs` wiring (F5, F6, F8, C1, C5, C8, F23). Syntax-checked only: it cannot run outside the image.
4. Documents: README, checklist, post-commit review (append), second safety review (write).
5. One independent review of the final diff; one remediation round.
6. Final checks and checkpoint proposal. No commit without approval.

## Log

- Batches 1 to 3 implemented, tests first; unit suite 315 of 315. README and checklist updated.
- Final independent review received (D1 to D12); each finding verified in the code; one remediation round done, tests first. F7 implemented by the product owner's decision. Unit suite 338 of 338.
- Committed tests touched in the whole mission, each for an approved rule and with no assertion weakened: `test/readiness.test.mjs` (fixture: planned cycles and rates that fit a series; problem count 3 to 4), `test/recorder.test.mjs` (fixtures: `cycles: 20`), `test/netcheck.test.mjs` and `test/harness.test.mjs` (tests appended only).
- Open after this round: script findings F9, F11, F12, F20, F21 (need the stub suites and, for two, Docker or Linux); F8 (a lost start answer is still a stop); F16, F17, F22, C6; the D1 recorder-gate decision. `p7.mjs` and `gateway.mjs` never executed.
- Checkpoint committed as `4516256eb20e1b43cdc201fe88c07a974ed6535e` (parent `462f5d4`), 31 paths, by authorisation.
- After the commit, uncommitted: the recorder-side D1 gate, test first. Unit suite 340 of 340. No second commit is authorised.

## Mission of 18 November 2026 (later): D1 gate remediation and remaining hardening

Start: HEAD `4516256eb20e1b43cdc201fe88c07a974ed6535e`, six files modified and uncommitted (the D1 recorder gate). Nothing may be committed or staged. Phase 0.5, `apps/`, `services/` untouched. **P7 NOT TESTED and NOT PASSED.**

### Findings of the independent D1 review (G)

| ID | Sev | Finding | Plan |
|---|---|---|---|
| G1 | Med | A refusal recorded nowhere is forgotten by a restart, and the PASS is then stored | A recorder that (re)starts while a cycle is open records that fact for the cycle (durable event; in memory if it cannot be written): the cycle is damaged, no PASS. A write-once marker alone is not sufficient: it can fail with the same storage |
| G2 | Med | The count depends on the wall clock (`atMs >= start`) | Each refusal is stamped with the cycle that is open when the recorder handles it; counting uses that stamp, not time |
| G3 | Med | The body's cycle is trusted before the path; a malformed request is attributed to no cycle | Attribution: the authenticated path's cycle, else the open cycle. The body's cycle is recorded as a claim only |
| G4 | Low | Emptying or cutting the rejection log makes the gate forget | Documented limit; no hash chain claimed |
| G5 | Low | A complete non-JSON line in the rejection log leaves the run unable to store any verdict after a restart | Assess |
| G6 | Low | Replay as a liveness lever | By design; documented |
| G7 | Low | Misnamed test; false restart claim in three places | Correct |

### Order of work

1. G1 to G3, tests first; correct the three texts and the test name (G7).
2. Remaining register items: F8, F9, F11, F12, F16, F17, F20, F21, F22, C6.
3. Validation: unit suite, stub suites, Compose rendering; Docker smoke only if its prerequisites allow without touching preserved state.
4. One adversarial review of the result, one remediation round.
5. Documents and final readiness assessment. No commit.

### Log (this mission)

- State verified; plan written.
- G1 to G3 implemented in `recorder.mjs`, tests first (`test/d1-gate.test.mjs`, 26 tests: 22 failed before the change, 4 were controls). Suite 366/366.
  - G1: a server that loads a run with a cycle open appends `recorder_restarted` to that cycle (once per process; memory flag `tookOver` and `damage.recorderMemory` when it cannot be written). The view reports `damage.recorderRestarted` (key present only then) and `damaged`; no PASS is stored. Acknowledgements continue.
  - G2/G3: every authenticated refusal is stamped `open` (the open cycle; `'unknown'` if it cannot be read) and, when path and body disagree, `claimedCycle`. `cycle` is the path's cycle, else the body's. `countsAgainst` decides by the stamp; records without a stamp keep the old rule. `workerStopsBeforeCut` and `firstContactAfterCut` now use ledger order.
  - CORRECTION: two assertions committed at `4516256` in `test/final-review.test.mjs` were inverted on purpose (restart view damaged; PASS refused). Three D1 tests updated to the new reason after a restart; the misnamed test renamed.
  - BEHAVIOUR CHANGES for the owner: (a) a recorder restart while a cycle is open makes that cycle INCONCLUSIVE (in a POWER-CUT run that ends the series); (b) an authenticated request refused while a cycle is open that names no usable cycle (stale-clock boot report, malformed body, unknown event kind) now counts against that cycle.
  - NOT changed, pinned by committed tests: a refusal that consistently names another cycle is not counted against the open one.
- NEXT: G7 texts (recorder comment done; README gate sentence; second-safety-review section 11), G4/G5, then register items F8, F9, F11, F12, F16, F17, F20, F21, F22, C6; validation; adversarial review; final report.
- G7 texts corrected (recorder comment, README gate and damage sections, section 11 of the second safety review struck through with a pointer to section 12, still to be written). Misnamed test renamed.
- G5: `verify-dir`, the run's ledger check and the start refusal now name a complete line that is not a record (`cannot be read (a line is not a record)`). The volume registry keeps its own checks (two committed registry tests showed why). The run still cannot proceed with such a line after a restart: now in the README and pinned by a test.
- F9 (`--pull never`, header says the dry run starts one container, a failed marker read refuses), F11 (a failed docker listing refuses instead of skipping: four places), F12 (`compose down` from `/`, by project name), F21 (the smoke's exit trap stops the containers on failure, removes nothing), F22 (`runFlagProblem`), F17 (unauthenticated rejections are no longer written once a log passes 16 MB; authenticated ones always are). Tests for F17, F22, G5 were written together with the code, not shown failing first.
- Stub suites RUN (stub docker / stub iptables only): `test-teardown-with-stubs.sh` PASSED, `test-containers-down-with-stubs.sh` PASSED, `firewall/test-with-stubs.sh` PASSED in a throwaway container (`--rm --pull never --network none`, read-only mount).
- Unit suite: 369/369, three consecutive runs.
- NEXT: Compose config rendering; isolated Docker smoke if it can be done without touching `opspilot-m16-p7-smoke`; adversarial review; section 12 and register reconciliation; final report.
- Compose rendering: `docker compose config` for the qualifying files and for the smoke override: both render (exit 0).
- ISOLATED SMOKE RUN: scratch copy of the smoke runner and a scratch override (both in the session scratchpad, not in the repository), project `opspilot-m16-p7-scratch`, generation `m1118a`, port 8798. Result: SMOKE PASSED, exit 0. `p7.mjs` and `gateway.mjs` executed with the code as it was BEFORE the H fixes. Left in Docker, not removed (no removal is authorised): containers `opspilot-m16-p7-scratch-{db,gateway,harness}-1` (stopped), networks `opspilot-m16-p7-scratch_{egress,p7db,p7gw}`, volumes `opspilot-m16-p7-scratch_{pgdata,state}_m1118a`. `opspilot-m16-p7-smoke` and the default project were not touched. The runner refuses a second run while that project exists.
- Adversarial review of the remediation: H1, H2 (unsafe PASS, reproduced), H3 to H6 and smaller items. Fixed test-first: H1, H2, H3, H4 (same process), H6 (narrowed), README claims, test honesty items. One attempted fix (serve a run whose rejection log has a non-record line after a restart) was withdrawn because a committed test pins that run as unusable; kept as a stated limit with its own test.
- Unit suite: 379/379, three consecutive runs. Stub suites pass. `git diff --check` clean. Nothing staged. Phase 0.5, `apps/`, `services/` untouched.

### Open after this mission

| Item | State |
|---|---|
| F8 | Lost start answer is still a stop (fail-closed). Not changed |
| F12, F21 | Changed, not validated (need a real teardown / a failing smoke) |
| F16 | Nonce of a request answered 500/503 is not persisted. Accepted: a mid-cycle restart now makes the cycle INCONCLUSIVE anyway |
| F17 | Replayed signed requests can still grow the run's rejection log |
| F20 | Firewall re-apply window: needs a Linux host |
| C6 | Unreadable acknowledgement file gives a view without acknowledgements; the view is damaged, so INCONCLUSIVE |
| G4 | No integrity protection of the ledgers |
| G5/H4 | A non-record line leaves the run unusable after a restart |
| H6 | Requests that consistently name another cycle are not counted: owner decision |
| Clock | Silent-stop detection compares times across two files |
| Smoke | Not repeated after the H fixes |

**P7 status = NOT TESTED AND NOT PASSED.**

## Mission of 18 November 2026 (final verification): fresh adversarial review, clock-independent ordering, remaining items

Start verified: HEAD `4516256eb20e1b43cdc201fe88c07a974ed6535e`, 14 modified files and `test/d1-gate.test.mjs` untracked, nothing staged; unit suite re-run 379/379; both removal stub suites pass. Scratch project `opspilot-m16-p7-scratch` (generation `m1118a`) is preserved and must not be touched.

Order: (1) fresh independent review of the current tree (read-only; no repository edits while it reads); (2) clock-independent ordering for silent-stop detection and the stale-clock boot report; (3) F8, F16, C6, replay growth, non-record lines, F20; (4) new isolated smoke on a NEW project against the final tree, together with a final review; (5) documents. No commit.

### Log (final verification)

- State verified, tests re-run. Review 1 started.
- Review 1 did not complete (the reviewing agent hit a usage limit before reporting; no findings were delivered). It is to be resumed or replaced by the final review. Implementation continues: monotonic stamps, time endpoint, F16, replay cap, F8.
- Implemented test-first (`test/final-verification.test.mjs`, 13 tests, 12 failed before):
  - monotonic stamp `mono` on every event, acknowledgement and rejection; silent-stop detection compares `mono` (wall clock only for records without it);
  - `POST /runs/<run>/time` (signed, read-only, exempt from window and nonce memory); `makeClient` signs in recorder time plus its own monotonic elapsed time; the server's protocol time is its start wall time plus monotonic elapsed (`steadyNow`);
  - F16: `signed_before_this_server_started` (authenticated refusal);
  - replayed/stale/pre-restart refusals past the log cap are not written and are held in memory against the open cycle;
  - F8: `startCycle` (lib/worker.mjs), wired into `p7.mjs`.
- Unit suite 392/392, three consecutive runs. No committed assertion changed (the committed client test's wording `not authenticated` was kept by wording the new error accordingly).
- NEXT: new isolated smoke on project `opspilot-m16-p7-scratch2` (generation `m1118b`) against this tree; final independent review (read-only; no repository edits while it reads); documents.
- SMOKE 2 (project `opspilot-m16-p7-scratch2`, generation `m1118b`, port 8801): **FAILED, exit 1**, in run B cycle 1: processes a and b wrote `netcheck-<ms>.json` with the same millisecond; the second stopped on the write-once refusal, so only b started. Not caused by this mission's changes (the name was `Date.now()` only); fail-closed. Fixed: the process id is part of the name. The failure exercised the new exit trap (F21): the three containers were stopped. Left in Docker, not removed: containers `opspilot-m16-p7-scratch2-{db,gateway,harness}-1`, networks `opspilot-m16-p7-scratch2_{egress,p7db,p7gw}`, volumes `opspilot-m16-p7-scratch2_{pgdata,state}_m1118b`.
- Final review (completed; scripts in the session scratchpad `review-h/`): four conditional paths to a stored PASS, none with captured traffic alone, plus smaller items. Fixed test-first (8 tests failed before):
  - J1: `savedResultProblem` also refuses to resend a PASS when the view shows no cut, an unconfirmed cut or a workload that stopped before the cut.
  - J2: the recorder stores no PASS without a recorded cut whose LAST confirmation is `yes`, or with a worker stop or silent worker before the cut (`pass_for_a_cycle_without_a_recorded_cut`, `..._whose_cut_is_not_confirmed`, `..._whose_workload_stopped_before_the_cut`).
  - J3: a `worker_stopped` or `journal_write_failed` report answered "busy" is held in memory against the open cycle.
  - J4: a request refused because the volume registry is inconsistent is held in memory against the open cycle (not written: a committed test pins that nothing is written to a run while the registry is inconsistent).
  - Silent stop: a worker is recent only if BOTH clocks say so (the monotonic clock stands still during a host suspend).
  - `startCycle` adopts only its own start (same process letter, boot id and head).
- COMMITTED TEST FIXTURES CHANGED, assertions unchanged: the J2 invariant ("no PASS without an acknowledging worker and a recorded, confirmed cut") made six committed tests that stored a PASS with no cut on record fail. Each now records the cut first through `test/helpers/cut.mjs` (and, in `recorder.test.mjs` runs `p2` and `a1`, one acknowledgement): `final-review.test.mjs` (d1a, d1d), `journal-failure-verdict.test.mjs` (j3), `recorder-hardening.test.mjs` (c7ok), `recorder.test.mjs` (p2, a1).
- Not fixed, by the final review: a late acknowledgement accepted between `check` reading the view and its PASS being stored is not bound to the result (Low); F16 can refuse an honest client that spans a restart for as long as the old server's clock lagged (Low, bounded); a stray non-JSON file in `results/` makes the run answer 500 (Low); a non-record line in `events.jsonl` leaves the cycle unclosable even on the running server (README claim to be narrowed).
- Unit suite 400/400, three consecutive runs; both removal stub suites pass.
- NEXT: smoke 3 on `opspilot-m16-p7-scratch3` (generation `m1118c`); a last review round over these fixes; documents.
- SMOKE 3 (project `opspilot-m16-p7-scratch3`, generation `m1118c`, port 8803): **PASSED, exit 0**, on the tree with the J fixes. Left in Docker, not removed.
- Review 3 (completed; `review-i/`): K1 (late acknowledgement erases a silence), K2 (`confirm-cut no` after a stored PASS), K3 (`startCycle` adopts a foreign start): fixed test-first. One High by its rubric left for the owner: a worker stop reported after the cut request is not counted (pinned by a committed test). Others recorded as open in section 13 of the second safety review.
- Unit suite 403/403, three consecutive runs.
- SMOKE 4 (project `opspilot-m16-p7-scratch4`, generation `m1118d`, port 8805) started against the final tree; result recorded below.
- SMOKE 4 result: **PASSED, exit 0**. Tree state it ran against is recorded beside its log (`scratch-smoke4/tree-state.txt` in the session scratchpad: hashes of the diff under `prototype/` and of `p7.mjs`, `gateway.mjs`, `recorder.mjs`, `lib/worker.mjs`, `lib/protocol.mjs`); no file under `prototype/` changed afterwards. Container kills on Docker Desktop only: not a durability result. Left in Docker, not removed: project `opspilot-m16-p7-scratch4`, volumes `..._pgdata_m1118d`, `..._state_m1118d`.
- Docker resources left by this session, all stopped, none removed: `opspilot-m16-p7-scratch` (`m1118a`, passed), `-scratch2` (`m1118b`, failed), `-scratch3` (`m1118c`, passed), `-scratch4` (`m1118d`, passed). `opspilot-m16-p7-smoke` and the default `opspilot` project were never touched.

**P7 status = NOT TESTED AND NOT PASSED.**

## Mission of 18 November 2026 (owner rulings A, B, C): gate closure and pre-commit verification

Start verified: HEAD `4516256eb20e1b43cdc201fe88c07a974ed6535e`, nothing staged, 22 changed or new paths preserved.

Owner rulings (accepted as requirements): **A** a worker stop reported after the cut request makes the cycle INCONCLUSIVE; **B** the PASS gate verifies all mandatory evidence itself; **C** no evidence may change between `check` and the stored PASS.

### Log (rulings)

- Tests first: `test/gate-closure.test.mjs` (30 tests; 22 failed before the implementation, 8 were controls that already held: restart, refusal, replay, baseline).
- Implemented (`recorder.mjs` `passEvidenceProblem`, `evidenceMarkOf`, `contradictionsAfterResult`, `finalOf`; `lib/verdict.mjs`; `lib/attempts.mjs`; `p7.mjs check`):
  - A: `workerStopsAfterCut` (ledger position after `cut_sent`); refused `pass_for_a_cycle_whose_worker_stopped_after_the_cut_request`; `check` classifies `WORKER_STOPPED_AFTER_CUT_REQUEST`; `savedResultProblem` refuses to resend.
  - B (all models): an acknowledged claim before the cut; no `cut_confirmed` other than `yes` anywhere. B (POWER-CUT, VM-CRASH): a boot report after the cut from a boot that no start ran on, and the same boot `check` reports; settings durable and (POWER-CUT) exactly the bound configuration, at every start and after the reboot; run id, database cluster (registry and every start), and (POWER-CUT) journal marker, installation id, start binding digests and the recorder's own binding unchanged since readiness.
  - C: `evidenceMark` (sizes of the run's ledgers, the acknowledgement file, the stop marker, the registry). `check` sends the mark of the view it verified; the recorder refuses a PASS whose mark differs. View, gate and store run in one synchronous step under the directory lock. A FRESH acknowledgement or worker report for a cycle that already has its result is stamped `afterResultOf`; a stored PASS with such a record has final status INCONCLUSIVE (view, `recovered` answer, run status and streak). A replay does not count. A saved PASS is stale when its mark differs; once the recorder holds a result, `savedResultProblem` leaves it to the recorder.
  - The cycle start records `pgSystemId`.
- COMMITTED TEST CHANGES:
  - `test/journal-failure-verdict.test.mjs` "a journal write failure reported after the cut...": its comment said an ordinary stop after the cut "does not count". The assertion `workerStopsBeforeCut == []` is kept (still true); its message and comment were rewritten for ruling A, and one assertion was added (`workerStopsAfterCut` holds the stop).
  - Fixtures only, assertions unchanged: every test that stores a PASS now sends what `check` sends (`test/helpers/cut.mjs`: `markOf`, `qualifyingPassFields`). In `recorder.test.mjs` the POWER-CUT start helper also reports the ready settings. Sites: `recorder.test.mjs` (p2, a1, e1), `final-review.test.mjs` (d1d), `journal-failure-verdict.test.mjs` (j3), `recorder-hardening.test.mjs` (c7ok), and the helpers of `d1-gate` and `final-verification`.
- Unit suite 433/433, three consecutive runs. Both removal stub suites pass. Syntax of every `.mjs` and `.sh` file checked. `git diff --check` clean.
- NEXT: independent review of the rulings (read-only; no edits while it reads); firewall stub suite; Compose rendering; a new isolated smoke (p7.mjs `check` changed).
- Firewall stub suite PASSED (throwaway container, `--rm --pull never --network none`, read-only mount). Compose renders for the qualifying files and for the smoke override.
- SMOKE 5 (project `opspilot-m16-p7-scratch5`, generation `m1118e`, port 8807): **PASSED, exit 0**, against the tree with rulings A to C (before the R fixes below; those touch `recorder.mjs` only). Every `check` result it produced carried `evidenceMark` and `identity`. Left in Docker, stopped, not removed.
- Review of the rulings (completed; scripts in `review-j/`): three paths to a final or stored PASS and smaller items. Fixed test-first (11 tests failed before):
  - R1 (High): a fresh acknowledgement or worker report after the result escaped `afterResultOf` when its cycle was not a number, missing, contradicted by its cycle id, or its body was not JSON. Now the decided cycle is found by the cycle named, the cycle whose id the request carries, and, with no cycle open, the last cycle started.
  - R2 (High): a boot reported before the cut counted as the reboot after it. Now every boot id reported before the cut request is excluded.
  - R3 (High, needs a start without boot id): every start of a qualifying cycle must name its boot.
  - R4 (Low): boot ids are compared as the start keeps them (64 characters).
  - R5 (Medium): an unsigned request between `check` and its PASS made the PASS stale, and the refused PASS then counted against the cycle for good. Now the mark covers only authenticated refusals, and a PASS refused only for a changed mark is not held against the cycle (the next check is held to every rule afresh).
- Fixture change (committed test helper, assertions unchanged): the POWER-CUT starts in `recorder.test.mjs` report a boot id (`boot-at-start`).
- Not fixed: `cut_command_finished` is appended after the command, outside the lock (the gate does not read it); a contradiction after the result that can be written to neither the rejection log nor the event ledger is lost (the cycle's final status cannot be held in memory).
- Unit suite 444/444, three consecutive runs. Removal stub suites pass. `git diff --check` clean.
- NEXT: a review of the R fixes; smoke 6 against the final tree; documents.
- SMOKE 6 (`opspilot-m16-p7-scratch6`, `m1118f`, port 8809): **PASSED, exit 0** (after the R fixes).
- Review of the R fixes: S1 (High: a stop or journal-failure report about a decided cycle answered "busy" was lost; now refused on record with its attribution, as is an acknowledgement or such a report the recorder could not handle) and S2 (Low: a report naming no usable cycle while the next cycle is open is attributed to the last decided cycle too). Fixed test-first (2 tests failed before).
- Committed test changed: `final-review.test.mjs` d1b, expected refusal count 1 -> 2 (the acknowledgement the recorder could not store is now refused on record; stricter). Message updated accordingly.
- Unit suite 446/446, three consecutive runs; removal stub suites pass; `git diff --check` clean.
- SMOKE 7 (`opspilot-m16-p7-scratch7`, `m1118g`, port 8811): **PASSED, exit 0**, against the final code (tree hash `be89f9550c418a6c`; afterwards only comments in `p7.mjs` and `lib/worker.mjs` and documents changed).
- Final short review of S1/S2: **no Critical or High**. Two comments that said "busy" is answered before anything is written were corrected; a 250 ms stall when a busy report's rejection cannot be written is accepted and documented.
- Docker resources left by this session, all stopped, none removed: projects `opspilot-m16-p7-scratch` (`m1118a`), `-scratch2` (`m1118b`, failed), `-scratch3` (`m1118c`), `-scratch4` (`m1118d`), `-scratch5` (`m1118e`), `-scratch6` (`m1118f`), `-scratch7` (`m1118g`). `opspilot-m16-p7-smoke` and the default project were never touched.

**P7 status = NOT TESTED AND NOT PASSED.**

## Mission of 18 November 2026 (latest): a contradiction after a stored PASS that no ledger can take

Owner decisions: restart during an open cycle makes it INCONCLUSIVE (approved); the seven scratch projects preserved; no commit.

- Reproduced on the code before the fix: with both ledgers unwritable, a fresh acknowledgement or worker report after the PASS was lost; after a restart `recovered` answered `final PASS`, streak 1 (scratch `contradiction/before-fix.txt`). **An unsafe PASS after restart was possible.**
- Correction in `recorder.mjs`: contradiction marker files (`contradictions/<run>/`, synced with their parent directories), the in-memory hold with retry and refusals, `serve` ignoring SIGINT, SIGTERM, SIGHUP and SIGQUIT while holding, the `'*'` attribution when the ledgers cannot be read, a stored PASS not final while the rejection log cannot be read (view and run status), and `recovered` refused while that log cannot be read or, for a PASS, while an unrecorded refusal is held. After the fix the same sequence gives `fallback: contradiction_marker`, the running view INCONCLUSIVE, and after the restart `final INCONCLUSIVE`, streak 0 (`after-fix.txt`).
- Tests: `test/post-result-contradiction.test.mjs` (20 tests). The qualifying harness was moved into `test/helpers/gate.mjs` (shared with `gate-closure.test.mjs`, unchanged behaviour).
- Two independent reviews: 3 High and 1 Medium found by the first, 1 High (narrow) and smaller items by the second. All fixed, except `'*'` invalidating earlier PASSes after a transient read fault (fail-closed, documented). The fixes for the second review were not reviewed again.
- STATED LIMIT, not closed: if the recorder host can write no file at all and the server is killed before any write succeeds, the contradiction is lost. Post-result contradiction handling is NOT restart-safe in that case.
- Unit suite 466/466, three consecutive runs. Removal stub suites pass. `git diff --check` clean. No new Docker smoke: only recorder failure paths and signal handling changed, and they are covered by the unit tests (including a real `serve` process).

**P7 status = NOT TESTED AND NOT PASSED.**

## Mission of 18 November 2026 (final): independent review before the commit decision

Owner ruling: the total recorder-storage-failure limitation is ACCEPTED for the prototype as an explicit boundary (no restart safety claimed under total storage failure; fail closed while a contradiction is held; never discarded silently on normal shutdown or recovery).

State verified: HEAD `4516256eb20e1b43cdc201fe88c07a974ed6535e`, nothing staged, 26 changed or new paths; suite re-run 466/466.

Changes made after the second review of the correction (the subject of this review): `runStatus` reads the rejection log once and treats an unreadable log as a contradiction (`unreadable`, `rejections: null`); `writeContradictionMarker` compares an existing file and writes a colliding record under its own name (`-<random>`), exported for a test as `writeContradictionMarkerForTest`; `serve` also refuses SIGHUP and SIGQUIT while holding; README "Limits" rewritten.

### Log (final review)

- Independent review started (read-only; no repository edits while it reads).
- Review round 1 (`review-o/`): 2 High, 2 Medium. Round 2 (`review-p/`): 2 High (one on the Linux socket path, not reproduced on macOS), Lows. Round 3 (`review-q/`): 1 High, 1 Medium. Round 4 (`review-r/`): 1 High (narrow mount race), Lows. All High and Medium findings fixed test-first, except the Linux SIGPIPE socket case: its fix (SIGPIPE no longer handled) is not verified on Linux. The fix of round 4 was not reviewed again. Details in section 14.2 of the second safety review.
- Changes: `rescueReport` (fresh reports of work while the run's records cannot be read or found, kept as `'*'`); `orphanHeld`; key memory; recorder identity and device check before a hold is released; the signed time request answered from the key alone before the run is checked; `serve` refuses all catchable terminating signals except SIGUSR1, SIGPIPE, SIGPROF and SIGTRAP while holding, and ignores stderr errors; `server.on('error')`; `status` warns when a server is running; `globalReject` and the marker never create the recorder directory.
- Test changes: `test/post-result-contradiction.test.mjs` grew to 31 tests. W2's expectation was changed from "held, then released" to "marker on the recorder's own disk, nothing held" by round 3's Medium finding; that test was written in this mission. `test/helpers/gate.mjs` exposes the server.
- Unit suite 477/477, three consecutive runs. Removal stub suites pass. `git diff --check` clean.
- SMOKE 8 (`opspilot-m16-p7-scratch8`, `m1118h`): **BLOCKED**. Docker reports "all predefined address pools have been fully subnetted" (the preserved scratch projects hold them). Left: two empty networks `opspilot-m16-p7-scratch8_p7db`, `opspilot-m16-p7-scratch8_p7gw`. Nothing removed. A further smoke needs the owner's approval to remove networks of stopped scratch projects, or a Docker address-pool change.
- ACCEPTED LIMIT (owner, 18 November 2026): a contradiction held in memory is lost if the server is ended before any write of it succeeds on the recorder's own disk (SIGKILL, crash, power loss). Not restart-safe under total recorder-storage failure. Also stated: a server started on an empty directory with `--new-directory`, and a cloned recorder directory.

**P7 status = NOT TESTED AND NOT PASSED.**

## Mission of 18 November 2026 (final bounded review and smoke validation)

Owner rulings: disk replacement or remounting under a running recorder is outside the supported envelope (documented in the README); one final review only; removal of the two empty scratch8 networks only, after inspection.

- Networks: `opspilot-m16-p7-scratch8_p7db` and `opspilot-m16-p7-scratch8_p7gw` inspected (scratch8 labels, scratch bridge names, no containers, no volumes in the project) and removed by id. Nothing else was removed. The record is in the scratchpad: `scratch-smoke8/networks-before-removal.json`, `networks-list-before.txt`, `networks-list-after.txt`.
- Final review (`review-s/`): one High within the envelope (an unreadable key file after a restart dropped a contradiction) and Lows. Fixed test-first: Z1 (key from memory) and Z2 (one request kept once). Review of that correction (`review-t/`): no Critical or High. Medium fixed: Z3 (rescued set keyed by run and nonce); Low fixed: pruning. Other Lows documented.
- Unit suite 480/480, three consecutive runs. Removal and firewall stub suites pass. Both Compose configurations render. Syntax checks pass. `git diff --check` clean.
- FINAL SMOKE (`opspilot-m16-p7-scratch9`, `m1118i`, port 8815, tree `039bb35cdd315770`): **BLOCKED**. Docker created one network (192.168.240.0/20), then answered "all predefined address pools have been fully subnetted". Exit 1 before any container started. Stopped as ruled: no global change, nothing unrelated removed. Left: the empty network `opspilot-m16-p7-scratch9_p7db` (removal not authorised).
- The final source tree has NOT been exercised by a container smoke. The last smoke that ran is smoke 7.

**P7 status = NOT TESTED AND NOT PASSED.**
