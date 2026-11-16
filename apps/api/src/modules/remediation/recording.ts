import type { Prisma, RemediationAction } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import type { ExecutionResult } from './execution';

/** Recording what an execution attempt did: the outcome on the action, and its effect on the service's history. */

export interface ExecutionRecord extends ExecutionResult {
  contentHash: string;
  attempt: number;
  approvedBy: { approverId: string; approvedAt: Date }[];
  startedAt: Date;
  finishedAt: Date;
}

/**
 * EXECUTING → EXECUTED or FAILED, with the full record of the attempt, and only while this attempt
 * is still the one in progress. An outcome that arrives after the attempt was recorded as
 * interrupted, reconciled or retried does not overwrite that: it returns false, and the caller
 * puts it in the audit log for a person to reconcile.
 */
export async function recordOutcome(actionId: string, record: ExecutionRecord, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<boolean> {
  const { count } = await db.remediationAction.updateMany({ where: { id: actionId, status: 'EXECUTING', attempts: record.attempt }, data: { status: record.success ? 'EXECUTED' : 'FAILED', executedAt: new Date(), executionResult: record as unknown as Prisma.InputJsonValue } });
  return count > 0;
}

/** Mirrors an executed action onto the service's history so later investigations can see it. */
export async function recordEffects(action: RemediationAction, operator: { label: string }, result: Pick<ExecutionResult, 'mode'> & { reconciled?: boolean }) {
  if (!action.serviceId) return;
  const params = (action.parameters ?? {}) as Record<string, unknown>;
  const via = result.reconciled ? 'as recorded by a person reconciling an interrupted attempt' : result.mode === 'webhook' ? 'via remediation webhook' : 'manually';
  if (action.type === 'rollback_deployment') {
    const target = typeof params.deploymentId === 'string' ? await prisma.deployment.findFirst({ where: { id: params.deploymentId, organizationId: action.organizationId } }) : null;
    const toVersion = typeof params.toVersion === 'string' ? params.toVersion : null;
    if (target || toVersion) {
      await prisma.deployment.create({
        data: {
          organizationId: action.organizationId,
          serviceId: action.serviceId,
          version: toVersion ?? `rollback-of-${target!.version}`,
          environment: target?.environment ?? 'production',
          status: 'SUCCEEDED',
          isRollback: true,
          rollbackOfId: target?.id,
          deployedBy: operator.label,
          description: `Rollback executed ${via} from remediation "${action.title}"`,
          source: 'remediation',
          finishedAt: new Date(),
        },
      });
      if (target) await prisma.deployment.update({ where: { id: target.id }, data: { status: 'ROLLED_BACK' } });
      return;
    }
  }
  const typeMap: Record<string, string> = { restart_service: 'restart', scale_service: 'scaling', toggle_feature_flag: 'feature_flag', config_change: 'config_change', rollback_deployment: 'other', run_runbook: 'other', manual: 'other' };
  await prisma.serviceEvent.create({
    data: {
      organizationId: action.organizationId,
      serviceId: action.serviceId,
      type: typeMap[action.type] ?? 'other',
      title: `Remediation executed: ${action.title}`,
      details: `Executed ${via} by ${operator.label}.`,
      source: 'remediation',
      actor: operator.label,
      metadata: { actionId: action.id, parameters: params } as Prisma.InputJsonValue,
    },
  });
}
