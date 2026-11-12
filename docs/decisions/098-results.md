# 098: results

## Why a first start is slow

Measured on 11 November 2026 in fresh linked clones on Proxmox QEMU: a Linux
box of 4 cores and 8 GiB, and an Android box of 8 cores and 16 GiB, both
Ubuntu 24.04 with kernel 6.8.0-149 and docker.io 29.1.3-0ubuntu3~24.04.2.
Each run stopped Docker and containerd, started `docker.socket` again, and
timed `docker version` as the box user. "Cold" dropped the page cache
first. The load ran in the box: `stress-ng --hdd 4 --hdd-bytes 512M` for
disk, `stress-ng --cpu 8` for CPU, and a `CPUQuota=10%` drop-in on both
units for a starved CPU.

### Live archive or snapshot

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

### What the host's load does

The whole first command, in ms:

| Condition | Runs | Time |
| --- | --- | --- |
| Warm, CPU load | 5 | 489 to 535 |
| Cold, CPU load | 5 | 730 to 781 |
| Cold, a tenth of a core | 3 | 2,154 to 2,441 |
| Cold, disk load | 5 | 4,706 to 8,866 |

## The check

Measured on 12 November 2026 with `docker-first-start.sh` run as the box
user, against its limit of 2,000 ms and its deadline of 30 s. Each run
under systemd stopped Docker, containerd and `docker.socket`, cleared
systemd's start limit, and started `docker.socket` again. "Cold" dropped
the page cache first, which only a VM can do. Disk load was
`stress-ng --hdd 4 --hdd-bytes 64M` in the box. A 3 s hold was an
`ExecStartPre=/bin/sleep 3` drop-in on `docker.service`, or a oneshot unit
running `sleep 3` that `docker.service` requires and follows. A hung
activation was `ExecStartPre=/bin/sleep infinity`.

Times are in ms: the first start, then the second where there was one.

### A Linux VM on Proxmox QEMU

8 cores and 16 GiB, Ubuntu 24.04.5, kernel 6.8.0-149, docker.io 29.1.3,
cold.

| Start | Condition | Runs | Times | Result |
| --- | --- | --- | --- | --- |
| Healthy | idle | 3 | 2,260 to 6,700, then 730 to 770 | pass |
| Healthy | disk load | 2 | 8,060 to 8,370, then 1,390 to 1,640 | pass |
| `ExecStartPre` 3 s | idle | 1 | 10,510, then 3,790 | fail: slow both times |
| `ExecStartPre` 3 s | disk load | 3 | 13,860 to 13,950, then 4,700 to 5,340; and 26,300, then no answer | fail |
| Required unit 3 s | idle | 1 | 7,570, then 3,760 | fail: slow both times |
| Required unit 3 s | disk load | 3 | 10,210 to 11,280, then 4,080 to 5,310 | fail: slow both times |
| No socket | idle | 1 | refused | fail at once |
| Hung activation | idle | 1 | no answer | fail after 29.1 s in all |

### A Linux box on Proxmox LXC

2 cores and 4 GiB, Ubuntu 24.04.5, kernel 6.17.13-2-pve, warm. A run of
the VM's cases loaded the same host's disk for part of this.

| Start | Condition | Runs | Times | Result |
| --- | --- | --- | --- | --- |
| Healthy, the box's first | fresh box | 1 | 6,880, then 1,040 | pass |
| Healthy | idle | 3 | 960 to 1,700 | pass at once |
| Healthy | disk load | 2 | 2,660 to 4,990, then 2,360 to 4,820 | fail: slow both times |
| `ExecStartPre` 3 s | idle | 1 | 4,390, then 4,510 | fail: slow both times |
| `ExecStartPre` 3 s | disk load | 3 | 6,020 to 7,390, then 9,820 to 12,870; and 18,960, then no answer | fail |
| Required unit 3 s | idle | 1 | 5,070, then 6,680 | fail: slow both times |
| Required unit 3 s | disk load | 3 | 5,910 to 7,060, then 5,450 to 8,160 | fail: slow both times |
| No socket | idle | 1 | refused | fail at once |
| Hung activation | idle | 1 | no answer | fail after 29.0 s in all |

### A Wayland desktop on Proxmox LXC

4 cores and 8 GiB, Ubuntu 26.04.1, kernel 6.17.13-2-pve, warm.

| Start | Condition | Runs | Times | Result |
| --- | --- | --- | --- | --- |
| Healthy, the box's first | fresh box | 1 | 4,030, then 1,880 | pass |
| Healthy | quiet host | 7 | 1,010 to 1,220 | pass at once |
| Healthy | host disk loaded by the runs above | 7 | 4,030 to 15,660, then 1,130 to 12,690 | 1 pass, 6 fail |

### A Docker box, without systemd

2 cores and 4 GiB, docker.io 29.1.3. Before each run after the first, the
check's own steps stopped `dockerd` and waited for `bb-box-start` to listen
again.

| Start | Condition | Runs | Times | Result |
| --- | --- | --- | --- | --- |
| Healthy, the box's first | fresh box | 1 | 7,610, then 1,200 | pass, 10.0 s in all |
| Healthy | second box, warm | 5 | 2,060, then 1,190; and 980 to 1,160 | pass |

An earlier check in such a box took 2,685 ms of Docker's own time, as the
first version counted it, and failed.

### What this shows

- Every start held 3 s, idle or under disk load, failed, as did no socket
  and a hung activation. A hung start ended by the deadline, with no
  `docker` command left running.
- Every healthy start passed on an idle or cold host, including each box's
  first start, the case the build checks.
- A healthy start failed when the host stayed busy through both starts: 2
  of 2 with disk load in a 2-core LXC box, and 6 of 7 in the Wayland box
  while other boxes loaded the host's disk. Both passed on a quiet host.

## The first version

The first version took off the time Docker waited for its host, from
counters of disk waits, CPU pressure and steal. Its healthy starts passed
at 178 to 1,252 ms of Docker's own time. But 2 of 3 starts held 3 s by
another unit passed under cold disk load, at 1,187 to 2,206 ms of their own.
A review then built broken starts that passed from overlapping and
historical counters. In two Android template builds the linked clone's
first command took 2,622 and 1,637 ms in all.
