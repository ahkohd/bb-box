#!/bin/sh
set -u
mkdir -p ~/bb-box ~/exp && tar -xzf ~/research.tgz -C ~/bb-box && tar -xzf ~/exp.tgz -C ~/exp
launchctl disable gui/$(id -u)/app.bb-box.device
launchctl bootout gui/$(id -u)/app.bb-box.device 2>/dev/null
mv ~/Library/LaunchAgents/app.bb-box.device.plist ~/app.bb-box.device.plist.off 2>/dev/null
pkill -u "$(id -u)" idb_companion
for s in 1206x2622 604x1312; do ffmpeg -hide_banner -loglevel error -f lavfi -i "testsrc2=size=${s}:rate=60" -frames:v 60 -pix_fmt nv12 -f rawvideo -y "/tmp/clip-${s}.yuv"; done
[ "${1:-}" = devices ] || exit 0
~/exp/make-seeded.sh 8
cd ~/bb-box/docs/research/ios-shared-hosts
nohup python3 -m http.server 8765 --bind 127.0.0.1 >/tmp/http.log 2>&1 &
./devices.sh up 8 2>&1 | tail -8
