# Measuring a desktop's stream

The harness behind [060's results](../../docs/decisions/060-results.md):
how smooth and sharp a desktop is through BB's server, as the panel shows
it. It needs two boxes, the desktop and a Linux desktop box as the viewer.

| File | What it is |
| --- | --- |
| `scene.html` | The page the desktop shows full screen: a block to drag, a key square, fixed text, a list to scroll |
| `web/page.html` | The viewer: noVNC or the panel's video client, logging every frame it draws |
| `entry.ts` | Builds `web/client.js` from the panel's own clients |
| `proxy.mjs` | Serves `web` and passes `/bb` to BB's server |
| `drive.mjs` | Drives one run in headless Chrome and writes `raw-<label>.json` |
| `batch.sh` | Several runs with one viewer, so control is taken once |
| `analyse.mjs` | Sums up the runs, with the box's CPU per phase |
| `cpu.sh`, `cpu-mac.sh`, `cpu-win.ps1` | Log the desktop box's CPU on Linux, macOS and Windows |

## Doing a run

1. Build the viewer:
   `npx esbuild scripts/measure/entry.ts --bundle --format=esm --outfile=scripts/measure/web/client.js --tsconfig=tsconfig.json`
2. On the viewer box, start Chrome with `--remote-debugging-port=9222`, and
   `node proxy.mjs server-url.txt`, where the file holds BB's server URL.
   Do not commit it.
3. On the desktop box, open `scene.html` full screen in the box's browser
   in kiosk mode, so that it starts at the screen's top left. Take a
   lossless screenshot of the whole screen at its real pixels, and copy it
   to the viewer as `web/ref.png`. Start the CPU logger.
4. On the viewer, `VIEWER=<a new id> BOX=<box id> bash batch.sh <width>x<height> <scale> vnc:<label> video:<label>`.
   Give the box's display `refresh` and `quality` as `REFRESH` and
   `QUALITY` where it has them, as the panel does.
5. Once the viewer has written `connected`, give it control:
   `bb plugin rpc call bb-box takeControl --input-file <file>`, where the
   file holds `{"threadId", "box", "viewer"}`. Then `touch go`.
6. `CPU=<cpu log> node analyse.mjs <label>...`

The scene is 1200 by 800 CSS pixels. Where a screen is smaller in points,
as on a Tart Mac, set the browser's page zoom so that a CSS pixel is a
screen pixel, and give scale 1.
