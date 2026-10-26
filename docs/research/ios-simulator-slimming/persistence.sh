#!/bin/sh
set -u
udid=$1
list=$2
here=$(cd "$(dirname "$0")" && pwd)
out=${RUNS:-$HOME/slim/runs}/persistence
mkdir -p "$out"
count_disabled() { xcrun simctl spawn "$udid" launchctl print-disabled system | grep -c "=> disabled"; }
processes() { python3 "$here/simtree.py" "$udid" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["processes"], d["footprint_mib"])'; }
boot() {
  state=$(xcrun simctl list devices | grep "$udid" | sed 's/.*(\([A-Za-z]*\)) *$/\1/')
  [ "$state" = "Booted" ] || xcrun simctl boot "$udid"
  xcrun simctl bootstatus "$udid" -b > /dev/null
}
{
boot
echo "slim, booted: disabled $(count_disabled); after 60 s: $(sleep 60; processes)"
start=$(date +%s); xcrun simctl reboot "$udid"; xcrun simctl bootstatus "$udid" -b > /dev/null
echo "after simctl reboot ($(( $(date +%s) - start )) s): disabled $(count_disabled); after 60 s: $(sleep 60; processes)"
start=$(date +%s)
"$here/apply-list.sh" "$udid" "$list" enable
xcrun simctl reboot "$udid"; xcrun simctl bootstatus "$udid" -b > /dev/null
echo "turned off: enable and reboot took $(( $(date +%s) - start )) s; disabled $(count_disabled); after 60 s: $(sleep 60; processes)"
start=$(date +%s)
"$here/apply-list.sh" "$udid" "$list" disable
xcrun simctl reboot "$udid"; xcrun simctl bootstatus "$udid" -b > /dev/null
echo "turned on again: disable and reboot took $(( $(date +%s) - start )) s; disabled $(count_disabled); after 60 s: $(sleep 60; processes)"
xcrun simctl shutdown "$udid"
xcrun simctl erase "$udid"
start=$(date +%s); boot
echo "after simctl erase, first boot $(( $(date +%s) - start )) s: disabled $(count_disabled); after 60 s: $(sleep 60; processes)"
xcrun simctl shutdown "$udid"
} 2>&1 | grep -v "^Warning: Please switch" | tee "$out/persistence.txt"
