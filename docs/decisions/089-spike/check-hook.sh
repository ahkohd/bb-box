#!/bin/sh
set -u
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
LC_ALL=C
export PATH LC_ALL

HERE=$(cd "$(dirname "$0")" && pwd)
RUNNER=$HERE/machine-snapshot.sh
DATA=${1:?usage: check-hook.sh <a folder the hook protects>}
STEPS_TO_INTERRUPT="unmounted moved-aside made"
FAILURES=0

pass() { printf 'PASS %s\n' "$*"; }
fail_check() {
  printf 'FAIL %s\n' "$*"
  FAILURES=$((FAILURES + 1))
}
new_id() { printf '%s%s\n' "$1" "$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"; }
now_ms() { date +%s%3N; }

until_done() {
  operation=$1
  shift
  while :; do
    out=$("$RUNNER" "$operation" "$@")
    code=$?
    [ "$code" = 10 ] || break
    sleep 0.2
  done
  printf '%s\n' "$out"
  return "$code"
}

expect() {
  what=$1 wanted=$2 got=$3
  if [ "$wanted" = "$got" ]; then pass "$what"; else fail_check "$what: wanted $wanted, got $got"; fi
}

check_describe() {
  out=$(until_done "$(new_id op)" describe)
  expect "describe exits 0" 0 $?
  printf '%s\n' "$out" | jq -e '.contract == 1 and (.scope == "machine") and (.holds | type == "array") and (.restore | type == "string")' >/dev/null
  expect "describe says its contract, scope, what it holds and how it restores" 0 $?
}

check_take_is_idempotent() {
  id=$(new_id sn)
  echo first >"$DATA/marker"
  started=$(now_ms)
  out=$(until_done "$(new_id op)" take "$id")
  expect "take exits 0" 0 $?
  printf 'INFO take took %s ms, paused %s ms\n' $(($(now_ms) - started)) "$(printf '%s' "$out" | jq -r .pausedMs)"
  again=$(until_done "$(new_id op)" take "$id")
  expect "a second take of the same snapshot exits 0" 0 $?
  expect "and names the same snapshot" "$(printf '%s' "$out" | jq -r .ref)" "$(printf '%s' "$again" | jq -r .ref)"
  until_done "$(new_id op)" list | jq -e --arg id "$id" '.snapshots | map(.id) | index($id) != null' >/dev/null
  expect "list has it" 0 $?
  TAKEN=$id
}

check_restore() {
  echo second >"$DATA/marker"
  operation=$(new_id op)
  started=$(now_ms)
  until_done "$operation" restore "$TAKEN" "$operation" >/dev/null
  expect "restore exits 0" 0 $?
  printf 'INFO restore took %s ms\n' $(($(now_ms) - started))
  expect "the data is as it was at the take" first "$(cat "$DATA/marker")"
  until_done "$operation" restore "$TAKEN" "$operation" >/dev/null
  expect "asking again for the same restore exits 0" 0 $?
  echo third >"$DATA/marker"
  until_done "$operation" restore "$TAKEN" "$operation" >/dev/null
  expect "and changes nothing more" third "$(cat "$DATA/marker")"
}

check_restore_cut_short_after() {
  step=$1
  echo "before-$step" >"$DATA/marker"
  operation=$(new_id op)
  BBBOX_HOOK_STOP_AFTER=$step "$RUNNER" "$operation" restore "$TAKEN" "$operation" >/dev/null
  while [ ! -f "$BBBOX_STATE/snapshot-operations/$operation/status" ] && [ -n "$(cat "$BBBOX_STATE/snapshot-operations/$operation/pid" 2>/dev/null)" ] && kill -0 "$(cat "$BBBOX_STATE/snapshot-operations/$operation/pid")" 2>/dev/null; do sleep 0.1; done
  until_done "$operation" restore "$TAKEN" "$operation" >/dev/null
  expect "a restore killed after the step '$step' finishes when asked again" 0 $?
  expect "and the data is as it was at the take" first "$(cat "$DATA/marker")"
  expect "and it launched the hook twice" 2 "$(cat "$BBBOX_STATE/snapshot-operations/$operation/launches")"
}

check_machine_restart_mid_operation() {
  operation=$(new_id op)
  boot=$BBBOX_STATE/fake-boot-id
  echo boot-one >"$boot"
  BBBOX_BOOT_ID_FILE=$boot BBBOX_HOOK_STOP_AFTER=moved-aside "$RUNNER" "$operation" restore "$TAKEN" "$operation" >/dev/null
  sleep 1
  echo boot-two >"$boot"
  out=$(BBBOX_BOOT_ID_FILE=$boot until_done "$operation" restore "$TAKEN" "$operation")
  expect "after the machine restarts mid-restore, asking again finishes it" 0 $?
  expect "and the data is as it was at the take" first "$(cat "$DATA/marker")"
}

check_delete_is_idempotent() {
  until_done "$(new_id op)" delete "$TAKEN" >/dev/null
  expect "delete exits 0" 0 $?
  until_done "$(new_id op)" delete "$TAKEN" >/dev/null
  expect "deleting it again exits 0" 0 $?
  until_done "$(new_id op)" list | jq -e --arg id "$TAKEN" '.snapshots | map(.id) | index($id) == null' >/dev/null
  expect "list no longer has it" 0 $?
}

check_unknown_snapshot() {
  operation=$(new_id op)
  until_done "$operation" restore sn0nothere "$operation" >/dev/null 2>&1
  expect "restoring a snapshot that is not there exits 4" 4 $?
}

export BBBOX_STATE=${BBBOX_STATE:-/var/lib/bb-box}
check_describe
check_take_is_idempotent
check_restore
for step in $STEPS_TO_INTERRUPT; do check_restore_cut_short_after "$step"; done
check_machine_restart_mid_operation
check_unknown_snapshot
check_delete_is_idempotent
printf '%s failures\n' "$FAILURES"
[ "$FAILURES" = 0 ]
