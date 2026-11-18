/**
 * Sets up, resets and reports the public demonstration (docs/deployment/PUBLIC_DEMO_MODE.md).
 * Runs only with PUBLIC_DEMO_MODE=true.
 *
 *   public-demo setup [--investigate]   create what is missing; idempotent
 *   public-demo reset [--investigate]   remove the demonstration organisation (and only it), then set up again
 *   public-demo status                  what exists
 *
 * In a container: node dist/scripts/public-demo.js <command>. Locally: npm run public-demo -w @opsilume/api -- <command>.
 *
 * What it guarantees:
 * - The demonstration organisation is the marked "Acme Commerce" dataset (scripts/demo-data.ts). Removal is
 *   scoped to it and verified, inside its transaction, to change nothing outside it.
 * - The persona accounts the dataset needs are created with random passwords that are never shown,
 *   stored elsewhere or used. Existing accounts are never changed. Nobody signs in with a password in
 *   demo mode (the API refuses it); operators work on the server, through this script.
 * - The visitor account is a VIEWER of the demonstration organisation and of nothing else.
 * - One run at a time: a Redis lock makes a second, concurrent run stop without doing anything.
 * - Every setup and reset leaves an audit entry in the demonstration organisation.
 * - Nothing here calls an external system, a webhook or a model.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import IORedis from 'ioredis';
import { prisma } from '../src/lib/prisma';
import { DEMO_VISITOR_EMAIL, DEMO_VISITOR_NAME } from '../src/lib/demo';
import { SLUG, findDemo, forPublicDemo, reset as removeDataset, seed as seedDataset, status as datasetStatus } from './demo-data';

const say = (line = '') => process.stdout.write(`${line}\n`);
const LOCK_KEY = 'opsilume:public-demo:lock';
const LOCK_SECONDS = 15 * 60;

/** The accounts the dataset expects (scripts/demo-data.ts, ACCOUNTS). Fictional personas. */
const PERSONAS: [email: string, name: string, title: string][] = [
  ['demo@example.com', 'Priya Raman', 'Head of Platform'],
  ['marcus@example.com', 'Marcus Oyelaran', 'Engineering Manager, Payments'],
  ['lena@example.com', 'Lena Fischer', 'Senior SRE'],
  ['tomas@example.com', 'Tomás Herrera', 'Backend Engineer'],
  ['aiko@example.com', 'Aiko Tanaka', 'Support Lead'],
];

/** A password nobody knows: never printed, never stored except as its hash. */
const unusablePassword = () => bcrypt.hash(randomBytes(32).toString('hex'), 12);

async function withLock<T>(work: () => Promise<T>): Promise<T | undefined> {
  const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 1, lazyConnect: true });
  await redis.connect();
  const token = randomUUID();
  try {
    if ((await redis.set(LOCK_KEY, token, 'EX', LOCK_SECONDS, 'NX')) !== 'OK') {
      say('Another setup or reset of the public demo is running. Nothing was done.');
      process.exitCode = 3;
      return undefined;
    }
    try {
      return await work();
    } finally {
      // Released only by its holder.
      await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, LOCK_KEY, token);
    }
  } finally {
    redis.disconnect();
  }
}

async function ensurePersonas() {
  if (process.env.PUBLIC_DEMO_OWNER_PASSWORD) {
    throw new Error('PUBLIC_DEMO_OWNER_PASSWORD is no longer supported: the public demo has no password sign-in. Remove it from the environment. Nothing was changed.');
  }
  for (const [email, name, title] of PERSONAS) {
    if (!(await prisma.user.findUnique({ where: { email } }))) await prisma.user.create({ data: { email, name, title, passwordHash: await unusablePassword() } });
  }
}

async function ensureVisitor(organizationId: string) {
  const visitor =
    (await prisma.user.findUnique({ where: { email: DEMO_VISITOR_EMAIL } })) ??
    (await prisma.user.create({ data: { email: DEMO_VISITOR_EMAIL, name: DEMO_VISITOR_NAME, title: 'Exploring the public demo', passwordHash: await unusablePassword() } }));
  // The visitor belongs to the demonstration organisation only.
  const elsewhere = await prisma.membership.count({ where: { userId: visitor.id, organizationId: { not: organizationId } } });
  if (elsewhere) throw new Error(`The visitor account ${DEMO_VISITOR_EMAIL} is a member of another organisation. Remove that membership first; nothing more was changed.`);
  await prisma.membership.upsert({
    where: { userId_organizationId: { userId: visitor.id, organizationId } },
    create: { userId: visitor.id, organizationId, role: 'VIEWER' },
    update: { role: 'VIEWER' },
  });
}

/** Starts one rule-based investigation per open incident, through the product's normal path (the worker runs them). */
async function investigate(organizationId: string) {
  const { aiService } = await import('../src/integrations/aiService');
  let provider = 'unreachable';
  try {
    provider = (await aiService.status()).llm.provider;
  } catch {
    /* reported below */
  }
  if (provider !== 'heuristic') return say(`Investigations not started: the analysis service is ${provider === 'unreachable' ? 'not reachable' : `configured with "${provider}"`}; the public demo uses the rule-based engine only.`);
  const { enqueueInvestigation } = await import('../src/modules/investigations/runner');
  const { closeQueues } = await import('../src/queues');
  const starter = await prisma.user.findUnique({ where: { email: 'lena@example.com' }, select: { id: true } });
  const open = await prisma.incident.findMany({ where: { organizationId, status: { not: 'CLOSED' } }, orderBy: { number: 'asc' }, select: { id: true, number: true, title: true } });
  for (const incident of open) {
    if (await prisma.investigation.count({ where: { organizationId, incidentId: incident.id } })) continue;
    const run = await prisma.investigation.create({
      data: { organizationId, incidentId: incident.id, question: 'What is the most likely cause, and what evidence supports or contradicts it?', createdById: starter?.id },
      select: { id: true },
    });
    await enqueueInvestigation(run.id);
    say(`  queued: INC-${incident.number} ${incident.title}`);
  }
  await closeQueues();
}

async function setup(withInvestigations: boolean) {
  await ensurePersonas();
  if (!(await findDemo())) await seedDataset();
  const demo = await findDemo();
  if (!demo?.marked) throw new Error(`The demonstration organisation "${SLUG}" is missing or unmarked after seeding. Nothing more was changed.`);
  await ensureVisitor(demo.org.id);
  await prisma.auditLog.create({ data: { organizationId: demo.org.id, actorType: 'system', actorLabel: 'public demo setup', action: 'public_demo.setup', resourceType: 'organization', resourceId: demo.org.id } });
  if (withInvestigations) await investigate(demo.org.id);
  say(`\nPublic demo ready: organisation "${demo.org.name}" (${SLUG}). Visitors enter through "Explore the demo" on the sign-in page.`);
}

async function main() {
  forPublicDemo();
  const [command, ...flags] = process.argv.slice(2);
  const withInvestigations = flags.includes('--investigate');
  if (command === 'status') {
    await datasetStatus();
    const visitor = await prisma.user.findUnique({ where: { email: DEMO_VISITOR_EMAIL }, select: { memberships: { select: { role: true, organization: { select: { slug: true } } } } } });
    return say(`\nVisitor account: ${visitor ? visitor.memberships.map((m) => `${m.role} of ${m.organization.slug}`).join(', ') || 'no membership' : 'missing'}`);
  }
  if (command === 'setup') return void (await withLock(() => setup(withInvestigations)));
  if (command === 'reset') {
    return void (await withLock(async () => {
      say(`Reset of the public demo started ${new Date().toISOString()}.`);
      const current = await findDemo();
      // An unmarked organisation with the demo's slug is never touched: the removal itself refuses it.
      if (current && !current.marked) await removeDataset(true);
      if (current?.marked) {
        // First close the demo to visitors and stop its runs, so little is written while it is removed: without
        // its membership no visitor session is valid and the entry answers "being prepared".
        await prisma.membership.deleteMany({ where: { organizationId: current.org.id, user: { email: DEMO_VISITOR_EMAIL } } });
        await prisma.investigation.updateMany({ where: { organizationId: current.org.id, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'CANCELLED', completedAt: new Date() } });
        // A write that still lands meanwhile makes the removal's transaction roll back, whole; it is tried again.
        for (let attempt = 1; ; attempt++) {
          try {
            await removeDataset(true);
            break;
          } catch (err) {
            // Still closed to visitors: running setup (or reset) again reopens it.
            if (attempt >= 3) throw new Error(`${(err as Error).message}\nThe demo stays closed to visitors until setup or reset completes.`);
            say(`Removal attempt ${attempt} rolled back (${(err as Error).message.split('\n')[0]}); trying again.`);
            await new Promise((r) => setTimeout(r, 2000 * attempt));
          }
        }
      }
      await setup(withInvestigations);
      const demo = await findDemo();
      if (demo) await prisma.auditLog.create({ data: { organizationId: demo.org.id, actorType: 'system', actorLabel: 'public demo reset', action: 'public_demo.reset', resourceType: 'organization', resourceId: demo.org.id } });
    }));
  }
  say('Usage: public-demo setup|reset [--investigate] | status');
  process.exitCode = 2;
}

if (require.main === module) {
  main()
    .catch((err) => {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
