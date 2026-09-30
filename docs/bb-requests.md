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

## Checked, no request needed

- **Subprotocols.** BB's WebSocket server answers with the first subprotocol
  the client asks for, which is what Selkies' client needs.

## Possible later

- **One daemon at enrolment.** The installer starts a temporary daemon to
  join, then installs the service and waits for it to connect again. On a
  real host, the handover and its 1 s polls took 1.1 to 1.3 s of the 2.25 s
  an enrolment took with the template
  ([enrolment and warm pools](research/enrolment-and-warm-pools.md)). A box
  runs commands meanwhile, so bb-box does not ask yet.
- **Machines hidden from thread placement.** If warm boxes are enrolled ahead,
  bb-box would ask for a way to keep an unclaimed machine out of BB's machine
  list and thread placement until a thread claims it.
- **Linger in the installer.** Where the installer makes a systemd user
  service, it could enable linger, so the service outlives the session that
  installed it. bb-box does this in its templates meanwhile.
