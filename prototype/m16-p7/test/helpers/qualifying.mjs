// What a qualifying (POWER-CUT) run needs in a test: storage evidence, a source package of exactly this source with
// its declared identity, and the facts a successful preflight gathers. Nothing outside the tests uses it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SOURCE_SETS, sourceDigest } from '../../lib/source.mjs';
import { tarGz } from './tar.mjs';

export const STORAGE = { driveModel: 'Example SSD 1TB', firmware: '1B2QEXM7', controller: 'NVMe (PCIe)', dbDevice: 'nvme0n1p2', journalDevice: 'nvme0n1p2', filesystem: 'ext4 rw,relatime', vendorDoc: 'vendor datasheet rev 3, section 4.2', evidenceFiles: 'host/baseline/*', writeCache: 'write back', fua: 'yes', flushSupported: 'yes', flushesObserved: 'yes', vendorFlushSemantics: 'yes', plp: 'unknown' };
const PROTO = fileURLToPath(new URL('../../..', import.meta.url));
export const SOURCE = sourceDigest(PROTO);
const entries = SOURCE_SETS.flatMap(([d, pattern]) => fs.readdirSync(path.join(PROTO, d)).filter((n) => pattern.test(n) && fs.statSync(path.join(PROTO, d, n)).isFile()).sort().map((n) => [`prototype/${d}/${n}`, fs.readFileSync(path.join(PROTO, d, n))]));
const COMMIT = 'c0'.repeat(20);
export const PACKAGE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p7-qualifying-')), 'opspilot-p7-test.tar.gz');
fs.writeFileSync(PACKAGE, tarGz(entries, { commit: COMMIT }));
export const IDENTITY = { sourceCommit: COMMIT, packageSha256: createHash('sha256').update(fs.readFileSync(PACKAGE)).digest('hex'), imageId: `sha256:${'e2'.repeat(32)}`, imageArch: 'amd64' };
/** Decision B1's shape, planned for the 20 cycles: 10 burst seconds at 100/s in every 60, 20/s otherwise, 600 s. */
export const WORKLOAD = { procs: 1, workers: 1, cycles: 20, maxSeconds: 600, headroom: 2, ratePerWorker: 100, targetRate: null, poolPerWorker: 40000, burstPeriodSeconds: 60, burstSeconds: 10, quietRate: 20 };
export const FACTS = (pgSystemId, over = {}) => ({
  pgSystemId, journal: { markerSha256: 'aa'.repeat(32), installationId: 'inst-1' },
  settings: { fsync: 'on', full_page_writes: 'on', synchronous_commit: 'on', wal_sync_method: 'fdatasync', data_checksums: 'off', server_version: '16.14' },
  netcheck: { strict: true, ok: true, bridges: ['172.22.0.1', '172.23.0.1'], probes: [{ name: 'host or bridge 172.22.0.1:22' }, { name: 'host or bridge 172.23.0.1:22' }] },
  workload: WORKLOAD, source: SOURCE, runtime: { arch: 'x64', node: 'v22.0.0', fingerprint: 'f1'.repeat(32) }, ...over,
});
