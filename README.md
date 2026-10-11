# bb-box

Computers for [BB](https://getbb.app) threads. Each thread gets boxes of its own: Linux, macOS or Windows, virtual or physical, with or without a desktop. You and the thread's agent both use them from BB.

bb-box is a BB plugin, which shows in BB as BB Box. It is for people who run BB for themselves and want their agents to have real machines. A desktop lets an agent build and test apps in a real browser or native interface. A plain machine runs Docker, services and builds. Either way, the work runs on a box and not on your own computer.

## Why bb-box

- A box belongs to its thread. It has what the thread has: its Git credentials, its machine variables, BB itself, and the same network reach.
- It works with any provider. A hypervisor, a container host, a physical machine or a cloud is a backend behind one interface.
- It is fast. A box is ready in seconds, and a warm box at once.
- You share control. You and the agent use the same desktop, and the agent waits while you have control.
- There are no surprises. A box lasts until someone releases it or its thread ends, with no expiry and no idle timeout.
- It is easy to set up. Each backend has a short guide, `bb box doctor` says what is missing, and one conformance suite runs against every backend. See the [architecture](docs/architecture.md).

bb-box assumes one trusted user. It is not a sandbox for code you do not trust.

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

## Quick start

This takes about 5 minutes, with Docker on the machine that runs BB. You need:

- a Linux machine that runs BB and Docker Engine, with BB's user in the `docker` group
- Node 22.18 or later, and npm
- about 10 GB of free disk and 8 GiB of memory

1. Install the plugin on the machine that runs BB:

   ```sh
   git clone https://github.com/moonstead/bb-box.git && cd bb-box
   npm install
   bb plugin build
   bb plugin install .
   ```

2. Build the Linux image. This takes a few minutes:

   ```sh
   setup/docker/build.sh linux
   ```

3. Turn on the Docker backend. In BB, open Settings, Plugins, BB Box. Under Backends, select **Set up** on Docker. Leave the host empty. Empty **Desktop image** and **Wayland desktop image**, as you have not built them. Select **Check**, then **Save and turn on**.

4. Make a box. Open a thread and select the **Box** tab in its right panel. Select the plus, choose **Linux** and **Server**, then select **Create box**. The box is ready in about a second, and joins BB a few seconds later.

5. Use it. Select **Open terminal** on the box's row. Or ask the thread's agent: "Get a Linux box and run uname -a in it."

When you are done, select **Release…** in the box's menu. A box also goes when its thread is archived or deleted.

If something is wrong, run `bb box doctor`. It checks the setup and says what to fix. For desktops, see the [Docker guide](setup/docker/README.md).

If a box says 'Could not join BB', it cannot reach BB's address from inside its container. Make BB listen on an address the containers can reach, or turn off **Enrol boxes as BB machines** under General in BB Box's settings. Boxes still work without it, but do not get the thread's Git credentials and variables.

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
