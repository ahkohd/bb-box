#!/bin/sh
set -e
video="${1:?usage: sheet.sh <video> <out.jpg> [count] [columns] [tile width]}"
out="${2:?usage: sheet.sh <video> <out.jpg> [count] [columns] [tile width]}"
count="${3:-12}"
columns="${4:-4}"
tile_width="${5:-640}"
length=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$video")
rows=$(( (count + columns - 1) / columns ))
rate=$(python3 -c "print($count / $length)")
ffmpeg -nostdin -y -loglevel error -i "$video" -vf "fps=$rate,scale=$tile_width:-2:flags=lanczos,drawtext=text='%{pts\:hms}':x=8:y=8:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6,tile=${columns}x${rows}:padding=4:margin=4" -frames:v 1 -q:v 3 "$out"
echo "$out: $count frames of $video, $length s"
