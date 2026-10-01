# 025: A restored box enrols again, keyed by its box ID

Status: accepted, 1 October 2026. Partly supersedes
[019](019-lost-records-are-restored-from-guests.md): whether a restored box
is a BB machine.

## Context

Since 019 the sweep restores a lost box record from its guest's labels. The
restored record had enrolment off, so the box was no longer a BB machine:

- the thread could not use it as a machine, and its commands ran only
  through bb-box's transports
- if BB still had the box's machine, nothing removed it, since the box's
  release no longer knew it

bb-box creates a box's machine with the box ID as the key
([014](014-enrol-through-machine-providers.md)). BB's create is idempotent
by key. While BB has a machine with that key, create returns that machine
rather than making another. Once BB has removed it, create makes a new one
with the same key.

## Decision

- When the sweep restores a box whose guest runs and whose command
  transport answers, and `enrol-boxes` is on, bb-box enrols the box again
  with its box ID as the key, as it does after an acquire.
- If BB still has the machine, the box gets it back. If BB shows that
  machine disconnected, as after the box restarted, bootstrap runs with the
  same key to start BB's daemon again
  ([017](017-boxes-clear-bb-daemon-state-at-boot.md)). If BB no longer has
  the machine, BB makes it again.
- The enrolment is timed from the restore, not from the box's creation,
  which the restored record takes as its ready time. The log says "after
  the sweep restored it".
- A box that is restored stopped, or whose guest did not answer, is not
  enrolled.

## Consequences

- A restored box is a machine the thread can use again, and the thread's
  access is set up in it again.
- Releasing a restored box that enrolled again removes its machine from BB.
- A box restored stopped does not enrol when it starts again. bb-box cannot
  tell it from a box whose machine was removed in BB, and that machine must
  stay removed. If BB still has its machine, the machine stays in BB after
  the box is released, as before.
