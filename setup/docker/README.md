# Docker backend

This backend runs Linux boxes as containers on one Docker host: the Docker on
BB's server, or another machine's over SSH. It is the quickest way to try
bb-box, as it needs only Docker. It offers four kinds:

- **linux**: Ubuntu 24.04 with the same tools as a Proxmox LXC linux box;
- **linux-docker**: the same, with a Docker daemon of its own, in a
  privileged container (off by default);
- **linux-desktop-cpu**: XFCE and Chrome, drawn by the CPU, shown in the
  thread's panel with shared control, and computer use through Cua Driver;
- **linux-desktop**: the same desktop on one of the host's NVIDIA GPUs,
  through the NVIDIA Container Toolkit (off by default).

All of them enrol in BB as machines, as Proxmox LXC boxes do.

The bb-box plugin, on BB's server, runs the `docker` CLI for every call. It
runs commands and copies files in a box with `docker exec`, and streams the
desktop through `socat` under `docker exec`. No SSH server runs in a box, and
BB's server needs no network path to the containers, so a Docker host over
SSH works as the local one does ([decision 031](../../docs/decisions/031-docker-boxes-are-reached-through-docker-exec.md)).

On a Linux host with local Docker, a linux box was ready 0.3 s after it was
asked for, and a linux-docker or linux-desktop-cpu box 0.6 s, its desktop
running. Its desktop stream opened in under 0.1 s. Over `ssh://`, every
`docker` call opens an SSH session, so a box took about 1.5 s, and its
stream 0.6 s.

| Path | What it does |
| --- | --- |
| `build.sh` | Builds the two images on the Docker host |
| `Dockerfile` | The images, made by the Proxmox LXC template's guest scripts |
| `customize.sh` | Runs those scripts inside the image as it is built |
| `start` | A box's main process: starts its services, then waits |

## Limits

- **Not a security boundary.** A box is a container: it shares the host's
  kernel, and its user may use `sudo` in it. A linux-docker box is a
  privileged container, which can take over the Docker host, so turn those
  boxes on only where the agents may do that.
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
  with Docker 29.8, rootful, on Linux. Docker Desktop and rootless Docker
  have not yet been tested. Rootless Docker cannot run linux-docker boxes,
  which need privileged containers, and the doctor says so.
- The `docker` CLI on BB's server, on the PATH of the user BB runs as, and
  that user allowed to use Docker. On Linux, add it to the `docker` group.
  For a Docker host over SSH, that user must log in to it with a key and no
  prompt, as a user who may use Docker there.
- Memory for the boxes: by default bb-box keeps 4 GiB of the host's memory
  free, and a small linux box has a 4 GiB limit, so the host needs at least
  8 GiB.
- Disk for the images: about 3 GB for the linux image and 6.5 GB for the
  desktop image.

## 1. Build the images

bb-box never pulls an image. Build both on the Docker host:

```sh
git clone <bb-box repository> && cd bb-box
setup/docker/build.sh
```

`build.sh linux` or `build.sh desktop` builds one. `--bb-url
https://bb.example.com` puts BB's host app in the images, so a box enrols
without downloading it. To build on a Docker host over SSH, run it with
`DOCKER_HOST=ssh://user@host`, or with that host's Docker context in use.

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
| `linux-image` | `bbbox/linux:1` | The image of linux and linux-docker boxes. Empty turns them off |
| `desktop-image` | `bbbox/linux-desktop:1` | The image of linux-desktop-cpu and linux-desktop boxes. Empty turns them off |
| `privileged` | off | Offers linux-docker boxes |
| `gpu-desktops` | off | Offers linux-desktop boxes, on the GPUs the NVIDIA Container Toolkit lists |
| `desktops-per-gpu` | 4 | The most linux-desktop boxes on one GPU |
| `network` | `bbbox` | The network bb-box makes for its boxes |
| `boxes` | 10 | The most bb-box containers on the host, running or stopped, of every bb-box install that uses it |
| `reserve-memory-mib` | 4096 | A new box is refused when the host would have less memory than this left, after the limits of the running boxes |

From a terminal, `bb box config show --json` prints the configuration and
`bb box config apply <file>` saves it. The Docker backend's entry is:

```json
{ "id": "docker", "type": "docker", "enabled": true, "fields": { "privileged": true } }
```

Then `bb box doctor` checks the `docker` CLI, the daemon, each image, the
network, linux-docker and GPU desktops when they are on, and the room on the
host. It also gives bb-box's install ID, which labels its containers.

### Trying it without BB

The conformance suite runs against the backend without BB. With a
configuration file such as `docker.json`:

```json
{ "backends": [{ "id": "docker", "type": "docker", "enabled": true, "fields": { "privileged": true } }] }
```

```sh
npm install
npm run conformance -- --backend docker --settings docker.json
```

It acquires a box of each kind, checks it, and releases it. Without BB, it
skips enrolling the boxes, and says so.

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
they always match the driver. When the GPU cannot drive the display, the
desktop falls back to the CPU, as on Proxmox LXC.

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
  stop leaves behind, starts Docker's daemon in a linux-docker box and the
  display, the session and Cua Driver in a desktop box, then writes
  `/run/bb-box/ready`. bb-box waits for that file, then runs BB's bootstrap,
  which starts BB's daemon in the box.
- **Stop and start.** `docker stop` and `docker start`. The restart policy is
  `unless-stopped`, so after a Docker or host restart a running box starts
  again and a stopped box stays stopped.
- **Release.** `docker rm --force --volumes`, which also removes a
  linux-docker box's Docker data.
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
  `docker` group, then restart BB.
- **A box does not come up**: `docker logs bbbox-<box ID>` shows its main
  process's output. bb-box's error message gives the last lines too.
- **A box does not enrol**: see Enrolment under Limits.
- **Removing everything bb-box made**: release the boxes from BB. Then
  `docker ps -a --filter label=bbbox.backend=docker` lists any left, and
  `docker network rm bbbox` removes its network.
