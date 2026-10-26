#!/bin/sh
mode=${1:?mode}; seconds=${2:?seconds}
case $mode in
  flat) python3 ~/exp/enc.py --n 2 --seconds "$seconds" --label "B flat out, 2 encoders" ;;
  paced) python3 ~/exp/enc.py --n 4 --seconds "$seconds" --paced --label "B paced, 4 encoders at 60 fps" ;;
esac >> ~/exp/bload.txt 2>/dev/null
