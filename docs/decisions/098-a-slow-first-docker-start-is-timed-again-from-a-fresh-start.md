# 098: A slow first Docker start is timed again from a fresh start

Status: accepted, 12 November 2026. Supersedes the check's rule in
[041](041-every-linux-box-has-docker.md): "fail above 2 s" becomes "fail
when a first start and a second one from a fresh start both take more
than 2 s".

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
same time. Docker's own work is about 210 ms of CPU. A cold disk and a busy
host are what slow it: with a cold cache and four disk writers in the box,
the first command took 4.3 to 8.9 s. The measurements are in
[098-results.md](098-results.md).

The check exists to catch a start that is slow for a reason in the image,
such as Docker waiting for another unit, a missing socket or a daemon that
hangs. A wider limit would let such waits through.

A first version of this decision took off the time Docker waited for its
host, from counters of disk waits, CPU pressure and steal. Those counters
overlap, count other work and hold time from before the check, so the
remainder is not Docker's own time. A review built broken starts that
passed from them, and 2 of 3 starts held 3 s by another unit passed under
disk load. This version estimates nothing.

## Decision

- The check times the first `docker` command with a monotonic clock, the
  kernel's uptime. The whole check has 30 s. A command still running 1 s
  before then is sent TERM, and its process group KILL at 30 s. Anything
  left in the group when the command ends is killed then.
- The check runs no other `docker` command before the one it times.
- A first command that answers within 2 s passes.
- A first command that answers more slowly is timed again. The check stops
  Docker as boot leaves it, then times a second first start the same way.
  The check passes only when the second answers within 2 s, and its line
  gives both times and says the first was slowed by a cold or busy host.
- Under systemd, the check stops `docker.service` and `containerd.service`
  without waiting, through `sudo`, and polls until both are inactive.
  `docker.socket` keeps listening, as at boot.
- Without systemd, in a Docker or microsandbox box, the check sends TERM to
  `dockerd`, waits for it to end, then waits until `bb-box-start` listens
  on Docker's socket again and the box user can open it.
- A failure says which of these it is: no answer within 30 s, a connection
  refused or no socket, slow both times, or Docker did not stop for a second
  start.
- The check is one script, `docker-first-start.sh`, that every Linux image
  installs and its three checks run.

## Consequences

- A cold disk passes: the first start reads Docker from the disk, and the
  second finds it in the page cache. A start held by something that repeats
  at each start fails both times: a 3 s `ExecStartPre`, a 3 s unit Docker
  requires, a missing socket and a hung daemon all failed, idle and under
  disk load.
- A delay that happens only at the first start after boot passes, since the
  second start does not repeat it. A unit that stays active after it first
  runs is one such delay.
- A host that stays busy through both starts fails a healthy image. Four
  disk writers in a 2-core LXC box, or a Proxmox host whose load stays near
  32, failed both starts. Build again when the host is quieter.
- `docker.service` allows 3 starts in 60 s. The check starts it at most
  twice, so a build step that started Docker in the minute before can make
  the second start fail as refused.
- The check takes at most 30 s. A second start costs about 2 s more
  without systemd: `dockerd` takes about 1 s to stop, and `bb-box-start`
  waits 1 s before it listens again.
- The box user stops Docker through `sudo`, which every image gives it. A
  command started through `sudo` is root's, so the check cannot kill it:
  it asks systemd to stop Docker without waiting, so `sudo` returns at
  once.
