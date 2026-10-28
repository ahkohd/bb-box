# 064 results

What each build unit of [064](064-ios-shared-hosts.md) measured and
checked. Each unit has a section of its own.

## Unit 2: the data model, `dedicated` and `shared`

Built on 26 October 2026.

### What it adds

- **`src/core/device-host.ts`**: 064's types for hosts, slots, placements
  and tiers; a slot's user and UID from its generation; each slot's ports;
  validators for a host and a slot as a helper's status gives them, and for
  a placement in `guest.data`; the slot's capabilities; and the words of
  every refusal.
- **The placement on the box record,** read from `guest.data` by
  `placementOf`, written once by the backend at the claim. A box with no
  slot keys is a VM of its own. The claim writes the slot's capabilities
  over the offer's: no root, no host desktop, no desktop computer use; the
  device and enrolment stay.
- **`dedicated`** for ios and **`shared`** for ios and macos, on
  `box_acquire`, `bb box acquire` (`--dedicated`, `--shared`) and the
  panel's acquire.
- **Refusals,** each in words naming `dedicated`: once shared ios boxes
  are the default, a size for an ios box without `dedicated: true`;
  `shared: true`, as no shared iOS host is set up; and for a box in a slot, a stop, a start, a resize, a restart and a
  grant. `dedicated` on another kind, `shared` on a kind that has no slot,
  and both at once, are refused too.
- **The switch,** `SHARED_IOS_BY_DEFAULT` in `src/core/device-host.ts`,
  off. Unit 6 turns it on in the change that makes shared the default.
  While it is off, an ios size without `dedicated` is today's box, a VM of
  its own at that size, and box_list says nothing of a size. With it on, the
  size is refused and box_list says a size needs `dedicated: true`.
- **box_list** says, on the ios kind's line, that each box is a VM of its
  own, that `dedicated: true` asks for one, and that no shared iOS host is
  set up. **box_status** has a Where line: "A VM of its own.", or for a box
  in a slot "On a shared iOS host (a Tart VM), slot 3 of 8. Ports 20300 to
  20399, in BB_PORT_BASE and BB_PORT_COUNT.", with its Root line naming
  `dedicated` and no Size line.
- **The New box form,** for the ios kind, a Machine choice under System,
  before the device: Shared, shown off with "No shared iOS host is set
  up.", and A VM of its own, chosen. The size shows only with A VM of its
  own, and Create sends `dedicated: true`. Your machines, which are always
  VMs of their own, do not show the choice.
- **The skill** says when to ask for `dedicated`, and to give it with a
  size, which a size will need once shared is the default.

### Checks

| Check | How | Result |
| --- | --- | --- |
| The compile-time cases | `test/device-host-types.ts`: 13 legal shapes and 20 illegal ones, each marked `@ts-expect-error`. tsc run with every mark removed | tsc passes with the marks. Without them it fails on exactly the 20 lines, each for its own reason: a pool Mac starting or deleting, a Tart host lent whole or with an end, a Namespace host with no end, a carried third slot, a slot record holding its user and UID, a held ios slot with no device, a held macos slot with one, an Android model in a slot, a VM placement with a host |
| `dedicated: true` gives today's box | the registry against the fake backend | a ready box, a VM of its own, with the offer's capabilities and the size asked for, stop and start offered |
| A size without `dedicated`, the switch off | the same | today's box: a VM of its own at the size asked; box_list's line names no size rule |
| A size without `dedicated`, the switch on | the same, with the registry told shared is the default | refused: "A shared ios box has no size of its own. Ask for dedicated: true with a size." With a preset, with cores alone, and with `dedicated: false`; box_list says a size needs it |
| A box in a slot | the fake backend's guest given a slot's placement | the slot's capabilities stored; box_status's Where and Root lines; each refusal in its words |
| The validators | `test/device-host.test.ts` | each legal shape read back whole; each illegal one that reaches a reader refused in words naming its field |
| The form, by keyboard | vitest, the panel rendered with a stub server | Shared is `aria-disabled`, out of the tab order, says "No shared iOS host is set up."; a click or an arrow key leaves A VM of its own chosen; Create sends `acquire ios dedicated`, and with Large, `acquire ios {"preset":"large"} dedicated` |
| A separate BB | a fresh `npx bb-app` with no account in a Linux desktop box, bb-box installed from the branch's path, Docker set up | `bb box acquire linux --shared` and `--dedicated` refused in their words; `ios --dedicated` refused as no backend offers ios there |
| The suite | tsc, `npm test` (the node suite, then vitest) and the docs test, on a Linux box, on the branch rebased onto origin/main at 78c54b64 | tsc clean; the node suite 2,046 passed, 0 failed, 288 skipped; vitest 217 passed |

### What limits these checks

- **No shared host exists yet,** so no real box has been in a slot. A box
  in a slot was checked only with the fake backend, its guest given a
  slot's placement by the test.
- **The separate BB has no ios kind.** Only Tart offers ios, and a fresh
  BB has no Mac it may reach, so an ios box there could not be made, and
  its form shows no Machine choice. A fresh BB has no agent either, so the
  checks there went through `bb box`, which shares the registry and the
  words with the tools.
- **Not checked here,** and due after the deploy: `dedicated: true`
  through production BB's tools on a real ios box, with box_list and
  box_status read back; and the New box form's ios choice in the
  production panel at 360 px and by keyboard.

### Deviations from 064

- **The placement's keys in `guest.data` are `slotHost`, `slotHostOn`,
  `slotGeneration`, `slotCarried`, `slotPlace` and `slotMost`,** not
  `host`, `generation` and `carried`: the SSH host pool already keeps its
  own `generation` there, which a pool Mac's slot (unit 5) would meet.
- **A slot placement holds `hostOn`, `place` and `most` too,** so
  box_status can name the host's kind, the slot's number and its ports
  without asking the host.
- **Some acquires are VMs of their own without `dedicated`:** spares, your
  machines, a thread's own machine, a box from a build, and a box with a
  project's image. Their sizes are not refused.
- **box_list's ios line** says what is true until unit 4: each box is a VM
  of its own. 064's "Shared by default" words wait for unit 6.

## Unit 1: streams at the viewer's size, and only while wanted

Built and measured on 26 October 2026. Device server version 20, protocol 2.

### What it adds

- **The viewer says what it draws.** The panel sends `BB_DEVICE_VIEW
  {"width": w, "height": h}`, the device's screen as drawn in the browser's
  own pixels, upright: before `START_VIDEO`, and 500 ms after what it draws
  changes and stays changed. That covers a resize, Show frame, Pixel for
  pixel and a move to a screen of another pixel density. The stage notices
  a new pixel density by the media query's change event, and on the next
  frame it paints. The relay's `VIDEO_VERBS` gains the verb.
- **The server picks a step.** `src/device/video-wants.ts` keeps what each
  wants: each viewer at the step that covers what it draws (`stepCovering`
  and `drawnShare` in `src/core/device.ts`), a viewer that never says at
  full size, a viewer of stills at a third, a recording at two thirds, the
  agent's settle reads at a third, and a switch's wait for its first frame
  at a third. The largest wins, within the lease holder's cap (`{"type":
  "cap", "most": step}`, for unit 6). A change waits until it has held for
  1 s. The stream opens at once when something wants it, and closes 10 s
  after the last want ends.
- **On iOS,** idb's stream opens only while wanted, with `scale_factor` set
  to the step. When nothing wants it, the stream is ended with idb's stop
  message. The driver peeks once at a third, to learn the screen, when a
  device starts and when it turns while the stream is closed.
- **Geometry stays in the device's own pixels.** The driver turns a frame's
  size back into the device's (the model's pixels, as the frame's shape
  says), so a step change is no change of geometry: no new generation, and
  an agent's screenshot and references stay good. Input is in the device's
  pixels on both platforms. The stage draws the frame at its own size and
  lays it out in the device's pixels, so the browser scales it up.
- **On Android,** frames stay at full size. Encoding pauses while nothing
  wants video; the emulator's screen stream still runs, so geometry still
  comes from it. When video is wanted again, the last screen is encoded.
- **Frames that show no change are marked,** and the settle read does not
  count them: a stream's opening key frame, a key frame sent again on
  request, and on Android a frame encoded again. A settle that opens the
  stream waits up to 1.5 s for its first frame.
- **A recording** records each segment's geometry in the device's pixels,
  so touches land in the clip whatever the step.
- **The delivery is compressed,** in a commit of its own: the server's
  files as gzip, text files as text, unpacked by Node's zlib in the box.
  520,644 bytes of files go as 139,460. The test's budget, 512 KB, is now on
  the compressed size.
- **A companion left encoding is restarted.** See [idb_companion never
  ends a stream whose call is cancelled](#idb_companion-never-ends-a-stream-whose-call-is-cancelled).
- **The guides** (desktops, recording) say what a viewer sees.

### How it was measured

- **iOS:** an ios box from production BB, Tart on the Mac, 6 cores and 16
  GiB, iOS 27.0, idb_companion 1.7.7, the iPhone 18 Pro. Version 20 was
  delivered from the branch as bb-box delivers it.
- **Android:** an android box from production BB, Proxmox QEMU, 8 cores and
  16 GiB, Android 15 (API 35), the Pixel 8 and the Pixel Fold, with
  version 20 delivered the same way.
- **The harness** in each box, `scripts/measure/ios` (README): the
  plugin's own relay (`viewer.ts`) and the panel's own client
  (`device.html`) in headless Google Chrome, driven by `drive.ts`; the
  plugin's own `DeviceServers` and `DeviceComputer` (`computer.ts`); and
  `record.ts`. BB's server and the network are not in these numbers. The
  harness held the box's lease with a start time no instance could pass,
  as a production bb-box that restarted during the run took the lease once
  and delivered its version 19 over version 20.
- **Pages in the device:** `touch.html` puts a red dot where a touch lands;
  `flip.html` turns black or white at each touch, and with `?busy` changes
  colour every frame.

### The step follows the panel

The iPhone 18 Pro, its own 1206x2622. The time is from the panel's change
to the first frame at the new step, the stall is the gap between the last
frame of the old step and the first of the new, on the busy page.

| Panel | Drawn | Share | Step | Frames | Time | Stall |
| --- | --- | --- | --- | --- | --- | --- |
| 520x800 at 2x, framed (a laptop) | 664x1445 | 0.551 | two thirds | 804x1748 | 1,557 ms | 56 ms |
| 700x1000 at 1x, framed (a desktop monitor) | 421x914 | 0.349 | a third | 402x874 | 1,641 ms | 128 ms |
| 900x1300 at 2x, framed (a 5K monitor) | 1106x2405 | 0.917 | full | 1206x2622 | 1,605 ms | 105 ms |
| Pixel for pixel, from a third | 1206x2622 | 1 | full | 1206x2622 | 1,598 ms | 103 ms |
| 700x1000, 1x to 2x (another screen) | 841x1829 | 0.698 | two thirds | 804x1748 | 1,615 ms | 97 ms |
| 700x1000, 2x to 1x | 421x914 | 0.349 | a third | 402x874 | 1,652 ms | 126 ms |
| 700x1000 at 1x, no frame | 453x984 | 0.376 | a third | 402x874 | 1,562 ms | 67 ms |
| 600x1100 at 1x, framed | 465x1010 | 0.385 | a half | 604x1312 | 1,558 to 1,591 ms | |

In 20 changes over three runs the step came 1,552 to 1,652 ms after the
panel changed: 500 ms for the panel to settle, 1 s of hold, and the
restart. The stall
was 50 to 128 ms, against 064's estimate of 50 to 106 ms. Between frames
the gap was 16 to 17 ms throughout. idb gave 402x874, 604x1312, 804x1748
and 1206x2622 for the four steps, as its own log said ("Applying 0.5 scale
from w=1206/h=2622 to output w=604/h=1312").

The laptop's panel came to two thirds, not 064's estimated half: drawn
1,445 pixels tall, a share of 0.55.

On Android the Pixel 8's frames stayed 1080x2400 at every size: 700x1000,
520x800 at 2x, 900x1300 at 2x and Pixel for pixel.

### Taps land where drawn

| Case | Taps | Landed |
| --- | --- | --- |
| iOS, Safari on `touch.html`, at a third, a half, two thirds and full (a large panel, and Pixel for pixel) | 4 at each, 20 in all | 20 |
| iOS, a tap 0, 700, 1,450, 1,550, 1,650 and 1,750 ms after the panel changed from a third to a half, on the frame of either step | 6 | 6 |
| Android, the Pixel 8 on `touch.html` in Chrome, at four panel sizes | 16 | 16 |

### H4: tap to screen at each step

100 taps through the panel at each step on `flip.html`, 600 ms apart,
timed from the pointer down to the drawn frame whose pixel under the tap
changed shade.

| Step | Seen | Median | 95th percentile | Worst |
| --- | --- | --- | --- | --- |
| A third | 100 | 49 ms | 72 ms | 80 ms |
| A half | 100 | 60 ms | 80 ms | 100 ms |
| Two thirds | 100 | 61 ms | 76 ms | 156 ms |
| Full | 100 | 63 ms | 81 ms | 158 ms |

The stall when the step changes is in the table above: 50 to 128 ms.

### 063's E8 cases, at a step

| Case | Result |
| --- | --- |
| iOS, all four orientations, Safari, at a third (frames 874x402 when sideways, geometry 2622x1206) | 12 of 12 taps landed; upside down, Safari stays sideways, content turned right, as 063 found |
| iOS, the Home Screen held upright with the device turned left, at a third | the geometry says turned left, content upright; a tap on the Settings icon, from its frame in the tree, opened Settings |
| iOS, an agent's screenshot downscaled to 721x1568 (scale 0.598), two taps at image pixels | 2 of 2 red dots at those pixels |
| iOS, a turn while a person's finger is down | the touch was lifted: "lifted the person's touch and 0 keys, as the device is about to rotate" |
| Android, the Pixel 8, all four orientations | 12 of 12 landed |
| Android, the Pixel Fold closed (1080x2092), open and half open (2208x1840) | 9 of 9 landed |
| Android, an agent's screenshot of the open Fold downscaled to 1568x1307 (scale 0.71) | 2 of 2 at those pixels |

The first Android run lost 3 taps to Chrome's own toolbar in landscape,
one of them its Home button, which left the page; the run again with
points on the page landed all 12.

### An agent's references after a person resizes the panel

Through `computer.ts`, with the panel moved between the agent's reads and
its acts:

- iOS: Settings observed at a third, the panel to Pixel for pixel (full),
  then `e10`, "General": "Tapped e10, button "General"". Observed at full,
  the panel to a half, then `e25`, "About": tapped. No reference was
  refused as stale, and the geometry's generation did not move.
- Android, the Pixel Fold open: Settings observed at a small panel, the
  panel to Pixel for pixel, then `e8`, "Connected devices": tapped.

### No frames 10 s after the last viewer leaves

The busy page on screen, one viewer watching, then the viewer's page
closed. CPU is from `ps` (iOS) and `/proc/<pid>/stat` (Android) over 5 s
windows.

| | Watched | Closed | idb_companion or bb-box-h264, CPU in 5 s: watched, then four windows after |
| --- | --- | --- | --- |
| iOS, at a third | 22:08:55.673 left | 22:09:05.648, 9.98 s after; idb's "The video stream is terminated" 8 ms later; no stats of any stream after | 0.36 s; then 0.37, 0.39, 0, 0 |
| Android | 22:16:32.280 left | 22:16:42.261, 9.98 s after: "encoding paused" | 1.42 s; then 1.49, 1.45, 0, 0 |

The Android server itself used 0.05 s of CPU in 5 s while paused, reading
the emulator's screen for its geometry.

### A recording

`record.ts main` with no viewer: the stream went to two thirds for the
recording ("the stream at two-thirds, for a recording at two-thirds"), and
closed 10 s after it stopped. Its segment was 804x1748. A minute with a
turn made a clip of 1280x1390, as a sideways part widens the canvas; 20
upright seconds made a clip of 1080x1600, 064's largest. The touches in the
log are in the device's pixels and its segments' geometry in the same, so
they meet in the clip.

### Through a separate BB

A fresh `npx bb-app` 0.47.1 with no account, in a Linux box, with bb-box
installed from the branch's path, a Docker backend on the box's own Docker
with `setup/docker/build.sh linux`'s image, enrolment off and the test
device on. A linux box with the test device standing in for the Pixel 8
was ready in 0.3 s, and bb-box delivered version 20 to it. Headless Chrome
opened the box's page in BB, `/plugins/bb-box/desktop/<thread>/<box>`,
which showed the device in its frame, and was resized:

| At | Panel | The server's log |
| --- | --- | --- |
| 22:35:55.9 | 1200x1000 at 1x, opened | 22:35:51.4 "the stream at third" for an earlier tab, then the same for this one |
| 22:36:20.970 | 520x800 at 2x | 22:36:22.468 "the stream at half": 1.50 s |
| 22:36:26.029 | 1400x1300 at 2x | 22:36:27.526 "the stream at full": 1.50 s |
| 22:36:31.091 | 700x1000 at 1x | 22:36:32.588 "the stream at third": 1.50 s |
| 22:36:36.120 | the page left | 22:36:46.131 "the stream closes": 10.01 s |

So BB's server and the plugin's relay carry `BB_DEVICE_VIEW` from the
panel to the box. The test device draws its card at its own size whatever
the step, so this checks the path and the timing, not the picture.

### idb_companion never ends a stream whose call is cancelled

In the first run on the Mac, idb_companion's log showed five video streams
still encoding at 58 fps, each 1.5 s of CPU in 5 s between them, with no
client:

- the stream of each device server that had stopped, here at each
  delivery: idb never learns that the call went;
- and the streams this unit first closed by cancelling the call, which
  idb also never ends.

Only idb's stop message ends a stream ("The video stream is terminated").
So the server now ends every stream with it, and cancels only if idb has
not ended it 500 ms later. And a device server that finds a companion
running when it starts counts the streams it encodes, from idb's stats
lines of the last 7.5 s, and starts it again if it encodes any. On the
next delivery: "idb_companion still encodes 6 video streams of an earlier
device server, which it never ends; starting it again", listening again
159 ms later, and no stream's stats until a viewer came.

This happens on every ios box today: each delivery or restart of the
device server leaves a stream encoding until the box's companion
restarts, taking the Mac's encoder from the streams people watch.

### Checks

| Check | Result |
| --- | --- |
| The suite: tsc, the node suite, then vitest, and the docs test, on a Linux box, on the branch rebased onto origin/main at 02bb17ac | tsc clean; the node suite 2,052 passed, 0 failed, 288 skipped; vitest 218 passed |
| New tests | the step's rule and the view verb's reading; the server's wants, hold, linger, cap and lease, with the test driver; opening and repeated key frames not counted by settle; the iOS video peeking, opening at each step's scale, keeping the generation, and ending each stream with idb's stop; idb's stats counted from its log; Android encoding paused and taken up again; the stage taking a touch in the device's pixels at every step and saying what it draws; the delivery's compressed budget |

### What limits these checks

- **BB's server and the network are not in the step, tap and H4 numbers.**
  They come from the plugin's relay and the panel's client in the box. The
  separate BB had no ios or android kind, as a fresh BB has no Mac or
  Proxmox it may reach, so its check used the test device. Due after the
  deploy, through production BB in the owner's browser on one ios and one
  android box: the panel at three sizes and Pixel for pixel, taps at each
  step, and no frames 10 s after the viewer leaves.
- **A move between screens** was checked by Chrome's emulation of a pixel
  density. Under emulation neither `resize` nor the media query's change
  event fires, so the stage's check at each painted frame found it. A real
  move between screens fires the media query's change, which was not
  checked.
- **Two viewers at once** were checked only in the tests, with the test
  device: the larger step wins, after the hold.
- **The cap** has no caller yet; unit 6's ledger sends it.
- **Only the iPhone 18 Pro** was measured on iOS. The iPad's steps follow
  the same rule; idb's sizes for it were not read.

### Deviations from 064

- **The viewer says its size before `START_VIDEO`,** not after, so a
  stream opens at its step and not at full size first. A viewer that
  never says, as an older panel, gets full size, as 064 says.
- **A viewer of stills, and a switch's wait for its first frame, want a
  third.** 064 lists viewers, recordings and the tools' waits. Stills need
  the stream to know when the screen changes; a switch needs a frame.
- **The stream also opens briefly at a third when a device starts, and
  when it turns while nothing watches,** to learn the shape of what it
  draws: idb's screenshot is always upright, so an agent's screenshot is
  turned by that shape. 064 says the server reads the orientation while
  still, which gives how the device is held, not how the app draws.
- **Android pauses its encoder while nothing wants video,** where 064
  names only idb's stream. Unit 1's check asks for no frames 10 s after
  the last viewer on both, and the encoder was 29% of a core on a busy
  screen with nobody watching. The emulator's screen stream still runs,
  for the geometry.
- **The settle read waits up to 1.5 s for a stream's opening frame,** and
  frames that show no change are not counted, so the agent's "Nothing on
  the screen changed" stays right when its own read opens the stream.
- **A device server restarts a companion that still encodes another
  server's streams.** Not in 064; found here.
- **The delivery is compressed,** in a commit of its own, as the server's
  files passed the 512 KB budget at 520,644 bytes.

## Unit 3: the host's helper

Built and checked on 26 October 2026.

### What it adds

- **`device-host`,** [`setup/tart/ios/device-host.sh`](../../setup/tart/ios/device-host.sh),
  the shared host's helper, run as root: `init`, `make`, `promise`,
  `claim`, `release`, `reset`, `daemon`, `resume`, `status`, `carry` and
  `install`, each written to be run again from the step it records before
  taking it. Its commands, state and exit codes are in the
  [iOS image's guide](../../setup/tart/ios/README.md#shared-hosts-device-host).
- **The last release decides under the lock.** `release` looks for any
  other claim, live promise or slot being made for a box; with none it
  writes `deleting` before it lets go, and answers `last=yes`. Every later
  `claim`, `promise` and `make` is refused with exit 7 and "This host is
  being deleted; ask again."
- **A release stops a slot gently,** in this order: its daemons, its
  devices through `simctl shutdown`, every process but its
  `containermanagerd` by SIGTERM, a second's pause, its launchd domain,
  then SIGKILL for what is left. See
  [a host that cannot boot a device](#a-host-that-cannot-boot-a-device).
- **The sweep queue** takes at most `resetting-most` UIDs a pass, in one
  `find` over the Data volume at background priority, logs those users out
  again, sweeps `/private/var/folders` again, and removes their IPC
  objects. It refuses a UID outside the slots' ranges.
- **The held ports** are a small perl program,
  [`device-host-ports.pl`](../../setup/tart/ios/device-host-ports.pl), run
  as `nobody` by the helper's daemon, on 127.0.0.1 and ::1.
- **`resume`** runs at every boot, from the helper's own LaunchDaemon. It
  carries on every slot cut short, starts the sweep queue, and once a boot
  clears each slot's stale BB lock and installer pid file, as the image
  does for its own user (017).
- **The bound:** a second booted device in a slot is shut down after 10
  minutes, with words in `status`. Each slot's cores, memory (its
  processes' physical footprint) and home size are in `status`.
- **The image's additions,** [`host-ios.sh`](../../setup/tart/ios/host-ios.sh),
  which `build-ios.sh` runs as root: the helper and its daemons, the slots'
  home from the pool's `.zshenv`, each runtime's `disabled.plist` kept
  from the image's slim devices, and the carried slots `bbd-i1` and
  `bbd-i2`. `bb-box-check-ios` checks the helper, its daemons, the held
  ports, the carried slots and the UID ranges.
- **The device server under a host's daemon.** A slot's server is
  `host`-managed: `install` and `restart` end it, and launchd starts the
  delivered version within a second; a server that gave up waits for a
  restart instead of exiting. Version 21.
- **Enrolment's hook.** A backend's transports may give
  `daemonKeptByHost`: bb-box then runs BB's installer with its environment,
  `BB_INSTALL_SKIP_SERVICE=1` for a slot, and calls its `takeOver` after
  every bootstrap. [`src/backends/tart/device-host.ts`](../../src/backends/tart/device-host.ts)
  has the slot's hook, the helper's exit codes and a parser of its
  `status`, for unit 4.

### How it was measured

On Linux first, with stub macOS tools: the helper runs against a fake
Mac's disk, users, launchd and simulator
([`test/fake-device-host.sh`](../../test/fake-device-host.sh)), in
[`test/device-host-helper.test.ts`](../../test/device-host-helper.test.ts),
24 cases. [`test/device-host-server.test.ts`](../../test/device-host-server.test.ts)
runs the real device server under a loop standing in for launchd's
`KeepAlive`, and delivers to it with 063's delivery.

Then live, in a dedicated ios box at 8 cores and 32 GiB, from the ios
image of 26 October (macOS 27.0, Xcode 27.0, iOS 27.0 24A434), as root.
The image was not rebuilt: `host-ios.sh` ran in the box as `build-ios.sh`
runs it. Times are wall-clock in the box, from `perl`'s
`Time::HiRes`; the helper's own step times are in its `took=` answers.
The image's own iPhone 18 Pro stayed booted throughout.

### The image's additions

`host-ios.sh` ran in 54.2 s: it kept the iOS 27.0 `disabled.plist` from
the image's iPhone 18 Pro, loaded the helper's daemons, and made
`bbd-i1` in 28.1 s and `bbd-i2` in 25.5 s (user 2.0 and 1.9 s, device
7.3 and 5.7 s, first boot 18.8 and 17.8 s). The check's new lines all
passed but the held ports, whose daemon failed to start as `nobody` with a
log path it could not write; fixed, and passed. The UID check walks the
Data volume in about 30 s.

### Eight slots, made and timed

Made one after another by `make`, each with the device server the box's
own user had (063's delivery, version 19), so each slot's server ran as
soon as its slot was ready:

| Slot | Whole | User | Device | First boot | Server listening after |
| --- | --- | --- | --- | --- | --- |
| 1 | 47.5 s | 2.7 s | 9.5 s | 34.7 s | 0.4 s |
| 2 | 38.1 s | 2.2 s | 11.3 s | 24.0 s | 0.3 s |
| 3 | 28.5 s | 2.1 s | 7.0 s | 18.9 s | 0.3 s |
| 4 | 31.7 s | 2.3 s | 8.0 s | 20.8 s | 0.3 s |
| 5 | 30.3 s | 2.1 s | 7.5 s | 20.0 s | 0.3 s |
| 6 | 32.8 s | 2.1 s | 7.4 s | 22.8 s | 0.3 s |
| 7 | 32.8 s | 2.1 s | 7.2 s | 22.9 s | 0.3 s |
| 8 | 34.1 s | 2.3 s | 7.2 s | 23.9 s | 0.4 s |

Each server's boot check found all 112 services off, so seeding held. M3
gave 38.7 s to a booted device in a VM that had run a while; M13 24.1 to
26.1 s in a VM just booted. Ten slots took the Data volume from 42 to 38
GiB free, about 0.4 GiB each. With 8 ready, each slot's processes had a
physical footprint of about 0.7 GiB, by `top`; summed resident memory said
9.1 GiB, as it counts the simulator's shared mappings once per process, so
`status` reports the footprint. With all 8 ready and idle, no process
used more than 0.13 of a core over 10 s, by `top`.

### H3: enrolment, on a fresh BB

H3 through the plugin moves to unit 4, which gives slots a backend; the
lead agreed. Here a fresh BB, `npx bb-app` with no account, ran as the
box's own user at 127.0.0.1:4999, with direct machine access. For each
slot, `bb machine create --provider manual` gave the enrolment command,
which ran over SSH as the slot's user under `env BB_INSTALL_SKIP_SERVICE=1`,
as enrol.ts now runs it; then the helper's `daemon`:

| Slot | Installer | `daemon` | Connected after `daemon` |
| --- | --- | --- | --- |
| `bbd-i1` | 5.8 s | 0.98 s | 0.8 s |
| `bbd-1` | 4.7 s | 1.43 s | |
| `bbd-2` | 6.3 s | 1.43 s | 0.6 s |
| `bbd-3` | 5.5 s | 1.40 s | 0.6 s |

Each installer's own daemon connected 0.6 s after it returned, as M14
found. `daemon` moved it into a LaunchDaemon as the slot's user, with its
command, port (38889 and 38890, as the installer chose) and data folder,
and stopped the installer's. A terminal made through the fresh BB on
`bbd-i1`'s machine ran as `bbd-i1`, UID 79991, with `BB_PORT_BASE=20000`,
and `simctl` listed one device, its own.

### A new device server delivered to a slot

063's delivery script, version 20 from this branch (21 after the rebase),
run as the slot's user against a running version 19:

| Slot | Delivery | Serving the new version after |
| --- | --- | --- |
| `bbd-3` | 0.12 s | 0.25 s |
| `bbd-4` | 0.11 s | 0.26 s |
| `bbd-5` | 0.10 s | 0.25 s |

Asked: within 2 s. M15 measured 1.67 s. The log says `start ... by host`.
The carried `bbd-i1`, claimed with no server, got one by the same
delivery in 0.19 s; its device, first booted when the image's setup made
it, booted cold in 1.5 s, and its companion listened 108 ms after it
started. The claim itself took 0.13 s, and booted `bbd-i2` in the
background as the ready slot.

### A cold restart with slots held

Twice, by a resize with restart, as M16 did.

| | First | Second |
| --- | --- | --- |
| Restart | 79.6 s | 91.8 s |
| Servers serving after the VM booted | 7 s | 38 s |
| Devices booted cold, all at once | 9, in 63 to 66 s | 7, in 31 to 59 s |
| Every companion listening after the VM booted | 86 s | 112 s |
| Slot BB daemons | failing on a stale lock | running at their first start |
| Machines connected after the fresh BB answered | | 31.7 and 34.2 s |

Nobody signed in for any of it: the helper's daemon, the held ports, every
slot's device server and BB's daemons came up by themselves. The first
restart found two faults. BB's daemons in the slots failed at every start
on the `daemon.lock.lock` the hard stop left, so `resume` now clears it
once a boot. And the fresh BB, started from `/tmp` by mistake, came back
empty as macOS clears `/tmp` at boot; the second run kept it in the
user's home. M16 had its machines connected 10.9 s after BB answered; here
31.7 and 34.2 s. BB's daemons had tried for about 50 s against a BB that
was down, and are likely backing off between tries. That is BB's own; the
daemons were running throughout.

### A CoreSimulatorService killed while three slots stream

Slots 4, 5 and 6 each showed the research's busy page and streamed through
idb, read by the research's [`multi.ts`](../research/ios-shared-hosts/multi.ts)
with its taps off. 15 s in, slot 7's CoreSimulatorService got SIGKILL.
Frames a second in each 5 s window from the kill:

| Slot | Before | During and after | Worst gap, 5 s before to 15 s after |
| --- | --- | --- | --- |
| 4 | 19.4 to 19.6 | 19.2 to 19.6 | 55 ms |
| 5 | 19.4 to 19.6 | 19.2 to 19.6 | 54 ms |
| 6 | 22.2 to 22.4 | 22.0 to 22.2 | 48 ms |

The busy page draws at about 20 frames a second in this VM; nothing
changed through the kill. Slot 7's own device: its server saw it stop 3.0
s after the kill, booted it again in 2.9 s, and had it back 8.3 s after
the kill, streaming 1.2 s later. Two more kills within 5 minutes met 063's
rule, and the server left the device stopped with "Restart the box to
start it again", which a box in a slot cannot do.

### H7: plant and check, with the held ports

As box A, slot 7, over SSH as its user, as `box_run` reaches a box:
files in `/tmp`, `/Users/Shared`, `/private/var/tmp` and its home; a
LaunchAgent; a crontab; a keychain with an item; a second device, booted;
a process that ignores SIGTERM; and a server on 127.0.0.1 at its
`BB_PORT_BASE`. As box B, slot 10, at the same time:

| B reaching A's | Result |
| --- | --- |
| home, and a file in it | refused |
| keychain | refused |
| device set | refused |
| device server's socket, idb's socket | refused: permission denied |
| process, by signal | refused: operation not permitted |
| a file A left readable in `/tmp` | readable, as 064 says |
| server on A's port, 127.0.0.1:20800 | reached, HTTP 200: loopback is shared, as 064 says |
| 8081 or 3000, to bind | refused: address already in use |
| 8081 or 3000, to ask | HTTP 421, with the held ports' words |

The image's own user binding 8081 on 127.0.0.1 and on 0.0.0.0, with
`SO_REUSEADDR`, was refused too.

A's release took 15.6 s: 5 s of it waiting for the process that ignores
SIGTERM, the rest the devices' shutdown. Its sweep found 32 paths and left
none. Then, as the next slot's user, `bbd-14`: every planted file, the
home, the crontab and the cron job's file gone; no process of UID 80007;
A's port free to bind. A check as root, `find -xdev -uid 80007` over the
Data volume, found nothing, in 35 s. One run had found one process of the
old UID left: a `distnoted` started after the release, as the pool's
helper describes for Spotlight. The sweep now logs the users out again and
sweeps `/private/var/folders` again; after that, a release cut short and
run again left no process and no folder of its UID 20 s after its sweep.

### A release cut short, and run again

The helper was killed with SIGKILL 0.15 s into a release, and again 1.2 s
into one with the gentle stop. Each time the slot was left in
`resetting processes`, with no answer given. Run again, each carried on
from that step and answered `released=yes last=no`, in 0.88 and 8.24 s,
with the user removed and the sweep queued.

### Releases and sweeps

| | Release | Its processes step | Sweep, one pass |
| --- | --- | --- | --- |
| Before the gentle stop, slots with a booted device | 2.0 to 4.1 s | 0.4 to 1.3 s | 26 to 149 s for one UID |
| With it | 5.6 to 15.6 s | 4.5 to 12.1 s | 44.6 to 203.9 s for one UID; 57.8 s for two in one pass |

Every sweep left nothing. Sweeps run at background priority, so they are
slower than M17's 31.8 s, most when devices are busy beside them.

### A host that cannot boot a device

After a few releases, no slot could boot a device, while the image's own
user could. CoreSimulatorService asserted in
`-[SimDeviceIOServer loadAllBundlesWithError:]`: "Failed to create audio
route descriptor", after a 30 s timeout. The simulator's audio service
was waiting on `com.apple.cmio.registerassistantservice`, which had hung
in a container query. Its log showed why: the release ended a slot's
processes in one SIGKILL, so the service, as it cleaned up after the
slot's idb_companion, queried that user's `containermanagerd` while it was
being killed ("XPC connection to containermanagerd interrupted. Retry
attempt 1 of 6"), and never answered again. Restarting the service did not
help; a restart of the VM did.

The gentle stop ends every other process of the user first, and its
`containermanagerd` a second later with its launchd domain. Checked both
ways on one boot: after a release with the gentle stop, a new slot's first
boot passed in 17.2 s; after a release with the old stop, the next first
boot failed as before. After the next restart, four releases with the
gentle stop, one of them H7's and one cut short, were each followed by a
first boot that passed, in 27.7 to 47.2 s.

### Checks

| Check | Result |
| --- | --- |
| tsc, the node suite, vitest, on a Linux box | pass |
| The docs test, from a clone of the bundle | pass |
| 064's live check for unit 3, in a dedicated ios box as root | every item above, H3 by bb-box's exact commands |

### What limits these checks

- **One ios box, one Mac, one evening.** The cold restarts, the wedge and
  its fix were each seen on one VM; the gentle stop held for 5 releases.
- **H3 through the plugin** waits for unit 4, which places boxes in slots.
- **The streams** were read from idb in the box, not through BB's relay
  and a browser. The busy page drew at about 20 frames a second, so the
  check shows steadiness through a kill, not the encoder's room.
- **The image was not rebuilt.** `host-ios.sh` ran in a box made from the
  current image, as `build-ios.sh` will run it. The carried slots in a
  real build are made before the image is shut down and cloned.

### Deviations from 064

- **A release takes 6 to 16 s,** not 1.5 s: the gentle stop shuts the
  devices down and waits for the user's processes, so the host's
  CoreMediaIO service never wedges. A slot still leaves `most` when its
  user is removed.
- **`disk-reserve-gib` 40 does not fit this image.** The ios box had 42
  GiB free, so a host would refuse its second slot. The live check used 5.
  Unit 4 should give hosts a larger disk, or the default a smaller
  reserve: a slot took about 0.4 GiB.
- **Status reports memory as physical footprint,** not resident memory,
  which counts the simulator's shared mappings once per process.
- **A slot's device server is `host`-managed:** 063's delivery installs
  it by ending it, and `connect` waits for it, as 064 says; its words say
  the host's daemon runs it. "bb-box has asked the host to start it again"
  is unit 4's, which can ask the helper.
- **`ahead` is kept by the helper,** which makes a spare slot after a
  claim or a release that leaves fewer ready than `ahead`.
- **`carry` makes each carried slot once in a host's life,** and keeps
  any that exists, so a rerun of `host-ios.sh` never gives a carried UID
  again. A rerun before this fix, in the live check, gave UID 79991 a
  second time.

## F-5: safety fixes to the host helper

Built and checked on 26 and 27 October 2026, after an independent safety
review of unit 3's helper. The helper is in no image yet; the ios image is
rebuilt after this.

### What changed

| Finding | Fix |
| --- | --- |
| 1, high: `daemon` made and chowned `logs` in the slot user's own BB folder as root, so a link there gave the user `/Library/LaunchDaemons` | BB's launchd log is `/private/var/log/bb-box-slots/<user>.log`: the folder root's, mode 755, the file made by root and then given to the user, mode 644. Root writes nothing in the user's BB data. It reads the pid and port files as the user, only from folders and files the user owns that are not links, and stops the installer's daemon as the user |
| 2, high: a sweep file named "80001 0" reached `find -uid 0` and `pkill -u 0` | The queue is read by path. A file whose whole name is not a slot UID is removed by that name before anything acts. `sweep_pass`, `log_out_again` and `remove_ipc` each refuse any argument that is not a slot UID; `remove_ipc` takes the UID alone and works out the user from it |
| 3: a release cut between moving `claim` and writing `releasing` stranded the slot | `releasing` is written first. The `last` decision is made once, by the release run again or by `resume`, and a held slot whose claim was already moved is released by its `released` file |
| 4: a claim whose slot lock timed out stayed `held` | The claim is removed and the slot is `ready` again |
| 5: a failed macOS lend made the slot `ready` with its device gone | Any failed lend sends the slot to `resetting`, and it is removed. A slot touched for a box is never lent again |
| 6: the seed ran `mkdir -p` in `/private/var/tmp` | `mkdir` alone. A store that exists must be a folder, not a link, of root's or the slot user's. A `disabled.plist` already there is removed, not written through |
| 7: the sweep removed the slot folder named by the file's `slot=` | A sweep file's `slot=` must be a slot number or a carried slot whose UID is the file's name, and its `user=` that slot's user, or the file is removed unswept |
| 8: UIDs wrapped at generation 10000 | No modulo. `make`, `promise` and the top-up refuse once the generation would reach 10000: "let its boxes go, then set it up again" |
| 9: box IDs of dots passed | A box ID starts with a letter or digit |
| 10: boot clean-up followed links | It skips a linked `.bb-machines` or data folder, and one the user does not own, and removes the lock and pid file as the user |
| Floor | `resetting-most` is at least 1: `init` refuses 0, and a hand-written 0 reads as 1. At 0 the sweep looped forever |

One more fault turned up while fixing these. `top_up` set the shell's
`id` and `dir`. A claim that topped up the host lent the new slot it had
just started instead of the one claimed: root wrote the box's key into
that slot's home, and the claim answered with that slot. A release that
topped up carried on the new slot instead of its own. `top_up` and the
`last` decision now run in subshells.

### How it was checked

On Linux, with the stub tools: 14 new cases in
[`test/device-host-helper.test.ts`](../../test/device-host-helper.test.ts),
each planting exactly the link, hand-written file or cut state it is
about. All 37 cases pass. Run against the helper as merged in PR 1169, all
14 new cases fail, and so does the `daemon` case, whose log moved. tsc
and the node suite passed on a Linux box; vitest ran there too.

Then live, in a dedicated ios box at 6 cores and 16 GiB, from the ios
image of 26 October, as root. The image was not rebuilt or changed:
`host-ios.sh` installed this branch's helper in 69.7 s and made both
carried slots.

| Step | Slot 1 | Slot 2 | Slot 3 |
| --- | --- | --- | --- |
| `make` | 52.9 s | 34.1 s | 32.4 s |
| `claim` | 0.11 s | 0.12 s | 0.13 s |
| `release` | 8.8 s | 8.2 s | 8.2 s |

The sweep queue was empty 118 s after the last release: 80001 alone in
60.2 s, then 80002 and 80003 together in 73.6 s, 8 paths found for each
UID and none left. The users, their processes and their logs were gone,
and the image check's slot-UID line found no file of 80000 to 89999 on the
Data volume, in 21 s. Its daemons, held-ports and carried-slots lines
passed too.

**Finding 1's attack.** As `bbd-1`, over SSH with the box's key, as
`box_run` reaches a box: a stand-in for BB's daemon running as the user,
its pid and port files, and `logs` linked to `/Library/LaunchDaemons`.
`daemon` took 0.17 s. `/Library/LaunchDaemons` stayed `root:wheel`,
`drwxr-xr-x`, with the same entries, owners and modes, plus only
`app.bb-box.bb.bbd-1.plist`. launchd ran the stand-in as `bbd-1`, writing
to `/private/var/log/bb-box-slots/bbd-1.log`. As `bbd-1`, adding a link,
moving the log or making a file in that folder were each refused. At a
new boot, `resume` left a root folder behind a linked data folder and a
linked `.bb-machines` alone, and cleared `bbd-2`'s own lock as `bbd-2`.

**The sweep file "80001 0",** written as root with a root file, a root
process and the IPC table as canaries. `reset`, traced with `sh -x`,
answered `refused=80001 0` and ran one command that acts:
`rm -f '/var/db/bb-box/host/sweep/80001 0'`. No `find`, `pkill`,
`launchctl bootout` or `ipcrm` ran, and every canary was unchanged.

### Deviation from the brief

The brief asked for a log file made by root, mode 644. launchd opens a
LaunchDaemon's `StandardOutPath` as its `UserName`: in the box, a
root-owned log, in a folder of mode 700 or 755, failed the spawn with
exit 78 (EX_CONFIG), as the held ports' daemon did in unit 3. So root
makes the file and then gives it to the user, in a folder of root's that
the user cannot write. The user can write their own log, but cannot swap
it for a link or add a file.

## F-6: dedicated ios boxes keep the common dev ports free

Found and fixed on 27 October 2026. The ios image built from unit 3 and
F-5 held 3000, 4200, 5000, 5173, 8000, 8080, 8081 and 19000 in every VM
made from it. That includes dedicated ios boxes, a whole VM for one box,
which need those ports for their own servers: React Native's Metro listens
on 8081. The cause: `device-host install`, run at the image's build,
loaded the held ports' daemon, and launchd started it at every boot.

### What changed

- **`install` writes both plists and loads neither,** unless the host has
  run `init`. In a VM that has not, it takes both out of launchd and out of
  `/Library/LaunchDaemons`. That clears a VM made from the image before
  this fix once the new helper is installed. On a host that has run
  `init`, `install` loads both again, as before, so a new helper's daemons
  start.
- **`init` loads the held ports' daemon and the helper's own.** They are
  in `/Library/LaunchDaemons`, so launchd starts both at each of the
  host's restarts. A daemon already loaded from the same plist is left
  running, so a second `init` does not let the ports go.
- **The helper's daemon does nothing before `init`.** In such a VM, `run`
  ran `resume` and then polled every 5 s. Now it returns at once, and its
  `KeepAlive` is `SuccessfulExit` false, so launchd does not start it
  again after that return.
- **The image check** (`bb-box-check-ios`) now checks that the 2 plists
  are written in `/var/db/bb-box/host`, that the held ports' plist lists
  the 8 ports, that neither daemon is loaded or in
  `/Library/LaunchDaemons`, and that nothing listens on the 8 ports at
  127.0.0.1 or ::1. It does not run `init`, because that would change the
  image. The helper's tests prove that `init` holds the ports.

### What else the image's helper does in a dedicated box

These were measured in a dedicated ios box made from the image built from
`b6347c88`, at 6 cores and 16 GiB, before the fix.

| Effect | Found | Now |
| --- | --- | --- |
| Held ports | `perl` as `nobody`, 9.0 MiB resident, 16 listening sockets: 8 ports on 127.0.0.1 and ::1 | gone |
| The helper's daemon | `sh` as root, 2.6 MiB resident. Each boot it ran `resume`, then every 5 s ran `bound`, which uses `ps` and `awk`. One `bound` took 0.03 s of CPU, measured 3 times with `time`, so about 0.006 of a core | not loaded, and `run` returns before `init` |
| Carried slot users | `bbd-i1` and `bbd-i2`, UIDs 79991 and 79992: hidden, standard, in `_developer` and `com.apple.access_ssh`, each with a random password that is never written down and no SSH key until a claim | unchanged |
| Their homes in `/Users` | 283 MiB and 297 MiB, mode 700 | unchanged |
| Their devices | one iPhone 18 Pro each, shut down, 0.4 MiB each in `/private/var/tmp`. The box user's `simctl` does not list them | unchanged |
| Their processes | none, after a boot | unchanged |
| Helper state | `/var/db/bb-box/host`, 76 KiB, mode 700 | unchanged |

None of the unchanged effects breaks a dedicated box today. The carried
slots cost a dedicated box about 580 MiB of disk and 2 hidden users. Every
VM made from the image has the same 2 users, with the same password hash.

### How it was checked

On Linux, with the stub tools: 4 new cases in
[`test/device-host-helper.test.ts`](../../test/device-host-helper.test.ts).
They check that `install` loads nothing and that a restart then loads
nothing. They check that `install` takes out daemons an older install
loaded, and that `run` makes no call before `init`. They also check that
`init` loads both daemons, keeps them across a restart and across a
second `init`, and that `install` on a host reloads them. A restart in the
stubs is launchd loading what is in `/Library/LaunchDaemons`. The carry
case now follows the image's build: `install`, then `carry`, with no
`init`. A case in [`test/ios-image.test.ts`](../../test/ios-image.test.ts)
checks that the image check's ports are the helper's. tsc, the node suite
and vitest passed on a Linux box.

Then live, as root, in a dedicated ios box from the image built from
`b6347c88`. The image was not rebuilt or changed.

| Step | 8081 | Seen |
| --- | --- | --- |
| The box as made | held | `perl` as `nobody` on 127.0.0.1:8081 and [::1]:8081, HTTP 421 |
| `host-ios.sh` installs this helper, then a reboot | free | launchd has neither daemon. All 8 ports free. `nc -l 127.0.0.1 8081` listened as the box user and received a line sent to it |
| The image check, without device boots | free | the helper, daemons, held ports free, carried slots and slot UIDs lines passed |
| `init` | held | both daemons loaded, HTTP 421. A second `init` left the ports daemon on the same pid. The image check's two lines then failed, as they should |
| A reboot | held | all 8 ports held, `nc -l 127.0.0.1 8081` refused with "Address already in use", and `resume` ran at the new boot |

## Unit 4: Tart hosts, shared still opt-in

Built on 27 October 2026. Device server version 22; the host's helper
version 2.

### What it adds

- **The `ios-hosts` settings** on the Tart backend: `ios-hosts-on`, off by
  default, and `-most` 8, `-ahead` 1, `-resetting-most` 4, `-cores` 8,
  `-memory-gib` 32, `-per-mac` 1 and `-disk-reserve-gib` 10. A host keeps
  the settings it was made with: bb-box gives them to its helper's `init`
  as it starts.
- **The registry places a shared box** ([`#placeInSlot`](../../src/core/boxes.ts)):
  for `shared: true`, it asks every backend whose lender lends the kind for
  its best tier, takes the best in 064's order (ready, join, make, new host;
  the pool Mac before Tart before Namespace in each), and asks again when a
  take loses its race, three times, then refuses with what each lost to. It
  runs in the registry's admission queue, which every acquire passes, so it
  is the one lock for device placement.
- **`SlotLender` on the Tart backend**
  ([`src/backends/tart/ios-hosts.ts`](../../src/backends/tart/ios-hosts.ts)):
  - **`offer`** reads each Mac's owner files for its hosts, and each serving
    host's `status`: a ready slot is `ready`; a slot being made, or a host
    starting with room, is `join`; room for a slot is `make`; a Mac with a
    free VM slot, the iOS image and fewer hosts than `per-mac` is
    `new-host`. Otherwise `wait`, with one sentence per cause, such as
    "The shared iOS host bb-box-host-... has all its 8 slots making, ready,
    held or promised (8 held). No shared iOS host can start on mac1: mac1
    runs a shared iOS host already, as many as it may (1)."
  - **`take`** claims a ready slot with the helper's `claim`; promises a
    place with its `promise`, or, on a host still starting, in the host's
    owner file on the Mac; or makes a new host: in the backend's placement
    chain, with the Mac's room checked again, it writes the host's owner
    file, `starting` with the box promised, and counts the VM against the
    Mac until it runs. So the next acquire joins it.
  - **A host's start** clones the iOS image as `bb-box-host-<id>` at the
    hosts' size, starts it, waits for SSH, installs this bb-box's helper,
    runs `init`, then, under the lender's lock, marks the host serving and
    gives the helper every promise from the owner file. A start that fails
    marks the host failed and deletes it.
  - **A box's acquire** waits for its host, then claims a ready slot, waits
    for one being made for it or as a spare, or has the helper make one for
    it, and is ready once SSH answers as the slot's user.
  - **Release** is the helper's `release`, or `unpromise` for a box that
    had no slot yet. When the helper answers `last=yes`, having written
    `deleting` under its lock, the backend stops and deletes the VM.
  - **The upkeep**: a host that failed and holds no box, one starting for 5
    minutes with no box promised, one marked `deleting`, and one serving
    with nothing held, promised or being made (the helper's new `vacate`
    decides under its lock) are deleted; a host whose VM is not running, as
    after its Mac restarted, is started again; a start an earlier instance
    began is carried on.
  - **Soft draining**: a host whose iOS image build is older than the
    image's lends its ready slots, and joins of slots being made, only while
    no host on the new build can start on its Mac, and makes no new slot.
  - **`held()`** lists each claimed slot of this install as a box's guest,
    with its box, thread, name, kind and creation from the claim, and each
    promise with no owner; the host's own VM is no box's.
  - **`transports`**: SSH to the host's VM as the slot's user, through the
    Mac; no desktop display; and `daemonKeptByHost`, the hook unit 3 added,
    so bb-box's own enrolment runs BB's installer with
    `BB_INSTALL_SKIP_SERVICE=1` and has the helper's `daemon` keep BB's
    daemon.
  - `stop`, `resize`, `planResize` and `grant` refuse a slot's guest in
    words, as the registry does first; `power` and `stopped` follow the
    host's VM, and `start` starts it.
- **The helper, version 2**
  ([`device-host.sh`](../../setup/tart/ios/device-host.sh)): `status`
  gives each claim's install, box, thread, name, kind and creation;
  `unpromise` answers `last` as `release` does; `vacate` writes `deleting`
  for a host that holds nothing; and `restart <slot>` starts a held slot's
  device server daemon again. bb-box installs its own copy at each host's
  start, so a host runs the helper of the bb-box that lends its slots.
- **Every slot stream is capped at two thirds:** on each connection to a
  slot box's device server, the plugin sends `{"type": "cap", "most":
  "two-thirds"}`, until unit 6's ledger.
- **"bb-box has asked the host to start it again."** When a slot box's
  device server does not answer and is not missing, the plugin asks the
  helper's `restart`, and the device's view says: "The device server for
  this box has not started. bb-box has asked the host to start it again."
- **063's words for a device that stopped twice** in 5 minutes, in a slot:
  "Reboot it with box_device reboot to start it again, or release the box
  for a new one: a shared box cannot be restarted." A VM of its own keeps
  "Restart the box to start it again."
- **`slotUid`** has no modulo: generations run from 1 to 9999, as the
  helper refuses 10000, and a placement with a generation past 9999 is
  refused in words.
- **The doctor's check Shared iOS hosts on** each Mac: each host's state,
  its slots held, ready, making and sweeping, its free disk and memory, and
  each held slot's cores, memory and home; with none, whether one can
  start.
- **box_list, `box_acquire` and `bb box acquire`** say what `shared: true`
  gives where a host is set up; the skill says when to ask for `dedicated`,
  and to start servers on the box's ports. The New box form's Shared choice
  is offered once a host is set up, and sends `shared`. A VM of its own
  stays chosen first until shared is the default.
- **Conformance cases** for any backend that lends slots
  ([`slotConformance`](../../test/conformance/suite.ts)): two acquires at
  once share one new host, each in a slot of its own; a box in a slot
  refuses a stop, a resize and a grant in words; a release of one leaves
  the other answering; the last release deletes an elastic host. They run
  against Tart on fakes in `npm test`, and in `npm run conformance` for a
  backend that lends slots.

### How it was checked, before the live check

On a Linux box, against a fake Mac whose host VMs run the real helper on
unit 3's fake macOS ([`test/fake-ios-host.ts`](../../test/fake-ios-host.ts)),
reached through the fake SSH as the VM's and each slot's user:

| Check | Result |
| --- | --- |
| Three boxes placed one after another, as the registry's queue places three asked for at once, then acquired at once | tiers `new-host`, `join`, `join`; one clone of the iOS image; slots `i1`, `i2` and `1`; each reached as its own user |
| A box on a serving host | its take is the claim of a ready slot |
| Releases | the first leaves the host; the last deletes its VM and owner file, and the box's guest is gone |
| A full host, `per-mac` 1 | `wait`, with the host's and the Mac's words |
| Another device than the slot's | `wait`: "A shared ios box has the iPhone 18 Pro, the model every slot is made with. Leave device out for it, or ask for dedicated: true for the iPhone 17." |
| A take that loses the last ready slot | `lost`; the registry asks again, and after three refuses with what each lost to |
| The registry, with the fake backend's elastic lender | three asked for at once make one host; a ninth on a host of 8 is refused with its words; `shared: true` with a size is refused; an ios box without `shared` stays a VM of its own; the last release deletes the host |
| The helper's new verbs | `unpromise` and `vacate` answer `last` and write `deleting` only when nothing keeps the host; `status` gives each claim; `restart` kickstarts the slot's device daemon, for the claim's box only |
| The suite | tsc clean; the node suite 2,108 passed, 0 failed, 288 skipped; vitest 219 passed |

### The live check

Through production BB on 27 October 2026, with `shared: true` asked for,
after the lead deployed this unit (PR 1172) and set `ios-hosts-on`, the
rest at their defaults. The Mac is the Tart Mac, an M4 Max; the iOS image
`bb-box-ios` build.20261027-010302-d8ba, from main 359e7a8b (F-6), macOS
27.0, Xcode 27.0, iOS 27.0; hosts at 8 cores and 32 GiB. The Mac's other
VM slot held another thread's box throughout, so `per-mac` 1 and the Mac's
two VMs both kept any second host out. Faults the check found were fixed
in PRs 1173 and 1174 and deployed during it; each section says which code
it ran on. Times are box_acquire's own timings, BB machines' state is from
`bb machine list`, and the panel was the owner's Helium on the Mac,
driven by playwriter.

| Check | Result |
| --- | --- |
| Three asked for at once, by three `bb box acquire ios --shared` started together (PR 1174) | one host, `bb-box-host-<id>` at one address; slots 1, 2 and 3 (`bbd-i1`, `bbd-i2`, `bbd-1`). Ready in 47.0 s (the first carried slot), 66.3 s (the second, which waited 14.7 s for its warm-up) and 127.9 s (a slot made after the host started, 67.1 s); BB machines 20.4 to 22.0 s after each was ready |
| 8 boxes, each its own device | 8 users, `bbd-i1`, `bbd-i2`, `bbd-1` to `bbd-6`, UIDs 79991, 79992, 80001 to 80006, ports 20000 to 20799, each device a UDID of its own. Each served a page on its own `BB_PORT_BASE` and opened it in its device: each agent screenshot showed its own box's name, user and port |
| Tapped, by the agent | one tap each through `computer_act`; each box's own page server logged exactly one `GET /tapped-1` |
| Tapped, by a person | in the panel, Take control, a tap on the device, control handed back, on each of the 8: every device showed "tapped 2" |
| Streamed | the 8 devices' panels in one Helium tab, 200 px each, the busy page on each: 48.0 to 49.8 frames a second over 10 s each, every one at a third (402x874), as 200 px asks; the worst gap 284 to 304 ms in every panel at the same moment |
| Capped at two thirds (PR 1173) | each connection to a slot's server logs "video: capped at two-thirds". A panel 1400x3000 at 1x with Pixel for pixel on drew 804x1748, and the server's step stayed at two thirds. Under PR 1172 the cap was never sent: see below |
| A ninth | refused: "The shared iOS host bb-box-host-<id> has all its 8 slots making, ready, held or promised (8 held). No shared iOS host can start on mac-1: mac-1 runs a shared iOS host already, as many as it may (1)." PR 1173 adds what frees first |
| A release racing a claim (PR 1174) | the host's last box released, and 1 s later a shared box acquired: the release marked the host deleting; the acquire was placed on a new host, which waited for the old VM to stop, then started: ready in 91.5 s, 61.3 s of it the host. A fault here: see below |
| The last release deletes the host | after the race, and after each of the five first boxes below: the doctor's check says "No shared iOS host runs", and the Mac's room "guests 1 of 2", the other thread's box. The queued image build took the freed VM slot at 03:05:44, 36 s after the release began |
| H3 through the plugin | every slot box was a connected BB machine, `enrolled` by bb-box's own enrolment, its daemon the helper's LaunchDaemon (`system/app.bb-box.bb.<user>` running). A terminal made through BB on two of them ran as `bbd-i1`, UID 79991, and `bbd-6`, UID 80006, each with its own booted device and ports |
| H9: 8 held slots idle | each device on its Home Screen, no viewer, a minute to settle. `top`, three 10 s samples inside a slot: the host's 8 cores 87 to 91% idle, about 0.7 to 1.0 core used in all; the helper's `status`: each slot 0.01 to 0.08 cores, a footprint of 1.4 to 1.5 GiB, a home of 0.5 to 0.6 GiB; `memory_pressure` 86% free. 32 GiB and 8 cores carry 8 idle slots with room |
| Disk | a host just made: 40.8 GiB free on its Data volume (the image's disk is 140 GB, its recovery partition after the main container). With 3 slots, 39.5 GiB; with 8, 36.5 GiB: about 0.5 to 0.6 GiB a slot as made. `disk-reserve-gib` 10 leaves about 26 GiB for 8 slots' builds, about 3.3 GiB each |
| H5: the host's VM stopped with 8 held slots | `tart stop` by the lead at 01:59:37. Under PR 1172, bb-box started it again only at 02:04:09, at the end of a sweep (below); it ran at 02:04:29. Every slot's device server was listening as it ran; the 7 devices then held (one box had been released meanwhile) booted cold together in 33.5 to 35.2 s, their companions listening about 50 s after the VM ran, and all 7 BB machines connected at 02:05:50, 81 s after it ran. In the panel all 7 drew their devices |
| H1: ready claims (PR 1173) | 10 claims, 40 to 50 s apart so the spare was made again: ready in 5.2 to 7.7 s, median 5.9 s; their BB machines 6.5 to 8.7 s after; the panel's first video frame 3.1 to 3.7 s after the view opened (3 claims timed with the counter below). Under PR 1172, 17.0 to 24.6 s |
| H1: a first box on a new host | 5 boxes: ready in 43.3, 47.0, 48.5, 50.6 and 50.7 s, each with the host 34.1 to 42.4 s of it; BB machines 9.5 to 23.6 s after. Their devices booted 2.5 to 48.0 s after the box was ready: the carried slot's cold boot took 9.2 to 39.0 s. The panel's first frame 8.2 to 9.3 s after the view opened, opened as soon as the box was ready |
| H6 | not run: see below |

The first frame was timed by an init script in each panel that marks the
first `drawImage` of a picture at a step of the iPhone 18 Pro's size;
without the size test the page's other drawing counts, so first frames
from before that counter are not given.

### Faults the live check found, and their fixes

| Found | Fix |
| --- | --- |
| The two-thirds cap was never sent: a delivery's own connection, the only one a new slot box gets, skipped it | PR 1173: the cap goes with the owner on every connection, a delivery's too |
| H5: the registry's restart of a crashed box went through the person's stop and start check, which refuses a slot box ("cannot be stopped on its own"), so the host waited for the sweep's upkeep, 4.5 minutes here, as the sweep first observed the 8 stopped boxes one by one | PR 1173: the registry's own restart of a box in a slot is allowed; a person's is still refused. box_status no longer tells a stopped slot box's agent to call box_start |
| A ready claim read the Mac's state three times, once in the offer, the take and the acquire: 17.0 to 24.6 s to ready | PR 1173: a box claimed in its take skips the host check, and a take reuses the offer's read for 15 s: 5.2 to 7.7 s |
| An eighth box was refused while the host's spare was still being made, as the spare fills the eighth place | PR 1173: a spare being made can be joined on a full host |
| The race: a claim that lost to the last release was asked again while the old VM still held the Mac's last VM slot, so it would have been refused | PR 1174: a host being deleted counts as leaving its Mac; the new host starts once the old VM has stopped, and waits up to its 10 minutes for a VM slot if another VM takes it first |
| The race again: the upkeep saw the helper's `deleting` and deleted the VM while the release was still stopping its slot; the release failed with SSH exit 255, and its box stayed "being released" until the next sweep | in this commit: the upkeep leaves a deleting host to a release this instance runs, and to any release for 2 minutes |

### What limits these checks

- **One Mac, one host at a time,** as `per-mac` is 1 and the Mac's other VM
  slot was another thread's. No two hosts ran at once, and new-host
  placement across Macs was checked only on the fakes.
- **H6 did not run.** The image rebuild it needs waited for a free VM
  slot, which my host held, and then failed as `tart get` read a
  `config.json` mid-deletion (the F-2 read race, seen on Tart 2.40.1). The
  lead runs H6 with the next rebuild, holding 3 shared boxes on a host of
  the old build. Soft draining is checked only on the fakes.
- **H5 ran on PR 1172's code,** before the restart fix; the 81 s from the
  VM running to every machine connected stands, the 4.5 minutes before it
  started do not.
- **Streams through the panel** were counted in one tab of the owner's
  browser on a busy page, not tapped to the frame; unit 1's H4 times taps.
- **Release times** were not taken here; unit 3 and F-5 measured them.

### Deviations from 064

- **`ios-hosts-on` is off by default,** the lead's condition for the deploy;
  064 has it on for Tart.
- **`shared: true` with no slot is refused with words,** not placed in a VM
  of its own: tier `own-vm` waits for shared to be the default (unit 6).
- **bb-box installs its own helper in each host as it starts,** so a host
  always runs the helper of the bb-box that lends its slots.
- **A placement's `place` counts from 0,** as the helper's does; box_status
  says "slot 1 of 8" for place 0, whose ports are 20000 to 20099.
- **Every slot has the image's first model;** another model is refused with
  words naming `dedicated`. 064's switch in a slot, by `simctl create` and
  seeding, is a follow-up.
- **The registry's lock for device placement is its admission queue,**
  which every acquire passes already.
- **The doctor's page has no ledger;** the ledger is unit 6.
- **A host's disk is the image's, not grown:** growing a macOS VM's disk
  needs its recovery partition removed. `disk-reserve-gib` is 10 instead
  of 40, from the numbers above.
- **The New box form keeps A VM of its own chosen first** while shared is
  opt-in.
- **"A VM is starting on this Mac" for its viewers** is not built; it goes
  with the ledger in unit 6.

## Unit 5: pool Mac slots

Built on 27 October 2026. The host's helper version 3; the pool's Mac
helper version 2.

### What it adds

- **A Mac whose SSH host pool line lists `ios` lends iOS slots,** each a
  macOS user with its own device, to ios boxes asked for with
  `shared: true`. The owner's answer holds: the Mac lends slots before
  whole boxes. Leaving `ios` off a Mac's line keeps it for whole boxes.
- **The slots' helper is unit 3's `device-host`,** set up on the Mac as a
  kept host ([the iOS image's guide](../../setup/tart/ios/README.md#shared-hosts-device-host)):
  - never deleted: its last release and `vacate` answer `last=yes` and
    write no `deleting`
  - no carried slots, and no carried slot's UID
  - closed while the Mac is lent whole: `close` is refused with exit 8
    while a slot is held, promised or being made for a box. Otherwise it
    lets the held ports go and removes every ready spare before it
    answers. A spare being made is removed when its step ends
  - `open` takes bb-box's settings each time, as the pool's Mac is never
    made again, holds the common dev ports and makes the spares `ahead`
    asks for
  - `summary` gives what the pool's status needs
- **`machine slot`** in `machine-mac.sh` runs the slots' helper, as the
  admin user may run only the Mac's helper as root. Its commands are
  `status`, `summary`, `open`, `close`, `make`, `promise`, `unpromise`,
  `claim`, `release`, `daemon` and `restart`. `open`, `make`, `promise`
  and `claim` are refused with exit 7 while the Mac's owner or resetting
  marker is there: "The pool's Mac is lent whole to a box, so it lends no
  iOS slot until that box is released." `status` adds `slots.*` lines.
- **Whole or slots, never both.** A whole claim, and an operator's reset,
  close the slots first, under the Mac's lock. While a slot is held, the
  claim is refused with exit 3: "The pool's Mac is lending iOS slots (1
  held). It is lent whole again when they are released." The pool's
  capacity check says the same, naming the Mac, so a `macos` or
  `macos-desktop` box goes to another offer or waits with those words.
- **`SlotLender` on the pool backend**
  ([`slots.ts`](../../src/backends/ssh-pool/slots.ts)):
  - `offer` gives a ready slot as `ready`, a spare being made as `join`,
    room as `make`, and a closed Mac that is not lent whole as `make`,
    which the take opens. Otherwise it waits, with a sentence for each
    Mac and "The next slot is likely free when a box on the pool's Mac is
    released." while a slot is held. The registry already puts the pool's
    Mac first in each tier.
  - `take`, `acquire`, `release`, `held`, `power`, `transports` with
    `daemonKeptByHost`, and `restartDeviceServer` follow Tart's. A slot
    box reaches the Mac over SSH as its slot's user.
  - The upkeep opens a Mac that lists `ios` and is not lent whole when it
    is closed, its settings changed, or it has fewer spares than `ahead`.
    It closes a Mac whose line no longer lists `ios` once nothing is held.
- **The pool's `ios` offer is for slots only** (`slotsOnly` on the
  kind): its capacity refuses a plain acquire with "The SSH host pool
  lends ios boxes only as slots on its Macs, each a macOS user with its own
  device. Ask for shared: true." Its device is the model and runtime the
  Mac's slots are made with. The doctor's check that offers of a kind
  agree does not count a slot offer's missing desktop. box_list takes the
  kind's words from an offer that is not slots-only.
- **`mac-ios.sh`,** which `setup-mac.sh` runs when Xcode has its iOS
  platform and `setup/tart/ios` is beside `setup/ssh-pool`:
  - installs idb_companion from its pin, checked by SHA-256
  - installs the slots' helper, its held ports' program, the slots' home
    and the device list
  - for the newest iOS runtime, installs the slimming list and makes its
    seed: a device made as bb-box's admin user, booted and slimmed twice.
    The seed is kept only if its store has every label of the list off
  - sets the helper up as a kept host, closed
  - `setup-mac.sh` then prints the Mac's line with `ios`
- **The pool's reset stops a box user gently,** as unit 3 found a slot
  must be stopped: its devices shut down by `simctl` where one runs,
  every process but its `containermanagerd` asked to end, a second's
  pause, its launchd domains, then SIGKILL for what is left. Before, it
  booted the user out and sent SIGKILL at once, the same fault.
- **Settings** `ssh-pool-ios-hosts-most` (12), `-ahead` (1),
  `-resetting-most` (4) and `-disk-reserve-gib` (40). The doctor's
  `<machine>: iOS slots` check says whether the Mac's slots are set up,
  whether it lends or is lent whole, and its slots held, ready, making and
  sweeping.
- **Conformance:** `slotConformance` for the pool, non-elastic, on the
  fakes in `npm test`
  ([`conformance-pool-slots.test.ts`](../../test/conformance-pool-slots.test.ts)),
  and through `npm run conformance` for a pool whose Mac lists `ios`.

### How it was checked, before the live check

On a Linux box, against a fake Mac running the real `machine-mac.sh` and
`device-host` on stub macOS tools:

| Check | Result |
| --- | --- |
| The kept host | closed at `init`, no carried slots, no ports until `open`; `open` takes the settings each time; a last release and `vacate` write no `deleting`; `close` refused with `held=` and `waiting=` while a slot is held or a box waits, and otherwise removes the spares and lets the ports go; a spare being made as it closes is removed when its step ends |
| The Mac's helper | a whole claim refused with 064's words while a slot is held, and the operator's reset too; once released, the whole claim closes the slots; while lent whole, `make`, `promise`, `claim` and `open` refused with words; a whole claim removes a ready spare's user first; slot commands need the slots set up and a slot's number |
| The gentle stop | the old box user's devices shut down, then each process but `containermanagerd` sent SIGTERM, then its launchd domain, then SIGKILL |
| `mac-ios.sh` | idb_companion from its pin, kept when at the pin; the seed has every label of the list off; a seed short of a label, or no slimming list for the runtime, fails with words; `setup-mac.sh` warns without `setup/tart/ios`, or when `mac-ios.sh` fails, and leaves `ios` off the line |
| The pool backend | the `ios` offer after a survey, slots only; the first take opens the closed Mac; a slot made and lent, its placement "On a shared iOS host (the pool's Mac), slot 1 of 12"; the whole kinds refused with words while it is held, and lent once it is released; a whole box closes the slots, an ios box then waits with words, and the upkeep opens the Mac after the whole box's release; another model refused naming `dedicated` |
| Conformance | the pool's slot cases on the fakes: two acquires share the Mac, each in a slot of its own; stop, resize and grant refused in words; a release leaves the other answering; the last leaves the Mac up |
| The suite | from a clone of the bundle on origin/main at 184db15f, on a Linux box: tsc clean; the node suite 2,142 passed, 0 failed, 288 skipped; vitest 220 passed; the docs test passed |

Then on a real Mac: a dedicated ios box, a Tart VM of the iOS image at 6
cores and 16 GiB, macOS 27.0, Xcode 27.0, iOS 27.0, made to stand in for a
fresh pool Mac. The image's carried slots, helper state and seed were
removed, a `bbbox-admin` user made, and this branch's `machine-mac.sh`
installed and initialised. Times are wall-clock in the VM.

| Step | Result |
| --- | --- |
| `mac-ios.sh`, as root | 186 s: idb_companion 1.7.7 downloaded and checked; the seed made as `bbbox-admin`, 112 of 112 labels off; the helper kept and closed, its own daemon loaded, no ports held |
| `machine slot open`, then `make` | 0.13 s; then 30.7 s: user 2.0 s, device 7.7 s, first boot 20.7 s |
| `machine slot claim` | 0.15 s. SSH as `bbd-1` with the box's key: its own booted iPhone 18 Pro, `BB_PORT_BASE=20000`, no sudo. 127.0.0.1:8081 answered with the held ports' words |
| A whole claim while slot 1 was held | refused, exit 3: "The pool's Mac is lending iOS slots (1 held). It is lent whole again when they are released." |
| `machine slot release` | 11.7 s, with the gentle stop; no process of UID 80001 left |
| A whole claim with a ready spare | 11.8 s: the spare's user removed, port 8081 free; then `promise` refused, exit 7 |
| The sweeps | 91.1 s and 69.5 s, one UID a pass, each 8 paths found and 0 left; `find -x /System/Volumes/Data -uid` found nothing of 80001 or 80002 |
| The slot conformance cases, through this branch's pool backend with the VM as its Mac | 5 of 5 passed in 92 s, the first opening the closed Mac and making two slots for two boxes acquired at once |

### The live check on the pool's Mac

Through production BB on 27 October 2026, on main 23e94b9 and then this
branch's doctor words, with `ios` on the pool Mac's line. The pool's Mac is
the M5 Max with 18 cores and 36 GiB, macOS 27.0.1, Xcode 27.0, iOS 27.0
(24A434), idb_companion 1.7.7. Its slots were set up with the iOS-only
step in the pool's guide, not `setup-mac.sh`. Boxes were acquired with
`bb box acquire ios --shared` from this thread. Times are box_acquire's
own timings. The doctor's `iOS slots` line gives the slots' load and
sweeps from the helper's status, as root.

| Check | Result |
| --- | --- |
| 12 slots made and held | the first claimed the ready spare: ready in 5.0 s. The next 11 one after another, each claiming the spare made after the one before: ready in 10.3 to 26.4 s. Slots 1 to 12 of 12, users `bbd-4` to `bbd-15`, ports 20000 to 21199, one booted iPhone 18 Pro each. The doctor: "12 held, 0 ready, 0 making, 0 sweeping, of 12" |
| 12 held, idle | each slot 0.00 to 0.01 cores, a footprint of 1.4 to 1.9 GiB, a home of 0.0 to 0.4 GiB. The Mac 94.6% idle over 3 s by `top`; `memory_pressure` 78% free; 293 GiB of disk free |
| Between two slots | as `bbd-15`: `bbd-4`'s home refused, its process not signalled, a file it left readable in `/tmp` readable, 127.0.0.1:8081 answered with the held ports' words |
| A whole box while slots are held | `bb box acquire macos-desktop --on "SSH host pool"` refused: "The pool's Mac mac-1 is lending iOS slots (12 held). It is lent whole again when they are released." A `macos` box earlier, with 1 held, the same words with "(1 held)" |
| Releases | one slot box in 10 s; the other 11 together in 17 s |
| Lent whole once they end | the same `macos-desktop` box: a claim of 12.6 s, which removed the ready spare first; ready in 13.9 s. A `macos` box earlier: a claim of 9.0 s |
| A reset leaves nothing | one slot box planted a file in `/tmp`, `/private/var/tmp` and `/Users/Shared`, a crontab and a process that ignores SIGTERM. From the whole box, after the 12 releases: no process of a slot UID, none of the planted files, no `bbd-` user or home, 8081 free. 48 entries in `/private/var/tmp` and 12 folders in `/private/var/folders` of slot UIDs were left to the sweep queue, and gone 91 s later |
| H11 | every sweep the doctor showed left nothing: passes of 1 to 4 UIDs found 8 to 38 paths and left 0, in 33 to 51 s; after the H1 boxes' releases, passes found 30 paths and left 0, in 34 s. The helper has Full Disk Access for remote users |
| The whole box's release | 75 s and 35 s, two releases, each stopping the box user gently, as helper version 2 does; the next box user signed in, and the slots reopened at the next upkeep |
| H1: ready claims | 10 claims, 50 s apart so the spare was made again: ready in 4.9 to 8.9 s, median 5.35 s; BB machines enrolled 6.8 to 11.7 s after. The first, opening the closed Mac and making its slot, 27.2 s |
| A slot's device | `box_status` of a claimed box read its device live: booted, upright, 1206x2622, and "On this Mac: 0 of about 6 full-size streams' room in use" |

### Faults the live check found, and their fixes

| Found | Fix |
| --- | --- |
| The pool Mac's sshd had `AllowUsers ... bbbox-admin bbx-*`, so SSH as a slot user never answered and the first box failed after 300 s | a host step: the owner added `bbd-*`. PR 1187: the error, the pool's guide and `mac-ios.sh` name it, and `mac-ios.sh` warns when sshd refuses slot users |
| That failed box's slot stayed held after the box was released, until the sweep restored the box and a second release freed it: the slot acquire did not give back what it took when it failed | PR 1187: a failed slot acquire gives back its slot or promise |
| H11 had no reading but as root on the Mac | PR 1185: the doctor's line gives each held slot's load and the last sweeps |
| The doctor gave a sweep pass's paths found once for each UID in it, and no sweeps while the Mac is closed or lent whole | in this commit: once a pass, with its UIDs, and in every state |

### What limits these checks

- **H1's first frame in the panel was not timed.** The ready and
  enrolment times are box_acquire's and BB's; the panel's first frame
  needs the owner's browser, as unit 4 timed it. A slot's device answered
  `box_status` at once.
- **The 12 slots were idle.** They booted their devices and stayed on the
  Home Screen; nothing streamed or built. 064's POOL measured twelve busy.
- **The gentle stop of a whole box user** ran on two releases, neither
  with a simulator of the box user's booted.
- **One Mac.** The pool has one Mac that lends slots.

### Deviations from 064

- **No `slots` marker in the pool's state.** The slots' `closed` marker,
  written under the slots' lock, and the owner marker, under the Mac's
  lock, decide between whole and slots. A whole claim closes the slots
  under the Mac's lock before it makes its owner marker with `ln`. A slot
  claim checks the owner marker under the Mac's lock, then claims under
  the slots' lock, which a closed host refuses.
- **The switch is `ios` on a Mac's line,** not an `on` setting: a Mac
  lends slots only where its line lists `ios`.
- **A release takes about 12 s, and removing a spare for a whole claim
  as long,** not 1.5 s, as unit 3's gentle stop shuts the devices down.
- **`disk-reserve-gib` is 40 on the pool,** as 064 says. Tart's is 10.
- **Slot generations on the pool's Mac never restart.** After slot 9999
  it lends no slot until its slots are set up again, which 064's ranges
  imply.

## Unit 8: `macos` boxes in slots

Built on 27 October 2026. The host's helper is unchanged: its macOS lend,
and F-5's reset of a failed one, were already there.

### What it adds

- **`shared: true` on a `macos` acquire takes a slot** on a shared iOS
  host, by the same placement as an ios box: the pool's Mac first, then a
  serving Tart host, then a slot being made, then a new Tart host. Both
  lenders lend `macos` where they lend `ios`. The claim names the box's
  kind, and the helper deletes the slot's device and its device server's
  daemon before it answers. A host with a `macos` box in it stays up for it
  as for an ios box.
- **A `macos` slot is never lent back as an ios slot.** Its release removes
  the slot's user and queues its sweep, as an ios slot's does; a later ios
  claim gets another slot, made with a device of its own.
- **A `macos` box without `shared` is a VM of its own,** as before. Where a
  host lends slots and no VM has room, the refusal keeps the backend's
  words and adds what `shared: true` gives.
- **Words for a box in a slot by its kind.** `dedicated` is for ios boxes
  only, so every refusal of a shared `macos` box names what to ask for
  instead: a `macos` box without `shared` for a VM of its own, or
  `macos-desktop` for a desktop. A stop, a start, a restart, a resize and a
  grant are refused in those words, and so are `box_run` with `desktop`,
  `box_record` and the computer tools, each saying the box has no console
  session. box_status's Root line says so, and a new Desktop line: "none. A
  shared macos box has no console session: no app windows, screenshots,
  computer use or macOS permission grants." A size with `shared` is refused:
  "A shared macos box has no size of its own. Leave shared out for a VM of
  its own at that size."
- **box_list's `macos` line** says what `shared: true` gives where a host
  lends slots, and nothing of it where none does.
- **A refresh of capabilities keeps a slot box's slot capabilities.**
  Before, the registry's refresh gave any box its kind's capabilities once
  its backend said the guest was as offered, which Tart says of every ios
  guest once its devices are known: a slot box could get root and the
  host's desktop back in its record. Found while building this unit.
- **The New box form** offers the Machine choice for `macos` once a host
  lends slots, with words of its own: Shared, "Ready in seconds, for
  commands, builds and the iOS Simulator. No sudo, Homebrew installs,
  desktop or app windows. Other boxes on the host share its cores and
  ports, and see its processes."; and A VM of its own, chosen first. Shared
  sends `shared` and no size; A VM of its own sends neither `shared` nor
  `dedicated`.
- **`box_acquire`'s and `bb box acquire`'s `shared`** say what it gives a
  `macos` box. The skill and the Tart and pool guides say it too.
- **Conformance:** `slotConformance` runs for `macos` on both fakes, in
  files of their own, with a case for `macos`: a released `macos` slot is
  not the slot a later ios box gets. `npm run conformance` runs it for any
  backend that lends `macos` slots.

### How it was checked, before the live check

On a Linux box:

| Check | Result |
| --- | --- |
| The registry, on the fake backend lending ios and macos slots | a `macos` box with `shared: true` placed in a slot, with no root, desktop, computer use or device; box_status's Where, Root and Desktop lines; a stop, a resize, a restart, a grant and `box_run` with `desktop` refused in their words, none naming `dedicated`; commands run; a size with `shared` refused; `dedicated` on `macos` refused; without `shared`, a VM of its own; the host deleted with its only `macos` box |
| No room for a `macos` VM | refused with the backend's words and what `shared: true` gives; an ios box's refusal names no `macos` slot; with no host lending slots, no hint, and no Machine choice |
| A refresh of capabilities | an ios and a `macos` slot box keep no root and no desktop |
| The helper, on stub macOS tools | a `macos` claim leaves its user no device and no device daemon, and `status` names its kind; its release removes the user; the slot is refused to an ios claim while it resets; the next ios claim gets another slot with a device of its own; once swept, only that slot and the one keeping the host are left |
| Conformance on the fakes | Tart and the pool, `macos`: two boxes share a host, the refusals, a release leaving the other answering, the `macos` slot not lent again, and the last release |
| The form, in vitest | for `macos` with a host lending slots: both choices with their words, A VM of its own chosen; ArrowUp chooses Shared and moves the focus, the size goes, Create sends `acquire macos shared`; then ArrowDown back and Create sends `acquire macos`. With no host lending slots, no Machine choice |
| The suite | from a clone of the bundle on origin/main at 4e425d92, on a Linux box: tsc clean; the reference check passed; the node suite 2,158 passed, 0 failed, 288 skipped, the docs test among them; vitest 222 passed |

### The live check

Through production BB on 27 October 2026, after the lead deployed this unit
(PR 1178, main 75298f5). Tart hosts only: the pool's Mac slots are not on.
The Mac is the Tart Mac; its other VM slot held another install's VM
throughout. Times are box_acquire's own timings; the panel was the owner's
Helium, in its "var" profile, driven by playwriter in a tab of its own.

| Check | Result |
| --- | --- |
| box_list | the `macos` line says what `shared: true` gives, as built |
| A first `macos` box with `shared: true`, no host running | a new host, slot 1 of 8, ports 20000 to 20099: ready in 52.3 s (host 37.6 s, slot 5.2 s, SSH 0.3 s), a BB machine 8.6 s after |
| In it, by box_run | user `bbd-i1`, UID 79991, in `_developer`; `BB_PORT_BASE` 20000; `sudo -n` asks for a password; `simctl list devices` lists no device; no device server daemon for the user; home `drwx------`; Xcode 27.0 |
| A second `macos` box with `shared: true` | the ready spare: slot 2, ready in 9.4 s, a BB machine 6.1 s after |
| box_status | Where, Root and Desktop lines as built; no Size line |
| Refusals, each in its words, none naming `dedicated` | box_stop, box_start, box_resize, box_resize with restart, box_grant, box_run with `desktop`, box_record and computer_windows |
| A size with `shared` | "A shared macos box has no size of its own. Leave shared out for a VM of its own at that size." |
| A `macos` box without `shared`, on Tart, its two VMs in use | refused: "No Mac can take this macos box: Two macOS VMs already run on mac-1, Apple's limit (...). Release or stop a macOS box, or stop another VM there." and then what `shared: true` gives |
| The second box released | within 15 s, from the first box: no user `bbd-i2`, no process of UID 79992, no LaunchDaemon for it |
| The next ios box with `shared: true` on that host | slot 3, user `bbd-1`, UID 80001: a new slot, not `bbd-i2`'s, with its own booted iPhone 18 Pro. Ready in 8.1 s, a BB machine 9.7 s after |
| The last release | the host deleted: the doctor says "No shared iOS host runs", and the Mac's room is back to 1 of 2 VMs |

The New box form, in the production panel at 360 px wide:

| Check | Result |
| --- | --- |
| macOS chosen | the Machine choice under System: Shared and A VM of its own, with their words, wrapped to the width; A VM of its own chosen, Size shown |
| By keyboard | from A VM of its own, ArrowUp chose Shared and moved the focus and the tab stop to it, and Resources went; ArrowDown went back, and Size came back; Tab left the group for Architecture |
| Type Desktop | no Machine choice, as `macos-desktop` takes no slot |
| Create with Shared | a `macos` box in slot 1 of a new host: ready in 80.3 s (host 43.9 s, slot 4.0 s; the timings do not say where the rest went), a BB machine 10.6 s after. Released at once |

### Faults the live check found, and their fixes

| Found | Fix |
| --- | --- |
| box_list's line and the panel gave a slot box a size, "6 cores, 16 GiB memory", the kind's default it was asked at; the panel showed a VM badge; box_status's Form line said "a macOS VM". Unit 4's ios slot boxes had the same | in the follow-up commit: a slot box has no size in box_list or the panel and no form badge, and its Form line is "a macOS user on a shared iOS host" |

The fix was checked from a clone of its bundle on main at 75298f5, on a
Linux box: tsc clean; the reference check passed; the node suite 2,158
passed, 0 failed, 288 skipped, the docs test among them; vitest 222 passed.
It is not yet checked in the production panel.

### What limits these checks

- **Tart hosts only.** The pool's Mac slots are not on, so a `macos` box
  in a pool slot was checked only on the fakes.
- **Builds were not run in a slot here.** M12 measured a Swift package, an
  iOS app built for testing and an XCUITest run as a slot's user.
- **The host's deletion was not timed;** it was gone at the next doctor
  run, about a minute after the last release.

## F-7: follow-ups from units 4 and 8, and from 063

Built on 27 October 2026. Device server version 24; the host's helper
stays at version 3.

### What changed

| Item | Found | Fix |
| --- | --- | --- |
| 1, the reload race | A host's start marked it `serving` on the Mac, then gave its helper each waiting box's promise. Between the two, another instance of the same install, as during a reload, saw a serving host whose helper held nothing, and its upkeep vacated and deleted it | The start writes `handing-over=<time>` in the host's owner file under the same lock that marks it `serving`, and removes it once the helper has every promise. No instance's upkeep vacates a host handing over, for 5 minutes at most, so a start that died leaves no host kept for ever |
| 2, BB's app in the ios image for slots | Each new slot's enrolment downloaded BB's app into an empty home and npm installed it | `keep-bb-app.sh`, run by `host-ios.sh` until F-8 replaced it, keeps the image user's BB app, only `npm` and `host-artifact.sha256` of each server BB's installer wrote, in the slots' home. `device-host` clones the slots' home into each new home with `cp -c`, so carried and made slots both have it, and APFS shares its blocks |
| 3, 32 s missing from a slot box's timings | A slot box's total runs from its record's making. Its placement on a shared host, each lender's offer and the take, which for a new host waits on the Tart backend's placement chain, came before the backend's `host`, `slot` and `ssh` steps and no step counted it | A slot box's timings give it as `shared-host`, "choosing a shared host". A new host's take that waits 2 s or more for the Tart backend's other placements says so in the log. The live check says which part was the 32 s |
| 4, the doctor past 120 s | Each backend's doctor was already bounded at 30 s. The device servers' section looked for Device Hub in each ios box one after another, each up to 15 s for its command and longer for the box's transports and power when it did not answer. A stopped host's boxes took about 40 s each | The device servers' checks run for every device box at once, and each look for Device Hub gives up after 15 s, saying "it waited 15 s for box ... to answer a command over SSH as its slot's user on the shared iOS host ..., and stopped waiting". The Tart backend's check of shared iOS hosts gives each host 15 s, and says what it waited on: its address from Tart, or its helper's status over SSH |
| 5, Android's network line | Both reports were true. 063's 6.3 s was a watching viewer's state: the device server reads the settings every 10 s while a viewer wants video, and once as each connection opens. With no viewer, nothing read them, so box_status showed the last read until a box_device action read them again | box_status asks the device server for a `settings` read, which it makes at once, 41 to 82 ms on Android (063), and answers with the state read. bb-box asks only a server of version 24 or later, and waits 3 s at most |
| 6, switching the model in a slot | Refused, but as "This box has no iPhone 17", while box_list lists the iPhone 17 for ios boxes. A slot has one model, the one every slot is made with; making another in a slot needs the device server to make and seed a device in the slot's user, not a small change | box_device switch to a model the slot lacks is refused before it reaches the device: "A shared ios box has only the iPhone 18 Pro, the model every slot is made with, so it cannot switch to the iPhone 17. Acquire an ios box with dedicated: true for the iPhone 17: a VM of its own, which switches between every model box_list gives." |

### How it was checked, before the live check

On a Linux box:

| Check | Result |
| --- | --- |
| 1: two Tart backends of one install on one fake Mac | the first starts a host for a box, held at its promise to the helper; the second's upkeep, run while the host starts and again once it is serving with the promise not yet taken, leaves it; the box then gets its slot; the last release deletes the host. On the code before, the second upkeep deleted the host |
| 2: `keep-bb-app.sh` on a fake home | the server's `npm`, links kept, and its build, nothing of the user's machine (`auth.json`, `host-id`), no server without a build, and an earlier copy removed; a home with none says so |
| 2: the helper's `make` on the stub tools | the slot's home has the kept app and build, owned by the slot's user |
| 3: the registry, on the fake backend lending slots | a slot box's timings have `shared-host`, which its total counts, and box_status gives "choosing a shared host"; a VM of its own has none |
| 4: five ios boxes, four on a host that does not answer | the device servers' checks in about 1 s with a 1 s bound, each silent box's check saying what it waited on; the Tart backend's check of a host whose helper hangs ends in its bound with "bb-box waited on its helper's status over SSH at ..., through mac1" |
| 5: the device server | a `settings` request reads the device and answers with a change made outside bb-box, with no viewer |
| 5: box_status | asks the device server for the read before it answers, and gives the network it read |
| 6: box_device on a shared ios box | the switch refused in those words; nothing reaches the device |
| The suite | on origin/main at 7e616a96 with the six commits, on a Linux box: tsc clean; the reference unchanged; the node suite 2,167 passed, 0 failed, 288 skipped, the docs test among them; vitest 222 passed |

### Item 2, measured in a dedicated ios box

In a dedicated ios box at 8 cores and 32 GiB, from the ios image of 27
October (build 20261027-010302, macOS 27.0, Xcode 27.0, iOS 27.0), as
root. The image was not rebuilt. A fresh BB, `npx bb-app` with no
account, ran as the box's own user at 127.0.0.1:4999, its machine access
direct. For each slot, `bb machine create --provider manual` gave the
enrolment command, which ran over SSH as the slot's user under
`env BB_INSTALL_SKIP_SERVICE=1`, as bb-box's enrolment runs it. Times are
from each installer line's arrival, by `perl`'s `Time::HiRes`.

Before: two slots made by the image's own helper, whose homes have no BB
app. After: BB's app for the fresh BB put in the image user's home as
`customize.sh` puts production's, then this branch's `host-ios.sh` run as
`build-ios.sh` runs it, and two slots made by its helper.

| | Slot | `make` (user step) | The installer | Of it, BB's app |
| --- | --- | --- | --- | --- |
| Before | `bbd-3` | 27.8 s (2.2 s) | 5.80 s | downloaded and installed, 3.48 s |
| Before | `bbd-4` | 25.2 s (2.0 s) | 4.72 s | downloaded and installed, 2.57 s |
| After | `bbd-5` | 27.2 s (3.0 s) | 2.75 s | "The identical server host artifact is already installed", 0.14 s |
| After | `bbd-6` | 31.9 s (3.7 s) | 2.64 s | the same, 0.13 s |

- **The installer is 2.1 to 3.2 s shorter,** each daemon connected 1.2 s
  after it was started either way.
- **The saving is npm, not the download:** BB's app is 1.4 MB, and
  production's took 0.03 to 0.04 s to fetch from the box. npm installed it
  and its dependencies into an empty home in 2.4 to 3.4 s.
- **The user step is about 1 s longer,** for the clone and its `chown` of
  about 65 MB a server. `host-ios.sh`'s keep step took about 1 s for two
  servers.
- **No more disk:** free disk fell 0.31 and 0.37 GiB a slot, as without
  the app (unit 3: about 0.4 GiB), as the clones share their blocks.
- **The rest of 7 to 24 s** to a connected BB machine is elsewhere: 2.6 s
  of the installer is enrolling and starting the daemon, then the helper's
  `daemon`, about 1 to 1.4 s (unit 3), and bb-box's wait to see the machine
  connected.

### What the image rebuild needs

Run `prepare-ios-image.sh` as for any ios image, from a macOS image built
with `--bb-url` set to BB's server URL, so the image user's home has BB's
app. Nothing else changes. The build's log then says "kept BB's app for
<server>, build <digest>"; without it, "kept no BB app", and slots
download it as before. A slot finds the app only while BB's server has the
build the macOS image was made with. A newer server build downloads as
before, so the image is worth rebuilding when BB updates, as the macOS
image is.

### The live check

Through production BB on 27 October 2026, after the lead deployed F-7 (PR
1180, main e0b8509, device server version 24). Tart hosts only. The Mac's
other VM slot held another thread's box throughout. Times are each tool's
own, and `bb box doctor`'s wall-clock.

| Item | Check | Result |
| --- | --- | --- |
| 1 | A shared ios box with no host running, and bb-box reloaded (`bb plugin reload`) 38 s later, while its new host started | **Failed: a fault, below.** The box failed after the reload: "No Mac can take this ios box: Two macOS VMs already run on mac-1 (..., shared iOS host bb-box-host-<id>)", with "Where: A VM of its own". The host stayed `starting` with no box promised. The window item 1 fixed was not reached |
| 1 | The next shared box, 6 minutes later | joined the host left `starting`, and its acquire carried the start on: ready in 37.3 s (host 27.9 s). So a later instance does carry on an earlier one's start |
| 3 | A shared `macos` box on that host | Timings: choosing a shared host 5.5 s, host 27.9 s, slot 3.6 s, ssh 0.3 s, total 37.3 s: every second counted. A ready claim on it, a shared ios box: choosing a shared host 5.4 s, ssh 0.3 s, total 5.7 s, as the claim is the take |
| 3 | The first box, before the reload | choosing a shared host 10.5 s |
| 4 | `bb box doctor`, the host running with two slot boxes | 12 s |
| 4 | The host's VM stopped by the lead (`tart stop`), the doctor run twice | 29 s and 29 s, where it ran past 120 s. "Shared iOS hosts on mac-1: bb-box-host-<id>: its VM is not running." "Device Hub in <box>: bb-box could not look in box <box>: it waited 15 s for box <box> to answer a command over SSH as its slot's user on the shared iOS host bb-box-host-<id>, and stopped waiting." |
| 5 | An Android box, Pixel 8, no viewer open. `adb shell` turned airplane mode on, Wi-Fi and data off, and night mode on, then box_status | the first box_status after it: "dark, changed outside bb-box", "network offline, changed outside bb-box". Turned back by `adb`, the next box_status: "light", "network online" |
| 6 | box_device switch to the iPhone 17 in a shared ios box | refused: "A shared ios box has only the iPhone 18 Pro, the model every slot is made with, so it cannot switch to the iPhone 17. Acquire an ios box with dedicated: true for the iPhone 17: a VM of its own, which switches between every model box_list gives." |

### The fault the live check found, and its fix

| Found | Fix |
| --- | --- |
| A shared box being acquired across a reload failed. The old instance's dispose aborted its acquire, and the registry's catch set the box's guest to null, as for a VM a backend releases when it throws. A slot's place is not released so: the host kept the box's promise. The new instance resumed the box with no guest, so the Tart backend placed it as a VM of its own, which the Mac's two VMs, one of them the host, refused. The sweep then dropped the promise as no record's | in the follow-up commit: the registry marks the guest a lender's take gives, and keeps a slot box's guest when its instance stops mid-acquire; the next instance resumes the box on its host. A host's start cut short by its instance stopping no longer marks the host failed and deletes it: the next instance carries the start on, as it did here |

Checked on a Linux box, from main at e0b8509 with the fix: a registry case
where dispose keeps a shared box's place and the next start makes it ready
in the same slot; a Tart case where one backend stops while its host's
helper runs `init`, the host is neither failed nor deleted, and a second
backend places the box on that host, one clone in all. tsc clean; the node
suite 2,169 passed, 0 failed, 288 skipped, the docs test among them; vitest
222 passed. Item 1's reload check ran again after the fix's deploy: below.

### Item 1 again, and item 2's image, after the fix

After the lead deployed the reload fix (PR 1181, main 7fa5e44) and
rebuilt the ios image from main e0b8509 (build 20261027-064516), whose
build log said "kept BB's app for <server>, build 3427d9e8...".

| Check | Result |
| --- | --- |
| Item 1: a shared ios box with no host running, and bb-box reloaded 38 s later, while its host started | ready 83 s after the acquire, 45 s after the reload, in slot 1 of the host that was starting, a connected BB machine. Timings: choosing a shared host 14.7 s, host 35.6 s, slot 0.4 s, ssh 0.3 s, total 74.4 s. The 23.4 s no step counts is the time from the old instance stopping to the new one's sweep resuming the acquire |
| A second shared ios box, the host's ready spare | choosing a shared host 6.5 s, ssh 0.3 s, total 6.8 s; BB enrolment 6.9 s. The first box's: 11.5 s |
| Item 2: the slots' homes | the slots' home holds BB's app, build 3427d9e8..., and the carried slot `bbd-i2`'s home had it from the image build. BB's server gives build 634c1bfd... now, so its installer downloaded and installed that build over it, and the doctor warns that the ios image "has another build of BB's app than BB's server gives" |
| The last release | the host deleted: "No shared iOS host runs" |

Item 2 saves its 2 to 3 s only while BB's server gives the build the
image kept. That build comes from the macOS image the ios image is made
from, so both need rebuilding after BB updates; here the macOS image was
older than the server's build.

### What limits these checks

- **Item 1's handover window was not seen live:** a reload 38 s into a
  start overlapped it once, after the fix, and the box was placed; whether
  the new instance's upkeep ran inside the window is not known. The
  two-instance case is checked on the fakes.
- **Item 3's 32 s from unit 8 was not seen again:** these placements took
  5.4 to 10.5 s. If it comes back, the timings now name it.
- **With the host stopped, the doctor's device server line still said
  "booted"**, from the last state the link had; only the Device Hub line
  said the box did not answer.
- **Item 5 ran on Android only.** iOS settings take the same request.

## Unit 6: the encoder ledger, then shared by default

Part A, the ledger, built on 27 October 2026. Device server version 25.

### What it adds

- **A ledger per Mac, in the plugin**
  ([`encoder-ledger.ts`](../../src/core/encoder-ledger.ts)). Every iOS
  device bb-box streams on a Mac is in that Mac's ledger, in a VM of its
  own or in a slot: a Tart backend's dedicated ios boxes and its hosts'
  slots on one Mac share one, and the pool's Mac has its own. A stream
  counts its frames a second over the last 10 s, with a floor of 20, times
  its frame's cost from 064's table, interpolated by pixels: 0.18 for a
  third of an iPhone 18 Pro, 1 for the whole, 1.75 for a whole iPad Pro
  13-inch. Android and the test device are not counted: their frames are
  not encoded by the Mac's encoder.
- **Budgets by chip.** 320 full-size iPhone frames a second for an Apple M4
  Max and 375 for an Apple M5 Max, from E1 and POOL. The Tart backend reads
  each Mac's chip with its state; the pool backend reads it once over SSH.
  A chip not in the table is measured by a probe of two encoders for 15 s,
  run only while the Mac's ledger has no stream: ffmpeg's
  `h264_videotoolbox`, hardware only, on the Mac, as M8 and M11 measured.
  Until it is measured, or where the Mac has no ffmpeg, the ledger assumes
  320 and the doctor warns.
- **The cap and the order.** The ledger keeps the sum within three
  quarters of the budget. Over it, it lowers the step of the lowest in 064's
  order first, the largest stream first within it: the agent's waits, then
  streams only watched, then recordings, then the device a person has
  control of. A stream never goes below a third, nor a recording below a
  half. At most two streams a Mac are at full size: the person in control
  first, then those already at full. The person in control keeps a
  full-size place for **Pixel for pixel**. A lowered stream rises again
  only after there has been room for 10 s; a stream that was not lowered
  follows its viewer at once, and so does the person in control.
- **Caps sent to each server.** A stream not lowered has no cap. A lowered
  one is capped at its step, with words. The cap goes on every connection
  of the lease holder, as unit 4's did, and whenever the ledger changes
  its mind.
- **The device server reports** (`BB_DEVICE_VIDEO`, version 25): to the
  lease holder, the step it streams at, each want with who wants it (a
  viewer, a recording or the agent's wait) and its step, the cap, and its
  frames a second over the last 10 s, at each change and every 2 s while
  the stream is wanted; to its viewers, the ledger's words, at each change
  and to each viewer as it connects. The cap request takes `words`. A
  server before version 25 gets no words and is not counted, and keeps
  unit 4's cap until the delivery on its first connection replaces it.
- **The control connection stays open while the stream is wanted,** so
  the ledger keeps hearing from it. Before, it closed after 10 minutes with
  no agent request, whoever watched.
- **The words.** Under the device's toolbar, while its stream is lowered:
  "Shown at a lower resolution: this Mac's video encoder is busy with 3
  other devices (box ios-2, box ios-5, box ios-7).", naming four and "and
  N more". Beyond the cap, with every stream at its floor: "This Mac's
  video encoder is full, so frames come more slowly." box_status, for an
  ios box: "On this Mac: 4 of about 5 full-size streams' room in use." The
  doctor's new check `encoder.<mac>`, Video encoder on each Mac: the room
  in use, the streams, the budget and where it came from, and the boxes
  shown lower.
- **New hosts on the Mac with the fewest streams.** Tier `new-host` is
  offered for each Mac with room, the Mac whose ledger uses least first.
- **The warning while a VM starts.** Each time the Tart backend starts a
  macOS VM on a Mac, a host or a box, every device streaming on that Mac
  shows "A VM is starting on this Mac; video may slow for about 30 s." for
  30 s.
- **The setting `encoderLedger`,** general and advanced, on by default.
  Off, every slot box's stream is capped at two thirds, as unit 4 left it,
  and no other is.
- **The guide** ([desktops](../guide/desktops.md)) says what a viewer sees.

### How it was checked, before the live check

On a Linux box, from the branch on origin/main at c8236a73:

| Check | Result |
| --- | --- |
| Frame costs and budgets | the table's points read back: 0.18, 0.33, 0.57, 1 and 1.75; a still stream counts 20 frames a second; the cap is 240 for an M4 Max and 281 for an M5 Max |
| The order, 10 busy devices on an M4 Max: the person in control at Pixel for pixel, one recording, eight watched at two thirds | the person in control at full, the recording at two thirds, the eight lowered to a half or a third, within 240 |
| A recording's floor | six recordings beside the person in control, over the cap: each at a half, never a third, and the allotment says the cap is exceeded |
| At most two at full | three at full asked: two; one already at full keeps its place; the person in control takes one from a stream already at full |
| Rising | a lowered stream rises 10 s after room came, not before; a lower step, the person in control and a stream not lowered move at once |
| The ledger, 10 devices on one Mac | the nine passive viewers capped, each told "busy with 9 other devices (box ios-0, box ios-2, box ios-3, box ios-4 and 5 more)"; box_status's line "4 of about 5"; control handed to another device moves the full-size place to it |
| One Mac, two backends | a dedicated box and a slot on one Mac count in one ledger; the pool's Mac in its own, at 375 |
| A VM starting | the words for 30 s, then gone |
| Off | no cap and no words from the ledger; box_status has no line |
| The probe | not run while a stream is on the Mac; run once when its ledger empties; its measure is the budget after; a chip in the table is never probed |
| The device server | reports each want with who wants it, the step and frames a second to the lease holder; tells each viewer the words, and a viewer that connects later at once; a cap with no words, as an older bb-box sends, still reads |
| The plugin's device servers | with the ledger on, a slot box's version 25 server is capped at nothing on connection, then at the ledger's step with its words; off, at two thirds again |
| The Tart backend, two Macs | the new host offered on the Mac whose ledger uses least, and on the other when that changes; the host's VM start warns its Mac, with the chip read from the Mac; each box names its Mac and chip |
| The suite | tsc clean; the node suite 2,190 passed, 0 failed, 288 skipped, the docs and reference tests among them; vitest 222 passed |

### The live check, on one host

Through production BB on 27 October 2026, after the lead deployed Part A
(PR 1183, main a7ba5d7, device server version 25) and set
`tart-ios-hosts-most` to 9 for the check. The Mac is the Tart Mac, an M4
Max; the Mac's other VM slot held another install's VM throughout, so no
dedicated box could run beside the host. 8 ios boxes with `shared: true`
took slots 1 to 8 of one host. The panels were the owner's Helium, driven
by playwriter: one tab holding the 8 boxes' pages, each 355x588 CSS
pixels, each with Pixel for pixel on, so each asked for full size. Each
panel's frames were counted for 10 s by wrapping its canvas's `drawImage`,
with each frame's size. "Busy" is unit 1's `flip.html?busy` in Safari,
whose bar changes colour each frame; the host's CPU is from `top` in a
slot.

| Case | Ledger | Steps | Frames a second in each panel | The host's CPU |
| --- | --- | --- | --- | --- |
| 8 busy | on | 2 at full, 6 at two thirds | 20.1 to 23.4 | 0% idle |
| 4 busy, 4 on the Home Screen | on | 1 busy and 1 still at full, the rest at two thirds | the busy: 49.0 to 49.6; worst gap 255 to 267 ms, at the same moment in each | 32% idle |
| The same, then a person takes control of a busy box at two thirds | on | that box at full at once; a still box at full drops to two thirds, with the words | the busy: 49.5 to 49.9 | |
| The same | off | all at two thirds, the person in control's too | the busy: 42.2 to 42.4 | |
| 8 busy | off | all at two thirds | 20.1 to 22.0 | |

- **The words, seen in the panel,** under each lowered device's toolbar:
  "Shown at a lower resolution: this Mac's video encoder is busy with 7
  other devices (box calm-pebble, box fond-eagle, box merry-beacon, box
  nimble-cloud and 3 more)." Not on a device at full size, and none with
  the ledger off.
- **box_status** on each: "On this Mac: 0 of about 5 full-size streams'
  room in use." at the acquire. **The doctor:** "Video encoder on
  <mac>: On this Mac: 2 of about 5 full-size streams' room in use. 8
  streams; an Apple M4 Max, about 320 full-size iPhone frames a second.
  Shown at a lower resolution: box calm-pebble, box fond-eagle, box
  merry-beacon, box nimble-cloud and 2 more."
- **Not 55 frames a second, and not for the encoder.** 8 busy slots took
  the host's 8 cores to 0% idle: each busy slot's Safari about a third of a
  core, and its own `cfprefsd` and `diagnosticd` about a tenth each. The
  ledger counted about 120 of the encoder's 320, so its cap never acted
  beyond the two at full size. With 4 busy and a third of the host idle,
  the busy streams came at 49 frames a second, as unit 4 measured at a
  third (48.0 to 49.8), with the same stalls in every panel at once: a
  limit neither of the host's CPU nor of the encoder, and the same with the
  ledger off.
- **A still device kept a full-size place** over busy ones, as the ledger
  keeps the streams already at full; the person in control took one at
  once.
- **A first busy page that redrew the whole screen** each frame saturated
  the host at 8 devices (load 77, then over 300 after Safari was relaunched,
  with 78 `MTLCompilerService` running). Rebooting the devices then: 5 of
  8 rebooted in 11 to 104 s; 3 timed out at 120 s and their devices were
  marked failed ("simctl could not wait for the device to boot"), though
  booted. `box_device reboot` then refused them ("The iPhone 18 Pro is not
  booted"), while the toolbar tells a person to reboot a failed device from
  More. Restarting their device servers recovered them. A follow-up for
  063.
- **The Tart doctor still said** "Each slot's stream is at two thirds at
  most until the encoder's ledger comes." Fixed in the follow-up commit.

### H8: a host and a dedicated box on one Mac

Through production BB on 28 October 2026, on main 6dc0f1b (F-8, device
server version 26), with `tart-ios-hosts-most` set to 9 for the check. The
Tart Mac, an M4 Max, with both its VM slots for this check: one ios box
with `dedicated: true` (6 cores, 16 GiB) and 9 with `shared: true` on one
host (8 cores, 32 GiB). The panels, the busy page and the counting are as
above: 10 panels in one tab of the owner's Helium, each with Pixel for
pixel, so each asked for full size; 5 devices on the Home Screen
throughout.

| Case | Ledger | Steps | Frames a second in each panel | The host's CPU |
| --- | --- | --- | --- | --- |
| The dedicated box and 4 slots busy | on | the dedicated box and one busy slot at full; the rest at two thirds | the dedicated box 55.4; the slots 27.6 to 28.4 | about 0 to 10% idle |
| The dedicated box and 2 slots busy | on | the same | the dedicated box 57.5; the slots 48.4 and 49.1 | 35% idle |
| The same, a person takes control of a busy slot at two thirds | on | that slot at full at once; the dedicated box, only watched, at two thirds, with the words | the dedicated box 57.7; the slots 50.2 and 50.6 | |
| The same, still in control | off | every slot at two thirds, the person in control's too; the dedicated box stayed at two thirds with the words: a fault, below | the dedicated box 57.4; the slots 49.1 and 49.4 | |

- **One ledger for the Mac.** Every lowered panel's words counted 9 other
  devices, the dedicated box among them: "Shown at a lower resolution: this
  Mac's video encoder is busy with 9 other devices (box nimble-birch, box
  noble-hill, box proud-eagle, box quick-plover and 5 more)." The doctor:
  "On this Mac: 3 of about 5 full-size streams' room in use. 10 streams;
  an Apple M4 Max, about 320 full-size iPhone frames a second."
- **Passive viewers stepped down first.** The person in control took a
  full-size place at once from the dedicated box, which was only watched; a
  busy slot already at full kept its place, as F-8 has it.
- **55 frames a second or more:** the dedicated box at full size, 55.4 to
  58.2, in every case. The slots, not: 48 to 52 with 2 busy and a third of
  the host idle, the ceiling unit 4 and the one-host check measured, and 28
  with 4 busy on a saturated host. The encoder was never the limit: the
  ledger counted about 3 of 5 full-size streams' room.
- **A VM starting.** The dedicated box was stopped and started again (17.4
  to 17.6 s each time) three times while the 2 slots streamed. Each time
  every slot's server took "A VM is starting on this Mac; video may slow for
  about 30 s." and dropped it 30 s later (00:11:17 to 00:11:47, 00:13:37 to
  00:14:07 UTC, and 00:08:05 at the first). Counted in 5 s windows in the panels, each of the 10 showed
  the words from 00:13:42 to 00:14:07. The 2 busy slots ran at 47.8 to 54.0
  frames a second through the start, against 51.2 to 53.0 before it; one
  window after the warning ended, as the dedicated box's own stream
  reopened, they fell to 38.6 and 39.4, then were back at 49.8 to 51.2. E1
  measured 36 to 43 for 8 half-size streams while a VM started; here, with
  2 busy streams, the start cost one 5 s window of about a quarter of their
  frames.
- **The first host failed to start.** Three slot boxes asked for at once
  made a host whose VM did not start: "Tart could not start bb-box-host-...
  on mac-1: Error Domain=VZErrorDomain Code=1 "The virtual machine
  failed to start."", which failed its three boxes. Three asked for while it
  started were refused, "Two macOS VMs already run", rather than joining it.
  The next three made a host that started. Not seen before; the doctor
  showed another install's VM on the Mac, stopped, which counts against its
  room.
- **The pool's Mac goes first.** Without `on`, the 9 slots went to the
  pool's Mac, as 064's order says; they were acquired again with
  `on: "Tart ..."` for the check.
- **A panel fell back to stills** after the frame holding the box being
  stopped reloaded: the page draws full-size screenshots about 5 times a
  second while its server streams at a third. Rebuilding the panels brought
  video back.

### Faults H8 found, and their fixes

| Found | Fix |
| --- | --- |
| The ledger switched off left a box in a VM of its own at its last ledger cap and words: off, the ledger's "no cap" is not sent, and the switch then capped only slot boxes | in the follow-up commit: off, a box that is not in a slot is sent no cap and no words, where its server is version 25 or later |

### Deviations from 064

- **Desktops are not counted.** 064 counts a macOS desktop's video from a
  Tart VM (060) and a Windows desktop encoded on the Mac (046). Their
  servers report no frames a second to bb-box, so the ledger cannot count
  them; a follow-up.
- **A stream that is not lowered has no cap,** so a viewer that asks for
  more gets it at once where there is room. Where there is none, the
  ledger's cap reaches the server within the server's 1 s hold.
- **The person in control rises at once,** not after 10 s, as do streams
  that were not lowered; only a lowered stream waits.
- **The probe runs on the Mac itself, with ffmpeg,** where the Mac has it.
  064 does not say where. Neither Mac here needs one: both chips are in the
  table.
- **Every macOS VM the Tart backend starts warns its Mac,** not only a new
  host: E1's slowdowns came from a box's VM and a host's alike.
- **A server before version 25 is not counted.** It keeps unit 4's cap
  until the delivery on its first connection replaces it.

### Part B: shared by default

`SHARED_IOS_BY_DEFAULT` is on. Built on 27 October 2026, in a commit of
its own after Part A.

- **An ios box asked for with no options takes a slot** where a backend
  lends ios slots: by 064's order, the pool's Mac, then a serving Tart
  host, a slot being made, then a new Tart host on the Mac whose encoder
  streams least. Where every lender says wait, the box is a VM of its own,
  as before, and the log says why it had no slot. Where neither can be
  had, it is refused with both reasons: "No shared iOS host had a slot:
  ... And no VM of its own could be had: ...".
- **063's suspended ios spare** is claimed only when no slot can be had.
- **The owner's answer 2:** a size, cores, memory or disk without
  `dedicated: true` is refused, "A shared ios box has no size of its own.
  Ask for dedicated: true with a size.", where a backend lends ios slots.
- **A VM of its own without asking,** as no slot can give it: another device
  than the slots' model, and `slim: false`. A project's own ios image, a
  spare, your machines and a box from a build stay VMs of their own.
- **`shared: true`** still takes a slot or is refused; `dedicated: true` is
  today's box.
- **box_list's ios line,** where a host lends slots: "Shared by default: a
  macOS user on a Mac or VM shared with other ios boxes, ready in seconds,
  with its own device, files and keychain, but no sudo, and cores and
  processes shared; where no shared iOS host has room, a VM of its own. ...
  Ask for dedicated: true for a VM of its own, with sudo, brew install and
  its own cores, ports and desktop; a size needs it. Another device than the
  first, or slim: false, gets a VM of its own."
- **The New box form** chooses Shared first where a host lends slots, and
  Shared sends `shared` with no size; A VM of its own sends `dedicated`
  with its size.
- **The skill, `box_acquire`'s and `bb box acquire`'s words, and the Tart
  and pool guides** say shared is the default.

#### What changes for an agent that acquires `ios` today

In production, with `ios-hosts-on` set on the Tart backend:

| The agent asks for | Today | With Part B |
| --- | --- | --- |
| `{kind: "ios"}` | a Tart VM of its own at 6 cores and 16 GiB, or a suspended spare: sudo, Homebrew, the host's desktop, stop, start and resize | a macOS user in a slot: ready in about 6 s from a ready slot (H1, unit 4), or about 45 to 50 s when it starts a host. No sudo, Homebrew installs or host desktop; stop, start, resize, restart and grant refused in words naming `dedicated`; the iPhone 18 Pro only, and a switch to another model refused; servers on its ports from `BB_PORT_BASE`, the common dev ports answering an error; a BB machine as before. Where no slot can be had, today's VM |
| `{kind: "ios", size: "large"}` or `cores`, `memory_gib`, `disk_gib` | a VM at that size | refused: "A shared ios box has no size of its own. Ask for dedicated: true with a size." |
| `{kind: "ios", dedicated: true}`, with or without a size | a VM | the same |
| `{kind: "ios", device: "iPhone 17"}` | a VM with the iPhone 17 | the same |
| `{kind: "ios", slim: false}` | a VM, not slimmed | the same |
| `{kind: "ios", shared: true}` | a slot, or refused | the same |

The first ios box on a Mac with no host now starts a host, which takes one
of the Mac's two VM slots, as a VM of its own did, and later ios boxes join
it.

#### Checks

| Check | Result |
| --- | --- |
| The switch on, a backend lending 2 slots | two ios boxes with no options in slots, with slot capabilities and Where lines; the third a VM of its own, with root; `shared: true` refused with the host's words; a size refused; `slim: false` and `dedicated: true` with a size VMs of their own; after a release the next box takes the slot |
| Neither a slot nor a VM | refused with both reasons |
| The switch on, no backend lending slots | an ios box with no options, and one with a size, are VMs of their own; box_list says no shared host is set up |
| The switch off | units 2, 4, 8 and F-7's tests, each with the switch off: an ios box with no options a VM of its own, a size needs no `dedicated`, `shared: true` opt-in |
| The form | with shared the default, Shared chosen first, no size, Create sends `acquire ios shared` |
| The suite | tsc clean; the node suite 2,192 passed, 0 failed, 288 skipped; vitest 223 passed |

The live acquire of `ios` with no options waits for Part B to be merged.

#### Deviations from 064

- **A size is refused only where a backend lends ios slots.** With no
  shared iOS host set up, every ios box is a VM of its own, so a size needs
  no `dedicated` there.
- **Another device than the slots', and `slim: false`, give a VM of its
  own** rather than a refusal, as they cannot be had in a slot.
- **The form's Shared sends `shared`,** which refuses where no slot can be
  had, as the person chose it; an agent's acquire with no options falls back
  to a VM of its own.

## F-8: follow-ups from units 4 to 6

Built on 27 October 2026. Device server version 26; the host's helper
version 4.

### What changed

| Item | Found | Fix |
| --- | --- | --- |
| 1, a failed Tart slot acquire | A Tart slot acquire that failed after its take kept the slot or promise it was placed with, as the pool's did before PR 1187: the registry expects a backend to give back what a failed acquire took | It releases the slot, or gives back the promise, unless its acquire was aborted or its instance is stopping, as at a reload, when the next instance resumes the box in the same place (F-7) |
| 2, a reboot under load | Under load, `simctl bootstatus` timed out at 120 s on devices that had booted, and the reboot marked them failed. `box_device reboot` then refused a failed device as not booted, as the driver checked that before every control | A reboot whose start fails reads the device from `simctl`; where it reads Booted, the driver attaches to it again instead of failing it. `box_device reboot` acts on a failed device, as Android's driver did |
| 3, the doctor's device server line | It gave the state the link last had: "booted" while the shared host's VM was stopped | The doctor asks the server for its state, waiting 3 s at most. With no answer, or no connection, it says the state now is not known, why, and what the server last said when |
| 4, BB's app for slots | The ios image kept the image user's BB app for the slots (F-7), stale after each BB update: slots then downloaded and installed the newer build over it, and the doctor warned | bb-box installs the build BB's server gives as the host's own user (the image user on a Tart host, bb-box's admin user on the pool's Mac), checked against the server's SHA-256, at a host's start and in its upkeep. The helper's new `keep-app`, as root, copies it into the slots' home and every ready slot no box has claimed: no link that is absolute or leaves the app, nothing writable by others or owned by another user, the build read from the copy. Otherwise it removes the slots' home's copy, so slots download the app. The image keeps no BB app |
| 5, a start re-run by another instance | Another instance's upkeep ran again a host start that had been `starting` for over 5 minutes, while the first still waited for room | A start writes `start-by=<instance>` and `start-beat=<time>` in the host's owner file, under its lock, and the beat every 30 s. Another instance's upkeep, or a box's acquire, waits for a start whose instance beat in the last 2 minutes, however old. A start cut short by its instance stopping gives up its claim at once. The doctor gives a starting host's instance and age |
| 6, a still device at full size | A still device kept a full-size place over a busy one, as the ledger keeps the streams already at full | A busy stream, over 5 frames a second, that has wanted full size for 10 s takes a still one's place, and rises at once. The person in control keeps theirs first, and a busy stream at full keeps its place |

### How it was checked, before the live check

On a Linux box:

| Check | Result |
| --- | --- |
| 1: a Tart acquire whose claim hook throws after its slot is claimed | the slot is released, no promise is left, and the next box gets a slot. On main the slot stayed held |
| 2: the iOS driver on a fake `simctl` | a reboot whose `bootstatus` fails once while the device reads Booted is booted, and says why; a boot that fails leaves the device failed; a reboot of the failed device boots it, and a control works after. On main the reboot of a failed device was refused |
| 3: the doctor, with a real device server | answering: its state now; stopped with SIGSTOP: "it did not answer within 1 s, so the device's state now is not known. It last said ... at ... UTC."; idle-closed: says bb-box closed its connection, ok |
| 4: the helper's `keep-app` on stub macOS | the host user's app copied into the slots' home and the ready slot, the claimed slot untouched, a slot made after has it; another build removes the copy and new slots have none; an absolute link, a link out of the app and a file others can write each refused; `from` a slot's home and a bad server folder refused. The install script with stub `curl` and `npm` and the real `shasum`: installs once, refuses another digest. A Tart host that serves runs the install and `keep-app`, and the doctor says the slots get the build. `machine slot keep-app` takes the home of the user who ran it through sudo, whatever `from` it is given |
| 5: two Tart backends of one install, the first's start held at its helper's `init`, the owner file aged 10 minutes | the second's upkeep and a box's acquire wait for it; `init` ran once; the doctor gives "starting, made 600 s ago, started by bb-box instance ..., last heard from 0 s ago"; a serving host's owner file has no start fields. F-7's reload case still passes |
| 6: the ledger | a busy stream at two thirds rises to full 10 s after it began waiting, a still one goes to two thirds, the person in control keeps theirs; a busy one at full keeps its place over still and busy streams. On main the still one kept its place |
| The suite | on a clone of the bundle on origin/main at 56a8b2c3: tsc clean; the node suite 2,201 passed, 0 failed, 288 skipped, the docs test among them; vitest 222 passed |

### The live check

Through production BB on 27 October 2026, after the lead deployed F-8 (PR
1190, main 552b0ce, device server version 26, helper version 4), on the
pool's Mac, an M5 Max, as both of the Tart Mac's VM slots were held by
other threads' boxes. Boxes were acquired with `shared: true`; the panels
were the owner's Helium, driven by playwriter.

| Item | Check | Result |
| --- | --- | --- |
| 3 | A slot box's device server stopped with SIGSTOP as its slot's user, then `bb box doctor` | "Version 26, protocol 2: it did not answer within 3 s, so the device's state now is not known. It last said the iPhone 18 Pro was booted, at 18:26:59 UTC." Before the stop: "the iPhone 18 Pro, booted." The doctor took 11 s |
| 2 | The device shut down twice within 5 minutes with `simctl`, so the driver left it failed ("stopped twice within 5 minutes"), then `box_device reboot` | "Rebooted the iPhone 18 Pro in 6.7 s. Now: booted". On main it was refused as not booted |
| 6 | Three slot boxes' panels in one tab, each with Pixel for pixel, all on the Home Screen | two at full size; the third, box honest-marsh, shown lower, as the doctor said |
| 6 | That third made busy, a page that repaints every frame, at 18:32:29 | between 18:32:46 and 18:32:57 it rose to full and a still one, box amber-brook, went lower, with the words under its toolbar. Counted over 10 s in the panels: the busy one 60.0 frames a second at 1206x2622, the still one at 804x1748, the other still one at 1206x2622 |
| 4 | The pool Mac's upkeep | it installed the server's build as bb-box's admin user, then `machine slot keep-app` was refused: the Mac's helper predates it, as the pool's Mac runs the helper `setup-mac.sh` installed. Slots there download the app until its slots are set up again |

### Faults the live check found, and their fixes

| Found | Fix |
| --- | --- |
| The doctor's fix for a silent device server in a pool Mac's slot named a host VM | in the follow-up commit: it names the Tart host's VM for a Tart slot, and the iOS slots check of its Mac for a pool Mac's slot |

### What limits these checks

- **Items 1 and 4 wait for the Tart Mac.** Both its VM slots were held by
  other threads' boxes from 17:50 to 22:00 UTC, so no shared Tart host
  could start for item 1, nor a dedicated ios box for item 4's enrolment
  measurement before and after, as F-7 measured. The lead runs them later.
  Item 4 on the pool's Mac waits for its slots to be set up again, as above.
- **Item 2's timed-out reboot was not seen live.** It needs a host whose
  cores are saturated, as unit 6's 8 busy slots on an 8-core host were; the
  pool's Mac has 18. It is checked on the fakes.
- **Item 5 was not seen live.** It needs two instances of one install and a
  start waiting for room.
- **Item 6's person in control** was not checked again live; unit 6 did.

## F-9: faults from H6, H8 and F-8, and hosts sized from each Mac

Built on 28 October 2026. The host's helper version 5; device server
version 26, unchanged. Items 1 to 5 were deployed as PR 1193; item 7 came
after, at the owner's request.

### H6: the iOS image changed while shared boxes were held

Run by the lead through production BB on 28 October 2026, on the Tart
Mac, an M4 Max, with one shared host a Mac (`tart-ios-hosts-per-mac` 1,
the default). Production moved to main f4fd561 during the run; the host
and its boxes live on the Mac and carried on through bb-box's restart.

| Step | What happened |
| --- | --- |
| 3 shared boxes on one host from the ios image of 27 October (build 20261027-064516) | slots 1 to 3 |
| The ios image rebuilt, from main 6dc0f1b | build 20261028-002015-21e2, its 42 checks passed |
| A dedicated ios box in the Mac's other VM slot, so no host can start; a 4th shared box | went to the old host, slot 4, in 5.2 s (choosing a shared host 4.9 s, ssh 0.3 s); BB enrolment 7.9 s. The doctor: "On build ..., older than the iOS image's, so it lends only while no host on the new build can start." |
| The dedicated box released; a 5th shared box | refused: "No shared iOS host can start on <mac>: <mac> runs a shared iOS host already, as many as it may (1)." The fault, below |
| The old host's 4 boxes released | the host deleted within a minute of its last release |
| A shared box | a new host on the new build, ready in 51.1 s (choosing 8.1 s, host 37.4 s, slot 4.7 s, ssh 1.0 s); BB enrolment 13.2 s |

- **The fault.** The old host refused its ready slot because a host on
  the new build could start, by a test that left the old host out of the
  Mac's count of hosts. A real start counts it. So with one host a Mac,
  no shared box could be had on that Mac until every box on the old host
  was released. Item 1 fixes it.
- **BB's app was not kept.** The new host's slots downloaded BB's app:
  `keep-app` refused every copy. Item 2 fixes it.

### What changed

| Item | Found | Fix |
| --- | --- | --- |
| 1, soft draining (H6) | A host on an older build asked whether a host on the new build could start with itself left out of its Mac's hosts | It asks as a start does: every host on the Mac against `per-mac`, and the Mac's VM room. It lends its ready slots until a host on the new build can start |
| 2, `keep-app` on Tart hosts (F-8 item 4) | As root, `cp -c` clones each file with its owner kept, and makes the folders and links root's. The check that the copy has one owner refused every copy: "README.md is not owned by UID 0" | The copy is checked for files of root and of the host user, the app's owner, and nothing else; then all of it, links too, is made root's. The checks against absolute links, links out of the app, files others can write and anything not a file or folder are unchanged, on the host user's app and on the copy |
| 3, refused while a host started (H8) | A failed host is not joined, and its start held a VM of the Mac's room until its VM was deleted, so boxes asked for meanwhile were told "Two macOS VMs already run" | A failed host's VM counts as leaving the Mac while it is deleted, and once it is stopped: a new host is offered there, and starts once the VM has gone |
| 4, no retry (H8) | A host whose VM did not start ("VZErrorDomain Code=1, Internal Virtualization error") failed its boxes at once | Its VM is deleted and the iOS image cloned again, once, while the host stays starting, so its boxes keep their promises and new ones join it. The log says so; the owner file keeps the first failure, which the doctor gives for a starting host; if the fresh clone fails too, the boxes' words give both. A start that waits for room is not retried: it waits, as before |
| 5, stills that stayed (H8) | A device panel whose first frame did not draw within 3 s showed stills for as long as the page lived, as for a browser that cannot decode at all | Stills chosen for a slow first frame say so, "The device's video did not show within 3 s, so this shows a picture a few times a second and tries the video again shortly.", and the panel asks for video again after 10 s, then after doubling waits up to a minute, until a frame draws; each new connection tries video first. A browser with no WebCodecs, or whose decoder refuses the stream, keeps its stills as before |
| 7, sizes from each Mac (the owner) | Hosts were 8 cores, 32 GiB and 8 slots on every Mac, and the pool's Mac 12 slots, whatever the Mac | See [below](#item-7-what-each-mac-gets) |

Item 5's cause is not proven. The panel could not be made to stay on
stills live by stopping a box, reloading its page and starting it again,
on a Mac with nothing else running: the video drew 1.3 s after the device
server answered. H8 had ten full-size panels in one tab and a VM starting,
and the reloaded panel's first frame came later than 3 s. Under such load
it may come late again; the fix makes that brief rather than permanent.

### How it was checked, before the live check

On a Linux box, from a clean clone of the bundle on origin/main at f4fd561:

| Check | Result |
| --- | --- |
| 1, on the fakes | one host a Mac: an old-build host lends its ready slot, and the doctor says why. Two a Mac: a new-build host is offered while the Mac has room, and the old host lends again once another macOS VM takes the room. On main the first refused |
| 2, on the fakes | `keep-app` keeps the app, makes the copy root's with a `chown -R -h`, and the link stays a link. The fakes cannot give a file two real owners, so the ownership itself was checked on macOS, below |
| 3, on the fakes | a host whose start failed, its VM held in deletion, a dedicated VM in the Mac's other slot: a new host is offered while the deletion runs. On main the Mac seemed full |
| 4, on the fakes | a VM that fails once starts on a fresh clone, a box joins the host meanwhile, the doctor and log give the first failure, and both boxes get slots on the one host; failing twice, the boxes' words give both failures and the host is deleted. On main the boxes failed |
| 5, in the app's tests | a first frame later than 3 s: stills with the new words; 10 s later video is asked for again, and a frame that decodes shows. On main the stills stayed |
| The suite | tsc clean; the node suite 2,208 passed, 0 failed, 288 skipped, the docs test among them; vitest 223 passed |

### Item 2, measured in a dedicated ios box

In a dedicated ios box at 8 cores and 32 GiB, from the ios image of 28
October (build 20261028-002015-21e2), as root.

- **The fault, seen.** The image's helper (version 4) refused, as on the
  Tart hosts: "README.md is not owned by UID 0". A copy made as root by
  `cp -RPc` had 434 folders and 5 links of root and 6,091 files of the
  image user.
- **The fix.** This branch's helper (version 5) kept the app in 1.73 s;
  the slots' home's copy was 435 folders, 6,092 files and 5 links, all
  root's. It still refused an absolute link, a link out of the app and a
  file others can write, each in the image user's app, and the check
  refused a copy with a third user's file: "is not owned by UID 0 or 501".
- **Enrolment,** as F-7 measured it: a fresh BB (`npx bb-app`, no
  account) in the box at 127.0.0.1:4999, machine access direct; each
  slot made by the helper and enrolled over SSH as its user under
  `BB_INSTALL_SKIP_SERVICE=1`, with `bb machine create --provider manual`'s
  command; times from each installer line's arrival.

| | Slot | `make` (user step) | The installer | Of it, BB's app |
| --- | --- | --- | --- | --- |
| Without | `bbd-1` | 24.3 s (2.6 s) | 5.01 s | downloaded and installed, 3.10 s |
| Without | `bbd-2` | 22.8 s (2.4 s) | 4.81 s | downloaded and installed, 2.76 s |
| With, `keep-app` 2.12 s | `bbd-3` | 23.8 s (2.6 s) | 2.24 s | "The identical server host artifact is already installed", 0.05 s |
| With | `bbd-4` | 24.1 s (2.7 s) | 2.31 s | the same, 0.05 s |

The kept app saves 2.5 to 2.8 s of each slot's installer, as F-7's image
copy did, and the user step is no longer.

### The live check

Through production BB on 28 October 2026, on the Tart Mac, the Mac's
other VM slot free unless said, shared boxes pinned to Tart with `on`.

Before the deploy, on main f4fd561:

- **Item 3 and 4's fault, again.** Four shared boxes asked for at once
  were promised to one starting host. Its VM failed, "VZErrorDomain
  Code=1 ... The virtual machine failed to start.", and the four boxes
  failed 66 s after they were asked for. A fifth box, asked for about 15 s
  after them, found the host failed already and started a second host,
  which served it 78.1 s after it was asked for. H8's three refusals came
  in that window, with the Mac's other slot held by a dedicated box.

After the lead deployed F-9 (PR 1193, main 7671c24, helper version 5):

| Item | Check | Result |
| --- | --- | --- |
| 2 | A host's start, then the doctor | "Its slots get BB's app build 634c1bfd81d4 from the host." The two carried slots, claimed as the host started, enrolled in 18.1 and 8.5 s; three slots made after `keep-app` had run, in 4.9, 3.7 and 3.8 s |
| 6 | One box's acquire made to fail after its promise was taken: from a slot box, the host's disk filled to 8.5 GiB free, so it made no slot ahead; the last ready slot taken; the disk let up to 10.5 GiB and a writer started that took it back under the host's 10 GiB reserve within seconds; then a shared box asked for | the offer found room, the box was promised, and the helper refused to make its slot. The acquire failed 5 min 20 s later: "The shared iOS host ... gave box ... no slot within 5 minutes." The disk freed, the host made a ready slot again; at the end every box was released and the host was gone 12 s after the last release returned, which a promise left behind would have stopped |
| 5 | A slot box's panel in the owner's browser, with its decoder's output held back for the page's first 6 s, as a busy decoder would | the first frame decoded at 3.0 s, held; stills asked for at 6.0 s, with the new words under the toolbar; video asked for again at 16.0 s, and its first frame drawn 10 ms later; the words gone |
| 1 | A host of 3 boxes on the current build, the ios image rebuilt by the lead from main 7671c24 (build 20261028-015327-ddc2), the build VM gone, so the Mac's other VM slot free; then a shared box | the doctor: "On build build.20261028-002015-21e2, older than the iOS image's, so it lends only while no host on the new build can start." The box took the old host's ready slot, slot 5, in 5.2 s (choosing a shared host 4.8 s, ssh 0.4 s). In H6 it was refused |
| 1 | The old host's boxes released, then four shared boxes, three at once and one 10 s later | the old host deleted at its last release; a new host on the new build, the four promised to it while it started, ready in 25.2 to 112.8 s |

### Item 7: what each Mac gets

A shared host's sizes now come from its Mac, size by size: a Mac's own
value first, then the backend's setting where set, then bb-box's
estimate.

- **The estimate.** Cores: a Tart Mac's performance cores
  (`hw.perflevel0.physicalcpu`); a pool Mac's slots share all its cores.
  Slots: the fewest of the cores over 1.3, a busy simulator measured in
  unit 6; the memory over 1.5 GiB a device after 8 GiB for the host; and
  what the Mac's video encoder allows, each slot counted as a stream at a
  half, 0.33 of a full frame, at 60 frames a second, within the ledger's
  three quarters of the budget: 12 for an M4 Max, 14 for an M5 Max.
  Memory for a Tart host: 8 GiB and 1.5 GiB a slot, within the Mac's
  memory less its reserve, shared by `per-mac` hosts.
- **Overrides.** `tart-ios-hosts-most`, `-cores` and `-memory-gib` count
  only where set, so they have no default now; each Tart Mac has the same
  three fields of its own. The pool's `ssh-pool-ios-hosts-most` counts
  only where set, and `ios:<slots>` on a Mac's line, as in `macos,ios:10`,
  wins for that Mac.
- **The doctor** gives each Mac's sizes and where each came from, as "A
  new host here has 9 slots (estimated: 9 for 12 cores at 1.3 a busy
  device, 69 for the 112 GiB of <mac>'s memory a host may have, ..., 12
  for the video encoder (an Apple M4 Max, ...); the fewest), 12 cores
  (estimated: <mac>'s performance cores), 22 GiB (estimated: 8 GiB for the
  host and 1.5 GiB for each of its 9 slots)".

| Mac | Cores, memory | A shared host or the Mac lends | Bound by | Before |
| --- | --- | --- | --- | --- |
| The Tart Mac, an M4 Max | 16 (12 performance), 128 GiB, 16 GiB kept free | hosts of 12 cores and 22 GiB, 9 slots each | the cores: the memory allows 69, the encoder 12 | 8 cores, 32 GiB, 8 slots |
| The pool's Mac, an M5 Max | 18, 36 GiB | 13 slots | the cores: the memory allows 18, the encoder 14 | 12 slots |

Neither Mac sets any of these sizes in production now, so both take the
estimate once item 7 is deployed. On the fakes and in the suite, on a clean
clone of item 7 on main 7671c24: tsc clean; the node suite 2,212 passed, 0
failed, 288 skipped; vitest 223 passed. Item 7 is not checked live yet.

### What limits these checks

- **Items 3 and 4 were not provoked after the deploy.** The VM failure
  came twice before it, each time on the first host started that session,
  and not on the two host starts after it. They are
  checked on the fakes, with a fake Tart that fails a start and holds a
  deletion.
- **Item 5's cause is not proven,** as above; the live check held the
  decoder's output back in the page rather than load the Mac.
- **Item 6 was provoked by a full disk,** which fails a slot's making; a
  slot box cannot make another slot's SSH fail. The path that gives back a
  claimed slot, not a promise, is checked on the fakes only.

### Deviations from the brief

- **Item 2 checks before it changes owners.** The brief said to make the
  copy root's before the check. The check now allows root and the host
  user, and refuses any other owner, then the copy is made root's: a check
  after a `chown` could not see an owner that should not be there.
- **Item 4 retries any failure of the VM's start,** a clone, the start, its
  address or SSH, not only Virtualization's error; not a start that waits
  for room.


## 065 A: each Mac says what it offers iOS devices

Built on 28 October 2026, as decided in
[065](065-macs-say-what-they-offer-and-ios-streams-in-software-where-they-must.md);
deployed as PR 1196, main 5bac6d0.

### What it adds

- **A probe on each Mac** measures whether it can run the iOS Simulator
  (Xcode, and its available iOS runtimes) and which H.264 encoders it has:
  a hardware one, by a VideoToolbox session that requires hardware and
  encodes 12 full-size frames, built once a Mac from Swift and kept by its
  hash; a software one, as `bb-box-h264 --version` names it. It runs no
  `xcrun` on a Mac without developer tools.
- **Where it measures:** the pool on each Mac at its survey and daily; Tart
  on each Mac, with the iOS Simulator and the software encoder taken from
  the iOS image's record; Namespace on each Mac it starts and in the
  doctor, kept per chip, as its Macs come and go. Each report is kept in
  the backend's storage.
- **Shown:** box_list's `ios`, `macos` and `macos-desktop` offers say what
  their Macs offer, without naming one; the doctor's `devices.<mac>`, iOS
  devices on the Mac, says what, where and when it was measured.
- **Used:** a Mac measured unable to run the Simulator or stream lends no
  ios slot, in words; one the probe cannot tell about lends as before, and
  the doctor warns. The ledger learns whether each Mac has a hardware
  encoder.

### Checks

On a Linux box, from the commit on origin/main at 73903b1: tsc clean; the
node suite 2,223 passed, 0 failed, 288 skipped, the docs and reference
tests among them; vitest 224 passed.

### The production check

Through production BB on 28 October 2026, after the lead deployed PR 1196:

| Provider | The doctor's check |
| --- | --- |
| Tart | "iOS devices on <mac>: The iOS Simulator (Xcode 27.0, iOS 27.0); video by its hardware H.264 encoder. Measured on the Mac, an Apple M4 Max, just now." |
| The pool | the same for its Mac, an Apple M5 Max |
| Namespace | another thread's `macos` box, started a minute before: "iOS devices on Namespace's Apple M4 Pro (Virtual) Macs: The iOS Simulator (Xcode 26.1.1, iOS 17.5, iOS 18.6, iOS 26.0, iOS 26.1, iOS 26.2); video by its hardware H.264 encoder." |

box_list's offers of `macos`, `macos-desktop` and `ios` on all three end
with "its Mac: iOS devices, video by its hardware H.264 encoder".

- **Namespace's Macs have an encoder now.** M18's Mac, an M4 Pro VM, could
  not make a hardware session (-12903). Today an M4 Pro VM and an M5 Max VM
  both did; on the M5 Max one session gave 141 full-size frames a second,
  and idb streamed two busy devices at 54 to 57 frames a second. Namespace
  may still give a Mac without one, which the report would show.
- **My own Namespace Mac could not be taken** for the check: the
  workspace's one Mac was another thread's box.

## 065 B: a software encoder for iOS streams

Built on 28 October 2026, as decided in
[065](065-macs-say-what-they-offer-and-ios-streams-in-software-where-they-must.md).
Device server version 27.

### What it adds

- **`bb-box-h264 --simulator <udid>`** reads a booted device's screen
  itself, as CoreSimulator gives it: a shared BGRA IOSurface, polled up to
  60 times a second by its seed, scaled to the step by vImage, converted to
  I420 and encoded, in one process, with no idb stream. `Z` on its input
  changes the step; `K` asks for a key frame. It finds SimulatorKit where
  Xcode 26 and Xcode 27 each keep it. `build-h264.sh` builds it on macOS on
  arm64, as on Linux: OpenH264 from Cisco's binary, pinned, or x264 from
  its pinned source when the operator asks for it. bb-box ships no x264
  binary. Its input also takes I420 and BGRA frames with a row stride.
- **The device server** streams a device by idb's H.264, from the Mac's
  hardware encoder, unless its choices say `software`, or idb's stream
  fails with a VideoToolbox error, when it changes to `bb-box-h264` for the
  life of the server and logs why. Its video report to the lease holder
  says how it encodes and, in software, the cores encoding took over the
  last 10 s, from each frame's encode time.
- **The setting `iosEncoder`,** general and advanced: `auto`, the default,
  `hardware` or `software`. bb-box delivers it with each ios box's device
  server, and `software` where its Mac was measured to have no hardware
  encoder.
- **The ledger** counts a stream in software against its Mac's CPU, not its
  encoder: a quarter of the Mac's cores, priced by step from the
  measurements below, with passive viewers lowered first, as for the
  encoder, and words that say the CPU is busy. Slot sizing (F-9 item 7)
  counts a software Mac's slots by the cores a stream at a half takes.
- **The iOS image** builds `bb-box-h264` (`prepare-ios-image.sh
  --with-x264` for x264), checks it streams each device's framebuffer, and
  records the VM's encoders, which Tart takes for what each Mac offers.
  The pool's `mac-ios.sh` builds it too.

### How it was measured

On a Namespace Mac (macOS 26.3.1, an Apple M5 Max VM, 6 cores, Xcode
26.1.1, an iPhone 17 Pro on iOS 26.2) and in a dedicated ios box on the
Tart Mac (an M4 Max VM, 6 cores, macOS 27.0, an iPhone 18 Pro), with
[software.ts](../../scripts/measure/ios/software.ts): a busy page that
changes every frame, frames counted as they leave the encoder. The raw
numbers are in [065's measurements](065-macs-say-what-they-offer/measurements.txt).

| Path | Step | Frames a second | Cores | Note |
| --- | --- | --- | --- | --- |
| idb's raw stream, through Node, x264 | a third | 57.2 | 0.61 | taps shown in 62 ms |
| | a half | 58.1 | 1.39 | 75 ms |
| | two thirds | 35.5 | 1.46 | 167 ms |
| | full | 15.9 | 1.40 | 349 ms |
| The framebuffer, two devices, Namespace | a third | 45.8, 46.0 | 0.10 each | |
| | a half | 46.4, 46.3 | 0.17 each | |
| | two thirds | 47.2, 47.2 | 0.27 each | |
| | full | 50.7, 50.5 | 0.45 each | |
| The framebuffer, one device, Tart | a third to full | 43.0 to 45.6 | 0.14 to 0.37 | first frame in 82 to 101 ms |

idb's raw stream tops out near 200 MB a second, whatever the HTTP/2
window or frame size, so it was not used.

### Through BB's panel, on a Tart box with hardware not used

A fresh BB, `npx bb-app` 0.47.1 with no account, ran in the dedicated ios
box, with bb-box from this branch, `iosEncoder` set to `software`, and an
SSH host pool whose one Mac was the box itself, set up by `setup-mac.sh`
and `mac-ios.sh`. An ios box asked for with no options took a slot in
1.2 s; bb-box delivered version 27 to it, with `"iosEncoder":"software"`,
and it said hello in 0.7 s. Headless Chromium, in the same VM, opened the
box's page in the fresh BB, took control, and clicked the busy page,
which turns black or white at each touch; frames were counted by wrapping
the canvas's `drawImage`, and each click timed to the first drawn frame
whose pixel had flipped. 20 s and 15 clicks a step:

| Step | Panel | Frame | Frames a second | Worst gap | Click to shown: median, p95 | The encoder's cores | The VM idle |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A third | 600x700 at 1x | 402x872 | 44.6 | 88 ms | 64, 89 ms | 0.11 | 69% |
| A half | 900x900 at 2x | 602x1310 | 44.7 | 94 ms | 66, 78 ms | 0.17 | 62% |
| Two thirds | 900x1150 at 2x | 804x1748 | 46.4 | 114 ms | 68, 82 ms | 0.27 | 54% |
| Full | 1100x1600 at 2x | 1206x2622 | 51.0 | 249 ms | 116, 355 ms | 0.64 | 24% |

An earlier full-size run gave 48.7 frames a second, clicks in 73 and 88 ms
and 0.43 cores. At full size the browser, decoding and drawing in the same
6-core VM, left a quarter of it idle, so that row is the browser's as much
as the encoder's. Every click landed and showed.

- **The ledger counted it as CPU.** The doctor: "Video encoder on mac-1:
  ... On this Mac: video encoded in software, about 0.2 of the 1.5 cores it
  may use. 1 stream in software."
- **A turn of the device** from the panel's toolbar drew it turned and
  back; frames stay the framebuffer's upright size, as idb's do.
- **Phase A on the same BB:** "iOS devices on mac-1: The iOS Simulator
  (Xcode 27.0, iOS 27.0); video by its hardware H.264 encoder, software
  (x264 0.165) as the fallback. Measured on the Mac, an Apple M4 Max
  (Virtual)."

### Through BB's panel, on a Namespace Mac

The same, on a Namespace Mac taken on 28 October 2026: macOS 26.3.1, an
Apple M4 Pro VM (M18's chip), 6 cores and 14 GiB, Xcode 26.1.1 and iOS 26.2
(23C54). Namespace's own agent holds port 22 and Remote Login is off, so the
pool's sshd for this check listened on 127.0.0.1:2222. Its slots were set up
with unit 7's `mac-ios.sh` (the next commit): an iPhone 17, as this Xcode
has no iPhone 18 Pro, slimmed by a list for iOS 26.2, whose seed had every
one of its 112 labels off. `bb-box-h264` was built with OpenH264.

| Step | Frame | Frames a second | Worst gap | Click to shown: median, p95 | The encoder's cores | The Mac idle |
| --- | --- | --- | --- | --- | --- | --- |
| A third | 402x872 | 45.3 | 117 ms | 78, 94 ms | 0.10 | 23% |
| A half | 602x1310 | 46.5 | 135 ms | 85, 135 ms | 0.21 | 26% |
| Two thirds | 804x1748 | 48.1 | 120 ms | 93, 105 ms | 0.34 | 22% |
| Full | 1206x2622 | 46.9 | 127 ms | 103, 121 ms | 0.69 | 13% |

The first run at a third came while the panel warmed up, at 37.6 frames a
second with one of 15 clicks not shown; the row is a second run. The
browser, BB and the device shared the Mac's 6 cores. The doctor: "iOS
devices on mac-1: The iOS Simulator (Xcode 26.1.1, iOS 17.5, iOS 18.6, iOS
26.0, iOS 26.1, iOS 26.2); video by its hardware H.264 encoder, software
(openh264 2.6.0) as the fallback. Measured on the Mac, an Apple M4 Pro
(Virtual)", and the ledger "On this Mac: video encoded in software, about
0.1 of the 1.5 cores it may use. 1 stream in software." idb's hardware
stream on this Mac, which M18 found failing, gave a busy device 52.5 frames
a second at a half and 58.5 at full.

### Checks

On a Linux box, from the branch on origin/main at 5bac6d0: tsc clean; the
node suite 2,229 passed, 1 failed, 288 skipped; vitest 224 passed. The
failure was an expectation this change moved, of a Tart encoder place's
fields; with it fixed, and the probe's runtime and device types added
after, tsc is clean and the six files they touch pass, 64 of 64.

### What limits these checks

- **On Namespace, through a pool, not a Namespace host.** A Namespace host
  is unit 7's, which needs its deployment to check.
- **The setup broke Homebrew's `node@24`** in the test box: `setup-mac.sh`
  upgraded Homebrew's libraries, and the image's `node@24` lost one until
  reinstalled. A test box's matter, not a pool Mac's, whose Node is
  Homebrew's own.
- **Mixed Macs:** a Tart slot's encoder place has no cores of its own, so
  the ledger takes 8 for it, under a host's 12.

### Deviations from 065

- **The software budget is a quarter of the cores of the Mac or VM the
  stream's encoder runs in,** where bb-box knows them: the pool's Mac's,
  a dedicated box's VM's; 8 otherwise.
- **The image measures its hardware encoder with ffmpeg,** as the macOS
  image has it, rather than the probe's Swift check.

## 065 C: Namespace hosts (064 unit 7)

Built on 28 October 2026, as decided in
[065](065-macs-say-what-they-offer-and-ios-streams-in-software-where-they-must.md).

### What it adds

- **`SlotLender` on the Namespace backend**
  ([`ios-hosts.ts`](../../src/backends/namespace/ios-hosts.ts)). Namespace
  offers `ios` as slots once it has measured a Mac that runs the iOS
  Simulator, whose newest iOS runtime has a slimming list in bb-box. The
  setting `ios-hosts-on`, on by default, turns it off. Its tier is the last
  of 064's order, `new-host` at a Namespace Mac's cost.
- **A host is a Namespace Mac made for an ios box,** at the largest shape
  the workspace allows, labelled `bbbox-role=device-host`. Its record, with
  the boxes promised while it starts, is in the backend's storage, as a
  Namespace Mac has no owner file to keep it on. Its start: the Mac ready,
  the tailnet joined, the Mac measured, then bb-box's setup unpacked and
  `mac-ios.sh` run as root with the host's settings: idb_companion from
  its pin, the slots' helper, the slimming list and its seed, and
  `bb-box-h264`. Boxes asked for while it starts join it. It is deleted at
  its last release, and lends no new slot in the hour before the plan's
  longest life; each box on it says it ends when the host does.
- **`mac-ios.sh`** keeps only the models the Mac's Xcode can make, so a
  Mac with Xcode 26 lends the iPhone 17, and sets up a host deleted after
  its last box when given its settings.
- **A list for iOS 26.2 (23C54),** the newest runtime of Namespace's Macs:
  the iOS 27.0 list's 112 labels, which M18 found all off on iOS 26.2, and
  which the seed's check found all off again.
- **A slot's commands run as its user through the Mac's own SSH and
  `sudo`** ([`slot-user.ts`](../../src/transports/slot-user.ts)), as
  Namespace's agent holds port 22 and Remote Login is off.
- **The probe** also reports the newest iOS runtime and the device types
  Xcode has, which the Namespace offer is made from.
- **The doctor's `ios-hosts.namespace`:** the host's slots, its end and how
  its video is encoded, or why none can start. The Namespace guide says a
  host takes the workspace's one Mac, and `macos` boxes refused for it say
  so.

### Deviations from 064 and 065

- **Not off by a hand switch, on by what was measured,** as 065 decided;
  `ios-hosts-on` stays for an operator to turn it off.
- **No `ssh <box name>` and no terminal** for a box on a Namespace host:
  Namespace's Macs have no SSH server for other users. Commands, files,
  BB's enrolment and the device server all go through the Mac's own user.
- **Streams by hardware where the Mac has an encoder.** Of Namespace's
  Macs measured on 28 October 2026, an M5 Max VM and two of three M4 Pro
  VMs had one; the third M4 Pro VM had none (-12903). Each host measures
  its own Mac, and streams in software, by B's encoder, where it has none,
  or for every stream with `iosEncoder` set to `software`.
- **No BB app kept for the slots,** as the Tart and pool hosts keep it:
  each slot downloads BB's app as it enrols, about 3 s more.
- **A host's size is the workspace's largest Mac,** 6 cores and 14 GiB
  here, and its slots the sizing estimate for it, 4.

### Checks, before the production check

On a Linux box, from the branch on origin/main at de8fdef: tsc clean; the
node suite 2,239 passed, 0 failed, 288 skipped, the docs and reference
tests among them; vitest 224 passed. The lender is tested against a stub
host that answers as the slot helper does: two boxes, one starting the
host and one joining it, each a slot, the last release deleting the
Mac; no new slot in the last hour; a Mac that cannot run the Simulator
failing its host with words and the upkeep clearing it; no host while the
workspace's Mac is taken. `mac-ios.sh`'s new parts ran for real on a
Namespace Mac in B's check above.

### The production check

On production BB at main 09102e6, on 28 October 2026, with `iosEncoder`
left at `auto`.

- **Namespace did not offer `ios` at first.** Its saved report came from
  A's probe, which did not ask for the newest iOS runtime. A `macos` box
  on Namespace, started and released, measured a Mac again: an M4 Pro VM
  with no hardware encoder. Namespace then offered `ios`.
- **Two `ios` boxes asked for with `on: "Namespace"`:** both ready 271 and
  274 s after the ask: the host 178 s, then each slot 90 to 94 s. Each was
  an iPhone 17 on iOS 26.2 (23C54), with Xcode 26.1.1. The host's Mac, a
  6-core 14 GiB M4 Pro VM, had a hardware encoder, so both streamed by it.
  `box_status` said each ends at the host's end; the doctor said 2 held, 1
  making, video by the Mac's hardware encoder.
- **BB's enrolment failed on both:** BB's installer could not start its
  daemon: `nohup: can't detach from console`. The fix is below.
- **Both panels, in one browser tab,** each 420x900, for 25 s with 10 taps
  each, at half size (604x1312), a busy page on each device:

  | Run | Frame rate (fps) | Tap to change, median (ms) | p95 (ms) | Longest gap (ms) |
  | --- | --- | --- | --- | --- |
  | 1 | 51.8 and 46.8 | 213 and 213 | 1,988 and 262 | 608 and 476 |
  | 2 | 51.7 and 53.6 | 214 and 205 | 2,010 and 718 | 4,982 and 3,665 |

  In run 2, 9 of the second box's 10 taps showed.
- **The host's CPU,** by `top` in a slot: 5 to 9% idle of its 6 cores in
  run 1, 21% later. The busiest were each device's Safari, about 66%,
  `appprotectiond`, about 63%, and `cfprefsd`, about 48%, while the slot
  kept ready was still being made. The slow taps are a full 6-core Mac,
  not the stream.
- **Released at once:** the host was deleted 10 s after the last release.

### After the production check

- **A slot's commands run in its user's launchd session**
  ([`slot-user.ts`](../../src/transports/slot-user.ts)): `sudo launchctl
  asuser <uid>` before `sudo -u`. On a Namespace Mac, `nohup` exits 127
  both as the Mac's own user and as a slot's user under `sudo`, and 0 under
  `launchctl asuser`, so BB's installer, which starts a slot's daemon with
  `nohup`, works.
- **A report says which probe made it.** One from an older probe is stale,
  so a pool Mac or a Tart host is measured again. For Namespace, which
  has no Mac to measure until one starts, bb-box measures a Mac it has, or
  starts one for a few minutes, with a 20-minute deadline, at most once a
  day, while shared iOS hosts are on, and only when the report cannot make
  an offer, so no `ios` box can be waiting for that Mac. The whole measure
  ends 5 minutes inside the deadline, and its steps are logged.
- **Namespace's Macs can vary by machine.** Namespace counts, for each
  kind of Mac, the machines that had a hardware encoder and those that did
  not. Where they differ, within a kind or between kinds, `box_list` and
  the doctor say its Macs vary by machine, and what each kind had. As each
  host builds `bb-box-h264` as it starts, a Mac without a hardware encoder
  streams in software there, and is no longer shown as offering no
  device.
- **`box_list` says how Namespace lends `ios`:** slots on a Mac made for
  the first box, in about 5 minutes, and deleted after its last.

### The second production check

On production BB at main 3c33b9a, with the fixes above, on 28 October 2026.

- **The workspace's Mac was taken for 20 minutes** from the moment hosts
  came on, by the first re-measure Mac: the report kept came from the
  older probe, so it started one, though that report could still make an
  offer. Nothing was logged, and two `ios` boxes asked for then were
  refused. The Mac ended at its deadline. bb-box now measures afresh only
  when the report cannot make an offer, bounds the measure inside the
  deadline, and logs each step.
- **Two `ios` boxes, asked for together, joined one new host:** ready
  263 s after the ask, the host 196 s, each slot 66 to 67 s. The host's
  Mac, an M4 Pro VM, had no hardware encoder, so its devices streamed in
  software, by OpenH264.
- **The first box enrolled in BB in 13.3 s,** so a slot's commands in its
  user's launchd session fixed the earlier failure.
- **The second failed:** its daemon exited with `Host daemon local API
  port 38888 is already in use`. BB's installer gives a daemon the first
  free port from 38888, and both slots' installers ran in the same second.
  The same could happen on a pool Mac or a Tart host.
- **One stream through the panel,** in a browser, 420x900, a busy page on
  the device, 25 s, 10 taps: 29.2 fps at half size (602x1310), taps
  median 209 ms, p95 1,095 ms, 7 of 10 shown, longest gap 527 ms. The
  encoder took about a quarter of a core, on a Mac 9% idle: each device's
  Safari, `appprotectiond` and `cfprefsd` took most of it.
- **Released at once;** the host was gone within 20 s.

### After the second production check

- **Each slot's BB daemon has its own port,** 38900 and up, by the slot's
  place on its host, on every lender: bb-box writes it to BB's
  `host-daemon-port` before BB's installer runs, as the installer keeps a
  stored port that is free and takes no port from the environment. The
  host's helper starts the slot's daemon on the same port.
- **The log says when a box that found no slot can have no VM of its
  own** where it was asked, as with `on: "Namespace"`, rather than that it
  gets one.


## F-9b: a shared host's failed start, seen live

Run on 28 October 2026 through production BB on main cb5e915, on the Tart
Mac, an M4 Max. Another thread's macOS box held the Mac's other VM slot
throughout, so a host had one slot. To make a start fail, the lead ran a
watcher on the Mac that stopped the first new host VM once, with
`tart stop <vm> --timeout 0`. Each box was a shared ios box pinned to
Tart, asked for without waiting. Times are UTC, from the Mac, bb-box's log
and the doctor.

### Run 1: the VM stopped 5 s after Tart listed it running

| Time | What happened |
| --- | --- |
| 07:37:49 | A box asked for |
| 07:38:00 | Host 1 starting |
| 07:38:37 | Its VM running, after a 37 s clone |
| 07:38:42 | Its VM stopped. bb-box had reached it over SSH already: the failure below came while it installed or started its helper, after the part the retry covered |
| About 07:39:00 | Two more boxes asked for |
| About 07:39:02 | Host 1 failed, its VM being deleted |
| 07:39:12 | Host 2 starting, for the two later boxes: not refused, though host 1's VM was not yet gone (item 3) |
| 07:39:20 | Host 1's VM deleted |
| 07:39:25 | The first box failed: "The shared iOS host ... did not start: The box at 192.168.64.4 did not answer on SSH." No fresh clone |
| 07:39:59 | Host 2 serving, 46.3 s after its start; the two boxes ready 65.2 and 64.8 s after they were asked for |

### Run 2: the VM stopped as soon as Tart listed it running

| Time | What happened |
| --- | --- |
| 07:42:51 | A box asked for |
| 07:43:05 | The host starting |
| 07:43:34 | Its first start failed by itself, before the watcher saw it: "VZErrorDomain Code=1 ... Internal Virtualization error", as in H8. The log: "did not start, so bb-box deletes its VM and starts a fresh clone of the iOS image, once" (item 4) |
| 07:43:45 | The doctor: "starting, made 49 s ago, on a fresh clone as its first start failed (Tart could not start ...)" |
| 07:43:50 to 07:44:05 | Two more boxes asked for; both joined the starting host, 3 boxes promised (item 4) |
| 07:44:27 | The fresh clone running, and stopped at once |
| 07:44:27 to 07:54:22 | Nothing noticed. The doctor still said "starting", its beat kept fresh |
| 07:54:22 | All three boxes failed, with both causes: "got no address within 576 s: ... no IP address found, is your VM running? That was a fresh clone's start; the first clone's failed too: Tart could not start ... VZErrorDomain Code=1 ..." |
| 07:54:58 | The doctor: no shared iOS host runs, the Mac runs 1 of 2 VMs |

### What the runs show

- **Item 3 works.** A failed host's VM leaves the Mac's room while it is
  deleted: run 1's later boxes got a new host 8 s before the old VM was
  gone, and were not told "Two macOS VMs already run".
- **Item 4 works where it reaches.** A real Virtualization failure got a
  fresh clone, boxes joined it while it started, and the doctor and the
  boxes' words gave the first failure.
- **Fault A: the retry ended at SSH.** A VM that stopped after it
  answered on SSH, while bb-box installed and started its helper, failed
  its boxes with no fresh clone, in words that did not say the VM stopped.
- **Fault B: a stopped VM was waited for.** A VM that stopped before it
  answered on SSH was noticed only at the start's 10-minute deadline, 9
  min 55 s after the stop. Its boxes waited that long.

### What changed

| Fault | Fix |
| --- | --- |
| A | The fresh clone is tried for any failure before the host serves: the VM's start, its address and SSH, and now the helper's install and init too. Where the VM no longer runs after such a failure, the words say "Its VM stopped after it answered on SSH, before it served: ..." |
| B | While a host's VM waits for its address and SSH, bb-box asks Tart every 3 s whether it still runs. A VM listed stopped, or gone, fails that attempt at once: "<vm> on <mac> stopped before it answered on SSH: Tart lists it stopped." The log says so when it is seen, with the time since the VM started. A `tart list` that fails is not taken as gone |

On the fakes, both failed on main and pass with the fix: a helper init
whose connection closes while the fake VM is stopped gets a fresh clone,
a box joins it, and the doctor and log give the words; a fake `tart ip`
held while the VM is stopped is noticed within a poll, and the fresh
clone serves.
On a Linux box, from a clean clone of the bundle on main cb5e915: tsc
clean; the node suite 2,247 passed, 0 failed, 288 skipped, the docs test
among them; vitest 224 passed.

### After the deploy

The lead deployed the two fixes as PR 1201, main e19adcc, and ran the
watcher three more times. From rerun 2, it spared a host's fresh clone, so
a retry could serve.

| Rerun | The stop | What happened |
| --- | --- | --- |
| 1 | 5 s after the VM ran | The first start failed by itself with Virtualization's error at 08:09:35, and the two later boxes joined the starting host. The fresh clone ran at 08:10:30 and was stopped at 08:10:35. The log at 08:10:43: "... stopped before it answered on SSH: Tart lists it stopped. bb-box saw it 16.7 s after the VM started, and stops waiting for it." All three boxes failed at 08:11:07 with both causes, 2 min 10 s after the first was asked for; in run 2 this took 11 min 31 s (fix B) |
| 2 | As soon as the VM ran | The first start failed by itself again, the watcher spared the fresh clone, and it served. The three boxes were ready in 168.6 s, and 49.4 and 72.3 s for the two that joined (item 4) |
| 3 | 2 s after the VM's SSH port opened | The first start ran, and was stopped at 08:29:41. At 08:30:21 the log: "did not start, so bb-box deletes its VM and starts a fresh clone of the iOS image, once: Its VM stopped after it answered on SSH, before it served: The box at 192.168.64.7 did not answer on SSH." The fresh clone served at 08:31:10, for 3 boxes, ready in 192.0, 85.1 and 65.9 s (fix A) |

Every host's VM was gone after its boxes were released, by the doctor
and on the Mac.

### Why first starts failed

A new host's first start failed by itself with "VZErrorDomain Code=1 ...
Internal Virtualization error" in 3 of the 7 hosts started today, and in
none of the fresh clones.

- **The disk was locked.** Virtualization's log at a failure: "Cannot
  acquire exclusive lock, errno 35" on the new VM's disk image, then the
  disk device failed to start.
- **By Tart's own listing.** Watched with `lsof` on the Mac, a `diskutil`
  and `diskimagescontroller` opened a new host's disk image a second before
  its `tart run`, and every half minute after. Tart 2.40.1's `tart list`
  sizes every ASIF disk image with `diskutil image info`, even with
  `--quiet`, and so does `tart get`. bb-box lists VMs often: its reads of
  the Mac's state, and the start script's own check just before `tart
  run`. A run that starts while a listing has its disk open fails.
- **Not only hosts.** bb-box's log has the same error since 26 October on
  dedicated boxes as they were acquired, on warm VMs as they resumed, and
  on a resize and restarts.
- **Fix C.** The start script, which starts and resumes every Tart macOS
  and Linux VM, runs `tart run` once more, 3 s later, when it fails at
  once with that error. The log says so: "Tart's run of <vm> on <mac>
  failed at once, as when a tart list reads its disk at that moment, so
  bb-box ran it again 3 s later: ...". On the fakes, a macOS box whose
  first run fails so starts on the second; failing twice, its acquire
  fails with the error. On a clean clone of the bundle on main e19adcc:
  tsc clean; the node suite 2,248 passed, 0 failed, 288 skipped, the docs
  test among them; vitest 224 passed.

After the lead deployed fix C (PR 1202, main c0369a1), with every
watcher on the Mac closed, three shared boxes were asked for minutes
apart, each on a new host. Each first start ran: no run was needed twice,
and the log had no Virtualization error.

| Asked for | Host | Serving after its start | The box ready |
| --- | --- | --- | --- |
| 09:00:00 | bb-box-host-43f748007a | 27.5 s (its VM 25.7 s) | 38.8 s |
| 09:05:01 | bb-box-host-1abdd1bff7 | 29.5 s (its VM 26.6 s) | 40.4 s |
| 09:13:01 | bb-box-host-a557569170 | 29.6 s (its VM 26.9 s) | 41.6 s |

The race did not come up without the watchers, whose `tart list` every
0.3 s raised its odds: fix C is a safety net, seen on the fakes only.
bb-box's own listings around a start are still there, to be removed in
F-10.

### What limits these checks

- **The stops were forced** with `tart stop --timeout 0`. Virtualization's
  own failure came by itself, in run 2 and reruns 1 and 2.
- **The lock's holder at a failing start was not caught.** The cause rests
  on Virtualization's log, the holders seen at a start that worked, and
  Tart's source.
- **Namespace was not provoked.** Its hosts have no retry on a fresh
  instance and no limit of two VMs, so items 3 and 4 are Tart's only.
  Making a Namespace start fail needs its API, which this check did not
  use.
