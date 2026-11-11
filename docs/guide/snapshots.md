# Snapshots

A snapshot keeps a box's state at one moment, so you can put the box back to it later. BB Box keeps its own record of each snapshot, and the box's backend keeps the snapshot itself, on the box's host.

You take, restore, rename and delete snapshots on a box's page, in its [Snapshots card](#on-a-boxs-page), on the Boxes page's [Snapshots tab](#the-snapshots-tab), or from the command line, and a thread's agent does with its tools. Where the backend allows it, you [fork](#forking-a-snapshot) a snapshot into a new box and [keep](#keeping-a-snapshot) one past the box's release. Docker boxes take, list, restore, fork, keep and delete snapshots. Hetzner Cloud's Linux boxes take, restore, fork and delete them on their host, and Namespace's Linux boxes take, restore and delete them on their machine. This works on Docker boxes, Hetzner Cloud and Namespace Linux boxes, Proxmox LXC boxes, Proxmox QEMU Linux boxes, Proxmox QEMU Windows desktops and Android boxes, microsandbox boxes, Tart's macOS, Linux and Windows VMs, iOS boxes in a VM of their own on Tart, and boat.dev boxes on a paid plan. Only you keep one.

## What each backend offers

| Backend | Holds | While the box runs | Restores | Forks | Keeps past a release |
| --- | --- | --- | --- | --- | --- |
| Proxmox LXC | the disk | taken live, in about a second: Proxmox freezes the container while it snapshots its disk | in place, to any snapshot, on LVM-thin, Ceph RBD and BTRFS; on [ZFS](#zfs), to the newest snapshot only, with a held copy as the undo | by a full copy, from a snapshot taken with a working identity reset | by a [held copy](#a-held-copy), of a snapshot that could fork |
| Proxmox QEMU, Linux | the disk, or the disk and memory | taken while it runs: Proxmox stops the VM while it snapshots its disks; with memory, about a second for each GiB of memory | as Proxmox LXC, and qcow2 disks on a directory, but not on ZFS yet | as Proxmox LXC, from the disk only | as Proxmox LXC, the disk only |
| Proxmox QEMU, Windows | the disk, with its EFI and TPM state volumes | taken while it runs, in about 6 to 7 seconds, most of it flushing Windows' writes: Proxmox stops the VM while it snapshots its disks | in place, with a snapshot as the undo, on LVM-thin, Ceph RBD, BTRFS and qcow2 disks. On ZFS, restore is refused: the undo would be a held copy, and a Windows box has no identity reset BB Box has checked | none, for the same reason | none, for the same reason |
| boat.dev, a paid plan | the disk, as a saved snapshot on your boat.dev account | taken live, after a fresh capture, a minute or more | by a new sandbox made from the snapshot, which runs the box with its ID, name and labels; the old sandbox is deleted | by a new sandbox made from the snapshot, from a snapshot taken with reset version 8 for Linux servers, or version 9 for Linux desktops | as it is, on the account, at boat.dev's daily price past the plan's included ones |
| boat.dev, the free trial | no snapshots: the trial has no saved snapshots | | | | |
| microsandbox | the disk, with the box's Docker data, or the disk and memory | in under a second, pausing the box while `msb` captures its disk; with memory, the box pauses for about a second | by a new microVM made from the snapshot, which runs the box with its ID, name and labels; the old microVM is deleted | by a new microVM booted from the snapshot's disk, never its memory, from a snapshot taken with a working identity reset | as it is: a snapshot outlives its box's microVM, on the host |
| Tart, macOS | the disk and memory, always: every snapshot is a copy of the suspended VM | suspends the VM, copies it and resumes it: 11 s for a 16 GiB VM | in place: it suspends the box, takes the undo, puts the snapshot's copy in the VM's place and resumes it, running as it was | by a copy of the snapshot's disk, without its memory, from a snapshot taken with macOS's identity reset | as it is: the copy stays beside the VMs |
| Tart, iOS in a VM of its own | as Tart, macOS: the VM's disk and memory, with the Simulator and its device as they were | as Tart, macOS | as Tart, macOS: the device comes back booted, with its apps open and its data as they were | as Tart, macOS: the fork boots its device afresh, with the snapshot's apps and data | as Tart, macOS |
| Tart, Linux | the disk | only while the box is stopped, as Tart cannot suspend a Linux VM | in place, after a shutdown | by a copy of the snapshot's disk, from a snapshot taken with reset version 8 for Linux servers, or version 9 for Linux desktops | as it is: the copy stays beside the VMs |
| Tart, Windows | the disk: its overlay on the Windows image, its UEFI variables and its QEMU settings | Windows shuts down for the copy and starts afresh after it: a take of a running 8 GiB box took 17 to 20 s on an Apple M4 Max; a stopped box with its memory saved starts from that memory, shuts down for the copy and stays stopped | in place, after a shutdown, with a snapshot as the undo: Windows starts afresh, never from saved memory | none: Windows has no identity reset | none, for the same reason |
| Docker | the disk and the box's Docker data | pauses the box; measured pauses range from 3.5 to 4.9 seconds on small overlay2 boxes to about 45 seconds for a 1.8 GB change on containerd | by a new container made from the snapshot, with a snapshot as the undo, which runs the box with its ID, name and labels; the old container is deleted once the new one runs | by a new container made from the snapshot, with the fork's own ID as its identity value, held until BB Box's check passes, from a snapshot taken with reset version 7 for Linux servers, or version 9 for Linux desktops, of a box made from an image built with the hold | as it is: a kept snapshot stays on the box's Docker engine, as its image, its copy of the Docker data and a keep tag |
| Hetzner Cloud, Linux | as Docker, on the box's [host](#hetzner-cloud-and-namespace) | as Docker | as Docker, on the same host | as Docker, on the same host, refused before anything is made when the host has no room | none: a release deletes the box's snapshots, and BB Box never keeps a host running to hold one |
| Namespace, Linux | as Docker, on the box's [machine](#hetzner-cloud-and-namespace) | as Docker; refused when the machine would end first | as Docker, on the same machine; refused when the machine would end first | none yet: a fork needs a machine of its own, and BB Box cannot carry a snapshot to one yet | none: the snapshots end with the machine, at the box's release or the machine's deadline |
| SSH host pool, a Mac lent whole | the box user's [home folder](#the-ssh-host-pools-macs), with its files, settings, keychain and browser profiles | pauses the box user's processes while APFS clones the home: about 0.3 s for 20,000 files, about 4 s for 220,000 | in place: BB Box ends the box user's session, takes the undo, puts a clone of the snapshot in the home's place and signs the user in again where it was signed in | none yet: a fork's new box user would need a userspace restart to be signed in, which ends its source's session | none: the snapshot lives on the Mac, which BB Box lends to the next box after the release |
| Namespace's Macs, the SSH host pool's Linux machines and iOS slots, iOS boxes in a slot on a shared host | no snapshots yet: see [what is not built yet](#what-is-not-built-yet) | | | | |

Linux desktops need an image built with identity reset version 9 or later. Older images refuse forks and Keep, saying why. Refresh the image and make the box again; an image rebuild does not update existing boxes or snapshots.

A microsandbox box takes snapshots only when its Docker disk is `msb`'s own, as on every box BB Box makes now. A box an earlier BB Box made keeps its Docker data on a file of the host's, which `msb` leaves out of a snapshot and cannot give a restored box, so its Snapshots say why it takes none; it works as before otherwise. BB Box takes them only with `msb` 0.7.7, the release whose snapshots it measured on Linux hosts and on a Mac. `bb box doctor` says so in its microsandbox Snapshots check. Each snapshot of a microsandbox box lists the one it was taken after ("after ..."), as `msb` keeps a box's snapshots in a chain; each holds its own data, so any of them can be deleted first.

### The SSH host pool's Macs

A box lent a pool Mac whole is a macOS user, so its snapshots hold its home folder, `/Users/<box user>`: its files, settings, login keychain, browser profiles, and its Simulator devices and their data. They do not hold apps installed on the Mac, files outside the home, the user's temporary and cache folders in `/private/var/folders`, the Mac's own grants to the box, or anything running. Each snapshot is an APFS clone of the home, kept on the Mac in a folder only root can read, `/var/db/bb-box/home-snapshots`, with the home's access control lists beside it, as a clone drops them. A clone takes almost no space at first and grows as the home changes.

A take pauses every running process of the box user while it clones the home, so the snapshot is one moment of the home: about 0.3 s for a home of 20,000 files, and about 4 s for 220,000. It then resumes only the processes it paused, so one you stopped yourself stays stopped. The plan says how long the box's last take paused it.

A restore ends the box user's session first: it clears the Mac's automatic login, so the Mac does not sign the user in again in the middle, shuts down its Simulators and ends every process of the user. Then it takes the undo, puts a clone of the snapshot in the home's place with its access control lists, deletes the home it replaced and clears the user's temporary and cache folders. A box user that was signed in at the console is signed in again, so its desktop and its apps' services start again: viewers lose the desktop for a few seconds. If restarting the login window does not sign the user in within 30 s, the Mac restarts userspace, which ends every SSH session on it and takes about 20 s more. If BB Box or the Mac's helper stops in the middle, BB Box asks again and the helper finishes the same restore: a home moved aside with its restored clone ready is put in place, never left missing.

A release deletes the box's snapshots, and the Mac's reset refuses to lend the Mac again while any snapshot of an earlier box is left. Snapshots stay off for:

- A box in an iOS slot on a pool Mac: its take is refused with the reason, until slots take snapshots.
- A Mac whose helper is older than version 3: the refusal says to run `setup-mac.sh` on it again.
- Forks: a fork would be a new box user beside its source on the same Mac, and signing a new user in needs a userspace restart there, which ends the source box's session and every SSH session on the Mac. The Mac's helper can already make such a user from a snapshot, and its proof checks it, but BB Box refuses forks with that reason until a later change signs a fork's user in without the restart.
- Keep: the snapshot lives on the Mac, which BB Box lends to the next box after the release.

### Tart

A Tart snapshot is an APFS clone of the VM's folder, kept beside the VMs, in `bb-box-snapshots` next to Tart's `vms` folder. A clone takes a moment and no space, and grows only as the box and its copy differ. BB Box copies only by cloning, with APFS's `clonefile`, and refuses a copy APFS cannot clone, rather than make a full copy of the whole VM: so it refuses when that folder is on another volume than the VMs. Before it suspends or stops anything, it also refuses while the volume has less free than the Mac's disk kept free, `reserve-disk-gib` (50 GiB unless set), or 20 GiB, whichever is more. A label file in each copy names the install, the box, the snapshot and its keep date.

A macOS snapshot holds the VM's saved memory, and Virtualization restores a saved state only under the macOS build and Tart that saved it. So at each suspend BB Box notes beside the VM the macOS build and Tart it was saved under, and each snapshot's label carries that note. After the Mac's macOS or Tart changes, BB Box does not restore a snapshot saved before, nor one whose memory has no such note, and says to fork it instead, which starts from its disk. The start just after a restore never boots the box from its disk when the snapshot's memory does not resume: it fails and says so, and a later start does.

A restore copies the snapshot beside the VM, then swaps it into the VM's place in two renames. It records each phase on the Mac first, with its shell's process and start time, and each restore has its own record. If BB Box or the Mac stops in the middle, the next look at the box, its start, or its release puts the right folder back: the snapshot's whole copy once it was in place, the VM's own folder otherwise, never neither. While a restore still runs, the box is neither started nor deleted. A release also deletes what a restore or a fork cut short left beside the VMs.

A Windows box on Tart runs in QEMU, not Tart, and its disk is an overlay on a build of the Windows image. Its snapshot copies, by the same APFS clones and into the same folder, only the overlay, the UEFI variables and the VM's QEMU settings: never QEMU's saved memory, its process files or its sockets. BB Box copies them only once Windows has shut down, so the disk is as Windows leaves it at a shutdown. It asks Windows to shut down, and presses QEMU's ACPI power button when Windows cannot be reached. If Windows does not shut down within 2 minutes, BB Box takes no snapshot and starts the box again. An ordinary Stop saves a Windows box's memory, so a take or restore of a stopped box first starts it from that memory and shuts Windows down. The box stays stopped, and its next start boots Windows afresh: apps that were open are closed.

A Windows snapshot stands on the build of the Windows image its box was made from, and its label names that image and build. An image refresh keeps a build while a box or a snapshot stands on it, even when a restore was cut short, so an old build stays on the Mac until its snapshots are deleted or its box is released. When it cannot read which build a box or snapshot on the Mac stands on, it keeps every build and says so. Restores and image refreshes on one Mac take turns, so one may wait for another. It waits about a minute at most, then refuses and changes nothing: try it again once the other has ended. If the build a snapshot stands on is gone anyway, removed outside BB Box, BB Box refuses to restore it and says which build it needs; delete the snapshot. A restore cut short whose snapshot's build has gone puts the box's own disk back and says why. A restore keeps the VM's ports on the Mac, puts the snapshot's disk, UEFI variables and size in place, leaves no saved memory behind, and boots Windows afresh. Restores record their phases, and are put right after a restart, as a macOS VM's are. Windows has no identity reset, so its snapshots do not fork, and Keep is refused.

An iOS box in a VM of its own, with `dedicated`, is a macOS VM that runs the iOS Simulator, so its snapshots are a macOS VM's. A restore brings the device back booted, with the apps that were open and their data. The device a snapshot was taken on comes back with it: restore a snapshot taken before you switched device, and the box shows the device it had then, with that device's own apps and data. Its undo brings back the device you had switched to. A fork, or a Keep of a box that was released, boots its device afresh from the snapshot's disk, with the snapshot's apps and data but none of them open. An iOS box in a slot on a shared iOS host takes no snapshots.

### Proxmox

A Proxmox snapshot needs storage that takes them: LVM-thin, ZFS, Ceph RBD, BTRFS, or qcow2 disks on a directory for VMs. It also needs the token's `VM.Snapshot` right. `bb box doctor` says whether both are so, in its Snapshots check.

A Windows desktop's snapshot holds its disk and its EFI and TPM state volumes. It restores in place, and the undo is another snapshot, on storage that rolls back past a newer snapshot. On ZFS it takes and deletes snapshots, and restore is refused, because the undo would be a held copy and a Windows box has no identity reset BB Box has checked. It does not fork, and Keep is refused for the same reason. It takes no snapshot of its memory.

An Android box on Proxmox QEMU snapshots the whole VM disk, including the Linux host files and Android device data, while it runs. It restores in place with a snapshot undo on LVM-thin, Ceph RBD, BTRFS and qcow2. On ZFS, take and delete work but restore is refused. Memory snapshots, forks and Keep are refused. The Android device and its host have no identity reset BB Box has checked. Device-only snapshots are separate and remain unbuilt.

BB Box starts an Android model cold when its unsaved marker is present. A snapshot taken while that model runs keeps the marker, as does an undo taken after a hard stop. A clean emulator save removes the marker, so a matching quick-boot save can still load after a host restart. New boxes can use the image's quick-boot saves. Wait for Android to finish booting before running adb commands.

### Hetzner Cloud and Namespace

A Hetzner Cloud or Namespace Linux box is a container on a Docker engine, so its snapshots are Docker's: the box pauses while BB Box copies its disk and Docker data, and the take says for about how long first. They hold no memory or running programs. Each snapshot stays on the engine that runs the box, and its size counts against that engine's disk. BB Box's room check before a take reads that disk, with every snapshot already on it.

On Hetzner Cloud, the snapshots stay on the box's host, which may hold other boxes too. A restore makes the new container on that host. A fork goes on the same host, and is refused, saying why, before anything is made, when the host has too little memory, too few cores or too little Docker disk for it. Releasing the box deletes its snapshots. A host is idle only once no box lives on it, so snapshots never keep a host running past its idle time, and never stop it either: they belong to a box, and a host with a box on it is not idle. Snapshots cost nothing beyond the host you already pay for.

On Namespace, the snapshots stay on the box's machine and end with it, at the box's release or at the machine's deadline, the plan's longest life. The time it ends is shown where a take or restore says where its snapshots go. A take or a restore that would end after the machine is refused, and says when the machine ends. A restore makes the new container on the same machine, and keeps the machine. Forks are off, as a fork needs a machine of its own and BB Box cannot carry a snapshot from one machine to another yet. Snapshots cost nothing beyond the machine.

Keep is off on both, and says why: a kept snapshot could not outlive its box there yet. BB Box asks a host or machine about snapshots only once one of its boxes has taken one, so hosts and machines whose boxes take none work as before.

### What is not built yet

- **Restores of a box threads run on stay off.** BB cannot yet hold every turn on a box: its "Send now" can start a turn while BB Box stops the box to restore it. Until BB can, move the threads off the box, or archive them, before you restore it. You and agents can restore every other box. See [restores of a box threads run on stay off](#restores-of-a-box-threads-run-on-stay-off).
- **A copy made outside BB Box can keep its source's identity.** BB Box's own forks always give it up. On Docker, microsandbox and boat.dev, a box's identity is a value BB Box sets, and a copy made with the provider's own tools, such as a fork in boat.dev's dashboard, gets its source's value. So it does not reset, and comes up as its source: the same BB machine, tailnet node and thread's access. Copy a box only through BB Box.
- **The identity reset across a Proxmox node's restart is unproved.** Held copies and earlier guests were checked not to start by themselves, and an earlier guest started by hand reset before its network. But no node was restarted in the checks, so it is not known what they do when one is. Restart a node with a held copy on it, and check that the copy stays stopped, before you rely on Keep, or on a restore's held-copy undo on ZFS, there.
- **A Linux VM on Proxmox QEMU does not restore on ZFS yet**, until that is checked on a VM there. Proxmox LXC boxes restore on ZFS. Snapshots of VMs on ZFS are taken, deleted, forked and kept as elsewhere.
- **Hetzner Cloud and Namespace keep no snapshot past a release, and Namespace does not fork yet.** A Hetzner Cloud host is deleted when it is idle, and a Namespace machine at its box's release or deadline, so a kept snapshot would have to move somewhere else first. Carrying a snapshot to another engine, for Namespace forks and Hetzner forks to another host, comes first, then Keep on each.
- **An Android device's own snapshots are planned for later**: the emulator's snapshot of the device alone. Until then, Android boxes on boat.dev and Proxmox QEMU take snapshots of the whole VM.
- **A Windows desktop on Proxmox QEMU takes no snapshot of its memory yet**, and it does not fork or Keep until a Windows identity reset is checked. A restore on ZFS stays off for that reason.
- **A Windows box on Tart takes no snapshot of its memory**, and it does not fork or Keep until a Windows identity reset is checked.
- **iOS boxes in a slot on a Namespace or Tart shared host take no snapshots**, and none are planned yet. A shared iOS box there has no VM of its own to copy: a take, restore or fork of one is refused and says so. For now its Snapshots card and its status still say what Tart takes of an iOS box in a VM of its own, and Take snapshot gives the reason only when you try it.
- **On the SSH host pool, only Macs lent whole take snapshots so far, and they do not fork or Keep.** iOS slots on pool Macs come next, then Linux homes on btrfs, then machine snapshots by an operator's hook. Each machine says what it could offer, and `bb box doctor` shows each machine's report. A take on a box whose machine offers none is refused with that machine's reason, such as "for a home snapshot, ext4 under /home, which neither clones nor snapshots". A home snapshot will never hold what a box with root changes outside its home, so machines whose boxes have root (reset=machine) will offer machine snapshots only. [Decision 090](../decisions/090-pool-machines-say-whether-they-snapshot.md) has the design.

## On a box's page

A box's page has a Snapshots card, after its activity and before its facts. Its heading says how many snapshots the box holds of how many it may, its undos apart, what they hold and on which host. Each row has the snapshot's name, a badge for Memory, Kept or Undo, when it was taken and by whom, its size, its note, and a small picture of the box's screen when the box has one. On a desktop, a row's Restore button and its menu show when the pointer is over the row or focus is in it; on a narrow or touch screen they always show.

- **Take snapshot**, in the card or in the menu of the page's heading beside Resize…, asks for a name (the time if you leave it empty), a note, and on a VM that can, "With its memory". It says what the snapshot holds and leaves out, how long it takes, whether it pauses the box and for about how long, the count after it, whether a picture is kept, and what it costs. When the box's backend would refuse a take now, the card says why, with the fix, and Take snapshot is off.
- **Restore** opens a dialog that reads what the restore would do and end, live. It says when the box goes back to and what goes, and names each thread on the box, a person holding its desktop and each BB terminal open on it. A box with a thread on it is not restored, as on the command line: the dialog names the threads and says why. A person's control of the desktop or a terminal is named under "Also goes", and the button says "Restore (box) anyway". The undo is ticked: untick it and the button turns red and says "Restore without undo". When no undo can be taken, for room or the ceiling, the dialog says why and leaves it unticked. The restore goes on only past what the dialog showed: if a thread, a terminal or the person's control has come since, or the plan changed, BB Box restores nothing and the dialog reads it all again. If BB Box cannot flush the box's writes before stopping it (below), nothing changes and the dialog asks whether to restore anyway with an undo that may miss the last seconds' writes.
- **While it restores**, a notice at the top of the page says so and follows each part: the stop, the undo, the rollback and the start. After it, a notice says when the box was restored, to what, and by whom, for 24 hours. Its **Undo…** opens the same dialog for the restore's undo. A restore BB Box could not confirm after a restart has its own notice, with **Check now**, which settles it as the sweep does.
- **Fork**, beside Restore, opens the [Fork dialog](#forking-a-snapshot). Below 640 px it is in the row's menu, as Fork…. It is off, with why, for a snapshot that cannot fork.
- **Keep…** is in each row's menu, below Note…: see [Keeping a snapshot](#keeping-a-snapshot). A kept snapshot's menu says **Keep 30 more days…** and **Stop keeping**.
- **Rename…**, **Note…**, **Copy ID** and **Delete…** are in each row's menu. A name is at most 60 characters and unique on the box; a note at most 1 KB. Delete says what it frees, whether you kept it, and whether it is a restore's undo. A snapshot a restore uses cannot be renamed, noted or deleted until the restore ends.

Every dialog starts on its safe choice, Cancel for Restore and Delete, the name for Take snapshot and Rename, and gives focus back to the button that opened it, or to the menu's button.

### Pictures

With each snapshot of a box that has a screen, a desktop or a device, BB Box keeps a picture of the screen as it was taken: a JPEG at most 320 px on its longest side. A desktop's picture comes from its computer-use driver, also while you hold the desktop; a device's from its device server. It waits at most 2 s, and a picture that fails or is late never fails or slows the snapshot. A restore's undo has a picture from before the box stops. Pictures are kept in `snapshots.db`, never on the provider or in the box, and go with their snapshot; past 48 MB, the oldest pictures of snapshots nobody kept go first. Only you see them on the page. Settings, Snapshots, "Keep a picture of the screen with each snapshot" turns them off.

## Taking a snapshot

```
bb box snapshot take <box> [--name <name>] [--note <text>] [--memory] [--check]
```

`--memory` holds the box's memory too, where its backend can: Proxmox QEMU can for a Linux box that runs, and cannot for a Windows desktop; Proxmox LXC cannot. A stopped Proxmox QEMU box is suspended to disk, so start it before you take a snapshot of it. Proxmox saves a VM's memory as a volume of twice its memory and 500 MiB more, on the VM's `vmstatestorage` or else on its disks' storage; BB Box checks that storage's room first, and refuses a memory snapshot when it cannot tell which storage Proxmox would use. Without `--name`, the snapshot is named after the time, such as "Thu 10:42". A name is unique on its box: a repeat gets " (2)".

Before it takes a snapshot of a box that runs, BB Box flushes the box's writes to its disk, with `sync` in the box, for at most 15 seconds, so the snapshot's disk holds what was just written, with or without memory. If the flush fails or takes longer, the snapshot is taken anyway, and it says it may miss the last writes: in the take's answer, in the list, on the page and in every fork of it.

The command waits until the backend confirms the snapshot is complete. A box holds 5 snapshots unless you change it in the settings (below). A take is refused when the host's storage is more than 85% full, or would be with the snapshot, or when its thin metadata is more than 80% full, as a full thin pool stops every box on the host. Both numbers follow the settings.

### How long a take pauses the box

Some backends pause a box while they take its snapshot: nothing in it runs until the take is done. `--check` says before the take whether it would pause the box and for about how long, with what that is based on, and takes nothing:

```
$ bb box snapshot take build-1 --check
A snapshot of box build-1 now would hold its disk, on Docker's disk, and take about 5 s.
Pauses build-1 for about 5 s while it copies 1.1 GB.
It adds up to 1.1 GB.
Nothing was taken. Run it again without --check to take it.
```

The Take snapshot dialog says the same before you take one. An agent's `box_snapshot` says it when called with `check`. After the take, its answer says how long the box was actually paused, such as "It paused build-1 for 4.1 s.", and the snapshot's row in the card says "paused 4.1 s". When a backend pauses a box for a time it cannot estimate or measure, it says so, and the row says "pause not measured".

| Backend | Pauses the box | Estimate based on | Measured |
| --- | --- | --- | --- |
| Docker | while it copies the box's changed disk and Docker data, when the box runs | the changed bytes and the Docker data's size, about 25 to 30 seconds a GiB for the disk and 15 for the Docker data, plus 4 seconds | from `docker pause` to `docker unpause` |
| microsandbox | while `msb` captures the box's disk, or its disk and memory, when the box runs | for a take with memory, the box's memory: about 1.5 seconds. No estimate for a disk-only take | the pause `msb`'s runtime logs, from pausing the microVM to resuming it. Unknown when the take added no such line to its log, or more than one |
| Tart, macOS | while it suspends the VM, copies it and resumes it, when the box runs | the VM's memory, which a suspend saves | from the suspend to when the VM runs again, before BB Box checks that it answers. Unknown when the VM does not resume |
| Proxmox LXC | while Proxmox freezes the container and snapshots its disk, when it runs | no estimate: Proxmox does not say | not measured |
| Proxmox QEMU | while Proxmox stops the VM to snapshot its disks, with or without memory, when it runs. With memory, it stops it at the end of saving its memory | no estimate: Proxmox does not say, and with memory it depends on how fast the VM changes its memory | not measured: Proxmox does not report how long the VM was stopped |
| boat.dev | never: boat.dev saves a sandbox while it runs | | |

A stopped box is never paused.

## Listing snapshots

```
bb box snapshot list [<box>] [--all] [--kept] [--json]
```

Without a box, it lists the snapshots of the thread's boxes. `--all` lists every snapshot BB Box records, of every thread's boxes and of boxes that are gone.

Each row says the snapshot's name and ID, its state, when it was taken and by whom, what it holds, and its size where the backend says. On a box's page, a row also says how long its take paused the box, where it did, or "pause not measured" where its backend could not measure it.

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

When a box is first ready, BB Box writes an identity marker in it, `/etc/bb-box/identity`. It holds the box's ID and the MAC addresses of the network cards its backend gives it. On Docker, microsandbox and boat.dev it holds a value BB Box sets on the box instead, the box's ID in `BBBOX_IDENTITY`, as Docker gives a container new MAC addresses at each start, and boat.dev a sandbox new ones on each machine it starts on. BB Box sets the box's own ID on every sandbox of the box, and a fork's own ID on the fork's, and boat.dev keeps it through a stop and start and a resize.

At each start, before its network, SSH, Tailscale, Docker, its desktop and BB's daemon start, the box compares the marker with what it has:

- if any of the marker's MAC addresses is on any of its cards, it keeps its identity, and adds its current cards to the marker: so a card added, then the first card removed, changes nothing
- if its cards are all known, and it has a new card but none of the marker's, it is a copy, and it resets
- if it cannot tell, as when its card has not appeared after 30 seconds, it removes nothing and starts its network, its desktop and logins, but SSH, Tailscale and BB's daemon wait while it keeps looking; once a card appears, it decides as above. On Proxmox LXC, a box that starts with no `eth` card and none of the marker's MAC addresses on any interface also sets its network settings for `eth` cards aside at once, before it waits, in `/var/lib/bb-box/held-network`. A card added later then gets its settings from Proxmox, never the ones a copy brought from its source. Once it decides, at this boot or a later one, a copy drops them, and the box itself gets them back unless Proxmox wrote new ones. If it cannot set them aside, it deletes them, as Proxmox writes a card's settings again when it adds the card; if it cannot delete them either, the network and everything after it stay off until the next start

A card is one the backend gave the box, as the kernel reports it. On Proxmox LXC it is a veth whose other end is outside the box, on no bridge, named `eth` and a number; on a VM, one with a device. Interfaces the box makes itself, such as Docker's and Tailscale's, bridges and tunnels, are never cards, whatever their names. An LXC card renamed from `eth` is no card either, so the box waits, as above, until it has its name again. Cards join the marker only as the box starts, before its own software makes interfaces again.

A reset removes what made the box its source:

- BB's machine credentials and host ID, so it joins BB as a new machine
- the thread's access file, `~/.config/bb-box/env`
- its Tailscale node
- its SSH host keys and machine ID, which it makes again; on boat.dev it leaves both to boat.dev, which gives every machine its own and tells BB Box the host key to expect

The rest of its disk stays, threads' files included. A restart, a resize, a rename and a spare given to a thread change nothing.

A reset writes down what it will remove before it removes anything, in `/var/lib/bb-box/identity-reset-pending`. If it cannot finish, the box keeps its network, SSH, Docker, its desktop and BB's daemon off, and the next start finishes it. `/var/lib/bb-box/identity-resets` lists each reset, with why and the BB machines it removed.

### If one of BB Box's own boxes resets

A box of BB Box's own should never reset. If one does, BB Box keeps it: it removes the box's old machine from BB, so its credentials stop working, waits until BB confirms that, and enrols the box again as a new BB machine. This is so for your machines too, which BB Box would otherwise release when BB removes their machine. The box's log says so, and `bb box doctor` names the box under Identity resets.

A box that is a thread's own machine, made by New box, is the exception: BB Box never removes that machine, as that would release the box with the thread's worktree. The doctor names the box and its thread instead.

If BB removes a machine while its box does not answer, BB Box keeps the box until it answers, then reads whether it reset, and decides.

A copy made outside BB Box that resets is not one of its boxes, so it stays out of BB. One whose identity is a value BB Box sets may not reset at all: see [what is not built yet](#what-is-not-built-yet).

### On boat.dev

A boat.dev sandbox starts on a machine that already runs boat.dev's own image, and boat.dev lays the sandbox's own files over it once it answers. So the check cannot run before the network or boat.dev's own SSH there. It runs when boat.dev starts the box's own services, a second or two after the sandbox is ready, and reads the value from `/run/ascii-secrets/env.sh`, which boat.dev writes before that. Only a value that differs from the marker's makes the box a copy. If the value is not there yet, as on a slow start, the box removes nothing and says it cannot tell yet; SSH, Tailscale and BB's daemon wait while it looks again every 2 seconds, however long that takes. BB Box waits for the check, and starts it itself if boat.dev has not 10 seconds on, before it lets the box user in over SSH, joins the tailnet or gives the box its access file; a start whose check has not decided after 5 minutes fails, saying why. If a reset ever leaves a box with no marker, BB Box writes it again at the box's next start.

A copy made outside BB Box keeps its source's identity. boat.dev gives a fork made in its dashboard or with its API the value of the sandbox it copied, unless the request sets another, so such a copy does not reset, and can act as its source: as the same BB machine, on the same tailnet node, with the thread's access. Copy a box's sandbox only through BB Box.

### On macOS

A fork of a macOS box gives up its source's identity before anything in it runs. On the Mac, before the fork's first boot, BB Box attaches the fork's own copy of the disk, mounts its Data volume and removes BB's machine credentials and host ID, BB's LaunchAgent for its daemon, the thread's access file, the VM's name and the SSH host keys, then ejects it. It attaches only the fork's own image, finds its APFS container from that image's own store and its Data volume by role inside that container, and never acts on the Mac's own container. A fork whose disk it cannot clean so is not made. This needs a Mac whose `diskutil` has `image attach`, as macOS 27 has: on another Mac, macOS boxes take and restore snapshots, but make no forks and keep none past a release, and `bb box doctor` says so in "macOS forks on <mac>". Tart then gives the fork a new MAC address and a new machine identifier, so a new hardware UUID. macOS boxes do not join the tailnet, so there is no node to remove.

macOS boxes also have a reset of their own, as Linux boxes do. BB Box installs it in each macOS VM as it is first ready, as `/usr/local/sbin/bb-box-identity`, with a LaunchDaemon, `dev.bb-box.identity`, that runs it at each boot. Its marker names the MAC address of the VM's network card, the VirtIO card Tart gives it, never the USB network interfaces macOS makes for itself. At a copy's first boot it removes the same again and makes new SSH host keys. macOS cannot make BB's daemon, a LaunchAgent that starts at the login, wait for it, so it reads who is logged in at the console before it removes anything and again after. If someone was, while BB's identity was still on the disk, it says so in its record, and BB Box refuses the fork. On a fork whose disk the Mac has cleaned, nothing of the source's is left to act, so a login then is no race.

### Turning it on

Only these images have it on: Linux on Proxmox LXC, Proxmox QEMU, Docker and microsandbox, which share Docker's images, boat.dev and Tart. Others have the program, with it off. A Tart Linux image prepared before this BB Box has it off too: refresh it, and boxes made from it after have it. macOS boxes on Tart get it when they are first ready.

BB Box writes markers only on the backends you name:

```
bb box option set general.identityResetBackends=proxmox-lxc,proxmox-qemu,tart
```

Until then, no box has a marker, and no box resets. Turning a backend off again stops new markers; a box that has one keeps it until you remove it, with `sudo bb-box-identity unarm` in the box.

### Snapshots and forks

Each snapshot records whether its box had a working reset when it was taken, and its version. A snapshot without one says "not fork-safe", and never forks. Each backend forks only from the version known to keep a copy from coming up as its source: version 7 on Proxmox LXC, microsandbox, Docker and Hetzner Cloud, 5 on Proxmox QEMU, 8 on boat.dev and Tart's Linux, 3 on Tart's macOS. A snapshot keeps the version it was taken under, so one taken before its image had that version never forks.

## Forking a snapshot

A fork is a new box made from a snapshot's disk: of the same kind, at the size the snapshot holds, on the same host, with a new name and box ID. It is for trying two things from one set-up state. On Proxmox it is a full copy of the snapshot, so it holds nothing of its source afterwards; either can be released alone.

It never acts as its source. BB Box makes the copy unable to start on its own: in its first request after the copy, it turns `onboot` off and takes every link down. It gives the copy its own address and new MAC addresses with its links still down, brings them up just before its first start, and turns `onboot` on only once the fork passes the check below. With new MAC addresses, so at its first boot its [identity reset](#a-copy-of-a-box-gives-up-its-identity) runs before its network, SSH, Tailscale and BB's daemon start, and removes its source's BB machine credentials and host ID, the thread's access file and the tailnet node, and makes new SSH host keys and a new machine ID. Then BB Box:

1. checks, before it hands the fork over, that the reset ran: its boot says it reset, its identity marker names its own MAC addresses and no box, BB's credentials and the access file are gone, its Tailscale state holds no node, its machine ID and SSH host keys are not those the snapshot held, as BB Box read them at the take, nor is the DHCP client ID it asked for its address with, and it holds its own address and no other box's. On Tart, whose Mac gives each VM its address by DHCP, a Linux source releases its lease as it shuts down, so the Mac may give its last address to a fork. BB Box hands such a fork over only when its source is stopped, the snapshot holds its source's DHCP client ID, and the fork asked for its address with one of its own; the source then gets another address when it starts, which BB Box records. A fork on an address its source holds while it runs or is suspended, as a suspended macOS box resumes with its own, is refused. So is a fork on its source's last address from a snapshot taken before BB Box read client IDs: take the snapshot again. While the check runs, the source's start and stop wait for it. Every item must be read: one BB Box cannot read refuses the fork. A fork whose first boot cannot tell yet whether it is a copy, as when its network card comes late, keeps SSH and BB's daemon off until it can; BB Box waits up to 3 minutes for its first start, on Proxmox LXC as on QEMU, and up to a minute more for the check, and never counts such a boot as a reset. A fork that fails the check is released, and says why. If BB Box cannot delete its copy yet, it stops it, says so, and tries again at each sweep; it never hands such a fork over
2. writes the fork's own identity marker
3. enrols it as a new BB machine, and gives it its thread's access, or yours

A fork given its source's name still resets: the name plays no part. What a fork still holds is everything else on the disk: a project's secrets, a signed-in browser, a keychain and cloud credentials in files. It is a new BB identity, not a cleaned box. It starts fresh: no apps are running, even from a snapshot with memory: it has what the box's disk held, which the flush before each take brings up to date.

A fork stays on its source's backend. Where that backend is [kept for certain projects](settings.md#backends-kept-for-projects), the fork goes only to a thread in one of them, and a fork into any other thread is refused, as its check says. You can still fork it as one of your machines, as a kept snapshot's fork always is. The thread's project is the one it is in when you fork, not the one its box was made in. A restore that makes a new guest is refused in the same way.

Its page's facts say where it came from: "Forked from amber-fox, "before the migration" (yesterday 23:39)". Its log starts with the same words, and its source's log says `fork-asked`, then `forked` or `fork-failed`. While the fork is made, its snapshot cannot be deleted, and its source's take, restore, stop and release wait for the copy.

Who forks:

- **You**, from a box's page or the command line, into the box's thread, or as one of your machines. A fork of one of your machines is one of your machines.
- **A thread's agent**, with `box_fork`, from its thread's own box into its own thread. Left without a snapshot, `box_fork` checks first that the box could be forked now, then takes one of the box now, named "for a fork", and forks that. If the fork is still refused, BB Box deletes that snapshot and says so; if the take deleted an older snapshot of the agent's to make room, it says that too. An agent does not fork a box threads run on, nor makes a fork one of your machines.

Only a snapshot that was taken with a working identity reset, of the version its backend needs, forks; others are refused with why, before anything is copied. Linux desktops fork from images built with reset version 9 or later. Older images refuse forks and Keep, saying why. Windows boxes and Android boxes on boat.dev have no reset checked yet, so they do not fork.

BB Box reads a box's identity reset from inside it as it takes a snapshot, so on Tart, where a Linux box is taken stopped and a macOS box can be, it reads it just before it stops the box itself, and keeps that reading, with a mark of the stopped VM's files, until the box next starts. A take uses the reading only while the VM's files are as BB Box left them: if the VM ran since, even started and stopped outside BB Box, they have changed. A snapshot of a box stopped another way, shut down from inside or by the Mac, or that ran since, neither forks nor keeps: start the box, stop it with BB Box, and take it again. A box whose reset was off when BB Box stopped it, as in one from an image prepared before the reset was turned on, is told to refresh the Linux image and make the box again.

The **Fork dialog** asks for the new box's name (one is made up if you leave it empty): a lower-case letter first, then lower-case letters, digits and hyphens, up to 32 characters, not ending in a hyphen and, for a thread's box, where it goes: in the box's thread, or as one of your machines. It says what the fork holds, its size, and at most how long the copy takes and how much space it uses on the host. **Fork** opens the new box's page, starting.

On the command line:

```
bb box snapshot fork <box> <snapshot> [--as-machine] [--name <name>] [--check]
```

`--check` says what the fork would be and refuses what it would refuse, changing nothing. Like the other snapshot commands, `--thread` or `--machine` say where the source box is.

On boat.dev a fork is a new sandbox made from the saved snapshot, with the fork's own ID as its identity value, so it resets at its first start. As boat.dev labels no sandbox made from a saved snapshot, BB Box makes one under a name of its own, stops it and copies it with the fork's labels, then deletes the first: 2 of boat.dev's starts, free within the plan's starts. A fork goes no further than its identity check until BB Box's check before it is handed over has passed: BB Box reads it as boat.dev's own user, and a fork whose boot says it has no marker is refused. Only then does the box user get in, does the fork join the tailnet, and get its access file. The check is the one above, with its marker naming its own value in place of MAC addresses; the address and the SSH host keys are boat.dev's. Its source's sandbox is not touched.

On Docker a fork is a new container made from the snapshot's image, named `bbbox-<fork>-<8 hex>`, with the fork's own ID, name and labels, and the fork's own ID as its identity value, `BBBOX_IDENTITY`, from its container settings: a snapshot's image holds no value of its own. Its Docker data is a new volume copied from the snapshot's, made before the container. It is placed as a new box is, so it has no GPU of its source's: a Docker fork has none. Its first start runs its identity reset and nothing else, then holds: Docker inside it, its desktop and every container copied from its source wait, so nothing of its source's runs in it. BB Box's check reads it while it is held, as above, with its marker naming its own value in place of MAC addresses. Only when the check passes does BB Box release the hold and change its restart policy from `no` to `unless-stopped`, and the fork's services start. A fork that fails the check is released, its container and its Docker data with it, and its hold is never released. If BB Box stops while a fork is made, before its check has passed, the fork stays held, even if it starts again, until BB Box's next start deletes the container it had begun and makes the fork again. Its source's container is not touched.

A Docker fork needs its source made from a Docker image built with the hold. A snapshot of a box made from an older image says why and never forks: rebuild the images with `setup/docker/build.sh`, make the box again and take a new snapshot.

## Agents' snapshots

A thread's agent has five tools:

| Tool | Does |
| --- | --- |
| `box_snapshot` | takes one of a box, with a name and a note, and with its memory where its backend can. With `check`, it says how long a take would pause the box, and takes nothing |
| `box_snapshots` | lists a box's, or every box's of the thread and of the machine it runs on, that the thread may see |
| `box_snapshot_delete` | deletes one that an agent of the thread took and nobody kept |
| `box_restore` | restores a box, always taking an undo first |
| `box_fork` | makes a new box of the thread from a snapshot of one of its boxes, or from the box now |

Its skill tells it to take one before a change it cannot undo, such as a migration, an upgrade, a deletion or a change to the system, and when you ask; never on a schedule of its own; to restore when an attempt went wrong rather than undo it by hand; and to delete its own when they are no longer needed.

What an agent may do follows the box:

- **Its thread's own box**, one no thread runs on: it takes snapshots, sees, restores and forks all of the box's, and deletes those an agent of its thread took. It restores without asking you, always with an undo; it cannot restore without one, nor past a person holding the desktop or a BB terminal open on the box, whether it asks through the form or not.
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
6. Takes the undo: a snapshot of the stopped box, named "before the restore at 01:56", so nothing written before the stop is lost. On ZFS the undo is a full copy of the stopped box instead: see [ZFS](#zfs). Without `--no-undo` a restore always takes one, and if it cannot, BB Box starts the box again as it was and restores nothing.
7. Reads what the box would lose once more, then rolls the box back, and starts it.
8. Reads the box's size back. A snapshot holds the box's cores, memory and disk as they were then, so a box resized since goes back to its size then, and the answer says so.
9. Writes the box's access file from the thread's access now, as the first command once the box answers, before any other command of BB Box's and before BB's daemon starts again: the restored disk holds the file as it was then. Then it writes the box's labels on Proxmox again, and starts its BB machine again, as a start does.

Undos are counted apart from the snapshots per box: a box keeps 2. Once a restore is done, its undo replaces the oldest one that is not kept and not the restore's own target. To undo a restore, restore its undo.

`--check` says what a restore would do, with its undo, the size the box goes back to, what it would end and the undo it would replace, and refuses what the restore would refuse. It changes nothing. While a restore runs, or one BB Box could not confirm holds the box, BB Box takes no snapshot of it, and refuses to start, stop or resize it.

On Tart, step 5 suspends a macOS box, and shuts a Linux or Windows box down. A Windows box is never stopped hard for a restore: Windows shuts down, as for a take, and the undo holds the disk Windows left.

On boat.dev, step 5 is boat.dev's own stop, which saves the box's disk, and step 6 saves that as the undo, so it holds exactly what the restore replaces. Step 7 makes the box a new sandbox from the snapshot, which runs the box from then on with its ID, name and labels. BB Box deletes the old sandbox only once the new one has started and taken its access file; if the new one does not start, BB Box deletes it and starts the old one again. The box's snapshots live on the account, not on the sandbox, so none is left behind. It costs 2 of boat.dev's starts, which `--check` and the dialog price before you restore: free within the plan's starts, and paid from the wallet past them. A restore needs 3 starts available in each of boat.dev's windows, free or paid. If the new sandbox does not start, or its access file cannot be written, BB Box deletes it and starts the old one again, and a restart of BB Box part way through finishes that.

A restore takes a few seconds. Measured on Proxmox LXC on LVM-thin, a box of 16 GiB: about 4 s, of which the stop takes about a second, the undo and the rollback under a second each, and the start about 2 s. When the snapshot was taken while the container ran, Proxmox's own start takes about 45 s instead, and BB Box waits for it.

On microsandbox, as on boat.dev, step 5 stops the box and step 6 takes the undo of its disk, so the undo holds exactly what the restore replaces. Step 7 makes the box a new microVM from the snapshot, with the box's own identity value, so it stays the same BB machine. A snapshot with memory comes back running, at the size it was taken at, as `msb` requires; a disk snapshot boots at the box's size. BB Box deletes the old microVM once the new one has started; the box's snapshots live on the host, not in the microVM, so none is lost.

On Tart, a macOS box of 16 GiB took 13 to 15 s: its suspend, which saves its memory, 4 to 6 s; the undo, a clone of the suspended VM, under half a second; putting the snapshot's copy in the VM's place under half a second; and the resume 8 to 9 s. It is never stopped hard. The box comes back running as it was at the take, its processes too, and so does an undo, which holds the box's memory from just before the restore. A Linux VM on Tart is shut down instead, and boots again.

On Tart, a Windows box of 8 GiB on an Apple M4 Max took 21 to 24 s, from the request until the box was ready again: Windows shut down, the undo and the swap, clones of three files, and a fresh boot of Windows.

### ZFS

ZFS rolls a disk back only to its newest snapshot, so a Proxmox LXC box on ZFS restores only its newest snapshot. Restoring an older one is refused before the box stops, and says how many newer snapshots it has: fork the older one instead, or delete the newer ones yourself first. BB Box never deletes newer snapshots to make a restore possible.

A snapshot taken as the undo would be newer than the one you restore, and ZFS would then refuse the rollback. So on ZFS the undo is a [held copy](#a-held-copy) of the stopped box: a full copy that cannot start. In place of steps 6 and 7 above, BB Box:

1. Copies the stopped box in full into a VMID of the box range, on the box's storage, labelled as the undo of this restore.
2. Disarms the copy, so it would not start at the node's boot or reach the network, and makes it a Proxmox template, which cannot start.
3. Rolls the box back to the newest snapshot, and starts it.

The copy takes about as long as copying the box's disk, and needs about the box's disk size free on the storage: `--check` and the dialog say both before you restore. Measured on a Linux box of 16 GiB on ZFS: the copy about 8 s, the rollback under a second and the start about 2 s. If the copy fails, BB Box deletes what it made of it, starts the box again as it was and restores nothing. BB Box makes such a copy only of a box whose [identity reset](#a-copy-of-a-box-gives-up-its-identity) works, which it reads while the box runs. For a box without one, it refuses the undo, and you can restore without one, with `--no-undo`. A copy cut short before it is a template is never trusted: BB Box deletes it and makes it again from the stopped box.

To undo a restore on ZFS, restore its undo. BB Box stops the box, copies the held copy in full into a new guest, in a new VMID of the box range, with the box's own MAC addresses, and starts the box on it. The box keeps its ID, name, BB machine, host ID, MAC address and SSH host keys, and its identity reset does not run. Where the backend gives each VMID its own address, the box's address becomes its new VMID's. Proxmox gives the new guest a new machine ID, as it does every clone. The guest it ran on until then becomes its **earlier guest**: disarmed, with new MAC addresses, and never started by BB Box. The box's other snapshots stay there, listed as on its earlier guest, to fork only. BB Box deletes the earlier guest when its last snapshot goes, and at the box's release. If the earlier guest holds no snapshot, BB Box deletes it at once. The held copy stays as long as an undo does.

BB Box does not restore a Linux VM on Proxmox QEMU on ZFS yet, until that is checked on a VM there. It does not restore a Windows desktop or an Android box on ZFS, because the undo would be a held copy and they have no identity reset BB Box has checked.

### Restores made outside BB Box

BB Box reads Proxmox's task list at each sweep. A rollback of one of its boxes that BB Box did not make, such as `pct rollback` on the host, is logged in the box's log by how it ended: done, failed, or still running, which it looks at again at the next sweep. After one that ended well, BB Box reads the box's size back, writes its labels again, and when it runs, its access file, and starts its BB machine again. A change in a box's snapshots without such a task is not taken for a restore.

### If BB Box restarts during a restore

Each step is recorded before it runs, with Proxmox's task once it begins. When BB Box starts again, it finishes the restore from the step it reached, or puts the box back as it was if it never got past the stop. When it cannot tell how a step ended, such as a rollback whose task it cannot read or that still runs, it keeps the snapshots the restore uses, leaves the box as the restore left it, refuses to start it, and checks again at each sweep. `bb box sweep` checks at once, and `bb box doctor` names such a restore.

## Keeping a snapshot

Keep makes a snapshot yours and keeps it past its box's release, for 30 days from the day you keep it unless Settings say otherwise, or until a date you choose. No agent can delete a kept snapshot, and BB Box deletes it after its date, whether its box lives or not; from 3 days before, its row says "goes in 3 days" in amber, and the Snapshots tab counts it. Keep it again to renew it: **Keep 30 more days…** adds the days to its keep date, at most 365 days from today. A date you choose can shorten a keep, and the dialog says so first. Days are counted in UTC.

After its box's release, the only way to use a kept snapshot is to fork it. So Keep is offered only for a snapshot that could be forked then: of a Linux box, or a macOS box on Tart, taken with a working identity reset of the version its backend forks from. Otherwise Keep… is off, with why: "taken before amber-fox's image had the identity reset: it could not be forked after a release". A Windows desktop on Proxmox QEMU or Tart takes snapshots of its disk, and Keep stays off, because a Windows box has no identity reset BB Box has checked, so a kept copy could not be forked.

The **Keep dialog** asks for the date, the default chosen, and says what keeping costs on that backend before you confirm: on Proxmox, "If amber-fox is released, BB Box first copies this snapshot in full into a template that cannot start: up to about 38 s, and about 2.8 GB, at most 17 GB, on pve-1's local-lvm until 2026-11-30, at no charge." The space is the box's disk use now, where Proxmox says it (containers), and at most the snapshot's disk. When, at today's size, a release would find no room for that copy, or no free VMID, the dialog says so; it keeps the snapshot anyway, as the room may be there by then. On microsandbox nothing is copied: "If amber-fox is released, it stays where it is until 2026-11-30." It stays on the host at its whole size. On Docker nothing is copied either, and the dialog says what it takes: "It takes about 8 MB of Docker's disk that no other image or container there uses, and up to 3.0 GB if what it shares is deleted."

The keep date is written on the provider first, in the snapshot's own label on Proxmox (`reset 7 kept 2026-11-30` in its description, with the version of the box's identity reset), then in BB Box's record. So a lost `snapshots.db` loses no keep: the snapshot is found again as kept, with its date and its version. Each change is recorded before the label is written; if BB Box stops between the two, its next sweep reads the label and settles the change before any expiry or release. boat.dev's saved snapshots take no labels and cannot be renamed, so there BB Box writes the date in its own storage for the backend, apart from `snapshots.db`, with what a fork of it needs: the version of the box's identity reset, and the box's kind and name. On microsandbox, whose snapshots' labels cannot change once taken, the keep date is a file of BB Box's beside `msb`'s snapshots, in the folder's `kept`. On Docker, whose image labels cannot change either, it is a tag on the snapshot's image, `bbbox-kept/<install>/<snapshot>:<yyyy-mm-dd>`, moved when the date changes: the new tag first, then the old one goes. A change cut short between the two can leave two tags for a while; BB Box's next maintenance leaves one, the date you asked for, or the later of the two if it lost its record of the change. If the provider refuses the label, nothing is kept. **Stop keeping** takes the date off the label and the record, and the snapshot goes with its box again.

On the command line:

```
bb box snapshot keep <box> <snapshot> [--days <n> | --until <yyyy-mm-dd>] [--check]
bb box snapshot unkeep <box> <snapshot>
```

`--check` says what keeping it would cost, changing nothing. A box that was released is named as `bb box snapshot list --all` names it; its kept snapshot can be kept longer, or deleted, not unkept.

### On Tart

On Tart nothing is copied at the release: the kept snapshot stays where it is, beside the VMs, and the release deletes the VM only. From then on it takes its whole size, up to the VM's disk and memory, as the box no longer shares its blocks; the Keep dialog says so. A fork of it after the release is one of your machines. Kept snapshots stay on the Mac after BB Box is removed from BB, or the Tart backend from its settings: delete them first, or remove them on the Mac as the Tart guide's Remove says.

### On Docker

On Docker nothing is copied at the release either: the kept snapshot stays on the box's Docker engine, as its image, its copy of the box's Docker data and its keep tag, and the release deletes the box's container and the snapshots nobody kept. Its image shares layers with the box's image, so while that image is there, the snapshot takes only what no other image or container uses: its own layers and its Docker data. A running fork of it uses all its layers, so then only its Docker data is its own. When the box's image is refreshed and the old one deleted, it takes up to its whole size. The Keep dialog and the Kept snapshots check in `bb box doctor` give both numbers, from the sizes of its image's layers. They are estimates: with Docker's containerd image store, Docker does not list the packed size of each layer. A fork of it after the release is one of your machines, a new container on the same engine, and resets as any fork does. Docker may give the fork the address its box had; BB Box accepts that once Docker says it has no container of that box, by its name or its labels, and that it gave that address to the fork. A lost box record alone is not enough. BB Box refuses to remove the Docker backend from its settings while the engine holds any of its snapshots, kept or not, as on boat.dev: delete them first.

### A held copy

On Proxmox, a kept snapshot outlives its box as a **held copy**: when the box is released, BB Box first copies each kept snapshot in full, its earlier guest's included, into a VMID of the box range, and only then deletes the box's guest. Each step is recorded before it runs:

1. the clone of the snapshot, labelled as a held copy with the box, the snapshot, its keep date, the box's kind and the version of its identity reset
2. the disarm: `onboot` off and every link down, and on a VM a new SMBIOS UUID
3. the conversion to a Proxmox template, which cannot start; BB Box waits until Proxmox lists it as one

The kept snapshot then lives on the copy: its row says "held copy on pve-1", and holds the disk only, also for a snapshot that held memory. It is listed under its box, marked released, on the Snapshots tab and in `bb box snapshot list --all`.

BB Box waits for the clone up to 3 times its estimate, and at least 3 minutes, so a large disk is not cut short.

A copy that is not a template yet is never trusted. If BB Box restarts in the middle of one, it deletes that copy when it starts again and makes it again from the snapshot, which the release has kept until then. If the wait runs out while Proxmox is still making the copy, BB Box keeps waiting for that same task at each retry: once the task ends well, it labels that copy, disarms it and makes it the template, rather than cloning again. A copy that Proxmox finished just as the wait ran out is made the template at once. A copy whose task failed, or one left when BB Box restarted, is deleted and made again. When a copy is made again, BB Box looks only for a task begun by that attempt, and waits while it cannot tell which task is its own. A part-made copy is never taken for a box. If `snapshots.db` was lost while a copy was being made, BB Box trusts the snapshot on the box, not the copy: it deletes the copy, and the release makes it again. A copy found running before it was a template, which should never happen, is logged `held-copy-started`.

Before it deletes anything, every release reads the labels of the snapshots on the box's guest. It stops, deleting nothing, if it cannot read them, or if a label says a snapshot is kept and BB Box's records do not say so yet, as after a lost `snapshots.db`, until the sweep has read the labels again.

If a copy cannot be made, the release stops and deletes nothing, and the box stays a BB machine. This happens when there is not enough room, when no VMID is free, or when BB Box cannot read the storage. The room rule is the same as for a take: the storage would be past your setting with the copy, counting what snapshots and copies being made there hold already. A copy is sized at about the box's disk use, and it holds that room until it is made. For example: "Release did not finish: bb-box could not copy "Thu 09:15", which you kept: pve-1's storage local-lvm has 6 GB free, and the held copy needs about 13 GB." A release also stops for a kept snapshot whose identity reset version BB Box does not know, as its copy could never fork. The sweep tries again every few minutes. Where taking your keeps off gets past the stop, the box's menu then offers **Release again** and **Release and delete what you kept** (Remove, for your machines); on the command line, `bb box release --delete-kept` and `bb box machines remove --delete-kept`. It is not offered while a copy is still being made, while a label cannot be read, or for a held copy that is not a template: delete that snapshot instead.

A kept snapshot of a released box forks from its held copy, as one of your machines, from the Snapshots tab or with `bb box snapshot fork <box> <snapshot>`. The fork resets at its first boot and is checked as any fork is.

### As it is, on boat.dev

On boat.dev a kept snapshot needs no copy: a saved snapshot lives on the account, not on the sandbox, and does not expire. A release deletes the box's other saved snapshots and leaves the kept ones as they are. Each costs boat.dev's daily price past the plan's included ones until its keep date, as the Keep dialog says, and counts against your ceiling. It forks as one of your machines, and **Keep 30 more days…** renews it after the release too.

## When a box is released

A box's snapshots go with it when it is released: Proxmox deletes them with the guest. On boat.dev, where they live on the account, BB Box deletes each of the box's saved snapshots before it deletes the sandbox; if one cannot be deleted, the release stops, deletes nothing more, and tries again at the next sweep, as a saved snapshot left behind would go on costing. The box's log says so for each one. On microsandbox, where they live on the host apart from the microVM, and on Docker, where they live on the engine apart from the container, BB Box deletes those nobody kept the same way, and kept ones stay as they are until their date, as on boat.dev. On Tart, where they live beside the VMs, BB Box deletes those nobody kept the same way, as they would go on taking the Mac's disk, and kept ones stay as they are. A Windows box's are never kept, so all of them go. On Proxmox, kept ones outlive it as held copies, above.

A guest BB Box has no box record for, whose thread BB says ended, goes at the next sweep, with its snapshots: first BB Box makes held copies of any it carries a keep date for, in BB Box's records or in the snapshots' labels. If it cannot read the labels, it keeps the guest until it can.

## If BB Box restarts

Each take, delete and restore is recorded before it starts, with the backend's task once it begins. A restore's own steps are above. If BB Box restarts in the middle of one, it reads the backend's task and the box's snapshots when it starts again, and finishes or settles it: a take is ready only if the backend shows it complete, and a take that never began is failed, never taken again.

BB Box also compares its records with each backend's snapshots every few minutes. A snapshot BB Box has no record of gets one again, so a lost `snapshots.db` loses no snapshot. The record keeps the snapshot's size where its backend lists one, as Docker, microsandbox and boat.dev do. One of a box that is gone is listed as found on its host until you delete it, or as kept until its date when it carries one. A snapshot found again keeps its identity reset's version from its label, and a held copy keeps it and its box's kind from its tags, so either still forks. One labelled before labels carried the version does not know it: it is not kept anew or forked, and a release stops rather than copy it, until you delete it or choose Release and delete what you kept.

## The Snapshots tab

The Boxes page has a third tab, Snapshots, after Machines and Threads, with its count, at `/plugins/bb-box/desktop/snapshots`. The line under the tabs says how many snapshots there are, undos apart, how many agents took, the space they use by host where known, and what paid ones cost a month; then, in amber, what needs you: keeps that end within 7 days, failed takes, snapshots that are incomplete, unavailable, lost or found.

Each box with snapshots has a card: its name, a link to its page while it lives; its kind; where it lives; its thread, or "Your machine"; and for a box that is gone, "released 12 Oct". Each row is as on a box's page, and also says what it holds and its life: "goes with the box", "kept until Sun 29 Nov", or "held copy on pve-1". Restore, Fork and the row's menu work as on the box's page; for a released box, Restore is off with "its box was released: fork it into a new box instead".

Search finds a snapshot by its name, its note, its box's name or its thread's title. Filters, with counts, choose by where it lives, what it holds, who took it, kept, undos and keeps that end within 7 days. Sort by newest, oldest, largest, price or box name.

**Select** puts a checkbox on each row; with some ticked, the bar offers **Keep…** and **Delete…**. Each opens a dialog that checks every snapshot as a single Keep or Delete would, at the moment you open it and again at the moment of the change, and lists those it skips with why, such as a snapshot a restore uses, and what each of the others costs or frees on its own backend. Keep… keeps each for the days in Settings from today, or that many days more for one kept already, so it never shortens a keep; if you choose a date, the dialog names each keep it would shorten.

## Settings

BB Box's settings have a Snapshots page, under Options. Its fields wait for Save, as other fields do; its switch saves at once.

| Setting | Default | Range | What it does |
| --- | --- | --- | --- |
| Snapshots per box | 5 | 1 to 50 | A take past it is refused, naming the snapshots to delete. Kept ones count; undos are counted apart, 2 a box. |
| Keep keeps a snapshot for | 30 days | 1 to 365 | From the day you keep one, unless you give a date. BB Box deletes a kept snapshot after its date. |
| Refuse new snapshots when a host's storage is past | 85% full | 50 to 90 | A take is refused past it, and past 5 points below it of a thin pool's metadata. 7 points above it, BB Box deletes agents' snapshots on that storage that nobody kept, oldest first, and logs why. |
| A ceiling on paid snapshots, one per backend that charges | 5 a month, in the provider's currency | 0 to 1,000 | A take that would bring the monthly rate held on that backend past it is refused. |
| Agents may restore their own boxes | on | | Off, an agent asks for a yes in its thread through the form before it restores any box. A box threads run on always needs that yes. A switch, saved at once. |
| Agents may restore memory snapshots | on | | Off, only you restore a snapshot that holds a box's memory. A switch, saved at once. |
| Keep a picture of the screen with each snapshot | on | | A switch, saved at once. Off, a snapshot has no picture. |

The page also says what each backend's snapshots hold and cost, and what its last check found of its storage.

From a terminal, `bb box option set` changes each of them: `general.snapshots.perBox=3`, `general.snapshots.roomPercent=80`, `general.snapshots.agentsRestore=false`, `general.snapshots.agentsMemory=false`, and a backend's ceiling as `general.snapshots.ceilings.<backend>=7.50`, with the backend's ID from `bb box config show`. `bb box option unset` gives each back its default.

### Paid snapshots

The ceiling bounds the monthly rate of what is held, not the bill. The rate is every paid snapshot the provider holds, kept or not, times its daily price, times 30. Where a provider's plan includes some snapshots, as boat.dev's does, the rate is what the provider bills: those past the included ones, counted from the provider's own figures for the whole account, and a take within the included ones adds nothing to it. If BB Box cannot read those figures when it would add one, it adds none, as an older count says nothing of what others on the account have added since, and the page shows an estimate at full price. Otherwise the page says how many saved snapshots the account holds and how many are billed. A take is refused when the rate would pass the ceiling after it, with the words "It would bring snapshots held on (backend) to about $5.04 a month, past your ceiling of $5.00". When the rate is past the ceiling for another reason, such as a lower ceiling, the page warns, new paid snapshots are refused, and BB Box deletes none of them. Beside each ceiling, the page shows the rate held and what was spent this month, deleted snapshots included. A price BB Box does not know is shown as unknown, and only you can take a snapshot there.

Where no backend charges for snapshots, the page says "None of your backends charges for snapshots".

## Removing a backend

A backend that holds snapshots cannot be removed from the settings while BB Box records them. Delete them first, or forget them:

```
bb box snapshot forget <backend> --yes
```

Forgetting removes BB Box's records only. The snapshots may still exist on the backend, and be billed there.

Where snapshots live on the provider apart from the box, on boat.dev, microsandbox and Docker, BB Box also asks the provider before it removes the backend, and refuses while it holds any of this install's snapshots, kept or not, recorded or forgotten. The refusal names them and says to delete them with `bb box snapshot delete <box> <snapshot>`, as `bb box snapshot list --all` names them.

### Docker

A Docker snapshot holds the disk and a separate copy of the box's Docker data.
It does not hold running programs, memory, `/run` or `/dev/shm`. A take pauses
the box while copying the Docker data and committing the disk. Before the take,
BB Box says about how long, from the bytes it copies, and after it, how long the
box was actually paused. The pause measurements above are from the design
experiments in decision 082, not a promise for every disk.

Snapshots stay on the box's Docker engine. Their images use
`bbbox-snapshot/<install>/<box>:<snapshot>` and their Docker volumes use
`bbbox-snapshot-<snapshot>-docker`. Labels identify the install, box and snapshot.
A restart finds them again, with their keep dates, from the engine alone. A
release deletes those nobody kept; a kept one stays, with its keep tag
`bbbox-kept/<install>/<snapshot>:<yyyy-mm-dd>`, until BB Box deletes it after
its date (see [On Docker](#on-docker)). If another container uses a
snapshot image, deleting the snapshot removes its tag and volume; Docker keeps
the shared image layers until that container goes. The listed size is an estimate
of the snapshot's own changed layer and Docker data, from its take, not a
promise of space freed by deleting it. The list shows it as "about", and a
delete says it freed up to about that much, less what a fork or another image
still uses. A fork made from
a snapshot shares its image's layers in the same way.

A restore flushes the box's writes, stops it at once, as a power cut would, and
takes its undo from the stopped box: no pause, as nothing runs. It then makes a new container,
`bbbox-<box>-<8 hex>`, from the snapshot's image, with the box's ID, name and
labels, at the cores and memory the snapshot was taken at. A box with a GPU
keeps the card and part it has now, read from the container being replaced, on
every restore. If the box has a GPU but that container has none, BB Box refuses
the restore and leaves the box as it was, rather than restore it without one.
Its Docker data is a new volume copied from the snapshot's, so the snapshot
stays as it was taken and can be restored again. Once the new container has started and is ready, BB Box
deletes the old container and its Docker data. If the new one does not start,
BB Box deletes it and starts the old one again. If BB Box or BB stops part way,
its next start finishes the restore or puts the old container back, so the box
has one container. A restore takes about as long as a take of the box, for its
undo, plus about 15 seconds for each GB of the snapshot's Docker data and a few
seconds to start. The box comes back with its programs started afresh: what was
running and in memory when the snapshot was taken is not there.

An older box's anonymous Docker volume can be copied too. Other writable mounts
are refused before pausing. Move those files into the box before taking a snapshot.
LXCFS mounts are allowed, including existing writable mounts. Docker leaves their
contents out of the committed image. Read-only mounts are not copied. An image with 120 or more layers is refused;
make a new box and move its files.

Space estimates count the changed disk bytes once on overlay2 and twice on the
containerd image store, then add the Docker volume's size. The space check reads
Docker's own filesystem, including the virtual disk on Docker Desktop or WSL 2.
A record rebuilt after BB Box's database is lost keeps the snapshot's size, from
the byte counts in its image's labels.

If BB Box crashes during a take, the box can stay paused until recovery runs.
Recovery waits three times the estimated pause plus 60 seconds, capped at
15 minutes, then the next maintenance sweep. This can take several minutes.
Lost snapshot records alone never authorise unpausing a box.
