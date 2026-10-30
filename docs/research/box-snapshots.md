# Snapshots of boxes

What a snapshot of a box should be in bb-box: what people and agents want
it for, what each backend can do natively, how fast and at what cost, a
model every backend fills in as it can, the agent's tools, the person's
pages, safety and security, and the units that would build it.

Research, 30 October 2026: a note of what was known and measured that day,
not the current design, which is in [the architecture](../architecture.md).
Not settled by a decision yet; [a draft of one](#a-draft-of-the-decision) is
at the end. The owner asked: "one core feature we should start thinking
about: snapshot. Is it provider based? The management etc.; for example
boat supports snapshot built in. An agent should be able to snapshot,
right?"

Measured on real hosts through bb-box's boxes, as the
[method](#how-it-was-measured) says. The raw output and the scripts are in
[box-snapshots/](box-snapshots/). Read against bb-box's main branch at
`e2d05767`.

## Recommendation

Is it provider based? The mechanism is; the model is bb-box's. And yes, an
agent should be able to take one, and restore its own box to one.

1. **A snapshot is bb-box's own record, filled in by each backend as it
   can.** bb-box keeps one list of snapshots, with one set of verbs (take,
   restore, fork, keep, delete), one owner rule and one retention rule. Each
   backend says, per kind, what its snapshots hold (the disk, or the disk
   and memory), whether a running box can be taken, whether it restores in
   place and forks, where the snapshot lives and what it costs, as
   backends already say what they resize (061). Where a backend has
   nothing, the box says so, and bb-box builds nothing generic for it in
   the first units.
2. **Native mechanisms only, at first.** The backends used most have fast
   ones: Proxmox LXC takes a snapshot in 0.7 s, Proxmox QEMU in 1.1 s, or
   3.7 s with its memory, and QEMU restores in 1 to 4 s; microsandbox takes
   one with memory in 1.5 s and forks a running box in 1.6 s; a macOS VM on
   Tart already saves its memory at each stop, and an APFS copy of it,
   86 GB, takes 0.02 s and no space. A
   portable format of bb-box's own, which could move between hosts, was
   slower by an order (13 s and 3 GB for a small box with vzdump), holds no
   memory, and puts secrets in an archive away from the box; it is left for
   later.
3. **A snapshot lives and dies with its box, unless the person keeps it.**
   A thread's snapshots go when its box is released, as the box's disk
   does. The person can keep one past the release, and then it is theirs,
   with an expiry. An agent cannot keep one.
4. **A restore replaces the box's state, so it says what goes.** The
   agent's `box_restore` and the person's Restore both say how much
   changed since the snapshot, and take a snapshot of the state they
   replace first, by default.
5. **A fork is a new box, with a new identity.** It keeps the files and
   drops the box's BB machine, its access and its tailnet node, so a fork
   never acts as its source.
6. **The person sees every snapshot in one place**: a Snapshots tab on the
   Boxes page, beside Machines and Threads, and each box's own on its page
   (069), with Take snapshot. Retention and quotas are in Settings (067).

First units: the record and the capability, then Proxmox LXC and QEMU,
then the agent's tools and the box page, then the Snapshots tab. Then
forks, Tart, microsandbox and boat. See [build units](#build-units).

## What a snapshot is for

What a person and an agent want, most common first. "Covered" says what
bb-box does today that meets it, without a snapshot.

| # | Want | Who | Covered today | Gap |
| --- | --- | --- | --- | --- |
| 1 | **A checkpoint before a risky change, and a roll back**: an upgrade, a migration, a `rm -rf`, an agent's experiment | agent, often unasked; person | No. A stop keeps the disk, but not an earlier one | Native on Proxmox, Tart (macOS, memory), microsandbox, boat (paid only) |
| 2 | **Fork a box to try two things**: two fixes from one set-up state, or a person and an agent side by side | agent, person | No. boat's backend forks a template, not a box (068); 069 left Fork out: "bb-box has no fork of a box" ([069](../decisions/069-boxes-page.md)) | Native on Proxmox (clone), microsandbox, boat, Tart (clone) |
| 3 | **Keep a set-up box to start more like it**: a box with a project's dependencies built, a logged-in app, a device with an app installed | person, project | Partly: a project's image (049) is a script on the standard image, rebuilt nightly; spares and warm boxes are of an image (032). 049 rejected "save this box as an image" | Short-lived: a fork of a snapshot. Long-lived and shared: stays 049's script |
| 4 | **Save a box's state across a stop or a release**: go home, come back to the same desktop and processes; free a Mac's VM slot | person | Partly: a stop keeps the disk (all virtual backends); Tart's macOS stop saves its memory (suspend); Windows on a Mac saves its memory; boat keeps a stopped disk 14 days. Nothing outlives a release | A kept snapshot outlives the release |
| 5 | **Recover from a broken box**: a box that no longer boots or answers | person | Partly: release and acquire again; 025 and 026 re-enrol a box whose record was lost | Restore of the last snapshot |
| 6 | **Share a state with another thread or person**: "look at this failing state" | person, agent | No | A fork into another thread; later |
| 7 | **A device's state**: an iOS Simulator or Android emulator with an app installed and signed in | agent, person | Partly: Android's Quick Boot snapshot makes a device boot in 2 to 4 s ([images.ts](../../src/backends/images.ts)); iOS devices boot from a slimmed runtime | Android's own snapshots; iOS has none |
| 8 | **Move a box to another host or provider** | person | No | Export where native (vzdump, msb export, docker save, tart push); later |

The first two are the feature. 3 stays mostly 049's: a script can be
reviewed and rebuilt, and a snapshot cannot, as 049 says. A snapshot meets
the short-lived half, "five more like this one, today".

## What each backend can do

What it offers natively, then what bb-box would build where it has
nothing. Times are this note's measurements where marked (m), and the
provider's words otherwise. "In place" is a restore of the same box;
"fork" is a new box from a snapshot.

| Backend | Holds | Running box | Take | Restore in place | Fork | Lives | Costs | Keeps |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Proxmox LXC | disk | yes | 0.68 s (m) | yes, any snapshot in the tree; stops the box; 45.8 s with its start (m) | full clone of a snapshot, 9.3 s (m); a thin fork, 0.13 s (m), which Proxmox does not offer | the node's storage, beside the disk | changed blocks only | until deleted; goes with the guest |
| Proxmox QEMU | disk, or disk and memory | yes | 1.07 s; with memory 3.69 s and 3.7 GiB for 4 GiB (m) | yes; with memory it resumes running, 3.92 s (m) | full clone of a snapshot, 6.54 s (m) | the node's storage | changed blocks, and the memory | until deleted; goes with the guest |
| Docker (and Hetzner, Namespace Linux, which run Docker boxes) | the container's writable layer; not its volumes, so not a box's own Docker data | yes, paused | `docker commit` 15.2 s for 1 GiB (m) | no: a new container from the image | `docker run` from the commit, 0.18 s (m) | the Docker host | the layer's size | until removed |
| Docker with CRIU | memory and processes | yes | 23 to 25 s for 1 GiB (m) | failed on Docker 29.1.3 (m) | not supported | the host | the memory | until removed |
| Tart, macOS | disk and memory, when suspended | no: suspends it first | suspend, about 7 s for 16 GiB (m); an APFS copy of the suspended folder, 0.02 s for 86 GB, no space (m) | one saved state, written again by each suspend; an earlier one by putting a copy back, 0.19 s, then a resume, 11.0 s, processes and all (m) | `tart clone` 0.03 s (m); the clone kept the MAC and the saved state, and would not run | the Mac's APFS disk, copy on write | changed blocks; memory up to the VM's | until deleted |
| Tart, Linux (arm64) | disk | no | a copy of the folder, stopped | by putting a copy back | `tart clone` | the Mac | changed blocks | until deleted |
| Windows on a Mac (QEMU) | disk and memory | no: saves it first | QEMU writes its memory to a file at each stop ([qemu.ts](../../src/backends/tart/qemu.ts)) | one saved state | a copy, not built | the Mac | | |
| microsandbox | disk, or disk and memory | yes, paused briefly | 0.34 s; with memory 1.50 s (m) | no: each restore is a new sandbox, 3.85 s with memory (m) | `msb fork` of a running box, 1.57 s (m) | the host | changed layers; 1.5 GB archive for 0.5 GiB RAM and 0.5 GiB disk (m) | until removed |
| boat.dev | disk (changes over boat's base); never memory | yes: a capture each minute, and one at each stop | automatic; a saved snapshot "can run minutes" | **no**: "You cannot resume or fork an older snapshot" | fork of the newest snapshot; 3.5 s to SSH from a stopped sandbox (068) | boat | automatic ones free; saved ones 10 per $20 of plan, then $0.056 a day; **refused on the trial** | automatic: 14 days after a stop, older ones within a day; saved: never |
| Hetzner Cloud (the host) | the whole host's disk, every box on it | yes | 76.7 s for a 320 GB host, 17.0 GB compressed (m) | rebuild the server from it | a new server at least as large as the snapshot's disk; refused here by the project's core limit (m) | Hetzner, in the project | EUR 0.0119 a GB a month ([guide](../guide/hetzner.md)) | until deleted |
| Namespace (the instance) | memory and disks, by a suspend, as documented | yes | refused: HTTP 501 for bb-box's instance (m) | wake only: one state, no list | none in the compute API | Namespace | not stated | not stated |
| SSH host pool, Linux | nothing: no root on the machine | | a copy of the box user's home | by putting it back | no | the machine | | |
| SSH host pool, Mac | nothing native without root; APFS local snapshots are of the whole volume and need root | | a copy of the box user's home | by putting it back | no | | | |
| iOS slots (shared hosts, 064) | nothing native: a Simulator device has no saved state | no: shut down first, 3.2 s (m) | `simctl clone` 1.6 s, or an APFS copy of its 352 MB folder 1.0 s (m) | | `xcrun simctl clone`; the clone booted in 2.5 s (m) | the host | its folder's changed blocks | until deleted |
| Android emulator (in its box) | the device's disk and memory | yes | 14.8 s, 2.5 GB (m) | yes, 3.2 s (m) | a copy of the AVD, not tried | the box's disk | | until deleted |

### Proxmox LXC and QEMU

- **What it offers.** `pct snapshot` and `qm snapshot` take a snapshot of a
  running guest; `qm snapshot --vmstate 1` adds its memory, and a rollback
  to it starts the VM where it was ([qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html)).
  `pct rollback` and `qm rollback` go back to any snapshot in the tree;
  `--start` starts the guest after ([pct(1)](https://pve.proxmox.com/pve-docs/pct.1.html)).
  A clone of a snapshot (`--snapname`) is always a full copy for a guest
  that is not a template.
- **Which storage.** LVM-thin, ZFS, Ceph RBD, BTRFS and qcow2 files take
  snapshots; LVM (thick) only for VMs since Proxmox VE 9, as a technology
  preview, with thick snapshot volumes; a raw directory does not
  ([storage](https://pve.proxmox.com/pve-docs/chapter-pvesm.html)).
  bb-box's LXC guide asks for storage with linked clones, LVM-thin, ZFS or
  Ceph ([setup/proxmox-lxc/README.md](../../setup/proxmox-lxc/README.md)),
  so every Proxmox LXC host bb-box supports can take snapshots.
- **The token.** bb-box's token has `VM.Clone`, `VM.Allocate`, the
  `VM.Config.*` rights and `VM.PowerMgmt`, but not `VM.Snapshot` or
  `VM.Snapshot.Rollback` ([setup/proxmox-lxc/README.md](../../setup/proxmox-lxc/README.md),
  [privileges](https://pve.proxmox.com/pve-docs/chapter-pveum.html)).
  `host/setup-token.sh` would add both, and the doctor say when they are
  missing.
- **Cost.** On LVM-thin a snapshot is a thin volume sharing the box's
  blocks. After 1 GiB was written, the 7.3 TiB pool's use rose by 0.02%,
  about 1.5 GiB, and the snapshot itself by nothing. A memory snapshot
  of a 4 GiB VM took an 8.5 GiB state volume, 3.7 GiB of it used.
- **What bb-box saw.** The rollbacks were made outside bb-box. Its box log
  recorded no stop, and both boxes were connected BB machines again within
  minutes: the snapshot held BB's daemon state from before. A restore
  through bb-box must say so in the box's log itself.
- **The LXC rollback's 45.8 s** was mostly the container's own shutdown:
  `pct rollback` shuts a running container down before it rolls back. A
  hard stop, as bb-box's stop for LXC is, takes 1.3 s (the clone's stop),
  so a restore through bb-box should stop first: about 3 s in all, to be
  measured in unit 2.
- **Forks.** Proxmox clones a snapshot only fully: 9.3 s for 4 GiB used
  (LXC), 6.5 s (QEMU), at the copy's full size. On LVM-thin a thin
  snapshot of the snapshot took 0.13 s and shares every block, which is
  what a linked clone of a template is; Proxmox's API cannot make one of a
  snapshot. bb-box would do it only through `pct clone` of a template made
  from the snapshot, or not at all: a full clone is fast enough for a
  first unit.
- **Moving.** `vzdump --mode snapshot` made a 2.9 GB archive of the LXC box
  in 13.2 s, and `pct restore` made a guest of it in 6.5 s; the QEMU box,
  2.5 GB in 12.8 s. Restorable on another node, but it holds no memory.

### Docker, and the backends that run Docker boxes

- **What it offers.** `docker commit` saves a container's file changes as
  an image, pausing it while it does, but "commits do not include any data
  contained in mounted volumes" ([docs](https://docs.docker.com/reference/cli/docker/container/commit/)).
  A box with Docker keeps its own Docker's data on a volume,
  `/var/lib/docker` ([docker/backend.ts](../../src/backends/docker/backend.ts),
  near `--volume`), so a commit of such a box loses its images and
  containers. bb-box would add a copy of that volume, as a tar beside the
  image.
- **Checkpoints.** `docker checkpoint` with CRIU saves memory and
  processes; it is experimental and "focuses on single-host use cases"
  ([docs](https://docs.docker.com/reference/cli/docker/checkpoint/)).
  Measured: 23 to 25 s for a container holding 1 GiB, and every restore
  failed on Docker 29.1.3, with a network and without one; restoring into
  a new container is refused ("custom checkpointdir is not supported").
  Not usable.
- **Hetzner Cloud** boxes are Docker containers on a host bb-box makes
  (055), so a box's snapshot is a Docker commit on that host. Hetzner's own
  snapshot is of the whole host, every box on it: what bb-box already uses
  for its host image ([host-image.ts](../../src/backends/hetzner/host-image.ts)).
  It costs EUR 0.0119 a GB a month and is kept until deleted
  ([Hetzner's docs](https://docs.hetzner.com/cloud/servers/backups-snapshots/overview/)).
  Measured: a snapshot of a running CPX42 host, 320 GB of disk with
  19 GB used, took 76.7 s and made 17.0 GB. A server from it must have a
  disk at least the snapshot's 320 GB, and the project's limit on shared
  cores refused one beside the host, so a fork was not measured. A host
  snapshot is no box's snapshot: it holds every box on the host, and a
  server from it starts all their containers, which `--restart
  unless-stopped` brings back, with their BB machines and tailnet nodes.
- **Namespace** Linux boxes are a Docker container in a Namespace instance
  of their own ([namespace/linux.ts](../../src/backends/namespace/linux.ts)),
  so a commit works there too, and could be pushed to the workspace's
  registry, where bb-box already keeps its Linux images. See
  [Namespace](#namespace).

### Tart

- **What it offers.** A macOS VM run with `--suspendable` can be suspended:
  Virtualization saves its memory beside its disk, as `state.vzvmsave`, and
  the next run resumes it. bb-box already stops every macOS box so
  ([tart/backend.ts](../../src/backends/tart/backend.ts), top), and keeps
  its warm VMs suspended. A Linux VM cannot be suspended, as Tart cannot
  resume one (040). A VM is a folder on the Mac's APFS disk, and `tart
  clone` copies it on write ([tart/backend.ts](../../src/backends/tart/backend.ts)).
- **One state.** A VM has one saved state, which each suspend writes
  again, and a state saved under another macOS build may not restore
  ([tart/host.ts](../../src/backends/tart/host.ts), `macosBuild`;
  [tart/config.ts](../../src/backends/tart/config.ts), the warm VMs'
  longest suspend). A snapshot is a copy of the whole suspended folder,
  disk and memory together; an earlier snapshot is restored by putting its
  copy back in the VM's place while it is suspended.
- **Measured.** Through bb-box, a 16 GiB macOS VM suspended in about 7 s
  and resumed in 10.4 s, its processes running on. Suspended, its folder
  held an 88.6 GB disk image and a 7.9 GB saved state, 86 GB on disk. An
  APFS copy of the folder (`cp -c`) took 0.02 s and no space, and putting
  it back in the VM's place 0.19 s: the next start, 11.0 s, brought back
  the disk and the memory of the copy, the same process (same PID) running
  and later changes gone. `tart clone` of the suspended VM took 0.03 s
  but kept the box's MAC address and saved state, and `tart run` of the
  clone failed at once ("Operation not supported"), so a fork of a macOS
  VM with its memory did not work: a fork would drop the saved state and
  boot from the disk, with a new MAC address, which unit 7 must measure.
- **The copy must be on the VMs' volume.** On another volume `cp -c`
  falls back to a full copy: 1 GB of 96 GB in 7.5 minutes. bb-box's VMs
  can live on a volume of their own, so snapshots go beside them.
- **Moving.** `tart push` sends a VM to an OCI registry, which bb-box has
  none of for Macs.

### microsandbox

- **What it offers.** "Disk is the default. Full adds memory and execution
  state." A full capture of a running sandbox pauses it briefly; every
  restore is a new sandbox and leaves the source alone; `msb fork` makes a
  child of a running one without a saved snapshot; `msb snap export` writes
  a `.msb` archive another machine imports
  ([snapshots](https://docs.microsandbox.dev/sandboxes/snapshots)). Full
  captures, forks and archives are local only.
- **Measured** with bb-box's pinned msb 0.7.7, nested in a Proxmox QEMU
  box: disk 0.34 s, full 1.50 s, fork of a running sandbox 1.57 s with its
  memory, a restore with memory 3.85 s, an archive of a full snapshot of
  0.5 GiB of memory and 0.5 GiB of disk 1.55 GB in 9.0 s.
- **What bb-box would add.** A restore in place is a restore into a new
  microVM under the box's name, then the old one removed: the box keeps
  its record and its name, and its guest changes. Snapshots of one sandbox
  form a chain with a head, which cannot be removed until another is
  chosen.
- **Not in LXC**: its seccomp filter stops `msb`'s snapshots
  ([setup/microsandbox/README.md](../../setup/microsandbox/README.md)).

### boat.dev

- **What it offers** ([snapshots](https://docs.boat.dev/snapshots.md),
  [resume and fork](https://docs.boat.dev/snapshots/resume-and-fork.md),
  [what is saved](https://docs.boat.dev/snapshots/whats-saved.md), the
  [API](https://boat.dev/openapi.yaml)):
  - boat saves a sandbox's disk every minute while it runs and once more at
    a stop, as an incremental chain; "Memory and running programs are not
    in a snapshot."
  - "Resume and fork always use the newest snapshot. You cannot go back to
    an older one." The list of a sandbox's snapshots holds only recent ones,
    and their files can be downloaded.
  - A fork of a running sandbox uses its last background snapshot, so it
    can miss the last minute; a saved snapshot of a running one takes a
    fresh capture first.
  - Saved snapshots never expire: 10 per $20 of plan per seat, then $0.056
    a day each. "You cannot save a snapshot during the free trial."
  - A snapshot keeps `/home`, folders made at `/`, Docker named volumes,
    containers and their images, and changes in `/etc`, `/usr`, `/opt`,
    `/var`; not `/tmp`, `~/.cache`, the build cache, the hostname, the
    address or the SSH host keys.
- **Measured through bb-box** (a `small` box forked from bb-box's template,
  using 2 of the 4 starts the trial had left that day): acquire 26.1 s, stop about 30 s,
  start 5.2 s. The start brought back the same machine, uptime unbroken,
  `/dev/shm` and `/tmp` still there, as 068's results also saw: a quick
  stop and start is no restore. 068 measured a fork of a stopped sandbox at
  3.5 s to SSH.
- **What bb-box would build.** On the trial there is no checkpoint to go
  back to: a stopped fork of the box would be one, kept free for 14 days,
  and a restore would swap the box's guest to a fork of it. On a paid plan
  a saved snapshot is the checkpoint, with a price.

### Namespace

Not measured beyond one call: Namespace answered bb-box's own call to
suspend a Linux box's instance with HTTP 501, not implemented
([namespace-results.txt](box-snapshots/namespace-results.txt)). What
Namespace's docs and bb-box's code say:

- **What a box is there.** A Linux box is a Docker container in a Namespace
  instance of its own; a macOS box is an instance of its own; iOS boxes are
  slots on a Namespace Mac ([namespace/linux.ts](../../src/backends/namespace/linux.ts),
  [the guide](../guide/namespace.md)). An instance lives at most its plan's
  longest life, 3 to 24 hours, and bb-box destroys it at release. bb-box
  never stops one: the backend has no `stop`.
- **Suspend and wake.** The SDK documents `suspendInstance`: "Execution
  stops and RAM and disks are snapshotted so the instance can be restored
  without restarting it", and `wakeInstance`
  ([compute SDK](https://namespace.so/docs/reference/typescript-sdk/compute/manage.md)).
  It is one saved state, as a Mac's suspend is: no list, no older state, no
  fork. For bb-box's instance and token it answered 501, so it is either
  not offered for these instances or not to this token.
- **Volumes.** Persistent volumes are "automatically snapshotted on
  shutdown, and new volumes can be initialized from a specific snapshot"
  ([storage](https://namespace.so/docs/architecture/storage)). Cache volumes
  are caches, billed at $0.002 a GB-hour while attached and $0.0048 a
  GB-day stored ([pricing](https://namespace.so/pricing.md)). bb-box uses
  neither.
- **Devboxes**, Namespace's other product, snapshot at each start and
  restore to any of them ([changelog](https://namespace.so/changelog),
  10 June 2026). bb-box does not use
  Devboxes: they are a different API, with their own images and lifecycle.
- **What bb-box would build.** For a Linux box, a `docker commit` of the
  box's container in its instance, pushed to the workspace's registry,
  where bb-box already keeps its Linux images; a restore or a fork is a new
  container from it, in the same instance or a new one. Its Docker volume
  is lost, as on any Docker backend, unless copied. Registry storage is
  "accounted in blocks of 100 GB" (pricing). For a macOS box, nothing
  better than a copy of the home folder, and its life of at most a day
  makes a snapshot of little use.
- **What a measurement would add.** The time of a commit and push of a
  small box's container to the registry, and of a fork from it in a new
  instance: about 15 minutes of a `small` Linux instance, under $0.05.
  It would not change the recommendation: Namespace comes after the
  backends with native snapshots either way.

### The SSH host pool, iOS slots and device state

- **No root, so nothing native.** A pool machine is lent with a new user,
  and its reset removes that user, or on Linux can reset the whole machine
  ([ssh-pool/backend.ts](../../src/backends/ssh-pool/backend.ts), top;
  `restores` in [types.ts](../../src/backends/types.ts)). An iOS slot is a
  macOS user on a shared host, removed with everything it owns at release
  (064). A copy of the box user's home is all bb-box could take, without
  memory, and a restore would need the user's processes ended first.
  Not worth a first unit; the box says it has no snapshots.
- **iOS Simulator.** `simctl` has no saved state of a booted device; a
  device is a folder under `~/Library/Developer/CoreSimulator/Devices`, and
  `xcrun simctl clone` copies a shut-down one. Measured in an iOS slot:
  shutting the device down took 3.2 s, a clone 1.6 s, an APFS copy of its
  352 MB folder 1.0 s, and the clone booted in 2.5 s with a setting
  written before. So a device snapshot is cheap, but holds no running app,
  and takes the box's device down for a few seconds. A later unit at most.
- **Android emulator.** Its console saves and loads named snapshots of the
  device's disk and memory: 14.8 s and 2.5 GB to save, 3.2 s to load, with
  the open app and a setting put back. These live in the box's disk, so a
  Proxmox QEMU snapshot of an android box holds them too. bb-box could
  offer the device's own as the device box's snapshot, as it already uses
  Quick Boot.

## How it was measured

On 30 October 2026, through boxes from production BB's bb-box, each
released when done. Times are wall clock, from `date` before and after
each step on the machine that ran it, or bb-box's own timings for a stop
and a start. Sizes are from the storage itself.

- **Proxmox**: one `linux` LXC box and one `linux` QEMU box, 2 cores,
  4 GiB, 16 GiB, on a Proxmox VE 9.2 node with LVM-thin. bb-box's token
  cannot take snapshots, so [proxmox-snapshots.sh](box-snapshots/proxmox-snapshots.sh)
  was run by the lead as root on the node. It checks each VMID's tags name
  the box, uses a spare VMID outside bb-box's ranges for clones, and
  removes everything it makes. Each box held 1 GiB of random data on disk,
  the QEMU box 1.5 GiB more in `/dev/shm`. [Output](box-snapshots/proxmox-results.txt).
- **Docker**: [docker-snapshots.sh](box-snapshots/docker-snapshots.sh) in
  a Proxmox QEMU box, Docker 29.1.3, CRIU 4.3. [Output](box-snapshots/docker-results.txt).
- **microsandbox**: [microsandbox-snapshots.sh](box-snapshots/microsandbox-snapshots.sh),
  msb 0.7.7 in a Proxmox QEMU box with KVM. Nested, so slower than on a host,
  if anything. [Output](box-snapshots/microsandbox-results.txt).
- **Android**: the emulator's console in an `android` box.
  [Output](box-snapshots/android-results.txt).
- **boat.dev**: bb-box's own acquire, stop and start of a `small` box on
  the trial; bb-box's timings.
- **Tart**: a `macos` box on Tart (6 cores, 16 GiB), stopped and started
  through bb-box, and [tart-snapshots.sh](box-snapshots/tart-snapshots.sh)
  run by the lead as the Tart user on the Mac: an APFS copy of the
  suspended VM's folder, a clone, and a second run that put the copy back.
  [Output](box-snapshots/tart-results.txt). An `ios` box on a shared host,
  `simctl` in the slot. [Output](box-snapshots/ios-results.txt).
- **Hetzner and Namespace**: [hetzner-snapshot.sh](box-snapshots/hetzner-snapshot.sh)
  and [namespace-suspend.sh](box-snapshots/namespace-suspend.sh), run by
  the lead with bb-box's tokens, which the owner allowed for this; each
  checks the machine is the box's or bb-box's host, labels what it makes
  with none of bb-box's labels, and deletes it. [Hetzner](box-snapshots/hetzner-results.txt),
  [Namespace](box-snapshots/namespace-results.txt).

What limits the numbers: one run each; small boxes (4 GiB, a few GiB used);
LVM-thin only on Proxmox; nested KVM for microsandbox; a box's real data,
a desktop's 16 GiB or a build's tens of GiB, would make full clones,
memory snapshots and archives slower in proportion. A thin snapshot does
not grow with the box.

## The model

### What a snapshot is

A record bb-box keeps, beside the box's record and its log (069 unit 1b):

| Field | Example | Notes |
| --- | --- | --- |
| `id` | `sn` and 12 letters and digits | bb-box's, never the provider's |
| `box` | the box's ID, name and kind at the time | kept after the box goes, for a kept snapshot |
| `name` | "before the migration" | given, or made from the time; unique per box |
| `note` | free text | |
| `takenAt`, `by` | a time; the agent of a thread, or the person | as the box log records an actor |
| `holds` | `disk` or `disk-and-memory` | what a restore brings back |
| `size` | 1.2 GB | what it adds, where the provider says; else what it holds |
| `cost` | "free", "about $0.06 a month", "EUR 0.02 a month" | words, from the backend |
| `lives` | "on pve-1's storage", "on boat", "on mac-1" | where it is, for the person |
| `ref` | `bbsnap-<id>` on Proxmox, a folder on a Mac, a boat snapshot ID | the backend's, opaque to the core |
| `owner` | the box's thread, or the person | see below |
| `keptUntil` | null, or a date | set when the person keeps one |
| `picture` | a small JPEG of the screen | see [a picture of the screen](#a-picture-of-the-screen) |
| `state` | taking, ready, failed, deleting | |

A snapshot is not an image. It holds one box's state, secrets included,
and serves that box and its forks. A project's image stays a script (049).
"Make an image from this snapshot" is left out for 049's reasons.

### Who owns it

- **A thread's box**: the thread owns its snapshots. Its agent can take,
  list, restore, fork and delete them. Other threads cannot see them.
- **The person's machines** (036): the person owns them. A thread working
  on one may take one, which is the person's, and must ask before a
  restore.
- **The person** can see, restore, fork, keep and delete every snapshot,
  from the pages.
- **Projects** own none in the first units: sharing a state across a
  project's threads is what a project's image is for.

### Naming, retention and cleanup

- A snapshot is named by its taker or by the time ("Thu 10:42"), unique
  per box.
- **With its box.** A box's snapshots are deleted when the box is
  released, before or with its guest. On Proxmox a guest's destroy removes
  its snapshots anyway; on a Mac and with microsandbox and Docker bb-box
  removes them; on boat a delete removes them.
- **A thread's end** releases its boxes (003), and so their snapshots.
- **Kept.** The person can keep a snapshot past its box's release, for 30
  days by default, or until a date; then it is theirs, listed with its box
  gone, and can be forked into a new box of theirs. bb-box deletes it at
  its date, and warns 3 days before on the Snapshots tab. Not on backends
  where it would hold a host: an SSH pool has none anyway.
- **Quotas**, in Settings, per backend: snapshots per box (5 by default;
  the oldest goes when an agent takes a sixth, never a kept one), and
  space on each host for snapshots (20% of its free disk by default; a
  take that would pass it is refused with what to delete). On a provider
  that charges, a monthly ceiling in its currency, 0 by default, so boat's
  saved snapshots stay off until the person allows them.
- **The sweep** finds snapshots by labels or names that carry the install
  and box (018), as it finds guests: a snapshot whose box is gone and
  which is not kept is deleted, so a lost record leaves nothing behind.

### Across hosts and providers

A snapshot is usable only where it was taken: on its host for Proxmox,
Tart and microsandbox, on its account for boat. A fork goes to the same
host. Moving one is a later unit, through each provider's own export
(vzdump, `msb snap export`, `docker save`, `tart push`), and never across
providers: a Proxmox disk is not a boat sandbox. The record says where it
lives, and a host that leaves Settings makes its snapshots unusable, as it
makes its boxes.

### The capability

Each backend says, per kind, what it can do, with no call to a host, as
`resizing(kind)` does (061, [types.ts](../../src/backends/types.ts)):

```ts
interface Snapshotting {
  readonly holds: "disk" | "disk-and-memory";
  readonly memoryByChoice: boolean;
  readonly whileRunning: "yes" | "pauses" | "suspends" | "stops";
  readonly restore: "in-place" | "new-guest" | "no";
  readonly anySnapshot: boolean;
  readonly fork: boolean;
  readonly lives: "host" | "provider";
  readonly cost: string | null;
  readonly keepsFor: string | null;
}
snapshotting?(kind: string): Snapshotting | null;
snapshot?(guest: Guest, request: SnapshotRequest, signal?: AbortSignal): Promise<SnapshotTaken>;
restore?(guest: Guest, snapshot: SnapshotRef, signal?: AbortSignal): Promise<Guest>;
fork?(snapshot: SnapshotRef, box: BoxIdentity, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest>;
deleteSnapshot?(snapshot: SnapshotRef, signal?: AbortSignal): Promise<void>;
snapshots?(signal?: AbortSignal): Promise<readonly HeldSnapshot[]>;
```

`restore` returns the guest, which may be a new one ("new-guest"), so
boat, microsandbox and a Tart fork fit; the core keeps the box's ID, name
and record. `box_list` and `box_status` say per box what its snapshots
hold, as they say what it resizes.

## Three shapes, compared

| | A. Native, behind one model (recommended) | B. One portable format of bb-box's own | C. A provider's model, passed through |
| --- | --- | --- | --- |
| What it is | bb-box's record, verbs and rules; each backend uses its own mechanism and says what it offers | bb-box archives a box's files (or a disk export) to a store of its own, and restores or forks it on any backend of the kind | each backend shows its provider's snapshots as they are: boat's, Proxmox's, Tart's |
| Take | 0.3 to 4 s on Proxmox, microsandbox; 7 s for a Mac's suspend | 13 s for a small box (vzdump); minutes for a desktop | as A |
| Memory | where native: Proxmox QEMU, Tart macOS, microsandbox, Android | never | where native |
| Same everywhere | no: the box says what it gets | yes, for a kind | no, and the words differ |
| Moves between hosts | not at first | yes, within a kind | no |
| Secrets | stay on the box's own storage | in an archive away from the box | as A |
| Storage | changed blocks | a full archive each time | as A |
| Work | per backend, small | one big format, a store, and restores per backend | per backend, and a page per provider |
| Fits bb-box | as resize (061) and images (049): a capability and optional methods | against 001's "the core does not care", it puts a format in the core | against 001: the core would name providers |

B is the only one that moves and is the same everywhere, but it costs an
order of magnitude more per take, holds no memory, needs a store, and
copies a box's secrets off its storage. C is what a person would see if
bb-box did nothing: each provider's console. A keeps the speed of each
provider and one way to use them all, at the price of being uneven: the
SSH host pool, iOS slots and Namespace get nothing at first, and a Docker
box gets its files but not its own Docker's data until unit 10. B can come
later as the export of an A snapshot, for the moves that need it.

## Safety: a restore replaces a box's state

- **Say what goes.** Before a restore, bb-box says what it replaces: "Goes
  back to 10:42, 2 h ago. What changed since goes: files written, apps
  installed, and on a running box every process. [It comes back running,
  as it was then.]" with the last of these only for a memory snapshot.
- **A snapshot first.** A restore takes a snapshot of the state it
  replaces, named "before restoring to 10:42", unless asked not to or the
  quota is full. It is the undo.
- **The agent** restores its own thread's box without asking the person,
  as it can release it. It must pass `replace: true`, and the tool's answer
  says what was replaced and the undo's name. On a machine of the
  person's own, the tool refuses unless the person agreed in the thread,
  as release does today.
- **The person** confirms in a dialog that names the box, the snapshot,
  the time lost, the undo, and whether a thread is working on the box now
  ("Fix the sign-in flow is working on amber-fox. Restore it anyway?"),
  as 069's guard for Stop and Release.
- **The box log** records each take, restore, fork and delete with its
  actor, as it records stops and starts now (069 unit 1b).
- **After a restore** the box enrols again if its BB machine changed, as a
  restored record does (025, 026), and gets the thread's current access.
  A Proxmox rollback also puts back the guest's tags and description as
  they were, so bb-box writes the box's current owner and name on it again,
  as a relabel does (036), in case the box changed hands since.

## Security

What a snapshot of a box holds, from the code:

- **The thread's access**: `~/.config/bb-box/env`, mode 600, with the
  variables BB gives the thread's machine, GH_TOKEN among them
  ([core/in-box.ts](../../src/core/in-box.ts), `envFile`, `envScript`).
- **BB's machine credentials**: the daemon's folder under `~/.bb-machines/`,
  with `auth.json` and `host-id`. 017 clears only its lock and PID at boot.
- **A tailnet node**, where the box joined one (050): Tailscale's state.
- **SSH host keys, the machine ID**, bb-box's authorized key, and on boat
  the template's.
- **Memory**, in a memory snapshot: every process's environment, with the
  same tokens, and whatever the agent or a person typed.
- **Whatever the work put there**: a signed-in browser, cloud credentials,
  a project's `.env`.

What follows:

1. **A snapshot is as secret as its box.** It is listed only to its owner
   and the person. No other thread sees it, in `box_list`, the CLI or the
   pages.
2. **A restore of the same box** brings back old access, which bb-box
   writes again from the thread's current access, as each command does.
3. **A fork is a new machine.** Before a fork answers, bb-box removes BB's
   machine credentials, the env file, Tailscale's state and the SSH host
   keys, makes a new machine ID, and enrols it under its own box ID, as a
   new box; the source's node and machine are never reused. This is the
   same per-machine list 049's contract removes from an image, applied at
   start.
4. **No fork into another thread** in the first units: it would hand one
   thread's files and history to another. When it comes, the person
   chooses it, and the fork drops the env file and the BB credentials as in
   3.
5. **A kept snapshot** outlives its thread, so it outlives that thread's
   tokens' lifetime too: the Snapshots tab says it holds "files and access
   from the thread", and a fork of it gets the person's access, never the
   old thread's.
6. **Memory snapshots are by choice**, never the default for an agent:
   they hold more secrets, in a form nobody can review.
7. **Never on a provider's shared space**: boat's share codes and an
   organisation's shared saved snapshots are not used.

## A picture of the screen

The owner asked whether a snapshot should keep a picture of the box's
screen when it is taken. Yes: a thumbnail in the Snapshots tab and on the
box's page tells snapshots of one box apart better than their times.

| Box | How it is taken | Size |
| --- | --- | --- |
| A desktop | the viewer's last frame, if a viewer was open within 10 s; otherwise a screenshot through Cua Driver, as `computer_screenshot` takes one ([core/computer.ts](../../src/core/computer.ts)) | a 320 px wide JPEG at quality 70, about 15 to 30 KB |
| A device (iOS, Android) | the device server's screenshot, as for `computer_observe` ([core/device-computer.ts](../../src/core/device-computer.ts)); the emulator's own snapshot already holds a `screenshot.png` | the same |
| Headless | none: the row shows the kind's glyph | |

- **When.** At the take, before a memory snapshot pauses the box, so it
  shows what the snapshot holds. A failure to take one never fails the
  snapshot.
- **Where.** In bb-box's own storage beside the record, never on the
  provider, and deleted with it. A thumbnail adds about 30 KB a snapshot;
  100 snapshots, 3 MB.
- **What it shows.** Whatever was on the screen: a token in a terminal, a
  signed-in page, a password manager. It is as secret as the snapshot, shown
  only to its owner and the person, never in a notification, a log or the
  Monitor, and the agent gets it only by asking for its own box's
  snapshots.
- **Not for an agent's judgement**: `box_snapshots` lists no images by
  default, so a list does not cost an agent tokens; it can ask for one.

## The agent's tools and the CLI

| Tool | Does | Answers |
| --- | --- | --- |
| `box_snapshot` | takes one: `box`, `name`, `note`, `memory` (where offered) | its name, what it holds, its size, how long it took, and how many the box has of its quota |
| `box_snapshots` | lists a box's, or the thread's | each: name, time, by, holds, size, cost |
| `box_restore` | `box`, `snapshot`, `replace: true`, `undo` (default true) | what it replaced, the undo's name, and the box's state |
| `box_fork` | a new box of the thread from a snapshot, or from the box now (a snapshot is taken first) | the new box, as `box_acquire` answers |
| `box_snapshot_delete` | deletes one | what it freed |

`box_list` and `box_status` say per kind and per box what a snapshot
holds, or that the box has none, as they say what it resizes. The
skill tells the agent when to take one: before a change it cannot undo,
when the person asks, and never on a schedule of its own.

The CLI, for a person and for scripts: `bb box snapshot take|list|restore|fork|keep|delete`,
with `--machine` for one of the person's machines, as `bb box stop` has.

## The person's pages

### Where every snapshot is seen

| Option | For | Against |
| --- | --- | --- |
| **A Snapshots tab on the Boxes page, beside Machines and Threads (recommended)** | one list across boxes, providers and kept ones; cleanup in one place; the page already has search, filters and sort (069) | a third tab |
| Only on each box's page | close to the box | a kept snapshot has no box; space and cost across boxes are invisible |
| In Settings, as storage | beside quotas | Settings is for configuration; a person looks for their things on the Boxes page |
| Nested under each box's row | no new tab | rows grow; kept ones have no row; 069 keeps rows short |

### The Snapshots tab

```
Boxes                                         [Machines] [Threads] [Snapshots]
14 snapshots, 9 by agents · 38 GB on 3 hosts · about $0.11 a month

[Search snapshots       ] [All boxes v] [All providers v] [Holds v] [Sort: newest v]

● amber-fox · Linux desktop · Proxmox LXC on pve-1
  [pic]  before the migration      disk             Today 10:42 · Fix sign-in flow (agent)
         1.2 GB · free · on pve-1 · goes with the box        [Restore…] [Fork] [...]
  [pic]  Thu 09:15                 disk             Thu 09:15 · You
         3.4 GB · free · on pve-1 · kept until 29 Nov        [Restore…] [Fork] [...]

● silver-pine · macOS · Tart on mac-1
  [pic]  after Xcode signed in     disk and memory  Today 08:03 · Build the iOS app (agent)
         7.9 GB · free · on mac-1 · goes with the box        [Restore…] [Fork] [...]

○ grey-ridge (released) · Linux · boat.dev
  [ - ]  release candidate setup   disk             12 Oct · You
         $0.056 a day · on boat · kept until 11 Nov · goes in 3 days    [Fork] [...]
```

`[pic]` is the snapshot's picture of the screen, 64 px wide, opened full
size with a click; `[ - ]` is a headless box's glyph.

- **A row**: the snapshot's name, what it holds, when and by whom (the
  person, or the thread's title with "(agent)", which opens the thread),
  its size, its cost where a provider charges, where it lives, and its
  expiry: "goes with the box", or "kept until 29 Nov". Grouped under its
  box, with the box's kind, provider and host; a released box's group says
  "(released)" and offers no Restore.
- **Filters**: box, provider and host, holds (disk, disk and memory), who
  (you, agents), kept, expiring within 7 days. **Sort**: newest, oldest,
  largest, cost, box.
- **Actions**: Restore… (the dialog below), Fork (a new box, in the
  thread the person chooses or as one of their machines), and in the menu
  Rename…, Note…, Keep… (a date), Stop keeping, Delete… ("Frees 3.4 GB on
  pve-1"). Several selected: Delete and Keep.
- **The line under the title** says the count, the space by host and the
  cost a month, as 069's line says the boxes.
- **Agent-made snapshots** show with the thread that made them and its
  title; the tab's own line counts them ("9 by agents"), and a filter shows
  only them. An agent's snapshots never ask the person anything when
  taken: they show here, and in the box's log.

### On a box's page (069)

A Snapshots section after Facts, and Take snapshot in the header's menu:

```
Snapshots · 2 of 5 · 4.6 GB on pve-1                              [Take snapshot]
  [pic] before the migration  disk  Today 10:42 · Fix sign-in flow (agent)  1.2 GB  [Restore…] [...]
  [pic] Thu 09:15             disk  Thu 09:15 · You · kept until 29 Nov     3.4 GB  [Restore…] [...]
  Snapshots hold the disk. They go when the box is released, unless kept.
```

A box whose backend has none says so in one line: "Boxes on the SSH host
pool have no snapshots."

Take snapshot opens a small dialog: a name (the time by default), a note,
and "With its memory" where offered, with what it costs, from the
backend's `snapshotting`: on Proxmox QEMU "about 4 s; the box pauses for a
moment; up to 4 GiB more on pve-1"; on a Mac "the box suspends and
resumes, about 20 s; up to 16 GiB more on mac-1".

The restore dialog:

```
Restore amber-fox to "before the migration"?

It goes back to today 10:42, 2 h 5 min ago. What changed since goes:
files, installed apps, and every process, as the box restarts.
Fix sign-in flow is working on amber-fox now.

[x] Take a snapshot of it now first ("before restoring to 10:42")

                                          [Cancel] [Restore amber-fox]
```

### Settings (067)

A Snapshots page in Settings, one step in from the overview, as each
option is: per backend, snapshots per box, space for snapshots on each
host, the monthly ceiling where a provider charges, and how long Keep
keeps by default. Each backend's own page says what its snapshots hold
and cost, from its `snapshotting`.

## Build units

Sized as PRs (S small, M a usual one, L large), each with its docs and
tests, each checked live on the real backend.

| # | Unit | Size |
| --- | --- | --- |
| 1 | The record, the store, the picture of the screen and the box log's events; `Snapshotting` in the interface; `box_list` and `box_status` say what a box's snapshots hold; the sweep's cleanup by label; no backend yet | M |
| 2 | Proxmox LXC and QEMU: take (disk; QEMU memory by choice), restore with a hard stop first, delete, delete with the guest, `held` snapshots by name; `VM.Snapshot` and `VM.Snapshot.Rollback` in `setup-token.sh`, and a doctor check | M |
| 3 | The agent's tools and the CLI: `box_snapshot`, `box_snapshots`, `box_restore` with its undo, `box_snapshot_delete`; the skill's words | M |
| 4 | The box page's Snapshots section, Take snapshot and the restore dialog (069) | M |
| 5 | The Snapshots tab, Keep and expiry, and Settings' Snapshots page with quotas (067) | L |
| 6 | Forks: `box_fork` and Fork on the pages, Proxmox full clones of a snapshot, and the identity reset before a fork answers | M |
| 7 | Tart: macOS snapshots as APFS copies of a suspended VM, beside the VMs on their volume, with memory; Linux VMs disk only; a fork by `tart clone` that drops the saved state and takes a new MAC address; a guard against a state saved under another macOS build | M |
| 8 | microsandbox: native snapshots, restore as a new guest, fork | S |
| 9 | boat: a stopped fork as the trial's checkpoint, a saved snapshot on a paid plan within the ceiling, restore by a new guest | M |
| 10 | Docker, Hetzner and Namespace Linux boxes: commit with a copy of the Docker volume; restore by a new container | M |
| 11 | Android devices' own snapshots in device boxes | S |
| Later | Moving a snapshot between hosts by export; forks into another thread; iOS | |

## Open questions for the owner

1. **May an agent restore its own box without asking?** Default: yes,
   with `replace: true` and an undo taken first; never on a machine of
   yours without your yes in the thread.
2. **Memory snapshots by default where offered?** Default: no; disk only
   unless the agent or the person asks, as memory holds more secrets and
   takes more space.
3. **How long does Keep keep?** Default: 30 days, renewable; only a person
   keeps one.
4. **Paid snapshot storage**, such as boat's saved snapshots at $0.056 a
   day: allowed? Default: a ceiling of 0, so none until you set one.

## A draft of the decision

070: A box's snapshots are bb-box's own records, taken by each backend's
own mechanism, kept with the box unless a person keeps them.

- A snapshot is a record of bb-box's: an ID, its box, a name and note,
  when and by whom, what it holds, its size, cost and place, its owner and
  expiry. It is not an image, and never becomes one.
- Each backend says per kind what its snapshots hold and can do
  (`snapshotting`), and takes, restores, forks and deletes them with its
  own mechanism. A backend with none says so, and its boxes have none.
- A thread owns its boxes' snapshots; the person owns their machines' and
  every kept one. No thread sees another's.
- A box's snapshots go with its release, unless kept; kept ones expire.
  Quotas per box and per host, and a cost ceiling per provider, are
  settings.
- A restore says what it replaces, takes an undo snapshot first, and is
  recorded in the box's log. An agent passes `replace: true`; a person
  confirms.
- A fork is a new box with a new identity: no BB machine, access, tailnet
  node or host keys of its source.
- The person sees every snapshot on a Snapshots tab of the Boxes page, and
  a box's own on its page.
- First: Proxmox LXC and QEMU. Then Tart, microsandbox, boat, Docker
  backends and Android devices. Not the SSH host pool or iOS slots.
- Moving a snapshot between hosts, and forks into another thread, are
  later.
