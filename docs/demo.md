# Recording the demo

The README and the documentation site's landing page open with a demo of about 70 seconds of a person and a thread's agent using bb-box in BB's web app. Record it again when the Box panel, the New box form, the desktop and terminal tabs, a box's page or its Snapshots card change.

## The demo video

The video is recorded in a box, on a fresh BB with no account, so no deployment's machine, user, project or account name can show. Every name in it is one BB or bb-box makes: the box that runs the fresh BB, the boxes bb-box names, and the user `box`. The scripts are in [scripts/demo](../scripts/demo).

### What it shows

1. BB's home, where the person asks the thread's agent: 'Get a Linux desktop box and open getbb.app on it.'
2. The agent gets a Linux desktop box with `box_acquire` and opens getbb.app in its browser with `computer_launch`, then maximises the browser with `box_run`.
3. The person opens the right panel, then the Box panel, then **Open desktop**, and maximises the pane to watch the desktop.
4. The person opens the Monitor in BB's sidebar on the desktop box for a few seconds, its CPU and memory moving, and hides it again.
5. In the Box panel, **New box**, a Linux server with the form's defaults, then **Open terminal** on its row, and `uname -sm && nproc` in it.
6. **Details** in the server box's menu: its page, with its Activity for a moment, then **Take snapshot** in its Snapshots card, named "before".
7. BB's back button, to the thread's terminal tab, where `sudo rm /usr/bin/git && git status` breaks the box: 'git: command not found'. `exit` ends the terminal, so no terminal is open on the box.
8. BB's forward button, back to the box's page, and **Restore** on the snapshot's row. The dialog has its undo ticked, and as nothing else is open on the box, its button says only **Restore** and the box's name. The box comes back on a new microVM, and the notice at the top of its page says it was restored, with **Undo…**.

The agent's wait is played at three times its speed, and the restore at six times; the rest is real time.

### The agent

A fresh BB has no agent signed in, so the thread's agent is [agent.mjs](../scripts/demo/agent.mjs), a scripted ACP agent. It makes the same calls to bb-box's tools that an agent would, through the MCP server BB gives it, and says what it does. Only its choice of calls is scripted. It needs `@modelcontextprotocol/sdk` beside it.

### The scripts

The recording, encoding and checking scripts in [scripts/demo/web-demo](../scripts/demo/web-demo) are copies of the `web-demo` skill's, so anyone can record the demo from a checkout. Change them in the skill first and copy them here, so the two do not drift. What is bb-box's own:

- [stage.sh](../scripts/demo/stage.sh) sets up the fresh BB, bb-box and the agent
- [steps.mjs](../scripts/demo/steps.mjs) is what the person does, for the skill's `record.mjs`
- [agent.mjs](../scripts/demo/agent.mjs) is the thread's agent
- [reset.sh](../scripts/demo/reset.sh) puts the fresh BB back to no thread and no box between takes
- [allow.txt](../scripts/demo/allow.txt) lists the words the check lets through

### Set up

On a Linux box with Docker, sudo and KVM, such as a Proxmox QEMU box, about 8 cores, 16 GiB of memory and 40 GB of disk free, with a checkout of `main` at `~/bb-box`:

```sh
sh ~/bb-box/scripts/demo/web-demo/install-tools.sh
sh ~/bb-box/scripts/demo/stage.sh ~/bb-box
```

`install-tools.sh` installs Playwright, Google Chrome, which plays the desktop's video, ffmpeg, webp, tesseract and a word list. `stage.sh` takes about 30 minutes. Start Docker first on a new VM, as the stage reads Docker's bridge address. If the image build stops moving, an Ubuntu mirror's download may have stalled: stopping its `apt` download process makes `apt` try again. It:

1. starts a fresh BB with its own data and ports, and nothing from the box's environment, on port 4999, with `~/fresh/bb.sh` as its `bb`
2. installs bb-box from the checkout
3. lets boxes join it as machines, through the Docker bridge
4. registers the agent and makes it the default, and turns off onboarding and telemetry
5. sets up the Docker backend with `bbbox/linux-desktop:1` as its desktop image, and builds both images. Docker's boxes take no snapshots, so Docker makes only the desktop, and a microsandbox backend on BB's server, first in the order, makes the Linux server, from the same image
6. sets the Monitor to read every 2 seconds, so its CPU and memory move in the few seconds it shows

### Record

From the checkout, with `BB_CLI=~/fresh/bb.sh`:

```sh
sh scripts/demo/web-demo/takes.sh scripts/demo/steps.mjs ~/takes "sh scripts/demo/reset.sh"
```

This records a rehearsal, then a dark take and a light take, in `~/takes`, with a fresh headless Chrome for each and [reset.sh](../scripts/demo/reset.sh) after each. The rehearsal starts the desktop for the first time, which is slow; it is not used. `record.mjs` drives BB's page at 1280 by 800 and draws a pointer that glides to each control before it is pressed, as headless Chrome draws none. It saves Chrome's screencast, the page alone at 2560 by 1600, with each frame's time, the time each step starts and the page's text. A take takes about a minute.

A restore can race bb-box's check that a box answers: when the check runs before the restored box has joined BB again, the box's page says it does not answer until the next check, a minute later. Look for 'does not answer' in each take's `page-text.json`, and record that theme again if it is there, giving the theme after the reset command, such as `light`.

About a second after a restore, the box's Activity card can show the old guest's last reading for about half a second, its "Read at" time earlier than the one before it, before the new guest's next reading. A new take shows it too. Read each frame's "Read at" time after the take's `restored` mark, as with `tesseract`, and remove the frames whose time goes back from the `frames` list in a copy of the take's `take.json`, beside a link to its `frames` folder. Encode that copy: the frame before stays on screen until the next fresh one.

### Encode

```sh
python3 scripts/demo/web-demo/encode.py ~/takes/dark --out docs/media --name demo --width 2560 --no-webp --max-mb 9.5
python3 scripts/demo/web-demo/encode.py ~/takes/dark --out ~/webp --name demo --webp-width 800 --webp-fps 8 --max-mb 4.9
cp ~/webp/demo.webp docs/media/
python3 scripts/demo/web-demo/encode.py ~/takes/light --out docs/media --name demo-light --no-webp
for video in demo demo-light; do ffmpeg -y -i docs/media/$video.mp4 -frames:v 1 -vf scale=1920:1200:flags=lanczos -q:v 3 docs/media/$video-poster.jpg; done
```

This plays the agent's wait three times faster, holds the last frame for 1.5 seconds, and makes:

- `demo.mp4` from the dark take: H.264 at CRF 12, 2560 by 1600, 30 fps, about 7 MB, under GitHub's limit of 10 MB for a video in a README. `demo-light.mp4` from the light take: the same at 1920 by 1200, about 4.7 MB. Both are `-tune animation`, yuv420p, faststart, no sound. The landing page plays one, muted and looping: the one that matches the page's theme.
- `demo.webp`, from the dark take: animated WebP at 800 by 500 and 8 fps, under 4.9 MB, for wherever a video does not play. Its quality steps down from 70 until it fits, as the desktop's video changes in every frame. Lossy WebP can leave ghosts on flat, dark UI, so look at a transition's frames full size, as with `anim_dump` from the `webp` package.
- The README plays `demo.mp4` as a GitHub video, a file uploaded to GitHub rather than the one in the repository. After a new take, drop `demo.mp4` into a comment box on the repository's GitHub page, such as a new issue's, without posting it, copy the `https://github.com/user-attachments/assets/...` address it gives, and put it on the README's third line in place of the old one. Mention it in the pull request's description too, so the file belongs to the repository. The docs site leaves that line out and plays its own copy.
- `demo-poster.jpg` and `demo-light-poster.jpg`: each video's first frame at 1920 by 1200, its poster while it loads, so the page does not jump when the video starts. The `for` loop makes them, as `encode.py` takes its poster from the Monitor scene.

### Check every frame

```sh
python3 scripts/demo/web-demo/scan.py ~/takes/dark ~/takes/light --allow scripts/demo/allow.txt --deny ~/deny.txt
```

This reads every frame's text, and the page's text, and fails on a word that is not in the dictionary or the allow list, or on any name in `~/deny.txt`. Write `~/deny.txt` on the box, not in the repository: the names of your machines, users, projects, accounts and domains, one per line. When it fails on a word that belongs in the demo, such as a new word in BB's interface or on getbb.app as the desktop shows it, add it to `allow.txt`. Tesseract misreads some of getbb.app's words on the desktop, and a new take can misread new ones: `allow.txt` lists those it has. List the names that show for whoever reviews the change.

Then look at the takes side by side with the last demo, as with `sh scripts/demo/web-demo/sheet.sh docs/media/demo.mp4 sheet.jpg 16`.

## The guide's screenshots

The guide's screenshots, `new-box-form.png`, `box-panel.png`, `desktop-box.png`, `terminal-box.png`, `monitor.png` and `monitor-threads-2x.png` in [docs/media](media), are taken on the same fresh BB, after a rehearsal and [reset.sh](../scripts/demo/reset.sh). With [chrome.sh](../scripts/demo/web-demo/chrome.sh) running, [screenshots.mjs](../scripts/demo/screenshots.mjs), copied into `~/.web-demo` and run there, beside Playwright, asks the agent for a desktop box, maximises the Box panel, and saves each at 2560 by 1600: the New box form, the Box panel with a server box and the desktop box, the desktop, and the server box's terminal after `uname -sm && nproc`. It then loads the desktop box with `stress-ng` from its own terminal and saves the Monitor open on it, with its Open menu, as `monitor.png`. Last, it makes a project on BB's server with seven threads of generic titles, two of them working, as the agent holds a turn whose prompt says WORK and ends any other at once, and saves the server's Threads menu, cropped to the Monitor, as `monitor-threads-2x.png`. An image whose name ends in `-2x` shows at half its pixels on the site, so it is sharp at the size of a 1x crop. They are in [making a box](guide/making-a-box.md), [desktops](guide/desktops.md), [the terminal](guide/terminal.md) and [the Monitor](guide/monitor.md). Read their text for names before committing, as for the video.

Take them twice, as for the video: once in dark, the default, and once with `DEMO_THEME=light`, with [reset.sh](../scripts/demo/reset.sh) and a new `chrome.sh` between them. The light take saves each with `-light` before its `.png`, or before its `-2x`, as `monitor-light.png` and `monitor-threads-light-2x.png`. The guide's Markdown names only the dark one, which GitHub shows. The site follows each image that has a light twin in the same folder with that twin, and shows only the one that matches the page's theme, so a reader's browser loads only that one.
