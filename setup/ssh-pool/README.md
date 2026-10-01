# SSH host pool backend

This backend lends Linux machines you already have, reached over SSH. A box
has a whole machine to itself. When the box is released, bb-box resets the
machine and lends it again.

It suits spare desktops, build servers and virtual machines you run
yourself. It is not a security boundary: a box runs as an ordinary user on
your machine, and can read what any user there can read.

| Path | What it does |
| --- | --- |
| `setup.sh` | Sets up a machine: run it once on each machine, as root |
| `machine.sh` | bb-box's helper, which `setup.sh` installs on the machine |
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

## Requirements

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
  size fits it: 2 cores and 4 GiB of memory for `linux`. For smaller machines, make the presets smaller with the
  `box-sizes` setting (see Sizes under Notes).

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

## 1. Get bb-box's key

1. In BB, open BB Box's settings and set up **SSH host pool**. Leave it off
   until a machine is ready.
2. Leave **SSH private key** empty. bb-box makes a key.
3. Press "Check". A note shows the public key, starting `ssh-ed25519`. The
   check fails until the pool has a machine; that is expected here.

To use a key you already have, paste its private key into the field
instead. It must have no passphrase.

From a terminal, `bb box config check <file> --test` runs the same check on
a configuration file, as `bb box config show --json` prints it.

## 2. Set up each machine

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
| `--reset-hook <path>` | Your whole-machine reset, for Docker. See [Docker](#docker) |

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

Run `setup.sh` again to update the helper or the key. It keeps the reset
generation. It never changes a user it did not make: if `bbbox-admin`
already exists for something else, choose another name with `--admin`.

### If 2 bb-box installs lend the same machine

Give `--key` once for each install's key:

```sh
sudo sh ssh-pool/setup.sh --key "ssh-ed25519 AAAA... bb-box" --key "ssh-ed25519 BBBB... bb-box"
```

`setup.sh` replaces the admin user's keys each time it runs, so give every
install's key whenever you run it again.

### If sshd lets only some users in

If sshd has `AllowUsers` or `AllowGroups`, add the admin user and box users,
for example:

```text
AllowUsers bbbox-admin bbx-* alice
```

Then reload sshd. `setup.sh` warns when it finds either setting.

## 3. Add the machine to bb-box

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
| `<kinds>` | `linux`. A line from before may also list `linux-docker`, linux with Docker, which needs `reset=machine` |
| `via=` | A jump host, reached with the same key |
| `reset=machine` | The machine has a whole-machine reset, so its boxes get Docker. `setup.sh` adds it when you give `--reset-hook` |
| `labels=` | Words for your own use |

bb-box lends the smallest free machine that fits the box's size. The pool's
boxes have Docker only when every machine's line has `reset=machine`
([decision 041](../../docs/decisions/041-every-linux-box-has-docker.md)).
When only some lines have it, no box has Docker, each says No Docker, and
the doctor warns.

### Through a jump host

bb-box reaches the jump host with the same key, as the user in `via=`, and
asks it to forward to the machine. The admin user cannot forward, so use
another user on the jump host. In its `authorized_keys`, you can limit the
key to forwarding to your machines:

```text
restrict,port-forwarding,permitopen="build-1:22",permitopen="build-2:22" ssh-ed25519 AAAA... bb-box
```

Add the jump host's keys to the host keys setting too. Name the machine by
the address the jump host reaches it on, and give its host keys under that
name. Boxes on a machine reached through a jump host have no Docker host
URL.

## What a reset does

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

### What it does not do

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

## Docker

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

## Running the pool

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

### Removing a machine

1. Release any box on it.
2. Remove its line from the machines setting, and its host keys.
3. On the machine, remove what `setup.sh` added:

   ```sh
   sudo userdel -r bbbox-admin
   sudo rm -rf /usr/local/libexec/bb-box /etc/sudoers.d/bb-box /etc/tmpfiles.d/bb-box.conf /var/lib/bb-box
   ```

## Notes

- **systemd.** On a machine with systemd, the helper turns on linger for
  each box user, so BB's daemon keeps running when no one is logged in.
  The reset turns it off. Without systemd, BB's daemon runs without linger.
- **Boot.** `/etc/tmpfiles.d/bb-box.conf` clears BB's lock and PID files in
  box homes at boot, so BB's daemon starts again after a hard stop.
- **Sizes.** Every machine is lent whole. bb-box claims the smallest free
  machine of at least the size a box asks for: as many online cores, 90%
  of the memory or more (the kernel keeps some of it), and, when the size
  names a disk, that much free under `/home`. The doctor shows each
  machine's cores, memory and free disk. If your machines are smaller than
  the presets, change them in the kinds part of BB Box's settings.
- **Desktops.** The pool lends headless machines only. Desktops are not
  supported yet.

## Testing on one computer

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
