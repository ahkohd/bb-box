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
- BB Box rolls a restore back again on its own only where 070 built it to:
  when the first rollback's request had no answer and BB Box finds no task
  for it, it sends it once more. In every other case where BB Box cannot be
  certain whether a rollback began, or what the disk holds, it never rolls
  back again on its own. Those cases are:
  - the rollback's task was cut short by its node's restart: lost, or
    failed with the node restarted after it began
  - Proxmox no longer has the rollback's task
  - the request sent once more had no answer either, and BB Box finds no
    task for it
  - the box runs when BB Box would send the request once more, as a node
    that restarts starts its boxes
- In each of those cases BB Box stops the box if it runs, and never starts
  it. It ends the restore as failed, with the box stopped, and says that
  its disk may be part-restored, that it does not roll it back again on
  its own, and what the person can do: restore it to a snapshot again, or
  release it. A new restore of the box is allowed. It first takes a fresh
  undo, of the part-restored disk, and the failed restore's undo stays, so
  the disk as it was before can still be restored.
- BB Box journals the decision to stop the box and fail the restore the
  moment it makes it. Every later sweep, before BB Box restarts or after,
  reads that decision before it looks at any task: it only tries to stop
  the box, and ends the restore failed once a read says the box is stopped.
  A task that later reads as OK, running, failed or unreadable changes
  nothing.
- If BB Box cannot stop the box, or cannot read whether it runs, the
  restore stays open, so nothing starts the box, and BB Box tries to stop
  it again at each sweep. It does so before it lists the backend's
  snapshots, so a listing that fails does not stop it. It never rolls back
  then. The person can release
  the box at any time. BB Box reads the box's power once more as it ends
  the restore, and ends it only when that read says stopped. A box found
  running then, or whose power cannot be read, stays held, and BB Box stops
  it at the next sweep.
- An HTTP answer to the rollback's request that does not say Proxmox began
  nothing is never a refusal: a 5xx answer, a timeout or a lost connection
  leaves the rollback's outcome unknown. Only a 4xx answer, or Proxmox
  failing to take the guest's lock, is a refusal.
- BB Box journals each rollback before it sends the request, then adds its
  task when Proxmox answers, so a lost answer is known to be uncertain.
  A rollback task whose ID the journal holds is BB Box's own. So is a
  rollback task of the same guest, by BB Box's own Proxmox user, that began
  while a request whose answer never came was open: from the request,
  until the restore ended, each with a minute's slack for the two clocks.
  BB Box reports neither as a restore made outside it. A rollback by
  another user in that time is still reported, as Proxmox names its user.
- On LVM-thin, the refusal of a new restore for a guest locked by a
  rollback also gives the `lvs` check and the `lvcreate` command that makes
  its volume again from the snapshot the restore names, before the unlock.
- With no restart, a rollback task that failed leaves the box stopped, as
  070 built it, and a refusal of the request starts it again as it was.

This supersedes two parts of 070, from G6's tests. A rollback whose task
Proxmox no longer has fails, with the box stopped, rather than staying
unknown. A request to roll back is sent at most twice: when the second has
no answer either, the restore fails rather than sending a third.

## Consequences

- A restore that a node's graceful reboot cuts short before its rollback
  ends as it was, with the restore reported as not done. One cut short
  during its rollback ends failed, with the box stopped and its undo kept.
  Where Proxmox left a lock, a new restore works once root unlocks the
  guest.
- A node whose uptime has passed a task's worker start since its restart
  gives no evidence. A take or undo whose task was lost then stays unknown,
  as 070 decided, and `bb box doctor` names it. A rollback whose task
  Proxmox no longer has needs no such evidence: it fails, with the box
  stopped, as above.
- A restore cut short by its node's restart does not finish on its own. It
  fails with the box stopped, and the person restores the box again or
  releases it. An earlier version of this decision rolled back again once
  after a restart. Review found that each guard it needed opened another
  case, so it was taken out.
- The first rollback whose answer never came, and whose task cannot be
  found, is still sent again, as 070 built it. BB Box cannot tell whether
  its node restarted then, unless the box is running.
- A rollback whose task is missing while its worker still runs is failed.
  Proxmox's lock on the guest refuses a new restore, or a release, until
  that worker ends.
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
