"""DEGRADED means the cause is not established: no hypothesis may stay "likely" under it.

Found by the first live evaluation of Milestone 10. In degraded_incomplete_evidence, claude-haiku-5-5
rated "index-node is slow or timing out" likely at 0.50, citing only symptoms. The assessment said
DEGRADED ("no cause is established"), but the guardrails capped hypotheses only for HEALTHY and
UNDETERMINED, so the report kept a likely cause that the product's own verdict denied.
"""

import json
from pathlib import Path

from app import guardrails
from app.evidence import EvidenceStore
from app.generated.contracts import GUARDRAIL_LIMITS
from app.graph import REPORT_INSTRUCTIONS
from app.schemas import EvidenceItem, HypothesisOut, InvestigationReport

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "live_degraded_incomplete_evidence.json").read_text())
CAP = GUARDRAIL_LIMITS["unestablishedCauseCap"]
CONTRACT = json.loads((Path(__file__).resolve().parents[3] / "contracts" / "guardrails.json").read_text())


def item(ref: str, evidence_kind: str, service: str = "orders", **data) -> EvidenceItem:
    return EvidenceItem(ref=ref, kind=evidence_kind, title=f"{evidence_kind} {ref}", summary="s", source_type=evidence_kind, source_id=f"src-{ref}", service=service, occurred_at="2026-06-01T11:30:00Z", data=data)


def hypothesis(title: str, confidence: float, status: str, refs: list[str]) -> HypothesisOut:
    return HypothesisOut(title=title, description="d", confidence=confidence, status=status, evidence_refs=refs)


def report(hypotheses: list[HypothesisOut], confidence: float) -> InvestigationReport:
    return InvestigationReport(summary="s", confidence=confidence, analysis_mode="llm", hypotheses=hypotheses, uncertainties=["u"], next_steps=["n"])


def degraded_store() -> EvidenceStore:
    store = EvidenceStore()
    store.items = [item("E1", "log_pattern", level="ERROR", count=6, kind="new", baselineCount=0)]
    return store


# ── The live failure itself ──


def test_the_live_report_that_failed_is_capped_without_losing_any_hypothesis():
    raw = InvestigationReport.model_validate(FIXTURE["reportBeforeGuardrails"])
    store = EvidenceStore()
    store.items = [EvidenceItem.model_validate(e) for e in FIXTURE["evidence"]]
    store.metric_services = set(FIXTURE["metricServices"])
    store.health_gaps = list(FIXTURE["healthGaps"])
    before = [(h.title, h.status, h.confidence) for h in raw.hypotheses]
    assert before[0][1:] == ("likely", 0.5) and FIXTURE["liveResult"]["guardrailNotes"] == []  # as the live run saw it

    notes = guardrails.enforce(raw, store, scope=FIXTURE["scope"], tool_failures=FIXTURE["toolFailures"], known_times=FIXTURE["knownTimes"])

    assert raw.assessment.outcome == "DEGRADED"
    after = [(h.title, h.status, h.confidence) for h in raw.hypotheses]
    # The leading hypothesis is kept, rated possible, capped; the others were already within the cap.
    assert after[0] == (before[0][0], "possible", CAP)
    assert after[1:] == before[1:]
    assert raw.confidence == CAP  # overall confidence follows the strongest hypothesis
    assert any("the outcome is DEGRADED, so the cause is not established" in n and before[0][0][:60] in n for n in notes)
    assert all(h.status != "likely" for h in raw.hypotheses)


# ── The rule, in each outcome ──


def test_degraded_hypotheses_already_within_the_cap_are_left_alone():
    r = report([hypothesis("A traffic shift", 0.3, "possible", ["E1"]), hypothesis("Something else", 0.1, "unlikely", ["E1"])], 0.3)
    notes = guardrails.enforce(r, degraded_store(), scope=["orders"], tool_failures=[])
    assert r.assessment.outcome == "DEGRADED"
    assert [(h.status, h.confidence) for h in r.hypotheses] == [("possible", 0.3), ("unlikely", 0.1)] and r.confidence == 0.3
    assert not any("outcome is DEGRADED" in n for n in notes)


def test_a_likely_rating_below_the_cap_is_still_not_allowed_under_degraded():
    # Below likelyMinimumConfidence a "likely" rating is already downgraded by the existing rule,
    # before the outcome is known; under DEGRADED it must not survive either way.
    r = report([hypothesis("Low but likely", 0.4, "likely", ["E1"])], 0.4)
    guardrails.enforce(r, degraded_store(), scope=["orders"], tool_failures=[])
    assert r.assessment.outcome == "DEGRADED"
    assert (r.hypotheses[0].status, r.hypotheses[0].confidence) == ("possible", 0.4)


def test_an_incident_with_a_causally_supported_likely_hypothesis_is_unchanged():
    store = EvidenceStore()
    store.items = [item("E1", "deployment", version="v1.5.0", status="SUCCEEDED", isRollback=False), item("E2", "log_pattern", level="ERROR", count=300, kind="new", baselineCount=0)]
    r = report([hypothesis("v1.5.0 broke orders", 0.8, "likely", ["E1", "E2"])], 0.8)
    notes = guardrails.enforce(r, store, scope=["orders"], tool_failures=[])
    assert r.assessment.outcome == "INCIDENT"
    assert (r.hypotheses[0].status, r.hypotheses[0].confidence, r.confidence) == ("likely", 0.8, 0.8)
    assert not any("outcome is DEGRADED" in n for n in notes)


def test_healthy_keeps_its_own_lower_cap():
    store = EvidenceStore()
    store.items = [item("E1", "metric_baseline", metric="error_rate", unit="%", avg=0.2, baselineAvg=0.2)]
    store.metric_services = {"orders"}
    r = report([hypothesis("A fault nobody can see", 0.6, "likely", ["E1"])], 0.6)
    guardrails.enforce(r, store, scope=["orders"], tool_failures=[])
    assert r.assessment.outcome == "HEALTHY"
    assert (r.hypotheses[0].status, r.hypotheses[0].confidence) == ("unlikely", GUARDRAIL_LIMITS["noFaultHypothesisCap"])


def test_undetermined_keeps_its_own_lower_cap():
    store = EvidenceStore()
    store.items = [item("E1", "deployment", version="v1.4.0", status="SUCCEEDED", isRollback=False)]
    r = report([hypothesis("The deployment did it", 0.6, "likely", ["E1"])], 0.6)
    guardrails.enforce(r, store, scope=["orders"], tool_failures=[])
    assert r.assessment.outcome == "UNDETERMINED"
    assert (r.hypotheses[0].status, r.hypotheses[0].confidence) == ("unlikely", GUARDRAIL_LIMITS["noFaultHypothesisCap"])


# ── The contract and the instructions ──


def test_the_cap_comes_from_the_contract_and_sits_below_the_likely_threshold():
    assert GUARDRAIL_LIMITS["unestablishedCauseCap"] == CONTRACT["unestablishedCauseCap"] == guardrails.UNESTABLISHED_CAUSE_CAP == 0.45
    assert GUARDRAIL_LIMITS["unestablishedCauseCap"] < GUARDRAIL_LIMITS["likelyMinimumConfidence"]
    assert GUARDRAIL_LIMITS["unestablishedCauseNote"] == CONTRACT["unestablishedCauseNote"]


def test_the_report_instructions_state_the_degraded_rule_with_the_contract_value():
    line = next(x for x in REPORT_INSTRUCTIONS.splitlines() if "outcome is DEGRADED" in x)
    assert "Do not classify a root-cause hypothesis as likely" in line and f"({CAP})" in line
    assert "{unestablished_cap}" not in REPORT_INSTRUCTIONS
