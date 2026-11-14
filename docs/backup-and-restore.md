# Backup and restore

What has to be backed up, how to do it, how to restore, and what was actually tested. Written for whoever operates an installation run with Docker Compose.

**There is no point-in-time recovery.** A backup is a snapshot taken when you run the command; everything written after it is lost if you restore it. Nothing here takes backups for you: schedule them yourself.

## What holds state

| Where | What | Back it up? |
|---|---|---|
| **PostgreSQL** (volume `pgdata`) | Everything that matters: organisations, accounts, services, incidents, telemetry, investigations and their evidence, approvals, the audit log, encrypted integration credentials, knowledge documents and their embeddings | **Yes.** This is the system of record |
| **`.env`** | `ENCRYPTION_KEY`, `JWT_SECRET`, `INTERNAL_SERVICE_TOKEN`, the database password | **Yes, separately and securely.** Without `ENCRYPTION_KEY` a restored database's GitHub tokens and webhook secrets cannot be decrypted. Do not store it next to the database backup |
| **Redis** (volume `redisdata`) | The job queue: investigations and indexing jobs that are waiting or running, and the schedules of the repeating jobs | No. See [Redis](#redis) |
| Containers | Nothing. They can be rebuilt from the repository |

## Taking a backup

With the application running (PostgreSQL takes a consistent snapshot; nothing needs to stop):

```bash
docker compose exec -T postgres pg_dump -U opspilot -d opspilot --format=custom > opspilot-$(date +%Y%m%d-%H%M%S).dump
```

The custom format is compressed and is what `pg_restore` reads. On the seeded demonstration data it is under 1 MB; expect it to be dominated by logs and metric samples in real use.

Keep more than one, keep them off the machine, and treat them as sensitive: a backup contains password hashes, API-key hashes, the audit log and whatever was in your logs.

## Restoring

A restore never has to overwrite a database that is in use. Restore into a **new** database, check it, then point the application at it.

```bash
# 1. A new, empty database beside the current one
docker compose exec -T postgres psql -U opspilot -d postgres -c 'CREATE DATABASE opspilot_restored'

# 2. Restore the backup into it
docker compose exec -T postgres pg_restore -U opspilot -d opspilot_restored --no-owner --exit-on-error < opspilot-20261114-120000.dump

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
docker compose exec -T postgres psql -U opspilot -d opspilot_restored -c \
  'SELECT (SELECT count(*) FROM "Organization") AS organisations, (SELECT count(*) FROM "Incident") AS incidents, (SELECT count(*) FROM "Investigation") AS investigations, (SELECT max("createdAt") FROM "AuditLog") AS last_audit_entry'
```

The last audit entry tells you how old the backup really is. Then sign in and open a recent investigation.

## What was tested

`npm run drill:backup` (`scripts/backup-restore-drill.mjs`) does all of the following on the isolated test stack, and runs in CI on every pull request. It was last run locally on 14 November 2026:

| Step | Checked |
|---|---|
| Create state | An ingested log line (with an idempotency key), a completed investigation with 60 evidence items, a remediation action awaiting approval, an API key |
| Back up | `pg_dump --format=custom` of the running database: 37 tables, about 36,000 rows, 0.8 MB |
| Restore | `pg_restore` into a second database on the same server. The source database is not touched |
| Compare | Every table's row count is identical. All 100 indexes exist, including the vector index that Prisma cannot describe. The 3 extensions and the migration history are identical. All 55 foreign keys are present and no row is left without its parent. Content digests of incidents, investigations (including the stored reports), evidence, approvals, remediation actions, accounts and embeddings are identical |
| Use it | A second API and worker are started against the restored database. The existing accounts sign in. The investigation, the action awaiting approval and the log line from before the backup are there. The API key still authenticates, and the idempotency key is still remembered, so a client that retries across a restore does not store its batch twice. A new investigation runs to a stored report, and does not appear in the source database |

What that does and does not show:

- **Shown**: a `pg_dump` backup restores completely and the application works against it, on the same PostgreSQL version and server.
- **Not tested**: restoring on a different machine or a different PostgreSQL major version; a database of realistic size (restore time grows with it, and was 0.5 seconds here); restoring while under load; a backup taken by any other method (volume snapshots, `pg_basebackup`); loss of the `ENCRYPTION_KEY`.
- **Not provided**: scheduled backups, retention of backups, encryption of backup files, replication, point-in-time recovery.

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
