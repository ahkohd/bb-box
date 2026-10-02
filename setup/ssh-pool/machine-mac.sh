#!/bin/sh
# bb-box's helper on a Mac in the SSH host pool (047). bb-box's admin user
# runs it through sudo, and runs nothing else as root. It has the commands,
# input, output and exit codes of the Linux helper, machine.sh, and one more,
# display. setup-mac.sh installs it as /usr/local/libexec/bb-box/machine.
#
#   machine status [grants]       grants: also Cua Driver's grants, which take seconds
#   machine claim <generation>    stdin: install, box, thread, name, kind, created, key
#   machine release <generation>  stdin: install, and box unless the box is not known
#   machine reset                 stdin: install, or nothing when an operator runs it
#   machine display <generation>  stdin: install, box
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
#
# Each box gets a new standard user, bbx-<generation>, whose UID is 70000
# plus the generation modulo 10000. It is hidden from the login window and in
# the _developer group, and its home is macOS's template with bb-box's,
# /usr/local/share/bb-box/home, on top. The reset makes the next box's user
# ahead and signs it in, so a free Mac has it at the console:
#
# 1. It logs the old box users out and ends their processes.
# 2. It makes the next user, with a random password, and sets it as the
#    automatic login.
# 3. It starts loginwindow again, which signs the next user in.
# 4. It removes the old users' crontabs, at jobs, System V IPC objects, sudo
#    rules and every file they own on the Data volume, then the users.
#    Some folders a user's first sign-in makes, such as ~/Library/Mail, are
#    protected: root removes them only with Full Disk Access, which SSH
#    sessions have when Remote Login allows it.
# 5. It checks that nothing of theirs is left and that the next user is at
#    the console, then moves the generation on.
#
# loginwindow signs a user in only when it starts. The reset restarts
# loginwindow alone first. If that does not sign the user in within a
# minute, it restarts userspace, then the whole Mac, and until the user is at
# the console it reports the reset as still running (exit 10). It remembers
# which way worked.
#
# The password is for Screen Sharing, which the relay signs in to as the box
# user: display prints it, and nothing else does. It is in sysadminctl's
# arguments, which ps shows, only in step 2, while no box user has a process.
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
now() { date +%s; }
# Writes stdin to a file in one step.
put() { cat >"$1.new.$$" && mv -f "$1.new.$$" "$1"; }
# Changes when the Mac starts again.
boot_id() { sysctl -n kern.bootsessionuuid 2>/dev/null || echo unknown; }
# A user's attribute in the local directory, such as its UniqueID.
attribute() { dscl . -read "/Users/$1" "$2" 2>/dev/null | sed -n "s/^$2: //p" | head -n 1; }
# Whether this helper has Full Disk Access.
full_disk() { head -c 1 "$ROOT$TCC" >/dev/null 2>&1; }
# The user at the console: root at the login window.
console() { stat -f %Su /dev/console 2>/dev/null; }
box_users() { dscl . -list /Users 2>/dev/null | grep "^$PREFIX"; }

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

# Box users, and the names of those that left a home, a sudo rule, a crontab or a password.
box_names() {
  {
    box_users
    for path in "$ROOT"/Users/"$PREFIX"* "$ROOT"/etc/sudoers.d/"$PREFIX"* "$ROOT"/private/var/at/tabs/"$PREFIX"* "$STATE"/passwords/"$PREFIX"*; do
      [ -e "$path" ] && echo "${path##*/}"
    done
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
    for user in $(dscl . -read "/Groups/$group" GroupMembership 2>/dev/null | sed 's/^GroupMembership://'); do
      case $user in "$PREFIX"*) [ "$user" = "$ready" ] || echo "$user in group $group" ;; esac
    done
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

# Cua Driver's Accessibility and Screen Recording grants, as Cua reports them
# in the session of the box user at the console: 1 or 0 each, or empty when
# no box user is there or Cua did not answer. Cua runs with the box user's
# HOME, where its socket is. Only `status grants` asks, as the pool's doctor
# does, since the pool reads every Mac's status twice for each box it lends.
grants() {
  accessibility='' recording=''
  user=$(console)
  uid=''
  case $user in "$PREFIX"*) uid=$(attribute "$user" UniqueID) ;; esac
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
}

status() {
  [ $# -eq 0 ] || { [ $# -eq 1 ] && [ "$1" = grants ]; } || quit 2 "usage: machine status [grants]"
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
  # Screen Sharing, which the box's display uses, and Full Disk Access,
  # which the reset needs.
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
  [ $# -eq 0 ] || grants
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
  sysadminctl -addUser "$user" -fullName "bb-box box" -UID "$uid" -password "$password" -home "/Users/$user" >/dev/null 2>&1
  # sysadminctl can fail and still exit 0.
  [ "$(attribute "$user" UniqueID)" = "$uid" ] || return 1
  dscl . -create "/Users/$user" IsHidden 1 || return 1
  for group in $JOINS; do
    [ "$group" = _developer ] || dscl . -read "/Groups/$group" >/dev/null 2>&1 || continue
    dseditgroup -o edit -a "$user" -t user "$group" >/dev/null 2>&1 || return 1
  done
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
  chown -R "$uid:20" "$home" || return 1
  # No notices that background items were added, such as Cua's and BB's daemons, as in Tart's image.
  launchctl disable "gui/$uid/com.apple.backgroundtaskmanagement.agent" >/dev/null 2>&1
  mkdir -p "$STATE/passwords" && chmod 700 "$STATE/passwords" || return 1
  (umask 077 && printf '%s\n' "$password" | put "$STATE/passwords/$user") || return 1
}

# Makes box user $1 with UID $2, unless it is made already. A user half made, by a reset cut short, is made again.
ready_user() {
  if [ "$(attribute "$1" UniqueID)" = "$2" ] && [ -s "$STATE/passwords/$1" ]; then return 0; fi
  if dscl . -read "/Users/$1" >/dev/null 2>&1 || [ -e "$ROOT/Users/$1" ]; then remove_user "$1"; fi
  make_user "$1" "$2" && return 0
  remove_user "$1" >/dev/null
  return 1
}

# Sets box user $1 as the user loginwindow signs in when it starts.
automatic_login() {
  user=$1
  if [ "$(defaults read "$LOGINWINDOW" autoLoginUser 2>/dev/null)" = "$user" ] && [ -e "$ROOT/etc/kcpassword" ]; then return 0; fi
  password=$(cat "$STATE/passwords/$user" 2>/dev/null)
  [ -n "$password" ] || fail "Box user $user has no password in $STATE/passwords."
  sysadminctl -autologin set -userName "$user" -password "$password" >/dev/null 2>&1
  [ "$(defaults read "$LOGINWINDOW" autoLoginUser 2>/dev/null)" != "$user" ] || return 0
  fdesetup status 2>/dev/null | grep -qx 'FileVault is Off\.' ||
    fail "FileVault is on, so the Mac cannot sign box users in by itself. Turn FileVault off."
  fail "sysadminctl did not set $user as the automatic login."
}

# How long each way of starting loginwindow again may take to sign the user in, in seconds.
patience() {
  case $1 in
    loginwindow) echo 60 ;;
    userspace) echo 180 ;;
    *) echo 480 ;;
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
    method=loginwindow
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
  number "$uid" || return 0
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

# Removes every file and directory UID $1 owns on the Data volume, clearing
# the flags that stop even root, and prints those still there.
sweep() {
  find "$DATA" -xdev -uid "$1" -prune -exec sh -c '
    chflags -R nouchg,nouappnd "$@" 2>/dev/null
    rm -rf "$@" 2>/dev/null
    for path; do if [ -e "$path" ] || [ -L "$path" ]; then printf "%s\n" "$path"; fi; done' sh {} + 2>/dev/null
  return 0
}

# Removes a box user and everything it left.
remove_user() {
  user=$1 uid=${2:-}
  [ -n "$uid" ] || uid=$(attribute "$user" UniqueID)
  log_out "$user" "$uid"
  rm -f "$ROOT/etc/sudoers.d/$user" "$ROOT/etc/sudoers.d/$user.new"
  crontab -u "$user" -r >/dev/null 2>&1
  rm -f "$ROOT/private/var/at/tabs/$user"
  # macOS's atq: the date, then the owner, queue and job number.
  atq 2>/dev/null | awk -v u="$user" 'NF > 3 && $(NF - 2) == u { print $NF }' | while read -r job; do atrm "$job"; done
  [ -z "$uid" ] || remove_ipc "$user" "$uid"
  for group in $JOINS; do dseditgroup -o edit -d "$user" -t user "$group" >/dev/null 2>&1; done
  if number "$uid"; then
    left=$(sweep "$uid" | head -n 1)
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
  rm -rf "$ROOT/Users/$user"
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

  # 1. Log the old box users out, and end their processes.
  [ -z "$old" ] || log_out "$old" "$old_uid"
  for other in $(box_users); do [ "$other" = "$next_user" ] || log_out "$other"; done

  # 2. Make the next box's user, and set it as the automatic login.
  ready_user "$next_user" "$next_uid" || fail "Could not make box user $next_user."
  automatic_login "$next_user"

  # 3. Start loginwindow again, which signs the next user in. Restarting
  # loginwindow alone leaves this helper running, so it starts now and signs
  # the user in while step 4 runs. The other ways wait for step 5.
  if [ "$(console)" != "$next_user" ] && [ "$(field "$STATE/signin" user)" != "$next_user" ]; then
    method=$(cat "$STATE/signs-in-by" 2>/dev/null)
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

  # 5. Check that nothing of theirs is left, and that the next user is at the console.
  problem=$(dirt "$next_user" | head -n 1)
  [ -z "$problem" ] || fail "The reset left $problem."
  sign_in "$next_user"
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
  release) release "$@" ;;
  reset) reset "$@" ;;
  display) display "$@" ;;
  init) init ;;
  version) echo "$VERSION" ;;
  *) quit 2 "usage: machine status [grants] | claim | release | reset | display | init | version" ;;
esac
