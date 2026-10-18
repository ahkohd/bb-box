# Proxmox LXC backend

This backend runs boxes as unprivileged LXC containers on a Proxmox VE host.
A box is a linked clone of a CT template that you build once. There are four
templates:

- **Linux**: Ubuntu 24.04 with development tools, agent CLIs and Docker.
- **GPU desktop**: the same, plus an XFCE desktop on an NVIDIA GPU, streamed
  over VNC, with Chrome and Cua Driver for computer use. Each carries one
  GPU.
- **CPU desktop**: the desktop with no GPU, drawn by the CPU.
- **Wayland desktop**: a Sway desktop on Wayland, drawn by the CPU.

bb-box drives the host through the Proxmox API with a token of its own, and
reaches inside boxes over SSH and VNC. A new box takes a few seconds; a warm
box or a spare is ready at once. How bb-box drives a box is in the
[architecture](../../docs/architecture.md#backends).

| Path | What it does |
| --- | --- |
| `host/bb-box.env.example` | Example settings for every script here |
| `host/setup-host.sh` | Kernel modules for Docker and TUN in boxes, NVIDIA device nodes at boot |
| `host/setup-network.sh` | The box bridge, NAT and a unit that keeps them up |
| `host/setup-token.sh` | Pool, user, role, API token and ACLs for bb-box |
| `host/setup-gpu-report.sh` | With GPU desktops: the host's report of each GPU's free memory, which bb-box reads |
| `template/build.sh` | Builds the templates |
| `test/smoke.sh` | Clones, starts, checks and deletes a box with bb-box's token |

## What you need

- Proxmox VE 8 or 9, and root on the host. The scripts use `pct`, `pveum`,
  `pveam`, `nft`, `ifupdown2`, `curl`, `jq` and `python3`.
- Storage that supports linked clones for containers: LVM-thin, ZFS or Ceph
  RBD, not a plain directory.
- Internet access from the host while templates build.
- For GPU desktops: an NVIDIA GPU with NVIDIA's driver loaded on the host,
  with `nvidia-modprobe` and `nvidia-smi`. Desktops share the GPU with
  anything else on the host. Without a GPU, build CPU desktops instead.
- A route from the machine that runs BB to the boxes' subnet (step 3).

## Steps

### 1. Settings

```sh
mkdir -p /etc/bb-box
cp host/bb-box.env.example /etc/bb-box/bb-box.env
```

Edit `/etc/bb-box/bb-box.env`. The example lists every setting with its
default. Check at least:

- `BBBOX_BRIDGE` and `BBBOX_GATEWAY_CIDR`: a bridge name and a subnet that
  are free on your host and network. Boxes get addresses in this subnet.
- `BBBOX_STORAGE`: storage with linked clones.
- `BBBOX_BB_URL`: your BB server's URL. Templates then carry BB's app for the
  box user, so a box joins BB faster. Boxes must be able to reach this URL.

A setting in the environment wins over the file, for example
`BBBOX_BUILD_ADDRESS=10.200.0.3 template/build.sh ...` for a second build at
the same time.

### 2. Host prerequisites

```sh
host/setup-host.sh
```

- An unprivileged container cannot load kernel modules. So the modules
  Docker needs in boxes, and `tun` for each template's TUN device, load at
  every boot from `/etc/modules-load.d/bb-box.conf`.
- With an NVIDIA driver, `bb-box-nvidia-devices.service` makes every NVIDIA
  device node at boot. Without it, `/dev/nvidia-uvm*` appear only on first
  CUDA use, and a desktop box fails to start. The script lists each GPU's PCI
  address, which a desktop template needs.

### 3. Network

```sh
host/setup-network.sh
```

Boxes live on a bridge with no physical port. The host has the gateway
address on it, routes the subnet, and masquerades boxes out of every other
interface. Nothing is filtered: a box reaches what the host reaches, as the
host's address.

The script:

- adds the bridge to `/etc/network/interfaces`, after a backup in
  `/root/bb-box/backup`, and brings it up. Proxmox's network API reads only
  that file. It refuses to change a different bridge of the same name;
- turns on IPv4 forwarding (`/etc/sysctl.d/90-bb-box.conf`);
- writes the nft table `ip bbbox` to `/etc/bb-box/network.nft`: masquerade,
  TCP MSS clamping for VPNs with a small MTU, and any `BBBOX_DNAT` rules;
- installs `bb-box-network.service` (at boot) and `bb-box-network.timer`
  (every 30 s), which run `bb-box-network repair`. It brings back a missing
  bridge or table, and never takes anything down. To take the network down
  on purpose, stop the timer first.

bb-box sets each box's address before it starts, so there is no DHCP. DNS in
boxes uses `BBBOX_DNS`, which the templates carry.

#### Reaching boxes

bb-box reaches boxes by address, over SSH (port 22) and VNC (port 5900). On
the machine that runs BB, and any other that should reach boxes, add a route
to the box subnet through the host, for example with the host's LAN address
`192.0.2.10`:

```sh
ip route replace 10.200.0.0/24 via 192.0.2.10
```

To keep it on a machine with systemd-networkd, add a drop-in for its
interface, such as `/etc/systemd/network/eth0.network.d/bb-box.conf`:

```ini
[Route]
Destination=10.200.0.0/24
Gateway=192.0.2.10
```

A static route on your LAN router covers every LAN machine at once. On a VPN
such as Tailscale, advertise the subnet from the host, keeping any routes it
advertises already, and approve it.

#### Names that resolve to the host

A name boxes need, such as your BB server's, may resolve to one of the
host's own addresses whose port forward matches only traffic from elsewhere,
such as a VPN address. Boxes then get no answer. Add a DNAT rule for boxes:

```sh
BBBOX_DNAT="198.51.100.1:443=192.0.2.20"   # the host's VPN address -> the real server
```

### 4. Templates

Build the Linux template, then the desktops you want. Each build takes 5 to
10 minutes, mostly downloads.

```sh
template/build.sh linux 9100
template/build.sh desktop 9101 --gpu 0000:01:00.0
template/build.sh copy-desktop 9101 9102 --gpu 0000:02:00.0   # a second GPU
template/build.sh desktop 9103 --cpu                          # no GPU
template/build.sh desktop 9105 --cpu --wayland                # Wayland, no GPU
```

- `build.sh` makes a CT from Proxmox's Ubuntu 24.04 template, customises it,
  boots it once and runs its checks as the box user. It then cleans it,
  makes it a template in `BBBOX_POOL` and protects it.
- Only root can give a container device nodes or features, and a clone copies
  them, so bb-box's token never needs those rights.
- `copy-desktop` makes a full copy of a desktop template for another GPU,
  to spread desktops across GPUs.
- `desktop --cpu` makes a desktop with no GPU device nodes and no NVIDIA
  userspace. A host without an NVIDIA driver gets it without `--cpu`. A GPU
  host can offer CPU desktops with it, without using GPU memory.
- `desktop --cpu --wayland` makes the Wayland desktop (048).

Every template gets `/dev/net/tun`, so its boxes can run Tailscale and other
VPNs (050). Its check confirms the device opens.

Every download is checked against a pinned SHA-256, and kept in
`/var/cache/bb-box/artifacts`:

- `template/apt-snapshot`: the Ubuntu archive snapshot each build installs
  from, so builds repeat;
- `template/pins.json`: Node.js, GitHub CLI, ripgrep, fd, Jujutsu, uv, Claude
  Code, Codex and Pi, for x86_64 and arm64;
- `template/desktop-pins.tsv`: TigerVNC, VirtualGL, Selkies, Google Chrome,
  Cua Driver and rustup, for x86_64 and arm64;
- the NVIDIA installer for the host's driver version, checked against the
  SHA-256 NVIDIA publishes beside it.

### 5. The plugin's API token

```sh
host/setup-token.sh
```

This makes the pool, a user with no password, an API token with privilege
separation, and the role `BBBoxPlugin` with only what bb-box uses:

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

The role applies on `/pool/<pool>`. The token also gets `PVEDatastoreUser` on
the storage and `PVESDNUser` on the bridge, which cloning and the network
need, and `Sys.Audit` on `/nodes/<node>` (the role `BBBoxPlugin-node`), so
bb-box can read the node's memory, disk and network. The token cannot touch
guests outside the pool, pass host devices through, or set container
features other than nesting.

The token can refresh the templates that exist: clone one, make the clone a
template and put it in the old one's place. It cannot make a template from
nothing or give a container host devices. So a new template, a template for
another GPU, and a new image contract need `template/build.sh` as root.

The script writes the token to `BBBOX_TOKEN_FILE` (mode 0600), with the API
URL, the node and the SHA-256 fingerprint of the host's certificate. It never
prints the secret.

#### The GPU memory report

With GPU desktops, have the host report each GPU's free memory:

```sh
host/setup-gpu-report.sh
```

Proxmox's API cannot read GPU memory, and the token cannot read files on the
host. Without the report, bb-box reads GPU memory in desktops, as one starts
and every few minutes while one runs, so a GPU that other work frees shows as
free only once a desktop reads it. With the report, it shows within about
25 s.

The script:

- makes a VM named `bb-box-gpu-memory` that is never started: no disk, no
  network, 16 MiB of memory and protection on. It is outside bb-box's pool,
  so the pool's role does not reach it. Its VMID is
  `BBBOX_GPU_REPORT_VMID`, and the script refuses to run without it. Choose
  a free VMID outside bb-box's VMID range. Do not use the next free VMID:
  `template/build.sh` builds there unless `BBBOX_BUILD_VMID` is set;
- gives bb-box's user and token `PVEAuditor`, Proxmox's read-only role, on
  `/vms/<vmid>` alone. The token can read the VM's notes, and can change
  nothing it could not before;
- installs `/usr/local/sbin/bb-box-gpu-memory` and
  `bb-box-gpu-memory.timer`, which runs it as root every 15 s. It reads
  `nvidia-smi` and writes each GPU's free and total memory in the VM's notes
  with `qm set --description`. It writes only when a GPU's free memory moves
  to another 64 MiB step, or after 4 minutes, so `/etc/pve` sees few writes.

bb-box reads the notes at most every 10 s, and finds each GPU by the ID its
desktop templates give it: its UUID, its PCI address or its index. A report
under 10 minutes old stands for every GPU it names. Without one, bb-box
reads memory in desktops. The doctor's "Host's GPU report" check says which.

### 6. Configure bb-box

On BB Box's settings page in BB, open Proxmox LXC's setup and fill in its
fields. A host set up with this guide's defaults needs only the values from
the token file, the SSH key and the templates you built. Check tests the
fields against the host; Save and turn on saves them. From a terminal,
`bb box config show --json` prints the configuration and
`bb box config apply <file>` saves an edited copy.

| Field | Example | Notes |
| --- | --- | --- |
| `url` | `https://192.0.2.10:8006/api2/json` | from the token file |
| `node` | `pve` | from the token file; can be empty on a single-node host |
| `tls-fingerprint` |  | from the token file: the SHA-256 of the host's certificate, which bb-box then trusts alone |
| `ca-certificate` |  | only without a fingerprint, when a private CA signed the host's certificate |
| `token-id` | `bbbox@pve!plugin` | from the token file |
| `token-secret` |  | secret; from the token file |
| `ssh-private-key` |  | secret; the key `BBBOX_SSH_KEY` names. Left empty, bb-box makes one, and its doctor shows the public key the templates must accept |
| `pool` | `bbbox` | `BBBOX_POOL` |
| `linux-templates` | `9100` | VMIDs of Linux templates, separated by spaces or commas |
| `desktop-templates` | `9101 GPU-<uuid>`, then `9102 GPU-<uuid>` on the next line | one line per GPU desktop template: its VMID and its GPU's ID |
| `desktop-cpu-templates` | `9103` | VMIDs of CPU desktop templates |
| `desktop-wayland-cpu-templates` | `9105` | VMIDs of Wayland desktop templates |
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

- Linux templates serve `linux`, GPU desktop templates `linux-desktop`, CPU
  desktop templates `linux-desktop-cpu`, and Wayland desktop templates
  `linux-desktop-wayland-cpu`. Leave a list empty to offer none of its kind.
- A GPU's ID can be any name without spaces; templates with the same ID share
  a GPU. Use its UUID, which this lists beside the PCI address you gave
  `build.sh`: `nvidia-smi --query-gpu=pci.bus_id,uuid --format=csv`.
- A new box is a clone of its kind's least used template. A GPU desktop goes
  to the GPU with the fewest desktops. It is refused when every GPU has
  `desktops-per-gpu` desktops, and the refusal suggests `linux-desktop-cpu`.
- A GPU desktop needs 384 MiB of GPU memory free as it starts. bb-box reads
  each GPU's free memory from [the host's report](#the-gpu-memory-report).
  Without it, bb-box reads it as a desktop on it starts, and with
  `nvidia-smi` in a running one every few minutes. The doctor shows each
  GPU's last reading. A new desktop skips a GPU that has less free, and is
  refused at once when every GPU has; the refusal suggests
  `linux-desktop-cpu`. A reading in a desktop stands for 5 minutes.
- `warm` keeps started boxes waiting per kind, so a new box is ready at once.
  A warm box waits at its template's size: 2 cores and 4 GiB for Linux, 4
  cores and 8 GiB for desktops. It serves only boxes with the same cores,
  since a running container takes new cores only when Proxmox next balances
  its CPUs, up to 10 s later. A box with other cores is a new clone. If the
  configuration's `kinds` part gives a kind's default size other cores, its
  warm boxes serve only boxes with the template's cores.

## Check it worked

```sh
test/smoke.sh 9100 9900 10.200.0.50
test/smoke.sh 9101 9901 10.200.0.51
```

It does what bb-box does, with the token: clone, configure, start, wait for
SSH, run the template's check as `box`, delete the box, and print how long
each step took.

Then run `bb box doctor`. For each template, its "Image of" check:

- fails when the image keeps an older contract than bb-box needs, or when its
  NVIDIA userspace is not the host's driver, since its desktops then start
  without the GPU;
- warns when the image is more than 14 days old, has another build of BB's
  app than BB's server gives, or was built with other pins than this
  bb-box's.

Its fix is the `build.sh` command that rebuilds the template.

## Update

- **Templates rebuild each night** once the nightly run is set up
  ([setup](../README.md#rebuild-images-each-night)). A nightly rebuild takes
  the latest Claude Code, Codex, Pi, gh and Chrome, and the day's apt
  snapshot, each checked against the SHA-256 its upstream publishes. The
  other tools stay pinned. `bb box images versions` shows what a rebuild
  would take.
- **Rebuild a template by hand** with `--replace`:

  ```sh
  template/build.sh linux 9100 --replace
  template/build.sh copy-desktop 9101 9102 --gpu 0000:02:00.0 --replace
  ```

  The new template is built and checked in another CT, and takes the old
  one's VMID only then, so a failure leaves the old template as it was.
  Boxes cloned from the old one keep running on LVM-thin. On storage where a
  linked clone needs its template, as on ZFS or Ceph RBD, `--replace` refuses
  while such boxes exist: release them first. Two builds at once each need
  their own `BBBOX_BUILD_ADDRESS` and `BBBOX_BUILD_VMID`.
- **Warm boxes follow the template.** Each template has a build ID in its
  tags, such as `build.20260101-120000-3f62`. bb-box hands out no warm box
  of an older build, and makes new ones. If you replace a template some
  other way, give it a new build ID, keeping its other tags (`--tags`
  replaces them all): `pct set 9100 --tags "build.$(date -u +%s)"`.
- **To change a tool's version**, change its pins (URL and SHA-256 for each
  architecture) and rebuild.
- **After the host's NVIDIA driver changes**, desktops start on the CPU until
  you rebuild the desktop templates.
- **After a bb-box update that adds a privilege**, run `host/setup-token.sh`
  again: it changes the role in place and keeps the token. Run
  `host/setup-host.sh` again if the update says so.

## Remove

1. In BB, release the backend's boxes, turn the backend off and remove it on
   BB Box's settings page.
2. On the host, delete what is left in the pool, such as image boxes and
   projects' image templates, then the templates:
   `pct set <vmid> --protection 0 && pct destroy <vmid>`.
3. Remove the token, the user, the roles and the pool:
   `pveum user delete <user>` (its tokens go with it),
   `pveum role delete BBBoxPlugin`, `pveum role delete BBBoxPlugin-node` and
   `pveum pool delete <pool>`, then delete `BBBOX_TOKEN_FILE`.
4. Take the network down: `systemctl disable --now bb-box-network.timer
   bb-box-network.service`, `nft delete table ip bbbox`, then remove the
   bridge's lines from `/etc/network/interfaces` and run `ifdown <bridge>`.
   Delete `/etc/systemd/system/bb-box-network.*`,
   `/usr/local/sbin/bb-box-network` and, if nothing else needs forwarding,
   `/etc/sysctl.d/90-bb-box.conf`.
5. Remove the GPU memory report: `systemctl disable --now
   bb-box-gpu-memory.timer`, delete `/etc/systemd/system/bb-box-gpu-memory.*`
   and `/usr/local/sbin/bb-box-gpu-memory`, then
   `qm set <vmid> --protection 0 && qm destroy <vmid>`. Proxmox removes the
   VM's ACLs with it.
6. Remove the host's parts: `systemctl disable --now
   bb-box-nvidia-devices.service`, then delete that unit,
   `/etc/modules-load.d/bb-box.conf`, `/etc/bb-box` and
   `/var/cache/bb-box`.

## When it goes wrong

- **A desktop box does not start**, with an error about a missing device: run
  `systemctl status bb-box-nvidia-devices` on the host.
- **A desktop shows the CPU path**: read `/run/bb-box/display-reason` in the
  box. After a driver upgrade on the host, rebuild the desktop templates.
- **A `linux-desktop` acquire fails, naming each GPU**: every GPU's desktop
  started on the CPU, for the reasons given. `bb plugin logs bb-box` shows
  each box released. Fix the reason, or ask for `linux-desktop-cpu`.
- **A `linux-desktop` acquire is refused at once for GPU memory**: every GPU
  had less than 384 MiB free when bb-box last looked. `bb box doctor` shows
  each GPU's reading. Free memory on a GPU, or ask for `linux-desktop-cpu`.
- **The doctor says the host's GPU report is old**: run
  `systemctl status bb-box-gpu-memory` on the host. Its log names a missing
  VM or an `nvidia-smi` that gave no memory. A host clock 10 minutes or more
  behind the BB server's also makes the report look old.
- **The desktop viewer says the box refused its VNC password**: VNC runs with
  another password than `/var/lib/bb-box/vnc-password`. Restart
  `bb-box-display` in the box, or release the box.
- **Boxes cannot reach a name that resolves to the host**: see
  [Names that resolve to the host](#names-that-resolve-to-the-host).
- **The box network is missing after changes on the host**:
  `bb-box-network check` says which part is missing; the timer restores it
  within 30 s.

## What a box has

Every template:

- Ubuntu 24.04 in an unprivileged container with `nesting=1`, no cloud-init,
  snapd or maintenance timers, and no apt run at start;
- the user `box` (uid 1000), with passwordless sudo, in the `sudo` and
  `docker` groups, with bb-box's SSH key; root accepts that key too. Linger is
  on for `box`, so its systemd user manager runs without a login, where BB's
  daemon runs once the box joins BB;
- build tools, Python, Git with Git LFS, the pinned tools, Docker with compose
  and buildx, which starts at its first use (041), the Postgres, Redis and
  SQLite clients, Vim and Neovim, and tools such as `tree`, `bc`, `zstd`,
  `socat` and `netstat`;
- pnpm and Yarn through Corepack, and `~/.local/bin` on `box`'s PATH;
- apt's package lists from the build, so `sudo apt-get install <package>`
  works at once. When apt answers 404 Not Found, run `sudo apt-get update`;
- SSH with keys only; each box makes its own host keys at first boot;
- systemd-networkd and systemd-resolved, IPv4 only, and a gratuitous ARP once
  the address is up, so the host forgets a deleted box's MAC at once;
- BB's app for `box`, if `BBBOX_BB_URL` was set;
- `/dev/net/tun`;
- `bb-box-check-headless`, a check bb-box runs as `box`.

The XFCE desktops add:

- an XFCE session on display `:99` as `box`, and VNC on port 5900, with a
  password each box makes at first boot (`/var/lib/bb-box/vnc-password`);
- Selkies 2.0, which streams `:99` as H.264 over WebSockets on
  `127.0.0.1:5980`, in `bb-box-selkies.service`, which starts and stops
  with the display. It captures nothing while no viewer is connected, and
  waits on the GPU path
  ([056](../../docs/decisions/056-linux-x11-desktops-add-a-selkies-stream-and-rfb-stays-for-the-rest-tuned.md));
- on a GPU desktop, the NVIDIA userspace for the host's driver and
  VirtualGL; on every desktop, Vulkan and Mesa's CPU renderers;
- Google Chrome, Mousepad, Ristretto, Evince and Noto CJK fonts;
- Rust (rustup, stable) and the libraries Zed's GPUI needs to build;
- Cua Driver, as a daemon in the desktop session, with its telemetry and
  update check off;
- `bb-box-check-desktop`, which checks the display, VNC, Selkies, the GPU,
  Chrome, the fonts, Mousepad and Cua Driver.

The Docker and microsandbox images, made from the same scripts, carry both
checks. There, with no systemd, the lines for systemd and its units say
skip, as `bb-box-start` does what they do; Cua Driver's line checks its
process; and a Docker box whose host gives it no TUN device skips that
line, as Tailscale runs in userspace there
([050](../../docs/decisions/050-a-box-can-join-the-operators-tailnet-as-an-ephemeral-node.md)).

Each login of `box` gets `DISPLAY=:99` and
`XAUTHORITY=/run/bb-box/Xauthority`.

### The desktop's display

`bb-box-display.service` chooses a path each time it starts:

- **GPU**: a rootless Xorg server with NVIDIA's driver, served by TigerVNC.
  OpenGL and Vulkan run on the GPU.
- **CPU**: `Xtigervnc`, with OpenGL and Vulkan on Mesa's CPU renderers.
  Everything works, more slowly.

It takes the CPU path when the GPU's device nodes are missing, when the
host's driver no longer matches the template's NVIDIA userspace, or when the
GPU has less than `MIN_FREE_VRAM_MIB` free (384 by default). The path is in
`/run/bb-box/display-mode`, and why in `/run/bb-box/display-reason`.
Settings are in `/etc/bb-box/desktop.env` in the box. To move a CPU desktop
to the GPU once memory is free, run `sudo systemctl restart bb-box-display`.

- A desktop uses one GPU, and the GPU's free memory limits how many desktops
  get it at once. Each desktop's Xorg takes about 40 to 75 MiB; Chrome and
  GPU apps more.
- A desktop starts at 1920x1080, and takes the viewer's size while a person
  holds control.

### The Wayland desktop

The Wayland template has what the CPU desktop has, without XFCE, TigerVNC or
an X server:

- **Sway**, headless and drawn by the CPU, with floating windows and Waybar
  along the bottom (apps, a terminal, a button per window, a clock). Its
  config is `/etc/bb-box/sway.conf`.
- **wayvnc** on port 5900. It signs in user `box` with the password in
  `/var/lib/bb-box/vnc-password`.
- **Selkies 2.0** on `127.0.0.1:5980`, in `bb-box-selkies.service`, which
  streams Sway as H.264 video, capturing it as a client: screencopy for
  frames, Sway's virtual keyboard and pointer for input. The build patches
  it (`guest/files/selkies-host-size.py`) to stream Sway at Sway's own size:
  unpatched, each viewer set Sway to 1024x768, and a lone viewer's capture,
  as the first on a fresh box, set it to 1024x768 or an earlier layout's
  size.
- **No Xwayland and no `DISPLAY`**, so Cua Driver can see every window.
  X11-only apps, such as xterm, Java Swing, Wine and older Electron apps,
  need `linux-desktop-cpu`.
- `/usr/local/libexec/bb-box/type`, built from `guest/files/bb-box-type.c`,
  which types text with a virtual keyboard of a fixed US layout, for computer
  use: wtype's keys lost characters in Chrome.
- `wl-clipboard`, `grim`, `slurp` and `wtype` stand in for `xclip`, `scrot`
  and `xdotool`.
