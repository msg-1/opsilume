#!/usr/bin/env bash
# Experiment E: clearance at increasing sizes, then the concurrency and interruption checks.
set -u
cd "$(dirname "$0")"
dc() { docker compose -f compose.yml "$@"; }
for spec in "1000 10" "10000 50" "100000 200"; do
  set -- $spec
  echo "== size: $1 actions, $2 organisations"
  dc exec -T api1 node exp-e.mjs build "$1" "$2"
  # A claim attempted from the other container while the clearance runs (it starts 50 ms in).
  dc exec -T api1 node exp-e.mjs measure "$1" & (sleep 0.05; dc exec -T api2 node exp-e.mjs claim "during-$1" a-10) & wait
done

echo "== changes after inspection invalidate the clearance"
dc exec -T api1 node exp-e.mjs build 1000 10 >/dev/null
D=$(dc exec -T api1 node exp-e.mjs digest)
dc exec -T db psql -U proto -d proto -q -c "UPDATE action SET status = 'PROPOSED' WHERE id = 'a-1'"
dc exec -T api1 node exp-e.mjs clear stale-digest - "$D"
dc exec -T api1 node exp-e.mjs clear fresh-digest -

echo "== two clearances at once, with the same digest"
dc exec -T api1 node exp-e.mjs build 10000 50 >/dev/null
D=$(dc exec -T api1 node exp-e.mjs digest)
dc exec -T api1 node exp-e.mjs clear concurrent-api1 - "$D" & dc exec -T api2 node exp-e.mjs clear concurrent-api2 - "$D" & wait

echo "== an interrupted clearance (killed after the cleared record, before commit), then repeated"
dc exec -T api1 node exp-e.mjs build 10000 50 >/dev/null
D=$(dc exec -T api1 node exp-e.mjs digest)
dc exec -T api1 node exp-e.mjs clear interrupted after_cleared_record "$D"; echo "exit=$?"
dc exec -T db psql -U proto -d proto -At -c "SELECT 'after kill: db head=' || journal_seq FROM installation_state; SELECT 'approvals still current=' || count(*) FROM approval WHERE superseded_at IS NULL; SELECT 'cleared audits=' || count(*) FROM audit WHERE action = 'recovery_cleared'"
dc exec -T api1 sh -c 'echo "cleared records in journal=$(grep -c "\"type\":\"cleared\"" /state/journal.log)"'
dc exec -T api1 node exp-e.mjs clear retry-old-digest - "$D"
dc exec -T api1 node exp-e.mjs clear retry-new-digest -
dc exec -T db psql -U proto -d proto -At -c "SELECT 'after retry: db head=' || journal_seq FROM installation_state; SELECT 'approvals still current=' || count(*) FROM approval WHERE superseded_at IS NULL; SELECT 'cleared audits=' || count(*) FROM audit WHERE action = 'recovery_cleared'"
