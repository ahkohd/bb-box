#!/bin/sh
set -e
take="${1:-take}"
out="${2:-$take/out}"
mkdir -p "$out"
python3 "$(dirname "$0")/encode.py" "$take"
cd "$take"
ffmpeg -y -loglevel error -f concat -safe 0 -i list.txt -vf "fps=30,scale=1920:1200:flags=lanczos,format=yuv420p" -c:v libx264 -crf 12 -preset slow -tune animation -movflags +faststart -an "$out/demo.mp4"
ffmpeg -y -loglevel error -f concat -safe 0 -i list.txt -vf "fps=10,scale=960:600:flags=lanczos" -c:v libwebp -lossless 0 -q:v 55 -compression_level 6 -loop 0 -an "$out/demo.webp"
ls -l "$out"
