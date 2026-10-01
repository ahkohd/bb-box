# 031: Docker boxes are reached through `docker exec`

Status: accepted, 1 October 2026. Partly supersedes
[013](013-docker-boxes-run-unprivileged.md). Extended by
[042](042-a-docker-host-can-be-a-bb-machine.md): the Docker host can be a BB
machine, reached through BB.

## Context

The Docker backend runs boxes as containers on one Docker host, local or
over `ssh://`. [013](013-docker-boxes-run-unprivileged.md) planned a start
script that starts sshd and the RFB server, so bb-box would reach a box as it
reaches a Proxmox LXC box: SSH for commands, and a TCP path to the RFB
server for the desktop.

That needs a network path from BB's server to each container. There is one
only when BB's server is the Docker host itself, with rootful Docker on
Linux. Over `ssh://`, on Docker Desktop, where the containers are in a VM,
and with rootless Docker, where the bridge is in a namespace of its own, the
container's address cannot be reached. The `docker` CLI, which the backend
needs anyway to make and remove containers, reaches the box in every case.

## Decision

- Commands and file copies run through `docker exec`, as the box user, with
  `sh` as the shell. A box runs no sshd and holds no key. `access.ssh` is
  null.
- The desktop stream is always `docker exec -i <box> socat -
  TCP:127.0.0.1:5900`, with the RFB password read through `docker exec`
  too. It is one route for every Docker host, and needs no published port.
  A box's address is shown only when BB's server is the Docker host and
  Docker is rootful, and nothing uses it.
- The start script is the container's main process under `docker-init`. It
  clears BB's daemon lock and PID file, starts what systemd starts in an LXC
  box, then writes `/run/bb-box/ready`. bb-box waits for that file, then runs
  BB's bootstrap, which starts BB's daemon, after every start
  ([017](017-boxes-clear-bb-daemon-state-at-boot.md)). This supersedes 013's
  line that the start script starts the daemon again.
- linux-docker boxes run Docker in Docker: a privileged container with its
  own daemon and an anonymous volume for `/var/lib/docker`, not the host's
  socket. Its containers are apart from the host's and other boxes', and a
  bind mount names the box's own paths. `access.dockerHost` is null.
- Boxes run no systemd, privileged or not, so linux-docker offers the
  feature `docker` alone, not 013's `docker` and `systemd`.
- `admin` is a per-offer fact the agent sees, not a promise of the kind.
  Every Docker box offers it, as the box user has `sudo`.
- `arch` is `x86_64` for every kind. The guest scripts pin x86_64 artifacts,
  and the Proxmox LXC offers say the same. On another host architecture the
  doctor warns that boxes run under emulation.
- A box has no disk size: Docker has no portable per-container disk limit.
  Capacity refuses a box that asks for a disk size, and gives no disk
  total.
- Containers are made with `--pull never`, so a box runs only an image the
  operator built. bb-box's network turns off traffic between containers.
  Each image is one layer over Ubuntu's.
- Chrome runs with `--no-sandbox`: Docker's default seccomp profile stops it
  making its sandbox's namespaces, and the container is the boundary.
- There is no warm pool: a box is ready in about a second.

Measured on a Linux host with local Docker 29.8: from the acquire to a
ready box took 0.33 s for linux, and 0.62 s for linux-docker and
linux-desktop-cpu; the desktop stream opened in 0.08 s, and 32 MiB copied in
and out in 0.4 s. Over `ssh://` to the same host, a box took about 1.5 s,
the stream 0.6 s and the copy 2.2 to 3 s.

## Consequences

- A Docker host over SSH works as a local rootful host does, with only the
  `docker` CLI on BB's server. Docker Desktop and rootless Docker should
  work the same way, but have not been tested. Rootless Docker cannot run
  privileged containers, so it has no linux-docker boxes: the doctor fails
  them there.
- Every command pays for one `docker exec`, and over `ssh://` for an SSH
  session too.
- linux-docker boxes are root on the Docker host, so they stay off unless
  the operator turns them on.
- An agent that needs systemd uses a Proxmox LXC box.
