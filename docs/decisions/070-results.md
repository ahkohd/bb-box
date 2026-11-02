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

## Unit 8: Keep

Built on 31 October 2026 on main `cf84a20a` (units 0 to 7 included). The
lead's answers are in 070's [Decided during unit 8](070-snapshots.md#decided-during-unit-8).

### What changed

- **Keep and Stop keeping**, `Snapshots.keep`, `unkeep` and `checkKeep` in
  `src/core/snapshots.ts`, with the person's rules from section 3 (no
  agent keeps or unkeeps; `mayAct` already said so). A keep date is the end
  of a UTC day: the days in Settings from today, or a date given, at most
  365 days ahead. Keep is offered only for a snapshot a fork could use
  after the release: ready, of the box's own disk, of a Linux box, taken
  with the identity reset at the version its backend forks from, on a
  backend that keeps past a release, and with a fork plan that is `ok`.
  Otherwise it is refused, and the row's Keep… is off, with 070's words:
  "Taken before old-desk's image had the identity reset: "old image" could
  not be forked after a release, so bb-box does not keep it." The check
  says what keeping costs and warns, without refusing, when a release
  would find no room or VMID for the held copy at today's size. Keep and
  renewal pass the ceiling's rule (`keep`, `renew`). Each change is
  checked with `eligible` again on the box's queue.
- **Keep dates in labels.** Keep writes the date on the provider first:
  `kept <yyyy-mm-dd>` in the snapshot's own description on Proxmox
  (`describeSnapshot`), or a held copy's `kept.<date>` tag and
  description. If the provider refuses, nothing is kept. `labelKept` in
  both Proxmox backends and `ProxmoxSnapshotting`.
- **Held copies at release**, `holdKept`, which `Boxes.#finishRelease` calls
  through `beforeRelease`, before the guest is deleted. For each kept
  snapshot on the box's guest or its earlier guest: an operation
  (`hold-copy`) pins it and records each step before it runs; the room
  check (a take's rule, sized at the box's disk use where Proxmox reads it,
  or the snapshot's disk); `copySnapshot`, a full clone of the snapshot
  into the box range, recorded before the clone and disarmed in its first
  request; `disarmCopy`; `templateCopy`, which now waits until Proxmox
  lists the copy as a template; then the record moves to the copy in one
  write, holding the disk only. The copy's tags carry the box, the
  snapshot, its time, its keep date, the box's kind and its reset version.
  `held-copy-made` is logged. If a copy cannot be made, the release stops
  and deletes nothing: "Release did not finish: bb-box could not copy
  "roomy", which you kept: ...". With `snapshots.db` unreadable, the
  release reads the provider's labels and stops while any says kept.
- **Keep's recovery check.** An unsettled `hold-copy` operation is finished
  at start and at each sweep, and by the release that resumes: a copy that
  is a template is confirmed; one that is not is deleted and made again
  from the snapshot, still pinned, never trusted; one found running before
  its template is logged `held-copy-started`. A part-made copy that cannot
  be deleted keeps its operation unknown and pinned, and the sweep tries
  again.
- **Release and delete what you kept**: `unkeepForRelease` takes each keep
  off, at the person's word, then the release goes on. The box's menu and
  your machines' Remove offer it, with Release again, once a release
  stopped for a copy (`releaseHeldForKept` on the box's view); the CLI's
  `bb box release` and `bb box machines remove` take `--delete-kept`.
- **Forks of held copies**: any held copy that is a template forks, by a
  full clone of the template (`forkByFullClone` with `from: "held-copy"`);
  a kept snapshot of a released box forks as one of the person's machines,
  from the tab or the CLI. `guestIdentity` reads a held copy's config.
- **Expiry**: the sweep deletes a kept snapshot after its date, held copy
  and all, as a delete by bb-box, "its keep ended", never while an
  operation pins it. A living box's kept snapshot goes the same way.
- **The owner's answers**: found snapshots are no longer deleted after 7
  days (`remove-found` is gone); a found one that its box comes back for
  loses its found mark. A leftover guest of an ended thread (`#releaseLeftover`
  with `ended`) gets held copies of its kept snapshots first (`holdKeptOn`),
  then goes at once with the rest, whose records go with it as settled
  deletes (`leftoverReleased`).
- **Unit 7's follow-up**: a fork's guest is disarmed before every delete,
  also when the sweep retries a release that a locked clone stopped.
- **The Snapshots tab**, `src/app/snapshots-tab.tsx` with its data from
  `snapshots.tab` (`src/plugin/snapshots-tab.ts`): a third tab after
  Machines and Threads, with its count, at `/plugins/bb-box/desktop/snapshots`;
  the line under the tabs and what needs the person in amber; a card per
  box, a released box marked so; search, filters with counts (where, holds,
  taken by, kept, undos, goes within 7 days), sort, and Select with bulk
  Keep… and Delete… (`snapshots.bulkCheck` and `snapshots.bulk`), which
  check each snapshot as a single change would and name what they skip.
  Its rows are the box page's rows (`SnapshotRow`, now with a place of its
  own), which gain Keep…, "Keep 30 more days…" and Stop keeping, "goes in
  3 days" from 3 days before, and a held copy's place.
- **RPC**: `snapshot.keepCheck`, `snapshot.keep`, `snapshot.unkeep`;
  delete, rename, note, picture, forkCheck and fork also take a released
  box's snapshot.
- **The CLI**: `bb box snapshot keep <box> <snapshot> [--days|--until]
  [--check]` and `unkeep`; `fork`, `keep`, `unkeep` and `delete` find a
  released box's snapshot by its box's ID, without a thread.
- **Settings**: "Keep keeps a snapshot for", 30 days, 1 to 365, under a
  Keep group on the Snapshots page, in Find and in the overview's row
  ("5 per box · kept 30 days · ..."), and `bb box option set
  general.snapshots.keepDays`.
- **Docs**: the guide's [Keeping a snapshot](../guide/snapshots.md#keeping-a-snapshot),
  [A held copy](../guide/snapshots.md#a-held-copy) and
  [The Snapshots tab](../guide/snapshots.md#the-snapshots-tab), the skill's
  line that only the person keeps, the reference, and 070's Decided during
  unit 8.

### Tests

On a Linux box, 8 cores, 16 GiB, Node 24.21, in a fresh copy of this
branch over main `cf84a20a`: `npx tsc` passes, and the reference is
current; the node suite ran 3,235 tests, 2,947 passed, 0 failed, 288
skipped (the live and conformance ones); vitest ran 427, all passed. The
node suite includes the docs, site and reference checks. New or changed
tests, each on a set clock where time matters:

- `test/keep.test.ts`, 17, on the world's set clock: Keep's label before
  its record, and its event; an agent refused; refused before the identity
  reset and where nothing keeps past a release; dates (days, a date, the
  past, past a year, both, a renewal that never shortens, one that may);
  a refused label keeping nothing, and Stop keeping; the room and VMID
  warnings; G15's release with a held copy of a memory snapshot (disk
  only, disarmed, a template, labelled, before the guest goes, unkept ones
  gone, pins ended); G15's release stopped for room, then finished by the
  sweep; Release and delete what you kept; G16's copy cut short by a
  restart, running, deleted and made again; one confirmed after a restart;
  expiry of a held copy, held past its date by a fork's pin; expiry of a
  living box's kept snapshot; renewal of a released box's held copy and
  its refusals; a release with `snapshots.db` unreadable; a fork check of
  a held copy; a held copy found again after records loss, with its reset
  version and kind.
- `test/forks.test.ts`, 2: G15 end to end (keep, release, restart, fork
  the held copy, the file from before the take, the reset, an agent seeing
  nothing); a fork's release disarmed before each attempt, the sweep's
  retry included.
- `test/snapshots.test.ts`: G3 now keeps a found snapshot until the
  person deletes it; a leftover guest of an ended thread goes at once with
  its found snapshot; one with a kept snapshot gets its held copy first.
- `test/snapshot-rules.test.ts`: keep dates, "goes in 3 days", and no
  automatic deletion of a found snapshot.
- `test/proxmox-lxc-snapshots.test.ts`, 1: Keep's held copy on Proxmox
  LXC: the clone of the snapshot, its tags and description, the disarm,
  a template only once Proxmox lists it, `labelKept` on the snapshot and
  the copy, the listing's keep date, version and kind. Both backends'
  offers now say `held-copy`.
- `test/plugin.test.ts`, 1: `keep`, `--check`, `unkeep`, a release that
  copies first, and a released box's snapshot kept longer, checked for a
  fork and deleted without a thread.
- `test/app.test.tsx`, 4 new and 4 changed: the Keep dialog's date, cost,
  warning, keep and focus; Keep… off with why, renewal, Stop keeping and
  "goes in 3 days"; the tab's count, line, cards, a released box's row,
  search, Select and bulk Keep with what it skips; Release and delete what
  you kept. Unit 4's page tests now expect the keep length.

### On a separate BB

A fresh `npx bb-app` 0.48.1 with no account, its own data folder and
ports, started with `env -i`, `HOME`, `PATH` and `BB_BOX_LIVE_CHECKS=1`, in
a Proxmox LXC box, with bb-box installed from this branch
([unit 7's live-setup.sh](070-snapshots/unit-7/live-setup.sh)). The lead
lent it a Proxmox LXC backend (template 9800, and 9803 without the
identity reset; VMIDs 3170 to 3181) and a Proxmox QEMU backend (9806, and
9804 for Windows; 3182 to 3189), on LVM-thin, with the production token,
and `general.identityResetBackends` was set to both on that BB only. Boxes
were machines of the person's. The node is written pve-1. Root steps were
read-only, by the lead, with unit 7's
[`proxmox-root.sh`](070-snapshots/unit-7/proxmox-root.sh).

| Check | Result |
| --- | --- |
| Keep, LXC and QEMU, after a file was written and a take | `--check` said "If keep-lxc is released, bb-box first copies this snapshot in full into a template that cannot start: up to about 38 s, and about 2.8 GB, at most 17 GB, on pve-1's local-lvm until 2026-11-30, at no charge."; on the VM "up to 17 GB", as Proxmox gives no disk use for VMs. Kept until 2026-11-30 |
| G15, release, QEMU | held copy into 3183, then the guest deleted; 9.3 s for `bb box machines remove`. Listed "its box was released 2026-10-31 · a held copy, guest 3183" |
| G15, release, LXC, first try | stopped, deleting nothing: "Proxmox LXC on pve-1 did not make guest 3171 a template". Proxmox's template call for a container answers before its worker ends, so bb-box read the config too soon; the part-made copy was deleted. Fixed: `templateCopy` waits until Proxmox lists the template (QEMU's call ends with it). A second try, with a mistake of mine in that fix, stopped the same way and deleted nothing |
| G15, release, LXC, after the fix | held copy into 3173 at the next sweep, then the guest deleted |
| G16, the held copies' configs (lead, read only) | 3173 and 3183: `template: 1`, `onboot: 0`, `link_down=1`, MAC addresses of their own, tags `held-copy`, `kept.2026-11-30`, `reset.7`, `snapshot.<id>`; 3183 a new SMBIOS UUID. 3173 still carries its source's `ip=` in net0, inert behind its link and as a template; a fork from it gets its own VMID's address, which the check before ready requires |
| G15, restart BB, then fork | BB's whole server stopped and started again; both kept snapshots still listed on their held copies. LXC fork ready in 11 s, QEMU in 16 s, each one of your machines; each read "written before the take", not the line written after it; `boot=reset`, its reset removing keep-lxc's copied BB machine |
| G16, restart before the template, LXC | `hold-next --at copied`, then a release: held after the clone (3176, not a template); `bb plugin reload bb-box` at 14:28:13; at 14:28:15 "Deleted guest 3176, the held copy of snapshot ... : it was not a template yet after bb-box restarted, so it is not trusted. bb-box makes it again from the snapshot."; made again as 3177 by 14:28:27; the release then finished |
| G16, the same, QEMU | 3186 deleted, made again as 3187, the release finished |
| G15, too little room | "Refuse new snapshots when a host's storage is past" set to 50 (the pool was about 54% full): Keep's `--check` warned "At today's size, a release would not finish: ... it would be 55% full, past your settings' 50%."; the release stopped with the same words and deleted nothing; `bb box machines remove --delete-kept` then released it with its snapshot |
| G15, before the identity reset | a box from 9803: "Taken before old-desk's image had the identity reset: "old image" could not be forked after a release, so bb-box does not keep it." |
| G15, Windows | a Windows desktop on QEMU: "Proxmox QEMU on pve-1 takes no snapshots of its windows-desktop boxes.", so there is nothing to keep there; released |
| Keep dates in labels | bb-box disabled, `snapshots.db` deleted, enabled: all 9 kept snapshots found again as kept with their dates, 4 held copies and 5 snapshots of living boxes; the held copies with `forkSafe` 7 from their tags |
| A held copy found again forks | the copies above, made before held copies carried the box's kind, came back with kind and system unknown, so their fork was refused as not Linux. Fixed (the `kind.` tag, and the system from the backend's offer of that kind); a new one, found again the same way, forked: ready in 9.7 s, the file from before the take, `boot=reset` |
| G9, a restore's target in the tab's bulk actions | a restore held after its stop: bulk Delete and bulk Keep each skipped its target with ""restore target" is in use by the restore that began at 14:44 UTC."; the restore then finished |
| The page and the tab, keyboard only, 1,440 and 390 px | [keep-page.mjs](070-snapshots/unit-8/keep-page.mjs). Box page, 1,440: the row's menu in 23 Tab presses, Keep… by the arrows, focus on the date (30 Nov), kept 1.7 s after Enter, focus back on the menu's button. 390: the menu a sheet, 17 Tab presses, Keep… by Tab, kept 1.3 s after Enter, focus back. Tab, 1,440: Select in 30 Tab presses, the row's checkbox by Space, the bar's Keep…, the dialog listing the snapshot's cost, kept. 390: Select in 12 presses, the same. Row actions always shown at 390 px, Fork in the menu |

At the end every machine, held copy and snapshot of the separate BB was
released or deleted, and the lead's `leftovers` listed no guest in 3170 to
3189.

Screenshots at 1,440, 760 and 390 px, dark and light, of the tab, the Keep
dialog, a kept row and the bulk dialog, are in the unit's thread storage,
not in the repository: they show the test node's name.

### Gates

| Gate | Result |
| --- | --- |
| G15 keep-lasts | **Passed** on Proxmox LXC and QEMU: Keep, release, a restart of BB, then a fork from the kept snapshot read the file written before the take; with too little room the release stopped and deleted nothing; Keep refused, with why, on a snapshot taken before the identity reset. On a Windows box there is no snapshot to keep: Windows boxes take none in this build, and the offer for them is `no` |
| G16 held-copy-inert | **Passed except the node's reboot**: `pct config` and `qm config` (by the lead) show each held copy a template, `onboot` 0, links down and its own MAC, the QEMU one a new SMBIOS UUID; bb-box restarted after a clone and before its template, on LXC and QEMU: the copy deleted and made again from the snapshot, and the release finished. The remade copy's files were read through a fork (G15's), whose reset ran. **Not proved**: the node's reboot, as no node is rebooted; unit 3's earlier-guest checks stand |
| G9 serialised-and-eligible, Keep's part | live: a restore's target skipped by bulk Delete and bulk Keep, named; expiry held by a fork's pin, in the tests. Rename of a pinned target was proved in unit 6 |

### Choices and deviations

- **No switch for Keep** (Decided during unit 8): arming gates it, so
  production's Keep is refused until the owner arms its backends.
- **Found snapshots stay until deleted**, the owner's answer, which changes
  section 1's rule and unit 1a's.
- **A held copy is cloned while the box still runs**, from the snapshot,
  rather than after a stop: Proxmox allows that for a snapshot, and the
  box is going anyway.
- **A held copy's room** uses a take's rule and the box's disk use now
  (containers) or the snapshot's disk size (VMs), not the snapshot's own
  use, which the token cannot read. The ceiling is not checked at release,
  as the copy replaces its snapshot in the rate. After the reviews it also
  counts and makes reservations, and fails closed.
- **Expiry is a delete by bb-box** ("its keep ended"), not an operation
  of kind `expire`, so it shares the delete's recovery.
- **A released box's kept snapshot is not unkept**: kept longer or deleted.
- **The tab's rows reuse the box page's**, with what a row holds and its
  life added; a released box's Restore is off with why rather than hidden.
- **The tab names no backends that take no snapshots**, and its line does
  not yet read storage past 85% or hosts that cannot take snapshots: both
  need a plan per host, which the tab does not read when it loads.

### Known limits

- **A snapshot labelled before this unit's reviews**, found again after
  `snapshots.db` is lost, has no reset version, as its label has none. It
  cannot be kept anew, and a release stops rather than copy it if it was
  kept. Labels written from now on carry the version, so a living box's
  snapshot found again forks.
- **Expiry was not run live**: its date cannot be brought forward on a live
  BB; the tests run it on a set clock.
- **The leftover guest of an ended thread with a kept snapshot** was run in
  the tests only: it needs a box record lost while its thread ends.
- **Thin metadata** is still not read (unit 1a's limit), so a held copy's
  room checks the pool's data only.

### After the reviews

Two independent reviews read the bundle at `fe5f91ee`: Astra (merge after
fixes, four P1 and three P2) and Opus (merge after fixes 1 to 4, with five
more). Astra reproduced six of its findings with scratch tests. The lead
asked for every finding, the stricter fix where the two overlapped, and a
regression test for each.

| Finding | From | Fix | Tests |
| --- | --- | --- | --- |
| A Keep or renewal cut short between the label and the record was lost: a held copy labelled 29 November was deleted on 1 November | Astra 1 | Keep, renewal and Stop keeping are operations of kind `keep` (a new migration lets the table take it), recorded before the label is written. Recovery reads the label and records what it says before any expiry or release; the reconcile takes a label's later keep date, never an earlier one | "review 1: a renewal cut short ...", "a keep whose label answer is lost ...", "the reconcile takes a later keep date" |
| After records loss, Proxmox lists a copy first, so a non-template copy was recorded over its source, and the release deleted the source | Astra 2 | Each snapshot ID prefers a trusted listing: the source over a copy that is not a template. The untrusted copy is deleted, and a release stops while a kept snapshot's copy is not a template | "review 2: with records lost while a held copy was not a template ...", "a release refuses while a kept snapshot's held copy is not a template" |
| Held copies bypassed the room admission: no reservation, others' reservations ignored, an unreadable plan admitted | Astra 3, Opus 2 | The take's transactional admission: it counts `reservedBytes` on the storage, reserves the copy's bytes on its `hold-copy` operation until it is made, and refuses when the plan or the storage's totals cannot be read. The words name what others hold, and show a decimal when a whole percent would equal the limit | "review 3: held copies share the room rule ...", "a held copy refused just past the room limit says by how much" |
| A living box's snapshot found again lost its reset version, so its held copy could never fork | Astra 4, Opus 5 | The snapshot's label carries `reset <n>`, read back on recovery. A release stops for a kept snapshot whose version is unknown, and copies only keeps whose date has not passed | "review 4: a living box's kept snapshot found again ...", "a release copies only keeps whose date has not passed" |
| Bulk Keep's untouched date shortened longer keeps | Astra 5 | Untouched, bulk Keep sends no date, so each row is kept for the days in Settings from today, or that many days more if kept already. A chosen date may shorten one, and its row says so | "review 5: bulk Keep with no date chosen never shortens ...", and the app's bulk test |
| The 120 s template wait counted sleeps, not time: 2,525 s with slow reads | Astra 6, Opus 6 | A monotonic deadline over reads and sleeps, which stops when cancelled | "review 6: the wait for a held copy's template is bounded by 120 s of elapsed time" |
| A held copy found with no thread showed a button to thread "unknown" | Astra 7 | Plain text: "Found again on its host; its thread is not known" | "070 unit 8 review 7" |
| The clone waited at most 180 s, so a disk over about 75 GiB never copied, and each retry cloned again | Opus 1 | The clone's wait is 3 times the plan's estimate, at least 180 s (`cloneWaitMs`), for every full clone, held copies and forks of them included; `waitTask` waits that long in the same run | "review: a clone's wait grows with its disk ..." |
| The bulk dialog checked again on every render, and sent `[]` once the selection emptied | Opus 3 | The IDs are frozen when the dialog opens | "the bulk dialog checks the snapshots chosen when it opened, once ..." |
| "Release anyway" and "Remove anyway" dropped "delete what you kept" | Opus 4 | The in-use state keeps `deleteKept` and passes it on | "Release and delete what you kept, then Release anyway ..." |
| The machine left BB before the copies were made | Opus 7 | The release makes the copies first, then takes the machine out of BB | "a release leaves BB's machine list only once its kept snapshots are copied" |
| A leftover guest of an ended thread was judged by the records alone | Opus 8 | It is kept while a snapshot's label says kept and the records do not, or while the labels cannot be read; a backend that takes no snapshots has none to read | "a leftover guest of an ended thread whose label says kept ...", and plugin.test's restored-box test |
| "Keep 30 more days…" counted from today; Select changed its name while pressed; the tab was blank while loading or after an error | Opus 9 | Renewal adds the days to the keep date; Select keeps its name with `aria-pressed`; the tab says "Reading the snapshots…" and shows the error | "a keep date: ... a renewal by default adds the days to the keep date", the app's bulk test, "the Snapshots tab says it is reading them until its answer comes" |
| Test gaps: a restart while the clone task runs, after the record moved, inside `holdKeptOn` | Opus | Tests for each | "a restart while the copy's task still runs ...", "a restart after the record moved to its held copy ...", "a leftover guest ... stays until the records agree" |

**Found in the live recheck.** With the wait cut to 1 s in a test build,
the release tried to delete the part-made copy while Proxmox was still
cloning it. The copy's config did not exist yet, so the delete counted as
done and the operation was settled. The clone then finished with its
source box's tags, and after the box's release the sweep restored it as a
box, `bb-box-copy-3171`. Two fixes, each with tests that fail without
them:

- A copy that fails while its task may still run stays unsettled, and the
  sweep deletes the part-made copy only once the task ends.
- A guest named `bb-box-copy-<vmid>` is listed as naming no box, so it is
  released as a leftover once no operation uses it, never restored.

The tests are "a release whose copy outlasts its wait while the provider
still makes it ...", and on each Proxmox backend, "a held copy cut short
before its own labels ... never one to restore".

**Live, after the fixes**, on a new separate BB set up as before, with the
same backends and VMIDs, armed on that BB only:

| Check | Result |
| --- | --- |
| Clone wait, test build (no 180 s floor, least wait 1 s), estimate factor 0 | LXC and QEMU releases stopped and deleted nothing: "Proxmox TASK vzclone ... failed (504): task did not finish in time." |
| The same, factor 3 (3 × 16 GiB × 2.4 s = 115 s) | both releases finished, held copies made in 9.5 s and 6.4 s; a fork from the LXC copy was ready in 8.9 s, with the file from before the take and `boot=reset` |
| The same, factor 0, after the fix above | each release stopped: "Proxmox LXC on pve-1 may still be making its copy, guest 3175, so bb-box deletes that copy only once the task ends, at a later sweep."; the operations stayed unknown with their reservations; the sweep deleted each part-made copy once its task ended; nothing was restored as a box. With factor 3, the sweep finished both releases |
| Room: "Refuse new snapshots when a host's storage is past" lowered to 55 on the test BB, with the pool about 54.7% full; two LXC boxes of 40 GiB, each with a 12 GiB file made by `fallocate`, so each copy is about 16 GB | the first release, held after its record (`hold-next --at planned`), reserved 15,716,274,176 bytes on its `hold-copy` operation; the second was refused: "pve-1's storage local-lvm has 3536 GB free, beside 16 GB that snapshots and copies being made there hold, and with the held copy, about 16 GB, it would be 55.1% full, past your settings' 55%."; the first then finished, and its reservation ended |
| Proxmox's API cut (`iptables` on the test BB), the setting back at 85 | the release stopped: "bb-box could not read where it would be copied, so it deleted nothing: ... cannot reach the Proxmox API"; the rule was then removed |
| The machine while a release stopped for a copy | still listed by `bb host list` as connected; gone once the copy was made |

The threshold was lowered on the test BB only, rather than filling the
shared pool. At the end the BB had no snapshot, box or unsettled
operation, and the lead's `leftovers` listed no guest in 3170 to 3189.

After the fixes, on this unit's two commits over main `cf84a20a`, in a
copy on the same kind of box: `npx tsc` passes, and the reference is
current; the node suite ran 3,254 tests, 2,966 passed, 0 failed, 288
skipped; vitest ran 431, all passed.

### After the re-reviews

Two re-reviews read `c5fede75`. Opus said merge, with two low findings.
Astra said not yet, with three blockers, each reproduced by a probe. The
lead asked for the three blockers and Opus's first low finding, each with
the probe as a regression test. All three new tests fail on `c5fede75` and
pass now.

| Finding | From | Fix | Tests |
| --- | --- | --- | --- |
| After records loss, a rebuilt, empty `snapshots.db` is healthy. If the reconcile then failed, a release found no kept record and deleted the guest, kept snapshot and all | Astra B1 (P1) | Every release lists its guest's own snapshots (`snapshotsOn`, one call on Proxmox) before it deletes anything. It stops, deleting nothing, when it cannot read them, or when a label says kept and the records do not, until the sweep has recorded it | "re-review B1: after records loss, every release reads its guest's own labels ...", and on Proxmox LXC "a release's label check lists one guest's own snapshots ..." |
| A clone slower than its wait, which ended well, was deleted and cloned again at every retry | Astra B2, Opus N2 | bb-box waits for the same task across retries. Once it ends well, the copy is labelled (`labelCopy`, split out of `copySnapshot`), disarmed and made a template, if its wait ran out in this run. A copy left by a restart is still deleted and made again, as G16 proved | "re-review B2: a clone slower than its wait that ends well ...", and the rewritten "a release whose copy outlasts its wait ..." |
| A retry whose submission answer was lost could take the previous clone's task, settle the operation and drop its reservation while the new clone ran | Astra B3 (P1) | Each copy attempt records its start and task (`attempts`, a new column in an appended migration). Recovery looks from this attempt's start only, skips every earlier attempt's task, and stays unsettled while more than one could be its own. Proxmox lists a clone's task under its source's VMID only, so the target VMID cannot be matched from the list | "re-review B3: a copy made again after a restart ..." |
| "Release and delete what you kept" did not clear an untrusted held copy, though the words offered it | Opus N1 | A stop that taking the keeps off cannot get past (`ReleaseWaits`) no longer offers it, in the words or the menu: an untrusted held copy, a copy still being made, labels that cannot be read, or labels the records do not have yet. An untrusted copy's words say to delete that snapshot | "review 2: a release refuses while a kept snapshot's held copy is not a template ..." |

**Live**, on a new separate BB set up as before, with the same backends
(VMIDs 3180 to 3189), armed on that BB only:

| Check | Result |
| --- | --- |
| B1: a kept snapshot's record deleted from the test BB's `snapshots.db`, then a release at once | stopped: "Box b1-lxc's label on Proxmox LXC on pve-1 says snapshot ... is kept until 2026-11-30, and bb-box's records do not say so yet, so it deleted nothing."; the machine stayed in BB; the sweep found the snapshot from its label, and the release then made its held copy |
| B1: Proxmox's API cut (`iptables` on the test BB) during a release | stopped: "bb-box could not read the labels of box b3-lxc's snapshots on Proxmox LXC on pve-1, so it cannot tell whether one is kept, and deleted nothing"; "Release and delete what you kept" not offered |
| B2: test build with a 1 s clone wait, LXC and QEMU | each release stopped while Proxmox copied ("bb-box waits for that task, and makes the copy a template once it ends well"); at the sweep the same copies, 3181 and 3186, became the held copies, one attempt each, with no second clone and nothing restored as a box; forks from both read the file from before the take, `boot=reset` |

At the end that BB had no snapshot, box or unsettled operation, and the
lead's `leftovers` listed no guest in 3170 to 3189.

After these fixes, on this unit's three commits over main `cf84a20a`, in
a copy on the same kind of box: `npx tsc` passes, and the reference is
current; the node suite ran 3,258 tests, 2,970 passed, 0 failed, 288
skipped; vitest ran 431, all passed.

A last re-review by Astra found B1, B3 and the wording answered, and one
race left in B2: a clone that ended well between its wait running out and
the task's read was deleted, as only a running task was kept. Now a clone
whose task ended well in that release is labelled, disarmed and made the
template there; only a copy whose task failed, or that cannot be finished,
is deleted. Its probe is the test "re-review B2 race: a clone that ends
well just as its wait runs out ...", which fails on `0135b683` and passes
now.

After that fix, on this unit's four commits over main `cf84a20a`: `npx
tsc` passes, and the reference is current; the node suite ran 3,259
tests, 2,971 passed, 0 failed, 288 skipped; vitest ran 431, all passed.

### Conditions and open questions

- **G16's node reboot** stays a condition before production's Keep is
  turned on, by arming its backends.
- **Rebuild the LXC template with version 7** before arming Proxmox LXC
  (unit 7's condition) also gates Keep there.

## Unit 9: Tart

macOS snapshots as APFS copies of the suspended VM, beside the VMs, with
its memory; Linux VMs on Tart, disk only, while stopped; restore by putting
a copy back; macOS's own identity reset, then forks and Keep; a guard
against a state saved under another macOS build or Tart. Decisions are in
070, [Decided during unit 9](070-snapshots.md#decided-during-unit-9).

### What changed

- **Tart's backend** offers snapshots (`src/backends/tart/snapshots.ts` and
  the backend): `snapshotting`, `identitySource`, `planSnapshots`,
  `snapshot`, `deleteSnapshot`, `heldSnapshots`, `snapshotsOn`,
  `providerTask`, `findTasks`, `powerOff`, `rollbackSnapshot`,
  `labelKept`, `guestIdentity`, `forkSnapshot`, `armFork` and `disarmFork`.
  All are POSIX sh scripts on the Mac, as the rest of the backend's are.
- **Where a snapshot lives.** In `bb-box-snapshots`, beside Tart's `vms`
  folder where `~/.tart` leads, as `<snapshot>/vm/`, an APFS copy (`cp -c`)
  of the VM folder's files, and `<snapshot>/label`: the install, box, VM,
  snapshot, time, what it holds, the Mac's macOS build and Tart version at
  the take, the identity reset's version and the keep date. A copy is made
  as `<snapshot>.part` with the shell's PID, and renamed when whole; a
  delete renames it `<snapshot>.deleting` first. The listing reads these:
  a `.part` whose shell is gone, or a `.deleting`, is incomplete.
- **Every copy checks first** that the snapshots folder is on the VMs'
  volume (its device is the VM folder's) and that the volume has at least
  `reserve-disk-gib`, or 20 GiB, free. Otherwise it refuses before anything
  stops.
- **A take of a running macOS box** suspends it, copies it and resumes it
  with the backend's own start (address, identity, clock). A stopped one is
  copied as it is. A Linux VM is copied only while stopped.
- **A restore** uses core's in-place order: the stop is Tart's own stop, a
  suspend for macOS and a shutdown for Linux, never a hard stop; the undo is
  a take of the suspended VM; the "rollback" copies the snapshot into
  `.restore-<vm>` and swaps it with the VM's folder in two renames, with a
  journal in `.rollbacks/<vm>` ("begun", then "done"); core then starts it,
  which resumes a macOS box as it was at the take. The snapshot stays. The
  journal goes with its VM's release.
- **The guard**: the plan and the rollback refuse a snapshot with saved
  memory whose label names another macOS build or Tart than the Mac's now,
  and say to fork it.
- **macOS's identity reset** (`setup/tart/guest/bb-box-identity-macos.sh`,
  version 2): the Linux program's commands and status lines, so core reads
  both alike. bb-box installs it in each macOS VM at acquire, beside the
  name and the grants (`src/backends/tart/identity.ts`), only in a
  `VirtualMac`, with its LaunchDaemon, and runs its `boot` once there, so a
  new box is `unarmed` until core writes its marker. Its marker names the
  MAC addresses of the `AppleVirtIONetwork` cards. A copy resets: BB's
  machine files under `/Users/*/.bb-machines`, BB's LaunchAgents
  `app.getbb.host-daemon.*`, the access file and the SSH host keys; it
  records a login before it decided as `raced`.
- **Forks** copy the snapshot's files but `state.vzvmsave` into a VM of the
  fork's own, claimed first, then `tart set --random-mac --random-serial`
  and the fork's size. The fork's first start identifies it by the Mac's
  ARP table, as its disk still names its source's VM, then names it after
  its box.
- **Core**:
  - `outlivesGuest` on a backend's offer: its snapshots live beside the
    guest, so a release deletes the unkept ones first, a kept one stays as
    it is, can be kept longer and forked after its box's release, and a
    guest is not held for a kept snapshot.
  - A memory take of a stopped box is allowed where snapshots suspend.
  - Forks, Keep, the identity marker and the reset's record work for
    macOS as for Linux (`forksOn`); the fork-safety read and the check
    before ready read macOS's paths (the hardware UUID as the machine ID,
    `/Users/*`, LaunchAgents, `ifconfig`), and the check refuses a `raced`
    reset.
  - Recovery's words for a rollback whose task failed name the backend,
    not Proxmox.
- **Words**: Keep says what it costs on Tart ("it stays where it is until
  ...; nothing is copied then, and from then on it takes its whole size,
  up to ... GB on /Volumes/...") and for a released box's kept one; the
  CLI's fork and keep help name Tart; the setting's help says Linux and
  macOS.
- **Docs**: the snapshots guide (the offer table, a Tart section, the macOS
  reset, restore times, Keep and release on Tart), the Tart guide's
  Snapshots section and clean-up, 070's decisions.

### Tests

New: `test/tart-snapshots.test.ts` (16 tests, against the fake Mac, whose
scripts run in a real shell, with a fake `tart` that now does
`--random-mac` and `--random-serial`) and `test/beside-snapshots.test.ts`
(3 tests, core with a backend whose snapshots live beside the guest, at a
set clock):

- the offers, macOS and Linux, and `identitySource`;
- a take of a running macOS box suspends, copies with the saved memory,
  labels and resumes; of a stopped one, no suspend; one whose suspend
  fails copies nothing and leaves the box running; Linux only while
  stopped;
- a snapshots folder on another volume refused, by the plan and by the
  take, with nothing copied and the box resumed; too little free refused;
- the listing: complete, cut short, delete cut short, another install's
  never; keep dates on the label; delete refused for another install's;
- each task's outcome from the Mac's folders and the restore journal: a
  take or a restore the Mac has no trace of did not begin, so it fails,
  rather than stay unsettled;
- a restore puts the copy back and keeps the snapshot, the stop a suspend,
  the journal gone with the VM's release;
- the guard: another macOS build refused with "Fork it instead"; another
  Tart; a copy with no saved memory restores;
- a fork: claimed first, no saved state, a new MAC address and machine
  identifier, the fork's size, its guest identity;
- the installer: only in a VM, its LaunchDaemon, its first `boot`;
- the macOS reset with a test root: off, unarmed, the marker, kept on the
  same MAC, reset on another (files gone, `host-artifact.sha256` kept, new
  host keys, the record), kept at the next boot; `raced` when someone had
  logged in, and the fork check's refusal of it; macOS's probes read no
  Linux path;
- core: a memory take of a stopped box where snapshots suspend, and not
  where they do not; a release deletes unkept ones, keeps a kept one with
  no held copy and releases the guest; a released box's kept one renewed
  and forked as one of your machines; Keep's words.

Updated: `test/tart.test.ts`'s acquire timings name the identity reset's
install step.

On a Proxmox LXC box, on a git checkout of the branch rebased on main:
`tsc` clean; `npm test`: the node suite, 3,356 tests, 3,068 passed, 0
failed, 288 skipped, the docs, site and reference checks among them; then
vitest, 443 of 443 in 5 files. `npm run reference` changed nothing more.

### On a separate BB

A fresh `npx bb-app` 0.48.1 with no account, its own data folder and
ports, started with `env -i` and `BB_BOX_LIVE_CHECKS=1`, in a Proxmox LXC
box, bb-box installed from this branch with `bb plugin install path:`.
The lead gave it a Tart backend of its own install on the production Tart
Mac, with that backend's SSH key put in the box as a file, which was
deleted once the backend was added; warm VMs off, the desktop kind off,
`reserve-disk-gib` 60, `general.identityResetBackends` `tart`. The Mac:
macOS 27.0.1, Tart 2.40.1, its VMs on an external volume of its own,
with 1,533 GiB free by `df` at the first take. Another thread held a
macOS VM there, so this unit ran one macOS VM at a time. Boxes were
machines of the person's, `macos`, 6 cores and 16 GiB. As in unit 11, a BB
with no account cannot make them BB machines, so the BB machine was stood
in for by a random host ID in `~/.bb-machines/live-check/host-id` and a
LaunchAgent `app.getbb.host-daemon.live-check-host_gate.plist`; a process
writing a counter each second, from `launchctl submit`, showed memory.

| Check | Result |
| --- | --- |
| Acquire | ready in 19.2 s: identity reset installed 1.8 s, marker 0.3 s. `bb-box-identity status`: version 2, `boot=unarmed`, `marker=matches`, `armed=yes`; the marker names `en0`'s MAC address only |
| Take, running | 11 s as bb-box timed it, 12.0 s for the command: suspend, copy, resume. "it holds its disk and memory ... Size: 89 GB, some shared with its box. Price: no charge." The counter process, PID 983, ran on |
| Restore | 13 s: stop (suspend) 4.0, undo 0.2, rollback (the copy put back) 0.2, start (resume) 7.8, access 0.1 s. `work.txt` back to "before"; PID 983 running, its counter back at 110, as at the take, from 128; the host ID file the same |
| Undo | 14 s: stop 3.9, undo 0.2, rollback 0.2, start 9.4, access 0.1 s. `work.txt` "after"; PID 983 at 131, from where the restore suspended it |
| Fork | the source suspended first (4.9 s), then forked as one of the person's machines: ready in 15 s, 16.2 s for the command, after core's check before ready. In the fork: booted 00:36:55, reset at 00:37:00, the console login at 00:37, `raced=no`; the host ID file and the BB LaunchAgent gone; a new SSH host key (`97b91907...` for `d0413a31...`), a new hardware UUID (`BBBB2925-...` for `C3396674-...`); its marker names its own MAC address and no box; named gate-fork; `work.txt` "before"; no counter process; an access file of its own (another SHA-256) |
| The source after its fork | started (resumed) in 7.1 s: the same host ID file, LaunchAgent, hardware UUID and SSH host key, PID 983 still running, `boot=unarmed`, `marker=matches` |
| Keep | 1.0 s, the date on the snapshot's label. `--check`: "If gate-mac is released, it stays where it is until 2026-12-01." Release 1.9 s: the two undos deleted with the box, the kept one listed "kept until 2026-11-02 · its box was released" |
| Fork of the kept snapshot after the release | ready in 16 s, one of the person's machines: `boot=reset`, `raced=no`, a new hardware UUID, no host ID file, `work.txt` "before" |
| Another volume | the lead pointed `bb-box-snapshots` at a 1 GB APFS disk image on the Mac. The take: refused in 0.9 s, before anything stopped: "bb-box cannot take a snapshot of box vol-mac now: the snapshots folder on mac1 is on another volume than its VMs, where a copy would be a full copy of the whole VM." The box ran on, uptime unbroken |
| Clean up | every machine released, the kept snapshot deleted, a sweep, then: no snapshots, no machines, no boxes, the doctor counting only other installs' VMs. On the Mac, the lead counted 0 snapshot folders, 0 owner files of this install and 0 VMs of its; the disk image detached and deleted. The test backend removed from the separate BB |

Found live, and fixed with a test each:

- The first box's marker named `en1` as well as `en0`: macOS lists USB
  network placeholders (`AppleUSBDeviceNCM11Data`) as `en1` and `anpi0`.
  Version 2 reads only `AppleVirtIONetwork` cards; forks need version 2,
  and the box was made again.
- The first take refused with "at least NaN GiB free": the backend read the
  disk reserve from a field that is not there. It reads
  `reserve.diskGiB`.
- The first fork was refused for its size: a Tart box keeps its image's
  disk, and the plan asked for the copy's 130 GiB. A fork's size leaves the
  disk to its copy.

### Gates

| Gate | Result |
| --- | --- |
| Take, restore, undo, fork and keep of a 16 GiB macOS box on a Tart Mac box, timed | passed, above, on the production Tart Mac as a second install, never a pool Mac |
| A copy on another volume refused | passed, above |

### Choices and deviations

- The reset is installed at acquire, not in the image (the lead's
  decision), so 070's "the unit is in a box's image" holds for Linux only.
- Tart's Linux VMs neither fork nor keep yet, against 070's backend table,
  which gave them both: their reset was not checked live. Their take and
  restore were tested against the fake Mac only; the gate is macOS's.
- The guard refuses rather than restore the disk alone.
- The undo of a macOS restore is a copy of the suspended VM, so it holds
  memory too: undoing brings the box back running, as the live check
  showed.
- "Your machine" boxes were used, so G17's hold on boxes threads run on
  did not come into it; those restores stay off.

### Known limits

- A take of a running macOS box suspends it for about 11 s, while the box
  still shows as ready: its desktop and commands wait.
- If bb-box stops during a take of a running macOS box, the box stays
  suspended: the take is settled at the next start, and the person starts
  the box.
- Each kept or undo copy grows as its box changes, up to the VM's disk and
  memory: on this Mac about 89 to 92 GB whole each, shared until the box
  changes. A box's 5 snapshots and 2 undos could take seven times that.
- macOS gives no ordering between a LaunchDaemon and a LaunchAgent, so
  the in-guest reset alone could only be checked to have run first. Since
  the reviews, the Mac cleans a fork's disk before it boots (below).
- macOS boxes made before this unit have no reset in them.

### Conditions and open questions

- Production forks and keeps macOS snapshots only once the owner adds the
  Tart backend to `general.identityResetBackends`.
- Should a restore after a macOS or Tart update put back the disk alone,
  booting afresh, rather than refuse and point to Fork?
- Tart's Linux identity reset: a live check would let Linux VMs on Tart
  fork and keep.
- Cleaning a fork's raw-format disk with `hdiutil` on a Mac without
  `diskutil image attach` is a follow-up in 070, once a host to check it on
  is free.

### After the reviews

Opus and Astra each said merge after fixes. The lead asked for these in one
amended commit, each with a test on the fake Mac that fails before it:

| Finding | What changed | Test |
| --- | --- | --- |
| A restore cut short between its two renames left no VM, then a release left a whole hidden VM (Opus 1, Astra 2, Opus 6) | The journal says `copying`, then `swapping` just before the first rename, with the shell's PID and start time and an attempt token per restore. Reading the box's power or task, its start and its release put back the snapshot's whole copy or the VM's own folder; a live restore holds the start and the release, and makes the power read "stopped"; the VM's state is read again just before the swap; a release deletes `.restore-`, `.replaced-` and `.fork-` folders; a PID with another start time is dead. A restore that did not happen is reported as such, and core starts the box again as it was | "cut short between its two renames", "cut short while it copied", "put right when it starts or its power is read", "a release deletes what a restore or a fork cut short left", "each restore has its own attempt" |
| A login during the reset went unrecorded, and nothing stopped the source's credentials acting (Opus 4, Astra 1) | The Mac cleans the fork's disk before its first boot, with the guards the lead set after three probes on the Tart Mac: the fork's own image only, its container from its own store, the Data volume by role, never the Mac's container. The in-guest reset reads the console user before and after its removals and records a race only while BB's identity was on the disk | "a fork's disk loses its source's BB machine ... before its first boot", "a fork whose disk would mount from the Mac's own container ... is refused", "records a race when someone logs in while it removes BB's machine", and, from the recheck, "a login during the reset of a disk that holds nothing of BB's ... is no race" |
| The label took the Mac's build at the copy, not at the suspend (Opus 3, Astra 3) | Each suspend notes the build and Tart beside the VM; the take copies that note; unknown provenance refuses; the start just after a restore never cold-boots | "memory saved before a macOS update is labelled with the build that saved it", "the start just after a restore never boots the VM from its disk" |
| Same volume is no clone, and the reserve was checked after the suspend (Astra 4) | Copies go through `clonefile`, refused rather than made in full; the plan and the take check the room before any suspend | "a copy APFS cannot clone is refused", "refused ... before the suspend" |
| A take whose resume failed said "taken, ready" (Opus 2, Astra 5) | The backend says why it did not resume; core marks the box stopped, with why, in the answer and the log | "a take whose box does not resume says the box is stopped", "a take whose box did not resume after it leaves the box stopped" |
| A fork over a VM already there kept its source's MAC and serial (Opus 5) | Refused | "a fork is never made over a VM that is there already" |
| A Mac without `diskutil image attach` (the lead's answer) | No macOS forks there, and no Keep, as a kept snapshot could not fork after the release; the plan and the scrub say why, naming macOS 27; the doctor's "macOS forks on <mac>" warns. No `hdiutil` path: recorded in 070 as a follow-up | "a Mac whose diskutil cannot attach a disk image makes no macOS forks" |
| Words (Astra 6, Opus 7) | The restore's dialog, undo label and CLI follow the backend's capture: "suspend it, which saves its memory", an undo "with its memory, so undoing brings it back running"; one sentence for another volume; "does not restore it" for another Tart; the guides say kept snapshots stay on the Mac after bb-box is removed | "the restore's words follow the backend", app "where the backend suspends the box, the restore dialog says its undo is taken suspended" |

Run against the reviewed commit with only the tests and fakes swapped in,
23 of the 35 tests in the two files failed, every new one but the last
race test, which guards a rule the recheck added.

On a Proxmox LXC box, on a git checkout rebased on main with units 10 and
11b: `tsc` clean; the node suite, 3,417 tests, 3,129 passed, 0 failed, 288
skipped; vitest, 445 of 445; `npm run reference` changed nothing more.

Found in the build: `note_disk_gb` in the Mac's shared shell code sets a
global `_id`, which overwrote the restore repair's snapshot ID; the
repair's variables are its own now.

#### Live recheck

On a new separate BB, the same second install on the production Tart Mac,
one macOS VM at a time, 16 GiB:

| Check | Result |
| --- | --- |
| Acquire | 20.5 s, reset version 3 installed in 1.0 s, `marker=matches` |
| Take, running | 11 s |
| Restore | 15 s: suspend 6.4, undo 0.4, copy back 0.3, resume 7.8, access 0.1 s; `work.txt` "before"; the counter process, PID 964, back to 12 from at least 13. The guard let it through, as its memory's note named the Mac's build |
| Undo | `work.txt` "after", the counter on from where the restore suspended it |
| `--check` words | "suspend it, which saves its memory: it is never stopped hard"; "a snapshot of it suspended, with its memory, so undoing brings it back running as it is now"; "put the snapshot's copy in its place, and resume it" |
| Fork, source suspended first | ready in 28 s, 15 s in unit 9's check, the Mac's cleaning of its disk included. Its reset found "BB machines removed: none": the stand-in host ID and BB LaunchAgent were already gone before it booted; new SSH host key and hardware UUID; `raced=no`. The source came back unchanged |
| Keep, release, fork of the kept snapshot | the first try refused the fork, and released it: its reset (version 3) saw a login during its removals and recorded a race, although the Mac had already cleaned the disk. So version 4 records a race only while BB's identity is still on the disk. On a new box with version 4: kept, released, forked in 28 s, `boot=reset`, `raced=no`, nothing of BB's on its disk |
| Clean up | every machine released and snapshot deleted, a sweep; the backend removed. The lead checked the Mac: `bb-box-snapshots` holds an empty `.rollbacks` only; no owner file, run note or `/tmp` mount point of this install's; no disk image of this install's attached |

The interrupted restore and the failed resume were not provoked live: a
shell cannot be stopped between two renames from bb-box, and the second VM
slot was another thread's. The fake Mac covers both.

## Unit 10: microsandbox

microsandbox's own snapshots: take with or without memory, restore as a swap
to a new microVM, fork from a snapshot's disk only, Keep as it is on the
host, and `msb`'s chain of dependent snapshots, with microsandbox's identity
source for the reset. The lead's two answers are in 070, [Decided during
unit 10](070-snapshots.md#decided-during-unit-10).

### What `msb` 0.7.7 does

Probed before building, with the release bb-box pins, in a Proxmox QEMU
Linux box with nested KVM (8 cores, 16 GiB), by
[microsandbox-unit-10.sh](../research/box-snapshots/microsandbox-unit-10.sh)
([output](../research/box-snapshots/microsandbox-unit-10-results.txt)):

- A Docker disk that is a file of the host's (`--mount-disk`) is left out
  of every snapshot, dropped on any restore, even with
  `--dangerously-inherit-resources`, and makes `--full` fail ("additional
  block resource ... has no immutable-generation provider"). A disk of
  `msb`'s own (`--mount-owned`) is captured, restored as a private copy, and
  works with `--full`.
- A snapshot outlives its sandbox, and restores after it is removed.
- Each capture's parent is the sandbox's previous capture. `msb` refuses to
  remove a parent without `--force`, and a group's head while it has other
  members. With both parents of a chain of three force-removed, the last
  restored byte-identical: 60 MB on the root and 15 MB on an owned disk.
- A restore keeps none of the old sandbox's settings: no labels, no
  environment, no hostname, no `/run` tmpfs, msb's default memory and
  network. A memory restore must keep the captured CPUs and memory.
  `--disk-only` boots a memory snapshot's disk at another size.

### What changed

- **microsandbox's backend** (`src/backends/microsandbox/backend.ts`,
  `snapshots.ts`) offers snapshots: `snapshotting`, `planSnapshots`,
  `snapshot`, `deleteSnapshot`, `heldSnapshots`, `snapshotsOn`,
  `providerTask`, `labelKept`, `powerOff`, `adoptSnapshot`, `forkSnapshot`,
  `armFork`, `disarmFork`, `guestIdentity` and `identitySource` (`value`).
  Each box's snapshots are the group `bbbox-<box ID>`, named
  `<install>-<snapshot ID>-r<reset version>`, with labels for the box, the
  snapshot and its size. A keep date is a file in `msb`'s folder's `kept`,
  written by a new host script, `keep`; another, `snapshots`, gives each
  snapshot's size and keep date.
- **The restore** restores into `bbbox-<box ID>-<token>`, at the box's size,
  or the captured size for memory, with the box's network profiles, then
  sets its labels, environment (`BBBOX_IDENTITY`, `BBBOX_HOSTNAME`) and disk
  size with `msb modify` before anything of the box runs there. Core's
  new-guest restore from unit 11 does the rest: the stop, the undo of the
  stopped box, the swap, the access file first, the old microVM deleted once
  the new one has started.
- **Each start** mounts `/run` in memory again when it is not, and sets the
  box's hostname from `BBBOX_HOSTNAME`.
- **The fork** restores the snapshot's disk only (`--disk-only` for a
  memory snapshot) under the fork's own name, labels and identity value; a
  part-made sandbox of that name with no bb-box labels is removed first.
- **New boxes get a Docker disk of `msb`'s own.** bb-box no longer makes a
  Docker disk file or a template of one; a box made before keeps its file
  and works as before, and takes no snapshot, saying why.
- **Only with `msb` 0.7.7**: every snapshot operation is refused with any
  other, and a new doctor check, `microsandbox.snapshots`, says so.
- **Core**: `dependsOn` from the backend at each take, undo and reconcile,
  cleared from a child when its parent is deleted, and shown as "after ..."
  on a row and "taken after ..." in `bb box snapshot list`; the fork check
  reads a value marker (`forkValue`) and, where an image has no `ip`,
  addresses from `hostname -I`; a value-source box is fork-safe without SSH
  host keys; a kept snapshot of a released box forks from the snapshot on a
  backend that keeps it as is; the release's words no longer speak of an
  account and cost where nothing is charged.
- **Docs**: the microsandbox guide's Snapshots section, the snapshots
  guide, the architecture, the reference's checks, and 070.

### Tests

New: `test/microsandbox-snapshots.test.ts` (13 tests, `msb`'s recorded
answers from the probes, a set clock, and the fake msb, which now models
`msb`'s snapshots as the probes found them: parents, heads, `--force`, a
restore that keeps no settings, and `--full` refused beside a host's disk
file), among them one through bb-box's own `Snapshots` and `Boxes`: take,
restore, undo, delete a parent, keep, release and a fork check of the kept
snapshot. One app test (the row's "after"). Changed: the microsandbox
tests for the owned Docker disk, a box made before, and the launch script.

On the QEMU box (8 cores, 16 GiB, Node 24.21), in a copy whose git tree is
this unit's commit over main `cacc1dcb` before these notes (`bb136463`):
`npx tsc` passes, and the reference is current (`node scripts/reference.ts
--check`); the node suite ran 3,331 tests, 3,043 passed, 0 failed, 288
skipped; vitest ran 444, all passed with `TZ=Pacific/Auckland`. With the
box's own UTC clock at 01:17, 3 app tests failed, the same 3 on main
`cacc1dcb`: they expect "today" of a snapshot taken 2 hours before, and
"yesterday" of one 26 hours before, which is not so between midnight and
about 02:00. That is not this unit's to fix.

### On a separate BB

A fresh `npx bb-app` 0.48.1 with no account, its own data folder and
ports, started with `env -i` and `BB_BOX_LIVE_CHECKS=1`
([live-setup.sh](070-snapshots/unit-10/live-setup.sh)), in the same QEMU
box, bb-box installed from this branch with `bb plugin install path:`, and a
microsandbox backend on BB's server, the box itself, with
`bbbox/linux:1` built from this branch by `setup/docker/build.sh linux` and
`general.identityResetBackends=microsandbox`, then the steps of
[live-gates.sh](070-snapshots/unit-10/live-gates.sh), run one at a time. No
credentials were needed.
Boxes were machines of the person's, and joined BB as machines. Times are
bb-box's own, from its record or the CLI's answer.

| Check | Result |
| --- | --- |
| A box | ready in 14.7 s (importing the image 12.7 s, create 1.5 s), a BB machine 12.8 s later; identity marker 0.3 s, version 7, `source value`; Docker on `/dev/vdc`, `msb`'s own disk |
| Take with memory | 1.8 s, 2.1 GB; a counter process in the box ran on through it. The first try was "not fork-safe": the image has no SSH host keys (fixed, below) |
| Take, disk | 1.1 s, 149 MB; listed "taken after" the memory snapshot |
| Delete a parent | the memory snapshot, which the disk one was taken after: 0.39 s, with `--force`; the child then restored |
| Restore, memory | 2.08 s and, again, 2.03 s. The counter process (the same PID) was running and counting, `work.txt` "before", Docker's images as then, one microVM, the same host ID `host_qga2n8kqq9`; BB's daemon connected again 5.5 s after the restore began. The first try left the machine disconnected: the new microVM had `msb`'s default network, which does not reach BB's private address (fixed, below) |
| Undo, disk | 2.41 s: `work.txt` "after", no counter, `boot=kept` (the check ran, no reset), `/run` in memory and the hostname set by bb-box, the same host ID; the daemon connected 1.3 s after the box was ready. A box keeps two undos: the oldest was deleted |
| Fork of the memory snapshot | ready in 1.9 s, a new BB machine `host_9bh7fxzjny` 2.9 s later; the source stayed `host_qga2n8kqq9`, connected. The counter's PID was not running and its file stood still; every process was 12 s old. `boot=reset`, "the value bb-box set on this guest is not the marker's; BB machines removed: host_qga2n8kqq9"; a new machine ID and new SSH host keys; its own marker and hostname; Docker's images came with it. The first try was refused, as the image has no `ip` to read addresses, and released (fixed, below) |
| Keep | "If msb-src is released, it stays where it is until 2026-12-01." |
| Release | 0.73 s; its two undos were deleted from `msb`, the kept snapshot stayed |
| Fork of the kept snapshot after the release | ready in 2.0 s, a new BB machine `host_ye5wb5pe7g`, `boot=reset`. The first try was refused, as core forked a released box only from a held copy (fixed, below) |
| A box made before | made by `origin/main`'s bb-box (`cacc1dcb`) in the same BB, its Docker disk a host's file; then under this branch: Take refused, "It was made before bb-box could snapshot a box's Docker disk: ..."; a stop and start, a resize to 3 cores with a restart in 1.7 s, its Docker image still there, its BB machine connected; its release removed its disk file |
| Clean up | every box released; every snapshot deleted; `msb ls` and `msb snapshot list` empty for bb-box's `msb` and the probes'; no keep file; BB stopped |

### Found live, and fixed

Each with a test that fails without it:

- The images microsandbox runs have no SSH server, so no SSH host keys, and
  a take recorded no `forkSafe`. A box whose identity is a value is now
  fork-safe without them; the fork's check still requires the keys its
  reset makes.
- A restore gave the new microVM `msb`'s default network. It now gets the
  box's profiles as rules, which `msb` records as its create does.
- The fork's check could not read addresses in an image with no `ip`; it
  falls back to `hostname -I`.
- Core refused to fork a kept snapshot of a released box without a held
  copy.
- The restored microVM's disk size was not recorded, so its size read back
  without a disk; the snapshot now carries it in a label.
- A child named its deleted parent until the next sweep.

### Choices and deviations

- **The undo is of the stopped box**, as on boat.dev, not taken live
  (decided during unit 10).
- **Dependent snapshots are deleted with `--force`**, not refused (decided
  during unit 10).
- **New boxes' Docker disks are `msb`'s own**, and old boxes take no
  snapshot (decided during unit 10). The template of a Docker disk for a
  host without `mkfs.ext4` is gone, so a Mac's box formats its disk whole
  again, which 053 measured at about 0.65 s more a box with 20 at once.
- **No live check on a Mac.** Only x86_64 Linux was checked, so after the
  reviews a Mac host takes no snapshots yet.
- The fork of a kept snapshot of a released box was checked live; the
  reconcile of `msb`'s snapshots after `snapshots.db` is lost was checked on
  the fake only.

### After the reviews

Two reviews, by Opus and by Astra, each said merge after fixes. The lead
asked for all of them in one amended commit, rebased onto main `a0420ab3`
(071 unit 1, whose GPU part of a box's size the unit now uses). Each fix
has a test that fails on the reviewed sources and passes now: run with the
reviewed `src` (and only the one new constant the tests import), the 5 new
tests below failed.

| Finding | Fix | Test |
| --- | --- | --- |
| Astra 1 (high): a restored box's start wrote its access file and recorded the step `access`, past `starting`, before the box's own start command ran. bb-box restarting there left recovery to skip the start, mark the box ready, and delete the old guest | an access file written within a start keeps the restore's record at `starting`, so recovery starts the box again, and the old guest is deleted only after; its time is still said as `access`. A hold for live checks, `answered`, stops a restore at that moment | "070 unit 10 review (Astra 1): bb-box restarting after a restore's new microVM took its access file ..." |
| Astra 2: the version guard read the host's facts, kept for a minute, so an `msb` changed meanwhile could still `--force` a delete | a take, a restore, a fork, Keep and a delete each run `msb --version` first, and a delete again right before `--force` | "... (Astra 2): msb changed under a running backend is read again before every change ..." |
| Opus 1: snapshots were offered on a Mac host, where nothing was measured | refused there with "bb-box takes no snapshots of microsandbox boxes on a Mac yet: what they rest on, such as each snapshot holding its own data, was measured on Linux only", and the doctor's Snapshots check warns; a follow-up in 070 | "... (Opus 1): on a Mac host microsandbox boxes take no snapshots yet ..." |
| Opus 2: a restore put back the snapshot's disk size when the box's had grown since | the larger of the two, as a fork does | "... (Opus 2): a restore keeps the box's disk when it has grown ..." |
| Opus 3: the probe and the live script did not cover all the results claim | the reviewer's checks A to C are in the probe, and passed on a fresh box ([output](../research/box-snapshots/microsandbox-unit-10-results.txt)): a running sandbox restored from a snapshot, the snapshot and the source then deleted, the same before and after a restart; a capture of it naming the deleted snapshot as its parent, restoring the same after its own parent went with `--force`; a parent removed with `--force` while a sandbox restored from it runs, the same after a restart. [live-gates.sh](070-snapshots/unit-10/live-gates.sh) now takes a disk snapshot and deletes a parent; "A box made before" was run by hand, as the table above says, as it needs `origin/main`'s bb-box | |
| Opus 4: the old Docker disk template folder was never removed, and was counted | the upkeep's sweep of Docker disks removes it, and the status script no longer counts it | "... (Opus 4): the upkeep removes the Docker disk template ..." |

On a fresh Proxmox QEMU box with nested KVM (8 cores, 16 GiB, Node 24.21),
in a copy whose git tree is this commit's before this section: `npx tsc`
passes, and the reference is current; the node suite ran 3,355 tests, 3,067 passed, 0 failed, 288 skipped
(`8d0e12d6`); vitest ran 444, all passed, with `TZ=Pacific/Auckland`, for
the 3 clock-bound app tests said above. A first node run beside the image
build failed one timing test in `test/device-delivery.test.ts`, which this
unit does not touch, and G4's wording in `test/restore.test.ts`, which the
Astra 1 fix had changed: the in-start access is timed as `access` again, and
both passed after.

The live recheck, on a separate BB as before (`npx bb-app` 0.48.1, no
account, `BB_BOX_LIVE_CHECKS=1`, bb-box from this commit, microsandbox on
the box itself), with [live-gates.sh](070-snapshots/unit-10/live-gates.sh)
and [live-interrupt.sh](070-snapshots/unit-10/live-interrupt.sh):

| Check | Result |
| --- | --- |
| Take with memory, take of the disk | 5.1 s and 1.3 s from the command line |
| Restore, memory | 3.6 s; the counter process running, `work.txt` "before", the same host ID, one microVM; BB's daemon connected again 7.0 s after the restore began |
| Undo, disk | 3.1 s; `work.txt` "after", `boot=kept`, the same host ID; the daemon connected 4.4 s after it began |
| A restore interrupted after the new microVM took its access file | held there with `hold-next --at answered`: the new microVM had its access file and no ready file, the old one was stopped. bb-box restarted (`bb plugin reload`); recovery (`bb box sweep`, 0.64 s) started the same new microVM, which ran its start command and said it was ready, with `work.txt` "before", `boot=kept`, its BB machine connected, and only then deleted the old one. One microVM was left |
| Fork of the memory snapshot | 2.6 s; no process of its source |
| Delete a parent | 0.40 s |
| Keep, release, fork of the kept snapshot | 0.45 s, 1.1 s, 2.9 s; the fork `boot=reset` with a new host ID |
| Clean up | every box released, every snapshot deleted, `msb ls` and `msb snapshot list` empty for bb-box's `msb` and the probe's, no keep file, BB stopped, the box released |

## Unit 11: boat.dev's saved snapshots

boat.dev's saved snapshots on a paid plan, within the ceiling, and a
restore as a swap to a new sandbox. On the trial, nothing: no take, no
restore and no Keep. Forks and Keep wait for unit 11b, as the lead decided
(070, [Decided during unit 11](070-snapshots.md#decided-during-unit-11)).

### What changed

- **boat.dev's backend** offers snapshots (`src/backends/boat/snapshots.ts`
  and the backend): `snapshotting`, `planSnapshots`, `snapshot`,
  `deleteSnapshot`, `heldSnapshots`, `snapshotsOn`, `providerTask`,
  `powerOff`, `adoptSnapshot` and `snapshotBill`. The plan is read from
  `/limits`: `accessTier` and `sandboxPlanKey` say trial or paid, and a
  plan it cannot read takes nothing. A take saves the sandbox under
  `<install>-<box>-<snapshot>`, records `save:<name>` as its task before it
  asks, polls until boat says `ready`, and keeps the capture's own time
  (`GET /snapshots/{snapshotId}`) as `capturedAt` and boat's size. A save
  boat fails is deleted. A delete records `delete:<name>` and confirms the
  name is gone.
- **The restore deploys the snapshot, then copies it.** boat gives a
  sandbox deployed from a saved snapshot no labels, whatever the request
  says, and labels cannot be set later (found live, below). So
  `adoptSnapshot` deploys it into a staging sandbox named
  `bb-box:restoring:<box>:<token>`, waits until it runs, stops it (boat's
  stop takes its last capture), forks it with the box's labels and a token
  of its own (`bbbox-guest`), and deletes the staging sandbox. The staging
  sandbox is on the claimed guest's record from the moment it exists, so a
  release or a recovery deletes it, and only one with that name and no
  labels. A restored guest's reference carries the token, so it never
  equals the old sandbox's.
- **Core: a new-guest restore from a snapshot** (`fromSnapshot`): the stop,
  the undo of the stopped box, then `adoptSnapshot` in place of a rollback,
  the swap, and the old guest deleted rather than kept as an earlier guest,
  as the box's snapshots live on the account; their records follow the box
  to its new guest. Recovery after a restart uses the swap's steps.
- **Core: a release deletes snapshots that live on the provider** before
  the guest goes, and stops, deleting nothing more, if one cannot be
  deleted. With `snapshots.db` unreadable it lists them from the provider
  and refuses where a label says kept.
- **Core: a backend's own bill** (`snapshotBill`) for the ceiling, read
  before each take, restore and Keep and at each sweep, trusted for 10
  minutes; otherwise every snapshot counts at its price. A take within the
  included ones adds nothing. Takes boat has not counted yet are counted.
- **Words**: a price with an included count says "$0.056 a day past the
  plan's 10"; Settings say "Held now on the account: 3 of the 10 saved
  snapshots the plan includes, so boat.dev bills about $0.00 a month for
  those past them"; the tab's line "boat.dev $0.00 a month held (3 of the
  10 the plan includes used)"; the restore dialog and `--check` say the new
  guest and the starts it costs; Keep and fork say why not yet.
- **Live checks**: `bb box snapshot fake-included <backend> <count>`.
- Sizes below 1 GB are said in MB in core's words, as the app says them,
  not "0.0 GB".
- Docs: the boat guide's Snapshots section and clean-up check; the
  snapshots guide's offer table, restore, release and paid snapshots; 070's
  decisions and unit 11b's row.

### Tests

New: `test/boat-snapshots.test.ts` (11 tests, boat's recorded `/limits`
and `/saved-snapshots` answers from the paid account on 31 October 2026
and the trial's, a set clock, and FakeBoat, which now drops a deploy's
labels as boat does), `test/provider-snapshots.test.ts` (7, core against
the fake provider in boat's shape: the bill and its fallback, the swap and
its undo, a swap that fails, the release, Keep and fork), and two app
tests (the restore dialog's words, Settings' included count).

On a Proxmox LXC box, in a copy whose git tree is this unit's commit over
main `b7a1b4c9` (the same tree hash): `npx tsc` passes, and the reference
is current (`node scripts/reference.ts --check`); the node suite ran
3,292 tests, 3,004 passed, 0 failed, 288 skipped; vitest ran 442, all
passed.

### On a separate BB

A fresh `npx bb-app` 0.48.1 with no account, its own data folder and
ports, started with `env -i` and `BB_BOX_LIVE_CHECKS=1`, in a Proxmox LXC
box, bb-box installed from this branch with `bb plugin install path:`, and
the boat backend added with `bb box backend add boat --secret api-key=...
--secrets-file`, from a key file `box_copy` put in the box. The account is
on boat's `standard` tier, plan `box_20`, with 10 saved snapshots
included and none held at the start. Boxes were machines of the person's.
As 068 found, a BB with no account cannot make boat boxes BB machines
("Sign in to your bb account to use bb connect"), so "the same machine"
was checked by a stand-in: a random host ID written to
`~/.bb-machines/live-check/host-id` before the take.

| Check | Result |
| --- | --- |
| Template, first box | this install built its own `linux` template: the box was ready in 620 s, most of it the build; a later box in 22.5 s (fork 0.4, ready 4.2, ssh 13.6, settle 4.0 s) |
| Take, running box | 17 s on the first box, 132 s on the second (boat's fresh capture). "Price: $0.056 a day past the plan's 10." |
| Restore, first try | failed and found the bug above: the deployed sandbox had `labels: {}`, so bb-box took it for gone and left the box stopped. A probe deploy with labels only, and a `PATCH` with labels, confirmed boat drops them; both probe sandboxes deleted. The box's release then deleted its two saved snapshots, and the unlabelled sandbox was deleted by hand |
| `--check` | "stop it ...; take its undo ..., a snapshot of it stopped, about 70 s, at $0.056 a day; make it a new guest from that snapshot ...: boat counts 2 starts: 12 of 12 left this minute, at no charge within the plan's starts" |
| Restore, after the fix | 53 s: stop 2.0, undo 6.6, swap 22, start 22, access 0.2 s. `work.txt` back to "before"; the host ID file's SHA-256 the same (`940f1fbf...`), a new boot ID; the old sandbox and the staging one deleted; the new sandbox labelled with the box and its token |
| Undo | restoring "before the restore at 18:58": 176 s: stop 13, undo 97, swap 54, start 11 s; `work.txt` "after", the same host ID |
| The undo's cost in downtime | the box is stopped from the stop to the start: 53 and 176 s here, of which the undo's save was 6.6 and 97 s |
| Keep | "bb-box keeps only a snapshot it can fork after its box's release, and boat.dev boxes have no identity reset yet, so a fork of one could act as its source, and bb-box forks none until they have one. So it does not keep "before the change"." |
| Fork | "bb-box does not fork "before the change": boat.dev boxes have no identity reset yet, ..." |
| Ceiling | ceiling 1, `fake-included boat 0`: "It would bring snapshots held on boat.dev to about $6.72 a month, past your ceiling of $1.00. It would be saved snapshot 4 there, and the plan includes 0. ..." Boat still listed 3 |
| Settings and the tab | after a sweep: `paid` `{ count: 3, monthly: 0, ceiling: 1, past: false, included: { included: 10, used: 3 } }`; the tab's line "boat.dev $0.00 a month held (3 of the 10 the plan includes used)" |
| Delete | "Deleted snapshot "before the change" ...: it freed 1 MB." |
| Release | the box's two undos deleted with it; boat's `/saved-snapshots` then empty, `used: 0` |

**What it cost, from boat's figures**: the wallet went from $14.55 to
$14.54, about $0.01 of VM time. Starts used today went from 30 to 40, all
within the plan's 200 a day, at no charge (`nextStartDollars` 0). At most
3 saved snapshots were held at once, within the 10 included, so they cost
nothing; each lived under 15 minutes.

### Boat's boot order, for unit 11b

What 068 and this unit saw of how a boat sandbox starts, which unit 11b's
identity source has to fit:

- A sandbox, a fork, a resume and a deploy all start on a machine already
  running boat's base image. boat then lays the sandbox's own files over
  it after the sandbox is `ready` and reachable over SSH: system files
  within seconds, then Docker and the enabled systemd services start
  again, and the rest of the files in the background until `hydrated`.
  So nothing of the sandbox's own runs before its network: section 9's
  `Before=network-pre.target` cannot hold there.
- The address, the SSH host key and the hostname come from boat and change
  at every resume; the MAC addresses are boat's, not bb-box's, so they
  cannot be the marker's value.
- boat keeps no labels on a deploy from a saved snapshot, and labels
  cannot change; a fork keeps the labels it is given. Per-sandbox `env`
  and create-time `files` (under `/home/user` or `/tmp`, written once, at
  the first start) are the ways bb-box could set a value on each guest;
  neither was probed in this unit.
- bb-box's own daemon and Tailscale are started by bb-box over SSH on
  boat, and BB's daemon by a user unit after hydration, so a reset that
  runs when boat starts the enabled services again, before those, may be
  enough; G14 on boat has to show it.

### Choices and deviations

- **Two starts a restore, not one.** As boat drops a deploy's labels, a
  restore deploys and then forks. The plan and the dialog say 2 starts,
  and, after the reviews, a restore needs 3 left (a third puts the box back
  if the new sandbox fails), unless boat sells more.
- **The undo is taken from the stopped box** (decided during unit 11), not
  as section 5's table says.
- **Forks and Keep on boat wait for unit 11b** (decided during unit 11).
  So "Keep and its price until the keep date" was not checked live; Keep's
  refusal was.
- **"The same BB machine after"** was checked by the box's record (the
  same box ID and name, a guest reference with the new token) and a
  stand-in host ID file, as this BB cannot enrol boat boxes.
- **The ceiling's refusal live** needed `fake-included`, as the plan's 10
  included snapshots make any take within them free, and the brief allowed
  3 at once.
- A saved snapshot's size is boat's `sizeBytes`, "what it holds", shown
  as what deleting it frees, as boat bills by count, not size.

### After the reviews

Two reviews, by Opus and by Astra (with 11 probes on the fake provider),
each said merge after fixes. The lead asked for all of them in one amended
commit on main `056dcbb0`. Each has a test that fails on the reviewed
commit, `576eac35`, and passes now: run against that commit's `src`, the
8 new boat tests and 11 new core tests below failed and the unit's earlier
tests passed.

| Finding | Fix | Test |
| --- | --- | --- |
| Astra 1: a part-made guest whose delete failed was ignored, and the old guest started beside it | the part-made guest is deleted and confirmed gone (the provider no longer lists it) before the old guest starts; otherwise neither starts, and the restore stays unsettled for the sweep | "Astra 1: a part-made new guest that cannot be confirmed gone ..." |
| Astra 2, Opus 2: the old sandbox was deleted before the new one started | the old guest stays, stopped, until the new one has started and taken its access file; a new guest that does not start is deleted, confirmed, and the old one started again, or neither if it cannot be confirmed | "Astra 2: the old guest stays until the new one starts ..." and "... starts neither" |
| Opus 2: a failed staging delete threw away a restore that worked | once the copy is claimed, a failed staging delete is logged and the guest keeps the staging ID; boat's upkeep deletes staging sandboxes whose copy runs a box, or no restore has used for an hour; a release deletes its own sandbox whatever the staging delete does | "Opus 2: a deployed sandbox that cannot be deleted once its copy runs the box ..." |
| Astra 3, Opus 1: a lost create answer, or a restart, left the staging sandbox unknown; recovery at `adopt-submitting` waited for a task boat cannot give | the staging sandbox's name (box and token) is on the claimed guest before boat is asked; release and recovery find it by that name, unlabelled; recovery without a task discards and goes on | "Opus 1 and Astra 3: a deployed sandbox whose create answer was lost ..."; "Opus 5 and Astra 3: a restore cut short at its new guest ..." |
| Astra 4, Opus 3: two takes close together could both pass the ceiling | the bill names what boat lists; every snapshot bb-box holds that boat does not list yet counts beside it, taken or still taking | "Astra 4 and Opus 3: a snapshot boat has not listed yet counts ..." |
| Astra 5, Opus 6: an unread bill fell back to this install's records | the whole account, as last read, at full price; with no bill read since the start, no paid take, undo or Keep; a snapshot found again keeps its backend's price | "Astra 5 and Opus 6: an unread bill counts the account ..."; "Astra 5: a snapshot found again ... keeps its backend's price" |
| Astra 6: a release with lost records, and an ended thread's leftover, left saved snapshots | every release lists the box's saved snapshots from boat, deletes them, records or not, and lists again to confirm; an ended thread's leftover the same, before its guest goes; a record a release left is deleted at the next sweep; a living box's old guest takes none | the two "Astra 6" tests |
| Astra 7: a failed save whose delete failed was treated as holding nothing | it is incomplete, still counted, and a delete by its ID finishes it | "Astra 7: a failed save whose clean-up fails ..." |
| Astra 8: an unfamiliar tier or no plan key allowed saved snapshots | only the `standard` tier with a `box_<n>` plan; anything else takes none, with the tier and plan in the words | in "boat's recorded answers ..." |
| Astra 9, Opus 7: words | Settings: "The account holds 3 saved snapshots and the plan includes 10, so none are billed.", "... holds 12 ... so 2 are billed: about $3.36 a month.", or an estimate said as one; no ledger spend for a backend with a bill; the tab "boat.dev 3 saved, none billed"; restore "boat.dev counts 2 sandbox starts for this: free within your plan's starts, 12 of 12 left this minute"; "with the box's own identity"; the allowance kept in storage so a row's price does not change at the first read; the guides and 070 say 2 starts | the app tests "070 unit 11: ..." |
| Opus 4: 1 start left passed the check, and "at no charge" was wrong | 3 starts needed, with words that say why; past the free ones, the words say which are paid and boat's price from its first bracket | in "a restore's plan ..." |
| Opus 5: recovery chose the restore's method from the plan as it is now | the method is saved on the operation (`newGuest`) when the restore starts | "Opus 5 and Astra 3: ..." |

On a Proxmox LXC box, in a copy whose git tree is this commit's
(`c9e9af11`, before these notes): `npx tsc` passes, the reference is
current; the node suite ran 3,304 tests, 3,016 passed, 0 failed, 288
skipped; vitest ran 442, all passed.


The live recheck, on a separate BB as before (`npx bb-app` 0.48.1, no
account, `BB_BOX_LIVE_CHECKS=1`, bb-box from this commit, the same paid
account):

| Check | Result |
| --- | --- |
| A box | this install's own template build hung at its first step, fetching the pinned tools inside the sandbox (boat said the sandbox was `idle` for over 30 minutes), so it was deleted; a template another install had built with the same scripts was then forked, as 068 allows; the box was ready |
| Take | 40 s; "Price: $0.056 a day past the plan's 10." |
| `--check` | "make it a new guest from that snapshot, with the box's own identity, start it, and delete its old guest. boat.dev counts 2 sandbox starts for this: free within your plan's starts, 12 of 12 left this minute" |
| Restore | 153 s: stop 0.7, undo 121, swap 21, start 9.0, access 0.2 s. `work.txt` back to "before", the host ID file's SHA-256 the same; only the new sandbox left |
| Undo | 156 s: stop 3.5, undo 107, swap 34, start 10 s; `work.txt` "after", the same host ID |
| Settings and the tab | `paid` `{ count: 3, monthly: 0, included: { included: 10, used: 3 }, billing: "billed" }`, so "The account holds 3 saved snapshots and the plan includes 10, so none are billed."; the tab "boat.dev 3 saved, none billed" |
| Release | 1 s; boat's `/saved-snapshots` then empty, `used: 0`, and no sandbox of this install left |

What it cost, from boat's figures: the wallet went from $14.54 to $14.49
and starts today from 40 to 49, all within the plan's 200, at no charge.
The wallet and the starts are the account's, so they include anything
else on it in that hour; most of this check's share was the hung template
sandbox, about 40 minutes at the `default` size, about $0.02. At most 3
saved snapshots at once, within the 10 included.

The hung build is not this unit's: `fetch-artifacts.sh` downloads with
`curl --retry 3` and no time limit, so a stalled download waits until the
build's 90 minutes. A follow-up should give its downloads a time limit.

### After Astra's re-review

Astra's re-review of `8bb7987d` found 10 of its 11 probes no longer
reproduced, and 5 findings left. Each fix has a test from Astra's probes
that fails on `8bb7987d` and passes now.

| Finding | Fix | Test |
| --- | --- | --- |
| R1: a release reported a staging sandbox gone while it could still run | when its delete fails, the release stops it and waits until boat says it is stopped; if it cannot, the release fails, so the restore stays unsettled and the old guest is not started | "R1: a release whose deployed sandbox cannot be deleted ..." |
| R2: a new guest gone before its access file settled the restore, and the sweep deleted the old one | an access failure rolls back as a start failure does: the new guest is deleted and confirmed, and the old one put back and started, protected by the unsettled operation until then | "R2: a new guest that goes before its access file is written ..." |
| R3: an old account count could undercount | no paid take, undo or Keep without a count read just then; Settings show an estimate, said as one; the claim that the fallback never undercounts is gone from 070 and the guides | "R3: a take is refused during a bill outage ...", and the updated fallback tests |
| R4: a price for the next start did not prove 3 starts | 3 starts available in every window, free or paid up to boat's `startLimitsWithWallet` | "R4: a restore needs 3 starts available in every window ..." |
| R5: a restart mid-rollback lost the old guest's reference | the rollback is journalled as its own step, `swap-back`, before the new guest is deleted, and recovery resumes it: the box's record back on the old guest, which is started | "R5: a restart while putting the old guest back ..." |
| Settings' slot | the billed or estimated sentence sits in one block of 3 lines' height, whichever it says | in the app test "070 unit 11: Settings say ..." |

The happy path of take, restore and release did not change: these fixes
act only when a staging delete fails, an access file cannot be written, a
bill cannot be read, starts run short, or bb-box restarts mid-rollback.
So no new live check was run.

On a Proxmox LXC box, in a copy whose git tree is this commit's
(`fdb3ca7c`, before this paragraph): `npx tsc` passes, the reference is
current; the node suite ran 3,309 tests, 3,021 passed, 0 failed, 288
skipped; vitest ran 442, all passed.

## Unit 11b: boat.dev's identity reset, then its forks and Keep

boat.dev's identity source, its `linux` template built with the reset on,
gate G14 on boat.dev, then forks from a saved snapshot and Keep as it is,
on the paid plan. Built on 1 November 2026, on main `a0420ab3`, after a
live probe the lead read first (070, [Decided during unit
11b](070-snapshots.md#decided-during-unit-11b)).

### The probe

Stock `small` sandboxes on the paid account, called through boat.dev's
API from a Proxmox LXC box, each with a probe unit enabled at boot,
ordered before `network-pre.target`, SSH and the users' services, that
logged what it could read when boat.dev started it.

| Question | Per-sandbox `env` | Create-time `files` |
| --- | --- | --- |
| Where it lands | `/run/ascii-secrets/env.sh`, on tmpfs, owned by `user`, mode 600, as `export NAME="value"`; a systemd unit does not inherit it | under `/home/user`; one under `/tmp` is gone on a new machine |
| A fork | takes the value the request gives; with none, its source's | accepted with 202 and ignored: the fork kept its source's file |
| A deploy from a saved snapshot | the value the request gives | the file the request gives |
| A resume on a new machine (a resize) | kept, written again | kept, on the disk |
| Before boat.dev starts the sandbox's own services | yes: 0.6 s on a fork, 0.8 s on a deploy, 2.6 s on a resume | yes on a deploy, 0.7 s |

Two more findings shaped the build. A resume 2 s and one 3 minutes after
a stop came back on the same running machine (the same boot ID, its
uptime unbroken), so nothing started again. And boat.dev gives every new
machine its own machine ID and SSH host keys, and the host key it reports
to pin is the one in those files: a fork's were not its source's. So on
boat.dev the reset leaves both to boat.dev; renewing the keys would break
bb-box's pinned SSH.

### What changed

- **The guest program, version 8** (`bb-box-identity.sh`), for every
  image. `enable --value-file <path>` reads the value from a file, with a
  strict pattern for a box ID, never sourcing it; at a boot of an armed
  box it waits up to 30 s for the value, then compares as before, so a
  missing value counts as a copy. `enable --machine-from-provider` leaves
  the SSH host keys and machine ID to the provider in a reset, and says
  so. `wait` holds BB's daemon while the reset is on and no check has run
  on this machine. Both options live in
  `/usr/local/lib/bb-box/identity-options`; a plain `enable`, as every
  other image runs, writes none, so Proxmox's and Docker's boots are as
  they were. `customize-base.sh` passes them from the build's settings.
- **boat.dev's `linux` template turns the reset on** with
  `BOX_IDENTITY_VALUE_FILE=/run/ascii-secrets/env.sh` and
  `BOX_IDENTITY_MACHINE=provider` (`buildEnvFor`), and the template's
  fingerprint covers those settings, so a change to them rebuilds it.
  Desktop and Android templates keep it off.
- **Every sandbox bb-box makes for a box carries `BBBOX_IDENTITY`**, the
  box's ID: the fork from the template, a restore's deployed sandbox and
  its copy, and a fork's two, with the fork's own ID. A resume passes
  none, so boat.dev keeps it. `identitySource` is `value` for `linux`.
- **bb-box waits for the check before the box user**: at each acquire and
  start, as boat.dev's user, it reads `bb-box-identity status` until the
  boot says `kept`, `unarmed` or `reset` (or `off` on an image without
  the reset), starts `bb-box-identity-settle.service` itself 10 s on,
  and fails the start on `failed`. Only then does it give the box user
  its key and SSH in, join the tailnet and write the access file.
- **Forks** (`forkSnapshot`): as a restore does, it deploys the saved
  snapshot under a staging name with the fork's value, stops it, copies
  it with the fork's labels and a token, and deletes the staging sandbox;
  a fork asked again after a restart goes on with the sandbox it made, and
  one cut short before its copy settled is released first, then made
  again.
  `guestIdentity` gives no MAC addresses, and `armFork` and `disarmFork`
  do nothing, as boat.dev has no `onboot` or links. The plan offers a fork
  at the snapshot's size, needing 2 starts (`forkStartWords`), also of a
  saved snapshot whose box's sandbox is gone. The offer forks from version
  8 (`BOAT_FORK_SAFE_FROM`).
- **Core's check before ready, for a value**: where the backend's source
  is `value`, the marker must name the fork's own box ID
  (`marker_value=`), and the provider's addresses are not compared;
  everything else is unit 7's check. A MAC marker reads as before.
- **Keep as it is**: boat.dev's saved snapshots take no labels and
  cannot be renamed, so `labelKept` writes the keep date in the backend's
  own storage (`kept-saved-snapshots`), apart from `snapshots.db`;
  `heldSnapshots` gives it back as `keptUntil`, and a delete or a name
  boat.dev no longer lists clears it. Core forks a kept snapshot of a
  released box whose backend keeps it as it is, and renews it after the
  release; the card offers Keep 30 more days there too.
- **Docs**: the snapshots guide (the offer table, the value on boat.dev,
  the order there, the outside copy, forks and Keep on boat.dev), the
  boat guide's Snapshots section, and 070's decisions.

### Tests

New or changed, each with a set clock and boat.dev's recorded answers
where it calls boat.dev:

- `test/identity-reset.test.ts`, 7 for version 8: the options and their
  refusals; a boat.dev box kept at three boots on new machines with the
  file's value, not the boot's argument; a fork's value resetting BB's
  machine, the access file and the tailnet node and leaving the host keys
  and machine ID; a missing value waited for, then a reset; values that
  are not box IDs; `wait` holding while no check has run, and not when the
  reset is off; the build's settings and `customize-base.sh`'s calls.
- `test/boat-snapshots.test.ts`, 7 new: the value on every sandbox and
  through a stop and start; the fork's two sandboxes; a kept snapshot
  forking with its box's sandbox gone; the 2 starts; the keep date in the
  backend's storage; the identity check before the box user, its start
  after 10 s and a failed check; `off` on an image without the reset.
  Four changed for the offer, the plan and the restore's value.
- `test/forks.test.ts`: the value check's verdict table, with Proxmox's
  MAC check unchanged; `test/provider-snapshots.test.ts`: Keep as it is
  past a release, its renewal and its fork, and a version 7 snapshot's
  Keep refused in plain words.
- `test/fake-boat.ts` keeps each sandbox's `env` as boat.dev does.

Proxmox's behaviour does not change: its identity tests pass unchanged,
but for the version the real program reports, 7 before and 8 now, in 3
status lines of `identity-reset.test.ts`, 4 of `forks.test.ts` (one of
them now sets `forkSafeFrom` 9 to stay one above it) and 3 of
`snapshots.test.ts`. Proxmox LXC still forks from 7 and QEMU from 5.

On a Proxmox LXC box, in a clone whose git tree is this commit's
(`84fc8d64`, before this paragraph), over main `a0420ab3`: `npx tsc`
passes, and the reference is current (`node scripts/reference.ts
--check`); the node suite, which holds the docs and site checks, ran
3,353 tests, 3,065 passed, 0 failed, 288 skipped; vitest ran 443, all
passed.

### On a separate BB

A fresh `npx bb-app` 0.48.1 with no account, its own data folder and
ports, started with `env -i` and `BB_BOX_LIVE_CHECKS=1`, in a Proxmox LXC
box, bb-box from this branch with `bb plugin install path:`, the boat
backend added with `--secrets-file` from a key file `box_copy` put in the
box, and `general.identityResetBackends=boat` in that BB only. Boxes were
machines of the person's. As this BB cannot make boat.dev boxes BB
machines, a stand-in BB machine folder, `~/.bb-machines/live-check`, with
a random `host-id` and an `auth.json`, and a Tailscale state with a
profile, were written in the source before the take; the access file was
bb-box's own.

| Check | Result |
| --- | --- |
| Template, first box | this install built its own `linux` template in 6 minutes; the box was ready in 402 s (fork 0.5, ready 4.5, ssh 12.0 with the check, settle 4.2 s), its marker `value` its box ID, written in 83 ms |
| The order | the check finished at 00:48:49.824, when boat.dev's agent started the enabled units; bb-box read it at 00:48:54.199; the box user's first login 00:48:54.799; `user@1001` 00:48:55.191 |
| Stop and start | 8 and 2 s; boat.dev gave back the same machine (the same boot ID), so no check ran; the same host ID |
| Resize, `small` to `medium` | 82 s, a new machine (new boot ID, machine ID and host key, boat.dev's); `boot=kept`, the same host ID, credentials, access file and tailnet state |
| Take | 144 s, a fresh capture; `forkSafe` 8 |
| Restore swap | 178 s, a new sandbox; `boot=kept`, the same host ID; `work.txt` back to "before". The undo was deleted at once |
| Fork | ready in 34 s (start 14.5, check 0.4 s): the staging sandbox reset at 00:57:03 and removed `host_317bc0fa833d`; on the fork the host ID, credentials and tailnet state were gone, the machine ID and host key new, the marker its own; bb-box wrote its own access file at 00:57:44. The source was untouched |
| Keep | `--check`: "If src-boat is released, it stays where it is until 2026-12-01, at $0.056 a day past the plan's 10"; kept until 2026-11-03 |
| Release, then BB restarted | the source removed in 1 s; its kept snapshot listed under it, released; BB's server stopped and started again |
| Fork of the kept snapshot | ready in 30 s (check 99 ms): the staging sandbox was stopped part way through its reset, and the fork's first boot resumed it from its pending record ("resuming the reset that began at 00:58:58"), `boot=reset`, the source's host ID removed |
| Clean-up | the kept snapshot deleted, both forks removed, the backend removed, this install's template deleted through boat.dev's API; boat.dev then listed only the three templates of another install that were there before, and no saved snapshots |

The live check ran this unit's code over main `cacc1dcb`. The rebase onto
`a0420ab3` and one change after it, a fork cut short before its copy
settled now released before it is made again (with its test), came
later; neither touches what the check ran.

**G14 on boat.dev passed**: a fork resets with a new host ID, tailnet
node, SSH host keys, machine ID and access file; a stop and start, a
resize and a restore swap each keep the box's host ID with no reset; then
Keep, a release and a fork of the kept snapshot. The tailnet item was
checked as unit 7 checked it, by the reset removing Tailscale's state.

**What it cost, from boat.dev's figures**, the probe and the live check
together: the wallet went from $14.48 to $14.47; boat.dev's used credit
rose by 1,416 s, about $0.014 at its 100,000 s a dollar; starts today went
from 42 to 51 by boat.dev's counter, all within the plan's 200, at no
charge. At most 2 saved snapshots at once, within the 10 included: the
probe's for 3 minutes, the live check's for 8 and its undo for 3.

### Choices and deviations

- **Not before the network on boat.dev.** Section 9's order cannot hold
  there; bb-box gates what it controls (the box user's SSH, Tailscale, the
  access file) on the check, and BB's daemon waits by its own unit.
- **The reset leaves the SSH host keys and machine ID to boat.dev**,
  which makes both new on every machine.
- **A stop and start on boat.dev** came back on the same machine, as
  boat.dev keeps one a while after a stop, so the check did not run
  again; the resize and the restore swap showed a new machine kept.
- **The keep date lives in bb-box's storage for the backend**, not on
  boat.dev, which has no labels for saved snapshots.
- **Docker's words are as they were**: a missing value still says "the
  value bb-box set on this guest is not the marker's".

### Known limit

- **A copy made outside bb-box keeps its source's identity.** boat.dev
  gives a fork made in its dashboard or API its source's value, so it
  does not reset. The guides say so in plain words.

### Conditions and open questions

- **Arming boat.dev in production** stays the owner's call, after merge
  and a smoke test; until then no boat.dev snapshot is fork-safe there.
- **boat.dev's desktop and Android templates** have no reset, so their
  boxes neither fork nor keep; a later unit could check them.
- **A fork's plan says no price in starts** in the Fork dialog, as the
  fork plan has no cost words; the 2 starts are said in the guides.

### After the reviews

Two reviews, by Opus and by Astra, read `98c1154c`, and each said merge
after fixes. The lead asked for all of them in one amended commit on main
`a0420ab3`. This section is what holds now where it differs from the
sections above. Each fix has a test that fails on `98c1154c` and passes
now: run against that commit's `src` and `setup`, the 7 new core and guest
tests failed, and `boat-snapshots.test.ts` did not load, as it uses what
the fixes add.

| Finding | Fix | Test |
| --- | --- | --- |
| Astra 1, Opus 4: a slow start wiped a good box's identity after 30 s | only a value that differs is a copy; a value not there yet holds the box as unknown, removing nothing, while SSH, Tailscale and BB's daemon wait, and `settle` reads the file again every 2 s; bb-box's start waits, and fails after 5 minutes with why | "version 8, boat: a value missing from the file never counts the box as a copy ..." |
| Opus 4: a box that reset with no marker stayed unarmed, and the words named interfaces | the unarm names `BBBOX_IDENTITY`; at the box's next start bb-box writes the marker again, on a value-source backend that is armed, only after a reset (`boot=reset`, marker missing), never for a box unarmed by hand or a Proxmox box | "version 8, boat: a box that reset with no value ..."; "Opus 4: a value-source box that a reset left with no marker ..." |
| Astra 2, Opus 5: a fork joined the tailnet and let the box user in before core's check | a boat fork starts only as far as its identity check (`startForForkCheck`), as boat.dev's `user`, and refuses a boot of `unarmed` or `off`; core reads the check through `forkCheckCommand`, as that user; the box user's SSH, settle and the tailnet join run only at `armFork("boot")`, after the check; the access file comes after | "Astra 2 and Opus 5: a fork starts only as far as its identity check ..." (boat) and "... core checks it through the backend's own check command ..." (core) |
| Opus 3: with a plain `enable`, `wait` held BB's daemon when no check had run | `wait` holds on no result only with a value file, so Proxmox's `wait` is version 7's | "version 8 on Proxmox: with a plain enable, wait goes on at once ..." |
| Opus 1: removing the backend left saved snapshots costing | a save that removes a backend whose snapshots live on its provider lists the provider's snapshots of this install first, kept or not, and refuses, naming them and how to delete them, or refuses if it cannot list them; only such a save asks the provider; the boat guide's "Turn it off" says so | "Opus 1: a backend whose snapshots live on its provider cannot be removed ..." |
| Astra 4, Opus 2: Keep dates could be lost | every change to the backend's record of saved snapshots goes through one queue; a name is cleared only when boat.dev answers that it has no saved snapshot by that name; a list answer with no array is an error, and changes nothing | "Astra 4 and Opus 2: Keep dates go through one queue ..." |
| Astra 3: upkeep deleted a fork's staging sandbox while the fork was made | upkeep skips a staging sandbox this process is still using, and counts one as done only when its copy exists, labelled with its box and token | "Astra 3: upkeep never deletes a fork's staging sandbox ..." |
| Astra 5: a kept snapshot found again could not fork | the backend's record of each saved snapshot (`saved-snapshot-facts`) holds the keep date, the identity reset's version from the take and the box's owner (kind, name, thread), and boat.dev's list gives them back after the box's sandbox is gone | "Astra 5: what a fork of a kept snapshot needs ..." |
| Astra 6: found again past its keep date, a paid snapshot stayed with no end | a snapshot found again on a backend whose snapshots live on its provider keeps its keep date even when it has passed, so expiry deletes it; Proxmox's found snapshots are as they were | "Astra 6: a provider's kept snapshot found again ... past its keep date ..." |

The fork's start changed: on boat.dev, a fork's timings say "identity
check" for its start up to the check, and a start of any boat box says it
before "ssh". So a short live recheck of a fork, a Keep and a release was
run, below.

The live recheck, on a separate BB as before (`npx bb-app` 0.48.1, no
account, `BB_BOX_LIVE_CHECKS=1`, bb-box from this commit, boat armed in
that BB only):

| Check | Result |
| --- | --- |
| Template, first box | this install built its own `linux` template; boat.dev's machine was slow (a load of 15 while it installed packages), so the box was ready in 1,243 s; the box's marker its own value |
| Take | 128 s; `forkSafe` 8 |
| Fork | ready in 224 s, most of it boat.dev's capture of the staging sandbox as it stopped (start 13.2, of which identity check 4.1, check 0.3 s); the fork reset at its first boot (`boot=reset`, the stand-in host ID removed); the order: boat.dev's `user` in at 02:25:27.202, the reset finished at 02:25:30.164, bb-box's gate and core's check read it as `user` at 02:25:30.227 and 02:25:30.415, the box user's first login at 02:25:30.941 and its manager at 02:25:31.315; the fork's own access file written at 02:25:44 |
| Keep, then release | kept until 2026-11-03; the source removed in 1 s, the kept snapshot listed under it, released |
| Removing the backend | refused twice, naming the snapshot: by its record, and by boat.dev's list ("Backend boat has 1 snapshot on its provider's account, kept or not, ... "before-change" ... kept until 2026-11-03"); with its records forgotten (`bb box snapshot forget`), still refused by boat.dev's list, by its saved name and keep date; once it was deleted, removed |
| Clean-up | the fork removed, the saved snapshot deleted, this install's template deleted; boat.dev then listed only the three templates of another install, and no saved snapshots |

What it cost, from boat.dev's figures: the wallet went from $14.47 to
$14.45; used credit rose by 1,441 s, about $0.014, most of it the slow
template build; starts within the plan, at no charge. One saved snapshot,
held for 6 minutes.

On a Proxmox LXC box, in a git tree of this commit's files (`a54fcae4`,
before these notes): `npx tsc` passes, the reference is current; the node
suite ran 3,363 tests, 3,075 passed, 0 failed, 288 skipped; vitest ran
443, all passed.

**Rebased onto unit 10** (main `cbad0e4d`, microsandbox's snapshots),
which had added the same check of a value marker in core. This unit now
uses unit 10's: the fork's value comes from `guestIdentity`, which on
boat.dev gives the box's ID, and a marker holding its source's value is
refused at once. A backend now says its guest's address is the provider's
endpoint (`addressIsAnEndpoint`), as boat.dev does, so only there are
the addresses left out of the check; microsandbox's are compared as unit
10 has them. The guides' Keep and release paragraphs name both backends.
Nothing in the fork or Keep path changed in what it does on boat.dev, so
the live recheck above stands.

On a Proxmox LXC box, in a git tree of the rebased commit's files: `npx
tsc` passes, the reference is current; the node suite ran 3,381 tests,
3,092 passed, 1 failed, 288 skipped, the failure a boat test that pinned
`guestIdentity`'s answer without its value, since updated and passing
with its file (27 of 27); vitest ran 444, all passed.

## Close-out A: microsandbox snapshots on a Mac

Unit 10 turned microsandbox snapshots off on a Mac host, as what they rest
on was measured on Linux only. This measures it on a Mac and turns them on
there, with the version guard kept. On the way it found that `msb` refuses
a snapshot's ID whenever its home is reached through a link, which bb-box's
own wrapper does on Linux too, so bb-box now names each snapshot by its
group and member. Decisions are in 070, [Decided during the
close-out](070-snapshots.md#decided-during-the-close-out).

### The probe on a Mac

Unit 10's probe could not run on a Mac as it was: it needs GNU `date`,
`mkfs.ext4` and `python3`. [microsandbox-mac.sh](../research/box-snapshots/microsandbox-mac.sh)
runs on a Mac and on Linux. It downloads its own `msb` 0.7.7, checks its
SHA-256 against bb-box's pin, and runs it with an `MSB_HOME` of its own,
never bb-box's `msb` or home. It needs no sudo, `python3` or `osascript`,
prints no paths or names, and on exit removes every sandbox and snapshot it
made, then its folder. It runs unit 10's checks and the reviewers' checks A
to C, adds the memory checks, and check E, bb-box's own commands.

The lead ran it on the production Mac host, as its user, in `/tmp`, on the
same volume as bb-box's `msb` folder: macOS 27.0.1, Apple M4 Max, 128 GiB,
APFS on the internal SSD, 340 GiB free. Each version passed first on a
nested-KVM Proxmox QEMU Linux box. Five runs:

| Run | Result | What it showed |
| --- | --- | --- |
| 1 | 12 passed, 3 failed | The data checks held: a chain of three restored byte for byte with both parents removed with `--force`, and checks A to C. The 3 failures measured nothing: the counter process never started on the Mac, and `--disk-only` printed no reason |
| 2 | 13 passed, 3 failed, 1 skipped | The cause was a terminal, not `msb`: from an interactive shell `msb exec` gave the sandbox a PTY, so every read ended in a carriage return ("x\r" is not "x"), and the PTY's hangup ended the counter. Run 2's script under a PTY on Linux (`script -qec`) gave the same pattern |
| 3 | 17 of 17 | With `msb exec --no-tty` and stdin from `/dev/null`, as bb-box runs `msb`. But its clean-up, which removes snapshots by ID, left 5 on the Mac and none on Linux |
| 4 | 19 passed, 3 failed | Removal by ID, as bb-box's delete did, failed on the Mac: "snapshot identity <ID> has 2 local copies; use group:member or an explicit artifact path" |
| 5 | 29 of 29 | Check E: bb-box's own commands by group and member (create with `--group` and `--label`, inspect, restore, `restore --disk-only` as a fork does, head, remove with `--force` of a parent, remove of an old head once another is head, remove of the last one after its sandboxes went, then nothing listed), once with `MSB_HOME` through a link and once through its real path. By ID, inspect failed through the link and worked through the real path |

Run 5 on the Mac ([output](../research/box-snapshots/microsandbox-mac-results.txt)),
times from the probe's own clock: a take with memory 0.78 s and of the disk
0.22 s; a memory restore 0.20 s, with the counter process running and
counting on from 12, its value at the take; the memory snapshot's disk
alone, booted as a fork boots it, 0.26 s, with the files byte for byte and
the counter still at 12; a disk restore at another size 0.28 s; removals
0.06 s each.

### Why "2 local copies"

On a Mac `/tmp` is a link to `/private/tmp`, so the probe's home was always
reached through one. Where `msb`'s home is a link, `msb` indexes each
snapshot under the link's path and the real one, and then refuses to pick
one by ID in `snapshot inspect`, `restore` and `remove`. Reproduced on
Linux the moment `MSB_HOME` is a link; by group and member all three work.
bb-box's wrapper reaches a home longer than 57 bytes through
`/tmp/bb-box-msb-<uid>`, as for a BB machine's own data folder, so a Linux
host with a long folder took snapshots before this that it could not
restore, fork or delete, and a release of such a box stopped at its
snapshots. bb-box's size read of a snapshot (`inspect`) failed there too,
and fell back to the box's size.

### What changed

- **Mac hosts take snapshots.** The refusal on a Mac is gone from the plan,
  every change and the doctor's Snapshots check, which says "ok" on a Mac
  with `msb` 0.7.7. The version guard stays as it was: every change reads
  `msb --version` first.
- **A snapshot is named by its group and member** (`groupMember`,
  `bbbox-<box ID>:<name>`) in `snapshot inspect`, `restore`, which forks
  use too, and `remove`, and when a new head is chosen. bb-box's own files
  (keep dates, sizes) stay keyed by the ID.
- **Docs**: the snapshots guide and the microsandbox guide say Linux hosts
  and Macs; the architecture says why bb-box names snapshots so; the probe
  and its Mac output are in the research folder; 070's decisions.

### Tests

In `test/microsandbox-snapshots.test.ts`, the fake `msb` refuses an ID as
the Mac did when its home is reached through a link (`homeThroughLink`):

- "a Mac host's microsandbox boxes take and delete snapshots, as the probe
  on a Mac measured, and the doctor says so; another msb is still
  refused", in place of unit 10's test of the refusal;
- "where msb's home is reached through a link ... bb-box names each by
  group and member to inspect, restore, fork and delete it": two snapshots,
  a restore, a fork, the parent deleted with `--force`, the last deleted,
  and no `msb` call with an ID.

Both fail on main's sources; both fail too with the Mac refusal lifted
alone. Two tests of unit 10 that pinned the ID in `remove` and `restore`
now pin group and member.

On a Proxmox LXC box (8 cores, 16 GiB, Node 24.21), in a git checkout of
this commit: `npx tsc` passes and the reference is current (`node
scripts/reference.ts --check`); the node suite ran 3,494 tests, 3,175
passed, 0 failed, 319 skipped; vitest ran 445, all passed, with
`TZ=Pacific/Auckland`.

### On a separate BB

The lead keeps a second microsandbox install off the owner's Mac, so the
live check through bb-box ran on Linux, through the link: a fresh `npx
bb-app` 0.48.1 with no account and `BB_BOX_LIVE_CHECKS=1` in a nested-KVM
Proxmox QEMU box (8 cores, 16 GiB), bb-box from this branch, microsandbox
on BB's server, with `HOME` long enough that `msb`'s home is 81 bytes, so
bb-box reached it through `/tmp/bb-box-msb-1000`
([live-linked-home.sh](070-snapshots/close-out/live-linked-home.sh), which
runs unit 10's own [live-setup.sh](070-snapshots/unit-10/live-setup.sh) and
[live-gates.sh](070-snapshots/unit-10/live-gates.sh) unchanged). Boxes were
machines of the person's and joined BB as machines. Times are bb-box's own.

| Check | Result |
| --- | --- |
| A box | ready in 235 s, most of it importing the image into a new `msb` home; `boot=unarmed`, its own marker |
| Take with memory, take of the disk | 3.4 s and 0.71 s |
| Restore, memory | 2.7 s: the counter process running, the same host ID, one microVM; BB's daemon connected again 6.8 s after the restore began |
| Fork of the memory snapshot | 2.8 s, a new BB machine; `boot=reset`, "BB machines removed" naming the source's host ID; no process of its source; new SSH host keys |
| Undo, disk | 2.5 s; `boot=kept`, the same host ID; the daemon connected 3.7 s after it began |
| Take a parent and its child, delete the parent | 0.68, 0.69 and 0.38 s |
| Keep, release | 0.38 s and 0.89 s; the kept snapshot listed after the release |
| Fork of the kept snapshot after the release | 2.3 s, `boot=reset`, a new host ID |
| Clean up | every box released, every snapshot deleted: "There are no snapshots", `msb ls` "No sandboxes found", `msb snapshot list` "No snapshots indexed", no keep file; the link in place throughout |
| Main's bb-box, in the same BB, through the same link | `origin/main`'s bb-box (`b15fe055`) installed from a checkout; the release of a box holding one snapshot stopped: "bb-box could not confirm the delete of snapshot ... msb snapshot remove failed: exit code 1. It checks again at its next sweep". With this branch's bb-box installed again, the sweep finished that release; `msb` then listed no sandboxes and no snapshots |

### After merge

The lead takes, restores, forks and deletes a snapshot on production's own
microsandbox backend on that Mac, releases the box and sees nothing
listed, and rolls back if anything is wrong.

## Close-out B: Tart's Linux boxes fork and are kept

Unit 9 shipped Tart's Linux VMs with takes and restores only, as their
identity reset was not checked live. This checks it live, turns it on in
their image, and offers fork and Keep for Tart's plain Linux boxes, as for
macOS. Decisions are in 070, [Decided during the
close-out](070-snapshots.md#decided-during-the-close-out).

### What the live check found first

- **The image had the reset off.** `prepare-linux-image.sh` installs
  `bb-box-identity` through `customize-base.sh`, which turns it on only with
  `BOX_IDENTITY_RESET=on`, and the script never set it. So no Tart Linux box
  was fork-safe, whatever bb-box offered. It sets it now for the plain image.
- **A stopped take was never fork-safe.** With the image fixed, the first
  live fork was refused: "tl-src had no working identity reset when
  'before' was taken". Core reads fork-safety from inside a ready box at
  each take, and Tart takes a Linux box only while it is stopped. A macOS
  box taken while stopped had the same gap. The fake Mac's tests had passed
  `forkSafe` in by hand, so they missed it. bb-box's own stop now reads it.

### What changed

- **Tart's offer** (`src/backends/tart/snapshots.ts`, the backend): the
  `linux-arm64` kind forks by copy and keeps as it is, from version 8 of
  the reset (`LINUX_FORK_SAFE_FROM`); its identity source is `device`, the
  VM card's MAC address. `linux-arm64-desktop-cpu` neither forks nor keeps,
  with why (`LINUX_DESKTOP_NO_FORKS`). The plan reads the fork rules from the
  offer, and a Linux snapshot taken without the reset says "which boxes
  from a Linux image refreshed since have". The "macOS forks" doctor check,
  about `diskutil image attach`, runs only for macOS kinds.
- **A Linux fork** copies the snapshot's files into a VM of its own,
  claimed first, with a new MAC address (`tart set --random-mac`) and the
  fork's size, names it a Linux guest, and cleans nothing on the Mac.
- **The image**: `prepare-linux-image.sh` sets `BOX_IDENTITY_RESET=on` for
  the plain image and off with `--desktop`.
- **Core**: where a backend's snapshots are taken from a stopped box
  (`readsForkSafetyAtStop`: it forks, and its snapshots are `stopped-only`
  or `suspends`), bb-box's stop reads the reset from inside the box just
  before it stops it, and keeps it on the box's record (`stopForkSafety`)
  once the stop has succeeded, with the stopped guest's mark; any write of
  the record in another state than stopped, or with a restore under way,
  drops it. A take of a stopped box uses it while the mark is the same
  (since the reviews, below). The fork and Keep refusals of a
  snapshot that is not fork-safe, there, add `STOPPED_ANOTHER_WAY`: "A
  snapshot of a stopped box is fork-safe only when bb-box stopped the box,
  as it reads the identity reset just before its stop: start the box, stop
  it with bb-box and take the snapshot again."
- **Docs**: the snapshots guide (the offer table, which images have the
  reset on, the stop rule), the Tart guide's Snapshots section, 070.

### Tests

- `test/tart-snapshots.test.ts`: the offers test, now with Linux forks and
  Keep and the desktop's refusal; "a Linux VM's snapshot forks into a VM of
  its own with a new MAC address ... nothing to clean on the Mac", with
  `diskutil` unable to attach; "a Linux VM's snapshot taken before its box
  had the identity reset does not fork ... a Linux desktop forks none"; and
  one through bb-box's own `Boxes` and `Snapshots` with the real Linux reset
  program in a test root, reached through the fake Mac's guest: core writes
  the marker at acquire, bb-box's stop reads version 8, the stopped take
  records it, the plan offers the fork, Keep takes it, and a box stopped
  outside bb-box takes a snapshot that is not fork-safe.
- `test/beside-snapshots.test.ts`: in core, bb-box's stop reads the reset
  where snapshots suspend the box, a stopped take uses it and keeps, a
  start forgets it, a box stopped another way takes one that neither keeps
  nor forks, with the words; where snapshots are taken live, the stop reads
  nothing.
- `test/identity-reset.test.ts`: Tart's Linux build turns the reset on for
  the plain image and off for the desktop.

Run against unit A's commit with only these tests swapped in, and the
three constants they import added so they load, 6 of the 7 new or changed
tests failed; the seventh, that a stop reads nothing where snapshots are
taken from a running box, guards that nothing changes there.

On a Proxmox LXC box (8 cores, 16 GiB, Node 24.21), in a git checkout of
this commit with the done note: `npx tsc` passes and the reference is
current; the node suite ran 3,499 tests, 3,180 passed, 0 failed, 319
skipped; vitest ran 445, all passed, with `TZ=Pacific/Auckland`.

### On a separate BB

A fresh `npx bb-app` 0.48.1 with no account, its own data folder and ports,
`env -i` and `BB_BOX_LIVE_CHECKS=1`, in a Proxmox LXC box, bb-box installed
from this branch with `bb plugin install path:`, by
[tart-linux-setup.sh](070-snapshots/close-out/tart-linux-setup.sh). The
lead gave it a Tart backend of its own install on the production Tart Mac,
as in unit 9, with that backend's SSH key put in the box as a file, deleted
once the backend was added; every kind off but `linux-arm64`, warm VMs off,
`reserve-disk-gib` 60, `general.identityResetBackends` `tart`. The Mac:
macOS 27.0.1, Tart 2.40.1. One VM of this install's ran at a time; no other
VM was touched.

The image was built from this branch's `prepare-linux-image.sh` on the Mac
as its user, under a name of its own, from the base the production image
names, already cached, so nothing was pulled, renamed or pruned (070, the
close-out's decisions say why not bb-box's own image build): 2 minutes 24
seconds, 4.7 GB; its box-user checks passed, and the doctor read it as a
standard image build.

As in unit 9, a BB with no account cannot make the boxes BB machines, so
the BB machine was stood in for by a random host ID in
`~/.bb-machines/live-check/host-id`, and the tailnet node by a file in
`/var/lib/tailscale`. The steps are
[tart-linux-gates.sh](070-snapshots/close-out/tart-linux-gates.sh). Times
are the CLI's.

| Check | Result |
| --- | --- |
| A box | ready in 4.8 s by bb-box's timings, identity marker 65 ms; 15.9 s for the command, the rest its first try to join a BB it cannot reach; `bb-box-identity status`: version 8, on, `boot=unarmed`, `marker=matches`, armed, `source=device`; its unit is ordered before `ssh`, `ssh.socket`, `systemd-networkd`, `tailscaled` and the box user's `user@` |
| Stop, take stopped, start | 16.1 s, 0.7 s and 4.2 s |
| Restore, undo | 20.8 s and 21.1 s, each a shutdown, the copy put back and a boot: `work.txt` "before", then "after"; the same host ID, machine ID and SSH host key; `boot=kept` |
| Fork, as one of the person's machines | ready in 4.6 s (5.5 s for the command), after core's check before ready. In the fork: `boot=reset`, "none of the marker's MAC addresses (0e:ac:...) is on this box's interfaces (1e:de:...); BB machines removed: <the stand-in host ID>"; no host ID file, no Tailscale state; a new machine ID and SSH host key; its own marker and hostname; `work.txt` "before". The order in its boot: the reset done at 1.45 s, `systemd-networkd` active at 1.55 s, `ssh` at 1.58 s and the box user's `user@1002` at 1.66 s, which is ordered after it |
| The source after its fork | unchanged: the same host ID, Tailscale state, machine ID, SSH host key and MAC address, `boot=kept`, `marker=matches` |
| Keep, release | 0.6 s; the source released in 1.2 s, its kept snapshot listed after |
| Fork of the kept snapshot after the release | ready in 4.6 s (5.4 s for the command): `boot=reset`, no host ID file, a new machine ID and SSH host key, `work.txt` "before" |
| Clean up | every machine released, the kept snapshot deleted, a sweep: no snapshots, no machines; the test backend removed. The lead then deleted the image and its two folders on the Mac with `TART_NO_AUTO_PRUNE=1`, and confirmed no VM, owner file or snapshot of this install's there, and production's own Linux images untouched |

### Known limits

- A box from a Tart Linux image prepared before this unit has the reset
  off, so its snapshots neither fork nor keep until the image is refreshed
  and the box made again.
- A box stopped other than by bb-box, shut down from inside or by the Mac,
  takes snapshots that neither fork nor keep, until bb-box starts and stops
  it.
- A Linux fork's disk is not cleaned on the Mac, as a macOS fork's is: it
  relies on systemd's order, measured above, and on its source's reset
  having been on at the take.
- bb-box's stop of a Tart box now waits for the reading first, a moment
  when the box answers and up to 10 s when it does not, and then reads the
  stopped VM's mark on the Mac.
- A Tart box stopped by bb-box whose VM folder is touched while it is
  stopped, by `tart set` say, also loses its reading: it fails closed.

### After the reviews

Opus and Astra each said merge after fixes. The lead asked for these, in
the same commits rebased onto main `93c25d53`, each with a test that fails
before it:

| Finding | What changed | Test |
| --- | --- | --- |
| Astra's high, Opus 2: a reading survived a start and stop outside bb-box between sweeps, and a failed stop observed as stopped kept it | The reading is kept only once bb-box's stop has succeeded, with the backend's mark of the stopped guest (`stoppedMark`), and a take uses it only while the mark is the same. On Tart the mark is each VM file's modification time and size (`config.json`, `nvram.bin`, `disk.img`, `state.vzvmsave`), read on the Mac; a run writes them, as the firmware writes the NVRAM at each boot. A backend with no mark keeps no reading | "a box bb-box stopped that then ran outside bb-box ... is not fork-safe", "a stop that failed, though the guest stopped, keeps no reading", and the fake Mac test, whose fake `tart run` now touches `nvram.bin` |
| Opus 1, Astra's low: an older image's box was told to stop it with bb-box, which cannot help | A reading that found the reset off or missing is kept as such; a snapshot records why it is not fork-safe (`forkSafeWhy`, a new column in `snapshots.db`); `reset-off` refusals say "refresh the Linux image and make the box again" (or, for macOS, "make the box again"), and only `unread` ones say to stop it with bb-box | "a box whose reset was off when bb-box stopped it ... refresh the Linux image", and unit 8's Keep tests in core and the CLI, whose box has no reset program, now expect those words |
| Opus 3: an in-place restore left stopped kept the reading of the earlier disk | Any write of the box's record with a restore under way drops the reading | "a restore drops the stopped box's reading as it begins" |

Run against the rebased commit's sources with only these tests and fakes
swapped in, and `resetOffWords` added so they load, all 6 failed.

On a Proxmox LXC box (8 cores, 16 GiB, Node 24.21), in a git checkout of
the three commits on main `93c25d53`: `npx tsc` passes and the reference is
current; the node suite ran 3,504 tests, 3,185 passed, 0 failed, 319
skipped; vitest ran 448, all passed, with `TZ=Pacific/Auckland`. At unit A's
commit alone: 3,495 tests, 3,176 passed, 0 failed, 319 skipped; vitest 448.

The stop and the take each gain one call to the Mac, `stoppedMark`, besides
the reading; nothing else in either path changed. It was run on the fake
Mac, whose scripts run in a real shell with GNU `stat`; on a Mac's BSD
`stat` it reads `%Fm` and `%z`, which was not run live.

### After merge

The lead refreshes production's `linux-arm64` image on the Tart Mac, which
production arms already, and forks one box to check.
