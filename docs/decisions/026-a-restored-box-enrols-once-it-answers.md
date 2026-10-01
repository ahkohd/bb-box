# 026: A restored box enrols once it answers

Status: accepted, 1 October 2026. Partly supersedes
[025](025-a-restored-box-enrols-again.md): when a restored box that did not
answer enrols.

## Context

Under 025 a restored box enrols only if, at the restore, its guest runs and
its command transport answers. A box restored stopped, or whose guest did
not answer, kept enrolment off. bb-box could not tell it from a box whose
machine was removed in BB, which must stay removed. So the thread could not
use it as a machine, and if BB still had its machine, the box's release did
not remove it.

When the sweep releases the guest of an ended thread whose record was lost,
nothing removes that box's machine either. bb-box made it with the box ID
as the key, but BB 0.44 gives a plugin no way to find a machine by its key:

- a machine does not show its key, and `hosts.list` and `hosts.get` cannot
  look one up by it
- `hosts.experimental_create` with the key makes a new machine when BB has
  none, as after someone removed it

## Decision

- The sweep marks each record it restores with `restoredAt`, the time of
  the restore. The mark stays until the box starts enrolling.
- A marked box enrols with its box ID as the key when bb-box starts it, or
  when a sweep finds it ready and its command transport answering. The
  sweep then clears the error the restore gave a guest that did not answer.
  The enrolment is timed from then, and the log says "after bb-box found
  the restored box answering".
- Only the mark lets a box enrol other than after its acquire. A box whose
  machine was removed in BB has enrolment off and no mark, so it stays off.
- While `enrol-boxes` is off, the sweep does not check marked boxes.
- When the sweep releases a guest of an ended thread whose record was lost,
  the box's machine stays in BB until BB can find a machine by its key
  ([request 6](../bb-requests.md#6-find-a-machine-by-its-key)). Such guests
  follow only lost plugin storage, which upgrades no longer cause
  ([019](019-lost-records-are-restored-from-guests.md)).

## Consequences

- A restored box whose kind can enrol becomes a BB machine again once it
  runs and answers, and its release then removes the machine.
- A restored box released before it enrols again leaves its machine in BB,
  if BB still has it.
- `box_status` says when a box is waiting to enrol again after a restore.
- A machine that was removed in BB is made again only for a box restored
  after the removal, as under 025.
