#!/bin/sh
set -u

name=${1:-slim}
url=${PAGE_URL:-http://127.0.0.1:8765/page.html?busy}
mkdir -p "$HOME/s"
udid=$(xcrun simctl list devices -j | python3 -c 'import json,sys; n=sys.argv[1]; print(next(d["udid"] for r in json.load(sys.stdin)["devices"].values() for d in r if d["name"]==n))' "$name")
started=$(python3 -c 'import time; print(time.time())')
xcrun simctl list devices | grep -F "($udid)" | grep -q '(Booted)' || xcrun simctl boot "$udid"
xcrun simctl bootstatus "$udid" -b >/dev/null
boot=$(python3 -c "import sys, time; print(f'{time.time() - float(sys.argv[1]):.1f}')" "$started")
pkill -u "$(id -u)" -f "idb_companion --udid $udid" 2>/dev/null
rm -f "$HOME/s/idb.sock"
nohup /usr/local/bin/idb_companion --udid "$udid" --grpc-domain-sock "$HOME/s/idb.sock" >"$HOME/s/companion.log" 2>&1 &
for _ in $(seq 1 300); do [ -S "$HOME/s/idb.sock" ] && break; sleep 0.1; done
xcrun simctl launch "$udid" com.apple.mobilesafari >/dev/null
sleep 2
xcrun simctl openurl "$udid" "$url"
printf '[{"name":"%s","udid":"%s","socket":"%s"}]\n' "$(id -un)" "$udid" "$HOME/s/idb.sock" >"$HOME/targets.json"
echo "$(id -un) $udid booted in $boot s"
