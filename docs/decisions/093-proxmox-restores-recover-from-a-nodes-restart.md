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
reset hard, at steps a restore journals, on LVM-thin and on ZFS. Some
cells needed root on the node before BB Box could go on, and a ZFS take
cut short was not run. It showed four things BB Box did wrong:

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
- The Proxmox backends say a node restarted after a task began only on the
  node's own evidence, never on wall-clock times. Proxmox's task ID holds
  its worker's start, in clock ticks since the node's boot. If the node's
  uptime now, read from the node the task ran on, is less than that, the
  worker belonged to an earlier boot. Anything else, such as an uptime that
  cannot be read or is not a whole number of seconds above zero, proves
  nothing. So does a task ID that does not match Proxmox's own grammar in
  every field, from its node name to its closing colon, though older
  Proxmox answers it as a task it has no record of.
- A task Proxmox has no record of, under Proxmox VE 9's "no such task"
  answer or the older HTTP 500 one, is lost when the node restarted after
  it began. A lost task is not running. BB Box then settles the take or
  undo by what the guest holds: a whole snapshot is ready, a part-made one
  incomplete, and none means it was not taken. A task Proxmox has no record
  of with no such evidence is still missing, and still left unknown, as 070
  decided. No other HTTP 400 answer reads as no task.
- A rollback is rolled back again, to the same snapshot, only when its task
  was lost, or failed, and the node restarted after it began. A restore
  rolls back again once at most, across BB Box's restarts.
- BB Box journals each rollback before it sends the request, then adds its
  task when Proxmox answers. A rollback whose answer never came counts as
  sent. For the first rollback, BB Box looks for its task and, finding
  none, sends it again, as 070 built it. For the second, it does not: the
  restore stays open, with the box stopped and held, and BB Box looks for
  the task again at each sweep. Only a definite refusal, such as the guest
  being locked, frees a rollback's place. While Proxmox refuses, the
  restore stays open: the box stays stopped and held, BB Box says what to
  run on the node, and tries again at each sweep. On LVM-thin, the refusal
  for a guest locked by a rollback also gives the `lvs` check and the
  `lvcreate` command that makes its volume again from the snapshot.
- A rollback stays BB Box's own after it rolls back again. BB Box reads
  every journaled rollback as its own, so the first is never reported as a
  restore made outside BB Box.
- Once a rollback may have changed the disk, BB Box never starts the box as
  it was, and does not leave it running. A node starts its boxes at its
  boot, so before BB Box rolls back again or gives up, it stops the guest
  if it runs. If it cannot stop it, or cannot read whether it runs, the
  restore stays open and the box held, and BB Box tries again at each
  sweep. If the undo is gone, or the guard refuses, when it would roll
  back again, or the second rollback fails or is lost, the restore fails
  with the box stopped. BB Box says its disk may be part-restored, and to
  restore it again before use.
- With no such restart, a rollback goes as 070 built it: a task that failed
  leaves the box stopped, and a missing one stays unknown.

This supersedes, for a rollback cut short by its node's restart only,
070's "a rollback task that failed leaves the box stopped", from G6's
tests.

## Consequences

- A restore that a node's graceful reboot cuts short ends at the snapshot
  with its undo, or as it was with the restore reported as not done, where
  the run showed it. Where Proxmox left a lock, it ends so once root
  unlocks the guest.
- A node whose uptime has passed a task's worker start since its restart
  gives no evidence. A task lost then stays unknown, as 070 decided, and
  `bb box doctor` names it.
- A second rollback whose answer and task log were both lost leaves the
  restore open, with the box stopped, until its task is found or a person
  restores the box again or releases it. BB Box cannot tell whether that
  rollback ran.
- The first rollback whose answer never came, and whose task cannot be
  found, is still sent again, as 070 built it, so a node that restarts
  during that first request can still see two rollbacks before the retry.
- Two cases still need root on the node, and the guide gives the commands:
  - On LVM-thin, Proxmox rolls back by removing the box's volume, then
    making it again from the snapshot. A restart between the two leaves the
    box with no volume, and Proxmox's own rollback cannot run again: it
    fails to remove the missing volume. The window is milliseconds; the run
    widened it to prove it.
  - A copy cut short by a hard reset can leave its volume with no guest.
    The token cannot see or delete it.
- A hard reset, as in a power cut, is not covered. Proxmox keeps
  `/etc/pve` in SQLite with `synchronous=NORMAL`, and Linux writes such
  changes to disk in the background, so a power cut can lose recent guest
  configuration. No wait is known to make a change safe. In the run, the
  reset lost a held copy made 41 s before it, which was the restore's undo.
  BB Box listed that undo as ready until a later listing found it gone. No
  recovery of a lost undo is proved.
- Held copies and earlier guests stayed stopped, with their links down,
  through a reboot and a hard reset.
