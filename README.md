# bb-box

Computers for [BB](https://getbb.app) threads. A thread gets its own boxes
(Linux, Windows or macOS, virtual or physical, with or without a desktop),
and both you and the thread's agent control them from BB.

bb-box is a BB plugin. It is built for people who run BB for themselves and
want their agents to have real machines: a desktop to build, run and profile
apps in a real browser or native UI, and plain machines for Docker, backend
services and builds, so that work runs on a box and not on your own machine.

To try it, see [Install](#install): one Docker host is enough.

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
  whether it has a desktop, GPU, Docker, how commands and file copies run, the
  desktop stream, and whether the box enrols in BB. The agent tools and the
  panel follow these declarations.
- **Virtual or real**: a virtual box is created on demand and deleted on
  release; a real box is a physical machine claimed from a pool, and reset and
  returned on release. The interface is acquire and release for both, and a
  warm pool of ready virtual boxes works like a pool of real machines.
- **Transport**: how bb-box reaches inside a box, shared by backends: command
  execution and file copy (SSH or `docker exec`; a guest agent later) and the
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
| Proxmox LXC | virtual | Linux, Linux with Docker, Linux desktop with or without a GPU | in development |
| Proxmox QEMU | virtual | Windows desktop | in development |
| macOS (physical Mac) | real | macOS desktop, iOS Simulator | planned |
| Apple Virtualization framework, with [Tart](https://tart.run) | virtual (macOS VMs on a Mac host) | macOS, macOS desktop | in development |
| Docker | virtual | Linux, Linux with Docker, Linux desktop with or without a GPU | in development |
| SSH host pool | real | Linux, Linux with Docker, on Linux machines you own | in development |
| Physical pool | real | Linux or Windows machines you own | possible |
| Microsandbox, Crabbox, clouds | virtual | what each provides | possible |

Windows boxes cannot enrol in BB until BB's host app runs on Windows
([BB requests](docs/bb-requests.md)). Until then they run commands, copy files
and stream their desktop, but do not get the thread's Git credentials and
machine variables from BB, and child threads cannot run on them.

### Proxmox LXC

The first backend creates unprivileged LXC containers on a Proxmox VE host by
linked clone from CT templates, one Linux and one desktop per GPU. Measured
on a Proxmox VE 9.2 host through the plugin's API token: clone 0.75 s, start
1.0 s, SSH ready about 0.45 s after start, so about 2.2 s from request to a
working box.

- **Linux**: Ubuntu 24.04 with common development tools and agent CLIs, and
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

### SSH host pool

Lends Linux machines you already have, reached over SSH, directly or
through a jump host. A box has a whole machine to itself, as a new user
made for it. When the box is released, the machine is reset and lent again.

- **Setup**: `setup/ssh-pool/setup.sh` adds an admin user that may run only
  bb-box's helper as root. Each machine keeps its own state, so bb-box
  carries on after it loses its storage.
- **Reset**: removes the box's user and everything it left. A machine whose
  reset fails goes out of service until the operator resets it.
- **Docker**: only on a machine with a whole-machine reset, a program you
  provide, since a box with Docker is root on the machine.
- **Limits**: headless only for now. It is not a security boundary: a box
  can read what any user on the machine can read.

See [its guide](setup/ssh-pool/README.md).

### Docker

Runs boxes as containers on one Docker host: the Docker on BB's server, or
another machine's over SSH. It needs only Docker, so it is the quickest way
to try bb-box. A linux box is ready in about a third of a second, and a
desktop in under a second.

- **Images**: built on the Docker host by `setup/docker/build.sh`, from the
  same guest scripts as the Proxmox LXC templates, so a box has the same
  tools. bb-box never pulls an image.
- **Reach**: commands, file copies and the desktop stream all go through
  `docker exec`, so BB's server needs no network path to a box, and a
  Docker host over SSH works as the local one does.
- **Docker in a box**: Docker in Docker, in a privileged container, which is
  root on the Docker host, so it is off until the operator turns it on.
- **Desktop**: XFCE and Chrome drawn by the CPU, or on an NVIDIA GPU through
  the NVIDIA Container Toolkit.
- **Limits**: no systemd in a box, no disk size of its own, and it is not a
  security boundary: a box shares the host's kernel.

See [its guide](setup/docker/README.md).

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

- Linux boxes with Docker, enrolled in BB with the thread's access.
- Linux desktop boxes on the GPU or the CPU, shown live in the thread's panel,
  with shared control and resizing.
- Computer use for agents, through the accessibility tree and screenshots.
- Box sizes: each kind has small, medium and large presets, and an agent or
  person can ask for a custom size up to the kind's largest.
- A warm pool: a warm box is handed out in about 0.1 s; BB's enrolment then
  takes a few seconds (see [what bb-box asks of BB](docs/bb-requests.md)).

The SSH host pool backend lends Linux machines you own, with Docker on
machines with a whole-machine reset. It passes the conformance suite against
Docker containers running sshd, with and without systemd.

The Docker backend runs Linux boxes, desktops among them, as containers on
one Docker host, local or over SSH, and needs only Docker to try bb-box.
It passes the conformance suite on a local Docker host and on one over SSH,
for every kind but linux-desktop, which has not yet been tested on a host
with an NVIDIA GPU.

Next: Windows, then macOS.

## Install

On the machine that runs BB:

```sh
git clone https://github.com/moonstead/bb-box.git && cd bb-box
npm install
bb plugin build
bb plugin install .
```

Then pick a backend and follow its guide under `setup/`. [Docker](setup/docker/README.md)
is the quickest: it needs only a Docker host, local or over SSH.
[Proxmox LXC](setup/proxmox-lxc/README.md) gives the fastest boxes, and
GPU desktops. On BB Box's settings page in BB (Settings, Plugins, BB Box),
set the backend up with the values the guide gives, press Check, save, and
turn it on. `bb box doctor` runs the same checks from a terminal, and
`bb box config` shows and saves the same configuration. Each thread gets a
Box panel, agents get the `box_` tools, and `skills/bb-box/SKILL.md`
describes both.

## Upgrade

Do not remove bb-box to upgrade it: `bb plugin remove` deletes its
configuration, secrets and storage. `bb box config show --json` prints the
configuration without its secrets; `bb box config apply --replace` sets
bb-box up again from it. Give the secrets again: as strings in the file in
place of `{"set": true}`, or apply it with those backends off and give them
on the settings page. `bb plugin source bb-box` shows
what it was installed from.

- From a path, as above: pull, run `npm install` and `bb plugin build`, then
  `bb plugin reload bb-box`.
- From a branch, with `bb plugin install git:<bb-box repository>@<branch>`:
  `bb plugin update bb-box` moves it to the branch's newest commit and keeps
  its settings and storage. `bb plugin outdated` shows whether there is one.
- From a commit or a tag: BB pins it, and `bb plugin update` refuses. Only a
  remove and an install move it, so install from a branch instead.

If bb-box loses its storage, its boxes keep running: take its install ID
back with `bb box install-id --set <id>`, and the next sweep restores the
boxes of live threads from their guests. When enrolment is on, each
becomes a BB machine again once it runs and answers.

## Develop

```sh
npm run typecheck
npm test
npm run build
node scripts/smoke.ts <settings.json>
npm run conformance -- --backend <type> --settings <settings.json>
```

The tests and scripts need Node 22.18 or later, which runs TypeScript
directly. `scripts/preview/` renders the built panels outside BB, with BB's
theme and fixtures, for screenshots: serve the repository root and open
`scripts/preview/index.html#panel-list`, or run `node scripts/preview/shoot.mjs`
on a machine with Chrome. The tests run against a fake Proxmox API, a fake
`ssh`, a fake `tart` and a fake `docker`, so they need no host. The smoke
script runs against a real backend without BB; see
[section 6 of the Proxmox LXC guide](setup/proxmox-lxc/README.md#6-smoke-test).
`npm run conformance` runs the conformance suite against a real backend; the
[SSH host pool guide](setup/ssh-pool/README.md#testing-on-one-computer) runs
it against Docker containers on one computer, and the
[Docker guide](setup/docker/README.md#trying-it-without-bb) against the
Docker backend.

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
- [Setting up the SSH host pool backend](setup/ssh-pool/README.md)
- [Setting up the Tart backend](setup/tart/README.md)
- [Setting up the Docker backend](setup/docker/README.md)
