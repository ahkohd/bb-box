# 062: Docker boxes are pinned to their cores, and see their memory through LXCFS where the host has it

Status: accepted, 25 October 2026 (#1035), with the review's changes. Extends
[028](028-a-box-size-is-chosen-when-it-is-made.md) and
[061](061-a-box-can-be-resized-live-where-its-backend-can-and-restarted-only-when-asked.md)
for Docker boxes.

## Context

A Docker box gets its size from `--cpus` (a CFS quota) and `--memory`
(028). The kernel enforces both, but most of what a box shows about
itself is the host's: in a box of 2 cores and 4 GiB on a large host,
`nproc` and `free` say the host's cores and memory. Tools that size
themselves from those oversubscribe: `make -j$(nproc)` runs a job per
host core on 2 cores' worth of time, and a tool that takes a share of
"total memory" asks for more than the box may use and is killed.

Proxmox LXC, microsandbox and the VMs show the box's own numbers already.
Docker boxes are the exception, on every Docker host bb-box meets:

- a person's own Docker host, reached over SSH or a local socket, which
  bb-box does not administer, and which may be rootless Docker or Docker
  Desktop's VM;
- Docker on a BB machine, through BB's relay, also the person's machine;
- the Hetzner Cloud hosts bb-box makes (055), whose host image bb-box
  builds.

Placement counts memory and boxes, not cores: boxes share a host's cores,
and only a box larger than the host is refused. So a host often has more
cores asked for than it has.

### What each option shows, measured

Measured on 25 October 2026 on a VM of 8 cores and 16 GiB as the Docker
host: Ubuntu 24.04.5, kernel 6.8, Docker 29.1.3, cgroup v2, LXCFS 5.0.4.
Each case is a container of 2 cores and 4 GiB. The images were
ubuntu:24.04 for the shell tools, node:24-slim, eclipse-temurin:21-jre,
python:3.13-slim and golang:1.25. Right answers are 2 and 4096.

| What reads it | `--cpus 2` (today) | `--cpuset-cpus 0,1` | `--cpus 2` and LXCFS | `--cpus 2` and LXCFS `--enable-cfs` | cpuset and LXCFS | `--cpus 2` and `OMP_NUM_THREADS=2` |
| --- | --- | --- | --- | --- | --- | --- |
| `nproc` (sched_getaffinity) | 8 | 2 | 8 | 8 | 2 | 2 |
| `make -j$(nproc)` | -j8 | -j2 | -j8 | -j8 | -j2 | -j2 |
| `getconf _NPROCESSORS_ONLN` | 8 | 8 | 8 | 2 | 2 | 8 |
| `/proc/cpuinfo` processors | 8 | 8 | 8 | 2 | 2 | 8 |
| `/proc/stat` CPUs | 8 | 8 | 8 | 8 | 2 | 8 |
| `free`, `/proc/meminfo` (MiB) | 15990 | 15990 | 4096 | 4096 | 4096 | 15990 |
| `/proc/uptime` | the host's | the host's | the box's | the box's | the box's | the host's |
| Node `os.availableParallelism()` | 2 | 2 | 2 | 2 | 2 | 2 |
| Node `os.cpus().length` | 8 | 8 | 8 | 8 | 2 | 8 |
| Node `os.totalmem()` (MiB) | 15991 | 15991 | 4096 | 4096 | 4096 | 15991 |
| Node `process.constrainedMemory()` | 4096 | 4096 | 4096 | 4096 | 4096 | 4096 |
| JVM 21 effective CPUs, heap | 2, 1 GiB | 2, 1 GiB | 2, 1 GiB | 2, 1 GiB | 2, 1 GiB | 2, 1 GiB |
| Python `os.cpu_count()` | 8 | 8 | 8 | 2 | 2 | 8 |
| Python `os.process_cpu_count()` | 8 | 2 | 8 | 8 | 2 | 8 |
| Go 1.25 `GOMAXPROCS`, `NumCPU` | 2, 8 | 2, 2 | 2, 8 | 2, 8 | 2, 2 | 2, 8 |

What follows from the table:

- The runtimes that read cgroup limits are right in every case: the JVM
  (since 10), Node's `availableParallelism` and `constrainedMemory`, and
  Go's `GOMAXPROCS` (since 1.25). So, by their documentation and not
  measured here, are build tools on them, such as Gradle and Maven on the
  JVM, and Cargo through Rust's `available_parallelism`, which reads the
  quota.
- `nproc`, `make -j$(nproc)`, `free`, `/proc/meminfo`, Python's
  `os.cpu_count()`, Node's `os.cpus()` and anything that counts
  `/proc/cpuinfo` or calls `sysconf` are wrong today.
- Only the CPU affinity changes `nproc`. A cpuset sets it; LXCFS does not,
  even with `--enable-cfs`. Only GNU `nproc`'s own `OMP_NUM_THREADS` and
  `OMP_THREAD_LIMIT` override it.
- Only LXCFS changes the memory a box sees. Nothing on the container's
  command line does.
- A cpuset and LXCFS together show 2 and 4096 everywhere. This is what
  Proxmox LXC does, below.

Further, on the same host:

| Change | What the box saw |
| --- | --- |
| `docker update --cpuset-cpus 0-2`, from 0,1 | `nproc`, `getconf` and `/proc/cpuinfo` 3 at once |
| `docker update --cpus 3 --memory 6g`, with LXCFS `--enable-cfs` | `/proc/cpuinfo` 3 and `free` 6144 at once; `nproc` still 8 |
| a second box pinned to the same two cores | `nproc` 2 in both: overlapping cpusets are allowed, and the boxes share the cores' time |
| `systemctl restart lxcfs` with boxes running | `/proc/meminfo` and `/proc/cpuinfo` fail with "Transport endpoint is not connected", so `free` fails, until each box restarts |
| `systemctl reload lxcfs` (SIGUSR1) | no change: boxes read their numbers on |
| a box made while LXCFS was not running, with its files mounted | `docker run` fails, as the files LXCFS serves are not there |

### The other backends, for comparison

Measured on 25 October 2026, each box of 2 cores and 4 GiB:

| Backend | How | `nproc`, `/proc/cpuinfo`, Node `os.cpus()`, Python `cpu_count` | `free` |
| --- | --- | --- | --- |
| Proxmox LXC | Proxmox pins each container's cores as a cpuset (this box had CPUs 9 and 53), spreads the guests' cpusets as it starts and resizes them, and mounts LXCFS over `/proc` and `/sys/devices/system/cpu` | 2 | 4096 |
| microsandbox | a microVM with 2 vCPUs | 2 | 3940, the VM's own after its kernel |
| Proxmox QEMU | a VM of the box's size (measured at 8 cores and 16 GiB: 8 and 15990) | its cores | its memory |
| Tart and Namespace's Macs | a VM of the box's size; not measured here | its cores | its memory |

Proxmox shares a host's cores between more containers than it has cores
by giving their cpusets the least-used CPUs, overlapping when it must.

## Decision

1. **Every Docker box is pinned to as many CPUs as it has cores**, with
   `--cpuset-cpus`, as well as its `--cpus` quota. bb-box allots the CPUs
   when it places the box:
   - The host's CPUs are those a probe container sees in
     `/sys/fs/cgroup/cpuset.cpus.effective`: the CPUs the daemon may give
     its containers, wherever it runs. Measured on a rootful daemon only;
     rootless Docker and Docker Desktop are to be checked when this is
     built.
   - A box takes the CPUs that the fewest of the host's running bb-box
     boxes are pinned to, the lowest-numbered first among equals. bb-box
     reads each container's pinning from `docker inspect`
     (`HostConfig.CpusetCpus`), so the allotment needs no state of its own
     and survives a restart of bb-box, and other installs' boxes count.
   - Two boxes placed on one host at once must not both take the same
     least-used CPUs. bb-box allots under the host's placement lock, which
     already places one acquire at a time, from `docker inspect` and the
     boxes it is making there but has not yet created.
   - When boxes ask for more cores than the host has, cpusets overlap,
     least-used CPUs first. A box shares those cores' time, as boxes share
     the host's time today. A box larger than the host is refused, as now.
   - A resize changes the cpuset live with `docker update` (061): it
     grows by the least-used CPUs, and shrinks by dropping the CPUs that
     the most other boxes share.
   - When a box is released or shrinks, CPUs come free. Then bb-box moves
     each box whose CPUs other boxes share onto CPUs no box uses, keeping
     its count, with `docker update`, so overlaps do not outlive the
     overcommit that caused them. A box's processes see how many CPUs they
     have, not which, so a move changes nothing they see. A box that shares
     no CPU is never moved.
   - Where the daemon cannot set a cpuset, the box keeps its quota alone,
     and the doctor says so and why. This is rootless Docker whose user
     systemd does not delegate the cpuset controller, the delegation the
     doctor already asks for.

2. **Where the host runs LXCFS, every Docker box mounts it**:
   `/proc/cpuinfo`, `/proc/meminfo`, `/proc/stat`, `/proc/uptime`,
   `/proc/swaps`, `/proc/loadavg`, `/proc/diskstats` and
   `/sys/devices/system/cpu/online`, as Proxmox does. With the cpuset,
   LXCFS's defaults are right, so it needs no `--enable-cfs`.
   - bb-box sees whether a host serves LXCFS with its survey's probe
     container: `/var/lib/lxcfs/proc/meminfo` mounted read-only and read.
     A box gets the mounts only while that probe passes, so a host
     without LXCFS still makes boxes.
   - **Hetzner Cloud hosts:** bb-box installs LXCFS in its host image and
     runs it with systemd. That changes the host image's fingerprint, so
     the next build after this change rebuilds it. Package upgrades on the
     host must not restart LXCFS under running boxes: the image holds the
     package and keeps unattended-upgrades and needrestart from restarting
     it, and a measured upgrade run leaves boxes' `free` working.
   - **A person's own Docker host and a BB machine's:** bb-box does not
     install it. The doctor names the hosts without it, says what boxes
     there see (`free` and `/proc/cpuinfo` say the host's), and how to
     add it: `apt install lxcfs`, or the distribution's package. bb-box
     cannot add it to Docker Desktop's VM; the doctor says that instead.
   - **An LXCFS restart** breaks the files in boxes already running, so
     the doctor checks each running box's `/proc/meminfo` on a host with
     LXCFS. A box whose read fails is named, with "restart it to see its
     memory again". bb-box does not restart it unasked (061). The doctor
     and the guide say that LXCFS should be reloaded, not restarted.

3. **A Docker box that cannot be pinned gets `OMP_NUM_THREADS`** set to
   its cores in its environment, which GNU `nproc` honours (measured
   above). That also caps OpenMP programs' threads at the box's cores,
   which they cannot use beyond anyway. A container's environment cannot
   change, so after a resize the variable keeps its first value until the
   box is made again. Elsewhere bb-box leaves `OMP_NUM_THREADS` alone.
   bb-box adds no variables of its own for the size: they would go stale
   at the first live resize, and `box_status` gives the size. `NPROC` is
   no name any tool reads.

Not chosen:

- **LXCFS with `--enable-cfs` instead of pinning.** It fixes
  `/proc/cpuinfo` and `sysconf`, but `nproc`, `make -j$(nproc)`,
  `/proc/stat`, Node's `os.cpus()` and Python's `process_cpu_count`
  still say the host's (measured). It also needs LXCFS, which most
  people's hosts lack.
- **The environment alone.** It fixes `nproc` only, through
  `OMP_NUM_THREADS`, nothing for memory, and goes stale at a resize.
- **Another runtime**, such as Sysbox or gVisor, which virtualise more
  of `/proc`. It is not on people's hosts, and changes much more than
  this issue needs. Not measured.

## Consequences

- On any Docker host that can set a cpuset, which is all of them but
  rootless Docker without delegation: `nproc`, `make -j$(nproc)`,
  Python's `process_cpu_count`, Go's `NumCPU` and the runtimes say the
  box's cores. With LXCFS too, so do `free`, `/proc/meminfo`,
  `/proc/cpuinfo`, `sysconf` and Node's `os.cpus()`, as on Proxmox LXC.
- A box pinned to CPUs that other boxes share gets less than its cores'
  time when they are busy, as today with quotas alone. Pinning keeps a
  box's work on its CPUs, so caches warm, and on a crowded host the
  least-used CPUs spread the load. On a large host with few boxes, a
  box's processes stay on its cores rather than move about the host.
- A Docker box made before this change keeps its unpinned limits until
  it is made again or resized; a resize pins it.
- Hetzner Cloud hosts' image is rebuilt once for LXCFS.
- Built in three steps: cpuset pinning, with resizes, moves and the
  doctor's line; then the LXCFS probe, mounts and doctor checks; then
  LXCFS in the Hetzner Cloud host image, with a live run of a 2-core box
  showing `nproc` 2 and `free` 4096. Rootless Docker is measured after.
  Tests on the fake Docker: the allotment, with overlap and two boxes
  placed at once; a resize up and down; a move after a release; a host
  with and without LXCFS; and a box whose LXCFS files fail. The
  conformance suite asks every backend's linux box that `nproc` and
  `free` say its size, with Docker on a host without LXCFS excused for
  `free`.
