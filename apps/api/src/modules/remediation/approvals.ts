import type { Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { conflict } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { type Content, contentHash } from './content';
import { requiredApprovals as requiredFor } from './effect';

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

// Approvals are timestamped by the database. One dated further ahead than this is not believed.
const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * The database's clock. Approvals are timestamped by it, so their expiry is judged by it too:
 * moving the API server's clock back cannot make an expired approval count again. An approval
 * that was found expired is superseded and never counts again, whatever any clock says later.
 */
export async function databaseNow(db: Prisma.TransactionClient | typeof prisma = prisma): Promise<Date> {
  const [row] = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return row!.now;
}

/** An approval that would count but is older than the validity window. */
export const isExpired = (approval: ApprovalRow, now = new Date()) => approval.decision === 'approved' && !approval.supersededAt && approval.createdAt < approvalCutoff(now);

/** Whether an approval counts for `hash`, the hash approvals of the action are bound to now (approvalHash). */
export function countsFor(approval: ApprovalRow, hash: string, now = new Date()) {
  return approval.decision === 'approved' && !approval.supersededAt && approval.contentHash === hash && approval.createdAt >= approvalCutoff(now) && approval.createdAt.getTime() <= now.getTime() + CLOCK_SKEW_MS;
}

/** The approvals that count for the action as it is now, one per approver. */
export function validApprovals<A extends ApprovalRow>(approvals: A[], hash: string, now = new Date()): A[] {
  const seen = new Set<string>();
  return approvals.filter((a) => countsFor(a, hash, now) && !seen.has(a.approverId) && seen.add(a.approverId));
}

/**
 * Locks an action's row for the rest of the transaction. Lock order: the action's row first, then
 * its approvals. Every operation that records a decision (approve, reject), supersedes approvals
 * (edit, expiry, invalidation, sending back for review) or submits takes this lock first, and acts
 * only if the action is still in the state it read; nothing locks approvals before the action.
 * Execution claims the action with one conditional update of the same row.
 */
export async function lockAction(tx: Prisma.TransactionClient, actionId: string) {
  const rows = await tx.$queryRaw<{ status: string; contentHash: string | null; requiredApprovals: number; requestedById: string | null }[]>`SELECT status, "contentHash", "requiredApprovals", "requestedById" FROM "RemediationAction" WHERE id = ${actionId} FOR UPDATE`;
  return rows[0] ?? null;
}

/**
 * PROPOSED → PENDING_APPROVAL, recording the hash that is being put up for approval. The status
 * is part of the condition, so a concurrent request cannot submit the same action twice. The
 * number of approvals needed never goes down: it is what the current settings require, or what
 * the action already required, whichever is more. Returns false when it was already submitted.
 */
export async function submitForApproval(actionId: string, requestedById: string, requiredApprovals: number, hash: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const row = await lockAction(tx, actionId);
    if (row?.status !== 'PROPOSED') return false;
    await tx.remediationAction.update({ where: { id: actionId }, data: { status: 'PENDING_APPROVAL', requestedById, requestedAt: new Date(), requiredApprovals: Math.max(row.requiredApprovals, requiredApprovals), contentHash: hash } });
    return true;
  });
}

/**
 * Records an approval for exactly this hash; the action becomes APPROVED once enough count, and
 * only while its content is still that hash. `action.requiredApprovals` is what the current
 * settings require; under the lock it is raised to the stored number if that is higher, and the
 * stored number is raised to it, never lowered. Returns the number actually applied.
 */
export function recordApproval(action: { id: string; requiredApprovals: number }, approverId: string, hash: string, comment?: string) {
  return prisma.$transaction(async (tx) => {
    // Under the lock: still awaiting approval, still bound to the hash the approver was shown.
    const row = await lockAction(tx, action.id);
    if (!row || row.status !== 'PENDING_APPROVAL' || row.contentHash !== hash) throw conflict('This action changed while you were approving it. Reload it and review what you are approving.');
    const required = Math.max(row.requiredApprovals, action.requiredApprovals);
    if (required !== row.requiredApprovals) await tx.remediationAction.update({ where: { id: action.id }, data: { requiredApprovals: required } });
    await tx.approval.create({ data: { actionId: action.id, approverId, decision: 'approved', comment, contentHash: hash } });
    // Distinct approvers: two concurrent decisions by one person count once.
    const now = await databaseNow(tx);
    const granted = (await tx.approval.findMany({ where: { actionId: action.id, decision: 'approved', supersededAt: null, contentHash: hash, createdAt: { gte: approvalCutoff(now), lte: new Date(now.getTime() + CLOCK_SKEW_MS) } }, select: { approverId: true }, distinct: ['approverId'] })).length;
    if (granted >= required) await tx.remediationAction.update({ where: { id: action.id }, data: { status: 'APPROVED' } });
    return { granted, required, approved: granted >= required };
  });
}

/** PENDING_APPROVAL → REJECTED, under the lock: refused if the action moved on or changed since the rejecter read it. */
export function recordRejection(action: Content & { id: string; contentHash: string | null }, approverId: string, comment: string) {
  return prisma.$transaction(async (tx) => {
    const row = await lockAction(tx, action.id);
    if (!row || row.status !== 'PENDING_APPROVAL' || row.contentHash !== action.contentHash) throw conflict('This action changed while you were rejecting it. Reload it and review what you are rejecting.');
    await tx.approval.create({ data: { actionId: action.id, approverId, decision: 'rejected', comment, contentHash: contentHash(action) } });
    await tx.remediationAction.update({ where: { id: action.id }, data: { status: 'REJECTED' } });
  });
}

/**
 * Marks approvals older than the validity window as superseded, so they stop counting and their
 * approvers can decide again; only while the action is still in `status` (an action that moved on,
 * to execution for example, keeps its approvals as they were). Returns how many, and their times.
 */
export function supersedeExpired(actionId: string, status: 'PENDING_APPROVAL' | 'APPROVED'): Promise<{ count: number; approvedAt: string[]; cutoff: string }> {
  return prisma.$transaction(async (tx) => {
    const row = await lockAction(tx, actionId);
    const cutoff = approvalCutoff(await databaseNow(tx));
    if (row?.status !== status) return { count: 0, approvedAt: [], cutoff: cutoff.toISOString() };
    const where = { actionId, decision: 'approved', supersededAt: null, createdAt: { lt: cutoff } };
    const expired = await tx.approval.findMany({ where, select: { createdAt: true } });
    const { count } = await tx.approval.updateMany({ where, data: { supersededAt: new Date() } });
    return { count, approvedAt: expired.map((a) => a.createdAt.toISOString()), cutoff: cutoff.toISOString() };
  });
}

/** Marks every current approval of an action as no longer counting. Usable inside a transaction. */
export const supersedeApprovals = (actionId: string, db: Prisma.TransactionClient | typeof prisma = prisma) =>
  db.approval.updateMany({ where: { actionId, supersededAt: null }, data: { supersededAt: new Date() } });

/**
 * The action is not what was approved: its approvals stop counting and it starts again from
 * PROPOSED. Only while it is still APPROVED; returns false, having changed nothing, otherwise.
 */
export function invalidateApproval(actionId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    if ((await lockAction(tx, actionId))?.status !== 'APPROVED') return false;
    await supersedeApprovals(actionId, tx);
    await tx.remediationAction.update({ where: { id: actionId }, data: { status: 'PROPOSED', contentHash: null } });
    return true;
  });
}

/**
 * The content is what was approved, but too few approvals count for it (the threshold was raised,
 * or the stored number was wrong). The approvals given stay valid and the action goes back to
 * waiting for the rest, needing the higher of `required` and what it already needed. Under the
 * lock. Returns the number applied, or null when it could not (no requester on record, or it moved on).
 */
export function awaitMoreApprovals(actionId: string, hash: string, required: number): Promise<number | null> {
  return prisma.$transaction(async (tx) => {
    const row = await lockAction(tx, actionId);
    if (!row || row.status !== 'APPROVED' || row.contentHash !== hash || !row.requestedById) return null;
    const applied = Math.max(row.requiredApprovals, required);
    await tx.remediationAction.update({ where: { id: actionId }, data: { status: 'PENDING_APPROVAL', requiredApprovals: applied } });
    return applied;
  });
}

/** Raises an action's required approvals to at least `required`, atomically: never lowers it. */
export const raiseRequiredApprovals = (actionId: string, required: number) =>
  prisma.$executeRaw`UPDATE "RemediationAction" SET "requiredApprovals" = GREATEST("requiredApprovals", ${required}) WHERE id = ${actionId}`;

export type Claim =
  | { claimed: true; approvers: { approverId: string; approvedAt: Date }[] }
  | { claimed: false; reason: 'moved_on' }
  | { claimed: false; reason: 'insufficient'; required: number; valid: number; newStatus: 'PENDING_APPROVAL' | 'PROPOSED' };

/**
 * Claims an action for execution, as one transaction under the row lock. For a production change
 * (`hash` given) the approvals are counted again here, against the higher of what the action
 * needs and what the organisation's settings require now; the settings row is share-locked, so a
 * change to the thresholds either commits before this check or waits for the claim. If too few
 * approvals count, nothing is claimed and the action goes back to waiting for approvals (or to
 * PROPOSED when it has no requester), its approvals left as they are. A read-only diagnostic
 * (`hash` null) is claimed on its status alone.
 */
export function claimExecution(actionId: string, organizationId: string, status: string, hash: string | null, executedById: string): Promise<Claim> {
  return prisma.$transaction(async (tx) => {
    const row = await lockAction(tx, actionId);
    if (!row || row.status !== status || (hash !== null && row.contentHash !== hash)) return { claimed: false, reason: 'moved_on' } as const;
    let approvers: { approverId: string; approvedAt: Date }[] = [];
    if (hash !== null) {
      const [settings] = await tx.$queryRaw<{ approvalsLowRisk: number; approvalsMediumRisk: number; approvalsHighRisk: number }[]>`
        SELECT "approvalsLowRisk", "approvalsMediumRisk", "approvalsHighRisk" FROM "OrganizationSettings" WHERE "organizationId" = ${organizationId} FOR SHARE`;
      const action = await tx.remediationAction.findUniqueOrThrow({ where: { id: actionId }, select: { risk: true, approvals: true } });
      const required = Math.max(1, row.requiredApprovals, settings ? requiredFor(settings as Parameters<typeof requiredFor>[0], action.risk, 'state_changing') : 1);
      const valid = validApprovals(action.approvals, hash, await databaseNow(tx));
      if (valid.length < required) {
        if (row.requestedById) {
          await tx.remediationAction.update({ where: { id: actionId }, data: { status: 'PENDING_APPROVAL', requiredApprovals: required } });
          return { claimed: false, reason: 'insufficient', required, valid: valid.length, newStatus: 'PENDING_APPROVAL' } as const;
        }
        await supersedeApprovals(actionId, tx);
        await tx.remediationAction.update({ where: { id: actionId }, data: { status: 'PROPOSED', contentHash: null, requiredApprovals: required } });
        return { claimed: false, reason: 'insufficient', required, valid: valid.length, newStatus: 'PROPOSED' } as const;
      }
      approvers = valid.map((a) => ({ approverId: a.approverId, approvedAt: a.createdAt }));
    }
    await tx.remediationAction.update({ where: { id: actionId }, data: { status: 'EXECUTING', executedById, attempts: { increment: 1 } } });
    return { claimed: true, approvers } as const;
  });
}
