#!/bin/sh
# Help choose the cuts: print the times (in seconds) when the recording's
# picture changes, then tile frames at chosen times to look at.
#   sh scripts/demo/find-cuts.sh IN.mov                 print change times
#   sh scripts/demo/find-cuts.sh IN.mov OUT.png T1 T2   tile frames at T1, T2 ...
set -eu
in=$1
if [ $# -eq 1 ]; then
  ffmpeg -v info -i "$in" -vf "fps=10,scale=640:-1,select='gt(scene,0.003)',showinfo" -f null - 2>&1 |
    sed -n 's/.*pts_time:\([0-9.]*\).*/\1/p' | awk '{printf "%.1f ", $1} END {print ""}'
  exit
fi
out=$2; shift 2
dir=$(mktemp -d); i=0
for t in "$@"; do
  ffmpeg -v error -y -ss "$t" -i "$in" -frames:v 1 -vf scale=640:-1 "$dir/$(printf %03d $i).png"
  i=$((i + 1))
done
ffmpeg -v error -y -i "$dir/%03d.png" -vf "tile=3x$(((i + 2) / 3))" "$out"
rm -r "$dir"
