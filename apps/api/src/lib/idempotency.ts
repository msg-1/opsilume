import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { env } from '../config/env';
import { authOf } from '../middleware/auth';
import { AppError, badRequest } from './errors';
import { prisma } from './prisma';

/**
 * Idempotent ingestion. A client that did not get an answer cannot know whether its batch was
 * stored, so it sends it again; without help that stores it twice. A request may therefore
 * carry an `Idempotency-Key` header. The first request with a key stores its data and records
 * the key **in the same database transaction**, so the two cannot disagree: either both are
 * there or neither is. A later request with the same key and the same body is answered with
 * the stored response and stores nothing.
 *
 *   - Without the header nothing changes: every request is stored, as before. Two requests
 *     with the same content and no key (or different keys) are two sets of telemetry.
 *   - The same key with a different body is refused (422): it is a client bug, and guessing
 *     which body was meant would lose data either way.
 *   - Two requests with the same key at the same moment: the database lets one insert the key
 *     and makes the other wait for it; the second then finds the stored response.
 *   - A request that fails (validation, unknown service, an outage) records no key, so the
 *     corrected or repeated request is processed normally.
 *   - Keys belong to one organisation and one endpoint, and are forgotten after
 *     INGEST_IDEMPOTENCY_TTL_HOURS (24). A retry after that is a new request.
 */

export type IngestionScope = 'logs' | 'metrics' | 'deployments' | 'events';
export type Db = Prisma.TransactionClient | typeof prisma;

const KEY = /^[A-Za-z0-9._:-]{8,128}$/;
export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const REPLAY_HEADER = 'Idempotent-Replayed';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  return value ?? null;
}
/** The body by content: key order and whitespace do not matter, values do. */
export const payloadHash = (body: unknown) => createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/**
 * Runs `store` once per (organisation, scope, key). `store` must do all its writes through the
 * client it is given, and return what the response body will be. Returns that body, and
 * whether it came from an earlier request.
 */
export async function withIdempotency<T>(req: Request, scope: IngestionScope, store: (db: Db) => Promise<T>): Promise<{ value: T; replayed: boolean }> {
  const { organizationId } = authOf(req);
  const key = req.header(IDEMPOTENCY_HEADER);
  if (key === undefined) return { value: await store(prisma), replayed: false };
  if (!KEY.test(key)) throw badRequest('Idempotency-Key must be 8 to 128 characters from: letters, digits, dot, underscore, colon, hyphen');
  const hash = payloadHash(req.body);
  const id = { organizationId_scope_key: { organizationId, scope, key } };
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = new Date();
    try {
      const value = await prisma.$transaction(
        async (tx) => {
          // A key that has expired is free again.
          await tx.ingestionRequest.deleteMany({ where: { organizationId, scope, key, expiresAt: { lt: now } } });
          // If another request holds this key in a transaction that has not finished, this waits
          // for it, and then fails with a unique violation if that one committed.
          await tx.ingestionRequest.create({ data: { organizationId, scope, key, payloadHash: hash, responseBody: {}, expiresAt: new Date(now.getTime() + env.INGEST_IDEMPOTENCY_TTL_HOURS * 3_600_000) } });
          const result = await store(tx);
          await tx.ingestionRequest.update({ where: id, data: { responseBody: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue } });
          return result;
        },
        { timeout: 30_000, maxWait: 10_000 },
      );
      return { value, replayed: false };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const earlier = await prisma.ingestionRequest.findUnique({ where: id });
      // Gone again (the other request failed and rolled back) or expired in the meantime: start over.
      if (!earlier || earlier.expiresAt < new Date()) continue;
      if (earlier.payloadHash !== hash) {
        throw new AppError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used with a different request body. Nothing was stored. Use a new key for a new request, and the same key only to repeat the same request.');
      }
      return { value: earlier.responseBody as T, replayed: true };
    }
  }
  throw new AppError(409, 'idempotency_conflict', 'Another request with this Idempotency-Key is being processed. Repeat the request in a moment.');
}

/** Removes keys that have expired. Run with the hourly retention job. */
export const purgeExpiredIdempotencyKeys = (now = new Date()) => prisma.ingestionRequest.deleteMany({ where: { expiresAt: { lt: now } } }).then((r) => r.count);
