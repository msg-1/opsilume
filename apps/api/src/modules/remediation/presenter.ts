import type { Prisma } from '@prisma/client';
import { notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { countsFor, isExpired, validApprovals } from './approvals';
import { approvalHash, contentHash } from './content';
import { sourceChecks } from './source';
import { type LegacyRead, legacyViews } from '../investigations/legacy';

/** Loading an action with its approvals, and the shape in which the API returns it. */

async function serviceNames(ids: (string | null)[]) {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  const rows = unique.length ? await prisma.service.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, slug: true } }) : [];
  return new Map(rows.map((r) => [r.id, r]));
}

async function userNames(ids: (string | null)[]) {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  const rows = unique.length ? await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } }) : [];
  return new Map(rows.map((r) => [r.id, r.name]));
}

export const detailInclude = {
  approvals: { orderBy: { createdAt: 'asc' } },
  incident: { select: { id: true, number: true, title: true, severity: true, status: true } },
  investigation: { select: { id: true, question: true, summary: true } },
} satisfies Prisma.RemediationActionInclude;

export type Detailed = Prisma.RemediationActionGetPayload<{ include: typeof detailInclude }>;

export async function presentMany(rows: Detailed[]) {
  const [services, users] = await Promise.all([
    serviceNames(rows.map((r) => r.serviceId)),
    userNames(rows.flatMap((r) => [r.proposedById, r.requestedById, r.executedById, ...r.approvals.map((a) => a.approverId)])),
  ]);
  const person = (id: string | null) => (id ? { id, name: users.get(id) ?? 'Unknown user' } : null);
  // An older stored report's summary is shown as a new one's would be (investigations/legacy.ts).
  const byOrganization = new Map<string, string[]>();
  for (const r of rows) if (r.investigation) (byOrganization.get(r.organizationId) ?? byOrganization.set(r.organizationId, []).get(r.organizationId)!).push(r.investigation.id);
  const views = new Map<string, LegacyRead>();
  for (const [organizationId, ids] of byOrganization) for (const [id, view] of await legacyViews(organizationId, ids)) views.set(id, view);
  const sources = await sourceChecks(rows);
  const now = new Date();
  return rows.map((r) => {
    const source = sources.get(r.id)!;
    // What approvals are bound to now (content.ts): an approver is shown this and sends it back.
    const hash = approvalHash(r, source.required && !source.verified);
    // Past the approval stage (executing, executed, rejected, cancelled), approvals are shown as
    // they counted then: for the hash that was approved, with no expiry since. A failed action can
    // be retried, and is checked again, so it is shown under the current rules.
    const live = ['PROPOSED', 'PENDING_APPROVAL', 'APPROVED', 'FAILED'].includes(r.status);
    const settled = r.contentHash ?? contentHash(r);
    const counted = (a: (typeof r.approvals)[number]) => (live ? countsFor(a, hash, now) : a.decision === 'approved' && !a.supersededAt && a.contentHash === settled);
    return {
    ...r,
    investigation: r.investigation && views.get(r.investigation.id)?.view ? { ...r.investigation, summary: views.get(r.investigation.id)!.view!.summary } : r.investigation,
    service: r.serviceId ? (services.get(r.serviceId) ?? null) : null,
    proposedBy: r.proposedByType === 'ai_agent' ? { id: null, name: 'OPSILUME AI' } : person(r.proposedById),
    requestedBy: person(r.requestedById),
    executedBy: person(r.executedById),
    // An approval counts only for the content it was given for, within its validity, once per approver.
    approvals: r.approvals.map((a) => ({ ...a, approver: person(a.approverId), counts: counted(a), expired: live && isExpired(a, now) })),
    approvalsGranted: live ? validApprovals(r.approvals, hash, now).length : new Set(r.approvals.filter(counted).map((a) => a.approverId)).size,
    currentHash: hash,
    sourceReview: source,
    };
  });
}

export async function load(organizationId: string, id: string) {
  const action = await prisma.remediationAction.findFirst({ where: { id, organizationId }, include: detailInclude });
  if (!action) throw notFound('Remediation action');
  return action;
}

/** One action as the API returns it. */
export const present = async (organizationId: string, id: string) => (await presentMany([await load(organizationId, id)]))[0];
