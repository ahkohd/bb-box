# 072 results: voxl against today's streamers, unit V1

Measured on 7 November 2026, for [072](072-voxl.md). The kit, the raw
runs and the screenshots are in [072-voxl/v1](072-voxl/v1/README.md).

## How it was measured

- **The BB**: a fresh `npx bb-app` 0.48.1 with no account, in a Linux box
  with 16 cores and 32 GiB, with bb-box installed from this unit's branch
  and the Docker backend on the box's own Docker.
- **The desktop**: a `linux-desktop-cpu` box at its default size, 4 cores
  and 8 GiB, from `setup/docker/build.sh desktop` on this branch:
  Xtigervnc 1.16.2 at 1920x1080, Selkies 2.0.0 as today, and voxl 0.3.4
  with the launcher's flags. voxl chose 1 encoder thread, its default for
  4 cores.
- **The viewer**: headless Chromium 158 on the same box, running the
  panel's own clients through BB's server and bb-box's relay: the video
  client for voxl and Selkies, and noVNC 1.7 at the panel's quality 2 and
  compression 2 for today's VNC. Its window was 1920x1080, and it watched
  without control.
- **The workloads**, in Chrome in kiosk mode on the desktop: a long page
  of text scrolling 10 px a frame, and a full-screen 1080p animation of 40
  circles over a changing background. Chrome drew both at 60 frames a
  second in every run.
- **The measures**: each frame draws the time as a block pattern at its top
  left. The viewer reads it from each frame it draws, so frames a second
  count new pictures, and latency runs from the content being drawn to the
  frame being drawn in the viewer, on one clock. Bandwidth is what the
  viewer's WebSocket received. CPU is each process's time in the desktop's
  container, in cores; for noVNC the encoder is the X server.
- **The links**: LAN is everything on one host, with no network between
  them. The slow link is a bottleneck between the viewer and BB's server:
  10 Mbit/s with a deep queue, and 20 ms each way, 40 ms round trip, as
  voxl's own benchmark shapes it.
- **Runs**: 3 runs of 20 s for each stream, workload and link, the streams
  taking turns, after 4 s of watching. Each cell gives the median and the
  range.

## Results

Scroll, LAN:

| Stream | Frames/s | Worst second | Latency p50, ms | Latency p99, ms | Longest gap, ms | Mbit/s | Streamer, cores | X server, cores |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| voxl | 60.0 (59.9 to 60.0) | 59 | 33 (32 to 49) | 39 (38 to 55) | 34 | 3.5 (3.4 to 3.5) | 0.32 (0.29 to 0.34) | 0.07 |
| Selkies | 58.8 (58.6 to 59.0) | 55 | 40 (39 to 56) | 52 (50 to 68) | 43 | 6.8 (6.6 to 7.4) | 0.41 (0.40 to 0.42) | 0.07 |
| noVNC on Xtigervnc | 49.0 (48.2 to 52.7) | 37 | 69 (52 to 80) | 120 (92 to 120) | 70 | 134.8 (132.5 to 144.9) | in the X server | 0.60 (0.59 to 0.62) |

1080p animation, LAN:

| Stream | Frames/s | Worst second | Latency p50, ms | Latency p99, ms | Longest gap, ms | Mbit/s | Streamer, cores | X server, cores |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| voxl | 60.0 (59.9 to 60.0) | 59 | 16 (15 to 16) | 22 (20 to 23) | 30 | 5.2 (5.1 to 5.2) | 0.31 (0.30 to 0.32) | 0.06 (0.06 to 0.07) |
| Selkies | 58.0 (57.5 to 59.0) | 53 | 38 (37 to 53) | 50 (48 to 69) | 39 | 6.4 (6.4 to 6.5) | 0.37 (0.36 to 0.37) | 0.07 (0.06 to 0.07) |
| noVNC on Xtigervnc | 60.0 (59.8 to 60.0) | 58 | 35 (32 to 47) | 45 (41 to 55) | 33 | 15.4 (15.3 to 15.4) | in the X server | 0.21 (0.21 to 0.25) |

Scroll, 10 Mbit/s and 40 ms round trip:

| Stream | Frames/s | Worst second | Latency p50, ms | Latency p99, ms | Longest gap, ms | Mbit/s | Streamer, cores | X server, cores |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| voxl | 60.0 (59.9 to 60.0) | 59 | 58 (58 to 59) | 65 (64 to 67) | 32 | 3.4 | 0.29 (0.28 to 0.30) | 0.07 (0.06 to 0.07) |
| Selkies | 58.7 (58.5 to 59.7) | 33 | 89 (70 to 91) | 577 (427 to 671) | 277 | 6.4 (5.8 to 6.7) | 0.40 (0.39 to 0.40) | 0.07 |
| noVNC on Xtigervnc | 3.6 (3.5 to 3.6) | 3 | 341 (331 to 384) | 636 (610 to 771) | 324 | 9.3 (9.2 to 9.4) | in the X server | 0.35 (0.35 to 0.40) |

1080p animation, 10 Mbit/s and 40 ms round trip:

| Stream | Frames/s | Worst second | Latency p50, ms | Latency p99, ms | Longest gap, ms | Mbit/s | Streamer, cores | X server, cores |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| voxl | 59.9 (59.9 to 60.0) | 59 | 45 (44 to 78) | 53 (52 to 87) | 31 | 5.2 (5.1 to 5.2) | 0.31 (0.30 to 0.36) | 0.08 (0.07 to 0.08) |
| Selkies | 58.5 (58.3 to 59.8) | 55 | 68 (67 to 68) | 79 (79 to 80) | 41 | 6.4 (6.4 to 6.5) | 0.36 (0.35 to 0.37) | 0.08 (0.07 to 0.08) |
| noVNC on Xtigervnc | 39.8 (39.6 to 39.9) | 34 | 101 (99 to 107) | 129 (125 to 138) | 100 | 10.0 | in the X server | 0.49 (0.43 to 0.50) |

Idle, one viewer watching a still page for 15 s:

| Stream | Streamer, cores | X server, cores | Mbit/s |
| --- | --- | --- | --- |
| voxl | 0.00 | 0.00 | 0 |
| Selkies | 0.29 | 0.03 | 0.02 |
| noVNC on Xtigervnc | in the X server | 0.00 | 0 |

## What it shows

Against Selkies, voxl is:

- **better on latency**: 7 ms lower at the median on the scroll and 22 ms
  on the animation on LAN, and 23 to 31 ms on the slow link;
- **better on the slow link's worst moments**: Selkies' scroll had seconds
  of 33 frames and gaps of 277 ms, a p99 of 577 ms; voxl's worst second
  was 59 and its longest gap 32 ms;
- **cheaper**: about half the bandwidth (3.4 to 5.2 Mbit/s against 6.4 to
  6.8), 0.05 to 0.11 of a core less while busy, and nothing while the
  screen is still, against 0.29 of a core;
- **the same** in frames a second on LAN, both near 60.

Against noVNC, today's fallback, voxl is better on every measure but the
CPU of a still screen, where both cost nothing. On the slow link noVNC
fell to 3.6 frames a second on the scroll.

Not shown by these figures:

- **Picture quality** was not scored. voxl sends half Selkies' bits, in
  4:2:0, and sharpens a still screen at CRF 16; Selkies sends 4:4:4 where
  the viewer decodes it.
- **A stall**: in a first batch before these, one voxl run of the
  animation stopped for 1.9 s once. It did not happen in that batch's other
  8 voxl runs, nor in the 13 here.
- **Several viewers**, **a GPU desktop** and **Proxmox LXC** were not
  measured. voxl's flow control is one decision for all its viewers.

## Live checks

On the same BB, through the panel's desktop view, with the Docker
backend's voxl setting on:

| Check | Result |
| --- | --- |
| The setting | Off, the desktop state listed Selkies then voxl; `bb box backend set docker --field voxl=true` listed voxl first, for a box already running, with no restart |
| The stream | The viewer opened `&stream=voxl`, and drew 1920x1080 |
| The menu | **Stream with voxl** under **Display**, ticked |
| Pointer and keys | A click at 600,450 put the box's pointer at 600,450; typed text reached an xterm in the box and was written to a file |
| Clipboard, box to browser | Text copied in the box reached the browser's clipboard |
| Clipboard, browser to box | **Paste from this computer** put the text on the box's clipboard and pasted it at Mousepad's cursor, after a typed word |
| Resize | Narrowing the browser set the box's screen to 856x726, and voxl's picture followed; widening it set 1120x906 |
| Wheel | The wheel scrolled an xterm's text |
| Hand back | The agent had control again, and the viewer stayed on voxl |
| The agent's tools | `computer_windows`, `computer_launch`, `computer_screenshot`, `computer_observe`, `computer_type` and `computer_act` worked while voxl streamed the desktop; Mousepad showed the agent's text |
| `box_record` | A clip made while voxl ran showed the pointer where it was |
| voxl's own start and stop | voxl answered 131 ms after the launcher was asked, and stopped 56 s after its last viewer |
| The image's probe | `voxl-probe.mjs`, which the desktop check runs, got a hello at 1920x1080 and 4 frames in 3 s of a still screen |

The panel's screenshots at 1440, 760 and 390 px, light and dark, are in
`072-voxl/v1/shots`: for example [the Display menu at 1440 px](072-voxl/v1/shots/viewer-menu-1440-light.png),
[at 390 px, dark](072-voxl/v1/shots/viewer-menu-390-dark.png), and [the
Docker backend's setting](072-voxl/v1/shots/settings-docker-1440-light.png).

## Cost

- **Image size**: voxl's 25 MB binary and about 3 MB of libraries it runs
  with. The build installs 20 more packages, 48.5 MB (esbuild, the x264,
  libyuv, Opus and PulseAudio headers, and the GLib development packages
  those bring), and purges them once voxl is built; libclang, pkg-config
  and the xcb headers were in the image already, for GPUI. The Docker
  desktop image is 6.81 GB.
- **Build time**: about a minute more: 12 s for the Rust toolchain and
  45 s to compile on 16 cores.
- **Risk**: voxl is four weeks old and released five times in its last
  week; bb-box pins it, and its protocol with it. Its binary is GPL-2.0
  through x264. It hides the X cursor while it runs, so a VNC viewer of the
  same desktop sees none until voxl stops.

## Not measured

- Proxmox LXC: its template is built by the same script; the lead builds
  one on the node.
- A GPU desktop: x264's cost there, against Selkies' NVENC.
- Wayland desktops: voxl streams X11 only.
- macOS and Windows: voxl runs there, but V1 does not build it for them.
