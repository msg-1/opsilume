import type { RiskLevel } from '@prisma/client';
import type { Request } from 'express';
import type { ActionEffect } from '../../lib/actionEffect';
import { audit } from '../../lib/audit';
import { prisma } from '../../lib/prisma';
import type { AuthContext } from '../../middleware/auth';
import { conflict } from '../../lib/errors';
import { addIncidentEvent } from '../incidents';
import type { getSettings } from '../organization';
import { lockAction, supersedeApprovals } from './approvals';
import { contentHash } from './content';
import { RISK_ORDER, effectiveRisk, requiredApprovals } from './effect';
import type { Detailed } from './presenter';
import type { SourceCheck } from './source';

/**
 * Checks made again whenever an action is submitted, approved or executed, so that an action
 * proposed or approved under earlier rules is held to the current ones. Each returns the action
 * to PROPOSED with its approvals kept on record and no longer counting; nothing is discarded.
 */

/** The risk the action must carry now: its stored risk, raised (never lowered) to the floor for what it does and where. */
export const currentRisk = (action: Detailed) => effectiveRisk(action.organizationId, action.type, action.risk, action.serviceId, action.effect as ActionEffect);

/**
 * Returns the action to PROPOSED and supersedes its approvals, as one transaction under the row
 * lock, and only if the action is still in the state it was read in and its content (fingerprint
 * of what it says, not only the stored approval hash, which a PROPOSED action does not have) is
 * still what the caller read. Otherwise nothing changes and it throws, so no caller ever audits a
 * transition that did not happen. A risk given is only ever raised from the current one. Returns
 * how many approvals were superseded and the risk before and after, as they were under the lock.
 */
const restart = (action: Detailed, raiseTo?: RiskLevel, minRequired = 0) =>
  prisma.$transaction(async (tx) => {
    const row = await lockAction(tx, action.id);
    const current = row && (await tx.remediationAction.findUnique({ where: { id: action.id } }));
    if (!row || !current || row.status !== action.status || row.contentHash !== action.contentHash || contentHash(current) !== contentHash(action)) {
      throw conflict('This action changed while it was being checked. Reload it and try again.');
    }
    const risk = raiseTo && RISK_ORDER.indexOf(raiseTo) > RISK_ORDER.indexOf(current.risk) ? raiseTo : current.risk;
    const { count } = await supersedeApprovals(action.id, tx);
    // The number of approvals needed never goes down (effect.ts, approvalThreshold).
    await tx.remediationAction.update({ where: { id: action.id }, data: { risk, requiredApprovals: Math.max(row.requiredApprovals, minRequired), status: 'PROPOSED', contentHash: null, requestedById: null, requestedAt: null } });
    return { superseded: count, previousRisk: current.risk, risk };
  });

/** The risk is part of what was approved: raising it means the approvals no longer cover the action. */
export async function raiseRisk(req: Request, auth: AuthContext, action: Detailed, risk: RiskLevel, settings: Awaited<ReturnType<typeof getSettings>>) {
  const applied = await restart(action, risk, requiredApprovals(settings, risk, 'state_changing'));
  // The risk as it was and became under the lock, not as this request read it.
  await audit(req, 'remediation.risk_raised', 'remediation_action', action.id, { previousRisk: applied.previousRisk, newRisk: applied.risk, previousStatus: action.status, supersededApprovals: applied.superseded });
  if (action.incidentId) await addIncidentEvent(action.incidentId, 'remediation', `Risk of "${action.title}" raised from ${applied.previousRisk.toLowerCase()} to ${applied.risk.toLowerCase()} under the current rules${applied.superseded ? `; ${applied.superseded} approval(s) no longer count` : ''}`, auth, { actionId: action.id });
}

/** Sends an action back to PROPOSED with its approvals kept on record and no longer counting, and says why in the audit log. */
export async function requireFreshApproval(req: Request, auth: AuthContext, action: Detailed, auditAction: string, meta: Record<string, unknown>, timeline: string) {
  const { superseded } = await restart(action);
  await audit(req, auditAction, 'remediation_action', action.id, { ...meta, previousStatus: action.status, supersededApprovals: superseded });
  if (action.incidentId) await addIncidentEvent(action.incidentId, 'remediation', timeline, auth, { actionId: action.id });
}

/** The approvals were given while the source looked sound, and it no longer does: they stop counting until people review it again. */
export async function requireSourceReview(req: Request, auth: AuthContext, action: Detailed, check: SourceCheck) {
  const { superseded } = await restart(action);
  await audit(req, 'remediation.source_review_required', 'remediation_action', action.id, { reasons: check.reasons, previousStatus: action.status, supersededApprovals: superseded });
  if (action.incidentId) await addIncidentEvent(action.incidentId, 'remediation', `"${action.title}" needs a fresh review: the investigation behind it does not support a production change`, auth, { actionId: action.id });
}
