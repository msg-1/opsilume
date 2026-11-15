import type { Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { conflict } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { type Content, contentHash } from './content';

/**
 * Approval management. An approval counts only for the content it was given for, and only
 * until that content changes: editing an action supersedes its approvals, and so does finding,
 * at execution, that the action is not the one that was approved. An approval also counts only
 * for a limited time (REMEDIATION_APPROVAL_VALIDITY_HOURS), and each approver counts once.
 * Superseded and expired approvals stay on record.
 */

type ApprovalRow = { approverId: string; decision: string; contentHash: string | null; supersededAt: Date | null; createdAt: Date };

/** The moment before which an approval no longer counts. */
export const approvalCutoff = (now = new Date()) => new Date(now.getTime() - env.REMEDIATION_APPROVAL_VALIDITY_HOURS * 3_600_000);

/** An approval that would count but is older than the validity window. */
export const isExpired = (approval: ApprovalRow, now = new Date()) => approval.decision === 'approved' && !approval.supersededAt && approval.createdAt < approvalCutoff(now);

/** Whether an approval counts for `hash`, the hash approvals of the action are bound to now (approvalHash). */
export function countsFor(approval: ApprovalRow, hash: string, now = new Date()) {
  return approval.decision === 'approved' && !approval.supersededAt && approval.contentHash === hash && approval.createdAt >= approvalCutoff(now);
}

/** The approvals that count for the action as it is now, one per approver. */
export function validApprovals<A extends ApprovalRow>(approvals: A[], hash: string, now = new Date()): A[] {
  const seen = new Set<string>();
  return approvals.filter((a) => countsFor(a, hash, now) && !seen.has(a.approverId) && seen.add(a.approverId));
}

/**
 * PROPOSED → PENDING_APPROVAL, recording the hash that is being put up for approval. The status
 * is part of the condition, so a concurrent request cannot submit the same action twice.
 * Returns false when it was already submitted.
 */
export async function submitForApproval(actionId: string, requestedById: string, requiredApprovals: number, hash: string): Promise<boolean> {
  const updated = await prisma.remediationAction.updateMany({
    where: { id: actionId, status: 'PROPOSED' },
    data: { status: 'PENDING_APPROVAL', requestedById, requestedAt: new Date(), requiredApprovals, contentHash: hash },
  });
  return updated.count > 0;
}

/**
 * Locks an action's row for the rest of the transaction. Everything that adds approvals or
 * supersedes them takes this lock first, so an approval cannot be recorded for content that an
 * edit is replacing at the same moment, and an edit cannot miss an approval being recorded.
 */
export async function lockAction(tx: Prisma.TransactionClient, actionId: string) {
  const rows = await tx.$queryRaw<{ status: string; contentHash: string | null }[]>`SELECT status, "contentHash" FROM "RemediationAction" WHERE id = ${actionId} FOR UPDATE`;
  return rows[0] ?? null;
}

/** Records an approval for exactly this hash; the action becomes APPROVED once enough count, and only while its content is still that hash. */
export function recordApproval(action: { id: string; requiredApprovals: number }, approverId: string, hash: string, comment?: string) {
  return prisma.$transaction(async (tx) => {
    // Under the lock: still awaiting approval, still bound to the hash the approver was shown.
    const row = await lockAction(tx, action.id);
    if (!row || row.status !== 'PENDING_APPROVAL' || row.contentHash !== hash) throw conflict('This action changed while you were approving it. Reload it and review what you are approving.');
    await tx.approval.create({ data: { actionId: action.id, approverId, decision: 'approved', comment, contentHash: hash } });
    // Distinct approvers: two concurrent decisions by one person count once.
    const granted = (await tx.approval.findMany({ where: { actionId: action.id, decision: 'approved', supersededAt: null, contentHash: hash, createdAt: { gte: approvalCutoff() } }, select: { approverId: true }, distinct: ['approverId'] })).length;
    if (granted >= action.requiredApprovals) {
      // Only while the content is still what was approved.
      await tx.remediationAction.updateMany({ where: { id: action.id, status: 'PENDING_APPROVAL', contentHash: hash }, data: { status: 'APPROVED' } });
    }
    return { granted, approved: granted >= action.requiredApprovals };
  });
}

export function recordRejection(action: Content & { id: string }, approverId: string, comment: string) {
  return prisma.$transaction([
    prisma.approval.create({ data: { actionId: action.id, approverId, decision: 'rejected', comment, contentHash: contentHash(action) } }),
    prisma.remediationAction.updateMany({ where: { id: action.id, status: 'PENDING_APPROVAL' }, data: { status: 'REJECTED' } }),
  ]);
}

/** Marks approvals older than the validity window as superseded, so they stop counting and their approvers can decide again. Returns how many. */
export async function supersedeExpired(actionId: string): Promise<number> {
  const { count } = await prisma.approval.updateMany({ where: { actionId, decision: 'approved', supersededAt: null, createdAt: { lt: approvalCutoff() } }, data: { supersededAt: new Date() } });
  return count;
}

/** Marks every current approval of an action as no longer counting. Usable inside a transaction. */
export const supersedeApprovals = (actionId: string, db: Prisma.TransactionClient | typeof prisma = prisma) =>
  db.approval.updateMany({ where: { actionId, supersededAt: null }, data: { supersededAt: new Date() } });

/** The action is not what was approved: its approvals stop counting and it starts again from PROPOSED. */
export function invalidateApproval(actionId: string) {
  return prisma.$transaction(async (tx) => {
    await lockAction(tx, actionId);
    await supersedeApprovals(actionId, tx);
    await tx.remediationAction.updateMany({ where: { id: actionId, status: 'APPROVED' }, data: { status: 'PROPOSED', contentHash: null } });
  });
}

/**
 * The content is what was approved, but too few approvals count for it (the threshold was raised,
 * or the stored number was wrong). The approvals given stay valid and the action goes back to
 * waiting for the rest. Returns false when it could not (no requester on record, or it moved on).
 */
export async function awaitMoreApprovals(actionId: string, hash: string, required: number): Promise<boolean> {
  const updated = await prisma.remediationAction.updateMany({
    where: { id: actionId, status: 'APPROVED', contentHash: hash, requestedById: { not: null } },
    data: { status: 'PENDING_APPROVAL', requiredApprovals: required },
  });
  return updated.count > 0;
}
