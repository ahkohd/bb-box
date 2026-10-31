# GPU boxes for compute and training

A draft of the guide page decision [071](../071-gpu-boxes.md) adds, as unit
8 will put it in `docs/guide/gpu-boxes.md`. It describes the design, not
what is built today.

A Linux box can have an NVIDIA card: a server for training and inference,
or a desktop for apps drawn on the GPU. You choose the GPU when you make
the box, and you can change it later with Resize.

## What you get

A box with a GPU has one card. You choose how it has it:

- **Shared**: the card is shared with other boxes, up to the boxes per card
  in BB Box's settings (4 by default). Boxes on a card share its memory and
  its time.
- **Whole card**: no other box is placed on the card while your box has it.
  Use it for a long training run.
- **None**: no card.

You can choose a GPU on a Linux server or a Linux desktop (X11) on x86_64,
where a provider has cards: Proxmox LXC on a host with NVIDIA cards, or
Docker with the NVIDIA Container Toolkit.

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
   of its memory is free now.
3. Select **Create box**.

An agent asks with `box_acquire`:

```text
box_acquire kind: linux, size: large, gpu: whole
```

## Check the card

In the box's terminal:

```sh
nvidia-smi
```

It lists the box's card. On a shared card, its memory and use are the whole
card's, other boxes' included, though it may not list their processes. The
box's page in BB shows the same card, with your box's own processes and
memory marked.

In the box the card is always CUDA device 0, whatever its number on the
host.

## Run PyTorch on the card

```sh
python3 -m venv ~/torch
~/torch/bin/pip install torch
~/torch/bin/python -c 'import torch; a = torch.rand(8192, 8192, device="cuda"); print(torch.cuda.get_device_name(0), (a @ a).sum().item())'
```

PyTorch's wheels bring their own CUDA libraries. If you need the CUDA
toolkit itself, install it from NVIDIA's package repository for Ubuntu
24.04, choosing a CUDA version your host's driver supports. `nvidia-smi`
shows the highest CUDA version the driver supports, top right.

To have the toolkit in every box of a project, put the install in the
project's box image script (see [Box images](../../guide/images.md)).

## Change a box's GPU

On the box's page, select **Resize…**, or **Change…** on its GPU card. Under
**GPU**, choose None, Shared or Whole card. **What changes** says what will
happen before anything does:

| Change | What happens |
| --- | --- |
| Shared to whole card, with no other box on the card | At once. Nothing in the box stops |
| Shared to whole card, with other boxes on the card | BB Box offers to move the box to a free card. That restarts the box. If no card is free, it says which boxes are on each card |
| Whole card to shared | At once. Other boxes can then be placed on the card |
| None to a GPU, or a GPU to none | A restart. Programs using the card stop |

On Docker, a box's card cannot be added, removed or changed after the box
is made, because a container's devices are fixed. Make a new box instead.

An agent asks with `box_resize`, with `check: true` first to see what would
change, and `restart: true` for a change that needs a restart.

## Limits

- **A shared card has no memory limit per box.** One box can take all of
  the card's memory, and programs in the other boxes then fail to allocate
  memory. For work that needs the card's memory, choose a whole card.
- **A whole card is fenced from other boxes on Proxmox LXC only.** On Proxmox
  LXC no other box can open the card. On Docker, a box with Docker in it
  can see every card on the host; BB Box points CUDA at the box's own card,
  but a program can still open another. Neither stops the host itself, or
  machines that are not BB Box's, from using the card.
- **A box's memory on the card is not in snapshots.** A snapshot holds the
  disk. After a restore, start your training again from its last
  checkpoint.
- **After the host's NVIDIA driver is upgraded**, `nvidia-smi` fails in a box
  made before, with "Driver/library version mismatch". The doctor names
  these boxes, and the box's page offers to update NVIDIA's userspace in
  the box.
- **One card per box.** A box cannot have two cards yet.
- **Only NVIDIA cards**, on x86_64 Linux boxes.

## Set it up

- **Proxmox LXC**: follow the setup guide's GPU steps: the host's driver, its
  device nodes at boot, and the GPU helper (`host/setup-gpu.sh`), which
  gives each box its card. Without the helper, only desktops can have a
  card, and only the one their template names.
- **Docker**: install the NVIDIA Container Toolkit and generate its CDI spec,
  then turn on **GPU boxes** in BB Box's Docker settings.

In BB Box's settings, each backend's GPUs section sets the boxes per card,
whether whole cards are allowed, and the GPU memory a new box needs free.
