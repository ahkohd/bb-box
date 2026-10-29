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
are [after them](#unit-63-the-ios-controls-and-box_device): each action,
its read-back, requests by ID, and E11. Unit 6.1's, for the frame, follow,
then unit 6.4's, for the toolbar. Unit 4.1's, for the Android driver, are
[after them](#unit-41-the-android-driver): the stream of each model,
recovery, E3 and E23. Unit 7.1's, for the computer tools on an iOS device,
are [after them](#unit-71-computer-use-on-an-ios-device). Unit 7.4's, for
recording a device, are [after them](#unit-74-recording-a-device): the
clips, the server killed mid-recording, and E15. Unit 7.5's, for spares
and copying from a device, are [at the end](#unit-75-spares-and-copy-from-a-device):
E16, E24, a suspend that did not restore, and the clipboard in the panel.

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

First the build's Android layer, `customize-android.sh`, ran in a box, then
the refresh's own script in that box, then the image's check,
`bb-box-check-android`, in both boxes. Then the lead built the template on
the Proxmox host with `build.sh android`, and its refresh ran through the
production BB, which has the Proxmox API token: [the template, built and
refreshed](#the-template-built-and-refreshed), below.

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
removed, `bb-box-emulator` refused to start the device.

No tailnet peer was tried, and none is needed for these boxes: Proxmox
boxes never join the tailnet, which only cloud backends' boxes do (050).
The firewall drops the device's ports on every interface but loopback, so
`tailscale0` is one more interface it drops on. A later backend whose
android boxes join the tailnet runs the probe from a tailnet peer then.

### Identity

Each box made its own adb key, console token and gRPC token: their SHA-256s
differed. The device's own serial, `EMULATOR37X2X12X0`, and whatever else
the snapshot holds, such as the device's Android ID, are the same in every
box from one template.

Two android boxes were not compared: android is not an offered kind until
unit 4.1, and the refresh's own clones are bb-box's, which no agent tool
enters. Unit 4.1's checks through BB compare two android boxes: their adb
keys, console and gRPC tokens, and Android IDs. The trial box of each
refresh below checked that its adb key and console token did not come with
the image.

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

### The template, built and refreshed

On 26 October 2026 the lead ran `build.sh android 1000 --with-x264` as
root on the Proxmox host, after the owner accepted the Android SDK's terms
with `accept-sdk-licence.sh`. The first build failed its own check: the
check read its devices from the image's record, which `finalize.sh` writes
only after the check, so the cloud image had none yet (fixed in #1148). The
second made build.20261026-151250-3f0c. Every line of its checks passed,
and a clone of it hibernated in 14.9 s and resumed in 7.9 s. With
`android-templates` set to 1000, `bb box doctor` passed the template, its
image, KVM for Android and Disk for Android.

Through the production BB:

| | `bb box images build proxmox-qemu/1000 --try` | `bb box images build proxmox-qemu/1000` |
| --- | --- | --- |
| Took | 335 s | 344 s |
| A box of the new build answered in | 10.3 s, the old's in 10.2 s; 8.6 s of each the network | 9.3 s, the old's in 9.3 s |
| `bb-box-check-android` on the trial box | 45 of 45 lines ok | 45 of 45 lines ok |
| BB's app | the box's, the record's and the server's the same | the same |
| The record | contract 1, Ubuntu 24.04.5 LTS, 15 tools; no tool older | the same |
| Afterwards | build.20261026-151250-3f0c stayed | template 1000 is build.20261026-153035-77eb; the build before is kept as its rollback |

`bb box images list` then said of it: "built today; not due; last rebuild
2026-10-26 passed".


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
| 24 h | did not resume: started at 11:17 UTC on 27 October, about 24 h after its suspend at 11:16 UTC on 26 October, the VM booted cold (macOS's boot record has no boot between 26 October 10:05 and 27 October 11:18), so Tart had not kept its saved state. box_start took 33.8 s. The server started at login and booted the device in 7.5 s, slim as before | a viewer's first key frame 6.0 s after it asked, as a new companion's first stream after a boot is slow | 10 taps changed the screen in 34 ms at the median, 75 ms at worst | the status bar said 11:19 on Tuesday 27, as the Mac did |

The 62-minute run was in a second box, which ran the device server as it
was before its last changes, none of them to the driver's resume. The 24 h
run was the same box, with the same server, version 3. Its suspended
state was not restored because Tart refused it: bb-box's log has
`VZErrorDomain Code=12 "The virtual machine failed to restore with error
'invalid argument'"`, after which bb-box booted the VM from its disk and
warned, as it does after an update. Neither applied: the Mac had been up
for 3 days and Tart (2.40.1) had not changed since 22 October. Whether a box
suspended for a day resumes is still open, and so is a spare that waits a
day suspended (unit 7.5). After the cold boot, idb_companion's resident
memory stayed at 56 MiB over 60 s while the screen changed; that companion
started after a boot, not across a resume, so it says nothing of the leak
below, which resident memory also hid (80 to 101 MiB while its footprint
was 34 GB). Its screen
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

## Three fixes from live checks

Checked on 26 October 2026 on the production BB and in one Tart
macos-desktop box, 6 cores and 16 GiB, made as unit 6.3's box was: the
standard macOS image (build.20261022-033224-9658), the iOS image's layer
from `build-ios.sh`, and its record. The device server came from this
checkout, version 7 before the fix and version 8 after it.

### "No backend offers ios boxes"

Unit 6.3's builder was refused an ios box with "No backend offers ios
boxes (iOS Simulator) now", and box_list had no ios kind. The Tart Mac was
at Apple's limit of two macOS VMs then, but that was not the cause. Asked
for an ios box while the Mac was full again, the production BB already
gave the right refusal, through box_acquire and through
`bb box acquire`: "No Mac can take this ios box: Two macOS VMs already run
on the Mac, Apple's limit (box ... of thread ..., box ... of thread ...).
Release or stop a macOS box, or stop another VM there."

The cause was timing. The Tart backend offers ios only once a Mac's record
of the iOS image lists its devices, and it reads that only after bb-box
starts. The refusal came 6 seconds after a box_list, a few minutes into a
deploy that restarted bb-box, so the first read of the Mac had not
answered. Every other backend's kinds come from its settings or from
what its host already said, so ios on Tart was the only kind hidden this
way.

Now a backend can name the kinds it withholds and why, once it has read
what decides them. Before acquire refuses a kind no backend offers, it
asks. Tart reads its Macs then, so after a restart the ios box is placed,
or refused for room, as any kind is. When a Mac still does not offer ios,
the refusal says why:

- a Mac that did not answer: "No ios box (iOS Simulator) can come now.
  Tart on the Mac offers them, but not now: the Mac did not answer, so
  bb-box cannot read which devices its iOS image offers: ...", as
  no_capacity
- an image with no devices: "... the iOS image bb-box-ios on the Mac lists
  no iOS devices in its record, so there is none to boot. bb box doctor
  says why.", as unknown_kind

### Input after a device boots again

A device's input goes through idb_companion's HID connection, which dies
when the device shuts down: "The dtuhidd connection
(com.apple.coredevice.feature.remote.hid.digitizer) has been invalidated".
Unit 6.3 made the reboot control start a new companion. Two more ways
boot the device and kept the old one: the server's restart of a device that
stopped by itself, and slimming's reboot when the server attaches to a
running device that has a service of its list on.

| Path | Version 7 | Version 8 |
| --- | --- | --- |
| The device shut down from outside (`simctl shutdown`); the server booted it again | the same companion kept (pid 11798); lock: "The device was locked, but it still reads unlocked after 3 s"; the companion's log: the HID connection invalidated | a new companion; lock and wake work; a tap on Settings opened it |
| One service of the slimming list turned on, then the server killed; launchd started it, and slimming rebooted the device | the same companion kept (`companionKept: true`); lock failed the same way, the HID connection invalidated | a new companion (`companionKept: false`); lock and wake work |
| The reboot control | a new companion, from unit 6.3 | a new companion; lock and wake work |

The fix is in one place: whenever the device boots while the server starts
it, the server starts a new companion. Only a reattach to a device that
kept running, with no reboot, keeps the one it has.

A device takes a few seconds to take input after it boots. After a stop by
itself, the server says it is back about 2 s after the stop, but the first
lock that took was sent about 7 s after that. In 2 runs, locks sent in the
first 6 s did not take, though the companion sent each press and none
failed on its connection. The reboot control waits for a
new picture before it answers, so a lock right after its answer took.

### The image's check reads each control back

`bb-box-check-ios` now checks, on each model, what box_device reads back:
dark and light, and each of the 12 text sizes, set and read back, then the
first set again; an override of the time and battery listed, then cleared;
and the lock state read as unlocked after boot.

Run in the box on all three models, the check passed every line, 36 of
36. Each model took dark and light, and all 12 text sizes, and read each
back, then went back to light and large. Each listed its status bar
override, then none once cleared, and read unlocked just after boot.

## Unit 6.1: the device frame

Measured on 26 October 2026 in one ios box acquired through the production
BB, on Tart, at the kind's default size, 6 cores and 16 GiB: macOS 27.0,
Xcode 27.0, iOS 27.0 (24A434), idb_companion 1.7.7. The device server was
this unit's, delivered from its checkout as bb-box delivers it. The panel's
own client, `SelkiesSession` with its new `DeviceStage`, ran in Chrome 156,
headless, on the box's macOS, behind the plugin's own relay, with BB's theme
loaded from BB's source: the harness in
[scripts/measure/ios](../../scripts/measure/ios/README.md). BB's server and
the panel through it are not in these numbers. The owner's checks of the
panel are listed under [Not checked here](#not-checked-here-1).

### What iOS does when it turns

Turns were sent as idb's HID orientation event, with the device's Safari
showing a page.

- **idb's HID orientation event counts from 0:** 0 upright, 1 upside down,
  2 turned right, 3 turned left. Its orientation read uses iOS's own
  numbers, 1 to 4, and 0 before the first turn, which the server takes as
  upright.
- **The video turns with what iOS draws,** as E8 found: turned left, the
  stream is the device's own picture turned a quarter anticlockwise, with
  the island at the left; turned right, at the right.
- **An iPhone does not draw upside down,** as 6.3 found, and keeps the side
  it was drawn on before: turned right, then upside down, the stream stays
  2622x1206 with the island at the right. **An iPad draws upside down:**
  idb's screenshot then has its interface upside down in the device's own
  picture, and the stream shows it the right way up.
- **iOS changes its layout 8 to 70 ms after the turn reads back,** in most
  turns, and 2.5 s after it once, in the box's first turn after it started.
  So a turn is two changes of geometry: the turn, then the new size.
- **The video, idb's screenshot and the video's island.** The stream draws
  the Dynamic Island as a black pill, and idb's screenshot does too;
  `simctl io screenshot` leaves it out. The island measured from the
  stream, upright: on the iPhone 18 Pro 284x110 pixels at (461, 42); on the
  iPhone 17 376x110 at (415, 42). The model table had 374x110 at (416, 33)
  for both, and now has these. The frame draws its island over the
  stream's, in place. Neither the stream nor the screenshot rounds the
  screen's corners, so the frame clips them.

### The first key frame of a sideways stream

Unit 5.2 found that a stream started while the picture is sideways sends
one key frame upright-sized, its picture on its side, then the right one.

| | Before | After |
| --- | --- | --- |
| A key frame asked for on a busy screen while sideways, 5 times | each restart sent 1206x2622 then 2622x1206, 50 to 80 ms apart: two new geometry generations a time | the first is dropped when the second follows within 150 ms; one generation, as before the restart |
| The server started with the device sideways | two generations | one |
| On a still screen | the second key frame came 51 ms after the first | the same |

The server drops it in the video, not the panel, so the agent's points and
the person's touches see one geometry, and none of its touches are lifted
by a change that was never there.

### Turns in the panel

`drive.ts turn` sent each turn through idb and logged, on every animation
frame, the frame's angle, the veil and which picture the panel showed. The
server reads idb's orientation every 250 ms while the screen changes and
every 2 s while it is still, so a turn made outside bb-box, as here, raises
the geometry generation; box_device's rotate goes through the same step.

| Model | Turns | Turning | Frames while turning | Gap between frames | New picture after the turn |
| --- | --- | --- | --- | --- | --- |
| iPhone 18 Pro | upright, left, right, upside down, upright | 267 to 283 ms | 19 to 20 | 16.7 ms at the median, 16.8 ms at worst | 301 to 304 ms |
| iPhone 17 | left, right, upside down, upright | 267 to 283 ms | 19 to 20 | 16.7, 16.8 ms | 301 to 303 ms |
| iPad Pro 13-inch (M5) | upright, left, right, upside down, upright | 267 to 283 ms | 19 to 20 | 16.7, 16.8 ms | 301 to 305 ms |

The animation is 300 ms; the first and last frames that moved are 267 to
283 ms apart. In every turn the new picture had come before the turn ended,
so the panel showed it as the turn ended and the veil never showed. The
turned old picture held until then, as 063 asks.

What the first runs found, and the panel now does:

- **The second change cut the turn short.** The size change 8 to 70 ms
  after the turn ended the animation, and the frame snapped. A change that
  comes while the frame turns now waits for the turn to end.
- **A half turn waited 1.6 s under the veil:** a key frame by restarting
  idb's stream took that long while iOS changed its layout. The frames that
  come anyway now carry the new generation, and the stream restarts only if
  none comes within 100 ms.
- **Upside down after the server restarted showed two islands:** the server
  had forgotten which side the iPhone last drew on, and guessed. It now
  reads the side from its own state file when it attaches, and keeps the
  last sideways side through an upright-sized frame.

### A tap after a turn lands where it is drawn

`touch.html` in the device's Safari put a red dot where each touch landed.
`drive.ts landing` took a pixel of the picture, pressed where the panel drew
it, and read the same pixel after: 16 of 16 taps landed where drawn, on the
three models, upright, turned left, turned right and upside down. Taps that
began where a dot already was are not counted.

### The agent's screenshot, turned

The agent's screenshot is idb's, which is the device's own picture whatever
way the device is held. The server now turns it as the video is drawn, so
its pixels are the video's and a point in one is a point in the other.

| iPad Pro 13-inch (M5), 5 each | Size | Time, at the median |
| --- | --- | --- |
| upright | 2064x2752 | 141 ms |
| turned left | 2752x2064 | 196 ms |
| upside down | 2064x2752 | 286 ms |

Each read upright. Turning costs 55 to 145 ms on the iPad's 5.7 million
pixels, most of it compressing the PNG again. Stills, for browsers that
cannot play the video, come the same way.

### What watching the orientation costs

On a still screen, over 20 s: the server took 0.001 to 0.002 of a core and
idb_companion 0.002 to 0.004, as unit 4.2 measured without the watch.
idb_companion logs two lines for each read, so the watch slows to every 2 s
while the screen is still.

### Foldables, drawn from the table

No Android device has run in a box yet, so the Pixel Fold, the Pixel 8 and
the Pixel Tablet were drawn by `frames.html` from the model table, with a
test card for a picture, in both themes, upright and turned. The fold's
times, with the new picture 600 or 900 ms after the change, as a device
would send it:

| Change | Moving | Frames | Gap between frames | Veil | Picture |
| --- | --- | --- | --- | --- | --- |
| open to closed, 2 times | 500 ms: 350 folding, 150 fading | 31 to 32 | 16.7 ms at the median; 33.4 ms at worst once, 16.8 otherwise | from 503 to 509 ms | at 606 to 613 ms |
| closed to open, 2 times | 500 ms | 32 | 16.7, 16.8 ms | from 503 to 504 ms | at 606 ms |
| closed to half open | 500 ms | 32 | 16.7, 16.8 ms | from 504 ms | at 906 ms |
| half open to closed, the picture at 100 ms | 500 ms | 31 | 16.7, 16.7 ms | none | held to 501 ms |

### Booting, asleep and failed

Drawn by `frames.html` with each state: booting shows the model's name and
'Booting' on a black screen; asleep, the last picture dimmed, 'Asleep' and
**Wake**; failed, the model, the error's words and **Reboot device**. Wake
and Reboot device take control first when the viewer does not have it.

### What limits these numbers

- Chrome was headless, on the box's own macOS, at a device pixel ratio of 1,
  and drew on the CPU; a person's browser on a display with a GPU may draw
  more smoothly, not less.
- The turns were idb's; box_device's rotate goes through the same step in
  the server, but was not driven here.
- The Android frames are the table's numbers: no Pixel has been seen in a
  frame beside its own picture.

### Not checked here

- **For the owner, in the panel through BB:** the frame on each iOS model in
  both themes; a turn by box_device's rotate and by Rotate in a later
  toolbar; Show frame and Pixel for pixel under Display in the menu, kept
  for the box; the frame in a narrow panel, at 360 px; on a phone's BB;
  with reduced motion; and whether the body's graphite, the light edge in
  the dark theme and the shadow in the light one look right.
- **For Android, once its template is built:** the Pixel 8, Pixel Fold and
  Pixel Tablet in their frames beside their own pictures; whether the
  emulator's stream turns with what Android draws, as iOS's does, which the
  frame assumes; a fold and an unfold by `adb` and the emulator's posture,
  with the stream's change of size; the Pixel Fold's half open posture; and
  each model's bezel, corner and button numbers against the device.

## Unit 6.4: the toolbar

Checked on 26 October 2026 on a physical pool Mac lent whole, through
`macos` on the SSH host pool, as no Tart VM was free: macOS 27.0.1, Xcode
27.0, iOS 27.0 (24A434), idb_companion 1.7.7 unpacked in the box user's
home, as the user has no sudo, and the device server of this unit started
by hand, with the iPhone 18 Pro, iPhone 17 and iPad Pro 13-inch (M5) the
Mac already had. The panel was the plugin's own `DesktopViewer`, with
the toolbar, its menus and the picker, built with BB's theme and run in
headless Chrome on the same Mac, behind the plugin's own relay, against
`viewer.ts` standing in for the plugin: the harness in
[scripts/measure/ios](../../scripts/measure/ios/README.md#the-panel). The
same page ran on a Linux box with the test device, as an iOS and as an
Android device, in Google Chrome 156. BB's server and the panel through it
are not in these checks.

### Each control, clicked, on the iPhone 18 Pro

Each click took control first, as the agent had it, and the toolbar said
"You have control. Hand back when done."

| Control | Seen |
| --- | --- |
| More, Open link, "example.com" | Safari opened https://example.com: the note said "Opened https://example.com on the iPhone 18 Pro." |
| Home | Safari closed to the Home Screen |
| Dark appearance | dark mode; the button pressed, its icon a moon |
| Rotate left, then Rotate right | the frame turned, the bar moved beside it, and back |
| Text size, Larger three times | the widgets' text larger; the popover said "Extra extra large", then Default gave "Large, the default" |
| More, Clean status bar | 9:41, full signal and battery; the note gave the decision's words |
| More, Battery, 42 | the status bar's battery at 42%; the note said only the picture changes |
| More, Location, New York, then No simulated location | "Set the iPhone 18 Pro's location to New York, 40.7128, -74.006 in 0.2 s.", then cleared |
| More, Lock, then Wake | the lock screen, dimmed, with Asleep and Wake; then the Home Screen |
| Copy screenshot | "Copied the iPhone 18 Pro's screen.": a PNG of 1206x2622, 3.0 MB, 143 to 155 ms through `deviceScreenshot`, three times, without taking control |
| More, Reboot device | booting, then back in 7.2 s, its status bar overrides set again |
| The picker, iPad Pro 13-inch (M5), iPhone 17, iPhone 18 Pro | below |

On Android, as the test device, the bar had Back and Recent apps, and More
had Battery and Network and no Clean status bar. Fold was not seen: no
foldable has been offered yet.

### The picker and a switch

The picker listed the three models, the iPhone 17 with "Not started in this
box yet, so it may take a minute." under it. A switch to it took about
16.4 s from the click to its first frame, 11.5 s of it booting; the bar and
the picker waited, saying "Switching to the iPhone 17…". A switch back to the
iPhone 18 Pro, started before in this box, took 7.3 s, 1.5 s of it booting,
and its note said "Apps are per device. Install your app again on the
iPhone 18 Pro if it needs it."

The first switch, to the iPad, stopped the device server: unit 6.1's watch
of the orientation read idb_companion's client while there was none, and
the error went unheard. The watch now skips a device that is not booted,
and a read that fails is no turn. The server, started again, finished the
switch from its intent, as 063 says it should.

### Narrow, zoomed, touch, keyboard and screen reader

- **360 px**, with touch: one row under the device, Home, Rotate left and
  More, 44 px targets, and "Using a control takes control from the agent."
  under it until the first tap. A tap took control and turned the device.
- **479 and 480 px**, and 1100 by 900 px at 200% zoom: the row where the screen
  beside the bar would be under 280 px wide and the row leaves it wider. At
  200% zoom the panel's height limits the device, so the bar stays beside
  it: the row would only make the phone smaller.
- **Keyboard**: the bar is one Tab stop; the arrow keys, Home and End move
  along it; Enter on Dark appearance took control and kept the focus on the
  bar; Enter on Text size opened it with the slider focused, which the arrow
  keys, Home and End move; Escape closed it back to Text size; Enter on
  More, then Open link, focused the field, and Enter opened the link.
- **Screen reader**: Chrome's accessibility tree, as a screen reader reads
  it: a toolbar named "iPhone 18 Pro controls", vertical or horizontal; each
  button named; Dark appearance pressed or not; Text size and More with
  their popups; while the device switches, each control unavailable with
  the reason as its description; the slider's value as words, such as
  "Large"; and the changes read out from a live region, such as "Turned
  left. Dark appearance."
- **The agent while a person holds control**: box_device's home, sent as
  the plugin sends it, was refused with `person-has-control` and its words.

### What this found

- **The plugin's relay dropped the device server's answers** to the
  person's controls: only the clipboard and the cursor came back from the
  input connection. The panel now gets them, and keeps only its own by ID.
- **A toolbar control by the keyboard lost the focus** to the device, as
  taking control focuses it. A control from the keyboard now leaves the
  focus on the bar; one from the pointer gives it to the device.
- **The touch note covered the screen** in a row at the panel's foot. The
  row now leaves room for it while it shows.

### What limits these checks

- Chrome was headless, on the box's own Mac or Linux. Its clipboard took
  the screenshot, but whether a person's browser lets a click copy a
  picture, or downloads it instead, was not seen.
- The pool Mac's simulators were not the iOS image's: not slimmed, and its
  idb_companion was not where the image puts it.
- No screen reader was run: the accessibility tree is what one reads.

### Not checked here

- **For the owner, in the panel through BB:** each control, the More menu,
  the picker and a switch; the bar in both themes; at 360 px, on a phone's
  BB with touch; and VoiceOver or another screen reader on the bar.
- **For Android, once its driver is built (unit 6.2):** Back, Recent apps,
  Fold and Network driven on the emulator, and their effect seen.

## Unit 4.1: the Android driver

Measured on 26 October 2026 with the harness in
[scripts/measure/android](../../scripts/measure/android/README.md#the-device-servers-driver),
in a Linux VM box on Proxmox QEMU with KVM, 16 cores and 32 GiB, on the AMD
Ryzen Threadripper PRO 9975WX host. The box ran the Android template's
layer, `customize-android.sh` with x264, as the template's build does: in
168 s, with the three devices booted once and saved. The device server was
this unit's, delivered from its checkout as bb-box delivers it. Every
number is in the box, from a viewer on the server's socket: BB's relay,
the network and the browser are not in them. Nothing was pinned, so the
emulator could use all 16 cores.

### How the driver runs the device

- **The emulator runs in a service of its own,** the box user's
  `bb-box-emulator@<avd>.service`, which the server writes. It checks the
  device's firewall before each start, starts the emulator with no window
  and its gRPC behind a token made new at each start, and saves the
  snapshot when it stops, through `adb emu kill`. A restart of the server
  leaves it running.
- **Attach and reattach.** The server finds a running emulator by its
  discovery file under `/run/user/<uid>/avd/running/`, whose process must
  be alive; files of dead ones are removed. It reattaches to one running
  the target device, stops one running another, and otherwise starts the
  target from its snapshot. The gRPC token is read from that file.
- **Frames.** The server asks the emulator's gRPC for its screen in RGB by
  shared memory, in `~/.bb-box/device/frames`, sized for the largest
  screen, 12.3 MB, and feeds `bb-box-h264` an `S` command for each frame. A
  key frame on demand is the helper's `K`: the last picture again as an
  IDR, with SPS and PPS. A change of size or orientation starts a new
  generation.
- **The emulator's picture turns with the device as it is held,** not with
  what Android draws. Turned by the console's `rotate`, the stream went to
  2400x1080 with the cutout's black band on the right: the picture upright
  to the viewer, the device turned right. Held upside down, Android kept
  Settings in its last landscape rotation, and the picture was 1080x2400
  with Settings sideways in it. So the driver reports `content` as
  `physical`, which is what the frame needs to draw the picture the right
  way up, and 063's note says so.
- **Android's clock.** A device booted from a snapshot keeps the clock it
  had when the snapshot was saved: 64 to 551 s behind the box's, after
  snapshots 1 to 9 minutes old. The server sets it at each boot and
  reattach, and after a resume, with `su 0 toybox date`, to within a
  second.

### The stream, each model

Busy is unit 2.4's load, `adb shell input swipe` up and down the launcher's
list. Windows of 5 s, two or three each. Cores are shares of one core.

| Model | First frame after a viewer asks | Frames a second, busy | Mbit/s, busy | Gaps between frames, busy: median, worst | Server: cores, resident | bb-box-h264: cores, resident | Emulator: cores busy, resident |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Pixel 8 | 4 to 5 ms | 57.4 to 58.6 | 7.6 to 7.8 | 16 to 17 ms, 33 to 43 ms | 0.022 to 0.032, 102 MiB | 0.46, 46 MiB | 8.8, 4.0 GiB |
| Pixel Fold, open | 13 ms | 34.4 to 34.6 | 4.5 to 4.7 | 28 to 29 ms, 72 to 115 ms | 0.018, 101 MiB | 0.37, 64 MiB | 11.0 to 11.8, 6.2 GiB |
| Pixel Fold, closed | | 53.8 | 7.1 | 19 ms, 23 ms | 0.024 | 0.33 | 7.1 |
| Pixel Tablet | 5 ms | 27.4 to 31.2 | 3.6 to 4.4 | 32 ms, 54 to 206 ms | 0.014 to 0.016, 101 MiB | 0.29 to 0.33, 65 MiB | 11.1 to 12.2, 6.0 GiB |

On a still screen no frames came. The server and the helper took no
measurable CPU, and the emulator 0.13 to 0.15 of a core. A viewer's hello
came 104 to 113 ms after it connected. The rates are unit 2.4's on 16
cores: the encoder adds nothing visible to the frame rate.

Key frames on request, 10 asks 0.5 s apart on the Pixel 8 and 5 on the
others:

| Model | Still: median, worst | Busy: median, worst |
| --- | --- | --- |
| Pixel 8 | 4.2 ms, 4.9 ms | 6.0 ms, 13.7 ms |
| Pixel Fold, open | | 6.6 ms, 8.8 ms |
| Pixel Tablet | | 6.3 ms, 9.2 ms |

### Recovery

| What happened | Times | What it took |
| --- | --- | --- |
| `bb-box-h264` killed (SIGKILL), busy | 3 | the server started it again and gave it the last frame, which it encoded as a key frame: 13 to 14 ms after the kill; a viewer's stall of 49 to 61 ms |
| The device server killed (SIGKILL) | 3 | systemd started it again; it found the emulator by its discovery file and reattached: hello 1.13 to 1.21 s after the kill, a key frame 1.49 to 1.52 s after it; the emulator kept |
| The emulator killed (SIGKILL) | 2 | the server saw its stream end, and booted it again. Cold, as no snapshot had been saved (below): a key frame 14.95 s after the kill. Before that rule, from its snapshot: 2.7 s |
| The same again within 5 minutes | 2 | the device left failed: "The Pixel 8 stopped twice within 5 minutes, so bb-box leaves it stopped. Reboot the device, or restart the box, to start it again." |
| Reboot, from failed | 2 | stopped, then booted cold: 14.9 s to the answer |
| A switch of model, through a control connection | 5 | the old device stopped and saved, the new one booted from its snapshot, to the answer with its first key frame: Pixel Fold 6.2 and 7.1 s, Pixel Tablet 5.6 s, Pixel 8 4.3 and 5.7 s |
| A fold and an unfold, by the console | 1 each | the stream went from 2208x1840 to 1080x2092 and back, each a new generation, the state's screen inner, outer, inner |
| The agent's screenshot | 1 | the emulator's PNG through gRPC, 46 ms, at the stream's size, 2400x1080 turned |

### E23: what a boot after a kill keeps

Before each kill, a file was written to `/sdcard/Download` and a setting
with `settings put global`, then `sync`.

| The emulator ended by | Next boot | The file | The setting |
| --- | --- | --- | --- |
| SIGKILL | from the last snapshot saved, 063's rule | lost | lost |
| SIGKILL | cold | kept | lost: Android writes settings a moment later, and the kill came first |
| The VM reset (sysrq `b`), 1 s after writing | cold | kept | lost, likewise |
| A clean reboot of the VM (`systemctl reboot`) | from the snapshot the service's stop saved | kept | kept |

An app was then installed, as `adb install -r` of the Calendar app's own
APK, which puts an update in `/data/app`:

| Between the install and the SIGKILL | Next boot | The app |
| --- | --- | --- |
| 2 s | cold | lost: back to the system's copy |
| 30 s, a setting written at the install kept | cold | lost: Android had recorded it, but the APK's bytes had not reached the emulator's disk ("is not zip"), so it went back to the system's copy |
| `adb shell sync`, then at once | cold | kept |

Loading the last snapshot saved puts the device's disk back as it was
then, so an app installed since, or anything else written, is gone. A cold
boot keeps what reached the device's disk, as a phone does after a power
cut. So the service keeps a marker for each device, written at each start
and removed only when the emulator answered `adb emu kill` and ended, which
saves the snapshot. A start that finds the marker boots cold: 14.5 to
15.0 s rather than 2 to 4 s. A clean stop, a switch, and the VM's own
shutdown all remove it. What Android has not yet written to its disk is
lost all the same, as on a phone: `adb shell sync` after an install writes
it, and the skill says so.

### The box's stop and start, a restart and a crash

| What happened | The device | Time |
| --- | --- | --- |
| `box_stop`, a Proxmox hibernation, and `box_start`, after 2 minutes, a viewer watching with the screen changing every second | survived: frames went on at once, `sys.boot_completed` still 1, a key frame on request in 4.8 ms at the median of 5 | the resume, 14.6 s |
| The same: the clocks | the VM's clock came back 2 minutes behind, and `systemd-timesyncd` had not stepped it 3 minutes later, as it asks only every 34 minutes at most. So the server saw no jump, and Android's clock, which follows the VM's, was 2 minutes behind too. Set by hand, as bb-box now does for an android box at `box_start`: the server saw the clock move 116 s, set Android's clock to within a second of it, and restarted the stream | |
| E3: `box_stop`, 61 minutes, then `box_start`, a viewer connected throughout | survived: `sys.boot_completed` still 1, the files written before kept, key frames on request in 4.5 to 14.6 ms. The VM's clock came back 61 minutes behind; set as `box_start` now sets it, the server saw it move 3654 s, set Android's clock, which was 3655 s behind, to the second, and restarted the stream: 54.8 fps busy after it | the resume, 14.2 s |
| `systemctl reboot` | the service's stop saved the snapshot; the server started with the VM and booted the device from it | 16.6 s from the reboot to the device booted, 7.0 s of it after the VM's kernel started |
| The VM reset by sysrq | booted cold, by the marker above | 23.7 s from the reset to the device booted, 14.8 s of it the cold boot |

### Memory after real use

The Pixel 8's emulator held 4,025 MiB just booted. After Chrome opened a
Wikipedia page, then Maps, YouTube, Gmail, Calendar and Settings, each
given 10 s, it held 4,980 MiB, 5.2 GB, and the same a minute later.
Android itself, given 2.5 GiB by the emulator, used 1.4 GiB of it. So the
research's 4.8 to 4.9 GB after use stands, a little over; unit 2.4's 3.9
GiB was the device scrolled, with no app opened.

### What limits these numbers

- One box, of 16 cores rather than the android kind's default 8, on one
  host, with nothing pinned. The frame rates are unit 2.4's at 16 cores.
- The kills were of processes in the box. The 5-minute rule held each
  second kill; a crash loop longer than that was not tried.
- The box was a Linux VM with the template's layer, not a clone of the
  template, as production does not offer android boxes before this unit.
  The template, its record and a box acquired through BB are the lead's
  checks after the deploy.
- The settings lost in E23 were written about a second before each kill.
  How long Android takes to write a setting was not measured.

### Through the production BB

After the deploy, android boxes acquired with `box_acquire` on the
production BB, at the kind's default size, 8 cores and 16 GiB, each a
clone of the Android template.

| Check | Result |
| --- | --- |
| box_list | android, on Proxmox QEMU, with "Devices: Pixel 8 (default), Pixel Fold, Pixel Tablet" |
| A size below the least, `cores: 2` | refused in words: "An android box needs at least 4 cores and 10 GiB memory, not 2 cores, 16 GiB memory: its emulator draws the device on the CPU and holds 4 to 5.5 GiB once booted.", with the presets |
| box_acquire, each model | the box ready in 10.5 to 11.8 s; the device booted from its snapshot 2.3 to 4.0 s after that; its clock 6,369 to 6,464 s behind, as the template's snapshots were made, and set |
| Two Pixel 8 boxes compared | the adb key, the console token and the gRPC token differ, by their SHA-256s; the Android ID, `settings get secure android_id`, and the serial are the same in both, as unit 3.1 found |
| The panel, in the owner's browser | each model in its frame beside its live picture, with the toolbar: the Pixel Fold open with its crease, then, folded by `adb emu fold`, the outer screen in the tall frame with the device's own camera hole; the Pixel 8; the Pixel Tablet in its landscape frame. The Fold's toolbar has Fold; the others' do not |
| A toolbar click | Home on the Pixel Tablet took control, "You have control. Hand back when done.", and was refused in words: "bb-box cannot do that on an Android device yet: touch, keys and paste, and the device's controls, come in a later version." Hand back gave control to the agent |
| E3, 1 hour | `box_stop`, 61 minutes, `box_start`: resumed in 5.9 s, the VM's clock set in 28 ms; the device still booted, its file kept, its clock and the box's the same to the second as the real time. The plugin delivered a newer device server as the box came back, which reattached, set Android's clock, 3,644 s behind, and streamed |
| E23, a restart | an app installed and synced, then `box_resize` to 10 cores with a restart: the snapshot saved as the VM shut down, the Fold booted from it in 4.9 s, the app and the file kept |
| E23, a crash | a file written and synced, then the VM reset by sysrq: the Fold booted cold in 15.7 s, 25.1 s after the crash, with the file and the app |
| E3, 24 hours | a Pixel 8 box stopped at 17:27 UTC on 26 October, `box_start` at 17:28 on 27 October: resumed in 3.7 s, the VM's clock set in 19 ms, 3.9 s in all. The emulator's process was kept: it had run 482 s of the VM's 488 s of running time, which a hibernation does not count. Before bb-box set it, Android's clock was 86,486 s behind, 24 h 1 min 26 s, then 0 s. The plugin delivered device server version 25, whose identity step gave the Pixel 8 its own Android ID in place of the template's, which restarts Android once: 20.9 s, so the device was back 20.0 s after the box was ready. Then a viewer's first frame 21 ms after it asked; still, no frames; busy, 41.6 fps and 5.4 Mbit/s; key frames on request in 4.0 to 4.5 ms, of 5; the agent's screenshot in 119 to 128 ms; gRPC status 0 with this start's token and 16 with a wrong one or none; adb listed the device; the agent's tap on Chrome's icon opened Chrome. The default network was Wi-Fi, VALIDATED, airplane mode off; Android pinged a host in 22 to 26 ms, and Chrome loaded an HTTPS page |

Two things the panel showed:

- **The Box tab names an android box "Linux VM",** as the box's OS, with no
  word of its device, while the Device view's header names the model.
- **box_status says "Desktop control: the agent"** on an android box, which
  has no desktop; the control it names is the device's.

## Unit 7.1: computer use on an iOS device

Measured on 26 October 2026 in one ios box acquired through the production
BB, on Tart, at the kind's default size, 6 cores and 16 GiB: macOS 27.0,
Xcode 27.0, iOS 27.0 (24A434), idb_companion 1.7.7, the iPhone 18 Pro,
slim. The device server was this unit's, delivered as bb-box delivers it:
version 11 before unit 4.1 merged, and version 12, rebased on it, for the
second box's run of the whole check and the typing checks. The harness, `computer.ts` in
[scripts/measure/ios](../../scripts/measure/ios/README.md#computer-use),
runs the plugin's own `DeviceServers` and `DeviceComputer` against it, so
each answer below is what the agent reads, and `check.json` is 063's live
check as one run. BB's server and the tools called from a thread are not in
these numbers: that is the live check after the deploy.

### How the device's tree is read

- **As VoiceOver reads the app.** idb's `accessibility_info` in its nested
  form gave 16 elements for Settings' first page. Asked as an XCUITest
  client, it gave 142, most of them empty groups. Identifiers came either
  way, so bb-box asks as VoiceOver does.
- **Frames are points of the screen as the app draws it,** as E8 found for
  touches. So an element's pixels in the video are its points times the
  model's scale, upright and sideways alike. Sideways, Safari read as
  2622x1206 and a tap by a new reference opened its tab overview.
- **A read takes 38 to 52 ms,** median 43.5 ms over 10 on a still screen.
  The first read after idb_companion starts took 1.1 to 2.9 s.
- **A newly started app shows only the status bar for 3.2 s,** then its
  first read takes 2.6 s more: Settings, cold, read every 150 to 200 ms. So
  `computer_launch` waits, at most 5 s, until the app it launched is the
  tree's root. A read of only the status bar is never answered: bb-box
  reads again for up to 5 s.
- **The tree lists some elements the screen does not show.** Safari's start
  page listed buttons below the screen, so each such line says so: 'below
  the screen'. The tree also kept a page hidden under another: the
  Settings list under its search suggestions, and both pages for a moment
  after a push.
- **iOS marks every element inside a scroll view as scrollable,** so bb-box
  takes the first of a run of them, such as Settings' list, as the
  scroller. A scroller narrower than a third of the screen along the scroll
  is passed over for the screen.

### A tap by reference checks what is there

idb also says which element is at a point, in 5 to 17 ms. Before a tap by
reference, bb-box asks at the element's centre, then at four other points
of its visible part, and taps the first where the element, or one of its
descendants, is. Where none is, it refuses and names what covers it.

| Seen live | What bb-box did |
| --- | --- |
| Settings' Accessibility row under the title bar and the Dynamic Island, the list scrolled | refused: 'e5, button "Accessibility", is covered by generic element "Dynamic Island, Empty" where it is now', with a hint to scroll up. After a scroll up, the tap opened Accessibility |
| Settings' General row, listed under the search suggestions | refused, covered by the suggestion "Accessibility" |
| Before this check: the same Accessibility row | the tap went to what covered it, and nothing opened |

### What else the first runs found

- **Keys were lost in Safari's address field.** On a Safari just started,
  'example.com' typed as keys, all within a millisecond, arrived as 'exam',
  and 'wikipedia.org' as 'wikip', 4 times of 4. Sent a character a request,
  so a few milliseconds apart, every key arrived. The server now waits
  15 ms between typed keys: 'en.wikipedia.org' and 'example.com' then
  arrived whole, 4 times of 4. 100 characters take 1.5 s more.
- **On a device's first typing, keys came slowly.** In a second, fresh box,
  paced keys and Return gave a search for 'exam' once. On the iPhone 17,
  never typed into, the field read part of the text 150 ms after the last
  key, and the rest came later: typing the rest again gave
  'example.comcom'. Neither came back after a reboot, nor on a field
  typed into before. So `computer_type` and `set_value` now wait until the
  field holds the text, or has not changed for three reads, at most 5 s,
  and never type it again. Keys such as Return go only once the text is
  there; otherwise the answer says what the field reads and that bb-box
  did not press them. On the iPad, never typed into, 'example.com' and
  Return then loaded the page, 3.5 s for the call.
- **Return pressed with the text in one call went before the text.** Safari
  searched for what it had so far. `computer_type` now lets the screen
  settle, 150 ms with no new frame, between its text and its keys.
- **A read straight after Home showed the app still there.** Home's
  animation was still running. `computer_observe` and `computer_windows`
  now wait for the screen to be still, at most 1 s. On a still screen this
  costs nothing.
- **Just after a switch, iOS names no app in front.** The first read
  failed with idb's 'The simulator's accessibility service named no
  frontmost application'. A read that fails is now tried again within the
  same 5 s: `computer_windows` answered 2.5 and 2.7 s after a switch to
  the iPhone 17 and back.
- **iOS's Dynamic Island lies inside a row's frame,** so a point read that
  found it counted as the row, until only the row and its descendants
  counted.
- **Escape does not close an iOS context menu.** The menu's 'Dismiss
  context menu' is a button in the tree.

### Each tool's time

Times are the tool's, in the plugin, from the call to its answer.

| Tool | What | Time | Times run |
| --- | --- | --- | --- |
| `computer_windows` | the device's one window and the app in front | 36 to 45 ms, median 40 ms | 5 |
| `computer_observe` | the tree, a still screen | 38 to 52 ms, median 43.5 ms | 10 |
| `computer_observe` | straight after a tap that opened a Settings page | 0.95 to 1.04 s: the page's last frames came about 0.8 s after the tap's answer | 10 |
| `computer_screenshot` | 721x1568, scaled from 1206x2622 in the box | 104 to 138 ms, median 108.5 ms | 10 |
| `computer_act` click | a tap by reference that opens or closes a Settings page, the change waited for and listed | 1.50 to 1.71 s, median 1.55 s | 10 |
| `computer_act` right_click | a 1.2 s press on Safari's icon, its menu's six items listed | 2.4 s | 1 |
| `computer_act` double_click | two taps on a page in Safari | 1.1 s | 1 |
| `computer_act` scroll | Settings' list to its end, 5 of 50 steps; General's, 2 of 50 | 5.8 s; 3.6 s | 1 each |
| `computer_act` set_value | Settings' search field, a tap, Cmd+A and 'Wallpaper', read back | 2.6 to 2.9 s | 3 |
| `computer_act` set_value on a slider | refused | 28 to 46 ms | 2 |
| `computer_act` drag | Larger Text's slider, 50% to 67% | 2.7 s | 1 |
| `computer_type` | 11 to 16 characters and Return into Safari's address | 2.0 to 3.5 s | 7 |
| `computer_launch` | an app already running | 0.6 to 0.7 s | 5 |
| `computer_launch` | an app not running, until its tree is read | 3.6 to 5.9 s | 9 |
| `computer_launch` | Safari, first on a model just switched to | 11.0 to 12.0 s | 2 |
| `computer_launch` | a URL in Safari | 2.5 to 2.6 s | 2 |
| any act, type or launch while a person has control | refused | under 1 ms | 4 |

Most of an action's time is waiting: for the screen to be still for 300 ms,
at most 2 s, then reading the tree again to list what changed.

### 063's live check, through the harness

| Step | Result |
| --- | --- |
| Settings, General, About by references | each by its reference; About read as 13 lines, such as 'static text "Model Name, iPhone 18 Pro" (id ProductModelName)' |
| A URL typed into Safari | 'Typed "example.com" and pressed Return', and example.com loaded |
| A long list scrolled | Settings' list to Developer, its last row, in 5 of 50 steps, and General's in 2: '... it moved no further, so it is at its end.' |
| A text field set | Settings' search field: 'Set e84, search field "Search", to "Wallpaper". e84 reads "Wallpaper" now.' |
| Refused on a slider | Larger Text's slider and the Home Screen's page dots, each refused with 'Drag it with computer_act's drag instead.' |
| Two with one label | the Home Screen's two 'Calendar' buttons, the widget and the app, got e3 and e4; a tap on e4 opened Calendar. Safari's two tabs, each 'Example Domain', got their own too |
| A turn | a reference read before a turn refused: 'The device turned or changed since you read e26, button "Tabs", so its reference is void.' |
| A person's control | reading and screenshots went on; a tap, typing and a launch were refused at once with the device's words; `computer_take_control` took it back |

### What limits these numbers

- One device, the iPhone 18 Pro, slim, in one box. The iPhone 17 and the
  iPad were not driven.
- Settings, Safari and the Home Screen only. An app of the agent's own,
  with its own identifiers, was not tried.
- The harness ran in the box, beside the device server. Through BB, each
  tool adds the round trip to the box.

### Through the tools in a thread

After the deploy, on 26 October 2026, the agent of this unit's thread ran
063's check with the real computer tools, on a fresh ios box from the
production BB (device server version 12, the iPhone 18 Pro, slim). Each
time is the tool call's, from its start to its answer in the thread's log,
so BB's server and the round trip to the box are in it.

| Step | Tool | Time | Result |
| --- | --- | --- | --- |
| The first read on the new box | `computer_windows`, twice | 13.1 s, 5.4 s | failed: 'The simulator's accessibility service named no frontmost application', though the Home Screen showed. See below |
| Settings | `computer_launch` | 5.7 s | its first launch in the box |
| Its tree | `computer_observe` | 0.04 to 0.12 s, 4 reads | |
| General, About, and back twice | `computer_act` click | 1.49 to 2.06 s, 4 taps | each by reference |
| General's list, then Settings' | `computer_act` scroll | 3.7 s, 2 steps; 5.6 s, 5 steps | each 'moved no further, so it is at its end' |
| The search field | `computer_act` set_value | 4.6 s | 'Wallpaper', read back; the device's first typing |
| Safari | `computer_launch` | 10.5 s | its first launch in the box |
| The address | `computer_act` click, `computer_type` | 1.8 s, 2.7 s | 'example.com' and Return, and the page loaded |
| A screenshot | `computer_screenshot` | 0.18 to 0.55 s | 721x1568 |
| The Home Screen's slider | `computer_act` set_value | 0.07 s | refused, with 'Drag it with computer_act's drag instead.' |
| The Home Screen's second 'Calendar', the app | `computer_act` click | 2.9 s | Calendar opened; the widget kept its own reference |
| A reference read before a turn | `computer_act` click | 0.52 s | refused as void |
| A new reference, sideways | `computer_act` click | 1.6 s | the tap landed; a location alert showed inside the window, with its three buttons |

Two things came out of it, both fixed in device server version 14 and the
plugin with it:

- **iOS named no app in front on a new box,** with the Home Screen on the
  screen, through 5 s of reads and a second call, until an app was
  launched. It did not come back in a second new box, nor after a reboot
  there, read every 1.6 s for 40 s. iOS still answers what is at a point
  then, so the driver now reads the screen at a grid of points, six across
  and every 30 points down, eight at a time, and puts what it finds under
  one root. Where SpringBoard owns most of the elements, the root is
  'Home Screen'; either way its value says 'read point by point, as iOS
  named no app in front'. A test reads the Home Screen this way from the
  error's own words. On a device, with the error given in place of the
  tree read, the Home Screen read so in 0.78 to 0.85 s, 3 times: 20
  elements, the 8 icons, the dock, the slider, the status bar and the
  widgets' text, under 'Home Screen'. The widgets' text belongs to their
  own processes, so the root goes by most elements, not all.
- **After a tap that brought up the alert,** the answer said 'Now in front:
  .', as the alert's root has no name. It now says 'the Home Screen or a
  system screen', as the window's heading does.

### Not checked here

- **The error itself again on a device,** as it did not come back: the
  point-by-point read was checked by giving it the error.
- **A person's control through BB:** no person held the panel during the
  thread's run. The harness checked it twice.
- **The image's check** does not yet read a tree or take a screenshot of
  each model, as 063 asks of units 7.1 and 7.2. It would need idb_companion
  started in the check, as no device server runs there.
- **Android:** unit 7.2. The shared parts, `DeviceComputer`, the tool
  routing and the server's requests, are tested with the test device only.

## Unit 7.4: recording a device

`box_record` on a device box records the device server's own stream. The
server writes each segment's H.264 as it comes, into a Matroska file of its
own making with each frame's time on the box's monotonic clock, and logs
each segment's model and geometry, every touch, each caption and each gap
beside them. At the stop, bb-box frames the segments on one canvas with
ffmpeg, holding each frame until the next, finds still stretches with
`freezedetect`, and makes the clip as 059 does.

### How it was checked

On 26 October 2026, in an ios box from the production BB on Tart (6 cores,
16 GiB), the iPhone 18 Pro, iOS 27.0, ffmpeg 9.0.2. The device server of
this unit was delivered by `scripts/measure/ios/bench.ts deliver`: version
11, before units 4.1 and 7.1 merged, for the table below, and version 13,
rebased on both, in a second box for the main clip and the kill again.
`scripts/measure/ios/record.ts` drove it through a control connection, with
no viewer open, then framed and made each clip as bb-box does. The plugin's
own path, `box_record` through BB, was checked on a Linux box with the test
device, in the plugin's tests; through a BB in a box it is the lead's check.

### The clips

| Scenario | Recorded | Segments | Still stretches cut | Clip | Framing | Making |
| --- | --- | --- | --- | --- | --- | --- |
| Settings scrolled, then Safari turned right and back, two captioned steps | 60.0 s | 5 | 16 | 27.5 s, 1280x1390, 1.1 MB | 7.6 s | 2.2 s |
| The same with Settings turned, which an iPhone draws upright only | 60.0 s | 3 | 17 | 25.7 s, 1280x1390, 0.95 MB | 4.8 s | 2.1 s |
| The Home Screen, still | 20.0 s | 1 | 1 | 0.5 s, 1080x1600 | 1.5 s | 0.3 s |
| The same, stills kept | 20.0 s | 1 | none | 20.0 s of its first frame | 1.7 s | 0.9 s |
| A scroll, then a minute still | 70.0 s | 1 | 4, the last 64.6 s | 3.6 s | 3.3 s | 0.6 s |
| The server killed mid-recording | 20.0 s | 2 | 6 | 11.5 s, the gap captioned | 2.8 s | 1.0 s |

- **Turns.** Each turn of Safari was two segments, as unit 6.1 found: the
  turn, with the picture still upright, then the new size 153 to 164 ms
  later. The clip draws the body turned with the island to the right, and
  Safari's page laid out across it. Settings, which an iPhone does not turn,
  shows upright on the turned body, on its side, as on a real phone.
- **Touches** show as the viewer's circles, where each landed: 60 touches
  logged in the minute, at most one each 40 ms for a contact that moves.
- **The canvas** fits the largest shape: 1080x1600 for a phone upright
  only; 1280x1390 with a turn, so the phone keeps one size throughout. The
  captions sit in a band of 109 pixels above or below the device.
- **No viewer.** No viewer was open for any clip; the frames came all the
  same.

Version 13's main clip: 60.0 s recorded, 4 segments, 13 still stretches
cut, a 25.1 s clip, framed in 6.8 s and made in 2.4 s. Its turn right came
as the turn and then the new size 62 ms later; the turn back upright came as
one change.

### The server killed mid-recording

`SIGKILL` to the server 7 s in. launchd started it again 204 and 214 ms
later in two runs of version 11, and 308 ms later in version 13's. The new server found the recording unended, logged the
gap, and carried on: the next segment began 0.7 s after the kill, at the
first key frame of idb's new stream. The clip holds the last frame across
the gap and shows "The device server restarted here, and frames were lost"
under the caption band, held for its reading time though the stretch around
it is still and cut.

### What recording costs

Over the same minute of scrolling and turns, the device server used 0.49 s
of CPU without a recording and 0.62 s with one, by `ps` at 0.01 s: about
0.2% of a core more. The segments of a busy minute took 5.2 MB. The cost is
at the stop: framing took 4.8 to 7.6 s a minute with 6 cores, and making
the clip about 2 s more.

### E15: still stretches, segments decoded at 15 fps

Each segment is decoded at 15 fps and each frame held until the next, so a
still stretch of the device is a run of identical frames in the framed
video, which `freezedetect` finds as it does on desktops: in every clip
above, each stretch still for over a second was cut to half a second, with
a mark such as "▶▶ 4 s later" in the corner beside the device where one of
3 s or more was cut. A still end is cut at the clip's end, so its mark has
no time to show, as on desktops. A still screen, kept, is its first frame
for the recording's whole length.

### What limits these numbers

- One model, the iPhone 18 Pro, on one Tart host. The iPad's picture is
  about 1.8 times the iPhone's, so framing it should take longer; not timed.
- Android's clip, and the Pixel Fold's fold, were not recorded live: the
  recorder reads only the device server's frames and state, which the
  Android driver gives as the iOS driver does, and the fold is drawn from
  the table, as the frame draws it. They are checked once an android box
  runs this server.
- A device that restarts mid-recording was checked with the test device
  only, in the tests. A recording that falls more than 2 s behind its
  frames, and a box stopped or restarted mid-recording, which ends it, were
  not checked.

## Units 5.1 and 6.2 on Android: input and controls

Measured on 26 October 2026 in one android box acquired through the
production BB, a clone of the Android template on Proxmox QEMU at the
kind's default size, 8 cores and 16 GiB: Android 15 (API 35), emulator
37.2.12.0, the Pixel 8 and the Pixel Fold. The device server was this
unit's, version 14 and then 15, delivered from its checkout as bb-box
delivers it, so the production plugin used it. Three ways in:

- **Through BB,** in the owner's Chrome on a Mac, driven by playwriter: the
  panel's own Device view and toolbar, and `box_device` from this thread.
- **The plugin's own code in the box,** as 5.2 and 6.3 measured iOS:
  `scripts/measure/ios/viewer.ts` runs the plugin's relay and the panel's
  video client in headless Chrome 156 in the box, and
  `scripts/measure/android/controls.ts` runs the plugin's `DeviceServers`
  and box_device's parsing and words. BB's server and the network are not
  in these.
- **Straight to the emulator's gRPC,** for what the emulator itself does.

A page served from the box and opened in the device's Chrome,
`scripts/measure/android/probe.html`, turned black or white at each touch
and logged each touch, key, pinch, scroll, field value and request.

### Touches, and E8

- **The emulator takes touches in the AVD's own panel, upright,** whatever
  way the device is held and whatever the app draws. `dumpsys input` showed
  the points as sent, and Android turned them with its display. The
  picture turns with the device as it is held (unit 4.1), so the server
  turns a point of the picture back into the panel's pixels.
- **On the Pixel Fold the panel is the inner screen's,** 2208x1840. While
  closed, a touch at (540, 700) of the outer screen landed at (265, 795) of
  it, so the emulator stretches the inner panel onto the outer screen, and
  the server stretches the other way.
- **Checked on screen:** the agent's long press at 30% across and 70% down
  the picture, with Android's pointer overlay on, and the agent's
  screenshot read for the crosshair. On the Pixel 8 in all four
  orientations, with the Home Screen held upright, and on the Pixel Fold
  closed, open and half open in all four, the crosshair was within 1 pixel
  of the tap in all 16.
- **Each finger is lifted by name:** the server sends every finger down in
  one `sendTouch`, and a finger that lifted with pressure 0.

### Keys and text

- **Keys go by their W3C names,** which the emulator takes: `sendKey` with
  key down and key up. Enter, Backspace, Delete, Home, End, the arrows,
  space, Caps Lock, Escape and Tab reached the page by name; Page Up and
  Down, Insert, F1 and F12 reached it, named "Unidentified" by Chrome.
  The emulator holds Shift between calls, so chords work. A key a US
  keyboard lacks, such as "é", is refused: "Send it as text, which bb-box
  pastes."
- **Every printable US character types as keys:**
  `a7?b8!c9(D0)e-_f=+g[{h]}i;:j,<k.>l/?mZ` arrived exactly, 3 of 3.
- **Text other than ASCII must be pasted, as on iOS.** `sendKey` with "é" as
  its key, or with "héllo" as its text, typed nothing for the é. So the
  server pastes it: the clipboard by gRPC `setClipboard`, then the Paste
  key.
- **Android adds no space to pasted text and keeps taking keys** while its
  notice shows, so the server holds none, unlike iOS.

What arrived, from the person through the panel's client, into the probe
app's own text field:

| What the person did | What arrived |
| --- | --- |
| An input method composing 'nihongo', then committing 日本語 | 日本語 |
| Arabic letters | مرحبا |
| An emoji | 😀 |
| Type text: ' crème brûlée, naïve façade' | exactly |
| Typed keys: ' Grüße' | exactly |

The device's clipboard held its own text again after each.

### E21: putting the clipboard back

The paste key then the old text put back on the clipboard after a wait,
then the field read:

| Where | Put back after | Pasted the new text |
| --- | --- | --- |
| An app's own text field | 0 ms | 1 of 3 |
| An app's own text field | 10, 25, 50 and 100 ms | 12 of 12 |
| A page in Chrome | 0 to 50 ms | mostly the old text |
| A page in Chrome | 100 and 150 ms | the new text |

Chrome reads the clipboard after it handles the key, up to about 150 ms
later, so the server puts the clipboard back 300 ms after the paste key.

Chrome on the device took 4 pastes from outside each time it started, then
no more, by the Paste key and by Ctrl+V alike, with the clipboard put back
or not, and with the on-screen keyboard shown or hidden. Its log said the
4 pastes and nothing for the rest. An app's own text field took a paste
every time, in 21 tries.

### The person and the agent

- **A person taking control halfway through the agent's swipe.** A 2 s
  swipe up the page's list scrolled it to 259 left alone. Taken over 0.8 s
  in, the list stopped at 189, the touch was lifted at once, and the
  agent's answer was `person-has-control`. Its next input was refused the
  same way, and one sent under the old generation after hand-back as
  `superseded`.
- **Halfway through the agent's paste.** Android's paste key goes about
  10 ms after the clipboard is set, so a person who takes control 150 ms
  in finds it sent: the paste finished, and the clipboard was put back, as
  063 says for a paste key already sent. Taken over 120 ms into the agent's
  keys ahead of a paste, the field kept 'abcdefg', nothing was pasted, and
  the clipboard still held its own text.
- **A reload while a person holds control,** mid-drag: the server lifted
  the person's touch as the old input connection ended, the new instance
  took the lease, the viewer connected again by itself, and its next tap
  landed.
- **The agent while a person holds control:** `box_device home` through BB
  was refused with `person-has-control`.
- **Alt and drag:** two touches mirrored about the screen's centre reached
  the page; its pinch read 1.413 against 1.414 from the pointer's path.
- **The wheel:** each notch is a swipe of 200 device pixels. It scrolled
  Chrome's list 180 to 380 device pixels down and 180 to 240 up: Android
  keeps a little of the swipe's speed, though the finger holds still before
  it lifts. A trackpad's 160 pixels in 4 events scrolled it 580 device
  pixels.

### E14: tap to screen

From the browser's pointerdown to the first drawn frame whose pixel beside
the tap changed, on the probe page, taps 0.6 s apart. Busy is Gradle
building a small app again and again, at 6 s a build; its share of the 8
cores is the mean over the run.

| Where | Load | Taps seen | Median | 95th percentile | Worst |
| --- | --- | --- | --- | --- | --- |
| In the box | idle | 100 of 100 | 87 ms | 90 ms | 92 ms |
| In the box, Android's pointer overlay, no app | idle | 30 of 30 | 76 ms | 94 ms | 175 ms |
| Through BB | idle | 100 of 100 | 67 ms | 346 ms | 596 ms |
| Through BB | idle, two more runs | 50 and 50 of 50 | 67 ms | 159 and 76 ms | 232 and 523 ms |
| Through BB | one build, 37% busy | 96 of 100 | 76 ms | 110 ms | 615 ms |
| Through BB | two builds, 60 to 89% busy | 100 of 100 | 87 ms | 329 ms | 522 ms |
| Through BB | two builds, the emulator pinned to cores 0 to 5 and the builds to 6 and 7 | 96 of 100 | 74 ms | 301 ms | 639 ms |

Through BB the browser decodes on the Mac's hardware, which is why it is
faster than headless Chrome decoding in software in a busy box.

Where the time goes, from wall clocks: the box's log stamped when each
touch reached the device server and when its first frame left, and the
browser stamped each pointerdown and each frame's arrival, both clocks
synced by NTP:

- **The device's own share,** the touch at the server to its frame out:
  median 51 ms idle (26 taps), and 61.5 to 64.5 ms with two builds and the
  emulator pinned, worst 78 ms (60 taps). This is the CPU drawing and
  encoding, and is the floor.
- **Decoding and drawing in the browser** after the frame arrived: median 4
  to 5 ms, worst 10 ms.
- **BB's path, both ways,** about 7 ms at the median.
- **Every slow tap lost 250 to 310 ms on the input's way in,** before the
  device server saw it; the frame's way out stayed normal. The same relay
  code run in the box without BB's server or SSH had no tail. bb-box's loop
  watch logged BB's server standing still 3 to 13 times in each minute of
  these runs, for up to 383 to 1,676 ms, which a tap arriving then waits
  out. Pinning the emulator lowered the busy median from 87 to 74 ms, not
  the tail.
- **The first tap after a still spell** of tens of seconds took 360 to
  559 ms through BB each time, by the same late input. In the box the
  first tap after a reconnect took 58 to 89 ms over 3 reconnects.

So Android's bar is about 70 to 90 ms at the median through BB, with the
device's CPU drawing, 50 to 60 ms, as its floor. The tail through BB is
[#1158](https://github.com/moonstead/bb-box/issues/1158), shared with
desktops.

### Each action, through box_device

Server time is from the request to its answer, read-back included.

| Action | Server time | Seen or read back |
| --- | --- | --- |
| home, back, recents | 0.1 s | the launcher; Settings back a page; the recent apps' overview |
| lock, wake | 0.2 s each, until Android reads asleep or awake | the state asleep, then awake |
| rotate, turn left and to upright | 0.1 to 0.3 s; the new picture 61 to 125 ms after the command | the Pixel 8 and the Fold turned, the stream 2400x1080 and 1840x2208 |
| posture, closed, half open, open | 0.2 to 0.6 s, until `cmd device_state` reads it | the outer screen at 1080x2092, the inner at 2208x1840 |
| appearance | 0.2 s | dark and light |
| text_size, each of the 7 font scales, and larger, smaller, default | 175 to 333 ms | each read back as set |
| location, London and cleared | 0.1 to 0.2 s | read back by `getGps`; cleared, the emulator's own, 37.422, -122.0841 |
| status_bar clean and live | 0.17 s | 9:41, full Wi-Fi and signal, the battery bb-box set, on the Pixel 8 and the Fold |
| battery, 42% not charging, and the device's own | 0.1 s | read back by `getBattery` |
| network, slow, offline, online | 0.1, 0.4 and 3.9 to 4.0 s; online waits for Wi-Fi's address | read back; E22 below |
| install, a 2 MB and a 170 KB APK | 0.2 to 0.3 s, `sync` included | in the app list; launched |
| switch | 6.6 s; 15.0 s the first time a model booted in this box | each model with its own settings |
| reboot | 18.5 s from the panel | back, cold |

Refused in words: a content size on Android and a font scale of 1.2 (bad
value), an `.aab`, a path with no file, and an install of an app the device
has while a person holds control. A file that is not a zip is "not an APK".

The production plugin, older than this unit, still refused `status_bar` on
Android in its own parsing, so `status_bar` was sent through the harness
with this unit's parsing.

### Read-backs

Each 10 times in the box:

| Read | Time |
| --- | --- |
| `cmd uimode night` | 8 to 10 ms |
| `settings get system font_scale` | 10 to 14 ms |
| `dumpsys power`, the wakefulness | 9 to 12 ms |
| airplane mode, Wi-Fi and the shaping | 17 to 21 ms |
| `cmd device_state print-state` | 8 to 10 ms |
| all of them in one `adb shell` | 36 to 42 ms |
| gRPC `getGps`, `getBattery` | 1 to 3 ms |

The server reads them together, with the location and battery by gRPC, in
41 to 82 ms. After `adb shell cmd uimode night no` in a shell, a watching
viewer's state said light, changed outside bb-box, 6.3 s later.

### Requests by ID

A turn right sent twice with one ID turned the device once, and the second
answer and the result asked for after were the first. With the plugin's
connection ended 50 ms after it sent a turn, it connected again and had its
answer, the device turned once.

### E10: a clean status bar

SystemUI's demo mode, allowed by `settings put global sysui_demo_allowed 1`,
then its broadcasts: the clock at 9:41, Wi-Fi and mobile at full, the
battery at the level bb-box set and not charging unless set so, no
notification icons, and the other icons hidden. It took 126 ms and showed on
the Pixel 8 and the Pixel Fold. `live` leaves demo mode. A cold boot clears
it, so the server sets it again when the device starts; after a switch away
and back, the Fold came back clean.

### E11: which way left and right turn

`setPhysicalModel` ROTATION about z, 90 degrees, gave the picture with the
device's top, its status bar and camera hole, at the left: turned left, a
quarter turn anticlockwise, the way the toolbar's left arrow points, as on
iOS. -90 is turned right and 180 upside down. bb-box turns in one step: the
emulator's default eases through the orientations between, so upside down
to turned right passed through upright.

### E22: the network presets

The page's own request for 200 KiB from the box, timed in the device's
Chrome:

| Preset | Result |
| --- | --- |
| online | 8 to 16 ms |
| offline | failed in 2 ms: "Failed to fetch" |
| slow | 20 KiB in 0.47 s, 50 KiB in 1.06 s, 200 KiB in 3.76 s |
| online again | 11 to 14 ms |

The emulator console's `network speed edge` and `network delay umts`, which
the research set, read back but did not slow these requests at all: Wi-Fi
does not go through them, and the emulator's mobile data never connects. So
`slow` shapes the device's Wi-Fi itself, as root in the device: `netem` on
`wlan0` at 473.6 kbit/s with 100 ms of delay, and incoming traffic
redirected through `ifb0` at the same rate. The goldfish kernel has `netem`,
`ifb` and `mirred`.

Turning airplane mode on and off once set the device's clock back 1 h
49 min, to the time its snapshot was made, so the network control sets the
clock again after each preset, as the server does at boot. Through the next
toggles it stayed within 1 s.

### Each device's own Android ID

Every box from the template began with the same Android ID, as the snapshot
holds it. Setting `android_id` alone changes what `settings get` says, but
apps read their own IDs since Android 8, made from a key Android keeps in
`settings_ssaid.xml` and loads only as its framework starts. So the server,
the first time each device boots in a box, removes that file, restarts the
framework with `stop` and `start`, waits for the boot to complete, and sets
a new `android_id`. It keeps a mark per device, with a digest of the box's
own adb key, so a box made from another never skips it.

| Box | `android_id` | apps' key | Time |
| --- | --- | --- | --- |
| The template's | 91f5432055d42a8c | 293E65B6… | |
| First box, Pixel 8 | 2c856c44ab45739d | 80266BB5… | 7.9 s |
| First box, Pixel Fold | af4121f49eb626f1 | | 7.5 s |
| Second box, Pixel 8 | 54fecc20eec6be27 | A378253F… | 7.8 s |

Google Play services' own ID changed with the key, from c37d8b19… to
294118ec…. A switch away and back kept the Pixel 8's ID, in 6.6 s. After
the restart the launcher showed "Pixel is starting…" for a few seconds.
Once this unit runs in the plugin, an acquire whose device boots for the
first time in the box says so after its time: "…booted N s after the box
was ready, about 8 s of it giving the device its own Android ID, as each
device's first boot in a box does."

### The toolbar, through BB

In the owner's Chrome, on the production BB's panel, which draws a control
when `supports` takes it:

| Control | Seen |
| --- | --- |
| Back, Home, Recent apps | Display settings back to Settings; the launcher; the recent apps' overview |
| Rotate left, Rotate right | the frame turned, the note said "Turned left.", then "Upright." |
| Dark appearance | dark, the note "Dark appearance." |
| Text size, Larger twice, then Default | "Text size 130%.", then "100%, the default" |
| More: Lock, then Wake | "Asleep." with the last picture dimmed, then "Awake." |
| More: Network, Slow, Offline, Online | "Set the Pixel 8's network to slow in 0.1 s.", then online "in 3.9 s." |
| More: Battery, 42, not charging | "Set the Pixel 8's battery to 42% in 0.1 s."; More then read "Battery: 42%" |
| More: Location, London, then No simulated location | "Set the Pixel 8's location to London, 51.5072, -0.1276 in 0.1 s.", then "Cleared…" |
| More: Open link, example.com | Chrome on the device opened https://example.com |
| More: Reboot device | "Rebooted the Pixel 8 in 18.5 s." |
| The picker, Pixel Fold | "Switched to the Pixel Fold in 12.1 s.", with "Apps are per device." |
| Fold: Closed, Open, Half open | the outer screen in a phone body; the inner screen; half open with the crease shaded and "Half open" under the frame |
| Copy screenshot | through the harness's panel client, a PNG of the Fold, 4.07 MB |

The production panel's Copy screenshot said "Box <name>'s device
server is not connected": this unit's harness, an instance started later,
had taken the box's lease, and an instance once superseded does not take it
back while it runs. That is right for a reload, where the earlier instance
is about to end; a harness that outlives its lease leaves the box's plugin
link down until bb-box reloads.

### What limits these numbers

- One box, of 8 cores, on one host. The Pixel Tablet was not driven.
- Through BB is one browser, Chrome on a Mac, on the same network as BB's
  server.
- The Gradle builds were of a small app with 2,000 generated classes; a
  real app's build loads the box differently.
- The wall clocks of the Mac and the box agree to about 30 ms, by their
  NTP; the split of BB's path both ways is that rough, the device's own
  share is not.
- E21's Chrome numbers come from one page; an app that reads the clipboard
  itself was not tried.

### Not checked here

- The Pixel Tablet, and the Fold's half-open posture held while an app
  uses it.
- Computer use on Android, unit 7.2.

## Six fixes from live checks

Checked on 26 October 2026 in one ios box from the production BB, on Tart,
4 cores and 8 GiB, with the iPhone 18 Pro, iOS 27.0 (24A434) and
idb_companion 1.7.7. The device server came from this checkout: version 14,
and main's 15, before the fixes, and these fixes after them.

### Input after a boot: the HID daemon starts at the first input

After the device stopped by itself (`simctl shutdown`), the server said it
was back, and a lock sent then did not take. The probe locked through a
control connection, sent the lock at once, then waited 3 s for the lock
state. Before the fix, 0 of 5 locks sent 0 to 1.3 s after "back" took. One
sent 3.6 s after did not, and ones sent 4 to 7 s after did. Taps were the
same: a tap on Safari 0 s after "back" opened nothing, and one 2.3 s after
did.

The simulator's log says why. Input goes through `dtuhidd`
(`com.apple.coredevice.dtuhidd`), which launchd starts only at the first
HID event after a boot. backboardd then logs "SimHIDVirtualServiceManager:
dtuhidd state changed to active", and only then hands input to it. In one
run the first lock was sent at 34.4 s and `dtuhidd` started then. It was
active at 36.7 s, and backboardd saw the press at 37.0 s, too late for the
lock's 3 s. A device left 20 s after its boot with no input had no
`dtuhidd` running. A fresh idb_companion on a device that had settled
locked it at the first try, so the companion was not the cause.

Now, before the server says a device it booted or attached to is booted or
back, it checks whether `dtuhidd` runs in the device. If not, it listens to
the device's log, sends a key-up of F13, which does nothing, and waits up
to 15 s for "dtuhidd state changed to active".

| After the device stopped by itself | Before | After |
| --- | --- | --- |
| A lock sent 0 to 1.3 s after "back" took at the first try | 0 of 5 | 3 of 3, sent 21 to 40 ms after "back" |
| From the F13 key-up to `dtuhidd` active | none sent | 0.8, 1.4 and 1.5 s |

### A companion from before the device's last boot

idb_companion's HID connection dies when its device shuts down. A
companion started before the device's last boot takes each key, and its
events go nowhere: an F13 key-up through it started no `dtuhidd`. The
server kept such a companion on a reattach, as when an older version left
one.

The check: the companion's start, from `ps -o ppid=,lstart=`, against the
start of the device's `launchd_sim`, SpringBoard's parent. When the
companion started first, the server starts a new one. The check reads no
command line.

| The device booted again with the server stopped, then the server started | Before (main's version 15) | After |
| --- | --- | --- |
| The companion | kept (the one from before the boot) | "started before the iPhone 18 Pro last booted, so its HID connection is gone; starting a new one" |
| `dtuhidd` | not running | active 0.5 s after the F13 key-up |
| Locks after the reattach | 0 of 3 took | 2 of 2 took |

### box_list while Tart reads its Macs

box_list now asks each backend, as acquire does, about the kinds it holds
back until it has read what decides them, and waits up to 10 s for that
read. A kind offered once read is listed as any kind is. One still held
back is listed under "Kinds you cannot acquire now", with why, or as being
checked while the read goes on. This was tested against fakes only: it
shows only in the seconds after bb-box restarts.

### A VM deleted while Tart lists the Mac's VMs

Tart 2.30.0's `tart list` fails with "Error: The file “config.json”
couldn’t be opened because there is no such file." when a VM folder loses
its config.json while it reads. The Mac's state script ended there, so the
whole Mac read as not answering. Tart 2.41.1's list does not fail. In a
macOS box, with VMs whose folders were written by hand, a loop copied a VM
folder, removed its config.json, then removed the folder, beside reads of
the state:

| State reads beside the deletes | Failed | Read without one of the two VMs that stayed |
| --- | --- | --- |
| Before | 28 of 440, and 2 of 52 | not counted |
| After | 0 of 402, and 0 of 306 | 0 of 306 |

When `tart list` fails, the script now reads each VM with `tart get`. A VM
whose config.json has gone is being deleted, so it is left out. A VM that
is there but cannot be read still fails the read, so a Mac is never taken
for one with no VMs.

### The Box tab and box_status on device boxes

The Box tab names a device box's device beside its OS, for example
"Linux Pixel 8" or "macOS iPhone 18 Pro", with no VM badge for its host.
Its details have a Device line. box_status says "Device control" on android
and ios boxes, rather than "Desktop control".

## F-3: Android boxes start with no network

Checked on 26 October 2026 on two android boxes from the production BB, 8
cores and 16 GiB, Proxmox QEMU, with the image of that day. Device server
version 16 as the image started it, then version 17 from this checkout,
delivered into each box as bb-box does.

### What was wrong

New Pixel 8 boxes had no network: `cmd wifi list-networks` said "No
networks", `dumpsys connectivity` "Active default network: none", and 3 to
15 "ANR in com.android.phone" in the first minutes. box_acquire still said
"network online", as the read-back read airplane mode and Wi-Fi's setting,
not whether the device reached anything.

The cause is in the template. On the device's first boot in the image
build, GoogleSdkSetup saves the emulator's AndroidWifi network. Android
writes a new network to its Wi-Fi store on disk about 10 s later, on a
timer. prepare-avds.sh saved the snapshot sooner, about 22 s after the
device booted, so AndroidWifi was in the snapshot's memory and not on its
disk:

| Where | AndroidWifi |
| --- | --- |
| The untouched snapshot, loaded read-only beside a box's device | listed by `cmd wifi list-networks`; 0 times in `WifiConfigStore.xml`, dated as the build |
| The same device left running | in `WifiConfigStore.xml` within 11 s of the load, by Android's timer; 4.4 and 5.8 s after bb-box first looked, in two boxes |
| A box's device after version 16 gave it its own Android ID | "No stored networks found" as Android read its store; none since |

Version 16 restarted Android's framework, with `stop` and `start`, 0.1 s
after the snapshot loaded, before that timer. The network was lost, and
every later boot read the empty store, a cold reboot too. The same restart
left the phone service failing to start. Its effect, "telephony service is
null" when Settings opened Network and internet, is the 7.2 worker's
report. It did not show after a full reboot.

### What changed

- **The Android ID by a reboot.** The server waits until AndroidWifi is in
  the Wi-Fi store on disk, removes `settings_ssaid.xml`, and reboots the
  device with `adb reboot`, in the same emulator. It no longer restarts
  the framework.
- **The emulator's Wi-Fi kept.** At each boot or reattach, a device with
  no saved AndroidWifi has it saved again, with `cmd wifi add-network
  AndroidWifi open`. That mends boxes version 16 left offline.
- **Online means reached.** The read-back adds the default network from
  `dumpsys connectivity`, which takes 14 to 16 ms. `online` and `slow` need
  a default network Android has validated; `offline` needs none. A boot
  waits up to 10 s for the network bb-box set, then restarts Wi-Fi once and
  waits up to 15 s more (below, after the deploy). The network control waits up
  to 8 s, then says what the device reads, for example "The network was
  set to online, but 8 s later the device reads airplane mode disabled,
  Wi-Fi on, not slowed, no default network."
- **The state after a failed control.** A control that fails now answers
  with the state read after it. Before, the failed network control above
  still said "network online".
- **The template.** prepare-avds.sh waits until AndroidWifi is in the Wi-Fi
  store before it saves each snapshot, and bb-box-check-android fails an
  image whose snapshot lacks it or has no validated network. The image
  needs a rebuild for this; until then the server's wait covers it.

### Live, with version 17

Each row read `dumpsys connectivity`'s default network and whether Android
validated it, AndroidWifi in `cmd wifi list-networks` and on disk, and
fetched http://example.com from the device with `toybox nc`.

| Check | Time | Default network | Fetch | Phone ANRs |
| --- | --- | --- | --- | --- |
| Pixel Fold, first boot in a box, by a switch | switch 43.5 s; Android ID 29.0 s | 100, validated | 200 OK | 0 |
| Pixel Tablet, first boot, by a switch | switch 39.4 s; Android ID 25.1 s | 100, validated | 200 OK | 0 |
| Pixel Fold, first boot, second box | switch 41.7 s; Android ID 23.5 s, 4.4 s of it the wait for the write | 100, validated | 200 OK | 0 |
| Pixel Tablet, first boot, second box | switch 40.5 s; Android ID 25.9 s, 5.8 s of it the wait | 100, validated | 200 OK | 0 |
| Pixel 8 offline under version 16, then version 17 delivered | AndroidWifi saved again at reattach; validated 11 s later | 100, validated | 200 OK | the earlier ones stay until a reboot |
| Switch back to the Pixel 8 | 7.6 s | 100, validated | 200 OK | 0 |
| Cold reboot, from box_device | 23.3 s | 100, validated | 200 OK | 0 |
| Offline, then online | 0.5 s, then 4.4 s | none, then 101, validated | fails, then 200 OK | 0 |
| Stop and start of the box | resumed in 8.0 s; the device back 0.5 s after | 101, validated | 200 OK | 0 |
| AndroidWifi forgotten by hand, then online | refused after 8 s, in the words above | none | | |

Settings opened Network and internet on the Fold with no crash. Chrome on
the Pixel 8 showed example.com. With `adb reboot` the apps' key changed,
for example from 7A94DC07… to F57C2B3B…. `svc power reboot` took 35 s,
against 20 s.

### What limits these numbers

- Two boxes on one host. Each device's first boot came from a switch, as
  each box's image server gave the Pixel 8 its ID before version 17 could
  run; five fresh boxes from the production BB, each with a fetch within
  the boot time box_acquire reports, need version 17 delivered there.
- The wait for the write, 4.4 to 5.8 s here, goes once the image is
  rebuilt with the new prepare-avds.sh. The reboot, about 20 s, stays.
- On Proxmox a stop and start resumes the device; a backend that boots it
  again was not tried.

### After the deploy: five fresh boxes

Version 17 in the production BB, five android boxes acquired one after
another, at most two held at a time, each released after its check. Each
row is the box's Pixel 8 as box_acquire handed it over.

| Box | Boot time box_acquire said | Android ID, the wait for the write in it | Default network | Fetch | Phone ANRs | Network and internet |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 34.8 s | 26.7 s, 6.4 s | 100, validated | 200 OK | 0 | opened, no crash |
| 2 | 35.5 s | 26.5 s, 5.9 s | 100, validated | 200 OK | 0 | opened, no crash |
| 3 | 32.8 s | 26.7 s, 6.4 s | 100, validated | 200 OK | 0 | opened, no crash |
| 4 | 32.3 s | 26.7 s, 6.4 s | 100, validated | 200 OK | 0 | opened, no crash |
| 5 | 49.5 s, and no "network online" | 26.8 s, 5.9 s | 100, not validated | DNS failed | 0 | opened, no crash |
| 6, while version 18 was made | 33.4 s | 26.3 s, 5.8 s | 100, validated | 200 OK | 0 | opened |

Box 5 had a different fault. AndroidWifi was saved and on disk, and Wi-Fi
connected, but the device could not reach even its gateway: "Network is
unreachable". Its routing table for Wi-Fi had no IPv4 routes, though
`dumpsys connectivity` listed them. netd's log shows why: ConnectivityService
added wlan0 and its routes to network 100 54 ms before it created that
network in netd, which refused them with "Machine is not on the network".
Its retry left the default route out, with "Network is unreachable". Version
17 said so after its 20 s wait, and box_acquire did not claim "network
online". Turning Wi-Fi off and on gave a validated network in 5.3 s.

So version 18, when the network bb-box set has not come 10 s after a boot
and airplane mode is off with Wi-Fi on, restarts Wi-Fi once, and waits up
to 15 s more. On a box with version 18, a loop flushed the Wi-Fi table's
IPv4 routes for 8 s after a cold reboot, which leaves the network
unvalidated as on box 5. The server restarted Wi-Fi 10 s after the boot
and read the network online 5.4 s later; a fetch gave 200 OK. One of six
boxes is too few to say how often Android does this.

## Units 7.2 and 7.3: computer use on an Android device

Measured on 26 October 2026 in two android boxes acquired through the
production BB, clones of the Android template on Proxmox QEMU at the kind's
default size, 8 cores and 16 GiB: Android 15 (API 35), emulator 37.2.12.0,
the Pixel 8. The device server was this unit's, version 17, which is 19
after its rebase on F-3's two fixes. The harness,
`computer.ts` in
[scripts/measure/android](../../scripts/measure/android/README.md#computer-use),
runs the plugin's own `DeviceServers` and `DeviceComputer`, so each answer
below is what the agent reads. With `--tree dump` or `--tree server` it
runs the device server in its own process with that source of the tree.
`check.json` is 063's live check as one run, `e12.json` is E12. BB's
server and the tools called from a thread are not in these numbers.

Both boxes started with no network on the device and with
`com.android.phone` failing to start, from the framework restart that gives
each device its own Android ID. Settings' Network & internet page crashes
then ("telephony service is null"). F-3 (#1163), merged after these runs,
gives the Android ID by a reboot instead. Here the device was rebooted cold
and joined to its Wi-Fi by hand with
`adb shell cmd wifi connect-network AndroidWifi open`, and the check opens
Connected devices rather than Network & internet.

### Where the tree comes from

- **bb-box's own tree server (7.3),** a Java program,
  `setup/android/tree-server/TreeServer.java`, built to a 15 KB dex,
  `src/device/tree-server.dex`, by `setup/android/build-tree-server.sh`
  with a pinned JDK 17, d8 and android-35, and delivered with the device
  server. The same source built on two boxes gave the same dex, byte for
  byte. The driver copies it to `/data/local/tmp` by its digest and runs it with
  `app_process` over `adb shell`, as `uiautomator` itself runs, talking a
  line of JSON each way on its standard input and output. It connects
  UiAutomation as `uiautomator` does, reads every window, in z-order, with
  their nodes, and lists the launcher's apps with their labels.
- **`uiautomator dump` (7.2),** to `/dev/tty`, parsed from its XML. It
  reads only the active window.
- Both go through one converter into the device's elements, so a dump and a
  server read of a screen give the same lines (below).

Choosing bb-box's own server over Appium's UiAutomator2 server:

| | bb-box's tree server | Appium UiAutomator2 server v10.6.6 |
| --- | --- | --- |
| What reaches the device | one 15 KB dex in `/data/local/tmp` | two APKs installed on each device, 17,968,807 and 197,183 bytes |
| Within the 512 KB delivery budget | yes: the delivered files are 504 KB in all | no: it would have to be in the image |
| Started | 80 to 150 ms to its hello | an instrumentation (`am instrument`), with an HTTP server forwarded by adb |
| Beside an app's tests | lets go of UiAutomation in 100 ms when `am instrument` starts | is itself an instrumentation holding UiAutomation, so it must be stopped |

Appium's tree time was not measured.

### Android lets one UiAutomation client in at a time

Two clients were started on a device, each connecting UiAutomation:

- The second failed with `IllegalStateException: UiAutomationService ...
  already registered!`. `uiautomator dump` beside a holder ended "Killed"
  in 93 ms.
- An instrumentation test that calls `getUiAutomation()`, as UiDevice and
  GrantPermissionRule do, passed alone and crashed ("Process crashed")
  while another client held UiAutomation.

So the dump is no safer beside a test than a server: it holds UiAutomation
for about 2 s a read, and up to 11 s on a screen that is not idle. The tree
server holds it while the agent works, lets go after 30 s with no read, and
watches `/proc` every 100 ms while it holds it: when `am instrument` or
`uiautomator` starts, it lets go at once. While an instrumentation runs, a
read is refused in words and screenshots go on.

### E12: tree times, before and after

Each read is the plugin's request to the box's device server and its
answer, 20 reads 200 ms apart, on a still screen:

| Source | Settings' first page | A page in Chrome |
| --- | --- | --- |
| `uiautomator dump` | 1,908 to 1,917 ms, median 1,911 ms | 1,900 to 1,919 ms, median 1,906 ms |
| bb-box's tree server | 2.7 to 33.1 ms, median 3.2 ms | 1.6 to 16.9 ms, median 3.0 ms |

The server's first read after it connects takes 330 to 620 ms: it waits
until the window list has not changed for three reads and the screen's
events have stopped for 300 ms. Without the window wait, a first read
missed the status bar, or every window. Its start, to its hello, took 80
to 150 ms.

### E12: the same references both ways

The same screen read by each source, the app's lines on the screen compared
with their references taken out:

| Screen | Dump | Server | Lines the same |
| --- | --- | --- | --- |
| Settings' first page | 12 | 12, and 19 more: the status bar, and rows below the screen | all 12 |
| The Home Screen | 16 | 16, and the status bar | all 16 |

In Chrome the two did not match: the dump, 4 s after the page was opened,
had its 13 lines, and the server, 2 s after the dump, had the empty frame
described below. A test compares a dump and a server read of one Settings
screen saved from the device: every element that can be tapped has the same role,
label, identifier and frame.

### E12: beside an instrumentation test

A small app of bb-box's own test probe, built in the box with aapt2, javac
and d8, has two instrumentations: `Holds` calls `getUiAutomation()` and
reads the screen every 500 ms for 8 s, as a UiDevice test does, and `Plain`
does not touch UiAutomation, as an Espresso test need not. Each ran with
`am instrument -w` while the plugin read the tree every 500 ms:

| Test | Its result | Reads while it ran | After it ended |
| --- | --- | --- | --- |
| `Holds` | passed, its UiAutomation connected 3 ms after it asked | refused in 4 to 34 ms each, in words | the server read again in 151 and 329 ms, then 3 to 20 ms |
| `Plain` | passed | refused the same way | 124 and 618 ms, then 3 to 6 ms |

Then a test started 10 times while the agent read every 100 ms, with
`Holds` for 2 s:

| How the tree was read | Tests passed |
| --- | --- |
| `uiautomator dump` only, as 7.2 alone would | 0 of 10: each crashed |
| The server gave way, and the dump read while the test ran, as 063's row for 7.3 asked | 9 of 10: the dump took UiAutomation before the test once |
| The server gave way, and reads were refused while the test ran | 10 of 10, twice, on two boxes |

So reads are refused while an instrumentation runs, and the dump is used
only when the tree server itself cannot run. With the tree server killed
(SIGKILL in the device), the next reads came from the dump, 1,911 and
1,929 ms, and 30 s later from a new server: 443 ms, then 3 to 5 ms.

### What the first runs found

- **A page in Chrome is in the tree only some of the time.** Otherwise
  Chrome shows a frame described "Web View" with nothing in it, to the dump
  and the server alike. The page's lines were there for the first box's
  whole session, for the dump read 4 s after a page was opened by a link,
  and for the server's first connection 3 s after one; they were not there
  for the server connecting 1 to 35 s after a dump, nor for the dump itself
  some minutes after the page loaded, nor straight after 'example.com' was
  typed in the check. Clearing UiAutomation's cache, waiting 1 s for quiet,
  and an accessibility focus on the frame did not bring them. With
  UiAutomation's flag that keeps other accessibility services, they were
  missing on a page just opened too, so the server connects without it. The
  element is a `web view` whose value says to use `computer_screenshot`.
  Why Chrome shows the page some times and not others is not known.
- **`uiautomator dump` never reads Settings' About page,** as its Up time
  ticks every second, and the dump waits for 1 s with no accessibility
  event: "ERROR: could not get idle state." after 11 s, every read, and
  every read of Settings after it. The server reads it in 2 to 6 ms.
- **Rows a list holds beyond the screen** come with their far edge cut to
  the list's, as from 2391 down to 2337. They are listed as below, above,
  right or left of the screen, by where they lie against the list that
  holds them; Chrome's tiles beyond the right edge read as right of the
  screen. Hidden ones of no size are left out.
- **A row's texts are its label,** as TalkBack reads them: Settings' first
  row is `button "Network & internet, Mobile, Wi‑Fi, hotspot"`. A row's
  own text and a description that repeats it are named once.
- **The keyboard is one element,** `keyboard "English (US) (QWERTY)"`, with
  no keys listed, above the app in z-order, so a tap by reference under it
  is refused naming it. This was checked against a screen saved from the
  device, not on a live screen.
- **set_value selects with Ctrl+A on Android,** not Cmd+A: "Wallpaper" then
  "Brightness" in Settings' search field, each read back.
- **Held upside down,** Android kept drawing in its last landscape rotation
  inside a 1080x2400 picture. The tree is in the display's pixels, so the
  converter turns it into the picture's: a tap by a new reference opened
  Chrome's tab switcher, upside down and turned left.
- **An app is named by its label,** from the launcher's apps that the
  server lists in 50 ms. Settings' search, an activity of another app, is
  named by its window's title, "Settings Services". With the dump alone, an
  app is named by its package.

### Each tool's time

Times are the tool's, in the plugin, from the call to its answer, from one
run of `check.json` with each source.

| Tool | What | Through the dump (7.2) | Through the server (7.3) |
| --- | --- | --- | --- |
| `computer_windows` | the device's one window and the app in front | 1.9 to 3.7 s | 0.8 to 1.0 s, as it waits up to 1 s for a still screen |
| `computer_observe` | the tree | 1.90 to 2.15 s, median 1.91 s | 2 to 6 ms, median 3 ms; 0.4 to 1.0 s just after a turn or a new page |
| `computer_screenshot` | 706x1568, from 1080x2400 | 125 ms | 111 to 169 ms |
| `computer_act` click | a tap by reference, the change waited for and listed | 4.7 to 6.0 s, median 5.0 s | 1.0 to 2.2 s, median 1.3 s |
| `computer_act` scroll | Settings' list to its end, 8 of 50 steps, and back | 28.2 and 28.3 s | 8.3 and 9.2 s |
| `computer_act` set_value | Settings' search field, read back | 6.9 and 7.7 s | 1.6 and 2.1 s |
| `computer_act` set_value on a slider | refused | | 3 ms |
| `computer_type` | 'example.com' and Enter into Chrome's address | 7.8 s | 2.0 s |
| `computer_launch` | an app, until it is in the tree | 4.4 to 5.6 s | 1.3 to 2.5 s |
| A reference read before a turn | refused as void | 1.9 s | 14 to 54 ms |
| any act, type or launch while a person has control | refused | under 1 ms | under 1 ms |

063's live check, through the server, in one run: Settings, Connected
devices and back by references; Settings' list scrolled to its end and
back; About read; the search field set to "Wallpaper", then "s"; Sound &
vibration's Media volume slider refused with "Drag it with computer_act's
drag instead"; Chrome launched by name; 'example.com' and Enter typed into
its address, and the page loaded; a second tab opened by URL, and the tab
switcher read with a button "Example Domain, tab" for each tab, each with
its own reference, and the second tapped; the device turned left, a reference read before the
turn refused as void, and a new one tapped; a person's control: reading and
a screenshot went on, a tap, typing and a launch were refused at once, and
`computer_take_control` took it back. Through the dump alone the same check
ran except About, which the dump cannot read.

### What limits these numbers

- One model, the Pixel 8, in two boxes. The Pixel Fold and the Pixel
  Tablet were not driven.
- Settings, Chrome, the Home Screen and the probe app only.
- The harness ran in the box. Through BB, each tool adds the round trip to
  the box.
- The instrumentation tests were bb-box's own probe, calling
  `Instrumentation.getUiAutomation()` as AndroidX's runner and UiDevice do,
  not a Gradle project's `connectedAndroidTest`.

### Not checked here

- **A tap refused under the keyboard on a live screen.** A test reads it
  from a screen saved from the device.
- **Through the tools in a thread,** after the deploy.
- **TalkBack.** The server connects UiAutomation as `uiautomator` does,
  which turns other accessibility services off while it is connected.

## Unit 7.5: spares and copy from a device

Spares of ios and android boxes are off unless an operator sets a count,
as the owner decided on 28 October 2026. With a count, a device spare
boots each of its kind's models once, goes back to the default, and stops
to wait only once its device server says the device has booted. A claim
resumes it and switches to the model asked for. The panel's Copy to this
computer, and Cmd+C or Ctrl+C in the device view, put the device's
clipboard on the viewer's, for the tab with control.

### How it was measured

On 28 October 2026, on the production BB, after the deploy of main
38bd6bb (device server version 28). The lead set `kinds.android.spares`
and `kinds.ios.spares` to 1 at 16:23:48 UTC, and android back to none at
16:43:16. Each claim was a `box_acquire` from this thread: android at its
default size, 8 cores and 16 GiB, on Proxmox QEMU; ios with
`dedicated: true`, 6 cores and 16 GiB, on Tart. Each claimed box was
released before the next claim, so each spare was a fresh one that had
waited 1 to 4 minutes. Times are box_acquire's own: from the request to
the box ready, then to the model asked for booted. Cold boxes and the
android switches were timed with the code before the deploy, in an
android box of this thread.

### The doctor

With counts of 0, the doctor's Spares section says, for each device kind,
"Spares are off for android boxes: none is kept", and what a spare would
cost. With the counts at 1 it said "bb-box keeps 1 spare android box: 1
ready, 0 being made", and the same for ios.

### Making a spare

From the count set to the spare waiting stopped, as `bb box list --all`
showed it, read every 10 s:

| | android | ios |
| --- | --- | --- |
| The first spare | 2 min 16 s or less: a clone, the device's first boot, each model booted once, the hibernation | 2 min 52 s or less: the same, then the suspend |
| A replacement, from the claim | 2 to 4 min | 2 to 4 min |

### E16: ready times

To the model asked for booted, five claims of each kind:

| Path | android | ios |
| --- | --- | --- |
| A new box (cold) | 40.6 s: ready in 9.8 s, then 30.8 s, 25 s of it the device's first boot giving it its own Android ID | 26.8 s: ready in 19.0 s, then 7.8 s |
| A spare, its default model | 23.2 s and 12.1 s (resume 22.8 s and 11.4 s) | 7.4 s and 7.6 s |
| A spare, another model | Pixel Fold 30.1 s and 20.2 s, Pixel Tablet 26.9 s: the resume, then a switch of 8.8 to 10.5 s | iPhone 17 16.7 s and 18.6 s, iPad Pro 18.6 s: the resume, then 9.5 to 11.5 s |
| Its BB machine connected again | 12.1 to 33.2 s | 8.5 to 11.2 s |

Every ios claim restored from its suspend. A switch to a model not booted
before in the box took 31.4 to 31.7 s on android, against 4.8 to 8.3 s
(median 6.8 s, of 5) for one booted before. So a spare boots each model
once before it waits: a claim of any model then switches as one booted
before.

An android spare's resume took 9.2 to 22.8 s, against 3.7 to 4.8 s for
this thread's own box stopped and started straight away (5 times). The
spare's state held 16.8 GiB (below), read from disk after it waited; how
much of the difference is the page cache was not measured.

### E24: a spare's disk

Read by the lead on the hosts at about 16:30 UTC:

| | android spare, 16 GiB memory | ios spare, 16 GiB memory |
| --- | --- | --- |
| Saved memory | a 32.49 GiB thin volume, 51.69% used: about 16.8 GiB | `state.vzvmsave`, 5.2 GiB |
| Its own disk | 48 GiB thin, 50.12% used | 95.6 GB apparent, 85 GiB by du, an APFS clone of the image, most of it shared |

The doctor says a spare's saved memory takes "at most a little over" the
box's memory.

### A suspend that did not restore

A dedicated ios box suspended at 15:44:40 UTC did not restore at 16:24,
39.5 minutes later. bb-box's log has `VZErrorDomain Code=12 "The virtual
machine failed to restore with error "invalid argument"."`, the error E4
met after 24 h, with no macOS or Tart update between. The VM booted
afresh: the new start timing said "boot 16.7 s", and the device was back
10.5 s after the box was ready, 27 s in all, about a new box's time.
bb-box was redeployed at about 16:17, in between. E4's run of 62 minutes
had restored.

bb-box's log had, on that Mac, the deploy's start at 16:22:43, two VM
starts at 16:23:44 and 16:24:01 (the first ios spare being made), then the
failure at 16:24:08. bb-box starts every macOS VM with the same flags and
changes no config of a VM that exists. Three controlled trials then
restored, each a dedicated ios box with no other box of this thread's
running:

| Trial | Result |
| --- | --- |
| An ios spare suspended 49.6 minutes, with a warm VM cloned and started on the Mac 13 minutes before the claim; its config.json and nvram.bin checksums, sizes, times and MAC address the same before and after | restored: ready 9.0 s from the claim, no boot since its first |
| A box suspended, bb-box reloaded with no code change 10 s later, the box started 5 minutes after with no other VM starting | restored: 9.4 s, no boot |
| The same box suspended, then started at the same moment as a new box's `tart run`, which began 0.8 s after its acquire, during the 7.7 s restore | restored: 7.7 s, no boot |

So neither a wait of this order, a reload, nor another VM's start beside
the restore made it fail, and the cause is not known. A spare is kept no
longer than Tart's `warm-max-hours`, 6 by default, as warm VMs are, and a
claim of one that does not restore boots it afresh and says so: at 16:24
that took 27 s to the device, a new box's time.

### Copy from a device, in the panel

In the owner's browser (Helium), through the production panel, on an
ios box with the iPhone 17 and an android box with the Pixel Fold:

| Check | Result |
| --- | --- |
| Copy to this computer without control, each platform | "Take control first, then copy: only the tab with control reads the device's clipboard." |
| ios, Copy to this computer, the device's pasteboard set by `simctl pbcopy` | the 39 characters, "Copied 39 characters from the iPhone 17.", 504 ms from the click to the note |
| ios, Cmd+C in the device view | "Copied 26 characters from the iPhone 17.", 564 ms from the key, 400 ms of it the wait for the device to copy |
| android, text typed in the device's search field, Ctrl+A and Ctrl+C in the device view | Android copied it, and "Copied 34 characters from the Pixel Fold.", 439 ms from the key |
| android, Copy to this computer | 318 ms. It held the text the iPhone's copy had put on the browser's clipboard, which taking control of the Pixel Fold had put on the device |

Taking control puts the browser's clipboard on the device, as it did
before this unit, so a device's clipboard read just after taking control
is the browser's.

### What limits these numbers

- Five claims of each kind, each spare waiting 1 to 4 minutes, on one
  Proxmox host and one Mac. A spare that waits for hours was not claimed.
- A failed switch on claim was not seen live: a claim asks only for a
  model the box offers, and each switched. The device-delivery test claims
  a model the device refuses, and the box keeps its model with words.
- No template or image was rebuilt, so a spare of an old build was not
  replaced live. Tests cover Proxmox's build check, which is older, and
  Tart's new one.
- Times are box_acquire's, rounded to 0.1 s.

### Not checked here

- **The cause of the failed restore.** One difference from the trials was
  not repeated: that box was suspended 54 s after its VM booted, by the
  bb-box before the deploy.
- **iOS's own copy** by Cmd+C of selected text in an app. The keyboard
  path was checked with text the host put on the pasteboard.

## F-15: the viewer's clipboard goes only with a paste

Built on 28 October 2026, from the owner's decision that day. Taking
control of a device put this computer's clipboard on the device, so a
test put a person's own clipboard on a test device. The same effect put
it on every desktop at control and at each focus of the window. The
owner decided that desktops follow the same rule.

What changed:

- **No push.** The panel no longer reads this computer's clipboard when
  the tab takes control or gets the focus, for devices and for every
  desktop: Selkies, noVNC, Tart and Windows.
- **A paste reads it then.** Cmd+V or Ctrl+V in the viewer, and Paste
  from this computer, read the clipboard at the paste. On a desktop they
  work as before.
- **A device pastes it whole and puts its clipboard back.** The viewer
  sends a device one `paste` request, text only, new in device server
  version 29. The server pastes it in batches of up to 2,000 characters,
  each with the device's clipboard saved and put back, as for the agent
  (E21), even when every letter has a key. Before, Cmd+V left the
  person's text on the device's clipboard. A server older than 29 is sent
  the text as `text` instead, which types it or pastes it, with the
  clipboard put back too. An image is refused with words, and so is text
  over 100,000 characters.
- **The device server drops `cw`.** From version 29 it puts no viewer's
  clipboard on the device, so a tab opened before this change cannot push
  one. Such a tab's Cmd+V pastes the device's own clipboard until the tab
  reloads. bb-box's paste for Tart's and Windows' desktops refuses the
  automatic send such a tab makes.
- **The menu says so.** Under Paste from this computer: "A paste from the
  box's own menu, or a middle click, uses the box's own clipboard", or
  "A paste from the device's own menu uses the device's own clipboard".
- **The agent's path** (computer_type and box_device's text) never used
  the viewer's clipboard, and is unchanged. Copy from a device (unit 7.5)
  is unchanged.

Tests: taking control and the window's focus read no clipboard and send
none, to a device or a desktop; Cmd+V and Paste each send it once, as one
`paste` request; a paste the device refuses shows its words; text over
the limit sends nothing; the device server drops `cw` from either
connection, and pastes a `paste` request whole with the clipboard put
back.

### F-15 in the panel

On 28 October 2026, through the production panel after the deploy, in
the owner's browser (Helium), in a tab of its own, freshly loaded. The
tab's `navigator.clipboard` was replaced by stubs that count each read
and return a test value set in the tab, and keep each write in the page,
so no step read or wrote the computer's own clipboard. Each box's
clipboard held a marker set in the box first: on the devices, typed into
a field by the agent and copied there; on the desktop, by `xclip`. Cmd+V
was a Cmd+V key event and a paste event carrying the test value,
dispatched in the device or desktop view. The device's clipboard was
read back by Copy to this computer, into the stub. Device server version
29.

| Check | android, Pixel 8 | linux-desktop-cpu | ios, iPhone 18 Pro, shared slot |
| --- | --- | --- | --- |
| Take control, then a focus of the window, 3 s | no read of this computer's clipboard; the device's still the marker | no read; the box's still the marker | no read |
| Cmd+V with the test value | "Pasted"; the value in the field; the device's clipboard the marker again | "Pasted"; the value in the field and on the box's clipboard, as on any desktop | not run |
| Paste from this computer | one read; "Pasted"; the value in the field; the clipboard the marker again | one read; "Pasted"; the value in the field | one read; refused: "simctl could not set the device's clipboard", shown as the problem line |
| The words under Paste from this computer | the device's | the desktop's | the device's |

Findings:

- **Chrome on the Android device took no paste.** It took neither the
  person's paste nor the agent's (Japanese text by computer_type) from
  its first start, past the 4 that unit 5.1 found. A native field, the
  Contacts editor's, took every paste, so the checks above ran there.
- **`simctl pbcopy` and `pbpaste` crash on shared iOS slots.** On a slot
  on the pool's Mac (Xcode 27.0, macOS 27.0.1) and one on a Namespace Mac
  (Xcode 26.1.1), both exited with code 139 from `box_run` and from the
  device server, so neither paste nor copy works on an ios box shared
  today; unit 7.5's check, earlier the same day, read the pasteboard. A
  dedicated ios VM could not be had: both of the Mac's VMs were in use.
  So "a paste arrives on iOS" is not shown here; the iOS paste path did
  reach the device server, which refused it in words.
- **Another plugin reads the clipboard at a paste.** In the desktop view,
  a Cmd+V's paste event also made the BB canvas plugin's editor call
  `navigator.clipboard.read()`, from its own document paste listener. It
  reads only at a paste, and sends nothing to a box.

## F-17: a shared slot's clipboard

Built on 28 October 2026. F-15's live check found that `xcrun simctl
pbcopy` and `pbpaste` crash, with exit code 139, on every shared ios slot:
from `box_run` and from the device server alike. So Paste from this
computer, Copy to this computer and an agent's typing of text a US keyboard
does not have all failed on a slot. Shared slots are the default, so this
hit most ios boxes.

### The cause

simctl does not write to the device's pasteboard directly. It puts the text
on a pasteboard of the Mac's own, named uniquely for the call, and
CoreSimulator's SimPasteboardPlus syncs that to the device. The Mac's
pasteboards are served by `pboard`, a LaunchAgent macOS loads only in a
desktop (Aqua) session. A slot's user never signs in at the console
([064](064-ios-shared-hosts.md)), so it has no Aqua session: `launchctl
managername` says `Background` in `box_run`, and the device server is a
LaunchDaemon in the system domain. Under lldb, on the pool's Mac (macOS
27.0.1, Xcode 27.0):

- "Connection to 'pboard' server had an error ... Connection init failed at
  lookup with error 3 - No such process", then "Failed to set up
  CFPasteboardRef 'CFPasteboardUnique-...'"
- then `EXC_BAD_ACCESS` at address 0x8 in `__CFCheckCFInfoPACSignature`, on
  CoreSimulator's queue `com.apple.CoreSimulator.NSPBObservation`: simctl
  uses the pasteboard it failed to make

The same exit code came on a Namespace Mac (Xcode 26.1.1). idb_companion
has no pasteboard call, and CoreSimulator's own pasteboard classes manage a
Mac pasteboard too, so every way to the device's clipboard needs `pboard`.
A box with a desktop session has it, which is why unit 7.5's earlier read
worked.

### The fix

- **The calls run in the user's own launchd session.** A slot's user may
  load a LaunchAgent into its own `user/<uid>` domain without root, from
  the device server's LaunchDaemon too. When the device server is not in an
  Aqua session, it loads macOS's own `/usr/libexec/pboard` there, as
  `app.bb-box.pboard`, for the background session, with the Mach services
  `pboard`'s own plist gives. It then runs each `pbcopy` and `pbpaste` as a
  short launchd job in that domain, with the text in a file and its exit
  code kept, and boots the job out after
  ([`user-session.ts`](../../src/device/user-session.ts)). A user with a
  desktop session elsewhere has its jobs run there, with macOS's own
  `pboard`. A server in a desktop session, as on a dedicated box, runs
  simctl where it is, as before.
- **The server loads `pboard` as the device boots,** so an agent's own
  `xcrun simctl pbcopy booted` in `box_run` works on a slot as well.
- **Only the environment simctl needs goes into a job's plist:** `HOME`,
  `USER`, `LOGNAME`, `PATH`, `TMPDIR` and the locale. The device server's
  own environment is never written.
- **Jobs a stopped server left** are booted out and removed at the next
  server's first job.
- **No host step.** The device server is delivered as before, now version
  30, so the pool's Mac, Tart hosts and Namespace hosts get the fix with
  it. No helper changes.
- **Checks.** `slot-clipboard.sh` sets and reads a device's clipboard the
  same way, as a given user, and says where. The iOS image's check runs it
  on carried slot `bbd-i1`'s device. The pool's `mac-ios.sh` runs it as the
  admin user, which has no desktop session, on a device made for the check
  and deleted after, and warns if it fails. It does not run on a Namespace
  host's start, which boxes wait for.

### Measured before the deploy

The new server was put in a slot's own `~/.bb-box/device/server/29` and
started again by launchd, so it ran as production runs it:

| Slot | Before | After |
| --- | --- | --- |
| Pool's Mac, iOS 27.0, Xcode 27.0 | `pbcopy` and `pbpaste` exit 139; `computer_type` of `bbtest é✓` fails: "simctl could not set the device's clipboard" | `computer_type` of `bbtest ✓ 日本 é` arrives whole; the clipboard reads back what it held before; `box_run`'s own `pbcopy` and `pbpaste` work, UTF-8 intact |
| Namespace Mac, iOS 26.2, Xcode 26.1.1 | exit 139 | `✓`, `日本`, `abc✓` and `a✓b日本c` arrive; `box_run`'s own calls work. See the follow-up below |

A job in the slot's domain took 0.13 to 0.17 s for a `pbcopy` or `pbpaste`
on the pool's Mac, by `perl`'s clock around the launchd job, against 0.08 s
for a direct call where `pboard` runs. On the Namespace Mac a call in the
slot's own session took 0.20 to 0.24 s.

### Checked after the deploy

On production BB at main dd05f65, device server version 30, on 28 October
2026, with test values only:

| Box | What was checked | Result |
| --- | --- | --- |
| Shared slot, pool's Mac, iOS 27.0 | the panel's Copy to this computer, with `bbtest device copy ✓ 日本` on the device's clipboard | "Copied 23 characters from the iPhone 18 Pro", and the text came whole |
| | the panel's Paste from this computer, into Safari's address field | "Pasted"; the field read `bbtest panel paste ✓ é 日本`, and the device's clipboard held its own text again after |
| | `computer_type` of `bbtest ✓ 日本 é` | arrived whole |
| | `box_device` appearance dark; `box_run`'s own `pbcopy` and `pbpaste` | 0.3 s; both worked, UTF-8 intact |
| Shared slot, Tart host, iOS 27.0 | `box_run`'s own `pbcopy` and `pbpaste` | worked from about 15 s after the device booted; before that, exit 60 (see below) |
| | `computer_type` of `✓ 日本` | arrived whole |
| Dedicated Tart box, iOS 27.0 | where the device server runs simctl | in its desktop session, as before: no `pasteboard:` line, no session folder, no pasteboard server of bb-box's own |

The panel's tab replaced `navigator.clipboard`'s read and write with test
stubs before the page loaded, so the panel's own code read a test string
and wrote to the stub. The Mac's own clipboard was never read or written.
That also means Cmd+V in the viewer could not be checked this way: a key
sent through Chrome's DevTools Protocol does not run the browser's paste,
so it went to the device as keys and pasted the device's own clipboard.
The Paste menu and Cmd+V send the same `paste` request (F-15).

Not checked after the deploy: a Namespace slot, whose code is the same as
the one measured there before it.

### The image's check line

Run by hand on a dedicated Tart box cloned from the iOS image, as
`bb-box-check-ios` will run it, on carried slot `bbd-i1`'s device:

- **The device's pasteboard answers some seconds after it reports booted.**
  Just after `simctl bootstatus -b`, `pbcopy` exits 60, "Operation timed
  out", at once and 5 s later, and works 10 s later. So `slot-clipboard.sh`
  now sets the clipboard up to 12 times, 5 s apart, and says on which try it
  worked.
- **Its words were lost.** A failure went to standard output, which the
  first set sent to `/dev/null`. Each failure now goes to standard error,
  which both callers keep.
- With both fixes: "bbd-i1 set and read its device's clipboard, UTF-8
  intact, in its own session, user/79991, with macOS's pasteboard server
  loaded there, in 1.4 s", in 7 s with the boot. The device was shut down
  after, the helper's status said the slot was ready and not booted, and
  nothing was left loaded or on disk.

### Follow-ups

- **A paste in a device's first seconds fails.** The device's pasteboard
  answers about 10 to 15 s after the device reports booted, on every kind
  of box. Until then simctl exits 60. The device server could wait for it
  as the check now does.
- **A paste can put in the clipboard's earlier text, or nothing.** On every
  kind of box, a dedicated one too, so it is not F-17's change: on a
  dedicated Tart box, `a✓b日本c` arrived as `a ✓c` and `bbtest ✓ 日本 é` as
  `bbtest é`; on a Namespace slot, `ab ✓` as `ab`; on a Tart host slot just
  after a reboot, `bbtest ✓ 日本 é` as `bbtest bbtest tart host ✓ 日本`, the
  text the clipboard held before. A paste alone, such as `✓ 日本`, arrived
  each time. A 500 ms wait before the clipboard is put back, instead of
  100 ms, did not change it on Namespace. The likeliest cause is that
  simctl returns before the device has the new text, so the paste key reads
  the old text, or the text being put back. The device server could read
  the clipboard back until it holds the text before it presses the paste
  key, and wait longer before putting it back.
- **Accessibility on a fresh Tart host slot.** On the first Tart host slot,
  every read of the screen timed out, "did not answer a frontmost request
  within 5.0s", until a `box_device` reboot.

## F-20: Settings taps, the front app and web pages

Built on 28 October 2026. QA on a shared ios slot (iPhone 18 Pro, iOS
27.0, slim on) found three faults: taps on Dark and on the Bold Text switch
in Settings > Appearance did nothing, though `computer_act` said each
landed on the right control; twice the tools said "the Home Screen or a
system screen in front" while Safari was in front; and Safari's page showed
no elements.

### Dark and Bold Text: iOS applies them only for uid 501

The cause is neither slim nor a missing session service. The simulator
applies a system setting that another process changed, as Settings and
`simctl ui` do, at once only when the macOS user's uid is 501, iOS's own
`mobile` uid. A slot's user never has uid 501.

- **The setting is written.** A tap on Dark makes Settings write
  `UserInterfaceStyleMode = 2` through cfprefsd, and SpringBoard gets
  cfprefsd's change notice. On a slot it then never reads the domain
  again, so its style arbiter never acts. On a dedicated box the same
  notice makes SpringBoard read the domain, and the arbiter switches the
  style within 3 ms. Later taps on Dark changed nothing at all, as the
  setting already read dark.
- **The uid, measured on one VM.** On a dedicated VM, with the same runtime,
  a stock device (nothing slimmed) and both run from a background launchd
  domain, `simctl ui appearance dark` turned Settings dark at once for the
  admin user (uid 501). For a second user made for the check (uid 80100) it
  stayed light, though simctl then read "dark". Text size behaved the same.
  CoreSimulatorService runs in `user/<uid>` for both, and the user name
  CoreFoundation sees is empty for both, so neither the session nor the
  name is the difference. Setting `USER=mobile` in the device's launchd did
  not help.
- **Slim is ruled out.** On a dedicated box with slim on, Dark by reference
  worked at once.
- **A change is not lost.** It shows after a device reboot, 7.0 to 7.1 s,
  or minutes later when SpringBoard reads the domain for another reason.
- **A SpringBoard restart shows it too, in about 2 s plus SpringBoard's
  start, but breaks reading the screen.** Every read then timed out, "did
  not answer a frontmost request within 5.0s", and stayed so after a new
  idb_companion and a restart of CoreSimulatorBridge, until a reboot. So
  bb-box reboots instead.
- **Bold Text by reference tapped the row's centre.** idb gives a switch in
  a row as one element whose frame is the whole row, 16 to 386 points
  across for Bold Text. A tap at its centre, 201 points, does nothing on
  iOS; the knob, near 340 points, toggles it.

What changes:

- The device server knows whether its user's uid is 501. Where it is not,
  bb-box's `appearance` and `text_size` controls set the value and then
  reboot the device, so the read-back matches the screen. The server
  treats them as a reboot: input under way stops, and the control gets the
  reboot's 120 s deadline, on the plugin's and the panel's side too.
  Measured on a slot with the server: appearance light, reboot included,
  10.2 s, and Bold Text, set earlier by a tap, showed with it.
- The device's state carries `changesShowAtStart` on such a device. The
  control's answer and the panel's note say the device rebooted to show the
  change and that open apps closed. After a tap in Settings that changes a
  switch, or changes no element, as a tap on Dark there does,
  `computer_act` says the change shows after `box_device` reboot, and that
  a dedicated box shows it at once.
- A switch in a row, wider than three times its height, is listed at its
  knob: 63 points wide, ending 14 points in from the row's right. The tree
  and a read at a point give the same frame, so a tap by reference lands on
  the knob and its check still finds the switch. Live on a slot, Bold Text
  by reference went from 0 to 1.
- Device server version 31. The new state field is optional, so a plugin
  reads an older server's state as before.

### The front app misread: an app iOS names no one

Opened cold by URL on a slot, Safari was in front for 8.5 s, from 1.7 s
after `openurl` to 10.1 s, as an application element with an empty label
and no children, read every 100 ms. bb-box took the root's label as the
app's name, so it said "the Home Screen or a system screen".

- An unnamed application element is named from its process: the program's
  path, from `ps`, matched to the app whose folder holds it in `simctl
  listapps` (77 ms, kept per process). SpringBoard is never named this way.
- An application element with no children says it is still starting, with
  a line to observe again in a few seconds. The tools treat it as not yet
  drawn, so `computer_launch` waits for its elements, at most 5 s as
  before, and its heading says "Safari (still starting) in front" if it is
  still starting then. A URL open waits for a named app with elements,
  rather than taking the Home Screen as drawn.
- Live on a slot, with Safari cold: `computer_launch` of a URL said "Safari
  in front" while Safari was starting, and `computer_observe` showed the
  line "still starting: iOS shows none of its elements yet".

### Web pages, read point by point

iOS's nested tree stops at Safari's own controls, but a read at a point of
the page names its element, from the page's own process: 150 points of a
Wikipedia page in 282 to 342 ms gave 26 or 27 distinct links, buttons and
texts.

- Where a named app's own labelled elements leave the screen's middle
  uncovered, bb-box reads that one point. The Home Screen is not read this
  way, as its widgets are other processes' too. When the point's element
  belongs to another process,
  it reads the screen at 6 points across and every 30 points down, less the
  points the app's own elements cover, 8 at once, and lists what the page's
  process gives in a `web view`, before the app's own controls. The web
  view scrolls; its elements do not each say so.
- Cost: none where the app's elements cover the middle, as in Settings;
  one point read, 5 to 17 ms, where the middle is the app's own; with a
  page in Safari, a read of the screen took 397 to 639 ms in all, against
  about 45 ms without the page.
- The web view's value says the page was read point by point and that an
  element smaller than the points' spacing may be missing, with
  `computer_screenshot` for the whole page.
- Live on a slot: example.com listed its texts and its link "Learn more";
  a tap on the link by reference opened iana.org. At the screen's bottom
  edge, under Safari's toolbar, the same tap did nothing until a scroll
  brought the link up, as iOS keeps that edge for its own gestures.

### Checks

Unit tests: `readIosTree` names an unnamed front app, says one with no
children is still starting, lists a page in a web view and reads no point
where the app covers the middle; a row switch's frame is its knob; the
driver reboots after appearance and text size for a uid other than 501 and
not for 501; the answer's and the computer tools' words; the state's new
field reads back.

### Live checks after the deploy

Through production on 29 October 2026, device server version 31, an iPhone
18 Pro on iOS 27.0, slim on. An agent's taps went through `computer_act`; a
person's through the panel in the owner's browser, by mouse on the device's
picture after Take control.

| Check | Shared slot | Dedicated box |
| --- | --- | --- |
| Safari opened cold by URL | "Safari in front"; `computer_observe` listed the page's 6 texts and its link "Learn more" in a `web view`, then Safari's 5 controls | the same |
| An agent's tap on Dark, by reference | the setting read dark (`UserInterfaceStyleMode = 2`), the screen stayed light, and the answer said to reboot to see it | dark at once, no such words |
| An agent's tap on Bold Text, by reference | 0 to 1, with the same words; the labels stayed regular | 0 to 1, bold at once |
| `box_device` reboot | 7.1 s; then Settings was dark and bold | not needed |
| `box_device` appearance light | 10.1 s, with "The device rebooted to show it: on a shared box ..."; the screen light | not tried by the agent |
| A person's taps in the panel, on Dark and on Bold Text's knob | the settings changed (dark, and Bold Text 0), the screen did not | Light and Bold Text off, shown at once |
| A person's Reboot device in the panel | 6.8 s; then dark, labels regular | not needed |
| A person's Dark appearance in the panel | the note "Set the iPhone 18 Pro to light in 10.1 s." and the reboot's reason, 10.5 s after the click | dark within 4 s, no reboot, no note of one |

One fault came out: on the slot, the reboot words also followed a tap on
Appearance in Settings' list, a tap that changes no setting, because the
new page's switches counted as switches that changed. Now only a switch
whose own value changed counts, as Bold Text's 0 to 1 does; a page of new
switches does not.

### Follow-ups

- A person's change in Settings on a shared slot still needs a reboot to
  show. Making the device's processes see uid 501, by loading a small
  library into each, might fix it at the root, but it changes what every
  app sees, so it is left for a trial of its own.
- The SpringBoard restart's lost screen reads look like the fresh Tart
  slot's above: both end only at a reboot.

## F-19: device boxes in the Boxes filter, and Simulator and Emulator tabs

Built on 28 October 2026, from the owner's annotated screenshots that day.
The Boxes page's filters had no way to find a device box, and a device
showed in a panel tab named Desktop.

What changed:

- **iOS and Android are systems.** The filters offer them under System,
  after Linux, macOS and Windows. A box with a device has its device's
  system, not its host's, so a shared ios box is iOS rather than macOS.
  They are systems, not a Device group of models, because the New box form
  offers them as systems, and a box's model changes when its device
  switches. The search matches a box's device, such as iPhone 18 Pro.
- **A device has a tab of its own.** A new panel action, Device, with a
  phone for its icon, shows a box's device in a tab titled Simulator for
  an ios device or Emulator for an android one. A box with a device and a
  desktop, such as a dedicated ios box, has two tabs, its device's and
  Desktop, each with a button that opens the other. A tab's title says
  which box only when another of the thread's boxes would have a tab of
  the same name, as in 'Simulator · box-2'.
- **A bare Desktop tab retitles itself.** Opened from the launcher, a
  Desktop tab whose one box has only a device shows the device and
  renames itself Simulator or Emulator. BB titles a tab only as it opens,
  and opening one again with the same params retitles it.
- **Control stays across a box's two tabs.** Going from a box's Desktop
  tab to its Simulator tab keeps control past the hidden tab's minute.

### F-19 in the panel

On 28 October 2026, after the deploy (main 3ad3e01), through the
production panel in the owner's browser (Helium), in a tab of its own, at
1,440 and 360 px wide:

| Check | Result |
| --- | --- |
| A shared ios box's row and tab | "Open simulator" on the row opened a tab titled Simulator, with the phone icon in BB's tab strip beside the Box tab's cube, and no Desktop button |
| An android box's row and tab | "Open emulator" opened a tab titled Emulator, with the phone icon |
| The Boxes page's filters, the list searched to this thread's boxes | System offered Linux, macOS, iOS and Android; ticking iOS listed only the ios box, ticking Android only the android box, with the other systems greyed |
| A dedicated ios box, a Tart VM, beside the shared one | its row had "Open simulator" and "Open desktop"; its tabs were titled "Simulator · " and the box's name, as the shared box's tab also said Simulator, and Desktop, as no other box had one. The Simulator tab's Desktop button opened the Desktop tab, with the cube icon and a Simulator button, and the Device Hub words naming the Simulator tab; that button went back to the Simulator tab |
| At 360 px | the filters' sheet offered iOS and Android, and ticking iOS listed only the ios box; each tab showed its title and phone icon alone in the strip, with Previous and Next to the others, and the dedicated box's two tabs kept their buttons. "Simulator · " and a box's name is cut short there |

Before the deploy, on a fresh BB in a box with bb-box from the branch and
the test device on: a bare Desktop tab whose one box had only the test
device renamed itself Emulator, and BB kept that title for the tab.

## F-21: an iOS paste that arrived wrong or late, and a new host's first reads

Built on 28 and 29 October 2026, from F-17's three follow-ups. Device
server version 32.

### The causes

**The earlier text was pasted because it was put back too soon.** simctl
does not return early: on a dedicated Tart box, 8 `pbcopy` calls each
returned 10 to 11 ms after the device's log said "Successfully finished
writing new snapshot to pasteboard". The app reads the pasteboard when it
handles Cmd+V, and after a boot the device handles the key late. Caught in
the device's log on a dedicated Tart box, 6 s after a reboot, as the
agent's `computer_type` put `bbtest ✓ 日本 é` into the probe app's field:

| Time | What |
| --- | --- |
| 19.759 | the device holds `✓ 日本` |
| 20.100 | the earlier text is back on the device, put back by the server 100 ms after the paste key |
| 20.572 to 20.605 | the keyboard, shown for the first time since the boot, reads the pasteboard 6 times |
| 20.848 | the app reads the pasteboard, and pastes `bbtest earlier clipboard` |

On a device that had settled, the app read 0 to 52 ms after the key, so
the 100 ms that E21 measured was enough there.

**The keys after a paste were lost behind iOS's notice.** '<app> pasted
from CoreSimulatorBridge' takes the keyboard while it shows: SpringBoard
logs `deferFromSBWindowScene: adding rule` for it, and `invalidate` when
it goes. It shows for about 2.55 s from about 50 ms after the app's read,
so the server's hold on keys, 2.6 s from the paste key (E21), was enough.
After a boot, the first notice came 450 ms after the read and went 3.1 s
after the key. The keys typed at 2.6 s were lost: `bbtest ✓ 日本 é` lost
` é` on the first paste after each of 3 reboots and server restarts. Each
paste shows two notices, one for each of the app's two reads, the second
at once after the first.

Safari's address field, where F-17's check typed, lost text the same way
after a boot, and took the same text whole once the device had settled.

**A just-booted device's pasteboard does not answer.** On a Tart host made
for the box, `simctl pbcopy` exited 60, "Operation timed out", from 7 to
12 s after the server said the device had booted, and worked from 13 s,
15.6 s after simctl's own boot. On a host some minutes old, and on a
dedicated box, it worked at once after a reboot.

**Reads failed because the device was not ready.** On a Tart host made for
the box, the first `computer_observe`, about 10 s after the boot, failed
with "did not answer a frontmost request within 5.0s". idb_companion's log
showed the rest of the device still starting: its HID transport was
negotiated 20 s after the boot, and accessibility first answered at 25 s.
The server had said the device booted at 4 s. A read at 25 s worked, and
so did every read after it. Of 3 new hosts, 1 failed this way, and 2 read
little or none of the Home Screen, point by point. Reads that failed until a
reboot, as in F-17's check, were not seen.

### The fix

- **A set returns only once the device holds the text.** The server reads
  the clipboard back every 50 ms, for at most 5 s. If the device never
  holds it, the paste is refused in words, no paste key goes, and the
  clipboard is put back.
- **A pasteboard that does not answer is waited for.** On simctl's exit
  60, `pbcopy` and `pbpaste` are tried again every second for up to 30 s,
  then refused in words.
- **The clipboard goes back after the app's read.** From just before the
  paste key, the server streams the device's log, filtered to the
  pasteboard's "is requesting item" and SpringBoard's keyboard lines
  ([`ios-paste-watch.ts`](../../src/device/ios-paste-watch.ts)). It puts
  the clipboard back 250 ms after an app's read, or 5 s after the key if
  no app reads. The keyboard's reads and simctl's own do not count. Where
  the log cannot be watched, it waits 1.5 s.
- **Keys wait for the notice to give the keyboard back,** with 100 ms
  free of any notice, for at most 6 s. If no notice shows within 1.5 s of
  the read, or the log cannot be watched, the 2.6 s hold applies as
  before.
- **The device is said to be booted only once it answers.** After a boot,
  the server reads the screen and the pasteboard every second until both
  answer, for at most 45 s, and logs how long it waited, or which did not
  answer. "No frontmost application" counts as an answer.
- **A log stream is stopped with SIGINT,** then SIGKILL if simctl has not
  ended 2 s later. With SIGKILL alone, 3 of 4 paste watches left the
  device's own `log stream` running under the device's launchd; with
  SIGINT, none of 6 did. The HID daemon's watch at boot ends the same way.

### Measured before the deploy

The change, with lab-only log lines, was put in the box's own
`~/.bb-box/device/server` and started again by launchd, so it ran as
production runs it. The agent's path was `computer_type` through
production BB. Runs of 20 went through the device server's own socket, as
the person's input connection does: keys as `kd` and `ku` messages and
pastes as `paste` requests, as `computer_type` splits them, each field read
back by the server's `tree` and the clipboard by its `clipboard` request.
The clipboard held a test value first; test values only.

| Check | Version 30 | This change |
| --- | --- | --- |
| Dedicated Tart box: `computer_type` of `bbtest ✓ 日本 é` into the probe app, 6 to 30 s after a reboot | `bbtest bbtest earlier clipboard`, 2 of 2 | whole, 1 of 1; the app read 47 ms after the key; the notice went 3.1 s after it |
| Dedicated Tart box: 20 mixed texts in a row | | 20 of 20 whole, the clipboard put back each time |
| Shared slot on a Tart host: the same 20 into Safari's address field, the first 40 s after the device started again | | 20 of 20 whole, the clipboard put back each time |
| Shared slot: `computer_type` of `bbtest agent ✓ 日本 é naïve` into Safari | | whole, the clipboard put back |
| Shared slot: a reboot on a host a minute old | | the server waited 4.7 s more for accessibility and the pasteboard to answer; the next `computer_observe` read the whole Home Screen in 48 ms |
| A set and its read-back | | 0.24 to 0.36 s on the slot, 0.25 to 0.34 s on the dedicated box |
| The panel's `paste` request, from the request to its answer | 0.6 s | 1.2 to 1.6 s |

The 20 texts were, in turn: `bbtest ✓ 日本 é`, `a✓b日本c`, `ab ✓`, `✓ 日本`,
`Grüße, 世界 — ok`, `naïve café ✓`, `日本語のテキスト` and `x→y ∑ 🙂 z`. In 6 of
each 20, iOS added its smart-paste space (E21): `a ✓b 日本c` and
`x →y ∑ 🙂 z`. Text with line feeds, CRLF and a decomposed é read back
byte for byte, so the read-back's comparison is exact.

A paste costs about 0.6 s more: 0.3 s for the log to listen, while the
apps are let paste, about 0.3 s for each read-back, and the 250 ms after
the read. On a host made for the box, the boot is said about 15 to 25 s
later, the time in which reads and pastes failed before.

### Checked after the deploy

On production BB at main a90c5f9, device server version 32, on 29 October
2026, with test values only. The agent's checks went through
`computer_type`; the runs of 20 went through the device server's own
socket, as before the deploy.

| Box | Check | Result |
| --- | --- | --- |
| Shared slot on a Tart host made for it | the first `computer_observe` | the whole Home Screen, 14 elements, first time, in 39 ms. In the boot, two reads of the screen went unanswered, after 10.3 and 7.7 s; the server said the device booted only when the third answered, 20.4 s after the boot |
| | `computer_type` of `bbtest after boot ✓ 日本 é` into Safari, at once after a reboot | arrived as `✓ 日本 é`: the device's first keyboard showed iOS's tip "Speed up your typing by sliding your finger across the letters", and the keys before the paste went to it. The paste arrived and the clipboard was put back |
| | the same, after the tip's Continue and another reboot | whole, the clipboard put back |
| | 20 mixed texts in a row into Safari's address field | 20 of 20 whole, 5 with iOS's smart-paste space; the clipboard put back each time; no paste line in the server's log and no log stream left |
| Dedicated Tart box | `computer_type` of `bbtest ✓ 日本 é` into the probe app, the device's first boot | whole, the earlier clipboard put back |
| | `computer_type` of `bbtest reboot ✓ 日本 é`, at once after a reboot | whole, the earlier clipboard put back |
| | the same 20 mixed texts into the probe app | 20 of 20 whole, 5 with the smart-paste space; the clipboard put back each time; no log stream left |

The server waited 8.3 s for the dedicated box's device to answer after
its first boot, and 5.0 to 6.0 s after each reboot, on both kinds of box.

### Not checked here

- **A Namespace slot and the pool's Mac,** whose clipboard goes the same
  way as a Tart slot's, through the user's own launchd session.
- **Android** is unchanged: its clipboard goes back 300 ms after the paste
  key (E21).

### Follow-up

- **The keyboard's first-use tip takes keys.** On a device whose keyboard
  has never shown, iOS shows a tip with a Continue button as a field takes
  the focus, and keys typed then are lost. A new slot's device, made
  fresh, has it; the image's carried devices may not. The image could mark
  the tip as seen, or `computer_type` could look for it.

## F-22: device box badges, narrow tab titles and tab icons

Built on 28 October 2026, from the owner's request that a device box's row
have badges as a desktop's has.

What changed:

- **A device box's row reads as a desktop's.** Its system is its device's,
  iOS or Android, then the device's model, then badges: Simulator or
  Emulator where Desktop goes, and Shared, for a macOS user on a shared
  host, or the box's form, such as VM, where a desktop's form goes. A
  dedicated ios box keeps its Desktop badge after Simulator.
- **A tab on a narrow screen is named for its box alone.** Under 768 px,
  BB's compact layout, a tab that would be 'Simulator · box-2',
  'Desktop · box-2' or 'Terminal: box-2' is 'box-2', as its icon says what
  it shows. A name that is the only one of its kind, such as Simulator,
  stays.
- **The Desktop and Terminal tabs have icons of their own**: a monitor and
  a terminal, as the Device tab has a phone.

### F-22 in the panel

On 29 October 2026, after the deploy (main 1652050), through the
production panel in the owner's browser (Helium), in a tab of its own,
the Boxes page searched to this thread's boxes, at 1,440 and 360 px wide:

| Check | Result |
| --- | --- |
| The panel's launcher | Box with the cube, Desktop with a monitor, Device with a phone, Terminal with a terminal |
| Rows, in a pane wide enough | a shared ios box 'iOS iPhone 18 Pro [Simulator] [Shared]'; a dedicated ios box, a Tart VM, 'iOS iPhone 17 [Simulator] [Desktop] [VM]'; an android box 'Android Pixel 8 [Emulator] [VM]'; a Linux desktop 'Linux [Desktop] [LXC]'. The Boxes page at 1,440 px showed each in full |
| Rows, in the thread's pane at its width then, 506 px | the shared ios row showed Simulator but not Shared, and the dedicated row Simulator but not Desktop or VM: badges that do not fit drop from the end, as they always have, and a device's model takes room a desktop's row does not have |
| Tabs at 1,440 px | Simulator, Emulator, Desktop and 'Terminal: ' and the box's name, each with its icon. With a Linux desktop and a dedicated ios box, 'Desktop · ' and each box's name |
| Tabs at 360 px | a terminal's tab was the box's name alone, with the terminal icon. The two clashing Desktop tabs were each box's name alone, with the monitor icon, and Simulator and Emulator kept their names, with the phone |
| Rows at 360 px | the name, system and model, and no badges, as a desktop's row had before. A dedicated ios row, with four buttons, showed none of its name: the system and model do not give way |

## F-22b: a row keeps its name and its key badges

Built on 29 October 2026, from F-22's live check. In the thread pane's
506 px, badges that did not fit wrapped out of sight from the end, so a
shared ios row lost Shared. At 360 px, a dedicated ios row lost all of its
name.

What changed:

- **A row's first line places its parts in order.** It measures them and
  keeps the name whole, then the system, then badges by rank: Simulator,
  Emulator, Shared, the box's form and BB machine first, Desktop next,
  then the rest. The device's model takes what is left, cut, and is
  dropped under 32 px. The name is cut only when it alone does not fit.
- **One quick action on a narrow screen.** Under 768 px, a row has its
  first quick action beside its menu, which has the rest.

### F-22b in the panel

On 29 October 2026, after the deploy (main 52b4def), through the
production panel in the owner's browser (Helium), in a tab of its own,
the Boxes page searched to this thread's boxes. "Room" is the first
line's width, as the browser measured it:

| Row | Thread pane, 506 px of a 1,440 px window | 360 px |
| --- | --- | --- |
| Shared ios | room 302: name, iOS, 'iPhone 18 Pro' cut to 64 px, Simulator, Shared; 2 quick actions | room 188: name, iOS, Simulator; Open simulator and the menu |
| Dedicated ios, a Tart VM | room 242: name, iOS, 'iPhone 17' cut to 46 px, Simulator, VM; Desktop gave way first | room 188: name, iOS, Simulator, VM; Open simulator and the menu |
| Android | room 272: name, Android, Emulator, VM; the model dropped | room 188: name, Android, VM. Emulator, of the same rank, did not fit, and VM, shorter, did |
| Linux desktop | room 272: name, Linux, Desktop, LXC | room 188: name, Linux, LXC |

On the Boxes page at 1,440 px every row showed its model and all its
badges, room 754 to 784. At 360 px it showed the same as the panel.

## F-22c and F-22d: the device badge first on a narrow row

Built on 29 October 2026, from F-22b's live check, where an android row at
360 px showed VM rather than Emulator.

- **F-22c ranks a row's badges** the device's word, Simulator or Emulator,
  first, then Shared, then the box's form and BB machine, then Desktop,
  then the rest.
- **F-22d lets the system word give way** on a box with a device, before
  Simulator or Emulator, which say it already. A row with room for both
  keeps it.

After F-22c's deploy (main 0795f88), at 360 px in the owner's browser, an
android row still read 'vivid-badger Android [VM]'. The browser measured a
first line of 188 px: the name 80 px and Android 45 px, with their gap,
left 55 px, and Emulator needs 56 px and its gap. So ranking alone could
not show Emulator beside a name of that length, and F-22d followed.

After F-22d's deploy (main 80b4b79), at 360 px, the same row read
'vivid-badger [Emulator] [VM]', with 188 px for its first line.

## F-14: a test's teardown that failed with ENOTEMPTY

Built on 29 October 2026. `tart-ios-hosts.test.ts` failed on CI at times,
twice on 29 October: the Tart backend's dispose ended with "ENOTEMPTY,
Directory not empty: '/tmp/bb-box-cm-...'", from `KeyFile.dispose`, as it
removed the folder of SSH's shared-connection sockets.

### The cause

The test that failed ends while a shared host's VM is still starting. As
bb-box stops, that start is aborted, and it still sends one SSH command,
on purpose: a note on the Mac that it left the start, so the next bb-box
instance carries it on at once (F-7). The Tart backend's dispose dropped
its `Ssh` before that, so the note, or any command in that window, made a
new `Ssh` on the same folders, never disposed, whose shared connection
put a socket in the folder being removed. On CI, the socket came between
the removal's reading the folder and its removing it. Logged through the
fake `ssh` in the test, on the code before this change, a shared
connection opened during or after the dispose in each of 4 runs, and
once, in 562 runs of that test alone, the new `Ssh`'s own folders were
left behind.

### The fix

- **The Tart backend lets the starts it stops leave their note first,**
  for at most 15 s, then disposes its `Ssh` and keeps it, so a later
  command uses it rather than making another.
- **A disposed `Ssh` opens no shared connection;** a later command dials
  alone.
- **A disposed `KeyFile` writes no key, known hosts or folder again.**
- **The removal tries again** on ENOTEMPTY and the like, up to 10 times,
  50 ms apart and longer each time, as a socket that was opening as the
  removal began can still come.

A first version stopped the Tart backend making any SSH connection once
it was stopping. That lost the note, so the next instance waited 2
minutes for the start's last sign of life, and F-7's test failed.

### Checks

| Check | Before | After |
| --- | --- | --- |
| A new test: bb-box stops while a shared host starts; each shared connection opened as it stopped is closed before its folder goes | failed in 4 of 5 runs | passed in 5 of 5 |
| F-7's test, a start that one instance leaves and the next carries on | passed | passed in 5 of 5 |
| `tart-ios-hosts.test.ts` whole, on a Linux box, 3 at a time | 30 of 30 passed | 30 of 30 passed |
| `KeyFile.dispose` with sockets still coming into the folder, 3,000 files written as it removes | failed, 3 of 3 | passed, 3 of 3 |
| A disposed `Ssh` asked for a command | opened a shared connection | dialed alone |

The whole file did not fail before the change on this box either, in 30
runs and in 562 runs of the failing test alone but for the one above, so
the new test is what shows the race.

## F-23: the keyboard's first-use tip on a slot's device

Built on 29 October 2026, from F-21's follow-up. On a new shared slot's
device, the first keyboard showed iOS's tip "Speed up your typing by
sliding your finger across the letters", with a Continue button, and keys
typed before a paste went to it.

The image's own devices never had it: `build-ios.sh` writes each device's
keyboard defaults, and `DidShowContinuousPathIntroduction` among them, and
`bb-box-check-ios` checks them. A slot's device is made fresh by
`device-host`, in the slot's own user, so it had none of them: the tip,
and autocorrect, smart punctuation and predictions on too.

- **A slot's first boot writes them.** `device-host` writes the image
  devices' seven keyboard defaults with `simctl spawn ... defaults write`,
  as the slot's user, while the device is booted for the first time, and
  keeps a `keyboard-defaults` file in the slot's folder once all are
  written. A write is tried 5 times, 2 s apart; if one still fails, the
  slot is not made, as for any first-boot failure. This covers slots on
  Tart hosts, Namespace hosts and the pool's Mac, which all make devices
  through `device-host`. `mac-ios.sh` needs no change: its own devices are
  the seed's and the clipboard check's, made and deleted there.
- **A carried slot made before this gets them at its warm-up,** which
  boots its device before a claim. A write that fails there is left for
  the next warm-up, and the claim goes on.
- **The image's check covers a carried slot's device.** The new line
  `slot keyboard` boots `bbd-i1`'s device, reads its keyboard defaults as
  `bbd-i1` with the image devices' own check, and shuts it down again.
- `device-host` is version 6.

Tests: a slot's first boot writes the seven defaults on its device, once;
a carried slot without them gets them at its warm-up; the image's check
runs the new line as the slot's user.

Not checked here: a live slot. Tart and Namespace hosts get the new
`device-host` as each host starts, so the check is a new shared slot after
the deploy: `computer_type` into Safari's address field right after the
device's first keyboard opens. The pool's Mac gets it when `setup-mac.sh`
runs again. The image needs no rebuild: its carried slots get the defaults
at their next warm-up. The next image build writes them as it makes the
carried slots, and its `slot keyboard` line checks them there.

## F-18: Chrome on an Android device takes a paste

Built on 29 October 2026, from F-15's finding that Chrome on the Android
device took no paste at all from its first start, where unit 5.1 had
found 4.

### The cause

Chrome's pages paste nothing for the Paste key or Ctrl+V. Checked on an
android box's Pixel 8 (Android 15, API 35, Chrome 124.0.6367.219), on a
test page that logs each paste event's text:

- `computer_type` of `ab ✓ 日本`, and of `✓1` to `✓5`: each paste event
  carried no text, and nothing was pasted. Android logged no "Chrome
  pasted from your clipboard", so Chrome did not read the clipboard at
  all.
- The text copied in Chrome itself, by Ctrl+A and Ctrl+C, then Ctrl+V:
  nothing pasted, and the selection was replaced by nothing.
- Chrome's own Paste menu, by a long press on the field: pasted the
  copied text at once, and so did Android's accessibility paste on the
  field (`ACTION_PASTE`), with the clipboard set by the emulator. Each
  logged "Chrome pasted from your clipboard".

So Chrome's key path uses a clipboard it does not read again, whoever
set the clipboard; its menu and accessibility paths read it. The clipboard
being put back 300 ms after the key (E21) is not the cause: Chrome never
asked. Why Chrome's key path holds a stale clipboard on the emulator is
not known.

### The fix

- **A paste goes as Android's accessibility paste.** The device server's
  Android driver asks bb-box's tree server, which holds UiAutomation, to
  paste. It finds the focused text field, in the input focus first and in
  the active window otherwise, and performs `ACTION_PASTE` on it. Where no
  text field has the focus, or the tree server cannot run, as during an
  instrumentation test, the Paste key goes as before, and the server's log
  says why.
- **Keys typed before the paste land first.** An accessibility paste goes
  straight to the app, so it overtook keys still on their way: `a✓b日本c`
  arrived as `a✓日本bc`, and with a 150 ms wait for quiet first, `naïve`
  still arrived as `ïnave`. The tree server now injects a Shift press and
  release through UiAutomation, and waits for Android to finish them,
  which is after the keys before them; then 100 ms of quiet, at most
  1.5 s. A page sees that Shift key.
- **Reads after a paste stay fresh.** After an accessibility paste, the
  tree server's own reads of Chrome's page stopped changing until it let
  UiAutomation go, 30 s later. It clears its node cache after each paste.
- The tree server is version 2, the device server version 33.
- `computer_type`'s description says that ctrl+v pastes nothing in Chrome
  on Android, and to send the text instead.

### Checked before the deploy

The new tree server and driver were put in the android box's own device
server folder, and the server started again by systemd, so it ran as
production runs it. Each check was the agent's `computer_type` through
production BB, into the test page in Chrome, started afresh first, and
test values only:

| Check | Version 32 | This change |
| --- | --- | --- |
| A text with a paste into the page, Chrome just started | `ab ✓ 日本` arrived as `ab `, and `✓1` to `✓5` as their digits only | `bbtest ✓ 日本 é` whole |
| 13 mixed texts in 3 calls, 18 pastes among keys: `naïve`, `naïve café ✓`, `a✓b日本c`, `Grüße, 世界 — ok`, `x→y ∑ 🙂 z`, `ab ✓`, `q✓w✓e✓r`, `bbtest ✓ 日本 é`, `né`, `ña`, `üb`, `日本語のテキスト`, `z✓` | | 13 of 13 whole and in order |
| `bbtest ✓ 日本 é` into Chrome's address bar, a native field | | whole |

`computer_type`'s read of the field after each call gave the field's
text.

Not checked here: the panel's Paste and Cmd+V on an android box, which go
through the same paste as the agent's text; an app's own text field other
than Chrome's address bar; and how much longer a paste takes, which is at
least the 100 ms of quiet.

## F-16: the paste RPC's automatic flag, and the paste field's words on a device

Built on 29 October 2026.

- **No automatic flag.** F-15 had the `desktopPaste` RPC refuse a send
  marked `automatic`, which only a panel tab opened before F-15's deploy
  made. Those tabs are long gone, and the panel sends no such flag, so the
  flag is gone: the RPC takes the viewer's text and answers null, or
  refuses in words.
- **The paste field says what a device does.** Where the browser will not
  let the panel read the clipboard, Paste from this computer opens a field
  to paste into. On a device it said the text "goes to the box's
  clipboard". It now says: "This computer's clipboard cannot be read here.
  Paste the text below: it is pasted where the cursor is, and the
  device's own clipboard is put back after." Its button says Paste into
  the device. A desktop's words are as before.

Tests: the desktop paste test without the flag; on a device, the field
shows the device's words, and its button sends one `paste` request with
the field's text.

## F-14, F-23, F-18 and F-16: checked after the deploy

On production BB at main ccdc82c, device server version 33, `device-host`
version 6, on 29 October 2026, with test values only.

| Box | Check | Result |
| --- | --- | --- |
| Shared slot on a Tart host made for the box: carried slot `bbd-i1` | its device's keyboard defaults, read with `simctl spawn ... defaults read` | none written: `DidShowContinuousPathIntroduction` and the rest missing |
| | `computer_type` of `bbtest first keyboard ✓ 日本 é` into Safari's address field, the device's first keyboard | arrived as `✓ 日本 é`: the slide to type tip showed, with Continue, and took the keys before the paste |
| | the same slot's device shut down, the seven defaults written into its own preference files with `plutil` as the slot's user, booted again, the same `computer_type` | whole, with no tip |
| | a device made for the check, the same writes while shut down, then booted | each default read back on the device as written |
| android box, Pixel 8, Chrome 124, Chrome's first start | 7 mixed texts by `computer_type` into a test page, among them `naïve café`, `a✓b日本c`, `x→y ∑ 🙂 z` and `q✓w✓e✓r`, 13 pastes | all whole and in order; 13 paste events, and 13 "Chrome pasted from your clipboard" |
| | the panel's Paste from this computer, in Helium, in a tab of its own whose `navigator.clipboard` was a stub holding a test value | one read of the stub; "Pasted"; the page got `bbtest panel paste ✓ 日本 é` whole; Copy to this computer then said the device's clipboard had no text, as before the paste |

### F-23b: a carried slot claimed at once

The live check found what F-23 missed. On a host made for the box, the
first box takes carried slot `i1` at once. Its claim loads the slot's
daemons and the device server boots the device, so `device-host` never
boots it and never wrote the defaults. Only `i2`, warmed after, got
them. So a new host's first box still met the tip.

- **A claim writes them too.** Through the device when it is booted, as
  before; and when it is shut down, as a carried slot's is until a box or
  a warm-up boots it, into the device's own preference files, with
  `plutil -replace`, as the slot's user, before its device server boots
  it. The live check above shows that a device booted after such writes
  reads them, and shows no tip.
- `device-host` is version 7.

Tests: a carried slot whose defaults are gone is claimed with its device
shut down; the seven defaults are in its device's files, and none went
through the device. Without the change, that test fails.

Not checked live: F-23b itself, which needs its deploy. The check is the
same: a new shared slot on a Tart host made for the box, `computer_type`
right after the first keyboard opens.

### F-23b checked after the deploy

On production BB at main 7431ca8, `device-host` version 7, on 29 October
2026, on a new shared slot, carried slot `bbd-i1`, on a Tart host made
for the box, with test values only:

| Check | Result |
| --- | --- |
| the device's keyboard defaults, read with `simctl spawn ... defaults read` | written: `DidShowContinuousPathIntroduction` 1, autocorrect and slide to type 0 |
| `computer_type` into Safari's address field, the device's first keyboard, and again after the field was closed | no slide to type tip either time |
| `computer_type` of ` bbtest again ✓ 日本 é` into the field once open | whole |

### Follow-up

- **Keys typed as Safari's address field opens are lost or out of
  order.** With the tip gone, `bbtest first keyboard ✓ 日本 é` still
  arrived as `✓ 日本 é` on the first opening, and `bbtest second open ✓ 日本 é`
  as `✓ 日本 éd open` on the second: the keys that went while the field
  moved up and its keyboard came in were lost, and some came after the
  paste. Text typed into the field once open arrived whole, as in F-21's
  runs. `computer_type` could wait for the field to be focused and its
  keyboard shown before the first key.

## F-25: keys typed as a field opens

Built on 29 October 2026, from F-23b's follow-up. `computer_type` into
Safari's closed address field lost the keys before a paste, or put some
after it: `bbtest first keyboard ✓ 日本 é` arrived as `✓ 日本 é`, and
`bbtest second open ✓ 日本 é` as `✓ 日本 éd open`, on a shared slot,
through production.

### The cause

`computer_type` taps the field, waits for the screen to be still for
150 ms, at most 1 s, and types. Safari's address field moves up as it
opens, and a new focused field and its keyboard come in. Read on a new
shared slot, by taps sent straight to the device server and its tree
read as fast as it answered, 3 times: the tap was answered in 61 ms, and
the focused field and its keyboard's keys showed 333, 335 and 414 ms
after it. A screen still for 150 ms can end the wait before that, and
the keys sent then are lost.

### The fix

- **After the tap that focuses a field, the first key waits** until the
  device's elements show a field with the focus and a keyboard, read
  every 250 ms for at most 5 s, then for the screen to settle.
- **A keyboard can be seen on both platforms.** iOS's tree names a key
  with iOS's `KeyboardKey` trait a `keyboard key`; Android's has its
  keyboard's window as a `keyboard`. Device server version 34.
- **If none comes,** the text goes anyway, and the answer says: "No text
  field had the focus with its keyboard shown within 5 s of the tap, so
  bb-box typed anyway, and the first keys may be lost: check what the
  field reads."
- The panel's Type text is the person's own input: it types into the
  field the person has opened and sees, so it is unchanged.
- `computer_type`'s description says it waits.

Tests: after a tap that opens a field, the text goes only once the field
and its keyboard show, on iOS and Android; with no keyboard, the text
goes after the whole wait, with the words.

### Checked before the deploy

`DeviceComputer`, the code `computer_type` runs, was run on each box over
the device server's own socket, with the device server's new tree put in
its own folder and started again. Each run tapped Safari's closed address
field, or Chrome's on Android, and typed a text with a paste, then closed
the field. Test values only.

| Box | Before, through production | This change |
| --- | --- | --- |
| Shared slot on a Tart host made for the box, iPhone 18 Pro | lost the keys before the paste, 2 of 2 (F-23b's check) | `bbtest one`, `two` and `three ✓ 日本 é`: 3 of 3 whole and in order |
| Dedicated Tart box, iPhone 18 Pro | 1 of 1 whole | 3 of 3 whole and in order |
| Dedicated box, with the device server's old tree, which shows no keyboard | | 3 of 3 whole, each after the 5 s wait, with the words |
| android box, Pixel 8, Chrome's address bar | 3 of 3 whole: Android gives the field the focus at once | 3 of 3 whole, no wait words |

Main's code also took 3 of 3 whole through the same harness on the
shared slot, so the loss depends on timing, as the read above shows.

### Checked after the deploy

On production BB at main a35f023, device server version 34, on 29
October 2026, on a new shared slot on a Tart host made for the box,
through production's `computer_type`, with test values only: `bbtest one`,
`two` and `three ✓ 日本 é` into Safari's closed address field, closed
again with its Close button between them, arrived 3 of 3 whole and in
order, with no words that the keyboard did not come. The keyboard's keys
read as `keyboard key` in `computer_observe`.
