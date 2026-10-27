# iOS image

The iOS image is a Tart VM for iOS Simulator boxes
([063](../../../docs/decisions/063-device-boxes.md)). It is a clone of the
macOS image, with:

- idb_companion, Meta's release pinned by URL and SHA-256 in [`pins`](pins),
  with its MIT notice in `/usr/local/share/bb-box/notices`
- a simulator device for each model bb-box offers, in
  [`devices.tsv`](devices.tsv): iPhone 18 Pro, iPhone 17 and iPad Pro
  13-inch (M5), each booted once and shut down
- each device slimmed: the services a device box does not need turned off,
  as below
- each device's keyboard defaults: no autocorrect, smart punctuation,
  predictions or slide to type, and the keyboard's first-use sheet answered
- `bb-box-check-ios`, the image's check
- `device-host`, the helper that lends the VM's slots when it is a shared
  host ([064](../../../docs/decisions/064-ios-shared-hosts.md)), with two
  slots made ahead, `bbd-i1` and `bbd-i2`, as below

Each ios box is a clone of this image. Its device server, which bb-box
delivers to the box, boots the device the box asked for, finds it by its
name and device type, and streams it to the panel through idb_companion.

## What you need

- A Tart backend set up as its [guide](../README.md) says, with the macOS
  image, `bb-box-macos`, built by `prepare-image.sh` from the base with
  Xcode. The iOS image is built on it, and uses its Xcode and iOS runtime.
- A slimming list for the iOS runtime of that Xcode, in [`slim`](slim). This
  bb-box has the list for iOS 27.0 (24A434), from Xcode 27.0. The build
  stops on another runtime, and says how to make its list.
- About 5 GiB more on the Mac's disk than the macOS image takes: the clone
  shares the macOS image's blocks, and adds what the build writes, most of
  it what each device downloads in its first boot. Boxes cloned from the
  image share its blocks in turn.

## Steps

### 1. Build the image

As the host user on each Mac, from a copy of `setup/`:

```sh
cd setup/tart
./prepare-ios-image.sh
```

It clones `bb-box-macos` to `bb-box-ios-build`, boots it, and runs
[`build-ios.sh`](build-ios.sh) in it. That:

1. installs idb_companion and its notice;
2. removes the simulator devices Xcode made, so the only devices are
   bb-box's, named as its models;
3. for each model: makes its device, boots it the first time (21 to 28 s),
   writes its keyboard defaults, slims it, and shuts it down;
4. answers Xcode's Components sheet, and gives the Simulator and Device Hub
   the microphone, which is BlackHole in the macOS image, so neither asks;
5. runs [`host-ios.sh`](host-ios.sh) as root, which installs `device-host`
   and its held ports, keeps each iOS runtime's `disabled.plist` from the
   image's slim devices, and makes the two carried slots (about 55 s);
6. clears the devices' pasteboards, CoreSimulator's logs, Device Hub's
   preferences and idb's state.

Then it runs `bb-box-check-ios`, writes the image's record, shuts the VM
down and names it `bb-box-ios`. It takes about 17 minutes: 7 for the
devices' first boots and slimming, and 10 for the check.

| Option | Default | Meaning |
| --- | --- | --- |
| `--from` | `bb-box-macos` | The macOS image to build on |
| `--name` | `bb-box-ios` | The image to make |
| `--replace` | off | Replace an image of that name. Boxes cloned from the old one keep running |
| `--skip-check` | off | Build without running the check. For a build you then check by hand |

### 2. Configure bb-box

Set the Tart backend's `ios-image` to `bb-box-ios`. Then run
`bb box doctor`. Its check **ios image on** each Mac says:

- whether the Mac has the image;
- its age, its pins against this bb-box's, and whether it is built on the
  macOS image's current build;
- whether its record offers iOS devices;
- whether its idb_companion and Xcode are a pairing an image check has
  passed. A pairing no check has passed fails: a new Xcode can stop
  idb_companion working, as it uses Apple's private frameworks;
- which devices are not slimmed.

## Slimming

An iOS Simulator device starts about 240 processes. A device box needs about
60 of them. The image turns the rest off, for about a quarter of the memory
and almost no idle CPU, as
the slimming research, `docs/research/ios-simulator-slimming.md`,
measured, and as [063 results](../../../docs/decisions/063-results.md#unit-32-the-ios-image)
measured again in this image.

- **The list** is [`slim/ios-27.0-24A434.txt`](slim/ios-27.0-24A434.txt):
  112 launchd labels, every one the research saw running in a stock iPhone
  18 Pro, less 55 kept for stated reasons. Among those kept are
  `nanoregistryd`, `sleepd` and `gamed`: without them `simctl bootstatus`
  never returns, two services retry in a loop at about 4 cores, and every
  XCUITest launch waits about 10 s. Nothing comes from simslim.
- **How:** `launchctl disable system/<label>` for each label, in the device
  through `simctl spawn`, then a reboot, then again, then a count. The second
  pass holds six watch labels the first does not. The build stops unless
  every label is disabled, after the second pass and after a further reboot.
- **What a slim device lacks:** widgets, wallpaper posters, Siri, Spotlight,
  Health, Home, Wallet, iCloud, Mail, News, Weather, Screen Time, Game
  Center's own services and Apple's push service. An app under test that
  uses one of them needs a box with `slim: false`.
- **The record** names each device's list, its labels and its SHA-256.
- **In each box,** the device server counts the list's labels in
  `launchctl print-disabled system` each time it boots or reattaches to the
  device, about 0.3 s. When some are on, as in a device made in the box or
  after a later Xcode clears them, it turns them off and reboots the device
  before its first frame: 8 s for three labels, 30 s for all 112.
- **A box with `slim: false`** has every label of the list turned on by its
  device server, and the device rebooted, before its first frame: 43 s for
  the 112, measured.
- **A new runtime** needs its own list: the labels change between runtimes.
  Make it from a stock device of that runtime with the research's
  `lists.py full`, and check it with `bb-box-check-ios`.

## The image's check

`bb-box-check-ios` runs at build, and in a refresh's trial box. Each line
says `ok` or `FAIL`, and it exits 1 if any fails. For the image it checks
idb_companion runs, its notice is there, and Device Hub is not running. For
each device it checks:

| Check | Fails when | Why |
| --- | --- | --- |
| boots | `simctl bootstatus` does not return within 60 s | a device can draw its Home Screen and never report booted, as without `nanoregistryd` |
| slim | not every label of the list is disabled | |
| keyboard | a keyboard default is not off | typed text must arrive as typed |
| pixels | a screenshot's size is not the model table's | the frame is drawn from the table |
| appearance | dark or light, once set, does not read back, or the first is not set again | box_device sets it and reads it back |
| text size | any of the 12 text sizes, once set, does not read back, or the first is not set again | box_device sets it and reads it back |
| status bar | an override of the time and battery is not listed, or is still listed once cleared | box_device sets it and reads it back |
| lock state | `notifyutil` does not read the lock state, or reads it locked just after boot | the device's awake state comes from it |
| idle cpu | the device's processes use more than 0.1 of a core over a minute, after a minute to settle | a service can fail loudly, as without `sleepd` |
| xcuitest launch | an XCUITest launch takes over 3 s to reach its automation session, or the test fails | a service can fail quietly, as without `gamed` |

For a shared host it checks:

| Check | Fails when |
| --- | --- |
| device-host | the helper is not installed, or does not run as root |
| device-host daemons | `install` did not write the plists of `app.bb-box.device-host` and its held ports, or launchd has either loaded before `init` |
| held ports free | anything listens at 3000, 4200, 5000, 5173, 8000, 8080, 8081 or 19000, on 127.0.0.1 or ::1: a dedicated box keeps them for its own servers |
| carried slots | `bbd-i1` or `bbd-i2` is missing, not ready, its device not seeded, or booted |
| slot uids | any file on the Data volume is owned by a UID from 80000 to 89999, or from 79990 to 79999 but the carried users' own |
| disabled.plist kept | the image kept no runtime's `disabled.plist` |

It builds a small app with a UI test, [`probe`](probe), for the last. Give
model names, separated by commas, to check only those:
`bb-box-check-ios "iPhone 17"`.

## Refresh

The nightly job refreshes the iOS image as it does the macOS image (049):
after 30 days, or when the macOS image has a newer build than the one the
iOS image is built on, or when this bb-box's pins differ. It runs
`prepare-ios-image.sh` on the Mac, starts a trial box from the new build,
runs the check there, and gives the build the image's name only if it
passes. It never pulls a base, and never removes the macOS image.

## Device Hub

Xcode 27's Run opens Device Hub, even when the device is booted already,
and no preference found stops it
([063 results](../../../docs/decisions/063-results.md#e20-xcodes-run-and-device-hub)).
Device Hub takes the device's pasteboard, so pasting stops working. The
image never starts it, and clears its preferences. Quitting Device Hub shuts
the device down, so in each box the device server looks for it every 5 s and
kills it (SIGKILL), which leaves the device booted: 2.9 s after it opened,
measured. `bb box doctor`'s check **Device Hub in** each ios box says whether
it runs, and how often the server has killed it.

## Shared hosts: device-host

A shared host is a VM of this image that lends slots: a macOS user with its
own device, many to a VM
([064](../../../docs/decisions/064-ios-shared-hosts.md)). Its helper,
[`device-host.sh`](device-host.sh), is installed as
`/usr/local/libexec/bb-box/device-host`, and runs as root. bb-box runs it
through sudo as the image's user. Input is one `name=value` a line on stdin.

| Command | What |
| --- | --- |
| `init` | stdin: `most`, `ahead`, `resetting-most`, `disk-reserve-gib`. The host's settings, kept as given the first time. Loads the helper's daemon and the held ports' daemon, which launchd then starts at every boot; run again, it leaves them running |
| `status` | the host, its promises, each slot with its state, ports, device and load, and the last sweeps |
| `make` | stdin: `install`, `box` (the box it is made for, if any), `server` (a device server's folder to copy). Makes a slot and answers its user, UID, device and ports |
| `promise` and `unpromise` | stdin: `install`, `box`. Holds a place in `most` for a box |
| `claim <slot>` | stdin: `install`, `box`, `thread`, `name`, `kind` (`ios` or `macos`), `created`, `key`, `server`. Lends a ready slot; the claim marker is made with `ln`, so one claim wins |
| `release <slot>` | stdin: `install`, `box`. Removes the slot's user, queues its sweep, and answers `last=yes` when no other claim, promise or slot made for a box is left, having written `deleting` under the lock |
| `daemon <slot>` | stdin: `install`, `box`. Moves BB's daemon, as its installer left it with `BB_INSTALL_SKIP_SERVICE=1`, into a LaunchDaemon as the slot's user |
| `reset` | runs the sweep queue: one `find` over the Data volume a pass, for at most `resetting-most` UIDs |
| `resume` | carries on every slot whose step was cut short, and the sweep queue. Run at every boot by the helper's own daemon, on a host that has run `init`; in any other VM that daemon's `run` returns at once |
| `carry` | the image build's: makes the carried slots `i1` and `i2`, their devices shut down and their daemons written but not loaded |
| `install` | writes the helper's daemon, `app.bb-box.device-host`, and the held ports' daemon, `app.bb-box.device-host.ports`. It loads them only on a host that has run `init`, and takes them out of launchd elsewhere, so a dedicated box from the image keeps the common dev ports free |

Exit codes: 0 done; 1 failed, with words; 2 usage; 3 lost a race, ask
again; 4 not this box's; 5 no room; 6 the slot is not ready; 7 the host is
being deleted, ask again.

- **Slots.** Slot `n` is user `bbd-n` with UID 80000 plus `n`; the carried
  slots are `bbd-i1` and `bbd-i2`, UIDs 79991 and 79992. A UID is never
  given again while the host lives. Each user is standard and hidden, in
  `_developer` and, where it exists, `com.apple.access_ssh`, with the
  pool's `.zshenv` and a home of mode 700.
- **Devices.** Each slot's device is the first model of `devices.tsv`,
  made by `simctl create` in its user and seeded with the runtime's
  `disabled.plist` before its first boot.
- **Ports.** Each slot has 100 ports from `BB_PORT_BASE`, 20000 plus 100
  for each place, in its `.zshenv`, `~/.bb-box/ports` and its daemons. The
  held ports' daemon, as `nobody`, answers 3000, 4200, 5000, 5173, 8000,
  8080, 8081 and 19000 on 127.0.0.1 and ::1 with HTTP 421 and words.
- **Daemons.** The device server runs as a LaunchDaemon with the slot's
  `UserName`, `KeepAlive` and `ThrottleInterval` 1; it waits for a
  delivered server, and a new version starts when the old one exits.
- **A release stops a slot gently:** its daemons, its devices through
  `simctl shutdown`, every process but its `containermanagerd` by SIGTERM,
  a second's pause, then its launchd domain and SIGKILL for what is left.
  Ending them all at once can leave the system's CoreMediaIO register
  assistant waiting forever on the user's `containermanagerd`, and then no
  slot can boot a device until the VM restarts
  ([064 results](../../../docs/decisions/064-results.md#a-host-that-cannot-boot-a-device)).
- **State** is in `/var/db/bb-box/host`, mode 700: a folder for each slot,
  with its state and claim, the promises, the sweep queue and `deleting`.
  Every step is recorded before it is taken, so `make`, `release` and
  `reset` can be run again after a cut, and a step that fails twice
  removes the slot.
- **Bounds.** No new slot while the Data volume has less than
  `disk-reserve-gib` free or `memory_pressure` gives under 15% free. A
  second booted device in a slot is shut down after 10 minutes, with words
  in `status`.
