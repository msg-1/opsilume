#!/usr/bin/env sh
# Rebuilds the demonstration organisation (and only it) and starts its rule-based investigations.
# Run from cron on the host, for example daily at 03:15:
#   15 3 * * * cd /opt/opsilume/deploy/public-demo && ./reset.sh >> /var/log/opsilume-demo-reset.log 2>&1
# A second run while one is running stops without doing anything (exit 3).
set -eu
cd "$(dirname "$0")"
exec docker compose run --rm --no-deps migrate node dist/scripts/public-demo.js reset --investigate
