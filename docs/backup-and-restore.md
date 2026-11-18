# Backup and restore

What has to be backed up, how to do it, how to restore, and what was actually tested. Written for whoever operates an installation run with Docker Compose.

**There is no point-in-time recovery, no replication and no disaster-recovery set-up.** A backup is the database at the moment the command ran; everything written after it is lost if you restore it. Nothing here takes backups for you: schedule them yourself, and check that they keep happening.

## What holds state

| Where | What | Back it up? |
|---|---|---|
| **PostgreSQL** (volume `pgdata`) | Everything that matters: organisations, accounts, services, incidents, telemetry, investigations and their evidence, approvals, the audit log, encrypted integration credentials, knowledge documents and their embeddings | **Yes.** This is the system of record |
| **`.env`** | `ENCRYPTION_KEY`, `JWT_SECRET`, `INTERNAL_SERVICE_TOKEN`, the database password | **Yes, separately and securely.** Without `ENCRYPTION_KEY` a restored database's GitHub tokens and webhook secrets cannot be decrypted. Do not store it next to the database backup |
| **Redis** (volume `redisdata`) | The job queue: investigations and indexing jobs that are waiting or running, and the schedules of the repeating jobs | No. See [Redis](#redis) |
| Containers | Nothing. They can be rebuilt from the repository |

## Taking a backup

Use the backup tool. It takes the backup, checks it, and only then gives it a name that looks like a backup:

```bash
npm run backup -- create --project opsilume --dir /srv/backups/opsilume
```

`--project` is the Docker Compose project of the installation (`opsilume` unless you changed it). It is required: the tool never guesses which installation is meant. `--dir` is where backups are kept; the tool writes nowhere else.

What `create` does, in order:

1. Runs `pg_dump --format=custom` inside the PostgreSQL container and streams it to `opsilume-YYYYMMDD-HHMMSS.dump.partial`. The application keeps running; `pg_dump` reads one consistent snapshot.
2. Reads the file's table of contents back with `pg_restore --list`. A file that is cut short or is not a backup fails here.
3. With `--verify-restore`: restores it into a scratch database on the same server, checks that every table has the row count recorded just before the dump and that every foreign key is valid, and drops the scratch database.
4. Computes its SHA-256, renames it to `opsilume-YYYYMMDD-HHMMSS.dump`, and records it in `backups.json` in the same directory (file, size, checksum, table and index counts, PostgreSQL version, database size).
5. With `--keep N`: removes the oldest backups **that this tool recorded**, so that N remain. Files it did not record are never touched, whatever they are called. Without `--keep` nothing is ever deleted.

If any step fails, the partial file is removed, nothing is renamed, earlier backups are left alone, the reason is written to `last-failure.json`, and the command exits with code 1.

Use `--verify-restore` at least for the scheduled nightly backup on a database of moderate size: it is the only check that proves the file restores. It needs free disk space for a second copy of the database while it runs, and compares row counts taken just before the dump, so on a database that is being written to at that moment it can report a difference in a busy table. Schedule it for a quiet hour.

Keep backups off the machine as well, and treat them as sensitive: a backup contains password hashes, API-key hashes, the audit log and whatever was in your logs. The tool does not encrypt or copy them anywhere.

### Scheduling

Nothing schedules backups for you, and nothing here was installed on any machine. The application has no scheduler of its own for this on purpose: a backup that runs inside the thing it protects stops when that thing does. Use the host's scheduler. Examples, to adapt:

```cron
# crontab on the host: nightly at 02:30 with a restore test, keeping 14; and a check at 08:00 that one exists
30 2 * * *  cd /opt/opsilume && npm run -s backup -- create --project opsilume --dir /srv/backups/opsilume --keep 14 --verify-restore >> /var/log/opsilume-backup.log 2>&1
0 8 * * *   cd /opt/opsilume && npm run -s backup -- status --dir /srv/backups/opsilume --max-age-hours 26 || echo "OPSILUME backups need attention" | mail -s "OPSILUME backup" ops@example.com
```

A systemd timer or launchd job works the same way: run `create`, and separately run `status` and act on a non-zero exit code. The second job matters more than the first. A backup job that silently stopped running produces no error anywhere; only "the newest backup is too old" reveals it.

### Retention

`--keep N` keeps the N newest backups made by the tool. There is no built-in daily/weekly/monthly scheme. If you need one, run a second `create` into another directory on a weekly schedule with its own `--keep`. Copy backups elsewhere with your own tooling before they rotate out.

### Checking backups

```bash
npm run backup -- status --dir /srv/backups/opsilume --max-age-hours 26     # is there a recent, complete backup, and did the last attempt succeed?
npm run backup -- verify --project opsilume --file /srv/backups/opsilume/opsilume-20261115-023000.dump             # readable, and unchanged since it was written?
npm run backup -- verify --project opsilume --file ... --restore                                                # and does it restore?
```

`status` fails (exit code 1) when there is no backup, when the newest is older than the limit, when the last attempt failed, when an unfinished file is lying around, or when a recorded backup is missing or has changed size. `verify` fails when the file's checksum differs from the one recorded when it was taken, when PostgreSQL cannot read it, or, with `--restore`, when it does not restore.

### When a backup fails

The command prints `Backup FAILED:` with the reason and exits 1; `status` reports it until a later backup succeeds. Then:

1. **Nothing was lost by the failure itself.** No file was written and earlier backups are untouched. What you have lost is time: your newest good backup is getting older.
2. **Read the reason.** The usual ones:
   - *"Expected one running postgres container … found 0"*: the database is not running, or `--project` is wrong. `docker compose ps`.
   - *`pg_dump failed`*: the first line of PostgreSQL's own error follows. Disk full on the database volume and a migration running at that moment (it holds locks `pg_dump` waits for or conflicts with) are the common causes.
   - *An error writing the file*: the backup directory is full or not writable.
   - *"row counts differ"* with `--verify-restore`: the database was being written to between the count and the dump. Run it again at a quieter time; if it repeats on a quiet database, treat the backup as bad.
   - *"pg_restore cannot read it"*: the dump was cut short. Check disk space and run it again.
3. **Run it again by hand** and watch it succeed before leaving it to the scheduler.
4. **If it keeps failing, your recovery point is your newest good backup.** Check which that is with `status`, and that it verifies with `verify --restore`.
5. **Do not delete older backups to make room** until a new one has succeeded and verified.

### Backing up a live database: the risks

- `pg_dump` is consistent (one snapshot) but not instantaneous. Everything written after it starts is not in it.
- It reads the whole database. On the test machine a database of 610,000 rows dumped in about 12 seconds; expect it to compete with the application for disk while it runs.
- It takes a lock that conflicts with schema changes. Do not run it during an upgrade, and do not upgrade during it.
- The backup is as good as the moment it was taken. There is no way to restore to a time between two backups.

## Restoring

A restore never has to overwrite a database that is in use. Restore into a **new** database, check it, then point the application at it.

```bash
# 1. A new, empty database beside the current one
docker compose exec -T postgres psql -U opsilume -d postgres -c 'CREATE DATABASE opsilume_restored'

# 2. Restore the backup into it
docker compose exec -T postgres pg_restore -U opsilume -d opsilume_restored --no-owner --exit-on-error < opsilume-20261114-120000.dump

# 3. Check it (see below) before using it

# 4. Point the application at it: change the database name in DATABASE_URL (for Docker Compose,
#    in docker-compose.yml's x-app-env or an override file), with the SAME ENCRYPTION_KEY as
#    when the backup was taken, then recreate the application containers
docker compose --profile app up -d
```

The `migrate` step that runs on every start applies any migration the backup does not have yet, so a backup taken on an older version should restore under a newer one; this follows from how migrations work and was not tested. The reverse (a newer backup under older code) is not supported.

On a new machine: install as in [setup-guide.md](setup-guide.md) with `SEED_DEMO_DATA=false` and the original `.env` secrets, start only PostgreSQL (`docker compose up -d postgres`), then run steps 1, 2 and 4.

### Checking a restored database

At minimum, before trusting it:

```bash
docker compose exec -T postgres psql -U opsilume -d opsilume_restored -c \
  'SELECT (SELECT count(*) FROM "Organization") AS organisations, (SELECT count(*) FROM "Incident") AS incidents, (SELECT count(*) FROM "Investigation") AS investigations, (SELECT max("createdAt") FROM "AuditLog") AS last_audit_entry'
```

The last audit entry tells you how old the backup really is. Then sign in and open a recent investigation.

## What was tested

`npm run drill:backup` (`scripts/backup-restore-drill.mjs`) does all of the following on the isolated test stack, and runs in CI on every pull request. Last run locally on 15 November 2026 (9 steps, 60 seconds):

| Step | Checked |
|---|---|
| Create state | An ingested log line (with an idempotency key), a completed investigation with 60 evidence items, a remediation action awaiting approval, an API key |
| Back up | `pg_dump --format=custom` of the running database: 37 tables, 611,000 rows, 12 MB |
| Restore | `pg_restore` into a second database on the same server (5 seconds). The source database is not touched |
| Compare | Every table's row count is identical. All 100 indexes exist, including the vector index that Prisma cannot describe. The 3 extensions and the migration history are identical. All 55 foreign keys are present and no row is left without its parent. Content digests of incidents, investigations (including the stored reports), evidence, approvals, remediation actions, accounts and embeddings are identical |
| Use it | A second API and worker are started against the restored database. The existing accounts sign in. The investigation, the action awaiting approval and the log line from before the backup are there. The API key still authenticates, and the idempotency key is still remembered. A new investigation runs to a stored report, and does not appear in the source database |
| Backup tool: create | `backup create --verify-restore` writes one finished file and no partial one, records its checksum and contents, and refuses to run without `--project` |
| Backup tool: damage | A truncated copy, a copy with one byte changed, and a file that is not a backup are each refused by `verify`; the untouched original verifies |
| Backup tool: rotation | Three backups with `--keep 2`: the oldest is removed and the two newest remain. Four files the tool did not make, one of them named like a backup, are untouched. `--keep 0` is refused |
| Backup tool: failure | With PostgreSQL stopped, `create` exits 1 and says so; no file is written; earlier backups are unchanged; `status` fails until the next good backup. A backup older than the limit is reported |

What that does and does not show:

- **Shown**: a `pg_dump` backup restores completely and the application works against it, on the same PostgreSQL version and server; the tool detects damaged files, rotates only its own, and makes a failure visible.
- **Not tested**: restoring on a different machine or a different PostgreSQL major version; a database larger than about 600,000 rows; restoring while under load; a backup taken by any other method (volume snapshots, `pg_basebackup`); loss of the `ENCRYPTION_KEY`; the scheduler examples above (they were written, not run); a full backup directory.
- **Not provided**: scheduling, copying backups off the machine, encryption of backup files, replication, point-in-time recovery, any form of high availability or disaster recovery beyond "restore the last backup".

## Does a backup hold everything needed to recover?

| Needed | In the database backup? |
|---|---|
| All application data, accounts, audit log, encrypted integration credentials | Yes |
| `ENCRYPTION_KEY`, `JWT_SECRET`, `INTERNAL_SERVICE_TOKEN`, the database password (`.env`) | **No.** Keep them separately. Without `ENCRYPTION_KEY`, stored GitHub tokens and webhook secrets cannot be decrypted and must be entered again. A new `JWT_SECRET` signs everyone out, which is harmless |
| The application itself | No. It is rebuilt from the repository at the version you were running; note the commit |
| Queue contents (Redis) | No, and not needed: see below |
| TLS certificates, reverse-proxy configuration, the host scheduler entries | No. They are yours |

## Redis

Redis holds no data that exists nowhere else. It is configured with an append-only file written once a second to the `redisdata` volume, so it survives a restart and loses at most about a second of queue changes if it is killed.

If Redis's data is lost entirely, or you restore PostgreSQL without it:

- **Schedules** of the repeating jobs (alert evaluation, retention, the sweep for stranded work) are put back by the worker within a minute.
- **An investigation that was waiting** is put back on the queue by the sweep once it has waited two minutes, and runs once.
- **An investigation that was running** is recorded as interrupted and has to be started again by a person.
- **Knowledge documents being indexed** are picked up again by the sweep after ten minutes.
- **A GitHub synchronisation that was queued** is lost; start it again from the interface.

The first three were tested by the failure drills (`npm run drills`: Redis killed, and Redis wiped, while an investigation was waiting). The last two follow from the code and were not drilled.

After restoring PostgreSQL from a backup, investigations that were waiting or running when the backup was taken are in the restored database in that state. The same rules apply to them: waiting ones are queued again, running ones are ended as interrupted by the sweep, once they are more than twenty minutes old.

## Removing one organisation is not a restore

To remove a single organisation at the end of a trial, use `npm run org:remove` ([customer-pilot-guide.md](customer-pilot-guide.md)). To get one organisation back from a backup there is no tool: restore the whole backup into a separate database and copy what you need.
