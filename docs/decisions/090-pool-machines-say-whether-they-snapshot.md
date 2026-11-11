# 090: Pool machines say whether they snapshot

Status: accepted, 11 November 2026, with the owner's build order (see
Build order). Unit 1 is built: each machine reports whether it can
snapshot, and BB Box takes no pool snapshots yet.
Extends [070](070-snapshots.md), whose table says the SSH host pool takes
no snapshots, and follows [065](065-macs-say-what-they-offer-and-ios-streams-in-software-where-they-must.md)'s
pattern: each machine says what it offers, measured on the machine.

The measurements are in [090-spike/measurements.md](090-spike/measurements.md).
The prototypes are in [090-spike](090-spike/):

| File | What it is |
| --- | --- |
| `home-linux.sh` | Home snapshots on Linux: probe, make a box user with its home as a btrfs subvolume or ZFS dataset, take, list, restore with undo, fork, delete |
| `home-mac.sh`, `clone-tree.c` | Home snapshots on a Mac by `clonefile(2)`: probe, make a box user as the pool does, sign in, take, restore with undo, fork, delete |
| `snapshot-machine-lvm.sh` | A sample operator hook for machine snapshots, on an LVM thin volume |
| `machine-snapshot.sh` | The helper's side of the hook: runs it detached, keyed by operation, and recovers after a restart |
| `check-hook.sh` | A contract check for any hook, run through the helper |

They are spike code, not the helper's. `home-mac.sh` does not clear the
automatic login, pause the user for a take, or put back ACLs: the spike ran
those steps by hand, as the measurements show, and section 2 makes them
part of the design. `home-linux.sh`'s ZFS restore names its moved-aside
dataset by user only, so it serves one restore at a time.

## Context

A pool box is a user, `bbx-<generation>`, on a machine lent whole, or an
iOS slot user, `bbd-<n>`, on a Mac shared by slots. The user has no root,
except on Linux machines with a whole-machine reset, whose boxes get Docker
and sudo. The reset removes the user and every file it owns. So almost
everything a box without root can change is in its home folder.

070 left the pool out: "Never on a shared host to act on one slot: no
snapshot or restore of a whole Mac or Hetzner host stands in for one box's."
The owner and the lead asked whether a pool machine could still offer
snapshots, by one of 2 ways, without tying the design to one machine type
or cloud:

1. Built in, found by probing: box homes on a filesystem that clones or
   snapshots. Scope "home".
2. An operator-installed hook with a contract BB Box defines. Scope
   "machine".

A machine with neither is refused with the reason, as today.

## What the spike found

### Home snapshots work on all 3 filesystems, with different costs

| | macOS, APFS | Linux, btrfs | Linux, ZFS |
| --- | --- | --- | --- |
| How | `clonefile(2)` of the home folder | a read-only snapshot of the home's subvolume | `zfs snapshot` of the home's dataset |
| Machine set-up | none: every Mac qualifies | homes must be subvolumes, made so by the helper | homes must be datasets, made so by the helper |
| Take, 4 GiB and 20,000 files | 114 to 129 ms | 43 to 56 ms | 51 to 64 ms |
| Take, 220,000 files | 3.8 s, 49 MiB of metadata | 137 ms | not measured |
| Copy-on-write | yes: 4 to 6 MiB per take | yes: 6 takes 196 KiB | yes: 3 takes 108 KiB |
| One point in time | no: files are cloned one by one | yes | yes |
| Restore with undo | 1.7 to 2.6 s, or 6.2 s with a booted simulator to shut down, then 1.6 s to sign in | 0.6 s | 0.8 s by clone and promote |
| Fork into a new user | clone, then change of owner | clone, then change of owner | full copy by send and receive (12 s for 2 GiB) |
| Keeps ACLs | no: 0 of 15 | yes | yes |

### A restore must end every process of the user first

On btrfs, a swap under a running process succeeds and so does the delete of
the old home, but the process keeps its working folder in the deleted copy
and writes files it opens by path into the restored home. On a Mac, about
120 processes of a logged-in user keep files open in the old home: they
would go on writing their databases there, with their memory from after
the take.

On a Mac, ending the session is not enough: loginwindow signs the user back
in 2.6 s later while the automatic login still names it. So the restore
clears the automatic login, ends the session, swaps, then sets the
automatic login and restarts loginwindow, which signs the same user in in
1.6 s. A new user, as a fork is, needed a userspace restart (20 s), which
ends every SSH session on the Mac.

The login keychain comes back with the home: after the restore the sign-in
unlocked it, its items were as at the take, and an item added later was
gone. cfprefsd needs nothing more once the session has ended. Spotlight is
off on pool Macs (`setup-mac.sh` turns it off), so it is not a factor.
FileVault does not affect clones; the pool already needs it off for the
automatic login.

### A fork of a home keeps the user's own secrets and its source's paths

A fork's reset removes BB's machine files (`host-id`, `auth.json`,
`config.json`), the access file, BB's daemon unit or launch agent, and on a
Mac the login keychain and the keychain folder named by the Mac's hardware
UUID, which would not unlock for the new user. It keeps the user's SSH
keys, `gh` token and other files, as 070 says of every fork. No file named
the source user's GeneratedUID, but files name the source's home path:
`/Users/bbx-1` in Photos and CoreSpotlight plists, and on Linux any virtual
environment, shell history or tool that stores absolute paths. A fork's
home path is always new, as its user is new.

### What a home snapshot does not hold

- Memory and running processes: a restore ends them all.
- On a Mac: the user's temporary and cache folders in
  `/private/var/folders`, where Xcode keeps its module cache; launchd's
  list of the user's disabled services; per-user state of system daemons
  under `/private/var/db`, `/private/var/protected` and
  `/private/var/containers`; files the user left in `/Users/Shared`,
  `/private/tmp` and `/private/var/tmp`; the slot's simulator store in
  `/private/var/tmp/com.apple.CoreSimulator.SimDevice.<udid>`, which the
  helper seeds; the Mac's screen-capture approvals and other grants, which
  the helper makes as root.
- On Linux: `/tmp`, `/var/tmp` and `/dev/shm`; the user's crontab, at jobs,
  System V IPC objects and linger; transient systemd units.
- Anything outside the home that a box with root changed. So home
  snapshots are refused for boxes with root.
- The machine's own software: Xcode, Homebrew, system packages.

### Machine hooks work, if the contract makes them idempotent

The sample LVM thin hook passed all 25 checks of `check-hook.sh`: a take of
1.2 s with a 108 ms freeze, a restore of 0.6 s, and a restore killed after
each of its steps, or cut short by a machine restart, finished when asked
again. An earlier version froze the root filesystem when its volume was not
mounted, and the VM had to be released: an operator's hook runs as root and
can stop a machine, so the contract check runs before any hook goes live.

## Decision

### 1. Two scopes, each a machine's own offer

`SnapshotScope` gains `"home"` and `"machine"`:

- **home**: the box user's home folder and nothing else. Offered by a
  machine whose box homes clone or snapshot: APFS on a Mac, a btrfs
  subvolume or a ZFS dataset per home on Linux. Only for boxes without
  root.
- **machine**: the whole machine, by the operator's hook. Offered only on a
  machine lent whole, so it holds one box. Never on a Mac that lends iOS
  slots, nor while any other user of the pool is on the machine.

A box has at most one. Where a machine has both, a box without root gets
home snapshots, which are faster and need no hook, and a box with root gets
machine snapshots.

### 2. How home snapshots work

The helper gains `machine snapshot` commands, run as root through the same
sudo rule:

```
machine snapshot probe
machine snapshot take <generation> <snapshot>      stdin: install, box
machine snapshot list <generation>                 stdin: install, box
machine snapshot restore <generation> <snapshot> <undo> <operation>
machine snapshot delete <generation> <snapshot>
machine snapshot fork <snapshot> <user>            Macs lent whole only
machine snapshot hook <operation> <command> ...    runs the operator's hook, section 3
```

- Snapshots live in a folder only root can read, on the same volume as the
  homes: `/var/db/bb-box/home-snapshots/<user>/<snapshot>` on a Mac,
  `<homes>/.bb-box-snapshots/<user>/<snapshot>` on btrfs, `<dataset>@<snapshot>`
  on ZFS. Each is named by BB Box's snapshot ID.
- **Take.** On a Mac, the helper stops every process of the user
  (`SIGSTOP`), clones, and resumes them: one point in time, for a pause of
  about 0.3 s for 20,000 files and about 4 s for 220,000. `whileRunning`
  is `pauses`, and the plan says the pause from the file count. On btrfs
  and ZFS a snapshot is one point in time, so `live`. Then the helper reads
  and keeps the home's ACLs beside the clone (a walk of about 4 s for
  220,000 files), as `clonefile` drops them.
- **Restore,** after 070's guard and admission:
  1. On a Mac, clear the automatic login if it names the user.
  2. Shut down the user's simulators (`simctl shutdown all`), then end
     every process of the user, as the reset's `log_out` does.
  3. Take the undo, a snapshot of the stopped home.
  4. Move the home aside, put a writable clone of the target in its place,
     put back the ACLs kept at the take, and delete the old home.
  5. Clear the user's temporary and cache folders outside the home
     (`/private/var/folders/<xx>/<user>/T` and `C` on a Mac), which may
     not match the restored home.
  6. Start the user again: on a Mac, set the automatic login and restart
     loginwindow; on Linux, start `user@<uid>.service`, whose units come
     back from the home.
  7. 070's step 9 then sets the box straight: its access file and BB's
     machine.

  Each step is safe to run again. A restore cut short is finished by
  asking again with the same operation: a home missing with a moved-aside
  home present means step 4 had begun.
- **Fork.** Only on a Mac lent whole, where no other user shares the Mac.
  The helper makes a new box user, clones the snapshot as its home, changes
  the owner of what the source owned, and removes the source's identity
  (above). Macs that lend iOS slots take and restore, but do not fork until
  a new user can be signed in there without a userspace restart, which ends
  every SSH session on the Mac (see Build order).
- **Delete** removes the clone, the subvolume or the ZFS snapshot.
- **Release.** The reset deletes every snapshot of the user before it
  removes the user, and its "nothing left" check gains the snapshots
  folder. Today's reset would leave btrfs snapshots behind unnoticed:
  they survive `rm -rf`, and the check looks only at `/home/bbx-*`.
- **New homes on Linux.** The helper makes each new box home a subvolume or
  a dataset where the homes' filesystem allows. A box made before that has
  a plain folder, and its plan says why it takes no snapshots.

On ZFS, a restore to an older snapshot needs a clone and promote, which
moves the newer snapshots onto the replaced dataset. ZFS homes come after
btrfs, and restore the newest snapshot only until a unit designs that
chain, as 086 did for Proxmox.

### 3. The hook contract

An operator installs a program as `/usr/local/libexec/bb-box/snapshot-machine`,
as `setup.sh --snapshot-hook <path>`, beside `--reset-hook`. BB Box runs it
only through the helper, as root.

| Command | Prints, as JSON on stdout | Exit codes |
| --- | --- | --- |
| `describe` | `contract` (1), `scope` ("machine"), `holds` (["disk"]), `whileRunning`, `restore` ("in-place"), `restarts` (whether a restore restarts the machine), `lives` ("host" or "provider"), `keepsPastRelease` ("no"), `price` (070's `Price`, or null), `excludes` (words), `storage` (name, type, percent full) | 0 |
| `take <snapshot>` | `id`, `ref`, `state` ("complete"), `capturedAt`, `pausedMs`, `bytes` or null | 0 taken; 5 refused with nothing changed (room, limits); 1 failed with nothing kept |
| `list` | `snapshots`: `id`, `ref`, `state` ("complete", "in-progress" or "incomplete"), `takenAt`, `bytes` | 0 |
| `restore <snapshot> <operation>` | `id`, `operation`, `state` ("restored") | 0 restored; 4 no such snapshot; 1 failed, with the machine as it was |
| `delete <snapshot>` | `id`, `state` ("gone") | 0, also when it was gone already |

The words of every refusal or failure go to stderr. Snapshot IDs are BB
Box's own (`sn` and 12 letters and digits); operation IDs are `op` and 12.

**Every command is safe to run again with the same arguments.** A take of
a snapshot that exists answers as for the first. A restore with an
operation that finished answers that it is restored and changes nothing,
so a repeat after a crash is harmless; a new restore of the same snapshot
is a new operation. A delete of a snapshot that is gone succeeds.

**The hook labels what it makes** with the snapshot ID (an LVM tag, a ZFS
property, a cloud snapshot's label), so `list` survives the loss of any
file on the machine, and 070's sweep finds lost records.

**The disk says where it came from.** Before a take, the hook writes the
snapshot's ID into a file on the disk it snapshots, and removes it after.
After a restore that file names the snapshot, which proves the restore
landed even when the machine restarted and the hook's own files went back
in time. The hook then writes the operation's ID, by which a repeat knows
it is done.

**The helper runs the hook detached,** under its lock, as it runs
`reset-machine` today: `machine snapshot hook <operation> <command> ...`
records the boot ID, launches the hook with `setsid`, and answers exit 10
while it runs. BB Box asks again until it ends. If the hook died without an
exit status, or the machine restarted, the helper launches it again with
the same arguments, at most 3 times, then fails with its last words. A
hook that restarts the machine to restore touches `$BB_BOX_RESTARTING`
first, as `reset-machine` does. The helper refuses an operation ID reused
with other arguments.

**The take is the operator's to make consistent.** A hook that freezes a
filesystem must check it is a mount point first: a freeze of a plain
folder freezes the filesystem it is on, as happened in the spike.

**A cloud server.** On a Hetzner Cloud or DigitalOcean server the hook
calls its provider's API with a token the operator puts in a file only root
can read: take creates a snapshot of the server labelled with the ID and
answers exit 10 until the provider's action ends; list filters the
account's snapshots by that label; restore rebuilds the server from the
snapshot, which restarts it, so it touches `$BB_BOX_RESTARTING` and later
reads the provider's action and the disk's file to confirm; delete deletes
the snapshot. `lives` is "provider", and `price` is the provider's per GB a
month, which 070's ceiling then bounds. A box with root on that server can
read the token, so the operator gives the token access to that server's
project only. No cloud was called in the spike.

### 4. How the pool reports and proves it

- **A report per machine,** kept in the helper's state
  (`/var/lib/bb-box/snapshots`, or `/var/db/bb-box/snapshots` on a Mac)
  and in BB Box's storage, as 065 keeps a Mac's report: `home` and
  `machine`, each `Measured`: yes with how (APFS, btrfs, ZFS, or the
  hook's `describe`), no with why, or unknown. It also says the homes'
  folder, their filesystem and the free space there.
- **The probe** is `machine snapshot probe`, run as root through the same
  sudo rule. For home scope it finds the filesystem under the box homes,
  then proves it: on a Mac, a clone with `cp -c` in the helper's state
  folder, which is on the homes' volume, and that the helper has Full Disk
  Access, which a clone of a home's protected folders needs; on btrfs, a
  trial subvolume and a read-only snapshot of it, both deleted; on ZFS,
  the dataset mounted at the homes. For machine scope it runs the hook's
  `describe` with a 30 s limit (below). A trial and a hook cost more than a
  survey should, so the probe runs at enrolment (`setup.sh` and
  `setup-mac.sh` run it and print what it found) and in the doctor, and
  each `machine status` passes on the last report. BB Box keeps the
  newest report it has seen, so it can answer while the machine is away.
- **The probe finishes on time and leaves nothing behind**, as it runs on
  machines whose boxes and iOS slots are in use. The hook runs in a
  session of its own. At 30 s the helper sends that whole session TERM,
  then KILL 2 s later, and reports the hook as failed, whatever it exits
  with after. Trials go in a folder only root can use, one subfolder per
  probe named by its process ID: `<homes>/.bb-box-snapshot-trials` on
  btrfs and `/var/db/bb-box/snapshot-trials` on a Mac. The probe removes
  its trial after a failure and when it is stopped, then checks that
  nothing of it is left. A probe killed outright leaves its subfolder,
  and the next probe removes it once no process has that ID. A trial the
  probe cannot remove is reported as a failure that names each path left,
  and the doctor warns with what to remove.
- **BB Box's rules on top.** A machine whose boxes have root
  (`reset=machine`) offers no home snapshots, whatever its filesystem; a
  Mac that lends iOS slots offers no machine snapshots. The report keeps
  what the machine found, and the words say both.
- **The proof** runs before a machine's offer goes live, and again when
  the helper or hook changes: a take, a change, a restore and a delete on a
  scratch user, `bbbox-probe`, made and removed by the helper. It runs only
  while no box holds the machine, during the reset, before the generation
  moves on. For a hook, the proof is
  `check-hook.sh`'s checks on a scratch snapshot. A machine whose proof
  failed offers none, and says why.
- **The doctor** has a check per machine and one for the pool. Unit 1
  shows what each machine could offer: "Home snapshots: APFS clones
  available under /Users, 120 GiB free", "Home snapshots: none: ext4 under
  /home, which neither clones nor snapshots", "Machine snapshots: hook
  found: machine scope, LVM thin (vg0/thin, 12% full)", or "Machine
  snapshots: none: its snapshot hook's describe failed: <its words>". The
  pool's check counts them: "2 of 4 machines could offer home snapshots
  (build-2, mac-1)". Later units add the proof's results: "proved 11 Nov
  10:42: a take in 0.1 s, a restore in 2.4 s".
- **Kinds.** `snapshotting(kind)` is per kind, with no host call, so the
  pool gives an offer when any machine serving the kind has one, and words
  for how many: "Snapshots: on SSH host pool, on 1 of its 2 machines, of
  the box's home folder". A machine that cannot take them is named in
  box_status and in the plan: "This box's machine, a Linux server, has no
  snapshots: its box homes are on ext4."
- **The snapshot card** says what a home snapshot holds: "Holds amber-fox's
  home folder: its files, settings, keychain and simulators. Not apps
  installed on the Mac, not files outside the home, nothing running."
- **Refusals** say what to do next: "amber-fox's machine takes no
  snapshots: its box homes are not on a filesystem that snapshots. Ask for
  a box on a machine that does: box_list says which." Placement does not
  yet prefer machines that snapshot; an agent asks for one with `on`.

### 5. What the core needs

The core's model fits: a take, a restore with an undo taken after the stop,
070's operations, pins, room rule and the box log need no change in shape.
It needs:

1. `SnapshotScope` gains `"home"` and `"machine"`, with their words in
   `holdsWords`, the snapshot card and the restore dialog.
2. Keep and fork are refused today for any scope but `"box"`, with words
   for a device. They become per scope: Keep refused for both new scopes,
   with words that say the snapshot lives on a machine lent to others after
   the release; fork allowed for `"home"` where the backend's plan says
   so.
3. The fork check (070 section 9) reads the whole guest: machine ID, SSH
   host keys, addresses, the tailnet node. For a home fork these are the
   same as the source's by design. So the check gains a home variant that
   reads only the fork's home: BB's files, the access file, BB's daemon
   unit, the keychain, and that nothing names the source's BB machine.
   `forkSafe` is the version of the helper's home reset.
4. The pool backend implements `snapshotting`, `planSnapshots`,
   `snapshot`, `rollbackSnapshot`, `deleteSnapshot`, `heldSnapshots` and,
   for Macs lent whole, `forkSnapshot`, through the helper. A machine that
   does not answer makes its snapshots `unavailable`, as 070 says.
5. The pool's test fakes gain the helper's snapshot commands, and the
   conformance suite runs take, restore, undo and delete on a pool machine
   that offers them.

### 6. What stays refused

- Home snapshots for a box with root: `linux-docker` boxes and machines
  with `reset=machine`.
- Machine snapshots on a Mac that lends iOS slots, or on any machine with
  more than one box user.
- Memory: no scope holds it.
- Keep past release, for both scopes, in the first units: the snapshot
  would hold the box's secrets on a machine lent to the next box, and a
  `linux-docker` box there has root.
- Fork where another user shares the machine.
- Fork on a Mac that lends iOS slots, until a new user can be signed in
  there without a userspace restart.
- A restore of a box threads run on, until 070's G17 passes, as for every
  backend.
- A home made before homes were subvolumes or datasets.
- A machine whose proof failed, or whose hook is not contract 1.

## Risks

- **APFS clones are per file.** A home of 220,000 files takes 3.8 s to
  clone and 8.3 s to delete, and the user is paused for the clone. Xcode's
  DerivedData can hold more. The plan says the pause before the take.
- **A Mac restore signs the user out.** Viewers of the desktop lose it for
  about 3 to 5 s, and the automatic login must be cleared first or the
  user comes back mid-swap. On a Mac where loginwindow alone does not sign
  the user in again, the helper falls back to a userspace restart, which
  ends every SSH session.
- **Forks keep absolute paths** to the source's home. Tools that store
  them, such as virtual environments, may break in the fork.
- **Room.** Snapshots grow as the home changes and share the machine's
  disk with the next boxes. 070's room rule applies to the homes' volume,
  and 064's disk reserve for slots counts snapshots.
- **Stale state outside the home** after a restore: caches are cleared;
  daemons' per-user state is not, and has not been seen to matter.
- **Hooks are root code BB Box does not write.** One froze a filesystem in
  the spike. The contract check runs before a hook goes live, and a hook
  that fails takes the machine out of service, as a failed reset does.
- **Cloud tokens on the machine** are readable by a box with root there.

## Build order

The owner chose this order on 11 November 2026. Each is a unit:

1. **Machines report whether they can snapshot.** The probe, the report
   kept per machine, the doctor's checks, the core's `"home"` and
   `"machine"` scopes with their words, and refusals that give the
   machine's own reason. No backend offers either scope, and no pool
   snapshot is taken. Built.
2. **Home snapshots on Macs lent whole.** Take and restore with undo, the
   reset's clean-up and the proof. Forks only where no other user shares
   the Mac. First proved on a real pool Mac. The snapshot store accepts
   the new scopes in this unit, as its records' check allows only `box`
   and `device` today.
3. **Shared iOS slots.** Take and restore. Forks stay off until a user can
   be signed in without a userspace restart, which ends every SSH session
   on the Mac.
4. **Linux homes on btrfs.** New homes as subvolumes, with the pool's
   reset fixed so that no snapshot is left behind.
5. **The hook contract and the machine scope.** The helper's runner,
   `setup.sh --snapshot-hook`, the contract check as a doctor check and in
   the conformance suite, and the LVM sample hook.

Later: ZFS homes, a sample cloud hook, and Keep past release where no box
on the machine has root.

### History: the spike's fork rule

The spike recommended the opposite fork rule: forks into a new slot on
iOS slot Macs in unit 3, and no fork on a machine lent whole, as its
snapshots live on it and its source holds it. The owner rejected that on
11 November 2026. This record states the owner's rule throughout: forks
only on a Mac lent whole, where no other user shares it, and none on Macs
that lend iOS slots until signing a new user in no longer restarts
userspace.

## Consequences

- 070's table row "SSH host pool, iOS slots, Namespace macOS: none" changes
  for the pool: per machine, home or machine scope. Namespace macOS is not
  affected.
- 070's rule "never on a shared host to act on one slot" stands: a home
  snapshot acts on one slot's home only, never the host.
- The pool's helpers, `setup.sh`, the setup guide, the snapshots guide and
  the BB Box skill change with each unit.
- Not measured in the spike: a real pool Mac (the spike used a Tart VM
  with System Integrity Protection off), Spotlight on, a cloud hook, ZFS
  at 220,000 files, a restore of a home on a Mac at 220,000 files.
