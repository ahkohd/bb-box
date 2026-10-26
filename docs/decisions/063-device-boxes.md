# 063: Device boxes: one iOS Simulator or Android emulator per box, in a frame in the panel, shared with the agent

Status: accepted, 26 October 2026, with [the owner's answers](#the-owners-answers); revised the same day after two
independent reviews, answered finding by finding under
[Review answers](#review-answers). Unit 2.4's measurements of each Android
model and encoder (E6, E7, E17), and unit 3.1's of the Android template
(E2, E13, E19, E24), are in [063 results](063-results.md). Built
on the research in
[iOS Simulator boxes](../research/ios-simulator-boxes.md) and
[Android emulator boxes](../research/android-emulator-boxes.md). Extends
[060](060-every-desktop-streams-as-video-through-one-viewer.md): a device's
screen is one more video display in the one viewer.
[059](059-agents-record-their-desktop-box-with-box-record.md): box_record
records a device. [027](027-a-kind-says-when-it-has-a-desktop.md): a kind
can say it has a device. [038](038-the-agent-can-take-control-back.md) and
[045](045-a-persons-control-lasts-through-a-restart-of-the-plugin.md):
control covers the device, through a restart of the plugin.
[032](032-spare-boxes-are-enrolled-ahead.md): a spare holds a booted
device. [049](049-a-project-image-is-a-script-on-the-standard-image-and-images-are-rebuilt-when-stale.md)
and [054](054-windows-images-are-refreshed-in-a-box-of-the-current-build.md):
device images are built, checked and refreshed as other images are.

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
| Screen source | the framebuffer, through idb_companion 1.7.7 | the emulator's gRPC `streamScreenshot` |
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

Every Android number above is the Pixel 8, at 1080x2400. The Pixel Fold
open and the Pixel Tablet have about 1.6 times its pixels, and drawing and
encoding both grow with pixels, so their frame rate and cost are not known
yet. E17 measures them before the Android viewer is built.

Through BB's server, both should show a tap in about 80 to 90 ms at the
median: the box's own 54 to 64 ms, and BB's 25 ms
([060](060-every-desktop-streams-as-video-through-one-viewer.md)). That
is an estimate, the sum of medians from different tests, not a measured
distribution. The iOS figure also took a frame's size as the sign of a
change, not its decoded pixels. E14 measures it in the browser, on decoded
pixels, with its tail.

The lead made nine decisions before this note: two kinds, `ios` and
`android`; one device per box, switched in place; idb_companion for iOS and
a server of bb-box's own for Android, both into 060's viewer; Android on
the CPU with one AVD per profile, each with a snapshot, and Google APIs
images only; text other than ASCII as a paste; the agent's device input
held back while a person has control, and its commands not; frames of
bb-box's own drawing; spares that keep a booted device; and Tart nested
virtualisation, Namespace and pool Macs later. After the reviews the lead
also set defaults for the note's open questions; they are written in, and
listed under [Defaults set by the lead](#defaults-set-by-the-lead). Where
this note changes the brief, it says so under
[Changes to the brief](#changes-to-the-brief).

## Decisions at a glance

Each decision rests on a measurement, or names the experiment (E1 to E24,
under [Experiments](#experiments)) that settles it in a named unit.

| | Decision | Settled by |
| --- | --- | --- |
| 1 | Two kinds, `ios` and `android`: a host VM with one booted device. An ios box keeps the host's macOS desktop, for the person only; an android box has no host desktop in v1 | iOS: the simulator runs headless in a Tart VM. Android: it runs headless in a QEMU VM with KVM, and not in LXC, Docker or Tart Linux |
| 2 | One data model for both platforms, in which a state the device cannot be in cannot be written: posture only on foldables, no fold on iOS, a runtime on every offered device, relative and absolute rotation apart | the two research sketches, merged, and both reviews |
| 3 | One device server per box, `bb-box-device`, in TypeScript on the box's Node, with a driver per platform | Node is in both images already; idb and the emulator both speak gRPC, which Node's `http2` reaches. Unit 2.2 proves the gRPC codec against both |
| 4 | It speaks 060's Selkies subset for video and input, and bb-box's own `BB_DEVICE` messages for the rest, over a unix socket reached by `connect` over SSH, as `bb-box-stream` | bb-box-stream does so on Macs and Windows today (060) |
| 5 | Every request has an ID, every switch a written intent, and every restart a rule: the [operations and recovery](#operations-and-recovery) contract | both reviews |
| 6 | The server's code is delivered by version, only forward, only by the plugin instance that holds the box's control connection, and never while a person has control or a recording runs | 045's reload of two instances |
| 7 | A viewer picks a display by its ID, not its protocol; a device display has no VNC and falls back to stills where video cannot play | today's routing picks the first Selkies display |
| 8 | Android frames are encoded by a small C helper, on x264 where the operator's image built it and on OpenH264 otherwise, which makes a key frame on demand; frames reach it by shared memory if E6 shows it pays | x264 took 20 ms a frame at 1080x2400; raw frames are 7.8 MB |
| 9 | Nothing of the device listens off the box: idb on a unix socket; the emulator's gRPC with a token, and a firewall of bb-box's own that the emulator cannot start without | the emulator's gRPC listens on every interface with no token by default |
| 10 | The panel draws the device in a frame of bb-box's own, from numbers in a model table, with a narrow toolbar and a More menu | Device Hub and Android Studio; what each platform can do, measured |
| 11 | The computer tools read and drive the device only: its tree, its framebuffer, its touches | Cua saw one element on Android and nothing of the device on iOS |
| 12 | A new tool, `box_device`, has one action per control; screenshots and URLs stay with the computer tools | the control tables in both notes |
| 13 | While a person holds control, the agent's device input is refused at once, and input already sent is stopped; reading, new installs and commands go on | 038 for desktops, and the notes' finding that adb input cannot be seen |
| 14 | Text other than ASCII is pasted in batches, with the device's clipboard saved and put back, and iOS's Allow Paste answered by the server | both reviews; the notes' paste measurements |
| 15 | `box_record` records the device server's own stream, framed, on a monotonic timeline, with captions in a band beside the device | both servers already encode the device's pixels; adb screenrecord stops at 3 minutes |
| 16 | A spare waits as a suspended or hibernated VM with its device booted, one of each kind by default where a host has room for it | E3 and E4 check the device survives; E24 measures the disk |

## The data shape

The types are in one file, `src/core/device.ts`, read by the plugin, the
panel and the device server alike, and the model table is beside it in
`src/core/device-models.ts`. Names below are the ones the code will use.

Two rules hold throughout:

- **A state the device cannot be in has no way to be written.** Posture is
  a field only of a foldable's state; a foldable is only an Android model;
  a flat model has exactly one screen, a foldable exactly two. Code that
  reads a model or a state never checks for a combination the types allow
  but the device cannot have. A file of compile-time cases that must fail
  to type-check (`test/device-types.ts`, with `@ts-expect-error`) keeps it
  so.
- **Data from outside is checked where it comes in.** The box record, the
  image record, the in-box state and intent files, and every wire message
  are parsed by one validator each, which gives a typed value or a refusal
  in words. A model name is resolved against the table there, so nothing
  past the boundary holds a name that is not a model.

### Device models

A model is one device a box can boot. bb-box's own table holds every model
it can offer, with the numbers its frame is drawn from.

```ts
type DevicePlatform = "ios" | "android";
type Orientation = "upright" | "turned-left" | "upside-down" | "turned-right";
type Posture = "closed" | "half-open" | "open";

interface Screen {
  readonly pixels: { readonly width: number; readonly height: number };  // upright
  readonly scale: number;                // pixels to points (iOS) or to dp (Android: density / 160)
  readonly cornerRadius: number;         // pixels
  readonly cutout: Cutout | null;        // drawn by the frame on iOS; null where the device draws its own
}

interface Cutout { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly shape: "pill" | "circle" }

interface Body {
  readonly bezel: number;                // pixels of black glass round the screen
  readonly radius: number;
  readonly buttons: readonly { readonly edge: "left" | "right" | "top"; readonly from: number; readonly to: number }[];  // fractions of the edge
}

interface FlatModel {
  readonly name: string;                 // "iPhone 18 Pro": what box_acquire's device and box_device's switch take
  readonly form: "phone" | "tablet";
  readonly screen: Screen;
  readonly body: Body;
}

interface FoldableModel {
  readonly name: string;
  readonly form: "foldable";
  readonly outer: Screen;                // shows when closed
  readonly inner: Screen;                // shows half open and open
  readonly hinge: "vertical" | "horizontal";
  readonly postures: readonly [Posture, ...Posture[]];
  readonly body: Body;
}

type IosModel = FlatModel & { readonly platform: "ios" };
type AndroidModel = (FlatModel | FoldableModel) & { readonly platform: "android" };
type DeviceModel = IosModel | AndroidModel;
```

A model in the table has no runtime: the same Pixel 8 can run Android 15 or
16. A model as an image offers it does. The image record lists each with
the versions it was built and checked with, so an image with another
runtime is told apart, and box_status can say what the agent tests on:

```ts
interface OfferedDevice {
  readonly model: string;                // a DeviceModel's name, resolved against the table when read
  readonly native: string;               // a simulator device type ID, or an AVD's name
  readonly runtime: Runtime;
}

type Runtime =
  | { readonly platform: "ios"; readonly os: string; readonly build: string; readonly xcode: string; readonly companion: string }
      // "27.0", "24A434", "27A266a", "1.7.7"
  | { readonly platform: "android"; readonly api: number; readonly image: "google_apis"; readonly revision: number;
      readonly abi: "x86_64"; readonly emulator: string; readonly snapshot: SnapshotOrigin | null };
      // 35, 9, "37.2.12.0"

interface SnapshotOrigin { readonly emulator: string; readonly cpu: string; readonly made: string }  // what a snapshot is tied to
```

The first catalogue is what the notes measured, with what each adds to its
image:

| Model | Platform | Form | Screen, upright | Measured | Adds to the image |
| --- | --- | --- | --- | --- | --- |
| iPhone 18 Pro (default) | ios | phone | 1206x2622 at 3x | stream, input, controls, boots | about 0.15 GB: its data after a first boot (133 MiB measured) |
| iPhone 17 | ios | phone | from its device type | first boot, 27.0 s | about 0.15 GB, to measure (E24) |
| iPad Pro 13-inch (M5) | ios | tablet | 2064x2752 | first boot, 67.7 s; hardware encoder at its size | about 0.15 GB, to measure (E24) |
| Pixel 8 (default) | android | phone | 1080x2400 at 420 dpi | stream, input, controls, boots | about 4.5 GB: 2.0 GB data, 2.5 GB snapshot memory |
| Pixel Fold | android | foldable | outer 1080x2092; inner 2208x1840 | fold, posture, boot 17.1 s; stream not yet (E17) | about 4.5 GB, to measure (E24) |
| Pixel Tablet | android | tablet | 2560x1600 | boot 17.4 s; stream not yet (E17) | about 4.5 GB, to measure (E24) |

Each image's own cost is under [Images](#images). Each further model is a
row in the table and a line in the image's build. The image's check fails
when a model's pixels differ from the table's, so a frame never fits the
wrong screen.

### A device box's state

```ts
interface Geometry {
  readonly generation: number;           // up by one at each change of screen, orientation or video size, and at each switch
  readonly physical: Orientation;        // how the device is held: what rotate sets
  readonly content: Orientation;         // how the app in front draws, read from the device
  readonly video: { readonly width: number; readonly height: number };  // the stream's pixels now
}

type FoldGeometry = Geometry & { readonly screen: "outer" | "inner" };

type FailureCode = "boot-failed" | "device-exited" | "companion-failed" | "emulator-failed" | "firewall-missing" | "incompatible";

type Power =
  | { readonly is: "booting"; readonly since: number }
  | { readonly is: "booted"; readonly awake: boolean }
  | { readonly is: "switching"; readonly to: string; readonly step: SwitchStep; readonly since: number }
  | { readonly is: "stopped" }
  | { readonly is: "failed"; readonly error: { readonly code: FailureCode; readonly words: string }; readonly since: number };

type Observed<T> =
  | { readonly known: true; readonly value: T; readonly at: number; readonly by: "bb-box" | "outside" }
  | { readonly known: false; readonly why: string };

interface Override<T> { readonly set: T | null; readonly at: number | null }   // what bb-box last set; null: the device's own

type DeviceState =
  | { readonly platform: "ios"; readonly model: string; readonly power: Power; readonly geometry: Geometry | null;
      readonly settings: IosSettings; readonly at: number }
  | { readonly platform: "android"; readonly form: "phone" | "tablet"; readonly model: string; readonly power: Power;
      readonly geometry: Geometry | null; readonly settings: AndroidSettings; readonly at: number }
  | { readonly platform: "android"; readonly form: "foldable"; readonly model: string; readonly power: Power;
      readonly geometry: FoldGeometry | null; readonly posture: Observed<Posture>; readonly settings: AndroidSettings; readonly at: number };

interface IosSettings {
  readonly appearance: Observed<"light" | "dark">;
  readonly textSize: Observed<IosContentSize>;                // "large" is iOS's default
  readonly location: Override<LatLon>;                        // simctl cannot read it back
  readonly statusBar: Override<IosStatusBar>;
}

type IosStatusBar = { readonly clean: boolean; readonly battery: { readonly level: number; readonly charging: boolean } | null };

interface AndroidSettings {
  readonly appearance: Observed<"light" | "dark">;
  readonly fontScale: Observed<AndroidFontScale>;             // 1 is Android's default
  readonly location: Observed<LatLon | null>;                 // gRPC getGps reads it back
  readonly battery: Observed<{ readonly level: number; readonly charging: boolean }>;  // the device's battery API sees it
  readonly network: Observed<NetworkPreset>;
  readonly statusBar: Override<"clean">;
}

type NetworkPreset = "online" | "offline" | "slow";
interface LatLon { readonly latitude: number; readonly longitude: number }
type IosContentSize = "extra-small" | "small" | "medium" | "large" | "extra-large" | "extra-extra-large"
  | "extra-extra-extra-large" | "accessibility-medium" | "accessibility-large" | "accessibility-extra-large"
  | "accessibility-extra-extra-large" | "accessibility-extra-extra-extra-large";
type AndroidFontScale = 0.85 | 1 | 1.15 | 1.3 | 1.5 | 1.8 | 2;
```

What each shape rules out:

- **Posture** is a field of the foldable arm only, and the foldable arm is
  Android only. A phone cannot carry one, and iOS cannot fold.
- **The screen** a foldable shows is in its geometry: the outer when
  closed, the inner half open and open. A flat device's geometry has no
  screen to name.
- **An error** exists only on a failed device, and a failed device always
  has one. A booted device says whether it is awake, so a locked Android
  phone, which sends no frames, is shown as asleep, not frozen.
- **Network** is an Android setting only. iOS has no network control in v1,
  and its state has no field that would claim one.
- **On iOS, battery is part of the status bar override,** as `simctl
  status_bar override` makes it. Setting the status bar live clears the
  battery too, and the state shows both cleared. The answer says so: "The
  status bar is live again, so the battery shows the Mac's."
- **What bb-box set and what the device shows are apart.** A setting the
  device can report is `Observed`, with who changed it last: `outside`
  when it differs from what bb-box last set, as after `adb shell settings`
  in `box_run`. A setting the device cannot report is an `Override`: what
  bb-box set, and nothing more is claimed.
- **Text size keeps each platform's own steps.** iOS's content size
  categories and Android's font scale do not scale text alike, so the
  state and the answers name the platform's own step, such as
  "accessibility-large" or 1.3. The toolbar's larger, smaller and default
  move between them on either.

Rotation has two meanings, kept apart. `physical` is how the device is
held, which bb-box sets. `content` is how the app in front draws, which the
device decides: on a phone turned sideways, Android's launcher stays
upright. Both are counted from the screen's own upright, not named
portrait or landscape: the Pixel Tablet's upright is landscape, and a
foldable's inner screen is wider than tall. People and agents see words:
"upright", "turned left", "upside down", "turned right".

Where each part lives, with one writer each:

| Data | Lives in | Written by | Read by |
| --- | --- | --- | --- |
| The model table | code, `src/core/device-models.ts` | bb-box | everything |
| The devices an image offers, as `OfferedDevice`s | the image record's `devices`: `/usr/share/bb-box/image.json` on Linux, `/usr/local/share/bb-box/image.json` on macOS; and the backend's own copy of the record | the image build | the backend's `kinds()`, box_list, acquire, the doctor |
| What the box should run, and any switch under way | the server's intent file, `~/.bb-box/device/intent.json` in the box | the device server, written whole and renamed into place | the device server at start |
| `DeviceState` | the server's state file, `~/.bb-box/device/state.json`; the plugin keeps the last it heard in memory | the device server | the plugin, every viewer |
| A box's platform, model and runtime, for lists | the box record's new `device` field: a copy | the plugin, from each `BB_DEVICE_HELLO` and `BB_DEVICE_STATE` | box_list, box_status, spares, the panel's lists |
| How the tab shows it: fit, frame on or off | the tab's local storage, per box, as the stream choice is | the viewer | the viewer |

The device server is the one writer of what a box runs. The box record's
`device` is a copy, never a second truth: when the two differ, the server's
wins, and the plugin updates the record. An acquire or a switch asks the
server, and the record changes only once the server answers.

The server reads back what can change behind it: geometry at once, from
each frame's size and the device's reported orientation; the rest when a
client connects, after each control, and every 10 s while a viewer
watches. How long a read takes is measured in units 6.2 and 6.3; the notes
timed setting each value, not reading it.

### Controls: one union

```ts
type DeviceControl =
  | { readonly action: "home" }
  | { readonly action: "back" }
  | { readonly action: "recents" }
  | { readonly action: "lock" }
  | { readonly action: "wake" }
  | { readonly action: "rotate"; readonly turn: "left" | "right" }       // a quarter turn from where it is
  | { readonly action: "rotate"; readonly to: Orientation }              // to one orientation
  | { readonly action: "posture"; readonly to: Posture }
  | { readonly action: "appearance"; readonly to: "light" | "dark" }
  | { readonly action: "text_size"; readonly to: "larger" | "smaller" | "default" | IosContentSize | AndroidFontScale }
  | { readonly action: "location"; readonly to: LatLon | null }
  | { readonly action: "status_bar"; readonly to: "clean" | "live" }
  | { readonly action: "battery"; readonly to: { readonly level: number; readonly charging: boolean } | null }
  | { readonly action: "network"; readonly to: NetworkPreset }
  | { readonly action: "install"; readonly paths: readonly [string, ...string[]] }
  | { readonly action: "switch"; readonly device: string }
  | { readonly action: "reboot" };
```

A control is checked against the box's model before it is sent, by one
function, `supports(model, control)`, which reads the model's arms: posture
on a flat model, back on iOS and a font scale on iOS are refused there,
with one set of words. The toolbar, `box_device` and the server all call
it. What each platform does for each, from the notes' control tables:

| Action | iOS | Android |
| --- | --- | --- |
| home | idb HOME button: 315 ms by its CLI, seen | gRPC `GoHome`: 2 ms, seen |
| back | refused: iOS has no back button | gRPC `GoBack`: 1 ms, seen |
| recents | refused: no command found, only Device Hub's menu | `KEYCODE_APP_SWITCH`: 11 ms, seen |
| lock | idb LOCK: 359 ms, seen | `KEYCODE_POWER` when awake: 25 ms, seen |
| wake | idb HOME, twice if the lock screen shows | `KEYCODE_POWER` when asleep; the image has no lock screen |
| rotate | idb `ui rotate`: 198 to 364 ms; the stream turns to 2622x1206 | gRPC `setPhysicalModel` ROTATION: under 1.5 s, seen in Settings, with auto-rotate on in the image |
| posture | refused: Xcode 27.0 has no foldable | gRPC `setPosture`: 2 to 4 ms; closed, half open, open. Tent and flipped are refused on the Pixel Fold, so not offered |
| appearance | `simctl ui appearance`: 140 ms, seen | `cmd uimode night`: 25 ms, seen |
| text_size | `simctl ui content_size`: 239 ms, seen | `settings put system font_scale`: 10 ms, seen |
| location | `simctl location set`, `clear`: 121 to 139 ms, accepted | console `geo fix`, gRPC `setGps`: 0 to 10 ms, read back |
| status_bar | `simctl status_bar override`, `clear`: 178 ms, seen | SystemUI's demo mode: not measured (E10); refused until it is |
| battery | the status bar's picture only, through `status_bar override`; the answer says the device's battery API is unchanged | console `power capacity`, `power ac`: 1 to 3 ms, seen in Settings |
| network | refused in v1 | the presets below, checked by an app's own requests (E22) |
| install | `simctl install`: not timed | `adb install -r`, or `install-multiple` for split APKs: not timed |
| switch | see [Switching](#switching) | see [Switching](#switching) |
| reboot | `simctl reboot`: 5.3 s | stop and boot cold: 16 to 18 s |

Android's network presets, each complete, so one call always lands in the
same state:

| Preset | Airplane mode | Wi-Fi, data | Speed | Delay |
| --- | --- | --- | --- | --- |
| online | off | on | full | none |
| offline | on | off | full | none |
| slow | off | on | `edge`: 473.6 kbit/s | `umts`: 35 to 200 ms |

Setting a preset sets every column, so `slow` then `online` leaves no
delay behind. E22 checks that an app's own request fails offline and is
slow on slow, not only that the settings read back.

Volume, Siri, the Action button, shake, erase, snapshots and audio are left
out of v1. idb sends no volume or Action button, shake was not looked at,
the device's sound is not streamed, and the rest are rare enough for
`box_run`.

### Input and coordinates

One coordinate space for everything: the video's pixels as the viewer
shows them now. The viewer's pointer, the agent's taps, a tree's frames and
a screenshot's pixels all use it, and each carries the geometry
`generation` it was made in.

- **The server owns the transform.** From `physical`, `content`, the
  active screen and the video's size, it turns a point into the device's
  own: points at the device's scale for idb, pixels in the emulator's own
  rotation for gRPC. Which space each takes after a rotation is E8.
- **A point from another generation is refused,** with `stale-geometry`,
  never mapped. An agent's screenshot, element references and coordinates
  from before a rotation, a fold or a switch are void after it. The tool
  says so: "The device turned since that screenshot. Take another."
- **Input waits for the new picture.** From a control that changes
  geometry until the first frame of the new generation, the server holds
  the person's touches and refuses the agent's with `stale-geometry`. A
  gesture under way when the geometry changes is ended where it is.

```ts
type DeviceInput =
  | { readonly type: "tap"; readonly at: Point }
  | { readonly type: "long_press"; readonly at: Point; readonly ms: number }
  | { readonly type: "swipe"; readonly from: Point; readonly to: Point; readonly ms: number }
  | { readonly type: "pinch"; readonly centre: Point; readonly from: number; readonly to: number; readonly ms: number }
  | { readonly type: "key"; readonly key: string; readonly modifiers: readonly ("shift" | "control" | "alt" | "meta")[] }  // W3C key names
  | { readonly type: "text"; readonly text: string };   // ASCII as keys; the rest pasted in batches

interface Point { readonly x: number; readonly y: number; readonly generation: number }

interface DeviceElement {
  readonly role: string;                  // button, text field, cell, image, static text...
  readonly identifier: string | null;     // Android's resource ID; iOS's accessibility identifier
  readonly label: string;
  readonly value: string | null;
  readonly frame: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly enabled: boolean;
  readonly focused: boolean;
  readonly can: { readonly tap: boolean; readonly edit: boolean; readonly scroll: boolean } | null;  // null where the platform does not say
  readonly children: readonly DeviceElement[];
}
```

Agents name keys one way, by W3C key name. The drivers map them: to HID
usages on iOS and to the emulator's key names on Android. No tool's
description names HID.

## Kinds and offers

| | `ios` | `android` |
| --- | --- | --- |
| Label | iOS Simulator | Android emulator |
| Host | macOS on arm64, a Tart VM | Linux on x86_64, a Proxmox QEMU VM where the host gives KVM (057) |
| Image | `bb-box-ios`, built on the Tart macOS image | a Proxmox QEMU template of its own, built on the Linux VM template (057), with no desktop |
| Commands | SSH, sh, as the box user with sudo | SSH, sh, as `box` with sudo |
| Displays | `device`, the device's video; `desktop`, the host's, for the person | `device` only |
| Computer use | the device, through the device server | the device, through the device server |
| Enrols | yes | yes, with Docker as other Linux boxes (041) |
| Sizes | the macOS presets; a device takes 1 to 1.5 GiB and half a core idle | 8 cores and 16 GiB by default, as measured for the phone; refused below 4 cores and 10 GiB. E17 may raise both for the tablet and the foldable |

- `KindCapabilities` gains `device`: the platform and the `OfferedDevice`s
  of an offer's image, or null. `KindInfo` gains the platform, which the
  panel names the kind by. `computerUse` stays Cua's and is null for both.
- `DisplayCapability` gains `shows: "desktop" | "device"`. A device display
  has `resizable: false` and no RFB partner.
- An offer has a model when its image's record lists it. An acquire with a
  `device` tries only offers that have it, as `features` narrow offers
  (041). An acquire with `on` (044) or `image` (049) is checked against
  that offer's or that image's record, not the standard offer's.
- A project image (049) may build on `ios` or `android`. It adds tools,
  such as a JDK for Gradle; it does not change the devices, which come from
  the standard image beneath it. Its check runs the device check too.
- An ios box takes one of a Mac's two macOS VM slots while it runs, as any
  macOS box does. A Mac that offers both kinds shares its slots between
  them.
- Android on a Mac (arm64 images under Tart's nested virtualisation) will be
  a kind of its own, `android-arm64`, as 040 gives arm64 Linux kinds of
  their own, since offers of a kind agree on their architecture.

### The host's desktop

- **iOS.** The person may open the host's desktop from the top bar, for
  Xcode. The agent's computer tools never drive it; its work on the host
  is commands. The Desktop view carries a line: "Do not open Device Hub
  here. It takes the device's clipboard, so pasting stops working. The
  device is in the Device view." The server also watches for Device Hub
  (`com.apple.dt.Devices`) every 5 s. While it runs, the device's state
  has a warning the panel shows, with Quit Device Hub. E20 checks whether
  Xcode's Run opens Device Hub, and whether a preference in the image
  stops it.
- **Android.** No host desktop in v1. The box is the Linux VM template's,
  with no X server, Selkies or Cua, so the emulator has the cores. A host
  desktop could come later as a feature, once measured beside a busy
  emulator.

## The device server

### One program, a driver per platform

`bb-box-device` is TypeScript run by the box's own Node: Homebrew's Node 24
in the Tart image, and the pinned Node in Linux images. It has no npm
dependencies. It speaks gRPC with Node's `http2` and a small protobuf codec
for the messages it uses, tested against the field numbers of the pinned
`.proto` files: idb's, and the emulator's `emulator_controller.proto`.
Unit 2.2 proves the codec against both before any driver is built on it.

Why not Swift or Go: Node is in both images now; the server shares
`src/core/device.ts` with the plugin, so the protocol cannot drift between
them; and the plugin can deliver it, as below, with no image rebuild for a
change.

Inside it, one interface, one implementation per platform, and one for
tests:

```ts
interface DeviceDriver {
  attach(target: OfferedDevice, signal: AbortSignal): Promise<"reattached" | "booted">;  // reattach to a running device, or boot it
  shutdown(signal: AbortSignal): Promise<void>;
  video(): VideoSource;
  touch(contacts: readonly Contact[]): Promise<void>;   // every contact now down, in the device's own space; empty lifts all
  key(key: string, down: boolean): Promise<void>;
  setClipboard(text: string): Promise<void>;
  clipboard(): Promise<string>;
  control(control: DeviceControl, signal: AbortSignal): Promise<void>;
  screenshot(): Promise<Uint8Array>;                    // PNG at the stream's pixels
  tree(): Promise<readonly DeviceElement[]>;
  readBack(): Promise<Partial<DeviceState>>;
}

interface VideoSource {
  frames(): AsyncIterable<EncodedFrame>;                // whole H.264 access units, only when the screen changes
  keyframe(): void;                                     // the next frame is an IDR with SPS and PPS, even on a still screen
}

interface EncodedFrame { readonly data: Uint8Array; readonly key: boolean; readonly generation: number; readonly monotonicMs: number }
```

| | iOS driver | Android driver | Test driver |
| --- | --- | --- | --- |
| Device | `simctl boot`, `shutdown`, `bootstatus`; reattaches to a booted device of the target's UDID | the emulator in its own user service, `bb-box-emulator@<avd>`, `-no-window -gpu swiftshader_indirect -grpc 8554 -grpc-use-token`; `adb emu kill` saves the snapshot; reattaches to a running emulator found by a discovery file whose process is alive | none |
| Frames | idb_companion's `video_stream`, H.264, encoded by VideoToolbox in the box | gRPC `streamScreenshot` RGB888 at the device's size, given width and height both; encoded by `bb-box-h264` | a test card, drawn and encoded in the server's own process |
| Key frame on demand | idb's, if E5 shows it gives one on a still screen; otherwise the stream is restarted, which gave its first frame in 61 ms on a warm companion | the helper encodes the last raw frame again as an IDR | encodes the card again |
| Touch, keys | idb's HID stream, opened when a person takes control or the agent sends its first input, as the first tap after the companion starts took 578 ms | gRPC `sendTouch`, `sendKey`, held open | recorded, for tests |
| Clipboard | `simctl pbcopy` with `LANG=en_US.UTF-8`, `simctl pbpaste` | gRPC `setClipboard`, `getClipboard` | recorded |
| Tree | idb `describe-all`, 18 ms | `uiautomator dump`, 1.9 s, until a server in the device answers sooner (unit 7.3) | a fixed tree |
| Screenshot | idb, 22 ms | gRPC `getScreenshot` PNG, 80 ms | the test card |

The test driver lets the shared path, the plugin, the relay and the viewer
be built and checked on any Linux box or Mac with no emulator or simulator.
It is offered as a model, "Test device", on linux, linux-desktop-cpu and
macos boxes when the advanced setting `test-device` is on, which is off by
default. The conformance suite (009) turns it on, so every backend's
device path is checked; the suite's device cases run on real device kinds
too wherever an offer has a device, as below.

`bb-box-h264` is about 200 lines of C, built in the Android image against
Ubuntu's libx264 where the operator's build has it, and against OpenH264,
with Cisco's binary as Windows uses it, where it has not. It reads frames, and a one-byte command to make the next
frame a key frame, and writes each access unit with its length first. An
H.264 byte stream from the ffmpeg command line has no frame boundaries,
which held each frame until the next began: 100 to 300 ms on a still screen
in the Android note's measurement. x264 runs as the note measured it:
`ultrafast`, `zerolatency`, 8 Mbit/s, 20 ms a frame at 1080x2400 on one
core. Every key frame carries SPS and PPS. Frames reach it by the
emulator's shared-memory transport (`MMAP`), which skips copying 7.8 MB a
frame through Node, if E6 shows that it pays; otherwise through a pipe.
Its licence is settled in [the owner's answers](#the-owners-answers).

### The stream

- **Bounded at every step.** Between the emulator and the encoder there is
  one slot: a raw frame not yet taken is replaced by a newer one, so at
  most two raw frames are held, about 16 MB for the phone and 23 MB for
  the tablet, whatever the encoder's speed. Raw traffic at 32 fps is about
  250 MB/s, so nothing queues it.
- **Each viewer is paced by the relay,** by acknowledged frames, as
  desktops are (056). A viewer that falls behind skips to the next key
  frame, which the server makes on request; other viewers are not held
  back.
- **The recorder** takes every encoded frame through a queue of at most 2 s.
  If it overflows, its segment ends and a new one starts at the next key
  frame, and the clip notes the gap.
- **A joining viewer, a returning hidden tab and a decoder reset** each ask
  for a key frame (`REQUEST_KEYFRAME`), and get one within a frame's time,
  still screen or not. A change of size starts a new generation, whose
  first frame is a key frame at the new size.
- **The encoder or idb's stream dies:** the server starts it again and
  sends a key frame. Viewers see one stall, under 1 s, checked by killing
  each in units 4.1 and 4.2.

### Where it listens and how bb-box reaches it

As `bb-box-stream` does (060):

- It listens on a unix socket, `~/.bb-box/device/device.sock`, in a folder
  only the box user can open. It has no TCP port. One server runs per box:
  it holds a lock (`flock` on `~/.bb-box/device/lock`), and removes a
  socket file left behind only once it holds the lock.
- bb-box reaches it with `bb-box-device connect` over the box user's SSH,
  the `device` display's command route. `connect` joins its stdin and
  stdout to the socket, starting the service first if it is not running.
  If the service manager has given up on it, `connect` says so in words,
  which the panel shows.
- A connection carries an HTTP upgrade, then WebSocket frames. The path
  says the client's role, as Selkies' does: `/device?role=viewer` for a
  viewer's video, `role=input` for the box's one input connection, which
  asks for no video, and `role=control` for the plugin's own requests.
- So the Selkies relay (056) carries a device's video and a person's input
  as it carries a desktop's: pacing by acknowledged frames, key frames on
  request, and input only from the viewer with control.
- **One control connection at a time, which holds the box's lease.** A
  plugin instance opens one per box on first use, and closes it after 10
  idle minutes, when the box stops, and when it is released. When a second
  instance connects, as during a reload (045), the later-started instance
  takes the lease, and the server tells the other `superseded` and closes
  its connection. Only the holder of the lease may deliver code, set
  control's owner, or start a recording.

### Messages

The Selkies subset, as bb-box-stream speaks it:

| From | Message | Meaning |
| --- | --- | --- |
| viewer | `SETTINGS`, `START_VIDEO`, `STOP_VIDEO`, `REQUEST_KEYFRAME`, `CLIENT_FRAME_ACK,<frame>` | video, as for desktops |
| input | `m,<x>,<y>,<buttons>,0` | a person's mouse: button 1 down is a touch at that point, moves are its moves, up ends it. Button 3 is a long press. With Alt held, a drag is a pinch: two touches mirrored about the screen's centre, and Alt itself never reaches the device |
| input | `m2,...` | the wheel and a trackpad's scroll: a swipe from the pointer of a twelfth of the screen per notch, notches within 100 ms joined into one swipe |
| input | `kd,<keysym>`, `ku,<keysym>`, `kr` | physical keys down and up, and all keys up. A keysym with no US key joins the text batch |
| input | `cw,<base64>` and the chunked forms | the person's clipboard, for the device's |
| server | `MODE websockets` | as Selkies |
| server | binary type 4 | an H.264 access unit, with its frame number |
| server | `clipboard,<base64>` | the device's clipboard, to the input connection only, which passes it to the viewer with control |

bb-box's own, each a verb, then one JSON value, as `BB_CURSOR` is a verb of
bb-box-stream's:

| From | Message | Meaning |
| --- | --- | --- |
| server | `BB_DEVICE_HELLO {protocol, version, platform, devices, state, lease}` | first, on every connection: the protocol and the server's version, the box's devices and the state |
| server | `BB_DEVICE_STATE {state}` | each change of `DeviceState`, to every connection |
| server | `BB_DEVICE_TOUCH {contacts, by}` | each touch, by the agent or a person, to viewers: those not in control draw it |
| server | `BB_DEVICE_STILL {png, generation}` | a still of the screen, to a viewer that asked for stills instead of video |
| input | `BB_DEVICE {id, type: "touch", contacts}` | a person's touches with more than one finger, from a touch screen |
| input | `BB_DEVICE {id, type: "text", text}` | committed text from the person: an input method's composition, a phone's keyboard, or Type text |
| control, input | `BB_DEVICE {id, type: "control", control}` | a `DeviceControl` |
| control | `BB_DEVICE {id, type: "input", input, owner}` | a `DeviceInput` from the agent, with the owner generation it was sent under |
| control | `BB_DEVICE {id, type: "owner", generation, holder}` | control's owner changed: `agent` or `person` |
| control | `BB_DEVICE {id, type: "screenshot"}`, `{type: "tree"}` | reads |
| control | `BB_DEVICE {id, type: "record", to: "start" or "stop"}` | box_record |
| control | `BB_DEVICE {id, type: "result"}` | the answer to an earlier request, asked for again after a lost connection |
| server | `BB_DEVICE_ANSWER {id, ok: true, state, ms, ...}` or `{id, ok: false, error: {code, words}}` | the answer to one request; a screenshot comes as base64 PNG, a tree as `DeviceElement`s |

Error codes: `unsupported` (this platform or model has no such control),
`unknown-device`, `bad-value`, `not-booted`, `busy` (another control or a
switch is under way), `stale-geometry`, `ambiguous` (two elements match a
reference), `outcome-unknown` (the server cannot tell whether a control
took effect; the answer gives the state read back), `superseded`, and
`failed` (the command's own words). The plugin adds `person-has-control`
before a request reaches the server. The words are the ones the agent and
the panel show.

The relay drops `BB_DEVICE` from a viewer without control, as it drops
input today. Controls from the person's toolbar come over the input
connection, so the same rule holds them.

## Operations and recovery

### Requests

- **Every request has an ID,** made by the client. The server keeps the
  answers to the last 200 requests. A request sent again with the same ID
  gets the first answer, or "in progress"; it is never done twice. So a
  lost reply never turns one rotate into two.
- **One control at a time.** Controls and switches run one after another;
  a control sent during a switch is refused with `busy`, in words. Reads
  run beside them. Input has its own queue.
- **Each control has a deadline:** 10 s for most, 120 s for a switch or a
  reboot, 300 s for an install. Past it, the answer is `outcome-unknown`
  with the state read back, so the agent reads where the device is rather
  than trying again.
- **A lost connection:** the client connects again and asks for the result
  by ID. If the server restarted meanwhile, it answers from its intent file
  (below), or with `outcome-unknown` and the state read back.

### Switching

A switch stops one model and starts another. The server writes its intent
before each step, whole, by renaming a new file into place:

```ts
type SwitchStep = "stopping" | "booting" | "waiting" | "streaming";

interface Intent {
  readonly target: string;                                      // the model the box should run
  readonly switching: { readonly id: string; readonly from: string; readonly step: SwitchStep; readonly since: number } | null;
}
```

1. **Stopping** the old model: on Android, `adb emu kill`, which saves its
   snapshot; on iOS, `simctl shutdown`.
2. **Booting** the new one: from its snapshot on Android; `simctl boot` on
   iOS.
3. **Waiting** for it to be ready: `sys.boot_completed` on Android,
   `bootstatus` on iOS, with a deadline of 120 s.
4. **Streaming** its first frame. Then `target` is the new model, and
   `switching` is cleared.

When the server starts with a switch in its intent, it looks at what is
running, never starting a second device: a booted simulator of either
model, or an emulator whose discovery file names a live process. Discovery
files of dead processes are deleted. It then carries on from that step.

If the new model does not come up by the deadline, the server boots the old
one again and answers: "Could not start the Pixel Fold: <words>. The Pixel
8 is back." Only if that fails too is the device `failed`.

Each model keeps its own apps and data. A switch shows the other model as
it was left, and the picker says so: "Apps are per device. Install your app
again on the Pixel Fold." A reboot keeps apps and data; a release loses
them with the box.

Switch times, end to end, to the first frame of the new model:

| | iOS | Android |
| --- | --- | --- |
| A model booted before in this box | shutdown (not timed) and 1.3 to 1.9 s to boot | 2.8 s to stop and save, and 2.2 to 3.9 s to boot from its snapshot: 5.0 to 6.7 s |
| A model booted once in the image, not in this box | shutdown and the boot E1 measures | as above, if the image's snapshot loads (E2); 2.8 s and 16 to 18 s cold if not |
| A model never booted | 14 to 68 s | not offered: every model is booted once in the image |

E16 times each, through to a frame the viewer has drawn.

### When things stop and start

| What happens | The device | The device server | Input held | A recording |
| --- | --- | --- | --- | --- |
| The server crashes | lives on: simulators under CoreSimulatorService, the emulator in its own service | back in about 1 s: the LaunchAgent sets `ThrottleInterval` to 1, as launchd's default waits 10 s; the systemd unit sets `RestartSec=1`, `StartLimitIntervalSec=60`, `StartLimitBurst=10`. After 10 crashes in a minute it stays down, and `connect` says why | lifted as the server starts: every touch up, every key up | its segment ends; a new one starts at the next key frame; the clip notes the gap |
| The device crashes | the server boots it once again; a second crash within 5 minutes leaves it `failed`, with Reboot device | stays up | lifted | as for a server crash |
| A connection ends: input, control, relay or SSH | lives on | stays up | every touch and key that connection held is lifted, and its queued input dropped | goes on |
| bb-box reloads, two instances at once (045) | lives on | stays up; the later instance takes the lease; the earlier is `superseded` | the relay's input connection ends, so its touches and keys are lifted; a person keeps control (045) | goes on |
| The server's code changes | lives on | updated only when no person has control and no recording runs, by the lease holder (below) | lifted, as for a crash | not touched: the update waits for it |
| The box stops and starts: a Tart suspend, a Proxmox hibernation | suspended with the VM | on resume it sees its monotonic and wall clocks part by more than 5 s, then sets the device's clock if it lags (E3, E4), opens idb's HID stream or the emulator's gRPC again, and sends a key frame | lifted on resume | ends at the stop; box_record says so |
| A spare is claimed after hours suspended | as above | as above, and E3 and E4 check it after 1 h and after 24 h | none | none |
| The VM restarts cold: `box_restart`, a resize by restart (061), a crash | before a restart it asks for, bb-box stops the device with its snapshot saved; after any restart the device boots again | starts with the VM, reads its intent, and boots `target` | none | ends; box_record says so |
| The emulator is killed with no snapshot saved | its next boot loads the last snapshot saved; what that keeps of apps installed since is E23 | as for a device crash | lifted | as for a device crash |

### Delivering the server's code

- **By version, not hash.** `src/core/device.ts` holds
  `DEVICE_SERVER_VERSION`, a whole number, and `DEVICE_PROTOCOLS`, the
  range of protocol versions the plugin speaks. A test fails when the
  server's files change and the version does not.
- **Only forward.** The holder of the lease delivers its server when the
  box's is older, or when the box's speaks no protocol the plugin can.
  Otherwise it uses the server it finds. So during a reload, the earlier
  instance never sends its older code back, as it holds no lease once the
  later one connects; and a bb-box rolled back to an older version
  replaces a server only if it cannot speak to it.
- **Never under a person or a recording.** A delivery waits while a person
  holds control or a recording runs, and the plugin log says so, as 045's
  does: "Box b-12's device server waits for version 7 until the person
  hands back control." It is tried again at each hand-back and each
  recording's end.
- **How.** The files go to `~/.bb-box/device/server/<version>/` through the
  command transport, about 100 KB. `current` is pointed at them, and the
  service restarted. Viewers see the box end their connection, and come
  back within 043's 5 s. The device stays booted.
- **Rollback.** The last version's folder stays. If the new one does not
  answer `BB_DEVICE_HELLO` within 10 s, twice, `current` points back, the
  version is marked bad for that box, and the plugin delivers it no more
  until a newer one. The doctor shows a box running a version marked bad.

### Fencing input

- **Control's owner has a generation.** The plugin tells the server each
  change of owner, with a number that only rises. The agent's input
  carries the generation it was sent under, and the server refuses input
  from an older generation, so input queued before a person took control
  never reaches the device.
- **Taking control stops the agent's input at once.** Queued input is
  dropped; a gesture under way is lifted where it is; a paste whose
  clipboard was set but whose paste key was not sent is abandoned, and the
  clipboard put back. A paste key already sent finishes, as it takes about
  0.1 s.
- **Hand-back, a switch and a server start** lift every touch and key.
- **Control belongs to the viewer, not to a display.** A person's tab that
  shows the device, then the host's desktop, then the device again keeps
  control throughout. Hiding one display's session to show the other is
  not the viewer going away, and starts none of 020's timers.

## Keeping the device's own ports closed

The rule: nothing outside the box reaches the device but through bb-box,
and if that cannot be ensured, the device does not start.

| What | How it is kept |
| --- | --- |
| The device server | the unix socket in a 0700 folder; reached only through the box user's SSH |
| idb_companion | `--grpc-domain-sock` in the same folder; no TCP port |
| The emulator's gRPC, 8554 | bound to loopback if the pinned emulator can be told to (E19). Otherwise on every interface, as now, and so behind the firewall below and a token. The token is made new at each start, and read by the server from that start's discovery file under `~/.android/avd/running/`, readable by the box user alone. It never leaves the box, and is never logged |
| The emulator's console and adb, 5554, 5555, and adb's server, 5037 | loopback, as each binds; the console's auth token file is kept, made per box |
| All of these | the firewall below |

The firewall:

- **A table of bb-box's own,** `inet bb_box_device`, so IPv4 and IPv6
  alike, with an input hook at priority -300, ahead of anything Docker or
  Tailscale writes. It drops 8554, 5554, 5555 and 5037 from every
  interface but `lo`. Docker and Tailscale manage their own tables and
  chains, never this one, so their rule changes leave it be. A container
  on `docker0` or a tailnet peer on `tailscale0` is not `lo`, and is
  dropped.
- **Fail closed.** A unit, `bb-box-device-firewall.service`, loads the
  table and checks it is there. The emulator's service `Requires` it and,
  before each start, checks the table again; without it the emulator does
  not start, and the device's state says why. The unit runs at every boot
  and resume, so there is no time after a boot when the port is open.
- **Checked live** in unit 3.1, and by the image's check: each port from
  another box, from a container in the box, and from a tailnet peer where
  the box has joined one (050), over IPv4 and IPv6, during boot and after
  an emulator restart; and gRPC calls with no token and a wrong token
  refused, from inside the box.

A container started with the host's network shares `lo`, and so reaches
the ports, with the token still needed. It is the agent's own, in the box,
as `adb` is. One trusted user still: the thread's agent and the person
share the box, and the agent may run adb or simctl, which can do anything
the server can. This is not a security boundary between them.

## The viewer

The owner's picture: the device, framed, in the middle of the panel, a
narrow bar of controls beside it.

```
+------------------------------------------------------------------+
| [iPhone 18 Pro v]  [Device | Desktop]   Take control  Type text  ... |
|------------------------------------------------------------------|
|                       .-----------.     [Home ]                  |
|                      |  .-------.  |    [Back ]  Android          |
|                      |  | video |  |    [Recnt]  Android          |
|                      |  |       |  |    -------                  |
|                      |  |       |  |    [Rot L]                  |
|                      |  |       |  |    [Rot R]                  |
|                      |  |       |  |    [Fold ]  foldables        |
|                      |  '-------'  |    -------                  |
|                       '-----------'     [Light]                  |
|                                         [Text ]                  |
|                                         -------                  |
|                                         [Shot ]                  |
|                                         [More ]                  |
+------------------------------------------------------------------+
```

Device and Desktop shows only on an ios box.

### Choosing a display

Today the plugin takes a box's first display as its RFB desktop, and finds
its video by looking for the first Selkies display. The panel keys its
kept sessions by box, viewer and protocol. Two Selkies displays on one box,
the host's and the device's, cannot be told apart that way.

- **A display is chosen by its ID** (`desktop`, `device`), in the route,
  in the panel's kept-session key, and in the relay's maps. The protocol
  is a property of the display, not how it is found.
- **Input and the clipboard go to one display:** the one the person's tab
  shows. Control stays one per box, covering both.
- **The viewer tells a device from a desktop** by `DisplayCapability.shows`.
  A device display draws the frame and toolbar; a desktop display draws as
  now.
- **A device display ignores** the `video` setting, the viewer's Show as
  VNC, and resizing to the panel: it has only video, at the device's own
  size.

### Where video cannot play

060 has not checked Safari, and the panel on a phone is Safari. A device
has no VNC to fall back to, and showing the host's desktop instead would
put a person's clicks on the wrong screen.

- **Where the browser has no H.264 decoding,** or the first frame does not
  decode within 3 s, the device display asks for stills: a PNG of the
  screen over the same connection when it changes, at most 5 a second.
  Above the frame: "This browser cannot play the device's video, so it
  shows a picture a few times a second." Touches and controls work as
  with video.
- **Never a black frame with no words.** While waiting for the first frame
  the screen shows the model's name and "Connecting".
- E18 checks Safari on macOS and on iOS in unit 2.3.

### The frame

- **Drawn by bb-box,** as SVG around the video's canvas, from the model's
  `Body` and `Screen`: a body with rounded corners, black glass of `bezel`
  pixels round the screen, the side buttons, and the screen's corners
  clipped to `cornerRadius`. No Apple or Google artwork.
- **Cutouts.** On iOS the frame draws the Dynamic Island over the screen,
  as Device Hub's chrome does; the framebuffer leaves it out. On Android
  the device draws its own cutout, so the frame draws none. Checked by eye
  per model in unit 6.1.
- **Per form and posture:**

| Form | Posture | Drawn |
| --- | --- | --- |
| phone | | one body, turned with the device |
| tablet | | one body, thinner bezel, turned with the device |
| foldable | closed | the outer screen in a phone body |
| foldable | open | the inner screen in one wide body, with a faint crease down the hinge |
| foldable | half open | as open, with the crease shaded, both halves flat and readable, and "Half open" under the frame |

- **Rotation.** The frame turns with `physical`. While the device turns,
  the last frame of video turns with the frame, as a real phone held
  sideways shows its old picture for a moment, and stays until the first
  frame of the new generation comes, however long the device takes: up to
  1.5 s on Android. The animation is 300 ms; if the new frame is later,
  the turned picture waits under a faint veil. Where `content` differs from
  `physical`, as the launcher upright on a phone held sideways, the video
  is drawn as the device draws it, turned within the frame, by the same
  transform the server uses for touches, so a tap lands where it is drawn.
- **Fold and unfold.** The inner screen's right half folds over the left in
  350 ms, then the outer screen fades in; unfolding is the reverse. The
  stream changes size mid-stream (1080x2092 closed, 2208x1840 open, as
  measured), and the old frame holds until the first new one comes.
- **Reduced motion:** with the browser's `prefers-reduced-motion`, both
  change at once.
- **Size.** The frame and toolbar fit the panel, the device's shape kept,
  and the screen is never drawn larger than its own pixels at the browser's
  pixel ratio. The More menu has Pixel for pixel, which scrolls, and Show
  frame, on by default.
- **Light and dark.** The device's body is graphite in both of BB's themes.
  In BB's dark theme the body has a 1 px light edge so it stands off the
  background; in the light theme, a soft shadow. The device's own
  appearance is separate, and is what the Appearance control sets.
- **Booting, asleep and failed.** While the device boots the screen is
  black, with the model's name and "Booting". An asleep device shows its
  last picture dimmed, with "Asleep" and Wake. A failed device shows its
  `error` and Reboot device.

### The toolbar

At most nine controls beside the frame, and a More menu. Each earns its
place by being frequent in testing an app, and either awkward with a mouse
or two or more taps deep in the device's own Settings. A control the
platform or model lacks is not drawn, so there are no disabled ghosts.

| Order | Control | Platforms | Why it is on the bar |
| --- | --- | --- | --- |
| 1 | Home | both | the commonest navigation; the home gesture is unreliable with a mouse. Device Hub and Android Studio both have it |
| 2 | Back | Android | Android's commonest navigation; an edge swipe with a mouse is unreliable |
| 3 | Recents | Android | switching apps; a swipe up and hold with a mouse is unreliable. iOS has no command for it |
| 4 | Rotate left | both | a layout check every app gets; a quarter turn |
| 5 | Rotate right | both | so turning back is one click, as both IDEs have. A design call, not measured |
| 6 | Fold | foldables | a popover: Closed, Half open, Open; the posture is what a foldable is tested for |
| 7 | Appearance | both | one click between light and dark; its icon shows which is on |
| 8 | Text size | both | a popover: smaller, larger, default, and the platform's step now |
| 9 | Screenshot | both | copies the device's own pixels as a PNG to this computer's clipboard; where the browser refuses the clipboard, downloads it |
| | More | both | Lock or Wake; Open link; Location (a few cities, or latitude and longitude, checked in range); Status bar: clean or live; Battery (level, charging); Network (Android); Show frame; Pixel for pixel; Reboot device, which says that it takes 5 to 18 s and keeps apps |

Left off: install (it needs a file in the box, which is the agent's work);
volume, Siri and the Action button (rare, and idb sends no volume); shake
(not checked); recording (the agent's `box_record`); snapshots (a later
decision).

- **Narrow panels.** With the panel under 480 px wide, or the device's
  screen under 280 px wide beside the bar, the bar goes below the frame as
  one row: Home, Back and Recents on Android, Rotate, Fold on foldables,
  and More, which takes the rest. Targets stay 44 px. On a phone's BB the
  row is the same.
- **Accessible.** Each control has a name, Appearance and Fold say which is
  on, popovers close with Escape and a click outside, and a change of the
  device's state is announced to a screen reader.
- **The device picker,** "iPhone 18 Pro" in the top bar, lists the kind's
  models for this box, and switches. A switch to a model not yet booted in
  this box warns that it may take a minute (iOS first boots, 14 to 68 s).
- **Device and Desktop** in the top bar, on an ios box only, shows the
  device or the host's desktop, each a kept session (037), so switching is
  instant.

### Control, hand-back and Type text

- **One control per box,** covering the device and the host's desktop, as
  one owner of input at a time (008). Take control and Hand back are the
  desktop viewer's own, in the same place.
- **A toolbar click takes control** when the viewer does not have it, as
  Take control does, and says so in the top bar: "You have control. Hand
  back when done." So a person changes the appearance in one click, not
  three. Screenshot does not take control: it sends the device nothing.
  On a touch screen, where there is no hover, the toolbar shows "Using a
  control takes control from the agent" once, under the bar, the first
  time.
- **Watchers see touches.** A viewer without control draws each
  `BB_DEVICE_TOUCH` as a 36 px translucent circle for 300 ms, so a person
  watching sees where the agent tapped. The viewer with control draws only
  its own pointer.
- **Typed keys** go as keys where a US keyboard has one. Committed text, from
  an input method's composition or a phone's keyboard, goes as one `text`
  message, in order with the keys around it. So Japanese typed through the
  browser's input method arrives whole.
- **Type text** (#1094) opens the same field as on desktops, and is the way
  the viewer suggests for long or non-English text. Its text goes as one
  paste.
- **Cmd+V or Ctrl+V** in the viewer pastes this computer's clipboard into
  the device, as on desktops. What the device copies comes back to the
  viewer with control: gRPC's clipboard on Android, and `simctl pbpaste`
  every 2 s while the tab has the focus on iOS, as Tart's desktops do
  (#464). The server's own pastes are not echoed back.
- **Two fingers.** With a mouse, Alt and drag pinches. On a touch screen, two
  fingers on the device are two touches.

### Text other than ASCII

Text with no US key, from the agent or the person, is pasted:

1. **Batched.** Characters are gathered until 150 ms pass with none, or a
   key that is not text comes, or 2,000 characters. Then they go as one
   paste, in order: a key typed after them waits for the paste.
2. **The clipboard is saved and put back.** The server reads the device's
   clipboard, sets its own text, sends the paste key, waits until the
   paste has landed, and puts the saved clipboard back. How long to wait
   is measured in E21; until then, 500 ms. While it does, the clipboard
   sync to the viewer is paused, so the person's computer never receives
   the server's text.
3. **iOS's Allow Paste is answered by the server.** The first paste into an
   app shows the alert, with Allow Paste as a button in the tree. After its
   own paste, the server looks for that alert for 1 s, and taps Allow Paste
   once if it is there. It never answers an alert it did not cause.
4. **Android's notice** ("pasted from your clipboard") shows once a batch,
   not once a character.

## Agent tools

### box_acquire, box_list, box_status and box_run

- `box_acquire({kind: "ios", device: "iPhone 18 Pro"})`. `device` is new:
  "For an ios or android box, the device it boots, from box_list, such as
  iPhone 18 Pro or Pixel Fold. Defaults to the kind's first." With
  another kind it is refused. A name no offer has is refused, with the
  kind's models listed. With `wait`, the answer comes once the device has
  booted, or after 120 s with "still booting", and says how long it took.
  The CLI's `bb box acquire` gains `--device`, and the New box form a
  device step for these kinds.
- `box_list`'s line for each device kind ends with its models: "Devices:
  iPhone 18 Pro (default), iPhone 17, iPad Pro 13-inch (M5)." A box's line
  names its device.
- `box_status` adds the device's line: model, runtime ("iOS 27.0, Xcode
  27.0" or "Android 15, API 35, Google APIs"), power, orientation, posture,
  appearance, text size, any warning, and the IDs for commands.
- `box_run` runs on the host, as on any box. On an ios box `simctl`
  commands may name the device as `booted`; on an android box `ANDROID_SERIAL`
  is set, so `adb` needs no `-s`. `BB_DEVICE_ID` holds the UDID or the
  serial on both.

### box_device

One action per control, so the toolbar and the agent do the same things in
the same words.

| Parameter | Type | For |
| --- | --- | --- |
| `box` | string | the box |
| `action` | `home`, `back`, `recents`, `lock`, `wake`, `rotate`, `posture`, `appearance`, `text_size`, `location`, `status_bar`, `battery`, `network`, `install`, `switch`, `reboot` | what to do |
| `turn` | `left`, `right` | rotate: a quarter turn from where the device is |
| `to` | string or number | rotate: `upright`, `turned-left`, `upside-down`, `turned-right`. posture: `closed`, `half-open`, `open`. appearance: `light`, `dark`. text_size: `larger`, `smaller`, `default`, or a step of this platform: an iOS content size such as `accessibility-large`, or an Android font scale such as 1.3. status_bar: `clean`, `live`. network: `online`, `offline`, `slow` |
| `latitude`, `longitude` | number | location: both, in range, or neither to clear it |
| `level`, `charging` | 0 to 100, boolean | battery: both, or neither for the device's own |
| `paths` | string array | install: on iOS one `.app` folder built for the simulator; on Android one `.apk`, or the split APKs of one app. In the box (box_copy puts them there) |
| `device` | string | switch: a model from box_list |

Each action takes exactly its own parameters. A parameter that belongs to
another action, half a pair, or a value out of range is refused with
`bad-value`, saying what the action takes. Rotate takes `turn` or `to`, not
both.

Answers say what happened, how long it took, and the state after it:
"Turned the iPhone 18 Pro left in 0.3 s. Now: turned left, 2622x1206,
dark, text size large, booted." Refusals:

| Code | Words, for example |
| --- | --- |
| `unsupported` | "iOS has no back button. Its actions are: home, lock, wake, rotate, ..." or "The Pixel 8 does not fold. The Pixel Fold does." |
| `unknown-device` | "This box has no Pixel 9. Its devices are: Pixel 8, Pixel Fold, Pixel Tablet." |
| `bad-value` | "text_size on Android takes larger, smaller, default or a font scale: 0.85, 1, 1.15, 1.3, 1.5, 1.8 or 2." |
| `not-booted` | "The Pixel Fold is still booting. Try again in a few seconds, or call box_status." |
| `busy` | "The box is switching to the Pixel Fold. Try again when box_status says it has booted." |
| `outcome-unknown` | "The connection to the box ended while turning the device, so bb-box cannot tell whether it turned. It is now upright. Read box_status before trying again." |
| `person-has-control` | "A person has control of this box's device. Wait for them to hand it back, or take it back with computer_take_control when they ask." |
| `failed` | the command's own words |

Install, in more detail:

- **iOS takes simulator builds only.** A `.app` built for the iOS
  Simulator SDK installs. An `.ipa`, or a `.app` built for devices, is
  refused: "This is a build for a physical iPhone. Build for the simulator,
  for example xcodebuild -sdk iphonesimulator, and install the .app."
- **Android takes APKs.** One `.apk`, or the split APKs of one app through
  `adb install-multiple`. An `.aab` is refused: "Android App Bundles do not
  install directly. Make APKs with bundletool build-apks --mode=universal."
- **The toolchain is the project's.** The ios image has Xcode. The android
  image has the emulator and platform-tools, not a JDK, Gradle or the
  SDK's build tools: a project adds them with its own image (049). The
  setup guide shows how.
- **During a person's control,** an install of an app the device does not
  have runs. One that would replace an installed app, which stops it if
  it is open, is refused with `person-has-control`.

The lead's sketch had `screenshot` and `open_url` too. They are left to the
computer tools, which already have both, so there is one way to each.

### Computer use on a device

On a device box the computer tools drive the device only, never the host.
The agent's work on the host is commands.

| Tool | On a device box |
| --- | --- |
| `computer_windows` | one window, ID 1, named after the model: "iPhone 18 Pro (device)". A system alert, such as Allow Paste, is inside it |
| `computer_observe` | the device's tree, as today's text: one element a line, references such as `e12`, with the identifier where the platform gives one |
| `computer_screenshot` | the framebuffer, at most 1568 px on its long edge, with its scale and geometry generation |
| `computer_act` click | a tap at the element's centre, or at x and y in the latest image |
| `computer_act` double_click | two taps 120 ms apart |
| `computer_act` right_click | a long press of 1.2 s, which opened the context menu on both platforms; the description says so |
| `computer_act` scroll | a swipe within the nearest scrollable element holding the target, or the screen's middle 80% where the platform does not say which scrolls: a fifth of that height per step, points every 16 ms, stopped when the picture stops moving |
| `computer_act` set_value | on an editable field only: a tap, select all, and a paste of the value. Refused on anything else, a slider included, with the words "Drag it with computer_act's drag instead" |
| `computer_act` key, `computer_type` keys | the key or chord, by W3C key name |
| `computer_type` text | ASCII as keys, with autocorrect off in the image; the rest pasted, as above |
| `computer_launch` app | an app by its bundle ID or package: `simctl launch`, `am start` |
| `computer_launch` url | `simctl openurl`, `am start -a android.intent.action.VIEW` |
| `computer_take_control` | as today |

- **References.** A reference is found again by its identifier first, then
  by role, label, and its place among its siblings, as 022 to 024 do for
  desktops. When two elements match, the action is refused with
  `ambiguous`, naming both. iOS gives a flat list; the server nests it by
  frames, which is only an approximation, so on iOS the identifier and the
  frame count for more than the nesting.
- **After an action** the tool waits until the screen has not changed for
  300 ms, at most 2 s, and answers with what changed, as on desktops.
- **Web pages** in Safari show only Safari's toolbar in the tree, so the
  agent uses screenshots there. On Android each tree takes 1.9 s until
  unit 7.3.

### What waits while a person has control

| The agent's call | While a person holds control |
| --- | --- |
| `computer_act`, `computer_type`, `computer_launch` | refused at once, in the device's words; input already queued is dropped |
| `box_device`, every action but `install` | refused at once, the same way |
| `box_device install` | runs for a new app; refused for one already installed |
| `computer_windows`, `computer_observe`, `computer_screenshot` | answer: reading the device sends it nothing |
| `box_record` | runs |
| `box_run`, including `simctl`, `idb` and `adb` | runs. bb-box cannot see input sent this way (`adb shell input`), and does not try |

Refused, not held: a call that waited for a hand-back would hold the
agent's turn for as long as the person tests, which may be minutes. This is
today's rule for desktops (038). The one difference from desktops is that
reads go on: on a desktop, taking control closes Cua's session, and a
device has no such session to close.

## Recording

`box_record` works on device boxes with the same actions, captions, clip
and 5-minute limit as on desktops (059):

- **The source is the device server's own stream,** not the host's screen:
  the device's own pixels, with no window, at the device's frame rate.
  `simctl io recordVideo` (54 fps busy) and `adb screenrecord` (12 fps
  busy, 3 minutes at most) are not needed.
- **A monotonic timeline.** Frames are stamped by the server's monotonic
  clock, so a wall clock set after a resume cannot move them. The events
  log gives the start and the stop in the same clock.
- **Segments.** The server copies its H.264 into `capture-<n>.mkv` under
  059's folder. Each segment starts with SPS, PPS and a key frame, which
  the server makes as the segment starts. A new segment starts at each
  change of the stream's size: a rotation, a fold. The log has each
  segment's size, orientation and posture, and every touch.
- **Still screens.** The server sends frames only when the screen changes,
  so a still stretch is a gap between frames. The clip holds each frame
  until the next, and the last frame until the stop. So a recording of a
  screen that never changed is a clip of its first frame for its whole
  length, and a long still end is kept, then cut as 059 cuts stillness.
- **No viewer needed.** Frames come while a recording runs, viewer or not.
- **Failures are honest.** A server restart, a device crash or a stop of
  the box ends a segment. The clip shows the gap with a caption, "The
  device restarted here", or ends early, and box_record's answer says
  what was lost. Release removes the folder, as 059 does.
- **Making the clip.** Each segment is decoded at 059's 15 fps. Each is
  placed, framed, on one canvas that fits the largest shape in the
  recording, at most 1600 px on its long edge. The frame is drawn by ffmpeg
  from the same `Body` and `Screen` numbers, with filters checked present
  in both the macOS and the Linux images' ffmpeg (059 records where they
  differ). Touches show as the viewer's circles.
- **Captions** sit in a band of the canvas above the device, or below it
  with `position: "bottom"`, so they never cover the app.

## Spares and ready times

- **A spare holds its device booted, and costs no memory while it waits.**
  An android spare is a hibernated Proxmox VM, as Linux and Windows spares
  are. An ios spare is a suspended Tart VM. That is new: today a Tart spare
  is a running box, and only Tart's warm VMs, which are not enrolled, wait
  suspended (032). Unit 7.5 changes the Tart backend so an enrolled spare
  can wait suspended, taking no VM slot.
- **By default, one ios and one android spare,** each kept on the first
  offer of its kind with room for it, and none where none has room. Room
  means: the host's free disk stays above its `reserve-disk-gib` with the
  spare's disk counted (E24 measures it: about 16 GiB of memory saved to
  disk for an android spare, and the VM's memory for an ios one); and on a
  Mac, a suspended VM's disk only, as it takes no slot. This is the kind's
  `spares` setting (032), per kind, not per host; its default is 1 for
  these two kinds, and an operator may set 0. The doctor says when a kind
  wants a spare and no host has room.
- **A claim** resumes the VM, checks the server's version, sets the
  device's clock, and, when the thread asked for another model, switches.
- **A spare from an older image build** is retired at claim and a new one
  made, as 049 retires stale builds. The Tart backend reads the spare's
  image record to tell, as it cannot today.
- **The default model** is the one a spare holds.

Expected time to a booted device:

| Path | iOS | Android |
| --- | --- | --- |
| A spare, its model | Tart's resume, then nothing (E4) | 4.1 to 5.0 s, as a hibernated Windows spare resumed (057), if the emulator survives it (E3) |
| A spare, another model booted before in this box | that, then a switch: the shutdown, and 1.3 to 1.9 s | that, then 5.0 to 6.7 s |
| A spare, another model booted once in the image | that, then a switch: the shutdown, and E1's boot | that, then 5.0 to 6.7 s if the image's snapshot loads (E2); 19 to 21 s if it boots cold |
| A new box | a clone and macOS's boot (13.6 s in 061), then the device: 1.9 to 13.1 s by E1, 32.2 s were it never booted | a clone and the VM's boot (8.3 s in 061), then 2.2 to 3.9 s from its snapshot if it loads there (E2), 16 to 18 s cold |
| Becoming a BB machine | 8 to 11 s more, unless a spare, which is enrolled ahead (032) | about 5 s more, unless a spare |

If E3 or E4 shows the device does not survive its VM's suspend, a spare
waits with its device shut down instead, and a claim boots it: the second
row's times.

## Images

Both are built, checked, refreshed and promoted as other images are (049):
a build in a box, a check, a trial, then promotion, keeping the last
working build.

| | iOS: `bb-box-ios` | Android: a Proxmox QEMU template |
| --- | --- | --- |
| Base | the Tart macOS image with Xcode 27, its iOS runtime (7.5 GiB, a cryptex) and the other runtimes it already has | the Linux VM template (057), with no desktop |
| Adds | idb_companion 1.7.7, 115 MB, from Meta's Homebrew tap, its bottle pinned by version and SHA-256, with its licence notice; each offered model created, booted once and shut down; the image record's `devices` | the SDK's command-line tools, emulator 37.2.12.0, platform-tools 37.0.1 and the Android 15 (API 35) Google APIs x86_64 system image revision 9, each pinned by URL and SHA-256 from Google's repository manifest in `setup/android/pins.json`; one AVD per model, each booted once and saved to its snapshot; `bb-box-h264`; the firewall unit; the image record's `devices` |
| Size added | about 0.6 GB: idb's 115 MB and about 0.15 GB a model, to measure (E24). Clones share the base on APFS, so the other runtimes cost nothing more | about 18 GB: 4.6 GB of SDK and about 4.5 GB a model (2.0 GB data, 2.5 GB snapshot memory), to measure (E24). A used device grows to 5 to 7 GB in its box |
| Build time added | each model's first boot: 27 to 68 s | 48 s to install, about 17 s to boot each model, 2.8 s to save it |
| Built by | `setup/tart/prepare-ios-image.sh`, on the macOS image | `setup/proxmox-qemu/build.sh android`, in a box of the Linux VM template |
| Refreshed | with the macOS image, after 30 days, by `bb box images refresh` (049) | monthly, in a box of the current build, as 054 refreshes Windows: the pins move with bb-box's releases |
| Licences | idb: MIT. Xcode's, accepted at build as now | the SDK's terms, accepted by `sdkmanager` in the build. Java is needed for `sdkmanager` and `avdmanager` at build only, and removed after. See [open questions](#the-owners-answers) |

The ios image is its own, not the macOS image itself, so macOS boxes do not
carry booted devices; it is a clone of the macOS image, so the iOS runtime
and Xcode are not stored twice.

What a build keeps and what it clears, so no two boxes share what should be
their own (049's sixth rule):

| | Kept | Cleared before capture |
| --- | --- | --- |
| iOS | each model's device, booted once and shut down; its keyboard preferences | the simulators' pasteboards; CoreSimulator's logs; Device Hub's preferences and any record that it ran; idb's state |
| Android | each AVD and its snapshot, booted with no account; `hw.keyboard = yes`; the settings below | `~/.android/avd/running/` and every discovery file; `~/.emulator_console_auth_token`; adb's keys (`~/.android/adbkey*`); the device's clipboard, cleared before each snapshot is saved; logcat |

Defaults in the image, so typing and pasting are predictable:

| Default | iOS | Android | Why |
| --- | --- | --- | --- |
| Autocorrect, predictions and smart punctuation off | the device's keyboard preferences, written before its first boot ends (E13) | Gboard's, set at build (E13) | on Tart, "Hello idb 123" typed as keys became "Hello IMDb 123" |
| A hardware keyboard | HID keys need none | `hw.keyboard = yes` in each AVD's `config.ini`, before its snapshot | with `no`, as `avdmanager` writes, keys never reached the device; changing it later voids the snapshot |
| Stylus handwriting off | | `settings put secure stylus_handwriting_enabled 0` | Gboard's "Try out your stylus" sheet took the typing |
| Auto-rotate on | | `settings put system accelerometer_rotation 1` | rotation by `setPhysicalModel` needs it |
| Device Hub never started | not opened at build; a preference that stops Xcode opening it, if E20 finds one | | it takes the device's pasteboard, and asks for the microphone at first launch |
| No window | no Simulator app | `-no-window` | the nested-virtualisation dialog sat over the screen; with the window open, the gRPC stream fell to 26 fps |
| Awake, no lock screen | the simulator does not lock | `svc power stayon true`, the longest screen timeout, no lock screen | a sleeping device sends no frames |
| Animations | on | on | apps are tested as people see them |

The image's check grows with the units:

- From units 3.1 and 3.2: each model boots from the image's state, its
  pixels match the model table, and the defaults above hold; on Android,
  the ports are closed as [above](#keeping-the-devices-own-ports-closed),
  and a clone's identity (adb key, console token) differs from the image's.
- From units 4.1 and 4.2: each model streams a frame and gives a key frame
  on demand.
- From units 5.1 and 5.2: a tap changes the screen, and Japanese text with an
  accented letter, pasted, arrives, with the clipboard put back.
- From units 7.1 and 7.2: the tree has elements, and a screenshot matches
  the stream's size.

An image that fails is not promoted, and the last one stays (049). Pinning
idb does not pin its fit with Xcode, the runtime and the server: the record's
`runtime` names all of them, and the doctor fails an offer whose
combination the check has not passed. If a new Xcode breaks idb, the macOS
image's refresh keeps building, and the ios image stays on its last good
build until idb catches up. Writing bb-box's own server on the same private
frameworks is a possible way out, not a proven one.

## Build phases

Phase 1 was the research. Each unit below is one builder's PR, on the
target OS's box: a Mac box for iOS, a Linux box with KVM for Android. Each
ends in a live check through BB, on a separate BB in a box with bb-box from
the unit's branch, with what it measured. Units side by side run in
parallel. Each unit brings what it introduces: the reference and the skill
text for each tool and parameter, the setup guide for each image, the
settings keys for each kind, doctor checks for what it needs from a host,
and conformance cases for what it adds. The "Also" column names them.

### Phase 2: foundations, before any device kind is offered

| Unit | Builds | Also | Live check | After |
| --- | --- | --- | --- | --- |
| 2.1 The data model and the kinds | `src/core/device.ts` and the model table; validators for every record and message; `supports`; the compile-time cases that must fail; `ios` and `android` in `KIND_INFO` with no offers; `KindCapabilities.device`; `DisplayCapability.shows`; the box record's `device`; box_acquire's `device` and `bb box acquire --device`, with their refusals | the kinds and tools reference; conformance cases for device capabilities, run where an offer has a device | on a separate BB: `box_acquire({kind: "ios"})` refused, naming no offer; `device` on a linux kind refused; box_list, box_status and the settings page unchanged for every other kind | |
| 2.2 The device server's life | `bb-box-device` with `connect`, the socket, its lock, the LaunchAgent (`ThrottleInterval` 1) and the systemd unit (`RestartSec=1`, its start limit); the protobuf codec, proved against idb's and the emulator's `.proto` files; HELLO, STATE, ANSWER; request IDs, deadlines and the intent file; the lease; delivery by version, deferral and rollback; the test driver with key frames on demand; the `test-device` setting | the setting's row; a doctor check of each box's server version; conformance cases on the test device | on a Linux box and a Mac box with the test device: the server killed and back within 2 s; a crash loop ending in words; a reload of bb-box with two instances delivering once; a delivery waiting while a person holds control, then made at hand-back; a version that never answers rolled back | 2.1 |
| 2.3 Display routing and the device display | displays by ID in the route, the kept-session key and the relay; input and clipboard per display, control per box; the device display as plain video, ignoring the video setting and VNC; stills where video cannot play; Device and Desktop | the desktops guide's section on device displays | a linux-desktop-cpu box with the test device: both displays together, switched for 2 minutes; input, clipboard, a hidden tab and a reconnect each reach only the display meant; with WebCodecs off, stills with their words, never the host; E18 | 2.2 |
| 2.4 The Android encoder and what devices cost | `bb-box-h264`, with key frames on command, and its tests; frames from the emulator to it, as E6 decides; the android kind's default and least sizes, from E17 | none outside the image yet | on a Linux box with KVM and the SDK installed by the research's script: E17, E6 and E7, each model, each number with its method | |

### Phase 3: the images

| Unit | Builds | Also | Live check | After |
| --- | --- | --- | --- | --- |
| 3.1 The Android template | `setup/proxmox-qemu/build.sh android` on the Linux VM template; the pins; the AVDs and snapshots; what is kept and cleared; the firewall unit, failing closed; the image record with each runtime and snapshot origin; the check; the monthly refresh | the proxmox-qemu `android-templates` setting; doctor checks for KVM, the template, its build's age and the disk it needs; the Android setup guide | the template builds and a refresh is promoted; a box from it boots each model from its snapshot, timed; the ports from another box, a container and a tailnet peer, IPv4 and IPv6, during boot and after a restart; no token and a wrong token refused; two clones' identities differ; E2, E13, E19, E24 | 2.1, 2.4 |
| 3.2 The iOS image | `setup/tart/prepare-ios-image.sh`; idb pinned with its notice; each model booted once; what is kept and cleared; the record with each runtime; the check | the tart `ios-image` setting; doctor checks for idb's version against Xcode's, and Device Hub not running; the iOS setup guide | a fresh box boots each model, timed (E1); typing "Hello idb 123" (E13); an app run from Xcode in the host, and whether Device Hub opens (E20); E24 | 2.1 |

### Phase 4: the drivers, and the kinds offered

| Unit | Builds | Also | Live check | After |
| --- | --- | --- | --- | --- |
| 4.1 The Android driver: boot, video, recovery | the emulator's service with its token; attach and reattach; frames through `bb-box-h264`; key frames; every row of [When things stop and start](#when-things-stop-and-start) on Android; the `android` kind offered on Proxmox QEMU where the host has KVM | the New box form's device step; the skill's text for device boxes; box_list and box_status lines | 060's harness through BB on each model: first frame, frame rate still and busy, CPU, memory; the encoder killed; the emulator killed; box stop and start; a cold restart; E3 after 1 h and 24 h suspended; E23 | 2.3, 3.1 |
| 4.2 The iOS driver: boot, video, recovery | idb_companion on its socket; attach and reattach; its frames and key frames; the same rows on iOS; the Device Hub watch; the `ios` kind offered on Tart | as 4.1, for iOS | the same harness through BB; idb's stream killed; box stop and start; E4 after 1 h and 24 h suspended; E5 | 2.3, 3.2 |

### Phase 5: touch, keys and shared control

| Unit | Builds | Also | Live check | After |
| --- | --- | --- | --- | --- |
| 5.1 Input, shared, and on Android | owner generations and fencing; lifting on every end; the wheel as a swipe; Alt and drag, and two fingers on a touch screen; committed text; batched paste with the clipboard saved and put back; touch echo to watchers; geometry generations and `stale-geometry`; all of it on Android | the desktops guide's device input section | E14 through BB, with and without a Gradle build running, and the first tap after a reconnect; a person taking control halfway through the agent's swipe and halfway through its paste; a reload while a person holds control; Japanese through the browser's input method, Arabic, an emoji, dead keys; a trackpad scrolling a list; a pinch on a phone's BB; E8, E21 | 4.1 |
| 5.2 Input on iOS | the HID stream, opened as control is taken; keys mapped from W3C names; paste through `simctl pbcopy`; Allow Paste answered by the server; pinch (E9) | | the same checks, with an `xcodebuild` running; the first tap after taking control quick, not 578 ms; E8, E9, E14, E21 | 4.2, 5.1 |

### Phase 6: the frame, the controls and box_device

| Unit | Builds | Also | Live check | After |
| --- | --- | --- | --- | --- |
| 6.1 The frame | the frame per form, posture and orientation; content drawn by the server's transform; fit, Pixel for pixel, Show frame; light and dark; rotation and fold animations held until the new frame; booting, asleep and failed screens | | screenshots of every model in both themes; rotation and fold driven by `adb` and idb in `box_run`, the animation's frame times; a tap after a turn landing where drawn | 5.1, 5.2 |
| 6.2 Android controls and box_device | the Android driver's controls and read-backs; network presets; the `box_device` tool with its parameters, refusals and `outcome-unknown`; `supports` for every Android action; the person's control refusal | the tools reference and the skill for `box_device` | every Android action by `box_device`, its effect seen or read back; each read-back's time; each font scale set and read back; a control sent twice by ID done once; E10, E11, E22 | 5.1 |
| 6.3 iOS controls | the iOS driver's controls and read-backs; battery as part of the status bar | | every iOS action by `box_device`, its effect seen; each content size set and read back; status bar live clearing the battery, in the answer's words; E11 | 5.2, 6.2 |
| 6.4 The toolbar | the toolbar, popovers, More menu, the narrow row and the device picker; a click taking control | the panel's guide | each control clicked on both platforms and its effect seen; a switch to a model not booted before, with its warning; at 360 px, 480 px and 200% zoom; by keyboard, by touch, and with a screen reader; the agent's `box_device home` refused while a person holds control | 6.1, 6.2, 6.3 |

### Phase 7: computer use, recording and spares

| Unit | Builds | Also | Live check | After |
| --- | --- | --- | --- | --- |
| 7.1 iOS computer use | the computer tools on the device: tree with identifiers, screenshot, act, type, launch; references by identifier, refusing ambiguous ones; scroll in its container; set_value on fields only; settling after actions | the computer tools reference for device boxes | an agent opens Settings, General, About by references, types a URL into Safari, scrolls a long list, sets a text field and is refused on a slider, and meets two rows with one label; each tool's time | 6.3 |
| 7.2 Android computer use | the same with `uiautomator dump` | | the same in Settings and Chrome; each tool's time, the tree's 1.9 s noted | 6.2; beside 7.1 |
| 7.3 Android's tree in tens of milliseconds | a UiAutomation server in the device: Appium's UiAutomator2 server (Apache-2.0), or one of bb-box's own run with `app_process` as scrcpy runs; it gives way to an app's instrumentation tests, and the dump is used while it does | | E12: tree times before and after; the same references found; an instrumentation test run beside it | 7.2 |
| 7.4 Recording | box_record on device boxes: the monotonic timeline, segments with key frames, still stretches held, gaps captioned, the frame drawn by ffmpeg on both OSes | the box_record reference for devices | a 60 s clip on each platform with a rotation and, on the Pixel Fold, a fold, and two captioned steps; a clip of a still screen; a long still end; no viewer open; the server killed mid-recording; E15 | 6.1 |
| 7.5 Spares and switching on claim | suspended enrolled Tart spares; hibernated android spares; the default of one each where a host has room; switching on claim; stale spares retired | the spares rows of the configuration reference; doctor words for a spare with no room | five claims of each path in [Spares and ready times](#spares-and-ready-times), on each platform, timed; a failed switch rolled back; E16, E24 | 4.1, 4.2, 6.4 |

## Experiments

| | What | Settles | Unit |
| --- | --- | --- | --- |
| E1 | A fresh Tart box from the ios image: time to booted, per model | the iOS ready time, and a switch to a model not booted in this box | 3.2 |
| E2 | An AVD snapshot made in the image build loads in a box, and on another host's CPU | whether a new android box boots in 2 to 4 s or 16 to 18 s | 3.1 |
| E3 | The emulator survives its VM's hibernation and resume, after 1 h and after 24 h: frames, gRPC, adb, the device's clock, held touches | whether an android box's stop and start, and an android spare, keep the device running | 4.1 |
| E4 | A booted simulator survives its Tart VM's suspend and resume, after 1 h and after 24 h: frames, HID, the clock | the same for ios | 4.2 |
| E5 | Each message of idb's video stream is one whole access unit; idb gives a key frame on request on a still screen, with SPS and PPS | whether the iOS driver needs a parser, and how it makes key frames | 4.2 |
| E6 | The emulator's `MMAP` frames to `bb-box-h264`, against RGB over gRPC through Node: CPU at the busy frame rate | how frames reach the encoder | 2.4 |
| E7 | x264 against OpenH264 in `bb-box-h264`: ms a frame at each model's size, and the picture at 8 Mbit/s | the encoder's cost under each licence choice | 2.4 |
| E8 | Which space each device takes touches in: all four orientations, an app locked upright, both screens of the Pixel Fold, half open, a downscaled agent screenshot, a turn mid-gesture | the server's transform | 5.1, 5.2 |
| E9 | idb's HID stream with two touches, for a pinch | whether iOS pinches from the viewer | 5.2 |
| E10 | SystemUI's demo mode for a clean status bar on Android 15 | whether Android has status_bar | 6.2 |
| E11 | Which way left and right turn on each platform | that the toolbar's arrows turn the way they point | 6.2, 6.3 |
| E12 | A UiAutomation server in the device against `uiautomator dump`; beside an app's instrumentation tests; back to the dump when it fails | Android's tree time | 7.3 |
| E13 | Autocorrect off by preferences, checked by typing "Hello idb 123" | the image's keyboard defaults | 3.1, 3.2 |
| E14 | Tap to screen through BB, on pixels decoded in the browser: 100 taps, median, 95th percentile and worst; gaps between frames; with a build running in the box, and on Android with the emulator pinned to its cores; the first tap after a reconnect | the device bar, below | 5.1, 5.2 |
| E15 | Segments decoded at 15 fps keep still stretches cut as on desktops | the recording's clip | 7.4 |
| E16 | Every path's time to a booted device and every switch's to its first drawn frame, five times each, with a failed switch | the ready-time and switch tables | 7.5 |
| E17 | The Pixel Fold closed, half open and open, and the Pixel Tablet, against the Pixel 8: frames a second busy, cores drawing, ms a frame in `bb-box-h264`, memory after 10 minutes' use; and two device boxes on one host | the android kind's sizes per model, and whether the tablet needs more than 8 cores | 2.4 |
| E18 | Safari on macOS and on iOS: whether WebCodecs decodes the device's H.264 at each model's size, and the stream plays | whether stills are Safari's way, or a fallback seldom seen | 2.3 |
| E19 | Whether the pinned emulator can bind its gRPC to loopback only | whether the firewall is the only wall, or the second | 3.1 |
| E20 | Whether running an app from Xcode in the host opens Device Hub, and whether a preference stops it | the iOS host desktop's warning and the image's default | 3.2 |
| E21 | How soon after a paste the clipboard can be put back on each platform without the paste reading the old text; Allow Paste found and answered | the paste's wait | 5.1, 5.2 |
| E22 | An app's own request fails offline, is slow on slow, and is quick again on online | that the network presets do what they say | 6.2 |
| E23 | What the emulator's next boot keeps when it was killed without saving its snapshot | what a crash of the VM loses | 4.1 |
| E24 | Disk, allocated and apparent: each image, a used device, a snapshot save, a hibernated or suspended spare, and a build and trial beside the current image | the sizes above, and the room a spare needs | 3.1, 3.2, 7.5 |

### The device bar

Devices are held to about 90 ms at the median from a tap to the screen
through BB, against 50 ms for desktops (060), and E14 reports the 95th
percentile and the worst beside it. The reasons:

- Most of it is the device's own time from a touch to drawing: 50 to
  60 ms in the box before any stream, on both platforms. No stream can
  remove it.
- The stream itself adds 1 to 2 ms on iOS and about 20 ms on Android,
  where the device has no hardware encoder.
- Device Hub's own window, captured, was slower: 86 ms in the box alone,
  before BB.
- The rest is BB's path, which desktops share: about 25 ms.

If E14 shows the median over 100 ms, or a 95th percentile over 150 ms on an
idle box, the unit stops and the lead decides.

## Changes to the brief

- **Switching is under 3 s only for an iOS model booted before in that
  box.** The brief said both platforms switch warm in under 3 s. Android
  takes 5.0 to 6.7 s end to end, stopping included. iOS takes the shutdown
  and 1.3 to 1.9 s for a device booted before in the same VM, 13.1 s for a
  clone of one booted once, and 14 to 68 s for a first boot. E1 and E16
  measure it, and the picker warns.
- **Refused, not held.** The brief said the agent's device input waits
  while a person holds control, as on desktops. Desktops refuse at once,
  and so does this. Reads go on, which desktops do not allow, and input
  already queued is dropped.
- **A toolbar click takes control.** The brief kept one owner of input.
  That stays; a click on a control now takes control as Take control
  does, rather than asking the person to take it first.
- **box_device** has `lock`, `wake` and `recents` added, and `screenshot`
  and `open_url` left to `computer_screenshot` and `computer_launch`.
- **The device server** is one program for both platforms, in TypeScript,
  delivered by the plugin by version. On iOS it fronts idb_companion,
  which the brief named as the stream.
- **No host desktop on android boxes in v1,** and on ios boxes the host's
  desktop is the person's only.
- **Spares** wait suspended or hibernated with the device booted, not
  running, so they hold no memory; one of each kind by default where a
  host has room.

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
- **Delivering the server whenever its hash differs.** Two plugin
  instances during a reload would each send their own.
- **A paste per character.** It replaces the device's clipboard each time,
  and shows Android's notice once a letter.
- **The host's Linux desktop on android boxes.** Xtigervnc, Selkies and Cua
  in a VM whose emulator already takes 7 of 8 cores when busy, for a need
  not yet shown.
- **Falling back to the host's desktop where device video cannot play.** A
  person's clicks would reach the wrong screen.

## Consequences

- A thread gets a phone, a foldable or a tablet, shown as the owner pictured
  it, which the agent drives through the tools it already knows, and
  records.
- Device video is over 060's desktop bar: about 80 to 90 ms from a tap to
  the screen through BB, most of it the device's own time.
- An Android device draws on the CPU: busy, the phone takes 7 of 8 cores
  and shows at most about 35 fps. The foldable open and the tablet have
  1.6 times its pixels, and E17 says what they cost; they may need more
  cores or show fewer frames. A host with both KVM and a GPU would lift
  this; none has both today.
- A build in the box competes with drawing: a Gradle build during a scroll
  will drop the frame rate. E14 measures by how much, and whether pinning
  the emulator to its cores helps.
- An ios box takes a Mac's macOS VM slot, so ios and macOS boxes compete
  for a Mac's two.
- The Android template is about 18 GB larger than the Linux VM template,
  and each model added costs about 4.5 GB more. A suspended or hibernated
  spare costs its memory again in disk.
- The device server's protocol moves with the plugin; the images change only
  for what they install.
- idb_companion rides on Apple's private frameworks. A new Xcode can stop
  the ios kind until idb follows; the last good image keeps it running
  meanwhile.
- adb and simctl in `box_run` can send input while a person holds control.
  bb-box's own tools cannot.
- Device boxes have no sound in v1.

## Defaults set by the lead

These answer the first draft's open questions. They are written into the
note above; the owner may still change any of them.

1. **Models:** iPhone 18 Pro, iPhone 17 and iPad Pro 13-inch (M5); Pixel 8,
   Pixel Fold and Pixel Tablet. iPhone 18 Pro and Pixel 8 are the
   defaults. The ios image grows by about 0.6 GB, the Android template by
   about 18 GB, about 4.5 GB a model.
2. **Spares:** one ios and one android by default, kept only where a host
   has room for them; none elsewhere.
3. **iOS network:** no control in v1.
4. **The host's desktop:** the computer tools drive the device only. A
   person may open an ios box's host desktop, with the warning about
   Device Hub. An android box has no host desktop in v1.
5. **The device bar:** about 80 to 90 ms from tap to screen through BB, for
   the reasons under [The device bar](#the-device-bar).

## The owner's answers

Given on 26 October 2026, to the questions the revision left open:

1. **Licences.**
   - **Android's encoder:** both. `bb-box-h264` uses x264 where the
     operator's own image build has built it from source, and OpenH264,
     with Cisco's patent-licensed binary as Windows uses it, where it has
     not. bb-box never ships an x264 binary. E7 measures OpenH264's cost,
     and the encoder in use is shown in the box's details.
   - **idb_companion:** Meta's pinned bottle in the ios image, with its
     notice. bb-box's own server only if idb falls behind Xcode.
   - **The Android SDK's terms:** the operator accepts them, as a step they
     confirm in the setup guide, and the template never leaves their
     install.

   Before bb-box is published with device boxes, the exact SDK and system
   image terms, x264's obligations for a helper built in the image, and the
   notices each image must carry are checked, with legal advice if the
   owner wants it.
2. **A toolbar click takes control,** as Take control does, and says so.
3. **The lead's defaults stand:** the first 6 models, spares where a host
   has room, no iOS network control in v1, the computer tools drive the
   device only, and about 80 to 90 ms from tap to screen as the device bar.

## Review answers

Two reviews read the first draft: one by Claude Fable 5.1 (F below) and one
by GPT-6 Astra (A below). Both said to build after changes. Where they
agreed, the note changed.

### Claude Fable 5.1

| | Finding | Answer |
| --- | --- | --- |
| F1 | Tablet and foldable performance is not measured; the kind's size rests on the phone | Changed. E17 measures them in unit 2.4, before the Android viewer; the kind's sizes come from it; Context and Consequences say what is not known |
| F2 | Delivery by hash fights itself across a reload; a restart breaks a recording | Changed. Delivery is by version, only forward, only by the lease holder, never under a person's control or a recording, logged as 045 does: [Delivering the server's code](#delivering-the-servers-code) |
| F3 | launchd's 10 s throttle, systemd's start limit, touches held when a connection drops, box stop and start | Changed. `ThrottleInterval` 1, `RestartSec=1` and a start limit that ends in words; touches lifted on every end; stop and start in [When things stop and start](#when-things-stop-and-start), checked in 4.1 and 4.2 |
| F4 | A paste per character clobbers the clipboard and floods prompts | Changed. Batched, the clipboard saved and put back, Allow Paste answered by the server: [Text other than ASCII](#text-other-than-ascii). Type text is suggested for non-English text |
| F5 | The device display has no fallback and no place in the video settings | Changed. It ignores the video setting and VNC, falls back to stills with words, and Safari is checked in 2.3 (E18) |
| F6 | Illegal states in the data model; iOS status bar and battery conflated; no runtime | Changed. Discriminated models and state, posture on foldables only, network Android only, battery inside iOS's status bar override, runtime on each offered device: [The data shape](#the-data-shape) |
| F7 | The host desktop can start Device Hub | Changed. A warning in the Desktop view, a watch with Quit Device Hub, and E20 for Xcode's Run and a preference |
| F8 | 2.1 is three units; doctor, docs, settings, forms come late; template build and refresh unplaced | Changed. 2.1 is split into 2.1, 2.2 and 2.3; each unit names its docs, settings, doctor and conformance; the template's build and monthly refresh are in 3.1 |
| F9 | Docker in the box can undo the firewall | Changed. A table of bb-box's own at priority -300, which Docker does not manage; checked from a container and a tailnet peer; the emulator does not start without it |
| F10 | The host desktop on android boxes is scope not asked for | Changed. No host desktop on android in v1; the template is the Linux VM template's |
| F11 | Licences left open; unused runtimes in the iOS image | Changed. Licences are an open question with options. The runtimes stay: the ios image is an APFS clone of the macOS image, so removing them from it saves nothing while the macOS image keeps them |
| F12 | Every toolbar control needs Take control first | Changed. A toolbar click takes control and says so; open question 2. `person-has-control` has device words |
| F13 | Smaller points: lock has no wake; three key vocabularies; Alt sent while pinching; auto-rotate; audio; suspended Tart spares are new; builds compete with drawing | Changed, each: `lock` and `wake` with `awake` in the state; W3C names for agents; Alt never sent while it pinches; auto-rotate on in the image; no sound in v1; unit 7.5 names the Tart backend change; builds measured in E14, with core pinning, and in Consequences |

### GPT-6 Astra

| | Finding | Answer |
| --- | --- | --- |
| A1 | The viewer cannot tell two Selkies displays apart | Changed. Displays by ID in the route, sessions and relay; input and clipboard per display; no fall-through to the host; unit 2.3 is this alone |
| A2 | The shared types allow illegal states | Changed. Discriminated arms, exact screen counts, posture on foldables only, lifecycle variants with an error only when failed, validators at every boundary, compile-time negative cases in 2.1 |
| A3 | No durable contract for switching and recovery | Changed. Request IDs and stored answers, deadlines, `outcome-unknown`, a written intent per switch step, reattach not restart, rollback to the old model, and the event table: [Operations and recovery](#operations-and-recovery). Stale sockets and discovery files are cleared |
| A4 | Refusing new input does not stop input in flight | Changed. Owner generations fence input; takeover drops queued input, lifts gestures and abandons an unsent paste; hand-back, switch and restart lift all; control belongs to the viewer across displays: [Fencing input](#fencing-input). Checked in 5.1 mid-swipe and mid-paste |
| A5 | The driver cannot ask for a key frame; no bounded queues | Changed. `VideoSource.keyframe()`, key frames with SPS and PPS, one raw frame slot, per-viewer pacing, a bounded recorder queue, encoder restart: [The stream](#the-stream). E5 asks idb for key frames on a still screen |
| A6 | Port protection is not fail-closed | Changed. A firewall unit the emulator requires and checks before each start; IPv4 and IPv6; all four ports; no and wrong tokens checked; a token per start; discovery files by live process; tokens and keys cleared from the image. E19 tries a loopback bind |
| A7 | No runtime identity, no gate for idb's private APIs | Changed. `OfferedDevice.runtime` names the runtime, Xcode or emulator and companion; the image's check grows to a real stream, tap, paste, tree and screenshot before promotion; the doctor fails an untested combination; the last good image stays. Our own server is named as unproven |
| A8 | Rotation needs physical, content and video geometry | Changed. `Geometry` has all three, an active screen on foldables and a generation; stale points are refused; input waits for the new frame; the animation holds until the frame comes; E8 covers every case named |
| A9 | Latency and capacity rest on the easiest case | Changed. The estimate is labelled provisional; E14 measures decoded pixels in the browser with the tail, under a build and after a reconnect; E17 covers the larger devices and two boxes on a host; a least size for the kind. Declined: a lower stream resolution as an automatic fallback in v1; too small a box is refused instead |
| A10 | Viewer input is less complete than claimed | Changed. Committed text apart from keys; the wheel as a swipe; Alt and drag, and two fingers on touch screens; right click as a long press; checked with a real input method, dead keys and a trackpad in 5.1 |
| A11 | The image contract is not complete enough for a refresh | Changed. A kept and cleared table; pins by URL and SHA-256; snapshot origin in the record; the record's path corrected; project images keep the standard devices; 049's trial and promotion; stale spares retired |
| A12 | The licence conclusions are not settled | Changed. Put to the owner as open question 1, with a check before publication. This note no longer says the SDK question is settled |
| A13 | State values claim more than the controls prove | Changed. `Observed` against `Override`, with `outside` changes; complete network presets checked by an app's requests (E22); iOS battery named as the status bar's picture; read-back times to be measured; each platform's own text-size steps. Geometry is read at once, not every 10 s |
| A14 | App installation advertises an unsupported case | Changed. Simulator builds only on iOS, with words for device builds; APKs and split APKs on Android, words for bundles; the toolchain is the project's image; replacing an installed app is refused under a person's control. Declined: a build-install-launch check in every unit; it is in the computer use units' checks through the agent's own work |
| A15 | Agent tools need stronger targeting and semantics | Changed. Identifiers and actionable flags in elements; ambiguous references refused; set_value on fields only; scroll within its container, stopping when still; settling after actions; relative `turn` against absolute `to`; parameters exactly per action; `outcome-unknown`. E12 covers instrumentation tests and the fallback |
| A16 | The phase plan understates dependencies | Changed. Foundations split into 2.1 to 2.3; the codec proved in 2.2; the helper in 2.4 before its image in 3.1; images after 2.1; drivers' read-backs before the frame; doctor, settings, guides, the form, the CLI and conformance named in each unit's Also. Conformance runs the test device everywhere, and real device cases wherever an offer has one |
| A17 | Recording needs an idle and failure contract | Changed. A monotonic timeline, a key frame with SPS and PPS per segment, still stretches held to the stop, gaps captioned, ffmpeg's filters checked on both OSes, and a live check of a still clip, no viewer and a server killed mid-recording. A server update waits for the recording |
| A18 | Switch times understated; app data not explained | Changed. End-to-end switch times, 5.0 to 6.7 s on Android; apps per device, said in the picker; a failed switch restores the old model; E16 times to a drawn frame |
| A19 | Storage and spares need admission rules | Changed. E24 measures disk, allocated and apparent, with builds and trials beside; a spare only where a host has room after its reserve; per kind, not per host. Declined in part: spares are on by default where there is room, as the lead decided, not opt-in |
| A20 | The toolbar needs a usability gate | Changed. Explicit narrow widths and a row of the most used; a check at 360 px, 480 px and 200% zoom, by keyboard, touch and screen reader; blocked controls explained without hover, and a click takes control; screenshot downloads where the clipboard is refused; Open link added to More; reboot and location say what they do |
