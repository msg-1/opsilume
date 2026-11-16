// Does a failed statement inside a Prisma interactive transaction keep the transaction's row locks until the callback ends?
import { db } from './lib/proto.mjs';
import { fresh, seed } from './lib/fixtures.mjs';
const { p } = await fresh();
await seed(p, { orgs: 1, perOrg: 1 });
const other = db();
const probe = async () => (await other.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'installation_state' AND l.mode = 'RowShareLock' AND l.granted`))[0].n;
const out = {};
await p.$transaction(async (tx) => {
  await tx.$queryRaw`SELECT 1 FROM installation_state WHERE id = 1 FOR UPDATE`;
  out.lockHeldBeforeError = (await probe()) > 0;
  try {
    await tx.$executeRaw`INSERT INTO audit (org_id, action) VALUES ('no-such-organisation', 'x')`;
  } catch (e) {
    out.errorCaught = true;
    out.lockHeldAfterErrorInsideCallback = (await probe()) > 0;
    // Can the transaction still be used?
    try { await tx.$queryRaw`SELECT 1`; out.transactionUsableAfterError = true; } catch (e2) { out.transactionUsableAfterError = false; out.secondError = String(e2.message).split('\n').filter(Boolean).at(-1).slice(0, 160); }
  }
}).catch((e) => (out.transactionRejected = String(e.message).split('\n').filter(Boolean).at(-1).slice(0, 160)));
console.log(JSON.stringify(out));
await p.$disconnect(); await other.$disconnect();

// Same, with a savepoint after the lock: a failed statement rolls back to it and the lock taken before it stays.
{
  const p2 = db(); const other2 = db();
  const probe2 = async () => (await other2.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'installation_state' AND l.mode = 'RowShareLock' AND l.granted`))[0].n;
  const s = {};
  await p2.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM installation_state WHERE id = 1 FOR UPDATE`;
    await tx.$executeRawUnsafe('SAVEPOINT claim_writes');
    try {
      await tx.$executeRaw`INSERT INTO audit (org_id, action) VALUES ('no-such-organisation', 'x')`;
    } catch {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT claim_writes');
      s.lockHeldAfterRollbackToSavepoint = (await probe2()) > 0;
      s.transactionUsable = (await tx.$queryRaw`SELECT 1 AS one`)[0].one === 1;
    }
  });
  // Does another session's FOR UPDATE actually block while the savepoint-rolled-back transaction is open?
  console.log(JSON.stringify({ savepoint: s }));
  await p2.$disconnect(); await other2.$disconnect();
}
