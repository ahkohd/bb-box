# A fork may hold its gone source's address when its provider gave it

Status: accepted
Date: 11 November 2026

## Context

Before a fork is handed over, BB Box checks that it does not hold its
source's address, so it cannot take what is sent to its source
([070](070-snapshots.md)). Where addresses are leased by DHCP, as on Tart, a
fork may hold its source's last address once the source is stopped or gone,
but only when it asked for it with a DHCP client ID of its own. A backend
that cannot say what its source holds now treats the address the source
had as still taken.

Docker assigns addresses itself. It hands a new container the lowest free
address on its network, and a stopped container holds none. So a fork of a
kept snapshot after its box's release, on an engine with no other box, gets
its source's old address. Docker uses no DHCP, so there is no client ID to
show, and BB Box refused every such fork: Keep's promise of a fork after the
release failed on an otherwise empty engine.

Three other ways were weighed:

- Mark Docker's addresses as endpoints, as boat.dev's are, so the check
  skips addresses. That would drop the check for a running source too.
- Forget the source's address once it is released. Then nothing would show
  that the fork's address is its own, rather than one it took.
- Hold the old address with a placeholder container while a fork starts.
  That adds a container to make, clean up after a crash and explain.

## Decision

- A backend may say which addresses it gave a guest itself, read from the
  provider now, not from inside the guest: `addressesGivenByProvider`.
- The fork check accepts a fork holding its source's last address only when
  the source is gone and the provider says it gave that address to the
  fork. The source is gone when BB Box's record of it has no guest, or the
  provider says its guest is gone. A stopped or suspended source could come
  back, so its address stays refused unless the fork shows a DHCP client ID
  of its own, as before.
- Every other part of the check stands: a source that runs keeps its
  address, and a fork holding it is refused at once; another box's address,
  the source's MAC, machine ID, host keys, BB machine and tailnet node are
  refused as before; an address the provider did not give the fork is
  refused.
- Docker says what its source holds now, from the source's container:
  running or paused with its address, stopped, or gone when this install
  has no such container for the box. It says what it gave the fork from
  the fork's own container, which it checks is this install's and the
  fork's, and only while it runs.
- The check runs while the fork's services are held, so nothing in the fork
  runs before it passes.

## Consequences

- A fork of a kept Docker snapshot after its box's release works on an
  engine with no other box, and its identity reset runs as for any fork.
- On a remote engine, BB Box records no address for its boxes, as the BB
  server cannot reach them. Docker still says what a running source holds,
  and the check refuses a fork that holds it, though Docker never gives one
  address to two running containers.
- Tart and other leasing backends do not say what they gave a guest, so
  their checks are unchanged.
