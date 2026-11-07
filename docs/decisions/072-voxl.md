# 072: voxl streams Linux X11 desktops, beside today's streamers, as an option the owner picks

Status: withdrawn by the owner, 7 November 2026. Unit V1 was built,
merged and then removed; its resize fix stays (see below). The rest of
this note is kept for the record, as it stood when V1 was built.

The owner tried voxl and chose not to keep it. On a LAN its gain over
Selkies was small: the same 60 frames a second, a few milliseconds less
latency, and somewhat less bandwidth and CPU. Its clearer gain, on a slow
link, did not outweigh one more streamer to build into every image, pin,
follow through frequent releases and keep working beside Selkies and VNC.
What V1 found and fixed stays: a video viewer's resize of a desktop whose
Xtigervnc owns its size now reaches it as SetDesktopSize, on Docker and
Proxmox LXC. V1's measurements and kit are in the history of PR 1390.

Extends [060](060-every-desktop-streams-as-video-through-one-viewer.md):
the panel keeps one video client and one viewer protocol, and voxl becomes
another server behind it. Extends
[056](056-linux-x11-desktops-add-a-selkies-stream-and-rfb-stays-for-the-rest-tuned.md):
an X11 desktop gains a third stream, beside its RFB server and Selkies, and
loses neither. Extends [029](029-configuration-is-one-checked-document.md):
the Docker and Proxmox LXC backends each gain one setting.

## Context

[voxl](https://github.com/tembo/voxl) streams an X11 display, a Mac's own
screen or a Windows desktop as H.264 over one WebSocket to a web client that
decodes with WebCodecs. It has input, the clipboard (text and PNG), desktop
audio, a microphone, file transfer and dynamic resolution. Its README
measures about 60 frames a second at 12 to 99 ms median latency on a VM
with no GPU, against under 8 for noVNC and 18 to 59 for Selkies on the
same links. Its code is MIT. It links x264, so a voxl binary is GPL-2.0.
bb-box ships no binary: images build it.

### The owner's direction

Given through the lead on 7 November 2026, while this note was written:

1. **Add voxl.** It sits beside today's streamers as an option the owner
   picks per backend, and per desktop in the viewer. It is never the
   default in this phase, even after its gate passes. Today's streamers
   stay exactly as they are.
2. **The owner tries it on production.** The lead deploys once V1's gate
   passes, and the owner says when.
3. **Only on the owner's word** does voxl become the default, and do the old
   streamers go, wherever voxl covers the kind: noVNC, wayvnc, x0vncserver,
   the Tart VNC holder and Selkies. That is a unit of its own.

### voxl, as read at v0.3.4

Read at tag v0.3.4 (commit 176f8be, 6 November 2026), the latest release.

- **One process per display.** It captures with MIT-SHM GetImage on any X
  server with DAMAGE and XFIXES, Xtigervnc and NVIDIA's Xorg included, and
  reads Xvfb's framebuffer in place only on Xvfb. A still screen costs
  nothing: it waits on damage events. With no viewer it encodes nothing.
- **x264 on the CPU only**, `ultrafast`, CRF 24, up to 30 Mbit/s, with its
  own rate control from each viewer's acknowledgements and pings, and a
  sharper repaint once the screen is still. Its README gives 1.3 to 1.7
  cores, X server included, for a busy 2560x1600 desktop. No GPU encoder.
- **X11 only on Linux.** Wayland is "being worked on".
- **Its protocol is its own**: binary messages with a type byte (video with
  a 16-byte header, Opus audio, the cursor's RGBA image, a PNG clipboard),
  JSON text from the server (`hello`, `ping`, `clip`, `close`), and short
  text commands from the viewer (`m`, `b`, `s`, `k`, `c`, `v`, `kf`, `a`,
  `po`, `sz`).
- **Every client may act.** Input, clipboard and resizes from any client
  reach the desktop, unless `--read-only` makes all of them watch. The
  clipboard goes to every client. Any client leaving releases every held
  key and button. Flow control is one decision for all clients: a slow
  one holds the frame rate of the others for up to 4 s.
- **It hides the X cursor** (XFixes) while it runs, and sends its image to
  viewers, who draw it. It never sends where the pointer is.
- **It follows the X screen's size**, resized by anyone, from RandR's
  events: a new `hello` and a key frame.
- **Sign-in**: a password from `--basic-auth-password`, `VOXL_PASSWORD` or
  made up, given as a link's `?token=`, Basic auth or a bearer token; off
  with `--enable-basic-auth=false`. It answers only for an IP address or
  `localhost`, and refuses an `Origin` other than its own page's.
- **Released as source only**: the release's one asset is the crate
  `voxl-server-0.3.4.crate`, SHA-256 `03609cf3…20e`. It builds with Rust,
  clang, pkg-config, esbuild and the -dev packages of x264, libyuv, Opus,
  PulseAudio and xcb, all in Ubuntu 24.04's archive: 28 s on 16 cores,
  a 25 MB binary.

## Decision

### 1. Each desktop, now and after

"Option" means the owner picks it per backend and per desktop. "Default"
comes only with phase 3.

| Desktop kind | Backends | Streams today | After V1 |
| --- | --- | --- | --- |
| `linux-desktop-cpu`, X11 on the CPU | Docker, Proxmox LXC | Xtigervnc (RFB, noVNC) and Selkies, video by default | voxl as an option, beside both |
| `linux-desktop`, X11 on a GPU | Proxmox LXC | x0vncserver (RFB) by default; Selkies with NVENC by choice | voxl as an option, beside both: x264 on the CPU |
| `linux-desktop`, X11 on a GPU | Docker | x0vncserver (RFB) only | voxl as an option, beside it |
| `linux-desktop-cpu` | Proxmox QEMU, microsandbox, boat.dev, Hetzner | RFB and Selkies | unchanged until V2 |
| `linux-arm64-desktop-cpu` | microsandbox, Tart, Hetzner | RFB and Selkies (by choice on Tart) | unchanged until V2 |
| `linux-desktop-wayland-cpu`, Sway | Docker, Proxmox LXC, Hetzner | wayvnc (RFB) and Selkies on Sway | keeps both: voxl is X11 only |
| `macos-desktop` | SSH host pool, Namespace | Screen Sharing (RFB) and bb-box-stream | unchanged until V4 |
| `macos-desktop` | Tart | Tart's VNC through bb-box's holder | unchanged until V4 |
| `windows-desktop` | Proxmox QEMU | QEMU's VNC and bb-box-stream.exe | unchanged until V5 |
| `windows-arm64-desktop` | Tart | QEMU's VNC, video from it by choice | unchanged until V5 |
| `ios`, `android` | all | bb-box's device servers | unchanged: not voxl's |

### 2. How voxl runs in a box

- **Built in the desktop images** from the pinned crate, as other artifacts
  are pinned: a `voxl` line in
  [desktop-pins.tsv](../../setup/proxmox-lxc/template/desktop-pins.tsv)
  with the release's URL and SHA-256, fetched by `fetch-artifacts.sh`.
  `customize-desktop.sh` builds it with `cargo build --release --locked`,
  so every crate is checked against voxl's `Cargo.lock`, with Rust 1.99.1
  from the pinned rustup in a toolchain it removes after. It installs
  `/usr/local/bin/voxl`, purges every package it installed to build it,
  and keeps the runtime libraries, installed with the desktop's own:
  libx264-164, libyuv0, libopus0, libpulse0 and libxcb1. The Docker and
  Proxmox LXC images share this script, so both get it.
- **Started on demand.** A launcher, `/usr/local/libexec/bb-box/voxl`,
  starts voxl as the box user when a viewer opens its display, and stops
  it once it has had no client for 60 s. On demand, because voxl hides the
  X cursor while it runs, which a VNC viewer of the same desktop would see.
- **Where**: display `:99`, the desktop's, on `127.0.0.1:5981` (Selkies is
  on 5980, VNC on 5900). Flags: `--addr=127.0.0.1 --port=5981
  --enable-basic-auth=false --enable-resize=false --audio-enabled=false
  --microphone-enabled=false --file-transfers=none`.

### 3. Sign-in and the path from the browser

voxl's sign-in is off, and it listens on the box's loopback only. The
browser never gets a voxl URL, port or token. It opens bb-box's `/desktop`
route on BB's server with `&stream=voxl`, as for Selkies, and BB has
signed it in. The relay reaches voxl through the box's command transport:
`docker exec` and socat on Docker, SSH on Proxmox LXC. It sends `Host:
localhost` and no `Origin`, which voxl's checks let through.

A per-session secret was not chosen: anything in the box can already
drive the desktop, as the agent does through Cua Driver, and the secret
would have to live in the box. Nothing outside the box reaches the port.

### 4. The relay translates voxl into the viewer's protocol

The panel keeps its one video client and its protocol, Selkies' subset
that bb-box-stream and the device servers speak too (060). A new relay,
`src/core/voxl.ts`, one per viewer connection, opens
its own WebSocket to the box's voxl and translates:

- **Video**: voxl's 16-byte header is rewritten in place to the panel's
  12-byte one, with the size from voxl's latest `hello`. Frame numbers are
  cut to 16 bits for the panel and put back for voxl's acknowledgements.
  The pixels are not decoded or copied.
- **Pacing stays voxl's.** The viewer acknowledges each frame as it draws
  it, as voxl's own client does, not every 50 ms, which voxl would read as
  queueing; and voxl's pings go to the viewer and its answers back, so voxl
  sees the whole round trip.
- **Control is the relay's.** From a viewer without control it passes only
  acknowledgements, video on and off, key frame requests and ping answers.
  Keys, the pointer, the wheel, the clipboard, and every binary message are
  dropped. The box's clipboard, text or PNG, goes only to the viewer with
  control, as with RFB and Selkies. On hand-back the relay releases what
  that viewer held.
- **Resize stays bb-box's.** voxl runs with resize off. The viewer's size
  goes to bb-box, which sets it through the backend (021), and voxl
  follows the X screen by itself.
- **The cursor**: voxl's RGBA image becomes the panel's cursor message, a
  PNG.

### 5. The agent's computer use

Computer use drives Cua Driver in the box, which reads windows and takes
its own screenshots through its own X connection; `box_record` records in
the box (059). Neither reads a stream, so voxl changes neither. Checked
live while a viewer watched through voxl: `computer_windows`,
`computer_launch`, `computer_screenshot`, `computer_observe`,
`computer_type` and `computer_act` each did what it says, and a
`box_record` clip showed the pointer where it was, though voxl hides the
X cursor while it runs.

People watching the agent see no pointer through voxl: it sends no
position, and draws none. Selkies draws it in. This stays an open
question for the owner's trial (see below).

### 6. GPU desktops

Today a Proxmox LXC GPU desktop streams RFB by default and Selkies with
NVENC by choice (#863); a Docker GPU desktop, RFB only. voxl on a GPU
desktop captures NVIDIA's Xorg with GetImage and encodes with x264 on the
box's CPU, taking cores from the box's own work. Its cost at 1920x1080 on
a CPU desktop was in 072's results: about a third of a core
for a busy screen. On a Proxmox LXC GPU desktop, voxl costs about 0.3 of a
core more than Selkies' NVENC, and the X server about 0.12 more, as voxl
reads the screen back; NVENC holds about 0.7 GiB more of the card's memory.
Both kept 60 frames a second.

### 7. The option, and how to turn it back

- **Per backend**: a setting on Docker (`voxl`) and on Proxmox LXC
  (`proxmox-lxc-voxl`), "Stream desktops with voxl", off by default. On,
  the viewer opens that backend's X11 desktops through voxl, where their
  image has it. Off, it opens them as today. Set on the backend's settings
  page, or `bb box backend set docker --field voxl=true`.
- **Per desktop**: the viewer's Display menu has **Stream with voxl**,
  ticked while voxl shows, on any desktop whose image has voxl, whatever
  the backend's setting. The tab remembers it for that box, as it does
  Show as VNC.
- **Back**: untick either. Nothing in a box changes: voxl stops by itself
  a minute after its last viewer.
- A desktop of an image built before voxl has no voxl display. The menu
  item is not shown and the setting does not reach it.

### 8. Audio

No X11 desktop has a sound server today, so V1 runs voxl with audio off.
V3 adds one (section [Units](#units)).

## Consequences

- The owner can try voxl on any new Docker or Proxmox LXC X11 desktop, by
  backend or by desktop, and go back at once.
- Desktop images grow by voxl's 25 MB binary and its libraries, and take
  about a minute more to build.
- An X11 desktop has three streams. The panel still has one video client.
- People watching the agent through voxl do not see its pointer.
- A voxl desktop's sound, files panel and microphone are not used yet.

## Open risks

- **One slow viewer slows the others** of a voxl desktop, up to 4 s, as
  voxl's flow control is one decision for all its clients.
- **Any viewer leaving releases held keys** in voxl, a watcher's too, while
  the viewer with control holds one.
- **The X cursor is hidden** while voxl runs: a VNC viewer of the same
  desktop sees none then, until voxl stops a minute after its last viewer.
- **voxl is new**: its first commit is from 12 October 2026, its first
  release from 21 October, and five releases came in the week to 6
  November. bb-box pins it, and checks its protocol again at each update.

## Questions for the owner's trial

1. Should a watcher see the agent's pointer through voxl? bb-box could
   follow the X pointer with a small helper, as bb-box-cursor does on Sway.
2. Should desktops have sound (V3)?
3. On GPU desktops, is x264 on the CPU acceptable, against Selkies' NVENC?

## Units

Each unit is delivered on origin/main with its gate. No unit makes voxl the
default.

| Unit | What | Gate |
| --- | --- | --- |
| V1 | Linux X11 desktops on Docker and Proxmox LXC: voxl in the images, the launcher, the relay, the setting, the viewer's menu item | Tests that fail on revert for each rule. Live, on a separate BB in a box with Docker inside it: input, clipboard both ways and a resize driven and seen; computer use on a voxl desktop; voxl against Selkies on the same desktop, frames a second, latency at p50 and p99, the box's CPU and bandwidth, for a scroll and a 1080p animation; the viewer at 390, 760 and 1440 px, light and dark. Proxmox LXC through the lead: a template built, and a desktop shown through voxl |
| Trial | The lead deploys; the owner tries voxl on production by backend or by desktop | The owner's word |
| V2 | The other Linux X11 backends (Proxmox QEMU, microsandbox, boat.dev, Hetzner) and arm64, with the same setting | voxl built for arm64 in the images; on each backend, a desktop shown and driven through voxl |
| V3 | Sound: a PulseAudio null sink in the X11 images, voxl's audio on, and Opus played in the viewer | Sound heard live in the panel; the sound server's idle CPU measured |
| V4 | macOS, beside bb-box-stream: voxl's ScreenCaptureKit capture on pool Macs, Namespace and Tart | 060's measures (lag, tearing, sharpness at 2x) against bb-box-stream; the permissions it needs, granted as 058 does |
| V5 | Windows, beside bb-box-stream.exe: voxl's Desktop Duplication on Proxmox QEMU and Tart | 060's measures against bb-box-stream.exe on the Basic Display adapter; built in the image with vcpkg |
| V6 | On the owner's word only: voxl the default where it covers the kind, then the old streamers removed there. Control and resizes move off the RFB display, which carries them today | Every gate above still passing, and the owner's word for each kind |
