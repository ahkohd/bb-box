# 106. Proxmox guests wait for free host memory, and heavy VMs boot one at a time

Status: Accepted  
Date: 2026-11-27

## Context

On a Proxmox node whose running guests' memory limits exceed physical RAM, booting several heavy VMs (such as Windows desktops with `balloon=0`, which fault all of their configured RAM during boot) within minutes of one another can exhaust host memory and freeze the node under page-fault thrashing. Proxmox's `MemAvailable` stays artificially high for minutes after a heavy VM starts because the guest has not yet touched all of its pages.

BB Box previously checked `MemAvailable` only once before cloning, against `reserve-memory-mib` (default 4 GiB), and started guests concurrently across Proxmox LXC and Proxmox QEMU. That left no protection against back-to-back heavy boots, ignored untouched RAM of recently started heavy VMs, and let warm refills, restores, forks, resumes, resizes and image trials start without re-checking host memory.

## Decision

Every Proxmox guest start on a node passes through one shared start gate (`src/backends/proxmox/start-gate.ts`) stored on `Backends` through `BackendContext.shared`, keyed by normalised API host and Proxmox node. `Proxmox.start` and `Proxmox.startRollbackWithMemory` (used when rolling back a QEMU snapshot with `vmstate`, which Proxmox starts automatically) require a gate-issued `StartPermit`, and `OwnedGuests.start` gates GPU-helper starts as well, so no path can bypass the gate.

- **Node-derived recent heavy boots:** the gate reads running QEMU VMs from the node (`/nodes/<node>/qemu`) rather than keeping recent-boot history only in process memory. Any running heavy VM (Windows, Android, or a QEMU VM with `balloon=0` and memory over 4 GiB) whose uptime is under 10 minutes holds its untouched RAM (`max(0, maxmem - mem)`) against the next start, whoever started it, as long as the backend's token can see it: Proxmox lists only the VMs the token may audit, which `setup-token.sh` grants on the install's pool. VMs outside the pool count only through the memory they have already touched, which shows in MemAvailable. Guests the gate has admitted that are still starting count with their full memory until they finish starting, and a guest already starting is never admitted twice. A failed read of the node admits nothing: waiters keep waiting, and fail at the end of their wait. Containers and ballooned Linux VMs never count as held, because their memory is a ceiling rather than preallocated RAM.
- **Heavy boot serialisation:** at most one heavy VM starts per node at a time, and the next heavy start waits until no running heavy VM on the node has an uptime under `heavy-start-settle-seconds` (default 120 s). Stopping or destroying a heavy VM frees its settle slot immediately. Containers never wait for the heavy settle delay, but still pass the memory check.
- **Effective margin across placement, doctor and gate:** the effective start memory margin is `start-memory-margin-mib` (default 16384 MiB) capped at a quarter of the node's total memory. Placement refuses before cloning with the same effective margin and setting name; `proxmox.memory` in `bb box doctor` reports the effective margin and fails when it leaves no room for the smallest configured preset size.
- **Queueing without head-of-line blocking:** the in-process queue serialises admission decisions (not the full Proxmox start task) and starts the first of a thread's waiters, in arrival order, that fits now. A refill never starts while a thread's start is waiting; refills use a wait of 0 s, so they give up and try again at the next top-up. A failed read of the node admits nothing: waiters show that they are waiting to read the node and fail at the end of their wait, or at once when Proxmox refuses the read (a 4xx answer). Wait time is wall-clock time since joining the queue, polled at least every 10 s up to `start-memory-wait-seconds` (default 600 s), with `waitingOn` progress shown on acquires, starts and restores. `box_acquire`'s readiness wait pauses its boot timer while `waitingOn` is set. On timeout the start fails with `BackendError("no_capacity")` and never starts anyway. Signal aborts end waits at once.
- **Refills, resizes and refreshes:** warm and spare refills ask the gate whether a start would be admitted now before cloning and use a wait of 0 s, retrying at the next top-up. QEMU resize rollbacks pass their abort signal and use a wait of 0 s. Image refresh answer timing measures from when the gate admitted the start so queue waits never fail the speed check.

## Consequences

- Multiple BB Box installs and manual VM starts on the same Proxmox node coordinate through live node status and guest uptimes without extra host files or locks.
- Small Proxmox hosts (16 GiB or 32 GiB) work with the default settings because the margin caps at a quarter of total RAM, and impossible sizes are caught at placement and by `bb box doctor`.
- A large waiting VM does not stall smaller containers that fit now, and a slow Proxmox start task does not block unrelated admission decisions.
- Refills stop cloning and deleting guests on tight hosts, and GPU card reservations on Proxmox LXC are taken only once the start gate admits the start.
