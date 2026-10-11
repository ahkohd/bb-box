# 057: Linux boxes can be Proxmox VMs, for their own kernel

Status: proposed, 11 October 2026.

## Context

bb-box makes Linux boxes as Proxmox LXC containers, Docker containers,
microsandbox microVMs (053) and SSH pool machines. The operator wants every
shape on offer, and one is missing: a Linux box that is a full VM on
Proxmox. The Proxmox QEMU backend makes only Windows VMs (039), from a
template refreshed in a box (054), with hibernated spares (#539).

What a VM gives that the others do not:

- its own kernel, whose version the box chooses, and kernel modules it can
  load, such as for a filesystem, WireGuard or eBPF work
- KVM inside the box, when the host allows nested virtualization, so a box
  can run its own VMs, Android emulators or Firecracker
- systemd as on a real machine, with no container limits on cgroups,
  mounts or devices
- a whole GPU passed through to the box, later

What it costs, against what is there:

| | LXC | microsandbox | QEMU VM |
| --- | --- | --- | --- |
| Isolation | shared kernel | own kernel | own kernel |
| Cold start | to measure | 2.9 s, measured on 10 October | a boot, to measure |
| From a spare | at once, 2 ms measured | its start, to measure | a resume: a Windows spare took 4.1 to 5.0 s |
| Memory | what it uses | what it uses, less when idle (#575) | its size, held while it runs |
| Nested KVM | no | no | yes, where the host allows |
| Kernel modules | no | no, its kernel is msb's | yes |

## Decision

**The Proxmox QEMU backend also offers Linux kinds**, as VMs from an Ubuntu
24.04 template.

- Kinds: `linux` and `linux-desktop-cpu`, the same kinds other backends
  offer, so a thread can choose the VM with `on`, and a VM box has
  everything a `linux` box has: Docker (041), the tools and the desktop
  stack (056). The offer adds 2 features, `kvm` where the host allows
  nested virtualization, and `kernel`. 2 aliases ask for them:
  `linux-kvm` and `linux-vm`, as `linux-docker` asks for Docker (041).
- Order: a plain `linux` acquire without `on` still prefers LXC and
  microsandbox, which start sooner and hold less. The VM is chosen by
  `on`, by an alias, or when the others have no room.
- The template: Ubuntu 24.04's cloud image, imported as a VM, set up once
  with the same guest scripts as the LXC template
  (`setup/proxmox-lxc/template/guest/`), through cloud-init, then made a
  template in bb-box's own VMID range. `setup/proxmox-qemu/build.sh linux
  <vmid>` builds it, as `build.sh windows` builds Windows'.
- Refresh, as 054: monthly, a box of the current build runs 049's Linux
  refresh, and the box is captured as the next build after the same
  checks. The build before stays as the rollback.
- BB: a VM box joins BB as other Linux boxes do, through bb-box's machine
  provider and BB's POSIX installer, with no manual machine.
- Spares: a stop hibernates the VM, so spares wait hibernated and take a
  warm VM's place, as for Windows (#612).
- Clones are linked clones of the template, as for Windows.
- A GPU desktop with a passed-through GPU is left for later. Passing a GPU
  to a VM takes it from the host and from every LXC desktop until the VM
  stops, and needs IOMMU set up on the host. The LXC GPU desktops serve
  that need.

## What it is for

The skill and `box_list` say so: choose a VM box for its own kernel,
kernel modules, KVM inside the box, or systemd as on a real machine.
Otherwise a `linux` box from LXC or microsandbox starts sooner.

## The live check

On a Proxmox host, with the template in bb-box's VMID range, applied by
the operator:

- a cold `linux` VM box and a claimed spare, timed, against LXC and
  microsandbox boxes of the same size
- `box_thread`, Docker, and `/dev/kvm` in the box running a nested VM
- a desktop box: its stream and computer use
- the refresh, its checks and the rollback

## Consequences

- The Proxmox QEMU backend's templates are per kind, not Windows' alone.
- A VM box holds its memory while it runs, so the backend's capacity
  counts it at its size, as for Windows.
- The backend's settings gain the Linux templates' VMIDs.
