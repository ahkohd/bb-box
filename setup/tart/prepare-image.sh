#!/bin/sh
# Builds the Tart image macOS boxes are cloned from. Run on each Mac as the
# user bb-box logs in as (see README.md):
#
#   ./prepare-image.sh --key '<bb-box public key>' [--key <another>]... [--from <image>] [--name <vm>] [--bb-url <url>] [--replace]
#
# It clones the base image to <name>-build, boots it, runs guest/customize.sh,
# guest/xcode.sh and guest/launcher.sh in it as its user, builds bb-box-stream
# from ../ssh-pool/mac-stream.swift there (060), installs Google Chrome with
# ../ssh-pool/mac-chrome.sh, as setup-mac.sh does on a pool Mac, shuts it
# down, grants
# Cua Driver Accessibility and Screen
# Recording on its disk (grant-tcc.sh), boots it again to check the grants,
# shuts it down and renames it to <name>. Boxes cloned from an image it
# replaces keep running. Its record (049) is in the image, in
# /usr/local/share/bb-box/image.json, as macOS keeps /usr/share read-only,
# and beside it, in ~/.bb-box/tart/images/<name>.json, where bb-box's doctor
# reads it.
set -eu

CUA_VERSION=0.30.4
CUA_SHA256=e270ea67388d794505031b0a15d8b58994c67e18e754a43634d7732251f595df
# BlackHole 2ch (#631): a virtual audio device whose output comes back on its
# input, the box's microphone. Existential Audio's signed, notarized package.
BLACKHOLE_VERSION=0.7.1
BLACKHOLE_SHA256=57b540f27a3e29c37e310e01bee0fdfab76733087e47f997ef9dccf851400dcf

# Cirrus Labs' image with Xcode, the iOS Simulator and the Metal toolchain
# (#475). Pinned to its Xcode: a new Xcode is a decision, not a refresh.
from=ghcr.io/cirruslabs/macos-golden-gate-xcode:27
name=bb-box-macos
key=
bb_url=
replace=0
die() { echo "prepare-image: $*" >&2; exit 1; }
while [ $# -gt 0 ]; do
  case $1 in
    --from) from=$2; shift 2 ;;
    --name) name=$2; shift 2 ;;
    --key)
      case $2 in ssh-*) ;; *) die "--key must be an OpenSSH public key" ;; esac
      key="${key:+$key
}$2"
      shift 2 ;;
    --bb-url) bb_url=$2; shift 2 ;;
    --replace) replace=1; shift ;;
    *) die "unknown option $1 (see the top of this script)" ;;
  esac
done
[ -n "$key" ] || die "give bb-box's public key with --key, as bb box doctor shows it"

here=$(cd "$(dirname "$0")" && pwd)
stream_source=$here/../ssh-pool/mac-stream.swift
[ -f "$stream_source" ] || die "found no $stream_source: run this from a whole copy of setup/"
chrome_source=$here/../ssh-pool/mac-chrome.sh
[ -f "$chrome_source" ] || die "found no $chrome_source: run this from a whole copy of setup/"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nix-profile/bin:/run/current-system/sw/bin:$PATH" TART_NO_AUTO_PRUNE=1
command -v tart >/dev/null || die "install Tart first: brew install openai/tools/tart"
[ "$(uname -m)" = arm64 ] || die "Tart runs macOS VMs on Apple silicon only"
exists() { tart list --source local --quiet | grep -qxF "$1"; }
if exists "$name" && [ "$replace" = 0 ]; then die "$name exists; give --replace to build it again"; fi

build="$name-build"
build_id=build.$(date -u +%Y%m%d-%H%M%S)-$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')
built=$(date -u +%Y-%m-%dT%H:%M:%SZ)
work=$(mktemp -d)
pid=
cleanup() {
  [ -n "$pid" ] && kill "$pid" 2>/dev/null
  rm -rf "$work"
}
trap cleanup EXIT
step() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*"; }

# macOS runs two macOS VMs at most. While others, such as threads' boxes, take
# both, a boot waits for one to go, saying so every 5 minutes, up to
# SLOT_WAIT_MINUTES, rather than failing (#650).
SLOT_WAIT_MINUTES=60
SLOT_POLL_SECONDS=30
boot() {
  waited=0
  while :; do
    tart run --no-graphics "$build" >"$work/run.log" 2>&1 &
    pid=$!
    i=0
    until tart exec "$build" true >/dev/null 2>&1; do
      if ! kill -0 "$pid" 2>/dev/null; then
        full=$(grep -m 1 'exceeds the system limit' "$work/run.log" || :)
        [ -n "$full" ] || { cat "$work/run.log" >&2; die "$build stopped while booting"; }
        [ "$waited" -lt $((SLOT_WAIT_MINUTES * 60)) ] || die "no macOS VM slot was free for $build within $SLOT_WAIT_MINUTES minutes: $full"
        [ $((waited % 300)) -ge "$SLOT_POLL_SECONDS" ] ||
          step "no macOS VM slot is free for $build ($full): waiting for one, up to $((SLOT_WAIT_MINUTES - waited / 60)) more minutes"
        sleep "$SLOT_POLL_SECONDS"
        waited=$((waited + SLOT_POLL_SECONDS))
        continue 2
      fi
      i=$((i + 1))
      [ "$i" -lt 300 ] || die "$build's guest agent did not answer within 5 minutes"
      sleep 1
    done
    return 0
  done
}
# Writes the guest's file systems out, then stops the VM and waits for Tart
# to exit. A shutdown from inside the guest did not end the VM in testing.
shutdown() {
  tart exec "$build" sync >/dev/null 2>&1 || :
  tart stop "$build" --timeout 30 >/dev/null 2>&1 || :
  wait "$pid" 2>/dev/null || :
  pid=
}

if exists "$build"; then tart delete "$build"; fi
step "cloning $from to $build"
tart clone "$from" "$build"
step "booting $build"
boot
step "customising $build"
tart exec -i "$build" env BBBOX_SSH_PUBLIC_KEY="$key" CUA_VERSION="$CUA_VERSION" CUA_SHA256="$CUA_SHA256" \
  BLACKHOLE_VERSION="$BLACKHOLE_VERSION" BLACKHOLE_SHA256="$BLACKHOLE_SHA256" BB_URL="$bb_url" /bin/sh -s \
  <"$here/guest/customize.sh"
step "setting Xcode up in $build"
tart exec -i "$build" /bin/sh -s <"$here/guest/xcode.sh" >"$work/xcode.txt" || { cat "$work/xcode.txt"; die "setting Xcode up failed"; }
grep -v '^[a-z-]*=' "$work/xcode.txt" || :
step "building bb-box's launcher for desktop commands in $build"
tart exec -i "$build" /bin/sh -s <"$here/guest/launcher.sh" || die "building bb-box's launcher failed"
# 060: bb-box-stream, each box's desktop as H.264 video for the panel, from
# VideoToolbox's hardware encoder, which the VM passes to the Mac's. It runs
# over SSH in the desktop session, with the grants SSH has there. Built with
# the image's Xcode, as setup-mac.sh builds it on a pool Mac.
step "building bb-box-stream in $build"
tart exec -i "$build" /bin/sh -c 'set -e; d=$(mktemp -d); cat >"$d/mac-stream.swift"; swiftc -O -swift-version 5 -o "$d/bb-box-stream" "$d/mac-stream.swift" 2>"$d/log" || { cat "$d/log" >&2; exit 1; }; sudo -n install -d -m 0755 /usr/local/bin; sudo -n install -m 0755 -o root -g wheel "$d/bb-box-stream" /usr/local/bin/bb-box-stream; rm -rf "$d"' \
  <"$stream_source" || die "building bb-box-stream failed"
stream=$(shasum -a 256 "$stream_source" | cut -c1-12)
# Google Chrome, which agents mostly use: from Google's stable download, its
# signature checked, with the Linux images' policies against its prompts, and
# admin's profile past its first run and What's New.
step "installing Google Chrome in $build"
tart exec -i "$build" sudo -n /bin/sh -s /Users/admin <"$chrome_source" >"$work/chrome.txt" || { cat "$work/chrome.txt"; die "installing Chrome failed"; }
chrome=$(sed -n 's/^chrome=//p' "$work/chrome.txt")
[ -n "$chrome" ] || die "Chrome's install gave no version"
# The pins' SHA-256 is of this script's pin lines, as bb-box hashes them.
step "recording $build_id in $build"
os=$(tart exec "$build" sw_vers -productVersion)
node=$(tart exec "$build" /bin/zsh -c 'node --version' 2>/dev/null | tr -d 'v\r') || node=
app=$(tart exec "$build" /bin/sh -c 'cat "$HOME"/.bb-machines/*/host-artifact.sha256 2>/dev/null | head -n 1') || app=
pins=$(grep -E '^[A-Z0-9_]+_(VERSION|SHA256|URL)=' "$here/prepare-image.sh" | shasum -a 256 | cut -d' ' -f1)
quoted() { if [ -n "$1" ]; then printf '"%s"' "$1"; else printf null; fi; }
# Xcode's, the iOS Simulator's and Metal's versions, where the base has Xcode.
xcode_tools=$(for tool in xcode ios-simulator metal; do v=$(sed -n "s/^$tool=//p" "$work/xcode.txt"); [ -z "$v" ] || printf ',"%s":"%s"' "$tool" "$v"; done)
record=$(printf '{"contract":1,"image":"standard","kind":"macos","arch":"arm64","build":"%s","built":"%s","base":null,"os":"macOS %s","aptSnapshot":null,"pins":"%s","bbApp":%s,"tools":{"cua-driver":"%s","blackhole":"%s","bb-box-stream":"%s","chrome":"%s"%s},"nvidia":null,"layer":null,"sizeGiB":null}' \
  "$build_id" "$built" "$os" "$pins" "$(quoted "$app")" "$CUA_VERSION" "$BLACKHOLE_VERSION" "$stream" "$chrome" "${node:+,\"node\":\"$node\"}$xcode_tools")
printf '%s\n' "$record" | tart exec -i "$build" sudo -n sh -c 'mkdir -p /usr/local/share/bb-box && cat >/usr/local/share/bb-box/image.json && chmod 0644 /usr/local/share/bb-box/image.json'
step "shutting $build down"
shutdown

step "granting Cua Driver its permissions on $build's disk"
archive="cua-driver-rs-$CUA_VERSION-darwin-arm64"
curl -fsSL --retry 3 -o "$work/cua.tgz" "https://github.com/trycua/cua/releases/download/cua-driver-rs-v$CUA_VERSION/$archive.tar.gz"
echo "$CUA_SHA256  $work/cua.tgz" | shasum -a 256 -c --quiet - || die "Cua Driver's archive does not match its pin"
tar -xzf "$work/cua.tgz" -C "$work"
"$here/grant-tcc.sh" "$build" "$work/$archive/CuaDriver.app"

step "checking the grants in $build"
boot
i=0
until tart exec "$build" /usr/local/bin/cua-driver permissions status --json >"$work/permissions.json" 2>"$work/permissions.err"; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || { cat "$work/permissions.err" >&2; die "Cua Driver did not answer in $build"; }
  sleep 1
done
cat "$work/permissions.json"
grep -q '"accessibility": *true' "$work/permissions.json" || die "Cua Driver has no Accessibility in $build"
grep -q '"screen_recording": *true' "$work/permissions.json" || die "Cua Driver has no Screen Recording in $build"
tart exec "$build" test -x /usr/local/bin/bb-box-stream || die "$build has no bb-box-stream"
tart exec "$build" system_profiler SPAudioDataType | grep -A 8 'BlackHole 2ch:' | grep -q 'Input Channels: 2' ||
  die "BlackHole gives $build no input device"
shutdown

if exists "$name"; then tart delete "$name"; fi
tart rename "$build" "$name"
mkdir -p "$HOME/.bb-box/tart/images"
printf 'from=%s\ncua=%s\nbuilt=%s\n%s\n' "$from" "$CUA_VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(printf '%s\n' "$key" | awk '{print "key=" $2}')" \
  >"$HOME/.bb-box/tart/images/$name"
printf '%s\n' "$record" >"$HOME/.bb-box/tart/images/$name.json"
step "done: $name is ready to clone ($(du -sh "${TART_HOME:-$HOME/.tart}/vms/$name" | cut -f1) on disk)"
