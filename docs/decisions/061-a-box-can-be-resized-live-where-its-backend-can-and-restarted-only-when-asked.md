# 061: A box can be resized after it is made, live where its backend can, and restarted only when asked

Status: proposed, 19 October 2026 (#868). Extends
[028](028-a-box-size-is-chosen-when-it-is-made.md), which left changing a
running box's size as a later step.

## Context

People and agents choose a box's size (cores, memory and root disk) when
they make it (028). Afterwards nothing changes it, though most backends
can. The owner wants a box resized in place: from the panel, by an agent
with a tool, and from the CLI. The owner will try it first by asking the
agent on one of their machines, a `linux-desktop-cpu` box on Proxmox LXC
kept with `bb box machines`, to resize that machine while the agent runs
on it.

### What each backend does, measured

Measured on 19 October 2026 with test boxes. Host commands ran on the
hosts, and each box logged what it saw every 2 seconds, with a process
started before the change to show whether it lived.

**Proxmox LXC** (Proxmox VE 9.2, a `linux-desktop-cpu` box at 4 cores,
8 GiB and 24 GiB, with its desktop up, BB's daemon running and 3 GiB held
by a test process):

| Change | What the box saw |
| --- | --- |
| `pct set` 6 cores, 12 GiB | 12 GiB in `/proc/meminfo` after 1 s; 6 cores after 7 s, when Proxmox next spread the guests' CPUs |
| `pct resize` the root disk to 32 GiB | 32 GiB in `df /` after 3 s: Proxmox grows the file system online |
| `pct set` 2 cores, 3 GiB, below the 4.3 GiB in use | 3 GiB at once; use fell to 3 GiB as the kernel reclaimed cache and filled the 512 MiB of swap; nothing was killed; 2 cores after 11 s |
| `pct set` back to 4 cores, 8 GiB | at once, and 4 cores after 4 s |

Every process lived through all four, the desktop's X server and BB's
daemon included. Proxmox refused nothing, not even memory below use. A
warm guest's claim (028) already makes the same changes on a running
guest: in another check, a box served warm at 6 GiB and 40 GiB was
resized in 0.8 s.

**Docker** (Docker 29.8 with cgroup v2, a box at 2 cores and 4 GiB, with
2.5 GiB held by a test process):

- `docker update --cpus --memory --memory-swap` applied within 4 s, as
  the box's cgroup (`cpu.max`, `memory.max`). `nproc` and `/proc/meminfo`
  show the host's CPUs and memory before and after.
- Memory below use was accepted, and the kernel's OOM killer ended the
  largest process at once. Here that was the test process. In a real box
  it could be the work the box is for.
- `/dev/shm` keeps the size it was given at create, half the memory then.
  `docker update` cannot change it.
- A Docker box has no disk of its own (028).

**Proxmox QEMU**, a Linux VM (2 cores, 4 GiB, 16 GiB) and a Windows 11
Pro VM (4 cores, 8 GiB, 64 GiB), as bb-box's templates make them today:

- `qm resize` grew each disk while the VM ran, and each guest saw it at
  once. In Linux, `growpart` and `resize2fs` grew `/` online. In Windows,
  bb-box's own `extendC` steps moved Windows RE out of the way and grew C:
  online, in 8 s.
- `qm set` cores and memory on a running VM is only pending: the
  templates have no CPU or memory hot-plug. A bb-box stop and start is a
  hibernate and a resume, which kept the session and the old size. A cold
  boot (shut down, then started through bb-box) applied it: 8.3 s for
  Linux, 15 to 20 s for Windows, which came back logged in at its
  desktop. bb-box recorded each as a stop it had not asked for.

With hot-plug turned on (`hotplug` with `cpu,memory`, `numa 1`, and fewer
`vcpus` than cores), after one cold boot:

- Linux: hot-added memory came online by itself, 8 to 12 GiB live.
  Hot-added CPUs arrived but stayed offline, as Ubuntu's rule brings them
  online only on Hyper-V and Xen. Taking memory away mostly failed (12 to
  11.4 GiB, not 8), and CPUs were not removed.
- Windows 11 Pro: hot-added memory showed at once (12 to 16 GB). Added
  CPUs did not: Windows' client editions take no CPU hot-add. Taking
  either away failed, and Proxmox left both pending ("error unplugging
  cpu8", "error unplug memory module").

**Tart** (Tart 2.30 on a Mac). `tart set` changes the VM's configuration
file and takes effect when the VM next starts. It does not check whether
the VM runs.

- Linux on arm64: a bb-box stop shuts the VM down. `tart set` with 4
  cores, 8 GiB and 70 GB, then a bb-box start (4.5 s), gave 4 cores and
  8 GiB. Tart's disk sizes are decimal: 70 GB is 65.2 GiB. Nothing in the
  image grew the partition at boot, and `growpart` with `resize2fs` grew
  it online afterwards.
- macOS: not yet checked live, as no Mac had room while this was written.
  A bb-box stop suspends a macOS VM, and keeps its memory in a saved
  state, which a VM of another size cannot restore. bb-box already drops
  a saved state that does not restore, and boots the VM afresh. So a new
  size for macOS means a restart that loses the session. Its disk is
  harder: macOS's recovery partition sits after the system's APFS
  container, and Tart's own advice for a larger disk is to delete it from
  recoveryOS, then grow the container. bb-box gives macOS boxes their
  image's disk for now (028).
- Windows on a Mac runs in QEMU through bb-box's own scripts (046), not
  Tart: its cores and memory are QEMU's arguments when it starts, and a
  stop saves its memory to a file, which a new size cannot restore.

**microsandbox** (msb 0.7.7, a box at 2 cores and 4 GiB). msb 0.7.7 has
`msb modify`, which plans a change (`--dry-run`), applies what it can
live, and saves the rest for the next start with `--next-start`:

- Cores and memory: every change needed a restart, up or down, with the
  warning "live CPU and memory resize are not available in this runtime
  yet". This is so although the guest kernel has the drivers for both
  (`virtio_msb_cpu` and `virtio_mem`), and msb's own design changes them
  live within the maximums a sandbox starts with. bb-box starts its boxes
  with no maximums of their own, so those are their sizes too.
- With `--next-start`, then a bb-box stop and start (1.8 s), the box had
  4 cores and 8 GiB, and Docker in it answered.
- The root disk grew live, from 32 to 40 GiB, and the guest's `/` showed
  40 GiB at once.

**SSH host pool.** A pool lends a whole machine, which has the size it
has.

## Decision

### What a resize is

- A resize gives an existing box a new size: a preset, or cores, memory
  and disk. Any part left out keeps what the box has, not the default
  preset, unlike an acquire. A preset's disk is the base, so a preset
  leaves the disk as it is.
- The same limits as an acquire (028): whole numbers, at least 2 GiB of
  memory for a Linux kind, and at most the kind's largest. The box stays
  on its host: a resize never moves it.
- The disk only grows. A smaller disk is refused, naming the disk the box
  has. A box at its base disk (`diskGiB` null) can grow to a number.
- The growth needs room on the box's host, by the same rules and reserves
  as an acquire, counting only what the box grows by. A shrink always
  fits. While a resize runs, its growth counts as pending for acquires on
  that host, as a warm claim's does (028).

### Live, after a restart, or not at all

Each part of a size changes in one of three ways on each offer of a kind:

- **live**: the box keeps running, and so does everything in it;
- **restart**: the box is shut down cleanly, changed and started again,
  which ends everything running in it. This is never the stop that keeps
  a session, as a hibernate or a suspend does: the new size would not
  apply, or the saved session would not restore;
- **no**: the offer cannot change it.

| Backend | Cores | Memory | Disk (grow) |
| --- | --- | --- | --- |
| Proxmox LXC | live | live | live |
| Docker | live | live | no |
| Proxmox QEMU, Linux and Windows | restart | restart | live |
| microsandbox (msb 0.7.7) | restart | restart | live |
| Tart, Linux | restart | restart | restart |
| Tart, macOS | restart | restart | no |
| Tart, Windows (QEMU) | restart | restart | restart |
| SSH host pool | no | no | no |

A resize that needs a restart for any part is done only when the caller
says so: `restart: true` in the tool, `--restart` in the CLI, and a
confirmation in the panel. Without it, bb-box changes nothing and says
which parts need a restart and roughly how long the box will be down.
bb-box never applies the live parts and leaves the rest: a resize is
whole or not at all.

A stopped box changes while stopped where its backend can: Proxmox LXC,
Docker, microsandbox, and Tart's Linux VMs, which are shut down when
stopped. Its new size
applies when it starts, with no restart to ask for. A box whose stop kept
its session (a hibernated Proxmox VM, a suspended macOS VM, a Windows VM
on a Mac with its memory saved) loses that session to a resize, so that
counts as a restart.

### The interface

`src/backends/types.ts` gains:

```ts
/** How a part of a box's size changes on an offer (061). */
export type ResizeWay = "live" | "restart" | "no";

export interface Resizing {
  readonly cores: ResizeWay;
  readonly memory: ResizeWay;
  /** The disk only grows. */
  readonly disk: ResizeWay;
  /** Whether cores and memory can also go down live. */
  readonly shrinks: boolean;
}

/** What a resize of one box would do, before anything changes. */
export interface ResizePlan {
  /** Each part that changes, and how. */
  readonly parts: readonly { readonly part: "cores" | "memory" | "disk"; readonly from: number | null; readonly to: number; readonly way: ResizeWay }[];
  /** Whether one more box's growth fits on the box's host, as capacity says it. */
  readonly room: Capacity;
  /** A restart's expected length, in seconds, when a part needs one: about 2 for microsandbox, 5 for Linux on Tart, 8 for a Linux VM and 20 for Windows, as measured. */
  readonly downSeconds: number | null;
}
```

and `Backend` gains three optional methods:

- `resizing(kind): Resizing | null`: what the offer can do, from what the
  backend holds, with no call to any host. Null, or the method missing,
  means no part changes. box_list, `bb box kinds` and the panel show it.
- `planResize(guest, kind, to, pending, signal): Promise<ResizePlan>`:
  the ways for this box and the room for its growth. It changes nothing.
  A backend whose ways depend on the box says so here, such as
  microsandbox's live maximums.
- `resize(guest, kind, to, options: { restart: boolean }, hooks, signal): Promise<Guest>`:
  makes the change and returns the guest with its size read back from it.
  Like every method, it is safe to repeat: a part already at its target is
  left alone. It refuses a part whose way is restart unless `restart` is
  true, and grows the file system with the disk.

### The tool, the CLI and the panel

- `box_resize` takes the box, a size as `box_acquire` does (`size`,
  `cores`, `memory_gib`, `disk_gib`), and `restart`. With `check: true` it
  only answers what the resize would do: each part's way, the room, and
  how long a restart takes. Its answer gives the box's new size, as
  `box_status` shows it, and what changed live.
- `bb box resize <box>` takes the same, as `--size`, `--cores`,
  `--memory-gib`, `--disk-gib`, `--restart` and `--check`, with `--thread`
  for another thread's box. `bb box machines resize <machine>` does the
  same for one of your machines. Both take `--force` as `bb box release`
  does (034).
- The Box panel and settings' Machines get a Resize action, which the
  design work draws later. It shows the presets, the largest size, each
  part's way and the room, and asks before a restart: "Restart
  <box> to resize it? Everything running in it stops, and it is back in
  about N s."
- box_list and `bb box kinds` say per kind what can be resized and how,
  such as "Resize: cores, memory and disk live" or "Resize: disk live;
  cores and memory after a restart". `box_status` and the panel show the
  box's size as now, and the last resize's time and any error.

### Rules

**Memory below use.** A live shrink of memory is refused when the box
uses more than the new size less a margin: the larger of 512 MiB and 10%.
bb-box reads the use from the box itself (the cgroup's `memory.current`,
or `MemTotal` less `MemAvailable`). Docker's OOM killer ends a process at
once, and an LXC box with little swap left thrashes. A restart has no
such limit, as nothing runs.

**A person in control.** A live resize goes ahead: it does not touch the
desktop, whose X server lived through every live change above. A restart
is refused while a person holds the box's control, unless the person
asks for it in the panel. The tool says that a person is using the box.

**Threads on the box (034).** A live resize goes ahead: BB's daemon lived
through every live change above. A restart is refused while a thread is
working on the box, naming it, as box_stop is. A person can force it from
the panel or with `--force`. After a restart the box reconnects to BB as
after any start (017), and an idle thread on it carries on.

**The box an agent runs on.** In a thread that runs on a box's machine,
`box_resize` takes that box, as the box tools do (036). A live resize
goes ahead, and the agent's session goes on. A resize that needs a
restart is refused, as it would end the call that asked for it:

> Resizing calm-otter needs a restart, which would end this thread's
> session on it. Ask the user to resize it from the Box panel, or from
> BB Box's settings under Machines, which restarts it; the thread's
> session comes back once it is up.

So the owner's first try, an agent on a Proxmox LXC machine resizing that
machine, is live in every part, and only a shrink of memory below use is
refused.

**Running commands and jobs.** A live resize leaves them running. A
restart ends them, box_run calls in flight among them, and the answer
says so. Calls made while the box restarts wait until it answers again,
as during a start.

**The desktop's display.** A live resize leaves it alone. After a
restart, viewers reconnect as after a start. A desktop's own resolution
is not part of a box's size.

**Warm pools and spares.** A resize changes only the box. Warm guests keep
their size, and a box made from one resizes like any other. A spare,
which is no thread's, is not resized: it takes its size when it is
claimed (028).

**The size bb-box keeps.** Before it changes anything, bb-box records the
resize on the box: the size asked for, and when. Afterwards the box's
recorded size (`BoxRecord.size`) becomes the new one, and its guest's
size is read back from the guest. Capacity follows by itself: Docker and
microsandbox count the limits of the running boxes, Tart the memory of
its running VMs, and Proxmox the node's own figures.

### Failure

A resize is put back, or reported plainly, and never leaves the box worse
off than it found it:

- bb-box checks the plan and the room first, and changes nothing when
  either refuses.
- It changes the parts that can be put back first (cores, then memory),
  and grows the disk last, as a disk cannot shrink again.
- When a later step fails, bb-box puts the earlier parts back and says
  what failed. A disk that grew stays grown, and the answer says so.
- When a box does not come back after a restart with its new size, bb-box
  puts the old size back and starts it again, then reports both.
- A resize cut short by a restart of bb-box is found from its record, and
  the box's size is read back from the guest. Its record then holds what
  the guest has, with the error.

## Consequences

- A box made too small no longer needs releasing and making again.
- The owner's case works first: Proxmox LXC is live in every part.
- Each PR adds a conformance check: resize a box larger, then smaller,
  live where the offer says, and check with the suite's measure (028) that
  the box has the new size within 15 s, and that a process started before
  a live resize still runs. A restart's check also checks that the box
  answers and is still the same box.
- Docker boxes' `/dev/shm` stays at half their first memory. Making it
  follow would need the container made again, which a live resize does
  not do.
- QEMU VMs need a restart for cores and memory. Hot-plug would make
  memory growth live, for Linux and Windows alike, but not CPUs on
  Windows, and not shrinking. Turning it on is a template change, left for
  later and asked about first.
- The Tart Linux image does not grow its partition at boot: bb-box grows
  it after the start, as the QEMU Linux image's boot script does.

### Left open

- Turning on hot-plug in the Proxmox QEMU templates, for live memory
  growth. It would need each VM's NUMA layout set at its first boot, and
  CPUs brought online in Linux by bb-box or a udev rule. It is an image
  change, so the owner decides.
- Starting microsandbox boxes with maximums above their size, once msb's
  runtime changes cores and memory live. msb 0.7.7's does not.
- Growing a macOS box's disk, which needs its recovery partition moved.

### The order to build it

Small PRs, each with its conformance check:

1. Core, the interface, `box_resize`, `bb box resize` and `bb box machines
   resize`, with Proxmox LXC: all live.
2. Docker: cores and memory live.
3. Proxmox QEMU, Linux and Windows: the disk live, and cores and memory
   with a restart.
4. microsandbox: the disk live, and cores and memory with a restart.
5. Tart: Linux, then macOS, then Windows on a Mac.
6. The panel's Resize action, once the design work has drawn it.
