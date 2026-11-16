# Milestone 16, P7: durability harness

**Research prototype. Not production code. Not a durability result.** P7 (native Linux durability) remains **NOT APPROVED and NOT TESTED**. This directory contains the harness for the physical power-loss test described in `docs/p7-physical-linux-test-plan.md`. Passing it would validate the journal durability **mechanism** of the prototype only. It would not establish production readiness.

## What it reuses, and what it leaves alone

- **Reused, unchanged:** the Phase 0.5 library in `../m16-phase05/lib/` (`claim`, `appendLocked`, `inspect`, `clear`, the journal and its verifier).
- **Not modified:** the Phase 0.5 files and results, and the Phase 0 branch.
- **Not part of the build:** nothing under `apps/` or `services/` imports this directory.
- **Its own Compose project:** `compose.yml` is `opspilot-m16-p7`.
  - PostgreSQL is on an **internal** network and is reached **directly**: there is no fault proxy. The Phase 0.5 proxy is still available in `../m16-phase05/` for fault injection.
  - The harness container also joins an `egress` network, only to reach the recorder on another host.
  - Nothing is published.
- **PostgreSQL** runs with `fsync=on`, `full_page_writes=on` and `synchronous_commit=on`. `init` and `run` refuse to start unless `SHOW` confirms all three. `wal_sync_method` is recorded, not set.
- **Synthetic data only.** There are no credentials beyond the throwaway local `proto` database user. Dispatch is a synthetic `dispatch` intent record in the journal: **no request is ever sent to any destination**, and there is no webhook receiver.

## Parts

| File | Runs on | Purpose |
|---|---|---|
| `recorder.mjs` | **Another host** (for example the Mac), never on the switched outlet | Stores each acknowledgement with `fsync` **before** replying. Holds the run's failure model (fixed at creation), the storage attestation, the cut times by its own clock, the results, and the stop marker. Also the operator commands `create-run`, `cut`, `confirm-cut` and `status` |
| `p7.mjs` | The machine under test, in the `harness` container | `init` (once; never wipes), `run` (the claim loop), `check` (preserve, compare, classify, report), `recover` (repair a torn tail; clear a journal that is one claim ahead, with an operator-confirmed digest) |
| `host-evidence.sh` | The machine under test, on the host, as root | Records the OS, kernel, virtualisation, mounts, devices, write cache, FUA, SMART, kernel log and PostgreSQL log. Read-only; installs nothing |
| `lib/` | — | Pure logic, tested without a database: `ledger.mjs` (durable and write-once files), `scan.mjs` (bounded-memory journal scan, history fingerprint, N1 repair bytes), `verdict.mjs` (comparison, classification, the consecutive-pass count) |
| `test/` | Anywhere with Node 22+ | `node --test prototype/m16-p7/test/harness.test.mjs`. These are **harness tests**, not durability results |
| `smoke-docker-desktop.sh` | A development machine | End-to-end harness flow with container kills. Its failure model is `HARNESS-SMOKE`, which **can never count** |

## The rules it enforces

- **Acknowledgements.** A claim is acknowledged only after its commit **certainly** succeeded, then its dispatch intent after that record was `fsync`ed.
  - An uncertain commit, quarantine, error or unreachable recorder stops that worker.
  - An ambiguous claim is **never retried or acknowledged**.
- **Each check, before anything is repaired:**
  1. **Preserve:** copy the journal and identity file into the cycle's evidence directory. That directory is created once and never overwritten.
  2. **Compare** against the recorder's acknowledgements:
     - every acknowledged claim must be in the journal **and** committed in the database (`audit` `execute_start` rows, which survive clearance);
     - every committed claim must be in the journal;
     - the journal may be at most one unacknowledged, uncommitted claim ahead;
     - every dispatch intent must belong to a committed claim;
     - the whole history must match. This is a bounded-memory fingerprint, minus any claims an earlier clearance accepted as never committed.
- **Verdicts** fail closed, and FAIL outranks INCONCLUSIVE.
  - **INCONCLUSIVE when:**
    - storage flush behaviour is unverified;
    - a durability setting is off;
    - no cut was recorded, or the cut wasn't confirmed;
    - a worker stopped before the cut;
    - there are no acknowledgements;
    - the run is `HARNESS-SMOKE`.
  - **What counts:** only `POWER-CUT` passes count toward the 20 consecutive passes. A `VM-CRASH` pass never does.
  - **What breaks the run of consecutive passes:** an INCONCLUSIVE cycle resets it, and a FAIL **stops the run**. The recorder then refuses every further start, acknowledgement and recovery.
- **Continuing state.** The database and journal carry over across cycles; nothing is reset. A new batch of synthetic actions is seeded per cycle, because clearance moves the old ones to `PROPOSED`.

## One cycle (physical power cut)

```bash
# Recorder host, once:
node recorder.mjs serve --dir <recorder-dir> --host <LAN address> --port 8787
node recorder.mjs create-run --dir <recorder-dir> --run p7-1 --failure-model POWER-CUT \
  --write-cache "write back" --flush-honoured yes --plp unknown --machine "<model, disk>"
# Test machine, once:
export P7_RECORDER_URL=http://<recorder address>:8787
docker compose up -d --wait && sudo ./host-evidence.sh p7-1 baseline
docker compose exec -T harness node p7.mjs init --run p7-1
# Each cycle N:
docker compose exec -T harness node p7.mjs run --run p7-1 --cycle N --workers 1   # or 4-8 for a burst
node recorder.mjs cut --dir <recorder-dir> --run p7-1 --cycle N --min-seconds 5 --max-seconds 600 \
  [--command-json '["<plug command>", "..."]']                                    # recorder host
# ... power returns, machine boots ...
node recorder.mjs confirm-cut --dir <recorder-dir> --run p7-1 --cycle N --power-was-cut yes
docker compose up -d --wait                                                       # PostgreSQL crash recovery runs here
sudo ./host-evidence.sh p7-1 cycle-N-after-boot                                    # kernel log, PostgreSQL recovery log, devices
docker compose exec -T harness node p7.mjs check --run p7-1 --cycle N             # exit 0 PASS, 2 FAIL, 3 INCONCLUSIVE
docker compose exec -T harness node p7.mjs recover --run p7-1 --cycle N           # prints a digest if clearance is needed
```

**On a FAIL:** stop. Leave the machine powered off, preserve the disk, and report (plan §5). Do not rerun.
