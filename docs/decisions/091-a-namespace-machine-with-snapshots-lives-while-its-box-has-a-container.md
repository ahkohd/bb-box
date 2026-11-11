# A Namespace machine with snapshots lives while its box has a container

Status: accepted
Date: 11 November 2026

## Context

A Namespace Linux box is a container on a machine of its own, and Namespace
bills the machine by the minute until it is destroyed or reaches its
deadline. BB Box moves the deadline on while the box is recorded.

Snapshots on Namespace ([082](082-docker-snapshots.md), item 8) stay on the
box's machine. A restore makes a new container there and removes the old
one. So a box may have two containers on its machine for a while, and the
core's release of one guest no longer means the box is gone. Before this
record, a backend's `release` could not tell the box's own release from the
core dropping one guest after a restore, and Namespace destroyed the whole
machine either way.

Once snapshots are in use, the machine can also outlive its box's container:
a restore that stopped part way, or a container removed by hand, leaves a
machine that costs minutes and holds nothing. And BB Box cannot always ask:
the machine's Docker may not answer.

Three questions had to be settled:

- What a release ends.
- What keeps a machine with snapshots alive, in particular a box whose
  container has stopped.
- How long BB Box keeps a machine alive while its Docker does not answer.

## Decision

- `release` takes a scope in its hooks. `whole-box` is the box's own release,
  including its retries: the backend may remove everything it holds for the
  box. `this-guest-only` is the core dropping one guest while the box lives
  on in another, after a restore or its swap back. Without a scope, a backend
  removes only that guest where the box may have another. Namespace is the
  only backend that reads it today: on `whole-box` it destroys the machine.
- A whole-box release on Namespace records its intent before it destroys the
  machine. If the destroy fails, the sweep finishes it, and the sweep never
  adopts that box again, even when the box's record is lost.
- On a machine whose box has taken a snapshot, BB Box moves the deadline on
  while a container a box record names exists there, running or stopped. A
  stopped box keeps its machine, and its disk, so the person ends the cost
  by releasing it. BB Box never lets a stopped box's machine expire on its
  own while promising that the disk stays.
- The sweep destroys a machine with snapshots where no container a box
  record names exists, and marks its box gone.
- When the machine's Docker does not answer, BB Box treats the machine as
  unknown, not empty. It moves the deadline on for one hour after a
  container of the box last answered, and then stops. The last answer is
  stored, so a restart of BB keeps it.
- A machine with snapshots but no stored last answer, such as one set up
  before the time was stored, gets its hour from the first sweep at which
  Docker does not answer. That time is stored at once, so a restart does not
  start the hour again. A later answer replaces it.
- A machine whose box has taken no snapshot keeps the behaviour from before
  this record: BB Box does not ask its Docker, and moves its deadline on
  while the box is recorded.

## Consequences

- A box's release always ends its machine and its minutes, even when a
  restore left an old container behind.
- A restore never destroys the machine its box runs on.
- A stopped Namespace box costs its machine's minutes until it is released.
  The Namespace guide says so.
- A machine with snapshots and no container of its box costs minutes for at
  most one sweep after the container goes.
- When Docker stops answering, BB Box moves a machine's deadline on for at
  most one hour. The machine then ends at the deadline its last extension
  set.
- The empty-machine rule covers only machines whose box has taken a
  snapshot. A machine whose box has taken none and whose container is gone
  still runs until the box is released or the machine reaches its deadline.
