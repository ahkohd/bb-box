#!/bin/bash
set -uo pipefail
cd "$HOME"
B=./bbc
now() { date +%s.%N; }
since() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.1f s", b - a }'; }
step() { local label=$1; shift; local t; t=$(now); "$@"; local rc=$?; echo "TIME $label: $(since "$t") (exit $rc)"; return $rc; }
identity() { $B box run "$1" --machine 'sudo bb-box-identity status | grep -E "^(version|enabled|boot|marker|armed|box|source)=" | tr "\n" " "; echo'; }
seen() {
  $B box run "$1" --machine 'echo "work.txt: $(cat ~/work.txt)"; echo "host ID: $(cat ~/.bb-machines/live-check/host-id 2>/dev/null || echo none)"; echo "tailnet state: $(sudo ls /var/lib/tailscale 2>/dev/null | tr "\n" " ")"; echo "machine ID: $(cut -c1-12 /etc/machine-id)"; echo "SSH host key: $(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | cut -d" " -f2)"; echo "hostname: $(hostname)"; echo "MAC: $(cat /sys/class/net/*/address | grep -v 00:00:00:00:00:00 | tr "\n" " ")"'
  identity "$1"
}
order() {
  $B box run "$1" --machine 'for u in bb-box-identity.service systemd-networkd.service ssh.service user@$(id -u).service; do printf "%s %s\n" "$(systemctl show -p ExecMainExitTimestampMonotonic -p ActiveEnterTimestampMonotonic --value "$u" | tr "\n" " ")" "$u"; done; systemctl show -p After --value user@$(id -u).service | tr " " "\n" | grep -c bb-box-identity; sudo tail -n 2 /var/lib/bb-box/identity-resets 2>/dev/null'
}

step "a box" $B box machines add linux-arm64 --on tart --name tl-src
identity tl-src
$B box run tl-src --machine 'systemctl show -p Before --value bb-box-identity.service | tr " " "\n" | grep -E "^(systemd-networkd|ssh|user@|tailscaled)" | sort | tr "\n" " "; echo'
$B box run tl-src --machine 'mkdir -p ~/.bb-machines/live-check && head -c 9 /dev/urandom | od -An -tx1 | tr -d " \n" > ~/.bb-machines/live-check/host-id; sudo mkdir -p /var/lib/tailscale && echo stand-in | sudo tee /var/lib/tailscale/tailscaled.state >/dev/null; echo before > ~/work.txt; sync'
seen tl-src

step "stop" $B box stop tl-src --machine
step "take, stopped" $B box snapshot take tl-src --machine --name before
step "start" $B box start tl-src --machine
$B box run tl-src --machine 'echo after > ~/work.txt; sync'
$B box snapshot list tl-src --machine

step "restore" $B box snapshot restore tl-src before --machine --replace
seen tl-src
undo=$($B box snapshot list tl-src --machine | sed -nE 's/^  "(before the restore at [^"]*)".*/\1/p' | head -1)
step "undo" $B box snapshot restore tl-src "$undo" --machine --replace
seen tl-src

$B box snapshot fork tl-src before --machine --check
step "fork" $B box snapshot fork tl-src before --machine --as-machine --name tl-fork
seen tl-fork
order tl-fork
echo "-- the source after its fork"
seen tl-src
$B machine list 2>&1 | grep -E '^tl-' || :

step "keep" $B box snapshot keep tl-src before --machine
step "release the fork" $B box machines remove tl-fork
step "release the source" $B box machines remove tl-src
$B box snapshot list --all
box=$($B box snapshot list --all | sed -nE 's/^tl-src \((bx[a-z0-9]+)\).*/\1/p' | head -1)
step "fork of the kept snapshot after the release" $B box snapshot fork "$box" before --machine --name tl-kept
seen tl-kept

step "release the kept one's fork" $B box machines remove tl-kept
$B box snapshot delete "$box" before --machine
$B box sweep
$B box snapshot list --all
$B box machines
