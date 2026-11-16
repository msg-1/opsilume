#!/usr/bin/env bash
# HARNESS SMOKE ONLY. Exercises the harness flow end to end on Docker Desktop: run -> "cut" -> check -> recover ->
# run, with continuing state, a journal one claim ahead (clearance), a torn final line (repair) and a deliberately lost
# committed claim (FAIL, then the run is stopped). It is NOT a P7 durability test: a container kill is not a power
# cut, and Docker Desktop is not native Linux. The run's failure model is HARNESS-SMOKE, which can never count.
#   ./smoke-docker-desktop.sh <work dir outside the repository>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="${1:?work directory (outside the repository)}"
port="${P7_SMOKE_PORT:-8797}"
proj=opspilot-m16-p7-smoke
run="smoke-$(date +%Y%m%dT%H%M%S)"
mkdir -p "$work/recorder" "$work/evidence"
docker compose ls -a --format json | grep -q "\"$proj\"" && { echo "refused: the $proj project exists (inspect it, then: docker compose -p $proj down -v)"; exit 1; }
export P7_RECORDER_URL="http://host.docker.internal:$port" P7_EVIDENCE_HOST="$work/evidence"
dc() { docker compose -p "$proj" -f "$here/compose.yml" "$@"; }
R() { local c="$1"; shift; node "$here/recorder.mjs" "$c" --dir "$work/recorder" --run "$run" "$@"; }
P() { dc exec -T harness node p7.mjs "$@" --run "$run"; }
rc() { set +e; "$@"; local r=$?; set -e; return $r; }
expect_exit() { local want="$1"; shift; local got=0; "$@" || got=$?; [ "$got" -eq "$want" ] || { echo "SMOKE FAILED: expected exit $want, got $got: $*"; exit 1; }; }
assert_result() { node -e 'const [f,c,x]=process.argv.slice(1); const r=JSON.parse(require("fs").readFileSync(f,"utf8")); const s=JSON.stringify({verdict:r.verdict,fails:r.fails,inconclusive:r.inconclusive,relation:r.relation,needsRecovery:r.needsRecovery,counts:r.counts}); if(!eval(x)){console.error(`SMOKE FAILED cycle ${c}: ${x}`, s); process.exit(1)} console.log(`cycle ${c} ok:`, s)' "$work/evidence/$run/cycle-$(printf %04d "$1")/result.json" "$1" "$2"; }
cut_now() { R cut --cycle "$1" --min-seconds "$2" --max-seconds "$3" --command-json "[\"docker\",\"compose\",\"-p\",\"$proj\",\"-f\",\"$here/compose.yml\",\"kill\"]"; R confirm-cut --cycle "$1" --power-was-cut yes --note "smoke: container kill, not a power cut"; }
start_run() { (P run "$@" >"$work/run-$run-$2.log" 2>&1 || true) & runpid=$!; sleep 6; }
recover() {
  local out code=0
  out="$(P recover --cycle "$1")" || code=$?
  echo "$out"
  if [ "$code" -eq 4 ]; then
    local d; d="$(node -e "console.log(JSON.parse(process.argv[1]).inspection.digest)" "$out")"
    P recover --cycle "$1" --clear-digest "$d"
  elif [ "$code" -ne 0 ]; then echo "SMOKE FAILED: recover exited $code"; exit 1; fi
}

node "$here/recorder.mjs" serve --dir "$work/recorder" --port "$port" >"$work/recorder-$run.log" 2>&1 &
rpid=$!
trap 'kill $rpid 2>/dev/null || true' EXIT
sleep 1
R create-run --failure-model HARNESS-SMOKE --write-cache "write back" --flush-honoured yes --plp unknown --machine "Docker Desktop (harness smoke only)" >/dev/null
dc up -d --wait
P init

echo "== cycle 1: two workers, all containers killed at a random moment"
start_run --cycle 1 --workers 2 --pool 50000
cut_now 1 4 8; wait "$runpid" || true
dc up -d --wait
expect_exit 3 P check --cycle 1
assert_result 1 "r.verdict==='INCONCLUSIVE' && r.fails.length===0 && r.inconclusive.includes('NOT_A_DURABILITY_RUN') && r.counts.claimAcks>0 && !r.countsTowardPhysicalPowerLoss"
recover 1

echo "== cycle 2: the claim process dies after a claim append, before commit -> journal one ahead; plus a torn line -> repair, then clearance"
start_run --cycle 2 --workers 1 --pool 1000 --smoke-crash-after-claim-append
cut_now 2 0 0; wait "$runpid" || true
dc up -d --wait
dc exec -T harness sh -c 'printf "{\"type\":\"dispatch\",\"se" >> /state/journal.log'   # and a torn final line: recover must repair, then clear
expect_exit 3 P check --cycle 2
assert_result 2 "r.fails.length===0 && r.relation==='journal-one-ahead' && r.needsRecovery.join()==='repair-torn-tail,clear' && r.counts.claimAcks===2"
recover 2

echo "== cycle 3: continuing state after clearance; a torn final line is injected after the kill -> repair"
start_run --cycle 3 --workers 2 --pool 50000
cut_now 3 3 6; wait "$runpid" || true
dc up -d --wait
dc exec -T harness sh -c 'printf "{\"type\":\"claim\",\"seq\":99999,\"act" >> /state/journal.log'
expect_exit 3 P check --cycle 3
assert_result 3 "r.fails.length===0 && r.needsRecovery[0]==='repair-torn-tail' && r.journal.tornBytes===32 && !r.fails.includes('HISTORY_DIFFERS')"
recover 3

echo "== cycle 4: one acknowledged committed claim is deleted from the database after the kill -> FAIL, run stopped"
start_run --cycle 4 --workers 2 --pool 50000
cut_now 4 3 6; wait "$runpid" || true
dc up -d --wait
dc exec -T db psql -q -U proto -d proto -c "DELETE FROM audit WHERE action = 'execute_start' AND ref = 'c0004aw1-1'"   # the cycle's first claim: certainly acknowledged
expect_exit 2 P check --cycle 4
assert_result 4 "r.verdict==='FAIL' && r.fails.includes('ACKNOWLEDGED_CLAIM_MISSING_FROM_DATABASE') && r.fails.includes('HISTORY_DIFFERS')"
echo "== after the FAIL: recover and the next cycle must both be refused"
expect_exit 1 P recover --cycle 4
expect_exit 1 P run --cycle 5 --workers 1 --pool 10

R status
dc down -v
echo "SMOKE PASSED (harness flow only; not a durability result). Evidence: $work/evidence/$run, recorder: $work/recorder/runs/$run"
