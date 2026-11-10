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
