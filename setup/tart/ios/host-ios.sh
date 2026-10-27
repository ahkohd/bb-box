#!/bin/sh
set -eu

die() { echo "host-ios: $*" >&2; exit 1; }
[ $# -eq 2 ] || die "usage: host-ios.sh <the folder of host-ios.sh> <the image's user>"
here=$1
owner=$2
step() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*" >&2; }

share=/usr/local/share/bb-box
libexec=/usr/local/libexec/bb-box
helper=$libexec/device-host
[ "$(id -u)" = 0 ] || die "run it as root"
id -u "$owner" >/dev/null 2>&1 || die "there is no user $owner"

template=
for candidate in "$here/../mac-home/.zshenv" "$here/../../ssh-pool/mac-home/.zshenv"; do
  if [ -f "$candidate" ]; then template=$candidate; break; fi
done
[ -n "$template" ] || die "found no mac-home/.zshenv beside $here: give it a whole copy of setup/, as prepare-ios-image.sh does"

step "installing device-host, its held ports' program and the slots' home"
install -d -m 0755 "$libexec" "$share/ios" "$share/slot-home"
install -m 0755 "$here/device-host.sh" "$helper"
install -m 0644 "$here/device-host-ports.pl" "$libexec/device-host-ports"
install -m 0644 "$template" "$share/slot-home/.zshenv"
install -m 0644 "$here/devices.tsv" "$share/ios/devices.tsv"

step "keeping each iOS runtime's disabled.plist from $owner's slim devices"
tab=$(printf '\t')
runtimes=$(mktemp)
trap 'rm -f "$runtimes"' EXIT
(cd / && sudo -n -H -u "$owner" -- xcrun simctl list -j) | python3 -I -c '
import json, sys
listed = json.load(sys.stdin)
ios = [r for r in listed["runtimes"] if r.get("platform") == "iOS" and r.get("isAvailable")]
for runtime in reversed(ios):
    for device in listed["devices"].get(runtime["identifier"], []):
        if device.get("isAvailable"):
            print(runtime["identifier"], runtime["version"], runtime["buildversion"], device["udid"], sep="\t")
' >"$runtimes"
written=
: >"$share/ios/runtimes.tsv.new"
while IFS="$tab" read -r runtime os build udid; do
  list=ios-$os-$build
  case " $written " in *" $list "*) continue ;; esac
  [ -s "$here/slim/$list.txt" ] || continue
  store=/private/var/tmp/com.apple.CoreSimulator.SimDevice.$udid/disabled.plist
  [ -s "$store" ] || continue
  missing=$(plutil -convert xml1 -o - "$store" | python3 -I -c '
import plistlib, sys
disabled = {label for label, off in plistlib.loads(sys.stdin.buffer.read()).items() if off}
listed = [line.strip() for line in open(sys.argv[1]) if line.strip()]
print(sum(1 for label in listed if label not in disabled))
' "$here/slim/$list.txt")
  [ "$missing" = 0 ] || continue
  install -m 0644 "$store" "$share/ios/$list.disabled.plist"
  install -m 0644 "$here/slim/$list.txt" "$share/ios/$list.txt"
  printf '%s\t%s\t%s\t%s\n' "$runtime" "$os" "$build" "$list" >>"$share/ios/runtimes.tsv.new"
  written="$written $list"
  step "kept $list's disabled.plist, from device $udid"
done <"$runtimes"
[ -n "$written" ] || die "none of $owner's devices has a disabled.plist with all of its runtime's slimming list: build and slim the image's devices first"
mv -f "$share/ios/runtimes.tsv.new" "$share/ios/runtimes.tsv"
chmod -R a+rX "$share/ios" "$share/slot-home"

step "writing device-host's daemons, loaded only by init"
"$helper" install </dev/null >&2

step "making the carried slots"
"$helper" carry </dev/null
