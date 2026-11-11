# Proxmox restores recover from a node's restart

Status: accepted
Date: 11 November 2026

## Context

[070](070-snapshots.md) made gate G16: a restore on Proxmox must come
through a restart of its node, not only a restart of BB Box.
[086](086-proxmox-lxc-boxes-restore-on-zfs-in-zfss-order.md) turned ZFS
restores on with G16 unproved on both LVM-thin and ZFS, to be run on a
Proxmox node nested in a VM.

That run is in [093's results](093-results.md). A node was rebooted, and
reset hard, at each step a restore journals, on LVM-thin and on ZFS. It
showed four things BB Box did wrong:

- A node starts its boxes at its boot. A box BB Box had stopped for a
  restore was running again when BB Box went on, so BB Box took an undo of
  the running box, and the rollback was then refused.
- Proxmox VE 9 answers a task it has no record of with HTTP 400, not 500.
  BB Box read that as a task it could not read, so a take or restore whose
  task a hard reset lost stayed unsettled at every sweep.
- A task a node lost in its restart cannot be running. 070 left a take
  with a missing task and no snapshot unknown, rightly, as missing alone
  does not prove that. But nothing else settled it.
- A rollback cut short by the restart was settled as failed, with the box
  stopped and its disk "maybe part-restored": half way, with no way back
  through BB Box.

Proxmox's API token cannot clear a lock a task leaves: Proxmox answers
"CT is locked (rollback)" to any change, and only root's `pct unlock`
clears it.

## Decision

- A restore that goes on after a restart, before it changed the box's
  disk, first reads whether the box runs. If it does, it was started again,
  as a node starts its boxes at its boot. BB Box restores nothing, takes no
  undo, and says so: the box stays as it is.
- The Proxmox backends read a task Proxmox has no record of, under either
  answer, as lost when the node started after the task began, by the
  node's own clock: its uptime and its time. A lost task is not running.
  BB Box then settles the take or undo by what the guest holds: a whole
  snapshot is ready, a part-made one incomplete, and none means it was not
  taken. A task Proxmox has no record of that began after the node's boot
  is still missing, and still left unknown, as 070 decided.
- A rollback whose task failed, or was lost, is rolled back again to the
  same snapshot, once. While Proxmox refuses, as when it left the guest
  locked, the restore stays open: the box stays stopped and held, and BB
  Box says what to run on the node, such as `pct unlock 9901`, and rolls
  back again at each sweep until it can. A second failed rollback leaves
  the box stopped, as before, and says so.

This supersedes 070's "a rollback task that failed leaves the box
stopped", from G6's tests, for a first failure.

## Consequences

- A restore that a node's restart cuts short ends at the snapshot with its
  undo, or as it was with the restore reported as not done. Where Proxmox
  left a lock, it ends so once root unlocks the guest.
- Two cases still need root on the node, and the guide gives the commands:
  - On LVM-thin, Proxmox rolls back by removing the box's volume, then
    making it again from the snapshot. A restart between the two leaves the
    box with no volume, and Proxmox's own rollback cannot run again: it
    fails to remove the missing volume. The window is milliseconds; the run
    widened it to prove it.
  - A copy cut short by a hard reset can leave its volume with no guest.
    The token cannot see or delete it.
- A hard reset, as in a power cut, is not covered in full. Proxmox keeps
  `/etc/pve` in SQLite with `synchronous=NORMAL`, and Linux writes dirty
  pages back after 30 s, so the node can lose about the last 30 s of guest
  configuration. In the run it lost a held copy made 41 s before the reset,
  which was the restore's undo. BB Box lists such an undo as lost at its
  second listing, 10 minutes later. A graceful reboot lost nothing.
- Held copies and earlier guests stayed stopped, with their links down,
  through a reboot and a hard reset.
