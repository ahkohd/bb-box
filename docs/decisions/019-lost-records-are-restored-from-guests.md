# 019: The sweep restores lost records, and only BB ends a thread

Status: accepted, 30 September 2026. Extends
[018](018-guests-name-their-install-and-box.md). Partly superseded by
[025](025-a-restored-box-enrols-again.md): whether a restored box is a BB
machine.

## Context

bb-box was removed and installed again while one of its boxes was running
for an active thread. The operator took the install ID back straight away,
as 018 describes. The box's guest carried the install ID and named its box
and thread. Within seconds the sweep released it.

Two rules in the sweep allowed this:

- It counted any 404, and any error code ending in `not_found`, as a
  thread that no longer exists. BB answers 404 for other things too, such
  as a plugin it does not know. An error that said nothing about the
  thread ended it, and the thread's boxes were released.
- It released a guest that no record named unless BB confirmed that its
  thread was live. An error from BB was enough to release it.

## Decision

A thread has ended only when BB says so: `threads.get` returns the thread
with `archivedAt` or `deletedAt` set, or fails with BB's `thread_not_found`
code. Any other answer, another 404 included, leaves the thread's boxes
alone until a later sweep.

No guest is released because its record is missing. For each of this
install's guests that no record names, the sweep:

| The guest | What the sweep does |
| --- | --- |
| names no box, as after an acquire interrupted before its claim was labelled | releases it |
| names a box whose record now holds another guest or none, and is not acquiring | releases it |
| names a box with no record, and BB says its thread is live | restores the box's record from the guest |
| names a box with no record, and BB says its thread ended | releases it |
| names a box with no record, and BB does not say | keeps it, and asks again at the next sweep |

A restored record takes the box's ID, thread, name, kind and creation time
from the guest's labels, the project from BB, and its state from the
guest's power. A running guest whose command transport does not answer is
restored as ready with an error that says to stop and start it.

The sweep logs every guest it releases, restores or keeps, with the reason,
so `bb plugin logs bb-box` shows why a guest went.

## Consequences

- A backend's `held()` must name each guest's box, thread, name, kind and
  creation time from the guest itself. The conformance suite checks that a
  new instance on empty storage with the same install ID does.
- The registry can be rebuilt from the guests alone. A restored box is not
  a BB machine again; its commands run through bb-box's transports.
- A guest of an ended thread stays until BB answers. When BB cannot be
  reached for a long time, such guests keep their capacity.
- Upgrading bb-box never needs `bb plugin remove`, which deletes its
  settings and secrets. The README says how to upgrade each kind of install.
