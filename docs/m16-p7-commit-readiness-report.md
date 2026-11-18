# M16 P7: final review and commit-readiness report

**Date:** 18 November 2026. **Branch:** `prototype/m16-p7-durability-harness`. **HEAD:** `a12e6156033a8ea240cef7d007357cc10e2a277e`. **Nothing is committed.** This file is in `docs/` of the harness branch.

**P7 is NOT TESTED and NOT PASSED.** Everything below was checked by reading the code and by unit and stub tests on a development machine. No Docker command was run, no container has executed any of this, and no real host exists.

## 1. Verdict

The change set is prepared as a prototype checkpoint and waits for the product owner's commit authorisation. It is not evidence of anything about durability.

**Both additions of this review were accepted by the product owner on 18 November 2026 and are incorporated:**

1. **The fail-closed journal wrapper,** for the prototype: any journal write failure, a dispatch record's included, prevents every later journal operation; the Phase 0.5 journal is unchanged; the wrapper is a separate file; the marker is never removed automatically. Its limits are in section 5. The main one: **if the marker itself cannot be written, a restarted process does not know about the failure.**
2. **The quiet-rate floor of 0.2 claims per second,** as an eligibility floor. It selects no workload: the burst and quiet rates remain undecided until the one-worker measurement. It is enforced where the workload is sized and by the recorder (section 2.1).

## 2. What this review changed

Each has a test that was written first and seen failing.

| Change | Why | Files |
|---|---|---|
| **A quiet rate below 0.2 claims per second is refused** (accepted 18 November) | Found in this review. The recorder counts a worker with no acknowledgement in the 10 s before the cut as stopped, which makes the cycle INCONCLUSIVE and, in a qualifying run, ends the series. Paced quiet claims are `1 / quiet rate` seconds apart, so a low quiet rate would have turned every cut in a quiet part into an INCONCLUSIVE cycle. The rule alone gives 0.1 per second; the floor is 0.2, so the gap is at most half the window. It is an eligibility floor, not a proposed rate | `lib/sizing.mjs` (the floor and the silent-stop window, defined once), `lib/readiness.mjs`, `recorder.mjs`, tests, README, checklist |
| **A failed journal write fails closed** (accepted 18 November) | Section 5 | `lib/failclosed.mjs` (new), `p7.mjs`, `test/failclosed.test.mjs` (new), README |
| **Two `kill` commands in `smoke-docker-desktop.sh` now include `compose.smoke.yml`** | They were the only smoke Compose commands in the scripts without the override. `kill` cannot create or attach a volume, so nothing was at risk, but the earlier report said the scripts always include it | `smoke-docker-desktop.sh` |

### 2.1 Quiet-rate floor: where it is enforced, and the evidence

| Place | What refuses | Evidence |
|---|---|---|
| **Workload sizing** (`lib/sizing.mjs`, `burstProblem`, used by `sizePool` and `sizePlan`) | Any burst pattern with a quiet rate below 0.2. `p7.mjs preflight` is then BLOCKED and `run` refuses before anything is seeded | `test/sizing.test.mjs`: 0.01, 0.1, 0.19 and 0.1999 are refused for the pool and for the plan; 0.2 is sized; higher rates and a workload without a pattern are sized as before. Written first and seen failing |
| **Recorder, readiness record** (`vetTestBinding` runs the same sizing; `qualifyingWorkloadProblems` checks again) | `readiness_not_ready: workload: the quiet rate must be at least 0.2 claims per second` | `test/recorder.test.mjs`, through the real endpoint: 0.01 and 0.19 are refused and leave no record; 0.2 is recorded and a start on it is vetted |
| **Recorder, every start** | The same refusal, even for a record that is consistent with what the start reports | Same test: a record with 0.1 written into the ledger by hand, with a matching digest, starts nothing |
| **Recorder, pure rule** | `qualifyingWorkloadProblems` | `test/readiness.test.mjs` |

- The sizing rule also applies to a **smoke** run that uses a burst pattern. That is consistent: the recorder's silent-stop rule applies to every run type.
- **One existing test input was changed for this:** `test/pacer.test.mjs` sized a synthetic pattern with a quiet rate of 0.01, which is no longer eligible; it now uses 0.2. No assertion changed.
- A constant throttle (`--target-rate`, smoke only) below 0.1 would trip the same silent-stop rule and is not refused. A qualifying run cannot use a throttle.

### 2.2 Assertions restored after an independent review of the changed tests

A second reviewer read the complete diff of the four pre-existing test files, every removed and added line, without my conclusions. Its count for `test/recorder.test.mjs`: 64 removed assertion lines, of which 60 are the same check on updated fixtures or a stricter or equivalent check for an approved change. **Four were not, all low severity; three are restored and one is explained:**

| Finding | What was done |
|---|---|
| A helper's expected error became a pattern with an optional `readiness_stale:` prefix, so three older checks would also have passed without the prefix | **Restored:** every call states the whole expected error again, matched exactly |
| "Creating a run does not touch the registry, so an existing record stays valid" was no longer asserted | **Restored** |
| A predecessor's record planted as the first record of a continuing run (`recorder.continues` named in the refusal) was no longer asserted | **Restored** as its own test, on its own runs |
| A check that the test helper supplies a default readiness half | **Not restored:** the helper no longer does that; it tested the helper, not the recorder |

`netcheck`, `readiness` and `sizing` tests lost nothing. From the same review, in the added tests:

- **Fixed:** the cut-once test named a branch it never asserted ("the run stopped while the cut was waiting"); it is asserted now. The end-to-end test's title claimed real commands only, though it writes the cut event directly; the title says so now.
- **Left as they are, and weaker than their names** (section 7, item 13): two assertions in the B6 test compare directories that `abandon` is never given, so they cannot fail; two lock tests would pass without the lock (the cross-process lock tests are the real ones); one identity refusal is asserted only through the pure function; one test skips itself outside a git checkout; the cut-once test depends on a 2-second window and could fail on a heavily loaded machine.

## 3. Review findings by task

### 3.1 Burst pacer: sizing and execution use identical limits

- **One set of numbers.** `p7.mjs run` passes the same rate, burst period, burst seconds and quiet rate to `sizePool`, to the pacer and to the readiness binding. For a qualifying run those numbers are taken from the readiness record, and a flag that differs is refused.
- **The recorder recomputes the sizing.** It does not only compare fields: `vetTestBinding` runs `sizePlan` on the bound numbers and refuses a pool below the requirement or a plan above 1,000,000 actions, at the record and at every start.
- **One formula.** The pacer's allowance and the pool requirement both come from `burstSecondsWithin`. The pool is the allowance times the headroom (at least 2); the most claims that can start is the allowance plus one.
- **Checked numerically in this review, and run again after the quiet-rate floor with eligible quiet rates only:** 4,000 random patterns (whole and fractional seconds, burst rates from 0.5 to 300 per second, quiet rates from 0.2, durations to 1,500 s). The fastest possible worker never started more claims than `maxClaimsWithin`, that figure never exceeded the pool, and the pacer and the sizing agreed on burst or quiet at every period boundary. This was an ad hoc script, not added to the suite; the suite's own eight-pattern test stays.
- **Limit:** the bound holds for the planned time. The recorder limits when `cut` may fire, not when the power really goes: a manual cut comes some seconds after the prompt. The headroom covers roughly as long again as the planned time.

### 3.2 Generation-named smoke volumes

- **Both volumes carry the generation:** `opspilot-m16-p7-smoke_pgdata_<generation>` and `..._state_<generation>`, each labelled with it.
- **The smoke-39 volumes cannot be selected through the override.** Their names have no suffix; `${P7_SMOKE_GENERATION:?}` refuses an unset or empty value, so a name without a suffix cannot be produced. The start script accepts lower-case letters and digits only (1 to 24), looks each name up exactly, refuses a generation whose volumes exist, and checks after `up` that the containers are on exactly those two volumes.
- **Still open (R13):** a Compose command typed by hand for the smoke project without `compose.smoke.yml` resolves to the old names. Nothing inside the harness can refuse that.
- **Never rendered by Compose.** Rendering the file counts as running Docker and was not done.

### 3.3 Source package verification: remaining trust assumptions

Verified by the recorder: the package's SHA-256, the commit id inside it, and that the harness source in it is the source on the recorder's disk; that digest is pinned to the run. What is still taken on trust:

1. **The commit id is whatever the archive says.** It is not checked against a repository, and an archive can be made by hand with any id. If an archive carries more than one global header, the last one wins.
2. **Only the harness files are compared by content.** Everything else in the package, including what the image is built from, is covered by the package checksum alone.
3. **Nothing ties the image to the package.** The image id is declared. The runtime fingerprint is the container's own report over three files, and an unreadable file still yields a valid-looking fingerprint.
4. **The test machine's source digest is self-reported.** The model is an honest operator who can make mistakes, not an adversary on the test machine.
5. **The recorder checks its disk, not its memory.** A recorder server started before its files were changed keeps running the old code while the check reads the new files. The server must be restarted after any source change, and before `create-run`.
6. **The digest covers listed directories, not recursively,** and not Node itself on the recorder host.
7. **The PostgreSQL image** is bound only by its server version.

### 3.4 `smoke-containers-down.sh`

- **It cannot remove a volume.** Its only removing commands are `docker rm <id>` and `docker network rm <name>`, without options. `docker rm` without `-v` leaves even anonymous volumes. The stub test fails if the script's text ever contains a volume, prune, force, Compose, run, start or stop command.
- **It cannot reach another project.** Containers, volumes and networks are selected by the exact label value `com.docker.compose.project=opspilot-m16-p7-smoke`; the qualifying project's name is a prefix of that, and a label filter matches the whole value. Each object's label is then read back and compared. The one `name=` filter is used only to find something to refuse. The project name is fixed and `--confirm` must equal it.
- **It stops nothing:** a container that is not already stopped is a refusal.
- **Limit:** the stub shows which commands the script sends, not how a real daemon matches a filter. The current version has never run against Docker.

### 3.5 What was read

- **In full, by me:** `p7.mjs`, `recorder.mjs`, both Compose files, `smoke-containers-down.sh`, `smoke-teardown.sh`, `host-evidence.sh`, and in `lib/`: `failclosed`, `ledger`, `lock`, `measure`, `pacer`, `package`, `readiness`, `sizing`, `source`, `worker`. **As diffs against the last commit, not whole files:** `smoke-docker-desktop.sh`, `test-teardown-with-stubs.sh`, `gateway.mjs`, `lib/gateway.mjs`, `lib/netcheck.mjs`. Also in full: the reused Phase 0.5 journal and claim library, the journal section of the design, the README diff, the firewall notes diff, the whole checklist, both stub tests, and every new test file (`pacer`, `measure`, `journal-failures`, `failclosed`, the tar helper).
- **In full, by the independent reviewer:** the diff of the four pre-existing test files (section 2.2). I read every removed line of it and the tests it flagged, not every added line.
- No path was found that retries an ambiguous claim, removes a volume outside the disabled `smoke-teardown.sh`, removes the journal-failure marker, or prints a run key.
- **Source-package and image-identity limits:** the README table was accurate but left out four of the limits of section 3.3 (the image is not tied to the package; the last archive header wins; the recorder checks its disk, not its running process; the digest is not recursive). They are now in the README and in checklist item O4, and the checklist tells the operator to restart `serve` after any source change.

## 4. Failed journal sync: what happened before, and now

"Before" is the reused Phase 0.5 journal alone. The claim itself was already safe: the transaction rolls back and the journal is one claim ahead, so later claims are refused. The gap was in what could be written afterwards.

| Write that fails | Before: same worker | Before: another worker, or a later command in the same boot | Now |
|---|---|---|---|
| `claim` | Stops | Claims refused (journal ahead), but a `dispatch` for an earlier claim was appended on top | Every append refused; not trusted |
| `void` | Stops | Claims refused (journal ahead) | The same, and nothing appended |
| `dispatch` | Stops | **Journal still trusted: claims continued on top of the unconfirmed record** | Every append refused; not trusted |
| `cleared` (recovery) | Command fails | **A rerun appended a second `cleared` record and committed** | The rerun stops the run before it inspects or clears |
| Torn-tail repair record | Command fails | **A rerun found the repair "already applied" and carried on, though its sync never succeeded** | `recover` stops the run at once; a rerun stops it again |

After a reboot the page cache is gone and every command verifies the journal in full from the disk; that was so before and is unchanged.

## 5. The fail-closed journal wrapper (accepted for the prototype, 18 November 2026)

- **Where:** `lib/failclosed.mjs`, a subclass the harness uses in place of the journal class. **The Phase 0.5 files are not edited**; `git status` shows nothing under `prototype/m16-phase05`.
- **Call sites:** `p7.mjs` builds every journal object through it (preflight, init, adopt, the start check of `run`, each worker, check, recover). The reused `claim`, `appendLocked` and `clear` only ever call `append` and `state` on the object they are given, which are the two methods the wrapper overrides. The one journal write the harness makes itself, the torn-tail repair record, goes through the wrapper's `appendBytes`. Nothing else in the harness writes to the journal file, except two deliberate damage steps in the Docker Desktop smoke script (a torn line and an invalid final line, written with shell commands inside the container).
- **What counts as a failure:** a failed sync, a write call that fails, and a short write, including one that wrote nothing. The only refusals that set no marker are the three the journal makes before it writes a byte (file missing, corrupt, or ending in a torn line an earlier crash left); nothing was written there. Before this review's last change a short write was not remembered; it is now, with its test written first.
- **What it does:** after any failed journal write or sync, every later append is refused and the journal reports itself as not trusted. `claim` answers `quarantined`, `preflight` is BLOCKED, `run` and `adopt` refuse, and `recover` stops the run on the recorder before it probes, repairs or clears anything.
- **Where the memory is:**
  - **In the process,** for every journal object on that directory. Always. This was per object before this review; `p7.mjs` builds one object per worker, so another worker of the same process could have carried on if the marker was missing.
  - **In a marker file** beside the journal, `journal-write-failed.json`. This is how another process, or the same command started again, learns of it.
- **Never removed automatically:** no code in the harness deletes, rewrites, renames or expires the marker (every reference to the journal directory in the code, the scripts and the Compose files was read: they read it, write the journal and the two write-once files, or, in the smoke script, damage the journal on purpose; and a test shows refused appends, state checks, new objects and a restarted process leave it byte for byte the same file). Only deleting the journal volume would take it away; the one script that deletes a volume is the disabled `smoke-teardown.sh`, for smoke volumes.

**Limits. There is no unconditional guarantee across processes.**

| Case | What happens | Shown by |
|---|---|---|
| Marker written | A restarted process refuses and reports what failed | Test with a real second process |
| **Marker could not be written** (it goes to the volume whose write just failed) | **A restarted process does not know and appends.** Only the process that saw the failure refuses, while it lives | Test with a real second process, which pins exactly this |
| Marker written but its own write or sync failed | Other processes of the same boot see it; it may be gone after a reboot or power cut. The harness then has only what is on the disk, verified in full, and no longer knows a write had failed | Reported as such in `journalWriteFailure.marker` |
| Marker empty, torn, not an object, or unreadable | Counts as a failure, never as none | Test |

- **It errs on the side of stopping:** any error from an append other than those three refusals sets the marker for good, including an error opening or reading the file before a byte was written.
- **A second, independent trace** is the `worker_stopped` event the worker sends to the recorder, when it arrives. It makes the cycle INCONCLUSIVE; it does not block a restarted process.
- **The verdict is not changed by the marker.** A cycle that passed its check while a marker exists stays `PENDING_RECOVERY`, because `recover` stops the run, so it never counts toward the series.
- **Departure from the design, accepted:** the design lets a failed `dispatch` line leave trust unaffected; here any failed journal write stops everything. Whether the production implementation should do the same has not been decided.
- **Not covered:** the recorder's own ledgers. A failed acknowledgement write marks that cycle's file damaged; a failed write to another recorder ledger is only answered with an error.
- **Never executed:** `p7.mjs` only loads inside the image. Its part of this is syntax-checked only.

## 6. Proposed commit

**Message** (Conventional Commits, no attribution lines):

```
feat: enforce the P7 burst workload, verify the source package, fail closed on journal write failure

Prototype harness only (prototype/m16-p7). P7 remains NOT TESTED and NOT
PASSED: nothing in this commit has run in Docker or on a real host.

- Workload (decision B1): one process, one worker and a burst pattern are
  required for a qualifying run and checked at every start. A pacer limits
  every claim start to the maximum burst rate and the quiet rate, and the
  pool is sized from the same numbers. A quiet rate below 0.2 claims per
  second is refused by sizing and by the recorder, because the recorder
  would count the worker as stopped. The rates themselves are undecided.
- Measurement: `recorder.mjs measure` reports what a cycle did from the
  acknowledgement ledger, apart from what was configured.
- Identity (decision B3): create-run checks the source package's SHA-256,
  embedded commit and contents, and pins the source digest to the run. The
  image id is declared, not verified.
- Recorder: one lock per directory, a cycle is cut at most once, a failed
  acknowledgement write damages the cycle's file, a ledger ending in a
  fragment is not appended to, `abandon` for a failed init (decision B6).
- Journal: a failed write or fsync is remembered in the process and in a
  marker beside the journal, and every later append is refused
  (lib/failclosed.mjs). If the marker cannot be written, a restarted process
  does not know. The Phase 0.5 library is unchanged.
- Gateway: listens on the internal address only.
- Smoke lifecycle: volumes are named per generation; containers and
  networks are removed by smoke-containers-down.sh, which keeps every
  volume; the volume-removing teardown is disabled without a separate flag.

229 unit tests and two stub suites pass. Not executed: any Docker run,
p7.mjs and gateway.mjs beyond a syntax check, the teardown scripts.
```

**Include** (38 paths, all in the harness worktree):

- Modified, under `prototype/m16-p7/`: `README.md`, `compose.smoke.yml`, `compose.yml`, `firewall/README.md`, `gateway.mjs`, `host-evidence.sh`, `lib/gateway.mjs`, `lib/ledger.mjs`, `lib/netcheck.mjs`, `lib/readiness.mjs`, `lib/sizing.mjs`, `p7.mjs`, `recorder.mjs`, `smoke-docker-desktop.sh`, `smoke-teardown.sh`, `test-teardown-with-stubs.sh`, `test/netcheck.test.mjs`, `test/readiness.test.mjs`, `test/recorder.test.mjs`, `test/sizing.test.mjs`.
- New, under `prototype/m16-p7/`: `.gitignore`, `HOST-PREPARATION-CHECKLIST.md`, `lib/failclosed.mjs`, `lib/lock.mjs`, `lib/measure.mjs`, `lib/pacer.mjs`, `lib/package.mjs`, `lib/source.mjs`, `lib/worker.mjs`, `smoke-containers-down.sh`, `test-containers-down-with-stubs.sh`, `test/failclosed.test.mjs`, `test/helpers/tar.mjs`, `test/journal-failures.test.mjs`, `test/measure.test.mjs`, `test/pacer.test.mjs`.
- New, under `docs/`: `m16-p7-autonomous-engineering-report.md`, `m16-p7-commit-readiness-report.md`. These two are the product owner's choice; the harness does not depend on them.
- Both additions are accepted, so nothing in this list is conditional any more.

**Exclude:**

- `docs/p7-physical-linux-test-plan.md` in the main checkout: never committed, by decision. It was edited in this review: a section 0.6 with the two decisions of 18 November and their limits, and one heading that was printed twice on a line.
- `.claude/` in the main checkout.
- `prototype/m16-p7/evidence/` if it ever appears (ignored by the new `.gitignore`).
- Everything outside the harness worktree: the preserved smoke directory, the baselines, the review manifests.
- Anything under `prototype/m16-phase05/`, `apps/`, `services/` (none is changed).

**After the commit, not before:** the source package and the identity chain need this commit's id. The recorder host must then run exactly the committed files.

## 7. Unresolved defects and risks

| # | Severity | Risk |
|---|---|---|
| 1 | Medium | **`p7.mjs` has never run** with any of this: burst flags, pacing, identity report, busy retry, the fail-closed journal and the repair path. A plain bug there shows at the first smoke run |
| 2 | Medium | **The gateway's listener binding has never run in a container.** If its assumption about the interfaces is wrong, the gateway exits and the stack is unusable. It fails closed |
| 3 | Medium | **Generation-named volumes have never been rendered or created by Compose** |
| 4 | Medium | **A hand-typed smoke Compose command without the override** resolves to the preserved smoke-39 volume names (R13) |
| 5 | Medium | **Bridge subnets are not fixed** (deferred by decision 7): recreating the qualifying networks invalidates a readiness record for good |
| 6 | Medium | **The fail-closed marker's limits** (section 5): no guarantee across processes when the marker cannot be written or its sync failed; the recorder's other ledgers are not covered |
| 7 | Low | **The trust assumptions of section 3.3** |
| 8 | Low | `smoke-docker-desktop.sh` was edited and cannot be run here; it does not yet exercise pacing, `measure`, the package check or the gateway's bound address |
| 9 | Low | Some recorder tests still create the readiness record with a helper that writes the ledger directly |
| 10 | Low | `measure` anchors the pattern at the first acknowledged claim; a violation smaller than its half-second allowance is not flagged |
| 11 | Low | The recorder lock assumes one host and a local directory; a crash while holding the takeover guard needs a person |
| 12 | Low | `smoke-teardown.sh` would fail on Compose's required variables after its checks. It is disabled and fails closed |
| 13 | Low | **Some added tests are weaker than their names** (section 2.2): assertions that cannot fail in the B6 test, two lock tests that would pass without the lock, one refusal asserted only through a pure function, one self-skipping test, and a 2-second timing window in the cut-once test |
| 14 | Low | The quiet-rate floor does not cover a constant throttle (smoke only) |

## 8. Test results

Run after the last edit.

| Suite | Result |
|---|---|
| `node --test prototype/m16-p7/test/*.test.mjs` | 229 tests, 229 pass, 0 fail, 0 skipped. By file: failclosed 14, harness 48, journal-failures 13, measure 7, netcheck 16, pacer 18, preflight 10, readiness 7, recorder 83, sizing 13 |
| `test-containers-down-with-stubs.sh` | Passed, 46 checks |
| `test-teardown-with-stubs.sh` | Passed, 16 checks |
| `node --check` on every `.mjs`, `bash -n` on every `.sh` | All pass |
| YAML parse of both Compose files | Both parse |
| `git diff --check` | Clean |
| The proposed commit message against `.githooks/commit-msg` | Passes |

**Not executed:** any Docker command, including Compose rendering; `firewall/test-with-stubs.sh` (it needs a container); `p7.mjs` and `gateway.mjs` beyond a syntax check; `smoke-containers-down.sh`, `smoke-teardown.sh` and `smoke-docker-desktop.sh` themselves; `init`, `run`, `recover`, `cut`.

## 9. Session record

- **HEAD at start and end:** `a12e6156033a8ea240cef7d007357cc10e2a277e`. No commit, push, merge, branch switch or history change.
- **Docker:** I ran no `docker` command. The two stub suites put a stub named `docker` first on their own `PATH`. The independent reviewer was instructed to work read-only and to run no Docker command, and reported that it changed nothing; I cannot verify more than its report and the unchanged file list.
- **Preserved state, re-checked by hashing as the last step:** all 1,553 entries of the smoke manifest match (1,113 evidence files and 440 recorder files; the file counts on disk are the same, plus the 50 run keys, which the manifest leaves out on purpose); the preserved recorder directory is unchanged (50 runs, 14 registry lines); both bundles and all 170 evaluation files match; no tags; refs differ from the review manifest only by this branch's own head, as before; `prototype/m16-phase05` has no changes; the main checkout shows only `.claude/` and the plan as untracked.
- **Production application code:** not touched.
