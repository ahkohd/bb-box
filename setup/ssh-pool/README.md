# SSH host pool backend

This backend lends Linux machines and Macs you already have, reached over
SSH. A box has a whole machine to itself. When the box is released, bb-box
resets the machine and lends it again.

It suits spare desktops, build servers and virtual machines you run
yourself. It is not a security boundary: a box runs as an ordinary user on
your machine, and can read what any user there can read.

| Path | What it does |
| --- | --- |
| `setup.sh` | Sets up a machine: run it once on each machine, as root |
| `machine.sh` | bb-box's helper, which `setup.sh` installs on the machine |
| `setup-mac.sh`, `machine-mac.sh`, `mac-home/` | A Mac's setup, helper and box users' home template. See [Macs](#a-mac) |
| `test/` | A pool of Docker containers for testing the backend on one computer |

## How it works

- `setup.sh` makes an admin user on the machine, `bbbox-admin`. It accepts
  only bb-box's SSH key, with no terminal or forwarding, and may run only
  bb-box's helper as root.
- To lend the machine, bb-box asks the helper to claim it. The helper makes
  a new user for the box, `bbx-<generation>`, which accepts bb-box's key.
  bb-box reaches the box as that user.
- To reset the machine, the helper removes the box's user and everything it
  left, then adds 1 to the machine's reset generation.

The machine keeps the truth about itself in `/var/lib/bb-box`: its reset
generation, and a marker naming the box that holds it. If bb-box restarts
or loses its storage, it reads the markers and carries on. Two bb-box
installs can share machines: each leaves alone the boxes of the other.

## What you need

### A Linux machine

- Linux on x86_64.
- root, to run `setup.sh`.
- `sshd`, accepting key logins.
- `sudo`, `flock` and `setsid` (util-linux), `useradd` (passwd), `pgrep`
  (procps), `find`, `tar`, and `curl` or `wget`.
- `git` and `gh`. A box uses them for the thread's GitHub access: `git`
  takes the thread's token through `gh`.
- Node.js 22.19 or newer, with npm, on the default `PATH`. BB's installer
  needs it to enrol a box. Debian's and Ubuntu's own `nodejs` is too old,
  so install Node.js 24 from NodeSource or nodejs.org.
- BB's server, where bb-box runs, must reach the machine's sshd, directly or
  through a jump host.
- At least the default size of the kinds it serves, or no box made at that
  size fits it: 2 cores and 4 GiB of memory for `linux`. For smaller
  machines, make the presets smaller in the kinds part of BB Box's settings.

On Debian or Ubuntu, this installs the tools, then Node.js 24 from
NodeSource:

```sh
sudo apt-get install sudo util-linux procps findutils passwd tar curl openssh-server git gh
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install nodejs
```

`setup.sh` warns if one of these is missing. bb-box's check fails without
Node.js 22.19 or newer and npm, and warns without `git` or `gh`.

A machine that is itself an unprivileged container, such as a Proxmox LXC
container, works. Box users there take user IDs 60706 to 61183, as the
container has only 65536 IDs. That range is between the ranges systemd
keeps for its own users. Elsewhere box users take 70000 to 79999.

### A Mac

- Apple silicon.
- FileVault off, so the Mac signs its box user in by itself after a
  restart.
- Remote Login on, in System Settings, General, Sharing.
- Nobody signed in at the console, as the box user takes it.
- At least the default size of the kinds it serves: 4 cores and 8 GiB of
  memory for `macos` and `macos-desktop`. Change the sizes in the kinds
  part of BB Box's settings if your Macs are smaller.
- A Mac set aside for boxes, not one people use. A box can read whatever
  any user on the Mac can read, and the reset removes users.
- Your own home on it closed to box users: macOS makes a home readable to
  the `staff` group, which box users are in, and yours may hold BB's or an
  agent CLI's credentials. Run `sudo chmod 700 /Users/<you>`. The doctor
  warns while a person's home is open.
- An HDMI dummy plug, if the Mac runs without a display. With nothing
  attached, one reset ended in a kernel panic in the display coprocessor,
  and the Mac restarted; the pool waits for a Mac that restarts in its
  reset. With a 1080p plug fitted, 15 resets in a row had none. The plug
  also gives the desktop its 2x mode, so the viewer is sharp.
- A Mac that is not also a Tart host, as a box takes the whole Mac. On
  macOS 27 and later, every reset restarts the Mac's user space, which
  stops every Tart VM on it and ends every SSH session. The doctor warns
  when one address is in both.

Xcode is optional. Install it in `/Applications` before you run
`setup-mac.sh`, and boxes on the Mac get Xcode and the iOS Simulator. The
pool's `macos` and `macos-desktop` offers have the features `xcode` while
every Mac that serves them has Xcode, and `ios-simulator` while each also
has an iOS runtime. Listing the runtimes takes a few seconds, so only
`setup-mac.sh` and the doctor list them. The helper keeps what they found
in `/var/db/bb-box/xcode`, and the pool reads it each time it looks at the
Macs. Only the Macs that answered count, so one that is switched off does
not hide the features.

`setup-mac.sh` turns off automatic App Store updates, so Xcode changes only
when you update it (see Update).

## Steps

### 1. Get bb-box's key

1. In BB, open BB Box's settings and set up **SSH host pool**. Leave it off
   until a machine is ready.
2. Leave **SSH private key** empty. bb-box makes a key.
3. Press "Check". A note shows the public key, starting `ssh-ed25519`. The
   check fails until the pool has a machine; that is expected here.

To use a key you already have, paste its private key into the field
instead. It must have no passphrase.

From a terminal, `bb box config check <file> --test` runs the same check on
a configuration file, as `bb box config show --json` prints it.

### 2. Set up each Linux machine

Copy this directory to the machine, then run `setup.sh` as root with the
public key:

```sh
scp -r setup/ssh-pool build-1:
ssh build-1
sudo sh ssh-pool/setup.sh --key "ssh-ed25519 AAAA... bb-box"
```

These options are optional:

| Option | What it does |
| --- | --- |
| `--name <name>` | The machine's name in bb-box. By default, its host name |
| `--address <host>` | How BB's server reaches it. By default, its first IP address |
| `--port <port>` | sshd's port, if BB's server reaches it on another |
| `--admin <user>` | The admin user's name. By default, `bbbox-admin` |
| `--reset-hook <path>` | Your whole-machine reset, for Docker. See [Docker](#docker-on-the-pools-machines) |

`setup.sh`:

- makes the admin user, if it does not exist
- installs the helper as `/usr/local/libexec/bb-box/machine`
- adds `/etc/sudoers.d/bb-box`, which lets the admin user run the helper
  as root, and nothing else
- adds `/etc/tmpfiles.d/bb-box.conf`, which clears BB's lock and PID files
  in box users' homes at boot
- starts the machine's reset generation at 0
- checks sshd's settings

It prints a line for the machines setting, and the machine's host keys. For
example:

```text
Add this line to the SSH host pool's machines setting. ...

  build-1 bbbox-admin@192.0.2.21 linux

Add these lines to the SSH host pool's host keys setting:

  192.0.2.21 ssh-ed25519 AAAA...
```

Read any warnings at the end, and fix them before you go on.

`setup.sh` never changes a user it did not make: if `bbbox-admin` already
exists for something else, choose another name with `--admin`.

#### If 2 bb-box installs lend the same machine

Give `--key` once for each install's key:

```sh
sudo sh ssh-pool/setup.sh --key "ssh-ed25519 AAAA... bb-box" --key "ssh-ed25519 BBBB... bb-box"
```

`setup.sh` replaces the admin user's keys each time it runs, so give every
install's key whenever you run it again.

#### If sshd lets only some users in

If sshd has `AllowUsers` or `AllowGroups`, add the admin user and box users,
and on a Mac that lends iOS slots the slot users, `bbd-*`, for example:

```text
AllowUsers bbbox-admin bbx-* bbd-* alice
```

Without `bbd-*`, every ios box on the Mac fails as its slot is lent: "SSH
as bbd-1 did not answer". `mac-ios.sh` warns of it. On a Mac, sshd reads
its settings at each new connection, so no restart is needed.

Then reload sshd. `setup.sh` warns when it finds either setting.

On a Mac, sshd must also let box users forward to a local port: a desktop's
route is `ssh -W` as the box user. A hardened `sshd_config` with
`AllowTcpForwarding no` breaks every desktop, with no error at setup. Use
`AllowTcpForwarding local`, or leave it out.

### 3. Set up each Mac

A Mac lends its box a new standard user, `bbx-<generation>`, signed in at
the Mac's console. A `macos` box reaches it over SSH. A `macos-desktop` box
gets the console's desktop too, through Screen Sharing, and computer use
through Cua Driver. Decision
[047](../../docs/decisions/047-a-physical-mac-is-an-ssh-pool-machine-lent-with-a-new-user-at-its-console.md)
explains why.

Copy the setup folder to the Mac, then run `setup-mac.sh` with sudo, from an
administrator's account:

```sh
scp -r setup mac-mini:bb-box-setup
ssh mac-mini
sudo sh bb-box-setup/ssh-pool/setup-mac.sh --key "ssh-ed25519 AAAA... bb-box"
```

`setup/ssh-pool` alone is enough for whole boxes. iOS slots need
`setup/tart/ios` beside it ([iOS slots on a Mac](#ios-slots-on-a-mac)).

It takes the same options as `setup.sh`, except `--reset-hook`.
`setup-mac.sh`:

- makes the admin user, `bbbox-admin`, hidden, which accepts only bb-box's
  keys and may run only the helper as root
- installs the helper as `/usr/local/libexec/bb-box/machine`, and the box
  users' home template in `/usr/local/share/bb-box/home`
- installs Homebrew if it is missing, as the administrator who ran sudo,
  then Git, GitHub CLI and Node.js with it
- installs Cua Driver in `/Applications`
- installs BlackHole 2ch, pinned, as the Mac's audio input
- installs the agent CLIs BB runs threads with, Claude Code, Codex and Pi,
  in `/usr/local/lib/bb-box`, linked from `/usr/local/bin`, pinned as the
  Linux images pin them
- adds a launch daemon that clears BB's lock and PID files in box homes at
  boot
- keeps the Mac awake, starts it after a power failure, and turns off
  automatic macOS and App Store updates, and Spotlight indexing
- prepares Xcode, if it is in `/Applications`: accepts its licence, runs
  its first launch and downloads the iOS platform, then notes its version
  and Simulator runtimes for the pool
- with Xcode, its iOS platform and `setup/tart/ios` beside it, sets up iOS
  slots with `mac-ios.sh`, as [below](#ios-slots-on-a-mac)
- starts the Mac's reset generation at 0, in `/var/db/bb-box`, and makes
  the first box user, `bbx-0`, the automatic login

It prints the line for the machines setting, the host keys, and steps for a
person at the Mac or on Screen Sharing:

```text
  mac-mini bbbox-admin@192.0.2.30 macos,macos-desktop
```

1. Turn on Screen Sharing, allow all users, and leave the VNC password
   off.
2. Select the (i) beside Remote Login, and turn on Allow full disk access
   for remote users. Without it, the reset cannot remove the folders macOS
   protects in a box user's home, such as `~/Library/Mail`.
3. Turn on CuaDriver under Accessibility and under Screen Recording, in
   Privacy and Security.
4. Under Accessibility, also add and turn on `/usr/bin/osascript` and
   `/usr/libexec/sshd-keygen-wrapper`. Screen Sharing ignores a viewer that
   is not Apple's, so a person's keys and pointer in the desktop's viewer go
   to a helper that `osascript` runs in the box user's session over SSH
   (#406).

These grants are per Mac, once. Box users are not asked to approve Cua's
screen capture: macOS 27 asks each new user, so the helper writes the
approval for each box user it makes.

If someone was signed in when you ran it, restart the Mac, so that it signs
in `bbx-0`. Then add the line and host keys to bb-box, as for a Linux
machine. Leave out `macos-desktop` if boxes should not get the Mac's
desktop.

#### iOS slots on a Mac

A Mac whose line lists `ios` lends iOS slots
([064](../../docs/decisions/064-ios-shared-hosts.md)): each shared `ios` box,
shared by default or with `shared: true`, gets a macOS user of its own on the Mac, with its own
booted device, files and keychain, ready in seconds. Slots use the Mac's
cores and video encoder, not a VM's. A slot has no sudo, no Homebrew
installs, no console and no app windows, and shares the Mac's loopback with
the other slots: each has 100 ports from `BB_PORT_BASE`, and the Mac holds
the common dev ports while it lends slots.

The Mac lends slots before whole boxes. While any slot is held, promised
or being made for a box, it is not lent whole, and a `macos` or
`macos-desktop` box goes to another offer or waits, with words: "The pool's
Mac mac-mini is lending iOS slots (3 held). It is lent whole again when
they are released." While it is lent whole, it lends no slot. Leave `ios`
off its line to keep it for whole boxes.

`setup-mac.sh` sets slots up when Xcode, with its iOS platform, is in
`/Applications` and `setup/tart/ios` is beside `setup/ssh-pool`. It runs
`mac-ios.sh`, which:

- installs idb_companion from its pin in `setup/tart/ios/pins`, checked by
  SHA-256, in `/usr/local/lib/idb_companion-<version>`, linked from
  `/usr/local/bin`
- installs the slots' helper, `device-host`, its held ports' program, the
  slots' home template (the pool's `.zshenv`) and the device list in
  `/usr/local/share/bb-box`
- builds `bb-box-h264` in `/usr/local/bin`, from `setup/android` beside
  `setup/ssh-pool`, which encodes a device's video in software should the
  Mac's hardware encoder fail
  ([065](../../docs/decisions/065-macs-say-what-they-offer-and-ios-streams-in-software-where-they-must.md)):
  with Cisco's OpenH264, or with x264 built from its pinned source when run
  with `H264_WITH_X264=yes`. bb-box ships no x264 binary
- for the newest iOS runtime, installs bb-box's slimming list and makes its
  seed: a device made, booted and slimmed twice as `bbbox-admin`, whose
  store of disabled services must have every label of the list off. It
  takes a few minutes the first time, and is kept after
- sets the helper up as a kept host, never deleted, closed until bb-box
  opens it
- checks that a user with no desktop session, as a slot's user is, can set
  and read a device's clipboard as the device server does: on a device made
  as `bbbox-admin` for the check and deleted after, through a launchd job in
  the user's own session (F-17). If it cannot, it warns, as pasting into an
  ios box and copying from it would fail

It needs a slimming list for the Mac's iOS runtime, as the iOS image does
([Slimming](../tart/ios/README.md#slimming)). It prints the line with `ios`:

```text
  mac-mini bbbox-admin@192.0.2.30 macos,macos-desktop,ios
```

To add slots to a Mac already in the pool, without running `setup-mac.sh`
again, which replaces the admin user's keys, run this on the Mac as an
administrator, from the copied setup folder. It touches no key, sudo rule
or box user, and may run while a box holds the Mac whole, though not while
the Mac is resetting (`machine status` says `marker=resetting`):

```sh
sudo mkdir -m 700 /var/root/bb-box-backup
sudo cp -p /usr/local/libexec/bb-box/machine /etc/sudoers.d/bb-box /var/root/bb-box-backup/
sudo install -m 0755 bb-box-setup/ssh-pool/machine-mac.sh /usr/local/libexec/bb-box/machine.new
sudo mv -f /usr/local/libexec/bb-box/machine.new /usr/local/libexec/bb-box/machine
sudo sh bb-box-setup/ssh-pool/mac-ios.sh "$PWD/bb-box-setup/ssh-pool" bbbox-admin
```

`bbbox-admin` is the admin user `/etc/sudoers.d/bb-box` names. Its rule
lets it run the helper with any arguments, so `machine slot` needs no new
rule. To undo it, with `ios` off the Mac's line, every ios box there
released and the doctor's `iOS slots` check showing none sweeping, put the
helper back and remove what `mac-ios.sh` added:

```sh
sudo launchctl bootout system/app.bb-box.device-host
sudo launchctl bootout system/app.bb-box.device-host.ports
sudo rm -f /Library/LaunchDaemons/app.bb-box.device-host.plist /Library/LaunchDaemons/app.bb-box.device-host.ports.plist
sudo rm -rf /var/db/bb-box/host /usr/local/libexec/bb-box/device-host /usr/local/libexec/bb-box/device-host-ports /usr/local/share/bb-box/ios /usr/local/share/bb-box/slot-home
sudo cp -p /var/root/bb-box-backup/machine /usr/local/libexec/bb-box/machine.new
sudo mv -f /usr/local/libexec/bb-box/machine.new /usr/local/libexec/bb-box/machine
```

idb_companion stays in `/usr/local/lib`, linked from `/usr/local/bin`.

bb-box opens the Mac's slots at its next upkeep while the Mac is not lent
whole, and keeps one ready. The helper is
[`device-host`](../tart/ios/README.md#shared-hosts-device-host), as on a
shared Tart host, run through `machine slot`. The doctor's `iOS slots`
check says whether it lends, and how many slots are held, ready, making
and sweeping.

### 4. Add the machines to bb-box

1. Add the line `setup.sh` printed to **Machines**, one line per machine.
2. Add the host keys to **Host keys**. bb-box connects only to machines
   whose keys are there.
3. Press "Check". Each machine should pass `SSH`, `helper`, `architecture`,
   `tools` and `state`. Then turn the pool on and save.

A line is:

```text
<name> [user@]host[:port] <kinds> [via=[user@]host[:port]] [reset=machine] [labels=<word>,<word>]
```

| Part | What it means |
| --- | --- |
| `<name>` | Lower-case letters, digits and `-`, unique in the pool |
| `[user@]host[:port]` | The admin user and how to reach sshd. Put an IPv6 address in brackets |
| `<kinds>` | `linux` on a Linux machine, and `macos`, `macos-desktop` and `ios` on a Mac. `ios` lends iOS slots, [above](#ios-slots-on-a-mac). `linux-docker`, linux with Docker, may be listed too, only with `reset=machine` |
| `via=` | A jump host, reached with the same key |
| `reset=machine` | The machine has a whole-machine reset, so its boxes get Docker. `setup.sh` adds it when you give `--reset-hook`. Not on a Mac |
| `labels=` | Words for your own use |

bb-box lends the smallest free machine that fits the box's size. The pool's
boxes have Docker only when every machine's line has `reset=machine`
([decision 041](../../docs/decisions/041-every-linux-box-has-docker.md)).
When only some lines have it, no box has Docker, each says No Docker, and
the doctor warns. Of machines of one size, bb-box then lends those without
`reset=machine` first, since a whole-machine reset may restart the machine.
After that it lends the one free longest, then the first listed.

#### Through a jump host

bb-box reaches the jump host with the same key, as the user in `via=`, and
asks it to forward to the machine. The admin user cannot forward, so use
another user on the jump host. In its `authorized_keys`, you can limit the
key to forwarding to your machines. `restrict` alone still lets the key run
commands there, so add `command="false"`:

```text
command="false",restrict,port-forwarding,permitopen="build-1:22",permitopen="build-2:22" ssh-ed25519 AAAA... bb-box
```

Add the jump host's keys to the host keys setting too. Name the machine by
the address the jump host reaches it on, and give its host keys under that
name. Boxes on a machine reached through a jump host have no Docker host
URL.

### Docker on the pool's machines

Boxes with Docker have passwordless sudo too, which means root on the
machine. So bb-box gives Docker only on a machine with a whole-machine reset
that puts the machine back as it was, and only when every machine in the
pool has one. Install Docker Engine on each machine, give `setup.sh` your
reset with `--reset-hook`, and use the line it prints, which has
`reset=machine`. If a machine with `reset=machine` lacks Docker, the doctor
fails for it, and bb-box does not lend it.

The whole-machine reset is a program you write. Give it to `setup.sh` with
`--reset-hook`, which installs it as `/usr/local/libexec/bb-box/reset-machine`.
It must:

- restore everything a root user could change, except `/var/lib/bb-box`,
  which it must keep: the reset generation lives there
- exit 0 when the machine is restored, or exit non-zero with the reason on
  standard error
- if it restarts the machine to finish, create the file named in
  `BB_BOX_RESTARTING` just before it does

The helper runs it as root, detached, without a terminal. It may take up to
15 minutes. When the machine comes back after a restart, the helper counts
the restore as done only if the hook had created that file or had exited
0. Otherwise the restart cut the hook short: the reset fails with "The
machine restarted before reset-machine finished", and the machine goes out
of service.

For example, a machine whose root filesystem is an overlay on tmpfs, with
`overlayroot` on Ubuntu, loses every change when it reboots. Its hook can
be:

```sh
#!/bin/sh
touch "$BB_BOX_RESTARTING"
systemctl reboot
sleep 600
echo "The machine did not restart." >&2
exit 1
```

Keep `/var/lib/bb-box` on a filesystem the overlay leaves alone, or the
machine forgets its reset generation, and the helper refuses to lend it.

A virtual machine your hypervisor restores from a snapshot works the same
way, if `/var/lib/bb-box` is on a disk the snapshot does not cover. Its
hook creates the `BB_BOX_RESTARTING` file before it asks for the restore.

`test/reset-machine-docker.sh` is not a whole-machine reset. It removes
Docker's containers, images and volumes and empties the temporary
directories, which is enough to test the backend.

Rootless Docker, which would need no whole-machine reset, is not supported
yet.

## Check it worked

On BB Box's settings page, press Check, or run `bb box doctor`. Each Linux
machine should pass `SSH`, `helper`, `architecture`, `tools` and `state`. The
doctor shows each machine's state, why one is out of service, its cores,
memory and free disk, and warns about a machine too small for a kind's
default size.

### What the doctor checks on a Mac

Besides SSH, the helper, the architecture, the tools, the state and the
box sizes, the doctor checks that:

- FileVault is off
- the box user is signed in at the console, and is the automatic login
- the helper has Full Disk Access
- Xcode, if the Mac has it, has an iOS runtime
- Screen Sharing is on, for `macos-desktop`
- Cua Driver has Accessibility and Screen Recording, for `macos-desktop`
- a viewer's input reaches the desktop, for `macos-desktop`: a one-point
  pointer move posted the helper's way, in the box user's session, moves
  the pointer

A Mac with FileVault on, without Full Disk Access, or without its box user
at the console is out of service, and the doctor says why. A Mac without
Screen Sharing lends `macos` only. Only the doctor asks Cua Driver for its
grants, as that takes a moment. Lending a box does not.

The doctor also warns when only some of the Macs that serve a kind have
Xcode, or an iOS runtime, as that kind's boxes then have neither, or no
iOS Simulator.

### What each machine reports for snapshots

A box lent a Mac whole takes snapshots of its home folder, where the Mac
reports that its homes clone. Linux machines, iOS slots and an operator's
snapshot hook take none yet. Each machine says what it could offer, so you
can see which will take them as the later parts are built
([decision 090](../../docs/decisions/090-pool-machines-say-whether-they-snapshot.md)).

The helper's `machine snapshot probe` finds out, as root:

- **Home snapshots**, of a box user's home folder only. It looks at the
  filesystem under the box homes, `/home` on Linux and `/Users` on a Mac,
  and tries it: on a Mac, an APFS clone with `cp -c`, and whether the helper
  has Full Disk Access; on btrfs, a trial subvolume and a snapshot of it,
  which it deletes; on ZFS, the dataset mounted at `/home`. It also notes
  the free space there.
- **Machine snapshots**, of the whole machine. It runs
  `/usr/local/libexec/bb-box/snapshot-machine describe`, if an operator
  installed such a hook, for at most 30 seconds. At 30 seconds it stops
  the hook and everything the hook started, and reports the hook as
  failed.

The probe's trials go in a folder only root can use:
`/home/.bb-box-snapshot-trials` on Linux, `/var/db/bb-box/snapshot-trials`
on a Mac. The probe removes its trial even when it fails or is stopped,
and the next probe removes the trial of one that was killed. If a trial
cannot be removed, the probe says what is left and where, `setup.sh` and
`setup-mac.sh` warn, and the doctor warns with what to remove as root.

`setup.sh` and `setup-mac.sh` run the probe and print what it found. The
doctor runs it again, and each status passes on the last report, which BB
Box keeps for each machine. The doctor shows it as `<machine>: snapshots`,
and counts the machines that could offer each in `Snapshots on the pool's
machines`. For example:

- "Home snapshots: APFS clones available under /Users, 120 GiB free."
- "Home snapshots: none: ext4 under /home, which neither clones nor
  snapshots."
- "Machine snapshots: hook found: machine scope, LVM thin (vg0/thin, 12%
  full)."

A machine with `reset=machine` gives its boxes root, so it never offers
home snapshots: a home snapshot would not hold what they change outside
the home. A Mac that lends iOS slots never offers machine snapshots. A
take on a pool box is refused with its machine's own reason. A machine
whose helper is older than this BB Box's warns: run `setup.sh`, or
`setup-mac.sh`, on it again.

### Home snapshots on a Mac lent whole

The helper keeps each snapshot as an APFS clone of the box user's home in
`/var/db/bb-box/home-snapshots/<box user>/<snapshot>`, which only root can
read, with the home's access control lists beside it. `setup-mac.sh`
builds `clone-tree`, which clones a home in one call to `clonefile`, with
the Command Line Tools' `clang`; without it the helper clones with
`ditto --clone`, which pauses the box longer. A Mac needs helper version 3,
from this BB Box's `setup-mac.sh`.

BB Box runs these helper commands, as root, through the same sudo rule:

| Command | What it does |
| --- | --- |
| `machine snapshot take <generation> <snapshot>` | Pauses the box user's running processes, clones the home, resumes what it paused, then keeps the home's ACLs |
| `machine snapshot list` | This install's snapshots on the Mac, and the free space under `/Users` |
| `machine snapshot stop <generation>` | Ends the box user's session for a restore, after clearing the automatic login |
| `machine snapshot restore <generation> <snapshot> <operation>` | Puts a clone of the snapshot in the home's place, with its ACLs, and clears the user's temporary and cache folders. Asked again with the same operation, it finishes a restore cut short, or changes nothing |
| `machine snapshot start <generation>` | Signs the box user in again where it was signed in, by restarting the login window, or userspace after 30 s; it exits 10 until the user is at the console |
| `machine snapshot delete <snapshot>` | Deletes a snapshot; again, it succeeds |
| `machine snapshot fork <snapshot> <user> <uid>` | Makes a new user from a snapshot, without BB's machine files, the access file, BB's launch agent, the login keychain or plists naming the source's home. Only where no other user shares the Mac, and only for a new box user, `bbx-<n>` with UID 70000 plus n modulo 10000, that is not on the Mac or at its console. BB Box does not call it yet |
| `machine snapshot proof` | On a free Mac: makes new scratch users, `bbbox-probe-` and 8 random hexadecimal digits, as box users are made, then takes, kills a take during its pause, restores with an undo, forks, aims forks at users already there, and deletes. It checks each, including that processes others stopped before a take stay stopped and that a process above the user's that stops late is resumed, removes only what it recorded making, and prints a report |

A take records the processes it pauses, with when each started, before it
stops them. It resumes only those, and a root `sudo` above one of them that
stopped with it. A process stopped before the take stays stopped, but a
recorded process that someone else stops during the pause, or in the minute
after it, is resumed with the rest. The record keeps a process above the box
user's that has not stopped yet for a minute, so a `sudo` that stops itself
later than the take's last check is resumed by the helper's next command in
that minute. It keeps a process it found stopped until a later check sees it
running or gone, even after that minute, and a second take keeps what the
first still names. A take killed while it paused the box user is resumed by
the helper's next command, whichever it is. A release deletes the box user's snapshots before it removes the
user, and the reset refuses to lend the Mac while a snapshot of an earlier
box is left. A restore signs a desktop's user out for a few seconds. When
the login window does not sign the user in again, the userspace restart
ends every SSH session on the Mac.

To prove home snapshots on a Mac before you rely on them, run the proof
while no box holds it:

```sh
sudo /usr/local/libexec/bb-box/machine snapshot proof
```

It takes about 2 to 3 minutes and leaves the box user waiting at the
console alone. It takes the helper's lock, then the iOS slots' lock, and
holds both until it ends, so no box and no iOS slot claim, promise or make
starts in the middle: a slot command sent meanwhile waits for the lock, up
to 30 s for a claim and 60 s for the others, then is refused and asked
again. It waits up to 60 s for a slot command that
holds the slots' lock first. It refuses with exit 3, changing nothing,
while a box holds the Mac, its reset runs, an iOS slot is anything but
ready (held, being given back, made or removed), a slot is promised to a
box, the slots' lock stays held, or a take's pause record is left.

Each run makes new scratch users, with random names and UIDs from 90000 to
99999 that no account has at that moment, outside the UIDs of box users
(70000 to 79999) and iOS slot users (80000 to 89999). It refuses with exit
5, changing nothing, when it cannot list the Mac's users. It makes no scan
of the Data volume. It records each thing it makes in
`/var/db/bb-box/proof-made` as it makes it: each user with its UID and
`GeneratedUID`, each folder and file with its device and inode, and each
process with when it started. At the end it deletes only what still
matches the record, and leaves anything else with a note on how to check
it, including files a scratch user made elsewhere on the Mac. A run cut
short leaves the record, and the next run first removes what that record
proves, in the same way. Where it cannot prove something is its own, it
refuses with exit 5 and keeps the record: check what the notes name,
remove what is an earlier proof's, then remove the record.


### Testing on one computer

`test/rig.sh` starts a pool of three Docker containers on this computer and
sets each up with `setup.sh`:

- `plain`, with sshd only and no systemd
- `systemd`, with systemd and Docker, privileged, with
  `test/reset-machine-docker.sh` as its whole-machine reset
- `bastion`, a jump host to `plain`

```sh
sh setup/ssh-pool/test/rig.sh up /tmp/bbbox-rig
npm run conformance -- --backend ssh-pool --settings /tmp/bbbox-rig/settings.json
SSH_POOL_RIG=/tmp/bbbox-rig node --test --test-concurrency=1 test/ssh-pool-live.ts
sh setup/ssh-pool/test/rig.sh down
```

The conformance suite checks the backend as it checks every backend. The
pool checks in `test/ssh-pool-live.ts` leave a box's processes, jobs, files
and IPC objects, then check the reset removed them. They also check a
failed reset, a restart during a whole-machine reset, with and without
the hook saying it would restart, a reset cut short, a reset refused while
a box holds the machine,
returning a machine to service, an old box released again after its machine
went to the next box, linger, and a jump host.

The suite skips enrolment in BB, which needs a BB server, and stopping and
starting, which a pool cannot do.

## Update

- Run `setup.sh` or `setup-mac.sh` again to update the helper or the key. It
  keeps the reset generation. With 2 bb-box installs, give every install's
  key each time.
- On a Mac, update Xcode by hand, from the App Store or Apple's developer
  site, then run `setup-mac.sh` again. It accepts the new licence, runs the
  first launch and notes the new runtimes. Until then, the kinds the Mac
  serves offer Xcode but not the iOS Simulator.

## Remove

### A Linux machine

1. Release any box on it.
2. Remove its line from the machines setting, and its host keys.
3. On the machine, remove what `setup.sh` added:

   ```sh
   sudo userdel -r bbbox-admin
   sudo rm -rf /usr/local/libexec/bb-box /etc/sudoers.d/bb-box /etc/tmpfiles.d/bb-box.conf /var/lib/bb-box
   ```

### A Mac

1. Release any box on it.
2. Remove its line from the machines setting, and its host keys.
3. On the Mac, turn the automatic login off in System Settings, Users and
   Groups, then restart the Mac.
4. Delete the box user, which is hidden. The first command lists it:

   ```sh
   dscl . -list /Users | grep '^bbx-'
   sudo sysadminctl -deleteUser bbx-3
   ```

   Here `bbx-3` stands for the name the first command prints.
5. With iOS slots, release every ios box on it first, wait for the
   doctor's `iOS slots` check to say none is sweeping, then stop the slots'
   daemons:

   ```sh
   sudo launchctl bootout system/app.bb-box.device-host
   sudo launchctl bootout system/app.bb-box.device-host.ports
   sudo rm -f /Library/LaunchDaemons/app.bb-box.device-host.plist /Library/LaunchDaemons/app.bb-box.device-host.ports.plist
   ```

6. Remove what `setup-mac.sh` added:

   ```sh
   sudo sysadminctl -deleteUser bbbox-admin
   sudo launchctl bootout system/dev.bb-box.clear-bb-state
   sudo rm -rf /usr/local/libexec/bb-box /usr/local/share/bb-box /etc/sudoers.d/bb-box /Library/LaunchDaemons/dev.bb-box.clear-bb-state.plist /var/db/bb-box
   ```

Homebrew, Cua Driver and the settings setup changed stay. Turn Spotlight
indexing back on with `sudo mdutil -a -i on`, and automatic updates in
System Settings, General, Software Update.

## When it goes wrong

bb-box's panel lists each machine as free, held, resetting or out of
service. The doctor shows each machine's state, and why one is out of
service.

### A machine out of service

A machine goes out of service when:

- its reset failed
- an earlier box left something, such as a `bbx-` user
- its reset generation went back, for example after it was restored from
  an old backup

The doctor shows the reason. Fix the cause, then reset the machine on it:

```sh
sudo /usr/local/libexec/bb-box/machine reset
```

Add `machine` to run the whole-machine reset too. The helper waits for it
to finish. If it reboots the machine, run the command again once the
machine is back, to finish the reset:

```sh
sudo /usr/local/libexec/bb-box/machine reset machine
```

If the whole-machine reset fails, its log is in
`/var/lib/bb-box/restore.failed/log`.

bb-box lends the machine again once it is clean. The helper refuses to
reset a machine that a box holds. Release the box first.

If your reset was cut short, for example because your SSH session ended,
the machine stays resetting, and the doctor says so. Run the reset again.

### A machine that does not answer

A box on a machine that does not answer keeps its machine. bb-box resets
the machine when it answers again. Its power shows as unknown meanwhile.

### A Mac out of service

Fix the cause the doctor shows, then reset the Mac on it:

```sh
sudo /usr/local/libexec/bb-box/machine reset
```

The command waits while the next box user signs in. If the helper restarts
macOS's user space or the Mac, which ends your SSH session, run it again
once SSH answers. A Mac takes no `machine` argument.

## How the pool behaves

What a person who lends machines should know about how the pool uses them.

### What a reset does

When a box is released, the helper:

1. renames the box's marker from `owner` to `resetting`, so a reset cut
   short is finished later
2. with `reset=machine`, runs your whole-machine reset and waits for it
3. ends the box user's sessions and processes
4. turns off linger, and removes the user's crontab, at jobs, System V IPC
   objects, sudo rule and every file it owns on a local filesystem
5. removes the user and its home
6. checks that nothing is left, and adds 1 to the reset generation

The next box gets a new user, with a new user ID. If the reset fails, the
machine goes out of service. bb-box lends it again only after a reset
succeeds.

#### What it does not do

The default reset removes what the box's user made. It does not undo:

- changes made as root. Only boxes with Docker can make them: they have
  sudo and the `docker` group. That is why Docker needs a whole-machine
  reset
- changes to files other users let anyone write
- files on network filesystems, such as NFS
- files in container storage, such as `/var/lib/docker`, which it never
  searches
- anything the box sent elsewhere, such as over the network

It does not hide your machine from the box. A box can read every file that
any user on the machine can read, and see every process. Lend machines that
hold nothing you would not show the box.

### How a box gets a Mac

bb-box claims a free Mac whose box user is at the console. If the user is
still signing in, the box waits for it, then, for `macos-desktop`, for Cua
Driver's socket in the user's home. It waits up to 3 minutes in all.

The desktop is Screen Sharing on the Mac, reached through SSH as the box
user. Each time the desktop opens, bb-box asks the helper for the box
user's password, over the admin user's SSH, and gives it only to Screen
Sharing's sign-in. bb-box never stores it. Each box's user has its own
password, which the reset removes with the user. The desktop has the size
of the Mac's display, and cannot be resized. A Mac without a display may
need an HDMI dummy plug for a useful size.

Where the display offers it, each box user's desktop runs at the 2x mode of
its size, for that user's session only: 1920 x 1080 points drawn with
3840 x 2160 pixels on a 1080p plug. On a Retina screen the viewer then
shows each pixel at about 1.35 screen pixels, rather than 2.7 at 1x, so
text is sharp. Computer use's coordinates stay in points, so they do not
change. setup-mac.sh builds `bb-box-display`, which the helper runs after
each user signs in. On a Mac whose display has no 2x mode, it does
nothing.

The cost is 4 times the pixels. Measured through the viewer, a full screen
of noise, the worst case for Screen Sharing's lossless compression, took
1.37 s to reach the browser at 2x and 0.36 s at 1x. Typing reached the
picture in 49 to 111 ms at 2x and 28 to 71 ms at 1x.

The box user is a standard user, not an administrator. It cannot run
commands as root, install into `/Applications` or `/opt/homebrew`, or change
system settings.
So `brew install` fails in a box. Installs into its home work, such as npm,
pip, cargo and apps in `~/Applications`. Install what every box needs with
Homebrew as the Mac's administrator.

On a Mac with System Integrity Protection off, a box's commands may use the
microphone and the camera with no prompt
([058](../../docs/decisions/058-a-mac-with-sip-off-grants-its-box-users-macos-permissions.md)).
A Mac mini has no microphone of its own: its input is BlackHole 2ch, a
virtual device that plays back what is sent to it. A box records through it,
and `say -a BlackHole` feeds it speech. A box has a camera only if one is
attached to the Mac, such as a USB webcam.

On such a Mac, an agent grants its own programs other permissions with
`box_grant`, such as Accessibility for an app it built, and `box_status`
lists them. The helper grants only the box user's programs and apps in
`/Applications`, never Apple's, a shell or an interpreter, and the reset
removes every grant. Each box user has a signing identity of its own,
"bb-box local code signing", so a program it rebuilds keeps its grants.

### How an ios box gets a slot

An ios box, shared by default or asked for with `shared: true`, goes to a
ready slot on a pool Mac first, before a shared Tart host
([064](../../docs/decisions/064-ios-shared-hosts.md#placing-a-box)). The
claim gives the slot's user the box's key and loads its device server; the
box is ready once SSH answers as that user. With no ready slot, the box is
promised a place and the helper makes a slot for it: a new user, a device
by `simctl create`, seeded, and its first boot. The Mac keeps
`ios-hosts-ahead` slots ready, 1 by default, while it is not lent whole.

Each slot's home starts with the build of BB's app that BB's server gives,
so the slot's enrolment skips its download, about 2 to 3 s. bb-box's upkeep
installs that build as bb-box's admin user, with the admin user's `npm`,
when BB's server gives a new one. The helper's `machine slot keep-app` then
copies it into the slots' home, and into each ready slot no box has
claimed, once it has checked the copy. Without `npm` for the admin user,
slots download the app as they enrol, and bb-box's log says why.

A macos box asked for with `shared: true` takes a slot the same way, and
the slot's device is deleted at the claim: a macOS user on the Mac for
commands, builds and the simulator, with no sudo, Homebrew, console session
or grants. Its release removes the slot as an ios box's does.

A slot's release stops its user gently, removes it, and queues a sweep of
every file its UID owns on the Data volume, as a shared Tart host's do. A
slot's UID, from 80000, is never given again. The helper's `status`, read
with `sudo /usr/local/libexec/bb-box/machine slot status`, gives each
sweep's paths found and left.

A whole claim of a Mac lending only ready spares removes them first, before
it signs anything in. It is refused while a slot is held, promised or being
made for a box. The helper's markers decide: the owner marker for a whole
box, and the slots' `closed` marker, under the slots' lock, for slots.

| Setting | Default | What |
| --- | --- | --- |
| `ios-hosts-most` | empty | slots making, ready or held on each Mac. Empty, bb-box estimates it for each Mac: the fewest of its cores over 1.3, its memory over 1.5 GiB after 8 GiB for the Mac, and what its video encoder allows; 13 on an 18-core, 36 GiB M5 Max. `ios:<slots>` on a Mac's line, as in `macos,ios:10`, wins for that Mac, and `bb box doctor` says where each Mac's number came from |
| `ios-hosts-ahead` | 1 | ready slots kept while the Mac is not lent whole |
| `ios-hosts-resetting-most` | 4 | released slots swept in one pass |
| `ios-hosts-disk-reserve-gib` | 40 | no new slot below this much free disk |

### What a Mac's reset does

When a box is released, the helper:

1. makes the next box's user, with a new random password, and sets it as
   the automatic login, so that macOS does not sign the old user in again
2. logs the box's user out and ends its processes gently: its simulator
   devices shut down, then every process but its `containermanagerd`
   asked to end, a second's pause, its launchd domains, and SIGKILL for
   what is left. Ending them all at once can wedge the system's
   CoreMediaIO service, and then no simulator device boots until the Mac
   restarts ([064 results](../../docs/decisions/064-results.md#a-host-that-cannot-boot-a-device))
3. starts the login window again, which signs the next user in
4. removes the old user's crontab, at jobs, System V IPC objects, sudo rule,
   managed preferences, places in groups and every file it owns on the Data
   volume, then the user
5. checks that nothing is left and that the next user is at the console,
   then adds 1 to the reset generation

If starting the login window again has not signed the user in within a
minute, the helper restarts macOS's user space, then, 3 minutes later, the
Mac. It gives up 8 minutes after that, and the Mac goes out of service. It
remembers the way that worked, and the next reset starts with it. macOS 27
does not sign the user in when the login window starts again, so on macOS
27 and later the helper restarts user space from the first reset. A Mac
updated to macOS 27 starts with the way it remembers, so its next reset
takes a minute longer.

Restarting user space or the Mac ends every process on it, SSH sessions
included. bb-box then asks the helper again, which waits for the sign-in to
finish.

The next user's home says which macOS it last signed in on, so its first
sign-in does not open Setup Assistant.

A person signed in at the console stops the reset, and the Mac goes out of
service. Their session is left alone. Sign them out, then run
`machine reset` as in [A Mac out of service](#a-mac-out-of-service).
Signing them out is not enough: the automatic login runs only when the
login window starts, and bb-box lends the Mac again only at a later reset
generation.

A Mac's reset keeps macOS, its settings and apps, Homebrew, and Cua
Driver's grants. It removes the box's user and home, with its keychain,
its LaunchAgents and login items, and its files anywhere on the Data
volume. It does not undo:

- changes to files that others own and anyone may write
- what a standard user can change for the whole Mac, such as Wi-Fi
  networks joined, Bluetooth devices paired and an iPhone trusted over USB
- the system log and crash reports that name the box's processes
- anything the box sent elsewhere

A Mac has no whole-machine reset, and its boxes have no Docker.

### Notes

- **systemd.** On a machine with systemd, the helper turns on linger for
  each box user, so BB's daemon keeps running when no one is logged in.
  The reset turns it off. Without systemd, BB's daemon runs without linger.
- **Boot.** `/etc/tmpfiles.d/bb-box.conf` clears BB's lock and PID files in
  box homes at boot, so BB's daemon starts again after a hard stop.
- **Sizes.** Every machine is lent whole. bb-box claims the smallest free
  machine of at least the size a box asks for: as many cores, 90% of the
  memory or more (the kernel keeps some of it), and, when the size names a
  disk, that much free under `/home`, or `/Users` on a Mac. It counts the
  cores and memory a process may use, so on a machine that is a container
  with a CPU or memory limit, it counts the limit, not the host's. The
  doctor shows each machine's cores, memory and free disk, and warns about
  a machine too small for a kind's default size, saying which presets it
  holds. If your machines are smaller than the presets, change them in the
  kinds part of BB Box's settings.
- **Desktops.** On a Linux machine, the pool lends terminal boxes only. A
  Mac lends its desktop as `macos-desktop`.
