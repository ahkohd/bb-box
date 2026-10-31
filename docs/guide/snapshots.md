# Snapshots

A snapshot keeps a box's state at one moment, so you can put the box back to it later. BB Box keeps its own record of each snapshot, and the box's backend keeps the snapshot itself, on the box's host.

For now you take, list, delete and restore snapshots from the command line, on Proxmox LXC boxes and Proxmox QEMU Linux boxes. Forking a new box from one and keeping one after its box is released come later: see [decision 070](../decisions/070-snapshots.md).

## What each backend offers

| Backend | Holds | While the box runs | Restores |
| --- | --- | --- | --- |
| Proxmox LXC | the disk | taken live, in about a second | in place, to any snapshot, on LVM-thin, Ceph RBD and BTRFS |
| Proxmox QEMU, Linux | the disk, or the disk and memory | taken live; with memory about a second for each GiB of memory | as Proxmox LXC, and qcow2 disks on a directory |
| Every other backend | no snapshots yet | | |

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

## A copy of a box gives up its identity

A Linux box can tell when it is a copy of another box, such as a Proxmox clone. When it is, it gives up the identity it copied before its network starts. This is off until you turn it on for a backend, as below.

### How it works

When a box is first ready, BB Box writes an identity marker in it, `/etc/bb-box/identity`. It holds the box's ID and the MAC addresses of the network cards its backend gives it. On Docker it holds a value BB Box sets on the box instead, as Docker gives a container new MAC addresses at each start.

At each start, before its network, SSH, Tailscale, Docker, its desktop and BB's daemon start, the box compares the marker with what it has:

- if any of the marker's MAC addresses is on any of its cards, whatever the card's name, it keeps its identity, and adds its current cards to the marker: so a card added, then the first card removed, changes nothing
- if its cards are all known, and it has a new one of the backend's but none of the marker's, it is a copy, and it resets
- if it cannot tell, as when its card has not appeared after 30 seconds, it removes nothing and starts its network, its desktop and logins, but SSH, Tailscale and BB's daemon wait while it keeps looking; once a card appears, it decides as above

A reset removes what made the box its source:

- BB's machine credentials and host ID, so it joins BB as a new machine
- the thread's access file, `~/.config/bb-box/env`
- its Tailscale node
- its SSH host keys and machine ID, which it makes again

The rest of its disk stays, threads' files included. A restart, a resize, a rename and a spare given to a thread change nothing.

A reset writes down what it will remove before it removes anything, in `/var/lib/bb-box/identity-reset-pending`. If it cannot finish, the box keeps its network, SSH, Docker, its desktop and BB's daemon off, and the next start finishes it. `/var/lib/bb-box/identity-resets` lists each reset, with why and the BB machines it removed.

### If one of BB Box's own boxes resets

A box of BB Box's own should never reset. If one does, BB Box keeps it: it removes the box's old machine from BB, so its credentials stop working, waits until BB confirms that, and enrols the box again as a new BB machine. This is so for your machines too, which BB Box would otherwise release when BB removes their machine. The box's log says so, and `bb box doctor` names the box under Identity resets.

A box that is a thread's own machine, made by New box, is the exception: BB Box never removes that machine, as that would release the box with the thread's worktree. The doctor names the box and its thread instead.

If BB removes a machine while its box does not answer, BB Box keeps the box until it answers, then reads whether it reset, and decides.

A copy made outside BB Box is not one of its boxes, so it stays out of BB.

### Turning it on

Only these images have it on: Linux on Proxmox LXC, Proxmox QEMU and Docker. Others have the program, with it off.

BB Box writes markers only on the backends you name:

```
bb box option set general.identityResetBackends=proxmox-lxc,proxmox-qemu
```

Until then, no box has a marker, and no box resets. Turning a backend off again stops new markers; a box that has one keeps it until you remove it, with `sudo bb-box-identity unarm` in the box.

### Snapshots and forks

Each snapshot records whether its box had a working reset when it was taken. A snapshot without one says "not fork-safe". Forks, which come later, will start only from snapshots that had it.

## Restoring a box

```
bb box snapshot restore <box> <snapshot> --replace [--no-undo] [--force]
```

A restore puts the box's disk back as it was when the snapshot was taken. Everything on its disk since then goes: files, installed apps and settings. The box restarts, so every process in it ends, unless the snapshot holds its memory, when it comes back running as it was then, with the credentials its apps held then. What the box did to the world since, such as a push or an upload, stays done. The command asks for `--replace` so that none of this happens by a slip.

In order, BB Box:

1. Checks the snapshot and the box: the snapshot must be ready and on the box's current guest, and Proxmox must not have the guest locked.
2. Checks what the box would lose. A restore of a box that a thread runs on, working or idle, is refused: it would take the thread's worktree, its uncommitted files and its session with it, and such restores stay off until BB Box can hold every turn on the box while it restores. Move the threads off it, or archive them, first. A person holding the box's desktop, or a BB terminal open on it, refuses the restore too, unless you give `--force`.
3. Checks that its undo fits: the room on the host's storage, and on a paid provider the ceiling, before anything stops.
4. Stops the box at once, without a clean shutdown.
5. Takes the undo: a snapshot of the stopped box, named "before the restore at 01:56", so nothing written before the stop is lost. Without `--no-undo` a restore always takes one, and if it cannot, BB Box starts the box again as it was and restores nothing.
6. Rolls the box back, and starts it.
7. Reads the box's size back. A snapshot holds the box's cores, memory and disk as they were then, so a box resized since goes back to its size then, and the answer says so.
8. Writes the box's access file from the thread's access now, as its first command, before BB's daemon starts again: the restored disk holds the file as it was then. Then it writes the box's labels on Proxmox again, and starts its BB machine again, as a start does.

Undos are counted apart from the snapshots per box: a box keeps 2. A new undo replaces the oldest one that is not kept and not the restore's own target. To undo a restore, restore its undo.

A restore takes a few seconds. Measured on Proxmox LXC on LVM-thin, a box of 16 GiB: about 4 s, of which the stop takes about a second, the undo and the rollback under a second each, and the start about 2 s. When the snapshot was taken while the container ran, Proxmox's own start takes about 45 s instead, and BB Box waits for it.

### ZFS

ZFS rolls a disk back only to its newest snapshot. BB Box restores nothing on ZFS yet: it says so, and changes nothing. Its restores there come once they are checked on a ZFS node. They will take a held copy of the stopped box as the undo, a full copy that cannot start, and undoing such a restore makes the box a new guest from that copy, with the box's own identity; the box's other snapshots then stay on its earlier guest, to fork only.

### Restores made outside BB Box

BB Box reads Proxmox's task list at each sweep. A rollback of one of its boxes that BB Box did not make, such as `pct rollback` on the host, is logged in the box's log by how it ended: done, failed, or still running, which it looks at again at the next sweep. After one that ended well, BB Box reads the box's size back, writes its labels again, and when it runs, its access file, and starts its BB machine again. A change in a box's snapshots without such a task is not taken for a restore.

### If BB Box restarts during a restore

Each step is recorded before it runs, with Proxmox's task once it begins. When BB Box starts again, it finishes the restore from the step it reached, or puts the box back as it was if it never got past the stop. When it cannot tell how a step ended, such as a rollback whose task it cannot read, it keeps the snapshots the restore uses, leaves the box as the restore left it, refuses to start it, and checks again at each sweep. `bb box sweep` checks at once, and `bb box doctor` names such a restore.

## When a box is released

A box's snapshots go with it when it is released: Proxmox deletes them with the guest. The box's log says so for each one.

## If BB Box restarts

Each take, delete and restore is recorded before it starts, with the backend's task once it begins. A restore's own steps are above. If BB Box restarts in the middle of one, it reads the backend's task and the box's snapshots when it starts again, and finishes or settles it: a take is ready only if the backend shows it complete, and a take that never began is failed, never taken again.

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
