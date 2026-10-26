#!/bin/sh
set -eu
name=$1
type=$2
label=$3
out=${RUNS:-$HOME/slim/runs}/$label
mkdir -p "$out"
now() { python3 -c 'import time; print(f"{time.time():.3f}")'; }
udid=$(xcrun simctl create "$name" "$type" com.apple.CoreSimulator.SimRuntime.iOS-27-0)
start=$(now)
xcrun simctl boot "$udid"
xcrun simctl bootstatus "$udid" -b > /dev/null
booted=$(now)
python3 -c "import json; print(json.dumps({'udid': '$udid', 'first_boot_seconds': round($booted - $start, 2)}))" | tee "$out/first-boot.json"
