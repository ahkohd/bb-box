#!/bin/bash
set -euo pipefail
usage() {
  cat >&2 <<'TEXT'
The root steps of 070 unit 7's live check, on the Proxmox node. Each acts
only on the VMIDs in BBBOX_VMIDS, and only on guests that carry the tag
install.<BBBOX_INSTALL>, as bb-box's boxes and forks do.

  live: BBBOX_VMIDS="3170 3171" BBBOX_INSTALL=<id> proxmox-root.sh <command> [vmid]

  config <vmid>
      read only: prints the guest's onboot, template, lock, tags, hostname
      or name, network lines and SMBIOS UUID (gate G14: a fork starts with
      onboot set and its links up)
  card-late <vmid>
      for a QEMU fork bb-box holds before its first start (bb box snapshot
      hold-next --at forked): waits up to 10 minutes for the guest to exist,
      re-armed and stopped, saves its net0 in /root/unit7-<vmid>-net0, removes
      it, waits for bb-box to start the VM, waits 75 s more, so its first
      boot cannot tell whether it is a copy, then puts the same net0 back
      while it runs (gate G14: a fork whose first boot says unknown is not
      handed over as ready)
  leftovers
      read only: lists every guest in BBBOX_VMIDS that carries the install's
      tag, with its status and tags, for the clean-up
  destroy <vmid>
      stops and destroys a guest of the install that bb-box no longer
      records, for the clean-up
TEXT
  exit 2
}
[ $# -ge 1 ] && [ -n "${BBBOX_VMIDS:-}" ] && [ -n "${BBBOX_INSTALL:-}" ] || usage
command=$1
node=$(hostname)

listed() { [[ " $BBBOX_VMIDS " == *" $1 "* ]] || { echo "VMID $1 is not in BBBOX_VMIDS: $BBBOX_VMIDS" >&2; exit 2; }; }
kind_of() {
  if [ -e "/etc/pve/nodes/$node/qemu-server/$1.conf" ]; then echo qm
  elif [ -e "/etc/pve/nodes/$node/lxc/$1.conf" ]; then echo pct
  else echo none; fi
}
ours() {
  local tool=$1 vmid=$2 tags
  tags=$($tool config "$vmid" | sed -n 's/^tags: //p')
  [[ ";$tags;" == *";install.$BBBOX_INSTALL;"* ]]
}
must_be_ours() {
  local tool
  tool=$(kind_of "$1")
  [ "$tool" != none ] || { echo "no guest $1 on $node" >&2; exit 2; }
  ours "$tool" "$1" || { echo "guest $1 does not carry the tag install.$BBBOX_INSTALL" >&2; exit 2; }
  echo "$tool"
}

case $command in
  config)
    [ $# -eq 2 ] || usage
    listed "$2"
    tool=$(must_be_ours "$2")
    $tool config "$2" | grep -E '^(onboot|template|lock|tags|hostname|name|net[0-9]+|smbios1):' | sed -E 's/(serial=)[^,]*/\1(address)/'
    ;;
  card-late)
    [ $# -eq 2 ] || usage
    listed "$2"
    vmid=$2
    for _ in $(seq 1 300); do
      tool=$(kind_of "$vmid")
      if [ "$tool" = qm ] && ours qm "$vmid" && qm config "$vmid" | grep -q '^onboot: 1' && qm status "$vmid" | grep -q stopped; then break; fi
      sleep 2
    done
    [ "$(kind_of "$vmid")" = qm ] && ours qm "$vmid" || { echo "no re-armed QEMU guest $vmid of the install appeared" >&2; exit 1; }
    net0=$(qm config "$vmid" | sed -n 's/^net0: //p')
    [ -n "$net0" ] || { echo "guest $vmid has no net0" >&2; exit 1; }
    printf '%s\n' "$net0" > "/root/unit7-$vmid-net0"
    qm set "$vmid" --delete net0 >/dev/null
    echo "$(date -u +%T) removed net0 of $vmid ($net0)"
    for _ in $(seq 1 300); do qm status "$vmid" | grep -q running && break; sleep 1; done
    echo "$(date -u +%T) $vmid is running, without a card"
    sleep 75
    qm set "$vmid" --net0 "$(cat "/root/unit7-$vmid-net0")" >/dev/null
    echo "$(date -u +%T) put net0 back on $vmid while it runs"
    rm -f "/root/unit7-$vmid-net0"
    ;;
  leftovers)
    for vmid in $BBBOX_VMIDS; do
      tool=$(kind_of "$vmid")
      [ "$tool" != none ] || continue
      ours "$tool" "$vmid" || continue
      echo "$vmid $tool $($tool status "$vmid" | sed 's/^status: //') $($tool config "$vmid" | sed -n 's/^tags: //p')"
    done
    ;;
  destroy)
    [ $# -eq 2 ] || usage
    listed "$2"
    tool=$(must_be_ours "$2")
    $tool stop "$2" >/dev/null 2>&1 || :
    $tool destroy "$2" --purge
    echo "destroyed $2"
    ;;
  *) usage ;;
esac
