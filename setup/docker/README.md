# Docker backend

This backend runs Linux boxes as containers on one Docker host: the Docker on
BB's server, another machine's over SSH, or a BB machine's, through BB. It is
the quickest way to try bb-box, as it needs only Docker. It offers three
kinds:

- **linux**: Ubuntu 24.04 with the same tools as a Proxmox LXC linux box;
- **linux-desktop-cpu**: XFCE and Chrome, drawn by the CPU, shown in the
  thread's panel with shared control, and computer use through Cua Driver;
- **linux-desktop**: the same desktop on one of the host's NVIDIA GPUs,
  through the NVIDIA Container Toolkit (off by default).

All of them enrol in BB as machines, as Proxmox LXC boxes do.

Both images have Docker installed, as every Linux image does
([decision 041](../../docs/decisions/041-every-linux-box-has-docker.md)).
By default each box is a privileged container with a Docker daemon of its
own, which its first `docker` command starts. With `privileged` off, or on
rootless Docker, every box here is unprivileged and says No Docker. An
agent that must have Docker asks for `linux-docker` rather than `linux`:
that takes only offers with Docker, here or on another backend.

The bb-box plugin, on BB's server, runs the `docker` CLI for every call. It
runs commands and copies files in a box with `docker exec`, and streams the
desktop through `socat` under `docker exec`. No SSH server runs in a box, and
BB's server needs no network path to the containers, so a Docker host over
SSH works as the local one does ([decision 031](../../docs/decisions/031-docker-boxes-are-reached-through-docker-exec.md)).

On a Linux host with local Docker, a linux box was ready 0.4 s after it was
asked for, and a linux-desktop-cpu box 0.6 s, its desktop running. Neither
waits for Docker: a box's first `docker` command took 0.3 s, as it started
the daemon. A desktop stream opened in under 0.1 s. Over `ssh://`, every
`docker` call logs in over SSH again, unless the calls share one connection
([Requirements](#requirements)). At a 2 ms round trip, the seven calls that
make a box took 2.1 s, against 0.43 s on a shared connection and 0.26 s on
the local socket, and a `docker exec` took 0.5 s, against 0.09 s (#97).

| Path | What it does |
| --- | --- |
| `build.sh` | Builds the two images on the Docker host |
| `Dockerfile` | The images, made by the Proxmox LXC template's guest scripts |
| `customize.sh` | Runs those scripts inside the image as it is built |
| `start` | A box's main process: starts its services, then waits |

## Limits

- **Not a security boundary.** A box is a container: it shares the host's
  kernel, and its user may use `sudo` in it. By default a box is a
  privileged container, which can take over the Docker host. Turn
  `privileged` off where the agents may not do that.
- **No systemd.** A box runs no init system, so `systemctl` does not work in
  it. The image's main process starts what a box needs. Use a Proxmox LXC box
  for work that needs systemd.
- **No disk size.** Boxes share the Docker host's disk, so a box cannot be
  given a disk of its own size. Ask for the base disk.
- **Chrome without its sandbox.** Docker's default seccomp profile stops
  Chrome making the namespaces of its sandbox, so a desktop box runs Chrome
  with `--no-sandbox`. The box is the boundary.
- **x86_64.** The images hold x86_64 builds. On an Arm host, such as Docker
  Desktop on a Mac with Apple silicon, boxes run under emulation, slowly.
- **Enrolment.** A box enrols in BB by reaching BB's server URL from inside
  its container. If BB listens only on the Docker host's localhost, a box
  cannot reach it, and enrolment fails. Then either make BB listen on an
  address the containers reach, or turn off **Enrol boxes as BB machines**
  in BB Box's settings: commands, file copies, desktops and computer use work
  without it.

## Requirements

- Docker Engine with BuildKit, on Linux, or Docker Desktop. bb-box was tested
  with Docker 29.8, rootful, on Linux, and with Docker Desktop on Windows as
  a BB machine's ([Docker Desktop on a Windows PC](#docker-desktop-on-a-windows-pc)).
  Rootless Docker has not yet been tested with bb-box. It needs systemd to
  delegate the cpu cgroup controller to the user that runs it, as systemd
  252 and later do. With an older systemd, Docker refuses each box's CPU
  limit, so no box starts; the doctor fails and gives the fix (#94). Rootless
  Docker cannot run the privileged containers that give boxes Docker, so
  there boxes say No Docker, and the doctor warns.
- The `docker` CLI on BB's server, on the PATH of the user BB runs as, and
  that user allowed to use Docker. On Linux, add it to the `docker` group.
  For a Docker host over SSH, that user must log in to it with a key and no
  prompt, as a user who may use Docker there. Let the `docker` calls share
  one SSH connection, which makes each about 0.2 s faster, in that user's
  `~/.ssh/config`:

  ```
  Host docker.example.com
    ControlMaster auto
    ControlPath ~/.ssh/cm-%C
    ControlPersist 10m
  ```

  The doctor warns when they do not. Calls beyond sshd's `MaxSessions`, 10
  by default, open their own connections. ssh on Windows cannot share
  connections.
- Memory for the boxes: by default bb-box keeps 4 GiB of the host's memory
  free, and a small linux box has a 4 GiB limit, so the host needs at least
  8 GiB.
- Disk to build the images: about 25 GB free on the Docker host for both,
  10 GB for the linux image alone and 18 GB for the desktop image alone.
  From an empty cache, building both used about 17 GB, for the images and
  Docker's build cache; the rest leaves room for an earlier build's.
  `build.sh` does not start with less free, and says how much is free.
  Once the images are built, `docker builder prune` frees the build cache.

## 1. Build the images

bb-box never pulls an image. Build both on the Docker host:

```sh
git clone <bb-box repository> && cd bb-box
setup/docker/build.sh
```

`build.sh linux` or `build.sh desktop` builds one. `--bb-url
https://bb.example.com` puts BB's host app in the images, so a box enrols
without downloading it. The app is the images' last layer, and its build
argument is the digest that BB's server gives for it, so after BB's app
changes, running `build.sh` again installs the new app and keeps the rest
cached. To build on a Docker host over SSH, run it with
`DOCKER_HOST=ssh://user@host`, or with that host's Docker context in use.

Before it builds, `build.sh` checks that the Docker host has the disk free
that the build needs, as Requirements says, with `df` in a container from
Ubuntu's image.

The build starts from Ubuntu's container image, pinned by digest, installs
Ubuntu's packages from a pinned snapshot on snapshot.ubuntu.com, and checks
each other download against its pinned SHA-256. When the snapshot service
has an outage, the build retries for a few minutes, then fails; run it again
later.

Building both takes about 10 minutes, mostly downloads. The images are
`bbbox/linux:1` and `bbbox/linux-desktop:1`, and the `1` is the images'
layout version, which `bb box doctor` checks.

## 2. Settings

In BB, on BB Box's settings page, set up the Docker backend and turn it on. Its fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `host` | empty | `unix:///path/to/docker.sock` or `ssh://user@host`. Empty uses the `docker` CLI's own default on BB's server: `DOCKER_HOST`, its current context, or the local socket |
| `linux-image` | `bbbox/linux:1` | The image of linux boxes. Empty turns them off |
| `desktop-image` | `bbbox/linux-desktop:1` | The image of linux-desktop-cpu and linux-desktop boxes. Empty turns them off |
| `privileged` | on | Docker in boxes: each box is a privileged container with a Docker daemon of its own, started by its first `docker` command. Off, boxes say No Docker |
| `gpu-desktops` | off | Offers linux-desktop boxes, on the GPUs the NVIDIA Container Toolkit lists |
| `desktops-per-gpu` | 4 | The most linux-desktop boxes on one GPU |
| `network` | `bbbox` | The network bb-box makes for its boxes |
| `boxes` | 10 | The most bb-box containers on the host, running or stopped, of every bb-box install that uses it |
| `reserve-memory-mib` | 4096 | A new box is refused when the host would have less memory than this left, after the limits of the running boxes |

From a terminal, `bb box config show --json` prints the configuration and
`bb box config apply <file>` saves it. The Docker backend's entry is:

```json
{ "id": "docker", "type": "docker", "enabled": true, "fields": {} }
```

Then `bb box doctor` checks the `docker` CLI, the daemon, that it can limit a
box's CPU and memory, each image, the network, Docker in boxes, GPU desktops
when they are on, and the room on the host. It also gives bb-box's install ID,
which labels its containers.

### Trying it without BB

The conformance suite runs against the backend without BB. With a
configuration file such as `docker.json`:

```json
{ "backends": [{ "id": "docker", "type": "docker", "enabled": true, "fields": {} }] }
```

```sh
npm install
npm run conformance -- --backend docker --settings docker.json
```

It acquires a box of each kind, checks it, and releases it. Without BB, it
skips enrolling the boxes, and says so.

## Docker Desktop on a Windows PC

A Windows PC with Docker Desktop can be the Docker host as a BB machine,
reached through BB ([042](../../docs/decisions/042-a-docker-host-can-be-a-bb-machine.md)).
BB's host app runs in a WSL 2 distribution that has Desktop's WSL
integration, and bb-box reaches Desktop's socket there. Over `ssh://` it
does not work (#158). For a PC that hosts boxes with nobody signed in, use
[Docker in WSL](../docker-wsl/README.md) instead.

We tested it with Docker Desktop 4.93 and Ubuntu 26.04, in a Windows 11 Pro
VM with 8 cores and 16 GiB (#233). Building both images took 14 minutes. A
linux box was ready 1.9 s after it was asked for, and a linux-desktop-cpu
box 1.5 s, its desktop and computer use working. Each enrolled in BB in
22 to 25 s, most of it BB's installer, as the images bb-box builds on a
machine do not hold BB's host app. A command took 0.2 s, a 16 MiB copy
under 4 s, and Docker in a box worked.

1. Install WSL and Ubuntu, in PowerShell as an administrator:
   `wsl --install -d Ubuntu`. Restart Windows if it asks. Ubuntu runs
   systemd.
2. In Ubuntu, choose the user BB will run as. Make it the default user,
   under `[user]` in `/etc/wsl.conf`, so that Desktop puts it in the
   `docker` group. Turn on linger for it, so its services run with no one
   logged in to it: `sudo loginctl enable-linger <user>`.
3. Install Node.js 22.19 or later, with npm, which BB's installer needs.
4. Install Docker Desktop with the WSL 2 backend. In its settings, turn on
   Start Docker Desktop when you sign in, and, under Resources, WSL
   integration for Ubuntu. Both were off after a quiet install.
5. Check that `docker version` in Ubuntu, as that user, shows the server.
   Desktop makes the `docker` group there, and puts the default user in it,
   when integration first starts.
6. Enrol Ubuntu in BB as a machine, as that user. If BB's host app was
   there before step 4, restart the user's services so it has the group:
   `sudo systemctl restart user@$(id -u <user>).service`.
7. In BB Box's settings, turn the machine on under Docker on BB machines.

Before you rely on it:

- Desktop runs only while someone is signed in to Windows. It keeps the
  distribution running, and stops it when it quits, so the machine is
  offline in BB then, and boxes there with it. After Desktop started again,
  the machine was back in 25 s and its boxes in 50 s, with their files.
- Docker has the memory WSL gives its VM, half the PC's by default. bb-box
  keeps 4 GiB of it free, so on a 16 GiB PC one small box fits. Set
  `memory` in `.wslconfig` in your Windows profile for more.
- `build.sh`'s check of the disk free sees Desktop's virtual disk, about
  1 TB, which grows as it fills, not the Windows drive. Building both
  images grew it by 16 GB, so check the drive has about 25 GB free.
- With no containers running for 5 minutes, Desktop's Resource Saver
  pauses Docker, and the next call takes about 2.5 s.
- When Windows restarts, BB may go on showing the machine connected until
  the connection times out: 16 minutes in our test. bb-box takes it as
  offline once BB has not heard from it for a minute.

## GPU desktops

A linux-desktop box gets one NVIDIA GPU through the Container Device
Interface (CDI). On the Docker host:

1. Install the NVIDIA driver and the
   [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).
2. Generate the toolkit's CDI spec, which names each GPU:
   `sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml`. Run it again
   after each driver upgrade.
3. Docker Engine 28.2 and later read CDI specs by default; for an older one,
   set `"features": {"cdi": true}` in `/etc/docker/daemon.json` and restart
   Docker.
4. Check that `docker info` lists the GPUs under Discovered Devices, then turn
   on the `gpu-desktops` field.

bb-box gives each desktop the GPU with the fewest desktops, by its UUID, and
counts a stopped desktop against its GPU, since it takes the GPU again when it
starts. The toolkit mounts the host driver's own libraries into the box, so
they always match the driver. A desktop with Docker is privileged, so it sees
every GPU on the host: its start script asks `nvidia-smi` for the PCI bus ID
of the GPU placed, and gives it to Xorg as its `BusID` and to the display,
which reads that GPU's free memory (#283). When the GPU cannot be found or
cannot drive the display, the desktop falls back to the CPU, as on Proxmox
LXC, and the reason is in the container's log. A desktop image built before
this lacks the `bbbox.gpu-bus-id` label. A GPU desktop on such an image stays
unprivileged and says No Docker, and the doctor warns, until the image is
built again.

GPU desktops have not yet been tested on a Docker host with a GPU.

## How the plugin drives a box

- **Acquire.** A box's container is named `bbbox-<box ID>` and carries
  labels that name bb-box's install, the box, its thread, its name and its
  kind, from the moment it is made. bb-box records the container's name
  before it makes it, so an acquire that stops halfway leaves nothing behind
  once it is cleaned up. The container runs on the `bbbox` network, on which
  boxes reach the internet but not each other.
- **Limits.** `--cpus` and `--memory` give the box its size, with no swap
  beyond it. `/dev/shm` is half the memory, at least 1 GiB, for Chrome. Each
  box runs under Docker's `--init`, with at most 16384 processes.
- **Start.** The image's main process, `bb-box-start`, clears what a hard
  stop leaves behind. In a box with Docker it listens on Docker's socket
  with `systemd-socket-activate`, so the first `docker` command starts
  Docker's daemon; a box with containers starts it at once, so their restart
  policies work. In a desktop box it starts the display, the session and Cua
  Driver. Then it writes `/run/bb-box/ready`, once Docker's socket is the
  `docker` group's, without waiting for Docker's daemon.
  bb-box waits for that file, then runs BB's bootstrap, which starts BB's
  daemon in the box.
- **Stop and start.** `docker stop` and `docker start`. The restart policy is
  `unless-stopped`, so after a Docker or host restart a running box starts
  again and a stopped box stays stopped.
- **Release.** `docker rm --force --volumes`, which also removes a box's
  Docker data.
- **Other containers.** bb-box acts only on a container whose labels name its
  install and the box. It leaves other containers alone, and other installs'
  boxes too, though they count against the most boxes.
- **Room.** A box is refused when the host would have fewer than the memory
  kept free left after the limits of the running boxes, when it asks for more
  cores than the host has, or when the host has the most boxes. There is no
  warm pool: a box is ready in about a second.

## Troubleshooting

- **"has no image"**: build the images (step 1) on the Docker host the
  `host` field names.
- **"permission denied" on the Docker socket**: add the user BB runs as to the
  `docker` group, then restart BB. For a BB machine's Docker, that is the
  user BB's host app runs as. Restart its services so it has the group:
  `sudo systemctl restart user@$(id -u <user>).service`. An earlier bb-box
  said only `EOF`.
- **A box does not come up**: `docker logs bbbox-<box ID>` shows its main
  process's output. bb-box's error message gives the last lines too.
- **A box does not enrol**: see Enrolment under Limits.
- **Removing everything bb-box made**: release the boxes from BB. Then
  `docker ps -a --filter label=bbbox.backend=docker` lists any left, and
  `docker network rm bbbox` removes its network.
