#!/bin/bash
set -euo pipefail
usage() {
  cat >&2 <<'TEXT'
The root steps of 070 unit 3's live check, on the Proxmox node. Each acts
only on the VMIDs in BBBOX_VMIDS whose guests carry the tag
install.<BBBOX_INSTALL> (bb-box's boxes, held copies and earlier guests all
do), and on snapshots that install labelled.

  live: BBBOX_VMIDS="3240 3241" BBBOX_INSTALL=<id> proxmox-root.sh <command> <vmid> [snapshot]

  lock <vmid>
      leaves <vmid> locked (rollback), as a rollback task that died does (gate G7)
  unlock <vmid>
      unlocks <vmid>, as bb-box then asks
  rollback <vmid> <snapshot>
      rolls <vmid> back to one of the install's snapshots, outside bb-box (gate G13);
      a running container shuts down first, which takes a while
  outside-take <vmid>
      takes a snapshot named byhand by hand, outside bb-box (gate G13)
  outside-delete <vmid> <snapshot>
      deletes one of the install's snapshots by hand, outside bb-box (gate G13)
  failing-rollback <vmid> <snapshot>
      locks <vmid> (backup), asks Proxmox for a rollback, whose task then fails
      on the lock, and unlocks it again (gate G13)
  held-rollback <vmid> <snapshot>
      holds <vmid>'s config lock file for 20 s while it asks for a rollback, so
      the rollback task runs, waiting on the lock, until Proxmox gives up on it
      after about 10 s: a rollback still running at a sweep (gate G13)
  config <vmid>
      prints <vmid>'s onboot, template, lock, tags and network lines (gate G16)
  destroy-kept <vmid>
      destroys a held copy or an earlier guest that bb-box no longer records,
      for the clean-up; it refuses a guest without either tag
  tasks <vmid>
      prints <vmid>'s last 20 tasks: type, start, end, status and user
  start-by-hand <vmid>
      starts a stopped container, waits 30 s, prints its identity reset's
      status and journal, and stops it again (gate G16)
TEXT
  exit 2
}
[ $# -ge 2 ] && [ -n "${BBBOX_VMIDS:-}" ] && [ -n "${BBBOX_INSTALL:-}" ] || usage
command=$1
vmid=$2
[[ " $BBBOX_VMIDS " == *" $vmid "* ]] || { echo "VMID $vmid is not in BBBOX_VMIDS: $BBBOX_VMIDS" >&2; exit 2; }
node=$(hostname)
type=lxc
tool=pct
[ -e "/etc/pve/nodes/$node/qemu-server/$vmid.conf" ] && { type=qemu; tool=qm; }
tags=$($tool config "$vmid" | sed -n 's/^tags: //p')
[[ ";$tags;" == *";install.$BBBOX_INSTALL;"* ]] || { echo "guest $vmid does not carry the tag install.$BBBOX_INSTALL: $tags" >&2; exit 2; }

ours() {
  local name=$1
  [[ $name =~ ^bbsn[a-z2-7]{12}$ ]] || { echo "not one of bb-box's snapshot names: $name" >&2; exit 2; }
  local label
  label=$(pvesh get "/nodes/$node/$type/$vmid/snapshot/$name/config" --output-format json | jq -r '.description // ""')
  [[ $label =~ ^bb-box\ install\ ${BBBOX_INSTALL}\ box\ [^\ ]+\ snapshot\ sn[a-z2-7]{12}($|\ kept) ]] || { echo "not a snapshot of install $BBBOX_INSTALL: $label" >&2; exit 2; }
}

case $command in
  lock)
    $tool set "$vmid" --lock rollback
    echo "locked $vmid (rollback)"
    ;;
  unlock)
    $tool unlock "$vmid"
    echo "unlocked $vmid"
    ;;
  rollback)
    [ $# -eq 3 ] || usage
    ours "$3"
    echo "rollback of $vmid to $3 began at $(date -u +%T)"
    $tool rollback "$vmid" "$3"
    echo "rollback of $vmid to $3 ended at $(date -u +%T)"
    ;;
  outside-take)
    $tool snapshot "$vmid" byhand --description "taken by hand"
    echo "took byhand on $vmid"
    ;;
  outside-delete)
    [ $# -eq 3 ] || usage
    ours "$3"
    $tool delsnapshot "$vmid" "$3"
    echo "deleted $3 on $vmid"
    ;;
  failing-rollback)
    [ $# -eq 3 ] || usage
    ours "$3"
    $tool set "$vmid" --lock backup
    pvesh create "/nodes/$node/$type/$vmid/snapshot/$3/rollback" || true
    sleep 2
    $tool unlock "$vmid"
    echo "asked for a rollback of $vmid while it was locked (backup), then unlocked it"
    ;;
  held-rollback)
    [ $# -eq 3 ] || usage
    ours "$3"
    lockfile=/run/lock/lxc/pve-config-$vmid.lock
    [ $type = qemu ] && lockfile=/var/lock/qemu-server/lock-$vmid.conf
    flock "$lockfile" sleep 20 &
    sleep 1
    echo "rollback of $vmid to $3 asked at $(date -u +%T), its config lock held"
    $tool rollback "$vmid" "$3" || true
    echo "rollback of $vmid ended at $(date -u +%T)"
    wait
    ;;
  config)
    $tool config "$vmid" | grep -E '^(onboot|template|lock|tags|net[0-9]+|smbios1|parent|description):' || true
    ;;
  destroy-kept)
    [[ ";$tags;" == *";held-copy;"* || ";$tags;" == *";earlier-guest;"* ]] || { echo "guest $vmid is neither a held copy nor an earlier guest: $tags" >&2; exit 2; }
    $tool destroy "$vmid" --purge
    echo "destroyed $vmid"
    ;;
  tasks)
    pvesh get "/nodes/$node/tasks" --vmid "$vmid" --source all --limit 20 --output-format json |
      jq -r '.[] | [.type, (.starttime | todate), ((.endtime // 0) | todate), (.status // "running"), .user] | @tsv'
    ;;
  start-by-hand)
    [ $type = lxc ] || { echo "start-by-hand reads the journal of containers only" >&2; exit 2; }
    pct start "$vmid"
    sleep 30
    pct exec "$vmid" -- bb-box-identity status || true
    pct exec "$vmid" -- journalctl -b -u bb-box-identity -o short-precise --no-pager | tail -20 || true
    pct exec "$vmid" -- sh -c 'cat /var/lib/bb-box/identity-resets 2>/dev/null; ip -br link' || true
    pct stop "$vmid"
    echo "stopped $vmid again"
    ;;
  *)
    usage
    ;;
esac
