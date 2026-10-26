# 063 results: what each Android device costs

The numbers unit 2.4 of [063](063-device-boxes.md) measured, so the
android kind's sizes, its encoder and the way frames reach the encoder come
from measurements: E17 (each model's cost), E6 (shared memory or a pipe)
and E7 (x264 or OpenH264). Unit 3.1's, for the Android template, are
[after them](#unit-31-the-android-template): E2 (snapshots in another VM),
E13 (typing), E19 (the gRPC port) and E24 (disk). Unit 3.2's, for the iOS
image, are [after them](#unit-32-the-ios-image): E1 (boot times), E13, E20
(Xcode's Run and Device Hub), E24, and its slimming. Unit 4.2's, for the iOS
driver, are [after them](#unit-42-the-ios-driver): E5 (idb's stream), the
stream of each model, recovery, slimming kept and turned off, Device Hub,
and E4 (a suspend). Units 5.1's shared parts and 5.2's, for input on iOS,
are [after them](#units-51-and-52-input-shared-and-on-ios): E8, E9, E14,
E21, and how iOS pastes. Unit 6.3's, for the iOS controls and box_device,
are [at the end](#unit-63-the-ios-controls-and-box_device): each action,
its read-back, requests by ID, and E11.

## How they were measured

With the harness in
[scripts/measure/android](../../scripts/measure/android/README.md), on
26 October 2026:

- **Host.** A linux-desktop-cpu box on Proxmox QEMU, 16 cores and 32 GiB,
  Ubuntu 24.04, on an AMD Ryzen Threadripper PRO 9975WX with nested KVM, as
  the [research](../research/android-emulator-boxes.md) used. No GPU: the
  emulator drew with SwiftShader (`-gpu swiftshader_indirect`), with no
  window.
- **Software.** Emulator 37.2.12.0, the Android 15 (API 35) Google APIs
  x86_64 image, each AVD made by `avdmanager` with 4 cores and 2 GiB and
  `hw.keyboard = yes`. `bb-box-h264` built by `setup/android/build-h264.sh
  --with-x264`: x264 0.165 from source at its pinned commit, and Cisco's
  OpenH264 2.6.0 binary. Both at 8 Mbit/s, one thread, constrained
  baseline.
- **A box's size, by pinning.** The emulator's every thread, the harness
  (Node) and the helper were pinned with `taskset` to the first 4, 8 or 12
  of the VM's cores, so they shared those cores as in a box of that size.
  [A real 8-core box](#a-real-8-core-box-and-two-boxes-on-one-host) checks
  that this holds.
- **Busy** is the research's load: `adb shell input swipe` up and down the
  launcher's app list, 120 ms each, without a pause. **Idle** is the home
  screen, still.
- **Frames** come from the emulator's gRPC `streamScreenshot` in RGB888,
  read by Node 24 with `node:http2`. Frames a second count frames received
  over each window; the emulator sends a frame only when the screen
  changes, so this is the device's drawing rate.
- **CPU** is from `/proc/<pid>/stat` over each window, in cores: the
  emulator's process tree, the helper, and Node. **Memory** is the
  emulator tree's resident set at the end of a run.
- **Encode ms** is the helper's own time for a frame, from reading its
  pixels to writing the access unit: RGB to I420 and the encode.
- Each row is a 30 s run in 10 s windows, after 1 s of load, unless it
  says 10 minutes. Raw results, one JSON line per run, are kept in the
  thread's storage, not the repository.

## E17: each model, busy, as a box of each size

| Model, screen | Pixels | fps busy, 4 / 8 / 12 / 16 cores | Emulator cores busy, 8 cores | Drawing alone, 8 cores | Idle | Resident memory, after 10 minutes busy |
| --- | --- | --- | --- | --- | --- | --- |
| Pixel 8 | 1080x2400 | 23.5 / 41.3 / 51.8 / 57 | 6.0 | 42.1 fps, 6.1 cores | 0.1 cores | 3.9 GiB, flat over the 10 minutes |
| Pixel Fold, closed | 1080x2092 | 27.4 / 43.6 / 53.3 / not run | 5.4 | 45.3 fps, 5.6 cores | 0.1 cores | 5.5 GiB, the same device as open |
| Pixel Fold, open | 2208x1840 | 12.6 / 22.8 / 30.1 / 36.3 | 6.7 | 23.3 fps, 7.0 cores | 0.1 to 0.6 cores | 5.4 GiB, flat over the 10 minutes |
| Pixel Fold, half open | 2208x1840 | not run / 22.7 / not run / not run | 6.7 | 23.1 fps, 6.8 cores | 0.1 cores | as open |
| Pixel Tablet | 2560x1600 | 11.2 / 20.4 / 28.3 / 31.7 | 6.8 | 21.2 fps, 7.0 cores | 1.6 cores: its home screen, just booted, still changed about once a second | 5.4 GiB, flat over the 10 minutes |

At 16 cores nothing was pinned. The phone's figure is from its first run
on the VM, with x264 by shared memory, at 8.5 cores; the Fold open and the
Tablet took 10.2 cores each there.

What they show:

- **Drawing is still the cost, and it grows faster than the pixels.** The
  Fold open and the Tablet have 1.6 times the phone's pixels, and draw at
  about half its rate: 21 to 23 fps against 41 on 8 cores. Each takes
  nearly 7 of the 8 cores while it scrolls.
- **More cores help every model, and none reaches 60 fps on the CPU.**
  From 8 to 12 cores the phone goes from 41 to 52 fps, and the large
  screens from 20 to 23 fps to 28 to 30; at 16, the phone shows 57 and
  the large screens 32 to 36.
- **The encoder is not what limits the frame rate.** Drawing alone and
  drawing with x264 differ by about 1 fps on each model, within the
  windows' spread.
- **Memory depends on the profile, not on use here.** The phone held
  3.9 GiB, and the Fold and the Tablet 5.4 to 5.5 GiB, unchanged over 10
  minutes of scrolling. The research's 4.8 to 4.9 GB after use came from
  opening apps, which these runs did not; unit 4.1's harness measures
  memory after real use.
- **Half open draws as open,** on the inner screen at 2208x1840. Android
  said `HALF_OPENED`, set by the console's `sensor set hinge-angle0 90`.
- **The phone at 4 cores** still scrolls at 23 fps, about what the large
  screens show at 8.

## E7: x264 against OpenH264

Busy, on 8 cores, with frames by shared memory. Both encoders kept up with
every frame on every model: frames encoded equalled frames received.

| Model, screen | x264: ms a frame, median / p95 | x264: cores | OpenH264: ms a frame, median / p95 | OpenH264: cores |
| --- | --- | --- | --- | --- |
| Pixel 8 | 6.9 / 10.1 | 0.28 | 10.6 / 15.1 | 0.41 |
| Pixel Fold, closed | 6.2 / 10.5 | 0.27 | 10.3 / 16.1 | 0.41 |
| Pixel Fold, open | 11.5 / 18.2 | 0.22 | 18.4 / 28.5 | 0.36 |
| Pixel Tablet | 11.7 / 18.0 | 0.19 | 23.4 / 33.5 | 0.43 |

The picture, from 120 busy frames of each model recorded raw at the rate
the device drew them, played through each encoder at that rate, given as
its frame rate, at 8 Mbit/s, then decoded by ffmpeg and compared with the
raw frames in 4:2:0:

| Model, screen | Recorded at | x264: Mbit/s, SSIM, PSNR | OpenH264: Mbit/s, SSIM, PSNR |
| --- | --- | --- | --- |
| Pixel 8 | 47 fps | 8.4, 0.9970, 50.1 dB | 3.2, 0.9960, 46.5 dB |
| Pixel Fold, closed | 44 fps | 7.8, 0.9982, 50.2 dB | 1.6, 0.9962, 45.6 dB |
| Pixel Fold, open | 24 fps | 7.9, 0.9986, 55.0 dB | 1.9, 0.9970, 48.4 dB |
| Pixel Tablet | 24 fps | 7.3, 0.9980, 54.7 dB | 1.8, 0.9966, 49.3 dB |

The replays ran at 18 to 30 fps, slower than recorded, as each frame went
through Node and the pipe one at a time; the frame rate the encoders were
given was the recorded one.

- **Both pictures are good; x264's is better.** x264 spends the 8 Mbit/s
  and gives 50 to 55 dB. OpenH264, in its screen-content mode, spends only
  1.6 to 3.2 Mbit/s of it and gives 46 to 49 dB, 3 to 6 dB less. Its rate
  control does not reach the target; a higher target, or its camera mode,
  was not tried. Neither picture was judged by eye.
- **Live, 8 Mbit/s is x264's ceiling, not its rate.** The helper tells
  x264 the frame rate is 60, the most a viewer shows, so its budget for a
  frame is an eighth of a megabit, and at 41 fps it sent 5.5 Mbit/s. Told
  that frames come when they come (`b_vfr_input`), x264 held each frame
  back until the next, which a still screen would never send.
- **x264 is about 1.5 to 2 times quicker,** and so adds 4 to 12 ms less to
  each frame's way to the screen. Both are far under the research's 20 ms
  a frame for x264, which went through PyAV and ffmpeg's colour
  conversion in Python.
- **Both cost under half a core** at the rates the device draws.

## E6: frames by shared memory or through Node

The emulator can write each frame into a file the client names
(`ImageTransport` `MMAP`), and send only the frame's size over gRPC. The
helper then reads the frame from that file. Through a pipe, Node receives
each frame's bytes over gRPC and writes them to the helper.

| Model | Way | fps busy, 8 cores | Node's cores | Received to encoded, median / p95 |
| --- | --- | --- | --- | --- |
| Pixel 8 | shared memory | 41.3 | 0.02 | 7.1 / 10.3 ms |
| Pixel 8 | pipe | 39.4 | 0.20 | 9.0 / 14.3 ms |
| Pixel Fold, open | shared memory | 22.8 | 0.01 | 11.9 / 19.2 ms |
| Pixel Fold, open | pipe | 22.3 | 0.18 | 17.9 / 29.8 ms |
| Pixel Tablet | shared memory | 20.4 | 0.01 | 12.2 / 19.4 ms |
| Pixel Tablet | pipe | 20.7 | 0.16 | 18.3 / 31.7 ms |

Two more runs of the phone, alternating, gave the same: 39 to 40 fps by
pipe with Node at 0.19 to 0.21 of a core, and 40 to 41 fps by shared
memory with Node at 0.01.

Whether a frame can tear: the emulator writes the next frame into the same
file, and its proto warns that this "can result in tearing". Two streams
ran at once on the busy phone, one by shared memory and one by bytes, for
20 s each, and every frame read from shared memory was compared with the
frames sent as bytes:

| Read held back after the frame's message | Frames read | Frames that matched no frame sent as bytes |
| --- | --- | --- |
| 0 ms | 661 | 0 |
| 8 ms | 658 | 0 |
| 20 ms | 640 | 3 |

So frames read at once were whole in these runs. The helper reads a frame
as soon as its message comes, unless it is still encoding the one before,
which takes 7 ms at the median on the phone and 12 ms on the large
screens; it then reads the newest frame when it finishes. The p95 of the
large screens' encode, 17 to 18 ms, is near the 20 ms where a frame could
tear.

## A real 8-core box, and two boxes on one host

A second VM of 8 cores and 16 GiB, the android kind's default, on the
same Proxmox host, ran the phone with nothing pinned, x264 by shared
memory, busy:

| Run | Real 8-core VM | 16-core VM pinned to 8 |
| --- | --- | --- |
| Alone, first | 42.2 fps, 5.8 cores | 41.3 fps, 6.0 cores |
| Both busy at once, 60 s | 37.8 fps | 47.5 fps, on a phone just booted again |
| Both busy at once again, 30 s | 37.8 fps | 40.1 fps |
| Alone, after | 37.2 fps | 40.1 fps |

- **Pinning stands in for a box's size.** The real 8-core VM drew the
  phone at 37 to 42 fps on 5.5 to 5.8 cores, as the pinned one did at 40
  to 41.
- **Two busy device boxes on one host did not slow each other** beyond the
  spread of runs alone, which was about 10%: the real VM's runs alone gave
  42 and 37 fps. The host has 32 cores with two threads each, and other
  boxes on it were not under our control. A host with more device boxes
  than cores is not measured.
- **What a run draws moves its rate.** The same pinned phone gave 47.5 fps
  just after a cold boot and 40 a few minutes later, with the same load:
  the launcher's list differed. Rates here are good to about 10%.

## What this decides

- **The android kind's sizes stand as unit 2.1 set them,** and gain a
  least size. Small, the default, is 8 cores and 16 GiB, as 063 set: the
  phone scrolls at 41 fps there, the Fold open and the Tablet at 20 to
  23, and a device takes at most 5.5 GiB, which leaves room for a build.
  Medium, 12 cores and 24 GiB, gives the large screens 28 to 30 fps;
  large, 16 cores and 32 GiB, gives them 32 to 36 and the phone 57. The
  least is 4 cores and 10 GiB, where the phone scrolls at 23 fps and the
  large screens at 11 to 13: `src/core/sizes.ts` refuses an acquire, a
  resize or a box-sizes preset below it, in words.
- **The tablet and the foldable need about 16 cores** to scroll at
  what the phone does on 8 to 12, and nothing here took them near 60 fps.
  063's Consequences hold: a host with both KVM and a GPU is the way past
  this.
- **The encoder.** `bb-box-h264` uses x264 where the image build has built
  it, and OpenH264 otherwise. Both keep up with every model. OpenH264
  takes about 1.5 times x264's CPU and 1.5 to 2 times its time a frame,
  for a picture 3 to 6 dB lower, so x264 is worth an operator's build.
- **Frames by shared memory.** It saves Node about 0.2 of a core, about 2
  to 6 ms a frame, and a frame or two a second on the phone but none on
  the large screens, and no torn
  frame was seen when read at once. The device server (unit 4.1) names a
  file in its own 0700 folder, `~/.bb-box/device/`, and feeds the helper
  `S` commands. The pipe stays in the helper and in
  `src/device/h264-encoder.ts`, for tests and in case a later emulator
  changes the transport.

## What limits these numbers

- One host, one CPU type, and nested KVM. Another host's CPU will draw at
  another rate.
- Pinning shares a box's cores among the emulator, Node and the helper, but
  not its memory bandwidth or the VM's other vCPUs' interrupts.
- The load is the launcher's list, scrolled without a pause: about the
  busiest a person's use gets, and kinder than a game or a video.
- The desktop of the linux-desktop-cpu VM ran beside the emulator, idle.
  An android box has none.

## Unit 3.1: the Android template

Measured on 26 October 2026 with the template's own scripts in
[setup/android](../../setup/android/README.md): two Linux VM boxes on Proxmox
QEMU, each a clone of the Linux VM template, on the same AMD Ryzen
Threadripper PRO 9975WX host with nested KVM. The build box had 16 cores and
16 GiB; the other 16 cores and 32 GiB. Emulator 37.2.12.0, the Android 15
(API 35) Google APIs x86_64 image revision 9, each AVD from `avdmanager`
with 4 cores and `hw.keyboard = yes`, drawn by SwiftShader with no window.

The template itself was not built: `build.sh android` runs as root on the
Proxmox host, and the refresh through the plugin's Proxmox API token. Both
are the lead's to run. What ran is the build's Android layer,
`customize-android.sh`, in a box, then the refresh's own script in that box,
then the image's check, `bb-box-check-android`, in both boxes.

### The build

| Step | Time |
| --- | --- |
| The SDK's four parts, downloaded and checked by SHA-256, then unpacked | about 60 s |
| Each device: `avdmanager`, a cold boot to `sys.boot_completed`, the defaults, the snapshot saved on stop | 29 to 32 s: boot 16.9 to 17.5 s, save 2.5 to 4.0 s |
| Each device booted again from its snapshot, as the build's own check | 2.1 to 3.3 s |
| The whole layer, with the SDK downloaded already | 101 s |

### The refresh, in a box

The script `refreshImage` runs in a box of an Android template (from
`buildScript("android", ...)`, with the setup files packed as the refresh
packs them) ran in the box that had the Android layer: the Linux template's
guest scripts, `customize-vm.sh`, `customize-android.sh` and `finalize.sh
android`. It took 250 s and exited 0. It kept the SDK, whose pins had not
moved, and the encoder the image had, made each device's AVD and snapshot
again, and wrote a record of kind `android` with the three devices, each
with its snapshot's origin, and a size of 20.8 GiB. After a reboot, as a
trial box starts, `bb-box-check-android` passed 44 of its 45 lines. The
other, that the box's adb key is its own, then compared the key with the
boot time, and failed on the box's second boot. It now compares it with the
image's build time, and passed. The
capture, the trial box and the replace are the Proxmox QEMU backend's, as
for the Linux templates, and were run against the fake Proxmox in the tests
only.

### E2: a snapshot made in the build, in another VM

The SDK and the AVDs, snapshots and all, were copied from the build box to
the other box, as a clone of the template would have them, and each device
booted from its snapshot there five times. Before the first, the page cache
was dropped (`drop_caches`), as a fresh clone reads its disk cold. Seconds
from `emulator` to `sys.boot_completed`:

| Device | First, cold cache | Then |
| --- | --- | --- |
| Pixel 8 | 3.73 | 2.29, 2.65, 2.08, 2.32 |
| Pixel Fold | 3.93 | 2.69, 3.11, 2.70, 3.31 |
| Pixel Tablet | 3.51 | 2.48, 2.48, 2.89, 2.48 |

Every boot loaded its snapshot (the emulator's log said "Successfully loaded
snapshot 'default_boot'"), within 063's 2.2 to 3.9 s, the Pixel Fold's first
at its top. One earlier boot of the Pixel Fold, the first after the copy,
took 9.4 s. The snapshot loaded in another VM on the same host. On another
host's CPU it was not tried: there is one Proxmox host. The image record
names the CPU each snapshot was made on.

### E13: typing

In Messages, keys sent by `adb shell input text` with the hardware keyboard
on and Gboard's defaults: "Hello idb 123", "teh", "adn", "recieve", "x." and
two spaces, then "i", arrived as typed. Nothing was corrected, no capital
was added, and two spaces gave no full stop. Gboard corrects only what it
types itself, so the template leaves Gboard's own settings as they are, and
turns off the system spell checker. 063 said to set Gboard's; that is not
needed.

### E19: the gRPC port

With `-grpc 8554 -grpc-use-token`, the pinned emulator listened for gRPC on
`[::ffff:127.0.0.1]:8554`, loopback only. Its console (5554), adb (5555)
and adb's server (5037) listened on 127.0.0.1 and ::1. So the firewall is
the second wall, not the only one. The research's `[::]:8554` was without
a token. Still open on every interface: adb's mDNS, UDP 5353, which answers
no connection.

The token is made new at each start by `bb-box-emulator`, and is in that
start's discovery file under `/run/user/<uid>/avd/running/`. gRPC
`getStatus` with no token and with a wrong one answered status 16,
UNAUTHENTICATED; with the start's token, 0.

### The ports, from elsewhere

From the other box, over IPv4 and over IPv6 (a private address added on the
two boxes' shared link, as their image has none): ports 8554, 5554, 5555
and 5037 timed out, dropped, every 16 s from 4 s into a cold boot until
90 s after it; SSH, port 22, connected each time. From a Docker container
in the box, to the box's address and to `docker0`'s: none connected, while
the device was booted, half a second into a restart, and after it. From a
network namespace on another interface of the box, as the image's check
does: none connected, over IPv4 and IPv6, for each device. With the table
removed, `bb-box-emulator` refused to start the device. No tailnet peer was
tried: no box here had joined a tailnet.

### Identity

Each box made its own adb key, console token and gRPC token: their SHA-256s
differed. The device's own serial, `EMULATOR37X2X12X0`, and whatever else
the snapshot holds, such as the device's Android ID, are the same in every
box from one template.

### E24: disk

Allocated and apparent, after the build and its checks:

| Part | Allocated | Apparent | Of which |
| --- | --- | --- | --- |
| The SDK | 4.6 GB | 4.6 GB | system image 3.5 GB, emulator 0.9 GB, command-line tools 0.2 GB |
| Pixel 8 | 3.4 GB | 4.0 GB | snapshot memory 2.4 GB, data 0.9 GB |
| Pixel Fold | 4.7 to 4.9 GB | 4.9 GB | snapshot memory 3.7 GB, data 1.1 GB |
| Pixel Tablet | 4.7 to 5.1 GB | 5.2 GB | snapshot memory 3.7 GB, data 1.4 GB |
| The box's root, after the build | 21.6 GiB | | the Linux VM image, 3.6 GiB, and the above |

The template adds about 18 GB to the Linux VM template, as 063 expected.
The Fold's and the Tablet's grew by 0.2 to 0.4 GB over 15 boots from their
snapshots without saving. Their snapshots hold more memory than the 2 GiB
each AVD asks for: the emulator raises it to 2.5 GiB for the Pixel 8 and
4 GiB for the large screens, which E17's resident memory matches. A device
used in a box, a hibernated spare, and a build and trial beside the current
template were not measured: they need the template (4.1, 7.5).


## Unit 3.2: the iOS image

Measured on 26 October 2026 with the image's own scripts in
[setup/tart/ios](../../setup/tart/ios/README.md), in one Tart
macos-desktop box at the ios kind's default size, 6 cores and 16 GiB,
cloned from the standard macOS image (build.20261022-033224-9658): macOS
27.0, Xcode 27.0 (27A266a), iOS 27.0 (24A434), idb_companion 1.7.7.

The image itself was not made. `prepare-ios-image.sh` clones the macOS
image and boots the clone with `tart` on the Mac, and the refresh does the
same through bb-box's SSH to the Mac, which a box cannot do. What ran is
the build's layer, `build-ios.sh`, in the box, which is a clone of the
macOS image as the build's VM is; then the image's check,
`bb-box-check-ios`, in the same box; then `prepare-ios-image.sh` itself with
a stand-in for `tart` that runs each `tart exec` in the box. The capture,
the trial box and the replace are the Tart backend's, as for the macOS
image, and were run against the fake Mac in the tests only.

### The build

| Step | Time |
| --- | --- |
| idb_companion downloaded, checked by SHA-256 and installed | 5 s |
| Xcode's own devices removed | 3 s |
| iPhone 18 Pro: made, first boot, defaults, slimmed (two passes and three reboots), shut down | first boot 27.6 s; slimming 89.5 s |
| iPhone 17: the same | first boot 26.8 s; slimming 88.6 s |
| iPad Pro 13-inch (M5): the same | first boot 20.9 s; slimming 101.1 s |
| The whole layer | 6 min 58 s |
| The check, all three devices | about 10 min |

Each device had all 112 labels of its list disabled after the second pass,
and again after a further reboot. A second build, by `prepare-ios-image.sh`
with the stand-in for `tart`, took 6 min 16 s for the layer, with first
boots of 17.6 to 26.1 s; its check passed all 24 lines, and the record it
wrote names the macOS build as its base, idb_companion 1.7.7, and each
device's runtime and list, with the pins digest bb-box computes.

### The check

Every line passed, on two full runs. The second run's numbers:

| Device | Boots in | Processes, idle over 60 s | XCUITest launch to automation session | Pixels |
| --- | --- | --- | --- | --- |
| iPhone 18 Pro | 2.5 s | 61, 0.013 of a core | 0.7 s | 1206x2622 |
| iPhone 17 | 1.9 s | 61, 0.021 of a core | 0.7 s | 1206x2622 |
| iPad Pro 13-inch (M5) | 1.9 s | 64, 0.020 of a core | 0.7 s | 2064x2752 |

### The check fails when a needed service is off

One of the three services the slimming research found needed was turned off
in each device by hand, with `launchctl disable`, and the check run again:

| Turned off | On | The check said |
| --- | --- | --- |
| `gamed` | iPhone 18 Pro | xcuitest launch FAIL: an XCUITest launch took 11.3 s to reach its automation session, over 3 s |
| `sleepd` | iPhone 17 | idle cpu FAIL: 1.662 of a core idle over 60 s, at most 0.1 |
| `nanoregistryd` | iPhone 18 Pro | boots FAIL: simctl bootstatus did not return within 60 s |
| `nanoregistryd` | iPad Pro 13-inch (M5) | nothing: the iPad booted in 1.9 s without it |

So the boot check catches `nanoregistryd` on the iPhone, as the research
found it, but the iPad does not need it. The check now also has a direct
line, needed services, which fails if any of the three is disabled.

After the run with `gamed` off, CoreSimulatorService stopped answering:
every `simctl` waited, unkillable, and the VM stalled on its way down at
the restart. Whether `gamed` caused it, or the XCUITest stopped after its
test, is not known; it did not happen on the runs with every service on.
The check now gives each `simctl` call 120 s and each XCUITest 300 s, and
runs XCUITest with `-collect-test-diagnostics never`: once, on the iPad
with every service on, xcodebuild sat in `simctl diagnose` for 4 minutes
after the test had passed.

### Slimming against the research

Settled 5 minutes after boot, then idle over 5 minutes, measured with the
research's `simtree.py` (summed `phys_footprint` of the device's process
tree):

| Device | Processes | phys_footprint | Idle CPU over 5 minutes | Research, the same list |
| --- | --- | --- | --- | --- |
| iPhone 18 Pro | 61 | 478 MiB | 0.012 of a core | 62, 528 MiB, 0.009 |
| iPhone 17 | 61 | 478 MiB | 0.012 of a core | not measured |
| iPad Pro 13-inch (M5) | 64 | 507 MiB | 0.012 of a core | iPad Pro 11-inch: 66, 509 MiB, 0.015 |

Stock, the research measured 240 processes, 1,997 to 2,201 MiB and 0.37 of
a core on the iPhone 18 Pro. macOS's own free memory, by `memory_pressure`,
fell from 90% to 88 or 89% with each device booted: 0.2 to 0.3 GiB of the
16 GiB VM, as the research's 0.21 GiB a slim device.

### E1: boot times

| Device | First boot, at build | Cold: the first boot after the VM's own, 10 to 47 s into it | Again, warm |
| --- | --- | --- | --- |
| iPhone 18 Pro | 27.6 s | 8.8 s | 1.9 to 2.5 s |
| iPhone 17 | 26.8 s | 10.9 s | 1.9 to 2.0 s |
| iPad Pro 13-inch (M5) | 20.9 s | 11.9 s | 1.9 to 2.0 s |

A box from the image boots each device in 9 to 12 s cold, within 063's
1.9 to 13.1 s, and in about 2 s once booted before in that box. The cold
boots were in the build box after a restart, not in a fresh clone of the
image: a clone shares the image's blocks on the Mac's APFS and so may read
them from the Mac's cache, so a clone may be quicker, not slower. That a
fresh clone keeps the slimming, which the research found, was not checked
again here.

### E13: typing

In the probe app on the iPhone 18 Pro and the iPad Pro 13-inch (M5), keys
sent as HID through idb_companion, with the software keyboard showing:
"Hello idb 123 teh adn recieve x.", two spaces, then "i", arrived as
typed. Nothing was corrected, no full stop was added, and no capital. The
keyboard's "slide to type" sheet did not show. Misspelt words are still
underlined, as spell checking is on; it changes nothing.

### E20: Xcode's Run and Device Hub

- **Run opens Device Hub.** In the box's desktop, the probe app run from
  Xcode with Cmd+R opened Device Hub 8 s later with no device booted, and
  4 s later with the device booted already by `simctl`, as an ios box's
  will be.
- **No preference found stops it.** With
  `IDEAlwaysLaunchSimulatorWhenRunningAgainstSimulator` set to NO, a name
  in Xcode's IDEiOSSupportCore, Device Hub still opened, 2 s after Run.
  Xcode's other device keys found by name
  (`IDELaunchSimulatorApplicationForTestSessions`) are for tests. So the
  Desktop view's warning and the device server's watch (4.2) stay.
- **Quitting Device Hub shuts the device down.** Quit by AppleScript, it
  shut the booted iPhone down with it. Killed with SIGKILL, it left the
  device booted. The watch's Quit Device Hub must not quit it.
- **No microphone prompt** showed in either run: tccd's log showed Device
  Hub asking only whether it had the microphone. The image grants the
  microphone, which is BlackHole, to the Simulator's trampoline and to
  Device Hub, in the user's TCC database, so neither can ask.
- **Xcode's first launch** shows a Components sheet, then External Agent
  Access, then What's New, over the desktop. The image answers the first,
  as Xcode's own preferences record it; a person opening Xcode in an ios
  box sees the other two. The macOS image's own Xcode set-up could answer
  them for every macOS box.

### E24: disk

Allocated and apparent, after the build and the checks:

| Part | Allocated | Apparent |
| --- | --- | --- |
| iPhone 18 Pro's device | 1.60 GiB | 1.61 GiB |
| iPhone 17's device | 1.54 GiB | 1.55 GiB |
| iPad Pro 13-inch (M5)'s device | 1.84 GiB | 1.84 GiB |
| idb_companion | 0.11 GiB | 0.11 GiB |
| bb-box's check, list and probe app | 48 KiB | |

The image adds about 5.1 GiB to the macOS image, not 063's 0.6 GB. Most of
each device is what it downloads in its first boot, before slimming can
start: 0.9 to 1.0 GiB of MobileAsset, two thirds of it Siri's
understanding model, and 0.2 to 0.4 GiB of wallpaper posters. A box from
the image is an APFS clone, so this costs the Mac's disk once, in the
image, not in each box. Removing the Siri assets after slimming would save
about 0.8 GiB a device; it was not tried. A device used in a box, a
suspended spare, and a build and trial beside the current image were not
measured: they need the image on the Mac (4.2, 7.5).

## Unit 4.2: the iOS driver

Measured on 26 October 2026 with the harness in
[scripts/measure/ios](../../scripts/measure/ios/README.md), in Tart
macos-desktop boxes at the ios kind's default size, 6 cores and 16 GiB,
cloned from the standard macOS image (build.20261022-033224-9658): macOS
27.0, Xcode 27.0 (27A266a), iOS 27.0 (24A434), idb_companion 1.7.7. Each box
ran the iOS image's layer, `build-ios.sh`, and its record, as the image
build does, then had the device server delivered from this unit's checkout
as bb-box delivers it. Every number is in the box, from a viewer on the
server's socket: BB's relay, the network and the browser are not in them.
Through BB is the lead's live check.

### E5: idb's video stream

A probe read idb_companion's `video_stream` over its unix socket with the
device server's own gRPC client, and logged each message's NAL units:

- **Each message is one whole access unit,** in Annex B with its start
  codes: of 153 messages over four streams, each of the 98 the probe
  printed began with a start code and held exactly one picture, and the
  driver's own reading of thousands more found none without one. A key
  frame carries its SPS, PPS and IDR in one message. So the driver
  needs no parser: it reads each message's NAL types, and the picture's
  size from the SPS.
- **On a still screen idb sends nothing after its first frame.** It has no
  request for a key frame. Stopping the stream and starting another gives a
  key frame with SPS and PPS, on a still screen too, in 50 to 106 ms; the
  first stream after the companion starts took 3.3 s.
- So the driver makes a key frame on demand in one of two ways. Where no
  frame has come since the last key frame, the screen has not changed, and
  it sends that key frame again: 2.4 ms at the median, 7.3 ms at worst, of
  10 asks. Otherwise it stops the stream and starts another: 58 to 86 ms at
  the median and 64 to 100 ms at worst, by model, of 5 to 10 asks, while
  the screen changed every frame.

### The stream, each model

Safari showing the iOS research's page, busy (a spinner and a counter
redrawn every frame), 10 s in 5 s windows, the second window given:

| Model | First frame after a viewer asks | Frames a second, busy | Mbit/s, busy | Server: cores, resident | idb_companion: cores, resident | Key frame on request, busy: median, worst |
| --- | --- | --- | --- | --- | --- | --- |
| iPhone 18 Pro | 50 to 77 ms | 57.1 to 57.7 | 1.9 to 3.6 | 0.018 to 0.022, 99 to 108 MiB | 0.076 to 0.09, 55 MiB | 79 to 82 ms, 86 to 90 ms |
| iPhone 17 | 71 ms | 59.1 | 3.3 | 0.018, 101 MiB | 0.06, 55 MiB | 58 ms, 64 ms |
| iPad Pro 13-inch (M5) | 82 ms | 58.9 | 4.8 | 0.018, 106 MiB | 0.054, 55 MiB | 86 ms, 100 ms |

On a still screen no frames came, and the two processes took 0.002 and
0.006 of a core. A viewer said hello 130 to 255 ms after it connected. A
HID tap, sent to idb_companion beside the server, changed the screen 53 ms
later at the median of 10 (31 to 77 ms), the first 238 ms, as the research
found.

### Recovery

| What happened | Three times | What it took |
| --- | --- | --- |
| idb_companion killed (SIGKILL) while busy | the stream failed, the server started a new companion, 106 to 108 ms, and a new stream | a viewer's stall: 482 to 489 ms, from the last frame before to a key frame after |
| The device server killed (SIGKILL) | launchd started it again; it found the device booted and its companion alive, and reattached to both | hello 238 to 248 ms after the kill, a key frame 779 to 797 ms after it |
| The device shut down from outside (`simctl shutdown`) | the server's watch, every 5 s, saw it and booted it again; slimming checked, the companion kept | frames again about 5 s after it was seen |
| The same again within 5 minutes | the device left failed: "The iPhone 18 Pro stopped twice within 5 minutes, so bb-box leaves it stopped. Restart the box to start it again." | |
| A switch of model, through a control connection | the old device shut down, the new one booted, a new companion, the first frame | 8.0 to 8.3 s, of which the shutdown about 3.7 s, the boot 1.4 to 1.5 s and the new companion's first frame about 3 s |

The first run of the device shutting down found a bug in the device
server's gRPC client, shared with Android: when the companion ended a
stream, the client waited for its own requests to end, so the server never
saw the stream end, and an abort after that raised an error nothing heard,
which stopped the server. The client now ends a call when the server ends
it.

### Slimming, kept and turned off

| Case | What the server did before the first frame | Time |
| --- | --- | --- |
| A device slim as the image left it | counted the list's 112 labels in `print-disabled` | 0.3 s |
| Three labels turned on by hand, then the server restarted | turned them off, rebooted the device | 8.0 s |
| The box's choice changed to `slim: false` | turned on all 112, rebooted the device | 43.0 s; then 222 processes, as stock |
| Back to slim | turned off all 112, rebooted it | 29.8 s; all 112 held after one pass |

### Device Hub

Device Hub opened in the box's desktop was killed by the server's watch,
with SIGKILL, 2.9 s after it opened, and the device stayed booted. The kill
is logged, and counted for the doctor's check, `device-hub.<box>`.

### E4: a booted device through the box's suspend

`box_stop` suspends a Tart macOS VM, and `box_start` resumes it and sets its
clock. The device has no clock of its own: a simulator runs on the Mac's
kernel, so its clock is the macOS VM's.

| Suspended for | The server | Frames | HID | The clock |
| --- | --- | --- | --- | --- |
| 110 s | saw its clock move 102 s past its own, restarted the stream, and checked the device and the companion | a viewer's key frame at once | a tap changed the screen in 56 ms at the median of 5, the first 143 ms | the status bar said 10:04, as the Mac did |
| 62 minutes | saw its clock move 3,704 s past its own, restarted the stream, and checked the device and the companion; the device was still booted | a viewer's key frame at once | a tap changed the screen in 57 ms at the median of 5, 28 to 91 ms | the status bar said 11:16, as the Mac did |
| 24 h | suspended again at 11:16 UTC on 26 October; to be read after 11:16 UTC on 27 October | | | |

The 62-minute run was in a second box, which ran the device server as it
was before its last changes, none of them to the driver's resume. Its screen
did not change after the resume, which hid what the next section found.

### Through the production BB

After the deploy, ios boxes acquired with `box_acquire` on the production
BB, at the kind's default size then, small, 4 cores and 8 GiB. The ios
kind's default is now medium, 6 cores and 16 GiB, the size the measurements
above were made at, with room for Xcode beside the device. The panel itself
was not seen: a box cannot reach BB's panel without a person's session.
Every stream number is from a viewer on the device server's socket in the
box, as above.

| Check | Result |
| --- | --- |
| box_list | ios, with "Devices: iPhone 18 Pro (default), iPhone 17, iPad Pro 13-inch (M5)" |
| box_acquire, each model | answered once the device had booted: 7.0 to 7.8 s after the box was ready; the device booted cold in 7.7 to 8.2 s, with all 112 labels still off in the fresh clone |
| The stream, each model | still: no frames once settled; busy: 56 to 62 fps, 3.4 to 4.7 Mbit/s; the server 0.014 to 0.024 of a core, idb_companion 0.05 to 0.08 |
| A key frame after a pause | on a still screen 0.5 to 1.4 ms at the median of 10, 2.4 ms at worst bar one of 90 ms; busy 60 to 63 ms at the median, 73 to 128 ms at worst |
| idb_companion killed | a stall of 456 to 762 ms, three times |
| The server killed | hello again in 0.20 to 0.23 s, a key frame in 0.82 to 0.86 s, the companion kept, three times |
| Device Hub opened | killed 1.0 s later; frames went on; the doctor's check said "The device server has killed it once" |
| `slim: false` | every label turned on and the device rebooted before its first frame, in 56.9 s; 202 processes after |
| A new server version | delivered by the plugin to a running box after an update, the device kept booted |
| box_stop and box_start | see below |

**After a stop and start, idb_companion grew without bound.** With the
screen changing, the companion that ran before the suspend grew by about
265 MB a second, to 17 GB in a minute; the box had 6% of its memory free
and its swap full, the device drew a few frames a second, and `simctl`
hung. A companion started after the resume stayed at 39 MB. Since version
5 the server starts a new companion when it sees the box resume: through
the deploy, on a fresh box, the new companion listened 212 ms after the
resume, stayed at 39 MB over the next minute while the screen changed, and
the stream ran at 54 to 57 fps.

Xcode's Run could not be driven from a command: Xcode refused Apple events
from a program run by `box_run`, whose shell, not the program, is the one
macOS asks about, so Device Hub was opened directly, which is what Run
does (E20).

## Units 5.1 and 5.2: input, shared and on iOS

Measured on 26 October 2026 in one ios box on Tart, the iPhone 18 Pro, 6
cores and 16 GiB, from the iOS image build.20261026-091450-8505: macOS 27.0,
Xcode 27.0, iOS 27.0 (24A434), idb_companion 1.7.7. The device server was
version 6 from this unit's checkout, delivered as bb-box delivers it.

Two ways in:

- **Straight to idb.** Probes on idb_companion's socket sent HID events and
  read the device's accessibility tree, for what idb and iOS do.
- **As the panel does, without BB's server.** A harness in
  [scripts/measure/ios](../../scripts/measure/ios/README.md) ran the
  plugin's own relay (`SelkiesRelay` and `SelkiesBox`) beside the device
  server, the panel's own video client (`SelkiesSession`) in Chrome 156,
  headless, on the box's macOS, and a control connection standing in for
  the plugin. Chrome's DevTools protocol pressed the pointer, the wheel and
  keys, and ran an input method, as a person would. BB's server, the
  network and another computer's browser are not in these numbers. Through
  BB is the lead's check.

A page served from the box's macOS, open in the device's Safari, reported
each touch, pinch, scroll and field value to its server's log.

### E14: tap to screen, in the browser

From the browser's `pointerdown` to the first decoded frame whose pixel
beside the tap changed, on a page that turns black or white at each
touch, 100 taps 0.6 s apart:

| Load in the box | Taps seen | Median | 95th percentile | Worst |
| --- | --- | --- | --- | --- |
| Idle | 100 of 100 | 64 ms | 83 ms | 93 ms |
| Four `xcodebuild` loops of the probe app, the box's 6 cores 89 to 97% busy | 100 of 100 | 52 ms | 81 ms | 96 ms |

The first idle run's driver missed its own first tap, as it read the pixel
before the page had a frame to compare with; the frames show that tap
landed at 111 ms. The driver now reads the pixel first. With BB's own
path, about 25 ms (060), these are about 80 to 110 ms at the median, inside
063's bar.

### The first tap after taking control

The device server opens idb's HID stream as a person takes control, and as
the agent sends its first input.

| Case | Times | First tap to screen |
| --- | --- | --- |
| Control handed back, then taken again | 5 | 72, 82, 74, 93 and 98 ms |
| idb_companion killed, started again by the server, then control taken | 2 runs of 20 taps | 20 of 20 seen in each; the first 95 and 83 ms |

The research's first tap took 578 ms, and the slimming research saw 15 of
20 taps land in the first stream after the companion started. Neither
happened here, with the stream opened ahead.

### E8: the space each takes touches in

- **idb takes points in the screen as the app draws it.** Safari turned
  left and turned right alike: idb's point (100, 300) reached the page at
  (38, 190), past a 62-point inset and 110 points of toolbar.
- **The stream turns with what is drawn,** to 2622x1206 while Safari is
  sideways, and stays 1206x2622 while the Home Screen stays upright on a
  phone held sideways. So a point in the stream's pixels, divided by the
  model's scale, is idb's point in every case tried, and the server needs
  no turn of its own on iOS.
- **Through the viewer,** taps at (300, 200) and (100, 300) in the
  sideways picture's points reached the page at (238, 90) and (38, 190);
  upright, (300, 200) reached (300, 138), past its 62-point inset.
- **A turn ends idb's HID stream** at the next event: idb answers 'Simulator
  display changed during the operation', and that event is lost. From one
  sideways to the other, the stream's size does not change, so no new
  geometry generation ends the gesture first. The driver now sends the
  touch events of the last 300 ms again on a new stream: 5 of 5 taps after
  turns landed, against 0 of 1 before.
- **Not settled here:** an app held upright while the device turns, and an
  agent's screenshot. idb's screenshot stays 1206x2622 with the picture on
  its side while the stream is 2622x1206, and a stream started while the
  device is sideways sends one first key frame of 1206x2622, on its side,
  then 2622x1206. Both are for unit 6.1's frame and 7.1's screenshots.

### E9: two fingers on iOS

idb's HID stream has one finger. Its `HIDPinch` event is a whole pinch: a
centre, a scale, a start radius and a duration, as two touches.

- Straight to idb, a pinch of scale 2 at the page's centre reached the page
  as two touches, scale 2.00.
- Through the viewer, Alt and drag from (241, 477) to (301, 557) reached the
  page as two touches mirrored about the centre, scale 2.759 against 2.76
  from the pointer's path.
- So on iOS a pinch from a person runs when its fingers lift, from the
  span at its start and its end, over the time it took, 0.2 to 1 s. It does
  not follow the fingers live. The agent's pinch is one `HIDPinch`.

### How iOS pastes, and E21

063 expected an Allow Paste alert for the server to answer. iOS 27 in the
simulator shows none:

- **Cmd+V from outside the device is refused silently.** With text put on
  the device's pasteboard by `simctl pbcopy`, HID Cmd+V pasted nothing, in
  the probe app and in Safari. Cmd+A, Cmd+C and Cmd+V of text copied inside
  the device worked. The device's log said why: `pasted` asked to prompt,
  and SpringBoard refused it, as `pasted` lacks the entitlement
  `com.apple.springboard.CFUserNotification`. TCC recorded the app's
  `kTCCServicePasteboard` as 3, limited.
- **Allowed, it pastes.** With that row set to 2, allowed, in the device's
  own `TCC.db`, Cmd+V pasted at once, in the app and in Safari, with no
  restart. This is iOS's per-app 'Paste from Other Apps: Allow'.
- **The keyboard's suggestion and the edit menu also paste,** with no
  prompt, but neither serves: the suggestion shows only when a field begins
  editing, and the menu needs a tap on the caret, which moves it.

So the server pastes this way: put the text on the device's pasteboard,
allow pasting from other apps for the apps running in the device, press
Cmd+V on the HID stream, then put the pasteboard back, and the apps' paste
setting 5 s later.

After each such paste, iOS shows '<app> pasted from CoreSimulatorBridge'
at the top of the screen. While it shows, the device takes no keys:

| Keys after a paste | Runs | Lost |
| --- | --- | --- |
| 16 letters, 240 ms apart, from 0.1 s after the paste | 3 | the first 10, to 2.4 s, in each |
| 2 taps at 0.3 and 0.6 s | 1 | none |
| 16 letters after a swipe up on the notice | 2 | none |

So the server holds keys, not touches, for 2.6 s after a paste. A swipe up
dismisses the notice, but the notice has no element in the accessibility
tree to find, so the server never swipes blind.

E21, putting the pasteboard back: 15 pastes, 3 at each of 0, 10, 25, 50
and 100 ms after the paste key's release, each then followed by `pbcopy`
of other text. All 15 pasted the new text. `pbcopy` itself takes 100 to
170 ms, so the server waits 100 ms more and puts the pasteboard back.

What else pasting does on iOS:

- **iOS adds a space before pasted text that follows a word,** its smart
  paste: 'üße' pasted after 'Gr' gave 'Gr üße', an emoji pasted after
  Arabic letters gained a space, and so did こんにちは pasted after '!'.
  Japanese after Japanese, and Arabic after Japanese, gained none.
- **So letters with an accent go as keys,** with Option as a Mac's keyboard
  types them: Option+u then u gave ü, Option+s ß, Option+e then e é,
  Option+n then n ñ, Option+c ç: 'grüßéñç' arrived exactly.
- **And the agent's text is pasted in as few pieces as it can.** A run of
  spaces and punctuation between two pastes joins them: 'Grüße, señor. 日本
  😀 مرحبا!' arrived exactly in 3.0 s, as keys and one paste, and the
  device's pasteboard held its own text again after.
- **A person's text from keys is gathered for 0.5 s,** not 063's 150 ms, so
  a slow typist's word is one paste, not several with spaces between.

### Control's owner

The plugin tells the server control's owner, with a generation that only
rises, at each change and on each new control connection.

- **Halfway through the agent's swipe.** A 2 s swipe up the page's list
  scrolled it to 230 when left alone. Taken over 0.8 s in, the list stopped
  at 76, the touch was lifted at once, and the agent's answer was
  `person-has-control`. Its next input was refused the same way, and one
  sent under the old generation after hand-back was refused as
  `superseded`.
- **Halfway through the agent's paste.** Taken over 150 ms into a paste of
  '中断されるテキスト', the paste was dropped before its paste key: the field
  stayed empty, the device's pasteboard held 'kept on the device' again,
  and the server logged that it put it back.
- **A reload while a person holds control.** The harness was stopped and
  started again mid-drag, as bb-box is in a reload: the server lifted the
  person's touch as the old input connection ended, the new instance took
  the lease and said the person had control, the viewer connected again by
  itself, and its next tap landed.

### The person's text and pointer

Through the viewer, into the probe app's field and a page in Safari:

| What the person did | What arrived |
| --- | --- |
| An input method composing 'nihongo', then committing 日本語 | 日本語, as one text message, one paste |
| Arabic letters as keys, as from an Arabic keyboard layout | مرحبا, as one paste |
| An emoji, inserted as the Mac's emoji picker inserts | 😀 |
| Dead keys, through Type text: ' crème brûlée, naïve façade' | exactly, as keys |
| Cmd+V of ' Привет' from the computer's clipboard | ' Привет', left on the device's pasteboard, as on desktops |
| One wheel notch, in Settings | a row moved 94 points; another notch, 95; two back, to where it began |
| A trackpad's 160 pixels | a row moved 64 points, with no fling |
| Alt and drag | a pinch, as under E9 |

The first wheel version lifted 100 ms after its last move, and iOS flung
the list to its end: it keeps a drag's speed when the finger stops sending.
The swipe now eases out, and the finger reports its place, one pixel either
way, every 16 ms until it lifts.

### What limits these numbers

- One device, the iPhone 18 Pro, on one Mac; the iPad and the iPhone 17 were
  not driven.
- Chrome was headless on the box's own macOS, so decoding shared the box's
  cores with the device and the builds.
- The pages and the probe app are small; an app's own paste handling,
  such as one that reads the pasteboard itself, was not tried.


## Unit 6.3: the iOS controls and box_device

Measured on 26 October 2026 in one Tart macos-desktop box at the ios kind's
default size, 6 cores and 16 GiB, cloned from the standard macOS image
(build.20261022-033224-9658): macOS 27.0, Xcode 27.0, iOS 27.0 (24A434),
idb_companion 1.7.7. The ios kind was not offered on the production BB that
day, so the box ran the iOS image's layer, `build-ios.sh`, and its record,
as unit 4.2's boxes did. The device server was version 7 from this unit's
checkout, delivered as bb-box delivers it.

The harness, `controls.ts` in
[scripts/measure/ios](../../scripts/measure/ios/README.md), runs the
plugin's own `DeviceServers` and box_device's own parsing and words against
the box's device server, so each line below is what the agent reads. BB's
server and the panel are not in these numbers. Each effect was seen in a
screenshot taken after the answer.

### Each action, on the iPhone 18 Pro

Server time is from the request to its answer, read-back included.

| Action | Server time | Seen |
| --- | --- | --- |
| home | 563 ms | Settings closed to the Home Screen |
| lock | 1.7 s, until the lock state reads locked | the lock screen; the state says asleep |
| wake | 1.2 s: Home twice, as the first shows the lock screen | the Home Screen |
| rotate, turn left or right | 260 to 270 ms | Safari turned; the stream 2622x1206 sideways, 1206x2622 upright |
| rotate, to an orientation | 242 to 245 ms | the same |
| appearance | 381 to 444 ms | dark and light |
| text_size, each of the 12 content sizes | 356 to 486 ms | each read back as set; the largest made Safari's toolbar larger |
| text_size, larger, smaller, default | 462 to 487 ms | a step up or down, and `large` |
| status_bar clean | 459 ms | 9:41, full signal and Wi-Fi, a full battery |
| battery, 42%, not charging | 488 ms | the status bar's battery at 42% |
| status_bar live | 334 ms | the time and battery live again; the answer says "The status bar is live again, so the battery shows the Mac's." |
| location, set and cleared | 239 to 241 ms | in Maps, the blue dot at Elizabeth Tower, then at Tokyo Tower |
| install, a .app built for the simulator | 6.4 to 6.8 s; 0.3 to 0.6 s again | the app installed and launched |
| switch, to the iPhone 17 and back | 8.1 to 8.4 s | each model with its own settings |
| reboot | 6.7 to 8.8 s, to the first frame | the device back, with its settings |
| back, recents, posture, network | refused at once, unsupported | |

On the iPad Pro 13-inch (M5), rotate, appearance, text_size and the status
bar did the same; its Home Screen turns, so the stream went to 2752x2064.

Refused with bad-value, in words: a turn with `to` as well, a font scale on
iOS, half of latitude and longitude or of level and charging, a latitude of
91, a parameter of another action, a device build of the app, an `.ipa`,
and a path with no app. A model the box does not offer is unknown-device.

### Read-backs

Each command 10 times, one after another, in the box:

| Read | Time |
| --- | --- |
| `simctl ui appearance` | 89 to 119 ms |
| `simctl ui content_size` | 90 to 110 ms |
| `simctl status_bar list` | 89 to 104 ms |
| the lock state, `notifyutil -g com.apple.springboard.lockstate` | 102 to 117 ms |

The server reads appearance, text size and the lock state together, in 122
to 126 ms on the iPhone and 180 to 357 ms on the iPad, when a client
connects, after each control, and every 10 s while a viewer watches. After
`xcrun simctl ui booted appearance dark` in a shell, a watching viewer's
state said dark, changed outside bb-box, 1.0 s later.

### Requests by ID

- **Twice with one ID:** a turn left sent twice with one ID turned the
  device once; the second answer and the result asked for after were the
  first, twice over.
- **A lost connection:** with the plugin's connection ended 50 and 150 ms
  after it sent a turn, the plugin connected again and asked for the answer
  by the request's ID. The device turned once, and the answer came 1.3 s
  after the request.
- **A person's control:** the plugin refused Home at once; the server
  refuses it too, which its tests check. An install of an app the device had was refused; an
  install of an app it did not have ran.

### E11: which way left and right turn

idb's screenshot is the device's own framebuffer, upright whichever way the
device is held. After `turn: "left"` the picture's top was at the
framebuffer's right edge, on the iPhone in Safari and on the iPad's Home
Screen, whose dock was at the left edge. So the device's top points left: a
quarter turn anticlockwise, the way the toolbar's left arrow points, and
right is clockwise. idb's `set_orientation` names these LANDSCAPE_LEFT and
LANDSCAPE_RIGHT, and `get_orientation` reads them back.

### What this found

- **simctl reads two sizes in another case:** `extra-Small` and `Small`,
  though it takes them as `extra-small` and `small`. The server reads
  without regard to case.
- **A reboot leaves idb_companion's HID connection dead:** "The dtuhidd
  connection ... has been invalidated". So Home, lock and every touch after
  a reboot failed. The reboot now starts a new companion. The server's
  restart of a device that stopped by itself keeps its companion, and so
  may meet the same.
- **A locked simulator keeps drawing its lock screen.**
  `hasBlankedScreen` turns 1 only 1 to 3 s after the lock, but the lock
  state at once, so the state's `awake` is the lock state.
- **`charged` at 100% draws a charging bolt,** which a clean status bar
  should not have, so a battery not charging is `discharging`.
- **A reboot clears the status bar's overrides,** and so does switching
  back to a model, which boots it again. bb-box sets them again, and the
  location, which simctl cannot read back, each time it attaches to the
  device.
- **An iPhone does not draw upside down,** so a turn to upside-down leaves
  the picture as it was, and its answer waits its 1 s for a new picture.
- **The stream's first frame after a turn comes after `set_orientation`
  answers.** A turn's answer waits up to 1 s for it, so the state it gives
  has the new size: 0.25 s in Safari.
- **A large screenshot overflowed the parser:** the base64 check backtracked
  through a 5 MB PNG of the iPad held sideways and ran out of stack. It is
  now one character class and a length check, and a 12 MB still parses.
- **`simctl io screenshot` turns with the app,** as the stream does, and
  idb's does not. That is a way to the sideways screenshots unit 5.2 left
  for 7.1, at a cost not measured here.
- **Recents:** no way was found. Cmd+Tab, Cmd and the up arrow, a slow swipe
  up from the bottom edge, a hold there, and Home pressed twice 100 and
  250 ms apart all left Settings in front. Recents stays refused on iOS.

### Not checked here

- Through the panel: the toolbar is unit 6.4, and BB's panel needs a
  person's session.
- Android: its driver's controls are unit 6.2's. The shared parts, the
  parsing, `supports` and the words, cover Android's actions in tests only.
