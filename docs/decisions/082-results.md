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
- Restore, fork and Keep remain later units.

Cancelling a Docker commit client after the commit reaches the engine was not
measured here. The failed-task record rejects a late image after interruption.

Delete reports the stored snapshot estimate through the existing core interface.
When a manually made container still uses the image, Docker retains its layers;
the displayed freed size does not distinguish that deferred space yet.
