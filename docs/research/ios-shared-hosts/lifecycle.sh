#!/bin/sh
set -u

tag=${1:?tag}
shift
here=$(cd "$(dirname "$0")" && pwd)
work=${SHARED_WORK:-$HOME/shared}
out=$work/runs/$tag
mkdir -p "$out"
events=$out/events.tsv
: >"$events"
ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
udid_of() { xcrun simctl list devices -j | python3 -c 'import json,sys; n=sys.argv[1]; print(next(d["udid"] for r in json.load(sys.stdin)["devices"].values() for d in r if d["name"]==n))' "$1"; }
event() {
  name=$1; shift
  start=$(ms)
  "$@" >>"$out/events.log" 2>&1
  end=$(ms)
  printf '%s\t%s\t%s\n' "$name" "$start" "$end" | tee -a "$events"
}
boot_wait() { xcrun simctl boot "$1"; xcrun simctl bootstatus "$1" -b >/dev/null; }
release_erase() { xcrun simctl shutdown "$1"; xcrun simctl erase "$1"; }
kill_companion() { kill "$(cat "$work/sock/$1.pid")"; }
restart_companion() {
  sock="$work/sock/$1.sock"; rm -f "$sock"
  nohup /usr/local/bin/idb_companion --udid "$1" --grpc-domain-sock "$sock" >>"$work/log/companion-$1.log" 2>&1 &
  echo $! >"$work/sock/$1.pid"
  for _ in $(seq 1 300); do [ -S "$sock" ] && break; sleep 0.1; done
}

"$here/devices.sh" up "${COUNT:-4}" 2>>"$out/up.log"
sleep 15
node "$here/multi.ts" --targets "$work/targets.json" --seconds "${SECONDS_EACH:-110}" --gap 1000 --sample --label "$tag" --out "$out/run.json" --raw "$out/raw" >"$out/run.txt" 2>&1 &
runner=$!
sleep 25
extra=$(udid_of shared-5)
event "boot a fifth device" boot_wait "$extra"
sleep 8
event "release the fifth: shut down and erase" release_erase "$extra"
sleep 8
event "boot the erased fifth again" boot_wait "$extra"
sleep 8
event "shut the fifth down" xcrun simctl shutdown "$extra"
sleep 8
second=$(udid_of shared-2)
event "kill shared-2's companion" kill_companion "$second"
sleep 3
event "restart shared-2's companion" restart_companion "$second"
sleep 8
ipad=$(udid_of "iPad Pro 13-inch (M5)")
fourth=$(udid_of shared-4)
event "switch shared-4's box to the iPad: shut shared-4 down" xcrun simctl shutdown "$fourth"
event "switch: boot the iPad" boot_wait "$ipad"
wait "$runner"
cat "$out/run.txt"
xcrun simctl shutdown "$ipad"
python3 "$here/events.py" "$out"
