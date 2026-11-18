#!/usr/bin/env bash
# Exercises smoke-containers-down.sh against a STUB `docker` that keeps its "state" in files and records every call.
# No real Docker command runs and nothing is removed anywhere: the stub is first on PATH, and it knows no command that
# removes a volume, starts or stops anything, or runs Compose: any such call would fail the test (exit 99).
#   ./test-containers-down-with-stubs.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
script="$here/smoke-containers-down.sh"
t="$(mktemp -d)"; mkdir "$t/bin"
P=opspilot-m16-p7-smoke
cat >"$t/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STUB/calls"
filter="${*: -1}"
case "$1 $2" in
  "volume ls") tr ' ' '\n' <"$STUB/volumes" | grep . || true ;;
  "volume inspect") case "$4" in
      *CreatedAt*) awk -v v="$5" '$1==v' "$STUB/volident" ;;
      *) key="$(echo "$4" | sed 's/.*"\(.*\)".*/\1/')"; awk -v v="$5" -v k="$key" '$1==v && $2==k {print $3}' "$STUB/vlabels" ;;
    esac ;;
  "ps -aq") case "$filter" in
      label=*) awk -F'|' '{print $1}' "$STUB/listed" ;;
      volume=*) [ ! -e "$STUB/fail-uses-volume" ] || exit 1; cat "$STUB/uses-volume" ;;
      network=*) [ ! -e "$STUB/fail-on-network" ] || exit 1; cat "$STUB/on-network" ;;
    esac ;;
  "inspect --format") awk -F'|' -v c="$4" '$1==c {print $2"|"$3"|"$4"|"$5}' "$STUB/cinfo" ;;
  "network ls") case "$filter" in label=*) cat "$STUB/nets-labelled" ;; name=*) [ ! -e "$STUB/fail-nets-named" ] || exit 1; cat "$STUB/nets-named" ;; esac ;;
  "network inspect") awk -F'|' -v n="$5" '$1==n {print $2"|"$3}' "$STUB/ninfo" ;;
  "network rm") [ -e "$STUB/keep-networks" ] || { grep -vx "$3" "$STUB/nets-labelled" >"$STUB/x" || true; mv "$STUB/x" "$STUB/nets-labelled"; }
                [ ! -e "$STUB/volume-changes" ] || sed -i.bak 's/2026-11-17T10:30:49Z/2026-11-18T00:00:00Z/' "$STUB/volident" ;;
  "rm "*) [ "$#" = 2 ] || { echo "stub docker: rm with options: $*" >&2; exit 99; }
          [ -e "$STUB/keep-containers" ] || { grep -v "^$2|" "$STUB/listed" >"$STUB/x" || true; mv "$STUB/x" "$STUB/listed"; } ;;
  *) echo "stub docker: unexpected call: $*" >&2; exit 99 ;;
esac
STUB
chmod +x "$t/bin/docker"
export PATH="$t/bin:$PATH" STUB="$t"
[ "$(command -v docker)" = "$t/bin/docker" ] || { echo "the stub is not first on PATH"; exit 1; }
fail() { echo "CONTAINERS-DOWN STUB TEST FAILED: $*"; cat "$t/calls" 2>/dev/null; exit 1; }
good() {   # what a finished smoke run leaves: three stopped containers, three networks, two volumes
  rm -f "$t"/keep-* "$t"/fail-* "$t/volume-changes"; : >"$t/calls"
  echo "${P}_pgdata ${P}_state" >"$t/volumes"
  { for v in pgdata state; do echo "${P}_$v com.docker.compose.project $P"; echo "${P}_$v com.docker.compose.volume $v"; echo "${P}_$v opspilot.p7.data disposable-harness-smoke"; done; } >"$t/vlabels"
  { for v in pgdata state; do echo "${P}_$v 2026-11-17T10:30:49Z /var/lib/docker/volumes/${P}_$v/_data {\"opspilot.p7.data\":\"disposable-harness-smoke\"}"; done; } >"$t/volident"
  printf '%s\n' "c1|exited|$P|db|volume:${P}_pgdata " "c2|exited|$P|gateway|bind: " "c3|exited|$P|harness|volume:${P}_state bind: bind: bind: " >"$t/cinfo"
  cp "$t/cinfo" "$t/listed"
  printf 'c1\nc3\n' >"$t/uses-volume"; printf 'c1\nc2\nc3\n' >"$t/on-network"
  printf '%s\n' "${P}_egress" "${P}_p7db" "${P}_p7gw" >"$t/nets-labelled"; cp "$t/nets-labelled" "$t/nets-named"
  printf '%s\n' "${P}_egress|$P|egress" "${P}_p7db|$P|p7db" "${P}_p7gw|$P|p7gw" >"$t/ninfo"
}
removing() { grep -E "^(rm|network rm) " "$t/calls" || true; }
# Anything that could remove a volume, force a removal, start or stop a container, or reach Compose. Never, in any case.
forbidden() { grep -E "^(volume (rm|prune)|system|compose|run|stop|start|kill|restart|container|network prune)( |$)|(^| )(-f|--force|-v|--volumes|prune)( |$)" "$t/calls" || true; }
run() {
  local want="$1" pat="$2"; shift 2; local out code=0
  out="$("$script" "$@" 2>&1)" || code=$?
  [ "$code" = "$want" ] || fail "exit $code, expected $want: $out"
  echo "$out" | grep -q "$pat" || fail "output lacks '$pat': $out"
  [ -z "$(forbidden)" ] || fail "a forbidden docker call was made: $(forbidden)"
}
refused() { local why="$1"; run 1 "refused: .*Nothing was removed" --confirm "$P"; [ -z "$(removing)" ] || fail "$why: a removing call was made"; echo "ok: refused, nothing removed: $why"; }
edit() { sed -i.bak "$1" "$t/$2"; }

# The script's own text: no command that removes a volume, forces, starts, stops, or runs Compose or a container.
code="$(grep -v '^[[:space:]]*#' "$script")"
echo "$code" | grep -nE "docker +(compose|run|stop|start|kill|restart|system|container)|volume +(rm|prune)|prune|(^|[[:space:]])(-f|--force|-v|--volumes)([[:space:]]|$)" && fail "the script contains a forbidden command" || true
[ "$(echo "$code" | grep -cE "docker (rm|network rm) ")" = 2 ] || fail "expected exactly two removing commands in the script"
echo "ok: the script's text has two removing commands (docker rm <id>, docker network rm <name>) and no volume, force, Compose, run, start or stop command"

good; run 0 "DRY RUN: nothing was removed"; [ -z "$(removing)" ] || fail "the dry run removed something"
out="$("$script")"; grep -q "Containers to remove (stopped): c1 c2 c3" <<<"$out" && grep -q "Networks to remove: ${P}_egress ${P}_p7db ${P}_p7gw" <<<"$out" && grep -q "Volumes KEPT, never removed by this script: ${P}_pgdata ${P}_state" <<<"$out" || fail "dry run listing: $out"
echo "ok: dry run names the project, the exact containers and networks, the kept volumes, and removes nothing"

# A docker listing that fails must refuse, never skip the check it feeds (before: an empty loop, in silence).
for f in uses-volume nets-named on-network; do good; touch "$t/fail-$f"; refused "docker cannot list ($f)"; done

for bad in opspilot opspilot-m16-p7 opspilot-isolated "${P}-2" "" ; do
  good; run 2 "must be exactly $P" --confirm "$bad"; [ ! -s "$t/calls" ] || fail "--confirm '$bad' reached docker"
done
good; run 2 "nothing else may follow" --confirm "$P" --volumes; [ ! -s "$t/calls" ] || fail "an extra argument reached docker"
good; run 2 "usage" -p opspilot; [ ! -s "$t/calls" ] || fail "an unknown argument reached docker"
good; run 2 "usage" --volumes; [ ! -s "$t/calls" ] || fail "an unknown argument reached docker"
echo "ok: any other project name, an extra argument or an unknown option is refused before docker is called at all"

# Volumes: both must be there, this project's, labelled disposable; no other.
good; : >"$t/volumes"; refused "both volumes are missing"
good; echo "${P}_pgdata" >"$t/volumes"; refused "one volume is missing"
good; echo "${P}_pgdata ${P}_state ${P}_extra" >"$t/volumes"; refused "an extra volume in the project"
good; echo "opspilot-m16-p7_pgdata opspilot-m16-p7_state" >"$t/volumes"; refused "the listing returns the qualifying project's volumes"
good; edit "/${P}_state opspilot.p7.data/d" vlabels; refused "the disposable-smoke label is missing on one volume"
good; edit "s/disposable-harness-smoke/evidence-keep/" vlabels; refused "the volume label has another value"
good; edit "s/${P}_pgdata com.docker.compose.project $P/${P}_pgdata com.docker.compose.project opspilot/" vlabels; refused "a volume's Compose project label names another project"
good; edit "s/${P}_state com.docker.compose.volume state/${P}_state com.docker.compose.volume pgdata/" vlabels; refused "a volume's Compose volume label does not match its name"
good; edit "/${P}_state 2026/d" volident; refused "a volume's identity cannot be read"
# Containers: this project's, a known service once, stopped, mounting only the two smoke volumes.
good; edit "s/^c2|exited|$P|/c2|exited|opspilot|/" cinfo; refused "a listed container is labelled with the default opspilot project"
good; edit "s/^c2|exited|$P|/c2|exited||/" cinfo; refused "a listed container has no project label"
good; edit "s/^c2|exited|$P|gateway/c2|exited|$P|api/" cinfo; refused "a container of an unexpected service"
good; edit "s/^c2|exited|$P|gateway/c2|exited|$P|/" cinfo; refused "a container with no service label"
good; echo "c4|exited|$P|db|volume:${P}_pgdata " | tee -a "$t/cinfo" >>"$t/listed"; refused "two containers of the same service"
for st in running restarting paused removing; do good; edit "s/^c1|exited/c1|$st/" cinfo; refused "a container is $st (the script stops nothing)"; done
good; edit "s/^c2|exited|$P|gateway|bind: /c2|exited|$P|gateway|bind: volume:0a5a2a70c2b9 /" cinfo; refused "a container mounts an anonymous volume"
good; edit "s/volume:${P}_pgdata/volume:opspilot-m16-p7_pgdata/" cinfo; refused "a container mounts a volume of the qualifying project"
good; edit "s/volume:${P}_state/volume:opspilot_pgdata/" cinfo; refused "a container mounts a volume of the default project"
good; echo foreign1 >>"$t/uses-volume"; refused "a container outside the project uses a smoke volume"
good; echo foreign2 >>"$t/on-network"; refused "a container outside the project is attached to a project network"
# Networks: this project's three, labelled; nothing unlabelled under the project's name.
good; echo "${P}_extra" >>"$t/nets-labelled"; echo "${P}_extra|$P|extra" >>"$t/ninfo"; refused "an unexpected fourth network"
good; echo "opspilot_default" >>"$t/nets-labelled"; refused "the listing returns a network of the default project"
good; edit "s/^${P}_p7db|$P|/${P}_p7db|opspilot|/" ninfo; refused "a network's project label names another project"
good; edit "s/^${P}_p7db|$P|p7db/${P}_p7db|$P|p7gw/" ninfo; refused "a network's Compose network label does not match its name"
good; edit "s/^${P}_egress|$P|egress/${P}_egress||/" ninfo; refused "a network with no labels"
good; echo "${P}_stray" >>"$t/nets-named"; refused "an unlabelled network carries the project's name prefix"

# The confirmed removal: exactly the checked containers, then exactly the checked networks, by id and by name.
good; run 0 "Every volume is still present, unchanged" --confirm "$P"
[ "$(removing)" = "rm c1
rm c2
rm c3
network rm ${P}_egress
network rm ${P}_p7db
network rm ${P}_p7gw" ] || fail "the confirmed removal made other removing calls than the six expected: $(removing)"
grep -c "^volume inspect" "$t/calls" | grep -qx 10 || fail "the volumes were not inspected before (labels, identity) and after (identity)"
echo "ok: confirmed removal makes exactly six removing calls, in order: 'rm <id>' for the three containers, then 'network rm <name>' for the three networks"
echo "ok: no call in any case above removed, pruned or named a volume in a removing command, forced a removal, or reached Compose, run, start or stop"

# Smoke volumes named per generation (compose.smoke.yml), beside the ones an earlier smoke left: all are kept and checked.
gens() {
  good
  echo "${P}_pgdata ${P}_pgdata_s2 ${P}_state ${P}_state_s2" >"$t/volumes"
  { for v in pgdata state; do for g in "" _s2; do echo "${P}_$v$g com.docker.compose.project $P"; echo "${P}_$v$g com.docker.compose.volume $v"; echo "${P}_$v$g opspilot.p7.data disposable-harness-smoke"; done; done; } >"$t/vlabels"
  { for v in pgdata state; do for g in "" _s2; do echo "${P}_$v$g 2026-11-17T10:30:49Z /var/lib/docker/volumes/${P}_$v$g/_data {}"; done; done; } >"$t/volident"
  printf '%s\n' "c1|exited|$P|db|volume:${P}_pgdata_s2 " "c2|exited|$P|gateway|bind: " "c3|exited|$P|harness|volume:${P}_state_s2 bind: " >"$t/cinfo"; cp "$t/cinfo" "$t/listed"
}
gens; run 0 "Every volume is still present, unchanged" --confirm "$P"
[ "$(removing | wc -l | tr -d ' ')" = 6 ] || fail "generations: expected six removing calls: $(removing)"
grep -c "^volume inspect" "$t/calls" | grep -qx 20 || fail "generations: all four volumes must be checked before and compared after"
gens; out="$("$script")"; grep -q "Volumes KEPT, never removed by this script: ${P}_pgdata ${P}_pgdata_s2 ${P}_state ${P}_state_s2" <<<"$out" || fail "generations: the dry run must name all four kept volumes: $out"
echo "ok: volumes of several smoke generations are all kept, checked before and compared after"
for bad in "${P}_pgdata_BAD" "${P}_pgdata_" "${P}_logs_s2" "${P}_pgdata_s2_x" "opspilot-m16-p7_pgdata_s2"; do
  gens; echo "$bad" >>"$t/volumes"; refused "a volume named $bad is listed for the project"
done
gens; edit "s/${P}_pgdata_s2 com.docker.compose.volume pgdata/${P}_pgdata_s2 com.docker.compose.volume state/" vlabels; refused "a generation volume's Compose volume label does not match its name"
gens; edit "/${P}_state_s2 opspilot.p7.data/d" vlabels; refused "a generation volume lacks the disposable label"
gens; edit "s/volume:${P}_pgdata_s2/volume:${P}_pgdata_zz/" cinfo; refused "a container mounts a smoke-named volume that is not among the project's volumes"
gens; echo "${P}_pgdata_s2" >"$t/volumes"; refused "only one kind of smoke volume exists"

# After a partial failure the rest can still be removed; with nothing left there is nothing to do.
grep -q "resumes an earlier, partial removal" <<<"$(good; : >"$t/listed"; : >"$t/uses-volume"; : >"$t/on-network"; "$script")" || fail "a partial state is not announced"
good; : >"$t/listed"; : >"$t/uses-volume"; : >"$t/on-network"; run 0 "Every volume is still present, unchanged" --confirm "$P"
[ "$(removing)" = "network rm ${P}_egress
network rm ${P}_p7db
network rm ${P}_p7gw" ] || fail "rerun with only networks left: $(removing)"
good; : >"$t/listed"; : >"$t/uses-volume"; : >"$t/on-network"; : >"$t/nets-labelled"; : >"$t/nets-named"; run 0 "nothing to remove" --confirm "$P"; [ -z "$(removing)" ] || fail "removed with nothing there"
echo "ok: a rerun removes what is left; with no containers and no networks it does nothing"

# Verification afterwards is not taken on trust.
good; touch "$t/volume-changes"; run 3 "STOP: the smoke volumes are not as they were before" --confirm "$P"
good; touch "$t/keep-containers"; run 3 "STOP: still present after removal: c1 c2 c3" --confirm "$P"
good; touch "$t/keep-networks"; run 3 "STOP: still present after removal: ${P}_egress" --confirm "$P"
echo "ok: a volume whose identity changed, or a container or network still present afterwards, ends with STOP and exit 3"
rm -r "$t"
echo "CONTAINERS-DOWN STUB TEST PASSED (stub docker only: the real removal has never been run)"
