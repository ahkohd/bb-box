# 056: Linux X11 desktops add a Selkies stream, and RFB stays for the rest, tuned

Status: accepted, 7 October 2026. Research only: nothing is built. Partly
supersedes [007](007-desktop-stream-is-a-typed-transport.md): Selkies
comes to X11 desktops on the CPU first, capturing their own X server, and
its GPU experiment gates only GPU desktops. Extends
[021](021-desktop-resize-through-the-backend.md): a Selkies display
resizes through its backend; and
[048](048-a-wayland-desktop-is-sway-with-floating-windows-streamed-by-wayvnc.md):
wayvnc's viewers ask for lighter pictures, and Selkies waits on Wayland.
Amended while its first step was built, 7 October 2026
([measured](../research/rfb-quality.md)): the compression level stays
noVNC's 2, as 9 saved under 2% of Xtigervnc's traffic and halved QEMU's
frames; and as wayvnc never sends a still area again, its viewers ask for
one losslessly once the screen is still.

## Context

People watch box desktops and take control of them a lot (#49), so
latency, picture quality, CPU in the box, and copy and paste matter. Every
desktop streams RFB today: the relay signs in to the box's VNC server and
copies bytes to noVNC in the panel, which asks for noVNC's defaults, JPEG
quality 6 and compression 2. Every viewer's stream crosses BB's server
(007).

[The research](../research/desktop-streaming.md) of 30 September chose
Selkies 2.0 over WebSockets as the second stream type for Linux, to be
measured first. This record measures it against RFB, as it is and tuned,
tries KasmVNC, and decides which desktop gets which stream.

### How it was measured

- **The server**: a `linux-desktop-cpu` box on Proxmox LXC, 4 cores and
  8 GiB, with its Xtigervnc 1.16.2 at 1920x1080 and Chrome 154 showing a
  test page in kiosk mode. Selkies 2.0.0, from its Ubuntu 24.04 package,
  captured the same X display with XShm and encoded H.264 with x264 at its
  defaults (8 Mbit/s, up to 240 frames a second), with resize off. noVNC
  1.7.0 reached Xtigervnc through websockify in the box.
- **The viewer**: a second box of the same kind on the same network,
  running headless Chrome 154 at 1920x1080 and decoding in software. It
  reached the server through a TCP forward, not through BB.
- **A constrained link**: 40 ms more round trip at the viewer (`netem`)
  and 20 Mbit/s out of the server (`tbf`), as from a home connection to a
  BB server far away.
- **Workloads**: an idle page; a long page of text scrolling at 0.6 px a
  millisecond, about 10 px a frame; and a full-screen canvas drawing 40
  circles each frame.
- **Measures**:
  - frames a second the viewer drew: for noVNC, animation frames in which
    its canvas changed; for Selkies, its client's own count;
  - key to screen: the viewer sends a key through its client, the page
    toggles a 200 px square, and the viewer reads the pixel each
    millisecond until it changes. The median of 15, with the range;
  - CPU of each process in the server box, in % of one core, and the
    bytes it sent.

### What it found

On the same network, 1920x1080:

| Workload | Stream | Frames/s | Key to screen, ms | CPU: Xtigervnc, selkies | Mbit/s |
| --- | --- | --- | --- | --- | --- |
| Idle | RFB | 0 | 17 (16 to 19) | 0, - | 0 |
| Idle | Selkies | 60 | 15 (14 to 22) | 3, 19 | 0.2 |
| Scroll | RFB as today (quality 6, compression 2) | 60 | 83 (67 to 97) | 40, - | 179 |
| Scroll | RFB, quality 2, compression 9 | 60 | 53 (42 to 62) | 40, - | 77 |
| Scroll | RFB, quality 0, compression 9 | 59 | 47 (40 to 61) | 39, - | 46 |
| Scroll | Selkies | 62 | 53 (35 to 60) | 7, 29 | 4.1 |
| Animation | RFB as today | 58 | 88 (83 to 104) | 50, - | 53 |
| Animation | Selkies | 62 | 72 (64 to 91) | 7, 32 | 8.9 |

Xtigervnc is also the X server, so it works while Selkies streams too.
websockify, which stood in for the relay's route, took 3 to 5% for RFB.
Chrome, the workload, took up to 2 cores.

With 40 ms more round trip, and then also 20 Mbit/s:

| Link | Workload | Stream | Frames/s | Key to screen, ms | Mbit/s |
| --- | --- | --- | --- | --- | --- |
| +40 ms | Scroll | RFB as today | 59 | 101 (86 to 116) | 179 |
| +40 ms | Scroll | RFB, quality 2, compression 9 | 58 | 66 (64 to 70) | 70 |
| +40 ms | Scroll | Selkies | 61 | 69 (67 to 90) | 2.4 |
| +40 ms, 20 Mbit/s | Scroll | RFB as today | 6 | 257 (217 to 421) | 18 |
| +40 ms, 20 Mbit/s | Scroll | RFB, quality 2, compression 9 | 13 | 215 (143 to 230) | 18 |
| +40 ms, 20 Mbit/s | Scroll | Selkies | 62 | 86 (81 to 104) | 3.8 |
| +40 ms, 20 Mbit/s | Animation | RFB, quality 2, compression 9 | 29 | 214 (130 to 262) | 13 |
| +40 ms, 20 Mbit/s | Animation | Selkies | 62 | 105 (100 to 123) | 8.3 |

On a `linux-desktop-wayland-cpu` box (048): Sway with pixman, wayvnc 0.7.2
at 60 frames a second, a 1024x768 screen, Chrome on Wayland:

| Link | Workload | Stream | Frames/s | Key to screen, ms | CPU: wayvnc | Mbit/s |
| --- | --- | --- | --- | --- | --- | --- |
| Same network | Idle | RFB as today | 0 | 4 (4 to 113) | 0 | 0 |
| Same network | Scroll | RFB as today | 59 | 88 (81 to 99) | 14 | 102 |
| Same network | Scroll | RFB, quality 2, compression 9 | 60 | 84 (73 to 94) | 13 | 75 |
| +40 ms, 20 Mbit/s | Scroll | RFB as today | 10 | 232 (227 to 236) | 5 | 16 |
| +40 ms, 20 Mbit/s | Scroll | RFB, quality 2, compression 9 | 13 | 202 (186 to 206) | 5 | 16 |

With quality 2 noVNC counted 69 frames a second; wayvnc sends at most 60,
so some updates were drawn over two frames.

Findings:

- **On a constrained link, only Selkies keeps up.** RFB asks for each
  update after drawing the last, and an update of scrolling text in JPEG
  fills most of the link, so it fell to 6 to 13 frames a second and a
  quarter of a second from key to screen. Selkies stayed at 62 frames a
  second and 86 to 105 ms.
- **Tuning RFB helps everywhere but does not fix that.** Quality 2 and
  compression 9 cut the bandwidth of scrolling 2.3 times and key to screen
  on the same network from 83 to 53 ms, with no more CPU. On the
  constrained link it doubled the frames, still at about 215 ms. wayvnc
  gained less: 102 to 75 Mbit/s, and 10 to 13 frames on the constrained
  link.
- **Picture quality was not scored.** Both refresh a still picture: TigerVNC
  sends lossy areas again losslessly once they stop changing (its encode
  manager's lossless refresh), and Selkies repaints a still screen at a
  higher quality (`--use-paint-over-quality`, on by default). Whether
  wayvnc does is not known.
- **Selkies costs CPU while watched, even when nothing moves.** With a
  viewer it captures at 60 frames a second: 19% of a core idle, against
  none for Xtigervnc. In motion it cost less than Xtigervnc's encoding:
  29 to 32% against 40 to 50%.
- **BB's server carries every viewer's stream.** One viewer of scrolling
  text is 179 Mbit/s through it with RFB today, 77 tuned and 4 with
  Selkies.
- **Selkies cannot stream Sway as it runs.** On Wayland Selkies runs its
  own compositor and captures that. Given Sway as the host display, it
  sends input and the clipboard to Sway but captures its own empty screen.
  Sway would have to run nested in Selkies' compositor, which 048's
  display unit does not do and this research did not try.
- **KasmVNC could not be measured here.** Its 1.5.0 package's install
  script failed on the template, on a conflict with TigerVNC's
  `vncserver`. Its `Xkasmvnc` ran on a second display, and its own client
  connected at 1920x1080, but Chrome drew mostly black there and no key
  reached the page, from its client or from `xdotool`.
- **Copy and paste**: Selkies moves text, images and formatted text both
  ways. RFB moves text: TigerVNC and wayvnc in the stream, and bb-box with
  commands for Tart's macOS and Windows.

### The other desktops, from their code and documentation

- **Windows**, on Proxmox and on a Mac, is QEMU's VNC server. It answers
  each request as Xtigervnc does, but sends JPEG only with its `lossy=on`
  option, off by default (`ui/vnc.c`): without it, a viewer's JPEG
  quality changes nothing, and only compression applies. bb-box writes
  QEMU's command line on a Mac; Proxmox writes its own. Not measured.
- **macOS on Tart** goes through bb-box's holder, which asks Tart for raw
  pixels and sends every viewer Zlib at level 1 whatever the viewer asks.
  It sends each update as it comes and closes a viewer only when 64 MiB
  wait for it: on a 20 Mbit/s link, about 27 s of stale screen. The
  panel's tuning does not reach it.
- **macOS on a pool's Mac** is Screen Sharing, whose encodings were not
  checked.
- Selkies and KasmVNC are Linux only.

## Decision

**RFB stays the stream of every desktop, and the panel asks for lighter
pictures.** noVNC in the panel asks every RFB display for JPEG quality 2
and compression 9. If side-by-side screenshots in its PR show moving text
too soft to read, it asks for 4 instead.

**Linux X11 desktops add a Selkies display.** On `linux-desktop-cpu` and
`linux-desktop`, wherever they are offered (Proxmox LXC, Docker,
microsandbox), Selkies 2.0, pinned, captures the desktop's own X server
beside its RFB server:

- on the CPU with XShm and x264, as measured;
- on the GPU with NVENC, and NvFBC capture where the GPU allows it, once
  step 3 of the plan has measured it. Until then GPU desktops have RFB
  only. Selkies' patched Xvfb is not needed.

The box's Selkies:

- listens on 127.0.0.1 in the box, with its own sign-in off: the relay
  reaches it through the box's command transport, as it reaches VNC, and
  BB has signed the viewer in;
- runs with resize off, sharing on, H.264, and audio, file transfers,
  printing and gamepads off;
- runs with the desktop if it costs nothing with no viewer, which its
  template PR measures. Otherwise its display's `open()` starts it, and it
  stops once `GET /api/sessions` has listed no page for 60 s.

**The panel picks the stream.** It opens a box's Selkies display where the
box has one and the browser has WebCodecs, which needs a secure context,
and RFB otherwise, or when Selkies fails to open. Viewers of either stream
can watch one box at once, and control is one per box across both. The
agent's computer use does not change.

**The relay carries Selkies message by message.** For a Selkies display:

- The viewer connects to the same `/desktop` route. BB's plugin WebSocket
  keeps text and binary messages apart (`string | Uint8Array`), which
  Selkies needs.
- The relay opens the display's route and speaks WebSocket to Selkies over
  it: undici's WebSocket, which the Proxmox console's route already uses,
  with a connector that opens the route, or a small client over the
  route's bytes. It passes each message as it is and never decodes
  video.
- Each viewer is a Selkies page of its own. Selkies encodes once per
  display and sends each page what its link carries, from that page's
  acknowledgements, resyncing it from a key frame at most once a second,
  or from a reference frame with NVENC. Flow control stays end to end, so
  the relay needs no `bufferedAmount`
  ([BB request 2](../bb-requests.md#2-send-backlog-on-plugin-websockets)),
  and a slow viewer does not slow the others.
- **Control.** With sharing on, Selkies lets every page drive input, so
  the relay decides. From a viewer without control it drops text messages
  whose first comma-separated field is a key, pointer, clipboard, resize,
  setting or command message, starting from the
  [research's list](../research/desktop-streaming.md#shared-control-filter)
  and checked against the pinned version's input handler, and every binary
  message, such as uploads and the microphone. Acknowledgements, key frame
  requests and statistics always pass. On hand-back it releases held keys
  and buttons, as for RFB.
- **Resize.** Selkies, with resize on, sizes the display to its first
  page; bb-box sizes it to the viewer with control instead. So Selkies
  runs with resize off, and the relay calls the display's `resize()`
  (021) with that viewer's size, `xrandr` on the X server, and sets the
  agent's size on hand-back. Other viewers scale.
- **No token and no subprotocol**: the relay is the only client of the
  box's Selkies.

**The client** is Selkies' web core (`selkies-core.js`, MPL-2.0),
vendored into the panel at the pinned version, with its socket URL pointed
at the relay, as noVNC is. The panel draws its video and keeps its own
control bar. Changed files are published under MPL-2.0 with the
repository. Selkies' own page, served on exact plugin routes in a frame,
is the fallback.

**Wayland stays on wayvnc, tuned.** Selkies on Wayland waits for a spike
with Sway nested in Selkies' compositor, checking Cua, resize and CPU.

**macOS and Windows stay on RFB.**

- **The Tart holder is paced by each viewer.** It keeps the screen and
  what changed, and sends a viewer an update only when that viewer has
  asked, with all it missed merged, so a slow viewer gets fewer frames
  that are current rather than a queue. JPEG in the holder, which has only
  Python 3.9's standard library on the Mac, would need a small Swift
  helper, and waits for a measurement of the paced holder.
- **Windows on a Mac** gets `lossy=on` on QEMU's `-vnc`, so the panel's
  tuning reaches it. **Windows on Proxmox** keeps lossless Tight: its
  console's options are Proxmox's, and only compression 9 applies. A
  better Windows stream, such as RDP through a gateway or an H.264 server
  in the guest, would be a decision of its own.

**Not adopted:**

- **KasmVNC**: it replaces the X server with its own, its client is a
  bundle the panel cannot import, it is GPL-2.0, it does not render on
  NVIDIA's driver (the research), and it neither installed cleanly nor
  drew the test page here. Its H.264 mode needs its client.
- **WebRTC**, Selkies' or any: its media needs UDP or TURN, and BB's
  plugin WebSocket carries TCP only. Selkies' WebSockets transport carries
  the same codecs.

## Consequences

- On a slow link a person sees about 60 frames a second and about 0.1 s
  from key to screen on X11 desktops, against 6 to 13 frames and a quarter
  of a second with RFB.
- BB's server carries 4 to 9 Mbit/s for each viewer of a moving X11
  desktop, against up to 179 today.
- Images and formatted text paste both ways on X11 desktops through
  Selkies.
- X11 desktop templates and images grow by 283 MB, Selkies installed from
  a 62 MB package.
- A watched X11 desktop costs about a fifth of a core in Selkies even when
  nothing moves.
- X11 desktops run two stream servers, the panel two clients, and the
  relay two protocols.
- Wayland, macOS and Windows desktops gain the tuning only, and Windows
  on Proxmox its compression only. Tart's macOS desktops stop falling
  seconds behind on a slow link.

## Open risks

- **The GPU.** NVENC and NvFBC in an LXC box, their GPU memory, and
  several desktops on one GPU are not measured.
- **Through BB.** Neither stream was measured through BB's server and the
  relay, nor is the largest message BB's plugin WebSocket takes known; a
  key frame can be a few hundred KB.
- **Picture quality** was not scored for either stream.
- **Selkies 2.0 is new**, released on 23 September 2026. bb-box pins it
  and checks its input messages again at each update.
- **The control filter** is now all that stops a viewer without control
  from driving a Selkies desktop. The conformance suite checks it.

## Plan of PRs

1. **The panel's tuning**: quality 2 and compression 9 for RFB displays,
   with screenshots of still and moving text at 2, 4 and 6; and
   `lossy=on` for QEMU on a Mac, measured there.
2. **The Tart holder's pacing**, with tests against the fake Mac, then
   measured on a Mac through a shaped link.
3. **Selkies on the GPU**: on a `linux-desktop` box, NVENC with NvFBC or
   XShm, measured as above, with GPU memory and two desktops on one GPU.
4. **Templates and images**: Selkies, pinned, in the X11 desktops'
   customize script, its unit and settings, its CPU with no viewer, its
   start time, and the idle stop if needed; the Docker images.
5. **Core**: the Selkies relay, with the message bridge, control filter,
   resize and release, tested against a fake Selkies.
6. **The panel**: the vendored client, and the choice of stream.
7. **Conformance**: a Selkies display's first frame, a key reaching the
   box, a resize, and input dropped from a viewer without control.
8. **Through BB**: both streams measured through the relay on a live BB,
   on the same network and on a constrained link.
9. **Docs**, with each PR.

Later: Selkies on Wayland with Sway nested; JPEG in the Tart holder; a
better Windows stream.
