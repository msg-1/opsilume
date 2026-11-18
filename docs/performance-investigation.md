# Read latency during ingestion: investigation

Milestone 9, 15 November 2026. Milestone 8 reported that read requests had a p95 of 2.2 to 2.4 seconds while log batches were being ingested, with the cause not isolated, and that log search slowed as the table grew. This is what was found, what was changed, and what is still slow.

**Summary.**

1. **The two-second stall was not in OPSILUME.** It was produced by the load generator, which blocked itself for about two seconds at a time and counted the wait as server latency. With the generator fixed, the same workload has a p95 of about 650 ms.
2. **Three real inefficiencies in the log queries were found from their query plans and fixed.** On the same data and request rate, median read latency fell from 123–143 ms to 38–45 ms and p95 from 512–652 ms to 277–374 ms.
3. **Aggregating queries are still slow under load.** Log patterns, the dashboard and the Integrations page each read every line in their time window, and their tail latency (p99 0.7 to 0.8 s here) was not improved. Fixing that needs pre-aggregation, which is a design change and was not attempted.

Everything was measured on an isolated copy of the application (`scripts/isolated-stack.mjs`), never on a database in use. All numbers are from one laptop and describe that machine only.

## 1. Reproducing the report

Environment: Apple M4, 10 cores, 24 GB RAM, macOS; Docker Desktop with 10 CPUs and 7.7 GB; PostgreSQL 16.15 with default settings (128 MB shared buffers, 4 MB work memory); one API process, one worker; another copy of the application running on the same machine, as in Milestone 8.

The Milestone 8 workload, "reads while writing" (4 clients, 120 reads over seven endpoints, during 40 requests of 300 log lines), was run three ways, twice each. The only difference is how the load generator samples container statistics while the requests are in flight.

| Load generator's monitor | Client-side read p50 | p95 | p99 | Reads over 1 s, as the client timed them | Reads over 1 s, **as the API timed them** |
|---|---|---|---|---|---|
| Synchronous (as in Milestone 8) | 104 / 84 ms | **2,278 / 2,363 ms** | 2,813 / 2,466 ms | 16 / 13 of 120 | 3 / 0 of 120 |
| Asynchronous | 76 / 78 ms | 695 / 621 ms | 763 / 668 ms | 1 / 0 | 1 / 0 |
| None | 73 / 82 ms | 634 / 645 ms | 739 / 691 ms | 0 / 0 | 0 / 0 |

The original result reproduces exactly, and only with the synchronous monitor. The API's own request-duration histogram (`opsilume_http_request_duration_seconds`), which nothing on the client can distort, records almost no request over one second in any of the six runs.

### Why

The monitor called `docker stats --no-stream` with a synchronous child process. That command takes **2.09 seconds**. While it runs, the load generator's event loop is frozen: responses that have already arrived sit unread, and when the loop resumes, their latency is computed as "now minus when the request was sent". Every request in flight during one of those calls was therefore reported as taking about two seconds, on every endpoint alike, which is exactly the pattern Milestone 8 saw ("p95 2,196 to 2,216 ms" on seven unrelated endpoints).

The explanation offered in the Milestone 8 report, that the single API process was busy parsing a batch, was a guess and was wrong. Measured directly, the synchronous work for one request is small:

| Stage, for one request of 1,000 lines (111 KB) | Median |
|---|---|
| `JSON.parse` | 0.12 ms |
| Validation | 0.30 ms |
| Redaction of every message | 0.33 ms |
| Fingerprint of every message | 1.13 ms |
| All of it, as the handler does it | **2.1 ms** |

A request of 5,000 lines, the largest allowed, takes 12 ms. The API's event-loop lag stayed at zero in every sampled run.

### What was changed in the tools

- `scripts/load-test.mjs` samples with non-blocking child processes, and reports p99.
- `scripts/perf-probe.mjs` (new) is the diagnostic used here. It sends at a **fixed rate** whatever the latency, reports only answered requests, and prints the API's own timings beside the client's. Its first version sent as fast as answers came; when reads got faster it sent more, ran into the API's rate limit (1,200 requests a minute per address) and compared two different workloads. That run was discarded.

Both tools now carry a comment saying why nothing synchronous may run while requests are being timed.

## 2. What is really slow

With the artefact gone, a third of the reads still took over 250 ms. Per route, as the API timed them, on about 850,000 log lines all within the last hour:

| Route | Mean |
|---|---|
| `GET /logs/patterns` | 522 ms |
| `GET /logs` (list and text search) | 225 ms |
| `GET /dashboard` | 159 ms |
| `GET /integrations` | 76 ms |
| `POST /logs` (1,000 lines) | 79 ms |
| `GET /incidents`, `/incidents/:id`, `/services` | 9–13 ms |

Everything slow reads the log table. What was checked, and what it showed:

| Checked | Finding |
|---|---|
| Locking | No lock waits on application queries in any sample. Inserts do not block reads (MVCC) |
| Transactions | Ingestion is one `INSERT` of the batch, 80 to 120 ms for 1,000 lines; with an idempotency key, one short transaction |
| Connection pool | Peak 26 to 31 connections of 100 allowed; the API's pool is 21. Peak active 11 to 18. No request waited for a connection |
| Event loop | No lag (see above) |
| Round trips | The list makes two queries (page and count) in parallel; nothing is fetched per row |
| Pagination | The page itself is an index scan of 50 rows: **0.04 ms**. The cost is in the count beside it |
| Indexes | Seven on the log table, 250 MB for 175 MB of data. All are used. One filter was written so that its index could not be |
| Database wait events | Disk reads and buffer contention during ingestion, with the default 128 MB buffer cache; autovacuum running throughout |
| Table growth | The slow queries read every line in the time window, so their cost is linear in the lines in that window, not in the size of the table |

### Query plans

On 856,000 lines in the window, each timed three times:

| Query | Plan | Time |
|---|---|---|
| List: newest 50 | Index scan on (organisation, timestamp), 8 buffers | 0.04 ms |
| Count of all lines in the window | Parallel index-only scan of all 856,000 entries | 17–23 ms |
| Count of lines matching a common word | **Parallel sequential scan of the whole table**, 22,000 buffers | 137–145 ms |
| The same, for a rare word | Trigram index | 2 ms |
| Patterns | Parallel scan, then an **incremental sort on four keys** including the service's name and slug; 771,000 buffer hits, **28,000 temporary-file blocks (about 220 MB) written and read** | 505–527 ms |
| Histogram with a level filter | The filter casts the column to text, so the (organisation, level, timestamp) index is not usable: **parallel sequential scan** | 79 ms |

## 3. The fixes

Each follows from a plan above. All are in `apps/api/src/modules/logs.ts`.

**a. Patterns are aggregated before they are joined to the service.** The query grouped by fingerprint, service id, service name and service slug, joining every line to its service first. A service id already determines its name and slug. Grouping by fingerprint and service id alone, and joining the 25 resulting rows afterwards, lets PostgreSQL use a hash aggregate with no sort and no temporary files. The result is the same set of rows.

**b. The log explorer's count stops at 10,000.** The list is paged 50 or 100 lines at a time, but it counted every matching line on every page view, which for a common word means scanning the whole table. The count now stops at 10,001; beyond that the response says so (`meta.totalIsLowerBound: true`) and the page reads "more than 10,000 results; narrow the time range or add a filter to reach the rest". Pages up to the 10,000th line are reachable as before.

The **investigation tools still count exactly** (`GET /tools/logs/search`). The number they return is cited as evidence in reports and checked against it, and investigations are rare compared with page views.

**c. The level filter compares the enum as an enum.** `"level"::text = ANY(...)` became `"level" = ANY(...::"LogLevel"[])`. The plan changes from a parallel sequential scan to an index-only scan on the index that exists for exactly this.

What they do to the queries themselves, on 1.52 million lines:

| Query | Before | After |
|---|---|---|
| Count for the list | 61–79 ms | **1.4 ms** |
| Count for a text search, common word | 225–234 ms | **22 ms** |
| Level filter | 79–81 ms (sequential scan) | **23–30 ms** (index-only scan) |
| Patterns | 291–307 ms | **238–240 ms** |

The pattern rewrite gave 4.6 times (520 to 112 ms) on the first dataset, where the old plan sorted on disk, and 1.3 times on this one, where it did not. It removes a bad plan; it does not make the query cheap.

### Correctness

`apps/api/tests/log-queries.test.ts` checks each rewritten query against the answer worked out from the rows themselves in the test, not against the query's earlier output:

- patterns: the same groups, counts, samples, levels, first and last times and service names, for every filter (level, service, text, time), for lines without a service, with a limit, across two organisations, and through the API. **This test passes on the old query and on the new one.**
- level filters: the list, the histogram and the anomaly detection return what they returned.
- the count: exact below the cap; a labelled lower bound above it; exact for the investigation tools; zero for another organisation.

The idempotency tests and the tenant-isolation tests pass unchanged. The full API suite passes (206 tests).

## 4. Before and after

Same machine, same procedure, twice each: the log table is emptied, 800,000 lines are loaded through the API (the second run of each pair loaded about 600,000, because some preload requests were refused by the rate limit; the pairs are comparable with each other), then for 30 seconds 8 writers each send a 1,000-line batch every 320 ms while 4 readers each send a request every 400 ms over eight endpoints. Latencies are of answered requests only; none was refused in these runs.

| | Before (run 1 / run 2) | After (run 1 / run 2) |
|---|---|---|
| Ingestion throughput | 24,800 / 24,700 lines/s | 24,400 / 24,800 lines/s |
| Ingestion request p50 / p95 | 118 / 261 ms · 159 / 259 ms | 112 / 256 ms · 132 / 221 ms |
| **Reads, all endpoints: p50** | **143 / 123 ms** | **38 / 45 ms** |
| **Reads: p95** | **512 / 652 ms** | **374 / 277 ms** |
| **Reads: p99** | 733 / 1,325 ms | 669 / 818 ms |
| Reads over 250 ms, as the API timed them | 75 of 291 / 56 of 278 | 37 of 298 / 17 of 292 |
| `GET /logs`: p50 / p95 | 147 / 248 ms · 128 / 342 ms | **10 / 75 ms · 14 / 76 ms** |
| `GET /logs?q=`: p50 / p95 | 443 / 771 ms · 383 / 857 ms | **41 / 83 ms · 36 / 80 ms** |
| `GET /logs/patterns`: p50 / p95 | 354 / 450 ms · 339 / 1,540 ms | 296 / 798 ms · 243 / 1,599 ms |
| `GET /dashboard`: p50 | 161 / 160 ms | 186 / 82 ms |
| `GET /integrations`: p50 | 173 / 167 ms | 182 / 151 ms |
| Database connections, peak (active) | 29 (18) / 28 (15) | 28 (18) / 26 (11) |
| Errors | 0 | 0 |
| Lines stored | every line sent | every line sent |

Read as: the list and the search, which are what a person uses most, are 10 to 15 times faster. Overall median latency fell by about 70% and p95 by 27% to 57%. The pattern query's median improved by 15% to 30% and its tail not at all; the two runs disagree on p95 by a factor of two, before and after, which is the size of the noise at 37 samples.

Ingestion is unchanged, as expected: nothing in the write path was touched.

## 5. What was tried and not adopted

**A larger buffer cache.** The wait events during ingestion were mostly disk reads and buffer-mapping contention, and PostgreSQL runs here with its default of 128 MB. With `shared_buffers = 1GB` those waits disappeared from the samples, and latency did not improve (reads p50 39 ms, p95 331 ms, p99 1,051 ms: within the noise of the runs above). The setting was left at its default. An operator with a much larger log volume than tested here should still size it for their machine; this test says only that it was not the limit at this volume.

**Caching, read replicas, a second API process.** Not tried. None is indicated by the evidence: the API process is not the bottleneck and the slow queries are slow in the database.

## 6. What remains

- **Queries that aggregate over a time window read every line in it.** Patterns, the error trend on the dashboard, the log histogram and the coverage figures on the Integrations page are all linear in the number of lines in their window. At about 800,000 lines in the window, under ingestion, patterns take 250 to 350 ms at the median and over a second in the tail. At ten times that, they would take seconds. The remedy is to maintain per-interval roll-ups as lines arrive (a table of counts per fingerprint, service and minute) and read those. That is new machinery with its own consistency questions and was out of scope for "the smallest safe fix".
- **The Integrations page runs its coverage queries every five seconds while it is open** and set-up is incomplete. They took 150 to 180 ms here. Not changed.
- **Text search for a rare word is fast (2 ms); for a very common word the first page is fast and only the count was slow.** The count is now bounded. A search that matches nothing in a large window still has to look at every line the trigram index cannot exclude.
- **The dataset is synthetic**: a handful of message templates. Real logs have many more distinct messages, which affects the trigram index and the number of pattern groups. The plans, and therefore these numbers, may differ on real data.
- **One machine, one PostgreSQL with default settings, runs of 30 seconds.** Nothing here says what happens over hours, as the table reaches tens of millions of lines, or with several organisations at once.
- **Offset pagination** is used for the list. It is bounded now by the 10,000-line cap; without the cap, deep pages would be slow.

## Reproducing this

```bash
npm run isolated:up
node scripts/perf-probe.mjs --reset --preload 800000 --seconds 30 --label mine    # the benchmark of section 4
npm run loadtest                                                                  # the Milestone 8 workload, with the corrected monitor
npm run loadtest -- --smoke                                                       # a tenth of it, as CI runs it: correctness only, no timing asserted
npm run isolated:down
```

`--reset` empties the log table of the isolated stack. The probe refuses to run against the default Compose project.
