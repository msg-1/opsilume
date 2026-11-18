import { randomUUID } from 'node:crypto';
// One worker's claim loop (pure: every effect is injected). p7.mjs supplies the real claim, the recorder
// acknowledgement and the dispatch-intent append; the tests supply fakes. The rules it holds to:
//   - a claim is acknowledged only after it returned `claimed: true` (its COMMIT returned);
//   - its dispatch intent is appended only after that acknowledgement, and acknowledged only after the append;
//   - ANY other outcome stops the worker for good: an uncertain commit, a quarantine, an error, a lost
//     acknowledgement. Nothing is retried, nothing is acknowledged, and no further action is claimed;
//   - a claim starts only when the pacer allows it, and never more than `pool` are attempted.
const lastLine = (e) => String(e?.message ?? e).split('\n').filter(Boolean).at(-1)?.slice(0, 200);

export async function runWorker({ pool, actionIdOf, claim, ack, appendDispatch, pacer, stop }) {
  for (let k = 1; k <= pool; k++) {
    await pacer.wait();
    const actionId = actionIdOf(k);
    let c;
    try { c = await claim(actionId, k); } catch (e) { return stop('claim_error', lastLine(e)); }
    if (!c?.claimed) return stop(`claim_${c?.reason}`, c?.problem ?? c?.error); // includes 'uncertain': never retried
    try { await ack('claim', c.seq, actionId); } catch (e) { return stop('ack_failed', lastLine(e)); }
    try { await appendDispatch(c.seq); } catch (e) { return stop('dispatch_intent_failed', lastLine(e)); }
    try { await ack('dispatch', c.seq, actionId); } catch (e) { return stop('ack_failed', lastLine(e)); }
  }
  return stop('pool_exhausted', `after ${pool} actions`);
}

/**
 * Repeats a recorder request ONLY while the recorder answers "busy" (HTTP 503, recorder_busy): that answer is
 * authenticated and the request was not accepted, so sending it again is safe. (For a worker's stop or journal-failure
 * report the recorder does record the busy answer, as a refusal against the open cycle: a repeat only adds a record,
 * and can only make the cycle INCONCLUSIVE.) Every other failure (a timeout, a lost connection, any other status) is thrown at once and
 * never retried here: its effect is unknown.
 */
export async function whileBusy(request, { tries = 6, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), waitMs = 2000 } = {}) {
  for (let i = 1; ; i++) {
    try { return await request(); } catch (e) {
      if (!(e?.status === 503 && e?.data?.error === 'recorder_busy') || i >= tries) throw e;
      await sleep(waitMs);
    }
  }
}

/**
 * Sends the cycle start (after the actions are seeded) and returns { cycleId, clockOffsetMs, answerLost }.
 * A refusal, or any answer with a status, is thrown as it is. If NO answer arrives (a timeout, a lost connection), the
 * recorder is asked whether the start is on record for this process:
 *  - it is (the start that carries this invocation's own id): the process continues with the recorded cycle id (before: it ended with a started cycle and no worker);
 *  - it is not: the start is sent once more. It cannot be recorded twice: the recorder refuses a second start of the
 *    same process in a cycle, and that refusal is thrown.
 * If the recorder cannot be asked either, the original failure is thrown and nothing is sent again.
 */
export async function startCycle({ call, run, cycle, proc, body: given }) {
  const body = { ...given, startId: randomUUID() }; // this invocation's own start: the recorder stores the id with it
  const send = async () => { const r = await whileBusy(() => call('POST', `/runs/${run}/cycles/${cycle}/start`, body)); return { cycleId: r.data.cycleId, clockOffsetMs: r.clockOffsetMs }; };
  try { return { ...(await send()), answerLost: false }; } catch (e) {
    if (e?.status !== undefined) throw e;
    let view;
    try { view = await call('GET', `/runs/${run}/cycles/${cycle}`); } catch { throw e; }
    // Its OWN start only: the one that carries this invocation's id. Another start for the same process letter (an
    // earlier invocation's, another process's) is not adopted: the start is sent again and the recorder refuses it.
    const same = (x) => x.proc === proc && x.startId === body.startId;
    if (view.data?.starts?.some(same) && typeof view.data.cycleId === 'string') return { cycleId: view.data.cycleId, clockOffsetMs: view.clockOffsetMs, answerLost: true };
    return { ...(await send()), answerLost: true };
  }
}
