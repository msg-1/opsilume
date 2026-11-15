import type { RiskLevel } from '@prisma/client';
import type { Request } from 'express';
import type { ActionEffect } from '../../lib/actionEffect';
import { audit } from '../../lib/audit';
import { prisma } from '../../lib/prisma';
import type { AuthContext } from '../../middleware/auth';
import { addIncidentEvent } from '../incidents';
import type { getSettings } from '../organization';
import { lockAction, supersedeApprovals } from './approvals';
import { effectiveRisk, requiredApprovals } from './effect';
import type { Detailed } from './presenter';
import type { SourceCheck } from './source';

/**
 * Checks made again whenever an action is submitted, approved or executed, so that an action
 * proposed or approved under earlier rules is held to the current ones. Each returns the action
 * to PROPOSED with its approvals kept on record and no longer counting; nothing is discarded.
 */

/** The risk the action must carry now: its stored risk, raised (never lowered) to the floor for what it does and where. */
export const currentRisk = (action: Detailed) => effectiveRisk(action.organizationId, action.type, action.risk, action.serviceId, action.effect as ActionEffect);

const restart = (action: Detailed, data: Record<string, unknown>) =>
  prisma.$transaction(async (tx) => {
    await lockAction(tx, action.id);
    await supersedeApprovals(action.id, tx);
    await tx.remediationAction.updateMany({ where: { id: action.id, status: action.status }, data: { ...data, status: 'PROPOSED', contentHash: null, requestedById: null, requestedAt: null } });
  });

/** The risk is part of what was approved: raising it means the approvals no longer cover the action. */
export async function raiseRisk(req: Request, auth: AuthContext, action: Detailed, risk: RiskLevel, settings: Awaited<ReturnType<typeof getSettings>>) {
  const superseded = action.approvals.filter((a) => !a.supersededAt).length;
  await restart(action, { risk, requiredApprovals: requiredApprovals(settings, risk, 'state_changing') });
  await audit(req, 'remediation.risk_raised', 'remediation_action', action.id, { previousRisk: action.risk, newRisk: risk, previousStatus: action.status, supersededApprovals: superseded });
  if (action.incidentId) await addIncidentEvent(action.incidentId, 'remediation', `Risk of "${action.title}" raised from ${action.risk.toLowerCase()} to ${risk.toLowerCase()} under the current rules${superseded ? `; ${superseded} approval(s) no longer count` : ''}`, auth, { actionId: action.id });
}

/** Sends an action back to PROPOSED with its approvals kept on record and no longer counting, and says why in the audit log. */
export async function requireFreshApproval(req: Request, auth: AuthContext, action: Detailed, auditAction: string, meta: Record<string, unknown>, timeline: string) {
  const superseded = action.approvals.filter((a) => !a.supersededAt).length;
  await restart(action, {});
  await audit(req, auditAction, 'remediation_action', action.id, { ...meta, previousStatus: action.status, supersededApprovals: superseded });
  if (action.incidentId) await addIncidentEvent(action.incidentId, 'remediation', timeline, auth, { actionId: action.id });
}

/** The approvals were given while the source looked sound, and it no longer does: they stop counting until people review it again. */
export async function requireSourceReview(req: Request, auth: AuthContext, action: Detailed, check: SourceCheck) {
  const superseded = action.approvals.filter((a) => !a.supersededAt).length;
  await restart(action, {});
  await audit(req, 'remediation.source_review_required', 'remediation_action', action.id, { reasons: check.reasons, previousStatus: action.status, supersededApprovals: superseded });
  if (action.incidentId) await addIncidentEvent(action.incidentId, 'remediation', `"${action.title}" needs a fresh review: the investigation behind it does not support a production change`, auth, { actionId: action.id });
}
