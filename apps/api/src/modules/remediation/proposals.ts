import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { REMEDIATION_TYPES, RISK_LEVELS } from '../../generated/contracts';
import { badRequest } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { addIncidentEvent } from '../incidents';
import { getSettings } from '../organization';
import { effectOf, effectiveRisk, requiredApprovals } from './effect';

/** Creating a proposed action, for a person (HTTP) or for the AI (from an investigation report). */

export const remediationInput = z.object({
  type: z.enum(REMEDIATION_TYPES),
  title: z.string().trim().min(4).max(200),
  description: z.string().trim().min(4).max(5000),
  rationale: z.string().trim().max(5000).nullable().optional(),
  risk: z.enum(RISK_LEVELS).default('MEDIUM'),
  incidentId: z.string().nullable().optional(),
  investigationId: z.string().nullable().optional(),
  serviceId: z.string().nullable().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

// expectedHash is the currentHash the approver was shown. Sending it makes the approval fail if
// the action changed between reading it and deciding.
// acknowledgeUnverifiedSource: the person has seen that the AI investigation behind the action no
// longer supports a production change (source.ts), and takes the decision on their own review.
export const decisionBody = z.object({ comment: z.string().trim().max(2000).optional(), expectedHash: z.string().length(64).optional(), acknowledgeUnverifiedSource: z.boolean().optional() });
export const requestApprovalBody = z.object({ acknowledgeUnverifiedSource: z.boolean().optional() });
export const rejectionBody = decisionBody.extend({ comment: z.string().trim().min(3, 'Give a reason for rejecting').max(2000) });
// expectedHash: the fingerprint the person executing was shown (currentHash). A request from an older view is refused.
export const executeBody = z.object({ confirmManual: z.boolean().optional(), notes: z.string().trim().max(2000).optional(), expectedHash: z.string().length(64).optional() });
// `attempt` is the failed attempt being retried, so a retry made from an older view cannot land on another one.
export const retryBody = z.object({ attempt: z.number().int().min(1) });
// What a person found on the target system for the latest attempt whose outcome is unknown.
// `attempt` is the attempt they looked at, so a decision cannot land on a newer one.
export const reconcileBody = z.object({ outcome: z.enum(['applied', 'not_applied', 'unknown']), notes: z.string().trim().min(3, 'Say what you checked').max(2000), attempt: z.number().int().min(1) });
/**
 * An edit changes only the fields it names. The risk is declared without a default on purpose:
 * `remediationInput.risk` defaults to MEDIUM, and a default survives `.partial()`, so an edit that
 * did not mention the risk used to set it to MEDIUM and with it lower the approvals needed.
 */
export const editBody = z
  .object({
    title: remediationInput.shape.title,
    description: remediationInput.shape.description,
    rationale: remediationInput.shape.rationale,
    risk: z.enum(RISK_LEVELS),
    serviceId: remediationInput.shape.serviceId,
    parameters: z.record(z.string(), z.unknown()),
  })
  .partial();

/** Used by users (HTTP) and by the investigation pipeline (AI proposals). */
export async function proposeRemediation(
  organizationId: string,
  input: z.infer<typeof remediationInput>,
  proposer: { type: 'user'; userId: string; label: string } | { type: 'ai_agent'; label: string },
  options: { timeline?: boolean } = {},
) {
  if (input.incidentId && !(await prisma.incident.findFirst({ where: { id: input.incidentId, organizationId }, select: { id: true } }))) throw badRequest('Incident does not exist');
  if (input.serviceId && !(await prisma.service.findFirst({ where: { id: input.serviceId, organizationId }, select: { id: true } }))) throw badRequest('Service does not exist');
  if (input.investigationId && !(await prisma.investigation.findFirst({ where: { id: input.investigationId, organizationId }, select: { id: true } }))) throw badRequest('Investigation does not exist');
  const settings = await getSettings(organizationId);
  const { effect, reasons } = await effectOf(organizationId, input);
  const risk = await effectiveRisk(organizationId, input.type, input.risk, input.serviceId, effect);
  const action = await prisma.remediationAction.create({
    data: {
      ...input,
      risk,
      effect,
      effectReasons: reasons,
      parameters: input.parameters as Prisma.InputJsonValue | undefined,
      organizationId,
      proposedByType: proposer.type,
      proposedById: proposer.type === 'user' ? proposer.userId : null,
      requiredApprovals: requiredApprovals(settings, risk, effect),
    },
  });
  if (action.incidentId && options.timeline !== false) {
    await addIncidentEvent(action.incidentId, 'remediation', `Remediation proposed: ${action.title}`, proposer.type === 'user' ? { kind: 'user', actorId: proposer.userId, label: proposer.label } : { kind: 'ai_agent', label: proposer.label }, { actionId: action.id, risk: action.risk });
  }
  return action;
}
