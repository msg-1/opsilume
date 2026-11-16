# Milestone 16, Phase 0.5: validation prototype

**Research prototype. Not production code.** It validates the revised design ([docs/post-restore-remediation-safety-design.md](../../docs/post-restore-remediation-safety-design.md), P4 to P7 and the no-downgrade policy). The results are in [docs/post-restore-remediation-safety-phase05-validation-report.md](../../docs/post-restore-remediation-safety-phase05-validation-report.md).

The Phase 0 prototype stays, unchanged, on the branch `prototype/m16-recovery-safety-phase0`. Nothing was copied from it: this directory was written fresh.

## Isolation

- **Not part of the build:** outside the npm workspaces; nothing under `apps/` or `services/` imports it.
- **Its own Compose project:** `compose.yml` defines `opspilot-m16-p05`, with an **internal** network, its own volumes (`pgdata`, `state`) and no published host ports.
- **A runtime image reused, unchanged:** `opspilot-isolated-api:latest` serves only as a Node 22 + Prisma 6.19.3 runtime. The database is `postgres:16-alpine`.
- **Fault injection:** `proxy.mjs` sits between the prototype and PostgreSQL, reads the PostgreSQL wire protocol, and cuts connections at `COMMIT` on command.
- **No outside requests:** `receiver.mjs` is a local stand-in that only records requests.

## Running it

```bash
cd prototype/m16-phase05
docker compose -f compose.yml up -d --wait
docker compose -f compose.yml exec -T api1 node exp-p5.mjs               # P5: unknown commit result (fault proxy)
docker compose -f compose.yml exec -T api1 node exp-p4.mjs correctness   # P4: incremental verification cases
docker compose -f compose.yml exec -T api1 node exp-p4.mjs concurrent-reader
docker compose -f compose.yml exec -T api1 node exp-p4.mjs perf 1000000  # also 100000, 500000; verify-mem <n>
./run-p6-scale.sh && ./run-p6-failures.sh                                # P6: clearance at scale, failures
docker compose -f compose.yml exec -T api1 node exp-downgrade.mjs        # no-downgrade policy
docker compose -f compose.yml down -v                                    # remove everything
```

The two-container P4 run and the P7 kill tests are described in the report. `results/p4-correctness-before-rehash-fix.json` is the run that exposed a defect in this prototype's verifier, kept as evidence.
