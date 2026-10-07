# 053: microsandbox runs light Linux boxes as microVMs

Status: accepted, 7 October 2026, as the operator's call. Follows
[005](005-linux-boxes-on-proxmox-lxc.md), which named microVM runtimes
such as microsandbox as possible backends. Extended by
[055](055-cloud-boxes-run-on-cloud-hosts-first-and-a-cloud-vm-per-box-later.md): a
cloud host with KVM runs microsandbox.

This record first said, on the same day, to build the backend later, when
one of three conditions held (below). The operator chose to build it
now: microsandbox is light, and agents make and drop many boxes, faster
than with Docker. The spike's measurements stay as they were.

Amended later on 7 October 2026, as the operator's call, after the built
backend was measured against Docker on the same hosts
([below](#what-the-built-backend-measured)): **microsandbox is an option
beside Docker, never a replacement for it and never the default.** It
stays last in the backend order, so only a box that asks for it gets a
microVM. On a Linux host under nested KVM, Docker made boxes about twice as fast and held
far less memory while idle; on bare metal, msb was as fast as Docker. What
microsandbox gives on Linux is a kernel per box. On a Mac, microsandbox is
far faster than Tart's Linux VMs.

## Context

microsandbox (`msb`) runs OCI images as libkrun microVMs: with KVM on
Linux, Hypervisor.framework on Macs with Apple silicon, and the Windows
Hypervisor Platform. It is one binary with its guest kernel beside it and
no daemon, under Apache-2.0, at 0.7.7 and still beta. It has SDKs, SSH,
published ports, disk and full snapshots, and forks of running sandboxes.

The operator ran it from May to July 2026 and stopped, as it was little
used. That install needed a local change to reach the local network, and
met an IPv6 bug (upstream #607). Upstream has fixed both since:

- **IPv6** (#607): since May, a guest gets an IPv4 or IPv6 address only
  when the host has a route for it (PR #671).
- **The local network**: guests took addresses from 100.96.0.0/11, inside
  Tailscale's 100.64.0.0/10, and while a sandbox ran the host lost its
  routes to tailnet peers there (#722). Since May the pool is
  172.16.0.0/12, and `--net-ipv4-pool` changes it. Since 24 July,
  `--net public,private` lets a guest reach private addresses.

A spike on 7 October 2026 measured msb 0.7.7, guest kernel 6.12.111, on
three hosts:

- **Linux in LXC**: a Proxmox LXC container with `/dev/kvm` passed in,
  8 cores and 16 GiB, on an AMD Threadripper PRO.
- **Linux in Docker**: a privileged Docker box on a Windows PC's WSL 2,
  with KVM nested under Hyper-V, on an AMD Ryzen 7.
- **A Mac**: an M4 Max on macOS 27, with msb in a scratch folder.

bb-box's images, `bbbox/linux:1` and `bbbox/linux-desktop:1`, were built
by `setup/docker/build.sh` and given to msb with `docker save` and
`msb load`.

## Decision

**Build a microsandbox backend now, `microsandbox`, a virtual one.** It
runs our Linux images unchanged, ready in under half a second, at about
100 MiB of the host's memory for an idle box, which suits agents that make
and drop many boxes. Speed and a low cost per box are the point, so each
step below is measured.

The record first set three conditions for building it, none of which held
on 7 October 2026:

1. A need that Docker and Tart do not meet: Docker in boxes on hosts where
   privileged containers are not allowed; Linux boxes on a Windows PC
   without WSL; or more arm64 Linux boxes on a Mac than Tart's VMs fit.
2. msb keeps its CLI and its state formats for three months, or reaches
   1.0.
3. For boxes that join a tailnet
   ([050](050-a-box-can-join-the-operators-tailnet-as-an-ephemeral-node.md)):
   its UDP relay keeps one mapping per source port (upstream #498).

The operator has chosen to build it anyway. The second condition is what
the pinned release guards against (below). The third still keeps a box on
a tailnet on Tailscale's relays. #516 tracks the work.

### The build plan

In small pull requests, in this order:

1. **This record**, amended.
2. **The msb relay.** msb has no daemon or API socket, so the Docker
   relay ([042](042-a-docker-host-can-be-a-bb-machine.md)), which forwards
   Docker's socket, cannot carry it. bb-box's host entry on a BB machine
   gets a call that runs msb there, over the same kind of relay: each call
   is a channel carrying the command line, stdin, stdout, stderr, the exit
   status and a terminal's size. The entry runs only the pinned msb, and
   imports images from Docker on the machine. On BB's server, a small
   client stands in for the `msb` CLI, so transports use command lines as
   they do for Docker (031).
3. **The backend**, virtual, with:
   - the kinds `linux`, with Docker on an ext4 disk of the box's own, so
     `linux-docker` too ([041](041-every-linux-box-has-docker.md)), and
     `linux-desktop-cpu`, whose VNC server is reached as a Docker box's
     is;
   - a host that is BB's server, one over `ssh://`, or a BB machine
     through the msb relay, one backend per host, as for Docker;
   - our own OCI images, which bb-box never pulls: it imports them onto
     the host from Docker there, as `setup/docker/build.sh` builds or
     loads them, with `docker save` and `msb load`;
   - boxes that join BB as machines, as other Linux boxes do, with the
     interface's capacity and doctor checks;
   - the conformance suite, against a fake `msb` in the tests and against
     a real host;
   - a setup guide, `setup/microsandbox/README.md`, with what you need,
     steps, check, update, remove, and what to do when it goes wrong
     (#499).
4. **Then, each measured:** spares from forks or snapshots where the host
   allows them, each with a new identity before it enrols; the Wayland
   desktop; and arm64 boxes on a Mac.

### How the backend handles what the spike found

- **BB's server on a private or tailnet address**: boxes run with
  `--net public,private`.
- **`msb start` does not rerun the image's command**: the backend runs
  `bb-box-start` through `msb exec` after each start, and waits for
  `/run/bb-box/ready`, on a `/run` that is a tmpfs.
- **Docker in a box**: `/var/lib/docker` is an ext4 disk of the box's own,
  removed with it.
- **Proxmox LXC hosts**: LXC's seccomp filter answers EPERM to `FICLONE`,
  so snapshots and flat roots fail there. The guide recommends a VM or the
  machine itself, and the doctor tests `FICLONE` on the host. Boxes work in
  LXC without them.
- **A fork or snapshot copies its source's identity**: each box from one
  gets a new machine ID, SSH host keys and hostname, and no enrolment of
  its source's, before it enrols.
- **msb is beta**: bb-box pins one release and checks its SHA-256 against
  the one it was tested with. It installs msb, its guest agent and
  libkrunfw as one release, in a folder of bb-box's own data, apart from a
  user's `~/.microsandbox`, and keeps msb's state and images there too
  (`MSB_HOME`). It never runs `msb self update`. A new release is a change
  to bb-box that passes the conformance suite first, and the guide says
  how to upgrade.
- **Records a failed create leaves**: a create for a box that failed is
  made again with `--replace`, which only a box of this install and the
  same box ID may be.

### What it would add

Over Docker:

- a kernel per box: Docker in every box with no privileged container,
  where a Docker box with Docker is privileged and root on its host; TUN
  with no device line on the host; Chrome's own sandbox; systemd when
  wanted;
- full snapshots and forks of running boxes.

Over Tart, for Linux on a Mac:

- a box in under a second, where a Linux VM's cold clone takes about 5.5 s;
- the same OCI images as Docker, for both architectures.

### Why it was not built at first

- Docker already gives a Linux box in under a second. Docker and Proxmox
  LXC serve every Linux kind, including those on a GPU, which msb cannot.
- On Macs, Tart serves the arm64 kinds, and spares enrolled ahead
  ([032](032-spare-boxes-are-enrolled-ahead.md)) hide its boot. A fork
  copies its source's identity, so a forked spare still needs its own and
  an enrolment of about 5 s: forks would fill the pool faster, not shorten
  a handover.
- A kernel per box is isolation, which bb-box does not aim at.
- It is beta, with 12 releases from 24 August to 5 October, and breaking
  changes before 1.0, such as the network presets removed on 24 July.
- A box on a tailnet would reach its peers through Tailscale's DERP
  relays, not directly, as msb's UDP relay gives each destination its own
  host port (#498).

## What the built backend measured

Measured on 7 October 2026 with msb 0.7.7, the backend as built (with
each box's Docker disk made by bb-box, #568), and each backend's own flags
as bb-box passes them: 2 cores, `bbbox/linux:1`. Not enrolled means bb-box's
steps to a ready box (create, the start script, the ready file) without
BB's daemon; enrolled means through bb-box, until each box was a BB
machine.

### A Linux host with nested KVM

A Windows PC's WSL 2, a VM under Hyper-V, AMD Ryzen 7 9800X3D, 16 threads,
93 GiB. msb runs under nested KVM there; Docker runs natively in the VM.

| 20 at once, not enrolled | msb, 4 GiB | msb, 2 GiB | Docker, 4 GiB | Docker, 2 GiB |
| --- | --- | --- | --- | --- |
| All ready by | 3.65 s | 3.00 s | 1.57 s | 1.44 s |
| Median | 3.28 s | 2.35 s | 1.14 s | 1.08 s |
| Host memory each, idle | 210 MiB | 108 MiB | 6 MiB | 8 MiB |
| 20 removed in | 0.31 s | 0.29 s | 2.84 s | 2.96 s |

With msb's own disk for Docker, which formats ext4 whole, 20 at 4 GiB took
7.2 s, median 6.9 s.

| 10 at once, enrolled, 4 GiB | msb | Docker (9, for room) |
| --- | --- | --- |
| Ready, median and slowest | 5.8 s, 14.4 s | 10.1 s, 23.9 s |
| BB enrolment each | 119 to 160 s | 118 to 148 s |
| Host memory each, idle | 1.7 to 2.0 GiB | about 830 MiB |

- One box alone: msb ready in 1.6 s, enrolled 9.7 s later; a desktop in
  2.3 s. A stopped box starts again in 1.1 s.
- msb gives freed memory back: a 4 GiB guest that touched 2 GiB and freed
  it held 226 MiB again 31 s later, through free page reporting in 2 MiB
  blocks. What it keeps is the guest's page cache, which each microVM
  holds in its own RAM where Docker's containers share the host's, and
  free memory in pieces under 2 MiB. Enrolment fills the cache. Dropping
  the guest's caches took a busy 4 GiB guest from 2.3 GiB to 306 MiB, and
  reporting in 4 KiB pieces to 206 MiB. The idle floor follows the box's
  memory: 181 MiB at 4 GiB, 82 MiB at 2 GiB.
- Nesting slows msb's boot, not its memory: a plain `msb create` took
  0.65 s there against the spike's 0.39 to 0.47 s on bare-metal KVM.

### A Mac

An M4 Max, 16 cores, 128 GiB, macOS 27; msb on the Hypervisor framework,
with no nesting. The images are x86_64 and msb on a Mac runs arm64 guests
only, so msb ran an arm64 stand-in, `ubuntu:24.04`, with bb-box's create
flags and its three steps. The Mac has no Docker, so the comparison is
with Tart's Linux VMs, which serve Linux on a Mac now
([040](040-linux-on-arm64-has-kinds-of-its-own.md)). The Mac has no
`mkfs.ext4`, so a Docker disk is msb's own.

| 20 at once, not enrolled, arm64 stand-in | 4 GiB | 2 GiB | 4 GiB, Docker disk | 2 GiB, Docker disk |
| --- | --- | --- | --- | --- |
| All ready by | 1.24 s | 1.70 s | 3.00 s | 2.17 s |
| Median | 1.04 s | 1.37 s | 2.86 s | 1.84 s |
| RSS each, idle | 264 MiB | 155 MiB | 273 MiB | 165 MiB |
| 20 removed in | 0.35 s | 0.24 s | 0.80 s | 0.78 s |

- A fork of a running box that had written 1 GiB took 0.70 s, its child
  answering 68 ms later: APFS has reflinks.
- Tart, 10 `linux-arm64` boxes at once through bb-box, enrolled: ready in
  9.1 s median, 10.1 s slowest, enrolled in 135 to 142 s, holding 3.4 to
  3.9 GiB RSS each, 2.3 to 2.8 GB as macOS counts a footprint. msb has no
  Mac host in bb-box yet, so there is no enrolled msb run to set beside it.

### What it means

- On a Linux host, microsandbox buys isolation and fast removal, not
  memory: a kernel per box, so Docker in a box with no privileged
  container and Chrome with its own sandbox, and 20 boxes removed 7 to 10
  times faster than Docker's. On bare metal it makes boxes as fast as
  Docker; under nested KVM, as in WSL 2, Docker is about twice as fast.
  Each microVM holds its own page cache where Docker's containers share
  the host's, so an idle box takes far more memory.
- On a Mac, microsandbox is the clear win over Tart for Linux boxes: 20 at
  once ready in 1 to 3 s, where one Tart Linux VM takes about 9 s and
  holds several times the memory.

### A Linux host without nesting

A Proxmox LXC box with `/dev/kvm` passed in, as the spike's: KVM on bare
metal, an AMD Threadripper PRO 9975WX, the box at 8 cores and 16 GiB. msb
and Docker ran in the same box, with `bbbox/linux:1` and each backend's
flags, as on the nested host.

| 20 at once, not enrolled | msb, 4 GiB | msb, 2 GiB | Docker, 4 GiB | Docker, 2 GiB |
| --- | --- | --- | --- | --- |
| One alone | 0.44 s | 0.41 s | 0.29 s | 0.30 s |
| All ready by | 1.47 s | 1.26 s | 1.42 s | 1.32 s |
| Median | 1.25 s | 0.89 s | 1.21 s | 1.14 s |
| Memory each, idle | 212 MiB | 110 MiB | under 10 MiB | 6 MiB |
| 20 removed in | 0.23 s | 0.22 s | 1.71 s | 1.54 s |

- Without nesting, msb makes boxes as fast as Docker: about the same at
  4 GiB, faster at 2 GiB. Most of the gap on the nested host was nesting.
- Memory does not change with nesting: about 210 MiB per idle 4 GiB box,
  against a few MiB for a Docker box.
- There is no enrolled run here: the box was not an msb host in bb-box.

## What the spike measured

### Our images boot unchanged

- msb's agent, `init.krun`, is PID 1 and runs the image's CMD,
  `bb-box-start`, as Docker's `--init` does. `/run/bb-box/ready` appeared
  0.39 to 0.47 s after `msb run -d` for `bbbox/linux:1`, and 0.74 s after
  it for `bbbox/linux-desktop:1`.
- `--init /lib/systemd/systemd` makes systemd PID 1 instead. sshd and
  Docker's socket started; only `systemd-sysctl` failed.
- `msb start` boots a stopped box without the CMD. Started through
  `msb exec`, `bb-box-start` had a stopped desktop ready again 0.59 s after
  `msb stop` began. Under systemd, units start at each boot.
- `/run` is a tmpfs only when asked for with `--tmpfs /run`, as Docker
  boxes have it, so that `ready` does not outlive a stop.
- sshd runs. BB's host app downloaded from BB's server in 0.04 s and Node
  ran, which is what enrolment needs. A live enrolment was not tried.
- The desktop, on the CPU: Xtigervnc, XFCE and Cua Driver's socket came
  up. A VNC client through a published port signed in with the VNC
  password, captured 1920 by 1080 in 0.32 s and typed into Mousepad.
  `xrandr` resized it. Chrome ran with its own sandbox, which a Docker box
  cannot.

### Network

| What | Result |
| --- | --- |
| HTTPS to the internet | by default; about 0.2 s to GitHub |
| BB's server on a private or tailnet address | only with `--net public,private`. By default msb's DNS answers NXDOMAIN for a name with a private, 100.64.0.0/10 or link-local address, and the traffic is dropped |
| Machines on the local network | as for BB's server |
| Into the box | published ports (`-p host:guest`) on the host's addresses: SSH to the box through one took 0.23 s. Guests have no address reachable from outside |
| UDP | through msb's relay |
| IPv6 | on a host with IPv4 only, a guest had no IPv6 address and no AAAA answers, and a dual-stack name connected over IPv4 in 16 ms. Not tried on a dual-stack host |
| `/dev/net/tun` | present. tailscaled 1.102.4 made `tailscale0` and ran "without policy routing", which the guest kernel lacks, with tunnelled IPv6 off. Joining was not tried |

Guest traffic goes through msb's own TCP/IP stack in the host process, not
a bridge.

### Docker in a box

The guest kernel has what dockerd needs: bridges, veth, nf_tables, overlay
and cgroup v2. It has no modules, IP_VS, WireGuard or AppArmor.

- dockerd 29 started as in a Docker box, but containers failed on the
  default root, which is overlayfs, as overlayfs cannot sit on it.
- With `/var/lib/docker` on an ext4 disk of the box
  (`--mount-owned /var/lib/docker:kind=disk,size=20G`), or on a flat ext4
  root, `docker run`, a published nginx and `docker build` worked, with no
  privileged container. On the Mac, arm64 Docker ran containers and a
  published nginx the same way.

### Speed and density

| From the request to a box that answers | Time |
| --- | --- |
| msb on Linux, `bbbox/linux:1` | 0.39 to 0.47 s |
| msb on Linux, 20 `bbbox/linux:1` boxes at once | 0.70 s median, all by 0.89 s |
| msb on Linux, `bbbox/linux-desktop:1` | 0.74 s |
| msb on Linux, a flat ext4 root, copied | 1.2 to 3.2 s |
| msb on the Mac, `msb create` of `ubuntu:24.04` | 0.35 s |
| Docker on a local host ([031](031-docker-boxes-are-reached-through-docker-exec.md)) | 0.33 s; 0.62 s with Docker or a desktop |
| Proxmox LXC, a new clone at a custom size, the same day | 4.5 s |
| Tart, a Linux VM's cold clone ([040](040-linux-on-arm64-has-kinds-of-its-own.md)) | about 5.5 s |

- `msb exec true` took about 10 ms. 50 MB went in through stdin in
  0.39 s, and through `msb cp` in 0.14 s.
- Stopping took 0.09 to 0.15 s and starting 0.17 to 0.18 s. The disk is
  kept.
- `--cpus`, `--memory` and `--root-disk` set the size, which defaults to
  1 core, 512 MiB and 4 GiB. The root is sparse. `msb modify` resizes.
- An idle `bbbox/linux` box held 92 to 120 MiB of the Linux host's memory,
  and an idle desktop 1.26 GiB. A box that touched 2 GiB and freed it gave
  it back within 10 s. msb reserves nothing: 20 boxes of 2 GiB ran on a
  host of 16 GiB. On the Mac, 24 small VMs held about 390 MiB each, as
  macOS counts it.
- `msb load` took 5.7 s for the linux image's 758 MB archive, and 19.7 s
  for the desktop's 1.7 GB.

### Snapshots and forks

| | Linux in Docker | The Mac |
| --- | --- | --- |
| Disk snapshot of a running box | 0.27 s | 0.16 s |
| A new box from it | 0.50 s | 0.23 s |
| Full snapshot, with memory | 0.85 s | 0.97 to 1.05 s |
| A new box from it, its processes running | 0.19 s | 0.12 s |
| A fork of a running box | 0.77 s | 0.74 s; 1.0 s for 10 |

- In the LXC container, snapshots and flat roots failed. Its seccomp filter
  answers EPERM to `FICLONE`, and msb falls back to copying only on
  ENOTSUP, EXDEV or EINVAL. Flat roots worked there with `clone=copy`,
  copying 2.1 GB for each box. Forks worked: 0.80 s for one and 0.41 s for
  five.
- A fork or a full snapshot is a copy of its source: the same hostname,
  as measured, and the same files, so the same machine ID, SSH host keys
  and BB enrolment.

### Rough edges

- A create that failed left a record that `msb ls` did not show: a new
  create said the name already existed, and `msb rm` said it was not
  found. `--replace` cleared it.
- A flat root could not use an image added with `msb load`, only one from
  a registry (compare upstream #1764).

## Kinds it could serve

| Kind | Host | Result |
| --- | --- | --- |
| `linux`, with Docker ([041](041-every-linux-box-has-docker.md)) | Linux with KVM | yes, measured |
| `linux-desktop-cpu` | Linux with KVM | yes, measured |
| `linux-desktop-wayland-cpu` | Linux with KVM | likely, not tried |
| `linux-arm64`, `linux-arm64-desktop-cpu` | a Mac with Apple silicon | yes, once our images build for arm64 from the arm64 pins Tart's Linux images use; tried with `ubuntu:24.04` only |
| `linux-desktop` | | no: msb has no GPU |
| macOS and Windows kinds | | no: msb runs Linux guests only |

## How it fits, as the spike found

**Setup for a user:**

- msb's release for the host, about 30 MB with libkrunfw beside it, and no
  daemon. A Mac needs nothing more.
- Linux needs KVM, the user in the `kvm` group, and glibc 2.28 or later.
  In an LXC container the host passes `/dev/kvm` in, and the user still
  needs the group, as udev inside resets the node's mode. Snapshots and
  flat roots then fail, so the guide recommends a VM or the machine itself.
- bb-box reaches msb on a BB machine through
  [042](042-a-docker-host-can-be-a-bb-machine.md)'s relay, so a user's own
  Mac or Linux PC needs no SSH, or over SSH, as Tart's Macs.
- bb-box installs the release it was tested with, checked against its
  published SHA-256, in a home of its own (`MSB_HOME`), apart from the
  user's `~/.microsandbox`. msb, its guest agent and libkrunfw are one
  release, which bb-box upgrades, never `msb self update`. The doctor
  checks the version.
- Images come from build.sh through `msb load`, or from a registry, which
  hosts without Docker and flat roots need. A project's image
  ([049](049-a-project-image-is-a-script-on-the-standard-image-and-images-are-rebuilt-when-stale.md))
  is a disk snapshot of its build box on each host, restored for each box
  in 0.2 to 0.5 s.

**The backend interface:**

| Part | With msb |
| --- | --- |
| `acquire` | `msb run -d` with labels for the install and the box, the size, the hostname, `--tmpfs /run`, the network profile and an ext4 disk for Docker, then a wait for `ready` through `msb exec` |
| Commands | `msb exec`, as Docker's are `docker exec` (031): stdin, the box user and exit codes |
| Files | `msb cp`, or `msb exec` with stdin |
| Display | RFB through `msb exec` and `socat`, as on Docker, or a published port on the host's loopback |
| `start`, `stop`, `power` | `msb start`, then `bb-box-start` through `msb exec`; `msb stop`; `msb inspect` |
| `held`, `release` | `msb ls --format json --label`; `msb stop` and `msb rm` |
| `capacity` | the host's cores and memory, at each box's size |
| `doctor` | `msb doctor`, the pinned version, KVM, a `FICLONE` test, and the network profile that BB's server needs |

The conformance suite's Linux checks would apply as they are. Resizing
([021](021-desktop-resize-through-the-backend.md)) worked in the box.

**Gaps to handle:**

- start `bb-box-start` after each `msb start`, or boot systemd;
- `--tmpfs /run`, and an ext4 disk for `/var/lib/docker`;
- the private network profile when BB's server or the user's network has
  private or tailnet addresses;
- a new identity after a fork or a full restore, before enrolment;
- a host outside LXC, or snapshots and flat roots off;
- `--replace` against the records a failed create leaves;
- arm64 builds of our images.

## Consequences

- A sixth backend, `microsandbox`, in `src/backends/microsandbox/`, with
  its guide in `setup/microsandbox/`. The README and the architecture list
  it with its status.
- bb-box's host entry runs msb on a BB machine for it: the pinned release
  only, from bb-box's own data folder.
- Not measured yet, and measured as the plan reaches them: a dual-stack
  host, a live enrolment, a tailnet join, the Wayland desktop, our images
  on arm64, Windows hosts, and forks on a host without `FICLONE`, where
  msb copies the box's disk.
- Until 1.0, upstream may change the CLI or state formats. A pinned
  release, upgraded by bb-box after the conformance suite passes, is the
  guard.
