# 059: Agents record their desktop box with box_record

Status: accepted, 16 October 2026 (#707). Linux X11 desktops first, then
Wayland, then macOS on Tart, then Windows. Extended by
[073](073-recordings-draw-the-pointer-keys-and-zooms-from-the-event-log.md),
which draws a pointer, clicks, keys and zooms, and frames the screen.

## Context

An agent that builds an app in a desktop box can only describe what it
did. A short video of the app working says more, and costs the person
watching the thread less. Everything needed is in the box already: its
display, Chrome and computer use. Recording the box's own screen captures
nothing outside it, unlike recording BB's UI on a person's computer
([demo.md](../demo.md)).

What is there today:

- ffmpeg is in the Linux X11 and Wayland desktop images
  (`customize-desktop.sh`, `customize-desktop-wayland.sh`). On X11 its
  `x11grab` reads the display. Sway on Wayland needs a wlroots recorder,
  such as `wf-recorder`, which the images lacked until #707.
- BB shows a file inline in a thread through the inline-vis directive:
  HTML or Markdown only, at most 5 MiB, in an opaque-origin iframe. A
  video shows inline only inside an HTML file. The owner checked that BB
  plays an MP4 there both as a `data:` URI and by a relative path to a
  file beside the page.
- The README demo settled a lossless animated WebP for GitHub, which plays
  images but not videos in a README, and an H.264 MP4 for viewing.

Measured in a Proxmox LXC desktop (1920x1080, 4 cores), 10 s of an agent
typing into Mousepad:

| What | Size | Length | Time to make |
| --- | --- | --- | --- |
| Capture: x11grab, 15 fps, lossless x264 ultrafast | 1.6 MB | 10 s | 11% of a core while recording; 21% at 30 fps |
| MP4: 1280 wide, 15 fps, CRF 28, `-tune animation` | 22 KB | 10 s | 0.7 s |
| The same, stills cut (`mpdecimate=max=7`) | 17 KB | 4.2 s | 0.5 s |
| The same at 2x | 14 KB | 2.1 s | 0.5 s |
| Animated WebP, lossy q70, 960 wide, 10 fps | 198 KB | 4.2 s | 0.9 s |
| Animated WebP, lossless, 960 wide, 10 fps | 616 KB | 4.2 s | 3.3 s |

A desktop compresses very well, and an MP4 is about a tenth of the size of
a lossy WebP of the same clip.

## Decision

### A tool, box_record, with start and stop

`box_record` takes a box and `action`: `start` or `stop`.

- `start` begins recording the box's desktop and returns at once. The agent
  then works with the computer tools and box_run as usual.
- `stop` ends the recording, makes the clip in the box, copies it into the
  thread's storage and answers with the line that shows it in the thread.
- A recording ends by itself after 5 minutes, so one an agent forgets cannot
  run on. A `stop` after that still delivers it. A box's release ends its
  recording.
- Two optional parameters, which an agent need not set:
  - `speed`: 1 (the default), 2 or 4, applied as the clip is made;
  - `stills`: `cut` (the default) or `keep`.

A fixed length would not do: a tool call blocks the agent, so it could not
act while it recorded. A command in the skill was the fallback. But an
agent would then have to start ffmpeg in the desktop session with the
display's flags for each OS, stop it so the file is whole, encode it, copy
it out and wrap it in HTML: six steps, with as many ways to leave a
recording running or a file broken. The tool makes it two calls.

What the person sees: a clip in the thread that plays at once, muted and
looping, with controls, where the agent posts it, and the MP4 in the
thread's storage to open full size.

### Still stretches are cut, keeping a short pause

Agent work has long still stretches: builds, waits and thinking. By
default bb-box finds every stretch with no change for over 1 s
(ffmpeg's `freezedetect`) and keeps 0.5 s of it, so a 5-minute session
becomes a short clip and a pause still reads as a pause.
`mpdecimate` with `setpts` is simpler, but shrinks each still stretch by a
fixed factor rather than to a fixed pause: with `max=7`, 10 s became 4.2 s
above, and a 2-minute build would still last 15 s. The live checks measure
both on a longer session.

### Formats, size and the inline preview

- **Capture**: 15 fps, the display's size, lossless x264 ultrafast, in the
  box. It costs about a tenth of a core.
- **Clip**: H.264 MP4, scaled down to 1280 wide at most, 15 fps, CRF 28,
  `-tune animation`, yuv420p, faststart.
- **In the thread**: a tiny HTML page beside the MP4, whose
  `<video autoplay muted loop controls>` loads the MP4 by its name, shown
  with inline-vis. The page stays far under the preview's 5 MiB whatever
  the clip's size, so no clip is capped or made again smaller. (Amended:
  the first build held the MP4 as a `data:` URI, which capped it at
  3.5 MB.)
- **No WebP**: BB's preview plays the MP4.

### Where it goes

`recordings/<box>-<date>-<time>.mp4` and `.html` in the thread's storage,
written as box_copy writes there (#487). The answer gives the inline-vis
line to post, the MP4's path, the clip's length and size, and how much
time was cut.

### Order, and what the images need

1. **Linux X11 desktops**, on Proxmox LXC, Docker and microsandbox:
   `x11grab`, with the ffmpeg the images have. Nothing to add.
2. **Linux Wayland desktops**: `wf-recorder` from Ubuntu 24.04, added to
   the Wayland image builds, which the nightly refresh rolls out, run with
   `--no-damage` under `timeout`. Tracking damage, it recorded no frame
   while the screen was still, and saw a stop only once the screen changed,
   up to a minute later when Waybar's clock ticked. With `--no-damage` it
   ends 51 ms after SIGTERM, with a whole file, but copies frames all the
   time it records: about two thirds of a core, against a tenth for
   `x11grab`, for at most 5 minutes on a desktop kind of 4 cores.
3. **macOS on Tart**, then pool Macs: ffmpeg's `avfoundation`, with
   Homebrew's ffmpeg added to the macOS image. `screencapture -v` records
   a fixed length only, and exits without a file if stopped by a signal
   ([demo.md](../demo.md)). On a Tart box, ffmpeg run over SSH records the
   screen with its windows, raises no dialog, and ends 137 ms after
   SIGTERM with a whole file, at about a quarter of a core, so the image
   needs no grant of its own. macOS has no `setsid` command: Perl's starts
   ffmpeg's session. Pool Macs need Screen Recording granted as 058
   allows.
4. **Windows**: ffmpeg's `gdigrab` in the desktop session, with BtbN's
   ffmpeg build added to the Windows images and their nightly refresh.
   `ddagrab` was the plan, but it needs a Direct3D 11 device, and a box
   drawn by WARP has none ("Failed to create D3D11VA device"). On a
   Proxmox QEMU box at 1280x800, gdigrab at 15 fps costs about a tenth of
   a core while an agent types. bb-box starts ffmpeg hidden, with a console
   of its own, and stops it with `taskkill` without `/F`: ffmpeg sees its
   console close and ends its file whole, about half a second later.
   `/F` leaves a file that cannot be read, and the close reaches ffmpeg
   only from the desktop session, so both actions run there. The arm64
   image takes BtbN's build of 31 August 2026: those from 30 September
   crash at start on Windows on arm64, even x64 ones under emulation.
   (Amended.)

### Step captions (amended, 25 October 2026)

The owner asked for clips like Devin's QA recordings: a step's name at the
top centre of the video, in a translucent grey pill led by a blue ▶, and
once it is checked, its result in a near-black pill just under it, led by a
green ✓ or a red ✗. The next step's pill replaces both.

- **Two more actions**, while recording: `step` with `text`, and `result`
  with `passed` and `text`. Each appends a line to `events` beside the
  capture, timed by the box's own clock, as `start` is: Perl's
  `Time::HiRes`, on Linux and macOS alike.
- **The stop has two parts.** The box stops the capture and reports its
  length, size, start time, the still stretches to cut and the events.
  bb-box then plans the clip: each event's place after the cuts and the
  speed, where each pill shows, and a hold, a frozen frame, wherever a
  caption would otherwise stay up less than its reading time, one second
  and a word every 0.29 s, from 2 s to 6 s. The hold comes after the speed,
  so a caption reads the same at 1x, 2x or 4x. The box then draws the pills
  and makes the clip.
- **The clip's clock is each frame's own time.** It was the frame count at
  15 fps, but macOS's avfoundation gives a frame only when the screen
  changes, so a Mac's clip came out shorter than the time it showed.
- **Pills burned in**, so they survive a download or a Slack upload. On
  Linux, ffmpeg draws them: a rounded mask in `geq`, and `drawtext` in
  DejaVu Sans, after measuring the text with `print(tw)`. Homebrew's ffmpeg
  has no `drawtext`, so on macOS AppKit draws each pill as a PNG, through
  JavaScript for Automation, in the system font: it sends no Apple event,
  so it asks for no grant. A box that cannot draw them still makes its
  clip, without captions, and the answer says so.
- **Chapters**: the clip's page lists the steps, each with its result and
  its time, and a click there plays the clip from it.
- **Windows** (amended): the same two-part stop, in PowerShell. `step`
  and `result` append to `events` with the box's clock in milliseconds,
  and GDI+ draws each pill as a PNG in Segoe UI, its icon in Segoe UI
  Symbol: GDI+ comes with every Windows box, so the pills need nothing
  installed.
  Checked on a Proxmox QEMU box and on a Tart arm64 box, at 1x and 2x,
  with the captions at the top and at the bottom.
- **Where the captions go** (amended): `start` takes `position`, `top`, the
  default, or `bottom`, for a check near the top of the screen, such as a
  menu bar or a window's title. At the bottom the pills sit above a dock or
  taskbar, the step over its result.
- **Skips and speed shown** (amended): a still stretch cut of 3 s or more
  shows "▶▶ 18 s later", the time it skipped, for 1.2 s, and a clip at 2x
  or 4x shows its speed all along, both in small pills in the corner away
  from the captions. A shorter cut shows nothing, so the mark does not
  flicker. The page's step list gives each step's real time in the
  recording.

### Notifications are the agent's

bb-box does not manage notifications. The skill says, in one line: clear
or dismiss notifications, and close windows that do not belong in the
video, before starting a recording.

## Rejected

- **Recording through the display stream bb-box already reads** (RFB or
  Selkies) would cover every OS at once. But it moves full-frame traffic
  and encoding onto BB's server for the whole recording, and the frame
  rate would follow the stream, not the work.
- **A lossless WebP as the clip**, as the README has: thirty times the
  MP4's size for a desktop, for a thread that needs none of GitHub's
  limits.

## Consequences

- An agent shows its work in two calls, and the person sees it play in the
  thread.
- Each OS needs its own capture command in bb-box, and macOS and Windows
  need ffmpeg in their images, which old images lack until rebuilt.
- A recording uses about a tenth of the box's core while it runs, and its
  capture file stays in the box until the clip is made.
