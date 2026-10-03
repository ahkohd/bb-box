#!/bin/sh
# Builds the Tart image Linux boxes on a Mac are cloned from (040): Ubuntu
# 24.04 on arm64, with what the Proxmox LXC Linux template has, from the same
# guest scripts and the arm64 tool pins. With --desktop, the image desktop
# boxes are cloned from, with what the CPU-only desktop template has. Run on
# each Mac as the user bb-box logs in as (see README.md):
#
#   ./prepare-linux-image.sh --key '<bb-box public key>' [--key <another>]... [--desktop] [--from <image>] [--name <vm>] [--bb-url <url>] [--replace]
#
# It clones the base image to <name>-build, grows its disk, boots it, runs
# ../proxmox-lxc/template's fetch-artifacts.sh, guest/customize-base.sh
# (BOX_RUNTIME=vm), guest/customize-desktop.sh (--desktop, DESKTOP_GPU=none)
# and guest/finalize.sh in it as root, checks it as the box user in between,
# shuts it down and renames it to <name>. Boxes cloned from an image it
# replaces keep running. finalize.sh writes its record (049),
# /usr/share/bb-box/image.json, and this copies it beside the image, to
# ~/.bb-box/tart/images/<name>.json, where bb-box's doctor reads it. About 6
# minutes, 8 with --desktop.
set -eu

from=ghcr.io/cirruslabs/ubuntu:24.04
name=
desktop=0
# A box keeps its image's disk (028); the file is sparse, so it costs only
# what a box writes.
disk_gb=64
key=
bb_url=
replace=0
die() { echo "prepare-linux-image: $*" >&2; exit 1; }
while [ $# -gt 0 ]; do
  case $1 in
    --from) from=$2; shift 2 ;;
    --name) name=$2; shift 2 ;;
    --desktop) desktop=1; shift ;;
    --key)
      case $2 in ssh-ed25519\ *) ;; *) die "--key must be an OpenSSH ed25519 public key" ;; esac
      key="${key:+$key
}$2"
      shift 2 ;;
    --bb-url) bb_url=$2; shift 2 ;;
    --replace) replace=1; shift ;;
    *) die "unknown option $1 (see the top of this script)" ;;
  esac
done
[ -n "$key" ] || die "give bb-box's public key with --key, as bb box doctor shows it"
if [ "$desktop" = 1 ]; then
  : "${name:=bb-box-linux-desktop}"
  kind=linux-arm64-desktop-cpu artifacts=desktop-cpu finalize=desktop
else
  : "${name:=bb-box-linux}"
  kind=linux-arm64 artifacts=linux finalize=linux
fi

here=$(cd "$(dirname "$0")" && pwd)
template=$here/../proxmox-lxc/template
[ -f "$template/pins.json" ] || die "no $template: run this from a checkout of bb-box"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nix-profile/bin:/run/current-system/sw/bin:$PATH" TART_NO_AUTO_PRUNE=1
command -v tart >/dev/null || die "install Tart first: brew install openai/tools/tart"
[ "$(uname -m)" = arm64 ] || die "Tart runs Linux VMs on Apple silicon only"
exists() { tart list --source local --quiet | grep -qxF "$1"; }
if exists "$name" && [ "$replace" = 0 ]; then die "$name exists; give --replace to build it again"; fi

build="$name-build"
build_id=build.$(date -u +%Y%m%d-%H%M%S)-$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')
work=$(mktemp -d)
pid=
cleanup() {
  [ -n "$pid" ] && kill "$pid" 2>/dev/null
  rm -rf "$work"
}
trap cleanup EXIT
step() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*"; }
# A command as root in the build VM. Tart's guest agent runs as the image's
# own user, who has sudo without a password.
as_root() { tart exec -i "$build" sudo -n "$@"; }

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
# A clean power-off: tart stop does not wait for a Linux guest to shut down.
shutdown() {
  tart exec "$build" sudo -n systemctl poweroff --no-block >/dev/null 2>&1 || :
  i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 120 ]; do
    i=$((i + 1))
    sleep 1
  done
  tart stop "$build" --timeout 30 >/dev/null 2>&1 || :
  wait "$pid" 2>/dev/null || :
  pid=
}
reboot() {
  shutdown
  boot
  as_root timeout 120 systemctl is-system-running --wait >/dev/null </dev/null || :
}

if exists "$build"; then tart delete "$build"; fi
step "cloning $from to $build"
tart clone "$from" "$build"
tart set "$build" --cpu 4 --memory 8192 --disk-size "$disk_gb"
step "booting $build"
boot

# The root file system fills the bigger disk.
as_root sh -c 'dev=$(findmnt -no SOURCE /); disk=/dev/$(lsblk -no PKNAME "$dev"); part=$(cat "/sys/class/block/${dev#/dev/}/partition"); growpart "$disk" "$part" >/dev/null || :; resize2fs "$dev" >/dev/null; df -h / | tail -1' </dev/null

# The Linux template's files, as build.sh lays them out in a CT.
step "copying the Linux template's scripts and pins into $build"
dir=/var/tmp/bb-box-build
tar -C "$here/.." -czf - proxmox-lxc/template proxmox-lxc/host/common.sh |
  as_root sh -c "rm -rf $dir && mkdir -p $dir && tar -xzf - -C $dir"
src=$dir/proxmox-lxc/template
printf 'BOX_USER=box\nBOX_RUNTIME=vm\nDESKTOP_GPU=none\nBB_URL=%s\nBUILD_ID=%s\n' "$bb_url" "$build_id" | as_root sh -c "cat >$src/build.env"
printf '%s\n' "$key" | as_root sh -c "cat >$src/plugin-key.pub"

step "fetching the arm64 tools, BB's host app and any desktop artifacts"
as_root sh -c 'command -v jq >/dev/null || { apt-get update -q >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -q jq >/dev/null; }' </dev/null
as_root env BBBOX_ENV=/nonexistent BBBOX_BB_URL="$bb_url" bash "$src/fetch-artifacts.sh" "$src/artifacts" "$artifacts" arm64 </dev/null
step "customising $build (the Linux template's customize-base.sh)"
as_root bash "$src/guest/customize-base.sh" "$src" </dev/null
# Each check runs after a boot, as in a new box: Docker, for one, is stopped
# then (041).
step "booting $build again, as a box would, and checking it as the box user"
reboot
as_root runuser -l box -c "bb-box-check-headless" </dev/null | tee "$work/check.txt"
# Each line is the check's name in 34 columns, a space, then ok or FAIL.
! grep -qE '^.{35}FAIL' "$work/check.txt" || die "a check failed (above)"
if [ "$desktop" = 1 ]; then
  step "adding the desktop to $build (customize-desktop.sh)"
  as_root bash "$src/guest/customize-desktop.sh" "$src" </dev/null
  step "booting $build again, as a box would, and checking the desktop as the box user"
  reboot
  as_root runuser -l box -c "bb-box-check-desktop" </dev/null | tee "$work/check.txt"
  # Each line is the check's name in 26 columns, a space, then ok or FAIL.
  ! grep -qE '^.{27}FAIL' "$work/check.txt" || die "a check failed (above)"
fi
step "finalizing $build"
as_root bash "$src/guest/finalize.sh" "$src" "$finalize" </dev/null
tart exec "$build" cat /usr/share/bb-box/image.json >"$work/image.json" || die "$build has no image record"
step "shutting $build down"
shutdown

if exists "$name"; then tart delete "$name"; fi
tart rename "$build" "$name"
mkdir -p "$HOME/.bb-box/tart/images"
printf 'from=%s\nkind=%s\nbuilt=%s\n%s\n' "$from" "$kind" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(printf '%s\n' "$key" | awk '{print "key=" $2}')" \
  >"$HOME/.bb-box/tart/images/$name"
cp "$work/image.json" "$HOME/.bb-box/tart/images/$name.json"
step "done: $name is ready to clone ($(du -sh "${TART_HOME:-$HOME/.tart}/vms/$name" | cut -f1) on disk)"
