#!/bin/sh
set -u
udid=$1
label=$2
here=$(cd "$(dirname "$0")" && pwd)
out=${RUNS:-$HOME/slim/runs}/$label/stream-check
mkdir -p "$out"
pages=$(mktemp -d)
cp "$here/../ios-simulator-boxes/page.html" "$pages/"
(cd "$pages" && exec python3 -m http.server 8765 --bind 127.0.0.1) > "$out/http.log" 2>&1 &
http=$!
xcrun simctl terminate "$udid" com.apple.mobilesafari 2>/dev/null
idb_companion --udid "$udid" --grpc-port 10882 > "$out/companion.log" 2>&1 &
companion=$!
until nc -z 127.0.0.1 10882 2>/dev/null; do sleep 0.5; done
for round in 1 2; do
  "$HOME/idbenv/bin/python" "$here/../ios-simulator-boxes/measure.py" idb --udid "$udid" --out "$out/round$round" > "$out/round$round.log" 2>&1
  python3 -c "
import json; d = json.load(open('$out/round$round/result.json'))
print('round $round: first frame', d['first_frame_ms'], 'ms; tap to frame', d['tap_to_frame_ms'], '; missed', d['taps_missed'], '; idle', d['idle']['fps'], 'fps; busy', d['busy']['fps'], 'fps')
"
done | tee "$out/summary.txt"
kill "$companion" "$http"
