# 063: Device boxes: one iOS Simulator or Android emulator per box, in a frame in the panel, shared with the agent

Status: proposed, 26 October 2026. Built on the research in
[iOS Simulator boxes](../research/ios-simulator-boxes.md) and
[Android emulator boxes](../research/android-emulator-boxes.md). Extends
[060](060-every-desktop-streams-as-video-through-one-viewer.md): a device's
screen is one more video display in the one viewer.
[059](059-agents-record-their-desktop-box-with-box-record.md): box_record
records a device. [027](027-a-kind-says-when-it-has-a-desktop.md): a kind
can say it has a device. [038](038-the-agent-can-take-control-back.md):
control covers the device. [032](032-spare-boxes-are-enrolled-ahead.md):
a spare holds a booted device.

## Context

The owner wants a thread's phone or tablet in the panel, as Xcode's Device
Hub and Android Studio's running devices show one: the device in its frame,
with a narrow bar of controls beside it. A person and the agent share it as
they share a desktop. The agent builds, installs and tests on it, reads its
screen as elements, and records what it did.

Two research notes measured how. What decides this note:

| | iOS Simulator | Android emulator |
| --- | --- | --- |
| Host | Tart macOS VM, paravirtual GPU, hardware H.264 | Proxmox QEMU VM with nested KVM, drawn by the CPU (SwiftShader) |
| Screen source | the framebuffer, through idb_companion 1.7.7 (MIT) | the emulator's gRPC `streamScreenshot` |
| Tap to encoded frame, in the box | 64 ms median, 78 ms worst (Tart) | 58 ms median, 67 ms worst, with x264 in the box |
| Frames a second, busy | 58 (Tart), 60 (pool Mac) | 32 encoded; drawing peaks at about 35 on 7 of 8 cores |
| Cost of the stream | 1% of a core idle, 10% busy, 57 MiB | x264: 20 ms a frame, about 0.65 of a core at 32 fps |
| Input | HID through idb, held open | gRPC touches and keys, held open |
| Text with no US key | paste: `simctl pbcopy`, then Cmd+V | paste: gRPC `setClipboard`, then Paste |
| Tree for the agent | idb `describe-all`, 18 ms | `uiautomator dump`, 1.9 s |
| Screenshot | idb, 22 ms | gRPC, 16 ms raw, 80 ms PNG |
| Boot | 1.3 to 1.9 s once booted in that VM; 14 to 68 s first boot | 2.2 to 3.9 s from its snapshot; 16 to 18 s cold |
| Memory per booted device | about 1 to 1.5 GiB | 3.4 GB after boot, about 5 GB after use |
| Foldables | none in Xcode 27.0 | Pixel Fold: fold, unfold and posture by command |

Through BB's server, both should show a tap in about 80 to 90 ms at the
median: the box's own 54 to 64 ms, and BB's 25 ms
([060](060-every-desktop-streams-as-video-through-one-viewer.md)). That is
over 060's 50 ms bar for desktops. Most of it is the device's own time from
touch to drawing, which no stream can remove.

The lead has made nine decisions, which this note builds on: two kinds,
`ios` and `android`; one device per box, switched in place; idb_companion
for iOS and a server of bb-box's own for Android, both into 060's viewer;
Android on the CPU with one AVD per profile, each with a snapshot, and
Google APIs images only; text other than ASCII as a paste; the agent's
device input held back while a person has control, and its commands not;
frames of bb-box's own drawing; spares that keep a booted device; and Tart
nested virtualisation, Namespace and pool Macs later. Where this note
changes one, it says so under [Changes to the brief](#changes-to-the-brief).

## Decisions at a glance

Each decision rests on a measurement, or names the experiment (E1 to E16,
under [Experiments](#experiments)) that settles it in a named unit.

| | Decision | Settled by |
| --- | --- | --- |
| 1 | Two kinds, `ios` and `android`: a host VM with one booted device, the host's desktop beside it | iOS: the simulator runs headless in a Tart VM. Android: it runs headless in a QEMU VM with KVM, and not in LXC, Docker or Tart Linux |
| 2 | One data model for both platforms: models, state, controls, input, elements | the two research sketches, merged below |
| 3 | One device server per box, `bb-box-device`, in TypeScript on the box's Node, with a driver per platform | Node is in both images already; idb and the emulator both speak gRPC, which Node's `http2` reaches |
| 4 | It speaks 060's Selkies subset for video and input, and bb-box's own `BB_DEVICE` messages for the rest, over a unix socket reached by `connect` over SSH, as `bb-box-stream` | bb-box-stream does so on Macs and Windows today (060) |
| 5 | Android frames are encoded by a small C helper on x264; frames go to it by the emulator's shared memory if E6 shows it pays | x264 took 20 ms a frame at 1080x2400; raw frames are 7.8 MB |
| 6 | Nothing of the device listens on the network: idb on a unix socket, the emulator's gRPC with a token and blocked by the box's firewall | the emulator's gRPC listens on every interface with no token by default |
| 7 | The panel draws the device in a frame of bb-box's own, from numbers in a model table, with a narrow toolbar of 9 controls and a More menu | Device Hub and Android Studio; what each platform can do, measured |
| 8 | The computer tools read and drive the device itself: its tree, its framebuffer, its touches | Cua saw one element on Android and nothing of the device on iOS |
| 9 | A new tool, `box_device`, has one action per control; screenshots and URLs stay with the computer tools | the control tables in both notes |
| 10 | While a person holds control, the agent's device input is refused at once; reading, installs and commands go on | today's rule for desktops (038), and the notes' finding that adb input cannot be seen |
| 11 | `box_record` records the device server's own stream, framed, with captions in a band beside the device | both servers already encode the device's pixels; adb screenrecord stops at 3 minutes |
| 12 | A spare waits as a suspended or hibernated VM with its device booted | Tart and Proxmox QEMU already keep warm VMs so; E3 and E4 check the device survives |

## The data shape

The types are in one file, `src/core/device.ts`, read by the plugin, the
panel and the device server alike, and the model table is beside it in
`src/core/device-models.ts`. Names below are the ones the code will use.

### Device models

A model is one device a box can boot. bb-box's own table holds every model
it can offer, with the numbers its frame is drawn from. An image's record
lists the models that image has booted once. A kind offers the models in
both.

```ts
type DevicePlatform = "ios" | "android";
type DeviceForm = "phone" | "foldable" | "tablet";
type Posture = "closed" | "half-open" | "open";

interface DeviceModel {
  readonly name: string;                 // "iPhone 18 Pro": what box_acquire's device and box_device's switch take
  readonly platform: DevicePlatform;
  readonly form: DeviceForm;
  readonly native: string;               // in the box: a simulator device type, or an AVD's name
  readonly screens: readonly DeviceScreen[];  // one; a foldable's outer screen first, then its inner
  readonly postures: readonly Posture[];      // empty unless a foldable
  readonly textSizes: readonly number[];      // the platform's steps, as scales of the default, 1
  readonly frame: FrameShape;
}

interface DeviceScreen {
  readonly shows: "always" | "closed" | "unfolded";   // a foldable's outer screen shows closed
  readonly pixels: { readonly width: number; readonly height: number };  // at rotation 0
  readonly scale: number;                // pixels to points (iOS) or to dp (Android: density / 160)
  readonly cornerRadius: number;         // pixels
  readonly cutout: Cutout | null;        // drawn by the frame on iOS; null where the device draws its own
}

interface Cutout { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly shape: "pill" | "circle" }

interface FrameShape {
  readonly bezel: number;                // pixels of black glass round the screen
  readonly bodyRadius: number;
  readonly buttons: readonly { readonly edge: "left" | "right" | "top"; readonly from: number; readonly to: number }[];  // fractions of the edge
  readonly hinge: "vertical" | "horizontal" | null;
}
```

The first catalogue is what the notes measured:

| Model | Platform | Form | Screen at rotation 0 | Measured |
| --- | --- | --- | --- | --- |
| iPhone 18 Pro (default) | ios | phone | 1206x2622 at 3x | stream, input, controls, boots |
| iPhone 17 | ios | phone | from its device type | first boot, 27.0 s |
| iPad Pro 13-inch (M5) | ios | tablet | 2064x2752 | first boot, 67.7 s; hardware encoder at its size |
| Pixel 8 (default) | android | phone | 1080x2400 at 420 dpi | stream, input, controls, boots |
| Pixel Fold | android | foldable | outer 1080x2092; inner 2208x1840 | fold, posture, boot 17.1 s |
| Pixel Tablet | android | tablet | 2560x1600 | boot 17.4 s |

Each further model is a row in the table and a line in the image's build.
The image's check fails when a model's pixels differ from the table's, so a
frame never fits the wrong screen.

### A device box's state

```ts
type Rotation = 0 | 90 | 180 | 270;        // degrees anticlockwise from the screen's rotation 0
type Appearance = "light" | "dark";
type Network = "online" | "offline" | "slow";
type DevicePower = "booting" | "booted" | "stopping" | "stopped" | "failed";

interface DeviceState {
  readonly model: string;                  // DeviceModel.name
  readonly power: DevicePower;
  readonly rotation: Rotation;
  readonly posture: Posture | null;        // null unless a foldable
  readonly appearance: Appearance;
  readonly textSize: number;               // one of the model's textSizes
  readonly location: { readonly latitude: number; readonly longitude: number } | null;
  readonly statusBar: "live" | "clean";
  readonly battery: { readonly level: number; readonly charging: boolean } | null;  // null: the device's own
  readonly network: Network;
  readonly video: { readonly width: number; readonly height: number } | null;      // the stream's pixels now
  readonly error: string | null;           // why it failed, in words
  readonly at: number;                     // when it last changed, ms since the epoch
}
```

Rotation is counted from the screen's own rotation 0, not named portrait or
landscape: the Pixel Tablet's rotation 0 is landscape, and a foldable's
inner screen is wider than tall. People and agents see words: "upright",
"turned left", "upside down", "turned right".

Text size is a scale, so one number means the same on both platforms. Each
platform's steps:

| Platform | Steps | Native |
| --- | --- | --- |
| iOS | 0.82, 0.88, 0.94, 1 (default), 1.12, 1.24, 1.35, 1.65, 1.94, 2.35, 2.76, 3.12 | `content_size` categories extra-small to accessibility-extra-extra-extra-large: body text 14 to 53 points against 17 |
| Android | 0.85, 1 (default), 1.15, 1.3, 1.5, 1.8, 2 | `font_scale`, as Android 15's Settings offers it |

Where each part lives:

| Data | Lives in | Written by | Read by |
| --- | --- | --- | --- |
| The model table | code, `src/core/device-models.ts` | bb-box | everything |
| The models an image has | the image record, `/usr/local/share/bb-box/image.json`, `devices`; and the backend's own image record | the image build | the backend's `kinds()`, box_list, acquire |
| A box's platform and model | the box record, a new `device` field | acquire and switch | box_list, box_status, spares, the panel's lists |
| `DeviceState` | the device server's `~/.bb-box/device/state.json` in the box; the plugin keeps the last it heard in memory | the device server | the plugin, every viewer |
| How the tab shows it: fit, frame on or off, device or desktop | the tab's local storage, per box, as the stream choice is | the viewer | the viewer |

The device server is the one writer of `DeviceState`. It reads back what a
person or a command in the box can change behind it (appearance, text size,
rotation and posture) when a client connects, after each control, and every
10 s while a viewer watches. A read costs 10 to 25 ms on Android and about
140 to 240 ms on iOS, by the notes' control timings.

### Controls: one union

```ts
type DeviceControl =
  | { readonly action: "home" }
  | { readonly action: "back" }
  | { readonly action: "recents" }
  | { readonly action: "lock" }
  | { readonly action: "rotate"; readonly to: "left" | "right" | "upright" }
  | { readonly action: "posture"; readonly to: Posture }
  | { readonly action: "appearance"; readonly to: Appearance }
  | { readonly action: "text_size"; readonly to: number | "larger" | "smaller" | "default" }
  | { readonly action: "location"; readonly to: { readonly latitude: number; readonly longitude: number } | null }
  | { readonly action: "status_bar"; readonly to: "clean" | "live" }
  | { readonly action: "battery"; readonly to: { readonly level: number; readonly charging: boolean } | null }
  | { readonly action: "network"; readonly to: Network }
  | { readonly action: "install"; readonly path: string }
  | { readonly action: "switch"; readonly device: string }
  | { readonly action: "reboot" };
```

What each platform does for each, from the notes' control tables. The code
keeps this table as `DEVICE_SUPPORT`, and the toolbar, `box_device` and
the server all read it, so a control a platform lacks is refused in one
place, with one set of words.

| Action | iOS | Android |
| --- | --- | --- |
| home | idb HOME button: 315 ms by its CLI, seen | gRPC `GoHome`: 2 ms, seen |
| back | not offered: iOS has no back button | gRPC `GoBack`: 1 ms, seen |
| recents | not offered: no command found, only Device Hub's menu | `KEYCODE_APP_SWITCH`: 11 ms, seen |
| lock | idb LOCK: 359 ms, seen | `KEYCODE_POWER`: 25 ms, seen |
| rotate | idb `ui rotate`: 198 to 364 ms; the stream turns to 2622x1206 | gRPC `setPhysicalModel` ROTATION: under 1.5 s, seen in Settings; the launcher stays upright on a phone |
| posture | not offered: Xcode 27.0 has no foldable | gRPC `setPosture`: 2 to 4 ms; closed, half open, open. Tent and flipped are refused on the Pixel Fold, so not offered |
| appearance | `simctl ui appearance`: 140 ms, seen | `cmd uimode night`: 25 ms, seen |
| text_size | `simctl ui content_size`: 239 ms, seen | `settings put system font_scale`: 10 ms, seen |
| location | `simctl location set`, `clear`: 121 to 139 ms, accepted | console `geo fix`, gRPC `setGps`: 0 to 10 ms, read back |
| status_bar | `simctl status_bar override`, `clear`: 178 ms, seen | SystemUI's demo mode: not measured (E10) |
| battery | the status bar only, through `status_bar override`: the device's battery API is unchanged, and the answer says so | console `power capacity`, `power ac`: 1 to 3 ms, seen in Settings |
| network | not offered in v1 (see [Open questions](#open-questions-for-the-owner)) | offline: airplane mode, 29 to 59 ms; slow: `network speed edge` and `network delay umts`, 473.6 kbit/s and 35 to 200 ms, seen |
| install | `simctl install`: not timed | `adb install -r`: not timed |
| switch | shut down, boot the other: 1.3 to 1.9 s booted before in that VM; 14 to 68 s first boot (E1) | stop with its snapshot saved (2.8 s), start the other from its own: 2.2 to 3.9 s |
| reboot | `simctl reboot`: 5.3 s | stop and boot cold: 16 to 18 s |

Volume, Siri, the Action button, shake, erase and snapshots are left out:
idb sends no volume or Action button, shake was not looked at, and the rest
are rare enough for `box_run`.

### Input and coordinates

One coordinate space for everything: the screen's pixels as the stream
shows them now, rotated as the stream is rotated. The viewer's pointer, the
agent's taps, a tree's frames and a screenshot's pixels all use it. Only the
device server turns them into the device's own: points at the device's
scale for idb, pixels at rotation 0 for the emulator. Whether each device
takes touches in its rotated or its unrotated space is E8.

```ts
type DeviceInput =
  | { readonly type: "tap"; readonly x: number; readonly y: number }
  | { readonly type: "long_press"; readonly x: number; readonly y: number; readonly ms: number }
  | { readonly type: "swipe"; readonly from: Point; readonly to: Point; readonly ms: number }
  | { readonly type: "key"; readonly key: string; readonly modifiers: readonly ("shift" | "control" | "alt" | "meta")[] }  // W3C key names
  | { readonly type: "text"; readonly text: string }     // ASCII as keys; the rest as a paste
  | { readonly type: "paste"; readonly text: string };

interface DeviceElement {
  readonly role: string;                  // button, text field, cell, image, static text...
  readonly label: string;
  readonly value: string | null;
  readonly frame: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly enabled: boolean;
  readonly focused: boolean;
  readonly children: readonly DeviceElement[];
}
```

A person's pointer and keys come from the viewer as Selkies' own `m`, `kd`
and `ku` messages, which the video client already sends, so the viewer
needs no new input code. The agent's come as `DeviceInput`.

## Kinds and offers

| | `ios` | `android` |
| --- | --- | --- |
| Label | iOS Simulator | Android emulator |
| Host | macOS on arm64, a Tart VM | Linux on x86_64, a Proxmox QEMU VM where the host gives KVM (057) |
| Image | the Tart macOS image with Xcode, with idb_companion and its devices added | a Linux desktop VM template of its own, with the Android SDK and its devices |
| Commands | SSH, sh, as the box user with sudo | SSH, sh, as `box` with sudo |
| Displays | `device`, the device's video; `desktop`, the host's | `device`; the host's `desktop` and its Selkies video |
| Computer use | the device, through the device server | the device, through the device server |
| Enrols | yes | yes, with Docker as other Linux boxes (041) |
| Sizes | the macOS presets; a device takes 1 to 1.5 GiB and half a core idle | 8 cores and 16 GiB by default, as measured: one phone left 10 GB free |

- `KindCapabilities` gains `device`: the platform and the model names an
  offer's image has, or null. `KindInfo` gains the platform, which the
  panel names the kind by. `computerUse` stays Cua's and is null for both.
- An offer has a model when its image's record lists it. An acquire with a
  `device` tries only offers that have it, as `features` narrow offers
  (041).
- An ios box takes one of a Mac's two macOS VM slots while it runs, as any
  macOS box does. A Mac that offers both kinds shares its slots between
  them.
- Android on a Mac (arm64 images under Tart's nested virtualisation) will be
  a kind of its own, `android-arm64`, as 040 gives arm64 Linux kinds of
  their own, since offers of a kind agree on their architecture.

## The device server

### One program, a driver per platform

`bb-box-device` is TypeScript run by the box's own Node: Homebrew's Node 24
in the Tart image, and the pinned Node in Linux images. It has no npm
dependencies. It speaks gRPC with Node's `http2` and a small protobuf codec
for the messages it uses, tested against the field numbers of the pinned
`.proto` files: idb's, and the emulator's `emulator_controller.proto`.

Why not Swift or Go: Node is in both images now; the server shares
`src/core/device.ts` with the plugin, so the protocol cannot drift between
them; and the plugin can deliver it, as below, with no image rebuild for a
change.

Inside it, one interface, one implementation per platform, and one for
tests:

```ts
interface DeviceDriver {
  boot(model: DeviceModel, signal: AbortSignal): Promise<void>;
  shutdown(signal: AbortSignal): Promise<void>;
  frames(): AsyncIterable<EncodedFrame>;   // whole H.264 access units, only when the screen changes
  pointer(event: ViewerPointer): Promise<void>;   // Selkies' m message, in the stream's pixels
  key(event: ViewerKey): Promise<void>;           // Selkies' kd and ku, by keysym
  input(input: DeviceInput): Promise<void>;
  control(control: DeviceControl, signal: AbortSignal): Promise<Partial<DeviceState>>;
  screenshot(): Promise<Uint8Array>;      // PNG at the stream's pixels
  tree(): Promise<readonly DeviceElement[]>;
  readBack(): Promise<Partial<DeviceState>>;
}
```

| | iOS driver | Android driver | Test driver |
| --- | --- | --- | --- |
| Device | `simctl boot`, `shutdown`, `bootstatus` | the emulator in its own user service, `bb-box-emulator@<avd>`, `-no-window -gpu swiftshader_indirect -grpc 8554 -grpc-use-token`; `adb emu kill` saves the snapshot | none |
| Frames | idb_companion's `video_stream`, H.264, encoded by VideoToolbox in the box (E5: one access unit a message) | gRPC `streamScreenshot` RGB888 at the device's size, given width and height both; encoded by `bb-box-h264` | a test card, drawn and encoded in the server's own process |
| Touch, keys | idb's HID stream, held open from when a person takes control or the agent's first input, as the first tap after the companion starts took 578 ms | gRPC `sendTouch`, `sendKey`, held open | recorded, for tests |
| Paste | `simctl pbcopy` with `LANG=en_US.UTF-8`, then Cmd+V as HID | gRPC `setClipboard`, then the Paste key | recorded |
| Tree | idb `describe-all`, 18 ms | `uiautomator dump`, 1.9 s, until a server in the device answers sooner (unit 5.3) | a fixed tree |
| Screenshot | idb, 22 ms | gRPC `getScreenshot` PNG, 80 ms | the test card |

The test driver lets the shared path, the plugin, the relay and the viewer
be built and checked on any Linux box with no emulator, and gives the
conformance suite (009) a device on every backend.

`bb-box-h264` is about 200 lines of C, built in the Android image against
Ubuntu's libx264, as the Linux desktop images carry x264 for Selkies (056).
It reads whole frames and writes each access unit with its length first. An
H.264 byte stream from the ffmpeg command line has no frame boundaries,
which held each frame until the next began: 100 to 300 ms on a still screen
in the Android note's measurement. x264 runs as the note measured it:
`ultrafast`, `zerolatency`, 8 Mbit/s, 20 ms a frame at 1080x2400 on one
core. Frames reach it by the emulator's shared-memory transport (`MMAP`),
which skips copying 7.8 MB a frame through Node, if E6 shows that it pays;
otherwise through a pipe.

### Where it listens and how bb-box reaches it

As `bb-box-stream` does (060):

- It listens on a unix socket, `~/.bb-box/device/device.sock`, in a folder
  only the box user can open. It has no TCP port.
- bb-box reaches it with `bb-box-device connect` over the box user's SSH,
  the `device` display's command route. `connect` joins its stdin and
  stdout to the socket, starting the server first if it is not running.
- A connection carries an HTTP upgrade, then WebSocket frames. The path
  says the client's role, as Selkies' does: `/device?role=viewer` for a
  viewer's video, `role=input` for the box's one input connection, which
  asks for no video, and `role=control` for the plugin's own requests.
- So the Selkies relay (056) carries a device's video and a person's input
  as it carries a desktop's: pacing by acknowledged frames, key frames on
  request, and input only from the viewer with control.
- The plugin's control connection, one per box, opens on first use and
  closes after 10 idle minutes, when the box stops, and when it is released,
  as the computer-use session does.

### Messages

The Selkies subset, as bb-box-stream speaks it:

| From | Message | Meaning |
| --- | --- | --- |
| viewer | `SETTINGS`, `START_VIDEO`, `STOP_VIDEO`, `REQUEST_KEYFRAME`, `CLIENT_FRAME_ACK,<frame>` | video, as for desktops |
| input | `m,<x>,<y>,<buttons>,0` | a person's pointer: button 1 down is a touch at that point, moves are its moves, up ends it. Alt held makes it two touches mirrored about the screen's centre, a pinch |
| input | `kd,<keysym>`, `ku,<keysym>`, `kr` | keys down and up, and all keys up. A keysym with no US key goes as a paste of its character |
| input | `cw,<base64>` and the chunked forms | the person's clipboard, for the device's |
| server | `MODE websockets` | as Selkies |
| server | binary type 4 | an H.264 access unit, with its frame number |
| server | `clipboard,<base64>` | the device's clipboard, to the input connection only, which passes it to the viewer with control |

bb-box's own, each a verb, then one JSON value, as `BB_CURSOR` is a verb of
bb-box-stream's:

| From | Message | Meaning |
| --- | --- | --- |
| server | `BB_DEVICE_HELLO {protocol, code, platform, models, state}` | first, on every connection: the protocol version, the hash of the server's code, the box's models and the state |
| server | `BB_DEVICE_STATE {state}` | each change of `DeviceState`, to every connection |
| server | `BB_DEVICE_TOUCH {x, y, phase, by}` | each touch, by the agent or a person, to viewers: those not in control draw it |
| control, input | `BB_DEVICE {id, type: "control", control}` | a `DeviceControl` |
| control | `BB_DEVICE {id, type: "input", input}` | a `DeviceInput`, from the agent |
| input | `BB_DEVICE {id, type: "input", input: {type: "paste", text}}` | Type text, from the person |
| control | `BB_DEVICE {id, type: "screenshot"}`, `{type: "tree"}` | reads |
| control | `BB_DEVICE {id, type: "record", to: "start" or "stop"}` | box_record |
| server | `BB_DEVICE_ANSWER {id, ok: true, state, ms, ...}` or `{id, ok: false, error: {code, words}}` | the answer to one request; a screenshot comes as base64 PNG, a tree as `DeviceElement`s |

Error codes: `unsupported` (this platform has no such control), `not-foldable`,
`unknown-device`, `bad-value`, `not-booted`, `failed` (the command's own
words). The words are the ones the agent and the panel show. The plugin
adds one of its own, `person-has-control`, before a request reaches the
server.

The relay drops `BB_DEVICE` from a viewer without control, as it drops
input today. Controls from the person's toolbar come over the input
connection, so the same rule holds them.

### Start, restart and versions

- **Delivered by the plugin.** The server's files go to
  `~/.bb-box/device/server/<code hash>/` through the command transport, as
  bb-box's in-box scripts do, when the hash in the box differs from the
  plugin's. About 100 KB.
- **Run by the box's service manager**, as the box user: a LaunchAgent in
  the desktop session on macOS, with KeepAlive, and a systemd user service
  on Linux, with `Restart=always` and lingering on. Both run the code that
  `~/.bb-box/device/server/current` points at, and come back within 2 s of a
  crash.
- **The device outlives the server.** iOS simulators run under
  CoreSimulatorService. The emulator runs in a user service of its own,
  which the server starts and stops. idb_companion is the server's child,
  and starts again with it; its first frame then took 61 to 877 ms.
- **At acquire,** once the box answers, bb-box delivers the code, starts the
  service and switches it to the asked-for model. The server writes the
  model to its state file, so after a crash or a reboot of the VM it boots
  that model again.
- **A new version.** When `BB_DEVICE_HELLO` names other code than the
  plugin's, the plugin delivers its own, points `current` at it, and
  restarts the service. Viewers see the box end their connection, and
  come back within 043's 5 s. The device stays booted.
- **The device fails or stops:** `power` goes to `failed`, with the reason
  in `error`, and the panel offers Reboot device.

### Keeping the device's own ports closed

| What | How it is kept |
| --- | --- |
| The device server | the unix socket in a 0700 folder; reached only through the box user's SSH |
| idb_companion | `--grpc-domain-sock` in the same folder; no TCP port |
| The emulator's gRPC, which listens on every interface | `-grpc-use-token`; the token is in the emulator's discovery file under `~/.android/avd/running/`, readable by the box user alone. The server reads it from there and sends it with each call. It never leaves the box, and is never logged |
| The emulator's console and adb ports, 5554 and 5555 | loopback only, as the emulator binds them; the console's own auth token file is kept |
| All of these | the Android image's nftables rules drop 8554, 5554, 5555 and 5037 from anything but loopback |

One trusted user still: the thread's agent and the person share the box,
and the agent may run adb or simctl, which can do anything the server can.
The rule is that nothing outside the box reaches the device but through
bb-box.

## The viewer

The owner's picture: the device, framed, in the middle of the panel, a
narrow bar of controls beside it, and the host's desktop one click away.

```
+-------------------------------------------------------------+
| [iPhone 18 Pro v]  [Device | Desktop]   Take control  Type text  ... |
|-------------------------------------------------------------|
|                       .-----------.     [Home ]             |
|                      |  .-------.  |    [Back ]  Android     |
|                      |  | video |  |    [Recnt]  Android     |
|                      |  |       |  |    -------             |
|                      |  |       |  |    [Rot L]             |
|                      |  |       |  |    [Rot R]             |
|                      |  |       |  |    [Fold ]  foldables   |
|                      |  '-------'  |    -------             |
|                       '-----------'     [Light]             |
|                                         [Text ]             |
|                                         -------             |
|                                         [Shot ]             |
|                                         [More ]             |
+-------------------------------------------------------------+
```

### The frame

- **Drawn by bb-box,** as SVG around the video's canvas, from the model's
  `FrameShape` and `DeviceScreen`: a body with rounded corners, black glass
  of `bezel` pixels round the screen, the side buttons, and the screen's
  corners clipped to `cornerRadius`. No Apple or Google artwork.
- **Cutouts.** On iOS the frame draws the Dynamic Island over the screen,
  as Device Hub's chrome does; the framebuffer leaves it out. On Android
  the device draws its own cutout, so the frame draws none. Checked by eye
  per model in unit 4.1.
- **Per form and posture:**

| Form | Rotation | Posture | Drawn |
| --- | --- | --- | --- |
| phone | each | | one body, turned with the device |
| tablet | each | | one body, thinner bezel, turned with the device |
| foldable | each | closed | the outer screen in a phone body |
| foldable | each | open | the inner screen in one wide body, with a faint crease down the hinge |
| foldable | each | half open | as open, with the crease shaded, both halves flat and readable, and "Half open" under the frame |

- **Rotation.** The frame turns 90 degrees about its centre in 300 ms, with
  the last frame of video turned with it, as a real phone held sideways
  shows its old picture for a moment. The first frame at the new size
  replaces it. A frame of video whose shape does not fit the screen's, as
  the Android launcher's upright picture on a phone turned sideways, is
  drawn turned to fit, as the phone would show it.
- **Fold and unfold.** The inner screen's right half folds over the left in
  350 ms, then the outer screen fades in; unfolding is the reverse. The
  stream changes size mid-stream (1080x2092 closed, 2208x1840 open, as
  measured), and the old frame holds until the first new one comes.
- **Reduced motion:** with the browser's `prefers-reduced-motion`, both
  change at once.
- **Size.** The frame and toolbar fit the panel, the device's shape kept,
  and the screen is never drawn larger than its own pixels at the browser's
  pixel ratio. So an iPhone 18 Pro's 1206x2622 fills a tall panel and stays
  sharp. In a panel narrower than the frame at half its fitted size, or on
  a phone's BB, the toolbar goes below the frame as a row. The More menu
  has Pixel for pixel, which scrolls, and Show frame, on by default.
- **Light and dark.** The device's body is graphite in both of BB's themes:
  a phone is dark whatever the page. In BB's dark theme the body has a
  1 px light edge so it stands off the background; in the light theme, a
  soft shadow. The device's own appearance is separate, and is what the
  Appearance control sets.
- **Booting and failed.** While the device boots the screen is black, with
  the model's name and "Booting" in it. A failed device shows its `error`
  and Reboot device.

### The toolbar

Nine controls at most, in four groups, and a More menu, beside the frame. Each earns its
place by being frequent in testing an app, and either awkward with a mouse
or two or more taps deep in the device's own Settings. A control the
platform or model lacks is not drawn, so there are no disabled ghosts.

| Order | Control | Platforms | Why it is on the bar |
| --- | --- | --- | --- |
| 1 | Home | both | the commonest navigation; the home gesture is unreliable with a mouse. Device Hub and Android Studio both have it |
| 2 | Back | Android | Android's commonest navigation; an edge swipe with a mouse is unreliable |
| 3 | Recents | Android | switching apps; a swipe up and hold with a mouse is unreliable. iOS has no command for it |
| 4 | Rotate left | both | a layout check every app gets |
| 5 | Rotate right | both | so turning back is one click, as both IDEs have |
| 6 | Fold | foldables | a popover: Closed, Half open, Open; the posture is what a foldable is tested for |
| 7 | Appearance | both | one click between light and dark; its icon shows which is on |
| 8 | Text size | both | a popover: smaller, larger, default, and the step now; Dynamic Type and font scale are a check every screen gets |
| 9 | Screenshot | both | copies the device's own pixels as a PNG to this computer's clipboard, as the desktop's Copy screenshot does |
| | More | both | Lock; Location (a few cities, or latitude and longitude); Status bar: clean or live; Battery (level, charging); Network (Android); Show frame; Pixel for pixel; Reboot device |

Left off: install (it needs a file in the box, which is the agent's work);
open a URL (the agent's `computer_launch`, and rare for a person); volume,
Siri and the Action button (rare, and idb sends no volume); shake (not
checked); recording (the agent's `box_record`); snapshots (a later
decision).

- **The device picker,** "iPhone 18 Pro" in the top bar, lists the kind's
  models for this box, and switches. A switch to a model not yet booted in
  this box warns that it may take a minute (iOS first boots, 14 to 68 s).
- **Device and Desktop** in the top bar shows the device or the host's
  desktop, each a kept session (037), so switching is instant.

### Control, hand-back and Type text

- **One control per box,** covering the device and the host's desktop, as
  one owner of input at a time (008). Take control and Hand back are the
  desktop viewer's own, in the same place. The toolbar's controls need
  control, as keys do; their tooltips say "Take control first". Screenshot
  does not: it sends the device nothing.
- **Watchers see touches.** A viewer without control draws each
  `BB_DEVICE_TOUCH` as a 36 px translucent circle for 300 ms, so a person
  watching sees where the agent tapped. The viewer with control draws only
  its own pointer.
- **Type text** (#1094) opens the same field. Its text goes to the device
  as a paste, whatever it holds: `simctl pbcopy` and Cmd+V on iOS,
  `setClipboard` and Paste on Android. The notes saw Japanese, Arabic and
  emoji arrive both ways, and both break as keys. iOS asks once per app to
  allow a paste ("Allow Paste" is in the device's tree); Android shows a
  notice for a few seconds.
- **Typed keys** go as keys where a US keyboard has one, and as a paste of
  the character where not, so a character typed with a dead key still
  arrives.
- **Cmd+V or Ctrl+V** in the viewer pastes this computer's clipboard into
  the device, as on desktops. What the device copies comes back to the
  viewer with control: gRPC's clipboard on Android, and `simctl pbpaste`
  every 2 s while the tab has the focus on iOS, as Tart's desktops do
  (#464).

## Agent tools

### box_acquire, box_list, box_status and box_run

- `box_acquire({kind: "ios", device: "iPhone 18 Pro"})`. `device` is new:
  "For an ios or android box, the device it boots, from box_list, such as
  iPhone 18 Pro or Pixel Fold. Defaults to the kind's first." With
  another kind it is refused. A name no offer has is refused, with the
  kind's models listed. With `wait`, the answer comes once the device has
  booted, or after 120 s with "still booting", and says how long it took.
- `box_list`'s line for each device kind ends with its models: "Devices:
  iPhone 18 Pro (default), iPhone 17, iPad Pro 13-inch (M5)." A box's line
  names its device.
- `box_status` adds the device's line: model, power, rotation, posture,
  appearance, text size, and the IDs for commands.
- `box_run` runs on the host, as on any box. On an ios box `simctl`
  commands may name the device as `booted`; on an android box `ANDROID_SERIAL`
  is set, so `adb` needs no `-s`. `BB_DEVICE_ID` holds the UDID or the
  serial on both.

### box_device

One action per control, so the toolbar and the agent can do the same
things in the same words.

| Parameter | Type | For |
| --- | --- | --- |
| `box` | string | the box |
| `action` | `home`, `back`, `recents`, `lock`, `rotate`, `posture`, `appearance`, `text_size`, `location`, `status_bar`, `battery`, `network`, `install`, `switch`, `reboot` | what to do |
| `to` | string or number | rotate: `left`, `right`, `upright`. posture: `closed`, `half-open`, `open`. appearance: `light`, `dark`. text_size: `larger`, `smaller`, `default`, or a scale such as 1.3, taken to the nearest step. status_bar: `clean`, `live`. network: `online`, `offline`, `slow` |
| `latitude`, `longitude` | number | location; leave both out to clear it |
| `level`, `charging` | 0 to 100, boolean | battery; leave both out for the device's own |
| `path` | string | install: a `.app` folder or `.ipa` on iOS, an `.apk` on Android, in the box (box_copy puts it there) |
| `device` | string | switch: a model from box_list |

Answers say what happened, how long it took, and the state after it:
"Turned the iPhone 18 Pro left in 0.3 s. Now: turned left, 2622x1206,
dark, text size 1, booted." An iOS battery answer adds that only the status
bar shows it. Refusals:

| Code | Words, for example |
| --- | --- |
| `unsupported` | "iOS has no back button. Its actions are: home, lock, rotate, ..." |
| `not-foldable` | "The Pixel 8 does not fold. The Pixel Fold does." |
| `unknown-device` | "This box has no Pixel 9. Its devices are: Pixel 8, Pixel Fold, Pixel Tablet." |
| `bad-value` | "text_size takes larger, smaller, default or a scale from 0.85 to 2." |
| `not-booted` | "The Pixel Fold is still booting. Try again in a few seconds, or call box_status." |
| `person-has-control` | the desktop's words: a person has taken control; wait for them to hand it back, or take it back with computer_take_control when they ask |
| `failed` | the command's own words |

The lead's sketch had `screenshot` and `open_url` too. They are left to the
computer tools, which already have both, so there is one way to each.

### Computer use on a device

On a device box the computer tools drive the device, not the host. The
host's desktop is the person's; the agent's work on the host is commands.
Device Hub must not run on an ios box (it takes the pasteboard), and Cua
read nothing of the device through it.

| Tool | On a device box |
| --- | --- |
| `computer_windows` | one window, ID 1, named after the model: "iPhone 18 Pro (device)". A system alert, such as Allow Paste, is inside it |
| `computer_observe` | the device's tree, as today's text: one element a line, references such as `e12`. iOS's flat list is nested by its frames. A reference is found again by role, label and ancestors (022 to 024) |
| `computer_screenshot` | the framebuffer, at most 1568 px on its long edge, with its scale, as today |
| `computer_act` click | a tap at the element's centre, or at x and y in the latest image |
| `computer_act` double_click | two taps 120 ms apart |
| `computer_act` right_click | a long press of 1.2 s, which opened the context menu on both platforms; the description says so |
| `computer_act` scroll | a swipe of a fifth of the screen per step, from the element's centre, points every 16 ms, as measured for drags |
| `computer_act` set_value | a tap on the field, select all, and a paste of the value |
| `computer_act` key, `computer_type` keys | the key or chord, as HID usages on iOS and W3C key names on Android |
| `computer_type` text | ASCII as keys, with autocorrect off in the image; any other character as a paste |
| `computer_launch` app | an app by its bundle ID or package: `simctl launch`, `am start` |
| `computer_launch` url | `simctl openurl`, `am start -a android.intent.action.VIEW` |
| `computer_take_control` | as today |

Web pages in Safari show only Safari's toolbar in the tree, so the agent
uses screenshots there. On Android each tree takes 1.9 s until unit 5.3.

### What waits while a person has control

| The agent's call | While a person holds control |
| --- | --- |
| `computer_act`, `computer_type`, `computer_launch` | refused at once, in the desktop's words |
| `box_device`, every action but `install` | refused at once, the same way |
| `box_device install` | runs |
| `computer_windows`, `computer_observe`, `computer_screenshot` | answer: reading the device sends it nothing |
| `box_record` | runs |
| `box_run`, including `simctl`, `idb` and `adb` | runs. bb-box cannot see input sent this way (`adb shell input`), and does not try |

Refused, not held: a call that waited for a hand-back would hold the
agent's turn for as long as the person tests, which may be minutes. This is
today's rule for desktops (038). The one difference from desktops is that
reads go on: on a desktop, taking control closes Cua's session, and a
device has no such session to close.

## Recording

`box_record` works on device boxes with the same actions, captions and
clip as on desktops (059):

- **The source is the device server's own stream,** not the host's screen:
  the device's own pixels, with no window, at the device's frame rate. The
  server keeps its frames coming while a recording runs, viewer or not.
  `simctl io recordVideo` (54 fps busy) and `adb screenrecord` (12 fps busy,
  3 minutes at most) are not needed.
- **Segments.** The server copies its H.264 into `capture-<n>.mkv` under
  059's folder, with the wall clock's timestamps, and starts a new segment
  at each change of the stream's size: a rotation, a fold. It logs each
  segment's size, rotation and posture, and every touch, in `events`.
- **Making the clip.** Each segment is decoded at 059's 15 fps, so a still
  stretch has frames and is cut as on desktops. Each is placed, framed, on
  one canvas that fits the largest shape in the recording, at most 1600 px
  on its long edge. The frame is drawn by ffmpeg from the same `FrameShape`
  numbers, as 059's caption pills are drawn. Touches show as the viewer's
  circles.
- **Captions** sit in a band of the canvas above the device, or below it
  with `position: "bottom"`, so they never cover the app.

## Spares and ready times

- **A spare holds its device booted, and costs no memory while it waits.**
  An ios spare is a suspended Tart VM, as warm macOS VMs are, which takes
  no VM slot. An android spare is a hibernated Proxmox VM, as Linux and
  Windows spares are. A running spare would cost half a core and 1 to
  1.5 GiB (iOS) or 5% of a core and about 5 GB (Android); a suspended one
  costs disk.
- **A claim** resumes the VM, checks the server's code, and, when the
  thread asked for another model, switches.
- **The default model** is the one a spare holds.

Expected time to a booted device:

| Path | iOS | Android |
| --- | --- | --- |
| A spare, its model | Tart's resume, then nothing (E4) | 4.1 to 5.0 s, as a hibernated Windows spare resumed (057), if the emulator survives it (E3) |
| A spare, another model booted once in the image | that, then a switch: 1.3 to 1.9 s in the same VM; in a fresh box, E1 | that, then 2.2 to 3.9 s from the model's snapshot |
| A new box | a clone and macOS's boot (13.6 s in 061), then the device: 1.9 to 13.1 s by E1, 32.2 s were it never booted | a clone and the VM's boot (8.3 s in 061), then 2.2 to 3.9 s from its snapshot if it loads there (E2), 16 to 18 s cold |
| Becoming a BB machine | 8 to 11 s more, unless a spare, which is enrolled ahead (032) | about 5 s more, unless a spare |

If E3 or E4 shows the device does not survive its VM's suspend, a spare
waits with its device shut down instead, and a claim boots it: the second
row's times.

## Images

| | iOS: the Tart macOS image | Android: a Proxmox QEMU template |
| --- | --- | --- |
| Base | the macOS image with Xcode 27 and its iOS runtime, as now (7.5 GiB; 21.5 GB with every runtime) | the Linux desktop VM template (057) |
| Adds | idb_companion 1.7.7, 115 MB, from Meta's Homebrew tap, its bottle pinned by version and SHA-256; each offered model created, booted once and shut down; the image record's `devices` | the SDK's command-line tools, emulator 37.2.12.0, platform-tools and the Android 15 (API 35) Google APIs x86_64 system image: 2.0 GB to download, 4.6 GB installed; one AVD per model, each booted once and saved to its snapshot; `bb-box-h264`; nftables rules; the image record's `devices` |
| Size added | idb's 115 MB, and each model's data: 133 MiB new, after its first boot to measure | 4.6 GB, and about 4.5 GB a model (2.0 GB data, 2.5 GB snapshot memory, to measure): about 18 GB for three |
| Build time added | each model's first boot: 27 to 68 s | 48 s to install, about 17 s to boot each model, 2.8 s to save it |
| Licences | idb: MIT. Xcode's, accepted at build as now | the SDK's terms forbid passing it on, so the build downloads it with `sdkmanager` and accepts its licences there; bb-box ships none of it. Java is needed for `sdkmanager` and `avdmanager` at build only, and removed after |

Defaults in the image, so typing and pasting are predictable:

| Default | iOS | Android | Why |
| --- | --- | --- | --- |
| Autocorrect, predictions and smart punctuation off | the device's keyboard preferences, written before its first boot ends (E13) | Gboard's, set at build (E13) | on Tart, "Hello idb 123" typed as keys became "Hello IMDb 123" |
| A hardware keyboard | HID keys need none | `hw.keyboard = yes` in each AVD's `config.ini`, before its snapshot | with `no`, as `avdmanager` writes, keys never reached the device; changing it later voids the snapshot |
| Stylus handwriting off | | `settings put secure stylus_handwriting_enabled 0` | Gboard's "Try out your stylus" sheet took the typing |
| Device Hub never started | not opened at build; the image's check fails if it runs | | it takes the device's pasteboard, and asks for the microphone at first launch |
| No window | no Simulator app | `-no-window` | the nested-virtualisation dialog sat over the screen; with the window open, the gRPC stream fell to 26 fps |
| Awake, no lock screen | the simulator does not lock | `svc power stayon true`, the longest screen timeout, no lock screen | a sleeping device sends no frames |
| Animations | on | on | apps are tested as people see them |

The image's check boots each model once from the image's state and checks
its screen's pixels against the model table.

## Build phases

Phase 1 was the research. Each unit below is one builder's PR, on the
target OS's box: a Mac box for iOS, a Linux box with KVM for Android. Each
ends in a live check through BB, on a separate BB in a box with bb-box from
the unit's branch, with what it measured. Units side by side run in
parallel. Each unit updates the architecture and the reference for what it
adds.

### Phase 2: a device's video in the panel

| Unit | Builds | Live check | After |
| --- | --- | --- | --- |
| 2.1 The shared model and the test device | `src/core/device.ts` and the model table; the kinds in `KIND_INFO`; `KindCapabilities.device`; the box record's `device`; box_acquire's `device`, box_list's models; `bb-box-device` with `connect`, the service units, delivery by the plugin, HELLO and STATE, and the test driver; the `device` display shown as plain video | a Linux box running the test driver: its video in the panel through BB, first frame and frame rate; the server killed and back within 2 s, the viewer back within 5 s; a new code hash delivered and restarted | |
| 2.2 The Android image | the template of [Images](#images), its record and check | the template builds; a box from it boots each model from its snapshot, timed; E2, the snapshot on a second host if there is one; ports 8554, 5554, 5555 closed from another box; E13 | |
| 2.3 The iOS image | the Tart image's additions, record and check | E1: a fresh box boots each model, timed; Device Hub not running; E13 by typing "Hello idb 123" | |
| 2.4 The Android driver: boot and video | the emulator's service with its token; frames through `bb-box-h264`; the `android` kind on Proxmox QEMU where it has KVM; acquire boots the model | 060's harness through BB: first frame, frame rate still and busy, server and encoder CPU, memory; E6; E7; E3 | 2.1, 2.2 |
| 2.5 The iOS driver: boot and video | idb_companion on its socket; its frames; the `ios` kind on Tart | the same harness through BB; E5; E4 | 2.1, 2.3 |

### Phase 3: touch, keys and shared control

| Unit | Builds | Live check | After |
| --- | --- | --- | --- |
| 3.1 Android input | the person's pointer, keys and pinch (Alt and drag) through gRPC; paste for Type text and for keys with no US key; the clipboard both ways; control and hand-back; touch echo to watchers | E14: tap to frame through BB, 20 taps, against about 80 to 85 ms expected; a list scrolled, a long press's menu, a pinch; Japanese, Arabic and an emoji by Type text; control taken, refused to a second viewer, handed back; E8 after rotating with `adb` | 2.4 |
| 3.2 iOS input | the HID stream, opened as control is taken; keys as HID usages; paste through `simctl pbcopy`; pinch (E9) | the same checks, E14 against about 80 to 90 ms; the first tap after taking control quick, not 578 ms; E8 after rotating with idb | 2.5 |

### Phase 4: the frame, the toolbar and box_device

| Unit | Builds | Live check | After |
| --- | --- | --- | --- |
| 4.1 The frame | the frame per form, posture and rotation; fit, Pixel for pixel, Show frame; light and dark; rotation and fold animations; booting and failed screens; Device and Desktop | screenshots of every model on both platforms in both themes; rotation and fold driven by `adb` and idb commands, the animation's frame times in the harness; a narrow panel and a phone's BB | 3.1, 3.2 |
| 4.2 Android controls and box_device | the Android driver's controls and read-backs; the `box_device` tool, `DEVICE_SUPPORT`, the refusal for a person's control | every Android action by `box_device`, its effect seen in a screenshot or read back; each font scale step set and read back; E10; E11 | 3.1 |
| 4.3 iOS controls | the iOS driver's controls and read-backs | every iOS action by `box_device`, its effect seen; each content size category set and read back against the text size steps; E11 | 3.2; beside 4.2 once its tool is in |
| 4.4 The toolbar | the toolbar, popovers, More menu and device picker | each control clicked on both platforms and its effect seen; a switch to a model not booted before, with its warning; keyboard focus order; a person's control refusing the agent's `box_device home` | 4.1, 4.2, 4.3 |

### Phase 5: computer use, recording and spares

| Unit | Builds | Live check | After |
| --- | --- | --- | --- |
| 5.1 iOS computer use | the computer tools on the device: tree, screenshot, act, type, launch; reads while a person holds control | an agent opens Settings, General, About by references, and types a URL into Safari; each tool's time; Allow Paste answered from the tree | 4.3 |
| 5.2 Android computer use | the same with `uiautomator dump` | the same in Settings and Chrome; each tool's time, the tree's 1.9 s noted | 4.2; beside 5.1 |
| 5.3 Android's tree in tens of milliseconds | a UiAutomation server in the device: Appium's UiAutomator2 server (Apache-2.0), or one of bb-box's own run with `app_process` as scrcpy runs (E12) | tree times before and after; the same references found | 5.2 |
| 5.4 Recording | box_record on device boxes, framed, with segments, touches and the caption band | a 60 s clip on each platform with a rotation and, on the Pixel Fold, a fold, and two captioned steps; its size and length; E15 | 4.1; beside 5.1 |
| 5.5 Spares and switching on claim | spares that hold a booted device; switching on claim; doctor checks for device kinds; the architecture's device section completed | five claims of each path in [Spares and ready times](#spares-and-ready-times), on each platform, timed; E16 | 4.4 |

## Experiments

| | What | Settles | Unit |
| --- | --- | --- | --- |
| E1 | A fresh Tart box from an image with each model booted once and shut down: time to booted, per model | the iOS ready time and the switch to a model not booted in this box | 2.3 |
| E2 | An AVD snapshot made in the image build loads in a box, and on another host's CPU | whether a new android box boots in 2 to 4 s or 16 to 18 s | 2.2 |
| E3 | The emulator survives its VM's hibernation and resume: frames, adb, the clock | whether an android spare keeps its device running | 2.4 |
| E4 | A booted simulator survives its Tart VM's suspend and resume | the same for ios spares | 2.5 |
| E5 | Each message of idb's video stream carries one whole access unit | whether the iOS driver needs a parser | 2.5 |
| E6 | The emulator's `MMAP` frames to `bb-box-h264`, against RGB over gRPC through Node: CPU at 32 fps | how frames reach the encoder | 2.4 |
| E7 | x264 against OpenH264 in `bb-box-h264`: ms a frame at 1080x2400 | the encoder, should x264's GPL matter to the owner | 2.4 |
| E8 | Which space each device takes touches in after a rotation | the server's coordinate mapping | 3.1, 3.2 |
| E9 | idb's HID stream with two touches, for a pinch | whether iOS pinches from the viewer | 3.2 |
| E10 | SystemUI's demo mode for a clean status bar on Android 15 | whether Android has status_bar | 4.2 |
| E11 | Which way left and right turn on each platform | that the toolbar's arrows turn the way they point | 4.2, 4.3 |
| E12 | A UiAutomation server in the device against `uiautomator dump` | Android's tree time | 5.3 |
| E13 | Autocorrect off by preferences, checked by typing "Hello idb 123" | the image's keyboard defaults | 2.2, 2.3 |
| E14 | Tap to frame and frame rate through BB, against the expected 80 to 90 ms | the device's bar, set in [Open questions](#open-questions-for-the-owner) | 3.1, 3.2 |
| E15 | Segments decoded at 15 fps keep still stretches cut as on desktops | the recording's clip | 5.4 |
| E16 | Every path's time to a booted device, five times each | the spare and ready-time table | 5.5 |

## Changes to the brief

- **Switching is under 3 s only for a model booted before in that box.**
  The brief said both platforms switch warm in under 3 s. Android takes 2.2
  to 3.9 s from a snapshot. iOS takes 1.3 to 1.9 s for a device booted
  before in the same VM, 13.1 s for a clone of one booted once, and 14 to
  68 s for a first boot. E1 measures a fresh box, and the picker warns.
- **Refused, not held.** The brief said the agent's device input waits
  while a person holds control, as on desktops. Desktops refuse at once,
  and so does this. Reads now go on, which desktops do not allow.
- **box_device** has `lock` and `recents` added, and `screenshot` and
  `open_url` left to `computer_screenshot` and `computer_launch`.
- **The device server** is one program for both platforms, in TypeScript,
  delivered by the plugin. On iOS it fronts idb_companion, which the brief
  named as the stream.
- **Spares** wait suspended or hibernated with the device booted, not
  running, so they hold no memory.

## Rejected

- **Device Hub's or the emulator's window, captured.** A third of the
  device's pixels on a VM's screen, 22 to 32 ms slower, and on iOS it
  takes the pasteboard. Both notes.
- **scrcpy for the emulator.** It encodes in the guest with Android's
  software encoder, and fell to 12 fps at full size. It stays the way for
  real phones later.
- **The `resizable` Android profile, switched in place.** It switches only
  with the emulator's window open.
- **Several booted devices per box.** About 1 GiB each on iOS and 5 GB on
  Android, for a switch of a few seconds that one device already gives.
- **Apple's device chrome from the box's Xcode.** It is Apple's artwork,
  and needs a licence call; a frame of our own does not.
- **A tool call that waits for a person's hand-back.** It holds the agent's
  turn for as long as the person tests.
- **A server in Swift or Go.** A second language for one program, a build
  in each image, and a protocol that could drift from the plugin's.

## Consequences

- A thread gets a phone, a foldable or a tablet, shown as the owner pictured
  it, which the agent drives through the tools it already knows, and
  records.
- Device video is over 060's desktop bar: about 80 to 90 ms from a tap to
  the screen through BB, most of it the device's own time.
- An Android device draws on the CPU: busy, it takes 7 of 8 cores and shows
  at most about 35 fps. A host with both KVM and a GPU would lift that; none
  has both today.
- An ios box takes a Mac's macOS VM slot, so ios and macOS boxes compete
  for a Mac's two.
- The Android template is about 18 GB larger than the Linux desktop's, and
  each model added costs about 4.5 GB more.
- The device server's protocol moves with the plugin; the images change only
  for what they install.
- adb and simctl in `box_run` can send input while a person holds control.
  bb-box's own tools cannot.

## Open questions for the owner

1. **Models.** Are iPhone 18 Pro, iPhone 17 and iPad Pro 13-inch (M5),
   and Pixel 8, Pixel Fold and Pixel Tablet the right first six, with
   iPhone 18 Pro and Pixel 8 as the defaults? Each Android model adds about
   4.5 GB to its image.
2. **Spares.** Keep one ios and one android spare on each machine that
   offers them? They hold disk, not memory: a hibernated android spare
   holds its 16 GiB of memory as a file.
3. **iOS network.** iOS has no network control in v1. The alternative is to
   shape the whole VM's traffic, except bb-box's SSH and BB's connection,
   which slows the box's own downloads too. Leave it out, or build that?
4. **The host's desktop for the agent.** The agent's computer tools drive
   the device only, and the host's desktop is the person's. Should the
   agent also drive the host's desktop, for Xcode or Android Studio, on a
   device box?
5. **The device bar.** Accept about 80 to 90 ms from tap to screen through
   BB for devices, against 50 ms for desktops, as the bar each platform's
   video must meet to be the default?
