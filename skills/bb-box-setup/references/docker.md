# Docker

Docker boxes are containers on one Docker host. They make `linux`,
`linux-desktop-cpu`, `linux-desktop-wayland-cpu`, and `linux-desktop` on a
GPU. A box is ready in about a second. The full guide is
`setup/docker/README.md` in bb-box's repository.

Before anything, tell the person: by default each box is a privileged
container with Docker of its own, so a box can take over its Docker host.
Ask whether that is acceptable. If it is not, set `--field privileged=false`:
boxes then have no Docker. A Docker box has no systemd and no disk size of
its own.

## On the machine that runs BB, or on one of their BB machines

This is the quickest path, and the first choice for "set up boxes here".

```sh
bb machine list                      # which machines there are
bb box setup docker                  # the machine that runs BB
bb box setup docker --machine <name> # one of their BB machines, by name or ID
```

It turns Docker on for that machine, with the Linux image alone. It also
turns on the nightly rebuild of images, and waits while the image builds:
5 to 12 minutes, or up to 15 on a slow machine. Run it as a background task
if you can. `--no-wait` starts it and says how far the build is; run the
command again to see.

- Where BB's user cannot use Docker, it prints the lines that fix it, such
  as adding the user to the `docker` group. Those are for the person to
  run, as they need root. Ask them to run them, then run the command again.
- Where it says "Boxes will not join BB yet", BB's machine access needs an
  address boxes can reach: see "When it goes wrong" in SKILL.md. Settle it
  before you prove the backend, or the first box does not enrol.
- Where the machine has no Docker, it says so. Docker Engine must be
  installed first: ask the person, as it needs root.
- The backend it adds is `docker:<machine name>`. `bb box backend list`
  shows it.
- It saves the desktop image fields empty, so the backend offers no
  desktops. To offer the X11 desktop, run `bb box backend set
  docker:<name> --unset desktop-image`, then `bb box docker-build <machine>`,
  which builds what is missing there. All three images need about 36 GB
  free.

## On a Linux host over SSH

Ask for the host's address, the user that may use Docker there, and
whether the user BB runs as can already log in to it with a key and no
prompt.

1. On the machine that runs BB, as the user BB runs as, check:
   `DOCKER_HOST=ssh://<user>@<host> docker info`.
2. Build the images there, from a checkout of bb-box at the installed
   commit: `DOCKER_HOST=ssh://<user>@<host> setup/docker/build.sh linux`.
   Leave out `linux` for all three images: it takes about 15 minutes and 36
   GB of disk. `build.sh linux desktop` builds two.
3. Add the backend. Give it an ID of its own when there is a Docker backend
   already:

   ```sh
   bb box backend add docker --id build-1 --field host=ssh://box@192.0.2.40 \
     --field desktop-image= --field wayland-desktop-image= --check
   bb box backend add docker --id build-1 --field host=ssh://box@192.0.2.40 \
     --field desktop-image= --field wayland-desktop-image=
   ```

   An empty image field turns that kind off on this backend. Leave the image
   fields out when all three images are built.

## In WSL on a Windows PC

A Windows PC can host boxes in a WSL distribution of bb-box's own, with SSH
on port 2222. The person runs `setup/docker-wsl/setup.ps1` on the PC, in
PowerShell 7 as an administrator, with BB's public SSH key. Follow
`setup/docker-wsl/README.md`: it ends with a backend whose `host` is
`ssh://box@<pc>:2222`. Add it as for a host over SSH.

## Fields worth knowing

`bb box backend fields docker` lists them all.

| Field | Default | What it does |
| --- | --- | --- |
| `host` | empty | `unix:///path/docker.sock`, `ssh://user@host`, or empty for the `docker` CLI's own default |
| `linux-image`, `desktop-image`, `wayland-desktop-image` | `bbbox/...:1` | The image of each kind. Empty turns the kind off here |
| `privileged` | `true` | Boxes have Docker of their own and can take over the host |
| `gpu-desktops` | `false` | Offers `linux-desktop` on the host's NVIDIA GPUs, through CDI |
| `boxes` | 10 | The most bb-box containers on the host |
| `reserve-memory-mib` | 4096 | Memory a new box leaves free. Lower it on a host with 8 GiB |

## Check and prove

`bb box doctor` checks the `docker` CLI, the daemon, the CPU and memory
limits, LXCFS, each image and the room on the host. "has no image" means the
build has not run on the host the `host` field names. Prove it with a
`linux` box: `bb box acquire linux --on <backend ID>`.

Boxes join BB by reaching BB's server URL from inside the container. If BB
listens only on localhost, they cannot. Either turn enrolment off, with
`bb box option set enrol=false`, or have BB listen on an address the
containers reach.
