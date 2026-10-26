#!/bin/sh
set -u
step() { echo "$(date +%H:%M:%S) $*"; }
now() { python3 -c 'import time; print(f"{time.time():.3f}")'; }
mkdir -p ~/bb-box ~/exp ~/idb && tar -xzf ~/research.tgz -C ~/bb-box && tar -xzf ~/exp.tgz -C ~/exp
step "system: macOS $(sw_vers -productVersion), $(sysctl -n machdep.cpu.brand_string), $(sysctl -n hw.ncpu) cores, $(( $(sysctl -n hw.memsize) / 1073741824 )) GiB"
xcodebuild -version 2>&1 | head -2 | tr '\n' ' '; echo
xcrun simctl list runtimes 2>&1 | grep -i ios
which ffmpeg node || true
t=$(now); curl -fsSL --retry 3 -o /tmp/idb.tgz https://github.com/facebook/idb/releases/download/v1.7.7/idb-companion.macos-arm64.tar.gz && echo "d0e4e10a7bbd85a6ce67966acb5fca0a87fd14cd026b79f8ec3ee6c338f4a166  /tmp/idb.tgz" | shasum -a 256 -c --quiet - && tar -xzf /tmp/idb.tgz -C ~/idb && step "idb_companion installed in $(python3 -c "print(round($(now)-$t,1))") s: $(~/idb/idb_companion --version 2>&1 | head -1)"
sed -i '' "s#/usr/local/bin/idb_companion#$HOME/idb/idb_companion#" ~/bb-box/docs/research/ios-shared-hosts/devices.sh
RT=$(xcrun simctl list runtimes -j | python3 -c 'import json,sys; r=[x for x in json.load(sys.stdin)["runtimes"] if x["platform"]=="iOS" and x["isAvailable"]]; print(r[-1]["identifier"] if r else "")')
DT=${DT:-com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro}
step "runtime $RT, device type $DT"
[ -n "$RT" ] && [ -n "$DT" ] || { echo "no iOS runtime or iPhone"; exit 1; }
xcrun simctl delete all >/dev/null 2>&1
t=$(now); T=$(xcrun simctl create tmpl "$DT" "$RT"); xcrun simctl boot "$T"; xcrun simctl bootstatus "$T" -b >/dev/null; step "template first boot $(python3 -c "print(round($(now)-$t,1))") s"
for pass in 1 2; do
  while read -r label; do [ -n "$label" ] && xcrun simctl spawn "$T" launchctl disable "system/$label" 2>/dev/null; done < ~/exp/ios-27.0-24A434.txt
  xcrun simctl reboot "$T"; xcrun simctl bootstatus "$T" -b >/dev/null
done
off=$(xcrun simctl spawn "$T" launchctl print-disabled system | python3 -c '
import re, sys
listed = {l.strip() for l in open(sys.argv[1]) if l.strip()}
off = {m.group(1) for m in re.finditer(r"\"([^\"]+)\" => (?:disabled|true)", sys.stdin.read())}
print(len(listed & off))' ~/exp/ios-27.0-24A434.txt)
xcrun simctl shutdown "$T"; step "template slimmed with the iOS 27.0 list: $off of 112 labels off; store $(ls /private/var/tmp/com.apple.CoreSimulator.SimDevice.$T/disabled.plist 2>&1)"
SEED=/private/var/tmp/com.apple.CoreSimulator.SimDevice.$T/disabled.plist
for i in $(seq 1 ${1:-6}); do N=$(xcrun simctl clone "$T" "shared-$i"); mkdir -p /private/var/tmp/com.apple.CoreSimulator.SimDevice.$N && cp "$SEED" /private/var/tmp/com.apple.CoreSimulator.SimDevice.$N/ 2>/dev/null; done
step "clones made"
