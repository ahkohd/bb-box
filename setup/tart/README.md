# Tart backend (macOS VMs)

This backend runs macOS boxes as VMs on your Macs with Apple silicon, with
[Tart](https://tart.run) on Apple's Virtualization framework. A box is a
copy-on-write clone of an image you prepare once on each Mac. It offers two
kinds:

- **macos**: a macOS VM for builds and commands, its desktop not shown;
- **macos-desktop**: the same VM with its desktop shown in the thread's panel,
  shared control, and computer use through Cua Driver.

Both enrol in BB as machines, as Linux boxes do.

The bb-box plugin, on the BB server, reaches each Mac over SSH as a host user
of its own and runs `tart` there. The VMs sit on the Mac's own NAT, which
only the Mac reaches, so bb-box reaches them through the Mac: commands over
SSH with the Mac as the jump host, and the desktop through Tart's VNC server.

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

In BB, set up the Tart backend in bb-box's settings, leaving it off for now,
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
  `/usr/bin:/bin:/usr/sbin:/sbin`.
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

In BB, under bb-box's settings, add each Mac as a host of the Tart backend.
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
| `vm-user` | `admin` | The image's user |
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

## How the plugin drives a box

- **Sizes.** A box gets the cores and memory of its size. bb-box refuses a
  size with more cores than the Mac has, or more memory than the Mac has
  left after its running VMs and the reserve. A box keeps its image's disk:
  growing a macOS VM's disk needs its recovery partition removed and its
  APFS container grown inside the guest, so bb-box refuses a disk size for
  now. The box's size, as status shows it, comes from the VM's config.

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
  kind's default size, retires it, and so does running it. A box at that size takes it: bb-box
  rewrites the owner file with the box's fields, resumes the VM, and names
  it after the box. A VM whose saved state does not restore is deleted, and
  the box gets a clone. An acquire that finds a warm VM being made in the
  last slot takes it over when it suits, or stops it.
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
