#!/bin/bash
set -uo pipefail
umask 022

readonly VERSION=1
readonly MARKER_HEADER="bb-box identity 1"
readonly KNOWN_HOST_KEY_TYPES=" ed25519 ecdsa rsa "
root=${BBBOX_IDENTITY_ROOT:-}
marker=$root/etc/bb-box/identity
armed=$root/var/lib/bb-box/identity-armed
resets=$root/var/lib/bb-box/identity-resets
run=$root/run/bb-box-identity
boot_result=$run/boot
boot_value=$run/value
net=$root/sys/class/net
nic_wait_seconds=${BBBOX_IDENTITY_NIC_WAIT_SECONDS:-30}
live_value=
marker_box=
marker_source=
marker_value=
marker_macs=()

say() { echo "bb-box-identity: $*"; }
fail() { echo "bb-box-identity: $*" >&2; exit "${2:-1}"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
lower() { tr 'A-F' 'a-f'; }
count_lines() { if [ -n "$1" ]; then printf '%s\n' "$1" | wc -l; else echo 0; fi; }
one_line() { printf '%s' "$1" | tr '\n' ' '; }
flush() { sync "$@" 2>/dev/null || sync; }
make_folder() { [ -d "$1" ] || install -d -m "$2" "$1"; }

is_ethernet() { [ "$(cat "$1/type" 2>/dev/null)" = 1 ] && [ -r "$1/address" ]; }

backend_interface() {
  local source=$1 path=$2
  case $source in
    eth) [[ ${path##*/} =~ ^eth[0-9]+$ ]] ;;
    device) [ -e "$path/device" ] ;;
    *) return 1 ;;
  esac
}

live_macs() {
  local source=$1 path
  for path in "$net"/*; do
    is_ethernet "$path" && backend_interface "$source" "$path" || continue
    lower <"$path/address"
  done | sort -u
}

macs_when_present() {
  local source=$1 expected=$2 deadline=$((SECONDS + nic_wait_seconds)) found
  while :; do
    found=$(live_macs "$source")
    [ "$(count_lines "$found")" -lt "$expected" ] || break
    [ "$SECONDS" -lt "$deadline" ] || break
    sleep 0.2
  done
  printf '%s' "$found"
}

read_marker() {
  local first key rest mac
  marker_box= marker_source= marker_value= marker_macs=()
  [ -f "$marker" ] && [ -r "$marker" ] || return 1
  {
    IFS= read -r first && [ "$first" = "$MARKER_HEADER" ] || return 1
    while read -r key rest || [ -n "$key" ]; do
      case $key in
        box) marker_box=$rest ;;
        source) marker_source=$rest ;;
        value) marker_value=$rest ;;
        mac)
          mac=$(printf '%s' "$rest" | lower)
          [[ $mac =~ ^([0-9a-f]{2}:){5}[0-9a-f]{2}$ ]] || return 1
          marker_macs+=("$mac")
          ;;
      esac
    done
  } <"$marker"
  case $marker_source in
    eth | device) [ "${#marker_macs[@]}" -gt 0 ] ;;
    value) [ -n "$marker_value" ] ;;
    *) return 1 ;;
  esac
}

compare_with_marker() {
  local expected live
  if [ "$marker_source" = value ]; then
    [ "$live_value" = "$marker_value" ] && return 0
    echo "the value bb-box set on this guest is not the marker's"
    return 1
  fi
  expected=$(printf '%s\n' "${marker_macs[@]}" | sort -u)
  live=$(macs_when_present "$marker_source" "$(count_lines "$expected")")
  [ "$live" = "$expected" ] && return 0
  echo "the MAC addresses of its $marker_source interfaces ($(one_line "${live:-none}")) are not the marker's ($(one_line "$expected"))"
  return 1
}

marker_text() {
  local box=$1 source=$2 note=$3 macs mac
  printf '%s\n' "$MARKER_HEADER"
  [ -z "$box" ] || printf 'box %s\n' "$box"
  printf 'source %s\n' "$source"
  case $source in
    value)
      [ -n "$live_value" ] || return 1
      printf 'value %s\n' "$live_value"
      ;;
    eth | device)
      macs=$(live_macs "$source")
      [ -n "$macs" ] || return 1
      for mac in $macs; do printf 'mac %s\n' "$mac"; done
      ;;
    *) return 1 ;;
  esac
  [ -z "$note" ] || printf '%s\n' "$note"
}

store_marker() {
  local box=$1 source=$2 note=$3 text
  text=$(marker_text "$box" "$source" "$note") || return 1
  make_folder "${marker%/*}" 0755 && make_folder "${armed%/*}" 0755 || return 1
  printf '%s\n' "$text" >"$marker.new" && chmod 0644 "$marker.new" && flush "$marker.new" && mv -f "$marker.new" "$marker" && flush "${marker%/*}" || return 1
  printf '%s\n' "${box:-none}" >"$armed.new" && chmod 0644 "$armed.new" && flush "$armed.new" && mv -f "$armed.new" "$armed" && flush "${armed%/*}"
}

forget_tailnet_node() {
  [ -d "$root/var/lib/tailscale" ] || return 0
  find "$root/var/lib/tailscale" -mindepth 1 -delete
}

bb_machine_folders() {
  local folder
  for folder in "$root"/home/*/.bb-machines/* "$root"/home/*/.bb-machines/.set-aside/* "$root"/root/.bb-machines/*; do
    [ -d "$folder" ] && printf '%s\n' "$folder"
  done
}

forget_bb_machines() {
  local folder id
  while IFS= read -r folder; do
    id=$(cat "$folder/host-id" 2>/dev/null) || id=
    find "$folder" -mindepth 1 -maxdepth 1 ! -type d ! -name host-artifact.sha256 -delete || return 1
    rm -rf "$folder/logs" "$folder/daemon.lock.lock" || return 1
    [ -z "$id" ] || printf '%s\n' "$id"
  done < <(bb_machine_folders)
  rm -f "$root"/home/*/.config/systemd/user/bb-host-daemon-*.service "$root"/home/*/.config/systemd/user/*.wants/bb-host-daemon-*.service
}

forget_access() {
  rm -f "$root"/home/*/.config/bb-box/env "$root"/root/.config/bb-box/env
}

renew_ssh_host_keys() {
  local key type types=()
  for key in "$root"/etc/ssh/ssh_host_*_key; do
    [ -e "$key" ] || continue
    type=${key##*/ssh_host_}
    type=${type%_key}
    [[ $KNOWN_HOST_KEY_TYPES == *" $type "* ]] && types+=("$type")
  done
  rm -f "$root"/etc/ssh/ssh_host_* || return 1
  for type in "${types[@]}"; do
    ssh-keygen -q -t "$type" -N '' -C '' -f "$root/etc/ssh/ssh_host_${type}_key" </dev/null || return 1
  done
}

renew_machine_id() {
  local id dbus=$root/var/lib/dbus/machine-id
  id=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  [[ $id =~ ^[0-9a-f]{32}$ ]] || return 1
  make_folder "$root/etc" 0755 || return 1
  printf '%s\n' "$id" >"$root/etc/machine-id" || return 1
  if [ -f "$dbus" ] && [ ! -L "$dbus" ]; then printf '%s\n' "$id" >"$dbus" || return 1; fi
}

journal_under_new_machine_id() {
  [ -z "$root" ] && [ -d /run/systemd/system ] || return 0
  timeout 30 systemctl restart systemd-journald.service || say "journald files the rest of this boot's logs under the copied machine ID, in /var/log/journal"
}

source_seen_now() {
  if [[ $marker_source =~ ^(eth|device|value)$ ]]; then echo "$marker_source"
  elif [ -n "$live_value" ]; then echo value
  elif [ -n "$(live_macs device)" ]; then echo device
  else echo eth; fi
}

reset_identity() {
  local reason=$1 machines source
  forget_tailnet_node || { say "could not remove the tailnet node's state"; return 1; }
  machines=$(forget_bb_machines) || { say "could not remove BB's machine credentials"; return 1; }
  forget_access || { say "could not remove the thread's access file"; return 1; }
  renew_ssh_host_keys || { say "could not make new SSH host keys"; return 1; }
  renew_machine_id || { say "could not make a new machine ID"; return 1; }
  journal_under_new_machine_id
  say "reset, as $reason: removed BB's machine credentials and host ID ($(one_line "${machines:-none}")), the thread's access file and the tailnet node; made new SSH host keys and a new machine ID"
  source=$(source_seen_now)
  if ! store_marker "" "$source" "reset $(now)"; then
    rm -f "$marker"
    say "wrote no new identity marker, so the next boot resets again"
  fi
  make_folder "${resets%/*}" 0755 && printf '%s %s; BB machines removed: %s\n' "$(now)" "$reason" "$(one_line "${machines:-none}")" >>"$resets"
  return 0
}

boot() {
  local reason
  make_folder "$run" 0700 || say "could not make $run, so bb box status cannot say what this boot found"
  rm -f "$boot_value"
  [ -z "$live_value" ] || (umask 077 && printf '%s\n' "$live_value" >"$boot_value") || say "could not keep the value bb-box set on this guest in $boot_value"
  if [ ! -e "$marker" ] && [ ! -e "$armed" ]; then
    printf 'unarmed\n' >"$boot_result" 2>/dev/null
    say "kept: bb-box has written no identity marker here, so there is nothing to compare"
    return 0
  fi
  if ! read_marker; then
    reason="its identity marker is missing or unreadable"
  elif reason=$(compare_with_marker); then
    printf 'kept\n' >"$boot_result" 2>/dev/null
    say "kept: the identity marker of box ${marker_box:-none} matches"
    return 0
  fi
  say "this box is a copy, so it resets its identity: $reason"
  if ! reset_identity "$reason"; then
    printf 'failed\n' >"$boot_result" 2>/dev/null
    say "the reset failed, so the network, SSH, Tailscale and the box user's services stay off"
    return 1
  fi
  printf 'reset\n' >"$boot_result" 2>/dev/null
  return 0
}

write_marker_for_box() {
  local box=$1 source=$2
  [[ $box =~ ^[a-z0-9]{4,64}$ ]] || fail "the box ID must be letters and digits" 2
  case $source in
    eth | device) ;;
    value) live_value=$(cat "$boot_value" 2>/dev/null) || live_value= ;;
    *) fail "the source must be eth, device or value" 2 ;;
  esac
  [ "$source" != value ] || [ -n "$live_value" ] || fail "this boot saw no value from bb-box, so a marker of it would not match at the next boot" 3
  store_marker "$box" "$source" "" || fail "found none of this box's $source interfaces, or could not write $marker" 3
  cat "$marker"
}

status() {
  local boot=none state
  [ ! -r "$boot_result" ] || boot=$(cat "$boot_result")
  live_value=$(cat "$boot_value" 2>/dev/null) || live_value=
  nic_wait_seconds=0
  if [ ! -e "$marker" ]; then state=missing
  elif ! read_marker; then state=unreadable
  elif compare_with_marker >/dev/null; then state=matches
  else state=differs; fi
  printf 'version=%s\nboot=%s\nmarker=%s\narmed=%s\nbox=%s\nsource=%s\n' "$VERSION" "$boot" "$state" "$([ -e "$armed" ] && echo yes || echo no)" "$marker_box" "$marker_source"
}

as_root_or_tested() { [ "$(id -u)" = 0 ] || [ -n "$root" ] || fail "run it as root" 2; }

command=${1:-}
[ $# -eq 0 ] || shift
case $command in
  boot)
    as_root_or_tested
    [ "${1:-}" != --value ] || live_value=${2:-}
    boot
    ;;
  write)
    as_root_or_tested
    box= source=
    while [ $# -gt 0 ]; do
      case $1 in
        --box | --source)
          [ $# -ge 2 ] || fail "$1 needs a value" 2
          if [ "$1" = --box ]; then box=$2; else source=$2; fi
          shift 2
          ;;
        *) fail "unknown option $1" 2 ;;
      esac
    done
    write_marker_for_box "$box" "$source"
    ;;
  status) status ;;
  version) echo "$VERSION" ;;
  *) fail "usage: bb-box-identity boot [--value <value>] | write --box <id> --source eth|device|value | status | version" 2 ;;
esac
