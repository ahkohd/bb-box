#!/bin/sh
set -u
umask 022
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
LC_ALL=C
export PATH LC_ALL

CONTRACT=1
VG=${BBBOX_HOOK_VG:-bbvg}
POOL=${BBBOX_HOOK_POOL:-thinpool}
ORIGIN=${BBBOX_HOOK_ORIGIN:-machine}
MOUNT=${BBBOX_HOOK_MOUNT:-/srv/machine}
TAKEN_AS=$MOUNT/.bb-box-taken-as
RESTORED_BY=$MOUNT/.bb-box-restored-by
SNAPSHOT_PREFIX=bbsn-
REPLACED=$ORIGIN-replaced
TAG=bb-box
MOST_PERCENT_FULL=85
STOP_AFTER_STEP_FOR_TESTS=${BBBOX_HOOK_STOP_AFTER:-}

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
valid_id() { case $1 in sn[a-z0-9]* | op[a-z0-9]*) case $1 in *[!a-z0-9]*) return 1 ;; esac ;; *) return 1 ;; esac; }
lv_of() { echo "$SNAPSHOT_PREFIX$1"; }
lv_exists() { lvs "$VG/$1" >/dev/null 2>&1; }
pool_percent_full() { lvs --noheadings -o data_percent "$VG/$POOL" | tr -d ' ' | cut -d . -f 1; }
lv_bytes() { lvs --noheadings --units b --nosuffix -o lv_size "$VG/$1" | tr -d ' '; }
lv_created() { date -d "$(lvs --noheadings -o lv_time "$VG/$1" | sed 's/^ *//')" +%s; }

stop_here_for_tests() {
  [ "$STOP_AFTER_STEP_FOR_TESTS" = "$1" ] || return 0
  printf 'stopped after %s, as asked\n' "$1" >&2
  kill -KILL 0
}

describe() {
  printf '{"contract":%s,"scope":"machine","holds":["disk"],"whileRunning":"pauses","restore":"in-place","restarts":false,"lives":"host","keepsPastRelease":"no","price":null,"excludes":"memory, and what is not on %s","storage":{"name":"%s/%s","type":"lvmthin","percentFull":%s}}\n' \
    "$CONTRACT" "$MOUNT" "$VG" "$POOL" "$(pool_percent_full)"
}

freeze_and_snapshot() {
  id=$1
  mountpoint -q "$MOUNT" || fail "$MOUNT is not mounted, so the hook will not freeze it: a freeze of a plain folder freezes the filesystem it is on."
  printf '%s\n' "$id" >"$TAKEN_AS" && sync -f "$MOUNT"
  fsfreeze -f "$MOUNT" || return 1
  frozen_at=$(date +%s%3N)
  lvcreate -q -s -n "$(lv_of "$id")" --addtag "$TAG" --addtag "bb-box-snapshot-$id" "$VG/$ORIGIN" >/dev/null
  made=$?
  fsfreeze -u "$MOUNT"
  paused_ms=$(($(date +%s%3N) - frozen_at))
  rm -f "$TAKEN_AS"
  return $made
}

take() {
  id=${1:-}
  valid_id "$id" || quit "$EXIT_USAGE" "usage: take <snapshot id>"
  lv=$(lv_of "$id")
  paused_ms=null
  if ! lv_exists "$lv"; then
    [ "$(pool_percent_full)" -lt "$MOST_PERCENT_FULL" ] || quit "$EXIT_REFUSED" "The thin pool $VG/$POOL is $(pool_percent_full)% full. Delete snapshots to make room."
    freeze_and_snapshot "$id" || fail "lvcreate could not snapshot $VG/$ORIGIN."
  fi
  printf '{"id":"%s","ref":"%s/%s","state":"complete","capturedAt":%s,"pausedMs":%s,"bytes":null}\n' "$id" "$VG" "$lv" "$(lv_created "$lv")" "$paused_ms"
}

list() {
  printf '{"snapshots":['
  separator=''
  for lv in $(lvs --noheadings -o lv_name -S "lv_tags=$TAG" "$VG" 2>/dev/null); do
    case $lv in "$SNAPSHOT_PREFIX"*) ;; *) continue ;; esac
    printf '%s{"id":"%s","ref":"%s/%s","state":"complete","takenAt":%s,"bytes":null}' "$separator" "${lv#"$SNAPSHOT_PREFIX"}" "$VG" "$lv" "$(lv_created "$lv")"
    separator=,
  done
  printf ']}\n'
}

machine_came_from() { cat "$TAKEN_AS" 2>/dev/null; }
restored_by() { cat "$RESTORED_BY" 2>/dev/null; }

restored_json() { printf '{"id":"%s","operation":"%s","state":"restored"}\n' "$1" "$2"; }

swap_in() {
  id=$1
  if mountpoint -q "$MOUNT"; then umount "$MOUNT" || fail "Something still uses $MOUNT, so it was not restored."; fi
  stop_here_for_tests unmounted
  if ! lv_exists "$REPLACED"; then lvrename -q "$VG" "$ORIGIN" "$REPLACED" >/dev/null || fail "Could not move $ORIGIN aside."; fi
  stop_here_for_tests moved-aside
  if ! lv_exists "$ORIGIN"; then lvcreate -q -s -n "$ORIGIN" "$VG/$(lv_of "$id")" >/dev/null || fail "Could not make $ORIGIN from $id."; fi
  lvchange -q -ay -K "$VG/$ORIGIN" >/dev/null || fail "Could not activate $ORIGIN."
  lvchange -q --setactivationskip n "$VG/$ORIGIN" >/dev/null
  stop_here_for_tests made
  mountpoint -q "$MOUNT" || mount "/dev/$VG/$ORIGIN" "$MOUNT" || fail "Could not mount $ORIGIN."
}

finish_restore() {
  id=$1 operation=$2
  [ "$(machine_came_from)" = "$id" ] || fail "The machine's disk does not name $id after the restore."
  printf '%s\n' "$operation" >"$RESTORED_BY" && rm -f "$TAKEN_AS" && sync -f "$MOUNT"
  ! lv_exists "$REPLACED" || lvremove -q -y "$VG/$REPLACED" >/dev/null || fail "Could not delete the volume it replaced."
}

restore() {
  id=${1:-} operation=${2:-}
  valid_id "$id" && valid_id "$operation" || quit "$EXIT_USAGE" "usage: restore <snapshot id> <operation id>"
  if mountpoint -q "$MOUNT" && [ "$(restored_by)" = "$operation" ]; then
    restored_json "$id" "$operation"
    return 0
  fi
  lv_exists "$(lv_of "$id")" || quit "$EXIT_NOT_FOUND" "There is no snapshot $id."
  swap_in "$id"
  finish_restore "$id" "$operation"
  restored_json "$id" "$operation"
}

delete() {
  id=${1:-}
  valid_id "$id" || quit "$EXIT_USAGE" "usage: delete <snapshot id>"
  lv=$(lv_of "$id")
  ! lv_exists "$lv" || lvremove -q -y "$VG/$lv" >/dev/null || fail "Could not delete $id."
  printf '{"id":"%s","state":"gone"}\n' "$id"
}

[ "$(id -u)" = 0 ] || quit "$EXIT_USAGE" "Run it as root."
verb=${1:-}
[ $# -eq 0 ] || shift
case $verb in
  describe) describe ;;
  take) take "$@" ;;
  list) list ;;
  restore) restore "$@" ;;
  delete) delete "$@" ;;
  *) quit "$EXIT_USAGE" "usage: snapshot-machine describe | take <id> | list | restore <id> <operation> | delete <id>" ;;
esac
