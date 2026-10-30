# Snapshots

A snapshot keeps a box's state at one moment, so you can see later what it held. BB Box keeps its own record of each snapshot, and the box's backend keeps the snapshot itself, on the box's host.

For now you take, list and delete snapshots from the command line, on Proxmox LXC boxes. Restoring a box to a snapshot, forking a new box from one and keeping one after its box is released come later: see [decision 070](../decisions/070-snapshots.md).

## What each backend offers

| Backend | Holds | While the box runs |
| --- | --- | --- |
| Proxmox LXC | the disk | taken live, in about a second |
| Every other backend | no snapshots yet | |

A Proxmox snapshot needs storage that takes them: LVM-thin, ZFS, Ceph RBD or BTRFS. It also needs the token's `VM.Snapshot` right. `bb box doctor` says whether both are so, in its Snapshots check.

## Taking a snapshot

```
bb box snapshot take <box> [--name <name>] [--note <text>] [--memory]
```

`--memory` holds the box's memory too, where its backend can; Proxmox LXC cannot. Without `--name`, the snapshot is named after the time, such as "Thu 10:42". A name is unique on its box: a repeat gets " (2)".

The command waits until the backend confirms the snapshot is complete. A box holds at most 5 snapshots. A take is refused when the host's storage is more than 85% full, or would be with the snapshot, or when its thin metadata is more than 80% full, as a full thin pool stops every box on the host.

## Listing snapshots

```
bb box snapshot list [<box>] [--all] [--kept] [--json]
```

Without a box, it lists the snapshots of the thread's boxes. `--all` lists every snapshot BB Box records, of every thread's boxes and of boxes that are gone.

Each row says the snapshot's name and ID, its state, when it was taken and by whom, what it holds, and its size where the backend says.

| State | Means |
| --- | --- |
| being taken | its take has started and its backend has not confirmed it yet |
| ready | its backend confirmed it complete |
| failed | the take failed and nothing is held; the row goes after 24 hours |
| incomplete | part of it exists, as when a take was stopped part way. Delete it to finish the clean-up on the host |
| being deleted | its delete has started |
| unavailable | BB Box cannot reach its host now, or its backend is not in the settings. It comes back ready when the host answers |
| lost | its host answered twice, 10 minutes apart, without it. The row goes after 7 days |

## Deleting a snapshot

```
bb box snapshot delete <box> <snapshot>
```

Give the snapshot's name or ID. The command waits until the backend confirms it is gone.

If a task such as a backup is running on the box's guest, a take or a delete is refused until it ends. If Proxmox left the guest locked with no task running, as when a task on it was stopped part way, it is refused with the command to run on the host, such as `pct unlock 214`. Only root on the host can unlock a guest.

## When a box is released

A box's snapshots go with it when it is released: Proxmox deletes them with the guest. The box's log says so for each one.

## If BB Box restarts

Each take and delete is recorded before it starts, with the backend's task once it begins. If BB Box restarts in the middle of one, it reads the backend's task and the box's snapshots when it starts again, and finishes or settles it: a take is ready only if the backend shows it complete, and a take that never began is failed, never taken again.

BB Box also compares its records with each backend's snapshots every few minutes. A snapshot BB Box has no record of gets one again, so a lost `snapshots.db` loses no snapshot. One of a box that is gone is listed as found on its host for 7 days, then deleted, unless it carries a keep date.

## Removing a backend

A backend that holds snapshots cannot be removed from the settings while BB Box records them. Delete them first, or forget them:

```
bb box snapshot forget <backend> --yes
```

Forgetting removes BB Box's records only. The snapshots may still exist on the backend, and be billed there.
