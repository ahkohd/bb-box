# A take says how long it pauses the box, before and after

Status: accepted
Date: 10 November 2026

## Context

Docker, microsandbox, Tart and Proxmox pause a running box while they take
its snapshot: nothing in it runs until the take is done. A large Docker box pauses
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
  take's answer, and its row on the box's page, say the pause measured, or
  that it was not measured.
- A backend may give a size with each snapshot it lists. A record rebuilt
  from that listing keeps it.
- A measured pause covers only the time the box was paused, never work
  before the pause or after the resume. When a backend cannot read that
  interval, the result is null, never 0.

What each backend says of a take of a running box:

| Backend | Plan | Measured pause |
| --- | --- | --- |
| Docker | pauses, with an estimate from the changed disk and the Docker data | from `docker pause` to `docker unpause` |
| microsandbox, disk | pauses, with no estimate: `msb` 0.7.7 pauses the microVM, captures its disk and resumes it | `pause_us` from the `capture_disk` line this take added to `msb`'s runtime log, or null |
| microsandbox, memory | pauses, about 1.5 seconds, from the box's memory | `vm_pause_window_us` from the `capture` line this take added to `msb`'s runtime log, or null |
| Tart, macOS | pauses, with an estimate from the VM's memory | from the suspend to when Tart runs the VM again, before BB Box's SSH, identity and clock checks; null when the VM does not resume |
| Proxmox LXC | pauses, with no estimate: Proxmox freezes the container while it snapshots its volumes (`PVE::LXC::Config` `__snapshot_freeze`) | null: Proxmox does not report it |
| Proxmox QEMU, disk | pauses, with no estimate: Proxmox calls `savevm-start` with no state file, which stops the VM until its disks are snapshotted | null: Proxmox does not report it |
| Proxmox QEMU, memory | pauses, with no estimate: the VM stops at the end of saving its memory | null: Proxmox does not report it |
| boat.dev | does not pause | 0 |

A stopped box is not paused, and its take's measured pause is 0.

A microsandbox snapshot does not record which log line its take wrote, so
BB Box reads the box's timing lines from `msb`'s log just before the take
and again after it. It uses a line only when the take added exactly one
capture line, of the kind the take made. Otherwise the pause is null, so a
take never reports an earlier take's pause.

## Consequences

- A person or an agent can decide before a long pause, and see how good the
  estimate was after.
- Proxmox does not report its pauses, so its takes say they cannot be
  measured.
- microsandbox's measure depends on the line its runtime logs at info level.
  A release of `msb` that changes that line leaves the pause unknown, not
  wrong, until BB Box reads the new one.
- A microsandbox take of a running box reads `msb`'s log twice. `msb` 0.7.7
  reads the whole log to answer, whatever `--since` says, so these reads
  grow slower as the log grows: about 0.5 seconds each for a 256 MiB log,
  on an 8-vCPU VM on an AMD Ryzen Threadripper PRO 9975WX.
- A new backend cannot leave its pause unsaid: the type does not allow it.
