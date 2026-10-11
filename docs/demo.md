# Recording the demo

The README opens with a 1-minute demo of a person using bb-box in BB's web app, and the guide uses screenshots from the same session. Record them again when the Box panel, the New box form or the desktop and terminal tabs change.

The scripts are in [scripts/demo](../scripts/demo). They run on a Mac with Google Chrome, ffmpeg and Swift.

## Before you start

- Use a Mac whose Chrome is signed in to your BB. Do not sign in to anything for the demo.
- Recording takes over the Mac's pointer and keyboard for about 5 minutes. Only start when the owner is not using it: wait until it has had no input for 5 minutes, or until they say it is free. If they start using it while you record, stop, put back what you changed and wait again.
- Work in a new Chrome window. Do not close or change the owner's tabs or windows.
- Turn on Do Not Disturb if you can. The recording covers only the page area, so a notification outside it does not show.
- The terminal or agent running the scripts needs Accessibility and Screen Recording permission in System Settings, Privacy and Security.

## The flow

The demo is 30 to 60 seconds once cut:

1. BB's web app with the left sidebar collapsed.
2. A new thread on a BB machine, with a neutral first message such as 'Demo'. Pick the machine by typing its name in the machine picker, so the list of machines is not shown in full.
3. In the thread's right panel, the plus, then **Box**, then the plus in the Box panel: the New box form. Choose Linux and Desktop, and select **Create box**.
4. **Open desktop** on the new box's row. The desktop appears in the panel.
5. Ask the thread's agent: 'Open Chrome on the desktop box and go to getbb.app.' It opens Chrome through computer use and the page loads in the panel.
6. Expand the panel, so the desktop shows large.
7. The Box tab, a second box: Linux and Server. **Open terminal** on its row and run `uname -a`.

Afterwards, release both boxes (`bb box release NAME --thread THREAD`), and close the window. Archive the demo thread only if its owner wants it gone.

## Capturing only the page

The recording shows BB's page and nothing else: not Chrome's tabs or address bar, which would show where your BB is hosted, and nothing outside the window.

`window.sh` opens a new Chrome window with its page area 1280x800 points at a fixed place on the screen, and `record.sh` and `shot.sh` capture exactly that area. Chrome's toolbar is taken as 87 points tall; if the first capture shows part of it, or cuts off the page, change `DEMO_TOOLBAR`. On a Retina screen the capture is 2560x1600 pixels.

```sh
swiftc -O scripts/demo/input.swift -o /tmp/demo-input
sh scripts/demo/window.sh open https://YOUR-BB/          # prints the window's ID
sh scripts/demo/record.sh 200 /tmp/demo/take.mov         # records for 200 s, in the background
```

## Driving Chrome

Chrome's default profile has no DevTools port and its JavaScript from AppleScript is off, and turning either on changes the owner's browser. So the demo is driven like a person would: `input.swift` posts mouse and keyboard events, gliding the pointer so clicks read well on video.

```sh
/tmp/demo-input click 477 331     # screen points: window x + page x, window y + 87 + page y
/tmp/demo-input type MACHINE-NAME
/tmp/demo-input key 36            # Return
/tmp/demo-input scroll -40        # repeat to scroll a form
/tmp/demo-input pos               # where the pointer is
```

Find each target with `shot.sh` and convert its place in the PNG to screen points: halve Retina pixels, then add the window's page origin (0, 127 with the defaults). Before each step, check with `pos` that the pointer is where you left it; if not, someone is using the Mac. Take the guide's screenshots with `shot.sh` during the same session.

## Recording for a fixed time

Give `record.sh` a length a little longer than the flow, about 200 s, and wait for it to end. Do not stop it with a signal: a background `screencapture` ignores Ctrl-C, and if made to stop on SIGINT it exits without writing the file. The cut removes the extra time.

## Cutting

List the moments the picture changes, then look at frames to check what each one shows:

```sh
sh scripts/demo/find-cuts.sh /tmp/demo/take.mov
sh scripts/demo/find-cuts.sh /tmp/demo/take.mov /tmp/demo/frames.png 5 19 100 177
```

Write the parts to keep as `start,end` lines, as in [cuts.example.txt](../scripts/demo/cuts.example.txt). Keep each click and the moment its result shows, and cut:

- waiting, including the agent's thinking
- the machine picker before the filter applies, which lists every machine
- the thread's Info tab, whose Directory row contains BB's host
- anything else that shows the host

Machine, box, provider and project names may show.

## Encoding

```sh
sh scripts/demo/encode.sh /tmp/demo/take.mov cuts.txt /tmp/demo/out
```

This cuts to a lossless master at 1280x800, then encodes from it:

- `demo.webp`: lossless animated WebP at 20 fps, usually 4 to 5 MB. Lossy WebP blends parts of earlier frames, which leaves ghosts on flat, dark UI, so do not use it. Keep it under 8 MB; if lossless is far over, cut the video shorter.
- `demo.mp4`: H.264 at CRF 12, `-tune animation`, yuv420p, faststart, 30 fps, usually about 2 MB. Keep it under 10 MB.

Always encode from the original recording, never from an earlier MP4 or WebP, or their artifacts carry over. To check a new encode against the old one at the same moment:

```sh
uv run --no-project --with pillow python scripts/demo/compare.py \
  docs/media/demo.webp /tmp/demo/out/demo.webp /tmp/demo form=13:700,60,580,360
```

## Where the files go

Put the files in [docs/media](media):

- `demo.webp` and `demo.mp4`
- `new-box-form.png`, `desktop-box.png`, `terminal-box.png` and `box-panel.png`, at 2560x1600

The README shows the WebP just under its title, because GitHub plays images in a README but not videos stored in the repo. The image links to the MP4:

```markdown
[![What the demo shows](docs/media/demo.webp)](docs/media/demo.mp4)
```

The screenshots are in [making a box](guide/making-a-box.md), [desktops](guide/desktops.md) and [the terminal](guide/terminal.md). Before committing, list the names that show in the video and screenshots for whoever reviews the change.
