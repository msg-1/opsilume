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

`apps/api/src/modules/remediation/`. Only signed-in people can approve, execute, edit, retry or reconcile; API keys and the AI's tool token are refused on those routes.

**Lifecycle.** `PROPOSED → PENDING_APPROVAL → APPROVED → EXECUTING → EXECUTED | FAILED`, with `REJECTED`, and `CANCELLED` from any state before execution. A `FAILED` action carries an outcome: `not_applied` (certainly not done) or `unknown` (may or may not have been done).

### Approval

- **Read-only diagnostics** need no approval. A person records that it was done and what was found. They are never sent to the webhook, so a misjudged text cannot change anything. The effect is recomputed at that moment; if the text now reads as a change, the action is reclassified and refused.
- **State-changing actions** need at least one approval, whatever the organisation's settings say, from someone other than the proposer and the requester (unless self-approval is switched on), and are at least medium risk.
- **The approval fingerprint** (`content.ts`, version 2) is what an approval is given for. The rule: everything an approver is shown and everything the webhook receives, plus where it would be carried out:
  - **content:** type, title, description, rationale, risk, service, incident, source investigation, the evidence the rationale cites, and the parameters;
  - **target:** carried out by hand, or by a webhook, identified by a digest of its address (never the address);
  - **review:** whether the source investigation was unverified when the action was submitted (section 4c).

  Free text is compared after normalising line endings and trailing whitespace only, so re-saving the same text keeps the approvals. Parameters are compared as values: key order does not matter, nothing else is normalised. Each approval stores the fingerprint it was given for. The interface sends the fingerprint it displayed, on approval and on execution, so a person who has an old version open is stopped.
- **Any change supersedes.** An edit that changes the fingerprint supersedes every approval and returns the action to `PROPOSED`. So does a change made underneath the API, a change of execution target, or a change in the source investigation, found at approval or execution (`remediation.approval_invalid`). Superseded approvals stay on record and no longer count. Approval of one action authorises no other, even one with identical content.
- **Earlier fingerprints.** Approvals given under version 1, which did not cover the rationale, the source or the target, are recognised. They are asked for again with their own message (`remediation.approval_fingerprint_outdated`), not reported as a change of content. After an upgrade, every action submitted or approved before it needs approval again.
- **Risk is never lowered.** An edit that would lower the risk is refused; cancel the action and propose it again. On submission, on each approval and at execution, the risk is also worked out again from what the action does and the service it acts on, and raised if the stored one is below that floor. A raise supersedes the approvals and returns the action to `PROPOSED` (`remediation.risk_raised`).
- **The number of approvals needed only goes up.** For an action it is the higher of what its risk requires under the organisation's current settings and what the action already required:
  - on proposal, the current settings;
  - on submission, on an edit (changed or not) and when the risk is raised, never less than before;
  - on approval and at execution, recomputed the same way.

  Lowering the settings therefore never lowers an action already proposed, and raising them applies at once. An unchanged edit leaves the number as it was. If too few approvals count at execution, nothing is executed and the action waits for the rest (`remediation.approval_insufficient`, with the status it moved to).
- **One person counts once,** at approval and at execution.
- **One lock order.** The action's row first, then its approvals. Every operation that records a decision (approve, reject), supersedes approvals (an edit, expiry, invalidation, sending an action back for review) or submits it takes the row lock first. Each acts only if the action is still in the state, and with the fingerprint, it was read in; nothing locks approvals before the action, so these cannot deadlock one another. Execution claims the action with one conditional update of the same row. As a result:
  - an approval and an edit, or a rejection, at the same moment cannot leave an approval counting for content it was not given for;
  - a rejection is recorded only against the content the person saw;
  - expired approvals of an action that has moved on, to execution for example, are left as they were.

  What is not locked: reading an action and the organisation's settings to decide what to do. Every write that follows is conditional, and approval and execution recompute the threshold from the settings as they are then.
- **Audit records match what happened.** Sending an action back for review, invalidating its approvals and superseding expired ones happen in one transaction under the lock, and only if the action has not moved on. If it has, nothing changes, the request is refused, and nothing is audited. The audit records the number of approvals actually superseded and, at execution, the status the action actually moved to (`newStatus`). Existing audit entries are never changed.

### Approval validity: a security policy

An approval counts for `REMEDIATION_APPROVAL_VALIDITY_HOURS`, default 24. This is a policy, not an experimentally established value. Whoever deploys OPSILUME must choose it and review it.
- **Valid values** are whole hours from 1 to 720. Anything else (0, negative, fractional, empty, above 720, not a number) stops the API from starting.
- **Expiry is judged by the database clock,** which also timestamps approvals, at approval and at execution. An approval dated more than five minutes ahead of it does not count.
- **An expired approval stays expired.** It is superseded when found: it stays on record, never counts again whatever any clock says later, and its approver may decide again. Repeating an old approve request does not revive it either: it is a new approval, made now, by a signed-in person, for the fingerprint the action has now. The action returns to `PENDING_APPROVAL`. The audit records the time of each expired approval and the cutoff (`remediation.approval_expired`).
- **Approvals are never extended.**

### Execution, outcome and reconciliation

- **Once.** The action is claimed atomically, under the fingerprint that was checked; a second request at the same moment is refused.
- **Outcome.** A 2xx from the webhook is `applied`. A 4xx, or an address refused before sending, is `not_applied`. A timeout, a dropped connection or a 5xx is `unknown`: the request was sent and nobody knows whether the change happened. That is recorded as unknown, never as executed and never as a clean failure, and no effect is written to the service history.
- **Failures never name the destination.** Messages from the network library, DNS and TLS name the host, the address or the URL, with any credentials or query string in it. So the stored, shown and audited summary gives a category only. The category is worked out from error codes and names, across nested causes, and is also stored as `executionResult.detail.failure`:
  - `timeout`, `resolve`, `refused`, `reset`, `unreachable`, `tls`;
  - `disallowed` (a private address), `invalid` (not an acceptable URL);
  - `other`.

  A redirect is not followed, and where it pointed is not recorded. Saving a webhook address records in the audit log only that it changed or was removed.
- **A stopped process.** If the process stops after claiming the action, the action stays `EXECUTING`. The worker's sweep (`reapStranded`, `apps/api/src/modules/system.ts`) finds it after `REMEDIATION_EXECUTION_STALE_MINUTES`:
  - The threshold defaults to 10 and must be at least a minute longer than the webhook timeout.
  - The sweep records the outcome as `unknown` (`interrupted`), keeping the attempt's number, fingerprint, start time and idempotency key (`remediation.execute_interrupted`).
  - It moves only that exact attempt, so two workers sweeping at once record it once.
  - It never resets the action to `APPROVED` or `PROPOSED`, and never sends anything.
- **A late outcome.** The outcome of an attempt is written only while that attempt is still in progress. An answer that arrives after the attempt was recorded as interrupted goes to the audit log (`remediation.outcome_after_interruption`) and changes nothing else.
- **Reconciliation** (`POST /remediations/:id/reconcile`, needs `remediation:execute`). For the latest attempt whose outcome is unknown, a person checks the target system and records what they found, with notes. Nothing is sent anywhere.

  | They record | Result |
  |---|---|
  | applied | The action is `EXECUTED`, and its effect goes on the service history |
  | not applied | It stays `FAILED` with outcome `not_applied`, and may be retried |
  | still unknown | It stays blocked, with the check on record, and can be reconciled again later |

  The decision is conditional on the attempt and the state, so a second decision made from the same view is refused. Every decision is audited (`remediation.reconcile`) and kept on the execution record.
- **Retry only after "not applied" is established.** A retry names the attempt it retries (`{ attempt }`), and is accepted only for the latest attempt and only when its outcome is `not_applied`:
  - either the webhook refused it (a 4xx, or a destination refused before sending), so nothing was sent or applied;
  - or a person recorded "not applied" through reconciliation, as a separate decision.

  An unknown outcome is never retried on anyone's word inside the retry request. The former `confirmNotApplied` shortcut is gone. A retry returns the action to `APPROVED`, conditionally on the attempt, so concurrent retries count once. Execution then checks everything again: the fingerprint, the source investigation and its evidence, the risk, and the number and age of the approvals. The audit records the reconciliation (`remediation.reconcile`) and the retry (`remediation.retry`, with `notAppliedBecause: refused | reconciled`). Every attempt carries the same idempotency key (`Idempotency-Key` header and `idempotencyKey` in the body), so a receiver that did apply the first attempt can refuse the second.
- **Record.** The execution result and the audit trail carry the approval fingerprint, the approvers with the time of each approval, the attempt number, the source check, the mode and the outcome.

**Operator procedure for an unknown outcome.**
1. Open the action. An interrupted attempt says so under "Mode".
2. Check the target system for the change, using the attempt number and the idempotency key (the action id).
3. Record what you found with "Record what happened": applied, not applied, or still unknown, saying what you checked.
4. Only after "not applied" is recorded, retry (naming the attempt), and execute again. Execution checks the current approvals, which may have expired meanwhile, so fresh approval may be needed.
5. Look in the audit log for a late outcome (`remediation.outcome_after_interruption`): it can tell you what the webhook answered after the attempt was marked interrupted.

**What OPSILUME cannot guarantee:**
- that a webhook receiver honours the idempotency key;
- that a person who records an outcome checked;
- what an external system actually did.

These controls make sure nothing is repeated or assumed by the product itself. They do not establish the outcome.

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
- **A consistency check at the API** (`trustedAssessment` in `guardrails.ts`). An assessment is used only if every reference it cites is evidence the API itself recorded for that run, and an INCIDENT, the only outcome that allows production changes, cites at least one. Otherwise it is dropped: the outcome is not verified, no production change is offered, and a guardrail note says why. Every INCIDENT assessment in the golden snapshot and in every saved evaluation run cites at least one reference, and every evidence item the AI service cites is sent to the API before the report, so a genuine report is not dropped: `services/ai/tests/test_agent.py` checks this for every scenario on the rule-based engine and the mock, and the browser test of a real rule-based investigation needs a trusted INCIDENT to propose its rollback. This check catches an assessment that does not fit the evidence. It does not catch one that fits the evidence but was not computed by `assessment.py`.

Signing the assessment would add a key to manage and rotate, and would protect only against something that can already answer as the AI service. It was not added.

**Reports stored before this change.** They are not migrated and nothing stored is changed. When one is read, `apps/api/src/modules/investigations/legacy.ts` presents it as a new report would be:

| Stored report | Shown as |
|---|---|
| Carries `summarySource` (every report from this change on) | Exactly as stored |
| Rule-based (from the report's `analysisMode`, else the row's, else a `heuristic` provider) | Its own summary, as stored; hypothesis ratings at the current caps (section 4c) |
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
- **API:** the API pass, including a missing assessment and assessments that cite unrecorded evidence or, for an incident, none, in `apps/api/tests/contract.test.ts`. Through the real path (a scripted AI service stream, the guardrails, storage, then every response) in `intelligence.test.ts`: a contradictory model report with a verified assessment, a missing assessment, an assessment citing unrecorded evidence, a rule-based report, and stored older reports with a trusted, absent, unrecorded-evidence or malformed assessment and a rule-based one. Every case checks the detail, the list and the incident. The contradictory, rule-based and stored older reports also check the remediation actions; every stored older report also checks the timeline entry, and that reading leaves the stored row unchanged; the trusted older report also checks a new postmortem. The view rules alone are in `legacy.test.ts`.
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
- **Copies made before this change keep the old text.** Notifications already delivered and postmortems already drafted are not rewritten (section 4c). Remediation actions proposed from an older report are checked again before anything happens to them (section 4c). A fresh install has no older rows: the seed creates no investigations and the demo uses the rule-based engine.
- **Older hypotheses are shown at the current caps,** with their stored ratings beside them (section 4c).
- **An older report shown as verified is verified now, not then.** Its summary is derived when it is read, from the assessment it stored.
- **The evaluation scores the AI service's output.** It does not run the API pass or the read-time view, which are tested separately, and its outcome patterns undercount paraphrases (above).
- **The model is not told the computed outcome before it writes.** The outcome depends on the hypotheses, which come in the same answer. The prompt is unchanged.

## 4c. Source investigations, older actions, confidence and copies

**Which proposals have a source to check.** A state-changing action linked to an investigation, whoever proposed it, and every AI proposal (one without an investigation has lost its source). `apps/api/src/modules/remediation/source.ts` checks it from what is stored, when it is proposed, submitted, approved, executed or shown:
- the investigation still exists;
- its stored assessment is well formed, cites only evidence recorded for that run (an INCIDENT at least one), and is INCIDENT;
- the evidence the rationale cites (its last `Evidence:` line) was recorded for that run.

Anything unclear counts as unverified. The result is recorded in the audit log on `propose`, `request_approval`, `approve` and `execute_start`.

**An unverified source needs a fresh human review.** It is neither discarded nor rejected: rejecting it would only teach people to drop the link, since an unlinked proposal is judged as before.
- **Approvals given before are set aside.** While the source is unverified, approvals are bound to a fingerprint that marks it (section 4), so approvals given before, or without acknowledging it, never count. An action already submitted or approved goes back to `PROPOSED`, with its approvals kept on record (`remediation.source_review_required`).
- **Each person acknowledges it.** Submitting and each approval need `acknowledgeUnverifiedSource: true`. The interface shows the reasons, says whether an AI proposed it or it is linked to an investigation, and asks each person to confirm that their decision does not rely on the investigation.
- **Nothing is executed automatically** because it was approved earlier.

Authorship is kept: a human proposal stays a human proposal. Human proposals not linked to an investigation, and read-only diagnostics, keep the existing policy, with no source check. An action whose source is verified goes through exactly as before. Once an action has left the approval stage (executing, executed, rejected, cancelled), its approvals are shown as they counted when it was decided.

Limits:
- **Only AI proposals carry structured evidence references.** A person's rationale is checked for an `Evidence:` line only if they wrote one.
- **The link can be removed.** A human proposal created without an investigation link, or whose investigation was deleted, is not source-checked. Deleting the investigation does change the fingerprint, so approvals given before no longer count.
- **Consistency, not proof.** The source check is the same consistency check as in section 4b: it cannot tell a stored assessment that fits its evidence from one that was not computed by the AI service.

**Confidence of older reports.** A report stored before `summarySource` existed, from any engine, is shown with the hypothesis ratings the current rules permit under its trusted outcome (`presentHypotheses` in `apps/api/src/modules/investigations/legacy.ts`):

| Trusted outcome | Each hypothesis is shown |
|---|---|
| HEALTHY or UNDETERMINED | Unlikely, at most `noFaultHypothesisCap` (0.2) |
| DEGRADED, or no trusted assessment | At most `unestablishedCauseCap` (0.45), and not likely |
| INCIDENT | As stored, unless it cites no recorded evidence: then at most `unsupportedHypothesisCap` (0.3), and not likely |

- **Caps:** the engine's maximum confidence applies in every case too.
- **Direction and order:** ratings are only ever lowered, never raised, and the order is kept.
- **Overall confidence:** shown no higher than the strongest hypothesis shown.
- **Stored values:** unchanged, and returned beside the shown ones (`asRecorded`, `confidenceAsRecorded`).
- **Labelling:** the investigation page and the printable report label the stored values as historical, not current.
- **Where the shown values are used:** the list, the incident page, the dashboard and a postmortem drafted now. The analytics averages use the stored values.

**Earlier AI output in the knowledge base.** A postmortem drafted by OPSILUME copies text from records that are still stored:
- what the incident's AI investigations reported: their summaries, narratives and hypotheses, the "AI investigation completed" timeline entries, and the actions the AI proposed;
- what people recorded on the incident: title, description, impact, root cause, resolution, the other timeline entries, and the actions people proposed.

Before summaries were built from the assessment, an investigation's summary was a model's own narrative. Postmortems can be edited, so the agent's knowledge search (`apps/api/src/modules/knowledgeProvenance.ts`) decides provenance from stored records, not from formatting.

**Whether OPSILUME drafted the document.** A postmortem counts as drafted when either of these holds:
- it is linked to an incident, which through the API only the generator does;
- there is a `postmortem.create` audit entry for it.

Either is enough. Audit writes are best-effort (a failed write is logged, not retried), so the incident link keeps a drafted postmortem from reading as written by people when its audit entry is missing. The seeded demo postmortem is linked to its incident, so it is treated as drafted.

**Where each piece of text came from.** The chunk is split into the pieces the template assembled: a line; a timeline entry's message; a hypothesis or action line's parts. Each piece is attributed:
- **template:** headings, the summary fields, placeholders;
- **AI:** contained in what an investigation reported, or sharing a 48-character window with it. The template's "Analysis by … These are hypotheses" line and "AI investigation completed" lines are AI markers;
- **people:** contained in what was recorded on the incident;
- **unmatched:** anything else.

Text is compared after normalising whitespace, case and Markdown emphasis. Pieces with fewer than four letters or digits say nothing and are skipped. Text found in both an AI record and a people record counts as AI. Renaming, removing or reordering headings, and where a chunk starts, do not change the answer; a piece cut at a chunk edge is still contained in the record it came from.

| Pieces in the chunk | `provenance` | `provenanceBasis` | Given to the agent as |
|---|---|---|---|
| Every substantive piece is something people recorded | `document` | `incident_record` | As written: usable operational knowledge, such as the resolution steps |
| Some AI pieces, no people pieces | `earlier_ai_output` | `source_match` (or `heading` when only the template's markers identify it) | Labelled "[Earlier AI output, not evidence …]", as historical and unverified when it contains a model's own summary or narrative; the incident's current verified assessment attached separately |
| AI pieces and people pieces | `contains_earlier_ai_output` | as above | Each AI line labelled "[earlier AI output, unverified]" where it stands |
| No AI piece, and at least one unmatched piece, even beside people's text | `unknown` | `unmatched` | Labelled "[Origin unknown, not evidence …]" |
| Template lines only | `unknown` | `template_only` | Labelled as template text, not evidence |

A document is `document` only when every substantive piece of it is attributed to what people recorded. A partial match never makes a chunk trusted. Any document OPSILUME did not draft (runbooks, guides, postmortems people wrote without an incident link) is `document` (`not_generated`).

**What can support a report.** Only knowledge text whose provenance is explicitly `document`. This is an allowlist in both services: earlier AI output, unknown origin, and a missing or unrecognised provenance may be read and cited, never as support. A postmortem result that carries no provenance is `unknown` in the AI service.

In both guardrail passes:
- a hypothesis citing only such text is capped at `unsupportedHypothesisCap` and is not likely;
- a "fact" resting only on it becomes an assumption;
- a production change resting only on it is withdrawn (`withdrawalReasons.earlierAiOutput`, a shared guardrail case).

The figure checker (`services/ai/app/claims.py`) uses only evidence that can support anything. A number or timestamp that appears only in such text is never "exact": it is reported as appearing in no collected evidence. It can never make an outcome INCIDENT, because the assessment counts only evidence that can be a cause, and a knowledge document is not one. The rule-based engine does not let it corroborate a mechanism or suggest a "documented procedure", and the system prompt says it is not evidence. Neither the stored document nor any database row is changed.

Limits:
- **The API trusts the AI service's label at its boundary.** The API computes provenance when the agent searches. When the report comes back, its guardrail pass reads the provenance on each evidence item as the AI service recorded it, and does not recompute it or compare it with what the search returned. Anything other than `document` is treated as not evidence there.
- **Audit entries can be missing.** Audit writes are best-effort. The incident link is the second signal; a drafted postmortem that lost both would read as written by people. Through the API that cannot happen: the link is set when it is drafted and cannot be removed, and incidents cannot be deleted.
- **Matching recognises copied text, not meaning.** Model text that a person rewrote in their own words matches nothing, and is then `unknown`: not evidence, but not identified as AI output either. Text copied by hand into a new, unlinked document reads as written by people.
- **Conservative by construction.** Text people wrote in a drafted postmortem that is not in an incident record (added later, or reworded) makes its chunk `unknown`. This includes the seeded demo postmortem's prose. Such text is still readable; it just supports nothing.
- **"Historical" is approximate.** It means the chunk contains a model's own summary or narrative, or was identified only by the template's markers.
- **Only the agent's search is labelled.** People see documents as written.
- **No new column.** A stored per-chunk provenance field would need a migration and a backfill; none was added. The incident link, the audit entry and the source records are the structured provenance.
- **The label's effect on a real model's wording has not been measured:** no model was called. What is enforced does not depend on the model reading the label: the allowlist in both guardrail passes, the figure checker and the rule-based exclusion.

**Copies made before.**

| Record | Corrected when read? | Why |
|---|---|---|
| Investigation detail, list, incident page and its completion entry, remediation actions, dashboard | Yes | Derived from the stored report at each read (section 4b and above) |
| Postmortem drafted from now on | Yes | Built from the same view |
| Postmortem drafted before, as shown to people | No | A document people may have edited and shared. It is not rewritten. |
| Postmortem drafted before, as given to the investigation agent | Labelled when read, not rewritten | Classified from the incident link, the generator's audit entry and the stored source records ("Earlier AI output in the knowledge base") |
| In-app notification already delivered | No | A delivered message is not rewritten. Its body may quote an older model summary |
| Audit log | No | A record of what happened at the time |

New notifications and postmortems carry the verified summary, never the unverified narrative.

**Tests.**

`apps/api/tests/legacy-remediation.test.ts` covers older actions:
- actions whose source has no assessment, a malformed one, unrecorded evidence, a non-INCIDENT outcome or a deleted investigation;
- the fresh-review path for AI and human proposals;
- linked and unlinked human proposals;
- risk raised and never lowered;
- expired and future-dated approvals;
- distinct approvers;
- concurrent executions.

The same file covers the fingerprint:
- edits of the rationale, cited evidence, parameters, description and target;
- source and incident changes made underneath the API;
- identical content submitted twice;
- a stale execution request;
- approvals under the v1 fingerprint;
- an approval racing an edit over repeated rounds.

It also covers older-report confidence.

Other files:
- `reconciliation.test.ts` simulates a process stopping:
  - before sending;
  - after sending, before any response;
  - after a success response, before it was stored.

  It also covers a timeout, a 5xx, duplicate sweeps, a late outcome, all three reconciliation decisions, duplicate decisions and an explicit retry.
- `knowledge-provenance.test.ts` runs the real indexer and the agent's search over drafted postmortems:
  - with their original headings, a renamed findings heading, no findings heading, and reordered sections;
  - with model text split across chunks;
  - with their sources deleted (then `unknown`);
  - with findings and a resolution in one chunk;
  - with a lost audit entry but an incident link;
  - the seeded demo postmortem itself, read from `prisma/seed.ts` (no chunk is `document`);
  - people's text mixed with paraphrased AI text, with AI text shorter than the matching window, with short unmatched text, or with text from a deleted investigation (never `document`);
  - a chunk entirely from people's records (`document`), and template lines only (`unknown`, `template_only`);
  - an unlinked postmortem without an audit entry (`document`).
- `services/ai/tests/test_knowledge_provenance.py` also checks that a figure appearing only in earlier AI output, unknown, missing or unrecognised provenance is never "exact", while one in a trusted document is. It also checks that unknown and missing provenance support no hypothesis, fact, corroboration or production change.

  It also runs a report through the API whose hypotheses, facts and production change rest only on earlier AI output, text of unknown origin, or text with no provenance.
- `remediation-consistency.test.ts` covers:
  - audits that match the transitions that happened (including simultaneous and repeated requests, and an action cancelled mid-way);
  - approval against rejection, rejection against rejection, and rejection against edit, at the same moment;
  - expiry and invalidation of an action that moved on, and expiry racing a cancel;
  - webhook failures (DNS, refusal, TLS, timeout, a redirect, credentials in the URL, nested and unexpected errors) recorded without the host, address, URL or credentials, and the settings audit without the address;
  - the approval threshold under raised and lowered settings, unchanged and content edits, a risk increase, edits racing a settings change, and execution after a change.

  Each protection was switched off in turn, and its test failed.
- `reconciliation.test.ts` also walks reconcile, retry and execute, with each current rule refusing in turn (changed content, a risk below the floor, an expired approval, a source that no longer supports it), and concurrent retries and executions resulting in exactly one webhook call.
- `config.test.ts` covers the validity bounds.
- `services/ai/tests/test_knowledge_provenance.py` covers the AI service side.
- The lifecycle tests already in `safety.test.ts` were updated for the new policy: a rationale edit and a target change need fresh approval; risk cannot be lowered.
- The web tests cover the review notice, the acknowledgements, the expired-approval label, the recorded ratings and the reconciliation control.

Each new guard was switched off in turn, and its tests failed. The approval-and-edit race test failed in each of three runs with the locks removed.

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
