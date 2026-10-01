# bb-box

Computers for [BB](https://getbb.app) threads. A thread gets its own boxes
(Linux, Windows or macOS, virtual or physical, with a desktop or headless),
and both you and the thread's agent control them from BB.

bb-box is a BB plugin. It is built for people who run BB for themselves and
want their agents to have real machines: a desktop to build, run and profile
apps in a real browser or native UI, and headless machines for Docker, backend
services and builds, so that work runs on a box and not on your own machine.

## Principles

- **A box belongs to its thread.** It is a resource of the thread that asked
  for it, with everything the thread has: Git credentials, machine variables,
  BB itself, and the same network reach as the thread's own machine. bb-box
  assumes one trusted user; it is not a sandbox for untrusted code.
- **Any provider.** bb-box's core does not care where a box comes from. A
  hypervisor, a container host, a physical machine, a cloud or a sandbox
  runtime is a backend behind one interface.
- **Fast.** A box is ready in seconds, and a warm pool makes it immediate.
- **Shared control.** You and the agent use the same desktop. When you take
  control you drive the agent's own desktop, its browser and windows, and the
  agent waits until you hand back.
- **Accessibility first.** Agents use a desktop through its accessibility tree
  (roles, names, values, actions, element references), and screenshots when
  appearance matters, the same way on every OS.
- **No surprises.** A box lives until its thread is archived or deleted, or
  until you or the agent releases it. There is no expiry and no idle timeout.
  The only limit is the host's capacity; a per-thread limit is optional.

## Concepts

- **Box**: one computer held by one thread, with a friendly name, a kind, an
  address and a state.
- **Backend**: an adapter for one provider. It acquires and releases boxes,
  reports their addresses and the provider's capacity, and says which
  transports reach its boxes. The core (registry, panel, agent tools,
  lifecycle, BB enrolment, computer use, desktop viewer) talks only to the
  backend interface and never names a provider, hypervisor, container
  technology or transport.
- **Kind**: what a backend offers, with declared capabilities: guest OS,
  desktop or headless, GPU, Docker, how commands and file copies run, the
  desktop stream, and whether the box enrols in BB. The agent tools and the
  panel follow these declarations.
- **Virtual or real**: a virtual box is created on demand and deleted on
  release; a real box is a physical machine claimed from a pool, and reset and
  returned on release. The interface is acquire and release for both, and a
  warm pool of ready virtual boxes works like a pool of real machines.
- **Transport**: how bb-box reaches inside a box, shared by backends: command
  execution and file copy (SSH; `docker exec` or a guest agent later) and the
  desktop stream (RFB, the VNC protocol, now; Selkies later). Everything that
  runs inside a box (BB enrolment, computer use, the thread's access) goes
  through a transport and is written once for every backend.
- **Thread access**: a box enrols in BB as an ordinary machine. That is how it
  gets the thread's Git credentials and machine variables, and it lets child
  threads run on it. The agent can also reach its boxes directly, for example
  with `ssh` or `DOCKER_HOST`.

## Using it

- **You**: the thread's panel lists every box, starts either kind, shows each
  desktop live, lets you take and return control, and releases boxes.
- **The agent**: bb-box's tools acquire a box of a kind, list and check boxes,
  run commands, copy files, drive a desktop with computer use, and release
  boxes. It can also start a child thread on a box.

## Backends

| Backend | Virtual or real | Kinds | Status |
| --- | --- | --- | --- |
| Proxmox LXC | virtual | Linux desktop with GPU, Linux headless with Docker | in development |
| Proxmox QEMU | virtual | Windows desktop | planned |
| macOS (physical Mac) | real | macOS desktop, iOS Simulator | planned |
| Apple Virtualization framework, for example [Tart](https://tart.run) | virtual (macOS VMs on a Mac host) | macOS desktop, iOS Simulator | planned |
| Docker | virtual | Linux desktop, Linux headless | planned, early |
| SSH host pool | real | any machine reachable over SSH | planned, early |
| Physical pool | real | Linux or Windows machines you own | possible |
| Microsandbox, Crabbox, clouds | virtual | what each provides | possible |

Windows boxes cannot enrol in BB until BB's host app runs on Windows
([BB requests](docs/bb-requests.md)). Until then they run commands, copy files
and stream their desktop, but do not get the thread's Git credentials and
machine variables from BB, and child threads cannot run on them.

### Proxmox LXC

The first backend creates unprivileged LXC containers on a Proxmox VE host by
linked clone from CT templates, one headless and one desktop per GPU. Measured
on a Proxmox VE 9.2 host through the plugin's API token: clone 0.75 s, start
1.0 s, SSH ready about 0.45 s after start, so about 2.2 s from request to a
working box.

- **Headless**: Ubuntu 24.04 with common development tools and agent CLIs, and
  Docker with compose and buildx (the container has `nesting=1`).
- **Desktop**: XFCE and Chrome on a real Xorg server driven by the host's
  NVIDIA GPU, streamed to BB. OpenGL and Vulkan run on the GPU, so browser
  rendering, WebGL, WebGPU and GPU-rendered native apps are hardware
  accelerated. Without a usable GPU the desktop falls back to CPU rendering.
- **Network**: boxes sit on their own bridge with NAT and get static
  addresses, so there is no DHCP wait.
- **Permissions**: root builds the templates once, with nesting and the GPU
  devices; bb-box's Proxmox API token only clones, configures, starts and
  deletes.
- **Limits**: a desktop uses one GPU, and the GPU's free memory limits how many
  desktops get hardware rendering.

## Easy to set up, tested on every backend

bb-box should be easy to set up on whatever you have. Every backend has a
setup script and a short guide, the plugin's settings page walks through
configuring a backend, and a `doctor` check says exactly what is missing. One
conformance suite (acquire each kind, ready, run a command, copy files, enrol
in BB, stream the desktop, computer use, release, capacity, crash recovery)
runs against every backend, so backend-agnostic is tested rather than assumed.
Docker and an SSH host pool come early, beside Proxmox LXC, for that reason
and because anyone can try them.

## Status

Private and in daily use; it will be open-sourced once it has been used daily
for months.

Working on the Proxmox LXC backend:

- Linux headless boxes with Docker, enrolled in BB with the thread's access.
- Linux desktop boxes on the GPU or the CPU, shown live in the thread's panel,
  with shared control and resizing.
- Computer use for agents, through the accessibility tree and screenshots.
- A warm pool: a warm box is handed out in about 0.1 s; BB's enrolment then
  takes a few seconds (see [what bb-box asks of BB](docs/bb-requests.md)).

Next: Docker and SSH host pool backends, to keep the core backend-agnostic and
to make bb-box easy to try; then Windows, then macOS.

## Install

On the machine that runs BB:

```sh
git clone <bb-box repository> && cd bb-box
npm install
bb plugin build
bb plugin install .
```

Then set a backend up with its guide, fill in its settings in BB under
bb-box, and check them with `bb box doctor`. Each thread gets a Boxes panel,
agents get the `box_` tools, and `skills/bb-box/SKILL.md` describes both.

## Upgrade

Do not remove bb-box to upgrade it: `bb plugin remove` deletes its settings
and secrets. `bb plugin source bb-box` shows what it was installed from.

- From a path, as above: pull, run `npm install` and `bb plugin build`, then
  `bb plugin reload bb-box`.
- From a branch, with `bb plugin install git:<bb-box repository>@<branch>`:
  `bb plugin update bb-box` moves it to the branch's newest commit and keeps
  its settings and storage. `bb plugin outdated` shows whether there is one.
- From a commit or a tag: BB pins it, and `bb plugin update` refuses. Only a
  remove and an install move it, so install from a branch instead.

If bb-box loses its storage, its boxes keep running: take its install ID
back with `bb box install-id --set <id>`, and the next sweep restores the
boxes of live threads from their guests. When `enrol-boxes` is on, each
becomes a BB machine again once it runs and answers.

## Develop

```sh
npm run typecheck
npm test
npm run build
node scripts/smoke.ts <settings.json>
```

The tests and scripts need Node 22.18 or later, which runs TypeScript
directly. The tests run against a fake Proxmox API and a fake `ssh`, so they
need no host. The smoke script runs against a real backend without BB; see
[section 6 of the Proxmox LXC guide](setup/proxmox-lxc/README.md#6-smoke-test).

## Third-party code

The desktop viewer bundles noVNC 1.7.0 from npm (`@novnc/novnc`), unchanged.
Its core library is under the Mozilla Public License 2.0, and the pako code it
includes under the MIT licence. Their source and licence texts are in the
package, in `node_modules/@novnc/novnc` after `npm install`.

## Documentation

- [Architecture](docs/architecture.md)
- [Backend interface](docs/backends.md)
- [Decision records](docs/decisions)
- [Research](docs/research)
- [Setting up the Proxmox LXC backend](setup/proxmox-lxc/README.md)
