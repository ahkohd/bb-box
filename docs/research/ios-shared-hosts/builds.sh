#!/bin/sh
set -u

tag=${1:?tag}
files=${2:-300}
here=$(cd "$(dirname "$0")" && pwd)
work=${SHARED_WORK:-$HOME/shared}
out=$work/runs/$tag
mkdir -p "$out"
seconds=${SECONDS_EACH:-100}

[ -d "$HOME/load1" ] || "$here/build-load.sh" make "$HOME/load1" "$files"
[ -d "$HOME/load2" ] || cp -R "$HOME/load1" "$HOME/load2"

"$here/devices.sh" down
sleep 5
echo "alone, no devices: $("$here/build-load.sh" build "$HOME/load1" "$HOME/dd1")" | tee -a "$out/summary.txt"
echo "alone again, no devices: $("$here/build-load.sh" build "$HOME/load1" "$HOME/dd1")" | tee -a "$out/summary.txt"
two() {
  "$here/build-load.sh" build "$HOME/load1" "$HOME/dd1" >"$out/two-1.txt" &
  first=$!
  "$here/build-load.sh" build "$HOME/load2" "$HOME/dd2" >"$out/two-2.txt"
  wait "$first"
  echo "two at once, no devices: $(cat "$out/two-1.txt"), $(cat "$out/two-2.txt")"
}
two | tee -a "$out/summary.txt"

"$here/devices.sh" up "${COUNT:-4}" 2>>"$out/up.log"
sleep 20
node "$here/multi.ts" --targets "$work/targets.json" --seconds 30 --sample --label "$tag-streaming-only" --out "$out/streaming.json" --raw "$out/raw-streaming" | tee -a "$out/summary.txt"

node "$here/multi.ts" --targets "$work/targets.json" --seconds "$seconds" --sample --label "$tag-one-build" --out "$out/one.json" --raw "$out/raw-one" >"$out/one.txt" &
runner=$!
sleep 10
echo "one build while devices stream: $("$here/build-load.sh" build "$HOME/load1" "$HOME/dd1")" | tee -a "$out/summary.txt"
wait "$runner"
cat "$out/one.txt" | tee -a "$out/summary.txt"

node "$here/multi.ts" --targets "$work/targets.json" --seconds "$seconds" --sample --label "$tag-two-builds" --out "$out/two.json" --raw "$out/raw-two" >"$out/two.txt" &
runner=$!
sleep 10
"$here/build-load.sh" build "$HOME/load1" "$HOME/dd1" >"$out/two-1.txt" &
first=$!
"$here/build-load.sh" build "$HOME/load2" "$HOME/dd2" >"$out/two-2.txt"
wait "$first"
echo "two builds while devices stream: $(cat "$out/two-1.txt"), $(cat "$out/two-2.txt")" | tee -a "$out/summary.txt"
wait "$runner"
cat "$out/two.txt" | tee -a "$out/summary.txt"

for run in streaming one two; do
  echo "$tag-$run taps:" | tee -a "$out/summary.txt"
  python3 "$here/analyse.py" "$out/raw-$run" | tee -a "$out/summary.txt"
done
