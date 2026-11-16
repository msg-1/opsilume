# Milestone 16, Phase 0: recovery-safety prototype

**Research prototype. Not production code.** It tests the design in [docs/post-restore-remediation-safety-design.md](../../docs/post-restore-remediation-safety-design.md). The findings are in [docs/post-restore-remediation-safety-phase0-prototype-report.md](../../docs/post-restore-remediation-safety-phase0-prototype-report.md).

## Isolation

Nothing here is part of the application:
- **Not a workspace.** It is not in the npm workspaces, and nothing under `apps/` or `services/` imports it.
- **Its own tiny schema** (`org`, `action`, `approval`, `audit`, `installation_state`), in its own database. It does not use the application's Prisma schema, migrations, routes or remediation code.
- **Its own Compose project.** `compose.yml` defines the project `opspilot-m16-proto`, with its own volumes (`opspilot-m16-proto_pgdata`, `opspilot-m16-proto_state`) and an **internal** network: no container can reach outside it, and no port is published to the host.
- **A runtime image reused, unchanged.** `opspilot-isolated-api:latest` (built earlier from this repository) serves only as a Node 22 + Prisma runtime; the application inside it is never started. Prisma is used for raw SQL against the prototype database only.
- **No outside requests.** "Webhooks" go to `receiver.mjs`, a local stand-in on the internal network that only records requests.

Experiment A runs in a one-off container with `--network none`, its own named volume (`opspilot-m16-proto_expa`) and `tmpfs` mounts.

## Running it

```bash
cd prototype/m16-phase0
docker compose -f compose.yml up -d --wait
./run-exp-a.sh                                        # A: append and flush latency, throughput, parse cost, full disk, unavailable storage
./run-exp-b.sh                                        # B: two containers, concurrency, kill, restart, clearance, flock
docker compose -f compose.yml exec -T api1 node exp-c.mjs    # C: torn tail and corruption cases
./run-exp-c-restore.sh                                # C: a real pg_dump / pg_restore of the prototype database
docker compose -f compose.yml exec -T api1 node exp-d.mjs    # D: crash at every lifecycle boundary
./run-exp-e.sh                                        # E: clearance at 1k, 10k and 100k actions
docker compose -f compose.yml down -v && docker volume rm opspilot-m16-proto_expa   # remove everything
```

Results are written to `results/`. The files named `*-before-*-fix.json` are the runs that exposed two defects in the prototype, kept as evidence.

## Files

| File | What it is |
|---|---|
| `lib/journal.mjs` | The journal: hash-chained records, parse and verification rules, torn-tail repair, the trust comparison |
| `lib/proto.mjs` | The prototype schema, provisioning, claim (lock first, savepoint, void), dispatch, outcome, sweep, reconcile, inspect, clear, crash points |
| `lib/fixtures.mjs` | Fresh state, synthetic data, statistics |
| `receiver.mjs` | The local stand-in receiver |
| `exp-*.mjs`, `run-*.sh` | The experiments |
| `probe-prisma-lock.mjs` | Shows that a failed statement releases a transaction's locks, and that a savepoint keeps them |
| `smoke.mjs` | One end-to-end execution |
