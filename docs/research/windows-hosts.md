# Windows hosts

Which backends could run boxes on a Windows machine, driven from BB's server
over OpenSSH and PowerShell as the Tart backend drives a Mac over SSH:
Hyper-V, WSL2 and Docker Desktop. Issue #158.

Research, 1 October 2026: a note of what was known and measured then, not
the current design, which is in [the architecture](../architecture.md).
Built as [setup/docker-wsl](../../setup/docker-wsl/README.md) (#158), with
no decision record.

Status: recommendation confirmed by measurement on 1 October 2026, in a
Windows 11 Pro VM on Proxmox with nested virtualisation (8 cores, 16 GiB).
The first option is built: [setup/docker-wsl/](../../setup/docker-wsl/README.md)
sets up a PC, and bb-box's conformance suite passes against it. See
[What we measured](#what-we-measured) and
[What the experiments changed](#what-the-experiments-changed).

## Recommendation

1. **Build nothing new first: run Docker Engine in one WSL2 distribution and
   point the Docker backend at it.** The distribution runs systemd, Docker
   Engine and its own sshd on port 2222. With WSL's mirrored networking that
   port is on the Windows machine's own address, so the backend's host is
   `ssh://user@windows-pc:2222` and everything else is as on Linux: linux,
   linux-docker and linux-desktop-cpu boxes, desktops through `docker exec`
   (031), and enrolment as BB machines. It works on Windows Home, and Docker
   Engine needs no subscription.
   Done: `setup/docker-wsl/setup.ps1` sets up a PC in about 75 s, and a box
   is ready 2 to 4 s after it is asked for.
2. **Hyper-V later, and only for Windows boxes on a Windows PC.** It is a new
   backend the size of Tart's. Its Windows guests reuse #46's template work
   (OpenSSH, the in-session helper, Cua), so build it after #46 lands, and
   only if the operator wants Windows boxes on a Windows PC rather than on
   Proxmox. Linux guests on Hyper-V add nothing that step 1 lacks for daily
   use. Hyper-V is fast enough for it: a Linux clone answered SSH in 11 s,
   and a saved one in 4 s.
3. **Not a WSL2 distribution per box.** All distributions share one VM, one
   kernel and one network namespace: two boxes cannot both listen on port 22
   or 5900, memory and CPU limits apply to the whole VM, and two Docker
   daemons would fight over the same network. Importing Ubuntu's 1.5 GB
   image took 12 to 15 s, against a container start of under 1 s.
4. **Not Docker Desktop as it is.** `ssh://` to Windows fails: the Windows
   `docker system dial-stdio` breaks with "the raw stream connection does
   not implement halfCloser" (docker/cli#4718, open). Docker Desktop also
   runs only while someone is logged in, and needs a paid seat in an
   organisation of more than 250 employees or 10 million dollars of
   revenue.

## What we measured

On 1 October 2026, in Windows 11 Pro 26H2 (build 26300) as a Proxmox VM
with nested virtualisation: 8 cores of an AMD Threadripper PRO 9975WX,
16 GiB, and WSL 3.0.1 with its memory set to 12 GB. BB's server, on the
same Proxmox host, reached the VM directly. The conformance suite and the
image builds ran from another machine through an SSH jump host. Nested
timings are a worst case.

Setting up the PC:

| Step | Time |
| --- | --- |
| Turn on Hyper-V and the Virtual Machine Platform | One restart; SSH back 19 s after it |
| Download and install WSL's MSI (351 MB) | 6.6 s and 13.8 s, no restart |
| `setup.ps1`, first run | 74 s: Ubuntu's image 19 s, import 12 s, Docker Engine and sshd 40 s |
| `setup.ps1`, again | 7 to 29 s, with boxes still running |
| Build bb-box's images over SSH | linux 328 s, linux-desktop 699 s |

Docker Engine in WSL, through bb-box's Docker backend (steps 3 and 4):

| Check | Result |
| --- | --- |
| `docker info` from BB's server | 0.31 s |
| Conformance suite, linux, linux-docker and linux-desktop-cpu | 49 checks pass, none fail; 9 skipped, such as enrolment, which needs a live BB server |
| Acquire until ready: linux, linux-docker, linux-desktop-cpu | 2.5 s, 3.2 s, 2.3 s; in the suite 2.9 s, 3.9 s, 3.2 s |
| Copy 32 MiB in, then out | 4.0 to 4.2 s |
| Stop, then start | 2.8 to 3.6 s |
| Open the desktop as the viewer's relay does | 0.9 s, 1920 by 1080 |
| Computer use: list the desktop's windows | 0.5 s |
| Distribution back after `wsl --shutdown` | 59 s, by the scheduled task |
| Windows restarted with nobody signed in | Boxes running again after 77 to 79 s, and the backend lists them as held; Windows answers SSH after 18 s |

Hyper-V (steps 5 and 6), with a Linux guest of 2 GiB on the Default Switch:

| Check | Result |
| --- | --- |
| Parent disk from Ubuntu's cloud image, once | 69 s to download and convert, 122 s to prepare |
| Differencing disk, `New-VM`, `Start-VM` | 1.1 s, 3.1 s, 0.7 s |
| Address in `Get-VMNetworkAdapter` | 5.3 s after `Start-VM` |
| SSH answers through the host | 10.8 s after starting |
| `Save-VM` | 0.6 s |
| `Start-VM` from saved | 0.6 s; SSH answers 3.7 s after it starts, at the same address |
| Console through FreeRDP `/vmconnect` over an SSH tunnel | Works: shows the guest's login prompt |

## What the experiments changed

The recommendation stands. These details differ from what the documents
said, and `setup/docker-wsl/` handles each:

- `wsl --install` fails at once in an SSH session, saying WSL is not
  installed. WSL's MSI from its GitHub release installs without a restart.
- Ubuntu's `openssh-server` package fails to install in mirrored mode: its
  socket unit cannot take port 22 from Windows' own sshd. Install with
  service starts held back, then run sshd as a plain service on 2222.
- A scheduled task at start-up alone does not bring the distribution back
  after `wsl --shutdown`: Task Scheduler restarts a task only when it fails
  to launch, not when it ends. A second trigger, every minute, that does
  nothing while the task runs, brings it back within a minute.
- WSL started in Windows' first seconds got its mirrored network only about
  3 minutes later, so boxes answered 205 s after a restart. The task now
  waits until Windows has been up a minute, and boxes answer after 77 to
  79 s.
- In an SSH session `USERDOMAIN` is `WORKGROUP`, so the task names its
  account from the process token instead.
- With nobody signed in, WSLg's compositor crashed about every 2 minutes,
  and WSL kept about 1 GB of its crash dumps. The setup turns WSLg off
  (`guiApplications=false`); boxes have desktops of their own.
- The Docker backend keeps 4 GiB free by default. With WSL at 12 GB that
  refused a desktop box and a second small box; 1024 MiB is enough, since
  WSL's cap keeps Windows' share.
- Hyper-V ran in the nested VM with Proxmox's default Hyper-V
  enlightenments and CPU type `host`; it needed no QEMU `args`.
- FreeRDP's `/vmconnect` always connects to port 2179, so the tunnel's local
  end must be port 2179. It logs in with NLA, as a member of Hyper-V
  Administrators on the host.
- A Hyper-V clone that makes fresh SSH host keys must run `ssh-keygen -A`
  before Ubuntu's `sshd -t` check, or sshd never starts.
- WSL 3.0.1, of 29 September 2026, adds WSL containers (`wslc`): its own
  CLI and SDK, run per Windows user, with no Docker API and no Compose yet.
  It is not a host for the Docker backend; watch it.

## The three options

| | Docker Engine in WSL2 | Hyper-V | WSL2 distribution per box |
| --- | --- | --- | --- |
| Windows edition | Any, Home too | Pro, Enterprise or Education | Any, Home too |
| Boxes | Linux containers | Linux and Windows VMs | Linux distributions |
| New code | A setup script | A backend | A backend |
| Make a box | A container start: ready in 2 to 4 s | Differencing disk, then boot: SSH in 11 s; from saved, 4 s | `wsl --import`, 12 to 15 s |
| Desktop | Ours, through exec | Linux: ours. Windows: see below | Ours, but ports clash |
| Computer use | Cua, as on Linux | Cua; #46's helper on Windows | Cua, as on Linux |
| Enrolment | Yes | Linux yes; Windows after BB request 1 | Yes |
| Per-box limits | Docker's | Per VM | None: VM-wide only |

### Docker Engine in WSL2

- **Reaching it.** Mirrored networking (`networkingMode=mirrored` in
  `.wslconfig`) needs Windows 11 22H2 or later. Windows' own OpenSSH keeps
  port 22, so the distribution's sshd listens on 2222, and a Hyper-V
  firewall rule (`New-NetFirewallHyperVRule ... -LocalPorts 2222`) lets it
  in. On older Windows, use the Windows OpenSSH server as a jump host to the
  WSL address instead; that address changes at each boot.
- **Staying up.** WSL stops a distribution 15 s after its last process
  started through `wsl.exe` ends, even with systemd services running, and
  the VM 60 s later. Set `instanceIdleTimeout=-1` (WSL 2.4.4 or later) and
  `vmIdleTimeout=-1`, and start the distribution at boot from a scheduled
  task. Since WSL 2.0, `wsl.exe` works from session 0, so from SSH and
  scheduled tasks. The task also needs a trigger every minute, so it brings
  the distribution back after `wsl --shutdown` or a WSL update, and it
  waits until Windows has been up a minute, or the WSL VM gets its network
  3 minutes late.
- **Capacity.** `.wslconfig` caps memory and processors for the WSL VM as a
  whole; Docker's limits then apply per box as on Linux. WSL takes half the
  PC's memory unless told otherwise. That cap already keeps Windows' share,
  so the Docker backend's memory kept free can drop from 4096 to 1024 MiB.
  With WSL at 12 GB on a 16 GB PC, that leaves room for one desktop box
  (8 GiB) or two small Linux boxes (4 GiB each).
- **Disk.** The distribution's disk is a sparse VHDX of up to 1 TB, so a
  box reports about 1 TB free whatever C: has left.
- **GPU.** CUDA reaches containers through `/dev/dxg` and a CDI spec made by
  `nvidia-ctk cdi generate`, which detects WSL. The GPU desktop's rendering
  path is not proven there, so start with linux-desktop-cpu.

### Hyper-V

- **Driving it.** OpenSSH Server on the host with PowerShell as its shell,
  and an account in the Hyper-V Administrators group, so the Hyper-V
  module's cmdlets (`New-VHD -Differencing`, `New-VM`, `Start-VM`,
  `Stop-VM`, `Remove-VM`) need no elevation. Files go over SFTP.
- **Clones.** A differencing disk on a prepared parent disk is made at once
  and starts small. `Save-VM` and `Start-VM` could keep a warm pool, as
  Tart's does: a saved 2 GiB guest resumed in 0.6 s.
- **Network.** The Default Switch gives guests addresses by DHCP behind NAT,
  reachable from the host only. Its range changes when the host restarts, so
  the backend reads each guest's address from Hyper-V
  (`Get-VMNetworkAdapter`), which Linux guests report through the
  `hv_kvp_daemon`. The host is then the jump host to the guest's OpenSSH,
  as with Tart.
- **Desktop.** Hyper-V has no VNC. Linux guests run our VNC server inside,
  as LXC desktops do. Windows guests need one of:
  - a VNC server in the guest, which shows the console session the helper
    and Cua use: no change to the relay (007), so this comes first;
  - Hyper-V's own console, which is RDP on the host's port 2179 with the
    VM's ID as a preconnection blob. FreeRDP (`/vmconnect`) and Guacamole
    speak it, and it works from boot, but the relay speaks only RFB, so it
    would need an RDP bridge. FreeRDP showed a Linux guest's console
    through an SSH tunnel to the host.
  Enhanced session mode is RDP too, so it would need the same bridge.
- **Capacity.** Memory per VM against the host's free memory; disks start
  small. No GPU at first: GPU partitioning would be its own research.

## Experiments, without a physical Windows machine

We ran these on 1 October 2026: see [What we measured](#what-we-measured).
Hyper-V needed no QEMU `args`.

Run Windows 11 Pro or Enterprise (an evaluation copy is enough) as a Proxmox
VM made from the Windows spike template (#46), with nested virtualisation on
the Proxmox host and CPU type `host`. Hyper-V in a nested VM may also need
Hyper-V enlightenments as QEMU `args` (`hv_passthrough` or a custom CPU
model); WSL's first-run warning about nested virtualisation is harmless.

1. Turn on OpenSSH Server, Hyper-V and the Virtual Machine Platform, with
   PowerShell as SSH's shell. From BB's server, log in with a key.
2. WSL: install WSL without a distribution, then import an Ubuntu root file
   system as `bbdocker`, with systemd, Docker Engine and sshd on 2222. Set
   mirrored networking, both idle timeouts to -1, and the firewall rule.
   Time the import.
3. From BB's server, `DOCKER_HOST=ssh://user@<vm>:2222 docker info`. Then
   point bb-box's Docker backend at it, acquire linux and linux-desktop-cpu
   boxes, and check `box_run`, `box_copy`, the terminal, the desktop,
   computer use and enrolment. Time each acquire.
4. Restart Windows with nobody logged in. Check that the scheduled task
   brings `bbdocker` back, and that the sweep finds the boxes.
5. Hyper-V: make a Linux guest from a differencing disk on the Default
   Switch. Time it until SSH answers through the host, and time `Save-VM`
   then `Start-VM`. Read its address with `Get-VMNetworkAdapter`.
6. From BB's server, through an SSH tunnel to port 2179, open the guest's
   console with FreeRDP `/vmconnect:<VM ID>`.

Nested timings are a worst case; a physical Windows PC is faster.

## Sources

- WSL 3.0.1 and WSL containers:
  https://github.com/microsoft/WSL/releases/tag/3.0.1 and
  https://devblogs.microsoft.com/commandline/wslc-architecture-deep-dive/
- WSL: networking, including mirrored mode and the Hyper-V firewall,
  https://learn.microsoft.com/en-us/windows/wsl/networking; `.wslconfig`
  settings, https://learn.microsoft.com/en-us/windows/wsl/wsl-config;
  release notes, https://learn.microsoft.com/en-us/windows/wsl/release-notes
  (2.0.0: session 0)
- WSL distributions share a network namespace:
  https://github.com/microsoft/WSL/issues/4304 and
  https://github.com/microsoft/WSL/issues/12331
- WSL from SSH: https://github.com/microsoft/WSL/issues/9231
- Distributions stopping despite systemd:
  https://github.com/microsoft/WSL/discussions/9245 and
  https://github.com/microsoft/WSL/issues/13416
- Import timings: https://gist.github.com/niratama/2c8f03cb9497f0528b8237c452cbdac2
- Docker over SSH to Windows: https://github.com/docker/cli/issues/4718 and
  https://github.com/docker/cli/issues/1376
- Docker Desktop without a logged-in user:
  https://github.com/docker/roadmap/issues/515; licence:
  https://docs.docker.com/desktop/troubleshoot-and-support/faqs/general/
- NVIDIA CDI on WSL:
  https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/cdi-support.html
- Hyper-V editions:
  https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/install-hyper-v
- The Default Switch's changing range:
  https://learn.microsoft.com/en-us/answers/questions/48268/change-hyper-v-(default-switch)-ip-address-range
- Hyper-V console over RDP:
  https://cloudbase.it/using-freerdp-to-connect-to-the-hyper-v-console/ and
  https://guacamole.apache.org/doc/gug/configuring-guacamole.html
- Hyper-V in a Proxmox VM:
  https://forum.proxmox.com/threads/windows-11-24h2-wsl2-wsl-nested-virtualization-is-not-supported-on-this-machine-message.158758/
  and https://www.onemarcfifty.com/blog/HyperV-Proxmox/
