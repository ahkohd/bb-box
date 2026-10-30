#!/bin/bash
set -euo pipefail
usage() {
  cat >&2 <<'TEXT'
The root steps of 070 unit 1a's live check, on the Proxmox node. Each acts
only on the VMIDs in BBBOX_VMIDS, and on snapshots BBBOX_INSTALL labelled.

  BBBOX_VMIDS="3240 3241" live-root.sh kill-take <vmid> [seconds]
      waits for a snapshot task on <vmid>, SIGKILLs that task's worker
      only, and exits: a take killed part way (gate G1)
  BBBOX_VMIDS="3240 3241" live-root.sh unlock <vmid>
      thaws and unlocks <vmid>, as bb-box then asks
  BBBOX_VMIDS="3240 3241" BBBOX_INSTALL=<id> live-root.sh keep-label <vmid> <snapshot> <yyyy-mm-dd>
      adds a keep date to the label of one of that install's snapshots (gate G3)
TEXT
  exit 2
}
[ $# -ge 2 ] && [ -n "${BBBOX_VMIDS:-}" ] || usage
command=$1
vmid=$2
[[ " $BBBOX_VMIDS " == *" $vmid "* ]] || { echo "VMID $vmid is not in BBBOX_VMIDS: $BBBOX_VMIDS" >&2; exit 2; }
node=$(hostname)
type=lxc
[ -e "/etc/pve/nodes/$node/qemu-server/$vmid.conf" ] && type=qemu
case $command in
  kill-take)
    task=vzsnapshot
    [ $type = qemu ] && task=qmsnapshot
    pattern="^UPID:[^:]+:([0-9A-F]{8}):[0-9A-F]+:[0-9A-F]+:${task}:${vmid}:"
    deadline=$((SECONDS + ${3:-900}))
    while [ $SECONDS -lt $deadline ]; do
      while read -r upid _; do
        [[ $upid =~ $pattern ]] || continue
        pid=$((16#${BASH_REMATCH[1]}))
        title=$({ tr '\0' ' ' < "/proc/$pid/cmdline"; } 2>/dev/null || true)
        [[ $title == "task $upid"* ]] || continue
        kill -9 "$pid"
        echo "killed worker $pid of $upid"
        exit 0
      done < /var/log/pve/tasks/active
      sleep 0.01
    done
    echo "no $task task on $vmid in time" >&2
    exit 1
    ;;
  unlock)
    if [ $type = lxc ]; then
      lxc-unfreeze -n "$vmid" 2>/dev/null || true
      pct unlock "$vmid"
    else
      qm unlock "$vmid"
    fi
    echo "unlocked $vmid"
    ;;
  keep-label)
    [ $# -eq 4 ] && [ -n "${BBBOX_INSTALL:-}" ] || usage
    name=$3
    date=$4
    [[ $date =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || usage
    path=/nodes/$node/$type/$vmid/snapshot/$name/config
    label=$(pvesh get "$path" --output-format json | jq -r '.description // ""')
    ours="^bb-box install ${BBBOX_INSTALL} box [^ ]+ snapshot sn[a-z2-7]{12}$"
    [[ $label =~ $ours ]] || { echo "not a label of install $BBBOX_INSTALL: $label" >&2; exit 2; }
    pvesh set "$path" --description "$label kept $date"
    echo "labelled $vmid $name: $label kept $date"
    ;;
  *)
    usage
    ;;
esac
