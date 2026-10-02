# Tart backend (VMs on a Mac)

This backend runs macOS boxes, and Linux boxes on arm64, as VMs on your Macs
with Apple silicon, with [Tart](https://tart.run) on Apple's Virtualization
framework. A box is a copy-on-write clone of an image you prepare once on
each Mac. It offers these kinds:

- **macos**: a macOS VM for builds and commands, its desktop not shown;
- **macos-desktop**: the same VM with its desktop shown in the thread's panel,
  shared control, and computer use through Cua Driver;
- **linux-arm64**: Ubuntu on arm64 with what a Linux box on Proxmox has,
  Docker included, from a second image (040). An agent may ask for it as
  linux-arm64-docker, linux-arm64 with Docker (041). Off until you give its
  image.
- **linux-arm64-desktop-cpu**: the same with an XFCE desktop drawn by the
  CPU, shown in the thread's panel, and computer use through Cua Driver,
  from a third image (040). Off until you give its image.
- **windows-arm64-desktop**: Windows 11 on arm64, its desktop shown in the
  thread's panel, and computer use through Cua Driver (046). QEMU runs its
  VM, with Apple's Hypervisor framework, not Tart. Off until you give its
  image, which you build from your own Windows ISO.

The macOS and Linux boxes enrol in BB as machines, as other Linux boxes do.
A Windows box does not, as on Proxmox.

The bb-box plugin, on the BB server, reaches each Mac over SSH as a host user
of its own and runs `tart` there. The VMs sit on the Mac's own NAT, which
only the Mac reaches, so bb-box reaches them through the Mac: commands over
SSH with the Mac as the jump host, and a macOS desktop through Tart's VNC
server. A Linux desktop has its own VNC server in the VM, reached over SSH.

Measured on a Mac with an M4 Max, macOS 27 on the host and in the VM, Tart
2.30.0, boxes of the small preset (4 cores, 8 GiB):

| Step | Time |
| --- | --- |
| Clone (copy on write) and size | about 0.1 s |
| First boot of a clone, from `tart run`: address, SSH, desktop logged in | 7 s, 10 s, 26 s |
| Resume from suspend, to SSH | about 4 s |
| A new SSH connection from the BB server's network, through the Mac | about 0.2 s |

| Path | What it does |
| --- | --- |
| `prepare-image.sh` | Builds the image a Mac's boxes are cloned from |
| `prepare-linux-image.sh` | Builds the image a Mac's Linux boxes are cloned from (040) |
| `prepare-windows-image.sh` | Builds the image a Mac's Windows boxes are made from, in QEMU (046) |
| `windows/` | What that script adds to the Proxmox Windows template's files: Windows' clock, and its check |
| `guest/customize.sh` | Runs inside the image's VM while it is built |
| `grant-tcc.sh` | Grants Cua Driver its permissions in a stopped VM's disk |

## Limits and licences

- **Two macOS VMs per Mac.** Apple's macOS licence (section 2B(iii)) allows
  two macOS VMs per Mac you own or control, for software development,
  testing during development, macOS Server or personal non-commercial use,
  and not as a service bureau or time-sharing service. The Virtualization
  framework enforces the limit. bb-box counts every macOS VM Tart runs on
  the Mac, not only its own, and refuses a third box with a message that
  says what to release. A VM another app runs (UTM, Docker Desktop's Linux
  VM and the like) is not in Tart's list; if it takes a slot, `tart run`
  fails with "The number of VMs exceeds the system limit", and bb-box
  reports that the Mac is full.
- **Tart's licence.** Tart is under the Functional Source License 1.1 with
  the Apache 2.0 future licence (FSL-1.1-ALv2), where internal use is a
  permitted purpose. bb-box runs the `tart` you install; it does not bundle
  Tart or publish images with Tart's guest agent. Offering macOS VMs to
  others as a commercial service, through bb-box or not, may be a Competing
  Use of Tart, and Apple's licence forbids it anyway.
- **Not a security boundary.** A box's user is an administrator of its VM,
  and the VM reaches the Mac's network through its NAT. See also the
  desktop's VNC server, below.

## Requirements

- A Mac with Apple silicon on macOS 14 or later (suspend needs 14). The VM's
  macOS must be no newer than the Mac's.
- Tart 2.30.0 is the version tested. bb-box reads `tart list` and the
  output of `tart run`, so check a newer release with the conformance suite
  (`npm run conformance -- --backend tart --settings <file>`) before relying
  on it.
- Disk: the base image takes about 37 GiB and the prepared image about 1.5
  GiB more. A box adds what it writes: about 2.5 GiB after its first boot,
  and about 3 GiB more while it is suspended (its memory, for an 8 GiB VM).
  bb-box keeps the reserve in its settings free.
- Memory: each box takes the memory of its size: 8, 16 or 32 GiB for the
  small, medium and large presets (028). bb-box keeps a reserve free for the
  Mac itself.
- For Windows boxes, QEMU on the host user's `PATH` in SSH sessions
  (`qemu-system-aarch64`, `qemu-img` and QEMU's UEFI firmware), from
  Homebrew or Nix. Each Windows box takes its memory and 2 GiB more for
  QEMU, and does not count against the two macOS VMs. Tart is needed only
  for macOS and Linux boxes.
- The Mac must stay awake: a sleeping Mac pauses its VMs. On a Mac that only
  serves boxes, turn sleep off (`sudo pmset -a sleep 0`); on a Mac you also
  use, keep it on power and awake while boxes run.

## 1. The host user

bb-box logs in to each Mac as a user of its own and runs Tart as that user,
so its VMs, images and SSH key are apart from yours. As an administrator on
the Mac:

```sh
# A standard user for bb-box. It never needs to log in at the Mac.
sudo sysadminctl -addUser bbbox-admin -fullName "bb-box" -password -
# Remote Login for that user: add it in System Settings > General > Sharing >
# Remote Login, or:
sudo dseditgroup -o edit -a bbbox-admin -t user com.apple.access_ssh
sudo systemsetup -setremotelogin on
```

Then, as `bbbox-admin`, install Tart from its official source:

```sh
brew install openai/tools/tart     # or: nix profile install nixpkgs#tart
tart --version
```

bb-box starts each VM's `tart run` detached from its SSH session, so the VM
outlives the connection. It needs no launchd job and no login item, and
works for a user that is not logged in at the Mac. (A launchd job would load
only in the GUI session of a user who is.) A VM does not come back by itself
after the Mac restarts: its box shows as stopped, and starting it boots it.

On a Mac you use yourself, you can instead give bb-box your own user. bb-box
then runs Tart as you, its VMs are in your `~/.tart`, and the BB server holds
a key that logs in as you. If that Mac is already a BB machine, BB can run
commands as you there anyway, so this adds no reach BB lacks.

## 2. bb-box's key

In BB, set up the Tart backend in BB Box's settings, leaving it off for now,
and press "Check". Its notes show bb-box's public key; the check fails until
a Mac is listed, which is expected here. Add the key to the host user's
`~/.ssh/authorized_keys`:

```sh
printf '%s\n' 'ssh-ed25519 AAAA... bb-box' >> ~/.ssh/authorized_keys
```

The same key goes into the image (section 3), for the VM's user.

## 3. The image

Run `prepare-image.sh` on the Mac as the host user. It clones a Cirrus Labs
base image, boots it, customises it from inside, shuts it down, grants Cua
Driver its permissions offline, boots it again to check them, and leaves a
stopped Tart VM named `bb-box-macos`. It takes about a minute and a half
once the base image is pulled; the pull itself is about 34 GB.

```sh
tart pull ghcr.io/cirruslabs/macos-tahoe-base:latest
./prepare-image.sh --key 'ssh-ed25519 AAAA... bb-box' \
  --from ghcr.io/cirruslabs/macos-tahoe-base:latest \
  --bb-url https://bb.example.com
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--key` | (required) | bb-box's public key, from `bb box doctor`. Give it again for each key the VM's user should accept |
| `--from` | `ghcr.io/cirruslabs/macos-tahoe-base:latest` | The image to start from: an OCI image or a local Tart VM, no newer than the Mac's macOS. For macOS 27, `ghcr.io/cirruslabs/macos-golden-gate-base:latest` |
| `--name` | `bb-box-macos` | The image to make |
| `--bb-url` | none | BB's server URL, to pre-install BB's host app, so a box enrols without downloading it |
| `--replace` | off | Replace an image of that name. Boxes cloned from the old one keep running |

What the image has:

- Cirrus Labs' base: user `admin` with automatic login and passwordless
  sudo, Homebrew, Git, Node 24, Xcode's command line tools and Tart's guest
  agent.
- bb-box's key for `admin`, and SSH that takes keys only. `admin`'s password
  is still `admin`, for the console only.
- The login PATH, Homebrew and Node for SSH commands (`~/.zshenv`): SSH
  commands run in a non-login zsh, which otherwise gets only
  `/usr/bin:/bin:/usr/sbin:/sbin`. When the box enrols, bb-box adds a line
  at the top that gives them the thread's environment and access.
- No sleep, no screen saver, no automatic updates, no Spotlight indexing.
- A launch daemon that clears BB's daemon lock and PID file at boot
  ([017](../../docs/decisions/017-boxes-clear-bb-daemon-state-at-boot.md)).
- Cua Driver 0.30.4, pinned by SHA-256, in `/Applications`, its daemon a
  LaunchAgent in `admin`'s session, with telemetry and update checks off for
  the daemon and the CLI, and Accessibility and Screen Recording granted.
- BB's host app, when `--bb-url` is given.
- Screen capture approved ahead for Cua Driver: see below.
- No "App Background Activity" notices. The user's Background Task
  Management agent, which posts them, is off, and the notices kept in
  Notification Center are removed. Background items still load and run.
  Without this, BB's daemon, added when a box enrols, leaves a notice on the
  desktop, and Notification Center shows a notice it keeps again at every
  login.

Cirrus Labs' image also grants `sshd-keygen-wrapper`, the process SSH logins
run under, Accessibility, Screen Recording and Apple Events. Commands over
SSH can therefore drive the desktop too, although they run outside its
session.

### The Linux image (arm64)

Linux boxes on a Mac (`linux-arm64`, 040) are
clones of a second image, which `prepare-linux-image.sh` builds from Cirrus
Labs' Ubuntu 24.04. It runs the Proxmox LXC template's own guest scripts in
the VM (`../proxmox-lxc/template`), with their arm64 tool pins, so a Linux
box on a Mac has what a Linux box on Proxmox has. It takes about 6 minutes
once the base image is pulled (3.1 GB), and leaves a stopped VM named
`bb-box-linux` of about 5.6 GB.

```sh
tart pull ghcr.io/cirruslabs/ubuntu:24.04
./prepare-linux-image.sh --key 'ssh-ed25519 AAAA... bb-box' --bb-url https://bb.example.com
```

Its options are `prepare-image.sh`'s, with `--from` defaulting to
`ghcr.io/cirruslabs/ubuntu:24.04` and `--name` to `bb-box-linux`. The keys
must be ed25519.

What it has, beyond the Linux template's development tools, agent CLIs,
Docker and BB's host app:

- user `box`, with bb-box's key and sudo without a password, as in every
  Linux box. Cirrus's `admin` user stays for Tart's guest agent, which runs
  as it, with its password locked;
- a 64 GB disk (sparse: it costs what a box writes), and the VM's own
  network and DNS from the Mac;
- packages from Ubuntu's live ports archive. Ubuntu keeps snapshots of its
  main archive only, so unlike the Proxmox template the arm64 image is not
  pinned to a snapshot date.

Everything in it is arm64: amd64 container images and x86_64 binaries do not
run there.

With `--desktop`, it builds the image Linux desktop boxes are cloned from
(`linux-arm64-desktop-cpu`), named `bb-box-linux-desktop` unless `--name`
says otherwise: the same, plus what the Proxmox CPU-only desktop template
has (`guest/customize-desktop.sh` with `DESKTOP_GPU=none`). That is XFCE on
display `:99` served over VNC on port 5900, drawn by the CPU, Chrome, Cua
Driver and Rust, all for arm64. It boots the VM once more to check the
desktop as the box user. It takes about 8 minutes, and the image is about
7.6 GB.

```sh
./prepare-linux-image.sh --desktop --key 'ssh-ed25519 AAAA... bb-box' --bb-url https://bb.example.com
```

### The Windows image (arm64)

Windows boxes on a Mac (`windows-arm64-desktop`, 046) are made from an
image that `prepare-windows-image.sh` builds in QEMU from your own Windows
11 Arm64 ISO, in English (United States), from Microsoft
(<https://www.microsoft.com/software-download/windows11arm64>). It installs
Windows unattended with the Proxmox Windows template's answer file and
first-logon scripts (`../proxmox-qemu`), adapted for arm64, and the arm64
virtio-win drivers, so a Windows box on a Mac has what one on Proxmox has:
OpenSSH with PowerShell 7 as its shell, Git, GitHub CLI and Cua Driver,
with `box` logged on at boot. Then it boots the image once as a box boots,
and checks a clone of it over SSH (`../proxmox-qemu/check.ps1`), saved and
restored as bb-box stops and starts a box.

```sh
./prepare-windows-image.sh --iso ~/Downloads/Win11_arm64.iso --iso-sha256 <its SHA-256> \
  --key 'ssh-ed25519 AAAA... bb-box' --delete-iso
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--iso`, `--iso-sha256` | (required) | The ISO, and its SHA-256, which the script checks |
| `--key` | (required) | bb-box's public key, as for the other images. ed25519 only |
| `--name` | `bb-box-windows` | The image to make, in `~/.bb-box/qemu/images` |
| `--edition`, `--product-key` | `Windows 11 Pro`, Microsoft's generic key for it | The edition to install, and its key. The generic key installs without activating, as on Proxmox |
| `--reserve-gib` | 50 | The disk space the build leaves free. It stops rather than leave less |
| `--delete-iso` | off | Delete the ISO once Setup has copied Windows from it |
| `--replace` | off | Build an image of that name again. Boxes made from the old build keep it |
| `--keep` | off | Keep a failed build's directory, to boot and look at |

It takes about 20 minutes on an M4 Max, and needs about 25 GiB beyond the
reserve while it runs; the image keeps about 15 GiB. Watch Setup with a VNC
viewer on the Mac, at the address the script prints. Each build is a
directory of the image, `build.<time>`, with a read-only `disk.qcow2` and
the UEFI variables; `current` links to the one new boxes are made from. A
failed build leaves its last screen and QEMU's output beside them.

QEMU's clock is UTC. The image reads it as UTC, and Windows' time service
syncs about every 17 minutes, which corrects a box a sleeping Mac has left
behind (`windows/clock.ps1`). bb-box also sets the clock when it starts a
stopped box.

### Permissions for computer use

macOS keeps Accessibility and Screen Recording grants in the system TCC
database, which System Integrity Protection guards on a running Mac. The
image script writes them while the VM is stopped instead, as Devin prepares
its Mac images: `grant-tcc.sh` attaches the VM's disk (an Apple sparse image)
with `diskutil image attach --noMount`, mounts only its Data volume with
`noowners,nobrowse`, so the host user can write the guest's files and Finder
does not show it, and adds a row per service for Cua Driver's bundle ID,
`com.trycua.driver`, with its code requirement. The rows follow Cua's
signing identity (team YCK386LBJ7), so a Cua update signed by the same team
keeps them. A denied row that Cua's first launch leaves is replaced. Then the
script boots the VM and checks that `cua-driver permissions status --json`
reports both. No person approves anything.

macOS 26 and later also ask once, on an app's first capture that bypasses
the system's window picker, and again after 30 days: "CuaDriver is
requesting to bypass the system private window picker and directly access
your screen and audio". replayd records when it last asked, in
`~/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist`,
and the dialog's Allow writes nothing else. The image writes Cua's entry
there dated far ahead, so its first capture, after a boot, a suspend and a
resume, raises no dialog.

## 4. Settings

In BB, under BB Box's settings, add each Mac as a host of the Tart backend.
A host has a short name, a switch, and these fields:

| Field | Example | Meaning |
| --- | --- | --- |
| `address` | `192.0.2.20` | The Mac's address, with `:port` when SSH is not on 22 |
| `user` | `bbbox-admin` | The host user bb-box logs in as |
| `host-keys` | `192.0.2.20 ssh-ed25519 AAAA...` | `ssh-keyscan -t ed25519 192.0.2.20` prints it. bb-box checks it on every connection |

A new box goes to the first Mac in the list with room. A Mac that is off
keeps its boxes and takes no new ones. The backend's own fields:

| Field | Example | Meaning |
| --- | --- | --- |
| `ssh-private-key` | empty | A secret. Empty makes bb-box generate one; its public key is in `bb box doctor` |
| `macos-image`, `macos-desktop-image` | `bb-box-macos` | The Tart VM each kind is cloned from, on every Mac. Empty turns the kind off |
| `linux-image` | empty | The Tart VM `linux-arm64` boxes are cloned from, such as `bb-box-linux`. Empty, the default, turns them off |
| `linux-desktop-image` | empty | The Tart VM `linux-arm64-desktop-cpu` boxes are cloned from, such as `bb-box-linux-desktop`. Empty, the default, turns them off |
| `windows-image` | empty | The image in `~/.bb-box/qemu/images` that `windows-arm64-desktop` boxes are made from, such as `bb-box-windows`. Empty, the default, turns them off |
| `vm-user` | `admin` | The macOS images' user. Linux boxes work as `box` |
| `vms-per-host` | 2 | At most 2 |
| `reserve-memory-mib`, `reserve-disk-gib` | 16384, 50 | A new box is refused when the Mac would have less. With 16 GiB kept free, a 16 GiB Mac takes no box and a 32 GiB Mac takes two 8 GiB boxes, so lower it on a small Mac you do not use yourself |

From a terminal, `bb box config show --json` prints the configuration and
`bb box config apply <file>` saves it; the Macs are the backend's `hosts`.
Before bb-box's configuration document, these were BB settings starting
`tart-`; the first start of the version that brings it moves them in, with
each Mac as a host.

Then `bb box doctor` checks each Mac: that SSH as the host user works with
its pinned key, that it is Apple silicon with Tart, that each kind's image is
there, and how many VMs, how much memory and how much disk it has free.

### A warm pool

The backend's warm count for a kind keeps that many suspended VMs ready, so
a box of the kind's default size is ready in about 4.5 s instead of 13 to
17 s. It is 0 by default. `macos` and `macos-desktop` share warm VMs while
they have the same image and default size; their counts add up. Set 1 on a
Mac given over to bb-box. On a Mac you also use, know what a warm VM costs:

- about 5.5 GiB of disk each, at the small preset: what its first boot
  writes, and its saved memory;
- while it is made, a VM slot and the default preset's memory for about
  30 s, after each box that takes one and after each change of the image,
  Tart or the Mac's macOS, which retire warm VMs;
- while it is made, a VM you start yourself can be refused, as the limit of
  two counts every macOS VM on the Mac.

A suspended VM takes no slot and no memory.

For `windows-arm64-desktop`, the warm count keeps that many Windows VMs
booted to the desktop and saved by QEMU, as a stop saves a box, so a box of
the default size restores one instead of booting a clone. Each holds what
its first boot wrote and its saved memory, up to its memory size, on disk.
While it is made, it takes its memory and 2 GiB more, after each box that
takes one and after each change of the Windows image's build, QEMU or the
Mac's macOS, which retire warm VMs. A saved VM takes no memory.

bb-box makes a warm VM, macOS or Windows, only when the Mac has the default
preset's memory free on disk beyond the disk reserve, for what its suspend
or save writes. A Mac with less gets no warm VM, and its boxes clone.

## How the plugin drives a box

- **Sizes.** A box gets the cores and memory of its size. bb-box refuses a
  size with more cores than the Mac has, or more memory than the Mac has
  left after its running VMs and the reserve. A macOS or Linux box keeps its
  image's disk: growing a macOS VM's disk needs its recovery partition
  removed and its APFS container grown inside the guest, so bb-box refuses
  a disk size for now. A Windows box may have a larger disk than the
  image's, if the Mac has what it grows by free beyond the reserve, and
  Windows extends C: over it; the disk takes only what Windows writes. The
  box's size, as status shows it, comes from the VM's config.

- **Acquire.** The box's VM is named `bb-box-<box ID>`. bb-box writes its
  owner file, `~/.bb-box/tart/owners/<VM>`, first, naming this install, the
  box, its thread, name, kind and creation time; then `tart clone` and `tart
  set` for the cores and memory of the box's size; then `tart run --no-graphics
  --vnc-experimental --suspendable`, detached; then it waits for the VM's
  address in the Mac's DHCP leases and for SSH through the Mac. Last, it
  names the VM after the box, its ComputerName, LocalHostName and HostName,
  with `scutil`.
- **A warm VM** is a clone named `bb-box-warm-<random>`, booted to the
  logged-in desktop and suspended. Its owner file says `filling`, then
  `warm`, and names the image and its build (its disk file's inode and
  modification time, so running the image to change it counts), Tart's
  version and the Mac's macOS build; a change of any of them, or of the
  kind's default size, retires it, and so does running it. A box at that
  size takes it: bb-box rewrites the owner file with the box's fields,
  resumes the VM, and names it after the box. A VM whose saved state does not restore is deleted, and
  the box gets a clone. An acquire that finds a warm VM being made in the
  last slot takes it over when it suits, or stops it. A Windows warm VM is
  made the same way, with its display helper compiled before QEMU saves
  it; its owner file names QEMU's version instead of Tart's, and a box that
  takes it has Windows' clock set after the restore.
- **Stop and start.** Stop suspends the VM, which frees its memory and its
  slot of the two; start resumes it in about 4 s, with its apps still open.
  A box's address is looked up again with `tart ip` when bb-box does not
  know it. The Mac's DHCP leases last an hour, so after a long suspend the
  address may have gone to another VM: each VM keeps its own name in
  `~/.config/bb-box/vm`, and bb-box refuses a VM that answers with another.
  A VM that keeps no name, as one made before names were kept or whose file
  was removed, gets one only when the Mac's ARP table gives its own MAC
  address for the address it answers at; otherwise bb-box refuses it.
  A saved state that does not restore, as after an update of macOS or Tart,
  is dropped, and the VM boots afresh from its disk.
- **Release.** `tart stop` and `tart delete`, then the owner file last, so a
  release cut short leaves a VM its install still finds.
- **Ownership.** The owner files are the record at the provider: bb-box finds
  its VMs from them if it loses its storage, and leaves alone the VMs of
  another install, which still count against the Mac's room.
- **Commands** run over SSH as the VM's user, outside the logged-in desktop
  session. `open -a <app>` from SSH still opens the app on the desktop.

### The desktop's VNC server

`--vnc-experimental` serves the VM's screen from the Virtualization
framework, from boot, with nothing installed in the VM. Each run has a new
port and a password of four random words, which Tart prints to the run's
output file, readable only by the host user. A viewer's connection goes
`ssh -W 127.0.0.1:<port>` to the Mac, and bb-box's relay answers the VNC
password; the browser never sees it.

- **What listens where.** Tart prints `127.0.0.1:<port>`, but the server
  listens on every interface of the Mac. While a desktop box runs, anyone on
  the Mac's networks who has that run's password can reach its desktop. To
  close it, either turn on the macOS firewall and block incoming connections
  to `tart` (System Settings > Network > Firewall > Options), or keep the
  Mac on a network you trust.
- **No resizing.** The server ignores a viewer's request for another size;
  the desktop is 2048x1536 pixels (1024x768 points at 2x).
- **A client must advertise DesktopSize.** The server ends the VM when a
  client asks for a framebuffer update without the DesktopSize
  pseudo-encoding (-223). noVNC and bb-box's relay advertise it.
- **Screen Sharing was tried instead.** The guest's own Screen Sharing would
  listen only on the VM's NAT address, which only the Mac reaches. With its
  legacy VNC password turned on, bb-box's relay can answer it. But a VNC
  connection gets a separate session at the login window, not the logged-in
  desktop, and moves the console to it, so you would not see the agent's
  desktop and the agent's session would lose the console. Its full frames
  also take 0.9 to 1.6 s against 0.3 s.

A Windows box's desktop is served by QEMU's VNC server instead, which
listens on the Mac's loopback only and so has no password. It does resize:
bb-box sets the listed mode that best covers the viewer, which the viewer
scales down, from 800x600 up.

## Troubleshooting

- **`tart` not found.** SSH sessions on a Mac get a short PATH. bb-box looks
  in `/opt/homebrew/bin`, `/usr/local/bin`, `~/.nix-profile/bin` and
  `/run/current-system/sw/bin`.
- **The Mac is full.** Two macOS VMs already run on the Mac, perhaps not
  bb-box's: `tart list` shows Tart's. Release or stop a box, or stop another
  VM.
- **A box does not answer SSH.** Check that the image's user accepts
  bb-box's key: from the Mac, `tart run bb-box-macos &`, then `ssh
  admin@$(tart ip bb-box-macos)` with the key.
- **A desktop box's VM stopped by itself.** If its output file,
  `~/.bb-box/tart/run/<VM>.out`, ends with "It is unclear if we can support
  clients that don't support this pseudo encoding", a VNC client without
  DesktopSize ended it. Start the box again.
