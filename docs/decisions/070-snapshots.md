# 070: A box's snapshots are bb-box's own records, taken by each backend's own mechanism, and kept with the box unless the person keeps them

Status: proposed, 30 October 2026, with the owner's answers to the
research's four questions built in. Revised the same day after two
independent reviews; every finding of both is answered in [What changed
after the reviews](#what-changed-after-the-reviews). Not built yet: see
[How it is built](#13-how-it-is-built) and its [gates](#gated-in-unit-n).

Research: [Snapshots of boxes](../research/box-snapshots.md), with its
measurements on Proxmox LXC and QEMU, Docker, Tart, microsandbox, boat.dev,
Hetzner, Namespace and device boxes. This note does not repeat them; it
cites them where a rule depends on a number. The research measured
Proxmox on LVM-thin only; what this note says of other Proxmox storage is
from Proxmox's own code, and unit 0 and unit 2 measure it.

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
`planResize` does.

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

### What bb-box knows today

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
- The SDK bb-box pins (0.6.15) has `bb.ui.requestInput`: a form in the
  thread that only the person can submit. Called from a tool, the agent
  gets a waiting notice at once; bb-box's server gets the submitted value,
  and the tool's result reaches the thread as a message. It is cancelled by
  a timeout (10 minutes by default, at most an hour), a stop of the thread,
  or a restart of BB's server.
- A Proxmox QEMU box's SMBIOS carries its address and a random UUID that
  each clone gets anew (`smbios1For`); an LXC box's hostname is its name,
  unique among the install's boxes. Neither is the box ID.

## Decision

### 1. A snapshot is a record of bb-box's

bb-box keeps one list of snapshots across every backend, in a file of its
own, `snapshots.db`, attached to the SDK's database as 069 attaches
`box-log.db`, with its own migrations and write-ahead log. Its records and
its operations (section 6) are never evicted; pictures are kept in a table
of their own, capped at 48 MB, and the oldest pictures of snapshots that
are not kept go first. If the file cannot be written, every operation that
would change a box is refused before it starts, and the doctor says so.

| Field | Type | Example | Notes |
| --- | --- | --- | --- |
| `id` | `sn` and 12 letters and digits | `sn7kq2m9xa4pd` | bb-box's, never the provider's |
| `box` | ID, name, kind, system, thread | `bxamberfox2q7k`, amber-fox, `linux-desktop` | copied at the take, so a kept snapshot still names its box after the release |
| `boxGone` | time and how, or null | released 12 Oct | set when the box is released or forgotten |
| `backend`, `host`, `storage` | backend ID and label; host; storage name and type | `proxmox-lxc`, pve-1, `local-lvm` (`lvmthin`) | where it is; usable only there |
| `name` | text, at most 60 characters, unique per box | "before the migration" | given, or the time ("Thu 10:42"); a repeat gets " (2)" |
| `note` | text, at most 1 KB, or null | | |
| `takenAt`, `capturedAt`, `tookMs` | times; duration | 10:42:07; 10:42:07; 680 ms | `capturedAt` is the moment the state is from, which can be earlier than the take (boat's background capture) |
| `by` | an `Actor`, as the box log's | the agent in "Fix the sign-in flow" | |
| `scope` | `box` or `device` | `box` | `device`: an Android emulator's own snapshot, which restores the device and nothing else in the box |
| `holds` | `disk` or `disk-and-memory` | `disk` | what a restore brings back |
| `excludes` | words, or null | "/tmp, caches, SSH host keys" | from the backend; shown on the row's details and in the restore dialog |
| `size` | bytes and what they mean, or null | 1.2 GB, `own` | `own`: what deleting it frees; `whole`: what it holds, some shared with the box; null: unknown, shown as unknown |
| `price` | amount, currency and period, or null | $0.056 a day | null where it is on the person's own storage; unknown prices are shown as unknown, never as free |
| `owner` | `thread` or `person` | `thread` | see [section 3](#3-who-may-do-what) |
| `keptUntil`, `keptAt` | times, or null | 29 Nov | set only by the person; the snapshot is then the person's |
| `undoOf` | an operation ID, or null | the restore at 11:02 | marks an undo, which section 8 counts apart |
| `forkSafe` | the reset version found in the box's image at the take, or null | 1 | see [section 9](#9-a-fork-is-a-new-box-with-a-new-identity) |
| `dependsOn` | snapshot IDs, or none | | microsandbox's chain: a snapshot others depend on cannot be deleted first |
| `picture` | the picture's state | `taken`, `none` (headless), `off`, `failed` | the image is in its own table, see [section 10](#10-a-picture-of-the-screen) |
| `ref` | the backend's reference | `bbsn7kq2m9xa4pd` on Proxmox | opaque to the core |
| `copy` | the held copy's reference, or null | VMID 9214 on pve-1 | Proxmox's way to keep past a release, see [section 7](#7-keep-and-what-it-costs-on-each-backend) |
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
| `ready` | it can be restored, forked, kept, renamed and deleted | `deleting`; `unavailable`; `lost` |
| `failed` | the take failed and nothing is held | removed after 24 hours; shown on the box's page until then |
| `incomplete` | part of it exists (Proxmox `snapstate=prepare` or `delete`, a half-written copy) | the person's Delete, which finishes the backend's own cleanup; never restored or forked |
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
  <box> snapshot <id> kept <date>`, and a held copy's tags. On a Mac: a
  label file in the snapshot's folder. On boat: the saved snapshot's name.
  Labels carry IDs and dates only, never names, notes or secrets.
- `heldSnapshots()` lists a backend's snapshots of this install. At start
  and at each sweep bb-box compares it with its records:
  - a record whose snapshot is missing from a successful listing, twice,
    becomes `lost`;
  - a labelled snapshot with no record, of a box that still exists, gets a
    record again (`by` unknown, name from the time);
  - a labelled snapshot of a box that is gone, whose label has a keep date
    not yet passed, gets a record again as kept;
  - a labelled snapshot of a box that is gone, with no keep date, is listed
    as "Found on pve-1, not in bb-box's records" for 7 days, then deleted.
    It is never deleted at once, so a lost `snapshots.db` loses no kept
    snapshot.

### 2. What a backend offers, and what it plans for one box

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

**What it plans for one box**, read live from the guest and its storage,
before anything changes, and changing nothing. Every dialog, every tool
call and every CLI command asks for a plan first, and acts only on what it
says:

```ts
interface SnapshotPlan {
  readonly storage: { readonly name: string; readonly type: string; readonly percentFull: number; readonly metadataPercentFull: number | null };
  readonly take: { readonly ok: boolean; readonly why: string | null; readonly aboutMs: number; readonly memoryAboutMs: number | null; readonly addsBytes: number | null };
  readonly restore: { readonly way: "rollback" | "rollback-newest-only" | "new-guest" | "none"; readonly why: string | null; readonly undo: "snapshot" | "held-copy" | "suspend-copy" | "none"; readonly undoAboutMs: number; readonly undoBytes: number | null; readonly sizeBack: BoxSize | null };
  readonly keep: { readonly way: KeepsPastRelease; readonly aboutMs: number | null; readonly bytes: number | null; readonly price: Price | null };
  readonly fork: { readonly ok: boolean; readonly why: string | null; readonly aboutMs: number; readonly bytes: number | null };
  readonly locked: { readonly lock: string; readonly fix: string } | null;
}

planSnapshots?(guest: Guest, kind: string, snapshot: SnapshotRef | null, signal?: AbortSignal): Promise<SnapshotPlan>;
```

On Proxmox the plan is one call for the guest's config (its root disk's
storage, its lock, its current size and its snapshots' sizes and parents)
and one for the storage's status, both of which the token can read; the
storage's type is read once when the backend starts. A time is the
measured rate times what this box holds: a memory snapshot "about 1 s per
GiB of memory" from the research's 3.7 s for 4 GiB, so a 16 GiB VM says
"about 15 s", not 3.7.

The operations, each only where the plan says it can:

```ts
snapshot?(guest: Guest, take: SnapshotTake, signal?: AbortSignal): Promise<SnapshotTaken>;
restoreSnapshot?(guest: Guest, ref: SnapshotRef, step: RestoreStep, signal?: AbortSignal): Promise<RestoreProgress>;
forkSnapshot?(ref: SnapshotRef, box: BoxIdentity, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest>;
holdCopy?(ref: SnapshotRef, label: HeldCopyLabel, signal?: AbortSignal): Promise<SnapshotRef>;
deleteSnapshot?(ref: SnapshotRef, signal?: AbortSignal): Promise<void>;
heldSnapshots?(signal?: AbortSignal): Promise<readonly HeldSnapshot[]>;
providerTask?(ref: TaskRef, signal?: AbortSignal): Promise<TaskOutcome>;
```

`restoreSnapshot` runs one step at a time (section 6), so bb-box records
each before the next. `providerTask` reads a provider's task by its
reference (a Proxmox UPID) after a restart.

#### Restore by storage, on Proxmox

Proxmox decides per storage whether a rollback may go past newer snapshots
(`volume_rollback_is_possible` in its storage plugins):

| Storage | Restore to | The undo | Notes |
| --- | --- | --- | --- |
| LVM-thin, Ceph RBD, qcow2 files (directory, NFS, CIFS), BTRFS | any snapshot | a snapshot, taken first | measured on LVM-thin by the research; the others in unit 2 |
| ZFS | the newest snapshot only | a held copy of the box as it is, taken first: a full clone into a stopped, labelled guest, which is not a snapshot and so does not block the rollback | an older snapshot is not restored in place: the plan says "pve-3 uses ZFS, which restores only the newest snapshot. Fork this one, or delete the 2 newer ones yourself first". bb-box never deletes newer snapshots to make a rollback possible |
| LVM (thick, VMs only, a preview in Proxmox VE 9) | none in the first units | | the doctor says so |
| a directory of raw files | none: it takes no snapshots | | the doctor says so |

The held copy costs the box's used disk in space and about 9 s for each
4 GiB used (the research's full clone, 9.3 s for 4 GiB on LXC, 6.5 s on
QEMU), and the restore dialog says both before the person confirms. It is
listed as the undo, and a restore to it swaps it in as the box's guest, as
a new-guest restore does (section 5).

#### What each backend fills in

| Backend | `scope`, `holds` | `whileRunning` | `restore` | The undo | `fork` | `keepsPastRelease` | `price` | Unit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Proxmox LXC | box; disk | live (0.7 s) | in-place, after a hard stop; by storage, above | a snapshot, or a held copy on ZFS | copy (9.3 s for 4 GiB used) | held-copy | none | 1, 2, 6, 7 |
| Proxmox QEMU, Linux | box; disk, or disk and memory | live (1.1 s); memory about 1 s a GiB | in-place; by storage | as LXC | copy (6.5 s) | held-copy, disk only | none | 1, 2, 6, 7 |
| Proxmox QEMU, Windows | box; disk | live | in-place; by storage | as LXC | none until a unit builds Windows' reset | held-copy | none | 2; forks later |
| Tart, macOS | box; disk and memory only | suspends (about 7 s, then resumes) | in-place: puts a copy back, then resumes (11 s) | a copy of the suspended VM, memory included | copy from the disk, new MAC address, once unit 8 builds macOS's reset | as-is: the copy stays on the VMs' volume; once the VM is deleted it holds its whole size | none | 8 |
| Tart, Linux | box; disk | stopped-only | in-place | a copy, after the stop the restore makes anyway | copy | as-is | none | 8 |
| microsandbox | box; disk, or disk and memory | pauses (0.3 s; memory 1.5 s) | new-guest (3.9 s) | a snapshot | copy: a disk snapshot restored as a new sandbox; never `msb fork`, which copies memory | as-is, confirmed in unit 9 | none | 9 |
| boat.dev, paid plan | box; disk | live; `capturedAt` is the fresh capture a saved snapshot makes | new-guest | a saved snapshot | copy | as-is | $0.056 a day past the plan's | 10 |
| boat.dev, trial | box; disk | | none: no saved snapshots on the trial, and a stopped fork's capture can be a minute old, so it cannot be an exact undo | | copy, of the newest capture | no | | 10 |
| Docker on a host of the person's | box; disk, with the box's own Docker volume, both captured while the container is paused | pauses (15 s for 1 GiB changed) | new-guest | a snapshot | copy | as-is | none | 11 |
| Hetzner, Namespace Linux | box; as Docker | pauses | new-guest | a snapshot | copy | no: Hetzner deletes a host with no boxes, and Namespace an instance at release | none | 11 |
| Android emulator (in its box) | device; the device's disk and memory | live (14.8 s) | in-place, the device only (3.2 s) | a device snapshot | none | no | none | 12 |
| SSH host pool, iOS slots, Namespace macOS | none | | | | | | | none |

Never on a shared host to act on one slot: no snapshot or restore of a
whole Mac or Hetzner host stands in for one box's.

### 3. Who may do what

One permission check, `mayAct(caller, operation, snapshot or box)`, serves
every tool, RPC, CLI command and picture, using the caller's thread from
BB's tool context, never a parameter. It is tested with guessed IDs and
calls across threads.

| Box | Owner of its snapshots | Take | See | Restore | Fork | Delete | Keep |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A thread's box | the thread | its agent; the person | its agent; the person | its agent, without asking, with an undo, unless its thread runs on it (below); the person | its agent, into its thread; the person | its agent, only what an agent of its thread took and nobody kept; the person | the person |
| The box a thread runs on but does not own: another thread's box, or one of the person's machines (036) | the box's thread, or the person | that thread's agent | that agent, only what it took there | only the person, in the box's page, or through the form an agent opens (section 5) | the person | that agent, only what it took there and nobody kept; the person | the person |
| A kept snapshot | the person, from the moment it is kept | | the person; the thread's agent while its box lives, without its picture | the person | the person, as a machine of theirs | the person | the person |

- No thread sees another thread's snapshots in anything an agent can
  read. A refusal for room names only the snapshots the caller may see,
  and says "and others you cannot see" for the rest.
- The CLI is the person's tool and a trusted way around these rules, as
  `bb box stop` is today: bb-box cannot tell who typed a command. The note
  claims isolation between threads, not against the CLI.
- Projects own none in the first units: a state shared across a project's
  threads is what a project's image is for (049).

### 4. The agent's tools, the CLI and the box log

#### Tools

| Tool | Parameters | Does | Answers |
| --- | --- | --- | --- |
| `box_snapshot` | `box`, `name`, `note`, `memory` (default false) | takes one; on a Tart macOS box, where every snapshot holds memory, refuses `memory` false and says to pass true | its name and ID, what it holds and leaves out, its size where known, how long it took, its price if any, and "3 of 5 for this box" |
| `box_snapshots` | `box` (optional), `pictures` (default false) | lists a box's, or every box's of the thread, that the thread may see | per box, what its snapshots hold or that it has none; per snapshot: name, ID, when, by, holds, size, price, kept; pictures as images only when asked |
| `box_restore` | `box`, `snapshot`, `replace` (must be true), `request` (an ID the agent makes, so a repeat is the same restore) | restores the box, as section 5 says. An undo is always taken: there is no way for an agent to restore without one | what it replaced, the undo's name, whether processes ended or memory came back, size changes, and the box's state. On a box its thread runs on: the waiting notice of the person's form |
| `box_fork` | `snapshot` or `box` (the box now), `name` | a new box of the thread from a snapshot, or from the box now, for which it takes a snapshot first, named "for a fork" | the new box, as `box_acquire` answers, and "forked from amber-fox at 10:42" |
| `box_snapshot_delete` | `box`, `snapshot` | deletes one the thread may delete | what it freed, where known |

`snapshot` takes a snapshot's name or ID. A tool never keeps a snapshot.
Five tools is three more than the smallest set (`box_snapshot` could take
an action for list and delete); they stay apart because each says one
thing an agent does, as `box_stop` and `box_start` do, and the owner can
ask for fewer.

The skill tells the agent: take one before a change it cannot undo, such
as a migration, an upgrade, a deletion or a change to the system; take one
when the person asks; never on a schedule of its own; restore when an
attempt went wrong rather than undoing by hand; delete its own when they
are no longer needed; and on the box it runs on, ask through the form and
end its turn.

#### The CLI

For the person and their scripts, as `bb box stop` is:

```
bb box snapshot take <box> [--name <name>] [--note <text>] [--memory]
bb box snapshot list [<box>] [--kept] [--json]
bb box snapshot delete <box> <snapshot>
bb box snapshot restore <box> <snapshot> --replace [--no-undo] [--force]
bb box snapshot fork <box> <snapshot> [--machine | --thread <thread>] [--name <name>]
bb box snapshot keep <box> <snapshot> [--days <n> | --until <date>]
bb box snapshot unkeep <box> <snapshot>
bb box snapshot rename <box> <snapshot> <name>
bb box snapshot note <box> <snapshot> <text>
```

`take`, `list` and `delete` come in unit 1, so it can be checked live
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
| `restore-asked` | the snapshot, the undo's name or "no undo", what the guard named | with "with your yes in (thread)" when the person submitted the form |
| `restored` | the snapshot, the time it went back to, size changes | a Proxmox rollback leaves no stop in the log; this event is what the box's page shows |
| `restore-failed` | the step it stopped at, the backend's words, and what bb-box then observed | as 069's G6 |
| `restored-outside` | the provider's task, its user and time | only from a provider's task record (below) |
| `fork-asked`, `forked`, `fork-failed` | the source and the new box | the new box's own log starts with `made`, from the source's snapshot |
| `snapshot-deleted` | its name, what it freed, why | why: by you, by the agent, the per-box limit, the host's storage nearly full, its keep ended, its box released |
| `snapshot-kept`, `snapshot-unkept` | until when | by the person only |
| `snapshot-lost`, `snapshot-unavailable` | its name, the backend's words | |

The box log is bounded and pruned (069). What must last, a restore's undo
and a person's yes, is also kept on the operation (section 6) for as long
as its snapshots live, and 30 days after.

**Restores made outside bb-box.** A changed Proxmox `parent` does not
prove a restore: a take and a delete change it too, and a second restore
to the same parent leaves it alone. So bb-box reads the node's task list at
each sweep, which the token's `Sys.Audit` on the node allows, and logs
`restored-outside` only for a `vzrollback` or `qmrollback` task on the
box's VMID that bb-box did not start, with the task's user and time. It
then sets the box straight as step 6 of a restore does. Without such a
task it claims nothing; a changed parent alone is logged as "its snapshots
changed outside bb-box", with no repair. Unit 2 tests an outside take, an
outside delete, two restores to one parent, and several changes between
sweeps.

### 5. A restore says everything it loses, and takes an undo first

#### Who restores, and how

- **An agent, on a box of its thread that its thread does not run on**:
  without asking the person, with `replace: true`. The undo is always
  taken; if it cannot be, the restore is refused. When Settings turns
  "Agents may restore their own boxes" off, the agent asks through the
  form below instead.
- **An agent, on the box its thread runs on**: never by itself. Its own
  worktree and session are on that disk, and BB may start its next turn
  (a queued message, a task's follow-up) while the restore runs. The tool
  opens a form in the thread with `bb.ui.requestInput`, which only the
  person can submit, and answers at once: "I asked you to restore dev-desk
  to 'before the upgrade'. End your turn now: nothing you do on dev-desk
  after this survives the restore." This is also the only way an agent
  restores one of the person's machines, as the owner asked: never without
  a yes in the thread.
- **The person**, from a box's page or the Snapshots tab, through the
  restore dialog; or by submitting an agent's form.

The form shows what the dialog shows (below), with Restore and Cancel. On
Restore, bb-box records the person's yes on the operation, waits up to 2
minutes for every thread on the box to be idle (the form's row says
"Waiting for Clean up the disk to finish its turn"), then runs the restore
as the person's, taking the undo at that moment, not when it was asked.
If a thread is still working after 2 minutes, a person holds the desktop
or a terminal is open, it restores nothing and says why in the row. The
box log says "Restored by you, with your yes in Clean up the disk". A
timeout, a stop of the thread or a restart of BB's server cancels the form
and nothing happens.

#### What a restore does, in order

1. **Plans** (section 2). Refuses what the plan refuses: a snapshot that is
   not `ready`, a snapshot of another box (it is forked instead), a target
   ZFS cannot roll back to, a box that is stopping, starting, restoring,
   being resized or released, a box whose snapshot is being taken or whose
   target is being deleted, a guest Proxmox has locked (with the words of
   [section 6](#6-every-change-is-an-operation-recorded-before-it-starts)).
2. **Guards everything it would lose.** A restore rolls back the whole
   disk, so it reads what is on it now, from `threadsOn`, not `checkInUse`:
   - every thread, working or idle, with a workspace on the box's BB
     machine: its worktree, its uncommitted files and its agent's session
     files go;
   - a person holding the desktop's control, as `checkRestart` checks;
   - BB terminals open on the box;
   - for a memory snapshot, nothing in that list comes back as it is now.

   An agent's restore is refused while any of these is so, except its own
   thread's workspace on its own box when its thread does not run on it.
   The person's dialog names them all, and goes on only with "Restore
   anyway".
3. **Takes the undo**: as the plan says, a snapshot, or on ZFS a held copy,
   or on Tart macOS a copy of the suspended VM. It is named "before the
   restore at 11:02", with " (2)" if that name is taken. It holds the disk,
   except on Tart macOS, where it holds memory too. Until it is confirmed
   `ready`, nothing changes. If it cannot be taken, the restore stops and
   says why. Only the person can restore without an undo, and only by
   unticking it, which turns the button red.
4. **Records** the operation's next step, and logs `restore-asked`.
5. **Restores**, step by step, each recorded before it runs (section 6):
   Proxmox stops the guest hard first (1.3 s; `pct rollback` on a running
   container shut it down for 45 s), rolls back, and starts it with its
   network link down, or resumes it for a memory snapshot. A new-guest
   restore (microsandbox, boat, a ZFS undo) stops the old guest hard before
   the new one starts, so the box never has two live guests, then swaps the
   record's guest in one write.
6. **Sets the box straight**, before it says ready:
   - reads the box's size back from the guest, as `resize` does: a
     snapshot holds the guest's cores and memory as they were, and the
     dialog said so beforehand ("amber-fox goes back to 4 cores and 8 GiB
     memory, as it was then"). A restore to a snapshot from before a disk
     was grown is refused until unit 2 has measured what Proxmox does with
     the file system;
   - writes the box's labels again (Proxmox tags and description, which a
     rollback puts back as they were), as a relabel does (036);
   - writes the access file from the thread's current access, `env` on
     Linux and macOS and `env.ps1` on Windows, through the guest's console
     or agent where its network is down, and then sets the link up;
   - clears BB's daemon lock and PID (017) and waits for the BB machine to
     come back, as `box_start` does; it is the same machine, with the same
     host ID;
   - joins the tailnet again if its node is gone (050).
7. **Logs** `restored`, and answers.

What this does not do, and the dialog says so:

- A disk restore and a disk undo bring back what was saved on the disk,
  not unsaved work in running apps, and not what the box did to the world
  since (a push, a message, an upload).
- A memory restore brings back running processes as they were, with the
  credentials they held then and their connections, as a Tart resume does
  today. bb-box cannot change a running process's environment. A token
  revoked since is refused upstream; one still valid upstream works in
  those processes. The dialog says this, and Settings can limit memory
  restores to the person.
- BB may give the restored machine a turn before step 6 ends. Pausing a
  machine's turns is BB's to offer; it is listed as a request to BB, and
  until then the box is `restoring` and box tools refuse it.

#### The person's restore dialog

```
Restore amber-fox to "before the migration"?

It goes back to yesterday at 23:39, 2 h 5 min ago. Everything on its disk
since then goes: files, installed apps and settings. amber-fox restarts,
so every process in it ends.

Also goes:
  · Fix the sign-in flow is working on amber-fox: its worktree, uncommitted
    files and session there.
  · Write the API guide is idle on amber-fox: the same.
  · You have control of its desktop.
  · A terminal is open on it.
amber-fox goes back to 4 cores and 8 GiB memory, as it was then.

[x] Take a snapshot first, "before the restore at 01:56", so you can undo
    this. About 1 s. Undos do not count against the 5 for amber-fox.

                                   [Cancel]  [Restore amber-fox anyway]
```

- On ZFS the undo line says "Copy amber-fox as it is first, so you can
  undo this: about 20 s and 9 GB on pve-3".
- A memory target says "amber-fox comes back running, as it was then, with
  the credentials its apps held then. Undo brings back its files, not its
  running apps."
- The button says "Restore amber-fox" when nothing more goes, "Restore
  amber-fox anyway" when the list is not empty, and "Restore without undo",
  in red, when the undo is unticked.
- After a restore, the box's page shows a notice for 24 hours: "Restored at
  11:02 to 'before the migration', taken yesterday at 23:39, by you. Undo
  restores 'before the restore at 11:02'." Undo opens the same dialog for
  the undo. A toast says it once only when the person is not on the box's
  page.

### 6. Every change is an operation, recorded before it starts

Take, restore, fork, delete, keep's held copy and expiry are operations.
Each is a row in `snapshots.db` before anything changes, as a resize is a
`ResizeRecord`:

| Field | Notes |
| --- | --- |
| `id` | `op` and 12 letters and digits; a tool's `request`, or the dialog's, makes a repeat return the same operation |
| `kind`, `box`, `snapshots` | the snapshots it uses are pinned: none can be deleted, expired or evicted while it runs |
| `by`, `consent` | the actor; for a form, the person's submit and its time |
| `undo` | the undo's snapshot ID, once taken |
| `guests` | the old and the new guest of a new-guest restore or a held copy |
| `step`, `task` | the step it is at, and the provider's task reference (a Proxmox UPID) |
| `state` | `running`, `done`, `failed`, or `unknown` until bb-box has observed the outcome |
| `reserved` | the storage and the price it reserved (section 8) |

- **One at a time per box.** Every snapshot operation runs on the box's
  `#chain` with its start, stop, resize and release. A release waits for a
  take that is running, then deletes what it made. Two takes on one box
  run one after the other. A restore waits for a take, and refuses while
  its target is deleting. A fork pins its source.
- **After a restart.** At start, the sweep's `#snapshotsCutShort` reads
  every operation not `done` or `failed`, asks the provider's task where it
  has one, observes the guest, and finishes it from the step it reached or
  marks it `failed` with what it found. A new-guest restore cut short keeps
  the guest the record names and stops the other; neither is released as a
  leftover until the operation is settled. What cannot be confirmed stays
  `unknown`, and the box's page says "bb-box could not confirm the restore
  of amber-fox: it was rolling back when bb-box restarted", with Check now.
- **A locked guest.** Proxmox can leave a guest locked (`snapshot`,
  `rollback`, `backup`) when a task dies, and only root can unlock it.
  bb-box refuses the operation with the lock and the command for the host,
  "Run `pct unlock 214` on pve-1", on the page, in the tool's answer and in
  the doctor.
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

Keep is offered only where it can last, and the Keep dialog says what it
costs on that backend before the person confirms:

| Backend | How a kept snapshot outlives the release | What Keep costs |
| --- | --- | --- |
| Proxmox LXC and QEMU | **A held copy.** At the release, before the guest is deleted, bb-box clones the kept snapshot in full into a new stopped guest, tagged as a held copy with the install, box, snapshot and keep date. The sweep adopts held copies and never releases one as a leftover; it deletes one at its keep date. A memory snapshot's copy holds the disk only | At the release: about 9 s for each 4 GiB used, and the snapshot's used disk in space (the dialog says "13 GB on pve-1"), plus a VMID from bb-box's range, until the keep date |
| Tart | As is: the snapshot's folder stays beside the VMs; bb-box deletes the VM only | Nothing at the release; then its whole size, up to the VM's disk, as APFS no longer shares its blocks |
| microsandbox | As is, if unit 9 confirms a snapshot outlives its sandbox; otherwise no Keep | |
| boat.dev, paid | As is: a saved snapshot never expires | its daily price, until the keep date |
| Docker on a host of the person's | As is: the commit and the volume's copy stay on the host | their size |
| boat.dev trial, Hetzner, Namespace, Android devices | **No Keep.** A stopped fork lasts 14 days; a Hetzner host and a Namespace instance go when their boxes go; a device snapshot lives in the box | |

- **Keep is confirmed only when it will last.** Keep is a promise the
  release must keep: a release of a box with kept snapshots first makes
  each held copy, and the release does not delete the guest until every
  copy is `ready`. If a copy fails, the release stops as "Release did not
  finish: bb-box could not copy 'Thu 09:15' (pve-1 has 6 GB free, and it
  needs 13 GB)", with Release again and "Release and delete it". Nothing
  kept is ever deleted without the person's word, and 30 days is never
  silently shortened.
- **A held copy needs room and a VMID.** The plan checks both when the
  person keeps a snapshot, and the Keep dialog warns if, at today's size,
  there would not be room.

### 8. Limits, room and cost

- **Per box: 5 snapshots, undos apart.** Kept ones count. Undos do not:
  each box has room for 2 undos of its own besides, and a third undo
  replaces the oldest, once the new one is `ready`. So the default never
  forces a restore without undo.
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
  provider charges, every row says the price, and Settings has a ceiling a
  month per provider, in its currency, and its account. It is an admission
  limit on the rate, not a cap on the bill:
  - the rate is every paid snapshot held, kept or not, undos and held
    copies included, times its daily price, times 30;
  - a take, an undo, a Keep, a renewal and a held copy are refused when
    they would bring the rate past the ceiling, with the rate and the
    ceiling;
  - when the rate passes the ceiling without a take (a lower ceiling, a
    price or a plan that changed), bb-box refuses new paid snapshots and
    warns on the tab and in Settings; it never deletes kept data to get
    under it;
  - this month's spend so far is a ledger that keeps deleted snapshots'
    charges, shown beside the rate;
  - a price bb-box does not know is shown as unknown and admitted only by
    the person.
  - Paid snapshots stay off until a live check on a real paid plan passes
    (unit 10). A fake priced backend proves the arithmetic only.

### 9. A fork is a new box with a new identity

- **What it is**: a new box from a snapshot, of the same kind and at least
  the same size, on the same host or account, with a new name and box ID.
  An agent forks into its own thread; the person forks into the box's
  thread or as a machine of their own. A kept snapshot of a released box
  forks as a machine of the person's. Forks into another thread, chosen by
  the person, are later.
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
  `ssh.service`, `tailscaled.service` and `user@.service`. If it cannot
  tell whether the box is a fork, it fails closed: it removes the identity
  anyway, so a box that was not a fork merely enrols again (026).
- **How a guest knows it is a fork**: by a value the backend gives each
  guest that a fork never shares with its source, compared with the value
  it last booted with, kept in `/etc/bb-box/booted-as`. It is a change
  detector, not an identity:

  | Backend | The value |
  | --- | --- |
  | Proxmox QEMU | the SMBIOS UUID, which `smbios1For` makes anew for each clone |
  | Proxmox LXC | the hostname, which is the box's name, unique among the install's boxes |
  | Tart | the MAC address, which a fork gets anew |
  | microsandbox, boat, Docker | an environment value bb-box sets on the new guest |
  | Windows, macOS | none in the first units: no fork |

- **Per box, not per kind.** The reset is in a box's image, so a box made
  from an older template has none. bb-box reads `/etc/bb-box/fork-reset`
  (a version) from the guest at each take and keeps it on the snapshot as
  `forkSafe`. A snapshot without it does not fork, and says "amber-fox was
  made from an image without the fork reset: release it and make a new box
  to fork from it".
- **Then it enrols** under its own box ID as a new BB machine, and gets its
  thread's access, or the person's. bb-box does not say a fork is ready
  until it has checked, through the fork's own transport, that each item
  of the table is new or gone.
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
  holds, and before a memory snapshot pauses or suspends the box. It is
  labelled "the screen around 10:42", never as proof of what was saved. It
  waits at most 2 s; a picture that fails or is late never fails or slows
  the snapshot.
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
2. A restore writes the thread's current access before the box's network
   is up (section 5, step 6). A memory restore cannot reach running
   processes, and says so.
3. A fork drops its source's identity before anything can use it, and only
   from an image that has the reset (section 9).
4. A kept snapshot outlives its thread, and its held copy is a stopped
   guest that never starts. The Snapshots tab says it holds "files and
   access from the thread". A fork of it gets the person's access, never
   the old thread's.
5. Memory snapshots are by choice (question 2), except on a Tart macOS box,
   where every snapshot holds memory and the dialog says so.
6. Nothing is shared through a provider: boat's share codes and an
   organisation's shared snapshots are not used.
7. Pictures are as secret as their snapshot, and can be turned off.
8. Labels on the provider carry IDs and dates only.
9. A person's yes is a submit in BB's form, which an agent cannot make,
   and is kept on the operation.

### 12. The pages

#### The Snapshots tab, on the Boxes page

A third tab, after Machines and Threads, with its count. Its path is
`/plugins/bb-box/desktop/snapshots`, as `threads` and `machines` are, and
it keeps its search, filters, sort and scroll as 069's G9 keeps the list's.

```
Machines 2   Threads 7   Snapshots 14                           [⚙] [+ New box]
14 snapshots, 9 by agents · 38 GB on 3 hosts · boat.dev $3.36 a month held
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

- **The line under the tabs** says the count and how many by agents, the
  space by host where known, and for each paid provider its monthly rate
  held. What needs the person comes first, in amber: keeps that end within
  7 days, failed takes, hosts that cannot take snapshots, storage past 85%,
  a rate past its ceiling.
- **Grouped by box**, in hairline cards as the Threads tab's. The card's
  head names the box (a link to its page), its kind badges, where it lives,
  and its thread (a chip that opens it) or "Your machine". A released box's
  head says "released 12 Oct".
- **A row**: the picture, for a box with a screen; the name, with badges
  for `Memory`, `Kept` and `Undo`; then one line. What needs attention
  comes first: a failure, `unavailable`, or a keep ending within 3 days in
  amber. Then when, by whom, what it holds, its size where known, its price
  where any, and its life, "goes with the box" or "kept until 29 Nov". A
  `taking` row has a spinner. No chevron: a snapshot has no page of its
  own.
- **Actions**: Restore and Fork as icon buttons, and the menu (Rename…,
  Note…, Keep…, Stop keeping, Copy ID, Delete…). On a desktop they show on
  the row under the pointer or with focus inside it; on a touch screen and
  below 640 px they always show, and Fork moves into the menu there. While
  the box is restoring or the snapshot is in use, Restore, Fork and Delete
  are disabled, with why.
- **Select**: a Select button beside Sort shows a checkbox on each row;
  with some ticked, a bar offers Keep… and Delete…, with what they free.
- **Filters**, with counts: Where (each backend and host), Holds, Taken by
  (you; agents), Kept, Goes within 7 days. **Sort**: newest, oldest,
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
- A box whose plan cannot take one now says why, with Take snapshot
  disabled: "pve-2's token cannot take snapshots. Fix it in Settings.",
  "Proxmox left amber-fox locked (rollback). Run `pct unlock 214` on
  pve-1."
- After a restore, its notice at the top of the page, with 069's other
  notices; a restore that bb-box could not confirm after a restart is one
  of them.
- At 390 px, the header's actions take a row of their own under the name,
  as the build checks 069's shipped header does.

**Take snapshot** opens a small dialog: a name (the time by default), a
note, and "With its memory" where the backend gives the choice, unticked,
with its time scaled to the box's memory and its space ("About 15 s.
brisk-lake pauses for a moment. Up to 16 GiB more on pve-1"). The words
say what it holds and leaves out, the count, the picture, and the price or
"no charge". On Take the dialog closes and the row appears at the top in
`taking`.

**Fork** opens a dialog: the new box's name, where it goes, its size, its
time and space from the plan, and what it is: "A new box with amber-fox's
files as they were at 23:39. It gets its own BB machine, address and keys,
and never acts as amber-fox. Everything else on its disk comes with it:
project secrets, signed-in browsers and keychains. It starts fresh: no
apps are running." On Fork, the new box's page opens, starting.

**Keep…** opens a dialog: the date (30 days by default), and what keeping
costs on that backend: "If amber-fox is released, bb-box first copies this
snapshot in full: about 10 s, and 13 GB on pve-1 until 29 Nov." Where
Keep cannot last, the menu item is disabled with why.

**Delete** asks: "Delete 'Thu 09:15'? Frees 3.4 GB on pve-1." or, on
LVM-thin, "Frees what it no longer shares with amber-fox." A kept one adds
"You kept it until 29 Nov."; an undo "It is the undo of the restore at
11:02."

Each dialog returns focus to the control that opened it when it closes.

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
| Agents | Agents may restore their own boxes | on | off: `box_restore` asks the person through the form |
| Agents | Agents may restore memory snapshots | on | off: only the person restores a memory snapshot |
| Pictures | Keep a picture of the screen with each snapshot | on | |
| Paid snapshots | A ceiling a month, per provider and account | $5 | beside it, the rate held and this month's spend |
| What each backend offers | one row per backend and storage, read only, from its plan | | "Disk; restores any; forks by full copy; keeps by held copy · no charge"; ZFS says "restores the newest only"; a row with a problem says it, with the fix |

- Each backend's own page gains a Snapshots line among its facts.
- The settings live under `general.snapshots` in the configuration
  document, through 067's engine, so Find, drafts and the merge apply.

#### Words

- "Snapshot", never "checkpoint" or "backup". "Restore", never "roll back"
  or "revert" (Proxmox's word stays in the log's backend words). "Fork",
  never "clone" or "duplicate". "Keep", "kept until", "goes with the box",
  "held copy".
- What it holds: "disk", "disk and memory". In sentences: "files, installed
  apps and settings"; "its running apps".
- Who: as 069: "by you", "by the agent in (thread)", "by a bb box command",
  "by bb-box: (why)", "outside bb-box".
- An undo's name: "before the restore at 01:56".
- Sizes in GB for snapshots, as providers bill; GiB for a box's memory and
  disk, as 069 says them. Prices as the provider gives them.

#### Look and motion

BB's tokens and components, the hairline cards of the Boxes and settings
pages, and no page motion. One weight, 400, wherever bb-box sets the
class: the build moves bb-box's own `RowTitle`, `PageTabs` and settings
`Group` headings from 500 to 400, and gives its dialog titles 400. No
shadow on cards; BB's dialog and toast keep their own. A new row appears in
place; a deleted row goes without a fade; spinners stop under reduced
motion. Amber and red carry words, never colour alone.

#### Keyboard, screen readers and narrow windows

- Tab reaches, per row, the picture's button, then Restore, Fork and the
  menu, which show when focus is inside the row. Each icon button has its
  name and the snapshot's ("Restore amber-fox to before the migration").
- The dialogs are alert dialogs; focus starts on the safe choice: Cancel in
  Restore and Delete, the name in Take snapshot. Closing returns focus to
  the opener.
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
tool restores, durable Keep before the Keep UI, and a backend whose gates
cannot run live stays unavailable.

| Unit | Change | Size | Live check |
| --- | --- | --- | --- |
| 0 | **The Proxmox permission change**: `VM.Snapshot` and `VM.Snapshot.Rollback` in `setup-token.sh` and the LXC guide's table; the doctor's `proxmox.snapshots` check of the token's rights and of each storage's type and what it restores. Ships first, so installs run `setup-token.sh` again before the feature arrives | S | A token from the branch's script and one from `origin/main`'s: the doctor passes the first and names the two missing for the second, without printing either; an LVM-thin and a ZFS storage each described as section 2 says |
| 1 | The record and `snapshots.db`; operations and their restart recovery for take and delete; `mayAct`; `Snapshotting` and `planSnapshots`; Proxmox LXC and QEMU take, delete, `heldSnapshots`, the reconcile with `unavailable`, `lost`, `incomplete` and found orphans; the box log's events; `box_list` and `box_status` words; `bb box snapshot take`, `list` and `delete` | M | Through the CLI on an LXC and a QEMU box: take with and without memory, list, delete. Gates G1, G2, G3, G9 |
| 2 | Restore on Proxmox: plans by storage, the undo (a snapshot, or a held copy on ZFS), the guard of section 5, operations and restart recovery, locks, size read back, access written with the network down, outside restores from task records; `bb box snapshot restore` | M | Gates G4, G5, G6, G7, G8, G13 |
| 3 | Settings' Snapshots page: limits, undos apart, room and the sweep's thresholds, keep length, the agents' switches, pictures, the paid ceiling as a rate, what each backend offers; through 067's drafts and Save | M | Each setting seen to bite; gate G10 |
| 4 | The agent's tools, the form through `bb.ui.requestInput`, the skill's words and the reference | M | Gates G11, G12 |
| 5 | The box page's Snapshots card, Take snapshot, the restore dialog, its notice and Undo, Delete, Rename and Note, and the pictures | M | Take, restore and undo from the page; a guarded restore names every thread, the control and a terminal; keyboard only; 390 px with the header's actions on their own row |
| 6 | Forks on Proxmox Linux: the reset unit in every Linux template and image with its marker, `forkSafe` per snapshot, `forkSnapshot` by full clone, the check before ready, `box_fork`, Fork on the pages | M | Gate G14 |
| 7 | Keep: held copies at release on Proxmox, the release that waits for them, keep dates in labels, held copies adopted by the sweep; the Snapshots tab with Keep…, expiry and Select | L | Gate G15 |
| 8 | Tart: macOS snapshots as APFS copies of the suspended VM beside the VMs, with memory; Linux VMs, disk only; restore by putting a copy back; macOS's own fork reset, then forks; a guard against a state saved under another macOS build | M | On a Tart Mac box, never a pool Mac someone else holds: take, restore, undo, fork and keep of a 16 GiB macOS box, timed; a copy on another volume refused |
| 9 | microsandbox: native snapshots, restore as a new guest with its handover, fork from a disk snapshot, dependent snapshots | S | Take with memory, restore, fork; the fork holds no process of its source |
| 10 | boat.dev: saved snapshots on a paid plan within the ceiling, restore as a new guest with its handover; on the trial, no restore and no Keep | M | Only once the owner gives a paid plan: take, restore, the price on the row and the rate in Settings, and what a restore costs in boat's starts. Until then paid snapshots stay off |
| 11 | Docker, Hetzner and Namespace Linux boxes: a paused commit with the box's Docker volume; restore as a new container | M | A Docker box with images in its own Docker: take, restore, and its images are still there; Keep disabled on Hetzner and Namespace with why |
| 12 | Android devices' own snapshots, `scope: device` | S | Save, restore, and the open app comes back; the words say the device only |
| Later | Moving a snapshot between hosts by export; forks into another thread; Windows and iOS forks; a registry push for Namespace | | |

## Gated in unit N

A unit lands only when its gates pass in its live check on a separate BB
in a box, as 067's and 069's do. Tokens are never printed.

| Gate | Unit | Rule | Passes when |
| --- | --- | --- | --- |
| G1 confirmed-take | 1 | A take is `ready` only when the provider confirms it complete (section 1) | A take whose task is killed part way is `incomplete`, never `ready`; Delete finishes Proxmox's cleanup |
| G2 unavailable-not-lost | 1 | A failed listing marks nothing; `lost` needs two successful listings without it; a backend with snapshots cannot be removed without Forget (section 1) | With pve-1 cut off for an hour, its snapshots are `unavailable` and come back `ready`; removing its backend asks to forget them, naming their size |
| G3 orphans-quarantined | 1 | A labelled snapshot of a gone box is listed, not deleted, for 7 days; one with a keep date gets its record back (section 1) | With `snapshots.db` deleted while bb-box is stopped, the next start finds every snapshot, kept ones as kept, and deletes none |
| G4 storage-rollback | 2 | The plan reads the storage; ZFS restores the newest only, with a held-copy undo; nothing newer is deleted (section 2) | On LVM-thin, a restore to the oldest of three with its undo; on ZFS, the same is refused with the words, a restore to the newest works with its held copy, and every newer snapshot is still there |
| G5 restore-guard | 2 | The guard reads `threadsOn`, control and terminals; an agent is refused while any is so (section 5) | With an idle thread's worktree on the box, a person holding control, or a terminal open, an agent's restore is refused naming it; the person's dialog lists each |
| G6 restart-recovery | 2 | Every step is recorded first and finished or reported at start (section 6) | bb-box killed after the hard stop, after the rollback, and after a new-guest start: each restore finishes or says it could not confirm, and no guest is released as a leftover |
| G7 lock-words | 2 | A locked guest is refused with the host's command (section 6) | A guest left with `lock: rollback` refuses take and restore with "Run `pct unlock <vmid>`", in the page, the tool and the doctor |
| G8 access-before-network | 2 | A restore writes current access before the network is up, and reads the size back (section 5) | A sentinel value changed after a take is the new one after a restore, before the box answers on its network; a restore across a memory resize shows the old memory, as the dialog said |
| G9 serialised | 1 | All operations on a box run one at a time; room and money are reserved at once for all boxes (section 6) | Two takes at once, take and release, take and restore, delete and restore, expiry and fork, and a repeated `request`, each end in one consistent state |
| G10 ceiling-rate | 3 | The ceiling bounds the rate held, checked on take, undo, Keep, renewal and held copy; never deletes to get under (section 8) | On a fake priced backend: a ceiling lowered below the rate refuses the next take and warns, and deletes nothing; deleting keeps the month's spend |
| G11 person-form | 4 | An agent's restore of the box its thread runs on is only through the person's submit; the box log records it (section 5) | On a machine of the person's, `box_restore` opens the form; Cancel, timeout and a BB restart do nothing; Restore waits for idle threads, takes its undo then, and logs "with your yes" |
| G12 permissions | 4 | `mayAct` for every operation and picture (section 3) | A thread guessing another thread's snapshot ID can list, see, restore, fork, delete and fetch the picture of none of them |
| G13 outside-restore | 2 | `restored-outside` only from a provider task (section 4) | An outside take, delete, two restores to one parent and several changes between sweeps each log as section 4 says, and only the rollback tasks as restores |
| G14 fork-identity | 6 | The reset runs before the network and identity services, fails closed, and only images with it fork (section 9) | On each Linux template, `systemd-analyze` shows the order; a fork's BB host ID, tailnet node, SSH host keys, machine ID and access file are new; the source's host ID never shows a second connection; a box from an image without it refuses to fork |
| G15 keep-lasts | 7 | Keep lasts the release: a held copy before the guest goes; the release stops if it cannot (section 7) | Keep, release, restart BB, then fork from the kept snapshot and read a file written before the take; with too little room, the release stops and deletes nothing |

## Open questions for the owner

Each has a default the build follows unless the owner says otherwise. Both
reviews' views are taken into the defaults.

1. **The paid ceiling.** Default: $5 a month per provider and account,
   checked against the monthly rate of everything held (each paid snapshot
   times its daily price times 30) on every take, undo, Keep and renewal;
   about three of boat's saved snapshots held all month. It refuses new
   paid snapshots past it, and never deletes kept ones. The other choice
   is $0, so none until the person sets one.
2. **An agent restoring the box its own thread runs on.** Default: refused;
   the agent asks through the form, and the person's submit restores it.
   The other choice was to run it when the turn ends, which both reviews
   advised against.
3. **Snapshots per box.** Default: 5, kept ones included, undos apart (2 a
   box), and a restore's target never deleted to make room. The other
   choice is 10.

## Alternatives considered

- **A portable format of bb-box's own** (the research's shape B). An order
  of magnitude slower per take, no memory, a store to run, and secrets in
  an archive away from the box. It can come later as the export of a
  snapshot, for moves.
- **Each provider's snapshots shown as they are** (shape C). The core would
  name providers, and the person would learn each one's words.
- **Restore by clone and swap everywhere**, so every storage restores any
  snapshot. It costs a full copy per restore, and the box's other
  snapshots stay on the old guest. Used only for ZFS's undo.
- **Keep by holding the released guest.** It would hold its memory, cores
  and VMID as a stopped box, and the sweep would have to tell it from a
  leftover; a held copy holds only the disk of the kept snapshot.
- **A page per snapshot.** A snapshot has little to show beyond its row and
  picture.
- **Undo kept in memory only, as a short "Undo" toast.** An undo must
  survive a reload and a restart of bb-box, so it is a snapshot.
- **The agent's word for the person's yes** (`person_agreed`). The SDK's
  form gives the person's own submit instead.
- **Fork from memory.** The memory holds the source's processes and tokens.

## The prototype

Open [070-snapshots/prototype.html](070-snapshots/prototype.html) in a
browser. It is one file with nothing to install, and saves nothing. It uses
bb-box's own tabs, row titles, badges, status dots, icon buttons, settings
rows and switches, with BB's buttons, menus and dialogs. A fake server
holds eleven boxes and eighteen snapshots under generic names, takes a
snapshot in about 1 s (longer with memory), restores in about 4 s and forks
in about 4 s, and keeps a box log. Pictures are drawn by the prototype, not
real screens. Add `?light` for the light theme.

The dashed Prototype panel, bottom left, goes to: the Snapshots tab, a
desktop box on LVM-thin, a box on ZFS, a VM with a memory snapshot, a Mac
on Tart, a box on boat.dev, an Android device box, a machine of yours with
an agent's form, a box with no snapshots, a box whose token cannot take
them, a released box's kept snapshot, and Settings. It also makes the next
take, restore or fork fail, runs an agent's snapshot and restore of its
box, opens an agent's form to restore your machine, restarts bb-box in the
middle of a restore, fills pve-1's storage past 92%, and switches dark and
light.

Worth trying:

1. On amber-fox, restore "before the migration": the dialog names the
   working thread, an idle one, your control of the desktop and an open
   terminal. Keep the undo, then use Undo in the notice; restore again: the
   undo count stays apart from the 5.
2. On tidy-glade (ZFS), try an older snapshot, then the newest: the undo is
   a held copy, with its time and space.
3. Untick the undo and see the button turn red.
4. "An agent asks to restore work-pc": submit the form in the thread
   stand-in, and see the box log's "with your yes".
5. "bb-box restarts mid-restore", then look at amber-fox.
6. Keep one of amber-fox's snapshots: the dialog says what a held copy
   costs. Then open grey-ridge, released, with its held copy.
7. On the Snapshots tab, hover a row for its actions, filter to agents, and
   Select two to delete.
8. In Settings, lower the ceiling below the rate held, and press Save.

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
memory snapshot and a failed take](070-snapshots/new/16-vm-memory-failed.png),
[with its memory](070-snapshots/new/17-take-with-memory.png), [a Mac on
Tart](070-snapshots/new/18-take-tart.png), [a token without the
rights](070-snapshots/new/19-token-lacks-rights.png), [a box with
none](070-snapshots/new/20-no-snapshots.png), [a released box's held
copy](070-snapshots/new/21-released-kept.png), [Settings'
Options](070-snapshots/new/22-settings-overview.png), [the Snapshots
settings page](070-snapshots/new/23-settings-snapshots.png), [the ceiling
below the rate](070-snapshots/new/24-ceiling-passed.png) and [a take it
refuses](070-snapshots/new/25-take-refused-ceiling.png), [an agent's
restore](070-snapshots/new/26-agent-restored.png), [the tab at 390
px](070-snapshots/new/27-phone-tab.png), [a box at 390
px](070-snapshots/new/28-phone-box.png), [the tab at 760
px](070-snapshots/new/29-760-tab.png), light ([the
tab](070-snapshots/new/30-light-tab.png), [a
restore](070-snapshots/new/31-light-restore.png)), [ZFS: an older snapshot
refused](070-snapshots/new/32-zfs-older.png), [ZFS: the newest, with a held
copy](070-snapshots/new/33-zfs-newest.png), [an agent's form in the
thread](070-snapshots/new/34-person-form.png), [restored with your
yes](070-snapshots/new/35-form-restored.png), [a restore cut short by a
restart](070-snapshots/new/36-restart-unconfirmed.png), [Keep and its
cost](070-snapshots/new/37-keep-dialog.png), [a locked
guest](070-snapshots/new/38-locked.png), and [a storage past
92%](070-snapshots/new/39-storage-full.png).

What it does not do, where the build follows this note:

- The tools and the CLI; a real form in BB's composer (a stand-in thread
  shows it).
- Keep's expiry by the sweep, the reconcile, `unavailable`, `lost` and
  found orphans.
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
- Every Linux template and image gains a boot step that drops a fork's
  inherited identity (unit 6), beside 017's, and a marker of its version.
- A release of a box with kept snapshots on Proxmox makes held copies
  first, and can stop for want of room.
- Agents gain five tools; an agent's restore of the box it runs on, or of a
  machine of the person's, is the person's, through a form in the thread.
- The box log records snapshots, restores and forks, and restores made
  outside bb-box on Proxmox when a task shows them.
- BB is asked for a way to pause a machine's turns while it is restored.

## What changed after the reviews

Two independent reviews, by Opus and by GPT-6 Astra, read the note, the
research and the code, and ran the prototype on a box. Both said: build
after changes. Every finding of both is answered here; numbers are each
review's own.

| Finding | Reviews | Change | Where shown |
| --- | --- | --- | --- |
| Keep cannot outlive a release on Proxmox; the sweep would delete a kept guest; Namespace and Hetzner lose theirs; the live check proved a row, not a restorable snapshot | Opus 1, Astra 1 | `keepsPastRelease` per backend; on Proxmox a held copy made before the guest goes, adopted by the sweep; the release stops if a copy fails; no Keep on boat's trial, Hetzner, Namespace and devices; the Keep dialog says time and space; G15 forks from a kept snapshot after a release and a restart and reads a file | Sections 2 and 7; G15; prototype Keep dialog, grey-ridge, [screenshot](070-snapshots/new/37-keep-dialog.png) |
| ZFS rolls back only to the newest snapshot, so undo-first breaks every restore; capability must be per storage, read live | Opus 2, Astra 2 | `planSnapshots` per guest and storage, read live; by-storage table; on ZFS restore to the newest only, with a held-copy undo; never deletes newer snapshots; unit 0's doctor checks storage; G4 | Section 2; G4; prototype tidy-glade, [screenshots](070-snapshots/new/32-zfs-older.png) |
| A restore loses idle threads' worktrees and sessions, a person's desktop, open terminals, not only working threads | Opus 3, Astra 7 | The guard reads `threadsOn`, control and terminals; the dialog lists each; an agent is refused while any is so; G5 | Section 5; G5; prototype restore dialog, [screenshot](070-snapshots/new/09-restore-dialog.png) |
| An agent's restore of the box its thread runs on races its next turn; deferral without a durable gate | Opus 3, Astra 7 | Refused; the agent asks through the form, and the person's submit restores after threads are idle, with the undo taken then; open question 2's default changed | Section 5; question 2 |
| `person_agreed` trusts the agent; the SDK can ask the person | Opus 4, Astra 9 | `bb.ui.requestInput`, which only the person submits; the yes is kept on the operation and in the box log; the Settings switch's "asks you instead" is now true; G11 | Sections 3, 4, 5, 11; G11; prototype work-pc, [screenshots](070-snapshots/new/34-person-form.png) |
| The limit can delete the restore's target; the undo uses up the 5; the default forces "restore without undo"; an agent could pass `undo: false` | Opus 5, Astra 3 | Undos apart (2 a box), replaced only once a new one is ready; targets, undos, in-use, kept and the person's never evicted; on a shared box only the same thread's; no agent bypass of the undo | Sections 4, 5, 8; prototype, worth trying 1 |
| Fork safety per kind, not per box; QEMU's SMBIOS serial is the address; Windows' own reset; `msb fork` copies memory; ordering of the reset | Opus 6, Astra 5 | `forkSafe` read per snapshot from the image's marker; a change detector per backend (SMBIOS UUID, hostname, MAC, a set value); Windows and macOS no fork until their reset; microsandbox forks from a disk snapshot; systemd `Before=`, fail closed; a fork still holds project secrets; G14 | Section 9; G14; prototype Fork dialog |
| A restore does not survive a restart; new-guest restores leave two guests; a Proxmox lock has no way out | Opus 7, Astra 6 | Operations recorded before each step, finished or reported by `#snapshotsCutShort`; new-guest handover stops the old guest first; `unknown` until observed; lock words with the host's command; G6, G7 | Section 6; G6, G7; prototype "bb-box restarts mid-restore" and the lock, [screenshots](070-snapshots/new/36-restart-unconfirmed.png) |
| No operation protocol: IDs, receipts, races, reservations, a full database | Astra 6, Opus 12 | Section 6's operations with request IDs, pinned snapshots, `#chain`, reservations in one transaction; a full `snapshots.db` refuses before any change; pictures evicted, never records; G9 | Sections 1 and 6; G9 |
| Thin storage fills after the take | Opus 8 | The sweep reads data and metadata use; past 85% refuses and warns; past 92% deletes agents' unkept snapshots, oldest first, and logs it | Section 8; prototype "fill pve-1", [screenshot](070-snapshots/new/39-storage-full.png) |
| A rollback puts back the guest's old size | Opus 9 | The plan says the size it goes back to; the size is read back after; a restore across a disk grow is refused until measured; G8 | Sections 2 and 5; G8; restore dialog |
| The ceiling can be passed with no take; a projection is not a bill cap; Keep and renewal unchecked; deleted charges vanish | Opus 10, Astra 10 | The ceiling bounds the monthly rate held, checked on take, undo, Keep, renewal and held copy; a ledger of this month's spend; never deletes to get under; paid stays off until a real paid check; G10 | Section 8; G10; open question 1; prototype Settings, [screenshot](070-snapshots/new/24-ceiling-passed.png) |
| No row for a box the thread runs on but does not own; an agent could delete the person's snapshots | Opus 11, Astra 9 | The table's middle row; agents delete only what an agent of their thread took and nobody kept; a kept snapshot is the person's at once | Section 3 |
| Races listed in part; undo names not unique | Opus 12 | Every operation on `#chain`; release waits for a take; undo names "before the restore at 01:56", with " (2)" | Sections 5 and 6; G9 |
| Unit 1 too large and not checkable live; units ordered by screens before safety | Opus 13, Astra 14 | Unit 0 for the token and doctor; unit 1 with `bb box snapshot take`, `list` and `delete`; restore's safety in unit 2; Settings before tools; forks before Keep; pictures in unit 5; named gates G1 to G15 | Section 13; Gated in unit N |
| Lost and unreachable confused; a lost database deletes kept snapshots; `snapstate=prepare` counted ready | Opus 14, Astra 8 | `unavailable`, `lost` after two good listings, `incomplete`; keep dates in labels; orphans listed 7 days before deletion; a backend with snapshots removed only by Forget; G1 to G3 | Section 1; G1, G2, G3 |
| Hover-only row actions; headless tiles; one weight; 390 px header; toast covering; undo's name; memory undo; scaled times; Tart's undo | Opus 15 | Actions on hover and focus, always on touch; no tile for headless rows; weight 400 for bb-box's classes; header actions on their own row at 390 px; toast only off the box's page; "before the restore at …"; the dialog says a disk undo does not bring back running apps; memory time scaled by GiB; Tart's undo holds memory | Section 12; prototype, [screenshots](070-snapshots/new/02-row-hover.png) |
| Settings save on blur; expiry clipped last in the line; focus lost after a dialog; Delete offered during a restore; a failed restore left "Restoring" | Astra 13, Astra 6 | Numbers through 067's draft and Save; what needs attention first in the line; focus back to the opener; Delete, Restore and Fork disabled while restoring; the prototype's failed restore ends its steps | Section 12; prototype Settings and rows |
| Rewriting the access file does not make a restore safe; memory restores revive credentials; new-guest handover | Astra 4 | Access written before the network is up; a memory restore says it revives processes and credentials, and Settings can limit it to the person; new-guest restores stop the old guest first; a request to BB to pause a machine's turns; G8 | Sections 5 and 11; G8 |
| The model does not say what state it captures: device vs box, Docker's volume, boat's capture time, microsandbox's chain, Tart memory-only for agents | Astra 11 | `scope`, `excludes`, `capturedAt`, `dependsOn` on the record; Docker captured paused with its volume; no undo or Keep on boat's trial; an agent's `memory: false` on Tart macOS refused; the picture labelled "around" the take | Sections 1, 2, 4, 10 |
| A changed Proxmox `parent` does not prove a restore | Astra 12 | `restored-outside` only from a rollback task in the node's task list; otherwise "its snapshots changed outside bb-box", with no repair; G13 | Section 4; G13 |
| CLI cannot tell who calls; room refusals reveal other threads' names; consent in a pruned log | Astra 9 | One `mayAct`; the CLI named as the person's trusted way around; refusals name only what the caller may see; consent kept on the operation; G12 | Sections 3, 4, 6; G12 |
| Five tools add to every agent's list | Opus 16 | Kept apart, one action each, with why; the owner can ask for fewer | Section 4 |
| Pictures' defaults are right | Opus 16 | Unchanged | Section 10 |
