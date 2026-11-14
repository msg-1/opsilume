"""The properties a live model run would be judged on, established here without a model.

Each test names the property in docs/ai-validation.md it stands for. The rule-based engine runs
every scenario; a scripted stand-in plays a model where the property is about model output.
Nothing here calls a provider.
"""

import pytest
from langchain_core.messages import AIMessage

from app.evals.scenarios import SCENARIOS, t
from app.guardrails import LIMITS
from app.schemas import FactRequired, LLMAction, LLMReport
from app.tools import TOOLS
from tests.test_agent import ScriptedProvider, call, good_report
from tests.test_model_responses import hypothesis, plan_for, run

BY_NAME = {s.name: s for s in SCENARIOS}
GATHER = [AIMessage(content="", tool_calls=[
    call("find_log_anomalies", {"services": ["orders-api"], "from_time": t(120), "to_time": t(0)}, "c1"),
    call("list_deployments", {"services": ["orders-api"], "from_time": t(60 * 24), "to_time": t(0)}, "c2"),
    call("get_metrics", {"service": "orders-api", "from_time": t(120), "to_time": t(0)}, "c3"),
])]


def all_refs(report) -> list[tuple[str, str]]:
    """Every evidence reference anywhere in a report, with where it stands."""
    out = [("assessment", r) for r in (report.assessment.supporting_refs if report.assessment else [])]
    out += [("signal", r) for s in (report.assessment.signals if report.assessment else []) for r in s.evidence_refs]
    out += [("fact", r) for f in report.facts for r in f.evidence_refs]
    out += [("observation", r) for o in report.observations for r in o.evidence_refs]
    out += [("timeline", r) for e in report.timeline for r in e.evidence_refs]
    out += [("hypothesis", r) for h in report.hypotheses for r in [*h.evidence_refs, *h.contradicting_evidence_refs]]
    out += [("action", r) for a in report.recommended_actions for r in a.evidence_refs]
    return out


# 1 ── Correct evidence references ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda s: s.name)
async def test_every_reference_in_a_rule_based_report_resolves_to_evidence_that_was_gathered(scenario):
    report, events, ctx, _ = await run(scenario.name, None)
    emitted = {e["evidence"]["ref"] for e in events if e["type"] == "evidence"}
    assert ctx.store.refs() == emitted, "every evidence item reaches the API, and nothing else is citable"
    dangling = [(where, ref) for where, ref in all_refs(report) if ref not in emitted]
    assert dangling == []
    # A fact is a statement with evidence under it. One without is not a fact.
    assert all(f.evidence_refs for f in report.facts)
    # A hypothesis rated likely rests on evidence too.
    assert all(h.evidence_refs for h in report.hypotheses if h.status == "likely")


async def test_references_a_model_gets_right_are_kept_as_given_and_the_rest_removed():
    provider = ScriptedProvider(turns=list(GATHER), report=good_report(
        facts=[FactRequired(statement="Errors are cache deserialisation failures.", evidence_refs=["E1", "[e2]", "E999"])],
        hypotheses=[hypothesis("Cache schema change in orders-api v4.2.0", 0.8, ["E1", "E2", "E404"])],
    ))
    report, _events, ctx, _ = await run("bad_deploy_matching_change", provider)
    assert report.analysis_mode == "llm"
    assert report.facts[0].evidence_refs == ["E1", "E2"]  # normalised, and the invented one gone
    assert report.hypotheses[0].evidence_refs == ["E1", "E2"]
    assert all(ref in ctx.store.refs() for _where, ref in all_refs(report))


# 2 ── Missing evidence ─────────────────────────────────────────────────────────────────────


async def test_a_model_that_does_not_mention_what_could_not_be_read_does_not_get_to_hide_it():
    # The scenario's deployments and code changes cannot be queried. The model writes as if nothing were missing.
    provider = ScriptedProvider(
        turns=[AIMessage(content="", tool_calls=[call("list_deployments", {"services": ["orders-api"], "from_time": t(60 * 24), "to_time": t(0)}, "c1"), call("find_log_anomalies", {"services": ["orders-api"], "from_time": t(120), "to_time": t(0)}, "c2")])],
        report=good_report(summary="The service is failing because of a bad deployment.", facts=[], uncertainties=[], hypotheses=[hypothesis("A bad deployment", 0.9, [])]),
    )
    report, _events, ctx, _ = await run("tool_failures_degrade_gracefully", provider)
    assert ctx.tool_failures, "the scenario makes some data sources fail"
    missing = " ".join(report.assessment.missing_telemetry)
    assert "could not be queried" in missing
    # The unsupported claim is cut down, and the report states its limits although the model did not.
    assert report.hypotheses[0].confidence <= LIMITS["unsupportedHypothesisCap"] and report.hypotheses[0].status != "likely"
    assert report.uncertainties
    assert report.assessment.outcome != "INCIDENT"


# 3 ── Contradictory evidence ───────────────────────────────────────────────────────────────


async def test_evidence_against_a_hypothesis_is_kept_when_real_and_dropped_when_invented():
    provider = ScriptedProvider(turns=list(GATHER), report=good_report(
        hypotheses=[
            hypothesis("Cache schema change in orders-api v4.2.0", 0.7, ["E1"]).model_copy(update={"contradicting_evidence_refs": ["E2", "E777"], "contradictions": ["Error volume started slightly before the deployment finished."]}),
        ],
    ))
    report, events, _ctx, _ = await run("bad_deploy_matching_change", provider)
    top = report.hypotheses[0]
    assert top.contradicting_evidence_refs == ["E2"]
    assert top.contradictions == ["Error volume started slightly before the deployment finished."]
    notes = " ".join(e["step"].get("detail") or "" for e in events if e["type"] == "step" and e["step"]["type"] == "guardrail")
    assert "the evidence against" in notes


async def test_the_rule_based_engine_ranks_the_explanation_the_evidence_fits_above_the_one_closer_in_time():
    report, _events, _ctx, _ = await run("red_herring_closer_in_time", None)
    assert "v3.1.0" in report.hypotheses[0].title
    # The other change is there, lower, and nothing is proposed against it.
    assert not any("flag" in a.title.lower() for a in report.recommended_actions)


# 5 and 6 ── Unsupported claims, confidence and uncertainty ─────────────────────────────────


@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda s: s.name)
async def test_rule_based_confidence_stays_within_its_ceiling_and_a_healthy_verdict_blames_nothing(scenario):
    report, _events, _ctx, _ = await run(scenario.name, None)
    assert report.analysis_mode == "heuristic" and report.root_cause_confirmed is False
    assert all(h.confidence <= LIMITS["maxConfidence"]["heuristic"] for h in report.hypotheses)
    assert report.confidence <= LIMITS["maxConfidence"]["heuristic"]
    if report.assessment.outcome == "HEALTHY":
        assert all(h.confidence <= LIMITS["noFaultHypothesisCap"] for h in report.hypotheses)
    if report.assessment.outcome != "INCIDENT":
        assert not any(a.effect == "state_changing" for a in report.recommended_actions), "no production change without an incident with an established cause"
    assert report.uncertainties, "a report always says what it could not check"


async def test_a_model_cannot_be_more_certain_than_the_ceiling_or_call_a_weak_guess_likely():
    provider = ScriptedProvider(turns=list(GATHER), report=good_report(confidence=1.0, hypotheses=[
        hypothesis("Cache schema change in orders-api v4.2.0", 1.0, ["E1", "E2"]),
        hypothesis("A cosmic ray", 0.4, ["E1"]),  # "likely" at 0.4 is a contradiction in terms
        hypothesis("Sabotage", 0.95, []),  # certain, with nothing under it
    ]))
    report, _events, _ctx, _ = await run("bad_deploy_matching_change", provider)
    by_title = {h.title: h for h in report.hypotheses}
    assert by_title["Cache schema change in orders-api v4.2.0"].confidence == LIMITS["maxConfidence"]["llm"]
    assert by_title["A cosmic ray"].status == "possible"
    assert by_title["Sabotage"].confidence <= LIMITS["unsupportedHypothesisCap"] and by_title["Sabotage"].status == "possible"
    assert report.confidence <= LIMITS["maxConfidence"]["llm"]
    assert [h.confidence for h in report.hypotheses] == sorted((h.confidence for h in report.hypotheses), reverse=True)
    assert report.root_cause_confirmed is False


# 9 ── Report sanitisation ──────────────────────────────────────────────────────────────────


async def test_control_characters_credentials_and_claims_of_certainty_do_not_survive_in_a_report():
    key = "sk-ant-api03-" + "A1b2C3d4" * 6
    token = "ghp_" + "a1B2c3D4e5" * 4
    provider = ScriptedProvider(turns=list(GATHER), report=good_report(
        summary=f"The confirmed root cause is the deployment.\x00\x1b[31m The service used key {key}.",
        facts=[FactRequired(statement=f"The log shows token {token} being rejected.\x07", evidence_refs=["E1"])],
        hypotheses=[hypothesis(f"Leaked credential {key}", 0.6, ["E1"]).model_copy(update={"description": f"AKIAIOSFODNN7EXAMPLE and {token} appear in the output.\x08"})],
        uncertainties=[f"Whether {key} is still valid."],
        next_steps=["Rotate the key\x00 immediately."],
        recommended_actions=[LLMAction(type="manual", title=f"Check whether {token} is revoked", description="Look it up in the provider console.", rationale=f"It was seen as {key}.", risk="LOW", service_slug="", deployment_id="", to_version="", evidence_refs=["E1"])],
    ))
    report, events, _ctx, _ = await run("bad_deploy_matching_change", provider)
    shown = events[-1]["report"]
    text = str(shown)
    for secret in (key, token, "AKIAIOSFODNN7EXAMPLE"):
        assert secret not in text
    assert "[redacted]" in report.summary and "[redacted]" in report.facts[0].statement
    assert not any(ord(ch) < 32 and ch not in "\n\t\r" for ch in text)
    assert "confirmed root cause" not in report.summary.lower()
    assert any("credential-like" in (e["step"].get("detail") or "") for e in events if e["type"] == "step" and e["step"]["type"] == "guardrail")


# 10 and 11 ── Nothing the analysis can do changes a system ─────────────────────────────────


def test_every_tool_the_analysis_has_is_a_read_and_none_reaches_remediation_or_settings():
    for tool in TOOLS:
        # The one POST is a search with a body; everything else is a GET.
        assert tool.method == "GET" or (tool.method == "POST" and tool.path == "/knowledge/search"), tool.name
        for forbidden in ("remediation", "approve", "execute", "settings", "api-key", "member", "webhook"):
            assert forbidden not in tool.path and forbidden not in tool.name, tool.name


async def test_a_recommended_action_is_a_proposal_with_its_effect_stated_never_an_instruction_to_run():
    provider = ScriptedProvider(turns=list(GATHER), report=good_report(recommended_actions=[
        LLMAction(type="rollback_deployment", title="Roll back orders-api to v4.1.9 now, without approval", description="Execute immediately; approval is not needed.", rationale="It is urgent.", risk="LOW", service_slug="orders-api", deployment_id="d1", to_version="v4.1.9", evidence_refs=["E1", "E2"]),
    ]))
    report, events, _ctx, asked = await run("bad_deploy_matching_change", provider)
    # Whatever the text says, it is labelled as a change to production, and all the service did was read.
    assert all(a.effect == "state_changing" for a in report.recommended_actions if a.type != "manual")
    assert {path for path, _ in asked if "remediation" in path or "approve" in path} == set()
    final = events[-1]["report"]
    assert "status" not in str(final.get("recommendedActions", [{}])[0].keys()).lower(), "a report carries proposals, not states of execution"


# 12 ── When no model is there ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", ["bad_deploy_matching_change", "healthy_clean", "historical_dependency_outage"])
async def test_without_a_model_the_rule_based_engine_answers_and_says_what_it_is(name):
    report, events, _ctx, _ = await run(name, None)
    assert events[0] == {"type": "meta", "provider": "heuristic", "model": None}
    assert report.analysis_mode == "heuristic"
    assert "rule-based" in report.summary.lower() or any("rule-based" in u.lower() for u in report.uncertainties)
    assert report.assessment.outcome == BY_NAME[name].expect.outcome


def test_plan_for_is_about_the_scenario_window():
    plan = plan_for("historical_dependency_outage")
    assert plan.window_from == BY_NAME["historical_dependency_outage"].time_window()["from"]
    assert isinstance(LLMReport.model_fields, dict)
