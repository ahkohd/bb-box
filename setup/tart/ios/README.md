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
5. clears the devices' pasteboards, CoreSimulator's logs, Device Hub's
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
| idle cpu | the device's processes use more than 0.1 of a core over a minute, after a minute to settle | a service can fail loudly, as without `sleepd` |
| xcuitest launch | an XCUITest launch takes over 3 s to reach its automation session, or the test fails | a service can fail quietly, as without `gamed` |

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
