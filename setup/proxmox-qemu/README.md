# Proxmox QEMU backend

This backend runs `windows-desktop` boxes as Windows 11 VMs on a Proxmox VE
host. A box is a linked clone of a template you build once, installed
unattended from your own ISO. The warm pool keeps boxes hibernated, and one of
those is ready in under 10 s. A new clone takes about a minute, sometimes
more, mostly Windows booting.

The backend shares the Proxmox LXC backend's host settings, bridge, pool, API
token and SSH key. How bb-box drives a box is in the
[architecture](../../docs/architecture.md#backends).

| Path | What it does |
| --- | --- |
| `build.sh` | Builds and checks the template, on the Proxmox host as root |
| `build-linux.sh` | Builds and checks the Linux VM template, for `build.sh linux` |
| `linux/boot.sh` | Gives each Linux VM box its address at boot, and grows its disk |
| `linux/customize-vm.sh` | Sets the Linux VM template up beyond the Proxmox LXC guest scripts |
| `answer/autounattend.xml` | The answer file: disk, edition, user `box`, no setup screens |
| `answer/bb-box/firstlogon.ps1` | Runs once at the first logon and sets the VM up |
| `answer/bb-box/boot.ps1` | Gives each box its address at boot |
| `answer/bb-box/logon.ps1` | Turns on browsers' full accessibility tree at each logon |
| [`../windows/check.ps1`](../windows/check.ps1) | Checks a clone of the new template over SSH, and a refresh's trial box |
| [`../windows/refresh.ps1`](../windows/refresh.ps1) | Refreshes the image in a box: Windows' updates and the pinned tools ([054](../../docs/decisions/054-windows-images-are-refreshed-in-a-box-of-the-current-build.md)) |

## What you need

- **A Proxmox host set up for Proxmox LXC**: its settings, network and API
  token, steps 1, 2, 3 and 5 of the
  [Proxmox LXC guide](../proxmox-lxc/README.md). Its templates are not needed.
- **A Windows 11 x64 ISO, English (United States).** Download it from
  Microsoft (<https://www.microsoft.com/software-download/windows11>,
  "Download Windows 11 Disk Image"), or use the 90-day Enterprise
  evaluation. Put it in an ISO storage on the host, by default as
  `local:iso/win11.iso` (`/var/lib/vz/template/iso/win11.iso`).
- **The virtio-win drivers**, as `local:iso/virtio-win.iso`:

  ```sh
  wget -O /var/lib/vz/template/iso/virtio-win.iso \
    https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso
  ```

- **A licence for each box.** By default the template installs Windows 11 Pro
  with Microsoft's generic install key, which installs without activating:
  Windows works, with a watermark and some personalisation settings locked.
  Set `BBBOX_WINDOWS_KEY` to your own key, or `BBBOX_WINDOWS_EDITION` to the
  edition your ISO and key are for. bb-box never ships Windows images.
- **About 40 GiB free** on the box storage, and internet access from the box
  bridge: the first logon downloads OpenSSH, PowerShell 7, Git, GitHub CLI,
  Cua Driver and the build tools, about 2 GB.

## Steps

### 1. Build the template

```sh
./build.sh windows 9104
```

It takes about 50 minutes, most of it Windows Setup. The VM's console in the
Proxmox UI shows how far it is. At the end it clones the new template, starts
the clone, and runs `../windows/check.ps1` in it over SSH with bb-box's key. It then
hibernates the clone and resumes it, as the warm pool does, and checks SSH
and Cua again:

```text
ok    PowerShell 7 over SSH              7.6.6
ok    UTF-8 code page                    ACP 65001, output utf-8
ok    SSH session elevated               box, elevated
...
ok    Edge page in the accessibility tree  <n> elements in <ms> ms
```

### 2. Configure bb-box

On BB Box's settings page in BB, open Proxmox QEMU's setup. Its connection,
token and SSH key, left empty, are Proxmox LXC's. Set at least:

| Field | Example | Notes |
| --- | --- | --- |
| `windows-templates` | `9104` | VMIDs of the Windows templates, separated by spaces or commas |
| `addresses` | `10.200.0.150-10.200.0.254` | box addresses: keep them apart from Proxmox LXC's |
| `vmid-first`, `vmid-last` | `9700`, `9799` | the VMIDs boxes take: keep them apart from Proxmox LXC's |

The [configuration reference](../../docs/reference/configuration.md#proxmox-qemu)
lists every field. Check tests the fields against the host; Save and turn on
saves them.

#### Windows boxes as BB machines

A box joins BB as a machine, as a Linux box does, so threads and terminals
can use it. Set `windows-enrol` off to keep Windows boxes out of BB. It
needs:

- BB 0.45.0 or later, whose Windows installer each box runs in its desktop
  session
- Node.js 22.19 or later in the template, which `build.sh` installs: a
  template without it still works, but each box then installs it as it
  joins BB, about 11 s more
- an agent CLI in the template for `box_thread`: `build.sh` installs Claude
  Code, Codex and Pi

A box takes about a minute to join BB, most of it BB's installer. A spare is
a BB machine already. Give `windows-desktop` a spare in Kinds, and it waits
hibernated, holding no memory, in the place of a warm box. BB's machine list
names its machine "(spare, stopped)" and shows it offline while it waits. A
box that takes it is a BB machine about 12 seconds later, and the New box
form says "ready in seconds".

A Windows box's machine is a machine of BB's manual provider, which bb-box
makes and removes with the box. Removing it from BB's machine list does not
release the box: release the box instead. "New box" in BB's new-thread
screen cannot make a Windows box (BB request 1 in the
[requests log](../../docs/bb-requests.md)).

### 3. Linux VM boxes, if you want them

The backend can also make `linux` boxes as VMs, for a kernel of their own
([057](../../docs/decisions/057-linux-boxes-can-be-proxmox-vms-for-their-own-kernel.md)).
Build their template with:

```sh
./build.sh linux 9106
```

It needs no ISO: it downloads Ubuntu 24.04's cloud image, pinned by its
SHA-256, and sets it up with the Proxmox LXC Linux template's guest scripts.
It needs about 16 GiB on the box storage. At the end it checks a clone of
the new template: its address, its disk grown, the box user's tools, and a
hibernate and resume. `--replace` and `--keep` work as for Windows.

Then add the template's VMID to `linux-templates` in Proxmox QEMU's setup.
A `linux` acquire chooses a VM only when it asks for one, with `on` or the
`linux-vm` kind, or when the other backends have no room.

The build also says whether KVM works in a clone, which needs the host to
allow nested virtualization. If it does, turn on `linux-kvm` too: boxes
then have `/dev/kvm`, for VMs and emulators of their own, and the
`linux-kvm` kind asks for one.

## Check it worked

`build.sh`'s own check, above, runs in a clone of the new template. Then run
`bb box doctor`. Its "Image of" check for each template:

- fails when the template keeps an older contract than bb-box needs;
- warns when the template is more than 60 days old, or was built with other
  pins than this bb-box's `build.sh`;
- warns when Windows boxes join BB and the template has no Node.js 22.19 or
  later, or none of the agent CLIs.

Its fix is the `build.sh windows <vmid> --replace` command.

## Update

bb-box refreshes each Windows template monthly
([054](../../docs/decisions/054-windows-images-are-refreshed-in-a-box-of-the-current-build.md)),
in the nightly run of `bb box images refresh`. In a box cloned from the
template, [`../windows/refresh.ps1`](../windows/refresh.ps1) installs
Windows' updates and the tools pinned in
[`../windows/pins.json`](../windows/pins.json). The box is then made a
template, a trial box of it runs `check.ps1`, and the new template takes the
old one's place under its VMID only if every check passes. The old template
stays as a rollback, at a free VMID of bb-box's range with "rollback" in its
name, until the next refresh succeeds: to go back to it, list its VMID as the
Windows template in bb-box's settings. `bb box doctor` lists each rollback,
which holds one of the range's VMIDs and box addresses meanwhile. To refresh one now, or to try a
refresh and keep the old template:

```sh
bb box images build proxmox-qemu/9104
bb box images build proxmox-qemu/9104 --try
```

For a new Windows release or a broken template, build it again from the ISO
by hand, with `--replace`:

```sh
./build.sh windows 9104 --replace
```

The new template is built and checked in another VM, and takes the old one's
place only then. Boxes cloned from the old one keep running on LVM-thin. To
change a tool's version, change its pin in `../windows/pins.json` and its
pin lines in `build.sh` (`NAME_VERSION=`, `NAME_SHA256=` and `NAME_URL=`),
which a test keeps equal.

bb-box refreshes each Linux template weekly, as other Linux images
([057](../../docs/decisions/057-linux-boxes-can-be-proxmox-vms-for-their-own-kernel.md)).
In a box cloned from the template it runs the Proxmox LXC template's guest
scripts and `linux/customize-vm.sh`, with the versions a rebuild takes. The
checks, the replace and the rollback are as for Windows: to go back, list
the rollback's VMID as the Linux template. For a new Ubuntu cloud image,
change its pin lines in `build-linux.sh` (`IMAGE_RELEASE=` and
`IMAGE_SHA256=`) and build it again with `./build.sh linux 9106 --replace`.

## Remove

1. In BB, release the backend's boxes, turn the backend off and remove it on
   BB Box's settings page.
2. On the host, delete the templates:
   `qm set <vmid> --protection 0 && qm destroy <vmid>`.
3. Delete the ISOs if nothing else uses them.

The host's Proxmox LXC parts stay until you remove that backend too.

## When it goes wrong

- **INACCESSIBLE_BOOT_DEVICE on the console, in a restart loop:** Windows did
  not get the VirtIO SCSI driver. Build with `--sata`.
- **Setup stops on a screen:** the ISO is not English (United States), or the
  edition is not on it. Check `BBBOX_WINDOWS_EDITION`.
- **A box has no address:** it reads its address at each boot, from the
  SMBIOS serial bb-box gives it, and logs to `C:\bb-box\boot.log`.
- **Anything else in a build:** run it again with `--keep`, and look at the
  build VM's console and `C:\bb-box\firstlogon.log` in it:
  `qm guest exec <vmid> -- powershell -Command "Get-Content C:\bb-box\firstlogon.log"`.
  A failed build also leaves a picture of its console in `/var/tmp`, named
  after the build VM.

## What a box has

- Windows 11, not generalized: every box is a linked clone of the same
  installed Windows, so machine SIDs repeat, which matters only in a domain.
  The time zone and the VM's clock are UTC.
- User `box`, an administrator, logged on to the console automatically, with
  no lock screen, sleep, screen saver or UAC prompt. Its password is random
  per build and kept nowhere else.
- OpenSSH Server with PowerShell 7 as its shell, bb-box's key, and its
  firewall rule open on every network profile. SSH sessions are elevated.
- UTF-8 as the system code page.
- The VirtIO drivers and the QEMU guest agent.
- Cua Driver, started at logon in the desktop session.
- Browsers that show their whole page to Cua.
- Build tools, pinned in `build.sh`: Visual Studio Build Tools (MSVC and the
  Windows SDK), LLVM (`clang`, and libclang for `bindgen`), and Rust through
  rustup with the stable MSVC toolchain. Every new shell, SSH's included,
  finds `cargo`, `rustc` and `clang`. They take about 12 GB, and a box keeps
  about 28 GB free. DirectX apps run on WARP, Windows' software renderer, as a
  box has no GPU.
- No Windows Update, no BitLocker device encryption, and no hibernation
  inside the guest: Proxmox hibernates boxes from outside.
