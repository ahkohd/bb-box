# Docker backend

This backend runs Linux boxes as containers on one Docker host: the Docker on
the machine that runs BB, another machine's over SSH, or a BB machine's,
through BB. It is the quickest way to try bb-box, as it needs only Docker. It
offers four kinds:

- **linux**: Ubuntu 24.04 with the same tools as a Proxmox LXC linux box;
- **linux-desktop-cpu**: XFCE and Chrome, drawn by the CPU, with computer use
  through Cua Driver;
- **linux-desktop**: the same desktop on one of the host's NVIDIA GPUs (off by
  default);
- **linux-desktop-wayland-cpu**: Sway on Wayland, drawn by the CPU. X11-only
  apps do not run there. It is on Ubuntu 26.04 (the Dockerfile's
  `UBUNTU_WAYLAND`), whose Sway and wayvnc carry the box's own pointer
  shapes, as the Proxmox LXC Wayland template is.

Boxes join BB as machines, as Proxmox LXC boxes do. By default each box is a
privileged container with a Docker daemon of its own, which its first
`docker` command starts (041).

bb-box runs the `docker` CLI on the machine that runs BB, and reaches inside a
box with `docker exec`, so it needs no network path to the containers (031). A
box is ready in about a second, on a local Docker host or over SSH with a
shared connection. How bb-box drives a box is in the
[architecture](../../docs/architecture.md#backends).

| Path | What it does |
| --- | --- |
| `build.sh` | Builds the images on the Docker host |
| `Dockerfile` | The images, made by the Proxmox LXC template's guest scripts |
| `customize.sh` | Runs those scripts inside the image as it is built |
| `start` | A box's main process: starts its services, then waits |

## What you need

- Docker Engine with BuildKit on Linux, or Docker Desktop. bb-box is tested
  with rootful Docker 29 on Linux, and with Docker Desktop on Windows as a BB
  machine's (below). Rootless Docker needs systemd 252 or later, which lets
  it limit each box's CPU, and the cpuset controller delegated to its user
  (below); boxes there have no Docker of their own.
- The `docker` CLI on the machine that runs BB, on the PATH of the user BB
  runs as, and that user allowed to use Docker: on Linux, in the `docker`
  group.
- For a Docker host over SSH: that user logs in to it with a key and no
  prompt, as a user who may use Docker there.
- Memory for the boxes: bb-box keeps 4 GiB of the host's memory free by
  default, and a small linux box has a 4 GiB limit, so the host needs at
  least 8 GiB. A small desktop box has 8 GiB, so for one the host needs at
  least 12 GiB.
- Disk to build the images, on the Docker host: about 36 GB free for all
  three, 10 GB for the linux image alone and 18 GB for either desktop image
  alone. `build.sh` does not start with less free.

Before you rely on it:

- **Not a security boundary.** A box is a container that shares the host's
  kernel, and its user may use `sudo`. A privileged box, the default, can take
  over the Docker host. Turn `privileged` off where the agents may not do
  that; boxes then have no Docker.
- **No systemd.** `systemctl` does not work in a box. Use a Proxmox LXC box
  for work that needs systemd.
- **No disk size.** Boxes share the host's disk, so a box cannot have a disk
  size of its own.
- **Chrome without its sandbox.** Docker's default seccomp profile stops
  Chrome's sandbox, so a desktop box runs Chrome with `--no-sandbox`.
- **x86_64.** The images are x86_64. On an Arm host, such as a Mac with Apple
  silicon, boxes run under emulation, slowly.
- **Enrolment.** A box joins BB by reaching BB's server URL from inside its
  container. If BB listens only on the Docker host's localhost, a box cannot
  reach it. Make BB listen on an address the containers reach, or turn off
  **Enrol boxes as BB machines** in BB Box's settings: commands, copies,
  desktops and computer use work without it.

## What a box sees

A box sees its own cores and memory, as on Proxmox LXC:

- **Cores.** bb-box pins each box to as many of the host's CPUs as it has
  cores, so `nproc` and `make -j$(nproc)` say the box's cores.
- **Memory.** Where the host runs LXCFS, `free`, `/proc/meminfo`,
  `/proc/cpuinfo` and the uptime are the box's own. Without LXCFS they
  show the host's, though the box's limits still hold. Docker Desktop
  cannot have LXCFS.

To add LXCFS on a Linux Docker host:

```sh
sudo apt install lxcfs
sudo systemctl enable --now lxcfs
```

Boxes made after that see their own memory. Boxes made before keep the
host's numbers until they are made again.

If the Docker host is itself a Proxmox LXC container, there is nothing to
add: Proxmox's LXCFS serves the container, and bb-box uses it.

**Reload LXCFS, never restart it.** A restart breaks `free` and
`/proc/meminfo` in every running box until that box stops and starts.
Use `sudo systemctl reload lxcfs`. To stop anything restarting it, as
bb-box's Hetzner Cloud hosts do:

```sh
sudo mkdir -p /etc/systemd/system/lxcfs.service.d
printf '[Unit]\nRefuseManualStop=yes\n' | sudo tee /etc/systemd/system/lxcfs.service.d/keep-running.conf
sudo systemctl daemon-reload
```

**Rootless Docker** pins boxes only when systemd gives its user the
cpuset controller. Until then a box gets `OMP_NUM_THREADS`, which `nproc`
follows. To give it:

```sh
sudo mkdir -p /etc/systemd/system/user@.service.d
printf '[Service]\nDelegate=cpu cpuset io memory pids\n' | sudo tee /etc/systemd/system/user@.service.d/delegate.conf
sudo systemctl daemon-reload
```

Then restart the host.

The doctor checks both: **Cores a box sees** and **Memory and CPUs a box
sees**.

## Steps

### 1. Reach Docker

On the machine that runs BB, as the user BB runs as, check that the `docker`
CLI reaches the Docker host:

```sh
docker info                                 # the local Docker
DOCKER_HOST=ssh://user@host docker info     # a Docker host over SSH
```

Over SSH, let the `docker` calls share one connection, in that user's
`~/.ssh/config`. Each call is then about 0.2 s faster, and the doctor warns
when they do not share:

```text
Host docker.example.com
  ControlMaster auto
  ControlPath ~/.ssh/cm-%C
  ControlPersist 10m
```

Calls beyond sshd's `MaxSessions`, 10 by default, open their own
connections. ssh on Windows cannot share connections.

### 2. Build the images

bb-box never pulls an image. Build them on the Docker host, from a checkout
of bb-box anywhere the `docker` CLI reaches it:

```sh
git clone <bb-box repository> && cd bb-box
setup/docker/build.sh                                 # all three images
setup/docker/build.sh linux                           # one: linux, desktop or desktop-wayland
DOCKER_HOST=ssh://user@host setup/docker/build.sh     # on a Docker host over SSH
```

- Building all three takes about 15 minutes, mostly downloads. The images are
  `bbbox/linux:1`, `bbbox/linux-desktop:1` and
  `bbbox/linux-desktop-wayland:1`.
- `--bb-url https://bb.example.com` puts BB's app in the images, so a box
  joins BB without downloading it.
- The build starts from Ubuntu's image, pinned by digest, installs Ubuntu's
  packages from a pinned snapshot, and checks every other download against
  its pinned SHA-256. When the snapshot service has an outage, the build
  retries for a few minutes, then fails: run it again later.
- The Docker host keeps the build's downloads between builds, in two of
  BuildKit's cache mounts (#96): the pinned tool files (`bb-box-artifacts`)
  and Ubuntu's packages (`bb-box-apt`). Each holds only what the current
  pins and snapshot use, and each file is still checked, so a rebuild
  downloads only what changed.
- Once the images are built, `docker builder prune` frees the build cache,
  the downloads too.
- `--arch arm64`, on an arm64 Docker host, builds `bbbox/linux:1-arm64` and
  `bbbox/linux-desktop:1-arm64` for microsandbox on a Mac (053), from the
  same scripts with their arm64 pins, as for Tart's Linux images. Ubuntu has
  no snapshots of its arm64 archive, so those packages come from the live
  archive. There is no Wayland desktop for arm64 yet.

### 3. Configure bb-box

On BB Box's settings page in BB, set up the Docker backend: fill in its
fields, press Check, then Save and turn on.

| Field | Default | Meaning |
| --- | --- | --- |
| `host` | empty | `unix:///path/to/docker.sock` or `ssh://user@host`. Empty uses the `docker` CLI's own default: `DOCKER_HOST`, its current context, or the local socket |
| `linux-image` | `bbbox/linux:1` | The image of linux boxes. Empty turns them off |
| `desktop-image` | `bbbox/linux-desktop:1` | The image of linux-desktop-cpu and linux-desktop boxes. Empty turns them off |
| `wayland-desktop-image` | `bbbox/linux-desktop-wayland:1` | The image of linux-desktop-wayland-cpu boxes. Empty turns them off |
| `privileged` | on | Each box is a privileged container with a Docker daemon of its own. Off, boxes have no Docker |
| `gpu-desktops` | off | Offers linux-desktop boxes, on the GPUs the NVIDIA Container Toolkit lists |
| `desktops-per-gpu` | 4 | The most linux-desktop boxes on one GPU |
| `network` | `bbbox` | The network bb-box makes for its boxes, on which they reach the internet but not each other |
| `boxes` | 10 | The most bb-box containers on the host, running or stopped, of every bb-box install that uses it |
| `reserve-memory-mib` | 4096 | A new box is refused when the host would have less memory than this left, after the limits of the running boxes |

From a terminal, `bb box config show --json` prints the configuration, and
`bb box config apply <file>` saves it. The Docker backend's entry is
`{ "id": "docker", "type": "docker", "enabled": true, "fields": {} }`.

#### A cloud server

A server rented from a cloud provider, such as Hetzner Cloud, can be the
Docker host as a BB machine, with nothing open to the internet: see
[a cloud server as a Docker host](../../docs/guide/cloud-docker-host.md).

#### Docker Desktop on a Windows PC

A Windows PC with Docker Desktop can be the Docker host as a BB machine,
reached through BB (042), not over SSH. Docker Desktop runs only while
someone is signed in to Windows: for a PC that hosts boxes with nobody signed
in, use [Docker in WSL](../docker-wsl/README.md) instead.

1. Install WSL and Ubuntu, in PowerShell as an administrator:
   `wsl --install -d Ubuntu`. Restart Windows if it asks.
2. In Ubuntu, pick the user BB will run as. Make it the default user, under
   `[user]` in `/etc/wsl.conf`, so Docker Desktop puts it in the `docker`
   group. Turn on linger for it, so its services run with nobody logged in:
   `sudo loginctl enable-linger <user>`.
3. Install Node.js 22.19 or later, with npm, which BB's installer needs.
4. Install Docker Desktop with the WSL 2 backend. In its settings, turn on
   Start Docker Desktop when you sign in, and WSL integration for Ubuntu
   under Resources.
5. Check that `docker version` in Ubuntu, as that user, shows the server.
6. Add Ubuntu to BB as a machine, as that user. If BB's app was there before
   step 4, restart the user's services so it has the group:
   `sudo systemctl restart user@$(id -u <user>).service`.
7. In BB Box's settings, turn the machine on under Docker on BB machines.

Then:

- Docker has the memory WSL gives its VM, half the PC's by default. Set
  `memory` in `.wslconfig` in your Windows profile for more.
- `build.sh`'s check of free disk sees Docker Desktop's virtual disk, not the
  Windows drive: make sure the drive has about 36 GB free.
- After 5 minutes with no containers running, Docker Desktop's Resource Saver
  pauses Docker, and the next call takes about 2.5 s.

#### GPU desktops

A linux-desktop box gets one NVIDIA GPU through the Container Device
Interface (CDI). On the Docker host:

1. Install the NVIDIA driver and the
   [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).
2. Generate the toolkit's CDI spec, which names each GPU:
   `sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml`. Run it again
   after each driver upgrade.
3. Docker Engine 28.2 and later read CDI specs by default. For an older one,
   set `"features": {"cdi": true}` in `/etc/docker/daemon.json` and restart
   Docker.
4. Check that `docker info` lists the GPUs under Discovered Devices, then turn
   on `gpu-desktops`.

Each desktop gets the GPU with the fewest desktops. A desktop whose GPU
cannot drive its display falls back to the CPU, and the reason is in the
container's log. GPU desktops have not been tested on a Docker host with a
GPU yet.

## Check it worked

Run `bb box doctor`. It checks the `docker` CLI, the daemon, that Docker can
limit a box's CPU and memory and pin it to its cores, whether boxes see
their own memory through LXCFS, each image, the network, Docker in boxes, GPU
desktops when they are on, and the room on the host. For each image it:

- fails when the image keeps an older contract than bb-box needs;
- warns when the image is more than 14 days old, has another build of BB's
  app than BB's server gives, or was built with other pins than this
  bb-box's.

To try the backend without BB, run the conformance suite from a checkout of
bb-box. It acquires a box of each kind whose image is set, checks it, and
releases it; without BB it skips enrolment, and says so:

```sh
npm install
echo '{ "backends": [{ "id": "docker", "type": "docker", "enabled": true, "fields": {} }] }' > docker.json
npm run conformance -- --backend docker --settings docker.json
```

## Update

- **Images rebuild each night** once the nightly run is set up
  ([setup](../README.md#rebuild-images-each-night)): bb-box builds a new
  image, checks a box of it, then moves the image's tag to it.
- **Rebuild by hand** with `build.sh`. BB's app is the images' last layer, so
  after it changes, `build.sh` installs the new app and keeps the rest
  cached.
- **On a BB machine**, bb-box builds an image again itself when it has no
  record, an older contract, or another build of BB's app.
- **After a driver upgrade** on a GPU host, generate the CDI spec again.

## Remove

1. In BB, release the backend's boxes, turn the backend off and remove it on
   BB Box's settings page.
2. On the Docker host, remove what bb-box left: its containers, its network
   and its images.

   ```sh
   docker ps -a --filter label=bbbox.box              # any boxes left
   docker network rm bbbox
   docker image ls 'bbbox/*'
   docker image ls 'bbbox-image/*'                     # projects' images
   docker image rm <image>
   docker builder prune
   ```

## When it goes wrong

- **"has no image"**: build the images (step 2) on the Docker host the
  `host` field names.
- **"permission denied" on the Docker socket**: add the user BB runs as to the
  `docker` group, then restart BB. For a BB machine's Docker, that is the
  user BB's app runs as: restart its services so it has the group,
  `sudo systemctl restart user@$(id -u <user>).service`.
- **A box does not come up**: `docker logs bbbox-<box ID>` shows its main
  process's output. bb-box's error gives the last lines too.
- **A box does not join BB**: see Enrolment, under What you need.
- **Each `docker` call is slow over SSH**: share one connection (step 1).
- **Rootless Docker refuses a box's CPU limit**: its systemd is older than
  252. The doctor fails and gives the fix.
