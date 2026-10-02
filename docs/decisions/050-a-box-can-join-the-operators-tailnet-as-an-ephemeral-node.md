# 050: A box can join the operator's tailnet as an ephemeral node

Status: accepted, 2 October 2026. Extends
[029](029-configuration-is-one-checked-document.md): the configuration
holds the tailnet and its key; and
[049](049-a-project-image-is-a-script-on-the-standard-image-and-images-are-rebuilt-when-stale.md):
standard Linux images carry Tailscale, stopped and with no state.
Checked after it was written: TUN in a Proxmox LXC container, its clones,
and the API token, below.

## Context

The operator dogfoods a project that shares a keyboard and mouse between
machines over a tailnet. Its threads need X11 desktop boxes that are nodes
of the operator's tailnet, so the app in a box can reach the operator's
machines and other boxes, and be reached from them. Nothing in bb-box
joins a tailnet today, and an image must hold no node of its own (049).

Measured in a `linux` box on Proxmox LXC and one on Docker, whose host was
an LXC container, without joining a tailnet:

| | Proxmox LXC, unprivileged | Docker on an LXC host |
| --- | --- | --- |
| `/dev/net/tun` | missing, and `mknod` is refused | missing |
| tailscaled with TUN | fails: no TUN device | fails: no TUN device |
| tailscaled in userspace mode | runs, answers in 0.05 s | runs |
| DNS | systemd-resolved | `/etc/resolv.conf` is Docker's bind mount |

Installing Tailscale from its apt repository took 2 to 3 s.

From Tailscale's documentation:

- An ephemeral node is removed 30 to 60 minutes after it goes offline, or
  at once when it runs `tailscale logout`.
- An auth key lasts at most 90 days. An OAuth client's secret has no
  stated expiry. A client with the `auth_keys` scope and a tag creates
  keys through the API, and `devices:core` lets it remove devices.
- `--advertise-tags` needs the policy's `tagOwners` to let the key's owner
  give the tag. Tagged nodes have key expiry off by default.
- An unprivileged LXC container has TUN only if its host gives it the
  device.

## Decision

### Opting in

No box joins unless asked. The narrowest setting wins:

- **A kind**: `kinds.<kind>.tailnet: true` in the configuration, so every
  box of the kind joins.
- **An image** (049): `tailnet: true`, so a project's threads join when
  their boxes use the project's image. The example project sets this.
- **A box**: `box_acquire` and `bb box acquire` take `tailnet` (true or
  false), and New box has "Join the tailnet", ticked when the kind or the
  image says so.

The choice shows only once a key is set and the backend placing the box
can join. `box_list` says which kinds can, and in which mode (below).
Spares and warm guests never join: a spare joins when a thread takes it.

### The key

The configuration has a `tailnet` part: the key, a secret kept write-only
like the providers' credentials, and the tags, `tag:bb-box` by default.
bb-box tells the two forms apart by their prefix.

- **An OAuth client (recommended)**, with the `auth_keys` scope, the tags,
  and `devices:core`. For each join, bb-box gets an access token (good for
  an hour) and creates a one-off, ephemeral, pre-approved key with the
  tags that expires in 5 minutes. The box only ever holds a key that
  cannot be used again, the secret does not expire, and `devices:core`
  lets bb-box remove a node whose box could not log out.
- **An auth key**: reusable, ephemeral, pre-approved and tagged. It goes
  into the box for the join, and it lasts at most 90 days, so the doctor
  says when to replace it.

### Joining

A box joins once it is ready, at the same time as BB enrolment, and is
handed over when both are done.

1. bb-box creates a key, or takes the auth key.
2. Through the command transport, it writes the key on standard input to
   a file in `/run` that only root can read, and runs a guest script,
   `bb-box-tailnet up`. The script starts tailscaled, runs the line below
   and removes the file.
3. bb-box records the node's ID, addresses and MagicDNS name from
   `tailscale status --json`. The box's details and `box_acquire`'s result
   show them, such as "Tailnet: calm-heron, 100.64.0.7".

```
tailscale up --auth-key=file:/run/bb-box/tailnet-key \
  --advertise-tags=tag:bb-box --hostname=<box name> \
  --accept-dns=<true where systemd-resolved runs> --timeout=30s
```

- **A failed join** releases the box and fails the acquire with
  Tailscale's message, as a failing image script does (049). The doctor
  finds the usual causes first.
- **tailscaled starts on demand**, not at boot: with systemd where there is
  one, and on Docker, which has none, in a loop that restarts it, as
  `bb-box-start` keeps its other services.
- **Nothing else.** Boxes do not advertise or accept routes, are not exit
  nodes, and do not run Tailscale SSH. bb-box reaches boxes through its own
  transports, never over the tailnet.
- **In the images.** Standard Linux images carry Tailscale from its apt
  repository, stopped. Finalizing removes `/var/lib/tailscale`, which holds
  the node's key and log ID. Tailscale follows upstream, as the agent CLIs
  do (049). A box from an older image installs it first, which adds about
  3 s.

### Leaving

- **On release or stop**, before bb-box removes the box from BB or stops
  it, it runs `bb-box-tailnet down`, which runs `tailscale logout`, with a
  10 s limit. An ephemeral node that logs out is removed at once, so its
  name is free for the next box. A box started again joins again with a
  new key.
- **When the box cannot log out**, because it is gone or does not answer,
  bb-box removes the node through the API by its recorded ID, and the
  sweep retries until it is gone. This needs `devices:core`. Without it,
  Tailscale removes the node 30 to 60 minutes after it went offline.

### TUN on each backend

| Backend | TUN | Mode | MagicDNS |
| --- | --- | --- | --- |
| Proxmox LXC | from the template, which `build.sh` gives the device | TUN; userspace for templates built before | yes |
| Docker | the host's, where it has the device | TUN; userspace on a host without it | no |
| Tart, Linux VMs | the VM's own kernel | TUN | yes |
| Tart macOS, Proxmox QEMU Windows | the VM's own kernel | later | later |
| SSH host pool | | not offered | |

- **Proxmox LXC.** `build.sh` gives each template the device with
  `pct set <vmid> --dev0 /dev/net/tun`. Only root on the host can set it,
  not the API token, so it belongs in `build.sh`. Clones copy it, and the
  rebuild of a template from a box of itself (049) keeps it.
- **Docker.** A privileged box sees the host's devices. A Docker host that
  is a VM or a physical machine has `/dev/net/tun`, and one that is an LXC
  container needs the same device line as a template. A box that is not
  privileged gets `--device /dev/net/tun --cap-add NET_ADMIN` when the host
  has the device. MagicDNS is off, as `/etc/resolv.conf` is Docker's.
- **Tart.** VMs have their own kernels. Linux VMs join now; macOS and
  Windows, on Tart or Proxmox QEMU, come later.
- **SSH host pool.** Not offered. Its machines are the operator's own and
  may be nodes already.

**Userspace mode** is the fallback where there is no TUN: tailscaled runs
with `--tun=userspace-networking`. Connections from the tailnet to the
box's listening ports work. Connections from the box need tailscaled's
SOCKS5 or HTTP proxy, so an app that dials its peers itself, as the
example project's does, does not work. The box's details say "userspace",
and the doctor says how to give the host TUN.

### The tailnet's policy

bb-box assumes only:

- `tagOwners` lets the OAuth client or the key's owner give the tags, and
  the OAuth client was created with them.
- Tailnet Lock is off, or the key is an auth key signed in advance with
  `tailscale lock sign`. bb-box cannot sign the keys it creates.

Who may reach boxes, and what boxes may reach, is the project's to grant.
For the example project, people's devices and boxes reach each other and
boxes reach each other; narrow `ip` to the ports the project uses:

```json
"tagOwners": {"tag:bb-box": ["autogroup:admin"]},
"grants": [
  {"src": ["autogroup:member"], "dst": ["tag:bb-box"], "ip": ["*"]},
  {"src": ["tag:bb-box"], "dst": ["autogroup:member", "tag:bb-box"], "ip": ["*"]}
]
```

### The doctor

| Check | What it does | When it is not ok |
| --- | --- | --- |
| `tailnet.key` | whether a key is set | skips the others, and the choice is hidden |
| `tailnet.client` | OAuth: asks for access tokens for `auth_keys` and `devices:core` | fails without `auth_keys`; warns without `devices:core`, as nodes then stay up to an hour after a box that could not log out |
| `tailnet.tags` | OAuth: creates a one-off key with the tags that expires in 60 s, then deletes it | fails when the tags are refused |
| `tailnet.key-age` | auth key: days since it was set | warns from 80 days, fails after 90 |
| `<backend>.tailnet-tun` | Proxmox LXC: each template's device lines through the API; Docker: a container from the box image tests `/dev/net/tun` | warns that boxes join in userspace mode, with the fix |
| `tailnet.images` | each image's record lists Tailscale | warns that joining installs it first |

When a key is set, the conformance suite joins a box on each backend that
can, checks that `tailscale status` says it is running with the tags and
the expected mode, releases it, and checks through the API that the node
is gone within 10 s.

### To verify in the first PRs

- Checked: `pct set <vmid> --dev0 /dev/net/tun` gives a container a
  working TUN, and tailscaled starts with it. A template made from that
  container keeps the line, and its linked clone has TUN too. The API
  token is refused: "configuring device passthrough is only allowed for
  root@pam".
- That a privileged Docker box sees `/dev/net/tun` once its LXC Docker
  host has the device.
- The time to join, expected to be under 3 s and hidden by BB enrolment.

## Consequences

- The example project's boxes are on the tailnet within seconds of being
  ready and leave it when released or stopped, with no nodes to remove by
  hand.
- One secret to set once. With an OAuth client, none to replace.
- Proxmox LXC templates need `build.sh` once more, as root, for TUN.
- A box on the tailnet is reachable by whatever the policy allows. bb-box
  is not a boundary between the agent in a box and the tailnet.
- MagicDNS is off in Docker boxes: use the addresses bb-box shows.

## Plan of PRs

1. The `tailnet` part of the configuration and its secret, the settings
   page's section, and the doctor's checks.
2. Tailscale in standard Linux images, the `bb-box-tailnet` guest script,
   the device in `build.sh`, and Docker's arguments.
3. Joining and leaving in core: the options for kinds, images,
   `box_acquire`, `bb box acquire` and New box, the box's record and
   details, the sweep, and the conformance test.
4. The setup guide's tailnet page: the policy, the OAuth client, and
   `build.sh` again.
