# Oracle Cloud Always Free: feasibility audit for the OPSILUME portfolio demo

**Date:** 18 November 2026. **Repository state inspected:** branch `prototype/m16-p7-durability-harness`, HEAD `1aec15dd6966b19f0ead445260cbf3be29b11df1`, clean working tree.

**Scope:** research, inspection and documentation only. No Oracle account was created or used, nothing was provisioned, and no application code, Dockerfile or Compose file was changed. All Oracle facts come from public pages read on 18 November 2026 (section 15).

**Status note (18 November 2026, deployment readiness validation; the audit below is unchanged).** Read it together with [DEPLOYMENT_READINESS_REPORT.md](DEPLOYMENT_READINESS_REPORT.md).

**What changed since the audit:**
- The section 11 application changes are implemented on `feature/opsilume-public-demo` (commit `80df9d9`, not merged), with one difference: there is no published visitor account. Visitors enter without a password, and nobody else can sign in on the public endpoint.
- The demo allows **2** concurrent investigations, not 3, with a 2-minute time limit.

**Measured in the readiness validation:**
- The long-running services' memory limits total about 3.3 GB, as estimated in section 5. The one-off `migrate` container adds 512 MB while it runs.
- The stack used about **530 MiB at idle** (arm64 containers on Docker Desktop).
- The locally built images are larger than the section 5 figures: API 854 MB, AI 696 MB, web 464 MB, before the base images. Allow 3–5 GB of disk for images and build cache.

**What the owner must still verify personally before provisioning:** the section 16 checklist, in particular:
- the A1 allowance and capacity actually shown in the console;
- card acceptance;
- the permanent home region;
- not upgrading the account;
- a domain or host name that can receive a Let's Encrypt certificate (ports 80 and 443 reachable from the internet).

Labels used throughout:

| Label | Meaning |
|---|---|
| **OFFICIAL** | An Oracle (or Let's Encrypt) page says so |
| **COMMUNITY** | A forum, blog or news report; not an entitlement |
| **MEASURED** | Observed on this repository's stack on the development machine |
| **ESTIMATE** | My estimate; the assumptions are stated |
| **UNVERIFIED** | Depends on the owner's account, region or a test that has not been run |

## 1. Executive summary

OPSILUME's full stack fits comfortably in Oracle's **current** Always Free Ampere A1 allowance, and every container image it uses exists for ARM64.
- **The allowance:** 2 OCPUs and 12 GB of memory (OFFICIAL). This is half of the long-quoted 4 OCPUs and 24 GB; see section 3.
- **ARM64:** the whole stack already runs on linux/arm64 on the development machine (MEASURED).
- **Memory:** about 0.66 GB at idle, and about 1.3 GB at peak for everything except the web container, under the recorded load test (MEASURED).

A ₹0 deployment is technically realistic. It is not yet safe or certain:

1. **Account-specific and unverifiable here (UNVERIFIED):**
   - card acceptance at sign-up;
   - A1 capacity in an Indian home region;
   - whether Oracle keeps the allowance at today's figure.

   Mumbai and Hyderabad each have one availability domain, and community reports describe Mumbai A1 capacity as scarce.
2. **Security blockers in the application for a public instance:**
   - the seed data publishes working passwords for an OWNER and an ADMIN account;
   - self-registration is open;
   - approved remediations can send outbound webhooks;
   - there is no scheduled reset.

   These need a small "public demo mode" before any public exposure (section 11).
3. **Operational conditions:**
   - idle-instance reclamation rules apply;
   - the account itself can be suspended after 30 days of inactivity;
   - Oracle gives no support to Always Free-only accounts;
   - HTTPS without a paid domain needs either a free third-party subdomain or Let's Encrypt's 6-day IP-address certificates.

## 2. Recommendation

**CONDITIONAL GO.** Proceed with Oracle Cloud Always Free (Ampere A1) only if all of these hold:

1. **Account and capacity:** the owner can create a Free Tier account with an accepted card, choose a home region, and obtain an A1 instance there of at least 1 OCPU and 6 GB, staying within 2 OCPUs and 12 GB in total.
2. **No Pay As You Go upgrade:** the account is never upgraded. After an upgrade, usage above the free limits is charged (OFFICIAL).
3. **Demo mode first:** the public-demo changes in section 11 are implemented and reviewed **before** the instance is reachable from the internet.
4. **HTTPS without spending:** HTTPS is set up at ₹0 with one of the options in section 6.

If condition 1 cannot be met within a reasonable number of attempts, fall back as described in section 13. Do not switch to a paid provider. The Always Free AMD micro instances (1 GB of memory each) are **not** sufficient for the full stack (NO-GO for that shape).

## 3. Oracle entitlement findings

| Question | Finding | Source type |
|---|---|---|
| Is A1 Always Free offered? | Yes. "All tenancies get the first 1,500 OCPU hours and 9,000 GB hours per month … For Always Free tenancies, this is equivalent to 2 OCPUs and 12 GB of memory" | OFFICIAL (Always Free resources page; free tier overview) |
| Conflicting figure | The Arm compute page still says 3,000 OCPU hours and 18,000 GB hours (4 and 24). Community reports say the allowance was halved in mid-2026 without an announcement; the date differs between reports | OFFICIAL pages conflict; COMMUNITY dates. **Plan for 2 OCPUs and 12 GB** |
| AMD micro | Up to two VM.Standard.E2.1.Micro, each 1/8 OCPU (burstable), 1 GB, 50 Mbps | OFFICIAL |
| Block storage | 200 GB in total for boot and block volumes combined, plus 5 volume backups, in the home region. Minimum boot volume 47 GB or 50 GB (the same page says both) | OFFICIAL |
| Public IPv4 | Instances can have a public IP and the price list has no public-IP charge. No official sentence says an IPv4 is free, and the reserved-IP limit for an Always Free-only account is not stated | OFFICIAL (indirect); count UNVERIFIED |
| Egress | 10 TB a month outbound free; inbound free. Above 10 TB is priced per GB. Not stated what happens above it on a non-upgraded account | OFFICIAL; behaviour above the limit UNVERIFIED |
| Load balancers | One Flexible Load Balancer (10 Mbps) and one Network Load Balancer | OFFICIAL. Not needed for this design |
| Object Storage | 20 GB and 50,000 requests a month for an Always Free-only account | OFFICIAL |
| HTTPS | Let's Encrypt certificates on the VM. Let's Encrypt also issues certificates for IP addresses, with a 6-day life, the `shortlived` profile and http-01 or tls-alpn-01 validation. The OCI load balancer only imports certificates | OFFICIAL (Let's Encrypt, Oracle) |
| Home region | Always Free compute and storage only in the home region, chosen at sign-up and permanent. India: Mumbai (`ap-mumbai-1`) and Hyderabad (`ap-hyderabad-1`), one availability domain each | OFFICIAL |
| A1 in India | No official statement of A1 Always Free availability per region. Mumbai A1 capacity is described as "notoriously scarce", Hyderabad as somewhat better | COMMUNITY; UNVERIFIED |
| Capacity errors | "Out of host capacity … might take several days"; advice: try another availability domain, wait, or upgrade. Indian regions have no second availability domain | OFFICIAL; frequency COMMUNITY |
| Idle reclamation | An instance is idle if, over 7 days, 95th-percentile CPU is below 20%, network utilisation is below 20%, and (A1 only) memory utilisation is below 20%. Idle instances may be reclaimed | OFFICIAL. An exemption for upgraded accounts is COMMUNITY (2023) only |
| Account inactivity | "Accounts left idle for 30 days or more may be deemed abandoned and become eligible for suspension or termination" | OFFICIAL |
| Card | Most users need a mobile number and a credit card. A $1 authorisation at sign-up is reversed. PIN debit, virtual, single-use and prepaid cards are not accepted. RuPay cards are reported to be declined | OFFICIAL; India-specific COMMUNITY |
| Staying free | After the $300 / 30-day trial the account stays active and Always Free resources remain. "Your credit card will not be charged unless you upgrade your account." A1 beyond the limit is disabled, then deleted | OFFICIAL |
| Exceeding limits | Not upgraded: blocked or reclaimed rather than billed (inference from the official wording; not stated outright). Upgraded: "will only charge you for resource usage above the Always Free limits" | OFFICIAL / inference |
| Other | Outbound SMTP port 25 blocked by default. No Oracle Support for Always Free-only accounts. One free account per person. Ubuntu 24.04 aarch64 images are available | OFFICIAL |

**What can only be confirmed in the owner's account:**
- eligibility, including card acceptance;
- the home-region choice;
- A1 capacity at the time of creation;
- the allowance the console shows (2/12 or 4/24);
- the reserved-IP limit;
- the image list.

## 4. ARM64 compatibility

**Evidence:** the development machine is Apple M4 (`arm64`). Docker Desktop's VM is `linux/aarch64`, and every image of the running stack is `linux/arm64`. The stack has run that way continuously (MEASURED: `docker image inspect` and `docker info`). The published platforms of every base image were read from the registries with `docker buildx imagetools inspect`.

| Component | ARM64 support | Evidence | Required changes | Risk |
|---|---|---|---|---|
| Node.js 22 (`node:22-slim`) | Yes | Registry lists `linux/arm64/v8`; local API, worker and web images built from it are arm64 | None | Low |
| Next.js 15.5 and React 19 (web) | Yes | Local web image arm64, running; `output: 'standalone'` | None | Low |
| Express 5 and the API (TypeScript) | Yes | Pure JavaScript; local API image arm64 | None | Low |
| Prisma 6.19 | Yes, when the image is built on ARM64 | `schema.prisma` declares no `binaryTargets`, so the engine for the build platform is installed; the local arm64 build runs | Build on ARM64 (on the VM, or locally on Apple silicon). Cross-building on amd64 would need `binaryTargets` | Low |
| bcryptjs | Yes | Pure JavaScript, no native build | None | Low |
| BullMQ, ioredis | Yes | Pure JavaScript | None | Low |
| PostgreSQL 16 + pgvector (`pgvector/pgvector:pg16`) | Yes | Registry lists `linux/arm64`; running locally | None | Low |
| Redis 7 (`redis:7-alpine`) | Yes | Registry lists `linux/arm64/v8` | None | Low |
| Python 3.12 (`python:3.12-slim`) and uv (`ghcr.io/astral-sh/uv:0.5`) | Yes | Registry lists arm64 for both | None | Low |
| FastAPI, LangGraph, LangChain, Anthropic SDK, pydantic-core and other native wheels | Yes | The AI image built from `uv.lock` on linux/arm64 without a compiler in the image (`python:3.12-slim`), so every dependency resolved to an aarch64 wheel; it runs | None | Low |
| Reverse proxy (not in the repository) | Yes | `nginx:1.27-alpine` and `caddy:2-alpine` both list `linux/arm64/v8` | A proxy service must be added (section 5) | Low |
| Prometheus, Grafana (optional) | Yes | Both list arm64 | Not needed for the demo | Low |
| Docker Engine and Compose on Ubuntu 24.04 aarch64 | Yes | Ubuntu 24.04 aarch64 images are offered for A1 (OFFICIAL) | Install Docker on the VM | Low |
| CPU microarchitecture | Probably compatible | The local CPU (Apple M4) is newer than Ampere Altra (Neoverse N1). Generic arm64 builds target the common baseline, but a binary built for newer CPU features would fail on N1 | Build on the VM, or test-run the images there before relying on them | Low to medium (UNVERIFIED) |

No AMD64-only image or dependency was found.

## 5. Resource estimates

**Measured on the development machine** (rule-based engine, the seeded demo dataset, linux/arm64):
- Idle memory of the running stack: web 103 MiB, API 88 MiB, worker 108 MiB, AI service 270 MiB, PostgreSQL 68 MiB, Redis 27 MiB, about **664 MiB** in total.
- Under the recorded load test (400,000 log lines, 40 investigations three at a time), the API, worker, database, queue and analysis service together peaked at about **1.3 GB**. The web container is not included ([pilot-acceptance-report.md](../pilot-acceptance-report.md), section 10).
- Image sizes: API 187 MB, web 107 MB, AI 136 MB, pgvector 154 MB, Redis 17 MB, about 0.6 GB in total.
- The seeded database (32,700 log lines, 19 incidents) is 123 MB.

**Estimates** (assumptions: Ubuntu 24.04 minimal with Docker uses about 0.5–0.8 GB; a reverse proxy uses about 30–60 MB; images are built on the VM; the rule-based engine only; no model inference):

| Scenario | What it means | RAM, typical / peak | CPU | Disk |
|---|---|---|---|---|
| A. Minimal demo | A few visits a day, occasional investigation | 1.5 GB / 2 GB including the OS | Near idle; short bursts on one core | Images ~0.6 GB, build cache 3–5 GB, database < 0.5 GB, logs < 1 GB with rotation. About 10 GB used of a 47–50 GB boot volume |
| B. Small concurrent exploration | 5–20 visitors at once, a few investigations at a time (the limit is 3 concurrent) | 2 GB / 3 GB | 1 OCPU busy in bursts; 2 OCPUs comfortable | As A, plus database growth from visitor writes until the scheduled reset |
| C. Beyond practical capacity | Sustained ingestion at load-test rates, dozens of simultaneous investigations, scraping, or an attack | 3–5 GB+; PostgreSQL and the AI service grow | 2 OCPUs saturated; latency degrades | Database and logs grow quickly without limits |

**Building on the VM:** `next build` and `npm ci` are the largest memory users, roughly 2–3 GB (ESTIMATE). With 6–12 GB this is fine, and builds run while the demo is down or before it starts. An alternative is to build the arm64 images on the owner's Apple-silicon machine and copy them over; this avoids the build cache on the VM.

**Suggested Compose memory limits** (ESTIMATE, to be tuned against measurements on the VM):

| Service | Limit |
|---|---|
| postgres | 768 MB |
| redis | 128 MB |
| api | 512 MB |
| worker | 512 MB |
| ai | 768 MB |
| web | 512 MB |
| proxy | 128 MB |

That is about 3.3 GB, which leaves room for the OS within a 6 GB instance. Redis keeps the queue, so it must not be given an eviction policy that drops jobs; its data set is small.

**Recommended shape:**
- **Preferred:** 2 OCPUs and 12 GB, the whole allowance, in one instance.
- **Smaller:** 1 OCPU and 6 GB also fits scenarios A and B, at about 40% memory use. Leaving room in the allowance does not matter for a single-VM design.
- **Not suitable:** the AMD micro shape.

## 6. Proposed deployment topology

```
Internet
   │  TCP 443 (and 80 for ACME and the redirect only)
   ▼
OCI security list + host firewall: allow 22 (owner's IP only), 80, 443
   │
   ▼
Reverse proxy (Caddy or Nginx): TLS, request-size limit, basic rate limit
   │  http://web:3000
   ▼
web (Next.js) ── proxies /api/* ──▶ api (Express) ──▶ postgres (pgvector)   ┐
                                         │  ▲          redis (BullMQ)        │ internal Compose
                                         ▼  │                              │ network only;
                                        worker ──HTTP──▶ ai (FastAPI)       │ no published ports
                                                 ai ──read-only tool API──▶ api ┘
```

Based on the repository as it is:

- **Public surface.** Only the proxy publishes ports. The web container already proxies `/api/*` to the API (`apps/web/next.config.ts`), so the API, its `/metrics` endpoint, the AI service, PostgreSQL and Redis need no public port.
  - The current `docker-compose.yml` publishes all of them on `127.0.0.1`. A deployment override must remove those mappings instead of relying on loopback.
  - Docker-published ports bypass a host firewall such as UFW, so "not published" is the protection that counts.
- **AI service privileges.** It has no database access and reaches data only through the API's read-only, organisation-scoped tool API (architecture.md). Run it with `AI_PROVIDER=deterministic` and with no model keys in its environment.
- **Persistence.** PostgreSQL in a named volume. Redis keeps its append-only file in a named volume (already configured). Both live on the boot volume or a separate block volume within the 200 GB.
- **Health and restarts.** Every application service already has a health check and `restart: unless-stopped`. Docker starts on boot, so the stack recovers after a VM reboot.
- **Migrations and seed.** The existing `migrate` service runs `prisma migrate deploy` and seeds only an empty database. Section 11 changes what the seed contains for a public instance.
- **TLS.** Options, all ₹0:
  - **(a)** A free subdomain from a third-party dynamic DNS service, with a normal 90-day Let's Encrypt certificate. This is a third-party dependency; check its terms.
  - **(b)** A Let's Encrypt IP-address certificate (6 days, `shortlived` profile, http-01 or tls-alpn-01). Needs an ACME client that supports profiles and dependable automatic renewal. Client support has not been verified (UNVERIFIED).
  - **(c)** A domain the owner already has.

  A purchased domain is out of budget.
- **Logs.** Docker's json-file driver with rotation (for example `max-size` 10 MB, `max-file` 3). The application logs carry no request bodies or headers (architecture.md).
- **Backups.** The repository's `npm run backup` tooling can write to the block volume. Because the demo data is disposable and reseeded, backups protect only the configuration. Optionally copy them off the VM by downloading, or to Object Storage within its 20 GB (that needs credentials on the VM; prefer downloading).
- **Monitoring.** Health checks, `docker ps` and the API's `/ready` endpoint. External uptime monitoring is optional and not assessed.
- **Reset.** A scheduled job (host cron) restores the seeded database, for example nightly. It does not exist yet (section 11).

## 7. Zero-cost analysis

| Resource | Proposed service | Monthly cost | Free-tier condition | Risk |
|---|---:|---:|---|---|
| Compute | 1 A1 instance, ≤ 2 OCPUs and ≤ 12 GB | ₹0 | Within the Always Free A1 allowance; home region; account not upgraded | Capacity may be unavailable; the allowance changed in 2026 and may change again; idle reclamation |
| Boot volume | 47–50 GB minimum, up to ~100 GB | ₹0 | Boot and block volumes within 200 GB in total | Low |
| Block storage | Optional data volume | ₹0 | Within the same 200 GB | Low |
| Public IP | One public IPv4 on the instance | ₹0 | No public-IP charge found; not stated explicitly | UNVERIFIED for the reserved-IP count |
| Network egress | Demo traffic | ₹0 | First 10 TB a month free | Behaviour above 10 TB on a non-upgraded account not stated |
| HTTPS | Let's Encrypt on the VM | ₹0 | Free service; needs a domain name or an IP certificate | Renewal automation; IP certificates last 6 days |
| Backups | 5 volume backups or Object Storage ≤ 20 GB, or download | ₹0 | Within those limits | Object Storage over 20 GB at trial end is deleted |
| Monitoring | Health checks on the VM | ₹0 | None | No alerting |
| Domain | Free third-party subdomain, or none (IP certificate) | ₹0 | Third-party terms | A purchased domain is **not** free and needs owner approval |
| AI inference | Built-in rule-based engine | ₹0 | No API keys on the server | None, provided no key is configured |

**Must avoid:**
- upgrading to Pay As You Go (usage above the free limits becomes billable);
- paid shapes, or more than 2 OCPUs and 12 GB of A1;
- volumes beyond 200 GB;
- the load balancer beyond its free tier (it is not needed anyway);
- Object Storage beyond 20 GB;
- any paid DNS, domain or AI provider.

Budget alerts are not a hard cap.

## 8. Portfolio demo feasibility

The existing code supports most of a public demo without architectural change:
- **No model needed:** the rule-based engine runs investigations with no model, and every report says which engine produced it.
- **Seeded data:** realistic fictional data already exists (the Acme demo organisation, with an active incident).
- **Limits already in place:** investigations are limited per day and in concurrency (`INVESTIGATION_DAILY_LIMIT` 50, `INVESTIGATION_MAX_CONCURRENT` 3); API requests per IP per minute (1,200); and request bodies (5 MB).
- **No production changes:** remediation never changes anything itself; an approval at most sends a signed webhook to a destination an admin configured.

**Minimum work before a public demo:**
- **Visitor access.** Provide a visitor account whose credentials are shown on the sign-in page. Give it the ENGINEER role, so it can start investigations and walk through proposals, or VIEWER for read-only. Owner and admin accounts must get random passwords.
- **No registration.** Turn self-registration off.
- **No outbound actions.** In demo mode, no webhook destinations, no integration secrets, and no GitHub sync of repositories a visitor adds; manual attestation only.
- **Bounded writes.** Stricter limits on ingestion and on request size at the proxy, plus the scheduled reset.
- **A visible notice.** Fictional data, rule-based engine, reset schedule.

None of this has been implemented. Section 11 lists it as work items.

## 9. Security assessment

**Critical blockers before any public exposure:**
1. **Published privileged credentials.** The seed creates all demo users with the documented password `Opsilume-demo-1` (`apps/api/prisma/seed.ts`), including the OWNER `demo@example.com` and an ADMIN. The README publishes it. On a public instance, anyone could sign in as OWNER and manage members, API keys, integrations, settings and webhooks.
2. **Open self-registration.** `POST /api/v1/auth/register` (rate-limited) creates accounts and organisations without bound.
3. **Outbound requests from the server.** An ADMIN, which anyone is under blocker 1, can configure webhook destinations, and approved actions are then dispatched to them. `safeRequest` refuses private addresses, but the server would still send requests to arbitrary public hosts.
4. **Published internal ports.** Postgres, Redis, the API and the AI service are published on loopback in the current Compose file. They must not be published at all on the VM.

**Already in place:**
- `helmet`; CORS limited to `WEB_ORIGIN`; an Origin check on cookie-authenticated writes; `SameSite=Lax`, `HttpOnly` cookies;
- `COOKIE_SECURE` is configurable (it must be `true` behind HTTPS);
- refusal to start in production with placeholder secrets;
- per-account sign-in throttling;
- tenant isolation on every query;
- AES-256-GCM for stored integration secrets;
- request logs without bodies or headers.

**To do at deployment:**
- **SSH:** key-only (OCI images default to key authentication), port 22 open only to the owner's IP in the security list, no password login.
- **Host:** firewall, and unattended security updates.
- **Secrets:** generated on the VM, kept outside backups, never committed.
- **Docker socket:** never mounted into a container (none of the current services mounts it).
- **Oracle account:** MFA on the account.
- **Abuse protection:** proxy-level request limits.

**Not claimed:** no external security review, penetration test or certification has been done. Free-tier suspension, reclamation and account termination are operational risks (section 10).

## 10. Risks and limitations

| Risk | Likelihood | Effect | Mitigation |
|---|---|---|---|
| No A1 capacity in the home region (Indian regions have one availability domain) | Medium to high (COMMUNITY) | Cannot create the VM | Retry over days; choose the home region with care (it is permanent); fall back (section 13) |
| Card declined at sign-up (RuPay or debit) | Medium (COMMUNITY) | No account | A Visa or Mastercard credit card |
| Allowance reduced again, or official pages stay inconsistent | Unknown | Instance disabled or deleted if over the limit | Use the smallest shape that works (1 OCPU, 6 GB) |
| Idle reclamation (CPU, network and A1 memory all below 20% at p95 over 7 days) | Medium for a quiet demo | Instance stopped or reclaimed | A 6 GB instance using about 2–2.5 GB stays above 20% memory. This is an observation about Oracle's stated rule, not a guarantee. Keep the setup reproducible from the repository |
| Account suspended after 30 days of inactivity | Low if the owner logs in periodically | Account loss | Log in periodically; keep everything in Git |
| Upgrade to Pay As You Go | Owner action | Charges become possible | Never upgrade without a separate, explicit decision |
| No Oracle support | Certain | Self-service only | Accept |
| Single VM, no redundancy | Certain | Downtime on any fault | Acceptable for a portfolio demo; say so |
| Abuse of the public demo | Medium | Resource exhaustion, data defacement | Section 11 changes, proxy limits, scheduled reset |
| ARM64 CPU-feature mismatch (Neoverse N1 vs Apple M4) | Low | A binary fails at start | Build on the VM |

## 11. Required application changes (not implemented)

Configuration only (a deployment Compose override; the shared `docker-compose.yml` is unchanged):
1. A reverse proxy service with TLS; no published ports for any other service.
2. `COOKIE_SECURE=true`, `WEB_ORIGIN=https://<host>`, and `TRUST_PROXY` set for the proxy chain. Generated `JWT_SECRET`, `ENCRYPTION_KEY`, `INTERNAL_SERVICE_TOKEN` and `POSTGRES_PASSWORD`.
3. `AI_PROVIDER=deterministic`, no model keys, `OTEL_ENABLED=false`.
4. Memory limits and log rotation.

Code (a public "demo mode", behind one environment flag, with tests):
5. A seed variant: random passwords for OWNER and ADMIN; one published visitor account (ENGINEER or VIEWER, to be decided).
6. Registration disabled.
7. Webhook dispatch, integration-secret entry, API-key creation and GitHub sync of visitor-added repositories disabled or refused.
8. Tighter write limits for visitors (ingestion size and rate), in addition to the proxy limits.
9. A scheduled reset that restores the seeded state, and a visible demo notice.

Effort (ESTIMATE): small to moderate, measured in days. Each item is a bounded change with existing patterns to follow: permissions, environment configuration and the seed.

## 12. Deployment prerequisites

- An Oracle Free Tier account created by the owner, with MFA, and **not** upgraded.
- A home region chosen deliberately: Mumbai or Hyderabad, considering capacity reports.
- An A1 instance (1–2 OCPUs, 6–12 GB) running Ubuntu 24.04 aarch64, with an SSH key.
- Security list and host firewall: 22 from the owner's IP only, 80 and 443 open.
- A decision on the HTTPS option (section 6) and, if a subdomain is used, that provider's terms.
- The section 11 changes merged and reviewed.
- Docker Engine and the Compose plugin installed on the VM.

## 13. Fallback options

These are fallbacks only. None replaces the preferred target without the owner's decision.

1. **Keep retrying A1 capacity** over days in the chosen home region, ₹0. A small instance (1 OCPU, 6 GB) may be easier to obtain than the full 2/12. UNVERIFIED.
2. **A static, fixture-based demo** (a pre-rendered walkthrough of recorded API responses) on a free static host, plus the video and screenshots. ₹0, but no live backend: the portfolio would show the product, not run it.
3. **A recorded demo only:** the video, screenshots and the repository's local quick start. ₹0, with no public URL.
4. **Other providers' free tiers** were not evaluated here. Most free general-purpose VMs elsewhere offer about 1 GB of memory, below this stack's needs. Any credit-based or trial option is **potentially paid** and needs a separate decision.

## 14. Exact next steps

1. The owner decides on this audit: CONDITIONAL GO or not.
2. If yes, the owner creates the Oracle account and checks:
   - card acceptance, the home region and the A1 allowance shown in the console;
   - whether an A1 instance can be created.

   Nothing else is provisioned yet.
3. In parallel, implement and review the public demo mode (section 11) on a feature branch. It is useful for any hosting option.
4. Only then: provision the VM, deploy with the override, verify HTTPS, health, resource use and the reset, and record the results in [PROJECT_STATUS.md](../PROJECT_STATUS.md).

## 15. Sources

All accessed 18 November 2026. None of the Oracle pages showed a "last updated" date.

**Oracle (OFFICIAL):**
- https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm
- https://www.oracle.com/cloud/free/faq/
- https://www.oracle.com/cloud/free/
- https://docs.oracle.com/en-us/iaas/Content/Compute/References/arm.htm
- https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/managingpublicIPs.htm
- https://docs.oracle.com/en-us/iaas/Content/General/service-limits/default.htm
- https://docs.oracle.com/en-us/iaas/Content/General/Concepts/regions.htm
- https://www.oracle.com/cloud/public-cloud-regions/
- https://docs.oracle.com/en-us/iaas/Content/Billing/Tasks/changingpaymentmethod.htm
- https://www.oracle.com/cloud/price-list/
- https://www.oracle.com/cloud/pricing/
- https://docs.oracle.com/en-us/iaas/Content/Balance/Tasks/managingcertificates.htm
- https://docs.oracle.com/en-us/iaas/Content/certificates/overview.htm
- https://docs.oracle.com/en-us/iaas/images/ubuntu-2404/

**Let's Encrypt (OFFICIAL, for its own issuance policy):**
- https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability
- https://letsencrypt.org/docs/profiles/
- https://letsencrypt.org/2025/07/01/issuing-our-first-ip-address-certificate

**COMMUNITY (reports, not entitlements):**
- https://infoq.com/news/2026/07/oracle-cloud-free-tier-limits/ (3 July 2026)
- https://terminalbytes.com/oracle-cloud-free-tier-changes-2026 (26 June 2026)
- https://51sec.org/2023/02/24/oracle-cloud-cleaning-up-idle-compute-instances-how-to-keep-it
- https://dev.to/ashish-codejourney/getting-a-free-oracle-cloud-vps-from-india-the-full-guide-and-the-rupay-wall-nobody-warns-you-4p5o

**Repository evidence:** `docker-compose.yml`; `apps/api/Dockerfile`, `apps/web/Dockerfile` and `services/ai/Dockerfile`; `apps/web/next.config.ts`; `apps/api/src/app.ts`, `config/env.ts`, `lib/permissions.ts` and `modules/auth.ts`; `apps/api/prisma/schema.prisma` and `seed.ts`; `services/ai/pyproject.toml` and `uv.lock`; [pilot-acceptance-report.md](../pilot-acceptance-report.md).

## 16. Owner checklist before provisioning

- [ ] I accept CONDITIONAL GO and its conditions (section 2).
- [ ] I have a Visa or Mastercard credit card Oracle is likely to accept, and I understand the reversed $1 authorisation.
- [ ] I have chosen a home region (Mumbai or Hyderabad) and accept that it is permanent.
- [ ] I will **not** upgrade to Pay As You Go without a separate decision.
- [ ] I will enable MFA on the Oracle account and keep its credentials to myself.
- [ ] I accept the HTTPS option: free subdomain (provider: ___), IP certificate, or an existing domain.
- [ ] I accept that the public demo will run without AI inference (rule-based engine) on fictional, regularly reset data.
- [ ] The public demo mode (section 11) is implemented and reviewed before the instance is exposed.
- [ ] I accept the operational risks: no support, idle reclamation, account inactivity, capacity, single VM.
- [ ] I will confirm in the console the A1 allowance shown (2/12 or 4/24) and plan for the smaller figure.
