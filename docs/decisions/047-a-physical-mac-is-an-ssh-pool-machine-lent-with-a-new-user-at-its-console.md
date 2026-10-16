# 047: A physical Mac is an SSH pool machine, lent with a new user at its console

Status: accepted, 2 October 2026. Extends
[030](030-a-mac-runs-desktop-commands-through-launchctl-asuser.md): on a
pool's Mac, the helper writes the desktop sudoers rule for each box's user
and removes it in the reset. Amended while it was built, 2 October 2026: a
live check on a stand-in Mac, a macOS 27 VM under Tart (#381), measured
the claim, the display and the reset. The reset now sets the next user as
the automatic login before it logs the old one out, the helper writes
`/etc/kcpassword` itself, and on macOS 27 a userspace restart signs the
next user in. What a real Mac must still confirm is under
[the live check](#the-live-check). Amended 3 October 2026: Screen Sharing
ignores the viewer's keyboard and pointer, so a helper in the box user's
session posts them (#406), with one more grant per Mac at setup.
Amended 15 October 2026: on the dedicated Mac, the first reset could not
remove the old user's folder in `/private/var/folders`, as macOS 27 marks
the user's `0`, `C`, `T` and `X` folders there `sunlnk`, and keeps its
daemons' folders in them, which root cannot list. The reset now empties
what it can there and leaves the rest (step 4), and the doctor counts it.
Amended 16 October 2026: each new box user starts with Cua's screen
capture approved, as macOS 27 otherwise asks every new user (computer
use).

## Context

#47 lends physical Macs as boxes. A Mac's own hardware gives what Tart's
VMs do not: Metal and Core ML on its own GPU and Neural Engine, all its
memory and cores, devices plugged into it, and no limit of two macOS VMs.
The research sketch is in
[later backends](../research/later-backends.md#physical-mac-real-later).

What shapes the design:

- **One console.** A Mac shows one graphical session on its display. The
  desktop and computer use need the box's user signed in there.
- **Signing in.** loginwindow signs a user in by itself only when it
  starts, from `autoLoginUser` and `/etc/kcpassword`, and only with
  FileVault off. `sysadminctl -autologin set` (macOS 13 and later) writes
  both, but on macOS 27 it writes no `kcpassword` and still exits 0. macOS
  has no other way to start a user's graphical session.
- **The disk.** The system volume is sealed. What a box changes is on the
  Data volume, and a running Mac cannot roll that back to a snapshot: that
  is done from recoveryOS, where a person signs in.
- **Screen Sharing.** A VNC client that gives only the VNC password gets a
  session of its own at the login window, not the console's user: Tart's
  setup measured this in a VM
  ([architecture](../architecture.md#desktops-and-control)). A
  client that signs in as the console's user with Apple's authentication
  (RFB security type 30, Diffie-Hellman) sees that user's screen. noVNC
  has spoken type 30 since 1.4.
- **Privacy grants.** macOS keeps Accessibility and Screen Recording per
  app in the system's TCC database, which System Integrity Protection
  guards. A person grants them in System Settings, once per Mac, and they
  hold for every user. An MDM profile can grant Accessibility. For Screen
  Recording a profile can only deny it or let a standard user approve it.
  macOS 15 and later also confirm an app's screen capture with each user,
  again every 30 days, and keep the answer in the user's home.
- **The SSH host pool** already lends Linux machines whole. Each box gets a
  new user, `bbx-<generation>`, and the reset removes it and everything it
  left. The pool has a reset generation, owner markers that survive lost
  storage, out of service and return to service, jump hosts, restarts in
  the middle of a reset, and a doctor check per machine.

What a box is, and its reset:

| Option | Reset | For | Against |
| --- | --- | --- | --- |
| A new standard user per box, as the pool | remove the user and what it owns; sign the next box's user in | built and tested in the pool; a new user ID makes leftovers findable by owner; the system stays as set up | changes outside its own files stay (below); signing in needs loginwindow to start again |
| One box user, its home made again | the same, keeping the user | one user to set up | what one box left has the next box's user ID, so the check cannot find it |
| A home on an APFS volume of its own | delete the volume | a large home (DerivedData, Simulator devices) goes at once, whatever its file count; a quota gives the box its disk size | a volume per box, mounted at the home before sign-in; still a user per box |
| A snapshot of the Data volume | roll back | the whole Data volume | not on a running Mac: recoveryOS, and a person |
| Erase All Content and Settings | erase, set up again | the whole Mac | Setup Assistant needs a person or MDM enrolment; Xcode and its runtimes are downloaded again; far too slow per box |
| A macOS VM per box | delete the VM | fully clean | that is Tart, with its two-VM limit and no Mac hardware |

The desktop:

| Option | For | Against |
| --- | --- | --- |
| Screen Sharing, signed in as the box user | in macOS; shows the console; no app or grant of ours | the box user needs a password the relay can use; that current macOS still offers type 30 is to be checked |
| Screen Sharing with the VNC password | the relay answers it now | a separate session at the login window, not the console |
| A VNC server of our own in the box's session | could resize | an app to build or choose, resident, with its own Screen Recording grant and 30-day confirmation |

More than one graphical session per Mac: Screen Sharing can sign a second
user in to a virtual session, but only Apple's client asks for one, and
Apple's licence allows one at a time. Fast user switching keeps other
sessions away from the console. Neither is worth building on.

Where it fits:

| Option | For | Against |
| --- | --- | --- |
| The SSH host pool, with Macs among its machines | the lifecycle of a machine lent whole is built and tested; one list of the machines you lend; the sketch's conclusion | a second helper, for macOS; the pool's machines no longer share one OS |
| A backend of its own | its own settings page | the pool's lifecycle and tests again; a second list of machines |
| An engine of the Tart backend | the same Macs and host user | Tart's boxes are made and deleted, a lent Mac is reset and can go out of service; a Mac lent whole leaves no room for VMs |

## Decision

**A Mac is a machine of the SSH host pool.**

- Its line in the machines setting names macOS kinds:
  `mac-mini bbbox-admin@192.0.2.30 macos,macos-desktop`.
- Its setup is `setup/ssh-pool/setup-mac.sh`, and its helper is
  `machine-mac.sh`, installed as `/usr/local/libexec/bb-box/machine`. The
  helper has the Linux helper's commands, input, output and exit codes,
  and one more command, `display`, below. Its state is in `/var/db/bb-box`,
  where macOS keeps such state.
- Everything else is the pool's: the smallest free machine that fits, the
  markers and generation, out of service and return to service, jump
  hosts, two installs sharing a machine, `members()`, and the doctor per
  machine.
- The pool's `hostOs` is `linux` while all its machines run Linux, `macos`
  when all are Macs, and null with both. The Physical chip hides Runs on
  anyway (044).
- A Mac lent by the pool is not also a Tart host: a box takes the whole
  Mac, and on macOS 27 and later each reset restarts its userspace, which
  stops every Tart VM on it. The doctor warns when one address is in both,
  and says so.

**A box is a new standard user, already signed in at the console.**

- One box per Mac, of either kind. A `macos` box is the same box without
  the display and computer use.
- The reset makes the next box's user ahead: `bbx-<generation>`, a
  standard user hidden from the login window, in the `_developer` group,
  with a random password only root on the Mac can read. The helper gives
  the password to `sysadminctl` on stdin and writes `/etc/kcpassword`
  itself, so it is in no command's arguments. Its home is made from
  macOS's template and bb-box's: the login PATH, no sleep and no screen
  saver, as in Tart's image, and Cua Driver's LaunchAgent. Its
  `loginwindow.plist` names the macOS version and build, so its first
  sign-in does not open Setup Assistant.
- So a free Mac is a warm box. A claim takes seconds: it writes the
  marker, adds the box's SSH key and 030's sudoers rule for the user, and
  waits for SSH, the user at the console and, for `macos-desktop`, Cua's
  socket. `readyTimeoutMs` is 3 minutes for both kinds.
- The reset, after the old box's BB machine is removed:
  1. make the next user and set it as the automatic login. From then on,
     whatever signs a user in signs in the next one: while the old user
     was still the automatic login, macOS signed it in again about 6 s
     after its logout;
  2. log the old user out and end its processes;
  3. start loginwindow again, which signs the next user in. The helper
     restarts loginwindow, then `launchctl reboot userspace`, then the
     whole Mac, each when the way before has not signed the user in within
     its time, and the Mac's next reset starts with the way that worked.
     On macOS 27 restarting loginwindow signed nobody in within 60 s, so a
     Mac with no way remembered starts with userspace on macOS 27 and
     later (#383). A restart ends the helper, so it waits for step 5;
  4. remove the old user's crontab, at jobs, System V IPC objects, sudoers
     rule, managed preferences and places in groups, including the
     `-disabled` group that allowing all users to a service makes, and
     every file it owns on the Data volume, such as in `/private/tmp`,
     `/Users/Shared` and `/private/var/folders`; then the user with its
     home. Spotlight can start the user's processes again during the
     sweep, so the helper logs it out and sweeps `/private/var/folders`
     again. macOS 27 marks the user's `0`, `C`, `T` and `X` folders there
     `sunlnk`, System Integrity Protection's "system no-unlink", which not
     even root can clear while SIP is on, and keeps folders of its daemons
     in `0` and `C`, such as `com.apple.ScreenTimeAgent` and
     `com.apple.QuickLook.thumbnailcache`, which root cannot even list,
     Full Disk Access or not. So the sweep empties what it can there, and
     the clean check takes the user's folder as removed when root sees
     only folders left in it, each the old user's or root's: a file, or
     anything of another user, such as the next box's, fails the reset. A
     later user gets another folder there, and cannot read the old one's
     `C` or `T`. The cost: what a box's use left in those daemons' folders,
     such as QuickLook's thumbnails, stays on the Mac, unreadable to later
     box users, until macOS clears it. The doctor's state check counts the
     old users' folders left there and what root can see in them, so a
     slow build-up shows;
  5. the clean check: no process or file of the old user, and the next
     user at the console. While a restart signs the user in, the helper
     reports the reset as still running, as for the pool's whole-machine
     reset, and bb-box asks again once it answers. Then the generation
     moves on.
- On the stand-in, a claim took 0.7 to 1.3 s, and a release under a
  minute. A real Mac's full restart is slower than the VM's. Enrolment is
  not measured yet.
- FileVault stays off, for the automatic login. If the Mac restarts while
  a box holds it, the box's user signs in again.

**What a reset keeps, and what may carry over.** A box must start clean.
Boxes are not a security boundary between each other or from the Mac.

- Kept, as set up: macOS, its settings and updates; apps in
  `/Applications`, such as Xcode and Cua Driver; Homebrew and what setup
  installed with it; the iOS Simulator's runtimes; Cua's Accessibility and
  Screen Recording grants; Screen Sharing and Remote Login; bb-box's
  helper, template and state.
- Removed: the user and its home, with its keychain, LaunchAgents, login
  items, privacy answers, Simulator devices, DerivedData, caches, shell
  history, Git and GitHub CLI credentials, and BB's daemon; its processes;
  its files anywhere on the Data volume. Its BB machine is removed first,
  as on Linux machines.
- May carry over, and rarely matters in daily use:
  - changes to files that others own and anyone may write;
  - what a standard user can change for the whole Mac: Wi-Fi networks
    joined, Bluetooth devices paired, and an iPhone trusted over USB,
    whose pairing record is the system's;
  - the system log and crash reports that name its processes;
  - what it sent elsewhere.
- A box can read whatever any user on the Mac can read. Lend Macs set
  aside for boxes, not ones people use.

**The box user is not an administrator** (`admin: false`).

- It cannot use sudo, install into `/Applications` or `/opt/homebrew`, or
  change system settings. That is what makes removing the user a reset.
- So `brew install` fails in a box. Installs into the home work: npm, pip
  and uv, cargo, mise, and apps in `~/Applications`. Setup installs
  Homebrew with Git, GitHub CLI and Node.js 22.19 or newer, which
  enrolment needs, and whatever else the operator adds.
- A Homebrew that boxes may change, put back from an APFS clone at each
  reset, can come later if its lack hurts.
- A Mac whose boxes need administrator rights would have to be restored
  whole, which nothing fast does. None is planned.

**The desktop is the console, through Screen Sharing.**

- One graphical session per Mac, the console's. Virtual sessions and fast
  user switching are not used.
- The display is Screen Sharing on port 5900, reached with
  `ssh -W 127.0.0.1:5900` as the box user. Protocol `rfb`.
- The relay signs in to Screen Sharing as the box user with Apple's
  authentication. `DisplayAuth` gains `{type: "apple", user, password}`,
  and the relay answers security type 30 with it. `open()` reads the
  password from the helper's `display` command each time, as Tart's
  `open()` reads its VNC password, so it is never in `Guest.data`. The
  viewer still gets security type None from the relay.
- Screen Sharing lets all users sign in, so each new box user can. On
  macOS 27 it allows administrators only at first, so a person sets it to
  all users at setup. Its VNC password option stays off.
- Not resizable at first: the console has the display's size. A Mac with
  no display may need an HDMI dummy plug for a good size. Resizing through
  the backend ([021](021-desktop-resize-through-the-backend.md)) can come
  later.
- Type 30 showed the box user's console on macOS 27. If a later macOS
  drops it or stops showing the console, the fallbacks, in order: the VNC
  password with Screen Sharing's `VNCAlwaysStartOnConsole` setting; a VNC
  server of our own.
- The viewer's input does not go through Screen Sharing, which ignores a
  viewer that is not Apple's ([the viewer's input](#the-viewers-input)).
  `open()` also returns an `input`: core's `MacInput`, on
  `macInputCommand()` run over the box user's SSH in its desktop session,
  through 030's wrapper, as Tart's macOS desktop first did (#426). It is a
  JXA script that posts each event at the HID event tap with `CGEventPost`,
  about 0.4 ms an event. The relay starts it at the controlling viewer's
  first input, sends it the keys, pointer, wheel and clipboard, and
  releases what was held when control passes. The box's clipboard comes
  back to the viewer over RPC.
- Its limits: keys go by their position on a US keyboard, and a character
  with no key there is dropped; text pasted into the box is Latin-1, as
  RFB's clipboard is; Screen Sharing does not show windows that keep
  themselves out of screen capture, or protected video; and macOS shows
  Screen Sharing's menu bar icon while a viewer is connected, and a notice
  when one leaves.

**Computer use is Cua, granted once per Mac.**

- Cua Driver at the version Tart's image pins, in `/Applications`, with its
  daemon a LaunchAgent from the home template, so it starts in each box
  user's session.
- Its socket is in the box user's home, and the user changes with each
  box. So core expands a leading `~/` in `computerUse.socket`, and the
  offer names `~/Library/Caches/cua-driver/cua-driver.sock`.
- A person turns on Accessibility and Screen Recording for Cua Driver in
  System Settings, once per Mac, at setup. They are per app in the system's
  database, so they hold for each new user and through every reset. A Mac
  under MDM can grant Accessibility by profile instead (macOS 27 moves it
  to declarative app settings). No profile grants Screen Recording.
- The 30-day confirmation of screen capture is per user, so a new user is
  asked on Cua's first capture:
  - under MDM, Apple's `forceBypassScreenCaptureAlert` restriction (macOS
    15.1 and later, from an MDM server only) turns it off;
  - otherwise each new box user starts with it answered (amended 16
    October 2026, as the operator decided). macOS 27 keeps it outside the
    system's database, in the user's home:
    `~/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist`,
    keyed by Cua's bundle ID, `com.trycua.driver`. replayd writes the
    entry when it asks, and asks again only after its
    `kScreenCapturePrivacyHintDate`. So the helper writes that entry as it
    makes each user, asked at that moment and due again 5 years on, and
    the user is never asked: a box has nobody to answer.

  On the dedicated Mac, a new user without the entry was asked on Cua's
  first capture, within a second. One with it went 4 minutes of computer
  use, with its use count rising, and replayd kept the entry's dates and
  never asked. macOS took the folder as the user's group container,
  writing its own metadata beside the file. The person still grants Cua
  Screen Recording once per Mac; the entry only spares each box user the
  notice on top of that grant. `setup-mac.sh` removes a copy placed in the
  home template by hand.
- SSH gets Accessibility, for the viewer's input, and no Screen Recording.
  A person allows `/usr/bin/osascript`, which runs the input helper, and
  `/usr/libexec/sshd-keygen-wrapper`, the SSH process it runs under, in
  System Settings > Privacy & Security > Accessibility, once per Mac. Both
  need Accessibility and leave to post events (`kTCCServicePostEvent`), as
  Tart's images have them; the live check confirms that this pane gives
  both. A Mac under MDM can grant them by profile instead. Any command run
  over SSH on the Mac can then post events, which bb-box accepts, as it is
  not a boundary on the Mac. Desktop commands run through 030's wrapper.
- SSH does need Full Disk Access, which a person gives at setup with
  Remote Login's "Allow full disk access for remote users". Without it,
  the reset cannot remove the folders macOS protects in a home, such as
  `~/Library/Mail`. The helper reads one byte of the system's `TCC.db` to
  tell whether it has it, and a Mac without it is out of service.
- The helper's status reports Cua's grants from the signed-in user's
  session, and the doctor shows them. The doctor checks the input helper's
  grant there too: it posts a pointer move of one point over SSH, reads
  the pointer's place back with `NSEvent.mouseLocation`, and moves it
  back.

**Xcode and the iOS Simulator.**

- Xcode is the operator's to install, as its download needs an Apple
  Account. Setup then accepts its licence, runs its first launch,
  downloads the iOS platform and runs `DevToolsSecurity -enable`. Box
  users are in `_developer`, so the debugger and Instruments need no
  password.
- The pool's macOS offers add the features `xcode` and `ios-simulator`
  when every Mac serving the kind that answered the last survey has them,
  as the pool's Docker feature works; the doctor warns when only some do.
  The doctor's `status xcode` keeps its answer in `/var/db/bb-box/xcode`,
  and each survey reads it while the Mac's Xcode version is the same. No
  kind requires them yet ([012](012-offers-may-add-features.md)); one can
  come when an agent needs the promise.
- App Store updates are off, so Xcode changes only when the operator
  updates it and runs `setup-mac.sh` again. On macOS 27 only
  `com.apple.commerce AutoUpdate` turns them off.
- Simulator devices are per user, in the home. A box starts with Xcode's
  default devices, and the reset removes them. `xcrun simctl` works over
  SSH. The Simulator's window shows on the desktop, where Cua can drive
  it. UI tests run as desktop commands (030).
- A new device's first boot is slow. The live check measures whether the
  reset should boot one ahead for the next user.
- Signing identities and Apple Accounts are the box's own, in its keychain
  and home. Devices over USB are not offered.

**Reach and enrolment.**

- bb-box reaches each Mac over SSH as the pool's admin user,
  `bbbox-admin`, directly or through a jump host, with its host keys in
  settings. It reaches boxes as their user.
- Reaching a Mac through BB, as Docker on a BB machine
  ([042](042-a-docker-host-can-be-a-bb-machine.md)), would need no inbound
  SSH, but the relay would have to carry SSH and the display as well as
  Docker's API. Later, if a Mac only BB can reach is to be lent.
- A box enrols in BB as a machine, as its user, when claimed
  ([014](014-enrol-through-machine-providers.md)), as Linux pool boxes and
  Tart's macOS boxes do.

**Capacity.** One box per Mac: the pool's `machines` limit. A box gets
the smallest free Mac with the cores, memory and free disk its size asks
for, as the pool's Linux machines are chosen
([028](028-a-box-size-is-chosen-when-it-is-made.md)), and has all of it. A
Mac mini with 16 GB fits the small and medium macOS presets. Several
`macos` boxes per Mac, each without the console, are not planned.

**Setup.** `setup-mac.sh`, run with sudo on the Mac:

- makes `bbbox-admin`, which takes only bb-box's key and may run only the
  helper as root, as on Linux;
- installs the helper, the home template, Cua Driver, Homebrew with Git,
  GitHub CLI and Node.js, and a launch daemon that clears BB's daemon lock
  and PID file in box homes at boot
  ([017](017-boxes-clear-bb-daemon-state-at-boot.md));
- keeps the Mac awake, starts it after a power failure, and turns off
  automatic macOS updates, which would restart a box, automatic App Store
  updates, which would change Xcode under a box, and Spotlight indexing;
- checks that FileVault is off and Remote Login is on;
- makes the first box user and signs it in;
- prints the machine line and host keys, and the steps for a person: turn
  on Screen Sharing for all users; allow full disk access for remote
  users; turn on Cua Driver under Accessibility and Screen Recording, and
  add `osascript` and `sshd-keygen-wrapper` under Accessibility, in panes
  setup opens; install Xcode if wanted.

The doctor checks per Mac what it checks for Linux machines, and FileVault,
the automatic login, the box user at the console, Full Disk Access, Screen
Sharing, Cua's grants, the input helper's grant, and Xcode with its iOS
runtime when present.

**Tests come first on fakes, then on a Mac set aside.**

- In `npm test`: the macOS helper on Linux, with stub macOS tools that
  keep their state in files (`dscl`, `sysadminctl`, `launchctl`, `pmset`,
  `defaults`, `stat -f`, `sysctl`); the pool's Mac paths with the fake
  helper and SSH the pool's tests use; and type 30 against the fake RFB
  server.
- On a Mac: the conformance suite, `npm run conformance -- --backend
  ssh-pool --settings <file>`, with the Mac's line in the settings, as the
  Docker rig runs it. And Mac checks in `test/ssh-pool-live.ts`: a box
  leaves files in `/private/tmp`, `/Users/Shared` and its home, a
  LaunchAgent, a login item, a crontab, a keychain item, a Simulator
  device and a process that ignores SIGTERM; the next box has none of
  them, Cua works there, and its desktop shows its user; and a reset cut
  by a restart is finished.
- The hardware: a Mac with Apple silicon, set aside for boxes and erased
  first, such as a Mac mini with M2 or later, 16 GB of memory and 512 GB of
  disk, as Xcode with an iOS runtime takes tens of GB; on a network BB's
  server reaches over SSH; an HDMI dummy plug, to compare the console's
  size with and without; an Apple Account for Xcode; and a person at the
  Mac or on Screen Sharing for setup's steps. A second Mac only for the
  two-install check, which otherwise skips with its reason. Not a Mac
  anyone uses: a box takes its console, and the reset removes users.
- The live check measures, and this record then takes in: the quickest
  sign-in that works and the reset's time; type 30 showing the console;
  when the 30-day confirmation shows for a new user; the file sweep's time
  with Xcode installed; the console's size with no display; and a new
  Simulator device's first boot. The stand-in measured the first two;
  [the live check](#the-live-check) lists what a real Mac must confirm.

## Consequences

- Agents get a real Mac for builds, Apple's tools and the iOS Simulator,
  and it is reset without reinstalling macOS, in under a minute after each
  release on the stand-in, with a claim in about a second.
- On macOS 27 each reset restarts the Mac's userspace. That ends every
  SSH session on the Mac, including an operator's `machine reset`, which
  they then run again, and would stop any VM on it: one more reason a
  pool's Mac is not also a Tart host.
- A person spends a few minutes on each Mac at setup, for Screen Sharing,
  Full Disk Access, Cua's grants and SSH's Accessibility. Without MDM, a
  person may also answer the 30-day confirmation once per box in the
  viewer, if the live check finds it shows, until the operator decides
  otherwise.
- `brew install` does not work in a Mac box.
- The interface gains `DisplayAuth` `apple` and a display's `input`
  (#406); the helper a `display` command; and core's Cua socket a leading
  `~/`. Nothing else changes.
- 030's sudoers rule is written for each box's user by the helper, and
  removed with the user.
- The pool's guide, settings text and doctor gain Macs, and its `hostOs`
  may be null.

## The live check

No Mac was set aside yet, so a stand-in ran step 6 of the plan first
(#381): a macOS 27.0 VM under Tart, with 4 cores, 8 GiB of memory and a
41 GiB disk. `setup-mac.sh`, the person's steps, the pool backend, its
doctor and the conformance suite ran against it. The runner ran inside the
VM and reached the helper through the VM's own SSH, also as the jump host,
so its load is in the timings: the load average was 18 to 129 during
resets.

| What | Time |
| --- | --- |
| `setup-mac.sh`, with Homebrew already in the image | 35 s |
| `machine status` | 0.25 to 0.35 s |
| `machine status grants` | 0.43 to 0.69 s |
| `machine status xcode`, with no Xcode | about 0.2 s |
| the doctor, 14 checks | 0.49 to 0.72 s; 0.83 to 1.08 s through the jump host |
| capacity | 0.27 s; 0.44 s through the jump host |
| acquiring `macos-desktop` | 0.71 to 1.29 s, of which the claim 0.33 to 0.55 s and SSH 0.24 to 0.32 s |
| the display's sign-in: `display`, `ssh -W` and type 30 | 2.42 to 3.41 s |
| the first full frame, 2048 by 1536 | 3.4 to 3.95 s |
| Cua as the box user: opening, then `list_windows` | 0.11 to 0.20 s, then 0.03 to 0.04 s |
| `sysadminctl -addUser`, with the password on stdin | 1.40 s |
| a release: the old user logged out | 2 s in |
| a release: the sweep | 21 to 37 s |
| a release: userspace restarting | 20 to 25 s in |
| the next user's Dock, after `launchctl reboot userspace` | 7 to 10 s; 16 to 22 s without the version stamp |
| bb-box's next call, once the user is signed in | 0.66 to 0.87 s |
| a full restart of the VM, to the next user at the console | about 25 s |
| restarting loginwindow, to the next user at the console | never, within 60 s |

The conformance suite passed for `macos-desktop`. Acquiring took 1,285 ms,
copying 32 MiB in and out 453 ms, and opening TextEdit 2,167 ms. It skipped
enrolment, as there was no BB server, resizing, and stopping and starting.

It also found:

- Plain `status` takes well under a second, so a claim's wait and each
  survey still ask the helper rather than test the console themselves.
- Type 30 showed the box user's desktop, and Cua's socket was ready at
  each claim, as the reset had signed the user in.
- With Full Disk Access, the sweep removed `~/Library/Containers` and
  `~/Library/Mail` with the rest: 339 entries.
- A file the reset cannot remove, made with `chflags schg`, which only
  root can set, failed the release at 25.4 s. The Mac went out of service
  with the file's name as the reason, the console stayed at the login
  window, and the old user did not come back. Once the flag was cleared,
  returning the Mac to service reset it and signed the next user in. The
  doctor now says when a reset stopped before signing anyone in.
- A user made again with an earlier user's name and ID met that user's
  cached groups, and Screen Sharing refused it. The helper flushes the
  directory service's cache after the group joins.
- While userspace restarts, the directory service does not answer, so the
  helper makes no user then.
- `atq` names no job's owner. A user's at jobs are files it owns in
  `/private/var/at/jobs`, so the sweep removes them.
- For the pool as a whole: a jump host's key needs `command="false"`
  before `restrict,port-forwarding,`, as `restrict` alone still lets the
  key run commands.

A Mac set aside, as under the hardware above, must still confirm:

- that the person's Accessibility step lets the input helper post events
  over SSH with System Integrity Protection on, as the stand-in's image
  came with the grants ([below](#the-viewers-input)), and that the
  doctor's check tells a Mac with the step from one without;
- the sweep without Full Disk Access, and whether reading one byte of
  `TCC.db` tells whether SSH has it. Tart's image has System Integrity
  Protection off, so root removed the protected folders and read `TCC.db`
  without Full Disk Access;
- that Full Disk Access for remote users is off on a new Mac, and the
  person's step that turns it on;
- the console's size with no display, with and without an HDMI dummy
  plug;
- whether Cua's first screen capture as a new user asks for the 30-day
  confirmation, as `list_windows` captures nothing;
- Xcode, which the VM had no room for, with 1.4 GiB free: the sweep's
  time with it, and a new Simulator device's first boot, which decides
  whether the reset boots one ahead;
- a release whose SSH the userspace restart cuts from outside the Mac,
  tested only on the fake Mac, as the runner was inside the VM;
- a full restart's time on real hardware;
- the timings without a runner on the same Mac, and enrolment, with a BB
  server.

### The viewer's input

Core's probe on the stand-in (macOS 27 under Tart, type 30 as the
console's user) showed the console and survived reconnects, but Screen
Sharing ignored the viewer's keyboard and pointer. `screensharingd` logged
"ignore key event", and `ScreensharingAgent` "viewer did not set keyboard
source". A pool's Macs take the same path. Without a fix, a person could
not type or click in a Mac box's desktop, so taking control
([008](008-shared-control.md)) would do nothing there, nor answer Cua's
30-day confirmation in the viewer. The agent's computer use was not
affected, as Cua posts its own events.

What #406 tried, in the order this record had set:

1. **A Screen Sharing setting: none works.** Remote Management with every
   privilege for all users (`kickstart -activate -configure -access -on
   -privs -all -allowAccessFor -allUsers`), the VNC password with
   `VNCAlwaysStartOnConsole`, and turning Screen Sharing off and on again.
   The log said the same each time.
2. **What Apple's client sends: not tried**, as 3 works.
3. **Input through the box's session: works, with a helper of ours.**
   - Cua Driver does not fit. Its API takes whole gestures aimed at an
     app's process, with no separate presses and releases of keys and
     buttons, and System Settings ignored its clicks sent in the
     background.
   - A JXA script run with `osascript` in the box user's session, posting
     at the HID event tap with `CGEventPost`, moved the pointer, clicked,
     dragged, scrolled, typed with Shift and ran Command shortcuts, at
     about 0.4 ms an event. System Settings took its clicks and typing
     too, so a person can answer macOS's own prompts in the viewer.

   This is the design under the desktop above. It needs no Screen
   Recording grant and no 30-day confirmation, as Screen Sharing still
   captures.
4. **A VNC server of our own: not needed.** It stays the way to resize
   the desktop later, at the cost of Screen Recording, a LaunchAgent and
   each new user's 30-day confirmation.

### On the Mac set aside

A Mac Studio, M5 Max, 32 GB, on macOS 27.0.1, ran the check from 15
October 2026 (#47), with no display attached.

- One reset in the conformance run ended in a kernel panic, and the Mac
  restarted: "DCPEXT0 PANIC - power_down_M3: auto_mode_change failed",
  the display coprocessor of the external display port failing a mode
  change as it powered down, likely in the userspace restart's display
  change with nothing attached. 13 resets after it did not panic. An HDMI
  dummy plug may prevent it: once one is in, a batch of resets counts the
  panics.
- A restart takes the Mac off its network for about a minute. A release
  whose first reset call lost SSH then put the Mac out of service at once.
  So the pool now asks such a Mac again until it answers, and shows it as
  resetting meanwhile. Only a Mac silent for 5 minutes in its reset goes
  out of service.

## Plan

Small PRs, in this order:

1. This record.
2. Core: the relay answers Apple's authentication for `DisplayAuth`
   `apple`, tested against the fake RFB server; a Cua socket may start
   with `~/`.
3. The macOS helper, `setup-mac.sh` and the home template, tested on Linux
   with stub macOS tools.
4. The pool lends Macs: macOS lines and offers, sizes, the display through
   the box's SSH with the helper's `display`, `hostOs`, and the doctor's
   Mac checks, on the fake helper. After 2 and 3.
5. Xcode and the Simulator: the features, the doctor's checks, and a
   conformance check that boots a device for offers with `ios-simulator`.
6. The live check on a Mac set aside, then an amendment with what it
   measured. A stand-in ran it first (#381); a Mac set aside runs it again
   for what the stand-in could not check, as under
   [the live check](#the-live-check).
7. The viewer's input on the pool's Macs (#406): the display's `input`
   through core's `MacInput`, the grant in `setup-mac.sh`'s steps for a
   person and its pane, and the doctor's check, on the fake helper. Before
   a Mac set aside runs 6 again, which checks it.

2 and 3 can be built at once. Nothing before 6 needs a Mac.
