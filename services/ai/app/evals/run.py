"""Evaluation harness for the investigation agent.

    uv run python -m app.evals.run --heuristic          # rule-based engine: free, used in CI
    AI_PROVIDER=anthropic ANTHROPIC_API_KEY=... uv run python -m app.evals.run --max-cost 1.00 --ledger eval-runs/<name>.json
                                                        # configured model: REAL API CALLS, capped
    uv run python -m app.evals.run --estimate           # what a paid run may cost at most; calls nothing
    uv run python -m app.evals.run --json
    uv run python -m app.evals.run --rescore eval-runs/<dir>   # score saved reports again: free

Every run writes the complete report, steps, evidence and usage of each scenario to
services/ai/eval-runs/<timestamp>-<engine>/ (git-ignored), so a result can be studied afterwards
without running, or paying for, the scenario again. Use --no-save to skip that.

Each scenario is a small fake of the OpsPilot tool API with a known answer, so the whole agent
runs unchanged against it. With a real model, --max-cost is a hard ceiling: every scenario's
provider is limited to what is left of the budget, and a scenario is not started if it could
exceed the remainder.

Scores, per scenario (app/evals/scoring.py explains each; every one carries an explanation):
  root_cause service citations no_invention contradictions missing calibration diagnostics
  remediation deployment

Spending. With a real model:
  - Configuration comes from the process environment only. The repository's .env is not read,
    so a key or a price override in it cannot be used by accident. AI_PROVIDER=anthropic must be
    set explicitly, the model must have a known price, and price overrides are refused.
  - The ceiling lives in a ledger file (--ledger, required) shared by every invocation that
    names it, so a repeat or a resumed run spends from what is left, never from a fresh budget.
    A scenario's limit is reserved in the ledger before it starts and replaced by its cost after.
  - A scenario starts only if what is left covers its expected cost plus one worst-case call,
    and its provider is limited to what is left (at most the per-investigation limit).
  - Before every call the provider computes an upper bound on what that call can cost, from the
    size of the request and the output limit, and refuses the call if the bound does not fit.
    A prompt that could exceed EVAL_MAX_PROMPT_TOKENS is refused, so the long-prompt prices
    cannot apply. The SDK does not retry (AI_MAX_RETRIES is forced to 0). A call that fails in a
    way that may have been billed (timeout, dropped connection, server error) is charged at its
    upper bound. A response from a different model stops the scenario's model calls.
  - The run stops at the first scenario that does not fit.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from .. import guardrails
from ..config import EVAL_MAX_PROMPT_TOKENS, HAIKU_LONG_PROMPT_THRESHOLD, PRICING, Settings
from ..graph import Context, run_investigation
from ..llm import LLMProvider, Resolution, build_provider, call_cost_bound, resolve
from ..schemas import InvestigationReport, InvestigationRequest
from ..tools import ToolClient
from .ledger import Ledger, LedgerError
from .scenarios import NOW, SCENARIOS, Scenario, t
from .scoring import CRITERIA, DIAGNOSTIC_ACTIONS, Score, score, unsafe_actions

__all__ = ["DIAGNOSTIC_ACTIONS", "Result", "evaluate", "live_settings", "max_calls_per_scenario", "rescore", "run_all", "unsafe_actions", "worst_case_call_usd"]

RUNS_DIR = Path(__file__).resolve().parents[2] / "eval-runs"

# Assumed cost of a scenario before any has run, used only to decide whether to start it.
FIRST_SCENARIO_ESTIMATE_USD = 0.02


def worst_case_call_usd(model: str, settings: Settings) -> float:
    """Most one call of a paid evaluation can cost: the largest prompt the provider will send
    (EVAL_MAX_PROMPT_TOKENS), all written to the cache, and an answer that uses every output token
    allowed. The provider refuses any call whose own bound is higher, so this is a true ceiling."""
    assert EVAL_MAX_PROMPT_TOKENS <= HAIKU_LONG_PROMPT_THRESHOLD
    bound = call_cost_bound(model, EVAL_MAX_PROMPT_TOKENS, settings.ai_max_tokens, settings)
    if bound is None:
        raise SystemExit(f"No price is known for {model}, so the spending ceiling cannot be enforced.")
    return bound


def max_calls_per_scenario(settings: Settings) -> int:
    """Model calls one scenario can make: the plan and the report (each may be asked again as plain
    JSON when the API cannot compile its schema), and one call per round of the tool loop."""
    return 2 + (settings.max_tool_rounds + 1) + 2


def live_settings(settings: Settings, model: str, limit: float) -> Settings:
    """The settings one paid scenario runs with: no SDK retries, a prompt cap below the long-prompt
    prices, the model pinned, every call reserved at its upper bound before it is sent, and a
    spending limit of `limit`."""
    return settings.model_copy(update={
        "ai_max_retries": 0, "ai_max_prompt_tokens": EVAL_MAX_PROMPT_TOKENS, "ai_expected_model": model, "ai_strict_spending": True,
        "ai_max_cost_usd_per_investigation": min(limit, settings.ai_max_cost_usd_per_investigation),
    })


@dataclass
class Result:
    scenario: str
    provider: str
    model: str | None
    mode: str
    scores: dict[str, Score]
    confidence: float
    top_hypothesis: str
    actions: list[str]
    proposed_rollback: bool
    tool_calls: int
    tools_used: list[str]
    guardrail_notes: int
    llm_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    tokens: int = 0
    cost_usd: float = 0.0
    seconds: float = 0.0
    #: Calls that failed in a way that may have been billed, and what they were charged
    unknown_calls: int = 0
    unknown_cost_usd: float = 0.0
    #: Elapsed time of the whole scenario, tools and guardrails included (seconds is model time)
    wall_seconds: float = 0.0
    served_model: str | None = None
    #: Set when a bill contradicted the bound reserved for it. The run stops.
    bound_exceeded: str | None = None
    #: Why the model stopped being used in this scenario, if it did (our own wording)
    model_stopped: str | None = None

    @property
    def fell_back(self) -> bool:
        """A model was configured, but the report was written by the rule-based engine."""
        return self.provider != "heuristic" and self.mode == "heuristic"

    @property
    def answered_calls(self) -> int:
        """Model calls that returned an answer (calls of unknown outcome excluded)."""
        return self.llm_calls - self.unknown_calls

    @property
    def passed(self) -> bool:
        # A fallback is not a result of the model being evaluated, however well the rule-based
        # report scores. The scores themselves are unchanged.
        return all(s.ok for s in self.scores.values()) and not self.fell_back

    @property
    def failures(self) -> list[str]:
        engine = [f"engine: the model was configured but the report was written by the rule-based engine ({self.model_stopped or 'reason not recorded'})"] if self.fell_back else []
        return engine + [f"{name}: {s.why}" for name, s in self.scores.items() if not s.ok]

    def wire(self) -> dict[str, Any]:
        return {**asdict(self), "passed": self.passed, "fellBack": self.fell_back}


async def evaluate(scenario: Scenario, provider: LLMProvider | None, settings: Settings | None = None, save_to: Path | None = None) -> Result:
    events: list[dict[str, Any]] = []

    async def emit(event: dict[str, Any]) -> None:
        events.append(event)

    tools = ToolClient("http://opspilot.test", "eval-token", transport=httpx.MockTransport(scenario.handler()))
    request = InvestigationRequest(investigation_id=f"eval-{scenario.name}", question=scenario.question, organization_name="Eval Org", api_url="http://opspilot.test", tool_token="eval-token", time_window=scenario.time_window(),
        # The scenario data is recorded at a fixed moment; the agent investigates as of that moment.
        current_time=t(0),
    )
    ctx = Context(request=request, settings=settings or Settings(_env_file=None), tools=tools, provider=provider, emit=emit)

    # Keep the report as the engine wrote it, before the guardrails repair anything: citation
    # accuracy and invention are properties of the engine, not of the safety net behind it.
    notes: list[str] = []
    raw: list[InvestigationReport] = []
    enforce_args: dict[str, Any] = {}
    original = guardrails.enforce

    def spy(report: InvestigationReport, store: Any, **kwargs: Any) -> list[str]:
        raw.append(report.model_copy(deep=True))
        enforce_args.update(kwargs)
        result = original(report, store, **kwargs)
        notes.extend(result)
        return result

    guardrails.enforce = spy  # type: ignore[assignment]
    began = time.perf_counter()
    try:
        report = await run_investigation(ctx)
    finally:
        guardrails.enforce = original  # type: ignore[assignment]
        await tools.aclose()

    steps = [e["step"] for e in events if e.get("type") == "step"]
    calls = [{"tool": st.get("toolName"), "input": st.get("input"), "ok": st.get("status") != "failed"} for st in steps if st.get("type") == "tool_call"]
    # Everything the investigator was shown: the briefing's own values and every tool result.
    seen = json.dumps([scenario.question, t(0), t(120), [st.get("output") for st in steps if st.get("type") == "tool_call"]], default=str)
    scores = score(scenario, report, raw[0] if raw else report, ctx.store, notes, calls, seen)

    top = report.hypotheses[0] if report.hypotheses else None
    usage = provider.usage if provider else None
    result = Result(
        scenario=scenario.name,
        provider=provider.name if provider else "heuristic",
        model=(provider.served_model or provider.model) if provider else None,
        mode=report.analysis_mode,
        scores=scores,
        confidence=report.confidence,
        top_hypothesis=top.title if top else "(none)",
        actions=[f"{a.type}:{a.risk}" for a in report.recommended_actions],
        proposed_rollback=any(a.type == "rollback_deployment" for a in report.recommended_actions),
        tool_calls=ctx.tool_calls,
        tools_used=sorted({str(c["tool"]) for c in calls}),
        guardrail_notes=len(notes),
        llm_calls=usage.calls if usage else 0,
        input_tokens=usage.input_tokens if usage else 0,
        output_tokens=usage.output_tokens if usage else 0,
        cache_read_tokens=usage.cache_read_tokens if usage else 0,
        cache_write_tokens=usage.cache_write_tokens if usage else 0,
        tokens=usage.total_tokens if usage else 0,
        cost_usd=round(usage.cost_usd, 6) if usage else 0.0,
        seconds=round((usage.latency_ms if usage else 0) / 1000, 1),
        unknown_calls=usage.unknown_calls if usage else 0,
        unknown_cost_usd=round(usage.unknown_cost_usd, 6) if usage else 0.0,
        wall_seconds=round(time.perf_counter() - began, 1),
        served_model=provider.served_model if provider else None,
        bound_exceeded=getattr(provider, "bound_exceeded", None),
        model_stopped=ctx.llm_stopped or None,
    )
    if save_to is not None:
        save_to.mkdir(parents=True, exist_ok=True)
        record = {
            "scenario": {"name": scenario.name, "question": scenario.question, "description": scenario.description, "expect": asdict(scenario.expect), "asOf": t(0)},
            "result": result.wire(),
            "report": report.wire(),
            "reportBeforeGuardrails": (raw[0] if raw else report).wire(),
            "guardrailNotes": notes,
            "toolCalls": calls,
            "knownTimes": enforce_args.get("known_times") or [],
            "scope": enforce_args.get("scope") or [],
            "toolFailures": enforce_args.get("tool_failures") or [],
            "metricServices": sorted(ctx.store.metric_services),
            # Dependencies whose state in a past window was not on record: part of what the assessment says is missing.
            "healthGaps": list(ctx.store.health_gaps),
            "evidence": [e.model_dump(by_alias=True) for e in ctx.store.items],
            "events": events,
        }
        (save_to / f"{scenario.name}.json").write_text(json.dumps(record, indent=2, default=str) + "\n")
    return result


async def run_all(resolution: Resolution | None, settings: Settings, max_cost: float | None, log: Any = print, save_to: Path | None = None, only: list[str] | None = None, ledger: Ledger | None = None) -> tuple[list[Result], list[str]]:
    """Runs the scenarios one after another. Returns the results and the names of any skipped for budget.

    With a ledger, the ceiling is the ledger's and what was spent by earlier invocations counts;
    without one, the ceiling is `max_cost` for this invocation alone (used by tests and mocks).
    """
    results: list[Result] = []
    skipped: list[str] = []
    spent = 0.0
    scenarios = [s for s in SCENARIOS if not only or s.name in only]
    live = resolution is not None and resolution.available
    paid = live and resolution.provider != "mock"  # type: ignore[union-attr]
    reserve = worst_case_call_usd(resolution.model, settings) if paid and max_cost is not None else 0.0  # type: ignore[union-attr, arg-type]
    run_name = save_to.name if save_to else ""
    for index, scenario in enumerate(scenarios):
        provider = None
        scenario_settings = settings
        entry = None
        if live:
            assert resolution is not None
            if max_cost is not None:
                remaining = ledger.remaining() if ledger else max_cost - spent
                expected = max((r.cost_usd for r in results), default=FIRST_SCENARIO_ESTIMATE_USD) * 1.25
                if expected + reserve > remaining:
                    # Stop here rather than skip ahead: later scenarios cost about the same.
                    skipped.extend(s.name for s in scenarios[index:])
                    log(f"  stopped before {scenario.name}: it needs about ${expected:.4f} plus ${reserve:.4f} for one worst-case call, and ${max(remaining, 0):.4f} of the budget is left")
                    break
                # The provider refuses any call whose upper bound does not fit in this limit, so
                # the scenario cannot spend more than what is left.
                scenario_settings = live_settings(settings, str(resolution.model), remaining) if paid else settings.model_copy(update={"ai_max_cost_usd_per_investigation": min(remaining, settings.ai_max_cost_usd_per_investigation)})
                if ledger is not None:
                    entry = ledger.reserve(scenario.name, scenario_settings.ai_max_cost_usd_per_investigation, run_name)
            # A fresh provider per scenario, so usage and limits are per investigation.
            provider = build_provider(resolution, scenario_settings)
        # If this raises, the reservation stays open and charged in full: nothing is assumed.
        result = await evaluate(scenario, provider, scenario_settings, save_to)
        results.append(result)
        spent += result.cost_usd
        overrun = False
        if entry is not None:
            assert ledger is not None
            ledger.settle(entry, result.cost_usd, passed=result.passed, unknown_usd=result.unknown_cost_usd, calls=result.llm_calls)
            overrun = bool(entry.get("overrun"))
        log(
            f"  {scenario.name}: {'pass' if result.passed else 'FAIL'} · {result.mode} · {result.served_model or result.model or 'rule-based'} · {result.llm_calls} requests"
            + (f" ({result.unknown_calls} of unknown outcome, charged ${result.unknown_cost_usd:.4f})" if result.unknown_calls else "")
            + f" · in {result.input_tokens:,} / out {result.output_tokens:,} / cache read {result.cache_read_tokens:,} / cache write {result.cache_write_tokens:,} tokens · "
            f"model {result.seconds}s, total {result.wall_seconds}s · ${result.cost_usd:.4f} · cumulative ${(ledger.committed() if ledger else spent):.4f}"
        )
        if result.fell_back:
            log(f"  FELL BACK TO RULE-BASED in {scenario.name}: {result.model_stopped or 'the model could not be used'}. This scenario counts as failed.")
        if paid and result.fell_back and result.answered_calls == 0:
            # The model never answered: the key, the model or the account is not usable. Running
            # the other scenarios would only produce rule-based reports under a model's name.
            skipped.extend(s.name for s in scenarios[index + 1 :])
            log(f"  STOPPED: the model did not answer a single call in {scenario.name}. No further scenario was started.")
            break
        if result.bound_exceeded or overrun:
            # The ceiling is only as good as the bounds behind it. When one fails, nothing more runs.
            skipped.extend(s.name for s in scenarios[index + 1 :])
            log(f"  STOPPED: the spending accounting failed in {scenario.name}: {result.bound_exceeded or 'it cost more than its reservation'}. No further scenario was started.")
            break
    return results, skipped


def rescore(directory: Path) -> list[tuple[str, dict[str, Score], dict[str, Score]]]:
    """Scores the reports saved by an earlier run again, without calling any model.

    Returns, per scenario: the scores of the report as it was shown at the time, and the scores of
    what today's guardrails make of the same model output. This is how a change to the scorer or
    to the guardrails is checked against real model output that has already been paid for.
    """
    from ..evidence import EvidenceStore
    from ..schemas import EvidenceItem

    by_name = {s.name: s for s in SCENARIOS}
    out = []
    for path in sorted(directory.glob("*.json")):
        if path.name == "summary.json":
            continue
        record = json.loads(path.read_text())
        scenario = by_name.get(record["scenario"]["name"])
        if scenario is None:
            continue
        store = EvidenceStore()
        store.items = [EvidenceItem.model_validate(e) for e in record["evidence"]]
        # What was examined matters to the health verdict, so it is restored along with the evidence.
        for call in record["toolCalls"]:
            if call.get("ok"):
                store.coverage.setdefault(str(call["tool"]), {"calls": 0, "records": 0})["calls"] += 1
        store.metric_services = set(record.get("metricServices") or [e.service for e in store.items if e.kind in ("metric", "metric_baseline") and e.service])
        store.health_gaps = list(record.get("healthGaps") or [])
        steps = [e["step"] for e in record["events"] if e.get("type") == "step" and e["step"].get("type") == "tool_call"]
        seen = json.dumps([scenario.question, t(0), t(120), [st.get("output") for st in steps]], default=str)
        shown = InvestigationReport.model_validate(record["report"])
        raw = InvestigationReport.model_validate(record["reportBeforeGuardrails"])
        as_shown = score(scenario, shown, raw, store, record["guardrailNotes"], record["toolCalls"], seen)
        again = raw.model_copy(deep=True)
        notes = guardrails.enforce(again, store, scope=record.get("scope") or [], tool_failures=record.get("toolFailures") or [], known_times=record.get("knownTimes") or [t(0), t(120)])
        out.append((scenario.name, as_shown, score(scenario, again, raw, store, notes, record["toolCalls"], seen)))
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--heuristic", action="store_true", help="Ignore configured models and evaluate the rule-based engine (free)")
    parser.add_argument("--max-cost", type=float, default=None, help="Hard ceiling in USD on estimated model spend for the whole run")
    parser.add_argument("--no-save", action="store_true", help="Do not write the per-scenario reports to eval-runs/")
    parser.add_argument("--only", action="append", default=None, metavar="SCENARIO", help="Run only this scenario (repeatable)")
    parser.add_argument("--estimate", action="store_true", help="Print the worst-case cost of the run and exit without calling a model")
    parser.add_argument("--rescore", type=Path, default=None, metavar="DIR", help="Score the reports saved in DIR again with the current scorer and guardrails. Calls no model")
    parser.add_argument("--ledger", type=Path, default=None, metavar="FILE", help="Spending ledger shared by every invocation of one approved budget. Required for a paid run")
    parser.add_argument("--model", default=None, metavar="ID", help="For a paid run: the exact model that was approved. The run is refused unless ANTHROPIC_MODEL is exactly this")
    parser.add_argument("--key-env", default=None, metavar="NAME", help="For a paid run: the one environment variable the API key is read from. ANTHROPIC_API_KEY is then ignored")
    parser.add_argument("--repeat", action="store_true", help="Run the --only scenarios a second time; each must have failed once in the ledger and not been repeated")
    args = parser.parse_args()
    if args.rescore:
        rows = rescore(args.rescore)
        for name, shown, again in rows:
            for label, scores in (("as shown at the time", shown), ("with current guardrails", again)):
                failed = [f"{k}: {v.why}" for k, v in scores.items() if not v.ok]
                print(f"{name:34} {label:24} {'pass' if not failed else 'FAIL'}")
                for f in failed:
                    print(f"{'':34} FAIL {f}")
        print(f"\n{sum(all(v.ok for v in a.values()) for _n, a, _b in rows)}/{len(rows)} pass as shown · {sum(all(v.ok for v in b.values()) for _n, _a, b in rows)}/{len(rows)} pass with current guardrails")
        sys.exit(0)
    # Never the repository's .env: a paid run uses only what is set in this process's environment.
    settings = Settings(_env_file=None)
    if args.key_env:
        # The key comes from this variable and nowhere else; its value is never printed.
        settings = settings.model_copy(update={"anthropic_api_key": os.environ.get(args.key_env, "")})
    if not args.heuristic and not args.estimate and settings.provider_choice == "anthropic" and not settings.anthropic_api_key:
        print(f"Refusing to run: AI_PROVIDER=anthropic but no key is set{f' in {args.key_env}' if args.key_env else ''}. Nothing was run.", file=sys.stderr)
        sys.exit(2)
    resolution = None if args.heuristic else asyncio.run(resolve(settings))
    paid = resolution is not None and resolution.available and resolution.provider not in ("mock",)
    names = [s.name for s in SCENARIOS if not args.only or s.name in args.only]
    if args.estimate:
        if settings.provider_choice != "anthropic":
            print("AI_PROVIDER is not set to anthropic in this environment: a run would not call a paid model and costs nothing.")
            sys.exit(0)
        model = settings.anthropic_model
        reserve = worst_case_call_usd(model, settings)
        per = max_calls_per_scenario(settings)
        print("Configuration (from the process environment; .env is not read):")
        print(f"  provider anthropic · model {model} · effort {settings.anthropic_effort} · output limit {settings.ai_max_tokens:,} tokens per call · SDK retries 0 (forced)")
        print(f"  prompt limit {EVAL_MAX_PROMPT_TOKENS:,} tokens per call, below the {HAIKU_LONG_PROMPT_THRESHOLD:,}-token threshold of the higher prices")
        print(f"  key: {args.key_env or 'ANTHROPIC_API_KEY'} is {'set' if settings.anthropic_api_key else 'NOT set'} in this environment (its value is not shown)")
        print(f"{len(names)} scenario(s); at most {per} model calls each, {per * len(names)} in all, before the budget is considered.")
        print(f"Worst case for one call: ${reserve:.5f} ({EVAL_MAX_PROMPT_TOKENS:,} prompt tokens all written to the cache, {settings.ai_max_tokens:,} output tokens).")
        if args.ledger and args.ledger.exists():
            data = json.loads(args.ledger.read_text())
            existing = Ledger(args.ledger, float(data["maxCostUsd"]), str(data["model"]), list(data.get("entries") or []), int(data.get("maxRepeats", 1)))
            print(f"Ledger {args.ledger}: ceiling ${existing.max_cost_usd:.2f}, committed ${existing.committed():.6f}, left ${existing.remaining():.6f}, repeats used {existing.repeats_used()} of {existing.max_repeats}.")
        elif args.ledger:
            print(f"Ledger {args.ledger} does not exist yet; the first paid run creates it with the --max-cost given and 1 repeat in all.")
        print("No model was called.")
        sys.exit(0)
    ledger: Ledger | None = None
    if paid:
        assert resolution is not None
        problems = []
        if settings.provider_choice != "anthropic":
            problems.append("AI_PROVIDER=anthropic must be set explicitly for a paid run")
        if resolution.model not in PRICING:
            problems.append(f"no price is known for {resolution.model}")
        if settings.ai_price_input_per_mtok is not None or settings.ai_price_output_per_mtok is not None:
            problems.append("price overrides (AI_PRICE_*) are not accepted for a paid run")
        if args.model is None or args.model != resolution.model:
            problems.append(f"--model must name the approved model exactly (configured: {resolution.model})")
        if args.max_cost is None:
            problems.append("--max-cost <USD> is required")
        if args.ledger is None:
            problems.append("--ledger FILE is required, so that every invocation spends from one budget")
        if not args.key_env:
            problems.append("--key-env NAME is required, naming the one variable that holds the key for this budget")
        if args.repeat and not args.only:
            problems.append("--repeat needs --only <scenario>")
        if problems:
            print("Refusing to run a paid evaluation: " + "; ".join(problems) + ".", file=sys.stderr)
            sys.exit(2)
        try:
            ledger = Ledger.open(args.ledger, float(args.max_cost), str(resolution.model))
            ledger.check_allowed(names, args.repeat)
        except LedgerError as exc:
            print(f"Refusing to run: {exc}", file=sys.stderr)
            sys.exit(2)
        if ledger.void_entries():
            print(f"{len(ledger.void_entries())} earlier attempt(s) in {args.ledger} made no model call and cost nothing; they stay in the ledger and do not count as attempts.")
        # Before anything is reserved: ask the Models API (free, no inference) whether this key
        # can use this model. A key that is rejected here would only produce rule-based reports.
        probe = build_provider(resolution, live_settings(settings, str(resolution.model), settings.ai_max_cost_usd_per_investigation))
        ok, detail = asyncio.run(probe.verify()) if probe else (False, "no provider could be built")
        if not ok:
            why = f"the key in {args.key_env} was rejected (401): it is revoked, mistyped, or not an API key" if "(401)" in detail else detail
            print(f"Refusing to run: Anthropic could not be used: {why}. Nothing was reserved or spent.", file=sys.stderr)
            sys.exit(2)
    log = (lambda *_a, **_k: None) if args.json else print
    if paid:
        assert ledger is not None
        log(f"Evaluating {resolution.provider} / {resolution.model} (effort {settings.anthropic_effort}). Ceiling ${ledger.max_cost_usd:.2f} in {args.ledger}; "  # type: ignore[union-attr]
            f"${ledger.committed():.4f} already committed, ${ledger.remaining():.4f} left. These are real API calls.")
    engine = f"{resolution.provider}-{resolution.model}" if paid or (resolution and resolution.available) else "rule-based"  # type: ignore[union-attr]
    save_to = None if args.no_save else RUNS_DIR / f"{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}-{engine}"
    results, skipped = asyncio.run(run_all(resolution, settings, ledger.max_cost_usd if ledger else args.max_cost, log, save_to, args.only, ledger))
    total = sum(r.cost_usd for r in results)
    by_criterion = {c: {v: sum(1 for r in results if r.scores[c].verdict == v) for v in ("pass", "fail", "n/a")} for c in CRITERIA}
    summary = {
        "engine": engine, "scenarioClock": NOW.isoformat(), "results": [r.wire() for r in results], "byCriterion": by_criterion, "skipped": skipped,
        "usage": {k: sum(getattr(r, k) for r in results) for k in ("llm_calls", "unknown_calls", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")},
        "totalCostUsd": round(total, 6),
        "unknownCostUsd": round(sum(r.unknown_cost_usd for r in results), 6),
        "ledger": {"file": str(args.ledger), "ceilingUsd": ledger.max_cost_usd, "committedUsd": round(ledger.committed(), 6)} if ledger else None,
        "settings": {"provider": settings.provider_choice, "model": settings.anthropic_model, "effort": settings.anthropic_effort, "maxTokens": settings.ai_max_tokens, "retries": 0 if paid else settings.ai_max_retries, "maxPromptTokens": EVAL_MAX_PROMPT_TOKENS if paid else None},
    }
    if save_to is not None and results:
        (save_to / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        log(f"\nFull reports saved to {save_to}")
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        short = {"outcome": "state", "root_cause": "cause", "service": "svc", "citations": "cite", "no_invention": "real", "contradictions": "contra", "missing": "gaps", "calibration": "calib", "diagnostics": "diag", "remediation": "safe", "deployment": "deploy"}
        mark = {"pass": "pass", "fail": "FAIL", "n/a": "-"}
        print(f"\nEngine: {engine}\n")
        print(f"{'scenario':34} " + " ".join(f"{short[c]:6}" for c in CRITERIA) + " conf  tools  top hypothesis")
        for r in results:
            print(f"{r.scenario:34} " + " ".join(f"{mark[r.scores[c].verdict]:6}" for c in CRITERIA) + f" {r.confidence:<5.2f} {r.tool_calls:<5}  {r.top_hypothesis[:60]}")
            for failure in r.failures:
                print(f"{'':34} FAIL {failure}")
        print()
        for c in CRITERIA:
            n = by_criterion[c]
            print(f"  {c:15} {n['pass']}/{n['pass'] + n['fail']} passed" + (f" ({n['n/a']} not applicable)" if n["n/a"] else ""))
        passed = sum(r.passed for r in results)
        print(f"\n{passed}/{len(results)} scenarios passed" + (f" · {len(skipped)} not run for budget" if skipped else "") + (f" · estimated spend ${total:.4f}" if total else ""))
    sys.exit(0 if results and all(r.passed for r in results) and not skipped else 1)


if __name__ == "__main__":
    main()
