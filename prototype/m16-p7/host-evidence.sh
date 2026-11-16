#!/usr/bin/env bash
# P7 host evidence, run on the Linux machine under test (as root, so findmnt, hdparm and journalctl can read):
#   sudo ./host-evidence.sh <run> <label>      e.g. <label> = baseline, cycle-0003-after-boot, final
# Read-only: it records the platform and logs, and installs nothing (a missing tool is recorded as missing).
# Writes evidence/<run>/host/<label>/ and refuses to overwrite an existing directory.
set -u
run="${1:?run id}"; label="${2:?label}"
[[ "$run" =~ ^[A-Za-z0-9_-]{1,64}$ && "$label" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || { echo "bad run or label"; exit 1; }
project="${P7_PROJECT:-opspilot-m16-p7}"
out="${P7_EVIDENCE_HOST:-$(dirname "$0")/evidence}/$run/host/$label"
mkdir -p "$(dirname "$out")" && mkdir "$out" || { echo "refused: $out exists"; exit 1; }
cap() { local name="$1"; shift; if command -v "$1" >/dev/null 2>&1; then "$@" >"$out/$name.txt" 2>&1; echo "exit $?" >>"$out/$name.txt"; else echo "missing: $1" >"$out/$name.txt"; fi; }

cap os-release cat /etc/os-release
cap uname uname -a
cap virt systemd-detect-virt
cap uptime uptime
cap docker-version docker version
cap docker-root docker info -f '{{.DockerRootDir}} {{.Driver}}'
cap lsblk lsblk -o NAME,MODEL,SERIAL,ROTA,TRAN,SIZE,FSTYPE,MOUNTPOINTS
for v in pgdata state; do
  mp="$(docker volume inspect -f '{{.Mountpoint}}' "${project}_${v}" 2>/dev/null)"
  echo "$mp" >"$out/volume-$v-mountpoint.txt"
  [ -n "$mp" ] && cap "findmnt-$v" findmnt -T "$mp" -o TARGET,SOURCE,FSTYPE,OPTIONS
done
for d in /sys/block/*; do
  b="$(basename "$d")"; [[ "$b" == loop* || "$b" == ram* ]] && continue
  { echo "write_cache: $(cat "$d/queue/write_cache" 2>/dev/null)"; echo "fua: $(cat "$d/queue/fua" 2>/dev/null)"; echo "rotational: $(cat "$d/queue/rotational" 2>/dev/null)"; } >"$out/queue-$b.txt"
  case "$b" in
    nvme*) cap "nvme-id-ctrl-$b" nvme id-ctrl "/dev/$b"; cap "nvme-vwc-$b" nvme get-feature -f 6 "/dev/$b" ;;
    sd*) cap "hdparm-W-$b" hdparm -W "/dev/$b" ;;
  esac
  cap "smart-$b" smartctl -a "/dev/$b"
done
cap kernel-log journalctl -k -b --no-pager
cap boots journalctl --list-boots --no-pager
cap db-log docker compose -p "$project" logs --no-color --timestamps db
cap containers docker compose -p "$project" ps -a
(cd "$out" && sha256sum ./*.txt >SHA256SUMS) 2>/dev/null || (cd "$out" && shasum -a 256 ./*.txt >SHA256SUMS)
sync
echo "host evidence written to $out"
