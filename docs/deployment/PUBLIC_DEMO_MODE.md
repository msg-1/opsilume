# Public demo mode

**Status (18 November 2026):** implemented, security-reviewed and remediated, and tested locally on branch `feature/opsilume-public-demo`. **Not deployed:** nothing is public, and no cloud resource exists. The Compose project of `deploy/public-demo` has not run (Docker Desktop had no free network address space). Its images ran together as containers in the readiness validation ([DEPLOYMENT_READINESS_REPORT.md](DEPLOYMENT_READINESS_REPORT.md)). TLS has not been issued for a real domain, and there has been no external security review. Hosting: [ORACLE_FREE_TIER_FEASIBILITY.md](ORACLE_FREE_TIER_FEASIBILITY.md).

This document covers:
- how a visitor explores OPSILUME without an account, and what stops a visitor from changing anything that matters;
- how the demonstration is seeded, reset and deployed;
- what has and has not been verified.

## 1. Architecture

The public demonstration is the ordinary application, with one flag set: `PUBLIC_DEMO_MODE=true`. It adds nothing that bypasses the existing authentication, roles or tenancy.

```
visitor ── HTTPS ──▶ nginx (only published service) ──▶ web (Next.js) ──/api/*──▶ API ──▶ PostgreSQL, Redis
                                                                                  │
                                                                     worker ──────┴──▶ AI service (rule-based engine only)
```

| Mode | How it is selected | Behaviour |
|---|---|---|
| Development | `PUBLIC_DEMO_MODE` unset or `false` (default), `NODE_ENV=development` | Unchanged. `npm run db:seed` creates the local accounts with the documented password |
| Private deployment | `PUBLIC_DEMO_MODE=false`, `NODE_ENV=production`, real secrets | Unchanged. Registration, roles, integrations and webhooks work as designed |
| Public demonstration | `PUBLIC_DEMO_MODE=true` (exactly; any other value except `false` stops the process) | Visitor entry, visitor restrictions and per-session isolation, investigation quotas. No password sign-in, registration, invitation, API key or webhook entry for anyone. Rule-based engine required |

The flag is read by the API and the worker from their own environment. The web app cannot set it; it only asks the API (`GET /api/v1/auth/demo`) whether to show the visitor entry. Every restriction is enforced by the API.

## 2. Visitor authentication

- The sign-in page shows **Explore the demo**. It calls `POST /api/v1/auth/demo`, which exists only in demo mode (`404` otherwise) and is rate-limited. It starts an ordinary session (the usual HttpOnly, SameSite=Lax cookies, `Secure` with `COOKIE_SECURE=true`) for one shared account: `visitor@demo.opsilume.invalid`.
- **No credentials are published.** The visitor account has a random password that is never shown or used, and password sign-in is refused for everyone in demo mode (section 3). The decision to use a passwordless visitor entry instead of a published password is decision 28 in [decisions.md](../decisions.md).
- The session reports `demoVisitor: true` and the permissions the API will really allow: `read` and `investigation:run`.
- **Every entry is its own visitor session.** All visitors are the same account, so the user cannot tell them apart; the session can. Each entry gets a random session id, stored on the session record and carried through every refresh. It owns the investigations started in it (section 5).
- **A replayed refresh token ends that visitor's session only.** Outside demo mode, a replayed (already rotated) refresh token is treated as theft and ends every session of the user. For the shared visitor account that would let anyone sign out every visitor, so there it ends that one session.
- **Entry is rate-limited:** 20 a minute (all sign-in endpoints) and 60 an hour per address, in the API; 1 a second with a burst of 10 at the proxy.

## 3. Owner and administrator access

On the public endpoint, **nobody but the visitor can be signed in.** In demo mode the API:
- refuses `POST /auth/login` for every account with `403 demo_restricted`, before it reads or checks any password. No owner, administrator or persona password is accepted, whether it is the documented `Opsilume-demo-1`, a random one, or an account's real one;
- refuses invitation preview and acceptance, and registration;
- accepts no API key (`X-Api-Key` or `Bearer opk_…`). The demonstration ingests nothing;
- treats every user session other than the visitor's as signed out, including one created before the flag was turned on;
- does not offer the GitHub webhook entry (`404`).

The sign-in page in demo mode shows only **Explore the demo**: no password form, no local credentials and no registration link.

**Persona accounts.** The dataset's fictional people (owner, administrator, engineers, viewer) are created by the setup with random passwords that nobody knows. Existing accounts are never changed.

**`PUBLIC_DEMO_OWNER_PASSWORD` is retired.** An earlier revision let it set the owner persona's password for a private operator sign-in through the public endpoint. That sign-in is gone: the setup refuses to run if the variable is set, and the Compose file no longer passes it. Leave it unset.

**Private operator access.** Operators work on the host, never through the public site:
- SSH with keys, from the operator's own addresses (feasibility audit);
- `docker compose run --rm --no-deps migrate node dist/scripts/public-demo.js status|setup|reset [--investigate]` (`reset.sh` wraps the reset);
- `docker compose logs`, `docker compose ps` and the health checks.

No administrative web interface is reachable on the demo host. Inspecting the demonstration in an owner's role is done on a private, non-demo instance (`PUBLIC_DEMO_MODE=false`, for example the local development stack with its own seed), not on the public one.

**Unchanged outside demo mode.** With the flag off (development or a private deployment), password sign-in, invitations, registration, API keys, webhooks and every owner and administrator function work as before (tested: the same owner and API key are refused with the flag on and accepted with it off).

## 4. Tenant isolation

The visitor is a **VIEWER member of the demonstration organisation only**:
- the setup refuses to continue if the visitor account belongs to any other organisation;
- every query filters by the session's organisation, as everywhere in the API;
- a request for another organisation's record by id answers `404` (tested).

## 5. What a visitor can and cannot do

**Visitor sessions are kept apart.** All visitors are one account, so isolation is by session (section 2):
- **Seen:** a visitor sees the seeded investigations (those no visitor started) and its own session's. This covers the investigation list and detail, an incident's investigations, the dashboard, remediation actions derived from another session's run, and the knowledge base's attribution of incidents to investigations. Another session's run answers `404` (tested).
- **Cancelled:** a visitor cancels only its own session's queued or running investigations. Another visitor's run or a seeded run answers `409` and stays as it was (tested).
- **Written to shared places:** nothing. The question, the result and the proposed actions of a visitor's run write no incident timeline entry and no notification (tested).
- **Still shared:**
  - aggregate counts and durations (analytics overview, today's usage in the analysis status);
  - the knowledge base and its search;
  - the seeded data.
- **Not exposed:** which session started a run is never returned.

The alternative the review allowed, disabling visitor cancellation and documenting shared visibility, was not needed: ownership could be isolated without changing authentication (decision 29 in [decisions.md](../decisions.md)).

**Allowed:**
- every read: dashboard, services and their graph, incidents, logs, metrics, deployments, service events, code changes, knowledge documents and search, remediation proposals, approvals, investigations, evidence, hypotheses and reports, analytics, members and settings (values only);
- starting an investigation, bounded as section 6 describes.

**Refused.** Enforced in two independent places:
1. **Permissions.** The visitor's permissions are fixed (`lib/demo.ts`, `VISITOR_PERMISSIONS`) whatever its membership role says. Every route's `requirePermission` therefore refuses writes, member and team management, settings, API keys, audit log access, integrations, GitHub configuration and sync, ingestion, knowledge changes, alert rules, and remediation proposals, approvals, execution, retry, reconciliation and cancellation.
2. **A method allowlist** in the authentication middleware. A visitor may make GET and HEAD requests, and only four other requests:
   - `POST /investigations`;
   - `POST /investigations/:id/cancel`;
   - `POST /knowledge/search`;
   - `POST /notifications/read`.

   Any other method or path is refused with `403 demo_restricted` before a route runs. That covers alternative methods, nested routes and routes added later. Profile changes and organisation switching are refused too.

**Refused for everyone in demo mode:** password sign-in, registration, invitations, API keys and the GitHub webhook entry (section 3).

**The four permitted writes:**
- **`POST /investigations`:** bounded by section 6's quotas.
- **`POST /investigations/:id/cancel`:** own session only.
- **`POST /knowledge/search`:** a read with one embedding computation each; bounded by the rate limits.
- **`POST /notifications/read`:** acts on the visitor account's notifications, which visitor runs never create.

**Reads that write:** the analytics CSV export writes no audit row for the visitor; `GET /settings` creates the default settings row if it is missing.

**Errors.** A visitor never receives the text of an error that this codebase did not word itself:
- **A failed investigation of a visitor** keeps its own message only if it is one of the API's known messages:
  - the time limit;
  - a broken connection;
  - an unreachable database;
  - no report produced;
  - a model provider refused.

  Anything else, including an upstream answer, an exception's text or an error event from the analysis service, is recorded as "The analysis could not be completed. No conclusions were recorded. Try again later." The original goes to the worker's log.
- **Failed steps of a visitor's run** keep what failed (the tool's name and input), but their error text is replaced the same way.
- **A dependency that is down** (`503 service_unavailable`) is answered in demo mode with "A service this request needs is not available right now", and its message goes to the API's log. The analysis and system status show "not reachable".
- **Other server errors** were already answered with a generic message and logged.
- **The analysis service, for everyone:** a tool call that cannot reach the API says "OPSILUME API is not reachable (ConnectError)", without the address. An error answer that is not the API's own is not repeated. These texts reach report uncertainties, which every member reads, so this applies outside demo mode too. The detail goes to the analysis service's log.
- **Logs** hold error messages and stacks, never request bodies, cookies or tokens (request logging records the method, path and status only).
- **Tested** with representative internal messages (a private address, a database URL with a password, a file path, a token, an upstream error page). None appeared in any visitor response.

**Outbound effects:**
- A visitor cannot reach any route that sends a webhook, executes a remediation, syncs GitHub or stores a credential.
- The demo's Compose file configures no GitHub token, no trace store and no model key.
- The proxy accepts request bodies of at most 256 KB.
- The MCP server is not part of the deployment.

**Owner and administrator capabilities are unavailable on the public endpoint** (section 3), and unchanged outside demo mode (tested).

## 6. The rule-based demonstration engine

The demo uses the existing rule-based engine of the AI service (`services/ai/app/rules.py`, `heuristics.py`). It is deterministic, needs no model, key or local LLM, and costs nothing. It is not a language model:
- it correlates the tool results by rules (recent change, unhealthy dependency, past incident, signal floor);
- every report carries `analysisMode: "heuristic"`, which the interface shows as rule-based;
- the report states its limits in its uncertainties ("This analysis used rule-based correlation without a language model; it cannot read code diffs or reason about mechanisms beyond keyword overlap").

**Enforcement:**
- The demo's Compose file sets `AI_PROVIDER=deterministic` and no keys.
- The API refuses to start an investigation in demo mode (`503 demo_engine_unavailable`) unless the analysis service reports the rule-based engine, or if the service cannot be reached.
- If a run's analysis service still reports a model provider, the worker stops that run before it uses any result.

**Bounds.** A visitor's start is refused with `429 limit_reached` when any of these is reached:

| Limit | Default | What it bounds |
|---|---|---|
| Per visitor session | 3 investigations (`DEMO_SESSION_INVESTIGATION_LIMIT`) | One visitor's pace. A new session is one click away, so this is not the real bound |
| Per client address, at once | 1 queued or running | One address holds at most half of the demo's capacity (two addresses can hold all of it until their runs end) |
| Per client address, per day | 10 (`DEMO_ADDRESS_DAILY_INVESTIGATION_LIMIT`) | One address, across all its sessions |
| Whole demo, at once | 2 (`INVESTIGATION_MAX_CONCURRENT`) | The host's capacity |
| Whole demo, per day | 200 (`INVESTIGATION_DAILY_LIMIT`) | The total, whoever starts them; it includes the setup's own runs |

How the limits are enforced:
- An address's sessions are those whose session records carry that address today. The address a session was entered from counts as well as the one it is used from. Entering sessions from one address and starting runs from another therefore stays within the first address's limits (tested).
- Every limit is counted from the investigations themselves. There is no separate counter that could drift, and a reset clears them all.
- The check and the insert happen in one transaction, under a per-organisation advisory lock. Parallel requests therefore cannot all pass: six parallel starts against a session limit of 1 give exactly one `202` (tested). With the lock removed, four got through.
- The questions and time windows are validated as everywhere. The proxy's request limits apply on top.

A determined visitor with many addresses (for example, many IPv6 addresses from one prefix) can still use up the whole day's 200. That bounds cost and load, but not fairness.

**Execution time limit.** No investigation runs longer than `INVESTIGATION_TIMEOUT_MS`. The Compose file sets it to **2 minutes** (`120000`), and `check-config.mjs` refuses more than 5. Rule-based runs take seconds.

When a run reaches the limit:
- The worker aborts the request to the analysis service, whether it answered nothing or stopped halfway.
- The run is recorded **FAILED** with "The investigation did not finish within … and was stopped. No conclusions were recorded."
- Evidence gathered so far stays; nothing is concluded. No report, hypotheses, proposed actions, timeline entry or notification are written. The report would have been stored only while the run was still RUNNING, and the failure is written only under the same condition, so exactly one of the two happens.
- Proposed actions never execute anything by themselves. No webhook is configured in the demo, and visitors cannot approve or execute.

**Slot release.** A slot is a QUEUED or RUNNING investigation. Every limit is counted from those rows, so a slot is free as soon as the run is recorded COMPLETED, FAILED, CANCELLED or interrupted.
- **Cancelling** frees the slot at once. The worker also checks every 2 seconds whether its run was cancelled or removed, and then lets go of the analysis request. A silent stream therefore no longer holds one of the worker's two places until the time limit.
- **A worker that dies** leaves its run RUNNING until the once-a-minute sweep records it as interrupted. With the demo's limit that is at most 7 minutes after it started (time limit + 5 minutes).
- **Another visitor's run** is unaffected by a cancellation or a time-out (tested).

**Honesty:** outcomes are computed from the evidence. In the seeded scenarios they come out as INCIDENT, HEALTHY or UNDETERMINED (section 7). Missing evidence produces UNDETERMINED with explicit uncertainties, and evidence against a hypothesis is listed with it.

**Not demonstrated:** model reasoning. The live Claude verification is documented separately ([claude-live-verification.md](../claude-live-verification.md)) and does not run in the demo.

## 7. Seed data

The demonstration organisation is **Acme Commerce** (`acme-commerce-demo`), the existing manual-testing dataset (`apps/api/scripts/demo-data.ts`):
- six services with dependencies and owning teams;
- deployments, service events, GitHub-style commits and pull requests on sample repositories (labelled as samples);
- logs, metrics, alert rules and alerts, knowledge documents (runbooks, architecture, a postmortem), eight incidents, and three remediation proposals awaiting approval.

Telemetry is anchored to the time of seeding, and its pseudo-random parts use a fixed seed, so every seed has the same shape.

The setup with `--investigate` starts one rule-based investigation per open incident through the normal queue. These are the outcomes observed locally:

| Incident | Scenario | Outcome |
|---|---|---|
| Checkout failing at payment after shop-payments v3.8.0 | Deployment-related regression | INCIDENT. The leading hypothesis cites 5 supporting and 2 contradicting evidence items |
| Database latency affecting order processing | Database connection pool exhaustion (a config change) | INCIDENT |
| Redis dependency outage: stock lookups failing | Dependency failure | INCIDENT. Hypotheses: upstream dependency and a recurrence of an earlier incident |
| Reports of slow order confirmation, not reproduced | Report not supported by the evidence | HEALTHY, with its uncertainties |
| Notification delivery delays; Order confirmation e-mails reported missing | Insufficient evidence | UNDETERMINED, with 6 stated uncertainties and the next steps |

**Not included:**
- Traces need a trace store (`TRACES_URL`), which the demo does not run; the interface says so where traces would appear.
- The setup itself writes no investigation, evidence or report: those are produced by the engine.

## 8. Reset

`node dist/scripts/public-demo.js reset --investigate` (`deploy/public-demo/reset.sh`, run by host cron):

1. Removes the demonstration organisation and only its rows, in one transaction. That transaction verifies that no row of any other organisation and no user account changed, or it rolls back (`demo-data.ts`).
2. Seeds it again and adds the visitor membership.
3. Starts the investigations.
4. Writes `public_demo.setup` and `public_demo.reset` audit entries.

**Sessions and quotas.** The removal deletes the demonstration organisation's session records and investigations, which are all the quota state there is.
- An earlier visitor's next request gets a clean `401`, and so does its refresh (tested).
- The visitor then enters again with fresh limits.
- A run that is in flight while it is removed leaves nothing behind. The worker's final writes are conditional on the run existing and still running, so they record nothing, propose nothing and notify nobody (tested).

**Under traffic:**
- The reset first removes the visitor's membership. That signs every visitor out, and the entry answers "being prepared".
- It then cancels the demonstration's queued and running investigations, and removes the organisation.
- A write that still lands during the removal rolls the removal's transaction back as a whole. It is tried up to three times, and then the reset fails with a non-zero exit, leaving the demo closed to visitors until `setup` or `reset` completes. An unmarked organisation with the demo's slug is never touched. A reset under real traffic has not been tested.

**Guarantees:**
- **One run at a time:** a Redis lock (15 minutes) makes a concurrent run exit with code 3 without doing anything (tested with two concurrent resets).
- **Idempotent:** running `setup` again creates nothing new (tested).
- **Visitors cannot start it:** it is a command on the host, with no route.
- **Effect on visitors:** during a reset, visitors briefly lose their session (it belonged to the removed organisation) and the visitor entry answers "The demo is being prepared" until the setup finishes. They then enter again.

No in-application scheduler was added. A host cron entry is the simplest bounded option, and reset can always be run by hand.

## 9. Environment

| Variable | Where | Value in the demo |
|---|---|---|
| `PUBLIC_DEMO_MODE` | API, worker, setup | `true` (Compose file) |
| `PUBLIC_DEMO_OWNER_PASSWORD` | none | retired: must be unset (the setup refuses to run otherwise) |
| `DEMO_SESSION_INVESTIGATION_LIMIT` | API | default 3: investigations one visitor session may start |
| `DEMO_ADDRESS_DAILY_INVESTIGATION_LIMIT` | API | default 10: investigations a day from one client address |
| `INVESTIGATION_DAILY_LIMIT`, `INVESTIGATION_MAX_CONCURRENT` | API | 200 and 2 (Compose file): the whole demonstration, per day and at once |
| `TRUST_PROXY` | API | `uniquelocal` (section 10a) |
| `INVESTIGATION_TIMEOUT_MS` | API, worker | `120000` (2 minutes; the configuration check allows at most 5) |
| `DEMO_HOSTNAME` | proxy, `WEB_ORIGIN` | the public host name |
| `POSTGRES_PASSWORD`, `JWT_SECRET`, `INTERNAL_SERVICE_TOKEN`, `ENCRYPTION_KEY` | all | generated on the server (`openssl rand -hex 32`); the Compose file refuses to start without them, and the API refuses placeholder values in production |
| `COOKIE_SECURE` | API | `true` |
| `AI_PROVIDER` | AI service | `deterministic`, no keys |
| `SEED_DEMO_DATA` | migrate | `false` (the local seed also skips itself in demo mode) |

## 10. Deployment configuration

[`deploy/public-demo/`](../../deploy/public-demo/) contains `compose.yml`, `nginx.conf.template`, `env.example`, `reset.sh` and `check-config.mjs`. The shared `docker-compose.yml` used for development is unchanged.

**Configuration check:** `node deploy/public-demo/check-config.mjs` renders the Compose file with placeholder secrets and fails unless:
- only the proxy publishes ports, and only 80 and 443;
- no service uses the host network or runs privileged;
- every service has a memory limit;
- demo mode, Secure cookies, `TRUST_PROXY=uniquelocal` and the investigation limits are set for the API, worker and setup;
- the AI service runs the rule-based engine with no key;
- no service is given `PUBLIC_DEMO_OWNER_PASSWORD`.

Run it before every deployment.

- **Published ports:** only `proxy` publishes ports (80, 443). Docker-published ports bypass host firewalls such as UFW, so no other service has a `ports:` entry. PostgreSQL, Redis, the API and the AI service are reachable only on the internal network.
- **Restarts and health:**
  - `restart: unless-stopped` on every long-running service;
  - health checks on every service except the proxy, which has none.

  The proxy starts only once `web` is healthy. Nginx resolves `web` when it starts, so restart the proxy after recreating the web container.
- **Memory limits:**
  - PostgreSQL and the AI service: 768 MB each;
  - API, worker, web and migrate: 512 MB each;
  - Redis and the proxy: 128 MB each.

  That is about 3.8 GB when every limit is reached, within the 6–12 GB of the planned instance. Typical use is far lower.
- **Logs and data:** json-file logs rotated at 10 MB × 3. Named volumes hold PostgreSQL and Redis data.
- **Migrations and setup:** `migrate` runs `prisma migrate deploy`, then the idempotent `public-demo setup`, before the API and worker start.
- **First start:** `setup` does not start the seeded investigations, so a fresh deployment shows no investigation until the first reset. Run `./reset.sh` once after the first `docker compose up -d`. It runs `reset --investigate`, which rebuilds the demonstration and starts one rule-based investigation per open incident. The cron entry then repeats this.
- **TLS:** Nginx serves the certificate from `/etc/letsencrypt` on the host. The configuration redirects HTTP to HTTPS and sets HSTS.
  - Nginx refuses to start until the certificate files exist (checked with `nginx -t`), so the first certificate cannot come through Nginx.
  1. Before the first start, with nothing listening on port 80 and port 80 reachable from the internet, obtain it with certbot's standalone mode: `sudo certbot certonly --standalone -d <DEMO_HOSTNAME>`.
  2. Start the stack (`docker compose up -d`). The proxy now starts, because the certificate files exist, and it serves `/.well-known/acme-challenge/` from `/var/www/certbot` on port 80.
  3. With the proxy running, switch the certificate's renewals to that webroot and reload the proxy after each renewal (certbot 2.3 or later; `reconfigure` tests the new settings, so the proxy must be up): `sudo mkdir -p /var/www/certbot && sudo certbot reconfigure --cert-name <DEMO_HOSTNAME> --webroot -w /var/www/certbot --deploy-hook "docker compose -f /opt/opsilume/deploy/public-demo/compose.yml exec -T proxy nginx -s reload"`.
  4. Confirm with `sudo certbot renew --dry-run`. The certbot package's timer then renews automatically.
  - **None of this has been run against a real domain** (see the readiness report).
- **Abuse limits:**
  - per address: 10 requests/s on `/api/` (burst 40) and 1 request/s on `/api/v1/auth/` (burst 10);
  - 20 connections per address;
  - request bodies of at most 256 KB (the API also refuses more than 256 KB in demo mode, `413`);
  - refusals answered with `429`;
  - a path containing `..`, an encoded dot or an encoded `%` refused with `400`. Such a path, `/api/../metrics` for example, was matched by Nginx as `/metrics` but forwarded as sent, and reached the API's unauthenticated `/metrics`, `/ready` and `/health` through the web app's `/api/*` rewrite. That was found in the readiness validation and fixed there.
- **ARM64:** every image has an arm64 build, and the images build on ARM64 (feasibility audit, section 4). Build them on the host itself (`docker compose build`).

## 10b. API rate limits

| Limiter | Limit | Key | Where |
|---|---|---|---|
| Every `/api/v1` request | 1200 a minute | client address | `app.ts` |
| Sign-in endpoints (`/auth/login`, `/register`, `/demo`, `/refresh`, `/accept-invitation`): one count shared by all of them | 20 a minute | client address | `modules/auth.ts` |
| Demo entry (`POST /auth/demo`) | 60 an hour | client address | `modules/auth.ts` |
| Failed sign-ins (refused in demo mode anyway) | 10 per 15 minutes | account email | `modules/auth.ts` |

**Per visitor session**, the API has no request rate limit. The per-session bound is the investigation quota (section 6), which is counted in the database.

**How they behave:**
- **In memory, per process.** Counts live in the API process's memory (the library's default store, `express-rate-limit` 7.5).
- **Restart.** After a restart every count starts from zero. A client refused just before a restart is allowed again (tested).
- **Addresses.** Every full address is its own key: IPv6 addresses are not grouped by prefix.
- **What survives a restart:** Nginx's per-address limits and the investigation quotas, which are counted from the database. The restart itself is visible in the logs.

**The deployment runs one API process:** one `api` container, started with `node dist/src/server.js`, with no cluster mode and no replicas. The worker serves no API routes. These limits are therefore the whole picture for one host, and they are not distributed or durable.

**Before running more than one API process or replica:**
- move the stores to a shared one (for example `rate-limit-redis` on the existing Redis), or keep the limits at Nginx only;
- check that every replica sees the same client address.

Without that, each process allows the full limit, which the tests show for two processes.

**Tested** (`tests/rate-limits.test.ts`, the only file that switches the limiters on):
- the 20th sign-in request allowed and the 21st refused, across different sign-in endpoints;
- another address unaffected, and a forged address in front not opening a new count;
- the 11th failed sign-in for one account refused from a new address;
- the 1200th `/api/v1` request allowed and the 1201st refused;
- counts lost on restart, and not shared between two processes.

**Not tested:**
- the hourly demo-entry limit (60, reached only over three minutes or more);
- the reset of a window when the minute passes.

## 10a. Client addresses

The per-address limits (Nginx's, and the API's rate limiters and investigation quotas) are only as good as the address each layer believes. The chain:

1. **Nginx** sees the TCP peer, and in every location sets `X-Forwarded-For $remote_addr`. That overwrites whatever the client sent; it does not append.
2. **The web app** (Next.js 15.5 rewrites) passes `X-Forwarded-For` to the API unchanged and adds no address of its own. This was checked against a production build of the web app with an echo server as the API: no header in, none out; one or two values in, the same out.
3. **The API**, with `TRUST_PROXY=uniquelocal`, skips private addresses (its peer, the web container, and any private hop) from the right and takes the first public one.

**Spoofing:**
- A forged `X-Forwarded-For` sent to the public endpoint is discarded by Nginx.
- Even if a proxy appended instead of overwriting, the API takes the right-most public address, not the forged left-most one.
- A connection from a public address to the API would not be believed at all, but the API is not published.

**Bypass:** Nginx is the only published service (`check-config.mjs`). The web app and the API are reachable only on the internal network. A request reaching the web app directly would pass its own `X-Forwarded-For` to the API unchanged, which is why the web app must never be published.

**Without a forwarded address**, every request appears to come from the web container. The per-address limits then act as one limit shared by everyone: stricter, never absent.

**Evidence:**
- automated: `apps/api/tests/client-address.test.ts` (the trust rules, the API's body limit, and the Nginx template's header, rate and body settings) and a test in `public-demo.test.ts` that drives the API through a trusted proxy with forged headers;
- the Next.js behaviour observed above;
- a run of the real Nginx template in a throwaway container (default bridge network) in front of an echo server:
  - a forged `X-Forwarded-For` was replaced;
  - a 300 KB body got `413`;
  - 40 rapid requests to `/api/v1/auth/` got 11 × `200` and 29 × `429`;
  - 120 rapid requests to `/api/` got 52 × `200` and 68 × `429`;
  - plain HTTP was redirected to HTTPS.

**To verify on the real host:** in that run, Docker Desktop's port forwarding made every client appear to Nginx as the Docker gateway (`172.17.0.1`). On a Linux host, Docker's iptables publishing normally preserves the client's IPv4 address. Docker's userland proxy (used, for example, for some IPv6 set-ups or when iptables is disabled) does not. If Nginx's access log shows the gateway address for outside clients, every per-address limit becomes one global limit. **Check the access log after the first deployment.**

## 11. Security assumptions

- The host, its Docker daemon and the `.env` file are trusted and controlled by the operator. SSH is key-only, from the operator's addresses.
- The visitor account's email is fixed (`lib/demo.ts`). Outside demo mode, that account is an ordinary VIEWER.
- Visitors share one account and one organisation, told apart by the session each entry creates (section 5). Whoever holds a visitor's session cookies is that visitor: the cookies are HttpOnly, SameSite=Lax and Secure.
- Nginx sees real client addresses on the host (section 10a).
- There has been no external security review and no penetration test.

## 12. Testing evidence (18 November 2026, local)

### Security review and remediation (18 November 2026)

A security review of the demo mode, followed by an independent review of the code with no access to the first reviewer's conclusions, found:

| Finding | Severity | Resolution |
|---|---|---|
| One visitor could see and cancel any other visitor's investigations and read their questions | High | Fixed: isolation by session (section 5) |
| One visitor could use up the day's investigation quota | High | Fixed: per-session, per-address and atomic demo-wide quotas (section 6) |
| An optional owner password turned the public endpoint into an administrator login | High | Fixed: no sign-in but the visitor's; `PUBLIC_DEMO_OWNER_PASSWORD` retired (section 3) |
| A replayed visitor refresh token signed out every visitor | Medium | Fixed: it ends that session only |
| Starts checked limits before inserting, so parallel requests could all pass | Medium | Fixed: check and insert under an advisory lock. This applies outside demo mode too, as does the 20-a-minute limiter now on `/auth/refresh` |
| Sessions entered from one address and used from another escaped the per-address limits | Medium | Fixed: entry and use addresses count together |
| Proposed actions of a visitor's run wrote "Remediation proposed" to the shared timeline | Medium/low | Fixed |
| Knowledge attribution read the latest run of an incident, whichever session it was | Low | Fixed: visitor runs and their proposals are excluded |
| Nginx's `/api/` limits were case-sensitive, while the web app routes `/API/` the same | Low | Fixed: case-insensitive locations (exercised) |
| Every anonymous CSV export wrote an audit row | Low | Fixed for the visitor |
| Upstream error text in the analysis and system status | Info | Generic message for the visitor |
| API keys accepted, webhook entry offered, body limit 5 MB in demo mode | Low | All refused or reduced in demo mode |
| A reset could fail under traffic | Plausible | The reset closes the demo first and retries (not tested under traffic) |

**Not changed** (accepted, section 13):
- aggregate analytics stay shared;
- per-address limits use full addresses, not IPv6 prefixes;
- the worker checks the engine on the run's first event, not again on the final report.

### Results

| What | How | Result |
|---|---|---|
| Visitor boundary, isolation (including a sweep of 30 visitor-readable endpoints for another session's run), quotas, races, sign-in refusals, setup and reset | `apps/api/tests/public-demo.test.ts`, against PostgreSQL and Redis in throwaway containers. Each refused route is first shown to exist with the flag off | **63 / 63** |
| Client addresses, body limit, Nginx template | `apps/api/tests/client-address.test.ts` | **10 / 10** |
| Visitor runs end to end with a real worker and queue: time limit, cancellation, slots, runs side by side, failure wording, reset during a run | `apps/api/tests/public-demo-lifecycle.test.ts` (real BullMQ on Redis, scripted analysis service, the real setup and reset script) | **5 / 5** |
| API rate limiters | `apps/api/tests/rate-limits.test.ts` | **7 / 7** |
| Whole API suite | `npm test -w @opsilume/api` | **508 / 508** |
| Web | `npm test -w @opsilume/web` | **74 / 74** |
| AI service (includes the new tool-error tests); P7 harness unit suite (P7 code unchanged) | `uv run pytest`, `ruff check`; `node --test prototype/m16-p7/test/*.test.mjs` | **358 passed**, ruff clean; **480 / 480** |
| Lint, typecheck, generated contracts | `npm run lint`, `npm run typecheck`, `npm run contracts` twice | Clean. Generated files stable; their only change is the session's `demoVisitor` field |
| Compose configuration | `node deploy/public-demo/check-config.mjs`; `docker compose config` without secrets | Passed; refused (exit 1) |
| Next.js header pass-through | A production build of the web app in front of an echo server | `X-Forwarded-For` passed unchanged; none added |
| Nginx | The real template in one throwaway container (default bridge network) with a self-signed certificate, in front of an echo server | Forged header replaced; 413 over 256 KB; 429 beyond the burst on `/api/` and `/api/v1/auth/`, also for `/API/...`; HTTP redirected. Every client appeared as the Docker gateway, so the limits were shown to trigger, not to be kept per client |
| Mutation checks | Each removed in turn: the advisory lock, the linked-address quota, the visitor timeline guard, the visibility scope, the cancellation check and the visitor failure wording. The configuration check was also given a 15-minute time limit | The corresponding test or check failed each time |
| End to end on the host (implementation stage) | API, worker and AI service as processes, `PUBLIC_DEMO_MODE=true` | Passed before this review; not repeated after it |

**Not tested:**
- **The containers of `deploy/public-demo` together.** Local Docker had no free network address space for another Compose project.
- **TLS issuance and renewal.**
- **Whether Nginx sees real client addresses on the real host** (section 10a).
- **The hourly demo-entry limit, and window resets of the API limiters.**
- **A reset under live traffic.**
- **The web pages against a running demo.** They were tested with a mocked API.
- **Anything on a public host. No external security review or penetration test.**

## 13. Remaining risks

- **Shared visitor account:**
  - aggregate figures and the knowledge base are shared;
  - whoever holds a visitor's cookies is that visitor;
  - a visitor with many addresses (an IPv6 prefix, for example) can use up the day's demo-wide quota, and two addresses can hold both analysis slots until their runs end.
- **Per-address limits depend on the host** passing real client addresses to Nginx (section 10a).
- **The API's limiters** are in memory, per process: they reset on restart and would not be shared by a second replica (section 10b).
- **A worker that dies mid-run** holds a slot for up to 7 minutes, until the sweep.
- **No WAF.** The proxy does the throttling for unauthenticated traffic.
- **The reset briefly makes the demo unavailable**, and under heavy traffic it may need its retries or fail. It exits non-zero; check cron mail or logs.
- **No monitoring or alerting** beyond health checks.
- **Single host:** no redundancy.

## 14. Running the demo locally

```bash
npm run infra:up                                   # PostgreSQL and Redis
export PUBLIC_DEMO_MODE=true                       # plus DATABASE_URL, REDIS_URL and the secrets from .env
npm run db:migrate
npm run public-demo -w @opsilume/api -- setup      # add --investigate with the AI service running (AI_PROVIDER=deterministic)
npm run dev                                        # open the sign-in page and choose "Explore the demo"
npm run public-demo -w @opsilume/api -- reset      # rebuild the demonstration organisation
npm run public-demo -w @opsilume/api -- status
```

While the flag is on, no account but the visitor can sign in, and API keys are refused, so a development database's own accounts are unusable. Turn the flag off again, and they work as before. Nothing about them is changed.
