#!/usr/bin/env bash
# HARNESS-SMOKE ONLY. Exercises the harness end to end on Docker Desktop. It is NOT a P7 durability test: a container
# kill is not a power cut and Docker Desktop is not native Linux. Both runs are HARNESS-SMOKE, which can never count.
# Run A (stops on INCONCLUSIVE, like a qualifying run): isolation, sizing refusal, two processes, check retry, a
#   recorder restart, the INCONCLUSIVE stop, recovery of the stopped cycle.
# Run B (continues A: same database and journal, new run id and key, count from zero): adopt; a manual-cut rehearsal
#   with a killed worker process; the journal one claim ahead with a torn line (quarantine, clearance by digest); an
#   invalid complete final line (FAIL, never repaired).
#   ./smoke-docker-desktop.sh <work dir outside the repository>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="${1:?work directory (outside the repository)}"
port="${P7_SMOKE_PORT:-8797}"
proj=opspilot-m16-p7-smoke
stamp="$(date +%Y%m%dT%H%M%S)"
runA="harness-smoke-$stamp-a"; runB="harness-smoke-$stamp-b"
mkdir -p "$work/recorder" "$work/evidence"
docker compose ls -a --format json | grep -q "\"$proj\"" && { echo "refused: the $proj project exists (inspect it, then: docker compose -p $proj down -v)"; exit 1; }
hashes() { (cd "$work" && find "$@" -type f ! -path "*/keys/*" -print0 2>/dev/null | sort -z | xargs -0 shasum -a 256 2>/dev/null) || true; }

# Evidence from earlier smoke runs must survive this one unchanged.
prior="$work/.prior-evidence-$stamp.sha256"
hashes evidence recorder >"$prior"

node "$here/recorder.mjs" serve --dir "$work/recorder" --port "$port" >"$work/recorder-$stamp.log" 2>&1 & rpid=$!
trap 'kill $rpid 2>/dev/null || true' EXIT
sleep 1
keyfile() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).keyFile))'; }
keyA="$(node "$here/recorder.mjs" create-run --dir "$work/recorder" --run "$runA" --failure-model HARNESS-SMOKE --stop-on-inconclusive --machine "Docker Desktop (harness smoke only)" | keyfile)"
run="$runA"
export P7_RUN="$runA" P7_RECORDER_TARGET="host.docker.internal:$port" P7_KEY_FILE_HOST="$keyA" P7_EVIDENCE_HOST="$work/evidence"
dc() { docker compose -p "$proj" -f "$here/compose.yml" "$@"; }
R() { local c="$1"; shift; node "$here/recorder.mjs" "$c" --dir "$work/recorder" --run "$run" "$@"; }
P() { dc exec -T harness node p7.mjs "$@"; }
now() { node -e 'console.log(new Date().toISOString())'; }
expect_exit() { local want="$1"; shift; local got=0; "$@" || got=$?; [ "$got" -eq "$want" ] || { echo "SMOKE FAILED: expected exit $want, got $got: $*"; exit 1; }; }
expect_refusal() { local pat="$1"; shift; local out; out="$("$@" 2>&1)" && { echo "SMOKE FAILED: should have been refused: $*"; exit 1; }; echo "$out" | grep -q "$pat" && echo "ok: refused ($pat)" || { echo "SMOKE FAILED: refusal did not mention '$pat': $out"; exit 1; }; }
assert_json() { node -e 'const [f,x]=process.argv.slice(1); const r=JSON.parse(require("fs").readFileSync(f,"utf8")); if(!eval(x)){console.error(`SMOKE FAILED: ${x}`, JSON.stringify({verdict:r.verdict,fails:r.fails,inconclusive:r.inconclusive,relation:r.relation,counts:r.counts,silent:r.silentWorkerStops,cut:r.cut,sizing:r.sizing,rate:r.measuredRate}).slice(0,900)); process.exit(1)} console.log(`ok: ${x.slice(0,120)}`)' "$1" "$2"; }
result() { ls "$work/evidence/$run"/cycle-$(printf %04d "$1")*/result.json | tail -1; }
kill_stack() { docker compose -p "$proj" -f "$here/compose.yml" kill; }
cut_command() { R cut --cycle "$1" --min-seconds "$2" --max-seconds "$3" --command-json "[\"docker\",\"compose\",\"-p\",\"$proj\",\"-f\",\"$here/compose.yml\",\"kill\"]"; R confirm-cut --cycle "$1" --power-was-cut yes --evidence "smoke: container kill, not a power cut"; }
# The manual procedure, rehearsed without any power cut: the recorder prompts, the "operator" (this script) acts at the
# prompt, notes when, and attests it afterwards.
cut_manual() {
  R cut --cycle "$1" --min-seconds "$2" --max-seconds "$3" | tee "$work/manual-cut-$run-$1.txt"
  grep -q "CUT THE POWER NOW" "$work/manual-cut-$run-$1.txt" || { echo "SMOKE FAILED: no manual prompt"; exit 1; }
  local from to; from="$(now)"; kill_stack; to="$(now)"
  R confirm-cut --cycle "$1" --power-was-cut yes --attested-from "$from" --attested-to "$to" --evidence "rehearsal: the operator killed the containers at the prompt; not a power cut"
}
SIZE="--max-seconds 40 --rate 300"
start_proc() { (P run --cycle "$1" --proc "$2" --workers 2 $SIZE >"$work/run-$run-$1$2.log" 2>&1 || true) & pids+=($!); }
# A kill can land between a claim append and its commit: then recover stops with exit 4 for the operator's digest.
recover() { local out code=0; out="$(P recover --cycle "$1")" || code=$?; echo "$out" | cut -c1-300
  if [ "$code" -eq 4 ]; then P recover --cycle "$1" --clear-digest "$(node -e 'console.log(JSON.parse(process.argv[1]).inspection.digest)' "$out")" | cut -c1-300
  elif [ "$code" -ne 0 ]; then echo "SMOKE FAILED: recover exited $code"; exit 1; fi; }
db_unique() { dc exec -T db psql -qtA -U proto -d proto -c "SELECT count(*) = count(DISTINCT meta->>'seq') AND count(*) = count(DISTINCT ref) FROM audit WHERE action = 'execute_start'"; }
db_head() { dc exec -T db psql -qtA -U proto -d proto -c "SELECT journal_seq FROM installation_state"; }

dc up -d --wait

echo "== isolation: topology"
nets() { docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$(dc ps -q "$1")"; }
[ "$(nets db)" = "${proj}_p7db " ] || { echo "SMOKE FAILED: db networks"; exit 1; }
[ "$(nets harness)" = "${proj}_p7db ${proj}_p7gw " ] || { echo "SMOKE FAILED: harness networks"; exit 1; }
[ "$(nets gateway)" = "${proj}_egress ${proj}_p7gw " ] || { echo "SMOKE FAILED: gateway networks"; exit 1; }
for n in p7db p7gw; do [ "$(docker network inspect -f '{{.Internal}}' "${proj}_$n")" = true ] || { echo "SMOKE FAILED: $n not internal"; exit 1; }; done
for n in p7db:p7db0 p7gw:p7gw0 egress:p7eg0; do [ "$(docker network inspect -f '{{index .Options "com.docker.network.bridge.name"}}' "${proj}_${n%%:*}")" = "${n##*:}" ] || { echo "SMOKE FAILED: bridge name ${n##*:}"; exit 1; }; done
# Images declare ports (EXPOSE); what matters is that nothing is bound on the host.
for c in db gateway harness; do docker inspect -f '{{json .HostConfig.PortBindings}} {{json .NetworkSettings.Ports}}' "$(dc ps -q $c)" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const [b,p]=s.trim().split(" ").map(JSON.parse);if(Object.keys(b??{}).length||Object.values(p??{}).some(v=>v!==null)){console.error("SMOKE FAILED: host port binding",s);process.exit(1)}})'; done
echo "ok: db only on p7db; harness on p7db + p7gw; gateway on p7gw + egress; internal networks internal; bridges named for the firewall; nothing published"
echo "== isolation: netcheck from inside the harness (not strict: HARNESS-SMOKE)"
P netcheck | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);for(const p of r.probes)console.log(p.ok?"  ok ":"  BAD", p.name, "->", p.outcome);console.log("host answers on the bridge address:", r.hostAnswersOnBridge);if(!r.ok)process.exit(1)})'
P init

echo "== RUN A ($runA). Sizing: an undersized or unsized pool is refused before anything is seeded or started"
expect_refusal "too small" P run --cycle 1 --proc a --workers 1 --max-seconds 600 --rate 250 --pool 50000
expect_refusal "no claim rate" P run --cycle 1 --proc a --workers 1 --max-seconds 40
expect_refusal "max-seconds" P run --cycle 1 --proc a --workers 1 --rate 250
[ "$(dc exec -T db psql -qtA -U proto -d proto -c 'SELECT count(*) FROM action')" = 0 ] && echo "ok: nothing was seeded by the refused starts" || { echo "SMOKE FAILED: actions seeded"; exit 1; }

echo "== A cycle 1: --proc a and --proc b concurrently (2 workers each); check retried; recorder restarted; INCONCLUSIVE stops the run"
pids=(); start_proc 1 a; sleep 3; start_proc 1 b; sleep 6   # b starts while a is already claiming
expect_refusal "sized for 40 s" R cut --cycle 1 --min-seconds 100 --max-seconds 100   # a cut later than the pools were sized for is refused
cut_command 1 5 8; wait "${pids[@]}" || true
dc up -d --wait
mkdir "$work/evidence/$run/cycle-0001"                    # as if an earlier check died right after creating its directory
expect_exit 1 P check --cycle 1 --smoke-fail-before-result-post   # and another died before sending its result
expect_exit 3 P check --cycle 1                           # the retry re-sends the saved result unchanged
[ -z "$(ls "$work/evidence/$run/cycle-0001")" ] && [ "$(ls -d "$work/evidence/$run"/cycle-0001-attempt-* | wc -l | tr -d ' ')" = 1 ] && echo "ok: check retried without overwriting evidence" || { echo "SMOKE FAILED: check retry"; exit 1; }
assert_json "$(result 1)" "r.fails.length===0 && r.counts.claimAcks>0 && r.measuredRate.totalPerSecond>0 && r.sizing.length===2 && r.sizing.every(z=>z.poolPerWorker===24000 && z.headroom===2)"
node -e 'const fs=require("fs");const a=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);const procs=[...new Set(a.map(x=>x.proc))].sort().join();const seqs=a.filter(x=>x.kind==="claim").map(x=>x.seq);if(procs!=="a,b"||new Set(seqs).size!==seqs.length){console.error("SMOKE FAILED: two-process acknowledgements",procs);process.exit(1)}console.log(`ok: ${seqs.length} claim acknowledgements from processes ${procs}, sequence numbers unique`)' "$work/recorder/runs/$run/acks/cycle-0001.jsonl"
[ "$(db_unique)" = t ] && echo "ok: committed claims have unique sequence numbers and unique action ids" || { echo "SMOKE FAILED: duplicate committed claims"; exit 1; }
kill "$rpid"; sleep 1
node "$here/recorder.mjs" serve --dir "$work/recorder" --port "$port" >>"$work/recorder-$stamp.log" 2>&1 & rpid=$!
sleep 1; echo "recorder restarted"
R status | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(r.stopped?.kind!=="inconclusive")process.exit(1);console.log("ok: run A stopped:",r.stopped.kind)})'
expect_refusal "run is stopped" P run --cycle 2 --proc a --workers 1 $SIZE
expect_refusal "has not been recovered" node "$here/recorder.mjs" create-run --dir "$work/recorder" --run "$runB" --failure-model HARNESS-SMOKE --continues "$runA"
recover 1                                                  # allowed: the stopped cycle itself; quarantine and clearance are not skipped
[ "$(dc exec -T db psql -qtA -U proto -d proto -c "SELECT count(*) FROM action WHERE status = 'APPROVED'")" = 0 ] && echo "ok: the cycle's unclaimed actions were retired (none left APPROVED)" || { echo "SMOKE FAILED: unclaimed actions not retired"; exit 1; }
headA="$(db_head)"
snapA="$(hashes "recorder/runs/$runA" "evidence/$runA")"

echo "== RUN B ($runB) continues A: same volumes, new run id and key, count from zero"
keyB="$(node "$here/recorder.mjs" create-run --dir "$work/recorder" --run "$runB" --failure-model HARNESS-SMOKE --continues "$runA" --machine "Docker Desktop (harness smoke only)" | keyfile)"
run="$runB"; export P7_RUN="$runB" P7_KEY_FILE_HOST="$keyB"
dbid="$(dc ps -q db)"
dc up -d --wait                                            # recreates only the harness container with the new run and key
[ "$(dc ps -q db)" = "$dbid" ] && [ "$(db_head)" = "$headA" ] && echo "ok: the database container and its state were not touched (head $headA)" || { echo "SMOKE FAILED: database changed"; exit 1; }
expect_refusal "use \"adopt\"" P init
expect_refusal "not_adopted" P run --cycle 1 --proc a --workers 1 $SIZE
P adopt
expect_refusal "already_adopted" P adopt
R status | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(r.cycles.length||r.streak.consecutivePhysicalPasses||r.stopped)process.exit(1);console.log("ok: run B starts with no cycles and a count of zero; continues",r.run.continues.run,"at head",r.run.continues.finalState.head)})'

echo "== B cycle 1: MANUAL CUT REHEARSAL (prompt, operator-attested interval); --proc b is killed (SIGKILL) beforehand"
pids=(); start_proc 1 a; start_proc 1 b; sleep 8
dc exec -T harness sh -c 'for d in /proc/[0-9]*; do tr "\0" " " <"$d/cmdline" 2>/dev/null | grep -q "[p]7.mjs run .*--proc b" && kill -9 "${d#/proc/}"; done; true'
echo "proc b killed"
cut_manual 1 13 15; wait "${pids[@]}" || true
dc up -d --wait
expect_exit 3 P check --cycle 1
# If the kill lands between b's claim append and its commit, the journal is one ahead and a's workers stop too (safe).
assert_json "$(result 1)" "r.fails.length===0 && r.inconclusive.includes('WORKLOAD_STOPPED_BEFORE_CUT') && r.silentWorkerStops.filter(w=>w.proc==='b').length===2 && (r.silentWorkerStops.length===2 || r.relation==='journal-one-ahead')"
assert_json "$(result 1)" "r.cut.how==='manual prompt' && r.cut.independentlyConfirmed===false && /attestation/.test(r.cut.operatorAttestedCut.label) && r.cut.operatorAttestedCut.from<=r.cut.operatorAttestedCut.to && r.cut.requestedAt<=r.cut.operatorAttestedCut.from && r.timeline.independentlyObservedCutAt===null"
assert_json "$(result 1)" "r.counts.windowFrom===$headA && r.counts.historyJournalClaims>r.counts.cycleJournalClaims && !r.fails.includes('HISTORY_DIFFERS')"
[ "$(db_unique)" = t ] && echo "ok: still unique across both runs" || { echo "SMOKE FAILED: duplicate committed claims"; exit 1; }
recover 1
node -e 'const fs=require("fs"),p=require("path");const d=process.argv[1];const f=fs.readdirSync(d).filter(x=>x.startsWith("cycle-summary-")).pop();const r=JSON.parse(fs.readFileSync(p.join(d,f),"utf8"));const t=r.timeline;const need=[r.cut.requestedAt,r.cut.operatorAttestedCut.from,t.bootTime,t.databaseReachableAt,t.verificationCompletedAt,t.recoveryStartedAt,t.recoveryCompletedAt];if(need.some(x=>!x)){console.error("SMOKE FAILED: rehearsal timeline",JSON.stringify(t));process.exit(1)}console.log("ok: rehearsal recorded request",r.cut.requestedAt,"| attested",r.cut.operatorAttestedCut.from,"to",r.cut.operatorAttestedCut.to,"| database reachable",t.databaseReachableAt,"| recovery",t.recoveryStartedAt,"to",t.recoveryCompletedAt)' "$(dirname "$(result 1)")"

echo "== B cycle 2: journal one claim ahead + a torn line -> observed quarantine, repair, inspection, clearance by digest (pool sized from the measured rate)"
pids=(); (P run --cycle 2 --proc a --workers 1 --max-seconds 20 --smoke-crash-after-claim-append >"$work/run-$run-2a.log" 2>&1 || true) & pids+=($!); sleep 6
cut_command 2 0 0; wait "${pids[@]}" || true
dc up -d --wait
dc exec -T harness sh -c 'printf "{\"type\":\"dispatch\",\"se" >> /state/journal.log'
expect_exit 3 P check --cycle 2
assert_json "$(result 2)" "r.fails.length===0 && r.relation==='journal-one-ahead' && r.quarantineRequired===true && r.needsRecovery.join()==='repair-torn-tail,clear' && /measured in cycle 1/.test(r.sizing[0].rateSource)"
out="$(P recover --cycle 2)" && code=0 || code=$?
[ "$code" -eq 4 ] || { echo "SMOKE FAILED: first recover should stop for the digest ($code)"; exit 1; }
node -e 'const r=JSON.parse(process.argv[1]); if(!r.quarantine.observed) process.exit(1); console.log("ok: quarantine observed:", r.quarantine.refusal)' "$out"
P recover --cycle 2 --clear-digest "$(node -e 'console.log(JSON.parse(process.argv[1]).inspection.digest)' "$out")" | cut -c1-300
expect_refusal "already recovered" P recover --cycle 2

echo "== B cycle 3: an invalid COMPLETE final line -> FAIL, never repaired, run stopped, cannot be continued"
pids=(); start_proc 3 a; sleep 2; start_proc 3 b; sleep 6
cut_command 3 3 5; wait "${pids[@]}" || true
dc up -d --wait
dc exec -T harness node -e 'const fs=require("fs");const f="/state/journal.log";let t=fs.readFileSync(f,"utf8");if(!t.endsWith("\n")){fs.appendFileSync(f,"\n");t+="\n"}const i=t.lastIndexOf("\"hash\":\"")+8;fs.writeFileSync(f,t.slice(0,i)+(t[i]==="a"?"b":"a")+t.slice(i+1))'
jbefore="$(dc exec -T harness sha256sum /state/journal.log)"
expect_exit 2 P check --cycle 3
assert_json "$(result 3)" "r.verdict==='FAIL' && r.fails.includes('JOURNAL_CORRUPT') && r.journal.corruptIsFinalLine===true && r.needsRecovery.length===0"
snapB="$(hashes "evidence/$runB")"
expect_refusal "run is stopped" P recover --cycle 3
expect_refusal "run is stopped" P run --cycle 4 --proc a --workers 1 $SIZE
expect_refusal "failed" node "$here/recorder.mjs" create-run --dir "$work/recorder" --run "$runB-next" --failure-model HARNESS-SMOKE --continues "$runB"
[ "$(dc exec -T harness sha256sum /state/journal.log)" = "$jbefore" ] && echo "ok: the corrupt journal was not repaired or changed" || { echo "SMOKE FAILED: journal changed"; exit 1; }
[ "$(hashes "evidence/$runB")" = "$snapB" ] && echo "ok: run B evidence unchanged by the refused commands" || { echo "SMOKE FAILED: evidence changed"; exit 1; }
[ "$(hashes "recorder/runs/$runA" "evidence/$runA")" = "$snapA" ] && echo "ok: run A's record and evidence are unchanged by everything run B did" || { echo "SMOKE FAILED: run A evidence changed"; exit 1; }

for r in "$runA" "$runB"; do run="$r"; R status | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(JSON.stringify({run:r.run.run,model:r.run.failureModel,continues:r.run.continues?.run??null,stopped:r.stopped?.kind,cycles:r.cycles.map(c=>c.status),passes:r.streak.consecutivePhysicalPasses}))})'; done
if [ -s "$prior" ]; then (cd "$work" && shasum -a 256 -c --quiet "$prior") && echo "ok: evidence from earlier smoke runs is unchanged" || { echo "SMOKE FAILED: earlier evidence changed"; exit 1; }; fi
for k in "$keyA" "$keyB"; do grep -rqF "$(cat "$k")" "$work/evidence" "$work/recorder/runs" "$work"/*.log && { echo "SMOKE FAILED: a run key appears in evidence or logs"; exit 1; }; done; echo "ok: no run key appears in any evidence or log file"
dc down -v
echo "SMOKE PASSED (HARNESS-SMOKE: harness flow only, not a durability result). Evidence: $work/evidence/$runA and $runB"
