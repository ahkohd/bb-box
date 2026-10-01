# 039: Windows desktops are clones of a template that is not generalized

Status: accepted, 1 October 2026. Partly supersedes
[015](015-computer-use-through-cua-driver.md): Cua's daemon on Windows
runs elevated. Extends [021](021-desktop-resize-through-the-backend.md),
[028](028-a-box-size-is-chosen-when-it-is-made.md) and
[030](030-a-mac-runs-desktop-commands-through-launchctl-asuser.md).

## Context

[Later backends](../research/later-backends.md#proxmox-qemu-for-windows-virtual-next)
planned `windows-desktop` on Proxmox QEMU: a sysprepped template,
Cloudbase-Init for the address and key, and a helper of bb-box's own in
the desktop session for windows and computer use. A spike (#46) built
Windows 11 Pro with no clicks and measured it:

| Way to start a box | SSH | Desktop with Cua |
| --- | --- | --- |
| A hibernated warm VM, resumed | 2.7 s | 4.3 s |
| A linked clone of a template that is not generalized | 15 to 31 s | about 20 s |
| A linked clone of a sysprepped template | 76 s | not within 20 min |

It also found that:

- after a resume the guest clock is behind by the time the VM was off,
  and Windows does not correct it within 30 s;
- Windows' VirtIO GPU driver ignores the viewer's resize, but a mode set
  in the desktop session takes about 1.3 s, and the stream follows;
- SSH sessions are elevated, and Cua's daemon drops a client at another
  integrity level, so it must run elevated too;
- Edge shows Cua only its toolbar unless it starts with
  `--force-renderer-accessibility`;
- the `cert` in Proxmox's `vncproxy` answer is not the certificate the
  API serves, so pinning it fails;
- a one-off scheduled task with an interactive logon runs a command in
  the desktop session in about 1 s.

## Decision

- **Template.** The setup script builds it from the operator's Windows 11
  ISO and the virtio-win ISO, with an answer file and a first-logon
  script, and no sysprep:
  - the VirtIO SCSI driver through `DriverPaths`, and BitLocker's
    automatic encryption off (`PreventDeviceEncryption`);
  - OpenSSH with PowerShell 7 as its shell, the system code page UTF-8,
    bb-box's key in `administrators_authorized_keys`, and the firewall
    rule for any network profile;
  - the guest agent, automatic logon as `box`, no lock screen, screen
    saver or sleep, and UAC elevating without a prompt;
  - Windows Update not installing or restarting by itself. A box lives
    hours, not months; the template is rebuilt to update it.
- **Clones.** A box is a linked clone of the template. Every box has the
  template's machine SID, SSH host key and computer name. None of them
  matters outside a domain, and renaming the computer needs a restart, so
  `relabel` renames the VM in Proxmox only.
- **Address.** The backend picks a static address on the boxes' bridge,
  as for LXC, and writes it in the VM's SMBIOS serial (`base64=1`, since
  Proxmox takes only base64 there). A startup task reads it early in
  boot and sets it. No Cloudbase-Init.
- **Warm pool.** Warm VMs are hibernated (`qm suspend --todisk 1`), at the
  kind's default size. A hibernated VM holds no memory, but holds its
  memory size on disk. A claim resumes one, and the backend sets the
  guest's clock over SSH before the box is ready. `stop` hibernates too,
  and `start` resumes and sets the clock, as Tart's `stop` suspends.
  Running warm VMs are an option where memory is plentiful. Warm and
  filling VMs stay out of `held()`, as on Proxmox LXC.
- **Commands.** OpenSSH, transport `ssh`, shell `powershell`, `admin`
  true, `streaming` true, `inDesktopSession` false. Files over SFTP. The
  guest agent is used for readiness only.
- **Desktop commands.** Core runs `session: "desktop"` on Windows as a
  one-off scheduled task for `box` with an interactive logon, made and
  started over SSH and deleted after. Output comes back through files at
  exit, with stderr redirected by the process.
- **Desktop.** Proxmox's console through `vncproxy` and `vncwebsocket`.
  The route pins the certificate the API serves, which the backend's
  Proxmox client already trusts. The display is `resizable`: the
  backend's `resize()` sets the mode in the desktop session through the
  same kind of task. The setup's role gains VM.Console, for the user and
  its token.
- **Computer use.** Cua Driver's Windows x86_64 build, pinned, on
  `\\.\pipe\cua-driver`. A task at logon starts its daemon elevated
  (highest run level) through `conhost.exe --headless`, so no console
  window shows. The apps it opens still run unelevated. Edge starts with
  `--force-renderer-accessibility`, as Chrome does in the Linux template,
  so Cua reads its pages.
- **Enrolment.** `enrol` is false until BB's host app runs on Windows
  ([BB request 1](../bb-requests.md#1-bbs-host-app-on-windows)).
- **Kind.** `windows-desktop`: Windows, x86_64, no GPU, one RFB display,
  Cua. Its presets are the Linux desktops': `small` 4 cores and 8 GiB,
  `medium` 8 and 16, `large` 16 and 32, with the template's disk.
  `readyTimeoutMs` is 3 minutes.

## Consequences

- A Windows desktop opens in about 4 s from the warm pool, and about 20 s
  without one. The agent drives it with the same seven computer tools.
- Each box needs a Windows licence. An unactivated or evaluation copy is
  enough to try it. bb-box never ships a Windows image.
- A box of another size is a cold clone, since a hibernated VM keeps its
  memory size.
- Until they enrol, Windows boxes get no Git credentials or machine
  variables from BB and no child threads, and they are not offered as a
  new box or as your machines
  ([033](033-a-thread-can-start-on-a-new-box.md),
  [036](036-your-machines-are-boxes-you-own.md)).
- The terminal is PowerShell through OpenSSH's ConPTY
  ([035](035-a-terminal-has-its-pty-on-bbs-server.md)); its resize is
  checked on the first box.
- Microsoft supports only sysprepped images. If a domain or a duplicate
  SID ever matters, a sysprepped template is the fallback, with minutes
  to the first desktop.
