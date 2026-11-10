# Proxmox LXC boxes restore on ZFS in ZFS's order

Status: accepted
Date: 10 November 2026

## Context

ZFS rolls a disk back only to its newest snapshot. [070](070-snapshots.md)
designed restores there in ZFS's order: stop the box, make a held copy of
it as the undo, which is not a snapshot and so does not block the rollback,
then roll back. Undoing such a restore swaps the box to a new guest made
from the copy, and its old guest becomes an earlier guest, fork only.

No ZFS node was free when 070 was built, so ZFS restores shipped off. The
order was proved under a live-check switch that runs it on LVM-thin, and
restoring a held copy stayed behind the same switch. 070 made gate G4 on a
ZFS node, and G16's node reboot, conditions before ZFS restores were turned
on.

A test ZFS storage on a Proxmox node is now free for live checks. A node
reboot is not: the node runs everything else.

## Decision

- A Proxmox LXC box whose disks are on ZFS restores in ZFS's order, by its
  backend's plan (`rollback-newest-only`, with a held copy as the undo),
  not by the live-check switch. The switch stays, for checks on LVM-thin.
- A restore to a snapshot with a newer one is refused before the box
  stops, with the count, and says to fork it or delete the newer ones
  first. bb-box never deletes newer snapshots to make a restore possible.
- The held copy is made only of a box whose identity reset works now, as
  070 says. A person may restore without an undo, which is a rollback
  alone.
- Restoring a held copy, a swap to a new guest, no longer needs the
  live-check switch, so a ZFS restore can be undone.
- A Linux VM on Proxmox QEMU on ZFS still restores nothing. Its order is
  the same, but it was not checked on a VM on ZFS. Windows desktops and
  Android boxes on ZFS stay refused, as they have no identity reset.

This supersedes 070's "ZFS restores ship off" and "restoring a held copy
stays behind the same switch", from its "Decided during unit 3", for
Proxmox LXC. It does not meet G16's reboot condition: see below.

## Consequences

- G4 on ZFS ran on a test ZFS storage: [results](070-results.md#zfs-restores-on-proxmox-lxc).
- G16's node reboot is still unproved. A held copy is disarmed and a
  template, which Proxmox does not start, and one cut short before it is a
  template is deleted and made again at bb-box's start, but no node was
  rebooted with one on it. A held copy is made only on a backend whose
  identity reset is armed (`general.identityResetBackends`), which is the
  owner's call, as it is for Keep. The guide says the reboot is unproved.
- The undo of a restore on ZFS is a full copy: about the box's disk size on
  the storage, a VMID from the box range, and about as long as copying the
  disk. The restore's check and dialog say the time and space first.
- Undoing it leaves an earlier guest, which holds the box's other
  snapshots, fork only, until the last goes or the box is released.
