# 036: Your machines are boxes you own, kept as BB machines

Status: accepted, 1 October 2026. Extends
[032](032-spare-boxes-are-enrolled-ahead.md): a spare that a thread starts
on through BB's picker becomes yours.

## Context

"New box" ([033](033-a-thread-can-start-on-a-new-box.md)) is hard to find
in BB's new-thread picker. The operator asked to add boxes in BB Box's
settings, as machines in BB's list and sidebar, like any other (#144).

## Decision

**Owner.** A box can belong to you, not to a thread. Its record is a box
record of the reserved thread `operator`, as spares are of `spare` (032),
with no project and role "box". BB's thread IDs never take that form. You
name it when you add it: a hostname label, unique among your machines.
That name is also its BB machine's name. It is outside the per-thread
limit, and counts against a backend's room like any box.

**Adding and removing.** BB Box's settings list your machines and add one
of any kind that can enrol, at any size, desktops included. Adding goes
through acquire, so it takes a spare when one fits, renamed. It enrols
under its box ID, whatever the general enrolment setting. It is removed
only in settings, or by removing its machine in BB.
[034](034-a-working-thread-holds-its-box.md) applies: settings asks before
removing or stopping one a thread is working on.

**Lifecycle.**

- The sweep never releases it, as its thread `operator` is always live.
- A lost record is restored from the guest's owner label
  ([019](019-lost-records-are-restored-from-guests.md)) to you, with its
  name. The box enrols again under its ID, and BB gives back its machine
  ([025](025-a-restored-box-enrols-again.md)).
- After a start it reconnects as any enrolled box does
  ([017](017-boxes-clear-bb-daemon-state-at-boot.md)).
- When you remove its machine in BB, bb-box releases the box. `remove`
  first clears the box's machine, so the release does not delete it
  again, which would wait on BB's removal (as found in #125).

**Where it shows.**

- BB's machine list, sidebar and new-thread picker, under your name.
- In a thread that runs on a box's machine, `box_list` and the Box panel
  show that box as "the machine this thread runs on", and the box tools
  take it. `box_release` and `box_stop` refuse it, and point to settings.
- The Desktops page lists your machines' desktops under "Your machines".

**Spare guard.** A spare whose machine gets a thread through BB's picker
becomes yours. A claim skips it, and the next spare upkeep moves it to
you, with the "(spare)" dropped from its machine's name, and makes a new
spare. A thread counts while it is neither archived nor deleted.

## Consequences

- One way to keep a box as a machine, which you can see and remove.
- A spare you start a thread on stays until you remove it in settings.
- Kinds that cannot enrol, such as Windows, cannot be your machines yet.
