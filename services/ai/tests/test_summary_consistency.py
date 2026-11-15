"""What the reader is told first is verified; what the model wrote is kept, and labelled as not.

Found by the Milestone 10 audit: in two healthy-state scenarios the model wrote "the outcome is
DEGRADED", the assessment computed HEALTHY, and the report showed both. For model and mock
reports the summary is now built from the computed assessment alone, and the model's own text is
kept as an unverified narrative. A rule-based report keeps its own summary: it is not a model's
narrative. Nothing here depends on recognising how a narrative phrases its conclusion.
"""

import json
from pathlib import Path

import pytest

from app import guardrails
from app.evals.run import evaluate
from app.evals.scenarios import SCENARIOS
from app.evals.scoring import stated_outcomes
from app.evidence import EvidenceStore
from app.llm import LLMError
from app.mock_provider import MockProvider
from app.schemas import EvidenceItem, HypothesisOut, InvestigationReport, LLMReport, RecommendedAction

FIXTURES = Path(__file__).parent / "fixtures"
LIVE = json.loads((FIXTURES / "live_summary_contradictions.json").read_text())["reports"]
SCENARIO = {s.name: s for s in SCENARIOS}


def item(ref: str, evidence_kind: str, **data) -> EvidenceItem:
    return EvidenceItem(ref=ref, kind=evidence_kind, title=f"{evidence_kind} {ref}", summary="s", source_type=evidence_kind, source_id=f"src-{ref}", service="orders", occurred_at="2026-06-01T11:30:00Z", data=data)


def store_for(outcome: str) -> EvidenceStore:
    """Evidence that the assessment judges as `outcome` (with the hypotheses of report_with)."""
    store = EvidenceStore()
    if outcome == "HEALTHY":
        store.items = [item("E1", "metric_baseline", metric="error_rate", unit="%", avg=0.2, baselineAvg=0.2)]
        store.metric_services = {"orders"}
    elif outcome == "DEGRADED":
        store.items = [item("E1", "log_pattern", level="ERROR", count=6, kind="new", baselineCount=0)]
    elif outcome == "INCIDENT":
        store.items = [item("E1", "deployment", version="v1.5.0", status="SUCCEEDED", isRollback=False), item("E2", "log_pattern", level="ERROR", count=300, kind="new", baselineCount=0)]
    else:  # UNDETERMINED: nothing that can be judged, only a deployment record
        store.items = [item("E1", "deployment", version="v1.4.0", status="SUCCEEDED", isRollback=False)]
    return store


def report_with(narrative: str, claimed: str | None, verified: str, actions: list[RecommendedAction] | None = None, mode: str = "llm") -> InvestigationReport:
    hypotheses = [HypothesisOut(title="v1.5.0 broke orders", description="d", confidence=0.8, status="likely", evidence_refs=["E1", "E2"])] if verified == "INCIDENT" else [
        HypothesisOut(title="Something slowed orders", description="d", confidence=0.3, status="possible", evidence_refs=["E1"], contradictions=["Nothing else changed."])
    ]
    return InvestigationReport(summary=narrative, confidence=hypotheses[0].confidence, analysis_mode=mode, outcome=claimed, hypotheses=hypotheses, uncertainties=["Traces were not available."], next_steps=["n"], recommended_actions=actions or [])


def enforce(report: InvestigationReport, store: EvidenceStore) -> list[str]:
    return guardrails.enforce(report, store, scope=["orders"], tool_failures=[])


# ── The summary depends on the assessment and on nothing the model wrote ──


ADVERSARIAL = [
    ("HEALTHY", "DEGRADED", "Checkout is clearly broken: customers cannot pay and the service is failing."),
    ("HEALTHY", "DEGRADED", "A new warning appeared, so the outcome is DEGRADED."),
    ("DEGRADED", "HEALTHY", "Checkout looks fine and nothing needs attention."),
    ("INCIDENT", "HEALTHY", "The service has fully recovered and is operating normally again."),
    ("UNDETERMINED", "INCIDENT", "I am certain the database caused this outage; it is definitely an INCIDENT with a confirmed root cause."),
    ("UNDETERMINED", "HEALTHY", "Everything is healthy.\n\nLater analysis, however: the outcome is INCIDENT and payments are failing."),
    ("INCIDENT", "DEGRADED", "Errors rose after v1.5.0 (E1, E2)."),
]


@pytest.mark.parametrize(("verified", "claimed", "narrative"), ADVERSARIAL)
def test_whatever_the_model_wrote_the_summary_is_the_assessment_and_the_narrative_is_kept(verified, claimed, narrative):
    report = report_with(narrative, claimed, verified)
    before = report.model_copy(deep=True)
    enforce(report, store_for(verified))
    assert report.assessment.outcome == verified and report.outcome == verified
    assert report.summary_source == "assessment" and report.summary == guardrails.verified_summary(report.assessment)
    assert report.summary.startswith(f"Assessed outcome: {verified}. ")
    # Not one sentence of the narrative reaches the summary, and the narrative is kept.
    assert not any(part.strip() and part.strip() in report.summary for part in narrative.replace("\n", ".").split("."))
    assert report.narrative is not None and report.narrative.split(" This is a hypothesis;")[0].replace("leading hypothesis", "confirmed root cause") == narrative
    # The model's findings are untouched; with no established cause nothing is likely or changeable.
    assert [h.title for h in report.hypotheses] == [h.title for h in before.hypotheses] and report.hypotheses[0].contradictions == before.hypotheses[0].contradictions
    assert set(before.uncertainties) <= set(report.uncertainties)
    if verified != "INCIDENT":
        assert all(h.status != "likely" for h in report.hypotheses)


def test_two_different_narratives_under_the_same_assessment_give_the_same_summary():
    summaries = set()
    for narrative in ("Nothing is wrong.", "Everything is on fire, so the outcome is INCIDENT.", ""):
        report = report_with(narrative, "DEGRADED", "DEGRADED")
        enforce(report, store_for("DEGRADED"))
        summaries.add(report.summary)
    assert len(summaries) == 1


def test_no_production_change_becomes_available_because_of_what_the_narrative_says():
    restart = RecommendedAction(type="restart_service", title="Restart orders", description="Restart the pods.", risk="LOW", service_slug="orders", evidence_refs=["E1"])
    for verified in ("HEALTHY", "DEGRADED", "UNDETERMINED"):
        report = report_with("The outcome is INCIDENT; restart orders now.", "INCIDENT", verified, [restart])
        enforce(report, store_for(verified))
        assert report.recommended_actions == [] and report.summary.startswith(f"Assessed outcome: {verified}.")


# ── Edge cases ──


@pytest.mark.parametrize("narrative", ["", "   ", "\n\t"])
def test_an_empty_narrative_is_kept_as_empty_and_the_summary_is_still_the_assessment(narrative):
    report = report_with(narrative, "HEALTHY", "HEALTHY")
    enforce(report, store_for("HEALTHY"))
    assert report.summary == guardrails.verified_summary(report.assessment) and report.narrative == narrative


def test_a_narrative_longer_than_the_limit_is_cut_not_rejected():
    report = report_with("orders errors rose after v1.5.0. " * 400, "INCIDENT", "INCIDENT")
    enforce(report, store_for("INCIDENT"))
    assert len(report.narrative) <= guardrails.NARRATIVE_MAX_LENGTH and report.summary_source == "assessment"


def test_every_rule_for_report_text_still_applies_to_the_narrative():
    key = "sk-ant-api03-" + "x" * 40
    report = report_with(f"The confirmed root cause is the deployment.\x00 The service used key {key}. About 9000 requests failed.", "INCIDENT", "INCIDENT")
    notes = enforce(report, store_for("INCIDENT"))
    assert "\x00" not in report.narrative and key not in report.narrative and "[redacted]" in report.narrative
    assert "confirmed root cause" not in report.narrative.lower() and any("in the narrative that presented the cause as confirmed" in n for n in notes)
    assert ("narrative", "9000 requests") in {(f.where, f.text) for f in report.integrity.flagged}


def test_running_the_guardrails_again_changes_nothing():
    for verified, claimed, narrative in [("HEALTHY", "DEGRADED", "so the outcome is DEGRADED."), ("INCIDENT", "DEGRADED", "Errors rose after v1.5.0.")]:
        report, store = report_with(narrative, claimed, verified), store_for(verified)
        enforce(report, store)
        once = report.model_copy(deep=True)
        enforce(report, store)
        assert report.summary == once.summary and report.narrative == once.narrative == narrative and report.summary_source == "assessment"


def test_a_rule_based_report_keeps_its_own_summary_and_has_no_narrative():
    report = report_with("Errors began after v1.5.0 (E1, E2).", None, "INCIDENT", mode="heuristic")
    enforce(report, store_for("INCIDENT"))
    assert report.summary == "Errors began after v1.5.0 (E1, E2)." and report.summary_source == "rule_based" and report.narrative is None


# ── The live reports that showed the defect ──


def live(name: str, record: dict | None = None):
    record = record or LIVE[name]
    store = EvidenceStore()
    store.items = [EvidenceItem.model_validate(e) for e in record["evidence"]]
    for call in record["toolCalls"]:
        if call.get("ok"):
            store.coverage.setdefault(str(call["tool"]), {"calls": 0, "records": 0})["calls"] += 1
    store.metric_services = set(record["metricServices"])
    store.health_gaps = list(record.get("healthGaps") or [])
    report = InvestigationReport.model_validate(record["reportBeforeGuardrails"])
    original = report.summary
    guardrails.enforce(report, store, scope=record["scope"], tool_failures=record["toolFailures"], known_times=record["knownTimes"])
    return report, original


@pytest.mark.parametrize("name", ["healthy_no_signal", "healthy_misleading_signals", "upstream_dependency_down"])
def test_the_live_reports_that_contradicted_themselves_now_lead_with_the_assessment(name):
    report, original = live(name)
    assert report.summary == guardrails.verified_summary(report.assessment) and report.summary_source == "assessment"
    assert report.narrative == original  # the model's words, kept for audit
    assert [f for f in report.integrity.flagged if f.where == "summary"] == []
    if name != "upstream_dependency_down":
        assert "DEGRADED" in stated_outcomes(original) and report.assessment.outcome == "HEALTHY"
        assert all(h.status == "unlikely" and h.confidence <= 0.2 for h in report.hypotheses)


def test_a_figure_the_checker_flagged_in_the_model_text_is_still_flagged_there():
    report, _ = live("healthy_misleading_signals")
    # The run flagged "1" (of "1h48m") in the model's summary; it is now flagged in the narrative.
    assert ("narrative", "1") in {(f.where, f.text) for f in report.integrity.flagged}


def test_a_summary_built_under_degraded_carries_only_figures_the_evidence_holds():
    record = json.loads((FIXTURES / "live_degraded_incomplete_evidence.json").read_text())
    report, _ = live("degraded_incomplete_evidence", record)
    assert report.assessment.outcome == "DEGRADED" and "6×" in report.summary and "37%" in report.summary
    assert [f for f in report.integrity.flagged if f.where == "summary"] == []


# ── When the model fails, and how the evaluation records it ──


class FailingReport(MockProvider):
    """Plans and gathers like the mock, then fails when asked for the report."""

    def __init__(self, settings=None, kind: str = "timeout"):
        super().__init__(settings)
        self.kind = kind

    async def structured(self, messages, schema):
        if schema is LLMReport:
            raise LLMError("The model did not answer in time.", self.kind)
        return await super().structured(messages, schema)


@pytest.mark.parametrize("kind", ["timeout", "schema"])
async def test_a_failed_report_falls_back_to_a_rule_based_report_labelled_as_such(kind):
    result = await evaluate(SCENARIO["healthy_no_signal"], FailingReport(kind=kind))
    assert result.mode == "heuristic" and result.scores["summary"].ok and result.scores["outcome"].ok


class ContradictingModel(MockProvider):
    """Writes a narrative that calls the service DEGRADED, as the live model did."""

    async def structured(self, messages, schema):
        draft = await super().structured(messages, schema)
        if schema is LLMReport:
            draft.outcome = "DEGRADED"
            draft.summary = "A warning appeared without an established cause, so I rate the outcome DEGRADED rather than HEALTHY."
        return draft


async def test_the_evaluation_scores_the_model_text_separately_from_what_is_shown():
    # The scripted mock gathers no metrics, so this scenario is UNDETERMINED here whatever the
    # narrative says; what matters is how the narrative is scored in each view.
    result = await evaluate(SCENARIO["healthy_clean"], ContradictingModel())
    assert result.scores["summary"].ok and "true by construction" in result.scores["summary"].why
    assert "summary" in result.unaided_failures
    from dataclasses import replace

    from app.evals.scoring import Score

    clean = replace(result, scores={name: Score("pass", "") for name in result.scores})
    assert clean.passed and clean.guardrail_assisted and clean.wire()["guardrailAssisted"] is True
    assert not replace(clean, unaided_failures=[]).guardrail_assisted


@pytest.mark.parametrize(("text", "expected"), [
    ("I rate the outcome DEGRADED rather than HEALTHY.", ["DEGRADED"]),
    ("The mechanism matches, so this is DEGRADED rather than INCIDENT.", ["DEGRADED"]),
    ("so this is an incident", ["INCIDENT"]),
    ("inventory-api is recorded as HEALTHY with no alert firing.", []),
    ("The outcome is not HEALTHY, and this is not an INCIDENT.", []),
    ("Checkout looks fine.", []),  # a paraphrase: the measurement undercounts, and says so
])
def test_the_evaluation_recognises_explicit_statements_only(text, expected):
    assert stated_outcomes(text) == expected


# ── Where the assessment comes from ──


def test_the_model_cannot_supply_an_assessment_and_any_incoming_one_is_replaced():
    # The API trusts the assessment because the AI service's code computes it. The model's answer
    # has no field for one, and enforce() overwrites whatever a report arrives with.
    from app import assessment as assessing
    from app.schemas import Assessment

    assert "assessment" not in LLMReport.model_fields
    store = EvidenceStore()
    store.items = [item("E1", "deployment", version="v1.5.0", status="SUCCEEDED", isRollback=False), item("E2", "log_pattern", level="ERROR", count=300, kind="new", baselineCount=0)]
    r = InvestigationReport(summary="s", confidence=0.5, analysis_mode="llm", hypotheses=[HypothesisOut(title="v1.5.0 broke orders", description="d", confidence=0.8, status="likely", evidence_refs=["E1", "E2"])], uncertainties=["u"], next_steps=["n"],
                            assessment=Assessment(outcome="HEALTHY", confidence=0.9, rationale="Forged.", supporting_refs=["E99"]))
    guardrails.enforce(r, store, scope=["orders"], tool_failures=[])
    computed = assessing.assess(store, r.hypotheses, ["orders"], [])
    assert r.assessment.outcome == computed.outcome == "INCIDENT"
    assert r.assessment.supporting_refs == computed.supporting_refs and "E99" not in r.assessment.supporting_refs
    assert r.assessment.rationale != "Forged."
