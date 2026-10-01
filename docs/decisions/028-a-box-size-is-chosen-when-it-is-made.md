# 028: A box's size is chosen when it is made, from presets per kind

Status: accepted, 1 October 2026. Partly supersedes
[011](011-interface-v1.md): a kind's `size`, and what `capacity` is asked.
Extended by
[039](039-windows-desktops-are-clones-of-a-template-that-is-not-generalized.md)
and [040](040-linux-on-arm64-has-kinds-of-its-own.md): the presets of the
Windows and arm64 kinds.

## Context

Each offer makes one size of box. Proxmox LXC takes cores, memory and disk
per template flavour from its settings, and the kind shows them as words in
`BoxKind.size`. The operator asked for people and agents to choose a box's
size when they make it, from presets or a custom size within limits, in the
panel and in `box_acquire`.

What the backends can do:

- Proxmox LXC sets cores and memory at clone and changes them while a guest
  runs, so a warm guest can take any size when it is claimed. It grows the
  root disk in about a second, but cannot shrink it below the template's.
- Docker sets CPUs and memory at create, and `docker update` changes them
  while the container runs. It limits the root disk only on some storage
  setups, such as overlay2 on XFS with project quotas, Btrfs or ZFS.
- Tart sets CPUs, memory and disk with `tart set` before a VM runs, so a
  suspended warm clone has the size it was made at.
- An SSH pool machine or a physical Mac has the size it has.

## Decision

- A size is cores, memory and root disk:
  `BoxSize { cores, memoryMiB, diskGiB }`. `diskGiB` null means the
  backend's base disk: the template's or image's, or the host's where the
  backend cannot limit it. A disk asked for below the base gets the base.
- Each kind has three presets, `small`, `medium` and `large`, a default
  preset, and a largest custom size, in bb-box's configuration. They are the
  same on every offer of the kind, so `large` means one thing. Presets leave
  the disk at the base. bb-box ships:

| Kinds | `small` | `medium` | `large` |
| --- | --- | --- | --- |
| `linux`, `linux-docker` | 2 cores, 4 GiB | 4 cores, 8 GiB | 8 cores, 16 GiB |
| `linux-desktop`, `linux-desktop-cpu` | 4 cores, 8 GiB | 8 cores, 16 GiB | 16 cores, 32 GiB |
| `macos`, `macos-desktop` | 4 cores, 8 GiB | 6 cores, 16 GiB | 8 cores, 32 GiB |

- The default preset is `small`, which is the size Proxmox LXC makes today.
  The largest custom size is twice `large`'s cores and memory, and 256 GiB
  of disk. The Windows kinds get theirs with their backend.
- `box_acquire` and the panel take a size: a preset's name, or a custom
  size, where any part left out comes from the default preset. No size
  means the default preset. Core refuses a custom size above the kind's
  largest, naming the presets and the largest.
- The backend interface:
  - `BoxIdentity.size` is the size asked for, always complete.
  - `capacity(kind, size, pending)` says whether one more box of that size
    fits. `pending` gives the kind and size of each of the backend's boxes
    still being acquired.
  - A virtual backend makes the size asked for. A pool claims its smallest
    free machine that is at least that size, which may be larger.
  - A machine has a size's memory when its OS reports at least 90% of it.
    The firmware and kernel keep some, so an 8 GiB machine reports about
    7.7 GiB, and a VM's total is below what it was given.
  - `Guest.size` is the size the box has, read from the guest, or null when
    the backend cannot tell. `held()` reads it too, so a restored record has
    it ([019](019-lost-records-are-restored-from-guests.md)) without a label
    for it.
  - `BoxKind.size` goes. Core shows the kind's presets, and each box's own
    size.
- An offer that cannot make a size says so in capacity's message, and the
  registry tries the next offer, as when one is full. Offers declare no
  limits of their own: capacity is where a backend refuses.
- A backend that cannot limit the disk takes a disk size when its host has
  that much free, and gives the box the host's disk, with `diskGiB` null.
- A warm guest serves a size its backend can set when it is claimed. Proxmox
  LXC's serve any size: claiming one sets cores and memory and grows the
  disk. Tart's suspended clones serve only the default preset, so another
  size makes a new clone. A warm guest made larger on claim needs room for
  the difference, which capacity counts.
- Proxmox LXC's cores, memory and disk settings per flavour go. Their saved
  values become the default preset's size for the flavour's kinds, once.
  The `warm` setting stays. Until
  [029](029-configuration-is-one-checked-document.md)'s document, the
  presets are kept in the general setting `box-sizes`.

## Consequences

- A box made at the default preset starts as quickly as before.
- 011 let the size differ between offers of a kind. A preset is now the same
  on every virtual offer; a pool gives at least the size.
- The Docker, SSH host pool and Tart backends take the size in their first
  version, or refuse every size but the default through capacity until they
  do.
- The conformance suite makes a box at a preset other than the default and
  checks what the box sees: cores (`nproc`), memory (its cgroup's
  `memory.max`, or the VM's total) and disk (`df /`), or at least those for
  a pool. Memory counts by the 90% rule. Capacity must refuse a size larger
  than any host.
- Tool output, `box_status` and the panel show each box's size, such as
  "4 cores, 8 GiB memory, 32 GiB disk".
- Changing a running box's size is a later step: Proxmox LXC and Docker can
  do it live, Tart only while stopped, and a pool not at all.
- The per-thread limit still counts boxes. A size budget per thread is not
  part of this.
