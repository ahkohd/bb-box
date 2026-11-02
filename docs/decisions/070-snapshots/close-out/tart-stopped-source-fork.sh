#!/bin/bash
set -uo pipefail
[ $# -eq 3 ] || { echo "usage: tart-stopped-source-fork.sh <user@mac> <known_hosts file> <private key file>"; exit 2; }
target=$1 known=$2 key=$3
cd "$HOME"
B=./bbc
install=$($B box install-id --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["installId"])')
now() { date +%s.%N; }
since() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.1f s", b - a }'; }
step() { local label=$1; shift; local t; t=$(now); "$@"; local rc=$?; echo "TIME $label: $(since "$t") (exit $rc)"; return $rc; }
on_mac() { ssh -o BatchMode=yes -o UserKnownHostsFile="$known" -i "$key" "$target" "export TART_NO_AUTO_PRUNE=1; $1"; }
bootp_form() { printf '%s' "$1" | awk -F: '{ for (i = 1; i <= NF; i++) { v = $i; sub(/^0/, "", v); printf "%s%s", (i > 1 ? ":" : ""), v } }'; }
lease() {
  echo "-- bootpd's lease for $1 at $(date -u +%H:%M:%S)"
  on_mac "awk -v hw='hw_address=1,$(bootp_form "$1")' '/^\\{/ { block = \"\"; keep = 0 } { block = block \$0 \"\\n\" } \$0 ~ hw \"\$\" { keep = 1 } /^\\}/ { if (keep) printf \"%s\", block }' /var/db/dhcpd_leases; date +now=%s"
}
recorded() { $B box list --all --json | python3 -c "import json,sys; [print(b['address']) for b in json.load(sys.stdin) if b.get('name') == sys.argv[1]]" "$1"; }
held() { $B box run "$1" --machine 'ip -o -4 addr show scope global | awk "{print \$4}" | cut -d/ -f1' | tr -d '\r'; }
client_id() { $B box run "$1" --machine 'sudo sed -n "s/^CLIENTID=//p" /run/systemd/netif/leases/*' | tr -d '\r'; }
mac_of() { $B box run "$1" --machine 'cat /sys/class/net/e*/address | head -1' | tr -d '\r\n'; }
seen() { echo "$1 records $(recorded "$1"), holds $(held "$1"), client ID $(client_id "$1")"; }
forks_on_mac() {
  for _ in $(seq 1 240); do
    on_mac "h=\${TART_HOME:-\$HOME/.tart}; for f in \$HOME/.bb-box/tart/owners/*; do grep -qxF install=$install \"\$f\" || continue; vm=\${f##*/}; echo \"\$vm \$(sed -n 's/.*\"macAddress\" *: *\"\\([^\"]*\\)\".*/\\1/p' \"\$h/vms/\$vm/config.json\" 2>/dev/null)\"; done" 2>/dev/null
    sleep 0.5
  done
}

step "a box" $B box machines add linux-arm64 --on tart --name tl-src
seen tl-src
src_mac=$(mac_of tl-src)
$B box run tl-src --machine 'networkctl --version | head -1; sudo journalctl -b -u systemd-networkd -o short-monotonic --no-pager | grep -i dhcpv4'
lease "$src_mac"
step "stop" $B box stop tl-src --machine
lease "$src_mac"
step "take, stopped" $B box snapshot take tl-src --machine --name stopped
forks_on_mac > fork-macs.log & watcher=$!
step "fork, source stopped" $B box snapshot fork tl-src stopped --machine --as-machine --name tl-fork
kill "$watcher" 2>/dev/null
for m in $(awk '$2 != "" { print $2 }' fork-macs.log | sort -u); do [ "$m" = "$src_mac" ] || lease "$m"; done
$B box machines
if $B box machines | grep -q '^- tl-fork: .*ready'; then
  seen tl-fork
  $B box run tl-fork --machine 'sudo journalctl -b -o short-monotonic --no-pager | grep -E "Finished bb-box-identity.service|DHCPv4 address"'
  step "stop the fork" $B box stop tl-fork --machine
fi
step "start the source" $B box start tl-src --machine
seen tl-src
$B box run tl-src --machine 'sudo journalctl -b -1 -u systemd-networkd -o short-monotonic --no-pager | tail -n 5'
step "stop the source" $B box stop tl-src --machine
$B box machines remove tl-fork 2>/dev/null
$B box machines remove tl-src --delete-kept
$B box sweep
$B box machines
