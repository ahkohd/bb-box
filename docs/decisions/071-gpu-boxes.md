# 071: A GPU is part of a box's size, on any Linux box: none, shared or a whole card, chosen when it is made and changed by Resize

Status: accepted, 31 October 2026, after two independent reviews (see
[What changed after the reviews](#what-changed-after-the-reviews)) and the
owner's answers to its six questions, each its default (see [Questions for
the owner](#questions-for-the-owner)). Not built yet: see [How it is
built](#16-how-it-is-built) and its [gates](#gated-in-unit-n). It has the
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
Extends [020](020-control-belongs-to-a-viewer.md): a fresh box with a GPU
that starts without it is made again on another card, servers as well as
desktops; an existing box is never made again. Extends
[067](067-settings-page.md): each backend with cards has a GPUs section,
and the `linux` and `linux-desktop` kinds a default GPU. Extends
[069](069-boxes-page.md): a box's page has a GPU fact and card. Extends
[070](070-snapshots.md): a snapshot, a fork, a restore, a held copy and a
swap never carry a card claim, and a restore labels the box again before
it starts it.

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
  `nvidia-modeset` and the card's DRM render and card nodes. `gpu_lines`
  in [build.sh](../../setup/proxmox-lxc/template/build.sh) finds them from
  the card's PCI address, so the minor and the DRM numbers are the kernel's,
  which need not follow nvidia-smi's index. A second card needs a second
  template, made with `build.sh copy-desktop`.
- Device lines can be set by `root@pam` only. pve-container's
  `check_ct_modify_config_perm` refuses a change to `devN` for every other
  user and for every API token, as an API token's user is `root@pam!name`,
  not `root@pam`; there is no resource mapping for LXC devices. Both
  reviews read this in pve-container's source. bb-box's token never sets
  them: its clones copy them from the template.
- The template has NVIDIA's userspace for exactly the host's driver,
  installed with no kernel modules, and records it in
  `/usr/share/bb-box/nvidia-version`
  ([customize-desktop.sh](../../setup/proxmox-lxc/template/guest/customize-desktop.sh)).
  The doctor fails a template whose userspace is not the host's driver, as
  the last box saw it (049).
- A new desktop goes to the card with the fewest desktops, then to that
  card's least used template (`#choose` in
  [backend.ts](../../src/backends/proxmox-lxc/backend.ts)). It counts
  acquires in flight per flavour, not per card. The setting
  `desktops-per-gpu` caps desktops per card; 0, the default, means no
  limit.
- A desktop needs 384 MiB of GPU memory free as it starts. bb-box reads
  each card's free memory from the host's report
  ([bb-box-gpu-memory](../../setup/proxmox-lxc/host/bb-box-gpu-memory)),
  which a root timer writes every 15 s into the notes of a VM that is never
  started, or from inside a running desktop where there is no report
  (#603). bb-box reads only the report's `at` and `gpu` lines, and skips
  any other.
- A desktop whose display came up on the CPU is released and retried on
  another card, and new desktops avoid that card for 10 minutes (020).
- `linux` boxes have no GPU. `linux-desktop-cpu` is the same desktop, drawn
  by the CPU, from templates with no NVIDIA userspace and `DISPLAY_MODE=cpu`.
- Proxmox VE 9 (pve-container 6.0.4, July 2025) adds a device line to a
  running container at once: `pct set --devN` on a running guest makes the
  node in it and allows it. Taking one away still waits for the next start.

**Docker.** `gpu-desktops` turns on `linux-desktop` boxes, each with one card
that the NVIDIA Container Toolkit lists as a CDI device. The setting
`desktops-per-gpu` caps them at 4 a card by default. A stopped desktop
keeps its card. With Docker in boxes on, the default where the daemon is
not rootless, every Linux box is a privileged container (041), with a GPU
or without (`#privileged` in
[backend.ts](../../src/backends/docker/backend.ts)), and a privileged
container can open every card on the host. A GPU desktop's start script
points Xorg at the one placed (#283). GPU desktops on Docker have not been
tested on a host with a card
([setup/docker/README.md](../../setup/docker/README.md#gpu-desktops)).

**The New box form** shows a GPU menu, None or 1 GPU, only for a desktop
whose system has both a GPU desktop and a CPU one
([new-box.tsx](../../src/app/new-box.tsx)). A server has no GPU menu.

**Resize** (061) changes cores, memory and disk, each `live`, `restart` or
`no` per backend ([resize.tsx](../../src/app/resize.tsx), `Resizing` and
`ResizePlan` in [types.ts](../../src/backends/types.ts)).

**Snapshots** (070). A Proxmox clone copies a guest's tags and device lines
with its disk. A rollback brings back the snapshot's config, tags and
device lines included. Held copies are labelled again by `heldCopyTags`,
which keeps none of a box's own tags.

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
5. Nothing makes a placement one decision: two acquires can pick the same
   card, and a copy or a rollback brings back device lines from before.

## Decision

### 1. A GPU is part of a box's size

A box's size (028) gains a fourth part:

| Part | Values | Example |
| --- | --- | --- |
| `gpu` | `none`, `shared` or `whole` | `shared` |

- `none`: bb-box gives the box no card. On Proxmox LXC the box has no
  NVIDIA device nodes. On Docker a privileged box can still open every
  card (section 7).
- `shared`: one card, which other boxes may share, up to the backend's
  boxes per card.
- `whole`: one card on which bb-box places no other box while this box
  holds it. On Proxmox LXC no other guest on the node is given the card's
  devices meanwhile (section 4). On Docker it is a promise among bb-box's
  boxes (section 7).

A box with a GPU also has a claim: which card it holds, how, and at which
generation. The claim is the backend's, as a box's host is; the size says
only what was asked.

```ts
type GpuPart = "none" | "shared" | "whole";

interface BoxSize {
  readonly cores: number;
  readonly memoryMiB: number;
  readonly diskGiB: number | null;
  readonly gpu: GpuPart;
}

interface CardClaim {
  readonly card: string | null;
  readonly part: GpuPart;
  readonly generation: number;
  readonly answer: "asked" | "granted" | "refused" | "yielded";
}

interface CardPlacement {
  readonly card: string;
  readonly index: number;
  readonly model: string;
  readonly memoryMiB: number;
}
```

`card` is the card's full UUID, as `nvidia-smi -L` gives it. A claim never
names a card by a device number or an index. `index` is nvidia-smi's
index, which follows PCI order and is how the pages name a card: "card 0",
"card 1". `generation` goes up by one with each change bb-box asks of the
host (section 4).

A box record also gains `nvidiaUserspace`: the version of NVIDIA's
userspace on the box's disk, `none`, or `unknown` until it is read
(section 6).

A box record made before this note has no `gpu`. It reads as `shared` for a
`linux-desktop` box on a backend with cards, and `none` for every other
box, which is what those boxes have. Its `nvidiaUserspace` reads as
`unknown` until bb-box reads it from the box.

One card at most, for now. Two whole cards in one box, for training across
both, is [question 3](#questions-for-the-owner).

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
  `linux-desktop-cpu` with `gpu` shared or whole is refused, as the two
  disagree (section 11).
- When a request leaves `gpu` out, the kind's "GPU when not asked for"
  setting says what it gets: `shared` for `linux-desktop`, as it promises a
  GPU today, and `none` for `linux` (section 12). This is [question
  2](#questions-for-the-owner).
- Arm64 Linux, macOS, Windows and device boxes have no GPU part. Their
  forms and tools do not offer one: no dead controls.

On a Proxmox LXC host with a driver, a desktop with `gpu` none is cloned
from the GPU desktop template too. Its display finds no NVIDIA device and
takes the CPU path, with x264 video (006, 060), as a CPU desktop does, and
a GPU can be added later without making it again. The CPU desktop template
is used only on a host with no driver, and for Wayland.

### 2. Which backends offer it

| Backend | None | Shared | Whole card | Add or remove a GPU later | Move to another card |
| --- | --- | --- | --- | --- | --- |
| Proxmox LXC with the helper (section 5) | yes | yes | yes | yes, with a restart | yes, with a restart |
| Proxmox LXC without the helper | yes | desktops only, on their template's card, as today | no | no | no |
| Docker | yes, see section 7 | desktops as today; servers once proven on a card | once proven on a card | no: a container's devices are fixed when it is made | no, for the same reason |
| Proxmox QEMU (057) | yes | no | later: a card passed through whole, see [Alternatives](#alternatives-considered) | later | later |
| SSH host pool, Linux machines with a card | later: a machine's card is its own, so whole only | | | | |
| microsandbox, Hetzner Cloud, Namespace, boat.dev, Tart | none | | | | |

Proxmox LXC is the backend the owner trains on, so it is built first and in
full. Docker follows with what Docker can do, and only after a real card
passes its gate. The rest are later, or have no cards.

### 3. Who holds a card, and where a box goes

A backend lists its cards and, for each, the boxes that hold it.

#### Who holds a card

| Guest | Holds its card | Why |
| --- | --- | --- |
| A running box, shared or whole | yes | |
| A stopped box with a whole card | yes, by default: [question 1](#questions-for-the-owner) | so a job paused overnight gets its card back |
| A stopped box with a shared GPU, on Proxmox LXC | no; it keeps a preference for its last card | so a forgotten stopped box neither blocks a whole card nor fills a card |
| A stopped box on Docker | yes | a container's devices are fixed when it is made |
| A box bb-box is making, moving, forking, restoring or starting | yes, from the moment its card is reserved (section 4) | |
| A warm guest or a spare (032) | yes, as a shared box, never a whole one | |
| A template, a held copy or an earlier guest (070) | never | they cannot start, or start only by hand, and then with no card (section 9) |
| A guest that is not this install's, or not bb-box's | as the helper reports it (section 5) | |

**The trade-off for stopped boxes, in plain words.** If a stopped box keeps
its card, a desktop someone forgot to release blocks that card from ever
being given whole, for as long as the box exists: with two cards, two
forgotten boxes block every whole card. If a stopped box does not keep its
card, it may not get it back when it starts: the card may have become
another box's whole card, or filled up, and when no card has room the
start is refused. A shared box can use any card, so for it only that last
case costs anything. A whole box was asked for a card to itself, often for
a long job paused overnight, so it keeps its card by default. The owner
decides: [question 1](#questions-for-the-owner).

**When a stopped shared box starts**, bb-box places it again, under the
card lock (section 4): on its last card if that card has room, else on
another card with room. When no card has room, the start is refused with
the words below; the person is also offered "Start with no GPU", which is a
Resize to None and a start. While the box is stopped its device lines stay
on its last card, so a start on the same card needs no change. A whole
claim on that card takes them out first (section 4, "Yielding").

#### Shared

A shared box goes to a card that:

1. no box holds whole;
2. has fewer boxes holding it than the backend's boxes per card;
3. has at least the GPU memory a new box needs free when last read, less
   what this install has reserved on it for boxes being placed.

Of those, it goes to the card with the fewest boxes, then the most memory
free, then the lowest index.

#### Whole

A whole box goes to a card that:

1. no other guest on the node holds, running or stopped, other than
   stopped shared boxes the helper manages, which yield;
2. has no card reserved on it by this install;
3. has the memory a new box needs free when last read.

Of those, the card with the least memory in use outside bb-box's boxes,
then the most free, then the lowest index. Whole is refused where the
backend's settings turn whole cards off, and where bb-box cannot see the
whole node (section 4, "When bb-box cannot see the node"). Before the box
is made, the form and Resize say how much of the card is in use outside
bb-box's boxes, where any is (section 13).

A whole box never takes a warm guest or a spare. A card held only by this
install's warm guests and stopped shared boxes is free for a whole box:
bb-box retires those warm guests first, as they are not boxes. Another
install's warm guests are its own, and block the card.

#### GPU memory: a reading, not a guarantee

A new box with a GPU needs memory free on its card as it starts:

- a desktop: 384 MiB, what its display needs (#603);
- a server: the backend's "GPU memory a new box needs", 1024 MiB by
  default.

This is a best-effort check at placement against the last reading of the
card. It is not a reservation and not a model's memory budget: nothing
stops another box, the host or a program outside bb-box from taking that
memory after the box is placed, and a shared card has no memory fence.
1024 MiB is about what a CUDA context and a small model take; unit 0
measures a context, cold and warm, on the owner's cards.

Readings, and how old they may be:

| Reading | Used | Words |
| --- | --- | --- |
| The helper's report, from a helper that answered in the last 3 minutes | as it is: the helper writes within about a second whenever a card's free memory moves by 64 MiB, so it is current | "17.8 GiB free when read, 20 s ago" |
| A reading from inside a box on the card, where there is no live helper, under 10 minutes old | as today | the same, with its age |
| None, or older than 10 minutes | unknown: a shared placement goes ahead and says so; whole is refused anyway, as it needs a live helper | "free memory unknown" |

The words always give the reading's age and never say "now". Memory this
install has reserved for boxes it is placing is taken off the reading, so
two of its own starts cannot both use the same headroom. Another install's
starts are not known until the card's reading moves.

#### Refusals

A refusal names what stands in the way, the boxes on each card, and what
the caller can do. There is one set of words for each audience, and a test
checks that every refusal has both.

- **To the person**, the boxes are named with their threads and linked, as
  the Boxes page does, and the words may say to release a box or to change
  a setting:

  > No card on pve-1 can take a shared GPU now. Card 0 is quiet-elm's whole
  > card. Card 1 has 4 boxes running, the most a card may have: amber-fox,
  > lone-pine, calm-reef and tidy-glade. Release one of them, choose no GPU,
  > or raise the boxes per card in BB Box's settings.

- **To an agent**, other boxes are named by their box names only, never a
  thread's title. The words never tell it to release, stop or resize
  another thread's box, or to change settings. They offer only its own
  boxes, another GPU part, waiting, or asking the user, and say what
  bb-box changed:

  > Not made: no card on pve-1 can take a shared GPU now. Card 0 is
  > quiet-elm's whole card; card 1 has 4 boxes running, the most a card may
  > have. Ask for gpu none, or ask the user. bb-box changed nothing.

  When the agent's own thread has boxes on those cards, the words add them:
  "Release one of your own boxes on card 1 (lone-pine), ask for gpu none,
  or ask the user."

#### A box that starts without its card

After each start bb-box makes of a box with a GPU, it checks in the box
that `nvidia-smi -L` lists the claimed card's UUID, that CUDA's driver
initialises (`cuInit`, which takes no card memory), and, for a desktop,
that its display came up on the GPU, as 020 does. What follows depends on
whether the box has been handed out:

- **A fresh acquire, not yet handed out**: released and made again on
  another card within the kind's time, as 020 does for desktops, now for
  servers too. New boxes avoid that card for 10 minutes.
- **An existing box** (a start, a Resize, a restore, an update): never
  released or made again, as its disk is someone's work. bb-box stops it,
  places it once on another card if one has room, and starts it again. If
  that fails too, the box is left stopped, with its disk and its claim,
  and its page, the tool's answer and the doctor say what happened and
  what to do: "amber-fox did not get card 1: nvidia-smi in it listed no
  card. It is stopped, with its disk as it was. Start tries again; the
  doctor has more."
- **A box bb-box did not start** (by hand, or by Proxmox at the node's
  boot) that has no card or the wrong one: left running, and named on its
  page and in the doctor (section 5, "Card numbering").

### 4. One claim per card

Placement decides which card a box should hold. A claim makes it so. Each
layer has one authority:

| Layer | Authority | Holds |
| --- | --- | --- |
| Within one install | the backend's card lock and reservations, per node | which card a box being made, moved, forked, restored or started will hold |
| Across installs and every guest on the node | the helper's ledger, on the host (section 5) | which guest may have each card's devices, and which holds it whole |
| The devices themselves | each guest's config, written only by the helper | the device lines |

#### The card lock

Each Proxmox LXC backend holds one lock per node, the card lock, from
reading the cards and claims to reserving a card. Acquire, the start of a
stopped box, Resize, fork, restore, warm refill and release all take it.
It is held for milliseconds, never across a clone, a stop or a start.

#### Reservations

Before a clone, a stop or a copy begins, the card is reserved in memory for
the box, with its GPU part and the memory it needs, as `#acquiring`
reserves templates today. Placement counts a reservation as a holder, per
card. A reservation ends when the helper answers the request it led to, or
the operation fails. A restart of bb-box loses its reservations, and with
them the operations that made them; recovery (below) puts claims straight
before anything new is placed.

#### Requests and answers

bb-box asks the helper by writing one marker tag on the guest (section 5):
the GPU part, the card's full UUID, and the box's next generation. The
helper answers each generation once, in its report: granted; refused, with
its reason; or, later, yielded. bb-box acts on the answer to the generation
it asked, never on what the device lines look like alone. It waits at most
10 s for an answer, then refuses: "The host's GPU helper on pve-1 did not
answer within 10 s. Run `bb box doctor`."

#### The helper decides

The helper sees every guest on the node, of every install and of none, and
it alone writes device lines. Requests are checked one at a time, so two
can never both win a card. It refuses:

- whole on a card whose devices another guest has, other than stopped
  shared boxes it manages (those yield);
- shared on a card another guest holds whole;
- any device change for a guest that is running or locked;
- any claim for a box whose claim another guest already has: a copy
  (section 9).

**Yielding.** When the helper grants a whole claim on a card that stopped
shared boxes it manages have the devices of, it takes those devices out of
each of them, in each guest's own config lock, and writes `yielded` for
them. If one of them starts first, it is running, and the whole claim is
refused instead. A yielded box is placed again when it starts (section 3).

#### Each operation, in order

| Operation | Steps |
| --- | --- |
| Acquire | Lock; place; reserve; unlock. Clone: templates carry no device lines and no marker. Write the marker with the box's labels in one config write. Wait for the answer. Start. Check in the box |
| Start of a stopped box | Lock; check the claim still stands, or place again (section 3); reserve; unlock. If the card changed, write the marker and wait. Start. Check |
| Resize, shared to whole, live | Lock; check that no other box holds the card and none is reserved; reserve whole; unlock. Write the marker. Wait. The box goes on running throughout |
| Resize, adding a GPU or moving | Lock; place; reserve the new card; unlock. Stop. Write the marker. Wait. Start. Check. The old card is given up only when the new claim is granted |
| Resize to none | Stop. Write `gpu.none`. Wait. Start, or leave stopped as it was |
| Fork | Lock; place the fork's own GPU part, none unless asked; reserve; unlock. Copy. Write the fork's marker in the same config write as 070's re-arm. Wait. Start |
| Restore | Record the box's claim in the restore's operation. Lock; check the card can take the box; reserve it for the box; unlock: all before the stop. Roll back. Write the box's current marker with a new generation, a recorded step. Wait. Start on that claim and its card, or refuse to start: never another card |
| Swap (`adoptCopy`) | As a restore, up to the stop. Set the old guest's marker to none and wait. Make the new guest, not set to start at boot. Give it the box's claim with a new generation, wait, and check its lines name the card; only then set it to start at boot. Start on that claim |
| Release | Delete the guest. The helper drops its claim when the guest is gone |

#### Races, and what each does

| Race | What happens |
| --- | --- |
| Two acquires in one install want the only free card whole | The card lock orders them. The first reserves the card; the second sees the reservation and goes to another card, or is refused before anything is copied |
| A Resize to whole and an acquire of a shared box, in one install | The same lock. Whichever reserves first has the card; the other is placed elsewhere or refused, before anything changes |
| Two installs on one node ask for the same card | Each places from what it sees, the other's holders included, from the helper's report. The helper answers one request at a time, so one is refused. A refused acquire places again once, on another card, then is refused with words; a refused Resize changes nothing and says so |
| A whole claim while a stopped shared box on that card is being started | Both go through the guest's config lock. If the start comes first, the box runs and the whole claim is refused. If the yield comes first, the box starts with no devices of that card, and its install places it again |
| bb-box restarts with requests outstanding | Before placing anything, bb-box reads the report and every marker in its pool. A granted current generation stands. A refusal is applied: the operation fails, or tries another card once. An unanswered request is waited for up to a minute, then reported, and the box is not started |

#### When bb-box cannot see the node

Whole is refused, and no claim changes on the node, when the helper is not
there, its last report is over 3 minutes old, it speaks a protocol bb-box
does not, or it has not answered one of this install's earlier requests on
the card. Boxes whose claims stand go on starting and running. "Whole cards
on pve-1 need the host's GPU helper, which has not reported for 4 min. Run
`systemctl status bb-box-gpu` on pve-1."

### 5. The host's GPU helper, bb-box-gpu

A small root service on each Proxmox host with cards, installed by
`host/setup-gpu.sh`. It replaces today's report timer, `bb-box-gpu-memory`:
it writes the same report, and it sets each box's device lines. It is the
only part of bb-box that can give a guest a card, because Proxmox lets
only `root@pam` set device lines (see [What bb-box offers
today](#what-bb-box-offers-today)).

Why a helper: the owner wants a box's card added, removed and moved after
it is made. That changes device lines on an existing guest, which bb-box's
token cannot do and a template cannot carry. A template per card cannot
move a box. See [Alternatives](#alternatives-considered).

#### What it acts on

- It reads every guest's config on the node, to know who holds each card.
- It writes only a guest that is an LXC container on this node, in a pool
  its config lists, unprivileged, not a template, with a description
  naming a bb-box install, and that carries exactly one well-formed marker
  or that the helper has granted a claim to before. (A rollback can take a
  guest's marker away: section 9.)
- A guest with no marker is never written: today's GPU desktops before
  they are marked, guests of older bb-box versions, guests of other tools.
  It still counts as holding the cards whose devices its lines name.

#### The marker

One tag, so a request is always whole and never half-written:

| Marker | Asks for |
| --- | --- |
| `gpu.none.g7` | no card |
| `gpu.shared.3f9a2c1e-55b0-4c1d-9e2a-0b7d6c4a1f00.g7` | the card with this UUID, shared |
| `gpu.whole.3f9a2c1e-55b0-4c1d-9e2a-0b7d6c4a1f00.g8` | the same card, whole |

The pattern is fixed: `gpu.` then `none`, or `shared.` or `whole.` and a
UUID in lower case without its `GPU-` prefix, then `.g` and the
generation, a whole number from 1. A guest with a tag that starts `gpu.`
and does not match, or with two such tags, is refused as `malformed`, and
nothing about it changes. The UUID must be one the helper itself has
listed. It never takes a path, a mode or a device number from a guest's
config.

#### How it writes

Inside Proxmox's own config lock, `PVE::LXC::Config->lock_config`, which
`pct start` and every config change through the API take too, in
pve-container's source; unit 0 checks the installed version:

1. Load the config.
2. Refuse if the guest is running (for a device change), has a `lock`, or
   has pending changes to its devices.
3. Work out the card's nodes from its UUID, now: its PCI address and minor
   from `/proc/driver/nvidia/gpus/<pci>/information`, and its DRM card and
   render nodes from `/dev/dri/by-path`, as `gpu_lines` does.
4. Replace only the NVIDIA and DRM `devN` lines of the current section,
   those naming `/dev/nvidia*` or `/dev/dri/*`: `/dev/nvidiaN`,
   `nvidiactl`, `nvidia-uvm` and `nvidia-uvm-tools` for a server, and also
   `nvidia-modeset` and the card's DRM nodes for a desktop. Every other
   line stays as it is: the TUN device (050), the snapshot sections, all
   else.
5. Write the config. Then write the ledger, then the answer.

It never writes raw `lxc.*` lines.

The check that the guest is stopped is inside the lock because Proxmox VE
9 adds a device line to a running container at once: a check followed by a
separate `pct set` could hot-plug a card into a box that had just started,
perhaps a card another box holds whole. The first version of this note said
"a running guest cannot gain one"; that was wrong.

bb-box changes a box's devices only with the box stopped, all the same.
Removing a device and moving to another card cannot be done live, a
desktop chooses its display path when it starts, and one tested path is
safer than two. A live add may come in a later note.

A change of GPU part alone, shared to whole and back, on a running guest
needs no write: the helper checks it, records it in its ledger and
answers.

#### The report: its answers

The report stays in the notes of the never-started VM `bb-box-gpu-memory`,
and keeps today's `at` and `gpu` lines, so today's bb-box goes on reading
it. New lines, each with a fixed grammar per protocol:

```text
helper bb-box-gpu 1.0.0 protocol 1 writes on pve-container 6.0.4
driver 580.65.06 since 1793450000
card 3f9a2c1e-55b0-4c1d-9e2a-0b7d6c4a1f00 pci 0000:01:00.0 minor 0 drm card1 renderD128
holder 3f9a2c1e-55b0-4c1d-9e2a-0b7d6c4a1f00 214 whole install 4kq7
holder 8c41d7b2-1a9e-4f63-b0c5-7e2d9a3b6c11 305 shared other
claim 214 g8 granted whole 3f9a2c1e-55b0-4c1d-9e2a-0b7d6c4a1f00
claim 233 g3 refused whole-taken 3f9a2c1e-55b0-4c1d-9e2a-0b7d6c4a1f00 214
claim 240 g2 yielded 3f9a2c1e-55b0-4c1d-9e2a-0b7d6c4a1f00 214
mismatch 219 8c41d7b2-1a9e-4f63-b0c5-7e2d9a3b6c11
```

- `helper`: its version, the protocol, whether writes are on, and the
  pve-container version it found.
- `driver`: the host's loaded driver, from `/sys/module/nvidia/version`,
  and since when.
- `card`: each card's UUID, PCI address, minor and DRM nodes now.
- `holder`: each guest that has a card's devices, its VMID, shared or
  whole, and its install, or `other` for a guest that is not bb-box's.
- `claim`: each answer, by VMID and generation.
- `mismatch`: a running guest whose lines no longer name its claim's card.

The helper writes the report within about a second of an answer, when a
card's free memory moves to another 64 MiB step, and at least once a
minute. It lists the answers of the last 10 minutes and every refusal still
in force. Proxmox caps a description's length; unit 0 records the cap, and
the report keeps under it.

#### The ledger: the claim of record

`/var/lib/bb-box-gpu/ledger`, root's, on the host's own disk, outside
every guest's config and so outside every snapshot. For each box, by the
box ID in its description (for a warm guest or a spare, by its VMID): the
guest's VMID, the generation, the GPU part, the card and the answer.

A guest's marker and lines are a request and its effect. A rollback or a
copy can bring back old ones; the ledger says which claim is current
(section 9). The ledger has one guest per box.

A lost ledger is rebuilt from the guests when the helper starts. A marked
guest whose lines match its marker is taken as granted. Where two guests
conflict, a running one keeps its card and the stopped ones lose their
lines. bb-box's next request for each box puts it right.

#### Card numbering

A card's minor and DRM numbers are given at boot. They need not follow
nvidia-smi's index, a BMC's VGA device often takes `card0`, and they can
move after a reboot, a driver change, or a card added or removed. So:

- Claims name a card by its full UUID, never a number.
- The helper works out a card's nodes from its UUID at each write, never
  from a number it stored.
- `bb-box-gpu-boot.service`, a oneshot ordered `Before=pve-guests.service`
  and wanted by it, rewrites the lines of every marked guest from its
  claim before any guest starts at boot. A marked guest whose card it
  cannot find loses its NVIDIA lines, so it starts with no card rather than
  the wrong one. If the boot pass itself fails, Proxmox still starts its
  guests, so the owner's other guests are never held up; the checks below
  name any GPU box that started on the wrong card.
- On each scan the helper compares each running marked guest's lines with
  its claim's card now, and reports any `mismatch`.
- After each start bb-box makes, and on each sweep (every 10 minutes),
  bb-box runs `nvidia-smi -L` in every running box with a GPU and compares
  the UUID with the claim. A mismatch fails the doctor and shows on the
  box's page, naming the box, and new placements on both cards stop until
  it is put right. bb-box never stops the box by itself; the person
  chooses Restart, which places it again. This is [question
  6](#questions-for-the-owner).
- The doctor says when the mapping of UUIDs to minors and DRM nodes has
  changed since the last boot.

#### When something fails

| Event | What happens |
| --- | --- |
| The helper stops or dies | No new answers. Boxes whose claims stand start as they are. A new GPU box, a change and every whole placement on the node wait, then are refused with words. Running boxes are not touched |
| A guest is locked | Refused as `locked`. bb-box names the lock and the command for the host, "Run `pct unlock 214` on pve-1", as 070 does |
| The node restarts | The boot pass corrects every marked guest's lines before guests start |
| A write is cut short | Proxmox writes a config whole. The helper writes the ledger after the config, and at its start compares the two and puts the ledger right from the guest |
| A malformed marker, or two | Refused. Nothing about the guest changes |
| The helper is replaced mid-request | systemd stops the old one after its current write. The new one answers outstanding generations from the guests and the ledger |
| `nvidia-smi` fails on the host | No card is listed, so no claim is granted, and the report says why. Device lines already written stay as they are |

#### What it costs the host

One long-running process, written in Perl against Proxmox's own modules,
so it takes the config lock as `pct` does without a 0.3 s `pct` start per
call, and knows whether a guest runs from Proxmox's own check in the same
process. It reads the configs under `/etc/pve/nodes/<node>/lxc/` once a
second, reads the cards' memory from one `nvidia-smi` that runs on and
reports each second, and writes a guest's config only when it changes one.
Unit 0 measures its time from a marker to an answer, over 20 tries, with
the spread and the worst; the target is under 2 s.

The modules' interfaces are Proxmox's own and can change between versions,
so the helper refuses to write on a pve-container version its release was
not tested on, and says so in its report.

#### Install, upgrade and removal

`host/setup-gpu.sh`, run as root on the host, is idempotent and prints
each thing it changes.

- **Install** puts in `/usr/local/sbin/bb-box-gpu`, `bb-box-gpu.service`
  (`Restart=always`) and `bb-box-gpu-boot.service`; its config,
  `/etc/bb-box/gpu.conf`, root's, with the pools it serves and whether
  writes are on; and the ledger's folder. It stops, disables and removes
  `bb-box-gpu-memory.timer` and its service, and keeps the report VM and
  the token's PVEAuditor on it. A first install starts with writes off: a
  dry run.
- `--pool <name>` adds an install's pool. `--writes on` and `--writes off`
  turn writes on and off.
- **Upgrade** is running a newer release's `setup-gpu.sh`. It replaces the
  program, restarts the service, and keeps the config and the ledger. It
  refuses a ledger written by a newer protocol unless given `--downgrade`.
- **Removal**, `setup-gpu.sh --remove`, stops and removes the helper and
  puts back today's timer, so the report goes on. It leaves every guest's
  device lines and markers as they are: no box loses its card. The backend
  then offers what its templates carry, as a host without the helper does.
- **bb-box and the helper's versions.** bb-box reads the helper's protocol
  from the report. An older one: the doctor says "Run host/setup-gpu.sh
  again", and no claim changes on that node. A newer one: "The GPU helper
  on pve-1 speaks protocol 2; update BB Box." Running boxes are not
  touched either way.

#### Dry run, and moving today's GPU desktops over

Today's GPU desktops have device lines from their per-card templates and
no marker. In this order:

1. Install the helper with writes off. It writes the report, and logs each
   write it would make, to the journal and to the report. It writes no
   guest.
2. bb-box marks its guests. Each guest of its pool with NVIDIA lines gets
   `gpu.shared.<the card those lines name>.g1`; each other guest of its
   pool gets `gpu.none.g1`; running or stopped, warm guests and spares
   included. Templates are not marked. A guest whose lines name no card
   the helper lists is not marked, and the doctor names it.
3. A day of dry run with the markers. The log must show no write the
   helper would make to any guest. Each "would write" is explained before
   going on.
4. `setup-gpu.sh --writes on`.

An older bb-box on the same node writes no markers, so its guests are
never written; they count as holders of their cards. A bb-box downgraded
after this ignores the markers, and the helper leaves them as they are.

From bb-box-gpu 0.4.2 (unit 6), a fork's copy before its re-arm is refused
a claim and loses its NVIDIA lines (section 9). A bb-box older than unit 6
re-arms a fork with its new labels and no marker, so under 0.4.2 its fork
would start with no card while its box says shared. So every bb-box that
serves a pool on the node runs unit 6 or later before the helper is
upgraded to 0.4.2; unit 6's node steps check the production BB's bb-box
build before the upgrade.

#### A host without the helper

As today: shared GPU desktops on the cards their templates name. It offers
no GPU on servers, no whole cards and no change of card, and the doctor
says why.

#### What a whole card fences on Proxmox LXC

An unprivileged container can open only the device nodes its config lists.
On Proxmox LXC a whole card is therefore a fence against every other guest
on the node, not only a placement rule: the helper gives no other guest the
card's nodes. It is not a fence against the host's own processes. A guest
outside bb-box's pools that already has the card's nodes blocks the card,
and is named by its VMID.

### 6. NVIDIA's userspace in a box

Two things make a card work in a container: the card's device nodes
(section 5), and NVIDIA's userspace for the host's driver inside the box.

#### In the templates

- `build.sh linux` installs NVIDIA's userspace when the host has an NVIDIA
  driver loaded, as `build.sh desktop` does today: exactly the host's
  version, from NVIDIA's installer checked against NVIDIA's SHA-256, with
  no kernel modules, recorded in `/usr/share/bb-box/nvidia-version`.
  `--cpu` leaves it out. A host with no driver gets a Linux template
  without it, and its backend offers no cards.
- On a host with a driver, desktops with no GPU are cloned from the GPU
  desktop template (section 1).
- Templates carry no device lines once the helper is there. Unit 7 makes
  one GPU desktop template the way, and `build.sh` stops adding device
  lines. `copy-desktop` stays for a host without the helper.

The userspace gives `nvidia-smi`, the CUDA driver library (`libcuda`),
NVML, NVENC and NVDEC, OpenGL, EGL and Vulkan. It does not give the CUDA
toolkit (`nvcc`, cuBLAS, cuDNN): the guide says how to get those, and most
frameworks bring their own (PyTorch's wheels do). It is on the template's
disk once: linked clones share its blocks.

A box with no GPU has no NVIDIA device nodes, but the GL and Vulkan
loaders still find NVIDIA's libraries and try them before they fall back.
Agents run browsers on `linux` boxes all day, so unit 0 checks that
headless Chrome, Playwright, `vulkaninfo` and an EGL program behave the same
on a `linux` box with the userspace and no card as on one without.

#### Each box's userspace is recorded

`nvidiaUserspace`, in the box's record, is the template's version at
clone. bb-box reads it again from `/usr/share/bb-box/nvidia-version` and
the version of `libnvidia-ml.so` in the box after each install or update,
after each restore, and at each start it makes. It is `none` where there is
none, and `unknown` for a box not yet read. The doctor names stopped boxes
from the record without starting them, as "known" or "not checked". A
snapshot records the box's userspace at the take, where bb-box can read
it, else unknown.

#### Adding a GPU to a box without the host's userspace

A desktop made from the CPU template, a server made before its template
had the userspace, a project's image built before then, or any box whose
userspace is older than the host's driver gets device nodes from a plain
restart and still has no working GPU. So Resize to a GPU reads the record:

| The box's userspace | Resize |
| --- | --- |
| The host's driver | a plain restart |
| None, or another version, and bb-box can install it | one restart that installs it too: "Restart, install NVIDIA's userspace 580.65.06 and add the GPU", about 60 s more. A desktop also gets `DISPLAY_MODE=auto`, so it draws on the GPU |
| bb-box cannot install it | refused before anything stops, with why |
| The box is stopped and needs it | "Start swift-owl first: NVIDIA's userspace is installed in a running box." Nothing changes |

bb-box can install it on a box on bb-box's own Linux image (Ubuntu 24.04
on x86_64) with 2 GiB of disk free and no NVIDIA or CUDA packages from apt
(`nvidia-*`, `libnvidia-*`, `cuda-drivers`), which NVIDIA's installer would
fight with. Otherwise: "Not changed: amber-fox has nvidia-driver-570 from
apt, which NVIDIA's installer would conflict with. Remove it, or make a new
box with a GPU."

The order: install in the running box, which has no device nodes yet, so
nothing in it changes; stop; the helper gives the card's devices; start;
check, as section 3 says. If the install fails, the box goes on running
with no GPU, as it was, and the words say why.

#### Updating a box's userspace after the host's driver changes

After a driver upgrade on the host, a box keeps the userspace on its disk,
and `nvidia-smi` and CUDA fail in it with "Driver/library version mismatch"
until it is updated. The update is offered to the person and never runs by
itself: [question 4](#questions-for-the-owner). The reason is not that the
box may be training: a driver upgrade means a module reload or a reboot,
after which no box with the old userspace can use its card. It is that the
box's own packages may conflict, and that the update replaces libraries
under any program that has them open.

- **Where it is offered.** The box's page ("Update NVIDIA's userspace…"),
  the doctor's output and the settings' list of cards, for several boxes
  at once ("Update NVIDIA's userspace in 3 boxes…"), and
  `bb box gpu update <box>` for the person. Agents are not offered it: a
  box's `box_status` says its userspace does not match, and to ask the
  user.
- **Before anything changes**, bb-box checks the host's driver as the
  helper reports it now, that the box runs, the checks above, and NVIDIA's
  installer for exactly that version: downloaded from NVIDIA and checked
  against NVIDIA's SHA-256, or already in the host's artifacts.
- **What it says first**: "bb-box installs NVIDIA's userspace 580.65.06 in
  lone-pine, over 570.86, then restarts it. Everything running in it stops:
  python3 (3310) has the GPU open." With 061's restart guards: the threads
  working on the box are named, and an agent's restart needs
  `restart: true`. Where the backend snapshots (070), it offers to take a
  snapshot first.
- **Steps**, recorded as an operation before the first: copy the installer
  in; run it with no kernel modules, with the flags
  `customize-desktop.sh` uses; write the version file; for a desktop, set
  `DISPLAY_MODE=auto`; restart; check that `nvidia-smi -L` lists the
  claimed card and CUDA's driver initialises, and for a desktop that its
  display came up on the GPU and NVENC encodes (060).
- **Cut short** by a bb-box restart, a crash of the box or a failed
  installer: the operation is `unknown` until bb-box reads the box's
  userspace again. A half-installed userspace, where the version file and
  the library disagree, is named on the box's page, with "Update again".
  The box is never released for it.
- **Never** on acquire, a start, a failed start, a restore, the doctor or
  the sweep.
- A restore can bring back an older userspace. Its dialog says so when the
  snapshot's record names another version (section 9).

#### Templates after a driver upgrade

The doctor's check that a template's userspace is the host's driver (049)
now covers Linux templates as well as desktop templates. A mismatch warns,
and turns off only GPU placements from that template. Boxes with no GPU are
still made from it, so the template every server is cloned from never
fails the doctor after a driver upgrade:

> The Linux template on pve-1 has NVIDIA's userspace 570.86, and the host's
> driver is 580.65.06. New boxes with a GPU are not made from it until it is
> rebuilt with `build.sh linux`. Boxes with no GPU are made as usual.

### 7. How a Docker box gets its card

A box with a GPU gets its card as a CDI device when its container is made:
`--device nvidia.com/gpu=<UUID>`, as desktops do today. The NVIDIA
Container Toolkit puts the host's own userspace in, so it always matches
the driver: the Docker images need none.

- Servers get cards as desktops do. `gpu-desktops` becomes `gpus`, "GPU
  boxes", and its words say so.
- A container's devices cannot change after it is made. So on Docker a GPU
  cannot be added, removed or moved: Resize says "Cannot change on Docker"
  and why, and suggests a new box.
- Shared to whole and back are placement rules only, so they are live, as
  on Proxmox LXC. The GPU part is in bb-box's record; the container's
  labels say the part it was made with, as labels cannot change. Another
  install on the same Docker host sees that, not a later switch. The doctor
  warns when it sees another install's GPU boxes on the host.
- A per-host card lock and reservations order placements, as on Proxmox
  LXC.

**Privileged boxes see every card.** With Docker in boxes on, the default
where the daemon is not rootless, every Linux box is privileged (041), with
a GPU or without, and can open every card on the host. So on such a host,
None means bb-box gives the box no card, and Whole means bb-box places no
other box on the card: both are promises among bb-box's boxes, not fences.
Every place where someone chooses says so: the New box form's line, Resize,
the tools' answers and the guide:

> On docker-1, every box with Docker in it can open every card, with a GPU
> or without. None and Whole card are what bb-box places, not what a box
> can reach.

Closing this would need boxes that are not privileged, and Docker in a box
needs a privileged box (041). Where Docker in boxes is off, or the daemon
is rootless, boxes are not privileged: a box sees only its own card, and
None and Whole fence it from other boxes that are not privileged.

bb-box sets `CUDA_VISIBLE_DEVICES` and `NVIDIA_VISIBLE_DEVICES` to the
card's UUID in `/etc/environment` and in the box's systemd manager's
environment, so commands from `box_run`, terminals, services and containers
inside the box see it. They choose which card CUDA uses; they are not a
fence, and `nvidia-smi` still lists every card. The tools and the guide
use `nvidia-smi -i <UUID>` to show the box's own card.

Docker's GPU servers, whole cards and the share switch are not offered, not
even behind a setting, until they pass on a real card (unit 11). Today's
GPU desktops on Docker stay as they are.

### 8. Resize changes the GPU

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
| Docker | `no` | `live`, once proven | `no` |

`planResize` reads the cards and says, for the GPU part, what would change
and how:

```ts
interface GpuChange {
  readonly from: GpuPart;
  readonly to: GpuPart;
  readonly fromCard: CardPlacement | null;
  readonly toCard: CardPlacement | null;
  readonly way: ResizeWay;
  readonly installs: string | null;
  readonly stopped: boolean;
  readonly others: readonly { readonly box: string; readonly name: string; readonly stopped: boolean }[];
}
```

`others` are the boxes on the card the box would be on. `installs` is the
userspace version the change installs, if any (section 6).

What each change does, for a running box:

| From | To | When | Way | What happens |
| --- | --- | --- | --- | --- |
| none | shared | a card has room | restart | The box stops, gets the card with room, and starts again; with the userspace installed first where it needs it |
| none | whole | a card is free | restart | The same, on a free card |
| shared | whole | no other box runs on its card | live | Only the claim changes; stopped shared boxes on the card yield. Nothing in the box stops |
| shared | whole | others run on its card, and another card is free | restart | bb-box offers to move the box to the free card |
| shared | whole | others run on its card, and no card is free | refused | bb-box names the boxes on each card |
| whole | shared | always | live | The card opens to other boxes. Nothing in the box stops |
| shared or whole | none | always | restart | The box stops, loses its card's devices, and starts again |

**A stopped box stays stopped**, as 061 has it for a stopped LXC. Its
devices change while it is stopped, and the change shows at its next
start. To none: its devices are taken out now. To whole: its card is
claimed now. To shared: its GPU part changes now, and it is placed when it
next starts. Adding a GPU to a stopped box that needs the userspace waits
for it to be started (section 6). The words say so: "swift-owl is stopped:
it has no GPU from its next start. Nothing starts now."

A restart for the GPU is a restart as 061 has it: asked first, with the
threads working on the box named, before it goes ahead anyway. An agent
needs `restart: true`. A change of cores or memory in the same Resize
happens with it, in one restart.

**The plan is made again when it is carried out**, under the card lock.
If it has changed in a way the caller did not agree to (a live change now
needs a move, a card has gone, another box took the card meanwhile),
nothing changes and the caller is asked again: the person's dialog shows
the new plan with what changed; an agent's answer says what changed and
whether `restart: true` is now needed.

**When a restart fails**, the box keeps its disk. Its claim is the old one
if the new one was never granted, and the new one if it was. It is left
stopped, and the words say what happened (section 3).

The words, in the Resize dialog's "What changes":

- None to shared: "GPU: none → shared, card 1 · Restart". Under it:
  "amber-fox restarts, gets card 1, NVIDIA RTX 4090 with 24 GiB, shared with
  1 other box, in about 15 s. Everything running in it stops."
- None to shared, with the userspace: "GPU: none → shared, card 1 · Restart".
  "amber-fox restarts, gets NVIDIA's userspace 580.65.06 and card 1, in about
  75 s. Everything running in it stops. Its desktop is then drawn by the
  GPU."
- Shared to whole, alone: "GPU: shared → whole card 1 · Live". "Card 1
  becomes amber-fox's alone. No other box is placed on it while amber-fox
  holds it. Nothing in amber-fox stops." Where boxes on the card are
  stopped: "swift-owl (stopped) is placed on another card when it next
  starts."
- Shared to whole, with others running and a free card: "GPU: shared on
  card 1 → whole card 0 · Restart". "Card 1 has lone-pine running. bb-box
  moves amber-fox to card 0, which has none, in about 15 s. Everything
  running in amber-fox stops: chrome (1907) and Xorg (812) have the GPU
  open." The button is "Move and restart".
- Shared to whole, no free card: refused, with nothing tried. "No card is
  free for amber-fox alone. Card 1 has lone-pine running. Card 0 is
  quiet-elm's whole card. Release one of them, or keep the GPU shared."
  Each box name is a link to its page.
- Whole to shared: "GPU: whole card 0 → shared · Live". "Card 0 opens to
  other boxes, up to 4. They share its memory and its time. Nothing in
  quiet-elm stops."
- Any GPU to none: "GPU: shared, card 1 → none · Restart". "amber-fox
  restarts without card 1, in about 15 s. Everything running in it stops."
  On a desktop: "Its desktop is then drawn by the CPU."

A desktop that loses its GPU on Proxmox LXC keeps its disk and its
userspace. Its display finds no NVIDIA device and starts on the CPU path,
as it does today when a card is missing (006). Its video is then x264.

### 9. Snapshots, forks and restores never carry a claim

A claim belongs to a box, in the helper's ledger. A snapshot, a copy or a
rolled-back config holds device lines and a marker, but they are never a
claim.

- **A snapshot** holds the disk, as 070 has it. A GPU box's memory on the
  card is never held: neither LXC nor CUDA can save it. The snapshot
  records the box's GPU part, card and userspace at the take, as
  information only. A snapshot taken before this note has none of these,
  and says "GPU not recorded".
- **A restore keeps the box's current claim.** Before the stop, the
  restore's operation (070, section 6) records the box's claim: its card,
  part and generation. Under the card lock, bb-box checks that the card
  can take the box and reserves it for the box until its start, so no
  other box is placed in its room while it is stopped; when the card has
  no room, the restore is refused before anything changes. After the
  rollback and before the start, bb-box writes the box's current marker
  with a new generation, as a recorded step of the restore that 070's
  recovery finishes (G6), and waits for the helper. Where the rolled-back
  marker is already that claim, granted, nothing is written; a box with no
  GPU whose rolled-back config has no marker or `gpu.none` and no NVIDIA
  lines needs no helper at all. Then it starts the box on that claim and
  card: the start does not place the box again, and refuses rather than
  move it to another card. After a restart, recovery reserves the card
  again before the start; when the card has filled meanwhile, the box is
  left stopped and the restore says why. Meanwhile the ledger holds: when
  the rolled-back config's marker is older than the ledger's, or there is
  none, the helper puts the claimed card's lines back while the guest is
  stopped, and so does its boot pass, so the guest never starts with the
  snapshot's card. The restore dialog says: "Its GPU stays as it is now:
  shared, card 1."
- **A restore brings back the userspace** on the snapshot's disk. When the
  snapshot's record names another version than the host's driver, the
  dialog says so: "This snapshot has NVIDIA's userspace 570.86, and the
  host's driver is now 580.65.06: nvidia-smi will fail in the box until its
  userspace is updated." Where the record is unknown: "Whether this
  snapshot's NVIDIA userspace matches the host's driver is not known."
  After the restore, bb-box reads the box's userspace again.
- **A fork starts with no card, unless asked for one.** `box_fork` and the
  Fork dialog take `gpu`, none by default, for a fork of a live box and of
  a kept snapshot alike: a fork is a copy of a disk, and the card belongs
  to the box it came from. Asked for shared or whole, the fork is placed
  and its card reserved before anything is copied, and refused before the
  copy when no card can take it: "Fork it with the GPU shared, or none."
  The fork's own marker is written in the same config write as 070's
  re-arm, with its new labels.
- **A copy in the window before its re-arm** carries its source's tags and
  marker, and the description of its new box, which the clone writes. Its
  `box.` tag and its description name different boxes, so the helper (from
  0.4.2) refuses it a claim as a copy not re-armed, and takes its NVIDIA
  lines out, so a crash in that window leaves the copy with no card. A
  copy whose description still names its source's box is refused as a
  copy of the guest that holds that box's claim, and loses its lines the
  same way.
- **A held copy has no claim.** Its labels (`heldCopyTags`) carry no
  marker. Its disarm write also sets `gpu.none`, and the helper takes its
  device lines out before it is made a template, so a fork or a swap from
  it never inherits a card.
- **An earlier guest** (070's ZFS swap) has `gpu.none` set in its disarm,
  and the helper takes its lines out.
- **A swap, `adoptCopy`, moves the box's claim.** The box's card is
  reserved before the stop, as for a restore. The old guest's marker is
  set to none and answered first. The new guest is made not set to start
  at boot: a held copy from before this note can still carry the
  snapshot's NVIDIA lines and no marker, and the helper never writes a
  guest with no marker. The new guest then gets the box's claim with a
  generation above every ledger entry of its box (the helper names a box
  `install/box`), and once the helper grants it and its lines name the
  card, it is set to start at boot. The ledger has one guest per box, so a
  crash in between leaves the box with no card, never two; recovery
  finishes the step. When the new guest cannot be made after the old
  guest's claim was cleared, bb-box gives the old guest the box's claim
  back and waits for the grant before it starts it again. If the helper
  does not grant it, the old guest is left stopped, as it would start with
  no card, the restore stays unconfirmed, and the next sweep tries again.
- Templates, held copies and earlier guests never count as holding a card.

**At most one claim, whatever crashes.**

| Crash, or node boot, between | Then |
| --- | --- |
| a fork's copy and its re-arm | The copy's tags name its source's box and its description its new box: the helper refuses it a claim as not re-armed and takes its lines out. 070's recovery deletes and makes the fork again |
| a rollback and the re-tag | The ledger is newer than the marker: the helper puts the claimed card's lines back before any start. 070's recovery writes the marker, reserves the card again and starts on it, or leaves the box stopped when the card has filled |
| a swap's old guest set to none and its new guest's claim | Neither guest holds the card, and the new guest does not start at boot. Recovery gives the claim to the new guest, checks its lines, then sets it to start at boot |
| a swap's failed new guest and the old guest's claim given back | The old guest has `gpu.none` and no lines, and stays stopped: the restore is unconfirmed, and recovery gives the claim back before it starts it |
| a held copy's disarm and its template step | The copy has `gpu.none`. 070 deletes it and makes it again |

### 10. The doctor

| Check | Backend | Passes when | Fails or warns |
| --- | --- | --- | --- |
| `proxmox.gpu-helper` | Proxmox LXC | the helper reported under 3 minutes ago, speaks a protocol bb-box speaks, has writes on, serves this install's pool, and runs on a pve-container version it was tested on | warn with no helper: "GPU on servers, whole cards and changes of card need host/setup-gpu.sh"; warn while it dry-runs; fail when old, on another protocol or version, or not serving the pool, with the fix |
| `proxmox.gpu-report` | Proxmox LXC | as today, now written by the helper | as today |
| `proxmox.gpu-claims` | Proxmox LXC | every box of this install with a GPU has its current generation granted | fail, naming each box with a refused or unanswered claim and why; warn, naming by VMID, guests of other installs or not bb-box's that hold cards |
| `proxmox.gpu-cards` | Proxmox LXC | every running box with a GPU sees its claimed card in `nvidia-smi -L`, and the helper reports no mismatch | fail, naming each box on the wrong card or none; warn when the mapping of cards to device numbers changed since the last boot |
| `proxmox.gpu-migration` | Proxmox LXC | no guest of this install's pool has NVIDIA lines without a marker | fail, naming them, with "Run bb box gpu mark" |
| `proxmox.gpu-userspace` | Proxmox LXC | each template with NVIDIA's userspace has the host's driver; each box with a GPU too | warn per template, saying GPU placements from it are off; warn per box, running boxes as read and stopped boxes as known or not checked, naming each, with the update (section 6) |
| `gpu.<card>` | Proxmox LXC | as today, per card: free memory, when read, against what a new box needs | as today, with the boxes on the card named |
| `gpu.<card>.whole` | Proxmox LXC, Docker | a card a box holds whole has no other holder | fail, naming the guests: it means a claim went wrong |
| `gpu.<card>.limit` | Proxmox LXC, Docker | a card has no more boxes than boxes per card | warn, naming the boxes over the limit: they keep running, and no new box goes on the card until it has room |
| `docker.gpus` | Docker | as today, for GPU boxes | as today, and warn when another install's GPU boxes are on the host |

Device nodes made at boot (`bb-box-nvidia-devices.service`) stay as today.

Decided with the lead during unit 3: until unit 7 offers servers with a GPU,
a node with no helper has no `proxmox.gpu-helper` check at all, so a node
with today's GPU desktops and no helper reads exactly as before. Unit 7 brings
in the warning for a missing helper. The dry run's warning says why writes
are off: bb-box's guests must be marked and a day of dry run with the markers
pass first (unit 4).

### 11. The agent's tools: one contract

The tools, the CLI (`bb box acquire --gpu`, `bb box resize --gpu`,
`bb box fork --gpu`), the forms and boxes made for BB's environments take
the same choice and resolve it the same way.

| Tool | `gpu` | Left out | Refused when |
| --- | --- | --- | --- |
| `box_acquire` | `none`, `shared` or `whole` | the kind's "GPU when not asked for": `shared` for `linux-desktop`, `none` for `linux`. Never the form's remembered choice | a kind with no GPU part and `gpu` other than none; `linux-desktop-cpu` with shared or whole; no provider can take it |
| `box_resize` | the same, with `check` and `restart` as for the other parts | the box's GPU as it is, also when `size` is a preset | a change that needs a restart, without `restart: true`; a plan that changed since `check` in a way not agreed to; another thread's box, as 061 has it |
| `box_fork` | the same | `none`, for a fork of a live box and of a kept snapshot alike | no provider can take the fork's GPU, before anything is copied |

- **The GPU is resolved before a provider is chosen.** A shared or whole
  GPU, asked for or by default, is never met by a provider without a card,
  and never quietly turned into none. A `linux-desktop` with no `gpu`, on a
  system where no card has room, is refused, as today's `linux-desktop`
  is: it promises a GPU. "Ask for gpu none for a desktop drawn by the CPU,
  or ask the user."
- A request that implies more than one card is refused, not taken as one:
  "One card per box for now."
- `box_list` says, per kind, which providers have cards and the room on
  each, with the reading's age: "linux: GPU none, shared or whole on Proxmox
  LXC (pve-1: 2 cards; card 0 whole, quiet-elm's; card 1 shared, 2 of 4
  boxes, 17.8 GiB free when read 20 s ago). On Docker (docker-1: 1 card),
  every box with Docker in it can open every card."
- `box_status` and `box_acquire`'s answer say the box's card: "GPU: card 1,
  shared, NVIDIA RTX 4090, 24 GiB, with 1 other box (lone-pine). Run
  nvidia-smi to see it." On Docker: "Run nvidia-smi -i GPU-1d2e…a622 to see
  it; every card on the host is listed." A box on the wrong card, or whose
  userspace does not match: "nvidia-smi in amber-fox fails: its NVIDIA
  userspace is 570.86 and the host's driver 580.65.06. Ask the user to
  update it."

Refusal words follow section 3: per audience, and tested for both. To an
agent:

> Not made: no card on pve-1 is free for a whole card. Card 0 is
> quiet-elm's whole card; card 1 has lone-pine running. Ask for gpu shared,
> or ask the user. bb-box changed nothing.

> Not resized: no card is free for amber-fox alone. Card 1 has lone-pine
> running; card 0 is quiet-elm's whole card. Keep the GPU shared, or ask the
> user. bb-box changed nothing.

> Not resized: when you checked, amber-fox could change to a whole card
> live; card 1 now has lone-pine running, so it would move to card 0 with a
> restart. Call box_resize with restart true to do that. bb-box changed
> nothing.

> Not forked: no card on pve-1 can take a whole card for the fork. Fork it
> with gpu shared or none, or ask the user. bb-box copied nothing.

An agent never releases, stops or resizes another thread's box to free a
card, and is never told to.

### 12. Settings (067)

Each backend with cards has a GPUs section on its page, and the `linux`
and `linux-desktop` kinds have a default GPU on theirs. These set limits
and defaults only. A box's own GPU is chosen in the form, by Resize and by
the tools, never here, and **no setting changes a box's GPU or a card's
holders**.

**Proxmox LXC**, GPUs section:

| Field | Key | Default | Words |
| --- | --- | --- | --- |
| Boxes per card | `proxmox-lxc-boxes-per-card` | 4 | The most boxes running on one card, desktops and servers together. 0 means no limit. |
| Whole cards | `proxmox-lxc-whole-cards` | on | Lets a box have a card to itself. Off, no box is given a whole card or changes to one; boxes that have one keep it until they change or are released. |
| GPU memory a new box needs | `proxmox-lxc-gpu-memory-mib` | 1024 | The memory, in MiB, a card must have free when last read for a new server box to be placed on it. A start-up check, not a limit on what the box uses. A desktop needs at least 384 MiB. |

**Docker**, GPUs section: GPU boxes (`gpus`, was `gpu-desktops`, off), Boxes
per card (`boxes-per-card`, was `desktops-per-gpu`, 4), Whole cards
(`whole-cards`, on), GPU memory a new box needs (`gpu-memory-mib`, 1024).

**Kinds**, on the `linux` and `linux-desktop` pages: GPU when not asked for
(`kinds.<id>.gpu`): None, Shared or Whole card; `none` for `linux`,
`shared` for `linux-desktop`. What a box of the kind gets when a request
leaves `gpu` out, and the New box form's first choice until the person's
own is remembered.

- **Saving** follows 067. The numbers are fields in a form with one Save:
  the first change brings up "1 change to Proxmox LXC on pve-1 not saved",
  with Discard and Save, and "Saved" shows only once BB Box confirms it.
  Whole cards is a switch and the kinds' default a menu that stands alone,
  so each acts at once and shows "Saved" when confirmed.
- **A lower limit** blocks new placements and evicts nothing. The cards
  list and the doctor name the boxes over it: "Card 1 has 4 boxes running,
  1 over the limit of 3. They keep running; no new box goes on card 1
  until it has room."
- **Whole cards off** lists the boxes that keep their whole card.
- **Old keys.** `proxmox-lxc-desktops-per-gpu` and Docker's
  `desktops-per-gpu` and `gpu-desktops` are read when the new key is not
  set. A value set explicitly is kept, 0 (no limit) included; only a key
  never set gets the new default of 4. The old key is left in place.
- `desktop-templates` loses its GPU IDs: one line per template, a VMID, as
  the other flavours have. A line with a GPU ID still reads, and the field
  says the ID is no longer needed once the helper is there.
- Under the fields, the list of cards: "The cards on pve-1, as its GPU
  helper reported them 5 s ago", each with its index, model, memory, the
  boxes holding it, any guests of other installs or not bb-box's by VMID,
  memory in use outside bb-box's boxes, and boxes over the limit. With no
  helper, "Set up the helper" links to the setup guide.

The default for boxes per card on Proxmox LXC changes from no limit to 4,
as on Docker. This is [question 4](#questions-for-the-owner).

### 13. The pages

#### The New box form

The GPU menu is in Resources, under the presets, as today, for a Linux
server or X11 desktop on x86_64, when any provider shown has cards. It has
three items: None, Shared and Whole card. Whole card is listed only when a
provider shown allows whole cards: no dead controls. Its first choice for
each kind is the kind's "GPU when not asked for", until the person's own
choice for that kind is remembered.

Under the menu, one line says what the choice means and where the box would
go, on the provider chosen or the first with room. It is short: two lines
at most on a wide window and three at 390 px, so it keeps its height
whatever it says, and while the cards are read it says "Reading the cards
on pve-1…" in the same space. Nothing below it moves.

- None: "No GPU. You can add one later with Resize."
- Shared: "Card 1 on pve-1, shared with 2 boxes; 17.8 GiB free when read, 20
  s ago. Boxes on a card share its memory."
- Whole card: "Card 0 on pve-1, to itself: bb-box places no other box on it."
  Where some is in use outside bb-box: "Card 0 on pve-1, to itself. 20.6 GiB
  of it is in use outside bb-box's boxes."
- On Docker, None and Whole card add: "Boxes with Docker in them can still
  open every card."
- When no card can take it: one sentence, "No provider has a free card
  now: see each below." Each provider's row says why in a short line, as
  rows do for memory today: "Card 0 is quiet-elm's; card 1 has 1 box."

#### A box's page (069)

- **Size**, in the facts, stays cores, memory and disk. The GPU has its own
  fact, so the page names it once in the facts.
- **A GPU fact** for a box with a card: "Card 0, whole" with "NVIDIA RTX
  4090 · 24 GiB" under it; "Card 1, shared" with "with lone-pine" under it.
  For a stopped shared box: "Card 1 when it starts, if it has room".
- **A GPU card**, under Activity, for a box with a GPU: which card, shared
  or whole, the boxes on it with links to their pages, and the card's
  memory and use as the Monitor reads them, with this box's own processes
  and memory marked. Its one action is "Change…", which opens Resize at
  the GPU. Its last line says what the claim means, or, for a stopped box,
  what happens at its next start.
- **Notices** on the page: a box on the wrong card; a userspace that does
  not match the host's driver, with "Update NVIDIA's userspace…".
- The box's menu has Resize, as today. Resize has a GPU section below Size,
  with the same three choices, and "What changes" as in section 8.
- The move confirmation names the box's processes that have the GPU open,
  from the Monitor, and says that everything running in the box stops.

#### The Boxes page (069)

The GPU badge says "GPU" for a shared card and "Whole GPU" for a whole one.
A stopped shared box's row says "holds no card while stopped". The busy
flag can be the GPU, from the Monitor's change.

#### Look and motion

One weight, 400, wherever bb-box sets the class. BB's shared `Button` and
dialog title render at 500 and 600; bb-box's own uses of them in these
surfaces set 400, as the prototype does, or the style pass is not complete,
as 070 says. No shadow on layout cards, and no rule above a form's or a
dialog's buttons. Chevrons last in a row. Nothing moves when the cards are
read: every line that waits for a reading keeps its height. The GPU menu
opens as the form's other menus do. No new motion.

### 14. Security

- **What the token gains.** Today bb-box's token can give no guest device
  access at all. With the helper, anything that holds the token can give
  any unprivileged guest in the pools the helper serves any card's NVIDIA
  device nodes, by writing a tag. That exposes the NVIDIA kernel driver's
  interface to that guest, a large surface. The setup guide says so where
  the helper is installed.
- The helper runs as root on the host. It writes only guests that section 5
  lists, and only their NVIDIA and DRM device lines, for cards it listed
  itself. It parses markers against a fixed pattern, and takes no path,
  mode or number from a guest's config. Its config is root's.
- Its tests feed it guests outside its pools, privileged guests, templates,
  running and locked guests, guests with pending changes, malformed and
  double markers, copies naming another box, and unmarked guests with
  NVIDIA lines, and check it leaves each alone.
- A whole card fences other guests on Proxmox LXC, not the host. On Docker
  with Docker in boxes, neither None nor Whole is a fence (section 7). The
  words and the guide say so.
- A shared card has no memory fence. One box can take all of a card's
  memory, and the others' programs then fail to allocate. The words of
  Shared and the guide say so.

### 15. The guide page

"GPU boxes for compute and training", drafted in
[071-gpu-boxes/guide.md](071-gpu-boxes/guide.md), goes to
`docs/guide/gpu-boxes.md` in unit 15: what you get, `nvidia-smi` and CUDA,
sharing and whole cards, changing a box's GPU, and the limits.

### 16. How it is built

#### Rules for every step on the node

The owner's GPU boxes are training on both cards.

- The lead runs every step on the Proxmox node. Builders do not reach it.
- Live checks use test guests on VMIDs the lead lends, never the owner's
  boxes, released at once.
- Before any step that loads a card, the card's free memory is read, as a
  card-wide figure. The step goes ahead only with at least 2 GiB more free
  than it loads.
- At most one load on a card at a time, under 1 GiB and under 60 s,
  unless the lead arranges a longer window with the owner.
- Figures are read card-wide (`nvidia-smi --query-gpu`), never from the
  training boxes' processes.
- Checks that need two guests on one card, for sharing and the fence, use
  test guests that open device nodes and load nothing.
- The node is never rebooted for a check.

#### Units

Each unit is one change, delivered on origin/main, with its gate. No GPU
box is offered, in a form or a tool, before claims (unit 5) and snapshot
safety (unit 6) are in. A tool takes an argument only from the unit that
carries it out.

| Unit | What | Gate |
| --- | --- | --- |
| 0 | Measure on the node, through the lead, into `071-results.md` | The measurements below, each with its method |
| 1 | The size's GPU part in core: types, records (`gpu`, `claim`, `nvidiaUserspace`), views, the `linux-desktop-cpu` name, the kinds' "GPU when not asked for", the fake backend's cards. Nothing new is offered | tsc, the node suite and vitest. Live: a separate BB upgraded from main, with old records, kinds, settings and a project's image, restarted twice: every box reads as section 1 says, and nothing offered changes |
| 2 | The helper, dry run only: the marker's parser, what it acts on, the locked write behind `writes off`, the ledger, the report's new lines, the boot pass, the card mapping | Its tests (section 14), and: two requests racing for one card, a lost ledger, a write cut short, a rollback, a copy naming another box. Live, through the lead: a day on the node writes no guest (every guest's config the same before and after), and today's bb-box reads the report throughout |
| 3 | `setup-gpu.sh`: install, upgrade, removal, retiring the timer, the version checks; the doctor's `proxmox.gpu-helper` | Live: install in dry run, run twice with nothing changed the second time, upgrade, remove and put back; the doctor passes and fails as section 10 says |
| 4 | Marking today's guests (`bb box gpu mark`), and the day of dry run with markers; `proxmox.gpu-migration`; a helper release that writes its report on its first pass after a start, so the day runs on it (decided during unit 3) | Live: after marking, 24 h of dry run show no write the helper would make; the doctor's check passes |
| 5 | Claims: the card lock, reservations, generations, waiting for answers, the start gate, recovery at bb-box's start; the helper's writes on. Used first by today's GPU desktops, whose behaviour does not change | Live, on test guests: two acquires at once with boxes per card 1 go to different cards; a second install with its own pool asks for the same card and is refused; bb-box killed between a marker and its answer, and on restart nothing is placed until it is settled; a stopped test guest's claim moved by the test harness gets the new card's lines within 2 s and starts on it; no other guest's config changes |
| 6 | Snapshot safety: 070's fork, restore, held copy, earlier guest and swap carry no claim (section 9); `box_fork gpu` none and shared for desktops | Live: a fork of a GPU desktop with none and with shared; a restore after a claim moved by the harness keeps the current card; a held copy's lines gone before it is a template; `adoptCopy` moves the claim; bb-box killed at each point of section 9's table, and the boot pass run by hand: afterwards no card has two claims, and `gpu.<card>.whole` passes |
| 7 | Servers with a shared GPU on Proxmox LXC: the userspace in the Linux template, one GPU desktop template with no device lines, desktops with no GPU from it, placement for servers, the checks after start and the sweep's; `box_acquire gpu` none and shared, `box_status`, `box_list`; the doctor's warning for a node with no helper (section 10) | Live: a shared server on each card, one at a time, with `nvidia-smi` and a PyTorch matrix multiply under 1 GiB; a desktop with no GPU from the GPU template behaves as a CPU desktop (display, video, Chrome); time to ready within 5 s of today's desktop's; an agent's `box_acquire` with gpu shared, and with gpu left out on `linux` and `linux-desktop` |
| 8 | Whole cards on Proxmox LXC: placement, yielding, refusals for each audience; `box_acquire gpu whole`, `box_fork gpu whole` | Live: two whole acquires at once for one free card, one made and one refused before any copy; whole refused with names while a test guest runs on the card; a stopped shared test guest yields and starts on the other card; a test guest without the card's nodes cannot open them |
| 9 | Resize with `gpu` on Proxmox LXC: share live; add, remove and move with a restart; stopped boxes; the plan made again; `box_resize gpu` | Live, every row of section 8's table, running and stopped: a process that counts, under 256 MiB on the card, keeps counting through a live switch; a move whose card is taken meanwhile is asked again; a failed restart leaves the box stopped with its disk; cores and GPU in one restart; the refusal with names |
| 10 | Adding a GPU to a box without the host's userspace (section 6) | Live: none to shared on a desktop made from the CPU template draws on the GPU and encodes with NVENC; the same on a `linux` box made without the userspace; a box with NVIDIA packages from apt refused before it stops |
| 11 | Docker: GPU servers, whole as placement, the share switch, the environment in every route, the words about privileged boxes | Only on a Docker host with a card: a privileged box with no GPU opens a card, as the words say; CUDA picks the box's card through `box_run`, a terminal and a service. Until it passes, nothing in this unit is offered, not even behind a setting |
| 12 | The userspace update after a driver change, on its own (section 6) | Live: an update from an older userspace on a test box; an update cut short is named, and "Update again" fixes it; a restore to a snapshot with an older userspace is named by the doctor; nothing updates by itself on acquire, start, restore, doctor or sweep |
| 13 | The New box form and the Resize dialog | Live in a separate BB at 390, 760 and 1440 px, light and dark: the line's height is the same for None, Shared, Whole card, refused and reading; each Resize row driven and its effect seen in `nvidia-smi` |
| 14 | The box's page and the Boxes page | Live: the GPU fact and card, a stopped box's words, the notices |
| 15 | Settings: the GPUs sections with Save, the old keys, the list of cards, the kinds' default; then the guide page, the reference, the setup guides and the skill | Live: a save with its receipt, a failed save, a lowered limit naming the boxes over it, whole cards off leaving a whole box as it is, an explicit old 0 kept; docs and site tests; the guide's commands run as written on a test box on each backend with a card |

Unit 0 measures, in this order. Steps 1 to 9 load no card.

1. The Proxmox VE and pve-container versions on the node.
2. That a device change through the token is refused, with one call on a
   stopped test guest that changes nothing. The source already answers
   this; the call confirms the installed version.
3. That `pct start` and the API's config changes take `lock_config` in the
   installed version's source.
4. Hot-plug on the installed version, with a device that is not a GPU's,
   on a running test guest.
5. The longest description Proxmox keeps.
6. Each card's UUID, PCI address, minor and DRM nodes, now and after the
   owner's next reboot, made for other reasons.
7. What `nvidia-smi -L` and `nvidia-smi` show in a test guest given one of
   the two cards' nodes, and that a test guest without them cannot open
   them.
8. The size of NVIDIA's userspace in a Linux template, and its effect on a
   clone's time.
9. The helper's time from a marker to an answer, with a throwaway script
   on the host that does the locked write for a stopped test guest: 20
   tries, the spread and the worst, and a refusal and a timeout. On any
   box with no card, not necessarily on the node: headless Chrome,
   Playwright, `vulkaninfo` and an EGL program with and without NVIDIA's
   userspace.
10. The one load: the GPU memory a CUDA context takes, cold and warm, with
    PyTorch, read as the card's memory used before, during and after, with
    the driver's and PyTorch's versions. Once per card, under the rules
    above.

Later, each its own note or unit: a card passed through to a Proxmox QEMU
box; Linux machines with cards in the SSH host pool; two whole cards in a
box; the GPU in Docker containers inside a box (the NVIDIA Container
Toolkit in the box); a live add of a GPU through Proxmox VE 9's hot-plug.

## Gated in unit N

What each unit may not claim until its gate is met:

- Unit 2: the helper is not called safe until its tests show it leaves
  alone every guest it must, and a day of dry run on the node has written
  no guest.
- Unit 4: writes are not turned on until a day of dry run with markers
  shows no write the helper would make.
- Units 5 and 6: no GPU box is offered beyond today's desktops until
  claims and snapshot safety pass live.
- Unit 7: no GPU server is offered, in the form or the tools, until a live
  PyTorch run on a test box passes on each card.
- Unit 8: no whole card is offered until two whole acquires at once leave
  one claim.
- Unit 9: Resize does not offer a GPU change until each row of section 8's
  table has been driven live, running and stopped.
- Unit 10: Resize to a GPU on a box without the userspace is refused, with
  words, until its gate passes.
- Unit 11: Docker's GPU servers, whole cards and share switch are not
  offered until they run on a card.
- Unit 12: no box's userspace is updated until the update's gate passes.
- Unit 13: the owner's production BB gets the form only after the live
  check on a separate BB.

## Questions for the owner

Each has a default this note builds in. A different answer changes the
units named. The owner answered all six on 31 October 2026, each with its
default: a stopped whole box keeps its card and a stopped shared box gives
up its place; `linux-desktop` shared, `linux` none and a fork none; one
card per box for now; 4 boxes per card where never set, explicit values
kept; the person updates a box's userspace, never bb-box by itself; a
running box on the wrong card is named, new placements on both cards stop,
and the person restarts it.

1. **Does a stopped box keep its card?** If it does, a box someone forgot
   to release blocks that card from being given whole for as long as it
   exists. If it does not, a stopped box may not get its card back when it
   starts, and is refused when no card has room. Default: a stopped box
   with a whole card keeps it; a stopped box with a shared GPU holds no
   place, and goes back to a card with room when it starts, its last card
   first. Other answers: every stopped box keeps its card, as today; none
   does; or a stopped whole box keeps its card for a day. Units 5 and 8.
2. **A box's GPU when a request does not say.** Default: `linux-desktop`
   shared, as it promises a GPU today, `linux` none, and a fork none, as
   the kinds' setting so it can be changed later; an agent never gets the
   form's remembered choice. Units 1 and 7.
3. **Two whole cards in one box**, for training across both cards.
   Default: not now; a request that implies more than one card is refused.
   The GPU part can grow a count later. Unit 1.
4. **Boxes per card on Proxmox LXC**: today no limit by default. Default:
   4 where the key was never set; a value set explicitly, 0 included, is
   kept; boxes over a new limit keep running and are named. Units 7 and
   15.
5. **A box's NVIDIA userspace after the host's driver changes.** Default:
   the doctor names the boxes, and the person updates them, one at a time
   or several at once; it never runs by itself, because the box's own
   packages may conflict and it replaces libraries in use. Units 10 and
   12.
6. **A running box on the wrong card**, after a reboot or a driver change
   moved the cards' numbers and the boot pass did not run. Default: named
   on its page and in the doctor, new placements on both cards stop, and
   the person restarts it; bb-box never stops it by itself. The other way
   is to stop it at once, which ends whatever it runs. Unit 7.

## Alternatives considered

**A template per card, as today's desktops.** No root on the host's side,
and proven. But a box cannot gain, lose or change a card after it is made,
which the owner wants, and templates multiply: cards times flavours, each
rebuilt when the driver changes. Kept for hosts without the helper.

**bb-box's own database as the claim of record.** Simple, and it survives a
rollback. But each install sees only its own pool, so it cannot keep two
installs, or guests that are not bb-box's, off a whole card. The helper
sees every guest on the node, so its ledger is the record.

**A Proxmox hookscript on the template.** Clones copy a template's
hookscript, which runs as root at `pre-start`. It could set device lines
just before a start, with no polling. But whether lines set in `pre-start`
apply to that same start is not known, a hookscript is also root-only to
set, it runs on every start of every clone, and it would have no view of
other guests to keep a whole card whole. Unit 0 may test it; the helper
does not depend on it.

**The host's userspace mounted into the box at start**, through LXC's
NVIDIA hook and `libnvidia-container`, as Docker's toolkit does. It would
end driver mismatches, and with them question 5. It needs raw `lxc.*`
lines, which only root can set; with a root helper that objection is
weaker, but such a hook runs as root on the host at each start, and has not
been proven in bb-box's unprivileged containers. A later note may take it,
with care.

**A GPU variant of the Linux image**, with the userspace only there. Smaller
plain templates, but a box made without a GPU could not be given one by
Resize without the install of section 6. The userspace costs disk once per
template.

**A card passed through to a Proxmox QEMU box (057).** A real fence and a
kernel of the box's own, and the token can set a passed-through device
through a resource mapping with `Mapping.Use`. But the card leaves the
host's driver for `vfio-pci`, so it cannot be shared with LXC boxes while
passed through; it needs IOMMU on the host; and a VM with a passed-through
card cannot be snapshotted with its memory or moved. Later, for whole cards
only.

**Stopped boxes always keep their card**, as today. The simplest rule, and
a start never fails for want of a card. But forgotten stopped boxes block
whole cards. The default keeps it for whole boxes only; question 1 asks.

**Releasing a stopped box's card at once when it stops**, rather than when
a whole claim needs it. Cleaner books, but every stop and start of a shared
box would need the helper, and a box stopped from inside, or at the node's
shutdown, would hold lines anyway. Yielding when needed has the same
effect on whole cards with less churn.

**A share of the card a whole box needs free, as a setting** (Opus 13).
The form and Resize already say how much is in use outside bb-box before
the box is made, and the GPU memory a new box needs still applies. A second
memory setting would add little.

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
host, docker-1, with one card. Its placement holds claims as section 4
does: a box being made, moved or started holds its card from the moment it
is placed.

The panel at the bottom left goes to each page and sets the scene:

- **Boxes, by card**: each card and the boxes holding it, a stopped shared
  box marked as holding no card, and the boxes with no GPU.
- **New box**: choose Server or Desktop, then the GPU. Server starts at
  None and Desktop at Shared, from the kinds' setting, and each keeps the
  person's last choice. The line under the menu says "Reading the cards…"
  first, then which card the box would get, in the same height. Choose
  Whole card for a server: no provider has a free card, the line says so
  in one sentence, and each provider's row says why.
- **amber-fox**, a shared desktop on card 1 with lone-pine running and
  swift-owl stopped: Resize, then Whole card. It is refused, as lone-pine
  runs on card 1 and card 0 is quiet-elm's; swift-owl, stopped, does not
  stand in the way. Select "Release quiet-elm", and Resize offers to move
  amber-fox to card 0, naming chrome and Xorg as GPU programs that stop.
  Start a whole box while the move runs: card 0 is already held, so it is
  refused.
- **quiet-elm**, a server with card 0 whole: Shared is live.
- **calm-reef**, a server with no GPU: Shared is a restart onto card 1.
- **pale-moss**, a desktop made from the CPU template, with no NVIDIA
  userspace: Shared is a restart that installs it first.
- **swift-owl**, a stopped shared server: Resize to None leaves it stopped.
  Its userspace is from before the host's last driver upgrade, so its page
  offers the update, once it is started.
- **dock-wren**, a Docker server alone on its card: Whole card is live, None
  says it cannot change on Docker, and the words say every box with Docker
  in it can open every card.
- **Settings: GPUs**: each backend's GPUs section, with Save for the
  numbers, Whole cards acting at once, and the kinds' default GPU. Lower the
  boxes per card below a card's boxes, save, and the card names the boxes
  over it, still running. Turn off whole cards, and quiet-elm keeps its
  card.
- **An agent asks**: the tools' answers to `box_list`, `box_acquire` with
  a GPU and without, `box_resize` with `check`, `box_fork`, and
  `box_status`, from the same cards, in the agent's words.

Waits are short and nothing is saved.

## Consequences

- Any Linux box on a GPU host can have a card, and change it later.
- One GPU desktop template and one Linux template per host, not one per
  card, once the helper is there.
- A root helper on each Proxmox host with cards, replacing the report's
  timer, with the doctor watching it. bb-box's token can then give a guest
  in its pool a card's devices, which it could not before.
- The helper's ledger, on the host, is the record of which box holds which
  card, across installs, and outside every snapshot.
- `linux-desktop-cpu` becomes a name for a desktop with no GPU; kinds no
  longer carry `gpu`; 012's rule that `gpu` must agree exactly now applies
  to the size.
- Whole card fences other guests on Proxmox LXC only. On Docker, None and
  Whole are promises among bb-box's boxes where boxes have Docker in them.
- A stopped shared box on Proxmox LXC holds no card, and may start on
  another.
- Every Linux template on a GPU host is rebuilt when the host's driver
  changes, as desktop templates are today; until then it makes boxes with
  no GPU only.
- Proxmox LXC's default boxes per card goes from no limit to 4 where it was
  never set.

## What changed after the reviews

### After the first reviews

Two independent reviews, by Opus and by GPT-6 Astra, read the note, the
guide draft and the prototype, compared them with the code and with
pve-container's source, and drove the prototype in a browser on a box.
Both said: build after changes. Numbers are each review's own.

| Finding | Reviews | Change | Where |
| --- | --- | --- | --- |
| Nothing makes a placement one decision: two acquires, a Resize racing an acquire, two installs on one node | Opus 2, Astra 1 | A per-node card lock and reservations before any copy or stop; generations answered once; the helper, which sees every guest of every install, decides and refuses a second claim on a whole card; a race table; whole refused when bb-box cannot see the node | Section 4 |
| The helper needs a locked, versioned protocol | Astra 2, Opus 10 | Writes inside `lock_config`, refusing running, locked and pending guests; one marker tag with a full UUID and a generation; answers in the report; a version and protocol; fail-closed table; Perl on Proxmox's modules, not a `pct` per call; install, upgrade and removal | Section 5 |
| The write path is unsafe on Proxmox VE 9, which hot-plugs a device line into a running container; unit 0's claim was wrong | Opus 3, Astra 2 | Said plainly; the stopped check is inside the lock; restart kept as policy, not justified by a false limit; unit 0 records the version and tests hot-plug with a device that is not a GPU's | Section 5, "How it writes"; unit 0 |
| Installing the helper would strip today's GPU desktops, which have no tag | Opus 1, Astra 3 | The helper acts only on explicit markers, or a claim it granted; unmarked guests are never written; marking, then a day of dry run that writes nothing, then writes on; older and downgraded versions covered | Section 5, "Dry run, and moving today's GPU desktops over"; units 2 to 4 |
| Snapshots, forks, restores, held copies and swaps carry tags and device lines | Opus 7, Astra 4 | The ledger is the claim of record, outside rollback data; a fork starts with none or a fresh claim, written in the re-arm; a restore re-labels as a recorded step before its start; held copies and earlier guests get `gpu.none`; a swap moves the claim; a crash table that leaves at most one claim | Section 9; unit 6 |
| Card numbering can move after a reboot or driver change; nothing checks running boxes | Opus 6 | Claims by UUID; nodes worked out at each write; a boot pass before `pve-guests.service`; the helper's mismatch line; `nvidia-smi -L` in every running GPU box after start and each sweep; question 6 | Section 5, "Card numbering"; question 6 |
| Stopped boxes pin cards, so whole cards will rarely be free | Opus 5 | The trade-off in plain words; default: stopped whole boxes keep their card, stopped shared boxes yield; question 1. Opus's "move the stopped boxes" offer is not needed, as they yield | Section 3; question 1 |
| A box made without NVIDIA's userspace cannot use a GPU after Resize; a CPU desktop forces the CPU | Opus 4, Astra 6 | Each box's userspace recorded; Resize installs it in the same restart, or refuses with words; GPU-host desktops with none cloned from the GPU template; proved on a CPU-made desktop with graphics and video | Sections 1 and 6; unit 10 |
| The userspace update needs its own safe operation and gate; the doctor fails the Linux template after a driver upgrade; question 4's reason does not hold | Opus 12, Astra 8 | A person's operation with preconditions, words, steps, interruption, checks, bulk; never automatic, for the true reason; the helper reports the driver; templates warn and block GPU placements only; its own unit and gate | Section 6; unit 12; question 5 |
| Recovery must keep disks and power state | Astra 5 | Make-again only for a fresh acquire; an existing box is left stopped with its disk and claim; a stopped box stays stopped through Resize; "everything running in it stops"; the plan made again, asked again when it changed | Sections 3 and 8 |
| On Docker every privileged box sees every card, so None is false too; `CUDA_VISIBLE_DEVICES` is not a fence | Opus 8, Astra 7 | None and Whole are promises among bb-box's boxes, said wherever someone chooses; the variables in `/etc/environment` and systemd's environment; `nvidia-smi -i`; nothing offered until a real card passes | Section 7; unit 11 |
| Free memory is presented as a guarantee | Astra 9 | A best-effort start-up check against a reading; ages given, never "now"; unknown and stale rules; this install's reservations taken off. A refresh at placement is not needed: the helper writes within a second of any 64 MiB move | Section 3, "GPU memory" |
| Tool defaults and refusal words need one contract | Astra 10, Opus 9 | One table for `box_acquire`, `box_resize`, `box_fork`; the GPU resolved before the provider, never downgraded; Resize keeps the GPU; fork none; the alias refused; refusals per audience, never telling an agent to release another's box or change settings, tested for both | Sections 3 and 11 |
| Defaults in the owner's direction are not settings | Opus 15 | "GPU when not asked for" on the `linux` and `linux-desktop` kinds; the form's first choice | Section 12; question 2 |
| Settings must not change ownership; numbers saved on every keystroke | Astra 11 | No setting changes a box or a card's holders; lower limits evict nothing and name boxes over; whole off keeps existing ones; 067's Save and receipts; explicit old values kept, 0 too | Section 12; question 4 |
| Whole can be granted on a card something else is using | Opus 13 | Whole ranks cards by memory used outside bb-box's boxes and says so before; guests outside the pools named by VMID. A setting for a share of the card is not taken: see Alternatives | Sections 3, 13; Alternatives |
| Unit 0 can disturb the training boxes | Opus 11, Astra unit 0 | Rules for every node step: the lead runs it, free memory read first, one load under 1 GiB and 60 s, card-wide figures; the token check answered by the source and confirmed with one refused call; the fence tested by opening nodes; no reboots | Section 16 |
| Units too big; tools too late; GPU boxes offered before snapshot safety | Opus 14, Astra 12 | 16 units, each with a live check; claims and snapshot safety before any new GPU box; tools with the unit that carries them out; Docker not offered until proven | Section 16; Gated in unit N |
| The prototype breaks the style guide | Opus 16, Astra 13 | Weight 400 on buttons and dialog titles; no layout shadows or rule above the buttons; the GPU line one fixed height with a reading state, details in provider rows; the box page names the GPU once in the facts; the Large preset not cut; the move confirmation names the GPU programs; the settings' wording | Prototype; section 13 |
| The prototype let a whole box land on a card being moved to | Astra 1 | The fake server holds a card from the moment a box is placed on it, as section 4 does | Prototype |
| A stopped box became Ready after Resize | Astra 5 | It stays stopped | Prototype |
| The agent's words told it to release other threads' boxes or raise settings | Opus 9 | Agents' own words | Prototype |
| The unit table, question answers and test capacity | Astra units, both on the questions | Taken unit by unit: two-guest checks with no load allowed; userspace work its own units; Docker's real-card gate; the kinds' default for the agent's GPU | Section 16; questions |
