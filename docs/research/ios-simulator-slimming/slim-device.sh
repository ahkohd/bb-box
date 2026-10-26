#!/bin/sh
set -eu
name=$1
type=$2
list=$3
label=$4
here=$(cd "$(dirname "$0")" && pwd)
out=${RUNS:-$HOME/slim/runs}/$label
udid=$("$here/fresh-device.sh" "$name" "$type" "$label" | python3 -c 'import json,sys; print(json.load(sys.stdin)["udid"])')
echo "$udid" > "$out/udid"
cp "$list" "$out/list.txt"
"$here/apply-list.sh" "$udid" "$list" | tee "$out/apply.txt"
xcrun simctl spawn "$udid" launchctl print-disabled system > "$out/print-disabled.txt"
"$here/measure-boot.sh" "$udid" "$label"
xcrun simctl spawn "$udid" launchctl print-disabled system > "$out/print-disabled-after-boot.txt"
"$here/run-needs.sh" "$udid" "$label"
xcrun simctl shutdown "$udid"
