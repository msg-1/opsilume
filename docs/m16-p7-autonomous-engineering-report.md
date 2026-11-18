# M16 P7: autonomous engineering session report

**Date:** 17 November 2026. **This file:** `docs/m16-p7-autonomous-engineering-report.md` (the harness worktree; the plan document is in the main checkout). **Branch:** `prototype/m16-p7-durability-harness`. **HEAD at start and at end:** `a12e6156033a8ea240cef7d007357cc10e2a277e` (nothing was committed).

**P7 is NOT TESTED and NOT PASSED.** Everything below is harness engineering, verified by unit tests and stub tests on a development machine. No Docker container ran, no real host exists, and no power was cut. Nothing here is a Docker integration result, a real-host result or a durability result.

## 1. Executive summary

- **The burst rate is now a limit the harness enforces,** not a figure it only sizes with. Burst claims start at no more than the configured maximum burst rate, quiet claims at no more than the quiet rate, and the pool is sized from the same numbers, so it is a true upper bound for the planned time. Proven on a fake clock against the real claim loop.
- **A cycle's real throughput can be measured** with one read-only recorder command. It reports measured figures apart from configured ones.
- **A new smoke environment always gets volumes of its own.** Smoke volumes are named per generation; the volumes smoke 39 left on the Mac can no longer be attached by a new smoke run, and nothing removes them.
- **The recorder now checks the source package itself.** The declared commit and checksum are verified against the package file, and the package's contents against the code the recorder is running. The image id is still only declared.
- **Five real defects were found and fixed,** each with a test written first and shown failing. One came from this session's own tests (after a failed acknowledgement write, the recorder could store the same acknowledgement twice). Four came from an independent review of the whole diff: a cycle could be cut twice; the source the recorder verified was not pinned to the run; a ledger ending in a fragment could be made unreadable by the next append; and a run whose stop marker was lost could go on.
- **Decision B1's shape is now enforced at every start,** not only when the readiness record is accepted.
- **209 unit tests pass** (153 at the start), plus two stub suites (46 and 16 checks).
- **Not done, by the session's boundaries:** any Docker run. The burst pacing, the gateway binding, the identity report and the generation-named volumes have therefore never executed in a container.

## 2. Engineering changes implemented

| Area | Change | Files |
|---|---|---|
| Burst-rate enforcement | A pacer limits every claim start; the worker loop was extracted so it can be tested | `lib/pacer.mjs` (new), `lib/worker.mjs` (new), `p7.mjs` (`cmdRun`), `lib/sizing.mjs` (comment) |
| Throughput measurement | A pure report and a read-only command | `lib/measure.mjs` (new), `recorder.mjs` (`measure`) |
| Smoke lifecycle | Generation-named smoke volumes; the start script requires a new generation; the containers-and-networks script handles any number of generations and announces a resumed partial removal | `compose.smoke.yml`, `smoke-docker-desktop.sh`, `smoke-containers-down.sh`, `smoke-teardown.sh` (header), `host-evidence.sh` |
| Identity | The recorder reads and checks the source package at `create-run`; the harness reports a fingerprint of its own runtime, which is bound | `lib/package.mjs` (new), `lib/source.mjs`, `lib/readiness.mjs`, `recorder.mjs` (`packageProblems`, `createRun`), `p7.mjs` (`identityNow`) |
| Recorder defects | A failed acknowledgement write marks the cycle's acknowledgement file damaged; a cycle is cut at most once; the verified source is pinned to the run; a result that stops a run stops it without its marker; the kept sizing of a qualifying start is the bound workload; the workload shape is checked at every start | `recorder.mjs` (`createRecorder`, `cut`, `identityRefusal`, `createRunLocked`) |
| Ledgers | Nothing is appended to a ledger that ends in a fragment; a new ledger's directory entry is synced; run keys are created private | `lib/ledger.mjs` |
| Cycle start | A start answered "busy" after seeding is repeated; nothing else is | `lib/worker.mjs` (`whileBusy`), `p7.mjs` (`cmdRun`) |
| Package reader hardening | Input and output size bounds | `lib/package.mjs` |
| Tests | 56 new unit tests, 10 new stub checks | `test/pacer.test.mjs`, `test/measure.test.mjs`, `test/journal-failures.test.mjs`, `test/helpers/tar.mjs` (all new), `test/recorder.test.mjs`, `test/readiness.test.mjs`, `test-containers-down-with-stubs.sh` |
| Documents | README, checklist and plan reconciled (section 8) | `README.md`, `HOST-PREPARATION-CHECKLIST.md`, `docs/p7-physical-linux-test-plan.md` (main checkout) |

All of this sits on top of the uncommitted changes of the earlier sessions, which were preserved.

## 3. Burst-rate enforcement design

**Workload fields** (all bound by the readiness record, all compared at every start): processes, workers, longest time to the cut, headroom, `ratePerWorker`, constant throttle, pool per worker, burst period, burst seconds, quiet rate. With a burst pattern, `ratePerWorker` (`--rate`) is the **maximum burst rate**.

**The rule** (`lib/pacer.mjs`, `nextStart`): after a claim starts, the next may start only once the allowed rate, integrated over the time between, reaches one claim. The allowed rate is the maximum burst rate in the first `burstSeconds` of every `burstPeriodSeconds`, counted from the moment claiming began, and the quiet rate in the rest.

- It is an instantaneous limit, not a budget. A machine slower than the limit simply claims less, and a worker that stalls never catches up, in the burst or after it.
- Segment ends are computed from the period index, never accumulated, so floating-point error does not drift across periods.
- A timer that fires early does not let a claim start early: the pacer checks the clock again.
- In the harness the pacer runs on the monotonic clock, so a wall-clock step (time synchronisation after a boot) cannot move the pattern.
- The claims that can start within `T` seconds number at most `floor(R x burst seconds + Q x quiet seconds) + 1` (`maxClaimsWithin`).

**Sizing uses the same limits** (`lib/sizing.mjs`, `sizePool`): the pool is that allowance times the headroom, and the headroom is at least 2, so the pool is never below what can start. A paced worker therefore cannot exhaust its pool before the planned time. The plan must still fit the 1,000,000-action clearance envelope.

**Fail closed:** a pattern needs all three values; they must be positive and finite; the burst must be shorter than its period; the quiet rate must be below the maximum burst rate; a pattern cannot be combined with a constant throttle; a pool below the requirement is refused before anything is seeded.

**Recorder enforcement:** a readiness record is accepted only with one process, one worker and a burst pattern (so a qualifying run is always paced); the record is never replaced; every start must report exactly the recorded workload, field by field; and the shape is checked again at every start, so a record that says otherwise starts nothing. The sizing the recorder keeps for a qualifying start, which limits the cut's timing, is the bound workload whatever the request says.

**What a run without a pattern does:** it is not paced at all and `--rate` only sizes the pool. That mode exists to measure a machine in a smoke run. A qualifying run cannot use it.

**Proof in tests** (`test/pacer.test.mjs`, 18 tests; the pacing ones drive the real `runWorker` and `createPacer` on a fake clock):
- a fast machine produces exactly 200 claims in each burst window and 20 in each quiet window for the synthetic pattern (20/s for 10 s in 60, 2/s otherwise), and no gap is shorter than its phase allows;
- a slow machine claims at its own speed in the burst and is still held to the quiet rate afterwards;
- a 45-second stall is not made up;
- for eight patterns and durations, the fastest possible worker starts no more claims than `maxClaimsWithin`, that number never exceeds the sized pool, and the pool is never exhausted before the duration ends.

**No production burst numbers were chosen.** The values in the tests are synthetic. The checklist leaves the maximum burst rate and the quiet rate blank.

## 4. Throughput measurement methodology

`node recorder.mjs measure --dir <recorder-dir> --run <run> --cycle <n>` (recorder host, read-only, writes nothing).

| Reported | Source |
|---|---|
| Total acknowledged claims, acknowledged dispatch intents | The cycle's acknowledgement ledger |
| Claims in each 10-second window | Recorder timestamps, anchored at the first acknowledged claim |
| Burst-period rate and quiet-period rate | Claims classified by the configured pattern, divided by the burst and quiet seconds inside the measured duration |
| Maximum observed rate | The most claims in any one second, and the highest complete 10-second window |
| Average rate | (claims - 1) / duration |
| Workers and processes | Counted from the streams that actually acknowledged, and separately from what the start declared |
| Workload configuration | From the cycle's start event, under `configured`, labelled as declarations |
| Measurement duration | First to last acknowledged claim |
| `withinConfiguredLimits` | Whether any window exceeds the configured limits; `null` for an unpaced cycle |

- **Measured and configured are separate objects** and are never mixed. A configured rate is a limit; only `measured` is an observation.
- **Deterministic:** the same ledger gives the same report regardless of line order.
- **One approximation, stated in the output:** the recorder sees acknowledgements, slightly after claims start, and anchors the pattern at the first one. Each window's limit therefore carries a half-second allowance at the peak rate.
- **Procedure for the future rehearsal** (checklist step 10): cycle 1 unpaced with one worker, to learn what the machine reaches; cycle 2 with a pattern, to see the bursts; `measure` on both.

**Not executed:** no workload ran. The 72 to 105 claims per second quoted earlier came from old smoke cycles with 2 and 4 workers on Docker Desktop, and remains the only measurement that exists.

## 5. Smoke lifecycle safety improvements

| Requirement | State |
|---|---|
| Old smoke containers and networks removable without volume removal | `smoke-containers-down.sh` (previous session): removes verified, stopped containers by id and verified networks by name. Its text contains no volume-removing, forcing, Compose or `run` command; the stub test fails if it ever does |
| Preserved smoke volumes cannot be used for a new smoke initialisation | Smoke volumes are now named per generation in `compose.smoke.yml`. The volumes smoke 39 left have no generation and can never match a new name |
| A new smoke environment requires explicitly fresh volumes | `P7_SMOKE_GENERATION` is required by Compose for every smoke command and by `smoke-docker-desktop.sh`, which refuses a generation whose volumes exist and checks after `up` that its containers are on exactly that generation's volumes |
| The qualifying project cannot be targeted | The project name is fixed in both teardown scripts; `--confirm` must equal it; volumes must match the smoke naming and carry the disposable label, which the qualifying volumes never have |
| A partial teardown is detected and resumable | A rerun checks whatever is left and removes it; it says so when no containers remain; with nothing left it does nothing |
| Every destructive operation fails closed | Dry run by default; any failed check removes nothing; after removal the volumes' identity is compared and anything unexpected ends with exit 3. The volume-removing teardown stays disabled without a separate authorisation flag, and refuses outright when generation-named volumes exist |

No second project name was introduced and no volume-deletion mechanism was added. Nothing was run against Docker: the scripts were exercised with stub `docker` commands only, and Compose has never rendered or created a generation-named volume.

**Two limits of this section:**
- **The protection holds wherever the smoke override is used.** `smoke-docker-desktop.sh` and every command written as the documents write it include `compose.smoke.yml`. A hand-typed Compose command for the smoke project with `compose.yml` alone still resolves to the names without a generation, which are the volumes smoke 39 left on the Mac. Compose cannot be made to refuse that from inside the harness.
- **The rewritten volume checks of `smoke-containers-down.sh` have only run against the stub.** The read-only dry run against the real daemon in the previous session was of the earlier version, which knew exactly two volumes.

**Generation naming is a new mechanism introduced in this session** and needs the product owner's acceptance (section 11). What it changes: a new Mac smoke run no longer needs any volume to be deleted, only the two approvals already listed there.

## 6. Failure scenarios tested

| Boundary | What the tests show | Where |
|---|---|---|
| Journal short write | Throws; leaves a torn tail that is reported with its length; no later append hides it | `journal-failures.test.mjs` |
| Journal fsync failure | Throws; the record is in the file but unconfirmed, so the journal is ahead of the database and claims stop | same |
| Database commit uncertainty | The worker stops; the claim is not acknowledged, not retried; no other action is claimed | `pacer.test.mjs` (worker loop) |
| Lost acknowledgement | The worker stops; no dispatch intent is written for that claim; the acknowledgement is not sent again | same |
| Recorder acknowledgement write failure | Answered with an error, never a success; the cycle's file is then damaged and accepts nothing more (**defect fixed**) | `recorder.test.mjs` |
| Recorder restart | Every stream continues exactly where its ledger ends; a ledger ending in a fragment is damaged | same |
| Stale lock recovery | A command killed with `SIGKILL` while holding the lock is taken over by the next one; a live or unreadable owner never is | same |
| Concurrent claim attempts | Two runs claiming one cluster at once: exactly one wins, one registry line; one readiness record posted three times is written once; one process started twice starts once | same |
| Concurrent attestation and start | (previous session) nothing lands between a start's checks and its write | same |
| Abandonment interrupted | The stop marker is written first; a rerun says "already stopped"; the marker is never rewritten | same |
| Readiness record tampering | An edited record never passes for the original configuration; a consistent forgery is a stated trust limit, and the backup comparison shows the edit | same |
| Source digest mismatch, image identity mismatch | Refused at the record and at every start; a package that does not back the declaration is refused eleven ways | same |
| Burst workload changes | Every field, changed alone, is refused at the start and cannot replace the record | same |
| Gateway interface changes | (previous session) ambiguous interfaces stop the gateway; listeners on any other address fail the strict check | `netcheck.test.mjs` |
| Journal truncation and replacement | Cut at a record boundary, cut mid-record, emptied, removed, replaced by another valid journal, identity file replaced: each is seen | `journal-failures.test.mjs` |
| Backup verification failure | A ledger cut short, a changed key (reported by name, never by content), an added file, hard links | `recorder.test.mjs` |

**The defect, in order:** the test `an acknowledgement whose fsync fails ...` was written to require that the same acknowledgement cannot be stored twice by the same server. It failed (`actual: undefined, expected: 'recorder_ack_file_damaged'`). The fix marks the cycle's acknowledgement file as damaged when a write or its sync throws. The test now passes and stays in the suite.

**Four more defects came from the independent review** (section 10.2): a cycle that could be cut twice, a verified source that was not pinned to the run, a ledger fragment that the next append would have made unreadable, and a lost stop marker. Each has a test in `recorder.test.mjs` under "findings of the independent review", written first and run failing (4 of 4 failed), then fixed (4 of 4 pass).

**Two characterisations of the reused Phase 0.5 journal,** which was not modified:
- The per-claim check is incremental: an in-place edit of an earlier record is found only by a full verification. The harness forces one at every cycle start, at adopt, at preflight and in recover, and `check` scans the file independently.
- The journal does not remember a failed fsync: a later append is accepted on top of the unconfirmed record (section 10, R1).

## 7. Source and image identity findings

| Value | Status |
|---|---|
| Harness source on the test machine | **Independently verified by the recorder** against its own copy, at the record and at every start. The report itself is the test machine's |
| Source package SHA-256 | **Independently verified by the recorder:** it hashes the package file |
| Source commit | **Verified by the recorder against the package** (the id `git archive` embeds). Not verified against a repository: an archive can be hand-made with any id |
| Package contents | **Independently verified by the recorder:** the harness source in the package must be the source the recorder runs |
| Image architecture | **Verified by the test machine and checked by the recorder** against the declaration |
| Runtime fingerprint (Node binary, installed-dependency lock, API manifest) | **Verified by the test machine,** bound by the record. New this session |
| Harness image id | **Declared by the operator,** bound, not verified |
| PostgreSQL image id | **Merely documented** in the host evidence; only `server_version` is bound |

- **Improved this session:** the commit and the package checksum moved from "declared" to "verified by the recorder", and the runtime fingerprint narrows what an undetected image change could be.
- **Not claimed:** a container cannot verify its own image id, and the harness does not say it can. The fingerprint is what a container can observe of its own contents; it is not the image id.
- **Never executed:** the fingerprint and the source digest are computed by `p7.mjs`, which only loads inside the image.

## 8. Documentation inconsistencies corrected

- **The five kinds of activity are now defined once and kept apart** in the README and the plan: smoke test, qualifying durability test, physical power-cut test, prototype validation, production implementation.
- **"Unthrottled bursts"** was replaced everywhere by the enforced maximum burst rate.
- **The figure of about 4,295 claims per second** is now described as the envelope's arithmetic limit, explicitly not approved and not a target. The checklist no longer suggests any rate.
- **The storage/identity table** in the README said the commit and checksum were "bound, not verified"; it now states what each value's status really is.
- **Smoke teardown instructions** in the README, the checklist and the firewall notes now use `smoke-containers-down.sh`, and say that fresh volumes come from a new generation, never from a removal.
- **The checklist's burst check** used an inline script; it now uses `recorder.mjs measure`.
- **The checklist's dates and status line** were corrected.
- **Approved decisions were not changed.** Where a number is undecided the documents say so.

## 9. Full test results

| Suite | Result |
|---|---|
| `node --test prototype/m16-p7/test/*.test.mjs` | 209 tests, 209 pass, 0 fail, 0 skipped (153 at the start of the session). By file: harness 48, journal-failures 13, measure 7, netcheck 16, pacer 18, preflight 10, readiness 6, recorder 81, sizing 10 |
| `test-containers-down-with-stubs.sh` | Passed, 46 checks |
| `test-teardown-with-stubs.sh` | Passed, 16 checks |
| `node --check` on every `.mjs`, `bash -n` on every `.sh` | All pass |
| YAML parse of `compose.yml` and `compose.smoke.yml` | Both parse |
| `git diff --check` | Clean |

**Not executed:** any Docker smoke; `firewall/test-with-stubs.sh` (it needs a container); `p7.mjs` and `gateway.mjs` beyond a syntax check; the real `smoke-containers-down.sh` and `smoke-teardown.sh`; Compose rendering of `compose.smoke.yml`.

## 10. Remaining defects and risks

### 10.1 Findings from this session's own review

Severity is for the harness as a test instrument. File and function are given for each.

**Fixed in this session**

| # | Severity | Where | Finding |
|---|---|---|---|
| F1 | High | `recorder.mjs`, `createRecorder`, acknowledgement branch | After a failed write or sync of an acknowledgement, the server's in-memory stream did not include the line that might be in the file. The same acknowledgement sent again was accepted and stored twice. Now the cycle's file is marked damaged and accepts nothing more |
| F2 | Medium | `p7.mjs`, `cmdRun` | A "busy" answer to the start request sent after seeding left seeded actions without a cycle. That one answer is now repeated (`lib/worker.mjs`, `whileBusy`); nothing else is |
| F3 | Medium | `lib/pacer.mjs`, `p7.mjs` `cmdRun` | The burst phase had no limit, so the pool was not a bound. Now enforced, on the monotonic clock |
| F4 | Low | `lib/package.mjs`, `readPackage` | An operator-supplied archive could expand without limit. Input and output sizes are now bounded |
| F5 | Low | `recorder.mjs`, `createRunLocked`; `lib/ledger.mjs`, `writeOnce` | A run key file was created with mode 0644 and made private a moment later (inside a private directory). It is now created 0600 |

**Open**

| # | Severity | Where | Finding |
|---|---|---|---|
| R1 | Medium | `prototype/m16-phase05/lib/journal.mjs`, `Journal.append`; `lib/ledger.mjs`, `appendDurable` | **A failed fsync is not remembered.** The call throws, but a later append is accepted on top of a record whose durability is unknown. On Linux a later successful fsync does not prove the earlier data reached the disk. The harness stops the worker on the error, and a claim that failed this way leaves the journal ahead of the database (quarantine), so nothing is silently trusted; but the journal itself will append again during clearance. Phase 0.5 code, unchanged by decision: a design question for the production implementation |
| R2 | Medium | `p7.mjs`: `cmdPreflight`, `cmdRun`, `identityNow`, `burstOf` | **Never executed.** The file only loads inside the image. Its new glue (burst flags, pacing, identity report, busy retry) is syntax-checked and was read line by line, nothing more. A plain bug there would surface at the first smoke run |
| R3 | (fixed, see 10.2) | `recorder.mjs`, start branch of `createRecorder` | The workload shape was checked only when the record was accepted. It is now checked at every start |
| R4 | Low | `test/recorder.test.mjs`, `makeReady` and `callerFor` | Several tests still create the readiness record with a helper that writes the ledger directly. The record it writes now has decision B1's shape, the two-process protocol tests were moved to a smoke run, and one test takes a qualifying run from `create-run` through two cycles using only the real commands and endpoints. The helper remains a shortcut around the endpoint's own checks |
| R5 | Medium | `gateway.mjs`; `lib/gateway.mjs`, `internalAddress` | The listener binding has never run in a container. If the assumption (the internal interface is the one without the default route) is wrong on a given Docker, the gateway exits and the stack is unusable until it is fixed. It fails closed |
| R6 | Medium | `compose.smoke.yml` | Generation-named volumes have never been rendered or created by Compose. The file parses as YAML; the interpolation form is the one `compose.yml` already uses |
| R7 | Low | `lib/measure.mjs`, `throughputReport` | The pattern is anchored at the first acknowledged claim, not at the harness's own start of claiming, and each window's limit carries a half-second allowance. A violation smaller than that allowance would not be flagged |
| R8 | Low | `lib/lock.mjs`, `withDirLock` | A process killed between writing its temporary file and linking it leaves a small stray file (never mistaken for the lock). A directory that does not exist is not locked (nothing can be working in it) |
| R9 | Low | `smoke-teardown.sh` | It knows only the two volumes without a generation and refuses when others exist, so nothing in the harness can remove a generation-named smoke volume. That is the intended state; removal remains a separate decision |
| R13 | Medium | `compose.yml` with the smoke project name | A hand-typed smoke Compose command that leaves out `compose.smoke.yml` resolves to the volume names without a generation: on the Mac, the preserved smoke-39 volumes. The scripts and the documented commands always include the override; nothing can enforce it for a command typed by hand |
| R10 | Low | `smoke-docker-desktop.sh` | It was edited (generation, exact-name volume checks) and cannot be run in this session. It also does not yet exercise the burst pacing, `measure`, the package check or the gateway's bound address |
| R11 | Low | `recorder.mjs`, `compareBackup` | `sameFilesystem: false` does not prove a separate physical disk; whole ledgers are read into memory |
| R12 | Informational | `prototype/m16-phase05/lib/journal.mjs`, `Verifier.check` | Between full verifications the journal check is incremental. An in-place edit of an earlier record is found at the next forced full verification (cycle start, adopt, preflight, recover) or by `check`'s independent scan, not by the next claim |

No path was found that retries an ambiguous claim, removes a Docker volume outside the disabled `smoke-teardown.sh`, or prints a run key.

### 10.2 Independent review

A second reviewer read the complete uncommitted change set and the surrounding files, read-only, without being given this session's conclusions. Some files changed while it read; each finding below was checked against the current code before anything was done. Its findings and what was done with each:

| # | Severity | Finding | Where | Disposition |
|---|---|---|---|---|
| H1 | High | **A cycle could be cut twice.** The lock covered only the scheduling step; a second `cut` during the random wait passed every check, and both would fire the plug command. A cycle checked during the wait was still cut | `recorder.mjs`, `cut` command | **Fixed.** A schedule held by a running process blocks another; after the wait the command re-takes the lock, re-checks, and writes `cut_sent` inside it. Test: the plug command runs exactly once; a cycle checked meanwhile is not cut; a dead scheduler's schedule is void |
| H2 | High | **The verified source was not pinned to the run.** The package was checked at `create-run`, but later checks compared the test machine with the recorder's disk at that moment. Both hosts moving to the same other code would have been accepted | `recorder.mjs`, `identityRefusal`, `createRunLocked` | **Fixed.** The digest is stored in the run's write-once record and bound; the recorder's own copy and the test machine's report must both equal it |
| M1 | Medium | The start did not enforce one process, one worker, a burst pattern; the test helpers wrote records the endpoint would refuse | `recorder.mjs` start branch; `test/recorder.test.mjs` | **Fixed.** Checked at every start. The helper's record has the B1 shape; the two-process protocol tests run on a smoke run |
| M2 | Medium | The sizing stored with a start was whatever the request said, and the cut's timing limit trusted it | `recorder.mjs`, start branch and `cutRefusal` | **Fixed.** For a qualifying start the stored sizing is the bound workload |
| M3 | Medium | Bridge addresses are bound but the networks have no fixed subnets: recreating the qualifying networks would make every later start stale for good | `compose.yml`, `lib/netcheck.mjs` | **Documented, not changed.** Fixing subnets changes the Compose networks and cannot be tried without Docker. The README and checklist say never to take the qualifying project down during a series |
| M4 | Medium | A torn tail in a ledger would fuse with the next appended line and break every later read | `lib/ledger.mjs`, `appendDurable` | **Fixed.** Nothing is appended to a ledger ending in a fragment; it stays readable |
| L1 | Low | The INCONCLUSIVE stop is two writes; a crash between them left a qualifying run not stopped | `recorder.mjs`, result branch | **Fixed** at the start: a stored result that stops a run refuses the next start |
| L2 | Low | The server's wait for the lock blocks acknowledgements; the README said 2 seconds, the code 8 | `recorder.mjs`, `lib/lock.mjs` | **Documented correctly.** The behaviour stays: commands hold the lock for milliseconds |
| L3 | Low | Lock ownership is checked by process id on one host; a directory shared between hosts would defeat it. A crash while holding the takeover guard needs a person | `lib/lock.mjs` | **Documented:** the recorder directory must be local to its one host |
| L4 | Low | The run key was created 0644, then made private | `recorder.mjs` | **Fixed** (already, F5) |
| L5 | Low | `smoke-teardown.sh` runs `docker compose ... down` from a directory with `compose.yml`, so it fails on the required variables after its checks and before any removal | `smoke-teardown.sh` | **Not changed.** It fails closed; the script is disabled and was not to be run |
| L6 | Low | `P7_SMOKE_GENERATION` set with the qualifying project made the evidence script look up a volume that does not exist | `host-evidence.sh` | **Fixed:** the generation applies to the smoke project only |
| L7 | Low | A new ledger file had no directory sync; on macOS `fsync` does not flush the drive cache | `lib/ledger.mjs` | Directory sync **added**; the macOS limit is **documented** |
| L8 | Low | An unreadable path still gives a valid-looking runtime fingerprint; the paths were not confirmed in the image | `p7.mjs`, `RUNTIME_FILES` | **Documented** as a limit of the fingerprint |
| L9 | Low | The pacer used the wall clock | `p7.mjs` | **Fixed** (already: monotonic clock) |
| I1 | Info | `cmdPreflight`'s comment still said read-only with only probe traces | `p7.mjs` | **Corrected** |
| I2 | Info | The package reader refuses any non-regular entry; one tracked symlink would block `create-run` | `lib/package.mjs` | **Checked:** the packaged paths contain no symlink |
| I3 | Info | The smoke script put key content on a `grep` command line | `smoke-docker-desktop.sh` | **Fixed:** the pattern is read from the key file |

**What that review checked and found sound:** no duplicate claim or acknowledgement path (`runWorker` never retries; `whileBusy` repeats only the authenticated busy answer); acknowledgement and abandon ordering; the lock's takeover re-check; readiness immutability; `cmdRun` and `cmdPreflight` building the same workload and binding; the pacing bound; the package parser (nothing extracted, bounded, duplicates and traversal rejected); the Docker scripts (no volume-removing command in the containers-and-networks script, generation names cannot make Compose reattach an older volume); no key or MAC logged or printed.

**What it did not read in full:** the two stub tests, `test/measure.test.mjs`, part of `smoke-docker-desktop.sh`, and `cmdCheck`/`cmdRecover`.

## 11. Work requiring product-owner decisions

1. **Acceptance of generation-named smoke volumes** (`P7_SMOKE_GENERATION`, `compose.smoke.yml`), a mechanism introduced in this session so that a new smoke environment has fresh volumes without any removal.
2. **The burst workload's four numbers:** maximum burst rate, burst seconds, burst period, quiet rate. They should follow a one-worker measurement on the host.
3. **Authorisation to run `smoke-containers-down.sh --confirm` on the Mac,** which removes the three stopped smoke-39 containers and three networks and keeps both volumes.
4. **Authorisation for a Docker smoke run** with a new `P7_SMOKE_GENERATION`: the first execution of the pacing, the gateway binding, the identity report and the generation volumes.
5. **A commit of the reviewed changes.** The source package and the identity chain need a real commit.
6. **Whether the reused journal should treat a failed fsync as fatal** (R1). It is Phase 0.5 code, kept unchanged by decision.
7. **Whether the qualifying networks should get fixed subnets** (independent review, M3), so that recreating them cannot invalidate a readiness record. It changes `compose.yml` and needs a Docker run to verify.

## 12. Recommended next milestone

**Isolated Docker integration validation,** in this order, each step needing its own approval:

1. Review and commit the current changes.
2. Run `smoke-containers-down.sh` on the Mac (dry run, then confirmed).
3. Extend `smoke-docker-desktop.sh` to cover what is new: an unpaced one-worker measurement cycle, a paced cycle checked with `measure`, the gateway's bound address, a refused source or image mismatch, a repeated preflight.
4. Run it with a new generation and review the evidence.
5. Decide the burst numbers from the measurement.

Only after that does preparing the real host make sense. The 20 physical power-cut cycles remain separately unauthorised.

## Session record

- **Starting HEAD and ending HEAD:** `a12e6156033a8ea240cef7d007357cc10e2a277e`. **Branch:** `prototype/m16-p7-durability-harness`. No commit, push, merge or branch switch.
- **Modified** (under `prototype/m16-p7/`): `README.md`, `compose.smoke.yml`, `compose.yml`, `firewall/README.md`, `gateway.mjs`, `host-evidence.sh`, `lib/gateway.mjs`, `lib/ledger.mjs`, `lib/netcheck.mjs`, `lib/readiness.mjs`, `lib/sizing.mjs`, `p7.mjs`, `recorder.mjs`, `smoke-docker-desktop.sh`, `smoke-teardown.sh`, `test-teardown-with-stubs.sh`, `test/netcheck.test.mjs`, `test/readiness.test.mjs`, `test/recorder.test.mjs`, `test/sizing.test.mjs`.
- **Untracked** (under `prototype/m16-p7/`): `.gitignore`, `HOST-PREPARATION-CHECKLIST.md`, `lib/lock.mjs`, `lib/measure.mjs`, `lib/pacer.mjs`, `lib/package.mjs`, `lib/source.mjs`, `lib/worker.mjs`, `smoke-containers-down.sh`, `test-containers-down-with-stubs.sh`, `test/helpers/tar.mjs`, `test/journal-failures.test.mjs`, `test/measure.test.mjs`, `test/pacer.test.mjs`. Also untracked: this report (`docs/m16-p7-autonomous-engineering-report.md` in the harness worktree). In the main checkout: `docs/p7-physical-linux-test-plan.md` (edited; untracked by decision).
- **Docker:** no `docker` command of any kind was run in this session, so no Docker resource was started, stopped, created, removed or even listed. The preserved smoke project was last listed in the previous session (three exited containers, three networks, two volumes).
- **Preserved state, re-verified by hashing files:** 1,553 smoke evidence files, 0 mismatches; the preserved recorder directory unchanged (`keys`, `runs`, `volumes.jsonl`; 50 runs; 14 registry lines); both bundles and all 170 evaluation files match; no tags; refs unchanged; `prototype/m16-phase05` untouched.
- **Git reads that write only outside the repository:** one test runs `git archive HEAD` of two library directories into a temporary directory, and one manual check wrote a full `git archive HEAD` of the packaged paths into the session's scratch directory, both to try the package reader on real archives. Neither changes anything in the repository.

## Addendum, 18 November 2026

This report describes the session of 17 November and is left as written. The final review of 18 November changed three things it says; the full account is in `docs/m16-p7-commit-readiness-report.md`.

- **R1 (a failed journal fsync is not remembered)** is closed in the harness, by the product owner's decision that a failed journal fsync must fail closed: `lib/failclosed.mjs` wraps the journal. The Phase 0.5 files are still unchanged. The recorder-ledger half of R1 stays open.
- **A new rule:** the quiet rate of a qualifying workload must be at least 0.2 claims per second, or a paced worker would be counted as stopped by the recorder's 10-second silent-stop check.
- **Section 5's statement that the smoke script always includes `compose.smoke.yml`** was not true of two `kill` commands in it. They include it now.
- **Unit tests:** 229, not 209.
- **Both additions were accepted by the product owner on 18 November.** The floor is also enforced where the workload is sized, and the wrapper's memory is per process, with a marker for other processes that is best effort only.
