#!/bin/sh
set -u
umask 022
PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin
LC_ALL=C
export PATH LC_ALL

HERE=$(cd "$(dirname "$0")" && pwd)
CLONE_TREE=${BBBOX_CLONE_TREE:-$HERE/clone-tree}
STATE=${BBBOX_STATE:-/var/db/bb-box-spike}
STORE=$STATE/home-snapshots
LOGINWINDOW=/Library/Preferences/com.apple.loginwindow
CONTRACT=1
EXIT_FAILED=1
EXIT_USAGE=2
EXIT_NOT_FOUND=4
EXIT_REFUSED=5

quit() {
  code=$1
  shift
  [ $# -eq 0 ] || printf '%s\n' "$*" >&2
  exit "$code"
}
fail() { quit "$EXIT_FAILED" "$@"; }
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'; }
valid_name() { case $1 in '' | *[!A-Za-z0-9._-]* | .*) return 1 ;; esac; }
home_of() { echo "/Users/$1"; }
attribute() { dscl . -read "/Users/$1" "$2" 2>/dev/null | sed -n -e "s/^$2: //p" | head -n 1; }
uid_of() { attribute "$1" UniqueID; }
console() { stat -f %Su /dev/console 2>/dev/null; }
used_bytes() { df -k /System/Volumes/Data | awk 'NR == 2 { print $3 * 1024 }'; }
snapshot_path() { echo "$STORE/$1/$2"; }

volume_of() { df "$1" | awk 'NR == 2 { print $1 }'; }

probe() {
  personality=$(diskutil info "$(volume_of /Users)" 2>/dev/null | sed -n 's/^ *Type (Bundle): *//p')
  mkdir -p "$STORE" && chmod 700 "$STATE" "$STORE"
  same_volume=no
  [ "$(volume_of /Users)" = "$(volume_of "$STORE")" ] && same_volume=yes
  probe_dir=$STORE/.probe.$$
  mkdir "$probe_dir" && echo probe >"$probe_dir/file"
  clones=no
  "$CLONE_TREE" "$probe_dir" "$probe_dir.clone" 2>/dev/null && clones=yes
  rm -rf "$probe_dir" "$probe_dir.clone"
  if [ "$personality" = apfs ] && [ "$same_volume" = yes ] && [ "$clones" = yes ]; then
    printf '{"contract":%s,"scope":"home","way":"apfs-clonefile","offers":true}\n' "$CONTRACT"
  else
    printf '{"contract":%s,"scope":"home","way":"none","offers":false,"why":"Box homes are on %s, and clonefile said %s."}\n' "$CONTRACT" "${personality:-unknown}" "$clones"
  fi
}

make_user() {
  user=${1:-} uid=${2:-} with_home=${3:-home}
  valid_name "$user" || quit "$EXIT_USAGE" "usage: make-user <user> <uid>"
  password=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)
  printf '%s\n' "$password" | sysadminctl -addUser "$user" -fullName "bb-box $user" -UID "$uid" -password - -home "/Users/$user" >/dev/null 2>&1
  [ "$(uid_of "$user")" = "$uid" ] || fail "sysadminctl did not make $user."
  dscl . -create "/Users/$user" IsHidden 1
  dseditgroup -o edit -a "$user" -t user _developer >/dev/null 2>&1
  dsmemberutil flushcache >/dev/null 2>&1
  mkdir -p "$STATE/passwords" && chmod 700 "$STATE/passwords"
  (umask 077 && printf '%s\n' "$password" >"$STATE/passwords/$user")
  if [ "$with_home" = home ]; then
    createhomedir -c -u "$user" >/dev/null 2>&1
    chown -R "$uid:20" "/Users/$user"
  fi
  printf '{"user":"%s","uid":%s}\n' "$user" "$uid"
}

kcpassword() {
  perl -e '
    my @key = (0x7D, 0x89, 0x52, 0x23, 0xD2, 0xBC, 0xDD, 0xEA, 0xA3, 0xB9, 0x1F);
    my $password = <STDIN>;
    chomp $password;
    my @bytes = (unpack("C*", $password), 0);
    push @bytes, 0 while @bytes % 12;
    print pack("C*", map { $bytes[$_] ^ $key[$_ % 11] } 0 .. $#bytes);'
}

wait_for_console() {
  user=$1 most=$2 waited=0
  while [ "$(console)" != "$user" ]; do
    [ "$waited" -lt "$most" ] || return 1
    sleep 1
    waited=$((waited + 1))
  done
  echo "$waited"
}

sign_in() {
  user=${1:-}
  started=$(now_ms)
  (umask 077 && kcpassword <"$STATE/passwords/$user" >/etc/kcpassword)
  defaults write "$LOGINWINDOW" autoLoginUser -string "$user"
  nohup sh -c 'sleep 1; launchctl reboot userspace' >/dev/null 2>&1 &
  printf '{"user":"%s","way":"userspace","asked":%s}\n' "$user" "$started"
}

end_processes() {
  user=$1 uid=$2
  pgrep -u "$uid" -x launchd_sim >/dev/null 2>&1 && sudo -n -H -u "$user" -- xcrun simctl shutdown all >/dev/null 2>&1
  launchctl bootout "gui/$uid" >/dev/null 2>&1
  launchctl bootout "user/$uid" >/dev/null 2>&1
  tries=0
  while pgrep -u "$uid" >/dev/null 2>&1; do
    pkill -KILL -u "$uid" >/dev/null 2>&1
    tries=$((tries + 1))
    [ "$tries" -le 50 ] || fail "Processes of $user did not end: $(pgrep -l -u "$uid" | head -n 3 | tr '\n' ' ')"
    sleep 0.2
  done
}

clone_home() {
  "$CLONE_TREE" "$1" "$2" || fail "clonefile could not clone $1."
}

take() {
  user=${1:-} id=${2:-}
  valid_name "$user" && valid_name "$id" || quit "$EXIT_USAGE" "usage: take <user> <snapshot>"
  target=$(snapshot_path "$user" "$id")
  if [ -d "$target" ]; then
    printf '{"id":"%s","user":"%s","state":"complete","tookMs":0}\n' "$id" "$user"
    return 0
  fi
  mkdir -p "$STORE/$user" && chmod 700 "$STATE" "$STORE" "$STORE/$user"
  before=$(used_bytes)
  started=$(now_ms)
  clone_home "$(home_of "$user")" "$target.partial"
  mv "$target.partial" "$target"
  took=$(($(now_ms) - started))
  date +%s >"$STORE/$user/.$id.taken"
  printf '{"id":"%s","user":"%s","state":"complete","tookMs":%s,"dataVolumeGrewBytes":%s}\n' "$id" "$user" "$took" $(($(used_bytes) - before))
}

list() {
  user=${1:-}
  printf '{"user":"%s","snapshots":[' "$user"
  separator=''
  for path in "$STORE/$user"/*; do
    [ -d "$path" ] || continue
    id=${path##*/} state=complete
    case $id in *.partial) id=${id%.partial} state=incomplete ;; esac
    printf '%s{"id":"%s","state":"%s","takenAt":%s}' "$separator" "$id" "$state" "$(cat "$STORE/$user/.$id.taken" 2>/dev/null || echo null)"
    separator=,
  done
  printf ']}\n'
}

swap_home() {
  user=$1 id=$2
  home=$(home_of "$user")
  replaced=$STORE/$user/.replaced
  if [ ! -e "$replaced" ] && [ -d "$home" ]; then mv "$home" "$replaced" || fail "Could not move $user's home aside."; fi
  [ -d "$home" ] || clone_home "$(snapshot_path "$user" "$id")" "$home"
  rm -rf "$replaced" || fail "Could not delete the home it replaced."
}

restore() {
  user=${1:-} id=${2:-} undo=${3:-}
  valid_name "$user" && valid_name "$id" && valid_name "$undo" || quit "$EXIT_USAGE" "usage: restore <user> <snapshot> <undo>"
  [ -d "$(snapshot_path "$user" "$id")" ] || quit "$EXIT_NOT_FOUND" "$user has no snapshot $id."
  uid=$(uid_of "$user")
  at_console=no
  [ "$(console)" = "$user" ] && at_console=yes
  started=$(now_ms)
  end_processes "$user" "$uid"
  stopped=$(now_ms)
  (take "$user" "$undo") >/dev/null || fail "Could not take the undo, so nothing changed."
  swap_home "$user" "$id"
  swapped=$(now_ms)
  printf '{"id":"%s","user":"%s","undo":"%s","wasAtConsole":"%s","stopMs":%s,"undoAndSwapMs":%s}\n' "$id" "$user" "$undo" "$at_console" $((stopped - started)) $((swapped - stopped))
}

identity_left_in() {
  home=$1
  for each in "$home"/.bb-machines/*/host-id "$home"/.bb-machines/*/auth.json "$home"/.bb-machines/*/config.json "$home"/.config/bb-box/env "$home"/Library/LaunchAgents/app.getbb.* "$home"/Library/Keychains/login.keychain-db "$home"/Library/Keychains/????????-????-????-????-???????????? "$home"/.ssh/id_* "$home"/.config/gh/hosts.yml; do
    [ -e "$each" ] && printf '%s\n' "${each#"$home"/}"
  done
}

reset_identity() {
  home=$1
  rm -rf "$home"/.bb-machines/*/host-id "$home"/.bb-machines/*/auth.json "$home"/.bb-machines/*/config.json "$home"/.bb-machines/*/daemon.lock
  rm -f "$home"/.config/bb-box/env "$home"/Library/LaunchAgents/app.getbb.*
  rm -rf "$home"/Library/Keychains/login.keychain-db "$home"/Library/Keychains/????????-????-????-????-????????????
}

fork() {
  source=${1:-} id=${2:-} user=${3:-} uid=${4:-}
  valid_name "$source" && valid_name "$id" && valid_name "$user" || quit "$EXIT_USAGE" "usage: fork <user> <snapshot> <new user> <uid>"
  [ -d "$(snapshot_path "$source" "$id")" ] || quit "$EXIT_NOT_FOUND" "$source has no snapshot $id."
  source_uid=$(uid_of "$source")
  source_guid=$(attribute "$source" GeneratedUID)
  make_user "$user" "$uid" no-home >/dev/null
  home=$(home_of "$user")
  rm -rf "$home"
  started=$(now_ms)
  clone_home "$(snapshot_path "$source" "$id")" "$home"
  cloned=$(now_ms)
  find "$home" -user "$source_uid" -exec chown -h "$uid" {} +
  owned=$(now_ms)
  before=$(identity_left_in "$home" | tr '\n' ' ')
  naming_source_guid=$(grep -rlI "$source_guid" "$home" 2>/dev/null | head -n 5 | tr '\n' ' ')
  naming_source_path=$(grep -rlI --exclude-dir=Caches "/Users/$source" "$home" 2>/dev/null | head -n 8 | tr '\n' ' ')
  reset_identity "$home"
  after=$(identity_left_in "$home" | tr '\n' ' ')
  printf '{"user":"%s","from":"%s@%s","cloneMs":%s,"chownMs":%s,"identityBefore":"%s","identityAfter":"%s","filesNamingSourceGUID":"%s","filesNamingSourcePath":"%s"}\n' \
    "$user" "$source" "$id" $((cloned - started)) $((owned - cloned)) "$before" "$after" "$naming_source_guid" "$naming_source_path"
}

delete() {
  user=${1:-} id=${2:-}
  rm -rf "$(snapshot_path "$user" "$id")" "$(snapshot_path "$user" "$id").partial" "$STORE/$user/.$id.taken"
  printf '{"id":"%s","state":"gone"}\n' "$id"
}

[ "$(id -u)" = 0 ] || quit "$EXIT_USAGE" "Run it as root."
verb=${1:-}
[ $# -eq 0 ] || shift
case $verb in
  probe) probe ;;
  make-user) make_user "$@" ;;
  sign-in) sign_in "$@" ;;
  wait-for-console) wait_for_console "$@" ;;
  end-processes) end_processes "$1" "$(uid_of "$1")" ;;
  take) take "$@" ;;
  list) list "$@" ;;
  restore) restore "$@" ;;
  fork) fork "$@" ;;
  delete) delete "$@" ;;
  *) quit "$EXIT_USAGE" "usage: home-mac.sh probe | make-user | sign-in | wait-for-console | end-processes | take | list | restore | fork | delete" ;;
esac
