# Android emulator boxes

How bb-box could give a thread an Android emulator as a box: its screen
streamed into BB's panel inside a device frame, device controls beside it,
control shared between a person and the agent, adb for the agent, and
computer use on the device. Issue #161 asks for it.

Research, 26 October 2026: a note of what was known and measured then, not
the current design, which is in [the architecture](../architecture.md).
Not settled by a decision yet. It is the Android half of the device boxes
work; the other half is [iOS Simulator boxes](ios-simulator-boxes.md), and
the two share a data sketch.

Status: prototypes run and measured on a Proxmox QEMU VM with nested KVM.
Namespace's Linux KVM boxes were not tried: the workspace's one Namespace
machine was in use all session. A pool Mac was in use too. Checked with
Android emulator 37.2.12.0, platform-tools 37.0.1, and the Android 15
(API 35) Google APIs x86_64 system image, revision 9.

## Recommendation

1. **Stream:** read the emulator's own screen through its gRPC service
   (`streamScreenshot`), encode it to H.264 in the box, and speak 060's
   protocol, as `bb-box-stream` does on macOS and Windows. It gives the
   device's own pixels, needs no desktop and no app in the device, and is
   the quickest way measured: 58 ms from tap to an encoded frame in the
   box. scrcpy is the fallback, and the way for real devices later.
2. **Input:** touches and keys through the same gRPC service, one held
   connection per viewer. Text with no key on a US keyboard goes as a
   paste, through the emulator's clipboard.
3. **Controls:** every control the owner listed has a supported command,
   in gRPC, the emulator console or adb. Switching between phone, foldable
   and tablet in one device works only with the emulator's window open.
4. **Hosts:** Linux VMs with KVM: Proxmox QEMU now, Namespace's KVM boxes
   when tested. Not LXC boxes, Tart's VMs or Docker. A booted device boots
   again from its snapshot in 2 to 4 s; a spare box can hold one running
   for 5% of a core and about 5 GB of memory.
5. **Agent:** the computer tools read the device, not a window: its UI tree
   and its screenshots, through a server in the box. Today's computer use
   sees the emulator's window as one element.

Each is below with its numbers and what limits it.

## How it was measured

Prototypes are in [android-emulator-boxes](android-emulator-boxes/), with
the raw results in [results](android-emulator-boxes/results/):

- [install-sdk.sh](android-emulator-boxes/install-sdk.sh) installs the
  SDK's command-line tools, the emulator, platform-tools and a system
  image, accepting the SDK's licences with its own `sdkmanager --licenses`.
- [boot.sh](android-emulator-boxes/boot.sh) starts a device cold, from its
  snapshot, or wiped, with gRPC on port 8554, and times it to adb's
  `device` state and to `sys.boot_completed`.
- [probe.py](android-emulator-boxes/probe.py) starts one stream and times
  its first frame. It counts frames for 10 s with the screen still, then
  for 10 s while a loop in the device swipes the launcher's app list up and
  down (`input swipe`, 120 ms each). It then taps 12 times, 0.6 s apart,
  with Android's pointer location overlay on, which draws cross hairs at a
  touch, and times the first decoded frame that shows them. CPU is the
  emulator's process tree, and the stream's own processes, over each 10 s,
  as a share of one core.
- [controls.py](android-emulator-boxes/controls.py) drives each control
  and reads its effect back from the device.
- [input.py](android-emulator-boxes/input.py) and
  [keys.py](android-emulator-boxes/keys.py) time taps and keys by each
  path against the gRPC stream, and check what text arrives.

Tap to frame is measured in the box: from the touch leaving the client to
the frame decoded in the box. It leaves out BB's relay, the network and the
browser's decoding, which are the same as for any desktop's video: about
25 ms at the median through BB's server
([060](../decisions/060-every-desktop-streams-as-video-through-one-viewer.md)).
The decoder is given whole frames: an H.264 parser fed a byte stream holds
each frame until the next begins, which on a still screen added 100 to
300 ms that a real viewer, given framed messages, does not have.

Host: a linux-desktop-cpu box on Proxmox QEMU, 8 cores and 16 GiB, Ubuntu
24.04, on an AMD Ryzen Threadripper PRO 9975WX, with nested KVM. No GPU:
the emulator drew with SwiftShader (`-gpu swiftshader_indirect`). The phone
is a Pixel 8 profile, 1080x2400 at 420 dpi, with 4 cores and 2 GiB.

Clips and screenshots used as evidence are kept in the thread's storage,
not the repository.

## 1. Stream

| Way | First frame | Tap to frame, median (worst) | Idle | Busy | CPU besides drawing, busy | Picture | Needs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gRPC `streamScreenshot`, raw RGB | 148 ms | 50 ms (64 ms) | 0 fps | 35 fps | none measurable | 1080x2400, the device's pixels | nothing |
| gRPC, encoded with x264 in the box | 172 ms | 58 ms (67 ms) | 0 fps | 32 fps | 20 ms a frame to encode, about 0.65 of a core at 32 fps | 1080x2400 | an encoder |
| scrcpy 5.0.1, H.264 over adb, full size | 395 ms | 65 ms (88 ms) | 0 fps | 12 fps | in the guest | 1080x2400 | a 90 KB jar pushed to the device |
| scrcpy, half size | 257 ms | 52 ms (71 ms) | 0 fps | 32 fps | in the guest | 540x1200 | as above |
| `adb screenrecord`, H.264 | at the first change | not comparable, see below | 0 fps | 12 fps | in the guest | 1080x2400 | nothing |
| The emulator's window on the X desktop, x264 | 103 ms | 82 ms (125 ms) | 60 fps | 60 fps | 0.15 of a core | 388x862: the window on a 1920x1080 desktop | a desktop and the window |

Notes on the table:

- **Drawing is the cost.** With no stream at all, the swipe loop took
  6.9 cores, nearly all of it SwiftShader drawing 1080x2400 on the CPU; the
  phone idle took 5% of one. So the device made about 35 frames a second
  at most, and no stream can show more. The 60 fps of window capture is
  the same frames sent again.
- **gRPC sends only when the screen changes,** and costs the emulator no
  more than drawing does (6.1 to 6.4 cores busy with the stream, 6.9
  without, within noise). Raw frames are 7.8 MB each, so they must be
  encoded in the box; x264 `ultrafast`, `zerolatency` at 8 Mbit/s took 20 ms
  a frame on one core at the device's size. The emulator can also hand
  frames over shared memory (`ImageTransport` `MMAP`), which saves the
  copy; not tried. Asking for a smaller frame needs both `width` and
  `height`: `width` alone was ignored.
- **scrcpy and screenrecord encode inside the guest,** with Android's
  software encoders only (`c2.android.avc.encoder`; no hardware codec in
  the emulator). At full size they fight the drawing for the guest's 4
  cores and fall to 12 fps when busy. At half size scrcpy keeps up. scrcpy
  is Apache-2.0, and works the same with a real phone over USB or Wi-Fi.
- **screenrecord** sends a bare H.264 stream with no frame boundaries,
  and stops after 3 minutes unless told otherwise. Its 393 ms is mostly
  the parser waiting for the next frame, but a viewer has the same
  problem: it is a recorder, for `box_record`, not a stream.
- **Window capture** needs a desktop session, sees only the window's
  pixels on screen (a third of the device's here), and shows whatever is
  in the window: the emulator's toolbar sits beside it, and a dialog,
  "Emulator Running in Nested Virtualization", sat over the screen until
  closed. With the window open the gRPC stream got slower too: 65 ms and
  26 fps, as the window draws every frame as well.
- **The emulator's WebRTC bridge** (`rtc_service_v2.proto`, and
  `libandroid-webrtc.so` ships in the emulator) was not measured. BB's
  plugin routes carry only TCP, so WebRTC's media cannot reach the panel
  ([desktop streaming](desktop-streaming.md#what-bbs-plugin-api-allows)).
- **First frames:** gRPC sends the current screen at once. scrcpy starts
  its server in the guest with `app_process` and its encoder first.
- **A fold or a rotation** changes the frame's size mid-stream: gRPC gives
  1080x2092 when the Pixel Fold closes. The viewer already handles a size
  change, as for desktop resizes.

**Recommendation:** the emulator's gRPC screen, encoded in the box by a
small server of bb-box's own that speaks 060's subset, as `bb-box-stream`
does on macOS and Windows. It sends whole frames of the device's own
pixels, only when they change, and needs nothing inside the device. On the
box alone a tap takes 50 to 58 ms to reach an encoded frame; through BB,
expect about 80 to 85 ms, close to what the iOS note expects for the
simulator, and over 060's 50 ms bar for desktops.

**What limits it:**

- **Frame rate is the drawing, not the stream.** On the CPU, 1080x2400
  peaked at about 35 fps with 7 of 8 cores busy. A GPU (`-gpu host`) is
  the way to 60 fps, but no box here has both KVM and a GPU: the GPU
  desktops are LXC containers without `/dev/kvm`. Not measured.
- **The encoder:** x264 is GPL-2.0, as in the Linux desktops' Selkies
  images; OpenH264 is the BSD choice, as on Windows.
- **The gRPC port listens on every interface,** `[::]:8554`, with no
  authentication unless the emulator is started with `-grpc-use-jwt` or
  `-grpc-use-token`. A device box must start it with one of them, or keep
  the port from the box's network.

## 2. Input

Times are to the first changed frame on the gRPC stream, in the box.

| What | How | Time, median (worst) | Checked |
| --- | --- | --- | --- |
| Tap | gRPC `sendTouch`, pressure on then off | 49 ms (53 ms) | yes |
| Tap | `adb shell input motionevent DOWN` and `UP` | 56 ms (120 ms) | yes |
| Tap | scrcpy's control socket | same as gRPC on scrcpy's stream | yes |
| Drag, swipe, scroll | gRPC `sendTouch` at each new point every 16 ms, then off | as tap | yes: a list scrolled |
| Long press | gRPC touch held 1.2 s | as tap | yes: the launcher's app menu opened |
| Two fingers, pinch | one gRPC `TouchEvent` with two touches, identifiers 0 and 1 | as tap | yes: "P: 2/2" in pointer location, two slots in `getevent` |
| Keys on a US keyboard | gRPC `sendKey`, key down and up, by W3C key name | 64 ms (129 ms) | yes |
| Keys | `adb shell input keyevent` | 70 ms (155 ms) | yes |
| ASCII text | gRPC `sendKey` with `text`; `adb shell input text` | 64 to 70 ms a letter | yes |
| é, Japanese, Arabic, emoji | gRPC `sendKey` with `text` | | no: "héllo ñandú" arrived as "hllo and"; the rest not at all |
| é | `adb shell input text` | | no: a `NullPointerException` in the shell command |
| Any text, by paste | gRPC `setClipboard`, then the Paste key | 97 ms (171 ms) | yes: "日本語 🙂 مرحبا" arrived |
| Home, back, recents, volume, power | gRPC `sendKey` `GoHome`, `GoBack`, `AudioVolumeUp`; `adb input keyevent` | 1 to 25 ms for the command | yes |

What was seen:

- **Keys need `hw.keyboard = yes` in the device's `config.ini`.**
  `avdmanager` writes `no`, and then gRPC and console keys never reach the
  guest: `getevent` showed touches but no keys. Changing it voids the
  device's snapshot, so it belongs in the image.
- **A paste shows a notice,** "Settings Services pasted from your
  clipboard", for a few seconds, as Android 12 and later do.
- **Gboard's "Try out your stylus" sheet** opened once over the app after
  gRPC touches, and took the typing until closed. It did not come back
  after `settings put secure stylus_handwriting_enabled 0`. A device image
  should turn it off.
- **Pressure** in a gRPC touch is in the device's units: 100 shows as 0.1.

**Recommendation:** each viewer with control holds one gRPC connection to
the box's server, which holds the emulator's. Pointer down, move and up map
to touches in the device's pixels, scaled from the video's. Keys go by name.
BB's **Type text** field, and any character with no US key, go as
`setClipboard` and Paste. Two fingers from a mouse need a modifier, as in
Android Studio, where Ctrl and drag pinches.

**What limits it:** adb is open to the agent at any time, and `adb shell
input` is input like any other. The control rule for desktops cannot see
it.

## 3. Controls

Each was run against a booted phone or foldable. Times are the command's
own, from a held gRPC connection or an `adb` call.

| Control | Command | Time | Effect seen |
| --- | --- | --- | --- |
| Home | gRPC `sendKey` `GoHome`; `adb shell input keyevent KEYCODE_HOME` | 2 ms; 12 ms | yes: the launcher in front |
| Back | gRPC `sendKey` `GoBack`; `KEYCODE_BACK` | 1 ms | yes |
| Recents | `KEYCODE_APP_SWITCH` | 11 ms | yes |
| Rotate | console `rotate`; gRPC `setPhysicalModel` `ROTATION` (0, 0, ±90); `settings put system user_rotation 0..3` with auto-rotate off | under 1.5 s | yes, in Settings: `ROTATION_90` and `ROTATION_270`. The launcher stays portrait on a phone |
| Fold, unfold | console `fold`, `unfold` | 2 ms | yes: Pixel Fold 2208x1840 opened, 1080x2092 closed, device state `CLOSED` and `OPENED` |
| Posture | gRPC `setPosture` closed, half opened, opened; console `sensor set hinge-angle0 <degrees>` | 2 to 4 ms | yes: `HALF_OPENED` at 90 degrees. Tent and flipped are refused on the Pixel Fold profile |
| Dark mode | `adb shell cmd uimode night yes\|no` | 25 ms | yes |
| Font size | `adb shell settings put system font_scale 1.3` | 10 ms | yes |
| Display size | `adb shell wm density 480`, `wm density reset` | 51 ms | yes |
| Location | console `geo fix <lon> <lat>`; gRPC `setGps` | 0 to 10 ms | gRPC `getGps` read it back; not seen in an app |
| Battery | console `power capacity 15`, `power ac off`; gRPC `setBattery` | 1 to 3 ms | yes: `dumpsys battery`, and Settings said "80% - Charging rapidly" |
| Airplane mode | `adb shell cmd connectivity airplane-mode enable\|disable` | 29 to 59 ms | yes |
| Wi-Fi, mobile data | `adb shell svc wifi disable\|enable`, `svc data disable\|enable` | 11 to 23 ms | Wi-Fi yes; data not read back |
| Network speed and latency | console `network speed edge`, `network delay umts` | 1 ms | yes: 473.6 kbit/s, 35 to 200 ms |
| Screenshot | gRPC `getScreenshot` RGB; PNG; `adb exec-out screencap -p` | 16 ms; 80 ms; 160 ms | yes |
| Clipboard | gRPC `setClipboard`, `getClipboard` | 1 ms | yes, with emoji and Japanese |
| Brightness | gRPC `setBrightness` | 1 ms | read back |
| Power button | `KEYCODE_POWER` | 25 ms | yes: asleep |
| Switch phone, foldable, tablet | console `resize-display 0\|1\|2`; gRPC `setDisplayMode` | under 3 s | only with the window open, on the `resizable` profile: 1080x2400, 2208x1840, 1920x1200 at 240 dpi. Headless: "KO: Failed to resize display" |
| Switch device | stop this device, start another | 2.2 to 3.9 s from a snapshot; 16 to 18 s cold | yes |
| Snapshot | console `avd snapshot save <name>`, `load <name>` | 1.6 s; 1.4 s | yes |
| Reboot | `adb reboot` | | not run; a cold boot took 16 to 18 s |

**Recommendation:** controls run as commands in the box, gRPC first, then
the console and adb, never through the emulator's window. The panel's
toolbar offers home, back, recents, rotate, fold and posture on
foldables, dark mode, font size, location, battery, network, screenshot and
switch device. Switching by the `resizable` profile is quicker, but needs
the window, so a device box would run it on a hidden X display; one device
per profile, each with a snapshot, needs nothing more.

**What limits it:** whether `resize-display` can work headless in a later emulator, and
what an app sees of a posture beyond Jetpack WindowManager, were not
checked.

## 4. Hosts

| | KVM | Result |
| --- | --- | --- |
| Proxmox LXC box | no `/dev/kvm` | cannot run accelerated |
| Proxmox QEMU VM (`linux-kvm`), nested on AMD | yes | measured here |
| Namespace Linux (`linux-kvm`) | yes, by the architecture: a privileged container whose `/dev/kvm` every user may open | not tested: slot in use |
| Tart Linux VM, arm64 | no: "HYP mode not available" | cannot run accelerated as Tart starts it |
| Tart macOS VM | `kern.hv_support: 0` | cannot run accelerated |
| Pool Mac | Hypervisor.framework on the Mac itself | not tested: in use |
| Docker, microsandbox, Hetzner Cloud | no KVM in the box | not tried |

The Tart Linux VM ran on an M4-class Mac, which Apple's Virtualization
framework can give nested virtualization from macOS 15. Tart would have to
start the VM with it on. That is a change to bb-box's Tart backend, not
tried here. An arm64 VM would run the `arm64-v8a` system images.

Boot, on the Proxmox QEMU VM:

| | Time to `sys.boot_completed` |
| --- | --- |
| Phone, first boot | 16.9 s |
| Phone, cold again (after a config change voided its snapshot) | 16.3 s |
| Foldable, first boot | 17.1 s |
| Tablet (Pixel Tablet, 2560x1600), first boot | 17.4 s |
| Resizable, first boot | 17.7 s |
| Phone from its snapshot | 2.2 to 3.9 s |
| Stopping and saving the snapshot (`adb emu kill`) | 2.8 s |

Memory and CPU:

- A booted phone: 3.4 GB resident just after boot, 4.8 to 4.9 GB after
  use, with the device's RAM set to 2 GiB. The box used 5.8 GB of 16 GB.
- Idle, no viewer: 5% of one core. Busy scrolling: up to 7 cores on
  SwiftShader.

Disk:

- Download: about 2.0 GB (system image 1,658 MB, emulator 337 MB,
  platform-tools 9 MB). Installed: 4.6 GB (system image 3.5 GB, emulator
  863 MB, platform-tools 22 MB), plus a Java runtime for `sdkmanager` and
  `avdmanager` only. It took 48 s here.
- One system image serves phone, foldable and tablet.
- A device: 5 to 7 GB after use, mostly its user data (2.0 GB) and its
  snapshot's RAM (2.5 GB).

Warm devices: a spare box can boot its device at enrolment and hold it for
5% of a core and about 5 GB of memory, or keep its snapshot on disk and
start in 2 to 4 s. The snapshot is tied to the emulator, the system image,
the device's config and, it may be, the host's CPU, so whether one made
in an image build loads in a box on another host is not tested.

**Recommendation:** an `android` device box is a `linux-kvm` VM: Proxmox
QEMU now, Namespace's when measured. The image has the SDK, one system
image, a device per offered profile with `hw.keyboard = yes`, and a
snapshot of each booted once. Licences: the SDK's terms forbid passing it
on, so the image build downloads it with `sdkmanager` and accepts its
licences there, as Windows images fetch OpenH264.

## 5. Agent use

| What the agent gets | How | Time |
| --- | --- | --- |
| Screenshot, raw at the device's pixels | gRPC `getScreenshot` RGB888, held connection | 16 ms |
| Screenshot, PNG | gRPC `getScreenshot` PNG; `adb exec-out screencap -p` | 80 ms; 160 ms |
| UI tree, XML: class, text, resource ID, content description, bounds in pixels, clickable, focused | `adb exec-out uiautomator dump /dev/tty` | 1.9 s every time |
| The app's own views | `adb shell dumpsys activity top` | 10 to 20 ms, 92 KB |
| Tap, swipe, keys, buttons | gRPC, as in [Input](#2-input), or `adb shell input` | |
| adb itself | install, logcat, shell, `am`, `pm`, `cmd` | 5 ms a round trip |

What the tree gives: for Settings, 79 nodes in 30 KB, with labels such as
"Wi-Fi" and "Network & internet". On the launcher, each app's label and
bounds, so a tap can aim at its centre. A menu, such as the long press's
"App info", "Pause app", "Widgets", shows with its items. `uiautomator
dump` waits for the screen to be idle each time, which is most of its
1.9 s.

Today's computer use on a Linux desktop, pointed at the emulator's window
on the X desktop: `computer_observe` gave one element, the window, and the
toolbar beside it another, with no buttons. The agent would click pixels on
a scaled picture of the phone.

**Recommendation:** on a device box, the computer tools read the device:
`computer_observe` returns its UI tree, `computer_screenshot` its screen,
`computer_act` sends gRPC touches at an element's centre or a point in the
latest image, in the device's pixels. adb stays the agent's own, for
building, installing and logs. A tree in 1.9 s is too slow for each step:
a server in the device that holds a UiAutomation session, as Appium's
UiAutomator2 server (Apache-2.0) or scrcpy's `app_process` way of running,
should answer in tens of milliseconds. Not measured.

## A device box's data, a sketch

For the design note. It extends the sketch in the
[iOS note](ios-simulator-boxes.md#a-device-boxs-data-a-sketch); the
fields Android adds are marked.

```ts
type DeviceBox = {
  platform: "ios" | "android";
  device: {
    type: string;            // "pixel_fold", the profile's ID
    name: string;            // "Pixel Fold"
    form: "phone" | "tablet" | "foldable" | "resizable" | "watch" | "tv";
    runtime: string;         // "Android 15 (API 35), Google APIs"
    id: string;              // the AVD's name, inside the box
    serial?: string;         // Android: "emulator-5554", for adb
  };
  screen: {
    pixels: { width: number; height: number };   // 2208 x 1840 open, 1080 x 2092 closed
    density: number;                             // Android: dpi, 420
    scale: number;                               // density / 160 on Android, points on iOS
    cornerRadius?: number;
    cutout?: { x: number; y: number; width: number; height: number };
  };
  state: "booting" | "booted" | "shutting-down" | "shutdown" | "failed";
  orientation: "portrait" | "landscape-left" | "landscape-right" | "portrait-upside-down";
  posture?: "closed" | "half-opened" | "opened" | "tent" | "flipped";  // foldables
  postures?: DeviceBox["posture"][];                                   // what the profile allows
  displayMode?: "phone" | "foldable" | "tablet" | "desktop";           // the resizable profile
  settings: {
    appearance: "light" | "dark";
    fontScale?: number;                 // Android: 0.85 to 2.0
    contentSize?: string;               // iOS
    displayDensity?: number;            // Android: wm density
    location: null | { latitude: number; longitude: number };
    battery?: { level: number; charger: "none" | "ac" | "usb" | "wireless"; status: "charging" | "discharging" | "not-charging" | "full" };
    network?: { airplane: boolean; wifi: boolean; data: boolean; speed: "full" | "lte" | "umts" | "edge" | "gprs"; delay: "none" | "lte" | "umts" | "edge" | "gprs" };
    hingeAngle?: number;
  };
  devices: { type: string; name: string; form: DeviceBox["device"]["form"]; booted: boolean; snapshot: boolean }[];
};

type DeviceControl =
  | { id: "home" | "back" | "recents" | "power" | "volume-up" | "volume-down"; kind: "button" }
  | { id: "rotate-left" | "rotate-right"; kind: "button" }
  | { id: "fold" | "unfold"; kind: "button" }
  | { id: "posture"; kind: "choice"; choices: NonNullable<DeviceBox["posture"]>[] }
  | { id: "display-mode"; kind: "choice"; choices: NonNullable<DeviceBox["displayMode"]>[] }
  | { id: "appearance"; kind: "choice"; choices: ["light", "dark"] }
  | { id: "font-scale" | "display-density"; kind: "steps" }
  | { id: "location"; kind: "place" }
  | { id: "battery"; kind: "battery" }
  | { id: "network"; kind: "network" }
  | { id: "screenshot" | "record" | "reboot" | "snapshot-save" | "snapshot-load"; kind: "action" }
  | { id: "switch-device"; kind: "choice"; choices: string[] };
```

The panel draws the video inside a frame of the device's form, with the
controls in a narrow bar beside it, as Android Studio's running devices
view does. A foldable's frame changes with its posture: one screen closed,
two halves with a hinge open. The frame can be our own drawing, or the device frames Android Studio
draws, which are Google's artwork and were not looked at here.

## Open questions for the owner

1. **The stream server:** a small server of bb-box's own on the
   emulator's gRPC, as recommended, or scrcpy, which also serves real
   phones later but encodes in the guest, at half size to keep up?
2. **GPU:** a device box draws on the CPU, at most about 35 fps at
   1080x2400 for 7 cores. A GPU needs a host that gives a box both KVM and
   a GPU, which none here does. Is CPU enough for now?
3. **Switching profiles:** one device per profile, each with a snapshot,
   switched in 2 to 4 s, or the `resizable` profile, switched in under
   3 s but only with the emulator's window on a hidden display?
4. **A new kind or a panel on Linux boxes?** An `android` kind with the
   device as its display, or a device panel any `linux-kvm` box can open.
5. **Google Play images:** the measured image is Google APIs, with no Play
   Store. Play images need a Google sign-in for the store, which a box
   should not hold.
6. **adb and control:** the agent's adb can send input while a person holds
   control. Leave it, or refuse `input` through bb-box's own tools while a
   person has control?
7. **Tart nested virtualization:** turn it on in the Tart backend so Mac
   hosts can run arm64 devices?
8. **Untested hosts:** Namespace's KVM boxes and a pool Mac.

## Rerunning the measurements

On a `linux-kvm` box with a desktop, 8 cores and 16 GiB:

```sh
./install-sdk.sh
export ANDROID_HOME=~/android-sdk PATH=~/android-sdk/cmdline-tools/latest/bin:~/android-sdk/platform-tools:~/android-sdk/emulator:$PATH
for d in pixel_8:phone pixel_fold:fold pixel_tablet:tablet resizable:resizable; do
  echo no | avdmanager create avd -n "${d##*:}" -k "system-images;android-35;google_apis;x86_64" -d "${d%%:*}"
  sed -i 's/^hw.keyboard *=.*/hw.keyboard = yes/' ~/.android/avd/"${d##*:}".avd/config.ini
done
python3 -m venv ~/venv && ~/venv/bin/pip install grpcio grpcio-tools av numpy pillow psutil
mkdir -p ~/proto && (cd ~/android-sdk/emulator/lib && ~/venv/bin/python -m grpc_tools.protoc -I. --python_out=$HOME/proto --grpc_python_out=$HOME/proto emulator_controller.proto)
curl -fsSLo ~/scrcpy-server-v5.0.1 https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-server-v5.0.1
./boot.sh phone cold
adb shell settings put system pointer_location 1
~/venv/bin/python probe.py grpc-h264 --taps 12
~/venv/bin/python probe.py scrcpy --width 540 --taps 12
~/venv/bin/python controls.py --set phone
```

The scrcpy server's SHA-256 is
`764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536`. For
window capture, start the device with `WINDOW=yes` in the desktop session
and run `probe.py x11` there.
