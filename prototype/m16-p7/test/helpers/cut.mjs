// What the operator's `cut` and `confirm-cut --power-was-cut yes` leave in a run's ledger, and what `check` sends with
// a PASS, for tests that store one. The recorder stores no PASS without a recorded, confirmed cut, and (product-owner
// rulings B and C of 18 November 2026) without the evidence mark of the view the check read and, for a qualifying run,
// the reboot, the settings and the identity it observed. Test fixtures only; nothing is cut.
import { cycleView } from '../../recorder.mjs';

export function confirmedCut(store, cycle = 1) {
  store.event({ cycle, kind: 'cut_sent', how: 'test fixture' });
  store.event({ cycle, kind: 'cut_confirmed', powerWasCut: 'yes', attestation: 'test fixture' });
}
/** The evidence mark of the cycle view as it is now (what `check` sends back with its result). */
export const markOf = (store, cycle = 1) => ({ evidenceMark: cycleView(store, cycle).evidenceMark });
/** The settings these tests' readiness records approve (test/helpers/qualifying.mjs, FACTS). */
export const READY_SETTINGS = { fsync: 'on', full_page_writes: 'on', synchronous_commit: 'on', wal_sync_method: 'fdatasync', data_checksums: 'off', server_version: '16.14' };
/**
 * For a qualifying run: the boot report the boot probe sends after the reboot (written to the ledger as the recorder
 * writes it), then what `check` sends with its PASS: the run, the settings and identity it found, its boot, and the
 * mark of the view, read last.
 */
export function qualifyingPassFields(store, { run, cycle = 1, pgSystemId, bootIdNow = `rebooted-${cycle}` }) {
  store.event({ cycle, kind: 'boot_report', bootId: bootIdNow, attestation: 'test fixture' });
  return { run, settings: READY_SETTINGS, identity: { pgSystemId, journalMarkerSha256: 'aa'.repeat(32), installationId: 'inst-1' }, reboot: { bootIdNow }, ...markOf(store, cycle) };
}
