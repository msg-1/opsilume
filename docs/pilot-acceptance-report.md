# Pilot acceptance report

Milestone 9, 15 November 2026; updated after Milestone 10 the same day for model-backed investigations, spend and security scanning. What has been verified about OPSILUME before an external team is asked to try it, how it was verified, what has not been, and what stands in the way. The audit record of the live model evaluation is [milestone-10-final-validation-report.md](milestone-10-final-validation-report.md).

**This report does not say OPSILUME is ready for production or for enterprise use.** No external team has used it. Nothing here shows that it shortens incidents. A model has been run against the current code only on 14 synthetic scenarios (Milestone 10), so there is no validated accuracy of AI analysis on customer data or on real incidents. Every measurement comes from one laptop and is not a throughput figure for production. There has been no external security review or certification. There is one process of each component on one machine: no high availability and no disaster recovery.

What it does say: for each area, which claims rest on which kind of evidence, so that whoever decides on a controlled pilot knows what they are relying on.

## How to read it

Every claim carries one of these labels. They are not grades of confidence; they say what was done.

| Label | Meaning |
|---|---|
| **Implemented** | The code exists. Nothing more is claimed |
| **Automated** | An automated test makes it happen and checks the result, in CI on every pull request. The test is named |
| **Local** | Run on real containers on the development machine (the isolated stack, the failure drills, the load test, the demo). Repeatable with the command named; true of that machine |
| **External** | Checked against the real outside system, or by someone outside the project |
| **Not tested** | Exactly that, however reasonable the code looks |
| **Limitation** | Known, and staying for the pilot. The customer should be told |
| **Blocker** | Must be resolved, or explicitly excluded from the pilot, before anyone outside is invited |

**Nothing in this report carries the label External.** That is the single most important fact in it.

Suites, as of `develop` at `8be2789` (CI): API 213 integration tests; AI service 276 tests and 14 evaluation scenarios; web 53; browser journeys 12; failure drills 11; backup drill 9 steps. All run with the rule-based engine or a mocked model; none calls a model. The one live model evaluation (Milestone 10) is in section 6.

## 1. Architecture and deployment topology

A modular monolith with one companion service, started by Docker Compose on one machine.

| Component | Role | State |
|---|---|---|
| Web (Next.js) | Interface; proxies `/api/*` to the API | Stateless |
| API (Express, Prisma) | System of record, authentication, ingestion, approvals | Stateless |
| Worker (BullMQ) | Runs investigations and scheduled jobs | Stateless; an interrupted run is recorded as interrupted |
| Analysis service (FastAPI) | Rule-based engine, or a model if the operator configures one. Reads data only through the API's read-only tool endpoints, with a short-lived token | Stateless |
| PostgreSQL 16 with pgvector | All durable data | **The state** |
| Redis 7 | Job queue, append-only file on a volume | Rebuildable from PostgreSQL |

| Claim | Label | Evidence |
|---|---|---|
| The stack starts from nothing and serves the browser journeys | Automated | `e2e.yml`: isolated stack built and started, 12 Playwright journeys |
| Images build; migrations apply to an empty database | Automated | `ci.yml` build job; database job |
| An investigation runs at most once and reaches exactly one end, through a killed worker, a lost Redis, a PostgreSQL outage and an unavailable analysis service | Automated, Local | `reliability.test.ts`, `outage.test.ts`; `npm run drills` (11 drills on real containers, in CI) |
| Readiness endpoints reflect PostgreSQL and Redis; shutdown is graceful | Automated, Local | `outage.test.ts`, `reliability.test.ts`, drills |
| More than one API or worker process | Not tested | Nothing is known to prevent it; nothing shows it works |
| Any host other than Docker Desktop on macOS and the GitHub Actions runner | Not tested | |
| TLS, reverse proxy, secrets management, host hardening | Not tested | Left to the operator; described in [customer-pilot-guide.md](customer-pilot-guide.md) |
| Single machine, single process of each component, no replica, no failover | Limitation | A restart interrupts running investigations; loss of the machine is loss of service until it is restored from backup |
| Upgrade of an installation holding data, from one version to the next | Not tested | Migrations are tested from empty, and against the seeded test database, not against an aged installation |

## 2. Supported integrations

| Integration | Label | What the evidence is |
|---|---|---|
| Logs, metrics, deployments, service events: four push endpoints with scoped API keys | Automated, Local | `integrations.test.ts`, `idempotency.test.ts`, `log-queries.test.ts`; load test (section 9); the demo's three instrumented services |
| Any vendor's log shipper or metrics agent | Not tested, Limitation | None is provided. The sender posts JSON; the customer writes or configures a forwarder |
| GitHub: commits and pull requests by token, optional signed webhook | Automated against a local stand-in only | `github.test.ts`, `integrations.test.ts`, `intelligence.test.ts` |
| GitHub against github.com | **Not tested. Blocker** if code changes are part of the pilot | No test credential was supplied in Milestone 8 or 9, and credentials present on the machine were deliberately not used. Procedure: [github-validation.md](github-validation.md), ten minutes, read-only |
| Remediation webhook: approved actions, signed, to an endpoint the customer runs | Automated | `safety.test.ts`, `netguard.test.ts`, with local receivers |
| A real receiver in a customer network | Not tested | |
| Distributed traces from a Jaeger-compatible query API, one per installation | Automated, Local | Stand-in in tests; a local Jaeger in the demo |
| Other trace stores; a trace store per organisation | Not tested, Limitation | |
| Integration status shown from what actually arrived, not from what was saved | Automated | `integrations.test.ts` |
| MCP server (read-only tools) | Automated in-process | Not tested with a real MCP client |
| Analysis by a language model | Implemented; **Not tested on the current code** | Section 6 |

Not supported at all: pulling from log or metric vendors, paging tools, chat or e-mail delivery, GitLab or Bitbucket, single sign-on, GitHub Enterprise Server.

## 3. Authentication and tenant isolation

| Claim | Label | Evidence |
|---|---|---|
| Passwords hashed; sign-in does not reveal which part was wrong; accounts lock after repeated failures even when the client forges its address | Automated | `auth.test.ts`, `hardening.test.ts` |
| Refresh tokens rotate; a replayed one revokes the whole session family; access tokens die when the session ends | Automated | `auth.test.ts`, `hardening.test.ts` |
| Cookie-authenticated writes from another origin are refused | Automated | `hardening.test.ts` |
| Four roles; every route guarded by a named permission; last owner cannot be removed | Automated | `auth.test.ts` |
| API keys are limited to their scopes, stored as hashes, shown once | Automated | `auth.test.ts` |
| Every query is limited to the caller's organisation; references to another organisation's records are refused | Automated | `auth.test.ts`, and cross-organisation cases in `integrations.test.ts`, `idempotency.test.ts`, `log-queries.test.ts`, `safety.test.ts`, `historical-health.test.ts` |
| Removing one organisation leaves every other unchanged | Automated | `remove-organization.test.ts` |
| Isolation holds at the database level (row-level security) | **Not implemented.** Limitation | Isolation is enforced in application code only. A query that forgets the filter would not be stopped by the database |
| A systematic audit that every route and raw query carries the filter | Not tested | The tests cover the routes they exercise; there is no static check and no outside review |
| Single sign-on, SCIM, multi-factor authentication, password reset by e-mail | Not implemented. Limitation | |
| Rate limiting: 1,200 requests a minute per client address | Automated; Limitation | Not per key or organisation: senders behind one address share it |

## 4. Outbound request security

| Claim | Label | Evidence |
|---|---|---|
| Requests to tenant-supplied addresses are checked in the lookup the connection itself uses, so the check cannot be answered differently from the connection (DNS rebinding) | Automated | `netguard.test.ts`: real connections, DNS played by a resolver the test controls |
| Refused: internal, loopback, link-local, metadata, IPv4-mapped, NAT64, 6to4 and Teredo answers; numeric address tricks; non-HTTP schemes; credentials in URLs; a name with one internal address among public ones | Automated | same |
| Redirects are not followed; only the status is read; a mismatched certificate fails the request | Automated | same |
| A refused destination means nothing was sent, and the action is recorded as not applied | Automated | same, through the application |
| GitHub requests go to a fixed host; redirects only within it, three at most | Automated | `github.test.ts` |
| The defect closed in Milestone 8 was exploited end to end before the fix | Not tested | It was a design gap, closed by construction |
| Egress filtering at the network level | Not implemented. Limitation | The application check is the only control; the operator's firewall should be the second |
| External penetration test | Not tested | |

## 5. Idempotency guarantees

With an `Idempotency-Key` header, the key is recorded in the same transaction as the data: a batch is stored if and only if its key is remembered.

| Guarantee | Label | Evidence |
|---|---|---|
| A repeat with the same key and body stores nothing and gets the first answer, on all four ingestion endpoints | Automated | `idempotency.test.ts` |
| 48 identical requests at the same moment store one batch | Automated | same, with more requests than pooled connections |
| The same key with a different body is refused and stores nothing | Automated | same, sequentially and concurrently |
| A failed request records no key | Automated | same |
| Keys are separate per organisation and endpoint; forgotten after 24 hours | Automated | same |
| A key survives a restore from backup | Local, in CI | Backup drill |
| 200 concurrent duplicates under load: 1,000 lines stored of 1,000 expected, 180 replays | Local | Load test, section 9 |
| Nothing is deduplicated without a key | Automated; Limitation by design | Two identical batches without a key are two batches. A client that sends a new key on each retry stores the batch each time |
| Investigations: at most one run per investigation | Automated, Local | `reliability.test.ts`, drills |
| Remediation: one dispatch per approved execution, with an idempotency key the receiver can use | Automated | `safety.test.ts` |
| The receiver honours that key | Not tested | It is the customer's endpoint |

## 6. Investigation quality and limitations

Detail: [ai-validation.md](ai-validation.md).

| Claim | Label | Evidence |
|---|---|---|
| The rule-based engine reaches the expected outcome, cause and service on 14 synthetic scenarios, three of them about past incidents | Automated | `npm run evals -- --heuristic`, in CI |
| Every report the rule-based engine writes is pinned | Automated | `test_heuristics_golden.py` |
| Every reference in a report resolves to evidence that was gathered; invented references, versions and figures are removed or flagged | Automated | `test_validation_matrix.py`, `test_agent.py`, `test_reliability.py`; a second, independent pass in the API |
| The outcome (healthy, degraded, incident, undetermined) is computed from evidence, never authored | Automated | `test_model_responses.py`, evaluations |
| Health of a past window comes from the record of that window; "nothing on record" is not read as healthy | Automated | `test_historical_health.py`, `historical-health.test.ts` |
| Evidence that could not be read is named in the report and limits confidence | Automated | `test_validation_matrix.py` |
| Control characters and credential-like strings are removed from report text | Automated | `test_validation_matrix.py` (added in Milestone 9) |
| With no model, an unusable answer, a timeout or exhausted credit, the rule-based engine writes the report and it is labelled as rule-based | Automated | `test_model_responses.py`, `test_claude_provider.py` |
| Ten failure scenarios on real telemetry from three instrumented services | Local | `npm run demo:e2e`, rule-based engine; the recorded run is in `demo/README.md`. Not in CI and not re-run in this milestone |
| **A language model with the current report format, tools and guardrails** | **Local, synthetic only; acceptance criteria not all met** | Milestone 10, `claude-haiku-5-5`: **13 of 14** on the first live run; 14 of 14 when its saved output is rescored with the PR #28 guardrails (post-processing, not a live result); **1 of 1** on the single live repeat of the failed scenario. Two healthy-state scenarios passed only because the guardrails corrected the model. One figure in a stated fact is flagged unsupported, which question 6 of [ai-validation.md](ai-validation.md) does not allow. $0.108031 spent of $0.87 approved. Not tested: real incidents, other models, a provider failure mid-run |
| Usefulness of a report to an engineer who did not build the product | Not tested | No such engineer has read one |
| Accuracy on real incidents | Not tested | Every scenario is synthetic and small |
| The rule-based engine recognises only the patterns it has rules for | Limitation | Outside them it reports what it found and says the cause is undetermined |
| Past health is reconstructed from alerts, incidents and metrics | Limitation | A problem nobody alerted on is invisible in retrospect |
| With a model configured, evidence leaves the installation for the provider | Limitation | Logs are redacted by pattern, which is a filter and not a guarantee |

## 7. Remediation safety

| Claim | Label | Evidence |
|---|---|---|
| The analysis has read-only tools only; its token is valid only under the tool endpoints | Automated | `test_validation_matrix.py`, `safety.test.ts`, `hardening.test.ts` |
| A recommended action is a proposal; nothing in the analysis service can execute one | Automated | `test_validation_matrix.py` |
| A production change cannot run without approval by a signed-in person other than the proposer, two for the highest risk; never by an API key or the analysis token | Automated | `safety.test.ts` |
| Approval is bound to the action's content; an edit supersedes approvals; approvals are counted again at execution | Automated | `safety.test.ts` |
| The proposer cannot understate risk; an unclear action is treated as state-changing; both services agree on what each kind of action does | Automated | `safety.test.ts`, `hardening.test.ts`, shared fixtures |
| An action the evidence does not support is withdrawn, not relabelled | Automated | Evaluations (`remediation` criterion), `test_rules.py` |
| One dispatch when execution is requested twice at once | Automated | `safety.test.ts` |
| A timeout or server error from the receiver is recorded as unknown and not retried until a person confirms nothing was applied | Automated | `safety.test.ts` |
| Every approval and execution is in the audit log, without secrets | Automated | `safety.test.ts`, `auth.test.ts` |
| What the customer's receiver does with an action | Not tested. Limitation | OPSILUME sends a signed request and records the answer. It cannot verify the change, and it cannot undo it |
| Behaviour of a model when proposing actions on the current code | Not tested | Section 6. The guardrails apply whatever proposes |

## 8. Backup and restore

Procedure and operator instructions: [backup-and-restore.md](backup-and-restore.md).

| Claim | Label | Evidence |
|---|---|---|
| A `pg_dump` of the running database restores completely: 37 tables and 611,104 rows identical in count, 100 indexes including the vector index, 3 extensions, migration history, 55 foreign keys with no orphan, identical content digests of seven tables | Local, in CI | `npm run drill:backup`, 15 November 2026: 9 steps passed in 59 s; dump 12.3 s (12 MB), restore 5.0 s |
| The application runs on the restored copy: accounts sign in, earlier records, an API key and an idempotency key are intact, a new investigation completes and does not appear in the source | Local, in CI | same |
| `npm run backup -- create` names a file a backup only after it has been read back (and, on request, restored and compared); records its checksum | Local, in CI | same |
| A truncated file, an altered file and a non-backup are each refused by `verify` | Local, in CI | same |
| Rotation removes only the tool's own oldest backups; files it did not make are untouched | Local, in CI | same |
| A failed backup exits non-zero, writes nothing, leaves earlier backups alone, and `status` reports it until the next good one; a stale backup is reported | Local, in CI | same |
| Scheduled backups | **Not implemented.** Limitation | Cron and timer examples are documented; none was installed or run. Without the operator's scheduler there are no backups |
| Copies off the machine; encryption of backup files | Not implemented. Limitation | The operator's responsibility |
| Restore on another machine or PostgreSQL major version; a database beyond about 600,000 rows; restore under load; a full backup disk | Not tested | |
| Loss of the encryption key | Not tested. Limitation | Stored integration credentials would have to be entered again. The key is not in the backup and must be kept separately |
| Point-in-time recovery, replication, disaster recovery | **Not implemented** | Recovery means restoring the last backup; everything after it is lost |

## 9. Performance benchmarks

Detail: [performance-investigation.md](performance-investigation.md). These are measurements of one small configuration on one laptop, with the load generator on the same machine. They are not a capacity statement and not a production throughput figure.

**Environment.** Apple M4, 10 cores, 24 GB RAM, macOS. Docker Desktop 29.2 with 10 CPUs and 7.7 GB for containers. PostgreSQL 16.15, default settings. One API process, one worker, one analysis service, rule-based engine. Another copy of the application was running on the machine.

**The Milestone 8 finding (read p95 of 2.2 to 2.4 s during ingestion) was investigated.** It was an artefact of the load generator, which blocked itself for two seconds at a time and counted the wait as server latency; the API's own histogram showed almost no request over one second. The generator was corrected. Three real inefficiencies in log queries were then found from their query plans and fixed.

Before and after the query fixes, same data (about 800,000 log lines), same fixed request rate, two runs each:

| Reads during ingestion | Before | After |
|---|---|---|
| All reads, p50 | 143 / 123 ms | 38 / 45 ms |
| All reads, p95 | 512 / 652 ms | 374 / 277 ms |
| All reads, p99 | 733 / 1,325 ms | 669 / 818 ms |
| Log list, p50 | 147 / 128 ms | 10 / 14 ms |
| Log text search, p50 | 443 / 383 ms | 41 / 36 ms |
| Log patterns, p50 | 354 / 339 ms | 296 / 243 ms |
| Ingestion throughput | about 24,400 lines/s | about 24,800 lines/s |
| Errors | 0 | 0 |

`npm run loadtest` with the corrected generator, from an empty log table:

| Workload | Result |
|---|---|
| Logs: 8 clients, 400 requests of 1,000 lines | 400,000 stored in 5.4 s. Request p50 100 ms, p95 149 ms |
| Metrics: 8 clients, 320 requests of 500 samples | 160,000 stored in 1.2 s |
| Duplicates: 200 requests at once under 20 keys | 1,000 lines stored of 1,000 expected; 180 replays |
| Reads while writing: 4 clients, 120 requests | p50 23 ms, p95 185 ms, p99 229 ms, max 274 ms |
| Investigations: 40, three at a time, rule-based | All completed in 7.8 s |
| Peak database connections | 28 of 100, 15 active |

| Claim | Label |
|---|---|
| Nothing sent was lost or stored twice at these volumes; the load test fails if it is | Local; a reduced run (`--smoke`) in CI |
| The read-latency figures above | Local |
| Query results unchanged by the fixes | Automated (`log-queries.test.ts`) |
| Aggregating views (log patterns, dashboard trend, integration coverage) read every line in their window; their tail latency was not improved | Limitation. The remedy is pre-aggregation, which was not attempted |
| The log list reports "more than 10,000" instead of an exact count for large result sets | Limitation, by design |
| More than one organisation at a time; runs longer than minutes; tens of millions of rows; memory over days; the web application's own performance; investigations with a model (tens of seconds each, and paid) | Not tested |
| The customer's expected volume on the pilot machine | Not tested. Repeat `npm run loadtest` there |

## 10. Operational requirements

What an operator must provide. None of it was exercised outside the development machine.

| Requirement | Label |
|---|---|
| A host with Docker Compose. At the volumes above the API, worker, database, queue and analysis service together peaked at about 1.3 GB of memory | Local |
| TLS in front of the web application; the database and Redis not published | Not tested (operator) |
| Real values for `JWT_SECRET`, `ENCRYPTION_KEY`, `INTERNAL_SERVICE_TOKEN` and the database password, kept outside the backup; `SEED_DEMO_DATA=false` | Implemented: start-up refuses known-weak values (`config.test.ts`, Automated) |
| Scheduled backups, a daily check that one exists (`backup status`), a copy elsewhere, and one restore on the pilot machine before data matters | Tooling Local; the schedule itself Not tested |
| Monitoring: `/health`, `/ready` and `/metrics` on the API and worker; Prometheus and Grafana configurations are provided | Implemented; alert rules Not implemented |
| A named person who watches the installation. There is no service-level agreement and no on-call | Limitation |
| Log and metric retention per organisation, applied hourly | Automated (`operations.test.ts`). Not tested: deleting at volume, and the space it gives back. Incidents, investigations, evidence and the audit log are kept indefinitely (Limitation) |
| Upgrades: apply migrations with `npm run db:migrate`, after a backup | Not tested on an aged installation |
| Removing a customer's data at the end of a pilot | Automated (`npm run org:remove`, `remove-organization.test.ts`) |
| With a model: the operator's own provider key, spending limits per investigation and per day | Automated against a mocked provider; Not tested live on current code |

## 11. Security review status

| Item | Label |
|---|---|
| Internal review of outbound requests (Milestone 8), ingestion and tenancy paths, by the author | Done; found and fixed one design defect (DNS rebinding) three milestones after it was written |
| Review by anyone other than the author | **Not done** |
| External penetration test, audit or certification of any kind | **Not done** |
| Dependency advisories: `npm audit` on shipped Node dependencies, high and critical, on every pull request | Automated |
| Python dependency audit (`pip-audit`) and container image scanning (Trivy, report only) | Configured in `.github/workflows/security.yml`, not a required check. First execution in CI: see the pull request that added it. Static analysis: not in place |
| Secret scanning and push protection on the repository | Enabled (GitHub setting, read on 15 November 2026) |
| Dependabot | Version updates configured (`.github/dependabot.yml`); they take effect once the file is on `develop`. Alerts and automatic security updates are repository settings and are **not enabled** |
| Shipped Node dependencies | `npm audit --omit=dev`: 5 moderate advisories, no high or critical. They come from one chain under the OpenTelemetry GCP resource detector (`gcp-metadata` → `gaxios` 7.1.3 → `rimraf` → `glob` → `minimatch`); see `docs/git-workflow.md`. Not reachable as installed. The fix needs an override, which is an owner decision |
| Credentials encrypted at rest (AES-256-GCM) or stored as hashes; never returned by the API | Automated |
| Audit log of mutating actions | Automated |
| Spans and logs scrubbed of content, credentials and personal identifiers | Automated (shared fixtures in both services) |
| Threat model document | Not written |

## 12. Outstanding pilot blockers

A blocker is resolved either by doing it or by taking the thing out of the pilot and saying so to the customer.

| # | Blocker | Resolved by |
|---|---|---|
| 1 | **Engine not decided.** The live model evaluation ran (Milestone 10) and does not meet all of its pre-set acceptance criteria: question 6 is not met as written, and question 4 needed guardrail repair in two scenarios | Pilot on the rule-based engine and say so. Or review the five flagged figures and the guardrail-assisted passes, decide whether they are acceptable, and if a further run is wanted, approve it under a new ledger; this one's repeat is used |
| 2 | **GitHub never tested against github.com** | The ten-minute read-only procedure in [github-validation.md](github-validation.md) with a dedicated token and repository; or exclude GitHub from the pilot |
| 3 | **No pilot host exists.** Nothing has run outside a laptop and CI | Provision one; TLS; real secrets; scheduled backup with `status` check; one restore there; `npm run loadtest` there |
| 4 | **No review by a second person** of authentication, tenancy and outbound requests | Someone other than the author reads those paths. An external test is better and is a cost decision |
| 5 | **Data agreement.** What the customer sends, where it is kept, when it is removed, and whether evidence may go to a model provider | A written agreement before the first byte |
| 6 | **The product name is not cleared** | A trademark check, or pilot under a working name stated as such |

Not blockers, but the customer should hear them: single machine with no failover; push-only ingestion that needs a forwarder on their side; no single sign-on; aggregating views slow down with volume; isolation enforced in application code only.

## Readiness by area

"Ready for a controlled pilot" means: with a named operator, a small agreed data set, and the limitations stated to the customer. It never means production.

| Area | Classification | Why |
|---|---|---|
| Architecture and deployment | Ready with limitations | Proven on one laptop and in CI only; single machine; no pilot host yet |
| Telemetry ingestion | Ready with limitations | Verified and measured locally; needs a forwarder on the customer's side |
| GitHub integration | **Not validated** | Local stand-in only |
| Remediation webhook | Ready with limitations | Our side verified; no real receiver |
| Authentication and tenant isolation | Ready with limitations | Extensively tested; application-level only; unreviewed by a second person |
| Outbound request security | Ready for a controlled pilot | Tested with real connections; no external test |
| Idempotency | Ready for a controlled pilot | Tested including under concurrency |
| Investigations, rule-based | Ready with limitations | Verified on synthetic scenarios; usefulness to real engineers unknown |
| Investigations, with a model | **Not validated** for a pilot | Evaluated on 14 synthetic scenarios (13 of 14 live, 1 of 1 on the repeat); the acceptance criteria set in advance are not all met. Not run on any customer's data |
| Remediation safety | Ready for a controlled pilot | Human approval enforced and tested; the receiver's behaviour is the customer's |
| Backup and restore | Ready with limitations | Drilled locally and in CI; scheduling and off-site copies are the operator's; no point-in-time recovery |
| Performance | Ready with limitations | Adequate at the measured volumes on one laptop; aggregating views unresolved; no figure for the customer's volume |
| Operations | **Blocked** | No pilot host, operator or schedule exists yet |
| Security review | **Not validated** | Internal only |

What a pilot would then establish, and nothing before it can: whether the reports are useful to engineers who did not build the product, on incidents nobody scripted.
