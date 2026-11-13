# BB Box

https://github.com/user-attachments/assets/eba3dd91-6c14-42b5-a17b-b53a91e6b9fd

Computers for [BB](https://getbb.app) threads: Linux, Windows, macOS, iOS and Android, virtual or real: desktops, terminals or simulators, shared by you and your agent.

Documentation: [bbbox.dev](https://bbbox.dev).

## Why BB Box

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
- **Files.** Browse, search and edit a box's files in a tab. See [a box's files](docs/guide/box-files.md).

*BB Box assumes one trusted user. It is not a sandbox for code you do not trust.*

## Quick start

Boxes run on the machine that runs BB to start with:

- **Linux**: Docker.
  - About 10 GB of disk free and at least 8 GiB of memory for the server image.
  - About 18 GB of disk free and at least 12 GiB of memory for a desktop.
- **A Mac with Apple silicon**: [microsandbox](setup/microsandbox/README.md#on-a-mac), which needs nothing installed and runs arm64 Linux boxes as microVMs.
  - About 80 GiB of free disk while it builds its first image; about 2.4 GiB after, or 6 GiB with the desktop image.
  - Each box counts at its full memory size.
  - [Tart](setup/tart/README.md) adds macOS, iOS and Windows boxes.
  - Avoid Docker Desktop on a Mac: its images are x86_64, so boxes run emulated and slowly.
- **Windows**: Docker in WSL 2. See [Docker on a Windows PC](setup/docker-wsl/README.md).

<details open>
<summary><strong>With an agent</strong></summary>

Paste this into a BB thread. The docs site's home page has the same prompt, with a copy button.

```text
Set up BB Box for me: the BB plugin that gives threads computers of their own, called boxes.

1. Install it: bb plugin install git:https://github.com/ahkohd/bb-box.git@main --yes
2. Follow its bb-box-setup skill. If your skills do not list it yet, find it with bb skill list and read it with bb skill show <id>.
3. Look at the machine that runs BB with bb box doctor, and set up the backend the skill suggests for it: Docker on Linux or in WSL 2 on Windows, microsandbox on a Mac with Apple silicon.
4. Ask me first before anything that needs root, changes BB's settings, or makes Docker boxes privileged containers, which can take over the machine they run on.
5. Prove it: bb box kinds, then bb box acquire with the Linux kind it lists, then bb box run <box> "uname -a", then bb box release <box>.
6. Tell me what you set up, what bb box doctor says, and what is left for me to do.
```

</details>

<details>
<summary><strong>Manually</strong></summary>

1. Install BB Box from BB's plugin store. In BB, open Settings, then Installed plugins, and search for **BB Box**. Or open the plugin store and install **BB Box**.

   To install from Git instead, open Settings, then Installed plugins, then the arrow beside **New plugin**, then **Install from source**, and enter:

   ```text
   git:https://github.com/ahkohd/bb-box.git@main
   ```

   Or with BB's command line, `bb`, or `npx --package bb-app bb` where `bb` is not installed:

   ```sh
   bb plugin install git:https://github.com/ahkohd/bb-box.git@main
   ```

   The store installs the latest release and updates within 0.x. `@main` follows new work as it lands. A release tag, such as `@v0.2.1`, stays on that release.

2. On Linux, open a thread's **Box** panel, or BB Box in BB's settings, and select **Use Docker on this machine**. The Linux image usually builds in 5 to 12 minutes, depending on the machine. On a Mac with Apple silicon, run `bb box backend add microsandbox --on` instead; its arm64 image builds in about 3 minutes. `bb box doctor` checks the setup.
3. Select the plus, then **Create box**.
4. For a desktop, select the plus, choose **Desktop**, and under Display X11 or Wayland, then **Build and create**. BB Box builds that desktop's image before the first one, usually in 4 to 10 minutes.
5. Open the box's desktop. Select **Open desktop** on the box's row.

</details>

### If a box says Could not join BB

Boxes join BB by reaching BB's server. If BB is signed in to your bb account, bb connect does that. If it is not, start BB with `npx bb-app --server-bind-host 0.0.0.0`, then in BB's settings, under Machines, set Machine access to **Manual** with this machine's address on your network, such as `http://192.0.2.10:38886`. See [when a box does not join BB](docs/guide/boxes.md#when-a-box-does-not-join-bb).

## Backends and boxes

| Backend | Boxes | Where they run | Snapshots |
| --- | --- | --- | --- |
| [Docker](setup/docker/README.md) | Linux; Linux desktop on the CPU or an NVIDIA GPU; Wayland desktop on the CPU | containers on the machine that runs BB, another host over SSH, or a BB machine with Docker, such as a [Windows PC with WSL](setup/docker-wsl/README.md) | disk and Docker data, pausing the box while it copies them; take, list, delete and restore with an undo; fork; Keep, on the box's own engine |
| [microsandbox](setup/microsandbox/README.md) | Linux; Linux desktop on the CPU | microVMs, each with a kernel of its own, on a Linux host with KVM or a Mac with Apple silicon: an option beside Docker, not the default | the disk, or the disk and memory, pausing the box for a moment; restore with an undo; fork; Keep |
| [Proxmox LXC](setup/proxmox-lxc/README.md) | Linux; Linux desktop on the CPU or a GPU; Wayland desktop on the CPU | containers on a Proxmox VE host | the disk, while it runs, freezing it for a moment; restore in place with an undo, and on ZFS to the newest snapshot only, with a full copy as the undo; fork; Keep as a copy that cannot start |
| [Proxmox QEMU](setup/proxmox-qemu/README.md) | Windows desktop; Linux with a kernel of its own, and KVM where the host allows; Android emulator devices | virtual machines on a Proxmox VE host | Linux: the disk, or the disk and memory, stopping the VM while Proxmox snapshots its disks; restore with an undo, but not on ZFS yet; fork and Keep from the disk. Windows: the disk, with its EFI and TPM state volumes, taken while it runs; restore in place with a snapshot undo on LVM-thin, Ceph RBD, BTRFS and qcow2. No memory snapshot, no fork and no Keep. On ZFS, take and delete work, and restore is refused. Android: the whole VM disk while it runs, with the same restore limits as Windows. Each device boots cold after a restore. No memory, fork or Keep |
| [Tart](setup/tart/README.md) | macOS, with or without a desktop; Linux on arm64, with or without a desktop; Windows desktop on arm64; iOS Simulator devices, in a VM of their own or a slot on a shared host | virtual machines on your Macs with Apple silicon | macOS, and iOS Simulator devices in a VM of their own: the disk and memory, restored running as it was. Linux: the disk, taken while stopped. These restore with an undo, fork and Keep. Linux desktops need reset version 9; older images refuse and say why. Windows: the disk, taken after Windows shuts down, restored in place with an undo; no fork or Keep. None for iOS devices in a slot on a shared host |
| [SSH host pool](setup/ssh-pool/README.md) | Linux; macOS, with or without a desktop; iOS Simulator devices, in slots on its Macs | machines over SSH, physical or a VPS | none |
| [Hetzner Cloud](docs/guide/hetzner.md) | Linux; Linux desktop on the CPU; Wayland desktop on the CPU; Linux on arm64, with or without a desktop | containers on x86 or Arm Docker hosts BB Box rents in your Hetzner Cloud project as boxes need them, and deletes when idle | Linux: disk and Docker data on the box's host, pausing the box while it copies them; restore with an undo; fork on the same host; no Keep, as a release deletes them |
| [Namespace](docs/guide/namespace.md) | macOS, with or without a desktop; Linux, with KVM; Linux desktop on the CPU; Wayland desktop on the CPU; iOS Simulator devices, in slots on a shared Mac | a Namespace machine for each box, a Mac or a Linux machine, rented by the minute in your Namespace workspace, within its plan's limits | Linux: disk and Docker data on the box's machine, which ends with them, pausing the box while it copies them; restore with an undo; no fork or Keep yet. None for Macs or iOS devices |
| [boat.dev](docs/guide/boat.md) | Linux, with KVM; Linux desktop on the CPU; Android emulator devices | a boat.dev sandbox for each box, a Linux VM forked from BB Box's template in seconds and billed by the second | on a paid plan, the disk, as a saved snapshot on your account: free up to your plan's included ones, then $0.056 a day each; restore with an undo; fork and Keep for Linux boxes. None on the free trial |

Docker boxes keep Docker data in labelled volumes. Maintenance retries failed
removals after other upkeep; a held volume does not stop the remaining cleanup.

Every kind of box, and its sizes, is in [kinds and sizes](docs/reference/kinds.md). Phones and tablets are in [device boxes](docs/guide/devices.md).

## Documentation

- [User guide](docs/guide/README.md)
- [Common questions](docs/guide/faq.md)
- [Setting up BB Box](setup/README.md)
- [Reference](docs/reference/README.md)
- [Architecture](docs/architecture.md)
- [Developing BB Box and writing a backend](docs/development.md)
- [Decision records](docs/decisions)
- [Research notes](docs/research)
- [Design specs](docs/design)
- [What BB Box asks of BB](docs/bb-requests.md)

## Licence

BB Box is under the [MIT licence](LICENSE). The software it bundles, and the software it installs on hosts and in images, keeps its own licence: see [Third-party software](THIRD-PARTY.md).
