#!/usr/bin/env node
// Backups of an OPSILUME installation's PostgreSQL database, for whoever operates it.
//
//   node scripts/backup.mjs create  --project <compose project> --dir <directory> [--keep 14] [--verify-restore]
//   node scripts/backup.mjs verify  --project <compose project> --file <backup.dump> [--restore]
//   node scripts/backup.mjs status  --dir <directory> [--max-age-hours 26]
//
// `create` takes a backup, checks it, and only then gives it its final name. `verify` checks
// an existing backup. `status` says how old the newest good backup is and fails if it is too
// old or the last attempt failed, so that a scheduler or a monitor can raise the alarm.
//
// It never runs on its own, never guesses which installation is meant (--project is required),
// writes only inside --dir, and deletes only backups that it made itself and that --keep says
// may go. There is no point-in-time recovery here: a backup is the database at one moment.
// See docs/backup-and-restore.md.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const NAME = /^opspilot-\d{8}-\d{6}\.dump$/;
const MANIFEST = 'backups.json';
const FAILURE = 'last-failure.json';
const say = (line = '') => process.stdout.write(`${line}\n`);

function args() {
  const [command, ...rest] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) continue;
    const key = rest[i].slice(2);
    options[key] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  }
  return { command, options };
}

/** The PostgreSQL container of one Compose project, found by its labels. No Compose file or .env is read. */
function postgresOf(project) {
  if (!project || project === true) throw new Error('--project is required: the name of the Compose project to back up (for the default installation, "opspilot").');
  const ids = execFileSync('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`, '--filter', 'label=com.docker.compose.service=postgres'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  if (ids.length !== 1) throw new Error(`Expected one running postgres container in the Compose project "${project}", found ${ids.length}. Is the database running?`);
  const env = (name) => execFileSync('docker', ['exec', ids[0], 'printenv', name], { encoding: 'utf8' }).trim();
  return { id: ids[0], user: env('POSTGRES_USER'), database: env('POSTGRES_DB') };
}

const psql = (pg, database, query) => execFileSync('docker', ['exec', '-i', pg.id, 'psql', '-U', pg.user, '-d', database, '-AtF', '\t', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

const sha256 = (file) =>
  new Promise((done, fail) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (c) => hash.update(c)).on('end', () => done(hash.digest('hex'))).on('error', fail);
  });

/** Row counts of every table, as text lines "table<TAB>count". */
function tableCounts(pg, database) {
  const tables = psql(pg, database, `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`).split('\n').filter(Boolean);
  return Object.fromEntries(tables.map((t) => [t, Number(psql(pg, database, `SELECT count(*) FROM "${t}"`))]));
}

/** What the backup file itself says it contains. Fails on a file that is cut short or is not a backup. */
function contents(pg, file) {
  const inside = `/tmp/verify-${process.pid}.dump`;
  try {
    execFileSync('docker', ['cp', file, `${pg.id}:${inside}`]);
    const toc = spawnSync('docker', ['exec', pg.id, 'pg_restore', '--list', inside], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (toc.status !== 0) throw new Error(`pg_restore cannot read it: ${toc.stderr.trim().split('\n')[0]}`);
    const lines = toc.stdout.split('\n');
    const tables = lines.filter((l) => / TABLE DATA public /.test(l)).length;
    if (!tables) throw new Error('it holds no table data');
    return { tables, indexes: lines.filter((l) => / INDEX public /.test(l)).length, constraints: lines.filter((l) => / FK CONSTRAINT public /.test(l)).length };
  } finally {
    spawnSync('docker', ['exec', pg.id, 'rm', '-f', inside]);
  }
}

/** Restores the file into a scratch database, compares it with what was recorded, and drops it again. */
function restoreTest(pg, file, expectedCounts) {
  const scratch = `backup_verify_${process.pid}`;
  const inside = `/tmp/restore-${process.pid}.dump`;
  try {
    execFileSync('docker', ['cp', file, `${pg.id}:${inside}`]);
    psql(pg, 'postgres', `CREATE DATABASE ${scratch}`);
    const restored = spawnSync('docker', ['exec', pg.id, 'pg_restore', '-U', pg.user, '-d', scratch, '--no-owner', '--exit-on-error', inside], { encoding: 'utf8' });
    if (restored.status !== 0) throw new Error(`restoring it failed: ${restored.stderr.trim().split('\n')[0]}`);
    const counts = tableCounts(pg, scratch);
    const orphans = Number(psql(pg, scratch, `SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND NOT convalidated`));
    if (orphans) throw new Error(`${orphans} foreign keys are not valid after the restore`);
    if (expectedCounts) {
      const different = Object.keys(expectedCounts).filter((t) => expectedCounts[t] !== counts[t]);
      if (different.length) throw new Error(`row counts differ from those recorded when the backup was taken: ${different.slice(0, 5).map((t) => `${t} ${expectedCounts[t]} → ${counts[t] ?? 'missing'}`).join(', ')}`);
    }
    return { tables: Object.keys(counts).length, rows: Object.values(counts).reduce((a, b) => a + b, 0) };
  } finally {
    spawnSync('docker', ['exec', '-i', pg.id, 'psql', '-U', pg.user, '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`]);
    spawnSync('docker', ['exec', pg.id, 'rm', '-f', inside]);
  }
}

const readManifest = (dir) => (existsSync(join(dir, MANIFEST)) ? JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) : { backups: [] });
const writeManifest = (dir, manifest) => {
  writeFileSync(join(dir, `${MANIFEST}.tmp`), `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(join(dir, `${MANIFEST}.tmp`), join(dir, MANIFEST));
};

async function create(options) {
  const dir = resolve(String(options.dir ?? ''));
  if (!options.dir || options.dir === true) throw new Error('--dir is required: where backups are kept.');
  mkdirSync(dir, { recursive: true });
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const final = join(dir, `opspilot-${stamp}.dump`);
  const partial = `${final}.partial`;
  try {
    const pg = postgresOf(options.project);
    // The counts are taken in the same snapshot as the dump would need to be exact; they are
    // taken just before it instead, and compared only by --verify-restore on a quiet database.
    const counts = options['verify-restore'] ? tableCounts(pg, pg.database) : null;
    // Streamed straight to the file: pg_dump reads one consistent snapshot while the application keeps running.
    await new Promise((done, fail) => {
      const dump = spawn('docker', ['exec', pg.id, 'pg_dump', '-U', pg.user, '-d', pg.database, '--format=custom'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      dump.stderr.on('data', (c) => (stderr += c));
      const out = createWriteStream(partial, { mode: 0o600 });
      dump.stdout.pipe(out);
      dump.on('error', fail);
      dump.on('exit', (code) => out.end(() => (code === 0 ? done() : fail(new Error(`pg_dump failed (exit ${code}): ${stderr.trim().split('\n')[0] ?? ''}`)))));
    });
    const bytes = statSync(partial).size;
    if (!bytes) throw new Error('pg_dump wrote an empty file');
    const inside = contents(pg, partial);
    const restored = options['verify-restore'] ? restoreTest(pg, partial, counts) : null;
    const digest = await sha256(partial);
    // Only a backup that passed its checks gets a name that looks like a backup.
    renameSync(partial, final);
    const entry = { file: basename(final), createdAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), bytes, sha256: digest, ...inside, restoreTested: !!restored, project: options.project, postgres: psql(pg, pg.database, 'SHOW server_version'), databaseSize: psql(pg, pg.database, `SELECT pg_size_pretty(pg_database_size(current_database()))`) };
    const manifest = readManifest(dir);
    manifest.backups.push(entry);
    // Rotation: only with --keep, only files this tool recorded, only the oldest beyond the number to keep.
    const removed = [];
    const keep = options.keep === undefined ? null : Number(options.keep);
    if (keep !== null) {
      if (!Number.isInteger(keep) || keep < 1) throw new Error('--keep must be a whole number of backups to keep, at least 1.');
      const mine = manifest.backups.filter((b) => NAME.test(b.file)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const old of mine.slice(0, Math.max(0, mine.length - keep))) {
        if (existsSync(join(dir, old.file))) rmSync(join(dir, old.file));
        removed.push(old.file);
      }
      manifest.backups = manifest.backups.filter((b) => !removed.includes(b.file));
    }
    writeManifest(dir, manifest);
    if (existsSync(join(dir, FAILURE))) rmSync(join(dir, FAILURE));
    say(`Backup written and checked: ${final}`);
    say(`  ${(bytes / 1024 / 1024).toFixed(1)} MB, ${inside.tables} tables, ${inside.indexes} indexes, sha256 ${digest.slice(0, 16)}…${restored ? `, restored into a scratch database and compared (${restored.rows.toLocaleString('en-GB')} rows)` : ''}`);
    if (removed.length) say(`  Removed ${removed.length} older backup(s) of this tool: ${removed.join(', ')}`);
    say('  Keep a copy somewhere else, and keep the ENCRYPTION_KEY from .env separately from it.');
    return entry;
  } catch (err) {
    // A failed attempt leaves no file that could be mistaken for a backup, and says so where `status` will find it.
    if (existsSync(partial)) rmSync(partial);
    writeFileSync(join(dir, FAILURE), `${JSON.stringify({ at: new Date().toISOString(), error: String(err.message).slice(0, 500) }, null, 2)}\n`);
    throw new Error(`Backup FAILED: ${err.message}\nNo backup was written. Earlier backups in ${dir} are untouched. See "When a backup fails" in docs/backup-and-restore.md.`);
  }
}

async function verify(options) {
  if (!options.file || options.file === true) throw new Error('--file is required: the backup to check.');
  const file = resolve(String(options.file));
  if (!existsSync(file)) throw new Error(`There is no file ${file}.`);
  const pg = postgresOf(options.project);
  const recorded = readManifest(resolve(file, '..')).backups.find((b) => b.file === basename(file));
  const digest = await sha256(file);
  if (recorded && recorded.sha256 !== digest) throw new Error(`Verification FAILED: ${basename(file)} is not the file that was written (its checksum differs from the one recorded when it was taken). Do not rely on it.`);
  let inside;
  try {
    inside = contents(pg, file);
  } catch (err) {
    throw new Error(`Verification FAILED: ${basename(file)}: ${err.message}. Do not rely on it.`);
  }
  let restored = null;
  if (options.restore) {
    try {
      restored = restoreTest(pg, file, null);
    } catch (err) {
      throw new Error(`Verification FAILED: ${basename(file)}: ${err.message}. Do not rely on it.`);
    }
  }
  say(`${basename(file)} is readable: ${inside.tables} tables, ${inside.indexes} indexes, ${inside.constraints} foreign keys${recorded ? '; checksum matches the one recorded when it was taken' : '; no recorded checksum to compare with'}${restored ? `; restored into a scratch database (${restored.tables} tables, ${restored.rows.toLocaleString('en-GB')} rows) and removed again` : ''}.`);
}

function status(options) {
  if (!options.dir || options.dir === true) throw new Error('--dir is required.');
  const dir = resolve(String(options.dir));
  const maxAge = Number(options['max-age-hours'] ?? 26);
  const manifest = readManifest(dir);
  const present = manifest.backups.filter((b) => existsSync(join(dir, b.file)) && statSync(join(dir, b.file)).size === b.bytes).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const failure = existsSync(join(dir, FAILURE)) ? JSON.parse(readFileSync(join(dir, FAILURE), 'utf8')) : null;
  const stray = readdirSync(dir).filter((f) => f.endsWith('.partial'));
  const problems = [];
  if (!present.length) problems.push('there is no backup');
  const ageHours = present.length ? (Date.now() - new Date(present[0].createdAt).getTime()) / 3_600_000 : null;
  if (ageHours !== null && ageHours > maxAge) problems.push(`the newest backup is ${ageHours.toFixed(1)} hours old (limit ${maxAge})`);
  if (failure && (!present.length || failure.at > present[0].createdAt)) problems.push(`the last attempt failed at ${failure.at}: ${failure.error}`);
  if (stray.length) problems.push(`an unfinished backup file is lying around (${stray.join(', ')}): an attempt was interrupted`);
  const missing = manifest.backups.length - present.length;
  if (missing) problems.push(`${missing} recorded backup(s) are missing or have changed size`);
  say(present.length ? `Newest backup: ${present[0].file}, ${ageHours.toFixed(1)} hours old, ${(present[0].bytes / 1024 / 1024).toFixed(1)} MB. ${present.length} backup(s) in ${dir}.` : `No backup in ${dir}.`);
  if (problems.length) throw new Error(`Backups need attention: ${problems.join('; ')}.`);
  say('Backups are in order.');
}

const { command, options } = args();
try {
  if (command === 'create') await create(options);
  else if (command === 'verify') await verify(options);
  else if (command === 'status') status(options);
  else {
    say('Usage: backup.mjs create --project <name> --dir <directory> [--keep N] [--verify-restore]\n       backup.mjs verify --project <name> --file <backup.dump> [--restore]\n       backup.mjs status --dir <directory> [--max-age-hours 26]');
    process.exitCode = 2;
  }
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
}
