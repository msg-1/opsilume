#!/usr/bin/env bash
# P7 host evidence, run on the Linux machine under test (as root, so findmnt, hdparm and journalctl can read):
#   sudo ./host-evidence.sh <run> <label> [--flush-probe]     e.g. <label> = baseline, cycle-0003-after-boot, final
# It records the platform and logs, and installs nothing (a missing tool is recorded as missing). Read-only, except
# with --flush-probe: that writes and deletes one small file beside the journal volume, to see whether the kernel
# issues flush requests to the device for fsync (it cannot show that the DEVICE honours them).
# Writes evidence/<run>/host/<label>/ and refuses to overwrite an existing directory.
set -u
run="${1:?run id}"; label="${2:?label}"; probe="${3:-}"
[[ "$run" =~ ^[A-Za-z0-9_-]{1,64}$ && "$label" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || { echo "bad run or label"; exit 1; }
project="${P7_PROJECT:-opsilume-m16-p7}"
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || { echo "bad P7_PROJECT"; exit 1; }
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
# Smoke volumes are named per generation (compose.smoke.yml): pass P7_SMOKE_GENERATION with the smoke project.
# Only the smoke project has generations: with any other project the variable is ignored, so it can't misname a
# qualifying volume if it is still set in the operator's shell.
gen=""; [ "$project" != opsilume-m16-p7-smoke ] || gen="${P7_SMOKE_GENERATION:-}"
[[ "$gen" =~ ^[a-z0-9]{0,24}$ ]] || { echo "bad P7_SMOKE_GENERATION"; exit 1; }
for v in pgdata state; do
  mp="$(docker volume inspect -f '{{.Mountpoint}}' "${project}_${v}${gen:+_$gen}" 2>/dev/null)"
  echo "$mp" >"$out/volume-$v-mountpoint.txt"
  [ -n "$mp" ] && cap "findmnt-$v" findmnt -T "$mp" -o TARGET,SOURCE,FSTYPE,OPTIONS
done
for d in /sys/block/*; do
  b="$(basename "$d")"; [[ "$b" == loop* || "$b" == ram* ]] && continue
  { echo "write_cache: $(cat "$d/queue/write_cache" 2>/dev/null)"; echo "fua: $(cat "$d/queue/fua" 2>/dev/null)"; echo "rotational: $(cat "$d/queue/rotational" 2>/dev/null)"; echo "scheduler: $(cat "$d/queue/scheduler" 2>/dev/null)"; echo "model: $(cat "$d/device/model" 2>/dev/null)"; echo "firmware: $(cat "$d/device/firmware_rev" 2>/dev/null || cat "$d/device/rev" 2>/dev/null)"; echo "stat: $(cat "$d/stat" 2>/dev/null)"; } >"$out/queue-$b.txt"
  case "$b" in
    nvme*) cap "nvme-id-ctrl-$b" nvme id-ctrl "/dev/$b"; cap "nvme-vwc-$b" nvme get-feature -f 6 "/dev/$b" ;;
    sd*) cap "hdparm-W-$b" hdparm -W "/dev/$b"; cap "hdparm-I-$b" hdparm -I "/dev/$b" ;;   # -I lists the FLUSH CACHE commands the drive reports
  esac
  cap "smart-$b" smartctl -a "/dev/$b"
done
cap lsblk-tree lsblk -s -o NAME,TYPE,TRAN,MODEL
cap lspci-storage sh -c 'lspci -nn 2>/dev/null | grep -iE "sata|nvme|raid|scsi|storage|ahci"'
cap kernel-storage-messages sh -c 'journalctl -k -b --no-pager 2>/dev/null | grep -iE "write cache|FUA|flush|barrier|nvme|ata[0-9]|sd[a-z]"'

# Flush probe (opt-in). Field 16 of /sys/block/<dev>/stat counts flush requests the kernel sent to the device
# (kernel 5.5+). If it rises while small files are fsynced on the journal's filesystem, the kernel issues flushes on
# this path. With a "write through" device the kernel sends none, and the count stays the same.
if [ "$probe" = "--flush-probe" ]; then
  pdir="${P7_FLUSH_PROBE_DIR:-$(dirname "$(cat "$out/volume-state-mountpoint.txt" 2>/dev/null)" 2>/dev/null)}"
  if [ -z "$pdir" ] || [ "$pdir" = . ] || [ ! -d "$pdir" ]; then echo "skipped: no probe directory (the state volume was not found)" >"$out/flush-probe.txt"
  else
    flushes() { for d in /sys/block/*; do b="$(basename "$d")"; [[ "$b" == loop* || "$b" == ram* ]] && continue; echo "$b $(awk '{print ($16 == "" ? "unavailable" : $16)}' "$d/stat" 2>/dev/null)"; done; }
    f="$pdir/p7-flush-probe.$$"
    { echo "probe directory: $pdir"; echo "filesystem: $(findmnt -no SOURCE,FSTYPE,OPTIONS -T "$pdir" 2>/dev/null)"; echo "kernel: $(uname -r)"; echo "--- flush requests per device before"; flushes
      for i in $(seq 1 20); do dd if=/dev/zero of="$f" bs=4k count=1 conv=fsync status=none 2>&1; done; rm -f "$f"
      echo "--- flush requests per device after 20 fsynced 4 KiB writes"; flushes
      echo "--- WHAT THIS SHOWS: a higher count on the journal's device means the KERNEL issued flush requests for fsync of a probe file on this filesystem."
      echo "--- WHAT IT DOES NOT SHOW: that the device honours a flush (vendor documentation only), or that PostgreSQL's or the journal's own writes are durable (only the power-cut cycles test that)."; } >"$out/flush-probe.txt" 2>&1
  fi
fi
cap kernel-log journalctl -k -b --no-pager
cap boots journalctl --list-boots --no-pager
# Plain docker, by label: `docker compose` here would read compose.yml and refuse without the run's variables, which
# sudo drops. The database log lives with its container, so capture it before that project is taken down.
cap db-log sh -c "docker logs --timestamps \"\$(docker ps -aq --filter label=com.docker.compose.project=$project --filter label=com.docker.compose.service=db | head -1)\""
cap containers docker ps -a --filter "label=com.docker.compose.project=$project"
# Which image each container of the project was created from (the image id), and the two images as they are now.
# Compare with the image id declared at create-run: nothing inside a container can observe it.
cap container-images sh -c "docker inspect -f '{{.Name}} {{.Image}} {{.Config.Image}}' \$(docker ps -aq --filter label=com.docker.compose.project=$project)"
cap images docker image inspect -f '{{.Os}}/{{.Architecture}} {{.Id}} {{.RepoTags}}' opsilume-isolated-api:latest postgres:16-alpine
(cd "$out" && sha256sum ./*.txt >SHA256SUMS) 2>/dev/null || (cd "$out" && shasum -a 256 ./*.txt >SHA256SUMS)
sync
echo "host evidence written to $out"
