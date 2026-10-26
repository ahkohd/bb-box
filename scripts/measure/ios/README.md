# Measuring an iOS device's stream

The harness behind [063's results](../../../docs/decisions/063-results.md#unit-42-the-ios-driver)
for unit 4.2: the iOS driver's stream, key frames, recovery and slimming,
measured in a Mac box made as the iOS image is, beside the device server.
It runs as the box user, with this checkout copied into the box.

| Step | What it does |
| --- | --- |
| `bench.ts deliver` | Delivers the device server from this checkout as bb-box does, with the devices of the image's record, `/usr/local/share/bb-box/image.json`. `--no-slim` delivers the box's choice of slim off; `--device` a first model |
| `bench.ts stream` | Connects as a viewer through `bb-box-device connect`, times the first frame, then counts frames, key frames and Mbit/s in windows of `--window` seconds for `--seconds`, with the cores and resident memory of the server and idb_companion. `--url` opens a page in Safari first |
| `bench.ts keyframes` | Asks for a key frame `--times` times, 0.5 s apart, and times each to its arrival |
| `bench.ts kill-companion` | Kills idb_companion while a viewer watches, and times the stall to the next key frame |
| `bench.ts kill-server` | Kills the device server, and times its hello and a key frame after it is back |
| `bench.ts switch --device <model>` | Switches the box's device through a control connection, and times it to the answer |
| `bench.ts tap` | Taps the screen's middle through idb's HID stream `--times` times, and times each to the next frame |
| `bench.ts state` | Prints the device's state from a viewer's hello |

## Doing a run

1. In a macos-desktop Tart box, run the iOS image's layer as the
   [iOS image's guide](../../../setup/tart/ios/README.md) describes:
   `setup/tart/ios/build-ios.sh` with the variables of `setup/tart/ios/pins`,
   then write the record with `record-ios.py`, as `prepare-ios-image.sh` does.
2. Serve a page to look at, still or busy, from the iOS research's
   `docs/research/ios-simulator-boxes/page.html`:
   `python3 -m http.server 8765 --bind 127.0.0.1`.
3. `node scripts/measure/ios/bench.ts deliver`, then the steps above, such as
   `node scripts/measure/ios/bench.ts stream --seconds 15 --url "http://127.0.0.1:8765/page.html?busy"`.

CPU is each process's CPU time from `ps` over each window, as a share of
one core. Memory is the processes' resident set at the window's end. Frames
are counted as the viewer receives them, so on a still screen there are
none, as idb sends a frame only when the screen changes.
