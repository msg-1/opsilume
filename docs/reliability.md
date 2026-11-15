# Investigation reliability

How OPSILUME decides whether there is a fault at all, what an action would do, when an action may run, and whether the figures in a report are true to the evidence. Each rule here is enforced in code and covered by tests; the file names say where.

Nothing in this document is a claim of production readiness. It describes safeguards and their limits.

## 1. Outcome: is there a fault at all?

Every report carries an **assessment**, computed from the evidence by `services/ai/app/assessment.py` for every engine (rule-based, mock, or a model). The report's author does not decide it. A model asked "why is X failing?" tends to find a reason; a report that always names a cause is useless on the day nothing is wrong.

| Outcome | Meaning |
|---|---|
| `HEALTHY` | No material evidence of a fault in the window examined |
| `DEGRADED` | Anomalies or warnings are measurable, but no cause is established. Also: a failure is evident but nothing in the evidence explains it |
| `INCIDENT` | A failure is evident, and the leading hypothesis is supported by something that can be a cause |
| `UNDETERMINED` | The service sent no telemetry in the window, or nothing could be queried. Neither a fault nor good health can be concluded |

`UNDETERMINED` is a fourth state on purpose. A service that sends nothing looks exactly like a service with a clean log; calling it healthy would be a guess.

### Signals

| Strength | What counts |
|---|---|
| Strong | 10 or more ERROR/FATAL lines in one pattern · error rate up by half or more **and** at least 1% · latency up by half or more **and** by at least 50 ms · a firing alert · a dependency or the service itself recorded as DOWN · three or more sampled traces with failed spans |
| Moderate | 3 to 9 ERROR/FATAL lines in one pattern · 50 or more new or spiking WARN lines · error rate up by a quarter and at least 0.5% · latency up by a quarter and by at least 20 ms · another metric moved by a quarter or more and by at least one whole unit · a dependency or the service recorded as DEGRADED |
| Weak | Anything else that was noticed: a few warnings, a couple of errors, a percentage change on a value close to zero |

Every metric rule has an absolute floor as well as a relative one. A pool gauge that averages 0.1 connections and drops to 0 has fallen by 100% and means nothing. A metric that was zero and is no longer has no percentage change at all, and is treated as a rise whose size is judged by the level reached.

### From signals to outcome

- A strong signal **and** a leading hypothesis at 0.25 confidence or more that cites something which can be a cause (a deployment, a service event, a commit or pull request, a dependency, a past incident, an alert, a trace): `INCIDENT`. A hypothesis that cites only log patterns and metrics describes the failure without explaining it.
- A strong signal without such a hypothesis, or moderate signals only: `DEGRADED`.
- Neither, and there is telemetry to judge by (metric samples, or log lines of any level): `HEALTHY`.
- Neither, and no telemetry: `UNDETERMINED`.

### Confidence in the outcome

The assessment has its own confidence, separate from the confidence in any hypothesis. For `HEALTHY` it is built from coverage: 0.35 to begin with, more when metrics held steady for every service in question, when the services logged and the logs contain no error pattern, and when the catalogue records them as healthy with no alert firing; less for every data source that failed and for each weak signal. A healthy verdict that rests on metrics alone says so in its rationale and in its number. It is never set to a constant.

### What a healthy report contains

- The outcome and its rationale, with references to the evidence it rests on. Metrics that did **not** move are evidence items (`metric_baseline`), and so is a healthy status in the catalogue (`service_health`), so there is something to cite.
- **Observations**: things worth knowing that are not evidence of a fault (routine warnings, the last deployment), each with references.
- **Not examined**: telemetry that was missing or could not be queried.
- No fault hypothesis above "unlikely". When the evidence shows no fault, any hypothesis is limited to 0.2 and marked unlikely, and the report's hypothesis confidence follows. A report with no hypothesis shows none.
- Nothing that would change production.

A report that concludes differently from the evidence is corrected in both directions, and the correction is recorded as a guardrail step: a report that blames a healthy service, and a report that calls a failing service healthy.

## 2. Action effects

Each recommended action is `read_only` or `state_changing`. The effect is decided from the action's type and its text by `services/ai/app/effects.py` and `apps/api/src/lib/actionEffect.ts`, never taken from whoever proposed it. The two implementations are checked against the same fixture (`services/ai/tests/fixtures/action-effects.json`) by both test suites.

- `rollback_deployment`, `restart_service`, `scale_service`, `toggle_feature_flag`, `config_change`: state-changing by definition.
- `run_runbook` and `manual`: by what the text says. It is state-changing if it mentions restarting or stopping a process, deploying or rolling back, changing configuration, switching something on or off, clearing a queue, cache or data, running a migration or writing data, changing capacity or infrastructure, changing access, or upgrading software.
- It is read-only only if it mentions none of those **and** says what it inspects (check, verify, compare, read, review, query, …).
- **Anything unclear is state-changing.** "Housekeeping, as discussed" needs approval.

The rule errs towards approval. "Read the eviction log" is classified as state-changing because of the word "eviction". That costs an approval; the opposite mistake could cost an outage.

### Runbooks

| Capability | How | Approval |
|---|---|---|
| Read a runbook | `GET /knowledge/documents/:id` | None |
| Explain a runbook | The investigation cites it as evidence | None |
| Generate an execution plan | `GET /knowledge/documents/:id/plan`: its steps, each labelled by what it would do | None |
| Carry out read-only steps | A `read_only` action, recorded by a person | None |
| Carry out state-changing steps | A `state_changing` action | Required |

An action that points at a runbook (`parameters.runbookDocumentId`) takes its effect from the runbook's steps, not from its own title. A runbook with no recognisable steps cannot be shown to be harmless and is state-changing. Commands in code blocks are judged as commands, and a command that is not recognised is state-changing.

OPSILUME executes nothing itself. "Carry out" means: a person does it, or the organisation's remediation webhook does.

## 3. Which actions are offered

The guardrails (`services/ai/app/guardrails.py`, applied again in `apps/api/src/modules/investigations/guardrails.ts`) remove an action from the proposals, and list it under next steps with the reason, when:

- it would change production and the outcome is not `INCIDENT`;
- it would change production and rests only on a hypothesis rated unlikely;
- it is a rollback whose target is not borne out: the deployment is not among those retrieved or has already been rolled back, the version to return to is not an earlier deployment of the same service, that deployment did not succeed and so never ran, or it was itself rolled back;
- it is high risk and a lower-risk action is proposed.

Such an action is withdrawn, not relabelled. Turning a rollback into a "manual" action would leave the same change waiting for approval.

### Deployments as suspects (rule-based engine)

Timing makes a deployment a candidate, not a culprit. A deployment shortly before a problem loses standing when the evidence speaks against it:

- it has already been rolled back, so its code is not running;
- it is itself a rollback, returning the service to a version that ran before;
- error logs fell after it (from the deployment context).

Each is stated as a contradiction on the hypothesis. This was added after a run on real telemetry in which a database slowed down minutes after a bad release had been rolled back: timing alone made the rollback deployment the leading suspect, and the proposed remedy was to return to the release that had just been removed. For that to be preventable, a rollback has to be recorded as one: `POST /deployments` accepts `rollbackOf`.

## 4. Approval and execution

`apps/api/src/modules/remediation/`. Only signed-in people can approve, execute, edit or retry; API keys and the AI's tool token are refused on those routes.

- **Read-only diagnostics** need no approval. A person records that it was done and what was found. They are never sent to the webhook, so a misjudged text cannot change anything. The effect is recomputed at that moment; if the text now reads as a change, the action is reclassified and refused.
- **State-changing actions** need at least one approval, whatever the organisation's settings say, from someone other than the proposer and the requester (unless self-approval is switched on), and are at least medium risk.
- **Binding.** An approval is given for a hash of the action's type, title, description, risk, service and parameters. The interface sends the hash it displayed, so an approver who has an old version open is stopped.
- **Edits.** Changing anything an approver was shown supersedes every approval and returns the action to `PROPOSED`. Superseded approvals stay on record and no longer count. Changing the rationale alone does not. An edit changes only the fields it names: the risk stays what it was unless a new one is given, and a new one is subject to the same floor as a proposal. A change of risk is a change of content.
- **At execution** the hash is recomputed and only approvals given for it are counted. If the content is not what was approved, however it came to differ, execution is refused, the approvals are superseded and the action starts again. Approval of one action authorises no other, even one with identical content.
- **The threshold is recomputed.** When an approval is given and again at execution, the number needed is taken from the action's risk and the organisation's current settings, and is never lower than the number it was submitted with. If the content is what was approved but too few approvals count for it, nothing is executed, the approvals given stay valid and the action returns to `PENDING_APPROVAL` for the rest (audit action `remediation.approval_insufficient`).
- **Once.** The action is claimed atomically; a second request at the same moment is refused.
- **Outcome.** A 2xx from the webhook is `applied`. A 4xx, or an address refused before sending, is `not_applied`. A timeout, a dropped connection or a 5xx is `unknown`: the request was sent and nobody knows whether the change happened. That is recorded as unknown, never as executed and never as a clean failure, and no effect is written to the service history.
- **Retry.** After `not_applied`, a retry needs nothing further. After `unknown`, a person must first confirm that the change was not applied. Every attempt carries the same idempotency key (`Idempotency-Key` header and `idempotencyKey` in the body), so a receiver that did apply the first attempt can refuse the second. The approvals are checked again when it is executed.
- **Record.** The execution result and the audit trail carry the content hash, the approvers with the time of each approval, the attempt number, the mode and the outcome.

What OPSILUME cannot guarantee: that a webhook receiver honours the idempotency key, or that a person who confirms "not applied" checked.

## 4a. Health belongs to a time

A service's health in the catalogue is its state now. An investigation of something that is over must not read it: what is down today says nothing about last week, and a rule that names today's outage as the cause of an old incident produces a confident, wrong report. That was the behaviour until Milestone 7.

- **What the engine is told.** `GET /tools/services/:ref` and the incident context take the window under investigation. When that window is over (it ended more than 15 minutes ago), the health of the service and of each dependency is worked out from what was recorded in the window, by the same rule that computes health now (`apps/api/src/modules/healthHistory.ts`): an alert that was firing, an incident that was open, metrics that were arriving. The answer carries `healthAsOf.mode: "window"` and leaves the present state out altogether. For a window that reaches the present, the present state is the right answer and the mode is `"current"`.
- **Nothing is assumed.** A service with no alert, no incident and no metrics in the window is `UNKNOWN`, not healthy. The incident being investigated does not count as evidence for itself.
- **What the report says.** Evidence from a past window is titled "was DOWN during the window" and says what it rests on and that it is not the state now; evidence about the present is titled "is DOWN". A dependency whose state at the time is unknown produces no evidence and no hypothesis; it is listed under what was not examined, and each one lowers the confidence in the assessment by 0.05 (at most 0.15). The outcome rules are unchanged.
- **Whoever asks.** The window is added to every `get_service` call that does not carry one (`run_tool`), so a model that asks with only a service name still gets the window's answer.
- **Limit.** Health is reconstructed, not replayed: there is no stored history of the health column. A service that was unhealthy without any alert rule covering it, and without an incident, looks healthy in retrospect if it was sending metrics. Reports say what the conclusion rests on for that reason.

Tests: `apps/api/tests/historical-health.test.ts` (the tool API and the incident context, against a database), `services/ai/tests/test_historical_health.py` (a dependency that was down then, one that is down only today, missing history, a healthy past window, and a caller that gives no window).

## 4b. Assessment, verified summary and unverified narrative

**The defect.** Found by the Milestone 10 audit. In two healthy-state scenarios of the first live evaluation (`healthy_no_signal`, `healthy_misleading_signals`), the report a user saw showed two things that contradict each other:
- a computed outcome of HEALTHY;
- a model summary saying "I rate the outcome DEGRADED rather than HEALTHY" and "so the outcome is DEGRADED".

**The cause.** The model writes its summary in the report step, before the outcome is computed. The guardrails then compute the outcome (section 1) and correct the structured fields: outcome, hypothesis statuses, confidence. They never touched the summary. The API stored whatever summary it received, and the investigation page, the investigation list, the incident page and the remediation page show it. The printable report was not affected: it shows the assessment's rationale, not the summary.

**The design.** A report now carries three separate things:

| | What it is | Where it comes from | Shown as |
|---|---|---|---|
| **Authoritative assessment** | The outcome (HEALTHY, DEGRADED, INCIDENT, UNDETERMINED), its rationale and the evidence it rests on | Computed from the evidence by `services/ai/app/assessment.py`, for every engine (section 1) | The Assessment panel, and the Conclusion of the printable report |
| **Verified summary** | The text the reader is told first: `report.summary` | Built only from the assessment: "Assessed outcome: {outcome}. {rationale} ({refs})." (`contracts/guardrails.json`, `reportSummary`) | The investigation page, the investigation list, the incident page, the remediation page, the timeline event and the notification |
| **Unverified model narrative** | What the model wrote as its summary: `report.narrative` | The model, unchanged apart from the sanitiser, the overclaim rewrite and the figure checker | Its own section, "Unverified model narrative", on the investigation page and the printable report only |

`report.summarySource` records which one the summary is: `assessment`, `unverified` (the report carries no assessment) or `rule_based` (the rule-based engine's own summary, which is written from the same evidence and kept as it is).

**How it is enforced.** `present_summary` in `services/ai/app/guardrails.py` runs after the outcome and the hypotheses are final. The API builds the summary again in `apps/api/src/modules/investigations/guardrails.ts` and never trusts a summary it receives. The text of both comes from the shared contract, and a shared case in `contracts/fixtures/guardrail-cases.json` checks that the Python and TypeScript passes produce the same full string.

**Where the API's trust in the assessment comes from.** The API does not recompute the assessment and cannot prove how one was computed. Its trust rests on three things:
- **The service boundary.** A report reaches the API only as the final event of the API's own request to `AI_SERVICE_URL`. No route accepts a report from a client. The `x-internal-token` header authenticates the API to the AI service, not the response to the API: the API trusts the answer because it asked the configured service.
- **The AI service's code.** The model's answer has no field for an assessment, and `guardrails.enforce` replaces any assessment a report carries with the one `assessment.py` computes (`services/ai/tests/test_summary_consistency.py` pins this).
- **A consistency check at the API** (`trustedAssessment` in `guardrails.ts`). An assessment is used only if every reference it cites is evidence the API itself recorded for that run, and an INCIDENT, the only outcome that allows production changes, cites at least one. Otherwise it is dropped: the outcome is not verified, no production change is offered, and a guardrail note says why. Every INCIDENT assessment in the golden snapshot and in every saved evaluation run cites at least one reference, and every evidence item the AI service cites is sent to the API before the report, so a genuine report is never dropped. This check catches an assessment that does not fit the evidence. It does not catch one that fits the evidence but was not computed by `assessment.py`.

Signing the assessment would add a key to manage and rotate, and would protect only against something that can already answer as the AI service. It was not added.

**Reports stored before this change.** They are not migrated and nothing stored is changed. When one is read, `apps/api/src/modules/investigations/legacy.ts` presents it as a new report would be:

| Stored report | Shown as |
|---|---|
| Carries `summarySource` (every report from this change on) | Exactly as stored |
| Rule-based (from the report's `analysisMode`, else the row's, else a `heuristic` provider) | Exactly as stored |
| Model or mock, engine unknown included, with a trusted assessment (well-formed outcome, rationale and references; the same consistency check against the evidence stored for it) | The summary built from that assessment; the stored text as the unverified narrative; the outcome is the assessment's |
| Model or mock without one (absent, malformed, citing unrecorded evidence, or an INCIDENT citing nothing) | "Outcome not verified"; the stored text as the unverified narrative; no outcome, and no assessment, shown |

The layer applies in every response that carries the summary: the investigation detail (and so the printable report), the list, the incident page and its timeline entry (both completion-message formats), the remediation actions, and a postmortem drafted from now on.


**Guarantees.**
- **No model text in the verified summary.** It is built from the assessment alone, so what the model wrote cannot change it: a contradiction in a later paragraph, a paraphrase ("checkout looks fine"), a claimed recovery and a confident claim under UNDETERMINED all leave it the same. This does not rely on recognising what the model said.
- **No assessment, no outcome.** When a report carries no assessment (API only; the AI service always computes one), the summary says the outcome is not verified and names no classification. The narrative is kept, marked unverified, and no action that changes production is offered.
- **The narrative is kept for audit,** with its own label, on the investigation page and the printable report. It is not sent with the investigation list, the incident or the remediation action. An empty narrative is shown as "The model returned no narrative."
- **The narrative is still checked:** secrets are removed, wording that presents a cause as confirmed is rephrased, and its figures are checked against the evidence. A narrative that fails these checks is flagged, not hidden.
- **Idempotent.** Running the guardrails again gives the same summary and narrative, with no repeated prefix.
- **The model's findings are untouched:** hypotheses, evidence references, confidence after the guardrails, contradictions, missing evidence and uncertainties.
- **Older reports are presented, not rewritten.** A stored model or mock report without `summarySource` is shown with a summary derived from its trusted assessment, or as unverified, everywhere it appears (see above). The stored row is unchanged.

**Tests.**
- **Python:** `services/ai/tests/test_summary_consistency.py`, including HEALTHY with a contradicting paraphrase, HEALTHY with an explicit DEGRADED claim, DEGRADED with a positive narrative, INCIDENT with a claimed recovery, UNDETERMINED with confident claims, an empty narrative, a contradiction in a later paragraph, repeated processing, and the live reports copied unedited into `tests/fixtures/live_summary_contradictions.json`.
- **API:** the API pass, including a missing assessment and assessments that cite unrecorded evidence or, for an incident, none, in `apps/api/tests/contract.test.ts`. Through the real path (a scripted AI service stream, the guardrails, storage, then every response) in `intelligence.test.ts`: a contradictory model report with a verified assessment, a missing assessment, an assessment citing unrecorded evidence, a rule-based report, and stored older reports with a trusted, absent, unrecorded-evidence or malformed assessment and a rule-based one. Each of these checks the detail, the list, the incident, its timeline entry and the remediation actions, and that reading leaves the stored row unchanged. The view rules alone are in `legacy.test.ts`.
- **Web:** the investigation page (model, empty narrative, no assessment, older report, mock), the printable report, the list, the incident page and the remediation page in `apps/web/src/test/journeys.test.tsx`.

**In the evaluation.** The scorer now has 12 criteria; documents that say 11 predate this. The `summary` criterion passes a summary built from the assessment, which agrees by construction. The narrative is scored separately, on the report as the model wrote it. Each scenario is scored in three views, and a pass that needed a guardrail is recorded (`guardrailAssisted`, `unaidedFailures`). `--rescore` prints all three views.

Rescoring the saved first live run (no model call; the saved files are unchanged byte for byte):

| View | Result |
|---|---|
| As shown at the time, scored with the new criterion | 11 of 14 |
| With the current guardrails (the final user-visible report) | 14 of 14 |
| As the model wrote it (raw model output) | 9 of 14 |

Five scenarios fail as the model wrote them. Four of them passed at the time only because a guardrail corrected the report, not two as first reported:

| Scenario | What the model wrote | What the guardrail did |
|---|---|---|
| `healthy_no_signal` | A summary stating the outcome DEGRADED | The summary is built from the HEALTHY assessment; the model's text is the narrative |
| `healthy_misleading_signals` | A summary stating the outcome DEGRADED | The same |
| `upstream_dependency_down` | An outcome of DEGRADED where the scenario is INCIDENT | The computed assessment, not the model, sets the outcome |
| `tool_failures_degrade_gracefully` | A cause rated `likely` at 0.45, below the 0.5 threshold, that the data cannot establish | The existing rule rated it `possible` |

The fifth, `degraded_incomplete_evidence`, is the scenario that failed at the time. It passes with the current guardrails only because of the DEGRADED cap added afterwards (section 1, `unestablishedCauseCap`), so it is a guardrail-dependent pass too, not a model improvement. The result recorded at the time, 13 of 14 under the criteria then in force, is unchanged; the run is not described as 14 of 14. The repeat run of `degraded_incomplete_evidence` passes 1 of 1 in all three views. No rule-based scenario needed a correction.

**Limits.**
- **Consistency is not correctness.** The summary agrees with the assessment by construction. That says nothing about whether the assessment, or the leading hypothesis, is right about the cause.
- **The verified summary is formulaic.** It is built from the assessment's rationale, not written for the reader.
- **The narrative can still contradict the assessment.** It is labelled as unverified rather than corrected. The evaluation recognises a stated outcome in it with three patterns (`services/ai/app/evals/scoring.py`), which catch explicit statements only and undercount paraphrases. The patterns are an evaluation measure, not a guarantee.
- **Rule-based summaries are kept as written** (`summarySource: rule_based`). The API relies on `analysisMode` to recognise them. A report that arrives labelled rule-based keeps its own summary: the label comes from the same trusted service.
- **The API's trust in the assessment is a boundary and a consistency check, not proof.** An assessment that fits the recorded evidence is used whoever produced it. See above.
- **Copies made before this change keep the old text.** The read-time view changes what is shown, not what was copied: notifications already sent, postmortems already drafted, and remediation actions already proposed from an older report. An older report without a trusted assessment may have proposed a production change at the time; the action remains, and still needs a person to submit, another to approve, and one to execute it. A fresh install has no older rows: the seed creates no investigations and the demo uses the rule-based engine.
- **An older report shown as verified is verified now, not then.** Its summary is derived when it is read, from the assessment it stored.
- **The evaluation scores the AI service's output.** It does not run the API pass or the read-time view, which are tested separately, and its outcome patterns undercount paraphrases (above).
- **The model is not told the computed outcome before it writes.** The outcome depends on the hypotheses, which come in the same answer. The prompt is unchanged.

## 5. Figures and identifiers

`services/ai/app/claims.py`. A citation that resolves is not enough: "error rate rose to 14% (E3)" has to be compared with what E3 says.

1. Each evidence item is turned into typed values (number, unit, source), from its structured data first and from its own title and summary second. A metric recorded without a unit takes it from its name (`latency_p95_ms`).
2. Each statement is split into claims: numbers with units, timestamps, versions, commit hashes, pull request numbers, incident keys.
3. Each claim is compared with the evidence the statement cites.

| Status | Meaning |
|---|---|
| `exact` | The cited evidence holds this value, in a compatible unit (210 ms = 0.21 s) |
| `rounded` | The cited evidence holds a value that rounds to it at the precision written |
| `calculated` | It is the ratio, difference, sum, share or percentage change of two cited values, or the time between two cited timestamps |
| `estimate` | The text marks it as approximate ("about", "roughly") and it is within 15% of a cited value |
| `uncited` | It matches evidence that exists but that the statement does not cite |
| `unsupported` | None of these: a wrong value, a wrong unit, or nothing to compare with |

- Units are compared by dimension. 210 s against evidence of 210 ms is unsupported, and the detail says the unit differs. A bare number does not support a claim in a physical unit.
- Timestamps are compared in UTC to the minute. An offset is converted. A timestamp without a zone is read as UTC and the detail says so.
- Not treated as measurements: the report's own confidence, HTTP status codes ("502s"), small bare integers ("2 hypotheses"), evidence references, the boundaries of the investigation window. The numbers inside a recommended action are instructions ("watch for 15 minutes") and only its identifiers are checked.
- Nothing is corrected and nothing is filled in. Each fact and observation carries its verification; the report carries a tally and the list of flagged claims; an uncertainty is added when any is unsupported. In the interface a fact with an unsupported figure is marked where it is read.
- A rollback's deployment id and target version are validated against the deployment evidence separately (section 3).

### How it fares on real model output

Run over the nine reports saved from the live evaluation in Milestone 3, without calling a model: 453 claims, 447 supported, 4 correctly flagged as uncited (a version named in a timeline entry that cites a different item), and 2 false positives (a bare HTTP "500" and a confidence written as "(0.35)"). No wrong measurement was found in those reports. The validator's first pass over the same reports flagged 25 claims; reading them showed most to be its own mistakes (status codes, dates, hyphenated units, the report's own confidence), and those became tests. Six remain flagged.

### Limits

- It is tokenisation plus typed comparison, not understanding. A figure can be correct and cited and still be used to support a conclusion it does not support.
- Derived values are found only as one operation on two values. A percentage of a percentage, or an average of three values, is flagged.
- Words are not checked: "doubled", "most", "a few".
- The model-facing instructions that ask for exact figures and UTC timestamps have not been run against a model in this milestone.

## 6. What has and has not been validated

| | Deterministic tests | Local demo, rule-based engine | Live model |
|---|---|---|---|
| Outcome assessment | Yes | Yes | The guardrails were applied to saved model output from Milestone 3; the changed prompt and schema were not run |
| Action effects, withdrawal rules | Yes | Yes | Same |
| Approval binding, execution outcomes | Yes (API tests) | Yes (runbook-safety scenario) | Not applicable |
| Claim validation | Yes | Yes | Applied to saved model output only |
| Trace retrieval | Yes (stub trace store) | Yes (Jaeger) | No |
| Dependency-chain and trace reasoning | Yes | Yes | These are rule-based-engine rules; a model reasons its own way |

The local demo was run once in full on 12 November 2026: nine of ten scenarios passed, and the tenth passed after the fix it prompted. The table and the caveats are in `demo/README.md`.

See `docs/claude-live-verification.md` for the live runs and `demo/README.md` for the local demonstration.
