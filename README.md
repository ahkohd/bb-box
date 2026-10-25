# bb-box

[![A person makes a desktop box in a BB thread, the agent opens Chrome in it, then the person makes a server box and runs a command in its terminal](docs/media/demo.webp)](docs/media/demo.mp4)

Computers for [BB](https://getbb.app) threads. Each thread gets boxes of its own: Linux, macOS or Windows, virtual or physical, with or without a desktop. You and the thread's agent both use them from BB.

## Why bb-box

- **Each thread gets its own computers.** Boxes have the thread's Git access, its variables and BB itself.
- **Keep boxes as your own machines.** Threads can run on them, such as an always-on agent with its own desktop.
- **Any provider.** Docker, Proxmox, Micro Sandbox, Macs with Tart, machines over SSH, or cloud machines from Hetzner Cloud and Namespace, made when boxes need them.
- **Ready in seconds.** A warm box is ready at once.
- **Shared desktops.** You and the agent use the same screen. The agent waits while you have control.
- **Recordings that show the work.** An agent records its test run as a short clip, with each step and its result captioned. See [Recordings](docs/guide/recording.md).

*bb-box assumes one trusted user. It is not a sandbox for code you do not trust.*

## Quick start

You need a Linux machine that runs BB and Docker, with about 10 GB free.

1. In BB, open Settings, then Installed plugins, then the arrow beside **New plugin**, then **Install from source**, and enter:

   ```text
   git:https://github.com/moonstead/bb-box.git@main
   ```

   Or with BB's command line:

   ```sh
   bb plugin install git:https://github.com/moonstead/bb-box.git@main
   ```

   It asks you to confirm. An agent or a script adds `--yes`, as it cannot answer.

2. Open a thread's **Box** panel and select **Use Docker on this machine**, or have an agent run `bb box setup docker`. The Linux image usually builds in 5 to 12 minutes, depending on the machine.
3. Select the plus, then **Create box**. Or ask the thread's agent: "Get a Linux box and run uname -a in it."
4. For a desktop, select the plus, choose **Desktop**, then **Create box**. bb-box builds the desktop image before the first one, usually in 4 to 10 minutes.

A box joins BB by reaching BB's server, so BB must listen on an address the box can reach. `bb box doctor` checks the setup. If a box says 'Could not join BB', see [when a box does not join BB](docs/guide/boxes.md#when-a-box-does-not-join-bb).

## Backends and boxes

| Backend | Boxes | Where they run |
| --- | --- | --- |
| [Docker](setup/docker/README.md) | Linux; Linux desktop on the CPU or an NVIDIA GPU; Wayland desktop on the CPU | containers on the machine that runs BB, another host over SSH, or a BB machine with Docker, such as a [Windows PC with WSL](setup/docker-wsl/README.md) |
| [microsandbox](setup/microsandbox/README.md) | Linux; Linux desktop on the CPU | microVMs, each with a kernel of its own, on a Linux host with KVM or a Mac with Apple silicon: an option beside Docker, not the default |
| [Proxmox LXC](setup/proxmox-lxc/README.md) | Linux; Linux desktop on the CPU or a GPU; Wayland desktop on the CPU | containers on a Proxmox VE host |
| [Proxmox QEMU](setup/proxmox-qemu/README.md) | Windows desktop; Linux with a kernel of its own, and KVM where the host allows | virtual machines on a Proxmox VE host |
| [Tart](setup/tart/README.md) | macOS, with or without a desktop; Linux on arm64, with or without a desktop; Windows desktop on arm64 | virtual machines on your Macs with Apple silicon |
| [SSH host pool](setup/ssh-pool/README.md) | Linux; macOS, with or without a desktop | machines over SSH, physical or a VPS |
| [Hetzner Cloud](docs/guide/hetzner.md) | Linux; Linux desktop on the CPU; Wayland desktop on the CPU; Linux on arm64, with or without a desktop | containers on x86 or Arm Docker hosts bb-box rents in your Hetzner Cloud project as boxes need them, and deletes when idle |
| [Namespace](docs/guide/namespace.md) | macOS, with or without a desktop; Linux, with KVM; Linux desktop on the CPU; Wayland desktop on the CPU | a Namespace machine for each box, a Mac or a Linux machine, rented by the minute in your Namespace workspace, within its plan's limits |

Every kind of box, and its sizes, is in [kinds and sizes](docs/reference/kinds.md).

Notes:

- Windows boxes join BB as machines too. A thread cannot yet start on a new Windows box from BB's new-thread screen ([BB requests](docs/bb-requests.md)).

## Documentation

- [User guide](docs/guide/README.md)
- [Setting up bb-box](setup/README.md)
- [Reference](docs/reference/README.md)
- [Architecture](docs/architecture.md)
- [Developing bb-box and writing a backend](docs/development.md)
- [Decision records](docs/decisions)
- [Research notes](docs/research)
- [Design specs](docs/design)
- [What bb-box asks of BB](docs/bb-requests.md)
