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
| F8 | Med | Lost answer to the cycle start | MITIGATED (note after start best effort); a lost start answer is still a stop | none (p7 only) |
| F9 | Med | `smoke-teardown.sh` dry run starts a container | OPEN: script cannot be exercised under the restrictions | |
| F10 | Low | Marker state never reported | FIXED with F4 (worker report) | journal-failure-verdict |
| F11 | Low | `for x in $(docker ...)` skips a check on failure | OPEN: script, as F9 | |
| F12 | Low | `compose down` without `-f` in teardown | OPEN: script, needs Docker | |
| F13 | Low | `--command-json` parsed after the wait | FIXED | recorder-hardening |
| F15 | Low | Accepted-claim line written twice on retry | FIXED | recorder-hardening |
| F16 | Low | Nonce persisted only by writing handlers | OPEN: the simple fix (refuse timestamps before server start) would refuse honest requests after a restart | |
| F17 | Low | Unbounded rejection appends | OPEN | |
| F18 | Low | Strict netcheck needs only one gateway bridge probe | FIXED | netcheck |
| F19 | Low | Hostname target passes strict route probes | FIXED | netcheck |
| F20 | Low | Firewall re-apply window, partial rules | OPEN: script, needs Linux | |
| F21 | Low | Smoke script leaves containers running on failure | OPEN: script | |
| F22 | Low | Smoke flag parsing | OPEN (smoke only) | |
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
| D1 | Med | A saved PASS could be re-sent and stored after the cycle got an authenticated refusal, or after a lost refusal and a recorder restart | FIXED in `check` (it re-vets a saved PASS against the cycle view). **DECISION open:** a recorder-side gate conflicts with a committed test that stores a PASS in a cycle with refusals; not added | final-review |
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
- Checkpoint prepared, not committed: awaits the product owner's authorisation.
