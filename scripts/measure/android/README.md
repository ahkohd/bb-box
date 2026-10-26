# Measuring what an Android device costs

The harness behind [063's results](../../../docs/decisions/063-results.md):
how fast each Android model draws on the CPU, what `bb-box-h264` costs to
encode it, how frames reach the encoder, and how the picture holds up at
8 Mbit/s. It runs in a Linux box with KVM, beside the emulator.

| File | What it is |
| --- | --- |
| `bench.ts stream` | Reads the emulator's gRPC `streamScreenshot`, by its bytes (`--mode pipe`) or by shared memory (`--mode mmap`), and feeds `bb-box-h264` through `src/device/h264-encoder.ts`. Each window gives frames received and encoded a second, Mbit/s, the cores of the emulator, the helper and Node, encode ms and the emulator's resident memory. `--busy` scrolls the launcher's app list with `adb shell input swipe`, as the research did. `--no-encode` only counts frames. `--record` keeps raw frames for `picture.sh` |
| `bench.ts tear` | Two streams at once, one by shared memory and one by bytes: whether a frame read from shared memory is ever one the emulator never sent whole, with the read held back `--window` ms |
| `bench.ts replay` | Plays a recording through one encoder at its own pace, and writes the H.264 |
| `bench.ts snap` | Saves one raw frame, to check its size and orientation |
| `picture.sh` | Replays a recording through x264 and OpenH264 at the recording's frame rate, and compares each decoded video with the frames as SSIM and PSNR, with ffmpeg |

## Doing a run

1. On a Linux box with KVM, install the SDK and make the AVDs as the
   [Android research](../../../docs/research/android-emulator-boxes.md#rerunning-the-measurements)
   does, with `install-sdk.sh` and `avdmanager`.
2. Build the helper with both encoders:
   `setup/android/build-h264.sh ~/h264-x264 --with-x264`.
3. Boot a model with the research's `boot.sh <avd> cold`, then keep it
   awake: `adb shell svc power stayon true`.
4. Pin the emulator to the cores a box would have, and run the stream
   pinned to the same cores, so the emulator, the helper and Node share
   them as in a box of that size:

   ```sh
   taskset -a -p -c 0-7 "$(pgrep -f 'qemu-system-x86_64.*-port 5554')"
   taskset -c 0-7 node scripts/measure/android/bench.ts stream --mode mmap --busy --seconds 30
   ```

5. For the picture, record about 30 busy frames by bytes, then compare:
   `bench.ts stream --mode pipe --busy --seconds 8 --record rec.bin --record-frames 150`,
   then `picture.sh rec.bin <label>`.

CPU is from `/proc/<pid>/stat` over each window, as a share of one core:
the emulator's whole process tree, the helper, and Node's own
`process.cpuUsage()`. Memory is the emulator tree's resident set.

## The device server's driver

`device.ts` measures unit 4.1's Android driver
([063 results](../../../docs/decisions/063-results.md#unit-41-the-android-driver)):
the device server in the box, as bb-box delivers it, with its viewer on the
server's socket through `bb-box-device connect`. It runs as the box user,
with this checkout copied into the box, in a box with the Android
template's layer, or a box of the template itself.

| Step | What it does |
| --- | --- |
| `device.ts deliver` | Delivers the device server from this checkout as bb-box does, with the devices of the image's record, or of `/usr/share/bb-box/android-devices.json` where the box has the layer but no record. `--device` names a first model |
| `device.ts stream` | Connects as a viewer, times its hello and its first frame, then counts frames, key frames, Mbit/s and the gaps between frames in windows of `--window` seconds for `--seconds`, with the cores and resident memory of the server, `bb-box-h264` and the emulator's process tree. `--busy` scrolls with `adb shell input swipe`, as unit 2.4 did |
| `device.ts keyframes` | Asks for a key frame `--times` times, 0.5 s apart, and times each to its arrival; `--busy` as above |
| `device.ts kill-encoder` | Kills `bb-box-h264` while a viewer watches, and times the stall to the next key frame |
| `device.ts kill-emulator` | Kills the emulator, and times the stall to the next key frame, or reports the state the server left the device in |
| `device.ts kill-server` | Kills the device server, and times its hello and a key frame after it is back, and whether the emulator was kept |
| `device.ts switch --device <model>` | Switches the box's device through a control connection, and times it to the answer |
| `device.ts reboot` | Reboots the device through a control connection, and times it |
| `device.ts screenshot` | Asks for the agent's screenshot `--times` times; `--out` keeps the last |
| `device.ts clock` | The box's clock and the device's, and how far apart |
| `device.ts memory` | The resident memory of the emulator, the server and the encoder, and what Android says it uses |
| `device.ts state` | The device's state, from a viewer's hello |
| `device.ts watch --seconds <s>` | Logs each second's frames and key frames, and each state, connecting again when the server goes, for a stop and start of the box |

CPU and memory are read from `/proc` as for `bench.ts`. Frames are counted
as the viewer receives them, so on a still screen there are none.

## Input and controls

Units 5.1 and 6.2 on Android
([063 results](../../../docs/decisions/063-results.md#units-51-and-62-on-android-input-and-controls))
use these, in a box with the template's devices and this checkout:

| File | What it does |
| --- | --- |
| `page.ts` | Serves `probe.html` on port 8765 and appends what the page logs to `/tmp/android-page.log`. Open it in the device's Chrome as `http://10.0.2.2:8765/`. `/clear` empties its field and list, and `/fetch?kib=<n>&after=<s>` has the page fetch `n` KiB from the box `s` seconds later and log how long it took, or why it failed |
| `probe.html` | A pad that turns black or white at each touch, a text field and a long list. It logs each touch with its point, each pinch's scale, each key, the field's value and the list's scroll |
| `controls.ts` | As the iOS `controls.ts`: box_device's parameters through `controlFromParameters` and the plugin's own `DeviceServers`, `twice`, `lost`, `read-back` (each Android read, 10 times), `watch`, `tap`, `input` and `shot`, which keeps `adb exec-out screencap` |

The panel's own client and relay come from the iOS harness, which takes the
platform from the environment: run `KIND=android node
scripts/measure/ios/viewer.ts` in the background, and drive it with
`CHROME=/usr/bin/google-chrome DEVICE_SCALE=1
PAGE="http://127.0.0.1:8770/device.html?model=Pixel%208&guest=linux" node
scripts/measure/ios/drive.ts owner:person e14:540:800:100:600:idle`, where
points are the video's pixels. `PROBE_DX` and `PROBE_DY` move the pixel
`e14` watches from the tap, 30 by default.

## Computer use

Units 7.2 and 7.3
([063 results](../../../docs/decisions/063-results.md#units-72-and-73-computer-use-on-an-android-device))
use `computer.ts`, as the iOS one, in a box with the template's devices and
this checkout: `node scripts/measure/android/computer.ts <steps.json>`. It
runs the plugin's own `DeviceServers` and `DeviceComputer`, and writes a
line of JSON a step with its time and what the agent would read.

| Option or step | What it does |
| --- | --- |
| `--tree dump`, `--tree server` | Stops the box's device server and runs one in this process, reading the tree only by `uiautomator dump`, or by bb-box's tree server with the dump when the server cannot run. Without it, the box's own server, delivered from this checkout |
| `--person` | Starts with a person holding control |
| `windows`, `observe`, `screenshot`, `act`, `type`, `launch`, `take_control` | The computer tools. `ref` is a reference, or `/pattern/` for the first line of the last tree that matches, or the `nth` |
| `control`, `person`, `wait` | A `box_device` control, a person taking or handing back control, a pause |
| `reads` | Reads the tree `times` times, `gapMs` apart, and gives each read's milliseconds |
| `watch` | Reads the tree every `gapMs` for `seconds`, with each read's time, its elements and why it was refused |
| `shell` | Runs a command in the box; with `background`, leaves it running and writes its output to `out` |

`check.json` is 063's live check, and `e12.json` is E12: tree times on
Settings and Chrome, an instrumentation test that uses UiAutomation and one
that does not run beside the reads, and the tree server killed. E12 needs
the probe app in `probe-app`, with two instrumentations,
`bbbox.probe/.Holds` and `bbbox.probe/.Plain`: the first calls
`getUiAutomation()` and reads the screen for `-e seconds`, the second only
waits. Build and install it in the box with
`setup/android/build-tree-server.sh --install-tools`, for the tools, then
`scripts/measure/android/probe-app/build.sh` and
`adb install -r scripts/measure/android/probe-app/out/probe.apk`.
