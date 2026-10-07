# 054: Windows images are refreshed in a box of the current build

Status: accepted, 7 October 2026. Extends
[049](049-a-project-image-is-a-script-on-the-standard-image-and-images-are-rebuilt-when-stale.md)
to Windows (#450). Keeps [039](039-windows-desktops-are-clones-of-a-template-that-is-not-generalized.md):
the image is not generalized.

## Context

049's refresh rebuilds the standard Linux images and checks each build
before it replaces the current one. Windows was left out. The Proxmox QEMU
template (`setup/proxmox-qemu/build.sh`, about 50 minutes) and Tart's
Windows image (`setup/tart/prepare-windows-image.sh`, about 30 minutes)
are built only by hand, from a Windows ISO, by someone with root on the
Proxmox host or a login on the Mac.

There were two ways to bring them in:

- **A. Refresh in a box.** Start a box of the current build, run a
  script in it that installs Windows' updates and the pinned tools, then
  capture the box as the new build. No ISO and no root on the host: the
  backend's own API, or the Mac's QEMU, does each step.
- **B. Build from the ISO, unattended.** Run the build scripts from the
  plugin. That needs the ISO on each host, root on the Proxmox host, and
  about an hour of a host's time a month.

## Decision

**A: a Windows image is refreshed in a box of its current build**, as
049 refreshes a Linux image, monthly, with the same checks before it
replaces the current build.

- `setup/windows/refresh.ps1` runs in the box as `box`, an elevated
  administrator, over SSH. It installs the updates Windows Update offers,
  but not drivers, and each tool in `setup/windows/pins.json` whose
  installed version is not its pin. Edge updates itself meanwhile, and its
  update drops the flag that puts a page in the accessibility tree, so the
  script gives it again, as the first logon does. It then writes the new
  image record, `C:\bb-box\image.json`, with the new build ID, and removes
  what the refresh left: its files, temporary files and the update
  downloads.
- When an update needs a restart, the script exits 3010. The refresh
  restarts the box, waits for it to answer, and runs the script again,
  up to 5 times.
- `setup/windows/pins.json` pins each tool for x86_64 and arm64, with its
  URL and SHA-256: the build scripts' pins, which a test keeps equal. Both
  add Node.js (#539), which BB's installer for Windows needs. The record's
  pins digest stays the build script's, so the doctor judges a refreshed
  build as it judges one from the ISO.
- There is no sysprep: a box of the new build is the old one's clone,
  with its updates, as 039 has it. The capture shuts the box down.
- The trial box runs `setup/windows/check.ps1`, the template's check,
  which prints `ok` or `FAIL` for each check. A backend may give its own.
- The refresh does not follow upstream versions for Windows: the pins move
  with bb-box's releases. Windows' updates are what change each month.

A fresh install from the ISO stays a manual step, with the build scripts,
for a new Windows release or a broken image.

## Consequences

- Each backend with Windows boxes gives `BackendImages` for its Windows
  kind: Proxmox QEMU through its API, Tart through QEMU on the Mac.
- A refreshed image is a clone of a clone. Each month's build carries the
  last one's history, and its disk grows by what the updates leave. A
  fresh install from the ISO starts that over.
- The pins in `setup/windows/pins.json` and in the build scripts must
  agree until the build scripts read `pins.json` themselves.
