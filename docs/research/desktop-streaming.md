# Desktop streaming

How a box's desktop reaches you in BB, so that you can watch it, take control
and hand control back, with GPU-rendered apps and web profiling as the target
workloads.

Research, 30 September 2026: a note of what was known and measured then, not
the current design, which is in [the architecture](../architecture.md).
Settled by [007](../decisions/007-desktop-stream-is-a-typed-transport.md)
and [011](../decisions/011-interface-v1.md); its Selkies experiment is still
open.

Status: recommendation made, measurements pending (see Experiments). Checked
on 30 September 2026.

## Recommendation

1. **Model the desktop stream as a transport with a type.** A kind declares
   its stream type and port; the plugin relays one WebSocket per viewer to
   that port; the panel loads the client for that type. The core never names
   VNC, Selkies or a display server.
2. **First stream type: RFB (VNC) with noVNC.** Ship it with the first
   desktop template. It works with the GPU desktop that already runs (Xorg
   with the NVIDIA driver, served by `x0vncserver`), and RFB is also what a
   Windows VM, a Tart macOS VM and a physical Mac offer, so the same viewer
   covers every planned backend.
3. **Second stream type for Linux desktops: Selkies 2.0 over WebSockets.**
   Adopt it once the GPU experiment below passes. It sends H.264 (NVENC or
   x264) decoded by WebCodecs, bounds each viewer's backlog and resyncs on a
   keyframe, resizes the desktop to the panel, and has a two-way clipboard for
   text and images. Run it on Selkies' patched Xvfb, which keeps the screen on
   the GPU, so one GPU can serve several resizable desktops (see
   [the GPU in a desktop box](gpu-desktop.md)).
4. **Not now:** WebRTC (its media cannot pass through a plugin WebSocket
   route and would need UDP or TURN into the box network), KasmVNC (no GPU
   rendering on NVIDIA's driver), Neko, Sunshine and Guacamole.

## Requirements

| Requirement | Why |
| --- | --- |
| Reaches the browser through BB | BB's app talks only to the BB server; boxes sit on a private network behind the provider host |
| Low latency, no stale frames | You must see the app's current state after you or the agent act |
| GPU apps stay on the GPU | GPUI apps, WebGL, WebGPU and Chrome's compositor are the workloads |
| Resizes to the panel | A fixed 1920x1080 desktop in a small panel is hard to read |
| Several viewers, one controller | You may open a box in two tabs; the agent drives through computer use at the same time |
| Clipboard both ways | Copying logs, URLs and screenshots in and out |
| Works for Linux now, Windows and macOS later | Same viewer and control model on every backend |

## What BB's plugin API allows

- `bb.http.experimental_websocket(path, handler, { auth })` gives the plugin a
  WebSocket route at `/api/v1/plugins/<id>/http/<path>`. The handler sees the
  request URL and headers, so a query such as `?box=<id>` can select the box.
- Routes match the **exact path**; `:` and `*` are literal. The plugin cannot
  mount a box's web server under a prefix, so the viewer's client code must
  ship with the plugin (bundled in the panel, or served from a fixed list of
  routes).
- `auth: "local"` accepts requests from the BB app's own origin, which is what
  the panel needs.
- The plugin socket has `send`, `close` and `readyState` but no
  `bufferedAmount`, so the relay cannot see its own send backlog. The relay
  must stay a pass-through and leave flow control to the stream protocol end
  to end. A BB feature request for `bufferedAmount` would let the relay drop
  frames itself.
- Media is TCP only. There is no way to carry WebRTC's UDP through BB.

Sources: `bb-plugin-sdk.d.ts` 0.5.29; `apps/server/src/services/plugins/plugin-api.ts`
and `plugins/bb-guide/skills/bb-plugin-authoring/references/backend-events.md`
in BB's source.

## Options

| | noVNC with a VNC server | Selkies 2.0 (WebSockets) | Selkies 2.0 (WebRTC) | KasmVNC 1.5 |
| --- | --- | --- | --- | --- |
| Latest release | noVNC 1.7.0, April 2026; TigerVNC 1.16.2 | 2.0.0, 23 September 2026 | same | 1.5.0, 29 July 2026 |
| Licence | MPL-2.0 (noVNC), GPL-2.0 (TigerVNC) | MPL-2.0 | MPL-2.0 | GPL-2.0 |
| Through a plugin WebSocket | yes, RFB over WebSocket | yes, one port carries everything | no, media is UDP or TURN | yes, but its client is a full web app |
| Picture | JPEG or ZRLE rectangles; noVNC decodes H.264 (encoding 50) but TigerVNC does not send it | H.264, H.265, VP8, VP9, AV1, striped H.264 or JPEG | same codecs | WebP, JPEG, QOI; H.264, H.265, AV1 video mode new in 1.5 |
| Encoder | CPU | NVENC, VA-API or CPU (x264, OpenH264) | same | CPU, or NVENC or VA-API in 1.5 |
| GPU rendering on NVIDIA | yes, with Xorg and the NVIDIA driver, read back by `x0vncserver` | yes, with Xorg and the NVIDIA driver (NvFBC capture) or the patched Xvfb (DRI3 capture) | same | no: its DRI3 support covers open-source drivers only |
| Stale frames | none queued: RFB is pull based, the client asks for each update | per-viewer budget of 2 s of stream (at least 4 MiB), then drop and resync on a keyframe; clients acknowledge frames | TWCC congestion control, GOP purge | not documented |
| Resize | Xvnc yes; `x0vncserver` follows the X server's size but cannot change it | yes, RandR on Xorg or the patched Xvfb | yes | yes |
| Clipboard | text; `x0vncserver` only from TigerVNC 1.15 (Ubuntu 24.04 has 1.13.1) | text, images, formatted text | same | text, images (Chromium) |
| Several viewers | yes (shared sessions); view-only is client side only | one primary viewer; others join as view-only, enforced on the server | same | users with read or write permission |
| Windows and macOS | yes: every OS has a VNC server; Tart and macOS Screen Sharing speak RFB | Linux only | Linux only | Linux only |

Other candidates, briefly:

- **Neko**: WebRTC only, with good control handover, but the same UDP problem.
- **Sunshine and Moonlight**: native clients, not a browser.
- **Apache Guacamole**: a gateway that turns VNC or RDP into its own image
  protocol. Worth a look for Windows over RDP later, not needed now.

## Design

```
panel (BB app)                 BB server (plugin)                 box
noVNC or Selkies client  --ws-->  relay: /desktop?box=<id>  --tcp-->  VNC server or Selkies
                                  control filter per viewer
```

- **The backend** reports the box's address. **The kind** declares
  `stream: { type: "rfb" | "selkies", port }` and whether the stream can resize.
- **The relay** opens one TCP connection per viewer, copies bytes both ways
  and applies the control filter. It never decodes pixels.
- **The panel** picks the client by stream type: noVNC's `RFB` class, which
  takes any WebSocket URL, or the Selkies client (see Open questions).
- **Several viewers.** RFB: the VNC server runs shared. Selkies allows one
  primary viewer per display and closes the old one when a second connects,
  so the relay connects your first panel as primary and any other panel with
  `role=viewer`.

### Shared control filter

The agent never drives through the stream: it drives the desktop through
computer use inside the box. The stream's input is yours alone, and the relay
drops it unless you hold control.

| Stream | Dropped from a viewer without control |
| --- | --- |
| RFB | KeyEvent (4), PointerEvent (5), ClientCutText (6), xvp (250), SetDesktopSize (251), QEMU extended key event (255) |
| Selkies | text messages whose first comma-separated field is `kd`, `ku`, `kh`, `kr`, `m`, `m2`, `co`, `js`, `cw`, `cws`, `cwd`, `cwe`, `cb`, `cbs`, `cbd`, `cbe`, `cr`, `r`, `cmd` or `REQUEST_CLIPBOARD`; binary messages from the browser (microphone, webcam, file upload) |

The Selkies list follows Selkies' own `VIEWER_COLLAB_EXTRA_PREFIXES`
(keyboard, mouse and clipboard) plus resize and commands, which it keeps for
the primary viewer. Frame acknowledgements and keyframe requests always pass,
so flow control keeps working.

**Resolution lock.** Resizing changes the coordinates the agent is using. The
relay passes resize requests only while you hold control, and the box returns
to its default size when you hand back.

### Bounded backlog

- **RFB** asks for each update after drawing the last, so frames never queue.
  Under heavy motion the picture drops frames rather than falling behind.
- **Selkies** gives each viewer a budget of 2 seconds of stream (at least
  4 MiB). Past it, it drops the queued video and resumes from a keyframe,
  requested at most once a second. Keyframe requests from the client are
  allowed every 0.25 s, and one slow viewer cannot slow the others.
- **The relay** adds no queue of its own if it stays a pass-through; with
  `bufferedAmount` it could also drop frames when the BB server falls behind.

### GPU memory

Each NVENC session uses GPU memory, and a desktop already uses some (about
40 to 47 MiB for Xorg and 100 to 300 MB for Chrome's GPU process). Where other
workloads hold most of a GPU's memory, use x264 on the CPU by default and
NVENC as a per-kind option. Selkies falls back to software on its own when
NVENC fails.

## Experiments

On a Proxmox host with an NVIDIA GPU, inside the desktop container, with
`/dev/nvidia0`, `/dev/nvidiactl`, `/dev/nvidia-modeset` and the GPU's
`/dev/dri/renderD*` passed through:

1. **Patched Xvfb on the GPU.** Build XLibre 25.2.2 with Selkies' four
   patches (`addons/base/build-xvfb.sh`; it builds on Ubuntu 24.04 in about
   two minutes and produces one 2.9 MB binary). Start
   `Xvfb :98 -glamor -dri /dev/dri/renderD128 -verbose 1 +extension GLX +extension RANDR -s 0 -dpms -nolisten tcp`.
   Check the log for the EGL vendor and "screen pixmap on the GPU", then
   `glxinfo -B`, `vkcube`, `chrome://gpu` and GPUI `hello_world`.
2. **Resize and density.** `xrandr --fb 2560x1440` then back; start two
   instances on one GPU and record each one's memory with `nvidia-smi`.
3. **Selkies on it.** Install the 2.0.0 `.deb` for Ubuntu 24.04 and run it on
   `:98` with `--encoder=h264enc` (NVENC), then with software x264. Record
   frame rate, latency (the stats panel), CPU, GPU memory and bandwidth for
   an idle desktop, scrolling a long page, and a WebGL demo, at 1920x1080.
4. **noVNC baseline.** The same three workloads through `x0vncserver` and
   noVNC.
5. **Through BB.** A throwaway plugin with one WebSocket route relaying to
   the box. Compare latency and frame rate with a direct connection.

Local check already done: the patched Xvfb builds on Ubuntu 24.04, starts
without a GPU, and resizes with `xrandr --fb`, with two spare outputs for
extra displays.

## Open questions

- **Embedding the Selkies client.** Its page builds the socket URL from its
  own location (`<page directory>/api/websockets`) and takes a token as
  `?token=`. Either serve its built files from fixed plugin routes and show it
  in an iframe, or vendor the client into the panel and change how it builds
  the URL. Vendoring modified files means publishing them under MPL-2.0,
  which suits a published project. Try the iframe first.
- **Subprotocols.** Selkies sends a token from the page fragment as a
  WebSocket subprotocol, and Chrome fails the connection if the server does
  not echo it. Check whether BB's plugin WebSocket echoes subprotocols; if not,
  pass the token as `?token=`.
- **Throughput of the plugin route.** Unmeasured; experiment 5 answers it.

## Sources

- noVNC releases and `core/encodings.js`: https://github.com/novnc/noVNC
- Selkies 2.0.0 release notes: https://github.com/selkies-project/selkies/releases/tag/2.0.0
- Selkies source: `src/selkies/websockets_mode.py` (relay budget, supersede),
  `src/selkies/input_handler.py` (viewer allow lists),
  `addons/selkies-web-core/selkies-ws-core.js` and `lib/util.js` (socket URL),
  `addons/base/build-xvfb.sh`, `addons/base/patches/`, `addons/base/services/xvfb/run`
- KasmVNC releases and GPU docs: https://github.com/kasmtech/KasmVNC/releases,
  https://www.kasmweb.com/kasmvnc/docs/1.3.4/_sources/gpu_acceleration.md.txt
- TigerVNC releases: https://github.com/TigerVNC/tigervnc/releases
- Devin's Mac article (bounded frame backlog, keyframe resync)
