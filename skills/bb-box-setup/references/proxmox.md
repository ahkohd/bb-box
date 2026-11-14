# Proxmox LXC and Proxmox QEMU

Both drive a Proxmox VE 8 or 9 host through its API, with a token of
bb-box's own. Proxmox LXC makes Linux boxes and desktops as containers,
linked clones of templates. Proxmox QEMU makes Windows desktops, and Linux
and Android VMs, on the same host. The guides are
`setup/proxmox-lxc/README.md` and `setup/proxmox-qemu/README.md`.

## Ask

- The host's address, and how you may reach it as root, such as
  `ssh root@192.0.2.10`. Every script runs on the host as root.
- Which storage has linked clones (LVM-thin, ZFS or Ceph RBD), and a free
  bridge name and subnet for boxes. The defaults are `vmbr200` and
  `10.200.0.1/24`.
- Which kinds they want: Linux, CPU desktops, GPU desktops (an NVIDIA GPU
  and driver on the host), Wayland desktops, Windows (their own Windows 11
  ISO and licence), Linux VMs, Android.
- BB's server URL, which boxes must reach.

## Prepare the host

Copy `setup/proxmox-lxc` from a checkout of bb-box at the installed commit
to the host, then, as root there:

```sh
mkdir -p /etc/bb-box && cp host/bb-box.env.example /etc/bb-box/bb-box.env
# edit /etc/bb-box/bb-box.env: BBBOX_BRIDGE, BBBOX_GATEWAY_CIDR, BBBOX_STORAGE, BBBOX_BB_URL
host/setup-host.sh
host/setup-network.sh
template/build.sh linux 9100                 # 5 to 10 minutes each
template/build.sh desktop 9103 --cpu         # a CPU desktop, if wanted
host/setup-token.sh
```

- The machine that runs BB must reach the box subnet. Add a route through
  the host, such as `ip route replace 10.200.0.0/24 via 192.0.2.10`, or on
  the LAN router. Ask the person before you change routes on BB's machine.
- `setup-token.sh` writes the token, the API URL, the node and the TLS
  fingerprint to `/root/bb-box/proxmox-token.env` on the host. It never
  prints the secret. Do not print that file either.
- The templates accept the SSH key `BBBOX_SSH_KEY` names,
  `/root/bb-box/ssh/id_ed25519` by default. bb-box must use that key.

## Get the token and key to bb-box without seeing them

Copy both files from the host into your thread's storage without printing
them, then read only the lines that are not secret:

```sh
umask 077
scp root@192.0.2.10:/root/bb-box/proxmox-token.env "$BB_THREAD_STORAGE/proxmox.env"
scp root@192.0.2.10:/root/bb-box/ssh/id_ed25519 "$BB_THREAD_STORAGE/proxmox-key"
grep -v SECRET "$BB_THREAD_STORAGE/proxmox.env"   # URL, node, token ID, fingerprint
```

Then add the backend. The key goes by `--secret-file`, which is read on the
machine BB's server runs on; if your thread runs elsewhere, ask the person
to put the key there, or leave the key out and see below.

```sh
grep '^PROXMOX_TOKEN_SECRET=' "$BB_THREAD_STORAGE/proxmox.env" | \
  bb box backend add proxmox-lxc \
    --field url=https://192.0.2.10:8006/api2/json --field node=pve \
    --field token-id='bbbox@pve!plugin' --field tls-fingerprint=<fingerprint> \
    --field linux-templates=9100 --field desktop-cpu-templates=9103 \
    --secret token-secret=PROXMOX_TOKEN_SECRET --secrets-stdin \
    --secret-file ssh-private-key="$BB_THREAD_STORAGE/proxmox-key" --check
```

Run it again without `--check` to save it. Delete the copies afterwards.

Left empty, `ssh-private-key` makes bb-box generate a key, and the backend's
checks give its public key; the templates must then be built with it.

## Fields worth knowing

| Field | What it takes |
| --- | --- |
| `linux-templates`, `desktop-cpu-templates`, `desktop-wayland-cpu-templates` | VMIDs, separated by spaces or commas. Empty offers none of that kind |
| `desktop-templates` | One line per GPU desktop template: its VMID. On a host without the GPU helper, a space and the GPU its device lines name, such as `9101 GPU-<uuid>`. Use `--field-file` or `--add-line` |
| `boxes-per-card` | The most of this install's boxes running on one card, 4 unless set, 0 for no limit. Unset, the replaced `desktops-per-gpu` is read, 0 included |
| `whole-cards` | A card to itself for a box: needs `bb-box-gpu` 0.4.3 or later. Unset, `general.wholeCards` says, off unless set |
| `gpu-memory-mib` | The memory a card must have free for a new server, 1024 unless set |
| `bridge`, `subnet`, `gateway`, `addresses` | Must match `/etc/bb-box/bb-box.env` when it changed them |
| `vmid-first`, `vmid-last` | The VMIDs boxes take. Keep other guests out of the range |

## GPU boxes

On a host with NVIDIA cards and its driver, the GPU helper gives each Linux
box and desktop its card: none, shared or a whole card. Ask the person
first: it runs as root on the host, and once its writes are on, bb-box's
token can give a box in its pool a card's device nodes. Follow "The GPU
helper" in `setup/proxmox-lxc/README.md`: build the templates on the host
with its driver, run `host/setup-gpu.sh`, which starts in a dry run, mark
running GPU desktops with `bb box gpu mark`, and after a day turn writes on
with `host/setup-gpu.sh --writes on --check`, then `--writes on`. Then set
the backend's GPUs fields above. Prove it with
`bb box acquire linux --gpu shared` and `nvidia-smi -L` in the box.

## Proxmox QEMU

It needs the Proxmox LXC host's settings, network and token: steps 1, 2, 3
and 5 above. Its connection, token and SSH key, left empty, are Proxmox
LXC's. Build templates on the host with `setup/proxmox-qemu/build.sh`:
`windows 9104` takes about 50 minutes, `linux 9106` and `linux-desktop 9107`
less, and `android 9108` needs nested virtualization and the Android SDK
licence. Keep its addresses and VMIDs apart from Proxmox LXC's:

```sh
bb box backend add proxmox-qemu --field windows-templates=9104 \
  --field addresses=10.200.0.150-10.200.0.254 --field vmid-first=9700 --field vmid-last=9799
```

Set `linux-templates`, `linux-desktop-templates` and `android-templates`
for the others, and `linux-kvm=true` when the build said KVM works in a
clone. A Windows box holds its memory while it runs, and a spare or warm
one waits hibernated, so keep their counts small on a small host. When the
doctor warns that a Windows template's box user's password can expire,
refresh it with `bb box images build proxmox-qemu/<vmid>`, or rebuild it:
its boxes otherwise need a repair and one more restart as they start.

## Check and prove

`test/smoke.sh 9100 9900 10.200.0.50` on the host clones, starts, checks and
deletes a box with the token. Then `bb box doctor`, and a first box:
`bb box acquire linux --on proxmox-lxc`, or `windows-desktop --on
proxmox-qemu`. A Windows box takes a minute or two to join BB.
