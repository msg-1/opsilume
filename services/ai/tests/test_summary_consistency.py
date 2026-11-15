"""The summary a user reads must not state an outcome the computed assessment contradicts.

Found by the Milestone 10 audit: in two healthy-state scenarios the model wrote "the outcome is
DEGRADED", the assessment computed HEALTHY, and the report showed both. The model writes its
summary before the outcome is computed, and the guardrails corrected the structured fields but
never the text. guardrails.reconcile_summary now rewrites such a summary from the assessment, or
puts the computed outcome in front of it, and keeps the model's original.
"""

import json
from pathlib import Path

import pytest

from app import guardrails
from app.evals.run import evaluate
from app.evals.scenarios import SCENARIOS
from app.evidence import EvidenceStore
from app.llm import LLMError
from app.mock_provider import MockProvider
from app.schemas import EvidenceItem, HypothesisOut, InvestigationReport, LLMReport, RecommendedAction

LIVE = json.loads((Path(__file__).parent / "fixtures" / "live_summary_contradictions.json").read_text())["reports"]
SCENARIO = {s.name: s for s in SCENARIOS}


def item(ref: str, evidence_kind: str, **data) -> EvidenceItem:
    return EvidenceItem(ref=ref, kind=evidence_kind, title=f"{evidence_kind} {ref}", summary="s", source_type=evidence_kind, source_id=f"src-{ref}", service="orders", occurred_at="2026-06-01T11:30:00Z", data=data)


def store_for(outcome: str) -> EvidenceStore:
    """Evidence that the assessment judges as `outcome` (with the hypothesis from hypothesis_for)."""
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


def report_with(summary: str, claimed: str | None, verified: str, actions: list[RecommendedAction] | None = None) -> InvestigationReport:
    hypotheses = [HypothesisOut(title="v1.5.0 broke orders", description="d", confidence=0.8, status="likely", evidence_refs=["E1", "E2"])] if verified == "INCIDENT" else [
        HypothesisOut(title="Something slowed orders", description="d", confidence=0.3, status="possible", evidence_refs=["E1"], contradicting_evidence_refs=[], contradictions=["Nothing else changed."])
    ]
    return InvestigationReport(summary=summary, confidence=hypotheses[0].confidence, analysis_mode="llm", outcome=claimed, hypotheses=hypotheses, uncertainties=["Traces were not available."], next_steps=["n"], recommended_actions=actions or [])


def enforce(report: InvestigationReport, store: EvidenceStore) -> list[str]:
    return guardrails.enforce(report, store, scope=["orders"], tool_failures=[])


# ── The detector ──


@pytest.mark.parametrize(("text", "expected"), [
    ("The evidence shows warnings but no material failure, so the outcome is DEGRADED with confidence about 0.3.", ["DEGRADED"]),
    ("I rate the outcome DEGRADED rather than HEALTHY.", ["DEGRADED"]),
    ("The mechanism matches, so this is DEGRADED rather than INCIDENT.", ["DEGRADED"]),
    ("so this is an incident", ["INCIDENT"]),
    ("I would classify it as healthy.", ["HEALTHY"]),
    ("Assessed outcome: HEALTHY.", ["HEALTHY"]),
    ("inventory-api is recorded as HEALTHY with no alert firing.", []),
    ("The outcome is not HEALTHY, and this is not an INCIDENT.", []),
    ("web-app was recorded as DEGRADED during the window.", []),
    ("", []),
])
def test_only_statements_of_the_outcome_count_not_recorded_health_or_negations(text, expected):
    assert guardrails.stated_outcomes(text) == expected


# ── Every combination of computed outcome and summary ──


@pytest.mark.parametrize(("verified", "claimed", "summary", "kind"), [
    ("HEALTHY", "DEGRADED", "A new warning appeared, so the outcome is DEGRADED.", "replaced"),
    ("DEGRADED", "HEALTHY", "orders looks fine, so the outcome is HEALTHY.", "replaced"),
    ("INCIDENT", "HEALTHY", "Nothing is wrong: the outcome is HEALTHY.", "replaced"),
    ("INCIDENT", "DEGRADED", "orders errors rose after v1.5.0 (E1, E2).", "prefixed"),
    ("INCIDENT", "DEGRADED", "Errors rose, so this is DEGRADED.", "replaced"),
    ("UNDETERMINED", "HEALTHY", "The outcome is HEALTHY.", "replaced"),
    ("UNDETERMINED", "INCIDENT", "The outcome is INCIDENT.", "replaced"),
])
def test_a_summary_that_contradicts_the_computed_outcome_is_made_consistent_and_the_original_kept(verified, claimed, summary, kind):
    report = report_with(summary, claimed, verified)
    before = report.model_copy(deep=True)
    notes = enforce(report, store_for(verified))
    assert report.assessment.outcome == verified and report.outcome == verified
    assert [o for o in guardrails.stated_outcomes(report.summary) if o != verified] == []
    assert f"Assessed outcome: {verified}." in report.summary
    correction = report.summary_correction
    assert correction.kind == kind and correction.verified_outcome == verified and correction.original_summary == summary and correction.stated_outcome == claimed
    assert any("The model's original summary is kept with the report." in n for n in notes)
    # Written by the service, and saying so; the model's findings are untouched.
    assert ("Summary written by OPSILUME" in report.summary) if kind == "replaced" else report.summary.endswith(summary)
    assert [h.title for h in report.hypotheses] == [h.title for h in before.hypotheses]
    assert report.hypotheses[0].contradictions == before.hypotheses[0].contradictions
    assert set(before.uncertainties) <= set(report.uncertainties)
    if verified != "INCIDENT":
        # No outcome is established, so the summary must not present a cause as established.
        assert all(h.status != "likely" for h in report.hypotheses)


@pytest.mark.parametrize(("verified", "summary"), [
    ("DEGRADED", "orders logged six new errors; the cause is not established, so the outcome is DEGRADED."),
    ("HEALTHY", "Nothing is wrong: metrics held steady, so the outcome is HEALTHY."),
    ("INCIDENT", "Errors began after v1.5.0 (E1, E2); orders is recorded as DEGRADED by its own health check."),
])
def test_a_consistent_summary_is_left_exactly_as_written(verified, summary):
    report = report_with(summary, verified, verified)
    notes = enforce(report, store_for(verified))
    assert report.summary == summary and report.summary_correction is None
    assert not any("original summary is kept" in n for n in notes)


def test_without_a_claim_of_its_own_a_consistent_summary_is_not_touched():
    report = report_with("orders is fine.", None, "HEALTHY")
    enforce(report, store_for("HEALTHY"))
    assert report.summary == "orders is fine." and report.summary_correction is None


@pytest.mark.parametrize("summary", ["", "   ", "\n\t"])
def test_an_empty_summary_is_replaced_from_the_assessment(summary):
    report = report_with(summary, "HEALTHY", "HEALTHY")
    enforce(report, store_for("HEALTHY"))
    assert report.summary.startswith("Summary written by OPSILUME from the computed assessment, because the model returned no summary.")
    assert report.summary_correction.kind == "replaced" and report.summary_correction.original_summary == summary


def test_control_characters_are_removed_before_the_summary_is_checked():
    report = report_with("so the outcome is\x00 DEGRADED", "DEGRADED", "HEALTHY")
    enforce(report, store_for("HEALTHY"))
    assert report.summary_correction.kind == "replaced" and "\x00" not in report.summary


def test_running_the_guardrails_again_changes_nothing():
    for verified, claimed, summary in [("HEALTHY", "DEGRADED", "so the outcome is DEGRADED."), ("INCIDENT", "DEGRADED", "Errors rose after v1.5.0.")]:
        report, store = report_with(summary, claimed, verified), store_for(verified)
        enforce(report, store)
        once = report.model_copy(deep=True)
        again = enforce(report, store)
        assert report.summary == once.summary and report.summary_correction == once.summary_correction
        assert not any("original summary is kept" in n for n in again)


def test_no_production_change_becomes_available_as_a_side_effect():
    restart = RecommendedAction(type="restart_service", title="Restart orders", description="Restart the pods.", risk="LOW", service_slug="orders", evidence_refs=["E1"])
    for verified in ("HEALTHY", "DEGRADED", "UNDETERMINED"):
        report = report_with("The outcome is INCIDENT; restart orders.", "INCIDENT", verified, [restart])
        enforce(report, store_for(verified))
        assert report.recommended_actions == [] and report.summary_correction.kind == "replaced"


def test_a_summary_longer_than_the_limit_is_cut_not_rejected():
    long = "orders errors rose after v1.5.0. " * 400
    report = report_with(long, "DEGRADED", "INCIDENT")
    enforce(report, store_for("INCIDENT"))
    assert report.summary_correction.kind == "prefixed" and len(report.summary) <= guardrails.SUMMARY_MAX_LENGTH
    assert len(report.summary_correction.original_summary) <= guardrails.SUMMARY_MAX_LENGTH


# ── The live reports that showed the defect ──


def live(name: str):
    record = LIVE[name]
    store = EvidenceStore()
    store.items = [EvidenceItem.model_validate(e) for e in record["evidence"]]
    for call in record["toolCalls"]:
        if call.get("ok"):
            store.coverage.setdefault(str(call["tool"]), {"calls": 0, "records": 0})["calls"] += 1
    store.metric_services = set(record["metricServices"])
    store.health_gaps = list(record["healthGaps"])
    report = InvestigationReport.model_validate(record["reportBeforeGuardrails"])
    original = report.summary
    guardrails.enforce(report, store, scope=record["scope"], tool_failures=record["toolFailures"], known_times=record["knownTimes"])
    return report, original


@pytest.mark.parametrize("name", ["healthy_no_signal", "healthy_misleading_signals"])
def test_the_two_healthy_reports_now_agree_with_their_outcome(name):
    report, original = live(name)
    assert "DEGRADED" in guardrails.stated_outcomes(original)  # the defect, as it was
    assert report.assessment.outcome == "HEALTHY" and guardrails.stated_outcomes(report.summary) == ["HEALTHY"]
    assert report.summary.startswith("Summary written by OPSILUME") and report.summary_correction.original_summary == original
    # The rewritten text introduces no figure the checker cannot match to evidence.
    assert [f for f in report.integrity.flagged if f.where == "summary"] == []
    # The model's findings are kept; its fault hypothesis stays capped and unlikely.
    assert report.hypotheses and all(h.status == "unlikely" and h.confidence <= 0.2 for h in report.hypotheses)


def test_the_upstream_report_keeps_its_narrative_behind_the_computed_outcome():
    report, original = live("upstream_dependency_down")
    assert report.assessment.outcome == "INCIDENT" and report.summary_correction.kind == "prefixed"
    assert report.summary.startswith("Assessed outcome: INCIDENT. Added by OPSILUME: the model concluded DEGRADED") and report.summary.endswith(original)
    assert guardrails.stated_outcomes(report.summary) == ["INCIDENT"]


# ── When the model fails, the rule-based report is consistent too ──


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
async def test_a_failed_report_falls_back_to_a_rule_based_summary_that_agrees(kind):
    result = await evaluate(SCENARIO["healthy_no_signal"], FailingReport(kind=kind))
    assert result.mode == "heuristic" and result.scores["summary"].ok and result.scores["outcome"].ok


class ContradictingModel(MockProvider):
    """Writes a report that calls a healthy service DEGRADED, as the live model did."""

    async def structured(self, messages, schema):
        draft = await super().structured(messages, schema)
        if schema is LLMReport:
            draft.outcome = "DEGRADED"
            draft.summary = "A warning appeared without an established cause, so I rate the outcome DEGRADED rather than HEALTHY."
        return draft


async def test_the_evaluator_records_a_pass_that_needed_the_correction():
    # The scripted mock gathers no metrics, so this scenario is UNDETERMINED here whatever the
    # model claims; what matters is how the summary is scored in each view.
    result = await evaluate(SCENARIO["healthy_clean"], ContradictingModel())
    assert result.scores["summary"].ok and "only because OPSILUME rewrote it" in result.scores["summary"].why
    assert "summary" in result.unaided_failures
    # When every criterion passes on the final report, the pass is marked as assisted.
    from dataclasses import replace

    from app.evals.scoring import Score

    clean = replace(result, scores={name: Score("pass", "") for name in result.scores})
    assert clean.passed and clean.guardrail_assisted and clean.wire()["guardrailAssisted"] is True
    assert not replace(clean, unaided_failures=[]).guardrail_assisted
