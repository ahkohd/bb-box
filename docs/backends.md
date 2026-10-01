# Writing a backend

A backend is where bb-box gets boxes from. The interface it implements, and
how each planned backend fits it, is in [the architecture](architecture.md)
under "Interface v1" and "Backends". This guide says what runs where, where
the code goes and how to prove a backend works.

## What runs where

One row per host and box OS. A box is a container, a VM or a physical
machine; its kinds are plain, with Docker, or with a desktop. "Working"
means merged and in daily use.

| Host | Box | Form | Backend | Kinds | Status | Arch | GPU |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Linux | Linux | container | Proxmox LXC | plain, Docker, desktop | working | x86_64 | `linux-desktop`: an NVIDIA GPU; `linux-desktop-cpu`: none |
| Linux | Linux | container | Docker | plain, Docker, desktop | working | x86_64 | `linux-desktop`: an NVIDIA GPU through CDI |
| Linux | Linux | physical | SSH host pool | plain, Docker | working | x86_64 | none offered |
| Linux | Windows | VM | Proxmox QEMU | desktop | in progress, #46 | x86_64 | none at first: Windows draws on the CPU; a whole card passed through later |
| Linux | macOS | - | - | - | not possible: macOS runs only on Apple hardware | - | - |
| Mac | macOS | VM | Tart | plain, desktop | working | arm64 | Tart's paravirtualised GPU, offered as `gpu: false` |
| Mac | macOS | physical | physical Mac | desktop | planned, #47 | arm64 | the Mac's own, offered as `gpu: false` |
| Mac | Linux | VM | Tart | plain, Docker, desktop | research, #148 | arm64; x86_64 programs through Rosetta | to research |
| Mac | Windows | VM | QEMU with HVF, UTM or Parallels | desktop | research, #150 | arm64 | to research |
| Windows | Linux | VM | Hyper-V | plain, Docker, desktop | research, #158 | x86_64 | to research |
| Windows | Linux | WSL2 distribution | WSL2 | plain, Docker | research, #158 | x86_64 | to research |
| Windows | Linux | container | Docker Desktop | plain, Docker, desktop | research, #158 | x86_64 | to research |
| Windows | Windows | VM | Hyper-V | desktop | research, #158 | x86_64 | to research |
| Windows | macOS | - | - | - | not possible | - | - |

Across the table:

- **Architecture.** Every Linux kind is x86_64 today, and every Mac box
  arm64. Each kind's capabilities name its `arch`. How a kind's ID shows
  it is open in #148.
- **Enrolment.** Linux and macOS boxes can become BB machines. Windows boxes
  cannot until BB's host app runs on Windows
  ([BB request 1](bb-requests.md#1-bbs-host-app-on-windows)).
- **Physical machines.** Linux machines join through the SSH host pool, and
  Macs through #47, planned as the same driver with a reset per OS. There is
  no plan for physical Windows machines yet.
- **Phone emulators.** The iOS Simulator runs only on Macs: on a physical
  Mac (#47), or in a Tart image with Xcode. Android emulators are in
  research (#161), for Linux hosts with KVM, Macs and Windows hosts.
- **Cloud hosts.** A cloud VM that runs Linux is a Linux host above:
  the Docker backend over `ssh://` and the SSH host pool reach one today. A
  backend that makes cloud VMs itself is later, with no issue yet.

## Where the code goes

| Part | Folder | Holds |
| --- | --- | --- |
| Core | `src/core/` | the registry, lifecycle, sweep, in-box scripts, tools and panel. It never names a provider or transport |
| Transports | `src/transports/` | SSH, routes and `openRoute`, and the ready check. They never know which provider made a box |
| Backends | `src/backends/<type>/` | one driver per provider, plus what several share: `ReadyPool` and `KvPoolStore` in `pool.ts`, the Proxmox API client in `proxmox/` |

The core uses only [src/backends/types.ts](../src/backends/types.ts) and
[src/transports/types.ts](../src/transports/types.ts).

## Adding a backend

1. Create `src/backends/<type>/` with a `BackendDriver`:
   - `type`, which is also the ID of the first backend of the type;
   - `label`, `description` and the `kinds` its backends can make;
   - `fields`, and `hostFields` for a backend whose hosts are set up alike:
     BB's setting descriptors, each with a group (`connection`,
     `credentials`, `boxes` or `advanced`), in the order the settings page
     shows them. A secret field is kept apart from the configuration;
   - `parse`, which turns the backend's part of the configuration into a
     typed config, or problems each at its field;
   - `setup`, the path of its guide and of the scripts it runs, in order.
     The settings page links the guide first, then the scripts;
   - `create`, which builds the `Backend`. Its context gives the backend's
     ID, its storage, and its warm counts, kinds and hosts as the
     configuration has them now. A switch or a count changes them without
     the backend being built again, so read them when needed.

   A backend that kept BB settings before the configuration document (029)
   also has `earlier`: those settings, and how to read them once into the
   document.
2. Reuse a transport from `src/transports/`, or add one there. A backend
   that serves a display inside the box builds it from the command
   transport's `route(port)`. A kind with computer use needs a command
   transport with `spawn`, which carries the driver's MCP session.
3. Record ownership at the provider (tags, names or a marker file), so
   `held()` finds every guest even if bb-box's storage is lost. Record the
   box's ID, thread, name, kind and creation time, which the sweep restores
   a lost record from
   ([019](decisions/019-lost-records-are-restored-from-guests.md)). Record
   `context.installId` with it from the first write, on warm and part-made
   guests too, and list only this install's guests in `held()`
   ([018](decisions/018-guests-name-their-install-and-box.md)).
4. Write `doctor()` so that it checks everything the backend needs and says
   how to fix each failure. Give each check a stable ID.
5. Add the driver to `DRIVERS` in
   [src/backends/index.ts](../src/backends/index.ts).
6. Add `setup/<type>/` with the guide and its scripts. Keep deployment
   values out: the guide uses example addresses and names. Templates and
   images remove BB's daemon lock and PID file at boot
   ([017](decisions/017-boxes-clear-bb-daemon-state-at-boot.md)).
7. Test it against a fake of the provider's API, as
   `test/proxmox-lxc.test.ts` does with `test/fake-proxmox.ts`, and run the
   conformance suite against it.

Nothing else changes. The registry, tools, panel and sweep pick up its
kinds.

## Rules the registry relies on

- Call `hooks.claim(guest)` before making or changing anything, so a
  restart can resume and the sweep can find the guest.
- If acquiring fails, release what was claimed before throwing.
- Make every method safe to repeat. A missing guest counts as released.
- Where the provider can reuse a reference, keep the box ID as
  `Guest.data.box` from the claim on, and check before acting that the
  guest at the reference still names this install and that box, or no box
  for an ownerless leftover. If it does not, `power` returns null, `release`
  does nothing, and `start` and `stop` throw `gone`. Add `stamp()` if your
  guests can predate install IDs.
- Guests of another install, or with none, still count against capacity.
- A real backend calls `hooks.resetting()` before it touches the machine,
  and puts the machine out of service if the reset fails. Keep the pool
  member's generation in `Guest.data`, so a repeated release of an old box
  never resets a machine that the next box holds.
- Put what a person should know about a box, such as a desktop's display
  mode, in `Guest.facts`. Status and the panel show them in order. Like
  `data`, they are stored with the box and are never a secret.
- Throw `BackendError` with `no_capacity`, `unsupported` or `gone` when the
  registry should act on it. Any other error is shown as it is, so its
  message must make sense to a person and never include a credential.
- Offers of one kind must agree on what the agent relies on. The doctor
  warns when they do not (`offerChecks` in
  [src/backends/index.ts](../src/backends/index.ts)).

## The conformance suite

[test/conformance/suite.ts](../test/conformance/suite.ts) runs the same checks
against any backend: doctor first, then for each kind acquire, transports, a
spawned channel, commands with 1 MiB of stdin, streaming, 32 MiB copied each
way, enrolment, Docker, displays, stop and start (with the box's clock right,
and connected to BB again within 3 s of being ready), recovery by a new
instance, repeated release and interrupted acquires. It also checks that two
installs on one backend leave each other's guests alone, and, given a `reuse`
hook that makes the backend hand out a reference again, that the old box reads
as gone and its release leaves the new box alone. The size check measures a
box as soon as it is ready, after filling any warm pool the run's settings ask
for, so the box can come from it; the pool stays for the next run, and a run
with a target of 0 removes it. Steps a kind does not declare are skipped by
its capabilities; any other skip gives its reason.

[test/fake-backend.ts](../test/fake-backend.ts) is an in-memory backend,
virtual or real, that passes the suite and backs the core's own tests.
[test/conformance.test.ts](../test/conformance.test.ts) runs the suite
against it, against Proxmox LXC with a fake API, against Tart on a fake
Mac, and against Docker on a fake Docker host.

```sh
node --test test/conformance.test.ts
```

## Proxmox LXC

- Virtual. Code in [src/backends/proxmox-lxc/](../src/backends/proxmox-lxc/).
  What any Proxmox backend uses is in
  [src/backends/proxmox/](../src/backends/proxmox/): the API client, for
  containers or VMs, the ownership tags and description, the TLS pin, and
  the connection, VMID range, address and SSH settings.
- The host side, templates and API token are set up by
  `setup/proxmox-lxc/`, whose guide lists the settings.
- Ownership lives in Proxmox tags (`bb-box`, `install.<id>`, `thread.<id>`,
  `box.<id>`, `kind.<kind>`), and in the description the clone writes, which
  names the install and the box before the tags are set.

## Proxmox QEMU

- Virtual. Code in [src/backends/proxmox-qemu/](../src/backends/proxmox-qemu/),
  on the same Proxmox client, ownership tags and settings as Proxmox LXC.
- The Windows template is built by `setup/proxmox-qemu/build.sh`, on a host
  set up as for Proxmox LXC: the same bridge, pool, token and SSH key. Its
  guide lists the settings. The backend has its own VMID range and
  addresses, apart from Proxmox LXC's. Its connection (the URL, token,
  fingerprint and CA certificate) and its SSH key, left empty, take
  Proxmox LXC's; each goes whole, so a URL set here never meets Proxmox
  LXC's token.
- A box is a linked clone of a template that is not generalized, so it boots
  as the same installed Windows. Its address reaches Windows in the SMBIOS
  serial: `base64=1`, and the serial is `address/prefix gateway` in base64,
  such as `10.200.0.12/24 10.200.0.1`. The template's `boot.ps1` reads it at
  each boot. smbios1 is set whole, so each clone gets a fresh UUID too.
- Commands run over SSH in PowerShell 7, as the template's box user, an
  administrator
  ([039](decisions/039-windows-desktops-are-clones-of-a-template-that-is-not-generalized.md)).
  The box's key goes in
  `C:\ProgramData\ssh\administrators_authorized_keys`.
- A larger disk grows before the VM starts, and the acquire then extends C:
  over it. Capacity is `memory`, `disk` on the template's storage, and
  `guests` in the VMID range. A box cannot enrol yet
  ([BB request 1](bb-requests.md#1-bbs-host-app-on-windows)).
- The desktop is the VM's console. Each viewer gets a VNC proxy from the
  API, with a password of its own, and reaches it through the API's
  `vncwebsocket` with the token, trusting the API's certificate as the API
  calls do. The token needs VM.Console.
- A desktop command, `box_run` with `desktop`, runs as a one-off scheduled
  task with the box user's interactive logon, in a headless console, so no
  window shows. It runs unelevated, as an app the user opens does, and
  takes about 1 s more than a command over SSH. Its output comes back when
  it exits. What it opens stays open, unless its timeout ends it.
- The VirtIO GPU driver takes a viewer's size from QEMU but does not
  switch to it, and Windows lists it late, if at all. So the backend sets
  the desktop to that size through a desktop command, which takes 1 to
  2 s. If the driver does not take it within 2 s, the backend sets the
  smallest listed mode that covers the viewer, which the viewer scales
  down, or else the largest. The mode is kept for the next logon.
- Computer use goes through Cua Driver, at the version `build.sh` installs.
  A task at logon starts its daemon in the box user's session, on the pipe
  `\\.\pipe\cua-driver`. It runs elevated, as SSH sessions do, since an
  elevated client cannot reach a daemon that is not; the apps it opens still
  run unelevated. bb-box runs `cua-driver mcp` over SSH, in PowerShell.
  Cua's cursor overlay, a window over the whole screen, is left out of the
  window lists.
- A stop hibernates the VM: Windows' memory goes to a state volume on the
  disk's storage, and the VM stops. A start resumes it, with its apps
  open, then sets Windows' clock over SSH, as the resume leaves it at the
  time the VM stopped. Proxmox locks a hibernated VM's config until it
  starts. Hibernation needs VM.PowerMgmt and VM.Config.Disk, which the
  setup's role has, and Datastore.AllocateSpace on that storage, which the
  token has.
- Still to come: a hibernated warm pool. The conformance suite runs against
  it, but skips the checks whose scripts are written for sh: commands,
  streaming, the architecture, file copies and enrolment.
- The tests run against the fake API, and the fake ssh as a Windows host,
  with a sh stand-in for PowerShell where a test needs one
  ([test/proxmox-qemu.test.ts](../test/proxmox-qemu.test.ts)).

## SSH host pool

- Real. Code in [src/backends/ssh-pool/](../src/backends/ssh-pool/). The
  machine side is `setup/ssh-pool/`: `setup.sh`, and the helper
  `machine.sh`, the only thing bb-box runs on a machine as root. Its guide
  lists the settings.
- bb-box logs in as the admin user, whose key is limited with `restrict`
  and whose sudo rule allows only the helper. The helper reads `key=value`
  lines on stdin, prints `key=value` lines, and holds a lock on the machine
  while it acts.
- Ownership lives on the machine, in `/var/lib/bb-box`: the reset
  generation, and an `owner` marker naming the install, box, thread, kind,
  generation and box user, written before the box user is made. A release
  first renames it to `resetting`, so `held()` returns a machine being
  reset with no owner, and the next release finishes it. Plugin storage
  keeps only what the machine cannot say: that it is out of service and
  why, the generation last seen, and the box on a machine that does not
  answer.
- `Guest.data` keeps the machine's generation and the box user. Every
  method checks the marker names this install, box and generation before
  acting, so an old box's release leaves the next box alone.
- Capacity is one `machines` limit: the machines serving the kind, and how
  many are not free at the size. A machine has a size when it has at least
  its cores, 90% of its memory and, for a disk, that much free under
  `/home`. Acquire claims the smallest such machine. Capacity first gives
  each acquire that has not claimed the machine its claim would take, so a
  small box waiting to claim does not stop a large one. `Guest.size` is the
  machine's cores and memory, with `diskGiB` null. There is no warm pool.
- `restores` is `machine` only when every machine has a whole-machine
  reset (`reset=machine`); only those machines serve `linux-docker`.
- `members()` reads each machine now, and shows a machine whose marker
  names a box as held, even when its helper is too old to lend it again.
  `returnToService(ref)` resets an out-of-service machine again; an
  operator can also run the helper's `reset` on the machine, which bb-box
  sees as a clean machine at a later generation. Neither resets a machine
  a box holds.
- A machine without the helper's tools is out of service. Enrolment's
  tools only fail the doctor: Node.js 22.19 or newer with npm for BB's
  installer, and, as a warning, git and gh for the thread's GitHub access.
  The helper reports them as `node` and `lacks`. A helper from before them
  leaves both out at the same version, so the doctor warns rather than
  taking its machine out of service.

`test/ssh-pool.test.ts` runs the suite and the pool's own checks against a
fake helper. To run them against real machines, start the Docker rig, then:

```sh
sh setup/ssh-pool/test/rig.sh up /tmp/bbbox-rig
npm run conformance -- --backend ssh-pool --settings /tmp/bbbox-rig/settings.json
SSH_POOL_RIG=/tmp/bbbox-rig node --test --test-concurrency=1 test/ssh-pool-live.ts
```

## Tart

- Virtual. Code in [src/backends/tart/](../src/backends/tart/): the
  settings in `config.ts`, the scripts it runs on a Mac in `host.ts`, and
  the backend in `backend.ts`.
- Each Mac and its image are set up by `setup/tart/`, whose guide lists the
  settings. bb-box reaches a Mac over SSH as a host user, with the Mac's host
  key pinned, and each VM through the Mac as the jump host.
- Ownership lives in an owner file per VM on the Mac,
  `~/.bb-box/tart/owners/<VM>`, which names the install, the box, its
  thread, name, kind and creation time. It is written with noclobber before
  the clone and removed after the VM is deleted. VM names hold the box ID, so
  references are never reused.
- Capacity is per Mac: `guests`, the running macOS VMs Tart lists there, at
  most two; `memory`, less a reserve and every running VM's; and `disk`. A
  box gets its size's cores and memory with `tart set`, and may not have
  more cores than the Mac. It keeps its image's disk, so a disk size is
  refused for now. `Guest.size` comes from the VM's
  config.json, with `diskGiB` null.
- The warm pool keeps suspended clones at a kind's default size. A VM
  serves a kind while the kind's image and its build (the inode and
  modification time of the image's disk file), the default size, Tart's
  version and the Mac's macOS build are the ones it was filled with, and it
  is suspended; `maintain()` retires it otherwise. Each VM keeps its own
  name in `~/.config/bb-box/vm`, which bb-box checks after every start, as
  the Mac's DHCP lease lasts an hour and a resumed VM can find its address
  given to another. A VM that keeps no name gets one only when the Mac's
  ARP table, just after bb-box reached the address, gives the MAC address in
  the VM's config.
- The tests run the real host scripts against a fake `tart` on a fake Mac
  ([test/fake-tart.mjs](../test/fake-tart.mjs),
  [test/fake-mac.ts](../test/fake-mac.ts)).

## Docker

- Virtual. Code in [src/backends/docker/](../src/backends/docker/): the
  fields in `config.ts`, the `docker` CLI in `cli.ts`, the command
  transport in `transport.ts`, and the backend in `backend.ts`.
- The images are built by `setup/docker/`, from the Proxmox LXC template's
  guest scripts; its guide lists the fields. bb-box runs the `docker` CLI
  on BB's server, against the local daemon or one over `ssh://`, and reaches
  a box only through `docker exec`
  ([031](decisions/031-docker-boxes-are-reached-through-docker-exec.md)).
- Ownership lives in container labels set at creation (`bbbox.backend`,
  `bbbox.install`, `bbbox.box`, `bbbox.thread`, `bbbox.name`, `bbbox.kind`),
  and the container's name is `bbbox-<box ID>`, so references are never
  reused. Every method reads the labels now and acts only on a container
  that names this install and the box.
- Capacity is per host: `guests`, every bb-box container there, running or
  stopped, of any install; `memory`, the host's less a reserve and the
  limits of the running boxes; and, for GPU desktops, `gpu-desktops` per
  GPU the NVIDIA Container Toolkit lists through CDI, counting stopped
  desktops. A box gets its size's cores and memory as container limits, and
  may not have more cores than the host. A disk size is refused, and
  `Guest.size` has `diskGiB` null. There is no warm pool.
- The tests run against a fake `docker` CLI whose daemon state is a
  directory, and whose `docker exec` runs commands on the test machine
  ([test/fake-docker.mjs](../test/fake-docker.mjs),
  [test/fake-docker.ts](../test/fake-docker.ts)).

To run the suite against a real Docker host with the images built:

```sh
echo '{ "backends": [{ "id": "docker", "type": "docker", "enabled": true, "fields": { "privileged": true } }] }' > /tmp/docker.json
npm run conformance -- --backend docker --settings /tmp/docker.json
```
