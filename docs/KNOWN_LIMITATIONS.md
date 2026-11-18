# Known limitations

**Last updated:** 18 November 2026. Nothing is removed from this list because it is inconvenient. An item leaves only when it is fixed, and its evidence is recorded.

## Product and validation

| Limitation | Kind | Detail |
|---|---|---|
| Not deployed; nothing run outside a laptop and CI | Infrastructure | No pilot host, no public URL ([PROJECT_STATUS.md](PROJECT_STATUS.md), section 10) |
| Not validated for production | Unverified | No production hardening, scale test or operational history |
| No customers, SLA or compliance certification | Scope | None exist |
| GitHub integration not run against github.com | Unverified | Tested against a local stub and real webhook signatures only ([github-validation.md](github-validation.md)) |
| MCP server not connected to a real MCP client | Unverified | Tested in-process |
| Model-driven analysis validated on one live run only | Unverified | `claude-haiku-5-5`, one investigation ([claude-live-verification.md](claude-live-verification.md)). Open from it: the healthy-service scenario's confidence (0.30 against a bound of 0.25); `run_runbook` treated as read-only although a runbook can change production |
| No external security review or penetration test | Security | Internal audit only ([engineering-audit.md](engineering-audit.md)) |
| Dependency scanning covers shipped Node packages only | Security | No Python, container or static analysis scanning in CI ([git-workflow.md](git-workflow.md)) |
| Aggregating views are linear in the size of their time window | Technical debt | Log patterns, dashboard trend, integration coverage; pre-aggregation not attempted |
| Logs and metrics are stored in PostgreSQL | Technical debt | Adequate locally; a dedicated store is the scaling path ([database-design.md](database-design.md)) |
| Post-restore remediation safety is a design and prototypes, not product code | In progress | Milestone 16 ([post-restore-remediation-safety-design.md](post-restore-remediation-safety-design.md)). The product's restore path does not yet carry these safeguards ([recovery-readiness-audit.md](recovery-readiness-audit.md)) |
| The OPSILUME name is not trademark-cleared | Accepted risk | Working name ([branding/opsilume-branding.md](branding/opsilume-branding.md)) |
| Open Medium and Low findings | Known bugs | Listed in [engineering-audit.md](engineering-audit.md) |
| Not safe to expose publicly as it is | Security | The seed gives every demo user, including OWNER and ADMIN, the documented password `OpsPilot-demo-1`. Self-registration is open. Admins can configure outbound webhooks. Internal services are published on loopback in `docker-compose.yml`. A public demo mode is required first ([deployment/ORACLE_FREE_TIER_FEASIBILITY.md](deployment/ORACLE_FREE_TIER_FEASIBILITY.md), sections 9 and 11) |
| Free hosting is conditional | Infrastructure | Oracle Always Free A1 is now 2 OCPUs and 12 GB (official pages conflict). Capacity in Indian regions is uncertain. Idle instances can be reclaimed and inactive accounts suspended, with no support. Upgrading the account makes charges possible (same audit, sections 3 and 10) |

## P7 durability harness (`prototype/m16-p7/`)

**P7 is NOT TESTED AND NOT PASSED.** The details are in [m16-p7-second-safety-review.md](m16-p7-second-safety-review.md) (sections 11 to 14.3) and the harness [README](../prototype/m16-p7/README.md).

| Limitation | Kind | Detail |
|---|---|---|
| No native Linux run | Unverified | No native Linux host has been available |
| No physical 20-cycle power-cut series | Unverified | Needs hardware and owner authorisation |
| The final source has not passed a container smoke | Unverified | The final smoke was blocked by Docker address-pool exhaustion. Smoke 7, the last that ran, predates the post-result contradiction work |
| Firewall script not run on Linux (F20) | Unverified | Stub suite only |
| Smoke teardown never run against real Docker (F12) | Unverified | Stub suite only |
| SIGPIPE behaviour on Linux unverified | Unverified | The recorder no longer handles SIGPIPE; its effect on Linux sockets is not checked |
| Total recorder-storage failure | Accepted risk (owner, 18 November 2026) | A contradiction held only in memory is lost if the recorder can write nothing on its own disk and is then ended by SIGKILL, a crash or power loss. Post-result contradiction handling is not restart-safe in that case |
| Recorder disk replaced or remounted while the recorder runs | Unsupported (owner, 18 November 2026) | The recorder assumes its storage identity is stable while it runs. Where it detects an inconsistency it keeps what it holds |
| Cloned recorder directory | Unsupported | A copy carries the same identity and cannot be told apart from the original |
| Recorder started on an empty directory with `--new-directory` | Unsupported | It knows no run keys and cannot authenticate reports |
| Ledgers have no integrity protection | Accepted risk | No hash chain or second copy. Someone who can edit the recorder directory can remove records unnoticed; the recorder host is trusted |
| A paused recorder host stops both clocks | Accepted risk | Silent-stop detection needs the wall clock and the monotonic clock to agree; both stand still while the host is paused |
| VM-CRASH runs have no journal identity check | Limitation | They have no readiness record to bind it |
| A storage fault while a report arrives ends the run's physical series | Fail-closed by design | Such a report counts against every decided cycle (`'*'`) |
| A recorder restart during an open cycle makes it INCONCLUSIVE | Accepted (owner) | It ends a POWER-CUT series |
| Requests that consistently name another cycle are not counted against the open one | Design choice | Pinned by tests |

## Accepted risks recorded elsewhere

The product-owner decisions on Milestone 16 (V1 to V3, P1 to P8, P8a, backup retention, the tested envelope of 1,000,000 actions) are in [post-restore-remediation-safety-decision-review.md](post-restore-remediation-safety-decision-review.md) and [post-restore-remediation-safety-design.md](post-restore-remediation-safety-design.md).
