# Tart backend (VMs on a Mac)

This backend runs VMs on your Macs with Apple silicon, with
[Tart](https://tart.run) on Apple's Virtualization framework, and QEMU for
Windows. A box is a copy-on-write clone of an image you prepare once on each
Mac. It offers these kinds:

- **macos**: a macOS VM for builds and commands, its desktop not shown;
- **macos-desktop**: the same VM with its desktop shown in BB, and computer
  use through Cua Driver;
- **linux-arm64**: Ubuntu on arm64 with what a Linux box on Proxmox has,
  Docker included (040). Off until you give its image;
- **linux-arm64-desktop-cpu**: the same with an XFCE desktop drawn by the CPU,
  and computer use. Off until you give its image;
- **windows-arm64-desktop**: Windows 11 on arm64, run by QEMU, with its
  desktop and computer use (046). Off until you give its image, which you
  build from your own Windows ISO.

macOS and Linux boxes join BB as machines; a Windows box does not yet.

bb-box reaches each Mac over SSH as a host user of its own, and runs `tart`
there. The VMs sit on the Mac's own NAT, so bb-box reaches them through the
Mac. A clone boots to SSH in about 10 s and to a logged-in desktop in about
26 s; a warm VM is ready in about 4.5 s, and a stopped box resumes in about
4 s. How bb-box drives a box is in the
[architecture](../../docs/architecture.md#backends).

| Path | What it does |
| --- | --- |
| `prepare-image.sh` | Builds the macOS image |
| `prepare-linux-image.sh` | Builds the Linux images (040) |
| `prepare-windows-image.sh` | Builds the Windows image, in QEMU (046) |
| `prepare-ios-image.sh` | Builds the iOS image on the macOS image (063) |
| `ios/` | What that script adds, and the iOS image's check: [its guide](ios/README.md) |
| `windows/` | What that script adds to the Proxmox Windows template's files |
| `guest/customize.sh` | Runs inside the image's VM while it is built |
| `guest/launcher.sh` | Builds bb-box's launcher for desktop commands in the image, with its permissions (#628) |
| `grant-tcc.sh` | Grants Cua Driver its permissions in a stopped VM's disk |

## What you need

- A Mac with Apple silicon on macOS 14 or later. A VM's macOS must be no
  newer than the Mac's.
- Tart 2.30.0, the version tested. bb-box reads the output of `tart run`,
  and reads Tart's VM folders as Tart does: a VM runs while a process holds
  Tart's lock on its config.json. It does not run `tart list` or `tart get`
  to read a Mac's state, as Tart 2.40 sizes every ASIF disk with diskutil
  then, and a VM that starts meanwhile cannot lock its disk. Check a newer
  release with the conformance suite before relying on it (see Update).
- perl, which macOS has in /usr/bin: bb-box reads Tart's lock with it.
- Disk: the macOS base image with Xcode takes about 80 GiB, and the prepared
  image a few GiB more. A box adds what it writes: about 2.5 GiB after its
  first boot, and its memory while it is suspended. The VMs can be on
  another volume (see below).
- Memory: each box takes the memory of its size, 8, 16 or 32 GiB for the
  small, medium and large presets. bb-box keeps a reserve free for the Mac
  itself.
- For Windows boxes: QEMU on the host user's `PATH` in SSH sessions
  (`qemu-system-aarch64`, `qemu-img` and QEMU's UEFI firmware), from Homebrew
  or Nix. Each Windows box takes its memory and 2 GiB more.
- For a macOS desktop: `/usr/bin/python3` from Xcode's command line tools
  (`xcode-select --install`), which Homebrew needs anyway. It runs the holder
  that shares the desktop with viewers.
- For a Windows desktop as video: `swiftc` from the same command line tools.
  bb-box builds its bb-box-stream on the Mac with it, into
  `~/.bb-box/qemu/bin`, which reads QEMU's VNC server and encodes the
  desktop with the Mac's hardware encoder (#865). Without it, Windows
  desktops show over VNC only, and `bb box doctor` says so.
- The Mac must stay awake: a sleeping Mac pauses its VMs. On a Mac that only
  serves boxes, turn sleep off with `sudo pmset -a sleep 0`.

Before you rely on it:

- **Two macOS VMs per Mac.** Apple's macOS licence (section 2B(iii)) allows
  two macOS VMs per Mac you own or control, for development and testing,
  and not as a service bureau or time-sharing service. The Virtualization
  framework enforces it. bb-box counts every macOS VM Tart runs on the Mac,
  and refuses a third box, saying what to release. A VM another app runs,
  such as UTM's, is not in Tart's list; when it takes a slot, bb-box reports
  that the Mac is full.
- **Tart's licence.** Tart is under the Functional Source License 1.1
  (FSL-1.1-ALv2), where internal use is a permitted purpose. bb-box runs the
  `tart` you install, and bundles no Tart and no images. Offering macOS VMs
  to others as a commercial service may be a Competing Use of Tart, and
  Apple's licence forbids it anyway.
- **Not a security boundary.** A box's user administers its VM, and the VM
  reaches the Mac's network through its NAT.
- **A macOS desktop listens on every interface.** Tart's VNC server listens
  on all the Mac's interfaces, with a password per run, and a second
  connection to it crashes the VM. Turn on the macOS firewall and block
  incoming connections to `tart`, or keep the Mac on a network you trust.
- **No resizing.** A macOS desktop is 2048x1536 pixels. A Windows desktop
  takes the viewer's size.

## Steps

### 1. The host user

bb-box logs in to each Mac as a user of its own, so its VMs, images and key
are apart from yours. As an administrator on the Mac:

```sh
# A standard user for bb-box. It never needs to log in at the Mac.
sudo sysadminctl -addUser bbbox-admin -fullName "bb-box" -password -
# Remote Login for that user: add it in System Settings > General > Sharing >
# Remote Login, or:
sudo dseditgroup -o edit -a bbbox-admin -t user com.apple.access_ssh
sudo systemsetup -setremotelogin on
```

Then, as `bbbox-admin`, install Tart:

```sh
brew install openai/tools/tart     # or: nix profile install nixpkgs#tart
tart --version
```

bb-box starts each VM detached from its SSH session, so the VM outlives the
connection, with no launchd job and no login. A VM does not come back by
itself after the Mac restarts: its box shows as stopped, and starting it
boots it.

On a Mac you use yourself, you can give bb-box your own user instead. Its VMs
are then in your `~/.tart`, and BB's server holds a key that logs in as you.

### 2. bb-box's key

On BB Box's settings page in BB, set up the Tart backend, leaving it off for
now, and press Check. Its notes show bb-box's public key; the check fails
until a Mac is listed, which is expected here. Add the key to the host
user's `~/.ssh/authorized_keys`:

```sh
printf '%s\n' 'ssh-ed25519 AAAA... bb-box' >> ~/.ssh/authorized_keys
```

The same key goes into the images, for the VM's user.

### 3. The images

Run the prepare scripts on the Mac, as the host user. Each leaves a stopped
image, and writes the image's record, which the doctor reads.

#### macOS

```sh
tart pull ghcr.io/cirruslabs/macos-golden-gate-xcode:27
./prepare-image.sh --key 'ssh-ed25519 AAAA... bb-box' --bb-url https://bb.example.com
```

The pull is about 69 GB. The script then takes a few minutes, most of them
booting an iPhone Simulator once. It leaves a stopped Tart VM named
`bb-box-macos`.

| Option | Default | Meaning |
| --- | --- | --- |
| `--key` | (required) | bb-box's public key. Give it again for each key the VM's user should accept |
| `--from` | `ghcr.io/cirruslabs/macos-golden-gate-xcode:27` | The image to start from, no newer than the Mac's macOS. `ghcr.io/cirruslabs/macos-golden-gate-base:latest` has the Command Line Tools alone, in about half the disk; the doctor warns that its boxes have no XCTest, Metal compiler or iOS Simulator |
| `--name` | `bb-box-macos` | The image to make |
| `--bb-url` | none | BB's server URL, to put BB's app in the image, so a box joins BB faster |
| `--replace` | off | Replace an image of that name. Boxes cloned from the old one keep running |

The image has Cirrus Labs' base (user `admin` with automatic login and
passwordless sudo, Homebrew, Git, Node and Xcode 27 with the iOS Simulator
and the Metal toolchain), plus:

- bb-box's key for `admin`, and SSH that takes keys only. `admin`'s password
  is still `admin`, for the console only;
- the login PATH, Homebrew and Node for SSH commands;
- no sleep, screen saver, automatic updates or Spotlight indexing, and no
  "App Background Activity" notices;
- Cua Driver, pinned by SHA-256, as a LaunchAgent in `admin`'s session, with
  telemetry and update checks off. The script grants it Accessibility and
  Screen Recording in the stopped VM's disk, and approves its screen capture
  ahead, so nobody has to approve anything;
- Google Chrome, from Google's stable download, with
  `../ssh-pool/mac-chrome.sh`, as setup-mac.sh installs it on a pool Mac.
  The download names no version, so its signature is the check: it must
  verify, Gatekeeper must accept it as notarised, and Google's team,
  EQHXZ8M8AV, must have signed it. Its policies, in /Library/Preferences as
  macOS empties /Library/Managed Preferences at boot without device
  management, turn off its default-browser, promotion and sign-in prompts
  and sync, as on Linux, at the recommended level. `admin`'s profile is past
  Chrome's first run and its What's New, which no policy turns off. The
  record lists its version, and the image's check reads the policies Chrome
  applies, as chrome://policy lists them;
- BlackHole 2ch, pinned by SHA-256, a virtual audio device that is the
  default input: what is played to its output comes back as the
  microphone, so a test can feed speech in with `say -a BlackHole`;
- bb-box's launcher, which commands in the desktop session (`box_run` with
  `desktop: true`) go through. TCC attributes what a command over SSH starts
  to `sshd-keygen-wrapper`, for which macOS never asks, so an app started
  that way could not have the microphone or record the system's audio. The
  launcher makes itself the responsible process instead, as Terminal does
  for what it starts, and has the microphone, the camera, the system's audio
  and what `sshd-keygen-wrapper` is allowed, so nobody has to approve
  anything. An app opened with `open -a` is its own responsible process, and
  macOS asks about it, in a prompt computer use can answer. A VM that can be
  suspended has no audio input device of its own, so BlackHole is the
  microphone;
- bb-box-stream, built from `../ssh-pool/mac-stream.swift` with the
  image's Xcode: the desktop as H.264 video for the panel, from
  VideoToolbox's hardware encoder, which the VM passes to the Mac's (060).
  It runs over SSH in the desktop session, with the grants SSH has there.
  bb-box offers the video once its `video` field is on and every Mac's
  image record lists it;
- BB's app, with `--bb-url`.

At each macOS box's start, bb-box runs the SSH host pool's Mac helper,
`../ssh-pool/machine-mac.sh`, in the VM through sudo. It gives `admin` a
code-signing identity of its own, "bb-box local code signing", so an app
signed with it keeps its grants when it is rebuilt. It also gives commands
run over SSH the microphone and the camera, which the launcher gives only
to desktop commands. This takes about 0.7 s of the box's start.
`box_grant` then grants the box's programs other permissions, such as
Accessibility, through the same helper
([058](../../docs/decisions/058-a-mac-with-sip-off-grants-its-box-users-macos-permissions.md)).
Both need System Integrity Protection off in the image: `csrutil status`
in a box says whether it is. With it on, `box_grant` refuses and says so.

#### Linux (arm64)

```sh
tart pull ghcr.io/cirruslabs/ubuntu:24.04
./prepare-linux-image.sh --key 'ssh-ed25519 AAAA... bb-box' --bb-url https://bb.example.com
./prepare-linux-image.sh --desktop --key 'ssh-ed25519 AAAA... bb-box' --bb-url https://bb.example.com
```

It runs the Proxmox LXC template's guest scripts in the VM, with their arm64
pins, so a Linux box on a Mac has what one on Proxmox has, with user `box`.
The first command makes `bb-box-linux` (about 6 minutes, 5.6 GB); with
`--desktop` it makes `bb-box-linux-desktop`, with XFCE, VNC, Chrome and Cua
Driver (about 8 minutes, 7.6 GB). Its options are `prepare-image.sh`'s; the
keys must be ed25519. Packages come from Ubuntu's live ports archive, which
has no snapshots, so the arm64 image is not pinned to a date. Everything in it
is arm64: amd64 container images and x86_64 binaries do not run there.

#### iOS

```sh
./prepare-ios-image.sh
```

It clones the macOS image and adds idb_companion and a booted-once, slimmed
iPhone 18 Pro, iPhone 17 and iPad Pro 13-inch (M5), in about 17 minutes. With
the Tart backend's `ios-image` set to it, bb-box offers ios boxes, each a clone
of it with one device booted. [The iOS image's guide](ios/README.md) says what
it has, and how it is checked and refreshed.

#### Shared iOS hosts

With `ios-hosts-on` set, an ios box is a macOS user with its own device on
a VM of the iOS image shared with other ios boxes
([064](../../docs/decisions/064-ios-shared-hosts.md)). It is the default:
an ios box asked for with no options takes a slot where a host has room or
can start, and is a VM of its own otherwise. One asked for with
`shared: true` takes a slot or is refused; one asked for with
`dedicated: true`, another device than the first or `slim: false` is a VM
of its own. A slot has no size of its own, so an ios box that asks for a
size without `dedicated: true` is refused, with "A shared ios box has no
size of its own. Ask for dedicated: true with a size." Ask for both to get
a VM of that size. With `ios-hosts-on` off, every ios box is a VM of its
own, as before.

- **A host is made for a box.** When no host has room, bb-box clones the iOS
  image as `bb-box-host-<id>` at the hosts' size and starts it. Boxes asked
  for while it starts join it, up to its slots, so three asked for at once
  make one host. bb-box gives the host its own `device-host` helper and the
  settings above as it starts; a change of setting applies to hosts made
  after it.
- **A box takes a slot.** The image's two carried slots go first, then slots
  the host makes, about 30 s each. A ready slot is claimed in about a
  second.
- **The last release deletes the host,** and the Mac's VM slot is free
  again. A box asked for while it is deleted gets a new host in that slot,
  which starts once the old VM has stopped; a new host whose Mac has no
  VM slot free as it starts waits for one, for up to 10 minutes. A host that starts again after its Mac restarted, or whose start
  was cut short, is carried on by the upkeep; one that failed, or holds no
  box, is deleted by it.
- **An image change drains a host softly:** a host on an older build of the
  iOS image lends its ready slots while no host on the new build can start on
  its Mac, and is deleted at its last release.
- **What a slot box gives up:** sudo, Homebrew, its own cores and ports, the
  host's desktop, a size, a stop and a start. Its device's stream shares the
  Mac's video encoder with every device there, as a dedicated box's does,
  and bb-box keeps them within it (064, unit 6). Every slot
  has the image's first device model; ask for `dedicated: true` for another.
- **A macos box asked for with `shared: true`** takes a slot as an ios box
  does, and the slot's device is deleted at the claim. It is a macOS user for
  commands, builds and the simulator, with no sudo, Homebrew, desktop or
  grants. A host with a macos box in it stays up for it as for an ios box,
  and its slot is removed at the release, never lent to an ios box. A macos
  box asked for without it is a VM of its own, as before.
- **`bb box doctor`'s check Shared iOS hosts on** each Mac lists each host,
  its slots and what each held slot uses.

The [iOS image's guide](ios/README.md#shared-hosts-device-host) has the
helper's commands and state.

#### Windows (arm64)

Download Windows 11 Arm64 in English (United States) from Microsoft
(<https://www.microsoft.com/software-download/windows11arm64>), then:

```sh
./prepare-windows-image.sh --iso ~/Downloads/Win11_arm64.iso --iso-sha256 <its SHA-256> \
  --key 'ssh-ed25519 AAAA... bb-box' --delete-iso
```

It installs Windows unattended with the Proxmox Windows template's files,
adapted for arm64, so a Windows box on a Mac has what one on Proxmox has,
bb-box-stream.exe too, with Cisco's arm64 OpenH264, for the desktop as video
(060). It then checks a clone of the image over SSH, saved and restored as
bb-box stops and starts a box. It takes about 30 minutes, and needs about 40 GiB beyond
the reserve while it runs; the image keeps about 30 GiB. Watch Setup with a
VNC viewer on the Mac, at the address the script prints.

| Option | Default | Meaning |
| --- | --- | --- |
| `--iso`, `--iso-sha256` | (required) | The ISO, and its SHA-256, which the script checks |
| `--key` | (required) | bb-box's public key. ed25519 only |
| `--name` | `bb-box-windows` | The image to make, in `~/.bb-box/qemu/images` |
| `--edition`, `--product-key` | `Windows 11 Pro`, Microsoft's generic key for it | The edition to install, and its key. The generic key installs without activating |
| `--reserve-gib` | 50 | The disk space the build leaves free. It stops rather than leave less |
| `--delete-iso` | off | Delete the ISO once Setup has copied Windows from it |
| `--replace` | off | Build an image of that name again. Boxes made from the old build keep it |
| `--keep` | off | Keep a failed build's directory, to boot and look at |

### 4. Configure bb-box

On BB Box's settings page in BB, add each Mac as a host of the Tart backend.
A host has a short name, a switch, and these fields:

| Field | Example | Meaning |
| --- | --- | --- |
| `address` | `192.0.2.20` | The Mac's address, with `:port` when SSH is not on 22 |
| `user` | `bbbox-admin` | The host user bb-box logs in as |
| `host-keys` | `192.0.2.20 ssh-ed25519 AAAA...` | `ssh-keyscan -t ed25519 192.0.2.20` prints it. bb-box checks it on every connection |

A new box goes to the first Mac in the list with room. A Mac that is off keeps
its boxes and takes no new ones. The backend's own fields:

| Field | Example | Meaning |
| --- | --- | --- |
| `ssh-private-key` | empty | A secret. Empty makes bb-box generate one; its public key is in `bb box doctor` |
| `macos-image`, `macos-desktop-image` | `bb-box-macos` | The Tart VM each kind is cloned from, on every Mac. Empty turns the kind off |
| `linux-image` | empty | The image of `linux-arm64` boxes, such as `bb-box-linux`. Empty, the default, turns them off |
| `linux-desktop-image` | empty | The image of `linux-arm64-desktop-cpu` boxes, such as `bb-box-linux-desktop`. Empty, the default, turns them off |
| `ios-image` | empty | The iOS image, such as `bb-box-ios`, which `prepare-ios-image.sh` builds on the macOS image. Empty, the default, turns it off. bb-box checks and refreshes it |
| `ios-hosts-on` | off | Shared iOS hosts, [below](#shared-ios-hosts): an ios box takes a slot on a VM of the iOS image made as a host, by default |
| `ios-hosts-most` | empty | A host's slots making, ready or held at most. Empty, bb-box estimates it for each Mac: the fewest of the host's cores over 1.3, its memory over 1.5 GiB after 8 GiB for the host, and what the Mac's video encoder allows, 12 on an M4 Max |
| `ios-hosts-ahead`, `ios-hosts-resetting-most` | 1, 4 | Ready slots a host keeps while it holds a box, and released slots it sweeps in one pass |
| `ios-hosts-cores`, `ios-hosts-memory-gib` | empty | Each host's VM's size, which its slots share. Empty, the Mac's performance cores, and 8 GiB for the host and 1.5 GiB for each slot, within the Mac's memory. On a 16-core, 128 GiB M4 Max: 12 cores, 9 slots and 22 GiB |
| `ios-hosts-per-mac` | 1 | Hosts a Mac runs at most. Each is one of the Mac's two macOS VMs, and both share the Mac's video encoder |
| `ios-hosts-disk-reserve-gib` | 10 | A host makes no new slot while its VM has less free disk than this |
| A Mac's `ios-hosts-most`, `ios-hosts-cores`, `ios-hosts-memory-gib` | empty | The same sizes for one Mac's hosts, set on the Mac, over the backend's and the estimate. `bb box doctor` gives each Mac's sizes and where each came from |
| `windows-image` | empty | The image in `~/.bb-box/qemu/images` of `windows-arm64-desktop` boxes: the name `prepare-windows-image.sh` was given with `--name`, or its default. Empty, the default, turns them off |
| `tart-windows-enrol` | on | Windows boxes join BB as machines, as the Proxmox QEMU backend's do. Off, they are boxes only |
| `video` | off | macOS desktops open as video, from bb-box-stream in the image (060), not VNC. Off by default: they open as VNC, which is already smooth on a Tart Mac, at 52 to 55 frames a second, and a person can choose video under Display. Video uses much less bandwidth, about 1.2 Mbit/s against 20 while scrolling, but a key shows a little later, about 57 ms against 31 |
| `vm-user` | `admin` | The macOS images' user. Linux boxes work as `box` |
| `vms-per-host` | 2 | At most 2 |
| `reserve-memory-mib`, `reserve-disk-gib` | 16384, 50 | A new box is refused when the Mac would have less. With 16 GiB kept free, a 32 GiB Mac takes two 8 GiB boxes; lower it on a small Mac you do not use yourself |

From a terminal, `bb box config show --json` prints the configuration and
`bb box config apply <file>` saves it; the Macs are the backend's `hosts`.

#### A warm pool

A kind's warm count keeps that many VMs ready, suspended (macOS and Linux) or
saved by QEMU (Windows), so a box of the kind's default size is ready in
seconds instead of a boot. It is 0 by default. `macos` and `macos-desktop`
share warm VMs while they have the same image and default size. Set 1 on a
Mac given over to bb-box. On a Mac you also use, a warm VM costs:

- about 5.5 GiB of disk each, at the small preset;
- while it is made, a VM slot and the default preset's memory for about
  30 s, after each box that takes one, and after each change of the image,
  Tart or the Mac's macOS;
- while it is made, a VM you start yourself can be refused, as the limit of
  two counts every macOS VM.

bb-box makes a warm VM only when the Mac has the default preset's memory free
on disk beyond the disk reserve.

## Check it worked

Run `bb box doctor`. For each Mac it checks SSH as the host user with its
pinned key, Apple silicon and Tart, each kind's image, and the VMs, memory
and disk free. For each image it:

- fails when the image keeps an older contract than bb-box needs;
- warns when it is older than 14 days (Linux) or 60 days (macOS and Windows),
  has another build of BB's app than BB's server gives (not on Windows), or
  was built with other pins than this bb-box's copy of its script;
- warns, for a Windows image whose boxes join BB, when it has no Node.js
  22.19 or later, or none of the agent CLIs.

A Windows box takes about 2 minutes to join BB on a Mac, most of it BB's
installer. What it needs, and what its machine can and cannot do, is in the
[Proxmox QEMU guide](../proxmox-qemu/README.md#windows-boxes-as-bb-machines).

Its fix gives the prepare script's command that builds the image again.

### VMs on another volume

Tart's VMs and images, `~/.tart`, and bb-box's QEMU files for Windows,
`~/.bb-box/qemu`, can be on another volume, such as an external NVMe drive
that stays plugged in. Make each a link to a folder on it; nothing else
changes, as everything that uses them, Tart and QEMU too, follows the link:

```sh
# With bb-box's backend for the Mac turned off, no VM running, and warm VMs deleted.
# Tart makes its control.sock sockets again, and ditto cannot copy them.
find ~/.tart/vms -name control.sock -type s -delete
mkdir -p /Volumes/<volume>/bb-box
ditto ~/.tart /Volumes/<volume>/bb-box/tart.noindex
ditto ~/.bb-box/qemu /Volumes/<volume>/bb-box/qemu
# ditto fills a Tart disk image's holes: a 6 GB Linux image takes 60 GB. dd keeps it sparse.
for f in ~/.tart/vms/*/disk.img; do
  t=/Volumes/<volume>/bb-box/tart.noindex/vms/${f#$HOME/.tart/vms/}
  dd if="$f" of="$t" bs=1m conv=sparse && touch -r "$f" "$t"
done
# Compare each copy with its original (cmp) before you switch.
mv ~/.tart ~/.tart.pre-move && ln -s /Volumes/<volume>/bb-box/tart.noindex ~/.tart
mv ~/.bb-box/qemu ~/.bb-box/qemu.pre-move && ln -s /Volumes/<volume>/bb-box/qemu ~/.bb-box/qemu
```

- **Keep both on the one volume.** APFS clones share blocks only within a
  volume: a box is a clone of its image, and costs only what it writes,
  when both are there. A copy holds each clone in full, so copy the images
  and let warm VMs be made again on the volume rather than copying them. Measured on an external PCIe NVMe drive,
  boxes boot and build as fast as on the Mac's own disk (#632).
- **The disk reserve is the volume's.** bb-box measures the free space where
  `~/.tart` leads, and its messages name the volume.
- **When the volume is not mounted**, bb-box counts the Mac as unreachable
  and keeps its boxes, saying which link leads nowhere. Check that the
  volume mounts after a restart, before boxes are needed.
- **The way back:** remove the links and move the `.pre-move` folders back,
  or, once those are deleted, copy the folders back with `ditto`.
- **Spotlight skips a folder whose name ends in `.noindex`**, as it skips
  the hidden `~/.tart`. In a folder it indexes, it opens each new VM's disk
  after Tart makes it. Measured on macOS 26, those opens take no lock, so
  they cannot fail a start as `tart list`'s did (F-12), but they read every
  new disk. A `.metadata_never_index` file in the folder does not stop it.
  `bb box doctor` says when Spotlight indexes Tart's folder, with the
  commands that keep it out and undo that. `sudo mdutil -i off
  /Volumes/<volume>` works too, for a volume that holds nothing else
  Spotlight should index.

### Snapshots

bb-box keeps a box's snapshots (070) beside Tart's `vms` folder, in
`bb-box-snapshots`, where `~/.tart` leads: each is an APFS clone of the
VM's folder, with a `label` file that names the install, the box and the
snapshot. Nothing is installed for them on the Mac; they use the Mac's
`python3`, as the VNC holder does, and `diskutil`.

- **Keep the folder on the VMs' volume.** There a clone takes a moment and
  no space. bb-box copies only with APFS's `clonefile`, never with `cp`,
  which makes a full copy when it cannot clone: measured, 1 GB of a 96 GB
  VM in 7.5 minutes. So it refuses to take, restore or fork a snapshot when
  the folder is on another volume, or when APFS will not clone.
- **The disk reserve applies.** bb-box copies nothing, and suspends nothing
  to copy, while the volume has less free than `reserve-disk-gib`, or 20
  GiB, whichever is more. A copy grows as its box changes, up to the VM's
  disk and memory.
- **A macOS snapshot holds the VM's memory**, which restores only under the
  macOS build and Tart that saved it. bb-box notes both at each suspend, in
  `~/.bb-box/tart/run/<vm>.saved-under`, and after an update of either it
  forks such a snapshot rather than restore it.
- **A restore records its phases** in `bb-box-snapshots/.rollbacks/<vm>`,
  and stages its copy in `.restore-<vm>` and the VM's own folder in
  `.replaced-<vm>`. If it is cut short, bb-box puts the right folder back
  the next time it reads the box, starts it or releases it; a release
  deletes what is left, a fork's `.fork-<vm>` too.
- **A fork's disk is cleaned on the Mac** before its first boot: bb-box
  attaches the fork's own copy of `disk.img` with `diskutil image attach
  --noMount`, finds the Data volume in that image's own APFS container,
  never the Mac's, mounts it under `/tmp` as the host user, removes the
  source's BB machine, BB's LaunchAgent, the access file, the VM's name and
  the SSH host keys, and ejects it. The fork's VM then gets a new MAC
  address and machine identifier with `tart set --random-mac
  --random-serial`. A Mac whose macOS has no `diskutil image attach`, which
  macOS 27 has, makes no macOS forks and keeps no macOS snapshot past a
  release; `bb box doctor` warns in "macOS forks on <mac>".
- **macOS boxes get an identity reset** when they are first ready: bb-box
  installs `/usr/local/sbin/bb-box-identity` and the LaunchDaemon
  `dev.bb-box.identity` in each macOS VM, which also runs at a fork's first
  boot. An iOS box in a VM of its own is a macOS VM, and gets the same reset.
- **An iOS box in a VM of its own takes snapshots as a macOS box does**,
  with its device's state in the VM's memory, and its snapshot's label says
  `kind=ios`. An iOS box in a slot on a shared iOS host takes none: it has
  no VM of its own to copy.
- **Linux boxes have the identity reset in their image**, on, from an image
  `prepare-linux-image.sh` built from this bb-box on: it runs at each boot
  before the network, SSH and the box user's services. A Linux fork gets a
  new MAC address from Tart, and its reset gives up the source's BB machine,
  tailnet node, access file, SSH host keys and machine ID. Its disk is not
  cleaned on the Mac. Linux desktops fork and Keep from an image built with
  reset version 9 or later. Older images refuse both and say why: refresh
  the image and make the box again.
- **A stopped box's snapshot forks only when bb-box stopped it** and it has
  not run since: bb-box reads the reset from inside the box just before its
  own stop, and keeps the reading with each VM file's modification time
  and size, which it reads again at a take. A run of the VM, even outside
  bb-box, changes them.
- **A Windows box's snapshot is a clone of three files** of its QEMU VM in
  `~/.bb-box/qemu/vms/<vm>`: `disk.qcow2`, its overlay on a build of the
  Windows image, `vars.fd` and `config`. Never QEMU's saved memory in
  `state`, its pid file, its output or its QMP socket. bb-box clones them
  only once Windows has shut down: it asks Windows over SSH, and presses
  QEMU's ACPI power button when that cannot be sent. A box whose memory an
  ordinary Stop saved starts from it, then shuts down. A restore keeps the
  VM's two ports, leaves no `state`, and boots Windows afresh. Its label
  names the image and build its overlay stands on; a restore whose build an
  image refresh has removed is refused and says so. `~/.tart/vms` must be
  on the same volume as `~/.bb-box`, as the clones need, and bb-box makes
  it when Tart has not. Windows snapshots do not fork, and Keep is refused:
  Windows has no identity reset.
- **Kept snapshots stay on the Mac** when bb-box, or this backend, is
  removed: delete them in bb-box first, or remove the folder as Remove
  says.

## Update

- **macOS and Linux images rebuild each night** once the nightly run is set
  up ([setup](../README.md#rebuild-images-each-night)), on each Mac in turn.
  A rebuild pulls the base again when the registry has moved its tag and the
  Mac has room.
- **Windows images are refreshed in a box** of their current build, monthly,
  in the same nightly run
  ([054](../../docs/decisions/054-windows-images-are-refreshed-in-a-box-of-the-current-build.md)).
  [`../windows/refresh.ps1`](../windows/refresh.ps1) installs Windows'
  updates and the pinned tools, a trial box runs `check.ps1`, and the new
  build becomes current only if every check passes. The build before stays
  as a rollback until the next refresh succeeds, whatever boxes use it: the
  link `rollback` beside `current` in `~/.bb-box/qemu/images/<image>` names
  it. To go back to it, on the Mac:

  ```sh
  cd ~/.bb-box/qemu/images/bb-box-windows && ln -sfn "$(readlink rollback)" current
  ```

  New boxes and warm VMs are then made from it, and boxes on the newer build
  keep it until they go. Pause the nightly run until the cause is fixed, or
  it refreshes the image again. A new image from `prepare-windows-image.sh`
  needs the Windows ISO and about 30 minutes, so the rollback is the way
  back.
- **Rebuild an image by hand** with its prepare script and `--replace`. Boxes
  cloned from the old one keep running.
- **Before a new Tart release**, run the conformance suite against a Mac from
  a checkout of bb-box:
  `npm run conformance -- --backend tart --settings <file>`.
- **After an update of macOS, Tart or QEMU** on the Mac, bb-box retires its
  warm VMs and makes new ones. A suspended box whose saved state no longer
  restores boots afresh from its disk.

## Remove

1. In BB, release the backend's boxes, and remove the Macs and the backend on
   BB Box's settings page.
2. On each Mac, as the host user, stop and delete bb-box's VMs and images:

   ```sh
   tart list                     # bb-box's VMs and images: bb-box-...
   tart stop <name>              # for each one running
   tart delete <name>            # for each of them
   ```

   `tart delete` refuses a running VM, but deletes a suspended one as it is.
   An image the Tart settings name otherwise needs its own `tart delete`.
   Then delete bb-box's snapshots, beside the VMs:
   `rm -rf "$(dirname "$(cd ~/.tart/vms && pwd -P)")/bb-box-snapshots"`.
3. Windows boxes are QEMU processes, not Tart VMs, and their disks are in
   `~/.bb-box`. Stop each one, then delete bb-box's files, the Windows image
   and its downloads with them:

   ```sh
   ls ~/.bb-box/qemu/vms                          # one folder for each box
   kill "$(cat ~/.bb-box/qemu/vms/<vm>/pid)"      # for each of them
   rm -rf ~/.bb-box
   ```

4. Delete the base images Tart pulled, about 81 GB for macOS with Xcode.
   When nothing else on the Mac uses Tart, `tart prune --entries caches`
   deletes them all. Otherwise run `tart delete` for each
   `ghcr.io/cirruslabs/...` that `tart list` shows, with its `@sha256:` entry.
5. Remove bb-box's key from `~/.ssh/authorized_keys`.
6. As an administrator, if the Mac served only bb-box: turn sleep back on
   with `sudo pmset -a sleep <minutes>`, turn Remote Login off with
   `sudo systemsetup -setremotelogin off`, delete the host user, and
   uninstall Tart and QEMU.

bb-box installs no launch agents or daemons on the Mac; it installs one in
each macOS VM, which goes with the VM. Its VNC holders end
with their VMs: `pgrep -fl 'bb-box.*holder.py'` shows none once the VMs have
stopped.

## When it goes wrong

- **`tart` not found**: SSH sessions on a Mac get a short PATH. bb-box looks
  in `/opt/homebrew/bin`, `/usr/local/bin`, `~/.nix-profile/bin` and
  `/run/current-system/sw/bin`.
- **The Mac is full**: two macOS VMs run already, perhaps not bb-box's.
  `tart list` shows Tart's. Release or stop a box, or stop another VM.
- **A box does not answer SSH**: check that the image's user accepts bb-box's
  key. From the Mac, run `tart run bb-box-macos &`, then
  `ssh admin@$(tart ip bb-box-macos)` with the key.
- **A box's VM stopped by itself**: `box_status` says why, from how
  `tart run` exited and macOS's crash report. bb-box starts it again unless it
  crashed in the last 10 minutes. The run's output and exit are in
  `~/.bb-box/tart/run/` on the Mac.
- **A macOS desktop does not show**: without `/usr/bin/python3`, it says how
  to get it. If the holder that shares the desktop ended early, stop and
  start the box.
