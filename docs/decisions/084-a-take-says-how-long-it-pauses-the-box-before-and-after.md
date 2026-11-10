# A take says how long it pauses the box, before and after

Status: accepted
Date: 10 November 2026

## Context

Docker, microsandbox, Tart and Proxmox can pause a box while they take its
snapshot: nothing in it runs until the take is done. A large Docker box pauses
for up to about 45 seconds ([082](082-docker-snapshots.md)). Before this
record, nobody was told before a take, and the take's answer gave only the
whole take's time, which includes other work. A record rebuilt from a
backend after `snapshots.db` was lost also had no size, though Docker keeps
the byte counts in its image's labels.

The command line and agent tools answer once, when the take is done, so they
cannot speak while it runs.

## Decision

- Each backend's snapshot plan says what a take would pause: `pause` for a
  take of the disk, and `memory.pause` for one with memory. Either the take
  does not pause the box, or it pauses it, with an estimate in milliseconds
  or none where the backend cannot estimate, and what the estimate is based
  on: the bytes of disk it copies or of memory it saves. The field is required, so every
  backend must say.
- Each take's result carries `pausedMs`: 0 when it did not pause the box, the
  pause the backend measured, or null when it paused the box for a time the
  backend cannot measure. BB Box keeps it with the snapshot's record.
- `bb box snapshot take --check` and `box_snapshot` with `check` say the plan
  and take nothing. The Take snapshot dialog shows it before the take. The
  take's answer, and its row on the box's page, say the pause measured.
- A backend may give a size with each snapshot it lists. A record rebuilt
  from that listing keeps it.
- A Proxmox LXC take of a running container says it pauses the box with no
  estimate: Proxmox freezes the container while it snapshots its volumes
  (`PVE::LXC::Config` `__snapshot_freeze`), for a time it does not report.

## Consequences

- A person or an agent can decide before a long pause, and see how good the
  estimate was after.
- Proxmox does not measure its pauses, so its takes say they cannot.
- A new backend cannot leave its pause unsaid: the type does not allow it.
