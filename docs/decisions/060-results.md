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
- On the Tart Mac the wheel did not scroll the page through VNC at all.
- The Wayland key times of 4 ms at the median are probably helped by the
  panel's lossless refresh, which asks for a frame soon after any change.
- The box CPU on the pool Mac is the whole Mac's, which other users share.
- Each figure is one run.
