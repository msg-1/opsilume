"""What happens when a model answers badly, with the model played by a script.

No model is called. These are the failure shapes a live provider can produce: reasoning from
the present about the past, citing nothing, claiming an outcome the evidence does not carry,
returning output that does not parse, or returning nothing at all. The report that reaches a
person must stay honest in each case. What only a live run can show is in docs/ai-validation.md.
"""

import json

import httpx
import pytest
from langchain_core.messages import AIMessage, ToolMessage

from app.config import Settings
from app.evals.scenarios import SCENARIOS, t
from app.graph import Context, run_investigation
from app.llm import LLMError
from app.schemas import FactRequired, InvestigationPlan, InvestigationRequest, LLMHypothesis, LLMReport, PlanStep
from app.tools import ToolClient
from tests.test_agent import ScriptedProvider, call, good_report

BY_NAME = {s.name: s for s in SCENARIOS}


async def run(name: str, provider):
    scenario = BY_NAME[name]
    events: list[dict] = []
    asked: list[tuple[str, dict]] = []
    inner = scenario.handler()

    def handle(request: httpx.Request) -> httpx.Response:
        asked.append((request.url.path.removeprefix("/api/v1/tools"), dict(request.url.params)))
        return inner(request)

    async def emit(e):
        events.append(e)

    tools = ToolClient("http://opsilume.test", "tok", transport=httpx.MockTransport(handle))
    request = InvestigationRequest(investigation_id="inv", question=scenario.question, organization_name="Org", api_url="http://opsilume.test", tool_token="tok", time_window=scenario.time_window(), current_time=t(0))
    ctx = Context(request=request, settings=Settings(_env_file=None), tools=tools, provider=provider, emit=emit)
    report = await run_investigation(ctx)
    await tools.aclose()
    return report, events, ctx, asked


def plan_for(name: str) -> InvestigationPlan:
    window = BY_NAME[name].time_window()
    return InvestigationPlan(objective="Find the cause", services=["web-app"], window_from=window["from"], window_to=window["to"], steps=[PlanStep(description="Check dependencies", tool="get_service")])


def hypothesis(title: str, confidence: float, refs: list[str], **extra) -> LLMHypothesis:
    return LLMHypothesis(title=title, description="d", confidence=confidence, status="likely", evidence_refs=refs, contradicting_evidence_refs=[], contradictions=[], assumptions=[], gaps=[], **extra)


async def test_a_model_that_asks_for_health_without_a_window_is_told_about_the_window_not_about_today():
    name = "historical_dependency_recovered"
    provider = ScriptedProvider(
        # The model asks the way a model would: a service name and nothing else.
        turns=[AIMessage(content="", tool_calls=[call("get_service", {"service": "web-app"}, "c1"), call("find_log_anomalies", {"services": ["web-app"], "from_time": BY_NAME[name].time_window()["from"], "to_time": BY_NAME[name].time_window()["to"]}, "c2")])],
        # …and then blames what is down today, citing nothing, with great confidence.
        report=good_report(
            summary="payments-api is down, which is the confirmed root cause of the web-app failures.", outcome="INCIDENT", confidence=0.95,
            facts=[FactRequired(statement="payments-api is DOWN.", evidence_refs=["E77"])],
            hypotheses=[hypothesis("Failure of upstream dependency payments-api", 0.95, [])],
        ),
        plan=plan_for(name),
    )
    report, events, ctx, asked = await run(name, provider)
    # The request that reached the API carried the investigation's window.
    service_calls = [params for path, params in asked if path == "/services/web-app"]
    assert service_calls and all(p.get("from") and p.get("to") for p in service_calls)
    # So what the model was shown is the record of that time: payments-api healthy, and labelled as the window's.
    shown = next(m.content for turn in provider.seen for m in turn if isinstance(m, ToolMessage) and m.tool_call_id == "c1")
    result = json.loads(shown)["result"]
    assert result["healthAsOf"]["mode"] == "window"
    assert {d["slug"]: d["health"] for d in result["dependsOn"]} == {"cache-redis": "HEALTHY", "payments-api": "HEALTHY"}
    assert "Critical alert firing" not in shown
    # The model's instructions say what health means in time.
    assert "Never use what a service's state is today as evidence for something that is over" in provider.seen[1][0].content

    # What the model then claimed has nothing under it, and the report says so instead of repeating it.
    assert report.analysis_mode == "llm"
    top = report.hypotheses[0]
    assert top.evidence_refs == [] and top.confidence <= 0.3 and top.status != "likely"
    assert report.facts == [] and "payments-api is DOWN." in report.assumptions
    assert "confirmed root cause" not in report.summary.lower()
    # The outcome is computed from the evidence, whatever the model wrote: a failure with no established cause.
    assert report.assessment.outcome == "DEGRADED" and report.outcome == "DEGRADED"
    assert ctx.store.by_kind("dependency") == []
    assert any(e["type"] == "step" and e["step"]["type"] == "guardrail" for e in events)


async def test_a_model_that_claims_health_over_a_failure_is_corrected_and_an_empty_report_is_completed():
    provider = ScriptedProvider(
        turns=[AIMessage(content="", tool_calls=[call("find_log_anomalies", {"services": ["orders-api"], "from_time": t(120), "to_time": t(0)}, "c1"), call("get_metrics", {"service": "orders-api", "from_time": t(120), "to_time": t(0)}, "c2")])],
        # Everything optional left out, and a verdict the evidence contradicts.
        report=LLMReport(summary="Everything looks fine.", outcome="HEALTHY", observations=[], confidence=0.0, timeline=[], facts=[], assumptions=[], uncertainties=[], next_steps=[], hypotheses=[], recommended_actions=[]),
    )
    report, events, _ctx, _ = await run("bad_deploy_matching_change", provider)
    assert report.analysis_mode == "llm"
    # Hundreds of new errors are in the evidence. The assessment follows the evidence.
    assert report.assessment.outcome in ("DEGRADED", "INCIDENT") and report.outcome == report.assessment.outcome
    assert report.assessment.supporting_refs, "the corrected outcome cites what it rests on"
    # The correction is on record, and the report is not left without a statement of its limits.
    guard = " ".join(e["step"].get("detail") or e["step"]["title"] for e in events if e["type"] == "step" and e["step"]["type"] == "guardrail")
    assert "HEALTHY" in guard or "healthy" in guard
    assert report.uncertainties
    assert report.recommended_actions == []
    refs = {e["evidence"]["ref"] for e in events if e["type"] == "evidence"}
    assert set(report.assessment.supporting_refs) <= refs


@pytest.mark.parametrize("failure", [
    LLMError("the provider returned output that does not match the report schema"),
    ValueError("Expecting ',' delimiter: line 14 column 3 (char 912)"),
    TimeoutError("the model did not answer"),
], ids=["schema mismatch", "output that is not JSON", "no answer"])
async def test_output_that_cannot_be_used_falls_back_to_the_rule_based_engine_and_says_so(failure):
    provider = ScriptedProvider(turns=[AIMessage(content="", tool_calls=[call("find_log_anomalies", {"from_time": t(120)}, "c1")])], report=failure)
    report, events, _ctx, _ = await run("bad_deploy_matching_change", provider)
    # A report still arrives, written by the rule-based engine and labelled as such.
    assert report.analysis_mode == "heuristic"
    assert events[-1]["type"] == "final" and events[-1]["report"]["analysisMode"] == "heuristic"
    assert any("language model" in u for u in report.uncertainties)
    # The failure in the logs is still found by the rule-based engine, with the outcome computed from the evidence.
    assert report.assessment.outcome in ("DEGRADED", "INCIDENT") and report.assessment.supporting_refs
    # Parser or model text is not passed on to the reader; the provider's own message is.
    shown = json.dumps(events)
    assert "delimiter" not in shown and "char 912" not in shown
    if isinstance(failure, LLMError):
        assert "does not match the report schema" in shown


async def test_a_model_that_says_nothing_and_calls_nothing_still_ends_in_an_honest_report():
    provider = ScriptedProvider(turns=[AIMessage(content="")], report=good_report(facts=[], hypotheses=[hypothesis("Something went wrong somewhere", 0.9, [])], summary="Something went wrong."))
    report, _events, ctx, _ = await run("historical_health_not_on_record", ScriptedProvider(turns=provider.turns, report=provider.report, plan=plan_for("historical_health_not_on_record")))
    # No tool was called by the model, so nothing it says is supported; what the orient step
    # gathered is all there is, and the report claims no more than that.
    assert all(h.evidence_refs == [] and h.confidence <= 0.3 for h in report.hypotheses)
    assert report.assessment.outcome in ("UNDETERMINED", "DEGRADED", "HEALTHY")
    assert report.root_cause_confirmed is False
    assert all(r in ctx.store.refs() for h in report.hypotheses for r in h.evidence_refs)
