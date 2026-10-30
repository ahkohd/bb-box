#!/bin/bash
set -euo pipefail
[ $# -ge 6 ] || { echo "usage: $0 <lxc-vmid> <lxc-box-id> <qemu-vmid> <qemu-box-id> <qemu-box-address> <spare-vmid outside bb-box's ranges> [--with-vzdump]" >&2; exit 2; }

LXC=$1 LXC_BOX=$2 VM=$3 VM_BOX=$4 VM_IP=$5 SPARE=$6 VZDUMP=${7:-}
DUMPDIR=/var/tmp/bb-box-snapshot-research

now() { date +%s.%N; }
since() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.2f s", b - a }'; }
step() { local label=$1; shift; local t; t=$(now); "$@" >/dev/null; echo "TIME $label: $(since "$t")"; }

storage_lines() {
  lvs --noheadings --units g -o vg_name,lv_name,lv_size,data_percent,origin,pool_lv 2>/dev/null |
    grep -E "vm-($LXC|$VM|$SPARE)-|snap_vm-($LXC|$VM)-|bbsnap" || true
  lvs --noheadings --units g -o vg_name,lv_name,lv_size,data_percent -S 'lv_attr=~^t' 2>/dev/null || true
}
show_storage() { echo "STORAGE $1:"; storage_lines | sed 's/^/  /'; }

owns() {
  local tool=$1 vmid=$2 box=$3
  "$tool" config "$vmid" | grep -E '^tags:' | grep -q "$box" || { echo "VMID $vmid does not carry the tag of box $box; stopping." >&2; exit 1; }
}

owns pct "$LXC" "$LXC_BOX"
owns qm "$VM" "$VM_BOX"
if pct status "$SPARE" >/dev/null 2>&1 || qm status "$SPARE" >/dev/null 2>&1; then echo "VMID $SPARE is in use; stopping." >&2; exit 1; fi

echo "PVE: $(pveversion)"
echo "LXC rootfs: $(pct config "$LXC" | grep -E '^rootfs:')"
echo "VM disk: $(qm config "$VM" | grep -E '^(scsi0|virtio0|sata0):')"
echo "VM memory: $(qm config "$VM" | grep -E '^memory:')"
echo "VM agent: $(qm config "$VM" | grep -E '^agent:' || echo none)"
show_storage "at the start"

in_lxc() { pct exec "$LXC" -- bash -c "$1"; }
vm_agent() { qm agent "$VM" ping >/dev/null 2>&1; }
vm_ssh() { timeout 0.3 bash -c "</dev/tcp/$VM_IP/22" 2>/dev/null; }
wait_vm() { local label=$1 t; t=$(now); for _ in $(seq 1 1200); do vm_ssh && break; sleep 0.1; done; echo "TIME vm SSH port answers $label: $(since "$t")"; }
in_vm() { if vm_agent; then qm guest exec "$VM" --timeout 120 -- bash -c "$1"; else echo "(no guest agent: skipped: $1)"; fi; }

echo "=== LXC $LXC"
step "lxc snapshot, running" pct snapshot "$LXC" s1 --description "bb-box snapshot research"
show_storage "after the LXC snapshot"
step "lxc write 1 GiB after the snapshot" in_lxc 'head -c 1024M /dev/urandom > /home/box/after.bin && echo after > /home/box/after-marker && sync'
show_storage "after writing 1 GiB in the LXC"

step "lxc clone of the snapshot (full) to $SPARE" pct clone "$LXC" "$SPARE" --snapname s1 --hostname bbsnap-fork --full 1
pct set "$SPARE" --delete net0,tags,description >/dev/null
show_storage "after the LXC full clone"
step "lxc start the clone, no network" pct start "$SPARE"
step "lxc stop the clone" pct stop "$SPARE"
step "lxc destroy the clone" pct destroy "$SPARE" --purge 1

SNAPLV=$(lvs --noheadings -o lv_name 2>/dev/null | awk '{print $1}' | grep -E "^snap_vm-$LXC-disk-0_s1$" || true)
if [ -n "$SNAPLV" ]; then
  VG=$(lvs --noheadings -o vg_name -S "lv_name=$SNAPLV" | awk '{print $1}')
  step "lxc thin snapshot of the snapshot (what a linked fork would be)" lvcreate -s -n bbsnap-thin-fork "$VG/$SNAPLV" -kn -ay
  show_storage "with the thin fork"
  step "lxc remove the thin fork" lvremove -fy "$VG/bbsnap-thin-fork"
else
  echo "NOTE: no LVM-thin snapshot volume for the LXC; skipped the thin fork."
fi

if [ "$VZDUMP" = --with-vzdump ]; then
  mkdir -p "$DUMPDIR"
  step "lxc vzdump, snapshot mode, zstd" vzdump "$LXC" --mode snapshot --compress zstd --dumpdir "$DUMPDIR"
  ls -l --block-size=M "$DUMPDIR"/vzdump-lxc-"$LXC"-*.tar.zst | awk '{print "SIZE lxc vzdump: " $5}'
  STORE=$(pct config "$LXC" | sed -nE 's/^rootfs: ([^:]+):.*/\1/p')
  step "lxc restore the vzdump to $SPARE" pct restore "$SPARE" "$DUMPDIR"/vzdump-lxc-"$LXC"-*.tar.zst --storage "$STORE" --unique 1
  pct set "$SPARE" --delete net0,tags,description >/dev/null
  step "lxc destroy the restored copy" pct destroy "$SPARE" --purge 1
  rm -f "$DUMPDIR"/vzdump-lxc-"$LXC"-*
fi

step "lxc rollback to s1, then start" pct rollback "$LXC" s1 --start 1
echo "LXC after rollback: $(in_lxc 'ls /home/box/after-marker /home/box/after.bin 2>&1 | tr "\n" " "; ls -l --block-size=M /home/box/before.bin | cut -d" " -f5')"
step "lxc delete snapshot s1" pct delsnapshot "$LXC" s1
show_storage "after the LXC's snapshot is deleted"

echo "=== QEMU $VM"
echo "VM uptime since: $(in_vm 'uptime -s')"
step "vm snapshot, running, disk only" qm snapshot "$VM" disk1 --description "bb-box snapshot research"
show_storage "after the disk-only snapshot"
step "vm snapshot, running, with memory (vmstate)" qm snapshot "$VM" mem1 --vmstate 1 --description "bb-box snapshot research"
show_storage "after the memory snapshot"
step "vm write 512 MiB after the snapshots" in_vm 'head -c 512M /dev/urandom > /home/box/after.bin; echo after > /home/box/after-marker; sync'

step "vm rollback to mem1 (resumes running)" qm rollback "$VM" mem1
echo "VM status after mem1 rollback: $(qm status "$VM")"
wait_vm "after mem1 rollback"
echo "VM after mem1 rollback: $(in_vm 'uptime -s; ls /dev/shm/ram.bin /home/box/after-marker 2>&1 | tr "\n" " "')"

step "vm clone of disk1 (full) to $SPARE" qm clone "$VM" "$SPARE" --snapname disk1 --name bbsnap-fork --full 1
NET=$(qm config "$SPARE" | sed -nE 's/^net0: (.*)$/\1/p')
qm set "$SPARE" --net0 "$NET,link_down=1" --delete tags,description >/dev/null
show_storage "after the VM full clone"
step "vm start the clone, link down" qm start "$SPARE"
step "vm stop the clone" qm stop "$SPARE"
step "vm destroy the clone" qm destroy "$SPARE" --purge 1

if [ "$VZDUMP" = --with-vzdump ]; then
  mkdir -p "$DUMPDIR"
  step "vm vzdump, snapshot mode, zstd" vzdump "$VM" --mode snapshot --compress zstd --dumpdir "$DUMPDIR"
  ls -l --block-size=M "$DUMPDIR"/vzdump-qemu-"$VM"-*.vma.zst | awk '{print "SIZE vm vzdump: " $5}'
  rm -f "$DUMPDIR"/vzdump-qemu-"$VM"-*
  rmdir "$DUMPDIR" 2>/dev/null || true
fi

step "vm rollback to disk1 (stops the VM)" qm rollback "$VM" disk1
echo "VM status after disk1 rollback: $(qm status "$VM")"
step "vm start after disk1 rollback" qm start "$VM"
wait_vm "after the start"
step "vm delete snapshot mem1" qm delsnapshot "$VM" mem1
step "vm delete snapshot disk1" qm delsnapshot "$VM" disk1
show_storage "at the end"
echo "Left: LXC $LXC and VM $VM running with no snapshots; VMID $SPARE removed."
pct listsnapshot "$LXC"; qm listsnapshot "$VM"
