# 060: Every desktop streams as video through one viewer

Status: accepted, 17 October 2026. The baselines are in
[060 results](060-results.md); the streams are not built yet.

## Context

The owner will spend most of their time in box desktops, and wants them
smooth and sharp on every platform. Today each platform streams its own
way ([architecture](../architecture.md#desktops-and-control)):

| Desktop | Server | Stream | What the owner sees |
| --- | --- | --- | --- |
| Linux X11 | Xtigervnc, and Selkies 2.0 beside it | H.264 video by default ([056](056-linux-x11-desktops-add-a-selkies-stream-and-rfb-stays-for-the-rest-tuned.md)) | smooth, but pixelated text |
| Linux Wayland | wayvnc 0.7.2 on Sway ([048](048-a-wayland-desktop-is-sway-with-floating-windows-streamed-by-wayvnc.md)) | RFB | 60 fps through the relay; VNC's drag lag |
| macOS, pool Mac | Screen Sharing over SSH ([047](047-a-physical-mac-is-an-ssh-pool-machine-lent-with-a-new-user-at-its-console.md)), 2x with an HDMI dummy plug | RFB, ZRLE | sharp, but tears: a frame comes as many rectangles, at 4x the pixels |
| macOS, Tart VM | the Virtualization framework's VNC, through a holder (#430) | RFB | as above, at 1x |
| Windows on Proxmox | QEMU's VNC through Proxmox's `vncwebsocket` | RFB | WARP, no GPU; VNC's drag lag |
| Windows on a Mac | QEMU's VNC on the Mac's loopback (`virtio-gpu-pci`, `lossy=on`) | RFB | as above |

Through BB's server, video already beat VNC on Linux: a dragged window
trailed the pointer by about 20 ms at the median, against about 200 ms
for VNC, and keys were as quick (056's comparison). The rest of a drag's
lag is BB's server stalling, which no stream can fix (request 25 in
[What bb-box asks of BB](../bb-requests.md)).

Every desktop must still work for the agent: computer use drives each one
through the Cua Driver in the box, which reads windows and takes its own
screenshots, and `box_record`
([059](059-agents-record-their-desktop-box-with-box-record.md)) records in
the box. Neither reads the viewer's stream, so a new stream changes
neither.

## What was looked at

| Option | Platforms | What it gives | Licence | Verdict |
| --- | --- | --- | --- | --- |
| [Selkies 2.0](https://github.com/selkies-project/selkies) with [pixelflux](https://github.com/selkies-project/pixelflux) | Linux only, X11 or its own Wayland compositor (Smithay, labwc) | H.264 or AV1 or VP9 over WebSockets or WebRTC; 4:4:4 with x264, x265 or NVENC (`video_fullcolor`) | MPL-2.0: we ship it | keep for Linux, tuned |
| [noVNC](https://github.com/novnc/noVNC) 1.6+ with RFB Open H.264 | any RFB server that sends it | H.264 inside VNC, decoded with WebCodecs | MPL-2.0 | useful where the server sends it |
| QEMU VNC Open H.264 ([patch series](https://patchew.org/QEMU/20250430072524.3650582-1-dietmar@proxmox.com/20250430072524.3650582-4-dietmar@proxmox.com/), Proxmox, April 2025) | QEMU VMs | x264 or a hardware encoder through GStreamer, on the host | GPL-2.0, in QEMU | not merged as of v5; check Proxmox's own QEMU |
| Apple's [High Performance Screen Sharing](https://support.apple.com/guide/remote-desktop/use-high-performance-screen-sharing-apdf8e09f5a9/mac) | macOS 14+, Apple silicon at both ends | HEVC RExt 4:4:4 over UDP and SRTP | closed, undocumented; clients such as [pippin](https://github.com/jonesy827/pippin) and [iShareScreen](https://github.com/madmalkav/iShareScreen) are reverse-engineered | drop: no browser decodes it, and a macOS update may break it |
| ScreenCaptureKit, VideoToolbox H.264, WebSocket or WebRTC: [mac-screen-cast](https://crates.io/crates/mac-screen-cast), [HoppScreen](https://github.com/Rakesh717/HoppScreen) | macOS | whole frames, hardware H.264, 30 to 60 ms on a LAN by their own measure | Apple's APIs; examples only | build our own, small |
| [Sunshine](https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2configuration.html) and Moonlight | Linux, Windows, macOS 14.2+ | game streaming, low latency | GPL-3.0; Moonlight's protocol, no maintained browser client | drop: licence and no browser client |
| RustDesk | all | its own protocol and web client | AGPL-3.0 | drop: licence |
| neko | Linux, X11 | WebRTC | Apache-2.0 | drop: no more than Selkies gives |
| SPICE, spice-html5 | QEMU | QXL or virtio-gpu, JPEG and LZ | LGPL | drop: no better in a browser |
| DXGI Desktop Duplication, and Windows.Graphics.Capture | Windows | whole frames from DWM; [reported working](https://github.com/go-mswin/screencapture) on Microsoft's Basic Display driver in a GPU-less QEMU VM, but often refused over RDP or in session 0 | Microsoft's APIs | build our own, small |
| OpenH264, Media Foundation's software H.264 | Windows, no GPU | software H.264 | OpenH264: BSD, with Cisco's patent-licensed binary | the encoder for Windows |

Measured on 16 October 2026: headless Chrome 155 on Linux, in a
linux-desktop-cpu box, said through `VideoDecoder.isConfigSupported` at
3840x2160 that it decodes H.264 High 4:2:0 and High 4:4:4
(`avc1.f40033`), AV1 4:4:4 and VP9 profile 1, but not HEVC. Safari is not
checked yet.

## Decision

**One viewer, one protocol.** The panel's video client, which already
speaks Selkies' WebSocket protocol through bb-box's relay (056), becomes
the viewer for every desktop. Each platform gets a server in the box that
speaks the same subset: video frames (H.264, keyframes on request, frame
IDs and acks for pacing), pointer and keyboard as Selkies' messages,
resize, and the clipboard. VNC stays on every desktop as the fallback,
and for computer use's own needs where it has any.

Per platform:

- **Linux X11: Selkies, tuned for sharp text.** 4:4:4 (`video_fullcolor`
  with x264) where the viewer decodes it, a higher quality when the
  picture is still (Selkies' paint-over), and a bitrate that does not
  starve text. Another worker is on this now.
- **macOS: a capture server of our own.** A small signed binary in each
  box, run as the box user: ScreenCaptureKit for whole frames at 2x,
  VideoToolbox H.264 in real-time mode, CGEvent for input under the
  Accessibility permission that [058](058-a-mac-with-sip-off-grants-its-box-users-macos-permissions.md)
  grants, and the pasteboard. Whole frames end the tearing. Pool Macs
  first, then Tart VMs, where the hardware encoder under the paravirtual
  GPU has to be measured; failing that, VideoToolbox's software encoder.
- **Windows: QEMU's H.264 first, else a capture server of our own.**
  First check whether Proxmox's QEMU build sends RFB Open H.264. If it
  does, noVNC 1.6 shows it with no guest software. Otherwise, a small
  service in the guest's desktop session: Desktop Duplication, with GDI
  as its fallback, and OpenH264 in software, speaking the same protocol.
  Both Windows cases have no GPU, so the encoder's CPU at 1080p and at 2x
  decides the frame rate.
- **Linux Wayland: Selkies' own Wayland mode, measured against wayvnc.**
  It brings its own compositor, labwc, in place of Sway; whether Sway's
  floating-window behaviour (048) carries over decides it.

**What goes:** Screen Sharing and Tart's VNC as the first stream on
macOS, and QEMU's VNC as the first on Windows, once their video passes
the measures below. All stay as the fallback.

## How smooth and sharp are measured

The harness from 056's comparison, a viewer in headless Chrome through
BB's server, grows to every platform:

- **Frame time:** frames a second, and the gaps between them at the
  median, the 95th percentile and the worst, while a window is dragged and
  a terminal scrolls.
- **Lag:** how far the dragged window trails the pointer, per frame; and
  key-to-screen.
- **Tearing:** a solid window dragged across the screen, its left edge
  read on rows at its top and bottom in every decoded frame. A frame whose
  rows disagree is torn.
- **Sharpness at 2x:** a fixed page of text at 2x, its region in the
  decoded frame compared with the box's own lossless screenshot by SSIM,
  still and right after a scroll.
- **Cost:** the box's CPU, the bitrate through BB's server, and the idle
  cost with and without a viewer.

A platform's video replaces its VNC as the default once it matches
Linux's numbers: lag under 50 ms at the median, no torn frames, and text
SSIM at least VNC's when still.

## Order

1. The harness on every platform, with today's numbers as the baseline
   ([scripts/measure](../../scripts/measure/README.md),
   [060 results](060-results.md)).
2. Linux X11 sharpness, which is under way.
3. macOS on pool Macs, where the owner works most, and the tearing is.
4. Windows: QEMU's Open H.264 if Proxmox has it, else the guest service.
5. macOS on Tart, then Linux Wayland.

## Open questions

- Safari's WebCodecs: H.264 4:4:4 and AV1 decode, for viewers on a Mac.
- VideoToolbox's hardware encoder inside a Tart macOS VM.
- OpenH264's CPU at 1920x1080 and at 2x on the Windows VMs, and whether
  Desktop Duplication works in their desktop session there.
- Whether Selkies' Wayland mode keeps what 048 chose Sway for.
