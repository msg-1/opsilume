#!/usr/bin/env bash
# P6 at increasing sizes, each with a row-lock probe and a claim probe started 1 s into the clearance from the other container.
set -u
cd "$(dirname "$0")"
dc() { docker compose -f compose.yml "$@"; }
for spec in "100000 200" "250000 500" "500000 1000" "1000000 2000"; do
  set -- $spec
  echo "== $1 actions, $2 organisations"
  dc exec -T api1 node exp-p6.mjs build "$1" "$2"
  dc exec -T api1 rm -f /results/p6-clear-started
  dc exec -T api1 node exp-p6.mjs measure "$1" &
  dc exec -T api2 sh -c 'while [ ! -f /results/p6-clear-started ]; do sleep 0.05; done; sleep 1' && { dc exec -T api2 node exp-p6.mjs probe-row "$1" & dc exec -T api2 node exp-p6.mjs probe-claim "$1" & wait; }
  wait
done
