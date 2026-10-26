#!/bin/sh
set -u
U=$(xcrun simctl list devices -j | python3 -c 'import json,sys; print(next(d["udid"] for r in json.load(sys.stdin)["devices"].values() for d in r if d["name"]=="iPhone 18 Pro"))')
SEED=/private/var/tmp/com.apple.CoreSimulator.SimDevice.$U/disabled.plist
xcrun simctl shutdown "$U" 2>/dev/null
for i in $(seq 1 "$1"); do
  N=$(xcrun simctl clone "$U" "shared-$i")
  mkdir -p "/private/var/tmp/com.apple.CoreSimulator.SimDevice.$N"
  cp "$SEED" "/private/var/tmp/com.apple.CoreSimulator.SimDevice.$N/disabled.plist"
  echo "shared-$i $N"
done
