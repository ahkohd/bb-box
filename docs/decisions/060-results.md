# 060 results: how smooth and sharp each desktop is

The numbers [060](060-every-desktop-streams-as-video-through-one-viewer.md)
measures each platform's stream by. Each new stream is measured the same
way and added here beside the baseline it has to beat.

## How they were measured

With the harness in [scripts/measure](../../scripts/measure/README.md), on
17 October 2026:

- The desktop box shows `scene.html` full screen in its own browser, and
  its lossless screenshot is the reference for sharpness.
- The viewer is headless Chrome on a Linux desktop box, through BB's
  server, as the panel's own client: noVNC with the box's display quality
  and lossless refresh, or the panel's video client. It takes control as
  the panel does.
- Each run: 3 s idle, then the text's SSIM, a 10 s drag of a solid block
  (with the SSIM again halfway), 10 s of wheel scrolling with a key every
  400 ms, then 15 keys alone.
- The box's CPU is the whole box's, in cores, from `/proc/stat`, `top` or
  the Windows processor counter.

## Baselines

Drag lag is how far the block trails the pointer in each frame. Key
times are from the key's send to the frame showing it.

| Desktop | Stream | Pixels, scale | Drag fps | Drag lag p50 / p95 | Torn | Scroll fps | Scroll Mbit/s | Key p50 / p95, idle | Key p50, scrolling | Text SSIM | Box cores, drag / idle |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Linux X11 | VNC | 1920x1080, 1x | 56 | 26 / 37 ms | 0 | 208 | 8.7 | 17 / 18 ms | 21 ms | 0.9999 | 1.0 / 0.02 |
| Linux X11 | video (Selkies) | 1920x1080, 1x | 62 | 26 / 36 ms | 0 | 62 | 2.6 | 14 / 38 ms | 33 ms | 0.9996 | 1.3 / 0.3 |
| Linux Wayland | VNC (wayvnc) | 1920x1080, 1x | 91 | 32 / 54 ms | 0 | 123 | 21.0 | 4 / 13 ms | 27 ms | 1.0 | 0.3 / 0.2 |
| macOS, pool Mac | VNC (Screen Sharing) | 3840x2160, 2x | 14 | 95 / 124 ms | 0 | 38 | 29.8 | 68 / 77 ms | 134 ms | 0.9997 | 1.3 / 0.1 |
| macOS, Tart VM | VNC | 2048x1536, 1x | 55 | 35 / 38 ms | 0 | none | none | 15 / 59 ms | 39 ms | 1.0 | 0.5 / 0.3 |
| Windows on Proxmox | VNC (QEMU) | 1280x800, 1x | 20 | 83 / 114 ms | 0 | 13 | 1.4 | 52 / 64 ms | 150 ms | 1.0 | 1.6 / 1.1 |
| Windows on a Mac | VNC (QEMU) | 1280x800, 1x | 32 | 60 / 94 ms | 0 | 56 | 10.5 | 93 / 121 ms | 73 ms | 1.0 | 1.3 / 1.3 |

What they show:

- **On Linux, VNC keeps up with a drag as well as video does**: both trail
  the pointer by about 26 ms at the median. The Tart Mac is close behind.
- **The pool Mac at 2x is the slowest**: 14 frames a second dragging and
  38 scrolling, at about 30 Mbit/s, a drag about 100 ms behind, and keys at
  68 ms. Its text is sharp when still.
- **Windows on Proxmox is next**: 20 and 13 frames a second, a drag about
  80 ms behind, and 150 ms for a key while scrolling. The box uses a core and a half while dragging,
  and a core even when idle.
- **Text at rest is sharp everywhere**, VNC and video alike: for dark text
  on white, 4:2:0 video loses only colour, which the text has none of. The
  blur the owner sees on video is in coloured text and in motion, which
  this scene does not yet test.
- **No torn frames were found**, the pool Mac included. The check reads one
  block's edge on two rows per decoded frame, which may be too coarse for
  the tearing seen there; it needs a finer test before it can pass the
  Mac's video.

## Pool Mac: video against VNC, 17 October 2026

The pool Mac at 2x (3840x2160), through BB's server, after #759 gave it
bb-box-stream. Same harness, one run each; the Mac's CPU is the whole
Mac's.

| | VNC (Screen Sharing) | Video (bb-box-stream) |
| --- | --- | --- |
| Drag fps | 12 | 49 |
| Drag lag p50 / p95 | 101 / 142 ms | 58 / 71 ms |
| Scroll fps | 27 | 50 |
| Key p50, idle / while scrolling | 74 / 176 ms | 55 / 100 ms |
| Scroll Mbit/s | 21.9 | 2.6 |
| Text SSIM still, black on white / coloured | 0.9997 / 0.996 | 0.9994 / 0.991 |
| Coloured text SSIM, halfway through the drag | 0.996 | 0.989 |
| Mac's CPU while dragging | 1.3 cores | 1.4 cores |

Video's 49 fps is the display's own rate: the HDMI dummy plug runs at
50 Hz.

**Tearing.** The owner saw it when dragging windows. A page's block dragged
inside a browser shows none on either stream. A real window dragged by its
title bar does show it on Screen Sharing:

| | VNC | Video |
| --- | --- | --- |
| Torn frames | 29 of 220 (13%), rows up to 128 pixels apart | 0 of 510 |
| Frames a second | 21 | 49 |
| Drag lag p50 / p95 | 63 / 131 ms | 55 / 82 ms |

The window was a red browser window on a dark background, with the Dock
hidden and clicking the wallpaper to reveal the desktop turned off. The
Mac draws a moving window with its rows one drag step (16 pixels) apart,
on the screen itself and on both streams, so the harness counts a frame as
torn only when its rows spread further than in the drag's typical frame.

Against 060's measures, video ends the tearing and drags in about half
VNC's lag, at four times the frames. It does not yet meet two of them: its
median drag lag is 58 ms, not under 50, and its coloured text is a little
softer than Screen Sharing's when still (0.991 against 0.996), as 4:2:0
loses colour. It is the panel's default on pool Macs from #759, with Show
as VNC in the Display menu.

## Windows on Proxmox: video against VNC, 17 October 2026

A windows-desktop box at 1280x800 of build.20261017-150621-a96f, the first
with bb-box-stream.exe, through BB's server; VNC is QEMU's. Video is as
this PR leaves it: OpenH264 at most QP 26, and standard font smoothing.

| | VNC (QEMU) | Video (bb-box-stream.exe) |
| --- | --- | --- |
| Drag fps | 22 | 45 |
| Drag lag p50 / p95 | 77 / 115 ms | 47 / 79 ms |
| Scroll fps | 13 | 35 |
| Key p50, idle / while scrolling | 47 / 151 ms | 44 / 56 ms |
| Scroll Mbit/s | 1.0 | 1.0 |
| Text SSIM still, black on white / coloured | 1.0 / 1.0 | 0.9988 / 0.9865 |

- **Window drag:** a red Edge window dragged by its title bar, 22 fps and
  84 / 112 ms behind on VNC against 36 fps and 56 / 81 ms on video. Both
  show the same spread of the window's edge down its rows in about half
  their frames: Windows draws a moving window so, and video's frames are
  whole captures of the compositor, so it is the screen's, not a tear.
- **Torn frames:** the drag check counted 2 torn frames on video. They
  have not been examined, so it is not known whether they come from the
  stream or from how Windows draws a moving window.
- **Bitrate:** about 20 kbit/s watching a still screen, which sends a key
  frame and two sharpening frames, then nothing; 1.6 Mbit/s for a page
  that moves every frame, at 24 fps.
- **CPU:** the server took 0.22 cores of the box's four while that page
  moved. With no viewer there is no server: it exits a minute after the
  last viewer leaves. Windows' processor counter over 10 s phases was too
  noisy to give more.
- **ClearType:** with it, text scored 0.979; its coloured fringes are what
  4:2:0 loses. The image now uses standard font smoothing.

## Tart Mac: video against VNC, 17 October 2026

A small macos-desktop box (4 cores) of build.20261017-171050-80c3, the
first with bb-box-stream, at 2048x1536, through BB's server. VNC is the
Virtualization framework's, through bb-box's holder. Same harness, one run
each, with Chrome showing the scene at 50% page zoom.

| | VNC | Video (bb-box-stream) |
| --- | --- | --- |
| Drag fps | 55 | 56 |
| Drag lag p50 / p95 | 40 / 44 ms | 50 / 63 ms |
| Torn frames | 0 | 0 |
| Scroll fps | 55 | 57 |
| Drag / scroll Mbit/s | 7.6 / 20.6 | 0.25 / 1.3 |
| Key p50, idle / while scrolling | 22 / 74 ms | none shown / 83 ms |
| Text SSIM still, black on white / coloured | 1.0 / 1.0 | 0.9994 / 0.9857 |
| Box cores, drag | 0.43 | 0.59 |

- **Encoder:** VideoToolbox's hardware encoder works in the VM: the
  Virtualization framework passes it to the Mac's. At 1080p it takes about
  7 ms a frame and a tenth of a core; at 2x, 19 ms. The software encoder
  takes 11 and 35 ms and two cores at 1080p.
- **Keys alone, in Chrome:** none of the 15 keys showed on video, in two
  runs, though frames came. In the VM, ScreenCaptureKit's stream holds back
  a small change in Chrome until something asks the window server for the
  screen: with an 8x8 screenshot 50 ms after each key, every key showed in
  the stream; without it, none did. TextEdit and Safari are not affected.
  VNC reads the VM's screen from outside it, so it is not affected. The fix
  is below.
- **The wheel** scrolls through the stream, in Chrome and in Safari.
- **Through the panel:** the box opens as video. Show as VNC and back,
  control, typing with Shift and Cmd+S, the wheel, and pasting both ways
  work.

## Tart Mac: Chrome's keys on video, 17 October 2026

bb-box-stream now takes a tiny screenshot, in a VM only, while a viewer
watches: every 30 ms for 200 ms after input, unless the stream sent a frame
in the last 30 ms, as in a drag, and every 250 ms otherwise. Measured with
the harness on a medium box (6 cores) with the server built in it and
Tart's video field on for the runs, as above.

| | Video, run 1 | Video, run 2 | VNC |
| --- | --- | --- | --- |
| Keys alone, shown | 15 of 15 | 15 of 15 | 15 of 15 |
| Key p50 / p95, alone | 57 / 76 ms | 58 / 146 ms | 31 / 95 ms |
| Key p50, while scrolling | 54 ms | 89 ms | 70 ms |
| Drag fps, lag p50 / p95 | 56, 50 / 75 ms | 57, 54 / 67 ms | 52, 34 / 53 ms |
| Scroll Mbit/s | 1.2 | 1.4 | 20.3 |
| Box cores, idle with a viewer | 0.61 | 0.48 | 0.36 |

- These runs took a screenshot after every pointer move too: about 1.2
  cores while dragging. Skipping it while the stream sends frames anyway
  halves that. Moving the pointer 60 times a second in the box, the whole
  VM went from 18.5% to 9.5% of its 6 cores, with the same frames, and
  frames still came 0 to 45 ms after each key.
- Tart's image needs a rebuild to carry the fix. Until then, and until the
  video field is turned on, Tart Macs show VNC only.

## Linux Wayland: Selkies on Sway against wayvnc, 17 October 2026

Selkies 2.0 can capture an existing wlroots compositor
(`--wayland-host-display`): screencopy for frames, and the virtual keyboard
and pointer protocols for input. So it streams the box's own Sway, and
048's floating windows stay as they are. A linux-desktop-wayland-cpu box
(4 cores, 1920x1080) ran the X11 image's Selkies 2.0.0 package with the
X11 wrapper's flags and that option. wayvnc was measured through BB's
server with viewer refresh, as the panel uses it. Selkies was measured
directly, as the Wayland kind does not offer it, through a forwarder that
drops the browser's Origin, as bb-box's relay does. Two runs of video.

| | wayvnc via BB | Selkies on Sway, run 1 | Run 2 |
| --- | --- | --- | --- |
| Drag fps | 118 | 61 | 61 |
| Drag lag p50 / p95 | 36 / 57 ms | 32 / 45 ms | 32 / 45 ms |
| Torn frames | 0 | 0 | 0 |
| Scroll fps | 123 | 61 | 62 |
| Scroll Mbit/s | 20.5 | 2.9 | 3.0 |
| Key p50, alone / while scrolling | 4 / 27 ms | 26 / 69 ms | 10 / 57 ms |
| Text SSIM still, black on white / coloured | 1.0 / 1.0 | 0.987 / 0.985 | 0.987 / 0.984 |
| Box cores, drag / idle with a viewer | 0.72 / 0.43 | 1.13 / 0.96 | 0.74 / 0.62 |

- **Decision: wayvnc stays.** Video's gain is bandwidth, about a seventh
  while scrolling, and a drag a little closer to the pointer. Keys are
  slower, text is softer and the box works harder. Video is held to Sway's
  60 frames a second; wayvnc's count is higher as it sends rectangles as
  they change.
- **Text** was 4:2:0 at CRF 25: Selkies ignores the full-colour message
  that bb-box's relay acts on, so through the relay it would be sharper.
- **Resize defect:** in host-capture mode, Selkies takes the desktop's
  size from its own view, which starts at 1024x768 and does not follow
  Sway, so each new viewer set Sway to 1024x768, even with
  `--enable-resize=false`. `--manual-width` and `--manual-height` hold one
  size, but each viewer then sets Sway back to it, undoing bb-box's own
  sizing (021, 048). It needs Selkies or pixelflux to read the host's
  output size.
- Selkies admits one main client, so a second page evicts the first; the
  harness leaves each run's page open, which spoiled three earlier runs.
- Selkies' own compositor (labwc), in place of Sway, was not measured.

## Windows: torn frames while scrolling, 17 October 2026

The owner saw video tear on Windows while scrolling. The harness now finds
a scroll's torn frames too: the list's rows are 20 pixels in two colours,
so in a whole frame they change colour at one place in 20 down a blank
column, and in a torn frame at two. A windows-desktop box of
build.20261017-191915-c934 at 1280x800, through BB's server, with the
scene in Edge.

| | Video before, 4 runs | Video after, 2 runs | VNC |
| --- | --- | --- | --- |
| Scroll frames torn | 47 of 354, 37 of 365, 3 of 286, 23 of 382 | 0 of 229, 0 of 240 | 0 of 133 |
| Drag frames torn | 22, 28, 3, 1 | 0, 0 | 0 |
| Scroll fps | 28 to 38 | 23 to 24 | 13 |
| Drag fps | 30 to 55 | 24 to 26 | 23 |
| Key p50, alone | 41 to 43 ms | 46 to 47 ms | 42 ms |

- **Where:** the torn frames are in Desktop Duplication's image of the
  screen on the Basic Display adapter. In the box, a copy of each
  duplicated frame was torn now and then while Edge scrolled with the
  wheel, though the image did not change while it was copied, and GDI's
  copies of the screen at the same time never were (0 of 807). So it is
  not Edge or DWM, nor bb-box-stream's copy, encoder or the viewer.
- **Fix:** on that adapter the duplicated frame now only says the screen
  changed, and GDI copies the screen once it is released.
  `BB_STREAM_CAPTURE=map` copies the duplicated image as before.
- **Cost:** GDI's copy takes about 20 ms a frame at 1280x800, against
  0.9 ms to map and copy the duplicated image, so a scroll shows about 24
  frames a second where it showed about 35: still above VNC's 13. Encoding
  one frame while copying the next would win some of that back.
- The 2 torn frames of the first Windows drag run, above, were these.
- **Copying while encoding:** a thread of its own now copies the screen
  while the frame before is encoded. On build.20261017-213805-cd97, two
  runs each: a drag went from 25 and 28 frames a second to 34 and 34, a
  scroll from 22 and 23 to 24 and 22, with no torn frame in either. While
  Edge scrolls, the copy itself is the limit.
- The box's CPU log read too low to be trusted in these runs, so they give
  no CPU figures.

## Corrected, 17 October 2026

The drag lags first given here for VNC were wrong, as were those in 056's
comparison. The analyser looked for the block's starting place in the 2 s
before the drag, and a VNC server sends no frames while the screen is
still, so it matched each VNC frame against the wrong place: about 250 ms
at the median and 1.4 s at the 95th percentile, on every platform. It now
takes the last frame before the drag, however old, or the scene's own
place. The lags above are recomputed from the same runs; nothing else
changed.

## The pointer over video, 17 October 2026

"Show the box's pointer", the option these checks name, has since gone
(the owner's note of 17 October 2026): the rule stays, with the box's
pointer out of the video while a person holds control and in it while the
agent does, and a box whose image cannot leave it out still shows it
always.

While a person holds control, the video leaves the box's pointer out and
the browser shows its shape instead (#772, #773). Checked by hand through
the panel, with one tab in control and one watching:

- The pool Mac and Linux drawn by the CPU follow it in both tabs: no
  pointer in the video while the person holds control, and the pointer in
  it with "Show the box's pointer" on or while the agent holds control.
- Windows does not. bb-box-stream.exe leaves the pointer out when told,
  but the pointer is already in the image Desktop Duplication returns. The
  VM's display adapter is the VirtIO GPU's display-only driver, which has
  no hardware cursor, so Windows draws the pointer into the desktop image.
  Windows video does not offer the option until a display device whose
  driver has a hardware cursor leaves it out.
- That driver has one, off by default: its INF sets HWCursor to 0. With
  HWCursor 1 in the display device's 2 keys and the device restarted,
  Desktop Duplication leaves the pointer out, checked on a throwaway box
  and through the panel. The image's first logon and refresh now turn it
  on (hardware-cursor.ps1), its record lists "hardware-cursor", and only a
  box of such an image offers the option. QEMU's VNC then sends the pointer
  as a cursor shape, not in the picture, so a viewer watching over VNC sees
  no pointer: accepted, as Windows shows video by default.
- On Linux, each change of control or of the option restarts Selkies'
  capture. Once, with the pointer still, the watching tab kept the frame
  from before the restart until the screen changed. With the pointer
  moving it did not happen. Not fixed.

## Windows on a Mac: video against VNC, 18 October 2026

A windows-arm64-desktop box (4 cores, 1280x800) of a build with
bb-box-stream.exe and Cisco's arm64 OpenH264 2.6.0, through BB's server,
3 runs each, against QEMU's VNC on the same kind (p50 / p95).

| | VNC, LAN | Video, LAN | VNC, 20 Mbit/s, 40 ms | Video, 20 Mbit/s, 40 ms |
| --- | --- | --- | --- | --- |
| Drag fps | 49-52 | 27-29 | 27-28 | 23-28 |
| Drag lag | 76-79 / 115-130 ms | 53-59 / 75-84 ms | 133-135 / 194-206 ms | 102-109 / 183-259 ms |
| Scroll fps | 52-58 | 20-22 | 25-27 | 20-21 |
| Scroll Mbit/s | 9.6-10.8 | 0.6 | 3.0-3.2 | 0.6 |
| Scroll torn frames | 3-7% | 0% | 2-4% | 0% |
| Key alone | 92-98 ms | 54-62 ms | 127-137 ms | 99-113 ms |

- **Decision: VNC stays the default on a Mac, video by choice.** Video is
  closer to the pointer and quicker for a key, but shows half VNC's
  frames on a LAN.
- **The limit is the capture, not the encoder.** Converting and encoding
  a 1280x800 frame takes 7.6 ms on arm64 (1.4 ms to I420, 6.2 ms in
  OpenH264), about 118 frames a second; x64 takes 5.6-6.3 ms. With Edge
  drawing 65 frames a second, Desktop Duplication on the Mac's VirtIO GPU
  DOD driver signalled 2-7 a second, mapped or read through GDI alike,
  and a full-screen GDI copy takes 26.7 ms. QEMU's VNC reads the guest's
  framebuffer from the host, about 50 updates a second.
- **Parked: a host-side bridge.** A program on the Mac that reads QEMU's
  VNC framebuffer on loopback, as the VNC display does, and encodes it
  with VideoToolbox, as bb-box-stream does for macOS desktops, served to
  the panel's video client. It would not need Windows' capture and would
  keep the encoder off the guest's cores. Copying only Duplication's
  dirty rectangles was considered and dropped: Duplication's own signal
  is the lower bound.

## Linux Wayland on Ubuntu 26.04, 19 October 2026

The Wayland images (Proxmox LXC and Docker) moved from Ubuntu 24.04 to
26.04, for the box's pointer. On 24.04's Sway 1.9 neither stream could
send it: Sway paints the pointer into every frame, so bb-box hid it with
a blank cursor theme while a person held control (#707), and the person's
own pointer was a plain arrow whatever the box's shape. Sway 1.11 on
26.04 (wlroots 0.19) has ext-image-copy-capture, whose pointer cursor
session gives the pointer's image, hotspot and position apart from the
frames.

What changed:
- **wayvnc 0.9.1** sends the pointer's shape to noVNC itself, and paints
  none into its frames.
- **Selkies 2.0.0's 26.04 build** paints no pointer either, but sends the
  browser one arrow at connect and never its changes. Its painted mode
  (`SET_NATIVE_CURSOR_RENDERING,1`) logged `cursor=painted` and painted
  nothing in host-capture mode. #808's and #819's patches apply as they
  are.
- **bb-box-cursor** (#828), in the image, opens a pointer cursor session
  and writes each change as a line. bb-box sends its shape to video viewers
  as Selkies' own cursor message, and its position as `BB_POINTER` (#834).
  The panel shows the person in control the box's shape, and draws the
  pointer over the picture for people watching, over video (#836) and
  over VNC, on a pointer stream of its own (#844).
- **The blank theme** stays for an image without the helper, as every 24.04
  box (#829).
- **Coreutils and sudo** are uutils and sudo-rs on 26.04. The forms bb-box
  runs in a box behave alike, except that `timeout -s KILL` exits 124, not
  137, and sudo-rs ignores `sudo -E`; bb-box relies on neither (#826).
- **wayvnc 0.9.1 still crashes** in neatvnc when a client connects after
  Sway was resized with no client (#394). The display script's restart of
  wayvnc after such a resize covers it, as on 24.04.

Checked through BB on fresh boxes of each backend, 1920x1080, with the
panel's own clients:

| | Proxmox LXC (CT 9809) | Docker |
| --- | --- | --- |
| bb-box-check-desktop | every line ok | every line ok or skipped (no TUN, no units) |
| Shape for the person in control, video and VNC | arrow, I-beam (Chrome and Mousepad, GTK3's own), hand, resize arrows | the same images |
| Pointer drawn for a watcher, as the agent clicks | at the click less its hotspot, video and VNC | the same, video and VNC |
| 5 resizes after a hidden tab | 0.31-0.38 s, no black frame | 0.31-0.36 s, no black frame |
| Hand-back with the tab hidden | 0.72 s, size restored | 0.55 s, size restored |
| VNC resize | 0.31-0.33 s | |
| A first viewer | Sway kept 1920x1080 | |
| Clipboard, video | text (é 中 ✓) and a 62 KB PNG both ways, byte for byte | |
| Clipboard, VNC | text both ways, exact; no images, as on 24.04 | |

## Linux on arm64: video against VNC, 19 October 2026

The two arm64 Linux desktop kinds, microsandbox and Tart, offer video by
choice since #848, from the Selkies their X11 images already run. Each box
had 4 cores and 8 GiB, at 1920x1080, through BB's server, with the same
harness. The slow link is 20 ms more each way and 20 Mbit/s from the box.
Two runs each on the LAN, one on the slow link (p50 / p95).

| | VNC, LAN | Video, LAN | VNC, 20 Mbit/s, 40 ms | Video, 20 Mbit/s, 40 ms |
| --- | --- | --- | --- | --- |
| **microsandbox** | | | | |
| Drag lag | 50 / 149-155 ms | 33-42 / 73-158 ms | 90 / 142 ms | 79 / 90 ms |
| Scroll Mbit/s | 6.6-7.0 | 3.0-3.1 | 5.9 | 3.0 |
| Key alone | 24-27 / 100-102 ms | 20-22 / 153-165 ms | 72 / 191 ms | 61 / 120 ms |
| Key while scrolling | 66-67 ms | 52-64 ms | 116 ms | 97 ms |
| Box cores, drag / watched idle | 0.9 / 0.1 | 1.7-1.9 / 0.4 | 1.1 / 0.1 | 1.8 / 0.3 |
| **Tart** | | | | |
| Drag lag | 34-37 / 54-58 ms | 28-34 / 38-45 ms | 78 / 101 ms | 78 / 531 ms |
| Scroll Mbit/s | 7.6-8.1 | 2.9 | 5.4 | 2.7 |
| Key alone | 37-39 / 45-446 ms | 22-23 / 29-80 ms | 77 / 1280 ms | 65 / 75 ms |
| Key while scrolling | 28-33 ms | 34 ms | 91 ms | 75 ms |
| Box cores, drag / watched idle | 1.3 / 0.06 | 1.7-1.8 / 0.9 | 1.1 / 0.04 | 1.7 / 0.9 |

Both kinds, both streams: no torn frames (one scroll frame in one video
run); video draws 60 frames a second, VNC 80 to 160 updates. Text SSIM
still, black on white and coloured: 0.9999 and 0.9998 over VNC, 0.998 and
0.996 over video, as on x64.

- **Video is as close to the pointer as VNC, or closer, and quicker for a
  key, at half the bandwidth.** On the slow link the gap widens on
  microsandbox: a drag's p95 is 90 ms against 142, a key 61 ms against 72.
- **Video costs CPU.** A drag takes about 0.8 of a core more. While
  someone watches an idle desktop, Selkies goes on encoding, 35 frames a
  second on microsandbox and 54 on Tart, for 0.4 and 0.9 of a core;
  nobody watching, it stops (#821).
- **The Tart VM stalls** for 0.5-0.65 s now and then, over both streams
  alike, which gives its p95 and maximum figures on the slow link.
- **Through the panel**, on both kinds: a first viewer leaves the screen at
  1920x1080 (first frame in 358 ms on microsandbox); a watcher sees the
  box's pointer in the video while the agent has control, in its shape
  (arrow, I-beam), and none while a person has it, who sees their own in
  the box's shape. Text (é 中 ✓) and a 62 KB PNG paste both ways over
  video, byte for byte; over VNC, text both ways, no images, as on x64.
  Five resizes after a hidden tab take 0.66-1.15 s (Wayland's took
  0.31-0.38 s), the held picture covering the change; hand-back with the
  tab hidden restores 1920x1080 in 0.64-0.85 s.

## Windows on a Mac: video from QEMU, 19 October 2026

Windows' own capture on the Mac's VirtIO GPU gave video a few frames a
second (above). bb-box-stream gained a mode for the Mac itself (#865): it
reads the VM's QEMU VNC server on the Mac's loopback, raw pixels, and
encodes them with VideoToolbox, as the macOS stream does. The Tart backend
builds it on each Mac from mac-stream.swift with the Command Line Tools'
swiftc. The person's pointer goes to QEMU's tablet through it, as the VNC
display gives it; keys, typing and the clipboard go to the guest's
bb-box-stream.exe, which also says where the pointer is for people
watching.

Measured through BB, on a Tart Windows box (4 cores, 1280x800, image
build.20261019-190106-a539) and a Linux viewer box, three runs of each,
interleaved, each run closing its viewer before the next (p50, p95 in
brackets). Frame rates count only the frames in which the dragged block
moved, as both streams send frames that change nothing (below).

| | Video, LAN | VNC, LAN | Video, 20 Mbit/s, 40 ms | VNC, 20 Mbit/s, 40 ms |
| --- | --- | --- | --- | --- |
| Moves a second, dragging | 25-29 | 25-29 | 25-29 | 14-15 |
| Drag lag | 58-60 (76-519) ms | 73-74 (111-119) ms | 101-102 (118-452) ms | 121-133 (187-199) ms |
| Drag Mbit/s | 0.07-0.13 | 4.5-5.8 | 0.08-0.14 | 1.8-2.0 |
| Scroll Mbit/s | 0.6-0.7 | 8.9-10.9 | 0.6-0.7 | 2.6-3.6 |
| Scroll frames torn | 0% | 3-8% | 0% | 2-6% |
| Key alone | 95-116 ms | 85-98 ms | 142-144 ms | 130-135 ms |
| Text SSIM still, black / coloured | 0.998-1.0 / 0.975-0.988 | 1.0 / 1.0 | 0.998-1.0 / 0.975-0.986 | 1.0 / 1.0 |

- **On a LAN, video keeps up with VNC**, 15 ms closer to the pointer, with no
  torn frames, at a fifteenth of the bandwidth. A key alone shows within
  about 15 ms of VNC's.
- **On a slow link, video is clearly ahead**: nearly twice VNC's moves a
  second, and 20-30 ms closer.
- **QEMU's refresh is the limit for both.** Its VNC server refreshes every
  30 ms while the picture changes, so about 33 a second at most; while it
  is still, more slowly, up to every 3 s; and at once again only when a
  client sends input (ui/vnc.c, vnc_refresh and protocol_client_msg). With
  the input through the guest, a key alone first showed in 150-186 ms. So
  the pointer goes through QEMU, and after each key the pointer as it is
  goes to QEMU again.
- **On the Mac**, a frame takes about 4 ms to encode and the bridge under 2%
  of a core. In the guest, Windows' capture and encoder no longer run.
- **QEMU sometimes stops answering one client** after another VNC client
  came and went; why is not known. The bridge connects again when a whole
  picture asked for has not come within a second. A first version of that
  reconnection wrote to the old socket's number after it was reused, and
  stalled the video while a VNC viewer joined; fixed (#881). Since then, a
  video viewer that joined as a VNC viewer joined got its video in 18 of 19
  tries.
- **People watching see the agent's pointer**, over video and over VNC:
  bb-box-stream.exe says where it is to a client that asks, and bb-box
  draws it, as on Wayland. Neither stream has it in the picture, as
  Windows puts it on the GPU's cursor plane.

## Corrected, 19 October 2026

The VNC frame rates for Windows on a Mac, in the baselines (32 dragging, 56
scrolling) and in the section of 18 October (49-52 and 52-58), count every
frame noVNC drew. The panel asks QEMU to send still areas again losslessly,
and each of those answers is a frame in which nothing on the scene moved.
Counting only the frames in which the dragged block moved, as above, VNC on
the same kind gives 25-29 a second on a LAN. The lags, key times and
bandwidth of those runs are as they were.

## Linux on a GPU: video with NVENC, 19 October 2026

A GPU desktop (`linux-desktop`) offers video by choice since #871, encoded
with NVENC on the box's GPU (#870). Two fixes to the image came before the
runs below:
- **4:2:0, locked.** A viewer asks for full colour, and NVENC's 4:4:4
  session failed with `NV_ENC_ERR_OUT_OF_MEMORY` on a shared GPU. Selkies
  then fell back to x264 on the box's CPU without telling the viewer.
- **Text in greyscale.** Ubuntu's fontconfig draws text in an LCD's
  subpixel colours, which 4:2:0 loses: NVENC's text scored 0.987 against
  the box's screenshot. Drawn in greyscale, by `/etc/fonts/local.conf`, it
  scores 0.9995. The setting is in every Proxmox LXC X11 desktop image.

Each box had 4 cores and 8 GiB, at 1920x1080, through BB's server, with
the same harness, beside a CPU desktop for comparison, whose video is x264
at 4:4:4. The slow link is 20 ms more each way and 20 Mbit/s from the box.
Two runs each on the LAN, one on the slow link (p50 / p95).

| | VNC, LAN | Video, LAN | VNC, 20 Mbit/s, 40 ms | Video, 20 Mbit/s, 40 ms |
| --- | --- | --- | --- | --- |
| **GPU desktop** | | | | |
| Drag lag | 29-32 / 47-54 ms | 16-22 / 122-305 ms | 72 / 95 ms | 71 / 251 ms |
| Scroll Mbit/s | 6.8-6.9 | 0.6-0.8 | 6.1 | 0.7 |
| Key alone | 14-17 / 105-817 ms | 10-11 / 142-551 ms | 54 / 162 ms | 58 / 77 ms |
| Key while scrolling | 41-44 ms | 24-31 ms | 63 ms | 75 ms |
| Text SSIM, black and coloured | 1.0 / 0.9999 | 0.9995 / 0.9893 | 1.0 / 0.9999 | 0.9995 / 0.9893 |
| Box cores, drag / watched idle | | | 0.7 / 0.1 | 0.3 / 0.3 |
| **CPU desktop** | | | | |
| Drag lag | 24-29 / 47-49 ms | 30-31 / 39-41 ms | 69 / 87 ms | 80 / 95 ms |
| Scroll Mbit/s | 6.8-7.0 | 1.8-1.9 | 7.0 | 1.8 |
| Key alone | 12 / 13-14 ms | 12 / 35-53 ms | 52 / 377 ms | 62 / 80 ms |
| Key while scrolling | 15-18 ms | 30-31 ms | 54 ms | 73 ms |
| Text SSIM, black and coloured | 1.0 / 0.9999 | 0.9998-0.9999 / 0.9977-0.998 | 1.0 / 0.9999 | 0.9995 / 0.9956 |
| Box cores, drag / watched idle | 0.2-0.7 / 0.1-0.5 | 0.6-0.7 / 0.5-0.7 | 0.3 / 0.1 | 1.2 / 0.4 |

No torn frames over VNC; 0.2% to 0.3% of drag frames over the GPU's video.
Video draws 60 frames a second, VNC about 105 to 110 updates.

- **NVENC is the closest to the pointer at the median**, 16 to 22 ms, and
  sends a ninth of VNC's bandwidth and under half of x264's. It uses a
  third of a core where x264 uses 0.6 to 1.2.
- **NVENC's video stalls once a run**, for 217 to 336 ms, with frames still
  coming every 16 ms but the picture falling up to 0.5 s behind. That is
  its p95. VNC on the same box had no such stall, and earlier NVENC runs
  at the same settings, when the GPU had more memory free, had a p95 of
  33 to 38 ms. It seems to follow the load of the GPU's other users.
- **Coloured text on dark is softer over NVENC's 4:2:0**, 0.989 against
  x264's 0.998 at 4:4:4. Black text on white is as sharp as x264's.
- **A watched desktop's video takes about 710 MiB of GPU memory** while it
  runs, freed when nobody watches. The GPUs had 680 to 960 MiB free during
  these runs, and a new GPU desktop needs 384 MiB. When NVENC cannot get
  the memory, Selkies falls back to x264 on the box's CPU.
- **Through the panel**, on the GPU desktop: VNC's first frame in 1.6 s,
  video's 0.45 s after the switch and 1.1 s after a reload, which keeps
  the choice. The person in control sees the box's pointer shape, and the
  plain cursor again at hand-back. Typed text, Shift, Enter and Ctrl+A
  reached Mousepad, and no key stayed down after hand-back. The desktop
  followed a viewer resized to 1280x800 in 0.5 s and back in 0.45 s, with
  Selkies retargeting its capture live, and took back 1920x1080 at
  hand-back. The clipboard was not checked: the panel's copy and paste use
  the viewer's own clipboard.

Recommendation: keep video by choice on GPU desktops, with VNC first.
VNC there is already close to video on a LAN, with sharper coloured text
and no stalls. Video is the better choice on a slow or metered link. Made
the default, every watched GPU desktop would take about 710 MiB of a GPU
that has less than that free, and could refuse new GPU desktops. Look again
when GPUs have more room, or if NVENC's stalls go.

## Limits

- Only the pool Mac is measured at 2x: Linux and Windows boxes run at 1x,
  and the Tart Mac's 1024x768 screen was measured at one pixel per CSS
  pixel (Chrome's page zoom at 50%) for the scene to fit.
- In the baselines, the wheel did not scroll the Tart Mac's page through
  VNC at all; in the later Tart run above it does, at 55 frames a second.
- The Wayland key times of 4 ms at the median are probably helped by the
  panel's lossless refresh, which asks for a frame soon after any change.
- The box CPU on the pool Mac is the whole Mac's, which other users share.
- Each figure is one run.
