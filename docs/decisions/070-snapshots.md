# 070: A box's snapshots are bb-box's own records, taken by each backend's own mechanism, and kept with the box unless the person keeps them

Status: proposed, 30 October 2026, with the owner's answers to the
research's four questions built in. Not built yet: see [How it is
built](#11-how-it-is-built).

Research: [Snapshots of boxes](../research/box-snapshots.md), with its
measurements on Proxmox LXC and QEMU, Docker, Tart, microsandbox, boat.dev,
Hetzner, Namespace and device boxes. This note does not repeat them; it
cites them where a rule depends on a number.

The prototype is [070-snapshots/prototype.html](070-snapshots/prototype.html):
one file, opened in any browser, made from bb-box's own components with a
fake server, as 067's and 069's were. Its source is in
[070-snapshots/prototype](070-snapshots/prototype/). How to click through it
is under [The prototype](#the-prototype).

Extends [069](069-boxes-page.md): its box log gains snapshot events, the
Boxes page gains a Snapshots tab, and a box's page gains a Snapshots
section. Extends [067](067-settings-page.md): Options gains a Snapshots
page. Extends [061](061-a-box-can-be-resized-live-where-its-backend-can-and-restarted-only-when-asked.md)'s
pattern: a backend says per kind what it can do, with no call to a host.

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

Three findings from the research that the design must answer:

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

- A box's record (`BoxRecord` in BB's key-value store) and the box log
  (`box-log.db`, 069 unit 1b, [box-log.ts](../../src/core/box-log.ts)), with
  an actor on each event: the person, an agent with its thread, a command,
  bb-box itself, or outside bb-box.
- What a backend can resize, per kind, with no call (`resizing(kind)`,
  [types.ts](../../src/backends/types.ts)). Snapshots follow that shape.
- How a tool reaches a box: a thread's own boxes, or the box it runs on,
  which may be one of the person's machines (`resolve` in
  [setup.ts](../../src/plugin/setup.ts)). Stop and release refuse the box a
  thread runs on, and refuse while threads work on a box's BB machine
  (`checkInUse`).
- A desktop's frames and a device's screenshots, through the viewer, Cua
  Driver and the device server
  ([computer.ts](../../src/core/computer.ts),
  [device-computer.ts](../../src/core/device-computer.ts)).

## Decision

### 1. A snapshot is a record of bb-box's

bb-box keeps one list of snapshots across every backend, in a file of its
own, `snapshots.db`, attached to the SDK's database as 069 attaches
`box-log.db`, with its own migrations, write-ahead log and a cap of 64 MB.

| Field | Type | Example | Notes |
| --- | --- | --- | --- |
| `id` | `sn` and 12 letters and digits | `sn7kq2m9xa4pd` | bb-box's, never the provider's |
| `box` | ID, name, kind, system, thread | `bxamberfox2q7k`, amber-fox, `linux-desktop` | copied at the take, so a kept snapshot still names its box after the release |
| `boxGone` | time and how, or null | released 12 Oct | set when the box is released or forgotten |
| `backend`, `host` | backend ID and label; host | `proxmox-lxc`, "Proxmox LXC on pve-1"; pve-1 | where it lives; usable only there |
| `name` | text, at most 60 characters | "before the migration" | given, or the time ("Thu 10:42"); unique per box |
| `note` | text, at most 1 KB, or null | | |
| `takenAt`, `tookMs` | time; duration | today 10:42; 680 ms | |
| `by` | an `Actor`, as the box log's | the agent in "Fix the sign-in flow" | |
| `holds` | `disk` or `disk-and-memory` | `disk` | what a restore brings back |
| `size` | bytes and what they mean, or null | 1.2 GB, `own` | `own`: what deleting it frees; `whole`: what it holds, some shared with the box; null: the provider does not say |
| `price` | amount, currency and period, or null | $0.056 a day | null where it is on the person's own storage and costs nothing more |
| `owner` | `thread` or `person` | `thread` | see [section 3](#3-who-owns-a-snapshot-and-who-sees-it) |
| `keptUntil`, `keptAt` | times, or null | 29 Nov | set only by the person |
| `undoOf` | a restore's time and the snapshot it went to, or null | the restore at 11:02 to "before the migration" | marks the snapshot a restore took first |
| `picture` | a picture's state | `taken`, `none` (headless), `off`, `failed` | the image is in its own table, see [section 6](#6-a-picture-of-the-screen) |
| `ref` | the backend's reference | `bbsn7kq2m9xa4pd` on Proxmox | opaque to the core |
| `state` | see below | `ready` | |
| `error` | the backend's words, or null | | on `failed` and `lost` |

A snapshot is not an image. It holds one box's state, secrets included,
and serves that box and its forks. A project's image stays a script (049),
and "Make an image from this snapshot" is left out for 049's reasons.

#### Its states

```
taking ──► ready ──► deleting ──► (gone: the record goes)
   │         │
   ▼         ▼
 failed     lost
```

| State | Means | Leaves by |
| --- | --- | --- |
| `taking` | the backend is taking it | `ready`; `failed`. A `taking` record found at start is checked against the backend: there, `ready`; not there, `failed` |
| `ready` | it can be restored, forked, kept, renamed and deleted | `deleting`; `lost` |
| `failed` | the take failed; nothing is held | removed after 24 hours; shown on the box's page until then |
| `deleting` | the backend is deleting it | gone; `ready` with an error, when the delete fails |
| `lost` | the backend no longer has it: deleted outside bb-box, or its host gone from settings | removed by the person, or after 7 days |

A restore and a fork are operations on a box, not states of a snapshot.
While one runs the snapshot stays `ready`, cannot be deleted, and its row
says "Restoring amber-fox…" or "Forking…".

Expiry is not a state. A kept snapshot whose `keptUntil` passes is deleted
by the sweep, as any delete.

#### Where it lives, and how it is found again

- The record is bb-box's. The snapshot itself lives where its backend keeps
  it: on its host for Proxmox, Tart, microsandbox and Docker, on the
  account for boat.
- Each backend names or labels a snapshot with the install, the box and the
  snapshot's ID, as 018 does for guests: on Proxmox a snapshot named
  `bb<id>` with a description `bb-box install <install> box <box> snapshot <id>`;
  on a Mac a folder named by the ID beside the VM, with a label file; on
  boat a saved snapshot's name.
- `heldSnapshots()` lists a backend's snapshots of this install. At start
  and at each sweep bb-box compares it with its records: a record whose
  snapshot is not there becomes `lost`; a snapshot with no record, of a box
  that still exists, gets a record again (`by` unknown, name from its
  label); one of a box that is gone and not kept is deleted. So a lost
  record leaves nothing behind, and nothing is billed for long unseen.

### 2. Each backend says what its snapshots can do

Per kind, with no call to a host, as `resizing(kind)` does:

```ts
type Holds = "disk" | "disk-and-memory";
type WhileRunning = "live" | "pauses" | "suspends" | "stopped-only";

interface Snapshotting {
  readonly holds: readonly Holds[];
  readonly whileRunning: WhileRunning;
  readonly restore: "in-place" | "new-guest" | "none";
  readonly anySnapshot: boolean;
  readonly fork: "copy" | "thin" | "none";
  readonly lives: "host" | "provider";
  readonly price: Price | null;
  readonly includedFree: number | null;
  readonly takesAboutMs: number;
  readonly restoresAboutMs: number;
}

interface Price {
  readonly amount: number;
  readonly currency: "USD" | "EUR";
  readonly per: "day" | "month" | "GB-month";
}
```

And optional methods on `Backend`, each only where `snapshotting(kind)` is
not null:

```ts
snapshotting?(kind: string): Snapshotting | null;
snapshot?(guest: Guest, take: SnapshotTake, signal?: AbortSignal): Promise<SnapshotTaken>;
restoreSnapshot?(guest: Guest, ref: SnapshotRef, signal?: AbortSignal): Promise<Guest>;
forkSnapshot?(ref: SnapshotRef, box: BoxIdentity, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest>;
deleteSnapshot?(ref: SnapshotRef, signal?: AbortSignal): Promise<void>;
heldSnapshots?(signal?: AbortSignal): Promise<readonly HeldSnapshot[]>;
snapshotRoom?(guest: Guest, signal?: AbortSignal): Promise<SnapshotRoom>;
```

- `SnapshotTake` carries the record's ID, its label, and `memory`.
  `SnapshotTaken` carries the backend's reference, what it holds, its size
  where known, and the time each step took.
- `restoreSnapshot` returns the guest, which is a new one where `restore` is
  `new-guest` (microsandbox, boat): the core keeps the box's ID, name and
  record, and swaps the guest.
- `snapshotRoom` says how full the storage that holds the box's snapshots
  is, for the room rule ([section 7](#7-retention-room-and-cost)).
- `box_list` and `box_status` say per kind and per box what a snapshot
  holds, or that the box has none, as they say what it resizes.

What each backend fills in, from the research's measurements:

| Backend | `holds` | `whileRunning` | `restore` | `anySnapshot` | `fork` | `price` | Unit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Proxmox LXC | disk | live (0.7 s) | in-place, after a hard stop | yes | copy (9.3 s for 4 GiB used) | none | 1, 2, 7 |
| Proxmox QEMU | disk; disk and memory | live (1.1 s); memory 3.7 s | in-place (1 to 4 s) | yes | copy (6.5 s) | none | 1, 2, 7 |
| Tart, macOS | disk and memory only | suspends (about 7 s, then resumes) | in-place: puts a copy back, then resumes (11 s) | yes | copy, from the disk, new MAC address | none | 8 |
| Tart, Linux | disk | stopped-only | in-place | yes | copy | none | 8 |
| microsandbox | disk; disk and memory | pauses (0.3 s; memory 1.5 s) | new-guest (3.9 s) | yes | thin (1.6 s) | none | 9 |
| boat.dev | disk | live | new-guest, newest only on the trial | no on the trial; yes for saved snapshots | copy | $0.056 a day for a saved snapshot past the plan's | 10 |
| Docker, Hetzner, Namespace Linux | disk, with the box's own Docker volume copied | pauses (15 s for 1 GiB changed) | new-guest | yes | copy | Hetzner and Namespace: none for a commit on the host; a registry push is later | 11 |
| Android emulator (in its box) | the device's disk and memory | live (14.8 s) | in-place, the device only (3.2 s) | yes | none | none | 12 |
| SSH host pool, iOS slots, Namespace macOS | none | | | | | | none |

A Tart macOS box holds its memory in every snapshot, as a suspend is how
Tart saves it; the take dialog and the tool's answer say so, and question 2
applies only where a backend gives the choice.

### 3. Who owns a snapshot, and who sees it

| Box | Owner of its snapshots | Who may take | Who may restore | Who may fork | Who may delete | Who may keep |
| --- | --- | --- | --- | --- | --- | --- |
| A thread's box | the thread | its agent; the person | its agent, without asking; the person | its agent, into its thread; the person | its agent, its own thread's; the person | the person |
| A machine of the person's own (036) | the person | an agent of a thread that runs on it; the person | the person; an agent only with the person's yes in the thread ([section 5](#5-a-restore-says-what-goes-and-takes-an-undo-first)) | the person | the person; an agent, only the ones it took | the person |
| A kept snapshot of a released box | the person | | | the person, into a new machine of theirs | the person | the person |

- No thread sees another thread's snapshots, in tools, the CLI's answers to
  a thread, or anything an agent can read. On a machine of the person's
  that it runs on, an agent sees only the snapshots it took there.
- The person sees every snapshot, on the Boxes page.
- Projects own none in the first units: a state shared across a project's
  threads is what a project's image is for (049).

### 4. The agent's tools, the CLI and the box log

#### Tools

| Tool | Parameters | Does | Answers |
| --- | --- | --- | --- |
| `box_snapshot` | `box`, `name`, `note`, `memory` (default false) | takes one; refuses `memory` where the backend gives no choice of it, and says why | its name and ID, what it holds, its size where known, how long it took, its price if any, and "3 of 5 for this box" |
| `box_snapshots` | `box` (optional), `pictures` (default false) | lists a box's, or every box's of the thread | per box, what its snapshots hold or that it has none; per snapshot: name, ID, when, by, holds, size, price, kept; pictures as images only when asked |
| `box_restore` | `box`, `snapshot`, `replace` (must be true), `undo` (default true), `person_agreed` (on a machine of the person's) | restores the box to the snapshot, as [section 5](#5-a-restore-says-what-goes-and-takes-an-undo-first) says | what it replaced ("2 h 5 min of changes"), the undo's name, whether processes ended or memory came back, and the box's state |
| `box_fork` | `snapshot` or `box` (the box now), `name` | a new box of the thread from a snapshot, or from the box now, for which it takes a snapshot first, named "for a fork" | the new box, as `box_acquire` answers, and "forked from amber-fox at 10:42" |
| `box_snapshot_delete` | `box`, `snapshot` | deletes one the thread may delete | what it freed, where known |

`snapshot` takes a snapshot's name or ID. A tool never keeps a snapshot:
keeping is the person's.

The skill tells the agent: take one before a change it cannot undo, such
as a migration, an upgrade, a deletion or a change to the system; take one
when the person asks; never on a schedule of its own; restore when an
attempt went wrong rather than undoing by hand; delete its own when they
are no longer needed; never pass `person_agreed` without the person's yes
in this thread to this restore.

#### The CLI

For the person and their scripts, as `bb box stop` is:

```
bb box snapshot take <box> [--name <name>] [--note <text>] [--memory]
bb box snapshot list [<box>] [--kept] [--json]
bb box snapshot restore <box> <snapshot> --replace [--no-undo] [--force]
bb box snapshot fork <box> <snapshot> [--machine | --thread <thread>] [--name <name>]
bb box snapshot keep <box> <snapshot> [--days <n> | --until <date>]
bb box snapshot unkeep <box> <snapshot>
bb box snapshot rename <box> <snapshot> <name>
bb box snapshot note <box> <snapshot> <text>
bb box snapshot delete <box> <snapshot>
```

`--machine <name>` names one of the person's machines, as `bb box stop`
has. `--force` restores while a thread works on the box. The box log
records these as "a bb box command", as it records `bb box stop`; bb-box
cannot tell who typed a command, as today.

#### The box log

`BOX_EVENT_KINDS` gains:

| Kind | Words | Notes |
| --- | --- | --- |
| `snapshot-taken` | its name, ID, what it holds, how long | |
| `snapshot-failed` | its name, the backend's words | |
| `restore-asked` | the snapshot, the undo's name or "no undo" | with the person's words when an agent passed `person_agreed` |
| `restored` | the snapshot, the time it went back to | a Proxmox rollback leaves no stop in the log; this event is what the box's page shows |
| `restore-failed` | the backend's words, and what bb-box then observed | as 069's G6 |
| `fork-asked`, `forked`, `fork-failed` | the source and the new box | the new box's own log starts with `made`, from the source's snapshot |
| `snapshot-deleted` | its name, what it freed, why | why: by you, by the agent, the per-box limit, its keep ended, its box released |
| `snapshot-kept`, `snapshot-unkept` | until when | by the person only |
| `snapshot-lost` | its name, the backend's words | |

A rollback, a restore of a snapshot or a revert done outside bb-box shows
as `stopped-unasked` today, or not at all. From unit 2, bb-box compares a
Proxmox guest's `parent` snapshot at each sweep with the one it last saw,
and when it changed without a restore of bb-box's, logs `restored` by
"outside bb-box", and writes the box's labels and access again as below.

### 5. A restore says what goes, and takes an undo first

What a restore does, in order, whoever asks:

1. **Refuses** a box with no snapshots, a snapshot that is not `ready`, a
   box that is stopping, starting, restoring or being released, and a
   snapshot of another box. A restore of a box to its own snapshot only;
   a snapshot of another box is forked.
2. **Guards** the box's work. As 069's G3 guard: while a thread other than
   the caller works on the box's BB machine, or the box's own thread works
   and the person asked, it asks first ("Fix the sign-in flow is working on
   amber-fox. Restore it anyway?"). The CLI's `--force` and the dialog's
   "Restore anyway" go on.
3. **Takes the undo**: a snapshot of the state it replaces, named "before
   restoring to 10:42", with `undoOf` set, unless `undo` is false. It holds
   the disk only, whatever the target holds. If it cannot be taken (no
   room, the per-box limit full of kept ones, the take fails), the restore
   stops and says why; only an explicit `undo: false`, or the dialog's
   unticked box, restores without one.
4. **Logs** `restore-asked`.
5. **Restores** through the backend, with the box's state `restoring` and
   its steps. Proxmox stops the guest hard first (bb-box's own stop takes
   1.3 s; `pct rollback` on a running container shut it down for 45 s),
   rolls back, and starts it, or resumes it for a memory snapshot.
6. **Sets the box straight**, before it says ready:
   - writes the box's labels again (Proxmox tags and description, which a
     rollback puts back as they were), as a relabel does (036);
   - writes the env file from the thread's current access, as each command
     does, so old tokens from the snapshot are replaced;
   - clears BB's daemon lock and PID (017) and waits for the BB machine to
     come back, as `box_start` does; it is the same machine, with the same
     host ID;
   - joins the tailnet again if its node is gone (050).
7. **Logs** `restored`, and answers.

The undo is a snapshot like any other: listed, counted, deletable. A
restore to it is a restore, with its own undo, so nothing is lost by
undoing.

#### An agent's restore

- On its own thread's box: without asking the person, with `replace: true`
  and the undo first. The person sees it on the box's page and the
  Snapshots tab, and in the box log, "Restored by the agent in Fix the
  sign-in flow".
- On the box its thread runs on, its own or the person's: the restore ends
  the thread's own turn, as the box restarts. bb-box accepts it, answers
  "amber-fox restores to … when this turn ends; nothing you do after this
  call survives", and runs it once the thread stops working, within 10
  minutes, or drops it and logs why.
- On one of the person's machines: refused unless `person_agreed` holds the
  person's words of agreement in this thread, quoted, such as "yes, roll it
  back to before the upgrade". The words go into the box log's
  `restore-asked` and the box's page ("Restored by the agent in Clean up the
  disk, with your yes: 'yes, roll it back'"). bb-box cannot read the
  thread, so this rests on the agent, as every "with the person's
  go-ahead" in the skill does today; the quote makes it checkable after.
  The refusal says what to ask: "dev-desk is one of the person's machines.
  Ask them in this thread whether to restore it to 'before the upgrade'
  (today 10:42; 2 h of changes go). If they say yes, call box_restore again
  with person_agreed set to their words."

#### The person's restore

The restore dialog names the box, the snapshot, the time lost, what ends,
the undo and any working thread, and its button says what it does:

```
Restore amber-fox to "before the migration"?

It goes back to today at 10:42, 2 h 5 min ago. What changed since then
goes: files, installed apps and settings. amber-fox restarts, so every
process in it ends.

Fix the sign-in flow is working on amber-fox now. Its commands end.

[x] Take a snapshot first, "before restoring to 10:42", so you can undo this.
    1 of 5 used for amber-fox.

                                        [Cancel]  [Restore amber-fox]
```

- A memory snapshot says instead: "amber-fox comes back running, as it
  was then."
- Unticking the undo turns the button red and its words to "Restore without
  undo".
- After a restore, the box's page shows a notice for 24 hours: "Restored to
  'before the migration' at 11:02, by you. Undo restores 'before restoring
  to 10:42'." Undo opens the same dialog for the undo snapshot. A toast says
  the same once, with Undo.

### 6. A picture of the screen

Each snapshot keeps a small picture of the box's screen as it was at the
take, so snapshots of one box are told apart by sight, not by time alone.

| Box | How it is taken | Kept |
| --- | --- | --- |
| A desktop | the viewer's last frame, if a viewer was open within the last 10 s; otherwise a screenshot through Cua Driver, as `computer_screenshot` takes one | a JPEG 320 px wide, quality 70, about 15 to 30 KB |
| A device (iOS, Android) | the device server's screenshot, as `computer_observe` takes one | the same, at the device's shape |
| A headless box | none: the row shows the kind's glyph | |

- **When**: just before the take, so it shows what the snapshot holds, and
  before a memory snapshot pauses or suspends the box. It waits at most
  2 s; a picture that fails or is late never fails or slows the snapshot,
  and the record says `failed`.
- **Where**: in `snapshots.db`, in a table of its own, never on the
  provider and never in the box. Deleted with the snapshot. When the file
  nears its cap, the oldest pictures of snapshots that are not kept go
  first, and their rows show the glyph.
- **Who sees it**: as the snapshot: the person, and the agent of the
  thread that owns it, only when it asks with `pictures: true`. Never in a
  notification, a log, the Monitor or a toast. Served by bb-box's RPC to
  its own app, not by a URL.
- **What it may show**: whatever was on the screen, a token in a terminal
  or a signed-in page included. Settings has a switch, "Keep a picture of
  the screen with each snapshot", on by default; off, no picture is taken,
  and the rows show the glyph.
- **On the page**: 64 by 40 px in a row, `object-fit: cover`, a hairline
  border, the kind's glyph when there is none. A click opens it at its full
  320 px in a popover with the snapshot's name and time. It has an `alt` of
  "amber-fox's screen at 10:42".

### 7. Retention, room and cost

- **With its box.** A snapshot that is not kept is deleted when its box is
  released, before the guest, and on Proxmox with it, as a destroy removes
  a guest's snapshots anyway. A thread's end releases its boxes (003), and
  so their snapshots.
- **Kept.** The person keeps one for 30 days from the day they keep it
  (Settings can change the 30), or until a date they choose. A kept
  snapshot outlives its box's release; its owner becomes the person; it is
  listed under its box, marked released, and can be forked into a new
  machine of the person's. bb-box deletes it at its date. From 3 days
  before, its row says "Goes in 3 days" in amber, and the tab's line counts
  it. "Keep 30 more days" renews it. Not on a backend whose snapshots would
  hold a host or a slot: none of the SSH pool's, the iOS slots' or
  Namespace's have snapshots anyway.
- **Per box.** At most 5 snapshots a box by default, kept ones included.
  When an agent takes a sixth, the oldest that an agent took and nobody
  kept is deleted, and the answer says so. When the person takes a sixth,
  or every one is kept or the person's, the take is refused with what to
  delete. An undo counts.
- **Room on each host.** A take is refused when the storage that holds the
  box's snapshots is more than 85% full, by `snapshotRoom`, or would be by
  the snapshot's expected size (a memory snapshot's is the box's memory).
  The refusal names the storage, how full it is and the largest snapshots
  on it. On LVM-thin, a snapshot shares the box's blocks, so what it uses
  grows as the box changes: the room rule reads the pool, not the
  snapshot.
- **Cost.** Where a provider charges, every row says the price ("$0.056 a
  day"), the tab's line says the month's total ("about $3.40 this month"),
  and Settings has a ceiling per provider a month, in its currency. A take
  that would bring the month's projected total past the ceiling is refused,
  with the ceiling and the total. The projection counts each paid snapshot
  to the end of the month, or to its keep date, at the provider's list
  price, less what the person's plan includes where the provider says. On
  boat on the trial, saved snapshots are refused by boat; bb-box takes a
  stopped fork instead, free for 14 days ([unit 10](#11-how-it-is-built)).

### 8. A fork is a new box with a new identity

- **What it is**: a new box from a snapshot, of the same kind and at least
  the same size, on the same host or account, with a new name and box ID.
  An agent forks into its own thread; the person forks into the box's
  thread or as a machine of their own. A kept snapshot of a released box
  forks as a machine of the person's. Forks into another thread, chosen by
  the person, are later.
- **It never acts as its source.** Before a fork's BB daemon, Tailscale or
  SSH can start, at its first boot, the guest removes its source's
  identity, as 017 removes the daemon's lock:

  | Removed or made new | Where |
  | --- | --- |
  | BB's machine credentials and host ID | the daemon's folder under `~/.bb-machines/` |
  | The thread's access | `~/.config/bb-box/env` |
  | The tailnet node | Tailscale's state |
  | SSH host keys | made new |
  | Machine ID | made new |
  | bb-box's authorized key | the fork's own |
  | Saved memory | never used: a fork starts from the disk, as the memory holds the source's processes, tokens and identity |

  A guest knows it is a fork because the box ID the backend gives it at
  boot (the hostname on Proxmox LXC, the SMBIOS serial on Proxmox QEMU, a
  file Tart writes into a stopped VM's disk) differs from the one it last
  booted as. Every template and image gains this boot step in unit 7; a
  backend whose images lack it offers no fork (`fork: "none"`), so an old
  template never forks.
- **Then it enrols** under its own box ID as a new BB machine, and gets its
  thread's access, or the person's. bb-box does not say a fork is ready
  until it has checked, through the fork's own transport, that the source's
  credentials are gone.
- **It records where it came from**: its page's facts say "Forked from
  amber-fox, 'before the migration' (today 10:42)". It is not tied to its
  source: either can be released alone.

### 9. Security

What a snapshot holds, from the code (the research's
[Security](../research/box-snapshots.md#security) has the paths): the
thread's access in the env file, `GH_TOKEN` among it; BB's machine
credentials; a tailnet node; SSH host keys and the machine ID; in a memory
snapshot, every process's environment and whatever was typed; and whatever
the work put there.

So:

1. A snapshot is as secret as its box. Only its owner and the person see
   it, as [section 3](#3-who-owns-a-snapshot-and-who-sees-it) says.
2. A restore of the same box writes the thread's current access again
   ([section 5](#5-a-restore-says-what-goes-and-takes-an-undo-first), step
   6), so a token revoked since does not come back into use.
3. A fork drops its source's identity before anything can use it
   ([section 8](#8-a-fork-is-a-new-box-with-a-new-identity)).
4. A kept snapshot outlives its thread. The Snapshots tab says it holds
   "files and access from the thread". A fork of it gets the person's
   access, never the old thread's.
5. Memory snapshots are by choice (question 2), except on a Tart macOS box,
   where every snapshot holds memory and the dialog says so.
6. Nothing is shared through a provider: boat's share codes and an
   organisation's shared snapshots are not used.
7. Pictures are as secret as their snapshot, and can be turned off.
8. Snapshot names, notes and labels on the provider carry no secrets: the
   label is the install, box and snapshot IDs only; names and notes stay in
   bb-box's record, except on boat, where the saved snapshot's name is the
   label and the person's name for it stays with bb-box.

### 10. The pages

#### The Snapshots tab, on the Boxes page

A third tab, after Machines and Threads, with its count. Its path is
`/plugins/bb-box/desktop/snapshots`, as `threads` and `machines` are.

```
Machines 2   Threads 7   Snapshots 14                           [⚙] [+ New box]
14 snapshots, 9 by agents · 38 GB on 3 hosts · about $3.40 this month

[Search snapshots                        ] [Filters] [Sort]

┌ amber-fox  Linux  Desktop  LXC · Proxmox LXC on pve-1 · Fix the sign-in flow ↗ ┐
│ [pic] before the migration                                 ⟲   ⑂   ⋯           │
│       Today 10:42 · by the agent · disk · 1.2 GB · goes with the box           │
│ [pic] Thu 09:15  Kept                                      ⟲   ⑂   ⋯           │
│       Thu 09:15 · by you · disk · 3.4 GB · kept until 29 Nov                   │
└────────────────────────────────────────────────────────────────────────────────┘
┌ grey-ridge  Linux · boat.dev · released 12 Oct                                 ┐
│ [ ▢ ] release candidate set-up  Kept                            ⑂   ⋯          │
│       12 Oct · by you · disk · $0.056 a day · goes in 3 days                   │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **The line under the tabs** says the count and how many by agents, the
  space by host where known, and the month's cost where any provider
  charges. Things that need the person come first, in amber: "2 go within 7
  days", "pve-2 cannot take snapshots: its token lacks VM.Snapshot".
- **Grouped by box**, in hairline cards as the Threads tab's. The card's
  head names the box (a link to its page), its kind badges, where it lives,
  and its thread (a chip that opens it) or "Your machine". A released box's
  head says "released 12 Oct" and links nowhere.
- **A row**: the picture; the name, with badges for `Memory`, `Kept` and
  `Undo`; then one line: when, by whom ("by you", "by the agent", the
  thread being on the card), what it holds, its size where known, its price
  where any, and its life: "goes with the box", "kept until 29 Nov", or
  "goes in 3 days" in amber. A `taking` row has a spinner and "Taking…"; a
  `failed` or `lost` row says so in red with the backend's words. No
  chevron: a snapshot has no page of its own; its picture opens larger.
- **Actions**, at the right of the row: Restore (an icon button, "Restore
  amber-fox to this…"), Fork (an icon button), and the menu: Rename…,
  Note…, Keep 30 days or Keep 30 more days, Keep until…, Stop keeping, Copy
  ID, and Delete…. A released box's rows offer no Restore. Keyboard: each is
  reached by Tab, in that order, with its name said.
- **Select**: a Select button beside Sort shows a checkbox on each row;
  with some ticked, a bar offers Keep 30 days and Delete…, with how much
  they free.
- **Filters**, with counts, as the Boxes page's: Where (each backend and
  host), Holds (disk; disk and memory), Taken by (you; agents), Kept (kept;
  not kept), Goes within 7 days. **Sort**: newest, oldest, largest, price,
  box name.
- **Search** matches the snapshot's name and note, the box's name and the
  thread's title.
- **Empty**: "No snapshots yet. An agent takes one before a risky change,
  or take one from a box's page." With the backends that have none named
  below: "Boxes on the SSH host pool have no snapshots."

#### On a box's page (069)

A Snapshots card after Top processes and before the facts, and Take
snapshot… in the header's menu:

```
┌ Snapshots   2 of 5 · disk · on pve-1                       [Take snapshot] ┐
│ [pic] before the migration                         ⟲   ⑂   ⋯             │
│       Today 10:42 · by the agent in Fix the sign-in flow · 1.2 GB         │
│ [pic] Thu 09:15  Kept                              ⟲   ⑂   ⋯             │
│       Thu 09:15 · by you · 3.4 GB · kept until 29 Nov                     │
│ Snapshots hold the disk. They go when amber-fox is released, unless kept. │
└───────────────────────────────────────────────────────────────────────────┘
```

- A box whose backend has none says so in the card, in one line, and has no
  Take snapshot: "Boxes on the SSH host pool have no snapshots."
- A box whose backend has them but cannot take one now says why, with Take
  snapshot disabled: "pve-2's token cannot take snapshots. Fix it in
  Settings." or "amber-fox is stopped; Proxmox can take a stopped box's
  snapshot" (where it can, it is enabled).
- After a restore, the notice of [section 5](#the-persons-restore) at the
  top of the page, with the other notices (069 section 7).
- A fork's facts gain "Forked from".

**Take snapshot** opens a small dialog:

```
Take a snapshot of amber-fox

Name   [Today 10:42                ]
Note   [                           ]
[ ] With its memory
    About 4 s. amber-fox pauses for a moment. Up to 8 GiB more on pve-1.
    A restore then brings back its running apps, and the secrets in them.

It holds the disk: files, installed apps and settings. About 1 s; amber-fox
keeps running. 3 of 5 for amber-fox after this. A picture of its screen is
kept with it.
                                           [Cancel]  [Take snapshot]
```

- "With its memory" shows only where the backend gives the choice, unticked.
  On a Tart macOS box it is a sentence instead: "It holds its memory too:
  amber-fox suspends and resumes, about 20 s."
- The words come from `snapshotting(kind)` and `snapshotRoom`, never
  guessed.
- On Take, the dialog closes and the row appears at the top of the card in
  `taking`, then turns `ready` with "took 0.7 s". A failure stays as a red
  row with the backend's words for 24 hours.

**Fork** opens a dialog: the new box's name (made as any box's), where it
goes (the box's thread, or as a machine of the person's), its size (the
source's), what it costs in time and space ("A full copy: about 10 s, and
13 GB on pve-1"), and what it is: "A new box with amber-fox's files as they
were at 10:42. It gets its own BB machine, address and keys, and never acts
as amber-fox. It starts fresh: no apps are running." On Fork, the dialog
closes and the new box's page opens, starting.

**Delete** asks: "Delete 'Thu 09:15'? Frees 3.4 GB on pve-1." or, on
LVM-thin, "Frees what it no longer shares with amber-fox." A kept one adds
"You kept it until 29 Nov." An undo adds "It is the undo of the restore at
11:02."

#### Settings (067)

Options gains a Snapshots row, between Images and Devices, whose value
reads "5 per box · kept 30 days · up to $5 a month on boat.dev", opening a
page one step in:

| Group | Setting | Default | Notes |
| --- | --- | --- | --- |
| Each box | Snapshots per box | 5 | 1 to 50 |
| Each box | Keep each host's snapshot storage below | 85% full | 50% to 95% |
| Keep | Keep keeps a snapshot for | 30 days | 1 to 365 |
| Agents | Agents may restore their own boxes | on | a switch; off, `box_restore` refuses and says to ask the person |
| Pictures | Keep a picture of the screen with each snapshot | on | a switch |
| Paid snapshots | A ceiling a month, per provider that charges | $5 | with this month's projection beside it: "$0.84 of $5.00" |
| What each backend offers | one row per backend, read only, from `snapshotting` | | "Disk; restores any; forks by full copy · no charge"; a row with a problem says it, with the fix; a click opens the backend's page |

- The switches sit at the right of their rows, just before the chevron
  where a row has one, as every switch in 067 does.
- Each backend's own page gains a Snapshots line among its facts.
- The settings live under `general.snapshots` in the configuration
  document, through 067's engine, so Find, drafts and the merge apply.

#### Words

- "Snapshot", never "checkpoint" or "backup". "Restore", never "roll back"
  or "revert" (Proxmox's word stays in the log's backend words). "Fork",
  never "clone" or "duplicate". "Keep", "kept until", "goes with the box".
- What it holds: "disk", "disk and memory". In sentences: "files, installed
  apps and settings"; "its running apps".
- Who: as 069: "by you", "by the agent in (thread)", "by a bb box command",
  "by bb-box: (why)", "outside bb-box".
- Sizes in GB for snapshots, as providers bill; GiB for a box's memory and
  disk, as 069 says them.
- Prices as the provider gives them: "$0.056 a day"; totals "about $3.40
  this month".

#### Look and motion

BB's tokens and components, the hairline cards of the Boxes and settings
pages, and no page motion. A new row appears in place; a deleted row goes
without a fade; a `taking` row's spinner stops under reduced motion.
Pictures have a 1 px border at the border token and a 6 px radius, inside a
card of 8 px. Numbers are tabular. Amber and red carry words, never colour
alone.

#### Keyboard, screen readers and narrow windows

- Tab reaches, per row, the picture's button, the name's menu, Restore,
  Fork and the menu. Each icon button has its name and the snapshot's
  ("Restore amber-fox to before the migration").
- The dialogs are alert dialogs; focus starts on the safe choice: Cancel in
  Restore and Delete, the name in Take snapshot.
- The restore's progress and result are said in a polite live region.
- At 390 px: the picture shrinks to 48 by 30 px; Fork moves into the menu;
  the line under a name may take two lines, with the life first when it is
  amber.

### 11. How it is built

Each unit is one PR with its tests and docs, a keyboard pass and
screenshots at 1,440, 760 and 390 px in light and dark where it has UI, and
a live check on a separate BB in a box: a fresh `npx bb-app` with no
account, bb-box installed from the unit's branch, with boxes made through
it. Proxmox first, as its snapshots are fast, native and on every Proxmox
host bb-box supports.

| Unit | Change | Size | Live check |
| --- | --- | --- | --- |
| 1 | The record and `snapshots.db`; `Snapshotting` and the optional methods; the box log's events; Proxmox LXC and QEMU take, delete, `heldSnapshots`, `snapshotRoom`, delete with the guest; the pictures; the reconcile at start and in the sweep; `box_list` and `box_status` say what a box's snapshots hold. **The Proxmox permission change**: `VM.Snapshot` and `VM.Snapshot.Rollback` in `setup-token.sh` and the LXC guide's table, a doctor check `proxmox.snapshots` that reads the token's permissions and says which are missing, and snapshots off on that backend with that reason until they are there | M | A token made by the branch's `setup-token.sh`, and one made by `origin/main`'s: the doctor passes the first and names the two missing for the second. An LXC and a QEMU box: take, with and without memory on QEMU, list, delete; a snapshot deleted outside bb-box becomes `lost`; one made outside with bb-box's label is found again; a box released takes its snapshots with it |
| 2 | Restore: the undo, the hard stop first on LXC, the steps of section 5, the box's `restoring` state, the box log's events, a rollback made outside bb-box logged as such | M | Restore an LXC and a QEMU box, with and without memory; time each step (target: about 3 s for LXC, 4 s for QEMU, plus the start); a box restored while its BB machine runs a thread is guarded; after a restore, the env file holds the thread's current access and the Proxmox tags name the box's owner now; `qm rollback` run on the node shows as "outside bb-box" |
| 3 | The tools and the CLI: `box_snapshot`, `box_snapshots`, `box_restore` with `replace`, `undo` and `person_agreed`, `box_snapshot_delete`; a restore deferred to a turn's end; the per-box limit and the room rule; the skill's words and the reference | M | An agent in a thread on the test BB takes three snapshots, breaks its box, restores, and undoes; on a machine of the person's, a restore without `person_agreed` is refused with the words to ask, and with it is logged with the quote; a restore of the box its thread runs on runs after the turn ends |
| 4 | The box page's Snapshots card, Take snapshot, the restore dialog and its notice with Undo, Delete, Rename and Note | M | From the page: take with and without memory, restore with and without undo, undo, delete; a guarded restore names the working thread; keyboard only; 390 px |
| 5 | The Snapshots tab: groups, filters, sort, search, Select; Keep, Keep until, Stop keeping, expiry and its warning; kept snapshots of released boxes | L | 20 snapshots on 4 boxes on two hosts; keep one, release its box, and see it listed released; set a keep date to tomorrow with a set clock and see "goes in 1 day", then gone after the sweep |
| 6 | Settings' Snapshots page: limits, room, keep length, the agents' switch, pictures, the paid ceiling and projection, what each backend offers; the backend page's line | M | Each setting changed and seen to bite: a sixth snapshot by an agent removes the oldest, by the person is refused; the room rule refuses at a set threshold; pictures off takes none; the agents' switch off refuses `box_restore` |
| 7 | Forks on Proxmox: `forkSnapshot` by full clone, the identity reset at first boot in every Linux template and image, the check before ready, `box_fork`, Fork on the pages | M | Fork an LXC and a QEMU box: the fork enrols as a new BB machine; the source's host ID never shows a second connection in BB's machine list; the fork's SSH host keys, machine ID and env file differ from the source's; a fork of a memory snapshot boots from the disk; an old template offers no fork |
| 8 | Tart: macOS snapshots as APFS copies of the suspended VM beside the VMs, with memory; Linux VMs, disk only and stopped; restore by putting a copy back; a fork by `tart clone` without the saved state and with a new MAC address; a guard against a state saved under another macOS build | M | On a Tart Mac box, never a pool Mac someone else holds: a 16 GiB macOS box's take, restore and fork timed; a copy on another volume refused |
| 9 | microsandbox: native snapshots, restore as a new guest, fork | S | A light Linux box: take with memory, restore, fork |
| 10 | boat.dev: a stopped fork as the trial's checkpoint, free for 14 days; a saved snapshot on a paid plan within the ceiling; restore as a new guest; the price on each row | M | On the trial: take and restore by the stopped fork. A paid plan is the owner's to give: until then, the ceiling's refusal is tested against a fake priced backend |
| 11 | Docker, Hetzner and Namespace Linux boxes: a commit with a copy of the box's Docker volume; restore as a new container | M | A Docker box with images in its own Docker: take, restore, and its images are still there |
| 12 | Android devices' own snapshots, in a device box | S | Save, restore, and the open app comes back |
| Later | Moving a snapshot between hosts by export; forks into another thread; iOS devices; a registry push for Namespace | | |

Units 1 to 6 make snapshots whole on Proxmox; 7 adds forks; 8 to 12 add a
backend each, each filling in `snapshotting` and its methods and changing
nothing else.

### The Proxmox permission change

- `setup-token.sh` adds `VM.Snapshot` (take and delete) and
  `VM.Snapshot.Rollback` (restore) to its role's privileges. Run again on
  a host, it modifies the role, as it already does, so existing installs get
  them by running it once more. A memory snapshot's state volume is written
  to the storage the token already has `PVEDatastoreUser` on.
- The LXC guide's table of privileges gains both rows.
- The doctor's `proxmox.snapshots` check reads the token's permissions on
  the pool (`GET /access/permissions`) and passes, or says: "The token
  cannot take snapshots: it lacks VM.Snapshot and VM.Snapshot.Rollback.
  Run setup-token.sh again on the host, or give the role both." Until it
  passes, `snapshotting` on that backend says why, and the pages say it.
- The storage must take snapshots. The LXC guide already asks for LVM-thin,
  ZFS or Ceph; the check also refuses a storage type that cannot, naming
  it.

## Open questions for the owner

Each has a default the build follows unless the owner says otherwise.

1. **The paid ceiling's starting value.** Default: $5 a month per provider
   that charges, about three of boat's saved snapshots held all month.
   The other choice is $0, so none until the person sets one.
2. **An agent's restore of the box its thread runs on** ends its own turn.
   Default: accept it and run it when the turn ends, as section 5 says. The
   other choice is to refuse it, so only the person restores such a box.
3. **Snapshots per box.** Default: 5, kept ones included, an agent's sixth
   replacing its oldest. The other choice is 10.

## Alternatives considered

- **A portable format of bb-box's own** (the research's shape B). An order
  of magnitude slower per take, no memory, a store to run, and secrets in
  an archive away from the box. It can come later as the export of a
  snapshot, for moves.
- **Each provider's snapshots shown as they are** (shape C). The core would
  name providers, and the person would learn each one's words.
- **A page per snapshot.** A snapshot has little to show beyond its row and
  picture; a page would be one more step before Restore.
- **Snapshots only on a box's page.** A kept snapshot has no box, and space
  and cost across boxes would be invisible.
- **Undo kept in memory only, as a short "Undo" toast.** An undo must
  survive a reload and a restart of bb-box, so it is a snapshot.
- **An agent's restore asked of the person each time.** The owner chose
  otherwise: an agent restores its own box, with the undo first.
- **Fork from memory.** The memory holds the source's processes and tokens;
  a fork starts from the disk.

## The prototype

Open [070-snapshots/prototype.html](070-snapshots/prototype.html) in a
browser. It is one file with nothing to install, and saves nothing. It uses
bb-box's own tabs, search row, row title, badges, status dots, icon
buttons, settings rows and switches, with BB's buttons, menus and dialogs.
A fake server holds nine boxes and fourteen snapshots under generic names,
takes a snapshot in about 1 s (4 s with memory), restores in about 4 s and
forks in about 4 s, and keeps a box log. Pictures are drawn by the
prototype, not real screens. Add `?light` for the light theme.

The dashed Prototype panel, bottom left, goes to: the Snapshots tab, a
desktop box on Proxmox LXC, a VM with a memory snapshot, a Mac on Tart, a
box on boat.dev with paid snapshots, an Android device box, a box with no
snapshots, a box whose token cannot take them, a released box's kept
snapshot, and Settings. It
makes the next take, restore or fork fail, makes an agent take a snapshot
and restore its box as you watch, and switches dark and light.

Worth trying:

1. On amber-fox's page, Take snapshot, with and without memory; see the
   row appear in `taking`, then ready.
2. Restore amber-fox to "before the migration": read the dialog, keep the
   undo, then use Undo in the notice.
3. Untick the undo and see the button turn red.
4. On the Snapshots tab, filter to agents, sort by largest, and Select two
   to delete.
5. Keep grey-ridge's snapshot 30 more days; see "goes in 3 days" go.
6. Fork amber-fox's snapshot as a machine of yours.
7. "An agent restores its box" in the panel, and watch amber-fox's page.
8. In Settings, change the ceiling below this month's projection.

Screenshots, at 1,440 px wide unless named, taken by a script that drives
the prototype on a box: [the Snapshots
tab](070-snapshots/new/01-snapshots-tab.png), [a picture opened
larger](070-snapshots/new/02-picture.png), [two
selected](070-snapshots/new/03-select.png) and [their
delete](070-snapshots/new/04-delete-two.png), [agents'
only](070-snapshots/new/05-filter-agents.png), [a desktop box's
page](070-snapshots/new/06-desktop-box.png), [Take
snapshot](070-snapshots/new/07-take-lxc.png), [a take in
progress](070-snapshots/new/08-taking.png), [the restore
dialog](070-snapshots/new/09-restore-dialog.png), [without
undo](070-snapshots/new/10-restore-without-undo.png),
[restoring](070-snapshots/new/11-restoring.png), [the notice with
Undo](070-snapshots/new/12-restored-notice.png), [the undo's
dialog](070-snapshots/new/13-undo-dialog.png), [Fork](070-snapshots/new/14-fork-dialog.png),
[a fork starting](070-snapshots/new/15-fork-starting.png), [a VM with a
memory snapshot and a failed take](070-snapshots/new/16-vm-memory-failed.png),
[with its memory](070-snapshots/new/17-take-with-memory.png), [a Mac on
Tart](070-snapshots/new/18-take-tart.png), [a token without the
rights](070-snapshots/new/19-token-lacks-rights.png), [a box with
none](070-snapshots/new/20-no-snapshots.png), [a released box's kept
snapshot](070-snapshots/new/21-released-kept.png), [Settings'
Options](070-snapshots/new/22-settings-overview.png), [the Snapshots
settings page](070-snapshots/new/23-settings-snapshots.png), [the ceiling
passed](070-snapshots/new/24-ceiling-passed.png) and [a take it
refuses](070-snapshots/new/25-take-refused-ceiling.png), [an agent's
restore](070-snapshots/new/26-agent-restored.png), [the tab at 390
px](070-snapshots/new/27-phone-tab.png), [a box at 390
px](070-snapshots/new/28-phone-box.png), [the tab at 760
px](070-snapshots/new/29-760-tab.png), and light ([the
tab](070-snapshots/new/30-light-tab.png), [a
restore](070-snapshots/new/31-light-restore.png)).

What it does not do, where the build follows this note:

- The tools, the CLI, an agent's restore of a machine of the person's
  with `person_agreed`, and a restore deferred to a turn's end.
- Keep's expiry by the sweep, the reconcile with the backend, and `lost`
  snapshots.
- Real room on a host: each host's fullness is a fixed number.
- The Machines and Threads tabs, and Activity and Top processes on a box's
  page, are stand-ins for 069's.
- Its search row copies the Boxes page's classes rather than using
  `SearchRow`, whose filters are box tags; the build gives `SearchRow` the
  snapshots' filter groups instead.

To rebuild it, on a box: `npm ci` at the repository's root, then `npm ci`
and `npm run build` in `docs/decisions/070-snapshots/prototype`, which
writes `prototype.html` beside the folder. `npx tsc -p tsconfig.json
--noEmit` there typechecks it.

## Consequences

- bb-box keeps a third small file of its own, `snapshots.db`, with
  pictures, capped at 64 MB.
- Every Proxmox install needs `setup-token.sh` run again for snapshots;
  until then the doctor and the pages say so, and nothing else changes.
- Every Linux template and image gains a boot step that drops a fork's
  inherited identity (unit 7), beside 017's.
- Agents gain five tools, and the skill gains when to use them.
- The box log records snapshots, restores and forks, and restores made
  outside bb-box on Proxmox.
