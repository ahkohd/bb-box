# 013: Docker boxes run unprivileged, without systemd

Status: accepted, 30 September 2026. Partly superseded by
[031](031-docker-boxes-are-reached-through-docker-exec.md): no sshd, bb-box
starts BB's daemon, and linux-docker has no systemd.

## Context

A box image could run systemd as its first process, like an LXC template, so
services start and BB's host app installs as a service. The later-backends
research measured this on Docker 29.8.1, nested in an LXC container:

| Container | systemd | Ready (SSH and RFB answer) |
| --- | --- | --- |
| unprivileged, `--init` and a start script | no | 0.78 s |
| unprivileged, systemd as the first process | exits at once: the cgroup filesystem is read-only | never |
| `--privileged`, systemd as the first process | reaches graphical.target in 0.8 to 0.9 s | 1.06 s |

A privileged container is root on the Docker host.

## Decision

- Docker kinds run unprivileged, with `--init` and a start script that starts
  sshd, the RFB server and the desktop.
- Privileged kinds are a setting the operator turns on. Only they offer the
  features `docker` and `systemd`, and so `linux-headless-docker`
  ([012](012-offers-may-add-features.md)).
- Enrolment works without systemd. BB's installer finds no service manager
  and leaves its host daemon running in the background, which also saves a
  daemon handover. The start script starts the daemon again when the
  container restarts, if the box is enrolled.
- `access.dockerHost` is null unless the operator opts in: the host's Docker
  socket is root on the host and on every other box there.

## Consequences

- Docker boxes are the fastest to be ready, and suit a laptop with Docker and
  no other setup.
- A Docker box image differs from the LXC template in how it starts
  services, not in what it has.
- The conformance suite restarts an enrolled box and checks that it
  reconnects to BB.
