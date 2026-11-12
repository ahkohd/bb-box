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

VERSION=4
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
DEVICE_HOST=$ROOT/usr/local/libexec/bb-box/device-host
SLOTS_STATE=$STATE/host
EXIT_LENT_WHOLE=7
EXIT_SLOTS_HELD=3
CONTAINERS_PROCESS=containermanagerd
HOMES=/Users
SNAPSHOT_PROBE=1
SNAPSHOT_HOOK=$ROOT/usr/local/libexec/bb-box/snapshot-machine
SNAPSHOT_HOOK_SECONDS=30
SNAPSHOT_HOOK_GRACE_SECONDS=2
SNAPSHOT_HOOK_OUT=$STATE/snapshot-hook.out.$$
SNAPSHOT_HOOK_ERR=$STATE/snapshot-hook.err
SNAPSHOT_REPORT=$STATE/snapshots
CLONE_TRIALS=$STATE/snapshot-trials
CLONE_TRIAL=$CLONE_TRIALS/$$
STOPS_ITSELF_ON_A_SIGN='until (-e $ARGV[0]) { select(undef, undef, undef, 0.05) } kill "STOP", $$; sleep 600'
STOPS_LATE_ABOVE='use POSIX ":sys_wait_h"; $| = 1; my $child = fork(); if (!$child) { exec @ARGV[1 .. $#ARGV] } print "$child\n"; while (1) { last if waitpid($child, WUNTRACED) <= 0; last unless WIFSTOPPED(${^CHILD_ERROR_NATIVE}); sleep $ARGV[0]; kill "STOP", $$ }'
IN_OWN_SESSION='use POSIX (); POSIX::setsid() >= 0 or exit 126; exec { $ARGV[0] } @ARGV or exit 127'
HOME_SNAPSHOTS=$STATE/home-snapshots
CLONE_TREE=$ROOT/usr/local/libexec/bb-box/clone-tree
EXIT_NO_SNAPSHOT=4
EXIT_REFUSED=5
EXIT_SIGNING_IN=10
RESTORE_SIGN_IN_SECONDS=30
PROOF_NAME_PREFIX=bbbox-probe-
PROOF_UID_BASE=90000
PROOF_UID_SPAN=10000
PROOF_PICKS=20
PROOF_RECORD=$STATE/proof-made
PROOF_LATE_STOP_SECONDS=3
NEWLINE='
'
DEVICE_HOST_LOCK=$SLOTS_STATE/lock
SLOT_HOLDER_PREFIX=slot-
SLOT_PREFIX=bbd-
SLOT_UID_BASE=80000
SLOT_UID_SPAN=10000
SLOT_LOCK_SECONDS=60
IOS_SHARE=$ROOT/usr/local/share/bb-box/ios
SIM_STORES=$ROOT/private/var/tmp
PROOF_DEVICE_BOOT_SECONDS=180
EXIT_NOT_OURS=4
DEVICE_HOST_WAIT_SECONDS=60
PAUSE_LOCK=$STATE/pause-lock
PAUSE_ROUNDS=5
PARENT_STOP_SECONDS=0.2
PARENT_STOP_CHECKS=5
PARENT_SETTLE_SECONDS=60

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
  lock_open_file 9 "$1" || quit 3 "Another bb-box command holds the Mac's lock."
}

lock_open_file() {
  perl -e 'use Fcntl ":flock"; open(my $f, ">&=", $ARGV[0]) or exit 1; $SIG{ALRM} = sub { exit 3 }; alarm $ARGV[1]; flock($f, $ARGV[1] ? LOCK_EX : LOCK_EX | LOCK_NB) or exit 3' "$@"
}

SIGNALS_ITS_CHILD_ONLY_WHILE_UNREAPED='use POSIX ":sys_wait_h"; use Time::HiRes qw(time sleep); my $seconds = shift; my $child = fork; defined $child or exit 1; if (!$child) { exec { $ARGV[0] } @ARGV or exit 127 } my $deadline = time + $seconds; my $sent = 0; while (waitpid($child, WNOHANG) == 0) { if (!$sent && time >= $deadline) { kill "TERM", $child; $sent = 1 } sleep 0.02 } exit($? & 127 ? 128 + ($? & 127) : $? >> 8)'

within() {
  perl -e "$SIGNALS_ITS_CHILD_ONLY_WHILE_UNREAPED" "$@" </dev/null 9>&-
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
      "$ROOT/Library/Managed Preferences"/"$PREFIX"* "$HOME_SNAPSHOTS"/"$PREFIX"*; do
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
  for path in "$ROOT"/Users/"$PREFIX"* "$ROOT"/etc/sudoers.d/"$PREFIX"* "$ROOT"/private/var/at/tabs/"$PREFIX"* "$STATE"/passwords/"$PREFIX"* "$HOME_SNAPSHOTS"/*; do
    [ -e "$path" ] && [ "${path##*/}" != "$ready" ] && ! the_store_of_a_slot_the_mac_still_has "$path" && echo "${path#"$ROOT"}"
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

volume_of() { df "$1" 2>/dev/null | awk 'NR == 2 { print $1 }'; }
homes_filesystem() { diskutil info "$(volume_of "$ROOT$HOMES")" 2>/dev/null | sed -n 's/^ *Type (Bundle): *//p' | head -n 1; }
homes_free_kib() { df -Pk "$ROOT$HOMES" 2>/dev/null | awk 'NR == 2 { print $4 }'; }

left_of_trial() {
  left=''
  for object in "$1/clone" "$1/trial" "$1"; do
    [ ! -e "$object" ] || left="$left $object"
  done
  printf '%s\n' "${left# }"
}

remove_trial() {
  rm -f "$1/clone" "$1/trial" 2>/dev/null
  rmdir "$1" 2>/dev/null
  left_of_trial "$1"
}

trials_folder_is_the_helpers() {
  [ -d "$CLONE_TRIALS" ] || mkdir -m 700 "$CLONE_TRIALS" 2>/dev/null
  [ -d "$CLONE_TRIALS" ] && [ ! -L "$CLONE_TRIALS" ] && [ "$(stat -f %u "$CLONE_TRIALS" 2>/dev/null)" = 0 ]
}

abandoned_trials() {
  for trial in "$CLONE_TRIALS"/*; do
    probe=${trial##*/}
    [ -d "$trial" ] && number "$probe" && ! kill -0 "$probe" 2>/dev/null && printf '%s\n' "$trial"
  done
}

remove_abandoned_trials() {
  for trial in $(abandoned_trials); do
    left=$(remove_trial "$trial")
    [ -z "$left" ] || trial_left="$trial_left $left"
  done
}

try_clone_trial() {
  if ! mkdir "$CLONE_TRIAL" 2>/dev/null; then
    trial_failed="the helper could not make $CLONE_TRIAL"
  elif ! printf 'trial\n' 2>/dev/null >"$CLONE_TRIAL/trial"; then
    trial_failed="the helper could not write $CLONE_TRIAL/trial"
  elif ! said=$(cp -c "$CLONE_TRIAL/trial" "$CLONE_TRIAL/clone" 2>&1); then
    trial_failed=$(printf '%s\n' "$said" | tail -n 1)
  fi
}

clone_trial() {
  trial_failed='' trial_left=''
  if ! trials_folder_is_the_helpers; then
    trial_failed="$CLONE_TRIALS is not a folder of root's own: remove it"
    return 1
  fi
  remove_abandoned_trials
  try_clone_trial
  trial_left=$(printf '%s %s\n' "$trial_left" "$(remove_trial "$CLONE_TRIAL")" | sed 's/^ *//; s/ *$//')
  [ -z "$trial_failed" ] && [ -z "$trial_left" ]
}

trial_left_words() {
  printf 'the helper could not remove its trial, which leaves %s: as root, delete each file there with rm, then its folder with rmdir' "$(printf '%s\n' "$trial_left" | sed 's/ /, /g')"
}

home_snapshots() {
  filesystem=$1
  if [ "$filesystem" != apfs ]; then
    echo snapshot.home=no
  elif ! full_disk; then
    printf 'snapshot.home=no\nsnapshot.home.why=box homes are on APFS under %s, but the helper lacks Full Disk Access, which it needs to clone the folders macOS protects in a home\n' "$HOMES"
  elif clone_trial; then
    printf 'snapshot.home=yes\nsnapshot.home.how=apfs\n'
  elif [ -n "$trial_left" ]; then
    printf 'snapshot.home=no\nsnapshot.home.why=box homes are on APFS under %s, but %s\nsnapshot.left=%s\n' "$HOMES" "$(trial_left_words)" "$trial_left"
  else
    printf 'snapshot.home=no\nsnapshot.home.why=box homes are on APFS under %s, but a trial clone failed: %s\n' "$HOMES" "$trial_failed"
  fi
}

hook_running() { kill -0 "$1" 2>/dev/null || kill -s 0 -- "-$1" 2>/dev/null; }

end_hook() {
  kill -s TERM -- "-$1" 2>/dev/null
  grace=$((SNAPSHOT_HOOK_GRACE_SECONDS * 10))
  while [ "$grace" -gt 0 ] && hook_running "$1"; do
    sleep 0.1
    grace=$((grace - 1))
  done
  kill -s KILL -- "-$1" 2>/dev/null
}

describe_within_deadline() {
  perl -e "$IN_OWN_SESSION" "$SNAPSHOT_HOOK" describe </dev/null >"$SNAPSHOT_HOOK_OUT" 2>"$SNAPSHOT_HOOK_ERR" 9>&- &
  hook=$!
  sleep "$SNAPSHOT_HOOK_SECONDS" </dev/null >/dev/null 2>&1 9>&- &
  deadline=$!
  while hook_running "$hook" && kill -0 "$deadline" 2>/dev/null; do sleep 0.1; done
  hook_timed_out=no
  if hook_running "$hook"; then
    hook_timed_out=yes
    end_hook "$hook"
  fi
  kill "$deadline" 2>/dev/null
  wait "$deadline" 2>/dev/null
  wait "$hook"
  hook_code=$?
  hook=''
}

hook_said() { tail -n 2 "$SNAPSHOT_HOOK_ERR" 2>/dev/null | tr '\n' ' ' | sed 's/ *$//'; }

snapshot_hook() {
  if [ ! -x "$SNAPSHOT_HOOK" ]; then
    echo snapshot.hook=none
    return
  fi
  describe_within_deadline 2>/dev/null
  if [ "$hook_timed_out" = yes ]; then
    printf 'snapshot.hook=failed\nsnapshot.hook.why=it did not finish within %s seconds, so the helper stopped it and everything it started\n' "$SNAPSHOT_HOOK_SECONDS"
  elif [ "$hook_code" = 0 ]; then
    printf 'snapshot.hook=found\nsnapshot.hook.describe=%s\n' "$(tr -d '\n' <"$SNAPSHOT_HOOK_OUT")"
  else
    printf 'snapshot.hook=failed\nsnapshot.hook.why=it exited with %s: %s\n' "$hook_code" "$(hook_said)"
  fi
  rm -f "$SNAPSHOT_HOOK_OUT"
}

snapshot_report() {
  filesystem=$(homes_filesystem)
  echo "snapshot.probe=$SNAPSHOT_PROBE"
  echo "snapshot.at=$(date +%s)"
  echo "snapshot.homes=$HOMES"
  echo "snapshot.filesystem=$filesystem"
  echo "snapshot.free_kib=$(homes_free_kib)"
  home_snapshots "$filesystem"
  snapshot_hook
}

remove_abandoned_probe_files() {
  for file in "$SNAPSHOT_REPORT.new."* "$STATE/snapshot-hook.out."*; do
    probe=${file##*.}
    [ -f "$file" ] && number "$probe" && ! kill -0 "$probe" 2>/dev/null && rm -f "$file"
  done
}

end_snapshot_probe() {
  [ -z "${hook:-}" ] || end_hook "$hook"
  [ ! -d "$CLONE_TRIAL" ] || remove_trial "$CLONE_TRIAL" >/dev/null
  rm -f "$SNAPSHOT_HOOK_OUT" "$SNAPSHOT_REPORT.new.$$"
}

probe_snapshots() {
  mkdir -p "$STATE"
  trap end_snapshot_probe EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  remove_abandoned_probe_files
  snapshot_report >"$SNAPSHOT_REPORT.new.$$"
  mv -f "$SNAPSHOT_REPORT.new.$$" "$SNAPSHOT_REPORT"
  cat "$SNAPSHOT_REPORT"
}

pausing_user=''
then_on_exit=''
when_a_user_is_made=''
on_a_half_made_user=remove_half_made_user
on_what_changed=say_what_changed
which_temporary_entries=every_temporary_entry
proof_fork_identity=''
lent_slot=''
holder_record=$STATE/owner

helper_exit() {
  code=$?
  trap - EXIT
  [ -z "$pausing_user" ] || resume_user "$pausing_user"
  [ -z "$then_on_exit" ] || "$then_on_exit" "$code"
  exit "$code"
}

exit_cleanly() {
  trap helper_exit EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'; }

snapshot_name_ok() {
  case ${1:-} in '' | .* | *[!A-Za-z0-9_-]*) return 1 ;; esac
  [ "${#1}" -le 64 ]
}

store_of() { printf '%s\n' "$HOME_SNAPSHOTS/$1"; }

store_is_the_helpers() {
  [ -d "$HOME_SNAPSHOTS" ] || mkdir -m 700 "$HOME_SNAPSHOTS" 2>/dev/null
  [ -d "$HOME_SNAPSHOTS" ] && [ ! -L "$HOME_SNAPSHOTS" ] && [ "$(stat -f %u "$HOME_SNAPSHOTS" 2>/dev/null)" = 0 ]
}

ready_store() {
  store_is_the_helpers || fail "$HOME_SNAPSHOTS is not a folder of root's own. Remove it, then try again."
  chmod 700 "$HOME_SNAPSHOTS"
  store=$(store_of "$1")
  [ -d "$store" ] || mkdir -m 700 "$store" || fail "Could not make $store."
  [ ! -L "$store" ] || fail "$store is a link. Remove it, then try again."
}

clear_flags_and_acls_of() {
  tree=$1
  shift
  find "$tree" -xdev "$@" -exec sh -c 'chflags -h nouchg,nouappnd,noschg "$@" 2>/dev/null; chmod -h -N "$@" 2>/dev/null; exit 0' sh {} +
}

hard_links_left_after_unlinking_them_as_they_are() {
  find "$1" -xdev ! -type d -links +1 2>/dev/null | while IFS= read -r link; do
    perl -e 'unlink $ARGV[0] or exit 1' "$link" 2>/dev/null || printf '%s\n' "$link"
  done
}

remove_tree() {
  [ -e "$1" ] || [ -L "$1" ] || return 0
  [ ! -d "$1" ] || [ -L "$1" ] || clear_flags_and_acls_of "$1" -type d
  left_links=$(hard_links_left_after_unlinking_them_as_they_are "$1")
  if [ -n "$left_links" ]; then
    printf '%s\n' "$left_links" | head -n 5 | while IFS= read -r link; do
      echo "note: left $link, a hard link to a file that is also outside $1, as it cannot be unlinked as it is; the helper changed none of its flags or ACLs" >&2
    done
    return 1
  fi
  clear_flags_and_acls_of "$1" ! -type d
  rm -rf "$1" 2>/dev/null
  absent "$1"
}

clone_tree() {
  if [ -x "$CLONE_TREE" ]; then "$CLONE_TREE" "$1" "$2"; else ditto --clone "$1" "$2"; fi
}

acl_entries() { ls -led "$1" 2>/dev/null | sed -n 's/^ *[0-9][0-9]*: //p'; }

tab() { printf '\t'; }

kept_acls() {
  home=$1
  find "$home" -acl 2>/dev/null | while IFS= read -r path; do
    case $path in *"$(tab)"*) continue ;; esac
    relative=${path#"$home"}
    acl_entries "$path" | while IFS= read -r entry; do
      case $entry in
        *' inherited '*) printf '%s\t+ai\t%s\n' "${relative:-/}" "$(printf '%s' "$entry" | sed 's/ inherited / /')" ;;
        *) printf '%s\t+a\t%s\n' "${relative:-/}" "$entry" ;;
      esac
    done
  done
}

put_back_acls() {
  acls=$1 home=$2
  [ -s "$acls" ] || return 0
  cut -f 1 "$acls" | sort -u | while IFS= read -r relative; do
    [ "$relative" = / ] && relative=''
    chmod -N "$home$relative" 2>/dev/null
  done
  while IFS="$(tab)" read -r relative way entry; do
    [ "$relative" = / ] && relative=''
    chmod "$way" "$entry" "$home$relative" 2>/dev/null || echo "$relative"
  done <"$acls" | head -n 1
}

paused_marker() { printf '%s\n' "$(store_of "$1")/.paused"; }

process_table() {
  ps -A -o pid=,ppid=,uid=,stat=,lstart= 2>/dev/null | awk 'NF >= 9 { printf "%s %s %s %s %s_%s_%s_%s_%s\n", $1, $2, $3, $4, $5, $6, $7, $8, $9 }'
}

identity_now() {
  case $1 in
    process) printf '%s\n' "$checked_table" | awk -v p="$2" '$1 == p { print $5; found = 1; exit } END { if (!found) print "gone" }' ;;
    account)
      if ! directory; then
        echo unknown
      elif ! dscl . -read "/Users/$2" >/dev/null 2>&1; then
        echo gone
      else
        echo "$(attribute "$2" UniqueID):$(attribute "$2" GeneratedUID)"
      fi
      ;;
    object)
      if absent "$2"; then echo gone; else object_id "$2" || echo unknown; fi
      ;;
  esac
}

say_what_changed() { echo "note: left $1 $2, as it is not what was recorded" >&2; }

change_only_what_is_still() {
  checked_kind=$1 checked_action=$2 checked_failed=no checked_table=''
  [ "$checked_kind" != process ] || checked_table=$(process_table)
  while read -r checked_recorded checked_target; do
    [ -n "$checked_target" ] || continue
    checked_now=$(identity_now "$checked_kind" "$checked_target")
    if [ "$checked_now" = gone ]; then
      continue
    elif [ "$checked_now" = "$checked_recorded" ]; then
      "$checked_action" "$checked_target" </dev/null || checked_failed=yes
    elif [ "$checked_kind" != process ]; then
      "$on_what_changed" "$checked_kind" "$checked_target" "$checked_now" </dev/null
      checked_failed=yes
    fi
  done
  [ "$checked_failed" = no ]
}

stop_process() { kill -STOP "$1" 2>/dev/null; }
continue_process() { kill -CONT "$1" 2>/dev/null; }
end_process() { kill -KILL "$1" 2>/dev/null; }

remove_object() {
  if [ -d "$1" ] && [ ! -L "$1" ]; then remove_tree "$1"; else rm -f "$1" 2>/dev/null && absent "$1"; fi
}

remove_as_it_stands() { rm -rf "$1" 2>/dev/null; absent "$1"; }

remove_empty_folder() { rmdir "$1" 2>/dev/null || holds_others "$1"; }

holds_others() { [ -n "$(ls -A "$1" 2>/dev/null)" ]; }

hold_pause_lock() {
  mkdir -p "$STATE"
  exec 8>>"$PAUSE_LOCK"
  lock_open_file 8 "$1"
}

let_go_of_pause_lock() { exec 8>&-; }

box_processes_to_pause() {
  awk -v box="$2" -v me=$$ '
    FILENAME == ARGV[1] { if ($1 == "take") split("", recorded); else recorded[$2 " " $3] = 1; next }
    { parent[$1] = $2; owner[$1] = $3; state[$1] = $4; started[$1] = $5; order[++count] = $1 }
    function running(pid) { return state[pid] !~ /^[TZ]/ }
    function record(kind, pid) { recorded[pid " " started[pid]] = 1; print kind, pid, started[pid] }
    END {
      for (i = 1; i <= count; i++) {
        pid = order[i]
        if (owner[pid] != box || pid == me || !running(pid) || ((pid " " started[pid]) in recorded)) continue
        record("box", pid)
        steps = 0
        for (above = parent[pid]; above > 1 && (above in owner) && steps < 64; above = parent[above]) {
          steps++
          if (owner[above] == box || above == me || !running(above) || ((above " " started[above]) in recorded)) continue
          record("parent", above)
        }
      }
    }' "$1" -
}

pause_user() {
  user=$1 uid=$2
  journal=$(paused_marker "$user")
  hold_pause_lock 60 || fail "Another take is pausing $user's processes."
  resume_journal "$journal"
  carry_unsettled_into_this_take "$journal"
  pausing_user=$user
  rounds=0
  while [ "$rounds" -lt "$PAUSE_ROUNDS" ]; do
    round=$(process_table | box_processes_to_pause "$journal" "$uid")
    [ -n "$round" ] || break
    printf '%s\n' "$round" >>"$journal"
    change_only_what_is_still process stop_process <<ROUND
$(printf '%s\n' "$round" | awk '$1 == "box" { print $3, $2 }')
ROUND
    rounds=$((rounds + 1))
  done
}

carry_unsettled_into_this_take() {
  { grep -v '^settle ' "$1" 2>/dev/null; echo "take $$"; } | put "$1"
}

journal_step() {
  process_table | awk -v now="$(now)" -v settle="$PARENT_SETTLE_SECONDS" '
    FILENAME == ARGV[1] {
      if ($1 == "settle") since = $2
      else if ($1 == "box" || $1 == "parent" || $1 == "resumed") {
        key = $2 " " $3
        if (!(key in kind)) order[++count] = key
        if (!(key in kind) || $1 == "parent") kind[key] = $1
      }
      next
    }
    { state[$1 " " $5] = $4 }
    END {
      if (since == "") since = now
      settled = now - since >= settle
      print "keep settle " since
      for (i = 1; i <= count; i++) {
        key = order[i]
        if (!(key in state)) continue
        if (state[key] ~ /^T/) {
          split(key, recorded, " ")
          print "continue " recorded[2], recorded[1]
          print "keep resumed " key
        } else if (!settled && kind[key] == "parent") print "keep parent " key
      }
    }' "$1" -
}

step_journal() {
  step=$(journal_step "$1")
  printf '%s\n' "$step" | sed -n 's/^keep //p' | put "$1"
  resumed=$(printf '%s\n' "$step" | sed -n 's/^continue //p')
  change_only_what_is_still process continue_process <<RESUMED
$resumed
RESUMED
  printf '%s\n' "$resumed"
}

journal_holds_processes() { grep -q -e '^box ' -e '^parent ' -e '^resumed ' "$1" 2>/dev/null; }

resume_journal() {
  journal=$1
  [ -f "$journal" ] || return 0
  checks=0 watching=no
  while :; do
    [ -z "$(step_journal "$journal")" ] || watching=yes
    [ "$checks" -gt 0 ] || resumed_at_ms=$(now_ms)
    [ "$watching" = yes ] && [ "$checks" -lt "$PARENT_STOP_CHECKS" ] || break
    checks=$((checks + 1))
    sleep "$PARENT_STOP_SECONDS"
  done
  journal_holds_processes "$journal" || rm -f "$journal"
}

resume_user() {
  resume_journal "$(paused_marker "$1")"
  [ "$pausing_user" != "$1" ] || { pausing_user='' && let_go_of_pause_lock; }
}

abandoned_pauses() {
  for journal in "$HOME_SNAPSHOTS"/*/.paused; do [ -f "$journal" ] && printf '%s\n' "$journal"; done
  return 0
}

resume_abandoned_pauses() {
  [ -n "$(abandoned_pauses)" ] || return 0
  hold_pause_lock 0 || return 0
  for journal in $(abandoned_pauses); do resume_journal "$journal"; done
  let_go_of_pause_lock
}

slot_of_holder() {
  case ${1:-} in "$SLOT_HOLDER_PREFIX"*) printf '%s\n' "${1#"$SLOT_HOLDER_PREFIX"}" ;; *) return 1 ;; esac
}

lent_user() {
  if lent_slot=$(slot_of_holder "$1"); then slot_lent_to_the_box "$lent_slot"; else mac_lent_to_the_box "$1"; fi
}

mac_lent_to_the_box() {
  expected=$1 lent_slot=''
  number "$expected" || quit 2 "The snapshot command needs the Mac's generation, or slot-<n> for an iOS slot."
  [ -n "$box" ] || quit 2 "The snapshot command needs box=."
  [ -e "$STATE/owner" ] || quit 4 "No box holds the Mac."
  [ "$(field "$STATE/owner" install)" = "$install" ] && [ "$(field "$STATE/owner" box)" = "$box" ] &&
    [ "$(field "$STATE/owner" generation)" = "$expected" ] || quit 4 "Another box holds the Mac."
  user=$(field "$STATE/owner" user) uid=$(field "$STATE/owner" uid)
  box_uid "$uid" && [ "$(attribute "$user" UniqueID)" = "$uid" ] || fail "Box user $user is not on the Mac."
  holder_record=$STATE/owner
}

slot_folder() { printf '%s\n' "$SLOTS_STATE/slots/$1"; }

a_slot_number() { number "${1:-}" && [ "$1" -gt 0 ] && [ "$1" -lt "$SLOT_UID_SPAN" ]; }

recorded_generated_uid_of_slot() { field "$(slot_folder "$1")/user-made" generated_uid; }

slot_user_the_device_host_made() {
  made_slot=$1 made_name=$2 made_uid=$3
  a_slot_number "$made_slot" && [ "$made_name" = "$SLOT_PREFIX$made_slot" ] && [ "$made_uid" = $((SLOT_UID_BASE + made_slot)) ] &&
    [ -e "$(slot_folder "$made_slot")/user-made" ] && [ "$(field "$(slot_folder "$made_slot")/slot" user)" = "$made_name" ] &&
    [ "$(field "$(slot_folder "$made_slot")/slot" uid)" = "$made_uid" ] || return 1
  made_guid=$(recorded_generated_uid_of_slot "$made_slot")
  [ -n "$made_guid" ] && [ "$(identity_now account "$made_name")" = "$made_uid:$made_guid" ]
}

a_slot_user_the_device_host_made() {
  case $1 in "$SLOT_PREFIX"*) slot_user_the_device_host_made "${1#"$SLOT_PREFIX"}" "$1" "$2" ;; *) return 1 ;; esac
}

the_store_of_a_slot_the_mac_still_has() {
  case $1 in "$HOME_SNAPSHOTS/$SLOT_PREFIX"*) ;; *) return 1 ;; esac
  kept_slot=${1##*/}
  kept_slot=${kept_slot#"$SLOT_PREFIX"}
  a_slot_number "$kept_slot" && [ "$(field "$(slot_folder "$kept_slot")/slot" user)" = "$SLOT_PREFIX$kept_slot" ]
}

slot_lent_to_the_box() {
  a_slot_number "$1" || quit 2 "The snapshot command needs the Mac's generation, or slot-<n> for an iOS slot."
  [ -n "$box" ] || quit 2 "The snapshot command needs box=."
  slots_set_up || quit 4 "The Mac lends no iOS slots."
  folder=$(slot_folder "$1")
  [ -f "$folder/slot" ] || quit 4 "The Mac has no iOS slot $1."
  [ "$(field "$folder/state" is)" = held ] || quit 4 "No box holds iOS slot $1."
  [ "$(field "$folder/claim" install)" = "$install" ] && [ "$(field "$folder/claim" box)" = "$box" ] || quit 4 "Another box holds iOS slot $1."
  user=$(field "$folder/slot" user) uid=$(field "$folder/slot" uid)
  [ -n "$(recorded_generated_uid_of_slot "$1")" ] ||
    quit "$EXIT_REFUSED" "iOS slot $1 was made by an older slot helper, which kept no record of its user's GeneratedUID, so it has no snapshots. It lends as before. Slots made after the update have snapshots."
  slot_user_the_device_host_made "$1" "$user" "$uid" || fail "iOS slot $1's user is not the one the device host made: its UID or GeneratedUID differs from the record, so the helper takes no snapshot of it and ends none of its processes."
  holder_record=$folder/claim
}

hold_the_slots_lock() {
  folder=$(slot_folder "$1")
  [ -f "$folder/slot" ] || quit 4 "The Mac has no iOS slot $1."
  exec 5>>"$folder/lock"
  lock_open_file 5 "$2" || quit 3 "Another bb-box command is working on iOS slot $1; ask again."
}

hold_for() {
  if holder_slot=$(slot_of_holder "$1"); then
    a_slot_number "$holder_slot" || quit 2 "The snapshot command needs the Mac's generation, or slot-<n> for an iOS slot."
    hold_the_slots_lock "$holder_slot" "$SLOT_LOCK_SECONDS"
  else
    lock "$2"
  fi
}

hold_a_slot_users_store() {
  case $1 in "$SLOT_PREFIX"*) ;; *) return 0 ;; esac
  store_slot=${1#"$SLOT_PREFIX"}
  a_slot_number "$store_slot" && [ -f "$(slot_folder "$store_slot")/slot" ] || return 0
  hold_the_slots_lock "$store_slot" "$2"
}

stopped_for_the_restore() {
  [ -f "$(session_file "$1")" ] || return 1
  [ -z "$lent_slot" ] || [ -e "$(slot_folder "$lent_slot")/stopped" ]
}

device_host_under_the_slots_lock() {
  printf 'install=%s\nbox=%s\n' "$install" "$box" | /bin/sh "$DEVICE_HOST" "$@" 8>&5 5>&- 6>&- 9>&-
}

session_file() { printf '%s\n' "$(store_of "$1")/.session"; }

taken_line() {
  dir=$1
  printf 'snapshot=%s\n' "${dir##*/}"
  printf 'captured=%s\n' "$(field "$dir/info" captured)"
  printf 'paused_ms=%s\n' "$(field "$dir/info" paused_ms)"
}

snapshot_info() {
  printf 'install=%s\nbox=%s\nuser=%s\nuid=%s\ncaptured=%s\npaused_ms=%s\n' "$install" "$box" "$1" "$2" "$3" "$4"
  for key in thread name kind created; do printf '%s=%s\n' "$key" "$(field "$holder_record" "$key")"; done
  [ -z "$lent_slot" ] || printf 'slot=%s\nslot_made=%s\n' "$lent_slot" "$(field "$(slot_folder "$lent_slot")/slot" made)"
}

clone_home() {
  user=$1 uid=$2 dir=$3 pause=$4
  home=$ROOT/Users/$user
  [ -d "$home" ] || fail "Box user $user has no home folder."
  partial=$dir.partial
  remove_tree "$partial" || fail "Could not remove $partial, which an earlier take left."
  mkdir -m 700 "$partial" || fail "Could not make $partial."
  echo $$ >"$partial/taker"
  snapshot_info "$user" "$uid" '' 0 >"$partial/info"
  paused_ms=0
  captured=$(now_ms)
  if [ "$pause" = pause ]; then
    captured=$(now_ms)
    pause_user "$user" "$uid"
  fi
  cloned=yes
  said=$(exec 8>&-; clone_tree "$home" "$partial/home" 2>&1) || cloned=no
  if [ "$pause" = pause ]; then
    resumed_at_ms=''
    resume_user "$user"
    paused_ms=$((${resumed_at_ms:-$(now_ms)} - captured))
  fi
  if [ "$cloned" = no ]; then
    remove_tree "$partial"
    fail "Could not clone $user's home: $(printf '%s\n' "$said" | tail -n 1)"
  fi
  kept_acls "$home" >"$partial/acls"
  snapshot_info "$user" "$uid" "$captured" "$paused_ms" | put "$partial/info"
  rm -f "$partial/taker"
  mv "$partial" "$dir" || fail "Could not keep the snapshot in $dir."
}

take_home() {
  user=$1 uid=$2 id=$3
  ready_store "$user"
  dir=$(store_of "$user")/$id
  if [ ! -d "$dir/home" ]; then
    pause=pause
    ! stopped_for_the_restore "$user" || pause=stopped
    clone_home "$user" "$uid" "$dir" "$pause"
  fi
  taken_line "$dir"
}

end_slot_session() {
  user=$1
  ready_store "$user"
  session=$(session_file "$user")
  [ -f "$session" ] || printf 'console=no\nautologin=no\nslot=%s\nsince=%s\n' "$lent_slot" "$(now)" | put "$session"
  resume_user "$user"
  said=$(device_host_under_the_slots_lock stop "$lent_slot" 2>&1)
  case $? in
    0) ;;
    4) quit 4 "$(printf '%s\n' "$said" | tail -n 1)" ;;
    *) fail "Could not stop iOS slot $lent_slot for the restore: $(printf '%s\n' "$said" | tail -n 1)" ;;
  esac
  echo stopped=yes
  echo console=no
}

start_slot_session() {
  user=$1
  said=$(device_host_under_the_slots_lock start "$lent_slot" 2>&1)
  code=$?
  [ -e "$(slot_folder "$lent_slot")/stopped" ] || rm -f "$(session_file "$user")"
  case $code in
    0) ;;
    4) quit 4 "$(printf '%s\n' "$said" | tail -n 1)" ;;
    *) fail "$(printf '%s\n' "$said" | grep -v -e '^started=' -e '^booted=' | tail -n 1)" ;;
  esac
  echo started=yes
  echo console=
  printf '%s\n' "$said" | grep '^booted='
}

end_session() {
  user=$1 uid=$2
  [ -z "$lent_slot" ] || { end_slot_session "$user"; return; }
  ready_store "$user"
  session=$(session_file "$user")
  if [ ! -f "$session" ]; then
    at_console=no autologin=no
    [ "$(console)" != "$user" ] || at_console=yes
    [ "$(defaults read "$LOGINWINDOW" autoLoginUser 2>/dev/null)" != "$user" ] || autologin=yes
    printf 'console=%s\nautologin=%s\nsince=%s\n' "$at_console" "$autologin" "$(now)" | put "$session"
  fi
  if [ "$(defaults read "$LOGINWINDOW" autoLoginUser 2>/dev/null)" = "$user" ]; then
    defaults delete "$LOGINWINDOW" autoLoginUser >/dev/null 2>&1
    [ "$(defaults read "$LOGINWINDOW" autoLoginUser 2>/dev/null)" != "$user" ] || fail "Could not clear the automatic login, so the Mac would sign $user in again during its restore."
  fi
  resume_user "$user"
  log_out "$user" "$uid" || fail "Could not end every process of $user, as the notes above say, so its session goes on."
  echo stopped=yes
  echo "console=$(field "$session" console)"
}

born_after() {
  born=$(stat -f %B "$1" 2>/dev/null) && number "$born" && [ "$born" -gt "$2" ]
}

one_line() { case $1 in *"$NEWLINE"*) return 1 ;; *) return 0 ;; esac; }

made_by_the_box_user() {
  ! absent "$1" && one_line "$1" && owned_by "$1" "$temporary_uid" && born_after "$1" "$temporary_user_born"
}

a_folder_of_the_box_user() { [ -d "$1" ] && [ ! -L "$1" ] && made_by_the_box_user "$1"; }

account_made_at() {
  dscl . -read "/Users/$1" accountPolicyData 2>/dev/null | tr -d ' \t\n' | sed -n 's|.*<key>creationTime</key><real>\([0-9]*\).*|\1|p'
}

temporary_entries_of() {
  temporary_uid=$2
  temporary_user_born=$(account_made_at "$1")
  number "$temporary_user_born" || return 0
  find "$DATA/private/var/folders" -mindepth 2 -maxdepth 2 -type d -uid "$temporary_uid" 2>/dev/null | while IFS= read -r folder; do
    a_folder_of_the_box_user "$folder" || continue
    for kind in T C; do
      a_folder_of_the_box_user "$folder/$kind" || continue
      for entry in "$folder/$kind"/* "$folder/$kind"/.[!.]* "$folder/$kind"/..?*; do
        made_by_the_box_user "$entry" && printf '%s %s\n' "$(object_id "$entry")" "$entry"
      done
    done
  done
  return 0
}

every_temporary_entry() { cat; }

clear_temporary_folders() {
  cleared=$(temporary_entries_of "$1" "$2" | "$which_temporary_entries")
  change_only_what_is_still object remove_as_it_stands <<CLEARED
$cleared
CLEARED
  return 0
}

swap_home() {
  user=$1 uid=$2 snapshot=$3
  store=$(store_of "$user")
  home=$ROOT/Users/$user
  aside=$store/.replaced
  staged=$store/.restoring
  if [ ! -d "$aside" ]; then
    remove_tree "$staged" || fail "Could not remove $staged, which an earlier restore left."
    said=$(clone_tree "$snapshot/home" "$staged" 2>&1) || fail "Could not clone the snapshot for $user's home: $(printf '%s\n' "$said" | tail -n 1)"
    unset_acl=$(put_back_acls "$snapshot/acls" "$staged")
    [ -z "$unset_acl" ] || fail "Could not put back the ACLs of ${unset_acl:-the home} in $user's restored home."
    if [ -e "$home" ]; then mv "$home" "$aside" || fail "Could not move $user's home aside."; else mkdir -m 700 "$aside"; fi
  fi
  if [ ! -e "$home" ]; then
    [ -d "$staged" ] || fail "$user's home is moved aside, but its restored copy is gone. Ask for the restore again."
    mv "$staged" "$home" || fail "Could not put the restored home in place of $user's."
  fi
  remove_tree "$aside" || fail "Could not delete the home the restore replaced, in $aside."
}

restore_home() {
  user=$1 uid=$2 id=$3 operation=$4
  store=$(store_of "$user")
  snapshot=$store/$id
  record=$store/.restore
  if [ "$(field "$record" operation)" = "$operation" ] && [ "$(field "$record" state)" = done ]; then
    printf 'restored=%s\noperation=%s\n' "$id" "$operation"
    return 0
  fi
  [ -d "$snapshot/home" ] || quit "$EXIT_NO_SNAPSHOT" "Box user $user has no snapshot $id."
  stopped_for_the_restore "$user" || quit "$EXIT_REFUSED" "Box user $user's session has not been ended for a restore. End it with machine snapshot stop first."
  log_out "$user" "$uid" || quit "$EXIT_REFUSED" "Could not end every process of $user, as the notes above say, so the restore changed nothing."
  printf 'operation=%s\nsnapshot=%s\nstate=running\n' "$operation" "$id" | put "$record"
  swap_home "$user" "$uid" "$snapshot"
  clear_temporary_folders "$user" "$uid"
  printf 'operation=%s\nsnapshot=%s\nstate=done\n' "$operation" "$id" | put "$record"
  printf 'restored=%s\noperation=%s\n' "$id" "$operation"
}

restore_sign_in() {
  user=$1
  if [ "$(console)" = "$user" ]; then
    rm -f "$STATE/signin"
    return 0
  fi
  method='' since=''
  if [ "$(field "$STATE/signin" user)" = "$user" ]; then
    method=$(field "$STATE/signin" method) since=$(field "$STATE/signin" since)
  fi
  if [ -z "$method" ]; then
    method=loginwindow
  elif number "$since" && [ "$method" = loginwindow ] && [ $(($(now) - since)) -ge "$RESTORE_SIGN_IN_SECONDS" ]; then
    method=userspace since=''
  elif number "$since" && [ $(($(now) - since)) -ge "$(patience "$method")" ]; then
    rm -f "$STATE/signin"
    fail "The Mac did not sign $user in again after its restore, even when userspace restarted. Check that FileVault is off and that the automatic login is $user."
  fi
  number "$since" || begin_sign_in "$user" "$method"
  echo "signin=$method"
  exit "$EXIT_SIGNING_IN"
}

start_session() {
  user=$1 uid=$2
  [ -z "$lent_slot" ] || { start_slot_session "$user"; return; }
  session=$(session_file "$user")
  if [ -f "$session" ]; then
    [ "$(field "$session" autologin)" != yes ] && [ "$(field "$session" console)" != yes ] || automatic_login "$user"
    [ "$(field "$session" console)" != yes ] || restore_sign_in "$user"
    rm -f "$session"
  fi
  echo started=yes
  echo "console=$(console)"
}

snapshot_dirs() {
  for dir in "$HOME_SNAPSHOTS"/*/*; do
    [ -d "$dir" ] && [ -f "$dir/info" ] && printf '%s\n' "$dir"
  done
  return 0
}

snapshot_state() {
  dir=$1
  case $dir in
    *.partial)
      taker=$(cat "$dir/taker" 2>/dev/null)
      if number "$taker" && kill -0 "$taker" 2>/dev/null; then echo in-progress; else echo incomplete; fi
      ;;
    *) if [ -d "$dir/home" ]; then echo complete; else echo incomplete; fi ;;
  esac
}

list_snapshots() {
  for dir in $(snapshot_dirs); do
    [ "$(field "$dir/info" install)" = "$install" ] || continue
    id=${dir##*/}
    id=${id%.partial}
    owner=${dir%/*}
    owner=${owner##*/}
    printf 'snapshot=%s' "$id"
    for key in box thread name kind created captured paused_ms; do printf '\t%s=%s' "$key" "$(field "$dir/info" "$key")"; done
    printf '\tuser=%s\tstate=%s\n' "$owner" "$(snapshot_state "$dir")"
  done
  df -Pk "$ROOT$HOMES" 2>/dev/null | awk 'NR == 2 { printf "store.total_kib=%s\nstore.used_kib=%s\nstore.free_kib=%s\n", $2, $3, $4 }'
}

a_snapshot_of_this_install_for() {
  dir=$1 owner=$2
  [ -d "$dir" ] && [ ! -L "$dir" ] && [ -f "$dir/info" ] && [ ! -L "$dir/info" ] &&
    [ "$(field "$dir/info" install)" = "$install" ] && [ "$(field "$dir/info" user)" = "$owner" ]
}

refuse_a_store_that_is_a_link() {
  [ ! -L "$HOME_SNAPSHOTS" ] && [ ! -L "$1" ] || quit 4 "$1 or $HOME_SNAPSHOTS is a link, so the helper leaves it. Check it with: ls -ld $HOME_SNAPSHOTS $1"
}

delete_snapshot() {
  owner=$1 id=$2
  store=$(store_of "$owner")
  refuse_a_store_that_is_a_link "$store"
  for dir in "$store/$id" "$store/$id.partial"; do
    absent "$dir" || a_snapshot_of_this_install_for "$dir" "$owner" ||
      quit 4 "$dir is not this install's snapshot of $owner, or has no record of whose it is, so the helper leaves it and deletes nothing. Check it with: ls -la $dir"
  done
  for dir in "$store/$id" "$store/$id.partial"; do
    absent "$dir" || remove_tree "$dir" || fail "Could not delete $dir."
  done
  echo "deleted=$id"
}

the_slots_own_snapshot() {
  a_snapshot_of_this_install_for "$1" "$2" && [ "$(field "$1/info" uid)" = "$3" ] && [ "$(field "$1/info" slot_made)" = "$4" ]
}

a_working_entry_of_the_helper() {
  case ${1##*/} in .paused | .session | .restore | .replaced | .restoring) return 0 ;; *) return 1 ;; esac
}

entries_of() {
  for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do absent "$entry" || printf '%s\n' "$entry"; done
}

what_is_not_the_slots() {
  entries_of "$1" | while IFS= read -r entry; do
    a_working_entry_of_the_helper "$entry" && continue
    the_slots_own_snapshot "$entry" "$2" "$3" "$4" || printf '%s is not a snapshot this install took of %s in this slot, or has no record of whose it is\n' "$entry" "$2"
  done
}

forget_slot_snapshots() {
  folder=$(slot_folder "$1")
  [ -f "$folder/slot" ] || quit 4 "The Mac has no iOS slot $1."
  slot_is=$(field "$folder/state" is)
  [ "$slot_is" = resetting ] || quit "$EXIT_REFUSED" "iOS slot $1 is ${slot_is:-in no known state}, not being removed, so the helper deletes none of its snapshots."
  user=$(field "$folder/slot" user) uid=$(field "$folder/slot" uid) made=$(field "$folder/slot" made)
  [ "$user" = "$SLOT_PREFIX$1" ] && [ "$uid" = $((SLOT_UID_BASE + $1)) ] || quit "$EXIT_REFUSED" "iOS slot $1's record names user $user with UID $uid, not the slot's own, so the helper deletes none of its snapshots."
  install=$(field "$folder/released" install)
  [ -n "$install" ] || install=$(field "$folder/claim" install)
  store=$(store_of "$user")
  if absent "$store"; then
    echo forgotten=0
    return 0
  fi
  refuse_a_store_that_is_a_link "$store"
  [ -d "$store" ] && owned_by "$store" 0 || quit 4 "$store is not a folder of root's, so the helper leaves it. Check it with: ls -ld $store"
  hold_pause_lock 60 || fail "Another take is pausing processes; ask again."
  resume_journal "$(paused_marker "$user")"
  let_go_of_pause_lock
  ! journal_holds_processes "$(paused_marker "$user")" || fail "A take's pause record in $store still names processes that may stop; ask again in a minute."
  refusal=$(what_is_not_the_slots "$store" "$user" "$uid" "$made" | head -n 1)
  [ -z "$refusal" ] || quit 4 "$refusal, so the helper leaves the store and deletes nothing. Check it with: ls -la $store"
  forgotten=0
  for entry in $(entries_of "$store"); do
    remove_tree "$entry" || fail "Could not delete $entry."
    a_working_entry_of_the_helper "$entry" || forgotten=$((forgotten + 1))
  done
  rmdir "$store" || fail "Could not delete $store."
  echo "forgotten=$forgotten"
}

home_naming_files() {
  grep -rlE --exclude-dir=Caches "/Users/$2([/\"<]|\$)" "$1/Library/Preferences" "$1/Library/Containers" "$1/Library/Application Support" "$1/Pictures" "$1/Library/Metadata" 2>/dev/null |
    grep '\.plist$'
}

identity_left_in() {
  for path in "$1"/.bb-machines/*/host-id "$1"/.bb-machines/*/auth.json "$1"/.bb-machines/*/config.json "$1"/.config/bb-box/env \
    "$1"/Library/LaunchAgents/app.getbb.* "$1"/Library/Keychains/login.keychain-db "$1"/Library/Keychains/????????-????-????-????-????????????; do
    [ -e "$path" ] && printf '%s\n' "${path#"$1"/}"
  done
  return 0
}

reset_fork_identity() {
  for path in $(identity_left_in "$1"); do remove_tree "$1/$path"; done
  rm -f "$1"/.bb-machines/*/daemon.lock "$1"/.bb-machines/*/install-daemon.pid
  home_naming_files "$1" "$2" | while IFS= read -r plist; do rm -f "$plist"; done
}

others_on_the_mac() {
  source=$1 fork=$2
  for other in $(box_users); do
    [ "$other" = "$source" ] || [ "$other" = "$fork" ] || printf 'box user %s\n' "$other"
  done
  if slots_set_up; then
    held=$(device_host summary </dev/null 2>/dev/null | sed -n 's/^held=//p' | head -n 1)
    number "$held" && [ "$held" -gt 0 ] && printf '%s iOS slots\n' "$held"
  fi
  who=$(console)
  case $who in '' | root | "$source" | "$PREFIX"*) ;; *) printf 'a person, %s, at the console\n' "$who" ;; esac
  return 0
}

fork_source() {
  source=$1
  source_dir=$(store_of "$source")/$2
  refuse_a_store_that_is_a_link "$(store_of "$source")"
  [ -d "$source_dir/home" ] || quit "$EXIT_NO_SNAPSHOT" "Box user $source has no snapshot $2 on the Mac."
  a_snapshot_of_this_install_for "$source_dir" "$source" || quit 4 "Snapshot $2 of $source is not this install's, or has no record of whose it is."
  source_uid=$(field "$source_dir/info" uid)
}

refuse_a_shared_fork() {
  sharing=$(others_on_the_mac "$1" "$2" 2>/dev/null | head -n 1)
  [ -z "$sharing" ] || quit "$EXIT_REFUSED" "The Mac is shared ($sharing), so it makes no fork: a fork's user goes beside its source only where no other user shares the Mac."
}

fork_home() {
  fork_source "$1" "$2"
  refuse_a_fork_target "$3" "$4"
  refuse_a_shared_fork "$source" "$3"
  make_fork "$1" "$2" "$3" "$4"
}

reserved_box_identity() {
  [ -n "$proof_fork_identity" ] && [ "$1:$2" = "$proof_fork_identity" ] && return 0
  generation_of_name=${1#"$PREFIX"}
  [ "$generation_of_name" != "$1" ] || return 1
  case $generation_of_name in '' | 0?* | *[!0-9]*) return 1 ;; esac
  [ "${#generation_of_name}" -le 9 ] && [ "$2" = "$((ID_BASE + generation_of_name % ID_SPAN))" ]
}

uid_holder() { dscl . -list /Users UniqueID 2>/dev/null | awk -v id="$1" '$2 == id { print $1; exit }'; }

fork_target_refusal() {
  target_user=$1 target_uid=$2
  if ! reserved_box_identity "$target_user" "$target_uid"; then
    echo "A fork's user is a box user the helper reserves, $PREFIX<n> with UID $ID_BASE plus n modulo $ID_SPAN, and $target_user with UID $target_uid is not."
  elif dscl . -read "/Users/$target_user" >/dev/null 2>&1 || [ -e "$ROOT/Users/$target_user" ] || [ -L "$ROOT/Users/$target_user" ]; then
    echo "User $target_user is on the Mac already."
  elif [ -n "$(uid_holder "$target_uid")" ]; then
    echo "UID $target_uid belongs to $(uid_holder "$target_uid") already."
  elif [ "$(console)" = "$target_user" ]; then
    echo "$target_user is at the Mac's console."
  fi
}

refuse_a_fork_target() {
  refusal=$(fork_target_refusal "$1" "$2")
  [ -z "$refusal" ] || quit "$EXIT_REFUSED" "$refusal So the helper makes no fork, and changed nothing."
}

make_fork() {
  id=$2 user=$3 uid=$4
  fork_source "$1" "$id"
  refuse_a_fork_target "$user" "$uid"
  ready_user "$user" "$uid" || fail "Could not make the fork's user, $user."
  fork_home_dir=$ROOT/Users/$user
  staged=$(store_of "$source")/.fork-$user
  remove_tree "$staged" || fail "Could not remove $staged, which an earlier fork left."
  said=$(clone_tree "$source_dir/home" "$staged" 2>&1) || fail "Could not clone snapshot $id for $user: $(printf '%s\n' "$said" | tail -n 1)"
  put_back_acls "$source_dir/acls" "$staged" >/dev/null
  find "$staged" -xdev -uid "$source_uid" -exec chown -h "$uid" {} + 2>/dev/null
  reset_fork_identity "$staged" "$source"
  remove_tree "$fork_home_dir" || fail "Could not replace $user's new home."
  mv "$staged" "$fork_home_dir" || fail "Could not put the fork's home in place for $user."
  printf 'user=%s\nuid=%s\nfrom=%s\n' "$user" "$uid" "$id"
  printf 'left=%s\n' "$(identity_left_in "$fork_home_dir" | paste -sd ' ' -)"
  echo signin=userspace
}

proof_line() {
  printf '%s: %s\n' "$1" "$2"
  [ "$1" != FAILED ] || proof_failed=yes
}

proof_check() {
  words=$1
  shift
  if "$@" >/dev/null 2>&1; then proof_line ok "$words"; else proof_line FAILED "$words"; fi
}

file_says() { [ "$(cat "$1" 2>/dev/null)" = "$2" ]; }
absent() { [ ! -e "$1" ] && [ ! -L "$1" ]; }
owned_by() { [ "$(stat -f %u "$1" 2>/dev/null)" = "$2" ]; }
has_acl() { acl_entries "$1" | grep -qxF "$2"; }
running_not_stopped() { state=$(ps -o stat= -p "$1" 2>/dev/null) && case $state in T*) false ;; *) true ;; esac; }
stopped() { state=$(ps -o stat= -p "$1" 2>/dev/null) && case $state in T*) true ;; *) false ;; esac; }
no_process_of() { ! pgrep -u "$1" >/dev/null 2>&1; }
no_user() { ! dscl . -read "/Users/$1" >/dev/null 2>&1 && absent "$ROOT/Users/$1" && absent "$STATE/passwords/$1"; }
same_bytes() { cmp -s "$1" "$2"; }

as_probe() { sudo -n -H -u "$proof_user" -- "$@"; }

eventually() {
  tries=0
  until "$@"; do
    tries=$((tries + 1))
    [ "$tries" -lt 40 ] || return 1
    sleep 0.25
  done
}

command_of_sudo() {
  child=$(process_table | awk -v p="$1" '$2 == p { print $1; exit }')
  printf '%s\n' "${child:-$1}"
}

proof_clone_script() {
  script=$1 before=$2
  printf '#!/bin/sh\n%s\nif [ -x %s ]; then exec %s "$1" "$2"; fi\nexec ditto --clone "$1" "$2"\n' "$before" "'$CLONE_TREE'" "'$CLONE_TREE'" >"$script"
  chmod 700 "$script"
}

take_by_way_of() {
  real_clone=$CLONE_TREE
  CLONE_TREE=$1
  shift
  take_home "$@"
  code=$?
  CLONE_TREE=$real_clone
  return "$code"
}

next_helper_command() { printf 'install=%s\n' "$install" | sh "$0" snapshot list >/dev/null 2>&1; }

nothing_left_paused() { ! grep -q -e '^box ' -e '^resumed ' "$(paused_marker "$proof_user")" 2>/dev/null; }

next_command_resumes() {
  next_helper_command
  nothing_left_paused
}

next_command_resumes_late() {
  next_helper_command
  running_not_stopped "$proof_late_parent" && nothing_left_paused
}

refused_fork() {
  (make_fork "$proof_user" snproof000001 "$1" "$2") >/dev/null 2>"$proof_run/err"
  [ $? = "$EXIT_REFUSED" ]
}

proof_keychain() { printf '%s\n' "$ROOT/Users/$proof_user/Library/Keychains/proof.keychain-db"; }

proof_item() {
  as_probe security unlock-keychain -p proof "$(proof_keychain)" >/dev/null 2>&1
  as_probe security find-generic-password -a proof -s bb-box-proof -w "$(proof_keychain)" 2>/dev/null
}

set_proof_item() {
  as_probe security unlock-keychain -p proof "$(proof_keychain)" >/dev/null 2>&1
  as_probe security add-generic-password -U -a proof -s bb-box-proof -w "$1" "$(proof_keychain)" >/dev/null 2>&1
}

plant_proof_home() {
  home=$1
  mkdir -p "$home/proof" "$home/.bb-machines/proof" "$home/.config/bb-box" "$home/Library/LaunchAgents" "$home/Library/Keychains/0A1B2C3D-0000-4000-8000-0000000000AA" \
    "$home/Library/Application Support/Google/Chrome/Default" "$home/Library/Preferences"
  echo before >"$home/proof/file.txt"
  for file in host-id auth.json config.json; do echo proof >"$home/.bb-machines/proof/$file"; done
  echo proof >"$home/.config/bb-box/env"
  echo proof >"$home/Library/LaunchAgents/app.getbb.proof.plist"
  echo proof >"$home/Library/Keychains/login.keychain-db"
  echo proof >"$home/Library/Keychains/0A1B2C3D-0000-4000-8000-0000000000AA/keychain-2.db"
  echo '{"profile":"before"}' >"$home/Library/Application Support/Google/Chrome/Default/Preferences"
  printf '<plist><dict><key>path</key><string>/Users/%s/Pictures</string></dict></plist>\n' "$proof_user" >"$home/Library/Preferences/com.apple.proof-path.plist"
  chown -R "$proof_uid:20" "$home"
}

sign_to_stop() {
  printf ": >'%s'; tries=0; until ps -o stat= -p %s | grep -q T; do tries=\$((tries + 1)); [ \"\$tries\" -lt 100 ] || break; sleep 0.05; done" "$1" "$2"
}

proof_temporary_folder() { as_probe getconf "$1" 2>/dev/null | sed 's|/*$||'; }

plant_a_temporary_file() {
  as_probe sh -c 'echo proof >"$1"' sh "$1" && chown -h "$proof_uid:20" "$1"
}

plant_proof_temporary_files() {
  temporary_folder=$(proof_temporary_folder DARWIN_USER_TEMP_DIR) cache_folder=$(proof_temporary_folder DARWIN_USER_CACHE_DIR)
  proof_temporary=$temporary_folder/bb-box-proof-made proof_cache=$cache_folder/bb-box-proof-made
  proof_older_temporary=$temporary_folder/bb-box-proof-older proof_ungiven_temporary=$temporary_folder/bb-box-proof-not-given
  if [ -z "$temporary_folder" ] || [ -z "$cache_folder" ] || [ ! -d "$temporary_folder" ] || [ ! -d "$cache_folder" ]; then
    proof_temporary=''
    echo "note: macOS gave $proof_user no temporary folders, so the proof did not check what a restore clears there"
    return 0
  fi
  for planted in "$proof_temporary" "$proof_cache" "$proof_older_temporary" "$proof_ungiven_temporary"; do plant_a_temporary_file "$planted"; done
  as_probe touch -t 200001010000 "$proof_older_temporary"
  for planted in "$proof_temporary" "$proof_cache" "$proof_older_temporary"; do record_file "$proof_user" "$planted" temp; done
  record_file "$proof_user" "$proof_ungiven_temporary"
}

temporary_entries_the_proof_made() {
  awk 'FILENAME == ARGV[1] { if ($1 == "temp") made[$3] = 1; next } ($1 in made)' "$PROOF_RECORD" -
}

check_what_the_restore_cleared() {
  [ -n "$proof_temporary" ] || return 0
  proof_check "the restore cleared a temporary file the user made" absent "$proof_temporary"
  proof_check "the restore cleared a cache file the user made" absent "$proof_cache"
  proof_check "the restore left a temporary file older than the user" test -f "$proof_older_temporary"
  proof_check "the restore left a temporary file the proof did not give it to clear" test -f "$proof_ungiven_temporary"
}

object_id() { stat -f %d:%i "$1" 2>/dev/null; }

record_line() { printf '%s\n' "$*" >>"$PROOF_RECORD"; }

record_dir() {
  [ -d "$2" ] && [ ! -L "$2" ] || return 0
  record_line "${3:-dir} $1 $(object_id "$2") $2"
}

record_file() {
  [ -f "$2" ] && [ ! -L "$2" ] || return 0
  record_line "${3:-file} $1 $(object_id "$2") $2"
}

recorded_objects() {
  awk -v kind="$1" -v owner="$2" '$1 == kind && $2 == owner { rest = $0; sub(/^[^ ]* [^ ]* [^ ]* /, "", rest); print $3, rest }' "$PROOF_RECORD"
}

record_again() {
  awk -v path="$2" '{ rest = $0; sub(/^[^ ]* [^ ]* [^ ]* /, "", rest) } !($1 == "dir" && rest == path)' "$PROOF_RECORD" | put "$PROOF_RECORD"
  record_dir "$1" "$2"
}

start_of() { process_table | awk -v p="$1" '$1 == p { print $5; exit }'; }

record_processes() {
  for recorded_pid; do
    started=$(start_of "$recorded_pid")
    [ -z "$started" ] || record_line "process $recorded_pid $started"
  done
}

note_proof_user() {
  made_name=$1 made_uid=$2 made_guid=-
  [ "$(attribute "$made_name" UniqueID)" != "$made_uid" ] || made_guid=$(attribute "$made_name" GeneratedUID)
  awk -v name="$made_name" '!($1 == "user" && $2 == name)' "$PROOF_RECORD" | put "$PROOF_RECORD"
  record_line "user $made_name $made_uid ${made_guid:--} $UNUSED_WHEN_PICKED"
  record_dir "$made_name" "$ROOT/Users/$made_name"
  record_file "$made_name" "$STATE/passwords/$made_name"
  echo "note: made $made_name, UID $made_uid, GeneratedUID ${made_guid:--}"
}

leave_for_the_proofs_cleanup() { :; }

make_proof_user() {
  record_line "user $1 $2 - $UNUSED_WHEN_PICKED"
  proof_made=no
  make_user "$1" "$2" && proof_made=yes
  note_proof_user "$1" "$2"
  [ "$proof_made" = yes ] || fail "Could not make $1, as the helper makes box users."
}

proof_left() {
  echo "note: the proof left $*"
  proof_left_any=yes
}

remove_what_the_proof_made() {
  remove_object "$1" && return 0
  proof_left "$1, which it could not remove"
  return 1
}

remove_an_empty_folder_the_proof_made() {
  remove_empty_folder "$1" && return 0
  proof_left "$1, which it could not remove"
  return 1
}

proof_left_what_changed() {
  case $1:$3 in
    account:unknown) proof_left "user $2, as the Mac's directory service did not answer" ;;
    account:*) proof_left "user $2, as it is not the account the proof made: UID $(attribute "$2" UniqueID), GeneratedUID $(attribute "$2" GeneratedUID). Check it with: dscl . -read /Users/$2 UniqueID GeneratedUID" ;;
    *) proof_left "$2, as it is not what the proof made. Check it with: ls -lid $2" ;;
  esac
}

remove_recorded_of() {
  removed_all=yes
  for kind_of_object in dir file temp emptydir; do
    removal=remove_what_the_proof_made
    [ "$kind_of_object" != emptydir ] || removal=remove_an_empty_folder_the_proof_made
    change_only_what_is_still object "$removal" <<OBJECTS || removed_all=no
$(recorded_objects "$kind_of_object" "$1")
OBJECTS
  done
  [ "$removed_all" = yes ]
}

remove_one_recorded() {
  change_only_what_is_still object remove_what_the_proof_made <<OBJECT
$(awk -v path="$1" '{ rest = $0; sub(/^[^ ]* [^ ]* [^ ]* /, "", rest) } ($1 == "dir" || $1 == "file") && rest == path { id = $3 } END { if (id != "") print id, path }' "$PROOF_RECORD")
OBJECT
}

left_in_place_of() {
  for path in "$ROOT/Users/$1" "$(store_of "$1")" "$STATE/passwords/$1"; do
    absent "$path" || printf '%s\n' "$path"
  done
}

recorded_id_of() {
  awk -v path="$1" '{ rest = $0; sub(/^[^ ]* [^ ]* [^ ]* /, "", rest) } ($1 == "dir" || $1 == "file") && rest == path { id = $3 } END { print id }' "$PROOF_RECORD"
}

unrecorded_place_of() {
  left_in_place_of "$1" | while IFS= read -r place; do
    [ "$(recorded_id_of "$place")" = "$(object_id "$place")" ] || { printf '%s\n' "$place"; break; }
  done
}

delete_the_account() {
  sysadminctl -deleteUser "$1" >/dev/null 2>&1
  ! dscl . -read "/Users/$1" >/dev/null 2>&1 || dscl . -delete "/Users/$1" >/dev/null 2>&1
  ! dscl . -read "/Users/$1" >/dev/null 2>&1 && return 0
  proof_left "user $1, which it could not remove"
  return 1
}

remove_proof_user() {
  name_made=$1 uid_made=$2 guid_made=$3
  account=$(identity_now account "$name_made")
  case $account in
    gone) ;;
    "$uid_made:$guid_made")
      (end_every_process_of_an_account_this_proof_made "$name_made" "$uid_made") >/dev/null 2>&1 || { proof_left "user $name_made, as its processes did not end, or it is not now the account the proof made"; return 1; }
      ;;
    *)
      proof_left_what_changed account "$name_made" "$account"
      return 1
      ;;
  esac
  remove_recorded_of "$name_made" || return 1
  leave_groups "$name_made"
  unproven=$(left_in_place_of "$name_made" | head -n 1)
  if [ -n "$unproven" ]; then
    proof_left "$unproven, and user $name_made with it, as the proof did not record making it. Check it with: ls -lid $unproven"
    return 1
  fi
  [ "$account" != gone ] || return 0
  change_only_what_is_still account delete_the_account <<ACCOUNT
$uid_made:$guid_made $name_made
ACCOUNT
}

end_recorded_processes() {
  change_only_what_is_still process end_process <<PROCESSES
$(awk '$1 == "process" { print $3, $2 }' "$PROOF_RECORD")
PROCESSES
  return 0
}

signal_what_the_proof_recorded() {
  signal_action=$1
  shift
  change_only_what_is_still process "$signal_action" <<PROCESSES
$(awk -v pids=" $* " '$1 == "process" && index(pids, " " $2 " ") { print $3, $2 }' "$PROOF_RECORD")
PROCESSES
  return 0
}

still_ending() { state=$(ps -o stat= -p "$1" 2>/dev/null); case $state in '' | Z*) false ;; *) true ;; esac; }
a_zombie() { state=$(ps -o stat= -p "$1" 2>/dev/null); case $state in Z*) true ;; *) false ;; esac; }

reap_if_ended() {
  for child; do
    tries=0
    while still_ending "$child" && [ "$tries" -lt 40 ]; do
      tries=$((tries + 1))
      sleep 0.25
    done
    ! a_zombie "$child" || wait "$child" 2>/dev/null
  done
  return 0
}

clean_what_the_record_proves() {
  proof_left_any=no
  end_recorded_processes
  users_made=$(awk '$1 == "user" { print $2, $3, $4 }' "$PROOF_RECORD")
  while read -r user_line_name user_line_uid user_line_guid; do
    [ -n "$user_line_name" ] || continue
    remove_proof_user "$user_line_name" "$user_line_uid" "$user_line_guid" </dev/null
  done <<USERS
$users_made
USERS
  remove_recorded_of - </dev/null
  [ "$proof_left_any" = no ]
}

a_record_the_proof_reads() {
  awk '
    $1 == "user" && NF == 5 && $5 == unused { next }
    ($1 == "dir" || $1 == "file" || $1 == "temp" || $1 == "emptydir") && NF >= 4 && $3 ~ /^[0-9]+:[0-9]+$/ { next }
    $1 == "process" && NF == 3 { next }
    { bad = 1 }
    END { exit bad }' unused="$UNUSED_WHEN_PICKED" "$PROOF_RECORD"
}

check_a_recorded_account() {
  account_now=$(identity_now account "$1")
  case $account_now in
    gone | "$2:$3") ;;
    *)
      proof_left_what_changed account "$1" "$account_now"
      return 0
      ;;
  esac
  place=$(unrecorded_place_of "$1")
  [ -z "$place" ] || proof_left "$place, and user $1 with it, as the proof did not record making it. Check it with: ls -lid $place"
}

check_a_recorded_object() {
  object_now=$(identity_now object "$2")
  [ "$object_now" = gone ] || [ "$object_now" = "$1" ] || proof_left_what_changed object "$2" "$object_now"
}

the_record_holds_what_it_cannot_prove() {
  proof_left_any=no
  recorded_lines=$(cat "$PROOF_RECORD")
  while read -r line_kind line_owner line_id line_rest; do
    case $line_kind in
      user) check_a_recorded_account "$line_owner" "$line_id" "${line_rest%% *}" </dev/null ;;
      dir | file | temp | emptydir) check_a_recorded_object "$line_id" "$line_rest" </dev/null ;;
    esac
  done <<LINES
$recorded_lines
LINES
  [ "$proof_left_any" = yes ]
}

recover_an_earlier_proof() {
  [ -e "$PROOF_RECORD" ] || return 0
  a_record_the_proof_reads ||
    quit "$EXIT_REFUSED" "An earlier proof left $PROOF_RECORD in a form this proof does not read, so it does not run. It changed nothing. Remove what it lists yourself, then the record."
  echo "note: an earlier proof was cut short; checking that its record in $PROOF_RECORD proves it made each thing it lists"
  if the_record_holds_what_it_cannot_prove; then
    quit "$EXIT_REFUSED" "The proof does not run: an earlier proof left what it cannot prove it made, as the notes above say. It changed nothing. Check each, remove what is an earlier proof's yourself, then remove $PROOF_RECORD."
  fi
  earlier_uids=$(awk '$1 == "user" { print $3 }' "$PROOF_RECORD" | sort -u | paste -sd ' ' -)
  if clean_what_the_record_proves; then
    rm -f "$PROOF_RECORD"
    echo "note: removed what the earlier proof made"
    set -- $earlier_uids
    note_what_stays_outside_the_record "$@"
    return 0
  fi
  quit "$EXIT_REFUSED" "The proof does not run: what an earlier proof made changed while this proof removed it, as the notes above say. It removed the rest, and kept $PROOF_RECORD. Check each, remove what is an earlier proof's yourself, then remove $PROOF_RECORD."
}

note_what_stays_outside_the_record() {
  uid_tests=$(for each_uid; do printf -- '-uid %s -o ' "$each_uid"; done | sed 's/ -o $//')
  echo "note: the proof deletes only what it recorded, so what macOS made for the scratch users outside the record, such as their temporary folders, stays. List it with: sudo find /System/Volumes/Data -xdev \( $uid_tests \)"
}

end_proof() {
  code=$1
  end_recorded_processes
  reap_if_ended $proof_children
  clean_what_the_record_proves
  cleaned=$?
  for each_made in "$proof_fork_user" "$proof_user" "$proof_stranger" "$proof_slot_user"; do
    proof_check "removed $each_made and what the proof made for it" no_user "$each_made"
  done
  proof_check "no process of the scratch users is left" eval "no_process_of $proof_uid && no_process_of $proof_fork_uid && no_process_of $proof_slot_uid"
  if [ "$proof_made_the_store" = yes ]; then proof_check "removed the snapshot store it made" absent "$HOME_SNAPSHOTS"; fi
  note_what_stays_outside_the_record "$proof_uid" "$proof_fork_uid" "$proof_slot_uid"
  if [ "$cleaned" = 0 ]; then
    rm -f "$PROOF_RECORD"
  else
    echo "note: what the proof made is recorded in $PROOF_RECORD, which its next run reads"
    proof_failed=yes
  fi
  [ "$code" = 0 ] || proof_failed=yes
  if [ "$proof_failed" = no ]; then
    echo "result: passed in $(( ($(now_ms) - proof_started) / 1000 )) s"
  else
    echo "result: FAILED"
    exit 1
  fi
}

refuse_unless_the_mac_is_free() {
  in_use=''
  if [ -e "$STATE/owner" ]; then in_use="a box holds the Mac"; elif [ -e "$STATE/resetting" ]; then in_use="the Mac's reset is running"; fi
  [ -z "$in_use" ] || quit 3 "The proof runs only while the Mac is free, and $in_use. Run the proof again when it is free. It changed nothing."
}

hold_the_device_hosts_lock() {
  [ -d "$SLOTS_STATE" ] || return 0
  exec 6>>"$DEVICE_HOST_LOCK"
  lock_open_file 6 "$DEVICE_HOST_WAIT_SECONDS" ||
    quit 3 "The proof runs only while the Mac's iOS slots are still, and another command held their lock for $DEVICE_HOST_WAIT_SECONDS s. Run the proof again later. It changed nothing."
}

slot_words() {
  case $1 in
    held) echo "held by a box" ;;
    releasing) echo "being given back" ;;
    making) echo "being made" ;;
    resetting) echo "being removed" ;;
    *) echo "${1:-in no known state}" ;;
  esac
}

claim_records_in() {
  for record in "$1"/claim "$1"/claim.new.* "$1"/released "$1"/last; do
    absent "$record" || printf '%s\n' "$record"
  done
}

slot_left_unidle() {
  slot_folder=$1
  is=$(field "$slot_folder/state" is)
  if [ -f "$slot_folder/state" ] && [ "$is" != ready ]; then
    echo "$(slot_words "$is") ($slot_folder/state)"
    return 0
  fi
  if [ ! -f "$slot_folder/slot" ] || [ ! -f "$slot_folder/state" ]; then
    echo "being made or removed, as it lacks its slot or state record ($slot_folder)"
    return 0
  fi
  claim_record=$(claim_records_in "$slot_folder" | head -n 1)
  [ -z "$claim_record" ] || echo "claimed, or its claim was cut short ($claim_record)"
}

slot_activity() {
  for slot_folder in "$SLOTS_STATE"/slots/*; do
    absent "$slot_folder" && continue
    unidle=$(slot_left_unidle "$slot_folder")
    [ -z "$unidle" ] || echo "an iOS slot is $unidle"
  done
  for promise in "$SLOTS_STATE"/promises/*; do
    [ ! -f "$promise" ] || echo "an iOS slot is promised to a box ($promise)"
  done
  for swept in "$SLOTS_STATE"/sweep/*; do
    [ ! -f "$swept" ] || echo "an iOS slot is being removed ($swept)"
  done
}

refuse_while_slots_are_lent() {
  in_use=$(slot_activity | head -n 1)
  [ -z "$in_use" ] || quit 3 "The proof runs only while the Mac is free, and $in_use. Run the proof again when it is free. It changed nothing."
}

journal_of_a_recorded_store() {
  [ -f "$PROOF_RECORD" ] || return 1
  journal_store=${1%/.paused}
  store_made=$(recorded_objects dir "${journal_store##*/}" | awk -v path="$journal_store" 'substr($0, index($0, " ") + 1) == path { print $1 }' | tail -n 1)
  [ -n "$store_made" ] && [ "$(object_id "$journal_store")" = "$store_made" ]
}

refuse_while_a_pause_is_left() {
  for journal in $(abandoned_pauses); do
    journal_of_a_recorded_store "$journal" && continue
    quit 3 "The proof runs only while the Mac is free, and a take's pause record is left in $journal: run 'machine status' to resume what it paused. It changed nothing."
  done
}

random_hex() { od -An -N4 -tx1 /dev/urandom | tr -d ' \n'; }
random_below() { od -An -N4 -tu4 /dev/urandom | awk -v n="$1" 'NF { print $1 % n; exit }'; }

read_the_accounts() {
  proof_accounts=$(dscl . -list /Users UniqueID 2>/dev/null) && [ -n "$proof_accounts" ] ||
    quit "$EXIT_REFUSED" "The proof could not list the Mac's users, so it does not run. It changed nothing."
}

picked_already() { case " $proof_picked " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

name_taken() {
  picked_already "$1" && return 0
  printf '%s\n' "$proof_accounts" | awk -v n="$1" '$1 == n { found = 1 } END { exit !found }' && return 0
  for path in "$ROOT/Users/$1" "$(store_of "$1")" "$STATE/passwords/$1" "$ROOT/etc/sudoers.d/$1" "$ROOT/etc/sudoers.d/$1.new" \
    "$ROOT/private/var/at/tabs/$1" "$ROOT/Library/Managed Preferences/$1"; do
    absent "$path" || return 0
  done
  return 1
}

uid_taken() {
  picked_already "$1" && return 0
  printf '%s\n' "$proof_accounts" | awk -v id="$1" '$2 == id { found = 1 } END { exit !found }'
}

fresh_name() {
  case $1 in "$PROOF_NAME_PREFIX"[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;; *) return 1 ;; esac
  ! name_taken "$1"
}

fresh_uid() {
  number "$1" && [ "$1" -ge "$PROOF_UID_BASE" ] && [ "$1" -lt $((PROOF_UID_BASE + PROOF_UID_SPAN)) ] && ! uid_taken "$1" && ! pgrep -u "$1" >/dev/null 2>&1
}

pick() {
  tries=0
  while [ "$tries" -lt "$PROOF_PICKS" ]; do
    if [ "$1" = name ]; then candidate=$PROOF_NAME_PREFIX$(random_hex); else candidate=$((PROOF_UID_BASE + $(random_below "$PROOF_UID_SPAN" | grep -x '[0-9]*' || echo -1))); fi
    if "fresh_$1" "$candidate"; then
      proof_picked="$proof_picked $candidate"
      picked=$candidate
      return 0
    fi
    tries=$((tries + 1))
  done
  quit "$EXIT_REFUSED" "The proof found no unused $1 for a scratch user in $PROOF_PICKS tries, so it does not run. It changed nothing."
}

pick_proof_identities() {
  read_the_accounts
  proof_picked=''
  pick name && proof_user=$picked
  pick uid && proof_uid=$picked
  pick name && proof_fork_user=$picked
  pick uid && proof_fork_uid=$picked
  pick name && proof_stranger=$picked
  pick name && proof_slot_user=$picked
  pick uid && proof_slot_uid=$picked
  proof_fork_identity=$proof_fork_user:$proof_fork_uid
}

start_the_record() {
  (set -C && : >"$PROOF_RECORD") 2>/dev/null || quit "$EXIT_REFUSED" "Another proof's record appeared in $PROOF_RECORD, so this one does not run. It changed nothing."
  record_line "user $proof_user $proof_uid - $UNUSED_WHEN_PICKED"
  record_line "user $proof_fork_user $proof_fork_uid - $UNUSED_WHEN_PICKED"
  record_line "user $proof_stranger $proof_fork_uid - $UNUSED_WHEN_PICKED"
  record_line "user $proof_slot_user $proof_slot_uid - $UNUSED_WHEN_PICKED"
  proof_run=$(mktemp -d "$STATE/proof-run.XXXXXX") || fail "Could not make the proof's own folder in $STATE."
  record_dir - "$proof_run"
}

slot_probe_simctl() { (cd / && sudo -n -H -u "$proof_slot_user" -- xcrun simctl "$@") </dev/null 2>/dev/null; }
proof_device_listed() { slot_probe_simctl list devices | grep -F "($1)" >/dev/null; }
proof_device_booted() { slot_probe_simctl list devices | grep -F "($1)" | grep -q '(Booted)'; }
proof_setting() { slot_probe_simctl spawn "$proof_device" defaults read com.bb-box.proof value; }
set_proof_setting() { slot_probe_simctl spawn "$proof_device" defaults write com.bb-box.proof value "$1" >/dev/null; }
a_device_id() { case ${1:-} in ????????-????-????-????-????????????) return 0 ;; *) return 1 ;; esac; }

boot_proof_device() {
  proof_device_booted "$1" || slot_probe_simctl boot "$1" >/dev/null || proof_device_booted "$1" || return 1
  within "$PROOF_DEVICE_BOOT_SECONDS" sudo -n -H -u "$proof_slot_user" -- xcrun simctl bootstatus "$1" -b >/dev/null 2>&1 </dev/null
}

make_and_record_the_devices_store() {
  devices_store=$SIM_STORES/com.apple.CoreSimulator.SimDevice.$1
  mkdir "$devices_store" 2>/dev/null || return 1
  record_dir "$proof_slot_user" "$devices_store"
  chown "$proof_slot_uid:0" "$devices_store" && chmod 700 "$devices_store"
}

proof_device_line() { grep -v '^#' "$IOS_SHARE/$1" 2>/dev/null | head -n 1; }

make_the_proof_device() {
  proof_device_type=$(proof_device_line devices.tsv | cut -f 2) proof_runtime=$(proof_device_line runtimes.tsv | cut -f 1)
  [ -n "$proof_device_type" ] && [ -n "$proof_runtime" ] || return 1
  slot_probe_simctl list devices >/dev/null || return 1
  slot_probe_simctl delete all >/dev/null
  proof_device=$(slot_probe_simctl create bb-box-proof "$proof_device_type" "$proof_runtime" | tail -n 1)
  a_device_id "$proof_device"
}

prove_slot_snapshots() {
  if ! slots_set_up; then
    echo "note: this Mac lends no iOS slots, so the proof checked no slot user's device"
    return 0
  fi
  make_proof_user "$proof_slot_user" "$proof_slot_uid"
  proof_line ok "made $proof_slot_user, UID $proof_slot_uid, a scratch user for an iOS slot, with no console session, as slot users have none"
  ready_store "$proof_slot_user"
  record_dir "$proof_slot_user" "$(store_of "$proof_slot_user")"
  slot_home=$ROOT/Users/$proof_slot_user
  echo before >"$slot_home/app-data.txt" && chown "$proof_slot_uid:20" "$slot_home/app-data.txt"
  if ! make_the_proof_device; then
    proof_line FAILED "simctl made a device for $proof_slot_user from the device host's $IOS_SHARE/devices.tsv and runtimes.tsv"
    return 0
  fi
  proof_line ok "simctl made device $proof_device, a $proof_device_type on $proof_runtime, for $proof_slot_user"
  if ! make_and_record_the_devices_store "$proof_device"; then
    proof_line FAILED "made and recorded the device's folder in ${SIM_STORES#"$ROOT"} before its first boot"
    return 0
  fi
  began=$(now_ms)
  boot_proof_device "$proof_device"
  proof_check "the device booted, in $(( ($(now_ms) - began) / 1000 )) s" proof_device_booted "$proof_device"
  set_proof_setting one
  proof_check "a setting inside the device reads one" test "$(proof_setting)" = one

  began=$(now_ms)
  take_home "$proof_slot_user" "$proof_slot_uid" snproofslot01 >"$proof_run/slot-take" || fail "The take of $proof_slot_user's home failed: $(cat "$proof_run/slot-take")"
  record_dir "$proof_slot_user" "$(store_of "$proof_slot_user")/snproofslot01"
  echo "slot take, its device booted: $(( $(now_ms) - began )) ms in all, the user's processes paused $(field "$proof_run/slot-take" paused_ms) ms"
  proof_check "the device still runs after the take" proof_device_booted "$proof_device"
  set_proof_setting two
  echo after >"$slot_home/app-data.txt"
  proof_later=$(slot_probe_simctl create bb-box-proof-later "$proof_device_type" "$proof_runtime" | tail -n 1)
  a_device_id "$proof_later" && make_and_record_the_devices_store "$proof_later"
  proof_check "a device made after the take is listed" proof_device_listed "$proof_later"

  began=$(now_ms)
  end_session "$proof_slot_user" "$proof_slot_uid" >/dev/null
  echo "slot stop, shutting its device down: $(( $(now_ms) - began )) ms"
  proof_check "the stop ended the slot user's processes, its device's with them" no_process_of "$proof_slot_uid"
  take_home "$proof_slot_user" "$proof_slot_uid" snproofslotun >/dev/null || fail "The slot user's undo failed."
  record_dir "$proof_slot_user" "$(store_of "$proof_slot_user")/snproofslotun"
  began=$(now_ms)
  restore_home "$proof_slot_user" "$proof_slot_uid" snproofslot01 opproofslot01 >/dev/null
  echo "slot restore: $(( $(now_ms) - began )) ms for the swap"
  record_again "$proof_slot_user" "$slot_home"
  start_session "$proof_slot_user" "$proof_slot_uid" >/dev/null
  proof_check "a file in the slot user's home is as at the take" file_says "$slot_home/app-data.txt" before
  proof_check "simctl lists the device as at the take" proof_device_listed "$proof_device"
  proof_check "simctl no longer lists the device made after the take" eval "! proof_device_listed '$proof_later'"
  began=$(now_ms)
  boot_proof_device "$proof_device"
  proof_check "the device boots after the restore, in $(( ($(now_ms) - began) / 1000 )) s" proof_device_booted "$proof_device"
  proof_check "the setting inside the device is as at the take: one" test "$(proof_setting)" = one

  end_session "$proof_slot_user" "$proof_slot_uid" >/dev/null
  restore_home "$proof_slot_user" "$proof_slot_uid" snproofslotun opproofslot02 >/dev/null
  record_again "$proof_slot_user" "$slot_home"
  start_session "$proof_slot_user" "$proof_slot_uid" >/dev/null
  proof_check "the undo puts back the slot user's file as before the restore" file_says "$slot_home/app-data.txt" after
  proof_check "the undo puts back the device made after the take" proof_device_listed "$proof_later"
  boot_proof_device "$proof_device"
  proof_check "the device boots after the undo, its setting two" test "$(proof_setting)" = two
  end_session "$proof_slot_user" "$proof_slot_uid" >/dev/null
  proof_check "the slot user's processes ended before the clean-up" no_process_of "$proof_slot_uid"
  for id in snproofslot01 snproofslotun; do
    remove_one_recorded "$(store_of "$proof_slot_user")/$id"
    proof_check "deleted the slot user's snapshot $id, which it recorded making" absent "$(store_of "$proof_slot_user")/$id"
  done
}

prove_home_snapshots() {
  lock 60
  refuse_unless_the_mac_is_free
  hold_the_device_hosts_lock
  refuse_while_slots_are_lent
  refuse_while_a_pause_is_left
  on_what_changed=proof_left_what_changed
  which_temporary_entries=temporary_entries_the_proof_made
  read_the_accounts
  recover_an_earlier_proof
  pick_proof_identities
  install=bb-box-proof box=proof
  proof_failed=no proof_made_the_store=no proof_children=''
  proof_started=$(now_ms)
  start_the_record
  when_a_user_is_made=note_proof_user
  on_a_half_made_user=leave_for_the_proofs_cleanup
  then_on_exit=end_proof
  exit_cleanly
  echo "macOS $(sw_vers -productVersion 2>/dev/null), homes on $(homes_filesystem), clone by $([ -x "$CLONE_TREE" ] && echo "clonefile(2)" || echo "ditto --clone")"
  echo "note: scratch users $proof_user (UID $proof_uid), $proof_fork_user (UID $proof_fork_uid) and, for an iOS slot, $proof_slot_user (UID $proof_slot_uid), recorded in $PROOF_RECORD as they are made"
  echo "note: the proof chooses nothing it deletes or signals by name, UID or PID alone, but for one rule: it ends every process of a scratch user's UID, and only while that account's UID and GeneratedUID match its record and the UID had no process when the proof picked it"
  proof_console_before=$(console)

  make_proof_user "$proof_user" "$proof_uid"
  proof_line ok "made $proof_user, UID $proof_uid, as the helper makes box users"
  [ -d "$HOME_SNAPSHOTS" ] || proof_made_the_store=yes
  ready_store "$proof_user"
  [ "$proof_made_the_store" = no ] || record_dir - "$HOME_SNAPSHOTS" emptydir
  record_dir "$proof_user" "$(store_of "$proof_user")"
  probe_home=$ROOT/Users/$proof_user
  plant_proof_home "$probe_home"
  as_probe security create-keychain -p proof "$(proof_keychain)" >/dev/null 2>&1
  set_proof_item one
  keychain_said=$(proof_item)
  sudo -n -H -u "$proof_user" -- /bin/sleep 600 </dev/null >/dev/null 2>&1 6>&- 9>&- &
  proof_pid=$!
  sudo -n -H -u "$proof_user" -- /bin/sleep 600 </dev/null >/dev/null 2>&1 6>&- 9>&- &
  proof_held_sudo=$!
  perl -e "$STOPS_ITSELF_ON_A_SIGN" "$proof_run/stop-during-the-take" </dev/null >/dev/null 2>&1 6>&- 9>&- &
  proof_stranger_pid=$!
  perl -e "$STOPS_ITSELF_ON_A_SIGN" "$proof_run/stop-during-the-killed-take" </dev/null >/dev/null 2>&1 6>&- 9>&- &
  proof_late_stranger=$!
  perl -e "$STOPS_LATE_ABOVE" "$PROOF_LATE_STOP_SECONDS" sudo -n -H -u "$proof_user" -- /bin/sleep 600 </dev/null >"$proof_run/late-child" 2>/dev/null 6>&- 9>&- &
  proof_late_parent=$!
  proof_children="$proof_pid $proof_held_sudo $proof_stranger_pid $proof_late_stranger $proof_late_parent"
  record_processes $proof_children
  sleep 1
  proof_command=$(command_of_sudo "$proof_pid")
  proof_held=$(command_of_sudo "$proof_held_sudo")
  record_processes "$proof_command" "$proof_held" $(cat "$proof_run/late-child")
  signal_what_the_proof_recorded stop_process "$proof_held"
  desktop_acl=$(acl_entries "$probe_home/Desktop" | head -n 1)
  plant_proof_temporary_files

  proof_clone_script "$proof_run/clone" "$(sign_to_stop "$proof_run/stop-during-the-take" "$proof_stranger_pid")"
  began=$(now_ms)
  take_by_way_of "$proof_run/clone" "$proof_user" "$proof_uid" snproof000001 >"$proof_run/out" || fail "The take failed: $(cat "$proof_run/out")"
  record_dir "$proof_user" "$(store_of "$proof_user")/snproof000001"
  echo "take: $(( $(now_ms) - began )) ms in all, the user's processes paused $(field "$proof_run/out" paused_ms) ms"
  proof_check "the take kept the home in the snapshot store" test -d "$(store_of "$proof_user")/snproof000001/home"
  proof_check "the user's process runs again after the take" running_not_stopped "$proof_command"
  proof_check "the root sudo above the user's process runs again after the take" eventually running_not_stopped "$proof_pid"
  proof_check "the user's process that someone else stopped before the take stays stopped" stopped "$proof_held"
  proof_check "a root process that someone else stopped during the take stays stopped" stopped "$proof_stranger_pid"
  proof_check "the take left nothing paused in its record" nothing_left_paused
  proof_check "a process above the user's that stops itself $PROOF_LATE_STOP_SECONDS s after the pause, after the take's last check, stops" eventually stopped "$proof_late_parent"
  proof_check "the take keeps its record while a process above the user's may still stop" test -s "$(paused_marker "$proof_user")"
  proof_check "the next helper command resumes the process that stopped late" next_command_resumes_late
  signal_what_the_proof_recorded end_process "$proof_late_parent" $(cat "$proof_run/late-child")
  reap_if_ended "$proof_late_parent"
  cp "$(proof_keychain)" "$proof_run/keychain-at-take"

  proof_clone_script "$proof_run/clone-waits" "$(sign_to_stop "$proof_run/stop-during-the-killed-take" "$proof_late_stranger"); echo \$\$ >'$proof_run/cloning'; exec /bin/sleep 120"
  (take_by_way_of "$proof_run/clone-waits" "$proof_user" "$proof_uid" snproofkilled >/dev/null 2>&1) 6>&- 9>&- &
  proof_taker=$!
  record_processes "$proof_taker"
  eventually test -s "$proof_run/cloning" || fail "The take that the proof kills did not reach its clone."
  record_processes "$(cat "$proof_run/cloning")"
  record_dir "$proof_user" "$(store_of "$proof_user")/snproofkilled.partial"
  proof_check "a take paused the user's process" eventually stopped "$proof_command"
  proof_check "the root sudo above it stopped too" eventually stopped "$proof_pid"
  signal_what_the_proof_recorded end_process "$proof_taker" "$(cat "$proof_run/cloning")"
  reap_if_ended "$proof_taker"
  proof_check "the helper killed during the pause left its pause record" test -s "$(paused_marker "$proof_user")"
  proof_check "the next helper command resumes the killed take's pause" eventually next_command_resumes
  proof_check "the user's process runs again after the killed take" running_not_stopped "$proof_command"
  proof_check "the root sudo above it runs again after the killed take" eventually running_not_stopped "$proof_pid"
  proof_check "the user's process that someone else stopped stays stopped after the recovery" stopped "$proof_held"
  proof_check "a root process that someone else stopped during the killed take's pause stays stopped" stopped "$proof_late_stranger"
  proof_check "a root process stopped during the first take stays stopped" stopped "$proof_stranger_pid"
  remove_one_recorded "$(store_of "$proof_user")/snproofkilled.partial"

  echo after >"$probe_home/proof/file.txt"
  echo later >"$probe_home/proof/new.txt"
  echo '{"profile":"after"}' >"$probe_home/Library/Application Support/Google/Chrome/Default/Preferences"
  set_proof_item two
  chown -R "$proof_uid:20" "$probe_home/proof"

  began=$(now_ms)
  end_session "$proof_user" "$proof_uid" >/dev/null
  echo "stop: $(( $(now_ms) - began )) ms"
  proof_check "the stop ended the user's processes" no_process_of "$proof_uid"
  take_home "$proof_user" "$proof_uid" snproofundo01 >/dev/null || fail "The undo's take failed."
  record_dir "$proof_user" "$(store_of "$proof_user")/snproofundo01"
  began=$(now_ms)
  restore_home "$proof_user" "$proof_uid" snproof000001 opproof000001 >/dev/null
  echo "restore: $(( $(now_ms) - began )) ms for the swap"
  record_again "$proof_user" "$probe_home"
  start_session "$proof_user" "$proof_uid" >/dev/null
  proof_check "a file is as at the take" file_says "$probe_home/proof/file.txt" before
  proof_check "a file made after the take is gone" absent "$probe_home/proof/new.txt"
  proof_check "a browser profile is as at the take" file_says "$probe_home/Library/Application Support/Google/Chrome/Default/Preferences" '{"profile":"before"}'
  proof_check "a keychain is byte for byte as at the take" same_bytes "$(proof_keychain)" "$proof_run/keychain-at-take"
  if [ -n "$keychain_said" ]; then
    proof_check "a keychain item reads as at the take" test "$(proof_item)" = one
  else
    echo "note: security could not read a keychain item as $proof_user outside a session, so only the keychain's bytes were checked"
  fi
  proof_check "the restored home is the user's" owned_by "$probe_home/proof/file.txt" "$proof_uid"
  if [ -n "$desktop_acl" ]; then proof_check "the home's ACLs are back: Desktop has $desktop_acl" has_acl "$probe_home/Desktop" "$desktop_acl"; fi
  check_what_the_restore_cleared
  proof_check "the same restore asked again changes nothing" restore_home "$proof_user" "$proof_uid" snproof000001 opproof000001

  end_session "$proof_user" "$proof_uid" >/dev/null
  restore_home "$proof_user" "$proof_uid" snproofundo01 opproof000002 >/dev/null
  record_again "$proof_user" "$probe_home"
  start_session "$proof_user" "$proof_uid" >/dev/null
  proof_check "the undo puts back the home as before the restore" file_says "$probe_home/proof/file.txt" after
  proof_check "the undo puts back a file made after the take" file_says "$probe_home/proof/new.txt" later

  sharing=$(others_on_the_mac "$proof_user" "$proof_fork_user" 2>/dev/null | head -n 1)
  if [ -n "$sharing" ]; then
    said=$( (fork_home "$proof_user" snproof000001 "$proof_fork_user" "$proof_fork_uid") 2>&1 >/dev/null)
    proof_check "a fork is refused while another user shares the Mac: $said" test -n "$said"
  fi
  proof_check "a fork aimed at the source's own user, $proof_user, is refused" refused_fork "$proof_user" "$proof_uid"
  echo "note: the helper said: $(cat "$proof_run/err")"
  proof_check "the refused fork left $proof_user with UID $proof_uid" test "$(attribute "$proof_user" UniqueID)" = "$proof_uid"
  proof_check "the refused fork left $proof_user's home and files" file_says "$probe_home/proof/file.txt" after
  proof_check "a fork aimed at a user the helper does not reserve, $proof_stranger, is refused" refused_fork "$proof_stranger" "$proof_fork_uid"
  echo "note: the helper said: $(cat "$proof_run/err")"
  proof_check "the refused fork made no user $proof_stranger" no_user "$proof_stranger"
  began=$(now_ms)
  make_fork "$proof_user" snproof000001 "$proof_fork_user" "$proof_fork_uid" >"$proof_run/out" || fail "The fork failed: $(cat "$proof_run/out")"
  fork=$ROOT/Users/$proof_fork_user
  record_again "$proof_fork_user" "$fork"
  echo "fork: $(( $(now_ms) - began )) ms"
  proof_check "the fork's home holds the snapshot's files" file_says "$fork/proof/file.txt" before
  proof_check "the fork's files are its own user's" owned_by "$fork/proof/file.txt" "$proof_fork_uid"
  proof_check "the fork keeps nothing of BB's machine, access file, launch agent or keychains: $(field "$proof_run/out" left)" test -z "$(field "$proof_run/out" left)"
  proof_check "the fork has no plist naming the source's home" absent "$fork/Library/Preferences/com.apple.proof-path.plist"
  proof_check "the source's home is untouched by the fork" owned_by "$probe_home/proof/file.txt" "$proof_uid"
  proof_check "a fork aimed at a user on the Mac already, $proof_fork_user, is refused" refused_fork "$proof_fork_user" "$proof_fork_uid"
  echo "note: the helper said: $(cat "$proof_run/err")"
  proof_check "the refused fork left $proof_fork_user with UID $proof_fork_uid" test "$(attribute "$proof_fork_user" UniqueID)" = "$proof_fork_uid"
  proof_check "the refused fork left $proof_fork_user's files as they were" owned_by "$fork/proof/file.txt" "$proof_fork_uid"

  prove_slot_snapshots
  proof_check "the user at the console is as before the proof: ${proof_console_before:-none}" test "$(console)" = "$proof_console_before"
  for id in snproof000001 snproofundo01; do
    remove_one_recorded "$(store_of "$proof_user")/$id"
    proof_check "deleted snapshot $id, which it recorded making in its own store" absent "$(store_of "$proof_user")/$id"
  done
}

snapshot() {
  verb=${1:-}
  [ $# -eq 0 ] || shift
  case $verb in
    probe)
      [ $# -eq 0 ] || quit 2 "usage: machine snapshot probe"
      probe_snapshots
      ;;
    take)
      [ $# -eq 2 ] && snapshot_name_ok "$2" || quit 2 "usage: machine snapshot take <generation | slot-<n>> <snapshot>"
      read_input
      hold_for "$1" 60
      lent_user "$1"
      exit_cleanly
      take_home "$user" "$uid" "$2"
      ;;
    list)
      [ $# -eq 0 ] || quit 2 "usage: machine snapshot list"
      read_input
      list_snapshots
      ;;
    delete)
      [ $# -eq 2 ] && snapshot_name_ok "$1" && snapshot_name_ok "$2" || quit 2 "usage: machine snapshot delete <user> <snapshot>"
      read_input
      lock 300
      hold_a_slot_users_store "$1" 300
      delete_snapshot "$1" "$2"
      ;;
    stop | start)
      [ $# -eq 1 ] || quit 2 "usage: machine snapshot $verb <generation | slot-<n>>"
      read_input
      hold_for "$1" 60
      lent_user "$1"
      if [ "$verb" = stop ]; then end_session "$user" "$uid"; else start_session "$user" "$uid"; fi
      ;;
    restore)
      [ $# -eq 3 ] && snapshot_name_ok "$2" && snapshot_name_ok "$3" || quit 2 "usage: machine snapshot restore <generation | slot-<n>> <snapshot> <operation>"
      read_input
      hold_for "$1" 300
      lent_user "$1"
      restore_home "$user" "$uid" "$2" "$3"
      ;;
    fork)
      [ $# -eq 4 ] && snapshot_name_ok "$1" && snapshot_name_ok "$2" && snapshot_name_ok "$3" && number "$4" || quit 2 "usage: machine snapshot fork <source user> <snapshot> <user> <uid>"
      read_input
      lock 300
      fork_home "$1" "$2" "$3" "$4"
      ;;
    forget-slot)
      [ $# -eq 1 ] && a_slot_number "$1" || quit 2 "usage: machine snapshot forget-slot <slot>"
      forget_slot_snapshots "$1"
      ;;
    proof)
      [ $# -eq 0 ] || quit 2 "usage: machine snapshot proof"
      prove_home_snapshots
      ;;
    *) quit 2 "usage: machine snapshot probe | take <holder> <snapshot> | list | delete <user> <snapshot> | stop <holder> | restore <holder> <snapshot> <operation> | start <holder> | fork <source user> <snapshot> <user> <uid> | forget-slot <slot> | proof, where a holder is the Mac's generation, or slot-<n> for an iOS slot" ;;
  esac
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
  if [ "$marker" = owner ] && [ -f "$(session_file "$(field "$STATE/owner" user)")" ]; then echo session=stopped; else echo session=; fi
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
  slots_set_up && device_host summary </dev/null 2>/dev/null | sed 's/^/slots./'
  [ ! -r "$SNAPSHOT_REPORT" ] || cat "$SNAPSHOT_REPORT"
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
  user_made=no
  make_user "$1" "$2" && user_made=yes
  [ -z "$when_a_user_is_made" ] || "$when_a_user_is_made" "$1" "$2"
  [ "$user_made" = no ] || return 0
  "$on_a_half_made_user" "$1"
  return 1
}

remove_half_made_user() { remove_user "$1" >/dev/null; }

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

clients_of() { pgrep -l -u "$1" 2>/dev/null | awk -v keep="$CONTAINERS_PROCESS" '$2 != keep { print $2 }' | sort -u; }

end_clients_before_containers() {
  for name in $(clients_of "$1"); do pkill -TERM -u "$1" -x "$name" >/dev/null 2>&1; done
  tries=25
  while [ -n "$(clients_of "$1")" ] && [ "$tries" -gt 0 ]; do
    tries=$((tries - 1))
    sleep 0.2
  done
}

stop_gently() {
  user=$1 uid=$2
  pgrep -u "$uid" >/dev/null 2>&1 || return 0
  if pgrep -u "$uid" -x launchd_sim >/dev/null 2>&1; then within 30 sudo -n -H -u "$user" -- xcrun simctl shutdown all >/dev/null 2>&1; fi
  end_clients_before_containers "$uid"
  sleep 1
}

UNUSED_WHEN_PICKED=unused-when-picked

a_name_this_proof_recorded() {
  [ -f "$PROOF_RECORD" ] && awk -v n="$1" '$1 == "user" && $2 == n { found = 1 } END { exit !found }' "$PROOF_RECORD"
}

still_the_account_this_proof_made() {
  made_as=$(awk -v n="$1" -v unused="$UNUSED_WHEN_PICKED" '$1 == "user" && $2 == n && $5 == unused { print $3 ":" $4 }' "$PROOF_RECORD" 2>/dev/null | tail -n 1)
  [ -n "$made_as" ] && [ "${made_as%%:*}" = "$2" ] && [ "$(identity_now account "$1")" = "$made_as" ]
}

end_every_process_of_an_account_this_proof_made() {
  if still_the_account_this_proof_made "$1" "$2"; then
    end_every_process_of_the_uid "$1" "$2"
    return
  fi
  echo "note: left every process of user $1, UID $2, as it is not now the account the proof made, recorded with a UID no process used when it was picked" >&2
  return 1
}

log_out() {
  user=$1 uid=${2:-}
  [ -n "$uid" ] || uid=$(attribute "$user" UniqueID)
  if box_uid "$uid" || a_slot_user_the_device_host_made "$user" "$uid"; then
    end_every_process_of_the_uid "$user" "$uid"
  elif a_name_this_proof_recorded "$user"; then
    end_every_process_of_an_account_this_proof_made "$user" "$uid"
  fi
}

end_every_process_of_the_uid() {
  user=$1 uid=$2
  stop_gently "$user" "$uid"
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

leave_groups() {
  for group in $JOINS; do
    for name in "$group" "$group-disabled"; do
      dseditgroup -o edit -d "$1" -t user "$name" >/dev/null 2>&1 ||
        dscl . -delete "/Groups/$name" GroupMembership "$1" >/dev/null 2>&1
    done
  done
}

# Removes a box user and everything it left.
remove_user() {
  user=$1 uid=${2:-}
  [ -n "$uid" ] || uid=$(attribute "$user" UniqueID)
  log_out "$user" "$uid"
  remove_tree "$HOME_SNAPSHOTS/$user" || fail "Could not delete the home snapshots of $user in $HOME_SNAPSHOTS/$user."
  rm -f "$ROOT/etc/sudoers.d/$user" "$ROOT/etc/sudoers.d/$user.new"
  crontab -u "$user" -r >/dev/null 2>&1
  rm -f "$ROOT/private/var/at/tabs/$user"
  # Its at jobs are files it owns, in /private/var/at/jobs, which the sweep
  # removes. macOS's atq does not say whose a job is.
  [ -z "$uid" ] || remove_ipc "$user" "$uid"
  leave_groups "$user"
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

slots_set_up() { [ -f "$DEVICE_HOST" ] && [ -e "$SLOTS_STATE/kept" ]; }
device_host() { /bin/sh "$DEVICE_HOST" "$@" 9>&-; }

slots_words() {
  held=$(printf '%s\n' "$1" | sed -n 's/^held=//p' | head -n 1)
  waiting=$(printf '%s\n' "$1" | sed -n 's/^waiting=//p' | head -n 1)
  words="${held:-0} held"
  [ "${waiting:-0}" = 0 ] || words="$words, ${waiting} waiting for a box"
  echo "The pool's Mac is lending iOS slots ($words). It is lent whole again when they are released."
}

close_slots_or_quit() {
  slots_set_up || return 0
  said=$(device_host close </dev/null 2>&1)
  case $? in
    0) ;;
    8) quit "$1" "$(slots_words "$said")" ;;
    *) fail "The Mac's iOS slots could not be closed, so it is not lent whole: $(printf '%s\n' "$said" | grep -v -e '^held=' -e '^waiting=' | tail -n 1)" ;;
  esac
}

slot_number_or_quit() {
  verb=$1
  shift
  number "${1:-}" && [ "$1" -gt 0 ] && [ $# -eq 1 ] || quit 2 "usage: machine slot $verb <slot>, a slot's number"
}

refuse_while_whole() {
  if [ -e "$STATE/owner" ]; then quit "$EXIT_LENT_WHOLE" "The pool's Mac is lent whole to a box, so it lends no iOS slot until that box is released."; fi
  if [ -e "$STATE/resetting" ]; then quit "$EXIT_LENT_WHOLE" "The pool's Mac is resetting after a box it was lent whole to, so it lends no iOS slot until its reset ends."; fi
}

slot() {
  verb=${1:-}
  [ $# -eq 0 ] || shift
  slots_set_up || quit 2 "This Mac has no iOS slots set up. Run bb-box's setup-mac.sh on it, with Xcode and its iOS platform, and the whole setup folder beside it."
  case $verb in
    status | summary)
      [ $# -eq 0 ] || quit 2 "usage: machine slot $verb"
      exec /bin/sh "$DEVICE_HOST" "$verb" </dev/null
      ;;
    open | close)
      [ $# -eq 0 ] || quit 2 "usage: machine slot $verb"
      lock 60
      [ "$verb" = close ] || refuse_while_whole
      device_host "$verb"
      exit $?
      ;;
    make | promise)
      [ $# -eq 0 ] || quit 2 "usage: machine slot $verb"
      lock 60
      refuse_while_whole
      exec /bin/sh "$DEVICE_HOST" "$verb" 9>&-
      ;;
    claim)
      slot_number_or_quit claim "$@"
      lock 60
      refuse_while_whole
      exec /bin/sh "$DEVICE_HOST" claim "$1" 9>&-
      ;;
    unpromise)
      [ $# -eq 0 ] || quit 2 "usage: machine slot unpromise"
      exec /bin/sh "$DEVICE_HOST" unpromise
      ;;
    release | daemon | restart)
      slot_number_or_quit "$verb" "$@"
      exec /bin/sh "$DEVICE_HOST" "$verb" "$1"
      ;;
    keep-app)
      [ $# -eq 0 ] || quit 2 "usage: machine slot keep-app"
      caller=${SUDO_USER:-}
      [ -n "$caller" ] && [ "$caller" != root ] || quit 2 "machine slot keep-app copies BB's app from the home of the user who runs it through sudo."
      home=$(dscl . -read "/Users/$caller" NFSHomeDirectory 2>/dev/null | sed -n 's/^NFSHomeDirectory: //p')
      [ -n "$home" ] || quit 2 "$caller has no home."
      { grep -E '^(server|digest)=' || true; printf 'from=%s\n' "$home"; } | exec /bin/sh "$DEVICE_HOST" keep-app
      ;;
    *) quit 2 "usage: machine slot status | summary | open | close | make | promise | unpromise | claim <slot> | release <slot> | daemon <slot> | restart <slot> | keep-app" ;;
  esac
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
  close_slots_or_quit "$EXIT_SLOTS_HELD"
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
    close_slots_or_quit 4
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
asks_for_the_proof() { [ "${1:-}" = snapshot ] && [ "${2:-}" = proof ]; }

asks_for_the_proof "$@" || resume_abandoned_pauses
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
  slot) slot "$@" ;;
  snapshot) snapshot "$@" ;;
  vm-ready | vm-grant | vm-granted)
    [ $# -eq 1 ] && [ -n "$1" ] || quit 2 "usage: machine $verb <user>"
    case $verb in vm-ready) vm_ready "$1" ;; vm-grant) grant "$1" ;; vm-granted) vm_granted "$1" ;; esac
    ;;
  init) init ;;
  version) echo "$VERSION" ;;
  *) quit 2 "usage: machine status [grants] | claim | grant | granted | release | reset | display | slot | snapshot probe | vm-ready | vm-grant | vm-granted | init | version" ;;
esac
