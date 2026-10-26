#!/bin/sh
set -u
step() { echo "$(date +%H:%M:%S) $*"; }
mkdir -p ~/bb-box ~/exp ~/idb && tar -xzf ~/research.tgz -C ~/bb-box && tar -xzf ~/exp.tgz -C ~/exp
if [ ! -x ~/idb/idb_companion ]; then
  curl -fsSL --retry 3 -o /tmp/idb.tgz https://github.com/facebook/idb/releases/download/v1.7.7/idb-companion.macos-arm64.tar.gz
  echo "d0e4e10a7bbd85a6ce67966acb5fca0a87fd14cd026b79f8ec3ee6c338f4a166  /tmp/idb.tgz" | shasum -a 256 -c --quiet - || { echo "idb archive mismatch"; exit 1; }
  tar -xzf /tmp/idb.tgz -C ~/idb
fi
~/idb/idb_companion --version 2>&1 | head -2
sed -i '' "s#/usr/local/bin/idb_companion#$HOME/idb/idb_companion#" ~/bb-box/docs/research/ios-shared-hosts/devices.sh
for s in 1206x2622 604x1312; do ffmpeg -hide_banner -loglevel error -f lavfi -i "testsrc2=size=${s}:rate=60" -frames:v 60 -pix_fmt nv12 -f rawvideo -y "/tmp/clip-${s}.yuv"; done
step "template"
T=$(xcrun simctl create tmpl com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro com.apple.CoreSimulator.SimRuntime.iOS-27-0)
xcrun simctl boot "$T"; xcrun simctl bootstatus "$T" -b >/dev/null
for pass in 1 2; do
  while read -r label; do [ -n "$label" ] && xcrun simctl spawn "$T" launchctl disable "system/$label" 2>/dev/null; done < ~/exp/ios-27.0-24A434.txt
  xcrun simctl reboot "$T"; xcrun simctl bootstatus "$T" -b >/dev/null
done
xcrun simctl shutdown "$T"
ls -la /private/var/tmp/com.apple.CoreSimulator.SimDevice.$T/
step "template slim; clones"
SEED=/private/var/tmp/com.apple.CoreSimulator.SimDevice.$T/disabled.plist
for i in $(seq 1 12); do
  N=$(xcrun simctl clone "$T" "shared-$i")
  mkdir -p "/private/var/tmp/com.apple.CoreSimulator.SimDevice.$N" && cp "$SEED" "/private/var/tmp/com.apple.CoreSimulator.SimDevice.$N/"
done
step "clones made"
