# Proxmox QEMU: the Windows template

`build.sh` builds the template that `windows-desktop` boxes are cloned from:
Windows 11 in a QEMU VM on your Proxmox host, installed unattended from your
own ISO. A box is a linked clone of it, which starts in about 20 s, or less
than 5 s when the warm pool keeps it hibernated.

It uses the same host settings, bridge, pool and SSH key as the Proxmox LXC
backend, so set that up first ([../proxmox-lxc/README.md](../proxmox-lxc/README.md)).

| Path | What it does |
| --- | --- |
| `build.sh` | Builds and checks the template, on the Proxmox host as root |
| `answer/autounattend.xml` | The answer file: disk, edition, user `box`, no setup screens |
| `answer/bb-box/firstlogon.ps1` | Runs once at the first logon and sets the VM up |
| `answer/bb-box/boot.ps1` | Gives each box its address at boot, from its SMBIOS serial |
| `answer/bb-box/logon.ps1` | Turns on browsers' full accessibility tree at each logon |
| `check.ps1` | Checks a clone of the new template over SSH |

## What you need

- **A Windows 11 x64 ISO, English (United States).** Download it from
  Microsoft (<https://www.microsoft.com/software-download/windows11>, "Download
  Windows 11 Disk Image"), or use the 90-day Enterprise evaluation. Put it in
  an ISO storage on the host, by default as `local:iso/win11.iso`
  (`/var/lib/vz/template/iso/win11.iso`).
- **The virtio-win drivers**, as `local:iso/virtio-win.iso`:

      wget -O /var/lib/vz/template/iso/virtio-win.iso \
        https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso

- **A licence for each box.** By default the template installs Windows 11 Pro
  with Microsoft's generic install key, which installs without activating:
  Windows works, with a watermark and some personalisation settings locked.
  Set `BBBOX_WINDOWS_KEY` to your own key, or `BBBOX_WINDOWS_EDITION` to the
  edition your ISO and key are for. bb-box never ships Windows images.
- About 25 GiB free on the box storage, and internet access from the box
  bridge: the first logon downloads OpenSSH from Windows Update, PowerShell 7
  and Cua Driver.

## Build it

    ./build.sh windows 9804

It takes about 45 minutes, most of it Windows Setup. The VM's console in the
Proxmox UI shows how far it is. At the end it clones the new template, starts
the clone at `BBBOX_BUILD_ADDRESS`, and runs `check.ps1` in it over SSH with
the plugin's key, as the backend will:

    ok    PowerShell 7 over SSH              7.6.6
    ok    UTF-8 code page                    ACP 65001, output utf-8
    ok    SSH session elevated               box, elevated
    ...
    ok    Edge page in the accessibility tree  3744 elements in 371 ms

To build it again, for example for a newer ISO, add `--replace`. The new
template is built and checked in another VM and only then takes the old one's
place. Boxes cloned from the old one keep running on LVM-thin.

## What the template has

- Windows 11, not generalized: every box is a linked clone of the same
  installed Windows. Machine SIDs repeat, which matters only in a domain.
  Computer name `bb-box-win`, time zone UTC.
- User `box`, an administrator, logged on automatically into the console
  session, with no lock screen, sleep, screen saver or UAC prompt. Its
  password is random per build and kept nowhere else.
- OpenSSH Server with PowerShell 7 as its shell, the plugin's key in
  `C:\ProgramData\ssh\administrators_authorized_keys`, and its firewall rule
  open on every network profile. SSH sessions are elevated.
- UTF-8 as the system code page.
- The VirtIO drivers and the QEMU guest agent.
- Cua Driver, started at logon in the desktop session, elevated and with no
  console window. Its pipe is `\\.\pipe\cua-driver`.
- Browsers expose their whole page to Cua: at logon the screen-reader flag is
  set, Edge does not keep running in the background, and its link handler
  passes `--force-renderer-accessibility`.
- No Windows Update, no BitLocker device encryption, no hibernation inside
  the guest (Proxmox hibernates boxes from outside).

## How a box gets its address

The backend sets each box's SMBIOS serial to its address with its prefix,
then the gateway, base64 encoded since Proxmox takes only base64 characters
there:

    qm set <box> --smbios1 "base64=1,uuid=<new>,serial=$(printf '10.78.0.12/24 10.78.0.1' | base64)"

At each boot `boot.ps1` reads it and sets the address, with the DNS servers of
the build. It logs to `C:\bb-box\boot.log`. A VM with no such serial stays on
DHCP.

## When the build fails

- **INACCESSIBLE_BOOT_DEVICE on the console in a restart loop:** Windows did
  not get the VirtIO SCSI driver. Build with `--sata`.
- **Setup stops on a screen:** the ISO is not English (United States), or the
  edition is not on it. Check `BBBOX_WINDOWS_EDITION`.
- **Anything else:** run again with `--keep`, and look at the build VM's
  console and `C:\bb-box\firstlogon.log` in it (`qm guest exec <vmid> --
  powershell -Command "Get-Content C:\bb-box\firstlogon.log"`). A failed build
  also leaves its console as `/var/tmp/bb-box-windows-<vmid>.ppm`.
