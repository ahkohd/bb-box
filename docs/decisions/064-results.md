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

Not run yet. It needs the Mac free of whole-Mac boxes, and the lead to run
the setup on it and deploy this unit. The pool's Mac was lent whole to
another thread's box throughout.

### What limits these checks

- **A Tart VM stood in for the pool's Mac.** It has the same macOS,
  Xcode and runtime, but not the pool's console user, Full Disk Access
  for remote users, or its encoder. A whole box's release and reset could
  not run there, as a person was signed in at its console. So the gentle
  stop of a whole box user is checked only on the fakes.
- **H1 and H11 wait for the pool's Mac.**

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
