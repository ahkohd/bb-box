# Enrolment and warm pools

How a box becomes a BB machine, how long that takes, and whether a warm box
can be enrolled before a thread claims it.

Research, 30 September 2026: a note of what was known and measured then, not
the current design, which is in [the architecture](../architecture.md).
Settled by [014](../decisions/014-enrol-through-machine-providers.md),
[017](../decisions/017-boxes-clear-bb-daemon-state-at-boot.md) and
[032](../decisions/032-spare-boxes-are-enrolled-ahead.md).

Status: a recommendation from BB's source, measured on a real Proxmox LXC
host and in Docker containers. Checked against BB 0.44.0 (server protocol
219) on 30 September 2026.

## Recommendation

1. **Enrol through BB's machine provider API.**
   - bb-box registers one machine provider. To enrol a box, it calls
     `hosts.experimental_create` with the box ID as the key.
   - BB then calls the provider's `create`, which calls
     `machines.bootstrap` with an executor that runs over the box's command
     transport.
   - BB issues the credential and runs its own installer. The credential
     passes through the transport as stdin, and bb-box never stores or logs
     it.
2. **Templates carry what the installer needs.** That is Node.js 22.19 or
   newer, npm and curl. bb-app is pre-installed with its digest file, so the
   installer skips the download and `npm install`, which saves 1.7 to 4.7 s.
3. **Templates with systemd enable linger for the box user.** Without it, the
   host daemon stops with the SSH session that installed it (measured on a
   real host). An SSH pool machine turns linger on at claim, since its reset
   turns it off.
4. **Every template and image clears BB's daemon lock and PID file at boot**
   ([017](../decisions/017-boxes-clear-bb-daemon-state-at-boot.md)). After a
   hard stop, the lock makes a restarted daemon wait up to 10 s, and where
   there is no service manager the old PID can make the installer's start
   fail on every attempt. After a restart, bb-box calls `bootstrap` again
   with the same key, which starts the daemon without enrolling again.
5. **Enrol when a box is claimed, not before.** Enrolment takes 1.7 to 2.5 s
   with the template, and a box runs commands meanwhile. Nothing BB sends is
   fixed at enrolment. Pre-enrolled warm boxes would show in BB's machine
   list, where anyone could start a thread on them.

## How enrolment works

BB's machine providers are the way a plugin adds machines. A provider has
`create`, `remove` and optional `suspend` and `resume`. Inside `create`,
`machines.bootstrap({key, executor})` does the enrolment:

| Step | Who | What happens |
| --- | --- | --- |
| 1 | BB | makes a one-time enrolment credential for the host |
| 2 | executor | runs `sh -c` in the box with the credential on stdin, which fetches `/install.sh` with curl and runs it |
| 3 | installer | checks Node and npm, then asks for bb-app with the installed digest. A 304 skips the download and npm |
| 4 | installer | starts a temporary daemon with `host-daemon join`, and polls its `/status` every 1 s until it connects |
| 5 | installer | with a service manager: stops the temporary daemon (1 s polls), writes the systemd or launchd unit, starts it, and polls again every 1 s |
| 5 | installer | without one: keeps the temporary daemon running and exits |
| 6 | BB | waits for the host to connect, polling every 250 ms, for up to 120 s |

- If the host has connected before, `bootstrap` with the same key runs the
  installer's `--start` instead, so it is safe to repeat.
- The installer runs systemd's user scope in a container, even as root. It
  uses a service only when `systemctl --user` works. Otherwise it leaves the
  daemon running.

## What was measured

Each enrolment used BB's manual machine command, fed to `sh -s` in the box
as the box user, with a timestamp on each installer line. "Connected" is
when BB first reported the machine connected and active.

**On a real host**, with systemd: boxes linked-cloned from the Linux
template on Proxmox VE 9.2 (Ubuntu 24.04, Node 24.21), with the BB server on
the same LAN.

| Box | Installer finished | Connected |
| --- | --- | --- |
| bb-app removed | 6.93 s | 7.12 s |
| template as built, bb-app pre-installed | 2.25 s | 2.45 s |
| as above, linger off | 2.57 s | 2.76 s |

| Step | Time |
| --- | --- |
| fetch the installer, check Node, npm, the data directory and a port | 0.5 s |
| ask for bb-app with the installed digest | 0.06 s |
| download and `npm install` bb-app, when not pre-installed | 4.8 s |
| join as the new machine | 0.33 s |
| install the systemd user service and wait for it to connect | 1.1 to 1.3 s |
| BB sees the machine, after the installer exits | 0.2 s |

With the template, a box is enrolled about 2.5 s after bb-box starts the
installer, on top of about 2.2 s from request to SSH: about 5 s from request
to an enrolled machine. What is left is the installer's fixed steps and its
1 s polls.

**In Docker**, without systemd: `node:24-bookworm-slim` containers with
`--init`, on a Linux devbox close to its BB server.

| Box | Installer finished | Connected |
| --- | --- | --- |
| bb-app not installed | 3.35 to 3.98 s | same |
| bb-app pre-installed | 1.65 to 1.77 s | same |

Without a service manager, the installer keeps its first daemon and exits
once it connects, which its 1 s poll sees about 1.07 s after the daemon
starts. The daemon keeps running after `docker exec` ends, under the
container's init.

**Restarts.** A `docker restart` of an enrolled container, then the start
that `bootstrap` runs for a known machine (`sh -s -- --start --host-id`):

| Before the start | Start finished | Connected |
| --- | --- | --- |
| nothing | 7.5 to 8.8 s, waiting for the daemon lock to go stale | 0.04 s after the start |
| nothing, the old PID now used by another process | fails: "Recorded daemon PID belongs to another process" | never |
| daemon lock and PID file removed | 0.46 to 0.47 s | 0.50 to 0.51 s after the restart |

- The daemon's lock is a directory, `daemon.lock.lock`, refreshed every 5 s
  and stale after 10 s. A hard stop leaves it behind.
- `install-daemon.pid` is written only where there is no service manager.
  PIDs in a container repeat from boot to boot, so once the old PID is one
  the installer's own processes take, the start fails every time: 4 of 5
  restarts in a row.
- A `systemd-tmpfiles` rule removes both at boot, tested in a Debian 12
  container with systemd, and keeps `auth.json`.

**Linger**, 30 s after the SSH session that ran the installer ended, on the
real host: with linger, the service was active and the machine connected.
Without it, the user manager stopped with the session and took the daemon
with it. It came back only when a new SSH session started the manager again.

Earlier, in a Debian 12 container with systemd, run over SSH as root:

| Case | 15 s after the SSH session ended |
| --- | --- |
| no linger | root's user manager stopped, and the service with it |
| `loginctl enable-linger root` | user manager and service running |
| linger, container restarted | service running again |

## What BB sends to an enrolled box

Nothing thread-specific is fixed at enrolment:

- BB resolves a machine's environment each time it is used: its Git
  credentials, and the global and project machine variables. Commands,
  terminals, the thread runtime and plugin host calls each get the current
  values.
- BB pushes the machine environment again when the host connects and when
  the settings change.

So a pre-enrolled warm box would be safe, and renaming it on claim works
(`hosts.update` with a name). The case against pre-enrolment is that warm
boxes would be visible machines, not how long enrolment takes.

## bb-box inside an enrolled box

A plugin's host entry runs on every enrolled machine, through the daemon's
own connection to BB. Each call gets the machine environment as its process
environment. bb-box can use this to write the thread's environment to a file
in the box, which its SSH sessions then load. This works because SSH sessions
do not go through BB, so they do not get the environment otherwise. The file
is written on enrolment and refreshed before `run` when it is older than
5 minutes.

## A thread on a new box

A provider marked `ephemeral` can also be the place a thread runs. You pick
"new bb-box box" when starting a thread, BB calls `create`, and BB removes
the machine when no thread uses it. This fits BB well, but the box then
belongs to a machine, not a thread. It is a later step, after enrolment works
for boxes that threads acquire.

## What a template needs

| Need | Why |
| --- | --- |
| Node.js 22.19 or newer, npm, curl | the installer and bootstrap use them |
| bb-app in `~/.bb-machines/<server host>/npm`, and `host-artifact.sha256` beside it | the installer skips the download and npm |
| linger for the box user, where systemd runs | the daemon survives the SSH session |
| BB's daemon lock and PID file removed at boot | a restarted box reconnects in 0.5 s |
| no `auth.json` in the data directory | the box enrols as a new machine |

`<server host>` is the host of BB's URL, with its port if it has one, and
any character other than a letter, digit, `.` or `-` replaced by `-`.

A template built for an older BB still works: the digest differs, so the
installer downloads and installs bb-app again, adding 2 to 5 s. The setup
scripts rebuild templates when BB updates.
