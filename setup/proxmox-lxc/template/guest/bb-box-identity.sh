#!/bin/bash
set -uo pipefail
umask 022

readonly VERSION=5
readonly MARKER_HEADER="bb-box identity 1"
readonly KNOWN_HOST_KEY_TYPES=" ed25519 ecdsa rsa "
readonly UNIT=bb-box-identity.service
readonly SETTLE_UNIT=bb-box-identity-settle.service
readonly IDENTITY_USERS="ssh.service tailscaled.service"
readonly GATED_UNITS="systemd-networkd.service NetworkManager.service ssh.service ssh.socket tailscaled.service user@.service docker.service docker.socket containerd.service bb-box-docker-containers.service bb-box-display.service bb-box-session.service bb-box-vnc.service bb-box-vnc-password.service bb-box-selkies.service bb-box-device-firewall.service"
root=${BBBOX_IDENTITY_ROOT:-}
marker=$root/etc/bb-box/identity
armed=$root/var/lib/bb-box/identity-armed
resets=$root/var/lib/bb-box/identity-resets
pending=$root/var/lib/bb-box/identity-reset-pending
switch=$root/usr/local/lib/bb-box/identity-reset-on
units=$root/etc/systemd/system
user_units=$root/etc/systemd/user
run=$root/run/bb-box-identity
boot_result=$run/boot
boot_value=$run/value
net=$root/sys/class/net
nic_wait_seconds=${BBBOX_IDENTITY_NIC_WAIT_SECONDS:-30}
settle_seconds=${BBBOX_IDENTITY_SETTLE_SECONDS:-2}
live_value=
marker_box=
marker_source=
marker_value=
marker_macs=()
found_macs=

say() { echo "bb-box-identity: $*"; }
fail() { echo "bb-box-identity: $*" >&2; exit "${2:-1}"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
lower() { tr 'A-F' 'a-f'; }
one_line() { printf '%s' "$1" | tr '\n' ' ' | sed 's/ $//'; }
flush() { sync "$@" 2>/dev/null || sync; }
make_folder() { [ -d "$1" ] || install -d -m "$2" "$1"; }
note_boot() { printf '%s\n' "$1" >"$boot_result" 2>/dev/null || :; }
boot_seen() { cat "$boot_result" 2>/dev/null || echo none; }

listed() {
  local wanted=$1 item
  shift
  for item in "$@"; do [ "$item" = "$wanted" ] && return 0; done
  return 1
}

is_ethernet() { [ "$(cat "$1/type" 2>/dev/null)" = 1 ] && [ -r "$1/address" ]; }

lxc_card_macs() {
  ip -d -j link show 2>/dev/null | jq -r '.[]? | select(.link_type == "ether" and .linkinfo.info_kind == "veth" and has("link_netnsid") and (has("master") | not) and (.ifname | test("^eth[0-9]+$"))) | .address' 2>/dev/null
}

vm_card_macs() {
  local path
  for path in "$net"/*; do
    is_ethernet "$path" && [ -e "$path/device" ] || continue
    cat "$path/address"
  done
}

live_macs() {
  case $1 in
    eth) lxc_card_macs ;;
    device) vm_card_macs ;;
  esac | lower | sort -u
}

write_atomically() {
  local file=$1 text=$2 mode=$3
  make_folder "${file%/*}" 0755 || return 1
  printf '%s\n' "$text" >"$file.new" && chmod "$mode" "$file.new" && flush "$file.new" && mv -f "$file.new" "$file" && flush "${file%/*}"
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

marker_mac_present() {
  local mac
  for mac in "${marker_macs[@]}"; do
    grep -qxF "$mac" <<<"$found_macs" && return 0
  done
  return 1
}

devices_settled() {
  [ -z "$root" ] && [ -S /run/udev/control ] && command -v udevadm >/dev/null || return 0
  udevadm settle --timeout="$nic_wait_seconds" >/dev/null 2>&1
}

new_backend_macs() {
  local mac
  for mac in $(live_macs "$marker_source"); do
    listed "$mac" "${marker_macs[@]}" || printf '%s\n' "$mac"
  done
}

look_for_marker_macs() {
  local loops=$((nic_wait_seconds * 5)) loop=0 settled=no
  devices_settled && settled=yes
  while :; do
    found_macs=$(live_macs "$marker_source")
    marker_mac_present && return 0
    [ "$settled" = no ] || [ -z "$(new_backend_macs)" ] || return 1
    [ "$loop" -lt "$loops" ] || return 2
    loop=$((loop + 1))
    sleep 0.2
  done
}

compare_with_marker() {
  if [ "$marker_source" = value ]; then
    [ "$live_value" = "$marker_value" ] && return 0
    echo "the value bb-box set on this guest is not the marker's"
    return 1
  fi
  look_for_marker_macs
  case $? in
    0) return 0 ;;
    1)
      echo "none of the marker's MAC addresses ($(one_line "$(printf '%s\n' "${marker_macs[@]}")")) is on this box's interfaces ($(one_line "${found_macs:-none}"))"
      return 1
      ;;
    *)
      echo "after waiting about $nic_wait_seconds s it found none of the marker's MAC addresses ($(one_line "$(printf '%s\n' "${marker_macs[@]}")")) and no new one of the backend's that would show it is a copy (its interfaces: $(one_line "${found_macs:-none}"))"
      return 2
      ;;
  esac
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
  write_atomically "$marker" "$text" 0644 && write_atomically "$armed" "${box:-none}" 0644
}

grow_anchors() {
  local mac added= text
  [[ $marker_source =~ ^(eth|device)$ ]] || return 0
  for mac in $(live_macs "$marker_source"); do
    listed "$mac" "${marker_macs[@]}" && continue
    marker_macs+=("$mac")
    added="$added $mac"
  done
  [ -n "$added" ] || return 0
  text=$(
    printf '%s\n' "$MARKER_HEADER"
    [ -z "$marker_box" ] || printf 'box %s\n' "$marker_box"
    printf 'source %s\n' "$marker_source"
    printf '%s\n' "${marker_macs[@]}" | sort -u | sed 's/^/mac /'
  )
  if write_atomically "$marker" "$text" 0644; then say "added this boot's interfaces ($added ) to the marker, as the box proved itself"; else say "could not add this boot's interfaces to the marker"; fi
}

bb_folders() {
  local folder
  for folder in "$root"/home/*/.bb-machines/* "$root"/home/*/.bb-machines/.set-aside/* "$root"/root/.bb-machines/* "$root"/root/.bb-machines/.set-aside/*; do
    [ -d "$folder" ] && printf '%s\n' "$folder"
  done
}

machines_here() {
  local folder id
  while IFS= read -r folder; do
    id=$(cat "$folder/host-id" 2>/dev/null) || continue
    [[ $id =~ ^[A-Za-z0-9_-]+$ ]] && printf '%s\n' "$id"
  done < <(bb_folders)
}

pending_line() { [ -r "$pending" ] && head -n 1 "$pending"; }

pending_machines() {
  local line id
  line=$(pending_line) || return 0
  line=${line##*; BB machines removed: }
  for id in $line; do [ "$id" = none ] || printf '%s\n' "$id"; done
}

forget_tailnet_node() {
  [ -d "$root/var/lib/tailscale" ] || return 0
  find "$root/var/lib/tailscale" -mindepth 1 -delete
}

forget_bb_machines() {
  local folder
  while IFS= read -r folder; do
    find "$folder" -mindepth 1 -maxdepth 1 ! -type d ! -name host-artifact.sha256 -delete || return 1
    rm -rf "$folder/logs" "$folder/daemon.lock.lock" || return 1
  done < <(bb_folders)
  rm -f "$root"/home/*/.config/systemd/user/bb-host-daemon-*.service "$root"/home/*/.config/systemd/user/*.wants/bb-host-daemon-*.service \
    "$root"/root/.config/systemd/user/bb-host-daemon-*.service "$root"/root/.config/systemd/user/*.wants/bb-host-daemon-*.service
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
  [ ${#types[@]} -gt 0 ] || [ ! -e "$root/etc/ssh/sshd_config" ] || types=(ed25519 ecdsa)
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

write_marker_after_reset() {
  local at=$1 text
  if text=$(marker_text "" "$(source_seen_now)" "reset $at"); then
    write_atomically "$marker" "$text" 0644 && write_atomically "$armed" none 0644
  else
    say "found no interface of the backend's to write a marker for, so it unarms this box until bb-box writes one"
    rm -f "$marker" "$armed" && flush "${marker%/*}" "${armed%/*}"
  fi
}

begin_reset() {
  local reason=$1 at=$2 machines
  machines=$( { pending_machines; machines_here; } | sort -u)
  write_atomically "$pending" "$at $reason; BB machines removed: $(one_line "${machines:-none}")" 0644
}

reset_identity() {
  local reason=$1 at=$2 line
  begin_reset "$reason" "$at" || { say "could not record the reset before it began, so it removed nothing"; return 1; }
  line=$(pending_line) || return 1
  forget_tailnet_node || { say "could not remove the tailnet node's state"; return 1; }
  forget_bb_machines || { say "could not remove BB's machine credentials"; return 1; }
  forget_access || { say "could not remove the thread's access file"; return 1; }
  renew_ssh_host_keys || { say "could not make new SSH host keys"; return 1; }
  renew_machine_id || { say "could not make a new machine ID"; return 1; }
  journal_under_new_machine_id
  write_marker_after_reset "$at" || { say "could not write this box's own identity marker"; return 1; }
  { make_folder "${resets%/*}" 0755 && printf '%s\n' "$line" >>"$resets" && flush "$resets"; } || { say "could not record the reset in $resets"; return 1; }
  { rm -f "$pending" && flush "${pending%/*}"; } || { say "could not mark the reset done"; return 1; }
  say "reset, as $reason: removed BB's machine credentials and host ID (${line##*; BB machines removed: }), the thread's access file and the tailnet node; made new SSH host keys and a new machine ID"
}

boot() {
  local reason at= outcome
  make_folder "$run" 0755 || say "could not make $run, so bb box status cannot say what this boot found"
  rm -f "$boot_value"
  [ -z "$live_value" ] || (umask 077 && printf '%s\n' "$live_value" >"$boot_value") || say "could not keep the value bb-box set on this guest in $boot_value"
  if [ ! -e "$switch" ]; then
    note_boot off
    say "the identity reset is off in this image"
    return 0
  fi
  if [ -e "$pending" ]; then
    read_marker || :
    at=$(pending_line | cut -d' ' -f1)
    reason=$(pending_line | cut -d' ' -f2- | sed 's/; BB machines removed: .*$//')
    say "resuming the reset that began at ${at:-an unknown time}: ${reason:-no reason recorded}"
  elif [ ! -e "$marker" ] && [ ! -e "$armed" ]; then
    note_boot unarmed
    say "kept: bb-box has written no identity marker here, so there is nothing to compare"
    return 0
  elif ! read_marker; then
    reason="its identity marker is missing or unreadable"
    say "this box is a copy, so it resets its identity: $reason"
  else
    reason=$(compare_with_marker)
    outcome=$?
    if [ "$outcome" -eq 0 ]; then
      note_boot kept
      say "kept: the identity marker of box ${marker_box:-none} matches"
      grow_anchors
      return 0
    fi
    if [ "$outcome" -eq 2 ]; then
      note_boot unknown
      say "not knowing yet whether this box is a copy: $reason. It removes nothing; SSH, Tailscale and BB's daemon wait while it looks again"
      return 0
    fi
    say "this box is a copy, so it resets its identity: $reason"
  fi
  if ! reset_identity "$reason" "${at:-$(now)}"; then
    note_boot failed
    say "the reset failed, so the network, SSH, Tailscale, Docker, the desktop and the box user's services stay off; the next boot resumes it"
    return 1
  fi
  note_boot reset
  return 0
}

settle() {
  local reason outcome
  [ -e "$switch" ] || return 0
  nic_wait_seconds=0
  while :; do
    case $(boot_seen) in
      unknown) ;;
      failed) return 1 ;;
      *) return 0 ;;
    esac
    if read_marker; then
      reason=$(compare_with_marker)
      outcome=$?
      if [ "$outcome" -eq 0 ]; then
        note_boot kept
        say "kept, now that its cards are here: the identity marker of box ${marker_box:-none} matches"
        return 0
      fi
      if [ "$outcome" -eq 1 ]; then
        say "this box is a copy, as its cards show now that they are here, so it resets its identity: $reason"
        if reset_identity "$reason" "$(now)"; then
          note_boot reset
          return 0
        fi
        note_boot failed
        say "the reset failed, so SSH, Tailscale and BB's daemon stay off; the next boot resumes it"
        return 1
      fi
    fi
    sleep "$settle_seconds"
  done
}

wait_for_identity() {
  local unit=${1:-} machine
  machine=$(printf '%s' "${unit%.service}" | grep -oE 'host_[A-Za-z0-9_]+$')
  while :; do
    case $(boot_seen) in
      unknown) sleep "$settle_seconds" ;;
      failed)
        say "this box's identity reset failed, so BB's daemon does not start"
        return 1
        ;;
      *) break ;;
    esac
  done
  if [ -n "$machine" ] && { cat "$resets" "$pending" 2>/dev/null || :; } | grep -qE "; BB machines removed: (.* )?$machine( .*)?\$"; then
    say "BB machine $machine went with this box's identity reset, so its daemon does not start"
    return 1
  fi
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
  [ -e "$switch" ] || fail "the identity reset is off in this image, so bb-box writes no marker" 3
  [ ! -e "$pending" ] || fail "a reset has not finished here, so bb-box writes no marker until it has" 3
  [ "$source" != value ] || [ -n "$live_value" ] || fail "this boot saw no value from bb-box, so a marker of it would not match at the next boot" 3
  store_marker "$box" "$source" "" || fail "found none of this box's $source interfaces, or could not write $marker" 3
  cat "$marker"
}

status() {
  local boot=none state
  [ ! -r "$boot_result" ] || boot=$(cat "$boot_result")
  live_value=$(cat "$boot_value" 2>/dev/null) || live_value=
  nic_wait_seconds=0
  if [ ! -e "$marker" ]; then
    state=missing
  elif ! read_marker; then
    state=unreadable
  else
    compare_with_marker >/dev/null
    case $? in 0) state=matches ;; 1) state=differs ;; *) state=incomplete ;; esac
  fi
  printf 'version=%s\nenabled=%s\nboot=%s\nmarker=%s\narmed=%s\npending=%s\nbox=%s\nsource=%s\n' "$VERSION" "$([ -e "$switch" ] && echo yes || echo no)" "$boot" "$state" \
    "$([ -e "$armed" ] && echo yes || echo no)" "$([ -e "$pending" ] && echo yes || echo no)" "$marker_box" "$marker_source"
}

unit_text() {
  cat <<EOF
[Unit]
Description=bb-box: a copy of a box gives up the identity it copied
DefaultDependencies=no
After=local-fs.target systemd-journald.socket systemd-udev-trigger.service
Before=network-pre.target $(printf '%s' "$GATED_UNITS" | tr ' ' '\n' | grep -v '@' | tr '\n' ' ')shutdown.target
Wants=network-pre.target
Conflicts=shutdown.target
RefuseManualStop=yes

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/bb-box-identity boot
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
EOF
}

settle_unit_text() {
  cat <<UNIT
[Unit]
Description=bb-box: services that use the box's identity wait until it is known
DefaultDependencies=no
Requires=$UNIT
After=$UNIT
Before=$IDENTITY_USERS shutdown.target
Conflicts=shutdown.target
RefuseManualStop=yes

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/bb-box-identity settle
TimeoutStartSec=infinity

[Install]
WantedBy=multi-user.target
UNIT
}

requirement_of() {
  local needed=$UNIT
  [[ " $IDENTITY_USERS " != *" $1 "* ]] || needed="$UNIT $SETTLE_UNIT"
  printf '[Unit]\nRequires=%s\nAfter=%s' "$needed" "$needed"
}

enable() {
  local with_unit=$1 gated unit
  write_atomically "$switch" "on" 0644 || fail "could not write $switch"
  [ "$with_unit" = yes ] || return 0
  write_atomically "$units/$UNIT" "$(unit_text)" 0644 || fail "could not write the unit"
  write_atomically "$units/$SETTLE_UNIT" "$(settle_unit_text)" 0644 || fail "could not write the unit"
  for gated in $GATED_UNITS; do
    write_atomically "$units/$gated.d/10-bb-box-identity.conf" "$(requirement_of "$gated")" 0644 || fail "could not require it of $gated"
  done
  write_atomically "$user_units/bb-host-daemon-.service.d/10-bb-box-identity.conf" "$(printf '[Service]\nExecStartPre=/usr/local/sbin/bb-box-identity wait %%n\nTimeoutStartSec=infinity')" 0644 || fail "could not make BB's daemon wait for it"
  make_folder "$units/multi-user.target.wants" 0755 || fail "could not enable the unit"
  for unit in "$UNIT" "$SETTLE_UNIT"; do
    ln -sfn "../$unit" "$units/multi-user.target.wants/$unit" || fail "could not enable $unit"
  done
}

disable() {
  local gated
  rm -f "$switch" "$units/$UNIT" "$units/multi-user.target.wants/$UNIT" "$units/$SETTLE_UNIT" "$units/multi-user.target.wants/$SETTLE_UNIT" "$user_units/bb-host-daemon-.service.d/10-bb-box-identity.conf"
  rmdir "$user_units/bb-host-daemon-.service.d" 2>/dev/null || :
  for gated in $GATED_UNITS; do
    rm -f "$units/$gated.d/10-bb-box-identity.conf"
    rmdir "$units/$gated.d" 2>/dev/null || :
  done
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
  enable)
    as_root_or_tested
    if [ "${1:-}" = --no-unit ]; then enable no; else enable yes; fi
    ;;
  disable)
    as_root_or_tested
    disable
    ;;
  settle)
    as_root_or_tested
    settle
    ;;
  wait) wait_for_identity "${1:-}" ;;
  unarm)
    as_root_or_tested
    rm -f "$marker" "$armed" && flush "${marker%/*}" "${armed%/*}"
    ;;
  status) status ;;
  version) echo "$VERSION" ;;
  *) fail "usage: bb-box-identity boot [--value <value>] | write --box <id> --source eth|device|value | enable [--no-unit] | disable | settle | wait [<unit>] | unarm | status | version" 2 ;;
esac
