# 070 results

What was built and checked for each unit of [070](070-snapshots.md). Each
unit keeps to its own section.

## Unit 1a: the snapshot record, and Proxmox LXC take and delete

Built on 30 October 2026, on main `9e7f9b6b` (unit 0 included).

### What changed

- **The record and `snapshots.db`.** `snapshots.db` is a file of its own
  beside bb-box's database, attached as `box-log.db` is, with its own
  migrations, write-ahead log and a 64 MB cap. It holds two tables: the
  snapshots, with every field of section 1's record, and their operations,
  with every field of section 6's. Records and operations are never
  evicted; an operation whose snapshots are all gone is pruned 30 days
  after the last of them went. The tables' checks already allow every
  state, operation kind and picture state 070 names, so later units need
  no rebuild. An existing `snapshots.db` that cannot be opened fails
  closed: no ledger takes its place, every snapshot change is refused, the
  box sweep keeps every leftover guest, and the doctor fails. Only where
  there is no such file and BB's handle refuses to attach one do the
  records live in bb-box's own database; they move into `snapshots.db` the
  first time it attaches. `src/plugin/snapshot-store.ts`,
  `src/plugin/attached-files.ts`.
- **The rules**, pure and tested on a set clock, in `src/core/snapshot.ts`:
  IDs (`sn` or `op` and 12 letters and digits), names (60 characters,
  unique per box with " (2)", the time by default), notes (1 KB),
  `eligible(snapshot, change)`, `mayAct(caller, act, standing, snapshot)`
  (which decides what an agent may see first, then applies a kept
  snapshot's rules, then the box's row of section 3), what counts against
  the 5 per box (undos apart, a kept undo counted), the limit's victim,
  the undo a new undo may replace, the room sweep's candidates, and bulk
  judging with a reason for each one skipped.
- **Pins are the operations.** A snapshot is pinned while an operation that
  names it is `running` or `unknown`; nothing else pins. So pins end with
  their operation by construction, and an operation bb-box cannot confirm
  keeps its pin.
- **Operations, on the box's queue.** `Boxes.inTurn` runs a snapshot
  operation on the box's `#chain` with its start, stop, resize and release.
  `src/core/snapshots.ts`:
  - A take plans first (`planSnapshots`), refuses what the plan refuses (a
    lock, with the host's command; the token's rights; storage that takes
    none, for any of the guest's disks), then in one transaction on
    `snapshots.db` checks the limit, the room (85% full, or 85% with what
    it adds, or 80% of thin metadata, counting what unsettled operations
    reserved on that physical storage, whichever backend made them), names
    it, and writes the record (`taking`) and its operation (`running`)
    before the backend is asked. A memory take checks and reserves the
    storage the plan says its memory goes to, at the size the plan says.
    The operation records `submitting` just before the provider is asked,
    and the provider's task just after it answers, before bb-box waits.
    The record is `ready` only when the backend confirms it complete and
    its task succeeded; `failed` when the backend says nothing is held;
    `incomplete` when part of it is, or its task failed; and stays
    `taking`, its operation `unknown`, when bb-box cannot tell.
  - A delete checks `eligible` at the moment of the change, on the box's
    queue, then records `deleting` and its operation before the backend is
    asked. A failed or lost record is removed with no call to the backend.
  - A request ID is the caller's own, bound to its box, kind and
    arguments. A repeat returns the same operation, also once its snapshot
    is gone and after bb-box restarts; a reuse for anything else is refused
    ("Request ID "r" was used already, for another take or delete. Make a
    new one for this.") and changes nothing. The check runs again inside
    the transaction that writes the operation, so the same request on two
    boxes at once makes one take and refuses the other.
  - Operations run as bb-box's own, under its stop signal, not the caller's.
- **Restart recovery.** At start, and at each sweep for operations bb-box
  could not confirm, `recover` lists each backend's snapshots once and
  reads each operation's provider task. An operation that reached
  `submitting` with no task recorded has its task looked up by its guest,
  type and time, skipping tasks another operation holds. Then:
  - a take is `ready` only if its task succeeded and the snapshot is
    whole; `incomplete` if part of it is left or its task failed; `failed`
    if its task failed and nothing is left, or if it never reached the
    provider (never taken again);
  - a delete is done if the snapshot is gone, finished if it never began,
    and the record put back if its task failed;
  - a task still running, a task bb-box cannot read, a whole snapshot with
    no task to confirm it, and a task Proxmox no longer has for a snapshot
    that is absent each leave the operation `unknown`, pinned, with why.
- **The reconcile**, at each sweep, before the box sweep: a failed listing
  makes `ready` records `unavailable` (logged once) and marks nothing else;
  a backend not in the settings makes them `unavailable` too; a successful
  listing brings them back `ready`. A record missing from a successful
  listing is `lost` only when a second listing 10 minutes later still lacks
  it. An `incomplete` record whose snapshot is gone is removed, logged as
  outside bb-box. A labelled snapshot with no record gets one again: by no
  one bb-box knows, named by its time; as kept when its label carries a
  keep date not passed; as found on its host when its box is gone, deleted
  after 7 days. A snapshot whose record changed after the listing began, a
  release's removal included, is left for the next listing. Housekeeping
  removes failed records after 24 hours and lost ones after 7 days, and
  deletes kept snapshots past their date and room-sweep candidates past
  92%, each through `eligible` at the moment of the change.
- **The box sweep keeps guests that hold snapshots bb-box keeps.** Before
  it releases a guest no box records, it asks the snapshots' ledger: a
  guest holding a found, kept or pinned snapshot stays, and the sweep
  reports it as "Guests kept for the snapshots they hold". With
  `snapshots.db` unreadable, it keeps every such guest.
- **A box's end.** A released box's snapshots go with it (Proxmox deletes
  them with the guest), each logged "by bb-box: its box was released", and
  each removal is a settled operation, so a listing that began before the
  release records none of them again; a forgotten box's stay,
  `unavailable` and marked gone; a kept one stays, marked gone.
- **Removing a backend** that holds snapshots is refused in the
  configuration's check, naming how many, their size and price; `bb box
  snapshot forget <backend> --yes` drops bb-box's records of them.
- **The backend interface**: `Snapshotting`, `SnapshotPlan` (with a
  physical storage key, and where a memory snapshot goes and what it
  adds), `snapshotting`, `planSnapshots`, `snapshot`, `deleteSnapshot`,
  `heldSnapshots`, `providerTask` and `findTasks`, with `SnapshotFailed`
  and `SnapshotIncomplete` for what a backend knows it left.
  `src/backends/types.ts`.
- **Proxmox**, shared by LXC and QEMU in
  `src/backends/proxmox/snapshotting.ts`: a snapshot is `bb<id>`, labelled
  `bb-box install <install> box <box> snapshot <id>`, with ` kept
  <yyyy-mm-dd>` once kept. The plan reads the guest's config, the status of
  each disk's storage, the token's rights on the pool (kept a minute) and,
  for LVM-thin, the metadata of the storage's own thin pool, found through
  the storage's settings; when it cannot read them it says why, and so does
  the doctor's Snapshots check. A storage's key is the node and its name,
  or its name alone when it is shared, so two backends on one pool share
  reservations. A take and a delete start Proxmox's task, record its UPID,
  wait, then read the guest's snapshot list: `snapstate` means part of it
  is left. A delete first checks the snapshot's label names this install,
  the box and the snapshot, and refuses otherwise; a part-made snapshot is
  deleted with `force`. A locked guest is refused: while a task runs on it,
  "try again when it ends"; with none, the host's `pct unlock <vmid>`; when
  bb-box cannot read its tasks, the unlock only "if no task is running".
  The listing reads each guest of this install's boxes, and calls a
  part-made snapshot whose guest has a task running, or whose tasks cannot
  be read, "in progress", not incomplete. Proxmox LXC offers disk
  snapshots, taken live.
- **The box log** gains `snapshot-taken`, `snapshot-failed`,
  `snapshot-deleted`, `snapshot-lost` and `snapshot-unavailable`. Its first
  migration is kept as it was (a test pins its hash), and a new one
  rebuilds the table so that it allows every kind 070 names, keeping every
  event.
- **Words.** `box_list` and `bb box kinds` say each offer's snapshots
  ("Snapshots: its disk, while it runs."); `box_status` and `bb box status`
  say the box's, naming only those the caller may see and counting all of
  them against the 5 ("Snapshots: 4 of 5: ..., and 3 you cannot see"). The
  doctor has a Snapshots section for `snapshots.db`.
- **The CLI**: `bb box snapshot take <box> [--name] [--note] [--memory]
  [--request]`, `list [<box>] [--all] [--kept] [--json]`, `delete <box>
  <snapshot> [--request]`, `forget <backend> --yes`, and, only with
  `BB_BOX_LIVE_CHECKS=1`, `hold-next --at planned|task` for the restart
  checks. `bb box sweep` runs the snapshots' sweep first.
- **Docs**: the guide's [Snapshots](../guide/snapshots.md) page, the
  reference regenerated, and 070's [Decided during unit
  1a](070-snapshots.md#decided-during-unit-1a).
- **Deferred, not proved**: when an agent takes a sixth snapshot, section 8
  deletes its thread's oldest unkept one once the new one is ready. Agents
  take no snapshots until unit 5, so 1a refuses a sixth for everyone;
  `limitVictim` chooses the snapshot and is tested alone, and unit 5 wires
  it into the take.

### Tests

On a Linux box, 8 cores, 16 GiB, Node 24.21, on this unit's commit over
main `9e7f9b6b`: `npx tsc` passes; the node suite ran 2,989 tests,
2,701 passed, 0 failed, 288 skipped (the live and conformance
ones); vitest ran 380, all passed. The node suite includes the docs,
site and reference checks. New tests, each on a set clock where time
matters:

- `test/snapshot-rules.test.ts`, 18: IDs and names; a pin refuses every
  change and names its operation; pins end with their operation, and an
  unknown one still pins; automatic deletions never take a kept, the
  person's, an undo or a snapshot no agent took; delete, expiry, found
  orphans, keep, unkeep, rename and note; what counts against the 5; the
  limit's victim; `mayAct` for a thread's own box, a box it runs on,
  another thread's box, a guessed ID, a box that is gone, the person, a
  command, and a kept snapshot; and G9's four reviewers' sequences at the
  level 1a builds, pins and `eligible` (below).
- `test/snapshots.test.ts`, 40: the engine through `Boxes` and a fake
  provider: take, names, the limit, room and reservations (by physical
  storage, and on a memory take's storage), locks and refusals, failed,
  incomplete and unconfirmed takes, a take ready only when its task
  succeeded, G9's races (two takes at once, a repeated request, a request
  bound to its caller, box, kind and arguments, the same request on two
  boxes at once, a take and a release, a delete and a take, two deletes), a
  restart at each step of a take and of a delete, including the gap
  between asking the provider and recording its task, a task that cannot
  be read and one Proxmox no longer has, G2 (an hour unlisted is
  unavailable, never lost; lost after two listings 10 minutes apart; a
  release during a listing; a backend that leaves the settings; the refusal
  to remove it), G3 (records gone, every snapshot found, kept ones as kept,
  an orphan deleted after 7 days only), the box sweep keeping a guest that
  holds snapshots, a forgotten box, agents' sight and deletes, `box_status`
  counting every snapshot, a `snapshots.db` that is unwritable, or exists
  and cannot be opened, records moving into it from bb-box's database,
  pruning, and the box log's migrations (the first one's hash pinned).
- `test/proxmox-lxc-snapshots.test.ts`, 13: labels; the offer; the plan's
  storage, its own thin pool's metadata, and refusals (storage, lock with
  `pct unlock`, a lock a running task holds, the token's right); metadata
  that cannot be read, in the plan and the doctor; a take recording its
  UPID before waiting, and found by guest and time when it was not; a take
  complete only when its task succeeded; G1 (a killed task is incomplete,
  a locked delete names the host's command, and after the unlock a forced
  delete cleans up); failed takes; a guest that is gone; a delete checking
  the label; the listing (other installs' and hand-made snapshots left out,
  a keep date, a part-made snapshot whose task still runs is in progress).
- `test/plugin.test.ts`, one more: `bb box snapshot take`, `list`, `delete`
  and `forget` through the plugin, `box_list` and `box_status` words,
  another thread seeing nothing, and the doctor's Snapshots section.

G9's reviewers' sequences involve restores, keeps, bulk actions and the
room sweep, which come in units 3, 4, 6 and 8. 1a builds the pins and
`eligible` they rest on, so they are tested there: a restore operation
pinning its target, then the undo to replace, a kept undo, bulk delete,
bulk keep and rename of the target, and the room sweep's candidates
checked again at the moment of deletion. They run live once those units
exist.

### On a separate BB

A fresh `npx bb-app` 0.48.1 with no account, its own data folder and
ports, started with `env -i`, `HOME`, `PATH` and `BB_BOX_LIVE_CHECKS=1`
only, in a Proxmox LXC box. bb-box installed from this branch with `bb
plugin install path:`. The lead gave it a Proxmox LXC backend and a Proxmox
QEMU one with the production token, their own VMIDs and addresses, and a
Linux template each; its install ID keeps production's guests and these
apart. Its log on the first start: "Opened snapshots.db, attached to
bb-box's database: ran 4 migrations." `bb box doctor`: "[ok] Snapshots: The
token may take, delete and restore snapshots on /pool/bbbox. local-lvm
(LVM-thin) restores any snapshot." and "[ok] Snapshots' records: ...
snapshots.db, attached to bb-box's database: 0 snapshots, 0 operations not
settled, 40 KB used."

All through `bb box`, on a Linux LXC box of a thread. In the words quoted
below, the node's name is written pve-1, as 070 writes it.

| Check | Result |
| --- | --- |
| Take, with a name and a note | ready in 0.3 s as bb-box timed it, 0.8 s for the command |
| Take again with the same name | "before the migration (2)" |
| Take with no name | "Fri 05:53", the server's time |
| List | each with its ID, state, time, "by a bb box command", disk, size unknown; "3 of 5 for this box" |
| A sixth | refused: "Box calm-island holds 5 snapshots, the most a box may. Delete one first: ..." naming all five |
| Delete by name, and by ID | 0.6 s for the command; "it freed what it no longer shared with its box" |
| A repeated request, sent twice at once | one snapshot: one answer "Took snapshot", the other "was asked for with that request already. It is ready." |
| Two takes at once | both ready, one after the other |
| A take and a release at once | the release was asked during the take, waited, and released the box after it; the box log: release-asked 29.901, snapshot-taken 30.111, released 31.933, snapshot-deleted "by bb-box: its box was released" 31.935 |
| bb-box restarted (`bb plugin reload`) after a take's Proxmox task began (`hold-next --at task`) | at the next start the take was ready, logged "confirmed after bb-box restarted" |
| bb-box restarted after a take was recorded, before Proxmox was asked | failed: "bb-box restarted before the take began, and pve-1 has no such snapshot"; never taken again |
| bb-box restarted after a delete's task began | gone at the next start, logged "confirmed after bb-box restarted" |
| bb-box restarted after a delete was recorded, before Proxmox was asked | finished at the next start: gone |

Each restart's command ended with "bb-box is stopping. (restarting)".

**G1.** The lead ran [`live-root.sh`](070-snapshots/unit-1a/live-root.sh)
as root on the node: it waited for a `vzsnapshot` task on the box's VMID,
matched by its UPID and its worker's title, and SIGKILLed that one worker.
The take then said: "bb-box could not finish snapshot "killed" of box
calm-island: Proxmox left it part-made (snapstate prepare): unexpected
status. Part of it is left on pve-1: delete it to finish the clean-up
there." It listed as `incomplete`, and stayed so through a sweep. Its
delete was refused: "Proxmox has guest 3240 locked (snapshot), so it cannot
delete the snapshot. Run `pct unlock 3240` on pve-1, then delete it
again." The box still answered commands. After the lead's `unlock`, the
delete finished Proxmox's clean-up: "Deleted snapshot "killed" ...".

**G2.** `iptables` in the BB's box dropped every packet to the Proxmox
API's port from 05:59:53 to 06:59:55 UTC. The first sweep after it, at
06:03:06, made all three of calm-island's snapshots `unavailable`,
logged once each, with the backend's words: "bb-box could not list Proxmox
LXC on pve-1's snapshots: Proxmox GET /cluster/resources failed (0):
cannot reach the Proxmox API: Connect Timeout Error". A list every 10
minutes showed them still `unavailable`, none `lost`, for the hour. 47 s
after the API came back, the sweep had them `ready` again, the kept one
still kept. During the hour, `bb box backend remove proxmox-lxc --yes` was
refused: "Backend proxmox-lxc has 1 box, so it cannot be removed or
renamed. Turn it off and release them first." and "Backend proxmox-lxc
holds 3 snapshots on pve-1, an unknown size, at no charge, so it cannot
be removed or renamed. Delete them first, or forget them with bb box
snapshot forget proxmox-lxc: bb-box then drops its records of them, and
they may still exist there and be billed." (Those words now give the
backend's error alone, without "bb-box could not list ...", which
repeated what `unavailable` says.)

**G3.** The lead added a keep date to one snapshot's label with the same
script (`keep-label`). bb-box was disabled, `snapshots.db` deleted, and
bb-box enabled again. Within 20 s the sweep had found all three snapshots
again, by "someone bb-box has no record of", named by their times, the
labelled one "kept until 2026-11-30", and deleted none. The failed record
of the earlier restart, which held nothing on Proxmox, was not found again,
as there was nothing to find.

### After the reviews

Two independent reviews read 1a and 1b: Opus said merge after fixes, and
Astra merge after named fixes. Every finding is fixed in this round, with
tests, except where the table says it is deferred.

| Finding | From | Fix | Tests |
| --- | --- | --- | --- |
| A request ID was global: another box's or kind's reuse answered with the first operation, a delete reusing a take's answered "already", the same request on two boxes at once failed with SQLite's UNIQUE error and marked the store failing, and another thread could read the answer | Opus 1a-1, Astra 5 | The ID is the caller's own (stored with the caller), bound to its box, kind and arguments by a digest; a mismatch is refused in plain words; the check runs again inside the writing transaction; a refusal no longer touches the store's failure state | `snapshots.test.ts`: "a request ID is bound to its caller, box, kind and arguments", "the same request on two boxes at once" |
| A repeated delete after the first finished said not found; the test expected that | Opus 1a-2, Astra 5 | The request is looked up before the snapshot is found, and answers with its operation, also after a restart | "a repeated request is the same take, and the same delete, also after the delete finished and after a restart" |
| A lock held by a running task (a nightly backup) was answered with `pct unlock` | Opus 1a-3 | The guest's running tasks are read first: with one, "try again when it ends", and no unlock; with tasks unreadable, the unlock only "if no task is running" | `proxmox-lxc-snapshots.test.ts`: "a lock a running task holds gets no unlock advice" |
| A release during a listing could give its snapshots a ghost "found" record and a false lost | Opus 1a-4 | Each removal at a release is a settled operation, which the reconcile's check sees | "a release during a sweep's listing leaves no ghost record and no false lost" |
| Thin metadata was skipped silently with no pool or several | Opus 1a-5 | The storage's thin pool is found from its settings; when it cannot be read, the plan says why, and the doctor warns with the token's missing rights | "thin metadata is read from the storage's own thin pool; when it cannot be, the plan and the doctor say so" |
| `ready` did not need the task to succeed, in a take and in recovery | Opus 1a-6, Astra 3 | Both are needed; a failed task with a whole-looking snapshot is `incomplete`, with its words | "a take is ready only when its task succeeded", and its Proxmox twin |
| Recovery took an unreadable task, or a missing task with an absent snapshot, as an ending, released the pin, and said the take never began; task-list errors read as an empty list; the gap between the request and its task being recorded was not covered | Opus 1a-7, Astra 3 | Each of these stays `unknown` and pinned, with why; a `submitting` step is recorded before the request, and a task not yet recorded is found by guest, type and time, skipping tasks other operations hold; a part-made snapshot whose guest's tasks cannot be read is in progress | "after a restart, a take whose task Proxmox no longer has", "a task bb-box cannot read", "the gap between asking the provider and recording its task" |
| A forgotten box's snapshots said "its backend is not in bb-box's settings"; `box_status` counted only what the caller sees | Opus 1a-8 | "its box was forgotten while bb-box had no working backend for it"; every snapshot counts against the 5, and only the visible are named | "box_status counts every snapshot against the limit" |
| The box sweep destroyed a gone box's guest with found or kept snapshots at its second sweep | Astra 1 | The snapshots' sweep runs first; the box sweep keeps a guest holding a found, kept or pinned snapshot, and every guest when the ledger is unreadable | "the sweeps together: a gone box's guest holding a found snapshot is kept by the box sweep", "with snapshots.db unreadable, the box sweep keeps every leftover guest" |
| An existing `snapshots.db` that could not be opened silently became an empty ledger in bb-box's database | Astra 2 | It fails closed; the fallback is only for a handle that attaches nothing and no file; its records move into `snapshots.db` once it attaches | "an existing snapshots.db that cannot be opened fails closed", "records kept in bb-box's database while its handle refused to attach move into snapshots.db" |
| A delete chose the snapshot by name alone | Astra 4 | The label must name this install, the box and the snapshot, or nothing is deleted | "a delete checks the snapshot's own label before it deletes" |
| `mayAct` let an agent restore or fork a kept snapshot on its own box, and see its picture | Astra 6 | What an agent may see is decided first, then a kept snapshot is the person's for everything but seeing it | `snapshot-rules.test.ts`: "a kept snapshot is the person's first" |
| An operation's receipt was pruned 30 days after it ended, even when its snapshot went today | Astra 7 | Kept 30 days from the removal of its last snapshot | "an operation's receipt lasts 30 days from the removal of its last snapshot" |
| The agent's sixth take is refused, not evicting as section 8 says | Opus note, Astra note | Recorded above as deferred to unit 5 | `limitVictim` alone |

### Live again, after the reviews

A fresh `npx bb-app` set up as before, with bb-box from this branch after
the fixes, and the lead's two Proxmox backends. All through `bb box`, on
Linux LXC boxes of a thread. The node's name is written pve-1.

| Check | Result |
| --- | --- |
| G9: the same request sent twice at once, on one box | one snapshot: "Took snapshot "r1" ... in 0.6 s", and "... was asked for with that request already. It is ready." |
| G9: the same request on two boxes at once | one took; the other: "Request ID "live-both" was used already, for another take or delete. Make a new one for this." (`reused_request`); the doctor stayed ok |
| G9: the request reused for a take with another name, and for a delete | both refused with those words |
| G9: a delete, the same delete again, and again after a restart | deleted once; each repeat answered with the first delete, and the take's request after the restart with the take. Those answers named the operation; they now say "Snapshot <id> of box <box> was deleted already, with that request." |
| `snapshots.db` replaced, while bb-box was off, by a file that is not a database | fails closed: the doctor "[fail] Snapshots' records: ... its existing snapshots.db cannot be opened: file is not a database."; a take refused, "So bb-box takes no snapshot until it can."; no records listed and nothing written over the file. With the real file back, every record was there. The doctor's words then said bb-box's handle refused to attach the file, which is not what happened; they now name the file alone |
| G1 again: the lead's script killed the take's worker | `incomplete` with the same words, still so after a sweep; its delete and a new take refused with `pct unlock 3240`; after the lead's unlock, the delete finished |
| A backup (`vzdump`) of the box running, holding its lock | take: "bb-box cannot take a snapshot of box green-cedar now: Proxmox is running a backup on guest 3240, which holds its lock (backup). Try again when it ends."; delete: the same reason, and the snapshot stayed `ready`; no unlock advice |
| The box sweep and a gone box's guest holding a found snapshot | the box's thread archived and its record removed while BB was off, so its guest was left over with a snapshot the reconcile found again; three sweeps in a row each "Guests kept for the snapshots they hold: 1", logged "Kept guest 3242 of box ...: it holds a snapshot bb-box keeps: found and kept 7 days."; once that snapshot was deleted, the next sweep removed the guest |
| G3 again: `snapshots.db` deleted while bb-box was off | within 21 s all three found by "someone bb-box has no record of", the labelled one "kept until 2026-11-30", the gone box's "found on pve-1, not in bb-box's records"; none deleted |
| A take held after its task began, then bb-box restarted with the Proxmox API cut | through the restart the take stayed "being taken" and pinned, its operation unsettled, the other three `unavailable`; once the API was back, one sweep made all four `ready` |

At the end bb-box listed no box and no snapshot, and its sweep no leftover
guest; the lead deleted the stopped backup's partial file.

### Known limit: thin pool metadata

The token cannot read a thin pool's metadata use: `GET
/nodes/<node>/disks/lvmthin` needs `Sys.Audit` on `/`, a read of the whole
cluster, which `host/setup-token.sh` does not give and the owner will not
grant. So on LVM-thin bb-box does not keep 070's rule that a take is
refused past 80% of thin metadata. The take goes on, and the doctor warns:
"bb-box cannot read local-lvm's thin metadata (...), so a take checks the
pool's data use but not that its metadata is under 80% full.", fix
"Reading a thin pool's metadata takes Sys.Audit on /, a read of the whole
cluster, which host/setup-token.sh does not give. Watch the pool's metadata
on the host, or give that right."

The storage's own status, which the token can read, gives the thin pool's
data: used, total and available. That covers the data half of the room
rule whole: the refusal past 85%, or past 85% with what the take adds and
what unsettled operations reserved, and unit 6's room sweep past 92%. It
does not cover metadata, and data use does not bound it. Metadata is a
volume of its own, sized when the pool was made, and it grows with the
number of thin volumes and snapshots and with the blocks each box writes
after its snapshots, while a take adds almost no data at the time. A pool
can fill its metadata with its data well under 85%, and that stops every
guest on the pool, as full data would.

At 1a's scale it is enough: a box holds at most 5 snapshots, and bb-box
takes them only when asked. It is not enough on its own once agents take
snapshots (unit 5) and boxes keep many for weeks (unit 8). Until the right
is given, the pool's metadata should be watched on the host (`lvs` gives
it as `Meta%`), as the doctor's warning says.

### Follow-ups for unit 8

The lead noted both for unit 8, which makes kept snapshots outlive their
box:

- **A kept snapshot at release.** In unit 1a a kept snapshot can come only
  from a label with a keep date, found by the reconcile. When its box is
  released, its record is marked gone, but Proxmox deletes the snapshot
  with the guest, so the next listings mark it lost. Unit 8's held copies,
  made before the guest goes, close this.
- **A leftover guest of an ended thread.** The box sweep now keeps such a
  guest while it holds a found, kept or pinned snapshot. Unit 8 decides
  what then becomes of it: a held copy of a kept snapshot, then the guest
  released.
- **A forgotten box's found snapshots.** In 1a only a forgotten box's guest
  outlives its box, and its snapshots, once found again, are deleted after
  7 days, though the person who forgot the box was told nothing was
  deleted. Opus asks for the owner's look at this before unit 8.

## Unit 1b: Proxmox QEMU take and delete

Built on 30 October 2026, on unit 1a.

### What changed

- Proxmox QEMU offers snapshots of its Linux boxes, `linux` and
  `linux-desktop`: the disk, or the disk and memory, taken while the VM
  runs. Windows (unit 3) and Android device boxes (unit 13) offer none yet.
- It shares unit 1a's Proxmox code. The plan reads every disk's storage,
  the boot disk, other disks, the EFI disk and the TPM state, and refuses a
  take when any of them takes no snapshots. It gives a memory snapshot's
  time as about a second for each GiB of the VM's memory, plus a second.
- **Where the memory goes.** The plan finds the storage Proxmox saves a
  memory snapshot's state on, from the VM's config as Proxmox does: its
  `vmstatestorage`, or else among its disks' storages, a shared one first
  and a file-based one before others. The state volume is twice the VM's
  memory and 500 MiB, which the take checks and reserves on that storage.
  Where the choice depends on an order bb-box cannot know, or a storage's
  settings cannot be read, a memory take is refused with why; a disk take
  is not affected. `--memory` sends `vmstate`; the snapshot holds the disk
  and memory when Proxmox lists it with its state. A part-made take or a
  locked VM names `qm unlock <vmid>`.
- A stopped Proxmox QEMU box is suspended to disk, so its take is refused:
  "bb-box cannot take a snapshot of box fond-fjord now: a stopped Proxmox
  QEMU box is kept suspended to disk, so start it first."
- The guide's Snapshots page names Proxmox QEMU's Linux boxes.

### After the reviews

| Finding | From | Fix | Tests |
| --- | --- | --- | --- |
| Only the boot disk's storage was checked; an EFI or TPM disk on storage with no snapshots was admitted and failed at Proxmox | Opus 1b-1 | Every disk's storage is checked | `proxmox-qemu-snapshots.test.ts`: "the plan checks every disk's storage" |
| A memory take checked the boot disk's storage and reserved the RAM's size, while Proxmox may use `vmstatestorage` and allocates twice the RAM and 500 MiB | Opus 1b-1, Astra 1b-1 | Planned on the target Proxmox would choose, at Proxmox's size, or refused with why | "a memory snapshot is planned on the storage Proxmox saves it to", and in `snapshots.test.ts` "a memory take checks and reserves the storage Proxmox saves the memory on" |
| Reservations were keyed by backend ID, so two backends on one pool did not share them | Astra 1b-2 | Keyed by the physical storage: the node and storage name, or the name alone when shared | "reservations are by physical storage"; the LXC and QEMU plans give `proxmox:pve:local-lvm` for one pool |
| The stopped-VM refusal named the VMID, not the box | Opus 1b-2 | Names the box, and says a stopped Proxmox QEMU box is kept suspended to disk | "a stopped VM's take is refused in words about the box" |

### Tests

On the same Linux box, over unit 1a: `npx tsc` passes; the node suite ran
2,996 tests, 2,708 passed, 0 failed, 288 skipped; vitest ran
380, all passed.

`test/proxmox-qemu-snapshots.test.ts`, 7: the offer, Linux only; the plan's
storage and memory time, and its refusal of a Windows box; a take with and
without memory, listed and deleted; a killed take incomplete and a locked
VM naming `qm unlock`; every disk's storage; the memory target and its
size, shared first, and refused when ambiguous or unreadable; the stopped
VM's words and the pool's storage key.

### On a separate BB

The same BB as unit 1a, bb-box installed again from this branch, the lead's
Proxmox QEMU backend with a Linux template, all through `bb box`, on a
Linux VM of 2 cores and 4 GiB:

| Check | Result |
| --- | --- |
| `bb box kinds` | "Snapshots: on Proxmox LXC on pve-1, its disk, while it runs; on Proxmox QEMU on pve-1, its disk, or its disk and memory, while it runs." |
| Take, disk only | ready in 0.7 s as bb-box timed it, 1.1 s for the command |
| Take with `--memory` | ready in 1.7 s, 2.1 s for the command; "it holds its disk and memory" |
| List, and `bb box status` | each with what it holds; "Snapshots: 2 of 5: ..." |
| The VM after the memory snapshot | answered at once, on the same boot (`uptime -s` unchanged) |
| Delete both | 0.8 s for the command; "it freed what it no longer shared with its box" |
| bb-box restarted after a memory take's task began | ready at the next start, "disk and memory" |
| `snapshots.db` deleted while bb-box was off | all three found again on enable, two "disk and memory", one "disk"; none deleted |
| A take of the stopped VM | refused: "Guest 3250 is suspended to disk. Start the box first." (now in words about the box, above) |
| A record for a snapshot the VM does not have, written into `snapshots.db` beside the real ones | missing at the first listing after it, 07:49:09, still `ready`; `lost` at 08:01:18, at the first listing 10 minutes after, logged as `snapshot-lost` with the words: "not on Proxmox" (snnotonproxmox): pve-1 no longer has it.; the real three untouched |

After the reviews, on the second separate BB, a Linux VM of 2 cores and 4
GiB: a take with `--memory` was ready in 1.8 s, 2.2 s for the command, "it
holds its disk and memory"; a disk take in 0.7 s; both listed with what they hold, "2 of 5 for
this box", and deleted.

## Unit 2: the identity reset

Built on 30 October 2026, on main `827d3315`, in four commits: the reset,
a reset never costing a box, the answers to the reviews, and the answers to
the re-reviews. This section describes the code as it stands after the
fourth; [After the reviews](#after-the-reviews) and [After the
re-reviews](#after-the-re-reviews) say what each changed.

### What changed

- **The guest program**, `bb-box-identity`
  (`setup/proxmox-lxc/template/guest/bb-box-identity.sh`), version 2.
  `customize-base.sh` installs it at `/usr/local/sbin`, so every Linux image
  bb-box builds has it: the Proxmox LXC templates (Linux, desktops, Wayland),
  Proxmox QEMU's Linux and Android images, Tart's Linux images, boat.dev's
  template, and the Docker images that Docker, Hetzner, Namespace and
  microsandbox boxes run. It turns the reset on only when the build sets
  `BOX_IDENTITY_RESET=on`, which only the checked builds do (Rollout, step
  2). Its commands: `boot`, `settle`, `wait`, `write`, `enable`, `disable`,
  `unarm`, `status` and `version`.
- **The marker**, `/etc/bb-box/identity`: a first line `bb-box identity 1`,
  then the box's ID, the source, and either one `mac` line for each of the
  backend's interfaces or one `value` line. A second file,
  `/var/lib/bb-box/identity-armed`, is written after the marker and says a
  marker was written here. `finalize.sh` removes both, and the list of
  resets, so no template, refresh or bake carries them.
- **The boot unit**, which `bb-box-identity enable` writes where systemd
  runs: `bb-box-identity.service`, with no default dependencies, after
  `local-fs.target`, before `network-pre.target` and the services it gates.
  A drop-in makes each of them require it and start after it:
  `systemd-networkd`, `NetworkManager`, `ssh`, `ssh.socket`, `tailscaled`,
  `user@.service` (the box user's manager, which runs BB's daemon),
  `docker`, `docker.socket`, `containerd`, `bb-box-docker-containers`, and
  the desktop's display, session, VNC, Selkies and device firewall. So if
  the check fails, none of them start: it fails closed. It refuses a manual
  stop, which would stop them too. A second unit,
  `bb-box-identity-settle.service`, runs `settle` after it, and `ssh` and
  `tailscaled` require it too; a drop-in for the box user's
  `bb-host-daemon-*` units, BB's daemon, makes each run `bb-box-identity
  wait %n` before it starts. When the boot could not tell, these wait while
  `settle` keeps looking (below); otherwise they go on at once.
- **Docker's image** has no systemd. `bb-box-start` runs `bb-box-identity
  boot --value "$BBBOX_IDENTITY"` before it starts anything; if that fails,
  it exits, starts nothing and never writes `/run/bb-box/ready`.
- **What the marker records**, by backend and kind (`identitySource` in
  `src/backends/types.ts`):

  | Backend | Source | What it records |
  | --- | --- | --- |
  | Proxmox LXC, `linux` | `eth` | the MAC addresses of the interfaces named `ethN`, as `netN` makes them |
  | Proxmox QEMU, `linux` | `device` | the MAC addresses of the interfaces with a device under `/sys/class/net/<name>/device` |
  | Docker, `linux` | `value` | `BBBOX_IDENTITY`, which bb-box sets on each guest when it makes it: the box's ID |
  | The other Linux kinds, Tart, microsandbox, Hetzner, Namespace, boat.dev | none until checked | microsandbox, Hetzner and Namespace boxes get `BBBOX_IDENTITY`, unused |
  | macOS, Windows, iOS, the SSH host pool | none | |

  bb-box writes markers only on the backends in
  `general.identityResetBackends`, empty by default.
- **The comparison at boot.** No marker and no armed record: kept, nothing
  to compare. A marker that is unreadable on a box that had one: reset. If
  any of the marker's MAC addresses is on any Ethernet card, whatever its
  name: kept, and the box's current cards of the backend's are added to the
  marker, so a card added, booted, then the first removed changes nothing.
  Once the cards are known (udev settled, or no udev, as in a container), a
  new one of the backend's with none of the marker's: a copy, reset.
  Otherwise it waits, in 150 loops of 0.2 s, then lets the boot go on
  removing nothing (`boot=unknown`): the network, Docker, the desktop and
  logins start, while SSH, Tailscale and BB's daemon wait for `settle`,
  which looks again every 2 s and decides as above once the cards are
  there. `wait` lets BB's daemon start once the boot is decided, unless its
  machine is named in a reset. A value is compared as it is.
- **The reset**, in order, each step's failure failing the boot: first
  `/var/lib/bb-box/identity-reset-pending`, written and synced, with the
  time, why and the host IDs it will remove, so a reset cut short is
  resumed at the next boot with them; the Tailscale state; in each folder
  under the box user's and root's `~/.bb-machines`, and those set aside,
  every file at its top (`auth.json`, `config.json`, `host-id`, locks,
  ports) but the app's digest, and its `logs`, then BB's daemon's user
  units; the access file `~/.config/bb-box/env`; new SSH host keys (ed25519
  and ECDSA when none are left); a new machine ID; then journald restarts
  so the boot's logs go under it. BB's installed app and the threads'
  folders stay. It writes a marker for the copy's own interfaces, with no
  box, so the next boot does not reset again and a copy of the copy does,
  or unarms the box when it has no card of the backend's to write; adds the
  pending line to `/var/lib/bb-box/identity-resets`; and only then removes
  the pending record.
- **bb-box writes the marker when a box is first ready**, on a backend in
  `general.identityResetBackends`, after a project image's script and
  before the box is ready, and records that it did on the box
  (`identityMarkedAt`); only such boxes are ever checked for a reset, through the box's command
  transport, as `sudo bb-box-identity write --box <id> --source <source>`.
  It takes about 60 to 80 ms, shown as `identity` in the box's timings. For
  `value`, the guest writes the value its own boot saw, never one bb-box
  passes, so a marker always matches the next boot. An image without the
  program, or a write the guest refuses, is logged ("Wrote no identity
  marker in box amber-fox, so a copy of it would not reset, and its
  snapshots cannot be forked: its image has no identity reset.") and the
  box is ready as before. `src/core/identity.ts`, `src/core/boxes.ts`.
- **`forkSafe` at each take.** Before a take is recorded, bb-box runs
  `bb-box-identity status` in the box. `forkSafe` is its version when this
  boot's check ran, the box is armed and the marker matches what the box has
  now; otherwise null, as for a stopped box or one that does not answer
  within 10 s. It is on the record from the start, so a restart keeps it.
  `bb box snapshot list` says of a Linux snapshot without it "not
  fork-safe: amber-fox had no working identity reset when it was taken".
  `src/core/snapshots.ts`.
- **Docs**: the guide's [Snapshots](../guide/snapshots.md#a-copy-of-a-box-gives-up-its-identity)
  page.

### Tests

On a Linux box, 8 cores, 16 GiB, Node 24.21, on this unit's four commits
over main `827d3315`: `npx tsc` passes and the reference is current; the
node suite ran 3,047 tests, 2,759 passed, 0 failed, 288 skipped (the live
and conformance ones); vitest ran 384, all passed. The node suite includes
the docs, site and reference checks. A device-server test that times a
new version within 2 s failed once under the full suite's load (2,187 ms)
in an earlier run, and passed 3 of 3 alone; this unit does not touch it.

- `test/identity-reset.test.ts`, 12, which run the guest program on a fake
  root: a box made before the change, with the program and no marker, keeps
  everything at three boots; on Proxmox LXC the marker holds `eth0` only,
  and `docker0`, a `br-` bridge, a `veth` and `tailscale0` change nothing
  over three boots; new MAC addresses reset every item of 070's table once,
  keep the threads' files and BB's app, and the next boot keeps; on a VM
  only cards with a device count, and a bridge carrying the card's address
  does not; a card that appears 0.6 s late is waited for, and one that never
  appears resets after the wait; a missing marker on an armed box, a wrong
  header, a bad MAC address and an unknown source each reset; a last line
  with no newline is read; a Docker box's value survives a new MAC address,
  and another value or none resets; `write` refuses what would not match at
  the next boot; a reset that cannot finish fails the boot; `forkSafe`'s
  rule; and the unit's order and requirements in `customize-base.sh`, the
  clean-up in `finalize.sh`, and the check's place in Docker's start.
- `test/snapshots.test.ts`, 3 more, through `Boxes` and the fake backend,
  which runs the real program on a fake root: the marker written before the
  box is ready, with its backend's source, and a take's `forkSafe` of 1;
  not fork-safe, with the words, for an image without the program, a
  backend with no source, a marker that no longer matches, and a boot whose
  check never ran; a Docker box's marker holding the value its start saw,
  and a box whose start saw none left unarmed.
- `test/microsandbox.test.ts` and `test/plugin.test.ts`: the variable at
  create, and the list's words.

### On a separate BB

A fresh `npx bb-app` 0.48.1 with no account, its own data folder and ports,
started with `env -i`, in a Proxmox LXC box; bb-box installed from this
branch with `bb plugin install path:`. The lead built two test templates
from this branch's `setup/`, for it only: Proxmox LXC Linux 3243
(`build.20261030-162241-8e67`) and Proxmox QEMU Linux 3252
(`build.20261030-161532-7c81`), and gave it a backend for each, with the
production token and its own VMIDs and addresses. Its Docker backend ran on
the box itself, with images built from this branch by `bb box setup
docker` (4 min). Boxes were "your machines" of that BB; the node's name is
written pve-1.

| Check | Result |
| --- | --- |
| The marker at first ready | written on each: `identity 78 ms` (LXC), `58 ms` (QEMU), `74 ms` (Docker) in the timings; LXC `source eth`, one `mac`; QEMU `source device`, `enp6s18`'s; Docker `source value`, the box's ID. The first boot said "kept: bb-box has written no identity marker here", as it ran before bb-box wrote one |
| The order, `systemd-analyze critical-chain`, LXC 3243 | `bb-box-identity.service @299ms +82ms`, then `network-pre.target @382ms`, then `systemd-networkd`; `ssh` after `basic.target @471ms`; `user@1000` at 544 ms; `systemctl show` gives each of `systemd-networkd`, `ssh`, `user@1000` and `tailscaled` both `Requires=` and `After=` it |
| The order, QEMU 3252 | `bb-box-identity.service @640ms +28ms`, then `network-pre.target @841ms`, then `systemd-networkd +73ms`; the journal: the check, then networkd, ssh and `user@1000` |
| The order, Docker's image | no systemd: the box's log shows the check as its start's first line at each start |
| A take | `forkSafe: 1` on QEMU and LXC; the list adds no words |
| A plain Proxmox clone, LXC | the lead ran `pct clone 3240 3290 --snapname <bb-box's snapshot> --full 1`, then `onboot 0`, no tags, `link_down=1`, outside the pool. The clone had a new MAC address (`bc:24:11:f5:88:c0` for `bc:24:11:fb:91:2c`) and reset at its first boot, at 16:33:26.188, before networkd (.313), ssh (.390), `user@1000` (.410) and tailscaled (.533). Host ID `host_22r4p9imps` gone, credentials, daemon unit and access file gone, new machine ID and SSH host key (`9A4o3Ycd...` for `2QIu6UxB...`), Tailscale state emptied and made again by tailscaled, threads' folders kept. After a reboot: `boot=kept`, one line in the resets |
| A plain Proxmox clone, QEMU | `qm clone 3250 3291 --snapname <bb-box's snapshot> --full 1`, the same settings: new MAC, `source=device`, the same results; host ID `host_5tau2iwvbh` removed. Its `journalctl` found no files: template 3252 predates the journald restart, which the LXC template had |
| Three restarts with Docker containers running and Tailscale's interface | LXC and QEMU, each with a Docker network, two containers with `--restart always` and tailscaled running (no login, see below), rebooted from inside three times: `boot=kept` each time; host ID, credentials, machine ID, SSH host key, Tailscale state and access file unchanged; `docker0`, `br-*`, `veth*` and `tailscale0` up each time |
| Three restarts of a Docker box | stopped and started through bb-box three times, with Docker in it running two containers: `boot=kept`, identity unchanged; its `eth0` had a new MAC address each time (`3e:22:aa:...`, `b2:f1:42:...`, `9a:8b:18:...`), which is why Docker boxes compare a value |
| A spare claimed and renamed, then restarted | spare fresh-acorn (`bx6shhmycajhqm`, `host_br4uth6acm`) claimed in 11 ms as renamed-spare: the same box ID, marker and host ID, its hostname and BB machine renamed; rebooted: `boot=kept`, `host_br4uth6acm` connected |

At the end the separate BB's sweep found no leftover guest; the snapshots,
boxes and Proxmox backends were removed and its box released; the lead
destroyed the clones and keeps the test templates to delete.

On production's templates, with the unit installed into a box by the
branch's `customize-base.sh` lines, and the marker written by hand as
bb-box would: a Proxmox LXC desktop box (check `@164ms +44ms`, then
`network-pre.target @209ms`, then the display, ssh and `user@1000`) and a
Tart Linux VM on arm64 (its card named at 59.125 s, the check from 59.406 to
59.629, networkd at 60.197, ssh at 60.295), each rebooted with `boot=kept`.
The LXC GPU and Wayland desktops, Android and boat were not checked.

**Tailscale, with a real node.** In the checks above tailscaled ran without
a login, so `tailscale0` and its state were there and its state was `{}`
(sha256 `44136fa3...`). Then, with the owner's approval, the lead minted one
auth key (single use, ephemeral, preauthorized, `tag:bb-box`, an hour) into
a file in neat-fern, a production Proxmox LXC box with the unit installed
from this branch; it joined the tailnet with it once, and the file was
deleted. The lead cloned it with `pct snapshot` and `pct clone`, as above.
The clone reset at its first boot, before networkd, ssh, `user@1000` and
tailscaled: its Tailscale state was the empty one and tailscaled said
`NeedsLogin`; host ID, credentials and access file gone; new machine ID and
SSH host key. The source kept its node, its state (`333f403e...`), its
host ID and machine ID, and stayed `Running` on the tailnet. It was then
logged out and released.

**A reset of one of bb-box's own boxes.** On production, a thread's Linux
box with the unit installed was given a marker naming another MAC address
and rebooted: it reset as a clone does, and within about 4 minutes bb-box
listed it "not enrolled ... until it is released". On a fresh separate BB
the same happened to one of its machines: the sweep found the machine
disconnected and ran BB's bootstrap again with its old key, which failed in
a box with no credentials, and the sweep's handling of that failure dropped
the box's enrolment; BB kept the old machine, disconnected. Had BB removed
the machine, bb-box would have released the box, as it does for one of
your machines whose machine is removed in BB. The lead's answer: a reset
must never cost a box. See [After the lead's answers](#after-the-leads-answers).

### Rollout

The reviews asked for a switch, so the rollout is staged, and each stage can
be undone on its own.

1. **Merge.** No box gets a marker: `general.identityResetBackends` is
   empty, so bb-box writes none, and an unarmed box never resets. bb-box
   checks for a reset only in a box it armed, so nothing else changes
   either. Docker boxes made from then on carry `BBBOX_IDENTITY`, unused
   until their backend is turned on. As for any change to
   `setup/proxmox-lxc/template` or `setup/docker`, Hetzner's host images,
   Namespace's Linux images and boat.dev's template are built again by
   bb-box at their next use (`boat/templates.ts` now names the program among
   the files its build reads); none of them turns the unit on.
2. **Rebuild the images.** Every Linux image gets the program. Only the
   builds that were checked turn the unit on (`BOX_IDENTITY_RESET=on`):
   Linux on Proxmox LXC (`build.sh linux`), Proxmox QEMU (`build-linux.sh
   linux`), Docker (`customize.sh linux`), and the refresh of those (057).
   The others have the program with the unit off and refuse a marker: the
   LXC desktops (GPU, CPU, Wayland), QEMU's desktop and Android, Docker's
   desktop images, Tart's Linux images and boat.dev's template. Each is
   turned on in its build only once checked as G14 says.
3. **Turn it on, one backend at a time**, after one new box of it is
   checked (`identity` in its timings; `sudo bb-box-identity status` says
   `enabled=yes`, `armed=yes`, and `boot=kept` after a reboot):
   `bb box option set general.identityResetBackends=proxmox-lxc`, then
   adding `proxmox-qemu`, then each Docker backend. microsandbox, Hetzner,
   Namespace and Tart offer no source yet, so naming them does nothing.
   Before Proxmox LXC or Proxmox QEMU goes in, boot its rebuilt Linux image
   unarmed, ideally before the first nightly rebuild after the merge, and
   run G14's checks again on it live: `systemd-analyze` for the order, now
   with `udevadm settle` on VMs and the requirements on Docker, containerd
   and the desktop; a plain clone that resets; three restarts with Docker
   containers and Tailscale; a spare claimed, renamed and restarted; a card
   added, booted, then the first removed; and a card that comes late. The
   G14 runs above were of version 1 of the program.
4. **A box made before** keeps working as it does: it has no marker, so it
   never resets, and its snapshots say "not fork-safe". bb-box arms a box
   only at its first ready, so turning a backend on arms no running box.
5. **Going back.** Take the backend out of `identityResetBackends`: new
   boxes get no marker. A box already armed keeps its check; unarm it
   through bb-box with `bb box run <box> 'sudo bb-box-identity unarm'`. Do
   not mask or disable `bb-box-identity.service` by hand: the network, SSH,
   Docker, the desktop and the box user's manager require it. A box whose
   reset failed has no network or SSH; reach it with `pct enter`, `qm
   terminal` or the console, and either fix what failed and reboot, which
   resumes the reset, or run `bb-box-identity disable` and reboot.
6. **Watch** `/var/lib/bb-box/identity-resets`, empty in every box that is
   not a copy, and the doctor's Identity resets section, empty unless one
   of bb-box's own boxes reset.

### After the lead's answers

**A reset never costs a box.** bb-box reads a box's
`/var/lib/bb-box/identity-resets`, and when a line there names the box's own
BB machine, it keeps the box and enrols it again as a new BB machine. It
does so wherever that machine's loss would show (`src/plugin/enrol.ts`):

- a reconnect, after bb-box starts a box and at each sweep for a box whose
  machine BB shows disconnected, which would otherwise run BB's bootstrap
  again with the old key;
- the sweep's handling of a machine BB no longer has, which would otherwise
  forget the box's enrolment;
- BB's removal of the machine, which would otherwise release one of your
  machines; and when bb-box cannot read the box's record then, as when it
  does not answer, it keeps the box too, says so in its log, and leaves
  removing it to the person;
- the enrolment of a box the sweep restored, whose machine BB still has.

It records the reset on the box, logs `identity-reset` in its box log,
removes the old machine from BB, so its credentials no longer work, enrols
the box as a new machine, counting the enrolment's time from then, writes
its own marker in the box again, and logs `enrolled-again`. A failed
enrolment is tried again at each sweep. The doctor has a section, Identity
resets, with a check for each such box: a warning once it is enrolled
again, naming both machines, and a failure until then. A box whose record
names another machine, as one copied from another box would, or none is
left as it was; a clone made outside bb-box is not in its records, so
bb-box never enrols it. The box log gains the two kinds in a migration of
its own, which keeps every event.

Tests, in `test/plugin.test.ts`: a thread's box whose own reset took its
machine, at a sweep: the old machine deleted, then a new one made and
bootstrapped, never a reconnect of the old one; the box log's two events
and their words; the doctor's warning; and no second action at the next
sweep. One of your machines whose machine BB removes after its reset: kept,
named as before, enrolled again, never released; and one that does not
answer: kept, not enrolled. A record naming another machine: the box's own
machine reconnects as after any reboot, nothing is deleted, and one of your
machines whose machine BB removes is still released (036). An enrolment
again that fails: tried again at the next sweep, the doctor failing with
why until it works, then warning.

**Live, on a fresh separate BB** (`npx bb-app` 0.48.1, no account, bb-box
from this branch, its Docker backend with images built from it), one of its
machines, keep-two (`host_3sa2732699`): its marker's value changed by hand
as root in the box, then the box restarted from outside bb-box, at
17:28:17. It reset at that start. The next sweep found it at 17:31:00 and
logged `identity-reset` ("Box keep-two reset its identity at 2026-10-30
17:28:18 UTC, as the value bb-box set on this guest is not the marker's.
BB's machine host_3sa2732699 went with it, so bb-box enrols the box again
as a new BB machine, and keeps it."); at 17:31:02 `enrolled-again` ("Box
keep-two joined BB again as machine host_xz43czk3qi, in place of
host_3sa2732699, 2 s after bb-box found its identity reset."). BB listed
only `host_xz43czk3qi`, connected; `bb box list` said "enrolled as a BB
machine in 1.9 s"; the box kept its name, record and owner, answered
commands with its access file, had the new host ID, and its marker named
the box again (`status`: `boot=reset marker=matches armed=yes
box=bx7xnqt7yhhemj`). The doctor:

```
Identity resets: Boxes of bb-box's whose identity reset at a boot, which bb-box keeps and enrols again as new BB machines.
  [warn] Identity reset of keep-two: Box keep-two reset its identity at 2026-10-30 17:28:18 UTC, as the value bb-box set on this guest is not the marker's, and BB's machine host_3sa2732699 went with it. bb-box kept the box and enrolled it again, at 2026-10-30 17:31:02 UTC, as BB machine host_xz43czk3qi.
        Fix: A box that is not a copy of another should never reset: see /var/lib/bb-box/identity-resets and journalctl -u bb-box-identity in the box.
```

An earlier run of the same check, before bb-box wrote the marker again and
timed the enrolment from the reset, behaved the same otherwise (keep-me,
`host_t3v95jev38` for `host_4g2ax4tru9`, 2 s).

The case that released a box before: another of its machines, keep-three
(`host_uwahzewcjm`), reset the same way at 21:57:34, and 4 s later its
machine was removed in BB (`bb host remove host_uwahzewcjm --yes`), before
any sweep. BB called bb-box's provider, which read the box's record: at
21:57:39 `identity-reset`, at 21:57:41 `enrolled-again` as
`host_j2s53vjk7e`, connected. The box was kept, with its name and owner,
and not released.

### After the reviews

Two reviews read units 2's first two commits: Astra (merge after fixes 1
to 7; do not roll out as it stands) and Opus (merge after 1 to 3, with a
switch before any image is rebuilt). Where they overlapped, the stricter
fix was made. A third commit answers them.

| Finding | From | Fix | Tests |
| --- | --- | --- | --- |
| A card added, removed, renamed or late reset a box that was not a copy, and a renamed or late card reset it at every boot; the wait followed the wall clock | Astra 1, Opus 1 | Kept when any of the marker's MAC addresses is on any card, whatever its name. Reset only once the cards are known (udev settled, or no udev, as in a container) and a new one of the backend's is there with none of the marker's. Otherwise it waits, counted in loops of 0.2 s, then boots as it is, resetting nothing, and logs that it could not tell (`boot=unknown`, not fork-safe). A reset with no card of the backend's to write a marker for unarms the box | `identity-reset.test.ts`: added, one of two removed, renamed (three boots), a VM's second card; a late card; no card: unknown, nothing erased; a copy whose card has no `eth` name unarms |
| A reset deleted host IDs before any record of them; a later failure, retried, recorded `none`; a receipt that could not be written still counted as done | Astra 2 | `identity-reset-pending`, with the original host IDs, written and synced before anything is removed; resumed at the next boot with those IDs; done only once the marker, the receipt and the pending file's removal succeed; a failure fails the boot | a failure after BB's credentials went, then the next boot: the original host ID in the receipt; a receipt that cannot be written fails the boot, and the next finishes it |
| `cat ... ; exit 0` turned an unreadable record into no reset, which released one of your machines | Astra 3 | The record is absent, read or unreadable; only a read record without the machine, or one absent, is no reset; unreadable is a check kept on the box | `plugin.test.ts`: a record that is not a readable file keeps the box |
| A failed delete of the old machine left the box `enrolling` with it; BB gave the old machine back for the box's key | Astra 4, Opus 3 | Recovery is resumable steps on the box's record: the reset found, the old machine removed and BB's removal confirmed (asked again at each sweep), then the enrolment, then done. A re-enrolment that BB answers with the old machine fails, and the next sweep removes it again. The fake BB now gives a new machine a new ID | a delete refused twice: off, never `enrolling`, the doctor failing, then a new machine, `host-<box>-2` |
| A box that did not answer when BB removed its machine was kept, and never looked at again; the host-deleted event forgot without checking | Astra 5, Opus 4 | The removed machine is kept on the box as a check, which the doctor warns of; at each sweep, once the box answers, bb-box reads its record: a reset of that machine enrols it again, none releases one of your machines (036). Enrolment is cleared only if the box still names that machine, compared in the same write. BB's host-deleted event takes the same path | one of your machines that does not answer: kept, warned of, then released once it answers with no reset |
| Docker's containers and the desktop started after a failed reset | Astra 6 | Docker, containerd, `docker.socket`, `bb-box-docker-containers`, and the desktop's display, session, VNC, Selkies and device firewall also require the unit | `enable` writes each requirement; live below |
| Root's set-aside BB folders and daemon units were left | Astra 7 | Cleared as the box user's are | a reset with root's set-aside `auth.json` and unit |
| A reset found on a thread's own machine (New box, 033) deleted it, which releases the box and its worktree | Opus 2 | Only machines bb-box's own enrolment made are removed and enrolled again. For a thread's machine bb-box records the reset and the doctor fails it, naming the thread and how to recover its work | a New box machine: no delete, no create, no bootstrap, the doctor failing with the thread |
| The rollout could not be staged | Opus 5 | `general.identityResetBackends`, empty by default: bb-box writes markers only on the backends named, and checks for a reset only in boxes it armed (`identityMarkedAt` on the box). Images turn the unit on only where checked. `bb-box-identity unarm` | engine tests: markers off for a backend, and an image with the reset off; a box never armed is released as before |
| Copies that keep their MAC addresses | Opus 6 | Noted for units 8 and 9 below | |
| What a reset leaves | Opus 7 | Listed below | |
| The snapshot's words claimed a reason | Opus 8 | "not fork-safe: amber-fox had no working identity reset when it was taken" | engine and plugin tests |
| G14's unchecked templates | Astra, lead | Program installed, unit off, and no source in bb-box, until each is checked (Rollout, step 2) | build scripts' settings tested |

**Live, the gates.** systemd booting in a Docker container on a test box,
with the branch's program turned on and stand-in units named `docker`,
`containerd` and `bb-box-display` beside the real `ssh` and
`systemd-networkd`. Three restarts: `boot=kept`, every service up, the host
ID kept. A copy (the marker given another MAC address) with `ssh-keygen`
made to fail: `boot=failed`, the unit failed, and the journal said
"Dependency failed for" `docker.service`, `containerd.service`,
`bb-box-display.service`, `ssh.service`, `ssh.socket` and
`systemd-networkd.service`, all inactive; the pending record held
`host_systemd_source`. With `ssh-keygen` back, the next boot resumed it:
`boot=reset`, every service up, new host keys, the receipt naming
`host_systemd_source`, no pending record; the boot after: `kept`. The first
run of this check found that a resumed reset made no host keys when the
failed attempt had removed them; it now makes ed25519 and ECDSA keys then.

**Live, the recovery, on a fresh separate BB** (`npx bb-app` 0.48.1, no
account, bb-box from this commit, its Docker backend with images built from
it):

- With `general.identityResetBackends` empty, a new machine, before-switch,
  got no marker (no `identity` in its timings; `status`: `armed=no`). Set to
  its Docker backend, the next, keep-four, got one in 70 ms.
- keep-four (`host_429bg4tra4`): its marker's value changed by hand as root,
  then the box restarted from outside bb-box at 22:40:00, when it reset. At
  22:42:21 the sweep logged `identity-reset`, removed the old machine and
  waited for BB to confirm it, and at 22:42:23 `enrolled-again`: "joined BB
  again as machine host_r2jb8bi8ra, in place of host_429bg4tra4, 2 s after
  bb-box found its identity reset". BB listed only `host_r2jb8bi8ra`,
  connected; `bb box list` said "enrolled as a BB machine in 1.7 s"; its
  marker named the box again (`boot=reset marker=matches armed=yes
  box=bxvuyjp5nw2x6r`); the doctor warned, naming both machines.
- quiet-one, armed, stopped, then its machine `host_36s3i2wtye` removed in
  BB: kept, stopped, and the doctor warned "BB no longer has machine
  host_36s3i2wtye of box quiet-one ... and bb-box could not read whether the
  box's identity reset (Box quiet-one is stopped. Start it first.), so it
  keeps the box." Started, the next sweep read no reset in it and released
  it, as 036 does, at 22:45:31.

**For units 8 and 9.** These copies keep their MAC addresses, so they would
not reset: `pct restore` without `--unique`, a disk copied into a new VM, a
`docker commit` with its environment, and a `tart clone` that keeps the
source's MAC address. Every copy bb-box makes must have new MAC addresses
(`--unique`, `tart set --random-mac`), and G14's unit 7 and unit 9 checks
should test that.

**What a reset leaves, as section 9 accepts:** every folder under
`~/.bb-machines/<server>/` but `logs` (`plugins/*/host-data`, providers'
`bridge-data`, `runtime`, `thread-storage`), `/var/lib/bb-box/vnc-password`,
the hostname, bb-box's authorized key, and the box user's own SSH keys and
cloud credentials. No plugin's host data was checked for a credential of
the machine itself. The unit does not require ifupdown's
`networking.service`: bb-box's images use systemd-networkd. The journald
restart was checked on Proxmox LXC and on a production QEMU box, not on
Tart.

### After the re-reviews

Opus said merge, with one low finding and a condition before step 3 of the
rollout. Astra said not yet, with three P1s it reproduced. The lead asked
for all of them, each with a regression test.

| Finding | From | Fix | Tests |
| --- | --- | --- | --- |
| A stale "absent" read of a box's record could release it after another check had recorded its reset meanwhile: the conditional update did nothing, but the release went on | Astra 1 | A box's identity decisions run one at a time in the enrolment. Before a read bb-box notes the box's reset and enrolment state; the release happens only when one update finds that state unchanged, no recovery pending and the machine still named, and only then | `plugin.test.ts`: a read held while another path records the reset, then answering "absent": not released, then enrolled again |
| A card added and booted never became an anchor, so removing the first card later reset a working box | Astra 2 | After a boot that matched, the box's current cards of the backend's are added to the marker | `identity-reset.test.ts`: LXC and a VM, a card added, booted, the first removed: kept; a copy of such a box still resets |
| An unknown boot let a copy start BB's daemon, Tailscale and SSH with its source's identity, and nothing looked again | Astra 3 | Unknown removes nothing and lets the boot go on, but SSH and Tailscale wait for the settle unit, and BB's daemon for `wait`; `settle` looks every 2 s and resets or keeps once the cards are there; `wait` keeps a removed machine's daemon from ever starting | a copy whose card comes after the wait: held, then reset, its daemon refused; the box's own card late: kept, its daemon started; no card: nothing removed, SSH and the daemon still waiting; `wait`'s rules |
| BB's removal of a machine after its box's reset waited up to 2 minutes for the recovery it started | Opus a | That path records the reset and starts the recovery without waiting | `plugin.test.ts`: BB holds the machine removing until `remove` returns; it returns at once, and the box is enrolled again once BB is done |
| A real copy can boot as its source when udev never settles | Opus b | Now held by `settle` rather than let through; for unit 7, `boot=unknown` is not a reset | |
| G14 ran on version 1 | Opus c | The rollout's step 3 now asks for G14 again on rebuilt LXC and QEMU images before either backend goes into `identityResetBackends` | |

Two faults found while testing are fixed: `wait` read its records through a
pipe that `pipefail` failed when the pending record was absent, and took a
host ID only up to its first underscore; and two other pipes that could
fail the same way are now plain loops.

**Live, in a systemd container** on a test box, with the branch's program
turned on, stand-ins named `docker` and `bb-box-display`, and a lingering
box user with a stand-in BB daemon unit (`bb-host-daemon-...-host_systemd_source`):
a normal boot and a restart with the marker written: `kept`, every service
and the daemon up. Then the box was stopped, disconnected from its network
and started with no card: after the 30 s wait, `boot=unknown`, the host ID
and credentials still there, `systemd-networkd`, the Docker and desktop
stand-ins, `systemd-user-sessions` and `user@1000` active, a shell working,
`ssh` inactive with its start job waiting, the settle unit running, and the
daemon waiting in its start step. Then a network was connected, giving the
box a new card as a copy gets: `settle` reset it ("none of the marker's MAC
addresses (02:42:ac:11:00:aa) is on this box's interfaces
(c2:3d:fa:9e:3b:28)"), SSH started, and the daemon failed its start step:
"BB machine host_systemd_source went with this box's identity reset, so its
daemon does not start". `multi-user.target` waits while SSH does, as it
wants SSH; logins do not.

### Choices and deviations

- **"Missing on a box that had one"** is the armed record. 070 resets when
  the marker is missing; with that alone, a new image's first boot, before
  bb-box writes the marker, and every boot of a box made before markers,
  would reset.
- **Docker** compares a value bb-box sets in the environment at create, the
  box's ID; microsandbox, Hetzner and Namespace boxes get it too, but bb-box
  arms none of them until each is checked. Docker gives a container a new
  MAC address at each start (3 of 3 measured), so a MAC address would reset
  a Docker box at every restart. There the check runs before anything in the
  box starts, not before its network, which Docker makes first. A
  `docker commit` made by hand keeps the variable in its image's settings,
  so a container run from it by hand would not reset; unit 12's commits
  must clear it (`--change "ENV BBBOX_IDENTITY="`).
- **boat.dev, Tart** write no marker in this unit. boat: whether its stop and start keep
  a MAC address is not measured (its files are another worker's, and its
  boxes are paid). Unit 11 settles its source.
- **After a reset** the unit writes the copy's own marker, with no box, so
  it does not reset again at its next boot. bb-box writes the box's own
  marker again only after it enrols one of its own boxes again; a fork's
  first contact is unit 7's.
- **bb-box's authorized key** stays: it is the template's, and a fork's own
  key is unit 7's.
- **The machine ID**: the reset writes a new one after systemd started, so
  systemd itself keeps the copied one until the next boot; journald is
  restarted so the rest of the boot is logged under the new one. Its first
  line, saying why, goes to the old one's journal; the summary line after it
  says why too.

## Unit 4: Settings' Snapshots page

Built on 30 October 2026, on main `7bd9f833` (units 0, 1a and 1b
included), and rebased onto `7652147b`. The lead's answers to this unit's questions are in 070's
[Decided during unit 4](070-snapshots.md#decided-during-unit-4).

### What changed

- **The settings**, under `general.snapshots` in the configuration
  document, read and checked by 067's engine: `perBox` (1 to 50, 5),
  `roomPercent` (50 to 90, 85), `keepDays` (1 to 365, 30), `agentsRestore`
  and `agentsMemory` (on), `pictures` (on), and `ceilings`, a ceiling a
  month for each backend ID (0 to 1,000, in whole cents, 5 unless set).
  `src/core/document.ts`; the configuration reference is regenerated.
- **What bites now, and what waits.** Snapshots per box, the room and the
  ceilings are used, shown and found. Keep's length (unit 8), the agents'
  two switches (unit 5) and pictures (unit 6) are in the schema and in
  `snapshotConfig`, tested, and say "Not used yet" in the reference; they
  are not on the page or in Find. Each comes onto the page with its unit.
- **The constants units 1a and 1b used are gone where a setting replaces
  them.** The take counts against `perBox`. The room refuses a take past
  `roomPercent`, a thin pool's metadata 5 points below it, and the sweep
  deletes 7 points above it (`roomThresholds`), so the defaults are as
  before: 85, 80 and 92. The housekeeping times stay fixed: 24 hours for a
  failed record, 7 days for a lost or found one, 10 minutes before a
  missing one is lost. `bb box status`, `box_status`, `bb box snapshot take`
  and `list` say "of N" with the setting.
- **The ceiling.** One rule, `ceilingVerdict` in
  `src/core/snapshot-cost.ts`, admits a take, an undo, a Keep, a renewal
  and a held copy. A take, an undo and a held copy are refused when the
  rate after them would be past the ceiling; a Keep and a renewal add no
  snapshot, so they are refused while the rate is past it. The rate is
  every paid snapshot the provider holds, being taken included, times its
  daily price, times 30; cents are compared, so the words never say "$5.00
  past $5.00". A price bb-box does not know is admitted for the person and
  refused for an agent. Unit 4 wires the take, in the same transaction as
  the limit and the room, so takes at once cannot pass it together. The
  refusal: "It would bring snapshots held on boat.dev to about $5.04 a
  month, past your ceiling of $5.00. Delete one, or raise the ceiling in
  Settings, Snapshots, Paid snapshots." Nothing deletes to get under it.
- **This month's spend.** `snapshots.db` gains `snapshot_charges`: a
  charge starts when a priced snapshot is ready, from the moment it holds,
  and ends when it is lost or its record goes, so a deleted snapshot's
  days still count. The month is the calendar month in UTC. Ended charges
  go after 400 days. `src/plugin/snapshot-store.ts`.
- **The page**, Options, Snapshots, between Images and Devices, through
  067's drafts and Save: "Each box" (Snapshots per box; Refuse new
  snapshots when a host's storage is past, whose words follow the typed
  value: "or past 80% of a thin pool's metadata. Past 92%, ..."), "Paid
  snapshots" (a row per backend that charges, with its price, the rate
  held and this month's spend, and in amber words when the rate is past
  the ceiling; otherwise "None of your backends charges for snapshots"),
  and "What each backend offers" (a row per backend, opening its page:
  what its kinds' snapshots hold and cost, and its doctor's last
  Snapshots check, with the fix in amber). No switches. The overview's row
  reads "5 per box · none taken past 85% full", with "paid up to $5.00 a
  month", or "past a paid ceiling" in amber.
- **Find** finds Snapshots per box, the room, each backend's ceiling (or
  "Paid snapshots" when none charges) and What each backend offers.
- **Import** and the receipts name each snapshot setting; a refused value
  lands on its field (`general.snapshots.ceilings.<id>` on that backend's
  ceiling).
- **The CLI**: `bb box option set general.snapshots.perBox=<n>` and
  `general.snapshots.roomPercent=<n>`. Ceilings are set on the page or in
  the configuration file.
- **For live checks only**, with `BB_BOX_LIVE_CHECKS=1`: `bb box snapshot
  fake-price <backend> <dollars a day | off>` gives snapshots taken from
  then on a made-up price, until bb-box restarts, so the ceiling can be
  checked where no backend charges.
- **Docs**: the guide's [Snapshots](../guide/snapshots.md) page has a
  Settings section.

### Tests

On a Linux box, on main `7652147b`: `npx tsc` passes; the node suite ran
3,010 tests, 2,721 passed, 1 failed, 288 skipped; vitest ran 383, all
passed; `node scripts/reference.ts --check` passes. The one failure, the
iOS driver restarting a fake `idb_companion`, is in a file this unit does
not touch, and passed 3 times in 3 when its file ran alone. An earlier full
run had one other such failure, a project's variables in an enrolled box
(`boxes.test.ts`), which also passed 3 times in 3 alone.

- `test/snapshot-cost.test.ts`, 5: the ceiling for each of the five
  changes, at and past it, free and unknown prices, per-GB prices, the
  rate held (taking counted; failed, lost and free not), this month's
  spend across a month's start, and the settings' defaults, thresholds and
  checks.
- `test/snapshots.test.ts`, 4 new: a lower and a higher limit, kept ones
  counted; the room at 60% refusing at 61%, metadata at 56% of 55%, and the
  sweep keeping at 66% and deleting the agent's unkept snapshot at 68%; G10
  on a fake price (below); an unknown price.
- `test/config-cli.test.ts`, 1 new: the two options, their range, unset.
- `test/app.test.tsx`, 3 new: the page's fields, words and Save, sending
  `{ perBox: 3, roomPercent: 60, ceilings: { fake: 7.5 } }`; no switches and
  none of the waiting settings; the empty Paid snapshots, the amber words
  past the ceiling and the overview's three values; Find and problem paths.

### G10 ceiling-rate

Passed for the take, on a fake priced backend in the tests and a made-up
price live: a ceiling lowered below the rate refuses the next take and
warns on the page and the overview, a sweep deletes nothing, and deleting
keeps the month's spend. The undo (unit 3), Keep, renewal, held copy and
bulk Keep (unit 8) do not exist yet: their admission is the same rule,
tested for each in `snapshot-cost.test.ts`, and their units prove it live.

### On a separate BB

A fresh `npx bb-app` (latest) with no account, its own data folder and
ports, started with `env -i`, `HOME`, `PATH` and `BB_BOX_LIVE_CHECKS=1`
only, in a Proxmox LXC box. bb-box installed from this branch with `bb
plugin install path:`. First start: "Opened snapshots.db, attached to
bb-box's database: ran 8 migrations." The lead gave it a Proxmox LXC
backend with its own VMIDs and addresses and a Linux template on LVM-thin.
Each setting was changed on the page in headless Chromium, with Save; the
takes are `bb box snapshot` on a machine of the person's. The node's name
is written pve-1 below.

| Check | Result |
| --- | --- |
| Snapshots per box set to 2 on the page | stored `{"perBox":2}`; two takes ready in 0.4 and 0.3 s; the third refused: "Box snapcheck holds 2 snapshots, and your settings allow 2 a box. Delete one first: "one", "two"." |
| Room set to 50% | "pve-1's storage local-lvm is 54% full, and your settings take no snapshot past 50%: a full thin pool stops every box there. Delete snapshots or release boxes on it first, or raise the limit in Settings, Snapshots." |
| Room back to 85% | stored nothing (the default); the same take ready, "3 of 5" |
| A made-up price of $0.056 a day, the ceiling at its default | two paid takes ready; the third refused: "It would bring snapshots held on Proxmox LXC on pve-1 to about $5.04 a month, past your ceiling of $5.00. ..." The page: "$0.056 a day for each snapshot. Held now: 2 snapshots, about $3.36 a month." |
| Ceiling lowered to 3 on the page | the row adds, in amber, "The rate held is past this ceiling: bb-box refuses new paid snapshots, undos, Keep and renewals there until you raise it or delete some. It deletes none by itself."; the overview's row is amber; the next take refused at "$5.04 a month, past your ceiling of $3.00"; after `bb box sweep` both snapshots are still listed |
| Find | "snapshot limit": Snapshots per box first; "storage full": the room; "snapshot ceiling": "Paid snapshots on Proxmox LXC (...)", "$3.00 a month" |
| The month's spend, at a made-up $30 a day, ceiling 1,000 | the charge ran 182.0 s from the snapshot's capture to its delete; after the delete the page said "Held now: 0 snapshots ... Spent this month so far, deleted ones included: $0.06" |
| Clean-up | every snapshot deleted, the machines removed, the price and settings back to their defaults |

Screenshots at 1,440, 760 and 390 px, light and dark, of the page with a
ceiling passed and with one held within it, the overview, a draft and
Find, are in the unit's thread storage, not in the repository: they show
the test node's name.

### Known limits

- **The spend on an open page** is as of the page's last read of the
  settings. Any change refreshes it; a page left open while a paid
  snapshot is held shows the spend of when it last read. A reload reads it
  afresh.
- **What each backend offers** is one row per backend, with each storage
  in the doctor's words, not one row per backend and storage from a plan
  as 070's table says: a plan needs a guest, and the doctor reads the
  templates' storage without one.
- **No backend charges yet**, so the ceiling bites only on the made-up
  price until unit 11.
