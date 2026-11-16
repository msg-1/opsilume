import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { AuthContext } from '../middleware/auth';
import { logger } from './logger';
import { prisma } from './prisma';

export interface AuditInput {
  organizationId: string;
  actorType: 'user' | 'api_key' | 'ai_agent' | 'system';
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Prisma.InputJsonValue;
  ip?: string | null;
}

/** Appends to the audit trail. Audit failures are logged but never fail the request. */
export async function writeAudit(entry: AuditInput, db: Pick<typeof prisma, 'auditLog'> = prisma) {
  try {
    await db.auditLog.create({ data: entry });
  } catch (err) {
    logger.error({ err, action: entry.action }, 'failed to write audit log');
  }
}

const actorTypeOf = (auth: AuthContext): AuditInput['actorType'] =>
  auth.kind === 'user' ? 'user' : auth.kind === 'api_key' ? 'api_key' : 'ai_agent';

/** The audit row for this request, or null when it is not authenticated. */
export function auditEntry(req: Request, action: string, resourceType: string, resourceId?: string | null, metadata?: Prisma.InputJsonValue): AuditInput | null {
  const auth = req.auth;
  if (!auth) return null;
  return { organizationId: auth.organizationId, actorType: actorTypeOf(auth), actorId: auth.actorId, actorLabel: auth.label, action, resourceType, resourceId, metadata, ip: req.ip };
}

/** Best-effort audit of a request: written on its own, after the change it records (see writeAudit). */
export function audit(req: Request, action: string, resourceType: string, resourceId?: string | null, metadata?: Prisma.InputJsonValue) {
  const entry = auditEntry(req, action, resourceType, resourceId, metadata);
  return entry ? writeAudit(entry) : Promise.resolve();
}

/**
 * Durable audit: written with the caller's transaction client, so the row commits with the change
 * it records or not at all. A failed insert is not caught: PostgreSQL has aborted the transaction,
 * the error reaches its owner and the change rolls back. Never open a transaction here.
 */
export async function auditIn(tx: Prisma.TransactionClient, entry: AuditInput | null) {
  if (entry) await tx.auditLog.create({ data: entry });
}
