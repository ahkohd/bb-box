# 011: Interface v1: shared kinds, routes and displays

Status: accepted, 30 September 2026. Partly supersedes
[007](007-desktop-stream-is-a-typed-transport.md). Partly superseded by
[012](012-offers-may-add-features.md): offers agree on the features a kind
requires and may add more, and Docker inside a box is a feature. Partly
superseded by [015](015-computer-use-through-cua-driver.md): `computerUse`
names the driver, and command transports gain `spawn`. Partly superseded by
[016](016-changes-from-building-v1.md): guests carry facts to show, and a
driver's setup is a guide with a list of scripts. Partly superseded by
[028](028-a-box-size-is-chosen-when-it-is-made.md): a box's size is chosen
when it is made, and `capacity` is asked about that size. Extended by
[044](044-a-box-can-be-asked-for-on-one-provider.md): an acquire may name
the provider, or the providers, to try. Extended by
[018](018-guests-name-their-install-and-box.md): guests name their install
and their box; by [020](020-control-belongs-to-a-viewer.md): control belongs
to one viewer; and by [021](021-desktop-resize-through-the-backend.md): a
display may resize through its backend.

## Context

The first backend interface was written for Proxmox LXC, where the BB server
reaches every box directly. Reviewing it against Docker, an SSH host pool,
Tart, a physical Mac and Windows on Proxmox QEMU found these gaps:

- A desktop was a host and port. Tart VMs sit behind the Mac host's NAT, a
  pool machine's VNC server listens on localhost, and Proxmox's console is a
  WebSocket that needs a single-use ticket.
- Kind IDs had to be unique across backends, so two backends could not offer
  the same kind.
- Capacity had memory and disk only. A Mac runs at most two macOS VMs, and a
  box needs all its resources on one host.
- Nothing said whether a command runs in the desktop session. On Windows,
  SSH and WinRM run in session 0, away from the desktop. On macOS, SSH runs
  outside the login session and its Accessibility and Screen Recording
  permissions.
- `start` and `stop` were required, and real machines cannot do them.
- Nothing said how bb-box knows a real machine is clean before handing it
  out.

## Decision

Adopt [Interface v1](../architecture.md#the-backend-interface):

- Kind IDs are shared words. An offer is a backend and a kind, and the
  registry takes the first offer with capacity in the order of settings.
- Transports reach a port inside a box through a route (`tcp`, `command` or
  `websocket`), which is plain data made per connection and opened in one
  place.
- A box has a list of displays, each with the protocol `rfb` or `selkies`.
  The relay answers the box's RFB authentication itself and offers the viewer
  none, so passwords and tickets stay on the BB server.
- Windows starts with RFB through Proxmox's console. RDP is not planned: it
  needs a gateway and a second client, and an RDP login moves the session off
  the console, so you and the agent could not share one desktop.
- Capabilities add the architecture, features, computer use, and for
  commands the shell, admin rights, the desktop session and streaming output.
- Capacity is named limits per host.
- Real pools get release hooks, a list of members, return to service, and a
  reset generation checked when a machine is claimed.
- `start` and `stop` are optional, and power can be `unknown`.
- A kind enrols in BB only when its shell is `sh` on Linux or macOS.

## Consequences

- Proxmox LXC, the fake backend and the conformance suite move to v1 before a
  second backend is added. After that, Docker, an SSH host pool, Tart, a
  physical Mac and Windows need no change to the core.
- The relay parses the RFB handshake as well as client messages. It still
  never decodes pixels.
- Windows boxes run commands, copy files and stream their desktop, but do not
  enrol until BB's host app runs on Windows ([BB requests](../bb-requests.md)).
- A change to the interface after v1 gets a new decision record.
