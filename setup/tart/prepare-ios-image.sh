#!/bin/sh
set -eu

usage="./prepare-ios-image.sh [--from <macOS image>] [--name <vm>] [--replace] [--skip-check]"
from=bb-box-macos
name=bb-box-ios
replace=0
skip_check=0
die() { echo "prepare-ios-image: $*" >&2; exit 1; }
while [ $# -gt 0 ]; do
  case $1 in
    --from) from=$2; shift 2 ;;
    --name) name=$2; shift 2 ;;
    --replace) replace=1; shift ;;
    --skip-check) skip_check=1; shift ;;
    --key | --bb-url) shift 2 ;;
    *) die "unknown option $1: $usage" ;;
  esac
done

here=$(cd "$(dirname "$0")" && pwd)
[ -f "$here/ios/build-ios.sh" ] && [ -f "$here/../ssh-pool/mac-home/.zshenv" ] || die "found no $here/ios/build-ios.sh or $here/../ssh-pool/mac-home/.zshenv: run this from a whole copy of setup/"
. "$here/ios/pins"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nix-profile/bin:/run/current-system/sw/bin:$PATH" TART_NO_AUTO_PRUNE=1
command -v tart >/dev/null || die "install Tart first: brew install openai/tools/tart"
LIST_TRIES=5
LIST_GAP_SECONDS=2
local_vms() {
  tries=1
  until listed=$(tart list --source local --quiet 2>&1); do
    [ "$tries" -lt "$LIST_TRIES" ] || die "tart list failed $LIST_TRIES times, $LIST_GAP_SECONDS s apart, so whether a VM exists is not known: $listed"
    printf 'prepare-ios-image: tart list failed, as when a VM is deleted while it reads: trying again in %s s: %s\n' "$LIST_GAP_SECONDS" "$listed" >&2
    sleep "$LIST_GAP_SECONDS"
    tries=$((tries + 1))
  done
  printf '%s\n' "$listed"
}
exists() {
  vms=$(local_vms) || exit 1
  printf '%s\n' "$vms" | grep -qxF "$1"
}
exists "$from" || die "there is no Tart VM $from: build the macOS image first with prepare-image.sh"
if exists "$name" && [ "$replace" = 0 ]; then die "$name exists; give --replace to build it again"; fi

build="$name-build"
build_id=build.$(date -u +%Y%m%d-%H%M%S)-$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')
built=$(date -u +%Y-%m-%dT%H:%M:%SZ)
pins=$(cat "$here/ios/pins" "$here/ios/devices.tsv" | shasum -a 256 | cut -d' ' -f1)
work=$(mktemp -d)
pid=
cleanup() {
  [ -n "$pid" ] && kill "$pid" 2>/dev/null
  rm -rf "$work"
}
trap cleanup EXIT
step() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*"; }

SLOT_WAIT_MINUTES=60
SLOT_POLL_SECONDS=30
boot() {
  waited=0
  while :; do
    tart run --no-graphics --no-clipboard "$build" >"$work/run.log" 2>&1 &
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
shutdown() {
  tart exec "$build" sync >/dev/null 2>&1 || :
  tart stop "$build" --timeout 30 >/dev/null 2>&1 || :
  wait "$pid" 2>/dev/null || :
  pid=
}
desktop_ready() {
  i=0
  until tart exec "$build" /bin/sh -c 'pgrep -u "$(id -u)" -x tccd && pgrep -x Dock' >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -lt 120 ] || die "$build's user did not log in to its desktop within 2 minutes"
    sleep 1
  done
}

if exists "$build"; then tart delete "$build"; fi
step "cloning $from to $build"
tart clone "$from" "$build"
step "booting $build"
boot
desktop_ready
guest_setup=/tmp/bb-box-ios-setup
tar -C "$here" -czf - ios -C "$here/../ssh-pool" mac-home/.zshenv | tart exec -i "$build" /bin/sh -c "rm -rf $guest_setup && mkdir -p $guest_setup && tar -xzf - -C $guest_setup"
tart exec "$build" test -s /usr/local/share/bb-box/image.json || die "$from has no image record: build it with prepare-image.sh"
tart exec "$build" cp /usr/local/share/bb-box/image.json "$guest_setup/macos-image.json"

step "adding idb_companion and the devices to $build"
tart exec "$build" /usr/bin/env IDB_VERSION="$IDB_VERSION" IDB_URL="$IDB_URL" IDB_SHA256="$IDB_SHA256" /bin/sh "$guest_setup/ios/build-ios.sh" "$guest_setup/ios" \
  >"$work/build.txt" || die "adding the devices failed"
cat "$work/build.txt"

if [ "$skip_check" = 0 ]; then
  step "checking $build with bb-box-check-ios"
  tart exec "$build" /usr/local/bin/bb-box-check-ios >"$work/check.txt" 2>&1 || { cat "$work/check.txt"; die "the iOS image's check failed"; }
  cat "$work/check.txt"
fi

step "recording $build_id in $build"
tart exec -i "$build" /bin/sh -c "cat >$guest_setup/build.txt" <"$work/build.txt"
record=$(tart exec "$build" python3 "$guest_setup/ios/record-ios.py" "$guest_setup/macos-image.json" "$guest_setup/build.txt" "$build_id" "$built" "$pins")
[ -n "$record" ] || die "the image's record was not made"
printf '%s\n' "$record" | tart exec -i "$build" sudo -n sh -c 'cat >/usr/local/share/bb-box/image.json && chmod 0644 /usr/local/share/bb-box/image.json'
tart exec "$build" rm -rf "$guest_setup"
step "shutting $build down"
shutdown

if exists "$name"; then tart delete "$name"; fi
tart rename "$build" "$name"
mkdir -p "$HOME/.bb-box/tart/images"
printf 'from=%s\nbuilt=%s\n' "$from" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$HOME/.bb-box/tart/images/$name"
printf '%s\n' "$record" >"$HOME/.bb-box/tart/images/$name.json"
step "done: $name is ready to clone ($(du -sh "${TART_HOME:-$HOME/.tart}/vms/$name" | cut -f1) on disk)"
