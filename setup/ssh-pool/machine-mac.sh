#!/bin/sh
# bb-box's helper on a Mac in the SSH host pool (047). bb-box's admin user
# runs it through sudo, and runs nothing else as root. It has the commands,
# input, output and exit codes of the Linux helper, machine.sh, and one more,
# display. setup-mac.sh installs it as /usr/local/libexec/bb-box/machine.
#
#   machine status [grants | xcode]
#                                 grants: also Cua Driver's grants, and whether a viewer's input
#                                 posts, which take seconds
#                                 xcode: finds Xcode's Simulator runtimes again, which takes seconds
#   machine claim <generation>    stdin: install, box, thread, name, kind, created, key
#   machine release <generation>  stdin: install, and box unless the box is not known
#   machine reset                 stdin: install, or nothing when an operator runs it
#   machine display <generation>  stdin: install, box
#   machine grant                 stdin: install, box, program, permission (repeated), target
#   machine granted <generation>  stdin: install, box
#
# A Mac VM that is itself the box, as Tart's are, runs the helper from bb-box
# through sudo with 3 more commands, for its user, with no owner marker and
# no reset, as the VM goes with the box:
#
#   machine vm-ready <user>       the user's signing identity, the microphone and
#                                 camera for its commands, and screen capture's
#                                 approvals; says signing=
#   machine vm-grant <user>       stdin: program, permission (repeated), target
#   machine vm-granted <user>     as granted
#   machine init
#   machine version
#
# Input on stdin is one name=value per line. The state lives in /var/db/bb-box:
#
#   generation   completed resets, written last by each reset
#   owner        the box that holds the Mac; made with ln, so one claim wins
#   resetting    the owner marker, renamed when its reset starts
#   passwords/   each box user's password, which only root can read
#   signin       how the reset is signing the next user in, and since when
#   signs-in-by  the way that signed the last user in, which the next reset tries first
#   xcode        Xcode's version and Simulator runtimes, as `status xcode` last found them
#
# Each box gets a new standard user, bbx-<generation>, whose UID is 70000
# plus the generation modulo 10000. It is hidden from the login window and in
# the _developer group, and its home is macOS's template with bb-box's,
# /usr/local/share/bb-box/home, on top. The reset makes the next box's user
# ahead and signs it in, so a free Mac has it at the console:
#
# 1. It makes the next user, with a random password, and sets it as the
#    automatic login, so that macOS does not sign an old user in again.
# 2. It logs the old box users out and ends their processes.
# 3. It starts loginwindow again, which signs the next user in.
# 4. It removes the old users' crontabs, at jobs, System V IPC objects, sudo
#    rules, managed preferences, places in groups and every file they own on
#    the Data volume, then the users.
#    Some folders a user's first sign-in makes, such as ~/Library/Mail, are
#    protected: root removes them only with Full Disk Access, which SSH
#    sessions have when Remote Login allows it, or with System Integrity
#    Protection off.
# 5. It checks that nothing of theirs is left and that the next user is at
#    the console, then moves the generation on.
#
# loginwindow signs a user in only when it starts. The reset restarts
# loginwindow alone first, or userspace on macOS 27 and later, where
# restarting loginwindow alone does not sign the user in. If that does not
# sign the user in within its time, it tries userspace, then the whole Mac,
# and until the user is at the console it reports the reset as still running
# (exit 10). It remembers which way worked, and starts with it next time.
#
# The password is for Screen Sharing, which the relay signs in to as the box
# user: display prints it, and nothing else does. sysadminctl and the
# automatic login read it on stdin, so it is never in a command's arguments.
#
# Exit codes: 0 done; 1 failed, with the reason on stderr; 2 usage; 3 another
# box holds the Mac; 4 not this box's, so release does nothing; 5 not clean,
# with the reason on stderr; 6 the generation moved on; 10 the reset is still
# signing the next user in.

set -u
umask 022
PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin
LC_ALL=C
export PATH LC_ALL

# Empty on a Mac. The tests set it to a directory laid out as a Mac's, to run the helper on Linux with stub macOS tools.
ROOT=

VERSION=1
STATE=$ROOT/var/db/bb-box
TEMPLATE=$ROOT/usr/local/share/bb-box/home
# Cua Driver's bundle ID, which macOS keys its screen-capture approval by.
CUA_BUNDLE=com.trycua.driver
# The Data volume, where everything a box can write is. /Users, /private and the like are firmlinks to it.
DATA=$ROOT/System/Volumes/Data
LOGINWINDOW=/Library/Preferences/com.apple.loginwindow
# Only a process with Full Disk Access can read it.
TCC="/Library/Application Support/com.apple.TCC/TCC.db"
CUA=/usr/local/bin/cua-driver
PREFIX=bbx-
ID_BASE=70000
ID_SPAN=10000
# _developer lets the debugger and Instruments run without a password. Where
# Remote Login or Screen Sharing allows only some users, their group exists,
# and box users join it.
JOINS="_developer com.apple.access_ssh com.apple.access_screensharing"

quit() {
  code=$1
  shift
  printf '%s\n' "$*" >&2
  exit "$code"
}
fail() { quit 1 "$@"; }
field() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -n 1; }
generation() { cat "$STATE/generation" 2>/dev/null; }
number() { case ${1:-} in '' | *[!0-9]*) return 1 ;; esac; }
box_uid() { number "${1:-}" && [ "$1" -ge "$ID_BASE" ] && [ "$1" -lt $((ID_BASE + ID_SPAN)) ]; }
now() { date +%s; }
# Writes stdin to a file in one step.
put() { cat >"$1.new.$$" && mv -f "$1.new.$$" "$1"; }
# Changes when the Mac starts again.
boot_id() { sysctl -n kern.bootsessionuuid 2>/dev/null || echo unknown; }
# A user's attribute in the local directory, such as its UniqueID.
# dscl names an attribute outside Open Directory's standard set, such as
# IsHidden, with dsAttrTypeNative: before it.
attribute() { dscl . -read "/Users/$1" "$2" 2>/dev/null | sed -n -e "s/^$2: //p" -e "s/^dsAttrTypeNative:$2: //p" | head -n 1; }
# The people on the Mac whose homes box users can enter, space separated:
# users with a login shell, a UID from 500 to below the box users', not
# hidden, whose home others or the staff group, which box users are in, may
# enter. macOS makes a home drwxr-x--- for staff, so an administrator's
# credentials there, such as BB's or an agent CLI's, are readable by boxes.
open_homes() {
  dscl . -list /Users UniqueID 2>/dev/null | while read -r user uid; do
    number "$uid" && [ "$uid" -ge 500 ] && [ "$uid" -lt "$ID_BASE" ] || continue
    [ "$(attribute "$user" IsHidden)" != 1 ] || continue
    case $(attribute "$user" UserShell) in '' | /usr/bin/false | /sbin/nologin | /usr/sbin/nologin) continue ;; esac
    home=$(attribute "$user" NFSHomeDirectory)
    [ -n "$home" ] && [ -d "$ROOT$home" ] || continue
    mode=$(stat -f %Lp "$ROOT$home" 2>/dev/null) && number "$mode" || continue
    if [ $((0$mode & 1)) -ne 0 ] || { [ $((0$mode & 8)) -ne 0 ] && [ "$(stat -f %g "$ROOT$home" 2>/dev/null)" = 20 ]; }; then printf '%s\n' "$user"; fi
  done | paste -sd ' ' -
}

# Whether this helper has Full Disk Access.
full_disk() { head -c 1 "$ROOT$TCC" >/dev/null 2>&1; }
# The user at the console: root at the login window.
console() { stat -f %Su /dev/console 2>/dev/null; }
box_users() { dscl . -list /Users 2>/dev/null | grep "^$PREFIX"; }
# Whether the Mac's directory service answers. While userspace restarts it
# does not, and every user seems gone.
directory() { dscl . -read /Groups/staff >/dev/null 2>&1; }

# Takes the lock that commands which change the Mac hold, waiting up to $1
# seconds. macOS has no flock command, so perl locks the file open on
# descriptor 9, which this shell holds until it exits.
lock() {
  mkdir -p "$STATE"
  exec 9>>"$STATE/lock"
  perl -e 'use Fcntl ":flock"; open(my $f, ">&=", 9) or exit 1; $SIG{ALRM} = sub { exit 3 }; alarm $ARGV[0]; flock($f, $ARGV[0] ? LOCK_EX : LOCK_EX | LOCK_NB) or exit 3' "$1" ||
    quit 3 "Another bb-box command holds the Mac's lock."
}

# Runs a command for at most $1 seconds. The watchdog ends its sleep when it is stopped.
within() {
  seconds=$1
  shift
  "$@" </dev/null 9>&- &
  pid=$!
  (
    sleep "$seconds" &
    timer=$!
    trap 'kill "$timer"; exit 0' TERM
    wait "$timer" && kill "$pid"
  ) >/dev/null 2>&1 9>&- &
  watchdog=$!
  wait "$pid"
  code=$?
  kill "$watchdog" 2>/dev/null
  return "$code"
}

# Runs a command 2 seconds after this helper has answered: restarting userspace or the Mac ends the helper too.
later() {
  nohup sh -c 'sleep 2; exec "$@"' sh "$@" </dev/null >/dev/null 2>&1 9>&- &
}

# Reads name=value lines from stdin. "optional" allows no input, and reads none from a terminal.
read_input() {
  install='' box='' thread='' name='' kind='' created='' key=''
  if [ "${1:-}" = optional ] && [ -t 0 ]; then return 0; fi
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      install=*) install=${line#install=} ;;
      box=*) box=${line#box=} ;;
      thread=*) thread=${line#thread=} ;;
      name=*) name=${line#name=} ;;
      kind=*) kind=${line#kind=} ;;
      created=*) created=${line#created=} ;;
      key=*) key=${line#key=} ;;
      '') ;;
      *) quit 2 "Unknown input: ${line%%=*}." ;;
    esac
  done
  [ -n "$install" ] || [ "${1:-}" = optional ] || quit 2 "The input needs install=."
}

# The box users in group $1.
box_members() {
  for member in $(dscl . -read "/Groups/$1" GroupMembership 2>/dev/null | sed 's/^GroupMembership://'); do
    case $member in "$PREFIX"*) echo "$member" ;; esac
  done
}

# Box users, and the names of those that left a home, a sudo rule, a
# crontab, a password, managed preferences or a place in a group.
box_names() {
  {
    box_users
    for path in "$ROOT"/Users/"$PREFIX"* "$ROOT"/etc/sudoers.d/"$PREFIX"* "$ROOT"/private/var/at/tabs/"$PREFIX"* "$STATE"/passwords/"$PREFIX"* \
      "$ROOT/Library/Managed Preferences"/"$PREFIX"*; do
      [ -e "$path" ] && echo "${path##*/}"
    done
    for group in $JOINS; do box_members "$group"; box_members "$group-disabled"; done
  } | sed 's/\.new$//' | sort -u
}

# What an earlier box left, one line each, apart from box user $1, made
# ahead for the next box. Empty on a clean Mac.
dirt() {
  ready=${1:-}
  for user in $(box_users); do [ "$user" = "$ready" ] || echo "user $user"; done
  for path in "$ROOT"/Users/"$PREFIX"* "$ROOT"/etc/sudoers.d/"$PREFIX"* "$ROOT"/private/var/at/tabs/"$PREFIX"* "$STATE"/passwords/"$PREFIX"*; do
    [ -e "$path" ] && [ "${path##*/}" != "$ready" ] && echo "${path#"$ROOT"}"
  done
  for group in $JOINS; do
    for user in $(box_members "$group"); do [ "$user" = "$ready" ] || echo "$user in group $group"; done
  done
  ipc_orphans | sed 's/^/a System V IPC object of removed UID /'
}

# System V IPC objects, one "<type> <id> <owner>" line each. An owner with no user shows as its UID.
ipc_objects() {
  for t in m q s; do
    ipcs -"$t" 2>/dev/null | awk -v t="$t" '$1 == t { print t, $2, $5 }'
  done
}

# The UIDs in the box users' range that own IPC objects but no longer have a user.
ipc_orphans() {
  ipc_objects | awk -v lo="$ID_BASE" -v hi="$((ID_BASE + ID_SPAN))" '$3 ~ /^[0-9]+$/ && $3 >= lo && $3 < hi { print $3 }' | sort -u
}

# Removes the IPC objects of a user and UID.
remove_ipc() {
  ipc_objects | while read -r t id owner; do
    [ "$owner" = "$1" ] || [ "$owner" = "$2" ] || continue
    ipcrm -"$t" "$id" 2>/dev/null
  done
}

# Whether a viewer's input reaches the desktop (#406): the input helper, a
# JXA script osascript runs in the box user's session over SSH, posts events
# with CGEventPost, which macOS drops without the Accessibility grant for
# osascript and sshd-keygen-wrapper. So this posts a one-point pointer move
# the same way, reads the pointer back, and moves it back. It prints 1 when
# the pointer moved, else 0.
INPUT_PROBE='ObjC.import("CoreGraphics");
function run() {
  function where() { return $.CGEventGetLocation($.CGEventCreate($())); }
  function move(to) { $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent($(), 5, to, 0)); }
  var at = where();
  var to = $.CGPointMake(at.x >= 1 ? at.x - 1 : at.x + 1, at.y);
  move(to);
  delay(0.2);
  var now = where();
  move(at);
  return Math.round(now.x) === Math.round(to.x) && Math.round(now.y) === Math.round(to.y) ? 1 : 0;
}'

# Cua Driver's Accessibility and Screen Recording grants, as Cua reports them
# in the session of the box user at the console: 1 or 0 each, or empty when
# no box user is there or Cua did not answer. Cua runs with the box user's
# HOME, where its socket is. Only `status grants` asks, as the pool's doctor
# does, since the pool reads every Mac's status twice for each box it lends.
grants() {
  accessibility='' recording='' input=''
  user=$(console)
  uid=''
  case $user in "$PREFIX"*) uid=$(attribute "$user" UniqueID) ;; esac
  if number "$uid"; then
    moved=$(within 10 launchctl asuser "$uid" /usr/bin/sudo -n -H -u "$user" -- /usr/bin/osascript -l JavaScript -e "$INPUT_PROBE" 2>/dev/null)
    case $moved in 0 | 1) input=$moved ;; esac
  fi
  if number "$uid" && answer=$(within 10 launchctl asuser "$uid" /usr/bin/sudo -n -H -u "$user" -- "$CUA" permissions status --json 2>/dev/null); then
    granted() {
      if printf '%s\n' "$answer" | grep -q "\"$1\": *true"; then
        echo 1
      elif printf '%s\n' "$answer" | grep -q "\"$1\": *false"; then
        echo 0
      fi
    }
    accessibility=$(granted accessibility) recording=$(granted screen_recording)
  fi
  echo "accessibility=$accessibility"
  echo "screenrecording=$recording"
  echo "input=$input"
}

# The version of the Xcode xcode-select chooses, from its Info.plist, or
# nothing with only the Command Line Tools or none.
selected_xcode() {
  selected=$(xcode-select -p 2>/dev/null)
  case $selected in
    *.app/Contents/Developer) defaults read "${selected%/Developer}/Info" CFBundleShortVersionString 2>/dev/null ;;
  esac
}

# Xcode's version and the Simulator runtimes it can use, such as "iOS 26.0",
# found again and kept in $STATE/xcode. Only `status xcode` finds them, as
# the pool's doctor and setup-mac.sh ask, since simctl may take seconds. A
# failure keeps the file. With only the Command Line Tools or none, xcrun is
# not run, as it may offer to install them. simctl runs with root's own
# home, since sudo on macOS keeps the admin user's.
xcode() {
  xcode_version=$(selected_xcode) xcode_runtimes=''
  if [ -n "$xcode_version" ]; then
    listed=$(within 10 env HOME=/var/root xcrun simctl list runtimes available 2>/dev/null) ||
      quit 1 "xcrun simctl did not list the Simulator's runtimes within 10 seconds. If Xcode's licence is not accepted, run setup-mac.sh again."
    xcode_runtimes=$(printf '%s\n' "$listed" | awk '/^[A-Za-z]+OS [0-9]/ { print $1 " " $2 }' | paste -s -d , -)
  fi
  printf 'xcode=%s\nruntimes=%s\n' "$xcode_version" "$xcode_runtimes" | put "$STATE/xcode"
  echo "xcode=$xcode_version"
  echo "runtimes=$xcode_runtimes"
}

# What plain status says of Xcode: its version, read again, and the runtimes
# in $STATE/xcode while they were found for that version.
known_xcode() {
  xcode_version=$(selected_xcode) xcode_runtimes=''
  if [ -n "$xcode_version" ] && grep -qxF "xcode=$xcode_version" "$STATE/xcode" 2>/dev/null; then
    xcode_runtimes=$(sed -n 's/^runtimes=//p' "$STATE/xcode")
  fi
  echo "xcode=$xcode_version"
  echo "runtimes=$xcode_runtimes"
}

status() {
  [ $# -eq 0 ] || { [ $# -eq 1 ] && { [ "$1" = grants ] || [ "$1" = xcode ]; }; } || quit 2 "usage: machine status [grants | xcode]"
  current=$(generation)
  echo "helper=$VERSION"
  echo "arch=$(uname -m)"
  echo "boot=$(boot_id)"
  echo "generation=$current"
  if [ -e "$STATE/owner" ]; then
    marker=owner
  elif [ -e "$STATE/resetting" ]; then
    marker=resetting
  else
    marker=none
  fi
  echo "marker=$marker"
  [ "$marker" = none ] || sed 's/^/marker./' "$STATE/$marker"
  # A Mac has no whole-machine reset, and its boxes no Docker.
  echo hook=0
  echo docker=0
  echo systemd=0
  # The Mac's size: its cores and memory in MiB, which a box has all of, and free disk under /Users in GiB.
  echo "cores=$(sysctl -n hw.ncpu 2>/dev/null)"
  echo "memory=$(sysctl -n hw.memsize 2>/dev/null | awk '{ print int($1 / 1048576) }')"
  echo "disk=$(df -Pk "$ROOT/Users" 2>/dev/null | awk 'NR == 2 { print int($4 / 1048576) }')"
  # Whether the Mac is itself a VM: "vm" where the kernel says it runs under a hypervisor, else "none".
  [ "$(sysctl -n kern.hv_vmm_present 2>/dev/null)" = 1 ] && echo virt=vm || echo virt=none
  missing=''
  for tool in sh tar perl dscl dseditgroup sysadminctl createhomedir launchctl pgrep pkill find ipcs visudo; do
    command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
  done
  command -v curl >/dev/null 2>&1 || missing="$missing curl"
  echo "missing=${missing# }"
  # What BB's installer and a box's GitHub access need: Node.js with npm, git and gh.
  echo "node=$(node --version 2>/dev/null | head -n 1)"
  lacks=''
  for tool in npm git gh; do
    command -v "$tool" >/dev/null 2>&1 || lacks="$lacks $tool"
  done
  echo "lacks=${lacks# }"
  if [ "$marker" = none ]; then echo "dirty=$(dirt "$PREFIX$current" | head -n 1)"; else echo dirty=; fi
  # The Mac's own: the box user it has for this generation, who is at the
  # console and signs in when loginwindow starts, which needs FileVault off,
  # Screen Sharing, which the box's display uses, Full Disk Access, which
  # the reset needs, and Xcode.
  echo os=macos
  echo "macos=$(sw_vers -productVersion 2>/dev/null)"
  user=''
  if number "$current" && [ "$(attribute "$PREFIX$current" UniqueID)" = "$((ID_BASE + current % ID_SPAN))" ]; then user=$PREFIX$current; fi
  echo "user=$user"
  echo "console=$(console)"
  echo "autologin=$(defaults read "$LOGINWINDOW" autoLoginUser 2>/dev/null)"
  if fdesetup status 2>/dev/null | grep -qx 'FileVault is Off\.'; then echo filevault=0; else echo filevault=1; fi
  if launchctl print system/com.apple.screensharing >/dev/null 2>&1; then echo screensharing=1; else echo screensharing=0; fi
  if full_disk; then echo fulldisk=1; else echo fulldisk=0; fi
  # System Integrity Protection: off lets the helper grant permissions (058).
  case $(csrutil status 2>/dev/null) in *disabled*) echo sip=0 ;; *enabled*) echo sip=1 ;; *) echo sip= ;; esac
  # The desktop as video (060), once setup-mac.sh has built it.
  if [ -x /usr/local/bin/bb-box-stream ]; then echo stream=1; else echo stream=0; fi
  case ${1:-} in
    xcode) xcode ;;
    *) known_xcode ;;
  esac
  [ "${1:-}" != grants ] || grants
  # For the doctor alone, as du may take a moment.
  if [ -n "${1:-}" ]; then
    left=$(leftovers)
    echo "leftovers=${left%% *}"
    echo "leftovers_kib=${left#* }"
    echo "openhomes=$(open_homes)"
  fi
}

# Makes box user $1 with UID $2 and a random password, from macOS's home
# template and bb-box's. The password file is written last, so a user
# without one is half made.
make_user() {
  user=$1 uid=$2
  holder=$(dscl . -list /Users UniqueID 2>/dev/null | awk -v id="$uid" '$2 == id { print $1; exit }')
  if [ -n "$holder" ]; then
    echo "UID $uid belongs to $holder. bb-box's box users take UIDs $ID_BASE to $((ID_BASE + ID_SPAN - 1))." >&2
    return 1
  fi
  password=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)
  [ "${#password}" = 24 ] || return 1
  # The password goes through stdin. The full name is the user's own, as
  # sysadminctl refuses one another user has. It can fail and still exit 0.
  said=$(printf '%s\n' "$password" |
    sysadminctl -addUser "$user" -fullName "bb-box $user" -UID "$uid" -password - -home "/Users/$user" 2>&1)
  if [ "$(attribute "$user" UniqueID)" != "$uid" ]; then
    reason=$(printf '%s\n' "$said" | sed -n 's/^.*sysadminctl\[[0-9:]*\] //p' | grep -v -e '^-*$' -e 'clear text password' -e 'Creating user record' | tail -n 1)
    if [ -n "$reason" ]; then echo "sysadminctl did not make $user: $reason" >&2; else echo "sysadminctl did not make $user." >&2; fi
    return 1
  fi
  dscl . -create "/Users/$user" IsHidden 1 || return 1
  for group in $JOINS; do
    [ "$group" = _developer ] || dscl . -read "/Groups/$group" >/dev/null 2>&1 || continue
    dseditgroup -o edit -a "$user" -t user "$group" >/dev/null 2>&1 || return 1
  done
  # macOS caches who is in which group. A user made again with an earlier
  # user's name and UID, as when a reset is tried again, can meet the cache
  # of the earlier user, and Screen Sharing then refuses them.
  dsmemberutil flushcache >/dev/null 2>&1
  home=$ROOT/Users/$user
  [ -d "$home" ] || createhomedir -c -u "$user" >/dev/null 2>&1
  [ -d "$home" ] || return 1
  if [ -d "$TEMPLATE" ]; then cp -R "$TEMPLATE/." "$home/" || return 1; fi
  # No screen saver. The setting is per Mac, in a file named for its hardware UUID.
  uuid=$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | sed -n 's/.*"IOPlatformUUID" = "\([^"]*\)".*/\1/p')
  [ -n "$uuid" ] || return 1
  mkdir -p "$home/Library/Preferences/ByHost" || return 1
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
    '<plist version="1.0"><dict><key>idleTime</key><integer>0</integer></dict></plist>' \
    >"$home/Library/Preferences/ByHost/com.apple.screensaver.$uuid.plist" || return 1
  # The macOS version the user last signed in on. A home without it is a new
  # account's, whose first sign-in opens Setup Assistant to ask for an Apple
  # Account, and takes about 15 s longer.
  version=$(sw_vers -productVersion) build=$(sw_vers -buildVersion)
  [ -n "$version" ] && [ -n "$build" ] || return 1
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
    "<plist version=\"1.0\"><dict><key>SystemVersionStampAsString</key><string>$version</string><key>BuildVersionStampAsString</key><string>$build</string></dict></plist>" \
    >"$home/Library/Preferences/loginwindow.plist" || return 1
  screen_approvals "$home" || return 1
  chown -R "$uid:20" "$home" || return 1
  # No notices that background items were added, such as Cua's and BB's daemons, as in Tart's image.
  launchctl disable "gui/$uid/com.apple.backgroundtaskmanagement.agent" >/dev/null 2>&1
  mkdir -p "$STATE/passwords" && chmod 700 "$STATE/passwords" || return 1
  (umask 077 && printf '%s\n' "$password" | put "$STATE/passwords/$user") || return 1
}

# Makes box user $1 with UID $2, unless it is made already. A user half made, by a reset cut short, is made again.
ready_user() {
  if [ "$(attribute "$1" UniqueID)" = "$2" ] && [ -s "$STATE/passwords/$1" ]; then return 0; fi
  directory || {
    echo "The Mac's directory service did not answer." >&2
    return 1
  }
  if dscl . -read "/Users/$1" >/dev/null 2>&1 || [ -e "$ROOT/Users/$1" ]; then remove_user "$1"; fi
  make_user "$1" "$2" && return 0
  remove_user "$1" >/dev/null
  return 1
}

# The automatic login's /etc/kcpassword for the password on stdin: XORed
# with Apple's key, with a null after it, padded with nulls to a multiple of
# 12 bytes.
kcpassword() {
  perl -e '
    my @key = (0x7D, 0x89, 0x52, 0x23, 0xD2, 0xBC, 0xDD, 0xEA, 0xA3, 0xB9, 0x1F);
    my $password = <STDIN>;
    chomp $password;
    my @bytes = (unpack("C*", $password), 0);
    push @bytes, 0 while @bytes % 12;
    print pack("C*", map { $bytes[$_] ^ $key[$_ % 11] } 0 .. $#bytes);'
}

# Sets box user $1 as the user loginwindow signs in when it starts. macOS
# 27's sysadminctl -autologin set names the user but writes no
# /etc/kcpassword (SACSetAutoLoginPassword error 22), and exits 0, so the
# helper writes both itself. The password goes only through stdin.
automatic_login() {
  user=$1
  secret=$STATE/passwords/$user
  [ -s "$secret" ] || fail "Box user $user has no password in $STATE/passwords."
  if [ "$(defaults read "$LOGINWINDOW" autoLoginUser 2>/dev/null)" = "$user" ] &&
    kcpassword <"$secret" | cmp -s - "$ROOT/etc/kcpassword"; then return 0; fi
  fdesetup status 2>/dev/null | grep -qx 'FileVault is Off\.' ||
    fail "FileVault is on, so the Mac cannot sign box users in by itself. Turn FileVault off."
  (umask 077 && kcpassword <"$secret" >"$ROOT/etc/kcpassword.new") &&
    chown root:wheel "$ROOT/etc/kcpassword.new" && mv -f "$ROOT/etc/kcpassword.new" "$ROOT/etc/kcpassword" ||
    fail "Could not write /etc/kcpassword for $user."
  defaults write "$LOGINWINDOW" autoLoginUser -string "$user" >/dev/null 2>&1
  [ "$(defaults read "$LOGINWINDOW" autoLoginUser 2>/dev/null)" = "$user" ] ||
    fail "Could not set $user as the automatic login."
}

# How long each way of starting loginwindow again may take to sign the user in, in seconds.
patience() {
  case $1 in
    loginwindow) echo 60 ;;
    userspace) echo 180 ;;
    *) echo 480 ;;
  esac
}

# The way the reset tries first: the one that signed the last user in. With
# none yet, restarting loginwindow alone, except on macOS 27 and later, where
# that does not sign the user in, so restarting userspace.
first_way() {
  way=$(cat "$STATE/signs-in-by" 2>/dev/null)
  case $way in
    loginwindow | userspace | restart) echo "$way" ;;
    *)
      major=$(sw_vers -productVersion 2>/dev/null | cut -d . -f 1)
      if number "$major" && [ "$major" -ge 27 ]; then echo userspace; else echo loginwindow; fi
      ;;
  esac
}

# Starts loginwindow again by way $2, which signs in box user $1, the
# automatic login. It leaves alone a person signed in at the console.
begin_sign_in() {
  who=$(console)
  case $who in
    '' | root | "$PREFIX"*) ;;
    *) fail "$who is signed in at the Mac's console, so the Mac cannot sign the next box's user in. Sign $who out, then reset the Mac: sudo /usr/local/libexec/bb-box/machine reset" ;;
  esac
  printf 'user=%s\nmethod=%s\nsince=%s\n' "$1" "$2" "$(now)" | put "$STATE/signin"
  case $2 in
    loginwindow) launchctl kickstart -k system/com.apple.loginwindow >/dev/null 2>&1 ;;
    userspace) later launchctl reboot userspace ;;
    restart) later shutdown -r now ;;
  esac
}

# Returns once box user $1 is at the console. Until then it exits 10, and
# when one way has not signed the user in within its time, it tries the next.
sign_in() {
  user=$1
  if [ "$(console)" = "$user" ]; then
    method=$(field "$STATE/signin" method)
    [ -z "$method" ] || echo "$method" | put "$STATE/signs-in-by"
    rm -f "$STATE/signin"
    return 0
  fi
  method='' since=''
  if [ "$(field "$STATE/signin" user)" = "$user" ]; then
    method=$(field "$STATE/signin" method) since=$(field "$STATE/signin" since)
  fi
  if [ -z "$method" ]; then
    method=$(first_way)
  elif number "$since" && [ $(($(now) - since)) -ge "$(patience "$method")" ]; then
    case $method in
      loginwindow) method=userspace ;;
      userspace) method=restart ;;
      *)
        rm -f "$STATE/signin"
        fail "The Mac did not sign $user in, even when it restarted. Check that FileVault is off and that the automatic login is $user."
        ;;
    esac
    since=''
  fi
  number "$since" || begin_sign_in "$user" "$method"
  echo "signin=$method"
  exit 10
}

# Logs a box user out and ends its processes.
log_out() {
  user=$1 uid=${2:-}
  [ -n "$uid" ] || uid=$(attribute "$user" UniqueID)
  box_uid "$uid" || return 0
  within 30 launchctl bootout "gui/$uid" >/dev/null 2>&1
  within 30 launchctl bootout "user/$uid" >/dev/null 2>&1
  tries=0
  while pgrep -u "$uid" >/dev/null 2>&1; do
    pkill -KILL -u "$uid" >/dev/null 2>&1
    tries=$((tries + 1))
    [ "$tries" -le 50 ] || fail "Processes of $user did not end: $(pgrep -l -u "$uid" | head -n 3 | tr '\n' ' ')"
    sleep 0.2
  done
}

# Removes every file and directory UID $1 owns on the Data volume, or under
# directory $2, clearing the flags that stop even root, and prints those
# still there.
sweep() {
  find "${2:-$DATA}" -xdev -uid "$1" -prune -exec sh -c '
    chflags -R nouchg,nouappnd "$@" 2>/dev/null
    rm -rf "$@" 2>/dev/null
    for path; do if [ -e "$path" ] || [ -L "$path" ]; then printf "%s\n" "$path"; fi; done' sh {} + 2>/dev/null
  return 0
}

# Whether what is left of folder $1, under /private/var/folders, is what
# macOS keeps there, for user ID $2. macOS 27 marks a user's 0, C, T and X
# folders there sunlnk, System Integrity Protection's "system no-unlink",
# and keeps its daemons' folders in them, such as
# 0/com.apple.ScreenTimeAgent, which root cannot even list, Full Disk
# Access or not. So it counts as removed when root sees only folders left
# in it, whether it can enter them or not, each the old user's or root's.
# A file, or anything of another user, such as the next box's, fails.
kept_by_macos() {
  case $1 in "$DATA/private/var/folders/"*) ;; *) return 1 ;; esac
  [ -d "$1" ] && [ ! -L "$1" ] || return 1
  [ -z "$(find "$1" ! -type d 2>/dev/null | head -n 1)" ] || return 1
  [ -z "$(find "$1" ! -uid "$2" ! -uid 0 2>/dev/null | head -n 1)" ]
}

# The folders old box users left under /private/var/folders, which macOS
# keeps (kept_by_macos), and the KiB root can see in them: "<count> <KiB>".
leftovers() {
  current_uid=$(attribute "$PREFIX$(generation)" UniqueID)
  find "$DATA/private/var/folders" -mindepth 2 -maxdepth 2 -type d 2>/dev/null | while IFS= read -r path; do
    uid=$(stat -f %u "$path" 2>/dev/null)
    number "$uid" && [ "$uid" -ge "$ID_BASE" ] && [ "$uid" -lt "$((ID_BASE + ID_SPAN))" ] && [ "$uid" != "$current_uid" ] || continue
    du -sk "$path" 2>/dev/null | awk '{ print $1 }'
  done | awk '{ n++; k += $1 } END { printf "%d %d\n", n, k }'
}

# 058: on a Mac whose owner turned System Integrity Protection off, TCC's
# databases can be written, so the helper grants the box user's programs
# what macOS would ask a person for, and the reset removes it again.
sip_off() { csrutil status 2>/dev/null | grep -q 'status: disabled'; }
# The columns of TCC's access table that this helper writes, as on macOS 27.
TCC_COLUMNS="service client client_type auth_value auth_reason auth_version csreq policy_id indirect_object_identifier_type indirect_object_identifier indirect_object_code_identity flags last_modified pid pid_version boot_uuid last_reminded one_time_reprompt_eligible reminder_count"
tcc_known() { [ "$(sqlite3 "$1" 'PRAGMA table_info(access);' 2>/dev/null | cut -d '|' -f 2 | paste -sd ' ' -)" = "$TCC_COLUMNS" ]; }
# User $1's TCC.db, which macOS 27 keeps outside the home: its tccd has it open.
user_tcc() {
  pid=$(pgrep -u "$1" -x tccd 2>/dev/null | head -n 1)
  [ -n "$pid" ] || return 1
  lsof -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p' | grep '/com\.apple\.TCC/TCC\.db$' | head -n 1
}
sql() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }
# Each row of TCC database $1 as service, client, type and indirect object, a line each.
tcc_keys() { sqlite3 "$1" "select service || char(9) || client || char(9) || client_type || char(9) || indirect_object_identifier from access order by 1;" 2>/dev/null; }
# What the claim saw of the system database, so the reset removes every row
# added while the box had the Mac: the helper's grants, and the denied rows
# macOS writes when a program asks.
tcc_snapshot() {
  sip_off && tcc_known "$ROOT$TCC" || return 0
  tcc_keys "$ROOT$TCC" | sort | put "$STATE/tcc-before"
}
tcc_restore() {
  [ -f "$STATE/tcc-before" ] && sip_off && tcc_known "$ROOT$TCC" || { rm -f "$STATE/tcc-before" "$STATE/grants"; return 0; }
  tcc_keys "$ROOT$TCC" | sort | comm -23 - "$STATE/tcc-before" | while IFS="$(printf '\t')" read -r service client type object; do
    sqlite3 "$ROOT$TCC" "DELETE FROM access WHERE service = $(sql "$service") AND client = $(sql "$client") AND client_type = $type AND indirect_object_identifier = $(sql "$object");"
  done
  rm -f "$STATE/tcc-before" "$STATE/grants"
}
# With SIP off the sweep removes an old user's ProtectedSystem container
# (its TCC.db) and /private/var/folders entry. Those of users reset while SIP
# was on stay, and go here, once their UID has no user.
old_leftovers() {
  sip_off || return 0
  for dir in "$DATA/private/var/containers/Data/ProtectedSystem"/* "$DATA/private/var/folders"/*/*; do
    [ -d "$dir" ] || continue
    uid=$(stat -f %u "$dir" 2>/dev/null)
    number "$uid" && [ "$uid" -ge "$ID_BASE" ] && [ "$uid" -lt "$((ID_BASE + ID_SPAN))" ] || continue
    dscl . -list /Users UniqueID 2>/dev/null | awk -v id="$uid" '$2 == id { found = 1 } END { exit !found }' && continue
    chflags -R nouchg,nouappnd,noschg "$dir" 2>/dev/null
    rm -rf "$dir" 2>/dev/null
  done
}

# Screen capture approved for the user (047). macOS 27 asks each user once
# whether a program may "bypass the system private window picker", and a box
# has nobody to answer. replayd keeps the answers in the user's home, keyed by
# the program, and asks again only after kScreenCapturePrivacyHintDate, so an
# entry with that date years ahead keeps the prompt away. The programs: Cua
# Driver, by its bundle ID; screencapture and the like run by box_run, which
# replayd charges to sshd-keygen-wrapper, by its path; and, in a Tart VM,
# what a desktop command starts through bb-box's launcher, by its URL. The
# grants to capture at all are the operator's (Cua's) or 058's; this is the
# per-user notice on top of them. The file is the helper's: it is written
# whole, owned by root until the caller gives the home to the user.
screen_approvals() { # home
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ) year=$(date -u +%Y)
  replayd="$1/Library/Group Containers/group.com.apple.replayd"
  mkdir -p "$replayd" && chmod 700 "$replayd" || return 1
  {
    printf '%s' '<?xml version="1.0" encoding="UTF-8"?>' \
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
      '<plist version="1.0"><dict>'
    for client in "$CUA_BUNDLE" /usr/libexec/sshd-keygen-wrapper file:///usr/local/libexec/bb-box/Launcher.app/; do
      printf '%s' "<key>$client</key><dict><key>kScreenCaptureAlertableUsageCount</key><integer>1</integer><key>kScreenCaptureApprovalLastAlerted</key><date>$now</date><key>kScreenCaptureApprovalLastUsed</key><date>$now</date><key>kScreenCapturePrivacyHintDate</key><date>$((year + 5))-01-01T00:00:00Z</date><key>kScreenCapturePrivacyHintPolicy</key><integer>2592000</integer></dict>"
    done
    printf '%s\n' '</dict></plist>'
  } >"$replayd/ScreenCaptureApprovals.plist" || return 1
  chmod 600 "$replayd/ScreenCaptureApprovals.plist"
}

# The box user's own code-signing identity (058): a self-signed certificate
# in a keychain of its own with an empty password, imported for all apps and
# with codesign in its partition list, so codesign and Xcode sign with it
# with no prompt. A program signed with it keeps its code requirement, and
# so its grants, across rebuilds. The login keychain would ask for a password
# the box user does not know. A restart locks the keychain, so each claim
# unlocks it again, in the desktop session; each command a box runs unlocks it
# in its own session. A keychain without the identity, as a failed attempt
# leaves, is made again. $STATE/signing names the user that has it, for
# box_status.
SIGNING="bb-box local code signing"
signing_identity() { # user uid
  user=$1 uid=$2
  home=$(attribute "$user" NFSHomeDirectory)
  [ -n "$home" ] && number "$uid" || return 1
  keychain=$home/Library/Keychains/bb-box-signing.keychain-db
  run() { launchctl asuser "$uid" /usr/bin/sudo -n -H -u "$user" -- "$@"; }
  rm -f "$STATE/signing"
  run security unlock-keychain -p "" "$keychain" >/dev/null 2>&1
  if ! run security find-identity -p codesigning "$keychain" 2>/dev/null | grep -qF "\"$SIGNING\""; then
    rm -f "$ROOT$keychain"
    # In /tmp, which the user can enter: under sudo, mktemp's own folder is root's alone.
    work=$(mktemp -d /tmp/bb-box-signing.XXXXXX) || return 1
    secret=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)
    printf '%s\n' '[req]' 'distinguished_name = dn' 'prompt = no' 'x509_extensions = ext' '[dn]' "CN = $SIGNING" '[ext]' \
      'basicConstraints = critical,CA:false' 'keyUsage = critical,digitalSignature' 'extendedKeyUsage = critical,codeSigning' >"$work/cert.cnf"
    # The PBE and MAC macOS's security tool can read.
    if /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -keyout "$work/key.pem" -out "$work/cert.pem" -days 3650 -config "$work/cert.cnf" >/dev/null 2>&1 &&
      /usr/bin/openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -out "$work/id.p12" -passout "pass:$secret" -name "$SIGNING" \
        -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1 >/dev/null 2>&1; then
      chown "$uid" "$work" "$work/id.p12" && mkdir -p "$ROOT$home/Library/Keychains" && chown "$uid:20" "$ROOT$home/Library/Keychains" &&
        run security create-keychain -p "" "$keychain" >/dev/null 2>&1 &&
        run security set-keychain-settings "$keychain" >/dev/null 2>&1 &&
        run security unlock-keychain -p "" "$keychain" >/dev/null 2>&1 &&
        run security import "$work/id.p12" -k "$keychain" -P "$secret" -A >/dev/null 2>&1 &&
        run security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" "$keychain" >/dev/null 2>&1
      made=$?
    else
      made=1
    fi
    rm -rf "$work"
    [ "$made" = 0 ] || { rm -f "$ROOT$keychain"; return 1; }
  fi
  run security unlock-keychain -p "" "$keychain" >/dev/null 2>&1 || return 1
  # On the user's search list, so codesign and Xcode find the identity.
  listed=$(run security list-keychains -d user 2>/dev/null | sed 's/^ *"//; s/"$//')
  printf '%s\n' "$listed" | grep -qxF "$keychain" ||
    run security list-keychains -d user -s $listed "$keychain" >/dev/null 2>&1
  echo "$user" >"$STATE/signing"
}

# The desktop at the 2x mode of its size, for user $1's session only, where
# the display offers one (setup-mac.sh's bb-box-display). Best effort: a 1x
# desktop still works.
hidpi() { # user uid
  [ -x "$ROOT/usr/local/bin/bb-box-display" ] || return 0
  launchctl asuser "$2" /usr/bin/sudo -n -H -u "$1" -- /usr/local/bin/bb-box-display hidpi >/dev/null 2>&1
}

# The microphone and the camera for box_run's commands, by default (058), in
# box user $1's own TCC database: those commands are charged to
# sshd-keygen-wrapper. The Mac has no microphone of its own: setup-mac.sh
# installs BlackHole as its input. It has a camera only if one is attached.
default_grants() { # user
  sip_off || return 0
  db=$(user_tcc "$1") && [ -n "$db" ] && tcc_known "$db" || return 1
  wrapper=/usr/libexec/sshd-keygen-wrapper
  requirement=$(codesign -d -r- "$ROOT$wrapper" 2>&1 | sed -n 's/^designated => //p' | head -n 1)
  [ -n "$requirement" ] || return 1
  blob=$(printf '%s' "$requirement" | csreq -r- -b /dev/stdout | xxd -p | tr -d '\n')
  [ -n "$blob" ] || return 1
  now=$(now)
  for service in kTCCServiceMicrophone kTCCServiceCamera; do
    sqlite3 "$db" "DELETE FROM access WHERE service = '$service' AND client = '$wrapper';
      INSERT INTO access (service, client, client_type, auth_value, auth_reason, auth_version, csreq, policy_id, indirect_object_identifier_type, indirect_object_identifier, indirect_object_code_identity, flags, last_modified, pid, pid_version, boot_uuid, last_reminded)
      VALUES ('$service', '$wrapper', 1, 2, 4, 1, X'$blob', NULL, 0, 'UNUSED', NULL, 0, $now, NULL, NULL, 'UNUSED', $now);" 2>/dev/null || return 1
  done
}

# The TCC service and database of each permission a grant may give: s for the
# system's, u for the box user's.
service_of() {
  case $1 in
    accessibility) echo "kTCCServiceAccessibility s" ;;
    screen-recording) echo "kTCCServiceScreenCapture s" ;;
    input-monitoring) echo "kTCCServiceListenEvent s" ;;
    microphone) echo "kTCCServiceMicrophone u" ;;
    camera) echo "kTCCServiceCamera u" ;;
    system-audio) echo "kTCCServiceAudioCapture u" ;;
    automation) echo "kTCCServiceAppleEvents u" ;;
    *) return 1 ;;
  esac
}

# Grants the box user's program the permissions asked for (058): an app (a
# bundle) by its bundle ID, any other program by its path, each with its code
# requirement, but a program signed only ad hoc by its path alone, so that a
# rebuild keeps the grant. Input: install=, box=, program=<path>,
# permission=<name> lines, and target=<bundle ID> for automation. It says
# granted=<permission> or refused=<permission> <why> for each.
grant() {
  # A Tart VM's user, vm-grant's, or else the user of the box that holds the Mac.
  vm_user=${1:-}
  install='' box='' program='' permissions='' target=''
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      install=*) install=${line#install=} ;;
      box=*) box=${line#box=} ;;
      program=*) program=${line#program=} ;;
      permission=*) permissions="$permissions ${line#permission=}" ;;
      target=*) target=${line#target=} ;;
      '') ;;
      *) quit 2 "Unknown input: ${line%%=*}." ;;
    esac
  done
  if [ -n "$vm_user" ]; then
    [ -n "$program" ] && [ -n "$permissions" ] || quit 2 "The grant needs program= and permission=."
    lock 60
    user=$vm_user
  else
    [ -n "$install" ] && [ -n "$box" ] && [ -n "$program" ] && [ -n "$permissions" ] || quit 2 "The grant needs install=, box=, program= and permission=."
    lock 60
    [ -e "$STATE/owner" ] && [ "$(field "$STATE/owner" install)" = "$install" ] && [ "$(field "$STATE/owner" box)" = "$box" ] || quit 4 "Box $box does not hold the Mac."
    user=$(field "$STATE/owner" user)
  fi
  sip_off || quit 7 "System Integrity Protection is on, so macOS lets no program grant permissions. A person grants them in System Settings, or the Mac's owner turns SIP off in recovery (058)."
  tcc_known "$ROOT$TCC" || fail "TCC's database is not as bb-box knows it on macOS 27, so it writes nothing there."
  home=$(attribute "$user" NFSHomeDirectory)
  [ -n "$home" ] || fail "Box user $user has no home."
  case $program in
    "$home"/* | /Applications/*) ;;
    *) quit 8 "$program is not in $home or /Applications. bb-box grants permissions only to the box user's programs and to apps in /Applications." ;;
  esac
  path=$ROOT$program
  [ -e "$path" ] || quit 8 "There is no $program."
  case $program in
    *.app | *.app/) app=${program%/} type=0 ;;
    *) app='' type=1 ;;
  esac
  if [ -n "$app" ]; then
    client=$(plutil -extract CFBundleIdentifier raw "$path/Contents/Info.plist" 2>/dev/null)
    [ -n "$client" ] || quit 8 "$program has no bundle ID."
  else
    [ -f "$path" ] && [ -x "$path" ] || quit 8 "$program is not an app or a program."
    client=$program
  fi
  identifier=$(codesign -dv "$path" 2>&1 | sed -n 's/^Identifier=//p')
  [ -n "$identifier" ] || quit 8 "$program is not signed. Sign it, with the box's identity: codesign -s \"bb-box local code signing\" --identifier <id> <program>."
  case "$client $identifier" in
    com.apple.* | *" com.apple."*) quit 8 "$program is Apple's. bb-box grants nothing to Apple's programs." ;;
  esac
  case $(basename "$program") in
    Terminal.app | iTerm.app | sh | bash | zsh | dash | ksh | fish | python* | ruby | perl* | node | osascript)
      quit 8 "$program runs any script, so a grant would reach every script. bb-box grants nothing to shells, terminals or interpreters." ;;
  esac
  requirement=$(codesign -d -r- "$path" 2>&1 | sed -n 's/^designated => //p;s/^# designated => //p' | head -n 1)
  [ -n "$requirement" ] || quit 8 "$program has no code requirement."
  blob=NULL
  case $requirement in
    # Signed only ad hoc: a program by path alone, which a rebuild keeps.
    cdhash*) [ "$type" = 1 ] || blob="X'$(printf '%s' "$requirement" | csreq -r- -b /dev/stdout | xxd -p | tr -d '\n')'" ;;
    *) blob="X'$(printf '%s' "$requirement" | csreq -r- -b /dev/stdout | xxd -p | tr -d '\n')'" ;;
  esac
  [ "$blob" != "X''" ] || fail "csreq could not compile $program's requirement."
  user_db=$(user_tcc "$user")
  now=$(now)
  for permission in $permissions; do
    entry=$(service_of "$permission") || { echo "refused=$permission bb-box grants accessibility, screen-recording, input-monitoring, microphone, camera, system-audio and automation."; continue; }
    service=${entry% *} where=${entry#* }
    db=$ROOT$TCC object=UNUSED object_type=0
    if [ "$where" = u ]; then
      if [ -z "$user_db" ] || ! tcc_known "$user_db"; then echo "refused=$permission the box user's TCC database is not open: sign the box user in first."; continue; fi
      db=$user_db
    fi
    if [ "$permission" = automation ]; then
      [ -n "$target" ] || { echo "refused=$permission it needs target=, the bundle ID of the app to send Apple events to."; continue; }
      object=$target
    fi
    if sqlite3 "$db" "DELETE FROM access WHERE service = $(sql "$service") AND client = $(sql "$client") AND indirect_object_identifier = $(sql "$object");
      INSERT INTO access (service, client, client_type, auth_value, auth_reason, auth_version, csreq, policy_id, indirect_object_identifier_type, indirect_object_identifier, indirect_object_code_identity, flags, last_modified, pid, pid_version, boot_uuid, last_reminded)
      VALUES ($(sql "$service"), $(sql "$client"), $type, 2, 4, 1, $blob, NULL, $object_type, $(sql "$object"), NULL, 0, $now, NULL, NULL, 'UNUSED', $now);" 2>/dev/null; then
      printf '%s\t%s\t%s\n' "$permission" "$client" "$object" >>"$STATE/grants"
      echo "granted=$permission"
    else
      echo "refused=$permission sqlite3 could not write TCC's database."
    fi
  done
  echo "client=$client"
}

# Removes a box user and everything it left.
remove_user() {
  user=$1 uid=${2:-}
  [ -n "$uid" ] || uid=$(attribute "$user" UniqueID)
  log_out "$user" "$uid"
  rm -f "$ROOT/etc/sudoers.d/$user" "$ROOT/etc/sudoers.d/$user.new"
  crontab -u "$user" -r >/dev/null 2>&1
  rm -f "$ROOT/private/var/at/tabs/$user"
  # Its at jobs are files it owns, in /private/var/at/jobs, which the sweep
  # removes. macOS's atq does not say whose a job is.
  [ -z "$uid" ] || remove_ipc "$user" "$uid"
  # Allowing all users to a service renames its group with -disabled, and the
  # group keeps its members for when only some are allowed again.
  # dseditgroup refuses a user whose record has gone, so dscl takes its name
  # out instead.
  for group in $JOINS; do
    for name in "$group" "$group-disabled"; do
      dseditgroup -o edit -d "$user" -t user "$name" >/dev/null 2>&1 ||
        dscl . -delete "/Groups/$name" GroupMembership "$user" >/dev/null 2>&1
    done
  done
  if number "$uid"; then
    left=$(sweep "$uid")
    # As the sweep removes the user's files, Spotlight's mds can start the
    # user's launchd domain again, even with indexing off, and its distnoted
    # makes the user's temporary folders again. So the user is logged out
    # again, and those folders swept again.
    log_out "$user" "$uid"
    left=$({
      printf '%s\n' "$left"
      sweep "$uid" "$DATA/private/var/folders"
    } | while IFS= read -r path; do
      if [ -e "$path" ] || [ -L "$path" ]; then kept_by_macos "$path" "$uid" || printf '%s\n' "$path"; fi
    done | head -n 1)
    if [ -n "$left" ]; then
      full_disk || fail "Could not remove ${left#"$DATA"}, which $user owned. The helper has no Full Disk Access: on the Mac, in System Settings, General, Sharing, select the (i) beside Remote Login, and turn on Allow full disk access for remote users."
      fail "Could not remove ${left#"$DATA"}, which $user owned."
    fi
  fi
  if dscl . -read "/Users/$user" >/dev/null 2>&1; then
    sysadminctl -deleteUser "$user" >/dev/null 2>&1
    ! dscl . -read "/Users/$user" >/dev/null 2>&1 || dscl . -delete "/Users/$user" >/dev/null 2>&1
    ! dscl . -read "/Users/$user" >/dev/null 2>&1 || fail "Could not remove user $user."
  fi
  rm -rf "$ROOT/Users/$user" "$ROOT/Library/Managed Preferences/$user"
  rm -f "$STATE/passwords/$user"
}

claim() {
  expected=${1:-}
  number "$expected" || quit 2 "usage: machine claim <generation>"
  case ${2:-} in
    '') ;;
    docker) quit 2 "Boxes on a Mac have no Docker." ;;
    *) quit 2 "usage: machine claim <generation>" ;;
  esac
  read_input
  [ -n "$box" ] || quit 2 "The claim needs box=."
  case $key in
    "ssh-ed25519 "* | "ssh-rsa "* | "ecdsa-sha2-"* | "sk-ssh-ed25519@openssh.com "* | "sk-ecdsa-sha2-"*) ;;
    *) quit 2 "The claim needs key=, an OpenSSH public key." ;;
  esac
  lock 0
  if [ -e "$STATE/owner" ] || [ -e "$STATE/resetting" ]; then quit 3 "Another box holds the Mac."; fi
  current=$(generation)
  number "$current" || quit 5 "The Mac has no reset generation in $STATE. Run bb-box's setup-mac.sh on it."
  [ "$current" = "$expected" ] || quit 6 "The Mac is at reset generation $current, not $expected."
  user=$PREFIX$current
  problem=$(dirt "$user" | head -n 1)
  [ -z "$problem" ] || quit 5 "An earlier box left $problem."
  uid=$((ID_BASE + current % ID_SPAN))
  if [ "$(attribute "$user" UniqueID)" != "$uid" ] || [ ! -s "$STATE/passwords/$user" ]; then
    quit 5 "Box user $user is not ready. Reset the Mac: sudo /usr/local/libexec/bb-box/machine reset"
  fi
  printf 'install=%s\nbox=%s\nthread=%s\nname=%s\nkind=%s\ncreated=%s\ngeneration=%s\nuser=%s\nuid=%s\n' \
    "$install" "$box" "$thread" "$name" "$kind" "$created" "$current" "$user" "$uid" >"$STATE/owner.new.$$"
  if ! ln "$STATE/owner.new.$$" "$STATE/owner" 2>/dev/null; then
    rm -f "$STATE/owner.new.$$"
    quit 3 "Another box holds the Mac."
  fi
  rm -f "$STATE/owner.new.$$"
  default_grants "$user" || :
  tcc_snapshot
  signing_identity "$user" "$uid" || :
  # Set already by the reset, but not for the first user, which init makes.
  hidpi "$user" "$uid" || :
  # The box's key, and 030's sudo rule, which lets the user run desktop commands in its own session and nothing else.
  home=$ROOT/Users/$user
  rule=$ROOT/etc/sudoers.d/$user
  if ! {
    mkdir -p "$home/.ssh" &&
      printf '%s\n' "$key" >"$home/.ssh/authorized_keys" &&
      chmod 700 "$home/.ssh" && chmod 600 "$home/.ssh/authorized_keys" &&
      chown -R "$uid:20" "$home/.ssh" &&
      printf '%s ALL=(root) NOPASSWD: /bin/launchctl asuser %s /usr/bin/sudo -n -u %s -- *\n' "$user" "$uid" "$user" >"$rule.new" &&
      chmod 440 "$rule.new" && visudo -cqf "$rule.new" >/dev/null 2>&1 &&
      mv -f "$rule.new" "$rule"
  }; then
    rm -f "$home/.ssh/authorized_keys" "$rule" "$rule.new" "$STATE/owner"
    fail "Could not lend box user $user."
  fi
  printf 'user=%s\nuid=%s\n' "$user" "$uid"
}

# Resets the Mac from the marker that names the box. It is safe to run
# again: the resetting marker stays until the new generation is written.
finish() {
  marker=$1
  held=$(field "$marker" generation)
  number "$held" || fail "$marker has no generation."
  if [ "$marker" = "$STATE/owner" ]; then
    mv -f "$STATE/owner" "$STATE/resetting" || fail "Could not mark the Mac as resetting."
    marker=$STATE/resetting
  fi
  next=$((held + 1))
  next_user=$PREFIX$next
  next_uid=$((ID_BASE + next % ID_SPAN))
  old=$(field "$marker" user)
  old_uid=$(field "$marker" uid)
  [ "$old" != "$next_user" ] || old=''

  # While userspace or the Mac restarts to sign the next user in, users and
  # processes seem to come and go. Steps 1 to 4 ran before the restart
  # began, so wait for the sign-in.
  method=$(field "$STATE/signin" method) since=$(field "$STATE/signin" since)
  if [ "$method" = userspace ] || [ "$method" = restart ]; then
    if [ "$(field "$STATE/signin" user)" = "$next_user" ] && number "$since" && [ "$(console)" != "$next_user" ] &&
      [ $(($(now) - since)) -lt "$(patience "$method")" ]; then
      echo "signin=$method"
      exit 10
    fi
  fi

  # 1. Make the next box's user, and set it as the automatic login. While an
  # old user is still the automatic login, macOS signs it in again a few
  # seconds after step 2 logs it out.
  ready_user "$next_user" "$next_uid" || fail "Could not make box user $next_user."
  automatic_login "$next_user"

  # 2. Log the old box users out, and end their processes.
  [ -z "$old" ] || log_out "$old" "$old_uid"
  for other in $(box_users); do [ "$other" = "$next_user" ] || log_out "$other"; done

  # 3. Start loginwindow again, which signs the next user in. Restarting
  # loginwindow alone leaves this helper running, so it starts now and signs
  # the user in while step 4 runs. The other ways wait for step 5.
  if [ "$(console)" != "$next_user" ] && [ "$(field "$STATE/signin" user)" != "$next_user" ]; then
    method=$(first_way)
    case $method in
      userspace | restart) printf 'user=%s\nmethod=%s\nsince=\n' "$next_user" "$method" | put "$STATE/signin" ;;
      *) begin_sign_in "$next_user" loginwindow ;;
    esac
  fi

  # 4. Remove the old box users, with everything they own. A user's record
  # goes last, so once nothing is left, as when bb-box asks again while the
  # next user signs in, there is nothing to sweep.
  if [ -n "$(dirt "$next_user" | head -n 1)" ]; then
    [ -z "$old" ] || remove_user "$old" "$old_uid"
    for other in $(box_names); do [ "$other" = "$next_user" ] || remove_user "$other"; done
    for other in $(ipc_orphans); do remove_ipc "$other" "$other"; done
  fi
  # The permissions granted, or asked for, while the box had the Mac (058).
  tcc_restore
  old_leftovers

  # 5. Check that nothing of theirs is left, and that the next user is at the console.
  problem=$(dirt "$next_user" | head -n 1)
  [ -z "$problem" ] || fail "The reset left $problem."
  sign_in "$next_user"
  # Made now the user is signed in, so a claim has only to unlock it.
  signing_identity "$next_user" "$next_uid" || :
  default_grants "$next_user" || :
  hidpi "$next_user" "$next_uid" || :
  echo "$next" | put "$STATE/generation"
  rm -f "$STATE/resetting"
  echo "generation=$next"
  echo released=yes
}

release() {
  expected=${1:-}
  number "$expected" || quit 2 "usage: machine release <generation>"
  [ $# -le 1 ] || quit 2 "A Mac has no whole-machine reset. usage: machine release <generation>"
  read_input
  lock 900
  if [ -e "$STATE/owner" ]; then
    marker=$STATE/owner
    # A guest that names no box never matches a box that holds the Mac.
    [ -n "$box" ] || quit 4 "A box holds the Mac."
  elif [ -e "$STATE/resetting" ]; then
    marker=$STATE/resetting
  else
    current=$(generation)
    echo "generation=$current"
    if number "$current" && [ "$current" -gt "$expected" ]; then echo released=already; else echo released=none; fi
    exit 0
  fi
  [ "$(field "$marker" install)" = "$install" ] || quit 4 "Another bb-box install holds the Mac."
  [ -z "$box" ] || [ "$(field "$marker" box)" = "$box" ] || quit 4 "Another box holds the Mac."
  [ "$(field "$marker" generation)" = "$expected" ] || quit 4 "The Mac has moved on to a later box."
  finish "$marker"
}

# For a Mac out of service: resets whatever is on it. It leaves alone a Mac
# a box holds, whoever asks, and from bb-box, a Mac another install is
# resetting. An operator runs it with no input, and it waits while the Mac
# signs the next user in.
reset() {
  [ $# -eq 0 ] || quit 2 "A Mac has no whole-machine reset. usage: machine reset"
  read_input optional
  lock 900
  if [ -e "$STATE/owner" ]; then
    quit 4 "Box $(field "$STATE/owner" name) of bb-box install $(field "$STATE/owner" install) holds the Mac. Release the box first."
  elif [ ! -e "$STATE/resetting" ]; then
    current=$(generation)
    number "$current" || current=0
    printf 'install=%s\ngeneration=%s\n' "$install" "$current" | put "$STATE/resetting"
  fi
  marker=$STATE/resetting
  other=$(field "$marker" install)
  if [ -n "$install" ] && [ "$other" != "$install" ]; then
    [ -n "$other" ] || quit 4 "An operator's reset of the Mac has not finished. Run it again on the Mac."
    quit 4 "Another bb-box install, $other, is resetting the Mac."
  fi
  if [ -n "$install" ]; then
    finish "$marker"
    exit 0
  fi
  while :; do
    out=$(finish "$marker")
    code=$?
    [ "$code" = 10 ] || break
    sleep 2
  done
  [ -z "$out" ] || printf '%s\n' "$out"
  exit "$code"
}

# The box user's name and password, for the relay to sign in to Screen
# Sharing as the box user. Only for the box that holds the Mac.
display() {
  expected=${1:-}
  number "$expected" || quit 2 "usage: machine display <generation>"
  read_input
  [ -n "$box" ] || quit 2 "The display needs box=."
  [ -e "$STATE/owner" ] || quit 4 "No box holds the Mac."
  [ "$(field "$STATE/owner" install)" = "$install" ] && [ "$(field "$STATE/owner" box)" = "$box" ] &&
    [ "$(field "$STATE/owner" generation)" = "$expected" ] || quit 4 "Another box holds the Mac."
  user=$(field "$STATE/owner" user)
  password=$(cat "$STATE/passwords/$user" 2>/dev/null)
  [ -n "$password" ] || fail "Box user $user has no password in $STATE/passwords."
  printf 'user=%s\npassword=%s\n' "$user" "$password"
}

# The box's grants (058), for box_status: sip=0 or 1, signing=1 when the box
# user has its signing identity, then a line
# grant=<permission> TAB <client> TAB <target> for each, oldest first.
granted() {
  expected=${1:-}
  number "$expected" || quit 2 "usage: machine granted <generation>"
  read_input
  [ -n "$box" ] || quit 2 "The grants need box=."
  [ -e "$STATE/owner" ] || quit 4 "No box holds the Mac."
  [ "$(field "$STATE/owner" install)" = "$install" ] && [ "$(field "$STATE/owner" box)" = "$box" ] &&
    [ "$(field "$STATE/owner" generation)" = "$expected" ] || quit 4 "Another box holds the Mac."
  if sip_off; then echo sip=0; else echo sip=1; fi
  if [ "$(cat "$STATE/signing" 2>/dev/null)" = "$(field "$STATE/owner" user)" ]; then echo signing=1; else echo signing=0; fi
  [ ! -f "$STATE/grants" ] || awk '!seen[$0]++ { print "grant=" $0 }' "$STATE/grants"
}

# A VM that is itself the box (Tart's): its user's signing identity, the
# microphone and camera for its commands, and screen capture with no
# per-user notice, at the box's start.
vm_ready() { # user
  number "$(id -u "$1" 2>/dev/null)" || quit 2 "There is no user $1."
  mkdir -p "$STATE"
  signing_identity "$1" "$(id -u "$1")" || :
  default_grants "$1" || :
  home=$(attribute "$1" NFSHomeDirectory)
  if [ -n "$home" ] && screen_approvals "$ROOT$home"; then
    chown -R "$(id -u "$1"):20" "$ROOT$home/Library/Group Containers/group.com.apple.replayd"
  fi
  if [ "$(cat "$STATE/signing" 2>/dev/null)" = "$1" ]; then echo signing=1; else echo signing=0; fi
}

# A VM's grants, for box_status, as granted gives them.
vm_granted() { # user
  if sip_off; then echo sip=0; else echo sip=1; fi
  if [ "$(cat "$STATE/signing" 2>/dev/null)" = "$1" ]; then echo signing=1; else echo signing=0; fi
  [ ! -f "$STATE/grants" ] || awk '!seen[$0]++ { print "grant=" $0 }' "$STATE/grants"
}

# Starts the reset generation at 0 and, on a free Mac, makes its box user and
# sets it as the automatic login. With nobody at the console, loginwindow
# starts again and signs the user in. A person signed in there restarts the
# Mac instead.
init() {
  lock 60
  number "$(generation)" || echo 0 | put "$STATE/generation"
  current=$(generation)
  if [ ! -e "$STATE/owner" ] && [ ! -e "$STATE/resetting" ]; then
    user=$PREFIX$current
    ready_user "$user" "$((ID_BASE + current % ID_SPAN))" || fail "Could not make box user $user."
    automatic_login "$user"
    [ "$(console)" != root ] || launchctl kickstart -k system/com.apple.loginwindow >/dev/null 2>&1
  fi
  echo "generation=$current"
}

[ "$(id -u)" = 0 ] || quit 2 "Run it as root, through sudo."
command -v perl >/dev/null 2>&1 || quit 1 "perl is missing, and the helper locks with it."
verb=${1:-}
[ $# -eq 0 ] || shift
case $verb in
  status) status "$@" ;;
  claim) claim "$@" ;;
  grant) grant "$@" ;;
  release) release "$@" ;;
  reset) reset "$@" ;;
  display) display "$@" ;;
  granted) granted "$@" ;;
  vm-ready | vm-grant | vm-granted)
    [ $# -eq 1 ] && [ -n "$1" ] || quit 2 "usage: machine $verb <user>"
    case $verb in vm-ready) vm_ready "$1" ;; vm-grant) grant "$1" ;; vm-granted) vm_granted "$1" ;; esac
    ;;
  init) init ;;
  version) echo "$VERSION" ;;
  *) quit 2 "usage: machine status [grants] | claim | grant | granted | release | reset | display | vm-ready | vm-grant | vm-granted | init | version" ;;
esac
