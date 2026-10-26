# iOS Simulator boxes

How bb-box could give a thread an iOS Simulator as a box: its screen
streamed into BB's panel inside a device frame, device controls beside it,
control shared between a person and the agent, and computer use on the
device.

Research, 26 October 2026: a note of what was known and measured then, not
the current design, which is in [the architecture](../architecture.md).
Not settled by a decision yet.

Status: prototypes run and measured on a Tart macOS VM and on a pool Mac.
A Namespace Mac was not tried: its only Mac slot was in use all session.
Checked with Xcode 27.0 (27A266a) and iOS 27.0 (24A434), on macOS 27.0
in a Tart box and macOS 27.0.1 on a physical Mac.

## What changed in Xcode 27

Xcode 27 has no Simulator.app. Its place is taken by **Device Hub**
(`com.apple.dt.Devices`, in `Xcode.app/Contents/Applications`), seen on
both Macs. Device Hub already looks like the owner's picture:

- the device in its frame in the middle of the window
- a toolbar above it: keyboard, layout, zoom, fit, more, settings, logs and
  info
- a bar below it: home, screenshot, record and rotate
- a settings panel: appearance, Liquid Glass, colour filter, text size,
  reduce motion, increase contrast, show borders, reduce transparency,
  VoiceOver, location, sound, audio output and input
- a Controls menu: Home, Lock, Siri, App Switcher, Action Button, Rotate
  Left, Rotate Right, Screenshot, Record Screen
- a sidebar of devices, to switch between them

It is a good reference for the panel's layout. It is not a good thing to
run in a device box (see [Input](#2-input)).

## Recommendation

1. **Stream:** read the simulator's framebuffer, not a window. Use
   idb_companion (Meta, MIT) in the box as the device's server first. It
   gives video, input, screenshots and the accessibility tree over one
   gRPC socket, which can be a unix socket as 060 asks. A bb-box adapter
   turns its H.264 into 060's protocol. Write our own server on the same
   private frameworks only if idb_companion falls behind Xcode.
2. **Input:** one HID stream held open per viewer, through the same
   server. Text that has no key on a US keyboard goes as a paste.
3. **Controls:** `simctl` and idb have a command for almost every control
   the owner listed. Switching device means booting another device.
4. **Hosts:** a Tart macOS VM is enough: the simulator runs on its
   paravirtual GPU, and VideoToolbox's hardware encoder works there. The
   image already has Xcode 27 and the iOS runtime. Keep devices booted
   once in the image, and measure whether a spare box should hold one
   running.
5. **Agent:** give the agent the device's own tree and screenshots, in
   points, through the same server. Today's computer use, pointed at
   Device Hub's window, reads too little of it to drive the device.

Each is below with its numbers and what limits it.

## How it was measured

Prototypes are in [ios-simulator-boxes](ios-simulator-boxes/), with the
raw results:

- [measure.py](ios-simulator-boxes/measure.py) starts one stream, and in
  the same process holds an idb HID stream open. It times the first
  frame. It counts frames for 10 s while Safari shows a still page
  ([page.html](ios-simulator-boxes/page.html)). It taps that page 20 times,
  0.6 s apart: each tap turns the page black or white. It times the first
  changed frame after each tap. Then it counts frames for 10 s while the
  page animates on every frame. CPU is the stream process's CPU time over
  each 10 s, as a share of one core. Memory is its resident size.
- [window-stream.swift](ios-simulator-boxes/window-stream.swift) captures
  Device Hub's window with ScreenCaptureKit, cropped to the device, and
  encodes it as `bb-box-stream` does.
- [input.py](ios-simulator-boxes/input.py) drags, long-presses, pastes and
  times what an agent reads.

Tap to frame is measured on the Mac: from the HID event leaving the client
to the encoded frame arriving from the server. It leaves out BB's relay,
the network and the browser's decoding, which are the same as for any
desktop's video: about 25 ms at the median through BB's server
([060](../decisions/060-every-desktop-streams-as-video-through-one-viewer.md)).

Hosts:

- **Tart:** a macos-desktop box, 8 cores and 32 GiB, macOS 27.0, from the
  standard image with Xcode 27. Its screen is 1024x768 at 1x.
- **Pool Mac:** a physical Mac with Apple silicon (M5 Max), lent whole,
  Xcode 27.0, a 4K display.

Clips and screenshots used as evidence are kept in the thread's storage,
not the repository.

## 1. Stream

| Way | Host | First frame | Tap to frame, median (worst) | Idle | Busy | CPU, idle / busy | Memory | Picture | Busy bitrate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| idb video-stream: framebuffer, H.264 | Tart | 61 ms | 64 ms (78 ms) | 4.4 fps | 58 fps | 1% / 10% | 57 MiB | 1206x2622, the device's pixels | 3.3 Mbit/s |
| idb video-stream: framebuffer, H.264 | Pool Mac | 877 ms | 54 ms (59 ms) | 1.3 fps | 60 fps | 0% / 11% | 40 to 62 MiB | 1206x2622 | 3.1 Mbit/s |
| ScreenCaptureKit, Device Hub's window, H.264 | Tart | 296 ms | 86 ms (126 ms) | 0 fps | 55 fps | 1% / 4%, and Device Hub's own drawing | 95 MiB | 420x848: the window's size on screen | 1.1 Mbit/s |
| axe stream-video: screenshots, PNG | Tart | 149 ms | 72 ms (122 ms) | 26 fps | 28 fps | 58% / 79% | 101 to 111 MiB | 1206x2622 | 36 Mbit/s |
| simctl io recordVideo | Tart | cannot stream | | | | | | 1206x2622 H.264 | |

Notes on the table:

- **idb, first tap:** the first tap after the companion starts took 578 ms
  on Tart, and was missed within the 0.6 s window on the pool Mac: the
  companion sets up its HID client then. The worst figures above leave
  that tap out. A server should set up HID when a viewer connects.
- **idb, first frame:** 61 ms on Tart was the companion's second stream;
  877 ms on the pool Mac was its first. The first stream sets up the
  encoder and a GPU colour conversion (`VTPixelTransferSession`).
- **idb encodes only when the screen changes**, about 1.2 to 2 ms a frame
  on Tart. Rate control at quality 0.2 gave 3.4 Mbit/s for 1206x2622.
- **idb follows rotation:** in landscape the stream is 2622x1206, and it
  changes size mid-stream when the device rotates. The viewer already
  handles a size change, as for desktop resizes.
- **ScreenCaptureKit** needs Device Hub open in the desktop session, its
  window not minimised, and Screen Recording for the capturing process.
  It sees only as many pixels as the window has on screen: a third of the
  device's on a 1024x768 VM screen. It adds about 22 ms against idb.
- **axe** polls screenshots, so it is not video: it would still need an
  encoder, and it spends more than half a core doing nothing.
- **simctl io recordVideo** refuses standard output ("rendering to
  standard out is no longer supported") and wrote nothing to a FIFO. To a
  file it recorded 600 frames in 11.15 s while busy, 54 fps, H.264 at the
  device's pixels. It suits `box_record` on a device box.
- **No visible window and no desktop session is needed** for idb or simctl.
  Everything above except ScreenCaptureKit ran over plain SSH. Both Macs
  did have a user logged in at the console, so a Mac with no console
  session is not tested.

**Recommendation:** the framebuffer, through idb_companion, adapted to
060's protocol by bb-box. It sends the device's own pixels as whole
frames, with no tearing, at 60 fps, for a tenth of a core.

It will not meet 060's bar for desktops, under 50 ms at the median through
BB. On the Mac alone a tap takes 54 to 64 ms to reach an encoded frame, and
encoding is 1 to 2 ms of that, so most of it is the simulator's own time
from touch to drawing. With BB's relay, expect about 80 to 90 ms. No other
way measured here is quicker.

This also answers one of 060's open questions: VideoToolbox's hardware
encoder works inside a Tart macOS VM.

**What limits it:**

- idb_companion and its FBSimulatorControl frameworks use Apple's private
  CoreSimulator and SimulatorKit frameworks. An Xcode release can break
  them. Version 1.7.7, built on 22 October 2026, works with Xcode 27.0.
- It is 115 MB, from Meta's Homebrew tap, under the MIT licence. Homebrew
  asks for the tap to be trusted first (`brew trust facebook/fb`).
- Its gRPC client is Python (fb-idb). bb-box would speak its gRPC from
  TypeScript, or through a small client of our own, not through fb-idb.

Writing our own server instead would mean the same private frameworks,
with idb's MIT source as the guide: framebuffer IOSurface callbacks for
frames, and SimulatorKit's Indigo HID messages for input. It is a few
hundred lines more than `bb-box-stream`, and the work of following each
Xcode is ours.

## 2. Input

| What | How | Time | Checked |
| --- | --- | --- | --- |
| Tap | HID touch down and up | 54 to 64 ms tap to frame, held stream | yes |
| Drag, swipe, scroll | HID touch down at each new point, every 16 ms, then up | as tap | yes: Settings scrolled |
| Long press | HID touch down, wait, up | as tap | yes: 1.2 s on the Settings icon opened its menu |
| Pinch | idb's pinch event | | not tested |
| Keys on a US keyboard | HID key usage codes, with Shift, Control, Option, Command | `idb ui text` 267 ms for 13 characters, CLI | yes |
| é, emoji, Japanese | no key code: idb and axe both fail ("No keycode found") | | no |
| Any text, by paste | `LANG=en_US.UTF-8 simctl pbcopy`, then Cmd+V as HID keys | about 0.2 s, then the prompt | yes: "A 😀 日本語 é" arrived |
| Home, Lock, Side, Siri, Apple Pay | idb `ui button`, axe `button` | 260 to 420 ms, CLI | Home, Lock, Siri: yes |
| Volume, Action button | none in idb or axe; Device Hub's artwork lists their HID usages (Volume Up: page 12, usage 233; Action: page 11, usage 45) | | not tested |

What was seen:

- **The first paste into an app asks.** Safari showed '"Safari" would like
  to paste from "CoreSimulatorBridge"'. The alert is in the accessibility
  tree, with Allow Paste as a button, so an agent or a person can answer
  it. A second paste did not ask.
- **Autocorrect changes typed words.** On Tart, "Hello idb 123" typed as
  keys became "Hello IMDb 123". On the pool Mac the same text was only
  underlined. Typing for an agent should go with autocorrect off, or as a
  paste.
- **Device Hub takes the pasteboard.** While it was open on Tart, the
  device's pasteboard followed the Mac's: `simctl pbpaste` gave the Mac's
  text, and `simctl pbcopy` did not stick. With Device Hub closed and the
  device booted again, `pbcopy` worked. So a device box should not run
  Device Hub.
- **Device Hub's first launch asks for the microphone** for
  "SimulatorTrampoline.xpc", a macOS prompt over the desktop.

**Recommendation:** each viewer with control holds one HID stream to the
server, as `bb-box-stream` holds input today. Pointer down, move and up map
to touch down at each point and touch up, in the device's points: the
viewer scales from the video's pixels by the device's scale (3 for an
iPhone 18 Pro). Keys go as HID usages. BB's **Type text** field, and any
character with no US key, go as `pbcopy` and Cmd+V. The agent's commands
use the same server, so they wait for the same control rule as desktops.

**What limits it:** no multi-touch from a mouse; pinch needs a modifier
or a control. Volume and Action buttons need HID usages that idb does not
send. Paste prompts once per app.

## 3. Controls

Each was run against a booted iPhone 18 Pro. Times are the command's,
including its process start.

| Control | Command | Time | Effect seen |
| --- | --- | --- | --- |
| Home | `idb ui button HOME` | 315 ms | yes |
| Lock | `idb ui button LOCK` | 359 ms | yes, lock screen; once, the screenshot after it showed the Home Screen |
| Siri | `idb ui button SIRI` | 353 ms | yes |
| App switcher | none found; Device Hub's menu (Ctrl+Shift+Cmd+H) | | UI path only |
| Rotate | `idb ui rotate PORTRAIT`, `LANDSCAPE_LEFT`, `LANDSCAPE_RIGHT`, `PORTRAIT_UPSIDE_DOWN` | 198 to 364 ms | yes: screenshots and stream turn to 2622x1206 |
| Appearance | `simctl ui <device> appearance light\|dark` | 140 ms | yes |
| Text size | `simctl ui <device> content_size <category>\|increment\|decrement` | 239 ms | yes |
| Increase contrast | `simctl ui <device> increase_contrast enabled\|disabled` | 143 ms | not looked at |
| Reduce motion | no command; `simctl spawn <device> defaults write com.apple.Accessibility ReduceMotionEnabled -bool true` | | Device Hub's switch turned on; apps not checked |
| Reduce transparency, VoiceOver, colour filter, Liquid Glass, show borders | no command | | Device Hub's panel only |
| Status bar | `simctl status_bar <device> override --time 9:41 --batteryState charged ...`, `clear` | 178 ms | yes |
| Location | `simctl location <device> set <lat>,<lon>`, `start` a route, `clear` | 121 to 139 ms | accepted; not seen in an app |
| Push | `simctl push <device> <bundle id> <file.json>` | 148 ms | accepted; no banner, as Settings takes none: needs an app that asked |
| Privacy grants | `simctl privacy <device> grant\|revoke\|reset <service> <bundle id>` | 121 to 141 ms | accepted |
| Screenshot | `simctl io <device> screenshot`; idb's gRPC screenshot | 330 to 590 ms; 22 ms | yes |
| Record | `simctl io <device> recordVideo` | | yes, 54 fps busy |
| Open a URL | `simctl openurl` | 189 ms | yes |
| Shake, memory warning | `idb ui shake`, `idb simulate-memory-warning` | 262 ms, 267 ms | not looked at |
| Switch phone or tablet | none: boot another device and point the stream at it | 1.3 to 1.9 s booted before; 14 to 68 s first boot | yes |
| Reboot | `simctl reboot` (new in Xcode 27) | 5.3 s | yes |
| Erase | `simctl erase`, on a device that is shut down | | not run |
| Screen geometry | `simctl io <device> screenConfig geometry <w>x<h>[@scale]` (new) | | not run |
| Foldable hinge | `idb hinge` exists | | no foldable device type in Xcode 27.0 |

**Recommendation:** controls run as commands in the box, through `simctl`
or the server, not through any UI. The panel's toolbar offers what has a
command; reduce motion and the rest of Device Hub's accessibility panel
wait until a supported way is found.

## 4. Hosts

| | Tart VM | Pool Mac | Namespace Mac |
| --- | --- | --- | --- |
| Simulator runs | yes, on the VM's paravirtual GPU | yes | not tested: slot in use |
| Hardware H.264 encoder | yes: VideoToolbox accepts "require hardware" at 1206x2622 and 2064x2752 | yes | |
| First boot, iPhone 18 Pro | 32.2 s, 23 s of it data migration | 13.9 s | |
| Boot again after shutdown | 1.9 s | 1.3 s | |
| Reboot | 5.3 s | | |
| First boot, new iPhone 17 | 27.0 s | | |
| Boot of a clone of a device booted once | 13.1 s | | |
| First boot, iPad Pro 13-inch (M5) | 67.7 s | | |
| Idle cost of a booted iPhone | about 6% of 8 cores, half a core | | |
| Memory per booted device | about 1 to 1.5 GiB, from vm_stat's used pages a minute after boot | | |

Disk:

- iOS 27.0 runtime: 7.5 GiB, a cryptex disk image. The Tart image has iOS,
  tvOS, watchOS and visionOS runtimes, 21.5 GB together.
- Xcode as installed in the image: `du` says 3.3 GiB, which undercounts
  Apple's compressed files.
- A device's data: 133 MiB new; 4.3 GiB for the iPhone used for an hour
  of these tests.

Warm devices:

- A booted simulator lives in its VM. A spare Tart box could hold one
  booted, for half a core and about 1 GiB while it waits.
- Most of a first boot's cost is one-off: the same device boots again in
  under 2 s. The image's `setup/tart/guest/xcode.sh` already boots an
  iPhone once, then deletes it. Keeping one device of each offered type,
  booted once and shut down, may give fast boots without holding any
  running. That 1.9 s was measured in the same VM straight after a
  shutdown, with caches warm. A fresh box from such an image is not
  measured yet.

**Recommendation:** Tart first. It isolates each device, needs no new host,
and its image has what is needed. A device box is a macOS VM from that
image, with idb_companion in it, and one device booted at start. Pool Macs
boot faster and may suit a heavy user, but are shared and fewer.

## 5. Agent use

| What the agent gets | How | Time |
| --- | --- | --- |
| Screenshot, PNG at the device's pixels (330 KB) | idb gRPC, held connection | 22 ms median |
| Screenshot | `simctl io screenshot` | 330 to 590 ms |
| Accessibility tree, flat JSON: role, label, value, frame in points | idb gRPC `describe-all`, held connection | 18 ms median |
| Accessibility tree | `idb ui describe-all`, CLI | 148 to 155 ms |
| Accessibility tree | `axe describe-ui` | 1.1 to 1.4 s |
| Tap, swipe, keys, buttons | HID, as in [Input](#2-input) | |

What the tree gives: for Settings, 17 elements, 13 of them buttons with
their labels, such as "General" and "Accessibility". For the Home Screen,
14, with each app's frame, so a tap can aim at an element's centre. A
system alert, such as Allow Paste, shows with its buttons. Web content in
Safari does not: only Safari's toolbar shows, so for a web page the agent
needs the screenshot.

Today's computer use on a Mac desktop reads macOS windows through the Cua
Driver. Pointed at Device Hub's window on Tart, it gave a partial tree
after its 3 s budget: the sidebar, nothing of the device. It would have to
click pixels on a scaled picture of the phone.

**Recommendation:** on a device box, the computer tools read the device:
`computer_observe` returns the device's tree, `computer_screenshot` the
framebuffer, `computer_act` sends HID at an element's centre or at a point
in the latest image. Coordinates are the device's points. These are the
same tools the agent knows, with the device as the only window.

## A device box's data, a sketch

For the design note. Names follow bb-box's own where they exist.

```ts
type DeviceBox = {
  platform: "ios" | "android";
  device: {
    type: string;            // "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro"
    name: string;            // "iPhone 18 Pro"
    form: "phone" | "tablet" | "foldable" | "watch" | "tv";
    runtime: string;         // "iOS 27.0"
    id: string;              // the simulator's UDID, inside the box
  };
  screen: {
    pixels: { width: number; height: number };   // 1206 x 2622, portrait
    scale: number;                                // 3: points = pixels / scale
    cornerRadius?: number;                        // from the framebuffer mask
  };
  state: "booting" | "booted" | "shutting-down" | "shutdown" | "failed";
  orientation: "portrait" | "landscape-left" | "landscape-right" | "portrait-upside-down";
  settings: {
    appearance: "light" | "dark";
    contentSize: "extra-small" | "small" | "medium" | "large" | "extra-large"
      | "extra-extra-large" | "extra-extra-extra-large"
      | "accessibility-medium" | "accessibility-large" | "accessibility-extra-large"
      | "accessibility-extra-extra-large" | "accessibility-extra-extra-extra-large";
    increaseContrast: boolean;
    statusBar: null | { time?: string; battery?: number; charging?: boolean; wifiBars?: number; cellularBars?: number };
    location: null | { latitude: number; longitude: number } | { route: { latitude: number; longitude: number }[]; speed: number };
    hingeAngle?: number;     // foldables, when a platform has them
  };
  devices: { type: string; name: string; form: DeviceBox["device"]["form"]; booted: boolean }[];
};

type DeviceControl =
  | { id: "home" | "lock" | "siri" | "side" | "action" | "volume-up" | "volume-down"; kind: "button" }
  | { id: "rotate-left" | "rotate-right"; kind: "button" }
  | { id: "appearance"; kind: "choice"; choices: ["light", "dark"] }
  | { id: "content-size"; kind: "steps" }
  | { id: "increase-contrast"; kind: "toggle" }
  | { id: "status-bar"; kind: "preset"; presets: ["clean", "none"] }
  | { id: "location"; kind: "place" }
  | { id: "push"; kind: "payload"; bundleId: string }
  | { id: "privacy"; kind: "grant"; service: string; bundleId: string }
  | { id: "screenshot" | "record" | "reboot" | "erase"; kind: "action" }
  | { id: "switch-device"; kind: "choice"; choices: string[] }
  | { id: "open-url"; kind: "text" };
```

The panel draws the video inside a frame of the device's form, with the
controls in a narrow bar beside it, as Device Hub places them. The frame
can be our own drawing, a rounded body with the screen's corner radius and
side buttons, or Apple's artwork in the box's Xcode
(`/Library/Developer/DeviceKit/Chrome/*.devicechrome`: PDFs and a
`chrome.json` that places each button and names its HID usage).

## Open questions for the owner

1. **idb_companion or our own server?** idb_companion works today and
   gives everything at once, but is Meta's, 115 MB, and on private APIs.
   Our own is smaller and ours to keep up with Xcode.
2. **Whose device frame?** Our own drawing ships with bb-box. Apple's
   artwork is in every box's Xcode, but is Apple's: reading it from the
   box at run time, not keeping it in the repository, still needs a
   licence call.
3. **A new kind or a panel on macOS boxes?** An `ios-simulator` kind with
   the device as its display, or a device panel any macOS box can open
   beside its desktop.
4. **One device per box, or several?** Switching phone to tablet in the
   same box takes 1.3 to 1.9 s once both have booted, against a new box.
   Several booted devices cost about 1 GiB each.
5. **Warm spares:** keep a device running in spare boxes, or only devices
   booted once in the image? Measure a fresh box's boot from such an image
   first.
6. **Defaults in the image:** autocorrect off, Device Hub never started,
   its microphone prompt answered, so typing and pasting are predictable.
7. **Foldables:** Xcode 27.0 has no foldable device type. A foldable needs
   the Android emulator, the other half of this programme.
8. **Namespace Macs** are untested here, and with them a Mac with no user
   logged in at its console.

## Rerunning the measurements

On a Mac box with Xcode 27:

```sh
brew tap facebook/fb && brew trust facebook/fb && brew install idb-companion
python3 -m venv ~/idbenv && ~/idbenv/bin/pip install fb-idb psutil
udid=$(xcrun simctl list devices available | sed -n 's/.*iPhone 18 Pro (\([-0-9A-F]*\)).*/\1/p' | head -n 1)
xcrun simctl bootstatus "$udid" -b
idb_companion --udid "$udid" --grpc-port 10882 &
cd ios-simulator-boxes && python3 -m http.server 8765 --bind 127.0.0.1 &
~/idbenv/bin/python measure.py idb --udid "$udid" --out ~/runs/idb
```

For the window, build `swiftc -O -o window-stream window-stream.swift`, open
Device Hub, and run `measure.py window ... -- ./window-stream iPhone
X,Y,W,H` from the desktop session, with the device's rectangle in the
window's points. For axe, `brew install cameroncooke/axe/axe` and run
`measure.py axe ... -- axe stream-video --udid "$udid" --format mjpeg
--fps 30`.
