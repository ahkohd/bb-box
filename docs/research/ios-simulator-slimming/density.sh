#!/bin/sh
set -u
source_udid=$1
label=$2
most=${3:-10}
settle=${4:-90}
list=${5:-}
here=$(cd "$(dirname "$0")" && pwd)
out=${RUNS:-$HOME/slim/runs}/density-$label
mkdir -p "$out"
xcrun simctl shutdown "$source_udid" 2>/dev/null
clones=""
n=0
swap_mib() { sysctl -n vm.swapusage | sed 's/.*used = \([0-9.]*\)M.*/\1/'; }
free_percent() { memory_pressure -Q | sed -n 's/.*free percentage: \([0-9]*\)%.*/\1/p'; }
while [ "$n" -lt "$most" ]; do
  n=$((n + 1))
  clone=$(xcrun simctl clone "$source_udid" "$label-$n")
  clones="$clones $clone"
  start=$(date +%s)
  xcrun simctl boot "$clone"
  xcrun simctl bootstatus "$clone" -b > /dev/null 2>&1
  boot=$(( $(date +%s) - start ))
  if [ -n "$list" ]; then
    "$here/apply-list.sh" "$clone" "$list" > /dev/null 2>&1
    xcrun simctl reboot "$clone"
    xcrun simctl bootstatus "$clone" -b > /dev/null 2>&1
  fi
  disabled=$(xcrun simctl spawn "$clone" launchctl print-disabled system | grep -c "=> disabled")
  sleep "$settle"
  total=0
  processes=0
  for c in $clones; do
    line=$(python3 "$here/simtree.py" "$c" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["processes"], d["footprint_mib"])')
    processes=$((processes + ${line%% *}))
    total=$(python3 -c "print(round($total + ${line##* }, 1))")
  done
  echo "booted=$n boot_s=$boot clone_disabled=$disabled processes=$processes footprint_mib=$total free_percent=$(free_percent) swap_mib=$(swap_mib)" | tee -a "$out/steps.txt"
  vm_stat > "$out/vm_stat-$n.txt"
  if [ "$(python3 -c "print(int(float('$(swap_mib)') > 1024))")" = 1 ] || [ "$(free_percent)" -lt 10 ]; then
    echo "stopped: swap over 1 GiB or free under 10%" | tee -a "$out/steps.txt"
    break
  fi
done
for c in $clones; do xcrun simctl shutdown "$c"; xcrun simctl delete "$c"; done
