#!/usr/bin/env bash
# Removes the stopped CONTAINERS and the NETWORKS of the smoke project "opspilot-m16-p7-smoke", and nothing else.
# Every smoke volume is kept: they are checked before, never named in a removing command, and compared afterwards.
# This file contains no command that can remove a volume, and none that starts, stops or forces anything.
#   ./smoke-containers-down.sh                                   dry run: every check, then what would be removed
#   ./smoke-containers-down.sh --confirm opspilot-m16-p7-smoke   removes exactly the containers and networks the dry run printed
# It refuses unless ALL of this holds:
#   - the project is exactly opspilot-m16-p7-smoke (fixed here; no argument can name another project);
#   - the project's volumes are smoke volumes and nothing else: named opspilot-m16-p7-smoke_pgdata or _state, alone or
#     with a generation suffix (compose.smoke.yml), each with that project's labels and the label
#     opspilot.p7.data=disposable-harness-smoke; and there is at least one of each kind;
#   - every container found is labelled with that project, is one of db, gateway, harness (each at most once), is not
#     running, and mounts no volume other than those smoke volumes;
#   - only containers of that project use the volumes or are attached to the project's networks;
#   - every network found is labelled with that project and is one of its three (p7db, p7gw, egress), and no
#     unlabelled network carries the project's name prefix.
# A partial removal is safe to repeat: whatever is left is checked again and removed; with nothing left it does nothing.
# Afterwards it checks that every volume is still there with the same name, creation time, mountpoint and labels
# (identity, not content), and that the containers and networks are gone. It exits 3 if any of that is not so.
# What it does NOT do: it does not give a later smoke run fresh volumes. The kept volumes still hold the earlier run.
set -euo pipefail
PROJ=opspilot-m16-p7-smoke
WANT_CLASS=disposable-harness-smoke
VOL_RE="^${PROJ}_(pgdata|state)(_[a-z0-9]{1,24})?\$"
SERVICES=" db gateway harness "
NETS=" ${PROJ}_egress ${PROJ}_p7db ${PROJ}_p7gw "
confirm=""
case "${1:-}" in
  "") [ "$#" -le 0 ] || { echo "usage: $0 [--confirm $PROJ]"; exit 2; } ;;
  --confirm) [ "$#" -eq 2 ] && [ "$2" = "$PROJ" ] || { echo "refused: --confirm must be exactly $PROJ, and nothing else may follow"; exit 2; }; confirm="$2" ;;
  *) echo "usage: $0 [--confirm $PROJ]"; exit 2 ;;
esac
refuse() { echo "refused: $*. Nothing was removed."; exit 1; }
vlabel() { docker volume inspect --format "{{ index .Labels \"$2\" }}" "$1"; }
videntity() { for v in $volumes; do docker volume inspect --format '{{.Name}} {{.CreatedAt}} {{.Mountpoint}} {{json .Labels}}' "$v"; done; }
has() { case "$1" in *" $2 "*) return 0 ;; *) return 1 ;; esac; }

# 1. The volumes that must survive: every volume of the project, each a smoke volume labelled as disposable smoke data.
volumes="$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJ" | sort | tr '\n' ' ')"
kinds=" "
for v in $volumes; do
  [[ "$v" =~ $VOL_RE ]] || refuse "volume $v is in project $PROJ but is not one of its smoke volumes (pgdata or state, with or without a generation)"
  kind="${BASH_REMATCH[1]}"; kinds="$kinds$kind "
  [ "$(vlabel "$v" com.docker.compose.project)" = "$PROJ" ] || refuse "volume $v does not belong to project $PROJ"
  [ "$(vlabel "$v" com.docker.compose.volume)" = "$kind" ] || refuse "volume $v is not the Compose volume its name says"
  [ "$(vlabel "$v" opspilot.p7.data)" = "$WANT_CLASS" ] || refuse "volume $v is not labelled opspilot.p7.data=$WANT_CLASS"
done
has "$kinds" pgdata && has "$kinds" state || refuse "project $PROJ should have at least one pgdata and one state smoke volume, found: ${volumes:-none}"
before="$(videntity)"
[ "$(echo "$before" | grep -c .)" = "$(echo $volumes | wc -w | tr -d ' ')" ] || refuse "the identity of every volume could not be read"

# 2. The containers: every one is this project's, a known service, stopped, and mounts only the two smoke volumes.
containers="$(docker ps -aq --filter "label=com.docker.compose.project=$PROJ" | tr '\n' ' ')"
seen=" "
for c in $containers; do
  info="$(docker inspect --format '{{.State.Status}}|{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.service" }}|{{range .Mounts}}{{.Type}}:{{.Name}} {{end}}' "$c")"
  IFS='|' read -r status project service mounts <<<"$info"
  [ "$project" = "$PROJ" ] || refuse "container $c is labelled with project '${project}', not $PROJ"
  has "$SERVICES" "$service" || refuse "container $c is service '${service}', which is not one of the smoke stack's"
  has "$seen" "$service" && refuse "more than one container of service $service"
  seen="$seen$service "
  case "$status" in exited|created|dead) ;; *) refuse "container $c ($service) is $status. This script stops nothing: it removes only containers that are already stopped" ;; esac
  for m in $mounts; do
    case "$m" in
      bind:*|tmpfs:*) ;;
      volume:*) has " $volumes" "${m#volume:}" || refuse "container $c ($service) mounts '$m', which is not one of this project's smoke volumes" ;;
      *) refuse "container $c ($service) has a mount of an unexpected kind: '$m'" ;;
    esac
  done
done
for v in $volumes; do
  users="$(docker ps -aq --filter "volume=$v")" || refuse "the containers that use volume $v could not be listed"
  for c in $users; do has " $containers" "$c" || refuse "volume $v is used by container $c, which is not part of project $PROJ"; done
done

# 3. The networks: every one is this project's and one of its three; nothing else is attached to them.
networks="$(docker network ls --format '{{.Name}}' --filter "label=com.docker.compose.project=$PROJ" | sort | tr '\n' ' ')"
named="$(docker network ls --format '{{.Name}}' --filter "name=${PROJ}_")" || refuse "the networks could not be listed"
for n in $named; do
  case "$n" in "${PROJ}_"*) has " $networks" "$n" || refuse "network $n carries the project's name but not its label" ;; esac
done
for n in $networks; do
  has "$NETS" "$n" || refuse "network $n is not one of the smoke stack's three networks"
  IFS='|' read -r nproject nname <<<"$(docker network inspect --format '{{ index .Labels "com.docker.compose.project" }}|{{ index .Labels "com.docker.compose.network" }}' "$n")"
  [ "$nproject" = "$PROJ" ] && [ "${PROJ}_${nname}" = "$n" ] || refuse "network $n is not labelled as network '${n#"${PROJ}"_}' of project $PROJ"
  attached="$(docker ps -aq --filter "network=$n")" || refuse "the containers on network $n could not be listed"
  for c in $attached; do has " $containers" "$c" || refuse "network $n has container $c attached, which is not part of project $PROJ"; done
done

echo "Compose project: $PROJ"
echo "Containers to remove (stopped): ${containers:-none}"
echo "Networks to remove: ${networks:-none}"
echo "Volumes KEPT, never removed by this script: ${volumes% }"
[ -n "$containers" ] || [ -z "$networks" ] || echo "(no containers are left: this resumes an earlier, partial removal)"
[ -n "$containers$networks" ] || { echo "nothing to remove: project $PROJ has no containers and no networks"; exit 0; }
if [ -z "$confirm" ]; then echo "DRY RUN: nothing was removed. To remove exactly the containers and networks above: $0 --confirm $PROJ"; exit 0; fi

# 4. Remove exactly what was checked, by id and by name. Containers first, so the networks are free.
for c in $containers; do docker rm "$c" >/dev/null; done
for n in $networks; do docker network rm "$n" >/dev/null; done

# 5. Prove what was kept and what is gone.
after="$(videntity)" || after="(could not be read)"
[ "$after" = "$before" ] || { echo "STOP: the smoke volumes are not as they were before. Before:"; echo "$before"; echo "After:"; echo "$after"; exit 3; }
left="$(docker ps -aq --filter "label=com.docker.compose.project=$PROJ" | tr '\n' ' ')$(docker network ls --format '{{.Name}}' --filter "label=com.docker.compose.project=$PROJ" | tr '\n' ' ')"
[ -z "$left" ] || { echo "STOP: still present after removal: $left"; exit 3; }
echo "removed the containers and networks of $PROJ. Every volume is still present, unchanged in name, creation time, mountpoint and labels:"
echo "$after"
echo "They still hold the earlier smoke runs. A new smoke environment gets its own volumes: set a new P7_SMOKE_GENERATION."
