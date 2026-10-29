#!/bin/bash
set -euo pipefail
die() { echo "template: $*" >&2; exit 1; }
step=${1:-}
kind=${2:-}
case "$kind" in linux | android) artifacts=linux ;; desktop) artifacts=desktop-cpu ;; *) die "the kind must be linux, desktop or android" ;; esac
here=$(cd "$(dirname "$0")" && pwd)
src=$here/../proxmox-lxc/template
[ -f "$src/build.env" ] || die "no $src/build.env"
. "$src/build.env"
export DEBIAN_FRONTEND=noninteractive
say() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }
boat_sources=/etc/apt/sources.list.d.boat
set_boat_sources_aside() {
  mkdir -p "$boat_sources"
  for source in /etc/apt/sources.list.d/*; do
    [ -e "$source" ] || continue
    case "$(basename "$source")" in ubuntu.sources | zz-bb-box-*) ;; *) mv "$source" "$boat_sources/" ;; esac
  done
}
remove_boat_docker() {
  systemctl stop docker.socket docker.service containerd.service 2>/dev/null || :
  installed=$(dpkg-query -W -f='${Package} ${Status}\n' docker-ce docker-ce-cli docker-ce-rootless-extras docker-buildx-plugin docker-compose-plugin containerd.io 2>/dev/null | awk '$4 == "installed" { print $1 }' || :)
  [ -z "$installed" ] || apt-get purge -y -q $installed >/dev/null
}
set_boat_tools_aside() {
  mkdir -p /usr/local/lib/boat-tools
  jq -r '.tools[] | select(.arch == "x86_64") | .links // {} | keys[]' "$src/pins.json" | while read -r command; do
    link=/usr/local/bin/$command
    [ -e "$link" ] || [ -L "$link" ] || continue
    case "$(readlink "$link" 2>/dev/null)" in /opt/bb-box-tools/*) ;; *) mv "$link" /usr/local/lib/boat-tools/ ;; esac
  done
}
set_boat_rust_aside() {
  mkdir -p /usr/local/lib/boat-rust
  for dir in /usr/local/rustup /usr/local/cargo; do
    [ ! -d "$dir" ] || mv "$dir" /usr/local/lib/boat-rust/
  done
  sed -i -e '/^RUSTUP_HOME=/d' -e '/^CARGO_HOME=/d' -e 's|/usr/local/cargo/bin:||g' /etc/environment
  for profile in /etc/profile.d/*; do
    if grep -qE 'RUSTUP_HOME|CARGO_HOME|/usr/local/cargo' "$profile" 2>/dev/null; then mv "$profile" /usr/local/lib/boat-rust/; fi
  done
  unset RUSTUP_HOME CARGO_HOME
}
remove_boat_keyring() {
  if dpkg-query -W -f='${Status}' gnome-keyring 2>/dev/null | grep -q "install ok installed"; then apt-get purge -y -q gnome-keyring >/dev/null; fi
}
pin_bb_box_cua() {
  pinned=$(readlink -f /usr/local/bin/cua-driver)
  case "$pinned" in /opt/cua-driver/*) ;; *) die "bb-box's Cua Driver is not what /usr/local/bin/cua-driver points at" ;; esac
  install -d -m 0755 /usr/local/lib/bb-box/bin
  ln -sfn "$pinned" /usr/local/lib/bb-box/bin/cua-driver
  sed -i "s|/usr/local/bin/cua-driver|$pinned|g" /etc/systemd/user/bb-box-cua-driver.service
  grep -q '^PATH="/usr/local/lib/bb-box/bin:' /etc/environment || sed -i 's|^PATH="|PATH="/usr/local/lib/bb-box/bin:|' /etc/environment
  grep -q '^PATH="/usr/local/lib/bb-box/bin:' /etc/environment || die "could not put bb-box's Cua Driver first on PATH"
}
put_boat_sources_back() {
  [ -d "$boat_sources" ] || return 0
  find "$boat_sources" -mindepth 1 -maxdepth 1 -exec mv -t /etc/apt/sources.list.d/ {} +
  rmdir "$boat_sources"
}
case "$step" in
  customize)
    command -v jq >/dev/null || { apt-get update -q >/dev/null && apt-get install -y -q jq >/dev/null; }
    say "fetching the tools, BB's host app and the desktop's artifacts"
    BBBOX_ENV=/nonexistent BBBOX_BB_URL="${BB_URL:-}" bash "$src/fetch-artifacts.sh" "$src/artifacts" "$artifacts" x86_64 </dev/null
    set_boat_sources_aside
    remove_boat_docker
    set_boat_tools_aside
    say "customize-base.sh"
    bash "$src/guest/customize-base.sh" "$src" </dev/null
    say "customize-sandbox.sh"
    bash "$here/customize-sandbox.sh" "$src" </dev/null
    if [ "$kind" = desktop ]; then
      set_boat_rust_aside
      say "customize-desktop.sh"
      bash "$src/guest/customize-desktop.sh" "$src" </dev/null
      pin_bb_box_cua
      remove_boat_keyring
    fi
    if [ "$kind" = android ]; then
      say "customize-android.sh"
      bash "$here/../android/customize-android.sh" "$src" </dev/null
    fi
    say "customized" ;;
  finalize)
    put_boat_sources_back
    say "finalize.sh"
    bash "$src/guest/finalize.sh" "$src" "$kind" </dev/null
    say "finalized" ;;
  *) die "the step must be customize or finalize" ;;
esac
