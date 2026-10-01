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
SSH with the Mac as the jump host, and the desktop through Tart's VNC server,
which listens on the Mac's loopback.

Measured on a Mac with an M4 Max, macOS 27 host and guest: TIMINGS.

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
  VM and the like) is not in Tart's list; if one takes a slot, `tart run`
  fails and bb-box reports the same message.
- **Tart's licence.** Tart is under the Functional Source License 1.1 with
  the Apache 2.0 future licence (FSL-1.1-ALv2), where internal use is a
  permitted purpose. bb-box runs the `tart` you install; it does not bundle
  Tart or publish images with Tart's guest agent. Offering macOS VMs to
  others as a commercial service, through bb-box or not, may be a Competing
  Use of Tart, and Apple's licence forbids it anyway.
- **A box is not a sandbox.** Its user is an administrator of the VM, and the
  VM's user can reach the Mac's network through its NAT.

## Requirements

- A Mac with Apple silicon on macOS 14 or later (suspend needs 14). macOS 15
  or later in the VM needs a host on at least the same version.
- Disk: an image takes about IMAGE_GB; each box adds what it writes, about
  CLONE_GB after its first boot. Keep the reserve in bb-box's settings free.
- Memory: each box takes the memory in bb-box's settings (8 GiB by default),
  and bb-box keeps a reserve free for the Mac itself.
- The Mac must stay awake: a sleeping Mac pauses its VMs. On a Mac that only
  serves boxes, turn sleep off (`sudo pmset -a sleep 0`); on a Mac you also
  use, keep it on power and awake while boxes run.

## 1. The host user

bb-box logs in to each Mac as a user of its own and runs Tart as that user,
so its VMs, images and SSH key are apart from yours. As an administrator on
the Mac:

```sh
# A standard user for bb-box, with no GUI login. Pick your own password.
sudo sysadminctl -addUser bbbox-admin -fullName "bb-box" -password -
# Remote Login for that user. Add it to the users allowed in
# System Settings > General > Sharing > Remote Login, or:
sudo dseditgroup -o edit -a bbbox-admin -t user com.apple.access_ssh
sudo systemsetup -setremotelogin on
```

Then, as `bbbox-admin`, install Tart from its official source:

```sh
brew install openai/tools/tart     # or: nix profile install nixpkgs#tart
tart --version
```

Tart's VMs run under launchd jobs that bb-box writes to
`~/.bb-box/tart/run/`, in the user's GUI session when it has one and its
background session otherwise. Nothing is added to the user's login items.

On a Mac you use yourself, you can instead give bb-box your own user. bb-box
then runs Tart as you, its VMs are in your `~/.tart`, and the BB server holds
a key that logs in as you. If that Mac is already a BB machine, BB can run
commands as you there anyway, so this adds no reach BB lacks.

## 2. bb-box's key

In BB, turn on the Tart backend in bb-box's settings, list the Mac (section
4) and save. `bb box doctor` then shows bb-box's public key in its notes. Add
it to the host user's `~/.ssh/authorized_keys`, marked so it is easy to find:

```sh
printf '%s\n' 'ssh-ed25519 AAAA... bb-box' >> ~/.ssh/authorized_keys
```

The same key goes into the image (section 3), for the VM's user.

## 3. The image

Run `prepare-image.sh` on the Mac as the host user. It clones a Cirrus Labs
base image, boots it, customises it from inside, shuts it down, grants Cua
Driver its permissions offline and checks them, and leaves a stopped Tart VM
named `bb-box-macos`:

```sh
./prepare-image.sh --key 'ssh-ed25519 AAAA... bb-box' \
  --from ghcr.io/cirruslabs/macos-golden-gate-base:latest \
  --bb-url https://bb.example.com
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--key` | (required) | bb-box's public key, from `bb box doctor` |
| `--from` | `ghcr.io/cirruslabs/macos-tahoe-base:latest` | The image to start from: an OCI image or a local Tart VM. Use one no newer than the Mac's macOS |
| `--name` | `bb-box-macos` | The image to make |
| `--bb-url` | none | BB's server URL, to pre-install BB's host app, so a box enrols without downloading it |
| `--replace` | off | Replace an image of that name. Boxes cloned from the old one keep running |

What the image has:

- Cirrus Labs' base: user `admin` with automatic login and passwordless
  sudo, Homebrew, Git, Node 24, Xcode's command line tools and Tart's guest
  agent.
- bb-box's key for `admin`, and SSH that takes keys only. `admin`'s password
  is still `admin`, for the console only: the desktop reaches you through
  bb-box, which asks for no password.
- Homebrew and Node on the PATH of SSH commands (`~/.zshenv`).
- No sleep, no screen saver, no automatic updates, no Spotlight indexing.
- A launch daemon that clears BB's daemon lock and PID file at boot
  ([017](../../docs/decisions/017-boxes-clear-bb-daemon-state-at-boot.md)).
- Cua Driver CUA_VERSION, pinned by SHA-256, in `/Applications`, its daemon a
  LaunchAgent in `admin`'s session, with telemetry and update checks off,
  and Accessibility and Screen Recording granted.

### Permissions for computer use

macOS keeps Accessibility and Screen Recording grants in the system TCC
database, which System Integrity Protection guards on a running Mac. The
image script writes them while the VM is stopped instead: `grant-tcc.sh`
attaches the VM's disk on the host with owners ignored, adds a row per
service for Cua Driver's bundle ID with its code requirement, and detaches
it. The rows follow Cua's signing identity, so a Cua update signed by the
same team keeps them. Then the script boots the VM and checks
`cua-driver permissions status --json`. TCC_FINDINGS

## 4. Settings

In BB, under bb-box's settings:

| Setting | Example | Meaning |
| --- | --- | --- |
| Tart: enabled | on | |
| Tart: Macs | `mac1 bbbox-admin@192.0.2.20` | One line per Mac: a short name, and the host user at its address |
| Tart: Mac host keys | `192.0.2.20 ssh-ed25519 AAAA...` | `ssh-keyscan -t ed25519 192.0.2.20` prints it. bb-box checks it on every connection |
| Tart: SSH private key | empty | Empty makes bb-box generate one; its public key is in `bb box doctor` |
| Tart: VM user | `admin` | The image's user |
| Tart: macos image, macos-desktop image | `bb-box-macos` | The Tart VM each kind is cloned from, on every Mac. Empty turns the kind off |
| Tart: cores per box, memory per box | 4, 8192 | |
| Tart: VMs per Mac | 2 | At most 2 |
| Tart: memory kept free, disk kept free | 16384 MiB, 50 GiB | A new box is refused when the Mac would have less |

Then `bb box doctor` checks each Mac: that SSH as the host user works with
its pinned key, that it is Apple silicon with Tart, that each kind's image is
there, and how many VMs, how much memory and how much disk it has free.

## How the plugin drives a box

- **Acquire.** The box's VM is named `bb-box-<box ID>`. bb-box writes its
  owner file, `~/.bb-box/tart/owners/<VM>`, first, naming this install, the
  box, its thread, name and kind; then `tart clone` and `tart set` for its
  cores and memory; then a launchd job runs `tart run --no-graphics
  --vnc-experimental --suspendable`; then it waits for the VM's address in
  the Mac's DHCP leases and for SSH through the Mac.
- **Desktop.** `--vnc-experimental` serves the VM's screen from the
  Virtualization framework on the Mac's loopback, with a new port and
  password on each run, written to the job's output file, which only the host
  user can read. A viewer's connection goes `ssh -W 127.0.0.1:<port>` to the
  Mac, and the relay answers the VNC password. The desktop cannot be resized
  from the viewer.
- **Stop and start.** Stop suspends the VM, which frees its memory and its
  slot of the two; start resumes it. RESUME_FINDINGS
- **Release.** The job goes, `tart stop` and `tart delete`, then the owner
  file last, so a release cut short leaves a VM its install still finds.
- **Ownership.** The owner files are the record at the provider: bb-box finds
  its VMs from them if it loses its storage, and leaves alone the VMs of
  another install, which still count against the Mac's room.
- **Commands** run over SSH as the VM's user, outside the logged-in desktop
  session, so they do not have Cua Driver's permissions. Computer use goes
  through Cua's daemon in the session.

## Troubleshooting

- **`tart` not found.** SSH sessions on a Mac get a short PATH. bb-box looks
  in `/opt/homebrew/bin`, `/usr/local/bin`, `~/.nix-profile/bin` and
  `/run/current-system/sw/bin`.
- **The number of VMs exceeds the system limit.** Two macOS VMs already run
  on the Mac, perhaps not bb-box's: `tart list` shows Tart's. Stop one.
- **A box does not answer SSH.** Check that the image's user accepts
  bb-box's key: `tart run bb-box-macos`, then `ssh admin@$(tart ip
  bb-box-macos)` from the Mac with the key.
