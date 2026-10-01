# Windows hosts

Which backends could run boxes on a Windows machine, driven from BB's server
over OpenSSH and PowerShell as the Tart backend drives a Mac over SSH:
Hyper-V, WSL2 and Docker Desktop. Issue #158.

Status: recommendation made, from documentation and issue trackers only.
Nothing is measured yet; the experiments below run Windows in a VM with
nested virtualisation. Checked on 1 October 2026.

## Recommendation

1. **Build nothing new first: run Docker Engine in one WSL2 distribution and
   point the Docker backend at it.** The distribution runs systemd, Docker
   Engine and its own sshd on port 2222. With WSL's mirrored networking that
   port is on the Windows machine's own address, so the backend's host is
   `ssh://user@windows-pc:2222` and everything else is as on Linux: linux,
   linux-docker and linux-desktop-cpu boxes, desktops through `docker exec`
   (031), and enrolment as BB machines. It works on Windows Home, and Docker
   Engine needs no subscription.
   Cost: a setup script and a section in docs/backends.md, about a day, plus
   the experiments.
2. **Hyper-V later, and only for Windows boxes on a Windows PC.** It is a new
   backend the size of Tart's. Its Windows guests reuse #46's template work
   (OpenSSH, the in-session helper, Cua), so build it after #46 lands, and
   only if the operator wants Windows boxes on a Windows PC rather than on
   Proxmox. Linux guests on Hyper-V add nothing that step 1 lacks for daily
   use.
3. **Not a WSL2 distribution per box.** All distributions share one VM, one
   kernel and one network namespace: two boxes cannot both listen on port 22
   or 5900, memory and CPU limits apply to the whole VM, and two Docker
   daemons would fight over the same network. Importing a 1.7 GB
   distribution took 5 to 8 s in one test, against a container start.
4. **Not Docker Desktop as it is.** `ssh://` to Windows fails: the Windows
   `docker system dial-stdio` breaks with "the raw stream connection does
   not implement halfCloser" (docker/cli#4718, open). Docker Desktop also
   runs only while someone is logged in, and needs a paid seat in an
   organisation of more than 250 employees or 10 million dollars of
   revenue.

## The three options

| | Docker Engine in WSL2 | Hyper-V | WSL2 distribution per box |
| --- | --- | --- | --- |
| Windows edition | Any, Home too | Pro, Enterprise or Education | Any, Home too |
| Boxes | Linux containers | Linux and Windows VMs | Linux distributions |
| New code | None | A backend | A backend |
| Make a box | A container start | Differencing disk, then boot | `wsl --import`, 5 to 8 s |
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
  scheduled tasks.
- **Capacity.** `.wslconfig` caps memory and processors for the WSL VM as a
  whole; Docker's limits then apply per box as on Linux.
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
  Tart's does; how fast a saved VM resumes is to measure.
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
    would need an RDP bridge.
  Enhanced session mode is RDP too, so it would need the same bridge.
- **Capacity.** Memory per VM against the host's free memory; disks start
  small. No GPU at first: GPU partitioning would be its own research.

## Experiments, without a physical Windows machine

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
