import { GUARDRAIL_LIMITS as LIMITS } from '../../generated/contracts';
import type { InvestigationEvent } from '../../integrations/aiService';
import { actionEffect } from '../../lib/actionEffect';
import type { InvestigationReport } from './schema';

export type StepInput = Extract<InvestigationEvent, { type: 'step' }>['step'];

const SUMMARY = LIMITS.summaryConsistency;
const SUMMARY_MAX_LENGTH = 6000;
const STATEMENTS = SUMMARY.statementPatterns.map((p) => new RegExp(p, 'gi'));
const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_m, key: string) => values[key] ?? '');
const cited = (refs: string[]) => (refs.length ? ` (${refs.join(', ')})` : '');

/**
 * The outcomes a text states as its conclusion ("the outcome is DEGRADED", "so this is an
 * INCIDENT"). A service's recorded health and negations are not statements of the outcome.
 * The same patterns as the AI service (contracts/guardrails.json).
 */
export function statedOutcomes(text: string): string[] {
  const found = STATEMENTS.flatMap((re) => [...(text ?? '').matchAll(re)].map((m) => m[1]!.toUpperCase()));
  return [...new Set(found)];
}

/** Makes the summary agree with the assessed outcome, as services/ai/app/guardrails.py does. */
function reconcileSummary(result: InvestigationReport, claimed: string | null): string | null {
  const assessment = result.assessment ?? null;
  const original = result.summary ?? '';
  const stated = statedOutcomes(original);
  if (!assessment) {
    // Nothing is verified, so nothing is rewritten into an outcome: the summary is marked.
    if (result.summaryCorrection || (!stated.length && !claimed)) return null;
    result.summaryCorrection = { kind: 'unverified', statedOutcome: (stated[0] ?? claimed ?? null) as never, verifiedOutcome: null, originalSummary: original.slice(0, SUMMARY_MAX_LENGTH) };
    result.summary = (SUMMARY.unverified + original).slice(0, SUMMARY_MAX_LENGTH);
    return SUMMARY.unverifiedNote;
  }
  const outcome = assessment.outcome;
  const conflicting = stated.filter((o) => o !== outcome);
  if (conflicting.length || !original.trim()) {
    const statedOutcome = conflicting[0] ?? null;
    const rationale = assessment.rationale.replace(/[. ]+$/, '') + cited(assessment.supportingRefs) + '.';
    let text = fill(conflicting.length ? SUMMARY.replaced : SUMMARY.replacedEmpty, { stated: statedOutcome ?? '', outcome, rationale });
    const top = result.hypotheses[0];
    if (top) text += fill(SUMMARY.leadingHypothesis, { title: top.title, status: top.status, refs: cited(top.evidenceRefs) });
    // A summary already corrected upstream keeps the model's original text, not the corrected one.
    result.summaryCorrection = { kind: 'replaced', statedOutcome: (statedOutcome ?? claimed) as never, verifiedOutcome: outcome, originalSummary: (result.summaryCorrection?.originalSummary ?? original).slice(0, SUMMARY_MAX_LENGTH) };
    result.summary = text.slice(0, SUMMARY_MAX_LENGTH);
    return fill(SUMMARY.note, { action: 'was rewritten from the computed assessment', stated: statedOutcome ?? 'nothing', outcome });
  }
  if (claimed && claimed !== outcome && !result.summaryCorrection) {
    result.summaryCorrection = { kind: 'prefixed', statedOutcome: claimed as never, verifiedOutcome: outcome, originalSummary: original.slice(0, SUMMARY_MAX_LENGTH) };
    result.summary = (fill(SUMMARY.prefixed, { stated: claimed, outcome }) + original).slice(0, SUMMARY_MAX_LENGTH);
    return fill(SUMMARY.note, { action: 'now begins with the computed outcome', stated: claimed, outcome });
  }
  return null;
}

/** Added to the uncertainties of a report that arrived without an assessment of the evidence. */
const UNVERIFIED = 'This report arrived without an assessment of the evidence, so its outcome is not verified.';

/**
 * Server-side guardrails, applied regardless of what the model produced:
 *  - every evidence reference must point at evidence that was actually collected;
 *  - a hypothesis with no supporting evidence cannot be rated "likely" and its confidence is capped;
 *  - the outcome is the one the AI service computed from the evidence (the assessment), never the
 *    outcome the report's author states; a report without an assessment has no verified outcome;
 *  - when the outcome is DEGRADED (the cause is not established), or there is no verified outcome,
 *    no hypothesis is rated "likely" and each is capped at the unestablished-cause cap;
 *  - overall confidence cannot exceed the best-supported hypothesis;
 *  - the summary may not state an outcome other than the assessed one: it is rewritten from the
 *    assessment, or the assessed outcome is put in front of it, and the original is kept; without
 *    an assessment it is marked as not verified;
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
  const verified = report.assessment?.outcome ?? null;
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
  // The outcome the report's author stated, as received; compared with the assessed one.
  const summaryNote = reconcileSummary(result, report.outcome ?? null);
  if (summaryNote) notes.push(summaryNote);

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
