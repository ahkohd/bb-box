# 046: Windows on a Mac runs in QEMU, in the Tart backend

Status: accepted, 1 October 2026. Extends
[039](039-windows-desktops-are-clones-of-a-template-that-is-not-generalized.md):
the same Windows guest, built for arm64 and run by QEMU on a Mac; and
[040](040-linux-on-arm64-has-kinds-of-its-own.md): its kind is
`windows-arm64-desktop`, by 040's rule. Amended while it was built: the
image's C: is not its disk's last partition, as Windows Setup puts WinRE in
a partition after it, so extending C: first moves WinRE onto C: (#341).

## Context

#150 ran Windows 11 on Arm in QEMU 11.1.1 with Apple's Hypervisor
framework (HVF), on a Mac with Apple silicon and macOS 27. Apple's
Virtualization framework, and so Tart, cannot run Windows.

| Step | Measured |
| --- | --- |
| Unattended install from the ISO, with the first-logon setup | 16 min |
| The base image | qcow2, 14.9 GiB used of 64 GiB |
| A clone: a qcow2 overlay on the base | 50 ms |
| A clone's first boot, to SSH and to the desktop with Cua | 13 s and 14 s; two at once, 14 s and 14.5 s |
| A save, with the guest stopped first and QEMU's bandwidth cap lifted | 0.93 s, to a 3.0 GB file a minute after boot |
| A restore, to running and then to SSH | 0.90 s after launch, then 31 ms |
| Host memory of a 6 GiB VM | 6.7 to 7.3 GB idle, 8.4 GB after a restore |
| Cua over SSH: window state with tree and screenshot; typing 35 characters | 356 ms; 364 ms |
| A resize through a task in the desktop session | 1.1 s, to a listed mode only |

It also found what does not work:

- QEMU started with `-daemonize` aborts while it saves: the forked process
  trips macOS's fork safety check, and the state file is cut short.
- A live save takes 81 s at QEMU's default bandwidth cap, and the restored
  guest then spends a while at 400% CPU and 12 GB.
- `mapped-ram` restores a frozen guest under HVF.
- The VirtIO GPU driver takes a viewer's size only at its next boot, and
  Windows sets only a fixed list of modes, without the 1280x800 it boots
  at.
- After a pause or a save, the guest's clock is behind by the time it was
  stopped. QEMU's real-time clock is UTC.
- Cua's daemon drops a client at another integrity level (os error 233).
  #150 used a standard user, with the daemon at medium integrity.

Where it runs: the Macs already serve Tart's boxes.

| Option | For | Against |
| --- | --- | --- |
| A second VM engine in the Tart backend | one list of Macs, one host user, one key and one doctor; one survey of each Mac and one placement at a time, so two boxes never count the same memory; owner files, warm VMs and the route through the Mac reused | most methods branch by engine; the backend's type and label still say Tart |
| A backend of its own on the same Macs | its code apart | each Mac, user and host key entered twice; each backend counts only its own VMs, so on one Mac both promise the same memory and disk, and two warm pools fill one disk |
| An app such as Parallels Desktop or UTM | packaged; Microsoft supports Windows 11 on Apple silicon in Parallels | an app to install on the Mac, with a licence for Parallels; scripting each is new work |

The kind: by 040's rule it is `windows-arm64-desktop`. Unlike Linux,
Windows on Arm runs most x64 apps through its emulation, so arm64 offers
of `windows-desktop` would often work. But emulated apps are slower, x64
drivers and kernel-mode software do not run, and what an agent builds
there is arm64 by default. An agent asking for `windows-desktop` should
not get one by surprise when the Proxmox host is full.

## Decision

**The Tart backend runs Windows boxes with QEMU.**

- One backend, type `tart`, with two engines: Tart for the macOS and
  Linux kinds, QEMU with HVF for Windows. Its ID, label, hosts and fields
  stay, so stored boxes, configurations and `on` keep working.
- One new field, `windows-image`: the image `windows-arm64-desktop` boxes
  are cloned from, such as `bb-box-windows`. Empty, the default, turns
  them off.
- `tart` is needed only while a Tart kind has an image, and QEMU only
  while `windows-image` is set, so a Mac can serve Windows boxes alone.
- The QEMU engine's Mac scripts are a module beside `host.ts`. The Windows
  guest's code moves out of the Proxmox QEMU backend to be shared, not
  copied: the desktop command, the display mode, the clock, the desktop
  check and Cua's pipe.

**The kind.** `windows-arm64-desktop`: Windows, arm64, no GPU, one RFB
display, Cua, `enrol` false, and commands as 039: OpenSSH with
PowerShell 7, elevated. Its presets are `windows-desktop`'s, so `small`
is 4 cores and 8 GiB. `readyTimeoutMs` is 3 minutes. Its description says
that x64 apps run under Windows' emulation, more slowly, and x64 drivers
do not. The panel shows the arm64 badge (040).

**QEMU.**

- bb-box runs the `qemu-system-aarch64` and `qemu-img` on the host user's
  PATH, looked for where `tart` is. 11.1 is the version tested; check a
  newer one with the conformance suite before relying on it.
- A VM runs as below. `<VM>` is its directory, and `<share>` is QEMU's
  own, beside its binary, which has the UEFI firmware.

  ```sh
  qemu-system-aarch64 -name bb-box-<box ID> -machine virt -accel hvf -cpu host \
    -smp <cores> -m <memory> \
    -drive if=pflash,format=raw,readonly=on,file=<share>/edk2-aarch64-code.fd \
    -drive if=pflash,format=raw,file=<VM>/vars.fd \
    -device qemu-xhci -device usb-kbd -device usb-tablet \
    -drive if=none,id=disk,file=<VM>/disk.qcow2,discard=unmap -device virtio-blk-pci,drive=disk \
    -netdev user,id=net,hostfwd=tcp:127.0.0.1:<SSH port>-:22 -device virtio-net-pci,netdev=net \
    -device virtio-gpu-pci -display none -vnc 127.0.0.1:<display> \
    -qmp unix:<VM>/qmp,server=on,wait=off -pidfile <VM>/pid
  ```

- It starts with `nohup`, detached from the SSH session as `tart run` is,
  never with `-daemonize`, and bb-box waits for its QMP socket. Scripts on
  the Mac drive it over QMP.
- User-mode networking: the guest reaches out through the Mac, and only
  the Mac reaches the guest, through the forwarded port. QEMU's vmnet
  networks would need root or a helper installed on the Mac.
- No TPM: the install skips Windows 11's TPM and Secure Boot checks, as
  #150's did, so no TPM emulator is installed.
- Each VM has two ports on the Mac's loopback, for SSH and VNC, chosen
  free when it is made and kept with it.

**The image.** `setup/tart/prepare-windows-image.sh` runs on each Mac as
the host user, as `prepare-image.sh` does.

- It installs from your Windows 11 Arm64 ISO, English (United States),
  with Microsoft's generic key unless you give another, and the
  virtio-win drivers, which it downloads for the build and deletes after.
- The guest's setup is the Proxmox template's answer file and first-logon
  scripts, for arm64 and with arm64 pins, as `prepare-linux-image.sh` runs
  the LXC template's scripts. So `box` is an administrator whose SSH
  session is elevated, and a logon task starts Cua's daemon at the highest
  run level through `conhost.exe --headless`, at the same level (039).
  #150's standard user is not needed: its error 233 came from the daemon
  and the client being at different levels.
- Beyond the Proxmox template:
  - `RealTimeIsUniversal=1`, so the clock stays right if a box's time
    zone changes;
  - Windows' time service syncs every 15 min, for a Mac that slept;
  - #150's install fixes: keys sent early for "Press any key", drivers
    through `DriverPaths` only, and no trim;
  - no address from the SMBIOS serial, and no guest agent.
- It checks a clone as `build.sh` does: `check.ps1` over SSH, a save and a
  restore, then SSH and Cua again. It leaves a build directory under
  `~/.bb-box/qemu/images/bb-box-windows/` with `disk.qcow2`, read-only,
  and `vars.fd`.
- It takes about 16 min and about 25 GiB of disk beyond the backend's disk
  reserve, and stops rather than leave less than the reserve free.
- `--replace` makes a new build directory. Boxes keep the old one.

**Clones.**

- A box's VM is `bb-box-<box ID>`: a directory under `~/.bb-box/qemu/vms/`
  with a qcow2 overlay on the image's disk, made in 50 ms, and the image's
  UEFI variables, copied as an APFS clone (`cp -c`).
- An overlay needs its base. An old build is deleted only when no VM's
  overlay uses it, and nothing runs the base itself.
- A box can have a larger disk than the image's: its overlay gets that
  size, and the box extends C: as on Proxmox. Windows 11 26H2 Setup puts
  WinRE in a recovery partition of about 0.9 GiB after C:, on both
  backends' images, so the extend first moves WinRE onto C:
  (`C:\Recovery`) and removes that partition (#341).

**Stop, start and warm VMs.**

- `stop` saves the VM: QMP `stop`, `migrate-set-parameters` with
  `max-bandwidth` 107374182400, `migrate` to `file:<VM>/state`, then
  `quit`. `start` runs QEMU again with `-incoming defer`, then
  `migrate-incoming` and `cont`, and deletes the state file, which no
  longer matches the disk. Never a live save, and never `mapped-ram`.
- After every restore, bb-box sets the guest's clock over SSH, as 039
  does on Proxmox.
- A state that does not restore, as after an update of QEMU or macOS, is
  dropped, and the VM boots from its disk, as Tart's do. So does a VM that
  a restart of the Mac ended.
- Warm VMs are filled as Tart's are: a clone booted to the desktop with
  Cua up, then saved. Its owner file says `filling`, then `warm`, and
  names the image's build, QEMU's version and the Mac's macOS build. A
  change of any of them, or of the kind's default size, retires it. A
  claim restores it: running in about 1 s, then the clock is set.
- The kind's warm count is 0 by default.

**The desktop.**

- QEMU's VNC server, reached through the Mac as Tart's is, with
  `ssh -W 127.0.0.1:<port>`. It listens on the Mac's loopback only,
  unlike Tart's, so it has no password.
- The display is `resizable` through the backend
  ([021](021-desktop-resize-through-the-backend.md)): `resize()` sets the
  listed mode that best covers the viewer, through a desktop command, as
  039 does, and the viewer scales the rest. It goes straight to the list,
  without the 2 s of tries at the exact size that Proxmox makes, as the
  driver takes that size only at its next boot. The smallest is 800x600.

**Capacity.**

- One survey of each Mac lists Tart's VMs and bb-box's QEMU VMs.
- A running Windows VM counts its memory plus 2 GiB, from #150's 8.4 GB
  for 6 GiB, so a `small` box takes 10 GiB of the Mac's memory. A saved
  or warm one takes none, and holds its overlay and state on disk.
- Windows VMs do not count against the Mac's two macOS VMs, as Linux VMs
  do not.
- The backend's memory and disk reserves cover all three systems. There
  is no count of Windows VMs: memory limits them. A count per Mac can
  come later if a Mac with many gets slow.

**Ownership.** An owner file per VM, as Tart's, in the same directory,
naming the engine. It is written before the VM's directory and removed
after it. `held()`, warm VMs and another install's VMs work as for Tart's.

**On a Mac you also use.**

- bb-box installs nothing there: no package, root, launchd job, TPM
  emulator or network helper. It uses the QEMU you have.
- Everything it writes is under the host user's `~/.bb-box`, and every VM,
  image, directory and process it names starts `bb-box-`.
- Set the disk reserve to what you keep free, such as 60 GiB.
- QEMU runs with `-display none`, so nothing shows on the Mac's screen.
  Core checks that no Dock icon shows when the host user is the one
  logged in.
- As for Tart, the Mac must stay awake while boxes run.

**Doctor.** For each Mac, when `windows-image` is set: QEMU and its
version, HVF (`sysctl kern.hv_support`), QEMU's firmware, the image's
current build, and its base read-only.

## Consequences

- A Windows desktop on a Mac opens in about 14 s from a clone, and in
  about 2 s from a warm VM, against Proxmox's 30 s and 4 s.
- Windows boxes are arm64. x64 apps run under emulation, more slowly;
  x64 drivers and kernel-mode software do not. Whether WSL2 runs, which
  needs nested virtualisation, is not measured.
- A running `small` box takes about 10 GiB of the Mac's memory. A saved or
  warm one takes up to its memory size on disk, beside what it wrote.
- As in 039: each box needs a Windows licence, and bb-box never ships an
  image; Windows boxes do not enrol, so they get no Git credentials from
  BB, no child threads, and are not offered as a new box or as your
  machines. Microsoft does not support Windows 11 in plain QEMU on Apple
  silicon. It works, without Microsoft's support.
- An update of QEMU retires warm VMs, and a stopped box whose state does
  not restore boots from its disk, losing its open apps.
- A Windows box's provider shows as "Tart on" and the Mac's name.
- Tart's setup guide gains Windows, and the conformance suite runs the
  kind.
