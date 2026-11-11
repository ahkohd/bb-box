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
  snapshot's copy and the VM's own folder set aside. A folder with a disk
  whose `config` cannot be read, or does not name both an image and a
  build, makes the scan unsure, and an unsure scan removes no build and
  says why.
- Restores, recoveries, image refreshes, removals of a build and the making
  of a VM's overlay take turns on the Mac. They can come from more than one
  process: from the scripts of several BB Box installs that share the Mac,
  and from a recovery any of them starts. So the turn is a lock on the Mac,
  `~/.bb-box/turn.lock`, held with `flock` through the shell's own file
  descriptor. The kernel lets one holder have it at a time and frees it when
  the last process holding the descriptor ends, the shell's children
  included, so no lock is ever cleared by hand. A task tries for its turn
  600 times, 0.1 s apart, then refuses and says to try again: about 60 s on
  Linux and 66 s on a macOS 27 VM, where each pause runs a little long. One
  that cannot open the lock refuses at once.
- The shell opens the lock with a plain `exec 9>>`, once a subshell has
  shown that the file opens. `command exec` would keep a failed open from
  ending the script, but macOS's `/bin/sh`, bash 3.2.57, crashes or spins
  after `command exec` opens a descriptor in a function: when a calling
  function returns, or when the script exits.
- The operator's `prepare-windows-image.sh` takes the same turn to publish
  its build: it moves the build into place, points `rollback` at the build
  that was current and `current` at the new one, all in its turn. It waits
  up to 10 minutes for the turn, saying so, as it has an hour's work to
  keep.
- An image refresh prunes only published builds that are neither current
  nor the rollback, have no owner file, and that nothing stands on. A build
  with an owner file awaits its install's promotion, whichever install that
  is, and a folder ending `.new` is a build still being made, by the
  operator's script or a refresh's capture. Neither is ever pruned.
- A refresh's build that is never promoted goes through its own install
  alone: the refresh removes what it made when it fails, and that install's
  next images run removes builds of its own that a run left, while none of
  its runs is going. Both remove through the build's removal, which checks
  the owner and the build's use in its turn. A build of an install that never
  runs again stays until it is removed by hand.
- An image refresh takes its turn before it reads which build is current,
  and keeps it through the promotion and the pruning. A removal checks the
  build's owner, that it is not current and that nothing stands on it in
  its turn. A restore holds its turn from the check of its copy's build to
  its record of the result. A recovery reads the restore's record again in
  its turn, and leaves a record that another has finished. A new VM names
  its build in its `config` in its turn, before it makes its overlay.
- A restore checks, in its turn, that its copy's build is there. A recovery that finds the build of the disk it would put in place
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
  the next refresh, once no VM or staged restore stands on it either, and it
  is neither the current build nor the rollback.
- A scan that cannot read a VM's or snapshot's `config` keeps every build
  until it can, so a damaged folder can hold disk until it is fixed or
  removed.
- Tasks on one Mac wait for each other's turns: a refresh's pruning, a
  restore's swap, a recovery, a new VM's overlay, an operator's publication.
  The wait is bounded, the turn is not: it lasts as long as its work, often
  seconds and longer when a prune deletes large builds, and a child process
  that outlives its script keeps the turn until it ends. A task refused
  after its wait changes nothing and can be tried again once the other has
  ended.
- A crash or power cut part way through an operator's build or a refresh's
  capture leaves a folder ending `.new`, which no refresh removes.
