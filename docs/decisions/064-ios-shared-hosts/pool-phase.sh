#!/bin/sh
set -u
tag=${1:?tag}
here=$HOME/bb-box/docs/research/ios-shared-hosts
out=$HOME/exp/runs/$tag
mkdir -p "$out"
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$out/summary.txt"; }
export SLIM_LIST=$HOME/exp/ios-27.0-24A434.txt
log "phase $tag start"
for s in 1206x2622 604x1312; do python3 $HOME/exp/enc.py --n 4 --seconds 15 --size $s --label "$tag-enc4-$s" 2>/dev/null | tee -a "$out/summary.txt"; done
python3 $HOME/exp/enc.py --n 2 --seconds 15 --label "$tag-enc2" 2>/dev/null | tee -a "$out/summary.txt"
"$here/devices.sh" up 12 2>>"$out/up.log"
sleep 20
for spec in ${RUNS:-4:1 8:1 12:1 8:0.5 12:0.5}; do
  count=${spec%%:*}; scale=${spec##*:}
  "$here/devices.sh" up "$count" 2>>"$out/up.log"
  node "$here/multi.ts" --targets "$HOME/shared/targets.json" --seconds 30 --scale "$scale" --sample --label "$tag-n$count-s$scale" --out "$out/n$count-s$scale.json" --raw "$out/raw-n$count-s$scale" | tee -a "$out/summary.txt"
  python3 "$here/analyse.py" "$out/raw-n$count-s$scale" | tail -1 | tee -a "$out/summary.txt"
done
log "phase $tag end"
