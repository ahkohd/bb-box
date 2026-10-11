#!/bin/sh
# Cut the recording and encode the README's demo.
#   sh scripts/demo/encode.sh IN.mov CUTS.txt OUTDIR
# CUTS.txt has one "start,end" pair of seconds in IN.mov per line; lines
# starting with # are comments. The kept parts are joined in order.
# Writes OUTDIR/demo.mp4 (H.264, CRF 12) and OUTDIR/demo.webp (lossless,
# 20 fps), both 1280x800, from a lossless master so no artifacts carry over.
set -eu
in=$1 cuts=$2 out=$3
sel=$(grep -v '^#' "$cuts" | grep , | sed 's/^/between(t,/; s/$/)/' | paste -sd+ -)
mkdir -p "$out"
master=$(mktemp -d)/master.mkv
ffmpeg -v error -y -i "$in" \
  -vf "fps=30,select='$sel',setpts=N/30/TB,scale=1280:800:flags=lanczos,format=rgb24" \
  -an -c:v ffv1 "$master"
ffmpeg -v error -y -i "$master" -vf format=yuv420p \
  -c:v libx264 -preset veryslow -crf 12 -tune animation -movflags +faststart "$out/demo.mp4"
ffmpeg -v error -y -i "$master" -vf fps=20 \
  -c:v libwebp_anim -lossless 1 -compression_level 6 -loop 0 "$out/demo.webp"
rm -r "$(dirname "$master")"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$out/demo.mp4" | awk '{printf "duration %.1f s\n", $1}'
ls -l "$out/demo.mp4" "$out/demo.webp" | awk '{printf "%s %.2f MB\n", $NF, $5 / 1048576}'
