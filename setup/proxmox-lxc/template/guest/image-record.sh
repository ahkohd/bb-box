#!/bin/bash
# Writes the image's record (049), <out-dir>/image.json, from the build
# directory and the template-release finalize.sh wrote there, on one line.
# finalize.sh runs it before it removes the build directory, then adds the
# image's size (sizeGiB, null until then) once it is clean.
#
# The contract is what bb-box needs of an image. The pins' SHA-256 is of
# pins.json, apt-snapshot and, for a desktop, desktop-pins.tsv, in that order,
# as bb-box computes it from its own copy. Pins bb-box resolved to newer
# versions (049) give the repository's in pins.json's `pinned`. build.env,
# or the environment, may give BUILD_ID, DESKTOP_GPU and DESKTOP_SESSION.
#
# usage: image-record.sh <build-dir> <kind> [<out-dir>]
set -euo pipefail

build=$1
kind=$2
out=${3:-/usr/share/bb-box}
arch=x86_64
[ "$(uname -m)" = x86_64 ] || arch=arm64

# shellcheck disable=SC1091
settings() { (. "$build/build.env" 2>/dev/null || true; eval "echo \"\${$1:-}\""); }
image_kind=linux
[ "$arch" = x86_64 ] || image_kind=linux-arm64
pin_files=("$build/pins.json" "$build/apt-snapshot")
pin_set=linux
tools=$(jq -c --arg arch "$arch" '[.tools[] | select(.arch == $arch) | {(.name): .version}] | add // {}' "$build/pins.json")
devices=null
if [ "$kind" = android ]; then
  image_kind=android
  pin_files+=("$build/android-pins.json")
  pin_set=android
  encoder=$(/usr/local/bin/bb-box-h264 --version 2>/dev/null || true)
  x264=
  case $encoder in x264*) x264=$(jq -r '.encoder[] | select(.name == "x264") | .version' "$build/android-pins.json") ;; esac
  tools=$(jq -c --slurpfile android "$build/android-pins.json" --arg x264 "$x264" \
    '. + ([$android[0].sdk[] | {("android-\(.name)"): .version}] | add)
       + {openh264: ($android[0].encoder[] | select(.name == "openh264") | .version)}
       + (if $x264 == "" then {} else {x264: $x264} end)' <<<"$tools")
  devices=$(jq -c . "$build/android-devices.json")
elif [ "$kind" != linux ]; then
  pin_files+=("$build/desktop-pins.tsv")
  pin_set=linux-desktop
  if [ "$(settings DESKTOP_SESSION)" = wayland ]; then image_kind=linux-desktop-wayland-cpu
  # Docker's X desktop image serves GPU desktops too, with the host's NVIDIA
  # userspace, on x86_64; on arm64 every desktop is on the CPU.
  elif [ "$arch" != x86_64 ] || { [ "$(settings DESKTOP_GPU)" = none ] && [ "$(settings BOX_RUNTIME)" != docker ]; }; then image_kind=$image_kind-desktop-cpu
  else image_kind=linux-desktop; fi
  version_of() { awk -F'\t' -v n="$1" -v a="$arch" '$1 == n && $5 == a { print $2 }' "$build/desktop-pins.tsv" | sed -n "$2"; }
  # Chrome as installed: a refresh keeps one newer than the pin.
  chrome=$(dpkg-query -W -f='${Status} ${Version}' google-chrome-stable 2>/dev/null | sed -n 's/^install ok installed \([0-9.]*\)-.*/\1/p' || true)
  [ -n "$chrome" ] || chrome=$(version_of chrome 's/^google-chrome-stable_\([0-9.]*\)-.*/\1/p')
  tools=$(jq -c --arg chrome "$chrome" \
    --arg cua "$(version_of cua-driver 's/^cua-driver-rs-\([0-9.]*\)-.*/\1/p')" \
    '. + ({"chrome": $chrome, "cua-driver": $cua} | with_entries(select(.value != "")))' <<<"$tools")
fi
nvidia=$(sed -n 's/^nvidia=//p' "$out/template-release" | head -1)
case $nvidia in "" | none) nvidia= ;; esac
pins=$(jq -r --arg set "$pin_set" '.pinned[$set] // empty' "$build/pins.json")
[ -n "$pins" ] || pins=$(cat "${pin_files[@]}" | sha256sum | cut -d' ' -f1)
build_id=$(settings BUILD_ID)
[ -n "$build_id" ] || build_id=build.$(date -u +%Y%m%d-%H%M%S)-$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')
program=$(
  {
    printf 'BOX_IDENTITY_RESET=%s\n' "$(settings BOX_IDENTITY_RESET)"
    if [ -d "$build/guest" ]; then
      for f in $(cd "$build/guest" && LC_ALL=C ls -1 *.sh 2>/dev/null | LC_ALL=C sort); do
        [ -f "$build/guest/$f" ] || continue
        printf 'file %s\n' "$f"
        cat "$build/guest/$f"
      done
    fi
    printf 'PREPARE=%s\n' "$(settings PREPARE)"
  } | sha256sum | cut -d' ' -f1
)

jq -cn --arg kind "$image_kind" --arg arch "$arch" --arg build "$build_id" --arg built "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg os "$(. /etc/os-release && echo "$PRETTY_NAME")" \
  --arg snapshot "$(sed -n 's/^apt_snapshot=//p' "$out/template-release" | grep -v '^none$' || true)" \
  --arg pins "$pins" \
  --arg app "$(cat /home/*/.bb-machines/*/host-artifact.sha256 2>/dev/null | head -1 || true)" \
  --arg nvidia "$nvidia" --arg program "$program" --argjson tools "$tools" --argjson devices "$devices" \
  '{contract: 1, image: "standard", kind: $kind, arch: $arch, build: $build, built: $built, base: null, os: $os,
    aptSnapshot: ($snapshot | select(. != "") // null), pins: $pins, bbApp: ($app | select(. != "") // null),
    tools: $tools, nvidia: ($nvidia | select(. != "") // null), layer: null, sizeGiB: null,
    program: ($program | select(. != "") // null)}
   + (if $devices == null then {} else {devices: $devices} end)' \
  >"$out/image.json"
chmod 0644 "$out/image.json"
echo "image-record: $image_kind $build_id"
