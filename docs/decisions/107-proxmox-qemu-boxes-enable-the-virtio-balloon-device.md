# 107. Proxmox QEMU boxes enable the virtio balloon device

Status: Accepted  
Date: 2026-11-27

## Context

`setup/proxmox-qemu/build.sh` and `setup/proxmox-qemu/build-linux.sh` created QEMU templates with `--balloon 0`, and clones inherited `balloon: 0`. Without a virtio balloon device, a running VM cannot return unused RAM to the host. Windows touches all of its configured RAM during boot, so an idle 32 GiB Windows box held gigabytes of resident host memory and host swap even while Windows itself used only a few gigabytes.

Proxmox VE's `qemu-server` (since 7.2-1, commit `c70e4ec397`, across all Proxmox VE 7.2, 8.x and 9.x releases) attaches `virtio-balloon-pci,id=balloon0,...,free-page-reporting=on` whenever `balloon` is unset or non-zero and the QEMU machine version is at least `6.2` (`--machine q35` resolves to the host's QEMU version). When `balloon` is non-zero, Proxmox sets `balloon_min` to `balloon` MiB, and `pvestatd` (`PVE::AutoBalloon::compute_alg1`) adjusts balloons only when host memory usage exceeds `ballooning-target` (80% by default), clamping every VM between `balloon_min` and `maxmem`. Setting `balloon` equal to `memory` therefore prevents auto-ballooning and leaves only free page reporting; setting `balloon` below `memory` allows `pvestatd` to inflate the balloon down to that floor under host memory pressure.

Guest support differs between Linux and Windows:

- **Linux VMs (Ubuntu 24.04):** the pinned Ubuntu 24.04 cloud image (`linux-image-6.8.0-139-generic`, `linux-image-virtual`) builds `CONFIG_VIRTIO_BALLOON=y`, `CONFIG_MEMORY_BALLOON=y` and `CONFIG_PAGE_REPORTING=y` into the kernel. Linux kernels 5.7 and later implement `VIRTIO_BALLOON_F_REPORTING`, so a Linux VM with `balloon` equal to `memory` returns unused pages to the host immediately without auto-ballooning.
- **Windows VMs:** `setup/proxmox-qemu/answer/bb-box/firstlogon.ps1` runs `virtio-win-gt-x64.msi /qn /norestart`, which installs `FE_balloon_driver` (`balloon.inf`, `balloon.cat`, `balloon.sys` staged into the Windows Driver Store via `SetupCopyOEMInf`) and `BalloonService` (`blnsvr.exe`, automatic start). Existing Windows templates built with `--balloon 0` therefore bind `balloon.sys` at boot with no rebuild. However, upstream `virtio-win/kvm-guest-drivers-windows` (`master` as of November 2026) negotiates only `VIRTIO_BALLOON_F_STATS_VQ` and classic balloon inflate and deflate (`BalloonFill` and `BalloonLeak`), and does not yet implement `VIRTIO_BALLOON_F_REPORTING` (upstream issue 899; PR 1657 remains open). To let the host reclaim unused RAM from idle Windows boxes today, Windows needs a balloon floor below `memory` so `pvestatd` can inflate the balloon when host memory exceeds 80%.

## Decision

- **Linux VMs (`linux` and `linux-desktop-cpu`):** BB Box sets `balloon` equal to `memory` (in MiB) whenever it configures a Linux VM's size: on acquire, resize (including rollbacks), fork, image build or trial boxes, and template capture. `setup/proxmox-qemu/build-linux.sh` creates new `linux` and `linux-desktop` templates with `--balloon` equal to `--memory` (16384 MiB during build, then 4096 MiB for `linux` and 8192 MiB for `linux-desktop` before templating). Auto-ballooning never shrinks Linux VMs; free page reporting returns unused pages to the host.
- **Windows VMs (`windows-desktop`):** Proxmox QEMU adds an advanced setting `windows-balloon-min-percent` (default `50`, whole numbers from `25` to `100`; `100` keeps `balloon` equal to `memory` and turns auto-ballooning off). Whenever BB Box configures a Windows VM's size (acquire, warm pool fill, resize and its rollbacks, image boxes, and capture), it sets `balloon` to `round(memory * windows-balloon-min-percent / 100)` MiB (clamped between 1 and `memory`). `setup/proxmox-qemu/build.sh` creates new Windows templates with `--balloon 8192` matching `--memory 8192`, so template builds are not auto-ballooned and existing templates need no rebuild.
- **Android VMs (`android`):** unchanged (`balloon: 0` in `build-linux.sh` and omitted by BB Box).
- **Start gate (`src/backends/proxmox/start-gate.ts`):** unchanged in code. Ballooned Linux VMs no longer have `balloon` off, so they stop counting as heavy (they allocate memory lazily and do not zero all RAM at boot). Windows VMs remain heavy by OS (`windows`), kind (`windows-desktop`) and `ostype` (`win*`), and Android remains heavy by kind. Admission continues to check each guest's full configured `memory`, never the lower balloon floor.
- **Existing guests and hibernated warm VMs:** boxes and warm VMs made before this change keep `balloon: 0` until they are made again. Claiming a hibernated warm VM resumes it first and never changes its hardware configuration before resume.

## Consequences

- Idle Linux VMs on Proxmox QEMU return unused pages to the host immediately via `free-page-reporting=on` with no change to guest-visible memory and no heavy start settle delay.
- Idle Windows boxes report real guest free memory to Proxmox through `BalloonService`. When host memory usage exceeds 80%, `pvestatd` inflates idle Windows boxes first (`freemem > balloon_min * 0.25`) in steps of up to 100 MiB per cycle down to `windows-balloon-min-percent` of their memory, and deflates them again as host memory frees up. Inside Windows, `balloon.sys` locks the inflated pages with `MmAllocatePagesForMdlEx`, so Task Manager shows less available RAM (and higher driver-locked / in-use memory) while the balloon is inflated.
- Proxmox rejects a VM config where non-zero `balloon` exceeds `memory`, so resize and capture always update `memory` and `balloon` together.
- When upstream `virtio-win` PR 1657 lands and ships in a signed driver release, Windows boxes can opt into free page reporting and operators can raise `windows-balloon-min-percent` toward `100` if they prefer free page reporting over auto-ballooning.
