# Architecture

How bb-box works now: its parts, the backend interface, a box's life,
commands and jobs, desktops and control, images, the relays through BB
machines, the configuration, and each backend. It describes the current
design only. Why each choice was made, and what came before, is in the
[decisions](decisions/README.md). The exact tools, commands, settings and
checks are in the [reference](reference/README.md), made from the code.

## The rule

bb-box's core does not care who the provider is
([001](decisions/001-provider-agnostic-core.md)). A hypervisor, a container
host, a pool of physical machines or a cloud is a backend behind one
interface, and one conformance suite tests every backend against it.

## Parts

```
BB app: Box panel, Boxes page, desktop and terminal tabs, settings      BB server
          |                                                                 |
          v                                                                 v
+------------------------------ bb-box plugin, on BB's server -------------------------------+
| Core: registry, lifecycle, sweep, agent tools, CLI, views, configuration, doctor,          |
|       desktop relay, shared control, enrolment, computer use, images, in-box scripts       |
|--------------------------------+-----------------------------------------------------------|
| Transports                     | Backends                                                  |
|  command: SSH, docker exec     |  proxmox-lxc, proxmox-qemu, docker, ssh-pool, tart        |
|  routes: tcp, command,         |                                                           |
|    websocket                   |                                                           |
+--------------------------------+-----------------------------------------------------------+
        |                                 |                                  |
        v                                 v                                  v
  inside each box             each provider's API or CLI       bb-box's host entry on BB machines:
                                                               access, the Docker and msb relays, file streams
```

| Part | Folder | Owns | Never |
| --- | --- | --- | --- |
| Core | `src/core/` | box records, lifecycle, sweep, computer use, the desktop relay's protocol work, images, in-box scripts | names a provider, hypervisor, container technology or transport |
| Plugin | `src/plugin/` | what BB calls: tools, CLI, RPC, HTTP routes, setup, enrolment, the nightly rebuilds | |
| App | `src/app/` | the panel, the Boxes page, the desktop and terminal tabs, the settings page | |
| Transports | `src/transports/` | running commands, copying files, opening a route to a port in a box | knows which provider made the box |
| Backends | `src/backends/<type>/` | acquire and release, capacity, ownership records, which transports and displays reach each box, images, `doctor` | runs anything in a box for the core |
| Host entry | `src/host/` | what BB's daemon runs for bb-box on a BB machine | |
| Relays | `src/relay/` | the Docker and msb relays and file streams, as channels on one WebSocket | |

- bb-box is a BB plugin with no service of its own
  ([002](decisions/002-bb-is-the-coordinator.md)). It calls each
  provider's API or CLI from BB's server.
- What runs inside a box is written once per guest OS and sent through the
  command transport: POSIX sh for Linux and macOS, PowerShell 7 for Windows.
  That covers enrolment, the thread's access, commands, file copies, jobs,
  computer use and a real machine's reset.
- Several backends can be on at once, and several can offer the same kind.

## The backend interface

The types are in [src/backends/types.ts](../src/backends/types.ts) and
[src/transports/types.ts](../src/transports/types.ts), and the code is
their reference. [Writing a backend](development.md#writing-a-backend) says
how to build one.

A backend declares its nature, virtual or real, and implements:

| Method | Does |
| --- | --- |
| `kinds()` | the kinds it offers, with their capabilities |
| `capacity(kind, size, pending)` | whether one more box of that size fits, with each host's limits and a message that says what is full |
| `acquire(box, previous, hooks, signal)` | makes or claims a guest, starts it, and returns when its command transport answers, within the kind's `readyTimeoutMs` |
| `release(guest, hooks)` | deletes a virtual guest, or resets a real machine and returns it to the pool |
| `power(guest)` | `running`, `stopped` or `unknown` now, from the provider, not a listing that may lag; null when the guest is gone |
| `start?`, `stop?` | only where the provider can; the panel and tools offer them only then |
| `stopped?(guest)` | why a guest stopped when bb-box did not stop it |
| `held()` | every guest this install holds, with the owner recorded at the provider |
| `stamp?` | records this install on a guest from before install IDs |
| `relabel?` | records a box's new owner or name on its guest, as when a spare is claimed |
| `asOffered?(guest, kind, createdAt)` | whether a guest comes from what the kind is offered from now |
| `footprint?()` | what its boxes take that another backend's must not, such as guest IDs and addresses |
| `transports(guest, kind)` | the command transport, the displays, and how the thread reaches the box |
| `images?` | the standard images it builds, and builds of projects' images |
| `doctor()` | checks the setup end to end and says how to fix what is wrong |
| `maintain?()` | upkeep, such as topping up a warm pool, at each sweep and when the configuration is applied |
| `members?()`, `returnToService?(ref)` | a real pool's machines and their state; puts back a machine the operator fixed |

A real backend also says what a release restores: `home`, the box user's
home, or `machine`, the whole machine.

- Every method is safe to repeat: the registry resumes after a restart and
  the sweep repeats releases. A missing guest counts as released.
- A backend records the guest with `hooks.claim` before it makes or
  changes anything, and releases what it claimed when an acquire fails.
- Each guest names its install and its box at the provider
  ([018](decisions/018-guests-name-their-install-and-box.md)). Where a
  provider reuses references, as Proxmox reuses VMIDs, `power`, `start`,
  `stop` and `release` first check that the guest still names the box in
  `Guest.data.box`. Otherwise `power` returns null, `release` does nothing,
  and `start` and `stop` throw `gone`.

### Kinds and offers

A kind is a shared word for what a box promises. An offer is a backend and
a kind. The registry tries a kind's offers in the configuration's order of
backends, and the first with room takes the box.

| Kind | Promises | Offered by |
| --- | --- | --- |
| `linux` | Linux on x86_64, no GPU | Proxmox LXC, Docker, an SSH pool's Linux machines |
| `linux-desktop` | a Linux desktop on a GPU | Proxmox LXC on a GPU host, Docker with NVIDIA's container toolkit |
| `linux-desktop-cpu` | a Linux desktop drawn by the CPU | Proxmox LXC, Docker |
| `linux-desktop-wayland-cpu` | a Linux desktop on Wayland, drawn by the CPU; X11-only apps do not run | Proxmox LXC, Docker |
| `linux-arm64` | Linux on arm64 | Tart |
| `linux-arm64-desktop-cpu` | a Linux desktop on arm64 | Tart |
| `macos` | macOS | Tart, an SSH pool's Macs |
| `macos-desktop` | a macOS desktop | Tart, an SSH pool's Macs |
| `windows-desktop` | a Windows desktop on x86_64 | Proxmox QEMU |
| `windows-arm64-desktop` | a Windows desktop on arm64 | Tart's Macs, in QEMU |

- **Names.** A kind without a desktop has no qualifier, and a desktop kind
  says `desktop` ([027](decisions/027-a-kind-says-when-it-has-a-desktop.md)).
  A kind names its architecture when it is not the OS's usual one, so
  `linux` is never arm64 ([040](decisions/040-linux-on-arm64-has-kinds-of-its-own.md)).
  The IDs `linux-headless` and `linux-headless-docker` are still accepted
  where an ID comes in, and core maps them to `linux`.
- **Docker.** `linux-docker` and `linux-arm64-docker` are aliases of
  `linux` and `linux-arm64` that take only offers with the feature `docker`
  ([041](decisions/041-every-linux-box-has-docker.md)). Proxmox LXC boxes
  and Tart's Linux VMs have Docker. Docker boxes have it unless the
  backend's `privileged` field is off or the host is rootless Docker, and a
  GPU desktop has it when its image was built after #283. An SSH pool has
  it only when every machine has a whole-machine reset. An offer or box
  without it says "No Docker".
- **Agreement.** Offers of one kind agree on what the agent relies on:
  `os`, `arch`, `gpu`, the computer-use driver, `enrol`, whether there is a
  desktop, and the features the kind requires. An offer may add features,
  such as a pool Mac's `xcode` and `ios-simulator`. The doctor warns when
  offers disagree ([012](decisions/012-offers-may-add-features.md)).
- **One provider.** An acquire may name its provider with `on`: as
  `box_list` gives it, by its backend ID, or by its one host's name. A list
  of them takes the first with room among them. Then only those are tried,
  and a full or offline one is refused rather than passed over
  ([044](decisions/044-a-box-can-be-asked-for-on-one-provider.md)).
- **GPU.** "No GPU" means no scarce GPU is taken, so macOS kinds declare
  `gpu: false`. A `linux-desktop` box whose display fell back to the CPU
  does not meet its kind: the backend releases it and tries another GPU
  within the kind's time, and new desktops avoid that GPU for 10 minutes
  ([020](decisions/020-control-belongs-to-a-viewer.md)). Proxmox's API
  cannot read GPU memory, so the Proxmox LXC backend reads it from a report
  the host writes: a root timer writes `nvidia-smi`'s figures in the notes
  of a VM that is never started, which the token may read and not change.
  Without a report under 10 minutes old, it keeps each GPU's free memory as
  a desktop on it last read it: its display service as it starts, and
  `nvidia-smi` in a running one during upkeep, for 5 minutes. A new desktop
  skips a GPU with less than it needs, and is refused before it starts when
  every GPU has less (#603).
- **Time to ready.** `readyTimeoutMs` is 30 s for a Proxmox LXC box, 60 s
  for a Docker box or a Linux pool machine, 3 minutes for a Windows VM or a
  pool's Mac, and 5 minutes for a Tart macOS or Linux VM.

### Capabilities

| Capability | Values | The core uses it to |
| --- | --- | --- |
| `os` | `linux`, `windows`, `macos` | pick the in-box scripts |
| `arch` | `x86_64`, `arm64` | tell the agent what runs there |
| `gpu` | yes or no | show GPU status and count GPU capacity |
| `features` | words such as `docker`, `xcode`, `ios-simulator` | let the agent choose, and show each box's extras |
| `command` | `transport` (a name for people), `shell` (`sh` or `powershell`), `admin`, `inDesktopSession`, `streaming`; or none | offer commands and file copies |
| `displays` | `{id, protocol, resizable}` for each display; none without a desktop | load the viewer client, and allow resizing |
| `computerUse` | `{driver, version, socket}`, or none | offer the computer tools ([015](decisions/015-computer-use-through-cua-driver.md)) |
| `enrol` | yes or no | make the box a BB machine |

- A kind enrols only when its shell is `sh` and its OS is Linux or macOS.
  BB's host app does not run on Windows yet
  ([BB requests](bb-requests.md#1-bbs-host-app-on-windows)).
- Computer use needs a command transport with `spawn`, which keeps a
  command running with its stdin and stdout as a byte channel.
- A box records its kind's capabilities when it is made. When the plugin
  starts, and after the configuration changes, core gives each box what its
  kind has now, where the backend's `asOffered` says the guest comes from
  what the kind is offered from now. Proxmox LXC answers by the template's
  build ID; Docker, Tart and pool kinds have capabilities fixed in code.

### Reaching inside a box

`transports(guest, kind)` returns the command transport, the displays, and
`access`: how the thread's own machine reaches the box, by SSH or a Docker
host, or null when only BB's server can.

**Routes.** A route says how to reach one port inside a box, as data:

| Route | Holds | For example |
| --- | --- | --- |
| `tcp` | host and port | a box on a network BB's server reaches |
| `command` | a command whose stdin and stdout carry the bytes | `ssh -W 127.0.0.1:5900 <box>`, `docker exec -i <container> socat - TCP:127.0.0.1:5900` |
| `websocket` | URL, headers, and a certificate fingerprint or CA | Proxmox's `vncwebsocket` with its one-time ticket |

`openRoute` in `src/transports/route.ts` is the only code that opens one.
A route is made for each connection, as it may hold a one-time secret, and
is never logged or sent to the browser. A command transport's `route(port)`
gives a route to a port inside the box: `ssh -W`, or `docker exec` with
`socat`.

**Displays.** A display has an ID, a protocol (`rfb`, or `selkies` beside
it on an X11 CPU desktop), whether it can resize, and `open()`, which
returns a route and how to sign in: none, a VNC password, or a user and
password for Apple's authentication. A display may also have:

- `resize()`, which the relay calls when the stream server cannot resize
  ([021](decisions/021-desktop-resize-through-the-backend.md));
- `minSize`, 800x600 on Linux and Windows desktops: the relay raises a
  smaller size to it, and the viewer scales the desktop down;
- `input`, for a stream server that ignores a viewer's keys and pointer
  (#406): the relay sends the controlling viewer's input there instead;
- `clipboard: "commands"`, for a server that does not move the clipboard:
  bb-box moves it with commands in the desktop session (#464).

**SSH.** SSH access gives the host, port, user, host keys and an optional
jump host: the Mac for Tart, a bastion for a pool
([016](decisions/016-changes-from-building-v1.md)). A real machine's host
keys are pinned at setup; a fresh virtual guest's key is accepted and not
recorded. Commands to one box share a connection where the backend gives
the transport a socket directory, as Proxmox LXC does: at most 8 commands
on it at once, retired after two idle minutes, a failed command or a
missing socket, with keepalives every 5 s. A probe always dials afresh.

### Guests, capacity and sizes

- **Guests.** A guest is the backend's handle on a box's machine: its
  reference, its host, its address, its size, and `data`, small values the
  backend needs later, stored with the box and never a secret. `facts`,
  such as a desktop's display mode, show in status and the panel. A
  backend with several hosts set up alike lists them in its configuration,
  and `host` names one; each Docker host is a backend of its own.
- **Capacity.** A box needs its memory, disk and a slot on one host, so
  `capacity` reports named limits per host, plus the warm pool for the
  kind: `memory` and `disk` in MiB; `cpu`; `guests` (Tart's two macOS VMs
  per Mac, a Docker container budget, Proxmox's VMID range);
  `gpu-desktops` and `gpu-memory` per GPU; and `machines` for a real pool.
  Each limit has what is used, the total if known, and a reserve for the
  host.
- **Sizes.** A box's size, cores, memory and root disk, is chosen when it
  is made ([028](decisions/028-a-box-size-is-chosen-when-it-is-made.md)).
  Each kind has the presets small, medium and large, a default and a
  largest custom size, the same on every offer and changed in the
  configuration's `kinds` part. Core refuses a size above the largest, and
  a Linux size under 2 GiB of memory. An offer that cannot make a size says
  so, and the registry tries the next. A pool lends its smallest free
  machine of at least the size, counting 90% of the memory.
- **Real pools.** `release` records "being reset" with `hooks.resetting()`
  before it touches a machine, so a restart finishes the reset. The machine
  keeps a reset generation, and the box keeps its machine's generation, so
  a repeated release of an old box never resets the machine the next box
  holds. A claim checks the machine is clean first, and puts it out of
  service with the reason if not.

## A box's life

```
requested -> acquiring -> starting -> ready -> enrolled
                                        |  ^
                                   stop |  | start      (you or the agent)
                                        v  |
                                      stopped

any state -> releasing -> released     (release, or the thread is archived or deleted)
```

1. **Requested.** The registry asks each offer of the kind for `capacity`
   at the box's size, in order, and uses the first with room. Otherwise the
   caller gets the backend's message, which says what is full. The record
   is made at once.
2. **Acquiring.** The backend claims a guest with `hooks.claim` before it
   makes anything, so a restart resumes and the sweep finds it.
3. **Starting.** The guest boots. Each step's time goes to `hooks.timing`
   and shows in the box's status.
4. **Ready.** The command transport answers. A box of a project's image
   that has no build on its backend runs the image's script now, before it
   is handed over (049).
5. **Enrolled.** A box whose kind can enrol becomes a BB machine, and the
   thread's access reaches it.
6. **Released.** You or the agent release it, or its thread is archived or
   deleted ([003](decisions/003-boxes-live-until-released.md)). bb-box
   removes the machine from BB, then the backend releases the guest. A box
   a thread is working on is released or stopped only when forced
   ([034](decisions/034-a-working-thread-holds-its-box.md)). Each release
   logs why.

Stopping keeps the disk and frees memory or a GPU. It never happens on a
timer: boxes do not expire.

| | Virtual | Real |
| --- | --- | --- |
| Acquire | clone and start a guest, or take a warm one | claim a free machine and make its box user |
| Ready | the transport answers | the transport answers as the box user |
| Stop and start | where the provider can | no |
| Release | delete the guest | remove the box user and what it left, or restore the whole machine |
| If release fails | the sweep retries | the machine goes out of service until the operator fixes it |

### Warm guests and spares

- **Warm guests** are ready guests of a kind that are not BB machines, so
  an acquire is only a claim ([004](decisions/004-acquire-and-release.md)).
  `ReadyPool` in [src/backends/pool.ts](../src/backends/pool.ts) picks a
  member that can serve the kind. The count is per backend and kind in the
  configuration, 0 by default. `maintain()` tops pools up after a claim,
  when the configuration is applied and at each sweep, never below the
  backend's reserves, and reports a pool it left short, with the reason,
  which the log, the doctor and the settings page show (#356). Warm guests
  wait at the kind's default size, from a build that is current: one from
  another template build, image build or default size is retired. How
  each backend keeps them is under [Backends](#backends).
- **Spares** are boxes made ahead and enrolled, at a kind's default size,
  that no thread owns yet: up to 10 per kind
  ([032](decisions/032-spare-boxes-are-enrolled-ahead.md)). An acquire at
  the default size takes one, so the box has the thread's access at once.
  BB lists a spare as "<name> (spare)". When no backend has room for a
  thread's box, bb-box releases a spare to make room. A spare that a
  thread starts on through BB's picker becomes your machine
  ([036](decisions/036-your-machines-are-boxes-you-own.md)). The upkeep
  replaces a spare, ready or waiting stopped, that its backend's
  `fromCurrentBuild` says comes from a build of the kind's image that a
  refresh (049) has replaced since, so a claim
  never takes an old build, and never waits on the backend for it. Proxmox
  LXC and QEMU compare the build recorded at the clone with the template's,
  Docker the container's image ID with the tag's, and microsandbox the
  image record a microVM took at creation with the image's. Tart and the
  SSH host pool cannot tell (a Tart box records no build of its image, and
  a pool machine has none), so their spares stay until they go otherwise.
- **Spares of projects' images.** Where a project's image is baked, on
  Proxmox LXC or Docker, bb-box also keeps one spare of the build for each
  kind, while the image is in use: a box started from the build, or the
  build was made, within 14 days, or the image says `bake: always`. The
  image's boxes claim it, and a new build replaces it (#440).

### Enrolment and the thread's access

A box is a resource of its thread and gets what the thread's machine has.

- **Enrolment.** bb-box is a BB machine provider. It creates a machine
  keyed by the box ID, and the provider runs BB's `bootstrap` through the
  box's command transport
  ([014](decisions/014-enrol-through-machine-providers.md)). Images carry
  BB's host app, so the installer skips its download; a box enrols about
  5 s after it is ready on Linux, and 8 to 11 s on a Mac
  ([BB request 5](bb-requests.md#5-enrol-quickly-when-bb-app-is-installed)).
  Images clear BB's daemon lock and PID file at boot
  ([017](decisions/017-boxes-clear-bb-daemon-state-at-boot.md)). An
  enrolment fails, rather than counting the box enrolled, when BB does not
  show the machine connected within 30 s (#286).
- **Variables.** BB gives the thread's Git credentials and machine
  variables to its daemon in the box. Each command bb-box runs, and each
  SSH session through the box's `~/.bashrc` (`~/.zshenv` on macOS), takes
  `GH_TOKEN`, the git identity and BB's machine variables from a process of
  that daemon as it starts: from `/proc` on Linux, from `ps -E` on macOS,
  and through each process's PEB on Windows, on trial, for bb-box's own
  commands only (#560;
  [BB request 8](bb-requests.md#8-give-a-machines-own-commands-its-variables)).
  The values never reach the disk. bb-box's host entry keeps a process
  with the current values running in a worker of the daemon
  (`src/host/access.ts`), so commands always find one. A project's own
  variables reach a box only while a thread of the project runs there
  ([BB request 11](bb-requests.md#11-give-a-machine-a-projects-variables-without-a-thread-there)).
  `git` takes GitHub credentials from `gh`, and fetches GitHub's SSH URLs
  over HTTPS.
- **Child threads.** A child thread can run on an enrolled box
  (`box_thread`), with its parent's agent and model when the box has that
  agent's CLI (#561). BB's new-thread screen can start a thread on a new
  box, which goes with the thread
  ([033](decisions/033-a-thread-can-start-on-a-new-box.md)).
- **Your machines.** Boxes you own, kept as BB machines under names you
  give, until you remove them
  ([036](decisions/036-your-machines-are-boxes-you-own.md)).
- **Files for every box.** A short list of files, each a path under the box
  user's home and a secret content, written into each Linux and macOS box
  as it joins BB, starts again or the list changes (#455). Windows boxes
  get none yet.
- **Direct access.** The agent can reach its boxes itself, with
  `ssh <box name>` or `DOCKER_HOST`, where `access` allows.
- **Windows** boxes enrol as machines of BB's manual provider, which
  bb-box makes and removes with the box (#539), as BB enrols a provider's
  machine with its installer for Linux and macOS only. A switch on each
  backend with Windows boxes turns it off.

### Clean-up and crash recovery

Nothing expires, so no box may be forgotten.

- **Ownership is recorded at the provider**: Proxmox tags, Docker labels,
  an owner file per Tart VM, a marker file on a real machine. `held()`
  reads it back, so the sweep works even when bb-box's storage is lost.
- **Each install records its ID** on every guest and acts only on its own.
  An install that lost its storage takes its old ID back with
  `bb box install-id --set`
  ([018](decisions/018-guests-name-their-install-and-box.md)).
- **After a restart** the registry resumes acquires, repeats interrupted
  releases and checks the power of the rest.
- **The sweep** runs at start and every 3 minutes. It records the install
  on older guests (`stamp()`); releases the boxes of threads that BB says
  ended, at this sweep and the last, since one answer may be wrong
  ([019](decisions/019-lost-records-are-restored-from-guests.md)); finishes
  interrupted releases; restores the record of a guest whose thread is
  live and releases one whose box holds another guest or none; and calls
  `maintain()`. A restored box enrols again, keyed by its box ID, once it
  answers ([026](decisions/026-a-restored-box-enrols-once-it-answers.md)).
  It changes a box's state only when `power()` confirms it, and logs each
  guest it releases, restores or keeps.
- **A guest deleted outside bb-box** shows as gone, and stays gone when
  its reference is reused.
- **A guest that stopped without bb-box's request** is recorded with what
  `stopped()` says. When the guest did not choose it, as when its VM
  crashed, bb-box starts the box again, unless it did so less than 10
  minutes before (#406).
- **A box that rebooted** starts its services again, and the sweep
  bootstraps its BB machine again when BB shows it disconnected.
- **If BB's server is down**, boxes keep running and nothing is released.

## Commands and jobs

- **A run** ends when the script's shell exits, even while something it
  started holds the output open. `CommandLine` in
  [src/transports/process.ts](../src/transports/process.ts) runs a POSIX
  script in a child shell, then writes an end mark and the exit status, so
  a background process cannot keep the run open. `box_run` keeps the first
  and last 16 KiB of each stream.
- **Windows.** [src/transports/powershell.ts](../src/transports/powershell.ts)
  sends the script base64-encoded, and exits as sh would. A script longer
  than Windows' command line goes to a file first. sshd ends everything a
  command started when it exits, so `Start-Detached` starts a command
  outside the session.
- **The desktop session.** `box_run` with `desktop` runs a command in the
  logged-in desktop session: with `DISPLAY` and the session bus on Linux,
  through `launchctl asuser` on macOS
  ([030](decisions/030-a-mac-runs-desktop-commands-through-launchctl-asuser.md)),
  and as an unelevated one-off scheduled task on Windows, whose output
  comes back when it exits
  ([039](decisions/039-windows-desktops-are-clones-of-a-template-that-is-not-generalized.md)).
- **Jobs.** BB ends a tool call at about five minutes, so `box_run` returns
  after 270 s, and a command still running goes on in the box as a job,
  which `box_job` reads. Each command runs as a job from the start, with
  its output and exit status in files under `~/.local/state/bb-box/jobs/`,
  so it also outlives a restart of bb-box (#405): bb-box's dispose hook
  waits up to 60 s for running commands, then leaves them to their jobs.
  On Windows a runner started with `Start-Detached` holds the job, outside
  the SSH session (#414). A Windows command in the desktop session has no
  job, and stops at 270 s. A box's next command removes the jobs bb-box
  has the result of, and those older than 7 days.
- **Files.** `box_copy` moves one file between the thread's workspace or
  storage folder and a box. A file up to 16 MiB goes through BB's file
  API. A larger one streams through the [file relay](#relays-through-bb-machines),
  and the box and bb-box's worker each check its SHA-256 before it
  replaces the target (#492). In a box, file copies are scripts with the
  file's bytes as their stdin or stdout.
- **The terminal.** A person's terminal is the box user's login shell over
  the command transport, with its PTY on BB's server, on the plugin's
  `/terminal` route ([035](decisions/035-a-terminal-has-its-pty-on-bbs-server.md)).
  It lives 10 minutes without a tab.

## Desktops and control

**The desktop relay.** Each viewer opens one WebSocket on the plugin's
`/desktop` route ([007](decisions/007-desktop-stream-is-a-typed-transport.md)).
The relay opens the display's route, does the box's RFB security
handshake itself, VNC authentication with the box's password or Apple's
(type 30) as a user, then offers the viewer RFB 3.8 with security type None
only, as BB has authenticated the viewer. Passwords and tickets never reach
the browser. It copies bytes both ways without decoding pixels, and always
joins as a shared client. The viewer is noVNC.

**The Selkies relay.** An X11 CPU desktop also has a Selkies display, H.264
over WebSockets from `127.0.0.1:5980` in the box
([056](decisions/056-linux-x11-desktops-add-a-selkies-stream-and-rfb-stays-for-the-rest-tuned.md)).
A viewer asks for it with `&stream=selkies`. With the general setting
`video` on, the panel shows such a desktop as video when its fastest of
three round trips to BB's server takes 10 ms or more, and over RFB when it
is quicker, as RFB answers keys faster on a LAN. The viewer's menu has
"Show as video", and the tab keeps that choice for the box. Video needs
WebCodecs, so a browser without it, or video that does not start, shows
RFB. The panel's client decodes the H.264 with WebCodecs onto a canvas,
takes keysyms from noVNC's keyboard handling, and stops the video while its
tab is hidden. The relay speaks WebSocket to Selkies over the display's
route and carries messages, not bytes:

- Each viewer joins Selkies as a viewer (`role=viewer`), so Selkies never
  hands the display from one page to another. The relay passes only its
  video requests, and drops the rest of what it sends.
- The input of the viewer with control goes over the box's input
  connection, one per box, which asks for no video. It opens as a person
  takes control, so their first key does not wait for it. A pointer loses
  its sequence number there, as several viewers' input shares it.
- The box's clipboard reaches only the viewer with control.
- Selkies paces a viewer by its socket, which the route hides, so the relay
  paces each by the frames it acknowledges: a second behind, it drops that
  viewer's frames until it catches up, then asks for a key frame, which
  goes to every viewer, and resumes from it. It asks on the input
  connection when that is open, as Selkies takes a viewer's request once a
  second, and again every 250 ms until one comes.
- Every relay runs on the event loop of BB's server, whose process runs
  bb-box, so code there that holds the loop holds every desktop's frames
  and input, whether it is bb-box's, BB's or another plugin's. bb-box logs,
  at most once a minute, when the loop stood still for 250 ms or more, and
  how much of it was garbage collection. A CPU profile of the process, 1 to
  30 s, one at a time, names the code (`bb plugin rpc call bb-box profile` with
  `{"seconds": 15}`). It logs only functions' names, files, lines and
  times.
- Selkies refuses a connection within 500 ms of another from the same
  address, and the relay's all come from the box's loopback, so it spaces
  them and tries again.
- A resize from the viewer with control goes through the RFB display, at a
  width of a multiple of 8 and an even height, as Selkies keeps them. Selkies
  follows a desktop that shrinks, but captures one that grows at its old
  size, even for later viewers. So after each resize bb-box makes, and when
  a viewer's frames have another size than the desktop's, the input
  connection sends SETTINGS with the desktop's size as a manual resolution,
  which moves the capture at once, without a restart. A capture moved to a
  larger size keeps its encoder's old size, so the picture is cut from the
  desktop's top left. So when the desktop grew past its video's size, every
  viewer's video stops for 300 ms: Selkies stops a capture no page wants,
  and starts the next at the desktop's size, from a key frame.

**Each desktop's server.**

| Desktop | Server | Signs in with | Resize |
| --- | --- | --- | --- |
| Linux, X11, GPU | TigerVNC's `x0tigervncserver` on Xorg | VNC password | the backend, with `xrandr --fb` |
| Linux, X11, CPU | `Xtigervnc` | VNC password | the server |
| Linux, Wayland | wayvnc on Sway ([048](decisions/048-a-wayland-desktop-is-sway-with-floating-windows-streamed-by-wayvnc.md)) | type 30, as `box` | the backend, with the display script's `resize` |
| Windows on Proxmox | Proxmox's console, through `vncwebsocket` | a one-time ticket and password | the backend, in the desktop session |
| Windows on a Mac | QEMU's VNC on the Mac's loopback | none | the backend, in the desktop session |
| macOS on Tart | the Virtualization framework's VNC, through a holder on the Mac | VNC password | none |
| macOS on a pool's Mac | Screen Sharing, through SSH as the box user | type 30, as the box user | none |

- **The picture.** The viewer asks a display for JPEG quality 2, or the
  quality the display names, and keeps noVNC's compression level, 2
  ([056](decisions/056-linux-x11-desktops-add-a-selkies-stream-and-rfb-stays-for-the-rest-tuned.md),
  [measured](research/rfb-quality.md)). Xtigervnc sends a still area again
  near losslessly about 0.1 s after it stops changing. wayvnc never does,
  and QEMU with `lossy=on` partly as JPEG still. So for a display with
  `refresh: "viewer"`, the Wayland desktops and Windows on a Mac, the
  viewer asks for the area it drew as JPEG again with no quality level
  once nothing has come for 250 ms, then for JPEG again
  (`src/app/rfb-refresh.ts`). Windows on a Mac names quality 4, as QEMU's
  JPEG at 2 breaks moving text up. Proxmox's console and Tart's holder
  send no JPEG.
- **A pool Mac's input.** macOS 27's Screen Sharing ignores a viewer that
  is not Apple's, so the display's `input` is core's `MacInput`: a JXA
  helper in the box user's session that posts each event with
  `CGEventPost`, keys by their position on a US keyboard
  ([047](decisions/047-a-physical-mac-is-an-ssh-pool-machine-lent-with-a-new-user-at-its-console.md#the-viewers-input)).
- **The clipboard.** Cmd+V, or Ctrl+V off a Mac, sends the browser's
  pasted text as ClientCutText and presses the box's paste chord; what the
  box copies comes back as ServerCutText, to the viewer with control only.
  TigerVNC and wayvnc move it both ways. For a display with `clipboard:
  "commands"`, Tart's macOS desktop and both Windows desktops, bb-box moves
  it itself for the viewer with control: `pbcopy` and `pbpaste`, or
  PowerShell's `Set-Clipboard` and `Get-Clipboard`, in the desktop session.
  The viewer asks for the box's clipboard every 2 s while its tab has the
  focus, one read per box at a time (#464, #461).
- **Viewers.** Each viewer has a random ID kept in its tab, so a tab that
  remounts keeps its control. Control belongs to one viewer, not to a
  person ([020](decisions/020-control-belongs-to-a-viewer.md)). The app
  keeps a hidden tab's desktop and terminal for 10 minutes, and a hidden
  tab that holds control hands it back after 60 s
  ([037](decisions/037-a-panel-keeps-a-boxs-desktop-and-terminal.md)).
- **Shared control.** One owner of input at a time, the agent by default
  ([008](decisions/008-shared-control.md)). The relay drops keys, pointer,
  clipboard and resizes from every other viewer, and passes update
  requests, so all see the desktop. On hand-back it releases what was held
  down and sets the desktop back to the agent's size. Control returns to
  the agent on hand-back, when the viewer has been gone 60 s, or when the
  box ends the connection and the viewer does not come back within 5 s
  ([043](decisions/043-a-viewer-has-5-s-to-come-back-after-the-box-ends-its-connection.md)).
  It is kept in plugin storage, so a viewer that connects within 60 s of a
  restart keeps it
  ([045](decisions/045-a-persons-control-lasts-through-a-restart-of-the-plugin.md)).
- **Pausing the agent** happens in the plugin. While a person holds
  control every computer tool refuses at once, and taking control closes
  the box's computer-use session. The agent takes control back, when asked,
  with `computer_take_control`
  ([038](decisions/038-the-agent-can-take-control-back.md)).

### Computer use

[015](decisions/015-computer-use-through-cua-driver.md),
[research](research/computer-use.md).

- **The driver** is Cua Driver, one release pinned with its SHA-256 in each
  image, with telemetry and update checks off. `cua-driver serve` runs in
  the desktop session: a user service on Linux, a LaunchAgent on macOS, an
  elevated task at logon on Windows.
- **The session.** One per box runs `cua-driver mcp` through the command
  transport's `spawn`, and the plugin speaks MCP over it. It opens on first
  use and closes after 10 idle minutes, when a person takes control, and
  when the box is released.
- **The tools** are bb-box's own, never Cua's: `computer_windows`,
  `computer_observe`, `computer_screenshot`, `computer_act`,
  `computer_type`, `computer_launch` and `computer_take_control` (see the
  [tools reference](reference/tools.md)).
- **Trees** are text, with references such as `e26` that belong to the
  plugin, within a budget of 300 lines. A reference is found again by its
  role, name and ancestors, follows its element through a rename, and an
  action on an element renamed out of sight is refused once
  ([022](decisions/022-references-follow-renames-not-rows.md),
  [023](decisions/023-a-reference-follows-its-element-through-its-own-rename.md),
  [024](decisions/024-an-element-renamed-out-of-sight-is-refused-once.md)).
- **Pixels** count only against the latest image of that window, at most
  1568 pixels on the long edge, and each image states its scale.
- **After each action** the plugin reads the tree again and says what
  changed: windows that opened or closed, and menus and popups with their
  items.
- **Delivery** is in the background first, then the foreground when Cua
  refuses, which the result says. On Wayland, keys go only to the focused
  window, so in the foreground, and an element Cua cannot click is clicked
  at the centre of its frame (048).

## Images

[049](decisions/049-a-project-image-is-a-script-on-the-standard-image-and-images-are-rebuilt-when-stale.md).
Each kind has a standard image per backend, built by the setup scripts and
rebuilt each night. A project can add a script on top.

- **The contract.** Every image has the box user with sudo, bb-box's key
  where it is reached over SSH, bb-box's boot units, BB's host app, Docker
  on first use, the desktop and Cua for desktop kinds, nothing of one
  machine, `bb-box-feature`, and its record. The kind's check
  (`bb-box-check-headless`, `bb-box-check-desktop`) checks it.
- **The record**, `/usr/share/bb-box/image.json` (`/usr/local/share` on
  macOS, `C:\bb-box\image.json` on Windows), gives the build's ID and date,
  the contract, the apt snapshot, the pins' digest, BB's app's digest, the
  tools, and for a project's image its script's digest
  (`src/backends/images.ts`). A copy is readable without starting the
  image: in a template's description, a Docker label, or a file beside a
  Tart VM.
- **Freshness.** The doctor fails an image with an older contract, or a
  GPU image whose NVIDIA userspace is not the host's, and warns when one is
  older than twice its interval, or has another BB app or other pins.
- **Nightly rebuilds** (`src/plugin/images.ts`). `bb box images refresh`,
  run each night by a BB script automation, rebuilds due standard images
  one at a time, most needed first, with the latest agent CLIs, gh and
  Chrome that publish checksums (`src/backends/versions.ts`). Linux images
  are due after 7 days and macOS images after 30. A run starts no image
  after 4 hours. A trial box of the new build must pass the kind's check,
  have BB's app and the record, answer no more than 5 s slower and have no
  older tool before the build takes the image's name. Windows images are
  not refreshed yet (#450).
- **A project's image** (`src/core/project-images.ts`) is a script run as
  root on a kind's standard image, with an optional check run as the box
  user, kept in the configuration with the paths it came from in the
  project's repository, usually `.bb/box-setup.sh` and `.bb/box-check.sh`.
  The script gets `BB_BOX_IMAGE`, `BB_BOX_KIND`, `BB_BOX_BACKEND` and
  `BB_BOX_ARCH`, and none of the project's secrets.
- **At start, then baked** (`src/plugin/bakes.ts`). A box with no current
  build of its image runs the script as it starts. Once two of its boxes
  did so on a backend within 14 days, or at once with `bake: always`,
  bb-box builds the image there: a box of the standard build, the script
  and check, finalizing, a capture and a trial box. A changed script or a
  rebuilt standard image makes a build out of date. The nightly run
  rebuilds builds in use and removes those unused for 30 days. Proxmox
  LXC, Docker and Tart bake, Tart on the Mac of the boxes (#439); the SSH
  host pool and GPU desktops run the script at each start.
- **Choosing.** A project's threads get its image for the kinds it covers.
  `box_acquire`'s `image`, `bb box acquire --image` and New box can choose
  another project's image or `standard`.
- **Written by an agent.** An agent drafts the script with
  `box_image_draft` from the project's own files (`src/core/draft.ts`),
  tries it with `box_image_try`, and registers it with `box_image_set`.

## Relays through BB machines

A BB machine runs bb-box's host entry (`src/host/entry.ts`) in a worker of
BB's daemon, called through BB. A call takes about 0.4 s, so calls set
things up and carry no commands
([BB request 12](bb-requests.md#12-make-a-plugins-host-call-quick)).
Bytes go over a WebSocket that the worker opens out to one of bb-box's
routes with a one-time secret, carrying channels with credit-based flow
control (`src/relay/mux.ts`).

- **access** keeps the thread's variables at hand for commands in a box
  (see [Enrolment and the thread's access](#enrolment-and-the-threads-access)).
- **The Docker relay** reaches a BB machine's Docker without SSH
  ([042](decisions/042-a-docker-host-can-be-a-bb-machine.md)). The docker
  CLI on BB's server uses a unix socket that bb-box listens on, and each
  connection to it is a channel on the `/docker-relay` route's WebSocket.
  It opens with the first `docker` command, in about 0.5 s, and closes
  after 5 idle minutes when bb-box has no box on the machine.
- **The msb relay** runs bb-box's msb on a BB machine
  ([053](decisions/053-microsandbox-runs-light-linux-boxes-as-microvms.md)).
  msb has no daemon or API socket to forward, so each run of it is a
  channel on the `/msb-relay` route's WebSocket, opened and kept as the
  Docker relay is. bb-box's msb client (`src/relay/msb-client.mjs`), run by
  node on BB's server, stands in for the msb CLI: it connects to the
  machine's unix socket, sends the run's arguments, and carries its stdin,
  stdout, stderr and exit status, and for a terminal its size and resizes,
  as the frames of `src/relay/msb.ts`. On the machine, the host entry runs
  only `bin/msb` in bb-box's msb folder, on a PTY of its own for a terminal,
  and three scripts of bb-box's
  (`src/backends/microsandbox/release.ts`) through its `microsandbox`
  call: install the pinned msb after checking its SHA-256, report on the
  machine, and import an image from Docker there. The folder is
  `microsandbox` in the plugin's data folder on the machine, with msb's
  state and images in its `home`. msb's sockets need a home of at most 57
  bytes, so a longer one is reached through a link of the user's,
  `/tmp/bb-box-msb-<uid>`.
- **File streams** carry a `box_copy` larger than BB's file API takes, on
  the `/file-relay` route, from the worker on the machine that holds the
  thread's workspace (#492).

## Configuration

bb-box's configuration is one checked document in its plugin storage
([029](decisions/029-configuration-is-one-checked-document.md)), described
field by field in the [configuration reference](reference/configuration.md).

- It lists the backends in the order the registry tries them, each with
  its fields, switch, warm counts and hosts; the kinds, each with its
  switch, presets, default, largest size and spares; the general settings;
  and projects' images.
- Hosts set up alike are a list inside one backend. Docker has a backend
  per Docker host, as each BB machine with Docker is one; two on one host
  are refused. Other types have one backend each.
- Switches stop new boxes only: an off backend's boxes keep working.
- A backend reads its switches, warm counts and kinds' sizes through its
  context, as they are at the call, so changing them does not build it
  again. A driver may take a set of fields from another type's backend:
  Proxmox QEMU takes Proxmox LXC's connection and SSH key.
- Secrets are kept apart from the document, and are write-only.
- The settings page and `bb box config show | check | apply` use the same
  RPC. Every write is checked, and a revision stops two people overwriting
  each other.

## Data ownership

| Data | Lives in | Owned by | Survives |
| --- | --- | --- | --- |
| Box records: ID, thread, kind, backend, guest, state, timings | plugin storage | core | restored by the sweep from the guests if lost, while their threads are live |
| Which guest belongs to which box and thread | the provider, or a marker on a real machine | backend | the plugin's storage being lost |
| Warm pool membership | the backend's pool store | backend | as above, for tags; plugin storage otherwise |
| The configuration | plugin storage | the operator | exported by `bb box config show --json`; deleted by `bb plugin remove` |
| Provider credentials, the files for every box | plugin storage, apart from the configuration | the operator | never in output, logs or errors, nor sent to the browser |
| bb-box's SSH key | plugin storage; setup installs its public key | core | |
| The install ID | plugin storage, and on every guest | core | the doctor shows the old ID, and an operator command restores it |
| The thread's Git credentials and variables | BB | BB | read from BB's daemon in the box by each command, never written to disk |
| Work in a box | the box's disk | the thread | deleted on release, or the home recreated on a real machine; not backed up |
| Standard images and builds of projects' images | the provider | the operator, and bb-box for rebuilds | rebuilt each night, or by the setup scripts |
| Who holds each desktop's input | plugin memory, and plugin storage while a person holds it | core | after a restart, the agent's unless the holder's viewer connects within 60 s |

## Backends

What runs where:

| Host | Box | Form | Backend | Kinds |
| --- | --- | --- | --- | --- |
| Linux | Linux | container | Proxmox LXC | `linux`, `linux-desktop`, `linux-desktop-cpu`, `linux-desktop-wayland-cpu` |
| Linux, Windows (WSL 2, Docker Desktop) | Linux | container | Docker, local, over `ssh://` or a BB machine's | `linux`, `linux-desktop`, `linux-desktop-cpu`, `linux-desktop-wayland-cpu` |
| Linux | Linux | microVM | microsandbox, local, over `ssh://` or a BB machine's | `linux`, `linux-desktop-cpu` |
| Linux | Linux | physical | SSH host pool | `linux` |
| Linux | Windows | VM | Proxmox QEMU | `windows-desktop` |
| Mac | macOS | VM | Tart | `macos`, `macos-desktop` |
| Mac | macOS | physical | SSH host pool ([047](decisions/047-a-physical-mac-is-an-ssh-pool-machine-lent-with-a-new-user-at-its-console.md)) | `macos`, `macos-desktop` |
| Mac | Linux | VM | Tart | `linux-arm64`, `linux-arm64-desktop-cpu` |
| Mac | Windows | VM | Tart, in QEMU | `windows-arm64-desktop` |

| | Proxmox LXC | Proxmox QEMU | Docker | microsandbox | SSH host pool | Tart |
| --- | --- | --- | --- | --- | --- | --- |
| Nature | virtual | virtual | virtual | virtual | real | virtual |
| Acquire | linked clone, start | resume a hibernated warm VM, or a linked clone | create and start a container | `msb create` | claim a machine | `tart clone`, `tart run`; QEMU for Windows |
| Release | delete | delete | remove the container | `msb remove` | reset the machine | `tart delete` |
| Commands | SSH | OpenSSH with PowerShell 7 | `docker exec` | `msb exec` | SSH as the box user | SSH through the Mac |
| Ownership | tags and description | tags and description | labels set at creation | labels set at creation | a marker on the machine | an owner file per VM on the Mac |
| Capacity | memory, disk, VMIDs, GPU | memory, disk, VMIDs | memory, a container budget, desktops per GPU | memory, cores, a microVM budget | machines | macOS VM slots, memory, disk |
| Stop and start | yes | yes, by hibernating | yes | yes | no | yes, by suspending or saving |
| Warm guests | started clones | hibernated clones | none: a box is ready in about a second | none: a box is ready in under half a second | free machines | suspended macOS VMs, saved Windows VMs |

### Proxmox LXC

Code in [src/backends/proxmox-lxc/](../src/backends/proxmox-lxc/), with
what Proxmox backends share in [src/backends/proxmox/](../src/backends/proxmox/):
the API client, ownership tags, TLS pin and settings. Set up by
[setup/proxmox-lxc](../setup/proxmox-lxc/README.md).

- A box is an unprivileged container, a linked clone of a CT template
  (`linux`, a GPU or CPU desktop, or the Wayland desktop), with `nesting=1`
  for Docker and `/dev/net/tun`. Root builds the templates; the API token
  only clones, configures, starts, stops and deletes in its pool.
- An acquire clones, sets the address, cores and memory, writes the
  description that names the install and box, then the tags (`bb-box`,
  `install.<id>`, `box.<id>`, `kind.<kind>` and the rest), starts the box,
  grows its disk if asked, and waits for SSH. Boxes get static addresses
  from a range, round-robin, with no DHCP.
- A template's build ID is a tag that clones copy. A warm box from another
  build is not handed out, and `maintain()` replaces it. A clone that finds
  its template away while `build.sh --replace` swaps it waits up to 10 s.
- A GPU desktop that started on the CPU path is released and tried on
  another GPU's template. On the GPU path the backend resizes the screen
  with `xrandr --fb`, which `x0vncserver` cannot.
- Each change to a guest tries again for up to 2 minutes while another
  Proxmox task holds the guest's lock.
- A warm box serves only a box with its cores, as a running container
  takes new cores only when Proxmox next rebalances CPUs.

### Proxmox QEMU

Code in [src/backends/proxmox-qemu/](../src/backends/proxmox-qemu/), on
the same Proxmox client. Set up by
[setup/proxmox-qemu](../setup/proxmox-qemu/README.md), on a host set up for
Proxmox LXC.

- A box is a linked clone of a Windows template that is not generalized
  ([039](decisions/039-windows-desktops-are-clones-of-a-template-that-is-not-generalized.md)).
  Its address reaches Windows in the SMBIOS serial, which `boot.ps1` reads
  at each boot. A larger disk grows before the VM starts, and the acquire
  extends C: over it.
- Commands run over OpenSSH in PowerShell 7, elevated, as the template's
  administrator `box`. The QEMU guest agent is for readiness only.
- The desktop is the VM's console through the API's VNC proxy. The VirtIO
  GPU driver ignores a viewer's size, so the backend sets the mode through
  a desktop command, no smaller than 800x600.
- Cua Driver runs elevated in the desktop session, on the pipe
  `\\.\pipe\cua-driver`.
- A stop hibernates the VM to a state volume, and a start resumes it with
  its apps open, then sets Windows' clock. Warm VMs are hibernated clones,
  tagged `warm`, as Proxmox refuses a hibernated VM's config changes; a
  claim resumes one, then gives it the box's tags.

### Docker

Code in [src/backends/docker/](../src/backends/docker/). Set up by
[setup/docker](../setup/docker/README.md), and on Windows by
[setup/docker-wsl](../setup/docker-wsl/README.md) or Docker Desktop.

- bb-box runs the `docker` CLI on BB's server, against a local daemon, one
  over `ssh://`, or a BB machine's through the Docker relay. It reaches a
  box only through `docker exec`, so BB's server needs no network path to
  a box ([031](decisions/031-docker-boxes-are-reached-through-docker-exec.md)).
- A box is a container named `bbbox-<box ID>`, with labels set at creation
  that name the backend, install, box, thread, name and kind. Its size is
  `--cpus` and `--memory`; it shares the host's disk, so a disk size is
  refused. It runs under `--init` with the image's start script and no
  systemd ([013](decisions/013-docker-boxes-run-unprivileged.md)), with
  `/run` as a tmpfs and the restart policy `unless-stopped`.
- A box is privileged, with Docker's data on an anonymous volume, unless
  `privileged` is off ([041](decisions/041-every-linux-box-has-docker.md)).
  Its start script listens on Docker's socket, so `dockerd` starts with the
  first `docker` command, then writes `/run/bb-box/ready`, which bb-box
  waits for before it runs BB's bootstrap.
- A GPU desktop gets one GPU through CDI. As it is privileged, it sees
  every GPU, so its start script points Xorg at the one placed, by its PCI
  bus ID (#283).
- Images are built on the Docker host by `setup/docker/build.sh`, from the
  Proxmox LXC template's guest scripts; bb-box never pulls one. On a BB
  machine, bb-box builds what is missing or out of date itself.

### microsandbox

Code in [src/backends/microsandbox/](../src/backends/microsandbox/). Set up
by [setup/microsandbox](../setup/microsandbox/README.md)
([053](decisions/053-microsandbox-runs-light-linux-boxes-as-microvms.md)).
It is an option beside Docker, for boxes that need a kernel of their own,
never the default: it stays last in the backend order, so a box gets a
microVM only when it asks for this backend.


- bb-box runs its own `msb` on one host: Linux with KVM, or a Mac with
  Apple silicon on the Hypervisor framework; BB's server, one over `ssh://`,
  or a BB machine through the msb relay. It installs the release it pins,
  0.7.7, checked by its SHA-256, in a folder of its own there, with `msb`'s
  state and images, the first time it needs it.
- A host offers the kinds of its architecture, from its facts, kept in
  storage for the next start: `linux` and `linux-desktop-cpu` on x86_64,
  `linux-arm64` and `linux-arm64-desktop-cpu` (040) on arm64, as a Mac.
- On a host without Docker to import an image from, as a Mac, bb-box builds
  it there in a builder microVM, `bb-box-builder-<id>`, from `docker:dind`
  pinned by digest, with `setup/docker/build.sh --arch` for the host's
  architecture, moves it into `msb` (`docker save` in the builder, `msb load`
  on the host), and removes the builder. One build runs at a time; a box of
  its kind is refused as `no_capacity` until it is done, so the registry
  tries the next offer, such as Tart.
- On such a host the nightly refresh (049) rebuilds the images too: the
  backend's `build` makes a new one in a builder with `--bb-url`, under
  `<image>:refresh-<time>`; a trial box of it, `bbbox-image-<id>`, runs
  Docker's check; and `replace` puts it under the image's name with
  `msb save` into `msb load`, as `msb` has no tag command, which share their
  layers. The images' `room` asks for 80 GiB free on the volume `msb` keeps
  them on, measured through any link, so a short host's image waits rather
  than fails. On a host with Docker it lists no builds: `msb` imports
  Docker's.
- A box is a microVM named `bbbox-<box ID>`, with labels set at creation
  that name the backend, install, box, thread, name and kind; `msb modify`
  changes the thread and name when the box changes hands. Its size is
  `--cpus`, `--memory` and `--root-disk`, a sparse disk of 32 GiB unless a
  size is asked for. `/run` is a tmpfs, and its network profiles are
  `public,private`, which reach BB's server on a private or tailnet address.
- With Docker on, as by default, `/var/lib/docker` is an ext4 disk of the
  box's own, as overlayfs cannot sit on `msb`'s root. bb-box makes it in
  its folder's `disks`, sparse, with its inode tables and journal left for
  the kernel to initialise (3 ms, about 5 MB), passes it with
  `--mount-disk`, and deletes it with the box; the upkeep removes one left
  by an acquire that stopped part way. `msb`'s own disk for a box formats
  it whole, which made 20 creates at once 2 to 3 s slower. On a host
  without `mkfs.ext4`, as a Mac, bb-box makes one such disk as a template
  instead, in its folder's `templates`, from a small microVM that sees that
  folder (with a quota above the disk's size, as `msb` gives a shared
  folder 4 GiB), and each box's disk is a clone of it (`cp -c` on APFS,
  reflinks elsewhere); a box made before the template exists gets `msb`'s
  own. The image's start
  script starts `dockerd` with the first `docker` command
  ([041](decisions/041-every-linux-box-has-docker.md)). It needs no
  privilege on the host: each box has its own kernel.
- `msb`'s agent runs the image's start script at the first boot only, so
  `start` runs it again through `msb exec` after `msb start`, then waits for
  `/run/bb-box/ready`.
- Commands, copies and the desktop's stream go through `msb exec --stream`,
  which gives output as it comes. `msb exec` of a stopped box boots it for
  the command, so the transport's probe asks `msb ping` first. As over SSH,
  what a command leaves running survives its `msb exec` only with `nohup`
  and its output redirected.
- Images come from Docker on the host, built by `setup/docker/build.sh`:
  bb-box imports a kind's image with `docker save` and `msb load` at its
  first box, and again when Docker's image ID changes; bb-box never pulls
  one.
- Capacity is the host's memory, less a reserve and the memory of the
  running bb-box microVMs, its cores, and a most-boxes budget counting every
  install's. `msb` reserves no memory and takes back what a guest frees.
  There is no warm pool yet.
- A guest keeps its page cache in its own RAM, which the host cannot share
  or take back, and enrolment fills it. At each boot bb-box sets the guest's
  `page_reporting_order` to 0, so it reports free memory to `msb` in pages
  rather than 2 MiB blocks, and each upkeep, every 3 minutes, has each
  running box whose load is under half its cores and with over 256 MiB
  cached drop its caches and compact its memory. An enrolled idle box then
  held 0.5 to 0.65 GiB of the host, where it held 1.6 to 1.9 GiB (053).

### SSH host pool

Code in [src/backends/ssh-pool/](../src/backends/ssh-pool/). Set up by
[setup/ssh-pool](../setup/ssh-pool/README.md), which installs the helper,
`machine.sh` or `machine-mac.sh`, the only thing bb-box runs as root.

- bb-box logs in as an admin user whose key is `restrict`ed and whose sudo
  rule allows only the helper. The helper reads and prints `key=value`
  lines, and holds a lock on the machine while it acts.
- A box is a new user on the machine, `bbx-<generation>`. Ownership lives
  on the machine, in `/var/lib/bb-box` (`/var/db/bb-box` on a Mac): the
  reset generation and an `owner` marker, written before the user is made.
  A release renames it to `resetting`, so a cut-short reset is finished.
- A reset removes the user and everything it owns. With `reset=machine`,
  it runs the operator's whole-machine reset first, which is what gives the
  pool's boxes Docker, when every machine has one.
- Capacity is one `machines` limit. A claim takes the smallest free
  machine of the size, then one without a whole-machine reset, then the one
  free longest.
- **Macs** ([047](decisions/047-a-physical-mac-is-an-ssh-pool-machine-lent-with-a-new-user-at-its-console.md))
  lend `macos` and `macos-desktop`. The next box's user is made and signed
  in at the console before the claim, through the automatic login, which
  needs FileVault off; on macOS 27 the reset restarts user space for it. The
  desktop is Screen Sharing with the viewer's input through `MacInput`. A
  Mac with Xcode adds the features `xcode` and `ios-simulator`. A Mac
  without FileVault off, Full Disk Access or its box user at the console
  is out of service.

### Tart

Code in [src/backends/tart/](../src/backends/tart/): settings in
`config.ts`, the scripts it runs on a Mac in `host.ts`, Windows in
`qemu.ts`, and the desktop holder in `vnc-holder.ts`. Set up by
[setup/tart](../setup/tart/README.md).

- bb-box reaches each Mac over SSH as a host user, with its host key
  pinned, and each VM through the Mac as the jump host. VMs sit on the
  Mac's own NAT.
- A box's VM is `bb-box-<box ID>`. Its owner file,
  `~/.bb-box/tart/owners/<VM>`, is written with noclobber before the clone
  and removed after the delete. `tart run` runs detached, with its exit
  status in `~/.bb-box/tart/run/<VM>.exit`, which `stopped()` reads with
  macOS's crash report.
- Capacity per Mac: at most two macOS VMs, counting every VM Tart runs
  there (Apple's licence and the Virtualization framework's limit; Linux
  VMs do not count); memory less a reserve; and disk. A macOS or Linux box
  keeps its image's disk.
- **macOS** boxes stop by suspending. Warm VMs are suspended clones, which
  take no slot and no memory until claimed. A warm VM serves while its
  image's build, the default size, Tart's version and the Mac's macOS
  build are the ones it was filled with. The desktop is Tart's VNC server,
  which crashes the VM on a second connection in a run, so a holder on the
  Mac makes the run's only connection and serves every viewer (#406).
- **Linux** boxes (040) are clones of a second image, built from the
  Proxmox template's guest scripts for arm64. Tart cannot resume a Linux
  VM, so a stop shuts it down, and there are no warm Linux VMs.
- **Windows** boxes (046) run in QEMU with HVF, as a second engine of the
  backend, so one survey counts every VM's memory and disk. A box is a
  qcow2 overlay on the image's current build, saved to a file when
  stopped; warm VMs are saved the same way.
- A project's image is built on the Mac of its boxes, and its boxes there
  are clones of that build, never warm VMs (#439).

## Planned

- **Joining a tailnet**
  ([050](decisions/050-a-box-can-join-the-operators-tailnet-as-an-ephemeral-node.md)):
  a box, opted in by kind, image or acquire, joins the operator's tailnet
  as an ephemeral node, with a one-off key from an OAuth client, and leaves
  it on release or stop. Built so far: Proxmox LXC templates have
  `/dev/net/tun`.
- **microsandbox**, next
  ([053](decisions/053-microsandbox-runs-light-linux-boxes-as-microvms.md)):
  spares made ahead, from forks only on hosts with reflinks, as a fork on
  ext4 copies the box's disk and is slower than a new box; the Wayland
  desktop; and arm64 boxes on a Mac.
- **Clouds**
  ([055](decisions/055-cloud-boxes-run-on-cloud-hosts-first-and-a-cloud-vm-per-box-later.md)):
  a cloud VM that runs Linux works today as a Docker host, through BB, or
  as a pool machine. Next, a cloud backend makes Docker and microsandbox
  hosts on Hetzner Cloud, then AWS, and places boxes on them; a cloud VM
  per box comes later, for Windows and GPU desktops.
- **Desktop streams** ([056](decisions/056-linux-x11-desktops-add-a-selkies-stream-and-rfb-stays-for-the-rest-tuned.md)):
  Linux X11 desktops add a Selkies display, H.264 over WebSockets, which
  the relay carries message by message with the same control; and Tart's
  holder sends each viewer updates only as it asks. Built so far: X11
  desktop templates and images run Selkies on `127.0.0.1:5980` in the box,
  which takes about 0.1% of a core while no viewer is connected.

## The conformance suite and the doctor

([009](decisions/009-conformance-suite-and-doctor.md))

- **The conformance suite** (`test/conformance/`) runs the same checks
  against every backend, skipping what a kind does not declare, never by
  backend name. [Writing a backend](development.md#the-conformance-suite)
  lists them.
- **The doctor** checks each backend end to end, and core's own parts,
  with a stable ID per check and what to do when one fails. It runs from
  the settings page, the panel and `bb box doctor`, and never prints a
  credential. The checks are in the [reference](reference/checks.md).
- **Each backend's setup** is a guide and the scripts it runs, which the
  settings page links, the guide first
  ([016](decisions/016-changes-from-building-v1.md)).

## Open questions

| Question | Where it is answered |
| --- | --- |
| Whether Cua's references survive a new proxy session; macOS 26's window-picker consent; driving the iOS Simulator; Cua's background input on real Xorg | the experiments in [computer use](research/computer-use.md) |
| What a stand-in Mac could not show: that a person's Accessibility step lets the input helper post events with System Integrity Protection on, the reset's sweep with it on, the console's size with no display, Cua's first capture for a new user, and Xcode with the Simulator's first boot | the live check on a Mac set aside, in [047](decisions/047-a-physical-mac-is-an-ssh-pool-machine-lent-with-a-new-user-at-its-console.md#the-live-check) |
| Whether BB's plugin WebSocket will give `bufferedAmount` | [BB request 2](bb-requests.md#2-send-backlog-on-plugin-websockets) |
| Selkies on a GPU desktop: NVENC and NvFBC in a box, and their GPU memory | step 3 of [056](decisions/056-linux-x11-desktops-add-a-selkies-stream-and-rfb-stays-for-the-rest-tuned.md#plan-of-prs) |
| Whether a Docker host that is an LXC container passes TUN to privileged boxes, and how long a tailnet join takes | the first PRs of [050](decisions/050-a-box-can-join-the-operators-tailnet-as-an-ephemeral-node.md#to-verify-in-the-first-prs) |
