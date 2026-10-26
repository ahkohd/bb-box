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
| `bench.ts rotate --to <orientation>` | Turns the device with idb's HID orientation event, then prints, for `--seconds`, each frame with the geometry generation in its header, each state the server sends and each change idb's orientation reads. `--out` keeps idb's own screenshot |
| `bench.ts screenshot` | Asks the device server for the agent's screenshot `--times` times, and prints each time, its size and generation, and the geometry. `--out` keeps the last |

Input, as the panel sends it (units 5.1 and 5.2), with three more files:

| File | What it does |
| --- | --- |
| `viewer.ts` | Runs the plugin's own relay for device viewers beside the device server, without BB's server: pages on port 8770, viewers' WebSockets on 8771. It takes the box's lease, as bb-box does, and stands in for the plugin: `/api/owner?holder=person` or `agent` sets control's owner, `/api/input` sends the agent's input, a `DeviceInput` as JSON, and `/api/control` a `DeviceControl`, such as a switch. It takes the lease again if the server restarts |
| `device.html` | The panel's own video client on a device display, in its frame, logging each frame it draws, with a pixel's shade where `window.probe` points. `?theme=light` or `dark` loads BB's theme; `frame=0` and `pfp=1` set Show frame and Pixel for pixel |
| `touch.html` | A page for the device's Safari that puts a red dot where each touch lands |
| `frames.html` | Every model's frame from the table, with a test card and no device: `?model=`, `physical`, `content`, `posture`, `theme`, `frame` and `power`. `change({posture})` changes it as a device would, and `foldTimes(posture, pictureAfterMs)` times a fold's frames |
| `drive.ts` | Drives `device.html` in headless Chrome through its DevTools protocol, one step an argument: `owner:person`, `tap:x:y`, `press`, `move` and `release`, `drag:x1:y1:x2:y2:ms[:alt]`, `wheel:x:y:delta:count:ms`, `ime:reading:committed`, `insert:text`, `type:text`, `typetext:text`, `agent:<json>`, `e14:x:y:taps:gapMs:label`, `wait:ms` and `eval:js`. Points are the device's, upright or as drawn. For the frame: `shot:<file>`, `theme:dark` or `light`, `view:frame` or `noframe` with `:pfp`, `size:w:h:scale`; `turn:<orientation>:<ms>:<label>` turns the device with idb and logs the frame's angle, the veil and the picture on each animation frame; `landing:x:y` taps a video pixel where it is drawn and says whether `touch.html`'s dot appeared there; `freehid` restarts the device server, so idb's HID stream is free for `turn` and `idbturn`. `PAGE` names another page, such as `frames.html` |

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

While the device server holds idb's HID stream, as it does once a person has
taken control, idb answers no other client's HID event until that stream
closes: `drive.ts freehid` restarts the server first. bb-box itself sends
every HID event through its own stream.

## Controls

`controls.ts` checks `box_device` on the device (unit 6.3). It runs the
plugin's own `DeviceServers` against the box's device server, as bb-box
does, and prints for each control what the agent reads: the answer's words,
the server's time and the round trip, and the settings read back.

| Step | What it does |
| --- | --- |
| `controls.ts control '<parameters>'` | Sends box_device's parameters as JSON, such as `'{"action":"rotate","turn":"left"}'`, through `controlFromParameters` and `DeviceServers.control`. `--shot <name>` takes a screenshot with `simctl io` after it, into `/tmp/bb-box-controls`; `--person` says a person has control |
| `controls.ts twice '<parameters>'` | Sends one control twice with the same ID, then asks for its result, and prints whether the device changed once |
| `controls.ts lost '<parameters>' --times <ms>` | Ends the plugin's connection that many milliseconds after sending, so the plugin asks for the answer again by its ID |
| `controls.ts read-back --times <n>` | Times each read-back command `n` times: appearance, content size, the status bar's overrides and the lock state |
| `controls.ts watch '<command>' --times <s>` | Watches as a viewer, runs a command in the box a second in, and prints each state the server sends for `s` seconds |
| `controls.ts native <name>` | Takes the agent's screenshot through the device server: since version 9, idb's own pixels turned as the video shows them |
| `controls.ts tap <x> <y>` and `input '<DeviceInput>'` | Sends the agent's input, as the computer tools will |
| `controls.ts shot <name>` | Takes a screenshot with `simctl io` |

`simctl io` screenshots are turned with the app on screen, as the stream
is. idb's are not, so `native` shows which way the device itself turned.

## The panel

`panel/` shows the panel's own device viewer, with its toolbar, picker and
menus, against `viewer.ts`, which answers the few calls the viewer makes of
the plugin: `desktop`, `takeControl`, `handBack` and `deviceScreenshot`.
It runs on a Linux box too, with the test device: a `devices.json` of the
test offer in `~/.bb-box/device`, and `node src/device/main.ts serve`.

1. Fetch BB's theme beside it, without its `@source` line, as
   `panel/theme.css`: `apps/web/src/components/ui/theme.css` of BB's
   repository, as `device.html` does.
2. Build the page's script and styles:
   `npx esbuild scripts/measure/ios/panel/entry.tsx --bundle --format=esm --outfile=scripts/measure/ios/panel/panel.js --tsconfig=tsconfig.json --alias:@get-bb/plugin-sdk/app=./scripts/measure/ios/panel/sdk.tsx --jsx=automatic --define:process.env.NODE_ENV='"production"'`,
   then `npx @tailwindcss/cli@4 -i scripts/measure/ios/panel/panel.css -o scripts/measure/ios/panel/out.css`.
3. Start `viewer.ts`, then drive `http://127.0.0.1:8770/panel/page.html`
   with `panel/check.ts`, one step an argument: `open:<theme>,<width>,<height>[,<zoom>[,touch]]`,
   `click:<name>` and `tap:<name>` by accessible name, `key:<key>`,
   `focus:<name>`, `type:<text>`, `shot:<name>`, `ax:<name>` for the
   accessibility tree of the toolbar and any menu or dialog, `focused`,
   `toasts`, `agent:<DeviceControl JSON>` for the agent's control, which a
   person's control refuses, `api:owner?holder=agent`, `wait:<ms>`,
   `eval:<js>` and `quit`. `CHROME` names the browser; `OUT` the files'
   prefix.
