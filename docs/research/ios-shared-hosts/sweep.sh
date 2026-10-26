#!/bin/sh
set -u

tag=${1:?tag}
shift
here=$(cd "$(dirname "$0")" && pwd)
work=${SHARED_WORK:-$HOME/shared}
out=$work/runs/$tag
mkdir -p "$out"
for count in "$@"; do
  "$here/devices.sh" up "$count" 2>>"$out/up.log"
  sleep "${SETTLE:-20}"
  node "$here/multi.ts" --targets "$work/targets.json" --seconds "${SECONDS_EACH:-30}" --sample --label "$tag-n$count" --out "$out/n$count.json" --raw "$out/raw-n$count" | tee -a "$out/summary.txt"
  python3 -c '
import json, sys
for t in json.load(open(sys.argv[1])):
    print(t["udid"])' "$work/targets.json" | while read -r udid; do
    python3 "$here/../ios-simulator-slimming/simtree.py" "$udid" 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sys.argv[1], d["processes"], d["footprint_mib"])' "$udid"
  done >"$out/footprint-n$count.txt"
  echo "$tag-n$count footprint summed $(awk '{s+=$3} END {print s}' "$out/footprint-n$count.txt") MiB over $(wc -l <"$out/footprint-n$count.txt" | tr -d ' ') devices" | tee -a "$out/summary.txt"
done
for count in "$@"; do
  echo "$tag-n$count taps:" | tee -a "$out/summary.txt"
  python3 "$here/analyse.py" "$out/raw-n$count" | tee -a "$out/summary.txt"
done
