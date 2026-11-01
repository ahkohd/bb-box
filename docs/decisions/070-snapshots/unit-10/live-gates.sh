#!/bin/bash
set -uo pipefail
cd "$HOME"
B=./bbc
export PATH=$HOME/.local/share/bb-box/microsandbox/bin:$PATH
now() { date +%s.%N; }
since() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.2f s", b - a }'; }
step() { local label=$1; shift; local t; t=$(now); "$@"; local rc=$?; echo "TIME $label: $(since "$t") (exit $rc)"; return $rc; }
machine() { $B machine list 2>&1 | grep -E "^$1 "; }
connected_after() {
  local box=$1 began=$2 at
  for _ in $(seq 1 120); do
    at=$($B box run "$box" --machine 'grep "\"msg\":\"Connected to server\"" ~/.bb-machines/*/logs/host-daemon.1.log | tail -1 | sed -E "s/.*\"time\":([0-9]+).*/\1/"')
    [ "${at:-0}" -gt "$(awk -v a="$began" 'BEGIN { printf "%d", a * 1000 }')" ] && break
    sleep 1
  done
  echo "TIME BB's daemon connected: $(awk -v a="$began" -v t="$at" 'BEGIN { printf "%.1f s", t / 1000 - a }') after the restore began"
}
state() { $B box run "$1" --machine 'cat ~/work.txt; a=$(cat ~/count); sleep 2; echo "count $a then $(cat ~/count)"; if kill -0 "$(cat ~/counter.pid)" 2>/dev/null; then echo "counter $(cat ~/counter.pid) running"; else echo "no process $(cat ~/counter.pid)"; fi; docker images --format "{{.Repository}}" | tr "\n" " "; echo; cat ~/.bb-machines/*/host-id; echo; hostname; mount | grep " /run "; sudo bb-box-identity status | grep -E "^(boot|marker|box)="'; }

step "a box" $B box machines add linux --on microsandbox --name msb-src
$B box run msb-src --machine 'sudo bb-box-identity status; mount | grep /var/lib/docker; docker run --rm hello-world | grep -m1 Hello'
$B box run msb-src --machine 'echo before > ~/work.txt; nohup sh -c "i=0; while :; do echo \$i > ~/count; i=\$((i+1)); sleep 1; done" >/dev/null 2>&1 & echo $! > ~/counter.pid; sync; sleep 3'
step "take with memory" $B box snapshot take msb-src --machine --name "with memory" --memory
$B box run msb-src --machine 'echo after > ~/work.txt; kill $(cat ~/counter.pid); docker rmi -f hello-world >/dev/null; sync'
step "take, disk" $B box snapshot take msb-src --machine --name "disk only"
$B box snapshot list msb-src --machine

began=$(now)
step "restore, memory" $B box snapshot restore msb-src "with memory" --machine --replace
connected_after msb-src "$began"
state msb-src; machine msb-src; msb ls

step "fork of the memory snapshot" $B box snapshot fork msb-src "with memory" --machine --as-machine --name msb-fork
state msb-fork
$B box run msb-fork --machine 'sudo cat /var/lib/bb-box/identity-resets; md5sum /etc/machine-id; ls /etc/ssh/*key.pub'
$B box run msb-src --machine 'md5sum /etc/machine-id'
machine msb-fork; machine msb-src

undo=$($B box snapshot list msb-src --machine | sed -nE 's/^  "(before the restore at [^"]*)".*/\1/p' | head -1)
began=$(now)
step "undo" $B box snapshot restore msb-src "$undo" --machine --replace
connected_after msb-src "$began"
state msb-src

step "take a parent" $B box snapshot take msb-src --machine --name parent
step "take its child" $B box snapshot take msb-src --machine --name child
step "delete the parent" $B box snapshot delete msb-src parent --machine
$B box snapshot list msb-src --machine
$B box snapshot delete msb-src child --machine

step "keep" $B box snapshot keep msb-src "with memory" --machine
step "release" $B box machines remove msb-src
msb snapshot list
box=$($B box snapshot list --all | sed -nE 's/^msb-src \((bx[a-z0-9]+)\).*/\1/p' | head -1)
step "fork of the kept snapshot after the release" $B box snapshot fork "$box" "with memory" --machine --name msb-kept
state msb-kept

$B box machines remove msb-fork
$B box machines remove msb-kept
$B box snapshot delete "$box" "with memory" --machine
$B box snapshot list --all
msb ls; msb snapshot list; ls "$HOME/.local/share/bb-box/microsandbox/kept/"
