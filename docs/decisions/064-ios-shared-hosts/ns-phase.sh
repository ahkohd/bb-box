#!/bin/sh
set -u
tag=${1:?tag}; here=$HOME/bb-box/docs/research/ios-shared-hosts; out=$HOME/exp/runs/$tag; mkdir -p "$out"
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$out/summary.txt"; }
log "phase $tag start"
if command -v ffmpeg >/dev/null; then
  for s in 1206x2622 604x1312; do [ -f /tmp/clip-$s.yuv ] || ffmpeg -hide_banner -loglevel error -f lavfi -i "testsrc2=size=${s}:rate=60" -frames:v 60 -pix_fmt nv12 -f rawvideo -y /tmp/clip-$s.yuv; done
  python3 $HOME/exp/enc.py --n 2 --seconds 15 --label "$tag-enc2" 2>/dev/null | tee -a "$out/summary.txt"
  python3 $HOME/exp/enc.py --n 4 --seconds 15 --label "$tag-enc4" 2>/dev/null | tee -a "$out/summary.txt"
  python3 $HOME/exp/enc.py --n 4 --seconds 15 --size 604x1312 --label "$tag-enc4-half" 2>/dev/null | tee -a "$out/summary.txt"
fi
"$here/devices.sh" up ${MOST:-6} 2>>"$out/up.log"; tail -${MOST:-6} "$out/up.log" | tee -a "$out/summary.txt"
sleep 15
for spec in ${RUNS:-4:1 6:1 6:0.5}; do
  count=${spec%%:*}; scale=${spec##*:}
  "$here/devices.sh" up "$count" 2>>"$out/up.log"
  node "$here/multi.ts" --targets "$HOME/shared/targets.json" --seconds 30 --scale "$scale" --sample --label "$tag-n$count-s$scale" --out "$out/n$count-s$scale.json" --raw "$out/raw-n$count-s$scale" | tee -a "$out/summary.txt"
  command -v ffmpeg >/dev/null && python3 "$here/analyse.py" "$out/raw-n$count-s$scale" | tail -1 | tee -a "$out/summary.txt"
done
log "phase $tag end"
