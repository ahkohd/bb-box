# Recording the demo

The README and the documentation site's landing page open with a 46-second demo of a person and a thread's agent using bb-box in BB's web app. Record it again when the Box panel, the New box form or the desktop and terminal tabs change.

## The demo video

The video is recorded in a box, on a fresh BB with no account, so no deployment's machine, user, project or account name can show. Every name in it is one BB or bb-box makes: the box that runs the fresh BB, the boxes bb-box names, and the user `box`. The scripts are in [scripts/demo](../scripts/demo).

### What it shows

1. BB's home, where the person asks the thread's agent: 'Get a Linux desktop box and open getbb.app on it.'
2. The agent gets a Linux desktop box with `box_acquire` and opens getbb.app in its browser with `computer_launch`, then maximises the browser with `box_run`.
3. The person opens the right panel, then the Box panel, then **Open desktop**, and maximises the pane to watch the desktop.
4. The person opens the Monitor in BB's sidebar on the desktop box for a few seconds, its CPU and memory moving, and hides it again.
5. In the Box panel, **New box**, a Linux server with the form's defaults, then **Open terminal** on its row, and `uname -sm && nproc` in it.

The agent's wait is played at three times its speed; the rest is real time.

### The agent

A fresh BB has no agent signed in, so the thread's agent is [agent.mjs](../scripts/demo/agent.mjs), a scripted ACP agent. It makes the same calls to bb-box's tools that an agent would, through the MCP server BB gives it, and says what it does. Only its choice of calls is scripted. It needs `@modelcontextprotocol/sdk` beside it.

### Set up

On a Linux box with Docker, about 8 cores, 16 GiB of memory and 40 GB of disk free:

1. Start a fresh BB with its own data and ports, and nothing from the box's environment:

   ```sh
   env -i HOME="$HOME/fresh" PATH=/usr/local/bin:/usr/bin:/bin npx bb-app@latest \
     --data-dir "$HOME/fresh/data" --server-bind-host 0.0.0.0 --server-port 4999 --host-daemon-port 4998
   ```

   Use the same `env -i` with `npx --package bb-app@latest bb` and `BB_SERVER_URL=http://127.0.0.1:4999` as `BB_CLI` for the commands below.

2. Install bb-box from a checkout of `main`, after `npm ci` in it: `bb plugin install path:<checkout> --yes`.
3. Let boxes join it as machines: `bb settings general machineServerUrl http://<Docker bridge address>:4999`, then `bb settings general defaultMachineAccess direct`.
4. `bb box setup docker`, then set the Docker backend's `desktop-image` to `bbbox/linux-desktop:1` with `bb box config apply`, and `bb box docker-build <machine>`. Both images take about 15 minutes.
5. Register the agent and make it the default: `bb plugin config provider-acp set customAgents '[{"id":"demo","displayName":"Demo agent","command":"node","args":["<path>/agent.mjs"]}]'`, then `bb settings general defaultProviderId acp-demo`. Set `onboardingCompletedAt` and turn `telemetryEnabled` off with `bb settings general`.
6. Set the Monitor to read every 2 seconds, so its CPU and memory move in the few seconds it shows: `bb box option set monitor.refreshIntervalSeconds=2`.
7. Rehearse the flow once, which also starts the desktop, then run [reset.sh](../scripts/demo/reset.sh) so the take starts with no thread and no box.

### Record

[chrome.sh](../scripts/demo/chrome.sh) starts headless Google Chrome, which plays the desktop's video, with a debugging port. [record.mjs](../scripts/demo/record.mjs), run with Playwright beside it, drives BB's page at 1280 by 800 and draws a pointer that glides to each control before it is pressed, as headless Chrome draws none. It saves Chrome's screencast, the page alone at 2560 by 1600, with each frame's time, and the time each step starts. `DEMO_THEME=light` records BB in its light theme, and dark is the default: record both, with [reset.sh](../scripts/demo/reset.sh) and a new `chrome.sh` between them.

### Encode

[encode.sh](../scripts/demo/encode.sh) speeds up the agent's wait, holds the last frame for 1.5 seconds, and encodes from the saved frames:

- `demo.mp4` from the dark take and `demo-light.mp4` from the light one: H.264 at CRF 12, 1920 by 1200, 30 fps, about 2 MB each, `-tune animation`, yuv420p, faststart, no sound. The landing page plays one, muted and looping: the one that matches the page's theme.
- `demo.webp`, from the dark take: animated WebP at 960 by 600, 10 fps and quality 55, for the README, as GitHub plays images in a README but not videos. Lossless came to 17.7 MB, and 8.7 MB even at 800 by 500 and 6 fps, as the desktop's video changes in every frame. Lossy WebP can leave ghosts on flat, dark UI, so look at a transition's frames full size, as with `anim_dump` from the `webp` package.
- `demo-poster.jpg` and `demo-light-poster.jpg`: the desktop with the Monitor open on it, each video's poster while it loads.

Keep each under about 5 MB.

### Check every frame

Before committing, read every frame's text, as with `tesseract` over the saved frames, and look through the words for any name that is not BB's, bb-box's or the box user's. List the names that show for whoever reviews the change.

## The guide's screenshots

The guide's screenshots, `new-box-form.png`, `box-panel.png`, `desktop-box.png`, `terminal-box.png`, `monitor.png` and `monitor-threads-2x.png` in [docs/media](media), are taken on the same fresh BB, after a rehearsal and [reset.sh](../scripts/demo/reset.sh). With [chrome.sh](../scripts/demo/chrome.sh) running, [screenshots.mjs](../scripts/demo/screenshots.mjs) asks the agent for a desktop box, maximises the Box panel, and saves each at 2560 by 1600: the New box form, the Box panel with a server box and the desktop box, the desktop, and the server box's terminal after `uname -sm && nproc`. It then loads the desktop box with `stress-ng` from its own terminal and saves the Monitor open on it, with its Open menu, as `monitor.png`. Last, it makes a project on BB's server with seven threads of generic titles, two of them working, as the agent holds a turn whose prompt says WORK and ends any other at once, and saves the server's Threads menu, cropped to the Monitor, as `monitor-threads-2x.png`. An image whose name ends in `-2x` shows at half its pixels on the site, so it is sharp at the size of a 1x crop. They are in [making a box](guide/making-a-box.md), [desktops](guide/desktops.md), [the terminal](guide/terminal.md) and [the Monitor](guide/monitor.md). Read their text for names before committing, as for the video.

Take them twice, as for the video: once in dark, the default, and once with `DEMO_THEME=light`, with [reset.sh](../scripts/demo/reset.sh) and a new `chrome.sh` between them. The light take saves each with `-light` before its `.png`, or before its `-2x`, as `monitor-light.png` and `monitor-threads-light-2x.png`. The guide's Markdown names only the dark one, which GitHub shows. The site follows each image that has a light twin in the same folder with that twin, and shows only the one that matches the page's theme, so a reader's browser loads only that one.
