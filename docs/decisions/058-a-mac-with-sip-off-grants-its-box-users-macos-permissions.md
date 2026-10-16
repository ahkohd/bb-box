# 058: A Mac with SIP off grants its box users macOS permissions

Status: proposed, 16 October 2026. Extends
[047](047-a-physical-mac-is-an-ssh-pool-machine-lent-with-a-new-user-at-its-console.md):
on a pool Mac whose owner has turned System Integrity Protection off, the
helper grants the box user's apps the permissions macOS asks a person for.

## Context

A Mac in the SSH host pool lends a new standard user to each box (047). An
agent drives it with no person at hand. macOS asks a person before an app
may use Accessibility, Screen Recording, Input Monitoring, the microphone,
the camera, or send Apple events to another app. Today only Cua Driver is
covered: a person grants it once per Mac, and the helper writes each new
user's screen-capture approval (047, #713). Any other app stops at
macOS's prompt. On the dedicated Mac, an app that wanted Accessibility
stopped a box on a dialog asking for an administrator's password, and the
agent could not go on.

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
  `/private/var/containers/Data/ProtectedSystem/.../TCC.db`. The runner
  images find its path from the files `tccd` has open.
- AWS lets the owner of an EC2 Mac, a physical Mac, change SIP.
- An MDM server's privacy profile (PPPC) can allow Accessibility, but
  lets users only approve Screen Recording and the microphone, not allow
  them. The pool has no MDM server, and 047 rules one out.

bb-box's Tart images already grant Cua this way, offline (#628). A physical
Mac cannot be prepared offline: it can only be changed while it runs.

## Decision

**A pool Mac's owner may turn SIP off, and then the helper grants box
users' apps their permissions, with no person.**

### SIP off is per Mac, optional, and the owner's

- The owner turns it off in recovery, fully (`csrutil disable`), on a Mac
  set aside for agents. bb-box never asks it of a Mac, and works on with
  SIP on as now.
- The helper's status reports SIP's state (`csrutil status`), and the
  doctor shows it for each pool Mac, with what works either way:
  - SIP on: Cua Driver as now (a person's grants once per Mac, the
    helper's screen-capture approval per user); every other app's
    permission needs a person in the desktop's viewer.
  - SIP off: the helper grants the permissions below on request, and the
    reset can remove what 047 leaves.

### The helper grants by bundle ID and code requirement

- What it grants: Accessibility, Screen Recording, Input Monitoring, the
  microphone, the camera, and Automation (Apple events to a named app).
  Full Disk Access is left out for now: it reaches every user's data, the
  other box users' leftovers included, and no agent need for it has come
  up.
- How: as root, it inserts a row for the app's bundle ID with the app's
  code requirement (`codesign -d -r-`, compiled with `csreq`), so the
  grant holds only for that app as signed. Accessibility, Screen
  Recording and Input Monitoring go in the system database
  (`/Library/Application Support/com.apple.TCC/TCC.db`); the microphone,
  the camera and Automation in the box user's, found as the runner images
  find it on macOS 27. Then it restarts `tccd`, so the grant takes effect.
- What it grants to: apps in the box user's home or in `/Applications`,
  that are signed, and not Apple's own (bundle IDs under `com.apple.`).
  Never Terminal, a shell or an interpreter: a grant to one would reach
  every script it runs. The helper refuses anything else, and says why.

### When: an agent asks, and the helper checks

My recommendation: an agent tool first, and no automatic grants yet.

- `box_grant` with `box`, `app` (a bundle ID or the app's path in the
  box), and `permissions` (a list from the above; Automation names its
  target app). It answers with each grant made or refused and the reason,
  and tells the agent to start the app again where macOS reads
  permissions only at launch.
- `box_status` lists the box's grants.
- Automatic grants, from `tccd`'s log of requests, would serve an agent
  that does not know which permission an app wants. They also grant
  whatever an app asks, which the agent did not choose. Revisit once the
  tool has run on real work, as a Mac setting that is off unless set.

### The reset removes them

- It deletes the box user's rows from the user database, which on macOS 27
  is outside the home and outlives the user, and the system rows the
  helper made for that box, recorded by box.
- With SIP off it can also remove what 047 leaves of an old user: the
  `sunlnk` folders and the daemons' folders in `/private/var/folders`. The
  doctor's count of leftovers then falls back to none.

### Not covered

- System and network extensions, and kernel extensions: they need the
  owner's approval in System Settings, and change the Mac for every box.
- Gatekeeper: an app the agent downloaded runs once its quarantine flag
  is cleared (`xattr -d com.apple.quarantine`), which the box user can do
  for its own files. No setting changes.

### Security

- Box users stay standard users without sudo. Root stays with the helper,
  which grants only what this policy allows, to the box user's own apps.
- SIP off removes protections for the whole Mac: a process that gets root
  can change the system and persist. So the Mac is set aside for agents,
  holds no person's data (047 and #717 close people's homes), and its
  owner accepts that. The doctor says so beside SIP's state.
- A grant is to an app as signed, never to a path alone, so another
  binary at that path does not inherit it.

## The live check

Before any helper code, once SIP is off on the dedicated Mac:

1. One grant end to end on macOS 27: a signed app in the box user's
   `~/Applications` that wants Accessibility. Find the user database from
   `tccd`'s open files, insert the row with its code requirement as root,
   restart `tccd`, and confirm the app is trusted (`AXIsProcessTrusted`)
   with no prompt.
2. The same for Screen Recording, and for the microphone in the user
   database.
3. A reset removes the rows and the leftover folders, and the next box
   user has no grant.
4. What else SIP off changes on macOS 27 that a box would notice.

## Consequences

- The helper gains a grant command, a record of grants per box, and rows
  to remove in the reset; the pool gains `box_grant` and a doctor line for
  SIP.
- A Mac with SIP on is unchanged.
- The grants depend on TCC's schema and database paths, which macOS
  changes between releases (macOS 27 moved the user database). The
  helper checks the schema's columns before it writes, and refuses with
  the doctor's warning when they differ.
