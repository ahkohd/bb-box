#!/bin/sh
set -eu
udid=$1
label=$2
settle=${3:-300}
idle=${4:-300}
here=$(cd "$(dirname "$0")" && pwd)
out=${RUNS:-$HOME/slim/runs}/$label
mkdir -p "$out"

now() { python3 -c 'import time; print(f"{time.time():.3f}")'; }

state=$(xcrun simctl list devices | grep "$udid" | sed 's/.*(\([A-Za-z]*\)) *$/\1/')
if [ "$state" != "Shutdown" ]; then xcrun simctl shutdown "$udid"; fi
sleep 5
start=$(now)
xcrun simctl boot "$udid"
xcrun simctl bootstatus "$udid" -b > /dev/null
booted=$(now)
python3 -c "import json; print(json.dumps({'boot_seconds': round($booted - $start, 2)}))" > "$out/boot.json"
sleep "$settle"
python3 "$here/simtree.py" "$udid" --detail 400 > "$out/settled.json"
xcrun simctl spawn "$udid" launchctl list > "$out/launchctl-list.txt"
python3 "$here/simtree.py" "$udid" --idle "$idle" > "$out/idle.json"
python3 - "$out" <<'EOF'
import json, sys
out = sys.argv[1]
boot = json.load(open(f"{out}/boot.json"))
settled = json.load(open(f"{out}/settled.json"))
idle = json.load(open(f"{out}/idle.json"))
summary = {
    "boot_seconds": boot["boot_seconds"],
    "processes": settled["processes"],
    "footprint_mib": settled["footprint_mib"],
    "idle_cores": idle["cores"],
    "idle_cpu_seconds": idle["cpu_seconds"],
    "idle_window_seconds": idle["seconds"],
}
json.dump(summary, open(f"{out}/summary.json", "w"), indent=1)
print(json.dumps(summary))
EOF
