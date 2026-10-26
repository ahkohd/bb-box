#!/bin/sh
set -u
tag=${1:?tag}
here=$HOME/bb-box/docs/research/ios-shared-hosts
out=$HOME/exp/runs/$tag
mkdir -p "$out"
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$out/summary.txt"; }
log "phase $tag start"
for i in 1 2; do python3 $HOME/exp/enc.py --n 2 --seconds 20 --label "$tag-enc2-$i" 2>/dev/null | tee -a "$out/summary.txt"; done
for spec in ${RUNS:-4:1 8:0.5}; do
  count=${spec%%:*}; scale=${spec##*:}
  "$here/devices.sh" up "$count" 2>>"$out/up.log"
  node "$here/multi.ts" --targets "$HOME/shared/targets.json" --seconds 30 --scale "$scale" --label "$tag-n$count-s$scale" --out "$out/n$count-s$scale.json" --raw "$out/raw-n$count-s$scale" | grep -v ' vm:' | tee -a "$out/summary.txt"
  python3 "$here/analyse.py" "$out/raw-n$count-s$scale" | tee -a "$out/summary.txt"
done
python3 $HOME/exp/enc.py --n 2 --seconds 20 --label "$tag-enc2-3" 2>/dev/null | tee -a "$out/summary.txt"
log "phase $tag end"
