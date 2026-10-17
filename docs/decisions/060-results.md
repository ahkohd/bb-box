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
  runs, though frames came. In the VM, ScreenCaptureKit reported most
  frames after a key in Chrome as unchanged, while a screenshot showed the
  change. Keys while scrolling showed, as the page changed anyway. TextEdit
  and Safari are not affected: frames come 15 to 40 ms after each key. VNC
  reads the VM's screen from outside it, so it is not affected. Not yet
  known: why, and whether a pool Mac's Chrome escapes it only because the
  Mac has a GPU of its own.
- **The wheel** scrolls through the stream, in Chrome and in Safari.
- **Through the panel:** the box opens as video. Show as VNC and back,
  control, typing with Shift and Cmd+S, the wheel, and pasting both ways
  work.

## Corrected, 17 October 2026

The drag lags first given here for VNC were wrong, as were those in 056's
comparison. The analyser looked for the block's starting place in the 2 s
before the drag, and a VNC server sends no frames while the screen is
still, so it matched each VNC frame against the wrong place: about 250 ms
at the median and 1.4 s at the 95th percentile, on every platform. It now
takes the last frame before the drag, however old, or the scene's own
place. The lags above are recomputed from the same runs; nothing else
changed.

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
