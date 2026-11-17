# Milestone 16, P7: durability harness

**Research prototype. Not production code. Not a durability result.** P7 (native Linux durability) remains **NOT APPROVED and NOT TESTED**. This directory contains the harness for the physical power-loss test described in `docs/p7-physical-linux-test-plan.md`. Passing it would validate the journal durability **mechanism** of the prototype only. It would not establish production readiness.

## What it reuses, and what it leaves alone

- **Reused, unchanged:** the Phase 0.5 library in `../m16-phase05/lib/` (`claim`, `appendLocked`, `inspect`, `clear`, the journal and its verifier).
- **Not modified:** the Phase 0.5 files and results, and the Phase 0 branch.
- **Not part of the build:** nothing under `apps/` or `services/` imports this directory.
- **Its own Compose project:** `compose.yml` is `opspilot-m16-p7`.
  - PostgreSQL is reached **directly**: there is no fault proxy. The Phase 0.5 proxy is still available in `../m16-phase05/` for fault injection.
  - Networks are described under "Network isolation" below.
- **PostgreSQL** runs with `fsync=on`, `full_page_writes=on` and `synchronous_commit=on`. `init` and `run` refuse to start unless `SHOW` confirms all three. `wal_sync_method` is recorded, not set.
- **Synthetic data only.** There are no credentials beyond the throwaway local `proto` database user. Dispatch is a synthetic `dispatch` intent record in the journal: **no request is ever sent to any destination**, and there is no webhook receiver.

## Parts

| File | Runs on | Purpose |
|---|---|---|
| `recorder.mjs` | **Another host** (for example the Mac), never on the switched outlet | Authenticates every request; stores each accepted acknowledgement with `fsync` **before** replying; holds the failure model, storage attestation, cut times (its own clock), results, recoveries and the stop marker. Operator commands: `create-run`, `cut`, `confirm-cut`, `status` |
| `gateway.mjs` | The machine under test, `gateway` container | The harness's only way out: forwards TCP to one fixed address, the recorder |
| `p7.mjs` | The machine under test, `harness` container | `boot-probe` (entrypoint), `netcheck`, `init` (once, on empty volumes; never wipes), `adopt` (a run that continues an earlier one), `run`, `check`, `recover` |
| `firewall/` | The machine under test, on the host | `p7-firewall.sh` and its README: the mandatory host firewall. **Prepared, never applied** |
| `host-evidence.sh` | The machine under test, on the host, as root | OS, kernel, virtualisation, mounts, devices, write cache, FUA, SMART, kernel log, PostgreSQL log. Read-only. **Not yet exercised on a real Linux machine** (required before qualifying cycles) |
| `lib/` | — | `protocol.mjs` (authentication, acknowledgement streams), `ledger.mjs`, `scan.mjs`, `verdict.mjs`, `sizing.mjs` |
| `test/` | Anywhere with Node 22+ | `node --test prototype/m16-p7/test/*.test.mjs`. **Harness tests**, not durability results |
| `smoke-docker-desktop.sh` | A development machine | End-to-end flow with container kills, labelled `HARNESS-SMOKE`, which **can never count** |

## Recorder protocol (test-only)

- **Key:** `create-run` makes one random 256-bit key per run, in `<recorder-dir>/keys/<run>.key` (mode 0600). The operator copies it to the test machine; the harness mounts it read-only. It is never printed, logged, committed or copied into evidence.
- **Request:** headers `x-p7-run`, `x-p7-ts` (ms), `x-p7-nonce` (random, single use) and `x-p7-mac` = HMAC-SHA256 over `P7-REQ-1`, method, path, run, timestamp, nonce and the body's SHA-256.
- **Refused:** a bad MAC, a run that differs from the path, a timestamp more than 5 minutes off, a nonce already seen (nonces are persisted, so this survives a recorder restart).
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

## The rules it enforces

- **Acknowledgements.** A claim is acknowledged only after `claim()` returned `claimed: true`, which is after its transaction's COMMIT returned. Its dispatch intent is acknowledged after that record was `fsync`ed. An uncertain commit, quarantine, error or unreachable recorder stops that worker. An ambiguous claim is **never retried or acknowledged**.
- **Each check, before anything is repaired:** the journal and identity file are copied into the cycle's evidence directory and synced to disk. Then the comparison runs (see `lib/verdict.mjs`).
- **Verdicts** fail closed, and FAIL outranks INCONCLUSIVE.
  - **A journal one claim ahead is not an unconditional pass.** The cycle stays `PENDING_RECOVERY` until the recorder holds: an observed quarantine (a claim was refused), the operator's inspection digest, and a completed clearance.
  - **A complete final line with an invalid hash is a FAIL.** Only a line with no newline is a torn tail (N1). Nothing else is ever repaired.
  - **INCONCLUSIVE when:** flush or FUA behaviour is unverified; a durability setting is off; no cut recorded or not confirmed; no reboot observed after the cut (qualifying runs); a worker stopped or went silent before the cut; the recorder rejected an authenticated message; no acknowledgements; a `HARNESS-SMOKE` run.
- **The qualifying series** is 20 cycles with final status PASS, from cycle 1, in one `POWER-CUT` run.
  - A FAIL stops the run. So does an INCONCLUSIVE cycle in a `POWER-CUT` or `VM-CRASH` run: investigate, resolve, and start a **new run at cycle 1**.
  - `create-run` refuses a qualifying run whose flush or FUA behaviour is not attested as verified, with the evidence named (see "Storage evidence").
  - `VM-CRASH` runs are supplementary and never count.
- **Continuing state.** The database and journal carry over across cycles; nothing is reset. Every cycle ends with `recover`, which the recorder requires before the next start.
- **After an INCONCLUSIVE cycle** the run is stopped, but the state is kept:
  1. `recover` that cycle. This is still allowed, and quarantine and clearance are not skipped.
  2. Investigate and resolve the cause.
  3. On the recorder: `create-run --run <new> --continues <old>` (a new key and a new record; the old run's record is never changed).
  4. On the test machine: set `P7_RUN` and `P7_KEY_FILE_HOST` to the new run, `docker compose up -d` (only the harness container is recreated; the volumes are untouched), then `p7.mjs adopt`.
  - `adopt` changes nothing. It refuses unless the journal verifies in full, the state is trusted, and it is exactly the state the recorder holds from the old run's last recovery.
  - The new run's count starts at zero, at its own cycle 1. Claims an earlier clearance accepted as never committed carry over, so every history comparison still covers the whole journal.
  - A run that **failed**, or whose recovery failed, can never be continued. Nor can a run that isn't stopped. `init` refuses a non-empty database, and nothing in the harness wipes volumes.
  - No run starts a cycle on volumes it neither initialised nor adopted: the recorder refuses the first start otherwise.
- **Workload sizing.** `run` needs `--max-seconds` (the longest planned time to the cut) and a claim rate: `--rate`, or `--target-rate` (a throttle), or the rate measured in the previous cycle. The pool per worker is `rate x max-seconds x headroom`, with headroom at least 2. A smaller `--pool` is refused before anything is seeded or started. `--workers` (1 to 12) and a second process (`--proc b`) set the burst size.
  - `recorder.mjs cut` refuses a delay that could run past the time the pools were sized for.
  - **Clearance envelope:** clearance was validated up to 1,000,000 affected actions (Phase 0.5), and every waiting APPROVED action is affected. `run` refuses to seed past that; use `--target-rate`, fewer workers or a shorter `--max-seconds`.
  - **Retiring unclaimed actions:** at the end of `recover`, the cycle's unclaimed synthetic actions go from APPROVED to PROPOSED, so they don't pile up across cycles. Claimed actions, the journal and the audit rows are not touched. This is a harness housekeeping step, not part of the design under test.
- **`check` can be retried** without overwriting anything: a saved result is re-sent as it is, and a new attempt gets its own directory.
- **Power-cut timing.** `confirm-cut` records the operator's attested time or interval (`--attested-from`, `--attested-to`). It is labelled an attestation everywhere; `independentlyConfirmed` is always false.
- **Evidence** is write-once. Each cycle records: run and cycle ids, failure model, cut-request time, the bounds on the cut (last durable acknowledgement, first contact afterwards), last journal and database sequence, boot time, when PostgreSQL started and became reachable, verification and recovery times, quarantine and clearance results, and the verdict with reasons. The cut itself is **not independently observed**; the operator's confirmation is recorded as an attestation.

## Storage evidence (flush and FUA)

`sudo ./host-evidence.sh <run> baseline --flush-probe` records what the operator needs. The operator then attests at `create-run`, naming the files in `--storage-evidence`.

| Question | Where to look | Attested as |
|---|---|---|
| Which device and controller hold the journal and PGDATA? | `findmnt-state.txt`, `findmnt-pgdata.txt`, `lsblk.txt`, `lsblk-tree.txt`, `lspci-storage.txt` | Recorded in `--machine` |
| Write-cache state | `queue-<dev>.txt` (`write_cache`), `hdparm-W-<dev>.txt` or `nvme-vwc-<dev>.txt` | `--write-cache "write back"` or `"write through"` |
| Is FUA advertised? | `queue-<dev>.txt` (`fua: 1` or `0`), `kernel-storage-messages.txt` ("supports DPO and FUA" / "doesn't support DPO or FUA") | `--fua yes`, `no` or `not-advertised` |
| Does the kernel issue flushes for fsync on this path? | `flush-probe.txt`: the flush-request count for the journal's device rises during the probe | `--flushes-observed yes` or `no` |
| Does the device honour a flush? | The vendor's datasheet or documentation only. No tool on the machine can show it | `--flush-honoured yes`, `no` or `unknown` |
| Power-loss protection | The datasheet | `--plp yes`, `no` or `unknown` |
| Mount options | `findmnt-*.txt`: no `nobarrier`, no `data=writeback` | Checked by the operator |
| PostgreSQL durability settings | Read by the harness with `SHOW` in every cycle; `init`, `adopt` and `run` refuse unless all three are on | Automatic |

**What qualifies:** a known write cache, flush honoured `yes`, and either FUA `yes`, or FUA `not-advertised` together with flushes observed `yes`. Anything unknown doesn't qualify, and `create-run` then refuses a `POWER-CUT` or `VM-CRASH` run.

**What this does not establish:**
- A missing FUA flag proves nothing by itself. It is accepted only with the flush probe showing the kernel's flushes on that device.
- The probe shows the kernel **sends** flushes. That the drive **obeys** them rests on the vendor's documentation, and ultimately on the power-cut cycles themselves.
- A "write through" device without FUA sends no flushes, so it doesn't qualify under this rule. It would need a separate decision.

## One cycle (physical power cut)

```bash
# Recorder host, once:
node recorder.mjs serve --dir <recorder-dir> --host <LAN address> --port 8787
node recorder.mjs create-run --dir <recorder-dir> --run p7-1 --failure-model POWER-CUT \
  --write-cache "write back" --flush-honoured yes --fua yes --plp unknown \
  --storage-evidence "host/baseline/queue-nvme0n1.txt, <datasheet>" --machine "<model, disk>"
# copy <recorder-dir>/keys/p7-1.key to the test machine (mode 0600)
# Test machine, once:
export P7_RUN=p7-1 P7_RECORDER_TARGET=<recorder address>:8787 P7_KEY_FILE_HOST=<path to the key>
docker compose up -d --wait && sudo ./host-evidence.sh p7-1 baseline --flush-probe
# apply and verify the host firewall (firewall/README.md)
docker compose exec -T harness node p7.mjs netcheck && docker compose exec -T harness node p7.mjs init
# Each cycle N:
docker compose exec -T harness node p7.mjs run --cycle N --proc a --workers 2 --max-seconds 660 --rate <claims/s per worker>
#   bursts: also --proc b in a second shell. From cycle 2 the rate may be left out: the previous cycle's measured rate is used
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

1. Start the cycle's workload on the test machine (`p7.mjs run …`).
2. On the recorder host: `node recorder.mjs cut --dir <dir> --run <run> --cycle N --min-seconds 5 --max-seconds 600`, **without** `--command-json`. It waits a random time, records the request time, and prints `*** CUT THE POWER NOW ***`.
3. At the prompt, switch the power off at the wall socket (never by opening the machine). Note the time from a clock synchronised with the recorder.
4. Wait at least 10 seconds, switch the power on, and let the machine boot. The stack restarts by itself, and the boot probe records the boot time and when PostgreSQL became reachable.
5. On the recorder host: `confirm-cut --power-was-cut yes --attested-from <time> [--attested-to <time>] --evidence "<what you saw: fans stopped, LEDs off>"`. If the power did not actually go, answer `no`: the cycle is then INCONCLUSIVE.
6. `host-evidence.sh`, `check`, `recover` as usual.

**What is recorded:** the request time (recorder clock); the operator's attested time or interval, labelled as an attestation; the last durable acknowledgement before, and the first contact after; the boot time; and recovery start and completion. Nothing observes the cut independently, and the evidence never says so.
