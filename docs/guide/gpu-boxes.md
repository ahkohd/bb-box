# GPU boxes for compute and training

A Linux box can have an NVIDIA card. Use a server for training and inference, or a desktop for apps drawn on the GPU. You choose the GPU when you make the box. You can change it later with Resize, where the box's backend can.

## What you get

A box has one card at most. You choose how it has it:

- **None**: BB Box gives the box no card.
- **Shared**: the box shares a card with other boxes, up to the backend's boxes per card, 4 unless you change it. Boxes on a card share its memory and its time.
- **Whole card**: BB Box places no other box on the card while your box holds it. Use it for a long training run.

You can choose a GPU for a Linux server, `linux`, or a Linux desktop on X11, `linux-desktop`, on x86_64. The box's backend needs NVIDIA cards:

- Proxmox LXC, on a host with NVIDIA's driver and BB Box's GPU helper
- Docker, with NVIDIA's Container Toolkit and **GPU boxes** turned on

Whole cards are off until you turn them on for a backend, in its GPUs section in BB Box's settings. Until then you can choose None or Shared.

If you leave the GPU out, a desktop gets a shared GPU and a server gets none. Each kind's page in BB Box's settings can change that.

In the box you have:

- `nvidia-smi`, which shows the card, its memory and the processes using it
- NVIDIA's driver libraries, for exactly the host's driver: CUDA's driver library, NVML, NVENC and NVDEC, OpenGL, EGL and Vulkan
- Docker, as every Linux box has; containers inside the box do not see the card yet

The box does not have the CUDA toolkit, such as `nvcc`, cuBLAS or cuDNN. Most frameworks bring their own CUDA libraries, so they need only the driver libraries the box has.

## Make a box with a GPU

In BB, select **New box**, then:

1. Choose **Linux**, then **Server** or **Desktop**.
2. Under **Resources**, choose a size, then a **GPU**: None, Shared or Whole card. Whole card is listed only where a provider allows it.
3. Read the line under the menu. It says which card the box would get, on which host, and how much of its memory was free when it was last read, for example 'Card 1 on pve-1, shared with 2 boxes; 17.8 GiB free when read, 20 s ago.'
4. Select **Create box**.

If no card can take the box, the line says so and **Create box** stays off. Each provider's row says why, such as 'Card 0 is quiet-elm's; card 1 has 4 boxes.'

An agent asks with `box_acquire`, for example with `kind: linux` and `gpu: shared`. From the command line:

```sh
bb box acquire linux --gpu shared
```

When no card can take it, BB Box names the boxes on each card and makes nothing.

## Check the card

In the box's terminal, list the cards the box can see:

```sh
nvidia-smi -L
```

On Proxmox LXC this lists the box's own card, as `GPU 0`. On Docker it lists every card on the host. The box's card is in `NVIDIA_VISIBLE_DEVICES`:

```sh
nvidia-smi -i "$NVIDIA_VISIBLE_DEVICES"
```

On a shared card, `nvidia-smi` shows the whole card's memory and use, other boxes' included. It may not list their processes. The box's page in BB shows the same card, with your box's own processes and memory marked.

CUDA sees the box's card as device 0. On Docker, BB Box sets `CUDA_VISIBLE_DEVICES` to the box's card in the box's environment and in `/etc/environment`, so terminals, `box_run` and services all get it.

To check that CUDA's driver starts, with nothing to install:

```sh
python3 -c 'import ctypes; print(ctypes.CDLL("libcuda.so.1").cuInit(0))'
```

It prints `0` when CUDA can use the card.

## Run PyTorch on the card

```sh
python3 -m venv ~/torch
~/torch/bin/pip install torch numpy
~/torch/bin/python -c 'import torch; a = torch.rand(4096, 4096, device="cuda"); print(torch.cuda.get_device_name(0), (a @ a).sum().item())'
```

It prints the card's name and a number. PyTorch's wheels bring their own CUDA libraries. They download about 3 GB and take about 5 GB of disk, and pip keeps the download in its cache, so leave about 8 GB free. A PyTorch process takes about 650 MiB of the card's memory before it allocates anything, and this example under 900 MiB in all.

If you need the CUDA toolkit itself, install it from NVIDIA's package repository for Ubuntu 24.04. Choose a CUDA version your host's driver supports: `nvidia-smi` shows the highest, top right. Do not install NVIDIA's driver packages, `nvidia-driver-*` or `cuda-drivers`, from apt. The box already has the driver's libraries, and BB Box cannot update them while those packages are there.

To have the toolkit in every box of a project, install it in the project's image. See [images](images.md).

## Change a box's GPU

On the box's page, select **Resize…** in its menu, or **Change…** on its GPU card. Under **GPU**, choose None, Shared or Whole card. **What changes** says what will happen before anything does: Live, Restart, While stopped or Cannot change.

On Proxmox LXC:

| Change | What happens |
| --- | --- |
| Shared to whole card, with no other box running on the card | At once. Nothing in the box stops |
| Shared to whole card, with other boxes running on the card | BB Box offers to move the box to a free card. That restarts the box, and everything running in it stops. If no card is free, it names the boxes on each card |
| Whole card to shared | At once. Other boxes can then be placed on the card |
| None to a GPU, or a GPU to none | A restart. Everything running in the box stops |

A stopped box stays stopped, and has its new GPU from its next start.

If the box has no NVIDIA userspace for the host's driver, adding a GPU installs it in the same restart, which takes about a minute more. A desktop is then drawn by the GPU. BB Box says first if it cannot install it, for example when the box has NVIDIA's packages from apt.

On Docker, shared to whole card and back happen at once. A box's card cannot be added, taken away or moved, because a container's devices are fixed when it is made. Make a new box instead.

An agent asks with `box_resize`, with `check: true` first to see what would change, and `restart: true` for a change that needs a restart. Left out, the GPU stays as it is. From the command line:

```sh
bb box resize <box> --gpu whole --check
bb box resize <box> --gpu whole --restart
```

## When a box is stopped

On Proxmox LXC, a stopped box with a whole card keeps its card, so a paused job gets it back. A stopped box with a shared GPU does not hold a place on its card. When it starts, it goes back to its last card if there is room, or to another card. If no card has room, the start is refused and says why.

On Docker, a stopped box keeps its card, shared or whole.

## After the host's driver changes

After the host's NVIDIA driver is upgraded, `nvidia-smi` fails in a box made before, with 'Driver/library version mismatch'. BB Box's doctor names these boxes, and the box's page shows a notice.

BB Box never updates a box's userspace by itself. To update it, from the command line:

```sh
bb box gpu update <box> --check
bb box gpu update <box>
```

The update downloads NVIDIA's installer for exactly the host's driver, checks it, installs it with no kernel modules and restarts the box. Everything running in the box stops. Add `--snapshot` to take a snapshot first, where the backend takes snapshots.

## Snapshots and forks

- A snapshot holds the disk, not the card's memory. After a restore, start your training again from its last checkpoint.
- A restore keeps the box's GPU as it is now, whatever it was when the snapshot was taken.
- A fork starts with no GPU unless you ask for one. Only a desktop's fork can have a GPU. A fork with a whole card needs a free card of its own.

## Docker GPU boxes

On a Docker host, each box with a GPU gets one card through the Container Device Interface (CDI). BB Box places boxes on cards, and says how many boxes each card has.

- With **Docker in boxes** on, every box is a privileged container, which can open every card on the host, with a GPU or without. There, None and Whole card are where BB Box places boxes, not what a box can reach. BB Box points CUDA at the box's own card, but a program can still open another.
- In WSL, Docker gives every card as one device, so every box with a GPU has every card.
- Boxes per card on Docker counts boxes running or stopped, of every install that uses the host.

To set it up, see [GPU boxes in the Docker setup guide](../../setup/docker/README.md#gpu-boxes).

## Settings

Each backend with cards has a **GPUs** section on its page in BB Box's settings. These set limits and defaults only. No setting changes a box's own GPU.

- **Boxes per card**: the most boxes on one card, desktops and servers together, 4 unless you change it. On Proxmox LXC it counts this install's boxes that run, and 0 means no limit. On Docker it counts every install's boxes, running or stopped.
- **Whole cards**: whether a box may have a card to itself. It is a switch, and saves at once. When it is not set on the backend, it follows the install-wide option `general.wholeCards`, which is off unless set. Turned off, no box is given a whole card or changes to one, and boxes that have one keep it until they change or are released.
- **GPU memory a new box needs**: the memory a card must have free, when last read, for a new server to be placed on it, 1,024 MiB unless you change it. It is a check at the start, not a limit on what the box uses. A desktop needs 384 MiB.

Under the fields, the list of cards shows each card, its memory, the boxes on it and any guests that are not this install's. A lower limit stops nothing that runs. The list names the boxes over the limit, and no new box goes on that card until it has room.

The `linux` and `linux-desktop` kinds' pages have **GPU when not asked for**: what a box of the kind gets when a request leaves the GPU out, and the New box form's first choice. Spare boxes of a kind whose GPU is a whole card are made shared.

From the command line:

```sh
bb box backend set <backend> --field boxes-per-card=2
bb box backend set <backend> --field whole-cards=true
bb box kind set linux --gpu shared
```

## Limits

- **Free memory is a reading.** The memory shown as free is what the card had when it was last read, with how long ago. BB Box checks it as a box starts, but does not reserve it. Another box or program can take it after.
- **A shared card has no memory limit per box.** One box can take all of the card's memory, and programs in the other boxes then fail to allocate memory. For work that needs the card's memory, choose a whole card.
- **A whole card is fenced from other boxes on Proxmox LXC only.** There, no other box can open the card. Programs on the host itself can still use it.
- **One card per box.** A box cannot have two cards yet.
- **Only NVIDIA cards**, on x86_64 Linux boxes.

## Set it up

- **Proxmox LXC**: follow [the GPU helper's steps in the Proxmox LXC setup guide](../../setup/proxmox-lxc/README.md#the-gpu-helper). The helper runs as root on the host and gives each box its card. Without it, only desktops can have a card, and only the one their template names.
- **Docker**: install NVIDIA's Container Toolkit, generate its CDI spec, then turn on **GPU boxes** in the backend's GPUs section. See [GPU boxes in the Docker setup guide](../../setup/docker/README.md#gpu-boxes).

See [agent tools](../reference/tools.md#box_acquire), the [command-line reference](../reference/cli.md#bb-box-resize) and [kinds and sizes](../reference/kinds.md).
