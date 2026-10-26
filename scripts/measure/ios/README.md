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

Input, as the panel sends it (units 5.1 and 5.2), with three more files:

| File | What it does |
| --- | --- |
| `viewer.ts` | Runs the plugin's own relay for device viewers beside the device server, without BB's server: pages on port 8770, viewers' WebSockets on 8771. It takes the box's lease, as bb-box does, and stands in for the plugin: `/api/owner?holder=person` or `agent` sets control's owner, and `/api/input` sends the agent's input, a `DeviceInput` as JSON |
| `device.html` | The panel's own video client on a device display, logging each frame it draws, with a pixel's shade where `window.probe` points |
| `drive.ts` | Drives `device.html` in headless Chrome through its DevTools protocol, one step an argument: `owner:person`, `tap:x:y`, `press`, `move` and `release`, `drag:x1:y1:x2:y2:ms[:alt]`, `wheel:x:y:delta:count:ms`, `ime:reading:committed`, `insert:text`, `type:text`, `typetext:text`, `agent:<json>`, `e14:x:y:taps:gapMs:label`, `wait:ms` and `eval:js`. Points are the device's, upright or as drawn |

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
4. For input, build the panel's client into `scripts/measure/web/client.js`
   as the [desktop harness](../README.md) does, start
   `node scripts/measure/ios/viewer.ts` in the background, open a page in
   the device that turns black or white at each touch, and run, for E14,
   `node scripts/measure/ios/drive.ts owner:person e14:300:500:100:600:idle`.
   It writes `/tmp/e14-<label>.json` and prints the median, the 95th
   percentile and the worst. Stop `viewer.ts` when done, so bb-box takes the
   box's lease back.

CPU is each process's CPU time from `ps` over each window, as a share of
one core. Memory is the processes' resident set at the window's end. Frames
are counted as the viewer receives them, so on a still screen there are
none, as idb sends a frame only when the screen changes.
