#!/bin/bash
set -uo pipefail
[ $# -ge 2 ] || { echo "usage: $0 take|restore|clean <box-id>   (as the Tart host user bb-box signs in as, with the box stopped by bb-box)" >&2; exit 2; }
MODE=$1 BOX=$2
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" TART_NO_AUTO_PRUNE=1
OWNERS=$HOME/.bb-box/tart/owners
VM=$(grep -lxF "box=$BOX" "$OWNERS"/* 2>/dev/null | head -n 1 | xargs -n 1 basename 2>/dev/null)
[ -n "$VM" ] || { echo "No owner file names box $BOX; stopping." >&2; exit 1; }
VMS=$(cd "${TART_HOME:-$HOME/.tart}/vms" && pwd -P)
KEEP=$(dirname "$VMS")/snapshot-research
FORK=bbsnap-research-fork
running_vms() { pgrep -x tart | wc -l | tr -d ' '; }

now() { perl -MTime::HiRes=time -e 'printf "%.3f\n", time'; }
since() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.2f s", b - a }'; }
free_gb() { df -g "$VMS" | awk 'NR==2 {print $4}'; }
files() { ls -l "$1" | awk 'NR>1 {printf "  %-16s %8.2f GB\n", $9, $5/1e9}'; du -sh "$1" | awk '{print "  on disk (du):", $1}'; }

echo "VM $VM in $VMS; copies in $KEEP; tart processes running: $(running_vms)"
[ "$(df "$VMS" | awk 'NR==2 {print $1}')" = "$(mkdir -p "$KEEP" && df "$KEEP" | awk 'NR==2 {print $1}')" ] || { echo "$KEEP is not on the VMs' volume; stopping." >&2; exit 1; }
[ "$MODE" = clean ] || [ -f "$VMS/$VM/state.vzvmsave" ] || { echo "$VM has no saved state: stop the box with bb-box first; stopping." >&2; exit 1; }

case "$MODE" in
take)
  echo "VM folder of $VM:"; files "$VMS/$VM"
  echo "free before: $(free_gb) GB"
  rm -rf "${KEEP:?}/$VM"
  t=$(now); cp -c -R "$VMS/$VM" "$KEEP/$VM"; echo "TIME APFS clonefile copy of the suspended VM: $(since "$t")"
  echo "free after the copy: $(free_gb) GB"
  t=$(now); tart clone "$VM" "$FORK"; echo "TIME tart clone of the suspended VM: $(since "$t")"
  echo "fork folder:"; files "$VMS/$FORK"
  echo "MAC: box $(sed -n 's/.*"macAddress" *: *"\([^"]*\)".*/\1/p' "$VMS/$VM/config.json"), fork $(sed -n 's/.*"macAddress" *: *"\([^"]*\)".*/\1/p' "$VMS/$FORK/config.json")"
  RUNNING=$(running_vms)
  if [ "$RUNNING" -lt 2 ]; then
    t=$(now); nohup tart run --no-graphics --suspendable "$FORK" > "$KEEP/fork-run.log" 2>&1 &
    for _ in $(seq 1 600); do ip=$(tart ip "$FORK" 2>/dev/null) && [ -n "$ip" ] && break; sleep 0.2; done
    echo "TIME the fork running with an address: $(since "$t") (ip ${ip:-none}; fork has saved state: $([ -f "$VMS/$FORK/state.vzvmsave" ] && echo yes || echo no))"
    tail -n 3 "$KEEP/fork-run.log"
    tart stop "$FORK" --timeout 10 >/dev/null 2>&1
  else
    echo "NOTE: $RUNNING VMs run on this Mac; the fork was not started."
  fi
  t=$(now); tart delete "$FORK"; echo "TIME tart delete of the fork: $(since "$t")"
  ;;
restore)
  [ -d "$KEEP/$VM" ] || { echo "No copy of $VM; run take first." >&2; exit 1; }
  t=$(now)
  mv "$VMS/$VM" "$KEEP/$VM.replaced" && mv "$KEEP/$VM" "$VMS/$VM" && rm -rf "$KEEP/$VM.replaced"
  echo "TIME restore: the copy put back in the VM's place: $(since "$t")"
  rm -f "$KEEP/fork-run.log"; rmdir "$KEEP" 2>/dev/null
  ;;
clean)
  tart delete "$FORK" >/dev/null 2>&1; rm -rf "${KEEP:?}"
  ;;
esac
echo "left: $(ls "$KEEP" 2>/dev/null | wc -l | tr -d ' ') entries in $KEEP; fork folder $([ -d "$VMS/$FORK" ] && echo present || echo gone)"
