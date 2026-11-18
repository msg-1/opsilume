# Milestone 16, P7: durability harness

**Research prototype. Not production code. Not a durability result.** P7 (native Linux durability) remains **NOT APPROVED and NOT TESTED**. This directory contains the harness for the physical power-loss test described in `docs/p7-physical-linux-test-plan.md`. Passing it would validate the journal durability **mechanism** of the prototype only. It would not establish production readiness.

## Five things that are not the same

Every document and every output of this harness keeps these apart. None of them stands in for another.

| What | What it is | What it can show |
|---|---|---|
| **Smoke test** (`HARNESS-SMOKE`) | The harness run end to end with container kills or an ordinary restart, on Docker Desktop or on the host | That the harness works. Its cycles are always INCONCLUSIVE and never count |
| **Qualifying durability test** (`POWER-CUT` run) | The 20-cycle series on the dedicated Linux host, on fresh volumes, under a readiness record | Evidence for an independent review of the journal mechanism. **Not authorised yet** |
| **Physical power-cut test** | A real loss of mains power to that host during a qualifying cycle | The only event that tests durability. A rehearsal without a cut, a reboot, or a container kill is not one. **Not authorised yet** |
| **Prototype validation** | What a completed, reviewed series would establish | That this prototype's journal and claim protocol kept acknowledged claims on that machine, drive and configuration |
| **Production implementation** | The real product code, which does not exist yet | Nothing here. Production acceptance needs that code, its review and its own tests |

P7 is **NOT TESTED and NOT PASSED**. Unit tests, stub tests and smoke runs are harness tests, never durability results.

## What it reuses, and what it leaves alone

- **Reused, unchanged:** the Phase 0.5 library in `../m16-phase05/lib/` (`claim`, `appendLocked`, `inspect`, `clear`, the journal and its verifier).
- **Added around it, not in it:** the journal object the harness hands to that library is `lib/failclosed.mjs`, the same journal with a memory for a failed write (see "A failed journal write fails closed").
- **Not modified:** the Phase 0.5 files and results, and the Phase 0 branch.
- **Not part of the build:** nothing under `apps/` or `services/` imports this directory.
- **Its own Compose project:** `compose.yml` is `opsilume-m16-p7`.
  - PostgreSQL is reached **directly**: there is no fault proxy. The Phase 0.5 proxy is still available in `../m16-phase05/` for fault injection.
  - Networks are described under "Network isolation" below.
- **PostgreSQL** runs with `fsync=on`, `full_page_writes=on` and `synchronous_commit=on`. `init` and `run` refuse to start unless `SHOW` confirms all three. `wal_sync_method` is recorded, not set.
- **Synthetic data only.** There are no credentials beyond the throwaway local `proto` database user. Dispatch is a synthetic `dispatch` intent record in the journal: **no request is ever sent to any destination**, and there is no webhook receiver.

## Parts

| File | Runs on | Purpose |
|---|---|---|
| `HOST-PREPARATION-CHECKLIST.md` | The operator | Step by step from the borrowed machine to `READY_FOR_OPERATOR_REVIEW`, with the decisions of 17 November 2026 (B1 to B6). It stops there: **the 20 physical power-cut cycles need the product owner's separate, explicit authorisation** |
| `storage-evidence.template.json` | Filled by the operator | The storage evidence checklist, passed to `create-run --storage-json` |
| `lib/readiness.mjs`, `lib/netcheck.mjs`, `lib/gateway.mjs`, `lib/source.mjs`, `lib/package.mjs`, `lib/lock.mjs`, `lib/pacer.mjs`, `lib/worker.mjs`, `lib/measure.mjs`, `lib/failclosed.mjs` | Both sides | The readiness binding, the network rules, the gateway, the source digest, the source-package reader, the recorder's directory lock, the claim pacing, the worker's claim loop and the throughput report, as pure code with injected clocks and probes so they are tested without Docker |
| `recorder.mjs` | **Another host** (for example the Mac), never on the switched outlet | Authenticates every request; stores each accepted acknowledgement with `fsync` **before** replying; holds the failure model, storage attestation, cut times (its own clock), results, recoveries and the stop marker. Operator commands: `create-run`, `attest`, `abandon`, `cut`, `confirm-cut`, `status`, `measure` (read-only), `verify-dir` (read-only) |
| `gateway.mjs` | The machine under test, `gateway` container | The harness's only way out: forwards TCP to one fixed address, the recorder. It listens on its internal (harness-facing) address only. Port 8788 reports whether the gateway itself can reach a fixed list of destinations it must not reach, and where its own sockets are bound |
| `p7.mjs` | The machine under test, `harness` container | `boot-probe` (entrypoint), `netcheck`, `preflight` (read-only), `init` (once, on empty volumes; never wipes), `adopt` (a run that continues an earlier one), `run`, `check`, `recover` |
| `firewall/` | The machine under test, on the host | `p7-firewall.sh` and its README: the mandatory host firewall. **Prepared, never applied** |
| `host-evidence.sh` | The machine under test, on the host, as root | OS, kernel, virtualisation, mounts, devices, write cache, FUA, SMART, kernel log, PostgreSQL log (read with plain `docker`, by project label, so it needs none of the run's variables). Read-only; it sets nothing on a drive. `P7_PROJECT` names the Compose project (default: the qualifying one). **Not yet exercised on a real Linux machine** (required before qualifying cycles) |
| `lib/` | — | `protocol.mjs` (authentication, acknowledgement streams), `ledger.mjs`, `scan.mjs`, `verdict.mjs`, `sizing.mjs` |
| `test/` | Anywhere with Node 22+ | `node --test prototype/m16-p7/test/*.test.mjs`. **Harness tests**, not durability results |
| `smoke-docker-desktop.sh` | A development machine | End-to-end flow with container kills, labelled `HARNESS-SMOKE`, which **can never count**. Removes nothing: it stops its containers and keeps its volumes. Needs `P7_SMOKE_GENERATION`, which names its own fresh volumes |
| `smoke-containers-down.sh` | Where a smoke ran | Removes the smoke project's stopped containers and its networks, and nothing else. Both smoke volumes are kept and verified. Dry run by default |
| `smoke-teardown.sh` | Where a smoke ran | The **only** thing in the harness that removes a volume. **Disabled by default:** it needs the product owner's separate authorisation, given as a second flag; see "Removing smoke state" |

## The host, and how the harness gets there

Decisions of 17 November 2026; the procedure is `HOST-PREPARATION-CHECKLIST.md`.

- **Host baseline (B5):** Ubuntu 24.04 LTS; kernel 5.5 or newer, with the actual version recorded (the flush probe needs the kernel's flush-request counter); a dedicated local SSD; local ext4 under Docker's data root, so PostgreSQL 16's data and the journal are on ext4-backed storage. Never the container's overlay layer for the journal, never a network filesystem. The physical device behind the mount is recorded. If the host can't meet this, the operator stops and asks for review.
- **Inspection tools (B4):** `smartmontools`, `pciutils`, `hdparm` and `nvme-cli` may be installed, with the machine owner's written permission. `host-evidence.sh` uses them to read only. Nothing here changes firmware, a write-cache setting, a partition or any storage configuration.
- **Transfer and image (B3):** the test machine gets a `git archive` of the exact reviewed commit (tracked files only, so no key, environment file, recorder directory or evidence), the uncommitted operator documents beside it, and a `SHA256SUMS` that is verified on arrival. The branch is not pushed for this. The image `opsilume-isolated-api:latest` is **built on that machine** (`docker build -t opsilume-isolated-api:latest -f apps/api/Dockerfile .` from the package root, the same build the repository's Compose file defines); an image built on the Mac is not used. The source commit, package checksum, image architecture and image id are recorded.

## Recorder protocol (test-only)

- **Key:** `create-run` makes one random 256-bit key per run, in `<recorder-dir>/keys/<run>.key` (mode 0600). The operator copies it to the test machine; the harness mounts it read-only. It is never printed, logged, committed or copied into evidence.
- **Request:** headers `x-p7-run`, `x-p7-ts` (ms), `x-p7-nonce` (random, single use) and `x-p7-mac` = HMAC-SHA256 over `P7-REQ-1`, method, path, run, timestamp, nonce and the body's SHA-256.
- **Refused:** a bad MAC, a run that differs from the path, a timestamp more than 5 minutes off, a nonce already seen (nonces are persisted, so this survives a recorder restart), and a request signed before the running recorder started (`signed_before_this_server_started`: a nonce is persisted only with what a request wrote, so a request the earlier server answered with an error would otherwise be new to the next one).
- **Whose clock.** The test machine signs in the RECORDER's time: its client asks the recorder once (`POST /runs/<run>/time`: signed, read-only, exempt from the time window, nothing written or remembered) and then adds what its own monotonic clock has counted. The test machine's wall clock, wrong after a power cut or corrected by NTP mid-cycle, decides nothing. The recorder's protocol time is its wall clock at start plus its monotonic clock, so setting the recorder's clock while it runs changes nothing either. A request signed by hand with a timestamp outside the window is still refused as stale and counts.
- **Response:** `x-p7-mac` over `P7-RES-1`, the request nonce, status, recorder time and body hash. The harness rejects any response it can't verify, so it can't be fed a forged acknowledgement or cycle view.
- **Cycle identity:** the recorder issues a random cycle id at a cycle's first start. Every acknowledgement, result and recovery must carry it. Only the run's one open cycle accepts acknowledgements.
- **Acknowledgement streams:** one per (process, worker), numbered `n = 1, 2, …`: a claim, then its dispatch intent, with the worker's claims strictly increasing and only its own actions. A duplicate, replay, gap, mismatch, repeated claim sequence or foreign action is refused, logged in `rejections.jsonl`, and makes the cycle INCONCLUSIVE.
- **Scope:** integrity and authenticity only. The data is synthetic, so nothing is encrypted. This is not a production authentication design.

## Network isolation

| Network | Members | Effect |
|---|---|---|
| `p7db` (internal) | `db`, `harness` | PostgreSQL is reachable only from the harness |
| `p7gw` (internal) | `harness`, `gateway` | The harness has no route anywhere else |
| `egress` | `gateway` only | The gateway forwards to `P7_RECORDER_TARGET` and nothing else |

- Nothing is published on the host. There is no webhook receiver.
- `p7.mjs netcheck` probes this from inside the harness, and `init` and `run` refuse to proceed unless it passes. It checks that the recorder answers through the gateway only to authenticated requests, that PostgreSQL is reachable, and that internet addresses and external DNS are not.
- **What Docker alone does not block (verified on Docker Desktop only):**
  - **The test machine's own bridge address answers the harness.** Probes there came back `refused`: the host replied, and only the lack of a listener on those ports stopped the connection. A service listening on all addresses of the host (for example sshd) would be reachable.
  - **The gateway container and the host keep general outbound access.** The gateway runs fixed code that connects only to the recorder, but Docker doesn't confine it.
- **A host firewall on the test machine is therefore mandatory before qualifying cycles** (`firewall/README.md`): drop traffic from the harness networks to the host, and allow the gateway only the recorder's address and port. In a `POWER-CUT` or `VM-CRASH` run `netcheck` is strict and fails while the host still answers on the bridge address. Nothing has verified this on a real Linux machine yet.
- **Strict mode is an allowlist and fails closed** (`lib/netcheck.mjs`):
  - A destination counts as blocked only if the probe timed out or the network said unreachable. `refused` means the packet arrived; any other answer is a failure too.
  - The harness must find exactly its two bridge addresses (`p7db`, `p7gw`) and probe both. None, one, or an unexpected third fails.
  - **The gateway checks its own way out.** Only the gateway has a route, so only it can show that the firewall limits it to the recorder. On port 8788 (internal network only) it probes a fixed list: four internet addresses, two other ports of the recorder host, and its own bridge addresses. It takes no input, so it can't be asked to connect anywhere. Strict mode fails if any of those is reachable, or if the list comes back empty, incomplete or not at all.
  - A smoke run only reports a host that answers and an open gateway; on Docker Desktop both are expected.
  - **Side effect to know about:** each network check makes the gateway attempt those connections. Where no firewall is applied (Docker Desktop, and the real host before the firewall), the attempts to the four public addresses (1.1.1.1, 8.8.8.8, 9.9.9.9, 140.82.112.3) and to the recorder host's other ports really leave the machine: a TCP handshake, no data.
  - **The gateway listens on one address.** At start it picks its interface on the internal network (the one without the default route; `/proc/net/route`) and binds ports 8787 and 8788 there. If it can't identify that interface (not exactly two IPv4 interfaces, or not exactly one default route) it exits rather than listen on every address; the harness then reaches nothing, and nothing runs. The self-check reports the addresses its own sockets are bound to, and strict mode fails unless both ports are on exactly the address the harness reaches the gateway at. No port is published.
- **Tested with fake probes only** (`test/netcheck.test.mjs`). The gateway's self-check, its listener binding and the strict rules have never run in a container or against a real firewall. The binding is new: the first smoke run on any Docker is its first real test (checklist, step 11).

## The rules it enforces

- **Acknowledgements.** A claim is acknowledged only after `claim()` returned `claimed: true`, which is after its transaction's COMMIT returned. Its dispatch intent is acknowledged after that record was `fsync`ed. An uncertain commit, quarantine, error or unreachable recorder stops that worker. An ambiguous claim is **never retried or acknowledged**.
- **Each check, before anything is repaired:** the journal and identity file are copied into the cycle's evidence directory and synced to disk. Then the comparison runs (see `lib/verdict.mjs`).
- **Verdicts** fail closed, and FAIL outranks INCONCLUSIVE.
  - **A journal one claim ahead is not an unconditional pass.** The cycle stays `PENDING_RECOVERY` until the recorder holds: an observed quarantine (a claim was refused), the operator's inspection digest, and a completed clearance.
  - **A complete final line with an invalid hash is a FAIL.** Only a line with no newline is a torn tail (N1). Nothing else is ever repaired.
  - **INCONCLUSIVE when:** flush or FUA behaviour is unverified; a durability setting is off; no cut recorded or not confirmed; no reboot observed after the cut (qualifying runs); a worker stopped or went silent before the cut; the recorder rejected an authenticated message; no acknowledgements; a `HARNESS-SMOKE` run.
- **The qualifying series** is 20 cycles with final status PASS, from cycle 1, in one `POWER-CUT` run.
  - A FAIL stops the run. So does an INCONCLUSIVE cycle in a `POWER-CUT` or `VM-CRASH` run: investigate, resolve, and start a **new run at cycle 1**.
  - `create-run` refuses a qualifying run whose flush or FUA behaviour is not attested as verified, with every item of the storage evidence checklist filled (see "Storage evidence checklist").
  - `VM-CRASH` runs are supplementary and never count.
- **Continuing state.** The database and journal carry over across cycles; nothing is reset. Every cycle ends with `recover`, which the recorder requires before the next start.
- **After an INCONCLUSIVE cycle** the run is stopped, but the state is kept:
  1. `recover` that cycle. This is still allowed, and quarantine and clearance are not skipped.
  2. Investigate and resolve the cause.
  3. On the recorder: `create-run --run <new> --failure-model <same type> --continues <old>` (a new key and a new record; the old run's record is never changed). A `POWER-CUT` run needs `--storage-json` and the four identity values and the package again, and the three operator attestations again.
  4. On the test machine: set `P7_RUN` and `P7_KEY_FILE_HOST` to the new run, `docker compose up -d` (only the harness container is recreated; the volumes are untouched), then `p7.mjs adopt`.
  - `adopt` changes nothing. It refuses unless the journal verifies in full, the state is trusted, and it is exactly the state the recorder holds from the old run's last recovery.
  - The new run's count starts at zero, at its own cycle 1. Claims an earlier clearance accepted as never committed carry over, so every history comparison still covers the whole journal.
  - A run that **failed**, or whose recovery failed, can never be continued. Nor can a run that isn't stopped. `init` refuses a non-empty database, and nothing in the harness wipes volumes.
  - No run starts a cycle on volumes it neither initialised nor adopted: the recorder refuses the first start otherwise.
- **Workload sizing.** `run` needs `--max-seconds` (the longest planned time to the cut) and a claim rate: `--rate` (with a burst pattern: the maximum burst rate), or `--target-rate` (a constant throttle), or (smoke and supplementary runs only) the rate measured in the previous cycle. A `POWER-CUT` cycle always runs the workload of its readiness record. The pool per worker is `rate x max-seconds x headroom`, with headroom at least 2. A smaller `--pool` is refused before anything is seeded or started. `--workers` (1 to 12) and a second process (`--proc b`) set the burst size. **Decision B1: the qualifying series uses one process, one worker and one burst pattern for all 20 cycles,** and the recorder enforces it: a readiness record is accepted only with `procs` 1, `workers` 1 and a burst pattern, and every start must report exactly the recorded workload, field by field. If the measured rate and the cut window don't fit the clearance envelope, the operator stops and reports rather than changing the workload.
  - **Burst pattern** (`--burst-period P --burst-seconds B --quiet-rate Q`, all three or none), with `--rate R` as the **maximum burst rate**: counted from the moment claiming starts, each period of P seconds begins with B seconds in which claims start at no more than R per second, and continues at no more than Q per second. The same pattern in every cycle. It can't be combined with `--target-rate`. A smoke run may use the same flags, to rehearse the pattern.
  - **Both rates are limits that execution enforces** (`lib/pacer.mjs`), not targets: after a claim starts, the next may start only once the allowed rate, integrated over the time between, reaches one claim. A slower machine simply claims less. A worker that falls behind never catches up, in the burst or after it.
  - **The pool is a genuine upper bound.** At most `R x burst seconds + Q x quiet seconds + 1` claims can start within `--max-seconds`; the pool is that allowance times the headroom (at least 2), so a paced worker cannot exhaust it before the planned time. Sizing and execution use the same four numbers, and the recorder binds all of them.
  - **Without a pattern and without `--target-rate` a worker is not paced at all** (it claims as fast as the machine allows, and `--rate` only sizes the pool). That mode is for measuring a machine in a smoke run. A qualifying run can't use it: its readiness record needs a burst pattern.
  - **Enforced at every start, not only when the record is accepted:** one process, one worker, a burst pattern whose quiet rate is at least 0.2 claims per second. (Quiet claims are `1 / quiet rate` seconds apart, and the recorder counts a worker that was silent for 10 s before the cut as stopped, which makes the cycle INCONCLUSIVE. The silent-stop rule alone gives 0.1; the floor is twice that, so the gap is at most half the window. Accepted by the product owner on 18 November 2026 as an **eligibility floor, not a workload selection**: the burst and quiet rates remain undecided until the one-worker measurement. It is enforced in two places: where the workload is sized (`lib/sizing.mjs`, so `preflight` is BLOCKED and `run` refuses before anything is seeded, for a smoke run with a burst pattern as well, since the silent-stop rule applies to every run type), and by the recorder, at the readiness record and at every start.) A record that says otherwise starts nothing, and the sizing the recorder keeps for a qualifying start (which limits the cut's timing) is the bound workload, whatever the request says.
  - **What a burst is here:** a rate burst by the one worker. Several workers appending at once are exercised by the unit tests and the Docker smoke only, not under power loss.
  - `recorder.mjs cut` refuses a delay that could run past the time the pools were sized for.
  - **Clearance envelope:** clearance was validated up to 1,000,000 affected actions (Phase 0.5), and every waiting APPROVED action is affected. `run` refuses to seed past that; use `--target-rate`, fewer workers or a shorter `--max-seconds`.
  - **Retiring unclaimed actions (approved housekeeping):** at the end of `recover`, the cycle's synthetic actions that were never claimed (`attempts = 0`, still APPROVED) become PROPOSED. It runs in one transaction that proves every other action of the cycle and every audit row is unchanged, checks the journal file is byte-identical, and confirms a second pass finds nothing. If it fails it rolls back, nothing is reported to the recorder, and the cycle stays not-recovered until `recover` is run again.
- **`check` can be retried** without overwriting anything: a saved result is re-sent as it is, and a new attempt gets its own directory.
- **Power-cut timing.** `confirm-cut` records the operator's attested time or interval (`--attested-from`, `--attested-to`). It is labelled an attestation everywhere; `independentlyConfirmed` is always false.
- **Evidence** is write-once. Each cycle records: run and cycle ids, failure model, cut-request time, the bounds on the cut (last durable acknowledgement, first contact afterwards), last journal and database sequence, boot time, when PostgreSQL started and became reachable, verification and recovery times, quarantine and clearance results, and the verdict with reasons. The cut itself is **not independently observed**; the operator's confirmation is recorded as an attestation.

## Measuring what a cycle really did

`node recorder.mjs measure --dir <recorder-dir> --run <run> --cycle <n>` (recorder host, read-only) prints one report from the cycle's acknowledgement ledger:

- **`measured`:** acknowledged claims in total; claims in each 10-second window; the rate in the burst parts and in the quiet parts; the most claims in any one second; the average rate; how many processes and workers actually acknowledged; when the first claim was stored and how long the measurement spans.
- **`configured`:** what the cycle's start declared: processes, workers, the maximum burst rate, the quiet rate, the pattern, the sizing figures. Named as declarations; never mixed into the measured figures.
- **`withinConfiguredLimits`:** whether any window holds more claims than the configured limits allow (with a small allowance, because the recorder sees acknowledgements, slightly after the claims started). `null` for an unpaced cycle.

The same ledger always gives the same report. To measure a machine's own one-worker rate, run one unpaced smoke cycle (`run --workers 1 --rate <guess> --max-seconds <s>`, no pattern, no throttle) and read `measured.averageClaimsPerSecond`. To check a pattern, run a smoke cycle with the burst flags and read the windows. Neither has been done on any machine yet.

## The recorder directory

Everything the recorder knows is in one directory: every run's record and acknowledgements, the keys, the volume registry and the recorder's identity. **Use one recorder directory for the whole physical experiment**, from the smoke rehearsal to the last qualifying cycle.

Procedure (recorder host):

1. **Create it once, on purpose.** `recorder.mjs serve --new-directory ...` and the first `create-run --new-directory ...`. Without that flag every command refuses a missing or empty directory, so a wrong path or an unmounted disk can't silently start a recorder with no history.
2. **Back it up before testing, to independent storage** (another disk or machine, not the same filesystem): after the smoke rehearsal and before the first qualifying `create-run`. For example `cp -a <recorder-dir> <backup>` or `rsync -a`. The directory contains the run keys (`keys/`, mode 0600): keep the backup on local media under the same care, with permissions preserved, and never in a shared or synced folder.
3. **Verify the backup before the first qualifying run:** `node recorder.mjs verify-dir --dir <recorder-dir> --backup <backup>` must exit 0. It compares every file byte for byte and also checks the identity, the registry and that every run has its key. It prints no key. It refuses a backup that is the live directory itself or inside it, or whose files are hard links to the live files, and reports `sameFilesystem`: `true` means the copy is not on another disk, which is the operator's to correct. `false` is not proof of another physical disk (two partitions of one drive also report it): where the copy is kept is the operator's statement.
4. **During the series,** take further backups whenever you like and check that history was only added to: `verify-dir --dir <recorder-dir> --backup <backup> --allow-growth` accepts new files and longer ledgers, and reports any earlier record that changed or disappeared.
5. **Stop if** `verify-dir` exits 1, if a command says the directory is missing or empty, or if any command answers `volume_registry_inconsistent`, `recorder_identity_missing` or `readiness_stale: recorder...`. Do not start a cycle, do not create a new directory, and **do not copy the backup over the live directory**: preserve both as they are and report. The harness never resets, rebuilds or recreates the registry or the identity.

Limits, stated plainly:

- **A new, empty recorder directory has no history.** The registry and the readiness records protect a series only inside the directory that holds them. That is why the directory is never created implicitly and why the procedure above exists.
- **Removing a run's own record together with its registry line is not detected by the recorder.** Only the verified backup shows it (`verify-dir --backup ... --allow-growth` reports the missing files and the changed registry).
- **Leftovers are not a new directory.** A directory with a registry or keys but no runs and no identity is `damaged`: every command refuses it, with or without `--new-directory`.
- A directory that holds runs but no identity (one that predates the identity, such as the development smoke directory, or one whose `recorder-id.json` was removed) is never given a new identity. Smoke runs still work there; no qualifying run can be created or made ready in it.

## Source and image identity

What a qualifying cycle runs is part of its readiness record.

| Value | How it is established | Status |
|---|---|---|
| Harness source on the test machine | Each host computes one digest over the files the harness executes (`lib/source.mjs`). The test machine reports its own at preflight and at every start | **Verified by the recorder** against the digest it pinned in the run's record at `create-run` (the one the package was checked against), at the readiness record and at every start (`source_differs_from_the_recorder`). The recorder's own copy must still be that source too (`recorder_source_changed_since_create_run`), so the two hosts cannot both move to other code. The report itself comes from the test machine |
| Source package SHA-256 | Declared at `create-run --package-sha256`; the recorder reads the package file (`--package`) | **Verified by the recorder:** it computes the file's SHA-256 itself |
| Source commit | Declared at `create-run --source-commit`; `git archive` embeds the commit id in the package | **Verified by the recorder against the package:** the embedded id must be the declared one. Not verified against a repository: an archive can be hand-made with any id in it |
| Package contents | Read from the package without extracting it (`lib/package.mjs`) | **Verified by the recorder, for the harness files only:** the harness source in the package must be, file for file, the source on the recorder host's disk. Every other file in the package is covered by the package checksum alone |
| Image architecture | The harness container reports its own (`process.arch`); declared at `create-run --image-arch` | **Checked by the recorder** against the test machine's report (`image_architecture_differs_from_declared`) |
| Runtime fingerprint | The harness container hashes its own Node binary, installed-dependency lock and API manifest | **Reported by the test machine and bound:** a change after the record refuses the start. It is what a container can say about its own image; it is not the image id |
| Harness image id | Declared at `create-run --image-id` | **Declared by the operator and bound, not verified.** Nothing inside a container can read the id of the image it was started from, and the harness has no access to the Docker daemon (by design). `host-evidence.sh` records the image id of every container (`container-images.txt`) on the host; the operator compares it with the declared id at the baseline and after every boot |
| PostgreSQL image | `server_version` is read by the harness and bound; the image id is in the host evidence | **Documented only,** apart from the version |

- A `POWER-CUT` run can't be created without all four declared values, well formed, and the source package file that backs the first two.
- **The runtime fingerprint is weaker than it looks:** a file the container can't read is recorded as unreadable, which still gives a stable value. Only the Node binary's path is certain; the other two paths have never been checked inside the image.
- **Trust limit, stated exactly:** everything the test machine reports is self-reported over the authenticated channel; and a different image with the same architecture, the same Node binary and the same installed dependencies, running the same mounted source, is not told apart from the declared one by anything in the harness. The source package directory and both images must therefore stay unchanged for the whole series: no rebuild, pull, retag or edit, and both are preserved until the independent review.
- The PostgreSQL image is covered only through `server_version` (bound) and the host evidence.
- **What the package check does not show:**
  - **That the image was built from the package.** Nothing ties the two together. The files the image is built from (`apps/api`, the lock file) are in the package, but they are not compared with anything; the image id is the operator's declaration.
  - **That the commit id is real.** It is read from the archive's own header. If an archive carries more than one such header, the last one is used.
  - **What the recorder process is running.** The recorder compares the files on its disk, not the code already loaded into the running `serve` process. Start `serve` from the reviewed checkout, and restart it after any change to those files, before `create-run`.
  - **Files outside the listed directories.** The source digest covers the harness directory, `lib/`, `firewall/` and the Phase 0.5 `lib/`, each without subdirectories, and nothing else: not Node itself, and not the tests.

## One lock for the recorder directory

The server and the operator commands are different processes writing the same ledgers. Everything that reads a ledger, decides and writes takes one lock on the directory (`.recorder.lock`): the server's handlers for cycle starts, readiness records, events, results and recoveries, and the commands `create-run`, `attest`, `abandon`, `cut` (its scheduling step) and `confirm-cut`. A cycle start is therefore decided on a snapshot nothing else can change before the start is written: an attestation or an abandonment lands either before it (and the start sees it) or after it.

- Acknowledgements stay outside the lock: they only append to their own stream.
- **A cycle is cut at most once.** `cut` records its schedule under the lock, and refuses while another `cut` for the same cycle is still waiting for its moment. When its own wait is over it takes the lock again and checks again: if the cycle was checked or the run stopped meanwhile, nothing is cut. A schedule whose process is gone never sent anything and is void.
- **A ledger that ends in an incomplete line is never appended to.** The fragment is reported by readers and left as it is; the command or request that would have appended fails. That is a stop: nothing edits a ledger.
- **A result that stops a run stops it even without its stop marker.** The two are separate writes; a start checks the stored results as well.
- **Durability of the recorder's own files** rests on `fsync` of each line and, for a new file, of its directory. On macOS `fsync` does not force the drive's cache to disk; the recorder host is not the machine whose power is cut, and it must not lose power during a cycle.
- **One server per directory.** `serve` refuses to start while another `serve` process is running on the same directory: two servers would each keep their own record of used nonces and acknowledgement streams.
- **A busy answer during a cycle start is repeated; nothing else is.** `p7.mjs run` asks the recorder twice: once before it seeds the cycle's actions and once after. A `recorder_busy` answer to the second request is authenticated and is given before the recorder reads or writes anything, so the harness sends that request again (up to six times, two seconds apart; `lib/worker.mjs`, `whileBusy`). A timeout, a lost connection or any other answer is never repeated. If the recorder stays busy, the actions are seeded without a started cycle and that cycle can't be started again: that is a stop. Avoid operator commands in the seconds a cycle is being started.
- **`recorder_busy`** (HTTP 503 from the server, exit 1 from a command) means the lock was held for longer than the wait (8 seconds in the server, 10 for a command). While the server waits it serves nothing else, acknowledgements included, so a command that hangs with the lock can stop a worker (`ack_failed`); commands hold the lock for milliseconds. Nothing was written; repeat the command.
- A lock whose owner process no longer exists is taken over. One whose owner is running, or can't be read, never is. "Exists" means on this host: **the recorder directory must be on a local disk of the one host that uses it,** never on a share that another host also mounts. If commands keep answering busy while nothing is running, stop and report rather than removing the file.

## Run types never share state

| Run type | Starts on | May continue | Counts toward P7 |
|---|---|---|---|
| `POWER-CUT` | **Fresh, dedicated volumes only** (`init`) | Only a `POWER-CUT` run of the same series, after an INCONCLUSIVE cycle | Yes: 20 consecutive passes in one run |
| `VM-CRASH` (supplementary) | Fresh volumes (`init`) | Only `VM-CRASH` | Never |
| `HARNESS-SMOKE` | Fresh volumes (`init`) | Only `HARNESS-SMOKE` | Never |

How "fresh and dedicated" is enforced:
- **`init` claims the volumes first.** Before creating anything it sends the recorder the database cluster's system identifier (unique per `initdb`) and the empty-state facts. For a qualifying run the recorder refuses unless the database has no relations, the journal volume has no entries, and the cluster's WAL position is that of a new cluster.
- **The recorder keeps a registry of every cluster any run was initialised on.** A cluster already registered is refused, for any run type, even if its contents were removed by hand.
- **Every cycle start, and `adopt`, must name the cluster the series started on.** A marker in the journal volume ties it to that cluster, so the two volumes can't be mixed.
- **`create-run --continues` refuses a different run type,** so a qualifying run never adopts smoke or supplementary state.
- **Evidence:** `evidence/<run>/init/initial-empty-state-*.json` on the test machine, and `volumes.jsonl` on the recorder. Smoke evidence stays in its own run directories.
- **Order on the real host:** smoke rehearsal first, under its own project and labelled disposable (`docker compose -p opsilume-m16-p7-smoke -f compose.yml -f compose.smoke.yml ...` for every Compose command of the rehearsal, with `P7_SMOKE_GENERATION` set); then stop it and remove its containers and networks (`./smoke-containers-down.sh`, which frees the bridge names and keeps its volumes); then the qualifying run under the project `opsilume-m16-p7`, whose volumes are different ones and new. No volume has to be removed for the qualifying run to start on fresh volumes.
- **Never run `docker compose down -v`, `docker volume rm`, `docker volume prune` or `docker system prune` on the test machine.** In the directory of `compose.yml`, a bare `down -v` removes the volumes of `opsilume-m16-p7`: the qualifying run's database and journal.
- **Never answer yes if Compose offers to recreate a volume, and never pass `-y`/`--yes` to `docker compose up`.** Compose makes that offer when a volume's definition differs from the file, and recreating deletes the data. The volume definitions in `compose.yml` are fixed for that reason; `compose.smoke.yml` is for the smoke project only.
- **The recorder never reads a damaged registry as "no history".** Every run that claimed volumes must still be in `volumes.jsonl` with the cluster its own ledger recorded. If the file was deleted, truncated, replaced or edited, every claim, start, adopt, volume check and `create-run` is refused (`volume_registry_inconsistent`) until the original file is restored; the recorder never rebuilds it.
- **Limits:** the registry knows only runs recorded in the same recorder directory, and removing a run's own record together with its registry line isn't detected (see "The recorder directory" for the procedure that covers both); beyond that, "fresh" means an empty database on a new cluster and an empty journal volume. The journal volume has no identity of its own before `init`. An `init` that fails after the claim uses up both the run id and those volumes: start again with a new run id on new volumes.
- **A start is vetted before anything is seeded,** so a refused start leaves the database untouched and can be retried.

## A failed `init` fails closed

Decision B6: **fail-stop.** `init` is the point after which a qualifying run's volumes are used up, so a failure there is never repaired in place.

| What happened | State | What may follow |
|---|---|---|
| `init refused: ...` before the claim; the run's ledger holds no `volume_claimed` | Nothing was created or claimed | The run is abandoned (its id is spent). After the product owner's review, a **new** run id may be created; the recorder lets it claim the volumes only if they are demonstrably empty (no relations, no journal entries, a new cluster) |
| `init` failed after the claim | The volumes belong to that run for good | The run is abandoned. **All state is preserved and the qualifying session stops.** A new qualifying attempt needs investigation and separate authorisation |
| The outcome is uncertain | Treated as claimed | The same |

- **Enforced with no action from anyone:** `init` claims the volumes with the recorder before it creates anything. Once claimed, the same run can't claim again (`already_claimed`), no other run can use that cluster (`volume_already_used_by_<run>`, even if it looks empty), and a run without a completed `init` can't start a cycle (`not_initialised`). `init` itself refuses a database or state directory that isn't empty.
- **`node recorder.mjs abandon --dir <recorder-dir> --run <run> --reason "..."`** closes the failed run. It writes the stop marker and one note in that run's record, in that order, and nothing else: no volume, journal, registry line or evidence file is touched, and no Docker command is run. Afterwards the run can't claim, initialise, adopt, be made ready, start a cycle or be continued, and its id can never be created again. It is only for a run that hasn't started a cycle.
- **Never:** automatic cleanup; a reset; deleting, recreating or reusing a volume; running `init` again after a failure; reusing the run id; another Compose project name to get around the claimed volumes.
- Tested with the recorder's unit tests only (`test/recorder.test.mjs`, "abandon" and "B6"): they show the state transitions, that the recorder's registry and the run's other records are byte for byte as they were, and that no Docker command is run (a stub `docker` on the path would record one). `abandon` is given nothing but the recorder's own directory, so it has no way to reach the journal, the volume marker or the evidence on the test machine; the test's comparison of those is therefore not a real check of anything. No `init` has failed against a real stack. Procedure: `HOST-PREPARATION-CHECKLIST.md`, step 15.

## A failed journal write fails closed

Product-owner decisions of 18 November 2026: **a failed journal `fsync` must fail closed,** and the wrapper below is accepted for the prototype: any journal write failure, a dispatch record's included, prevents every later journal operation; the Phase 0.5 journal stays unchanged and the wrapper stays separate; the failure marker is never removed automatically.

- **What the reused journal does by itself:** a failed write or `fsync` throws, the claim's transaction rolls back and the worker stops. It does **not** remember the failure. The next append, by another worker or a later command, would land on top of a record nobody confirmed, and on Linux a later successful `fsync` does not prove that earlier data reached the disk.
- **What the harness adds (`lib/failclosed.mjs`, a wrapper; the Phase 0.5 files are not edited):** the failure is remembered in the process that saw it, for every journal object it has on that directory (`p7.mjs` builds one per worker), and in a marker file beside the journal, `journal-write-failed.json` (what was being written, the error code, the time). The marker is how another process, or the same command started again, learns of it. While it is remembered:
  - every append is refused (`JOURNAL_WRITE_FAILED_EARLIER`): claim, void, dispatch intent, clearance record and the torn-tail repair record;
  - the journal is reported as not trusted, so `claim` answers `quarantined`, `preflight` is BLOCKED, `run` and `adopt` refuse, and `recover` stops the run before it probes, repairs or clears anything.
- **Nothing removes the marker.** No code in the harness deletes, rewrites, renames or expires it, and there is no repair, no retry and no override. (The one thing that could take it away is deleting the journal volume itself; the only script that deletes a volume is `smoke-teardown.sh`, for smoke volumes, and it is disabled.) The series cannot continue on those volumes; stop, preserve everything and report. `check` still preserves the journal exactly as found, and the marker with it (`journal-write-failed-as-found.json`), and its result carries `journalWriteFailure`.
- **Any journal write failure counts:** a failed sync, a write call that fails, and a short write, including one that wrote nothing and so leaves no trace in the journal itself. **The only refusals that set no marker** are the three the journal makes before it writes a byte: the file is missing, is corrupt, or ends in a torn line that an earlier crash left. Nothing was written there, so no write failed; a torn line left by a power cut is still repaired by `recover`, as the design says.
- **Limits, stated exactly:**
  - **There is no unconditional guarantee across processes.** The marker is written to the very volume whose write just failed, so it may not be writable either. **If the marker cannot be written, a restarted process does not know about the failure and will append.** Only the process that saw the failure refuses, for as long as it lives. A test pins exactly this behaviour.
  - **A marker whose own write or sync failed** may be incomplete (it then still counts as a failure for whoever finds it). It is in the file system's cache, where other processes of the same boot see it, but it may be gone after a reboot or a power cut. After a reboot the harness then has only what is on the disk, which every command verifies in full; it no longer knows that a write had failed.
  - Which case applies is said where it can be known. The worker that saw the failure reports it to the recorder as an event of its own, `journal_write_failed`, with what became of the marker (`written`, `found`, `written, but not confirmed on disk`, or `NOT written`). `check` runs in a new process after the reboot, so in its result `journalWriteFailure.marker` can only read `found`, or the field is null when the marker is gone. (An earlier version of this sentence said the check result shows all four; it cannot.)
  - A marker that exists but is empty, torn or unreadable counts as a failure, never as none.
  - Any error from an append other than those three refusals sets the marker for good, including an error opening or reading the file before a byte was written. That is deliberate: the harness cannot tell those apart safely.
  - This is the harness's addition, **not part of the Phase 0.5 design**, which says a failed write throws and nothing commits. It is stricter than the design in one respect: the design lets a failed `dispatch` line leave trust unaffected; here any failed journal write stops everything. Whether the production implementation should do the same is a design decision that has not been taken.
  - The recorder's own ledgers are not covered: a failed acknowledgement write marks that cycle's file damaged, but a failed write to another recorder ledger is only answered with an error.
- Tested with unit tests on a file system that fails on demand (`test/failclosed.test.mjs`). The wiring in `p7.mjs` has never run: it only loads inside the image.

## After a journal write failure: what `check`, `recover` and the recorder do

Added after the post-commit review of commit `462f5d4` (`docs/m16-p7-post-commit-review.md`, finding F4).

- **A known journal write failure is never a PASS.** `check` makes the cycle INCONCLUSIVE with the reason `JOURNAL_WRITE_FAILED` when the marker is beside the journal, or when a worker reported a failure to the recorder during the cycle. A failed comparison stays FAIL.
- **The worker's report (`journal_write_failed`) counts whether it arrived before or after the cut was requested,** unlike an ordinary worker stop. The recorder accepts it only while the cycle is open (started, not yet checked); a report for a cycle already checked is refused.
- **The recorder decides with the check, not after it.** For a cycle with such a report it refuses a PASS (`pass_contradicts_a_recorded_journal_write_failure`) and refuses the recovery (`journal_write_failed_in_this_cycle`). It also refuses a PASS whose own result carries the marker or the reports (`pass_reports_a_journal_write_failure`).
- **`recover` stops the run** before it probes, repairs or clears anything, for a failure known from any of four places: the marker as it is now, a worker's report held by the recorder, or the marker or a report as `check` recorded them with its result (the marker may be gone by the time `recover` runs). The recorder refuses the recovery for the three of those it can know (it cannot see the marker on the test machine; that case reaches it as `recover`'s stop). The rule is `lib/recovery.mjs`. A journal write that fails inside the clearance itself also stops the run on the recorder, and the worker's report is repeated while the recorder only answers "busy".
- **What is still not covered:** a failure whose marker is lost **and** whose report never reached the recorder is known to nobody. That is the stated limit of the wrapper, unchanged.
- The rule and the recorder's refusals are unit-tested (`test/harness.test.mjs`, `test/journal-failure-verdict.test.mjs`). `p7.mjs check` itself has never run.

## A torn final line the verifier cannot accept a repair for: INCONCLUSIVE, never repaired

Post-commit review, finding F3. **Product-owner decision of 18 November 2026: the Phase 0.5 verifier stays unchanged, and this mitigation is accepted for the time being.**

- **The limitation:** the reused verifier measures an ignored line by the length of its decoded text, and the repair record names the raw byte count. For a fragment that is not valid UTF-8 (the review's example: the bytes `7b 22 ff fe 80 41`) the two differ, and the verifier refuses the repair record. Before the fix, `recover`'s own write therefore turned a repairable torn tail into a `corrupt` journal.
- **What the harness does:**
  - **`check`** asks, read-only, whether a repair would be verified (`lib/scan.mjs`, `repairCheck`). If it would not, the cycle is **INCONCLUSIVE** with the reason `TORN_TAIL_NOT_REPAIRABLE`, not a provisional PASS. A failed comparison stays FAIL. The result carries `tornTailRepairProblem`. If the question could not be answered at all (the fragment could not be read), `check` saves no result (the attempt's directory keeps the journal as found) and can be run again. A fragment longer than 64 MiB is not examined and is treated as one the verifier would not accept.
  - **The test is the verifier's own measure, not "valid UTF-8".** Most invalid UTF-8 fails it. A few invalid sequences decode to the same length (a four-byte character cut after three bytes, for example); those are repairable, are repaired, and behave like any other torn tail.
  - **`recover`** stops before it probes, repairs, clears or retires anything, on what `check` recorded. It writes `recovery-not-possible-*.json` in the cycle's evidence and exits 8. (If `check` found the tail repairable and it is not so when `recover` reaches it, the journal is not as it was found: that stops the run.) **No repair record is written.** The journal stays byte for byte as found, with its invalid bytes: nothing is replaced, normalised or truncated, and it is still a torn tail, not corrupt.
  - **The recorder** stores no PASS for such a result (`pass_reports_a_torn_tail_that_cannot_be_repaired`) and accepts no recovery for the cycle (`torn_tail_cannot_be_repaired`). Its final status is INCONCLUSIVE and stays so.
- **A torn tail that is valid UTF-8 is handled as before:** provisional PASS, repaired by `recover`, PASS once the recovery is recorded. ASCII fragments, blocks of zero bytes and valid multi-byte text are covered by tests.
- **What follows from INCONCLUSIVE:** in a qualifying run it ends the series, and because the cycle cannot be recovered, no run can continue that database and journal. **Physical power-cut testing cannot proceed through this condition.** A power cut can leave such a tail; if one does, the series stops there, safely and without a wrong result, and can only be taken further after the verifier's length rule has been resolved in a separately approved change.
- Unit-tested at library level and on the recorder (`test/repair-utf8.test.mjs`, `test/harness.test.mjs`, `test/journal-failure-verdict.test.mjs`). The wiring in `p7.mjs check` and `recover` has never run.

## The recorder never dies on a request, and never loses a refusal silently

Post-commit review, findings F1 and F2.

- **A request target that is not a URL** (for example `GET http://[`) is answered `400 bad request target`. Nothing is read or written for it: no ledger, and no rejection line. (An unknown path or an unknown run is still logged as a rejection, one line, as before, until that log is larger than 16 MiB: from then on unauthenticated requests are still refused but no longer written to it, and the server says so on stderr for the first one and every hundredth. Authenticated refusals are always written.)
- **A rejection that cannot be written to its log** (the log ends in a fragment, the disk is full, the file is not writable) no longer ends the server. The request is refused all the same:
  - **Unauthenticated** (unsigned, bad MAC, unknown path or run): answered exactly as before, so the network check's unsigned probe still gets its 401. Nothing about it is recorded anywhere; the server counts it and prints a line on stderr for the first one and every hundredth.
  - **Authenticated:** answered `500 refusal_not_recorded`, with `refused` (what was refused) and `fallback`. (A request with a stale timestamp gets the same status without the signed body, as stale requests always did.) The refusal is kept as an event in the run's ledger (`refusal_not_recorded`, `fallback: "event"`), where it still counts against its cycle as a reason for INCONCLUSIVE and still blocks a replay. It is appended under the directory lock when the lock can be had, and without it otherwise.
  - **No such event for a replayed or stale request** (`fallback: "none"`): anyone who captured a signed request can send those, and they must not be able to write to the run's event ledger.
  - **With `fallback: "none"`,** or if the event ledger cannot be written either, this server accepts no further acknowledgement and no PASS for the open cycle. If it cannot even tell which cycle is open (the event ledger cannot be read at that moment), it stores no PASS for any cycle of the run for as long as it runs.
  - **The same holds for an authenticated request that fails outside a refusal** (the ledger it had to write or read failed, or the run's directory could not be found for a moment): it is answered with an error, and this server stores no PASS for the open cycle, or for the run, afterwards. That flag is in memory only and does not survive a restart of the recorder. **The restart itself is what a later server goes by:** a server that takes over a cycle that is open records that (`recorder_restarted`, see the next section) and stores no PASS for the cycle, whether or not anything was lost. Further, a run ledger that ends in a fragment is itself reported as damage in every cycle view (`damage.runLedgers`), before and after a restart.
  - It is never answered as an ordinary refusal, and never reported as recorded.
- **Nothing repairs a damaged ledger.** A final line without its newline is left byte for byte; readers skip it and writers refuse to append after it.
- **It is made visible:** `verify-dir` lists every ledger that ends in an incomplete line, or cannot be read, as a problem (exit 1). A cycle start is refused while a ledger the cycle depends on is in that state: the run's events, rejections or accepted claims, or the volume registry (`recorder_ledger_ends_in_a_fragment: <file>` or `recorder_ledger_cannot_be_read: <file>`; when the damaged file is the run's own rejection log, that text arrives inside a `refusal_not_recorded` answer). Another cycle's acknowledgement file and the recorder-wide rejection log stop no cycle; `verify-dir` reports them all the same.
- **An error no handler foresaw** is answered 500 and named on stderr (its name and code only); it does not end the server. A handler that fails part-way may already have written something; it is never answered as accepted.
- Unit-tested with a real server in a process of its own (`test/recorder-availability.test.mjs`).

## A damaged cycle is INCONCLUSIVE, and a refused result never blocks the cycle

Second safety review, finding A (a cycle that could never be closed).

- **The recorder says what is damaged.** The cycle view it serves carries `damaged` and `damage`, with three reasons that may each be null, and a fourth that is present only when it applies:
  - `runLedgers`: one of the run's own ledgers (events, rejections, accepted claims) ends in a fragment or cannot be read, so refusals or events of the cycle may be missing. Read from the files, so a restarted recorder reports it too.
  - `acknowledgementLedger`: the cycle's acknowledgement file ends in a fragment, holds a line that does not follow its stream, or cannot be read. Any process that reads the file sees this.
  - `recorderMemory`: what only the running server knows: an acknowledgement it could not store, an authenticated refusal it could record nowhere, or its own takeover of the cycle when it could not record that. **It does not survive a restart of the recorder,** and a view computed by another process (the `cut` command, a test) does not have it.
  - `recorderRestarted`: a recorder process took the cycle over while it was open (the recorder was restarted, or crashed and was started again). Whatever the earlier process held only in memory is lost, and nothing can show afterwards that there was nothing. So the cycle is damaged: **a recorder restart during an open cycle makes that cycle INCONCLUSIVE**, and in a qualifying run that ends the series.
    - Each server that takes the cycle over appends one event, `recorder_restarted`, to the run's ledger when it first serves the run. The test machine cannot send that event.
    - If the event cannot be written, that server still stores no PASS for the cycle and reports it as `recorderMemory`; the next server writes its own event. Every process that could store a PASS for the cycle either started the cycle itself or knows it took it over.
    - Acknowledgements are not affected: every stream continues where its ledger ends, so the cycle's evidence stays complete.
    - A restart while no cycle is open records nothing and affects no cycle.
    - **Do not restart `serve` between a cycle's start and its `check`.** If it happens, run `check` (INCONCLUSIVE), `recover`, and continue with a new run as for any inconclusive cycle.
  Only reasons are reported: no key, no MAC, no request content. A reason may carry an operating-system error code.
- **`check` decides before it saves anything.** Any damage makes the cycle INCONCLUSIVE with the reason `RECORDER_CYCLE_RECORDS_DAMAGED`; a failed comparison stays FAIL. The recorder stores no PASS for a damaged cycle (`pass_for_a_cycle_the_recorder_marked_damaged`), so the two agree, and the cycle's final status is INCONCLUSIVE whether or not it is recovered. `recover` works from the result the recorder accepted, as for any inconclusive cycle; while one of the run's ledgers is damaged it is refused before it changes anything, because the recorder could not record it.
- **A result the recorder refuses is evidence, not a dead end** (`lib/attempts.mjs`):
  - It is marked beside itself (`result-refused-<time>.json`: who refused, the status and the reason), kept byte for byte, and never sent again. `check` exits 9.
  - The next run of `check` makes a **fresh attempt in a directory of its own** (`cycle-NNNN-attempt-<time>`), reads the cycle view again and decides again. Nothing is overwritten or deleted.
  - Every result carries its attempt's identity (`attempt.dir`, a random `attempt.id`, the earlier attempts, and which of them were refused), so one attempt cannot be taken for another.
  - A refused result was never accepted: the recorder stored nothing for it. Only the recorder's stored result counts, for `recover` and for the series. (If the answer is "not open" because this very result did arrive earlier, `check` recognises it by its attempt id and does not mark it.)
  - **A saved PASS is checked against the cycle view before it is sent again.** If the view now shows damage, an authenticated refusal or a reported journal write failure, `check` does not send it: it marks it (`refusedBy: "check"`), keeps it, and the next run decides afresh. A result file that cannot be read is a dead attempt, neither sent nor reused.
  - **The recorder refuses it as well** (`pass_for_a_cycle_with_authenticated_rejections`): it stores no PASS for a cycle in which it refused an authenticated request while the cycle was open. INCONCLUSIVE is accepted and closes the cycle.
    - **Which cycle a refusal counts against is decided by the recorder, not by the request and not by a clock.** Each authenticated refusal is stamped with the cycle that is open as the recorder refuses it (`open`). The cycle it names is the path's; the body's only where the path names none; a body that contradicts the path is kept as `claimedCycle` and decides nothing.
    - **Counted against the open cycle:** a refusal that names it, one that names no usable cycle (a body that is not JSON, an event of an unknown kind, an acknowledgement without its cycle, a request older than the time window such as a boot report sent by a clock that is more than 5 minutes off), and one whose path and body contradict each other.
    - **Not counted:** a refusal made while no cycle is open (before the start, or after the result is stored, during recovery), and one that consistently names another cycle than the open one. The latter is on record with both cycles.
    - **A refused report of a journal write failure or a worker stop** counts against the open cycle whatever cycle it names.
    - **If the recorder cannot tell which cycle is open** when it refuses (its event ledger cannot be read at that moment), the refusal counts against every cycle of the run, for good: the run has to be replaced. This needs the rejection to be written; if it cannot be, the server holds it in memory as above.
    - **What a restart keeps and what it does not.** A refusal on record (in the rejection log, or the event kept in its place) is counted by any recorder process. One that could be recorded nowhere is known only to the server that made it. That is why a server that takes a cycle over stores no PASS for it at all (`recorderRestarted` above): the guarantee across a restart is the takeover record, not the refusal.
    - **Not protected:** the ledgers are plain append-only files without a hash chain or a second copy. Someone who can edit the recorder's directory can remove a line or a whole file, and the recorder will not notice a complete line that is gone. The recorder host and its directory are trusted.
    - **A consequence to plan for:** anyone who can replay, during a cycle, a captured signed request that names that cycle or no cycle makes the cycle INCONCLUSIVE (never PASS). A replayed request that names another cycle is recorded and not counted.
    - **Silent workers and the clock.** Every event, acknowledgement and rejection carries the recorder host's monotonic time (`mono`) beside the wall-clock time. A worker counts as running at the cut only if its last acknowledgement BEFORE the cut request is recent by both clocks; an acknowledgement after the request changes nothing. A wall clock set back cannot hide a silent worker; one set ahead between the last acknowledgement and the cut reports a silence that was none (INCONCLUSIVE). Not covered: a recorder host paused so that both clocks stand still.
    - **The recorder also holds the PASS to its own record of the cut:** none is stored without a recorded cut whose last confirmation is `yes`, or with a worker stop or silent worker before the cut request. `confirm-cut` is refused once the cycle has its result.
    - **Not counted, and for the product owner to rule on:** a worker's stop report that arrives AFTER the cut request (the cut request is not the power loss; a committed test pins this as intended).
    - **Replayed, stale and pre-restart requests** are no longer written once the run's rejection log is larger than 16 MiB; they are then held in the server's memory against the open cycle (no PASS). A refusal of a request signed now is always written.
    - **Held in memory against the open cycle as well:** a request refused because the volume registry is inconsistent. A worker-stop or journal-failure report answered "busy", and an acknowledgement or such a report that the recorder could not handle, is in addition refused on record with its attribution.
- **What the recorder itself verifies before it stores a PASS** (product-owner rulings of 18 November 2026; `passEvidenceProblem`), in this order after the damage, refusal, cut and silence rules:
  - **A, worker stops:** no worker stop reported after the cut request either (its place in the event ledger decides, not a clock). The cut request is not the power loss.
  - **B, evidence:** an acknowledged claim before the cut; no cut confirmation other than `yes` anywhere. For the qualifying failure models (POWER-CUT, VM-CRASH): every start names its boot; a boot report placed after the cut request from a boot that no start ran on and that was not reported before the cut, and it is the boot `check` reports (`reboot.bootIdNow`); the durability settings on and, for POWER-CUT, exactly the configuration readiness bound, at every start and in the result; the run id, the database cluster (volume registry and every start), and for POWER-CUT the journal marker, the installation id, the start binding digests and the recorder's own binding unchanged since readiness. Other runs never count toward the series and are not held to the qualifying rules.
  - **C, evidence boundary:** the cycle view carries an `evidenceMark` (sizes of the run's event ledger, accepted claims, the cycle's acknowledgement file, the stop marker and the volume registry, and the number of authenticated refusals). `check` sends back the mark of the view it verified; a PASS whose mark differs is refused (`pass_evidence_changed_since_it_was_checked`). That refusal alone is not held against the cycle: the next `check` reads the view again and is held to every rule. Reading the view, checking and storing run in one synchronous step of the server under the directory lock, so nothing can be added in between.
  - **After the result:** a FRESH acknowledgement or worker report about a cycle that already has its result (the cycle it names, the cycle whose id it carries, or, if it names none, the last cycle started or decided) is refused and recorded with `afterResultOf`. A stored PASS with such a record has the final status INCONCLUSIVE (cycle view, `recovered` answer, run status and series count). A replayed request does not count. `confirm-cut` is refused once a cycle has its result.
  - **A contradiction that cannot be written where it normally goes** (the rejection log, then a `refusal_not_recorded` event) is written to a place of its own: a write-once file per request, `<recorder dir>/contradictions/<run>/contradiction-<nonce>.json`. The file and the directories above it are synced, and the answer says `fallback: "contradiction_marker"`. These files are evidence: keep them with the recorder directory. Every view reads them; one that cannot be read counts against every decided cycle.
  - **If no place can take it, the server holds it in memory** and says so loudly on stderr; that is never described as recorded. While it holds one, the server:
    - refuses recovery of the cycle, every cycle start, and every PASS;
    - shows the cycle as INCONCLUSIVE in its own views;
    - tries to write it again at every request;
    - does not stop on any catchable terminating signal: SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGUSR2, SIGALRM, SIGVTALRM, SIGXCPU, SIGXFSZ and others where the platform has them. SIGUSR1 is left to Node's debugger. SIGPIPE, SIGPROF and SIGTRAP are not taken over: Node ignores SIGPIPE, and profilers and debuggers send the other two.
    **Do not restart the recorder while it reports one: restore its storage, and the next request writes it.** `recorder.mjs status` runs in a process of its own and cannot see what a running server holds; it says so when a server is serving the directory. Ask the server (`GET /runs/<run>`) instead.
  - **A report of work while the run's records cannot be read or found** counts against every decided cycle (`afterResultOf: "*"`). This covers a ledger that cannot be read when the run is first loaded, a run directory that is missing, and a recorder disk that is replaced or gone. The server keeps every run key it has seen in memory, and answers the signed time request from the key alone, so such a report can still be authenticated.
    - It is written to a marker. When the run's directory could not be found, the report is also held until a marker is kept on the recorder's own disk: the identity file `recorder-id.json` must be the one the server first saw, and the marker must still be found on the same device afterwards.
    - The recorder directory itself is never created by the server.
  - **Supported storage failure envelope.** The recorder assumes its designated storage keeps its identity while the server runs: the same disk, mounted at the same place. Inside that envelope it handles a file or directory that cannot be read or written, a ledger that ends in a fragment, a write that fails, a run directory or key file that cannot be read, and a restart between requests; each of these fails closed as described above. **Replacing or remounting the recorder's disk underneath a running recorder is outside the supported envelope** (product-owner ruling of 18 November 2026). The recorder does not claim protection against physical storage substitution. Where it does detect an identity inconsistency (the identity file is not the one it first saw, or a marker is not on that file's device), it keeps what it holds rather than release it.
  - **THE STATED LIMIT, accepted by the product owner for the prototype (18 November 2026):** a contradiction held in memory is lost if the server is ended before any write of it succeeds on the recorder's own disk. That means by a signal it cannot catch (SIGKILL), a crash, or the recorder host losing power. A restarted server cannot know of it, and recovery records the PASS. **Post-result contradiction handling is not restart-safe under total recorder-storage failure.** A test pins this.
    - The same holds if the server was started on an empty or absent directory with `--new-directory` (an unmounted disk): it knows no keys and cannot authenticate the report.
    - A restored or cloned copy of the recorder directory carries the same identity, so a marker written to a copy mounted in place of the original is not told apart.
  - **While a run's rejection log cannot be read** it may hold a contradiction, so no stored PASS is shown as final, and recovery is refused.
  - **When the cycle cannot be determined** (the run's ledgers could not be read as the report arrived), a contradiction counts against every decided cycle (`afterResultOf: "*"`), including PASSes recovered long before, and every cycle decided later. A short read fault on the recorder host while a report arrives therefore ends the run's physical series: replace the run. This fails closed by design; it needs a storage fault on the recorder host.
  - Other limits: VM-CRASH runs have no readiness record, so their journal identity is not checked; `cut_command_finished` is written outside the lock after the cut command returns, and no decision reads it.
    - **A complete line that is not a record** in one of the run's ledgers (an interrupted write cannot produce one) is named by `verify-dir` and refuses a cycle start. For the rejection log and the accepted-claims ledger, the server that is running serves the cycle as damaged and INCONCLUSIVE can close it; for the event ledger no request can be served at all. **After a recorder restart the run is unusable in every case: every request fails and no verdict of any kind is stored.** The same holds for a result file that cannot be parsed. Nothing repairs it.
  - Only a refusal releases a saved result. One that was merely not delivered (a timeout, a lost connection, an unauthenticated or busy answer, a server fault) is sent again exactly as saved, as before.
- **Limits:** if the recorder restarts between the failure and the check, `recorderMemory` is empty; the view then shows the takeover (`recorderRestarted`) and whatever ledger damage there is, not the original reason. A fresh attempt that still computes a result the recorder refuses is refused again, in its own directory; each run of `check` makes at most one attempt.
- Unit-tested against a real in-process recorder with the library functions `check` uses (`test/cycle-closure.test.mjs`). `p7.mjs check` itself has never run.

## An event belongs to a cycle that has started

Second safety review, finding B (post-commit review, F14).

- An event that names a cycle is accepted only if that cycle **has started**, and only with that cycle's own id, given as a string and equal to it exactly. Otherwise: `cycle_not_started` or `wrong_cycle_id`.
- A `worker_stopped` event must name its cycle (`worker_stopped_needs_its_cycle`) and is accepted only for the cycle that is **open**: started and not yet checked (`cycle_not_open`). A `journal_write_failed` report is held to the same.
- A refused event is logged as an authenticated rejection, like any other refusal, and stored nowhere else: it cannot count against another cycle. Before this, a `worker_stopped` sent ahead of a cycle without an id was stored and later made the real cycle INCONCLUSIVE.
- Unchanged: run-level events without a cycle (`volume_claimed`, `initialised`, `adopted`, a `netcheck` outside a cycle), and cycle events with the right id, including `quarantine_observed` and `netcheck` for a cycle already checked.
- Unit-tested (`test/cycle-events.test.mjs`).

## The whole series is planned before it starts

Post-commit review F7; product-owner decision of 18 November 2026.

- **Why:** clearance was validated for 1,000,000 affected actions. A claimed action stays affected for the rest of the series (the harness never moves it out of `EXECUTING`, by decision), so every cycle's claims accumulate.
- **The plan (`lib/sizing.mjs`, `seriesPlan`):** `20 cycles x the most claims that can start in one cycle within the planned time + the pool of one cycle` must not exceed 1,000,000. The pool already holds the headroom (at least 2) over the allowance. The most claims per cycle is the pacer's own bound, for every worker of every process.
- **Preflight** computes it (`--cycles`, 20 by default) and is BLOCKED if the series does not fit. **Nothing is reduced to fit:** another workload must be decided. The largest number of claims per cycle that fits follows from the calculation for the given pool (`maxClaimsPerCyclePermitted`); no fixed figure is built in.
- **The readiness record** binds the planned cycles with the rest of the workload, and stores the calculation (`plan`, shown by `status`). The recorder accepts a record only for 20 planned cycles that fit; a start on another plan is `readiness_stale`.
- **Before every cycle, on the actual count:** `run` counts every action clearance would have to process now (claimed and still `EXECUTING`, settled as unknown, or waiting) and refuses, before the recorder is asked and before anything is seeded, if that plus the new pool would pass 1,000,000. It reports both numbers with the start; the recorder refuses a count that is malformed, that is not for the recorded pool, or that passes the envelope (`series_capacity_exceeded`), and keeps the count with the start.
- **Limits:** the plan bounds the claims of the planned time; a cut that comes later than planned lets a worker claim more, up to its pool, which only the count before the next cycle sees. The recorder cannot count the database: it checks what the test machine reports, and a start that reports no count is not refused by the recorder. The count and its SQL are in `p7.mjs`, which has never run.
- Unit-tested: `test/series-plan.test.mjs`.

## Further hardening after the second safety review

Each item names its finding in `docs/m16-p7-post-commit-review.md` (F) or `docs/m16-p7-second-safety-review.md` (C).

- **`recover` is not tried again after a recorded recovery failure** (F5), also when the run was "only" stopped as inconclusive.
- **A clearance leaves its evidence at once** (F6): `clearance-<time>.json` in the cycle's evidence, written as soon as the clearance committed; a re-run reads the digest back from it instead of reporting none. The cycle summary is written before the recovery is reported, and the recorder's answer beside it when it arrives (`recovery-recorded-<time>.json`). A saved clearance is used only if it names this cycle and this claim.
- **A lost note after the cycle start no longer leaves a started cycle without workers** (F8, in part). A start request whose answer is lost is still a stop: the actions are seeded and that cycle cannot be started again.
- **The cut's command is checked before a cut is scheduled** (F13): `--command-json` must be a non-empty JSON array of strings.
- **An accepted claim is recorded once** (F15), also when the recovery report is repeated.
- **Strict network check** (F18, F19): the gateway's self-check must have probed both of the gateway's bridge addresses, and the recorder target must be an IPv4 address, not a host name.
- **The recorder client never follows a redirect** (F23): before, a redirect from whatever answered at the recorder address made the client send the signed request to the redirect's target.
- **Not changed, and why:** the scripts (`smoke-teardown.sh`, `smoke-containers-down.sh`, `smoke-docker-desktop.sh`, the firewall script: F9, F11, F12, F20, F21) cannot be exercised under the restrictions these changes were made under, so they were left as they are. The size check before a cycle (F7) is a decision for the product owner: counting every affected action could refuse a later cycle of a series. F16, F17, F22 and C6 are recorded as open.
- **From the final review of these changes** (`docs/m16-p7-second-safety-review.md`, D1 to D12): a stop is recorded even when its event cannot be written (the marker is written first); the client's error names what was refused; an unreadable acknowledgement file or directory is reported by error code, never by a path of the recorder host; `run` ends with exit code 10 after a journal write failure; the strict target rule takes a real IPv4 address only.
- All of the above that is in `p7.mjs` has never run.

## Removing smoke state

Two scripts, with different reach. Neither is run by anything else.

### Containers and networks only: `smoke-containers-down.sh`

It frees the smoke project's container names, network names and bridge names, and **keeps every smoke volume.**

- `./smoke-containers-down.sh` is a dry run: every check, then the exact containers and networks.
- `./smoke-containers-down.sh --confirm opsilume-m16-p7-smoke` removes those containers by id (`docker rm <id>`) and those networks by name (`docker network rm <name>`), in that order.
- **It refuses** unless:
  - the project is exactly `opsilume-m16-p7-smoke` (fixed in the script);
  - every volume of the project is a smoke volume (`..._pgdata` or `..._state`, with or without a generation suffix) with that project's labels and `opsilume.p7.data=disposable-harness-smoke`, and there is at least one of each kind;
  - every container is labelled with that project, is `db`, `gateway` or `harness` (each at most once), is **not running**, and mounts no volume other than those smoke volumes;
  - only that project's containers use the volumes or are attached to its networks;
  - every network is labelled with that project and is one of its three, and no unlabelled network carries the project's name.
- **It can't remove a volume.** The script contains two removing commands and no other: no volume command that removes, no Compose, no `run`, no force, no `-v`. `docker rm` without `-v` never removes a named volume, and the mount check rules out anonymous ones.
- **A partial removal can be repeated.** Whatever is left is checked again and removed; with nothing left it does nothing.
- **Afterwards** it compares every volume's name, creation time, mountpoint and labels with what it read before, and checks the containers and networks are gone; anything else ends with `STOP` and exit 3. That comparison shows the volumes' identity, not their contents.
- It stops nothing: a running container is a refusal.
- **Fresh volumes come from a new generation, never from a removal.** `compose.smoke.yml` names the smoke volumes per generation (`opsilume-m16-p7-smoke_pgdata_<generation>`, `..._state_<generation>`), and `P7_SMOKE_GENERATION` must be set for every smoke Compose command; Compose refuses without it. `smoke-docker-desktop.sh` requires a generation whose volumes don't exist yet, and checks after `up` that its containers are on exactly those volumes. Volumes an earlier smoke left behind (with another generation, or with none) are never attached, started or removed; they simply stay. The qualifying project's volumes have no generation and no disposable label, and a different project name.
- **Tested with a stub `docker` only** (`./test-containers-down-with-stubs.sh`). An earlier version was also dry-run against the real daemon through a shim that forwards listing and inspect calls only. The real removal has never been run, and the generation-named volumes have never been created by Compose.

### Volumes included: `smoke-teardown.sh` (disabled by default)

Nothing in the harness removes a volume except `smoke-teardown.sh`, and it removes only the two smoke volumes without a generation suffix; if the project also has generation-named volumes it refuses, so nothing removes those. `--confirm opsilume-m16-p7-smoke` alone is refused: deleting the smoke volumes needs the product owner's separate, explicit authorisation, stated as `--volume-removal-authorised-by-product-owner`.

- `./smoke-teardown.sh` is a dry run: it runs every check and prints the project and the exact volumes.
- `./smoke-teardown.sh --confirm opsilume-m16-p7-smoke --volume-removal-authorised-by-product-owner` removes the containers and networks of that project (`down`, never `-v`) and then the two volumes by exact name.
- **It refuses** unless: the project is exactly `opsilume-m16-p7-smoke` (fixed in the script); its volumes are exactly `opsilume-m16-p7-smoke_pgdata` and `opsilume-m16-p7-smoke_state`; each carries that project's Compose labels and `opsilume.p7.data=disposable-harness-smoke`; the marker in the journal volume, if there is one, says `HARNESS-SMOKE`; and only that project's containers use the volumes.
- **Qualifying volumes can't pass it.** The label comes only from `compose.smoke.yml`, which is never used with the qualifying project, and that project has another name.
- **It never touches** the recorder directory, the registry or the evidence directory: those are host directories, not Docker volumes.
- **The removal has only been tested with a stub `docker`** (`./test-teardown-with-stubs.sh`). Against real Docker only the dry run has been run; the real removal never has.

## Storage evidence checklist

These are five different things. The harness records them separately and never lets one stand in for another.

| What | How it is established | Field |
|---|---|---|
| Device cache configuration | `queue-<dev>.txt` (`write_cache`), `hdparm-W-<dev>.txt` or `nvme-vwc-<dev>.txt` | `writeCache` |
| Device reports flush support | `hdparm-I-<dev>.txt` (FLUSH CACHE commands) for SATA; the NVMe specification makes Flush mandatory, recorded from `nvme-id-ctrl-<dev>.txt` | `flushSupported` |
| Kernel flush requests observed | `flush-probe.txt` from `host-evidence.sh --flush-probe`: the flush-request count for the journal's device rises | `flushesObserved` |
| FUA advertised | `queue-<dev>.txt` (`fua`), `kernel-storage-messages.txt` | `fua` |
| Vendor-documented flush/FUA durability | The vendor's datasheet or documentation, cited | `vendorDoc`, `vendorFlushSemantics` |

**None of these is a measurement of PostgreSQL's or the journal's durability.** The flush probe fsyncs a probe file; it says nothing about the journal's or PostgreSQL's own writes. Only the power-cut cycles test that.

The operator fills `storage-evidence.template.json` and passes it to `create-run --storage-json`. Every item is required:

- [ ] Drive model and firmware (`driveModel`, `firmware`): `lsblk.txt`, `queue-<dev>.txt`, `smart-<dev>.txt`
- [ ] Controller (`controller`): `lspci-storage.txt`, `lsblk-tree.txt`
- [ ] Database and journal device mapping, and the filesystem with its mount options (`dbDevice`, `journalDevice`, `filesystem`): `findmnt-pgdata.txt`, `findmnt-state.txt`. No `nobarrier`, no `data=writeback`
- [ ] Write-cache configuration (`writeCache`)
- [ ] FUA status (`fua`: `yes`, `no`, `not-advertised`)
- [ ] Flush support (`flushSupported`) and observed use (`flushesObserved`)
- [ ] Vendor documentation reference (`vendorDoc`) and whether it supports flush/FUA durability (`vendorFlushSemantics`)
- [ ] The evidence files (`evidenceFiles`)
- [ ] PostgreSQL durability settings: read by the harness itself in `preflight`, `init`, `adopt` and every `run`

**A qualifying run is refused, with every reason listed, if:**
- any item is missing or "unknown";
- the vendor documentation doesn't support flush/FUA durability;
- the cache is write-back and the device doesn't report flush support, or no kernel flushes were observed;
- FUA is advertised but doesn't work;
- the drive is write-through without FUA and without demonstrable flushes.

FUA not advertised is accepted only with observed flushes **and** the vendor documentation.

## Preflight and the readiness record

`docker compose exec -T harness node p7.mjs preflight --max-seconds <s> --rate <r> [--workers n] [--procs n] [--burst-period s --burst-seconds s --quiet-rate r]`

It prints `READY_FOR_OPERATOR_REVIEW` or `BLOCKED` with the exact reasons, and exits 0 or 6. It changes nothing on the test machine, seeds nothing, and **never starts a workload or a cut**. `READY_FOR_OPERATOR_REVIEW` is not approval, and it has never been produced end to end: that needs the real host.

**What it writes, all of it on the recorder:** the log of the unauthenticated probes it sends on purpose and, only when every check passes, one **readiness record** in the run's own ledger.

### The readiness record

A `POWER-CUT` cycle starts only while the configuration is exactly the one a successful preflight recorded for that run. The recorder refuses the start otherwise (`readiness_missing`, or `readiness_stale: <what changed>`), before anything is seeded.

| Bound | From | Changes when |
|---|---|---|
| Run id and run type; the run it continues, if any | Recorder | Never: a record belongs to one run |
| Database cluster system identifier | Test machine | Other database volume or a new cluster |
| Journal volume identity (digest of the marker `init` wrote, and the installation id) | Test machine | Other journal volume |
| Recorder identity (`recorder-id.json`) | Recorder | Other or copied recorder directory without its identity |
| Registry state (`volumes.jsonl`, byte for byte) | Recorder | **Any** later claim on this recorder, or any edit |
| Storage evidence digest | Recorder | The run record's storage evidence was altered |
| PostgreSQL configuration (`fsync`, `full_page_writes`, `synchronous_commit`, `wal_sync_method`, `data_checksums`, server version) | Test machine | Any of them |
| Firewall as observed: the destinations the strict network check probed (they carry the bridge addresses), all passed | Test machine | Bridge addresses or the probe set change; any probe fails |
| What the operator attested, including `firewall-verified-on-host` and its evidence text | Recorder | Any attestation recorded again |
| Workload: processes, workers per process, longest time to the cut, headroom, rate, throttle, pool per worker, burst period, burst seconds, quiet rate | Test machine | Any of them |
| Harness source, by content (`lib/source.mjs`: one digest over the files either host executes), and the runtime (architecture, Node version) | Test machine, **checked against the recorder's own copy** | A changed, added or removed source file on either host; another architecture or Node version |
| Declared identity: source commit, source package SHA-256, harness image id, image architecture | Recorder (`create-run`, write-once) | Never: fixed when the run is created |

- **Order:** `init` (or `adopt`) and the three attestations come first; then `preflight` records. A preflight before `init` can only report; it says to run it again afterwards.
- **The recorder checks its own half itself** and re-checks the reported half. A bare statement that the machine is ready is never stored.
- **One run only.** A record can't be used by another run, on other volumes, or by the run that continues the series after an INCONCLUSIVE cycle: that run needs its own attestations and its own preflight. A record copied into another run's ledger never matches.
- **A qualifying cycle runs the recorded workload.** `run` takes it from the record; the flags may be left out, and a flag that differs is refused. The recorder also refuses a start with another worker count or a process beyond the recorded number (`--procs 2` allows `--proc a` and `--proc b`).
- **The first accepted record is final.** A later preflight with the same configuration is confirmed and nothing is written; one with any difference is refused (`readiness_already_recorded: <what differs>`) and the record stays as it is. A second record written into the ledger by hand is ignored: the first line is the run's record. `recorder.mjs attest` is refused once the record exists, since it would invalidate it for good.
- **Undoing a change makes the record valid again.** A change that can't be undone (another run's claim on this recorder, an attestation written again, a different image) ends the run as a qualifying series. That is a stop: see "A failed `init` fails closed" for what a stop means for the volumes.
- **The bridge addresses are bound but not fixed.** `compose.yml` gives the networks no fixed subnets, and the probe names carry the addresses. If the qualifying project's networks are ever recreated (`docker compose down`, then `up`) and Docker gives them other subnets, every later start is `readiness_stale: test.firewall...` for good. Never take the qualifying project down during a series.
- **Because the registry is bound byte for byte, no other run may claim volumes on that recorder during the series** (no smoke or supplementary run on other volumes in between).
- **Not bound, on purpose:** sequence heads, boot ids, WAL positions, times and probe outcomes (a timeout and "unreachable" both mean blocked). Whether the bound values really stay the same across a real power cut and reboot has not been observed; every start of a smoke or supplementary run stores the configuration it reported (`bindingNoted`, unenforced), so the host rehearsal can show which values stay the same. Its workload part varies there with the measured rate; the other parts are the ones to compare.

| Check | Blocked when |
|---|---|
| Run type and run id | Not a `POWER-CUT` run; stopped; a cycle already started |
| Fresh, dedicated volumes | The database or journal volume isn't empty; the cluster isn't new; the recorder has the cluster registered to another run |
| Storage evidence | Any item above is missing or doesn't qualify |
| PostgreSQL settings | `fsync`, `full_page_writes` or `synchronous_commit` isn't on |
| Network isolation and host firewall | The strict network check fails (for example the host still answers on a bridge address) |
| Recorder | It doesn't answer an authenticated request, or doesn't reject an unauthenticated one |
| Workload sizing | No rate or duration given, the pool is too small, the burst pattern is incomplete or inconsistent, or the plan exceeds the clearance envelope |
| Workload shape (recorder) | Not one process and one worker, or no burst pattern (decision B1), or a quiet rate below 0.2 claims per second |
| Source and image (recorder) | The source differs from the recorder's copy, or the architecture from the declared one |
| Operator attestations | Any of `firewall-verified-on-host`, `manual-cut-rehearsed-on-host`, `host-evidence-reviewed` is missing |

The attestations are recorded on the recorder host with `recorder.mjs attest --run <run> --item <item> --evidence "<what was done, when, where the output is>"`. They are the operator's statements, labelled as such; the recorder can't observe them. The recorder also refuses a `POWER-CUT` cycle start, and a readiness record, without all three.

On Docker Desktop, preflight is always BLOCKED: the run isn't `POWER-CUT`, there is no storage evidence, the host answers on the bridge addresses, and nothing is attested.

## One cycle (physical power cut)

**Not authorised.** Preparation ends at `READY_FOR_OPERATOR_REVIEW` (`HOST-PREPARATION-CHECKLIST.md`). The 20 physical power-cut cycles need the product owner's separate, explicit authorisation. The commands are listed so the procedure can be reviewed.

```bash
# Before any of this, on the test machine: the firewall, and the smoke rehearsal under its own project. The storage
# evidence comes from there (create-run needs it, and the flush probe needs a journal volume):
#   sudo P7_PROJECT=opsilume-m16-p7-smoke P7_SMOKE_GENERATION=<generation> ./host-evidence.sh <smoke run> baseline --flush-probe
# Recorder host, once (the same directory as the smoke rehearsal; see "The recorder directory": back it up and verify the backup first):
node recorder.mjs serve --dir <recorder-dir> --host <LAN address> --port 8787
node recorder.mjs create-run --dir <recorder-dir> --run p7-1 --failure-model POWER-CUT \
  --storage-json <filled storage-evidence.template.json> --machine "<model, disk>" \
  --source-commit <commit> --package-sha256 <checksum> --package <the source package .tar.gz> \
  --image-id <sha256:...> --image-arch <amd64|arm64>
# copy <recorder-dir>/keys/p7-1.key to the test machine (mode 0600)
# Test machine, once (after ./smoke-containers-down.sh has removed the smoke containers and networks):
export P7_RUN=p7-1 P7_RECORDER_TARGET=<recorder address>:8787 P7_KEY_FILE_HOST=<path to the key>
docker compose up -d --wait && sudo ./host-evidence.sh p7-1 baseline --flush-probe
#   the baseline must show the same device and filesystem as the storage evidence
# verify the host firewall under this project (firewall/README.md: all nine checks, check 3 strict)
# record the three operator attestations (recorder host), then:
docker compose exec -T harness node p7.mjs init          # if it fails: "A failed init fails closed"
docker compose exec -T harness node p7.mjs preflight --procs 1 --workers 1 --max-seconds 660 --rate <maximum burst rate, claims/s> \
  --burst-period <s> --burst-seconds <s> --quiet-rate <claims/s>
#   must print READY_FOR_OPERATOR_REVIEW with "readiness": { "recorded": true }. Review it; it is not approval.
#   That record is final: it is never replaced.
#   ---- everything below needs the product owner's separate authorisation ----
# Each cycle N (the workload is the recorded one: one process, one worker, the recorded burst pattern; nothing else is accepted):
docker compose exec -T harness node p7.mjs run --cycle N --proc a
node recorder.mjs cut --dir <recorder-dir> --run p7-1 --cycle N --min-seconds 5 --max-seconds 600 \
  [--command-json '["<plug command>", "..."]']                                    # recorder host
# ... power returns, the machine boots, the stack restarts by itself ...
node recorder.mjs confirm-cut --dir <recorder-dir> --run p7-1 --cycle N --power-was-cut yes \
  --attested-from <ISO time you cut it> [--attested-to <ISO time>] --evidence "<what was seen>"   # an attestation
sudo ./host-evidence.sh p7-1 cycle-N-after-boot
docker compose exec -T harness node p7.mjs check --cycle N                        # exit 0 PASS, 2 FAIL, 3 INCONCLUSIVE
docker compose exec -T harness node p7.mjs recover --cycle N                      # exit 4: inspect, then pass --clear-digest
```

**On a FAIL or INCONCLUSIVE:** stop. On a FAIL leave the machine powered off, preserve the disk, and report (plan §5).

## Manual power-cut procedure

For when no smart plug is used, or as its fallback. **It must be exercised on the real machine before qualifying cycles**; so far it has only been rehearsed on Docker Desktop with a container kill.

**Decision B2: the host rehearsal cuts no power.** The machine stays on an outlet the plug doesn't switch; the operator goes through the sequence, with the plug's command and then with the manual prompt, in a `HARNESS-SMOKE` run, and answers `confirm-cut --power-was-cut no`. That cycle is INCONCLUSIVE (`POWER_LOSS_NOT_CONFIRMED`), as it should be. It is evidence that the sequence and the plug command work, never a physical power-cut cycle, and the `manual-cut-rehearsed-on-host` attestation must say that no power was cut.

1. Start the cycle's workload on the test machine (`p7.mjs run …`).
2. On the recorder host: `node recorder.mjs cut --dir <dir> --run <run> --cycle N --min-seconds 5 --max-seconds 600`, **without** `--command-json`. It waits a random time, records the request time, and prints `*** CUT THE POWER NOW ***`.
3. At the prompt, switch the power off at the wall socket (never by opening the machine). Note the time from a clock synchronised with the recorder.
4. Wait at least 10 seconds, switch the power on, and let the machine boot. The stack restarts by itself, and the boot probe records the boot time and when PostgreSQL became reachable.
5. On the recorder host: `confirm-cut --power-was-cut yes --attested-from <time> [--attested-to <time>] --evidence "<what you saw: fans stopped, LEDs off>"`. If the power did not actually go, answer `no`: the cycle is then INCONCLUSIVE.
6. `host-evidence.sh`, `check`, `recover` as usual.

**What is recorded:** the request time (recorder clock); the operator's attested time or interval, labelled as an attestation; the last durable acknowledgement before, and the first contact after; the boot time; and recovery start and completion. Nothing observes the cut independently, and the evidence never says so.
