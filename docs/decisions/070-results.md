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
   G14 runs above were of version 1 of the program. Step 3 ran on 31
   October: see "Rollout step 3" below; both templates need version 5.
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

### Rollout step 3, on the rebuilt templates

On 31 October 2026 the lead rebuilt production's templates from main with
version 2 of the program: Proxmox LXC 9800 (`build.20261031-015802-ee19`)
and Proxmox QEMU 9806 (`build.20261031-015944-13b3`). A separate BB (a
fresh `npx bb-app` 0.48.1 with no account, bb-box from main `b8088de6`) had
a backend on each, with their own VMIDs and addresses. Each template's
program was main's file, byte for byte, with both units enabled and 16
drop-ins.

| Check | Proxmox LXC | Proxmox QEMU |
| --- | --- | --- |
| Unarmed: boot and order | pass: `boot=unarmed`; the check `@159ms +17ms`, then `network-pre.target @177ms`, networkd, ssh and `user@1000` | pass: the check after udev's coldplug, `@505ms +25ms`, then `network-pre.target @627ms`, networkd, ssh and `user@1000` |
| Unarmed: requirements | pass: networkd, ssh, `ssh.socket`, `user@1000`, Docker, `docker.socket`, containerd and `bb-box-docker-containers` each require the check and start after it; ssh the settle unit too | pass, the same |
| Unarmed: three restarts with Docker and tailscaled (no login) | pass: `unarmed`, nothing changed | pass |
| Unarmed: a take | pass: "not fork-safe: lxc-u had no working identity reset when it was taken" | |
| Naming both backends arms no running box | pass: the unarmed box restarted `unarmed` | |
| Armed: the marker at first ready | pass: `identity 41 ms`, `source eth` | pass: `identity 44 ms`, `source device` |
| Armed: the order | pass: `kept` in 36 ms, before `network-pre`, networkd, ssh, `user@1000`, containerd, tailscaled and Docker; settle before ssh and tailscaled | pass: after udev's coldplug, 84 ms with `udevadm settle`, then the same order |
| Armed: three restarts with Docker and a tailnet node logged in with a single-use ephemeral key | pass: `kept` each time; host ID, credentials, machine ID, SSH key, Tailscale state and node key, access file unchanged; Tailscale `Running` | pass |
| Armed: a stop and start through bb-box | pass, the same | no boot: bb-box's stop suspends a VM to disk, so its start resumes the same boot and no check runs |
| A take | pass: `forkSafe: 2` | pass: `forkSafe: 2` |
| A plain clone, by the lead, `link_down=1` | pass: reset at its first start, before networkd, ssh, `user@1000` and tailscaled; host ID, credentials, daemon unit and access file gone; new machine ID and SSH key; Tailscale state `{}`; threads' folder and containers kept; after a reboot `kept`, one reset | pass, the same |
| The source after its clone | pass: unchanged, BB machine connected, Tailscale `Running` | pass |
| A spare claimed, renamed and restarted | pass: claimed in 12 ms with the same box ID, marker and host ID; its access file rewritten for its owner; after a restart `kept`, its renamed BB machine connected | not run: one VMID |
| A card added and booted, then the first removed, then put back | pass: the marker gained `eth1`'s MAC; `kept` with only `eth1`; `kept` with `eth0` back | pass, with `qm reboot`, a cold start each time |
| A late card: started with no card, then its own card put back | **fail**: a false reset | pass: `boot=unknown` at 55 s, the host ID kept, ssh and tailscaled waiting; once the card was back, `kept`, ssh, tailscaled and BB's daemon started |

**The failure.** With no card, the LXC box's check waited 30 s and ended
`unknown`, as it should. Its network and Docker then started, and Docker made
`docker0`, a bridge and two `veth` interfaces. The settle unit counted every
Ethernet-type interface as a card of the backend's for an `eth` marker, so it
took those four as new cards with none of the marker's, and reset the box:
"none of the marker's MAC addresses (bc:24:11:87:90:2f bc:24:11:af:12:b9) is
on this box's interfaces (52:dd:31:2b:7a:db 62:01:bc:70:20:83
da:35:57:32:58:35 fe:63:50:f4:f1:cd)". On a VM only cards with a device
count, so Docker's interfaces never did. The unit tests' no-card settle, and
the systemd container's, never added Docker's interfaces.

**What bb-box did.** As built: it logged `identity-reset`, removed
`host_eai95mipb8` from BB, waited for BB to confirm, and enrolled the box
again as `host_dvmjmz6nbv` 2 s after it found the reset (`enrolled-again`).
It wrote the box's marker again, so the box is armed, and the doctor names it
under Identity resets. It kept the box. The reset cost its tailnet node.

**The fix, version 3.** A new card shows a copy only if it is a card of the
marker's own source: one named `eth` and a number on LXC, one with a device on
a VM. This holds at boot, in settle and in `status`. A copy whose card was
renamed, which version 2 reset and unarmed, is now held as unknown, with
nothing removed. The version goes to 3, so a take's `forkSafe` says whether
its box had the fix.

**Tests.** `identity-reset.test.ts`: on LXC and on a VM, a box with no card
past the wait is held while Docker's and Tailscale's interfaces appear, both
at boot and in settle; nothing is removed, SSH and BB's daemon still wait,
`status` says `incomplete`, and it is kept once its card is back. A copy whose
card has no `eth` name is held; one whose marker is gone and has no `eth` card
still resets and unarms. Both fail on version 2, the first with the live
message.

**Live again, with version 3** installed by hand in the same two boxes
(sha256 `621241f5...`), both restarted `kept`, and a new take of the LXC box
(`forkSafe: 3`):

| Check | Proxmox LXC | Proxmox QEMU |
| --- | --- | --- |
| A plain clone, by the lead | pass: reset at its first start, `host_dvmjmz6nbv` removed, before networkd, ssh, `user@1000` and tailscaled | |
| A copy whose new card comes late: a clone started with no card, given a new one after 45 s | pass: at 45 s `boot=unknown`, the host ID still there, Docker up with its bridge and veths, ssh and tailscaled waiting, BB's daemon waiting; once the card came, `settle` reset it and refused the copied machine's daemon; after a reboot `kept` | |
| A late card on the box itself | pass: `boot=unknown` at 45 s with Docker up, ssh and tailscaled waiting, the host ID unchanged; once its own card was back, `kept`, then ssh, tailscaled and BB's daemon started | pass: the same at 55 s |

The templates still hold version 2, so neither backend goes into
`identityResetBackends` until 9800 and 9806 are rebuilt with the fix, and
`bb-box-identity version` in a new box says so: version 5, below.

Afterwards the snapshots, boxes and both backends were removed from the
separate BB, its box released, and the lead destroyed the clones. One
spare was released before it was claimed, by setting the spares to 0
first; the claim was done again in the right order.

### After the version 3 re-review

Astra found that on LXC a name was not enough. A bridge, bond, TAP, dummy,
veth, macvlan, ipvlan or VLAN that the box made and named `eth9` still
counted as a new card, so with the card missing it reset the box, at boot
and in `settle`. A software interface with a fixed MAC also became an
anchor, so a copy that made it again, its card late, was kept. The lead set
the rule for version 4.

**What a card is, version 4.** On LXC, a card is an Ethernet interface
the backend gave the box:

- it is not a bridge, bond, TUN or TAP, nor stacked on another interface:
  it has no `bridge`, `bonding`, `tun_flags` or `lower_*` entry
- its `iflink` is not its own index, so it is linked to another interface
- that interface is not inside the box: no interface in the box has
  `iflink`'s index and links back to it

On a VM a card has a device, as before. Matching the marker looks at
cards, whatever their names, so a renamed card still keeps its box. The
marker, its anchors and evidence of a copy need the `eth` name too, on LXC.
Anchors grow only at boot, before the box's own software makes its
interfaces again, not in `settle`.

The back link is checked both ways because LXC moves the card into the
box, where it gets a low index: `ifindex 2`, `iflink 2761` on a production
box. The box's own docker0 or a veth can then take the host peer's index by
chance, and Docker's veths had `iflink 2` there, the index of their peers in
the containers. A one-way check, "no interface inside has that index",
would make the card the box's own whenever that happened.

**Tests.** `identity-reset.test.ts`:

- each of a bridge, bond, TAP, a veth whose peer is inside, a dummy, and a
  macvlan, ipvlan or VLAN on an inside link, named `eth9`, with the card
  missing, leaves the box held at boot and in `settle`, nothing removed and
  the marker `incomplete`, on LXC and on a VM, until its card is back
- a bridge with a fixed MAC never becomes an anchor; a copy whose marker
  holds such a MAC, as version 3 could grow it, is held when the bridge is
  made again, its daemon waiting, and resets once its own new card comes
- anchors do not grow in `settle`; the next boot adds the card
- a card whose host peer's index an interface of the box later takes is
  still the box's card, and a pair the box made, each linking to the other,
  is not

The first three fail on version 3. On a QEMU box, a probe with real kernel
interfaces in network namespaces, the card made as LXC makes it, in its
host's namespace and moved into the box's:

| Case | Version 3 | Version 4 |
| --- | --- | --- |
| Card missing; the box made a bridge, bond, veth with its peer inside, dummy, TAP, macvlan, ipvlan or VLAN named `eth9` | reset, all 8 | held, nothing removed |
| Card missing; docker0, a veth to a namespace of its own, `tap0`, or a TUN or WireGuard named `eth9` | held | held |
| A copy: the card with a new MAC, alone or with docker0 | reset | reset |
| The box itself: its card with docker0 and a veth, docker0 at the host peer's index | | kept, marker matches |
| The box itself, its card renamed `lan0` | kept | kept |
| The box itself with a fixed-MAC bridge `eth9` and a second card `eth1` | kept, both grown | kept; the marker gained `eth1` only |
| A copy, card missing, its marker holding the bridge's MAC, the bridge made again | kept, its daemon started | held, its daemon waiting |

**Known limit.** A veth that the box makes, names `eth` and a number, and
whose peer it moves into a namespace of its own still counts as a card.
Container runtimes name that end `veth...`, not `eth...`.

**Live, by hand**, on two production boxes with version 4 installed and
armed by hand, each running Docker containers and tailscaled; the lead ran
the node steps. While each box waited with no card, a bridge named `eth9`
with a fixed MAC and a TAP named `eth8` were made in it.

| Check | Proxmox LXC | Proxmox QEMU |
| --- | --- | --- |
| A plain clone | pass: reset at its first start, the host ID removed | pass |
| A copy whose card comes late | pass: `boot=unknown`, the host ID kept; still `unknown` with `eth9` and `eth8`; reset once its new card came, its copied daemon refused; `kept` after a reboot, its marker holding the new `eth0` only | |
| The box itself, its card late | pass: `unknown`, still `unknown` with `eth9` and `eth8`, the host ID kept; `kept` with the same host ID once its own card was back | pass, the same |

The lead deleted the snapshots and destroyed the clones. Neither backend
goes into `identityResetBackends` until 9800 and 9806 are rebuilt with
version 5, below.

### After the version 4 re-review

Astra found two more. GRE TAP, IPv6 GRE TAP and ERSPAN interfaces named
`eth9` passed version 4's tests: they are Ethernet, with another index as
their link and none of the excluded entries, so with the card missing they
reset the box. And indices belong to namespaces: a card with index 20 and its
peer at 100 outside, beside a veth of the box's with index 100 and its peer
at 20 in a namespace of its own, looked like a pair inside the box. That hid
the card; a second card then reset the box.

The lead stopped chasing kinds one by one, and set the rule for version 5.

**What a card is, version 5.** On LXC, a card is what the kernel's own link
information, `ip -d -j link`, says is one:

- `link_type` `ether` and `info_kind` `veth`
- a `link_netnsid`: its peer is in another namespace
- no `master`: it is on no bridge or bond
- named `eth` and a number

Nothing else is a card or an anchor, whatever its name. The index arithmetic
of version 4 is gone; the collision needs none of it, as the two veths have
different `link_netnsid` values and the box's has another name. On a VM a
card still has a device. Anchors still grow only at boot.

On a production LXC box, `eth0` is `veth` with `link_netnsid` 0 and no
master; Docker's veth there has a master and `link_netnsid` 1.

Two consequences, plainly:

- **A card renamed from `eth`** on LXC, such as with `pct set --net0
  name=lan0,...`, is no card, so the box is held as unknown, removing
  nothing, until it has its name again. bb-box always names its cards `eth0`.
- **The remaining limit.** A veth that the box makes, names `eth` and a
  number, keeps off any bridge, and whose peer it moves into another
  namespace is a card by this rule. With the box's own card missing, it
  resets the box. Unit 2's recovery then keeps the box and enrols it again as
  a new BB machine, so the cost is the box's BB machine, tailnet node and
  access file, not the box.

**Tests.** The test guest now gives the program a fake `ip` that prints the
links it is given. `identity-reset.test.ts`:

- with the card missing, each of a bridge, bond, TAP, a veth whose peer is
  inside, a veth on a bridge as Docker's are, a dummy, a macvlan, an ipvlan, a
  VLAN, a GRE TAP, an IPv6 GRE TAP, an ERSPAN, a VXLAN and a Geneve, named
  `eth9`, leaves the box held at boot and in `settle`, on LXC and on a VM
- the reviewer's collision: the marker still matches, the box is kept at
  boot and in `settle`, and a second card is grown at the next boot, never a
  reset
- a card renamed `lan0` holds the box at three boots, removing nothing

The fixture changed shape, so version 4 cannot run these tests; the probe
compares the two versions instead.

**Probe**, with real kernel interfaces in network namespaces on a QEMU box,
the card made as LXC makes it:

| Case | Version 4 | Version 5 |
| --- | --- | --- |
| Card missing; a GRE TAP, IPv6 GRE TAP or ERSPAN named `eth9` | reset | held |
| Card missing; a veth on a bridge named `eth9`, its peer in a namespace of the box's | reset | held |
| Card missing; a bridge, bond, inside veth, dummy, TAP, TUN, WireGuard, macvlan, ipvlan, VLAN, VXLAN or Geneve named `eth9`, or docker0, `tap0` and a Docker-like veth | held | held |
| The reviewer's collision, then a second card | reset | kept; the second card grown at the next boot |
| A copy: the card with a new MAC, alone or with docker0 | reset | reset |
| The box itself, with docker0 and a Docker-like veth | kept | kept |
| The box itself, its card renamed `lan0` | kept | held |
| A copy, card missing, a bridge with the MAC its marker holds made again | held | held |
| The limit: card missing, a veth named `eth9` with its peer in a namespace of the box's | reset | reset |

**Live, by hand**, on a production LXC box with version 5 installed and armed
by hand, running Docker containers and tailscaled; the lead ran the node
steps. While the box, or its copy, waited with no card, a bridge with a fixed
MAC, a TAP, a GRE TAP, an ERSPAN and a veth pair inside the box were made in
it, named `eth5` to `eth9`.

| Check | Result |
| --- | --- |
| A plain clone | pass: reset at its first start, the host ID removed |
| A copy whose card comes late | pass: `boot=unknown`, the host ID kept; still `unknown` with the five interfaces; reset once its new card came, its copied daemon refused; `kept` after a reboot |
| The box itself, its card late | pass: `unknown` through the five interfaces, the host ID kept; `kept` with the same host ID once its own card was back |

The lead deleted the snapshot and destroyed the clones.

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

## Unit 3: restore on Proxmox

Built on 31 October 2026 on main `be8cfc47` (units 0, 1a, 1b, 2 and 4
included), and rebased onto `b8088de6`. The lead's answers are in 070's
[Decided during unit 3](070-snapshots.md#decided-during-unit-3).

### What changed

- **The plan by storage.** `planSnapshots` with a target now says how
  Proxmox restores it, read live: `rollback` on storage that rolls back to
  any snapshot (LVM-thin, Ceph RBD, BTRFS, qcow2 files), `rollback-newest-only`
  on ZFS, and `none` with why (storage without snapshots, the token without
  `VM.Snapshot.Rollback`, a stopped Proxmox QEMU box kept suspended to disk,
  a target the guest does not have or has part-made). It also says how many
  snapshots on the guest are newer than the target, the undo it would take
  (a snapshot, or a held copy) with its time and space, and the size the
  box goes back to, read from the snapshot's own config. Every disk's
  storage counts. `src/backends/proxmox/snapshotting.ts`.
- **The restore**, `Snapshots.restore` in `src/core/snapshots.ts`, on the
  box's queue with its start, stop, resize and release. Each step is
  recorded on the operation before it runs, and the provider's task as soon
  as it begins:
  1. It refuses what the plan refuses, with the plan's words: a lock (with
     the host's command), ZFS (off), a target that is not ready, is on an
     earlier guest ("only forked") or is another box's, a box that is not
     running or stopped, and a box whose last restore bb-box could not
     confirm.
  2. The guard (below).
  3. In one transaction on `snapshots.db`: the undo's record (`taking`) and
     the operation (`running`), which pin the target and the undo, with
     the undo's space and price reserved. The undo is refused there, before
     anything stops, by the room rule or the ceiling (`ceilingVerdict`,
     change `undo`), each with its own fix; the person may restore without
     it (`--no-undo`), an agent never. `restore-asked` is logged.
  4. A hard stop (`powerOff`, which a QEMU box needs: its `stop` hibernates).
  5. The undo of the stopped box, "before the restore at 01:56": a
     snapshot, or in ZFS's order a held copy. If it fails, the box starts
     again as it was, and the restore says nothing on its disk changed.
  6. The rollback (`rollbackSnapshot`), which refuses a running guest. If
     Proxmox refuses it, the box starts again as it was; if its task fails
     part way, the box stays stopped, and the answer names the undo.
  7. The start, during which, once the box answers and before the backend
     runs any command of its own, the access file is written and checked
     by its SHA-256; then the size read back from the guest, the labels
     again (`relabel`), and BB's machine started again as a start does
     (commands wait for it; the restore does not). The guard is read again
     before the stop and before the rollback.
  8. `restored`, with the time of each part: "in 4.4 s (stop 1.1 s, undo
     0.3 s, rollback 0.4 s, start 2.3 s, access 0.2 s)". Then undos past 2
     a box are replaced, oldest first, never the restore's own target, a
     kept one or a pinned one.
- **The box while it restores** carries a `restoring` mark. Commands,
  starts, stops and resizes are refused with "Box amber-fox is being
  restored to snapshot ...", and the box sweep leaves it alone, so it is
  never taken as stopped or started outside bb-box. A restore always ends
  with the box running; one of a stopped box starts it.
- **The guard** reads, through the plugin, the threads on the box's BB
  machine (`threadsOn`), whether a person holds its desktop, and BB
  terminals open on it. A box with a thread on it, working or idle, or the
  box the caller's thread runs on, is refused for everyone, `--force`
  included, naming the threads: execution machines' restores stay off
  (G17). Control and terminals refuse an agent, and refuse the person
  unless `--force`, which `restore-asked` then records. When bb-box cannot
  tell which threads run there, or whether a terminal is open, it refuses.
- **Agents.** `mayAct` already let an agent restore its own thread's
  boxes only. An agent cannot pass `--no-undo` or `--force`, and unit 4's
  two switches now bite: with "Agents may restore their own boxes" off, or
  "Agents may restore memory snapshots" off for a memory snapshot, an
  agent's restore is refused. The tool comes in unit 5.
- **Restart recovery** (`#recoverRestore`). At start and at each sweep, an
  operation cut short is finished from the step it reached or settled: one
  recorded but not begun changes nothing; a stop that had not happened is
  undone; an undo or a rollback is judged by its Proxmox task, found by
  guest, type and time if its UPID was never recorded; a held copy that is
  not a template is deleted and made again, never trusted; a half-made new
  guest of a swap is deleted and made again; a swap that wrote the record
  goes on to disarm the old guest. What bb-box cannot tell stays `unknown`,
  pinned, with the box marked and stopped, and the doctor says so.
- **Locks.** A guest Proxmox left locked refuses a restore and a take with
  the host's command, and the doctor's Snapshots section now has a check
  for each box with snapshots whose guest is locked (`snapshots.locked.<box>`)
  and each restore bb-box could not confirm (`snapshots.restore.<box>`).
- **ZFS's order: held copies, swaps and earlier guests.** Built for
  Proxmox LXC and QEMU, and off: ZFS restores are refused. A switch for
  live checks only (Decided during unit 3) runs it on LVM-thin:
  - the restore stops the box, makes a held copy of the stopped guest
    (`copyGuest`: a full clone into the box range, its VMID recorded
    before the clone; labelled `held-copy`, `snapshot.<id>`, `taken.<s>`;
    `disarmCopy`: `onboot` 0, every link down, and on QEMU a new SMBIOS
    UUID; `templateCopy`), then rolls back to the newest snapshot only;
    an older one is refused with how many are newer;
  - a held copy is made only of a box whose identity reset works now, read
    before the stop, and the undo records that version as its `forkSafe`
    (after the reviews);
  - restoring a held copy is a swap, which also stays behind the switch:
    `adoptCopy` makes a new guest from it
    with the box's MAC addresses and, on QEMU, its SMBIOS UUID, `onboot`
    1, links up, and the address of its own VMID; the record's guest is
    swapped; `retireGuest` disarms the old guest (`onboot` 0, links down,
    new MAC addresses and UUID, tagged `earlier-guest`), whose snapshots
    are then "on amber-fox's earlier guest: fork only". An old guest with
    no snapshot on it is deleted at once;
  - held copies and earlier guests are excluded from the box sweep, the
    snapshot listing of current guests and outside restores, are listed by
    `heldSnapshots` as `held-copy` and `earlier`, are kept by the box
    sweep while an operation uses them, and go with their last snapshot
    or their box's release, each removal recorded as a settled operation
    so a listing that began before records none of them again.
- **Restores made outside bb-box** (`outsideRestores`, at each sweep):
  `vzrollback` and `qmrollback` tasks on this install's guests since the
  last look, read from the node's task list, not started by bb-box (no
  operation names their UPID). `restored-outside` when one ended OK, after
  which bb-box reads the size back, writes the labels again, and when the
  box runs, its access file, and starts its BB machine; `restore-outside-failed`
  with what bb-box then found; `restore-outside-running` once, then its
  end at a later sweep. Each is recorded as a settled operation, so it is
  logged once, also after a restart. A listed task with no end time is
  read from its own status: the list gives a running one `status` RUNNING.
- **The box log** gains `restore-asked`, `restored`, `restore-failed`,
  `restored-outside`, `restore-outside-failed`, `restore-outside-running`
  and `held-copy-made`, which its store already allowed.
- **The CLI**: `bb box snapshot restore <box> <snapshot> --replace
  [--no-undo] [--force] [--request] [--json]`, and `--check`, which says
  what the restore would do (its undo, with time and space; a swap and
  what stays on the earlier guest; the size it goes back to; what it would
  end) and refuses what it would refuse, changing nothing: the plan first,
  as 070 asks of every command; with `BB_BOX_LIVE_CHECKS=1`,
  `hold-next` gains `stopped`, `copied`, `undo`, `rolled-back`, `adopted`
  and `started`, and `bb box snapshot zfs-order <backend> on|off`. The list
  says "a held copy, guest 3240" and "on amber-fox's earlier guest 3241:
  fork only".
- **Proxmox LXC's start** reports its parts (boot, network, ssh), as QEMU's
  did, which the restore logs.
- **Docs**: the guide's [Snapshots](../guide/snapshots.md#restoring-a-box)
  page, the reference regenerated, and 070's Decided during unit 3.

### Tests

On a Linux box, 8 cores, 16 GiB, Node 24.21, on this unit's commits over
main `b8088de6`, in a fresh copy of the branch: `npx tsc` passes, and the
reference is current; the node suite ran 3,067 tests, 2,779 passed, 0
failed, 288 skipped (the live and conformance ones); vitest ran 384, all
passed. The node suite includes the docs, site and reference checks. New
or changed tests, each on a set clock where time matters:

- `test/restore.test.ts`, 14, through `Boxes` and a fake provider whose
  snapshots copy the fake guest's files and whose rollback puts them and
  the size back: G4 on LVM-thin (the order of stop, undo, rollback and
  start; the oldest of three; the undo holding what was written before the
  stop); G8 (the access file written before the labels, without the
  snapshot's stale line; the size read back and said); G9's undo sequences
  (two undos a box; the oldest undo restored keeps its target; a kept undo
  stays); the undo's admission (room and ceiling refused before anything
  stops, each with its fix; `--no-undo` for the person only); G5 (a thread
  on the box refuses everyone, `--force` included; control, terminals and
  an unreadable guard; `--force` recorded; the agents' switches); failures
  (an undo that fails, a refused rollback and a failed stop start the box
  again unchanged; a failed rollback task leaves it stopped, naming the
  undo); G7 (lock words and the doctor's check; ZFS refused; a restore
  across a disk's growth); G6 (a restart after the stop, the undo, the
  rollback and the start; one before anything changed; an unconfirmed
  rollback unknown and pinned, the box marked, its start refused, the sweep
  leaving it alone, the doctor's check, then settled); a repeated request;
  G13 (bb-box's own rollback not logged as outside; two OK, a failed one
  and a running one, each once, the running one's end after a restart);
  ZFS's order (the newest only; the held copy disarmed and a template; the
  swap with the box's identity; the earlier guest fork only and kept by the
  box sweep; a release deleting both, with a listing begun before recording
  neither again); G6 and G16 in ZFS's order (a copy before its template
  deleted and made again; a swap after its new guest made, finished; an
  old guest with no snapshot deleted); expiry of a kept snapshot on an
  earlier guest; and `--check` (what a restore would do, its refusals,
  nothing changed).
- `test/proxmox-lxc-snapshots.test.ts`, 5 more: the restore plan (rollback,
  the snapshot's size, newer ones, ZFS, a missing target, the token
  without `VM.Snapshot.Rollback`); the rollback (refusing a running guest,
  a lock with `pct unlock`, its UPID before it waits, the config put back,
  a failed task); outside rollbacks with user and status, and one running;
  the copy methods (claimed before the clone, labels, disarm, template,
  listing, the box's MAC and own address on the new guest, the earlier
  guest's new MAC, the sweep's exclusions, a copy of another box left
  alone).
- `test/snapshots.test.ts`: its world moved to `test/snapshot-world.ts` for
  both files; the reused request's words.

### On a separate BB

A fresh `npx bb-app` 0.48.1 with no account, its own data folder and
ports, started with `env -i`, `HOME`, `PATH` and `BB_BOX_LIVE_CHECKS=1`
only, in a Proxmox LXC box; bb-box installed from this branch with `bb
plugin install path:`, and BB's machine access set to direct with the
box's address, so boxes enrol without an account. The lead gave it a
Proxmox LXC and a Proxmox QEMU backend, on LVM-thin, with production's
templates and their own VMIDs and addresses, and ran each root step from
[`proxmox-root.sh`](070-snapshots/unit-3/proxmox-root.sh) after reading
it; the script acts only on the given VMIDs whose guests carry the
install's tag. Boxes were machines of the person's, made with `bb box
machines add`. The node is written pve-1.

**Restores by rollback** (`rest-lxc` on Proxmox LXC, 2 cores, 4 GiB, 16 GiB;
`rest-vm` on Proxmox QEMU, the same size):

| Check | Result |
| --- | --- |
| G4, LXC: three snapshots, a file written after the last, restore to the oldest | the file said "one"; the undo "before the restore at 00:32" was ready 1.5 s after `restore-asked`; restoring the undo then brought back the file written after the last snapshot, before the stop |
| A restore's time, LXC | 4.4 s as bb-box timed it (stop 1.1 s, undo 0.3 s, rollback 0.4 s, start 2.3 s, access 0.2 s), 5.1 s for the command, to a snapshot taken while stopped (an undo) |
| Proxmox's start after a rollback, LXC | 44 to 46 s for Proxmox's own start task (vzstart 00:39:06 to 00:39:50, 00:42:56 to 00:43:41, 00:46:14 to 00:46:58) when the snapshot was taken while the container ran; 1.4 to 2.5 s when taken while it was stopped; 1.8 and 2.1 s for a plain stop and start. The task log says only "TASK OK". bb-box waits for it, so such a restore takes about 47 s |
| G4, QEMU: the same | the oldest back; its undo brought back the later file; 9.9 s (stop 0.2 s, undo 0.3 s, rollback 0.5 s, start 8.9 s, access 0.1 s) |
| A memory snapshot, QEMU | taken with `--memory` while a `sleep` ran; the restore took 2.6 s, and the VM came back running: its uptime went on from the take, the `sleep` was there, and BB listed the machine connected |
| G8, the check said it first, LXC: a take at 4 GiB, a live resize to 6 GiB, a BB terminal open | `--check --force`: "... It goes back to 2 cores, 4 GiB memory, 16 GiB disk, as it was then; it has 2 cores, 6 GiB memory, 16 GiB disk now. It would also end what is on it now: a BB terminal is open on it. ... Nothing changed." The restore then did that, and `bb box status` said 4 GiB |
| G8, size, QEMU | memory resized from 4 to 6 GiB with a restart after a take; the restore said "Its size went back from 2 cores, 6 GiB memory, 16 GiB disk to 2 cores, 4 GiB memory, 16 GiB disk, as it was then", and `free` and `bb box status` said 4 GiB |
| A restore across a disk's growth, LXC | refused at first, as 070 said. Then measured with a rollback by root across a growth from 16 to 18 GiB: Proxmox put back `size=16G`, `df` said 16G, the container started, and its file was the snapshot's. bb-box now allows it; a later restore said "... 18 GiB disk to ..., 16 GiB disk, as it was then" |
| G8, access first, LXC and QEMU | a systemd path unit in the box logged each change of the access file with the time and whether a sentinel line was in it. A line was added after the last bb-box command, a snapshot taken, the box restored: after its boot (LXC at 1793409785), the file changed once, at 1.9 s, without the sentinel, the same second as bb-box's SSH session to it began; QEMU's the same, 4.6 s after its boot. bb-box records that step before the labels and BB's machine |
| G5, a BB terminal open on the box | "Restoring box rest-lxc to "guard" would end what is on it now: a BB terminal is open on it. Restore anyway with --force. bb-box changed nothing." With `--force` it restored, and `restore-asked` ended "restored anyway, though a BB terminal is open on it." |
| G5, a thread on the box (in a project on it, and the terminal) | "Box rest-lxc is a box threads run on: "Stay idle; a test of bb-box's restore guard." (working) runs on it. A restore would take their worktrees, uncommitted files and sessions there with it, and bb-box does not restore such a box yet ...", also with `--force`. After the thread was archived, only the terminal was named |
| G6, LXC: `hold-next` at stopped, undo, rolled-back and started, then `bb plugin reload bb-box` | each restore finished at the next start, logged "... after bb-box restarted", with the right file; the doctor said 0 operations not settled |
| G6, QEMU: held after the rollback of a stopped box | finished after the restart in 13 s; started, 4 GiB, 0 operations not settled |
| G7, LXC: the lead left 3242 locked (rollback) | take: "Proxmox LXC on pve-1 left box rest-lxc locked (rollback), so it takes no snapshot. Run `pct unlock 3242` on pve-1."; restore: "... so bb-box restores nothing. Run `pct unlock 3242` on pve-1."; the doctor: "[fail] rest-lxc locked: ... Fix: Run `pct unlock 3242` on pve-1." |
| G7, QEMU: 3250 locked | the same three, with `qm unlock 3250` |
| G13, LXC: root's `pct rollback` twice to one snapshot, then one refused by a lock, between sweeps | the next sweep logged two `restored-outside` ("Proxmox's task UPID:...:vzrollback:3242:root@pam:, by root@pam, at ..., ended OK ...") and one `restore-outside-failed` ("failed: CT is locked (backup). bb-box then found it stopped.") |
| G13, LXC: a rollback held on Proxmox's config lock for 10 s, with bb-box sweeping every 5 s | the first try logged it as failed with "RUNNING": the task list gives a running task that status. Fixed: a task with no end time is read from its own status. Then: `restore-outside-running` at 00:55:35, and at 00:55:46 `restore-outside-failed`: "can't lock file '/run/lock/lxc/pve-config-3242.lock' - got timeout" |
| G13, QEMU: root's `qm rollback` of the running VM | `restored-outside` at the next sweep, "bb-box wrote its labels again, writes its access file when it next starts" (Proxmox left it stopped) |
| G10, the undo's price, QEMU, with a made-up $0.1 a day and one paid snapshot held | "bb-box would take an undo of box zfs-vm before restoring it. It would bring snapshots held on Proxmox QEMU on pve-1 to about $6.00 a month, past your ceiling of $5.00. ... Or restore without an undo, with --no-undo." The box stayed ready, and nothing was logged; `--no-undo` restored |

**ZFS's order, under the live-check switch, on LVM-thin**:

| Check | Result |
| --- | --- |
| An older snapshot | "Live checks run ZFS's order on Proxmox LXC on pve-1: as on ZFS, bb-box restores only the newest snapshot there, and "one" has 6 newer ones. Delete them yourself first. bb-box never deletes newer snapshots to make a rollback possible." |
| The newest, LXC | a held copy of the stopped box into 3240 in 9.6 s, then the rollback: 58 s in all, Proxmox's start 45 s (the snapshot was taken running) |
| The held copy, `pct config 3240` (by the lead) | `template: 1`, `onboot: 0`, `link_down=1`, its own MAC, tags `held-copy` and `snapshot.<id>` |
| Its undo, a swap, LXC (`--no-undo`: the backend had 3 VMIDs) | 11 s (stop 1.1 s, swap 8.0 s, start 2.2 s): a new guest 3241 from the copy, with the box's MAC `bc:24:11:30:f1:13`, `onboot: 1`, link up, the address of its own VMID (.251; the box's record, its commands and `hostname -I` all said so), the same BB machine and host ID, connected, and the file from before the restore. The old guest 3242: `onboot: 0`, `link_down=1`, a new MAC, tag `earlier-guest`; its snapshots listed "on rest-lxc's earlier guest 3242: fork only" |
| QEMU, the same | held copy into 3252 in 7.5 s; the swap in 6.5 s onto 3250 with the box's MAC `bc:24:11:68:ac:73` and SMBIOS UUID, from .253 to .252; the old guest 3251 with a new MAC and UUID, links down, `onboot: 0`; the copy a template with its own UUID. A clone of a held copy always gets the address of its own VMID, never the copy's |
| G6 and G16: `hold-next --at copied`, so the restore stopped after its clone, before the copy was disarmed or a template | `pct config 3240` then: no `template` line, link up, `onboot: 0`. After `bb plugin reload bb-box`: "Deleted guest 3240, the undo's copy for the restore of box rest-lxc: bb-box restarted before it was a template, so it is not trusted. bb-box makes it again from the stopped box." It was made again in 7.5 s, as a template, disarmed, and the restore finished |
| G16: the remade copy adopted for the same box | the file written just before the stop, BB's `auth.json` and `host-id` from the enrolment at 00:32, the same MAC; BB listed the same machine, connected |
| G6: `hold-next --at adopted`, after the swap's new guest was made, then a restart | a sweep during the hold released nothing; after the restart the swap finished: the new guest, the same MAC and machine, the copy's file |
| An old guest with no snapshot left on it | was left behind; fixed: such a guest is now deleted at the end of the swap. The lead destroyed the one left |
| G16 and G6 on a box made from the rebuilt template (unit 2's program, version 2, its unit enabled, the box armed, its marker matching) | a restore in ZFS's order (held copy 3242, then the rollback: `boot=kept` after); its undo, a swap held after the new guest started, then a restart: finished at the next start, onto 3240, at .250, with the same MAC `bc:24:11:d5:98:ca` and BB host ID, connected, and `boot=kept marker=matches`: no reset |
| G16: that box's earlier guest 3241, started by hand (`pct start` by the lead) | `pct config`: `onboot: 0`, `link_down=1`, MAC `BC:24:11:CF:0F:C8`, tag `earlier-guest`. Started, it reset: "none of the marker's MAC addresses (bc:24:11:d5:98:ca) is on this box's interfaces (bc:24:11:cf:0f:c8)", removing BB's host ID; its journal, read with the guest stopped and mounted: the check began at 02:04:40.413, decided at .474 and finished at .608, then systemd-networkd at .643, ssh at .688, the box user's manager at .756; eth0 stayed down |
| Release of that box | its earlier guest 3241 and held copy 3242 went at the next sweep |
| Release of a box with a held copy and an earlier guest (QEMU) | the next sweep deleted both, each snapshot logged "it went with its held copy, guest 3252" and "... its box's earlier guest, guest 3251". A second sweep running at the same time had listed the copy before it went, and recorded it again as found: fixed, each such removal is now a settled operation, as unit 1a's are, and a test holds a listing open across it |

### After the reviews

Two independent reviews read the bundle at `ed6abd28`: Astra (merge after
fixes, nine findings) and Opus (merge after fixes 1 to 3). Each reproduced
its findings with scratch tests. Every finding is fixed, with a regression
test; the reviews' failure cases are now tests in
`test/restore-recovery.test.ts`, and each of the 15 that reproduce a finding
fails on `ed6abd28` and passes now. The lead asked for all of them, and for
the stricter fix where the two overlapped.

| Finding | From | Fix | Tests |
| --- | --- | --- | --- |
| Recovery at `undo-ready` rolled back although the undo had been deleted outside bb-box | Astra 1 | Before recovery goes on to the rollback or the swap, it checks the undo is still there and whole: a snapshot in a fresh listing, a held copy still a template. If not, the undo is marked lost and the box starts again as it was | "recovery does not roll back once its undo is gone" |
| A restart at `adopt-claimed` left `guests.new` naming the undo's held copy, which recovery then deleted as a half-made guest; `adoptCopy` failing before its claim did the same; `deleteCopy` would destroy any guest of the box | Astra 2, Opus 1 | The undo's copy is recorded on the undo's own record, never in `guests`; `adopt-claimed` clears `guests.new` in the same write; a half-made new guest is discarded through `release` only if it is not the box's guest and no snapshot record lives on it; `deleteCopy` destroys only a guest tagged as a held copy or an earlier guest of exactly that box, or described as a held copy of it | "a swap with an undo cut short at adopt-claimed", "a swap whose new guest cannot be made", "a swap cut short at adopt-task", and `deleteCopy` refusing a box's own guest |
| Rollback recovery could take the undo's UPID, still on the operation, or an outside rollback just before the request, for the rollback's | Astra 3 | Each step that begins a provider task clears the last one's in the same write, and records its own time (`step_at`, a new column); the lookup by guest, type and time starts from that step's time, takes only tasks of the token's own user, and stays unknown when two tasks could be the step's | "keeps no earlier task", "not confirmed by another user's rollback", "two tasks ... leave it unknown", and the backend's user filter |
| The guard was read only while planning | Astra 4 | It is read again before the stop and before the rollback or swap, in recovery too. A thread found then refuses the restore for everyone; a person in control or a terminal refuses it unless the person's `--force` covered that very loss, which the operation records. Refused before the stop, nothing changed; after it, the box starts again as it was | "the guard is read again before the stop, before the rollback, and before recovery goes on" |
| A held copy was made of a box without a working identity reset, and an undo took the target's `forkSafe` | Astra 5, Opus 3 | `forkSafe` is read from the box while it runs, before the stop, and is the undo's; ZFS's order is refused without it, unless the person restores without an undo | "a held copy needs the box's identity reset now, and an undo's forkSafe is the disk it holds" |
| A lock a running backup held refused a take but not a restore | Astra 6 | The plan's restore is `none`, with "Try again when it ends", for any lock without an unlock fix | the backend's "a lock a running backup holds refuses a restore" |
| `role` "machine" refused a box with no thread left on it | Astra 7 | Only threads on the box's BB machine now, or the caller's thread running on it, as the owner answered | "a box that was a thread's own machine, with no thread on it now, may be restored" |
| A take went ahead during a restore bb-box could not confirm | Astra 8 | Takes are refused, as restores, starts, stops and resizes are, while a restore holds the box or is unsettled | "no take while a restore bb-box could not confirm holds the box" |
| A GPU desktop's start ran a command before the access file was written; the words claimed nothing ran with the old file | Astra 9 | A backend's `start` takes a hook it calls once the box answers, before any command of its own; the restore writes the access file there. The words now say that what the box started at boot may have read the old file | "the access file is written once the box answers, before the backend runs any command of its own" |
| ZFS's order made the held copy a second time after a restart at `rollback-submitting` | Opus 2 | Recovery resumes after the held copy (`copy-ready`) when the undo is one | "ZFS's order cut short at rollback-submitting ... makes no second one" |
| Older undos went before the rollback succeeded; `--check` did not name them | Opus 4 | Undos past two go only once the restore is done; `--check` names the one that would | "older undos go only once the restore is done" |
| A restoring mark could outlive its operation and hold the box for good | Opus 5 | At each sweep, a mark whose operation is no longer unsettled, or unknown to bb-box, is cleared and logged | "a restoring mark never outlives its operation" |
| A held copy restored by a swap whatever the switch said | Opus 6 | Swaps stay behind the live-check switch until such restores are checked on ZFS | "a held copy is restored by a swap only while the live-check switch is on" |
| Words: `--check` on a swap that deletes an old guest with nothing on it; "Run it again without --check"; "Check its status in a few seconds" for a restore bb-box could not confirm | Opus 7 | `--check` says the old guest is deleted, and with no undo that nothing then holds the box as it is; "with --replace instead of --check"; the box's words point to `bb box doctor` and `bb box sweep` | |
| Restarts mid-task and swaps with an undo were not tested | Opus 8 | Tests for an undo's task running, then OK, and failed; a rollback's task OK and failed; a copy's task begun; an adoption's task begun; a swap whose earlier guest cannot be disarmed at once; a swap with its own undo | `test/restore-recovery.test.ts` |

The fake provider now does a task's work before it reports the task, as
Proxmox does, and its tasks carry a user.

After the fixes, on this unit's commits over main `399c1b49`, in a fresh
copy on the same kind of box: `npx tsc` passes, and the reference is
current; the node suite ran 3,093 tests, 2,805 passed, 0 failed, 288
skipped; vitest ran 384, all passed.

**The fixed paths, live**, on a third separate BB set up as above, with the
same backends, VMIDs 3240 to 3242 and 3250 to 3251, and
`general.identityResetBackends` on for both. Each box was made from the
rebuilt templates and armed (`bb-box-identity status`: version 2, `armed=yes`,
the box's ID):

| Check | Result |
| --- | --- |
| A rollback restore, LXC, with a line added to the box's access file before the take | 47 s (stop 1.1 s, undo 0.3 s, rollback 0.4 s, start 44 s, access 0.6 s); the file was the snapshot's, and the access file had no such line: the start's hook wrote it |
| `hold-next --at undo`, then `bb plugin reload bb-box` | recovery found the undo still there, read the guard again, rolled back and started: "restored ... in 50 s (rollback 0.4 s, start 45 s, access 0.5 s) after bb-box restarted", with the snapshot's file |
| ZFS's order on an armed LXC box | `--check`: "copy it in full, stopped, as its undo ...: a held copy that cannot start, about 38 s, up to 17 GB on local-lvm". The restore: 56 s (stop 1.5 s, undo 8.1 s, rollback 0.8 s, start 45 s, access 0.4 s), its undo a held copy, guest 3242; `boot=kept` after |
| Its undo as a swap (`--no-undo`), held once the clone's task began (`hold-next --at task`), then a restart | Proxmox's clone was still running at the restart, so recovery left the restore unconfirmed; the next sweep, 3 minutes later, deleted the half-made guest 3240 (vzdestroy 02:57:56), cloned it again from 3242 (vzclone 02:54:49, then 02:57:56) and swapped: "restored ... in 198 s (swap 7.5 s, start 1.7 s, access 0.4 s) after bb-box restarted; no undo". The box at .250, its MAC `bc:24:11:cb:2b:b9` and box ID the same, `boot=kept`: no reset; the file from before the restore; the target's copy 3242 untouched; "one" listed on the earlier guest 3241, fork only. The deletion logged nothing: it now logs "Deleted guest 3240, the new guest part made for the restore of box ..." |
| Deleting "one", the earlier guest's last snapshot | "The earlier guest 3241 of box re-zfs is deleted: its last snapshot went." |
| ZFS's order again, held after the held copy (`hold-next --at undo`), then a restart | recovery checked the copy 3241 was still a template, rolled back and started: "restored ... in 56 s ... after bb-box restarted". One clone only (vzclone 02:59:36 to 02:59:43), so no second copy |
| `pct config` of both held copies (by the lead) | `template: 1`, `onboot: 0`, `link_down=1`, their own MACs, tags `held-copy`, `install.<id>`, `box.<id>` and `snapshot.<id>`. Each keeps the address its box had when copied, inert behind its link; a guest made from it gets its own VMID's |
| A rollback restore, QEMU, the same access check | 10 s (stop 0.2 s, undo 0.3 s, rollback 0.5 s, start 8.9 s, access 0.4 s); the file was the snapshot's, no such line in the access file, `boot=kept` |
| Proxmox's start after a rollback | its own vzstart task took 44 to 45 s each time (02:44:54 to 02:45:38, 02:47:51 to 02:48:35, 02:59:45 to 03:00:30), and 1 s for the guest made from a held copy (02:58:04 to 02:58:05) |
| Removing both machines | every snapshot went with its box, and both held copies with the box's records ("it went with its held copy, guest 3242"); `bb box snapshot list --all` then said "There are no snapshots." |

### Gates

| Gate | Result |
| --- | --- |
| G4 storage-rollback | **Passed on LVM-thin, LXC and QEMU**: the plan reads the storage; a restore to the oldest of three with its undo, nothing written before the stop lost. **ZFS's order passed under the live-check switch on LVM-thin, LXC and QEMU**: an older target refused with the words, the newest restored after its held copy, every newer snapshot still there; its undo a swap onto a new guest with the box's MAC addresses (and SMBIOS UUID on QEMU), `onboot` set and links up, the same BB host ID with no reset, the old guest an earlier guest whose snapshots list fork only; a restart while the copy was not yet a template and after the new guest was made; release deleting both. **Not proved**: Proxmox's own refusal on ZFS (no ZFS node), and expiry, which needs Keep (unit 8). ZFS restores stay off |
| G5 restore-guard | **Passed** for a thread on the box (refused for everyone, `--force` included, naming it) and a BB terminal (refused, then restored with `--force`, which the log records). A person holding the desktop is tested only in `test/restore.test.ts`: the separate BB's backends offer no desktop. The agent's refusal is tested there too; its tool is unit 5's, the person's dialog unit 6's |
| G6 restart-recovery | **Passed** on LXC after the stop, the undo, the rollback and the start; on QEMU after the rollback; in ZFS's order after the clone and after the swap's new guest was made. Each finished, nothing was released as a leftover, and no operation stayed unsettled. One that cannot be confirmed stays unknown and pinned, in the tests. After the reviews, again on LXC after the undo, in ZFS's order after the held copy, and during a swap's clone: the half-made guest deleted and made again at the next sweep |
| G7 lock-words | **Passed** on LXC and QEMU in the CLI's take and restore and in the doctor. The page and the tool come with units 6 and 5 and use the same words |
| G8 access-first | **Passed** on LXC and QEMU, as measured above, and the memory read back across a resize on QEMU, the disk across a growth on LXC |
| G9 serialised-and-eligible, restore's part | the undo sequences in the tests (two undos; the oldest undo restored keeps its target; a kept undo stays); live, every restore replaced the oldest undo past two, never its own target |
| G10 ceiling-rate, the undo's part | **Passed** live on a made-up price: refused before the box stopped, and restored without it |
| G13 outside-restore | **Passed** on LXC and QEMU: two restores to one snapshot, a failed one and a running one, between and across sweeps, each logged once by its status. A snapshot taken by hand (`pct snapshot`) logged nothing, as it is not bb-box's; one of bb-box's deleted by hand (`pct delsnapshot`, 01:46:47) was logged `snapshot-lost` at 01:57:00, at the listing 10 minutes after the first that missed it, as unit 1a does. Without a task, bb-box claims no restore |
| G16 held-copy-inert | **Passed**: each held copy a template, disarmed, in `pct config` and `qm config`; each earlier guest with `onboot` 0, links down and a MAC that is not the box's; a copy cut short before its template deleted and made again, and the remade copy adopted for the same box with its files, credentials and host ID. On a box made from the rebuilt template, with unit 2's program (version 2) armed: after its swap the new guest's check said `boot=kept`, with the box's MAC and host ID, so no reset ran; its earlier guest, started by hand by the lead, reset (the check decided at 02:04:40.474 and finished at .608) before systemd-networkd (.643), ssh (.688) and the box user's manager (.756), removed BB's host ID, and kept its link down. **Not proved**: the node's reboot, as no node can be rebooted; it is a condition before ZFS restores or unit 8's Keep are turned on |

### Choices and deviations

- **`restore-asked` is logged when the restore is recorded**, before the
  stop, not at step 6, so the log shows the ask before the box stops. A
  restore refused before then logs nothing, as nothing changed.
- **The restore does not wait for BB's machine to come back.** It starts
  BB's daemon again as `box_start` does, and commands wait for it. On the
  separate BB, without an account, the wait for the thread's variables
  added 30 s to every restore.
- **A restore across a disk's growth is allowed** after measuring it
  (Decided during unit 3).
- **A swap takes a held copy of the stopped guest as its undo**, as ZFS's
  order does; 070 does not say what a swap's undo is. A swap needs a VMID
  for each of the box, its undo's copy and its new guest.
- **An old guest with no snapshot left on it is deleted** at the end of a
  swap, as an earlier guest exists only for its snapshots.
- **Undos past two are replaced** once the restore is done, never its own
  target (after the reviews).
- **A restore of a stopped box starts it**, as step 7 says, so the access
  file is written at once.
- **Proxmox LXC's start now reports its parts** (boot, network, ssh),
  which `bb box status` shows under Last start, as QEMU's did.
- **A restore cut short while its provider's task still runs waits for
  the next sweep**, up to 3 minutes: recovery leaves it unconfirmed, the
  box marked, and settles it once the task has ended. `bb box sweep`
  checks at once.
- **An outside restore is set straight once.** On LXC the lead locked the
  guest at once after, and setting it straight failed on the lock; bb-box
  says so in the log and does not try again. The access file is written
  by bb-box's next command anyway.

### Conditions and open questions

- **ZFS restores** stay off until G4 runs on a ZFS node; the node reboot
  of G16 is a condition before they, or unit 8's Keep, are turned on.
- **Restores of boxes threads run on** stay off until G17 (unit 5).
- **Proxmox's 44 s start** after a rollback to a snapshot taken while the
  container ran: Proxmox's own task takes it, and its log says only "TASK
  OK"; a guest made from a held copy starts in 1 s. Worth a look on the node (an fsck or a journal replay at mount is
  a guess, not measured), as it makes such a restore take about 47 s.
- **Thin metadata** is still not read (unit 1a's known limit), so a
  restore's undo, like a take, checks the pool's data only.

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

## Unit 5: the agent's tools, the form and the turn hold

Built on 31 October 2026 on main `ec8e31e7` (units 0 to 4 included), and
rebased onto `e55c35f4`. The lead's answers are in 070's [Decided during
unit 5](070-snapshots.md#decided-during-unit-5).

### What changed

- **The agent's tools**, `src/plugin/snapshot-tools.ts`: `box_snapshot`
  (`box`, `name`, `note`, `memory`), `box_snapshots` (`box`, optional),
  `box_snapshot_delete` (`box`, `snapshot`) and `box_restore` (`box`,
  `snapshot`, `replace`, which must be true, and `request`). Each answers as
  section 4 says, with "3 of 5 for this box", and each refusal ends with a
  hint for snapshots: what to delete, whom to ask, or to try again. A tool
  finds its box as the other box tools do, and counts the box its thread
  runs on, its own new box included, as one it runs on.
- **Section 3, in one place.** `mayAct` lets an agent restore on a box it
  runs on, and `restoreRoute` (`src/core/snapshot.ts`) decides how: at once,
  through the form, or not at all. An agent restores its thread's own box
  at once, with an undo; through the form when "Agents may restore their
  own boxes" is off, or when the box is one threads run on; never a memory
  snapshot with "Agents may restore memory snapshots" off. Nobody restores
  a box threads run on while such restores are off, and when on, only from
  a disk snapshot and always with an undo, `--no-undo` refused.
- **The agent's take past the limit** deletes, once the new one is ready,
  the oldest snapshot an agent of the same thread took and nobody kept, on
  the person's machines too, checked with `eligible` at that moment
  (`limitVictim`, from unit 1a). The take's operation records it, so a
  restart finishes the replacement. A person's take past the limit is
  refused, as before; so is an agent's when no snapshot qualifies, saying
  so. If the delete is refused at that moment, the take stands and its
  answer says the box is over its limit.
- **"Try again".** A new error code, `try_again`, for refusals that hold
  only for now: a host's storage too full, for a take or a restore's undo,
  and a task such as a backup holding the guest's lock. The Proxmox plan
  says the latter as `busy`. Agents get "This holds only for now, not for
  good"; "unsupported" is kept for what the box cannot do.
- **The form**, through `bb.ui.requestInput`: `box_restore` asks the engine
  to restore; when the route is the form, the engine refuses with
  `needs_yes` and the plan it would carry out (`YesNeeded`), and the tool
  opens the form in the thread (renderer `restore`, `src/app/restore-form.tsx`,
  registered with `pendingInteraction`). The form says what goes, the undo
  that is always taken, the size the box goes back to, what the backend
  leaves out, and on the box the thread runs on, that its session goes back
  too. It says an answer is "a yes given in this thread". On a yes, bb-box
  holds every new turn on the box, waits up to a minute for turns there to
  end, then restores the snapshot the form named, by its ID, as its own
  work, not under the tool's signal. The yes is bound to a digest of the
  plan: the box, its guest, the target and its reference, the undo's kind,
  what else goes, each thread by its ID, and the box's snapshots. A plan
  that changed since asks again, at most three times, and a yes is checked
  on any route. The form agrees to what goes only on a box threads run on;
  with agents' own restores off, a person's desktop control or a terminal
  refuses the restore before any form, as it does without one. Cancel and a timeout answer the agent;
  a stop of the thread, a BB restart and bb-box stopping answer it as an
  error, which BB only steers in.
- **The yes on the record.** The operation keeps the yes (thread, title,
  time, plan), and `restore-asked` and `restored` end "on a yes given in
  "Asks" (thr_...)".
- **The turn hold**, `src/plugin/turn-hold.ts`, on BB's `message.dispatch`
  hook: a message for a thread on a box that bb-box restores waits, with
  "bb-box is restoring box dev-desk, the machine this thread runs on. This
  message waits until the box is ready again." It holds from a form's yes,
  and from a restore's record by any route, until the box is ready, also
  after bb-box restarts, as it reads the boxes' restoring marks. When a
  hold ends, bb-box asks BB to try the held messages again
  (`recheck`), and each wait also asks BB to try again in 15 s (`sendAt`),
  as the live check found a recheck BB did not act on.
- **Checks for a running turn**: before the stop, just after it, and before
  the rollback. One found stops the restore: before the stop with nothing
  changed, after it by starting the box again as it was.
- **Restores of boxes threads run on stay off** (`MACHINE_RESTORES_SHIP`),
  as G17 did not pass (below). For live checks only, with
  `BB_BOX_LIVE_CHECKS=1`, `bb box snapshot machine-restores on|off` changes
  that until bb-box restarts, and `bb box snapshot hold-next` gains
  `--at checked` (after the last check, before the stop) and `--seconds`.
- **Settings**: the agents' two switches are on the Snapshots page, under
  Agents, saved at once as 067's switches are, and in Find.
- **`bb box option`** sets `general.snapshots.ceilings.<backend>`, in whole
  cents, refusing a backend that is not there, and the two switches;
  `option list` shows a ceiling row for each backend.
- **Words**: the skill's Snapshots section (when to take one, restore
  rather than undo by hand, delete your own, try again, the form and ending
  the turn, never answer bb-box's forms); the guide's Agents' snapshots
  section; the reference regenerated; requests 38 and 39 in
  [bb-requests](../bb-requests.md).

### Tests

On a Linux box, 8 cores, 16 GiB, Node 24.21, on this unit's commit over
main `e55c35f4`, after the reviews' fixes: `npx tsc` passes, and the
reference is current; the node suite ran 3,118 tests, 2,830 passed, 0
failed, 288 skipped (the live and conformance ones); vitest ran 386, all
passed. The node suite includes the docs, site and reference checks; they
ran again, with the new tests, on the last commit, which adds only docs. New
or changed tests, each on a set clock where time matters:

- `test/snapshot-rules.test.ts`, 2 new: section 3's table cell by cell on a
  set clock (an agent on its own box, on a box it runs on, on another
  thread's box, kept snapshots, the person, a command; take, see, see the
  picture, restore, fork, delete, keep, unkeep, rename and note), and
  `restoreRoute` for each switch and case.
- `test/snapshot-agents.test.ts`, 13: the agent's take past the limit,
  never another thread's, a kept or the person's, on the person's machine,
  and finished after a restart; `try_again` for room and
  a task's lock; a box threads run on off for everyone, then the person's
  restore naming each thread, never without an undo or from memory; G17 in
  the engine, a running turn before the stop and one that starts as it
  stops; the yes bound to its plan, a stale one asking again, and the yes
  on the record, and checked on any route; the settings route and a
  terminal; agreement by thread ID; an orphan ceiling unset; the turn
  hold's release and its words for an unconfirmed restore; an agent's own
  box restored at once.
- `test/plugin.test.ts`, 5 new: the four tools through BB's fake host,
  with G12's guesses from another thread; the form's cancel, a wrong
  answer, a changed plan and the yes; the hold on `message.dispatch` from
  the yes until ready, its words within BB's 200 characters, `sendAt` and
  the recheck; `bb box option` for ceilings and the switches; a failed
  workspace lookup showing only what the agent took.
- `test/app.test.tsx`, 2 new: the switches and Find; the form's words,
  focus on Cancel and its answer.
- Changed for this unit: a room refusal is `try_again`; agents' restores
  off now ask through the form; `mayAct` lets an agent restore what it took
  on a box it runs on; unit 4's page test no longer expects no switches.

### On a separate BB

A fresh `npx bb-app` (latest) with no account, its own data folder and
ports, started with `env -i`, `HOME`, `PATH` and `BB_BOX_LIVE_CHECKS=1`,
in a Proxmox LXC box, with bb-box installed from this branch
([`live-setup.sh`](070-snapshots/unit-5/live-setup.sh)). The lead gave it a
Proxmox LXC backend with production's template on LVM-thin and its own
VMIDs. dev-desk was a machine of the person's (`bb box machines add`), and
the thread "Asks" ran on it, on a scripted ACP agent
([`acp-agent.mjs`](070-snapshots/unit-5/acp-agent.mjs)) that calls bb-box's
tools as an agent would and runs shell commands in its own process. Forms
were answered in BB's app, in headless Chromium
([`form.mjs`](070-snapshots/unit-5/form.mjs)). The node is written pve-1.

**G11, the form** (restores of boxes threads run on turned on with the
live-check switch):

| Check | Result |
| --- | --- |
| Off (the default): `box_restore` of dev-desk | refused: "Box dev-desk is a box threads run on: "Asks" (working) runs on it. ... bb-box does not restore such a box yet ... bb-box changed nothing." No form |
| On: `box_restore` of dev-desk | the form opened; the agent got BB's own notice, "The request is shown to the user. A successful result will arrive separately. Do not ask again or assume an answer. ..." The form named "Asks" with its worktree, files and session, said the thread's session goes back too, and named the undo |
| Cancel in the app | "bb-box did not restore box dev-desk: ... Nothing changed." reached the thread as a message and started a turn; the file written after the snapshot stayed |
| A stop of the thread | the form went, nothing was restored, and nothing more reached the thread |
| BB's server restarted (its process killed, BB's supervisor started it again) | the form went, nothing was restored |
| Restore in the app | restored with its undo first: `restore-asked`, the undo in 0.3 s, `restored` in 47 s (stop 1.2 s, undo 0.3 s, rollback 0.4 s, start 45 s, access 0.5 s), each "on a yes given in "Asks" (thr_...)"; the file written after the snapshot was gone; the result started a turn on the restored box, in a fresh session |
| A BB terminal opened on dev-desk after the form, then Restore | nothing restored; the form came again, `changed`, adding "a BB terminal is open on it" |
| No room for the undo (room set to 50%, the pool 53% full) | refused before any form: "bb-box would take an undo of box dev-desk before restoring it, and pve-1's storage local-lvm is 53% full ...", with "This holds only for now"; nothing changed |
| "Agents may restore their own boxes" off, on the agent's own box bold-cloud | the form, "Settings turn agents' own restores off"; Restore in the app restored it with its undo, "on a yes given in "Asks"" |
| Timeout | after 10 minutes BB ended the form (`interrupted`, reason `timeout`); the agent was told "nobody answered the form within 10 minutes. Nothing changed.", and the box was as it was |
| The asking agent answers its own form: `bb thread interactions list --self --json`, then `bb thread interactions respond <id> --self --value '{"restore":true,"plan":"..."}'` | `bb` was on the agent's path, and the list gave it the form's whole payload, plan included. BB said "Interaction ... answered". bb-box restored bold-cloud with its undo and logged it "on a yes given in "Asks" (thr_...)", word for word as for the app. BB's own record of the form says `plugin_submitted`, with nothing of who answered. Recorded in request 38 |

**G12**: a second thread on the same BB, "Guesses", given the first
thread's snapshot IDs and names: `box_snapshots` of the first thread's box
said it has no such box; of dev-desk, which it also runs on, "No
snapshots, and 4 you cannot see"; `box_snapshot_delete` and `box_restore`
by ID and by name said "That box has no snapshot ..." or no such box.
Nothing changed. Pictures come with unit 6; `mayAct`'s `see-picture` is
tested above.

**G17, the turn hold.** Each case restored dev-desk by the person's
command, with a live-check hold at the step named, and a message to "Asks"
during it; "Send now" is `bb thread queue send`
([`g17.sh`](070-snapshots/unit-5/g17.sh), sampling the box, the thread,
its queue and the machine each second).

| Case | Result |
| --- | --- |
| A message while dev-desk is held stopped | at first BB refused it: "The "bb-box" plugin's message.dispatch hook failed: returned an invalid decision: reason Too big: expected string to have <=200 characters". Fixed to a shorter reason; then it was queued, "waiting on bb-box", and ran on the restored box only after it was ready |
| "Send now" while the box is stopped | BB refused it: "This message cannot be sent yet: the "dev-desk" host is not ready" (HTTP 409); it stayed queued. bb-box's recheck when the restore ended did not send it, as BB had tried it seconds before, at the machine's reconnection; fixed with `sendAt`, it ran 23 s after the box was ready |
| "Send now" after the last check, before the stop (held 25 s at `checked`) | **the turn started** on the running box; bb-box's stop then interrupted it ("Thread interrupted because the host daemon disconnected"); the check after the stop found it, and bb-box started the box again: "a turn runs on it now ... Nothing on its disk changed, and bb-box started box dev-desk again as it was." No disk was replaced under a turn, but a turn ran on a box bb-box was stopping |
| "Send now" while the restored box reconnects (held 25 s at `started`) | BB's daemon on dev-desk had reconnected by itself during the boot, so the turn started about 25 s before bb-box called the box ready. The rollback was done and the access file written; the steps left (reading the size, Proxmox's labels, BB's reconnect) did not interrupt it. It did not wait, but no disk changed under it |
| bb-box restarted mid-restore (`bb plugin reload bb-box`, held at `stopped`) with a message held | the message stayed held through the reload; bb-box finished the restore from the step it reached and the message ran when the box was ready. BB's orphan sweep releasing held rows was not seen in a reload this short |

### After the reviews

Two independent reviews read the commit at `1942c189`: Astra (merge after
fixes, six findings) and Opus (merge after fixes, nine findings, having run
the unit's tests on a box). Every finding below is fixed, with a test,
except where it says otherwise.

| Finding | From | Fix | Tests |
| --- | --- | --- | --- |
| A yes given while the route was the form could restore another snapshot after a rename and a settings change, as the tool looked the name up again and a direct route skipped the plan's check | Astra 1 | The restore after a yes names the snapshot by the ID the form showed, and a yes is checked against the plan on any route; a stale one restores nothing | `snapshot-agents.test.ts`: "a yes is checked against the plan wherever the restore's route now goes" |
| When BB could not say where the thread runs, its own box counted as one it does not run on, showing the person's and other threads' snapshots | Astra 2, Opus 4 | One check, `runsOnBox`, for the snapshot tools and `box_status`: a failed lookup counts as running on it | `plugin.test.ts`: "when bb-box cannot tell where the thread runs ..." |
| With agents' own restores off, the form let an agent past a person's desktop control or a terminal, which the direct route refuses | Opus 1 | The form agrees to what goes only on a box threads run on; on the settings route, control and terminals refuse as before | "with agents' restores off, the form does not let an agent past ..."; live, below |
| The limit never replaced an agent's snapshot on one of the person's machines, as such snapshots are the person's by owner | Astra 5, Opus 2 | The limit goes by who took it: an agent's, unkept, not an undo; the room sweep still spares the person's | "an agent's take past the limit on one of the person's machines ..."; the 1a rule test; live, below |
| A restart between a take and its replacement left the box over its limit | Astra 4 | The take's operation records the snapshot it replaces and stays unsettled until it is gone; recovery finishes it | "a take that was to replace one past the limit finishes the replacement after bb-box restarts" |
| What goes was agreed by its words, so a new thread with the same title counted as agreed | Opus 3 | Each loss has a key, a thread's by its ID, and the operation keeps the keys; the plan's digest hashes the keys and the box's snapshots, so a new snapshot asks again too | "what goes is agreed by each thread's ID ..."; the plugin's changed plan is now a snapshot taken meanwhile |
| A form's hold that ended with no restore on the box did not ask BB to send the held messages | Opus 5 | `release` asks BB at once when no restore marks the box | "the turn hold asks BB again when a form's hold ends ..." |
| A restore bb-box could not confirm held the machine's messages with words that said it was restoring | Opus 6 | The hold stays, and says "bb-box could not confirm its restore of box ..., so this message waits. bb box doctor says why." | the same test |
| `try_again` for a full storage, which does not clear by itself | Opus 7 | Kept, as the brief asks, with a hint that it works once what it names changes, such as snapshots deleted, and not to retry in a loop | |
| A ceiling for a backend that is gone could not be unset | Opus 8 | The backend is checked only when setting one | "bb box option unsets a ceiling whose backend is gone" |
| A refusal after a yes came back as an error, which BB only steers in, so an agent that had ended its turn would not hear it | Opus 9 | It comes back as a plain result, which starts a turn | |
| Words: the tool's description and the skill said a box threads run on goes through the form; the guide said an agent restores only its thread's own snapshots on its own box | Opus | Both now say such restores are off for now; the guide gives section 3's row | |
| The form waits on the asking thread's own turn | Astra 3 | Not changed: live, BB's notice ended the asking turn and the thread was idle (`bb thread show`) while the form waited, and every yes from the app restored | |
| A name taken by a snapshot the agent cannot see gives its new one " (2)", which tells it the name exists | Astra 6 | Not changed: names are unique per box in `snapshots.db`. Recorded below | |

Live again, with bb-box reinstalled from the fixed commit on the same
separate BB:

| Check | Result |
| --- | --- |
| Agents' own restores off, a BB terminal open on the agent's own box | refused before any form: "Restoring box bold-cloud to "one" would end what is on it now: a BB terminal is open on it. Ask the person to end it first ..." |
| The same, the terminal closed, Restore in the app | restored with its undo, "It was restored on a yes given in this thread." |
| Snapshots per box set to 2 on dev-desk, which held the agent's "before the upgrade" and a command's "g17 base" | the agent's take "limit check" was ready, and "The box was at its limit of 2, so bb-box deleted the oldest snapshot an agent of this thread took and nobody kept: "before the upgrade"." The command's stayed |

At the end bb-box on the separate BB listed no box and no snapshot.

### Gates

| Gate | Result |
| --- | --- |
| G11 form | **Passed** with the live-check switch on: the form, cancel, a stop of the thread, a BB restart, the yes from the app with its undo, a changed loss list, no room for an undo, and the agent's own box with its restores off, each as the gate says, and the timeout. The asking agent's own answer is taken as a yes, as 070 expected, and recorded |
| G12 permissions | **Passed** live and in the tests, pictures apart (unit 6) |
| G17 turns held | **Not passed**: "Send now" after the last check and before the stop runs a turn on a box being stopped. So restores of boxes threads run on ship off, as 070 and the lead say, until BB can hold a machine against "Send now" (request 39) |

### Choices and deviations

- **Restores of boxes threads run on ship off**, on the page (unit 6), the
  form and the command line. The form, the hold and the checks are built
  and tested, and work under the live-check switch.
- **The yes is recorded on the asking agent's operation**, not as an actor
  of its own; the undo's record names the agent (Decided during unit 5).
- **A wait of up to a minute** for turns on the box to end after a form's
  yes, so the asking agent can end its turn.
- **A check just after the stop** besides 070's checks before the stop and
  before the rollback; it is what caught G17's third case.
- **The hold's reason** names the box but not the snapshot, to keep within
  BB's 200 characters.
- **`box_snapshots` has no `pictures` parameter** until unit 6; `box_fork`
  comes with unit 7.
- **A memory snapshot with agents' memory restores off is refused**, not
  asked for through the form.
- **The form's restore by the asking agent's own answer** cannot be told
  from the person's; bb-box says "a yes given in the thread" everywhere, as
  070 says.

### Known limits

- **A hidden name shows as taken.** An agent naming its snapshot as one it
  cannot see on the same box gets " (2)", which tells it such a name
  exists. Names are unique per box in `snapshots.db`; making them unique
  per audience needs a migration. Names only, never their snapshots.

### Conditions and open questions

- **Restores of boxes threads run on** need BB to hold a machine against
  "Send now" (request 39) before G17 can pass.
- **An actor for a yes given in a thread**, so the undo's record says it
  too, needs new rows in `snapshots.db` and the box log's store; worth it
  with request 38, when BB can say who answered.
- **BB's recheck** did not send a held message that BB had re-tried
  seconds earlier; bb-box relies on `sendAt` 15 s ahead.

## Unit 6: the box page's Snapshots card

Built on 31 October 2026 on main `e55c35f4` (units 0 to 4 included), and rebased onto `9ac74968` (unit 5).

### What changed

- **The card**, `src/app/snapshots-card.tsx`, a component of its own, after
  Activity and before the facts on a box's page. Its heading says "2 of 5,
  and 1 undo · disk · on pve-1"; each row has the picture, the name with
  Memory, Kept and Undo badges, then what needs attention first (a failure,
  incomplete, unavailable, lost, an earlier guest), when, by whom, the size
  and any price, the undo's restore, and the note. Restore and the row's
  menu show on hover or focus on a desktop and always on a narrow or touch
  screen. The footer says what snapshots hold and that they go with the
  box. A box whose backend has none says so, with no Take snapshot.
- **Its data comes with the page.** `boxPage` gains `snapshots`, built in
  `src/plugin/snapshot-card.ts` from bb-box's records, so the card is laid
  out in the page's first frame and nothing in it moves when data comes.
  What a take would refuse now (the lock with the host's command, the
  token's rights, the limit, the room, the ceiling) is read from the
  backend's plan by `checkTake`, kept 30 s and read again when the box's
  snapshots or state change, at most 2 s per read; the card then says why,
  and Take snapshot is off in the card and in the header's menu.
- **Take snapshot…**, in the card and in the header's menu after Resize….
  Its dialog asks for a name (the time if empty) and a note, and "With its
  memory" where the backend gives the choice. It reads the plan when it
  opens and says what the snapshot holds and leaves out, the time, the
  space a memory snapshot takes, the count after it, whether a picture is
  kept, and the price or "no charge".
- **The restore dialog** reads `snapshot.restoreCheck` when it opens: the
  restore's check, as `--check` gives it, and the guard as data. It names
  every thread on the box, working or idle, a person holding its desktop,
  and each terminal. A box threads run on is refused, saying why, with
  every thread, the control and the terminals named and no Restore button:
  restores of execution machines stay off (G17). Control and terminals are
  listed under "Also goes", and the button says "Restore (box) anyway". The
  undo is ticked; unticked, the button is red, "Restore without undo".
  When room or the ceiling refuses the undo, the dialog says why and leaves
  it unticked, so the person can restore without it, as `--no-undo` does.
  It says the size the box goes back to, and on a swap what stays on the
  earlier guest.
- **Notices**, with 069's: while a restore runs, which part it is at
  (bb-box now signals the page at each part); after it, for 24 hours,
  "Restored at 04:15 to "one", taken today at 04:01, by you. Undo restores
  "before the restore at 04:15"", with Undo… and Dismiss (remembered in
  the browser); and a restore bb-box could not confirm, with Check now,
  which settles snapshot operations as the sweep does. A polite live region
  says the restore's progress and result.
- **Rename…, Note…, Copy ID and Delete…** in each row's menu.
  `Snapshots.rename` and `annotate` check `mayAct` and `eligible` before
  queueing and again on the box's queue, so a restore's target is refused
  at once and named, not renamed after the restore. A name is unique per
  box. Delete says what it frees ("Frees what it no longer shares with
  snap-lxc." on LVM-thin), whether it was kept, and whose undo it is.
- **Pictures.** At each take, and for a restore's undo before the box
  stops, bb-box keeps a picture of the screen of a box that has one: a
  JPEG at most 320 px on its longest side, quality 70, encoded by bb-box
  (`src/core/jpeg.ts`, baseline with halved colour; no new dependency).
  A desktop's comes from its computer-use driver (`Computer.screenPicture`,
  read-only, which works while a person holds the desktop), a device's from
  its device server. It waits at most 2 s, beside a live disk take or
  before a pausing or memory one, and a picture that fails or is late is
  recorded as `failed` and never fails or slows the snapshot. Pictures are
  in `snapshots.db`'s `snapshot_pictures`, capped at 48 MB, the oldest of
  snapshots nobody kept going first, and deleted with their snapshot. They
  reach the page through `snapshot.picture`, after `mayAct`'s
  `see-picture`, never by URL. A tile is 64 by 40 px (48 by 30 at 390 px);
  it opens the picture at its full size in a popover.
- **The pictures setting** comes onto Settings, Snapshots, in a Pictures
  group, as a switch that saves at once, and into Find. The configuration
  reference no longer says "Not used yet" for it.
- **The guard counts bb-box's own terminals.** A terminal opened from a
  box's page is bb-box's, not BB's, and a restore ends it too; the guard
  counted only BB's. It now counts both, so the dialog, the CLI and the
  box log name it.
- **RPC**: `snapshot.takeCheck`, `take`, `restoreCheck`, `restore`,
  `delete`, `rename`, `note`, `picture` and `settle`, each as the person.
  A change answers once done, or after 3 s with `pending` while it goes on
  as bb-box's own operation; the page follows it through the box's changed
  signal.
- **Keyboard and focus.** Each dialog starts on its safe choice: Cancel in
  Restore and Delete, Close when refused, the name in Take snapshot and
  Rename, the note in Note. Each gives focus back to the button that
  opened it, or for one opened from a menu, to the menu's button.
- **Docs**: the guide's [Snapshots](../guide/snapshots.md#on-a-boxs-page),
  its settings table, and the reference.

In the same commit, at the lead's request, outside unit 6's own scope (a commit of its own until unit 5's restore changes wove it into the card's):

- **The restore flushes the box's writes before its hard stop.** On
  Proxmox QEMU the hard stop dropped what the guest had not written to its
  disk yet, so a restore's undo could miss the last seconds before it.
  Before the stop, bb-box now runs `sync` in the box over its command
  transport (Write-VolumeCache on Windows), for at most 15 s. If that
  fails, the restore stops before the box does unless the person accepts
  an undo that may miss the last writes (see After the review, 3). The
  QEMU guest agent's freeze and thaw are not used: no bb-box path reaches
  the guest agent yet, and `sync` alone was enough live (below).

### Tests

On a Linux box, 8 cores, 16 GiB, Node 24.21, in a fresh copy of this
branch on main `e55c35f4`, with the next commit: `npx tsc` passes and the
reference is current; the node suite ran 3,108 tests, 2,819 passed, 1
failed, 288 skipped (the live and conformance ones); vitest ran 392, all
passed. The node suite includes the docs, site and reference checks. The
one failure, a Tart image test timing out at 31 s, is in a file this unit
does not touch, and passed 3 times in 3 when its file ran alone.

- `test/snapshot-page.test.ts`, 9: the JPEG's markers and sizes, wide,
  tall and not a multiple of 16; a take's picture, seen by the person and
  the box's agent and not by another thread's; pictures off and a headless
  box; a failing and a late picture (aborted at 2 s) with the take still
  ready; the undo's picture taken before the stop; the 48 MB cap sparing
  kept ones; rename and note, unique names, limits, the agent refused, a
  restore's target refused and named at once; the take check refusing as
  a take would and changing nothing, and its cache; the page's view
  (newest first, counts with undos apart, the notice for 24 hours with its
  undo, restoring, and an unconfirmed restore after a restart); the
  restore preview naming threads, control and terminals, and a refused
  undo leaving the restore to the person without the CLI's flag in its
  words.
- `test/restore.test.ts`, 1 new: the flush runs before the power-off and
  the undo; a failed flush leaves the restore going and says so on the
  undo.
- `test/app.test.tsx`, 8 new: the card's place, words, badges and the
  header's menu item beside Resize…; Take snapshot's words, focus and the
  take sent; a refused take and a backend with none; the guarded restore
  naming every thread, the control and a terminal, with no Restore button;
  Restore anyway and without undo; the restored, restoring and unconfirmed
  notices, Undo… and Check now; Delete, Rename and Note with focus; the
  pictures switch and Find. Unit 4's tests now expect the pictures switch.

### On a separate BB

A fresh `npx bb-app` 0.48.1 with no account, its own data folder and
ports, started with `env -i`, `HOME`, `PATH` and `BB_BOX_LIVE_CHECKS=1`
only, in a Proxmox LXC box, with BB's machine access direct so boxes
enrol. bb-box installed from this branch with `bb plugin install path:`.
The lead gave it a Proxmox LXC and a Proxmox QEMU backend on LVM-thin with
the CPU desktop templates. Two machines of the person's: `snap-lxc` (LXC,
2 cores, 4 GiB) and `snap-vm` (QEMU, the same). The page was driven in
headless Chromium with the keyboard only, by the scripts in
[070-snapshots/unit-6](070-snapshots/unit-6/); the node is written pve-1.

| Check | Result |
| --- | --- |
| The page does not move when the card's data arrives | the card is in the frame where the heading first appears (334 ms after navigation), 129 px high, and its height never changed in 8 s. The one later move is Activity (069) growing from 143 to 775 px at 678 ms when its readings come, which moves everything below it (CLS 0.134); 069 unit 3 lays that out from the first frame, and this is to be measured again on it |
| Take from the card, LXC, keyboard only | Take snapshot reached in 11 Tab presses; focus started in Name; "It holds the disk: files, installed apps and settings. About 1.0 s; snap-lxc keeps running. 1 of 5 for snap-lxc after this. A picture of its screen around now is kept with it. No charge: it is on the host's own storage."; ready 0.8 s after Enter; picture taken; focus back on Take snapshot |
| Take from the header's menu, LXC | the menu's button reached in 35 Tab presses, Take snapshot… by the arrow keys; ready 1.1 s after Enter; focus back on the menu's button |
| The picture | 320 by 180, 2.2 KB for an empty desktop; opened from the keyboard at its full size; with a terminal and an editor open, the tile and the popover show both windows |
| Restore and undo, LXC, keyboard only | Restore reached in 4 Tab presses, focus on Cancel; restored to "one" in 48 s to the notice (stop 1.2 s, undo 0.4 s, rollback 0.9 s, Proxmox's start 45 s, as unit 3 measured for a snapshot taken running); `~/state.txt` said "one"; the live region said "snap-lxc was restored to "one"."; Undo… reached in 30 Tab presses, Escape closed its dialog back to Undo…; the undo took 5.0 s and the file said "three" |
| Take with memory, QEMU | "With its memory" ticked by Space; "Up to 8.5 GiB more on pve-1's local-lvm. About 5.0 s"; ready in 3.0 and 2.8 s, Memory badge |
| Restore of a memory snapshot, QEMU | 32 s to the notice; the file said "one"; "snap-vm comes back running, as it was then, with the credentials its apps held then" |
| The undo after a restore, QEMU, before the flush | a file written just before the restore, without `sync`, was missing after its undo; with `sync` first it was there |
| The same, after the flush | `echo nosync > ~/f1`, a restore at once, then its undo: `f1` said "nosync", on QEMU and on LXC; the undo had no note |
| A guarded restore, LXC: two threads on its BB machine (a no-model ACP agent, one holding its turn, one idle), a person holding its desktop in another tab, and a terminal open from its page | the dialog refused with focus on Close and no Restore button, naming "Fix the sign-in flow is working on snap-lxc: ...", "Write the API guide is idle on snap-lxc: ...", "A person has control of its desktop." and "A terminal is open on it." |
| The same with the threads archived | "Also goes:" the control and the terminal; "Restore snap-lxc anyway" restored in 53 s; `restore-asked`: "... restored anyway, though a person holds control of its desktop, and a BB terminal is open on it."; the desktop's control went back to the agent |
| 390 px | the header's actions on a row of their own under the name; row actions always shown; tiles 48 by 30 |

Before the guard counted bb-box's own terminals, the first guarded run
named the threads and the control but not the page's terminal, and the
restore ended it: that run found the gap fixed above.

Screenshots at 1,440, 760 and 390 px in light and dark, of the page, the
card, Take snapshot, the restore dialog, the guarded dialog, restoring and
the picture, are in the unit's thread storage, not in the repository.

### Choices and deviations

- **Fork and Keep are not on the card** (units 7 and 8), so the footer
  does not say "unless kept" yet, and rows have no Fork button or Keep…
  item: no dead controls.
- **The viewer's last frame is not used for pictures.** 070 asks for it
  when a viewer was open within 10 s; bb-box's server has no decoded frame
  (the browser decodes them), so every desktop picture comes from the
  computer-use driver, which reads the screen while a person holds it.
- **No toast when the person is not on the box's page.** The page's
  restores answer on the page; an agent's restores come with unit 5.
- **Row lines on the box's page** follow 070's box-page sketch (when, by
  whom, size, price, life when kept), not the Snapshots tab's, which also
  says what each holds: the card's heading says it once.
- **A restore's notice can be dismissed**, as the prototype has it; the
  choice is kept in the browser.
- **Resizing the window across BB's narrow layout** remounts BB's panel,
  which closes an open dialog and focuses the page's heading. That is BB's
  layout, not the card's; it showed in the screenshots, which open each
  dialog after resizing.

### After the review

A review found nine things; each is fixed, with a test. After the fixes
and the rebase onto unit 5 (`9ac74968`), on a Linux box in a fresh copy of
the branch: `npx tsc` passes and the reference is current; the node suite
ran 3,135 tests, 2,847 passed, 0 failed, 288 skipped; vitest ran 397, all
passed. The PNG checks live in `snapshot-picture.ts`, not `png.ts`, which
is one of the device server's files and would need a new device server
version.

1. **A restore goes on only past what the dialog showed.** The dialog
   sends the losses it listed and a token of all it showed (the threads,
   the control, the terminals, the losses, the undo and whether it was
   refused, the size back, a swap, the guest). The server reads the
   preview again: if the token differs, it restores nothing and sends the
   new preview, which the dialog shows with "What the restore would do or
   end changed since this dialog read it". The core refuses, with what
   came since, a loss beyond those accepted ("Since you looked, more would
   go with box ...: 2 BB terminals are open on it."), so a terminal opened
   between the server's check and the restore's own is refused too.
2. **The guard is read again after the flush**, right before the stop. A
   thread that came during the flush stops the restore before the box
   stops, and nothing changes.
3. **A failed flush stops the restore unless the person accepts it.**
   The flush, getting into the box included, has 15 s. When it fails, the
   restore stops before the box does, says why, and changes nothing. The
   dialog then asks: "Restore anyway, its undo may miss the last writes";
   the CLI takes `--unflushed`; an agent cannot. When the person goes on,
   the answer, the box log, the undo's note, the restored notice and the
   undo's own restore dialog each say the undo may miss the last writes.
   The page's restore answers once the box has stopped, or after 60 s, so
   that every refusal before the stop reaches the dialog.
4. **A screen's PNG is bounded before it is inflated**: at most 8 MiB and
   2,048 px a side, inflated to no more than its size needs, its rows
   checked for length and filter. A 100 by 100 PNG that inflates to 64 MiB,
   one 40,000 px a side, one with missing rows and one with a bad filter
   are each refused, and the take goes on without a picture. With these
   bounds the decode is small enough to stay on the server's thread.
5. **A restore that fails after the RPC has answered is not lost.** The
   page shows a failed restore for 24 hours, with its reason, in a notice
   that the live region also says, until a later restore or Dismiss.
6. **The 48 MB of pictures is a hard cap.** Before a picture is written,
   the oldest pictures of snapshots nobody kept go until it fits; if
   kept ones alone leave no room, the new picture is refused and its
   snapshot's picture is `failed`, with a log line.
7. **A restore's start keeps the page as it is.** The box is "starting"
   during a restore's start; the page no longer takes that for a box
   starting, so the card, the restoring notice and its live region stay
   mounted and in place.
8. **After a delete, focus goes to the next row's menu button**, or the
   one before it, or Take snapshot, or the card's heading.
9. **Settings' group headings are at weight 400**, the Pictures heading
   among them. Other weights of 500 still in Settings, not changed here:
   the page heading (`settings-parts.tsx`), the backend fields' and
   setup's section headings (`settings-fields.tsx`, `settings-setup.tsx`,
   `settings-backend-fields.tsx`), the first-run headings
   (`settings-first-run.tsx`), the project images' heading
   (`settings-images.tsx`), the overview's "things need you" and machine
   names (`settings-overview.tsx`, `settings-machines.tsx`,
   `settings-docker-hosts.tsx`), a backend check's name and state
   (`settings-backend-page.tsx`), the box files' heading
   (`settings-files.tsx`) and the configuration's group labels
   (`settings-configuration.tsx`).

## Unit 7: forks on Proxmox

Built on 31 October 2026 on main `b1bf22db` (units 0 to 6 included), and
rebased onto `aa192bdf`. What was decided while building it is in 070's
[Decided during unit 7](070-snapshots.md#decided-during-unit-7).

### What changed

- **The backends.** Proxmox LXC and Proxmox QEMU offer `fork: copy` for
  their Linux kinds, and their plan says whether a snapshot forks now: not
  without `VM.Clone` on the pool, under a lock or a running task, on a QEMU
  box kept suspended to disk, or when the snapshot is missing or part-made;
  otherwise the size it holds, read from its config, and the copy's time and
  space at most. `forkSnapshot` (`src/backends/proxmox/forks.ts`) claims a
  VMID of the box range, records the guest before the clone, copies the
  snapshot in full (`snapname`, `full: 1`) onto the source's storage,
  and in one step re-arms it: `onboot` 1, every link up, a new MAC address
  on every card, the address of its own VMID, the snapshot's cores and
  memory, the new box's tags, and on QEMU a new SMBIOS UUID with its own
  address in it. The VMID stays reserved until then, so the box sweep never
  takes the copy, whose copied tags still name its source, for a leftover.
  A failed copy is deleted; a copy cut short by a restart is deleted before
  the copy is made again.
- **The fork's box** (`Boxes.fork`, `src/core/boxes.ts`): a new record with
  its origin (`fork`: the operation, the snapshot, the source and its MAC
  addresses), checked against the thread's box limit, the name and the
  backend's room, and made through the acquire path. Its copy runs on the
  source box's queue. Then bb-box starts it with the backend's `start`, and
  **checks it before it is ready** (`forkVerdict`, `src/core/identity.ts`),
  through the backend's own command transport, so before bb-box writes any
  access file there: the identity reset's status, the marker's MAC
  addresses, BB's folders under `/home/*` and `/root`, the access files,
  Tailscale's state, the machine ID and the SSH host keys. Only then does it
  write the fork's own marker, call it ready and enrol it as a new BB
  machine. A fork that fails the check is released and fails, saying why
  and "nothing of it acts as (source)". `boot=unknown` and a pending reset
  are looked at again every 2 s for a minute.
- **What a take records.** With `forkSafe`, a take keeps the SHA-256 of the
  box's machine ID and of each SSH host key's key on the snapshot's record
  (`identity`, a new column in `snapshots.db`, by migration), read by the
  same command as `forkSafe`.
- **The engine** (`Snapshots.fork`, `checkFork`, `forkEnded`,
  `src/core/snapshots.ts`): `mayAct`'s fork row; the snapshot `ready`, of a
  living box, of the box's own disk (not a device or a held copy), of a
  Linux box, with `forkSafe`; the backend's plan. The operation is recorded
  before the box, pins the snapshot, and is settled by the fork's box: done
  when it is ready, failed when it fails or goes, left while it starts,
  also after a restart. A repeated `request` gives the same fork.
- **`box_fork`** (`box`, `snapshot`, `name`): into the agent's own thread;
  with no snapshot it takes one of the box now, "for a fork", first. It
  answers as `box_acquire` does, with the fork's origin among its facts.
- **The CLI**: `bb box snapshot fork <box> <snapshot> [--as-machine]
  [--name <name>] [--check] [--request <id>] [--json]`; with
  `BB_BOX_LIVE_CHECKS=1`, `hold-next --at forked` holds a fork after its
  copy is re-armed, before its first start.
- **The page.** Each row of the Snapshots card has Fork after Restore, in
  the row's menu as Fork… below 640 px, off with why where the snapshot
  cannot fork. The Fork dialog asks for the name and, for a thread's box,
  whether the fork goes in its thread or among your machines; it says what
  the fork holds, its size, and the copy's time and space at most; Fork
  opens the new box's page. A fork's page says "Forked from (source),
  (snapshot) ((when))" under Made. `snapshot.forkCheck` and `snapshot.fork`
  are new RPCs.
- **Docs**: the guide's [Forking a snapshot](../guide/snapshots.md#forking-a-snapshot),
  the skill's words for `box_fork`, the reference, and 070's notes.

### Tests

On a Linux box, 8 cores, 16 GiB, Node 24.21, in a fresh copy of this branch
over main `aa192bdf`: `npx tsc` passes, and the reference is current; the
node suite ran 3,184 tests, 2,896 passed, 0 failed, 288 skipped (the live
and conformance ones); vitest ran 414, all passed. The node suite includes
the docs, site and reference checks; they ran again on the last docs.

- `test/forks.test.ts`, 7, through `Boxes` and the fake provider, whose
  forks copy the snapshot's files and run the real `bb-box-identity` on a
  root of their own with a new MAC address: a fork resets, is checked, gets
  its own marker and the snapshot's file, and its source keeps its BB
  machine, marker, machine ID and keys; a fork given its source's name, as
  one of your machines, after the same name was refused in the thread; the
  snapshot pinned while the copy runs and free after; the take's hashes on
  the record; the box logs. A fork whose first boot did not reset is never
  ready: its source's MAC address, its image's reset off, and a boot that
  could not tell, each released with why. A late card held until `settle`
  resets it, then ready. A snapshot without `forkSafe` refused with the
  words, nothing copied. An agent forks its own box into its thread, never
  one it runs on, another thread's, or as your machine; the check changes
  nothing; a repeated request. A refused plan and a failed copy. Recovery
  after a restart: done once ready, failed once released.
- `test/proxmox-lxc-snapshots.test.ts` and
  `test/proxmox-qemu-snapshots.test.ts`, 3 more: the clone of the snapshot,
  recorded before it, re-armed with `onboot`, links up, a new MAC, its own
  address, its labels, its source untouched, the sweep never seeing the
  half-made copy as its source's; a failed copy and a missing snapshot; a
  half-made fork deleted after a restart and another guest never; on QEMU a
  new SMBIOS UUID with its own address, no saved memory, and Windows
  refused.
- `test/plugin.test.ts`, 1: `box_fork` takes "for a fork" first and refuses
  a snapshot without a working reset, as the CLI's `--check` does; another
  thread finds no such box.
- `test/app.test.tsx`, 3: the dialog's words, focus on the name, the choice
  of where it goes, Fork sent with them; Fork off with why; a fork's facts.

The test box's `better-sqlite3` binary, installed while npm 11 held back
install scripts, crashed at the end of files that use it, on `origin/main`
too; with the build from another box of the same image, every file ran.

### On a separate BB

A fresh `npx bb-app` 0.48.1 with no account, its own data folder and ports,
started with `env -i`, `HOME`, `PATH` and `BB_BOX_LIVE_CHECKS=1`, in a
Proxmox LXC box, with bb-box installed from this branch
([`live-setup.sh`](070-snapshots/unit-7/live-setup.sh)) and
`general.identityResetBackends` set to both Proxmox backends on that BB
only. The lead lent it a Proxmox LXC backend (template 9800, and 9803, a
CPU desktop from before unit 2, without `bb-box-identity`) and a Proxmox
QEMU backend (template 9806, and 9807), on LVM-thin, with the production
token and 12 VMIDs and addresses of their own. Both Linux templates carry
version 5 of the identity reset. An agent's thread ran on the scripted ACP
agent of unit 5. Root steps ran from
[`proxmox-root.sh`](070-snapshots/unit-7/proxmox-root.sh), which the lead
read first; the page was driven by
[`fork-page.mjs`](070-snapshots/unit-7/fork-page.mjs). The node is written
pve-1.

| Check | Result |
| --- | --- |
| The take | the agent's `box_snapshot` of its LXC box gentle-acorn (armed, `boot=unarmed` at its first boot, before its marker): `forkSafe` 5, and the record held the SHA-256 of its machine ID and of its two host keys, as read in the box |
| `box_fork`, LXC | the agent forked "set up" into fair-comet, ready 15 s after the call (copy and start 12 s): at its first boot the reset ran at 09:07:12.163, before systemd-networkd (.174) and ssh (.264): "removed BB's machine credentials and host ID (host_u4mqv4jcdv), the thread's access file and the tailnet node; made new SSH host keys and a new machine ID". bb-box's check passed and wrote its marker (its own MAC, its own box). The fork had the snapshot's file, a new machine ID and new host keys (none of the take's hashes), and joined BB as host_g2az9ezrmi |
| The source's host ID | BB's server log has one "Session opened" for host_u4mqv4jcdv, at 09:05:38, never replaced, through every fork of it; each fork had a session of its own |
| A fork given its source's name, LXC | `bb box snapshot fork gentle-acorn "set up" --as-machine --name gentle-acorn`: ready in 13 s, `boot=reset`, the same file, BB machine host_4eb9mavc7e; BB listed two machines named gentle-acorn, each with its own host ID, both connected, and the source's still had its one session |
| `--check` | "Forking ... would make one of your machines, with 2 cores, 4 GiB memory, 16 GiB disk, as the snapshot holds. ... Nothing changed." |
| QEMU, from a memory snapshot | src-vm (`boot=unarmed`, armed) with `sleep 9999` running, taken `--memory`; vm-fork ready in 22 s: the reset at 09:12:02.718, before networkd (.730) and ssh (.852); a fresh boot (up 0 minutes), no `sleep 9999`, a new SMBIOS UUID; its own BB machine. The source's second session, at 09:11:50, replaced its first after the memory snapshot's pause, 12 s before the fork booted |
| QEMU, from a disk snapshot | a file written just before the take, one flushed, and one written after `sync`: all three in the fork |
| `onboot` and links (`proxmox-root.sh config`, by the lead) | the forks 3171, 3172, 3175 (LXC) and 3177 (QEMU): `onboot: 1`, no `link_down`, MAC addresses of their own, their own addresses, their own box's tags; 3177 a new SMBIOS UUID |
| A first boot that says unknown, QEMU | held after its copy (`hold-next --at forked`); the lead removed its card at 09:16:59, bb-box started it at 09:17:26; its check said at 09:18:06 "not knowing yet whether this box is a copy ... It removes nothing", and SSH stayed down; bb-box showed it starting. The lead put the same card back at 09:18:42; `settle` reset it at 09:18:42.80, SSH started at .93, bb-box's check ran at 09:18:43.59 and wrote the marker at .64, and only then was it ready, 116 s after the request |
| An image without the unit | old-desk, from template 9803, has no `bb-box-identity`; its snapshot listed "not fork-safe: old-desk had no working identity reset when it was taken", and the fork was refused before anything was copied: "old-desk had no working identity reset when "old image" was taken, so bb-box does not fork it: ..." |
| A restart mid-fork | held after its copy at .184, then `bb plugin reload bb-box`: the copy was deleted, made again at .185 (copy 12.6 s) and checked, ready 32.5 s after the request; 0 operations not settled. The CLI that waited on it answered "is acquiring", as the reload ended its wait |
| The page, 1,440 px, keyboard only | gentle-acorn's page: Fork reached in 14 Tab presses, focus on the name, the default "In (thread)", Enter on Fork: the new box's page opened 0.9 s later, starting; jolly-tundra was ready in 11.5 s, its facts "Forked from gentle-acorn, "set up" (today 09:06)" |
| The page, 390 px, keyboard only | src-vm's page: the row's menu, a sheet at that width, reached in 13 Tab presses, then Fork…; the dialog on the name, "It becomes one of your machines."; the new box's page 0.9 s after Enter; page-fork ready in 19 s, with its origin in its facts |
| Permissions | a second thread's agent: `box_fork` of the first thread's box said "This thread has no box "gentle-acorn""; the first thread's agent of one of your machines: "This thread has no box "src-vm"" |

Afterwards every box and snapshot of the separate BB was released or
deleted, and the lead's `leftovers` listed no guest of the install in the
lent VMIDs.

### Gates

| Gate | Result |
| --- | --- |
| G14 fork-identity, unit 7's part | **Passed** on Proxmox LXC and QEMU: each fork reset at its first boot before its network, SSH and BB's daemon, also one given its source's name; each started with `onboot` set and its links up; the source's host ID never had a second connection from a fork; a snapshot from an image without the unit refused to fork; a fork whose first boot said unknown was not handed over until it reset, on QEMU and, after the changes above, on LXC. One LXC late-card run before those changes took its source's address, which cut the source off BB for 40 s and made it open a session of its own again; a fork that holds its source's address is now refused, and version 6 keeps a late card from taking it. A logged-in tailnet node was not part of these checks: unit 2 proved the reset removes one, and the check refuses a fork whose Tailscale state still holds a node |

### Choices and deviations

- **`forkSnapshot` takes the previous guest**, as `acquire` does, so a fork
  cut short by a restart deletes its half-made copy; and it returns the
  guest stopped, for core to start and check (070 sketched neither).
- **The check compares hashes the take kept** (Decided during unit 7);
  snapshots taken before this unit fork with that comparison left out.
- **`--as-machine`**, not `--machine` or `--thread`, which already name
  where the source box is; forks into another thread stay later.
- **A fork has the snapshot's size**; no larger size is offered.
- **The copy runs on the source box's queue**, so its take, restore, stop
  and release wait for it.
- **bb-box's authorized key** is the template's on Proxmox, the same in
  every box of an install, so a fork's is as much its own as any box's.
  Keys a person or agent added to `authorized_keys` come with the disk.
- **The copy's time is an upper bound**: 2.4 s for each GiB of the disk,
  unit 3's rate for a held copy. It said 38 s for 16 GiB disks; the copies
  took 12 to 16 s with about 2 GB used.

### Takes flush first

The live check found that a fork of a QEMU memory snapshot lacked what the
VM had not written to its disk: vm-fork's reset found no BB machine to
remove, as the source's credentials, written 18 s before the take, were not
yet on its disk. Proxmox saves memory instead of freezing the file system,
and a fork starts from the disk only. At the lead's request:

- **Before a take of a running box**, bb-box runs `sync` in it, as unit 6's
  restore does before its stop, with the same helper and 15 s limit, on
  Proxmox LXC and QEMU, disk only and with memory alike. A stopped box has
  nothing to flush.
- **A flush that fails or times out stops nothing.** The take goes ahead,
  and its record keeps why (`unflushed`, a new column in `snapshots.db`, by
  migration). The take's answer says "bb-box could not flush the box's
  writes to its disk before it (why), so it may miss what was written in
  the last seconds before it"; the list and the page's row say "may miss
  its last writes"; `--check`, the Fork dialog, the fork's answer and
  `fork-asked` say the fork may lack them too. A restore's undo whose flush
  failed records it the same way. Keep comes in unit 8 and is to say it
  too.

Tests, in `test/take-flush.test.ts`, 3: the flush before each take, disk
and memory, and none for a stopped box; a failed flush, the take ready
and its record, answer and list words; a flush that never answers holds a
take 15 s at most. In `test/forks.test.ts`: the words of `--check`, the
fork's answer and `fork-asked` for an unflushed snapshot. Two unit 1a tests
that restarted bb-box 20 ms into a take now wait for the take's hold, as
the flush comes first.

Live, on a second separate BB set up as the first, with the same lent
backends: src-vm (Proxmox QEMU, armed) joined BB, whose credentials were
written at 09:59:30.82 (`host-id`) and 09:59:30.86 (`auth.json`); a file
was written at 09:59:32, and the memory snapshot taken at once, ready in
2.0 s, flushed (no `unflushed`). Its fork vm-fork was ready in 15 s; its
reset at 09:59:49 removed `host_q83i4g7zfe`, the source's machine, so its
credentials were on the snapshot's disk; the file was there too, and no
process of the source ran in it.

### A late card on Proxmox LXC, and the source's address

An LXC fork whose card came late was released at the container start's
30 s wait for SSH, before its reset could run; a VM waits 180 s. At the
lead's request, a fork's first start now waits up to 180 s for SSH on
Proxmox LXC as on QEMU (`start` takes how long to wait; only a fork's first
start asks for more). Then the live check of it found a fork that took its
source's address, and two more changes answer that.

**Live, on the second separate BB** (src-lxc a Proxmox LXC machine of the
person's, armed, at .180; the lead ran
[`proxmox-root.sh`](070-snapshots/unit-7/proxmox-root.sh) `card-late`,
which takes a held fork's card off before its first start and puts it back
75 s after):

| Run | Result |
| --- | --- |
| First try, 3171 | the script acted on the clone while Proxmox still held `lock: create`, as a full clone copies its source's `onboot: 1` at once, and `pct set` failed on the lock; nothing changed, and that fork started with its card. The script now waits for no lock and for net0 to stay the same for 5 s, which is bb-box's re-arm done |
| The wait, 3172 | started at 10:51:33 with no card; its check said "not knowing yet" after 30 s; the card came back at 10:52:50; `settle` reset it at 10:52:51.34, removing `host_w8h3gy9iwv`, src-lxc's copied machine, and refusing that machine's daemon; ssh at .37; bb-box's start waited 76.8 s for the network and handed it over, ready, joined as its own machine. **But** it held .180, src-lxc's address, beside its own .182: with no card at its start, Proxmox wrote no network file, so the copy kept its source's; when the card was hot-plugged, systemd-networkd brought up .180 before Proxmox wrote the fork's own file, at 10:52:50.877. src-lxc's daemon logged "Server heartbeat acknowledgements stopped; reconnecting" at 10:53:25 and was connected again at 10:53:37, a session of its own: BB's server shows that session from src-lxc, and the fork's copied daemon never started. src-lxc was back on .180 once the fork was released |
| The guard, 3173 | the check before ready now reads the fork's global IPv4 addresses and refuses a fork that holds its source's address (the source's address is kept on the fork's origin). The same run: refused at 11:04:48, 3 s after the card came back, "bb-box did not hand fork lxc-late3 over: it holds src-lxc's address .180, so it would take what is sent to src-lxc. bb-box released it"; src-lxc kept its session, and its daemon logged nothing then |
| Version 6, 3174 | `bb-box-identity` version 6 installed by hand in src-lxc, then a snapshot (`forkSafe` 6). At 11:14:28 the fork's boot said "not knowing yet" and "held its network settings ( eth0.network ) aside while it cannot tell whether it is a copy"; the card came back at 11:15:12; the reset at 11:15:13 removed src-lxc's machine; the fork held only .184 (the lead read lo and eth0 .184 alone 20 s later, and bb-box's check found no .180), and was handed over, ready, waiting 76.8 s for its network. src-lxc kept the session it had since 10:53:37, and its daemon logged no disconnect |

**Version 6 of the identity program** (`bb-box-identity.sh`). On Proxmox
LXC, when a boot cannot tell yet whether the box is a copy, the program
moves the `eth` cards' network files (`/etc/systemd/network/ethN.network`)
aside, to `/run/bb-box-identity/held-network`, before systemd-networkd
starts. A card added later then gets its settings only from Proxmox's
hot-plug, which writes them. Once `settle` decides, a copy drops the held
files, and the box itself gets them back if Proxmox wrote none. The reset
alone would be too late: networkd applies a file the moment the card
appears, before `settle` looks again. A VM's address comes from its SMBIOS
at each boot, so nothing is held there. Templates 9800 and 9806 carry
version 5, so the LXC template needs a rebuild before production has this;
until then bb-box's check refuses such a fork. A take now records
`forkSafe` 6 on a box with the new program.

Tests: `test/identity-reset.test.ts`, 2: an LXC copy started without its
card holds its copied file aside, so none is there when networkd starts,
and once it resets the backend's own file stays and the copied one is
gone; the box itself, its card late, gets its file back if the backend
wrote none and keeps the backend's if it did; a VM, and a copy whose card
was there at its start, hold nothing. `test/forks.test.ts`: a fork holding
its source's address is refused and released, and a fork's start asks for
180 s. `test/proxmox-lxc-snapshots.test.ts`, 1: an LXC start waits 30 s,
and a fork's first start 180 s, before it says nothing answered.

After these changes, on the same kind of box, in a fresh copy over main
`aa192bdf`: `npx tsc` passes and the reference is current; the node suite
ran 3,191 tests, 2,903 passed, 0 failed, 288 skipped; vitest ran 414, all
passed. The docs, site and reference checks ran again on the last docs.
Rebased onto main `812f78dc` (069 unit 4), in a fresh copy: `npx tsc`
passes and the reference is current; the node suite ran 3,196 tests, 2,908
passed, 0 failed, 288 skipped; vitest ran 423, all passed.
The second separate BB's boxes, forks and snapshots were removed, and the
lead's `leftovers` found no guest of its install.

### After the reviews

Two reviews read the three commits above: Astra asked for eight fixes and
Opus for two, with three more to follow. All of them are in. Where they
changed what is written above, this section is what holds now.

**A clone cannot start until bb-box arms it.** The first request after
Proxmox's clone task ends sets `onboot` 0 and every link down
(`disarm`, `src/backends/proxmox/forks.ts`). bb-box then gives the copy
its new MAC addresses, its own address and, on QEMU, its new SMBIOS UUID,
each with its link still down. Before the first start, bb-box brings the
links up (`armFork("network")`). It sets `onboot` 1 only after the check
before ready passes (`armFork("boot")`). A held copy for a restore is
disarmed by the same first request, before its labels. A reboot of the
node before the check passed would leave the fork stopped.

**Known limit: the gap before the disarm.** A full clone copies the
snapshot's `onboot: 1` and its source's network settings at once, while
Proxmox holds the clone's lock. The lock goes as the task ends, and
bb-box's disarm lands one task poll (50 ms) and two requests later. A
hookscript could close that gap, but the lead chose not to add one, for
these reasons:

- the lock covers the whole copy
- a node that reboots inside the gap starts the copy with a MAC address
  of its own, so its first boot resets it
- bb-box's recovery deletes a half-made fork when it starts again

[The node-side sampling](#the-combined-live-recheck) found the gap under
217 ms, with one 0.1 s sample in it.

**The network hold, version 7 of the identity program.** Version 6 held
an LXC copy's network files only once the boot's wait ended unknown. A
card hot-plugged during that wait made a copy that reset without holding
them, which raced Proxmox's own write. Version 7:

- holds the copied `ethN.network` files at the boot's first look, before
  it waits, when the box has no `eth` card and none of the marker's MAC
  addresses on any interface (`ip -j link`, so a renamed card counts)
- holds them in `/var/lib/bb-box/held-network`, flushed to disk, so a
  restart before `settle` decides loses nothing: the next boot's decision
  puts them back for the box itself if Proxmox wrote none, or drops them
  for a copy
- deletes the copied files if it cannot hold them; if it cannot delete
  them either, the boot fails closed, and the network, SSH, Tailscale,
  Docker, the desktop and the box user's services stay off
- never holds anything for a VM, for a box whose card is there at its
  start, or for the box itself with a renamed card that carries its
  marker's address

Template builds remove `/var/lib/bb-box/held-network` (`finalize.sh`).

**Each backend forks only from a version known safe.** An offer now says
`forkSafeFrom`: 7 on Proxmox LXC, as earlier versions can bring up a
source's address, and 5 on QEMU. A snapshot taken under an older version
is refused before anything is copied, with words that say which version
it needs. The Fork button is off with the same words. The check before
ready refuses a fork whose reset reports an older version.

**The check before ready reads everything or refuses.**

- Every observation prints a line of its own, `missing=` or `unreadable=`
  for each item it could not read, and the probe ends with `probes=done`.
  A missing end, an unreadable item, or a machine ID or host key that is
  missing or empty refuses the fork.
- A take records `forkSafe` only when the machine ID and host keys are
  whole.
- The fork must hold its own address. Reading no address at all refuses
  it, and so does any other address in the backend's box range, not only
  its source's.
- A shared MAC address, the source's address and another box's address
  refuse at once, before any wait. `unknown` and pending still wait, and
  are never taken as a reset.
- The marker must match and be armed, and the reset enabled.

**A failed clean-up is not hidden.** When bb-box cannot delete a failed
fork's guest, for example while Proxmox still holds its clone lock, it
stops the guest, keeps it on the box's record and says so: "bb-box could
not delete its guest (VMID) yet (why), so it stopped it. It tries again at
each sweep, and never hands the fork over." The operation stays unknown,
with "Its guest (VMID) is not deleted yet; bb-box tries again at each
sweep", and keeps its pin. The sweep deletes the guest later and then
settles the operation. Recovery after a restart leaves such a box for the
sweep.

**`box_fork` checks before it takes.** With no snapshot named, `box_fork`
first checks the box as a fork of it would be checked:

- who may fork it, and not a box the agent runs on
- the backend's offer and its plan for both the fork and the take
- the box's identity reset now, against the backend's minimum version

Only then does it take "for a fork". If the fork is still refused after
the take, bb-box deletes that snapshot and says so. The take's words,
including an older snapshot evicted at the box's limit, are passed on.

**Names and kept snapshots.**

- A fork's name is checked before anything is recorded, against the same
  rule as a machine's name, in core, the tool, the RPC and the dialog.
- A person's fork of a kept snapshot is always one of their machines, with
  no choice of thread, as section 3 says.

**Flush words fit the record.** `unflushed` is cut on a UTF-8 boundary,
below the column's 1,024-byte limit, so a long error in any script no
longer fails the take.

Tests, 17 new or rewritten:

- `test/forks.test.ts`:
  - the verdict table
  - an old version refused
  - a clean-up that fails and the sweep that finishes it
  - kept snapshots and bad names
  - `box_fork`'s check before the take
  - the order of copy, links up, start (180 s), check and `onboot`
- `test/identity-reset.test.ts`, 5 for version 7:
  - the hold before the wait
  - a card during the wait
  - a reboot before `settle`
  - a hold that fails
  - nothing held where nothing should be
- `test/proxmox-lxc-snapshots.test.ts` and
  `test/proxmox-qemu-snapshots.test.ts`:
  - the disarm as the first request after the clone
  - the two arms
  - a held copy disarmed before its labels
  - the offers' `forkSafeFrom`
- `test/plugin.test.ts`: `box_fork`'s refusals before and after its take
- `test/take-flush.test.ts`: a long non-ASCII flush error

On a Linux box, over main `812f78dc`: `npx tsc` passes and the reference
is current; the node suite ran 3,206 tests, 2,918 passed, 0 failed, 288
skipped; vitest ran 423, all passed. The node suite includes the docs, site
and reference checks; they ran again on the last docs.

[`proxmox-root.sh`](070-snapshots/unit-7/proxmox-root.sh) changed with
these fixes. `card-late` now waits for the fork as bb-box holds it:
stopped, no lock, `onboot` not set, net0's link down. It takes how long to
wait after the start, and puts net0 back with its link up. The new `sample`
reads the clone's config every 0.1 s until bb-box's arm. Both take several
VMIDs, as a fork's VMID is not known ahead. Before the live run, both ran
against a fake `/etc/pve` and `pct` on a box: `sample` passed a 20 ms gap
and caught a 600 ms one.

### The combined live recheck

On the second separate BB, with this build and the same lent backends.
src-lxc was a new Proxmox LXC machine of the person's, at .185, with
version 7 installed by hand. Its snapshot "v7" was recorded `forkSafe` 7,
flushed, with its identity hashes. The lead ran two commands of
[`proxmox-root.sh`](070-snapshots/unit-7/proxmox-root.sh) on the node,
after reading it:

- `sample`, started before the fork: it read the new guest's config from
  `/etc/pve` every 0.1 s, with whether it ran, until bb-box's arm
- `card-late`, with 10 s: it took the held fork's card off and put it back,
  link up, 11 s into its first boot, inside the boot's 30 s wait

The fork, lxc-v7, was held for 180 s after its copy (`hold-next --at
forked`) and became VMID 3170, at .180.

| Time | What happened |
| --- | --- |
| 12:20:50.067 | the clone's config appeared: `lock: create`, `onboot: 1`, link up, as the snapshot held |
| 12:20:57.603 to .712 | the lock went: the last locked sample, then one with `onboot: 1`, no lock, link up, stopped |
| 12:20:57.812 | bb-box held the fork; the hold comes after the disarm and the addressing |
| 12:20:57.820 | the next sample: `onboot: 0`, link down |
| 12:21:08.208 | card-late removed net0 (the fork's own MAC address and .180, `link_down=1`) |
| 12:23:57.995 | the fork ran, with no card, `onboot: 0` |
| 12:23:58.876 | the boot's first look: "held its network settings ( eth0.network ) aside in /var/lib/bb-box/held-network, as it started with no card of its own" |
| 12:24:09.229 | "this box is a copy, so it resets its identity": the card came during card-late's `pct set`, which returned at .282 with net0 back, link up |
| 12:24:09.347 | the reset removed `host_zhgynaepxa`, src-lxc's copied machine, and made new host keys and a new machine ID |
| 12:24:09.425 | systemd-networkd started, configuring eth0 with Proxmox's file for the fork |
| 12:24:09.507 | ssh started |
| 12:24:09.8 | bb-box's check passed (30 ms) and wrote the fork's marker |
| 12:24:09.840 | `onboot: 1`, the arm, the first sample with it and no lock since .712 |
| 12:24:11.604 | joined BB as `host_f63v89a5ig`, ready 200 s after the request (180 s of it the hold; network 10.8 s) |

| Check | Result |
| --- | --- |
| The hold from the first look | 0.9 s into the boot, with no card, 10.4 s before the card came |
| The reset before the network | at .347, before networkd (.425), ssh (.507) and BB's daemon (12:24:10.49) |
| Addresses | lo and eth0 .180 only; `eth0.network` said .180; `/var/lib/bb-box/held-network` gone; `boot=reset`, version 7, the marker naming the fork's own box |
| The source | src-lxc kept .185 and its one session, opened at 12:17:03.497; BB's server shows no other session and no close for its host ID, and its daemon logged no disconnect |
| No start before the arm | `onboot: 0` from .820 until the arm at 12:24:09.840, after the check passed; links down until bb-box brought them up for the start |
| The gap | one sample, at 12:20:57.712, had `onboot: 1` with no lock: the known limit above. The samples put the gap after .603 and before .820, so under 217 ms, and bb-box's hold at .812 agrees. Its expected width is one task poll, 50 ms, and two requests. The lead accepted it |

The fork's file from the take was there. Afterwards src-lxc and lxc-v7
were removed with their snapshot.

### After the re-reviews

Astra's re-review found three fixes only partly done, each shown by a
probe. Opus's re-review said merge, with one cheap follow-up. All four are
in. Each probe is now a regression test, and each test fails on the
commit before these fixes.

**A restart during a fork's first start keeps its guest** (Astra 5). When
bb-box stopped while a fork was starting, the fork's record dropped its
guest, which went on running. After the restart, bb-box copied the
snapshot again beside it. Now bb-box leaves a fork's record as it is when
it stops, guest included. After the restart, it makes the copy again only
once the old guest is deleted. On Proxmox, the backend disarms the old
guest, deletes it, and checks that it is gone. If it cannot delete it, it
makes no other copy.

**A read that fails is not a clean answer** (Astra 6). The fork's check
took grep's error, reading its Tailscale state, for "no tailnet node". It
now tells no match (exit 1) from an error (2 or more): an error makes the
state unreadable, and the fork is refused. Two more reads failed open the
same way, and now refuse:

- a failed hash of the machine ID or a host key, which gave an empty value
  that the parser dropped
- a failed read of the identity marker, which gave no MAC addresses

**`box_fork` checks room and place before its take** (Opus 2). The check
before the take now runs the fork's own admission:

- the backend's room for the box's size
- the thread's box limit
- a name the thread already has
- for one of the person's machines, the machine-name rule and enrolment

With no room, the take no longer deletes the agent's oldest snapshot for a
fork that is then refused. Room can still change between the check and the
fork. If it does, the snapshot taken for the fork is deleted, as before,
but a snapshot the take evicted does not come back.

**An abandoned clone is disarmed before each delete** (Opus's follow-up).
A fork can fail, be released or be cut off by a restart while Proxmox
still holds its clone lock. bb-box now disarms the clone, `onboot` 0 and
every link down, before each attempt to delete it:

- in the backend's own clean-up after a failed or cut-short copy
- when it deletes a half-made fork after a restart
- in core, before each release of a fork's guest, when the fork fails and
  at each sweep after

A Proxmox request waits up to 120 s for a lock, so the disarm lands as soon
as the clone task ends. If the lock outlasts that, bb-box skips that
delete, which would wait on the same lock, and tries again at the next
sweep. The disarm finds a fork's clone by its description, which names
the fork from the clone's start: the clone's copied tags name its source
until bb-box labels it.

Tests, 5:

- `test/forks.test.ts`:
  - the real check script with a failing grep, `sha256sum` and `sed`:
    each item unreadable, and the fork refused
  - bb-box stopping during a fork's first start, then recovery: the guest
    kept on the record, and deleted before the copy is made again
  - room and a taken name refused before `box_fork`'s take, with both
    snapshots still there at the limit
  - a disarm before each release of a fork's guest, at the failure and at
    the sweep
- `test/proxmox-lxc-snapshots.test.ts`: a failed copy disarmed before its
  delete, and left disarmed when the delete fails; recovery's disarm
  before its delete; `disarmFork` acting only on the fork's own guest

On a new Linux box, over main `812f78dc`: `npx tsc` passes and the
reference is current; the node suite ran 3,211 tests, 2,923 passed, 0
failed, 288 skipped; vitest ran 423, all passed. The 5 new tests, run
against the previous commit's source, all failed, each on the gap it
covers.

### Conditions and open questions

- **Rebuild the LXC template with version 7** of the identity program
  before arming Proxmox LXC. Until then no LXC snapshot forks: bb-box
  forks Proxmox LXC boxes only from version 7. A snapshot keeps the
  version it was taken under, so snapshots from before the rebuild never
  fork on LXC. The QEMU template forks from version 5 and needs the
  rebuild only to report version 7.

- **Arming production** (`general.identityResetBackends`) is the owner's
  call; until then no production snapshot is fork-safe, and every fork
  there is refused with why.
