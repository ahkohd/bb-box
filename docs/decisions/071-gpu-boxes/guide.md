# GPU boxes for compute and training

A draft of the guide page decision [071](../071-gpu-boxes.md) adds, as unit
15 will put it in `docs/guide/gpu-boxes.md`. It describes the design, not
what is built today.

A Linux box can have an NVIDIA card: a server for training and inference,
or a desktop for apps drawn on the GPU. You choose the GPU when you make
the box, and you can change it later with Resize.

## What you get

A box with a GPU has one card. You choose how it has it:

- **Shared**: the card is shared with other boxes, up to the boxes per card
  in BB Box's settings (4 by default). Boxes on a card share its memory and
  its time.
- **Whole card**: BB Box places no other box on the card while your box
  holds it. Use it for a long training run.
- **None**: BB Box gives the box no card.

You can choose a GPU on a Linux server or a Linux desktop (X11) on x86_64,
where a provider has cards: Proxmox LXC on a host with NVIDIA cards and BB
Box's GPU helper, or Docker with the NVIDIA Container Toolkit.

If you do not choose, a desktop gets a shared GPU and a server gets none.
BB Box's settings can change that for each kind.

In the box you have:

- `nvidia-smi`, which shows the card, its memory and the processes using
  it;
- NVIDIA's driver libraries for the host's driver: CUDA's driver library,
  NVML, NVENC and NVDEC, OpenGL, EGL and Vulkan;
- Docker, as every Linux box has (041). Containers inside the box do not
  see the card yet.

The box does not have the CUDA toolkit (`nvcc`, cuBLAS, cuDNN). Most
frameworks bring their own CUDA libraries, so you need only the driver
libraries the box has.

## Make a box with a GPU

In BB, select **New box**, then:

1. Choose **Linux**, then **Server** or **Desktop**.
2. Under **Resources**, choose a size, then a **GPU**: Shared or Whole card.
   The line under the menu says which card the box would get, and how much
   of its memory was free when it was last read.
3. Select **Create box**.

An agent asks with `box_acquire`:

```text
box_acquire kind: linux, size: large, gpu: whole
```

If no card can take it, BB Box says which boxes are on each card, and
changes nothing.

## Check the card

In the box's terminal:

```sh
nvidia-smi
```

On Proxmox LXC it shows the box's card. On a shared card, its memory and
use are the whole card's, other boxes' included, though it may not list
their processes. The box's page in BB shows the same card, with your box's
own processes and memory marked.

On Docker, `nvidia-smi` lists every card on the host. To see your box's
own card:

```sh
nvidia-smi -i "$NVIDIA_VISIBLE_DEVICES"
```

In the box, CUDA sees the box's card as device 0, whatever its number on
the host.

## Run PyTorch on the card

```sh
python3 -m venv ~/torch
~/torch/bin/pip install torch
~/torch/bin/python -c 'import torch; a = torch.rand(4096, 4096, device="cuda"); print(torch.cuda.get_device_name(0), (a @ a).sum().item())'
```

PyTorch's wheels bring their own CUDA libraries. If you need the CUDA
toolkit itself, install it from NVIDIA's package repository for Ubuntu
24.04, choosing a CUDA version your host's driver supports. `nvidia-smi`
shows the highest CUDA version the driver supports, top right. Do not
install NVIDIA's driver packages (`nvidia-driver-*`, `cuda-drivers`) from
apt: the box already has the driver's libraries, and BB Box cannot update
them while those packages are there.

To have the toolkit in every box of a project, put the install in the
project's box image script (see [Box images](../../guide/images.md)).

## Change a box's GPU

On the box's page, select **Resize…**, or **Change…** on its GPU card. Under
**GPU**, choose None, Shared or Whole card. **What changes** says what will
happen before anything does:

| Change | What happens |
| --- | --- |
| Shared to whole card, with no other box running on the card | At once. Nothing in the box stops. Stopped boxes on the card go to another card when they next start |
| Shared to whole card, with other boxes running on the card | BB Box offers to move the box to a free card. That restarts the box, and everything running in it stops. If no card is free, it says which boxes are on each card |
| Whole card to shared | At once. Other boxes can then be placed on the card |
| None to a GPU, or a GPU to none | A restart. Everything running in the box stops |

A box that is stopped stays stopped: it has its new GPU from its next
start.

If the box has no NVIDIA userspace, or an older one than the host's driver,
adding a GPU installs it in the same restart, which takes about a minute
more. A desktop is then drawn by the GPU. BB Box says before if it cannot
install it, for example when the box has NVIDIA's packages from apt.

On Docker, a box's card cannot be added, removed or changed after the box
is made, because a container's devices are fixed. Make a new box instead.

An agent asks with `box_resize`, with `check: true` first to see what would
change, and `restart: true` for a change that needs a restart. Left out,
the GPU stays as it is.

## When a box is stopped

A stopped box with a whole card keeps its card, so a paused job gets it
back.

A stopped box with a shared GPU does not hold a place on its card. When it
starts, it goes back to its last card if there is room, or to another card.
If no card has room, the start is refused and says why; you can start it
with no GPU instead.

## Snapshots and forks

- **A snapshot holds the disk, not the card's memory.** After a restore,
  start your training again from its last checkpoint.
- **A restore keeps the box's GPU as it is now**, whatever it was when the
  snapshot was taken.
- **A fork starts with no GPU**, unless you ask for one. A fork of a box
  with a whole card needs a free card of its own.

## Limits

- **Free memory is a reading.** The memory shown as free is what the card
  had when it was last read, with how long ago. BB Box checks it as a box
  starts, but it is not reserved: another box or program can take it
  after.
- **A shared card has no memory limit per box.** One box can take all of
  the card's memory, and programs in the other boxes then fail to allocate
  memory. For work that needs the card's memory, choose a whole card.
- **A whole card is fenced from other boxes on Proxmox LXC only.** On
  Proxmox LXC no other box can open the card. Programs on the host itself
  can still use it.
- **On Docker, every box with Docker in it can open every card**, with a
  GPU or without. There, None and Whole card are where BB Box places
  boxes, not what a box can reach. BB Box points CUDA at the box's own
  card, but a program can still open another.
- **After the host's NVIDIA driver is upgraded**, `nvidia-smi` fails in a
  box made before, with "Driver/library version mismatch". The doctor
  names these boxes, and the box's page offers to update NVIDIA's
  userspace in the box. BB Box never updates it by itself.
- **One card per box.** A box cannot have two cards yet.
- **Only NVIDIA cards**, on x86_64 Linux boxes.

## Set it up

- **Proxmox LXC**: follow the setup guide's GPU steps: the host's driver,
  its device nodes at boot, and the GPU helper (`host/setup-gpu.sh`),
  which gives each box its card. The helper starts in a dry run that
  changes no box; after a day of it, turn its writes on with
  `setup-gpu.sh --writes on`. Without the helper, only desktops can have a
  card, and only the one their template names.
- **Docker**: install the NVIDIA Container Toolkit and generate its CDI spec,
  then turn on **GPU boxes** in BB Box's Docker settings.

The helper runs as root on the host. Once it is there, BB Box's API token
can give a box in its pool a card's device nodes, which it could not do
before; that opens NVIDIA's kernel driver to the box.

In BB Box's settings, each backend's GPUs section sets the boxes per card,
whether whole cards are allowed, and the GPU memory a new box needs free.
The `linux` and `linux-desktop` kinds' pages set the GPU a box gets when it
is not asked for. No setting changes a box's own GPU.
