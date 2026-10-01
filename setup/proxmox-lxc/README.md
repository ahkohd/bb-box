# Proxmox LXC backend

This backend runs boxes as unprivileged LXC containers on a Proxmox VE host.
A box is a linked clone of a CT template that you build once. Templates
come in three flavours:

- **Linux**: Ubuntu 24.04 with development tools, agent CLIs and Docker;
- **desktop**: the same, plus an XFCE desktop on a real Xorg server driven by
  an NVIDIA GPU, streamed over VNC, with Chrome and Cua Driver for computer
  use. Each desktop template carries one GPU;
- **CPU desktop**: the desktop with no GPU, drawn by the CPU.

The bb-box plugin drives boxes through the Proxmox API with its own API
token, and reaches inside them over SSH and VNC. Measured on Proxmox VE 9.2
from another machine on the LAN: clone 0.75 s, configure 0.02 s, start 1.0 s,
and SSH answers about 0.45 s after start, so about 2.2 s from request to a
usable box.

This directory holds everything needed on the Proxmox side:

| Path | What it does |
| --- | --- |
| `host/bb-box.env.example` | Example settings for every script here |
| `host/setup-host.sh` | Kernel modules for Docker in boxes, NVIDIA device nodes at boot |
| `host/setup-network.sh` | The box bridge, NAT and a unit that keeps them up |
| `host/setup-token.sh` | Pool, user, role, API token and ACLs for the plugin |
| `template/build.sh` | Builds the Linux and desktop templates |
| `test/smoke.sh` | Clones, starts, checks and deletes a box with the plugin's token |

## Requirements

- Proxmox VE 8 or 9, and root on the host. The scripts use `pct`, `pveum`,
  `pveam`, `nft`, `ifupdown2`, `curl`, `jq` and `python3`.
- Storage that supports linked clones for containers: LVM-thin, ZFS or Ceph
  RBD (not a plain directory).
- Internet access from the host during template builds.
- For GPU desktops: an NVIDIA GPU with NVIDIA's driver loaded on the host,
  including `nvidia-modprobe` and `nvidia-smi`. Desktops share the GPU with
  anything else on the host. Without a GPU, build a CPU-only desktop
  template instead; its desktops render on the CPU.
- A route from the machine that runs your BB server to the boxes' subnet
  (see [Reaching boxes](#reaching-boxes)).

## 1. Settings

```sh
mkdir -p /etc/bb-box
cp host/bb-box.env.example /etc/bb-box/bb-box.env
```

Edit `/etc/bb-box/bb-box.env`. The example lists every setting with its
default. Check at least:

- `BBBOX_BRIDGE` and `BBBOX_GATEWAY_CIDR`: a bridge name and a subnet that
  are free on your host and network. Boxes get addresses in this subnet.
- `BBBOX_STORAGE`: storage with linked clones.
- `BBBOX_BB_URL`: your BB server's URL. Template builds then pre-install its
  host package for the box user, which makes enrolling a box as a BB machine
  faster. Boxes must be able to reach this URL.

A setting in the environment wins over the file, for example
`BBBOX_BUILD_ADDRESS=10.200.0.3 template/build.sh ...` for a second build
running at the same time.

## 2. Host prerequisites

```sh
host/setup-host.sh
```

- An unprivileged container cannot load kernel modules, so the modules
  Docker needs inside boxes (overlayfs, veth, nftables NAT and the iptables
  matches it uses) are loaded at every boot from
  `/etc/modules-load.d/bb-box.conf`.
- With an NVIDIA driver, `bb-box-nvidia-devices.service` creates every NVIDIA
  device node at boot. `/dev/nvidia-uvm*` otherwise appear only on first CUDA
  use, and a desktop box then fails to start. The script lists each GPU's PCI
  address and nodes; you need the PCI address to build a desktop template.

## 3. Network

```sh
host/setup-network.sh
```

Boxes live on a bridge with no physical port. The host has the gateway
address on it, routes the subnet, and masquerades boxes out of every other
interface. Nothing is filtered: a box reaches whatever the host reaches (the
internet, your LAN, a VPN), leaving as the host's address.

The script:

- adds the bridge to `/etc/network/interfaces` itself (Proxmox's network API
  does not read `interfaces.d`), after a backup in `/root/bb-box/backup`, and
  brings it up with `ifup`. It refuses to change an existing, different
  bridge of the same name;
- turns on IPv4 forwarding (`/etc/sysctl.d/90-bb-box.conf`);
- writes the nft table `ip bbbox` to `/etc/bb-box/network.nft`: masquerade,
  TCP MSS clamping to each route's MTU (for VPNs with a small MTU), and any
  `BBBOX_DNAT` rules;
- installs `bb-box-network.service` (at boot) and `bb-box-network.timer`
  (every 30 s), which run `bb-box-network repair`. Repair brings back a
  missing bridge or table and never takes anything down. To take the network
  down on purpose, stop the timer first.

Boxes get static addresses that the plugin sets on each clone before start,
so there is no DHCP server and no DHCP wait. DNS inside boxes uses
`BBBOX_DNS`, baked into the templates.

### Reaching boxes

The plugin reaches boxes by address, over SSH (port 22) and VNC (port 5900).
Add a route to the box subnet via the Proxmox host on the machine that runs
your BB server, and on any other machine that should reach boxes directly,
for example with the host's LAN address `192.0.2.10`:

```sh
ip route replace 10.200.0.0/24 via 192.0.2.10
```

To make it persistent on a machine that uses systemd-networkd, add a drop-in
for its interface, for example
`/etc/systemd/network/eth0.network.d/bb-box.conf`:

```ini
[Route]
Destination=10.200.0.0/24
Gateway=192.0.2.10
```

A static route on your LAN router covers every LAN machine at once. For
machines on a VPN such as Tailscale, advertise the subnet from the host
(`tailscale set --advertise-routes=...`, keeping any routes it already
advertises) and approve it.

### Names that resolve to the host

If a name boxes need, such as your BB server's, resolves to one of the
host's own addresses whose port forward only matches traffic from elsewhere
(for example a VPN address), boxes get no answer. Add a DNAT rule for boxes:

```sh
BBBOX_DNAT="198.51.100.1:443=192.0.2.20"   # the host's VPN address -> the real server
```

## 4. Templates

Build the Linux template, then a desktop template for each GPU you want
desktops on. Each build takes about 5 to 10 minutes, mostly downloads.

```sh
template/build.sh linux 9100
template/build.sh desktop 9101 --gpu 0000:01:00.0
template/build.sh copy-desktop 9101 9102 --gpu 0000:02:00.0   # a second GPU
template/build.sh desktop 9103 --cpu                          # no GPU
```

`build.sh` creates a CT from Proxmox's Ubuntu 24.04 template (downloading it
with `pveam` if needed), customises it with `pct exec`, boots it once and
runs its checks as the box user, then cleans it, turns it into a template in
`BBBOX_POOL` and protects it. Only root can give a container device nodes or
features, and a clone copies them, so the plugin's token never needs those
rights. `copy-desktop` makes a full copy of a desktop template with another
GPU's device nodes; use it to spread desktops across GPUs. `desktop --cpu`
makes a desktop template with no device nodes and no NVIDIA userspace,
whose display always takes the CPU path; it is what a host without an
NVIDIA driver gets, and a GPU host can offer CPU desktops with it without
using GPU memory. `build.sh headless`, the Linux template's earlier name,
still works.

To rebuild a template in place, for example with new pins, add `--replace`:

```sh
template/build.sh linux 9100 --replace
template/build.sh copy-desktop 9101 9102 --gpu 0000:02:00.0 --replace
```

The new template is built and checked (for `copy-desktop`, copied) in
another CT, `BBBOX_BUILD_VMID` or else the next free VMID, and takes the old
template's VMID only then, so a failure leaves the old template as it was.
`--replace` replaces only a bb-box template of the same kind. The old
template is removed and the new one put in its place: on LVM-thin as a
linked clone, which leaves the VMID without a template for about 3 s, and
elsewhere as a full copy, which takes longer. A clone that fails meanwhile
waits up to 10 s for the template and tries again, and the box's timings
show the wait.

Boxes cloned from the old template keep running. On LVM-thin a linked clone
is a thin snapshot that needs nothing of its template's volume, so boxes
keep the old template's blocks in the pool until they are released. Where a
linked clone needs its template, as on ZFS or Ceph RBD, `--replace` refuses
while such boxes exist: release them first. Two builds at the same time each
need their own `BBBOX_BUILD_ADDRESS` and `BBBOX_BUILD_VMID`.

Each template `build.sh` makes, or copies, gets a tag with a build ID of its
own, such as `build.20260101-120000-3f62`, which it keeps through
`--replace`. A warm box carries the ID of the template it was cloned from.
bb-box hands out no warm box whose template now has another ID, or is away
while it is replaced, and replaces those boxes with clones of the new
template. A template made some other way has no ID. If you replace a
template by other means, tag the new one with a new ID, so bb-box replaces
the warm boxes of the old one: `pct set 9100 --tags build.$(date -u +%s)`,
for example. `--tags` replaces all of the template's tags, so add any others
it should keep, separated by `;`.

Everything a build downloads is checked against a pinned SHA-256 and kept in
`/var/cache/bb-box/artifacts`:

- `template/apt-snapshot`: the Ubuntu archive snapshot every build installs
  from, so builds are repeatable;
- `template/pins.json`: Node.js, GitHub CLI, ripgrep, fd, Jujutsu, uv,
  Claude Code, Codex and Pi, each for x86_64 and arm64 (`arch`). A build
  installs the ones for its image's architecture: x86_64 here, arm64 for
  Linux VMs on a Mac (040);
- `template/desktop-pins.tsv`: TigerVNC, VirtualGL, Google Chrome, Cua
  Driver and rustup;
- the NVIDIA installer for exactly the host's driver version, checked against
  the SHA-256 NVIDIA publishes next to it.

To update a tool, change its pins (URL and SHA-256, for each architecture)
and rebuild.

### What is in a box

Both templates:

- Ubuntu 24.04 in an unprivileged container with `nesting=1`, no
  cloud-init, snapd or maintenance timers, and no apt runs at start;
- the user `box` (uid 1000): passwordless sudo, in the `sudo` and `docker`
  groups, with the plugin's SSH key; root also accepts that key. Linger is on
  for `box`, so its systemd user manager starts at boot and keeps running
  without a login: BB's installer puts its host daemon there when a box
  enrols as a BB machine (as `box`). At boot, `/etc/tmpfiles.d/bb-box.conf`
  removes the daemon lock and pid file a hard stop leaves behind, so a
  restarted box reconnects at once;
- build tools, Python, Git with Git LFS, the pinned tools above, Docker with
  compose and buildx, the Postgres, Redis and SQLite clients, Vim and Neovim
  (`vim` and `nvim`; `editor` stays nano), and everyday tools such as
  `tree`, `bc`, `zstd`, `socat` and `netstat`;
- pnpm and Yarn through Corepack, which fetches the version a project names
  on first use without asking; `~/.local/bin` is on `box`'s PATH, for
  `uv tool install` and pipx;
- apt's package lists, from the image's own Ubuntu archive sources as they
  were at the build (not the build's snapshot), stored compressed (about
  70 MiB), so `sudo apt-get install <package>` works at once. They age with
  the template: when apt answers 404 Not Found for a package updated since,
  run `sudo apt-get update`, or rebuild the templates;
- SSH with keys only; each box makes its own host keys on first boot;
- systemd-networkd with the address Proxmox writes from the plugin's
  settings, systemd-resolved with `BBBOX_DNS`, IPv4 only;
- a gratuitous ARP as soon as the address is up (`bb-box-announce.service`),
  so the host stops using a deleted box's MAC for a reused address at once
  instead of after its neighbour timers (up to 8 s);
- BB's host package for `box`, if `BBBOX_BB_URL` was set;
- `bb-box-check-headless`, a health check the plugin can run as `box`.

The desktop template adds:

- an XFCE session on display `:99` as `box`, and VNC on port 5900 with a
  password each box makes on first boot (`/var/lib/bb-box/vnc-password`,
  readable by `box` and root);
- the NVIDIA userspace matching the host's driver, VirtualGL, Vulkan and
  Mesa's CPU renderers, Google Chrome, and Cua Driver running as a daemon in
  the desktop session (below);
- Mousepad (text editor), Ristretto (image viewer), Evince (PDF viewer) and
  XFCE's application finder, which open text files, images and PDFs; web
  pages open in Chrome;
- Noto CJK fonts (88 MiB), so Chinese, Japanese and Korean text renders;
- Rust (rustup, stable) and the libraries Zed's GPUI needs to build;
- `bb-box-check-desktop`, which checks the display, VNC, the GPU, Chrome's
  GPU status, CJK fonts, that Mousepad opens a window, and Cua Driver.

### Computer use (Cua Driver)

The desktop template installs one pinned Cua Driver release (checked
against both SHA-256 values in `template/desktop-pins.tsv`) and runs it as a
daemon in the box user's systemd manager: `bb-box-cua-driver.service` runs
`cua-driver serve` with the desktop's `DISPLAY` and `XAUTHORITY`, and
`bb-box-session.service` starts it with the XFCE session and stops it with
the session. It listens on `/home/box/.cache/cua-driver/cua-driver.sock`.

The plugin keeps one SSH session per box running
`cua-driver mcp --socket /home/box/.cache/cua-driver/cua-driver.sock` and
speaks MCP over it, so element references live as long as the daemon. A
person can use the same daemon from a shell, for example
`cua-driver call get_screen_size`.

Cua Driver's telemetry and its update check are off everywhere it runs:
`CUA_DRIVER_RS_TELEMETRY_ENABLED=false` and `CUA_DRIVER_RS_UPDATE_CHECK=false`
are set for every login and user service, and `~/.cua-driver/config.json`
for `box` and root says the same. The template carries no Cua installation
ID. Move the pin only after checking the new release on a box.

Every login of `box`, including SSH commands and BB's services, gets
`DISPLAY=:99` and `XAUTHORITY=/run/bb-box/Xauthority`.

### The desktop's display

`bb-box-display.service` chooses a path each time it starts:

- **GPU**: a rootless Xorg server with NVIDIA's driver on a virtual
  1920x1080 screen, served by TigerVNC's `x0tigervncserver`. OpenGL and
  Vulkan run on the GPU, so Chrome's compositing, WebGL and WebGPU, and
  Vulkan apps such as GPUI, are hardware accelerated.
- **CPU**: `Xtigervnc`, with OpenGL and Vulkan on Mesa's CPU renderers
  (llvmpipe and lavapipe). Everything works, slowly: Chrome keeps WebGL,
  WebGPU and compositing on the CPU (the template's Chrome wrapper adds
  `--ignore-gpu-blocklist` on this path), and Vulkan apps present in mailbox
  mode, because Xtigervnc paces FIFO presentation by its viewers and would
  stall an app while nobody watches. The settings programs need on this path
  are in `/run/bb-box/display.env`, which the desktop session and the box
  user's shells load.

It takes the CPU path when the GPU's device nodes are missing, when the
host's NVIDIA driver no longer matches the template's userspace, or when the
GPU has less than `MIN_FREE_VRAM_MIB` free (384 by default: enough for Xorg
and Chrome's GPU process). The path is in `/run/bb-box/display-mode` (`gpu`
or `cpu`), and why in `/run/bb-box/display-reason`. Settings are in
`/etc/bb-box/desktop.env` in the box.

A desktop on the CPU path moves to the GPU once memory is free:

```sh
sudo systemctl restart bb-box-display   # restarts the desktop session
```

Limits:

- A desktop uses one GPU. With two GPUs visible, Vulkan's first device may
  not be the one driving the X screen and cannot present to it, so each
  desktop template carries exactly one GPU.
- The GPU's free memory limits how many desktops get the GPU at once. Each
  desktop's Xorg takes about 40 to 75 MiB, Chrome and GPU apps more.
- Both paths start at 1920x1080 and resize to the viewer while you hold
  control. On the GPU path bb-box runs `xrandr --fb` over SSH, since
  `x0vncserver` cannot resize a screen with no RandR outputs.
- When the host's NVIDIA driver changes, desktops fall back to the CPU until
  you rebuild the desktop templates.

## 5. The plugin's API token

```sh
host/setup-token.sh
```

This creates the pool, a user with no password, an API token with privilege
separation, and the role `BBBoxPlugin` with only what the plugin uses:

| Privilege | Used for |
| --- | --- |
| VM.Clone | linked-clone a template |
| VM.Allocate | create boxes in the pool, and delete them |
| VM.Config.CPU, VM.Config.Memory, VM.Config.Disk | cores, memory, disk size |
| VM.Config.Network | the box's address on `net0` |
| VM.Config.Options | description, tags, and clearing the protection a clone inherits |
| VM.Config.HWType | a Windows box's SMBIOS serial, which carries its address (Proxmox QEMU) |
| VM.Console | a Windows box's desktop, through the API's VNC proxy (Proxmox QEMU) |
| VM.PowerMgmt | start and stop |
| VM.Audit, Pool.Audit | status, config and the pool's members |

The role applies on `/pool/<pool>`; the token also gets `PVEDatastoreUser`
on the storage and `PVESDNUser` on the bridge, which cloning and setting the
network need, and `Sys.Audit` on `/nodes/<node>` (a role named after the API
role with `-node` added), so the capacity guard and `doctor` can read the
node's memory, disk and network. With privilege separation the token has the intersection of
its own ACLs and its user's, so both get the same ones. The token cannot
touch guests outside the pool, pass host devices through, or set container
features other than nesting. Run the script again after an update that adds
a privilege: it changes the role in place and keeps the token.

The token is written to `BBBOX_TOKEN_FILE` (mode 0600) with the API URL,
node and the SHA-256 fingerprint of the host's certificate. The script never
prints the secret.

## 6. Smoke test

```sh
test/smoke.sh 9100 9900 10.200.0.50
test/smoke.sh 9101 9901 10.200.0.51
```

It does what the plugin does, with the token: clone, configure, start, wait
for SSH, run the template's check as `box` and delete the box, and prints
how long each step took.

To test the plugin's own code against the host before installing it, run
this from a checkout of bb-box, on a machine that reaches the host's API and
the box subnet ([Reaching boxes](#reaching-boxes)), with Node 22.18 or later:

```sh
npm install
cp scripts/smoke.example.json /root/bb-box/smoke.json
node scripts/smoke.ts /root/bb-box/smoke.json --doctor
```

The example is a configuration file in the form `bb box config show --json`
prints, with the secrets in it. It reads the API URL, node, token and
fingerprint from the token file, and the key from `ssh/id_ed25519`, both
next to the settings file. Change the other values to match your host. It acquires a
`linux` box, runs `uname -a`, releases the box and prints each
step's time. `--kind`, `--size` and `--command` pick another kind, preset
or command. The smoke run prints the size the box has. For a
desktop kind it also prints the box's GPU, display mode and the reason, and
opens the desktop as the viewer's relay does, answering its VNC password,
and prints the desktop's size:

```sh
node scripts/smoke.ts /root/bb-box/smoke.json --kind linux-desktop
```

Smoke runs are an install of their own, with the ID `smoke`, so they can
share the pool with a BB server's bb-box: neither touches the other's boxes,
though they share the host's capacity. Each run first releases any box an
earlier run left.

## 7. Configuration

Set up the backend on BB Box's settings page in BB: open Proxmox LXC's
setup and fill in its fields, which appear in this order. The examples are
this guide's defaults; a host set up with them needs only the values from
the token file, the SSH key and the templates you built. "Check" tests the
fields against the host before you save them; "Save and turn on" does
both.

From a terminal, `bb box config show --json` prints the configuration, and
`bb box config apply <file>` saves an edited copy. The backend's part of the
file looks like this, with the field names below:

```json
{
  "backends": [
    {
      "id": "proxmox-lxc",
      "type": "proxmox-lxc",
      "enabled": true,
      "fields": { "url": "https://192.0.2.10:8006/api2/json", "token-id": "bbbox@pve!plugin", "token-secret": "<from the token file>" },
      "warm": { "linux": 1 }
    }
  ]
}
```

| Field | Example | Notes |
| --- | --- | --- |
| `url` | `https://192.0.2.10:8006/api2/json` | from the token file |
| `node` | `pve` | from the token file; can be empty on a single-node host |
| `tls-fingerprint` |  | from the token file: the SHA-256 of the host's certificate, which bb-box then trusts alone |
| `ca-certificate` |  | only without a fingerprint, when a private CA signed the host's certificate |
| `token-id` | `bbbox@pve!plugin` | from the token file |
| `token-secret` |  | secret; from the token file |
| `ssh-private-key` |  | secret; the key `BBBOX_SSH_KEY` names. Left empty, bb-box makes one and its doctor shows the public key the templates must accept |
| `pool` | `bbbox` | `BBBOX_POOL` |
| `linux-templates` | `9100` | VMIDs of Linux templates, separated by spaces or commas |
| `desktop-templates` | `9101 GPU-<uuid>`, then `9102 GPU-<uuid>` on the next line | one line per GPU desktop template: its VMID and its GPU's ID |
| `desktop-cpu-templates` | `9103` | VMIDs of CPU-only desktop templates |
| `desktops-per-gpu` | `0` | the most desktops on one GPU at once; 0 means no limit |
| `bridge` | `vmbr200` | `BBBOX_BRIDGE` |
| `subnet` | `10.200.0.0/24` | the subnet of `BBBOX_GATEWAY_CIDR` |
| `gateway` | `10.200.0.1` | the address of `BBBOX_GATEWAY_CIDR` |
| `addresses` | `10.200.0.10-10.200.0.254` | box addresses; the n-th VMID gets the n-th address |
| `vmid-first` | `9900` | boxes take VMIDs from this range; keep other guests out of it |
| `vmid-last` | `9999` |  |
| `ssh-user` | `box` |  |
| `reserve-memory-mib` | `4096` | a new box is refused if the node would have less memory free |
| `reserve-disk-gib` | `50` | a new box is refused if the template's storage has less free |

`warm` keeps started boxes waiting per kind, so a new box is ready at once.
`linux` and `linux-docker` are clones of the same templates and share their
warm boxes, so the backend keeps the sum of their counts.

A box is made at the size asked for: its kind's preset or a custom size
([028](../../docs/decisions/028-a-box-size-is-chosen-when-it-is-made.md)).
The kinds part of bb-box's configuration changes the presets, and
`skills/bb-box/SKILL.md` lists them. A disk size grows the template's disk;
one smaller than the template's keeps the template's, which is quickest.
A warm box waits at its template's size, which `build.sh` makes its kinds'
default size: 2 cores and 4 GiB for Linux templates, 4 cores and 8 GiB for
desktops. It is handed out only to a box with the same cores, and given that
box's memory and disk. A running container takes new memory at once, but
new cores only when Proxmox next rebalances its CPUs, up to 10 s later, so a
box with other cores is a new clone, ready in 2 to 4 s. If `box-sizes`
gives a kind's default size other cores, its warm boxes serve only boxes
with the template's cores. Capacity
checks the size against the node's CPU threads, its memory less the
reserve, and, for a larger disk, the storage less the reserve.

bb-box kept this backend's settings in BB's plugin settings, as
`proxmox-lxc-*` keys, until its configuration document
([029](../../docs/decisions/029-configuration-is-one-checked-document.md)).
On the first start of the version that brings it, bb-box moves them into
the document, with the same backend ID, so boxes and guests carry over.
`bb box config migrated` shows what they were.

Leave a flavour's templates empty to offer none of its kinds. Linux
templates serve `linux` and `linux-docker`, GPU desktop templates
`linux-desktop`, and CPU-only desktop templates `linux-desktop-cpu`.

The GPU's ID can be any name without spaces; templates with the same ID
share a GPU. Use its UUID, which this command lists next to the PCI address
you gave `build.sh`:

```sh
nvidia-smi --query-gpu=pci.bus_id,uuid --format=csv
```

A new box is cloned from its flavour's least used template. A GPU desktop
goes to the GPU with the fewest desktops, and is refused when every GPU runs
`proxmox-lxc-desktops-per-gpu` desktops; the refusal suggests a
`linux-desktop-cpu` box when there are CPU-only templates.

### How the plugin drives a box

1. `POST /nodes/{node}/lxc/{template}/clone` with `newid`, `hostname`,
   `pool` and `full=0`. A linked clone takes no `storage` parameter.
2. `PUT /nodes/{node}/lxc/{vmid}/config` with
   `net0=name=eth0,bridge={bridge},ip={address}/{prefix},gw={gateway},type=veth`,
   `cores` and `memory` from the size asked for, `onboot=1` and
   `delete=protection`.
3. `PUT` the same path with `tags`, now that the box is in the pool (Proxmox
   checks tags against `/vms/{vmid}` alone): `bb-box`, `thread.<id>`,
   `box.<id>`, `kind.<kind>`, `created.<seconds>` and `template.<vmid>`.
4. `POST /nodes/{node}/lxc/{vmid}/status/start`.
5. To grow the disk, `PUT /nodes/{node}/lxc/{vmid}/resize` while the box is
   running: online it takes about a second, on a stopped clone Proxmox checks
   the file system first and it takes over 20 s.
6. Wait for TCP port 22 with a connect timeout of about 250 ms, then SSH as
   `box`. An earlier attempt, made before the box has its address, waits out
   ARP resolution, which takes longer than the box's whole boot.
7. For a GPU desktop, read `/run/bb-box/display-mode` once SSH works. If it
   says `cpu`, the box did not get the GPU (`display-reason` says why), so it
   does not meet the `linux-desktop` kind: release it and try another GPU's
   template, while the kind's 30 s allows. New desktops avoid that GPU for
   10 minutes while another GPU has a template. When none is left, refuse
   and suggest `linux-desktop-cpu`. `linux-desktop-cpu` boxes come only from
   CPU-only templates. Counting desktops per GPU before cloning avoids most
   of these. Show the GPU, the mode and the reason as the box's facts. A
   warm desktop is checked the same way before it is kept.
8. To delete: `POST .../status/stop` if it is running, then
   `DELETE /nodes/{node}/lxc/{vmid}?purge=1&destroy-unreferenced-disks=1`.

Hand out addresses round-robin rather than reusing the lowest free one.
Boxes announce themselves, but a peer that missed the announcement still
holds the old box's MAC for a while.

Poll `GET /nodes/{node}/tasks/{upid}/status` every 50 to 100 ms: clone and
start finish in under a second. Treat `exitstatus` `OK` and `WARNINGS: n` as
success. VMIDs can collide with guests created meanwhile; on "already
exists", try the next free VMID in the range.

## Troubleshooting

- **A desktop box does not start** with an error about a missing device:
  run `systemctl status bb-box-nvidia-devices` on the host.
- **A desktop shows the CPU path**: read `/run/bb-box/display-reason` in the
  box. After a host driver upgrade, rebuild the desktop templates.
- **A `linux-desktop` acquire fails naming each GPU**: every GPU's desktop
  started on the CPU path, for the reasons given. `bb plugin logs bb-box`
  shows each box released. Fix the reason, or ask for `linux-desktop-cpu`.
- **The desktop viewer says the box refused its VNC password**: the plugin
  reads `/var/lib/bb-box/vnc-password` over SSH for each viewer, so VNC is
  running with another password. Restart `bb-box-display` in the box, or
  release the box.
- **Boxes cannot reach a name that resolves to the host**: see
  [Names that resolve to the host](#names-that-resolve-to-the-host).
- **Box network missing after changes on the host**: `bb-box-network check`
  says which part is missing; the timer restores it within 30 s.
