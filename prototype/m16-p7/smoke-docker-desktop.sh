#!/usr/bin/env bash
# HARNESS-SMOKE ONLY. Exercises the hardened harness end to end on Docker Desktop. It is NOT a P7 durability test: a
# container kill is not a power cut and Docker Desktop is not native Linux. The run's failure model is HARNESS-SMOKE,
# which can never count. Covers: network isolation (topology + netcheck), authenticated recorder, two processes
# (--proc a, --proc b) concurrently, a recorder restart, a worker process killed unexpectedly, the journal one claim
# ahead with a torn line (observed quarantine, clearance by digest, repeated recovery refused), and an invalid
# complete final line (FAIL, never repaired, run stopped, evidence unchanged).
#   ./smoke-docker-desktop.sh <work dir outside the repository>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="${1:?work directory (outside the repository)}"
port="${P7_SMOKE_PORT:-8797}"
proj=opspilot-m16-p7-smoke
run="harness-smoke-$(date +%Y%m%dT%H%M%S)"
mkdir -p "$work/recorder" "$work/evidence"
docker compose ls -a --format json | grep -q "\"$proj\"" && { echo "refused: the $proj project exists (inspect it, then: docker compose -p $proj down -v)"; exit 1; }

# Evidence from earlier smoke runs must survive this one unchanged.
prior="$work/.prior-evidence-$run.sha256"
(cd "$work" && find evidence recorder -type f ! -path "*/keys/*" -print0 | sort -z | xargs -0 shasum -a 256 2>/dev/null) >"$prior" || true

node "$here/recorder.mjs" serve --dir "$work/recorder" --port "$port" >"$work/recorder-$run.log" 2>&1 & rpid=$!
trap 'kill $rpid 2>/dev/null || true' EXIT
sleep 1
key="$(node "$here/recorder.mjs" create-run --dir "$work/recorder" --run "$run" --failure-model HARNESS-SMOKE --machine "Docker Desktop (harness smoke only)" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).keyFile))')"
export P7_RUN="$run" P7_RECORDER_TARGET="host.docker.internal:$port" P7_KEY_FILE_HOST="$key" P7_EVIDENCE_HOST="$work/evidence"
dc() { docker compose -p "$proj" -f "$here/compose.yml" "$@"; }
R() { local c="$1"; shift; node "$here/recorder.mjs" "$c" --dir "$work/recorder" --run "$run" "$@"; }
P() { dc exec -T harness node p7.mjs "$@"; }
expect_exit() { local want="$1"; shift; local got=0; "$@" || got=$?; [ "$got" -eq "$want" ] || { echo "SMOKE FAILED: expected exit $want, got $got: $*"; exit 1; }; }
ev="$work/evidence/$run"
assert_json() { node -e 'const [f,x]=process.argv.slice(1); const r=JSON.parse(require("fs").readFileSync(f,"utf8")); if(!eval(x)){console.error(`SMOKE FAILED: ${x}`, JSON.stringify({verdict:r.verdict,fails:r.fails,inconclusive:r.inconclusive,relation:r.relation,counts:r.counts,silent:r.silentWorkerStops}).slice(0,600)); process.exit(1)} console.log(`ok: ${x.slice(0,110)}`)' "$1" "$2"; }
result() { ls "$ev"/cycle-$(printf %04d "$1")*/result.json | tail -1; }
cut_now() { R cut --cycle "$1" --min-seconds "$2" --max-seconds "$3" --command-json "[\"docker\",\"compose\",\"-p\",\"$proj\",\"-f\",\"$here/compose.yml\",\"kill\"]"; R confirm-cut --cycle "$1" --power-was-cut yes --evidence "smoke: container kill, not a power cut"; }
start_proc() { (P run --cycle "$1" --proc "$2" --workers 2 --pool 50000 >"$work/run-$run-$1$2.log" 2>&1 || true) & pids+=($!); }
# A kill can land between a claim append and its commit: then recover stops with exit 4 for the operator's digest.
recover() { local out code=0; out="$(P recover --run "$run" --cycle "$1")" || code=$?; echo "$out" | cut -c1-300
  if [ "$code" -eq 4 ]; then P recover --run "$run" --cycle "$1" --clear-digest "$(node -e 'console.log(JSON.parse(process.argv[1]).inspection.digest)' "$out")" | cut -c1-300
  elif [ "$code" -ne 0 ]; then echo "SMOKE FAILED: recover exited $code"; exit 1; fi; }
db_unique() { dc exec -T db psql -qtA -U proto -d proto -c "SELECT count(*) = count(DISTINCT meta->>'seq') AND count(*) = count(DISTINCT ref) FROM audit WHERE action = 'execute_start'"; }

dc up -d --wait

echo "== isolation: topology"
nets() { docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$(dc ps -q "$1")"; }
for c in db gateway harness; do echo "$c: $(nets $c)"; done
[ "$(nets db)" = "${proj}_p7db " ] || { echo "SMOKE FAILED: db networks"; exit 1; }
[ "$(nets harness)" = "${proj}_p7db ${proj}_p7gw " ] || { echo "SMOKE FAILED: harness networks"; exit 1; }
[ "$(nets gateway)" = "${proj}_egress ${proj}_p7gw " ] || { echo "SMOKE FAILED: gateway networks"; exit 1; }
for n in p7db p7gw; do [ "$(docker network inspect -f '{{.Internal}}' "${proj}_$n")" = true ] || { echo "SMOKE FAILED: $n not internal"; exit 1; }; done
# Images declare ports (EXPOSE), which compose lists with published port 0; what matters is that nothing is bound on the host.
for c in db gateway harness; do docker inspect -f '{{json .HostConfig.PortBindings}} {{json .NetworkSettings.Ports}}' "$(dc ps -q $c)" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const [b,p]=s.trim().split(" ").map(JSON.parse);if(Object.keys(b??{}).length||Object.values(p??{}).some(v=>v!==null)){console.error("SMOKE FAILED: host port binding",s);process.exit(1)}})'; done
echo "ok: db only on p7db; harness on p7db + p7gw; gateway on p7gw + egress; both internal networks internal; nothing published"
echo "== isolation: netcheck from inside the harness"
P netcheck | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);for(const p of r.probes)console.log(p.ok?"  ok ":"  BAD", p.name, "->", p.outcome);if(!r.ok)process.exit(1)})'
P init

echo "== cycle 1: --proc a and --proc b concurrently (2 workers each); the recorder is restarted before recovery"
pids=(); start_proc 1 a; sleep 3; start_proc 1 b; sleep 6   # b starts while a is already claiming
cut_now 1 5 8; wait "${pids[@]}" || true
dc up -d --wait
mkdir "$ev/cycle-0001"                                   # as if an earlier check died right after creating its directory
expect_exit 1 P check --run "$run" --cycle 1 --smoke-fail-before-result-post   # and another died before sending its result
expect_exit 3 P check --run "$run" --cycle 1             # the retry re-sends the saved result unchanged
[ -z "$(ls "$ev/cycle-0001")" ] && [ "$(ls -d "$ev"/cycle-0001-attempt-* | wc -l | tr -d ' ')" = 1 ] && echo "ok: check retried without overwriting evidence (one attempt directory, result re-sent)" || { echo "SMOKE FAILED: check retry"; exit 1; }
assert_json "$(result 1)" "r.fails.length===0 && r.counts.claimAcks>0"
node -e 'const fs=require("fs");const a=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);const procs=[...new Set(a.map(x=>x.proc))].sort().join();const seqs=a.filter(x=>x.kind==="claim").map(x=>x.seq);if(procs!=="a,b"||new Set(seqs).size!==seqs.length){console.error("SMOKE FAILED: two-process acknowledgements",procs);process.exit(1)}console.log(`ok: ${seqs.length} claim acknowledgements from processes ${procs}, sequence numbers unique`)' "$work/recorder/runs/$run/acks/cycle-0001.jsonl"
[ "$(db_unique)" = t ] && echo "ok: committed claims have unique sequence numbers and unique action ids" || { echo "SMOKE FAILED: duplicate committed claims"; exit 1; }
kill "$rpid"; sleep 1
node "$here/recorder.mjs" serve --dir "$work/recorder" --port "$port" >>"$work/recorder-$run.log" 2>&1 & rpid=$!
sleep 1; echo "recorder restarted"
recover 1

echo "== cycle 2: --proc b is killed unexpectedly (SIGKILL) while --proc a continues"
pids=(); start_proc 2 a; start_proc 2 b; sleep 8
dc exec -T harness sh -c 'for d in /proc/[0-9]*; do tr "\0" " " <"$d/cmdline" 2>/dev/null | grep -q "[p]7.mjs run .*--proc b" && kill -9 "${d#/proc/}"; done; true'
echo "proc b killed"
cut_now 2 13 15; wait "${pids[@]}" || true
dc up -d --wait
expect_exit 3 P check --run "$run" --cycle 2
assert_json "$(result 2)" "r.fails.length===0 && r.inconclusive.includes('WORKLOAD_STOPPED_BEFORE_CUT') && r.silentWorkerStops.filter(w=>w.proc==='b').length===2 && (r.silentWorkerStops.length===2 || r.relation==='journal-one-ahead')"
[ "$(db_unique)" = t ] && echo "ok: still unique after the kill" || { echo "SMOKE FAILED: duplicate committed claims"; exit 1; }
recover 2

echo "== cycle 3: journal one claim ahead + a torn line -> observed quarantine, repair, inspection, clearance by digest"
pids=(); (P run --cycle 3 --proc a --workers 1 --pool 1000 --smoke-crash-after-claim-append >"$work/run-$run-3a.log" 2>&1 || true) & pids+=($!); sleep 6
cut_now 3 0 0; wait "${pids[@]}" || true
dc up -d --wait
dc exec -T harness sh -c 'printf "{\"type\":\"dispatch\",\"se" >> /state/journal.log'
expect_exit 3 P check --run "$run" --cycle 3
assert_json "$(result 3)" "r.fails.length===0 && r.relation==='journal-one-ahead' && r.quarantineRequired===true && r.needsRecovery.join()==='repair-torn-tail,clear'"
out="$(P recover --run "$run" --cycle 3)" && code=0 || code=$?
[ "$code" -eq 4 ] || { echo "SMOKE FAILED: first recover should stop for the digest ($code)"; exit 1; }
node -e 'const r=JSON.parse(process.argv[1]); if(!r.quarantine.observed) process.exit(1); console.log("ok: quarantine observed:", r.quarantine.refusal)' "$out"
digest="$(node -e 'console.log(JSON.parse(process.argv[1]).inspection.digest)' "$out")"
P recover --run "$run" --cycle 3 --clear-digest "$digest"
expect_exit 1 P recover --run "$run" --cycle 3
echo "ok: a repeated recovery is refused"

echo "== cycle 4: an invalid COMPLETE final line -> FAIL, never repaired, run stopped, evidence unchanged"
pids=(); start_proc 4 a; start_proc 4 b; sleep 7
cut_now 4 3 5; wait "${pids[@]}" || true
dc up -d --wait
dc exec -T harness node -e 'const fs=require("fs");const f="/state/journal.log";let t=fs.readFileSync(f,"utf8");if(!t.endsWith("\n")){fs.appendFileSync(f,"\n");t+="\n"}const i=t.lastIndexOf("\"hash\":\"")+8;fs.writeFileSync(f,t.slice(0,i)+(t[i]==="a"?"b":"a")+t.slice(i+1))'
jbefore="$(dc exec -T harness sha256sum /state/journal.log)"
expect_exit 2 P check --run "$run" --cycle 4
assert_json "$(result 4)" "r.verdict==='FAIL' && r.fails.includes('JOURNAL_CORRUPT') && r.journal.corruptIsFinalLine===true && r.needsRecovery.length===0"
snap="$(cd "$ev" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256)"
expect_exit 1 P recover --run "$run" --cycle 4
expect_exit 1 P run --cycle 5 --proc a --workers 1 --pool 10
[ "$(dc exec -T harness sha256sum /state/journal.log)" = "$jbefore" ] && echo "ok: the corrupt journal was not repaired or changed" || { echo "SMOKE FAILED: journal changed"; exit 1; }
[ "$(cd "$ev" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256)" = "$snap" ] && echo "ok: evidence unchanged by the refused commands" || { echo "SMOKE FAILED: evidence changed"; exit 1; }

R status | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(JSON.stringify({model:r.run.failureModel,stopped:r.stopped?.reason,cycles:r.cycles,streak:r.streak,rejections:r.rejections}))})'
if [ -s "$prior" ]; then (cd "$work" && shasum -a 256 -c --quiet "$prior") && echo "ok: evidence from earlier smoke runs is unchanged" || { echo "SMOKE FAILED: earlier evidence changed"; exit 1; }; fi
grep -rqF "$(cat "$key")" "$work/evidence" "$work/recorder/runs" "$work"/*.log && { echo "SMOKE FAILED: the run key appears in evidence or logs"; exit 1; } || echo "ok: the run key appears in no evidence or log file"
dc down -v
echo "SMOKE PASSED (HARNESS-SMOKE: harness flow only, not a durability result). Evidence: $ev"
