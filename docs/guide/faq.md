# Common questions

Short answers to what people ask first about BB Box. Each answer links to the page that has the detail.

## Is a box a security boundary?

No. BB Box assumes one trusted user, and it is not a sandbox for code you do not trust. A Docker box is a privileged container by default, which can take over its Docker host. A box on an SSH host pool machine can read what any user there can read, and a shared iOS box is a macOS user on a Mac it shares with other boxes.

Give boxes only machines that hold nothing you would not show them. Turn off **Docker in boxes** and Docker boxes run unprivileged, without Docker of their own. See [the Docker settings](../reference/configuration.md#docker) and [the SSH host pool](../../setup/ssh-pool/README.md).

## How does BB Box handle keys and tokens?

Backend secrets, such as API tokens and SSH keys, stay in BB Box: a secret's value never leaves it, and settings and exports show only whether one is set. See [secrets](../reference/configuration.md#secrets).

A box that joins BB gets the thread's Git credentials and variables through BB, and a box that does not join gets neither. See [when a box does not join BB](boxes.md#when-a-box-does-not-join-bb).

For cloud machines on a tailnet, BB Box makes a single-use key for each machine from a Tailscale OAuth client. See [Network](settings.md#network). A fork gives up its source's BB credentials, and BB Box checks they are gone before it hands the fork over. Other secrets on the disk stay. See [a copy of a box gives up its identity](snapshots.md#a-copy-of-a-box-gives-up-its-identity).

## What stops a cloud bill running away?

Each cloud backend has a limit on what it runs at once, 2 by default: **Most hosts** on Hetzner Cloud, **Most machines** on Namespace and **Most boxes** on boat.dev. Hetzner Cloud also has a **Monthly limit (EUR)**, 20 by default, and deletes a host 30 minutes after its last box goes. See [keeping the cost down on Hetzner Cloud](hetzner.md#keeping-the-cost-down).

Rented machines end even if BB Box stops or loses track of them. A boat.dev box stops 30 minutes after BB Box last renewed it, and BB Box keeps a Namespace machine's end only an hour ahead while its box is held. It destroys a Namespace machine whose box has gone once BB says the box's thread has ended. See [the auto-stop on boat.dev](boat.md#stop-start-and-the-auto-stop) and [checking that nothing is left running on Namespace](namespace.md#check-that-nothing-is-left-running).

Spares back off when they fail. A device spare that does not boot within 10 minutes stops spares of its kind for 30 minutes, and a project image's spare that fails to start stops spares of that build for a day. See [spares of device boxes](spares.md#spares-of-device-boxes) and [checks](../reference/checks.md).

## How long does a box last?

A box belongs to a thread. It stays until you release it, or until its thread is archived or deleted, and releasing it deletes everything on its disk. A machine is a box of your own that belongs to no thread, and stays until you remove it. A snapshot you keep outlasts its box. See [the user guide](README.md), [your machines](boxes.md#your-machines) and [keeping a snapshot](snapshots.md#keeping-a-snapshot).

## Do I need hardware of my own?

No. Hetzner Cloud, Namespace and boat.dev each make boxes with no machine of your own. Their machines reach BB's server through bb connect or [the tailnet](tailnet.md). With several backends turned on, **First with room** tries them in order and uses the first with room for the box. See [choose a backend](../../setup/README.md#choose-a-backend) and [Provider](making-a-box.md#provider).

## Which backend should I start with?

Docker on Linux, microsandbox on a Mac with Apple silicon, and Docker in WSL 2 on Windows. Each runs boxes on the machine that runs BB. See [the quick start](../../README.md#quick-start).

## Which systems can boxes run?

| System | Backends |
| --- | --- |
| Linux | Docker, microsandbox, Proxmox LXC, Proxmox QEMU, SSH host pool, Hetzner Cloud, Namespace, boat.dev |
| Linux on arm64 | Tart, microsandbox, Hetzner Cloud |
| Linux desktop | Docker, microsandbox, Proxmox LXC, Proxmox QEMU, Hetzner Cloud, Namespace, boat.dev |
| Linux desktop on a GPU | Docker, Proxmox LXC |
| macOS, with or without a desktop | Tart, SSH host pool, Namespace |
| Windows desktop | Proxmox QEMU, and Tart on arm64 |
| iPhone and iPad in the iOS Simulator | Tart, SSH host pool, Namespace |
| Android emulator | Proxmox QEMU, boat.dev |

See [kinds and sizes](../reference/kinds.md) and [backends and boxes](../../README.md#backends-and-boxes).

## What does it cost?

BB Box is under the MIT licence, and boxes on machines of your own cost nothing more. Cloud backends bill your own account with each provider, and boat.dev bills saved snapshots beyond your plan's. See what it costs on [Hetzner Cloud](hetzner.md#what-it-costs), [Namespace](namespace.md#what-it-costs), [boat.dev](boat.md#what-it-costs) and [a cloud server as a Docker host](cloud-docker-host.md#what-it-costs).

## Why does a box say Could not join BB?

A box joins BB by reaching BB's server, and BB on its own listens only on 127.0.0.1, which a box cannot reach. Sign in to your bb account in BB so bb connect reaches it, or set Machine access to **Manual** with an address boxes can reach, and start BB listening there. See [when a box does not join BB](boxes.md#when-a-box-does-not-join-bb).
