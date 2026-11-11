# Windows snapshots on Tart copy a disk Windows shut down

Status: accepted
Date: 11 November 2026

## Context

A Windows desktop on arm64 runs on a Mac in QEMU, inside the Tart backend
([046](046-windows-on-a-mac-runs-in-qemu-in-the-tart-backend.md)). Its VM is a folder of QEMU's: `disk.qcow2`,
an overlay on a versioned build of the Windows image, `vars.fd`, its UEFI
variables, and `config`. An ordinary Stop saves QEMU's memory to `state`
beside them, and a start loads `state` whenever it is there.

Tart's macOS and Linux snapshots ([070](070-snapshots.md)) are APFS clones
of a VM's folder, beside Tart's `vms` folder, with a label, a task journal
and a two-rename swap for restores. A macOS snapshot holds memory; a Linux
one is taken only while the VM is stopped.

A Windows disk copied under saved memory, or while Windows runs, is not as
Windows leaves it: booted afresh, it is as after a power cut. Windows has no
identity reset in bb-box, so a copy must never come up beside its source.

## Decision

- A Windows box on Tart offers snapshots of its disk only: stopped only,
  restored in place with a snapshot as the undo, no fork, and Keep refused.
  `outlivesGuest` is true, as its copies live beside the VMs.
- A snapshot clones three files of the VM's folder, `disk.qcow2`, `vars.fd`
  and `config`, into the same `bb-box-snapshots` folder Tart's use, by the
  same `clonefile` copy, label, room check and journal. Never `state`, the
  pid file, QEMU's output or its sockets.
- bb-box copies only once Windows has shut down. A take of a running box
  asks Windows to shut down, over SSH, and presses QEMU's ACPI power button
  when that cannot be sent, copies, and boots Windows afresh. A box whose
  memory an ordinary Stop saved starts from it, shuts down, and is copied;
  it stays stopped. Windows that does not shut down within the shutdown wait
  is not copied. A restore's stop is the same shutdown, so its undo is whole.
- A restore swaps in the snapshot's three files, keeps the VM's ports, and
  leaves no `state`, so the next start boots Windows from the restored disk
  and never resumes stale memory.
- A snapshot's label names the image and build its overlay stands on. An
  image refresh, and the removal of a refresh's build, keep every build that
  a VM, a snapshot, or a restore cut short stands on: they read the `config`
  of each VM, of each snapshot, and of both folders a restore stages, the
  snapshot's copy and the VM's own folder set aside. A restore swaps those
  folders, and a recovery puts them right, only while it holds the image's
  builds, and pruning holds them too, so a folder is never between two
  places while pruning reads them. The hold is a link naming the shell that
  holds it, and one whose shell has ended is cleared.
- A restore checks, while it holds the builds, that its copy's build is
  there. A recovery that finds the build of the disk it would put in place
  gone puts the VM's own folder back, or, with none to put back, records the
  restore as failed and says why. It never records it as done, and a start
  of a VM whose build is gone is refused and says so.

## Consequences

- A take of a running Windows box closes its apps and takes about as long
  as a shutdown and a boot; its plan says it pauses the box.
- A take of a stopped Windows box closes the apps its saved memory held.
- Restores after a restart of bb-box are put right from the same journal as
  a macOS VM's, by `heal_rollback` given the QEMU VM's folder.
- Forks and Keep wait for a Windows identity reset.
- An old build of the Windows image stays on the Mac while a snapshot
  stands on it, which can be until the box is released, so a refresh frees
  less disk while old snapshots remain. Deleting the snapshots frees it at
  the next refresh.
