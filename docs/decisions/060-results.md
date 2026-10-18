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
