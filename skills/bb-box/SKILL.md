---
name: bb-box
description: Boxes for BB threads, Linux, macOS or Windows computers for commands, builds, tests, servers and Docker, and the bb box command to set up, check and clean up their backends.
---

# bb-box

BB Box gives each BB thread its own boxes: Linux, macOS or Windows
computers that start in seconds. A box belongs to the thread that acquired
it. It goes when the thread releases it with `box_release`, or a few
minutes after the thread is archived or deleted. Boxes do not expire. Push
your work to Git, or copy it out, before a box goes: its disk goes with it.
To free a box's memory and CPU but keep its disk, stop it with `box_stop`.

Every tool's answer ends with a `Next:` line that says what to do next. The
tools, and each of their parameters, are in the
[tool reference](../../docs/reference/tools.md). This skill says what the
tools do not.

## Choosing a box

`box_list` shows the kinds on offer, their sizes, where each can come from
("On: ..."), and the project's images, with whether each has a spare ready
where it is built ahead, which its boxes claim at once (#440). The
[kinds reference](../../docs/reference/kinds.md) describes every kind.

`box_list` lists only the providers this thread's project may use. A
provider the user kept for certain projects comes first for their threads,
and is not listed for any other thread; naming it in `on` is refused. Ask
the user rather than look for a way round it.

- A kind's providers say what their boxes are, in brackets after each
  name, where that differs: VMs, containers, or an SSH host pool's
  physical machines, each lent whole with its own cores, memory and, on a
  Mac, GPU and Xcode. Choose a physical Mac for its whole GPU and speed, and
  a VM for root or a size of your own. `on` takes the
  name, with or without the brackets. `box_acquire` and `box_status` say a
  box's form on their Form line, such as "a physical Mac, lent whole".
- A box can change size after it is made with `box_resize`, where its
  provider can: box_list says per kind what changes live and what needs a
  restart (061). Parts you leave out stay as they are, and the disk only
  grows. A live change keeps everything in the box running, so you can
  resize the box your thread runs on. A change that needs a restart ends
  everything running in the box: BB Box makes it only with `restart: true`,
  never for the box your thread runs on, and not while a person holds the
  desktop or a thread works on the box. `check: true` says what would
  change first. A live shrink of memory below what the box uses is refused.
  BB counts a machine's processors only when its daemon connects, and sets
  its automatic thread limit from them. After a live change of cores,
  BB Box restarts BB's daemon on the box when no thread works there and
  no BB terminal is open there;
  otherwise its answer says how to set the limit by hand.
- Ask for the kind's default size when you can. A kind can keep spare boxes
  ready at that size, and then a box is ready at once. On Proxmox's Windows
  VMs and Tart's macOS and Windows VMs, a spare waits stopped, and it takes
  a few seconds to resume.
- Linux boxes run Ubuntu 24.04 with build tools, Git, Python with `uv`,
  Node.js with pnpm and Yarn, Docker, `gh`, `rg`, `fd`, `jj`, and the Claude
  Code, Codex and Pi CLIs. Desktops add XFCE, Chrome, Mousepad, Ristretto,
  Evince and CJK fonts. Wayland desktops (`linux-desktop-wayland-cpu`) run
  Ubuntu 26.04 with Sway instead of XFCE, and the same apps on Wayland; X11
  apps do not run there.
- `sudo apt-get install -y <package>` works at once. If apt answers 404 Not
  Found, run `sudo apt-get update` and try again. `box_status` says whether
  the box user can use `sudo`.
- Ask for `linux-docker` when you need Docker for sure: it skips offers
  without it. A box in Docker runs no systemd, so `systemctl` does not work
  there.
- Docker snapshots pause the box while copying its disk and Docker data, for about as long as `box_snapshot` with `check` says. They hold no memory or running programs. Take, list, delete, restore and fork are available, and the person can keep one: it stays on the box's Docker engine after the release, until its date. A restore makes a new container with the box's ID and name, after an undo, and deletes the old one once the new one runs. A fork is a new container with the fork's own ID, from a snapshot taken with identity reset version 7, or 9 for a desktop, of a box made from an image built with the fork hold, and it has no GPU. Nothing in a fork runs, not even its inner Docker or its desktop, until BB Box's check passes. Release deletes the snapshots nobody kept. Other writable mounts are refused before pausing.
- Docker boxes keep their Docker data in a volume labelled for the box and install. A failed removal is reported. Maintenance retries removal after the container has gone, leaving live boxes and boxes being made alone.
  A held volume does not stop other maintenance.
- Ask for `linux-vm` when you need a kernel of your own: to load kernel
  modules, or for systemd as on a real machine. Ask for `linux-kvm` when
  the box must run VMs or emulators itself, through `/dev/kvm`: a VM on
  Proxmox, which starts in about 10 s and holds its memory while it runs,
  or a box on a Namespace Linux machine of its own, ready in about 25 s and
  billed by the minute. A plain `linux` box starts sooner, so ask for these
  only when you need them.
- A `linux` or `linux-desktop` box on x86_64 can have an NVIDIA card, where
  its provider has cards. Ask with `gpu`: `none`, `shared`, one card other
  boxes may share, or `whole`, a card to itself, where its provider has
  whole cards on. Left out, the box gets its kind's GPU when not asked for,
  which `box_list` gives: shared for `linux-desktop` and none for `linux`
  unless the user changed it. `box_list` says which providers have cards,
  the room on each card and whether whole cards are on.
- In a box with a GPU, `nvidia-smi -L` lists the card; on Docker it lists
  every card, and `nvidia-smi -i "$NVIDIA_VISIBLE_DEVICES"` shows the box's
  own. CUDA sees the box's card as device 0. The box has NVIDIA's driver
  libraries but not the CUDA toolkit: PyTorch's wheels bring their own
  CUDA. Never install NVIDIA's driver packages from apt. A shared card has
  no memory fence, so keep within the memory `nvidia-smi` shows free; a
  PyTorch process takes about 650 MiB before it allocates anything.
- When no card can take a box, the refusal names the boxes on each card.
  Ask for `gpu: none`, or ask the user; never release, stop or resize
  another thread's box to free a card.
- `box_resize` changes a box's GPU: `check: true` first, then
  `restart: true` where adding or taking away a GPU needs a restart, on
  Proxmox LXC. Shared to whole card and back are live where no other box
  runs on the card. On Docker only that switch is possible. `box_fork`
  gives a fork no GPU unless asked, and only a desktop's fork can have one.
- After the host's NVIDIA driver changes, `nvidia-smi` in an older box says
  "Driver/library version mismatch". Ask the user to update the box's
  userspace with `bb box gpu update <box>`: it restarts the box.
- An `ios` box is a macOS VM with one iOS Simulator device booted, shown to
  the person in the panel. `box_list` names its devices; `device` picks one,
  such as `box_acquire({kind: "ios", device: "iPhone 17"})`, and the first
  is the default. With `wait`, `box_acquire` answers once the device has
  booted, at most 120 s, and `box_status` gives its Device lines: the
  model, its iOS and Xcode, and its state. Build and run on the host with
  `box_run`: `xcrun simctl` takes `booted` as the device, as in
  `xcrun simctl install booted App.app` and
  `xcrun simctl launch booted <bundle id>`. Build for the simulator, with
  `-sdk iphonesimulator`. The device is slim: widgets, Siri, iCloud,
  Health, Wallet and the like are off, for a quarter of the memory. Ask for
  `slim: false` for an app that uses one of them; its first boot then takes
  about a minute more. Do not open Device Hub on the host: it
  takes the device's clipboard, and BB Box closes it.
- Where `box_list` says a shared iOS host is set up, an `ios` box is shared
  by default: a macOS user on a Mac or VM shared with other ios boxes, ready
  in seconds, with its own device, files and keychain, but no sudo, Homebrew
  installs or app windows, and cores and processes shared. Where no host has
  room, or you ask for another device than the first or `slim: false`, it
  is a macOS VM of its own instead; `shared: true` refuses rather than do
  that. Where no shared iOS host is set up, each `ios` box is a VM of its
  own. Servers on
  localhost in a shared box are reachable from every box on its host: start
  yours on your box's ports, from `BB_PORT_BASE`, such as Metro with
  `--port $BB_PORT_BASE`; the common dev ports are held and answer an error.
  Ask for `dedicated: true` when the box must have a VM of its own: a build
  that needs the cores, `brew install` or sudo, an app that needs fixed
  ports, Xcode's window, another device than the first, or a project with
  its own ios image. Give `dedicated: true` with a `size`, `cores`,
  `memory_gib` or `disk_gib` for an ios box: a shared box has no size, and
  where a shared iOS host is set up, a size without it is refused.
  `box_status` says where the box is, on its Where line.
- A `macos` box is a macOS VM of its own unless it asks for `shared: true`,
  where `box_list` says so on the macos kind's line. A shared macos box is a
  macOS user on a shared iOS host, ready in seconds, for commands, builds,
  `simctl` and XCUITest runs, with its own files and keychain. It has no
  sudo, Homebrew installs, desktop, app windows, screenshots, computer use
  or `box_grant`, and its cores, ports and processes are shared: start
  servers on its ports, from `BB_PORT_BASE`. It has no device of its own;
  make one with `simctl create`. Leave `shared` out for a build that needs
  the cores, sudo or `brew install`, or acquire `macos-desktop` for app
  windows and macOS UI tests.
- An `android` box is a Linux VM with one Android emulator device booted,
  a Pixel 8, Pixel Fold or Pixel Tablet, shown to the person in the panel.
  It has no desktop. `device` picks the model as for `ios`, and the device
  boots from its snapshot in about 3 s once the box is up. Build and run on
  the host with `box_run`, where the Android SDK is in `/opt/android-sdk`
  and `adb` reaches the device as `emulator-5554`, as in `adb install
  app.apk` and `adb shell am start -n <package>/<activity>`. Its apps and
  data stay through a stop and start of the box. If the emulator ends
  without saving, as when it crashes, BB Box boots it cold, in about 15 s,
  which keeps what Android had written to its disk: run `adb shell sync`
  after `adb install`, so a crash cannot lose the app; `box_device`'s
  `install` does that itself. Each device gets its own Android ID the
  first time it boots in a box, which takes about 25 s more, once.
- Cloud providers cost money while a box exists, so release such a box as
  soon as you are done. Hetzner Cloud's Linux boxes are containers on hosts
  BB Box makes as boxes need them: a box on a host with room is ready in
  seconds, and one that needs a new host in about a minute. A Namespace Mac
  is a Mac of its own, ready in about 20 s, or about a minute with its
  desktop, that ends at the plan's longest
  life whatever you do: `box_status` says when ("Ends"), and the thread is
  told an hour before. Copy out what you need before then. Where the user
  has several Namespace workspaces, `box_list` names each, such as
  Namespace (team-b), and `on` takes that name.
- Windows boxes have Visual Studio Build Tools (MSVC and the Windows SDK),
  LLVM (`clang`), Rust (`cargo`, `rustc`), Node.js, and the Claude Code,
  Codex and Pi CLIs. They have no GPU: DirectX apps render on WARP,
  Windows' software renderer.

## Running commands

`box_run`'s description gives its timeout, its jobs after 270 s and how to
keep a server running. Its answers, and `box_job`'s, say what to do when
BB Box restarts. Beyond those:

- A command that exits with a non-zero code is not a tool error. A command
  that times out is.
- A box can stop on its own, as when its VM crashes. The tool's error and
  `box_status` say when and why. BB Box starts it again unless it crashed in
  the last 10 minutes.
- Each command reads `~/.config/bb-box/env`, which sets `BB_BOX_ID`,
  `BB_BOX_NAME`, `BB_BOX_KIND`, `BB_THREAD_ID`, and `BB_HOST_ID` once the box
  is a BB machine.
- On a Mac, only a desktop command (`desktop: true`) reaches the login
  keychain, which git's keychain helper and Xcode's signing use.
- macOS boxes have Google Chrome as well as Safari, on Tart images and pool
  Macs set up since Chrome was added. Chrome updates itself.
- A macOS box's microphone is BlackHole 2ch, a virtual device: what is
  played to it comes back as the microphone. Feed an app speech with
  `say -a BlackHole "Hello"`; its system audio is what plays to the default
  output. Start the app with `desktop: true`, which has the microphone and
  the system's audio without a prompt.

### macOS permissions

On Tart's macOS boxes, and on Macs of the SSH host pool with System
Integrity Protection off, `box_grant` grants a program macOS permissions
with no prompt: Accessibility, Screen Recording, Input Monitoring, the
microphone, the camera, the system's audio (`system-audio`, which Screen
Recording does not cover), or Automation of one app. `box_status` lists the
box's grants. They go with the box: a Tart VM is deleted, and a pool Mac's
reset removes them. Linux and Windows boxes refuse.

- Grant only the program that needs it, under the box user's home or in
  `/Applications`. BB Box grants nothing to Apple's programs, shells,
  terminals or interpreters.
- Sign the program first, with the box's own identity, so a rebuild keeps
  the grant: `codesign -s "bb-box local code signing" --identifier
  <id> <program>`. Xcode can sign with it too. A command-line program
  signed only ad hoc is granted by its path, which also survives a rebuild.
- A grant applies only when the program is its own responsible process.
  Open an app with `open`. On a Mac of the SSH host pool, run a
  command-line program through `bb-box-own <program> <arguments>`. On
  other Macs, start it through launchd from a `box_run` command with
  `desktop: true`: `launchctl submit -l <label> -o <log> -- <program>
  <arguments>`, then `launchctl remove <label>`. A program `box_run` runs directly is
  charged to SSH instead, which has Accessibility, Screen Recording, the
  microphone and the camera already.
- Start the program again after a grant: macOS reads some permissions only
  at launch.
- The Mac's microphone is BlackHole 2ch, as above. A box has a camera only
  if one is attached to the Mac.

### Windows

The Windows kinds' descriptions in `box_list` say how commands run there.
Beyond those:

- A Windows box is a BB machine, as a Linux or macOS box is, so
  `box_thread` can start a thread there, on an agent CLI in its image. It
  takes a minute or two to join BB, or none from a spare.
- Type `pwsh` for PowerShell 7, never `powershell`, which is Windows
  PowerShell 5.1.
- `Start-Detached` gives the command it starts the environment variables,
  but not PowerShell variables: pass values in `$env:`.
- For a GUI program's window to show, call `Start-Detached` in a desktop
  command (`desktop: true`).

## Copying files

`box_copy`'s description gives its sizes and paths. Beyond those:

- A copy that fails leaves the target as it was.
- The machine that holds the workspace or storage folder must be connected
  to BB, as it is while the thread runs there.

## Snapshots

Where a box's backend takes them (`box_status` and `box_list` say), a
snapshot keeps a box's disk, or with `memory` its running apps too, so you
can put the box back to it. A Windows desktop on Proxmox QEMU snapshots its
disk while it runs, including the EFI and TPM state volumes, and restores in
place with an undo on LVM-thin, Ceph RBD, BTRFS and qcow2. It takes no
memory snapshot. Fork and Keep refuse, because a Windows box has no identity
reset BB Box has checked. On ZFS, take and delete work, and restore refuses
for that reason.

An Android box on Proxmox QEMU snapshots its whole VM disk while running,
including Android data and Linux host files. Restore uses a snapshot undo
on LVM-thin, Ceph RBD, BTRFS and qcow2; ZFS refuses restore. Memory, fork
and Keep are refused because memory restore and identity reset are unproved.

An iOS box with `dedicated` on Tart snapshots its whole macOS VM with its
memory, so a restore brings its device back booted, with the device, apps
and data it had when the snapshot was taken. A fork boots the device
afresh. A shared iOS box takes no snapshots: it has no VM of its own.

BB Box starts an Android model cold when its unsaved marker is present. A snapshot taken while that model runs keeps the marker, as does an undo taken after a hard stop. A clean emulator save removes the marker, so a matching quick-boot save can still load after a host restart. New boxes can use the image's quick-boot saves. Wait for Android to finish booting before running adb commands.

- Take one with `box_snapshot` before a change you cannot undo: a
  migration, an upgrade, a deletion, or a change to the system. Take one
  when the person asks. Never take them on a schedule of your own.
- A take can pause the box: nothing in it runs until the take is done.
  Call `box_snapshot` with `check` first to see whether it pauses the box
  and for about how long. Tell the person before a pause of more than a few
  seconds, such as a large Docker box's. Docker, microsandbox, Tart's
  macOS VMs, including iOS boxes with `dedicated`, and Proxmox all pause a
  box that runs. The take's answer says
  how long it paused the box, or that its backend cannot measure it, as
  Proxmox cannot.
- When an attempt went wrong, restore with `box_restore` rather than
  undoing it by hand. BB Box always takes an undo first, named "before the
  restore at 11:02": restore that to undo the restore. On ZFS, a Proxmox
  LXC box restores only its newest snapshot, and its undo is a full copy
  of the stopped box. Restoring that undo moves the box to a new guest
  with the same identity, and its other snapshots then fork only.
- `box_snapshots` lists what you may see of a box's snapshots. Delete your
  own with `box_snapshot_delete` once they are no longer needed. A box holds 5 unless the person set otherwise; when you take one
  past that, BB Box deletes the oldest one an agent of this thread took.
  You cannot delete or restore a kept snapshot. You delete only those an
  agent of this thread took; on a box you run on, you see only those.
- Only the person keeps a snapshot, so that it outlives the box's
  release; no tool keeps one. If a state should outlive the box, say so
  and let the person keep it, on the box's page or the Snapshots tab.
- To try two things from one set-up state, fork the box with `box_fork`:
  a new box of this thread from one of its snapshots, or from the box now.
  The fork has the snapshot's files and its own BB machine, address and
  keys; everything else on the disk comes with it. Only a snapshot taken
  with a working identity reset forks, and only from a box of this thread
  that you do not run on.
- A refusal that says to try again holds only for now, such as a host's
  storage too full or a backup running: try again later.
- When Settings turn agents' restores off, `box_restore` asks for a yes
  in the thread with a form and answers at once. Then end your turn; the
  result comes to the thread as a message.
- A box threads run on, the box your thread runs on or one of the person's
  machines, is not restored for now: BB Box says so. When that changes, it
  too goes through the form, and on the box your thread runs on, nothing
  you do after asking survives the restore: your session there goes back
  too.
- Never answer one of BB Box's forms yourself, with `bb thread
  interactions` or any other way. Only the person answers them.

## A box's files

A person opens a box's own files from the box's row, its page, or the Files tab beside the thread. That view is the box user's files, not the thread workspace: a tree, tabs, search, go to file, find in the file, and a Markdown preview. New file and New folder are icons on the tree. A row's menu creates, renames and deletes, and delete asks for confirmation. On a narrow window the tree and the open file take turns. A device box has no Files view. Switching panels keeps drafts and view state in app memory, within eight hidden workspaces and 32 MiB in total. Save before reloading the app; a released box loses that state. Agents still read and change files with `box_run`, or from the terminal.

## Desktops and computer use

Open an app or a URL with `computer_launch`, then read a window with
`computer_observe`, act on it with `computer_act` and type with
`computer_type`. Their descriptions say how. Beyond those:

- A person can take control of a desktop from BB. While they hold it, every
  computer tool refuses at once; call `computer_take_control` only when they
  ask you to continue or have clearly finished. Afterwards, observe the
  window again: the references and images from before are gone.
- A reference stays valid while its element is on screen. When it has gone,
  the tool says so: observe the window again.
- When an app refuses input in the background, BB Box uses the real pointer
  or keyboard, and says so. The desktop's focus may then have moved.
- On a Wayland desktop, text that goes through the real keyboard is typed
  with a US keyboard layout. Text with a character that layout lacks, such
  as `é`, is pasted instead: BB Box puts it on the box's clipboard, presses
  Ctrl+V (Ctrl+Shift+V in a terminal), then puts the clipboard's text back,
  so an app that reads key presses, such as a game or a shortcut field,
  gets one paste. A box from an older image pastes all text. Keys and
  chords, such as `Return` or `ctrl+a`, are still pressed.
- On Windows, a window with no title gets the title "<app> (untitled)", as
  Cua reaches only windows with one: `computer_launch` names it at once, and
  `computer_windows` names it in the background and lists it on a later
  call, within about 15 s, and each says so. An app that draws everything
  itself, such as a GPUI app, has no accessibility tree: drive it with
  `computer_screenshot` and pixel actions.

## Computer use on a device

On an ios or android box the computer tools drive the device, never the
host: use `box_run` for the host.

- The device is one window, window 1. `computer_observe` gives its
  accessibility tree, with each element's identifier where the app gives
  one, as in `button "General" (id com.apple.settings.general)`. An alert
  shows inside it. Elements below or above the screen say so: scroll to
  them first. On Android the app in front comes first, then the status
  bar, then the keyboard as one element: type into a field rather than
  tapping keys.
- `computer_act` taps for a click and long-presses for a right click.
  Before a tap by reference it checks what is at that point, and refuses
  when something else covers the element, such as a title bar or the
  keyboard. Scroll it clear, or tap what you see by pixels.
- `scroll` swipes within the list that holds the element, a fifth of it a
  step, and stops when the list moves no further. `set_value` sets text
  fields only. Move a slider with `drag`, from x and y to `to_x` and
  `to_y` in your latest `computer_screenshot`.
- `computer_type` types what a US keyboard has as keys, and pastes the
  rest. Give `keys` such as `Return` in the same call: BB Box presses them
  once the field holds the text, and says so when it never does. `cmd` is
  the Command key on iOS; on Android `ctrl+a` selects all.
- `computer_launch` opens an app by bundle ID, package or name, such as
  `Settings`, or a URL. An app just started takes a few seconds before iOS
  shows its elements: the tool waits for them, about 4 to 6 s in all. On
  Android it takes 1 to 2.5 s.
- Web pages: iOS gives a page's elements only one point at a time, so in
  Safari, or another app showing a web page, BB Box reads the page point by
  point, in about 0.4 s, and lists its links, fields and text in a `web
  view` before the app's own controls. An element smaller than the points'
  spacing, 30 points down and a sixth of the screen across, may be
  missing: use `computer_screenshot` to see the whole page. Chrome on
  Android shows a page's contents only some of the time; otherwise the
  tree has a `web view` whose value says the page is not in it.
- An app just started, such as Safari for up to 9 s after its first
  launch, can be in front before iOS shows any of its elements. Its line
  says it is still starting: observe again in a few seconds.
- A switch in a row, as in Settings, is listed at its knob, so a tap by
  reference toggles it. A tap on the row's label does nothing on iOS.
- On a shared ios box, iOS shows a change to a system setting made in
  Settings, such as Dark or Bold Text, only at the device's start: the
  setting changes, but the screen does not until `box_device` reboots the
  device. A dedicated box shows such a change at once.
- While an instrumentation test runs on an Android device, such as from
  `./gradlew connectedAndroidTest`, `computer_observe` and the actions that
  read the tree are refused in words: Android lets one client read the
  screen's elements at a time, and a read as the test starts can crash it.
  Screenshots work, and reading comes back as soon as the test ends.
- A turn or a switch of the device voids earlier references and images.
  Observe again.
- While a person has control, reading goes on, and every other computer
  tool is refused at once.

## A device's controls

`box_device` controls an ios or android box's device as the panel's toolbar
does: Home, lock and wake, rotate, light or dark, text size, location, the
status bar and the battery, install an app, switch to another model, and
reboot; on Android also Back, Recents, the network and, on the Pixel Fold,
its posture.
`box_status` lists the actions the device has. Each answer says what
changed, how long it took, and the device's state after it, read back from
the device.

- `rotate` with `turn: "left"` turns the device a quarter turn
  anticlockwise, the way the toolbar's left arrow points; `to` turns it to
  one orientation. An app that does not turn, such as an iPhone's Home
  Screen, stays upright on a device held sideways, and the screen keeps
  its size.
- `text_size` takes iOS's own content sizes, such as `accessibility-large`,
  or Android's font scales, such as 1.3, or `larger`, `smaller` and
  `default`, which is `large` on iOS and 1 on Android.
- On a shared ios box, `appearance` and `text_size` reboot the device
  after setting it, about 7 to 10 s, as iOS there shows such a change only
  at the device's start. Apps that were open are closed: open yours again.
  A dedicated box changes them at once.
- `status_bar: "clean"` shows 9:41, full signal and a full battery, for
  screenshots. `battery` on iOS changes only the status bar's picture: an
  app that reads the battery sees the Mac's. `status_bar: "live"` clears
  every override, the battery's too. On Android a clean status bar shows
  9:41, full signal and the battery as `battery` set it, and `battery` sets
  what apps read: level, and charging or not.
- `location` sets the simulated location. Leave out both `latitude` and
  `longitude` to clear it. iOS cannot read it back, so the state shows what
  BB Box set. An Android emulator always has a location, so clearing it
  gives back the emulator's own.
- `network` on Android takes `online`, `offline` (airplane mode) or `slow`
  (474 kbit/s each way, 100 ms more on the way out), each a whole preset.
- `install` takes one `.app` in the box, built for the simulator with
  `xcodebuild -sdk iphonesimulator`, or on Android one `.apk`, or the split
  APKs of one app. An Android App Bundle (`.aab`) does not install: make
  APKs from it with `bundletool build-apks --mode=universal`.
- `posture` folds the Pixel Fold: `closed` shows its outer screen, `open`
  and `half-open` its inner one. A turn or a fold voids earlier
  screenshots and coordinates.
- `switch` changes the model. Each model keeps its own apps and settings.
- While a person has control of the box, `box_device` refuses every action
  but installing an app the device does not have. Wait for the hand-back.
- iOS has no Back, Recents or network control, and no iOS device folds.
  `xcrun simctl` in `box_run` does what `box_device` does not, such as
  `xcrun simctl privacy booted grant photos <bundle id>` to give an app the
  photo library, and `xcrun simctl push booted <bundle id> payload.json` to
  send it a push notification. An appearance or text size set this way
  shows in the state as changed outside BB Box, and on a shared box shows
  on the screen only after a reboot. On Android, `adb` in
  `box_run` does the same, such as `adb shell pm grant <package>
  android.permission.CAMERA`.

## Recording a desktop or a device

`box_record` records a desktop box's screen, on Linux, macOS or Windows,
so you can show your work in the thread rather than describe it. Start it, do what the
video should show, then stop it. Its answer gives a line that plays the
clip in the thread: put it on its own in your reply. The line shows a file
of the storage folder of the thread it is in, so BB Box copies the clip to
your parent threads too: a parent can pass the line on in its own report as
it is. Do not write an absolute path into it. Idle stretches are
cut by default, so a long session makes a short clip: do not pause between
steps for the viewer.

- Before you start a recording, clear or dismiss notifications, and close
  windows that do not belong in the video.
- To show a test run, caption each check: before it,
  `action: "step"` with what you check, one short line ("It keeps the draft
  when saving fails"); after it, `action: "result"` with `passed` true or
  false and what you saw ("Draft kept; no error toast"). They are drawn
  over the video, a step at the top and its result under it, and listed as
  chapters under it. Each stays on screen long enough to read, even at
  speed 2 or 4. If what you check is near the top of the screen, such as a
  menu bar or a window's title, start with `position: "bottom"` so the
  captions do not cover it.
- On Windows, BB's Keep Awake opens a "Windows PowerShell" window over the
  desktop when the box joins BB and each time BB restarts there, such as
  after a resume. Minimise it with the computer tools before you record;
  closing it ends Keep Awake, and BB opens another. If typing seems to go
  nowhere on Windows, that window may have taken the focus.
- On an ios or android box, `box_record` records the device's own screen,
  not the host's desktop: the device in its frame, turning as it turns, with
  each touch shown as a circle. The captions sit in a band above the device,
  or below it with `position: "bottom"`, so they never cover the app. No
  viewer needs to be open. Where the device restarts or its server restarts
  during a recording, the clip holds the last picture and says so.

## BB machines

A box joins BB as a machine a few seconds after it is ready, or a minute or
two for a Windows box, so threads and terminals can use it. `box_acquire`,
`box_start` and `box_run` wait up to 20 s for that.

- In a box that is a BB machine, each command gets `GH_TOKEN`,
  your git identity and BB's machine variables from BB. `git` fetches GitHub
  through `gh`, over HTTPS, even for SSH URLs.
- A project's own variables reach a box only while a thread of that project
  runs on it. A command that needs one can run in a thread on the box: start
  one with `box_thread`.
- `box_thread` starts the child on your thread's agent and model when the
  box has that agent's CLI, and otherwise on the first agent CLI the box
  has, with its default model. It refuses a box with none of BB's agent
  CLIs, and names them.
- A box that could not join BB, as when a DNS lookup of BB's address timed
  out, tries again by itself. `box_enrol` tries at once. It runs BB's
  installer in the box. It does not restart, stop or resize the box. It
  stops only the BB daemon of a machine that BB no longer has. A box whose
  machine BB still has is left as it is, and recorded as a BB machine.
- In BB's new-thread screen, "New box" starts a thread on a Linux or macOS
  box of its own, not a Windows one. From a terminal, `bb thread spawn`
  does the same with the environment provider `bb-box-new` and inputs such
  as `{"kind": "linux"}`; give `--model`, since a new box cannot list models
  until it exists.

## A project's image

A project's image is a script run as root on the standard image of its Linux
kinds, so the project's boxes start with what it needs. When asked to make
one, follow these steps:

1. **Draft.** Read the project's files and pass them to `box_image_draft`:
   `.devcontainer/devcontainer.json` and the Dockerfile it names, a
   Dockerfile, `.tool-versions`, `mise.toml`, `.nvmrc`, `.python-version`,
   `rust-toolchain.toml`, or `flake.nix` with `flake.lock`. For a box someone
   set up by hand, give its name as `box` too.
2. **Finish.** Settle what the draft left to you: its answer and the top of
   the script list it. Leave out what needs the checkout, such as `npm ci`:
   a build has no repository. Write the script to `.bb/box-setup.sh`, and a
   check that fails when the script did not do its work, such as
   `cargo --version`, to `.bb/box-check.sh`.
3. **Try.** Call `box_image_try`, which builds the script in a clean box as a
   build will. Fix the script and try again until every check passes. With
   `keep: true`, a box of what it built stays for you to look inside with
   `box_run`; release it after.
4. **Register.** Commit the two files, then call `box_image_set` with their
   text and paths. It changes every new box of those kinds in the project, so
   ask the user first unless they asked for the image. Proxmox LXC, Docker and
   Tart then build the image ahead once it is used, and later boxes start from
   the build; the SSH host pool and GPU desktops run the script as each box
   starts.

## The bb box command

The `bb box` command checks and sets up BB Box; the
[CLI reference](../../docs/reference/cli.md) lists it. To set up a backend,
or change kinds, sizes, spares or options, use the `bb-box-setup` skill. An
agent mostly needs:

- `bb box doctor`, which checks each backend and says how to fix what is
  wrong.
- `bb box setup docker`, when no backend is set up and the user agrees: it
  turns Docker on, on the machine that runs BB, as the Box panel's first run
  does, and waits while the Linux image builds, usually 5 to 12 minutes. A
  box there is a privileged container, root on that machine, so ask first.
  `--no-wait` starts it and says how far the build is; run it again to see.
  Where BB's user cannot use Docker, it prints the lines that fix it, for
  the user to run.
- `bb plugin logs bb-box`, which says why each box was released, and how long
  each step of joining BB took.

The Files view opens one folder level first, then fills quick open in the background. Cached folders refresh quietly. Its tree is on the right on wide windows; the create menu sits beside the path. These panel calls remain unavailable to agents.

Docker snapshots allow LXCFS mounts and leave their contents out. A crash during
a take can leave the box paused for several minutes until maintenance recovers it.
Deleting an image used by another container removes its tag; its layers stay
until Docker can reclaim them. Report the size as an estimate, not space freed.
