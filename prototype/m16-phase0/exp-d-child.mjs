// Runs one execution with the given options; a crash point kills this process with SIGKILL.
import { db, execute, journalAt } from './lib/proto.mjs';
const [id, opts] = process.argv.slice(2);
try { await execute(db(), journalAt(), id, process.env.RECEIVER_URL, JSON.parse(opts)); process.exit(0); } catch (e) { console.error(String(e.message).split('\n').filter(Boolean).at(-1)); process.exit(3); }
