#!/bin/sh
umask 022

VERSION=4
MARKER_HEADER="bb-box identity 1"
root=${BBBOX_IDENTITY_ROOT:-}
marker=$root/etc/bb-box/identity
armed=$root/var/lib/bb-box/identity-armed
resets=$root/var/lib/bb-box/identity-resets
pending=$root/var/lib/bb-box/identity-reset-pending
switch=$root/usr/local/lib/bb-box/identity-reset-on
run=$root/var/run/bb-box-identity
boot_result=$run/boot
users=$root/Users
nic_wait_tenths=${BBBOX_IDENTITY_NIC_WAIT_TENTHS:-300}

say() { echo "bb-box-identity: $*"; }
fail() { echo "bb-box-identity: $*" >&2; exit "${2:-1}"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
lower() { tr 'A-F' 'a-f'; }
one_line() { printf '%s' "$1" | tr '\n' ' ' | sed 's/ $//'; }
note_boot() { mkdir -p "$run" 2>/dev/null; printf '%s\n' "$1" >"$boot_result" 2>/dev/null || :; }
boot_seen() { cat "$boot_result" 2>/dev/null || echo none; }

live_macs() {
  if [ -n "${BBBOX_IDENTITY_MACS:-}" ]; then
    printf '%s\n' $BBBOX_IDENTITY_MACS | lower | sort -u
    return
  fi
  for _if in $(ioreg -r -c AppleVirtIONetwork -l 2>/dev/null | sed -n 's/.*"BSD Name" = "\(.*\)".*/\1/p'); do
    ifconfig "$_if" ether 2>/dev/null | awk '$1 == "ether" { print $2 }'
  done | lower | sort -u
}

write_atomically() {
  mkdir -p "${1%/*}" || return 1
  printf '%s\n' "$2" >"$1.new" && chmod "$3" "$1.new" && mv -f "$1.new" "$1" && sync
}

marker_box() { sed -n 's/^box //p' "$marker" 2>/dev/null | head -n 1; }
marker_macs() { sed -n 's/^mac //p' "$marker" 2>/dev/null | lower; }

read_marker() {
  [ -f "$marker" ] && [ -r "$marker" ] || return 1
  [ "$(head -n 1 "$marker")" = "$MARKER_HEADER" ] || return 1
  [ "$(sed -n 's/^source //p' "$marker")" = device ] || return 1
  _m=$(marker_macs)
  [ -n "$_m" ] || return 1
  for _mac in $_m; do printf '%s' "$_mac" | grep -Eq '^([0-9a-f]{2}:){5}[0-9a-f]{2}$' || return 1; done
}

compare_with_marker() {
  _i=0
  while :; do
    found=$(live_macs)
    for _mac in $(marker_macs); do
      printf '%s\n' "$found" | grep -qxF "$_mac" && return 0
    done
    [ -z "$found" ] || return 1
    [ "$_i" -lt "$nic_wait_tenths" ] || return 2
    _i=$((_i + 1))
    sleep 0.1
  done
}

marker_text() {
  _macs=$(live_macs)
  [ -n "$_macs" ] || return 1
  printf '%s\n' "$MARKER_HEADER"
  [ -z "$1" ] || printf 'box %s\n' "$1"
  printf 'source device\n'
  for _mac in $_macs; do printf 'mac %s\n' "$_mac"; done
  [ -z "$2" ] || printf '%s\n' "$2"
}

bb_folders() {
  for _f in "$users"/*/.bb-machines/* "$users"/*/.bb-machines/.set-aside/* "$root"/var/root/.bb-machines/*; do
    [ -d "$_f" ] && printf '%s\n' "$_f"
  done
}

machines_here() {
  bb_folders | while IFS= read -r _f; do
    _id=$(cat "$_f/host-id" 2>/dev/null) || continue
    printf '%s' "$_id" | grep -Eq '^[A-Za-z0-9_-]+$' && printf '%s\n' "$_id"
  done
}

console_user() {
  if [ -n "$root" ]; then
    if [ -s "$root/console-users" ]; then
      head -n 1 "$root/console-users"
      [ "$(wc -l <"$root/console-users")" -le 1 ] || { sed 1d "$root/console-users" >"$root/console-users.new" && mv "$root/console-users.new" "$root/console-users"; }
    else
      cat "$root/console-user" 2>/dev/null || echo root
    fi
    return
  fi
  stat -f %Su /dev/console 2>/dev/null || echo root
}

stop_bb_daemons() {
  for _p in "$users"/*/Library/LaunchAgents/app.getbb.host-daemon.*.plist; do
    [ -f "$_p" ] || continue
    _owner=$(stat -f %u "$_p" 2>/dev/null) || continue
    _label=$(basename "$_p" .plist)
    [ -z "$root" ] || continue
    if launchctl print "gui/$_owner/$_label" >/dev/null 2>&1; then
      : >"$run/daemon-loaded"
      launchctl bootout "gui/$_owner/$_label" >/dev/null 2>&1 || :
    fi
  done
}

forget_bb_machines() {
  stop_bb_daemons
  rm -f "$users"/*/Library/LaunchAgents/app.getbb.host-daemon.*.plist || return 1
  bb_folders | while IFS= read -r _f; do
    find "$_f" -mindepth 1 -maxdepth 1 ! -type d ! -name host-artifact.sha256 -delete || exit 1
    rm -rf "$_f/logs" "$_f/daemon.lock.lock" || exit 1
  done
}

forget_access() { rm -f "$users"/*/.config/bb-box/env "$root"/var/root/.config/bb-box/env; }

renew_ssh_host_keys() {
  rm -f "$root"/etc/ssh/ssh_host_* || return 1
  if [ -n "$root" ]; then
    mkdir -p "$root/etc/ssh" && for _t in ed25519 ecdsa rsa; do ssh-keygen -q -t "$_t" -N '' -C '' -f "$root/etc/ssh/ssh_host_${_t}_key" </dev/null || return 1; done
  else
    ssh-keygen -A >/dev/null || return 1
  fi
}

reset_identity() {
  _why=$1 _at=$2
  rm -f "$run/daemon-loaded"
  _logins=$(console_user)
  _held=$( { machines_here; ls "$users"/*/Library/LaunchAgents/app.getbb.host-daemon.*.plist 2>/dev/null; } | head -n 1)
  _machines=$( { [ -r "$pending" ] && sed -n 's/.*; BB machines removed: //p' "$pending" | tr ' ' '\n' | grep -v '^none$'; machines_here; } | sort -u | tr '\n' ' ' | sed 's/ $//')
  write_atomically "$pending" "$_at $_why; BB machines removed: ${_machines:-none}" 0644 || { say "could not record the reset before it began, so it removed nothing"; return 1; }
  _line=$(head -n 1 "$pending")
  forget_bb_machines || { say "could not remove BB's machine credentials"; return 1; }
  forget_access || { say "could not remove the thread's access file"; return 1; }
  _logins="$_logins $(console_user)"
  _raced=
  [ -z "$_held" ] || for _u in $_logins; do [ "$_u" = root ] || _raced=yes; done
  [ ! -e "$run/daemon-loaded" ] || _raced=yes
  if [ -n "$_raced" ]; then
    _line=$(printf '%s' "$_line" | sed "s/; BB machines removed: /; someone was logged in at the console ($(printf '%s' "$_logins" | tr -s ' ')) while it decided or removed BB's machine, so BB's daemon may have run as its source; BB machines removed: /")
  fi
  renew_ssh_host_keys || { say "could not make new SSH host keys"; return 1; }
  if _text=$(marker_text "" "reset $_at"); then
    write_atomically "$marker" "$_text" 0644 && write_atomically "$armed" none 0644 || { say "could not write this box's own identity marker"; return 1; }
  else
    say "found no network interface of its own to write a marker for, so it unarms this box until bb-box writes one"
    rm -f "$marker" "$armed"
  fi
  { printf '%s\n' "$_line" >>"$resets" && rm -f "$pending" && sync; } || { say "could not record the reset in $resets"; return 1; }
  [ -z "$_raced" ] || : >"$run/raced"
  say "reset, as $_why: removed BB's machine credentials and host ID (${_machines:-none}), the thread's access file and BB's daemon; made new SSH host keys"
}

boot() {
  mkdir -p "$run" 2>/dev/null
  rm -f "$run/raced"
  if [ ! -e "$switch" ]; then note_boot off; say "the identity reset is off"; return 0; fi
  if [ -e "$pending" ]; then
    _at=$(head -n 1 "$pending" | cut -d' ' -f1)
    _why=$(head -n 1 "$pending" | cut -d' ' -f2- | sed 's/; BB machines removed: .*$//; s/; a user was logged in.*$//')
    say "resuming the reset that began at ${_at:-an unknown time}"
  elif [ ! -e "$marker" ] && [ ! -e "$armed" ]; then
    note_boot unarmed
    say "kept: bb-box has written no identity marker here, so there is nothing to compare"
    return 0
  elif ! read_marker; then
    _why="its identity marker is missing or unreadable"
  else
    compare_with_marker
    case $? in
      0) note_boot kept; say "kept: the identity marker of box $(marker_box) matches"; return 0 ;;
      2) note_boot unknown; say "not knowing yet whether this box is a copy: it found no network interface; it removes nothing"; return 0 ;;
    esac
    _why="none of the marker's MAC addresses ($(one_line "$(marker_macs)")) is on this box's interfaces ($(one_line "$found"))"
  fi
  say "this box is a copy, so it resets its identity: $_why"
  if ! reset_identity "$_why" "${_at:-$(now)}"; then
    note_boot failed
    say "the reset failed; BB's daemon has no credentials or LaunchAgent to start with, and the next boot resumes it"
    return 1
  fi
  note_boot reset
}

write_marker_for_box() {
  printf '%s' "$1" | grep -Eq '^[a-z0-9]{4,64}$' || fail "the box ID must be letters and digits" 2
  [ "$2" = device ] || fail "a macOS box's source is device" 2
  [ -e "$switch" ] || fail "the identity reset is off, so bb-box writes no marker" 3
  [ ! -e "$pending" ] || fail "a reset has not finished here, so bb-box writes no marker until it has" 3
  _text=$(marker_text "$1" "") || fail "found no network interface of this box's" 3
  write_atomically "$marker" "$_text" 0644 && write_atomically "$armed" "$1" 0644 || fail "could not write $marker" 3
  cat "$marker"
}

status() {
  nic_wait_tenths=0
  if [ ! -e "$marker" ]; then _state=missing
  elif ! read_marker; then _state=unreadable
  else
    compare_with_marker
    case $? in 0) _state=matches ;; 1) _state=differs ;; *) _state=incomplete ;; esac
  fi
  printf 'version=%s\nenabled=%s\nboot=%s\nmarker=%s\narmed=%s\npending=%s\nbox=%s\nsource=%s\nraced=%s\n' "$VERSION" \
    "$([ -e "$switch" ] && echo yes || echo no)" "$(boot_seen)" "$_state" "$([ -e "$armed" ] && echo yes || echo no)" \
    "$([ -e "$pending" ] && echo yes || echo no)" "$(marker_box)" "$([ "$_state" = missing ] || echo device)" "$([ -e "$run/raced" ] && echo yes || echo no)"
}

as_root_or_tested() { [ "$(id -u)" = 0 ] || [ -n "$root" ] || fail "run it as root" 2; }

command=${1:-}
[ $# -eq 0 ] || shift
case $command in
  boot) as_root_or_tested; boot ;;
  write)
    as_root_or_tested
    box= source=
    while [ $# -gt 0 ]; do
      case $1 in
        --box) box=${2:-}; shift 2 ;;
        --source) source=${2:-}; shift 2 ;;
        *) fail "unknown option $1" 2 ;;
      esac
    done
    write_marker_for_box "$box" "$source"
    ;;
  enable) as_root_or_tested; write_atomically "$switch" on 0644 || fail "could not write $switch" ;;
  disable) as_root_or_tested; rm -f "$switch" ;;
  unarm) as_root_or_tested; rm -f "$marker" "$armed" ;;
  status) status ;;
  version) echo "$VERSION" ;;
  *) fail "usage: bb-box-identity boot | write --box <id> --source device | enable | disable | unarm | status | version" 2 ;;
esac
