import { fresh, seed } from './lib/fixtures.mjs';
const [own = '600', shared = '50'] = process.argv.slice(2);
const { p } = await fresh();
await seed(p, { orgs: 1, perOrg: Number(own) });
await seed(p, { orgs: 1, perOrg: Number(shared), prefix: 's' });
await p.$disconnect();
