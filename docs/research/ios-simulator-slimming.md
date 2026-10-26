# Slimming an iOS Simulator

Whether bb-box's ios boxes should turn off the background launchd services
an iOS Simulator starts but a device box does not need, as simslim does;
what it saves, what it breaks, and what bb-box's own version would need.

Research, 26 October 2026: a note of what was known and measured then, not
the current design, which is in [the architecture](../architecture.md).
An addendum to [iOS Simulator boxes](ios-simulator-boxes.md), for unit 3.2
of [063](../decisions/063-device-boxes.md).

Status: measured on two Tart macos-desktop boxes at the ios kind's default
size, 6 cores and 16 GiB, on the same Mac host. macOS 27.0, Xcode 27.0
(27A266a), iOS 27.0 (24A434). The pool Mac was not used.

## Recommendation

Adopt it, on by default, in unit 3.2's image.

1. **What:** disable the 112 launchd labels in
   [list-full.txt](ios-simulator-slimming/list-full.txt), with
   `launchctl disable system/<label>` run in the device through
   `xcrun simctl spawn`. The list is bb-box's own: every label we saw
   running in a stock iPhone 18 Pro after it settled, less the 55 in
   [lists.py](ios-simulator-slimming/lists.py)'s `KEEP`, each kept for a
   stated reason.
2. **What it gives:** an iPhone 18 Pro settles at 62 processes
   and 528 MiB phys_footprint, against 240 and 1,997 to 2,201 MiB
   stock: 74 to 76% less. Idle CPU falls from 0.37 of a core to
   0.009 of a core. An iPad Pro 11-inch falls from 265 processes and 2,514 MiB
   to 66 and 509 MiB, and from 0.42 of a core to 0.015. Repeat boots are
   quicker: 1.5 to 2.4 s against 4.4 to 8.4 s. These were measured with
   113 labels; the 112 keep `gamed` as well, one process of about 12 MiB.
3. **What it breaks:** none of 063's needs. All 15 live checks passed on
   the slim iPhone and the slim iPad, as on stock, and the UI tests pass.
   What a slim device loses is the apps and features 063 does not use:
   widgets, wallpaper posters, Siri, Spotlight, Health, Home, Wallet,
   iCloud, Mail, News, Weather, Screen Time. An app under test that uses
   one of those needs slimming turned off.
4. **Where:** in the image build, during the boot each offered model
   already gets (063, unit 3.2): apply, reboot, apply again, check the
   count, shut down. One pass took 28 to 65 s a model, one `simctl spawn`
   a label. A box cloned from that image is a copy of the whole VM, so
   its devices start slim with no work at boot.
5. **How it lasts:** the overrides survived shutdown and boot, `simctl
   reboot` and, unexpectedly, `simctl erase`. They did not survive
   `simctl clone`: a clone of a slim device boots stock. So the device
   server checks at each boot, with `launchctl print-disabled system`,
   and applies the list and reboots when the count is short: for a model
   it creates in the box, for a clone, or if a later Xcode clears them.
6. **Turning it off per box:** an acquire option, such as
   `box_acquire({kind: "ios", slim: false})`, and a `box_device` action for
   a running box. The server runs `launchctl enable` for each label and
   reboots the device. With the 44-label core list that took 19 s. For the
   full list, from the 28 to 40 s its apply took on the iPhone, expect
   about 35 to 50 s; that was not measured. Turning it back on is the same
   with `disable`.
7. **Checked with every image:** the image check boots each model and
   fails if `simctl bootstatus` does not return within 60 s, if idle CPU
   over a minute is above 0.1 of a core, if an XCUITest launch takes over
   3 s to reach its automation session, or if any of 063's needs fails.
   Three labels in this note's first lists failed in exactly those ways
   (see [What went wrong](#what-went-wrong-and-what-it-teaches)).

On one 6-core, 16 GiB VM, each further stock iPhone took about 1.0 GiB
of the VM's memory and each slim one about 0.21 GiB. Eight stock iPhones
left 36% free and idled at about 3 cores; by the same slopes about 12 stock
or about 50 slim would fit before 10% free, an extrapolation, not a
measurement (see [5](#5-how-many-fit-on-one-vm)). 063 keeps one device a
box, so for it slimming mostly means a smaller, quieter box and more boxes
a host.

## How it was measured

Scripts and raw results are in
[ios-simulator-slimming](ios-simulator-slimming/):

- [simtree.py](ios-simulator-slimming/simtree.py) finds the device's
  `launchd_sim` by its UDID, walks every process under it, and sums each
  one's `phys_footprint` and CPU time from `proc_pid_rusage`. That is the
  measure simslim's README uses: it counts compressed and swapped pages,
  and does not count shared pages once per process, as a sum of resident
  sizes would.
- [measure-boot.sh](ios-simulator-slimming/measure-boot.sh) shuts the
  device down, boots it, times `simctl bootstatus -b`, waits 5 minutes,
  takes the snapshot, then measures CPU over the next 5 minutes.
- [needs.py](ios-simulator-slimming/needs.py) runs 063's needs live, each
  with its effect read back, through idb_companion 1.7.7's gRPC and
  `simctl`. [run-needs.sh](ios-simulator-slimming/run-needs.sh) adds the
  stream (the earlier note's
  [measure.py](ios-simulator-boxes/measure.py)) and the UI tests, with a
  footprint snapshot after each.
- [probe-app](ios-simulator-slimming/probe-app/) is a small SwiftUI app,
  built with XcodeGen, that shows its location, last push, privacy grants,
  taps and typed text as labels the accessibility tree reads. Its UI test
  target has three tests: five taps counted, a sentence typed and echoed,
  and three relaunches.
- [lists.py](ios-simulator-slimming/lists.py) builds our lists from a
  stock run's `launchctl list`. [apply-list.sh](ios-simulator-slimming/apply-list.sh)
  applies one. [persistence.sh](ios-simulator-slimming/persistence.sh)
  checks reboot, turning off and on, and erase.
  [density.sh](ios-simulator-slimming/density.sh) boots clones one by one,
  applying a list to each if given one, until the VM runs short of memory.
- [stream-check.sh](ios-simulator-slimming/stream-check.sh) runs the
  stream measurement twice on one companion.
  [boots-within.sh](ios-simulator-slimming/boots-within.sh) and
  [uitest-launch.sh](ios-simulator-slimming/uitest-launch.sh) were the
  tests for halving suspects: does `bootstatus` return within a limit, and
  how long an XCUITest launch takes. [quick-needs.sh](ios-simulator-slimming/quick-needs.sh)
  runs the needs alone.
- [results](ios-simulator-slimming/results/) has each run's summaries.
  `iphone-stock/labels.json` is stock's every process with its label,
  footprint and CPU time.

simslim 0.12.2 was installed with Homebrew in one throwaway box and run once,
on a fresh iPhone 18 Pro, as a reference. None of its code or service
lists is used here. Its list was compared with ours only to narrow a
search for a boot hang, and the cause was then found by our own tests.

Each device was created fresh with `simctl create`. "Stock" is a device as
Xcode makes it. Every device's first boot was stock, before any list was
applied: 22.6 to 37.3 s for an iPhone and 24.6 to 29.1 s for the iPad,
most of it iOS's data migration. Slimming does not shorten a first boot;
in the image, the first boot happens at build.

## 1. Stock against slim

iPhone 18 Pro, settled 5 minutes after boot:

| | Stock (two runs) | simslim (reference) | Ours, core: 44 labels | Ours, full: 113 labels, `gamed` off |
| --- | --- | --- | --- | --- |
| Processes | 240, 241 | 99 | 149 | 62 |
| phys_footprint | 1,997 MiB, 2,201 MiB | 660 MiB | 1,178 MiB | 528 MiB |
| Idle CPU over 5 minutes | 0.37, 0.37 of a core | 0.014 | 0.30 | 0.009 of a core |
| Repeat boot | 8.4 s, 4.6 s | 2.4 s | 3.4 s | 1.5 to 1.9 s |
| Labels disabled, and time to apply | | 168, 12 s, written with the device shut down | 44, 28 s | 113, 28 to 40 s |
| 063's needs, live | 15 of 15 | 15 of 15 | 15 of 15 | 15 of 15 |

iPad Pro 11-inch (M5):

| | Stock | Ours, full: 113 labels, `gamed` off |
| --- | --- | --- |
| Processes | 265 | 66 |
| phys_footprint | 2,514 MiB | 509 MiB |
| Idle CPU over 5 minutes | 0.42 of a core | 0.015 of a core |
| Repeat boot | 4.4 s | 2.4 s |
| Labels disabled, and time to apply | | 113, 65 s |
| 063's needs, live | not run | 15 of 15 |

Notes:

- **Where stock's memory goes.** No single service is large: most take 4
  to 15 MiB each, and SpringBoard, the largest, 66 MiB. What costs is
  their number. 556 of stock's 1,997 MiB is extensions that daemons start,
  not launchd labels: about 20 wallpaper posters from PosterBoard at about
  11 MiB each, and widgets from chronod. Disabling the daemon stops its
  extensions.
- **Where stock's idle CPU goes.** Over 5 minutes, `diagnosticd` used 52 s
  and `apsd` 31 s of stock's 110 s. `apsd` keeps trying to reach Apple's
  push service. With the core list, which keeps `apsd`, idle CPU stayed at
  0.30 of a core; with `apsd` disabled it falls to 0.009 of a core.
  `simctl push` does not need `apsd`: push passed with it off.
- **The core list** is 7 families: wallpaper posters; widgets and live
  activities; Siri and intelligence; search and suggestions; device
  management; health, home and fitness; watch and companion. It saves 41
  to 46% of memory and little CPU. The full list saves 74 to 76%
  and most idle CPU, for no further breakage in our checks, so the
  recommendation is the full list.
- **Our full list beats simslim's** on this runtime, 62
  processes against 99, with fewer labels, because it is built from what
  this runtime runs. A list kept for many runtimes disables labels that
  are not there, and misses ones that are new.
- **Repeat boot** varies between runs: stock's took 8.4 s once and 4.6 s
  once. Slim boots were all 1.5 to 3.4 s.
- **A device in use grows.** After the needs check, the stream and the UI
  tests, stock was at 284 processes and 2,630 MiB, simslim at 120 and 887
  MiB, core at 182 and 1,727 MiB, full at 102 and 940 MiB.

## 2. 063's needs, slim

Each was run live, in this order, and its effect read back. Results are
the same on stock, simslim, core and full, except where noted.

| Need | How it was checked | Stock | Slim (full) |
| --- | --- | --- | --- |
| Install and launch | `simctl install`, `simctl launch`; the app's label in the tree | 323 ms to 7.2 s install, 150 to 430 ms launch | 6.1 s install, 408 ms launch; iPad 1.1 s, 608 ms |
| Accessibility tree | idb `describe-all`; the app's labels found | 11 elements | yes |
| HID input | idb tap on "Tap me"; the count read back | yes | yes |
| Typing, as HID keys | "Hello idb 123" into a field; read back exactly | yes | yes |
| Privacy grants | `simctl privacy grant contacts, photos`; the app reads status 3, authorised | yes | yes |
| Location | `simctl privacy grant location`, `simctl location set`; the app shows 51.5007,-0.1246 | yes | yes |
| Push | `simctl push`; the app's notification delegate shows the title | 115 to 154 ms | yes |
| Pasteboard | `simctl pbcopy` of text with an accented letter and an emoji; `simctl pbpaste` gives it back | yes | yes |
| Paste into a field | the keyboard's paste suggestion tapped; the field reads back | yes | yes |
| Appearance | `simctl ui appearance dark`, light; read back | yes | yes |
| Content size | `simctl ui content_size extra-extra-large`, large; read back | yes | yes |
| Status bar | `simctl status_bar override --time 9:41`; `list` and a screenshot show it | yes | yes |
| Screenshot | `simctl io screenshot` 350 to 370 ms; idb 44 to 52 ms | yes | yes |
| recordVideo | `simctl io recordVideo`, 4 s, a tap in it | yes | yes |
| Safari | `simctl openurl` of a page on the Mac; the page's script calls the Mac; a paste reaches the page's field | yes | yes |
| Framebuffer stream | idb video stream, 20 taps on a page in Safari, second round after the companion starts | 57 fps busy; tap to frame median 65 to 78 ms | 20 of 20 taps: simslim 84.6 ms, core 77.7 ms, full on the iPad 82.4 ms; 56 to 58 fps busy on the iPhone, 47 on the iPad |
| UI tests | `xcodebuild test-without-building`, 3 tests | 42.1 to 45.7 s, all pass | all pass. simslim 43.7 s, core 45.6 s. Full with `gamed` off: 105 s on the iPhone, 93 s of tests on the iPad, each launch about 10.5 s slower; with `gamed` kept, a launch reaches its automation session in 0.8 s, as stock |

Keyboard settings (autocorrect off, 063's E13) are preferences, not
services, so slimming does not touch them; typing "Hello idb 123" came
through unchanged on every device here.

What it costs to use, after the checks, stream and UI tests:

| | Stock | simslim | Core | Full |
| --- | --- | --- | --- | --- |
| Before | 244 processes, 2,216 MiB | 99, 660 MiB | 149, 1,177 MiB | 62, 528 MiB |
| After the needs check, with Safari | 280, 2,612 MiB | 126, 1,095 MiB | 180, 1,752 MiB | 100, 931 MiB |
| After the UI tests | 284, 2,630 MiB | 120, 887 MiB | 182, 1,727 MiB | 102, 940 MiB |

Install, launch and Safari's page load took the same time slim as stock,
within the spread between runs: install varied from 0.3 to 10 s on both.
The UI tests did too, once `gamed` was kept.

## 3. The list, and why each kept service is kept

[list-full.txt](ios-simulator-slimming/list-full.txt) is generated by
`python3 lists.py full <stock run>` from a stock iPhone 18 Pro's `launchctl
list`: every `com.apple.` label with a running process at settle, less
`KEEP`, less launchd's one-shot labels. By family:

- **Widgets and wallpaper:** PosterBoard, chronod, liveactivitiesd,
  replicatord, MapKit.SnapshotService.
- **Siri and intelligence:** assistantd, sirittsd, siriactionsd,
  siriinferenced, siri.context.service, siriknowledged, assistant_cdmd,
  corespeechd, voicebankingd, intelligenceflowd, intelligencecontextd,
  generativeexperiencesd, modelcatalogd, modelmanagerd, textunderstandingd,
  linkd, biomed, biomesyncd.
- **Search:** spotlightknowledged.updater, searchd, hybridsearchd,
  fileindexerd, suggestd, parsecd, peopled.
- **Accounts, iCloud, Store and push:** akd, appleaccountd, amsaccountsd,
  amsengagementd, cdpd, cloudd, syncdefaultsd, appstored, itunesstored,
  itunescloudd, apsd, identityservicesd, ids_simd, AppSSODaemon.
- **Mail, calendars, contacts sync:** email.maild, icloudmailagent,
  dataaccess.dataaccessd, addressbooksyncd, eventkitsyncd, remindd.
- **Health, home, fitness:** healthd, homed, homeeventsd, fitcore,
  fitnesscoachingd, fitnessintelligenced, activitysharingd, activityawardsd.
- **Watch, car and companion:** nanotimekitcompaniond, companionappd,
  nanoregistrylaunchd, nanoprefsyncd.2, NPKCompanionAgent,
  brook.brookcompaniond, appconduitd, wcd, carkitd.
- **Wallet and money:** passd, financed, finhealthd.
- **Screen Time and family:** ScreenTimeAgent, ScreenTimeSettingsAgent,
  UsageTrackingAgent, FamilyControlsAgent, ManagedSettingsAgent,
  familycircled, dmd, deviceaccessd.
- **Device management:** remotemanagementd, DeviceConfigurationAgent,
  managedassetsd. The first two start about 13 subscriber processes.
- **Apps' background services:** newsd, weatherd, navd, routined,
  geoanalyticsd, GameController.gamecontrollerd, mobiletimerd,
  findmy.findmylocated, callservicesd, sharingd, rapportd, sociallayerd,
  avatarsd, communicationtrustd, mediaanalysisd, photoanalysisd,
  medialibraryd, ClipServices.clipserviced, SafariBookmarksSyncAgent,
  Safari.passwordbreachd.
- **Telemetry, experiments and setup:** ap.adprivacyd,
  ap.promotedcontentd, diagnosticextensionsd, triald, eligibilityd,
  followupd, jetpackassetd, assetsubscriptiond, AssetCacheLocatorService,
  ind, purplebuddy.budd.

Kept, with the reason for each, in `KEEP`: SpringBoard, backboardd,
CoreSimulator.bridge, runningboardd, InputUI, pasteboard.pasted, tccd,
locationd, usernotificationsd, bulletindistributord, donotdisturbd,
installd and its helpers, containermanagerd, lsd, iconservicesagent,
cfprefsd, distnoted, configd_sim, UserEventAgent-System, securityd, trustd,
nsurlsessiond, syslogd, aslmanager, AccessibilityUIServer, axassetsd,
fontservicesd, FileCoordination, FileProvider, pluginkit.pkd, dasd, swcd,
revisiond, GSSCred, accountsd, mobileassetd, managedconfiguration.profiled,
systemstatusd, countryd, localizationswitcherd, featureaccessd,
appprotectiond, geod, assetsd, contactsd, calaccessd, webbookmarksd,
devicecheckd, AuthenticationServicesAgent, mediaremoted, and three found
by our tests:

- **nanoregistryd:** with it disabled together with the rest of the full
  list, the device came up and drew its Home Screen, but `simctl
  bootstatus -b` never returned. Found by halving the suspects four times.
  With the core list it was disabled and boot was fine, so it is the
  combination; keeping it is enough.
- **sleepd:** with it disabled, SpringBoard and mobiletimerd retried it
  over XPC in a tight loop: about 38,000 log lines a second, and 4 cores
  of CPU between them and diagnosticd.
- **gamed:** with it disabled, every app launch by an XCUITest waited
  about 10.5 s before "Setting up automation session", against 0.5 s
  stock; `simctl launch` did not wait. The UI tests still passed, in 105 s
  against 42 to 46 s. Found by halving 15 suspects four times, timing one
  test's launch each time.

Some of the kept ones could go too, at a small gain each and a real risk
to apps under test (geod for MapKit, assetsd for the photo picker,
calaccessd and contactsd for EventKit and Contacts). They are kept for the
apps, not for 063.

Six watch-companion labels ship with an "enabled" override in the runtime
and stayed enabled after the first `disable`; a second `disable` after a
reboot held. bb-box should apply the list, reboot, and check the count.

## 4. Applying it

Where, against the options:

| | At image build | At each boot | Offline, writing launchd's store |
| --- | --- | --- | --- |
| Work at acquire | none | 28 to 65 s, then a reboot of about 7 s | none |
| Survives reboot and erase | yes, measured | yes | not tested |
| Survives `simctl clone` | no, measured: the boot check applies it | yes | not tested |
| Tools | Apple's: `simctl spawn ... launchctl disable` | the same | private: the store's place and format are not documented |
| Recommendation | yes | only to repair, when the check finds the count wrong | no |

Persistence, measured with the core list on one device:

| Step | Disabled after | Processes, footprint 60 s after |
| --- | --- | --- |
| Slim, booted | 44 | 161, 1,298 MiB |
| `simctl reboot`, 7 s | 44 | 138, 1,063 MiB |
| `launchctl enable` each, then reboot: 19 s | 0 | 245, 2,406 MiB |
| `launchctl disable` each, then reboot: 22 s | 44 | 135, 1,052 MiB |
| `simctl erase`, then a first boot of 20 s | 44 | 156, 1,178 MiB |
| `simctl clone` of a slim device, booted | 0, in each of 8 clones | about 230, as stock |

The overrides outlived `simctl erase`, which clears the device's data,
and were lost by `simctl clone`, which copies it. So launchd_sim keeps them
outside the device's folder, apparently by UDID. We did not find where;
they are not in the device's `data` folder as a file named for them. A Tart
clone of the image copies the whole VM, UDIDs and all, so it keeps them.
Since bb-box cannot rely on what it cannot see, the server's boot check is
the guard.

Applying the list to a clone, then rebooting, left 106 of 112 disabled:
the six watch-companion labels again, as on the first apply anywhere. A
second apply holds them.

## 5. How many fit on one VM

Clones of one booted-once iPhone 18 Pro were booted one at a time on the
first VM, 6 cores and 16 GiB, each given 60 s to settle. After each, the
script recorded the devices' summed phys_footprint and macOS's own
`memory_pressure` free percentage. It would stop at 10% free or 1 GiB of
swap; neither was reached.

| Devices booted | Stock: processes, summed footprint, VM memory free | Slim (112 labels): processes, summed footprint, VM memory free |
| --- | --- | --- |
| 1 | 230, 2,006 MiB, 81% | 61, 474 MiB, 81% |
| 2 | 455, 4,443 MiB, 75% | 123, 955 MiB, 79% |
| 3 | 689, 6,655 MiB, 71% | 184, 1,429 MiB, 78% |
| 4 | 924, 8,907 MiB, 66% | 246, 1,911 MiB, 77% |
| 5 | 1,173, 11,249 MiB, 59% | |
| 6 | 1,407, 13,477 MiB, 51% | |
| 7 | 1,657, 15,847 MiB, 43% | |
| 8 | 1,886, 18,011 MiB, 36% | |

- Each further stock iPhone took about 6.4 points of free memory, about
  1.0 GiB, matching the earlier note's 1 to 1.5 GiB from `vm_stat`. Each
  slim one took about 1.3 points, about 0.21 GiB: about 5 times less.
- Summed phys_footprint overstates what the VM gives: 18 GB for eight
  stock devices on a 16 GiB VM with 36% still free. It counts compressed
  pages, and each process's share separately. For room on a host, the
  VM's free memory is the measure; for comparing stock and slim, both
  agree on the direction.
- Run to 10% free on the same slopes, about 12 stock iPhones would fit
  and about 50 slim ones. That is extrapolated, not measured: the slim run
  was stopped at 4 for time. CPU is the nearer limit for stock: 12 stock
  devices idle at about 4.4 cores of 6. Slim ones idle at about 0.01 of a
  core each. Drawing while busy, the GPU and disk were not measured with
  more than one device.
- Clone boots took 4 to 12 s. The stock run's clones were of a slim device
  and came up stock, which is how `simctl clone` was found to drop the
  overrides; the slim run applied the list to each clone and rebooted it.

## What went wrong, and what it teaches

Four of this note's own mistakes are worth bb-box's image check:

1. **A list made from `launchctl list` can catch launchd's one-shot
   labels.** The first list held `com.apple.xpc.launchd.oneshot.0x10000004.launchctl`,
   the label `simctl spawn` itself runs under. Disabling it made later
   spawns fail, "Process spawn via launchd failed ... Service is
   disabled", whenever launchd reused that label. The list now drops
   one-shot labels, and the apply step retries a failed spawn.
2. **A boot can look done and not be.** nanoregistryd: Home Screen up,
   `bootstatus` never returning. The image check must time `bootstatus`.
3. **A service can be missed loudly.** sleepd: a retry loop at 4 cores.
   The image check must measure idle CPU.
4. **A service can be missed quietly.** gamed: every UI test still passed,
   at more than twice the time. The image check must time an XCUITest
   launch.

## Found on the way, stock too

These are not caused by slimming; they change 063's assumptions.

- **No Allow Paste alert on iOS 27.** After `simctl pbcopy`, a focused
  field in our app and in Safari showed the text as a suggestion above
  the keyboard, "Paste from CoreSimulatorBridge"; tapping it pasted with
  no alert. HID Cmd+V, as the earlier note sent it, pasted nothing, in
  either, stock or slim. An app reading `UIPasteboard` itself got nothing
  and showed no alert. 063's decision 14, that the server answers Allow
  Paste, needs checking again in unit 5.2: paste may have to go through the
  suggestion, found 36 points above the keyboard's top row.
- **The keyboard's first use shows a sheet,** "Speed up your typing by
  sliding your finger", with Continue, over the keyboard. The image should
  answer it at build, as 063 answers Device Hub's microphone prompt.
- **The accessibility tree once returned only the app's root,** zero
  frame, no children, 34 s after a launch, on stock. A reboot cleared it.
  The server should treat a tree of one element as "not ready".
- **idb's first stream after the companion starts misses taps:** 15 of 20
  in the first round, on stock and slim alike, and none in the second. The
  earlier note saw the first tap lost; the server should set up HID before
  a viewer's first tap.
- **simslim's licence.** The brief said simslim had none. On 26 October
  2026 its repository showed the MIT licence. This note uses none of its
  code or lists either way.

## What limits this

- One runtime: iOS 27.0 (24A434). A new runtime adds and renames labels.
  The list must be rebuilt from a stock run of each runtime the image
  carries, and checked as above.
- Two models: iPhone 18 Pro and iPad Pro 11-inch (M5). The list came from
  the iPhone; the iPad ran the same list.
- Our checks cover 063's needs and a small app. An app that uses a
  disabled family will fail in ways these checks do not see: widgets,
  App Intents and Shortcuts (linkd), Live Activities, HealthKit, HomeKit,
  PassKit, CloudKit, Mail, CallKit, sharing. That is what the
  per-box switch is for.
- Two VMs ran at once on one Mac host for part of the time, the core,
  persistence and iPad runs on the second. Boot times and CPU may be a
  little high for that; memory is per device and not affected.
- Times to apply varied from 28 to 66 s for the same kind of list,
  with the host busy or not.

## Open questions for the lead

1. **The switch's name and default.** On by default, as the owner asked;
   `slim: false` at acquire and a `box_device` action to turn it off,
   which reboots the device for 30 to 40 s. Should a person in the panel
   see it, or only the agent?
2. **Core or full.** Full saves 74 to 76% and most idle CPU; core
   saves 41 to 46% and little CPU, but leaves Mail, Wallet, Game Center,
   iCloud and the rest running for apps that use them. This note
   recommends full with the switch.
3. **Paste.** 063 decision 14 assumed an Allow Paste alert. iOS 27 shows a
   suggestion instead, and Cmd+V did nothing. Unit 5.2 should settle how
   the server pastes.
4. **Where the overrides live.** They survived `simctl erase` and were
   lost by `simctl clone`. The boot check repairs either case; finding the
   store would let the image check read it without booting.

## Rerunning the measurements

On a Mac box with Xcode 27. The scripts expect this folder and
[ios-simulator-boxes](ios-simulator-boxes/) side by side, and the probe
app built into `~/slim/dd`:

```sh
brew tap facebook/fb && brew trust facebook/fb && brew install idb-companion xcodegen
python3 -m venv ~/idbenv && ~/idbenv/bin/pip install fb-idb psutil
(cd ios-simulator-slimming/probe-app && xcodegen generate &&
  xcodebuild -project SlimProbe.xcodeproj -scheme SlimProbe \
    -destination "generic/platform=iOS Simulator" -derivedDataPath ~/slim/dd build-for-testing)
cd ios-simulator-slimming
udid=$(xcrun simctl create stock com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro com.apple.CoreSimulator.SimRuntime.iOS-27-0)
xcrun simctl boot "$udid" && xcrun simctl bootstatus "$udid" -b
./measure-boot.sh "$udid" stock
python3 lists.py full ~/slim/runs/stock > list.txt
./slim-device.sh slim com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro list.txt full
./density.sh "$(cat ~/slim/runs/full/udid)" slim 8 60 list.txt
```
