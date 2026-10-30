# Snapshots

A snapshot keeps a box's state at one moment, so you can see later what it held. BB Box keeps its own record of each snapshot, and the box's backend keeps the snapshot itself, on the box's host.

For now you take, list and delete snapshots from the command line, on Proxmox LXC boxes and Proxmox QEMU Linux boxes. Restoring a box to a snapshot, forking a new box from one and keeping one after its box is released come later: see [decision 070](../decisions/070-snapshots.md).

## What each backend offers

| Backend | Holds | While the box runs |
| --- | --- | --- |
| Proxmox LXC | the disk | taken live, in about a second |
| Proxmox QEMU, Linux | the disk, or the disk and memory | taken live; with memory about a second for each GiB of memory |
| Every other backend | no snapshots yet | |

A Proxmox snapshot needs storage that takes them: LVM-thin, ZFS, Ceph RBD, BTRFS, or qcow2 disks on a directory for VMs. It also needs the token's `VM.Snapshot` right. `bb box doctor` says whether both are so, in its Snapshots check.

## Taking a snapshot

```
bb box snapshot take <box> [--name <name>] [--note <text>] [--memory]
```

`--memory` holds the box's memory too, where its backend can: Proxmox QEMU can, for a box that runs; Proxmox LXC cannot. A stopped Proxmox QEMU box is suspended to disk, so start it before you take a snapshot of it. Proxmox saves a VM's memory as a volume of twice its memory and 500 MiB more, on the VM's `vmstatestorage` or else on its disks' storage; BB Box checks that storage's room first, and refuses a memory snapshot when it cannot tell which storage Proxmox would use. Without `--name`, the snapshot is named after the time, such as "Thu 10:42". A name is unique on its box: a repeat gets " (2)".

The command waits until the backend confirms the snapshot is complete. A box holds 5 snapshots unless you change it in the settings (below). A take is refused when the host's storage is more than 85% full, or would be with the snapshot, or when its thin metadata is more than 80% full, as a full thin pool stops every box on the host. Both numbers follow the settings.

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

## Settings

BB Box's settings have a Snapshots page, under Options. Its fields wait for Save, as other fields do.

| Setting | Default | Range | What it does |
| --- | --- | --- | --- |
| Snapshots per box | 5 | 1 to 50 | A take past it is refused, naming the snapshots to delete. Kept ones count; undos are counted apart, 2 a box. |
| Refuse new snapshots when a host's storage is past | 85% full | 50 to 90 | A take is refused past it, and past 5 points below it of a thin pool's metadata. 7 points above it, BB Box deletes agents' snapshots on that storage that nobody kept, oldest first, and logs why. |
| A ceiling on paid snapshots, one per backend that charges | 5 a month, in the provider's currency | 0 to 1,000 | A take that would bring the monthly rate held on that backend past it is refused. |

The page also says what each backend's snapshots hold and cost, and what its last check found of its storage.

From a terminal, `bb box option set general.snapshots.perBox=3` and `general.snapshots.roomPercent` change the first two.

### Paid snapshots

The ceiling bounds the monthly rate of what is held, not the bill. The rate is every paid snapshot the provider holds, kept or not, times its daily price, times 30. A take is refused when the rate would pass the ceiling after it, with the words "It would bring snapshots held on (backend) to about $5.04 a month, past your ceiling of $5.00". When the rate is past the ceiling for another reason, such as a lower ceiling, the page warns, new paid snapshots are refused, and BB Box deletes none of them. Beside each ceiling, the page shows the rate held and what was spent this month, deleted snapshots included. A price BB Box does not know is shown as unknown, and only you can take a snapshot there.

No backend charges for snapshots yet, so the page says "None of your backends charges for snapshots".

## Removing a backend

A backend that holds snapshots cannot be removed from the settings while BB Box records them. Delete them first, or forget them:

```
bb box snapshot forget <backend> --yes
```

Forgetting removes BB Box's records only. The snapshots may still exist on the backend, and be billed there.
