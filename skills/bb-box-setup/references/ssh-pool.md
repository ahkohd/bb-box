# The SSH host pool

The pool lends the person's own Linux machines and Macs, reached over SSH.
A box has a whole machine to itself, as a new user there. When the box is
released, bb-box resets the machine and lends it again. A Mac can also lend
iOS slots: each shared ios box is a macOS user on the Mac with its own
device. The guide is `setup/ssh-pool/README.md`.

It is not a security boundary: a box can read what any user on the machine
can read, and the reset removes users. Use machines set aside for boxes, and
say so to the person.

## Ask

- The machine's address as BB's server reaches it, an administrator who may
  run `sudo` there, and a name for it, such as `build-1` or `mac-1`.
- On Linux: x86_64, `sshd`, Node.js 22.19 or newer on the default `PATH`,
  `git` and `gh`. `setup.sh` warns about what is missing.
- On a Mac: Apple silicon, FileVault off, Remote Login on, nobody signed in
  at the console, and the person's own home closed with
  `sudo chmod 700 /Users/<them>`. Xcode in `/Applications` first, for Xcode
  and iOS. An HDMI dummy plug if it runs without a display.
- Which kinds the machine serves: `linux` on Linux; `macos`,
  `macos-desktop` and `ios` on a Mac.

## Get bb-box's key

```sh
bb box backend add ssh-pool --off       # if there is none yet: bb box backend list
bb box backend set ssh-pool --check     # a note gives the public key, ssh-ed25519 ...
```

The check fails until the pool has a machine. That is expected.

## Set up a Linux machine

Copy `setup/ssh-pool` from a checkout of bb-box at the installed commit to
the machine, then run `setup.sh` there as root, with the public key:

```sh
scp -r setup/ssh-pool <admin>@192.0.2.21:
ssh <admin>@192.0.2.21 sudo sh ssh-pool/setup.sh --key "'ssh-ed25519 AAAA... bb-box'" --name build-1
```

It makes the admin user `bbbox-admin`, which accepts only bb-box's key and
may run only bb-box's helper as root. It prints the line for the pool's
`machines` field and the machine's host keys. Read its warnings, and fix them
first.

## Set up a Mac

Copy the whole `setup` folder, so `setup/tart/ios` is beside
`setup/ssh-pool` for iOS slots. Run, from an administrator's account:

```sh
scp -r setup <admin>@192.0.2.30:bb-box-setup
ssh <admin>@192.0.2.30 sudo sh bb-box-setup/ssh-pool/setup-mac.sh --key "'ssh-ed25519 AAAA... bb-box'" --name mac-1
```

It prints the machines line, the host keys, and four steps for a person at
the Mac or on Screen Sharing: Screen Sharing for all users, full disk access
for remote users, and Accessibility and Screen Recording for CuaDriver,
`/usr/bin/osascript` and `/usr/libexec/sshd-keygen-wrapper`. Give the person
those steps; you cannot do them over SSH. If someone was signed in, the Mac
must restart.

With Xcode and its iOS platform, it also sets up iOS slots, and the line it
prints lists `ios`. Leave `ios` off the line to keep the Mac for whole
boxes; while any slot is held, the Mac is not lent whole.

## Add the machine to the pool

Add the printed line and host keys, then turn the pool on:

```sh
bb box backend set ssh-pool \
  --add-line machines="build-1 bbbox-admin@192.0.2.21 linux" \
  --add-line known-hosts="192.0.2.21 ssh-ed25519 AAAA..." --on --check
bb box backend set ssh-pool \
  --add-line machines="build-1 bbbox-admin@192.0.2.21 linux" \
  --add-line known-hosts="192.0.2.21 ssh-ed25519 AAAA..." --on
```

Give one `--add-line known-hosts=...` for each host key line `setup.sh`
printed. A machines line is
`<name> [user@]host[:port] <kinds> [via=<jump host>] [reset=machine] [labels=<words>]`.
`ios:<slots>` on a Mac's line sets its iOS slots. `reset=machine` means the
machine has a whole-machine reset, so its boxes get Docker; boxes have Docker
only when every line has it.

To take a machine out: `bb box backend set ssh-pool --remove-line
machines=build-1 --remove-line known-hosts=192.0.2.21`. It is refused while
the machine holds a box.

## Check and prove

The checks should pass for each machine: SSH, the helper, its architecture,
its sizes, and on a Mac its desktop and Xcode. A machine smaller than the
kind's default size gets no box at that size: lower the presets with
`bb box kind set` if the machines are small. Prove it with
`bb box acquire linux --on ssh-pool`, or `macos --on ssh-pool`. A release
resets the machine, which takes a few seconds on Linux and longer on a Mac.

Each machine's `snapshots` check says what snapshots it could offer: home
snapshots where its box homes are on APFS, btrfs or ZFS, and machine
snapshots where an operator installed a snapshot hook. Boxes lent a Mac
whole take home snapshots where the Mac says its homes clone; Linux
machines, iOS slots and hooks take none yet, so tell the person what those
could offer, not that they snapshot. To prove home snapshots on a free Mac,
have the person run `sudo /usr/local/libexec/bb-box/machine snapshot proof`
there. It takes about 2 to 3 minutes on new scratch users, and iOS slot
commands wait for it. It refuses, changing nothing, while a box or an iOS
slot uses the Mac. Where an earlier proof was cut short, it first checks
that proof's whole record, then removes what that proof recorded making;
where it cannot list the Mac's users or prove something is its own, it
refuses, changing nothing, and keeps `/var/db/bb-box/proof-made`: tell the person what
its notes say rather than removing anything yourself. A check that warns says what to do: run
the machine's setup script again when its helper is older, or, when the
probe could not remove its trial, remove as root what it names.
