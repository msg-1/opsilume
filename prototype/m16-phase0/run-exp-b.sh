#!/usr/bin/env bash
# Experiment B: two prototype API containers sharing the state volume. Bash, so that word splitting is explicit.
set -u
cd "$(dirname "$0")"
dc() { docker compose -f compose.yml "$@"; }
labels() { local run=$1 procs=$2; if [ "$procs" = 1 ]; then echo "$run-api1 $run-api2"; else for c in api1 api2; do for i in $(seq 0 $((procs-1))); do printf "%s " "$run-$c.$i"; done; done; fi; }

echo "== B1: concurrent claims, one process per container (300 own + 50 shared each; every 25th own claim rolled back)"
dc exec -T api1 node exp-b-setup.mjs 600 50
dc exec -T api1 node exp-b-worker.mjs b1-api1 1 300 50 25 1 & dc exec -T api2 node exp-b-worker.mjs b1-api2 301 600 50 25 1 & wait
dc exec -T api1 node exp-b-verify.mjs b1 $(labels b1 1)

echo "== B3: a process killed while holding the state lock, right after flushing its claim record"
dc exec -T api1 node exp-b-setup.mjs 600 0
dc exec -T api1 node exp-b-crash.mjs a-1-1 2000 & sleep 0.5
dc exec -T api2 node exp-b-worker.mjs b3-api2 301 320 0 0 1
wait
dc exec -T api1 node exp-b-verify.mjs b3 b3-api2
dc exec -T api1 node exp-b-recover.mjs b3
dc exec -T api2 node exp-b-worker.mjs b3-after-api2 321 340 0 0 1
dc exec -T api1 node exp-b-verify.mjs b3-after b3-after-api2

echo "== B4: a container restarted in the middle of a run of claims"
dc exec -T api1 node exp-b-setup.mjs 600 0
dc exec -T api2 node exp-b-worker.mjs b4-api2 301 600 0 0 1 & sleep 1.5
dc restart -t 0 api2 >/dev/null 2>&1; wait
dc exec -T api1 node exp-b-verify.mjs b4
dc exec -T api1 node exp-b-worker.mjs b4-after-api1 1 20 0 0 1
dc exec -T api1 node exp-b-verify.mjs b4-after b4-after-api1

echo "== B5: claims racing a clearance that holds the state lock for 3 s"
dc exec -T api1 node exp-b-setup.mjs 600 0
dc exec -T api1 node exp-b-recover.mjs b5 3000 & sleep 0.5
dc exec -T api2 node exp-b-worker.mjs b5-api2 301 330 0 0 1
wait
dc exec -T api1 node exp-b-verify.mjs b5 b5-api2

echo "== B6: flock(1) between the two containers: 500 locked appends each, then a holder killed"
dc exec -T api1 sh -c 'rm -f /state/flock.log /state/flock.lock /state/kill.lock'
start=$(date +%s%N)
dc exec -T api1 sh -c 'for i in $(seq 1 500); do flock /state/flock.lock sh -c "echo api1-$i >> /state/flock.log"; done' &
dc exec -T api2 sh -c 'for i in $(seq 1 500); do flock /state/flock.lock sh -c "echo api2-$i >> /state/flock.log"; done' &
wait
end=$(date +%s%N)
dc exec -T api1 sh -c 'echo lines=$(wc -l < /state/flock.log) unique=$(sort -u /state/flock.log | wc -l) malformed=$(grep -cvE "^api[12]-[0-9]+$" /state/flock.log)'
echo "elapsed_ms=$(( (end-start)/1000000 ))"
dc exec -d api1 sh -c 'flock /state/kill.lock sleep 60'
sleep 1
dc exec -T api2 sh -c 'flock -n /state/kill.lock true && echo "while held: acquired (unexpected)" || echo "while held: refused (expected)"'
t0=$(date +%s%N)
dc exec -T api1 sh -c 'pkill -9 -f "sleep 60"' 
dc exec -T api2 sh -c 'flock -w 10 /state/kill.lock true && echo "after holder killed: acquired"'
t1=$(date +%s%N)
echo "acquire_after_kill_ms=$(( (t1-t0)/1000000 ))"
