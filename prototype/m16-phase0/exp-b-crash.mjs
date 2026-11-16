// Claims one action and is killed right after the claim record is flushed, while holding the state lock (optionally after a pause).
import { claim, db, journalAt } from './lib/proto.mjs';
const [id, pauseMs = '0'] = process.argv.slice(2);
await claim(db(), journalAt(), id, { crashAt: 'after_claim_append', pauseMs: Number(pauseMs) });
