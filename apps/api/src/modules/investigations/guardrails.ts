import { GUARDRAIL_LIMITS as LIMITS } from '../../generated/contracts';
import type { InvestigationEvent } from '../../integrations/aiService';
import { actionEffect } from '../../lib/actionEffect';
import type { InvestigationReport } from './schema';

export type StepInput = Extract<InvestigationEvent, { type: 'step' }>['step'];

const SUMMARY = LIMITS.reportSummary;

/** The summary of a model or mock report: the assessed outcome and the assessment's rationale, as in guardrails.py. */
export function verifiedSummary(assessment: Pick<NonNullable<InvestigationReport['assessment']>, 'outcome' | 'rationale' | 'supportingRefs'>): string {
  const rationale = assessment.rationale.replace(/[. ]+$/, '') + (assessment.supportingRefs.length ? ` (${assessment.supportingRefs.join(', ')})` : '') + '.';
  return SUMMARY.verified.replace('{outcome}', assessment.outcome).replace('{rationale}', rationale);
}

/**
 * Whether an assessment is consistent with the evidence the API itself recorded for the run:
 * every reference it cites was received as evidence, and an incident (the only outcome that
 * allows production changes) cites at least one. This is a consistency check, not proof of
 * where the assessment came from: the API trusts that because the report is the answer to its
 * own request to the AI service, whose code computes the assessment (docs/reliability.md §4b).
 */
export function trustedAssessment(assessment: { outcome: string; supportingRefs: string[] }, recorded: Set<string>): boolean {
  if (!assessment.supportingRefs.every((r) => recorded.has(r))) return false;
  return !(assessment.outcome === LIMITS.outcomeAllowingProductionChanges && !assessment.supportingRefs.length);
}

/**
 * Separates what is verified from what the model wrote. The incoming summary is never trusted:
 * for model and mock reports it is rebuilt from the assessment, and the model's text becomes (or
 * stays) the narrative. A rule-based report keeps its summary. Idempotent.
 */
function presentSummary(result: InvestigationReport): void {
  if (result.analysisMode === 'heuristic') {
    result.summarySource = 'rule_based';
    return;
  }
  if (result.narrative == null) result.narrative = (result.summary ?? '').slice(0, SUMMARY.narrativeMaxLength);
  result.summary = result.assessment ? verifiedSummary(result.assessment) : SUMMARY.unverified;
  result.summarySource = result.assessment ? 'assessment' : 'unverified';
}

/** Added to the uncertainties of a report that arrived without an assessment of the evidence. */
const UNVERIFIED = 'This report arrived without an assessment of the evidence, so its outcome is not verified.';

/**
 * Server-side guardrails, applied regardless of what the model produced:
 *  - every evidence reference must point at evidence that was actually collected;
 *  - an assessment is used only if it cites evidence that was collected (an incident at least one);
 *  - a hypothesis with no supporting evidence cannot be rated "likely" and its confidence is capped;
 *  - the outcome is the one the AI service computed from the evidence (the assessment), never the
 *    outcome the report's author states; a report without an assessment has no verified outcome;
 *  - when the outcome is DEGRADED (the cause is not established), or there is no verified outcome,
 *    no hypothesis is rated "likely" and each is capped at the unestablished-cause cap;
 *  - overall confidence cannot exceed the best-supported hypothesis;
 *  - for model and mock reports the summary is built here from the assessment alone, and what
 *    the model wrote is kept as its unverified narrative; without an assessment the summary says
 *    the outcome is not verified and states none;
 *  - what each action would do is decided here from its type and text;
 *  - a production change resting on a hypothesis rated unlikely is withdrawn;
 *  - a production change is withdrawn unless the verified outcome is an incident;
 *  - a high-risk action offered next to a safer one moves to the next steps.
 *
 * This pass is independent of the AI service's own guardrails on purpose: a report might arrive
 * that was never checked. The limits and wording come from contracts/guardrails.json and the
 * behaviour is pinned by contracts/fixtures/guardrail-cases.json, which both sides run.
 */
export async function applyGuardrails(
  report: InvestigationReport,
  known: Set<string>,
  addStep: (step: StepInput) => Promise<unknown>,
  deploymentRefs: Map<string, string> = new Map(),
): Promise<InvestigationReport> {
  const notes: string[] = [];
  const clean = (list: string[], where: string) => {
    const kept = list.filter((r) => known.has(r));
    if (kept.length !== list.length) notes.push(`Removed ${list.length - kept.length} reference(s) to non-existent evidence from ${where}.`);
    return kept;
  };
  // The assessment is computed by the AI service's code from the evidence; the report's own
  // `outcome` is what its author (possibly a model) claims, and is never taken as verified.
  // An assessment that cites evidence this run did not record (or an incident citing none) is not used.
  const assessment = report.assessment && trustedAssessment(report.assessment, known) ? report.assessment : null;
  if (report.assessment && !assessment) notes.push(`The assessment (${report.assessment.outcome}) is not used: it cites evidence this run did not record, or no evidence for an incident. The outcome is not verified.`);
  const verified = assessment?.outcome ?? null;
  if (verified === null && report.outcome) notes.push(LIMITS.unverifiedOutcomeNote.replace('{claimed}', report.outcome));
  const hypotheses = report.hypotheses.map((h) => {
    const evidence = clean(h.evidenceRefs, `hypothesis "${h.title}"`);
    let { confidence, status } = h;
    if (!evidence.length) {
      if (confidence > LIMITS.unsupportedHypothesisCap || status === 'likely') notes.push(`Hypothesis "${h.title}" has no supporting evidence; confidence capped at ${LIMITS.unsupportedHypothesisCap}.`);
      confidence = Math.min(confidence, LIMITS.unsupportedHypothesisCap);
      if (status === 'likely') status = 'possible';
    }
    // DEGRADED means the cause is not established, and without an assessment nothing is verified:
    // in either case "likely" would claim more than is known.
    if ((verified === 'DEGRADED' || verified === null) && (confidence > LIMITS.unestablishedCauseCap || status === 'likely')) {
      const note = verified === null ? LIMITS.unverifiedCauseNote : LIMITS.unestablishedCauseNote;
      notes.push(note.replace('{title}', h.title.slice(0, 60)).replace('{cap}', String(LIMITS.unestablishedCauseCap)));
      confidence = Math.min(confidence, LIMITS.unestablishedCauseCap);
      if (status === 'likely') status = 'possible';
    }
    return { ...h, evidenceRefs: evidence, contradictingEvidenceRefs: clean(h.contradictingEvidenceRefs, `the evidence against "${h.title}"`), confidence, status };
  });
  const ceiling = hypotheses.length ? Math.max(...hypotheses.map((h) => h.confidence)) : 0.2;
  let confidence = report.confidence;
  if (confidence > ceiling) {
    notes.push(`Overall confidence reduced from ${confidence.toFixed(2)} to ${ceiling.toFixed(2)} to match the strongest hypothesis.`);
    confidence = ceiling;
  }
  const result: InvestigationReport = {
    ...report,
    assessment,
    // As in the AI service, the outcome a report carries is the assessed one, or none.
    outcome: verified,
    uncertainties: verified === null && !report.uncertainties.includes(UNVERIFIED) ? [...report.uncertainties, UNVERIFIED] : report.uncertainties,
    confidence,
    hypotheses: hypotheses.sort((a, b) => b.confidence - a.confidence),
    timeline: report.timeline.map((t) => ({ ...t, evidenceRefs: clean(t.evidenceRefs, 'the timeline') })),
    facts: report.facts.map((f) => ({ ...f, evidenceRefs: clean(f.evidenceRefs, 'a stated fact') })).filter((f) => {
      if (f.evidenceRefs.length) return true;
      notes.push(`Moved unsupported statement to assumptions: "${f.statement.slice(0, 80)}"`);
      report.assumptions.push(f.statement);
      return false;
    }),
    recommendedActions: report.recommendedActions.map((a) => ({ ...a, evidenceRefs: clean(a.evidenceRefs, `action "${a.title}"`) })),
  };
  result.assumptions = report.assumptions;
  presentSummary(result);

  // The same rules as services/ai/app/guardrails.py, applied again here.
  // What each action does is decided from its type and text, never taken from the sender.
  result.recommendedActions = result.recommendedActions.map((a) => {
    const { effect, reasons } = actionEffect(a.type, a.title, a.description);
    return { ...a, effect, effectReasons: reasons };
  });
  const withdraw = (a: (typeof result.recommendedActions)[number], reason: string) => {
    notes.push(`Action "${a.title.slice(0, 60)}" is not offered for approval: ${reason}. It is listed under next steps.`);
    result.nextSteps = [...result.nextSteps, LIMITS.nextStepPrefixes.withdrawn.replace('{reason}', reason).replace('{title}', a.title).slice(0, 500)];
  };
  // 1. A production change must not rest on a hypothesis the report itself rates unlikely.
  //    It is withdrawn, not relabelled: as a "manual" action the same change would still be on offer.
  const held = new Set<string>();
  const doubted = new Set<string>();
  result.hypotheses.forEach((h, i) => h.evidenceRefs.forEach((r) => (h.status === 'unlikely' && i > 0 ? doubted : held).add(r)));
  held.forEach((r) => doubted.delete(r));
  result.recommendedActions = result.recommendedActions.filter((a) => {
    if (a.effect !== 'state_changing') return true;
    // A rollback rests on the deployment it rolls back, not on every record it cites (the
    // previous version's deployment is cited as the target, whatever else that record supports).
    const id = a.type === 'rollback_deployment' ? (a.parameters as { deploymentId?: unknown } | null | undefined)?.deploymentId : undefined;
    const subject = typeof id === 'string' ? deploymentRefs.get(id) : undefined;
    const restsOn = subject ? [subject] : a.evidenceRefs;
    if (!restsOn.some((r) => doubted.has(r))) return true;
    withdraw(a, LIMITS.withdrawalReasons.unlikelyHypothesis);
    return false;
  });
  // 1b. Without a verified incident and an established cause, nothing justifies changing production.
  if (verified !== LIMITS.outcomeAllowingProductionChanges) {
    const reason = verified === null ? LIMITS.withdrawalReasons.noAssessment : LIMITS.withdrawalReasons.noIncident.replace('{outcome}', verified);
    result.recommendedActions = result.recommendedActions.filter((a) => {
      if (a.effect !== 'state_changing') return true;
      withdraw(a, reason);
      return false;
    });
  }
  // 2. A high-risk option is not offered next to a safer one: it moves to the next steps.
  if (result.recommendedActions.some((a) => a.risk !== 'HIGH')) {
    const risky = result.recommendedActions.filter((a) => a.risk === 'HIGH');
    for (const a of risky) {
      notes.push(`High-risk action "${a.title.slice(0, 60)}" moved to next steps: a lower-risk action is proposed.`);
      result.nextSteps = [...result.nextSteps, LIMITS.nextStepPrefixes.highRisk.replace('{title}', a.title).replace('{description}', a.description).slice(0, 600)];
    }
    result.recommendedActions = result.recommendedActions.filter((a) => a.risk !== 'HIGH');
  }
  if (notes.length) await addStep({ type: 'guardrail', title: 'Output guardrails adjusted the report', detail: [...new Set(notes)].join('\n') });
  return result;
}
