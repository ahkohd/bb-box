# bb-box

[![A person asks a BB thread's agent for a Linux desktop box, and the agent opens getbb.app in its browser. The person opens the desktop, glances at the box's CPU and memory in the Monitor, then makes a server box and runs a command in its terminal. On the server box's page, the person takes a snapshot, breaks the box from its terminal, and restores the snapshot with an undo](docs/media/demo.webp)](docs/media/demo.mp4)

Computers for [BB](https://getbb.app) threads: Linux, Windows, macOS, iOS and Android, virtual or real: desktops, terminals or simulators, shared by you and your agent.

## Why bb-box

- **Each thread gets its own computers.** Boxes have the thread's Git access, its variables and BB itself.
- **Any provider.** Docker, Proxmox, microsandbox, Macs with Tart, machines over SSH, or Hetzner Cloud, Namespace and boat.dev.
- **Ready in seconds.** A box is usually ready in seconds, and a warm box at once.
- **Shared desktops.** You and the agent use the same screen. The agent waits while you have control.
- **Phones and tablets to test apps on.** An iPhone or iPad in the iOS Simulator, or an Android device in its emulator. See [device boxes](docs/guide/devices.md).
- **GPUs.** A box can share an NVIDIA card or have one to itself, with `nvidia-smi`, CUDA and PyTorch ready, on supported backends. See [GPU boxes](docs/guide/gpu-boxes.md).
- **Snapshot, undo and fork.** Save a box before a risky change, restore it with an undo, or fork it into a fresh box with its own identity. See [snapshots](docs/guide/snapshots.md).
- **Resize as you go.** More cores, memory, disk or a GPU when a build needs them, from the Box panel, the box's page or the agent. See [resizing a box](docs/guide/resizing.md).
- **Recordings that show the work.** An agent records its test run as a short clip, with each step and its result captioned. See [Recordings](docs/guide/recording.md).
- **Keep boxes as your own machines.** Threads can run on them, such as an always-on agent with its own desktop.
- **Every machine at a glance.** CPU, memory, disk, GPU and processes of every box and machine, in BB's sidebar. See [the Monitor](docs/guide/monitor.md).

*bb-box assumes one trusted user. It is not a sandbox for code you do not trust.*

## Quick start

You need a Linux machine that runs BB and Docker, with about 10 GB of disk free and at least 8 GiB of memory, or 12 GiB for a desktop box.

Boxes join BB by reaching BB's server. If BB is signed in to your bb account, bb connect does that. If it is not, start BB with `npx bb-app --server-bind-host 0.0.0.0`, then in BB's settings, under Machines, set Machine access to **Manual** with this machine's address on your network, such as `http://192.0.2.10:38886`. See [when a box does not join BB](docs/guide/boxes.md#when-a-box-does-not-join-bb).

1. In BB, open Settings, then Installed plugins, then the arrow beside **New plugin**, then **Install from source**, and enter:

   ```text
   git:https://github.com/ahkohd/bb-box.git@stable
   ```

   Or with BB's command line, `bb`, or `npx --package bb-app bb` where `bb` is not installed:

   ```sh
   bb plugin install git:https://github.com/ahkohd/bb-box.git@stable
   ```

   It asks you to confirm. An agent or a script adds `--yes`, as it cannot answer.

   `stable` is the release branch. `main` is where new work lands first and is tried before it reaches `stable`; install `@main` only to try that work.

2. Open a thread's **Box** panel, or BB Box in BB's settings, and select **Use Docker on this machine**, or have an agent run `bb box setup docker`. The Linux image usually builds in 5 to 12 minutes, depending on the machine.
3. Select the plus, then **Create box**. Or ask the thread's agent: "Get a Linux box and run uname -a in it."
4. For a desktop, select the plus, choose **Desktop**, and under Display X11 or Wayland, then **Build and create**. bb-box builds that desktop's image before the first one, usually in 4 to 10 minutes.

`bb box doctor` checks the setup. If a box says 'Could not join BB', see [when a box does not join BB](docs/guide/boxes.md#when-a-box-does-not-join-bb).

## Backends and boxes

| Backend | Boxes | Where they run | Snapshots |
| --- | --- | --- | --- |
| [Docker](setup/docker/README.md) | Linux; Linux desktop on the CPU or an NVIDIA GPU; Wayland desktop on the CPU | containers on the machine that runs BB, another host over SSH, or a BB machine with Docker, such as a [Windows PC with WSL](setup/docker-wsl/README.md) | none yet |
| [microsandbox](setup/microsandbox/README.md) | Linux; Linux desktop on the CPU | microVMs, each with a kernel of its own, on a Linux host with KVM or a Mac with Apple silicon: an option beside Docker, not the default | the disk, or the disk and memory; restore with an undo; fork; Keep |
| [Proxmox LXC](setup/proxmox-lxc/README.md) | Linux; Linux desktop on the CPU or a GPU; Wayland desktop on the CPU | containers on a Proxmox VE host | the disk, live; restore in place with an undo, but not on ZFS yet; fork; Keep as a copy that cannot start |
| [Proxmox QEMU](setup/proxmox-qemu/README.md) | Windows desktop; Linux with a kernel of its own, and KVM where the host allows; Android emulator devices | virtual machines on a Proxmox VE host | Linux: the disk, or the disk and memory; restore with an undo; fork and Keep from the disk. None for Windows or Android |
| [Tart](setup/tart/README.md) | macOS, with or without a desktop; Linux on arm64, with or without a desktop; Windows desktop on arm64; iOS Simulator devices, in a VM of their own or a slot on a shared host | virtual machines on your Macs with Apple silicon | macOS: the disk and memory, restored running as it was. Linux: the disk, taken while stopped. Both restore with an undo, fork and Keep. Linux desktops need reset version 9; older images refuse and say why. None for Windows or iOS |
| [SSH host pool](setup/ssh-pool/README.md) | Linux; macOS, with or without a desktop; iOS Simulator devices, in slots on its Macs | machines over SSH, physical or a VPS | none |
| [Hetzner Cloud](docs/guide/hetzner.md) | Linux; Linux desktop on the CPU; Wayland desktop on the CPU; Linux on arm64, with or without a desktop | containers on x86 or Arm Docker hosts bb-box rents in your Hetzner Cloud project as boxes need them, and deletes when idle | none yet |
| [Namespace](docs/guide/namespace.md) | macOS, with or without a desktop; Linux, with KVM; Linux desktop on the CPU; Wayland desktop on the CPU; iOS Simulator devices, in slots on a shared Mac | a Namespace machine for each box, a Mac or a Linux machine, rented by the minute in your Namespace workspace, within its plan's limits | none yet |
| [boat.dev](docs/guide/boat.md) | Linux, with KVM; Linux desktop on the CPU; Android emulator devices | a boat.dev sandbox for each box, a Linux VM forked from bb-box's template in seconds and billed by the second | on a paid plan, the disk, as a saved snapshot on your account: free up to your plan's included ones, then $0.056 a day each; restore with an undo; fork and Keep for Linux boxes. None on the free trial |

A fork, and Keep past a box's release, need the box's identity reset turned on for its backend, so that a copy never comes up as its source. Linux desktops need an image built with reset version 9 or later; older images refuse forks and Keep, saying why. What each backend's snapshots hold, and what is not built yet, is in [snapshots](docs/guide/snapshots.md#what-each-backend-offers).

Every kind of box, and its sizes, is in [kinds and sizes](docs/reference/kinds.md). Phones and tablets are in [device boxes](docs/guide/devices.md).

## What still waits on BB

Some things wait on features BB does not have yet, listed in [what bb-box asks of BB](docs/bb-requests.md). You will notice them in five places. A thread cannot start on a new Windows box from BB's new-thread screen, though Windows boxes join BB as machines. A box's terminal is bb-box's own tab, not BB's terminal with its tabs and history. When BB's server is busy for a moment, every desktop's picture and input wait for it, so a drag can lag. A file over 16 MiB copies to or from a box only while the machine that holds it is connected to BB. An agent's command that runs longer than about 4.5 minutes goes on as a job, which the agent checks later, as BB ends a tool call after about five minutes.

## Documentation

- [User guide](docs/guide/README.md)
- [Setting up bb-box](setup/README.md)
- [Reference](docs/reference/README.md)
- [Architecture](docs/architecture.md)
- [Developing bb-box and writing a backend](docs/development.md), and [AGENTS.md](AGENTS.md), the rules for working in this repository
- [Decision records](docs/decisions)
- [Research notes](docs/research)
- [Design specs](docs/design)
- [What bb-box asks of BB](docs/bb-requests.md)

## Licence

bb-box is under the [MIT licence](LICENSE). The software it bundles, and the software it installs on hosts and in images, keeps its own licence: see [Third-party software](THIRD-PARTY.md).
