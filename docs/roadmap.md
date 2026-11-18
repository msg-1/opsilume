# Roadmap

The plan from here is in the first part, updated 18 November 2026. The milestone history below it was recorded as of 14 November 2026; "Verified" there means exercised by automated tests or by running the stack. The current status of everything is in [PROJECT_STATUS.md](PROJECT_STATUS.md).

## Direction

OPSILUME's immediate goal is a **portfolio-ready public prototype**: a working application at a public URL, with controlled demonstration data, a polished experience and an honest technical record. Enterprise or commercial functionality is not a goal. Items below are plans, not commitments; anything marked *idea* is not a requirement.

### 1. Completed milestones

See [PROJECT_STATUS.md](PROJECT_STATUS.md), section 3, and the history below. In short: the M1 to M16 build plan, improvement Milestones 3 to 10, the remediation integrity work, the Milestone 15 recovery audit, and Milestone 16's design, its Phase 0 and 0.5 prototypes, and the P7 harness (implemented; P7 NOT TESTED).

### 2. Immediate next steps

| Item | Objective | Why it matters | Dependencies | Acceptance criteria | Priority | Status |
|---|---|---|---|---|---|---|
| P7 container smoke | Run the final P7 source in containers once | The final source has not been exercised in containers | Docker address space: owner approval to remove stopped scratch resources, or explicit subnets in the scratch override | One smoke on a new isolated project passes against a recorded source-tree hash | High | BLOCKED |
| Merge the P7 branch | Bring `prototype/m16-p7-durability-harness` into `develop` | Keeps the record and harness on the integration branch | Owner review; CI green | Pull request merged with `--no-ff`; no product code changed | Medium | NOT STARTED |
| Release 0.1.0 | Promote `release/0.1.0` to `main` | `main` holds only the initial commit | Owner review | `main` tagged 0.1.0, back-merged into `develop` | Medium | BLOCKED (owner approval) |

### 3. Portfolio-readiness milestones

| Item | Objective | Why it matters | Dependencies | Acceptance criteria | Priority | Status |
|---|---|---|---|---|---|---|
| Hosting feasibility | Confirm Oracle Cloud Always Free can run the stack | The deployment target must cost nothing per month | An Oracle account (owner); a resource check against the stack's memory and CPU | A written check: shape, memory, disk, network limits against measured usage; a go/no-go decision | High | NOT STARTED |
| Public demo mode | A safe, resettable public instance | Visitors must not be able to change anything that matters or spend money | Hosting feasibility | Rule-based engine only (no paid AI); seeded fictional data; no outbound remediation webhooks; scheduled reset; sign-in for visitors or read-only access | High | NOT STARTED |
| Public deployment | The demo at a public URL | The core portfolio deliverable | Public demo mode | HTTPS URL reachable; health checks green; documented deploy and rollback; zero monthly cost | High | NOT STARTED |
| Presentation | README with screenshots, an architecture diagram and the demo link; a short walkthrough video | Lets a reviewer understand the product in minutes | Public deployment | README updated; video recorded and linked | Medium | NOT STARTED |
| Case study | A technical case study and interview notes | Explains the decisions and trade-offs the owner can defend | The above | Written, linked from the README, consistent with [decisions.md](decisions.md) | Medium | NOT STARTED |

### 4. Future technical improvements

| Item | Objective | Why it matters | Dependencies | Acceptance criteria | Priority | Status |
|---|---|---|---|---|---|---|
| P7 physical qualification | Native Linux plus the 20-cycle power-cut series | The only evidence that would support a durability claim | Native Linux machine, separate recorder host, controllable power cut, owner authorisation | All criteria of the P7 plan met and independently reviewed | Low for the portfolio; High before any durability claim | NOT STARTED |
| Post-restore remediation safety in the product | Bring the Milestone 16 design into the API | Closes critical finding C1 of the recovery audit | P7 outcome; implementation and security review | Implemented, tested, reviewed | Medium | NOT STARTED |
| GitHub validation | Run the client against github.com | M5 is unverified externally | A read-only token | [github-validation.md](github-validation.md) procedure passes | Medium | BLOCKED (token) |
| Model evaluation | Repeat runs and more scenarios with a model | One live run is not a measurement | An approved budget | [ai-validation.md](ai-validation.md) plan executed within its ceiling | Low | BLOCKED (budget) |
| Live updates | Server-sent events instead of polling | Responsiveness | None | UI updates without polling | Low | NOT STARTED |
| Scaling | Partition `LogEntry` by time; pre-aggregate views | Linear-time views | Load measurements | Measured improvement | Low | NOT STARTED |
| Security tooling | Python and container scanning in CI | Only `npm audit` runs | None | Checks added and passing | Low | NOT STARTED |

### 5. Long-term product possibilities (*ideas*, not requirements)

- Notifications by email or chat.
- More telemetry sources, and a dedicated log and metric store.
- Deeper deployment-causality analysis and post-fix verification.
- An external security review, if the project ever moves toward real use.

### 6. Deferred or out of scope

| Item | Status | Reason |
|---|---|---|
| Production-scale infrastructure | DEFERRED | Portfolio-first scope; zero budget ([decisions.md](decisions.md), decisions 22 and 24) |
| Commercial features (billing, SLAs, compliance) | DEFERRED | Not a goal for the prototype |
| Paid AI inference in the public demo | Out of scope | Decision 25 |
| A paid domain | DEFERRED | Zero budget; needs owner approval |
| Protection against replacing the P7 recorder disk while it runs | Out of scope | Owner ruling, 18 November 2026 |


## Milestone history (as of 14 November 2026)

| # | Milestone | Status | How it was verified |
|---|---|---|---|
| M1 | Foundation and architecture | Done | Builds, lint and typecheck clean |
| M2 | PostgreSQL and incident management | Done | API integration tests |
| M3 | Services and deployment tracking | Done | API integration tests |
| M4 | Log ingestion and analysis | Done | API integration tests (redaction, patterns, anomalies, retention) |
| M5 | GitHub integration | Done | REST adapter tested against a local stub of the GitHub API; webhooks tested with real signatures. **Not run against github.com** |
| M6 | Redis, BullMQ, background jobs | Done | Ran with a real worker and Redis; tests run jobs inline |
| M7 | Auth, RBAC, multi-tenancy | Done | API integration tests (isolation, scopes, token rotation) |
| M8 | Python FastAPI AI service | Done | 23 tests; ran on host and in Docker |
| M9 | LLM integration, structured output, tool calling | Done | Verified against the live Anthropic API with `claude-haiku-5-5` (claude-live-verification.md), plus 14 provider tests against a mocked API |
| M10 | RAG, embeddings, pgvector | Done | Tests against real pgvector; ran with local embeddings |
| M11 | LangGraph investigation agent | Done | Evals 5/5 (rule-based engine); end-to-end through queue and worker |
| M12 | MCP server | Done | Tool listing and a tool call tested in-process. **Not connected to a real MCP client** |
| M13 | Remediation and approvals | Done | API tests and browser test of the full approval flow |
| M14 | Monitoring, collaboration, analytics | Done | API tests; Prometheus and Grafana verified running |
| M15 | Testing, security, performance | Partly | 70 automated tests. No load testing or dependency audit yet |
| M16 | Docker, CI/CD, documentation | Done | Full stack built and run in Docker. CI runs on every pull request on GitHub and passes on `develop`; the browser suite has passed on `release/0.1.0` |

## Test inventory

| Suite | Count | Scope |
|---|---|---|
| API integration (Vitest + Supertest) | 206 | HTTP → PostgreSQL, all modules; shared contracts; real API responses against the response contracts; trace continuity through BullMQ; failure handling (AI service, Redis and PostgreSQL outages, a killed worker, duplicate delivery, failing trace export) |
| AI service (pytest, mocked model APIs) | 232 | Agent graph, guardrails, providers, embeddings, HTTP API, MCP; each rule of the rule-based engine; a snapshot of all its reports; shared contracts; tracing |
| Web (Vitest + Testing Library) | 53 | API client, formatting, accessible components; the seven journeys as rendered pages (sign-in, incident, starting an investigation, report, evidence, approval, execution outcomes) |
| End-to-end (Playwright), in CI on every pull request | 12 | Sign-in, incident, investigation, approval, RBAC, logs, knowledge, audit, mobile layout; what the page shows while the AI service or the queue is down, and after it returns |
| Failure drills (`npm run drills`), in CI on every pull request | 11 | Real containers killed, stopped and started on a throwaway stack: what was recorded, and that an investigation completes afterwards |
| Agent evaluations | 14 scenarios | Outcome, cause, service, citations, invention, contradictory and missing evidence, calibration, diagnostics, remediation safety, deployment-tool use |
| Local demo, end to end | 10 scenarios | Real telemetry and failures, rule-based engine: outcomes, blame, proposals, evidence provenance, recovery, runbook safety (run locally, not in CI) |

## Milestone 4: reliability and real-system validation

Done: outcome assessment (healthy, degraded, incident, undetermined), action effects and runbook plans, approvals bound to content, unknown execution outcomes, checked figures, trace retrieval, the local demo environment with seven failure scenarios, and the OPSILUME working name. See [reliability.md](reliability.md) and [demo/README.md](../demo/README.md).

Not done, and why:

- **No model was run in this milestone** (no budget). The changed report instructions and schema, the new `get_traces` tool and the demo environment are untested with a language model.
- **The name is not cleared.** Trademark and domain checks are listed in [branding/opsilume-branding.md](branding/opsilume-branding.md).
- **The demo is not in CI.** It needs the whole stack and about 25 minutes; it was run locally, and the recorded run is in [demo/README.md](../demo/README.md). CI checks only that it builds.

## Milestone 5: architecture hardening

No change to the runtime architecture, the API or any safety boundary. What changed is how the code is divided and how its parts are kept in agreement.

| Area | Before | After |
|---|---|---|
| Contracts between Python and TypeScript | Each side declared its own enums, guardrail limits and effect rules; one fixture tied the reports together | One definition under `contracts/`, generated into both languages; the report, the tools and the guardrail behaviour are checked on both sides; CI fails on drift |
| `investigations.ts` (one file) | Routes, validation, limits, orchestration, stream handling, guardrails and persistence together | `modules/investigations/`, one file each |
| `remediation.ts` (one file) | Proposals, hashing, effect, approvals, execution, recording and routes together | `modules/remediation/`, one file each |
| Rule-based engine | One 313-line `analyse()` | `rules.py`: one function per rule, each tested alone; a snapshot of all sixteen reports |
| Web API types | Written by hand, drifted | Generated from the API's response contracts; real responses tested against them; CI fails on drift |
| Tracing | A switch that stopped at the queue, the streamed response and the tool calls | One trace per investigation across every hop; spans scrubbed; local store and `npm run trace` |
| Web tests | 14 unit tests | 47, including the seven journeys as rendered pages |

What it found along the way: the API accepted any string as a claim kind; the investigation list never returned `attemptedProvider`, so a rule-based fallback was not labelled there; the incident page read fields its type did not have; the sign-in page named a demo password the seed does not set. All four are fixed.

Not done, on purpose: the other API modules are not split; Prisma queries are not traced; the browser does not start traces; page-local response types outside the generated contracts (dashboard, settings, monitoring, analytics, knowledge, changes) are still written by hand.

## Milestone 6: reliability

No new feature and no new lifecycle state. The question was what happens to an investigation, and to the application, when something around it fails, and whether that is tested by more than a status code. The full account, with what was not tested, is in [reliability-readiness-report.md](reliability-readiness-report.md).

Done: the remediation risk defect found while preparing the demo (an edit without a risk reset a high-risk action to medium); an investigation runs at most once and reaches exactly one end; interrupted runs are recorded within about a minute instead of twenty; the worker shuts down within a grace period and says what it left unfinished; honest, non-leaking failure messages; readiness on the worker and in the Compose health checks; a throwaway stack; 31 API tests, 2 browser tests and 11 drills; accepted work that survives Redis being killed or wiped; the browser suite and the drills in CI on every pull request.

Not done, and why:

- **Not a claim of production readiness.** One worker, one Redis and one PostgreSQL on one machine were tested. Nothing here says how the system behaves with several workers, under load, or across a network partition.
- **A run interrupted by a crash is not resumed.** It is recorded as failed and has to be started again by a person. Resuming would need the run's progress to be stored and the AI service to continue from it.
- **No model was run.** Every test and drill used the rule-based engine or a scripted stand-in. Timeouts and interrupted streams with a real provider are tested only against mocks.
- **`e2e.yml` is not a required check.** Making it one is a branch-protection change, which is the owner's to make.

## Milestone 7: pilot readiness

The question was what stands between this codebase and an outside team connecting its systems, investigating an incident and judging the result. The starting point is in [pilot-readiness-gap-analysis.md](pilot-readiness-gap-analysis.md); the result for a reader outside the project is [customer-pilot-guide.md](customer-pilot-guide.md).

Done:

- **Integrations.** One page and one endpoint for every source that really exists, with a status that follows accepted data, recorded rejections and explicit checks, not saved credentials. A getting-started list ticked from what was received. Data that names an unregistered service is surfaced and can be linked.
- **Past incidents.** Health for a window that is over comes from the alerts, incidents and metrics recorded in it, not from today. Missing history is stated and lowers confidence.
- **Reports.** A document view of an investigation, with facts, hypotheses and recommendations labelled, that prints from the browser.
- **Pilot guide, and a safe way to remove a trial organisation** (`npm run org:remove`).
- **Security review of the new surface**, recorded in the pull requests: isolation, credentials in responses and stored state, authorisation, outbound requests, error text, audit, limits. Two defects found and fixed in review (an in-memory count over a day of logs; a stored rejection that could repeat a caller's value).

Not done, and why:

- **Not a claim of pilot success or production readiness.** No outside team has used it. Everything was verified on the rule-based engine, on one machine.
- **No model was run** (no budget). The model's instructions and the `get_service` tool changed in this milestone and are untested with a model.
- **GitHub against github.com** still needs a real token.
- **No pull-based collectors.** A team whose logs and metrics live in a vendor needs a forwarder; none is provided.
- **`Browser end-to-end tests` is still not a required check on `develop`.** The steps are in [git-workflow.md](git-workflow.md).

## Milestone 8: integration trust and validation

No new feature for users. The remaining risks named at the end of Milestone 7 were addressed, measured, or written down as open. The summary for whoever decides on a pilot is [pilot-acceptance-report.md](pilot-acceptance-report.md).

Done:

- **Outbound requests.** A tenant's webhook address is checked in the connection itself, not before it, which closes a DNS-rebinding gap; the block list covers reserved and IPv4-embedding ranges; GitHub redirects stay within its API. Tested with real connections.
- **Idempotent ingestion.** An `Idempotency-Key` on the four ingestion endpoints, recorded in the same transaction as the data.
- **Backup and restore.** A documented procedure, and a drill that restores into a second database, compares it and runs the application against it, in CI.
- **Measurements.** A reproducible load test, with its results and their limits.
- **AI validation without a model.** Three evaluation scenarios about past incidents and scripted tests of bad model output; two defects fixed.
- **GitHub.** Webhook, permission and failure tests, and a read-only procedure for validating against github.com.

Not done, and why:

- **GitHub was not validated against github.com.** No token was supplied for the purpose. The procedure is ready ([github-validation.md](github-validation.md)).
- **No model was run** (no budget). The exact tests a paid run must cover are in [ai-validation.md](ai-validation.md).
- **The read-latency finding of the load test was not isolated or fixed**: reads stall for about two seconds while large log batches are ingested.
- **No point-in-time recovery, scheduled backup or replication.**
- **No external security review.**

## Milestone 9: pilot validation and operational readiness

No new feature for users. The open findings of Milestone 8 were investigated, and what an operator needs was built or written down. The summary, claim by claim with the kind of evidence behind each, is [pilot-acceptance-report.md](pilot-acceptance-report.md).

Done:

- **Read latency during ingestion.** The two-second stall reported in Milestone 8 was an artefact of the load generator, not of the application; the explanation offered then was wrong. Three real inefficiencies in log queries were found from their plans and fixed (median read latency under ingestion down by about two thirds on the same data). [performance-investigation.md](performance-investigation.md).
- **Operational backups.** `npm run backup` (create, verify, status) with verification before a file is named a backup, rotation of its own files only, and visible failure; the drill covers damaged backups, rotation and a failed backup. Scheduling, retention and what to do when a backup fails are documented.
- **AI validation without a model.** A test matrix over the twelve areas a pilot depends on, a sanitising pass over report text, and a costed plan for a live run (proposed ceiling $1.00), not executed.
- **CI.** The load test runs in reduced form on every pull request and fails if anything sent is not stored once; the review of what CI does and does not cover is in [git-workflow.md](git-workflow.md).

Not done, and why:

- **GitHub was not validated against github.com.** No test credential was supplied; credentials present on the machine were not used.
- **No model was run** (not authorised).
- **Aggregating views remain linear in the size of their time window** (log patterns, dashboard trend, integration coverage). The remedy is pre-aggregation, which was not attempted.
- **Nothing was run outside a laptop and CI.** There is no pilot host.
- **No review by a second person, and no external security review.**

## Needs the owner's input

1. ~~An Anthropic API key~~ — configured; live verification done.
2. **A GitHub token**, to verify the integration against real repositories.
3. ~~A decision on a remote repository~~ — published at https://github.com/msg-1/opspilot (public); `main` and `develop` are protected.
4. ~~A licence~~ — MIT (`LICENSE`).
5. **Promotion of `develop` to `main`** (release 0.1.0) once you have reviewed the result.
6. **A budget for a live model run** of the eleven evaluation scenarios and of the demo environment, if you want the Milestone 4 changes validated with a model.
7. **Clearance of the OPSILUME name** (trademark, domains) before it is used beyond a working name.
8. **Whether `Browser end-to-end tests` becomes a required check on `develop`** (it already is on `main`). It takes about eleven minutes per pull request; the steps are in git-workflow.md.
9. **A GitHub token and a model budget** before a pilot: the two integrations that have never been exercised for real. The model plan proposes a ceiling of $1.00 ([ai-validation.md](ai-validation.md)); the GitHub procedure needs a read-only token for one test repository ([github-validation.md](github-validation.md)).
10. **A pilot host, an operator and a data agreement** (pilot-acceptance-report.md, section 12).
11. **Whether to enable Dependabot alerts** on the repository, and whether to add Python and container scanning to CI (git-workflow.md).

## Next

1. ~~Re-run the evaluation against a real model~~ — done with six scenarios and structured scoring (docs/claude-live-verification.md). Open from it: the healthy-service scenario reports 0.30 confidence against a bound of 0.25; `run_runbook` is treated as read-only although a runbook can change production. Next: more scenarios (config change, traffic spike, memory leak, two simultaneous causes), repeated runs to measure variance, and `ANTHROPIC_EFFORT=low` against `medium`. Each needs an approved budget.
2. ~~Run CI on a remote; add the end-to-end suite to CI with Compose~~ — done; since Milestone 6 it runs on every pull request, with the failure drills.
3. Live updates over server-sent events instead of polling.
4. Load test ingestion and log search; partition `LogEntry` by time.
5. Email or chat delivery for notifications and invitations.
6. `npm audit` / `pip-audit` review and a dependency update policy.
