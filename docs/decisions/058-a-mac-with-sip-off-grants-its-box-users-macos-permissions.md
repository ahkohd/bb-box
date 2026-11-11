# 058: A Mac with SIP off grants its box users macOS permissions

Status: accepted, 16 October 2026, after the live check below; extended to
Namespace's Macs, and to macOS 26's TCC schema, by
[093](093-namespaces-macs-grant-macos-permissions-through-the-mac-helper.md).
Extends
[047](047-a-physical-mac-is-an-ssh-pool-machine-lent-with-a-new-user-at-its-console.md):
on a pool Mac whose owner has turned System Integrity Protection off, the
helper grants the box user's apps and command-line programs the
permissions macOS asks a person for.

## Context

A Mac in the SSH host pool lends a new standard user to each box (047). An
agent drives it with no person at hand. macOS asks a person before a
program may use Accessibility, Screen Recording, Input Monitoring, the
microphone, the camera, or send Apple events to another app. Today only
Cua Driver is covered: a person grants it once per Mac, and the helper
writes each new user's screen-capture approval (047, #713). Any other app
stops at macOS's prompt. On the dedicated Mac, an app that wanted
Accessibility stopped a box on a dialog asking for an administrator's
password, and the agent could not go on.

macOS keeps these permissions in TCC's databases. With SIP on, no process,
root included, may write them. A person, or an MDM server, must answer.

What others do:

- Devin's cloud Mac (Cognition) prepares the guest's image offline: it
  mounts the disk and writes the TCC databases before the VM boots.
- GitHub's runner images (actions/runner-images,
  `configure-tccdb-macos-27.sh`) and Cirrus Labs' Tart images
  (`disable-sip.pkr.hcl`, `update-tcc-database.sh`) run with SIP off and
  insert rows with `sqlite3`.
- On macOS 27 the user's database has moved out of the home, to
  `/private/var/containers/Data/ProtectedSystem/<UUID>/Data/Library/Application Support/com.apple.TCC/TCC.db`.
  The runner images find its path from the files `tccd` has open.
- AWS lets the owner of an EC2 Mac, a physical Mac, change SIP.
- An MDM server's privacy profile (PPPC) can allow Accessibility, but
  lets users only approve Screen Recording and the microphone, not allow
  them. The pool has no MDM server, and 047 rules one out.

bb-box's Tart images already grant Cua this way, offline (#628). A physical
Mac cannot be prepared offline: it can only be changed while it runs.

## Decision

**A pool Mac's owner may turn SIP off, and then the helper grants box
users' programs their permissions, with no person.**

### SIP off is per Mac, optional, and the owner's

- The owner turns it off in recovery, fully (`csrutil disable`), on a Mac
  set aside for agents. bb-box never asks it of a Mac, and works on with
  SIP on as now.
- The helper's status reports SIP's state (`csrutil status`), and the
  doctor shows it for each pool Mac, with what works either way:
  - SIP on: Cua Driver as now (a person's grants once per Mac, the
    helper's screen-capture approval per user); every other program's
    permission needs a person in the desktop's viewer.
  - SIP off: the helper grants the permissions below on request, and the
    reset removes everything 047 leaves.

### What it grants, where, and how

- Accessibility, Screen Recording and Input Monitoring, in the system
  database (`/Library/Application Support/com.apple.TCC/TCC.db`); the
  microphone, the camera and Automation (Apple events to a named app), in
  the box user's, found from the files its `tccd` has open. Full Disk
  Access is left out: it reaches every user's data, and no need for it has
  come up.
- Each grant is a row with `auth_value` 2 and the program's compiled code
  requirement (`codesign -d -r-`, then `csreq -b`). The helper checks the
  schema's columns before it writes, and refuses when they differ. `tccd`
  reads a new row at once: no restart is needed.
- Who gets it, which the live check settled:
  - An app (a bundle) is found by its bundle ID, never by path: a path row
    for an app's executable does nothing, and macOS writes its own denied
    bundle-ID row beside it. So an app is granted by bundle ID with its
    requirement.
  - A command-line program (a Mach-O such as cargo's `target/release/`
    output) is found by its path: macOS writes its own denied rows by
    path, and ignores an identifier row. So a program is granted by path,
    with its requirement when it has a stable one.
- A grant replaces any denied row macOS wrote for the same program.
- What it grants to: programs under the box user's home, and apps in
  `/Applications` that are not Apple's (bundle IDs under `com.apple.`).
  Never Terminal, a shell or an interpreter: a grant there reaches every
  script it runs. The helper refuses anything else, and says why.

### Programs the agent builds, and rebuilds

An ad-hoc signature, as Xcode's "Sign to Run Locally" and the linker give,
has the build's cdhash as its whole requirement, so each rebuild would
lose a grant. Each box therefore gets a signing identity of its own:

- At creation the helper makes a self-signed code-signing certificate for
  the box user, in a keychain of its own (`bb-box-signing`) with a known,
  empty password, imported for all apps and with codesign in its partition
  list, and on the user's keychain search list. Codesign and Xcode sign
  with it with no prompt. (In the login keychain codesign asks for a
  password the box user does not know.)
- Signed with it, a program's requirement is its identifier and the
  certificate's leaf hash, the same across rebuilds. The tools and the
  skill tell the agent to sign with "bb-box local code signing": Xcode's
  signing identity, or `codesign -s "bb-box local code signing"
  --identifier <id> <binary>` after `cargo build`.
- The grants then hold across rebuilds: an app by bundle ID and that
  requirement, a program by path and that requirement, which also refuses
  another binary put at the path.
- A program the agent does not sign keeps only an ad-hoc signature: it is
  granted by path alone, which holds across rebuilds but trusts whatever
  is at that path. The box user owns that path, and the grant ends with
  the box, so this is the box's own risk. An ad-hoc app cannot keep a
  grant across rebuilds: the agent signs it, or asks again.

### Who is responsible: box_run's commands

macOS checks the permissions of a program's responsible process. A
command `box_run` starts is charged to `sshd-keygen-wrapper`, the SSH
process it runs under, which a person granted Accessibility at setup for
the viewer's input (047). So every command already has Accessibility, with
no grant, and a grant on the program itself is not what macOS checks.

That stays, and on a Mac with SIP off the helper also grants
`sshd-keygen-wrapper` Screen Recording, so `box_run`'s
commands can capture the box's screen too. The agent's own command-line
tools then work with no grant. Disclaiming by default would make every
command need its own grants, rebuilt tools re-granted, and the viewer's
input helper would lose the grant it needs.

`box_grant` is then for programs that are their own responsible process:
apps opened with `open` or from the Dock, and command-line programs the
box starts through bb-box's launcher, which disclaims responsibility
(`responsibility_spawnattrs_setdisclaim`). The helper installs that
launcher, `/usr/local/bin/bb-box-own`, and the tool's answer says to run a
granted program through it.

### When: an agent asks

- `box_grant` with `box`, `program` (a bundle ID, an app's path, or a
  program's path in the box), and `permissions` (from the list above;
  Automation names its target app). It answers grant by grant, made or
  refused with the reason, and says to start the program again where
  macOS reads permissions only at launch.
- `box_status` lists the box's grants.
- No automatic grants from `tccd`'s requests for now: they grant whatever
  a program asks, which the agent did not choose. A Mac setting for them,
  off unless set, can come later.

### The reset removes them

The live check found that every row outlives the user: the helper's
grants, and macOS's own denied rows, by bundle ID and by path. So:

- At each claim the helper notes the system database's rows; the reset
  deletes the rows added since, whoever wrote them, and the box user's
  database goes with the user.
- With SIP off, the reset's sweep already removes the old user's
  ProtectedSystem container (its user database) and its
  `/private/var/folders` entry, which it could not with SIP on: the user
  reset after SIP went off left neither. Those left by users reset while
  SIP was on stay, about 30 MB each: the reset removes, once, any of them
  whose UID has no user.

### Not covered

- System and network extensions, and kernel extensions: they need the
  owner's approval in System Settings, and change the Mac for every box.
- Gatekeeper: a program the agent downloaded runs once its quarantine flag
  is cleared (`xattr -d com.apple.quarantine`), which the box user can do
  for its own files. No setting changes.

### Security

- Box users stay standard users without sudo. Root stays with the helper,
  which grants only what this policy allows, to the box user's own
  programs.
- SIP off removes protections for the whole Mac: a process that gets root
  can change the system and persist. So the Mac is set aside for agents,
  holds no person's data (047 and #717 close people's homes), and its
  owner accepts that. The doctor says so beside SIP's state.
- A grant names a program as signed, so another binary does not inherit
  it, except a program granted by path alone, which is the box's own.

## The live check

On the dedicated Mac (macOS 27.0.1, SIP fully off), 16 October 2026, with
probe programs in a box user's home, the rows written as root by a script
and each probe run in the desktop session:

| Program | Granted by | Result | After a rebuild |
| --- | --- | --- | --- |
| App, ad-hoc | bundle ID and its cdhash requirement | Accessibility, Screen Recording and the microphone (user database) granted, no prompt | (requirement changes) |
| App, local identity | bundle ID and identifier-and-leaf requirement | both granted | still granted (new cdhash, same requirement) |
| App, ad-hoc | path of its executable | not granted: macOS uses its denied bundle-ID row | not granted |
| CLI, ad-hoc | path, no requirement | both granted | still granted |
| CLI, local identity | identifier | not granted: macOS looks a CLI up by path | not granted |
| CLI, local identity | path and its requirement | both granted | still granted; an ad-hoc build at that path refused |

- The schema of both databases on macOS 27: `access` with `service`,
  `client`, `client_type` (0 bundle ID, 1 path), `auth_value`,
  `auth_reason`, `auth_version`, `csreq`, `policy_id`, the indirect
  object's 3 columns, `flags`, `last_modified`, `pid`, `pid_version`,
  `boot_uuid`, `last_reminded`, `one_time_reprompt_eligible`,
  `reminder_count`.
- A program asking for a permission writes a denied row at once, by bundle
  ID for an app and by path for a CLI.
- An ungranted CLI run by `box_run` had Accessibility, from
  `sshd-keygen-wrapper`; through a disclaiming launcher the same CLI had
  none.
- After the reset, every probe row was still in the system database; the
  old user and its user database were gone; and 25 ProtectedSystem
  containers and `/private/var/folders` entries of users reset before SIP
  went off were still there.
- Nothing else a box would notice changed with SIP off, in these tests.

## Consequences

- The helper gains a grant command, a snapshot of the system database's
  rows per claim, the per-box signing identity, the launcher, and the
  reset's removals; the pool gains `box_grant`, grants in `box_status`,
  and a doctor line for SIP.
- A Mac with SIP on is unchanged.
- The grants depend on TCC's schema and database paths, which macOS
  changes between releases (macOS 27 moved the user database). The
  helper checks them before it writes, and the doctor warns when they
  differ.
