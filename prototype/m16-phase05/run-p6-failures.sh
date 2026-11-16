#!/usr/bin/env bash
set -u
cd "$(dirname "$0")"
dc() { docker compose -f compose.yml "$@"; }
build() { dc exec -T api1 node exp-p6.mjs build "$@" >/dev/null; }
state() { dc exec -T api1 node exp-p6.mjs state "$1"; }

echo "== route lock wait during a 1,000,000-action clearance (repeated row-lock attempts)"
build 1000000 2000
dc exec -T api1 rm -f /results/p6-clear-finished /results/p6-clear-started
dc exec -T api1 node exp-p6.mjs measure 1000000-rowloop >/dev/null &
dc exec -T api2 node exp-p6.mjs probe-row-loop 1000000; wait

echo "== process killed EARLY in the clearance (2 s in), 250,000 actions"
build 250000 500; state before-early-kill
D=$(dc exec -T api1 node exp-p6.mjs digest)
dc exec -T api1 node exp-p6.mjs clear-once early-kill - "$D" & sleep 2.5; dc exec -T api1 sh -c 'kill -9 $(cat /results/p6-nodepid-early-kill) && echo killed'; wait
state after-early-kill
dc exec -T api1 node exp-p6.mjs clear-once retry-after-early-kill - "$D"
state after-retry

echo "== process killed after the cleared record, before commit, 250,000 actions"
build 250000 500
D=$(dc exec -T api1 node exp-p6.mjs digest)
dc exec -T api1 node exp-p6.mjs clear-once late-kill after_cleared_record "$D"; echo "exit=$?"
state after-late-kill
dc exec -T api1 node exp-p6.mjs clear-once late-kill-old-digest - "$D"
dc exec -T api1 node exp-p6.mjs clear-once late-kill-new-digest -
state after-late-retry

echo "== database interruption: the clearing backend terminated 1.5 s in, 250,000 actions"
build 250000 500
D=$(dc exec -T api1 node exp-p6.mjs digest)
dc exec -T api1 rm -f /results/p6-backend-db-kill
dc exec -T api1 node exp-p6.mjs clear-once db-kill - "$D" & dc exec -T api2 node exp-p6.mjs kill-db db-kill 1500; wait
state after-db-kill

echo "== two clearances at once with the same digest, 250,000 actions"
build 250000 500
D=$(dc exec -T api1 node exp-p6.mjs digest)
dc exec -T api1 node exp-p6.mjs clear-once concurrent-1 - "$D" & dc exec -T api2 node exp-p6.mjs clear-once concurrent-2 - "$D" & wait
state after-concurrent

echo "== changed after inspection, then a repeated attempt, 250,000 actions"
build 250000 500
D=$(dc exec -T api1 node exp-p6.mjs digest)
dc exec -T db psql -U proto -d proto -q -c "UPDATE action SET status = 'PROPOSED' WHERE id = 'a-1'"
dc exec -T api1 node exp-p6.mjs clear-once stale-digest - "$D"
D2=$(dc exec -T api1 node exp-p6.mjs digest)
dc exec -T api1 node exp-p6.mjs clear-once fresh-digest - "$D2"
dc exec -T api1 node exp-p6.mjs clear-once repeated-same-digest - "$D2"
state after-repeated
