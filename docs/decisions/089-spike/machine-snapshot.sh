#!/bin/sh
set -u
umask 022
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
LC_ALL=C
export PATH LC_ALL

STATE=${BBBOX_STATE:-/var/lib/bb-box}
HOOK=${BBBOX_SNAPSHOT_HOOK:-/usr/local/libexec/bb-box/snapshot-machine}
OPERATIONS=$STATE/snapshot-operations
MOST_LAUNCHES=3
EXIT_USAGE=2
EXIT_STILL_RUNNING=10

quit() {
  code=$1
  shift
  [ $# -eq 0 ] || printf '%s\n' "$*" >&2
  exit "$code"
}
boot_id() { cat "${BBBOX_BOOT_ID_FILE:-/proc/sys/kernel/random/boot_id}"; }
valid_operation() { case $1 in op[a-z0-9]*) case $1 in *[!a-z0-9]*) return 1 ;; esac ;; *) return 1 ;; esac; }
put() { cat >"$1.new.$$" && mv -f "$1.new.$$" "$1"; }

launch() {
  dir=$1
  shift
  boot_id | put "$dir/boot"
  launches=$(($(cat "$dir/launches" 2>/dev/null || echo 0) + 1))
  echo "$launches" | put "$dir/launches"
  BB_BOX_RESTARTING=$dir/restarting setsid sh -c '"$@" >"$0/out" 2>"$0/log"; echo $? >"$0/status.new" && mv -f "$0/status.new" "$0/status"' "$dir" "$HOOK" "$@" \
    </dev/null >/dev/null 2>&1 &
  echo $! | put "$dir/pid"
}

hook_still_runs() {
  pid=$(cat "$1/pid" 2>/dev/null)
  [ -n "$pid" ] && [ "$(cat "$1/boot")" = "$(boot_id)" ] && kill -0 "$pid" 2>/dev/null
}

report_finished() {
  dir=$1
  code=$(cat "$dir/status")
  cat "$dir/out"
  [ "$code" = 0 ] || sed 's/^/hook: /' "$dir/log" | tail -n 3 >&2
  exit "$code"
}

relaunch_or_fail() {
  dir=$1
  shift
  launches=$(cat "$dir/launches" 2>/dev/null || echo 0)
  if [ "$launches" -ge "$MOST_LAUNCHES" ]; then
    echo 1 | put "$dir/status"
    printf 'The hook stopped before it finished, %s times. Its last words: %s\n' "$launches" "$(tail -n 1 "$dir/log" 2>/dev/null)" | put "$dir/log"
    : >"$dir/out"
    report_finished "$dir"
  fi
  launch "$dir" "$@"
  printf '{"operation":"%s","state":"running","launch":%s}\n' "${dir##*/}" "$((launches + 1))"
  exit "$EXIT_STILL_RUNNING"
}

run() {
  operation=$1
  shift
  valid_operation "$operation" || quit "$EXIT_USAGE" "usage: machine-snapshot <operation> describe | take <id> | list | restore <id> <operation> | delete <id>"
  [ -x "$HOOK" ] || quit 5 "This machine has no snapshot hook, $HOOK, so it takes no snapshots of itself."
  dir=$OPERATIONS/$operation
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir" && printf '%s\n' "$*" | put "$dir/args"
    launch "$dir" "$@"
    printf '{"operation":"%s","state":"running","launch":1}\n' "$operation"
    exit "$EXIT_STILL_RUNNING"
  fi
  [ "$(cat "$dir/args")" = "$*" ] || quit "$EXIT_USAGE" "Operation $operation was started with other arguments: $(cat "$dir/args")."
  [ ! -f "$dir/status" ] || report_finished "$dir"
  if hook_still_runs "$dir"; then
    printf '{"operation":"%s","state":"running"}\n' "$operation"
    exit "$EXIT_STILL_RUNNING"
  fi
  relaunch_or_fail "$dir" "$@"
}

forget() {
  operation=${1:-}
  valid_operation "$operation" || quit "$EXIT_USAGE" "usage: machine-snapshot forget <operation>"
  rm -rf "${OPERATIONS:?}/$operation"
}

[ "$(id -u)" = 0 ] || quit "$EXIT_USAGE" "Run it as root."
case ${1:-} in
  forget) shift && forget "$@" ;;
  *) run "$@" ;;
esac
