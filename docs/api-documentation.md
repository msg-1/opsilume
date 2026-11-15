# API documentation

Base URL: `http://localhost:4000/api/v1`. JSON in and out.

## Conventions

- **Authentication:** session cookie (set by `/auth/login`), `Authorization: Bearer <access token>`, or `x-api-key: opk_...`.
- **Errors:** `{ "error": { "code": "validation_error", "message": "...", "details": [{ "path": "title", "message": "..." }] } }` with status 400, 401, 403, 404, 409, 413, 422, 429, 500 or 503.
- **Lists:** `?page=1&pageSize=25` → `{ "data": [...], "meta": { "page", "pageSize", "total", "totalPages" } }`.
- **Time parameters** (`from`, `to`): ISO-8601, or relative such as `15m`, `6h`, `7d` meaning "that long ago".
- **Services** can be referenced by id or slug wherever a `service` parameter appears.

## Roles and permissions

| Capability | Viewer | Engineer | Admin | Owner |
|---|:-:|:-:|:-:|:-:|
| Read everything except audit log and API keys | ✓ | ✓ | ✓ | ✓ |
| Manage incidents, services, deployments, knowledge, alert rules | | ✓ | ✓ | ✓ |
| Run investigations, propose and execute remediation | | ✓ | ✓ | ✓ |
| Approve low and medium risk remediation | | ✓ | ✓ | ✓ |
| Approve high-risk remediation | | | ✓ | ✓ |
| Members, teams, integrations, API keys, settings, audit log | | | ✓ | ✓ |

API key scopes: `ingest:logs`, `ingest:deployments`, `ingest:events`, `ingest:metrics`, `tools:read`.

## Endpoints

### Auth — `/auth`
| Method and path | Description |
|---|---|
| `POST /register` | Create an organisation and its owner. Body: `email`, `password` (10+ characters, letter and number), `name`, `organizationName` |
| `POST /login` | Body: `email`, `password`, optional `organizationId` |
| `POST /refresh` | Rotate the refresh token, issue a new access token |
| `POST /logout` | Revoke the session |
| `GET /me` | User, organisation, role, permissions, other organisations |
| `POST /switch-organization` | Body: `organizationId` |
| `PATCH /profile` | `name`, `title`, or `currentPassword` + `newPassword` |
| `GET /invitations/:token`, `POST /accept-invitation` | Invitation preview and acceptance |

### Incidents — `/incidents`
| Method and path | Description |
|---|---|
| `GET /` | Filters: `q`, `status`, `severity`, `service`, `assigneeId`, `active=true|false`, `from`, `to`, `sort` |
| `POST /` | `title`, `severity` (SEV1–SEV4), `serviceIds[]`, `description`, `assigneeId`, `commanderId`, `customerImpact`, `startedAt` |
| `GET /:id` | By id or key (`INC-12`). Includes timeline, investigations, remediation, alerts, postmortem |
| `PATCH /:id` | Any of the create fields plus `status`, `rootCause`, `resolution`, `note`. Closing requires `RESOLVED` first |
| `POST /:id/comments` | `message`; `@Full Name` notifies that member |
| `GET /:id/context` | Related deployments, service events, alerts, error patterns, similar incidents |
| `POST /:id/postmortem` | Create a postmortem draft in the knowledge base (idempotent) |

### Services, deployments, events
| Method and path | Description |
|---|---|
| `GET/POST /services`, `GET/PATCH/DELETE /services/:id` | Catalogue. `GET /services/graph` returns nodes and edges |
| `PUT /services/:id/dependencies` | Replace upstream dependencies: `{ dependencies: [{ serviceId, kind }] }` |
| `GET/POST /deployments`, `GET/PATCH /deployments/:id` | Record and browse deployments. Detail includes the linked commit, pull requests, previous deployment and incidents that began within 6 hours. `rollbackOf` (the id or version being rolled back) records a deployment as a rollback and marks the other as `ROLLED_BACK`, so that version is never offered as a rollback target |
| `GET/POST /service-events` | Config changes, feature flags, scaling, restarts, maintenance |

### Retrying ingestion safely — `Idempotency-Key`

The four ingestion endpoints (`POST /logs`, `POST /monitoring/metrics`, `POST /deployments`, `POST /service-events`) accept an optional `Idempotency-Key` header: 8 to 128 characters from letters, digits, `.`, `_`, `:` and `-`. Generate one per request (a UUID is fine) and send the **same** key whenever you repeat that request.

| Situation | Result |
|---|---|
| No header | The request is stored. Two requests with the same content are stored twice: OPSILUME never guesses that two batches are one |
| First request with a key | Stored. The key is recorded in the same database transaction as the data, so the two cannot disagree |
| Same key, same body, again | Nothing is stored. The answer is the first request's, with the header `Idempotent-Replayed: true` |
| Same key, same body, at the same moment | One is stored; the others wait for it and get its answer |
| Same key, different body | `422 idempotency_key_reused`. Nothing is stored. Key order and whitespace in the JSON do not count as a difference |
| The request failed (400, 404, 5xx, no answer and nothing stored) | No key is recorded. Repeat or correct the request with the same key |
| Same key after 24 hours (`INGEST_IDEMPOTENCY_TTL_HOURS`) | Treated as a new request |

Keys are separate per organisation and per endpoint. Expired keys are removed hourly.

**How a client should retry.** Send the batch with a new key. On a timeout, a dropped connection, `429` or any `5xx`, send the same batch again with the same key, backing off (for example 1 s, 2 s, 4 s, up to a minute). On `400`, `404` or `422` do not retry unchanged: the request itself is wrong. Do not reuse a key for a different batch, and do not generate a new key for a retry, which would store the batch twice.

### Logs — `/logs`
| Method and path | Description |
|---|---|
| `POST /` | `{ service?, environment?, logs: [{ timestamp?, level?, message, service?, host?, traceId?, spanId?, attributes? }] }`, up to 5,000 per request. Returns `{ accepted, unknownServices }` |
| `GET /` | Filters: `q`, `service`, `level`, `environment`, `traceId`, `fingerprint`, `from` (default `1h`), `to`, `order` |
| `GET /histogram`, `/patterns`, `/anomalies`, `/facets` | Volume by level over time; lines grouped by pattern; patterns that are new or at least 3× their baseline rate; filter values |

### Monitoring — `/monitoring`
| Method and path | Description |
|---|---|
| `POST /metrics` | `{ samples: [{ service, metric, value, timestamp? }] }`. Metric names are `lower_snake_case` |
| `GET /overview` | Health, latest values, error-rate sparkline and firing alerts per service |
| `GET /series?service=&metric=a,b&from=` | Bucketed avg/min/max |
| `GET/POST /alert-rules`, `PATCH/DELETE /alert-rules/:id` | `service`, `name`, `metric`, `comparator` (`gt`/`lt`), `threshold`, `windowMinutes`, `severity`, `autoIncident` |
| `GET /alerts`, `POST /evaluate` | Alert history; evaluate rules now (also runs every minute) |

### GitHub — `/github`, `/webhooks/github`
| Method and path | Description |
|---|---|
| `GET/PUT /github/integration` | Status; set `token` and/or `webhookSecret` (`null` removes) |
| `GET/POST /github/repositories`, `PATCH/DELETE /github/repositories/:id` | `fullName` (`owner/name`), `service`, `sample` |
| `POST /github/sync` | Queue a sync of all or one repository |
| `GET /github/commits`, `/github/pull-requests` | Filters: `repository`, `service`, `q`, `from`, `to`, `state` |
| `POST /webhooks/github/:orgSlug` | GitHub webhook receiver (`push`, `pull_request`, `ping`); requires a valid `X-Hub-Signature-256` |

### Integrations — `/integrations`

What can be connected and whether it works. Status follows what happened (data accepted or rejected, a check answered or not), not what was saved. No response contains a credential, a webhook address or the address of an installation-level service.

| Endpoint | Notes |
|---|---|
| `GET /` | Every source this installation has: `logs`, `metrics`, `deployments`, `events` (push, by API key), `github`, `remediation_webhook`, and the installation-level `traces` and `analysis_engine`. Per source: `status`, `statusDetail`, `provides`, `requires`, `lastReceivedAt`, `lastError`, `lastCheck`, `facts`, `setup`. Also `unresolvedServices` (names in incoming data that match no registered service) and `onboarding` (six steps, each ticked from what was received). Permission `read` |
| `POST /github/check` | Asks GitHub whether the token and every connected repository can be read; stores and returns `{ ok, detail }`. People with `integration:manage` only; at most once every 5 seconds |
| `POST /remediation-webhook/check` | Sends one signed request with `event: "ping"` and no action to the remediation webhook; stores and returns `{ ok, detail }`. The address is checked against private ranges again before sending; redirects are not followed; the answer's body is not read. People with `settings:manage` only |
| `POST /unresolved-services/link` | `{ ref, service }`. Gives stored log lines that named the unregistered service `ref` to a registered service. Permission `service:write` |

`status` is one of:

| Status | Meaning |
|---|---|
| `not_configured` | Nothing is set up and nothing has arrived |
| `configured` | Something was saved (an API key with the scope, a webhook address). Nothing has shown that it works |
| `connected` | The other side answered (a key was used, a token was accepted, a check passed), but no usable data has arrived |
| `delivering` | Usable data is arriving: accepted, recent for continuous sources, and belonging to registered services |
| `degraded` | It worked or partly works, and something needs attention: the last request was rejected, a continuous source has been quiet for 24 hours, or data names services that are not registered |
| `unavailable` | The last check failed, or an installation-level service does not answer |

### Knowledge — `/knowledge`
| Method and path | Description |
|---|---|
| `GET/POST /documents`, `GET/PATCH/DELETE /documents/:id` | `title`, `type`, `content` (Markdown), `service`, `tags`, `sourceUrl` |
| `GET /documents/:id/plan` | The document as an execution plan: its list items and numbered steps, each with `effect` and `reasons`, plus `effect`, `stateChanging` and `readOnly` for the whole. Nothing is executed |
| `POST /documents/:id/reindex`, `POST /reindex` | Re-embed one or all documents |
| `POST /search` | `{ query, limit?, types?, service? }` → `{ mode: "hybrid"|"keyword", note?, hits: [...] }` |

### Investigations — `/investigations`
| Method and path | Description |
|---|---|
| `POST /` | `{ question, incidentId?, timeWindow?: { from, to } }` → 202 with the queued investigation |
| `GET /`, `GET /:id` | List; detail with plan, steps, evidence, hypotheses, report and proposed remediation |
| `POST /:id/cancel` | Cancel a queued or running investigation |
| `GET /ai-status` | Which analysis engine and embedding model are active |

### Remediation — `/remediations`
| Method and path | Description |
|---|---|
| `GET /`, `POST /`, `GET /:id` | `type`, `title`, `description`, `rationale`, `risk`, `incidentId`, `investigationId`, `serviceId`, `parameters`. The response adds `effect` (`read_only` or `state_changing`, decided from the type and text, and from the runbook in `parameters.runbookDocumentId`), `effectReasons`, `currentHash` (the approval fingerprint), `sourceReview` (`required`, `verified`, `reasons`), `attempts`, and per approval `counts`, `expired` and `supersededAt` |
| `PATCH /:id` | Edit before execution. Only the fields sent change; `risk` keeps its value when omitted and cannot be lowered (400). Changing anything in the approval fingerprint (rationale included) supersedes the approvals and returns the action to `PROPOSED`; re-saving the same text does not |
| `POST /:id/request-approval` | `PROPOSED` → `PENDING_APPROVAL`. Refused for read-only diagnostics, which need none. Needs `acknowledgeUnverifiedSource: true` when `sourceReview.verified` is false |
| `POST /:id/approve`, `/reject` | Signed-in users only. `comment` optional for approve, required for reject. `expectedHash` (the `currentHash` that was displayed) makes approval fail with 409 if the action changed meanwhile. Needs `acknowledgeUnverifiedSource: true` when `sourceReview.verified` is false |
| `POST /:id/execute` | State-changing: `APPROVED` only, and only if enough approvals for its risk were given for the current content (409 otherwise; with too few it returns to `PENDING_APPROVAL`). Without a webhook configured, requires `{ confirmManual: true, notes? }`. Read-only: from `PROPOSED`, always `{ confirmManual: true, notes? }`, never sent to the webhook. Optional `expectedHash` refuses a request made from an older view. `executionResult.outcome` is `applied`, `not_applied` or `unknown`; `interrupted` marks an attempt whose process stopped |
| `POST /:id/retry` | Returns a failed action to `APPROVED`. After an `unknown` outcome it requires `{ confirmNotApplied: true }`, recorded as a reconciliation |
| `POST /:id/reconcile` | For the latest attempt whose outcome is `unknown`: `{ outcome: 'applied' \| 'not_applied' \| 'unknown', notes, attempt }`. Applied: `EXECUTED`; not applied: may be retried; unknown: stays blocked. Sends nothing |
| `POST /:id/cancel` | Cancel before execution |

The webhook request carries `Idempotency-Key: <action id>` (the same for every attempt), `X-OpsPilot-Attempt`, and in the body `idempotencyKey`, `attempt`, `effect`, `contentHash` (the approval fingerprint the approvals were given for) and `approvals`. A timeout (`REMEDIATION_WEBHOOK_TIMEOUT_MS`, default 30 s), a dropped connection or a 5xx is recorded as outcome `unknown`. See [reliability.md](reliability.md).

An approval counts for `REMEDIATION_APPROVAL_VALIDITY_HOURS` (default 24, a security policy the operator chooses). An execution still in progress after `REMEDIATION_EXECUTION_STALE_MINUTES` (default 10) is recorded as outcome `unknown` for a person to reconcile. A production change that is an AI proposal or is linked to an investigation that does not support it (`sourceReview.verified: false`) can be submitted and approved only with `acknowledgeUnverifiedSource: true`; see reliability.md §4 and §4c.

`POST /tools/knowledge/search` (the agent's tool) adds `provenance` to each result (`document`, `earlier_ai_output`, `contains_earlier_ai_output`) and, for postmortems, `currentAssessment`; see reliability.md §4c.

### Organisation and governance
| Method and path | Description |
|---|---|
| `GET /members`, `POST /members/invitations`, `PATCH/DELETE /members/:id` | Membership and roles |
| `GET/POST /teams`, `PATCH/DELETE /teams/:id`, `PUT/DELETE /teams/:id/members/:userId` | Teams, leads and on-call flags |
| `GET/PATCH /settings` | Approval policy, log retention and redaction, remediation webhook |
| `GET/POST /api-keys`, `DELETE /api-keys/:id` | The secret is returned once, on creation |
| `GET /audit-logs` | Filters: `action` (prefix), `actorType`, `resourceType`, `resourceId`, `from`, `to`; `format=csv` |
| `GET /notifications`, `POST /notifications/read` | In-app notifications |
| `GET /analytics/overview?from=30d`, `GET /analytics/incidents.csv` | Reliability and delivery measures; CSV export |
| `GET /dashboard`, `GET /system/status` | Overview aggregate; database, Redis, queues and AI status |

### Tool API — `/tools` (agent, MCP)
Read-only and compact. Accepts a user session, an API key with `tools:read`, or the investigation's tool token.

`GET /services`, `/services/:ref`, `/incidents`, `/incidents/:id/context`, `/logs/search`, `/logs/patterns`, `/logs/anomalies`, `/logs/histogram`, `/deployments`, `/deployment-context`, `/traces`, `/code-changes`, `/service-events`, `/metrics`; `POST /knowledge/search`.

`GET /deployment-context?service=<slug|id>[&deploymentId=][&environment=]` answers the questions asked about a deployment in one call: what it replaced (`previousSuccessful`, skipping failed releases and with no age limit), the ready-made `rollbackTarget`, `changes` (commits and merged pull requests between the two deployments, the deployed commit first), `errorLogs` before and after it over an equal window, `incidentsAfter`, `alreadyRolledBack` and `recentDeployments`. Without `deploymentId` it describes the service's latest deployment; `deployment` is `null` when there is none.

`GET /traces?service=<slug>&from=&to=&limit=&errorsOnly=` summarises traces from the Jaeger-compatible trace store configured in `TRACES_URL`: per trace its duration, the services crossed, the span with the largest self time (`slowestSpan`, with `system` and `peer` when the span says) and the spans that failed (`errorSpans`), plus `sampled`, `failed`, `p50Ms` and `p95Ms`. Failed traces come first, then the slowest. `available: false` with a `note` when no trace store is configured or it cannot be reached. The trace store is not tenant-aware: the service must belong to the caller's organisation, and its slug must equal its OpenTelemetry `service.name`.

### Investigation report

Besides `summary`, `confidence`, `hypotheses`, `facts`, `timeline`, `assumptions`, `uncertainties`, `nextSteps` and `recommendedActions`, a report carries:

| Field | Content |
|---|---|
| `outcome` | `HEALTHY`, `DEGRADED`, `INCIDENT` or `UNDETERMINED`. Also stored on the investigation and returned in lists |
| `assessment` | `outcome`, `confidence` (in the outcome, not in a hypothesis), `rationale`, `supportingRefs`, `signals[]` (`level`, `kind`, `text`, `evidenceRefs`), `missingTelemetry[]` |
| `observations[]` | Statements with evidence references that are not evidence of a fault |
| `facts[].verification`, `observations[].verification` | `status` (`verified`, `partly`, `unsupported`, `no_claims`) and `checks[]` (`text`, `kind`, `status`, `detail`, `evidenceRef`) |
| `integrity` | `checked`, `supported`, `flagged[]` (`where`, `text`, `status`, `detail`) |
| `recommendedActions[].effect`, `.effectReasons` | Recomputed by the API from the type and text |

## AI service (internal)

Called only by the API with the `x-internal-token` header: `GET /v1/status`, `POST /v1/embeddings`, `POST /v1/investigations/run` (NDJSON events: `meta`, `step`, `evidence`, `final`, `error`).
