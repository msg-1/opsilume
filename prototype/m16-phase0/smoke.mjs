import { fresh, seed } from './lib/fixtures.mjs';
import { execute, inspect } from './lib/proto.mjs';
const { p, j } = await fresh();
await seed(p, { orgs: 1, perOrg: 2 });
const r = await execute(p, j, 'a-1-1', process.env.RECEIVER_URL);
const again = await execute(p, j, 'a-1-1', process.env.RECEIVER_URL);
const hits = await (await fetch(process.env.RECEIVER_URL.replace('/hook', '/hits'))).json();
console.log(JSON.stringify({ r, again, hits: hits.length, journal: j.state().entries.map((e) => e.type), view: (await inspect(p, j)).problem }));
await p.$disconnect();
