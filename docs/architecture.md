# Architecture

How bb-box fits together: its parts, the backend interface, a box's life, and
how you and the agent use a box. The reasons behind each choice are in
[decisions](decisions/README.md).

## The rule

bb-box's core does not care who the provider is
([001](decisions/001-provider-agnostic-core.md)). A hypervisor, a container
host, a Mac, a pool of physical machines, a cloud or a sandbox runtime is a
backend behind one interface. The core is tested against every backend by one
conformance suite, so the rule is checked, not assumed.

## Parts

```
BB app (panel, desktop viewer)          BB server
          |                                 |
          v                                 v
+-------------------- bb-box plugin, on the BB server ---------------------+
| Core: registry, lifecycle, sweep, agent tools, panel, settings, doctor,  |
|       desktop relay, shared control, BB enrolment, in-box scripts per OS |
|------------------------------+-------------------------------------------|
| Transports                   | Backends                                  |
|  command: SSH, docker exec   |  built: proxmox-lxc, proxmox-qemu,        |
|    (guest agent later)       |    ssh-pool, tart, docker                 |
|  routes: tcp, command,       |  planned: mac (physical), clouds, ...     |
|    websocket                 |                                           |
+------------------------------+-------------------------------------------+
          |                                 |
          v                                 v
     inside each box                  each provider's API
```

| Part | Folder | Owns | Never |
| --- | --- | --- | --- |
| Core | `src/core/` | box records, lifecycle, sweep, tools, panel, relay, enrolment, computer use, in-box scripts | names a provider, hypervisor, container technology or transport |
| Transports | `src/transports/` | running commands, copying files, opening a route to a port in a box | knows which provider made the box |
| Backends | `src/backends/<type>/` | acquire and release, address, capacity, ownership records, which transports and displays reach each box, `doctor` | runs anything in a box for the core |

- bb-box is a BB plugin with no service of its own
  ([002](decisions/002-bb-is-the-coordinator.md)). The plugin calls each
  provider's API from the BB server.
- Everything that runs inside a box goes through the command transport and is
  written once per guest OS: POSIX sh for Linux and macOS, PowerShell for
  Windows. That covers enrolment, the thread's environment, `run`, file
  copies, computer use and the reset of a real machine's box user.
- Several backends can be active at once, and several can offer the same
  kind (see [Kinds and offers](#kinds-and-offers)).

## Interface v1

The interface the core, transports and backends are built to. It came from
reviewing the first draft against Docker, an SSH host pool, Tart, a physical
Mac and Windows on Proxmox QEMU
([011](decisions/011-interface-v1.md)). The types are in
[src/backends/types.ts](../src/backends/types.ts) and
[src/transports/types.ts](../src/transports/types.ts); the sketch at the end
of this section is the reference.

### Backend methods

A backend declares its nature (virtual or real) and its kinds, and implements:

| Method | Does |
| --- | --- |
| `kinds()` | the kinds it offers, with capabilities |
| `capacity(kind, size, pending)` | whether one more box of that size fits, with the limits of each host, and a message saying what is full |
| `acquire(box, previous, hooks, signal)` | makes or claims a guest, starts it, and returns when its command transport answers, within the kind's `readyTimeoutMs` |
| `release(guest, hooks)` | deletes a virtual guest, or resets a real machine and returns it to the pool |
| `power(guest)` | `running`, `stopped` or `unknown` now, not from a listing that may lag; null when the guest is gone |
| `start?`, `stop?` | only where the provider can; the panel and tools offer them only when present |
| `stopped?(guest)` | why a guest stopped when bb-box did not stop it, such as its VM process's exit status and crash report, and whether the guest did not choose it (#406) |
| `held()` | every guest this install holds for boxes, with the owner recorded at the provider ([018](decisions/018-guests-name-their-install-and-box.md)) |
| `stamp?(boxId, guest)` | records this install on the guest of a box from before install IDs, and returns the guest with its box ID |
| `asOffered?(guest, kind, createdAt)` | whether the guest comes from what the kind is offered from now, so a box gains what a release adds to its kind (see [Capabilities](#capabilities)) |
| `transports(guest, kind)` | the command transport, the displays, and how the thread reaches the box |
| `doctor()` | checks the setup end to end and says what is missing |
| `maintain?()` | upkeep, such as topping up a warm pool, on every sweep and when the configuration is applied; a call during a run starts one more after it |
| `members?()`, `returnToService?(ref)` | pool members and their state; puts back a machine the operator has fixed |

A real backend also states what a release restores: `home` (the box user's
home is recreated) or `machine` (reimaged or restored from a snapshot).

Every method must be safe to repeat: the registry retries after a restart and
the sweep repeats releases.

Each guest names the install and the box it belongs to
([018](decisions/018-guests-name-their-install-and-box.md)). Where a
provider reuses references, as Proxmox reuses VMIDs, `power`, `start`,
`stop` and `release` first check that the guest still names the box in
`Guest.data.box`. Otherwise `power` returns null, `release` does nothing,
and `start` and `stop` throw `gone`.

### Kinds and offers

- A kind ID is a shared word that names what the kind promises, never what
  it lacks. Several backends may offer the same kind. A kind without a
  desktop has no qualifier, and a desktop kind says `desktop`
  ([027](decisions/027-a-kind-says-when-it-has-a-desktop.md)). The default
  kind is `linux`.
- The IDs before 027, `linux-headless` and `linux-headless-docker`, stay
  accepted wherever an ID comes in: tool input, configuration, stored
  records and guests' kind tags. Core maps them to the new IDs where they
  come in, so backends and views see only the new ones.
- `linux-docker` and `linux-arm64-docker` are aliases of `linux` and
  `linux-arm64` with the feature `docker`. An acquire through one takes
  only offers that have it. Every Linux image has Docker, started on first
  use; an offer or box without it shows "No Docker"
  ([041](decisions/041-every-linux-box-has-docker.md)).
- An offer is a backend and a kind. The registry tries the offers of a kind
  in the order the backends are listed in the configuration, and takes the
  first with capacity. The box records both.
- An acquire may name its provider with `on`: the provider's name as
  `box_list` gives it, its backend ID, or its one host's name. Then the
  registry tries that offer only, and refuses rather than place the box
  elsewhere ([044](decisions/044-a-box-can-be-asked-for-on-one-provider.md)).
  `on` will also take a list, of which the first with room in acquire
  order takes the box; the New box form sends one when its filters hide
  some providers.
- Offers of one kind must agree on what the agent relies on: `os`, `arch`,
  `gpu`, the computer-use driver, `enrol`, whether there is a desktop display,
  and the features the kind requires (`requires`). Each offer's `features`
  include the required ones and may add more, which the panel and `status`
  show for each box. Transports may differ. `doctor` warns when
  offers do not agree ([012](decisions/012-offers-may-add-features.md)).

| Kind | Promises | Offered by |
| --- | --- | --- |
| `linux` | Linux, no GPU | Proxmox LXC, Docker, an SSH pool machine |
| `linux-desktop` | a Linux desktop with a GPU | Proxmox LXC on a GPU host, Docker with NVIDIA's container toolkit |
| `linux-desktop-cpu` | a Linux desktop without a GPU | Proxmox LXC from a CPU-only desktop template, Docker |
| `linux-desktop-wayland-cpu` | a Linux desktop on Wayland without a GPU, where X11-only apps do not run | Proxmox LXC from a CPU Wayland desktop template, Docker (048) |
| `linux-arm64` | Linux on arm64, no GPU | Tart |
| `linux-arm64-desktop-cpu` | a Linux desktop on arm64 without a GPU | Tart |
| `windows-desktop` | a Windows desktop, no GPU | Proxmox QEMU |
| `windows-arm64-desktop` | a Windows desktop on arm64, no GPU | Tart's Macs, in QEMU (046) |
| `macos` | macOS, no GPU | Tart, a Mac in an SSH pool (047) |
| `macos-desktop` | a macOS desktop, no GPU | Tart, a Mac in an SSH pool (047) |

- An SSH pool offers `linux` on Linux machines, and `macos` and
  `macos-desktop` on Macs ([047](decisions/047-a-physical-mac-is-an-ssh-pool-machine-lent-with-a-new-user-at-its-console.md)).
  Docker runs on a local daemon, a host over `ssh://`, such as a Windows PC
  with Docker Engine in WSL2, or a BB machine
  ([042](decisions/042-a-docker-host-can-be-a-bb-machine.md)).
- A pool's macOS offers have the features `xcode` and `ios-simulator`
  while every Mac serving them that answered the last survey has Xcode and
  an iOS runtime (047). Tart's image has Xcode's command line tools only,
  so its offers have neither.
- A kind's ID names its architecture when it is not the OS's usual one:
  `-arm64` follows the OS, and the rest is the x86_64 kind's. An agent
  asking for `linux` never gets arm64, where amd64 images and x86_64
  binaries fail
  ([040](decisions/040-linux-on-arm64-has-kinds-of-its-own.md)).
  Windows on arm64 is `windows-arm64-desktop`
  ([046](decisions/046-windows-on-a-mac-runs-in-qemu-in-the-tart-backend.md)).
- "No GPU" means no scarce GPU is taken. Macs render with Metal, and Tart
  through its paravirtualised GPU, so macOS kinds declare `gpu: false`.
- A `linux-desktop` box whose display fell back to the CPU
  ([006](decisions/006-gpu-desktop-on-xorg.md)) does not meet its kind. The
  backend releases it and tries another GPU within the kind's
  `readyTimeoutMs`, or reports that none is left and names
  `linux-desktop-cpu`. New desktops avoid that GPU for 10 minutes while
  another is left ([020](decisions/020-control-belongs-to-a-viewer.md)).
  `linux-desktop-cpu` boxes come only from CPU-only templates or images,
  which have no GPU device nodes or driver. Every desktop shows its display
  mode and the reason as facts.
- On Proxmox LXC `x0vncserver` refuses a viewer's resize on a
  `linux-desktop` screen, which has no RandR outputs, so the backend resizes
  it with `xrandr --fb`
  ([021](decisions/021-desktop-resize-through-the-backend.md)).
  `linux-desktop-cpu`, and a `linux-desktop` box back on the CPU, take the
  viewer's resize themselves. Both desktops resize to the viewer while you
  hold control.
- A Wayland desktop, `linux-desktop-wayland-cpu`, is Sway, headless, with
  floating windows and Waybar's taskbar, streamed by wayvnc
  ([048](decisions/048-a-wayland-desktop-is-sway-with-floating-windows-streamed-by-wayvnc.md)).
  wayvnc refuses a viewer's resize, so the backend runs the display script's
  `resize`, which sets Sway's output size and fits the windows into it, in
  about 20 ms. Xwayland is off, as one X11 window hides every window from Cua,
  so X11-only apps need `linux-desktop-cpu`. A Wayland desktop on the GPU, and
  Hyprland, wait for the host's `nvidia-drm` module to have `modeset=1`.
- Docker comes with Proxmox LXC (`nesting=1`) and Tart's Linux VMs, and
  with the Docker backend's boxes when they are privileged, as they are by
  default but for GPU desktops.
  A box user in the `docker` group is root on the machine, so an SSH pool
  gives Docker only if its reset restores the whole machine
  (`restores: "machine"`). Rootless Docker kept in the box user's home may
  allow it after a home reset; that is untested.
- Each kind sets `readyTimeoutMs`, the longest an acquire may take: 30 s
  for an LXC box, 60 s for a Docker box or a pool machine, 3 min for a
  Windows VM and 5 min for a Tart VM.

### Capabilities

| Capability | Values | The core uses it to |
| --- | --- | --- |
| `os` | `linux`, `windows`, `macos` | pick the in-box scripts |
| `arch` | `x86_64`, `arm64` | tell the agent what runs there |
| `gpu` | yes or no | show GPU status and count GPU capacity |
| `features` | words such as `docker`, `systemd`, `xcode`, `ios-simulator` | let the agent choose a kind, and show each box's extras |
| `command` | the command capability below, or none | offer `run` and file copies |
| `displays` | a list of `{id, protocol, resizable}`, empty for a box without a desktop | load the viewer client before the box exists, and allow resizing |
| `computerUse` | `{driver, version, socket}`, or none | offer the computer tools, and reach the driver in the box ([015](decisions/015-computer-use-through-cua-driver.md)) |
| `enrol` | yes or no | enrol the box as a BB machine |

A box records its kind's capabilities, `requires` and label when it is
acquired. When the plugin starts, and after a change to the configuration,
the core gives each box what its kind has now, so a release that adds a
capability, such as computer use, reaches boxes made before it. It does so
only where the backend's `asOffered` says the guest comes from what the
kind is offered from now; a backend without it is assumed to match. The
guest's size, address and facts stay as they were made.

- Proxmox records the template's build ID with each guest when it is
  cloned. On LVM-thin, `build.sh --replace` keeps a template's VMID while
  clones of the old build keep running, so the VMID alone does not say
  which build a guest came from. A guest matches while its template is
  still one of the kind's and has the build it recorded.
- A guest from before builds were recorded matches if it was made after
  its template's build began. With no build tag on the template, the box
  keeps what it has.
- Docker, Tart and SSH pool kinds have capabilities fixed in code, not set
  per image, so an older box gets what a new one would. A pool's Mac box
  does only while its own Mac answered the last survey, as a Mac kind's
  Xcode features follow the Macs that did (047).

The command capability:

| Field | Meaning |
| --- | --- |
| `transport` | a name for people: `ssh`, `docker`, `guest-agent`. The core never branches on it |
| `shell` | `sh` or `powershell`, the language of the in-box scripts |
| `admin` | the box user can become root or Administrator |
| `inDesktopSession` | commands already run in the logged-in desktop session. False for OpenSSH and WinRM on Windows, which run in session 0, and for SSH on macOS, which runs outside the login session and its Accessibility and Screen Recording permissions |
| `streaming` | output arrives while the command runs. False for the QEMU guest agent, which returns output when the process exits |

- A kind enrols only when its shell is `sh` and its OS is Linux or macOS. BB's
  installer is a POSIX sh script, and its host app does not run on Windows
  yet ([BB requests](bb-requests.md)).
- A kind with no command transport can still be viewed and released. A kind
  that cannot enrol still runs commands through the transport.
- A kind with computer use needs a command transport with `spawn`, which
  keeps a command running with its stdin and stdout as a byte channel. SSH
  and `docker exec` have it; the QEMU guest agent does not.

### Reaching inside a box

`transports(guest, kind)` returns three things:

- `command`: the command transport, or none.
- `displays`: the box's displays, one per stream (`desktop` now; a second
  display or the iOS Simulator later).
- `access`: how the thread's own machine reaches the box, for `ssh <box name>`
  and `DOCKER_HOST`. Null when only the BB server can reach it.

**Routes.** A route says how to reach one port inside a box, as plain data:

| Route | Holds | For example |
| --- | --- | --- |
| `tcp` | host and port | a box on a network the BB server reaches |
| `command` | a command whose stdin and stdout carry the bytes | `ssh -W 127.0.0.1:5900 <host>`, `docker exec -i <container> socat - TCP:127.0.0.1:5900` |
| `websocket` | URL, headers, subprotocols, and optionally a certificate fingerprint to pin or a CA to trust | Proxmox's `vncwebsocket` with its one-time ticket, Orchard's port-forward |

- `openRoute(route)` in `src/transports/route.ts` is the only code that opens
  a route. It returns a byte channel with backpressure.
- A route is made for each connection, because it may hold a short-lived
  secret such as a single-use console ticket. Routes are never logged or sent
  to the browser.
- A command transport may offer `route(port)`, a route to a TCP port inside
  the box: SSH gives `ssh -W`, Docker gives `docker exec` with `socat`, so
  `socat` is in every Docker image. A backend uses it to build a display that
  is served inside the box.

**Displays.** Each display has an ID, a label, a protocol (`rfb` or
`selkies`), whether it can resize, and `open()`, which returns a route and the
authentication the box expects (none, a VNC password, or a user and password
for Apple's). A display whose
stream server cannot resize may offer `resize()`, which the relay calls
beside the viewer's own request, one at a time per box with the latest size
last ([021](decisions/021-desktop-resize-through-the-backend.md)). A display
may set `minSize`, the smallest size a viewer may set: the relay raises a
smaller SetDesktopSize to it, and the viewer scales the desktop down. Linux
and Windows desktops set 800x600. Xvnc sets the raised size and answers that
it did, and noVNC asks again while that differs from its pane. So the relay
sends a raised size asked for again with no screens: Xvnc refuses that
layout, and noVNC stops asking. QEMU reads only the size. noVNC asks for one
size at a time and does not ask again when QEMU answers that it passed a
request on, so the viewer has noVNC check its pane once the pane's size has
held for 250 ms: the last frame of a pane opening is not lost.

- For RFB the relay does the security handshake with the box itself: it
  answers VNC authentication (security type 2) with the password, or Apple's
  (type 30) with the user and password, then offers the viewer RFB 3.8 with
  security type None only. Passwords and tickets never reach the browser; BB
  has already authenticated the viewer.
- macOS Screen Sharing, which a pool's Macs use (047), gives a client with
  only the VNC password a session of its own at the login window. So the
  relay signs in as the box's user with Apple's type 30, which shows that
  user's console, and Screen Sharing's VNC password stays off. Type 30 is
  Diffie-Hellman in the server's group, whose shared secret's MD5 is the
  AES-128 key for the user and password, as noVNC does it. On macOS 27,
  Screen Sharing ignored the viewer's keyboard and pointer this way: a
  blocker, with its fallbacks in 047's live check.
- wayvnc, which streams a Wayland desktop (048), offers no VNC password,
  so the relay signs in there with type 30 too, as the user `box`.
- Windows uses RFB through Proxmox's console: nothing to install in the
  guest, the same noVNC client, and it shows the console session the agent
  uses. `vncproxy` returns a one-time ticket, which authorises the WebSocket,
  and a one-time password, which the relay answers as the VNC password. The
  route trusts the API's certificate as the backend's API calls do, by its
  fingerprint or its CA, not the `cert` in `vncproxy`'s answer. Windows'
  VirtIO GPU driver ignores a viewer's resize, so the backend sets the mode
  in the desktop session, no smaller than 800x600
  ([039](decisions/039-windows-desktops-are-clones-of-a-template-that-is-not-generalized.md)).
  RDP is not planned. It needs a gateway and a second client, and an RDP
  login moves the session off the console, so you and the agent could not
  share one desktop.

**SSH access** gives host, port, user, the host keys, and an optional jump
host (the Mac host for Tart, a bastion for a pool). The SSH transport is built
from it and reaches the target through the jump host with `ProxyCommand`
(`ssh <options for the jump> -W %h:%p`), so each hop has its own key and
known_hosts file ([016](decisions/016-changes-from-building-v1.md)).

- A real machine's host keys are pinned at setup.
- A fresh virtual guest has no known key yet. The transport accepts any key
  and does not record it.
- With a jump host, pinned keys are checked on both hops. A fresh Tart VM
  behind a pinned Mac is reached with the Mac's key checked and the VM's
  accepted.
- Commands to one box share a connection where the backend gives the
  transport a directory for its sockets, as Proxmox LXC does. Only the first
  pays for SSH's handshake: about 0.1 s on a local network, more through a
  jump host. bb-box starts it with `ControlMaster=yes -N`, one at a time,
  and ssh keeps it until it has been idle for two minutes. bb-box stops
  using it 10 s before then, puts at most 8 commands on it at once, since
  sshd allows 10, and dials alone beyond that. A command waits for the
  connection to open no longer than its own timeout, or until it is
  aborted, and then dials alone. A command that exits with 255, or that the
  transport stops at its timeout, retires the connection; after a
  connection cannot be made, commands dial alone for 5 s. ssh removes the
  socket when the connection ends, as when the box restarts, and a
  connection whose socket has gone is retired too. Keepalives every 5 s end
  a connection to a box that died without closing it within about 20 s. A
  box too busy to answer for less, as one near its memory limit during a
  big build, keeps its commands. A probe always dials afresh, so it says
  whether the box answers.
  The ready check opens the shared connection instead, so the box's first
  commands, such as its enrolment's, skip the handshake. The backend closes
  a box's connections, retired ones too, before it stops or releases the
  box, as another box may take its address, and all of them when it is
  disposed.

**Output and the desktop session.**

- `onOutput(chunk, from)` gives bytes, and says whether they came from stdout
  or stderr. A transport that cannot stream calls it once per stream when the
  command exits.
- A run ends when the script's shell exits, even while something it left in
  the background holds the output open, as bash's subshell for
  `cd web && nohup server >log 2>&1 &` does. `CommandLine` in
  [src/transports/process.ts](../src/transports/process.ts) runs a POSIX
  script in a child shell, with stdin from `/dev/null` when none is given,
  then writes a random end mark and the exit status to stdout and stderr.
  The command line holds the mark in two halves, so a script that prints
  command lines, as `ps aux` does, never ends its run early. Once both marks
  arrive, the run returns and stops the local command, such as `ssh`.
  Output written after the mark is dropped.
- On a Windows box, whose shell is PowerShell,
  [src/transports/powershell.ts](../src/transports/powershell.ts) puts the
  script base64-encoded in a script block, so none of its quotes reach the
  command line. The run exits as sh would: with the script's own exit, else
  the last native command's code when its last statement failed, else 1 when
  that failed, else 0. A script too long for Windows' command line of 32,767
  characters goes to a file in the box first, over stdin. These runs have no
  end mark yet, so they end when the output closes. sshd runs each command
  in a job that ends everything in it when the command exits, so each
  script can call `Start-Detached`, Windows' `nohup`, which starts a
  command through WMI, outside the job. A run also stops in the box when
  its timeout runs out, as a Linux one does under GNU `timeout`: a watchdog
  in the job ends the run's PowerShell, and the job ends the rest. The run
  then exits 1, which counts as timed out once the timeout has passed.
  File copies are PowerShell scripts too, with the file's bytes as their
  stdin or stdout. A relative path, or one that starts with `~`, is under
  the box user's home, and a file's mode does not apply.
- The agent's `run` tool takes `session: "desktop"` to start something in the
  desktop session, such as an app to test. The core wraps the script in its
  helper for the OS unless the transport already runs there: `DISPLAY` and the
  session bus on Linux, `launchctl asuser` on macOS
  ([030](decisions/030-a-mac-runs-desktop-commands-through-launchctl-asuser.md)),
  an unelevated one-off scheduled task with an interactive logon on
  Windows, whose output comes back at exit
  ([039](decisions/039-windows-desktops-are-clones-of-a-template-that-is-not-generalized.md)).

### Guests

A guest is the backend's handle on a box's machine: its own reference, the
host it is on (a Proxmox node, a Docker host, a Mac), its address, and `data`,
small values the backend needs later, such as a per-claim user or published
ports. The registry stores `data` with the box and passes it back. It never
holds a secret. Where references can be reused, `data.box` holds the box ID
from the claim on ([018](decisions/018-guests-name-their-install-and-box.md)).
A backend with several hosts set up alike, such as Tart's Macs, lists them
in its configuration, and `host` names one
([029](decisions/029-configuration-is-one-checked-document.md)). A Docker
backend has one host, so each Docker host is a backend of its own
([042](decisions/042-a-docker-host-can-be-a-bb-machine.md)).

### Capacity

A box needs its memory, disk and slot on one host: two Macs with one free VM
slot each, and 8 GiB free on only one of them, have no room for a 16 GiB VM.
So `capacity` reports named limits per host, plus the warm pool for the kind.

| Resource | Unit | Used by |
| --- | --- | --- |
| `memory`, `disk` | MiB | every virtual backend |
| `cpu` | count | backends that reserve cores |
| `guests` | count | Tart (two macOS VMs per Mac, counting every macOS VM on it, not only bb-box's), a Docker container budget, Proxmox's guest ID range |
| `gpu-desktops`, `gpu-memory` | count, MiB | GPU desktops, one limit per GPU |
| `machines` | count | real pools: held, resetting and out of service, of the total |

Each limit has `used`, `total` (none when there is no known ceiling, as for
Docker without a budget) and `reserve`, the part kept back for the host.

### Sizes

A box's size is chosen when it is made
([028](decisions/028-a-box-size-is-chosen-when-it-is-made.md)): cores,
memory and root disk, where a disk of null is the backend's base.

- Each kind has the presets `small`, `medium` and `large`, a default preset
  and a largest custom size, in bb-box's configuration, the same on every
  offer. The configuration's kinds part changes them per kind.
  `box_acquire` and `bb box acquire` take a preset or a custom size; core
  refuses one above the largest, or one of a Linux kind with less than
  2 GiB memory, as BB's daemon uses about 260 MB in a box. The kinds part
  may still make a Linux preset smaller, and the doctor then warns.
- The backend gets the size in `BoxIdentity.size`, and `capacity` is asked
  about that size, with the kind and size of each box still being acquired.
  An offer that cannot make it says so in capacity's message, and the
  registry tries the next.
- A virtual backend makes the size asked for. A pool claims its smallest
  free machine of at least that size. A machine has a size's memory when
  its OS reports at least 90% of it, since the firmware and kernel keep
  some. `Guest.size` is what the box has, read from the guest, so a
  restored record has it.

### Real pools and release

- `release` gets hooks. `resetting()` records "being reset" before the
  machine is touched, so a restart finishes the reset rather than handing out
  a dirty machine. `timing()` reports each step.
- `members()` lists each machine with its host, kinds, state (`free`, `held`,
  `resetting` or `out-of-service`), the reason, since when, and its reset
  generation. The panel shows them, and `returnToService(ref)` puts back a
  machine the operator has fixed.
- A reset ends by writing a marker on the machine with a new generation
  number, and recording the same number in the pool store. The box keeps its
  machine's generation in `Guest.data.generation`, and `release` does
  nothing when the stored generation has moved on, so a repeated release of
  an old box never resets the machine the next box holds. Before handing a
  machine out, a claim checks that the numbers match, the box user has no
  processes, its home matches the skeleton, no BB machine is enrolled and no
  owner marker is left. For a desktop kind, the box user must also own the
  console session. If any check fails, the machine goes out of service with
  the reason, and the claim tries the next one.
- A `PoolStore` must not assume a guest's labels or tags can change after
  creation. Docker sets labels only when it creates a container (backend,
  install, box, kind), so `held()` finds every container this install made.
  Docker has no warm pool, as a box is ready in about a second
  ([031](decisions/031-docker-boxes-are-reached-through-docker-exec.md)).

### Doctor and setup

- `doctor()` returns a summary, checks and notes, as built. Each check has a
  stable `id` (for example `docker.daemon` or `pool.<machine>.host-key`) and a
  status: `ok`, `warn`, `fail`, or `skipped` after an earlier failure.
- The conformance suite runs `doctor()` first, and skips a backend whose
  checks fail, printing them.
- A doctor checks each host's room for a box of its kinds' default size. It
  warns about a host or machine that could not hold a kind's default size
  even when empty, by its cores and its memory less what it keeps free, and
  says which of the kind's presets it can hold: one that holds none takes a
  box of the kind only at a smaller custom size. The fix is smaller presets
  or a larger machine (029, #74).
- Each driver names its setup guide and scripts. The guide is the entry
  point: the settings page links it first, then the scripts in the order the
  guide runs them ([016](decisions/016-changes-from-building-v1.md)). Drivers
  give repository paths, and core makes the links from one repository URL.

### Types

```ts
// src/transports/types.ts
export type GuestOs = "linux" | "windows" | "macos";
export type Arch = "x86_64" | "arm64";
export type DisplayProtocol = "rfb" | "selkies";

/** A two-way byte stream with backpressure. */
export interface ByteChannel {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

/** How to reach one port inside a box. May hold secrets: never log it or send it to the browser. */
export type Route =
  | { readonly type: "tcp"; readonly host: string; readonly port: number }
  | { readonly type: "command"; readonly argv: readonly string[] }
  | {
      readonly type: "websocket";
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
      /** SHA-256 of a self-signed certificate to pin. */
      readonly fingerprint?: string;
    };

/** src/transports/route.ts, the only code that opens a route. */
export declare function openRoute(route: Route, signal?: AbortSignal): Promise<ByteChannel>;

export type DisplayAuth =
  | { readonly type: "none" }
  | { readonly type: "vnc-password"; readonly password: string }
  /** macOS Screen Sharing's sign-in, RFB security type 30 (047). */
  | { readonly type: "apple"; readonly user: string; readonly password: string };

export interface Display {
  readonly id: string;
  readonly label: string;
  readonly protocol: DisplayProtocol;
  readonly resizable: boolean;
  /** Called once per viewer connection: tickets can be single use. */
  open(signal?: AbortSignal): Promise<{ readonly route: Route; readonly auth: DisplayAuth }>;
  /** Sets the size the backend's own way, when the stream server cannot (021). */
  resize?(size: { readonly width: number; readonly height: number }, signal?: AbortSignal): Promise<void>;
}

export interface SshAccess {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** known_hosts lines. Pinned for a real machine; empty for a fresh virtual guest. */
  readonly hostKeys: readonly string[];
  readonly jump?: SshAccess;
}

export interface StreamOptions {
  readonly stdin?: string | Uint8Array;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  onOutput(chunk: Uint8Array, from: "stdout" | "stderr"): void;
}

export interface CommandTransport {
  // probe, run, stream, writeFile and readFile as built. `kind` is dropped:
  // the capability's `transport` is the one name. Plus:
  /** A route to a TCP port inside the box. */
  route?(port: number, signal?: AbortSignal): Promise<Route>;
  /** A long-running command whose stdin and stdout are the channel (015). */
  spawn?(script: string, signal?: AbortSignal): Promise<ByteChannel>;
  /** The box user's login shell on a PTY on BB's server, for a person's terminal. */
  terminal?(size: TerminalSize, signal?: AbortSignal): Promise<Terminal>;
}

// src/backends/types.ts
export interface CommandCapability {
  readonly transport: string;
  readonly shell: "sh" | "powershell";
  readonly admin: boolean;
  readonly inDesktopSession: boolean;
  readonly streaming: boolean;
}

/** Offers of a kind agree on the driver; each template pins its version. */
export interface ComputerUse {
  readonly driver: "cua";
  readonly version: string;
  /**
   * Where `cua-driver serve` listens: a Unix socket, or a named pipe on
   * Windows. A leading `~/` is the home of the user the driver runs as (047).
   */
  readonly socket: string;
}

export interface KindCapabilities {
  readonly os: GuestOs;
  readonly arch: Arch;
  readonly gpu: boolean;
  /** This offer's features: the kind's `requires`, and any extras. */
  readonly features: readonly string[];
  readonly command: CommandCapability | null;
  readonly displays: readonly { readonly id: string; readonly protocol: DisplayProtocol; readonly resizable: boolean }[];
  readonly computerUse: ComputerUse | null;
  /** Only when command.shell is "sh" and os is linux or macos. */
  readonly enrol: boolean;
}

export interface BoxKind {
  /** A shared word: several backends may offer the same kind. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** The features every offer of this kind has. */
  readonly requires: readonly string[];
  readonly capabilities: KindCapabilities;
  readonly readyTimeoutMs: number;
}

/** Cores, memory and root disk (028). */
export interface BoxSize {
  readonly cores: number;
  readonly memoryMiB: number;
  /** Null: the backend's base disk, the template's, image's or host's. */
  readonly diskGiB: number | null;
}

export interface BoxIdentity {
  readonly boxId: string;
  readonly threadId: string;
  readonly name: string;
  readonly kind: string;
  readonly createdAt: number;
  /** The size asked for, always complete. */
  readonly size: BoxSize;
}

export interface Guest {
  readonly ref: string;
  /** Which host of the backend: a Proxmox node, a Docker host, a Mac. */
  readonly host: string | null;
  readonly address: string | null;
  /** The size the box has, read from the guest; null when unknown. */
  readonly size: BoxSize | null;
  /**
   * Stored with the box and passed back. Never a secret. Where references
   * can be reused, `box` holds the box ID (018).
   */
  readonly data?: Readonly<Record<string, string | number | boolean>>;
  /** Shown in order by status and the panel, such as the display mode. Never a secret. */
  readonly facts?: readonly { readonly label: string; readonly value: string }[];
}

export type PowerState = "running" | "stopped" | "unknown";

/** Why a guest stopped without bb-box's request (#406). */
export interface StopReason {
  readonly reason: string;
  /** The guest did not choose it: its VM crashed or was killed, or its host restarted. */
  readonly crashed: boolean;
  readonly at: number | null;
}

export interface BoxTransports {
  readonly command: CommandTransport | null;
  readonly displays: readonly Display[];
  readonly access: { readonly ssh: SshAccess | null; readonly dockerHost: string | null } | null;
}

export interface Capacity {
  readonly ok: boolean;
  /** What is full and what to release, for the user. Null when ok. */
  readonly message: string | null;
  /** Null for a real backend, whose free machines are its `machines` limit. */
  readonly warm: { readonly ready: number; readonly target: number } | null;
  readonly hosts: readonly HostCapacity[];
}

export interface HostCapacity {
  readonly host: string;
  readonly ok: boolean;
  readonly limits: readonly Limit[];
}

export interface Limit {
  readonly resource: "memory" | "disk" | "cpu" | "guests" | "gpu-desktops" | "gpu-memory" | "machines";
  /** Which one, where there are several: a GPU's index or UUID. */
  readonly id?: string;
  readonly used: number;
  /** Null when there is no known ceiling. */
  readonly total: number | null;
  readonly reserve: number;
  readonly unit: "MiB" | "count";
}

export interface ReleaseHooks {
  resetting(): Promise<void>;
  timing(step: string, ms: number): void;
}

export interface PoolMember {
  readonly ref: string;
  readonly host: string | null;
  readonly kinds: readonly string[];
  readonly state: "free" | "held" | "resetting" | "out-of-service";
  readonly reason: string | null;
  readonly since: number;
  readonly generation: number;
}

export interface Backend {
  readonly id: string;
  /** Shown to users, for example "Proxmox LXC on pve1" or "Docker on devpc". */
  readonly label: string;
  /** Where its boxes run, by name; empty for a pool or a local Docker daemon. */
  readonly hosts?: readonly string[];
  readonly nature: "virtual" | "real";
  /** Real backends: what a release restores. */
  readonly restores?: "home" | "machine";
  kinds(): readonly BoxKind[];
  /** Real backends: free machines for a kind, from the last survey, with no call. */
  free?(kind: string): number | null;
  capacity(
    kind: string,
    size: BoxSize,
    pending: readonly { readonly kind: string; readonly size: BoxSize }[],
    signal?: AbortSignal,
  ): Promise<Capacity>;
  acquire(box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest>;
  release(guest: Guest, hooks: ReleaseHooks, signal?: AbortSignal): Promise<void>;
  power(guest: Guest, signal?: AbortSignal): Promise<PowerState | null>;
  start?(guest: Guest, signal?: AbortSignal, timing?: (step: string, ms: number) => void): Promise<void>;
  stop?(guest: Guest, signal?: AbortSignal): Promise<void>;
  stopped?(guest: Guest, signal?: AbortSignal): Promise<StopReason | null>;
  held(signal?: AbortSignal): Promise<HeldGuest[]>;
  stamp?(boxId: string, guest: Guest, signal?: AbortSignal): Promise<Guest>;
  relabel?(guest: Guest, box: BoxIdentity, from: string, signal?: AbortSignal): Promise<void>;
  asOffered?(guest: Guest, kind: string, createdAt: number, signal?: AbortSignal): Promise<boolean>;
  /** What its boxes take that another backend's must not, for the doctor. */
  footprint?(): Footprint;
  transports(guest: Guest, kind: string): Promise<BoxTransports>;
  doctor(signal?: AbortSignal): Promise<DoctorReport>;
  maintain?(signal?: AbortSignal): Promise<void>;
  members?(signal?: AbortSignal): Promise<readonly PoolMember[]>;
  returnToService?(ref: string, signal?: AbortSignal): Promise<void>;
  dispose?(): Promise<void>;
}

export interface Footprint {
  /** Guest IDs it may use, such as a Proxmox cluster's VMIDs. */
  readonly ids?: { readonly scope: string; readonly first: number; readonly last: number };
  /** Addresses its boxes may get, such as those on one node's bridge. */
  readonly addresses?: { readonly scope: string; readonly list: readonly string[] };
}

export interface DoctorCheck {
  /** Stable, for example "docker.daemon". */
  readonly id: string;
  readonly name: string;
  readonly status: "ok" | "warn" | "fail" | "skipped";
  readonly detail: string;
  readonly fix: string | null;
}

export interface BackendDriver<C = unknown> {
  // type, label and nature as built. `settings` gives way to (029):
  /** One line on what the backend is for, shown while it is off. */
  readonly description: string;
  /** The kinds its backends can make, which take warm counts. */
  readonly kinds: readonly string[];
  /** The backend's fields, named within it; the settings page renders them. */
  readonly fields: Readonly<Record<string, FieldDescriptor>>;
  /** The fields of each host, for a backend with several hosts set up alike. */
  readonly hostFields?: Readonly<Record<string, FieldDescriptor>>;
  /**
   * Sets of fields that, all empty, take the values of the first other
   * backend of type `from`, such as Proxmox QEMU's connection from Proxmox
   * LXC. A set goes whole, so no connection mixes values from both.
   */
  readonly inherits?: { readonly from: string; readonly sets: readonly (readonly string[])[] };
  /**
   * For a type with several backends, one per host (042): the host its
   * fields name. Two backends on one host are refused.
   */
  readonly several?: (fields: Readonly<Record<string, unknown>>) => string;
  /** Reads the backend's part of the configuration. */
  parse(part: BackendPart): ParsedBackend<C>;
  /** Built again only when its fields, inherited too, or the install ID change. */
  create(config: C, context: BackendContext): Backend;
  /** Paths in the repository, linked from the settings page, the guide first. */
  readonly setup: { readonly guide: string; readonly scripts: readonly string[] };
  /** The BB settings it declared before 029, read once into the document. */
  readonly earlier?: {
    readonly settings: Readonly<Record<string, PluginSettingDescriptor>>;
    read(values: Readonly<Record<string, unknown>>): EarlierBackend | null;
    sizes?(values: Readonly<Record<string, unknown>>): Readonly<Record<string, BoxSize>>;
  };
}

/**
 * BB's setting descriptor, including `secret: true`, plus where the page
 * puts the field. Fields show in the order they are declared.
 */
export type FieldDescriptor = PluginSettingDescriptor & {
  /** `boxes`: what boxes are made from or run on, such as templates or images. */
  readonly group: "connection" | "credentials" | "boxes" | "advanced";
};

/**
 * A backend's fields and hosts in the configuration document. Switches and
 * warm counts reach the backend through its context instead.
 */
export interface BackendPart {
  readonly id: string;
  /** Every declared field: set, inherited or its default, secrets included. */
  readonly fields: Readonly<Record<string, string | number | boolean | undefined>>;
  /** `name` is `Guest.host`; it cannot change while the host has boxes. */
  readonly hosts: readonly { readonly name: string; readonly fields: Readonly<Record<string, string | number | boolean | undefined>> }[];
}

/** The switch leaves the settings, and each problem names its field. */
export type ParsedBackend<C> =
  | { readonly ok: true; readonly config: C }
  | { readonly ok: false; readonly problems: readonly FieldProblem[] };

export interface FieldProblem {
  /** A path within the backend's part, such as `url` or `hosts.0.address`; "" for the whole backend. */
  readonly path: string;
  readonly message: string;
}

/**
 * The functions read the configuration as it is at the call, so a change to
 * a switch, a warm count or a kind's sizes never builds the backend again.
 * Backends call them when they need them, and keep no copy.
 */
export interface BackendContext {
  /** The type for a type's first backend, else `<type>:<name>`. */
  readonly id: string;
  readonly storage: BackendStorage;
  /** This install's ID, recorded on every guest it makes (018). */
  readonly installId: string;
  /** What the configuration says now about one of the backend's kinds. */
  kind(id: string): KindSettings;
  /** Warm guests to keep of a kind; 0 while the backend or the kind is off. */
  warm(kind: string): number;
  /** Whether new boxes may go on this host. */
  hostOn(name: string): boolean;
  /** BB machines reached through BB (042); absent where there is no BB. */
  readonly machines?: MachineAccess;
  /** The warm pools an upkeep that ran to its end left short for want of room (#356). */
  warmShortfalls(short: readonly WarmShortfall[]): void;
  logError(operation: string, error: unknown): void;
}

/** A BB machine as a backend reaches it, through bb-box and BB (042). */
export interface MachineAccess {
  /** The docker CLI's host: a unix socket on BB's server, relayed to the machine. */
  dockerHost(hostId: string): string;
  /** Listens on that socket; fails at once when BB shows the machine offline. */
  ready(hostId: string): Promise<void>;
  /** The machine's name as BB has it, or null while bb-box does not know it. */
  name(hostId: string): string | null;
  /** Whether BB shows it connected, with no call to it; null for no such machine. */
  connected(hostId: string): Promise<boolean | null>;
}

export interface KindSettings {
  /** The kind and this backend are both on: new boxes of it may come here. */
  readonly enabled: boolean;
  /** The size of a box made with no size asked for. Warm guests wait at it. */
  readonly defaultSize: BoxSize;
  /** Every preset's size, the default's among them, smallest first. */
  readonly presets: readonly BoxSize[];
}

// Unchanged: BoxOwner, HeldGuest, AcquireHooks, DoctorReport,
// BackendError, BackendStorage, RunOptions, RunResult.
```

## A box's life

```
requested -> acquiring -> starting -> ready -> enrolled
                                        |  ^
                                   stop |  | start      (you or the agent)
                                        v  |
                                      stopped

any state -> releasing -> released     (release, or the thread is archived or deleted)
```

1. **Requested.** The registry asks each backend that offers the kind for
   `capacity` for the box's size, in the configuration's order, and uses the
   first one with room. An acquire that names a provider asks that one
   only, and one that names several asks only those (044).
   If none has room you see the backend's message, which says what is full
   and what to release. The registry records the box and returns at once.
2. **Acquiring.** In the background, the backend claims a guest with
   `hooks.claim` before it makes or changes anything, so a restart can resume
   and the sweep can find it.
3. **Starting.** The guest exists and is booting (`hooks.starting`). Each
   step's time goes to `hooks.timing` and shows in the box's status.
4. **Ready.** The command transport answers.
5. **Enrolled.** If the kind can enrol, bb-box enrols the box as a BB machine
   and the thread's environment reaches it (see Thread access). The time from
   ready to enrolled shows after the start-up steps' times, as BB enrolment.
6. **Released.** You or the agent release the box, or its thread is archived
   or deleted ([003](decisions/003-boxes-live-until-released.md)). bb-box
   removes the machine from BB, then the backend releases the guest. A missing
   guest counts as released. A box a thread is working on is released or
   stopped only when forced
   ([034](decisions/034-a-working-thread-holds-its-box.md)). Every release
   logs one line saying why: who released it, that its thread ended, or
   what bb-box needed, as trimming spares or making room.

| | Virtual | Real |
| --- | --- | --- |
| Acquire | clone and start a guest, or take one from the warm pool | claim a free machine, prepare the box user |
| Ready | the transport answers | the transport answers as the box user |
| Stop and start | yes, where the provider can | usually not |
| Release | delete the guest | end the box user's processes, recreate its home, return the machine |
| If release fails | the sweep retries | the machine is held back from the pool and flagged for the operator |

Stopping and starting a box is something you or the agent choose, to free
memory or GPU while keeping the disk. It never happens on a timer.

## Warm pool

A warm pool keeps ready guests of a kind so that acquire is only a claim. A
real backend's pool of free, reset machines is the same thing
([004](decisions/004-acquire-and-release.md)).

- `ReadyPool` in [src/backends/pool.ts](../src/backends/pool.ts) picks a free
  member that can serve the kind and makes sure only one box holds it.
- Each backend brings a `PoolStore` for membership. Proxmox LXC keeps it in
  guest tags; real backends keep it in the backend's plugin storage.
- The target size is set per backend and kind in the configuration, 0 by
  default, and the backend reads it with `context.warm(kind)`. `maintain()`
  tops the pool up after each claim, when the configuration is applied
  (#355) and on every sweep, and never below the backend's memory and disk
  reserves. It runs one at a time, and a call during a run starts one more
  after it, as the run may have read a count or a pool from before the
  call. An off backend or kind keeps no warm guests.
- An upkeep that runs to its end gives `context.warmShortfalls()` each pool
  it left below its count because no host had room, with the reason an
  acquire would be told (#356). bb-box logs a pool when it falls short, when
  the reason's words change and when it has room again, not at each sweep;
  the doctor warns of each short pool; and the settings page reads them in
  `ConfigState.backends[].warmShort`, as `{ kinds, count, have, reason }`.
- Warm guests wait at their kind's default size, from `context.kind(kind)`
  (029). One that cannot serve the default after the operator changes it,
  such as a Proxmox LXC guest with other cores, is retired and made again.
- A warm guest counts against capacity and fits when claimed. One made
  larger on claim needs room for the difference
  ([028](decisions/028-a-box-size-is-chosen-when-it-is-made.md)). Proxmox
  LXC hands a warm guest only to a box with its cores: a running container
  takes new cores only when Proxmox next rebalances CPUs, up to 10 s later.
- A warm guest must be a clone of what its template is now. Proxmox LXC's
  `build.sh` tags each template with a build ID of its own, which warm
  guests copy when they are filled. A warm guest whose template has another
  ID, or is away while it is replaced, is not ready: capacity does not count
  it, no claim takes it, and `maintain()` retires it.
- Tart's warm VMs are suspended, so two VMs per Mac are never spent on idle
  ones. A suspended VM counts only in `disk` (about 5.5 GiB at the small
  preset) until a box takes it; then it needs a VM slot and its memory, as a
  clone does, so a claim is placed as a clone is. A fill holds a slot and
  its memory for about 30 s, from the clone to the suspend. An acquire that
  finds a fill holding the last slot takes the fill over when its size and
  kinds suit the box, or stops it and clones, so capacity counts that slot
  as free for a box (#145). A resume takes about 4.5 s
  to a named box, against 13 to 17 s for a clone. A warm VM saved under
  another image build, Tart version or macOS build of the Mac is retired,
  as its state may not restore; one that fails to restore anyway gives way
  to a clone. Its owner file says `filling`, then `warm`, and a claim
  rewrites it with the box's fields; `held()` leaves out warm VMs and the
  ones the instance is filling, and lists a fill left by a restart with no
  owner, for the sweep to release.
- Proxmox QEMU's warm VMs are hibernated, filled once Windows' desktop and
  Cua's daemon are up. Proxmox refuses a hibernated VM's config changes,
  tags too, so the pool's membership is the `warm` tag plus, in memory, the
  VMs a claim or `maintain()` has taken. A claim resumes the VM and only
  then gives it the box's tags. A running VM tagged `warm`, as after a
  restart cut a claim short, is retired; a fill left tagged `filling` names
  no box, so the sweep releases it.
- Warm guests are not enrolled
  ([014](decisions/014-enrol-through-machine-providers.md)). A box enrols
  when it is claimed, and runs commands meanwhile. Spare boxes, which core
  keeps enrolled for the kinds the operator chooses, hide that wait. BB
  shows them in its machine list until a thread claims them
  ([032](decisions/032-spare-boxes-are-enrolled-ahead.md)).

## Thread access

A box is a resource of its thread and gets what the thread's own machine has.

- **Enrolment.** A box whose kind can enrol becomes an ordinary BB machine
  ([014](decisions/014-enrol-through-machine-providers.md),
  [research](research/enrolment-and-warm-pools.md)).
  - bb-box registers a machine provider. It creates a machine with the box ID
    as the key, and the provider's `create` runs BB's `bootstrap` through the
    box's command transport. BB issues the credential and runs its own
    installer. While the plugin restarts, BB can say for some seconds that
    it knows no such provider, so bb-box asks up to 6 times, 6 s apart,
    and the log says so.
  - Templates carry Node.js, npm, curl and a pre-installed bb-app, so the
    installer skips the download and `npm install`. On a real host with
    BB 0.44.0, a box is enrolled 5.2 to 5.5 s after it is ready, of which the
    installer takes about 5 s; bb-box asks BB for under 2 s
    ([BB request 5](bb-requests.md#5-enrol-quickly-when-bb-app-is-installed)).
    Where systemd runs, the box user has linger, or the host daemon stops
    when the installing SSH session ends. A template sets it; a pool machine
    turns it on at claim, since its reset turns it off.
  - Setting up the thread's access, below, needs only the machine's ID, so it
    runs while BB's installer does. bb-box asks BB whether the machine is
    connected every 500 ms, and every 100 ms once bootstrap has returned.
    Each enrolment logs how long each step took, from ready to enrolled, in
    `bb plugin logs bb-box`. One that bb-box follows again after a restart
    is counted from then, and the box shows no enrolment time.
  - A box the sweep restores from its guest, while it runs and answers,
    enrols again with the box ID as the key. BB gives back the machine it
    still has, whose daemon bootstrap starts again if it is disconnected, or
    makes a new one ([025](decisions/025-a-restored-box-enrols-again.md)).
    A box restored stopped, or whose guest did not answer, carries
    `restoredAt` and enrols when bb-box starts it or the sweep finds it
    answering ([026](decisions/026-a-restored-box-enrols-once-it-answers.md)).
    Each enrolment is counted from when bb-box found the box answering. A
    box whose machine was removed in BB has no mark, so it stays off.
  - Every template and image removes BB's daemon lock and PID file at boot,
    so a box that restarts after a hard stop reconnects in about 0.5 s
    ([017](decisions/017-boxes-clear-bb-daemon-state-at-boot.md)). Without
    that, it waits up to 10 s for the lock, or fails where PIDs repeat.
  - The thread's Git credentials and machine variables reach the box through
    BB, which gives them to its daemon in the box. Plugins can read their
    names but not their values, so each command bb-box runs, and each SSH
    session through the box's `~/.bashrc` (`~/.zshenv` on macOS), takes the
    listed names from a worker of that daemon as it starts: from `/proc` on
    Linux, and from `ps -E` on macOS, which reads a value holding a space
    then `NAME=`, or a backslash then three digits, wrongly
    ([BB requests](bb-requests.md), request 8). A changed value reaches the
    next command, and the values never reach the disk. The names are BB's
    machine variables, `GH_TOKEN` and the user's git identity
    (`GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`,
    `GIT_COMMITTER_EMAIL`). `git` asks `gh` for GitHub credentials, so it
    uses `GH_TOKEN`, and fetches `git@github.com:` and
    `ssh://git@github.com/` URLs over HTTPS, as on the thread's machine.
    The startup file skips the env file in a shell whose command starts
    with `: bb-box-env;`, as bb-box's commands and the shells they start
    do, since the command reads it itself. So a command reads it once, not
    once more in each shell around it, which saves about 10 ms a command on
    Linux and 60 ms on macOS (#100). Any other shell that reads the startup
    file, such as a zsh a command starts on macOS, still reads the env file,
    so it does not keep an old `GH_TOKEN`.
  - BB's daemon starts the workers that carry the variables a moment after
    BB shows the machine connected, up to about a second later on a Mac. So
    the enrolment ends once a command in the box finds such a worker, or
    30 s after the machine connects, since BB can give a new machine
    `GH_TOKEN` some seconds after its other variables. A reconnect after
    bb-box starts a box waits up to 30 s for BB to show the machine
    connected again, then in the same way. `box_run` waits up to 20 s for
    either, as `box_acquire` and `box_start` do, so its first command has
    the variables; a Mac box takes 8 to 10 s from ready to enrolled. A box
    with no names to take, or with nothing running the daemon's program,
    does not wait. If BB removes the machine during these waits, the box is
    left unenrolled.
  - BB's daemon can stop during these waits, as in a box that runs out of
    memory, so bb-box asks BB again as they end. If BB does not show the
    machine connected within 30 s of that, or of bootstrap returning, the
    enrolment fails rather than recording the box enrolled (#286). The
    reason, in `box_status` and the log, names the box's memory when it is
    under 2 GiB. The box keeps its machine until its release.
  - BB can take seconds to answer while it is busy, so bb-box asks for the
    machine's and the project's names together, first as the box starts,
    and keeps them for a minute. After that, a command gets the names it
    has while bb-box asks again in the background, so a variable added in
    BB reaches commands a minute or so later.
  - BB starts and stops its workers as it pleases: a plugin reload stops
    the ones a box has, and nothing starts them again. So bb-box has a host
    entry, which BB runs in a worker of the daemon (`src/host/access.ts`).
    For each call, BB gives the worker the daemon's current variables, and
    its "access" keeps a `sleep` started with them, so commands always find
    them. It starts a new one only when the values bb-box names change, and
    holds a lease so BB's idle timer leaves the worker alone. bb-box calls
    it before a box's first command, and again in the background 30 s
    later at most, or 2 s while BB has not given the machine `GH_TOKEN`
    yet. Commands take the values the sleep holds meanwhile, so a changed
    value arrives within that time and a call (`src/plugin/holder.ts`).
    The sleep ends with the worker, as on a plugin reload, and the next
    command waits for another, as does a command with names the sleep does
    not hold.
  - A project's own variables are only in the agent that a worker of the
    daemon starts for a thread of the project on the box, so commands take
    the variables from any process below the daemon, not only its workers.
    A box with no such thread has none of them
    ([BB requests](bb-requests.md), request 11).
- **Child threads.** A child thread can run on an enrolled box. You can
  also start a thread on a new box from BB's new-thread screen, which BB
  removes with the thread
  ([033](decisions/033-a-thread-can-start-on-a-new-box.md)).
- **Your machines.** You can add boxes in BB Box's settings that belong to
  you, not to a thread. Each is a BB machine with the name you give it,
  in BB's list and picker, and lives until you remove it
  ([036](decisions/036-your-machines-are-boxes-you-own.md)).
- **Direct access.** The agent can also reach its boxes itself, for example
  with `ssh <box name>` or `DOCKER_HOST`, over the same network the BB server
  uses.
- **No enrolment.** A kind that cannot enrol still runs commands, copies
  files and streams its desktop through the transports. Windows boxes cannot
  enrol until BB's host app runs on Windows
  ([BB requests](bb-requests.md)), so they do not get the thread's Git
  credentials and machine variables from BB, and child threads cannot run on
  them.

## You and the agent

| Surface | You | The agent |
| --- | --- | --- |
| Panel | list the thread's boxes, acquire one by kind, see status, GPU or CPU, and timings, stop, start and release | not used |
| Tools | not used | acquire, list, status, run, copy files in and out, stop, start, release, start a child thread on a box |
| Desktop | the viewer in the panel, over the relayed stream | seven computer tools: the accessibility tree first, screenshots when appearance matters |
| Control | take and hand back | its computer tools refuse while you hold control; it takes control back when you ask |

- **Desktop viewer.** Each desktop box in the panel has "Open desktop", which
  opens the box's desktop in a thread panel tab of its own, and "Open desktop
  in a browser tab", which opens it on the plugin's Boxes page. The
  Boxes page lists every box across threads, servers as well as desktops. The panel's design is in
  [docs/design/panel.md](design/panel.md). Each viewer opens one WebSocket on the plugin's
  `/desktop?box=<id>&viewer=<id>` route. The relay opens the display's route,
  answers the box's RFB authentication itself (VNC authentication with the
  password the box wrote at boot, or Apple's as the box user), offers the
  viewer security type None, and copies bytes both ways without decoding
  pixels. It always joins the desktop as a shared client, so one viewer never
  disconnects another. The panel loads the client for the stream type: noVNC
  for `rfb`
  ([007](decisions/007-desktop-stream-is-a-typed-transport.md),
  [011](decisions/011-interface-v1.md)).
- **Viewer ID.** Each viewer has a random ID kept in the browser tab's
  session storage, so a panel tab that remounts keeps the control it took.
  Two viewers open at once never share an ID. Control belongs to one viewer,
  not to you, so another tab of yours shows the desktop without input
  ([020](decisions/020-control-belongs-to-a-viewer.md)). The app keeps each
  desktop's and terminal's connection while its tab is hidden, for up to 10
  minutes, so switching back shows it at once. A hidden tab that holds
  control hands it back after 60 s
  ([037](decisions/037-a-panel-keeps-a-boxs-desktop-and-terminal.md)).
- **Shared control.** One owner of input at a time, the agent by default,
  held in the plugin's memory. The relay parses what each viewer sends and
  drops keys, pointer, clipboard writes and resizes from any viewer that is
  not the owner, so nothing in the box filters input. Update requests pass,
  so every viewer sees the desktop. Taking control in one viewer releases
  whatever another viewer of yours held down. On hand-back the relay releases
  any keys and buttons still held down, and sets the desktop back to the
  size it had while the agent had control. Control returns to the agent when
  you hand back, when your viewer has been gone for 60 s, or when the box
  ends the connection and your viewer does not connect again within 5 s
  ([008](decisions/008-shared-control.md)). Your control is kept in plugin
  storage on every change, so after a restart, as for an update, your
  viewer keeps it and the desktop's size if it connects again within 60 s
  ([045](decisions/045-a-persons-control-lasts-through-a-restart-of-the-plugin.md)).
  A take or hand-back in the old instance while the new one starts holds
  too: the new one reads control again as the first viewer connects.
  The plugin log says why the box ended the connection, and what a restart
  did with your control.
- **Pausing the agent** happens in the plugin, not the box
  ([015](decisions/015-computer-use-through-cua-driver.md)). While you hold
  control, every computer tool refuses at once without reaching the box.
  Taking control waits up to 3 s for a call in flight, then closes the box's
  computer-use session; the panel shows control as yours only after that.
  Handing back drops every reference and image, and the agent's next call
  tells it to observe again. This is cooperative: the agent can still reach
  the box over SSH. When you ask it to continue, the agent takes control
  back with `computer_take_control`, which works as a hand-back, and your
  viewer says so ([038](decisions/038-the-agent-can-take-control-back.md)).

**Computer use** ([015](decisions/015-computer-use-through-cua-driver.md),
[research](research/computer-use.md)).

- **Driver.** Cua Driver, one release pinned in each template with its
  SHA-256, with telemetry and the update check off. The pin moves only after
  the conformance suite passes.
- **In the box.** `cua-driver serve` runs in the logged-in desktop session:
  a user service on Linux, an elevated Scheduled Task at logon on Windows
  ([039](decisions/039-windows-desktops-are-clones-of-a-template-that-is-not-generalized.md)),
  a LaunchAgent that starts Cua's signed app on macOS.
- **From the plugin.** One session per box runs `cua-driver mcp --socket
  <socket>` through the command transport's `spawn`, and the plugin speaks
  MCP over it: 2 to 4 ms per call, against 165 ms for a new SSH connection.
  It opens on first use, and closes after 10 idle minutes, when you take
  control and when the box is released.
- **Tools.** The agent sees bb-box's tools, never Cua's:

  | Tool | Does |
  | --- | --- |
  | `computer_windows` | lists windows with ID, app, title and size |
  | `computer_observe` | reads a window's tree, with an optional query, limit and screenshot |
  | `computer_screenshot` | returns an image of a window or the desktop |
  | `computer_act` | clicks, double-clicks, right-clicks, scrolls or sets a value, by reference or by pixel, or presses a key chord |
  | `computer_type` | types text or a key chord, into a reference, a window's focused element, a menu or the desktop |
  | `computer_launch` | opens an app or URL and returns its window ID |
  | `computer_take_control` | takes the desktop back from a person who has finished with it, as a hand-back ([038](decisions/038-the-agent-can-take-control-back.md)) |

- **Tree text** has no frames, and uses the plugin's references such as
  `e26`. Chrome gives each word, or each letter, of a page its own `static`
  line, so a run of them becomes one line, and names made only of U+FFFC
  (object replacement) are dropped. The default budget is 300 lines, counting
  every printed line; over it, the header says how many were cut and suggests
  a query. A long article is 165 KB of text without one.
- **References** belong to the plugin. Each has a fingerprint: role, name,
  and its ancestors' roles and names; never its value. An old reference is
  found again in the latest tree, or refused if it matches none or several.
  With raw Cua tokens, a stale reference in foreground mode clicked the wrong
  element. When only names changed, as an editor's tab and text area do
  when its document is edited, an element keeps the reference of the element
  in its place: the same role, under ancestors with the same roles, at the
  same position among siblings of its role. An element or ancestor that
  shares its role with a sibling, such as a row among rows, keeps its name in
  the place, so a button in a list whose rows all changed gets a new
  reference ([022](decisions/022-references-follow-renames-not-rows.md),
  [023](decisions/023-a-reference-follows-its-element-through-its-own-rename.md)).
  Cua's tokens for a window go stale each time it is read, even for one
  element, so the next action on a reference reads the window again first.
- **A rename out of sight.** The plugin records, per reference, the role
  and name it last showed the agent, in a tree, a list of changes, a popup
  or an action's result. An action on a reference whose element has since
  been renamed, as a lone button in one spot can be after its page changes,
  is refused once with the new name and the old
  ([024](decisions/024-an-element-renamed-out-of-sight-is-refused-once.md)).
  Mousepad's text view, named after its text, has no value in Cua's tree,
  so a rule on values could not tell content from a new control.
- **Pixels.** The agent sees only pixels of images the plugin returned, at or
  under 1568 pixels on the long edge. A pixel action is accepted only against
  the latest image of that window. Each image and pixel action states the
  image's size, the window's or screen's size and the scale between them.
  The plugin passes the agent's pixels to Cua as they are. Cua maps a
  window's pixels by its latest image of the window, and the desktop's by
  its latest image of the desktop in the session. A new session, after an
  idle close or a reconnect, has none and would take pixels as the
  screen's, so before a pixel action on the desktop the plugin takes an
  image of the same size, and refuses the action if the screen's size
  changed. Cua's `capture_id`, which binds pixels to one image, serves one
  action only, so the plugin does not pass it.
- **After each action** the plugin reads the tree again and returns what
  changed. Cua cannot check a click on the desktop, so the plugin compares
  the window list before and after, and reads the window under the point
  only when its tree has at most 200 elements: a read stops at that budget,
  and a web page's full read takes 0.2 to 3 s. A window found too large is
  then only checked for popups, which takes 6 to 7 ms. When the plugin sees
  no change, it suggests a screenshot.
- **Menus and popups** are missing from the window list. A read of the
  window under them lists them, with their bounds. The plugin reads a popup
  that opened and shows its items, but only when their frames fill the
  popup's bounds: for some popups Cua gives another window's elements. A
  GTK app's menu, such as Mousepad's File menu, is one: its items show in
  its window's tree instead, and the plugin points to them there. It
  names the popup after what opened it, such as "the context menu on list
  item 'Task 3'", and says when it closes. A popup never becomes the active
  window, so keys for it go to the desktop in the foreground. The plugin
  forgets a popup once a read of its window no longer lists it: each popup
  it holds costs a read of that window on later actions on the desktop.
- **Cua's own words** name tools and codes the agent does not have, such as
  `list_apps`, `bring_to_front` or `foreground_unavailable`, and window IDs
  in hex. The plugin drops them, but not paths or file names that hold an
  underscore, and says why in its own words, with window IDs as
  `computer_windows` gives them, and when an app will not open, lists the
  apps installed in the box, without settings panels and session actions.
- **Delivery.** Background first, which does not move the shared pointer.
  When Cua refuses, in 2 to 4 ms, the plugin retries in foreground and says
  that the desktop's focus may have moved. On the desktop and in popups only
  the foreground works. On Wayland, typing and keys go only to the focused
  window, so they always go in the foreground (048).
- **An element with no action** on Wayland: Cua clicks it through X11, and
  refuses because it cannot inject input. The plugin then clicks the centre
  of the element's frame, in window pixels, and says that it did (048).
- **Element frames** are in the screen's pixels, except a GTK 3 app's on
  Wayland, which are in the window's own, as the app does not know where
  its window is. Cua says `window` for both, and does not scale either when
  its image of the window is smaller. On a Wayland box, which its kind
  says, the plugin reads a window's frames the way that puts more of them
  inside the window. On other desktops it leaves them as they are, as a
  frame above or left of the window is an element scrolled out of it (048).
- **A URL** opens in a new browser window, or in a tab of one already open,
  whose title changes. Until the page has a title, Chrome's is its address,
  so the plugin waits up to 10 s for a title that is not. A page with no
  title of its own, such as a JSON response, keeps its address, so the
  plugin then says the page may still be loading or has no title.
- **An app already open** that allows one instance, such as Mousepad, takes
  a second launch over D-Bus and may show a new document in its window
  instead of opening one. Cua then fails the launch, as no new window
  appeared. When the app had a window before, the plugin brings that window
  to the front with Cua's `bring_to_front` and returns it, saying the app
  was already open, and that its title changed when it did.
- **Two windows of one app** within about 20 pixels of each other, as Chrome
  places a new window 10 pixels from the last, get one tree from Cua: it
  finds a window's tree by where the window is, and takes the app's first
  window there. The plugin knows a tree is another window's when its frame
  bears that window's title. It then moves the window it reads 40 pixels
  from the other with Cua's `set_window_frame`, says so, and reads it again.
  A maximised window does not move: the plugin asks the agent to un-maximise
  or close one of the two.

## Clean-up and crash recovery

Nothing expires, so a box must never be forgotten.

- **Ownership is recorded at the provider** where it can be: tags on a Proxmox
  guest, labels set as the container is made for Docker, an owner file per
  VM for Tart, a marker file on a real machine. `held()` reads it back, so
  the sweep works even if bb-box's storage is lost.
- **Each install records its ID** on every guest it makes, and `held()`
  returns only that install's guests. Two BB servers, or a smoke run, can
  share a pool and never touch each other's guests. An install that lost
  its storage gets its old ID back from the doctor's note, with an operator
  command ([018](decisions/018-guests-name-their-install-and-box.md)).
- **The claim comes first.** `hooks.claim` records the guest before anything
  is made, so an interrupted acquire is always found.
- **After a restart** the registry resumes boxes that were acquiring, repeats
  releases that were interrupted, and checks the power of the rest.
- **Commands across a restart** (#405). BB aborts a plugin's tool calls when
  it updates or reloads it, then waits for its dispose hooks. `box_run` does
  not stop on that abort: bb-box's first hook takes no new commands and waits
  up to 60 s for those running, then stops the rest. On Linux and macOS each
  command runs as a job, with its output and exit status in files under
  `~/.local/state/bb-box/jobs/` that the box's next command removes once
  bb-box has them, so a stopped command goes on in the box and `box_job` gives
  its result. A job cannot tell whether bb-box got its output, as a write to a
  dropped `docker exec` still succeeds, so it never removes its own files;
  those nobody removes go after 7 days. On Windows, sshd ends a session's
  processes with it, so a command stops.
- **The sweep** runs at start and every few minutes:
  1. records this install on the guests of its boxes from before install
     IDs, through `stamp()`, once per box. A guest with no install ID that
     no box records is left to the doctor's note;
  2. releases the boxes of threads that BB says were archived or deleted,
     at this sweep and the last. A thread has ended only when BB returns it
     archived or deleted, or answers `thread_not_found`; any other error
     keeps its boxes. One answer is not enough: a wrong one, as after a
     restart, would take a live thread's boxes. So the first sweep keeps
     them and the next releases them. The answers are kept in memory, so a
     restart starts again. A thread event asks BB about the thread, and
     releases its boxes at once only when BB returns it archived or
     deleted. When BB finds no such thread, that counts as its first
     answer for the next sweep; while BB says the thread is live, or
     cannot say, the boxes stay. Each line that keeps or releases boxes
     for this gives BB's answer as it came: archivedAt and deletedAt, or
     the error's status, code and message;
  3. finishes interrupted releases;
  4. for each of this install's guests from `held()` that no record names:
     releases it when it names no box (an acquire interrupted before the
     claim was labelled) or when its box now holds another guest or none.
     Otherwise it restores the box's record from the guest while BB says
     the thread is live, releases the guest once BB says the thread ended,
     at this sweep and the last, and keeps it while BB does not say
     ([019](decisions/019-lost-records-are-restored-from-guests.md)).
     The released guest's BB machine stays until BB can find a machine by
     its key ([026](decisions/026-a-restored-box-enrols-once-it-answers.md)).
     A restored box waiting to enrol enrols once its guest answers;
  5. calls `maintain()`.

  A guest from `held()` belongs to a box record only when it names that
  box, or, with no owner yet, when the box is still acquiring. So a reused
  reference never makes the sweep treat a new box's guest as an old one's.
  No guest is released because its record is missing, and the sweep logs
  each guest it releases, restores or keeps, with the reason. The power
  `held()` lists can be older than the box, which may have started or
  stopped since, and a provider's listing can lag, so the sweep changes a
  box's state only when `power()` confirms the change.
- **A guest deleted outside bb-box** makes `power` return nothing; the box is
  marked gone and the panel says so. It stays gone when its reference is
  reused, since the new guest names another box.
- **A guest that stopped without bb-box's request**, found by the sweep, a
  status check or a command that cannot reach it, is recorded as the box's
  unrequested stop, with what the backend's `stopped()` says of it (#406).
  `box_status`, the panel and the error a caller gets say when it stopped
  and why. When the guest did not choose it, as when its VM crashed, bb-box
  starts the box again at once, unless it did so for the stop before less
  than 10 minutes before, and says so. A stop bb-box makes forgets it.
- **If the BB server is down**, boxes keep running and nothing is released.
- **If a box reboots**, its services start again, the viewer reconnects and
  control returns to the agent. This includes a reboot bb-box did not start,
  such as the host's. The sweep bootstraps a ready box's BB machine again
  when BB shows it disconnected
  ([017](decisions/017-boxes-clear-bb-daemon-state-at-boot.md)). A Mac
  that booted has BB's daemon's LaunchAgent loaded already, from the login,
  and BB's `launchctl bootstrap` fails for it with "Bootstrap failed: 5":
  bb-box then unloads it and runs the bootstrap once more (#416).

## Images

Planned
([049](decisions/049-a-project-image-is-a-script-on-the-standard-image-and-images-are-rebuilt-when-stale.md)).
Today each kind has one image per backend, built by the setup scripts.

- **The contract.** Every image has the box user with sudo, bb-box's key
  where it is reached over SSH, bb-box's boot units, BB's host app, Docker
  on first use, the desktop and Cua for desktop kinds, nothing of one
  machine, and its record. The kind's check checks it.
- **A project's image** is a script run as root on a kind's standard
  image, one script for every Linux backend. It runs at box start until
  the image has had two boxes on a backend within 14 days; then bb-box
  bakes it there. It is built in a box of the base kind, then captured: a
  template, `docker commit`, or a renamed Tart VM. A project's threads get
  it by default, and New box and `box_acquire` can choose it.
- **Written by an agent.** A person never writes the script. It lives in
  the project's repository, `.bb/box-setup.sh` by default. On request, an
  agent drafts it with `box_image_draft` from the project's
  `devcontainer.json`, Dockerfile, mise or `.tool-versions`,
  `rust-toolchain.toml` or Nix files, fills the gaps, and tries it with
  `box_image_try` in a fresh box until the checks pass. It then registers
  it with `box_image_set`. A box saved as an image is not stored, as it
  cannot be built again on a fresh base.
- **The record**, `/usr/share/bb-box/image.json`, gives the build's date,
  contract, apt snapshot, BB app's digest, tools, NVIDIA userspace and the
  script's digest, with a copy readable without starting the image.
- **Freshness.** The doctor warns when an image is old, has another BB app
  or other pins, and fails one with an older contract or another NVIDIA
  version than the host's. `bb box images refresh`, run nightly by a BB
  automation, rebuilds stale images one at a time: Linux weekly, Windows
  and macOS monthly, within each host's disk reserve. A trial box from the
  new build must pass the checks before it replaces the old one.

## Tailnet

Planned
([050](decisions/050-a-box-can-join-the-operators-tailnet-as-an-ephemeral-node.md)).
A box can join the operator's tailnet, for a project whose app talks to
the operator's machines over it.

- **Opt-in** per kind or image in the configuration, or per box from New
  box, `box_acquire` and `bb box acquire`. Spares and warm guests never
  join; a spare joins when a thread takes it.
- **The key** is a secret in the configuration's `tailnet` part: an OAuth
  client (recommended), from which bb-box creates a one-off, ephemeral,
  pre-approved, tagged key for each join, or a reusable, ephemeral,
  pre-approved, tagged auth key.
- **Joining** runs beside BB enrolment once the box is ready: a guest
  script starts tailscaled and runs `tailscale up` with the box's name as
  its hostname and `tag:bb-box`. A failed join fails the acquire. The box
  shows its tailnet name and addresses.
- **Leaving.** Release and stop run `tailscale logout` first, which removes
  an ephemeral node at once. If the box cannot, bb-box removes the node
  through Tailscale's API, or Tailscale does within an hour.
- **TUN.** Proxmox LXC templates get `/dev/net/tun` from `build.sh`; Docker
  boxes use their host's; Tart's Linux VMs have their own. Without TUN, a
  box joins in userspace mode, which takes connections but cannot dial its
  peers. The SSH host pool does not join.

## Configuration

bb-box's configuration is one checked document in its plugin storage
([029](decisions/029-configuration-is-one-checked-document.md)).

- The document lists the backends in the order the registry tries them,
  each with its fields, switch, warm counts per kind and hosts; the kinds,
  each with its switch, presets, default preset and largest size; and the
  general settings: boxes per thread, enrolment and the default kind.
- Hosts set up alike are a list inside one backend, tried in order. Separate
  backends of one type are for configurations that differ in kind; the
  first keeps the type as its ID, another is `<type>:<name>`.
- Docker may have several backends, one per Docker host, as each BB
  machine with Docker is one (042); two on one host are refused. Each
  other type has one backend for now.
- Switches for a backend, a host or a kind stop new boxes only. An off
  backend stays built, so its boxes keep working.
- A backend's part holds its fields and its hosts' fields. It reads its
  switches, warm counts and kinds' sizes through its context, as they are
  at the call, so changing them does not build it again.
- A driver may inherit sets of fields from a backend of another type. A set
  left all empty takes that backend's values, even while that backend is
  off, and the settings page says where each value comes from. Proxmox
  QEMU takes Proxmox LXC's connection and SSH key this way, since Windows
  boxes on a host use the same API token and the key `build.sh` put in the
  template.
- Secrets are stored apart from the document and are write-only: the page
  and the CLI say whether each is set.
- The settings page and `bb box config show | check | apply <file>` use the
  same RPC: `config.get`, `config.check(draft, {test})` and
  `config.apply(draft, revision)`. Every write is checked, and a revision
  stops two people overwriting each other. `show --json` is the export.
- The first start of the version that brings it moves BB's settings into
  the document once, and leaves boxes and guests as they are. It keeps a
  copy of the non-secret values it moved, which `bb box config migrated`
  prints, until the operator removes it.

## Data ownership

| Data | Lives in | Owned by | Survives |
| --- | --- | --- | --- |
| Box records: ID, thread, kind, backend, guest and its data, state, timings | plugin storage | core | restored by the sweep from the guests' labels if lost, while their threads are live; a restored box enrols again with the same key once it runs and answers |
| Which guest belongs to which box and thread | the provider (tags, names), or a marker on a real machine | backend | the plugin's storage being lost |
| Pool membership | the backend's `PoolStore` | backend | as above for tags; plugin storage otherwise |
| Configuration | plugin storage, one document | operator | exported by `bb box config show --json`; deleted by `bb plugin remove` |
| Provider credentials, and the tailnet key (planned, 050) | plugin storage, apart from the configuration | operator | never shown in output, logs or errors, nor sent to the browser |
| bb-box's SSH key | plugin storage; its public key is installed by setup | core | |
| The install ID | plugin storage, and on every guest | core | the plugin's storage being lost: the doctor shows the old ID and an operator command restores it |
| The thread's Git credentials and variables | BB | BB | resolved by BB each time they are used; read from BB's daemon in the box by each command, never written to disk or to bb-box's storage |
| Work in the box: files, containers, running apps | the box's disk | the thread | deleted on release (virtual), or the home recreated (real); not backed up |
| Templates and images | the provider | operator | built by the setup scripts; planned (049): rebuilt by bb-box when stale, and project images built by bb-box from a script in the configuration |
| Who holds each desktop's input | plugin memory, and plugin storage while a person holds it | core | after a restart, the agent's again unless the holder's viewer connects within 60 s |

Push work to Git or copy it out before releasing a box.

## Backends

How each backend fits the interface. Proxmox LXC, Proxmox QEMU (Windows),
Docker, the SSH host pool and Tart, with Windows on a Mac, are built.
Physical Macs, as SSH pool machines (047), are built and passed the live
check on a stand-in Mac, a macOS VM; a Mac set aside must still confirm
what the VM could not show. Clouds are planned, and the later-backends
research fills in the details.

| | Proxmox LXC | Proxmox QEMU (Windows) | Docker | SSH host pool | SSH host pool, Macs (047) | Apple Virtualization framework (Tart) |
| --- | --- | --- | --- | --- | --- | --- |
| Nature | virtual | virtual | virtual | real | real | virtual |
| Acquire | linked clone, start | resume a hibernated warm VM, or a linked clone of a template that is not generalized, start | create and start a container from the kind's image | claim a machine | claim a Mac, its box user already signed in | `tart clone` (copy on write), `tart run` headless |
| Release | delete | delete | remove the container | remove the box user and what it left, or restore the whole machine | remove the box user and what it left, and sign the next one in | `tart delete` |
| Command | SSH | OpenSSH for Windows with PowerShell 7 | `docker exec` | SSH | SSH | SSH through the Mac host |
| Display route | RFB over TCP | RFB through Proxmox's console WebSocket | RFB through `docker exec` and `socat` | none yet; RFB through SSH later | RFB (Screen Sharing) through SSH, signed in as the box user | RFB through the Mac host |
| Ownership record | tags | tags | labels set at creation, and the container name `bbbox-<box ID>` | marker file on the machine, with a reset generation | marker file on the Mac, with a reset generation | an owner file per VM on the Mac, written before the clone with noclobber and removed last. A warm VM's says `filling`, then `warm`, and a claim rewrites it with the box's fields, so warm VMs are claimed in it rather than renamed, since `tart rename` does not check whether a VM is running |
| Capacity limits | memory, disk, guests (the ID range), GPU | memory, disk (a hibernated VM's memory is on disk), guests (the ID range) | memory, guests (a container budget), desktops per GPU | machines | machines | guests (two macOS VMs per Mac), memory, disk |
| Stop and start | yes | yes | yes | no | no | yes |
| Enrol | yes | not until BB's host app runs on Windows | yes, without systemd | yes | yes | yes |

Notes:

- **Proxmox LXC** waits for a template that `build.sh --replace` is
  swapping, which leaves its VMID without a template for about 3 s. When a
  clone fails and the template is missing, not yet a template or locked,
  the backend waits up to 10 s for it, then clones again on the next VMID.
  The token reaches only the pool's guests, so Proxmox answers 403 for a
  VMID that is not there, and both Proxmox backends count a guest or
  template that answers 403 as missing, as one that answers 404. When the
  template is there after a failure, the clone is tried once more at once,
  as the template may have come back meanwhile. The box's timings show the
  wait as `template`, apart from `clone`. Warm guests and the capacity check
  wait the same way.
- **Docker** runs the `docker` CLI against a local socket, a Docker host
  over `ssh://`, or a BB machine's Docker. Commands, file copies and the
  desktop all go through `docker exec`, so BB's server needs no network
  path to a box
  ([031](decisions/031-docker-boxes-are-reached-through-docker-exec.md)).
  For a BB machine, set as `bb:<machine ID>` and turned on in settings,
  bb-box relays Docker's API: the CLI uses a unix socket on BB's server,
  and each connection to it is a channel, with credit-based flow control,
  on one WebSocket that the machine's host worker opens out to a route of
  bb-box's with a one-time secret. The relay opens on demand with one host
  call, and the worker holds a lease while it is open
  ([042](decisions/042-a-docker-host-can-be-a-bb-machine.md)).
  GPU desktops use NVIDIA's container toolkit through CDI. Boxes run with
  `--init` and a start script, and no systemd
  ([013](decisions/013-docker-boxes-run-unprivileged.md)). Docker inside a
  box needs a privileged container, which is root on the Docker host. Boxes
  are privileged unless the operator turns it off, or the host is rootless
  Docker ([041](decisions/041-every-linux-box-has-docker.md)). A privileged
  GPU desktop sees every GPU on the host, so its start script points Xorg
  at the one placed, by its PCI bus ID (#283). In a Wayland desktop the
  start script runs Sway, wayvnc and Cua, as the LXC template's units do,
  and the display script's `resize` runs under `docker exec` (048). Without
  systemd, BB's installer leaves its host daemon running in the background.
  After a restart, the start script removes BB's daemon lock and PID file,
  and bb-box calls `bootstrap` again, which starts the daemon
  ([017](decisions/017-boxes-clear-bb-daemon-state-at-boot.md)).
  `access.dockerHost` is null.
- **Windows** on Proxmox QEMU
  ([039](decisions/039-windows-desktops-are-clones-of-a-template-that-is-not-generalized.md))
  clones a template that is not generalized: a clone shows its desktop
  with Cua in about 30 s, and a hibernated warm VM resumes to it in about
  4 s. The backend sets the guest's clock after each resume. The box's
  address is in the VM's SMBIOS serial, which a startup task reads.
  Commands use OpenSSH with PowerShell 7, elevated; the guest agent is for
  readiness only. The desktop is Proxmox's console, so nothing is
  installed in the guest for it. Cua's daemon runs elevated in the desktop
  session, started at logon. It cannot enrol in BB until BB's host app
  runs on Windows.
- **SSH host pool** needs nothing but SSH access to each machine, directly
  or through a jump host, and an admin user that may run only bb-box's
  helper as root. Each box gets a new user, removed with everything it left
  on release; Docker needs a whole-machine reset the operator provides,
  since a box with Docker is root on the machine. The machine holds the
  truth: a marker names the install and box, and the reset generation
  moves on with each reset. Desktops and rootless Docker are not
  built yet. Macs join the pool with a helper of their own (047).
- **Physical Macs** (047) have one console session, and a box takes the
  whole Mac. Its user, new for each box, is signed in at the console before
  the claim, so a claim takes about a second. The reset sets the next user
  as the automatic login, removes the old user and what it left, and
  starts loginwindow again so the automatic login signs the next user in,
  which needs FileVault off. On macOS 27 only a userspace restart does
  that, which ends every SSH session on the Mac. Cua's grants, and Full
  Disk Access for the reset's SSH, are per Mac: a person gives them once
  at setup, or MDM gives Accessibility, and they hold through every reset.
- **Tart** images are prepared ahead on each Mac by the setup's scripts,
  from Cirrus Labs' images pulled with `tart pull`: for macOS, Cua's
  permissions written offline into the image's TCC database, automatic
  login, Xcode's command line tools, background indexing off. Several Macs
  are the backend's hosts in the configuration (029), or are managed by
  Orchard later.
  - Apple's macOS licence (section 2B(iii)) allows two macOS VMs per Mac you
    own or control, for software development, testing during development,
    macOS Server or personal non-commercial use, and not as a service bureau
    or time-sharing service. Agents developing and testing on your own Macs
    fit.
  - Windows on arm64 runs in QEMU with HVF, as a second engine of the same
    backend, so one survey of each Mac counts every VM's memory and disk.
    A box is a qcow2 overlay on an image the setup builds on each Mac,
    reached through the Mac as Tart's VMs are, and saved to a file when
    stopped. Windows VMs do not count against the two macOS VMs
    ([046](decisions/046-windows-on-a-mac-runs-in-qemu-in-the-tart-backend.md)).
  - Tart, Orchard and tart-guest-agent are under FSL-1.1-ALv2, where internal
    use is a permitted purpose. bb-box drives Tart and does not redistribute
    it.
  - The VNC port and password change on every `tart run`. The backend starts
    `tart run` detached from its SSH session, with its output in a file only
    the host user can read, and `open()` reads the file each time. The
    password never goes in `Guest.data`. A launchd job would load only in the
    GUI session of a host user logged in at the Mac.
  - Tart's VNC server (the Virtualization framework's) listens on every
    interface of the Mac, ignores SetDesktopSize, and ends the VM when a
    client asks for an update without the DesktopSize pseudo-encoding. The
    guest's own Screen Sharing gives a VNC client a separate session at the
    login window, not the logged-in desktop, so it does not fit
    ([setup guide](../setup/tart/README.md#the-desktops-vnc-server)).
  - A suspended VM holds no slot and no memory, so `stop` suspends (macOS 14
    or later on the host), and `start` resumes in about 4 s.
  - Tart runs Linux VMs too, as the arm64 kinds
    ([040](decisions/040-linux-on-arm64-has-kinds-of-its-own.md)).
    They do not count against the two-VM limit, and a clone answers SSH in
    about 5.5 s. Tart cannot resume a suspended Linux VM, so `stop` shuts
    one down.
- **Clouds, microsandbox and Crabbox** fit as virtual backends with SSH and
  instance tags; a cloud's capacity is its quota.

## Conformance suite and setup

([009](decisions/009-conformance-suite-and-doctor.md))

- **Conformance suite** in `test/conformance/`, run against a live backend
  from an env file. For each kind: capacity, acquire to ready with the hooks,
  run a command with 1 MiB of stdin, copy 32 MiB each way (so a transport with
  small limits, such as the QEMU guest agent's 64 KiB of stdin, proves it
  splits the data), enrol, stream a frame, a Mac's desktop command (in the
  `Aqua` session, with stderr apart from stdout; 030), computer use (the
  Chrome and GTK sequences from the research rig, also run when the Cua pin
  moves), stop and start where supported (the box's clock right after, and
  connected to BB again within 3 s of being ready), repeated release, and
  crash recovery (an interrupted acquire is resumed or released, and
  `held()` finds every guest). Two installs on one backend leave each
  other's guests alone, and a box whose reference is reused reads as gone
  and releases nothing (018). Steps a kind does not support are skipped by
  its declared capabilities, never by backend name.
- **Fake backend.** An in-memory backend passes the suite and backs the core's
  own tests.
- **Setup**, per backend: a short guide and the scripts it runs, which
  prepare the provider: templates or images, the network, a restricted
  credential, and bb-box's public key.
- **Settings page.** bb-box's own section on its page in BB's Tools, with a
  part per backend and its switch and hosts, and the kinds and their
  presets. A backend's guided setup tests the draft with its doctor before
  saving, and shows each check with what to do when it fails (029).
- **`doctor`** also runs from the panel and from the command line, and prints
  notes such as the public key to install. It never prints a credential.

## Open questions

| Question | Where it is answered |
| --- | --- |
| Whether Cua's references survive a new proxy session; macOS 26's window-picker consent; driving the iOS Simulator; Cua's background input on real Xorg | the experiments in [computer use](research/computer-use.md) |
| Whether a viewer can type and click through a Mac's Screen Sharing (a blocker); what a stand-in Mac could not show: the reset's sweep with System Integrity Protection on, the console's size with no display, Cua's first capture for a new user, and Xcode with the Simulator's first boot | the live check on a Mac set aside, in [047](decisions/047-a-physical-mac-is-an-ssh-pool-machine-lent-with-a-new-user-at-its-console.md#the-live-check) |
| Whether BB's plugin WebSocket will give `bufferedAmount` | [BB requests](bb-requests.md) |
| Switching the Linux desktop to Selkies' patched Xvfb | the experiment in [the GPU in a desktop box](research/gpu-desktop.md), once the host allows it |
| Whether the Proxmox API token can capture and replace templates, whether the guest scripts run again cleanly on a built template, and whether a BB script automation can run `bb box` | the first PRs of [049](decisions/049-a-project-image-is-a-script-on-the-standard-image-and-images-are-rebuilt-when-stale.md#to-verify-in-the-first-prs) |
| Whether a Docker host that is an LXC container passes TUN to privileged boxes, and how long a join takes | the first PRs of [050](decisions/050-a-box-can-join-the-operators-tailnet-as-an-ephemeral-node.md#to-verify-in-the-first-prs) |
