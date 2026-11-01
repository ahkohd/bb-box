# 070: A box's snapshots are bb-box's own records, taken by each backend's own mechanism, and kept with the box unless the person keeps them

Status: proposed, 30 October 2026, with the owner's answers to the
research's four questions built in. Revised three times the same day after
three rounds of two independent reviews; every finding of each round is answered
in [What changed after the reviews](#what-changed-after-the-reviews). Not
built yet: see [How it is built](#13-how-it-is-built) and its
[gates](#gated-in-unit-n).

Research: [Snapshots of boxes](../research/box-snapshots.md), with its
measurements on Proxmox LXC and QEMU, Docker, Tart, microsandbox, boat.dev,
Hetzner, Namespace and device boxes. This note does not repeat them; it
cites them where a rule depends on a number. The research measured
Proxmox on LVM-thin only; what this note says of other Proxmox storage and
of Proxmox's clone is from Proxmox's own code, and unit 0 and unit 3
measure it. Anything a gate cannot prove live stays off.

The prototype is [070-snapshots/prototype.html](070-snapshots/prototype.html):
one file, opened in any browser, made from bb-box's own components with a
fake server, as 067's and 069's were. Its source is in
[070-snapshots/prototype](070-snapshots/prototype/). How to click through it
is under [The prototype](#the-prototype).

Extends [069](069-boxes-page.md): its box log gains snapshot events, the
Boxes page gains a Snapshots tab, and a box's page gains a Snapshots
card. Extends [067](067-settings-page.md): Options gains a Snapshots
page. Extends [061](061-a-box-can-be-resized-live-where-its-backend-can-and-restarted-only-when-asked.md)'s
pattern: a backend says per kind what it can do with no call to a host, and
plans an operation on one box, read live, before anything changes, as
`planResize` does. Adds request 38 to [what bb-box asks of
BB](../bb-requests.md#38-say-who-answered-a-plugins-form).

## Context

The owner: "one core feature we should start thinking about: snapshot. Is
it provider based? The management etc.; for example boat supports snapshot
built in. An agent should be able to snapshot, right?"

The research answered: the mechanism is each provider's; the model is
bb-box's. Then the owner gave the direction for this note. Snapshots are a
core feature. bb-box has its own model, and each provider fills it in as it
can. Agents can take them. A UI manages them, with a small picture of the
box's screen on each.

The owner's answers to the research's questions, which this note builds in:

1. An agent may restore its own box without asking, with an undo snapshot
   taken first. Never one of the person's own machines without a yes in the
   thread.
2. Memory snapshots are not the default where a backend offers them. Disk
   only, unless asked.
3. Keep keeps a snapshot 30 days. Only the person can keep one.
4. Paid snapshot storage is allowed, such as boat's saved snapshots at
   $0.056 a day. bb-box shows what it costs, and the person sets a ceiling
   in Settings.

Findings from the research that the design must answer:

- bb-box's Proxmox token lacks `VM.Snapshot` and `VM.Snapshot.Rollback`
  ([setup-token.sh](../../setup/proxmox-lxc/host/setup-token.sh)).
- A rollback made outside bb-box was not recorded in the box log, and the
  box came back as the same BB machine within minutes: the snapshot held
  BB's daemon state from before.
- A fork must drop its source's BB machine credentials, env file, tailnet
  node and SSH host keys. A Proxmox clone and a `tart clone` keep them all.

### Who uses snapshots, and for what

Two users. The agent of a thread, through tools, many times a day once it
can; and the person, on the Boxes page, a few times a week. Most frequent
first, estimated from the research's table of wants, not measured.

| # | Task | Who | How often |
| --- | --- | --- | --- |
| 1 | Take a checkpoint before a risky change | agent, often unasked | Several times a day per busy thread |
| 2 | Roll back after it went wrong | agent; person | Daily |
| 3 | See what snapshots exist, and what they cost | person | Weekly |
| 4 | Clean up: delete what is no longer needed, free space | person | Weekly |
| 5 | Fork: try two things from one set-up state | agent; person | Weekly |
| 6 | Keep a state past the box's release, and start from it later | person | Rarely |

### What bb-box and BB offer today

- A box's record (`BoxRecord` in BB's key-value store), with a resize
  recorded on it before it starts (`ResizeRecord`) and finished by the sweep
  if bb-box restarts part way, and the box log (`box-log.db`, 069 unit 1b,
  [box-log.ts](../../src/core/box-log.ts)) with an actor on each event.
- One queue of work per box in the server (`#chain` in
  [boxes.ts](../../src/core/boxes.ts)), which serialises a box's start,
  stop, resize and release within one process.
- What a backend can resize per kind (`resizing(kind)`), and what a resize
  of one box would do (`planResize`), in [types.ts](../../src/backends/types.ts).
- How a tool reaches a box: a thread's own boxes, or the box it runs on,
  which may be one of the person's machines or another thread's box
  (`resolve` in [setup.ts](../../src/plugin/setup.ts)). Before a restart,
  `checkRestart` refuses while a person holds the desktop's control and,
  unless forced, while threads work on the box's BB machine.
- bb-box's Proxmox boxes have `onboot` set, so they start when their node
  boots; a Proxmox clone copies it, with the guest's network settings, and
  gives every network interface a new MAC address. A clone of a running
  container is refused unless it is of a snapshot.
- The SDK bb-box pins (0.6.15) has `bb.ui.requestInput`: a form in the
  thread. Called from a tool, the agent gets a waiting notice; bb-box's
  server gets the submitted value. The form is answered in BB's app, and
  also by BB's command line, `bb thread interactions respond --self`, which
  any agent of the thread can run: the result does not say who answered.
  It is cancelled by a timeout (10 minutes by default, at most an hour), a
  stop of the thread, or a restart of BB's server. The SDK also has a
  `message.dispatch` hook, with which a plugin can hold or refuse a turn
  before it starts; BB's "Send now" bypasses it.

## Decision

### 1. A snapshot is a record of bb-box's

bb-box keeps one list of snapshots across every backend, in a file of its
own, `snapshots.db`, attached to the SDK's database as 069 attaches
`box-log.db`, with its own migrations and write-ahead log. Its records and
its operations (section 6) are never evicted; pictures are kept in a table
of their own, capped at 48 MB, and the oldest pictures of snapshots that
are not kept go first. If the file cannot be written, every snapshot
operation is refused before it starts, and the doctor says so; a box's
start, stop, resize and release go on (see [Decided during unit
1a](#decided-during-unit-1a)).

| Field | Type | Example | Notes |
| --- | --- | --- | --- |
| `id` | `sn` and 12 letters and digits | `sn7kq2m9xa4pd` | bb-box's, never the provider's |
| `box` | ID, name, kind, system, thread | `bxamberfox2q7k`, amber-fox, `linux-desktop` | copied at the take, so a kept snapshot still names its box after the release |
| `boxGone` | time and how, or null | released 12 Oct | set when the box is released or forgotten |
| `backend`, `host`, `storage` | backend ID and label; host; storage name and type | `proxmox-lxc`, pve-1, `local-lvm` (`lvmthin`) | where it is; usable only there |
| `guest` | `current`, `earlier`, or `held-copy` | `current` | `earlier`: it lives on a guest the box no longer runs on, after a swap (section 2); `held-copy`: it is a held copy (section 7) |
| `name` | text, at most 60 characters, unique per box | "before the migration" | given, or the time ("Thu 10:42"); a repeat gets " (2)" |
| `note` | text, at most 1 KB, or null | | |
| `takenAt`, `capturedAt`, `tookMs` | times; duration | 10:42:07; 10:42:07; 680 ms | `capturedAt` is the moment the state is from, which can be earlier than the take (boat's background capture) |
| `by` | an `Actor`, as the box log's | the agent in "Fix the sign-in flow" | |
| `scope` | `box` or `device` | `box` | `device`: an Android emulator's own snapshot, which restores the device and nothing else in the box |
| `holds` | `disk` or `disk-and-memory` | `disk` | what a restore brings back; a held copy holds the disk only |
| `excludes` | words, or null | "/tmp, caches, SSH host keys" | from the backend; shown in the restore dialog |
| `size` | bytes and what they mean, or null | 1.2 GB, `own` | `own`: what deleting it frees; `whole`: what it holds, some shared with the box; null: unknown, shown as unknown |
| `price` | amount, currency and period, or null | $0.056 a day | null where it is on the person's own storage; unknown prices are shown as unknown, never as free |
| `owner` | `thread` or `person` | `thread` | see [section 3](#3-who-may-do-what) |
| `keptUntil`, `keptAt` | times, or null | 29 Nov | set only by the person; the snapshot is then the person's |
| `undoOf` | an operation ID, or null | the restore at 11:02 | marks an undo, which section 8 counts apart; a kept undo is an ordinary kept snapshot |
| `forkSafe` | the version of the identity reset found in the box at the take, or null | 1 | see [section 9](#9-a-fork-is-a-new-box-with-a-new-identity); a snapshot without it neither forks nor is kept |
| `dependsOn` | snapshot IDs, or none | | microsandbox's chain: the snapshot this one was taken after, shown on its row; each holds its own data, so any is deleted first (changed during unit 10) |
| `picture` | the picture's state | `taken`, `none` (headless), `off`, `failed` | the image is in its own table, see [section 10](#10-a-picture-of-the-screen) |
| `ref` | the backend's reference | `bbsn7kq2m9xa4pd` on Proxmox | opaque to the core |
| `state` | see below | `ready` | |
| `error` | the backend's words, or null | | on `failed`, `incomplete` and `lost` |

A snapshot is not an image. It holds one box's state, secrets included,
and serves that box and its forks. A project's image stays a script (049),
and "Make an image from this snapshot" is left out for 049's reasons.

#### Its states

```
taking ──► ready ──► deleting ──► (gone: the record goes)
   │        │  ▲          │
   ▼        ▼  │          ▼
 failed   unavailable   incomplete
            │
            ▼
           lost
```

| State | Means | Leaves by |
| --- | --- | --- |
| `taking` | its take has started and is not confirmed | `ready` only when the backend confirms it complete (on Proxmox, the task ended OK and the snapshot has no `snapstate`); `failed` when the backend says so; `incomplete` when part of it exists |
| `ready` | it can be restored, forked, kept, renamed and deleted, as its plan allows | `deleting`; `unavailable`; `lost` |
| `failed` | the take failed and nothing is held | removed after 24 hours; shown on the box's page until then |
| `incomplete` | part of it exists (Proxmox `snapstate=prepare` or `delete`, a half-made held copy) | the person's Delete, which finishes the backend's own cleanup; never restored or forked |
| `deleting` | its delete has started | gone when the backend confirms; `incomplete` when the delete stops part way |
| `unavailable` | bb-box cannot reach where it is: its host does not answer, or its backend is not in settings | `ready` when a listing succeeds again; never `lost` by itself |
| `lost` | a listing that succeeded did not have it, twice, 10 minutes apart | removed by the person, or after 7 days |

A listing that fails marks nothing: as `held()` does today, a backend that
throws is skipped. A backend or host that holds snapshots cannot be removed
from settings while it holds them, except by an explicit "Forget its
snapshots", which names them, their size and their price, and says they may
still exist and be billed.

Expiry is not a state. A kept snapshot whose `keptUntil` passes is deleted
by the sweep as a delete, once no operation uses it.

#### Where it lives, and how it is found again

- The record is bb-box's. The snapshot itself lives where its backend keeps
  it: on its host for Proxmox, Tart, microsandbox and Docker, on the
  account for boat.
- Each backend labels a snapshot with the install, the box, the snapshot's
  ID and, once kept, its keep date, as 018 does for guests. On Proxmox: a
  snapshot named `bb<id>` with a description `bb-box install <install> box
  <box> snapshot <id> kept <date>`; an earlier guest and a held copy carry
  tags and a description of their own (sections 2 and 7). On a Mac: a label
  file in the snapshot's folder. On boat: the saved snapshot's name. Labels
  carry IDs and dates only, never names, notes or secrets.
- `heldSnapshots()` lists a backend's snapshots, earlier guests and held
  copies of this install. At start and at each sweep bb-box compares it
  with its records:
  - a record whose snapshot is missing from a successful listing, twice,
    becomes `lost`;
  - a labelled snapshot with no record, of a box that still exists, gets a
    record again (`by` unknown, name from the time);
  - a labelled snapshot or held copy of a box that is gone, whose label has
    a keep date not yet passed, gets a record again as kept;
  - a labelled snapshot of a box that is gone, with no keep date, is listed
    as "Found on pve-1, not in bb-box's records" until the person deletes
    it (changed during unit 8: it was deleted after 7 days). It is never
    deleted by bb-box, so a lost `snapshots.db` loses no kept snapshot.
- Earlier guests and held copies are never started, warmed, lent as
  spares, released as leftovers, or checked as a kind's template: their
  labels exclude them from each of those.

### 2. What a backend offers, and what it plans for one snapshot

Two steps, as for a resize.

**What it offers, per kind**, with no call to a host, for `box_list`, the
kinds in Settings and the words before a box exists:

```ts
type Holds = "disk" | "disk-and-memory";
type WhileRunning = "live" | "pauses" | "suspends" | "stopped-only";
type KeepsPastRelease = "as-is" | "held-copy" | "no";

interface Snapshotting {
  readonly scope: "box" | "device";
  readonly holds: readonly Holds[];
  readonly whileRunning: WhileRunning;
  readonly restore: "in-place" | "new-guest" | "none";
  readonly fork: "copy" | "none";
  readonly keepsPastRelease: KeepsPastRelease;
  readonly lives: "host" | "provider";
  readonly price: Price | null;
  readonly excludes: string | null;
}

interface Price {
  readonly amount: number;
  readonly currency: "USD" | "EUR";
  readonly per: "day" | "month" | "GB-month";
  readonly known: boolean;
}

snapshotting?(kind: string): Snapshotting | null;
```

**What it plans for one box and one snapshot**, read live from the guest
and its storage, before anything changes, and changing nothing. Every
dialog, every tool call and every CLI command asks for a plan first, and
acts only on what it says:

```ts
interface SnapshotPlan {
  readonly storage: { readonly name: string; readonly type: string; readonly percentFull: number; readonly metadataPercentFull: number | null };
  readonly take: { readonly ok: boolean; readonly why: string | null; readonly aboutMs: number; readonly memoryAboutMs: number | null; readonly addsBytes: number | null };
  readonly restore: { readonly way: "rollback" | "rollback-newest-only" | "new-guest" | "none"; readonly why: string | null; readonly undo: "snapshot" | "held-copy" | "suspend-copy" | "none"; readonly undoAboutMs: number; readonly undoBytes: number | null; readonly sizeBack: BoxSize | null; readonly leavesOnEarlierGuest: number };
  readonly keep: { readonly way: KeepsPastRelease; readonly why: string | null; readonly aboutMs: number | null; readonly bytes: number | null; readonly price: Price | null };
  readonly fork: { readonly ok: boolean; readonly why: string | null; readonly aboutMs: number; readonly bytes: number | null };
  readonly locked: { readonly lock: string; readonly fix: string } | null;
}

planSnapshots?(guest: Guest, kind: string, snapshot: SnapshotRef | null, signal?: AbortSignal): Promise<SnapshotPlan>;
```

On Proxmox the plan is one call for the guest's config (its root disk's
storage, its lock, its size and its snapshots' sizes and parents) and one
for the storage's status, both of which the token can read; the storage's
type is read once when the backend starts. A time is the measured rate
times what this box holds: a memory snapshot "about 1 s per GiB of memory"
from the research's 3.7 s for 4 GiB, so a 16 GiB VM says "about 15 s".

The operations, each only where the plan says it can:

```ts
snapshot?(guest: Guest, take: SnapshotTake, signal?: AbortSignal): Promise<SnapshotTaken>;
restoreSnapshot?(guest: Guest, ref: SnapshotRef, step: RestoreStep, signal?: AbortSignal): Promise<RestoreProgress>;
forkSnapshot?(ref: SnapshotRef, box: BoxIdentity, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest>;
holdCopy?(source: SnapshotRef | Guest, label: HeldCopyLabel, step: HeldCopyStep, signal?: AbortSignal): Promise<HeldCopyProgress>;
adoptCopy?(copy: SnapshotRef, box: BoxIdentity, identity: GuestIdentity, signal?: AbortSignal): Promise<Guest>;
deleteSnapshot?(ref: SnapshotRef, signal?: AbortSignal): Promise<void>;
heldSnapshots?(signal?: AbortSignal): Promise<readonly HeldSnapshot[]>;
providerTask?(ref: TaskRef, signal?: AbortSignal): Promise<TaskOutcome>;
```

`restoreSnapshot` and `holdCopy` run one step at a time (section 6), so
bb-box records each before the next. `adoptCopy` makes a new guest from a
held copy for the same box, with the box's `GuestIdentity`: its MAC
addresses, and on QEMU its SMBIOS, so it stays the same machine (section
9). `providerTask` reads a provider's task by its reference (a Proxmox
UPID) after a restart.

#### A held copy

A held copy is a full clone made inert, used for two things: Keep past a
release (section 7) and the undo on ZFS (below). Proxmox's clone copies
`onboot`, the network settings and the disk, so a plain clone could start
by itself at the node's next boot as its source. Its steps, each recorded
before it runs, with its source (the snapshot, or the stopped guest) pinned
until the last is done:

1. **Clone** the source in full into a VMID from bb-box's range, in its
   pool, labelled as a held copy with the install, box, snapshot and keep
   date.
2. **Disarm**, in one config write: `onboot` 0, every network interface's
   link down, and on QEMU a new SMBIOS UUID.
3. **Make it a template.** A Proxmox template cannot start; it can still
   be cloned, in full or linked. The token's `VM.Allocate` on the pool
   allows the conversion, and `VM.Clone` the clones.

**A copy that is not yet a template is never trusted.** If bb-box restarts,
or the node boots, before step 3 is done, the copy may have started: its
identity reset would then have removed the saved credentials and access,
and its boot may have changed other files, so it no longer holds what it
copied. So the sweep's first act at start is to delete every held copy
that is not a template, and to make it again from its source, which is
still pinned. It never finishes or adopts such a copy. A held copy is made
only of a snapshot with `forkSafe`, so even a copy that does start resets
before its network, BB's daemon or Tailscale can start (section 9). G16
proves this, with a node reboot and a check of the remade copy's files.

**Cloning a held copy re-arms the clone.** A held copy is used only by
cloning it: a fork clones it as a new box (section 9); an undo clones it
for the same box with `adoptCopy`. Both inherit its disarm, so both set
`onboot` back and their links up, as the box they become needs, before
the first start. G4 and G14 check it.

#### Restore by storage, on Proxmox

Proxmox decides per storage whether a rollback may go past newer snapshots
(`volume_rollback_is_possible` in its storage plugins):

| Storage | Restore to | The undo | In the first units |
| --- | --- | --- | --- |
| LVM-thin, Ceph RBD, qcow2 files (directory, NFS, CIFS), BTRFS | any snapshot | a snapshot of the stopped guest, taken after the stop | LVM-thin, measured by the research; the others each once unit 3 has run its gate on one |
| ZFS | the newest snapshot only | a held copy of the stopped guest, which is not a snapshot and so does not block the rollback | off until G4 passes on a ZFS node: an older snapshot is never restored in place; "pve-3 uses ZFS, which restores only the newest snapshot. Fork this one, or delete the 2 newer ones yourself first." bb-box never deletes newer snapshots to make a rollback possible |
| LVM (thick, VMs only, a preview in Proxmox VE 9) | none | | the doctor says so |
| a directory of raw files | none: it takes no snapshots | | the doctor says so |

**The ZFS order.** Proxmox refuses a full clone of a running container
unless it is of a snapshot, and a new snapshot would block the rollback.
So on ZFS the restore stops the guest first, then copies it, then rolls
back:

1. stop the guest hard;
2. make the held copy of the stopped guest (about 9 s for each 4 GiB used,
   from the research's full clone; the dialog says the time and space);
3. roll back to the newest snapshot, and start.

If step 2 fails, bb-box starts the guest again as it was, the restore
stops with nothing changed, and it says so: the box was stopped for that
time. If bb-box restarts between steps, the operation (section 6) finishes
or reports it.

**Undoing a ZFS restore is a swap.** The undo is a held copy, so undoing
means `adoptCopy`: a full clone of the copy becomes the box's guest, with
the box's MAC addresses and SMBIOS, after the current guest has stopped. The
box keeps its ID, name, record, BB machine and host ID. Its other snapshots
stay where they are, on the guest it ran on until then, which becomes the
box's **earlier guest**:

- it is disarmed as step 2 of a held copy is, and its network interfaces
  also get new MAC addresses, so that if it is ever started, by hand, by
  Proxmox's high availability or by a fault, its identity marker no longer
  matches and its reset runs before its network (section 9); it is
  labelled as the box's earlier guest and never started by bb-box;
- its snapshots are listed under the box as "on amber-fox's earlier guest:
  fork only", with Fork, Keep and Delete, and no Restore;
- it is deleted when its last snapshot goes, and at the box's release,
  after held copies of its kept snapshots are made (section 7);
- the restore dialog says beforehand how many snapshots this leaves there
  ("3 snapshots stay on its earlier guest: fork only").

The same swap, with the box's identity passed on, is how microsandbox's and
boat's new-guest restores keep the box the same machine.

#### What each backend fills in

| Backend | `scope`, `holds` | `whileRunning` | `restore` | The undo | `fork` | `keepsPastRelease` | `price` | Unit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Proxmox LXC | box; disk | live (0.7 s) | in-place, after a hard stop; by storage, above | a snapshot after the stop, or a held copy on ZFS | copy (9.3 s for 4 GiB used) | held-copy | none | 1a, 2, 3, 7, 8 |
| Proxmox QEMU, Linux | box; disk, or disk and memory | live (1.1 s); memory about 1 s a GiB | in-place; by storage | as LXC | copy (6.5 s) | held-copy, disk only | none | 1b, 2, 3, 7, 8 |
| Proxmox QEMU, Windows | box; disk | live | in-place; by storage | as LXC | none until a unit builds Windows' reset | no: with no fork, a kept copy could not be used | none | 3 |
| Tart, macOS | box; disk and memory only | suspends (about 7 s, then resumes) | in-place: puts a copy back, then resumes (11 s) | a copy of the suspended VM, memory included | copy from the disk, new MAC address, once unit 9 builds macOS's reset | as-is, once forks are built: the copy stays on the VMs' volume, holding its whole size once the VM is deleted | none | 9 |
| Tart, Linux | box; disk | stopped-only | in-place | a copy, after the stop | copy | as-is | none | 9 |
| microsandbox | box; disk with the box's Docker disk, or disk and memory; none on a box whose Docker disk is a file of the host's | pauses (0.3 s; memory 1.5 s) | new-guest (3.9 s), a swap | a snapshot of the stopped box (decided during unit 10) | copy: the snapshot's disk restored as a new sandbox; never `msb fork`, which copies memory | as-is: a snapshot outlives its sandbox (confirmed in unit 10) | none | 10 |
| boat.dev, paid plan | box; disk | live; `capturedAt` is the fresh capture a saved snapshot makes | new-guest, a swap | a saved snapshot of the stopped sandbox (decided during unit 11) | copy, from unit 11b | as-is, from unit 11b | $0.056 a day past the plan's | 11, 11b |
| boat.dev, trial | box; disk | | none: no saved snapshots on the trial, and a stopped fork's capture can be a minute old, so it cannot be an exact undo | | copy, of the newest capture | no | | 11 |
| Docker on a host of the person's | box; disk, with the box's own Docker volume, both captured while the container is paused | pauses (15 s for 1 GiB changed) | new-guest, a swap | a snapshot | copy | as-is | none | 12 |
| Hetzner, Namespace Linux | box; as Docker | pauses | new-guest, a swap | a snapshot | copy | no: Hetzner deletes a host with no boxes, and Namespace an instance at release | none | 12 |
| Android emulator (in its box) | device; the device's disk and memory | live (14.8 s) | in-place, the device only (3.2 s) | a device snapshot | none | no | none | 13 |
| SSH host pool, iOS slots, Namespace macOS | none | | | | | | | none |

Never on a shared host to act on one slot: no snapshot or restore of a
whole Mac or Hetzner host stands in for one box's.

### 3. Who may do what

One permission check, `mayAct(caller, operation, snapshot or box)`, serves
every tool, RPC, CLI command, picture and bulk action, using the caller's
thread from BB's tool context, never a parameter. It is tested with guessed
IDs and calls across threads.

| Box | Owner of its snapshots | Take | See | Restore | Fork | Delete | Keep |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A thread's box that the thread does not run on | the thread | its agent; the person | its agent; the person | its agent, without asking, with an undo; the person | its agent, into its thread; the person | its agent, only what an agent of its thread took and nobody kept; the person | the person |
| The box a thread runs on: its own new box (033), another thread's box, or one of the person's machines (036) | the box's thread, or the person | that thread's agent | that agent, only what it took there | the person, from the box's page; or its agent through a form in the thread, on a yes given in the thread; always with an undo; both off until G17 passes (section 5) | the person | that agent, only what it took there and nobody kept; the person | the person |
| A kept snapshot | the person, from the moment it is kept | | the person; the thread's agent while its box lives, without its picture | the person | the person, as a machine of theirs | the person | the person |

- No thread sees another thread's snapshots in anything an agent can
  read. A refusal for room names only the snapshots the caller may see,
  and says "and others you cannot see" for the rest.
- The CLI is the person's tool and a trusted way around these rules, as
  `bb box stop` is today: bb-box cannot tell who typed a command, and an
  agent can run it. The note claims isolation between threads, not against
  the CLI or BB's own command line.
- Projects own none in the first units: a state shared across a project's
  threads is what a project's image is for (049).

### 4. The agent's tools, the CLI and the box log

#### Tools

| Tool | Parameters | Does | Answers |
| --- | --- | --- | --- |
| `box_snapshot` | `box`, `name`, `note`, `memory` (default false) | takes one; on a Tart macOS box, where every snapshot holds memory, refuses `memory` false and says to pass true | its name and ID, what it holds and leaves out, its size where known, how long it took, its price if any, and "3 of 5 for this box" |
| `box_snapshots` | `box` (optional), `pictures` (default false) | lists a box's, or every box's of the thread, that the thread may see | per box, what its snapshots hold or that it has none; per snapshot: name, ID, when, by, holds, size, price, kept, which guest; pictures as images only when asked |
| `box_restore` | `box`, `snapshot`, `replace` (must be true), `request` (an ID the agent makes, so a repeat is the same restore) | restores the box, as section 5 says. An undo is always taken: there is no way for an agent to restore without one | what it replaced, the undo's name, whether processes ended, size changes, and the box's state. On a box threads run on: the waiting notice of the form |
| `box_fork` | `snapshot` or `box` (the box now), `name` | a new box of the thread from a snapshot, or from the box now, for which it takes a snapshot first, named "for a fork" | the new box, as `box_acquire` answers, and "forked from amber-fox at 10:42" |
| `box_snapshot_delete` | `box`, `snapshot` | deletes one the thread may delete | what it freed, where known |

`snapshot` takes a snapshot's name or ID. A tool never keeps a snapshot.
Five tools is three more than the smallest set; they stay apart because
each says one thing an agent does, as `box_stop` and `box_start` do, and
the owner can ask for fewer.

The skill tells the agent: take one before a change it cannot undo, such
as a migration, an upgrade, a deletion or a change to the system; take one
when the person asks; never on a schedule of its own; restore when an
attempt went wrong rather than undoing by hand; delete its own when they
are no longer needed; on a box threads run on, the box it runs on or one
of the person's machines, ask through the form and end its turn; and
never answer one of bb-box's forms, with `bb thread interactions` or any
other way.

#### The CLI

For the person and their scripts, as `bb box stop` is:

```
bb box snapshot take <box> [--name <name>] [--note <text>] [--memory]
bb box snapshot list [<box>] [--kept] [--json]
bb box snapshot delete <box> <snapshot>
bb box snapshot restore <box> <snapshot> --replace [--no-undo] [--force]
bb box snapshot fork <box> <snapshot> [--as-machine] [--name <name>] [--check]
bb box snapshot keep <box> <snapshot> [--days <n> | --until <date>]
bb box snapshot unkeep <box> <snapshot>
bb box snapshot rename <box> <snapshot> <name>
bb box snapshot note <box> <snapshot> <text>
```

`take`, `list` and `delete` come in unit 1a, so it can be checked live
before any page; the rest come with their units. `--machine <name>` names
one of the person's machines. `--force` restores while threads work on the
box, and `--no-undo` without an undo: both are the person's, as the
dialog's "Restore anyway" and its unticked undo are. The box log records
these as "a bb box command".

#### The box log

`BOX_EVENT_KINDS` gains:

| Kind | Words | Notes |
| --- | --- | --- |
| `snapshot-taken` | its name, ID, what it holds, how long | |
| `snapshot-failed` | its name, the backend's words | |
| `restore-asked` | the snapshot, the undo's name or "no undo", what the guard named | with "on a yes given in (thread)" for a form; never "your yes" while BB cannot say who answered (request 38) |
| `restored` | the snapshot, the time it went back to, size changes, snapshots left on an earlier guest | a Proxmox rollback leaves no stop in the log; this event is what the box's page shows |
| `restore-failed` | the step it stopped at, the backend's words, and what bb-box then observed | as 069's G6 |
| `restored-outside`, `restore-outside-failed`, `restore-outside-running` | the provider's task, its user, time and status | only from a provider's task record (below) |
| `fork-asked`, `forked`, `fork-failed` | the source and the new box | the new box's own log starts with `made`, from the source's snapshot |
| `snapshot-deleted` | its name, what it freed, why | why: by you, by the agent, the per-box limit, the host's storage nearly full, its keep ended, its box released, the last on an earlier guest |
| `snapshot-kept`, `snapshot-unkept` | until when | by the person only |
| `snapshot-lost`, `snapshot-unavailable` | its name, the backend's words | |
| `held-copy-made`, `held-copy-started` | the copy, and for the second the node boot that started it and what bb-box then did | `held-copy-started` should never appear; G16 |

The box log is bounded and pruned (069). What must last, a restore's undo
and a yes given in a form, is also kept on the operation (section 6) for as
long as its snapshots live, and 30 days after.

**Restores made outside bb-box.** A changed Proxmox `parent` does not
prove a restore. So bb-box reads the node's task list at each sweep, which
the token's `Sys.Audit` on the node allows. A `vzrollback` or `qmrollback`
task on the box's VMID that bb-box did not start is logged by its status:
`restored-outside` only when it ended OK, then the box is set straight as
step 9 of a restore does; `restore-outside-failed` when it failed, with a
check of the guest; `restore-outside-running` while it runs, checked again
at the next sweep. Without such a task bb-box claims nothing; a changed
parent alone is logged as "its snapshots changed outside bb-box", with no
repair.

### 5. A restore says everything it loses, and takes an undo first

#### Who restores, and how

- **An agent, on a box of its thread that its thread does not run on**:
  without asking the person, with `replace: true`. The undo is always
  taken; if it cannot be, the restore is refused. When Settings turns
  "Agents may restore their own boxes" off, the agent asks through the
  form below instead.
- **A box threads run on, an execution machine** (the box an agent's
  thread runs on, another thread's box it runs on, or one of the person's
  machines), as the owner decided on 30 October 2026, two ways:
  - **the person, from the box's page**;
  - **an agent, through the form**: never by itself, as its own worktree
    and session are on that disk. `box_restore` opens a form in the thread
    with `bb.ui.requestInput` and answers at once: "I asked you to restore
    dev-desk to 'before the upgrade'. End your turn now: nothing you do on
    dev-desk after this survives the restore." The restore runs on a yes
    given in the thread, and is recorded as that.

  Either way **an undo is always taken**: the dialog's undo cannot be
  unticked, and if no undo can be taken the restore is refused. Both ship
  off until G17 passes (below).
- **The person**, from a box's page or the Snapshots tab, through the
  restore dialog.

**The form, and what it is not.** The form serves two cases: an agent's
restore of an execution machine, and of a box of its own when Settings
turns "Agents may restore their own boxes" off. It is answered in BB's
app, and also by BB's command line, which the asking agent can run;
bb-box cannot tell which (request 38). So the form, its result and the box
log say "a yes given in the thread", never "your yes"; the skill tells
agents never to answer bb-box's forms; and G11 runs `bb thread
interactions respond --self` from the asking agent and records what bb-box
logs. When request 38 is met, the record names who answered: the person in
the app, or the command line and its thread.

**What a yes in the form does.** The approval is bound to the plan it
showed: the box, the snapshot, the box's guest generation and the list of
what goes. On a yes, bb-box runs the restore as its own operation, not
under the tool call, whose signal a stop of the thread aborts. If the plan
has changed by the time it runs (another thread, a terminal, a new
snapshot target), it restores nothing and opens the form again with the
new list. The tool's result reaches the asking thread as a message, which
on an execution machine starts a turn on the restored box, whose session
files went back too: the form says so. A timeout, a stop of the thread or
a restart of BB's server cancels the form and nothing happens.

**Holding turns on the box (admission).** A restore of a box threads run
on, an execution machine, is a restore of their working disk, so no turn
may start on it while it runs. So
bb-box holds every turn for a thread on the box with the SDK's
`message.dispatch` hook, from the person's confirmation, in the dialog or
the form, until the box is ready again. Two things can let a turn through:

- BB's "Send now" bypasses the hook. bb-box checks for a running turn
  before each step that changes the box, the stop first, and stops the
  restore with nothing more changed if it finds one. A check is not atomic
  with the step after it, so a turn sent in that moment, or while the box
  reconnects to BB after the restore, can still start.
- A held turn is released by BB's orphan sweep if bb-box stops, as at an
  update. When the operation resumes after a restart, bb-box holds the
  turns again and checks for a running turn before its next step.

A box threads run on is restored from disk snapshots only: a memory
restore would bring back BB's daemon mid-session.

**Restores of execution machines ship off.** They stay off, on the page,
through the form and in the CLI, until G17 passes with "Send now" injected
after the final check and during the box's reconnection, and a bb-box
restart mid-restore. Until then the person restores such a box only after
moving its threads off it, when it is no longer an execution machine.
Restores of a thread's other boxes, which no thread runs on, are not
affected.

#### What a restore does, in order

1. **Plans** (section 2). Refuses what the plan refuses: a snapshot that is
   not `ready`, one on an earlier guest, a snapshot of another box (it is
   forked instead), a target ZFS cannot roll back to, a box that is
   stopping, starting, restoring, being resized or released, a box whose
   snapshot is being taken or whose target is being deleted, a guest
   Proxmox has locked (with the words of
   [section 6](#6-every-change-is-an-operation-recorded-before-it-starts)).
2. **Guards everything it would lose.** A restore rolls back the whole
   disk, so it reads what is on it now, from `threadsOn`, not `checkInUse`:
   - every thread, working or idle, with a workspace on the box's BB
     machine: its worktree, its uncommitted files and its agent's session
     files go;
   - a person holding the desktop's control, as `checkRestart` checks;
   - BB terminals open on the box.

   An agent's restore is refused while any of these is so, except its own
   thread's workspace on a box its thread does not run on. The person's
   dialog names them all, and goes on only with "Restore anyway".
3. **Pins** the target and records the operation (section 6); for a box
   threads run on, starts holding their turns.
4. **Admits the undo**: its space and, on a paid provider, its price are
   reserved against the room rule and the ceiling (section 8) before
   anything stops. If either refuses, an agent's restore is refused; the
   person is told which, with its own fix (for room, the snapshots on that
   storage that deleting would free it; for price, the ceiling in
   Settings), and can untick the undo instead, except on an execution
   machine, which is never restored without one.
5. **Captures the undo**, in the order the backend's capture needs (table
   below), so it holds exactly what the restore replaces. It is named
   "before the restore at 11:02", with " (2)" if that name is taken. Until
   it is `ready`, nothing else changes. If it cannot be taken, bb-box
   brings the box back as it was, and the restore stops and says why. Only
   the person can restore without an undo, by unticking it, which turns the
   button red, and never on an execution machine.
6. **Logs** `restore-asked`, then **restores**: Proxmox rolls back; a
   new-guest restore or an undo by held copy makes the new guest with the
   box's identity (`adoptCopy`), while the old guest stays stopped, then
   swaps the record's guest in one write.
7. **Starts** the guest, or resumes it for a memory snapshot.
8. **Reads the size back** from the guest, as `resize` does: a snapshot
   holds the guest's cores and memory as they were, and the dialog said so
   beforehand ("amber-fox goes back to 4 cores and 8 GiB memory, as it was
   then"). A restore to a snapshot from before the disk was grown is
   refused until unit 3 has measured what Proxmox does with the file
   system.
9. **Sets the box straight**, before it says ready:
   - writes the access file from the thread's current access, `env` on
     Linux and macOS and `env.ps1` on Windows, over SSH, as bb-box's first
     command once the box answers, before bootstrap or anything else bb-box
     runs;
   - writes the box's labels again (Proxmox tags and description, which a
     rollback puts back as they were), as a relabel does (036);
   - clears BB's daemon lock and PID (017) and waits for the BB machine to
     come back, as `box_start` does; it is the same machine, with the same
     host ID;
   - joins the tailnet again if its node is gone (050).
10. **Logs** `restored`, stops holding turns, and answers.

The capture order, per backend:

| Backend | Before the undo | The undo | Then |
| --- | --- | --- | --- |
| Proxmox LXC and QEMU, not ZFS | a hard stop (bb-box's own, 1.3 s; `pct rollback` on a running container shut it down for 45 s), after checking no turn runs | a snapshot of the stopped guest | rollback, start |
| Proxmox on ZFS | the same stop | a held copy of the stopped guest | rollback to the newest, start |
| Tart, macOS | a suspend, which saves memory; never a hard stop | an APFS copy of the suspended VM, memory included | put the target's copy back, resume |
| Tart, Linux | a shutdown, as its snapshots are stopped-only | an APFS copy | put the target's copy back, start |
| microsandbox, boat, Docker | none: the box keeps running while its undo is taken (a pause for microsandbox and Docker; a fresh capture for boat) | a snapshot of the running box | stop the old guest, start the new one with the box's identity, swap |
| Android device | none: the host box keeps running; the device pauses while its state saves | a device snapshot | load the target on the device |

A device restore puts back the device only, so its guard and its dialog
name what the device loses (the apps open on it since, their state), not
the box's worktrees, sessions or terminals, which it does not touch.

What this does not do, and the dialog says so:

- A restore brings back what was saved on the disk, not what the box did
  to the world since (a push, a message, an upload). On Proxmox and Tart
  the undo is taken after the stop or suspend, so nothing written before
  the restore is in neither; on microsandbox, boat and Docker, what the box
  writes between its undo and the old guest's stop, about a second, is.
- A memory restore brings back running processes as they were, with the
  credentials they held then and their connections, as a Tart resume does
  today. bb-box cannot change a running process's environment. A token
  revoked since is refused upstream; one still valid upstream works in
  those processes. Settings can limit memory restores to the person, and a
  box threads run on is never restored from memory.
- Processes the work itself starts at the box's boot may read the old
  access file before bb-box rewrites it. Starting the box with its network
  down and writing the file first needs a way into the guest without a
  network: on QEMU, the guest agent in every image and
  `VM.GuestAgent.FileWrite` on the token; on LXC, nothing the token can use.
  That is left for a later unit, for QEMU only.

#### The person's restore dialog

```
Restore amber-fox to "before the migration"?

It goes back to yesterday at 23:39, 2 h 5 min ago. Everything on its disk
since then goes: files, installed apps and settings. amber-fox restarts,
so every process in it ends. What it did to the world since stays done.

Also goes:
  · Fix the sign-in flow is working on amber-fox: its worktree, uncommitted
    files and session there go.
  · Write the API guide is idle on amber-fox: the same.
  · You have control of its desktop.
  · A terminal is open on it.
amber-fox goes back to 4 cores and 8 GiB memory, as it was then.

[x] Take a snapshot of it, once stopped, so you can undo this. About 1 s.
    Named "before the restore at 01:56". Undos do not count against the 5.

                                   [Cancel]  [Restore amber-fox anyway]
```

- On ZFS the undo line says "Copy amber-fox once stopped, so you can undo
  this: about 20 s and 9 GB on pve-3", and the dialog says what an undo of
  it would do: "Undoing this makes a new guest from that copy; the 3
  snapshots on its current guest stay there, fork only."
- A memory target says "amber-fox comes back running, as it was then, with
  the credentials its apps held then. Undo brings back its files, not its
  running apps."
- What the backend leaves out ("It leaves out /tmp, caches and SSH host
  keys") is said where there is any.
- The button says "Restore amber-fox" when nothing more goes, "Restore
  amber-fox anyway" when the list is not empty, and "Restore without undo",
  in red, when the undo is unticked.
- After a restore, the box's page shows a notice for 24 hours: "Restored at
  11:02 to 'before the migration', taken yesterday at 23:39, by you. Undo
  restores 'before the restore at 11:02'." Undo opens the same dialog for
  the undo. A toast says it once only when the person is not on the box's
  page.

### 6. Every change is an operation, recorded before it starts

Take, restore, fork, delete, a held copy, an adoption and expiry are
operations. Each is a row in `snapshots.db` before anything changes, as a
resize is a `ResizeRecord`:

| Field | Notes |
| --- | --- |
| `id` | `op` and 12 letters and digits; a tool's `request`, or the dialog's, makes a repeat return the same operation |
| `kind`, `box`, `generation`, `snapshots` | the box's guest generation it was planned on; the snapshots it uses are pinned |
| `by`, `consent` | the actor; for a form, the yes given in the thread, its time and the plan it showed |
| `undo` | the undo's snapshot ID, once taken |
| `guests` | the old and the new guest of a swap or a held copy |
| `step`, `task` | the step it is at, and the provider's task reference (a Proxmox UPID) |
| `state` | `running`, `done`, `failed`, or `unknown` until bb-box has observed the outcome |
| `reserved` | the storage and the price it reserved (section 8) |

- **One eligibility check, at the moment of the change.** Whether a
  snapshot may be deleted, expired, evicted by the limit or the room
  sweep, replaced as an undo, kept, unkept or renamed is one function,
  `eligible(snapshot, change)`. It refuses a pinned snapshot for every one
  of those, and a kept or the person's snapshot for every automatic
  deletion. It is called when the change is made, on the box's `#chain`,
  not when it is chosen: a sweep that picked its candidates a moment
  earlier checks each again before deleting it, so a snapshot that became
  a restore's target or was kept meanwhile stays. Every path uses it: a
  row, a menu, a dialog already open when the pin began, a bulk action,
  the CLI, the sweep and the limit. Bulk actions skip what it refuses and
  say which, and why.
- **Pins end with their operation.** An operation's pins (its target, its
  undo, a fork's source, a held copy's source) are released together when
  it is `done` or `failed`, including when Check now settles one cut short
  by a restart.
- **One at a time per box.** Every snapshot operation runs on the box's
  `#chain` with its start, stop, resize and release. A release waits for a
  take that is running, then deletes what it made. Two takes on one box
  run one after the other. A restore waits for a take, and refuses while
  its target is deleting. A fork pins its source.
- **After a restart.** At start, the sweep's `#snapshotsCutShort` reads
  every operation not `done` or `failed`, asks the provider's task where it
  has one, observes the guests, and finishes it from the step it reached
  or marks it `failed` with what it found: a held copy that is not yet a
  template is deleted and made again from its source, which is still
  pinned, and never finished or adopted (section 2); a swap cut short keeps the guest the
  record names and stops the other; neither guest is released as a
  leftover until the operation is settled. What cannot be confirmed stays
  `unknown`, and the box's page says "bb-box could not confirm the restore
  of amber-fox: it was rolling back when bb-box restarted", with Check now.
- **A locked guest.** Proxmox can leave a guest locked (`snapshot`,
  `rollback`, `backup`, `clone`) when a task dies, and only root can unlock
  it. bb-box refuses the operation with the lock and the command for the
  host, "Run `pct unlock 214` on pve-1", on the page, in the tool's answer
  and in the doctor; a box left stopped and locked stays stopped until
  then.
- **Room and money are reserved**, for every box at once, in one
  transaction on `snapshots.db`, so two takes cannot both use the last of a
  host's room or the ceiling.

### 7. Keep, and what it costs on each backend

The person keeps a snapshot for 30 days from the day they keep it
(Settings can change the 30), or until a date they choose. A kept snapshot
is the person's at once; no agent can delete it. It outlives its box's
release, listed under its box marked released, and can be forked into a
new machine of the person's. bb-box deletes it at its date; from 3 days
before, its row says "goes in 3 days" in amber and the tab's line counts
it. "Keep 30 more days" renews it.

**Keep only what can be used after the release.** After a release the
only way to use a kept snapshot is to fork it. So Keep is offered for a
snapshot only when its fork plan is `ok`: its box forks (not Windows,
not macOS until unit 9), and it was taken with `forkSafe`. Otherwise Keep is
disabled with why: "Taken before brisk-lake's image had the identity reset:
it could not be forked after a release." The Keep dialog says what keeping
costs on that backend before the person confirms:

| Backend | How a kept snapshot outlives the release | What Keep costs |
| --- | --- | --- |
| Proxmox LXC and QEMU | **A held copy** (section 2), made at the release before the guest is deleted. A memory snapshot's copy holds the disk only, and its row says "disk" from the release on | At the release: about 9 s for each 4 GiB used, and the snapshot's used disk in space (the dialog says "13 GB on pve-1"), plus a VMID from bb-box's range, until the keep date |
| Tart | As is: the snapshot's folder stays beside the VMs; bb-box deletes the VM only | Nothing at the release; then its whole size, up to the VM's disk, as APFS no longer shares its blocks |
| microsandbox | As is: a snapshot outlives its sandbox, on the host (confirmed in unit 10); its keep date is a file of bb-box's beside `msb`'s snapshots | its whole size on the host, until the keep date |
| boat.dev, paid | As is: a saved snapshot never expires | its daily price, until the keep date |
| Docker on a host of the person's | As is: the commit and the volume's copy stay on the host | their size |
| Windows, boat.dev trial, Hetzner, Namespace, Android devices | **No Keep.** No fork on Windows yet; a stopped fork lasts 14 days; a Hetzner host and a Namespace instance go when their boxes go; a device snapshot lives in the box | |

- **Keep is confirmed only when it will last.** A release of a box with
  kept snapshots first makes each held copy, its earlier guest's included,
  and does not delete the guest until every copy is a template. If a copy
  fails, the release stops as "Release did not finish: bb-box could not
  copy 'Thu 09:15' (pve-1 has 6 GB free, and it needs 13 GB)", with Release
  again and "Release and delete it". Nothing kept is ever deleted without
  the person's word, and 30 days is never silently shortened.
- **A held copy needs room and a VMID.** The plan checks both when the
  person keeps a snapshot, and the Keep dialog warns if, at today's size,
  there would not be room.
- **Paid Keep is within the ceiling.** Keeping or renewing a paid snapshot
  is refused while the rate held is past the ceiling (section 8), and the
  dialog says so; bulk Keep shows the same words for each.

### 8. Limits, room and cost

- **Per box: 5 snapshots, undos apart.** Kept ones count. Undos do not:
  each box has room for 2 undos of its own besides. A kept undo is an
  ordinary kept snapshot: it counts in the 5 and is no longer replaced as
  an undo.
- **An undo is admitted like any snapshot.** Its space and, on a paid
  provider, its price are reserved before the box stops (section 5, step
  4), so a restore's undo can never pass the room rule or the ceiling.
- **A new undo replaces an old one only when it may.** It replaces the
  oldest undo that is not kept, not pinned and not the target of a running
  operation, once the new one is `ready`. If no undo may go, the box holds
  a third until the restore ends, then the oldest that may go goes. So the
  default never forces a restore without undo, and never deletes a
  restore's target.
- **What the limit never deletes**: a restore's or a fork's target, an
  undo, a snapshot in use by an operation, a kept snapshot, the person's.
  When an agent takes a sixth, the oldest that an agent of the same thread
  took and nobody kept is deleted, once the new one is `ready`; on a box
  shared by threads, never another thread's. When none qualifies, or the
  person takes a sixth, the take is refused with what to delete.
- **Room on each host, at the take.** A take is refused when the plan's
  storage is more than 85% full, or would be by the snapshot's expected
  size (a memory snapshot's is the box's memory), or its thin metadata is
  more than 80% full.
- **Room on each host, afterwards.** On LVM-thin and ZFS a snapshot shares
  the box's blocks, so it grows as the box changes, and a full thin pool
  puts every guest on the node into I/O errors. The sweep reads each
  storage's data and metadata use through the plan. Past 85%, takes are
  refused and the tab and box pages warn. Past 92%, bb-box deletes agents'
  snapshots on that storage that nobody kept, oldest first, never one of
  the kinds above, and logs "by bb-box: pve-1's storage was 93% full".
- **Cost: the ceiling bounds the monthly rate of what is held.** Where a
  provider charges, every row says the price. The ceiling is a setting the
  person sets, one per provider and account, in its currency, with a
  default of $5 a month, as the owner decided on 30 October 2026. It sits
  in Settings, BB Box, Snapshots, under "Paid snapshots", one row per
  provider that charges ("boat.dev, this install's account"), with the
  rate held and this month's spend beside it. It is an admission limit on
  the rate, not a cap on the bill:
  - the rate is every paid snapshot held, kept or not, undos and held
    copies included, times its daily price, times 30;
  - a take, an undo, a Keep, a renewal and a held copy are refused when
    the rate would be past the ceiling after it. The refusal says: "It
    would bring snapshots held on boat.dev to about $5.04 a month, past
    your ceiling of $5.00. Delete one, or raise the ceiling in Settings,
    Snapshots, Paid snapshots." An agent's tool answers the same words;
  - when the rate passes the ceiling without a take (a lower ceiling, a
    price or a plan that changed), bb-box refuses new paid snapshots, Keep
    and renewals, and warns on the tab and in Settings; it never deletes
    kept data to get under it;
  - this month's spend so far is a ledger that keeps deleted snapshots'
    charges, shown beside the rate;
  - a price bb-box does not know is shown as unknown and admitted only by
    the person;
  - paid snapshots stay off until a live check on a real paid plan passes
    (unit 11). A fake priced backend proves the arithmetic only.

### 9. A fork is a new box with a new identity

- **What it is**: a new box from a snapshot or a held copy, of the same
  kind and at least the same size, on the same host or account, with a new
  name and box ID. An agent forks into its own thread; the person forks
  into the box's thread or as a machine of their own. A kept snapshot of a
  released box forks as a machine of the person's. Forks into another
  thread, chosen by the person, are later.
- **It starts from the disk.** A fork never uses saved memory, which holds
  the source's processes, tokens and identity: a memory snapshot forks
  from its disk, microsandbox forks from a disk snapshot, and `msb fork`
  is never used.
- **It never acts as its source.** At its first boot, before its network,
  BB's daemon, Tailscale, SSH and the box user's session can start, the
  guest removes its source's identity, as 017 removes the daemon's lock:

  | Removed or made new | Where |
  | --- | --- |
  | BB's machine credentials and host ID | the daemon's folder under `~/.bb-machines/` |
  | The thread's access | `~/.config/bb-box/env`, or `env.ps1` on Windows |
  | The tailnet node | Tailscale's state |
  | SSH host keys | made new |
  | Machine ID | made new |
  | bb-box's authorized key | the fork's own |

  On Linux this is a systemd unit ordered `Before=` `network-pre.target`,
  `ssh.service`, `tailscaled.service` and `user@.service`.
- **How a guest knows it is a fork: an identity marker that bb-box writes
  and checks.** bb-box writes `/etc/bb-box/identity` over SSH when a box
  is first ready and after each reset: the box's ID, and the MAC addresses
  of the interfaces its backend gives it, and no others. On Proxmox LXC
  those are the `ethN` interfaces of its `netN` settings; on QEMU and Tart,
  the interfaces with a device under `/sys/class/net/<name>/device`.
  Interfaces the box makes for itself, `docker0`, `br-*`, `veth*` and
  `tailscale0`, are never written or compared: they do not exist yet when
  the unit runs, before `network-pre.target`. At each boot the unit
  compares that same set's MAC addresses with the marker's. If they differ,
  or the marker is missing or unreadable, it resets, failing closed. The
  MAC address is the value because of what changes it:

  | Event | MAC addresses | So |
  | --- | --- | --- |
  | A fork, a held copy, any Proxmox clone (LXC and QEMU) or `tart clone` | new: the provider gives a clone new ones | the reset runs |
  | A restart, a stop and start, a resize, a rename by `relabel` or a spare claimed (036) | unchanged | no reset; a renamed box keeps its BB machine |
  | A same-box swap: an undo by held copy, microsandbox's and boat's new-guest restores | set by bb-box to the box's own on the new guest (`adoptCopy`), with the old guest stopped first | no reset; the box stays the same BB machine and host ID |
  | The old guest of a swap, kept as an earlier guest | made new by bb-box when it is disarmed | the reset runs if it is ever started |
  | Docker inside the box, joining the tailnet | the backend's interfaces unchanged; the box's own interfaces are not compared | no reset |
  | microsandbox, boat, Docker | a value bb-box sets on each guest in place of a MAC address, passed on in a same-box swap | as above |

  A fork's name does not matter, so a fork given its source's name still
  resets. On first contact with a fork, bb-box checks that the marker is
  gone or names the fork's MAC addresses, that each item of the table is
  new or gone, and only then writes the fork's own marker and says it is
  ready. Windows and macOS have no such unit in the first units, so no
  fork.
- **Per snapshot, not per kind.** The unit is in a box's image, so a box
  made from an older template has none. bb-box reads the unit's version
  from the guest at each take and keeps it on the snapshot as `forkSafe`.
  A snapshot without it neither forks nor is kept, and says "Taken before
  amber-fox's image had the identity reset".
- **Then it enrols** under its own box ID as a new BB machine, and gets its
  thread's access, or the person's.
- **What a fork still holds**: everything else on the disk. A project's
  secrets, a signed-in browser, a keychain and cloud credentials in files
  come with it. A fork is a new BB identity, not a cleaned box, and the
  Fork dialog says so.
- **It records where it came from**: its page's facts say "Forked from
  amber-fox, 'before the migration' (yesterday 23:39)". Either can be
  released alone.

### 10. A picture of the screen

Each snapshot keeps a small picture of the box's screen around the take,
so snapshots of one box are told apart by sight, not by time alone.

| Box | How it is taken | Kept |
| --- | --- | --- |
| A desktop | the viewer's last frame, if a viewer was open within the last 10 s; otherwise a screenshot through Cua Driver, as `computer_screenshot` takes one | a JPEG 320 px wide, quality 70, about 15 to 30 KB |
| A device (iOS, Android) | the device server's screenshot, as `computer_observe` takes one | the same, at the device's shape |
| A headless box | none, and the row has no tile | |

- **When**: just before the take, so it shows about what the snapshot
  holds, and before a memory snapshot pauses or suspends the box. An
  undo's picture is from before the stop. It is labelled "the screen
  around 10:42", never as proof of what was saved. It waits at most 2 s; a
  picture that fails or is late never fails or slows the snapshot.
- **Where**: in `snapshots.db`, in its own table, never on the provider and
  never in the box. Deleted with the snapshot.
- **Who sees it**: the person, and the agent of the thread that owns it,
  only when it asks with `pictures: true`. Never in a notification, a log,
  the Monitor or a toast. Served by bb-box's RPC to its own app, through
  `mayAct`, not by a URL.
- **What it may show**: whatever was on the screen. Settings has a switch,
  "Keep a picture of the screen with each snapshot", on by default.
- **On the page**: 64 by 40 px in a row, a 1 px border and a 6 px radius. A
  click opens it at its full 320 px in a popover. Its `alt` is
  "amber-fox's screen around 10:42".

### 11. Security

What a snapshot holds, from the code (the research's
[Security](../research/box-snapshots.md#security) has the paths): the
thread's access in the env file, `GH_TOKEN` among it; BB's machine
credentials; a tailnet node; SSH host keys and the machine ID; in a memory
snapshot, every process's environment and whatever was typed; and whatever
the work put there.

So:

1. A snapshot is as secret as its box: section 3 says who sees it.
2. A restore writes the thread's current access over SSH as bb-box's first
   command (section 5, step 9). A memory restore cannot reach running
   processes, and says so; processes started at boot may read the old file
   first.
3. A fork drops its source's identity before its network starts, and only
   from a snapshot with the identity reset (section 9).
4. A held copy and an earlier guest cannot start by themselves: a held copy
   is a template, and both are disarmed (section 2). The Snapshots tab says
   a kept snapshot holds "files and access from the thread". A fork of it
   gets the person's access, never the old thread's.
5. Memory snapshots are by choice (question 2), except on a Tart macOS box,
   where every snapshot holds memory and the dialog says so.
6. Nothing is shared through a provider: boat's share codes and an
   organisation's shared snapshots are not used.
7. Pictures are as secret as their snapshot, and can be turned off.
8. Labels on the provider carry IDs and dates only.
9. No agent restores a machine threads run on by itself: only through the
   form, with an undo always taken. Its yes is recorded as given in the
   thread, not as proof of who gave it, until BB can say (request 38); then
   the record names who answered.

### 12. The pages

#### The Snapshots tab, on the Boxes page

A third tab, after Machines and Threads, with its count. Its path is
`/plugins/bb-box/desktop/snapshots`, as `threads` and `machines` are, and
it keeps its search, filters, sort and scroll as 069's G9 keeps the list's.

```
Machines 2   Threads 7   Snapshots 14                           [⚙] [+ New box]
14 snapshots and 1 undo, 9 by agents · 38 GB on 3 hosts · boat.dev $3.36 a month held
● 1 goes within 7 days · 1 take failed · pve-2 cannot take snapshots

[Search snapshots                           ] [Filters] [Sort] [Select]

┌ amber-fox  Linux  Desktop  LXC · Proxmox LXC on pve-1 · Fix the sign-in flow ↗ ┐
│ [pic] before the migration                                                     │
│       Yesterday 23:39 · by the agent · disk · 1.2 GB · goes with the box       │
│ [pic] Thu 09:15  Kept                                         ⟲   ⑂   ⋯        │
│       kept until 29 Nov · Thu 09:15 · by you · disk · 3.4 GB      (hovered)    │
└────────────────────────────────────────────────────────────────────────────────┘
┌ grey-ridge  Linux · Proxmox LXC on pve-1 · released 12 Oct                     ┐
│ release candidate set-up  Kept                                                 │
│ goes in 3 days · 12 Oct · by you · disk · held copy, 13 GB on pve-1           │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **The line under the tabs** says the count, undos apart, how many by
  agents, the space by host where known, and for each paid provider its
  monthly rate held. What needs the person comes first, in amber: keeps
  that end within 7 days, failed takes, hosts that cannot take snapshots,
  storage past 85%, a rate past its ceiling.
- **Grouped by box**, in hairline cards as the Threads tab's. The card's
  head names the box (a link to its page), its kind badges, where it lives,
  and its thread (a chip that opens it) or "Your machine". A released box's
  head says "released 12 Oct".
- **A row**: the picture, for a box with a screen; the name, with badges
  for `Memory`, `Kept` and `Undo`; then one line. What needs attention
  comes first: a failure, `unavailable`, a keep ending within 3 days in
  amber, or "on amber-fox's earlier guest: fork only". Then when, by whom,
  what it holds ("device" for a device snapshot), its size where known, its
  price where any, and its life. A `taking` row has a spinner. No chevron:
  a snapshot has no page of its own.
- **Actions**: Restore and Fork as icon buttons, and the menu (Rename…,
  Note…, Keep…, Stop keeping, Copy ID, Delete…). On a desktop they show on
  the row under the pointer or with focus inside it; on a touch screen and
  below 640 px they always show, and Fork moves into the menu there. Each
  is disabled, with why, when its plan or a pin refuses it.
- **Select**: a Select button beside Sort shows a checkbox on each row;
  with some ticked, a bar offers Keep… and Delete…. Each opens a dialog
  that applies the same plans, `eligible` and refusals to each snapshot,
  says which are skipped and why, and what each of the rest frees or costs
  on its own backend: a held copy's size on Proxmox, a daily price on
  boat.
- **Filters**, with counts: Where (each backend and host), Holds, Taken by
  (you; agents), Kept, Undos, Goes within 7 days. **Sort**: newest, oldest,
  largest, price, box name. **Search**: the snapshot's name and note, the
  box's name and the thread's title. The build gives 069's `SearchRow`
  these filter groups.
- **Empty**: "No snapshots yet. An agent takes one before a risky change,
  or take one from a box's page." The backends that have none are named
  below.

#### On a box's page (069)

A Snapshots card after Top processes and before the facts, and Take
snapshot… in the header's menu:

```
┌ Snapshots   2 of 5, and 1 undo · disk · on pve-1             [Take snapshot] ┐
│ [pic] before the migration                                                  │
│       Yesterday 23:39 · by the agent in Fix the sign-in flow · 1.2 GB       │
│ [pic] Thu 09:15  Kept                                     ⟲   ⑂   ⋯        │
│       kept until 29 Nov · Thu 09:15 · by you · 3.4 GB                       │
│ Snapshots hold the disk. They go when amber-fox is released, unless kept.   │
└─────────────────────────────────────────────────────────────────────────────┘
```

- A box whose backend has none says so in the card, and has no Take
  snapshot: "Boxes on the SSH host pool have no snapshots."
- A box whose plan cannot take one now says why in the card, with Take
  snapshot disabled: "pve-2's token cannot take snapshots. Fix it in
  Settings.", "Proxmox left amber-fox locked (rollback). Run `pct unlock
  214` on pve-1.", the limit, the room or the ceiling.
- After a restore, its notice at the top of the page, with 069's other
  notices; a restore that bb-box could not confirm after a restart is one
  of them.
- At 390 px, the header's actions take a row of their own under the name.

**Take snapshot** opens a small dialog: a name (the time by default), a
note, and "With its memory" where the backend gives the choice, unticked,
with its time scaled to the box's memory and its space ("About 15 s.
brisk-lake pauses for a moment. Up to 16 GiB more on pve-1"). The words
say what it holds and leaves out, the count, the picture, and the price or
"no charge".

**Fork** opens a dialog: the new box's name, where it goes, its size, its
time and space from the plan, and what it is: "A new box with amber-fox's
files as they were at 23:39. It gets its own BB machine, address and keys,
and never acts as amber-fox. Everything else on its disk comes with it:
project secrets, signed-in browsers and keychains. It starts fresh: no
apps are running." On Fork, the new box's page opens, starting.

**Keep…** opens a dialog: the date (30 days by default), and what keeping
costs on that backend: "If amber-fox is released, bb-box first copies this
snapshot in full into a template that cannot start: about 10 s, and 13 GB
on pve-1 until 29 Nov." Where Keep cannot be used after a release, the
menu item is disabled with why.

**Delete** asks: "Delete 'Thu 09:15'? Frees 3.4 GB on pve-1." or, on
LVM-thin, "Frees what it no longer shares with amber-fox." A kept one adds
"You kept it until 29 Nov."; an undo "It is the undo of the restore at
11:02."

Each dialog returns focus to the control that opened it, or for a dialog
opened from a menu, to the menu's button.

#### Settings (067)

Options gains a Snapshots row, between Images and Devices, whose value
reads "5 per box · kept 30 days · boat.dev up to $5 a month", opening a
page one step in. Numbers are drafts saved with 067's Save and receipts;
switches save at once, as 067's do.

| Group | Setting | Default | Notes |
| --- | --- | --- | --- |
| Each box | Snapshots per box | 5 | 1 to 50; undos apart, 2 a box |
| Each box | Refuse new snapshots when a host's storage is past | 85% full | 50% to 90%; the sweep's deletion of agents' unkept snapshots is 7 points above |
| Keep | Keep keeps a snapshot for | 30 days | 1 to 365 |
| Agents | Agents may restore their own boxes | on | off: `box_restore` asks through the form |
| Agents | Agents may restore memory snapshots | on | off: only the person restores a memory snapshot |
| Pictures | Keep a picture of the screen with each snapshot | on | |
| Paid snapshots | A ceiling a month, per provider and account, one row each | $5, the owner's default | beside it, the rate held and this month's spend; past it, new paid snapshots, undos, Keep and renewals are refused with the words of section 8 |
| What each backend offers | one row per backend and storage, read only, from its plan | | "Disk; restores any; forks by full copy; keeps by held copy · no charge"; ZFS says "restores off until checked"; a row with a problem says it, with the fix |

- Each backend's own page gains a Snapshots line among its facts.
- The settings live under `general.snapshots` in the configuration
  document, through 067's engine, so Find, drafts and the merge apply.

#### Words

- "Snapshot", never "checkpoint" or "backup". "Restore", never "roll back"
  or "revert" (Proxmox's word stays in the log's backend words). "Fork",
  never "clone" or "duplicate". "Keep", "kept until", "goes with the box",
  "held copy", "earlier guest".
- What it holds: "disk", "disk and memory", "device". In sentences:
  "files, installed apps and settings"; "its running apps".
- Who: as 069: "by you", "by the agent in (thread)", "by a bb box command",
  "by bb-box: (why)", "outside bb-box", "on a yes given in (thread)".
- An undo's name: "before the restore at 01:56".
- Sizes in GB for snapshots, as providers bill; GiB for a box's memory and
  disk, as 069 says them. Prices as the provider gives them.

#### Look and motion

BB's tokens and components, the hairline cards of the Boxes and settings
pages, and no page motion. One weight, 400, wherever bb-box sets the class.
The build moves bb-box's own `RowTitle`, `PageTabs` and settings `Group`
headings from 500 to 400 and gives its dialog titles 400; until that unit,
those three stay at 500, and the style pass is not complete. No shadow on
cards; BB's dialog and toast keep their own. A new row appears in place; a
deleted row goes without a fade; spinners stop under reduced motion. Amber
and red carry words, never colour alone.

#### Keyboard, screen readers and narrow windows

- Tab reaches, per row, the picture's button, then Restore, Fork and the
  menu, which show when focus is inside the row. Each icon button has its
  name and the snapshot's ("Restore amber-fox to before the migration").
- The dialogs are alert dialogs; focus starts on the safe choice: Cancel in
  Restore and Delete, the name in Take snapshot. Closing returns focus as
  above.
- The restore's progress and result are said in a polite live region.
- At 390 px: the picture shrinks to 48 by 30 px; actions always show; Fork
  moves into the menu; the line under a name may take two lines, with what
  needs attention first.

### 13. How it is built

Each unit is one PR with its tests and docs, a keyboard pass and
screenshots at 1,440, 760 and 390 px in light and dark where it has UI, and
a live check on a separate BB in a box: a fresh `npx bb-app` with no
account, bb-box installed from the unit's branch, with boxes made through
it. Proxmox first. A unit lands only when its gates pass (below). Safety
comes before screens: operations, permissions and the undo before any
tool restores, the identity reset before any held copy or fork, durable
Keep before the Keep UI, and a backend, storage or path whose gates cannot
run live stays unavailable.

**The identity reset comes second, on its own (unit 2).** Held copies
(ZFS's undo in unit 3, Keep in unit 8) and forks (unit 7) all rely on it,
and so does `forkSafe` on every snapshot taken from then on. Folding it
into unit 1a would double that unit, and folding it into unit 3 would put a
change to every Linux template inside the restore's own risky change. As a
unit of its own it is a template change, a marker and a boot step, checked
live with a plain Proxmox clone, before anything depends on it.

**Off when they ship.** Restores of execution machines, boxes threads run
on, ship off and turn on only when G17 passes (unit 5). ZFS restores ship
off and turn on only when G4 passes on a ZFS node (unit 3). Paid snapshots
ship off until a live check on a real paid plan (unit 11).

| Unit | Change | Size | Live check |
| --- | --- | --- | --- |
| 0 | **The Proxmox permission change**: `VM.Snapshot` and `VM.Snapshot.Rollback` in `setup-token.sh` and the LXC guide's table; the doctor's `proxmox.snapshots` check of the token's rights and of each storage's type and what it restores. Ships first, so installs run `setup-token.sh` again before the feature arrives | S | A token from the branch's script and one from `origin/main`'s: the doctor passes the first and names the two missing for the second, without printing either; an LVM-thin and a ZFS storage each described as section 2 says |
| 1a | The record and `snapshots.db`; operations, pins, `eligible` and their restart recovery for take and delete; `mayAct`; `Snapshotting` and `planSnapshots`; Proxmox LXC take, delete, `heldSnapshots`, the reconcile with `unavailable`, `lost`, `incomplete` and found orphans; the box log's events; `box_list` and `box_status` words; `bb box snapshot take`, `list` and `delete` | M | Through the CLI on an LXC box: take, list, delete. Gates G1, G2, G3, G9 |
| 1b | Proxmox QEMU: take with and without memory, delete, the reconcile | S | Through the CLI on a QEMU box: take with and without memory, list, delete |
| 2 | **The identity reset**: the marker and its boot unit in every Linux template and image, written after a box is first ready, the backend's interfaces only; its version read at each take as `forkSafe`. No fork or held copy yet | M | Gate G14's first part |
| 3 | Restore on Proxmox: plans by storage, the capture order, undo admission, held copies (inert, remade if not yet a template) for ZFS's undo, swaps with `adoptCopy` and earlier guests, the guard of section 5, operations and restart recovery, locks, size read back, access over SSH first, outside restores from task records; `bb box snapshot restore`. Execution machines refused | M | Gates G4, G5, G6, G7, G8, G13, G16; ZFS only where a ZFS node is free, and off otherwise |
| 4 | Settings' Snapshots page: limits, undos apart, room and the sweep's thresholds, keep length, the agents' switches, pictures, the paid ceiling as a rate, what each backend offers; through 067's drafts and Save | M | Each setting seen to bite; gate G10 |
| 5 | The agent's tools; the form through `bb.ui.requestInput`, for execution machines and for an agent's own box when its restores are off; the undo always taken on execution machines; the `message.dispatch` hold; execution-machine restores, by page or form, stay off unless G17 passes; the skill's words and the reference | M | Gates G11, G12, G17 |
| 6 | The box page's Snapshots card, Take snapshot, the restore dialog, its notice and Undo, Delete, Rename and Note, and the pictures | M | Take, restore and undo from the page; a guarded restore names every thread, the control and a terminal; keyboard only; 390 px with the header's actions on their own row |
| 7 | Forks on Proxmox Linux: `forkSnapshot` by full clone, re-armed, the check before ready, `box_fork`, Fork on the pages | M | Gate G14's second part |
| 8 | Keep: held copies at release on Proxmox, the release that waits for them, keep dates in labels, Keep's recovery check; the Snapshots tab with Keep…, expiry and Select | L | Gates G15, G16 |
| 9 | Tart: macOS snapshots as APFS copies of the suspended VM beside the VMs, with memory, and the suspend before the undo; Linux VMs, disk only; restore by putting a copy back; macOS's own identity reset, then forks and Keep; a guard against a state saved under another macOS build | M | On a Tart Mac box, never a pool Mac someone else holds: take, restore, undo, fork and keep of a 16 GiB macOS box, timed; a copy on another volume refused |
| 10 | microsandbox: native snapshots, restore as a swap, fork from a disk snapshot, dependent snapshots | S | Take with memory, restore, fork; the fork holds no process of its source; the restored box keeps its BB machine |
| 11 | boat.dev: saved snapshots on a paid plan within the ceiling, restore as a swap; on the trial, no restore and no Keep | M | Only once the owner gives a paid plan: take, restore, the price on the row and the rate in Settings, and what a restore costs in boat's starts. Until then paid snapshots stay off |
| 11b | boat.dev's identity source: the value bb-box sets on each guest, passed on in a same-box swap and new in a fork, delivered where boat's boot order lets the reset run before BB's daemon, Tailscale and SSH as the box user (see unit 11's results); boat's template rebuilt with the reset on; then forks from a saved snapshot and Keep, as-is until the keep date at its daily price | M | Gate G14 on boat: a fork resets with a new host ID, tailnet node, SSH host keys, machine ID and access file; a stop and start, a resize and a restore swap each keep the box's host ID with no reset; then Keep, a release, and a fork of the kept snapshot |
| 12 | Docker, Hetzner and Namespace Linux boxes: a paused commit with the box's Docker volume; restore as a swap | M | A Docker box with images in its own Docker: take, restore, and its images are still there; Keep disabled on Hetzner and Namespace with why |
| 13 | Android devices' own snapshots, `scope: device`, with the device's own capture order and losses | S | Save, restore, and the open app comes back; the words say the device only, and name no worktree |
| Later | Restores with the network down on QEMU (the guest agent and `VM.GuestAgent.FileWrite`); moving a snapshot between hosts by export; forks into another thread; Windows and iOS forks and Keep; a registry push for Namespace | | |

## Gated in unit N

A unit lands only when its gates pass in its live check on a separate BB
in a box, as 067's and 069's do, with the production token's rights.
Tokens are never printed.

| Gate | Unit | Rule | Passes when |
| --- | --- | --- | --- |
| G1 confirmed-take | 1a | A take is `ready` only when the provider confirms it complete (section 1) | A take whose task is killed part way is `incomplete`, never `ready`; Delete finishes Proxmox's cleanup |
| G2 unavailable-not-lost | 1a | A failed listing marks nothing; `lost` needs two successful listings without it; a backend with snapshots cannot be removed without Forget (section 1) | With pve-1 cut off for an hour, its snapshots are `unavailable` and come back `ready`; removing its backend asks to forget them, naming their size |
| G3 orphans-quarantined | 1a | A labelled snapshot of a gone box is listed, not deleted, for 7 days; one with a keep date gets its record back (section 1) | With `snapshots.db` deleted while bb-box is stopped, the next start finds every snapshot and held copy, kept ones as kept, and deletes none |
| G4 storage-rollback | 3 | The plan reads the storage; the capture order is the backend's; ZFS restores the newest only, with a held-copy undo; an undo of it is a swap that keeps the box's identity, re-arms the clone, and leaves an earlier guest; nothing newer is deleted (section 2) | On LVM-thin, a restore to the oldest of three with its undo, and nothing written before the stop is lost. On ZFS, an older target is refused with the words; the newest restores with its held copy; every newer snapshot is still there; undoing it makes a new guest with the box's MAC addresses, `onboot` set and links up, the box keeps its BB host ID with no reset, and its other snapshots show on its earlier guest, fork only; a second restore and undo, expiry, release and a bb-box restart at each step leave every guest and snapshot accounted for, on LXC and QEMU. Until this passes, ZFS restores stay off |
| G5 restore-guard | 3 | The guard reads `threadsOn`, control and terminals; an agent is refused while any is so (section 5) | With an idle thread's worktree on the box, a person holding control, or a terminal open, an agent's restore is refused naming it; the person's dialog lists each |
| G6 restart-recovery | 3 | Every step is recorded first and finished or reported at start; pins end with their operation (section 6) | bb-box killed after the stop, after the undo, after the rollback, and after a swap's new guest starts: each restore finishes or says it could not confirm, no guest is released as a leftover, and once settled, by itself or by Check now, none of its snapshots stays pinned |
| G7 lock-words | 3 | A locked guest is refused with the host's command (section 6) | A guest left with `lock: rollback` refuses take and restore with "Run `pct unlock <vmid>`", in the page, the tool and the doctor |
| G8 access-first | 3 | The access file is bb-box's first command after a restore, and the size is read back (section 5) | A sentinel value changed after a take is the new one after a restore before any other command bb-box runs, on LXC and QEMU; a restore across a memory resize shows the old memory, as the dialog said |
| G9 serialised-and-eligible | 1a, 3, 8 | All operations on a box run one at a time; `eligible` is checked at the moment of each change, for every path; room and money are reserved at once for all boxes (section 6) | Two takes at once, take and release, take and restore, delete and restore, expiry and fork, and a repeated `request`, each end in one consistent state. Restore twice then restore the oldest undo: the target stays. Restore twice, keep the oldest undo, restore again: the kept undo stays. Start a restore, then bulk-delete, bulk-keep and rename its target: each is refused for it and named. Let the room sweep pick its candidates, then start a restore to one and keep another before it deletes: both stay |
| G10 ceiling-rate | 4 | The ceiling bounds the rate held, checked on take, undo, Keep, renewal and held copy; never deletes to get under (section 8) | On a fake priced backend: a ceiling lowered below the rate refuses the next take, Keep and renewal, single and bulk, and warns, and deletes nothing; at a rate one snapshot below the ceiling, a restore's undo is refused before the box stops, and the person can restore without it; deleting keeps the month's spend |
| G11 form | 5 | An agent restores an execution machine only through the form, always with an undo; a form is bound to its plan and run as bb-box's own operation; its words claim a yes given in the thread, nothing more (section 5) | With execution-machine restores turned on for the test, on a machine of the person's, `box_restore` opens the form; Cancel, timeout, a stop of the thread and a BB restart do nothing; Restore from the app restores with the undo taken then, and logs "on a yes given in the thread"; a changed loss list asks again; with no room for an undo, it restores nothing. The same with "Agents may restore their own boxes" off, on the agent's own box. Then the asking agent runs `bb thread interactions respond --self` on its own form: what BB does and what bb-box logs are recorded in the unit's results and in request 38 |
| G12 permissions | 5 | `mayAct` for every operation, picture and bulk action (section 3) | A thread guessing another thread's snapshot ID can list, see, restore, fork, delete and fetch the picture of none of them |
| G13 outside-restore | 3 | Outside restores only from a provider task, by its status (section 4) | An outside take, delete, two restores to one parent, a rollback task that fails, one still running at a sweep, and several changes between sweeps each log as section 4 says |
| G14 fork-identity | 2, 7 | The unit runs before the network and identity services, fails closed, compares the backend's interfaces' MAC addresses with the marker, and only snapshots with `forkSafe` fork; a fork is re-armed (section 9) | Unit 2: on each Linux template, `systemd-analyze` shows the order; a plain Proxmox clone of a box, made with the production token, resets, and its BB host ID, tailnet node, SSH host keys, machine ID and access file are new; a `linux-docker` box with containers running and a box on the tailnet each restart three times without a reset; a spare claimed and renamed, then restarted, does not reset and keeps its host ID. Unit 7: a fork, also one given its source's name, resets, starts with `onboot` set and links up, and the source's host ID never shows a second connection; a snapshot from an image without the unit refuses to fork |
| G15 keep-lasts | 8 | Keep lasts the release through a held copy, and is offered only where a fork can use it (section 7) | Keep, release, restart BB, then fork from the kept snapshot and read a file written before the take; with too little room, the release stops and deletes nothing; Keep is refused, with why, on a Windows box and on a snapshot taken before the identity reset |
| G16 held-copy-inert | 3, 8 | A held copy and an earlier guest cannot start by themselves; a copy not yet a template is remade from its source, never trusted (section 2) | `pct config` and `qm config` show each held copy a template, and each earlier guest with `onboot` 0, links down and MAC addresses that are not the box's; after the node reboots, none is running and none connects to BB or the tailnet; bb-box killed after a clone and before it is a template, and the node rebooted at that moment: the copy is deleted and made again. The remade copy is then checked for what it saved, before any reset can run: adopted for the same box with `adoptCopy`, which keeps the box's MAC addresses so no reset runs, its files, BB machine credentials, host ID and access file are the source's, and the box comes back as the same BB machine. Its reset is checked apart: a fork of it resets as G14 says, with new credentials, access and host ID. An earlier guest started by hand resets before its network |
| G17 turns-held | 5 | No turn starts on an execution machine while it is restored, or the restore stops before the next change; execution-machine restores stay off until this passes (section 5) | A message queued to a thread on the box during its restore waits until the box is ready; "Send now" while waiting, after the final check and before the stop, and while the restored box reconnects to BB: each either waits, or stops the restore with nothing more changed and says so; a bb-box restart mid-restore, with BB's orphan sweep releasing the held turns, holds them again and checks before the next step. If any case lets a turn run on a box being changed, the path stays off |

## The owner's answers

The owner answered the two questions this note left him on 30 October
2026, and the note is written to them:

1. **The paid ceiling** is a setting the person sets, per provider, with a
   default of $5 a month (section 8 and Settings).
2. **Restores of a machine that threads run on** are allowed both ways:
   the person from the box's page, and an agent through the form, recorded
   as "a yes given in the thread". An undo is always taken for them, with
   no way to untick it. They turn on only after G17 passes. When BB's
   request 38 lands, the record names who answered (section 5).

The research's other questions are settled by the owner's earlier answers
and the reviews: an agent never restores the box its thread runs on, and
each box holds 5 snapshots with undos apart, which Settings can change.

## Decided during unit 1a

On 30 October 2026, during unit 1a:

- **An unwritable `snapshots.db` stops snapshots only.** While bb-box
  cannot write `snapshots.db`, it refuses every snapshot operation before it
  starts (a take, a delete, and from later units a restore, a fork, a Keep
  and a held copy), and the doctor's Snapshots' records check fails. A
  box's start, stop, resize and release do not use the file, so they go on.
  The lead decided this reading of section 1's "every operation that would
  change a box".

## Decided during unit 3

On 30 and 31 October 2026, during unit 3, the lead decided:

- **No ZFS node is free**, so ZFS restores ship off, as section 13 says.
  A switch for live checks only, `bb box snapshot zfs-order <backend> on`,
  which exists only with `BB_BOX_LIVE_CHECKS=1` on BB's server and lasts
  until bb-box restarts, runs ZFS's order on an LVM-thin backend: the held
  copy as the undo, the newest snapshot only, the swap with `adoptCopy`
  and the earlier guest. It proves those live; Proxmox's own refusal to
  roll ZFS back past a newer snapshot stays unproved.
- **No node is rebooted**: the only node runs everything else. G16's
  reboot part stays unproved, and is a condition before ZFS restores or
  unit 8's Keep are turned on.
- **A box threads run on** is any box with a thread, working or idle, on
  its BB machine, or the box the caller's thread runs on. In unit 3 its
  restores are refused for everyone, the CLI's `--force` included, naming
  the threads. So `--force`, the CLI's "Restore anyway", passes only a
  person holding the desktop and BB terminals.
- **After the reviews**: restoring a held copy, a swap, stays behind the
  same switch until G4 passes on a ZFS node, so unit 8's Keep copies do not
  become restorable before then; a held copy, as section 2 says, is made
  only of a box whose identity reset works, read before the stop; and
  older undos are replaced only once a restore is done.

Found by measuring, and built so:

- **A restore across a disk's growth goes back to the disk's size then.**
  On LVM-thin, a rollback puts back the snapshot's own volume, and
  Proxmox puts back its size in the guest's config: a container grown
  from 16 to 18 GiB after a take came back with a 16 GiB file system and
  `size=16G`, and started. So section 5's refusal of such restores is
  lifted, and the restore reads the size back and says it, as it does
  cores and memory.

## Decided during unit 4

On 30 October 2026, during unit 4, the lead decided:

- **The room's other thresholds follow the setting.** A thin pool's
  metadata refuses a take 5 points below "Refuse new snapshots when a
  host's storage is past", and the room sweep deletes 7 points above it, so
  85 gives 80 and 92, as before.
- **Housekeeping times stay fixed.** A failed record goes after 24 hours, a
  lost or found one after 7 days, and a missing one is lost after a second
  listing 10 minutes later. None is a setting.
- **Settings show only what bites.** The Snapshots page, the overview's
  row and Find show the snapshots per box, the room and the paid ceilings.
  Keep's length, the agents' two switches and pictures are in the
  configuration's schema and in core, tested, and come onto the page with
  the units that use them: 8, 5 and 6.
- **The ceiling's rule covers all five changes now; only the take uses it
  yet.** One rule admits a take, an undo, a Keep, a renewal and a held
  copy. Unit 4 wires the take; units 3 and 8 wire the rest, and prove G10's
  undo, Keep, renewal and bulk parts live.
- **A ceiling is per backend ID**, in the provider's currency, 5 unless
  set. Where no backend charges, the page says "None of your backends
  charges for snapshots". A made-up price, only with `BB_BOX_LIVE_CHECKS=1`,
  checks the ceiling where none charges.

## Decided during unit 5

On 31 October 2026, during unit 5:

- **Restores of boxes threads run on ship off: G17 did not pass.** BB's
  "Send now" sent a message held by bb-box's `message.dispatch` hook after
  bb-box's last check for a running turn and before its stop; the turn
  started on the box, and the stop interrupted it. bb-box's check just after
  the stop then found it, started the box again and restored nothing, so no
  disk was replaced under a turn; but a turn ran on a box bb-box was
  stopping. A check cannot be made at the same moment as the step after it
  from a plugin, so this stays off until BB can hold a machine against "Send
  now" ([request 39](../bb-requests.md#39-let-a-plugin-hold-a-machine-against-send-now)).
  The lead decided that had G17 passed, these restores would have shipped
  on, with no switch; a switch for live checks only,
  `bb box snapshot machine-restores on|off`, lasts until bb-box restarts.
- **The form's yes is the asking agent's restore, with the yes on its
  operation.** The operation records the yes (thread, title, time and the
  plan it was given for), and `restore-asked` and `restored` say "on a yes
  given in (thread)". The undo's record names the agent, as an actor of
  its own for a yes would need new rows in `snapshots.db` and `box-log.db`.
- **Before a form's restore, bb-box holds every new turn on the box and
  waits up to a minute for turns there to end**, so the asking agent can
  end its own; then it checks as section 5 says. It checks for a running
  turn before the stop, just after the stop, and before the rollback.
- **The yes is bound to the plan the form showed**: the box, its guest, the
  target and its reference, the undo's kind, and what else goes. A
  different plan asks again, at most three times.
- **A memory snapshot with "Agents may restore memory snapshots" off is
  refused, not asked for through the form**: section 5 names the form's two
  cases, and this is not one.
- **A refusal that holds only for now answers `try_again`**: a host's
  storage too full, for a take or a restore's undo, and a task such as a
  backup holding the guest's lock.
- **`box_snapshots` has no `pictures` parameter yet**; pictures come with
  unit 6, and `box_fork` with unit 7.

## Decided during unit 7

On 31 October 2026, during unit 7:

- **The check before ready compares what the snapshot held.** At each take,
  with `forkSafe`, bb-box keeps a hash of the box's machine ID and of each
  SSH host key on the snapshot's record (`identity`, a new column). On a
  fork's first contact, before anything else bb-box runs there, it reads
  the fork's identity reset, marker, BB folders, access file, Tailscale
  state, machine ID and host keys, and hands it over only if the reset ran:
  its boot says `reset` (or `kept` on a later boot of a fork that reset),
  its marker names only the fork's own MAC addresses and no box, BB's
  credentials, the access file and a tailnet node are gone, and the
  machine ID and host keys are not the snapshot's. `boot=unknown` and a
  reset still pending are waited for, up to a minute, never counted as
  reset. A fork that fails the check is released, and fails with why. A
  snapshot taken before this unit has no such hashes, and its forks are
  checked without that last comparison.
- **`forkSnapshot` makes the guest; core starts it.** The backend copies
  the snapshot in full into a VMID of its own, recorded before the clone,
  and re-arms it in one step: `onboot` 1, every link up, new MAC
  addresses, the address of its own VMID, on QEMU a new SMBIOS UUID, and
  the new box's labels. It takes the previous guest of a fork cut short by
  a restart, as `acquire` does, and deletes it before it copies again.
  Core starts the guest with the backend's `start`, then checks it.
- **The copy runs on the source box's queue**, so the source's take,
  restore, stop and release wait for it, and the fork's operation pins its
  snapshot until the fork is ready or failed. Its box log has `fork-asked`
  then `forked` or `fork-failed`; the fork's own log starts with `made`,
  "Forked from (source), (snapshot) (taken ...)".
- **Where a fork goes.** An agent forks into its own thread; the person
  into the box's thread, or with `--as-machine` (the page's "As one of
  your machines") as a machine of theirs; a fork of one of the person's
  machines is one of theirs. The CLI's `--machine` and `--thread` already
  say where the source box is, so the fork's own choice is `--as-machine`.
  Forks into another thread stay later, as section 9 says.
- **A fork has the snapshot's size**, read from the snapshot's config; no
  larger size is offered yet.
- **Held copies do not fork yet**: they come with Keep (unit 8).
- **Takes flush first** (the lead's request after the first live check).
  Before a take of a running box, bb-box runs `sync` in it, as unit 6's
  restore does before its stop, with the same 15 s limit, disk only and
  with memory alike: a QEMU memory snapshot's disk otherwise lacked what
  the guest had not written yet, so its fork lacked it too. A flush that
  fails or times out stops nothing: the take goes ahead, and its record
  (`unflushed`, a new column), its answer, the list, the page's row and
  every fork of it say it may miss the last writes. Keep (unit 8) is to
  say so too.
- **A fork's first start waits up to 180 s for SSH** on Proxmox LXC as on
  QEMU (the lead's request), so an LXC fork whose card comes late is
  waited for until its reset, not failed at the container's usual 30 s.
  Other starts keep their own wait.
- **A fork never keeps its source's address.** Live, an LXC fork started
  without its card kept its source's network file, as Proxmox writes one
  only for the cards a container starts with; when the card was
  hot-plugged, systemd-networkd brought up the source's address before
  Proxmox wrote the fork's own, and the source lost its connection to BB
  for 40 s. Two fixes: the check before ready refuses a fork that holds
  its source's address; and version 6 of the identity program, on Proxmox
  LXC, sets the `eth` cards' network files aside while a boot cannot tell
  whether it is a copy, so a card added later gets only Proxmox's settings.
  The reset is too late for that: networkd applies a file the moment the
  card appears. The fix needs the LXC templates rebuilt with version 6;
  until then the check before ready refuses such a fork.

After the two reviews of unit 7, the lead decided:

- **A clone cannot start until bb-box arms it.** The first request after
  the clone task sets `onboot` 0 and every link down. The copy gets its
  own addresses with its links down. Its links come up just before its
  first start, and `onboot` only once the check before ready passes. The
  gap between the clone's lock going and that first request is accepted,
  with no hookscript: the lock covers the copy, a reboot inside the gap
  still resets on the new MAC address, and recovery deletes a half-made
  fork.
- **Version 7 holds from the first look.** On Proxmox LXC, a boot with no
  `eth` card and none of the marker's MAC addresses on any interface holds
  the copied network files before it waits, in `/var/lib/bb-box/`,
  flushed, and settles them at the next decision. If it cannot hold them
  it deletes them, and if it cannot delete them the boot fails closed.
  This replaces version 6's hold after the wait.
- **Each backend forks only from a version known safe**: Proxmox LXC from
  7, QEMU from 5, before the copy and at first contact.
- **The check before ready reads everything or refuses**: every probe must
  finish and every item be read; the fork must hold its own address and
  no other address of the box range; a shared MAC or another box's
  address refuses at once, before any wait.
- **A failed clean-up is kept, not hidden**: the guest stays on the record,
  stopped, the operation unknown and pinned, and the sweep deletes it.
- **`box_fork` checks before it takes**, deletes the snapshot it took if
  the fork is still refused, and passes on the take's words.
- **Names are checked before anything is recorded**, by the machine rule.
- **A fork of a kept snapshot is one of the person's machines.**

After the re-reviews:

- **A fork's record keeps its guest when bb-box stops.** Recovery deletes
  that guest, and confirms it is gone, before it copies the snapshot
  again.
- **A read that fails is unreadable, never a negative answer**, so it
  refuses the fork.
- **`box_fork`'s check before its take includes the fork's room and
  place**: the backend's room, the thread's limit and the name.
- **An abandoned clone is disarmed before each attempt to delete it.**

## Decided during unit 8

On 31 October 2026, during unit 8, the lead decided, with the owner's
earlier answers:

- **A leftover guest of an ended thread** (a guest with no box record,
  whose thread BB says ended at two sweeps) goes at once, with its
  snapshots. First, bb-box makes held copies of those it carries a keep
  date for, as they are the person's; the rest go with it.
- **Found snapshots are kept until the person deletes them.** Only a
  forgotten box's guest still holds snapshots once its box is gone, and
  the person who forgot it was told nothing was deleted. So section 1's
  7-day deletion of found snapshots is dropped: they are listed as found
  until the person deletes them, or until their guest goes as above.
- **Keep has no switch of its own.** It needs a snapshot that could fork
  after the release, so it is refused on a backend that is not armed
  (`general.identityResetBackends`), as production is. Arming is the
  owner's call, and gates Keep too. G16's node reboot stays unproved, as
  no node is rebooted.
- **A living box's kept snapshot goes at its date**, as section 1 says,
  not back to "goes with the box".

Built so:

- **A keep date is the end of a UTC day**, the same day the label
  carries. Keep keeps from today for the days in Settings, or until the
  date given, at most 365 days from today. Keeping a kept snapshot again
  renews it: by default it adds the days to its keep date, so it never
  shortens it; a date the person gives may, and the dialog and `--check`
  say so.
- **The keep date is written on the provider first.** If Proxmox refuses
  the snapshot's label, or the held copy's tags, nothing is kept. Stop
  keeping takes it off the label first too. A released box's kept
  snapshot is not unkept, as only its keep holds it: it is kept longer, or
  deleted.
- **A held copy is a copy of the snapshot**, cloned while the box still
  runs (Proxmox allows a full clone of a running guest only from a
  snapshot), then disarmed and made a template, before the guest is
  deleted. It carries the snapshot's time, the box's kind and the version
  of the box's identity reset in its tags, so one found again after
  `snapshots.db` is lost still forks. bb-box waits until Proxmox lists the
  copy as a template: Proxmox's call for a container answers before its
  worker ends.
- **A held copy's room** is a take's: refused when the storage would be
  past "Refuse new snapshots when a host's storage is past" with the copy,
  sized at the box's disk use now where Proxmox reads it (containers), or
  the snapshot's disk size (VMs). A held copy replaces its snapshot in the
  paid rate, so a release checks no ceiling; no backend charges yet.
- **With `snapshots.db` unreadable**, a release reads the provider's labels
  and refuses while one of the box's snapshots carries a keep date, so a
  broken record never deletes a kept snapshot. Unit 1a's release with an
  unwritable file goes on otherwise.
- **"Release and delete what you kept"** stops keeping each kept snapshot
  of the box not yet copied, at the person's word, then releases it; held
  copies already made stay kept.
- **Any held copy forks**, a kept one of a released box as one of the
  person's machines, by a full clone of the template.
- **A fork's guest is disarmed before every attempt to delete it**, the
  sweep's retries of its release included (unit 7's follow-up).

After the two reviews of unit 8, the lead asked for these, each with a
regression test:

- **Keep and its renewals are recorded operations** (`keep`), journalled
  before the label changes. Recovery settles each from the label before any
  expiry or release, and the reconcile takes a label's later keep date.
- **A copy is never trusted over its source.** After records loss, a held
  copy that is not a template, beside the snapshot it was made from, is
  deleted and the source kept. A release stops while a kept snapshot's
  copy is unfinished.
- **A held copy goes through the storage admission takes use**: it counts
  what snapshots and copies being made there reserve, reserves its own
  bytes on its operation until it is made, and refuses when the plan or
  the storage's totals cannot be read.
- **The snapshot's label carries the identity reset's version** (`reset
  <n>`), so a living box's snapshot found again still forks. A release
  stops for a kept snapshot whose version is unknown, rather than copy
  what could never fork.
- **The clone's wait scales with the disk**: 3 times the plan's estimate,
  at least 3 minutes, for held copies and for forks of them. If the wait
  runs out while the provider still makes the copy, its operation stays
  unsettled and the part-made copy is deleted only once the task ends. A
  guest named as a part-made copy is never taken for a box (found live).
- **The release copies before the machine leaves BB**, and a leftover guest
  of an ended thread is judged by the snapshots' labels as well as the
  records.
- **Bulk Keep never shortens by default**, and names each keep a chosen
  date would shorten.

After the re-reviews, the lead asked for these, each with the reviewer's
probe as a regression test:

- **Every release reads its guest's labels** before it deletes anything,
  from a listing of that guest's own snapshots, and stops when it cannot
  read them, or when a label says kept and the records do not. A rebuilt,
  empty `snapshots.db` is healthy, so the records alone cannot show that
  nothing is kept.
- **A slow clone that ends well is kept.** bb-box waits for the same task
  across its retries, then labels, disarms and templates that copy, rather
  than cloning again; one that ends well just as the wait runs out is kept
  in the same release. A copy left by a restart is still not trusted.
- **Each copy attempt records its start and its task.** Recovery takes only
  a task begun from this attempt's start, never an earlier attempt's, and
  stays unsettled while more than one could be its own. Proxmox lists a
  clone's task under its source's VMID only, so the target VMID cannot be
  matched from the list.
- **"Release and delete what you kept" is offered only where it gets past
  the stop**: not while a copy is being made, a label cannot be read, or a
  held copy is not a template.

## Decided during unit 10

On 1 November 2026, during unit 10, from probes of `msb` 0.7.7 (the
release bb-box pins) in a nested-KVM box, the lead decided:

- **New microsandbox boxes get a Docker disk of `msb`'s own**
  (`--mount-owned`), in place of the file of the host's bb-box made
  (`--mount-disk`). `msb` leaves a host's file out of every snapshot, drops
  it on any restore, even with `--dangerously-inherit-resources`, and
  refuses `--full` for a box that has one ("additional block resource ...
  has no immutable-generation provider"). Its own disk is captured, restored
  as a private copy, and works with `--full`. A create took 0.54 s with its
  own 64 GiB disk against 0.45 s with a host's file, one at a time. A box
  made before keeps working as it does, Docker, resizes and release
  included, and takes no snapshot: "it was made before bb-box could
  snapshot a box's Docker disk: its Docker data is on a file of the host's,
  which msb leaves out of a snapshot and cannot give a restored box. A new
  box can". So the template of a Docker disk that bb-box made on a host
  without `mkfs.ext4` is no longer made.
- **Dependent snapshots are recorded and shown, and deleted with
  `--force`.** Each `msb` capture's parent is its sandbox's previous
  capture, or the snapshot a restored sandbox came from, and `msb` refuses
  to delete a parent without `--force`. But the data is not shared: in a
  chain of three, with both parents force-deleted, the last restored
  byte-identical (60 MB on the root and 15 MB on an owned disk). Section
  1's "a snapshot others depend on cannot be deleted first" would let only
  the newest go, which breaks the limit of 5, undo replacement and the room
  sweep. So `dependsOn` names the parent, the row says "after ...", and a
  delete passes `--force` when others depend on it. The one rule of `msb`'s
  that holds is kept: a group's head cannot be deleted while it has other
  members, so bb-box makes another member the head first.
- **Only with the `msb` those probes measured.** bb-box takes, restores,
  forks and deletes microsandbox snapshots only when the host's `msb` is
  0.7.7. With any other, every snapshot operation is refused with the words,
  and the doctor's Snapshots check warns. A test fails if bb-box pins
  another release without the probes run again
  ([microsandbox-unit-10.sh](../research/box-snapshots/microsandbox-unit-10.sh)).
- **The undo is taken of the stopped box**, as on boat.dev (decided during
  unit 11), not of the running box as section 5's capture order says: the
  undo then holds exactly what the restore replaces.

Built so:

- **A snapshot's name says whose it is.** Each box's snapshots are one
  group, `bbbox-<box ID>`, named `<install>-<snapshot ID>-r<version of the
  identity reset>`, so `msb snapshot list` alone gives the install, box,
  snapshot and `forkSafe`, as a label carries them on Proxmox. `msb` cannot
  change a snapshot's labels once taken, so Keep writes the keep date in a
  file of bb-box's, `kept/<msb snapshot ID>`, beside `msb`'s folder.
- **A restore keeps nothing of the old sandbox's settings.** `msb snapshot
  restore` gives the new sandbox none of the old one's labels, environment,
  hostname, `/run` tmpfs or memory size. So bb-box restores a disk snapshot
  at the box's size and a memory snapshot at its captured size (`msb`
  refuses another), then sets the box's labels and environment on it with
  `msb modify` before anything of the box runs there. Each start of a box
  mounts `/run` in memory again when it is not, and sets the box's hostname
  from `BBBOX_HOSTNAME`.
- **The identity source is a value**, `BBBOX_IDENTITY`, as on Docker (unit
  2): bb-box sets the box's ID on each sandbox, passes it on in a same-box
  swap, and sets the fork's own ID on a fork, so the reset runs in a fork
  and in no swap. A fork's check reads the marker's value, not MAC
  addresses. A fork restores a memory snapshot's disk only
  (`--disk-only`), and nothing of the box runs in it until bb-box starts its
  image's command, which runs the reset first. Forks from version 7 of the
  identity program, as on Proxmox LXC.
- **A restored sandbox is `bbbox-<box ID>-<token>`**, and a part-made one,
  before its labels are set, is still the box's to delete: a release and a
  restore's clean-up remove a sandbox of that name with no bb-box labels.
- **A restore gives the new sandbox the box's network profiles** as rules
  (`--net-default deny --net-rule allow@dns,allow@public,allow@private,allow:ingress@any`
  for `public,private`), which msb records as its create does. Without
  them the restored box could not reach BB on a private address (found
  live). Its disk size, from a label taken with the snapshot, is set on it
  too, so its size reads back whole.
- **A box with no SSH server is fork-safe without SSH host keys.** The
  images microsandbox runs have none, so a take there records the machine
  ID alone; the reset makes new keys, and the fork's check still requires
  them. A box compared by MAC address still needs its keys at the take. The
  fork's check reads addresses with `hostname -I` where an image has no
  `ip` (found live).
- **A kept snapshot of a released box forks from the snapshot itself** on a
  backend that keeps it as is, as a held copy does on Proxmox.

After the two reviews of unit 10, the lead asked for these:

- **No snapshots on a Mac host yet.** Everything above was measured on
  Linux, ext4 and KVM; a Mac runs `msb` on another hypervisor and file
  system. Until the probe, with the reviewers' checks, runs on a Mac, every
  snapshot operation there is refused: "bb-box takes no snapshots of
  microsandbox boxes on a Mac yet: what they rest on, such as each snapshot
  holding its own data, was measured on Linux only", and the doctor says
  so. Follow-up: run
  [microsandbox-unit-10.sh](../research/box-snapshots/microsandbox-unit-10.sh)
  on a Mac, then lift it.
- **The version is read fresh before every change**: a take, a restore, a
  fork, Keep and a delete each run `msb --version` first, and a delete reads
  it again right before a `--force`, never from the host's facts, which are
  kept for a minute.
- **An access file written as a restored box starts is part of its start.**
  The restore's record stays at its start until the start has finished, so
  bb-box restarting before the box's own start command ran starts it again,
  and deletes the old guest only after.
- **A restore keeps the larger of the snapshot's disk and the box's**, as a
  fork does.

## Decided during unit 11

On 31 October 2026, during unit 11, the lead decided:

- **The ceiling holds what the provider bills.** boat.dev's plan includes
  saved snapshots, 10 for each $20 of plan, and bills only those past them,
  account-wide, at $0.056 a day each. So a backend may give its own bill
  (`snapshotBill`: how many the plan includes, how many the account holds,
  and the daily price of each past them), and the rate held is then what is
  past the included ones, times the price, times 30. A take, an undo and a
  held copy add to the rate only when they would be past the included
  ones. Each take, undo and Keep reads the bill first, and is refused when
  it cannot be read: an older count says nothing of what others on the
  account have added since. Settings then show an estimate, every saved
  snapshot of the last count and bb-box's own since at full price, said as
  an estimate. Each row's price says "past the plan's 10", and Settings and
  the tab's line say how many the account holds and how many are billed.
- **Keep and forks wait on boat.dev for unit 11b.** Keep is offered only for
  what can fork after a release (section 7), and a fork needs the identity
  reset, whose source unit 2 left for boat. boat.dev boots its base image
  and lays the sandbox's own files over it after the sandbox is reachable,
  so the reset cannot run before the network there, as section 9 says. Unit
  11 ships take, list, delete, the price, the ceiling and the restore; Keep
  and fork on boat.dev are refused with "boat.dev boxes have no identity
  reset yet". The swap does not need the reset: boat.dev's boxes are not
  armed, so the new sandbox comes back with the box's own BB machine files,
  with the old sandbox stopped first.
- **boat.dev's restore stops the box first, then saves the undo.** boat.dev's
  stop saves the disk, and a saved snapshot of a stopped sandbox is that
  save, so the undo holds exactly what the restore replaces. Section 5's
  capture order took the undo from the running box, which loses what is
  written between the undo and the stop. The cost is the box being stopped
  while its undo is saved; unit 11's results give it as measured.

Built so:

- **A saved snapshot's name is its label**: the install, the box and the
  snapshot, `<install>-<box>-<snapshot>`, at most 62 characters, as boat.dev
  allows 63 and no labels. bb-box lists, reconciles and deletes only names
  of its own install.
- **A restored box runs on a new sandbox** labelled as the box, with a
  token of its own (`bbbox-guest`), so its guest reference differs from the
  old sandbox's, and bb-box never takes one for the other. boat.dev gives a
  sandbox deployed from a saved snapshot no labels, so the restore deploys
  it under a name that carries the box and the token, stops it, forks it
  with the box's labels, and deletes the deployed one; the name is known
  before boat is asked, so a release, a recovery or the upkeep finds it
  after a lost answer or a restart.
- **Never two sandboxes acting as the box, never none.** The old sandbox
  stays, stopped, until the new one has started and taken its access
  file; only then is it deleted, and the sweep releases it as a leftover if
  that delete fails. If the new one does not start, or its access file
  cannot be written, bb-box records that it is putting the old one back
  (`swap-back`), deletes the new one, confirms it and the sandbox deployed
  for it gone or stopped, and starts the old one again; a restart resumes
  from that step. If it cannot confirm them, it starts neither, leaves the
  restore unsettled and tries again at its next sweep. The box's snapshots stay restorable: they live on the
  account.
- **Every release deletes the box's saved snapshots**: before the sandbox
  goes, from boat.dev's own list as well as the records, and confirmed by a
  second list; a leftover sandbox of an ended thread's box the same way; and
  a record left by a release that could not do it, at the next sweep. If
  one cannot be deleted, the release stops and the sweep tries again.
- **The plan is read from boat.dev's limits, never assumed**: only the
  `standard` tier with a `box_` plan takes saved snapshots; a missing or
  unfamiliar tier or plan takes none.
- **What a restore costs in starts** is in its plan and its words: 2 starts,
  the deploy and the fork, free within the plan's starts and priced from
  the wallet past them. A restore needs 3 available in every one of
  boat.dev's windows, free or paid up to boat.dev's own ceilings with the
  wallet (`startLimitsWithWallet`), as putting the box back takes a third,
  and is refused before anything stops otherwise.
- **Reservations last until boat.dev counts them**: a snapshot bb-box holds
  that boat.dev's list does not name yet counts beside its bill. When the
  bill cannot be read just now, no paid snapshot is admitted. A snapshot
  found again keeps its backend's price.
- **A live check can count fewer included snapshots**:
  `bb box snapshot fake-included <backend> <count>`, only with
  `BB_BOX_LIVE_CHECKS=1`, until bb-box restarts, so the ceiling's refusal is
  seen with a few snapshots.

## Decided during unit 11b

On 1 November 2026, during unit 11b, after a live probe of boat.dev's
per-sandbox `env` and create-time `files` (070 results, unit 11b), the lead
decided:

- **boat.dev's identity source is the per-sandbox `env`**, `BBBOX_IDENTITY`
  set to the box's ID. boat.dev writes it to `/run/ascii-secrets/env.sh`
  at each start, before it starts the sandbox's own services; a fork or a
  deploy takes the value the request gives, and inherits its source's
  otherwise; a stop and start and a resize keep it. Create-time `files`
  are not used: a fork accepts them and ignores them, so a fork would keep
  its source's file.
- **Version 8 of the identity program, for every image.** It can read the
  value from a file (`enable --value-file`), never sourcing it. Only a
  value that differs is a copy; a value not there yet holds the box as
  unknown, removing nothing, while SSH, Tailscale and BB's daemon wait
  (after the reviews). It can leave the SSH
  host keys and machine ID to the provider (`--machine-from-provider`), as
  boat.dev gives every machine its own and pins the host key it reports
  from those files. With a value file, `wait` holds BB's daemon while no
  check has run on this machine. Proxmox's behaviour does not change: its
  images run `enable` with no options, `wait` is version 7's there, and
  Proxmox's `forkSafeFrom` stays 7 for LXC
  and 5 for QEMU. boat.dev forks from version 8.
- **Section 9's order holds on boat.dev for what bb-box controls.** The
  check cannot run before the network or boat.dev's own SSH there. bb-box
  waits for it, as boat.dev's user, before it lets the box user in, joins
  the tailnet or writes the access file, and starts it itself if boat.dev
  has not 10 s on; BB's daemon waits for it by its own unit.
- **Only boat.dev's `linux` template turns the reset on**, as on Proxmox.
  Desktop and Android boxes there neither fork nor keep.
- **A copy made outside bb-box keeps its source's identity**, a known
  limit: boat.dev gives a fork made in its dashboard or API its source's
  value. The guides say so in plain words.
- **G14's tailnet item is checked as unit 7 checked it**: by the reset
  removing Tailscale's state, as the test BB has no account.
- **Keep on boat.dev is as it is**, at the daily price past the plan's
  included ones, until the keep date. Its keep date lives in the backend's
  own storage, apart from `snapshots.db`, as boat.dev's saved snapshots
  take no labels. A kept snapshot of a released box forks, and renews.
  Keep is offered only for snapshots taken under version 8 or later, and
  says why otherwise.
- **Arming boat.dev stays off in production** until the owner arms it after
  merge and a smoke test.

## Alternatives considered

- **A portable format of bb-box's own** (the research's shape B). An order
  of magnitude slower per take, no memory, a store to run, and secrets in
  an archive away from the box. It can come later as the export of a
  snapshot, for moves.
- **Each provider's snapshots shown as they are** (shape C). The core would
  name providers, and the person would learn each one's words.
- **Restore by clone and swap everywhere**, so every storage restores any
  snapshot. It costs a full copy per restore, and the box's other
  snapshots move to an earlier guest each time. Used only for ZFS's undo.
- **Keep by holding the released guest.** It would hold its memory, cores
  and VMID as a stopped box that could start; a held copy is a template of
  the kept snapshot's disk only.
- **The hostname, or the SMBIOS UUID, as the fork detector.** A rename
  changes the hostname, and a fork can share a name; a held copy keeps the
  UUID. The MAC address changes on every clone and nothing else, and
  bb-box sets it on a swap.
- **Starting a restored box with its network down.** It needs a way into
  the guest without a network, which the token has none of on LXC; left
  for QEMU later.
- **A page per snapshot.** A snapshot has little to show beyond its row and
  picture.
- **Undo kept in memory only, as a short "Undo" toast.** An undo must
  survive a reload and a restart of bb-box, so it is a snapshot.
- **The agent's word for the person's yes** (`person_agreed`). The form at
  least asks in the thread, where the person sees it, and records it.
- **Fork from memory.** The memory holds the source's processes and tokens.

## The prototype

Open [070-snapshots/prototype.html](070-snapshots/prototype.html) in a
browser. It is one file with nothing to install, and saves nothing. It uses
bb-box's own tabs, row titles, badges, status dots, icon buttons, settings
rows and switches, with BB's buttons, menus and dialogs. A fake server
holds eleven boxes and eighteen snapshots under generic names, takes a
snapshot in about 1 s (longer with memory), restores in about 4 s and
forks in about 4 s, and keeps a box log. Pictures are drawn by the
prototype, not real screens. Add `?light` for the light theme.

The dashed Prototype panel, bottom left, goes to: the Snapshots tab, a
desktop box on LVM-thin, a box on ZFS, a machine of yours, a VM with a
memory snapshot, a Mac on Tart, a box on boat.dev, an Android device box,
a box with no snapshots, a box whose token cannot take them, a released
box's kept snapshot, and Settings. It also makes the next take, restore or
fork fail, runs an agent's snapshot and restore of its box, opens an
agent's form to restore your machine, restarts bb-box in the middle of a
restore, fills pve-1's storage past 92%, and switches dark and light.

Worth trying:

1. On amber-fox, restore "before the migration": the dialog names the
   working thread, an idle one, your control of the desktop and an open
   terminal. Keep the undo, then use Undo in the notice; restore to the
   oldest undo: its target stays.
2. On tidy-glade (ZFS), try an older snapshot, then the newest, then undo
   it: the other snapshots move to its earlier guest, fork only.
3. On brisk-lake, its oldest snapshot was taken before the identity reset:
   Fork and Keep are disabled, with why.
4. "An agent asks to restore work-pc": the thread stand-in shows the form,
   worded as a yes given in the thread, with its undo always taken; answer
   it, and see work-pc's notice and log follow the restore. On work-pc's
   page, its own restore dialog will not let the undo be unticked.
5. "bb-box restarts mid-restore", then Check now on amber-fox.
6. Start a restore, go to the Snapshots tab, Select its target and delete:
   it is skipped and named.
7. In Settings, lower the ceiling below the rate held and Save; then try
   Keep on quick-wren's snapshot.
8. On quick-wren, restore with its undo at the default ceiling: the undo is
   refused before the box stops, and the dialog offers to restore without
   it.
9. "pve-1's storage passes 92%", then at once restore brisk-lake to
   "schema v41" and keep another of its snapshots: the sweep spares both.

Screenshots, at 1,440 px wide unless named, taken by a script that drives
the prototype on a box: [the Snapshots
tab](070-snapshots/new/01-snapshots-tab.png), [a row's actions on
hover](070-snapshots/new/02-row-hover.png), [two
selected](070-snapshots/new/03-select.png) and [their
delete](070-snapshots/new/04-delete-two.png), [agents'
only](070-snapshots/new/05-filter-agents.png), [a desktop box's
page](070-snapshots/new/06-desktop-box.png), [Take
snapshot](070-snapshots/new/07-take-lxc.png), [a take in
progress](070-snapshots/new/08-taking.png), [the restore dialog naming what
goes](070-snapshots/new/09-restore-dialog.png), [without
undo](070-snapshots/new/10-restore-without-undo.png),
[restoring](070-snapshots/new/11-restoring.png), [the notice with
Undo](070-snapshots/new/12-restored-notice.png), [the undo's
dialog](070-snapshots/new/13-undo-dialog.png), [Fork](070-snapshots/new/14-fork-dialog.png),
[a fork starting](070-snapshots/new/15-fork-starting.png), [a VM with a
memory snapshot, a failed take and one taken before the
reset](070-snapshots/new/16-vm-memory-failed.png), [with its
memory](070-snapshots/new/17-take-with-memory.png), [a Mac on
Tart](070-snapshots/new/18-take-tart.png), [a token without the
rights](070-snapshots/new/19-token-lacks-rights.png), [a box with
none](070-snapshots/new/20-no-snapshots.png), [a released box's held
copy](070-snapshots/new/21-released-kept.png), [Settings'
Options](070-snapshots/new/22-settings-overview.png), [the Snapshots
settings page](070-snapshots/new/23-settings-snapshots.png), [the ceiling
below the rate](070-snapshots/new/24-ceiling-passed.png) and [a take it
refuses](070-snapshots/new/25-take-refused-ceiling.png), [an agent's
restore of a device](070-snapshots/new/26-agent-restored.png), [the tab at 390
px](070-snapshots/new/27-phone-tab.png), [a box at 390
px](070-snapshots/new/28-phone-box.png), [the tab at 760
px](070-snapshots/new/29-760-tab.png), light ([the
tab](070-snapshots/new/30-light-tab.png), [a
restore](070-snapshots/new/31-light-restore.png)), [ZFS: an older snapshot
refused](070-snapshots/new/32-zfs-older.png), [ZFS: the newest, with a held
copy](070-snapshots/new/33-zfs-newest.png), [the form in the
thread](070-snapshots/new/34-person-form.png), [restored on a yes given in
the thread](070-snapshots/new/35-form-restored.png), [a restore cut short
by a restart](070-snapshots/new/36-restart-unconfirmed.png), [Keep and its
cost](070-snapshots/new/37-keep-dialog.png), [a locked
guest](070-snapshots/new/38-locked.png), [a storage past
92%](070-snapshots/new/39-storage-full.png), [a ZFS undo leaving an earlier
guest](070-snapshots/new/40-zfs-earlier-guest.png), [an undo's target kept
through a third undo](070-snapshots/new/41-undo-target-kept.png), [a bulk
delete skipping a restore's target](070-snapshots/new/42-bulk-skips-pinned.png),
[Keep refused over the ceiling](070-snapshots/new/43-keep-over-ceiling.png),
[the room sweep leaving a restore's target and a newly kept
snapshot](070-snapshots/new/44-sweep-spares-protected.png), and [a paid
undo refused before the stop](070-snapshots/new/45-paid-undo-refused.png).

What it does not do, where the build follows this note:

- The tools and the CLI; a real form in BB's composer, and an agent
  answering it (a stand-in thread shows the form); the turn hold. It shows
  restores of a box threads run on, work-pc, as they will work once G17
  passes; they ship off. Only work-pc and dev-desk are marked as boxes
  threads run on, though the others list threads' workspaces.
- Keep's expiry by the sweep, the reconcile, `unavailable`, `lost` and
  found orphans, held copies' templates and node reboots.
- Real room on a host: each storage's fullness is a fixed number until the
  panel fills pve-1.
- The Machines and Threads tabs, and Activity and Top processes on a box's
  page, are stand-ins for 069's.
- bb-box's own `PageTabs`, `RowTitle` and settings `Group` keep weight 500
  here, as they are in `src/`; the build moves them to 400.
- Its search row copies the Boxes page's classes rather than using
  `SearchRow`.

To rebuild it, on a box: `npm ci` at the repository's root, then `npm ci`
and `npm run build` in `docs/decisions/070-snapshots/prototype`, which
writes `prototype.html` beside the folder. `npx tsc -p tsconfig.json
--noEmit` there typechecks it.

## Consequences

- bb-box keeps a third small file of its own, `snapshots.db`, with its
  records, operations and pictures.
- Every Proxmox install needs `setup-token.sh` run again for snapshots
  (unit 0); until then the doctor and the pages say so, and nothing else
  changes.
- Every Linux template and image gains a boot step that resets a fork's
  inherited identity when its backend's MAC addresses differ from bb-box's
  marker (unit 2), beside 017's.
- A release of a box with kept snapshots on Proxmox makes held copies,
  templates that cannot start, first, and can stop for want of room.
- ZFS restores stay off until G4 passes on a ZFS node, and restores of
  boxes threads run on until G17 passes.
- Agents gain five tools. An agent restores a machine threads run on only
  through a form in the thread, always with an undo, recorded as a yes
  given in the thread until BB can say who answered.
- The box log records snapshots, restores and forks, and restores made
  outside bb-box on Proxmox when a task shows them.
- BB is asked to say who answered a plugin's form (request 38).

## What changed after the reviews

### After the first reviews

Two independent reviews, by Opus and by GPT-6 Astra, read the note, the
research and the code, and ran the prototype on a box. Both said: build
after changes. Numbers are each review's own.

| Finding | Reviews | Change | Where shown |
| --- | --- | --- | --- |
| Keep cannot outlive a release on Proxmox; the sweep would delete a kept guest; Namespace and Hetzner lose theirs; the live check proved a row, not a restorable snapshot | Opus 1, Astra 1 | `keepsPastRelease` per backend; on Proxmox a held copy made before the guest goes, adopted by the sweep; the release stops if a copy fails; no Keep on boat's trial, Hetzner, Namespace and devices; the Keep dialog says time and space; G15 forks from a kept snapshot after a release and a restart and reads a file | Sections 2 and 7; G15; [screenshot](070-snapshots/new/37-keep-dialog.png) |
| ZFS rolls back only to the newest snapshot, so undo-first breaks every restore; capability must be per storage, read live | Opus 2, Astra 2 | `planSnapshots` per guest and storage, read live; by-storage table; on ZFS restore to the newest only, with a held-copy undo; never deletes newer snapshots; unit 0's doctor checks storage; G4 | Section 2; G4; [screenshots](070-snapshots/new/32-zfs-older.png) |
| A restore loses idle threads' worktrees and sessions, a person's desktop, open terminals, not only working threads | Opus 3, Astra 7 | The guard reads `threadsOn`, control and terminals; the dialog lists each; an agent is refused while any is so; G5 | Section 5; G5; [screenshot](070-snapshots/new/09-restore-dialog.png) |
| An agent's restore of the box its thread runs on races its next turn | Opus 3, Astra 7 | Refused; the agent asks through the form; open question 2's default changed | Section 5; question 2 |
| `person_agreed` trusts the agent | Opus 4, Astra 9 | `bb.ui.requestInput` in the thread (worded after the second reviews as a yes given in the thread) | Sections 3 to 5; G11 |
| The limit can delete the restore's target; the undo uses up the 5; the default forces "restore without undo"; an agent could pass `undo: false` | Opus 5, Astra 3 | Undos apart (2 a box); targets, undos, in-use, kept and the person's never evicted; no agent bypass of the undo | Sections 4, 5, 8 |
| Fork safety per kind, not per box; QEMU's SMBIOS serial; Windows; `msb fork` copies memory; ordering | Opus 6, Astra 5 | `forkSafe` per snapshot; Windows and macOS no fork; microsandbox forks from a disk snapshot; systemd `Before=`, fail closed; a fork still holds project secrets (the detector replaced after the second reviews) | Section 9; G14 |
| A restore does not survive a restart; new-guest restores leave two guests; a Proxmox lock has no way out | Opus 7, Astra 6 | Operations recorded before each step, finished or reported by `#snapshotsCutShort`; `unknown` until observed; lock words with the host's command; G6, G7 | Section 6; [screenshots](070-snapshots/new/36-restart-unconfirmed.png) |
| No operation protocol: IDs, receipts, races, reservations, a full database | Astra 6, Opus 12 | Operations with request IDs, pinned snapshots, `#chain`, reservations in one transaction; a full `snapshots.db` refuses before any change; G9 | Sections 1 and 6; G9 |
| Thin storage fills after the take | Opus 8 | The sweep reads data and metadata use; refuses past 85%; deletes agents' unkept snapshots past 92% | Section 8; [screenshot](070-snapshots/new/39-storage-full.png) |
| A rollback puts back the guest's old size | Opus 9 | The plan says the size it goes back to; read back after; a restore across a disk grow refused until measured; G8 | Sections 2 and 5 |
| The ceiling can be passed with no take | Opus 10, Astra 10 | The ceiling bounds the monthly rate held, checked on take, undo, Keep, renewal and held copy; a ledger; never deletes; paid off until a real check; G10 | Section 8; [screenshot](070-snapshots/new/24-ceiling-passed.png) |
| No row for a box the thread runs on but does not own; an agent could delete the person's snapshots | Opus 11, Astra 9 | The table's middle row; agents delete only what an agent of their thread took and nobody kept | Section 3 |
| Races; undo names not unique | Opus 12 | `#chain`; release waits for a take; "before the restore at 01:56", with " (2)" | Sections 5 and 6 |
| Unit 1 too large; screens before safety | Opus 13, Astra 14 | Unit 0; the CLI in unit 1; restore's safety in unit 2; Settings before tools; forks before Keep; gates | Section 13 |
| Lost and unreachable confused; a lost database deletes kept snapshots | Opus 14, Astra 8 | `unavailable`, `lost` after two good listings, `incomplete`; keep dates in labels; orphans held 7 days; G1 to G3 | Section 1 |
| UI against the owner's guide | Opus 15, Astra 13 | Hover-only actions; no headless tiles; weight 400 for bb-box's classes; the 390 px header; the toast; numbers with Save; attention first; focus back | Section 12; [screenshot](070-snapshots/new/02-row-hover.png) |
| Rewriting the access file does not make a restore safe; memory restores revive credentials | Astra 4 | Said plainly; Settings can limit memory restores to the person (the network-down step was cut after the second reviews) | Sections 5 and 11 |
| What state is captured | Astra 11 | `scope`, `excludes`, `capturedAt`, `dependsOn`; Docker paused with its volume; no undo or Keep on boat's trial | Sections 1 and 2 |
| A changed `parent` does not prove a restore | Astra 12 | Rollback tasks from the node's task list | Section 4; G13 |
| CLI, refusals and consent as a trust boundary | Astra 9 | One `mayAct`; the CLI a trusted way around; refusals name only what the caller may see | Section 3; G12 |
| Five tools; pictures | Opus 16 | Kept apart, with why; pictures unchanged | Sections 4 and 10 |

### After the second reviews

(Unit numbers in this table are those of round 2; the identity reset was
made unit 2 after round 3, and the units after it moved up by one.)

The same two reviewers read the revision and ran its prototype again.
Both said: build after these changes. Their numbers are N1 to N8 in each
review; the lead's decisions are marked.

| Finding | Reviews | Change | Where shown |
| --- | --- | --- | --- |
| A held copy can start at the node's next boot, as its source: `onboot`, network settings and disk are copied | Opus N2, Astra N1 | A held copy is a full clone, disarmed (`onboot` 0, links down, a new SMBIOS UUID) and made a Proxmox template, which cannot start; each step recorded and finished at start; made only of `forkSafe` snapshots, so a copy started before its disarm resets before its network; excluded from start, warm, spare, leftover and template checks; G16 reboots the node | Section 2, "A held copy"; section 1; G16 |
| A running LXC cannot be cloned except from a snapshot, so the ZFS undo's order fails | Astra N2 | On ZFS: stop, copy the stopped guest, roll back; a failed copy starts the box again with nothing changed; ZFS restores off until G4 passes on a ZFS node | Section 2, "The ZFS order"; G4 |
| A ZFS undo strands the box's other snapshots and resets its identity; who owns the old guest | Opus N3, Astra N3 | Undoing is a swap (`adoptCopy`) that gives the new guest the box's MAC addresses and SMBIOS, so it stays the same BB machine; the old guest becomes the box's earlier guest, disarmed, its snapshots "fork only", deleted with its last snapshot or at release after their held copies; the dialog says how many stay there; G4 covers repeated undos, expiry, release and restarts on LXC and QEMU | Section 2, "Undoing a ZFS restore is a swap"; section 9; G4; [screenshot](070-snapshots/new/40-zfs-earlier-guest.png) |
| Keep can preserve a snapshot nothing can use after the release (Windows, an old image) | Astra N4 | Keep only where the snapshot's fork plan is `ok`; Windows `keepsPastRelease: no` until its reset; the row says why; G15 checks both refusals | Section 7; section 2's table; G15; prototype brisk-lake |
| An agent can answer the person's form itself (`bb thread interactions respond --self`) | Opus N1 (lead's decision) | Worded as "a yes given in the thread" in the form, its result and the log, never "your yes"; the skill forbids agents to answer bb-box's forms; request 38 asks BB to say who answered; G11 runs the CLI answer from the asking agent and records what happens; open question 4 | Sections 4, 5, 11; [request 38](../bb-requests.md#38-say-who-answered-a-plugins-form); G11; question 4; [screenshot](070-snapshots/new/34-person-form.png) |
| Consent does not close the execution race; a resumed daemon; scope changes while waiting | Astra N5 | The yes is bound to the plan and the box's generation, and asks again if the loss list changes; the restore runs as bb-box's own operation; turns on the box are held with the SDK's `message.dispatch` hook from the yes to ready, also after a restart; a turn that started anyway (Send now) stops the restore before anything changes; boxes threads run on are restored from disk only; G17, and the path stays off if G17 fails | Section 5, "Holding turns on the box"; G17 |
| The LXC hostname is not a fork detector (renames, shared names) | Opus N4 (lead's decision) | An identity marker bb-box writes and checks: `/etc/bb-box/identity` with the box ID and the MAC addresses; a boot unit resets when they differ, failing closed; clones get new MAC addresses, renames and restarts do not change them, and swaps set the box's own; G14 adds a renamed spare's restart and a fork with its source's name | Section 9; G14 |
| Access before the network cannot be built on LXC with this token; QEMU needs the guest agent and `VM.GuestAgent.FileWrite` | Opus N5, Astra N7 (lead's decision) | Cut from the first units: the access file is written over SSH as bb-box's first command after the box answers; what that leaves open is said; network-down repair is a later unit for QEMU, with the privilege and the guest agent | Section 5, steps and "What this does not do"; section 13, Later; G8 |
| Undo pruning and bulk actions bypass protection | Opus N6, Astra N6 | A new undo replaces only an undo that is not kept, pinned or a target, or a third is held until the restore ends; a kept undo is an ordinary kept snapshot; pins checked in one place for every path, bulk included; G9 adds the three sequences | Sections 6 and 8; G9; [screenshots](070-snapshots/new/41-undo-target-kept.png) |
| The undo's capture and the stop leave a gap | Astra 3 (round 2) | The undo is taken after the stop, so nothing written before the restore is in neither | Section 5, steps 4 and 5 |
| Outside rollback tasks counted as restores whatever their status | Astra 12 (round 2) | Logged by status: OK, failed or running; G13 adds the failed and running cases | Section 4; G13 |
| The prototype's form reported a restore its box did not show | Opus N7 | The form follows the restore's operation, and work-pc shows its notice and log | Prototype; [screenshot](070-snapshots/new/35-form-restored.png) |
| A tool's signal aborts on a thread's stop; its result starts a turn on a restored box | Opus N8 | The restore runs as bb-box's own operation; the form says the asking thread's next turn starts on the restored box, whose session went back too | Section 5 |
| A device restore's undo said "disk"; a kept memory snapshot's copy holds the disk only | Opus N8 | "device" for device snapshots; the row says "disk" from the release | Sections 7 and 12; prototype rosy-reef |
| The prototype: renewals over the ceiling, bulk Keep without its checks, fork eligibility from the box, Android as a whole box, focus from a menu, exclusions not shown | Astra N8 | Keep and renewal refused over the ceiling; bulk Keep through a dialog with the same checks; fork and Keep from the snapshot's `forkSafe`; Android a device snapshot with no fork and no Keep; focus back to the menu's button; exclusions in the restore dialog | Prototype; [screenshot](070-snapshots/new/43-keep-over-ceiling.png) |
| The prototype counted a ZFS held copy as a newer snapshot | Astra N2 | Held copies are left out of a rollback's ordering | Prototype tidy-glade |
| Unit 1 still large | Astra 14 (round 2) | Split into 1a (core and LXC with the CLI) and 1b (QEMU) | Section 13 |
| Weight 500 left in bb-box's own components | Astra 13 (round 2) | Said plainly: the style pass is not complete until the build moves them | Section 12, "Look and motion" |

### After the third reviews

Opus said build, with two points before units 2 and 6 of that round;
Astra said build after named changes, with the foundation free to start.
Their numbers are R1 to R6 in each review; the lead's decisions are
marked.

| Finding | Reviews | Change | Where shown |
| --- | --- | --- | --- |
| A held copy that booted before it was a template no longer holds the saved state (its reset removed the credentials); recovery finished it anyway | Astra R1 (lead's decision) | A copy that is not yet a template is never trusted: at start the sweep deletes it and makes it again from its source, which stays pinned until the copy is a template; G16 kills bb-box and reboots the node at that moment, and checks the remade copy's files through a fork | Section 2, "A held copy"; G16 |
| An earlier guest keeps the box's MAC addresses, so the marker would not stop it if started | Opus R1 | Its disarm also gives it new MAC addresses, so any start resets before its network; G16 checks its config and starts one by hand | Section 2, "Undoing a ZFS restore is a swap"; section 9's table; G16 |
| The marker must list only the backend's interfaces, or every Docker or tailnet box resets at each boot | Opus R2 | Only the interfaces the backend gives (`ethN` of `netN` on LXC; those with a device under `/sys/class/net` on QEMU and Tart) are written and compared; G14 restarts a `linux-docker` box with containers and a tailnet box three times each without a reset | Section 9; G14 |
| BB's orphan sweep releases held turns if bb-box stops | Opus R3 | Named in section 5; the operation holds the turns again and checks for a running turn before its next step after a restart; G17 includes it | Section 5, "Holding turns on the box"; G17 |
| "Send now" can start a turn after the final check, or while the box reconnects | Astra R2 (lead's decision) | Execution-machine restores ship off, on the page, the form and the CLI; they turn on only when G17 passes with Send now after the final check and during reconnection, and a restart; the units say so | Section 5, "Restores of execution machines ship off"; section 13; G17 |
| Clones of a held copy inherit its disarm | Opus R4 | A fork and an `adoptCopy` set `onboot` back and their links up before the first start; G4 and G14 check it | Section 2, "Cloning a held copy re-arms the clone"; G4, G14 |
| The sweep deleted a restore's target and a newly kept snapshot; bulk Keep and Rename touched pinned targets; Check now left the undo pinned | Astra R3 (lead's decision) | One `eligible(snapshot, change)` check, called at the moment of each change on the box's chain, by every path including the sweep, the limit, undos, bulk actions, Keep and Rename; pins end together with their operation, Check now included; G9 adds the sweep, bulk Keep and Rename sequences | Section 6; G6, G9; prototype, [screenshot](070-snapshots/new/44-sweep-spares-protected.png) |
| A paid undo bypassed the ceiling | Astra R4 (lead's decision) | A restore's undo is admitted like any snapshot, its space and price reserved before the box stops; refused, an agent's restore is refused and the person may untick the undo; G10 adds it | Section 5, step 4; section 8; G10; [screenshot](070-snapshots/new/45-paid-undo-refused.png) |
| Held copies need the identity reset, which came in unit 6 | Astra R5 (lead's decision) | The identity reset is unit 2, on its own, before any held copy or fork, with why; the units after it move up by one | Section 13 |
| One hard stop for every backend is wrong for Tart's memory undo and Android's device restore | Astra R5 | A capture order per backend: stop on Proxmox, suspend on Tart macOS, shutdown on Tart Linux, a live capture then swap on microsandbox, boat and Docker, the device only on Android; what each loses is said | Section 5, the capture order |
| Mixed bulk Keep costs; Android's dialog promised and denied the host's disk; Fork's focus at 390 px | Astra R6 | Bulk Keep says each snapshot's own cost (a held copy's size, a daily price); a device restore names only what the device loses; every row dialog returns focus to its opener, or to the row's menu button when opened from the menu | Section 5; section 12; prototype |
| Open questions | Lead | Two left that are the owner's: the ceiling, and the form's yes; the others settled | Open questions |

### After the fourth checks

Both reviewers' fourth checks said build. A last patch, with the owner's
answers, and no new review round:

| Finding | From | Change | Where shown |
| --- | --- | --- | --- |
| Section 6 still said an unfinished held copy is disarmed and made a template | Lead | It now gives section 2's rule: deleted and made again from its pinned source, never finished or adopted | Section 6, "After a restart" |
| G16 read a held copy's files through a fork, whose reset removes BB's identity and access by design | Lead | The remade copy is checked through `adoptCopy` for the same box, which keeps the box's MAC addresses so no reset runs: its files, credentials, host ID and access file are the source's; the fork's reset is checked apart | G16 |
| At 390 px, cancelling Fork or Keep opened from a row's menu left focus on the page | Lead | Dialogs opened from the menu return focus to the menu's button; the menu returns focus itself when it opens no dialog | Prototype |
| An undo refused for lack of room said to raise the ceiling | Lead | Each refusal names its own fix: for room, the snapshots on that storage whose deletion would free it; for price, the ceiling | Section 5, step 4; prototype |
| The paid ceiling | Owner | A setting the person sets per provider, $5 a month by default, in Settings, Snapshots, Paid snapshots; the refusal's words written in | Section 8; section 12, Settings; The owner's answers |
| Restores of machines threads run on | Owner | Both ways: the person from the box's page, and an agent through the form, recorded as "a yes given in the thread"; an undo always taken, with no way to untick it; off until G17 passes; once request 38 lands, the record names who answered; G11 checks the undo too | Sections 3, 4, 5, 11; G11; The owner's answers; [screenshot](070-snapshots/new/34-person-form.png) |
| The prototype's box log said a form's restore was "by you" | Found while patching | A form's restore, its undo and its notice say "on a yes given in (thread)", never "by you" | Prototype; [screenshot](070-snapshots/new/35-form-restored.png) |
