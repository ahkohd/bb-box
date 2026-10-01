# What bb-box asks of BB

bb-box builds on BB rather than around it
([002](decisions/002-bb-is-the-coordinator.md)). These are the BB features it
needs and does not have yet, checked against BB 0.44.0 (plugin SDK and
server protocol 219). They are drafts until filed with BB.

| Request | Status | Without it |
| --- | --- | --- |
| [BB's host app on Windows](#1-bbs-host-app-on-windows) | draft | Windows boxes cannot enrol |
| [Send backlog on plugin WebSockets](#2-send-backlog-on-plugin-websockets) | draft | the desktop relay cannot slow down for a slow viewer |
| [Start cleanly after a reboot](#3-start-cleanly-after-a-reboot) | draft | every template and image clears BB's daemon lock and PID file at boot |
| [Change a plugin's source and keep its state](#4-change-a-plugins-source-and-keep-its-state) | draft | moving bb-box off a pinned commit or tag needs `bb plugin remove`, which deletes its settings, secrets and storage |
| [Enrol quickly when bb-app is installed](#5-enrol-quickly-when-bb-app-is-installed) | draft | a box from a template with bb-app installed takes about 5 s to enrol, not under 2 s |
| [Find a machine by its key](#6-find-a-machine-by-its-key) | draft | the machine of a box whose record was lost, and whose thread then ended, stays in BB |
| [Reach a port on a machine](#7-reach-a-port-on-a-machine) | draft | a Mac that runs Tart for bb-box needs SSH from the BB server, with a host user and a key, even when it is a BB machine already |
| [Give a machine's own commands its variables](#8-give-a-machines-own-commands-its-variables) | draft | bb-box reads the thread's variables and GH_TOKEN from BB's workers in the box: from `/proc` on Linux, inexactly from `ps -E` on macOS, and not at all on Windows |

## 1. BB's host app on Windows

**What bb-box needs.** Windows boxes that enrol as BB machines, like Linux and
macOS boxes. Then a thread's Git credentials and machine variables reach its
Windows box, and a child thread can run there, for example to build and test
a Windows app.

**What BB does now.**

- `bb-app`'s `package.json` declares `"os": ["darwin", "linux"]`.
- The machine installer is a POSIX sh script. On any other system it stops
  with "bb machine installation supports macOS and Linux only."
- The host daemon runs as a systemd user service on Linux or a launchd agent
  on macOS.
- A machine provider's `bootstrap` runs the installer through the provider's
  executor as `sh -c`.

**What we ask.**

1. A Windows installer, in PowerShell, that enrols a machine the way the sh
   installer does, including the same skip when the host app is already
   installed.
2. `bb-app` published with Windows builds of its native modules, for x86_64
   first.
3. The host daemon running as the logged-in user in the desktop session, for
   example as a scheduled task at logon, rather than as a service in session 0.
   Threads then reach the desktop the user sees.
4. `experimental_machines.bootstrap` choosing the installer by the machine's
   OS, so a provider's executor can run PowerShell.

**Until then.** Windows boxes run commands, copy files and stream their
desktop through bb-box's own transports. They do not get the thread's Git
credentials and machine variables from BB, and child threads cannot run on
them. The panel says so on each Windows box.

## 2. Send backlog on plugin WebSockets

**What bb-box needs.** The desktop relay copies a box's stream to each viewer
through a plugin WebSocket route. When a viewer's network is slower than the
stream, the relay should see its own backlog, so it can stop reading from the
box and let the stream protocol slow down.

**What BB does now.** The plugin socket has `send`, `close` and `readyState`.
`send` returns nothing, and there is no `bufferedAmount`, so the plugin cannot
tell how much is queued for the viewer.

**What we ask.** Either `bufferedAmount` on the plugin socket, as in the
browser's WebSocket, or a `send` that returns a promise which resolves when the
data has been handed to the network.

**Until then.** The relay copies bytes as they come and leaves flow control to
the stream protocol end to end ([007](decisions/007-desktop-stream-is-a-typed-transport.md)).
RFB paces updates end to end, through the viewer's update requests or
TigerVNC's congestion control, which keeps the backlog small. Selkies'
WebSocket mode is not measured yet.

## 3. Start cleanly after a reboot

**What bb-box needs.** A box that restarts after a hard stop reconnects to BB
as soon as it boots. bb-box's `stop` on Proxmox LXC is a hard stop, and a
Docker box's daemon ends with its container.

**What BB does now.** Measured in Docker containers with BB 0.44.0:

- The host daemon's lock, `daemon.lock.lock` in the data directory, survives
  a hard stop. A daemon started within 10 s waits for it to go stale: the
  start took 7.5 to 8.8 s instead of 0.47 s.
- Without a service manager, the installer records the daemon's PID in
  `install-daemon.pid`. After a reboot, `--start` finds that PID used by
  another process and stops with "Recorded daemon PID belongs to another
  process." A container's PIDs repeat from boot to boot, so this happened on
  4 of 5 restarts in a row.

**What we ask.**

1. `--start` ignores a PID file written before the last boot, for example by
   recording the boot ID beside the PID.
2. The daemon takes over a lock whose holder is not running, for example by
   recording its PID and boot ID in the lock directory.

**Until then.** Templates and images remove both files at boot
([017](decisions/017-boxes-clear-bb-daemon-state-at-boot.md)).

## 4. Change a plugin's source and keep its state

**What bb-box needs.** An operator moves bb-box from one source to another
without losing anything: from a pinned commit to a branch to follow
development, or from a branch to a release tag. Its settings, secrets,
schedules and storage stay, and so do the boxes its storage records.

**What BB does now.** Checked in BB 0.44.0:

- Git tags and commits, and exact npm versions, are pinned.
  `bb plugin update` skips a pinned plugin and says to remove it and install
  it again.
- A pinned `git:` or `npm:` source changes only through `bb plugin remove`
  and a fresh install. The remove deletes the plugin's settings, secrets and
  schedules, and the new install starts with empty storage.
- Only a local path moves in place: `bb plugin install path:<new dir>` keeps
  the plugin's configuration.

Moving bb-box from a pinned commit to a branch this way on 30 September cost
a running box: the new install had no box records, and its sweep released a
box that a live thread was using.

**What we ask.** Either of:

1. `bb plugin install <source>` for an installed plugin moves it to the new
   source and keeps its settings, secrets, schedules and storage, as a local
   path install does now.
2. `bb plugin update <id>` takes a new ref, for example `--ref <branch>`,
   for a `git:` source.

Either should show the old and new source and ask first, as an install does.

**Until then.** The README says to install bb-box from a branch, which
`bb plugin update` follows, and never to remove it to upgrade. If bb-box
loses its storage anyway, its boxes keep running:
`bb box install-id --set <id>` takes its install ID back, and the sweep
restores the boxes of live threads from their guests
([019](decisions/019-lost-records-are-restored-from-guests.md)). After a
remove, its settings and secrets must still be entered again.

## 5. Enrol quickly when bb-app is installed

**What bb-box needs.** A box from a template that has bb-app installed is a
BB machine in under 2 s after it is ready. Until then it has none of the
thread's Git credentials and machine variables, and no child thread can run
there.

**What BB does now.** Measured on a real host with BB 0.44.0, on a box with
systemd and bb-app installed: the enrolment took 5.23 s after the box was
ready, of which BB's installer took 4.98 s. Every other step together took
about 0.25 s.

| Step | Time |
| --- | --- |
| check Node, npm and the data directory, and ask for bb-app with the installed digest | about 0.5 s |
| a host daemon from start to connected, for each of the two below | about 2 s |
| from the temporary daemon connecting to BB showing the machine active | about 3 s |
| BB showing the machine connected, after the installer exits | 0.13 to 0.43 s |

From the installer and the daemon's code:

- **Two daemons.** The installer starts a temporary daemon with
  `host-daemon join`. Where there is a service manager, it stops that daemon,
  writes and starts the systemd or launchd service, and waits for the
  service's daemon to connect. Most of the 3 s above is this handover.
- **1 s polls.** Each wait checks the daemon's `/status` with a new
  `node -e` process, then sleeps 1 s. Enrolment has two such waits, each of
  which loses up to 1 s. The `--start` path already polls every 0.25 s.
- **A daemon's start.** Before it connects, the daemon starts two Node
  processes, the bb-app launcher and then the daemon bundle, and runs the
  user's login shell to read its environment, with a 3 s limit.
  `--auto-update` does no work at start: the daemon asks for
  `/install/version` only after the server refuses its protocol version.

An earlier measurement with the same BB took 2.25 s for the installer, with
0.33 s to join and 1.1 to 1.3 s for the service
([enrolment and warm pools](research/enrolment-and-warm-pools.md)). Why a
daemon now takes about 2 s to connect is not known yet.

**What we ask.**

1. One daemon at enrolment. For example, `host-daemon join` stores the
   machine's credentials and exits once the server accepts them, and the
   service is the only daemon that connects.
2. The installer's waits check `/status` every 0.1 to 0.25 s, from one Node
   process rather than a new one for each check.
3. A daemon that connects well under 1 s after it starts when bb-app is
   installed, for example by reading the login shell's environment after it
   connects rather than before.

Together these should bring an enrolment with bb-app installed under 2 s.

**Until then.** bb-box sets up the thread's access in the box while BB's
installer runs, asks BB whether the machine is connected every 100 ms once
the installer has finished, and logs each step's time in
`bb plugin logs bb-box`. Spare boxes, enrolled ahead, are to hide the wait
for the kinds that have them
([032](decisions/032-spare-boxes-are-enrolled-ahead.md)). BB shows them as
machines until a thread claims them (below).

## 6. Find a machine by its key

**What bb-box needs.** To remove the BB machine of a box whose record it
lost. bb-box makes each box's machine with the box ID as the key
([014](decisions/014-enrol-through-machine-providers.md)). If bb-box loses
its storage and a box's thread ends before the sweep restores the box, the
sweep releases the box's guest, which names the box ID. Nothing tells
bb-box which machine has that key, so the machine stays in BB, disconnected,
until someone removes it.

**What BB does now.** Checked in BB 0.44.0:

- `Host` has no key. `hosts.list` filters only by type and by whether a
  machine is still being made, and `hosts.get` takes a host ID.
- `hosts.experimental_create` with the key returns the machine BB has for
  it, but makes a new one when BB has none, as after someone removed it.
  bb-box must not bring back a machine that was removed.
- `machineBootstrap.bootstrap` finds the machine by its key, and checks that
  the plugin's provider made it, but then runs BB's installer in the box.

**What we ask.** A way for a plugin to find the machine its provider made
with a given key, without making one. For example, `hosts.get({ key })`
that answers only the plugin whose provider made the machine, or the key on
`Host` for that plugin.

**Until then.** Such a machine stays in BB until someone removes it
([026](decisions/026-a-restored-box-enrols-once-it-answers.md)). It
follows only lost plugin storage, which upgrades no longer cause.

## 7. Reach a port on a machine

**What bb-box needs.** To drive a Mac that is already a BB machine without
SSH. The Tart backend runs `tart` on a Mac host, and reaches each VM through
it, since the VMs sit on the Mac's own NAT: commands over SSH with the Mac as
the jump host, and the desktop through Tart's VNC server on the Mac's
loopback. Today all three need SSH from the BB server to the Mac: a host user
with Remote Login, bb-box's key in its `authorized_keys`, and the Mac's host
key pinned in bb-box's settings. When the Mac runs BB's host daemon, BB
already has an authenticated connection to it.

**What BB does now.** Checked in the plugin SDK 0.5.29 and 0.6.5:

- A plugin can declare one host entry (`bb.host`, an
  `ExperimentalHostEntry`), which BB's daemon runs as a worker on each
  machine. The server side calls it with `bb.hosts.experimental_client`:
  request and response with JSON in and out, up to 30 minutes a call, plus
  ephemeral signals from the worker and `experimental_retainWorker` for work
  in the background. That is enough to run `tart clone`, `run`, `ip`,
  `suspend` and `delete` on the Mac.
- Nothing carries bytes both ways with backpressure. Calls and signals are
  JSON messages, and machine terminals (`terminals.create`, `input`,
  `output`) are PTY sessions whose output is read back, which change bytes
  and suit people, not protocols. So neither can carry the VNC stream or an
  SSH connection to a VM.

**What we ask.** A way for a plugin's server side to open a two-way byte
stream to a TCP address as a machine sees it, with backpressure: for example
`bb.hosts.experimental_connect({ hostId, host, port, signal })`, returning a
`ReadableStream` and a `WritableStream`, and allowed only to addresses the
host entry's machine can reach. It could be limited to the loopback and
private ranges, or to what a plugin's host entry allows.

**What it would remove.** For a Mac that is a BB machine, all of bb-box's
SSH to the Mac: the host user's Remote Login, bb-box's key on the Mac and
its pinned host key. `tart` would run through the host entry; the VNC route
would be a stream to `127.0.0.1:<port>` on the Mac; each VM's SSH would be a
stream to `<VM address>:22` from the Mac, so the VMs need no jump host. The
VMs' own SSH, with bb-box's key in the image, would stay, until the VMs
enrol and bb-box can run commands through BB too.

**Until then.** The Tart backend reaches Macs over SSH, which is also the
general path for Macs that do not run BB.

## 8. Give a machine's own commands its variables

**What bb-box needs.** The thread's machine variables and GitHub token in
every command that runs in its box, not only in the processes BB's daemon
starts. bb-box runs commands through the box's own transport, SSH or
`docker exec`, for `box_run` and the other box tools, and a thread may run
its own over SSH. They need what BB's workers in the box have: GH_TOKEN for
`gh` and git, and the variables a project sets for its builds and tests.

**What BB does now.** Checked in BB 0.44.0 and the plugin SDK 0.5.29:

- A plugin can list machine variables, for all projects
  (`system.machineEnvironment`) and for one (`projects.machineEnvironment`),
  and set or replace them, but cannot read a value. Every variable comes
  back with `secret: true` and `value: null`. `bb machine env list --json`
  gives the same.
- BB's daemon on a machine gives the values, and GH_TOKEN, to the processes
  it starts for threads, in their environment. The daemon's own process has
  none of them, and some workers have only some.
- No command on the machine prints them.

**What we ask.** A way for the machine's own user to get the variables a
thread of a given project has on that machine, in a form a shell can
source. bb-box would read them before every command, so it must be quick.
For example:

- the daemon keeps them, per project, in a file in its data directory that
  only the machine's user can read, and rewrites it when they change; or
- a command of BB's host app that asks the daemon and prints
  `export NAME='value'` lines for a project, in a few milliseconds.

Either way, the values stay on the machine BB already gives them to, and
no plugin's server side sees them.

**What it would remove.**

- On Linux, bb-box's scan of `/proc/<pid>/environ` for the daemon's
  workers, which picks the newest worker with the most variables.
- On macOS, bb-box's parsing of `ps -E`. It prints a newline as `\012`
  but leaves a backslash as it is, so it cannot read exactly a value that
  holds a backslash and three digits, or a space followed by a name and
  `=`.
- On Windows, which has neither `/proc` nor `ps -E`, the gap: once
  request 1 lets a Windows box enrol, it would get the variables the same
  way.
- bb-box's dependence on where BB installs its daemon
  (`host-daemon/dist/daemon-bundle`), which a BB release can change.

**Until then.** Linux boxes read the workers' environment from `/proc`,
and macOS boxes parse `ps -E`, choosing the worker the same way
(`src/core/in-box.ts`). Windows boxes get none of the variables.

## Checked, no request needed

- **Subprotocols.** BB's WebSocket server answers with the first subprotocol
  the client asks for, which is what Selkies' client needs.

## Possible later

- **Machines hidden from thread placement.** bb-box enrols spare boxes ahead
  ([032](decisions/032-spare-boxes-are-enrolled-ahead.md)), and BB shows them
  in its machine list and picker until a thread claims them. bb-box would
  ask for a way to keep a machine out of both, such as a flag that
  `hosts.update` can set and clear. BB now hides only ephemeral machines.
  Only BB makes those, and it removes them once no thread uses them.
- **Linger in the installer.** Where the installer makes a systemd user
  service, it could enable linger, so the service outlives the session that
  installed it. bb-box does this in its templates meanwhile.
