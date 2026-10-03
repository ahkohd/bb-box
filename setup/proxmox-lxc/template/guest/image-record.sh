#!/bin/bash
# Writes the image's record (049), <out-dir>/image.json, from the build
# directory and the template-release finalize.sh wrote there. finalize.sh runs
# it before it removes the build directory, then adds the image's size
# (sizeGiB, null until then) once it is clean.
#
# The contract is what bb-box needs of an image. The pins' SHA-256 is of
# pins.json, apt-snapshot and, for a desktop, desktop-pins.tsv, in that order,
# as bb-box computes it from its own copy. build.env, or the environment,
# may give BUILD_ID, DESKTOP_GPU and DESKTOP_SESSION.
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
tools=$(jq -c --arg arch "$arch" '[.tools[] | select(.arch == $arch) | {(.name): .version}] | add // {}' "$build/pins.json")
if [ "$kind" != linux ]; then
  pin_files+=("$build/desktop-pins.tsv")
  if [ "$(settings DESKTOP_SESSION)" = wayland ]; then image_kind=linux-desktop-wayland-cpu
  elif [ "$(settings DESKTOP_GPU)" = none ]; then image_kind=$image_kind-desktop-cpu
  else image_kind=linux-desktop; fi
  version_of() { awk -F'\t' -v n="$1" -v a="$arch" '$1 == n && $5 == a { print $2 }' "$build/desktop-pins.tsv" | sed -n "$2"; }
  tools=$(jq -c --arg chrome "$(version_of chrome 's/^google-chrome-stable_\([0-9.]*\)-.*/\1/p')" \
    --arg cua "$(version_of cua-driver 's/^cua-driver-rs-\([0-9.]*\)-.*/\1/p')" \
    '. + ({"chrome": $chrome, "cua-driver": $cua} | with_entries(select(.value != "")))' <<<"$tools")
fi
nvidia=$(sed -n 's/^nvidia=//p' "$out/template-release" | head -1)
case $nvidia in "" | none) nvidia= ;; esac
build_id=$(settings BUILD_ID)
[ -n "$build_id" ] || build_id=build.$(date -u +%Y%m%d-%H%M%S)-$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')

jq -n --arg kind "$image_kind" --arg arch "$arch" --arg build "$build_id" --arg built "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg os "$(. /etc/os-release && echo "$PRETTY_NAME")" \
  --arg snapshot "$(sed -n 's/^apt_snapshot=//p' "$out/template-release" | grep -v '^none$' || true)" \
  --arg pins "$(cat "${pin_files[@]}" | sha256sum | cut -d' ' -f1)" \
  --arg app "$(cat /home/*/.bb-machines/*/host-artifact.sha256 2>/dev/null | head -1 || true)" \
  --arg nvidia "$nvidia" --argjson tools "$tools" \
  '{contract: 1, image: "standard", kind: $kind, arch: $arch, build: $build, built: $built, base: null, os: $os,
    aptSnapshot: ($snapshot | select(. != "") // null), pins: $pins, bbApp: ($app | select(. != "") // null),
    tools: $tools, nvidia: ($nvidia | select(. != "") // null), layer: null, sizeGiB: null}' \
  >"$out/image.json"
chmod 0644 "$out/image.json"
echo "image-record: $image_kind $build_id"
