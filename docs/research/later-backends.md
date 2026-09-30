# Later backends

A sketch of the Docker, SSH host pool, Windows on Proxmox QEMU, physical Mac
and Tart backends, to test that bb-box's backend interface fits them before
the core is built out.

Status: done. Docker was measured here; the other four were researched from
their sources and documentation. The interface changes it found are now
[Interface v1](../architecture.md#interface-v1)
([011](../decisions/011-interface-v1.md)), with the review's changes in
[012](../decisions/012-offers-may-add-features.md) and
[013](../decisions/013-docker-boxes-run-unprivileged.md) (#5). The last
section lists what is still open. Checked on 30 September 2026.

## Summary

- **All five fit Interface v1**, as amended by 012, with no further type
  change. The gaps the first interface had are closed by v1: host and port
  for the desktop, unique kind IDs, memory and disk as the only capacity, no
  desktop session, required power control, and no clean check for real
  machines.
- **Docker** is the fastest backend and the easiest to test: a desktop
  container answers SSH and RFB 0.8 s after `docker run`, and `docker exec`
  takes 20 to 30 ms. It runs unprivileged without systemd. systemd and
  Docker inside the box need a privileged container, which is root on the
  Docker host.
- **The SSH host pool and the physical Mac should be one driver** with a reset
  script per OS. The hard part is reset: bb-box can make a machine's box user
  clean, and check it before every claim, but it cannot prove a machine is
  clean if the box user had admin rights.
- **Windows on Proxmox QEMU** works without BB enrolment. Use OpenSSH for
  commands, the QEMU guest agent for readiness, and Proxmox's own console for
  the desktop. Computer use and anything that opens a window need a helper
  running in the desktop session, because every remote command runs in
  session 0.
- **Tart** reaches VMs only through the Mac host, so every route goes through
  SSH to the Mac. Two macOS VMs per Mac is a hard limit, and Apple's licence
  allows them for software development and testing, not as a service to
  others. Tart's licence
  (FSL-1.1-ALv2) allows our use and publishing bb-box.

## Docker (virtual; early)

### What was measured

On Docker 29.8.1, nested in an Arch Linux LXC container on a Proxmox host
(kernel 6.17.13-2-pve), with cgroup v2. The image is ubuntu:24.04 with sshd,
Xtigervnc 1.13.1, XFCE, socat and xdotool, and a `box` user with sudo
(837 MB).

| Variant | Ready (SSH and RFB banners after `docker run`) | Notes |
| --- | --- | --- |
| Unprivileged, systemd as PID 1 | never | systemd exits: "Failed to create /init.scope control group: Read-only file system". Docker mounts `/sys/fs/cgroup` read-only; remounting it with `CAP_SYS_ADMIN` was denied |
| Privileged, systemd as PID 1 | 1.06 s | systemd reaches graphical.target in 0.8 to 0.9 s of userspace |
| Unprivileged, `docker run --init` and a start script | 0.78 s | most of it is `ssh-keygen -A` |

| Operation | Time |
| --- | --- |
| `docker exec <c> true` | 17 to 39 ms, usually under 30 ms |
| `ssh box@<c> true` | 120 ms |
| RFB banner through `docker exec -i <c> socat - TCP:127.0.0.1:5900` | 32 to 40 ms |
| Docker-in-Docker (`docker:29-dind`, privileged): inner daemon ready | 1.05 s |
| Inner `docker run alpine true`: first (with pull), then cached | 2.0 s, 0.3 s |

- An idle XFCE desktop container with systemd used 140 MiB of memory and 55
  processes.
- `xrandr --fb 1280x800` resized the Xtigervnc screen, so the display can be
  `resizable`.
- A GPU passed in by device node (`--device /dev/nvidia0 --device
  /dev/nvidiactl` with `nvidia-smi` and `libnvidia-ml` mounted) was visible.
  `/dev/nvidia0` was the GPU that `nvidia-smi` lists as index 1, so GPUs must
  be chosen by UUID, never by index or device number.

### How it fits

- **Acquire.** Create a container from the kind's image through the Engine
  API with labels (`bbbox.backend`, `bbbox.kind`, `bbbox.generation`), the
  name `bbbox-<box>`, `--init`, memory, CPU and process limits, the kind's
  network, and `--shm-size` of at least 1 GiB (Chrome crashes with Docker's
  default 64 MiB `/dev/shm`). Then start it. A warm container is created as
  `bbbox-warm-<n>` and claimed by renaming it.
- **Release.** `docker rm -f -v`. A missing container counts as released.
- **Ready.** `docker exec <c> true` answers as the box user, then the desktop
  answers RFB. `readyTimeoutMs` 30 s.
- **Address.** The container's address on a bb-box bridge network, which
  only the Docker host reaches. Null for a remote Docker host or Docker
  Desktop, where everything goes through `docker exec`.
- **Capacity.** One host (the Docker daemon):
  - `guests`: a container budget from settings;
  - `memory`: `docker info` total, less the limits of bb-box's containers and
    a reserve;
  - `disk`: `total` null, since the API does not report free space;
  - `gpu-desktops` per GPU UUID when GPU kinds are on.
- **Commands and files.** The Engine API: exec, whose output without a TTY
  arrives as frames marked stdout or stderr (which is what `onOutput(chunk,
  from)` wants), and the archive API, which copies tar streams in and out.
  Transport `docker`, shell `sh`, `admin` true (sudo inside the container),
  `streaming` true. `route(port)` is
  `docker exec -i <c> socat - TCP:127.0.0.1:<port>`, so socat is in every
  image.
- **Desktop.** Xtigervnc on 5900 inside the container, reached through the
  exec route (which works on a remote host and on Docker Desktop too).
  Protocol `rfb`, `resizable` true. Selkies later, as for LXC.
- **GPU.** NVIDIA's container toolkit, preferably through CDI
  (`nvidia-ctk cdi generate`, then `--device nvidia.com/gpu=<UUID>`) with
  `NVIDIA_DRIVER_CAPABILITIES=all`, so the graphics, display and video
  libraries are mounted from the host driver. The desktop runs as in
  [the GPU in a desktop box](gpu-desktop.md). Not measured here: the GPUs on
  this host were almost full with other work.
- **systemd and Docker inside.** Only in a privileged container, which the
  operator turns on in settings, knowing it is root on the Docker host. Such
  an offer has the features `systemd` and `docker`. Without it, the image
  runs `docker-init` and a start script
  ([013](../decisions/013-docker-boxes-run-unprivileged.md)).
- **Enrolment and thread access.** Without systemd, BB's installer leaves its
  host daemon running in the background, and the start script starts it
  again after a restart (013). `access.ssh` is set only when the thread's
  machine reaches the container's address. `access.dockerHost` stays null,
  because the host's Docker socket is root on the host and on every other
  box.
- **Computer use.** As for LXC: the Linux helper, with the accessibility bus
  and XTEST, and no permissions to grant.
- **Images.** Built by the setup script from Dockerfiles in this repository
  (`bbbox/linux-desktop`, `bbbox/linux-headless`), with the version in the
  tag. Published images can come later.
- **Setup for a new user.** Docker Engine on Linux, or Docker Desktop; a
  setting for the Docker host (a socket or `ssh://`); run the setup script to
  build the images; optionally the NVIDIA toolkit. `doctor` checks the
  daemon, the API version, the images, the toolkit for GPU kinds, and the
  budget.
- **Conformance.** Runs on any Linux machine with Docker, including CI
  runners, so it is the backend that tests the core end to end on every
  change: capacity, acquire, run, files, a frame of the desktop, computer
  use, stop and start, release, and `held()` after a crash.

Kinds ([012](../decisions/012-offers-may-add-features.md)):
`linux-headless` and `linux-desktop-cpu` always; `linux-desktop` with NVIDIA's
container toolkit; `linux-headless-docker` only when privileged.

## SSH host pool (real; early)

Machines you own, reached over SSH, lent to one box at a time and reset when
it is released.

- **Two users on each machine.**
  - `bbbox-admin` is used by bb-box only. It has bb-box's admin key, and sudo
    only for the scripts in `/usr/local/libexec/bb-box/`.
  - `box` is the box user the thread gets. By default it has no admin rights.
- **Acquire (claim).** From the pool store, take a free machine that serves
  the kind. Over the admin connection:
  - run the clean check (below); if it fails, put the machine out of service
    with the reason and try the next one;
  - write the owner marker `/var/lib/bb-box/owner` with the box, thread and
    generation;
  - install the box's key in the box user's `authorized_keys`;
  - turn on linger for the box user where systemd runs, so BB's host daemon
    outlives the SSH session that enrols the box
    ([014](../decisions/014-enrol-through-machine-providers.md));
  - start the desktop service for desktop kinds.

  The guest is `{ref: machine, host: machine, address, data: {user: "box"}}`.
- **Ready.** SSH answers as the box user, and for desktop kinds the display
  answers. Seconds.
- **Release (reset).** `resetting()` first, then:
  1. remove the BB machine enrolment;
  2. end the box user's sessions and processes (`loginctl terminate-user`,
     then `pkill -KILL -u box`);
  3. remove its crontab and `at` jobs and turn off lingering;
  4. remove its files in `/tmp`, `/var/tmp` and `/dev/shm`;
  5. recreate its home from the skeleton;
  6. write `/var/lib/bb-box/clean` with a new generation, and record the same
     generation in the pool store.

  `restores: "home"`.
- **The clean check, before each claim.**
  - The marker's generation matches the pool store.
  - The box user has no processes.
  - Its home matches the skeleton's manifest.
  - No crontab.
  - No BB machine is enrolled.
  - No owner marker.
- **What "clean" can mean.** A home reset is a convention for one trusted
  user: if the box user had sudo or was in the `docker` group, it could have
  changed anything, and no check proves otherwise. A pool that grants admin
  rights must restore the whole machine instead (`restores: "machine"`). The
  operator supplies that reset command, for example a Btrfs or ZFS snapshot
  rollback and a reboot, or a network reinstall. bb-box runs it and then runs
  the same check.
- **Kinds.** `linux-headless` and `linux-desktop-cpu`, and `linux-desktop` on
  a machine with a GPU. `linux-headless-docker` needs one of two things:
  - a whole-machine reset, since a box user in the `docker` group is root on
    the machine; or
  - rootless Docker for the box user. Its daemon runs as the box user and
    keeps its images and containers in the home, so the home reset removes
    them. To be tested.
- **If a reset fails**, the machine goes out of service with the reason and
  shows in `members()`, and the operator uses `returnToService` after fixing
  it. A reset interrupted by a restart is finished by the sweep, because
  `resetting()` was recorded first.
- **Address and access.** The machine's LAN name or address, host keys pinned
  at setup, and optionally a jump host. `access.ssh` is the box user on it.
- **Capacity.** A `machines` limit for the kind asked about: the machines
  that serve it, and how many are held, resetting or out of service.
  `members()` gives each machine's state.
- **Commands and files.** SSH, shell `sh`, `streaming` true, `admin` false by
  default. `route(port)` is `ssh -W 127.0.0.1:<port>`.
- **Desktop.** For Linux desktop machines, Xvnc (or Xorg with
  `x0vncserver` on a GPU) as a service for the box user, listening on
  127.0.0.1 only and reached through the SSH route. Protocol `rfb`.
- **Enrolment.** Yes, per claim, as the box user; removed by the reset.
- **Ownership.** The owner marker on the machine, and the pool store in
  plugin storage. `held()` reads the markers, so it survives lost storage.
- **Setup for a new user.**
  1. Run the setup script as root on each machine. It creates the two users
     and the skeleton, installs the reset and check scripts and the desktop
     service, and prints the host key fingerprint.
  2. Add each machine to settings with its fingerprint.
  3. `doctor` checks, per machine: reachable, host key, sudo rules, box user,
     marker, desktop service.
- **Conformance.** The whole real-pool lifecycle can run against Docker
  containers acting as machines: the systemd image from the Docker
  measurements, privileged, with sshd. So CI tests claim, the clean check, a
  dirty reset (files, processes, a crontab, a lingering service), a failed
  reset, a reset interrupted by a restart, and return to service, without
  hardware.

## Proxmox QEMU for Windows (virtual; next)

- **Template.** The setup script builds a Windows 11 or Windows Server 2025 VM
  from the operator's ISO. It uses UEFI (OVMF) with a TPM state disk and
  VirtIO drivers, and installs:
  - the QEMU guest agent, from the virtio-win guest tools;
  - OpenSSH Server, with PowerShell as its default shell;
  - Cloudbase-Init;
  - bb-box's in-session helper.

  It then runs `sysprep /generalize /oobe /shutdown` with an answer file that
  creates the `box` user, turns on automatic logon and skips OOBE, and
  converts the VM to a template.
- **Acquire.** Linked clone (`qm clone --full 0`), which is quick on storage
  with snapshots (LVM-thin, ZFS, Ceph, qcow2). Proxmox's cloud-init
  (`ipconfig0`, `sshkeys`) writes a config drive in the configdrive2 format
  for Windows guest types, which Cloudbase-Init reads. Through it the backend
  sets the hostname, a static address and bb-box's SSH key for the box. Then
  start the clone.
- **Ready.** The first boot after sysprep runs specialize and OOBE, and
  reboots, so it takes minutes, not seconds. `readyTimeoutMs` is 10 min.
  - Readiness is the guest agent's `ping`, then SSH as the box user, then the
    helper answering in the desktop session.
  - A warm pool is what makes Windows usable.
  - A faster option to measure: clone a template that was not generalized.
    Duplicate machine SIDs do not matter for machines that are not in a
    domain, but Microsoft supports only sysprepped images.
- **Release.** Stop and delete, as for LXC.
- **Address.** A static address on the boxes' bridge, as for LXC. The guest
  agent's `network-get-interfaces` confirms it.
- **Capacity.** `memory` (4 to 8 GiB per box), `disk` (linked clones are
  small at first), and `guests` (the VMID range). No GPU at first: Windows
  renders on the CPU (WARP). A GPU would need a whole card passed through.
- **Commands and files.** OpenSSH for Windows: transport `ssh`, shell
  `powershell`, `admin` true, `streaming` true, `inDesktopSession` false.
  Files over SFTP. `route(port)` is `ssh -W`.
  - Keys for members of Administrators are read from
    `C:\ProgramData\ssh\administrators_authorized_keys`, not the user's home,
    unless the template removes that `Match` block. Cloudbase-Init writes the
    user's file.
  - The guest agent through the Proxmox API is the fallback: no network path
    is needed, but it runs as SYSTEM, returns output only at exit, and caps
    stdin at 64 KiB, writes at 60 KiB per call and reads at 16 MiB. Its
    privileges are VM.GuestAgent.Unrestricted for exec, and
    VM.GuestAgent.FileRead and FileWrite for files.
- **Session 0.** OpenSSH, WinRM and the guest agent are services, so what they
  start runs in session 0, where no window shows. Anything that must appear
  on the desktop, and computer use, goes through bb-box's helper. It runs in
  the box user's desktop session, started at logon by a scheduled task with
  the highest privileges, and listens on 127.0.0.1, reached through the SSH
  route. `session: "desktop"` on Windows asks the helper to start the process.
- **Desktop.** Proxmox's console:
  - `POST /nodes/{node}/qemu/{vmid}/vncproxy` with `websocket=1` returns a
    port, a one-time ticket and a one-time `password`;
  - the backend's `open()` returns a `websocket` route to
    `.../vncwebsocket?port=&vncticket=`, with the API token in a header and
    the certificate fingerprint;
  - the `password` is the VNC password in the RFB handshake
    (`generate-password` is deprecated: a WebSocket proxy always gets one);
  - privilege VM.Console.

  Nothing runs in the guest, it shows the console session the helper uses,
  and it works from boot. `resizable` false until resizing through the VirtIO
  GPU driver is checked.
- **Computer use.** UI Automation for the accessibility tree, `SendInput`
  for input, and Windows Graphics Capture for screenshots, all in the helper.
  - Windows asks no permission for these. But a process can drive elevated
    windows only if it is elevated itself (UIPI), so the helper runs elevated.
  - UAC's secure desktop cannot be driven at all, so the template sets UAC to
    elevate without prompting.
  - The template also turns off the lock screen, the screen saver and sleep.
- **Enrolment.** No: BB's host app does not run on Windows. The panel says so.
  Thread access is SSH only: `access.ssh` is the box user when the thread's
  machine reaches the boxes' network.
- **Licensing.** Each VM needs a Windows licence. Evaluation media (90 days
  for Windows 11 Enterprise, 180 days for Server 2025) are enough to try it.
  bb-box never ships Windows images; the template is built from the
  operator's ISO.
- **Kind.** `windows-desktop`.
- **Setup for a new user.**
  1. Upload the ISO and the virtio-win ISO to Proxmox.
  2. Run the template script.
  3. Give bb-box's token:
     - VM.Clone on the template, and VM.Allocate on the boxes' pool;
     - VM.Config.*, VM.PowerMgmt, VM.Console, VM.Audit and
       VM.GuestAgent.Audit on the pool;
     - Datastore.AllocateSpace on the storage, and SDN.Use on the bridge;
     - VM.GuestAgent.Unrestricted, FileRead and FileWrite only if the guest
       agent fallback is turned on.
  4. `doctor` checks the template (guest agent, sysprepped, OpenSSH), the
     token's privileges, and one test clone.
- **Conformance.** Needs a Proxmox host, so it runs nightly or by hand, not
  on every change. The suite skips enrolment because the kind declares
  `enrol: false`, and tests large file copies through SFTP.

## Physical Mac (real; later)

The SSH host pool driver with macOS machines, a macOS reset script and a
desktop kind. A separate driver is not needed.

- **The box user must own the console.** The desktop display and computer use
  need a logged-in GUI session.
  - The box user is a standard user with automatic login, which needs
    FileVault off.
  - loginwindow logs a user in automatically only at boot. So a reset
    recreates the home and then reboots to get the desktop back: about 1 to 2
    minutes on Apple silicon, to be measured.
  - Readiness and the clean check include "the box user owns the console"
    (`stat -f %Su /dev/console`).
- **Reset.** `resetting()`, then:
  1. remove the BB enrolment;
  2. log the box user out (`launchctl bootout gui/<uid>`) and kill its
     processes;
  3. remove its crontab;
  4. delete its home and recreate it from the skeleton. Its LaunchAgents,
     login items, keychain, Simulator devices and derived data are all in the
     home;
  5. reboot;
  6. write the marker with a new generation.

  `restores: "home"`. A standard box user cannot write `/Library` or install
  system daemons, which is what makes a home reset meaningful. With admin
  rights, only erasing the Mac restores it.
- **Permissions for computer use.**
  - The helper needs Accessibility and Screen Recording. macOS keeps these in
    the system TCC database, tied to the helper's code signature, so they
    survive recreating the home. The conformance suite checks this with a
    reset followed by computer use.
  - SIP protects that database on a running Mac, so a person grants them
    once per machine at setup.
  - An MDM profile can pre-approve Accessibility but not Screen Recording.
  - macOS 15 asks again periodically for apps that record the screen. Mac
    setup must check whether that prompt appears for the helper, and MDM can
    suppress it where available.
  - Commands over SSH do not have these grants, so the helper runs as a
    LaunchAgent in the box user's session and does the work. `session:
    "desktop"` uses it too.
- **Desktop.** Screen Sharing on 5900, with "VNC viewers may control screen
  with password" turned on at setup. Otherwise it offers only Apple's own
  authentication types.
  - The route is `ssh -W 127.0.0.1:5900 <mac>`, so the weak VNC password
    exchange never crosses the network.
  - A Mac with no display attached may need an HDMI dummy plug for a usable
    resolution; to be checked.
  - `resizable` false.
- **Kinds.** `macos-desktop` on Apple silicon (`arch` arm64, like Tart).
  Machines with Xcode add the features `xcode` and `ios-simulator`, and can
  offer a kind that requires them (see [Still open](#still-open)).
- **iOS Simulator.**
  - At setup: install Xcode, run `xcodebuild -runFirstLaunch`, download the
    iOS platform, and run `DevToolsSecurity -enable`.
  - `xcrun simctl` works over SSH as the box user. The Simulator window shows
    on the desktop display.
  - A separate `simulator` display, capturing only its window, can come later
    as a second display.
- **Commands and files.** SSH as the box user: shell `sh`, `admin` false,
  `inDesktopSession` false, `streaming` true.
- **Enrolment.** Yes: BB's host app runs on darwin.
- **Setup for a new user.**
  - On each Mac:
    - update macOS;
    - run the setup script with sudo, which creates the users, the skeleton
      and the reset scripts, and sets automatic login, Remote Login for the
      two users, and no sleep (`pmset`);
    - turn on Screen Sharing with the VNC password;
    - grant the helper's permissions;
    - install Xcode.
  - Then add the Mac to settings with its host key.
  - `doctor` checks everything it can see, including whether the permissions
    are granted (the helper reports them).
- **Conformance.** Needs a real Mac. The reset tests are the ones for the SSH
  pool, plus a LaunchAgent, a login item and a Simulator device left behind.

## Tart on the Apple Virtualization framework (virtual; later)

- **Where things run.** bb-box reaches each Mac host over SSH as
  `bbbox-admin` and runs `tart` there. VMs sit on the host's NAT
  (192.168.64.0/24), which only the host reaches, so every route goes through
  the host.
- **Acquire.**
  1. `tart clone <image> bbbox-<box>`. The clone is copy on write on APFS,
     and Tart gives it a new MAC address when another local VM has the same
     one.
  2. `tart set --cpu --memory`.
  3. `tart run --no-graphics --vnc-experimental`, run by a launchd job on the
     host so it outlives the SSH connection.
  4. `tart ip --wait --resolver agent`.

  Warm VMs are claimed in the pool store rather than renamed: `tart rename`
  moves the VM's directory and does not check whether the VM is running.
- **Ready.** SSH to the VM through the host answers, or `tart exec <vm>
  true`. `readyTimeoutMs` 5 min; boot time to be measured.
- **Release.** `tart stop`, then `tart delete`, and remove the launchd job.
- **Stop and start.** With `--suspendable` (macOS 14 and later), `stop` can be
  `tart suspend`, which frees the memory and the VM slot and resumes faster
  than a boot. A warm pool of suspended clones is worth measuring.
- **Address and access.** The VM's NAT address. `access.ssh` is
  `{host: <VM address>, user: admin, jump: <Mac host>}`: the Mac's key is
  pinned, and the VM's first key is accepted.
- **Capacity.** For each Mac:
  - `guests`: at most two running macOS VMs, counting every running VM on the
    Mac (`tart list`, and other hypervisors), not only bb-box's. A suspended
    VM does not count;
  - `memory`: the host's, less a reserve;
  - `disk`: APFS free space.
- **Commands and files.** SSH through the host: shell `sh`, `admin` true,
  `inDesktopSession` false. `tart exec` runs through tart-guest-agent over
  gRPC. The agent runs as a launchd global agent, so its commands run in the
  GUI session, which makes it the natural `session: "desktop"` helper for
  Tart.
- **Desktop.** `--vnc-experimental` starts a VNC server on the host, not in
  the VM. It uses Apple's Virtualization framework, and prints
  `vnc://:<password>@127.0.0.1:<port>` with a random port and a new password
  on each run.
  - The launchd job writes that URL to a file only `bbbox-admin` can read.
  - `open()` reads the file and returns the route
    `ssh -W 127.0.0.1:<port> <mac>`, with a `vnc-password`.
  - It shows the VM's screen from boot, needs nothing in the guest, and keeps
    the password out of `Guest.data`.
  - The alternative, `--vnc`, is the guest's Screen Sharing at the VM address,
    which needs the VNC password option turned on in the image.
- **Image.** Start from a Cirrus Labs image, such as
  `ghcr.io/cirruslabs/macos-tahoe-base`, or one of theirs with Xcode. Every
  image except the vanilla ones has the `admin` user (password `admin`) with
  automatic login and Remote Login, and tart-guest-agent. Then, with Packer's
  Tart plugin:
  - change the password;
  - add bb-box's helper and key;
  - grant the helper Accessibility and Screen Recording;
  - warm Xcode and the Simulator;
  - let Spotlight indexing finish, and turn off background services the box
    does not need.

  Devin prepares its Mac images by mounting the guest's disk on the host and
  editing macOS's configuration databases directly, rather than clicking
  through dialogs. Writing the helper's grants into the image's TCC database
  the same way would avoid a person granting them in each image; to be
  tested. Images are tens of GB, so pull them at setup, not at acquire.
- **Kinds.** `macos-desktop`, as for the physical Mac; images with Xcode add
  its features.
- **Enrolment.** Yes, as the VM's user.
- **Orchard.** For several Macs, bb-box can talk to an Orchard controller
  instead of SSH to each Mac:
  - `POST /v1/vms` creates a VM, and Orchard places it on a worker with a
    free slot;
  - `GET /v1/vms/{name}/ip` gives the address;
  - `PUT /v1/vms/{name}/state` changes the power state (running, stopped or
    suspended);
  - `GET /v1/vms/{name}/port-forward?port=` is a WebSocket to a port in the
    VM, which gives `websocket` routes for SSH and the display;
  - `/exec` is a WebSocket that runs commands over SSH to the VM, so outside
    the GUI session;
  - Orchard's VNC goes to the guest's Screen Sharing on 5900, not Tart's
    host-side server.

  This is a second driver for the same kinds, not needed for one or two Macs.
- **Setup for a new user.**
  1. An Apple silicon Mac on macOS 14 or later.
  2. `brew install openai/tools/tart`.
  3. Remote Login for `bbbox-admin` with bb-box's key.
  4. `tart pull` the image, then run the Packer build.
  5. Add the Mac to settings with its host key.

  `doctor` checks the Tart version, the image, free slots, and that a test
  clone's guest agent answers.
- **Conformance.** Needs a Mac. The suite adds a third acquire on a Mac that
  must be refused with the capacity message, and a suspend and resume.

## Licences

### Tart, Orchard and tart-guest-agent

Tart moved from Cirrus Labs to OpenAI in 2026. Since 5 June 2026 (Tart
[#1238](https://github.com/openai/tart/pull/1238), Orchard #446), all three
are under the Functional Source License 1.1 with the Apache 2.0 future
licence (FSL-1.1-ALv2), with the notice "Copyright 2022-2026 OpenAI" in Tart's
case. Before that they were under the Fair Source License, with a free tier
of 100 CPU cores for Tart and 4 Orchard workers. The licensing page on
tart.run still shows those old tiers, but the repository removed it on
6 June 2026 (#1240). The `LICENSE` file is what applies.

The terms that matter:

> A Permitted Purpose is any purpose other than a Competing Use. A Competing
> Use means making the Software available to others in a commercial product
> or service that: 1. substitutes for the Software; 2. substitutes for any
> other product or service we offer using the Software that exists as of the
> date we make the Software available; or 3. offers the same or
> substantially similar functionality as the Software.
>
> Permitted Purposes specifically include using the Software: 1. for your
> internal use and access; [...]

> If you redistribute any copies, modifications or derivatives of the
> Software, you must include a copy of or a link to these Terms and
> Conditions and not remove any copyright notices provided in or with the
> Software.

> We hereby irrevocably grant you an additional license to use the Software
> under the Apache License, Version 2.0 that is effective on the second
> anniversary of the date we make the Software available.

What this means:

- **Our use is allowed.** Running Tart on our own Macs to give our own threads
  macOS VMs is internal use. There is no longer a size limit.
- **Publishing bb-box is allowed.** bb-box runs the `tart` command that the
  user installs; it does not copy, modify or bundle Tart, so the FSL does not
  reach bb-box's code. To keep it that way:
  - the setup script installs Tart from its official source;
  - bb-box never vendors Tart's code or publishes images containing
    tart-guest-agent.
- **Users of bb-box.** The guide should say that offering macOS VMs to
  others as a commercial service, through bb-box or not, may be a Competing
  Use of Tart. Apple's licence forbids it anyway (below).
- **Each Tart release becomes Apache 2.0 two years after it is released.**

### Apple's macOS licence

The macOS Tahoe 26 licence, section 2B(iii), allows:

> up to two (2) additional copies or instances of the Apple Software [...]
> within virtual operating system environments on each Apple-branded
> computer you own or control that is already running the Apple Software,
> for purposes of: (a) software development; (b) testing during software
> development; (c) using macOS Server; or (d) personal, non-commercial use.

and continues:

> the grant set forth in Section 2B(iii) above does not permit you to use the
> virtualized copies or instances of the Apple Software in connection with
> service bureau, time-sharing, terminal sharing, relay service or other
> similar types of services.

Agents developing and testing software on your own Macs fit (a) and (b).
The Virtualization framework enforces the limit of two. Section 3 (leasing a
Mac with a minimum period of 24 hours) applies only to renting Macs to
others, which bb-box does not do.

### Others

- **Windows**: a licence per VM; evaluation media to try it.
- **Docker Engine** and **NVIDIA's container toolkit**: Apache 2.0. Docker
  Desktop needs a paid subscription in larger businesses.

## Interface changes

### Adopted in Interface v1

The changes this research proposed, as they are now in
[Interface v1](../architecture.md#interface-v1):

| Change | Needed by |
| --- | --- |
| `Route` (`tcp`, `command`, `websocket`), opened only by `openRoute`; `CommandTransport.route?(port)` | Tart behind the host's NAT, a remote Docker host, Proxmox's console WebSocket, Orchard's port-forward, VNC on a pool machine's localhost |
| `Display {id, label, protocol, resizable, open()}` returning a route and `DisplayAuth` (none or a VNC password); a list of displays per box; the relay answers RFB authentication | Proxmox's console ticket, Tart's per-run password, macOS Screen Sharing; a Simulator display later |
| `CommandCapability {transport, shell, admin, inDesktopSession, streaming}` | Windows (PowerShell, session 0), macOS over SSH (outside the GUI session), the QEMU guest agent (output at exit) |
| `run` tool option `session: "desktop"`, wrapped by the core's per-OS helper | opening apps and computer use on Windows and macOS |
| Kind IDs shared between backends, offers tried in the order of settings; `arch`, `features`, `computerUse`, `readyTimeoutMs` | Docker, LXC and pool machines offering the same kind; arm64 Macs; the Simulator; Windows first boot |
| `Guest.host`, `Guest.data`; `BoxTransports.access` with `SshAccess {host, port, user, hostKeys, jump}` and `dockerHost` | several hosts per backend, per-claim data, pinned keys on real machines, the Mac host as a jump |
| Capacity as named limits per host (`memory`, `disk`, `cpu`, `guests`, `gpu-desktops`, `gpu-memory`, `machines`) | two VMs per Mac, a Docker budget, GPUs, real pools |
| `release(guest, hooks)` with `resetting()` and `timing()`; `members?()`, `returnToService?()`; a reset generation checked at claim; `restores: "home" or "machine"` | the SSH pool and physical Macs |
| `start?` and `stop?` optional; power can be `unknown` | real machines |
| Enrolment only with shell `sh` on Linux or macOS | Windows |
| Doctor checks with a stable `id` and `ok`, `warn`, `fail` or `skipped`; a setup script and guide per driver | every backend |

### Adopted after the review

The review of Interface v1, a comment on pull request #4, is folded in by #5:

- A kind lists the features it requires (`BoxKind.requires`). An offer's
  `features` include them and may add more. `gpu` still agrees exactly
  ([012](../decisions/012-offers-may-add-features.md)).
- Docker inside a box is the feature `docker`, and the `docker` capability is
  gone.
- The kinds are `linux-headless`, `linux-headless-docker`, `linux-desktop`
  (GPU), `linux-desktop-cpu`, `windows-desktop` and `macos-desktop`. Kind IDs
  name what a kind promises, never what it lacks.
- `CommandTransport.kind` is dropped, so `transport` is the one name.
- Docker kinds run unprivileged, with `--init` and a start script. Only
  privileged kinds, which the operator turns on, offer `systemd` and
  `docker`. BB's installer runs its daemon without a service manager
  ([013](../decisions/013-docker-boxes-run-unprivileged.md)).
- The conformance suite copies 32 MiB each way and sends 1 MiB of stdin, so
  every transport proves it chunks.
- The architecture records:
  - Tart's display details file on the Mac host, and suspend as `stop`;
  - Tart counting every running VM on a Mac against `guests`;
  - one known_hosts file covering a jump host and its target;
  - the physical Mac's reboot on reset, and its console check;
  - Windows needing a warm pool.

### Still open

None of these change a type.

1. **A macOS kind with Xcode.** An agent that builds for iOS needs Xcode and
   the Simulator. Under 012 it asks for a kind that requires them, for
   example `macos-desktop-xcode` with `requires: ["xcode", "ios-simulator"]`,
   offered by physical Macs and Tart images with Xcode.
2. **`gpu` on macOS kinds.** Physical Macs and Tart VMs both render with
   Metal, Tart through its paravirtualised GPU. Neither takes a scarce GPU
   from a pool, so both should offer `gpu: false`, to agree exactly.
3. **Docker in the SSH pool.** The pool offers `linux-headless-docker` only
   with a whole-machine reset, or with rootless Docker for the box user,
   which a home reset removes. Rootless Docker needs testing before the pool
   claims the kind.
4. **Measurements still to take**:
   - a sysprepped Windows clone's first boot, and one that skipped
     generalize;
   - a Tart clone's boot, and a resume from suspend;
   - a physical Mac's reset and reboot.

  `readyTimeoutMs` values are estimates until then.

## Sources

Cloned on 30 September 2026:

- Tart 05edeac (https://github.com/openai/tart): `Sources/tart/Commands/Run.swift`,
  `Clone.swift`, `Exec.swift`, `IP.swift`, `Rename.swift`,
  `Sources/tart/VNC/FullFledgedVNC.swift`, `ScreenSharingVNC.swift`,
  `LICENSE`, `docs/quick-start.md`, `docs/blog/posts/2023-04-25-orchard-ga.md`;
  commits 5ad172e (relicense) and 1ea60ef (docs after the move to OpenAI).
- Orchard f101ade (https://github.com/openai/orchard): `internal/controller/api.go`,
  `api_vms_portforward.go`, `api_vms_exec.go`, `internal/controller/sshexec`,
  `internal/command/vnc/vm.go`, `pkg/resource/v1/v1.go`, `LICENSE`.
- tart-guest-agent 6d4bd9c: `README.md`, `LICENSE`.
- macos-image-templates (https://github.com/cirruslabs/macos-image-templates):
  `data/tart-guest-agent.plist`, `data/tart-guest-daemon.plist`.
- qemu-server a7b4240 (https://git.proxmox.com/?p=qemu-server.git):
  `src/PVE/API2/Qemu.pm` (`vncproxy`, `vncwebsocket`),
  `src/PVE/API2/Qemu/Agent.pm` (limits and privileges),
  `src/PVE/QemuServer/Cloudinit.pm` (configdrive2 for Cloudbase-Init).
- Apple, Software License Agreement for macOS Tahoe 26:
  https://www.apple.com/legal/sla/docs/macOSTahoe.pdf
- BB host app 0.44.0 `package.json` (`os: ["darwin", "linux"]`).
- Devin's article on Mac workspaces (image preparation by writing the guest's
  configuration databases from the host).
- The Docker measurements: the Dockerfile and scripts are not published.
