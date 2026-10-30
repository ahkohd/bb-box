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
