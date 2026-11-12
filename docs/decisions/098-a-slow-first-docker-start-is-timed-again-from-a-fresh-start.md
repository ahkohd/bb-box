# 098: Docker's first start is judged by its own time, not its host's

Status: accepted, 11 November 2026. Supersedes the check's rule in
[041](041-every-linux-box-has-docker.md): "fail above 2 s" becomes "fail
above 2 s of Docker's own time".

## Context

041's checks time the first `docker` command in a box, which starts Docker
through its socket, and fail above 2 s. In October that took 538 to 602 ms.
On a busy Proxmox host it failed healthy images: 2,560 and 3,144 ms in
fresh linked clones of the Android template, 2,012 ms in the template
itself, and 4,232 ms at a node load of 12 to 15 in
[071's results](071-results.md). Each passed when built again.

Those builds installed from Ubuntu's live archive, not the pinned snapshot,
so newer packages were a second suspect. Measured in a Linux VM on Proxmox
QEMU, the live archive's containerd and runc and the snapshot's took the
same time: warm 521 to 573 ms, cold 731 to 1,003 ms, and 1,862 to 2,417 ms
with Docker held to a tenth of a core. Docker's own work is about 210 ms
of CPU. Disk load is what slows it: with a cold cache and four disk writers
in the box, the first command took 4.3 to 8.9 s. The measurements are in
[098-results.md](098-results.md).

The check exists to catch a start that is slow for a reason in the image,
such as Docker waiting for another unit or a timeout. A wider limit would
let such waits through; a retry would still fail on a host that stays busy.

## Decision

- The check times the first `docker` command, as before, and takes off the
  time Docker waited for its host: the time any of Docker's threads was
  waiting for the disk, sampled every 10 ms; the time its cgroups waited
  for a CPU, from their pressure stall information; and the CPU time its
  host took from Docker's work: Docker's CPU time times the box's steal
  time over its busy time, at most 19 times, as when 95% is stolen.
- What remains is Docker's own time. The check fails above 2 s of it, 041's
  limit, or above 30 s in all, or when Docker does not answer.
- Under systemd, Docker's threads are those of `containerd.service` and
  `docker.service`. In a Docker or microsandbox box, which has no systemd,
  they are the box's.
- The check is one script, `docker-first-start.sh`, that every Linux
  image installs and its three checks run.

## Consequences

- A healthy image passes on a busy host: 178 to 1,252 ms of its own in every
  load measured in a box, against the limit of 2,000 ms. In an Android
  template's build at a host load of 7 to 22, the linked clone's first
  command took 2,622 ms, which failed 041's rule, and 1,623 ms of its own
  while steal was counted over all CPU time. Counted over busy time, at a
  load of about 18, the clone took 1,637 ms, 508 ms of its own.
- What Docker's own time still holds: its CPU work, about 0.2 s in a Linux
  box and 0.7 s in an Android box; its waits for anything but the disk or
  a CPU, such as timers, sockets and child processes; and the time systemd
  and the `docker` command take to pass it the connection.
- A start that waits 3 s for another unit fails on a quiet box and under CPU
  load. Under heavy disk load, the part of such a wait that overlaps
  Docker's own waits for the disk is not counted: it delayed nothing that the
  disk did not.
- The check reads `/proc`, cgroups and pressure stall information, which
  Ubuntu's kernels have. Without them, it counts the whole time, as before.
