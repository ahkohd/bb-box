# 107. Windows boxes on Proxmox QEMU enable the virtio balloon device at full memory

Status: Accepted  
Date: 2026-11-27

## Context

`setup/proxmox-qemu/build.sh` created Windows templates with `--balloon 0`, and clones inherited `balloon: 0`. Windows touches all of its configured RAM during boot, and without a virtio balloon device none of that host memory can be returned while the box sits idle. On a node running several large Windows boxes, idle boxes held gigabytes of resident memory and host swap even while Windows itself used only a fraction of its RAM.

Proxmox VE's `qemu-server` (since 7.2-1, commit `c70e4ec397`, in all Proxmox VE 8.x and 9.x releases) attaches `virtio-balloon-pci,id=balloon0,...,free-page-reporting=on` whenever `balloon` is not `0` and the QEMU machine version is at least `6.2` (`--machine q35` resolves to the host's QEMU version). When `balloon` equals `memory`, Proxmox's `PVE::AutoBalloon` sets `balloon_min` equal to `maxmem`, so `pvestatd` never inflates the balloon or forces guest memory down.

On the Windows side, `setup/proxmox-qemu/answer/bb-box/firstlogon.ps1` runs `virtio-win-gt-x64.msi /qn /norestart`, which installs the `FE_balloon_driver` feature by default: `balloon.inf` and `balloon.sys` are staged into the Windows Driver Store and `blnsvr.exe` is installed as `BalloonService`. Existing templates built with `--balloon 0` therefore already hold the driver and service, and Windows Plug and Play binds `balloon.sys` on boot once the PCI device appears.

Upstream `virtio-win/kvm-guest-drivers-windows` (`master` as of November 2026) negotiates `VIRTIO_BALLOON_F_STATS_VQ` (reporting guest free and total memory to Proxmox through `BalloonService`) and classic balloon inflate and deflate, but does not yet implement `VIRTIO_BALLOON_F_REPORTING` (tracked in upstream issue 899 and open PR 1657). Enabling the balloon device at full memory prepares the Proxmox and QEMU configuration, avoids auto-ballooning, and gives Proxmox accurate guest memory reporting immediately, while full host page reclamation from idle Windows guests depends on the guest balloon driver supporting free page reporting (or a future decision on lower balloon minimums).

## Decision

- Windows kinds on Proxmox QEMU set `balloon` equal to the box's `memory` (in MiB) whenever BB Box configures a Windows VM's size: on acquire, warm pool fill, Windows image build or trial boxes, Windows template capture, and resize (including resize rollback).
- `setup/proxmox-qemu/build.sh` creates new Windows templates with `--balloon 8192` matching `--memory 8192`. Because BB Box configures `balloon` per clone, existing Windows templates do not need a rebuild.
- Proxmox rejects a VM config where non-zero `balloon` exceeds `memory`, so resize updates `memory` and `balloon` together on grow, shrink and rollback.
- The Proxmox start gate (`src/backends/proxmox/start-gate.ts`) continues to classify Windows VMs as heavy by OS (`windows`), kind (`windows-desktop`) and `ostype` (`win*`), because Windows still zeroes all configured RAM during boot even with a balloon device enabled.
- Linux and Android VMs on Proxmox QEMU are unchanged in this decision.

## Consequences

- Every Windows box on Proxmox QEMU boots with `virtio-balloon-pci` and `free-page-reporting=on` on Proxmox VE 7.2, 8.x and 9.x, with auto-ballooning prevented because `balloon` equals `memory`.
- Existing Windows templates bind `balloon.sys` and report real guest memory usage through `BalloonService` on their next clone with no template rebuild.
- Because current upstream `virtio-win` `balloon.sys` does not yet negotiate `VIRTIO_BALLOON_F_REPORTING`, setting `balloon` equal to `memory` alone will not reclaim idle Windows host RAM until a driver with free page reporting ships and is enabled, or until a follow-up decision allows a lower balloon floor.
- Linux VMs and Android VMs keep their existing `balloon: 0` setting; Linux kernels (5.7 and later) already implement `VIRTIO_BALLOON_F_REPORTING`, so applying the same change to Linux VMs in a follow-up would immediately return unused Linux VM pages to the host.
