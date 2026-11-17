#!/usr/bin/env bash
# Exercises smoke-teardown.sh against a STUB `docker` that only records the calls it receives. No real Docker command
# runs and nothing is removed anywhere: the stub is first on PATH and the real docker is never reached.
#   ./test-teardown-with-stubs.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; mkdir "$t/bin"
P=opspilot-m16-p7-smoke
cat >"$t/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STUB/calls"
case "$1 $2" in
  "volume ls") [ "$5" = "label=com.docker.compose.project=opspilot-m16-p7-smoke" ] && tr ' ' '\n' <"$STUB/volumes" | grep . || true ;;
  "volume inspect") key="$(echo "$4" | sed 's/.*"\(.*\)".*/\1/')"; awk -v v="$5" -v k="$key" '$1==v && $2==k {print $3}' "$STUB/labels" ;;
  "ps -aq") cat "$STUB/containers" ;;
  "inspect -f") cat "$STUB/container-project" ;;
  "run --rm") cat "$STUB/marker" ;;
  "compose -p"|"volume rm") ;;
  *) echo "stub docker: unexpected call: $*" >&2; exit 99 ;;
esac
STUB
chmod +x "$t/bin/docker"
export PATH="$t/bin:$PATH" STUB="$t"
[ "$(command -v docker)" = "$t/bin/docker" ] || { echo "the stub is not first on PATH"; exit 1; }
fail() { echo "TEARDOWN STUB TEST FAILED: $*"; cat "$t/calls" 2>/dev/null; exit 1; }
good() {   # the state a finished smoke run leaves behind
  : >"$t/calls"
  echo "${P}_pgdata ${P}_state" >"$t/volumes"
  { for v in pgdata state; do echo "${P}_$v com.docker.compose.project $P"; echo "${P}_$v com.docker.compose.volume $v"; echo "${P}_$v opspilot.p7.data disposable-harness-smoke"; done; } >"$t/labels"
  echo c1 >"$t/containers"; echo "$P" >"$t/container-project"
  printf '{\n  "pgSystemId": "7111111111111111111",\n  "failureModel": "HARNESS-SMOKE"\n}\n' >"$t/marker"
}
destructive() { grep -cE "^(compose .* down|volume rm|volume prune|system prune|rm )" "$t/calls" || true; }   # (`run -v` is the read-only mount)
# run <expected exit> <pattern in output> <args...>; a refusal must make no removing call at all
run() {
  local want="$1" pat="$2"; shift 2; local out code=0
  out="$("$here/smoke-teardown.sh" "$@" 2>&1)" || code=$?
  [ "$code" = "$want" ] || fail "exit $code, expected $want: $out"
  echo "$out" | grep -q "$pat" || fail "output lacks '$pat': $out"
}
refused() { local why="$1"; run 1 "refused: .*Nothing was removed" --confirm "$P"; [ "$(destructive)" = 0 ] || fail "$why: a removing call was made"; echo "ok: refused, nothing removed: $why"; }

good; run 0 "DRY RUN: nothing was removed"; [ "$(destructive)" = 0 ] || fail "the dry run removed something"
grep -q "Volumes: ${P}_pgdata ${P}_state" <<<"$("$here/smoke-teardown.sh")" && echo "ok: dry run names the project and the exact volumes, and removes nothing"

for bad in opspilot opspilot-m16-p7 opspilot-isolated "${P}-2" "" ; do
  good; run 2 "must be exactly $P" --confirm "$bad"; [ ! -s "$t/calls" ] || fail "--confirm '$bad' reached docker"
done
good; run 2 "usage" -p opspilot; [ ! -s "$t/calls" ] || fail "an unknown argument reached docker"
echo "ok: any other project name (opspilot, opspilot-m16-p7, opspilot-isolated, a suffix, empty) is refused before docker is called at all"

good; : >"$t/volumes"; run 0 "nothing to remove" --confirm "$P"; [ "$(destructive)" = 0 ] || fail "removed with no volumes"
good; echo "${P}_pgdata ${P}_state ${P}_extra" >"$t/volumes"; refused "an extra volume in the project"
good; echo "${P}_pgdata" >"$t/volumes"; refused "a volume is missing"
good; echo "opspilot_pgdata ${P}_state" >"$t/volumes"; refused "a volume of the default opspilot project appears in the listing"
good; sed -i.bak "/${P}_state opspilot.p7.data/d" "$t/labels"; refused "the disposable-smoke label is missing on one volume"
good; sed -i.bak "s/disposable-harness-smoke/evidence-keep/" "$t/labels"; refused "the volumes are labelled evidence-keep (a qualifying run's volumes)"
good; sed -i.bak "s/${P}_pgdata com.docker.compose.project $P/${P}_pgdata com.docker.compose.project opspilot/" "$t/labels"; refused "a volume's Compose project label names another project"
good; sed -i.bak "s/${P}_state com.docker.compose.volume state/${P}_state com.docker.compose.volume pgdata/" "$t/labels"; refused "a volume's Compose volume label does not match its name"
good; sed -i.bak "s/HARNESS-SMOKE/POWER-CUT/" "$t/marker"; refused "the journal volume marker says POWER-CUT"
good; sed -i.bak "s/HARNESS-SMOKE/VM-CRASH/" "$t/marker"; refused "the journal volume marker says VM-CRASH"
good; echo NO-MARKER >"$t/marker"; refused "the journal volume has entries but no marker"
good; : >"$t/marker"; refused "the marker could not be read"
good; echo opspilot >"$t/container-project"; refused "a container of another project uses a volume"

good; echo EMPTY >"$t/marker"; run 0 "init never ran"; [ "$(destructive)" = 0 ] || fail "dry run removed"
good; run 0 "removed the disposable smoke state" --confirm "$P"
[ "$(grep -E "^(compose|volume rm)" "$t/calls")" = "compose -p $P down
volume rm ${P}_pgdata ${P}_state" ] || fail "the confirmed removal made other calls than the two expected"
grep -E "^(compose|volume|system) " "$t/calls" | grep -qE "(^| )(-v|--volumes|prune)( |$)" && fail "a -v, --volumes or prune call was made"
echo "ok: confirmed removal makes exactly two removing calls: 'compose -p $P down' (no -v) and 'volume rm' of the two named volumes"
rm -r "$t"
echo "TEARDOWN STUB TEST PASSED (stub docker only: the real teardown has never been run)"
