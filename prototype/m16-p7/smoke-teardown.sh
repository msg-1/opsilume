#!/usr/bin/env bash
# Removes the DISPOSABLE HARNESS-SMOKE Docker state, and nothing else: the containers, networks and the two volumes of
# the Compose project "opspilot-m16-p7-smoke". It is the only place in the P7 harness that removes a volume.
#   ./smoke-teardown.sh                                   dry run: checks everything, prints what would be removed
#   ./smoke-teardown.sh --confirm opspilot-m16-p7-smoke --volume-removal-authorised-by-product-owner
#                                                         removes exactly what the dry run printed, VOLUMES INCLUDED
# DISABLED BY DEFAULT: --confirm alone is refused. Deleting the smoke volumes needs the product owner's separate, explicit
# authorisation, stated with the second flag. To remove only the containers and networks, and keep the volumes, use
# ./smoke-containers-down.sh instead.
# It never uses `down -v`, `volume prune` or `system prune`: volumes are removed by exact name, after every check.
# It refuses unless ALL of this holds:
#   - the project is exactly opspilot-m16-p7-smoke (fixed here; no argument can name another project);
#   - the project's volumes are exactly opspilot-m16-p7-smoke_pgdata and opspilot-m16-p7-smoke_state;
#   - each carries the Compose labels of that project and volume, and the label opspilot.p7.data=disposable-harness-smoke
#     (set only by compose.smoke.yml, which only smoke-docker-desktop.sh uses; a qualifying run's volumes have no such label);
#   - the marker in the journal volume, if init wrote one, says the volumes were initialised by a HARNESS-SMOKE run;
#   - only containers of that project use the volumes.
# It knows only the two volumes without a generation suffix (smokes before generations existed). If the project also
# has generation-named volumes it refuses: nothing in the harness removes those.
# The recorder directory and the evidence directory are host directories outside Docker: this script never touches them.
set -euo pipefail
PROJ=opspilot-m16-p7-smoke
WANT_CLASS=disposable-harness-smoke
VOLS=("${PROJ}_pgdata" "${PROJ}_state")
confirm=""
case "${1:-}" in
  "") ;;
  --confirm) confirm="${2:-}"; [ "$confirm" = "$PROJ" ] || { echo "refused: --confirm must be exactly $PROJ"; exit 2; }
    [ "$#" -eq 3 ] && [ "$3" = "--volume-removal-authorised-by-product-owner" ] || { echo "refused: this would delete the smoke volumes, which needs the product owner's separate authorisation (--volume-removal-authorised-by-product-owner). Nothing was removed. To remove only containers and networks: ./smoke-containers-down.sh"; exit 2; } ;;
  *) echo "usage: $0 [--confirm $PROJ --volume-removal-authorised-by-product-owner]"; exit 2 ;;
esac
refuse() { echo "refused: $*. Nothing was removed."; exit 1; }
label() { docker volume inspect -f "{{ index .Labels \"$2\" }}" "$1"; }

found="$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJ" | sort | tr '\n' ' ')"
[ -n "$found" ] || { echo "nothing to remove: project $PROJ has no volumes"; exit 0; }
[ "$found" = "${VOLS[0]} ${VOLS[1]} " ] || refuse "project $PROJ should have exactly the volumes ${VOLS[*]}, found: $found"
for v in "${VOLS[@]}"; do
  [ "$(label "$v" com.docker.compose.project)" = "$PROJ" ] || refuse "volume $v does not belong to project $PROJ"
  [ "${PROJ}_$(label "$v" com.docker.compose.volume)" = "$v" ] || refuse "volume $v is not the Compose volume its name says"
  [ "$(label "$v" opspilot.p7.data)" = "$WANT_CLASS" ] || refuse "volume $v is not labelled opspilot.p7.data=$WANT_CLASS (found '$(label "$v" opspilot.p7.data)')"
  for c in $(docker ps -aq --filter "volume=$v"); do
    [ "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$c")" = "$PROJ" ] || refuse "volume $v is used by container $c, which is not part of project $PROJ"
  done
done
# The marker `p7.mjs init` writes into the journal volume. Read-only, no network. The harness image declares no volumes
# of its own, so this temporary container creates and removes nothing but itself.
marker="$(docker run --rm --network none --entrypoint sh -v "${VOLS[1]}:/state:ro" opspilot-isolated-api:latest -c 'cat /state/p7-volume.json 2>/dev/null || { [ -z "$(ls -A /state)" ] && echo EMPTY || echo NO-MARKER; }')"
case "$marker" in
  EMPTY) echo "journal volume: empty (init never ran)" ;;
  *'"failureModel": "HARNESS-SMOKE"'*) echo "journal volume: initialised by a HARNESS-SMOKE run" ;;
  *) refuse "the journal volume is not marked as HARNESS-SMOKE data (it has entries without a marker, or a marker of another run type)" ;;
esac

echo "Compose project: $PROJ"
echo "Containers and networks: those of project $PROJ only (docker compose -p $PROJ down, without -v)"
echo "Volumes: ${VOLS[*]}"
if [ -z "$confirm" ]; then echo "DRY RUN: nothing was removed. Removing the above, volumes included, needs the product owner's separate authorisation."; exit 0; fi
docker compose -p "$PROJ" down
docker volume rm "${VOLS[0]}" "${VOLS[1]}"
echo "removed the disposable smoke state of $PROJ. Recorder and evidence directories were not touched."
