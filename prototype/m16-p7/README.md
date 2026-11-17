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
| `p7.mjs` | The machine under test, `harness` container | `boot-probe` (entrypoint), `netcheck`, `init` (once; never wipes), `run`, `check`, `recover` |
| `host-evidence.sh` | The machine under test, on the host, as root | OS, kernel, virtualisation, mounts, devices, write cache, FUA, SMART, kernel log, PostgreSQL log. Read-only. **Not yet exercised on a real Linux machine** (required before qualifying cycles) |
| `lib/` | — | `protocol.mjs` (authentication, acknowledgement streams), `ledger.mjs`, `scan.mjs`, `verdict.mjs` |
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
- `p7.mjs netcheck` verifies this from inside the harness, and `init` and `run` refuse to proceed unless it passes: the recorder answers only authenticated requests through the gateway; internet addresses, external DNS, the recorder host directly, and the host and bridge addresses are all unreachable.
- **Limit:** the gateway container itself has ordinary outbound access. It runs fixed code that connects only to the recorder, but a host firewall rule on the test machine (allow only the recorder address) is still recommended and must be checked there.

## The rules it enforces

- **Acknowledgements.** A claim is acknowledged only after `claim()` returned `claimed: true`, which is after its transaction's COMMIT returned. Its dispatch intent is acknowledged after that record was `fsync`ed. An uncertain commit, quarantine, error or unreachable recorder stops that worker. An ambiguous claim is **never retried or acknowledged**.
- **Each check, before anything is repaired:** the journal and identity file are copied into the cycle's evidence directory and synced to disk. Then the comparison runs (see `lib/verdict.mjs`).
- **Verdicts** fail closed, and FAIL outranks INCONCLUSIVE.
  - **A journal one claim ahead is not an unconditional pass.** The cycle stays `PENDING_RECOVERY` until the recorder holds: an observed quarantine (a claim was refused), the operator's inspection digest, and a completed clearance.
  - **A complete final line with an invalid hash is a FAIL.** Only a line with no newline is a torn tail (N1). Nothing else is ever repaired.
  - **INCONCLUSIVE when:** flush or FUA behaviour is unverified; a durability setting is off; no cut recorded or not confirmed; no reboot observed after the cut (qualifying runs); a worker stopped or went silent before the cut; the recorder rejected an authenticated message; no acknowledgements; a `HARNESS-SMOKE` run.
- **The qualifying series** is 20 cycles with final status PASS, from cycle 1, in one `POWER-CUT` run.
  - A FAIL stops the run. So does an INCONCLUSIVE cycle in a `POWER-CUT` or `VM-CRASH` run: investigate, resolve, and start a **new run at cycle 1**.
  - `create-run` refuses a qualifying run whose flush or FUA behaviour is not attested as verified.
  - `VM-CRASH` runs are supplementary and never count.
- **Continuing state.** The database and journal carry over across cycles; nothing is reset. Every cycle ends with `recover`, which the recorder requires before the next start.
- **Evidence** is write-once. Each cycle records: run and cycle ids, failure model, cut-request time, the bounds on the cut (last durable acknowledgement, first contact afterwards), last journal and database sequence, boot time, when PostgreSQL started and became reachable, verification and recovery times, quarantine and clearance results, and the verdict with reasons. The cut itself is **not independently observed**; the operator's confirmation is recorded as an attestation.

## One cycle (physical power cut)

```bash
# Recorder host, once:
node recorder.mjs serve --dir <recorder-dir> --host <LAN address> --port 8787
node recorder.mjs create-run --dir <recorder-dir> --run p7-1 --failure-model POWER-CUT \
  --write-cache "write back" --flush-honoured yes --fua yes --plp unknown --machine "<model, disk>"
# copy <recorder-dir>/keys/p7-1.key to the test machine (mode 0600)
# Test machine, once:
export P7_RUN=p7-1 P7_RECORDER_TARGET=<recorder address>:8787 P7_KEY_FILE_HOST=<path to the key>
docker compose up -d --wait && sudo ./host-evidence.sh p7-1 baseline
docker compose exec -T harness node p7.mjs netcheck && docker compose exec -T harness node p7.mjs init
# Each cycle N:
docker compose exec -T harness node p7.mjs run --cycle N --proc a --workers 2    # bursts: also --proc b in a second shell
node recorder.mjs cut --dir <recorder-dir> --run p7-1 --cycle N --min-seconds 5 --max-seconds 600 \
  [--command-json '["<plug command>", "..."]']                                    # recorder host
# ... power returns, the machine boots, the stack restarts by itself ...
node recorder.mjs confirm-cut --dir <recorder-dir> --run p7-1 --cycle N --power-was-cut yes --evidence "<what was seen>"
sudo ./host-evidence.sh p7-1 cycle-N-after-boot
docker compose exec -T harness node p7.mjs check --cycle N                        # exit 0 PASS, 2 FAIL, 3 INCONCLUSIVE
docker compose exec -T harness node p7.mjs recover --cycle N                      # exit 4: inspect, then pass --clear-digest
```

**On a FAIL or INCONCLUSIVE:** stop. On a FAIL leave the machine powered off, preserve the disk, and report (plan §5).
