#!/bin/sh
set -u
umask 022
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
LC_ALL=C
export PATH LC_ALL

HOMES=${BBBOX_HOMES:-/home}
STORE_NAME=.bb-box-snapshots
STORE=$HOMES/$STORE_NAME
ZFS_PARENT=${BBBOX_ZFS_PARENT:-}
CONTRACT=1
ID_BASE=70000
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
now_ms() { date +%s%3N; }
json_string() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"; }
valid_name() { case $1 in '' | *[!A-Za-z0-9._-]* | .*) return 1 ;; esac; }
home_of() { echo "$HOMES/$1"; }
uid_of() { id -u "$1" 2>/dev/null; }

filesystem_of() { stat -f -c %T "$1" 2>/dev/null; }

is_btrfs_subvolume() { [ "$(filesystem_of "$1")" = btrfs ] && [ "$(stat -c %i "$1" 2>/dev/null)" = 256 ]; }

zfs_dataset_of() { zfs list -H -o name,mountpoint 2>/dev/null | awk -v m="$1" '$2 == m { print $1; exit }'; }

home_way() {
  home=$(home_of "$1")
  if is_btrfs_subvolume "$home"; then
    echo btrfs
  elif command -v zfs >/dev/null 2>&1 && [ -n "$(zfs_dataset_of "$home")" ]; then
    echo zfs
  elif [ "$(filesystem_of "$HOMES")" = btrfs ]; then
    echo btrfs-not-subvolume
  else
    echo none
  fi
}

homes_way() {
  case $(filesystem_of "$HOMES") in
    btrfs) echo btrfs ;;
    zfs) [ -n "$ZFS_PARENT" ] && echo zfs || echo zfs-without-parent ;;
    *) echo none ;;
  esac
}

why_not() {
  case $1 in
    none) echo "Box homes in $HOMES are on $(filesystem_of "$HOMES"), which neither clones nor snapshots. Put them on btrfs or ZFS." ;;
    zfs-without-parent) echo "Box homes in $HOMES are on ZFS, but no dataset is set for them. Set BBBOX_ZFS_PARENT." ;;
    btrfs-not-subvolume) echo "The home is a plain folder on btrfs, made before homes were subvolumes. Release the box and make it again." ;;
  esac
}

probe() {
  way=$(homes_way)
  printf '{"contract":%s,"scope":"home","way":%s,"homes":%s,"filesystem":%s' "$CONTRACT" "$(json_string "$way")" "$(json_string "$HOMES")" "$(json_string "$(filesystem_of "$HOMES")")"
  case $way in
    btrfs | zfs) printf ',"offers":true}\n' ;;
    *) printf ',"offers":false,"why":%s}\n' "$(json_string "$(why_not "$way")")" ;;
  esac
}

make_home() {
  user=$1
  home=$(home_of "$user")
  case $(homes_way) in
    btrfs) btrfs subvolume create "$home" >/dev/null ;;
    zfs) zfs create -o mountpoint="$home" "$ZFS_PARENT/$user" ;;
    *) mkdir "$home" ;;
  esac
}

make_user() {
  user=$1 uid=$2
  valid_name "$user" || quit "$EXIT_USAGE" "usage: make-user <user> <uid>"
  home=$(home_of "$user")
  groupadd -g "$uid" "$user" || fail "groupadd $user"
  make_home "$user" || fail "Could not make $home."
  useradd -u "$uid" -g "$uid" -M -d "$home" -s /bin/bash -c "bb-box box" "$user" || fail "useradd $user"
  cp -a /etc/skel/. "$home/"
  mkdir -p "$home/.ssh" "$home/.cache"
  chown -R "$uid:$uid" "$home"
  chmod 700 "$home"
  usermod -p '*' "$user"
  loginctl enable-linger "$user" 2>/dev/null
  printf '{"user":%s,"uid":%s,"home":%s,"way":%s}\n' "$(json_string "$user")" "$uid" "$(json_string "$home")" "$(json_string "$(home_way "$user")")"
}

snapshot_path() { echo "$STORE/$1/$2"; }
zfs_home() { zfs_dataset_of "$(home_of "$1")"; }

bytes_of_snapshot() {
  case $1 in
    btrfs) btrfs filesystem du -s --raw "$2" 2>/dev/null | awk 'NR == 2 { print $3 }' ;;
    zfs) zfs get -Hp -o value used "$2" 2>/dev/null ;;
  esac
}

user_exists_or_quit() { uid_of "$1" >/dev/null || quit "$EXIT_NOT_FOUND" "There is no user $1."; }

snapshot_exists() {
  case $(home_way "$1") in
    btrfs) [ -d "$(snapshot_path "$1" "$2")" ] ;;
    zfs) zfs list -H "$(zfs_home "$1")@$2" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

taken_json() {
  printf '{"id":%s,"user":%s,"state":"complete","tookMs":%s,"exclusiveBytes":%s}\n' "$(json_string "$2")" "$(json_string "$1")" "$3" "${4:-null}"
}

take() {
  user=${1:-} id=${2:-}
  valid_name "$user" && valid_name "$id" || quit "$EXIT_USAGE" "usage: take <user> <snapshot>"
  user_exists_or_quit "$user"
  way=$(home_way "$user")
  if snapshot_exists "$user" "$id"; then
    taken_json "$user" "$id" 0
    return 0
  fi
  started=$(now_ms)
  case $way in
    btrfs)
      mkdir -p "$STORE/$user" && chmod 700 "$STORE" "$STORE/$user"
      btrfs subvolume snapshot -r "$(home_of "$user")" "$(snapshot_path "$user" "$id").partial" >/dev/null || fail "btrfs could not snapshot $user's home."
      date +%s >"$STORE/$user/.$id.taken"
      mv "$(snapshot_path "$user" "$id").partial" "$(snapshot_path "$user" "$id")"
      ;;
    zfs) zfs snapshot "$(zfs_home "$user")@$id" || fail "ZFS could not snapshot $user's home." ;;
    *) quit "$EXIT_REFUSED" "$(why_not "$way")" ;;
  esac
  taken_json "$user" "$id" $(($(now_ms) - started))
}

list() {
  user=${1:-}
  valid_name "$user" || quit "$EXIT_USAGE" "usage: list <user>"
  printf '{"user":%s,"snapshots":[' "$(json_string "$user")"
  separator=''
  case $(home_way "$user") in
    btrfs)
      for path in "$STORE/$user"/*; do
        [ -d "$path" ] || continue
        id=${path##*/} state=complete
        case $id in *.partial) id=${id%.partial} state=incomplete ;; esac
        printf '%s{"id":%s,"state":"%s","takenAt":%s}' "$separator" "$(json_string "$id")" "$state" "$(cat "$STORE/$user/.$id.taken" 2>/dev/null || echo null)"
        separator=,
      done
      ;;
    zfs)
      zfs list -H -p -t snapshot -o name,creation,used "$(zfs_home "$user")" 2>/dev/null | while IFS='	' read -r name creation used; do
        printf '%s{"id":%s,"state":"complete","takenAt":%s,"exclusiveBytes":%s}' "$separator" "$(json_string "${name#*@}")" "$creation" "$used"
        separator=,
      done
      ;;
  esac
  printf ']}\n'
}

stop_user() {
  user=$1 uid=$(uid_of "$1")
  loginctl terminate-user "$user" >/dev/null 2>&1
  systemctl stop "user@$uid.service" >/dev/null 2>&1
  tries=0
  while pgrep -u "$uid" >/dev/null 2>&1; do
    pkill -KILL -u "$uid" >/dev/null 2>&1
    tries=$((tries + 1))
    [ "$tries" -le 50 ] || fail "Processes of $user did not end."
    sleep 0.2
  done
  systemctl reset-failed "user@$uid.service" "user-runtime-dir@$uid.service" >/dev/null 2>&1
}

start_user() { systemctl start "user@$(uid_of "$1").service" >/dev/null 2>&1; }

swap_btrfs_home() {
  user=$1 id=$2
  home=$(home_of "$user")
  replaced=$STORE/$user/.replaced
  if [ ! -e "$replaced" ] && [ -d "$home" ]; then mv "$home" "$replaced" || fail "Could not move $user's home aside."; fi
  if [ ! -d "$home" ]; then btrfs subvolume snapshot "$(snapshot_path "$user" "$id")" "$home" >/dev/null || fail "Could not put $id back as $user's home."; fi
  btrfs subvolume delete "$replaced" >/dev/null 2>&1 || fail "Could not delete the home it replaced."
}

swap_zfs_home() {
  user=$1 id=$2
  dataset=$(zfs_home "$user")
  [ -n "$dataset" ] || dataset=$ZFS_PARENT/$user
  home=$(home_of "$user")
  restoring=$ZFS_PARENT/.restoring-$user
  replaced=$ZFS_PARENT/.replaced-$user
  zfs list -H "$restoring" >/dev/null 2>&1 || zfs clone -o mountpoint=none "$dataset@$id" "$restoring" || fail "Could not clone $id."
  zfs promote "$restoring" || fail "Could not promote the clone of $id."
  zfs list -H "$replaced" >/dev/null 2>&1 || zfs rename "$dataset" "$replaced" || fail "Could not move $user's home aside."
  zfs set mountpoint=none "$replaced"
  zfs rename "$restoring" "$dataset" || fail "Could not put $id back as $user's home."
  zfs set mountpoint="$home" "$dataset" || fail "Could not mount $user's home."
}

restore() {
  user=${1:-} id=${2:-} undo=${3:-}
  valid_name "$user" && valid_name "$id" && valid_name "$undo" || quit "$EXIT_USAGE" "usage: restore <user> <snapshot> <undo>"
  user_exists_or_quit "$user"
  snapshot_exists "$user" "$id" || quit "$EXIT_NOT_FOUND" "$user has no snapshot $id."
  way=$(home_way "$user")
  started=$(now_ms)
  stop_user "$user"
  stopped=$(now_ms)
  (take "$user" "$undo") >/dev/null || fail "Could not take the undo, so nothing changed."
  case $way in
    btrfs) swap_btrfs_home "$user" "$id" ;;
    zfs) swap_zfs_home "$user" "$id" ;;
  esac
  swapped=$(now_ms)
  start_user "$user"
  printf '{"id":%s,"user":%s,"undo":%s,"stopMs":%s,"undoAndSwapMs":%s,"totalMs":%s}\n' "$(json_string "$id")" "$(json_string "$user")" "$(json_string "$undo")" $((stopped - started)) $((swapped - stopped)) $(($(now_ms) - started))
}

identity_left_in() {
  home=$1
  for each in "$home"/.bb-machines/*/host-id "$home"/.bb-machines/*/auth.json "$home"/.bb-machines/*/config.json "$home"/.config/bb-box/env "$home"/.config/systemd/user/bb-host-daemon-*.service "$home"/.ssh/id_* "$home"/.config/gh/hosts.yml "$home"/.local/share/tailscale; do
    [ -e "$each" ] && printf '%s\n' "${each#"$home"/}"
  done
}

reset_identity() {
  home=$1
  rm -rf "$home"/.bb-machines/*/host-id "$home"/.bb-machines/*/auth.json "$home"/.bb-machines/*/config.json "$home"/.bb-machines/*/daemon.lock "$home"/.bb-machines/*/host-daemon-port
  rm -f "$home"/.config/bb-box/env "$home"/.config/systemd/user/bb-host-daemon-*.service "$home"/.config/systemd/user/default.target.wants/bb-host-daemon-*.service
  rm -rf "$home"/.local/share/tailscale
}

fork() {
  source=${1:-} id=${2:-} user=${3:-} uid=${4:-}
  valid_name "$source" && valid_name "$id" && valid_name "$user" || quit "$EXIT_USAGE" "usage: fork <user> <snapshot> <new user> <uid>"
  snapshot_exists "$source" "$id" || quit "$EXIT_NOT_FOUND" "$source has no snapshot $id."
  way=$(home_way "$source")
  home=$(home_of "$user")
  started=$(now_ms)
  groupadd -g "$uid" "$user" || fail "groupadd $user"
  case $way in
    btrfs) btrfs subvolume snapshot "$(snapshot_path "$source" "$id")" "$home" >/dev/null || fail "Could not clone $id." ;;
    zfs) zfs send "$(zfs_home "$source")@$id" | zfs receive -o mountpoint="$home" "$ZFS_PARENT/$user" || fail "Could not copy $id." ;;
  esac
  cloned=$(now_ms)
  useradd -u "$uid" -g "$uid" -M -d "$home" -s /bin/bash -c "bb-box box" "$user" || fail "useradd $user"
  usermod -p '*' "$user"
  chown -R --from="$(uid_of "$source"):$(uid_of "$source")" "$uid:$uid" "$home"
  owned=$(now_ms)
  before=$(identity_left_in "$home" | tr '\n' ' ')
  reset_identity "$home"
  after=$(identity_left_in "$home" | tr '\n' ' ')
  printf '{"user":%s,"from":%s,"cloneMs":%s,"chownMs":%s,"identityBefore":%s,"identityAfter":%s}\n' "$(json_string "$user")" "$(json_string "$source@$id")" $((cloned - started)) $((owned - cloned)) "$(json_string "$before")" "$(json_string "$after")"
}

delete() {
  user=${1:-} id=${2:-}
  valid_name "$user" && valid_name "$id" || quit "$EXIT_USAGE" "usage: delete <user> <snapshot>"
  case $(home_way "$user") in
    btrfs)
      for path in "$(snapshot_path "$user" "$id")" "$(snapshot_path "$user" "$id").partial"; do
        [ ! -d "$path" ] || btrfs subvolume delete "$path" >/dev/null || fail "Could not delete $id."
      done
      rm -f "$STORE/$user/.$id.taken"
      ;;
    zfs)
      dataset=$(zfs_home "$user")
      ! zfs list -H "$dataset@$id" >/dev/null 2>&1 || zfs destroy "$dataset@$id" || fail "Could not delete $id."
      ;;
  esac
  printf '{"id":%s,"state":"gone"}\n' "$(json_string "$id")"
}

remove_user() {
  user=${1:-}
  valid_name "$user" || quit "$EXIT_USAGE" "usage: remove-user <user>"
  way=$(home_way "$user")
  home=$(home_of "$user")
  uid_of "$user" >/dev/null && stop_user "$user"
  loginctl disable-linger "$user" 2>/dev/null
  case $way in
    btrfs)
      for path in "$STORE/$user"/* "$STORE/$user"/.replaced; do [ ! -d "$path" ] || btrfs subvolume delete "$path" >/dev/null; done
      rm -rf "$STORE/$user"
      btrfs subvolume delete "$home" >/dev/null
      ;;
    zfs) zfs destroy -r "$(zfs_home "$user")" ;;
  esac
  userdel "$user" 2>/dev/null
  groupdel "$user" 2>/dev/null
  printf '{"user":%s,"removed":true,"left":%s}\n' "$(json_string "$user")" "$(json_string "$(ls -d "$home" "$STORE/$user" 2>/dev/null | tr '\n' ' ')")"
}

[ "$(id -u)" = 0 ] || quit "$EXIT_USAGE" "Run it as root."
verb=${1:-}
[ $# -eq 0 ] || shift
case $verb in
  probe) probe ;;
  make-user) make_user "$@" ;;
  take) take "$@" ;;
  list) list "$@" ;;
  restore) restore "$@" ;;
  fork) fork "$@" ;;
  delete) delete "$@" ;;
  remove-user) remove_user "$@" ;;
  *) quit "$EXIT_USAGE" "usage: home-linux.sh probe | make-user | take | list | restore | fork | delete | remove-user" ;;
esac
