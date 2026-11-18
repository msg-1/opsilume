import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { type Request, type Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env, rateLimitsOff } from '../config/env';
import { writeAudit } from '../lib/audit';
import { randomToken, sha256 } from '../lib/crypto';
import { DEMO_VISITOR_EMAIL, VISITOR_PERMISSIONS } from '../lib/demo';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors';
import { permissionsFor } from '../lib/permissions';
import { prisma } from '../lib/prisma';
import { slugify } from '../lib/slug';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  accessCookieMaxAgeMs,
  authenticate,
  signAccessToken,
  userOf,
} from '../middleware/auth';

const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;

const password = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200)
  .refine((p) => /[a-zA-Z]/.test(p) && /\d/.test(p), 'Password must contain a letter and a number');
const email = z.string().trim().toLowerCase().email().max(254);

const registerBody = z.object({
  email,
  password,
  name: z.string().trim().min(1).max(120),
  organizationName: z.string().trim().min(2).max(120),
});
const loginBody = z.object({ email, password: z.string().min(1).max(200), organizationId: z.string().optional() });
const acceptInviteBody = z.object({
  token: z.string().min(10),
  name: z.string().trim().min(1).max(120).optional(),
  password: password.optional(),
});

// Compared against when the email is unknown, so both paths cost one hash at the configured cost.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', env.BCRYPT_ROUNDS);

// Read when a cookie is set, so the configuration in force is the one applied.
const cookieBase = () => ({ httpOnly: true, sameSite: 'lax' as const, secure: env.COOKIE_SECURE, path: '/' });

async function startSession(req: Request, res: Response, userId: string, organizationId: string, demoSessionId?: string | null) {
  const refresh = randomToken(48);
  const session = await prisma.refreshToken.create({
    data: {
      userId,
      organizationId,
      demoSessionId,
      tokenHash: sha256(refresh),
      userAgent: req.header('user-agent')?.slice(0, 300),
      ip: req.ip,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  const access = signAccessToken(userId, organizationId, session.id);
  res.cookie(ACCESS_COOKIE, access, { ...cookieBase(), maxAge: accessCookieMaxAgeMs });
  // The refresh cookie is only ever sent to the auth endpoints.
  res.cookie(REFRESH_COOKIE, refresh, { ...cookieBase(), maxAge: REFRESH_TTL_MS, path: '/api/v1/auth' });
  return access;
}

function clearSession(res: Response) {
  res.clearCookie(ACCESS_COOKIE, cookieBase());
  res.clearCookie(REFRESH_COOKIE, { ...cookieBase(), path: '/api/v1/auth' });
}

async function uniqueOrgSlug(name: string) {
  const base = slugify(name);
  for (let i = 0; i < 50; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    if (!(await prisma.organization.findUnique({ where: { slug } }))) return slug;
  }
  return `${base}-${randomToken(4).toLowerCase()}`;
}

async function sessionPayload(userId: string, organizationId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      title: true,
      memberships: { select: { role: true, organization: { select: { id: true, name: true, slug: true } } } },
    },
  });
  const current = user.memberships.find((m) => m.organization.id === organizationId);
  if (!current) throw unauthorized();
  const demoVisitor = env.PUBLIC_DEMO_MODE && user.email === DEMO_VISITOR_EMAIL;
  return {
    user: { id: user.id, email: user.email, name: user.name, title: user.title },
    organization: current.organization,
    role: current.role,
    // What the API will actually allow (the visitor's permissions are fixed; see lib/demo.ts).
    permissions: demoVisitor ? [...VISITOR_PERMISSIONS] : permissionsFor(current.role),
    organizations: user.memberships.map((m) => ({ ...m.organization, role: m.role })),
    demoVisitor,
  };
}

export const authRouter = Router();

const limiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: rateLimitsOff,
  message: { error: { code: 'rate_limited', message: 'Too many attempts. Try again in a minute.' } },
});

/** Refused in the public demonstration: nobody creates accounts or organisations there. */
const demoDisabled = () => new AppError(403, 'demo_restricted', 'This action is not available in the public demo.');

authRouter.post('/register', limiter, async (req, res) => {
  if (env.PUBLIC_DEMO_MODE) throw demoDisabled();
  const body = registerBody.parse(req.body);
  if (await prisma.user.findUnique({ where: { email: body.email } })) {
    throw conflict('An account with this email already exists');
  }
  const passwordHash = await bcrypt.hash(body.password, env.BCRYPT_ROUNDS);
  const slug = await uniqueOrgSlug(body.organizationName);
  const { user, org } = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: { name: body.organizationName, slug, settings: { create: {} } },
    });
    const user = await tx.user.create({
      data: {
        email: body.email,
        name: body.name,
        passwordHash,
        lastLoginAt: new Date(),
        memberships: { create: { organizationId: org.id, role: 'OWNER' } },
      },
    });
    return { user, org };
  });
  await writeAudit({
    organizationId: org.id,
    actorType: 'user',
    actorId: user.id,
    actorLabel: user.name,
    action: 'organization.create',
    resourceType: 'organization',
    resourceId: org.id,
    ip: req.ip,
  });
  const accessToken = await startSession(req, res, user.id, org.id);
  res.status(201).json({ ...(await sessionPayload(user.id, org.id)), accessToken });
});

/**
 * Per-account throttle. The address-based limiter above can be sidestepped by anyone who can
 * vary their apparent address; this one is keyed by the account under attack, so it cannot.
 * Successful sign-ins do not count, so a legitimate user is not locked out by their own use.
 */
const accountLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `login:${String((req.body as { email?: unknown } | undefined)?.email ?? '').trim().toLowerCase().slice(0, 254)}`,
  message: { error: { code: 'rate_limited', message: 'Too many failed sign-in attempts for this account. Try again in 15 minutes.' } },
});

authRouter.post('/login', limiter, accountLimiter, async (req, res) => {
  // The public demonstration has no password sign-in at all: visitors enter through POST /auth/demo and
  // operators work on the server (docs/deployment/PUBLIC_DEMO_MODE.md). No password is ever checked here.
  if (env.PUBLIC_DEMO_MODE) throw demoDisabled();
  const body = loginBody.parse(req.body);
  const user = await prisma.user.findUnique({
    where: { email: body.email },
    include: { memberships: { orderBy: { createdAt: 'asc' } } },
  });
  // Always run a hash comparison so response time does not reveal whether the email exists.
  const ok = await bcrypt.compare(body.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok || !user.isActive) {
    // Failed attempts against a real account are part of that organisation's audit trail.
    if (user?.memberships[0]) {
      await writeAudit({ organizationId: user.memberships[0].organizationId, actorType: 'user', actorId: user.id, actorLabel: user.name, action: 'auth.login_failed', resourceType: 'user', resourceId: user.id, ip: req.ip });
    }
    throw unauthorized('Invalid email or password');
  }
  const membership = body.organizationId
    ? user.memberships.find((m) => m.organizationId === body.organizationId)
    : user.memberships[0];
  if (!membership) throw forbidden('This account does not belong to an organisation');
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await writeAudit({
    organizationId: membership.organizationId,
    actorType: 'user',
    actorId: user.id,
    actorLabel: user.name,
    action: 'auth.login',
    resourceType: 'user',
    resourceId: user.id,
    ip: req.ip,
  });
  const accessToken = await startSession(req, res, user.id, membership.organizationId);
  res.json({ ...(await sessionPayload(user.id, membership.organizationId)), accessToken });
});

/** Whether this deployment is the public demonstration (the sign-in page asks; nothing secret is returned). */
authRouter.get('/demo', (_req, res) => {
  res.json({ enabled: env.PUBLIC_DEMO_MODE });
});

/**
 * Starts a session as the shared demo visitor, without a password. Exists only in the public
 * demonstration; elsewhere it is "not found". The visitor's membership (VIEWER of the demonstration
 * organisation) is created by the demo setup (scripts/public-demo.ts), never here.
 */
/** Each entry writes a session and an audit row: an address may enter the demo 60 times an hour (in memory, per API process). */
const demoEntryLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: rateLimitsOff,
  message: { error: { code: 'rate_limited', message: 'Too many demo entries from your address. Try again later.' } },
});

authRouter.post('/demo', limiter, demoEntryLimiter, async (req, res) => {
  if (!env.PUBLIC_DEMO_MODE) throw notFound();
  const visitor = await prisma.user.findUnique({
    where: { email: DEMO_VISITOR_EMAIL },
    include: { memberships: { where: { role: 'VIEWER' }, orderBy: { createdAt: 'asc' }, take: 1 } },
  });
  const membership = visitor?.isActive ? visitor.memberships[0] : undefined;
  if (!visitor || !membership) throw new AppError(503, 'demo_unavailable', 'The demo is being prepared. Try again in a minute.');
  await writeAudit({ organizationId: membership.organizationId, actorType: 'user', actorId: visitor.id, actorLabel: visitor.name, action: 'auth.demo_login', resourceType: 'user', resourceId: visitor.id, ip: req.ip });
  // Each entry is its own visitor session, kept across refreshes; it owns the investigations started in it.
  const accessToken = await startSession(req, res, visitor.id, membership.organizationId, randomUUID());
  res.json({ ...(await sessionPayload(visitor.id, membership.organizationId)), accessToken });
});

authRouter.post('/refresh', limiter, async (req, res) => {
  const presented = (req.cookies?.[REFRESH_COOKIE] as string | undefined) ?? (req.body?.refreshToken as string | undefined);
  if (!presented) throw unauthorized('No refresh token');
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(presented) } });
  if (!record || record.expiresAt < new Date()) {
    clearSession(res);
    throw unauthorized('Session expired');
  }
  if (record.revokedAt) {
    // A rotated token was replayed: treat as theft and end every session for this user. The demo visitor
    // account is shared by every visitor, so there only that visitor's own session ends.
    const family = record.demoSessionId ? { demoSessionId: record.demoSessionId } : { userId: record.userId };
    await prisma.refreshToken.updateMany({ where: { ...family, revokedAt: null }, data: { revokedAt: new Date() } });
    clearSession(res);
    throw unauthorized('Session expired');
  }
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: record.userId, organizationId: record.organizationId } },
    include: { user: { select: { isActive: true } } },
  });
  if (!membership || !membership.user.isActive) {
    clearSession(res);
    throw unauthorized('Session expired');
  }
  await prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
  const accessToken = await startSession(req, res, record.userId, record.organizationId, record.demoSessionId);
  res.json({ accessToken });
});

authRouter.post('/logout', async (req, res) => {
  const presented = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (presented) {
    await prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(presented), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  clearSession(res);
  res.status(204).end();
});

authRouter.get('/me', authenticate, async (req, res) => {
  const auth = userOf(req);
  res.json(await sessionPayload(auth.userId, auth.organizationId));
});

authRouter.post('/switch-organization', authenticate, async (req, res) => {
  const auth = userOf(req);
  const { organizationId } = z.object({ organizationId: z.string().min(1) }).parse(req.body);
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: auth.userId, organizationId } },
  });
  if (!membership) throw forbidden('You are not a member of that organisation');
  const accessToken = await startSession(req, res, auth.userId, organizationId);
  res.json({ ...(await sessionPayload(auth.userId, organizationId)), accessToken });
});

authRouter.patch('/profile', authenticate, async (req, res) => {
  const auth = userOf(req);
  const body = z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      title: z.string().trim().max(120).nullable().optional(),
      currentPassword: z.string().optional(),
      newPassword: password.optional(),
    })
    .parse(req.body);
  const data: { name?: string; title?: string | null; passwordHash?: string } = {};
  if (body.name) data.name = body.name;
  if (body.title !== undefined) data.title = body.title;
  if (body.newPassword) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!body.currentPassword || !(await bcrypt.compare(body.currentPassword, user.passwordHash))) {
      throw badRequest('Current password is incorrect');
    }
    data.passwordHash = await bcrypt.hash(body.newPassword, env.BCRYPT_ROUNDS);
    // Changing the password signs out every other session.
    await prisma.refreshToken.updateMany({ where: { userId: auth.userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }
  await prisma.user.update({ where: { id: auth.userId }, data });
  // Every session was just ended, including this one: start a fresh one for this device.
  if (data.passwordHash) await startSession(req, res, auth.userId, auth.organizationId);
  res.json(await sessionPayload(auth.userId, auth.organizationId));
});

/** Invitation preview so the accept screen can show who invited whom. */
authRouter.get('/invitations/:token', async (req, res) => {
  if (env.PUBLIC_DEMO_MODE) throw demoDisabled();
  const invite = await prisma.invitation.findUnique({
    where: { tokenHash: sha256(String(req.params.token)) },
    include: { organization: { select: { name: true } } },
  });
  if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) throw badRequest('This invitation is invalid or has expired');
  const existing = await prisma.user.findUnique({ where: { email: invite.email }, select: { id: true } });
  res.json({ email: invite.email, role: invite.role, organizationName: invite.organization.name, hasAccount: !!existing });
});

authRouter.post('/accept-invitation', limiter, async (req, res) => {
  if (env.PUBLIC_DEMO_MODE) throw demoDisabled();
  const body = acceptInviteBody.parse(req.body);
  const invite = await prisma.invitation.findUnique({ where: { tokenHash: sha256(body.token) } });
  if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) throw badRequest('This invitation is invalid or has expired');
  let user = await prisma.user.findUnique({ where: { email: invite.email } });
  if (!user) {
    if (!body.name || !body.password) throw badRequest('Name and password are required to create your account');
    user = await prisma.user.create({
      data: { email: invite.email, name: body.name, passwordHash: await bcrypt.hash(body.password, env.BCRYPT_ROUNDS) },
    });
  } else {
    // Existing accounts must prove ownership before being attached to a new organisation.
    if (!body.password || !(await bcrypt.compare(body.password, user.passwordHash))) {
      throw unauthorized('Enter your existing OPSILUME password to accept this invitation');
    }
  }
  await prisma.$transaction([
    prisma.membership.upsert({
      where: { userId_organizationId: { userId: user.id, organizationId: invite.organizationId } },
      create: { userId: user.id, organizationId: invite.organizationId, role: invite.role },
      update: { role: invite.role },
    }),
    prisma.invitation.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } }),
  ]);
  await writeAudit({
    organizationId: invite.organizationId,
    actorType: 'user',
    actorId: user.id,
    actorLabel: user.name,
    action: 'member.join',
    resourceType: 'membership',
    resourceId: user.id,
    metadata: { role: invite.role },
    ip: req.ip,
  });
  const accessToken = await startSession(req, res, user.id, invite.organizationId);
  res.status(201).json({ ...(await sessionPayload(user.id, invite.organizationId)), accessToken });
});
