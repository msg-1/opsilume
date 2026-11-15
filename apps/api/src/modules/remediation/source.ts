import { Prisma } from '@prisma/client';
import { GUARDRAIL_LIMITS as LIMITS } from '../../generated/contracts';
import { prisma } from '../../lib/prisma';
import { trustedStoredAssessment } from '../investigations/legacy';
import { citedRefs } from './content';

/**
 * Whether the investigation behind a production change still supports it.
 *
 * Checked for every state-changing action that is linked to an investigation, whoever proposed
 * it, and for every AI proposal (an AI proposal without an investigation has lost its source).
 * The AI may propose a state-changing action only under a verified INCIDENT (the guardrails
 * withdraw it otherwise); an action proposed before those rules, from a report whose assessment
 * is not trusted today, or by a person citing an investigation that does not show an incident,
 * may not meet that. So the source is checked from what is stored whenever the action is
 * proposed, submitted, approved, executed or shown:
 *  - the investigation still exists;
 *  - its stored assessment is well formed, cites only evidence recorded for the run (an incident
 *    at least one), and its outcome is INCIDENT;
 *  - the evidence the proposal cites (its "Evidence:" line) was recorded for the run.
 * Anything unclear counts as unverified. An unverified source does not discard or reject the
 * action: it requires a fresh, explicit human review (routes.ts, approvalHash in content.ts).
 * Rejecting it outright would only teach people to drop the link, since an unlinked human
 * proposal is judged on its own as before.
 *
 * Read-only diagnostics, and human proposals not linked to an investigation, need no source.
 */

export type SourceCheck = { required: boolean; verified: boolean; reasons: string[] };

type ActionLike = { id: string; organizationId: string; proposedByType: string; effect: string; investigationId: string | null; rationale: string | null };

/** Whether an action's source must be checked: a production change that is an AI proposal or is linked to an investigation. */
export const sourceRequired = (a: Pick<ActionLike, 'proposedByType' | 'effect' | 'investigationId'>) => a.effect === 'state_changing' && (a.proposedByType === 'ai_agent' || a.investigationId != null);
type Row = { id: string; assessment: unknown };

const NOT_REQUIRED: SourceCheck = { required: false, verified: true, reasons: [] };

export async function sourceChecks(actions: ActionLike[]): Promise<Map<string, SourceCheck>> {
  const checks = new Map<string, SourceCheck>();
  const needed = actions.filter(sourceRequired);
  for (const a of actions) if (!needed.includes(a)) checks.set(a.id, NOT_REQUIRED);
  const byOrganization = new Map<string, string[]>();
  for (const a of needed) if (a.investigationId) (byOrganization.get(a.organizationId) ?? byOrganization.set(a.organizationId, []).get(a.organizationId)!).push(a.investigationId);
  const found = new Map<string, { organizationId: string; assessment: unknown; recorded: Set<string> }>();
  for (const [organizationId, ids] of byOrganization) {
    const unique = [...new Set(ids)];
    const [rows, evidence] = await Promise.all([
      prisma.$queryRaw<Row[]>`SELECT id, report->'assessment' AS assessment FROM "Investigation" WHERE "organizationId" = ${organizationId} AND id IN (${Prisma.join(unique)})`,
      prisma.evidence.findMany({ where: { investigationId: { in: unique }, investigation: { organizationId } }, select: { investigationId: true, ref: true } }),
    ]);
    for (const r of rows) found.set(r.id, { organizationId, assessment: r.assessment, recorded: new Set(evidence.filter((e) => e.investigationId === r.id).map((e) => e.ref)) });
  }
  for (const a of needed) {
    const reasons: string[] = [];
    const source = a.investigationId ? found.get(a.investigationId) : undefined;
    if (!source || source.organizationId !== a.organizationId) {
      reasons.push('the investigation behind it no longer exists');
    } else {
      const assessment = trustedStoredAssessment(source.assessment, source.recorded);
      if (!assessment) reasons.push('its assessment of the evidence is missing, malformed or does not match the evidence recorded');
      else if (assessment.outcome !== LIMITS.outcomeAllowingProductionChanges) reasons.push(`its verified outcome is ${assessment.outcome}, not an incident`);
      const cited = citedRefs(a.rationale);
      const unknown = cited.filter((r) => !source.recorded.has(r));
      if (unknown.length) reasons.push(`it cites evidence the investigation did not record (${unknown.join(', ')})`);
    }
    checks.set(a.id, { required: true, verified: !reasons.length, reasons });
  }
  return checks;
}

export const sourceCheck = async (action: ActionLike) => (await sourceChecks([action])).get(action.id)!;

/** Why an action needs a fresh review, for the person reading the refusal. */
export const sourceMessage = (check: SourceCheck, proposedByType: string) =>
  `${proposedByType === 'ai_agent' ? 'This action was proposed by an AI investigation that' : 'The investigation this action is linked to'} does not support a production change: ${check.reasons.join('; ')}. A person must review it before it can go ahead: submit it with acknowledgeUnverifiedSource: true, and each approver must acknowledge the same.`;
