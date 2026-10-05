#!/bin/sh
# Xcode in a macOS image (#475), run in the build VM as its user, after
# customize.sh. A base with Xcode, as macos-golden-gate-xcode is, has its
# licence accepted and its first launch run, the Metal toolchain where it is
# missing, and an iPhone Simulator booted once, so that a box's first boot of
# one does not spend minutes on its caches. A base with only the Command Line
# Tools is left as it is. It prints the versions for the image's record last,
# as xcode=, ios-simulator= and metal= lines.
set -eu

die() { echo "xcode: $*" >&2; exit 1; }
dev=$(xcode-select -p 2>/dev/null || true)
case $dev in
  */Xcode*.app/Contents/Developer) ;;
  *) echo "xcode: this base has no Xcode (${dev:-nothing selected}), so the image has the Command Line Tools alone"; exit 0 ;;
esac

sudo -n xcodebuild -license accept
sudo -n xcodebuild -runFirstLaunch
xcodebuild -checkFirstLaunchStatus || die "Xcode's first launch did not finish"
if ! xcrun -f metal >/dev/null 2>&1; then
  echo "xcode: downloading the Metal toolchain"
  xcodebuild -downloadComponent MetalToolchain
fi
xcrun -f metal >/dev/null || die "Xcode has no Metal compiler"

# The newest iOS runtime and iPhone, booted once and removed.
runtime=$(xcrun simctl list runtimes | awk '/^iOS / && !/unavailable/ { id = $NF } END { print id }')
[ -n "$runtime" ] || die "Xcode has no iOS Simulator runtime"
device=$(xcrun simctl list devicetypes | sed -n 's/^\(iPhone [^(]*\) (\(.*\))$/\2/p' | tail -n 1)
[ -n "$device" ] || die "Xcode has no iPhone Simulator device type"
started=$(date +%s)
udid=$(xcrun simctl create bb-box-warm-up "$device" "$runtime")
xcrun simctl boot "$udid"
xcrun simctl bootstatus "$udid" -b >/dev/null
xcrun simctl shutdown "$udid"
xcrun simctl delete "$udid"
echo "xcode: booted a Simulator of $device on $runtime once, in $(( $(date +%s) - started )) s"

echo "xcode=$(xcodebuild -version | sed -n 's/^Xcode //p' | head -n 1)"
echo "ios-simulator=$(xcrun simctl list runtimes | awk -v id="$runtime" '$NF == id { print $2 }')"
echo "metal=$(xcrun metal --version 2>&1 | sed -n 's/.*metalfe-\([0-9.]*\).*/\1/p; s/.*version \([0-9.]*\).*/\1/p' | head -n 1)"
