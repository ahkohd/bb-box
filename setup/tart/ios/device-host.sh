#!/bin/sh
set -u
umask 022
PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin
LC_ALL=C
export PATH LC_ALL

ROOT=

VERSION=3
HOST=$ROOT/var/db/bb-box/host
SHARE=$ROOT/usr/local/share/bb-box
IOS_SHARE=$SHARE/ios
SLOT_HOME=$SHARE/slot-home
DAEMONS=$ROOT/Library/LaunchDaemons
DATA=$ROOT/System/Volumes/Data
SIM_STORE=$ROOT/private/var/tmp
SLOT_LOGS=$ROOT/private/var/log/bb-box-slots
INSTALLED=/usr/local/libexec/bb-box/device-host
PORTS_PROGRAM=/usr/local/libexec/bb-box/device-host-ports
HOST_LABEL=app.bb-box.device-host
PORTS_LABEL=app.bb-box.device-host.ports
DEVICE_LABEL=app.bb-box.device
BB_LABEL=app.bb-box.bb
PREFIX=bbd-
SLOT_UID_BASE=80000
SLOT_UID_SPAN=10000
CARRIED_UID_BASE=79990
CARRIED_SLOTS="i1 i2"
JOINS="_developer com.apple.access_ssh"
HELD_PORTS="3000 4200 5000 5173 8000 8080 8081 19000"
PORT_FIRST=20000
PORT_COUNT=100
DEFAULT_MOST=8
DEFAULT_AHEAD=1
DEFAULT_RESETTING_MOST=4
RESETTING_MOST_LEAST=1
DEFAULT_DISK_RESERVE_GIB=10
MEMORY_FREE_LEAST=15
PROMISE_MOST_S=600
HOME_SIZE_EVERY_S=600
SECOND_DEVICE_MOST_S=600
WATCH_EVERY_S=5
STEP_TRIES=2
CLAIM_WARM_WAIT_S=300
SWEEPS_KEPT=20
DAEMON_PATH=/opt/homebrew/opt/node@24/bin:/opt/homebrew/opt/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
EXIT_LOST=3
EXIT_NOT_OURS=4
EXIT_FULL=5
EXIT_NOT_READY=6
EXIT_DELETING=7
EXIT_LENDING=8

SELF=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
KEPT_MARK=$HOST/kept
CLOSED_MARK=$HOST/closed
[ ! -e "$KEPT_MARK" ] || CARRIED_SLOTS=''

quit() {
  code=$1
  shift
  printf '%s\n' "$*" >&2
  exit "$code"
}
fail() { quit 1 "$@"; }
field() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -n 1; }
number() { case ${1:-} in '' | *[!0-9]*) return 1 ;; esac; }
now() { date +%s; }
precise_now() { perl -MTime::HiRes=time -e 'printf "%.3f\n", time'; }
seconds_since() { perl -e 'printf "%.1f\n", $ARGV[1] - $ARGV[0]' "$1" "$(precise_now)"; }
put() { cat >"$1.new.$$" && mv -f "$1.new.$$" "$1"; }
boot_id() { sysctl -n kern.bootsessionuuid 2>/dev/null || echo unknown; }
attribute() { dscl . -read "/Users/$1" "$2" 2>/dev/null | sed -n -e "s/^$2: //p" -e "s/^dsAttrTypeNative:$2: //p" | head -n 1; }
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

later() {
  nohup "$@" </dev/null >/dev/null 2>&1 9>&- 8>&- 7>&- &
}

background() {
  if command -v taskpolicy >/dev/null 2>&1; then taskpolicy -b "$@"; else "$@"; fi
}

take_lock() {
  fd=$1 file=$2 wait=$3
  mkdir -p "$(dirname "$file")"
  eval "exec $fd>>\"\$file\""
  perl -e 'use Fcntl ":flock"; open(my $f, ">&=", $ARGV[0]) or exit 1; $SIG{ALRM} = sub { exit 3 }; alarm $ARGV[1]; flock($f, $ARGV[1] ? LOCK_EX : LOCK_EX | LOCK_NB) or exit 3' "$fd" "$wait"
}

lock_host() { take_lock 9 "$HOST/lock" "$1" || quit "$EXIT_LOST" "Another bb-box command holds this host's lock."; }
unlock_host() { exec 9>&-; }

held_elsewhere() {
  [ -e "$1" ] || return 1
  perl -e 'use Fcntl ":flock"; open(my $f, ">>", $ARGV[0]) or exit 1; exit(flock($f, LOCK_EX | LOCK_NB) ? 1 : 0)' "$1"
}

setting() {
  value=$(field "$HOST/settings" "$1")
  if number "$value"; then
    if [ "$1" = resetting-most ] && [ "$value" -lt "$RESETTING_MOST_LEAST" ]; then value=$RESETTING_MOST_LEAST; fi
    echo "$value"
    return
  fi
  case $1 in
    most) echo "$DEFAULT_MOST" ;;
    ahead) echo "$DEFAULT_AHEAD" ;;
    resetting-most) echo "$DEFAULT_RESETTING_MOST" ;;
    disk-reserve-gib) echo "$DEFAULT_DISK_RESERVE_GIB" ;;
  esac
}

read_input() {
  allowed=$1
  install='' box='' thread='' name='' kind='' created='' key='' server='' most='' ahead='' resetting_most='' disk_reserve_gib='' kept=''
  if [ -t 0 ]; then return 0; fi
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    k=${line%%=*}
    v=${line#*=}
    [ "$k" != "$line" ] || quit 2 "Unknown input: $line."
    case " $allowed " in *" $k "*) ;; *) quit 2 "Unknown input: $k." ;; esac
    case $k in
      install) install=$v ;;
      box) box=$v ;;
      thread) thread=$v ;;
      name) name=$v ;;
      kind) kind=$v ;;
      created) created=$v ;;
      key) key=$v ;;
      server) server=$v ;;
      most) most=$v ;;
      ahead) ahead=$v ;;
      resetting-most) resetting_most=$v ;;
      disk-reserve-gib) disk_reserve_gib=$v ;;
      kept) kept=$v ;;
    esac
  done
}

box_word_or_quit() {
  case $1 in
    '' | [!A-Za-z0-9]* | *[!A-Za-z0-9_.-]*) quit 2 "$2 needs box=, a box ID of letters, digits, dots, dashes and underscores that starts with a letter or digit." ;;
  esac
}

carried() { case " $CARRIED_SLOTS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
slot_or_quit() {
  if carried "${1:-}"; then return 0; fi
  number "${1:-}" && [ "$1" -gt 0 ] || quit 2 "usage: device-host $2 <slot>, a slot such as 3${CARRIED_SLOTS:+, or $(echo "$CARRIED_SLOTS" | sed 's/ / or /')}."
}
slot_user() { echo "$PREFIX$1"; }
slot_uid() {
  if carried "$1"; then echo $((CARRIED_UID_BASE + ${1#i})); else echo $((SLOT_UID_BASE + $1)); fi
}
slot_of_uid() {
  for each in $CARRIED_SLOTS; do
    [ "$1" = "$(slot_uid "$each")" ] && { echo "$each"; return 0; }
  done
  echo $(($1 - SLOT_UID_BASE))
}
slot_uid_allowed() {
  number "${1:-}" || return 1
  [ "$1" -ge "$SLOT_UID_BASE" ] && [ "$1" -lt $((SLOT_UID_BASE + SLOT_UID_SPAN)) ] && return 0
  for each in $CARRIED_SLOTS; do [ "$1" = "$(slot_uid "$each")" ] && return 0; done
  return 1
}
all_slot_uids() {
  for uid; do slot_uid_allowed "$uid" || return 1; done
}
owner_of() { stat -f %u "$1" 2>/dev/null; }
users_own() {
  path=$1 uid=$2
  [ -e "$path" ] && [ ! -L "$path" ] && [ "$(owner_of "$path")" = "$uid" ]
}
users_folder() { [ -d "$1" ] && users_own "$1" "$2"; }
slot_dir() { echo "$HOST/slots/$1"; }
slot_ids() {
  for dir in "$HOST"/slots/*; do
    [ -f "$dir/slot" ] && echo "${dir##*/}"
  done | sort -n
}
fact() { field "$HOST/slots/$1/slot" "$2"; }
state() { field "$HOST/slots/$1/state" "$2"; }
set_state() {
  id=$1
  shift
  { for pair; do printf '%s\n' "$pair"; done; echo "since=$(now)"; } | put "$HOST/slots/$id/state"
}
home_of() { echo "$ROOT/Users/$(slot_user "$1")"; }
port_base() { echo $((PORT_FIRST + PORT_COUNT * $(fact "$1" place))); }

holds_place() {
  case $(state "$1" is):$(state "$1" step) in
    making:* | ready:* | held:* | releasing:* | resetting:processes | resetting:user) return 0 ;;
    *) return 1 ;;
  esac
}
counts_against_most() { holds_place "$1"; }

counted() {
  n=0
  for id in $(slot_ids); do counts_against_most "$id" && n=$((n + 1)); done
  echo "$n"
}

free_place() {
  taken=$(for id in $(slot_ids); do holds_place "$id" && fact "$id" place; done)
  place=0
  while printf '%s\n' "$taken" | grep -qx "$place"; do place=$((place + 1)); done
  echo "$place"
}

live_promises() {
  for file in "$HOST"/promises/*; do
    [ -f "$file" ] || continue
    since=$(field "$file" since)
    if number "$since" && [ $(($(now) - since)) -lt "$PROMISE_MOST_S" ]; then echo "${file##*/}"; else rm -f "$file"; fi
  done
}

drop_promise() { [ -z "${1:-}" ] || rm -f "$HOST/promises/$1"; }

deleting() { [ -e "$HOST/deleting" ]; }
kept_host() { [ -e "$KEPT_MARK" ]; }
closed() { [ -e "$CLOSED_MARK" ]; }
lends_nothing() { deleting || closed; }
refuse_if_deleting() {
  if deleting; then quit "$EXIT_DELETING" "This host is being deleted; ask again."; fi
  if closed; then quit "$EXIT_DELETING" "This host is closed, as the pool's Mac is while it is lent whole, so it lends no slot now; ask again."; fi
}

others_keep_the_host() {
  for other in $(slot_ids); do
    [ "$other" = "$1" ] && continue
    case $(state "$other" is) in
      held) return 0 ;;
      making) [ -z "$(state "$other" for)" ] || return 0 ;;
    esac
  done
  [ -n "$(live_promises)" ]
}

as_user() {
  user=$1
  shift
  (cd / && sudo -n -H -u "$user" -- "$@")
}

simctl() {
  user=$1
  shift
  as_user "$user" xcrun simctl "$@"
}

runtime_line() { grep -v '^#' "$IOS_SHARE/runtimes.tsv" 2>/dev/null | head -n 1; }
default_model() { head -n 1 "$IOS_SHARE/devices.tsv" 2>/dev/null; }

user_made() {
  id=$1
  user=$(slot_user "$id") uid=$(slot_uid "$id")
  [ "$(attribute "$user" UniqueID)" = "$uid" ] && [ -e "$(slot_dir "$id")/user-made" ]
}

remove_from_groups() {
  for group in $JOINS; do
    dseditgroup -o edit -d "$1" -t user "$group" >/dev/null 2>&1 ||
      dscl . -delete "/Groups/$group" GroupMembership "$1" >/dev/null 2>&1
  done
}

delete_user() {
  user=$1
  if dscl . -read "/Users/$user" >/dev/null 2>&1; then
    sysadminctl -deleteUser "$user" >/dev/null 2>&1
    ! dscl . -read "/Users/$user" >/dev/null 2>&1 || dscl . -delete "/Users/$user" >/dev/null 2>&1
    ! dscl . -read "/Users/$user" >/dev/null 2>&1 || return 1
  fi
  rm -rf "$ROOT/Users/$user"
}

make_user() {
  id=$1
  user=$(slot_user "$id") uid=$(slot_uid "$id")
  user_made "$id" && return 0
  rm -f "$(slot_dir "$id")/user-made"
  if dscl . -read "/Users/$user" >/dev/null 2>&1 || [ -e "$ROOT/Users/$user" ]; then
    remove_from_groups "$user"
    delete_user "$user" || { echo "Could not remove $user, which a step cut short left half made." >&2; return 1; }
  fi
  holder=$(dscl . -list /Users UniqueID 2>/dev/null | awk -v id="$uid" '$2 == id { print $1; exit }')
  if [ -n "$holder" ]; then
    echo "UID $uid belongs to $holder. Slot users take UIDs $SLOT_UID_BASE to $((SLOT_UID_BASE + SLOT_UID_SPAN - 1)), and the image's carried slots $(slot_uid i1) and $(slot_uid i2)." >&2
    return 1
  fi
  password=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)
  [ "${#password}" = 24 ] || return 1
  said=$(printf '%s\n' "$password" | sysadminctl -addUser "$user" -fullName "bb-box $user" -UID "$uid" -password - -home "/Users/$user" 2>&1)
  if [ "$(attribute "$user" UniqueID)" != "$uid" ]; then
    reason=$(printf '%s\n' "$said" | sed -n 's/^.*sysadminctl\[[0-9:]*\] //p' | grep -v -e '^-*$' -e 'clear text password' -e 'Creating user record' | tail -n 1)
    echo "sysadminctl did not make $user${reason:+: $reason}." >&2
    return 1
  fi
  dscl . -create "/Users/$user" IsHidden 1 || return 1
  for group in $JOINS; do
    [ "$group" = _developer ] || dscl . -read "/Groups/$group" >/dev/null 2>&1 || continue
    dseditgroup -o edit -a "$user" -t user "$group" >/dev/null 2>&1 || return 1
  done
  dsmemberutil flushcache >/dev/null 2>&1
  home=$ROOT/Users/$user
  [ -d "$home" ] || createhomedir -c -u "$user" >/dev/null 2>&1
  [ -d "$home" ] || return 1
  if [ -d "$SLOT_HOME" ]; then cp -Rc "$SLOT_HOME/." "$home/" 2>/dev/null || cp -R "$SLOT_HOME/." "$home/" || return 1; fi
  base=$(port_base "$id")
  printf '%s\n' "export BB_PORT_BASE=$base BB_PORT_COUNT=$PORT_COUNT" >>"$home/.zshenv" || return 1
  mkdir -p "$home/.bb-box/device" || return 1
  printf 'base=%s\ncount=%s\n' "$base" "$PORT_COUNT" >"$home/.bb-box/ports" || return 1
  printf '%s\n' "$id" >"$home/.bb-box/device/host-managed" || return 1
  chown -R "$uid:20" "$home" || return 1
  chmod 700 "$home" "$home/.bb-box" "$home/.bb-box/device" || return 1
  : >"$(slot_dir "$id")/user-made"
}

seed() {
  id=$1 udid=$2
  user=$(slot_user "$id") uid=$(slot_uid "$id")
  list=$(runtime_line | cut -f 4)
  plist=$IOS_SHARE/$list.disabled.plist
  [ -s "$plist" ] || { echo "This host has no $plist to slim the slot's device with." >&2; return 1; }
  store=$SIM_STORE/com.apple.CoreSimulator.SimDevice.$udid
  if ! mkdir "$store" 2>/dev/null; then
    [ -d "$store" ] && [ ! -L "$store" ] && { [ "$(owner_of "$store")" = 0 ] || [ "$(owner_of "$store")" = "$uid" ]; } ||
      { echo "${store#"$ROOT"} is not a folder of root's or $user's, so the slot's device is not seeded." >&2; return 1; }
  fi
  rm -f "$store/disabled.plist" && cp "$plist" "$store/disabled.plist" && chown -R "$uid:0" "$store" && chmod 700 "$store"
}

make_device() {
  id=$1
  user=$(slot_user "$id")
  dir=$(slot_dir "$id")
  model_line=$(default_model)
  model=$(printf '%s\n' "$model_line" | cut -f 1) type=$(printf '%s\n' "$model_line" | cut -f 2)
  runtime=$(runtime_line | cut -f 1)
  [ -n "$model" ] && [ -n "$type" ] || { echo "This host has no $IOS_SHARE/devices.tsv to choose the slot's device from." >&2; return 1; }
  [ -n "$runtime" ] || { echo "This host has no iOS runtime in $IOS_SHARE/runtimes.tsv." >&2; return 1; }
  udid=$(field "$dir/device" udid)
  if [ -n "$udid" ] && simctl "$user" list devices 2>/dev/null | grep -qF "($udid)"; then
    seed "$id" "$udid"
    return
  fi
  simctl "$user" list devices >/dev/null 2>&1 || { echo "simctl did not run as $user." >&2; return 1; }
  simctl "$user" delete all >/dev/null 2>&1 || { echo "simctl could not remove the default devices of $user." >&2; return 1; }
  udid=$(simctl "$user" create "$model" "$type" "$runtime" 2>/dev/null | tail -n 1)
  case $udid in ????????-????-????-????-????????????) ;; *) echo "simctl did not make a $model on $runtime for $user." >&2; return 1 ;; esac
  printf 'model=%s\ntype=%s\nruntime=%s\nudid=%s\n' "$model" "$type" "$runtime" "$udid" | put "$dir/device"
  seed "$id" "$udid"
}

device_udid() { field "$(slot_dir "$1")/device" udid; }

device_booted() { simctl "$(slot_user "$1")" list devices 2>/dev/null | grep -F "($2)" | grep -q '(Booted)'; }

boot_device() {
  id=$1
  user=$(slot_user "$id") udid=$(device_udid "$id")
  [ -n "$udid" ] || { echo "Slot $id has no device." >&2; return 1; }
  device_booted "$id" "$udid" || simctl "$user" boot "$udid" >/dev/null 2>&1 || device_booted "$id" "$udid" ||
    { echo "simctl did not boot $user's device $udid." >&2; return 1; }
  simctl "$user" bootstatus "$udid" -b >/dev/null 2>&1 || { echo "$user's device $udid did not finish booting." >&2; return 1; }
}

first_boot() {
  id=$1
  boot_device "$id" || return 1
  if [ "$(field "$(slot_dir "$id")/make" mode)" = carry ]; then
    simctl "$(slot_user "$id")" shutdown "$(device_udid "$id")" >/dev/null 2>&1 || { echo "simctl did not shut down $(slot_user "$id")'s device." >&2; return 1; }
  fi
}

plist_head() {
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
    '<plist version="1.0">' '<dict>'
}
plist_tail() { printf '%s\n' '</dict>' '</plist>'; }
plist_string() { printf '  <key>%s</key><string>%s</string>\n' "$1" "$(xml "$2")"; }
plist_arguments() {
  printf '  <key>ProgramArguments</key>\n  <array>\n'
  for argument; do printf '    <string>%s</string>\n' "$(xml "$argument")"; done
  printf '  </array>\n'
}
plist_environment() {
  printf '  <key>EnvironmentVariables</key>\n  <dict>\n'
  while [ $# -ge 2 ]; do
    printf '    <key>%s</key><string>%s</string>\n' "$1" "$(xml "$2")"
    shift 2
  done
  printf '  </dict>\n'
}

DEVICE_SERVER_WAIT='d="$HOME/.bb-box/device"; until [ -f "$d/current/src/device/bb-box-device.sh" ] && [ -f "$d/devices.json" ]; do sleep 1; done; exec /bin/sh "$d/current/src/device/bb-box-device.sh" serve'

write_device_daemon() {
  id=$1
  user=$(slot_user "$id")
  home=/Users/$user
  mkdir -p "$(slot_dir "$id")/daemons"
  {
    plist_head
    plist_string Label "$DEVICE_LABEL.$user"
    plist_string UserName "$user"
    plist_string GroupName staff
    plist_environment HOME "$home" USER "$user" LOGNAME "$user" PATH "$DAEMON_PATH" BB_PORT_BASE "$(port_base "$id")" BB_PORT_COUNT "$PORT_COUNT"
    plist_arguments /bin/sh -c "$DEVICE_SERVER_WAIT"
    plist_string WorkingDirectory "$home"
    printf '  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>ThrottleInterval</key><integer>1</integer>\n'
    plist_string ProcessType Interactive
    plist_tail
  } | put "$(slot_dir "$id")/daemons/$DEVICE_LABEL.$user.plist"
}

load_daemon() {
  plist=$1
  label=$(basename "$plist" .plist)
  installed=$DAEMONS/$label.plist
  cp "$plist" "$installed.new.$$" && chown root:wheel "$installed.new.$$" && chmod 644 "$installed.new.$$" && mv -f "$installed.new.$$" "$installed" || return 1
  launchctl bootout "system/$label" >/dev/null 2>&1
  tries=0
  until launchctl bootstrap system "$installed" >/dev/null 2>&1; do
    launchctl print "system/$label" >/dev/null 2>&1 && return 0
    tries=$((tries + 1))
    [ "$tries" -lt 20 ] || { echo "launchd did not load $label." >&2; return 1; }
    sleep 0.25
  done
}

unload_daemon() {
  launchctl bootout "system/$1" >/dev/null 2>&1
  rm -f "$DAEMONS/$1.plist"
}

loaded_as_written() {
  label=$(basename "$1" .plist)
  launchctl print "system/$label" >/dev/null 2>&1 && cmp -s "$1" "$DAEMONS/$label.plist"
}

keep_loaded() { loaded_as_written "$1" || load_daemon "$1"; }

initialised() { [ -f "$HOST/settings" ]; }

load_slot_daemons() {
  id=$1
  for plist in "$(slot_dir "$id")"/daemons/*.plist; do
    [ -f "$plist" ] || continue
    load_daemon "$plist" || return 1
  done
  : >"$(slot_dir "$id")/loaded"
}

unload_slot_daemons() {
  id=$1
  user=$(slot_user "$id")
  for label in "$DEVICE_LABEL.$user" "$BB_LABEL.$user"; do unload_daemon "$label"; done
  rm -f "$(slot_dir "$id")/loaded"
}

copy_server() {
  id=$1 from=$2
  [ -n "$from" ] || return 0
  user=$(slot_user "$id") uid=$(slot_uid "$id")
  device=$(home_of "$id")/.bb-box/device
  [ ! -L "$(home_of "$id")/.bb-box" ] && [ ! -L "$device" ] && [ ! -L "$device/server" ] || { echo "$user's device folder is a link." >&2; return 1; }
  [ ! -e "$device/current" ] || return 0
  case $from in /*) ;; *) echo "server= must be an absolute path to a device server's folder." >&2; return 1 ;; esac
  version=$(readlink "$ROOT$from/current" 2>/dev/null)
  case $version in server/[0-9]*) ;; *) echo "$from has no device server." >&2; return 1 ;; esac
  [ -d "$ROOT$from/$version" ] && [ -f "$ROOT$from/devices.json" ] || { echo "$from has no whole device server." >&2; return 1; }
  mkdir -p "$device/server" || return 1
  rm -rf "$device/$version.incoming"
  cp -R "$ROOT$from/$version" "$device/$version.incoming" && mv "$device/$version.incoming" "$device/$version" || return 1
  for file in devices.json choices.json node; do
    [ ! -f "$ROOT$from/$file" ] || cp "$ROOT$from/$file" "$device/$file" || return 1
  done
  ln -sfn "$version" "$device/current" || return 1
  chown -R "$uid:20" "$device" && chmod 700 "$device"
}

make_daemons() {
  id=$1
  dir=$(slot_dir "$id")
  write_device_daemon "$id" || return 1
  copy_server "$id" "$(field "$dir/make" server)" || return 1
  [ "$(field "$dir/make" mode)" = carry ] && return 0
  load_slot_daemons "$id"
}

record_timing() { printf '%s %s\n' "$2" "$3" >>"$(slot_dir "$1")/timings"; }

failed_step() {
  id=$1 step=$2 words=$3
  dir=$(slot_dir "$id")
  tries=$(($(field "$dir/fails" "$step" | head -n 1 | grep . || echo 0) + 1))
  { grep -v "^$step=" "$dir/fails" 2>/dev/null; echo "$step=$tries"; } | put "$dir/fails"
  if [ "$tries" -ge "$STEP_TRIES" ]; then
    removed_words="Making slot $id failed at its $step step $tries times, so the slot is removed: $words"
    lock_host 60
    set_state "$id" is=resetting step=processes "after=making $step failed $tries times"
    unlock_host
    carry_on "$id" >/dev/null 2>&1
    fail "$removed_words"
  fi
  fail "Making slot $id failed at its $step step: $words Run it again to carry on from there."
}

making_step() {
  id=$1 step=$2 next=$3
  shift 3
  started=$(precise_now)
  words=$("$@" 2>&1 >/dev/null) || failed_step "$id" "$step" "${words:-it failed.}"
  record_timing "$id" "$step" "$(seconds_since "$started")"
  lock_host 60
  if closed && [ -z "$(state "$id" for)" ]; then
    set_state "$id" is=resetting step=processes "after=the host closed while it was made"
  elif [ "$next" = ready ]; then
    set_state "$id" is=ready
  else
    set_state "$id" is=making "step=$next" "for=$(state "$id" for)"
  fi
  unlock_host
}

within() {
  perl -e '$SIG{ALRM} = sub { kill "TERM", $pid; exit 124 }; $pid = fork // exit 1; if (!$pid) { exec @ARGV[1 .. $#ARGV] } alarm $ARGV[0]; waitpid $pid, 0; exit($? >> 8)' "$@"
}

CONTAINERS_PROCESS=containermanagerd

clients_of() { pgrep -l -u "$1" 2>/dev/null | awk -v keep="$CONTAINERS_PROCESS" '$2 != keep { print $2 }' | sort -u; }

end_clients_before_containers() {
  uid=$1
  for name in $(clients_of "$uid"); do pkill -TERM -u "$uid" -x "$name" >/dev/null 2>&1; done
  tries=25
  while [ -n "$(clients_of "$uid")" ] && [ "$tries" -gt 0 ]; do
    tries=$((tries - 1))
    sleep 0.2
  done
}

stop_slot() {
  id=$1
  user=$(slot_user "$id") uid=$(slot_uid "$id")
  unload_slot_daemons "$id"
  within 30 sudo -n -H -u "$user" -- xcrun simctl shutdown all >/dev/null 2>&1
  end_clients_before_containers "$uid"
  sleep 1
  launchctl bootout "gui/$uid" >/dev/null 2>&1
  launchctl bootout "user/$uid" >/dev/null 2>&1
  tries=0
  while pgrep -u "$uid" >/dev/null 2>&1; do
    pkill -KILL -u "$uid" >/dev/null 2>&1
    tries=$((tries + 1))
    [ "$tries" -le 50 ] || { echo "Processes of $user did not end: $(pgrep -l -u "$uid" | head -n 3 | tr '\n' ' ')" >&2; return 1; }
    sleep 0.2
  done
}

remove_slot_user() {
  id=$1
  user=$(slot_user "$id") uid=$(slot_uid "$id")
  dscl . -read /Groups/staff >/dev/null 2>&1 || { echo "The Mac's directory service did not answer, so user $user is not removed yet." >&2; return 1; }
  crontab -u "$user" -r >/dev/null 2>&1
  rm -f "$ROOT/private/var/at/tabs/$user" "$ROOT/etc/sudoers.d/$user"
  remove_from_groups "$user"
  delete_user "$user" || { echo "Could not remove user $user." >&2; return 1; }
  rm -f "$(slot_log "$user")"
  mkdir -p "$HOST/sweep"
  printf 'slot=%s\nuser=%s\nuid=%s\nsince=%s\n' "$id" "$user" "$uid" "$(now)" | put "$HOST/sweep/$uid"
}

resetting_step() {
  id=$1 step=$2 next=$3
  shift 3
  started=$(precise_now)
  words=$("$@" 2>&1 >/dev/null) || fail "Resetting slot $id failed at its $step step: ${words:-it failed.} Run it again to carry on from there."
  record_timing "$id" "$step" "$(seconds_since "$started")"
  lock_host 60
  set_state "$id" is=resetting "step=$next"
  unlock_host
}

carry_on() {
  id=$1
  dir=$(slot_dir "$id")
  take_lock 8 "$dir/lock" 900 || quit "$EXIT_LOST" "Another bb-box command is working on slot $id."
  while [ -f "$dir/slot" ]; do
    case $(state "$id" is):$(state "$id" step) in
      making:user) making_step "$id" user device make_user "$id" ;;
      making:device) making_step "$id" device first-boot make_device "$id" ;;
      making:first-boot) making_step "$id" first-boot daemons first_boot "$id" ;;
      making:daemons) making_step "$id" daemons ready make_daemons "$id" ;;
      releasing:*)
        lock_host 60
        decide_last "$id" "$(state "$id" box)"
        set_state "$id" is=resetting step=processes "box=$(state "$id" box)"
        unlock_host
        ;;
      resetting:processes) resetting_step "$id" processes user stop_slot "$id" ;;
      resetting:user)
        resetting_step "$id" user sweep remove_slot_user "$id"
        later /bin/sh "$SELF" reset
        ;;
      *) break ;;
    esac
  done
  exec 8>&-
}

new_slot() {
  id=$1 place=$2 for=$3 mode=$4 from=$5
  dir=$(slot_dir "$id")
  mkdir -p "$dir"
  printf 'mode=%s\nserver=%s\n' "$mode" "$from" | put "$dir/make"
  set_state "$id" is=making step=user "for=$for"
  printf 'user=%s\nuid=%s\nplace=%s\ncarried=%s\nmade=%s\n' "$(slot_user "$id")" "$(slot_uid "$id")" "$place" "$(carried "$id" && echo 1 || echo 0)" "$(now)" |
    put "$dir/slot"
}

disk_free_gib() { df -Pk "$DATA" 2>/dev/null | awk 'NR == 2 { print int($4 / 1048576) }'; }
memory_free_percent() { memory_pressure 2>/dev/null | sed -n 's/^System-wide memory free percentage: *\([0-9]*\)%.*/\1/p' | head -n 1; }

generation() {
  last=$(cat "$HOST/generation" 2>/dev/null)
  number "$last" && echo "$last" || echo 0
}

no_room() {
  for_box=$1
  if [ $(($(generation) + 1)) -ge "$SLOT_UID_SPAN" ]; then
    echo "This host has given all its $((SLOT_UID_SPAN - 1)) slot UIDs, so it makes no new slot: let its boxes go, then set it up again."
    return
  fi
  most=$(setting most)
  promised=$(live_promises | grep -vx "${for_box:-}" | grep -c .)
  if [ $(($(counted) + promised)) -ge "$most" ]; then
    echo "This host has all its $most slots making, ready, held or promised."
    return
  fi
  reserve=$(setting disk-reserve-gib)
  free=$(disk_free_gib)
  if number "$free" && [ "$free" -lt "$reserve" ]; then
    echo "This host has $free GiB of disk free, under the $reserve GiB it keeps, so it makes no new slot."
    return
  fi
  memory=$(memory_free_percent)
  if number "$memory" && [ "$memory" -lt "$MEMORY_FREE_LEAST" ]; then
    echo "This host has $memory% of its memory free, under $MEMORY_FREE_LEAST%, so it makes no new slot."
  fi
}

room_or_quit() {
  words=$(no_room "$1")
  [ -z "$words" ] || quit "$EXIT_FULL" "$words"
}

spare_count() {
  n=0
  for id in $(slot_ids); do
    case $(state "$id" is) in
      ready) n=$((n + 1)) ;;
      making) [ -n "$(state "$id" for)" ] || n=$((n + 1)) ;;
    esac
  done
  echo "$n"
}

top_up() (
  from=$1
  lends_nothing && return 0
  while [ "$(spare_count)" -lt "$(setting ahead)" ] && [ -z "$(no_room '')" ]; do
    id=$(($(generation) + 1))
    echo "$id" | put "$HOST/generation"
    new_slot "$id" "$(free_place)" '' host "$from"
    later /bin/sh "$SELF" continue "$id"
  done
)

answer_slot() {
  id=$1
  echo "slot=$id"
  echo "user=$(slot_user "$id")"
  echo "uid=$(slot_uid "$id")"
  echo "home=/Users/$(slot_user "$id")"
  echo "model=$(field "$(slot_dir "$id")/device" model)"
  echo "udid=$(device_udid "$id")"
  echo "ports=$(port_base "$id")"
  echo "port_count=$PORT_COUNT"
  [ ! -f "$(slot_dir "$id")/timings" ] || echo "took=$(awk '{ printf "%s%s %s", (NR > 1 ? "," : ""), $1, $2 }' "$(slot_dir "$id")/timings")"
}

write_settings() {
  for pair in "most=$most" "ahead=$ahead" "resetting-most=$resetting_most" "disk-reserve-gib=$disk_reserve_gib"; do
    [ -z "${pair#*=}" ] || number "${pair#*=}" || quit 2 "${pair%%=*} must be a whole number."
  done
  [ -z "$most" ] || [ "$most" -ge 1 ] || quit 2 "most must be at least 1."
  [ -z "$resetting_most" ] || [ "$resetting_most" -ge "$RESETTING_MOST_LEAST" ] || quit 2 "resetting-most must be at least $RESETTING_MOST_LEAST."
  made=$(field "$HOST/settings" made)
  printf 'most=%s\nahead=%s\nresetting-most=%s\ndisk-reserve-gib=%s\nmade=%s\n' \
    "${most:-$(setting most)}" "${ahead:-$(setting ahead)}" "${resetting_most:-$(setting resetting-most)}" "${disk_reserve_gib:-$(setting disk-reserve-gib)}" "${made:-$(now)}" |
    put "$HOST/settings"
}

mark_closed() {
  closed || printf 'since=%s\n' "$(now)" | put "$CLOSED_MARK"
}

init() {
  read_input "most ahead resetting-most disk-reserve-gib kept"
  case $kept in '' | yes) ;; *) quit 2 "kept= is yes, or left out." ;; esac
  lock_host 60
  mkdir -p "$HOST/slots" "$HOST/promises" "$HOST/sweep"
  if [ "$kept" = yes ] && ! kept_host; then
    initialised && quit 2 "This host was set up to be deleted with its last box, so it cannot be kept."
    [ -z "$(slot_ids)" ] || quit 2 "This host has slots already, so it cannot be kept."
    mark_closed
    : >"$KEPT_MARK"
    CARRIED_SLOTS=''
  fi
  initialised || write_settings
  number "$(cat "$HOST/generation" 2>/dev/null)" || echo 0 | put "$HOST/generation"
  host_daemon_plists
  keep_host_daemons_loaded || fail "launchd did not load the host's daemons."
  for key in most ahead resetting-most disk-reserve-gib; do echo "$key=$(setting "$key")"; done
  if kept_host; then echo kept=yes && echo "closed=$(closed && echo yes || echo no)"; fi
}

refuse_unless_kept() {
  kept_host || quit 2 "$1 is only for a kept host, such as the pool's Mac. This host is deleted with its last box."
}

open_host() {
  read_input "install most ahead resetting-most disk-reserve-gib"
  lock_host 60
  refuse_unless_kept "open"
  write_settings
  rm -f "$CLOSED_MARK"
  host_daemon_plists
  keep_host_daemons_loaded || fail "launchd did not load the held ports' daemon."
  top_up ''
  echo open=yes
  for key in most ahead resetting-most disk-reserve-gib; do echo "$key=$(setting "$key")"; done
}

slots_in() {
  n=0
  for id in $(slot_ids); do [ "$(state "$id" is)" = "$1" ] && n=$((n + 1)); done
  echo "$n"
}

waiting_boxes() {
  n=$(live_promises | grep -c .)
  for id in $(slot_ids); do [ "$(state "$id" is)" = making ] && [ -n "$(state "$id" for)" ] && n=$((n + 1)); done
  echo "$n"
}

close_host() {
  read_input "install"
  lock_host 60
  refuse_unless_kept "close"
  if others_keep_the_host ''; then
    echo "held=$(slots_in held)"
    echo "waiting=$(waiting_boxes)"
    quit "$EXIT_LENDING" "This host is lending slots: $(slots_in held) held, and $(waiting_boxes) promised or being made for a box."
  fi
  mark_closed
  unload_daemon "$PORTS_LABEL"
  spares=''
  for id in $(slot_ids); do
    [ "$(state "$id" is)" = ready ] || continue
    set_state "$id" is=resetting step=processes "after=the host closed"
    spares="$spares $id"
  done
  unlock_host
  for id in $spares; do (carry_on "$id") >/dev/null 2>&1; done
  echo closed=yes
  echo "removed=$(echo $spares)"
}

summary() {
  [ $# -eq 0 ] || quit 2 "usage: device-host summary"
  echo "helper=$VERSION"
  if kept_host; then echo kept=1; else echo kept=0; fi
  echo "closed=$(field "$CLOSED_MARK" since)"
  if deleting; then echo "deleting=$(field "$HOST/deleting" since)"; else echo deleting=; fi
  for key in most ahead resetting-most disk-reserve-gib; do echo "$key=$(setting "$key")"; done
  echo "counted=$(counted)"
  for is in held ready making releasing resetting; do echo "$is=$(slots_in "$is")"; done
  echo "waiting=$(waiting_boxes)"
  echo "sweeping=$(sweep_queue | wc -l | tr -d ' ')"
  line=$(runtime_line)
  list=$(printf '%s\n' "$line" | cut -f 4)
  printf 'runtime=%s\n' "$line"
  printf 'model=%s\n' "$(default_model | cut -f 1,2)"
  echo "companion=$(head -n 1 "$IOS_SHARE/companion" 2>/dev/null)"
  if [ -n "$list" ] && [ -s "$IOS_SHARE/$list.txt" ]; then
    echo "labels=$(grep -c . "$IOS_SHARE/$list.txt")"
    echo "list_sha256=$(shasum -a 256 "$IOS_SHARE/$list.txt" </dev/null 2>/dev/null | cut -d ' ' -f 1)"
  fi
}

make() {
  read_input "install box server"
  [ -z "$box" ] || box_word_or_quit "$box" "make"
  resume >/dev/null
  lock_host 60
  refuse_if_deleting
  room_or_quit "$box"
  id=$(($(generation) + 1))
  echo "$id" | put "$HOST/generation"
  new_slot "$id" "$(free_place)" "$box" host "$server"
  drop_promise "$box"
  unlock_host
  carry_on "$id"
  [ "$(state "$id" is)" = ready ] || fail "Slot $id is $(state "$id" is), not ready."
  answer_slot "$id"
}

carry() {
  [ ! -t 0 ] || exec </dev/null
  read_input ""
  lock_host 60
  kept_host && quit 2 "A kept host, such as the pool's Mac, has no carried slots."
  mkdir -p "$HOST/slots"
  place=0
  for id in $CARRIED_SLOTS; do
    if [ ! -f "$(slot_dir "$id")/slot" ] && ! grep -qx "$id" "$HOST/carried" 2>/dev/null; then
      new_slot "$id" "$place" '' carry ''
    fi
    grep -qx "$id" "$HOST/carried" 2>/dev/null || echo "$id" >>"$HOST/carried"
    place=$((place + 1))
  done
  unlock_host
  for id in $CARRIED_SLOTS; do
    [ -f "$(slot_dir "$id")/slot" ] || continue
    carry_on "$id"
    case $(state "$id" is) in
      '') continue ;;
      making) fail "Carried slot $id is not made: it is making, at its $(state "$id" step) step." ;;
    esac
    echo "carried=$id $(slot_user "$id") $(slot_uid "$id") $(device_udid "$id") $(awk '{ printf "%s%s %s", (NR > 1 ? "," : ""), $1, $2 }' "$(slot_dir "$id")/timings")"
  done
}

promise() {
  read_input "install box"
  box_word_or_quit "$box" "promise"
  lock_host 60
  refuse_if_deleting
  if [ ! -f "$HOST/promises/$box" ]; then
    room_or_quit "$box"
    mkdir -p "$HOST/promises"
    printf 'install=%s\nbox=%s\nsince=%s\n' "$install" "$box" "$(now)" | put "$HOST/promises/$box"
  fi
  echo "promised=$box"
}

mark_deleting() {
  printf 'since=%s\nslot=%s\nbox=%s\n' "$(now)" "$1" "$2" | put "$HOST/deleting"
}

decide_empty() {
  if deleting; then
    echo last=yes
  elif others_keep_the_host ''; then
    echo last=no
  elif kept_host; then
    echo last=yes
  else
    mark_deleting '' "$1"
    echo last=yes
  fi
}

unpromise() {
  read_input "install box"
  box_word_or_quit "$box" "unpromise"
  lock_host 60
  drop_promise "$box"
  echo "unpromised=$box"
  decide_empty "$box"
}

vacate() {
  read_input "install"
  lock_host 60
  decide_empty ''
}

restart() {
  id=${1:-}
  slot_or_quit "$id" restart
  read_input "install box"
  box_word_or_quit "$box" "The restart"
  dir=$(slot_dir "$id")
  lock_host 60
  [ "$(state "$id" is)" = held ] || quit "$EXIT_NOT_OURS" "Slot $id is $(state "$id" is): no box holds it."
  [ "$(field "$dir/claim" install)" = "$install" ] && [ "$(field "$dir/claim" box)" = "$box" ] || quit "$EXIT_NOT_OURS" "Another box holds slot $id."
  unlock_host
  label=$DEVICE_LABEL.$(slot_user "$id")
  launchctl print "system/$label" >/dev/null 2>&1 || fail "Slot $id's device server daemon is not loaded."
  launchctl kickstart -k "system/$label" >/dev/null 2>&1 || fail "launchd did not start slot $id's device server again."
  echo "restarted=$id"
}

lend() {
  id=$1 key=$2 kind=$3 from=$4
  user=$(slot_user "$id") uid=$(slot_uid "$id")
  home=$(home_of "$id")
  [ ! -L "$home/.ssh" ] && [ ! -L "$home/.ssh/authorized_keys" ] || { echo "$user's .ssh is a link." >&2; return 1; }
  mkdir -p "$home/.ssh" && printf '%s\n' "$key" >"$home/.ssh/authorized_keys" &&
    chmod 700 "$home/.ssh" && chmod 600 "$home/.ssh/authorized_keys" && chown -R "$uid:20" "$home/.ssh" || return 1
  if [ "$kind" = macos ]; then
    unload_daemon "$DEVICE_LABEL.$user"
    rm -f "$(slot_dir "$id")/daemons/$DEVICE_LABEL.$user.plist"
    simctl "$user" shutdown all >/dev/null 2>&1
    simctl "$user" delete all >/dev/null 2>&1 || return 1
    rm -f "$(slot_dir "$id")/device"
    return 0
  fi
  copy_server "$id" "$from" || return 1
  [ -e "$(slot_dir "$id")/loaded" ] || load_slot_daemons "$id"
}

warm_carried_after() {
  for other in $CARRIED_SLOTS; do
    [ "$other" = "$1" ] && continue
    [ "$(state "$other" is)" = ready ] && [ ! -e "$(slot_dir "$other")/loaded" ] || continue
    later /bin/sh "$SELF" warm "$other"
  done
}

claim() {
  id=${1:-}
  slot_or_quit "$id" claim
  read_input "install box thread name kind created key server"
  box_word_or_quit "$box" "The claim"
  case $key in
    "ssh-ed25519 "* | "ssh-rsa "* | "ecdsa-sha2-"* | "sk-ssh-ed25519@openssh.com "* | "sk-ecdsa-sha2-"*) ;;
    *) quit 2 "The claim needs key=, an OpenSSH public key." ;;
  esac
  case ${kind:-ios} in ios | macos) kind=${kind:-ios} ;; *) quit 2 "A slot lends kind ios or macos, not $kind." ;; esac
  dir=$(slot_dir "$id")
  lock_host 30
  refuse_if_deleting
  [ -f "$dir/slot" ] || quit "$EXIT_LOST" "This host has no slot $id; ask again."
  is=$(state "$id" is)
  [ "$is" = ready ] || quit "$EXIT_NOT_READY" "Slot $id is $is, not ready."
  printf 'install=%s\nbox=%s\nthread=%s\nname=%s\nkind=%s\ncreated=%s\nclaimed=%s\n' "$install" "$box" "$thread" "$name" "$kind" "$created" "$(now)" >"$dir/claim.new.$$"
  if ! ln "$dir/claim.new.$$" "$dir/claim" 2>/dev/null; then
    rm -f "$dir/claim.new.$$"
    quit "$EXIT_LOST" "Another box claimed slot $id; ask again."
  fi
  rm -f "$dir/claim.new.$$"
  set_state "$id" is=held "box=$box" "kind=$kind"
  drop_promise "$box"
  top_up "$server"
  unlock_host
  if ! take_lock 8 "$dir/lock" "$CLAIM_WARM_WAIT_S"; then
    lock_host 60
    rm -f "$dir/claim"
    set_state "$id" is=ready
    unlock_host
    fail "Slot $id's warm-up did not end within $CLAIM_WARM_WAIT_S s; ask again."
  fi
  if ! words=$(lend "$id" "$key" "$kind" "$server" 2>&1); then
    lock_host 60
    [ ! -f "$dir/claim" ] || mv -f "$dir/claim" "$dir/released"
    set_state "$id" is=resetting step=processes "box=$box" "after=lending failed"
    unlock_host
    exec 8>&-
    carry_on "$id" >/dev/null 2>&1
    fail "Could not lend slot $id, so it is removed: ${words:-it failed.}"
  fi
  exec 8>&-
  carried "$id" && warm_carried_after "$id"
  answer_slot "$id"
}

warm() {
  id=${1:-}
  slot_or_quit "$id" warm
  dir=$(slot_dir "$id")
  take_lock 8 "$dir/lock" 0 || exit 0
  [ "$(state "$id" is)" = ready ] && [ ! -e "$dir/loaded" ] || exit 0
  boot_device "$id" || fail "Could not boot slot $id's device."
  load_slot_daemons "$id" || fail "Could not load slot $id's daemons."
  echo "warmed=$id"
}

decide_last() (
  id=$1 box=$2
  dir=$(slot_dir "$id")
  [ ! -f "$dir/claim" ] || mv -f "$dir/claim" "$dir/released"
  [ ! -f "$dir/last" ] || return 0
  if others_keep_the_host "$id"; then
    echo no | put "$dir/last"
    top_up ''
  elif kept_host; then
    echo yes | put "$dir/last"
    top_up ''
  else
    mark_deleting "$id" "$box"
    echo yes | put "$dir/last"
  fi
)

release() {
  id=${1:-}
  slot_or_quit "$id" release
  read_input "install box"
  box_word_or_quit "$box" "The release"
  dir=$(slot_dir "$id")
  lock_host 60
  if [ ! -f "$dir/slot" ]; then
    echo released=already
    if deleting; then echo last=yes; else echo last=no; fi
    exit 0
  fi
  is=$(state "$id" is)
  case $is in
    held)
      holder=$dir/claim
      [ -f "$holder" ] || holder=$dir/released
      [ "$(field "$holder" install)" = "$install" ] || quit "$EXIT_NOT_OURS" "Another bb-box install holds slot $id."
      [ "$(field "$holder" box)" = "$box" ] || quit "$EXIT_NOT_OURS" "Another box holds slot $id."
      set_state "$id" is=releasing "box=$box"
      decide_last "$id" "$box"
      ;;
    releasing)
      [ "$(field "$dir/released" box)" = "$box" ] || [ "$(state "$id" box)" = "$box" ] || quit "$EXIT_NOT_OURS" "Slot $id was released for another box."
      decide_last "$id" "$box"
      ;;
    resetting)
      [ "$(field "$dir/released" box)" = "$box" ] || [ "$(state "$id" box)" = "$box" ] || quit "$EXIT_NOT_OURS" "Slot $id was released for another box."
      ;;
    *) quit "$EXIT_NOT_OURS" "Slot $id is $is: no box holds it." ;;
  esac
  unlock_host
  carry_on "$id"
  echo released=yes
  echo "last=$(cat "$dir/last" 2>/dev/null || echo no)"
}

ipc_objects() {
  for t in m q s; do
    ipcs -"$t" 2>/dev/null | awk -v t="$t" '$1 == t { print t, $2, $5 }'
  done
}

remove_ipc() {
  uid=$1
  all_slot_uids "$uid" || return 1
  user=$(slot_user "$(slot_of_uid "$uid")")
  ipc_objects | while read -r t object owner; do
    [ "$owner" = "$user" ] || [ "$owner" = "$uid" ] || continue
    ipcrm -"$t" "$object" 2>/dev/null
  done
}

sweep_pass() {
  root=$1
  shift
  [ $# -gt 0 ] && all_slot_uids "$@" || return 1
  first=1
  for uid; do
    if [ "$first" = 1 ]; then set -- "$@" "("; first=0; else set -- "$@" -o; fi
    set -- "$@" -uid "$uid"
    shift
  done
  set -- "$@" ")"
  background find "$root" -xdev "$@" -prune -exec sh -c '
    for path; do printf "found %s\n" "$path"; done
    chflags -R nouchg,nouappnd "$@" 2>/dev/null
    rm -rf "$@" 2>/dev/null
    for path; do if [ -e "$path" ] || [ -L "$path" ]; then printf "left %s\n" "$path"; fi; done' sh {} + 2>/dev/null
  return 0
}

log_out_again() {
  all_slot_uids "$1" || return 1
  launchctl bootout "user/$1" >/dev/null 2>&1
  tries=0
  while pgrep -u "$1" >/dev/null 2>&1 && [ "$tries" -lt 25 ]; do
    pkill -KILL -u "$1" >/dev/null 2>&1
    tries=$((tries + 1))
    sleep 0.2
  done
}

sweep_queue() {
  for file in "$HOST"/sweep/*; do
    uid=${file##*/}
    [ -f "$file" ] && [ ! -L "$file" ] && slot_uid_allowed "$uid" && echo "$uid"
  done | sort -n
}

sweep_waiting() {
  for file in "$HOST"/sweep/*; do
    [ -e "$file" ] || [ -L "$file" ] && return 0
  done
  return 1
}

sweep_file_sound() {
  file=$1 uid=${1##*/}
  [ -f "$file" ] && [ ! -L "$file" ] && slot_uid_allowed "$uid" || return 1
  id=$(field "$file" slot)
  number "$id" || carried "$id" || return 1
  [ "$(slot_uid "$id")" = "$uid" ] && [ "$(field "$file" user)" = "$(slot_user "$id")" ]
}

refuse_unsound_sweep_files() {
  for file in "$HOST"/sweep/*; do
    [ -e "$file" ] || [ -L "$file" ] || continue
    sweep_file_sound "$file" && continue
    rm -f "$file"
    echo "refused=${file##*/}: not a slot's UID with its own slot and user"
  done
}

reset() {
  [ $# -eq 0 ] || quit 2 "usage: device-host reset"
  [ ! -t 0 ] || exec </dev/null
  read_input "install"
  while :; do
    take_lock 7 "$HOST/sweep.lock" 0 || { echo sweeping=elsewhere; exit 0; }
    while :; do
      refuse_unsound_sweep_files
      uids=$(sweep_queue | head -n "$(setting resetting-most)")
      [ -n "$uids" ] || break
      started=$(precise_now)
      out=$(sweep_pass "$DATA" $uids)
      for uid in $uids; do log_out_again "$uid"; done
      out=$(printf '%s\n' "$out"; sweep_pass "$DATA/private/var/folders" $uids)
      took=$(seconds_since "$started")
      found=$(printf '%s\n' "$out" | grep -c '^found ')
      left=$(printf '%s\n' "$out" | grep -c '^left ')
      for uid in $uids; do
        id=$(slot_of_uid "$uid")
        remove_ipc "$uid"
        lock_host 60
        [ "$(state "$id" is):$(state "$id" step)" != resetting:sweep ] || rm -rf "$(slot_dir "$id")"
        rm -f "$HOST/sweep/$uid"
        printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$uid" "$(echo $uids | wc -w | tr -d ' ')" "$found" "$left" "$took" "$(now)" >>"$HOST/sweeps"
        tail -n "$SWEEPS_KEPT" "$HOST/sweeps" | put "$HOST/sweeps"
        unlock_host
      done
      echo "swept=$(echo $uids | tr ' ' ',') found=$found left=$left seconds=$took"
    done
    exec 7>&-
    [ -n "$(sweep_queue)" ] || break
  done
}

newest_installer_daemon() {
  home=$1 uid=$2 user=$3
  users_folder "$home/.bb-machines" "$uid" || return 1
  for dir in "$home"/.bb-machines/*; do
    users_folder "$dir" "$uid" && users_own "$dir/install-daemon.pid" "$uid" || continue
    pid=$(as_user "$user" cat "$dir/install-daemon.pid" 2>/dev/null)
    number "$pid" || continue
    [ "$(ps -o uid= -p "$pid" 2>/dev/null | tr -d ' ')" = "$uid" ] || continue
    echo "$dir $pid"
    return 0
  done
  return 1
}

slot_log() { echo "$SLOT_LOGS/$1.log"; }
make_slot_log() {
  user=$1 uid=$2
  log=$(slot_log "$user")
  mkdir -p "$SLOT_LOGS" && [ -d "$SLOT_LOGS" ] && [ ! -L "$SLOT_LOGS" ] && chown root:wheel "$SLOT_LOGS" && chmod 755 "$SLOT_LOGS" || return 1
  { [ -f "$log" ] && [ ! -L "$log" ]; } || { rm -f "$log" && : >"$log"; } || return 1
  chown "$uid:20" "$log" && chmod 644 "$log"
}

daemon() {
  id=${1:-}
  slot_or_quit "$id" daemon
  read_input "install box"
  box_word_or_quit "$box" "The daemon"
  dir=$(slot_dir "$id")
  lock_host 60
  [ "$(state "$id" is)" = held ] && [ "$(field "$dir/claim" box)" = "$box" ] && [ "$(field "$dir/claim" install)" = "$install" ] ||
    quit "$EXIT_NOT_OURS" "Box $box does not hold slot $id."
  unlock_host
  user=$(slot_user "$id") uid=$(slot_uid "$id")
  home=$(home_of "$id")
  found=$(newest_installer_daemon "$home" "$uid" "$user") || fail "BB's installer left no daemon running as $user: run BB's command with BB_INSTALL_SKIP_SERVICE=1 first."
  data=${found% *} pid=${found##* }
  port=''
  ! users_own "$data/host-daemon-port" "$uid" || port=$(as_user "$user" cat "$data/host-daemon-port" 2>/dev/null)
  number "$port" || fail "BB's installer left no daemon port in ${data#"$ROOT"}."
  command=$(ps -ww -o command= -p "$pid" 2>/dev/null)
  [ -n "$command" ] || fail "BB's daemon, process $pid, ended before the helper read its command."
  set --
  set -f
  for word in $command; do [ "$word" = --supervise ] || set -- "$@" "$word"; done
  set +f
  case $1 in
    /*) ;;
    *)
      program=$(PATH=$DAEMON_PATH command -v "$1") || fail "BB's daemon runs $1, which is not in $DAEMON_PATH."
      shift
      set -- "$program" "$@"
      ;;
  esac
  case " $* " in *" --host-daemon-port "*) ;; *) set -- "$@" --host-daemon-port "$port" ;; esac
  label=$BB_LABEL.$user
  mkdir -p "$dir/daemons"
  log=$(slot_log "$user")
  make_slot_log "$user" "$uid" || fail "Could not make ${log#"$ROOT"} for BB's daemon."
  {
    plist_head
    plist_string Label "$label"
    plist_string UserName "$user"
    plist_string GroupName staff
    plist_environment HOME "/Users/$user" USER "$user" LOGNAME "$user" PATH "$DAEMON_PATH" BB_DATA_DIR "${data#"$ROOT"}" BB_APP_NPM_PREFIX "${data#"$ROOT"}/npm" \
      BB_PORT_BASE "$(port_base "$id")" BB_PORT_COUNT "$PORT_COUNT"
    plist_arguments "$@"
    plist_string WorkingDirectory "/Users/$user"
    printf '  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>ThrottleInterval</key><integer>2</integer>\n'
    plist_string StandardOutPath "${log#"$ROOT"}"
    plist_string StandardErrorPath "${log#"$ROOT"}"
    plist_tail
  } | put "$dir/daemons/$label.plist"
  as_user "$user" kill -TERM "$pid" 2>/dev/null
  waited=0
  while kill -0 "$pid" 2>/dev/null; do
    waited=$((waited + 1))
    [ "$waited" -lt 50 ] || { as_user "$user" kill -KILL "$pid" 2>/dev/null; break; }
    sleep 0.2
  done
  load_daemon "$dir/daemons/$label.plist" || fail "launchd did not load BB's daemon for $user."
  echo "daemon=$label"
  echo "port=$port"
}

stale_work() {
  for id in $(slot_ids); do
    case $(state "$id" is):$(state "$id" step) in
      making:* | releasing:* | resetting:processes | resetting:user) held_elsewhere "$(slot_dir "$id")/lock" || echo "$id" ;;
    esac
  done
}

clear_bb_state_after_boot() {
  boot=$(boot_id)
  [ "$(cat "$HOST/resumed-boot" 2>/dev/null)" != "$boot" ] || return 0
  mkdir -p "$HOST"
  for id in $(slot_ids); do
    user=$(slot_user "$id") uid=$(slot_uid "$id") home=$(home_of "$id")
    users_folder "$home/.bb-machines" "$uid" || continue
    for data in "$home"/.bb-machines/*; do
      users_folder "$data" "$uid" || continue
      as_user "$user" rm -rf "$data/daemon.lock.lock" "$data/install-daemon.pid"
    done
  done
  echo "$boot" | put "$HOST/resumed-boot"
}

resume() {
  [ ! -t 0 ] || exec </dev/null
  clear_bb_state_after_boot
  for id in $(stale_work); do later /bin/sh "$SELF" continue "$id"; done
  if sweep_waiting && ! held_elsewhere "$HOST/sweep.lock"; then later /bin/sh "$SELF" reset; fi
  echo "resumed=$(stale_work | wc -l | tr -d ' ')"
}

continue_slot() {
  id=${1:-}
  slot_or_quit "$id" continue
  [ -f "$(slot_dir "$id")/slot" ] || quit "$EXIT_LOST" "This host has no slot $id."
  carry_on "$id"
  echo "slot=$id"
  echo "is=$(state "$id" is)"
}

booted_devices() {
  ps -ww -axo uid=,pid=,command= 2>/dev/null | awk '/launchd_sim/ {
    if (match($0, /\/Devices\/[0-9A-F-][0-9A-F-]*\//)) print $1, $2, substr($0, RSTART + 9, RLENGTH - 10)
  }'
}

bound_devices() {
  seen=$(booted_devices)
  for id in $(slot_ids); do
    uid=$(slot_uid "$id") dir=$(slot_dir "$id")
    mine=$(printf '%s\n' "$seen" | awk -v u="$uid" '$1 == u' | sort -k 2 -n)
    count=$(printf '%s\n' "$mine" | grep -c .)
    if [ "$count" -le 1 ]; then rm -f "$dir/second-device"; continue; fi
    since=$(field "$dir/second-device" since)
    if ! number "$since"; then
      printf 'since=%s\ncount=%s\n' "$(now)" "$count" | put "$dir/second-device"
      continue
    fi
    [ $(($(now) - since)) -ge "$SECOND_DEVICE_MOST_S" ] || continue
    own=$(device_udid "$id")
    printf '%s\n' "$mine" | grep -qw "$own" || own=$(printf '%s\n' "$mine" | head -n 1 | cut -d ' ' -f 3)
    for udid in $(printf '%s\n' "$mine" | cut -d ' ' -f 3); do
      [ "$udid" = "$own" ] && continue
      simctl "$(slot_user "$id")" shutdown "$udid" >/dev/null 2>&1
      printf 'A second device, %s, was booted in slot %s for %s minutes, so it was shut down at %s.\n' "$udid" "$id" $((SECOND_DEVICE_MOST_S / 60)) "$(date -u +%H:%M)" | put "$dir/second-device-words"
    done
    rm -f "$dir/second-device"
  done
}

watch() {
  [ ! -t 0 ] || exec </dev/null
  tick=0
  while :; do
    bound_devices
    if [ $((tick % 12)) = 0 ] && sweep_waiting && ! held_elsewhere "$HOST/sweep.lock"; then later /bin/sh "$SELF" reset; fi
    tick=$((tick + 1))
    sleep "$WATCH_EVERY_S"
  done
}

run() {
  initialised || exit 0
  resume
  watch
}

home_kib() {
  id=$1 dir=$(slot_dir "$1")
  cached=$(cat "$dir/home-kib" 2>/dev/null)
  at=${cached#* }
  if ! number "$at" || [ $(($(now) - at)) -ge "$HOME_SIZE_EVERY_S" ]; then
    if [ ! -e "$dir/measuring" ] || [ $(($(now) - $(cat "$dir/measuring" 2>/dev/null || echo 0))) -ge 120 ]; then
      now >"$dir/measuring"
      later /bin/sh "$SELF" measure "$id"
    fi
  fi
  echo "${cached%% *}"
}

measure() {
  id=${1:-}
  slot_or_quit "$id" measure
  dir=$(slot_dir "$id")
  kib=$(background du -sk "$(home_of "$id")" 2>/dev/null | awk '{ print $1 }')
  [ -d "$dir" ] || exit 0
  number "$kib" && echo "$kib $(now)" | put "$dir/home-kib"
  rm -f "$dir/measuring"
}

memory_by_uid() {
  footprint=$(top -l 1 -n 100000 -stats uid,mem 2>/dev/null | awk '
    /^UID +MEM/ { table = 1; next }
    table && $1 ~ /^[0-9]+$/ { v = $2 + 0; if ($2 ~ /K/) v /= 1024; else if ($2 ~ /G/) v *= 1024; else if ($2 !~ /M/) v /= 1048576; mib[$1] += v }
    END { for (u in mib) printf "%s %d\n", u, mib[u] }')
  if [ -n "$footprint" ]; then
    echo "$footprint"
  else
    ps -axo uid=,rss= 2>/dev/null | awk '{ kib[$1] += $2 } END { for (u in kib) printf "%s %d\n", u, kib[u] / 1024 }'
  fi
}

status() {
  [ $# -eq 0 ] || quit 2 "usage: device-host status"
  echo "helper=$VERSION"
  echo "boot=$(boot_id)"
  if deleting; then echo "deleting=$(field "$HOST/deleting" since)"; else echo deleting=; fi
  if kept_host; then echo kept=1; else echo kept=0; fi
  echo "closed=$(field "$CLOSED_MARK" since)"
  for key in most ahead resetting-most disk-reserve-gib; do echo "$key=$(setting "$key")"; done
  echo "generation=$(cat "$HOST/generation" 2>/dev/null || echo 0)"
  echo "cores=$(sysctl -n hw.ncpu 2>/dev/null)"
  echo "memory=$(sysctl -n hw.memsize 2>/dev/null | awk '{ print int($1 / 1048576) }')"
  echo "disk=$(disk_free_gib)"
  echo "memory_free=$(memory_free_percent)"
  echo "runtime=$(runtime_line | cut -f 1)"
  echo "model=$(default_model | cut -f 1)"
  echo "counted=$(counted)"
  for box in $(live_promises); do printf 'promise=%s\t%s\t%s\n' "$box" "$(field "$HOST/promises/$box" install)" "$(field "$HOST/promises/$box" since)"; done
  for id in $(slot_ids); do
    claim=$(slot_dir "$id")/claim
    [ -f "$claim" ] || continue
    printf 'claim=%s' "$id"
    for key in install box thread name kind created; do printf '\t%s' "$(field "$claim" "$key" | tr -d '\t')"; done
    echo
  done
  cores=$(ps -axo uid=,pcpu= 2>/dev/null | awk '{ cpu[$1] += $2 } END { for (u in cpu) printf "%s %.2f\n", u, cpu[u] / 100 }')
  memory=$(memory_by_uid)
  booted=$(booted_devices)
  for id in $(slot_ids); do
    dir=$(slot_dir "$id") uid=$(slot_uid "$id")
    is=$(state "$id" is) place=$(fact "$id" place)
    [ -n "$is" ] && [ -n "$place" ] || continue
    udid=$(device_udid "$id")
    slot_cores=$(printf '%s\n' "$cores" | awk -v u="$uid" '$1 == u { print $2 }')
    slot_memory=$(printf '%s\n' "$memory" | awk -v u="$uid" '$1 == u { print $2 }')
    devices=$(printf '%s\n' "$booted" | awk -v u="$uid" '$1 == u' | grep -c .)
    up=0
    [ -z "$udid" ] || ! printf '%s\n' "$booted" | grep -qw "$udid" || up=1
    loaded=0
    [ ! -e "$dir/loaded" ] || loaded=1
    kib=''
    user_made "$id" 2>/dev/null && kib=$(home_kib "$id")
    box=$(state "$id" box)
    printf 'slot=%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$(slot_user "$id")" "$uid" "$(fact "$id" carried)" $((PORT_FIRST + PORT_COUNT * place)) \
      "$is" "$(state "$id" step)" "$box" "$(state "$id" for)" "$(state "$id" since)" "$(field "$dir/device" model)" "$udid" "$up" "$loaded" \
      "${slot_cores:-0}" "${slot_memory:-0}" "${kib:+$((kib / 1024))}"
    [ "$devices" -le 1 ] || printf 'devices=%s\t%s\t%s\n' "$id" "$devices" "$(field "$dir/second-device" since)"
    [ ! -s "$dir/second-device-words" ] || printf 'device_words=%s\t%s\n' "$id" "$(cat "$dir/second-device-words")"
  done
  echo "sweeping=$(sweep_queue | wc -l | tr -d ' ')"
  [ ! -f "$HOST/sweeps" ] || sed 's/^/sweep=/' "$HOST/sweeps"
}

host_daemon_plists() {
  {
    plist_head
    plist_string Label "$HOST_LABEL"
    plist_arguments /bin/sh "$INSTALLED" run
    printf '  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n  <key>ThrottleInterval</key><integer>10</integer>\n'
    plist_string StandardErrorPath /var/log/bb-box-device-host.log
    plist_tail
  } | put "$HOST/$HOST_LABEL.plist"
  {
    plist_head
    plist_string Label "$PORTS_LABEL"
    plist_string UserName nobody
    plist_arguments /usr/bin/perl "$PORTS_PROGRAM" $HELD_PORTS
    printf '  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>ThrottleInterval</key><integer>5</integer>\n'
    plist_tail
  } | put "$HOST/$PORTS_LABEL.plist"
}

ports_held_here() { ! kept_host || ! closed; }

keep_host_daemons_loaded() {
  if ports_held_here; then keep_loaded "$HOST/$PORTS_LABEL.plist" || return 1; else unload_daemon "$PORTS_LABEL"; fi
  keep_loaded "$HOST/$HOST_LABEL.plist"
}

unload_host_daemons() {
  unload_daemon "$HOST_LABEL"
  unload_daemon "$PORTS_LABEL"
}

install() {
  [ $# -eq 0 ] || quit 2 "usage: device-host install"
  mkdir -p "$HOST/slots" "$HOST/promises" "$HOST/sweep"
  chmod 700 "$HOST"
  host_daemon_plists
  echo "written=$HOST_LABEL $PORTS_LABEL"
  if initialised && ! ports_held_here; then
    unload_daemon "$PORTS_LABEL"
    load_daemon "$HOST/$HOST_LABEL.plist" || fail "launchd did not load the helper's daemon."
    echo "loaded=$HOST_LABEL"
    echo "held_ports="
  elif initialised; then
    load_daemon "$HOST/$PORTS_LABEL.plist" || fail "launchd did not load the held ports' daemon."
    load_daemon "$HOST/$HOST_LABEL.plist" || fail "launchd did not load the helper's daemon."
    echo "loaded=$HOST_LABEL $PORTS_LABEL"
    echo "held_ports=$HELD_PORTS"
  else
    unload_host_daemons
    echo "loaded="
    echo "held_ports="
  fi
}

[ "$(id -u)" = 0 ] || quit 2 "Run it as root, through sudo."
command -v perl >/dev/null 2>&1 || quit 1 "perl is missing, and the helper locks with it."
verb=${1:-}
[ $# -eq 0 ] || shift
case $verb in
  init) init ;;
  install) install "$@" ;;
  status) status "$@" ;;
  summary) summary "$@" ;;
  open) open_host ;;
  close) close_host ;;
  make) make ;;
  carry) carry ;;
  promise) promise ;;
  unpromise) unpromise ;;
  vacate) vacate ;;
  restart) restart "$@" ;;
  claim) claim "$@" ;;
  warm) warm "$@" ;;
  release) release "$@" ;;
  reset) reset "$@" ;;
  daemon) daemon "$@" ;;
  resume) resume ;;
  continue) continue_slot "$@" ;;
  bound) bound_devices ;;
  watch) watch ;;
  run) run ;;
  measure) measure "$@" ;;
  version) echo "$VERSION" ;;
  *) quit 2 "usage: device-host status | summary | init | install | open | close | make | carry | promise | unpromise | vacate | claim <slot> | release <slot> | restart <slot> | reset | daemon <slot> | resume | version" ;;
esac
