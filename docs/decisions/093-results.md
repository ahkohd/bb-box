# 093 results: G16, restores through a node's restart

Run on 11 November 2026, on main `73d24449` and then this change.

## The test bed

- **The node.** Proxmox VE 9.2.26 on Debian 13, from Proxmox's
  no-subscription repository, kernel 7.0.14-28-pve, as a KVM guest of 6
  cores and 12 GiB in a Linux box on Proxmox QEMU. Its own disk files gave
  it an LVM-thin pool, `local-lvm`, and a ZFS pool, `local-zfs`, of 40 GiB
  each. It is written pve-1.
- **bb-box on the node.** `setup-host.sh`, `setup-network.sh`,
  `setup-token.sh` and `template/build.sh linux 9100` from the setup guide,
  as root on pve-1. Template 9101 is a full copy of 9100 on ZFS. The token
  was given `PVEDatastoreUser` on `local-zfs` as well.
- **BB.** A fresh `npx bb-app` 0.49.0 with no account, its own data folder
  and ports, started with `env -i`, `HOME`, `PATH` and
  `BB_BOX_LIVE_CHECKS=1` only, in another Linux box, with bb-box installed
  from this branch with `bb plugin install path:`, machine access direct,
  and `general.identityResetBackends=proxmox-lxc`. Boxes were machines of
  the person's, `lvm-a` on LVM-thin (guest 9900) and `zfs-a` on ZFS (9901,
  then 9904 after a swap), each 2 cores, 2 GiB and 16 GiB.
- **Each run.** Write A to `~/g16.txt`, take a snapshot, write B. Start a
  restore with `bb box snapshot hold-next` at the step, restart the node,
  wait for it, then restart BB Box with `bb plugin reload bb-box`.
- **A reboot** is `systemctl reboot` on pve-1. **A hard reset** is QEMU's
  `system_reset` on pve-1's VM, which loses what pve-1 had not written to
  its disks.
- **During a task.** Proxmox's LVM-thin snapshot and rollback take under a
  second, and a ZFS rollback is one command. To restart the node during
  them, a wrapper on pve-1 held `lvcreate` or `zfs rollback` for 90 s when
  a flag in `/run` was set, and the node was restarted 3 s after the task
  began. A held copy's clone, about 10 s, needed no wrapper.

## LVM-thin

| Step | Restart | What pve-1 held after | What BB Box did | Box |
| --- | --- | --- | --- | --- |
| After the stop | reboot | The box running at B: the boot started it (`onboot: 1`) | Before the fix: took an undo of the running box, then "refused the rollback: Guest 9900 is running ... Nothing on its disk changed, and BB Box started box lvm-a again as it was". The undo stayed, for a restore not done | B, not done; a stray undo. Fixed |
| During the undo | reboot | Proxmox's task interrupted and cleaned up: "snapshot create failed: starting cleanup", no lock, no part-made snapshot; the box running at B | "could not take the undo ...: received interrupt. Nothing on its disk changed" | B, not done |
| During the undo | hard reset | No lock, no snapshot, and no record of the task: the reset lost its config write | "could not take the undo ...: unexpected status. Nothing on its disk changed" | B, not done |
| During the rollback | reboot, `lvcreate` held | The box's volume removed and not made again; `lock: rollback`; the boot's start failed: "no such logical volume" | Before the fix: "could not finish restoring ...: lvm rollback ... received interrupt. The box is stopped, and its disk may be part-restored." After `pct unlock`, a new restore failed at its undo ("Snapshot origin LV vm-9900-disk-0 not found") and one with `--no-undo` at Proxmox's rollback ("lvremove ... Failed to find logical volume") | Half way. Root's `lvcreate -kn -n vm-9900-disk-0 -s bbthin/snap_vm-9900-disk-0_<target>` and `pct unlock 9900` brought it to A, and its undo then restored B |
| After the rollback, before the start | reboot | The box running at A: the boot started it | Finished the restore at its restart | A, with its undo |
| A take, during its task | hard reset | No snapshot, no lock, no record of the task | Before the fix: unsettled at every sweep: "could not read its task ... (400): Parameter verification failed. - upid: no such task". After it: "pve-1 restarted after Proxmox began task ..., and kept no record of it, so it is not running. pve-1 has no such snapshot, so it was not taken." | Settled, failed |

## ZFS

| Step | Restart | What pve-1 held after | What BB Box did | Box |
| --- | --- | --- | --- | --- |
| After the stop | reboot | The box running at B | Before the fix: "could not copy box zfs-a for its undo: Guest 9901 is running", with a failed undo record | B, not done. Fixed as on LVM-thin |
| During the held copy | hard reset | The copy's guest config gone, its dataset `tank/subvol-9902-disk-0` left with no guest; the box running at B | Before the fix: unsettled, as the take above. After it: "Box zfs-a started again before BB Box restored it, as a node that restarts starts its boxes. Nothing on its disk changed" | B, not done; a stray dataset only root can delete |
| During the rollback | reboot, `zfs rollback` held | The rollback not run: the disk at B, `lock: rollback`; the boot's start failed; held copy 9903 a template, stopped | After the fix: the restore stays open: "... failed: zfs error: received interrupt, so its disk may be part-restored, and Proxmox LXC on pve-1 refused to roll it back again: Proxmox has guest 9901 locked (rollback) ... Run `pct unlock 9901` on pve-1. BB Box rolls it back again at each sweep until it can". After `pct unlock 9901` and a sweep: done | A, with its undo; restoring the undo made a new guest from 9903 and brought back B |
| After the rollback, before the start | hard reset | The rollback kept: the box running at A. The held copy's guest config, made 41 s before the reset, gone; its dataset `tank/basevol-9905-disk-0` left | Finished the restore. Listed the undo as ready, on guest 9905, which no longer exists | A, with its undo lost |

Held copy 9903 (`template: 1`, `onboot: 0`, `link_down=1`) and earlier guest
9901 (`onboot: 0`, `link_down=1`, tag `earlier-guest`) stayed stopped
through a reboot and a hard reset. Neither started.

## What the token can do

Measured with bb-box's token on pve-1:

- `PUT /nodes/pve-1/lxc/<vmid>/config` with `delete=lock`: "CT is locked
  (rollback)". So is a rollback asked for while the lock is there.
- `DELETE` of an orphan volume on `local-zfs`: "Permission check failed
  (/storage/local-zfs, Datastore.Allocate)". The storage's content list
  does not show it either.
- `GET /nodes/pve-1/status`, which holds the node's uptime: allowed, by
  `Sys.Audit` on `/nodes/pve-1`, which the token has.

## Why a hard reset can lose an undo

`pmxcfs` keeps `/etc/pve` in SQLite with `PRAGMA journal_mode=WAL` and
`PRAGMA synchronous=NORMAL`, read from its binary. In that mode SQLite does
not wait for the disk at each commit, so a power cut can lose commits that
other readers already saw. Linux writes such changes back in the
background; pve-1's `vm.dirty_expire_centisecs = 3000` says when a page may
be written, not when it will have been. So no wait is known that makes a
change safe. The reset lost the held copy's config, made 41 s before it,
and both tasks that made it, while the ZFS rollback, which waits for its
transaction group, was kept.

This run shows the risk. It does not measure a window, and it proves no way
to bring a lost undo back. A graceful reboot lost nothing here.

## Tests that fail without the change

Run with the tests and fakes of this change against main's source
(`73d24449`), against this branch's first head (`8665a516`), and against
this change. 110 tests in `proxmox-lxc-snapshots`, `restore-recovery` and
`restore`: 21 fail on main, 15 on the first head, none on this change.

Fail on main and pass on this change:

- "G16 by rollback", "on ZFS storage" and "by the live-check switch: a node
  that restarts after the stop starts the box at its boot, and recovery then
  takes no undo and restores nothing".
- "G16: a take whose task the node lost, leaving a whole snapshot on the
  guest, is settled by it", and the same for an undo.
- "G16: a rollback lost by its node is rolled back again once", and "a
  rollback failed as its node rebooted".
- The tests of the lost task's evidence, the HTTP 400 answers, the LVM-thin
  lock's command, the undo gone, the guard, the second rollback and the
  refusals, below.

Fail on the first head and pass on this change:

- "G16: a task Proxmox has no log of stays missing while the node has not
  restarted, though its clock moved on or its uptime reads wrong": the
  first head read a node clock set forward by 250 s, and an uptime of
  `null`, as a restart.
- "G16: a task the node lost in a hard restart is lost ... whatever the
  node's clock did": the first head missed the restart once the node's
  clock was set back.
- "G16: a task that failed as its node rebooted says the node restarted".
- "G16: only Proxmox VE 9's no-such-task answer from the task's status
  reads as no task": the first head read "unable to parse worker upid" as
  no task.
- "G16: a guest a cut rollback left locked on LVM-thin is refused with how
  to make its volume again before the unlock".
- "G16: a rollback cut short whose undo, a snapshot, is then gone leaves
  the box stopped", and the same for a held copy: the first head started
  the box as if nothing on its disk had changed.
- "G16: a rollback cut short is not rolled back again once the guard
  refuses".
- "G16: a restore rolls back again only once, across BB Box's restarts",
  when the second rollback fails and when it is lost: the first head rolled
  back a third time.
- "G16: a delete whose task the node lost, with the snapshot still on the
  guest, is deleted again", and "a rollback made outside BB Box whose task
  the node lost is not logged": the first head failed the delete, and
  logged the rollback as failed.
- "with no node restart, a rollback task that failed is not rolled back
  again", "Opus 8: restarts mid-task", and main's "a rollback task that
  fails leaves it stopped": the first head rolled back again with no
  restart.

Pass on all three, as checks that settling is unchanged: a take or undo
whose task was lost, leaving a part-made snapshot or none.

## Tests of the third change

The third change journals each rollback before its request, stops a guest
its node started when its disk may be part-restored, reads a task ID as
evidence only in Proxmox's whole grammar, and keeps a retried restore's
first rollback BB Box's own. Its tests were run against the second head
(`47c7689e`), then with each part of the change put back in turn.

Fail on the second head and pass on this change, 9 tests:

- "G16: a second rollback Proxmox accepted, whose answer and task were
  both lost, is the one retry": the second head rolled back a third time.
- "G16: a rollback cut short whose undo, a snapshot, is gone, and whose
  guest the node started at its boot, is stopped again and left stopped",
  the same for a held copy, "... when the guard then refuses", and "a
  second rollback lost too, whose guest the node then started": the second
  head left the box ready and running.
- "G16: a rollback cut short, whose guest the node started and BB Box
  cannot stop, keeps its restore open and the box held": the second head
  refused to roll back a running guest and said it kept it stopped.
- "G16: only a task ID whole in Proxmox's own form is evidence of a
  restart", and "a malformed task ID that failed is not said to be cut
  short by a restart": the second head read
  `UPID:pve:NOTHEX00:000F4240:FFFFFFFF:vzrollback:7000:root@pam:` as lost.
- "G16: a first rollback cut short by a restart is still BB Box's own after
  its retry": the second head logged it as a failed restore made outside
  BB Box.

With one part put back at a time, each fails only its own tests: the
strict task ID 2, the ownership lookup 1, the third rollback's refusal 1,
the stop of a running guest 6, the refusal freeing its place 1 ("a refusal
spends no try"), and the first rollback asked again as before 1 ("with no
node restart, a first rollback whose answer never came ... as before",
which passes on main and on the second head).

## Live after the change

With bb-box from this branch's first head, at its restart: a restore held
after its stop on LVM-thin, then a reboot, settled as "Box lvm-a started
again before BB Box restored it, as a node that restarts starts its boxes.
Nothing on its disk changed", with B on the box and no undo taken; the take
above settled as not taken; the restore cut short during its held copy
settled as not done; the ZFS rollback cut short stayed open until
`pct unlock`, then finished, and its undo restored B. `bb box doctor` then
said 0 operations not settled.

The second and third changes, to the lost task's evidence, the
rollback's journal and the stop of a node-started guest, were not run
again on the node. Both live rollbacks cut short read back
after the reboot as failed tasks, "received interrupt", whose worker began
before the boot: the case the change rolls back again.

## Not proved

- **A hard reset soon after a change on the node.** Proxmox can lose the
  change. An undo made then can be lost, and a copy's volume left with no
  guest. No safe wait is known, and no recovery of the undo is proved.
- **LVM-thin's rollback between its two steps.** Only root can put the
  volume back.
- A take on ZFS cut short was not run; it is the same code as on LVM-thin.
- The run did not repeat every cell after each fix: the LVM-thin rollback
  cut short records the failure before the fix and root's repair.
