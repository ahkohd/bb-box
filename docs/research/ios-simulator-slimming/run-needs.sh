#!/bin/sh
set -u
udid=$1
label=$2
here=$(cd "$(dirname "$0")" && pwd)
out=${RUNS:-$HOME/slim/runs}/$label/needs
project=${PROJECT:-$HOME/slim/ios-simulator-slimming/probe-app/SlimProbe.xcodeproj}
derived=${DERIVED:-$HOME/slim/dd}
app=$derived/Build/Products/Debug-iphonesimulator/SlimProbe.app
mkdir -p "$out"
now() { python3 -c 'import time; print(f"{time.time():.3f}")'; }
footprint() { python3 "$here/simtree.py" "$udid" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["processes"], d["footprint_mib"], d["cpu_seconds"])'; }

pages=$(mktemp -d)
cp "$here/needs-page.html" "$here/../ios-simulator-boxes/page.html" "$pages/"
(cd "$pages" && exec python3 -m http.server 8765 --bind 127.0.0.1) > "$out/http.log" 2>&1 &
http=$!
idb_companion --udid "$udid" --grpc-port 10882 > "$out/companion.log" 2>&1 &
companion=$!
until nc -z 127.0.0.1 10882 2>/dev/null; do sleep 0.5; done

echo "before: $(footprint)" | tee "$out/footprints.txt"
"$HOME/idbenv/bin/python" "$here/needs.py" --udid "$udid" --app "$app" --out "$out" --http-log "$out/http.log"
echo "after needs: $(footprint)" | tee -a "$out/footprints.txt"

xcrun simctl terminate "$udid" com.apple.mobilesafari 2>/dev/null
xcrun simctl terminate "$udid" com.example.slimprobe 2>/dev/null
sleep 2
"$HOME/idbenv/bin/python" "$here/../ios-simulator-boxes/measure.py" idb --udid "$udid" --out "$out/stream" > "$out/stream.log" 2>&1
python3 -c "
import json; d = json.load(open('$out/stream/result.json'))
print('stream: first frame', d['first_frame_ms'], 'ms; tap to frame', d['tap_to_frame_ms'], '; missed', d['taps_missed'], '; busy', d['busy']['fps'], 'fps')
" | tee "$out/stream-summary.txt"
echo "after stream: $(footprint)" | tee -a "$out/footprints.txt"
kill "$companion" "$http"

start=$(now)
xcodebuild test-without-building -project "$project" -scheme SlimProbe -destination "id=$udid" -derivedDataPath "$derived" > "$out/uitests.log" 2>&1
status=$?
end=$(now)
python3 -c "print('ui tests: exit $status,', round($end - $start, 1), 's')" | tee "$out/uitests-summary.txt"
grep -E "Executed|passed|failed" "$out/uitests.log" | tail -5 | tee -a "$out/uitests-summary.txt"
echo "after ui tests: $(footprint)" | tee -a "$out/footprints.txt"
