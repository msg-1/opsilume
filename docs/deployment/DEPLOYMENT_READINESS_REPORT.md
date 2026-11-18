# Public demo: deployment readiness report

**Date:** 18 November 2026
**Branch:** `feature/opsilume-public-demo`
**Commit validated:** `80df9d93c69b6a358d16c5f4b9158d97ea840769`
**Fixes made during this validation:** the proxy fix F1 and documentation corrections, reviewed and committed with this report in the commit that follows `80df9d9` (section 13)

**Scope:** an engineering validation on the development machine (macOS, Docker Desktop 29.2.1, arm64):
- Nothing was deployed, no cloud account was used, and no certificate was requested.
- There has been **no external security review**.

Statuses used:

| Status | Meaning |
|---|---|
| **PASS** | Directly verified |
| **FAIL** | A verified defect |
| **BLOCKED** | Could not be tested here |
| **NOT TESTED** | Not attempted |
| **CONDITIONAL** | Acceptable only under the stated conditions |

## 1. Executive summary

**The `deploy/public-demo` Compose project could not be started here.** Docker Desktop refused to create any new network: `all predefined address pools have been fully subnetted`. Per the mission's rules, global Docker settings were not changed, nothing was pruned, and no explicit-subnet workaround was used.

**Instead, the deployment's own images were exercised as containers.**
- **Built from the same `compose.yml`** for arm64.
- **The same configuration:** the same environment (rendered by `docker compose config` with throwaway secrets), memory limits and commands.
- **Wiring:** each was started on Docker's existing default bridge and wired by address (`--add-host`) where Compose would provide names.
- **Exposure:** only the Nginx proxy was published, on loopback, with a self-signed certificate.

That stack ran the whole visitor journey:
- health checks;
- the visitor entry and its session;
- refresh;
- reads;
- a rule-based investigation;
- isolation between two visitors;
- cancellation;
- the time limit;
- refused writes and sign-ins;
- the body and rate limits;
- a reset during live traffic.

All of it behaved as designed. It is strong evidence for the images and their configuration. It is **not** a test of the Compose project itself: Compose networking, name resolution, `depends_on` ordering and restart policies were not exercised.

**One security defect was found and fixed in the proxy configuration.** A path such as `/api/../metrics` reached the API's unauthenticated `/metrics`, `/ready` and `/health` from outside. The exposed data was process and request statistics, with no identifiers or secrets. Section 9, F1.

**Real TLS issuance and renewal, and real client addresses**, cannot be tested without a host and a domain.

**Recommendation:** ready for a **hosting validation** on a real host, once the fixes from this validation are reviewed and committed. **Not** ready to be called a public deployment. Section 14.

## 2. Exact commit and branch validated

| Check | Result |
|---|---|
| Repository | a local worktree of `github.com/msg-1/opsilume` |
| Branch and HEAD | `feature/opsilume-public-demo` at `80df9d93c69b6a358d16c5f4b9158d97ea840769`, clean at the start |
| `main` and `develop` | `aed4476` and `075302c`, the same locally and on `origin`, unchanged |
| Documents reviewed | `PUBLIC_DEMO_MODE.md`, `ORACLE_FREE_TIER_FEASIBILITY.md`; every file in `deploy/public-demo/` |

## 3. Deployment architecture (as implemented)

```
internet ──80/443──▶ proxy (nginx 1.27) ──▶ web (Next.js, :3000) ──/api/*──▶ api (:4000) ──▶ postgres, redis
                                                                               ▲
                                              worker (:9464 health) ──▶ ai (:8000, rule-based) ──tools──┘
```

**Services:**
- eight services (`postgres`, `redis`, `migrate`, `api`, `worker`, `ai`, `web`, `proxy`) on one Compose network;
- named volumes `pgdata` and `redisdata`.

**Exposure:**
- Only `proxy` has `ports` (80 and 443, all interfaces).
- PostgreSQL, Redis, the API, the worker, the AI service and the web app publish nothing.

**Start order:**
1. `migrate` waits for healthy PostgreSQL and Redis, runs `prisma migrate deploy`, then `public-demo setup`.
2. `api` and `worker` start once `migrate` has completed successfully.
3. `web` waits for a healthy `api`.
4. `proxy` waits for a healthy `web`.

`ai` has no dependants. If it is not ready, investigations are refused with `503 demo_engine_unavailable`. That is fail-safe.

**Demo safety:** `PUBLIC_DEMO_MODE=true`, `COOKIE_SECURE=true`, `TRUST_PROXY=uniquelocal`, and `AI_PROVIDER=deterministic` with empty model keys.

## 4. Static validation results

| Check | Command or method | Result |
|---|---|---|
| Compose renders | `docker compose -f compose.yml config --quiet` with placeholder values | **PASS** |
| Missing secrets refused | each of `DEMO_HOSTNAME`, `POSTGRES_PASSWORD`, `JWT_SECRET`, `INTERNAL_SERVICE_TOKEN`, `ENCRYPTION_KEY` left out in turn | **PASS**: exit 1, "required variable … is missing a value" (names only, no values) |
| Port exposure, demo flags, engine, memory limits, no owner password, time limit ≤ 5 min | `node deploy/public-demo/check-config.mjs` | **PASS** |
| Topology | rendered JSON | **PASS**: one network, two named volumes, restart policies and health checks as described in section 3 (the proxy has no health check) |
| `.env` excluded from Git | `git check-ignore -v deploy/public-demo/.env` (`.gitignore` rule `.env`) | **PASS** |
| No secrets in tracked deployment files | review of `compose.yml`, `env.example`, `nginx.conf.template`, `reset.sh`, `check-config.mjs` | **PASS**: secrets come only from `.env`; `env.example` leaves them empty |
| Script syntax | `sh -n reset.sh`; `node --check check-config.mjs` | **PASS** |
| arm64 images | `docker compose build api ai web` on arm64; `docker image inspect` | **PASS**: all three built natively for `linux/arm64`. pgvector 16, Redis 7 and Nginx 1.27 are arm64 |
| Image contents | `dist/src/server.js`, `dist/src/worker.js`, `dist/scripts/public-demo.js` present; runtime users `node` and `opsilume` (not root) | **PASS** |
| Prisma CLI offline | `npx --no-install prisma --version` with no network | **PASS**: the bundled 6.19.3, no download at runtime |
| Web proxy target | `routes-manifest.json` in the web image | **PASS**: `http://api:4000`, fixed at build |
| Nginx syntax | `nginx -t` on the rendered template, with a throwaway certificate | **PASS** |
| Nginx without certificate files | `nginx -t` | **Confirmed:** Nginx refuses to start. The first certificate must be obtained before the first start (F3) |
| Invalid configuration | `INVESTIGATION_TIMEOUT_MS=50` (below the minimum of 100) | **PASS**: the worker refuses to start ("Invalid environment configuration"). An invalid `PUBLIC_DEMO_MODE` stops the process (API test suite) |
| Setup and reset instructions vs scripts | `reset.sh` runs `docker compose run --rm --no-deps migrate node dist/scripts/public-demo.js reset --investigate`, which exists in the image | **PASS**, with the first-start gap F4 |

## 5. Container validation results

| Check | Result |
|---|---|
| Starting the `deploy/public-demo` Compose project | **BLOCKED**: `docker network create` fails with "all predefined address pools have been fully subnetted" (Docker Desktop has 32 networks). Not worked around, per the mission's rules |
| Starting the same images as containers on the default bridge (described in section 1) | **PASS** |
| `migrate` (the Compose command) | **PASS**: 7 migrations applied, the HNSW index preserved, "Public demo ready" |
| Health checks (each service's Compose command, run with `docker exec`) | **PASS**: postgres, redis, api, worker, ai, web |
| Memory at idle (`docker stats`) | postgres 164 MiB, api 102, ai 118, worker 70, web 54, redis 12, proxy 11: about **530 MiB** in all, far below the limits |
| Compose name resolution, `depends_on`, restart policies, named volumes | **NOT TESTED** (needs the Compose network) |

**Temporary resources:**
- created: containers `opsilume-readiness-*`, images `opsilume-readiness-{api,ai,web}`, and two anonymous volumes of the PostgreSQL and Redis containers;
- removed afterwards: all of them, by exact name (the volumes identified by their creation time);
- left: the base images pulled by the build (`node:22-slim`, `python:3.12-slim`, `ghcr.io/astral-sh/uv:0.5`), as reusable cache;
- not touched: no other container, network, volume or image. The development stack (`opspilot-*`, 8 containers) and the network count (32) are unchanged.

## 6. Visitor journey results

All requests went through the proxy over HTTPS (`demo.example.org` resolved to loopback; self-signed certificate).

| # | Step | Result |
|---|---|---|
| 1 | Health checks | **PASS** |
| 2 | Entry page `/login`; demo flag `{"enabled":true}`; HTTP redirected with `301` to HTTPS | **PASS** |
| 3 | "Explore the demo": the visitor, a VIEWER of `acme-commerce-demo`, `demoVisitor: true`, permissions `read, investigation:run`. Cookies HttpOnly, Secure, SameSite=Lax; the refresh cookie limited to `/api/v1/auth` | **PASS** |
| 4 | A dedicated visitor session: one session row with its own `demoSessionId` | **PASS** |
| 5 | Refresh: `200`; a new row with the same `demoSessionId`, the old one revoked; still the visitor | **PASS** |
| 6 | Reads (dashboard, incidents (8), services (6), logs, monitoring, deployments (25), code changes (6), knowledge (5), investigations, remediations (3), analytics) | **PASS**: all `200` |
| 7 | An investigation of INC-3 completed in about 2 s: `heuristic`, outcome UNDETERMINED (the documented "insufficient evidence" scenario), 16 steps, every tool call completed. The session id is not in the response | **PASS** |
| 8 | Visitor B: A's investigation `404`, absent from B's list and from B's incident view; present in A's | **PASS** |
| 9 | Cancellation: B cancelling A's run `409`; A cancelling it `200`, then CANCELLED, no proposals. Cancelling a finished run `409` | **PASS** |
| 10 | Quotas: A's fourth start `429` ("This demo session has run its 3 investigations"); B, a fresh session, `202` | **PASS** |
| 11 | Time limit: the worker's image with `INVESTIGATION_TIMEOUT_MS=100` gives FAILED, "did not finish within 100 ms … No conclusions were recorded", no report, hypotheses or proposals, no slot held. Then restored to 2 minutes | **PASS** |
| 12 | Remediation by a visitor: approve, reject, execute, retry, reconcile, cancel and request-approval each `403`; the action stays PENDING_APPROVAL | **PASS** |
| 13 | Refused writes (`403 demo_restricted`): incidents, settings, API keys, logs ingestion, invitations, GitHub integration and sync, knowledge documents, webhook check, profile, organisation switch, `DELETE /investigations`. `GET /api-keys` and `/audit-logs` `403`. GitHub webhook entry `404` | **PASS** |
| 14 | Registration `403`; sign-in as the owner persona with the documented password `403`; visitor email `403`; invitation acceptance `403`; an API key `401` | **PASS** |
| 15 | A cross-site write (`Origin: https://evil.example`) `403`; same-site `200` | **PASS** |
| 16 | A 300 KB body `413` (from Nginx) | **PASS** |
| 17 | Reset during live traffic (section 9, item 7) | **PASS** in this container stack |
| 18 | Unauthenticated internal endpoints from outside | **FAIL, then fixed:** F1 |
| 19 | Next.js image optimiser as a fetcher: remote URLs `400 "url" parameter is not allowed`; same-origin paths `400 not a valid image`, no content returned | **PASS** |

**What the reset during traffic covered:** the real `public-demo.js reset --investigate`, with a sentinel organisation added outside the demo.
- **Result:** exit 0 in about 2 s.
- **Outside the demo:** a fingerprint of every other organisation and every account (with password hashes) was identical before and after.
- **The old organisation:** its sessions and investigations are gone.
- **Seeded investigations:** six queued and completed by the worker. INC-3 UNDETERMINED, INC-4 INCIDENT, INC-5 HEALTHY, INC-6 UNDETERMINED, INC-7 INCIDENT, INC-8 INCIDENT, all `heuristic`.
- **Audit:** `public_demo.setup` and `public_demo.reset`.
- **Visitor traffic during it:** 11 × `200` and 4 × `429` (Nginx entry limit) on entry; 6 × `503` "being prepared"; 7 × `200` and then 14 × `401` on reads. No other errors.
- **Afterwards:** an earlier visitor gets `401`.

## 7. TLS and reverse-proxy results

| Item | Static configuration | Local behaviour (self-signed, loopback) | Real public issuance | Renewal |
|---|---|---|---|---|
| HTTP to HTTPS redirect | **PASS** | **PASS** (`301`) | n/a | n/a |
| Certificate loading | **PASS** (`nginx -t`) | **PASS** (TLS handshake) | **NOT TESTED**: no domain, no approval | **NOT TESTED** |
| Bootstrap order | Nginx does not start without the files (F3) | — | **NOT TESTED** | — |
| ACME webroot `/.well-known/acme-challenge/` on port 80 | **PASS** (configured) | NOT TESTED | **NOT TESTED** | **NOT TESTED** |
| HSTS, `X-Content-Type-Options` | **PASS** | **PASS** (`max-age=31536000`, `nosniff`); the app adds `X-Frame-Options: DENY`, CSP and a referrer policy | — | — |
| Request size (256 KB) | **PASS** | **PASS** (`413`) | — | — |
| Rate limits | **PASS** | **PASS**. 40 rapid `/api/v1/auth/` requests: 11 × `200`, 29 × `429`. Also limited for `/API/…` | — | — |
| Forwarded address | **PASS** (`X-Forwarded-For $remote_addr` in every proxied location; `TRUST_PROXY=uniquelocal`) | **CONDITIONAL**: every client appeared as `172.17.0.1`, the Docker Desktop gateway, so the per-address limits acted as one shared limit | **BLOCKED**: needs the Linux host | — |
| Internal endpoints | — | **FAIL, then fixed** (F1) | — | — |
| Health-check routing | API `/health`, `/ready`, `/metrics` are internal; not under `/api/*`, so not routed from outside after F1 | **PASS** after F1 | — | — |

**There is no certbot service in Compose.** Certbot runs on the host; the exact commands are now documented (F3).

**A local self-signed test is not evidence** that public issuance or renewal works.

## 8. Oracle Always Free readiness

[ORACLE_FREE_TIER_FEASIBILITY.md](ORACLE_FREE_TIER_FEASIBILITY.md) was reviewed against the current deployment, and a dated status note was added to it. The audit itself was not changed.

**It is consistent:**
- arm64 builds;
- memory limits of about 3.3 GB for the long-running services (the one-off `migrate` adds 512 MB while it runs);
- a measured idle use of about 530 MiB, which fits a 1 OCPU / 6 GB A1 instance with room to spare.

**It is out of date:**
- section 11 lists the demo-mode changes as not implemented and plans a published visitor account. Both are superseded: implemented, with a passwordless visitor;
- the concurrency figure is 2 now, not 3;
- the image sizes are larger than recorded.

The status note says so.

**What the owner must verify personally before any provisioning decision.** Nothing here assumes them:
- that a Free Tier account can be created and the card is accepted, and that the account is **not** upgraded to Pay As You Go;
- the home region, which is permanent, and that A1 capacity can actually be obtained there;
- the A1 allowance the console actually shows (2/12 or 4/24), planning for the smaller one;
- idle-reclamation and account-inactivity rules as they stand on the day;
- a host name that can get a Let's Encrypt certificate, with ports 80 and 443 reachable;
- MFA on the account, and SSH restricted to the owner's addresses.

**The hosting constraint stays ₹0 a month.**

## 9. Security findings

| ID | Finding | Severity | Status |
|---|---|---|---|
| F1 | **Internal endpoints reachable from outside.** The API's unauthenticated `/metrics`, `/ready` and `/health` could be reached through the public proxy with `/api/../metrics`, `/api/v1/%2e%2e/%2e%2e/metrics` and similar. Nginx matched the normalised path (`/metrics`) to `location /`, forwarded the original path, the web app's `/api/*` rewrite matched it, and the dot segments resolved on the way to the API. **Exposed:** Prometheus process and request statistics (CPU, memory, event loop, route templates with request counts) and database/Redis readiness. **Not exposed:** identifiers, emails, tokens or secrets (checked). Only the API's root paths were reachable this way; paths that normalise back under `/api/` still hit the rate-limited locations | **Low–medium** (information disclosure) | **Fixed in configuration** (uncommitted). Nginx returns `400` for any request whose path contains `..`, an encoded dot or an encoded `%`; query strings are not checked. Re-tested in the running proxy: every variant `400`; pages, API calls, static assets and a `..` in a query string unaffected. Evidence: see **F1 evidence** below the table. A code-level defence is proposed in section 13 |
| F2 | **Stale upstream address.** Nginx resolves `web` once, at start. If the web container is recreated with a new address, the proxy may keep the old one | Low (availability) | Documented: restart the proxy after recreating `web`. Optional configuration change in section 13 |
| F3 | **First-certificate bootstrap.** Nginx cannot start without its certificate, so the first certificate cannot use the webroot, and the previous instructions did not say how to get it | Medium (operational) | **Documented:** standalone issuance before the first start, then `certbot reconfigure` to the webroot with a reload hook (`PUBLIC_DEMO_MODE.md`, section 10). Not run against a real domain |
| F4 | **No investigations on first start.** A fresh deployment shows no investigations until the first reset: `migrate` runs `setup` without `--investigate` | Low (presentation) | Documented: run `./reset.sh` once after the first start |
| F5 | **Health-check claim.** The documentation said every long-running service has a health check; the proxy has none | Info | Documentation corrected |
| F6 | **IPv6 clients.** Nginx listens on IPv4 only inside its container. If Docker serves IPv6 clients through its userland proxy, they all appear as the gateway and share one address bucket | Low (availability) | Known; to check on the host (section 11) |

**F1 evidence**, of three kinds:
1. **Live, in the readiness stack:** every variant `400` after the fix.
2. **Live, an isolated Nginx at review**, with the real template and an echo upstream:
   - 13 traversal forms answered `400` by Nginx without reaching the upstream, including `%252e`, `..%2f`, `..%5c`, `/x/../api/…` and an absolute-form request target, over HTTP/1.1 and HTTP/2;
   - 12 normal paths reached the upstream, including query strings with `..`, `%2e` or `%25`, static chunks with `%5B…%5D`, and dotted ids.
3. **A template test** in `client-address.test.ts`. It checks that the rule exists and that its pattern matches those paths; it does not test Nginx itself.

Requests refused this way are answered before Nginx's rate-limit phase. They are cheap and never reach the application.

Nothing found contradicts the demo-mode controls:
- visitor isolation;
- sign-in refusals;
- refused writes;
- the remediation guard;
- the CSRF Origin check;
- body and rate limits;
- the reset's containment.

## 10. Resource and operational constraints

**Configured:**
- **Memory limits:** postgres 768 MB, redis 128 MB, api 512 MB, worker 512 MB, ai 768 MB, web 512 MB, proxy 128 MB, migrate 512 MB (one-off).
- **Logs:** json-file, 10 MB × 3 per container.
- **Restarts:** `unless-stopped` on every long-running service.
- **Health checks:** on every service except the proxy.

**Workload bounds:**

| Bound | Value |
|---|---|
| Per visitor session | 3 investigations |
| Per client address | 1 at a time, 10 a day |
| Whole demo | 2 at once, 200 a day |
| Time per investigation | 2 minutes |
| Body size | 256 KB at Nginx and at the API |
| Nginx | 10 r/s (burst 40) on `/api/`, 1 r/s (burst 10) on `/api/v1/auth/`, 20 connections per address |
| API (in memory) | 1200 a minute and 20 sign-in requests a minute per address; 60 demo entries an hour per address |

There is no model, key or paid call: `AI_PROVIDER=deterministic`, and the API refuses any other engine.

**Unbounded or expensive workload:** none found that a visitor can trigger beyond these. Knowledge search costs one local embedding each, bounded only by the rate limits.

**Growth between resets:**
- session rows (one per entry or refresh; at most 60 entries an hour per address);
- audit rows for each entry;
- investigations (200 a day).

The reset removes all of them.

**The single-API-process assumption is CONDITIONAL.** `compose.yml` defines one `api` service with no `deploy.replicas`, and it is started as one Node process (`node dist/src/server.js`, no cluster). Correct for this file; nothing enforces it if someone scales the service.

**Reset scheduling:** `reset.sh` is meant for host cron; an example line is in the script. It exits 3 if another reset holds the lock. Its log goes wherever cron sends it.

## 11. Known limitations (rechecked against the code)

| Limitation | Actual impact | Blocks the portfolio demo? | Code or documentation? | Proportionate mitigation |
|---|---|---|---|---|
| API rate limits in memory, reset on restart | After a restart, an abusive client gets a fresh API allowance; Nginx's limits (in Nginx's memory) and the investigation quotas (in the database) still apply | No | Documentation | Rely on Nginx for request rates; keep the restart policy; nothing more for one host |
| Not shared across API processes | Each process would allow the full limit | No, with one process | Documentation (code only if scaled) | Keep exactly one `api`; add a shared store only before scaling |
| Exactly one API process required | Holds by construction in `compose.yml`; not enforced | No | Documentation | `check-config.mjs` could also assert no `deploy.replicas`; operator note |
| A dead worker holds a slot | Up to about 7 minutes (the time limit plus 5 minutes, swept once a minute), counting against the 2 concurrent slots; other visitors get `429` meanwhile | No | Documentation | Restart policy brings the worker back; the sweep frees the slot |
| Many addresses can use up the daily quota | Further investigations are refused until midnight UTC or the next reset; reads unaffected | No | Documentation | Daily reset; the operator can raise or lower `INVESTIGATION_DAILY_LIMIT`; Nginx limits slow it |
| Shared aggregate analytics and seeded knowledge | Visitors see aggregate counts of others' runs and the same knowledge base; no visitor's question or result | No | Documentation | Accepted by design |
| Reset during live traffic | Validated in the container stack with light traffic (section 6); not on the Compose deployment or under heavy load | No | Validation on the host | Run the first resets by hand while watching the logs |
| Real client addresses on the host | Unknown until deployed; if Nginx sees the gateway, every per-address limit becomes global (stricter, never absent) | No, but must be checked on day one | Validation on the host | Check Nginx's access log after the first visits; if needed, keep Docker's iptables publishing (default) and avoid the userland proxy |

**None of these is marked resolved.**

## 12. Blocked and untested items

| Item | Status | Why |
|---|---|---|
| Starting the `deploy/public-demo` Compose project | **BLOCKED** | Docker Desktop has no free network address pool. Changing global settings, pruning and explicit subnets are excluded |
| Compose DNS, `depends_on`, restart policies, named volumes | **BLOCKED** | Same |
| Real client addresses through Docker publishing | **BLOCKED** | Docker Desktop's port forwarding hides them; needs the Linux host |
| Real certificate issuance and renewal | **NOT TESTED** | No authorised domain; not approved |
| Load and heavy-traffic reset | **NOT TESTED** | Out of scope; light traffic only |
| A worker dying mid-run in the container stack | **NOT TESTED** here | Covered by the API's reliability tests, not by this stack |
| Real browser journey | **NOT TESTED** | The journey used HTTP clients through the proxy; the web pages are covered by component tests |
| Hourly demo-entry limit; window resets of the API limiters | **NOT TESTED** | As before |
| External security review, penetration test | **NOT TESTED** | Has not happened |
| P7 | Not reopened | Remains **NOT TESTED AND NOT PASSED** |

## 13. Required fixes, by severity

1. **Before the hosting validation:**
   - **Done, in this report's commit:** the F1 proxy fix, reviewed again before committing (`deploy/public-demo/nginx.conf.template`; its template test in `apps/api/tests/client-address.test.ts`; API suite 509/509).
   - **Done, in this report's commit:** the documentation corrections (F3, F4 and F5 in `PUBLIC_DEMO_MODE.md`, the status note in the Oracle document, `PROJECT_STATUS.md`).
2. **Recommended, a code change (not made: it needs approval). Defence in depth for F1.**
   - The API should not answer `/metrics`, `/ready` and `/health` to requests that came through the proxies.
   - Smallest version: in `apps/api/src/app.ts`, answer `404` on those three paths when the request carries `X-Forwarded-For`. The container health check and Prometheus call them directly, without that header.
   - Alternative: serve metrics on a separate internal port, as the worker does.
   - Files: `apps/api/src/app.ts`.
   - Tests: a request with `X-Forwarded-For` gets `404`; one without gets `200`.
3. **Optional, configuration.** For F2, let Nginx re-resolve `web` at run time: `resolver 127.0.0.11 valid=10s;` and a variable in `proxy_pass`. Changing how the path is forwarded needs care alongside F1, so it is left as a recommendation.
4. **On the host, at the first deployment** (operational, not code):
   - the TLS bootstrap as documented;
   - check client addresses in Nginx's access log;
   - run `./reset.sh` once;
   - install the cron entry and watch the first scheduled reset;
   - run `check-config.mjs` before `up`.

## 14. Final recommendation

**Ready for a hosting validation: CONDITIONAL.**

**Conditions:**
- the F1 proxy fix and the documentation corrections from this validation are reviewed and committed (done in this report's commit);
- the owner completes the Oracle prerequisites in section 8.

**The images and configuration are sound.** They build for arm64, start, pass their health checks, and enforce the demo's controls end to end through the proxy. The one defect found (F1) is fixed and tested.

**Not established here, and only a real host can establish them:**
- the Compose project itself running;
- real TLS issuance and renewal;
- real client addresses;
- behaviour under real traffic.

**Do not describe the demo as deployed, publicly available or production-ready.**

**Next smallest step, the owner's decision:**
1. Check Oracle account eligibility and A1 capacity yourself (section 8) before authorising any hosting activity.
2. If that succeeds, run the deployment on the instance with the first-deployment checklist (section 13, item 4).
3. Optionally, before any cloud step, approve freeing Docker Desktop address space, or one explicit subnet for a throwaway Compose project, so that the Compose project itself can be started locally once.
