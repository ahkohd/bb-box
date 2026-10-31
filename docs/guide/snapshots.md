# Snapshots

A snapshot keeps a box's state at one moment, so you can put the box back to it later. BB Box keeps its own record of each snapshot, and the box's backend keeps the snapshot itself, on the box's host.

You take, restore, rename and delete snapshots on a box's page, in its [Snapshots card](#on-a-boxs-page), or from the command line, and a thread's agent does with its tools, on Proxmox LXC boxes and Proxmox QEMU Linux boxes. Forking a new box from one and keeping one after its box is released come later: see [decision 070](../decisions/070-snapshots.md).

## What each backend offers

| Backend | Holds | While the box runs | Restores |
| --- | --- | --- | --- |
| Proxmox LXC | the disk | taken live, in about a second | in place, to any snapshot, on LVM-thin, Ceph RBD and BTRFS |
| Proxmox QEMU, Linux | the disk, or the disk and memory | taken live; with memory about a second for each GiB of memory | as Proxmox LXC, and qcow2 disks on a directory |
| Every other backend | no snapshots yet | | |

A Proxmox snapshot needs storage that takes them: LVM-thin, ZFS, Ceph RBD, BTRFS, or qcow2 disks on a directory for VMs. It also needs the token's `VM.Snapshot` right. `bb box doctor` says whether both are so, in its Snapshots check.

## On a box's page

A box's page has a Snapshots card, after its activity and before its facts. Its heading says how many snapshots the box holds of how many it may, its undos apart, what they hold and on which host. Each row has the snapshot's name, a badge for Memory, Kept or Undo, when it was taken and by whom, its size, its note, and a small picture of the box's screen when the box has one. On a desktop, a row's Restore button and its menu show when the pointer is over the row or focus is in it; on a narrow or touch screen they always show.

- **Take snapshot**, in the card or in the menu of the page's heading beside Resize…, asks for a name (the time if you leave it empty), a note, and on a VM that can, "With its memory". It says what the snapshot holds and leaves out, how long it takes, the count after it, whether a picture is kept, and what it costs. When the box's backend would refuse a take now, the card says why, with the fix, and Take snapshot is off.
- **Restore** opens a dialog that reads what the restore would do and end, live. It says when the box goes back to and what goes, and names each thread on the box, a person holding its desktop and each BB terminal open on it. A box with a thread on it is not restored, as on the command line: the dialog names the threads and says why. A person's control of the desktop or a terminal is named under "Also goes", and the button says "Restore (box) anyway". The undo is ticked: untick it and the button turns red and says "Restore without undo". When no undo can be taken, for room or the ceiling, the dialog says why and leaves it unticked. The restore goes on only past what the dialog showed: if a thread, a terminal or the person's control has come since, or the plan changed, BB Box restores nothing and the dialog reads it all again. If BB Box cannot flush the box's writes before stopping it (below), nothing changes and the dialog asks whether to restore anyway with an undo that may miss the last seconds' writes.
- **While it restores**, a notice at the top of the page says so and follows each part: the stop, the undo, the rollback and the start. After it, a notice says when the box was restored, to what, and by whom, for 24 hours. Its **Undo…** opens the same dialog for the restore's undo. A restore BB Box could not confirm after a restart has its own notice, with **Check now**, which settles it as the sweep does.
- **Rename…**, **Note…**, **Copy ID** and **Delete…** are in each row's menu. A name is at most 60 characters and unique on the box; a note at most 1 KB. Delete says what it frees, whether you kept it, and whether it is a restore's undo. A snapshot a restore uses cannot be renamed, noted or deleted until the restore ends.

Every dialog starts on its safe choice, Cancel for Restore and Delete, the name for Take snapshot and Rename, and gives focus back to the button that opened it, or to the menu's button.

### Pictures

With each snapshot of a box that has a screen, a desktop or a device, BB Box keeps a picture of the screen as it was taken: a JPEG at most 320 px on its longest side. A desktop's picture comes from its computer-use driver, also while you hold the desktop; a device's from its device server. It waits at most 2 s, and a picture that fails or is late never fails or slows the snapshot. A restore's undo has a picture from before the box stops. Pictures are kept in `snapshots.db`, never on the provider or in the box, and go with their snapshot; past 48 MB, the oldest pictures of snapshots nobody kept go first. Only you see them on the page. Settings, Snapshots, "Keep a picture of the screen with each snapshot" turns them off.

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

If a task such as a backup is running on the box's guest, a take or a delete is refused until it ends: an agent is told to try again later. If Proxmox left the guest locked with no task running, as when a task on it was stopped part way, it is refused with the command to run on the host, such as `pct unlock 214`. Only root on the host can unlock a guest.

## A copy of a box gives up its identity

A Linux box can tell when it is a copy of another box, such as a Proxmox clone. When it is, it gives up the identity it copied before its network starts. This is off until you turn it on for a backend, as below.

### How it works

When a box is first ready, BB Box writes an identity marker in it, `/etc/bb-box/identity`. It holds the box's ID and the MAC addresses of the network cards its backend gives it. On Docker it holds a value BB Box sets on the box instead, as Docker gives a container new MAC addresses at each start.

At each start, before its network, SSH, Tailscale, Docker, its desktop and BB's daemon start, the box compares the marker with what it has:

- if any of the marker's MAC addresses is on any of its cards, it keeps its identity, and adds its current cards to the marker: so a card added, then the first card removed, changes nothing
- if its cards are all known, and it has a new card but none of the marker's, it is a copy, and it resets
- if it cannot tell, as when its card has not appeared after 30 seconds, it removes nothing and starts its network, its desktop and logins, but SSH, Tailscale and BB's daemon wait while it keeps looking; once a card appears, it decides as above

A card is one the backend gave the box, as the kernel reports it. On Proxmox LXC it is a veth whose other end is outside the box, on no bridge, named `eth` and a number; on a VM, one with a device. Interfaces the box makes itself, such as Docker's and Tailscale's, bridges and tunnels, are never cards, whatever their names. An LXC card renamed from `eth` is no card either, so the box waits, as above, until it has its name again. Cards join the marker only as the box starts, before its own software makes interfaces again.

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

## Agents' snapshots

A thread's agent has four tools:

| Tool | Does |
| --- | --- |
| `box_snapshot` | takes one of a box, with a name and a note, and with its memory where its backend can |
| `box_snapshots` | lists a box's, or every box's of the thread and of the machine it runs on, that the thread may see |
| `box_snapshot_delete` | deletes one that an agent of the thread took and nobody kept |
| `box_restore` | restores a box, always taking an undo first |

Its skill tells it to take one before a change it cannot undo, such as a migration, an upgrade, a deletion or a change to the system, and when you ask; never on a schedule of its own; to restore when an attempt went wrong rather than undo it by hand; and to delete its own when they are no longer needed.

What an agent may do follows the box:

- **Its thread's own box**, one no thread runs on: it takes snapshots, sees and restores all of the box's, and deletes those an agent of its thread took. It restores without asking you, always with an undo; it cannot restore without one, nor past a person holding the desktop or a BB terminal open on the box, whether it asks through the form or not.
- **A box threads run on**: the box its thread runs on, another thread's box it runs on, or one of your machines. It takes snapshots there, and sees and deletes only what it took there. It restores the box only on a yes given in the thread, through a form (below), and only once such restores are on.
- **A kept snapshot** is yours: an agent sees it while its box lives, and nothing more.

No thread sees another thread's snapshots. A refusal for the limit names only the snapshots the agent may see, and says how many others there are.

When an agent's take would pass the limit per box, BB Box deletes the oldest snapshot an agent of the same thread took and nobody kept, once the new one is ready. On a box threads share, it never deletes another thread's. When none qualifies, the take is refused, naming what to delete. Your own take past the limit is always refused.

A take or a restore refused only for now, as for a host's storage too full or a backup holding the guest, tells the agent to try again later.

### The form: a yes given in the thread

`box_restore` opens a form in the thread instead of restoring when the box is one threads run on, or when Settings turn "Agents may restore their own boxes" off. The agent gets a notice at once and ends its turn. The form says what the restore replaces, what else goes (each thread on the box, with its worktree, uncommitted files and session there; your control of its desktop; open terminals), the size the box goes back to, and the undo, which is always taken. On a box the asking thread runs on, it says that thread's session goes back too.

- **Restore** runs the restore as BB Box's own work, not under the agent's call. It first holds every new turn on the box, waits up to a minute for turns there to end, then checks again what the restore would do. If anything changed since the form, such as a new thread, a terminal or a new snapshot of the box, it restores nothing and asks again with the new list. The result, a refusal included, reaches the thread as a message, which starts its next turn.
- **Cancel**, no answer within 10 minutes, a stop of the thread and a restart of BB's server each restore nothing.

BB Box cannot tell who answers a form: BB's command line can answer one too (`bb thread interactions respond`), and any agent of the thread can run it. So the form, its answer and the box's log say "on a yes given in (thread)", never that you said yes. The skill tells agents never to answer BB Box's forms.

### Restores of a box threads run on stay off

A restore of a box threads run on replaces their working disk, so no turn may start on it while it runs. BB Box holds every turn for a thread on the box, with BB's `message.dispatch` hook, from the yes until the box is ready, and asks BB to send them after. It checks for a running turn before the stop, again just after it, and before the rollback, and stops the restore with nothing on the disk changed if it finds one.

BB's "Send now" passes that hold, and a check is not at the same instant as the step after it. A live check found that a turn sent between BB Box's last check and its stop does start, and the stop interrupts it; BB Box then finds it, starts the box again and restores nothing. So these restores stay off, by the form, by the page and on the command line, until BB can hold a machine against "Send now". Until then, move the threads off a box, or archive them, before you restore it.

## Restoring a box

```
bb box snapshot restore <box> <snapshot> --replace [--no-undo] [--force] [--unflushed]
```

A restore puts the box's disk back as it was when the snapshot was taken. Everything on its disk since then goes: files, installed apps and settings. The box restarts, so every process in it ends, unless the snapshot holds its memory, when it comes back running as it was then, with the credentials its apps held then. What the box did to the world since, such as a push or an upload, stays done. The command asks for `--replace` so that none of this happens by a slip.

In order, BB Box:

1. Checks the snapshot and the box: the snapshot must be ready and on the box's current guest, and Proxmox must not have the guest locked.
2. Checks what the box would lose. A restore of a box that a thread runs on, working or idle, is refused: it would take the thread's worktree, its uncommitted files and its session with it, and such restores stay off until BB Box can hold every turn on the box while it restores. Move the threads off it, or archive them, first. A person holding the box's desktop, or a BB terminal open on it, refuses the restore too, unless you give `--force`.
3. Checks that its undo fits: the room on the host's storage, and on a paid provider the ceiling, before anything stops.
4. With an undo to take, flushes the box's writes to its disk, with `sync` in the box (Write-VolumeCache on Windows), for at most 15 s, getting into the box included: a VM's hard stop drops what it has not written yet. If that fails, BB Box restores nothing and says why, unless you give `--unflushed`, when it goes on and the undo, the box log and the answer say the undo may miss the last seconds' writes. An agent cannot give it.
5. Reads again what the box would lose, after the flush, and refuses if a thread now runs on it, or if more would go than `--force` covered. Then it stops the box at once, without a clean shutdown.
6. Takes the undo: a snapshot of the stopped box, named "before the restore at 01:56", so nothing written before the stop is lost. Without `--no-undo` a restore always takes one, and if it cannot, BB Box starts the box again as it was and restores nothing.
7. Reads what the box would lose once more, then rolls the box back, and starts it.
8. Reads the box's size back. A snapshot holds the box's cores, memory and disk as they were then, so a box resized since goes back to its size then, and the answer says so.
9. Writes the box's access file from the thread's access now, as the first command once the box answers, before any other command of BB Box's and before BB's daemon starts again: the restored disk holds the file as it was then. Then it writes the box's labels on Proxmox again, and starts its BB machine again, as a start does.

Undos are counted apart from the snapshots per box: a box keeps 2. Once a restore is done, its undo replaces the oldest one that is not kept and not the restore's own target. To undo a restore, restore its undo.

`--check` says what a restore would do, with its undo, the size the box goes back to, what it would end and the undo it would replace, and refuses what the restore would refuse. It changes nothing. While a restore runs, or one BB Box could not confirm holds the box, BB Box takes no snapshot of it, and refuses to start, stop or resize it.

A restore takes a few seconds. Measured on Proxmox LXC on LVM-thin, a box of 16 GiB: about 4 s, of which the stop takes about a second, the undo and the rollback under a second each, and the start about 2 s. When the snapshot was taken while the container ran, Proxmox's own start takes about 45 s instead, and BB Box waits for it.

### ZFS

ZFS rolls a disk back only to its newest snapshot. BB Box restores nothing on ZFS yet: it says so, and changes nothing. Its restores there come once they are checked on a ZFS node. They will take a held copy of the stopped box as the undo, a full copy that cannot start, made only of a box whose [identity reset](#a-copy-of-a-box-gives-up-its-identity) works; undoing such a restore makes the box a new guest from that copy, with the box's own identity, and the box's other snapshots then stay on its earlier guest, to fork only. Until then, restoring a held copy works only in BB Box's live checks.

### Restores made outside BB Box

BB Box reads Proxmox's task list at each sweep. A rollback of one of its boxes that BB Box did not make, such as `pct rollback` on the host, is logged in the box's log by how it ended: done, failed, or still running, which it looks at again at the next sweep. After one that ended well, BB Box reads the box's size back, writes its labels again, and when it runs, its access file, and starts its BB machine again. A change in a box's snapshots without such a task is not taken for a restore.

### If BB Box restarts during a restore

Each step is recorded before it runs, with Proxmox's task once it begins. When BB Box starts again, it finishes the restore from the step it reached, or puts the box back as it was if it never got past the stop. When it cannot tell how a step ended, such as a rollback whose task it cannot read or that still runs, it keeps the snapshots the restore uses, leaves the box as the restore left it, refuses to start it, and checks again at each sweep. `bb box sweep` checks at once, and `bb box doctor` names such a restore.

## When a box is released

A box's snapshots go with it when it is released: Proxmox deletes them with the guest. The box's log says so for each one.

## If BB Box restarts

Each take, delete and restore is recorded before it starts, with the backend's task once it begins. A restore's own steps are above. If BB Box restarts in the middle of one, it reads the backend's task and the box's snapshots when it starts again, and finishes or settles it: a take is ready only if the backend shows it complete, and a take that never began is failed, never taken again.

BB Box also compares its records with each backend's snapshots every few minutes. A snapshot BB Box has no record of gets one again, so a lost `snapshots.db` loses no snapshot. One of a box that is gone is listed as found on its host for 7 days, then deleted, unless it carries a keep date.

## Settings

BB Box's settings have a Snapshots page, under Options. Its fields wait for Save, as other fields do; its switch saves at once.

| Setting | Default | Range | What it does |
| --- | --- | --- | --- |
| Snapshots per box | 5 | 1 to 50 | A take past it is refused, naming the snapshots to delete. Kept ones count; undos are counted apart, 2 a box. |
| Refuse new snapshots when a host's storage is past | 85% full | 50 to 90 | A take is refused past it, and past 5 points below it of a thin pool's metadata. 7 points above it, BB Box deletes agents' snapshots on that storage that nobody kept, oldest first, and logs why. |
| A ceiling on paid snapshots, one per backend that charges | 5 a month, in the provider's currency | 0 to 1,000 | A take that would bring the monthly rate held on that backend past it is refused. |
| Agents may restore their own boxes | on | | Off, an agent asks for a yes in its thread through the form before it restores any box. A box threads run on always needs that yes. A switch, saved at once. |
| Agents may restore memory snapshots | on | | Off, only you restore a snapshot that holds a box's memory. A switch, saved at once. |
| Keep a picture of the screen with each snapshot | on | | A switch, saved at once. Off, a snapshot has no picture. |

The page also says what each backend's snapshots hold and cost, and what its last check found of its storage.

From a terminal, `bb box option set` changes each of them: `general.snapshots.perBox=3`, `general.snapshots.roomPercent=80`, `general.snapshots.agentsRestore=false`, `general.snapshots.agentsMemory=false`, and a backend's ceiling as `general.snapshots.ceilings.<backend>=7.50`, with the backend's ID from `bb box config show`. `bb box option unset` gives each back its default.

### Paid snapshots

The ceiling bounds the monthly rate of what is held, not the bill. The rate is every paid snapshot the provider holds, kept or not, times its daily price, times 30. A take is refused when the rate would pass the ceiling after it, with the words "It would bring snapshots held on (backend) to about $5.04 a month, past your ceiling of $5.00". When the rate is past the ceiling for another reason, such as a lower ceiling, the page warns, new paid snapshots are refused, and BB Box deletes none of them. Beside each ceiling, the page shows the rate held and what was spent this month, deleted snapshots included. A price BB Box does not know is shown as unknown, and only you can take a snapshot there.

No backend charges for snapshots yet, so the page says "None of your backends charges for snapshots".

## Removing a backend

A backend that holds snapshots cannot be removed from the settings while BB Box records them. Delete them first, or forget them:

```
bb box snapshot forget <backend> --yes
```

Forgetting removes BB Box's records only. The snapshots may still exist on the backend, and be billed there.
