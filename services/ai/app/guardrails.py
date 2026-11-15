"""Input and output guardrails for investigations.

Input: the user's question and all tool output are treated as untrusted data. Suspicious
instruction-like content is flagged (and reported in the investigation steps), never obeyed.
Output: the report is checked against the evidence that was actually collected.
"""

from __future__ import annotations

import re

from . import assessment as assessing
from . import claims
from .effects import action_effect
from .evidence import EvidenceStore
from .generated.contracts import GUARDRAIL_LIMITS as LIMITS
from .schemas import InvestigationReport, SummaryCorrection

# Limits are defined once, in contracts/guardrails.json, and generated for the API as well.
MAX_LLM_CONFIDENCE: float = LIMITS["maxConfidence"]["llm"]
UNSUPPORTED_CONFIDENCE_CAP: float = LIMITS["unsupportedHypothesisCap"]

_INJECTION = re.compile(
    r"ignore (all |any )?(previous|prior|above) (instructions|prompts)|disregard (the )?(system|previous) (prompt|instructions)|"
    r"you are now|reveal (your|the) (system prompt|instructions)|print (your|the) system prompt|act as (?!incident)|"
    r"exfiltrat|send (it|this|them|the data) to http",
    re.IGNORECASE,
)
_OVERCLAIM = re.compile(r"(?<!not a )(?<!no )\b(confirmed root cause|root cause is confirmed|definitely caused|certainly caused|proven (to be )?the cause|without (a )?doubt)\b", re.IGNORECASE)
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def screen_text(text: str) -> tuple[str, list[str]]:
    """Removes control characters and reports instruction-like phrases found in untrusted text."""
    cleaned = _CONTROL.sub("", text).strip()
    findings = sorted({m.group(0).lower() for m in _INJECTION.finditer(cleaned)})
    return cleaned, findings


def wrap_untrusted(label: str, content: str) -> str:
    """Marks content as data so the model does not treat it as instructions."""
    return f"<{label}>\n{content.replace(f'</{label}>', '')}\n</{label}>"


#: Highest confidence a fault hypothesis may carry when the evidence shows no fault
NO_FAULT_HYPOTHESIS_CAP: float = LIMITS["noFaultHypothesisCap"]
#: Highest confidence any hypothesis may carry when the outcome is DEGRADED: anomalies are
#: present but the cause is not established, so no hypothesis may reach "likely".
UNESTABLISHED_CAUSE_CAP: float = LIMITS["unestablishedCauseCap"]
# How a summary states an outcome, and the wording used when it has to be made consistent.
# Defined once in contracts/guardrails.json and applied the same way by the API.
_SUMMARY = LIMITS["summaryConsistency"]
_STATEMENTS = [re.compile(p, re.IGNORECASE) for p in _SUMMARY["statementPatterns"]]
SUMMARY_MAX_LENGTH = 6000


def stated_outcomes(text: str) -> list[str]:
    """The outcomes a text states as its conclusion: "the outcome is DEGRADED", "I rate the
    outcome HEALTHY", "so this is an INCIDENT". A service's recorded health ("recorded as
    HEALTHY") and negations ("not an INCIDENT", "DEGRADED rather than HEALTHY") are not
    statements of the outcome. Paraphrases ("the service looks fine") are not recognised."""
    found = [m.group(1).upper() for p in _STATEMENTS for m in p.finditer(text or "")]
    return list(dict.fromkeys(found))


def _cited(refs: list[str]) -> str:
    return f" ({', '.join(refs)})" if refs else ""


def reconcile_summary(report: InvestigationReport, claimed: str | None) -> str | None:
    """Makes the summary agree with the computed outcome. Returns a note when it changes it.

    The model writes its summary before the outcome is computed. If the summary states another
    outcome, or is empty, it is rewritten from the assessment. If only the model's own outcome
    differed and the summary states none, a sentence giving the computed outcome is put in
    front. Either way the original is kept in `summary_correction`, and the new text says it was
    written by OPSILUME, not by the model. Agreeing with the outcome does not make a summary
    correct; it only stops it from contradicting the assessment shown beside it."""
    verdict = report.assessment
    if verdict is None:
        return None
    outcome, original = verdict.outcome, report.summary or ""
    conflicting = [o for o in stated_outcomes(original) if o != outcome]
    if conflicting or not original.strip():
        stated = conflicting[0] if conflicting else None
        rationale = verdict.rationale.rstrip(". ") + _cited(verdict.supporting_refs) + "."
        text = (_SUMMARY["replaced"] if conflicting else _SUMMARY["replacedEmpty"]).format(stated=stated, outcome=outcome, rationale=rationale)
        if report.hypotheses:
            top = report.hypotheses[0]
            text += _SUMMARY["leadingHypothesis"].format(title=top.title, status=top.status, refs=_cited(top.evidence_refs))
        # An empty summary stated nothing: the model's own outcome field is not what it "stated".
        report.summary_correction = SummaryCorrection(kind="replaced", stated_outcome=stated, verified_outcome=outcome, original_summary=original[:SUMMARY_MAX_LENGTH])  # type: ignore[arg-type]
        report.summary = text[:SUMMARY_MAX_LENGTH]
        return _SUMMARY["note"].format(action="was rewritten from the computed assessment", stated=stated or "nothing", outcome=outcome)
    if claimed and claimed != outcome:
        report.summary_correction = SummaryCorrection(kind="prefixed", stated_outcome=claimed, verified_outcome=outcome, original_summary=original[:SUMMARY_MAX_LENGTH])  # type: ignore[arg-type]
        report.summary = (_SUMMARY["prefixed"].format(stated=claimed, outcome=outcome) + original)[:SUMMARY_MAX_LENGTH]
        return _SUMMARY["note"].format(action="now begins with the computed outcome", stated=claimed, outcome=outcome)
    return None


assert UNESTABLISHED_CAUSE_CAP < LIMITS["likelyMinimumConfidence"], "contracts/guardrails.json: unestablishedCauseCap must be below likelyMinimumConfidence"


def _valid_rollback(action, store: EvidenceStore) -> str | None:
    """Why a rollback's target is not borne out by the evidence, or None when it is."""
    params = action.parameters
    deployments = store.by_kind("deployment")
    target = next((d for d in deployments if params and d.source_id == params.deployment_id), None)
    if not params or not params.deployment_id:
        return "it does not say which deployment to roll back"
    if target is None:
        return f"deployment {params.deployment_id} is not among the deployments that were retrieved"
    if not params.to_version:
        return "it does not say which version to return to"
    wanted = params.to_version.lower().removeprefix("v")
    earlier = [d for d in deployments if d.service == target.service and (d.occurred_at or "") < (target.occurred_at or "")]
    match = next((d for d in earlier if str((d.data or {}).get("version") or "").lower().removeprefix("v") == wanted), None)
    if match is None:
        return f"{params.to_version} is not an earlier deployment of {target.service} in the evidence"
    status = (match.data or {}).get("status")
    if status == "ROLLED_BACK":
        return f"{params.to_version} was itself rolled back, so it is not a version to return to"
    if status != "SUCCEEDED":
        return f"{params.to_version} did not deploy successfully ({status}), so it never ran"
    if wanted == str((target.data or {}).get("version") or "").lower().removeprefix("v"):
        return f"{params.to_version} is the version that deployment installed, so there is nothing to roll back to"
    if (target.data or {}).get("status") == "ROLLED_BACK":
        return f"deployment {params.deployment_id} has already been rolled back"
    return None


_KEY_LIKE = re.compile(r"sk-ant-[A-Za-z0-9_\-]{6,}|sk-[A-Za-z0-9_\-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")


def _clean(text: str) -> str:
    return _KEY_LIKE.sub("[redacted]", _CONTROL.sub("", text))


def _sanitise(report: InvestigationReport) -> bool:
    """Whatever wrote the report, its text is shown to people and stored. Control characters and
    anything shaped like a credential are taken out of every text field. Logs are redacted when
    they are ingested, so this is a second line: it matters when that redaction is switched off
    or a model reproduces something it should not. Returns whether anything changed."""
    changed = False

    def fix(obj: object, *fields: str) -> None:
        nonlocal changed
        for name in fields:
            value = getattr(obj, name, None)
            if isinstance(value, str):
                cleaned = _clean(value)
            elif isinstance(value, list) and all(isinstance(v, str) for v in value):
                cleaned = [_clean(v) for v in value]
            else:
                continue
            if cleaned != value:
                setattr(obj, name, cleaned)
                changed = True

    fix(report, "summary", "assumptions", "uncertainties", "next_steps")
    for h in report.hypotheses:
        fix(h, "title", "description", "facts", "assumptions", "gaps", "contradictions")
    for item in [*report.facts, *report.observations]:
        fix(item, "statement")
    for t in report.timeline:
        fix(t, "description")
    for a in report.recommended_actions:
        fix(a, "title", "description", "rationale")
    return changed


def enforce(report: InvestigationReport, store: EvidenceStore, *, scope: list[str] | None = None, tool_failures: list[str] | None = None, known_times: list[str] | None = None) -> list[str]:
    """Mutates the report so that it only claims what the evidence supports. Returns notes on what changed."""
    known = store.refs()
    notes: list[str] = []
    if _sanitise(report):
        notes.append("Removed control characters or a credential-like string from the report's text.")
    cap = LIMITS["maxConfidence"].get(report.analysis_mode, LIMITS["maxConfidence"]["heuristic"])

    def keep(refs: list[str], where: str) -> list[str]:
        normalised = [r.strip().strip("[]()").upper() for r in refs]
        kept = list(dict.fromkeys(r for r in normalised if r in known))
        dropped = len(set(normalised)) - len(kept)
        if dropped:
            notes.append(f"Removed {dropped} citation(s) of evidence that does not exist from {where}.")
        return kept

    for h in report.hypotheses:
        h.evidence_refs = keep(h.evidence_refs, f'hypothesis "{h.title[:60]}"')
        h.contradicting_evidence_refs = keep(h.contradicting_evidence_refs, f'the evidence against "{h.title[:60]}"')
        if not h.evidence_refs and (h.confidence > UNSUPPORTED_CONFIDENCE_CAP or h.status == "likely"):
            notes.append(f'Hypothesis "{h.title[:60]}" cites no evidence: confidence capped at {UNSUPPORTED_CONFIDENCE_CAP} and status set to possible.')
            h.confidence = min(h.confidence, UNSUPPORTED_CONFIDENCE_CAP)
            h.status = "possible"
        if h.confidence > cap:
            notes.append(f'Confidence of "{h.title[:60]}" reduced to {cap}: a root cause is never treated as certain before a human verifies it.')
            h.confidence = cap
        if h.status == "likely" and h.confidence < LIMITS["likelyMinimumConfidence"]:
            h.status = "possible"
    report.hypotheses.sort(key=lambda h: h.confidence, reverse=True)

    supported: list = []
    for f in report.facts:
        f.evidence_refs = keep(f.evidence_refs, "a stated fact")
        if f.evidence_refs:
            supported.append(f)
        else:
            notes.append(f'Moved an uncited "fact" to assumptions: "{f.statement[:80]}"')
            report.assumptions.append(f.statement)
    report.facts = supported

    for t in report.timeline:
        t.evidence_refs = keep(t.evidence_refs, "the timeline")
    report.timeline = [t for t in report.timeline if t.evidence_refs]

    for o in report.observations:
        o.evidence_refs = keep(o.evidence_refs, "an observation")
    report.observations = [o for o in report.observations if o.evidence_refs]

    withdrawn: list = []

    def withdraw(action, reason: str) -> None:
        """An action the evidence does not stand behind is not offered for approval, under any
        type: relabelling a rollback as "manual" would leave the same change on the table. It is
        kept where a human can still see it, with the reason."""
        notes.append(f'Action "{action.title[:60]}" is not offered for approval: {reason}. It is listed under next steps.')
        report.next_steps.append(LIMITS["nextStepPrefixes"]["withdrawn"].format(reason=reason, title=action.title)[:500])
        withdrawn.append(action)

    deployment_refs = {e.ref for e in store.by_kind("deployment")}
    for a in report.recommended_actions:
        a.evidence_refs = keep(a.evidence_refs, f'action "{a.title[:60]}"')
        if a.type == "rollback_deployment" and not (set(a.evidence_refs) & deployment_refs):
            notes.append(f'Action "{a.title[:60]}" proposed a rollback without citing a deployment: downgraded to a manual action.')
            a.type = "manual"
            a.parameters = None
        elif a.type == "rollback_deployment" and (problem := _valid_rollback(a, store)):
            # A rollback is offered for approval only with a target the evidence bears out.
            withdraw(a, f"it proposed a rollback, but {problem}")
    report.recommended_actions = [a for a in report.recommended_actions if a not in withdrawn]
    # What each action would do is decided here from its type and text, never taken from the author.
    for a in report.recommended_actions:
        a.effect, a.effect_reasons = action_effect(a.type, a.title, a.description)
    # A production change must serve an explanation the report believes in. An action whose
    # cited evidence supports only hypotheses rated unlikely ("turn the flag off as a precaution")
    # is kept as something for a human to consider, not offered for approval as a change.
    held: set[str] = set()
    doubted: set[str] = set()
    for i, h in enumerate(report.hypotheses):
        (doubted if h.status == "unlikely" and i > 0 else held).update(h.evidence_refs)
    doubted -= held
    withdrawn.clear()
    by_source = {e.source_id: e.ref for e in store.by_kind("deployment")}
    for a in report.recommended_actions:
        if a.effect != "state_changing":
            continue
        # A rollback rests on the deployment it rolls back, not on every record it cites: the
        # previous version's deployment is cited as the target, whatever else that record supports.
        subject = by_source.get(a.parameters.deployment_id) if a.type == "rollback_deployment" and a.parameters and a.parameters.deployment_id else None
        rests_on = {subject} if subject else set(a.evidence_refs)
        if rests_on & doubted:
            withdraw(a, LIMITS["withdrawalReasons"]["unlikelyHypothesis"])
    report.recommended_actions = [a for a in report.recommended_actions if a not in withdrawn]
    # A high-risk option is not put forward next to a safer one that addresses the problem: it
    # moves to the next steps, where a human can still weigh it.
    if any(a.risk != "HIGH" for a in report.recommended_actions):
        for a in [a for a in report.recommended_actions if a.risk == "HIGH"]:
            notes.append(f'High-risk action "{a.title[:60]}" moved to next steps: a lower-risk action is proposed.')
            report.next_steps.append(LIMITS["nextStepPrefixes"]["highRisk"].format(title=a.title, description=a.description)[:600])
            report.recommended_actions.remove(a)
    report.recommended_actions = report.recommended_actions[: LIMITS["maxRecommendedActions"]]

    # ── Does the evidence show a fault at all? The answer is computed, not taken from the author. ──
    claimed = report.outcome
    verdict = assessing.assess(store, report.hypotheses, scope or [], tool_failures or [])
    report.assessment = verdict
    report.outcome = verdict.outcome
    if claimed and claimed != verdict.outcome:
        notes.append(f"The report concluded {claimed}; the evidence supports {verdict.outcome}: {verdict.rationale}")
    if verdict.outcome in ("HEALTHY", "UNDETERMINED"):
        for h in report.hypotheses:
            if h.confidence > NO_FAULT_HYPOTHESIS_CAP or h.status != "unlikely":
                notes.append(f'Hypothesis "{h.title[:60]}" limited to {NO_FAULT_HYPOTHESIS_CAP} and marked unlikely: the evidence shows no material fault for it to explain.')
                h.confidence = min(h.confidence, NO_FAULT_HYPOTHESIS_CAP)
                h.status = "unlikely"
    if verdict.outcome == "DEGRADED":
        # DEGRADED is defined as "cause not established", and "likely" claims that it is. Each
        # hypothesis is kept, rated no higher than possible and capped; the order cannot change,
        # because capping preserves it.
        for h in report.hypotheses:
            if h.confidence > UNESTABLISHED_CAUSE_CAP or h.status == "likely":
                notes.append(LIMITS["unestablishedCauseNote"].format(title=h.title[:60], cap=UNESTABLISHED_CAUSE_CAP))
                h.confidence = min(h.confidence, UNESTABLISHED_CAUSE_CAP)
                if h.status == "likely":
                    h.status = "possible"
    if verdict.outcome != LIMITS["outcomeAllowingProductionChanges"]:
        # Without an evident failure and a supported cause, nothing justifies changing production.
        withdrawn.clear()
        for a in [a for a in report.recommended_actions if a.effect == "state_changing"]:
            withdraw(a, LIMITS["withdrawalReasons"]["noIncident"].format(outcome=verdict.outcome))
        report.recommended_actions = [a for a in report.recommended_actions if a not in withdrawn]
    if not report.observations:
        report.observations = assessing.observations(store, verdict.signals)

    ceiling = max((h.confidence for h in report.hypotheses), default=0.0)
    if report.confidence > ceiling:
        notes.append(f"Overall confidence reduced from {report.confidence:.2f} to {ceiling:.2f} to match the strongest hypothesis.")
        report.confidence = ceiling

    # After the outcome and the hypotheses are final, and before the summary's wording and figures
    # are checked: the text that is checked is the text that is shown.
    note = reconcile_summary(report, claimed)
    if note:
        notes.append(note)

    if _OVERCLAIM.search(report.summary):
        report.summary = _OVERCLAIM.sub("leading hypothesis", report.summary) + " This is a hypothesis; the root cause has not been confirmed."
        notes.append("Rephrased wording in the summary that presented the cause as confirmed.")
    if not report.uncertainties:
        report.uncertainties.append("The analysis is based only on the records available in OpsPilot for the examined time window.")
        notes.append("Added a missing statement of uncertainty.")
    report.assumptions = list(dict.fromkeys(report.assumptions))

    # ── Figures and identifiers, checked against the evidence each statement cites ──
    report.integrity = claims.verify_report(report, store, known_times)
    unsupported = [f for f in report.integrity.flagged if f.status == "unsupported"]
    if unsupported:
        notes.append(f"{len(unsupported)} figure(s) or identifier(s) could not be matched to evidence and are marked as unsupported: " + "; ".join(f'"{f.text}" in {f.where}' for f in unsupported[:6]) + ".")
        report.uncertainties.append(f"{len(unsupported)} figure(s) in this report could not be matched to the collected evidence. They are marked; treat them as unverified.")
    return list(dict.fromkeys(notes))
