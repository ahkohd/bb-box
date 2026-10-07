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
| `windows/` | What that script adds to the Proxmox Windows template's files |
| `guest/customize.sh` | Runs inside the image's VM while it is built |
| `grant-tcc.sh` | Grants Cua Driver its permissions in a stopped VM's disk |

## What you need

- A Mac with Apple silicon on macOS 14 or later. A VM's macOS must be no
  newer than the Mac's.
- Tart 2.30.0, the version tested. bb-box reads `tart list` and the output of
  `tart run`, so check a newer release with the conformance suite before
  relying on it (see Update).
- Disk: the macOS base image with Xcode takes about 80 GiB, and the prepared
  image a few GiB more. A box adds what it writes: about 2.5 GiB after its
  first boot, and its memory while it is suspended.
- Memory: each box takes the memory of its size, 8, 16 or 32 GiB for the
  small, medium and large presets. bb-box keeps a reserve free for the Mac
  itself.
- For Windows boxes: QEMU on the host user's `PATH` in SSH sessions
  (`qemu-system-aarch64`, `qemu-img` and QEMU's UEFI firmware), from Homebrew
  or Nix. Each Windows box takes its memory and 2 GiB more.
- For a macOS desktop: `/usr/bin/python3` from Xcode's command line tools
  (`xcode-select --install`), which Homebrew needs anyway. It runs the holder
  that shares the desktop with viewers.
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
- BB's app, with `--bb-url`.

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

#### Windows (arm64)

Download Windows 11 Arm64 in English (United States) from Microsoft
(<https://www.microsoft.com/software-download/windows11arm64>), then:

```sh
./prepare-windows-image.sh --iso ~/Downloads/Win11_arm64.iso --iso-sha256 <its SHA-256> \
  --key 'ssh-ed25519 AAAA... bb-box' --delete-iso
```

It installs Windows unattended with the Proxmox Windows template's files,
adapted for arm64, so a Windows box on a Mac has what one on Proxmox has. It
then checks a clone of the image over SSH, saved and restored as bb-box stops
and starts a box. It takes about 30 minutes, and needs about 40 GiB beyond
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
| `windows-image` | empty | The image in `~/.bb-box/qemu/images` of `windows-arm64-desktop` boxes: the name `prepare-windows-image.sh` was given with `--name`, or its default. Empty, the default, turns them off |
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
  was built with other pins than this bb-box's copy of its script.

Its fix gives the prepare script's command that builds the image again.

## Update

- **macOS and Linux images rebuild each night** once the nightly run is set
  up ([setup](../README.md#rebuild-images-each-night)), on each Mac in turn.
  A rebuild pulls the base again when the registry has moved its tag and the
  Mac has room. Windows images are not rebuilt yet.
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
2. On each Mac, as the host user, delete bb-box's VMs and files:

   ```sh
   tart list                     # bb-box's VMs are named bb-box-...
   tart delete <name>            # for each of them
   rm -rf ~/.bb-box
   ```

3. Remove bb-box's key from `~/.ssh/authorized_keys`.
4. As an administrator, delete the host user, and uninstall Tart and QEMU if
   nothing else uses them.

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
