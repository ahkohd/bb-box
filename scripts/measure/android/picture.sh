#!/bin/bash
set -euo pipefail

usage() {
  echo "usage: picture.sh <recording> <label> [cores]" >&2
  echo "Replays a recording of raw frames through each encoder at its pace, then compares" >&2
  echo "the decoded video with the frames, as SSIM and PSNR, one JSON line per encoder." >&2
  exit 2
}

[ $# -ge 2 ] || usage
recording=$1
label=$2
cores=${3:-8}
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

read -r size fps < <(python3 -I - "$recording" "$work/frames.rgb" <<'EOF'
import struct, sys
source, target = sys.argv[1], sys.argv[2]
with open(source, "rb") as frames, open(target, "wb") as raw:
    size = None
    stamps = []
    while True:
        head = frames.read(17)
        if len(head) < 17:
            break
        stamps.append(struct.unpack("<d", head[0:8])[0])
        width, height = struct.unpack("<II", head[9:17])
        size = size or (width, height)
        raw.write(frames.read(width * height * 3))
rate = round((len(stamps) - 1) * 1000 / (stamps[-1] - stamps[0]))
print(f"{size[0]}x{size[1]} {rate}")
EOF
)

for encoder in x264 openh264; do
  replay=$(taskset -c 0-$((cores - 1)) node "$here/bench.ts" replay --file "$recording" --encoder "$encoder" --fps "$fps" --out "$work/$encoder.h264" --label "$label")
  scores=$(ffmpeg -hide_banner -nostats -i "$work/$encoder.h264" -f rawvideo -pix_fmt rgb24 -s "$size" -i "$work/frames.rgb" \
    -lavfi "[0:v]setpts=N/(25*TB),format=yuv420p,split[a][c];[1:v]setpts=N/(25*TB),format=yuv420p,split[b][d];[a][b]ssim;[c][d]psnr" -f null - 2>&1 |
    sed -n 's/.*SSIM.* All:\([0-9.]*\).*/ssim=\1/p; s/.*PSNR.* average:\([0-9.inf]*\).*/psnr=\1/p' | tr '\n' ' ')
  ssim=$(echo "$scores" | sed -n 's/.*ssim=\([0-9.]*\).*/\1/p')
  psnr=$(echo "$scores" | sed -n 's/.*psnr=\([0-9.inf]*\).*/\1/p')
  echo "$replay" | jq -c --argjson recordedFps "$fps" --arg ssim "$ssim" --arg psnr "$psnr" '. + {recordedFps: $recordedFps, ssim: ($ssim|tonumber), psnr: ($psnr|tonumber)}'
done
