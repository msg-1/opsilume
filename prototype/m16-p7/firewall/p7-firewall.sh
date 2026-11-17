#!/usr/bin/env bash
# Host firewall for the dedicated P7 test machine (Linux, Docker Engine with iptables). NOT applied anywhere yet.
#   RECORDER_IP=192.168.1.20 RECORDER_PORT=8787 ./p7-firewall.sh print     # show the rules; changes nothing
#   sudo RECORDER_IP=... RECORDER_PORT=... ./p7-firewall.sh apply          # add them; rolls back by itself after
#                                                                          # P7_ROLLBACK_SECONDS (default 180) unless:
#   sudo ./p7-firewall.sh confirm                                          # keep them (run from a NEW ssh session)
#   sudo ./p7-firewall.sh remove | status
#   RECORDER_IP=... RECORDER_PORT=... ./p7-firewall.sh unit                # print a systemd unit that applies them
#                                                                          # before Docker starts, on every boot
# What it does:
#   - Drops everything the harness networks (bridges p7db0, p7gw0, p7eg0) send to the HOST itself: host services such
#     as sshd on the bridge addresses become unreachable from the containers.
#   - Lets the gateway network (p7eg0) reach only RECORDER_IP:RECORDER_PORT over TCP; drops all its other traffic.
#   - Drops anything leaving the two internal networks (Docker already does; stated explicitly).
# What it never touches: the physical interface, sshd from the LAN, or any rule that is not tagged p7-harness. Every
# rule matches only the three bridge names above, so the operator's management access cannot be cut by it.
set -euo pipefail
cmd="${1:-print}"
BRIDGES=(p7db0 p7gw0 p7eg0)
TAG=p7-harness
CONFIRMED=/run/p7-firewall.confirmed

need_target() {
  [[ "${RECORDER_IP:-}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo "RECORDER_IP must be an IPv4 address"; exit 1; }
  [[ "${RECORDER_PORT:-}" =~ ^[0-9]{1,5}$ ]] || { echo "RECORDER_PORT must be a port"; exit 1; }
}
# One rule per line: "<binary> <table-operation and arguments>". Order matters within a chain.
rules() {
  echo "iptables -N P7-HOST"
  echo "iptables -A P7-HOST -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment $TAG -j ACCEPT"   # replies to connections the host opened
  echo "iptables -A P7-HOST -m comment --comment $TAG -j DROP"
  for b in "${BRIDGES[@]}"; do echo "iptables -I INPUT 1 -i $b -m comment --comment $TAG -j P7-HOST"; done
  echo "iptables -N DOCKER-USER"                                                                               # exists once Docker has started; harmless if it does
  echo "iptables -N P7-EGRESS"
  echo "iptables -A P7-EGRESS -p tcp -d $RECORDER_IP --dport $RECORDER_PORT -m comment --comment $TAG -j RETURN"
  echo "iptables -A P7-EGRESS -m comment --comment $TAG -j DROP"
  echo "iptables -I DOCKER-USER 1 -i p7eg0 -m comment --comment $TAG -j P7-EGRESS"
  for b in p7db0 p7gw0; do echo "iptables -I DOCKER-USER 1 -i $b ! -o $b -m comment --comment $TAG -j DROP"; done
  for b in "${BRIDGES[@]}"; do echo "ip6tables -I INPUT 1 -i $b -m comment --comment $TAG -j DROP"; done       # the networks are IPv4-only; this keeps it so
}
remove() {
  for bin in iptables ip6tables; do
    command -v "$bin" >/dev/null || continue
    # Delete tagged rules from the built-in chains, then flush and delete our own chains.
    for chain in INPUT DOCKER-USER; do
      # `|| true`: no such chain, or no tagged rule, is the normal case on a clean machine.
      { "$bin" -w -S "$chain" 2>/dev/null || true; } | { grep -- "--comment $TAG" || true; } | sed 's/^-A /-D /' | while read -r r; do eval "$bin -w $r"; done
    done
    for chain in P7-HOST P7-EGRESS; do "$bin" -w -F "$chain" 2>/dev/null || true; "$bin" -w -X "$chain" 2>/dev/null || true; done
  done
  rm -f "$CONFIRMED"
}
linux_root() { [ "$(uname -s)" = Linux ] && [ "$(id -u)" = 0 ] || { echo "apply/remove/confirm/status need root on the Linux test machine"; exit 1; }; }

case "$cmd" in
  print) need_target; rules ;;
  apply)
    need_target; linux_root; remove
    rules | while read -r bin rest; do
      case "$rest" in "-N "*) "$bin" -w $rest 2>/dev/null || true ;; *) "$bin" -w $rest ;; esac
    done
    # At boot (the systemd unit) there is nobody to confirm and the rules were confirmed when first applied: no rollback.
    if [ "${P7_NO_ROLLBACK:-}" = 1 ]; then touch "$CONFIRMED"; echo "applied (no rollback)"; exit 0; fi
    secs="${P7_ROLLBACK_SECONDS:-180}"
    ( sleep "$secs"; [ -f "$CONFIRMED" ] || "$0" remove ) </dev/null >/dev/null 2>&1 &
    disown
    echo "applied. Open a NEW ssh session to this machine now; if it works, run: sudo $0 confirm"
    echo "without confirm, the rules are removed in $secs seconds." ;;
  confirm) linux_root; iptables -w -S P7-HOST >/dev/null 2>&1 || { echo "nothing to confirm: the rules are not applied (already rolled back?)"; exit 1; }; touch "$CONFIRMED"; echo "kept" ;;
  remove) linux_root; remove; echo "removed" ;;
  status) linux_root; for c in INPUT DOCKER-USER P7-HOST P7-EGRESS; do echo "== $c"; iptables -w -S "$c" 2>/dev/null | grep -E "$TAG|^-N" || echo "(none)"; done ;;
  unit)
    need_target
    cat <<UNIT
# /etc/systemd/system/p7-firewall.service : the rules must be in place before Docker restarts the stack after a power cut.
[Unit]
Description=P7 harness firewall
Before=docker.service
Wants=network-pre.target
After=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=RECORDER_IP=$RECORDER_IP RECORDER_PORT=$RECORDER_PORT P7_NO_ROLLBACK=1
ExecStart=$(cd "$(dirname "$0")" && pwd)/p7-firewall.sh apply
ExecStop=$(cd "$(dirname "$0")" && pwd)/p7-firewall.sh remove

[Install]
WantedBy=multi-user.target
# Docker must not start the stack without these rules: if this unit fails, docker.service does not start.
RequiredBy=docker.service
UNIT
    ;;
  *) echo "usage: p7-firewall.sh print|apply|confirm|remove|status|unit"; exit 1 ;;
esac
