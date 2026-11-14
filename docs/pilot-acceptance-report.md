# Pilot acceptance report

Milestone 8, 14 November 2026. What has been verified about OPSILUME before an external team is asked to try it, what has not, and what must happen first.

**This is not a statement that OPSILUME is ready for production, or that a pilot will succeed.** No external team has used it. No model has been run against the current code. Every measurement here comes from one laptop. The purpose of this report is that whoever decides on a pilot knows exactly which claims rest on tests and which do not.

How to read it: "verified" means a test made the thing happen and checked the result, and names the test. "Not verified" means exactly that, however reasonable the code looks.

## 1. Supported integrations

| Integration | What it is | Verified | Not verified |
|---|---|---|---|
| Logs, metrics, deployments, service events | Four push endpoints, authenticated by scoped API keys | Ingestion, validation, association with services, status on the Integrations page, idempotent retries, behaviour under modest concurrent load | Volumes beyond those in section 6; any vendor's shipper or agent (none is provided: the sender posts JSON) |
| GitHub | Reads commits and pull requests by token; optional signed webhook | Everything, against a local stand-in for the GitHub API (section 5) | **Anything against github.com.** No token was supplied |
| Remediation webhook | Sends approved actions, signed, to an endpoint the customer runs | Dispatch, signing, idempotency key, timeouts and unknown outcomes, the test request, destination checks at connection time (section 2) | A real receiver in a customer network |
| Distributed traces | Reads a Jaeger-compatible query API, set per installation | Against a local Jaeger in the demo environment and a stand-in in tests | Any other trace store; per-organisation configuration (there is none) |
| Analysis engine | Rule-based by default; a language model if the operator configures one | Rule-based: 14 evaluation scenarios, every report pinned | **A language model with the current report format and tools** (section 7) |
| MCP server | Read-only tools for AI clients | In-process | With a real MCP client |

Not supported at all: pulling from log or metric vendors, paging tools, chat or e-mail delivery, GitLab or Bitbucket, single sign-on.

## 2. Security validation

### Outbound requests

**Defect found and fixed.** The address of a tenant's remediation webhook was checked by resolving its host name, and the request was then made by an HTTP client that resolved the name again. A DNS record that answered the check with a public address and the connection with an internal one (DNS rebinding) would have sent a signed request to an internal address. The check now happens in the lookup the connection itself uses, on every connection, so the socket is opened only to addresses that were checked.

Every outbound path was reviewed:

| Path | Destination chosen by | State |
|---|---|---|
| Webhook dispatch, webhook test request | Tenant | Checked at connection time; redirects not followed; only the status is read |
| GitHub API | Fixed host; repository name from the tenant | Redirects followed only within the API's own origin (three at most); dot-segment names refused |
| AI service, trace store | Operator | Not tenant-controlled |
| AI service to the API's tool endpoints | The API, under the internal token | Not tenant-controlled |

Verified by `apps/api/tests/netguard.test.ts`, which makes real connections with DNS played by a resolver the test controls:

- a request arrives at the checked address under the host name that was asked for;
- a name that passes the check when saved and then resolves inside is refused at the connection, and the internal server receives nothing;
- a different answer on each connection is checked each time;
- a name with one internal address among public ones is refused;
- IPv6 loopback, link-local, unique-local, IPv4-mapped, NAT64, 6to4 and Teredo answers are refused;
- literal addresses in decimal, hexadecimal, octal and short notation are refused, as are non-HTTP schemes and URLs with credentials;
- a redirect to a cloud metadata address is not followed;
- a certificate that does not match the host name fails the request;
- through the application: a rebound webhook is neither pinged nor sent an approved action, and the action is recorded as not applied.

Not verified: the previous code was not exploited end to end, which would need a DNS server that changes its answer between two real lookups. The gap was in the design and is closed by construction. No external penetration test has been done.

### Carried over from earlier milestones, unchanged

Organisation isolation on every query; credentials encrypted at rest or stored as hashes and never returned; approvals bound to content; the analysis limited to read-only tools; spans and logs scrubbed. These are covered by the existing suites and were not re-audited here.

## 3. Ingestion reliability

| Property | Verified by |
|---|---|
| A rejected request stores nothing and the reason is shown to the operator, by field, without the payload | `integrations.test.ts` |
| Data for a service that is not registered is surfaced, and stored log lines can be given to a service afterwards | `integrations.test.ts`, browser journey |
| With PostgreSQL down, requests are refused with 503 and nothing is half-stored | `outage.test.ts`, drill `postgres-down` |
| 400 requests of 1,000 log lines from 8 clients were all accepted and all 400,000 lines stored | Section 6 |

Not verified: ingestion while Redis is down (it does not use the queue, so it should be unaffected, but that was not drilled); ingestion during a PostgreSQL failover (there is no replica); behaviour when the disk fills; sustained ingestion over hours.

## 4. Idempotency

The four ingestion endpoints accept an optional `Idempotency-Key` header. The key is recorded in the same database transaction as the data, so a batch is stored if and only if its key is remembered.

| Guarantee | Verified by (`apps/api/tests/idempotency.test.ts`) |
|---|---|
| A repeated request with the same key and body stores nothing and gets the first answer | All four endpoints, three repeats each |
| 48 identical requests at the same moment store one batch | With more requests than the database pool has connections |
| The same key with a different body is refused (422) and stores nothing | Sequentially and concurrently (six different bodies at once: one stored, five refused) |
| A failed request records no key, so it can be corrected or repeated | Invalid body, unknown service, a failure inside the transaction |
| Keys are separate per organisation and per endpoint | Two organisations, same key |
| A key is forgotten after 24 hours and removed by the hourly job | By moving its expiry |
| **Nothing is deduplicated without a key** | Identical batches without a key, or with different keys, are all stored |
| A key survives a restore from backup | Backup drill |

A defect was found by CI and fixed before merging: with more duplicates than pooled connections, the request holding the key waited for a connection the duplicates held, and all of them timed out. Every read and write of an idempotent request now uses its transaction's own connection.

Limits: a client that sends a new key with each retry stores the batch each time; nothing is guaranteed after the retention period; a replayed deployment carries the first response, including its record's id.

## 5. GitHub integration

**Not validated against github.com.** No token was supplied for the purpose, and the credentials already present on the machine were not used. The procedure for doing it, read-only, with a dedicated repository and a short-lived token, is in [github-validation.md](github-validation.md) and is run with `npm run github:validate`. The procedure itself was tested against the stand-in.

Verified against a local stand-in for the GitHub API (`github.test.ts`, `integrations.test.ts`, `intelligence.test.ts`): token validated before storage and never returned or logged; commits and pull requests read and stored once; rate limit, server error and permission refusal recorded as failures in our own words, without GitHub's message; recovery without reconfiguration; every request a `GET`; webhook signatures accepted only when they cover exactly the body received (refused: a changed body, another organisation's secret, SHA-1, malformed signatures, no secret, unknown organisation); redelivered webhooks stored once; role enforcement.

This is the largest single gap for a pilot that wants code changes in its reports.

## 6. Backup and restore

Procedure: [backup-and-restore.md](backup-and-restore.md). Verified by `npm run drill:backup`, locally and in CI:

- `pg_dump` of the running database (37 tables, about 36,000 rows, under 1 MB);
- restore into a second database beside it, without touching the first;
- identical row counts in every table, all 100 indexes including the vector index, 3 extensions, the migration history, all 55 foreign keys with no orphaned row, and identical content digests of incidents, investigations with their reports, evidence, approvals, actions, accounts and embeddings;
- a second API and worker run against the restored copy: existing accounts sign in, earlier records are intact, an API key still authenticates, an idempotency key is still remembered, and a new investigation completes and does not appear in the source.

Redis holds only the job queue and is not backed up; what happens to queued work when Redis is lost was verified by the failure drills of Milestone 6.

Not verified: a restore on another machine or PostgreSQL version; a database of realistic size (this restore took about a second); restore under load; loss of the encryption key. There is **no point-in-time recovery**, no scheduled backup and no replication.

## 7. Performance measurements

`npm run loadtest`, twice, on the isolated stack. These are measurements of one small configuration, not a capacity statement.

**Environment.** Apple M4, 10 cores, 24 GB RAM, macOS. Docker Desktop 29.2 with 10 CPUs and 7.7 GB for containers. PostgreSQL 16.15 (100 connections allowed), Redis 7.4, Node 22. One API process, one worker, one analysis service, rule-based engine. The load generator ran on the same machine, and another copy of the application was running on it at the time.

| Workload | Run 1 | Run 2 |
|---|---|---|
| **Logs**: 8 clients, 400 requests of 1,000 lines | 400,000 stored in 11.4 s (35,000 lines/s). Request p50 105 ms, p95 1,640 ms, max 2,319 ms. No errors | 10.9 s (36,700 lines/s). p50 96 ms, p95 1,625 ms, max 2,327 ms. No errors |
| **Metrics**: 8 clients, 320 requests of 500 samples | 160,000 stored in 1.1 s. p50 27 ms, p95 38 ms | 1.1 s. p50 27 ms, p95 38 ms |
| **Duplicates**: 200 requests at once, 20 batches × 10 copies under one key each | 1,000 lines stored (1,000 expected), 180 replays. p50 140 ms, p95 199 ms | 1,000 stored, 180 replays. p50 127 ms, p95 182 ms |
| **Reads while writing**: 4 clients, 120 requests, during log ingestion | p50 56 ms, **p95 2,208 ms**, max 2,490 ms | p50 101 ms, **p95 2,403 ms**, max 2,733 ms |
| **Investigations**: 40, three at a time (the per-organisation limit) | All completed in 17.5 s (137/min). Each: p50 0.6 s, p95 3.0 s. Refused at the limit 7 times, as designed. At most 1 waiting | 22.0 s (109/min). p50 1.2 s, p95 3.5 s. Refused 5 times. At most 2 waiting |
| Database connections | Peak 28 of 100, 4 active | Peak 28, 5 active |
| Container memory, peak | API 381 MiB, worker 117, PostgreSQL 476, Redis 12, analysis 120 | API 384, worker 126, PostgreSQL 614, Redis 12, analysis 121 |
| Afterwards | Database 347 MB; no failed job; API ready | Database 613 MB; no failed job; API ready |

What the numbers show, and do not:

- **Nothing was lost or duplicated**: every line and sample sent was stored once; every duplicate was recognised; every investigation completed.
- **Reads stall while large log batches are ingested.** p95 for reads rose above two seconds, for every endpoint including ones that do not touch the log table. The median stayed low. The cause was not isolated; the pattern (all endpoints, same delay) points at the single API process being busy with a batch rather than at the database. A pilot that sends large batches while people use the interface would notice this.
- **Log search slows with volume.** The median of a text search over the last hour rose from 285 ms to 740 ms between the runs, as the table grew from 400,000 to 800,000 lines. The trend beyond that is not known.
- **Investigations are fast only because the engine is rule-based.** A model takes tens of seconds per investigation and costs money; the throughput above says nothing about that.
- **Queue pressure was not really exercised**: the per-organisation limit of three concurrent investigations keeps the queue almost empty by design.
- Not measured: more than one organisation at a time, runs longer than a few minutes, memory over hours, the web application, a database of tens of millions of rows.

## 8. AI evaluation

Detail and the exact plan for a paid run: [ai-validation.md](ai-validation.md).

Verified without a model: the rule-based engine passes 14 of 14 scenarios, three of them about past incidents; every report it writes is pinned; scripted stand-ins for a model show that a model which reasons from the present about the past, contradicts the evidence, returns unusable output or says nothing still ends in an honest report. Two defects were found and fixed by these tests: a model call that timed out ended the investigation as failed instead of falling back, and the text of a parsing failure, which can quote the model's output, was copied into the report.

**Not verified: any behaviour of a real model with the current report format, the historical health tool, the outcome assessment or the action-effect rules.** The last live run was in Milestone 3, on six scenarios. A pilot on the rule-based engine does not need a model; a pilot that advertises AI analysis does.

## 9. Known risks

Ordered by how much they could hurt a pilot.

1. **A model has never run on this code.** If the pilot uses one, the first customer incident is the first real test.
2. **GitHub is untested against github.com.**
3. **One process of everything, on one machine.** No redundancy; a restart interrupts running investigations (they are recorded as interrupted, not resumed).
4. **Read latency under ingestion load** (section 7), with an unisolated cause.
5. **No backups unless the operator schedules them**, and no point-in-time recovery.
6. **Push-only ingestion**: the customer must write or configure a forwarder. This is integration work on their side before any value appears.
7. **Past health is reconstructed** from alerts and incidents, so a problem nobody alerted on is invisible in retrospect.
8. **No external security review.** The outbound-request defect of this milestone was found by reading the code, three milestones after it was written.
9. **Rate limiting is per client address**, 1,200 requests a minute, not per key or organisation: one busy sender behind a shared address can exhaust it for others.
10. **The product name is not cleared.**

## 10. Requirements before an external pilot

Must, before anyone outside is invited:

1. **Decide the engine.** Rule-based only (state it plainly to the customer), or approve a budget and run the live evaluation in [ai-validation.md](ai-validation.md) first.
2. **Run the GitHub validation** in [github-validation.md](github-validation.md) with a test repository, or tell the customer GitHub is not part of the pilot.
3. **Host it properly**: TLS in front of the web application, real secrets, `SEED_DEMO_DATA=false`, the database not published, and a scheduled `pg_dump` with the encryption key stored elsewhere. Restore one backup once, on the pilot machine.
4. **Agree what data is sent.** Logs are redacted by pattern, which is a filter and not a guarantee; with a model configured, evidence leaves the installation for the provider.
5. **Name an operator** who watches the installation, and tell the customer there is no service-level agreement.

Should:

6. Isolate the read-latency finding (run the API with a second process, or measure the event loop) and repeat the load test on the pilot machine with the customer's expected volume.
7. Make `Browser end-to-end tests` a required check on `develop` ([git-workflow.md](git-workflow.md)).
8. Give the customer a small forwarder for their log and metric source, or confirm they will write one.
9. Have someone other than the author review the outbound-request and ingestion paths.

What a pilot would then establish, and nothing before it can: whether the reports are useful to engineers who did not build the product, on incidents nobody scripted.
