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
