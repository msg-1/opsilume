# Project status

**Last updated:** 18 November 2026 (public demo mode committed on `feature/opsilume-public-demo` as `80df9d9` and pushed; deployment readiness validated locally, recorded in the commit that follows it).

**Status recorded against:** branch `prototype/m16-p7-durability-harness`. The P7 hardening is commit `2de30aa1d262ad1a3c52305f29158d17000fef5d`; this documentation was added in the commit that follows it. `develop` is at `075302c`. `main` holds only the initial commit (`aed4476`).

This is the single source of truth for where the project stands. Statuses mean:

| Status | Meaning |
|---|---|
| COMPLETE | Implemented and validated by the evidence named |
| IMPLEMENTED | The code exists; validation is incomplete |
| IN PROGRESS | Active work |
| BLOCKED | Waiting for a dependency or an owner decision |
| NOT TESTED | Not verified |
| DEFERRED | Intentionally postponed |
| NOT STARTED | Future work |

Code that exists is never COMPLETE by itself.

## 1. The project

**OPSILUME**; repository, packages and configuration use the `opsilume` identifiers (renamed on 18 November 2026; earlier commits keep the former name). Tagline: *Illuminate every incident.*

It is an AI-assisted engineering intelligence and incident investigation platform. It correlates logs, metrics, traces, deployments, GitHub changes, service dependencies, documentation and past incidents. An investigation produces evidence-backed hypotheses, says what evidence is missing or contradictory, states its uncertainty, and computes an outcome (healthy, degraded, incident, undetermined) from the evidence. Remediation is proposed, approved by people and never executed by OPSILUME itself.

The immediate goal is a **portfolio-ready public prototype**, not a commercial product. There are no customers, no production-scale validation, no commercial SLA and no compliance certification.

## 2. Overall stage

A working system for local use and evaluation, built in a public repository with CI. It runs on a laptop and in CI only. It is **not deployed** anywhere, and has **not** been hardened or validated for production.

The current engineering work is Milestone 16: post-restore remediation safety. Its P7 durability harness has been built and reviewed, but not run on real hardware.

## 3. Completed milestones

The original build plan (M1 to M16 in [roadmap.md](roadmap.md)):

| # | Milestone | Status | Evidence |
|---|---|---|---|
| M1 | Foundation and architecture | COMPLETE | Builds, lint and typecheck |
| M2 | PostgreSQL and incident management | COMPLETE | API integration tests |
| M3 | Services and deployment tracking | COMPLETE | API integration tests |
| M4 | Log ingestion and analysis | COMPLETE | API integration tests |
| M5 | GitHub integration | IMPLEMENTED | Tested against a local stub of the GitHub API and real webhook signatures. **NOT TESTED against github.com** (needs a token) |
| M6 | Redis, BullMQ, background jobs | COMPLETE | Real worker and Redis; failure drills in CI |
| M7 | Auth, RBAC, multi-tenancy | COMPLETE | API integration tests |
| M8 | Python FastAPI AI service | COMPLETE | pytest; ran on the host and in Docker |
| M9 | LLM integration | COMPLETE (limited) | One live run with `claude-haiku-5-5` ([claude-live-verification.md](claude-live-verification.md)) and mocked-API tests. No paid evaluation run since |
| M10 | RAG, embeddings, pgvector | COMPLETE | Tests against real pgvector |
| M11 | LangGraph investigation agent | COMPLETE | Evaluations on the rule-based engine; end to end through the queue |
| M12 | MCP server | IMPLEMENTED | Tested in-process. **NOT TESTED with a real MCP client** |
| M13 | Remediation and approvals | COMPLETE | API and browser tests |
| M14 | Monitoring, collaboration, analytics | COMPLETE | API tests; Prometheus and Grafana run |
| M15 | Testing, security, performance | IMPLEMENTED | Automated suites, a modest load test and a dependency audit exist. No external security review; no production-scale performance test |
| M16 | Docker, CI/CD, documentation | COMPLETE | Full stack in Docker; CI on every pull request |

Later improvement milestones, each merged into `develop` through a pull request. Details are in [CHANGELOG.md](../CHANGELOG.md) and the reports linked from [roadmap.md](roadmap.md):

- **Milestones 3 to 10:** real AI validation, reliability, architecture hardening, pilot readiness, integration trust, pilot validation and final validation. COMPLETE as recorded in their reports, with the limits those reports state.
- **Remediation integrity work:** pull requests #32 to #37, including transactional remediation audits. COMPLETE (merged, tested).
- **Milestone 15, phase 1:** recovery readiness audit ([recovery-readiness-audit.md](recovery-readiness-audit.md)). COMPLETE (an audit; no code changed).

## 4. Current branch and latest commit

| | |
|---|---|
| Working branch | `feature/rename-to-opsilume` (18 November 2026). It is based on `prototype/m16-p7-durability-harness` and adds the Oracle feasibility audit and the rename to `opsilume`. Neither branch is merged |
| P7 branch | `prototype/m16-p7-durability-harness` (published 18 November 2026) |
| P7 commit | `2de30aa1d262ad1a3c52305f29158d17000fef5d` |
| `develop` | `075302c53120eac8e311e7d560ba49e6c5b2ad75` |
| `main` | `aed447658b834826bec9100603439072cf776e18` (initial commit only; release 0.1.0 is on `release/0.1.0`, not merged) |

Check the live state with `git branch --show-current`, `git rev-parse HEAD` and `git status`. This table records a moment, not a promise.

## 5. Features and their validation status

| Area | Status | Validation |
|---|---|---|
| Incidents, services, deployments, logs, metrics, alerts | COMPLETE | API integration tests against PostgreSQL |
| Auth, sessions, RBAC, API keys, tenancy | COMPLETE | API integration tests (isolation, scopes, rotation) |
| Investigation agent (rule-based engine) | COMPLETE | Unit tests, a pinned snapshot of every rule's output, 14 evaluation scenarios, local demo end to end |
| Investigation agent with Claude | COMPLETE (limited) | One live investigation; no repeated or large-scale model evaluation |
| Evidence provenance and guardrails | COMPLETE | Enforced twice (AI service and API); tested |
| Remediation proposals, approvals bound to content, execution outcomes | COMPLETE | API and browser tests; transactional audits |
| Knowledge base (pgvector, hybrid search) | COMPLETE | Tests against real pgvector |
| GitHub integration | IMPLEMENTED | Stub and signature tests only. NOT TESTED against github.com |
| MCP server | IMPLEMENTED | In-process only. NOT TESTED with a real client |
| Backups and restore drill | COMPLETE (local) | Drill on the throwaway stack ([backup-and-restore.md](backup-and-restore.md)) |
| Post-restore remediation safety (M16) | IN PROGRESS | Design reviewed; Phase 0 and Phase 0.5 prototypes validated in isolation; not in the product |
| P7 durability harness | IMPLEMENTED | See section 6 |
| Public demo mode (`PUBLIC_DEMO_MODE`) | IMPLEMENTED; security-reviewed and remediated; tested locally | Visitor entry without credentials; server-side visitor restrictions; visitors isolated by session; per-session, per-address and demo-wide investigation quotas; no sign-in but the visitor's; rule-based engine required; idempotent setup and locked reset. A 2-minute time limit per investigation, cancellation that frees the worker within seconds, and visitor-facing errors limited to the API's own wording. Implementation committed as `80df9d9`, not merged. Tests: 86 dedicated API tests (including a real worker and queue), API 509/509, web 74/74, AI 358.

**Readiness validation, local** ([deployment/DEPLOYMENT_READINESS_REPORT.md](deployment/DEPLOYMENT_READINESS_REPORT.md)):
- the deployment's arm64 images ran together as containers, with the Compose file's configuration;
- the whole visitor journey passed through Nginx over HTTPS with a self-signed certificate;
- a reset under light live traffic passed;
- one proxy defect was found and fixed: internal API endpoints were reachable through `/api/../`.

**BLOCKED:** starting the Compose project itself (Docker Desktop has no free network address pool).

**NOT TESTED:**
- TLS issuance and renewal on a real domain;
- client addresses on the real host;
- a public host;
- an external security review.

The API's rate limiters are in memory for one process ([deployment/PUBLIC_DEMO_MODE.md](deployment/PUBLIC_DEMO_MODE.md)) |

## 6. In progress: Milestone 16, P7 durability

P7 asks whether a remediation claim recorded in PostgreSQL and in the journal survives a real power loss on native Linux. The harness (`prototype/m16-p7/`) runs the workload, a recorder on a second host, and the check and recovery tools.

**P7 status: NOT TESTED AND NOT PASSED.**

The validation levels are separate. Passing one says nothing about the next.

| Level | Status | Evidence |
|---|---|---|
| Automated tests of the harness | COMPLETE | 480 of 480 on three consecutive runs (18 November 2026); stub suites (removal scripts, firewall), Compose rendering, syntax checks |
| Independent code review | COMPLETE for the supported envelope | Repeated adversarial reviews; findings and dispositions in [m16-p7-second-safety-review.md](m16-p7-second-safety-review.md) sections 11 to 14.3 |
| Docker container smoke | NOT TESTED for the final source | Container smokes passed on earlier source; the last that ran (18 November 2026) predates the post-result contradiction work. The final smoke was blocked by Docker address-pool exhaustion before any container started |
| Native Linux verification | NOT STARTED | No native Linux host available |
| Physical 20-cycle power-cut qualification | NOT STARTED | Not authorised; needs the hardware in section 9 |

The full record is in [m16-p7-hardening-progress.md](m16-p7-hardening-progress.md), [m16-p7-post-commit-review.md](m16-p7-post-commit-review.md) and [m16-p7-second-safety-review.md](m16-p7-second-safety-review.md).

## 7. Blocked

| Item | Status | Blocked by |
|---|---|---|
| Container smoke of the final P7 source | BLOCKED | Docker Desktop address pools are exhausted by preserved scratch projects. Needs the owner's approval to remove stopped scratch resources, or explicit subnets in the scratch Compose override |
| P7 native Linux and physical qualification | BLOCKED | Hardware: a native Linux test machine, a separate recorder host, a controllable power cut. Owner authorisation |
| GitHub validation against github.com | BLOCKED | A read-only token for one test repository |
| Paid model evaluation | BLOCKED | An approved model budget (the plan proposes a $1.00 ceiling; [ai-validation.md](ai-validation.md)) |
| Release 0.1.0 to `main` | BLOCKED | Owner review and approval |
| Public deployment | NOT STARTED; readiness validated locally (CONDITIONAL, [deployment/DEPLOYMENT_READINESS_REPORT.md](deployment/DEPLOYMENT_READINESS_REPORT.md)) | Section 10; the public demo mode is implemented (section 5), the hosting account is not |

## 8. Unverified functionality

All NOT TESTED:
- the GitHub client against github.com;
- the MCP server with a real MCP client;
- Claude beyond the recorded live run (variance, more scenarios, other models);
- the P7 harness on native Linux and under a real power loss;
- the final P7 source in containers;
- the P7 firewall script on a Linux host;
- the P7 smoke teardown against real Docker;
- the P7 recorder's SIGPIPE behaviour on Linux;
- anything outside a laptop and CI.

## 9. Known limitations

See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md). The most important:
- no production deployment or validation;
- no external security review;
- GitHub and MCP not validated externally;
- P7 not qualified.

The P7 harness also has accepted limits:
- total recorder-storage failure followed by a kill loses an in-memory contradiction;
- replacing or remounting the recorder disk during operation is unsupported.

## 10. Deployment status

**NOT STARTED.** There is no public URL. The application runs locally with Docker Compose.

**Feasibility audit: COMPLETE** (18 November 2026, [deployment/ORACLE_FREE_TIER_FEASIBILITY.md](deployment/ORACLE_FREE_TIER_FEASIBILITY.md)). The recommendation is **CONDITIONAL GO** for one Oracle Always Free Ampere A1 instance.
- **Fit:** Oracle's current allowance is 2 OCPUs and 12 GB. The stack uses about 0.7 GB at idle, about 1.3 GB at load-test peak without the web container, and already runs as linux/arm64 images locally.
- **Conditions:**
  - the owner's account and card are accepted;
  - A1 capacity is available in the home region;
  - the account is never upgraded;
  - a public demo mode is implemented first (published OWNER and ADMIN passwords in the seed, open registration, outbound webhooks and a scheduled reset are blockers);
  - HTTPS is set up at ₹0.

No account has been created and nothing has been provisioned.

The preferred target is Oracle Cloud Always Free. That is subject to verifying eligibility and that its resources can run the stack, with a zero monthly budget ([decisions.md](decisions.md), decisions 23 to 25). No cloud account, domain or paid service has been set up.

## 11. Security and safety status

- **In place:**
  - authentication and session handling;
  - RBAC and tenancy enforced on every query;
  - secrets required, with no fallbacks;
  - outbound requests to tenant URLs pinned against DNS rebinding;
  - approvals bound to content;
  - remediation never executed by OPSILUME;
  - credentials masked at ingestion;
  - spans scrubbed;
  - `npm audit` of shipped Node dependencies in CI (no Python or container scanning).

  Details: [architecture.md](architecture.md) (security summary) and [engineering-audit.md](engineering-audit.md).
- **Not done:**
  - an external security review or penetration test;
  - production hardening;
  - a compliance assessment.
- **AI safety:**
  - the agent is read-only;
  - evidence is produced by code, never by the model;
  - the outcome is computed from the evidence;
  - every report is labelled with the engine that produced it.

## 12. Next recommended task

**Resume here.** Two independent tracks:

**Portfolio deployment (preferred next):**
1. The public demo mode and its readiness validation are committed on `feature/opsilume-public-demo`, which is not merged ([deployment/DEPLOYMENT_READINESS_REPORT.md](deployment/DEPLOYMENT_READINESS_REPORT.md): ready for a hosting validation, CONDITIONAL).
2. Owner decision on the CONDITIONAL GO in [deployment/ORACLE_FREE_TIER_FEASIBILITY.md](deployment/ORACLE_FREE_TIER_FEASIBILITY.md). If yes, the owner creates the Oracle account and checks the card, home region, allowance and A1 capacity.
3. On a real host, after the owner's decision:
   - start the Compose project;
   - issue and renew TLS as documented;
   - confirm in Nginx's access log that it sees real client addresses (readiness report, section 13).

   Locally, the Compose project can run only if Docker address space is freed or an explicit subnet is approved.

**P7:** decide how to close the container-smoke gap:

1. Owner decision: free Docker address space (remove stopped P7 scratch resources) or allow explicit subnets in the scratch override. Then run one container smoke of the final P7 source on a new isolated project, and record it here.
2. Review and merge `prototype/m16-p7-durability-harness` into `develop` by pull request, if the owner approves. It is a prototype directory; it does not change the product.
3. The portfolio deployment track is described above and in [roadmap.md](roadmap.md).

P7 physical qualification stays a separate track that needs hardware and authorisation.

## 13. Before the project is portfolio-ready

All of these are NOT STARTED unless stated otherwise:
- **A public URL** serving the application in a safe demo mode: seeded data, no paid AI, no real remediation destinations, reset on a schedule.
- **A polished first-run experience** for a visitor.
- **A README** that leads with the product, the architecture diagram and screenshots. The README exists; screenshots and a demo link do not.
- **A short walkthrough video.**
- **A technical case study,** and interview notes on the architecture and its decisions.
- **Release 0.1.0** merged to `main`, with the protected branches in order.
- **Honest limits stated** wherever the product is presented: no customers, no production validation, P7 not qualified.
