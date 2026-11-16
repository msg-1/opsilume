#!/usr/bin/env bash
# Real backup and restore of the PROTOTYPE database only (opspilot-m16-proto). The state volume is NOT restored.
set -eu
cd "$(dirname "$0")"
dc() { docker compose -f compose.yml "$@"; }
dc exec -T api1 node exp-c-restore.mjs setup
dc exec -T db pg_dump -U proto -d proto --format=custom -f /tmp/proto-backup.dump
dc exec -T api1 node exp-c-restore.mjs after-backup
dc exec -T db psql -U proto -d proto -q -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
dc exec -T db pg_restore -U proto -d proto --no-owner --exit-on-error /tmp/proto-backup.dump
dc exec -T api1 node exp-c-restore.mjs after-restore
