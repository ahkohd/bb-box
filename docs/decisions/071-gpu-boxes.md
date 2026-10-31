# 071: A GPU is part of a box's size, on any Linux box: none, shared or a whole card, chosen when it is made and changed by Resize

Status: proposed, 31 October 2026. Not built yet: see [How it is
built](#14-how-it-is-built) and its [gates](#gated-in-unit-n). It has the
owner's direction of 31 October 2026 built in: see [The owner's
direction](#the-owners-direction).

The prototype is [071-gpu-boxes/prototype.html](071-gpu-boxes/prototype.html):
one file, opened in any browser, made from bb-box's own components with a
fake server, as 069's and 070's were. Its source is in
[071-gpu-boxes/prototype](071-gpu-boxes/prototype/). How to click through
it is under [The prototype](#the-prototype). The guide page this note
adds, "GPU boxes for compute and training", is drafted in
[071-gpu-boxes/guide.md](071-gpu-boxes/guide.md).

Extends [028](028-a-box-size-is-chosen-when-it-is-made.md): a box's size
gains a GPU part. Extends
[061](061-a-box-can-be-resized-live-where-its-backend-can-and-restarted-only-when-asked.md):
Resize changes the GPU part, live where only a placement rule changes and
with a restart where the box's devices change. Partly supersedes
[012](012-offers-may-add-features.md) and the kinds table in [the
architecture](../architecture.md): `gpu` is no longer part of a kind, and
`linux-desktop-cpu` becomes another name for a `linux-desktop` with no GPU.
Extends [020](020-control-belongs-to-a-viewer.md): a box with a GPU that
starts without it is retried on another card, servers as well as desktops.
Extends [067](067-settings-page.md): each backend with cards has a GPUs
section. Extends [069](069-boxes-page.md): a box's page has a GPU fact and
card. Extends [070](070-snapshots.md): what a restore and a fork do to a
box's GPU.

## Context

The owner trains models on GPU boxes. Today the only way to get a GPU is to
ask for a Linux desktop. The owner said a headless GPU box "is a
configuration choice", not a kind of box.

### The owner's direction

Given through the lead on 31 October 2026, while this note was written:

- Sharing or a whole card is chosen per box, in the box's interface, and can
  be switched at will after the box exists, not only when it is made.
- The New box form has GPU None, Shared and Whole card, for servers and
  desktops alike.
- A box's own page and menu change it later, as part of Resize: the GPU is
  part of a box's size. The words say what happens.
- Whole card is a placement rule. Shared to whole is instant when no other
  box is on the card. When others are, bb-box offers to move this box to a
  free card, which is a restart since its device changes, or refuses and
  says who is on the card. Whole to shared is instant. Adding or removing a
  GPU is a restart.
- Backend settings set only limits and defaults, such as boxes per card and
  whether whole cards are allowed, never a box's own choice.
- Agents: `box_acquire` and `box_resize` take the same choice.

### Who uses GPU boxes, and for what

Most frequent first. Estimated from the owner's use, not measured.

| # | Task | Who | How often |
| --- | --- | --- | --- |
| 1 | Run a training or inference job on a card, from a terminal or a thread | person; agent | Daily, for hours or days |
| 2 | Watch what the card is doing: use, memory, temperature, the processes on it | person | Many times a day |
| 3 | Make a box with a GPU for a new piece of work | person; agent | Weekly |
| 4 | Give a long job the card to itself, then let others share it again | person | Weekly |
| 5 | Add a GPU to a box that turned out to need one, or take it away | person; agent | Weekly |
| 6 | Use a desktop on the GPU for WebGL, Vulkan and native apps | person; agent | Weekly |
| 7 | Snapshot or fork a GPU box before a risky change | agent | Weekly, once 070 is built |

### What bb-box offers today

**Proxmox LXC.** One kind has a GPU: `linux-desktop`, an X11 desktop.

- Each GPU desktop template carries one card's device nodes as `devN`
  lines: `/dev/nvidiaN`, `nvidiactl`, `nvidia-uvm`, `nvidia-uvm-tools`,
  `nvidia-modeset` and the card's DRM render and card nodes
  (`gpu_lines` in
  [build.sh](../../setup/proxmox-lxc/template/build.sh)). A second card
  needs a second template, made with `build.sh copy-desktop`.
- Device lines can be set by `root@pam` only, and not by its API tokens.
  bb-box's token never sets them: its clones copy them from the template
  (the comment above `pct set "$ct" $devices` in build.sh).
- The template has NVIDIA's userspace for exactly the host's driver,
  installed with no kernel modules
  ([customize-desktop.sh](../../setup/proxmox-lxc/template/guest/customize-desktop.sh)).
  The doctor fails a template whose userspace is not the host's driver, as
  the last box saw it (049).
- A new desktop goes to the card with the fewest desktops, then to that
  card's least used template (`#choose` in
  [backend.ts](../../src/backends/proxmox-lxc/backend.ts)). The setting
  `desktops-per-gpu` caps desktops per card; 0, the default, means no
  limit.
- A desktop needs 384 MiB of GPU memory free as it starts. bb-box reads
  each card's free memory from the host's report
  ([bb-box-gpu-memory](../../setup/proxmox-lxc/host/bb-box-gpu-memory)),
  which a root timer writes every 15 s into the notes of a VM that is never
  started, or from inside a running desktop where there is no report
  (#603).
- A desktop whose display came up on the CPU is released and retried on
  another card, and new desktops avoid that card for 10 minutes (020).
- `linux` boxes have no GPU. `linux-desktop-cpu` is the same desktop, drawn
  by the CPU, from templates with no NVIDIA userspace.

**Docker.** `gpu-desktops` turns on `linux-desktop` boxes, each with one card
that the NVIDIA Container Toolkit lists as a CDI device. The setting
`desktops-per-gpu` caps them at 4 a card by default. A stopped desktop
keeps its card. A desktop with Docker in it is privileged and sees every
card on the host, so its start script points Xorg at the one placed (#283).
GPU desktops on Docker have not been tested on a host with a card
([setup/docker/README.md](../../setup/docker/README.md#gpu-desktops)).

**The New box form** shows a GPU menu, None or 1 GPU, only for a desktop
whose system has both a GPU desktop and a CPU one
([new-box.tsx](../../src/app/new-box.tsx)). A server has no GPU menu.

**Resize** (061) changes cores, memory and disk, each `live`, `restart` or
`no` per backend ([resize.tsx](../../src/app/resize.tsx), `Resizing` and
`ResizePlan` in [types.ts](../../src/backends/types.ts)).

**The Monitor** shows a GPU tile where a reading has GPU figures. A change
being built alongside this note adds NVIDIA figures wherever bb-box shows a
machine's load: per card, use, memory used and total, temperature, power,
and the processes using it; a box that shares a card shows the card's
figures as the whole card's, with the box's own processes and memory
marked. This note uses those figures and does not repeat them.

### What stands in the way

1. A headless box cannot have a GPU. Training does not need a desktop.
2. A box cannot gain, lose or change its card after it is made. On Proxmox
   LXC that needs device lines changed, which only `root@pam` can do.
3. A card is either shared or not offered. Nothing gives a long job a card
   to itself.
4. Each card needs its own template, and every template is rebuilt when the
   host's driver changes.

## Decision

### 1. A GPU is part of a box's size

A box's size (028) gains a fourth part:

| Part | Values | Example |
| --- | --- | --- |
| `gpu` | `none`, `shared` or `whole` | `shared` |

- `none`: no card. The box has no NVIDIA device nodes.
- `shared`: one card, which other boxes may share, up to the backend's
  boxes per card.
- `whole`: one card that no other box is placed on while this box has it.

A box with a GPU also has a placement: which card it is on. The placement is
the backend's, as a box's host is; the size says only what was asked.

```ts
type GpuPart = "none" | "shared" | "whole";

interface BoxSize {
  readonly cores: number;
  readonly memoryMiB: number;
  readonly diskGiB: number | null;
  readonly gpu: GpuPart;
}

interface CardPlacement {
  readonly card: string;
  readonly index: number;
  readonly model: string;
  readonly memoryMiB: number;
}
```

`card` is the card's UUID, as `nvidia-smi -L` gives it. `index` is
nvidia-smi's index, which follows PCI order and is how the pages name a
card: "card 0", "card 1".

A box record made before this note has no `gpu`. It reads as `shared` for a
`linux-desktop` box on a backend with cards, and `none` for every other
box, which is what those boxes have.

One card at most, for now. Two whole cards in one box, for training across
both, is [question 2](#questions-for-the-owner).

#### Kinds

`gpu` leaves the kind. Linux on x86_64 has these kinds:

| Kind | What it is | GPU |
| --- | --- | --- |
| `linux` | A server: a terminal, Docker, no screen | none, shared or whole, where the backend has cards |
| `linux-desktop` | An X11 desktop | none, shared or whole, where the backend has cards |
| `linux-desktop-cpu` | Another name for `linux-desktop` with `gpu` none | none |
| `linux-desktop-wayland-cpu` | A Wayland desktop | none: Wayland on NVIDIA needs the host's `nvidia-drm` with `modeset=1` (048) |

- `linux-desktop-cpu` stays as a name, so agents, skills and saved settings
  that use it go on working. `box_list` lists it under `linux-desktop` as
  "also `linux-desktop-cpu`, the same with no GPU". A box made as
  `linux-desktop-cpu` is a `linux-desktop` box with `gpu` none, and says so.
- A `linux-desktop` box asked for with no `gpu` gets `shared` where a
  provider has cards, as it does today. A `linux` box asked for with no
  `gpu` gets `none`. This is [question 1](#questions-for-the-owner).
- Arm64 Linux, macOS, Windows and device boxes have no GPU part. Their
  forms and tools do not offer one: no dead controls.

A desktop with `gpu` none on Proxmox LXC is cloned from today's CPU desktop
template, which draws with the CPU and encodes video with x264 (060). A
desktop with a GPU is cloned from the GPU desktop template.

### 2. Which backends offer it

| Backend | None | Shared | Whole card | Add or remove a GPU later | Move to another card |
| --- | --- | --- | --- | --- | --- |
| Proxmox LXC | yes | yes | yes | yes, with a restart | yes, with a restart |
| Docker | yes | yes | yes | no: a container's devices are fixed when it is made | no, for the same reason |
| Proxmox QEMU (057) | yes | no | later: a card passed through whole, see [Alternatives](#alternatives-considered) | later | later |
| SSH host pool, Linux machines with a card | later: a machine's card is its own, so whole only | | | | |
| microsandbox, Hetzner Cloud, Namespace, boat.dev, Tart | none | | | | |

Proxmox LXC is the backend the owner trains on, so it is built first and in
full. Docker follows with what Docker can do. The rest are later, or have no
cards.

### 3. Where a box's card is: placement

A backend lists its cards and, for each, the boxes on it. A box is "on" a
card when its placement names the card, running or stopped: a stopped box
takes its card again when it starts.

**Shared.** A shared box goes to a card that:

1. no box has whole;
2. has fewer boxes than the backend's boxes per card;
3. has at least the GPU memory a new box needs free, as last read (see
   below).

Of those, it goes to the card with the fewest boxes, then the most memory
free, then the lowest index. A shared box is never placed on a card a box
has whole.

**Whole.** A whole box goes to a card with no box on it, of this install or
another, running or stopped, and with the memory a new box needs free. Of
those, the most memory free, then the lowest index. Whole is refused where
the backend's settings do not allow whole cards.

Warm guests and spares (032) are placed as shared boxes, and count on their
card. A whole box never claims a warm guest or a spare. A card whose only
guests are warm ones is free for a whole box: bb-box retires those warm
guests first, as they are not boxes.

**GPU memory.** A new box with a GPU needs memory free on its card as it
starts:

- a desktop: 384 MiB, what its display needs (#603);
- a server: the backend's "GPU memory a new box needs", 1024 MiB by
  default, about what one CUDA context and a small model take. Unit 0
  measures what a CUDA context takes on the owner's cards.

The check uses the host's report where there is one under 10 minutes old,
or each card's last reading from inside a box on it, as today. A card that
was lately read with less is skipped, and the box is refused at once when
every card was.

**Refusals** name what stands in the way and what to do, and name the boxes
on each card. A box of another thread is named by its box name only, never
its thread's title, to an agent; the person's pages name both, as the Boxes
page does.

> No card on pve-1 can take a shared GPU now. Card 0 is quiet-elm's whole
> card. Card 1 has 4 boxes, the most a card may have: amber-fox,
> swift-owl (stopped), lone-pine and calm-reef. Release one of them, ask for
> no GPU, or raise the boxes per card in bb-box's settings.

**A box that starts without its card** is retried on another, as 020 does for
desktops, now for servers too. After a start, bb-box checks that
`nvidia-smi -L` in the box lists the card's UUID. If it does not, the box is
released and made again on another card within the kind's time, and new
boxes avoid that card for 10 minutes. A server has no display mode, so this
check is its only one.

### 4. How a Proxmox LXC box gets its card

Two things make a card work in a container: the card's device nodes, and
NVIDIA's userspace for the host's driver inside the container.

#### The userspace: in the Linux image, on a host with a driver

`build.sh linux` installs NVIDIA's userspace when the host has an NVIDIA
driver loaded, as `build.sh desktop` does today: exactly the host's
version, from NVIDIA's installer checked against NVIDIA's SHA-256, with no
kernel modules. `--cpu` leaves it out. A host with no driver gets a Linux
template without it, and its backend offers no cards.

So every Linux box on a GPU host can be given a card later by Resize,
without being made again. The userspace is on the template's disk once:
linked clones share its blocks. A box with no GPU never loads it.

The userspace gives `nvidia-smi`, the CUDA driver library (`libcuda`),
NVML, NVENC and NVDEC, OpenGL, EGL and Vulkan. It does not give the CUDA
toolkit (`nvcc`, cuBLAS, cuDNN): the guide says how to get those, and most
frameworks bring their own (PyTorch's wheels do).

The doctor's check that a template's userspace is the host's driver (049)
covers Linux templates on a GPU host as well as desktop templates.

#### The devices: one template per flavour, and a helper on the host

The device lines of a box are set by a small root service on the Proxmox
host, `bb-box-gpu`, which `host/setup-gpu.sh` installs. It replaces
`bb-box-gpu-memory` and does both jobs: the report of each card, and each
box's device lines.

Why a helper: the owner wants a box's card added, removed and moved after
it is made. That changes device lines on an existing guest, which
bb-box's token cannot do and a template cannot carry. A template per card
cannot move a box. See [Alternatives](#alternatives-considered).

How bb-box asks, and how the helper answers:

1. bb-box sets the guest's wanted card as a tag, while the guest is
   stopped: `gpu.<first 8 hex digits of the card's UUID>`, and `gpu-whole`
   for a whole card. No tag means no GPU. Tags are how bb-box keeps a box's
   ownership in Proxmox, so the sweep can rebuild a lost record (018), and
   the placement comes back with it.
2. The helper runs every second. It reads each guest's config from
   `/etc/pve/nodes/<node>/lxc/`, and acts only on a guest that is in
   bb-box's pool, is unprivileged, is not a template, is stopped, and whose
   description names a bb-box install.
3. For such a guest whose tag names a card the helper lists, it makes the
   guest's NVIDIA device lines those of that card: `/dev/nvidiaN`,
   `nvidiactl`, `nvidia-uvm` and `nvidia-uvm-tools` for a server, and also
   `nvidia-modeset` and the card's DRM nodes for a desktop. For a guest with
   no `gpu.` tag, it removes NVIDIA and DRM device lines. It never touches
   any other line: the TUN device (050) stays where it is.
4. bb-box waits for the guest's config to show the card's device lines,
   then starts it. It waits at most 10 s, then refuses: "The host's GPU
   helper did not give the box its card within 10 s. Run `bb box doctor`."
5. The helper writes what it lists into the report, as today's report does:
   each card's UUID, PCI address, index, model, free and total memory. It
   writes when a card's free memory moves to another 64 MiB step, or after
   4 minutes, as today, so a quiet card costs no writes. Its device work
   reads files only, and writes a guest's config only when it changes one.

The helper changes only stopped guests, so a running box never loses its
card under it. Unit 0 measures how long a request takes, with a target of
under 2 s, and that a change in device lines takes effect at the next start
and not before.

Today's desktop templates, one per card, go on working. bb-box reads a
template's device lines as its card, and places its clones on that card. A
box cloned from such a template keeps its lines until the helper changes
them: the helper treats a box whose lines name a card as on that card. Unit
3 makes one GPU desktop template the way, and `build.sh` stops adding
device lines to templates. `copy-desktop` stays for a host without the
helper.

A host without the helper offers what its templates carry, as today:
shared GPU desktops on the cards their templates name. It offers no GPU on
servers, no whole cards and no change of card, and the doctor says why.

#### What a whole card fences on Proxmox LXC

An unprivileged container can open only the device nodes its config lists.
On Proxmox LXC a whole card is therefore a fence against other boxes, not
only a placement rule: no other box has the card's nodes. It is not a
fence against the host, or guests that are not bb-box's: their processes
can still use the card. The box page says when the card has memory in use
that is not this box's, from the Monitor's per-card processes.

### 5. How a Docker box gets its card

A box with a GPU gets its card as a CDI device when its container is made:
`--device nvidia.com/gpu=<UUID>`, as desktops do today. The NVIDIA
Container Toolkit puts the host's own userspace in, so it always matches
the driver: the Docker images need none.

- Servers get cards as desktops do. `gpu-desktops` becomes `gpus`, "GPU
  boxes", and its words say so.
- A container's devices cannot change after it is made. So on Docker a GPU
  cannot be added, removed or moved: Resize says "Cannot change on Docker"
  and why, and suggests a new box. Shared to whole and back are placement
  rules only, so they work as on Proxmox.
- A box with Docker in it is privileged (041) and sees every card on the
  host. bb-box sets `CUDA_VISIBLE_DEVICES` and `NVIDIA_VISIBLE_DEVICES` to
  the placed card's UUID for the box user's sessions, so CUDA programs use
  that card. A program can still open another card. On Docker, whole card
  is a placement promise among bb-box's boxes, not a fence, and the
  Resize words and the guide say so.

### 6. Resize changes the GPU

The GPU is a fourth part of Resize (061). For each backend and kind,
`resizing(kind)` gains:

```ts
interface Resizing {
  readonly cores: ResizeWay;
  readonly memory: ResizeWay;
  readonly disk: ResizeWay;
  readonly shrinks: boolean;
  readonly gpu: { readonly add: ResizeWay; readonly share: ResizeWay; readonly move: ResizeWay } | null;
}
```

`add` covers adding and removing a GPU; `share` switching between shared
and whole; `move` changing card. Null: the backend has no cards.

| Backend | `add` | `share` | `move` |
| --- | --- | --- | --- |
| Proxmox LXC with the helper | `restart` | `live` | `restart` |
| Proxmox LXC without the helper | `no` | `no` | `no` |
| Docker | `no` | `live` | `no` |

`planResize` reads the cards live and says, for the GPU part, what would
change and how:

```ts
interface GpuChange {
  readonly from: GpuPart;
  readonly to: GpuPart;
  readonly fromCard: CardPlacement | null;
  readonly toCard: CardPlacement | null;
  readonly way: ResizeWay;
  readonly others: readonly { readonly box: string; readonly name: string; readonly stopped: boolean }[];
}
```

`others` are the boxes on the card the box would be on. What each change
does:

| From | To | When | Way | What happens |
| --- | --- | --- | --- | --- |
| none | shared | a card has room | restart | The box stops, gets the card with room, and starts again |
| none | whole | a card is free | restart | The same, on a free card |
| shared | whole | no other box is on its card | live | Only bb-box's record and the guest's tag change. Nothing in the box stops |
| shared | whole | others are on its card, and another card is free | restart | bb-box offers to move the box to the free card. Programs using the GPU stop |
| shared | whole | others are on its card, and no card is free | refused | bb-box names the boxes on each card |
| whole | shared | always | live | The card opens to other boxes. Nothing in the box stops |
| shared or whole | none | always | restart | The box stops, loses its card's devices, and starts again |

A restart for the GPU is a restart as 061 has it: asked first, with the
threads working on the box named before it goes ahead anyway. A change of
cores or memory in the same Resize happens with it, in one restart.

The words, in the Resize dialog's "What changes":

- GPU none to shared: "GPU: none → shared, card 1 · Restart". Under it:
  "amber-fox stops, gets card 1, NVIDIA RTX 4090 with 24 GiB, shared with 1
  other box, and starts again, in about 15 s."
- Shared to whole, alone: "GPU: shared → whole card 1 · Live". "Card 1
  becomes amber-fox's alone. No other box is placed on it while amber-fox
  has it. Nothing in amber-fox stops."
- Shared to whole, with others and a free card: "GPU: shared on card 1 →
  whole card 0 · Restart". "Card 1 has 2 other boxes: lone-pine and
  swift-owl (stopped). bb-box moves amber-fox to card 0, which has none.
  Programs using the GPU stop, and must be started again." The button is
  "Move and restart".
- Shared to whole, no free card: refused, with nothing tried. "No card is
  free for amber-fox alone. Card 1 has lone-pine and swift-owl (stopped).
  Card 0 is quiet-elm's whole card. Release one of them, or keep the GPU
  shared." Each box name is a link to its page.
- Whole to shared: "GPU: whole card 0 → shared · Live". "Card 0 opens to
  other boxes, up to 4. They share its memory and its time. Nothing in
  quiet-elm stops."
- Any GPU to none: "GPU: shared, card 1 → none · Restart". "amber-fox stops,
  its card's devices are taken out, and it starts again. Programs using the
  GPU stop." On a desktop: "Its desktop is then drawn by the CPU."

A desktop that loses its GPU on Proxmox LXC keeps its disk, which was
cloned from the GPU desktop template. Its display finds no NVIDIA device
and starts on the CPU path, as it does today when a card is missing (006).
Its video is then x264, as on a CPU desktop, where the image has it.

### 7. Snapshots and forks of GPU boxes (070)

- A snapshot holds the disk, as 070 has it. A GPU box's memory is never
  held: neither LXC nor CUDA can save what is in a card's memory. The
  snapshot records the box's size at the take, GPU part included, as
  information.
- A restore keeps the box's GPU as it is now. A Proxmox rollback brings back
  the config of the snapshot, with its device lines and tags, which may
  name another card or none. So after the rollback and before the start,
  bb-box sets the box's current tags again, and waits for the helper, as
  for any start with a card. The restore dialog says: "Its GPU stays as it
  is now: shared, card 1."
- A restore brings back the NVIDIA userspace on the snapshot's disk. When
  the snapshot's image record names another driver than the host's, the
  restore dialog says so: "This snapshot has NVIDIA's userspace for driver
  570.86, and the host now has 580.65: nvidia-smi will fail in the box
  until its userspace is updated." See [question 4](#questions-for-the-owner).
- A fork is a new box. It asks for the source's GPU part unless told
  otherwise, and is placed as a new box is: a fork of a whole box needs a
  free card, and is refused before anything is copied when there is none,
  with what to do: "Fork it with the GPU shared, or none." `box_fork` takes
  `gpu`. A Proxmox fork copies the source's config, device lines included,
  so bb-box sets its tags and waits for the helper before its first start.
- A held copy (070) has no GPU: it is never started.

### 8. The doctor

| Check | Backend | Passes when | Fails or warns |
| --- | --- | --- | --- |
| `proxmox.gpu-helper` | Proxmox LXC | the report was written by the helper under 10 minutes ago, and lists the cards the host has | warn with no helper: "GPU on servers, whole cards and changes of card need host/setup-gpu.sh"; fail when its report is old: "Run `systemctl status bb-box-gpu` on the host" |
| `proxmox.gpu-report` | Proxmox LXC | as today, now written by the helper | as today |
| `proxmox.gpu-userspace` | Proxmox LXC | each template with NVIDIA's userspace has the host's driver | fail per template, as 049 does for desktop templates; warn per running box with a GPU whose own userspace is not the host's driver, naming the boxes |
| `gpu.<card>` | Proxmox LXC | as today, per card: free memory against what a new box needs | as today, with the boxes on the card named |
| `gpu.<card>.whole` | Proxmox LXC, Docker | a card a box has whole has no other box on it | fail, naming the boxes: this should not happen, so it means a placement went wrong |
| `docker.gpus` | Docker | as today, for GPU boxes | as today |

Device nodes made at boot (`bb-box-nvidia-devices.service`) stay as today.

### 9. The agent's tools

The tools take and say the same choice as the form.

- `box_acquire` takes `gpu`: `none`, `shared` or `whole`. Left out, it is
  the kind's default (section 1). With a kind that cannot have one, `gpu`
  other than `none` is refused with the kinds that can.
- `box_resize` takes `gpu`, with `check` and `restart` as for the other
  parts. A move to a free card is a restart, so it needs `restart` true.
- `box_fork` takes `gpu`, for the fork.
- `box_list` says, per kind, which providers have cards, how many, and the
  room on each: "linux: GPU none, shared or whole on Proxmox LXC (pve-1: 2
  cards; card 0 whole, quiet-elm's; card 1 shared, 2 of 4 boxes, 17.8 GiB
  free) and Docker (gpu-host: 1 card, shared, 1 of 4 boxes)."
- `box_status` and `box_acquire`'s answer say the box's card: "GPU: card 1,
  shared, NVIDIA RTX 4090, 24 GiB, with 1 other box (lone-pine). Run
  nvidia-smi to see it."

An answer to a refused `box_resize` for whole, with others on the card and
no free card:

> Not resized: no card is free for amber-fox alone. Card 1 has lone-pine
> and swift-owl (stopped); card 0 is quiet-elm's whole card. Keep the GPU
> shared, or ask the user to release a box. bb-box changed nothing.

An agent never releases or resizes another thread's box to free a card.

### 10. Settings (067)

Each backend with cards has a GPUs section on its page. The section sets
limits and defaults only. A box's own GPU is chosen in the form, by Resize
and by the tools, never here.

**Proxmox LXC**, GPUs section:

| Field | Key | Default | Words |
| --- | --- | --- | --- |
| Boxes per card | `proxmox-lxc-boxes-per-card` | 4 | The most boxes that share one card, desktops and servers together. 0 means no limit. |
| Whole cards | `proxmox-lxc-whole-cards` | on | Lets a box have a card to itself. Off, every box with a GPU shares. |
| GPU memory a new box needs | `proxmox-lxc-gpu-memory-mib` | 1024 | The memory, in MiB, a card must have free for a new server box to be placed on it. A desktop needs at least 384 MiB. |

Under the fields, a list of the cards the helper reports, each with its
index, model, memory, and the boxes on it, read-only, with "Set up the
helper" linking to the setup guide when there is no helper.

`desktop-templates` loses its GPU IDs: one line per template, a VMID, as
the other flavours have. A line with a GPU ID still reads, and the field
says the ID is no longer needed once the helper is there. The old key
`proxmox-lxc-desktops-per-gpu` reads as boxes per card when the new key is
not set, so a value the owner set stays.

**Docker**, GPUs section: GPU boxes (`gpus`, was `gpu-desktops`, off), Boxes
per card (`boxes-per-card`, was `desktops-per-gpu`, 4), Whole cards
(`whole-cards`, on), GPU memory a new box needs (`gpu-memory-mib`, 1024). The
old keys read when the new ones are not set.

The default for boxes per card on Proxmox LXC changes from no limit to 4,
as on Docker. A host whose settings set `desktops-per-gpu` keeps its value.
This is [question 3](#questions-for-the-owner).

### 11. The pages

#### The New box form

The GPU menu is in Resources, under the presets, as today, for a Linux
server or X11 desktop on x86_64, when any provider shown has cards. It has
three items: None, Shared and Whole card. Whole card is listed only when a
provider shown allows whole cards: no dead controls.

Under the menu, one line says what the choice means and where the box would
go, on the provider chosen or the first with room:

- None: "No GPU. You can add one later with Resize, on Proxmox LXC."
- Shared: "Card 1 on pve-1, NVIDIA RTX 4090, 24 GiB: 2 other boxes, 17.8
  GiB free now. Boxes on a card share its memory and time."
- Whole card: "Card 0 on pve-1 to itself: no other box is placed on it
  while this box has it."

The line keeps its height whatever it says, so nothing below it moves when
the cards are read. When no card has room, the line says why and what to
do, and the provider rows say which providers cannot take it, as rows do
for memory today. The menu remembers the last choice per kind, as the size
does.

#### A box's page (069)

- **Size**, in the facts, gains the GPU: "4 cores · 16 GiB · 64 GiB disk ·
  whole card".
- **A GPU fact** for a box with a card: "Card 0, whole" with "NVIDIA RTX
  4090 · 24 GiB" under it; "Card 1, shared" with "with lone-pine and
  swift-owl" under it.
- **A GPU card**, under Activity, for a box with a GPU: which card, shared
  or whole, the boxes on it with links to their pages, and the card's
  memory and use as the Monitor reads them, with this box's own processes
  and memory marked. Its one action is "Change…", which opens Resize at
  the GPU. A box with no GPU on a backend with cards shows no card; its
  Resize lists the GPU.
- The box's menu has Resize, as today. Resize has a GPU section below Size,
  with the same three choices, and "What changes" as in section 6.

#### The Boxes page (069)

The GPU badge says "GPU" for a shared card and "Whole GPU" for a whole one.
The busy flag can be the GPU, from the Monitor's change.

#### Look and motion

One weight, 400. Chevrons last in a row. Nothing moves when the cards are
read: every line that waits for a reading keeps its height. The GPU menu
opens as the form's other menus do. No new motion.

### 12. Security

- The helper runs as root on the host. It acts only on stopped,
  unprivileged guests in bb-box's pool whose description names a bb-box
  install, and writes only NVIDIA and DRM device lines for cards the host
  has. Everything it can be asked comes from a tag on a guest that bb-box's
  token can already change; the worst a wrong tag can do is give a box of
  bb-box's another card's nodes. A test feeds it guests outside the pool,
  privileged guests, templates and running guests, and checks it leaves
  them alone.
- A whole card fences other boxes on Proxmox LXC, not on Docker (sections 4
  and 5). The guide says so.
- A shared card has no memory fence. One box can take all of a card's
  memory, and the others' programs then fail to allocate. The words of
  Shared and the guide say so.

### 13. The guide page

"GPU boxes for compute and training", drafted in
[071-gpu-boxes/guide.md](071-gpu-boxes/guide.md), goes to
`docs/guide/gpu-boxes.md` in unit 8: what you get, `nvidia-smi` and CUDA,
sharing and whole cards, changing a box's GPU, and the limits.

### 14. How it is built

Each unit is one change, delivered on origin/main, with its gate. Live
checks use test boxes on VMIDs the lead lends, never the owner's boxes,
and one box per card at a time, released at once.

| Unit | What | Gate |
| --- | --- | --- |
| 0 | Measure on the Proxmox node, through the lead, and record in `071-results.md` | The numbers below, each with its method |
| 1 | The size's `gpu` part: types, records, views, the `linux-desktop-cpu` name, the kind defaults, the fake backend | tsc, the full node suite and vitest; old records read as section 1 says |
| 2 | Proxmox LXC: `bb-box-gpu`, `setup-gpu.sh`, NVIDIA's userspace in the Linux template, the doctor's checks | The helper's tests (guests it must leave alone); on a test node: a stopped guest of the pool gets a card's lines within 2 s, and loses them; the doctor passes and fails as section 8 says |
| 3 | Proxmox LXC: placement and acquire with `gpu`, servers and desktops; today's per-card templates still work; one GPU desktop template | Live: a shared server and a whole server, each with `nvidia-smi` and a PyTorch matrix multiply on the card; a whole box refused with the words of section 3 when its card has a box; a box that starts without its card retried on the other; time to ready within 5 s of today's desktop's |
| 4 | Resize with `gpu` on Proxmox LXC: share live; add, remove and move with a restart | Live, each row of section 6's table, with a process before and after a live change still running; the refusal with names |
| 5 | Docker: GPU on servers, whole cards, `CUDA_VISIBLE_DEVICES`, share live | On a Docker host with a card, if the lead has one; otherwise the fake, and the guide says it is not yet tried on a card |
| 6 | The form, the box page, Resize, the tools (`box_acquire`, `box_resize`, `box_fork`, `box_list`, `box_status`) and the settings sections, with the old keys | Live in a separate BB: the form at 390 px and 1440 px, light and dark; nothing moves when cards are read; each Resize row driven and its effect seen in `nvidia-smi`; an agent's `box_acquire gpu whole` and `box_resize gpu shared` |
| 7 | Snapshots and forks of GPU boxes (070's rules in section 7) | Live: a restore keeps the box's card; a fork of a whole box refused with no free card, and placed with one |
| 8 | The guide page, the reference, the setup guides and the skill | docs and site tests; the guide's commands run on a test box as written |

Unit 0 measures:

- whether this Proxmox version lets a token with any privilege set an LXC
  device line, with a test guest of the lent range (it is expected to
  refuse: if it allows one through a resource mapping, unit 2 uses that and
  needs no helper);
- that a change of device lines on a stopped guest takes effect at its next
  start, and that a running guest cannot gain one;
- the helper's time from a tag to the device lines, over 20 tries;
- the size of NVIDIA's userspace in the Linux template, and its effect on a
  clone's time;
- the GPU memory one CUDA context takes on each card, with PyTorch;
- that a container without a card's nodes cannot open them, with the card
  in use by another test container.

Later, each its own note or unit: a card passed through to a Proxmox QEMU
box; Linux machines with cards in the SSH host pool; two whole cards in a
box; the GPU in Docker containers inside a box (the NVIDIA Container
Toolkit in the box).

## Gated in unit N

What each unit may not claim until its gate is met:

- Unit 2: the helper is not called safe until its tests show it leaves alone
  every guest it must, and it has run for a day on a test node without
  touching a guest outside the pool.
- Unit 3: no GPU server is offered in the form or tools until a live
  PyTorch run on a test box passes on each card.
- Unit 4: Resize does not offer a GPU change until each row of section 6's
  table has been driven live on a test box.
- Unit 5: Docker's GPU boxes stay off by default until they run on a card.
- Unit 6: the owner's production BB gets the form only after the live check
  on a separate BB.

## Questions for the owner

Each has a default this note builds in. A different answer changes the
units named.

1. **A desktop's GPU when an agent does not say.** Default: a
   `linux-desktop` box asked for with no `gpu` gets a shared card where a
   provider has one, as `linux-desktop` does today; a `linux` box gets none.
   The other way is none for every kind unless asked, which changes what
   today's `linux-desktop` means. Units 1 and 6.
2. **Two whole cards in one box**, for training across both cards. Default:
   not now; the size's GPU part can grow a count later. Unit 1.
3. **Boxes per card on Proxmox LXC**: today no limit by default. Default: 4,
   as on Docker, with a value already set kept. Unit 6.
4. **A box's NVIDIA userspace after the host's driver changes.** A box with
   a GPU keeps the userspace it was made with on its own disk, so after a
   driver upgrade on the host, `nvidia-smi` fails in it until it is
   updated. Default: the doctor names such boxes, and the box's page offers
   "Update NVIDIA's userspace…", which the person runs: bb-box downloads
   NVIDIA's installer for the host's driver, checks its SHA-256, copies it
   in and runs it with no kernel modules. Never automatic, as the box may be
   training. Unit 4.

## Alternatives considered

**A template per card, as today's desktops.** No root on the host's side,
and proven. But a box cannot gain, lose or change a card after it is made,
which the owner wants, and templates multiply: cards times flavours, each
rebuilt when the driver changes. Kept for hosts without the helper.

**A Proxmox hookscript on the template.** Clones copy a template's
hookscript, which runs as root at `pre-start`. It could set device lines
just before a start, with no polling. But whether lines set in `pre-start`
apply to that same start is not known, a hookscript is also root-only to
set, and it runs on every start of every clone. Unit 0 may test it; the
helper does not depend on it.

**The host's userspace mounted into the box at start**, through LXC's
NVIDIA hook and `libnvidia-container`, as Docker's toolkit does. It would
end driver mismatches. But it needs raw `lxc.*` lines, root-only, and has
not been proven in bb-box's unprivileged containers. A later note may take
it, and would answer question 4 another way.

**A GPU variant of the Linux image**, with the userspace only there. Smaller
plain templates, but a box made without a GPU could not be given one by
Resize: it would need making again. The userspace costs disk once per
template.

**A card passed through to a Proxmox QEMU box (057).** A real fence and a
kernel of the box's own, and the token can set a passed-through device
through a resource mapping with `Mapping.Use`. But the card leaves the
host's driver for `vfio-pci`, so it cannot be shared with LXC boxes while
passed through; it needs IOMMU on the host; and a VM with a passed-through
card cannot be snapshotted with its memory or moved. Later, for whole cards
only.

**Kinds for each GPU choice**, such as `linux-gpu`. Fewer changes to the
size, but the owner said a GPU is a configuration choice, and kinds cannot
change after a box is made, so a GPU could not be added later.

**Sharing set per backend, not per box.** Simpler, and today's model. The
owner chose per box.

## The prototype

[071-gpu-boxes/prototype.html](071-gpu-boxes/prototype.html), built with
`npm run build` in [071-gpu-boxes/prototype](071-gpu-boxes/prototype/)
after `npm ci` at the repository's root and there. It uses bb-box's own
form parts (`FormSection`, `OptionCard`, `MenuSelect`, `ProviderRow`), with
a fake server: one Proxmox LXC node, pve-1, with two cards, and one Docker
host with one card.

The panel at the bottom left goes to each page and sets the scene:

- **Boxes, by card**: each card and the boxes on it, and the boxes with no
  GPU.
- **New box**: choose Server or Desktop, then the GPU: the line under the
  menu says which card the box would get, or why none can take it. Create
  it, and it appears on its card. One new shared box fills card 1 to its
  4. The next goes to docker-1, and pve-1's row says no card can take it.
  Choose Whole card for a server: no provider has a free card, and the
  line names the boxes on each.
- **amber-fox**, a shared desktop on card 1 with two other boxes: Resize,
  then Whole card. It is refused, with the boxes on each card named and
  linked, as card 0 is quiet-elm's whole card. Select "Release quiet-elm",
  and Resize then offers to move amber-fox to card 0, with a restart.
- **quiet-elm**, a server with card 0 whole: Shared is live.
- **calm-reef**, a server with no GPU: Shared is a restart onto card 1.
- **dock-wren**, a Docker server alone on its card: Whole card is live, and
  None says it cannot change on Docker.
- **Settings: GPUs**: each backend's GPUs section, with its cards. Change
  the boxes per card or turn off whole cards, and the form and Resize
  follow.
- **An agent asks**: the tools' answers to `box_list`, `box_acquire` with a
  GPU, `box_resize` with `check`, and `box_status`, from the same cards.

Waits are short and nothing is saved.

## Consequences

- Any Linux box on a GPU host can have a card, and change it later.
- One GPU desktop template and one Linux template per host, not one per
  card, once the helper is there.
- A root helper on each Proxmox host with cards, replacing the report's
  timer, with the doctor watching it.
- `linux-desktop-cpu` becomes a name for a desktop with no GPU; kinds no
  longer carry `gpu`; 012's rule that `gpu` must agree exactly now applies
  to the size.
- Whole card fences other boxes on Proxmox LXC only. On Docker it is a
  promise among bb-box's boxes.
- Every Linux template on a GPU host is rebuilt when the host's driver
  changes, as desktop templates are today.
- Proxmox LXC's default boxes per card goes from no limit to 4.
