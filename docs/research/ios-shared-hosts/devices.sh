#!/bin/sh
set -u

work=${SHARED_WORK:-$HOME/shared}
list=${SLIM_LIST:-/usr/local/share/bb-box/ios/ios-27.0-24A434.txt}
template_name=${TEMPLATE:-iPhone 18 Pro}
url=${PAGE_URL:-http://127.0.0.1:8765/page.html?busy}
mkdir -p "$work/sock" "$work/log"

step() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
now() { python3 -c 'import time; print(f"{time.time():.3f}")'; }
since() { python3 -c "import sys, time; print(f'{time.time() - float(sys.argv[1]):.1f}')" "$1"; }
udid_of() { xcrun simctl list devices -j | python3 -c 'import json,sys; n=sys.argv[1]; print(next(d["udid"] for r in json.load(sys.stdin)["devices"].values() for d in r if d["name"]==n))' "$1"; }
booted() { xcrun simctl list devices | grep -F "($1)" | grep -q '(Booted)'; }

slim() {
  udid=$1
  while read -r label; do
    [ -n "$label" ] || continue
    tries=0
    until xcrun simctl spawn "$udid" launchctl disable "system/$label" 2>/dev/null; do
      tries=$((tries + 1)); [ "$tries" -lt 5 ] || break; sleep 1
    done
  done <"$list"
}

disabled_count() {
  xcrun simctl spawn "$1" launchctl print-disabled system | python3 -c '
import re, sys
listed = {l.strip() for l in open(sys.argv[1]) if l.strip()}
off = {m.group(1) for m in re.finditer(r"\"([^\"]+)\" => (?:disabled|true)", sys.stdin.read())}
print(len(listed & off))' "$list"
}

make_one() {
  index=$1 template=$2
  started=$(now)
  udid=$(xcrun simctl clone "$template" "shared-$index")
  xcrun simctl boot "$udid"; xcrun simctl bootstatus "$udid" -b >/dev/null
  slim "$udid"; xcrun simctl reboot "$udid"; xcrun simctl bootstatus "$udid" -b >/dev/null
  slim "$udid"; xcrun simctl reboot "$udid"; xcrun simctl bootstatus "$udid" -b >/dev/null
  count=$(disabled_count "$udid")
  xcrun simctl shutdown "$udid"
  echo "made shared-$index $udid disabled=$count seconds=$(since "$started")"
}

start_companion() {
  udid=$1
  sock="$work/sock/$udid.sock"
  rm -f "$sock"
  nohup /usr/local/bin/idb_companion --udid "$udid" --grpc-domain-sock "$sock" >"$work/log/companion-$udid.log" 2>&1 &
  echo $! >"$work/sock/$udid.pid"
  for _ in $(seq 1 300); do [ -S "$sock" ] && break; sleep 0.1; done
}

case ${1:-} in
  make)
    count=${2:?count}
    parallel=${3:-4}
    template=$(udid_of "$template_name")
    xcrun simctl shutdown "$template" 2>/dev/null
    index=${FIRST:-1}
    count=$((index + count - 1))
    while [ "$index" -le "$count" ]; do
      batch=0
      while [ "$batch" -lt "$parallel" ] && [ "$index" -le "$count" ]; do
        make_one "$index" "$template" &
        index=$((index + 1)); batch=$((batch + 1))
      done
      wait
    done
    ;;
  up)
    count=${2:?count}
    printf '[' >"$work/targets.json"
    first=1
    for index in $(seq 1 "$count"); do
      udid=$(udid_of "shared-$index")
      started=$(now)
      fresh=0
      booted "$udid" || { xcrun simctl boot "$udid"; fresh=1; }
      xcrun simctl bootstatus "$udid" -b >/dev/null
      boot=$(since "$started")
      if [ "$fresh" = 1 ] || ! [ -S "$work/sock/$udid.sock" ]; then
        kill "$(cat "$work/sock/$udid.pid" 2>/dev/null)" 2>/dev/null
        start_companion "$udid"
      fi
      [ "$fresh" = 1 ] && xcrun simctl openurl "$udid" "$url"
      step "shared-$index $udid booted in $boot s, companion up"
      [ "$first" = 1 ] || printf ',' >>"$work/targets.json"
      first=0
      printf '{"name":"shared-%s","udid":"%s","socket":"%s"}' "$index" "$udid" "$work/sock/$udid.sock" >>"$work/targets.json"
    done
    printf ']\n' >>"$work/targets.json"
    ;;
  down)
    for pidfile in "$work"/sock/*.pid; do [ -f "$pidfile" ] && kill "$(cat "$pidfile")" 2>/dev/null; rm -f "$pidfile"; done
    xcrun simctl shutdown all 2>/dev/null
    ;;
  delete)
    xcrun simctl list devices | sed -n 's/^ *shared-[0-9]* (\([-0-9A-F]*\)).*/\1/p' | while read -r udid; do xcrun simctl delete "$udid"; done
    ;;
  *) echo "usage: devices.sh make <n> [parallel] | up <n> | down | delete" >&2; exit 2 ;;
esac
