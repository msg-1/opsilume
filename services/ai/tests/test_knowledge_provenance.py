"""Earlier AI output found in the knowledge base is labelled, and supports nothing.

The API marks postmortem text that quotes an earlier AI investigation (apps/api/src/modules/
knowledgeProvenance.ts). Here: the label reaches the evidence, and neither the guardrails nor the
rule-based engine let it count as support.
"""

from datetime import UTC, datetime, timedelta

from app import guardrails, rules
from app.evidence import EARLIER_AI_OUTPUT, EvidenceStore, is_earlier_ai_output
from app.generated.contracts import GUARDRAIL_LIMITS, KNOWLEDGE_PROVENANCES
from app.rules import Case
from app.schemas import EvidenceItem, Fact, HypothesisOut, InvestigationReport


def search_result(provenance: str | None, content: str = "The connection pool was exhausted.", doc_type: str = "postmortem") -> dict:
    hit = {"chunkId": "c1", "documentId": "d1", "title": "Postmortem: Orders outage", "type": doc_type, "section": "AI investigation findings (unconfirmed)", "content": content, "similarity": 0.8, "matchedBy": ["vector"]}
    if provenance:
        hit["provenance"] = provenance
    if provenance and provenance != "document":
        hit["currentAssessment"] = {"investigationId": "inv-1", "outcome": "INCIDENT", "summary": "Assessed outcome: INCIDENT. A failure is evident (E1)."}
    return {"mode": "hybrid", "results": [hit]}


def test_the_values_come_from_the_contract():
    assert EARLIER_AI_OUTPUT == set(KNOWLEDGE_PROVENANCES) - {"document"}


def test_earlier_ai_output_is_labelled_in_the_evidence_and_keeps_its_text():
    store = EvidenceStore()
    store.ingest("search_knowledge_base", search_result("earlier_ai_output"))
    item = store.items[0]
    assert item.title.endswith("(earlier AI output, not evidence)")
    assert item.data["provenance"] == "earlier_ai_output" and item.data["content"] == "The connection pool was exhausted."
    assert item.data["currentAssessment"]["outcome"] == "INCIDENT"
    assert is_earlier_ai_output(item) and store.not_evidence() == {item.ref}


def test_a_document_people_wrote_is_plain_evidence():
    store = EvidenceStore()
    store.ingest("search_knowledge_base", search_result("document"))
    assert not store.items[0].title.endswith("not evidence)") and store.items[0].data["provenance"] == "document"
    assert store.not_evidence() == set()


def test_a_missing_or_unrecognised_provenance_is_treated_conservatively():
    # A postmortem that does not say where its text came from may quote an earlier AI investigation.
    for hit, expected in [(search_result(None), "unknown"), (search_result("from-the-future"), "unknown"), (search_result(None, doc_type="runbook"), "document")]:
        store = EvidenceStore()
        store.ingest("search_knowledge_base", hit)
        assert store.items[0].data["provenance"] == expected
        assert (store.not_evidence() == {store.items[0].ref}) == (expected != "document")
    store = EvidenceStore()
    store.ingest("search_knowledge_base", search_result(None))
    assert store.items[0].title.endswith("(origin unknown, not evidence)")


def test_the_guardrails_count_it_as_no_support():
    store = EvidenceStore()
    store.items = [
        EvidenceItem(ref="E1", kind="log_pattern", title="300× ERROR in orders (new pattern)", summary="s", source_type="log_pattern", source_id="fp", service="orders", occurred_at="2026-06-01T11:30:00Z", data={"level": "ERROR", "count": 300, "kind": "new", "baselineCount": 0}),
        EvidenceItem(ref="E2", kind="document", title="Postmortem › AI findings", summary="s", source_type="knowledge_chunk", source_id="c1", data={"provenance": "earlier_ai_output"}),
    ]
    report = InvestigationReport(
        summary="s", confidence=0.8, analysis_mode="llm", uncertainties=["u"], next_steps=["n"],
        facts=[Fact(statement="The pool was exhausted last time.", evidence_refs=["E2"]), Fact(statement="Errors are rising.", evidence_refs=["E1"])],
        hypotheses=[HypothesisOut(title="Pool exhausted, as before", description="d", confidence=0.8, status="likely", evidence_refs=["E2"])],
    )
    notes = guardrails.enforce(report, store, scope=["orders"], tool_failures=[])
    h = report.hypotheses[0]
    assert h.evidence_refs == ["E2"]  # still cited
    assert h.status != "likely" and h.confidence <= GUARDRAIL_LIMITS["unsupportedHypothesisCap"]
    assert [f.statement for f in report.facts] == ["Errors are rising."]
    assert "The pool was exhausted last time." in report.assumptions
    assert any("cites only earlier AI output, which is not evidence" in n for n in notes)
    assert any("resting only on earlier AI output" in n for n in notes)


# ── The rule-based engine ──

NOW = datetime(2026, 6, 1, 12, 0, tzinfo=UTC)


def _at(minutes_ago: float) -> str:
    return (NOW - timedelta(minutes=minutes_ago)).isoformat().replace("+00:00", "Z")


def _case(provenance: str | None) -> Case:
    store = EvidenceStore()
    store.ingest("list_deployments", {"deployments": [{"id": "d1", "service": "orders", "version": "v2", "status": "SUCCEEDED", "commitSha": "abc1234567", "startedAt": _at(20), "isRollback": False}]})
    store.ingest("get_code_changes", {"commits": [{"id": "c1", "sha": "abc1234567", "repository": "orders", "message": "Lower the database connection pool size and the acquire timeout", "author": "a", "committedAt": _at(25), "service": "orders", "files": ["db.ts"]}]})
    store.ingest("find_log_anomalies", {"anomalies": [{"fingerprint": "fp", "sample": "timeout acquiring connection from database pool", "level": "ERROR", "serviceId": "svc_orders", "serviceSlug": "orders", "count": 300, "firstSeen": _at(10), "lastSeen": _at(1), "baselineCount": 0, "kind": "new"}]})
    store.ingest("search_knowledge_base", search_result(provenance, "Checkout failed when the database connection pool was exhausted and requests hit the acquire timeout."))
    return Case.build(store, scope=["orders"], window=(NOW - timedelta(hours=2), NOW))


def test_only_documents_people_wrote_corroborate_a_mechanism_or_suggest_a_procedure():
    plain, earlier = _case("document"), _case("earlier_ai_output")
    for case in (plain, earlier):
        rules.rule_recent_change(case)
    plain_h, earlier_h = plain.hypotheses[0], earlier.hypotheses[0]
    assert any("Documentation or a past incident describes the same mechanism" in f for f in plain_h.facts)
    assert not any("describes the same mechanism" in f for f in earlier_h.facts)
    assert earlier_h.confidence < plain_h.confidence
    doc_ref = earlier.store.by_kind("document")[0].ref
    assert doc_ref not in earlier_h.evidence_refs
    assert any("Follow the documented procedure" in s for s in rules.build_next_steps(plain, []))
    assert not any("Follow the documented procedure" in s for s in rules.build_next_steps(earlier, []))


def test_earlier_ai_output_cannot_make_an_outcome_an_incident():
    # INCIDENT, the only outcome that allows a production change, needs a hypothesis citing
    # something that can be a cause. A knowledge document, earlier AI output included, is not one.
    store = EvidenceStore()
    store.items = [
        EvidenceItem(ref="E1", kind="log_pattern", title="300× ERROR in orders (new pattern)", summary="s", source_type="log_pattern", source_id="fp", service="orders", occurred_at="2026-06-01T11:30:00Z", data={"level": "ERROR", "count": 300, "kind": "new", "baselineCount": 0}),
        EvidenceItem(ref="E2", kind="document", title="Postmortem › AI findings", summary="s", source_type="knowledge_chunk", source_id="c1", data={"provenance": "earlier_ai_output"}),
    ]
    report = InvestigationReport(summary="s", confidence=0.9, analysis_mode="llm", uncertainties=["u"], next_steps=["n"],
                                 hypotheses=[HypothesisOut(title="Pool exhausted, as the old postmortem said", description="d", confidence=0.9, status="likely", evidence_refs=["E1", "E2"])])
    guardrails.enforce(report, store, scope=["orders"], tool_failures=[])
    assert report.assessment.outcome == "DEGRADED"
    assert report.hypotheses[0].status != "likely"
