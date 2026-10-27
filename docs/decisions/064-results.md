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
