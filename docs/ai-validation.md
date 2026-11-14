# Validating the analysis with a live model

**Status, 14 November 2026: no model has been called since the live verification of Milestone 3** ([claude-live-verification.md](claude-live-verification.md)). Since then the report format, the outcome assessment, the action-effect rules, the trace tool and the historical health tool have all changed. Everything about them is verified on the rule-based engine and with a scripted stand-in for a model. Whether a real model behaves well with them is not known.

This document says what was tested without a model, and exactly what a paid run would have to cover. A paid run needs the owner's explicit approval of a budget; none is made by any test, script or CI job in this repository.

## What is tested without a model

| What | How | Where |
|---|---|---|
| The rule-based engine on 14 ground-truth scenarios | Each scored on up to 11 criteria: outcome, cause, service, citations, invention, contradictions, missing evidence, calibration, diagnostics, remediation safety, deployment tool use | `npm run evals -- --heuristic` (in CI) |
| Past incidents | Three scenarios: a dependency that was down then; one that is down only today; one whose state then is not on record. The fake API answers as the real one does, so reading today's state fails them | `services/ai/app/evals/scenarios.py`, `tests/test_historical_health.py` |
| Every report the rule-based engine writes | Pinned byte for byte | `tests/test_heuristics_golden.py` |
| The report's structure | The schema is exported from Python and the API is tested against the export; both guardrail passes run on every report | `tests/test_contracts.py`, `apps/api/tests/contract.test.ts` |
| Evidence references | A citation of evidence that does not exist is removed and the claim demoted; figures are checked against the evidence they cite | `tests/test_agent.py`, `tests/test_reliability.py` |
| A model that reasons from the present about the past | Scripted: it asks for health without a window and blames what is down today. It is shown the window's record, and its unsupported claim is capped and its fact demoted | `tests/test_model_responses.py` |
| A model that contradicts the evidence | Scripted: claims "healthy" over hundreds of errors, with every optional part empty. The outcome is recomputed from the evidence | same |
| Output that cannot be used | Scripted: schema mismatch, not JSON, no answer. The rule-based engine takes over and the report is labelled as such; parser text is not shown | same |
| A model that says and calls nothing | Scripted: the report claims no more than was gathered | same |
| The provider code | Request shape, caching, retries, rate limits, refusals, exhausted credit, spending limits, against a mocked API | `tests/test_claude_provider.py` |

A scripted model does what the script says. It cannot show how a real model reads the instructions.

## What only a live run can show

In order of importance for a pilot. Each line is a question, the scenario that answers it, and what to look at.

| # | Question | Run | Pass when |
|---|---|---|---|
| 1 | Does the model stay within the report format now in use? | All 14 scenarios | Every run ends in a report (no fallback to the rule-based engine for format reasons); `citations` and `no_invention` pass |
| 2 | Does it respect time? | `historical_dependency_outage`, `historical_dependency_recovered`, `historical_health_not_on_record` | It names the cache outage from the window's record in the first; names no dependency in the second and third; says the state is not on record in the third. No hypothesis rests on today's state |
| 3 | Does it call `get_service` sensibly now that the tool takes a window? | The same three, reading the tool calls | Calls succeed; the window is the investigation's (it is added automatically when the model omits it, so this is about wasted or malformed calls) |
| 4 | Does it say "nothing is wrong" when nothing is? | The four `healthy_*` scenarios | Outcome HEALTHY, no fault hypothesis above "unlikely", no production change proposed. The Milestone 3 run reported 0.30 confidence against a bound of 0.25 on one of these |
| 5 | Does it propose only safe actions? | `red_herring_closer_in_time`, `deployment_rollback_target`, `degraded_incomplete_evidence` | `remediation` passes: rollback only of the implicated deployment, to the right version; no "precautionary" change against an unlikely cause |
| 6 | Are its figures true to the evidence? | All, reading `integrity` in each report | No figure flagged unsupported in a fact; flagged figures in other places are counted and reviewed |
| 7 | What does a run cost and how long does it take? | All | Recorded per scenario: tokens, cache hits, calls, seconds, estimated cost |
| 8 | How does it behave when the provider fails mid-run? | One scenario with `AI_REQUEST_TIMEOUT_SECONDS=5` | The investigation ends in a rule-based report labelled as such, not in a failure |

### How to run it, once approved

```bash
cd services/ai
uv run python -m app.evals.run --estimate                      # no call is made: prints the worst-case cost of the run
ANTHROPIC_API_KEY=... uv run python -m app.evals.run --max-cost 2.00   # refuses to run against a model without --max-cost; saves each report under eval-runs/
uv run python -m app.evals.run --rescore eval-runs/<that directory>   # scores the saved reports again, free
```

`--estimate` prints the ceiling before anything is spent; `--max-cost` stops the run before a call that could exceed it; `--only <scenario>` runs one. The Milestone 3 run of six scenarios on `claude-haiku-5-5` cost about $0.12 in total. Fourteen scenarios on the same model should be of the same order per scenario, but the report format is larger now, so take the figure from `--estimate`, not from this sentence.

Saved reports contain only the synthetic scenario data. Keep them (`eval-runs/` is ignored by git): they are what later changes to guardrails and scoring are checked against without paying again.

### What a live run would still not show

Behaviour on a customer's real data, at real volume, with real ambiguity. The scenarios are synthetic and small. A pilot is the first place that is tested, which is one reason reports say "hypothesis" and every production change needs a person.
