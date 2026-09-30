# bb-box

Computers for BB threads. A thread gets its own boxes (Linux, Windows or macOS,
virtual or real, with a desktop or headless), and both the operator and the
thread's agent control them from BB.

## Goal

bb-box is for the operator's personal use with BB. A box is a resource of the
thread that asked for it, not a security boundary: anyone who can start the
operator's BB threads already has everything. A box exists so an agent has its
own machine for real computer, browser and app development work, and so heavy
or messy work (Docker, backends, builds) runs there instead of on the
operator's machine.

Requirements, from the operator, 30 September 2026:

- A thread can have as many boxes as it needs. The host's capacity is the only
  limit; an optional per-thread limit is off by default.
- Crazy fast startup.
- A box has everything its thread has: Git credentials, machine variables, BB,
  and the same network reach as the thread's own machine.
- **Desktop boxes** for real computer-use and browser-use work and app
  development: building, running and profiling web and native apps (GPUI apps,
  for example) on a real GPU.
- **Headless boxes** for the agent's own work: Docker, backend services,
  builds.
- The operator and the agent both control every box in BB: start, see, use,
  take control, release.
- A box lives until its thread is archived or deleted, or until the operator or
  the agent releases it. No expiry, TTL or idle timeout.
- Linux first, Windows next, macOS last.

What matters, in order: UX, startup speed, BB integration. Keep what makes
bb-box reliable (clean-up when a thread ends, recovery after a crash, a
capacity guard) and nothing that serves none of these.

## Concepts

- **Box**: one computer held by one thread. It has a friendly name, a kind, an
  address and a state.
- **Backend**: where boxes come from. bb-box's core does not care who the
  provider is: Proxmox, LXC, a VM, a physical machine, Crabbox or anything
  else is a backend behind one interface. The core (registry, panel, agent
  tools, lifecycle, BB enrolment, computer use, desktop viewer) never names a
  provider, a hypervisor, a container technology or a transport. A backend
  only adapts its provider: acquire and release, address, capacity, and which
  transports reach its boxes.
- **Transport**: how bb-box reaches inside a box, shared by backends: command
  execution and file copy (SSH now; WinRM or an in-box agent later) and the
  desktop stream (VNC now; RDP or WebRTC later). Everything that runs inside a
  box goes through a transport and is written once for every backend.
- **Kind**: what a backend offers, with declared capabilities: guest OS,
  desktop or headless, GPU, Docker, how to run commands and copy files, the
  desktop viewer, whether the box enrols in BB, and capacity. The agent tools
  and the panel follow these declarations, so a new platform plugs in without
  reworking them.
- **Virtual or real**: a virtual box is created on demand and deleted on
  release; a real box is a physical machine claimed from a pool and reset and
  returned on release. The interface is acquire and release for both. A warm
  pool of ready virtual boxes and a pool of real machines are the same idea.
- **Thread access**: a box enrols in BB as an ordinary machine, which is how it
  gets the thread's Git credentials and machine variables, and lets child
  threads run on it. The agent can also reach its boxes directly, for example
  with `ssh` or `DOCKER_HOST`.
- **Control**: the operator uses the thread's panel (every box, its desktop
  view, take control, release); the agent uses bb-box's tools (acquire, list,
  status, release, run a command, copy files, and computer use on desktops).
  The desktop is shared: when the operator takes control they drive the
  agent's own desktop, and the agent's input pauses until they hand back.
- **Computer use**: the accessibility tree first (roles, names, values,
  actions, element references), screenshots second, the same way on every
  OS.

## Backends

| Backend | Virtual or real | Kinds | Status |
| --- | --- | --- | --- |
| Proxmox LXC | virtual | Linux desktop with GPU, Linux headless with Docker | building |
| Proxmox QEMU | virtual | Windows desktop | next |
| Mac | real Mac mini, or macOS VMs on one | macOS desktop, iOS Simulator | last |
| Physical PC pool | real | Linux or Windows | when needed |
| Crabbox, microsandbox, clouds | virtual | whatever they provide | possible |

## The first backend: Proxmox LXC on Moonstead

Measured on Moonstead (Proxmox VE 9.2, 2 NVIDIA RTX PRO 6000, 64 threads,
251 GB) on 30 September 2026:

- Unprivileged LXC containers, linked-cloned from CT templates: clone 1 s,
  start 1 s, boot 0.8 s, SSH ready about 1.2 s after start. Crabbox, which
  Stead used, took 55 s for the same container.
- Headless template 9800: Ubuntu 24.04, dev tools, Claude Code, Codex, Pi,
  Docker with compose and buildx (`nesting=1`; no `keyctl` needed).
- Desktop template 9801: Xorg with NVIDIA's driver on a virtual screen as the
  box user, served over VNC, XFCE, Chrome, and the host's NVIDIA driver version
  in the container. GL and Vulkan run on the GPU: Chrome's WebGL, WebGPU and
  video decode are hardware accelerated, and a GPUI example runs on the GPU.
  Without the GPU, the desktop falls back to CPU rendering.
- Network: bridge `vmbr78` (10.78.0.0/24) with NAT and no filtering; boxes
  reach the internet, the LAN, the tailnet and BB, and BB reaches boxes
  directly. Addresses are static, so there is no DHCP wait.
- Nesting and GPU devices are set on the templates once by root; the plugin's
  Proxmox token only clones, configures, starts and deletes.
- Limits: each desktop uses one GPU, and the GPUs' free memory limits how many
  desktops get hardware rendering; the rest fall back to CPU rendering.

## Decisions

- **BB is the coordinator.** No Crabbox, coordinator, adapter, relay or portal:
  the bb-box BB plugin calls each backend directly, and BB provides auth,
  threads, events, agent tools, the panel, HTTP and WebSocket routes, and
  machine enrolment.
- **Containers for Linux.** LXC gives startup in seconds, a shared host GPU and
  Docker. A VM is overkill for Linux; Windows needs one.
- **Microsandbox is not needed.** It has no display or GPU on Linux and runs
  one process rather than a full systemd session; LXC boots in under a second.
- **Stead is gone.** bb-box replaces it; Stead and Crabbox were removed on
  30 September 2026.

Detailed design: [docs/architecture.md](docs/architecture.md),
[docs/backends.md](docs/backends.md), decision records in
[docs/decisions](docs/decisions), research in [docs/research](docs/research).

## Roadmap

1. Linux headless boxes end to end: template, backend, registry, agent tools,
   panel, clean-up, BB enrolment. Target: a working box in seconds.
2. Linux desktop boxes: GPU desktop template, desktop streaming in BB's panel,
   shared control, computer use for the agent.
3. Speed: a warm pool of ready boxes, and faster BB enrolment and checkout.
4. Windows boxes on Proxmox QEMU.
5. macOS boxes on a Mac mini, physical or as macOS VMs, with the iOS
   Simulator.
