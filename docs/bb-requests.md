# What bb-box asks of BB

bb-box builds on BB rather than around it
([002](decisions/002-bb-is-the-coordinator.md)). These are the BB features it
has needed. Each one's status is checked against BB 0.45.0, its plugin SDK
0.6.15, its guide and its component registry, on 7 October 2026. A request BB
meets stays here, with the bb-box issue that drops its workaround. This page
is a log: bb-box does not file these with BB.

| Request | Status | Without it |
| --- | --- | --- |
| [BB's host app on Windows](#1-bbs-host-app-on-windows) | partly met | Windows boxes join BB as machines of BB's manual provider, not bb-box's, so BB removing one does not release its box, and "New box" cannot make a Windows box (#539) |
| [Send backlog on plugin WebSockets](#2-send-backlog-on-plugin-websockets) | not met | the desktop relay cannot slow down for a slow viewer |
| [Start cleanly after a reboot](#3-start-cleanly-after-a-reboot) | not met | every template and image clears BB's daemon lock and PID file at boot |
| [Change a plugin's source and keep its state](#4-change-a-plugins-source-and-keep-its-state) | not met | moving bb-box off a pinned commit or tag needs `bb plugin remove`, which deletes its settings, secrets and storage |
| [Enrol quickly when bb-app is installed](#5-enrol-quickly-when-bb-app-is-installed) | not met | a box from a template with bb-app installed takes about 5 s to enrol, not under 2 s |
| [Find a machine by its key](#6-find-a-machine-by-its-key) | not met | the machine of a box whose record was lost, and whose thread then ended, stays in BB |
| [Reach a port on a machine](#7-reach-a-port-on-a-machine) | not met | a Mac that runs Tart for bb-box needs SSH from the BB server, with a host user and a key, even when it is a BB machine already; Docker on a BB machine goes through a relay of bb-box's own, on a route with `auth: "none"` guarded by a one-time secret |
| [Give a machine's own commands its variables](#8-give-a-machines-own-commands-its-variables) | not met | bb-box's host entry keeps a process with the thread's variables and GH_TOKEN on each box, and commands read them from BB's processes there: from `/proc` on Linux, inexactly from `ps -E` on macOS, and through each process's PEB on Windows |
| [Open BB's terminal on a machine from a plugin](#9-open-bbs-terminal-on-a-machine-from-a-plugin) | not met | a box's terminal is bb-box's own tab over its own shell, not BB's terminal with its tabs, history and persistence |
| [Show machine-making environments where they can be seen](#10-show-machine-making-environments-where-they-can-be-seen) | not known | "New box" in the new-thread screen sits below the fold of the Machines list, and users do not find it |
| [Give a machine a project's variables without a thread there](#11-give-a-machine-a-projects-variables-without-a-thread-there) | not met | a box has its thread's project variables only while a thread of the project runs on it |
| [Make a plugin's host call quick](#12-make-a-plugins-host-call-quick) | not met | each call to bb-box's host entry takes about 0.4 s, so it cannot carry commands |
| [Mark a machine offline when it stops checking in](#13-mark-a-machine-offline-when-it-stops-checking-in) | not met | a machine that goes with no word, such as a PC that restarts, shows as connected for about 16 minutes, so bb-box judges it by when BB last heard from it |
| [Panel actions without a launcher row](#14-panel-actions-without-a-launcher-row) | not met | a thread panel action is always a launcher row, so Desktop and Terminal cannot be hidden and open from the Box panel alone; instead each is a shortcut that opens the right box |
| [Give a plugin's CLI the caller's files](#15-give-a-plugins-cli-the-callers-files) | documented in 0.45.0, not shipped | `bb box image set --script-file` and `bb box config apply` read their files on BB's server, so they fail from any other machine; agents use `box_image_set`, which takes the text, until #535 |
| [Alert dialogs that do not fly in from the corner](#16-alert-dialogs-that-do-not-fly-in-from-the-corner) | not met | every plugin's alert dialog, scaffolded from the registry's `alert-dialog.tsx`, flies in from the top left on Tailwind v4; bb-box carries BB's own dialog motion in its copy |
| [Carry providers' own config to every machine](#17-carry-providers-own-config-to-every-machine) | not met | a box lacks the config a provider reads from its machine, such as pi's `models.json`, so bb-box carries a list of files of its own into every box (#455) |
| [A nav page's title-bar action beside its title](#18-a-nav-pages-title-bar-action-beside-its-title) | not met | the Boxes page's settings gear sits at the title bar's right, before BB's own buttons, not beside the "Boxes" title where the operator wanted it |
| [Tool calls longer than five minutes](#19-tool-calls-longer-than-five-minutes) | not met | `box_run` returns after 270 s, and a command still running goes on as a job for `box_job`; a Windows command in the desktop session, which has no job, is stopped (#486, #414) |
| [Move large files through the file API](#20-move-large-files-through-the-file-api) | not met | `box_copy` moves a file over 16 MiB through bb-box's own worker on the machine that holds it, which needs that machine connected to BB (#492) |
| [Stop a plugin's machine workers after its tool calls](#21-stop-a-plugins-machine-workers-after-its-tool-calls) | not met | a command in a Docker box on a BB machine loses its box first at a deploy, so `box_run` waits up to 10 s to see that bb-box is stopping before it names the job (#415) |
| [Remove a machine whose host is gone](#22-remove-a-machine-whose-host-is-gone) | not met | a Windows box's machine stays in BB's list as "removing" when the box goes before BB has torn down the threads' environments on it, so bb-box waits up to 2 minutes for BB's removal before it releases a Windows box (#539) |
| [Install commands for the machine's OS](#23-install-commands-for-the-machines-os) | not met | BB's install action for Cursor's CLI on a Windows machine is a bash script, which Windows cannot run (#561) |

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

**Status in BB 0.45.0: not met.** SDK 0.6.15's plugin WebSocket has neither
`bufferedAmount` nor a `send` that returns a promise.

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

**Status in BB 0.45.0: not met.** SDK 0.6.15 has no navigation call that opens
BB's terminal on a machine.

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

**Status in BB 0.45.0: not met.** `threadPanelAction` in SDK 0.6.15 has no
field that hides its launcher row.

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

**Until then.** bb-box's copy carries that motion ([#453](https://github.com/moonstead/bb-box/pull/453)),
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

**Status in BB 0.45.0: not met.** Neither the guide nor SDK 0.6.15 states a
tool call's time limit or a way to keep a call open. It was not timed again.

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

**Status in BB 0.45.0: not met.** SDK 0.6.15's `files.read` and `files.write`
still move a whole file, with no offset, length or append.

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

**Status in BB 0.45.0: not met.** SDK 0.6.15's `hosts.delete` takes no force,
and neither do `bb machine remove` and `bb machine retry-cleanup`.

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
