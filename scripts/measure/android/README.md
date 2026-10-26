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
