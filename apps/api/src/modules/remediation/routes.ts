import type { Prisma, RemediationAction } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../../lib/audit';
import { badRequest, conflict, forbidden } from '../../lib/errors';
import { csvEnum, paged, paginate, paginationQuery, param } from '../../lib/http';
import { notifyRoles, notifyUsers } from '../../lib/notify';
import { prisma } from '../../lib/prisma';
import { authOf, can, requirePermission, requireUser, userOf } from '../../middleware/auth';
import { addIncidentEvent } from '../incidents';
import { getSettings } from '../organization';
import { awaitMoreApprovals, invalidateApproval, isExpired, recordApproval, recordRejection, submitForApproval, supersedeApprovals, supersedeExpired, validApprovals } from './approvals';
import { approvalHash, contentHash } from './content';
import { approvalThreshold, effectOf, effectiveRisk, requiredApprovals } from './effect';
import { execute } from './execution';
import { detailInclude, load, present, presentMany } from './presenter';
import { decisionBody, editBody, executeBody, proposeRemediation, rejectionBody, remediationInput, requestApprovalBody, retryBody } from './proposals';
import { currentRisk, raiseRisk, requireSourceReview } from './safeguards';
import { sourceCheck, sourceMessage } from './source';
import { env } from '../../config/env';
import { recordEffects, recordOutcome } from './recording';

/** HTTP routes under /api/v1/remediations. Approve, execute, edit and retry are for signed-in people only (requireUser). */
export const remediationRouter = Router();

remediationRouter.get('/', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const q = paginationQuery.extend({ status: csvEnum(['PROPOSED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXECUTING', 'EXECUTED', 'FAILED', 'CANCELLED']), incidentId: z.string().optional(), investigationId: z.string().optional() }).parse(req.query);
  const where: Prisma.RemediationActionWhereInput = {
    organizationId,
    ...(q.status ? { status: { in: q.status } } : {}),
    ...(q.incidentId ? { incidentId: q.incidentId } : {}),
    ...(q.investigationId ? { investigationId: q.investigationId } : {}),
  };
  const [rows, total, counts, settings] = await Promise.all([
    prisma.remediationAction.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(q), include: detailInclude }),
    prisma.remediationAction.count({ where }),
    prisma.remediationAction.groupBy({ by: ['status'], where: { organizationId }, _count: true }),
    getSettings(organizationId),
  ]);
  res.json({
    ...paged(await presentMany(rows), total, q),
    statusCounts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
    executionMode: settings.remediationWebhookUrl ? 'webhook' : 'manual',
  });
});

remediationRouter.post('/', requirePermission('remediation:propose'), requireUser, async (req, res) => {
  const auth = userOf(req);
  const action = await proposeRemediation(auth.organizationId, remediationInput.parse(req.body), { type: 'user', userId: auth.userId, label: auth.label });
  await audit(req, 'remediation.propose', 'remediation_action', action.id, { title: action.title, type: action.type, risk: action.risk });
  res.status(201).json(await present(auth.organizationId, action.id));
});

remediationRouter.get('/:id', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const [view] = await presentMany([await load(organizationId, param(req.params.id))]);
  const settings = await getSettings(organizationId);
  res.json({ ...view, executionMode: settings.remediationWebhookUrl ? 'webhook' : 'manual', allowSelfApproval: settings.allowSelfApproval });
});

remediationRouter.post('/:id/request-approval', requirePermission('remediation:propose'), requireUser, async (req, res) => {
  const auth = userOf(req);
  const { acknowledgeUnverifiedSource } = requestApprovalBody.parse(req.body ?? {});
  let action = await load(auth.organizationId, param(req.params.id));
  if (action.status !== 'PROPOSED') throw conflict(`Only proposed actions can be submitted for approval (current status: ${action.status})`);
  if (action.effect === 'read_only') throw conflict('This is a read-only diagnostic: it needs no approval. Carry it out and record the result.');
  const settings = await getSettings(auth.organizationId);
  // The risk it is submitted at is what the action needs under the current rules, never less than stored.
  const risk = await currentRisk(action);
  if (risk !== action.risk) {
    await raiseRisk(req, auth, action, risk, settings);
    action = await load(auth.organizationId, action.id);
  }
  const source = await sourceCheck(action);
  const unverified = source.required && !source.verified;
  if (unverified && !acknowledgeUnverifiedSource) throw conflict(sourceMessage(source));
  const hash = approvalHash(action, unverified);
  if (!(await submitForApproval(action.id, auth.userId, requiredApprovals(settings, action.risk, 'state_changing'), hash))) throw conflict('This action was already submitted');
  await audit(req, 'remediation.request_approval', 'remediation_action', action.id, { risk: action.risk, contentHash: hash, sourceVerified: !unverified, ...(unverified ? { acknowledgedUnverifiedSource: true, sourceReasons: source.reasons } : {}) });
  if (action.incidentId) await addIncidentEvent(action.incidentId, 'remediation', `Approval requested for: ${action.title}`, auth, { actionId: action.id });
  await notifyRoles(action.risk === 'HIGH' ? ['OWNER', 'ADMIN'] : ['OWNER', 'ADMIN', 'ENGINEER'], { organizationId: auth.organizationId, type: 'remediation.approval_requested', title: `Approval needed: ${action.title}`, body: `${auth.label} requested approval for a ${action.risk.toLowerCase()}-risk action.`, link: `/remediation/${action.id}` }, auth.userId);
  res.json(await present(auth.organizationId, action.id));
});

remediationRouter.post('/:id/approve', requirePermission('remediation:approve'), requireUser, async (req, res) => {
  const auth = userOf(req);
  const { comment, expectedHash, acknowledgeUnverifiedSource } = decisionBody.parse(req.body ?? {});
  let action = await load(auth.organizationId, param(req.params.id));
  if (action.status !== 'PENDING_APPROVAL') throw conflict(`This action is not awaiting approval (current status: ${action.status})`);
  // Approvals past their validity stop counting here, so their approvers can decide again.
  const expired = await supersedeExpired(action.id);
  if (expired) {
    await audit(req, 'remediation.approval_expired', 'remediation_action', action.id, { superseded: expired, validityHours: env.REMEDIATION_APPROVAL_VALIDITY_HOURS, stage: 'approve' });
    action = await load(auth.organizationId, action.id);
  }
  const settings = await getSettings(auth.organizationId);
  const risk = await currentRisk(action);
  if (risk !== action.risk) {
    await raiseRisk(req, auth, action, risk, settings);
    throw conflict(`Under the current rules this action is ${risk.toLowerCase()} risk, not ${action.risk.toLowerCase()}. Its approvals no longer count; it must be submitted for approval again.`);
  }
  const source = await sourceCheck(action);
  const unverified = source.required && !source.verified;
  const hash = approvalHash(action, unverified);
  // Submitted while its AI source looked sound, and it no longer does: everyone reviews it again.
  if (unverified && action.contentHash === contentHash(action)) {
    await requireSourceReview(req, auth, action, source);
    throw conflict(sourceMessage(source));
  }
  if (hash !== action.contentHash || (expectedHash && expectedHash !== hash)) throw conflict('This action changed after it was submitted or after you opened it. Reload it and review what you are approving.');
  if (unverified && !acknowledgeUnverifiedSource) throw conflict(sourceMessage(source));
  if (action.risk === 'HIGH' && !can(auth, 'remediation:approve:high')) throw forbidden('High-risk actions must be approved by an admin or owner');
  if (!settings.allowSelfApproval && (action.requestedById === auth.userId || action.proposedById === auth.userId)) {
    throw forbidden('You cannot approve an action that you proposed or requested');
  }
  if (action.approvals.some((a) => a.approverId === auth.userId && !a.supersededAt)) throw conflict('You have already recorded a decision on this action');
  // The threshold is worked out from the risk as it is now, not read from the row alone.
  const required = approvalThreshold(settings, action);
  if (required !== action.requiredApprovals) await prisma.remediationAction.updateMany({ where: { id: action.id, status: 'PENDING_APPROVAL', contentHash: hash }, data: { requiredApprovals: required } });
  const result = await recordApproval({ id: action.id, requiredApprovals: required }, auth.userId, hash, comment);
  await audit(req, 'remediation.approve', 'remediation_action', action.id, { granted: result.granted, required, risk: action.risk, comment, contentHash: hash, sourceVerified: !unverified, ...(unverified ? { acknowledgedUnverifiedSource: true } : {}) });
  if (action.incidentId) await addIncidentEvent(action.incidentId, 'remediation', `${auth.label} approved: ${action.title} (${result.granted}/${required})`, auth, { actionId: action.id });
  if (result.approved) {
    await notifyUsers([action.requestedById], { organizationId: auth.organizationId, type: 'remediation.approved', title: `Approved: ${action.title}`, body: 'The action can now be executed.', link: `/remediation/${action.id}` });
  }
  res.json(await present(auth.organizationId, action.id));
});

remediationRouter.post('/:id/reject', requirePermission('remediation:approve'), requireUser, async (req, res) => {
  const auth = userOf(req);
  const { comment } = rejectionBody.parse(req.body ?? {});
  const action = await load(auth.organizationId, param(req.params.id));
  if (action.status !== 'PENDING_APPROVAL') throw conflict(`This action is not awaiting approval (current status: ${action.status})`);
  if (action.approvals.some((a) => a.approverId === auth.userId && !a.supersededAt)) throw conflict('You have already recorded a decision on this action');
  await recordRejection(action, auth.userId, comment);
  await audit(req, 'remediation.reject', 'remediation_action', action.id, { comment });
  if (action.incidentId) await addIncidentEvent(action.incidentId, 'remediation', `${auth.label} rejected: ${action.title} — ${comment}`, auth, { actionId: action.id });
  await notifyUsers([action.requestedById], { organizationId: auth.organizationId, type: 'remediation.rejected', title: `Rejected: ${action.title}`, body: comment, link: `/remediation/${action.id}` });
  res.json(await present(auth.organizationId, action.id));
});

remediationRouter.post('/:id/execute', requirePermission('remediation:execute'), requireUser, async (req, res) => {
  const auth = userOf(req);
  const body = executeBody.parse(req.body ?? {});
  const action = await load(auth.organizationId, param(req.params.id));
  const readOnly = action.effect === 'read_only';
  const hash = contentHash(action);
  // The effect is recomputed, not trusted from the row: text that now reads as state-changing is treated as such.
  const current = await effectOf(auth.organizationId, action);
  if (readOnly && current.effect !== 'read_only') {
    await prisma.remediationAction.update({ where: { id: action.id }, data: { effect: 'state_changing', effectReasons: current.reasons, requiredApprovals: Math.max(1, action.requiredApprovals) } });
    throw conflict('This action is no longer a read-only diagnostic and now needs approval.');
  }
  const settings = await getSettings(auth.organizationId);
  let approvers: { approverId: string; approvedAt: Date }[] = [];
  // The hash the counted approvals were given for: the content hash, or the review hash while the AI source is unverified.
  let approvedHash = hash;
  if (readOnly) {
    if (!['PROPOSED', 'APPROVED'].includes(action.status)) throw conflict(`This diagnostic cannot be recorded now (current status: ${action.status})`);
    if (!body.confirmManual) throw badRequest('A read-only diagnostic is carried out by a person. Do it, then confirm with confirmManual: true and your findings in notes.');
  } else {
    if (action.status !== 'APPROVED') throw conflict(`Only approved actions can be executed (current status: ${action.status})`);
    // An approval is never enough on its own: the action is held to the current rules here.
    const risk = await currentRisk(action);
    if (risk !== action.risk) {
      await raiseRisk(req, auth, action, risk, settings);
      throw conflict(`Under the current rules this action is ${risk.toLowerCase()} risk, not ${action.risk.toLowerCase()}. Its approvals no longer count; it must be submitted for approval again. Nothing was executed.`);
    }
    const source = await sourceCheck(action);
    const unverified = source.required && !source.verified;
    if (unverified && action.contentHash === hash) {
      await requireSourceReview(req, auth, action, source);
      throw conflict(`${sourceMessage(source)} Nothing was executed.`);
    }
    const expected = approvalHash(action, unverified);
    const now = new Date();
    const valid = validApprovals(action.approvals, expected, now);
    // Checked here independently of the APPROVED status: the approvals that count for this exact
    // content, against what its risk requires now.
    const required = Math.max(1, approvalThreshold(settings, action));
    const expiredHere = action.approvals.filter((a) => a.contentHash === expected && isExpired(a, now));
    if (expected === action.contentHash && valid.length < required && expiredHere.length) {
      // Approvals given for this content, but too long ago. They stay on record; the action waits for fresh ones.
      await supersedeExpired(action.id);
      if (!(await awaitMoreApprovals(action.id, expected, required))) await invalidateApproval(action.id);
      await audit(req, 'remediation.approval_expired', 'remediation_action', action.id, { expired: expiredHere.length, validApprovals: valid.length, required, validityHours: env.REMEDIATION_APPROVAL_VALIDITY_HOURS, stage: 'execute' });
      throw conflict(`${expiredHere.length} approval(s) of this action are older than ${env.REMEDIATION_APPROVAL_VALIDITY_HOURS} hours and no longer count. It is waiting for approval again; nothing was executed.`);
    }
    if (expected !== action.contentHash || !valid.length) {
      // The action is not what was approved. Its approvals no longer count and it starts again.
      await invalidateApproval(action.id);
      await audit(req, 'remediation.approval_invalid', 'remediation_action', action.id, { approvedHash: action.contentHash, currentHash: hash, validApprovals: valid.length, required });
      throw conflict('This action is not the one that was approved: its content changed afterwards. The approvals no longer count; submit it for approval again.');
    }
    if (valid.length < required) {
      // Same content, too few approvals. Those given still count; the action waits for the rest.
      if (!(await awaitMoreApprovals(action.id, expected, required))) await invalidateApproval(action.id);
      await audit(req, 'remediation.approval_insufficient', 'remediation_action', action.id, { contentHash: hash, risk: action.risk, validApprovals: valid.length, required, recorded: action.requiredApprovals });
      throw conflict(`This ${action.risk.toLowerCase()}-risk action needs ${required} approvals and has ${valid.length}. It is waiting for approval again; nothing was executed.`);
    }
    approvers = valid.map((a) => ({ approverId: a.approverId, approvedAt: a.createdAt }));
    approvedHash = expected;
    if (!settings.remediationWebhookUrl && !body.confirmManual) {
      throw badRequest('No remediation webhook is configured. Carry out the action yourself, then confirm with confirmManual: true.');
    }
  }
  // Claim the action atomically so it cannot be executed twice, and only with the content that was checked.
  const claimed = await prisma.remediationAction.updateMany({
    where: { id: action.id, status: action.status, ...(readOnly ? {} : { contentHash: approvedHash }) },
    data: { status: 'EXECUTING', executedById: auth.userId, attempts: { increment: 1 } },
  });
  if (!claimed.count) throw conflict('This action is already being executed');
  const mode = readOnly ? 'diagnostic' : settings.remediationWebhookUrl ? 'webhook' : 'manual';
  await audit(req, 'remediation.execute_start', 'remediation_action', action.id, { mode, effect: action.effect, contentHash: hash, attempt: action.attempts + 1, approvedBy: approvers.map((a) => a.approverId) });

  const startedAt = new Date();
  const result = await execute({ ...action, attempts: action.attempts + 1 }, { userId: auth.userId, label: auth.label }, approvers, body.notes);
  await recordOutcome(action.id, { ...result, contentHash: hash, attempt: action.attempts + 1, approvedBy: approvers, startedAt, finishedAt: new Date() });
  if (result.success && !readOnly) await recordEffects(action, auth, result);
  await audit(req, result.success ? 'remediation.execute_success' : 'remediation.execute_failure', 'remediation_action', action.id, { mode: result.mode, outcome: result.outcome, summary: result.summary, contentHash: hash });
  if (action.incidentId) {
    const what = result.success ? (readOnly ? 'Diagnostic recorded' : 'Remediation executed') : result.outcome === 'unknown' ? 'Remediation outcome unknown' : 'Remediation failed';
    await addIncidentEvent(action.incidentId, 'remediation', `${what}: ${action.title} — ${result.summary}`, auth, { actionId: action.id, mode: result.mode, outcome: result.outcome });
  }
  res.json(await present(auth.organizationId, action.id));
});

/**
 * Editing is allowed until execution starts. Any change to what an approver was shown supersedes
 * every approval and returns the action to PROPOSED: an approval never carries over to different content.
 */
remediationRouter.patch('/:id', requirePermission('remediation:propose'), requireUser, async (req, res) => {
  const auth = userOf(req);
  const patch = editBody.parse(req.body ?? {});
  const action = await load(auth.organizationId, param(req.params.id));
  if (!['PROPOSED', 'PENDING_APPROVAL', 'APPROVED'].includes(action.status)) throw conflict(`This action can no longer be edited (current status: ${action.status})`);
  if (patch.serviceId && !(await prisma.service.findFirst({ where: { id: patch.serviceId, organizationId: auth.organizationId }, select: { id: true } }))) throw badRequest('Service does not exist');
  // Only the fields the edit names change. In particular the risk stays what it was unless a new one is given.
  const next = { ...action, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as RemediationAction;
  const { effect, reasons } = await effectOf(auth.organizationId, next);
  // An explicit risk is still subject to the floor for what the action does.
  next.risk = await effectiveRisk(auth.organizationId, next.type, next.risk, next.serviceId, effect);
  const before = contentHash(action);
  const after = contentHash(next);
  const changed = before !== after;
  const settings = await getSettings(auth.organizationId);
  const superseded = changed ? action.approvals.filter((a) => !a.supersededAt).length : 0;
  const updated = await prisma.$transaction(async (tx) => {
    if (changed) await supersedeApprovals(action.id, tx);
    return tx.remediationAction.updateMany({
      where: { id: action.id, status: action.status },
      data: {
        title: next.title, description: next.description, rationale: next.rationale, risk: next.risk, serviceId: next.serviceId,
        parameters: (next.parameters ?? undefined) as Prisma.InputJsonValue | undefined,
        effect, effectReasons: reasons, requiredApprovals: requiredApprovals(settings, next.risk, effect),
        ...(changed ? { status: 'PROPOSED' as const, contentHash: null, requestedById: null, requestedAt: null } : {}),
      },
    });
  });
  if (!updated.count) throw conflict('This action changed state; reload and try again');
  await audit(req, 'remediation.edit', 'remediation_action', action.id, { fields: Object.keys(patch), previousHash: before, newHash: after, supersededApprovals: superseded, previousStatus: action.status, ...(next.risk !== action.risk ? { previousRisk: action.risk, newRisk: next.risk } : {}) });
  if (changed && action.incidentId) await addIncidentEvent(action.incidentId, 'remediation', `Remediation edited: ${next.title}${next.risk !== action.risk ? ` (risk ${action.risk.toLowerCase()} → ${next.risk.toLowerCase()})` : ''}${superseded ? ` (${superseded} approval(s) no longer count)` : ''}`, auth, { actionId: action.id });
  res.json(await present(auth.organizationId, action.id));
});

/**
 * A failed execution can be sent back for another attempt. The approvals still have to match the
 * content when it is executed again. If the last attempt's outcome is unknown (timeout, dropped
 * connection, server error), a human must first confirm that the change was NOT applied:
 * otherwise a retry could apply it a second time.
 */
remediationRouter.post('/:id/retry', requirePermission('remediation:execute'), requireUser, async (req, res) => {
  const auth = userOf(req);
  const body = retryBody.parse(req.body ?? {});
  const action = await load(auth.organizationId, param(req.params.id));
  if (action.status !== 'FAILED') throw conflict('Only failed actions can be retried');
  const last = (action.executionResult ?? {}) as { outcome?: string };
  const uncertain = last.outcome !== 'not_applied';
  if (uncertain && !body.confirmNotApplied) {
    throw conflict('The outcome of the last attempt is unknown: the change may have been applied. Check the target system, then retry with confirmNotApplied: true.');
  }
  const updated = await prisma.remediationAction.updateMany({ where: { id: action.id, organizationId: auth.organizationId, status: 'FAILED' }, data: { status: 'APPROVED' } });
  if (!updated.count) throw conflict('Only failed actions can be retried');
  await audit(req, 'remediation.retry', 'remediation_action', action.id, { previousOutcome: last.outcome ?? 'unknown', confirmedNotApplied: uncertain ? true : undefined, attempt: action.attempts });
  res.json(await present(auth.organizationId, param(req.params.id)));
});

remediationRouter.post('/:id/cancel', requirePermission('remediation:propose'), requireUser, async (req, res) => {
  const auth = userOf(req);
  const action = await load(auth.organizationId, param(req.params.id));
  if (!['PROPOSED', 'PENDING_APPROVAL', 'APPROVED'].includes(action.status)) throw conflict(`This action can no longer be cancelled (current status: ${action.status})`);
  const updated = await prisma.remediationAction.updateMany({ where: { id: action.id, status: action.status }, data: { status: 'CANCELLED' } });
  if (!updated.count) throw conflict('This action changed state; reload and try again');
  await audit(req, 'remediation.cancel', 'remediation_action', action.id);
  if (action.incidentId) await addIncidentEvent(action.incidentId, 'remediation', `Remediation cancelled: ${action.title}`, auth, { actionId: action.id });
  res.json(await present(auth.organizationId, action.id));
});
