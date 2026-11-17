#!/usr/bin/env bash
# Exercises p7-firewall.sh (apply, rollback, confirm, status, remove, the boot path) against STUB iptables/ip6tables
# that only keep their rules in a file. Run it in a throwaway Linux container as root; it changes no real firewall:
#   docker run --rm -u 0 -v "$PWD/firewall":/fw:ro --entrypoint bash opspilot-isolated-api:latest /fw/test-with-stubs.sh
set -euo pipefail
[ "$(uname -s)" = Linux ] && [ "$(id -u)" = 0 ] || { echo "run in a Linux container as root"; exit 1; }
t="$(mktemp -d)"; mkdir "$t/bin"; cp /fw/p7-firewall.sh "$t/fw.sh"
cat >"$t/bin/iptables" <<'STUB'
#!/usr/bin/env bash
# Minimal stand-in: -N, -A, -I, -D, -S, -F, -X on a state file. Fails like iptables does for a missing/existing chain.
st="${STUB_STATE:?}/$(basename "$0").rules"; ch="${STUB_STATE}/$(basename "$0").chains"; touch "$st" "$ch"
[ "$1" = -w ] && shift
op="$1"; chain="$2"; shift 2
has() { grep -qx "$chain" "$ch" || [[ "$chain" == INPUT ]]; }
case "$op" in
  -N) has && exit 1; echo "$chain" >>"$ch" ;;
  -A) has || exit 1; echo "-A $chain $*" >>"$st" ;;
  -I) has || exit 1; shift; { echo "-A $chain $*"; cat "$st"; } >"$st.new"; mv "$st.new" "$st" ;;
  -D) grep -vxF -- "-A $chain $*" "$st" >"$st.new" || true; mv "$st.new" "$st" ;;
  -S) has || exit 1; echo "-N $chain"; grep -- "^-A $chain " "$st" || true ;;
  -F) has || exit 1; grep -v -- "^-A $chain " "$st" >"$st.new" || true; mv "$st.new" "$st" ;;
  -X) has || exit 1; grep -vx "$chain" "$ch" >"$ch.new" || true; mv "$ch.new" "$ch" ;;
  *) exit 2 ;;
esac
STUB
chmod +x "$t/bin/iptables"; cp "$t/bin/iptables" "$t/bin/ip6tables"
export PATH="$t/bin:$PATH" STUB_STATE="$t" RECORDER_IP=192.168.1.20 RECORDER_PORT=8787
rules() { cat "$t"/iptables.rules "$t"/ip6tables.rules 2>/dev/null | grep -c p7-harness || true; }
fail() { echo "FIREWALL STUB TEST FAILED: $*"; exit 1; }

echo "== apply on a clean machine (no DOCKER-USER chain yet), then roll back unconfirmed"
P7_ROLLBACK_SECONDS=2 "$t/fw.sh" apply >/dev/null
[ "$(rules)" = 13 ] || fail "expected 13 tagged rules after apply, got $(rules)"
grep -q -- "-A P7-EGRESS -p tcp -d 192.168.1.20 --dport 8787 .* -j RETURN" "$t/iptables.rules" || fail "recorder rule missing"
[ "$(grep -- '^-A P7-EGRESS' "$t/iptables.rules" | tail -1 | grep -c -- '-j DROP')" = 1 ] || fail "P7-EGRESS must end in DROP"
[ "$(grep -- '^-A P7-EGRESS' "$t/iptables.rules" | head -1 | grep -c -- '-j RETURN')" = 1 ] || fail "the recorder rule must come before the DROP"
[ "$(grep -c -- '^-A INPUT -i p7' "$t/iptables.rules")" = 3 ] || fail "three INPUT jumps expected"
sleep 4
[ "$(rules)" = 0 ] || fail "unconfirmed rules were not rolled back ($(rules) left)"
"$t/fw.sh" confirm >/dev/null 2>&1 && fail "confirm must refuse after a rollback" || true
echo "ok: 13 rules applied in the right order; rolled back without a confirm; a late confirm is refused"

echo "== apply, confirm, and the rules stay"
P7_ROLLBACK_SECONDS=2 "$t/fw.sh" apply >/dev/null; "$t/fw.sh" confirm >/dev/null; sleep 4
[ "$(rules)" = 13 ] || fail "confirmed rules did not stay ($(rules))"
out="$("$t/fw.sh" status)"; grep -q "P7-EGRESS" <<<"$out" || fail "status"   # captured first: grep -q would close the pipe early
echo "ok: confirmed rules stay"

echo "== applying again does not duplicate; a foreign rule is never touched"
echo "-A INPUT -p tcp --dport 22 -j ACCEPT" >>"$t/iptables.rules"
P7_NO_ROLLBACK=1 "$t/fw.sh" apply >/dev/null
[ "$(rules)" = 13 ] || fail "re-apply duplicated rules ($(rules))"

echo "== the boot path (systemd unit): no rollback, on a machine where nothing is applied yet"
"$t/fw.sh" remove >/dev/null; [ "$(rules)" = 0 ] || fail "remove left rules"
grep -qxF -- "-A INPUT -p tcp --dport 22 -j ACCEPT" "$t/iptables.rules" || fail "remove touched a rule that is not ours"
unit="$("$t/fw.sh" unit)"
grep -q "P7_NO_ROLLBACK=1" <<<"$unit" && grep -q "^Before=docker.service" <<<"$unit" && grep -q "^RequiredBy=docker.service" <<<"$unit" || fail "unit"
P7_NO_ROLLBACK=1 "$t/fw.sh" apply >/dev/null; sleep 3
[ "$(rules)" = 13 ] || fail "boot-path rules did not stay ($(rules))"
echo "ok: idempotent; foreign rules untouched; the boot path keeps its rules; the unit orders itself before Docker and is required by it"
echo "FIREWALL STUB TEST PASSED (stub iptables only: no real firewall was changed, and this proves nothing about real packet filtering)"
