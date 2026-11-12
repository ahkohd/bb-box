# 098: results

Measured on 11 November 2026 in fresh linked clones on Proxmox QEMU: a Linux
box of 4 cores and 8 GiB, and an Android box of 8 cores and 16 GiB, both
Ubuntu 24.04 with kernel 6.8.0-149 and docker.io 29.1.3-0ubuntu3~24.04.2.
Each run stopped Docker and containerd, started `docker.socket` again, and
timed `docker version` as the box user. "Cold" dropped the page cache
first. The load ran in the box: `stress-ng --hdd 4 --hdd-bytes 512M` for
disk, `stress-ng --cpu 8` for CPU, and a `CPUQuota=10%` drop-in on both
units for a starved CPU.

## Live archive or snapshot

The snapshot `20260926T060000Z` has containerd 2.2.1-0ubuntu1~24.04.3 and
runc 1.3.3-0ubuntu1~24.04.3. The live archive had 2.2.1-0ubuntu1~24.04.4 and
1.3.4-0ubuntu1~24.04.1, and the same docker.io. Five runs of each, in ms:

| Condition | Live archive | Snapshot |
| --- | --- | --- |
| Warm, idle | 522 to 555 | 521 to 573 |
| Cold, idle | 731 to 1,003 | 764 to 912 |
| Cold, a tenth of a core | 1,959 to 2,242 | 1,862 to 2,417 |

The packages make no difference. On an idle box, containerd's start took
about 25 ms warm and 105 ms cold, and dockerd's about 500 ms warm and
600 ms cold. Docker's work was 61 ms of CPU for containerd and 151 ms for
dockerd. In the Android box, 2 minutes after its device booted, the first
command took 1,184 ms, and dockerd used 619 ms of CPU.

## What the host's load does

The whole first command, in ms:

| Condition | Runs | Time |
| --- | --- | --- |
| Warm, CPU load | 5 | 489 to 535 |
| Cold, CPU load | 5 | 730 to 781 |
| Cold, a tenth of a core | 3 | 2,154 to 2,441 |
| Cold, disk load | 5 | 4,706 to 8,866 |

## The check

Docker's own time, as `docker-first-start.sh` reports it, against its
limit of 2,000 ms:

| Start | Condition | Runs | Whole time, ms | Docker's own, ms | Result |
| --- | --- | --- | --- | --- | --- |
| Healthy | cold, idle | 3 | 667 to 730 | 178 to 237 | pass |
| Healthy | cold, disk load | 5 | 4,280 to 7,242 | 223 to 492 | pass |
| Healthy | cold, CPU load | 3 | 637 to 1,459 | 243 to 340 | pass |
| Healthy | cold, a tenth of a core | 3 | 1,992 to 2,390 | 639 to 1,252 | pass |
| Held 3 s by another unit | idle | 3 | 3,487 to 3,493 | 3,119 to 3,197 | fail |
| Held 3 s by another unit | CPU load | 3 | 3,568 to 3,912 | 2,260 to 3,148 | fail |
| Held 3 s by another unit | cold, disk load | 3 | 4,464 to 7,855 | 1,187 to 2,206 | fail once, pass twice |
| No socket | idle | 1 | | | fail: Docker did not answer |

Two first tries, counting stalls system-wide and then only Docker's cgroups'
pressure, were set aside. System-wide, a 3 s wait passed under disk or CPU
load, as other tasks' stalls covered it. Docker's cgroups alone failed
healthy starts under disk load, at 4,518 to 5,148 ms of their own, because
the kernel does not count a wait for the file system's journal, as in
`fsync`, as a stall. Such a thread is in uninterruptible sleep, so sampling
Docker's threads counts it.

## An Android template's build

The Android template built from this change on a Proxmox host, with the
host's load rising from about 7 to 22 during the linked clone's check. The
check then counted steal time over all of the box's CPU time, not over its
busy time alone.

| Where | Whole time, ms | Waiting for the host, ms | Docker's own, ms | Result |
| --- | --- | --- | --- | --- |
| Build VM | 653 | 348 | 305 | pass |
| Linked clone | 2,622 | 999 | 1,623 | pass |

041's rule would have failed the clone, as it failed the builds of 10 and
11 November.

On a VM whose other CPUs are idle, steal over all CPU time is a small
fraction even when the host takes much of the time Docker runs. So the
check now scales Docker's CPU time by steal over busy time: on 8 CPUs with
600 of 720 ticks idle, 60 busy and 60 stolen, 600 ms of Docker's work is
credited 600 ms, not 55 ms.

Built again with steal counted over busy time, at a host load of about 18
throughout:

| Where | Whole time, ms | Waiting for the host, ms | Docker's own, ms | Result |
| --- | --- | --- | --- | --- |
| Build VM | 616 | 321 | 295 | pass |
| Linked clone | 1,637 | 1,129 | 508 | pass |

At a similar load, the clone's own time fell from 1,623 ms to 508 ms, a
quarter of the limit.

