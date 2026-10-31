# What bb-box asks of BB

bb-box builds on BB rather than around it
([002](decisions/002-bb-is-the-coordinator.md)). These are the BB features it
has needed. Each one's status was checked against BB 0.45.0, its plugin SDK
0.6.15, its guide and its component registry, on 7 October 2026, or against the
version its section names. On 25 October 2026 the requests a plugin's API or
BB's command line shows were checked again against BB 0.47.1 and its plugin SDK
0.6.79: their sections say "Status in BB 0.47.1". Those that only a live test
shows, such as a reboot or a Windows install, keep the status of the version
they name. A request BB meets stays here, with the bb-box issue that drops its
workaround. This page
is a log: bb-box does not file these with BB.

| Request | Status | Without it |
| --- | --- | --- |
| [BB's host app on Windows](#1-bbs-host-app-on-windows) | partly met | Windows boxes join BB as machines of BB's manual provider, not bb-box's, so BB removing one does not release its box, and "New box" cannot make a Windows box (#539) |
| [Send backlog on plugin WebSockets](#2-send-backlog-on-plugin-websockets) | not met in 0.47.1 | the desktop relay cannot slow down for a slow viewer |
| [Start cleanly after a reboot](#3-start-cleanly-after-a-reboot) | not met | every template and image clears BB's daemon lock and PID file at boot |
| [Change a plugin's source and keep its state](#4-change-a-plugins-source-and-keep-its-state) | not met | moving bb-box off a pinned commit or tag needs `bb plugin remove`, which deletes its settings, secrets and storage |
| [Enrol quickly when bb-app is installed](#5-enrol-quickly-when-bb-app-is-installed) | not met | a box from a template with bb-app installed takes about 5 s to enrol, not under 2 s |
| [Find a machine by its key](#6-find-a-machine-by-its-key) | not met | the machine of a box whose record was lost, and whose thread then ended, stays in BB |
| [Reach a port on a machine](#7-reach-a-port-on-a-machine) | not met | a Mac that runs Tart for bb-box needs SSH from the BB server, with a host user and a key, even when it is a BB machine already; Docker on a BB machine goes through a relay of bb-box's own, on a route with `auth: "none"` guarded by a one-time secret |
| [Give a machine's own commands its variables](#8-give-a-machines-own-commands-its-variables) | not met | bb-box's host entry keeps a process with the thread's variables and GH_TOKEN on each box, and commands read them from BB's processes there: from `/proc` on Linux, inexactly from `ps -E` on macOS, and through each process's PEB on Windows |
| [Open BB's terminal on a machine from a plugin](#9-open-bbs-terminal-on-a-machine-from-a-plugin) | met in 0.47.1, experimental; bb-box does not use it yet | a box's terminal is bb-box's own tab over its own shell, not BB's terminal with its tabs, history and persistence |
| [Show machine-making environments where they can be seen](#10-show-machine-making-environments-where-they-can-be-seen) | not known | "New box" in the new-thread screen sits below the fold of the Machines list, and users do not find it |
| [Give a machine a project's variables without a thread there](#11-give-a-machine-a-projects-variables-without-a-thread-there) | not met | a box has its thread's project variables only while a thread of the project runs on it |
| [Make a plugin's host call quick](#12-make-a-plugins-host-call-quick) | not met | each call to bb-box's host entry takes about 0.4 s, so it cannot carry commands |
| [Mark a machine offline when it stops checking in](#13-mark-a-machine-offline-when-it-stops-checking-in) | not met | a machine that goes with no word, such as a PC that restarts, shows as connected for about 16 minutes, so bb-box judges it by when BB last heard from it |
| [Panel actions without a launcher row](#14-panel-actions-without-a-launcher-row) | may be met in 0.47.1, experimental; not tried | a thread panel action is always a launcher row, so Desktop and Terminal cannot be hidden and open from the Box panel alone; instead each is a shortcut that opens the right box |
| [Give a plugin's CLI the caller's files](#15-give-a-plugins-cli-the-callers-files) | documented in 0.45.0, not shipped | `bb box image set --script-file` and `bb box config apply` read their files on BB's server, so they fail from any other machine; agents use `box_image_set`, which takes the text, until #535 |
| [Alert dialogs that do not fly in from the corner](#16-alert-dialogs-that-do-not-fly-in-from-the-corner) | not met | every plugin's alert dialog, scaffolded from the registry's `alert-dialog.tsx`, flies in from the top left on Tailwind v4; bb-box carries BB's own dialog motion in its copy |
| [Carry providers' own config to every machine](#17-carry-providers-own-config-to-every-machine) | not met | a box lacks the config a provider reads from its machine, such as pi's `models.json`, so bb-box carries a list of files of its own into every box (#455) |
| [A nav page's title-bar action beside its title](#18-a-nav-pages-title-bar-action-beside-its-title) | not met | the Boxes page's settings gear sits at the title bar's right, before BB's own buttons, not beside the "Boxes" title where the operator wanted it |
| [Tool calls longer than five minutes](#19-tool-calls-longer-than-five-minutes) | not met in 0.47.1 | `box_run` returns after 270 s, and a command still running goes on as a job for `box_job`; a Windows command in the desktop session, which has no job, is stopped (#486, #414) |
| [Move large files through the file API](#20-move-large-files-through-the-file-api) | not met in 0.47.1 | `box_copy` moves a file over 16 MiB through bb-box's own worker on the machine that holds it, which needs that machine connected to BB (#492) |
| [Stop a plugin's machine workers after its tool calls](#21-stop-a-plugins-machine-workers-after-its-tool-calls) | not met | a command in a Docker box on a BB machine loses its box first at a deploy, so `box_run` waits up to 10 s to see that bb-box is stopping before it names the job (#415) |
| [Remove a machine whose host is gone](#22-remove-a-machine-whose-host-is-gone) | met in 0.47.1; bb-box does not use it yet | a Windows box's machine stays in BB's list as "removing" when the box goes before BB has torn down the threads' environments on it, so bb-box waits up to 2 minutes for BB's removal before it releases a Windows box (#539) |
| [Install commands for the machine's OS](#23-install-commands-for-the-machines-os) | not met | BB's install action for Cursor's CLI on a Windows machine is a bash script, which Windows cannot run (#561) |
| [End a thread's processes before removing its worktree on Windows](#24-end-a-threads-processes-before-removing-its-worktree-on-windows) | not met | bb-box ends the processes working in BB's worktrees in a Windows box before it asks BB to remove the box's machine, or BB's teardown fails with EBUSY and the machine stays "removing" (#539) |
| [Keep the server's event loop free](#25-keep-the-servers-event-loop-free) | not met in 0.47.1 | BB's server stops for up to 1.2 s, 6 to 20 times a minute, and every desktop's frames and input wait it out, so a drag lags by up to a second and a video viewer loses frames |
| [Say what uninstalling a plugin keeps](#26-say-what-uninstalling-a-plugin-keeps) | not met in 0.47.1 | after an uninstall in BB's settings and a fresh install, bb-box came back with its old box records and its Docker backend on, though the dialog says it deletes the plugin's settings |
| [Start a Windows machine's helpers without a window](#27-start-a-windows-machines-helpers-without-a-window) | not met | on a Windows box, Keep Awake's PowerShell opens a window over the desktop each time BB's daemon starts, and after a boot BB's daemon opens one of its own, which take the focus and show in box_record's clips |
| [Refresh a machine's processors and memory when they change](#28-refresh-a-machines-processors-and-memory-when-they-change) | not met | after a live resize (061), BB keeps a machine's old processor count, and its automatic thread limit with it, until BB's daemon there restarts; bb-box restarts it when no thread works on the machine and no BB terminal is open there, and otherwise says how to set the limit by hand |
| [Start one daemon however often it is started](#29-start-one-daemon-however-often-it-is-started) | not met | two starts of BB's daemon at once, such as its logon entry's and a reconnect's after a boot, can leave two supervisors running; bb-box waits for BB's own start after a boot before it reconnects a Windows box (#917) |
| [Serve a plugin's WebSocket route off the server's loop](#30-serve-a-plugins-websocket-route-off-the-servers-loop) | not met | every desktop's frames and input run on BB's server's event loop, so whatever holds that loop, BB's or a plugin's, holds them |
| [Load a plugin's new version before unloading the old](#31-load-a-plugins-new-version-before-unloading-the-old) | not met | a plugin has no tools while its old version's dispose hooks run, so bb-box waits only 5 s for running commands at a deploy, and stops longer ones, which go on as jobs |
| [Give live agent sessions a plugin's tools back after it reloads](#32-give-live-agent-sessions-a-plugins-tools-back-after-it-reloads) | not met | after bb-box reloaded, running Claude Code sessions lost its tools until their agent runtime restarted, or for about an hour |
| [Install BB's app on Windows in seconds](#33-install-bbs-app-on-windows-in-seconds) | not met | BB's installer takes 42 to 88 s on a Windows box, most of it npm installing bb-app; bb-box's Windows images pre-install the server's build, which helps until the server's next build (#916) |
| [Keep one plugin's stylesheet from slowing another's panel](#34-keep-one-plugins-stylesheet-from-slowing-anothers-panel) | not met | a terminal in bb-box's panel took about 2.2 s to draw a prompt, as the shell-tasks plugin's stylesheet made each character's measurement about 100 times slower; bb-box is moving its terminals to xterm's WebGL renderer |
| [Say what a machine needs before installing](#35-say-what-a-machine-needs-before-installing) | not met | on a fresh Ubuntu server, BB's machine installer stopped with "sh: node: not found" and its usage, and the guide for a cloud Docker host lists Node.js 22 as a step of its own |
| [Let a reloaded plugin's old instance go](#36-let-a-reloaded-plugins-old-instance-go) | not met in 0.47.1 | each update of bb-box to new code keeps the old version's code in BB's server, about 5 MiB of heap and 4 MiB outside it, and each reload of the same code keeps the old instance, about 0.6 MiB |
| [Leave a modified click on a panel's link to the browser](#37-leave-a-modified-click-on-a-panels-link-to-the-browser) | not met in 0.48.0 | each link on a box's page stops the click going further when Ctrl or Command is held, so the browser opens the new tab |
| [Say who answered a plugin's form](#38-say-who-answered-a-plugins-form) | not met in 0.6.15 | a restore an agent asks for through a form (070) is recorded as "a yes given in the thread", as the asking agent can answer the form itself with `bb thread interactions respond --self`, which 070's unit 5 measured |
| [Let a plugin hold a machine against Send now](#39-let-a-plugin-hold-a-machine-against-send-now) | not met in 0.6.15 | restores of boxes threads run on stay off (070's G17), as "Send now" can start a turn between bb-box's last check and its stop |

## 1. BB's host app on Windows

**Status in BB 0.45.0: partly met.** BB 0.45.0 has a Windows host app:
`bb-app` lists `win32`, and a Windows machine enrols with `install.ps1`, a
Node installer that starts the daemon at sign-in from the user's `Run` key, so
in the desktop session (`bb guide machines`). Asks 1 to 3 are met. The SDK's
`MachineBootstrapRequest` still names no OS, and ask 4 is not met: #539's
trial found that a provider's machine cannot enrol on Windows (below), so
Windows boxes join BB as manual machines.

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
   OS, so a provider's executor can run PowerShell. Or
   `hosts.experimental_getEnrollmentCommand` giving a provider's machine its
   enrolment command with its Windows form, `windowsCommand`, as it gives a
   manual machine's.

**What #539's trial found, in BB 0.45.0.**

- `bootstrap` asks a provider's executor to run
  `sh -c <script> bb-machine-install <server>/install.sh`, with the bundle on
  stdin for `--bootstrap-env BB_ENROLLMENT`, whatever the machine's OS.
- `hosts.experimental_getEnrollmentCommand` gives no command for a
  provider's machine, before `bootstrap` or during it.
- `install.ps1` serves only a manual enrolment's `X-BB-Enrollment` header: a
  provider's bundle, which carries its credential for `--bootstrap-env`, gets
  "This installer needs an enrollment command".

**Until then.** A Windows box enrols as a machine of BB's manual provider,
whose enrolment command has a Windows form, unless the Proxmox QEMU or Tart
backend's "Windows boxes as BB machines" switch is set off (#539). bb-box
owns that machine itself: its release removes the machine once BB has, a
failed enrolment removes it, and the sweep removes any whose box is gone.
Its commands take the thread's Git credentials and machine variables, and
child threads run on it, on an agent CLI in its image. BB's provider hooks do
not reach such a machine, so BB removing it does not release the box, and
"New box" refuses Windows kinds. When ask 4 is met, Windows boxes can be
bb-box's provider machines like the rest, and the switch can go.

We tried BB's Linux host app in WSL2 inside a Windows box as a stopgap
(#174), and chose not to build it. A Windows command could read GH_TOKEN,
the git identity and machine variables from a BB daemon in WSL, through
`wsl.exe`, in 0.1 s. A stop and start, which hibernates the box, kept WSL
running. But on a windows-desktop box (4 cores, 8 GiB), measured on
1 October 2026, each box would pay:

- about 1.1 GB of memory while WSL runs, before BB's daemon: free memory
  was 4.6 GB, against 5.6 to 5.7 GB without WSL
- about 3 s on each boot: SSH answered 6.0 s after the kernel started,
  against 3.1 to 3.6 s without WSL
- about 3 GB more in the template: 1.2 GB for WSL and 1.4 to 1.9 GB for
  the Linux distribution
- a startup task and `.wslconfig` with both idle timeouts off, because WSL
  otherwise stops the distribution, and BB's daemon with it, within 10 s of
  the last `wsl.exe`

A thread started on such a box would also run in Linux, not Windows:

- BB would list a Linux machine beside each Windows box
- processes BB's daemon starts could run Windows programs only by full path,
  because their PATH has no Windows folders
- files across the boundary are slow: `git status` on 5,000 files took 28 to
  58 s on the other side's files, against under 1 s on each side's own

## 2. Send backlog on plugin WebSockets

**Status in BB 0.47.1: not met.** SDK 0.6.79's plugin WebSocket has `send`,
`close` and `readyState`, and still neither `bufferedAmount` nor a `send` that
returns a promise.

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

**Status in BB 0.45.0: not met.** The 0.45.0 daemon still reads
`install-daemon.pid` as a bare PID, with no boot ID, and takes over its lock
only once the lock is stale by age. The guide says nothing new.

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

**Status in BB 0.45.0: not met.** `bb plugin install` keeps a plugin's state
only when it moves from one local path to another, and `bb plugin update`
takes no ref.

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

In BB's desktop app 0.46.0, on 11 October 2026, **Install from source** in
Installed plugins with the same repository on another branch said nothing
and kept the old branch. Only **Uninstall** and a fresh install moved it.

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

**Status in BB 0.45.0: not met.** Boxes made on 7 October enrolled in 9.0 to
13.2 s, as `box_status` gives it, not under 2 s.

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

**Status in BB 0.45.0: not met.** SDK 0.6.15 has no way to find a machine by
its key.

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

**Status in BB 0.45.0: not met.** SDK 0.6.15 has no stream to an address on a
machine.

**What bb-box needs.** To drive a Mac that is already a BB machine without
SSH. The Tart backend runs `tart` on a Mac host, and reaches each VM through
it, since the VMs sit on the Mac's own NAT: commands over SSH with the Mac as
the jump host, and the desktop through Tart's VNC server on the Mac's
loopback. Today all three need SSH from the BB server to the Mac: a host user
with Remote Login, bb-box's key in its `authorized_keys`, and the Mac's host
key pinned in bb-box's settings. When the Mac runs BB's host daemon, BB
already has an authenticated connection to it.

The same holds for a Docker host that is a BB machine, such as a developer's
PC with Docker in WSL
([042](decisions/042-a-docker-host-can-be-a-bb-machine.md)). bb-box needs
Docker's API there, which is a unix socket or a named pipe, as a byte
stream from BB's server.

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
- Emulating a stream with calls and signals carried 0.12 to 1.1 MiB/s,
  measured on 1 October 2026.

**What we ask.** A way for a plugin's server side to open a two-way byte
stream with backpressure to an address as a machine sees it: a TCP address,
a unix socket or a named pipe. For example
`bb.hosts.experimental_connect({ hostId, host, port, signal })`, or with
`path` in place of `host` and `port`, returning a `ReadableStream` and a
`WritableStream`, and allowed only to addresses the host entry's machine
can reach. It could be limited to the loopback and private ranges, or to
what a plugin's host entry allows. A stream that the plugin's host entry
answers itself, for example with a handler that is given the stream, would
serve as well.

**What it would remove.** For a Mac that is a BB machine, all of bb-box's
SSH to the Mac: the host user's Remote Login, bb-box's key on the Mac and
its pinned host key. `tart` would run through the host entry; the VNC route
would be a stream to `127.0.0.1:<port>` on the Mac; each VM's SSH would be a
stream to `<VM address>:22` from the Mac, so the VMs need no jump host. The
VMs' own SSH, with bb-box's key in the image, would stay, until the VMs
enrol and bb-box can run commands through BB too.

For a Docker host that is a BB machine, it would remove bb-box's relay: the
route with `auth: "none"`, the one-time secret, the lease the worker holds,
and the flow control bb-box does itself.

**Until then.** The Tart backend reaches Macs over SSH, which is also the
general path for Macs that do not run BB. For Docker on a BB machine, the
machine's worker opens a WebSocket out to a route of bb-box's, with a
one-time secret that a host call gives it, and carries Docker's API over it
(042).

## 8. Give a machine's own commands its variables

**Status in BB 0.45.0: not met.** Neither the guide nor SDK 0.6.15 gives a
machine's user the variables a thread has there.

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
- The daemon holds the current values in memory. BB's server sends it the
  variables set for all projects, with GH_TOKEN and the git identity, when
  it connects and whenever BB's settings change
  (`machine-environment.replace`, checked in BB's source of September
  2026). These are what the daemon gives the processes it starts.
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

The daemon already holds the values, so this only asks it to let the
machine's user read what it holds, and to keep that current when the
server sends a change. Giving them to the daemon's own process would not
do: a process's environment is fixed when it starts, so the daemon would
need a restart to pass on a changed token or variable.

**What it would remove.**

- bb-box's host entry, whose worker keeps a `sleep` with the variables on
  each enrolled box.
- On Linux, bb-box's scan of `/proc/<pid>/environ` for the processes
  below the daemon, which picks the newest with the most variables.
- On macOS, bb-box's parsing of `ps -E`. It prints a newline as `\012`
  but leaves a backslash as it is, so it cannot read exactly a value that
  holds a backslash and three digits, or a space followed by a name and
  `=`.
- On Windows, which has neither `/proc` nor `ps -E`, bb-box's reader of
  each process's environment block through its PEB, at offsets Windows
  does not document, compiled in each box.
- bb-box's dependence on where BB installs its daemon
  (`host-daemon/dist/daemon-bundle`), which a BB release can change.

**Until then.** bb-box's host entry keeps a `sleep` with the variables on
each enrolled box, since BB's own workers come and go
(`src/host/access.ts`). Linux boxes read the environment of the
processes below the daemon from `/proc`, and macOS boxes parse `ps -E`,
choosing the process the same way (`src/core/in-box.ts`). Windows boxes,
on trial, read each process's environment block through its PEB, with a
small C# reader that the first command compiles in the box, and their held
process is Node, as Windows has no `sleep` (`src/core/windows-access.ts`,
#560).

## 9. Open BB's terminal on a machine from a plugin

**Status in BB 0.47.1: met, experimental.** SDK 0.6.79's `terminals.create`
makes a terminal session scoped to a thread, an environment or a directory on a
host, and the app's `navigate.experimental_openTerminal` shows it in the
surface's own BB terminal panel. bb-box has not moved its terminal to it yet.

**What bb-box needs.** A terminal in a box, one click from the Box panel.
A box that is a BB machine already has BB's own terminal sessions on it:
BB's app opens a terminal tab on a machine, keeps the session across
reloads, lists it with the thread's others, and streams it over its own
WebSocket. bb-box wants that tab, opened on the box's machine, from its
panel.

**What BB does now.** Checked in BB 0.44.0 and the plugin SDK 0.5.29:

- The SDK's `terminals` area creates, lists, resizes, writes to and closes
  terminal sessions on a host (`scope: { kind: "host_path", hostId }`), and
  reads their output by polling `output({ sinceSeq })`. There is no stream,
  and nothing to put a session in BB's terminal tab: `useBbNavigate` opens
  thread panels, plugin panels and URLs, and BB's terminal tab is none of
  those.
- BB's app streams its own terminals over `/ws/terminals/<id>`, which is
  internal.

**What we ask.** A navigation call that opens BB's terminal tab on a
machine, for example `navigate.openTerminal({ hostId, cwd?, title? })`,
returning the session so the plugin can close it with the box. A second
best is a WebSocket for a session the SDK created, so a plugin's tab can
stream it instead of polling.

**Until then.** bb-box's terminal tab is its own: a shell in the box over
the box's transport, with its PTY on BB's server, streamed to xterm.js
over a plugin WebSocket (`src/plugin/terminal.ts`). It keeps the shell
while the tab is away, but not across a plugin restart, and it is not in
BB's terminal list.

## 10. Show machine-making environments where they can be seen

**Status in BB 0.45.0: not known.** Neither the guide nor the SDK says where
the new-thread screen lists environments, and this check did not look at BB's
UI.

**What bb-box needs.** "New box" in BB's new-thread screen
([033](decisions/033-a-thread-can-start-on-a-new-box.md)) where a user sees
it when they open the Environment picker.

**What BB does now.** Checked in the web app BB 0.44.0 serves:

- With three or more machines, the Environment picker uses its contextual
  menu. An environment that brings its own machine (a composition with a
  `machineProviderId`, such as BB's Modal sandbox or bb-box's "New box") is
  listed inside the Machines group, after every machine.
- That group is a scroll area capped at 12rem (`max-h-48`). A machine row is
  about 26 px, so with six machines the group is full, and the first such
  environment starts at its bottom edge. Users see the machines, the "On
  <machine>" section and "Reuse existing", and not "New box" (the operator,
  1 October 2026: "Where is the new box?").
- Plugin machines in that list push it further down: every bb-box box that
  is a BB machine, and each spare box
  ([032](decisions/032-spare-boxes-are-enrolled-ahead.md)) until BB can hide
  machines from placement ("Possible later" below).
- The picker's search shows it: typing "new" filters out the machines, and
  environments that bring their own machine are not filtered.

**What we ask.** List environments that bring their own machine in a group
of their own, outside the scrolling Machines list, for example "New
machine" under the machines, or before them.

**Until then.** The operator scrolls the Machines list to its end, or types
"new" in the picker's search. The skill says so.

## 11. Give a machine a project's variables without a thread there

**Status in BB 0.45.0: not met.** SDK 0.6.15's host updates take no projects.

**What bb-box needs.** A box has everything its thread has (#109),
including the variables set for the thread's project. Most boxes serve a
thread that runs on another machine, so no thread of the project runs on
the box.

**What BB does now.** Checked in BB 0.44.0 and the plugin SDK 0.5.29,
with a project variable set for a test project only:

- BB's server sends a machine's daemon the variables set for all projects
  (`machine-environment.replace`). It sends a project's variables only in
  the request that starts a thread of the project on that machine
  (`contributedEnv`), and the daemon gives them to that thread's agent
  alone, not to its own workers.
- In a box acquired by a thread on another machine, the variable was unset
  in `box_run`, in a BB terminal on the box, and in bb-box's terminal.
- With a thread of the project on the box, its agent had the variable.
  bb-box now reads it from there (`src/core/in-box.ts`).
- No API makes the daemon hold a project's variables without a thread, an
  environment or a terminal of that project on the machine.

**What we ask.** A way for a plugin to tell BB that a machine serves a
project, for example `hosts.update({ hostId, projectIds })`, so that BB
sends the machine those projects' variables as it sends the ones for every
project. With request 8, commands in the box would then read them from
BB's daemon. The values stay on machines BB gives them to, and no plugin
sees them.

**Until then.** A box has its project's variables only while a thread of
the project runs on it, as with `box_thread` or "New box". The skill says
so.

## 12. Make a plugin's host call quick

**Status in BB 0.45.0: not met.** Neither the guide nor SDK 0.6.15 changes how
a host call starts. It was not timed again.

**What bb-box needs.** Calls to its host entry that take about as long as
BB's own requests to a machine. bb-box calls its host entry to keep a
process with the thread's access on each enrolled box (request 8): before
a command, when its last call there is more than 30 s old. It also calls
it to open the relay to a Docker host that is a BB machine
([042](decisions/042-a-docker-host-can-be-a-bb-machine.md)).

**What BB does now.** Measured on 1 October 2026, with a throwaway plugin
whose host entry does nothing, on a box that is a BB machine:

- A call from the plugin's server side took 424 ms at the median and
  630 ms at the 90th percentile, 2 ms of it in the machine.
- A plugin CLI command that makes one call took about 690 ms, against about
  290 ms for one that calls nothing. `bb file read` on the same box took
  about 200 ms, CLI included.

So each call adds about 400 ms on BB's side. Where the time goes is not
known yet.

**What we ask.** A plugin's host call that adds no more than BB's own
requests to a machine, which take 0.1 to 0.2 s.

**What it would remove.** About 0.4 s from a box's first command after
it enrols or after a reload, and from each opening of a Docker relay.

**Until then.** bb-box calls its host entry as little as it can: for a
box's access at most every 30 s, in the background once a call has worked,
and once each time a relay opens.
Commands themselves go through SSH, `docker exec` or the relay.

## 13. Mark a machine offline when it stops checking in

**Status in BB 0.45.0: not met.** `bb host list` still gives `lastSeenAt`, and
the guide names no time after which BB marks a silent machine offline. bb-box
keeps its rule of 60 s.

**What bb-box needs.** BB's word on whether a machine is connected, kept up
to date. bb-box asks it before it places a box on a Docker host that is a BB
machine, and before it opens the relay there, so it can say at once when the
machine has gone ([042](decisions/042-a-docker-host-can-be-a-bb-machine.md)).

**What BB does now.** Measured on 1 October 2026 (#233):

- Each machine's `lastSeenAt` moves on about every 5 s, idle or not.
- A Windows PC with its BB machine in WSL restarted, and said nothing as it
  went. BB showed it `connected` for 16 min 20 s after it last heard from
  it, until the connection timed out. That is about how long Linux takes to
  give up on a TCP connection whose data goes unanswered.
- Meanwhile each call to the machine waited for its own timeout, and failed.

**What we ask.** Mark a machine disconnected after a few missed check-ins,
for example after 15 to 30 s with no word.

**What it would remove.** bb-box's own rule, and up to 16 minutes in which
BB and its plugins take a machine that has gone as connected.

**Until then.** bb-box takes a machine that BB shows connected, but has not
heard from for 60 s, as offline.

## 14. Panel actions without a launcher row

**Status in BB 0.47.1: may be met, experimental; not tried.** SDK 0.6.79
replaces `threadPanelAction` with `experimental_tab`, whose registration takes
`availability: "action"` and a `useVisible` hook. Whether a tab `useVisible`
hides can still be opened by code, as bb-box needs, is not yet tried.

**What bb-box needs.** A thread panel action that a panel can open, but that
BB draws no launcher row for: a tab a plugin reaches by code, not one a
person starts cold from the panel's launcher. bb-box has three thread panel
actions: Box, Desktop and Terminal. Box is the one to start from; Desktop
and Terminal only make sense for a particular box, opened from a row in Box.
As launcher rows of their own they invite a cold start with no box chosen.

**What BB does now.**

- `app.slots.threadPanelAction({ id, title, component })` registers an action,
  and every registered action is a launcher row. `PluginThreadPanelActionRegistration`
  has no field to hide the row (checked against plugin SDK 219 in BB 0.44.0).
- A panel opens another with `navigate.openThreadPanel({ actionId, title, params })`,
  so an action can be opened by code whether or not a person could start it
  from the launcher.
- A panel action's component gets `{ threadId, openPanel }` and no RPC, so a
  bare tab cannot itself read the thread's boxes to decide what to show.

**What we ask.** A `launcher: false` (or `hidden: true`) field on
`threadPanelAction`, so an action registers and opens by code but shows no
launcher row. Desktop and Terminal would set it; Box would not.

**Until then.** Desktop and Terminal keep their launcher rows, and each is a
shortcut rather than a cold start. Opened bare, Desktop opens the thread's
one desktop box straight away, offers a chooser when there are several, and
when there is none shows "No desktop box" with a button to the Box panel;
Terminal does the same for the thread's boxes with a terminal. The logic
lives in each tab's component, since a panel action gets no RPC in its
context and `run()` none either.

## 15. Give a plugin's CLI the caller's files

**Status in BB 0.45.0: documented, not shipped.** `bb guide plugins` says a
plugin command called with `--stdin` gets the caller's standard input, up to
256 KiB of text, as `--input-text`. BB 0.45.0's CLI does not do it, nor does
the nightly 0.45.1-nightly.37496027885.1: both rewrite only
`--<flag>-stdin`, which takes one line of at most 16 KiB, and pass a bare
`--stdin` on to the command ("unknown option '--stdin'"). bb-box takes image
scripts and configuration files this way once the CLI does (#535).

**What bb-box needs.** A plugin CLI command that reads a file where `bb` runs:
a project image's script for `bb box image set --script-file`
([049](decisions/049-a-project-image-is-a-script-on-the-standard-image-and-images-are-rebuilt-when-stale.md)),
or a configuration for `bb box config apply`.

**What BB does now.** A plugin's CLI command runs in the plugin, on BB's
server. Its context is `{ cwd, threadId, projectId, signal }` (plugin SDK
0.5.29), with no standard input and no way to read the caller's files. A path
resolves against `cwd` on the server, so from an execution machine the file
is not found ("Cannot read /tmp/…: ENOENT").

**What we ask.** One of:

- standard input for a command, as `bb box image set --script-file -` would read it; or
- a declared file option, such as `{ type: "file" }`, whose contents the `bb` CLI reads where it runs and sends with the call.

**Until then.** The commands say the file is read on the machine BB's
server runs on. Agents use `box_image_set` and `box_image_try`, which take
the text, and `bb box image try <name>` tries an image already set, with no
file.

## 16. Alert dialogs that do not fly in from the corner

**Status in BB 0.45.0: not met.** The 0.45.0 registry's `alert-dialog` still
has the four slide classes, and no `motion-reduce` classes.

**What bb-box needs.** Its confirms (Release, Stop anyway, Remove) to move
as BB's own dialogs do, so that a plugin's dialog is not the odd one out.
The operator's note of 3 October 2026 on the release modal: "the way it
animates in is weird".

**What BB does now.** shared-ui's `alert-dialog.tsx`, and the plugin
registry's copy that every plugin scaffolds from, give `AlertDialogContent`
shadcn's `zoom-in-95` plus `slide-in-from-left-1/2` and
`slide-in-from-top-[48%]` on top of the `-50%` translate centring. The two
slides were a Tailwind v3 workaround for that centring, when translate was
part of `transform`. On Tailwind v4, where `translate` is its own property,
they stack on it, and the box flies in diagonally from the top left, and
out the same way. BB's own confirms (ThreadDeleteDialog, ConfirmDeleteDialog
and the rest) use shared-ui's `DialogContent`, which has no slide: a fade
and a 95% zoom from the centre over 200 ms, the same on close.

**What we ask.** Give `AlertDialogContent` in shared-ui and in the registry
`DialogContent`'s motion: drop the four slide classes, keep
`duration-200`, the fade and the 95% zoom, and add
`motion-reduce:data-[state=open]:animate-none` and its closed twin so the
dialog just appears and disappears under `prefers-reduced-motion`.

**Until then.** bb-box's copy carries that motion (#453),
with a note in `components/ui/alert-dialog.tsx` that avoids spelling the
dropped class names, since Tailwind scans comments and would emit them.

## 17. Carry providers' own config to every machine

**Status in BB 0.45.0: not met.** The guide names no provider config that BB
carries to machines.

**What bb-box needs.** A provider that BB runs on a box to find the same
config there as on the machine where the operator set it up. pi reads its
custom providers and models from `~/.pi/agent/models.json`, and its defaults
from `~/.pi/agent/settings.json`, on the machine it runs on. A box has
neither, so a pi thread on a box lacks the providers and models the operator
added on their own machine, and cannot use them.

**What BB does now.** It carries a thread's Git credentials and BB's machine
variables to every machine it runs a thread on, but not a provider's own
config files, so each machine needs them copied by hand.

**What we ask.** Carry each provider's own config to every machine BB runs the
provider on, as BB carries Git credentials and machine variables: for pi,
`models.json` and `settings.json`, and the like for other providers.
`models.json` can hold API keys, so BB keeps them as secrets and never shows
them.

**Until then.** bb-box's general settings have "Files for every box": paths
under the box user's home and their contents, kept as secrets, which bb-box
writes into every Linux and macOS box as it joins BB, and into running boxes
when they change (#455). Windows boxes, and machines that are not boxes, still
need the files copied by hand.

## 18. A nav page's title-bar action beside its title

**Status in BB 0.45.0: not met.** SDK 0.6.15's nav panel has no slot beside
its title.

**What bb-box needs.** The Boxes page's settings gear in BB's title bar
right after the page's title, "Boxes", small and dim like the title's own
icon (the operator's note of 5 October 2026).

**What BB does now.** `PluginNavPanelRegistration.headerContent` (plugin
SDK 0.5.29) renders a plugin's component in the title bar, but on its right:
`PluginPanelHeaderActions` puts it before the pane's own actions and the
right-panel toggle, while `PluginPanelHeaderCenter` owns the icon and title
on the left and takes nothing from the plugin.

**What we ask.** A slot beside the title, such as `titleAccessory`: a small
component rendered right after the title in `PluginPanelHeaderCenter`,
contained as `headerContent` is, for an icon button or a short status.

**Until then.** The gear is bb-box's `headerContent`, at the bar's right,
before BB's buttons.

## 19. Tool calls longer than five minutes

**Status in BB 0.47.1: not met.** SDK 0.6.79's `registerTool` still takes no
time limit and no way to keep a call open. It was not timed again.

**What bb-box needs.** A tool call that runs as long as its tool says, such as
`box_run` with `timeout_seconds` up to an hour, or else to be told when BB
gives up on one.

**What BB does now.** An agent's call to a plugin tool ends after about 300 s
with only "terminated", the message of an HTTP response whose body stalled for
five minutes, Node's default. The plugin's call is not aborted: its signal
stays live and the command goes on, so the plugin cannot say what happened,
and its eventual answer goes nowhere (measured on 7 October 2026 with a 330 s
`box_run` on a Linux box, and in #486 on Windows).

**What we ask.** Keep a tool call's request open while the plugin works, by
sending keep-alive bytes or progress, up to a stated limit; or abort the
plugin's signal with a reason when BB ends the call, and document the limit.

**Until then.** `box_run` returns after 270 s. A command still running then
goes on in its box as a job, and the answer names it with its output so far
for `box_job`; on Windows, the job starts outside the SSH session (#414). A
Windows command in the desktop session, which has no job, is stopped then,
with its output so far.

## 20. Move large files through the file API

**Status in BB 0.47.1: not met.** SDK 0.6.79's `files.read` and `files.write`
still move a whole file as one string, with no offset, length or append.

**What bb-box needs.** To copy a file of any size between a thread's workspace
or storage folder and a box, as `box_copy` does for small ones: installers,
app bundles and build artifacts are often hundreds of megabytes, and trying a
build on a box is a common reason for one (#485).

**What BB does now.** The plugin SDK's `files.read` returns a whole file as
base64 in one answer and `files.write` takes one the same way, with no offset,
length or append. BB refuses a file over 25 MB with HTTP 413: "File size ...
bytes exceeds the 25 MB limit".

**What we ask.** A way to move a large file in pieces: a ranged `files.read`
(offset and length) and a `files.write` that appends or writes at an offset,
or a stream in each direction. Either keeps memory flat on BB's server and the
machine.

**Until then.** `box_copy` moves up to 16 MiB through the file API, which
base64 keeps under the limit. A larger file streams through bb-box's own host
worker on the machine that holds it, over a WebSocket out to bb-box's route,
as the Docker relay does (042), with its SHA-256 checked at both ends (#492).
That needs the machine connected to BB and bb-box's host entry on it, so the
file API is still the better way when BB offers one.

## 21. Stop a plugin's machine workers after its tool calls

**Status in BB 0.45.0: not met.** Neither the guide nor SDK 0.6.15 says that a
plugin's tool calls end before its machine workers stop.

**What bb-box needs.** At a deploy, its running tool calls to hear that bb-box
is stopping before the machines they work on stop answering, so a call can say
what goes on (#415).

**What BB does now.** It stops the plugin's worker on each BB machine first,
then aborts the plugin's tool calls with "plugin-disposed", then runs its
dispose hooks (#405). bb-box's relay to Docker on a BB machine runs in that
worker, so a `box_run` in a Docker box there fails at once, as if the box had
gone, while the command goes on in the box as a job.

**What we ask.** Abort a plugin's tool calls, and run its dispose hooks,
before stopping its workers on machines; or abort the calls with the same
reason as the workers stop.

**Until then.** A `box_run` whose box stops answering waits up to 10 s to see
whether bb-box is stopping. If it is, the answer names the job, which
`box_job` reads once bb-box is back; if not, it fails as before.

## 22. Remove a machine whose host is gone

**Status in BB 0.47.1: met.** SDK 0.6.79's `hosts.delete` takes `force`, where
0.6.15's took none. bb-box has not moved to it yet, and still waits up to 2
minutes for BB's removal before it releases a Windows box.

**What bb-box needs.** To remove a Windows box's machine, made with BB's
manual provider (#539), when the box goes, even when the box has gone first,
so that no machine is left in BB's list.

**What BB does now.** Before it removes a machine, BB tears down each
thread's environment on it, such as a worktree, and each teardown needs the
machine connected. `hosts.delete` of a manual machine returns before then. If
the machine has gone by then, each teardown fails with "Host is not
connected", BB tries it again, and the machine stays in BB's list as
"removing", disconnected, for good. Removing the machine again does not help,
nor does archiving the environment's thread and asking for the environment's
cleanup. There is no way to force an environment's teardown, or a machine's
removal, once its host is gone.

**What we ask.** A way to remove a machine whose host is gone, such as a
forced `hosts.delete` and `bb machine remove --force` that drop its
environments' teardowns. Or a teardown that gives up when its machine is
being removed and is not connected. A `hosts.delete` of a manual machine
that returns once BB has removed it would also help.

**Until then.** Once bb-box has asked BB to remove a Windows box's manual
machine, it waits up to 2 minutes for BB to finish before it releases the
box, and keeps its record of the machine until BB no longer has it. Its sweep
looks again, and it logs a machine BB has not removed in that time. One whose
box went first stays in BB's list.

## 23. Install commands for the machine's OS

**Status in BB 0.45.0: not met.** On a Windows machine, SDK 0.6.15's
`hosts.providerCliStatus` gives a bash command to install Cursor's CLI.

**What bb-box needs.** BB's install action for each provider's CLI in a form
the machine can run, so that a Windows box can get an agent CLI (#561).

**What BB does now.** `hosts.providerCliStatus` gives each provider's install
command for the machine. On a Windows machine, Claude Code's is PowerShell,
`irm https://claude.ai/install.ps1 | iex`, and Codex's and Pi's are
`npm.cmd install -g`. Cursor's is a bash script that runs `mktemp`, `curl`
and `bash`, which Windows cannot run.

**What we ask.** Cursor's install action in a Windows form on a Windows
machine, or none where BB has no Windows installer for it.

**Until then.** bb-box installs no agent CLI itself. Its Windows images are
to carry Claude Code, Codex and Pi (#450).

## 24. End a thread's processes before removing its worktree on Windows

**Status in BB 0.45.0: not met.**

**What bb-box needs.** BB to remove a Windows box's machine when the box
goes, with the worktrees of the threads that ran on it (#539).

**What BB does now.** Before it removes a machine, BB tears down each
thread's worktree on it. On Windows the teardown fails with "EBUSY: resource
busy or locked, rmdir" while the thread's agent, and the worker of BB's
daemon that runs it, still work in the worktree, as they do after the
thread's turn ends. Windows does not remove a folder a process works in, as
Linux does. BB tries again, but nothing ends those processes, so the machine
stays "removing" until its box is gone, and then for good (request 22).

**What we ask.** On Windows, end a thread's processes that work in its
worktree, the agent and its worker included, before tearing the worktree
down.

**Until then.** Before bb-box asks BB to remove a Windows box's machine, it
ends every process in the box whose working directory is in BB's worktrees,
and what those started, keeping BB's daemon and its other workers. It reads
each process's working directory from its PEB.

## 25. Keep the server's event loop free

**Status in BB 0.47.1: not met.** On a fresh BB 0.47.1 on a 4-core machine,
bb-box logged BB's server standing still for up to 778 ms, twice in two
minutes, while a desktop was open.

**What bb-box needs.** BB's server's event loop free of long synchronous
work. bb-box's desktop relays run on that loop, inside BB's server process,
so every desktop's frames and input wait while it is held.

**What BB does now.** On 10 October 2026, through BB's server, a desktop's
frames stood still for 300 to 700 ms, and once for 1.1 s, in pairs about
every 11 s, on VNC and video alike, while the box sent them evenly. bb-box's
loop watch counted 10 to 16 such stalls a minute, with almost no garbage
collection in them. A window dragged in video mode lagged 0.24 to 0.5 s at
the 95th percentile, and up to 0.9 s. After the 1.1 s stall, the relay
dropped 67 frames of a video viewer's to catch up. A CPU profile of the
server process over 20 s, with a desktop open, showed these busy spans:

- 1181 ms and 230 ms: `resolveGitCredentials` → `runGh` → `spawn`, from
  `resolveHostEnvironment`, `callPluginHostRpc` and
  `sweepProviderEnvironmentInSlot`. Spawning `gh` held the loop.
- 146 ms and 140 ms: `runPeriodicSweepJobs` → `sweepMachineLifecycles` →
  `get` and `_prepare`, its synchronous SQL.
- 166 ms: BB's microtask `dispatch`.

bb-box's own code had about 21 ms of its own in those 20 s.

On 22 October 2026, BB 0.46.0's server held 3.5 GB, and bb-box's loop watch
counted 6 to 20 stalls a minute, the longest 640 ms to 1142 ms, while agents
used desktops. A CPU profile over 60 s, from bb-box's `profile` RPC, found:

- Busy 33% of the time, with 37 spans of 100 ms or more.
- Busy time by whose code: BB 7098 ms (36%), garbage collection 6620 ms
  (33%), bb-box 3610 ms (18%), Node alone 1513 ms (8%), V8 and native code
  992 ms (5%), other plugins 30 ms.
- The five longest spans, 1023 ms to 1112 ms, all under BB's code: HTTP
  `dispatch` and `cors2`, `runMicrotasks`, and SQLite:
  `runTimedStatementOperation`, `runEventLoopWorkSync`, `db.transaction` and
  `sqliteTransaction`.
- Garbage collection: 11 major collections of 66 ms to 85 ms, 810 ms in
  all, with 1.3 GB of the heap in use, of which 790 MiB was old space.
  The process's other 2.2 GB is outside the JavaScript heap.

bb-box's share was spawning: each child process forked the 3.5 GB server,
holding the loop for about 49 ms, up to 124 ms, and bb-box started up to 62
a minute. bb-box now starts its commands from a small helper process, which
forks in about 0.1 ms, so that share is gone.

**What we ask.**
- Spawn `gh` off the main loop, or cache git credentials rather than
  resolving them on each host environment sweep and plugin host call.
- Run `sweepMachineLifecycles`' SQL in smaller pieces, or off the loop.
- Keep each SQLite transaction short, or run the database off the main
  loop: transactions held it for up to a second.
- Find what HTTP `dispatch` and `cors2` spend up to a second on per
  request, and the microtasks that follow them.
- Keep the heap smaller, so each major collection is shorter. A 3.5 GB
  server forks slowly too, which any plugin that spawns pays for.

**Until then.** Drags in a desktop lag in bursts, video or VNC. bb-box logs
each minute in which the loop stood still for 250 ms or more, and the
`profile` RPC names the code.

## 26. Say what uninstalling a plugin keeps

**Status in BB 0.47.1: not met.** `bb plugin remove --help` in 0.47.1 says it
deletes a plugin's settings, secrets and schedules, and still says nothing of its
storage.

**What bb-box needs.** An uninstall that does what its dialog says, or a
dialog that says what stays. A person who uninstalls bb-box to start again,
or to change its source ([4](#4-change-a-plugins-source-and-keep-its-state)),
should know whether its boxes' records and its configuration stay.

**What BB does now.** In BB's desktop app 0.46.0, on 11 October 2026, the
plugin's **Uninstall** asked: 'Uninstall "bb-box" and delete its managed
files, settings, secrets, and schedules?' After it, a fresh install of
bb-box from another branch still had its box records, so the Box panel
listed the old box, and still had its configuration, so Docker on the
machine was on. Both are in the plugin's storage, which the dialog does not
name. In BB 0.44.0, `bb plugin remove` and a fresh install started with
empty storage (see 4).

**What we ask.** Either of:

1. The dialog says the plugin's storage stays, and how to delete it.
2. The dialog offers to delete the storage too, and does so when asked.

**Until then.** The [setup guide](../setup/README.md#remove-bb-box) says to
release the boxes before removing bb-box. A box whose container went
meanwhile shows as Gone.

## 27. Start a Windows machine's helpers without a window

**Status in BB 0.46.0: not met.**

**What bb-box needs.** Nothing on a Windows box's desktop that the agent
or person did not open. Agents drive the desktop with computer use, and
`box_record` records it ([059](decisions/059-agents-record-their-desktop-box-with-box-record.md)).

**What BB does now.** On a Windows box enrolled as a BB machine, on 16
October 2026, BB's Keep Awake plugin starts `powershell.exe -NoProfile
-NonInteractive -Command ...` from its host worker in the desktop session.
It calls `SetThreadExecutionState`, then waits for the worker. BB starts it
without hiding its console, so it opens a window:

- With Windows Terminal as the default terminal, as Windows 11 has it, a
  Windows Terminal window titled "Windows PowerShell" opens over the
  desktop and takes the focus. Keys an agent sent to Notepad went to it.
  Closing it ends the PowerShell, and BB starts it again, with another
  window.
- With Windows Console Host as the default (the `DelegationConsole` and
  `DelegationTerminal` settings), an empty console window opens instead.
  So bb-box cannot avoid it by choosing the terminal.

A new window opens each time BB's daemon starts, such as when a box
resumes. bb-box's own helper in the same session, a Node process, opens
none.

After a cold boot BB's daemon opens a window of its own too (#917; BB
0.46.0, 22 October 2026). Its `HKCU` `Run` entry runs `powershell.exe
-WindowStyle Hidden` with `install-machine-windows.mjs --start`, which
starts `--run` through WMI with its window hidden. That starts the
supervisor, `bb-app.js host-daemon --supervise`, detached, so it has no
console. The supervisor then starts the daemon, `daemon-bundle.mjs`, with
`spawn` and no `windowsHide`, so Windows gives the daemon a new console,
and its window, titled "Windows PowerShell", stays on the desktop for as
long as the daemon runs. It does so with Windows Terminal or Windows
Console Host as the default, and with the `Run` entry itself started
through `conhost.exe --headless`. A process started hidden, as
`Start-Process -WindowStyle Hidden`, stays hidden with either default, so
the console host is not the cause.

Keep Awake's machine selection is "all" or a list of host IDs. An install
that keeps "all" cannot leave boxes out, and one that lists hosts must add
each new machine by hand, which does not suit boxes that come and go.

**What we ask.**

1. Start helper processes on Windows with their windows hidden: Node's
   `windowsHide: true`, or `CREATE_NO_WINDOW`. That includes the
   supervisor's start of the daemon, in `spawnLoggedProcess`.
2. Let a machine opt out of a plugin such as Keep Awake, so that a
   machine provider, such as bb-box, can leave its boxes out whatever a
   plugin's selection says.

**Until then.** A box does not need Keep Awake: its image turns sleep,
hibernation and the screen's timeout off. Keep Awake's selection can leave
boxes out only by listing every other machine. After a Windows box enrols,
and after each reconnect, bb-box hides the windows of the consoles of BB's
processes once: it finds each from the process, not by title, and in Windows
Terminal hides Terminal's own window, as hiding the console's pseudo window
only minimises it. It minimises a window before it hides it, so the keyboard
goes to the desktop: hidden alone, the window kept it, and a Ctrl+C could
reach BB's daemon (#916). A console BB opens later, as when its daemon
restarts by itself, stays until the next reconnect.

## 28. Refresh a machine's processors and memory when they change

**Status in BB 0.46.0: not met.**

**What bb-box needs.** A box can now be resized while it runs
([061](decisions/061-a-box-can-be-resized-live-where-its-backend-can-and-restarted-only-when-asked.md)):
on Proxmox LXC and Docker its cores and memory change in seconds, with
everything in it still running. BB's automatic thread limit for a machine
is one thread per processor, so it should follow.

**What BB does now.** BB reads a machine's processor count when its daemon
connects, and never again while it stays connected. Checked on 19 October
2026, on a box enrolled as a BB machine with a thread working on it:

- After a live resize from 2 to 4 cores, `nproc` in the box said 4 within
  15 s, and `bb concurrency-limit status` still said "auto, 2 (2
  processors, connected)" minutes later. The owner found the same on one
  of their machines after a resize to 8 cores: it stayed limited to 4
  threads until its agent set the limit by hand.
- `bb machine reconnect` refuses a machine that is connected: "HTTP 409:
  Machine is connected and doesn't need reconnecting".
- Restarting BB's daemon (its systemd user service) makes BB count the new
  processors within seconds. But the service's `KillMode` is
  `control-group`, and a thread's agent runs as the daemon's child, so a
  restart ends any turn running there, and any BB terminal open there,
  whose shells are the daemon's children too. BB lists a machine's
  terminals, each thread's and each environment's apart, so bb-box asks
  for all three.

**What we ask.**

1. Refresh a connected machine's processors and memory when they change,
   such as by having the daemon read them again every few minutes, or
   when asked.
2. Or give plugins a way to say a machine's size changed, such as
   `hosts.refresh(hostId)`, which has the daemon read it again without
   ending what runs there.
3. Either way, let the automatic thread limit follow the new count. A
   limit a person set stays as it is.

**Until then.** After a live resize that changes a BB machine's cores,
bb-box restarts BB's daemon there only when no thread is working on the
machine and no BB terminal is open there. Otherwise its answer says that BB keeps the old count and thread
limit until the machine's daemon restarts, and how to set the limit by hand
(`bb concurrency-limit host <name> <n>`, then `auto` once BB counts the new
cores). bb-box never changes a limit itself.

## 29. Start one daemon however often it is started

**Status in BB 0.46.0: not met.**

**What bb-box needs.** One BB daemon supervisor on a machine, however many
times something asks for it to start.

**What BB does now.** On Windows, `install-machine-windows.mjs --start`
asks the daemon's port whether a daemon runs, and starts one when none
answers. Two starts at once both find none, and both start a supervisor.
After a cold boot of a Windows box, BB's `Run` entry starts the daemon at
logon, and a reconnect of the machine, such as bb-box's after it started
the box, can come within seconds of it. A box was seen with two
supervisors started 4 s apart (#917). A start made once the first daemon
answers says "The host daemon is already running", and starts nothing.

**What we ask.** Make the start single-instance: take a lock, such as a
named mutex or the data folder's lock file, before checking for a daemon,
and hold it until the new daemon answers or fails. Or have a supervisor
exit when another holds its machine's lock.

**Until then.** Before it runs BB's reconnect command on a Windows box,
bb-box asks the box whether BB's daemon is on its way: its supervisor or
installer runs, or BB's `Run` entry for the machine is there and the
logon is under 2 minutes old. It then waits up to 90 s for BB to show the
machine connected, and reconnects only if it does not (#917).

## 30. Serve a plugin's WebSocket route off the server's loop

**Status in BB 0.46.0: not met.**

**What bb-box needs.** Its desktop relays off BB's server's event loop.
Each relay passes a desktop's frames to its viewers and their input to the
box, and must not wait on anything else.

**What BB does now.** `bb.http.experimental_websocket` calls a plugin's
handlers on the server's main loop. A plugin cannot hand the socket to a
worker thread or another process. So a stall of that loop, from BB, from
any plugin or from garbage collection, holds every desktop's frames and
input (request 25). Profiled on 22 October 2026, the loop stood still for up
to 1.1 s, 6 to 20 times a minute.

**What we ask.** A WebSocket route that BB serves in a worker thread, or
hands to a process of the plugin's own, still behind BB's auth. Or a way to
pass an accepted socket to a plugin's worker.

**Until then.** bb-box keeps its own work on the loop small, logs each
minute in which the loop stood still, and can profile it. The only way off
the loop would be a port of bb-box's own, which each install would have to
expose.

## 31. Load a plugin's new version before unloading the old

**Status in BB 0.46.0: not met.**

**What bb-box needs.** Its tools available while it is updated or reloaded.

**What BB does now.** BB disposes of the old version, runs its dispose
hooks, and only then loads the new one. Agents get no tools from the plugin
in between. On 22 October 2026, a probe called `bb box kinds` every 2 s
across three reloads of bb-box:

| Reload | The CLI said "unknown command 'box'" | bb-box's lines |
| --- | --- | --- |
| 03:09:57 UTC | for 60 s, until 03:10:57 | none: before these lines were logged |
| 03:12:08 UTC | for 63 s, until 03:13:11 | "started in 0.02 s" at 03:13:08 |
| 03:14:32 UTC | not at all | "stopped in 0.43 s", then "started in 0.02 s; BB began it 0.08 s after the last version stopped" |

The first two reloads waited on bb-box's dispose hook, which then waited up
to 60 s for running `box_run` commands to end. BB's own test host
(`createFakePluginHost`'s `reload`) does the opposite: it loads the new
version, then disposes of the old.

**What we ask.** Load and register the new version, then dispose of the old,
as the test host does. Or say in the guide that a plugin's dispose time is
time without its tools.

**Until then.** bb-box waits only 5 s for running commands at a reload. A
command still running then goes on in its box as a job, and the agent gets
the job's ID for `box_job`.

## 32. Give live agent sessions a plugin's tools back after it reloads

**Status in BB 0.46.0: not met.**

**What bb-box needs.** An agent that is working keeps bb-box's tools across
a reload of bb-box.

**What BB does now.** On 22 October 2026, bb-box reloaded several times
between 03:23 and about 03:35 UTC. Claude Code sessions that were running
then lost bb-box's tools. Their notice said the
`box_*` and `computer_*` tools were "no longer available (MCP server
disconnected)". BB's own bridge tools, such as canvas and task, stayed.
bb-box itself was fine: `bb box` worked on the CLI, its host worker logged
that it was ready, and the reload logged "started in 0.02 s". A session got
the tools back at once only when its agent runtime restarted, with `bb
thread stop` and then a new message. One session that was not restarted got
them back on its own, but only about an hour after the reload: it lost them
at about 03:35 UTC and had them again at about 04:45.

**What we ask.** When a plugin loads again, BB's bridge tells live sessions
that its tools are back, with MCP's `notifications/tools/list_changed`, or
reconnects them at once, so they need no restart and no hour's wait.

**Until then.** An agent that loses bb-box's tools needs its thread stopped
and a new message, or waits about an hour. bb-box keeps its reloads short, so fewer sessions catch
one, but cannot bring the tools back to a session that lost them.

## 33. Install BB's app on Windows in seconds

**Status in BB 0.46.0: not met.**

**What bb-box needs.** A Windows box joins BB as quickly as a Linux one.
Agents wait for it: until then the box has none of the thread's access.

**What BB does now.** On 22 October 2026, Windows boxes on Proxmox and on a
Mac joined BB in 49 to 95 s after they were ready, of which BB's installer
took 42 to 88 s. In one box the installer's npm install of bb-app took
35 s: it wrote `install-machine-windows.mjs` at 03:41:31 and bb-app's
launchers at 03:42:07, then started the daemon, which connected about 6 s
later. The same npm install, run by hand on that 4-core arm64 VM, took
16 s for 46 packages and 6,109 files. A Linux box with bb-app pre-installed
enrols in about 5 s ([request 5](#5-enrol-quickly-when-bb-app-is-installed)).

**What we ask.** On Windows, unpack a built bb-app, with its native add-ons
for the machine's architecture, rather than run npm install, or say how a
machine provider should install it ahead.

**Until then.** bb-box's Windows images pre-install the server's bb-app
when a template is refreshed, with its digest in `host-artifact.sha256`,
as the macOS and Linux images do, so BB's installer finds it and skips the
download and npm install. A box of a server that has built bb-app again
since installs it as before (#916).

## 34. Keep one plugin's stylesheet from slowing another's panel

**Status in BB 0.46.0: not met.**

**What bb-box needs.** Its panels to lay out and draw as fast inside BB as
on a page of their own, whatever other plugins' stylesheets hold.

**What BB does now.** BB loads every plugin's app stylesheet into the one
page, and its rules reach every plugin's panel. On 22 October 2026, a
terminal in bb-box's panel took about 2.2 s from the prompt arriving to
drawing it. xterm's DOM renderer measures the width of each new character,
and each measurement took about 30 ms in the panel, against 0.3 ms
elsewhere. Turning stylesheets off one at a time found the cause: the
`app.css` of shell-tasks, a plugin bundled with BB. Without it, the prompt
took about 8 ms. That stylesheet has `:has()` rules, the likely cause, as a
`:has()` rule can make the browser recheck styles across the page on each
change, though the exact rule was not isolated.

**What we ask.**
- Scope each plugin's stylesheet to its own panels and slots, for example
  in a cascade layer and under the plugin's root element, so one plugin's
  rules neither match nor restyle another's elements.
- Check shell-tasks' `:has()` rules, and keep any that must stay global to
  selectors that cannot match outside its own elements.

**Until then.** bb-box is moving its terminals to xterm's WebGL renderer,
which does not measure characters in the page. Other parts of its panels
may still be slowed.

## 35. Say what a machine needs before installing

**Status in BB 0.46.0: not met.**

**What bb-box needs.** A cloud server, or any fresh machine, that becomes a
BB machine with the command BB's Add a machine dialog gives, and a clear
message when it cannot.

**What BB does now.** On 22 October 2026, on a new Hetzner server with
Ubuntu 26.04 and nothing else installed, the Manual setup command failed
with "sh: node: not found" and printed only its usage. BB's installer needs
Node.js 22 or later, and says so nowhere in its output. Installing Node.js
from Ubuntu's own packages (22.22.1) fixed it.

Two more things slowed the same setup:

- The command is shown once in the dialog and expires in 15 minutes.
  `bb machine create --provider manual` makes the machine but does not
  print the command, and the machine, opened afterwards in BB, says
  "Machine is no longer paired".
- The daemon should run as a user of its own, with lingering on, which the
  dialog does not say.

**What we ask.**
- The installer installs Node.js where it can, or stops with one plain
  line: which version it needs, and how to install it.
- `bb machine create --provider manual` prints the command, as the dialog
  shows it, so a machine can be set up from the CLI.
- The dialog says which user to run the command as, and that lingering
  keeps the daemon running after the user logs out.

**Until then.** bb-box's guide for a cloud Docker host lists Node.js, the
user and lingering as steps before the command.

## 36. Let a reloaded plugin's old instance go

**Status in BB 0.47.1: not met.**

**What bb-box needs.** A plugin that reloads, at each deploy or
`bb plugin reload`, leaves nothing of its old instance or its old code in
BB's server once the old instance is disposed.

**What BB does now.** BB's `loadOne` reads `const previous = loaded.get(row.id)`
in the same scope as the functions it gives the new instance, such as
`getSdk: () => boundSdk`. A closure in that scope, `failBeforeFactory`, reads
`previous`, so V8 keeps `previous` in the scope's context, which every
closure of the new instance shares. The new instance's API therefore keeps
the old instance alive, which keeps the one before it, and so on: every
instance since the server started stays reachable, with the handlers,
tools, schemas and state it registered or held.

On 25 October 2026, on a fresh BB 0.47.1 with no account, Docker set up and
one Linux box kept, BB's heap after a full garbage collection, a minute
after each `bb plugin reload`:

| Reloads | bb-box reloaded | A plugin that does nothing, reloaded |
| --- | --- | --- |
| 0 | 81 MiB | 96 MiB |
| 2 | 83 MiB | 97 MiB |
| 10 | 89 MiB | 97 MiB |
| 20 | 96 MiB | 98 MiB |

A heap snapshot after the 20th reload of bb-box held 20 old instances
through `previous`, and 12.0 MiB that only they kept. On the operator's
BB, with boxes and desktops in use, the heap after a full collection went
from 725 to 884 MiB over a day with about 35 deploys.

An update to new code, as at each deploy, costs more. On a second fresh BB
0.47.1, set up the same way, bb-box was moved 6 times between two commits
of main with `bb plugin update`, from a Git mirror on the machine:

| Updates | BB's heap after a full collection | Outside the heap |
| --- | --- | --- |
| 0 | 81 MiB | 25 MiB |
| 2 | 92 MiB | 33 MiB |
| 4 | 103 MiB | 40 MiB |
| 6 | 114 MiB | 48 MiB |

BB imports each version's `server.js` at a new URL, ending in
`?bbPluginLoad=` and a number, and Node's module loader keeps every module
it has loaded, in its `LoadCache`, for the life of the process. A heap
snapshot after the 6th update held all 7 versions, each with about 10,000
functions. The 6 old ones kept 31.6 MiB that nothing else did: 21.9 MiB of
code, bytecode and functions, and 9.7 MiB of each version's module-level
data. Their old instances were not kept: an update does not go through
`previous`. That is about 5.3 MiB of heap a deploy, close to the 4.6 MiB a
deploy on the operator's BB.

**What we ask.** BB drops its reference to the old instance once it is
disposed, for example by declaring `previous` with `let` and setting it to
`undefined` after `disposePluginInstance`, or by reading it in a function of
its own, so no closure of the new instance shares its context. For an
update, BB loads a plugin's server code where it can be let go, as Node
cannot unload a module it has imported: in a worker or a process of its
own, or in a `vm` context it drops with the old version.

**Until then.** BB's server grows by one version of bb-box's code at each
deploy, and by one instance at each reload, and a restart of BB's server
frees them all.

## 37. Leave a modified click on a panel's link to the browser

**Status in BB 0.48.0: not met.**

**What bb-box needs.** A link in a plugin's panel to a path of BB's app, such
as a box's page or one of its views, opens in a new tab when clicked with
Ctrl or Command held, or with the middle button, as any link does.

**What BB does now.** On 30 October 2026, on a fresh BB 0.48.0 with no
account, in headless Chromium: a Ctrl-click on such a link inside the
panel's main pane had its default prevented before it reached the
document, and BB routed to the link's path in the same tab, opening no new
tab. The same link appended outside BB's app, under `body`, opened a new
tab.

**What we ask.** BB's handling of links in a panel routes in the app only
a plain left click, and leaves a click with a modifier key or another
button to the browser.

**Until then.** The links on a box's page and the box's name in a view's bar
stop the click going further when it has a modifier key or another button,
so BB never sees it and the browser opens the new tab.

## 38. Say who answered a plugin's form

**Status in plugin SDK 0.6.15: not met.**

**What bb-box needs.** Decision 070 lets an agent ask for a restore of a box
its thread runs on, such as one of the person's own machines, through a form
in the thread (`bb.ui.requestInput`), and restores only on its submit. The
owner's rule is "never one of the person's own machines without a yes in the
thread". bb-box needs to know that the person gave that yes, not the agent
that asked.

**What BB does now.** `PluginInteractionResult` gives `submitted` and the
value, and nothing of who submitted it. BB's command line answers a plugin's
form: `bb thread interactions respond <interactionId> --self --value <json>`,
where `--self` is the thread in `BB_THREAD_ID`, and every agent has `bb` on
its path. So the asking agent can answer its own form.

**What we ask.** Either of:

- the result says where the answer came from: the app, by a person, or the
  command line, with the thread that ran it where it was one;
- or a form can be marked as answerable only in the app, and the command
  line refuses to answer it.

**Until then.** bb-box words the form, its result and the box log as "a yes
given in the thread", never as the person's own; the skill tells agents never
to answer bb-box's forms; and 070's gate G11 runs the command line's answer
from the asking agent and records what bb-box then logs.

**Measured in 070's unit 5** (G11, a fresh BB, latest bb-app, 31 October
2026). The asking agent's own process ran `bb thread interactions list
--self --json`, which gave it the form's whole payload, then `bb thread
interactions respond <id> --self --value <json>` with the plan it read
there. BB answered "Interaction ... answered", and bb-box restored the box,
logging "on a yes given in "Asks"", word for word as for Restore pressed in
BB's app. BB's own record of the form says `plugin_submitted`, with nothing
of who submitted it.

## 39. Let a plugin hold a machine against Send now

**Status in plugin SDK 0.6.15: not met.**

**What bb-box needs.** Decision 070 restores a box that threads run on only
while no turn can start on it. bb-box holds every message for a thread on
the box with the `message.dispatch` hook, and checks for a running turn
before each step that changes the box.

**What BB does now.** "Send now" on a queued row skips the hook, by design.
While the machine is connected, it starts the turn at once. A plugin's check
is never at the same moment as its next step, so a turn sent between bb-box's
last check and its stop runs, and the stop interrupts it. Measured in 070's
unit 5 (gate G17): the turn showed "Thread interrupted because the host
daemon disconnected"; bb-box's check after the stop found it, started the box
again and restored nothing. While the machine was stopped, BB refused "Send
now" itself ("the host is not ready", HTTP 409), which is what bb-box needs
for the whole restore.

**What we ask.** Either of:

- a plugin can hold a machine: no turn starts on it, "Send now" included,
  until the plugin lets it go or stops, with a reason shown on each held row;
- or "Send now" asks the hook too when the hook's wait names a machine, and
  the person can still override it from the machine's own controls.

**Until then.** Restores of boxes threads run on stay off, on the page,
through the form and on the command line.

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
- **The thread in a machine provider's `create`.** For a thread on a new
  box ([033](decisions/033-a-thread-can-start-on-a-new-box.md)), bb-box
  finds the thread from `create`'s key, which BB sets to the thread's ID.
  That is not documented. bb-box would ask for the thread's ID, or none,
  in `create`'s context.
- **Linger in the installer.** Where the installer makes a systemd user
  service, it could enable linger, so the service outlives the session that
  installed it. bb-box does this in its templates meanwhile.
