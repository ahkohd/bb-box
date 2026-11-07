# 072 unit V1: the live check and the measurements

What [072 results](../../072-results.md) ran, on a Linux box with Docker,
16 cores and 32 GiB, with nothing else running on it during the
measurements.

| File | What it does |
| --- | --- |
| `live-setup.sh` | A fresh `npx bb-app` with no account, bb-box installed from a checkout at `~/work/plugin`, the Docker backend with the desktop image built by `setup/docker/build.sh desktop`, a project, a thread and a tool-calling ACP agent (`acp-agent.mjs`, from 069 unit 1b), whose calls `agent-call.sh` makes |
| `live-check.mjs` | Drives the panel's desktop view in headless Chromium: the stream it opens, the Display menu, taking control, the pointer and typing, the clipboard both ways, a resize, the wheel and handing back, each seen in the box |
| `shots.mjs` | The viewer at 1440, 760 and 390 px, light and dark, with and without its Display menu open, and the Docker backend's settings |
| `scene.html` | The desktop's workload, in Chrome in kiosk mode: a long page of text scrolling 10 px a frame, a full-screen 1080p animation of 40 circles over a changing background, or a still page. Every frame draws the time, `Date.now()` modulo 2^24 ms, as 24 black and white blocks at its top left, with their inverse under them |
| `web/viewer.html` | The viewer: the panel's own video client for voxl and Selkies, and noVNC as the panel sets it, bundled from `scripts/measure/entry.ts` into `web/client.js` and reached through BB's server by `scripts/measure/proxy.mjs`. For each frame it draws, it reads the marker and the time |
| `shaped-proxy.mjs` | The slow link, between the viewer and that proxy: 10 Mbit/s towards the viewer with a deep queue, and 20 ms each way (`RATE_MBIT`, `RTT_MS`) |
| `measure.mjs` | One run: starts the scene, watches it for 4 s, then measures for 20 s. Frames a second are frames with a new marker; latency is the viewer's time less the marker's, from the content drawn to the frame drawn in the viewer; bandwidth is the bytes the viewer's WebSocket received; CPU is each process's ticks in the desktop's container, from `/proc`, over the same 20 s |
| `batch.sh` | The first batch: voxl and Selkies, on LAN only |
| `batch-matrix.sh` | The results: 3 runs of voxl, Selkies and noVNC, taking turns, for each workload, on LAN and the slow link, then each idle |
| `tables.mjs` | The results' tables, from the runs in `measure/` |
| `measure/`, `live-check.json`, `shots/` | What the runs, the live check and `shots.mjs` gave |

The scene and the viewer run on the same box, so both read the same clock.

To run them, as `box` on the box, after building the desktop image:

```sh
sh ~/work/plugin/docs/decisions/072-voxl/v1/live-setup.sh
. ~/live-results/env.sh
~/agent-call.sh "$LIVE_THREAD" box_acquire '{"kind":"linux-desktop-cpu"}'
```

Then set `BOX` and `CONTAINER` in `~/live-results/env.sh`, copy `scene.html`
to `/tmp` in the desktop's container, start the proxy from this folder with
a file holding BB's address, and `shaped-proxy.mjs 7001 7000`, then run
`batch-matrix.sh`, `live-check.mjs` and `shots.mjs` with Playwright
installed, and `tables.mjs`.
