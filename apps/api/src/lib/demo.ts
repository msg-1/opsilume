import type { Prisma } from '@prisma/client';
import { env } from '../config/env';
import type { AuthContext } from '../middleware/auth';
import { AppError } from './errors';
import type { Permission } from './permissions';

/**
 * Public demonstration mode (PUBLIC_DEMO_MODE=true; off by default). See docs/deployment/PUBLIC_DEMO_MODE.md.
 *
 * A visitor signs in through POST /api/v1/auth/demo, never with a password, as one dedicated account
 * that is a VIEWER member of the demonstration organisation only. Every restriction below is enforced
 * by the API; the web app only reflects it.
 */

/** The shared visitor account. Its password is random and never published or used. */
export const DEMO_VISITOR_EMAIL = 'visitor@demo.opsilume.invalid';
export const DEMO_VISITOR_NAME = 'Demo visitor';

/**
 * The password of the locally seeded demo accounts (`npm run db:seed`). It is public knowledge, so a
 * public demonstration refuses any sign-in with it.
 */
export const DEMO_PASSWORD = 'Opsilume-demo-1';

/** All a visitor may do, whatever its membership role says: read, and start a bounded investigation. */
export const VISITOR_PERMISSIONS: readonly Permission[] = ['read', 'investigation:run'];

/** The only requests a visitor may make that are not reads. Anything else is refused before it reaches a route. */
const VISITOR_WRITES: [method: string, path: RegExp][] = [
  ['POST', /^\/api\/v1\/investigations$/],
  ['POST', /^\/api\/v1\/investigations\/[^/]+\/cancel$/],
  ['POST', /^\/api\/v1\/knowledge\/search$/],
  ['POST', /^\/api\/v1\/notifications\/read$/],
];

export function visitorMayRequest(method: string, originalUrl: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') return true;
  const path = originalUrl.split(/[?#]/)[0]!.replace(/\/+$/, '');
  return VISITOR_WRITES.some(([wm, re]) => wm === m && re.test(path));
}

/**
 * Investigations a visitor may see: those no visitor started (the seeded ones) and its own session's.
 * Every visitor is the same account, so the session, not the user, is what owns a visitor's run.
 */
export function visibleInvestigations(auth: AuthContext): Prisma.InvestigationWhereInput {
  if (!auth.demoVisitor) return {};
  return { OR: [{ demoSessionId: null }, ...(auth.demoSession ? [{ demoSessionId: auth.demoSession }] : [])] };
}

/** Remediation actions a visitor may see: those not proposed by another visitor session's investigation. */
export function visibleRemediations(auth: AuthContext): Prisma.RemediationActionWhereInput {
  if (!auth.demoVisitor) return {};
  return { OR: [{ investigationId: null }, { investigation: { is: visibleInvestigations(auth) } }] };
}

/**
 * The visitor's own limits, checked inside the transaction that creates the investigation (under the
 * organisation's lock, so parallel requests cannot all pass). A new session is one click away, so the
 * per-session limit only paces one visitor; the per-address limits and the organisation's daily and
 * concurrency limits (investigations/limits.ts) are what bound the demo as a whole.
 */
export async function assertVisitorQuota(db: Prisma.TransactionClient, auth: AuthContext, address: string | undefined) {
  if (!auth.demoSession) throw new AppError(403, 'demo_session_required', 'Enter the demo again to run an investigation.');
  const refuse = (message: string) => new AppError(429, 'limit_reached', message);
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  // The addresses this request and this session have been seen from (a session records its address when it
  // is entered and at each refresh), and every visitor session seen from any of them today. Entering sessions
  // from one address and using them from another therefore does not escape the per-address limits.
  const seen = await db.refreshToken.findMany({ where: { demoSessionId: auth.demoSession, ip: { not: null } }, distinct: ['ip'], select: { ip: true } });
  const addresses = [...new Set([...(address ? [address] : []), ...seen.map((s) => s.ip!)])];
  const linked = (await db.refreshToken.findMany({ where: { ip: { in: addresses }, demoSessionId: { not: null }, createdAt: { gte: since } }, distinct: ['demoSessionId'], select: { demoSessionId: true } })).map((s) => s.demoSessionId!);
  const sessions = [...new Set([auth.demoSession, ...linked])];
  const where = { organizationId: auth.organizationId };
  const [session, today, running] = await Promise.all([
    db.investigation.count({ where: { ...where, demoSessionId: auth.demoSession } }),
    db.investigation.count({ where: { ...where, demoSessionId: { in: sessions }, createdAt: { gte: since } } }),
    db.investigation.count({ where: { ...where, demoSessionId: { in: sessions }, status: { in: ['QUEUED', 'RUNNING'] } } }),
  ]);
  if (running >= 1) throw refuse('One of your investigations is still running. Wait for it to finish.');
  if (session >= env.DEMO_SESSION_INVESTIGATION_LIMIT) throw refuse(`This demo session has run its ${env.DEMO_SESSION_INVESTIGATION_LIMIT} investigations.`);
  if (today >= env.DEMO_ADDRESS_DAILY_INVESTIGATION_LIMIT) throw refuse(`The daily limit of ${env.DEMO_ADDRESS_DAILY_INVESTIGATION_LIMIT} demo investigations from your address has been reached. It resets at midnight UTC.`);
}

/**
 * Failure texts this codebase writes in its own words (runner, aiService, stream). Anything else, such as
 * an upstream body, an exception's text or an internal address, is shown to a visitor as VISITOR_FAILURE.
 */
const OWN_FAILURES = [
  /^The investigation did not finish within [\w .]+ and was stopped\. No conclusions were recorded\.$/,
  /^The connection to the AI service was interrupted before the investigation finished\. No conclusions were recorded\.$/,
  /^The database could not be reached while the investigation was running, so it was stopped\. No conclusions were recorded\. Start it again\.$/,
  /^The AI service ended the investigation without producing a report$/,
  /^The public demo runs the rule-based engine only; the analysis service reported a model provider, so the run was stopped\.$/,
];
export const VISITOR_FAILURE = 'The analysis could not be completed. No conclusions were recorded. Try again later.';
export const forVisitor = (text: string) => (OWN_FAILURES.some((re) => re.test(text)) ? text : VISITOR_FAILURE);
