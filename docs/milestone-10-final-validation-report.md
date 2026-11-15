# Milestone 10: final validation report

Live AI validation and pilot readiness. Audited on 15 November 2026 against the repository, the saved evaluation reports, the evaluation ledger and the CI records. Every figure below was read from one of those sources during the audit. Figures that could not be checked are marked as such.

**This report does not say OPSILUME is ready for production or commercially launched.** No customer has used it. The model evaluation uses synthetic scenarios, not real incidents.

## 1. Executive summary

- **First live evaluation.** For the first time since Milestone 3, the investigation agent ran against a real model, Anthropic `claude-haiku-5-5`, on all 14 synthetic evaluation scenarios. **13 of 14 passed.** `degraded_incomplete_evidence` failed two criteria: it rated a cause `likely` at confidence 0.50 that the evidence did not establish. This result stands as recorded.
- **Root cause and fix.** The failure exposed a guardrail gap. When the computed outcome was DEGRADED ("anomalies, cause not established"), nothing stopped a hypothesis from staying `likely`. PR #28 closed the gap in both guardrail passes, in the AI service and in the API. It also stopped the API from trusting a report's own claimed outcome.
- **Rescore.** Applying the corrected guardrails to the saved model output from the first run gives 14 of 14. That is post-processing of the original output, not a new model run, and not evidence that the model improved.
- **Repeat.** One live repeat of the failed scenario after the fix passed: 1 of 1. The model itself rated its leading explanation `possible` at 0.40, so the new cap had nothing to correct.
- **Spend.** $0.108031 of an approved $0.87, under a ledger that limits spending by construction. The single permitted repeat is used.
- **Pilot readiness.** Two blockers remain unchanged: GitHub has not been validated against github.com, and no customer, pilot host or external review exists (section 11).

| Result | What it is | Outcome |
|---|---|---|
| Original live evaluation | 14 scenarios, real model, 15 Nov 2026 08:23–08:33 UTC, before PR #28 | **13 / 14** |
| Corrected rescore | The same saved model output with the PR #28 guardrails applied; no model call | 14 / 14 (post-processing, not a live result) |
| Post-fix live repeat | `degraded_incomplete_evidence` only, real model, 15 Nov 2026 09:56 UTC, after PR #28 | **1 / 1** |

The original live run did not pass 14 of 14. Do not quote it that way.

## 2. Scope and non-scope

**In scope:**
- the 14 synthetic scenarios in `services/ai/app/evals/scenarios.py`, served by a simulated tool API;
- one model (`claude-haiku-5-5`) at one setting (effort `medium`, 8,000 output tokens per call, no retries);
- the guardrails, the spending controls, and the test and CI record.

**Not in scope, and not done:**
- real customer data or incidents, and the demo environment's telemetry;
- any other model or provider, and any repeat beyond the single approved one;
- the timeout scenario of `docs/ai-validation.md` question 8, which was not authorised. Timeout handling is covered only by mocked tests;
- GitHub against github.com;
- production hosting, load at production scale, and an external security review.

**The Node API does not take part in a model evaluation.** The runner drives the AI service against a simulated tool API, so the API's independent guardrail pass is shown by its tests, not by the live runs.

## 3. Repository and Git state (verified during the audit)

| Item | State |
|---|---|
| `develop` | `8be2789b9b1c1b19f34cdbc81a2f251b53ecc257`, the merge of PR #28. Working tree clean before this report |
| PR #28 | Two commits: `25041c3` (DEGRADED cap) and `558d5aa` (API takes the outcome only from the assessment). Merged as `8be2789` |
| `main` | `aed4476`, untouched in Milestone 10 |
| Tags and releases | None |
| Backup refs and bundles | 108 refs, 7 bundles, unchanged |

Milestone 10 pull requests, all merged into `develop`:

| PR | Merge commit | What |
|---|---|---|
| #24 | `03e5e9f` | The paid evaluation ceiling holds by construction: settings from the environment only, a ledger across invocations, a bound reserved for every call, no retries |
| #25 | `9c4a0ea` | Stop when a bill exceeds its bound; `--model` required |
| #26 | `14cb6e2` | Key read only from `--key-env`; one repeat per ledger |
| #27 | `e028fd8` | A rule-based fallback is never reported as a live model result |
| #28 | `8be2789` | No `likely` hypothesis under DEGRADED; the API trusts only the assessment's outcome |

## 4. Original live evaluation

Run `services/ai/eval-runs/20261115T082338Z-anthropic-claude-haiku-5-5`, made on `develop` at `e028fd8`, before PR #28.

**Configuration** (from the run's `summary.json`):

| Setting | Value |
|---|---|
| Provider | `anthropic` |
| Model | `claude-haiku-5-5`, as named in every response |
| Effort | `medium` |
| Output tokens per call | 8,000 |
| Retries | 0 |
| Prompt cap | 98,000 tokens |

All 14 reports were written by the model (`mode: llm`): none fell back to the rule-based engine, and no call had an unknown outcome.

| Scenario | Mode | Requests | Cost (USD) | Confidence | outcome | root_cause | service | citations | no_invention | contradictions | missing | calibration | diagnostics | remediation | deployment | Result |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `bad_deploy_matching_change` | llm | 5 | 0.0081 | 0.80 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | pass |
| `upstream_dependency_down` | llm | 7 | 0.0080 | 0.50 | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ | ✓ | ✓ | ✓ | – | pass |
| `healthy_no_signal` | llm | 6 | 0.0065 | 0.20 | ✓ | ✓ | – | ✓ | ✓ | – | – | ✓ | – | ✓ | – | pass |
| `red_herring_closer_in_time` | llm | 5 | 0.0075 | 0.75 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | pass |
| `tool_failures_degrade_gracefully` | llm | 7 | 0.0071 | 0.45 | ✓ | ✓ | – | ✓ | ✓ | – | ✓ | ✓ | ✓ | ✓ | – | pass |
| `healthy_clean` | llm | 5 | 0.0048 | 0.00 | ✓ | ✓ | – | ✓ | ✓ | – | – | ✓ | – | ✓ | – | pass |
| `healthy_old_deployment` | llm | 6 | 0.0067 | 0.00 | ✓ | ✓ | – | ✓ | ✓ | – | – | ✓ | – | ✓ | – | pass |
| `healthy_irrelevant_warnings` | llm | 5 | 0.0051 | 0.00 | ✓ | ✓ | – | ✓ | ✓ | – | – | ✓ | – | ✓ | – | pass |
| `healthy_misleading_signals` | llm | 6 | 0.0076 | 0.20 | ✓ | ✓ | – | ✓ | ✓ | ✓ | – | ✓ | – | ✓ | – | pass |
| `degraded_incomplete_evidence` | llm | 5 | 0.0069 | 0.50 | ✓ | ✗ | – | ✓ | ✓ | – | ✓ | ✗ | ✓ | ✓ | – | **fail** |
| `deployment_rollback_target` | llm | 7 | 0.0086 | 0.80 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | pass |
| `historical_dependency_outage` | llm | 6 | 0.0082 | 0.60 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | pass |
| `historical_dependency_recovered` | llm | 6 | 0.0071 | 0.30 | ✓ | ✓ | – | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | pass |
| `historical_health_not_on_record` | llm | 7 | 0.0086 | 0.25 | ✓ | ✓ | – | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | pass |

✓ pass · ✗ fail · – not applicable to the scenario.

**Totals:**

| | |
|---|---|
| Requests | 83 |
| Input tokens | 122,658 |
| Output tokens | 122,747 |
| Cache reads | 414,816 |
| Cache writes | 184,930 |
| Estimated cost | **$0.100903** |
| Elapsed time | 574.8 s for the 14 scenarios |

By criterion:

| Criterion | Passed |
|---|---|
| Outcome | 14 of 14 |
| Root cause | 13 of 14 |
| Citations | 14 of 14 |
| No invention | 14 of 14 |
| Calibration | 13 of 14 |
| Remediation safety | 14 of 14 |
| Missing evidence | 9 of 9 applicable |
| Contradictions | 7 of 7 applicable |
| Diagnostics | 9 of 9 applicable |
| Service | 5 of 5 applicable |
| Deployment | 1 of 1 applicable |

**The failure.** In `degraded_incomplete_evidence`, search-api is slower, and its calls to index-node time out. No index-node telemetry, trace, change or dependency status explains why.
- **The assessment:** correctly DEGRADED.
- **The model's leading hypothesis:** "index-node is slow or timing out, so search-api calls to it exceed the 2000ms timeout", rated `likely` at 0.50. It cited only symptoms (latency, error rate, the timeout log pattern and a sample line), and the model called it "unconfirmed" in its own summary.
- **The guardrails:** they changed nothing, with 0 notes.
- **The scorer:** it failed `root_cause` ("Rated likely although the cause cannot be established") and `calibration` ("Confidence 0.50; the evidence supports 0.00 to 0.45").

The scorer was right. The product defines DEGRADED as "cause not established", and `likely` starts at 0.50.

## 5. Corrected rescore

`uv run python -m app.evals.run --rescore eval-runs/20261115T082338Z-anthropic-claude-haiku-5-5`. It applies the current guardrails to the model output saved before any guardrail, and calls no model.

- **Result:** "13/14 pass as shown · 14/14 pass with current guardrails". Rerun during this audit on `8be2789`, with the same result.
- **What changes:** only `degraded_incomplete_evidence`, whose leading hypothesis goes from `likely` 0.50 to `possible` 0.45. The other 13 reports come out identical to what was shown, in hypotheses, confidence and outcome.
- **No saved artefact.** The rescore writes nothing; it prints to the terminal. Before this audit it existed only as reported output and the PR #28 description. It was regenerated here.
- **Originals untouched.** All 170 files under `services/ai/eval-runs/` have the same sha256 before and after the audit's rescores.

**The 14 of 14 is a guardrail repair of the first run's output, not better model behaviour.** The live result for that scenario remains a fail.

## 6. Post-fix live repeat

Run `services/ai/eval-runs/20261115T095633Z-anthropic-claude-haiku-5-5`: a separate directory holding `degraded_incomplete_evidence.json` and `summary.json`. It was made after PR #28 merged, with `--repeat --only degraded_incomplete_evidence`.

| | |
|---|---|
| Scenarios run | 1 (`degraded_incomplete_evidence`); `skipped: []` |
| Engine | `anthropic-claude-haiku-5-5`; mode `llm`; served by `claude-haiku-5-5`; no fallback |
| Requests | 7; none of unknown outcome |
| Tokens | Input 9,032 · output 8,451 · cache reads 39,728 · cache writes 12,814 |
| Estimated cost | **$0.007128** |
| Time | 40.8 s |
| Tool calls | 14 |
| Assessed outcome | DEGRADED |
| Leading hypothesis | "index-node is slow or stalling under load, causing search-api's upstream timeouts": `possible`, 0.40, citing E1, E2, E5, E6 |
| Second hypothesis | Traffic growth or an external factor: `unlikely`, 0.15 |
| Report confidence | **0.40** |
| Recommended actions | None. Six next steps for a human |
| Guardrail notes | **None.** The report before and after the guardrails is identical |
| Figures flagged as unsupported | 0 |

Scores:

| Criterion | Score | Note |
|---|---|---|
| Outcome | pass | |
| Root cause | pass | "No fault is rated likely" |
| Citations | pass | 15 of 15 resolve |
| No invention | pass | |
| Missing evidence | pass | |
| Calibration | pass | 0.40 against 0.00 to 0.45 |
| Diagnostics | pass | 6 checks |
| Remediation | pass | |
| Service, contradictions, deployment | n/a | |

**Result: 1 of 1.** It also rescores 1 of 1.

What this shows and does not show:

- **Shown:** after PR #28, on one attempt, the model followed the DEGRADED rule. It did not rate the unestablished cause `likely`, kept confidence under the cap, and said what was missing.
- **Not shown:**
  - that the new guardrail works on live output. It had nothing to correct, so the cap is shown by tests (section 8), not by this run;
  - that the new report instruction caused the change. One sample cannot separate that from run-to-run variation;
  - anything about the API's guardrail pass, which a model evaluation does not involve.

## 7. Guardrail implementation and API enforcement

Checked in the code at `8be2789`.

| Item | Where | Verified |
|---|---|---|
| `unestablishedCauseCap: 0.45`, below `likelyMinimumConfidence: 0.5` | `contracts/guardrails.json` | Yes |
| The generator refuses a cap that is not ≥ 0 and strictly below the likely threshold | `scripts/contracts.mjs` | Yes (refusal checked on a scratch copy during PR #28) |
| The same values and wording are generated into Python, the API and the web app | `services/ai/app/generated/contracts.py`, `apps/api/src/generated/contracts.ts`, `apps/web/src/lib/generated/contracts.ts` | Yes; `contracts:check` clean in CI |
| AI service: under a DEGRADED outcome, **every** hypothesis above 0.45 or rated `likely` is capped at 0.45 and rated no higher than `possible`, with a note. None is removed; overall confidence follows the strongest hypothesis. The module refuses to load if the cap is not below the threshold | `services/ai/app/guardrails.py` | Yes |
| Report instructions: "When the assessment outcome is DEGRADED, anomalies are present but the cause is not established. Do not classify a root-cause hypothesis as likely…" with the cap from the contract | `services/ai/app/graph.py` | Yes |
| API: the outcome is taken only from the assessment, never from the report's own `outcome`. Under DEGRADED, the same cap and status rule | `apps/api/src/modules/investigations/guardrails.ts` | Yes |
| API, no assessment: hypotheses capped; production-changing actions withdrawn to next steps with the `noAssessment` reason; `outcome` null in the report and in storage; an uncertainty and a note added | `guardrails.ts`, `persistence.ts` | Yes |
| A verified assessment wins over the report's claim, both ways (claims DEGRADED but verified INCIDENT: kept; claims INCIDENT but verified DEGRADED: capped) | `apps/api/tests/contract.test.ts` | Yes |
| The regression fixture is the original model output, unaltered | `services/ai/tests/fixtures/live_degraded_incomplete_evidence.json` | Yes: the report before guardrails, evidence, tool calls, known times, scope, tool failures, metric services and health gaps are identical to the original run file |

**Why the assessment can be trusted where the claim cannot.** The model's output schema (`LLMReport`) has an `outcome` field and no `assessment` field. The assessment is computed by `services/ai/app/assessment.py` and attached by the guardrails for every report. Every report the AI service sends passes through that step (`analyse → guard → END` in `graph.py`). The API accepts reports only from the AI service's final event (`stream.ts`).

**Residual trust boundary.** The API relies on the assessment the AI service computed. It cannot itself prove that an INCIDENT assessment is justified, because only the AI service holds the evidence while the report is written. A defect in the assessment, or a compromised AI service, would pass through. `contracts/README.md` records that the assessment is computed only by the AI service, "because only it holds the full evidence while the report is written". It does not state this residual risk in so many words; this report does.

## 8. Test and CI evidence

Read from the CI log of the post-merge run on `develop` at `8be2789` (GitHub Actions run 43700870978, 15 Nov 2026 09:46 UTC, conclusion success):

| Suite | Result in CI |
|---|---|
| AI service, pytest | 276 passed |
| AI service, ruff | All checks passed |
| Rule-based evaluation | 14/14 scenarios passed |
| API, Vitest on PostgreSQL with pgvector | 20 files, 213 passed |
| Web, Vitest | 2 files, 53 passed |
| Backend and frontend lint and type checks | Jobs succeeded |
| Shared contracts and generated API types up to date | `git diff --exit-code` steps succeeded |
| Dependency audit (`npm audit --omit=dev --audit-level=high`) | Passed. It reports 5 moderate-severity advisories in shipped dependencies (`glob`, `minimatch` and dependents), below the gate's threshold |

PR #28, on its head commit `558d5aa`, passed all seven checks: frontend, backend, database integration tests, AI service, build verification, commit messages, and browser end-to-end tests. The end-to-end run (43699554688) included the browser journeys, the failure drills ("All 11 drills passed"), the backup and restore drill ("9 steps"), and the reduced load test, all successful.

The new regression tests:
- **AI service:** 8 tests in `services/ai/tests/test_degraded_guardrail.py`.
- **API:** 4 boundary tests (no assessment with a claimed INCIDENT or DEGRADED; verified INCIDENT; verified DEGRADED) in `apps/api/tests/contract.test.ts`, plus an end-to-end storage test in `apps/api/tests/intelligence.test.ts`.
- **Shared:** one case in `contracts/fixtures/guardrail-cases.json`, run by both services.

Not rerun during this audit: the test suites themselves. Their figures come from the CI log above, not from a local run.

## 9. Spend and ledger reconciliation

`services/ai/eval-runs/m10-ledger.json`, read without modification. Its sha256 was the same before and after the audit.

| Run | Entries | Calls | Cost (USD) | Counts as attempts |
|---|---|---|---|---|
| `20261115T074819Z` (key rejected with 401; every report rule-based) | 14 | 0 | 0.000000 | No: zero-cost entries, kept as a record (PR #27) |
| `20261115T082338Z` (original live run) | 14 | 83 | 0.100903 | Yes: first attempts |
| `20261115T095633Z` (repeat) | 1 | 7 | 0.007128 | Yes: the single repeat (attempt 2 of `degraded_incomplete_evidence`) |
| **Total** | 29 | 90 | **0.108031** | |

| Item | Value |
|---|---|
| Approved ceiling | $0.87 |
| Committed | **$0.108031** (the ledger's `committedUsd` agrees) |
| Remaining | **$0.761969** |
| Repeats | **1 of 1 used.** No further repeat is possible against this ledger |
| Calls of unknown outcome | 0 |
| Overruns | 0 |

These are estimates at the list prices in `services/ai/app/config.py`, checked against Anthropic's published Haiku 5.5 prices on 15 November 2026. The Anthropic Console is the authority on what was billed; its figures were not available to this audit.

All live API usage recorded in the repository to date: $0.1181 (Milestones 3–4, `docs/claude-live-verification.md`) plus $0.108031 (Milestone 10), about **$0.226**.

The run labelled `20261115T074819Z-anthropic-claude-haiku-5-5` holds rule-based reports produced under a rejected key. It is evidence of the silent-fallback defect that PR #27 fixed. It is not a model result and must not be cited as one.

## 10. Security and operational limitations

- **Trust boundary:** the API trusts the AI service's computed assessment (section 7).
- **Isolation in code only:** tenant isolation is enforced in application code, not by the database (no row-level security).
- **Dependencies:** 5 moderate-severity advisories in shipped Node dependencies (section 8). There is no Python dependency audit, image scanning or static analysis in CI, and Dependabot alerts are off.
- **No external security review** or certification.
- **Retries differ outside the evaluation.** Ordinary investigations keep the SDK's 2 retries, whose cost the accounting cannot see. Only the paid evaluation runs with strict, retry-free accounting.
- **One of everything, on one machine:** a single process of each component; no replication, failover, disaster recovery or production-scale validation.
- **Ingestion:** push-only telemetry ingestion; no pull connectors to log or metric vendors.
- **Exposed key:** an earlier API key was exposed by accident and was revoked. The replacement key was never read or printed by the tooling, and no key-shaped string appears in the evaluation files or the ledger.

## 11. Pilot readiness assessment

| Area | Classification | Basis |
|---|---|---|
| Rule-based investigations | Validated with limitations | 14/14 synthetic scenarios in CI; usefulness on real incidents unknown |
| Model-backed investigations (`claude-haiku-5-5`) | Validated with limitations | 13/14 live, then 1/1 on the failed scenario after the fix; synthetic scenarios, one model, one or two samples each |
| Evidence citation and no invention under a live model | Validated with limitations | 14/14 and 1/1 live; synthetic data |
| DEGRADED and unverified-outcome guardrails | Validated | Code and tests in both services, CI green; the live repeat did not exercise the cap |
| Paid-evaluation spend control | Validated | Mocked-API tests of each property; two live runs within reservations, no overrun |
| Remediation safety (human approval, withdrawal rules) | Validated | API tests; no unsafe proposal in 15 live reports |
| Backup and restore | Validated with limitations | Drill in CI; scheduling and off-site copies are the operator's; no point-in-time recovery |
| GitHub integration | **Not validated** | Local stand-in only; not run against github.com |
| External customer pilot | **Not validated** | None conducted |
| Production hosting and operating schedule | **Not validated** | None established |
| Multi-node, replication, disaster recovery, production scale | **Not validated** | Not built or tested |
| Vendor pull connectors | **Not validated** | Not implemented; ingestion is push-based |
| Independent security review | **Not validated** | None done |
| Product name | **Not validated** | OPSILUME has no legal or trademark clearance |
| Commercial billing, enterprise SSO, certifications, SLAs | **Not validated** | Not established |

## 12. Outstanding actions and recommended next steps

1. **Bring the other validation documents up to date.** They were not edited in this audit:
   - `docs/ai-validation.md` still opens with "no model has been called since … Milestone 3";
   - `docs/claude-live-verification.md` has no Milestone 10 runs, and its spend total stops at $0.1181;
   - `docs/pilot-acceptance-report.md` still lists model-backed investigations as not validated.
2. **Close the GitHub gap.** Run the read-only procedure in `docs/github-validation.md`, or exclude GitHub from a pilot.
3. **Make the end-to-end check required on `develop`.** Branch protection still does not require `Browser end-to-end tests` (`docs/git-workflow.md`).
4. **Decide on the moderate dependency advisories** (`npm audit fix` or accept them), and whether to add Python and image scanning.
5. **Prepare a pilot:**
   - choose a host, an operator and a data agreement;
   - arrange a review by someone other than the author;
   - clear the product name.
6. **Before relying on the model in a pilot,** consider a wider sample: more scenarios or repeated runs under a new, separately approved ledger. This ledger's repeat is used.
7. **Optional:** have the API check an INCIDENT assessment against the evidence kinds it has stored, to narrow the trust boundary in section 7.

## 13. Evidence paths and commit references

| Evidence | Location |
|---|---|
| Original live run | `services/ai/eval-runs/20261115T082338Z-anthropic-claude-haiku-5-5/` (14 scenario files and `summary.json`) |
| Post-fix repeat | `services/ai/eval-runs/20261115T095633Z-anthropic-claude-haiku-5-5/` |
| Rejected-key run (not a model result) | `services/ai/eval-runs/20261115T074819Z-anthropic-claude-haiku-5-5/` |
| Rule-based baseline at Milestone 10 | `services/ai/eval-runs/20261115T053519Z-rule-based/` |
| Ledger | `services/ai/eval-runs/m10-ledger.json` |
| Regression fixture | `services/ai/tests/fixtures/live_degraded_incomplete_evidence.json` |
| Guardrails | `services/ai/app/guardrails.py`, `apps/api/src/modules/investigations/guardrails.ts`, `apps/api/src/modules/investigations/persistence.ts` |
| Contract | `contracts/guardrails.json`, `contracts/fixtures/guardrail-cases.json`, `scripts/contracts.mjs`, `contracts/README.md` |
| Runner and ledger code | `services/ai/app/evals/run.py`, `services/ai/app/evals/ledger.py`, `services/ai/tests/test_eval_budget.py` |
| Commits | PRs #24 `03e5e9f`, #25 `9c4a0ea`, #26 `14cb6e2`, #27 `e028fd8`, #28 `8be2789` (commits `25041c3`, `558d5aa`) |
| CI | Post-merge run 43700870978 on `8be2789`; PR #28 end-to-end run 43699554688 on `558d5aa` |

`services/ai/eval-runs/` is ignored by git, so the run directories and the ledger exist only on the machine that produced them. Keep a copy if this evidence must outlive that machine.

## Addendum, 15 November 2026: corrections found while aligning the other documents

These points are missing from the audit above. The text above is left as it was merged; this section corrects it.

1. **Two passes in the original run needed guardrail repair.** In `healthy_no_signal` and `healthy_misleading_signals`, the model concluded DEGRADED with a fault hypothesis rated `possible` at 0.30. The assessment recomputed HEALTHY, and the guardrails capped the hypothesis at 0.20, `unlikely`. They count among the 13 passes because the scorer judges the report the product shows. As the model wrote them, they would have failed the healthy-state question. Guardrail notes appear in 5 of the 14 reports: these two, `upstream_dependency_down` (outcome raised from DEGRADED to INCIDENT by the assessment, and two figure flags), `red_herring_closer_in_time` and `historical_health_not_on_record` (one figure flag each).
2. **Figures flagged by the claim checker.** 595 figures checked in the original run, 574 supported, 21 flagged: 15 uncited, 1 stated as an estimate, 5 unsupported.
   - One unsupported figure sits in a stated fact: "13.33 ERROR" against evidence of "13.33 /min" in `red_herring_closer_in_time`. That looks like a checker false positive on the unit, not yet confirmed.
   - The others are in summaries and one action, including "09:30Z" in `upstream_dependency_down`, which no evidence carries.
   - The repeat: 35 checked, 35 supported.
3. **The pre-set acceptance criteria** of `docs/ai-validation.md` are therefore not all met:
   - question 6 is not met as written;
   - question 4 is met only after guardrail repair.

   Section 11's "Validated with limitations" for model-backed investigations describes the evidence that exists. It is not a pilot go-ahead. For a pilot, model-backed investigations are **not validated** (`docs/pilot-acceptance-report.md`).
4. **Section 12, item 1 is done:** `docs/ai-validation.md`, `docs/claude-live-verification.md` and `docs/pilot-acceptance-report.md` now carry the Milestone 10 results.
5. **Security scanning** has since been configured (`.github/workflows/security.yml`, `.github/dependabot.yml`). See `docs/git-workflow.md` for what has executed and what remains unconfigured. The 5 moderate npm advisories are analysed there.
