# Docker snapshot take results

Measured on 10 November 2026 for item 2 of decision 082.

## Automated checks

The checks ran on a separate Linux box, from main at `321a8ac0` with this unit's changes.
The requested Docker, snapshot, provider-snapshot and conformance tests passed.
The site built and its link check found no broken links.

Focused tests cover take, list, delete, mount and layer refusals, identity blanking,
image-store estimates, interrupted takes, recovery bounds, late images, ownership,
provider-only listing and retrying an unpause after a completed commit.
Removing the corresponding behaviour made the estimate, layer, mount, identity,
unpause and recovery-bound tests fail. The changes were restored afterwards.

## Verified live

The successful checks used a separate BB with no account, running in a Linux VM
with 4 vCPU, 8 GiB memory and a 48 GiB disk. Its backend reached the VM's Docker
engine, Docker 29.1.3 with the containerd image store. The test box was Linux with 2 cores and 2 GiB memory. The image was built
from this repository. The test build used HTTPS Ubuntu sources because HTTP
package downloads stalled. Those build-only changes are not part of this unit.

The box held a file containing `A` and a running Alpine container with `A` in an
inner Docker volume. A take through `bb box snapshot take` completed in 4.05 seconds,
including CLI overhead. BB Box logged a pause of 2,413 ms. Its recorded operation
took 2,885 ms.

The list showed a ready disk snapshot of 14 MB. Its exact estimate was 13,959,168
bytes: 143,360 changed disk bytes counted twice on the containerd image store,
and 13,672,448 bytes of Docker data. A separate `du -sk` of the copied volume
reported 13,348 KiB, exactly 13,672,448 bytes. Read-only inspection found `A` in
both the committed image and the copied inner volume. The image's source box
label and identity variable were blank.

The image and volume used the agreed names and ownership labels. The volume had
no `bbbox.volume-of` label. Delete removed both objects. Restore, fork and Keep
refused. Fork used the core's existing identity-reset refusal for this test box.

For recovery, the box had 1 GiB of extra Docker data. The separate BB's recorded
processes were killed after Docker reported the box paused. A partial snapshot
volume existed, with no completed snapshot image. After restart, the snapshot
was not listed as ready. BB Box automatically unpaused the box about 193 seconds
after the take began, including the recovery bound and sweep interval. The partial
volume disappeared. Both the box file and the inner container data still read `A`.

Release removed the released box's snapshot image and volume. Another box's
snapshot image and volume remained. An image and volume labelled for a different
install also remained.

## Limits and follow-ups

- Records rebuilt from the engine alone have no displayed size, as on the other
  backends today. The byte counts remain in image labels for a later core change.
- The core does not announce a take's pause beforehand or include its measured
  pause in the result. The offer says it pauses; the log records milliseconds.
- Docker inside an LXC host refused `/proc/cpuinfo` before pausing. BB Box's LXCFS
  bind mounts currently have Docker's writable flag. They need a separate change
  before such boxes can take snapshots. This unit keeps the writable-mount refusal.
- Fork and Keep remain later units. Restore is below.

Cancelling a Docker commit client after the commit reaches the engine was not
measured here. The failed-task record rejects a late image after interruption.

Delete reports the stored snapshot estimate through the existing core interface.
When a manually made container still uses the image, Docker retains its layers;
the displayed freed size does not distinguish that deferred space yet.

## Restore, verified live

A fresh BB 0.49.0, with no account, ran in a separate Linux VM: Proxmox QEMU,
8 vCPU, 16 GiB of memory and a 100 GiB disk, Ubuntu 24.04.5, kernel
6.8.0-149, Docker 29.1.3 with the containerd image store. BB Box was installed
from the branch, and Docker set up with `bb box setup docker`. Each box was a
machine of 2 cores and 2 GiB. Each run wrote `A` to a file in the box user's
home and into an inner container's volume and writable layer, took snapshot
`A`, changed all three to `B`, and restored `A`. It then restored the undo,
deleted every snapshot and released the box.

| Run | Take | Restore | Undo restored | What came back |
| --- | --- | --- | --- | --- |
| No LXCFS | 7.5 s, paused 5.5 s | 6.8 s | 5.9 s | `A` three times; the inner container restarted and ran; `B` after the undo |
| No LXCFS, BB killed after the undo's commit | 4.6 s | finished by the sweep after BB restarted, about 3 minutes later | 9.7 s | as above |
| No LXCFS, BB killed once the new container started, the old one still there | 4.3 s | finished by the sweep 181 s after BB restarted | 9.1 s | as above |
| LXCFS 5.0.4 | 5.5 s | 6.0 s | 3.7 s | as above; the new container had all 8 LXCFS mounts and saw 2048 MiB and 2 CPUs |
| LXCFS 5.0.4, BB killed after the undo's commit | 5.7 s | finished by the sweep 183 s after BB restarted | 9.0 s | as above |

In every run the box kept its ID, name, thread and kind labels, and
`BBBOX_IDENTITY` was its own ID. The new container was named
`bbbox-<box>-<8 hex>` and carried `bbbox.from-snapshot`. After each restore,
and after each recovery, Docker listed one container for the box. After the
deletes and the release, Docker listed no BB Box containers, volumes or
snapshot images.

A restore's steps, from Docker's events in one run: the undo's copy of the
Docker data and its commit took 3.9 s after `docker kill`; making the new
volume and copying the snapshot's Docker data into it, 0.3 s; the new
container's create, under 0.1 s; its start, 0.15 s. The old container was
removed 0.26 s after the start, once the new one was ready. The rest of the
restore's time, about a second, was BB Box's flush, plan and checks before
the kill.

After a kill, BB's first recovery could not reach Docker: this BB reaches its
own engine through its BB machine, which was offline until it reconnected. The
sweep 3 minutes later finished each restore. The old container stayed stopped
until then: Docker does not restart a container stopped by `docker kill`, even
with `unless-stopped`, and even after dockerd restarts (checked separately).

The box's page was open in the separate BB's panel, in Chromium with
Playwright, through every run. It recorded each Read at time the Activity card
showed. Across 39 readings in five runs, including both kinds of kill, the card
never showed a reading older than the one before it (issue 1428).

## Fork, verified live

Measured on 10 November 2026 on a Proxmox QEMU VM with 8 vCPU, 16 GiB of
memory and a 100 GiB disk: Ubuntu 24.04.5, kernel 6.8.0-149, Docker 29.1.3
with the containerd image store. A separate BB ran there, a fresh
`npx bb-app@0.49.0` with no account, its ports dropped from outside the VM,
with BB Box installed from the branch and markers on for its Docker backend
(`general.identityResetBackends`). Each source was one of the person's
machines, `linux` with 2 cores and 2 GiB, or `linux-desktop-cpu` with 2 cores
and 4 GiB, from images with identity reset version 9. The older versions were
made by changing the version the box's reset reports before the take, and the
failed resets by changing what its `boot` does.

| Run | What happened |
| --- | --- |
| Fork of `A` | Ready 2.3 s after the request: its start 0.6 s, BB Box's check 0.13 s, then it joined BB in 2.0 s more |
| A snapshot taken under reset version 6 | Refused before anything was made: "src-n had version 6 of the identity reset when "v6" was taken, and BB Box forks Docker on build-1's boxes only from version 7". Docker made no container and no volume |
| A reset that fails at its first start | The fork stopped as it started, saying "the identity reset failed, so the box starts nothing and never says it is ready". BB Box released it, and Docker deleted its container and Docker data |
| A reset that does not run at all | BB Box's check refused it: "its boot's identity check says "none", not that it reset". It was released. Its restart policy was `no` at its start and never became `unless-stopped` |
| Fork of a Linux desktop on the CPU, from a snapshot taken under reset version 9 | Ready 1.5 s after the request: its start 0.6 s, BB Box's check 66 ms. Its reset ran, it held the source's file, and its identity value was its own box ID |
| A Linux desktop snapshot taken under reset version 8 | Refused before anything was made: "BB Box forks Docker on build-1's boxes only from version 9". Docker made no container and no volume |
| BB's server killed with `kill -9` at the fork's `start` event | The half-made fork ran with restart policy `no`, its own reset done. When BB started again its BB machine had not reconnected, so the fork failed and said it was released; the sweep 3 minutes later deleted its container and Docker data. The source was untouched |

The source wrote `A` to `~/work.txt` and, in a running inner container, to its
volume and its writable layer. The fork had `A` in all three. It was named
`bbbox-<fork>-<8 hex>`, with its own box ID, name and labels,
`bbbox.from-snapshot`, and `BBBOX_IDENTITY` its own box ID. Docker's events
for it, from the volume's create: its container's create at 883 ms, after the
copy of the Docker data, its start at 1,258 ms, BB Box's check at 1,568 ms, and
the change of its restart policy to `unless-stopped` at 1,825 ms.

What the fork's identity read, against its source:

| Item | Source | Fork |
| --- | --- | --- |
| Marker | its own box ID and value | before hand-over its own value and no box; after it, its own box ID and value |
| Boot | `unarmed` | `reset`: "the value bb-box set on this guest is not the marker's; BB machines removed: host_<id>", naming the source's BB machine |
| BB's machine credentials and the access file | the source's | the source's gone; new ones from its own enrolment, as a BB machine of its own |
| Machine ID | its own | a new one |
| SSH host keys | none: a Docker box runs no SSH server | new ones its reset made |
| Tailnet node | none: this BB has no tailnet | none |

A write of `B` in the fork, in all three places, left the source with `A`.
The source kept its container, marker, BB machine and credentials through
every run, and its inner Docker still ran containers. A Docker box's start
script never starts BB's daemon: BB Box starts it with BB's bootstrap once the
box is handed over, so no refused copy ran as its source's BB machine. After
the releases, Docker listed no BB Box containers, volumes or snapshot images.

## A fork held until its check

Measured on 10 November 2026 on a Proxmox QEMU VM with 8 vCPU, 16 GiB of
memory and a 100 GiB disk: Docker 29.1.3 with the containerd image store,
and the Linux image built from this change, labelled `bbbox.fork-hold="1"`
and holding `/usr/local/libexec/bb-box/fork-hold`. A separate BB ran there,
a fresh `npx bb-app@0.49.0` with no account, its ports dropped from outside
the VM, with BB Box installed from the branch and markers on for its Docker
backend. A `docker` wrapper first on BB's PATH logged each call and, while a
gate file was there, held BB Box's check of a fork before it ran, so the
fork could be read as BB Box's check would find it.

The source was one of the person's machines, `linux` with 2 cores and 2 GiB.
It wrote `A` to `~/work.txt`, and in its Docker to an inner container's
writable layer and named volume. A second inner container, with restart
policy `always`, ran the box's own `sshd` on port 2222 through `chroot`, as
the review that found the gap did, with the box's SSH host keys made by
`ssh-keygen -A`. The source also held a stand-in Tailscale state file. Two
snapshots were taken: one as it was, and one with `bb-box-identity boot`
changed to exit 0 without resetting.

| Run | What happened |
| --- | --- |
| Fork of the faulted snapshot, held at BB Box's check | The fork still held the source's marker, machine ID, SSH host keys, BB machine credentials, access file and Tailscale state, as its reset had not run. It ran `docker-init`, `bb-box-start`, `fork-hold` and `sleep` alone. No TCP port from 1 to 65535 answered on its address, `ssh-keyscan` on port 2222 had no answer, there was no Docker socket, and no inner container ran. When the gate opened, the check refused it: "its boot's identity check says "none", not that it reset". BB Box set its policy to `no`, killed it and deleted its container and Docker data. It never wrote the release |
| Fork of the snapshot as it was, held at BB Box's check | Its own identity value, a marker with its own value and no box, a new machine ID and new SSH host keys, no BB credentials, access file or Tailscale state of the source's. It ran the same four processes, no port answered and no inner container ran. When the gate opened, the check passed. BB Box changed the policy to `unless-stopped` 67 ms after the gate opened, and wrote the release 22 ms after that. Its inner containers started 560 ms after the release. Port 2222 then served the fork's own new ED25519 key, not the source's. Its start took 668 ms and the check 703 ms, the gate's wait included |
| BB's server killed with `kill -9` while a fork was held at its check | BB's own supervisor started the server again at once, before the VM's BB machine had reconnected, so the fork failed and BB Box could not yet delete it. The fork stayed held for 3 minutes, its four processes and no port, through a `docker restart` too. The next sweep set its policy to `no`, killed it and deleted it and its Docker data. It never wrote the release |
| An ordinary stop and start of the source | Not held: its inner containers started 520 ms after `docker start` |
| A restore of the source to the snapshot as it was | Not held: the new container had `BBBOX_FORK_HOLD` blank, from the snapshot's image, and restart policy `unless-stopped`. Its inner containers started 470 ms after `docker start`, with `A` back |

The fork joined BB as a BB machine of its own, with credentials of its own.
A write of `B` in the fork, in all three places, left the source with `A`,
and with its own marker, machine ID, SSH host keys and BB credentials.

The fork's first enrolment, and the source's reconnection after its
restore, could not reach BB at the VM's `docker0` address: each box's own
Docker had taken the same range, `172.16.0.0/24`, from the VM's Docker
address pools, so the address was the box's own. With BB's machine URL set
to the box network's gateway, the fork joined BB. This comes from the VM's
address pools, not from the hold. After the releases, Docker listed no
containers, volumes or snapshot images of the test install.
