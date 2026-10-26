# 063 results: what each Android device costs

The numbers unit 2.4 of [063](063-device-boxes.md) measured, so the
android kind's sizes, its encoder and the way frames reach the encoder come
from measurements: E17 (each model's cost), E6 (shared memory or a pipe)
and E7 (x264 or OpenH264). Unit 3.1's, for the Android template, are
[at the end](#unit-31-the-android-template): E2 (snapshots in another VM),
E13 (typing), E19 (the gRPC port) and E24 (disk).

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

