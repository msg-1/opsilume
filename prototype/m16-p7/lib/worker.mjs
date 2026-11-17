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
 * authenticated and is given before the recorder reads or writes anything, so the request certainly had no effect and
 * sending it again is safe. Every other failure (a timeout, a lost connection, any other status) is thrown at once and
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
