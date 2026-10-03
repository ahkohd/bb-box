#!/bin/sh
# Builds the Tart image macOS boxes are cloned from. Run on each Mac as the
# user bb-box logs in as (see README.md):
#
#   ./prepare-image.sh --key '<bb-box public key>' [--key <another>]... [--from <image>] [--name <vm>] [--bb-url <url>] [--replace]
#
# It clones the base image to <name>-build, boots it, runs guest/customize.sh
# in it as its user, shuts it down, grants Cua Driver Accessibility and Screen
# Recording on its disk (grant-tcc.sh), boots it again to check the grants,
# shuts it down and renames it to <name>. Boxes cloned from an image it
# replaces keep running. Its record (049) is in the image, in
# /usr/local/share/bb-box/image.json, as macOS keeps /usr/share read-only,
# and beside it, in ~/.bb-box/tart/images/<name>.json, where bb-box's doctor
# reads it.
set -eu

CUA_VERSION=0.30.4
CUA_SHA256=e270ea67388d794505031b0a15d8b58994c67e18e754a43634d7732251f595df

from=ghcr.io/cirruslabs/macos-tahoe-base:latest
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

boot() {
  tart run --no-graphics "$build" >"$work/run.log" 2>&1 &
  pid=$!
  i=0
  until tart exec "$build" true >/dev/null 2>&1; do
    kill -0 "$pid" 2>/dev/null || { cat "$work/run.log" >&2; die "$build stopped while booting"; }
    i=$((i + 1))
    [ "$i" -lt 300 ] || die "$build's guest agent did not answer within 5 minutes"
    sleep 1
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
tart exec -i "$build" env BBBOX_SSH_PUBLIC_KEY="$key" CUA_VERSION="$CUA_VERSION" CUA_SHA256="$CUA_SHA256" BB_URL="$bb_url" /bin/sh -s \
  <"$here/guest/customize.sh"
# The pins' SHA-256 is of this script's pin lines, as bb-box hashes them.
step "recording $build_id in $build"
os=$(tart exec "$build" sw_vers -productVersion)
node=$(tart exec "$build" /bin/zsh -c 'node --version' 2>/dev/null | tr -d 'v\r') || node=
app=$(tart exec "$build" /bin/sh -c 'cat "$HOME"/.bb-machines/*/host-artifact.sha256 2>/dev/null | head -n 1') || app=
pins=$(grep -E '^[A-Z0-9_]+_(VERSION|SHA256|URL)=' "$here/prepare-image.sh" | shasum -a 256 | cut -d' ' -f1)
quoted() { if [ -n "$1" ]; then printf '"%s"' "$1"; else printf null; fi; }
record=$(printf '{"contract":1,"image":"standard","kind":"macos","arch":"arm64","build":"%s","built":"%s","base":null,"os":"macOS %s","aptSnapshot":null,"pins":"%s","bbApp":%s,"tools":{"cua-driver":"%s"%s},"nvidia":null,"layer":null,"sizeGiB":null}' \
  "$build_id" "$built" "$os" "$pins" "$(quoted "$app")" "$CUA_VERSION" "${node:+,\"node\":\"$node\"}")
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
shutdown

if exists "$name"; then tart delete "$name"; fi
tart rename "$build" "$name"
mkdir -p "$HOME/.bb-box/tart/images"
printf 'from=%s\ncua=%s\nbuilt=%s\n%s\n' "$from" "$CUA_VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(printf '%s\n' "$key" | awk '{print "key=" $2}')" \
  >"$HOME/.bb-box/tart/images/$name"
printf '%s\n' "$record" >"$HOME/.bb-box/tart/images/$name.json"
step "done: $name is ready to clone ($(du -sh "${TART_HOME:-$HOME/.tart}/vms/$name" | cut -f1) on disk)"
