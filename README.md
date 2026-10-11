# bb-box

Computers for [BB](https://getbb.app) threads. Each thread gets boxes of its own: Linux, macOS or Windows, virtual or physical, with or without a desktop. You and the thread's agent both use them from BB.

## Why bb-box

- A box belongs to its thread. It has what the thread has: its Git credentials, its machine variables, BB itself, and the same network reach.
- You can keep one as a machine of your own. It joins BB's machine list, threads run on it, and it stays until you remove it: an always-on agent with its own desktop, for example. See [your machines](docs/guide/boxes.md#your-machines).
- It works with any provider. A hypervisor, a container host, a physical machine or a cloud is a backend behind one interface.
- It is fast. A box is ready in seconds, and a warm box at once.
- You share control. You and the agent use the same desktop, and the agent waits while you have control.
- A box lasts until someone releases it or its thread ends, with no expiry and no idle timeout.
- It is easy to set up. Each backend has a short guide, `bb box doctor` says what is missing, and one conformance suite runs against every backend. See the [architecture](docs/architecture.md).

bb-box assumes one trusted user. It is not a sandbox for code you do not trust.

## Quick start

You need a Linux machine that runs BB and Docker, with about 10 GB free.

1. In BB, open Settings, then Installed plugins, then **New plugin**, then **Install from source**, and enter `git:https://github.com/moonstead/bb-box.git@main`. With BB's command line: `bb plugin install git:https://github.com/moonstead/bb-box.git@main`.
2. Open a thread's **Box** panel and select **Use Docker on this machine**. The Linux image builds in 4 to 8 minutes.
3. Select the plus, then **Create box**. Or ask the thread's agent: "Get a Linux box and run uname -a in it."

`bb box doctor` checks the setup. If a box says 'Could not join BB', see [when a box does not join BB](docs/guide/boxes.md#when-a-box-does-not-join-bb).

## Backends and boxes

| Backend | Boxes | Where they run |
| --- | --- | --- |
| Docker | Linux; Linux desktop on the CPU or an NVIDIA GPU; Wayland desktop on the CPU | containers on the machine that runs BB, another host over SSH, or a BB machine with Docker, such as a Windows PC with WSL |
| microsandbox | Linux; Linux desktop on the CPU | microVMs, each with a kernel of its own, on a Linux host with KVM or a Mac with Apple silicon: an option beside Docker, not the default |
| Proxmox LXC | Linux; Linux desktop on the CPU or a GPU; Wayland desktop on the CPU | containers on a Proxmox VE host |
| Proxmox QEMU | Windows desktop | virtual machines on a Proxmox VE host |
| [Tart](https://tart.run) | macOS, with or without a desktop; Linux on arm64, with or without a desktop; Windows desktop on arm64 | virtual machines on your Macs with Apple silicon |
| SSH host pool | Linux; macOS, with or without a desktop | your own physical machines, lent to one thread at a time and reset after |

Notes:

- Windows boxes join BB as machines, as Linux and macOS boxes do, on Proxmox and on a Mac. Each backend's Windows enrolment setting turns this off. A thread cannot yet start on a new Windows box from BB's new-thread screen ([BB requests](docs/bb-requests.md)).
- Most Linux boxes have Docker. One that does not says No Docker.
- Macs in the SSH host pool are built, but not yet checked on a real Mac.

Every kind of box, and its sizes, is in [kinds and sizes](docs/reference/kinds.md).

## Spares, video, sound and images

- A kind can keep spare boxes, made and joined to BB ahead, so a thread gets one in seconds. A Windows or macOS VM's spare waits stopped, holding no memory. See [settings](docs/guide/settings.md#kinds).
- A Linux desktop on X11, drawn by the CPU, can show as video, which stays smooth on a slow connection. Every viewer gets video, and **Show as VNC** goes back; a setting turns it off. See [desktops](docs/guide/desktops.md#video).
- A macOS box on Tart has a microphone a test can speak into, and what an agent runs in its desktop session can use the microphone, the camera and the system's audio without a prompt. See the [Tart guide](setup/tart/README.md#macos).
- bb-box rebuilds its standard images as they come due, each night: Linux weekly, macOS and Windows monthly. A new build replaces the old one only once a trial box passes its checks, and a Windows image keeps the build before as a rollback. See [images](docs/guide/images.md#standard-images-stay-up-to-date).

## Documentation

- [User guide](docs/guide/README.md): the Box panel, making a box, desktops, the terminal, images, jobs, files and settings
- [Setting up bb-box](setup/README.md): choose a backend, install, rebuild images each night, upgrade and remove
- Setup guides for each backend:
  - [Docker](setup/docker/README.md), and [Docker in WSL on a Windows PC](setup/docker-wsl/README.md)
  - [microsandbox](setup/microsandbox/README.md), an option beside Docker for boxes with a kernel of their own
  - [Proxmox LXC](setup/proxmox-lxc/README.md)
  - [Proxmox QEMU](setup/proxmox-qemu/README.md)
  - [Tart](setup/tart/README.md)
  - [SSH host pool](setup/ssh-pool/README.md)
- [Reference](docs/reference/README.md): the command line, agent tools, configuration, kinds and health checks, made from the code
- [Architecture](docs/architecture.md), and [developing bb-box and writing a backend](docs/development.md)
- [Decision records](docs/decisions), [research notes](docs/research) and [design specs](docs/design)
- [What bb-box asks of BB](docs/bb-requests.md)

## Develop

```sh
npm run typecheck
npm test
```

The tests need Node 22.18 or later, which runs TypeScript directly. They use fakes of each provider, so they need no host. To check a backend against a real provider, and to write a new one, see [developing bb-box](docs/development.md).

## Third-party code

What bb-box bundles, and what its images install, is in [third-party software](THIRD-PARTY.md), with each licence.
