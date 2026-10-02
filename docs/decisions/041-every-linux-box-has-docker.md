# 041: Every Linux box has Docker, started on first use

Status: accepted, 1 October 2026. Partly supersedes
[012](012-offers-may-add-features.md) and
[040](040-linux-on-arm64-has-kinds-of-its-own.md): `linux-docker` and
`linux-arm64-docker` become aliases; and
[013](013-docker-boxes-run-unprivileged.md): Docker boxes are privileged
by default. Amended while it was built: a GPU desktop on the Docker backend
was at first never privileged, so it had no Docker. A privileged container
sees every GPU on the host, and Xorg would take the first, not the one
bb-box placed. Amended 2 October 2026 (#283): a GPU desktop is privileged
too, and its start script points Xorg at the GPU placed, by its PCI bus ID.

## Context

The operator asked to drop the picker's "Docker inside" badge, to assume
every headless image has Docker, and whether desktops should too.

Every Linux image has Docker installed already: the Proxmox LXC
templates, headless and desktop, Tart's Linux image, and the Docker
backend's images, which are built from the same scripts. What differs is
whether it can run. In a Docker backend box it needs a privileged
container, and an SSH pool box user in the `docker` group is root on the
machine.

Measured on a `linux` LXC box, where Docker starts at boot: idle,
`dockerd` holds 67 MiB and `containerd` 41 MiB, 108 of the box's 294 MiB
in use, and `docker.service` adds 0.5 s to the boot. The files are about
275 MB in the template, shared by linked clones. So the cost is Docker
running, not Docker installed.

With `docker.socket` enabled and the two services not started at boot,
the first `docker` command starts both in 0.33 s, measured locally on
Docker 29.1 in Ubuntu 24.04, and later ones take 11 ms. A container with
a restart policy then stays down after the box stops and starts, until
the first `docker` command. A unit that starts Docker at boot only when
`/var/lib/docker/containers` is not empty brings it back with the box.

The Docker backend's boxes have no systemd, and their start script waits
for `dockerd` before the box is ready. In a privileged container,
`systemd-socket-activate -l /run/docker.sock dockerd -H fd://` starts
nothing until the first `docker` command, which took 0.24 s as the box
user, after the socket was given to the `docker` group.

The picker also shows "Docker" for the Docker backend beside "Docker
inside" for the feature, which reads as the same thing.

## Decision

- Docker is installed in every Linux image: headless and desktop, x86_64
  and arm64. Agents never install it themselves, which would take tens of
  seconds each time, and could not work in a Docker backend box without
  a privileged container, or for an SSH pool user without `sudo`.
- Docker starts on first use. `docker.socket` is enabled, and
  `docker.service` and `containerd.service` are not started at boot. A
  box that has containers starts Docker at boot, so restart policies work
  as before. The Docker backend's start script does the same with
  `systemd-socket-activate`, and no longer waits for Docker.
- The template's checks find Docker stopped after boot, then time the
  first `docker` command from there, and fail above 2 s.
- One kind per shape. `linux-docker` and `linux-arm64-docker` become
  aliases of `linux` and `linux-arm64` with the feature `docker`,
  accepted wherever an ID comes in, as 027's old IDs are. An acquire
  through an alias takes only offers that have it. Backends offer only
  the kinds.

| Kind | Promises |
| --- | --- |
| `linux` | Linux, no GPU |
| `linux-desktop` | a Linux desktop with a GPU |
| `linux-desktop-cpu` | a Linux desktop without a GPU |
| `linux-arm64` | Linux on arm64, no GPU |
| `linux-arm64-desktop-cpu` | a Linux desktop on arm64 without a GPU |

- A Linux kind requires no features, so its offers may differ on
  `docker`. The panel badges the exception: a Linux offer or box without
  Docker says "No Docker", and "Docker inside" goes. The Docker backend's
  badge becomes "Container". `box_list` and `box_status` say whether a
  kind or box has Docker, as they say whether it gives root.

| Backend | Docker |
| --- | --- |
| Proxmox LXC | every template, with `nesting=1`, as now |
| Tart | its Linux images, as now |
| Docker | each box is a privileged container, by default. Any box with the setting off or on a rootless Docker host says "No Docker" |
| SSH host pool | only on a machine whose reset restores the whole machine, as now. Otherwise "No Docker" |

## Consequences

- An idle box pays nothing for Docker: on LXC, 108 MiB and 0.5 s of boot
  come back. Its first `docker` command waits about half a second, once.
  A Docker backend box is ready without waiting for `dockerd`.
- Tool input, the configuration document, stored records, guests' kind
  tags and an SSH pool machine's line keep working with the old IDs. An
  entry for an alias in the document moves to its kind once, unless the
  kind has one of its own.
- Which offer an acquire of `linux` takes is still the configuration's
  order. An agent that must have Docker where offers differ asks for
  `linux-docker`.
- The Docker backend's boxes are root on the Docker host by default. This
  is not a security boundary, and its doctor says so, as now. Its setting
  becomes "Docker in boxes", on unless set.
- Rootless Docker for each SSH pool box user, cleared with its home,
  could give Docker on machines without a whole-machine reset. It waits
  for a spike.
