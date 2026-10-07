# 042: A Docker host can be a BB machine, reached through BB

Status: accepted, 1 October 2026. Extends
[031](031-docker-boxes-are-reached-through-docker-exec.md): the Docker
backend reaches a BB machine's Docker without SSH. Checked after it was
built: on a Windows PC, the relay reaches Docker Desktop's socket in WSL,
and privileged boxes there start and enrol (#233). Extended by
[049](049-a-project-image-is-a-script-on-the-standard-image-and-images-are-rebuilt-when-stale.md):
Docker images are rebuilt through the same relay. Extended by
[055](055-cloud-boxes-run-on-cloud-hosts-first-and-a-cloud-vm-per-box-later.md):
a cloud VM is a Docker host through the same relay.

## Context

A developer's PC that runs Docker already, for example in WSL on Windows,
could host boxes. The Docker backend reaches a Docker host through a local
socket or `ssh://`. On a Windows PC with WSL, SSH needs sshd in WSL, a key,
a port proxy from Windows to WSL and a firewall rule, on each PC. Such a PC
is often a BB machine already: BB's daemon runs there, in WSL on Windows,
and keeps an outbound connection to BB's server.

A spike on 1 October 2026 measured bb-box's host entry from a throwaway
plugin, on a `linux-docker` box that was a BB machine:

- A host call from bb-box's server took 424 ms at the median, 2 ms of it
  in the machine, and about 0.9 s to a worker that had stopped. A result
  holds about 6 MiB of bytes at most. Over SSH, `box_run true` takes about
  0.1 s, so calls suit setup, not commands.
- BB carries no byte stream between a plugin's server side and its host
  entry. Calls and signals together carried 0.12 to 1.1 MiB/s.
- A WebSocket that the worker opens out to a route of bb-box's own works
  today. The route has `auth: "none"`, and checks a one-time secret that a
  host call gives the worker. It opened in 0.4 to 0.53 s, echoed in 0.3 ms
  at the median, and carried 54 to 142 MiB/s. It needs only the outbound
  HTTPS that BB's daemon uses.
- BB stops a worker after 5 idle minutes unless it holds a lease. A plugin
  reload ends the worker and its sockets. A call in flight failed in about
  3 s when the machine went.

## Decision

**Build it, in the Docker backend.** A Docker host can be a BB machine. It
is neither a backend of its own nor a new transport: bb-box relays Docker's
API, so the `docker` CLI on BB's server drives the machine's Docker as it
drives a local socket. Containers, labels, `docker exec` for commands,
copies, the desktop and terminals, Cua's MCP, capacity, the doctor and the
sweep all work as they are. The backend interface does not change.

**The relay.**

- For each Docker host that is a BB machine, bb-box's server listens on a
  unix socket that only BB's user can use, and gives the `docker` CLI that
  socket as the host.
- Each connection to that socket is a channel on one WebSocket for the
  machine. The machine's worker opens the WebSocket out to a route of
  bb-box's, with `auth: "none"` and a secret of 128 random bits that a host
  call gives it. The route accepts each secret once, within 10 s.
- The worker connects each channel to Docker as the `docker` CLI there
  would: `DOCKER_HOST`, else the current context's endpoint, else the
  default socket or named pipe.
- Each side of a channel sends only as much as the other side has granted,
  1 MiB at first, and grants more as its own socket drains. This keeps a
  slow side from filling memory, as BB's plugin socket gives no
  backpressure
  ([request 2](../bb-requests.md#2-send-backlog-on-plugin-websockets)).
  Each direction ends on its own, as `docker exec` and `docker cp` close
  their input before their output. Frames are at most 64 KiB, and a ping
  every 15 s finds a dead relay.
- The relay opens when a `docker` command needs it, with one host call. The
  worker holds a lease while it is open. It stays open while bb-box has a
  box on the machine or a channel is open, and closes after 5 idle minutes
  otherwise.
- A plugin reload, a deploy or the machine reconnecting ends the relay. The
  next `docker` command opens it again, in about 0.5 s, or about 1 s if
  the worker had stopped. Containers keep running. Terminals and desktops
  reconnect, as after any plugin restart.

**Which machines.** The operator turns on each machine.

- BB Box's settings list, under Docker, the BB machines that can host
  boxes: connected, persistent, not made by bb-box, and with Docker
  answering the host entry. Each row shows the machine's name, Docker's
  version, cores and memory, and a switch.
- bb-box's own boxes, spares and your machines
  ([036](036-your-machines-are-boxes-you-own.md)) are BB machines with
  Docker too ([041](041-every-linux-box-has-docker.md)), so the list leaves
  out every machine bb-box's provider made.
- Turning a machine on adds a Docker backend whose host is that machine,
  last in acquire order. The configuration names the machine by its BB
  machine ID, as `bb:<machine ID>`. Its offers and boxes say "Docker on
  <machine name>". Turning it off removes that backend, as for any other.
- No machine is used without its switch. A box is a privileged container,
  root on the machine (041), and takes its memory, so a person decides.

**Images.** Turning a machine on builds any image it lacks there, with
bb-box's `setup/docker/build.sh` run on BB's server against the machine's
socket, as `docker build` sends its files through the API. The row shows
the build until it ends. The doctor gives the same fix when an image is
missing or old. Images are built, not copied, as everywhere now.

**A machine that is offline.** Capacity reads the machine's state from BB,
with no host call, so an acquire takes the next offer at once. Commands and
copies on its boxes fail at once, saying the machine is offline. A release
waits as an interrupted release does, and the sweep finishes it when the
machine is back. Boxes do not move to another host.

**Ruled out.**

- A backend of its own, which would repeat the Docker backend's kinds,
  images, capacity, doctor and labels.
- Running the `docker` CLI on the machine, with lifecycle in host calls and
  each process's input and output relayed, as the spike proposed. Each
  operation would need a second path, and each lifecycle call would take
  about 0.5 s. Relaying the API keeps one path and makes one host call
  each time the relay opens.
- BB's shared ports, which publish a machine's loopback TCP ports through
  BB's gate. Docker's API is a unix socket, and root on the machine.
- SSH, which stays for Docker hosts that are not BB machines. On a Windows
  PC it needs the setup above on each PC.

## Consequences

- A developer turns their PC on in settings. It needs no SSH, key, port
  proxy or firewall rule, only BB's daemon and Docker.
- A `docker` command costs a few round trips between BB's server and the
  machine, and about 0.5 s more when the relay must open first.
- bb-box depends on more of BB's experimental APIs: the host entry,
  `experimental_retainWorker` and `experimental_websocket`, and a route
  with `auth: "none"` guarded by a one-time secret.
  [Request 7](../bb-requests.md#7-reach-a-port-on-a-machine), extended,
  would replace the route and the secret. If these APIs change, a Docker
  host over `ssh://` still works.
- BB's server needs the `docker` CLI, as for any Docker host. The CLI
  agrees an API version with the machine's Docker.
- With Docker Desktop's WSL integration, WSL may not reach containers'
  addresses. Nothing here needs them: the desktop goes through
  `docker exec`, as now. Before the build ends, a check on a Windows PC
  with Docker Desktop: the worker reaches Docker's socket in WSL, a
  privileged box starts, and a box enrols in BB.
- Through Docker, the relay is root on the machine, as an `ssh://` host is.
  It is not a security boundary.
- The images are x86_64. On an Arm machine they run under emulation,
  slowly, and the doctor says so, as now.
