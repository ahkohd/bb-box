# A Wayland desktop

What a Linux desktop box on Wayland needs: a headless compositor, a stream
the relay can show, computer use, and apps drawn natively on Wayland, on the
GPU and on the CPU (#45).

Status: measured on 2 October 2026. Decided in
[048](../decisions/048-a-wayland-desktop-is-sway-with-floating-windows-streamed-by-wayvnc.md).

## Recommendation

1. **Sway, headless, with floating windows, streamed by wayvnc.** It starts
   in about 0.13 s, resizes in milliseconds, paces frames at 60 a second,
   uses about 100 MB with its stream, and works with Cua Driver and the
   relay as they are.
2. **Turn Xwayland off for now.** One X11 window on Sway hides every
   window's process and bounds from Cua.
3. **CPU first.** On the GPU, every Wayland compositor needs the host's
   `nvidia-drm` module loaded with `modeset=1`. The test host has it off.
4. **Keep GNOME Shell with TigerVNC's `w0vncserver` as a possible second
   kind.** It works, but it cannot resize, it draws without pacing, it
   takes about 650 MB, and Cua takes about 720 ms per action on it.
5. **Hyprland needs a DRM device**, so it waits for the GPU path too.

## Setup

- A CPU desktop box on Proxmox LXC: 8 cores and 16 GiB (the `medium`
  size), Ubuntu 24.04, cloned from the `linux-desktop-cpu` template. The
  `small` size was measured by pinning everything to 4 cores.
- A GPU desktop box on the same backend, on a host with NVIDIA RTX PRO
  6000 Blackwell GPUs and driver 580.142.
- Ubuntu 24.04's packages: Sway 1.9 (wlroots 0.17), wayvnc 0.7.2 (neatvnc
  0.7.1), Waybar 0.9.24, GNOME Shell 46. TigerVNC 1.16.2 was built from
  source for `w0vncserver`, and gnome-remote-desktop 46 rebuilt with VNC.
- Cua Driver 0.28.3, the template's pin, and 0.32.0, the newest release.
  Chrome 154. GPUI 0.2.2 for the frame-rate probe, and Zed for a real
  GPUI app.
- On the CPU, apps used Mesa: llvmpipe for OpenGL, lavapipe for Vulkan.

## Compositors

### Sway

Started as the box user with:

```sh
WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman \
  sway -c sway.conf
```

- Its output is `HEADLESS-1`, set by `output HEADLESS-1 mode 1920x1080`.
- From launch to wayvnc's first full frame: 127 ms. Sway's IPC socket
  answers in 5 to 6 ms.
- Memory: Sway 42 to 77 MB, wayvnc 44 to 125 MB, the more while a viewer
  is watching.
- Frame callbacks are paced at the output's 60 Hz, so an app that
  animates without stopping draws 60 frames a second, not as many as it
  can.
- With floating windows by default (below), apps open at their own size,
  centred, as on a normal desktop, with Sway's title bars.

### GNOME Shell

Started with `gnome-shell --headless --virtual-monitor 1920x1080@60
--wayland-display wayland-g --no-x11` in a D-Bus session of its own.

- On the bus 242 ms after launch.
- Memory: gnome-shell 368 to 381 MB, and its portals 256 to 270 MB.
- Its virtual monitor has one mode, so the display cannot be resized.
- Frame callbacks are not paced: an animating app draws as fast as the
  CPU allows (see the GPUI table).
- At start it shows the Activities overview, which takes the keyboard.
  An extension that leaves the overview was needed for Cua.

### KWin

Not tried. Ubuntu 24.04 has Plasma 5.27, and Cua has no KWin adapter.

### Hyprland

Tried later, for projects whose Linux side drives Hyprland. Hyprland 0.56.2
with aquamarine 0.15.1 and Mesa 26.2, from Arch Linux's packages, in a
container in the CPU desktop box:

- It stops at start: "Cannot open backend: no allocator available".
- Aquamarine allocates buffers only through GBM or DRM dumb buffers, both
  on a DRM device. Its headless outputs have no device of their own, and
  its DRM backend needs a seat, from seatd or logind, and the GPU's card
  node. A CPU box has neither, so no renderer setting helps.
- On a GPU, it needs what Sway needs there (below), and seatd in the box.
  Whether several boxes can hold one GPU's card node at once is not known.
- Cua 0.28.3 has a Hyprland adapter. Its own notes call it experimental:
  windows are found through an optional Hyprland plugin built for the
  exact Hyprland version, by default for discovery only, and its input is
  qualified for two apps.
- Sway 1.9 already offers, by `wayland-info`, the protocols remote-input
  tools often use: `zwlr_virtual_pointer_manager_v1`,
  `zwp_virtual_keyboard_manager_v1` and `zwlr_data_control_manager_v1`.

## Streams

### wayvnc on Sway

| Question | Measured |
| --- | --- |
| Security types | none: 1; `enable_auth` with a user and password: 129 and 5 (RSA-AES); with `relax_encryption=true` as well: 129, 5 and 30 (Apple Diffie-Hellman). Never 2 (VNC password) |
| The relay's own sign-in | `boxHandshake` from `src/core/rfb.ts` with `{type: "apple"}` signs in and has ServerInit 155 ms after connecting; a wrong password or user gets wayvnc's "Invalid username or password" |
| Shared viewers | two at once both get frames and both follow a resize |
| First full frame | 80 ms after connecting, at 1920x1080 |
| Frame rate | 30 a second by default; `-f 60` gives 58 to 60 |
| A viewer's SetDesktopSize | refused (status 1, prohibited) |
| `swaymsg output HEADLESS-1 mode WxH` | returns in 2 to 5 ms; viewers get the new size and a full frame 5 to 105 ms later; any size, such as 1233x677 |
| After a restart | first full frame about 125 ms later |

- Once, during resize tests, wayvnc exited without a word. 8 resize cases
  and 30 stress cycles of resize then a new viewer, 38 in all, did not
  repeat it. Run it as a service that restarts it; the relay's 5 s for a
  viewer to come back covers it
  ([043](../decisions/043-a-viewer-has-5-s-to-come-back-after-the-box-ends-its-connection.md)).
- It logs "Output HEADLESS-1 power state failure" at start, which does no
  harm.

### TigerVNC's w0vncserver on GNOME

TigerVNC 1.16 added `w0vncserver`, a VNC server for Wayland that captures
the screen through the RemoteDesktop and ScreenCast portals and PipeWire.
Ubuntu 24.04 packages TigerVNC 1.13, so it was built from source:

```sh
cmake -DBUILD_VIEWER=OFF -DENABLE_NLS=OFF -DENABLE_H264=OFF .. && make w0vncserver
```

- Shared viewers work (`-AlwaysShared`), with a VNC password (type 2), as
  `x0vncserver` today.
- First full frame 0.72 s after connecting.
- It needs a one-time Remote Desktop consent in the portal. It was
  accepted through the accessibility tree; a restore token would keep it.
- No resize: the virtual monitor has one mode, and `w0vncserver` has no
  `-AcceptSetDesktopSize`.
- About 100 ms after each change it sends the area again losslessly. That
  sharpens the picture; it is not lag.

### gnome-remote-desktop

- Ubuntu builds it without VNC. Rebuilt with VNC, it signs in with a VNC
  password, has its first frame 172 ms after connecting, and a viewer can
  resize it.
- Headless, it adds a new virtual monitor for each connection, and it
  serves one viewer at a time (a TODO in its `grd-vnc-server.c`). That
  breaks the relay's shared control, so it was not pursued.

## Apps

| App | Window mapped after launch |
| --- | --- |
| gtk4-demo (GTK 4) | 150 ms; 807 ms the first time; about 155 ms on GNOME |
| Zed (GPUI on wgpu, lavapipe) | 165 to 358 ms |
| Chrome 154, native Wayland | 209 to 211 ms |
| Chrome 154 through Xwayland | 443 ms |
| xterm through Xwayland | 74 ms |

- Chrome draws natively on Wayland when it starts with
  `XDG_SESSION_TYPE=wayland` in its environment, and through Xwayland
  otherwise. The template's Chrome wrapper flags, such as
  `--force-renderer-accessibility`, still apply.
- GPUI 0.2.2 needs `app_id` set, and the title set with
  `window.set_window_title()`: on Wayland it ignores
  `TitlebarOptions.title`.
- `cargo add gpui@0.2.2` fails to build: xattr 0.2.3 uses `libc::ENOATTR`,
  which libc 0.2.190 lacks on Linux. A `[patch.crates-io]` copy of xattr
  using `ENODATA` builds.

## GPUI frame rate and feel

The probe is a GPUI app that scrolls a 10,000-row list by one row every
frame, as the Windows probe for #150 did (about 60 fps on WARP). It draws
its frame number as a barcode, so a viewer can count the frames it is
actually shown.

| Compositor | Window | small (4 cores) | medium (8 cores) |
| --- | --- | --- | --- |
| Sway | 1200x700 | 58 to 60 fps | 58 to 60 fps |
| Sway | 1920x1048, maximised | 58 to 60 fps | 58 to 60 fps |
| GNOME | 1200x700 | 190 fps | 205 fps |
| GNOME | 1920x1048, maximised | 66 fps | 69 fps |

- GNOME's unpaced frames cost 2 to 3 times the CPU for the same picture:
  the app uses 1.0 to 1.7 cores and gnome-shell 1.2 to 1.9, against 0.5 to
  1.3 and under 0.1 on Sway. This happens only while an app animates
  without stopping; GPUI draws nothing when idle.
- Frames a viewer is shown, asking as noVNC does (Tight, JPEG), from a
  client in the box: 58 to 60 a second through wayvnc with `-f 60`, about
  54 through `w0vncserver`. Both look smooth.

How it feels, from an input event sent over RFB to the first screen update
with pixels, without network latency:

| Action | Sway, small | Sway, medium | GNOME, small | GNOME, medium |
| --- | --- | --- | --- | --- |
| A key typed into a GPUI text field | 31 ms | 33 ms | 22 ms | 23 ms |
| A wheel scroll | 34 ms | 29 ms | 32 ms | 31 ms |
| A window resize: fullscreen on Sway, maximise on GNOME | 37 ms | 37 ms | 51 ms | 52 ms |

- GPUI draws its first frame at the new size 7 to 15 ms after the
  compositor asks.
- Typed text arrives intact.
- Dragging a floating window's border on Sway, 30 moves in 0.5 s: the app
  draws 19 to 21 sizes on the way, and its final size 4 to 9 ms after the
  button is released.

## Floating windows, the bar and resizing

Sway tiles by default. These lines make it a floating desktop:

```
for_window [all] floating enable
default_border normal 2
default_floating_border normal 2
floating_modifier Mod4 normal
```

- New windows open at the size they ask for, centred, with a 25-pixel
  title bar Sway draws. A window's border can be dragged to resize it, and
  Mod4 with a drag moves it.
- Waybar with its `wlr/taskbar` module lists the windows, and a click on
  one brings it to the front. Its configuration in the test:

  ```json
  {"layer": "top", "position": "bottom", "height": 30,
   "modules-left": ["wlr/taskbar"], "modules-right": ["clock"],
   "wlr/taskbar": {"format": "{title}", "on-click": "activate", "max-length": 40},
   "clock": {"format": "{:%H:%M}"}}
  ```

- When the output shrinks, floating windows can be left partly outside
  it. A fit step after the mode change moves and shrinks each one into the
  output, less the bar, in one `swaymsg` command. A floating window's size
  in `resize set` includes its title bar. Mode change and fit together
  took 19 to 20 ms.

  ```python
  for space in workspaces:
      area = space["rect"]  # the output, less the bar
      for n in space["floating_nodes"]:
          r, deco = n["rect"], n["deco_rect"]["height"]
          w, h = min(r["width"], area["width"]), min(r["height"] + deco, area["height"])
          x = min(max(r["x"], area["x"]), area["x"] + area["width"] - w)
          y = min(max(r["y"] - deco, area["y"]), area["y"] + area["height"] - h)
          # when it changed:
          cmds.append(f"[con_id={n['id']}] resize set {w} {h}, move absolute position {x} {y}")
  ```

## Computer use

### Cua on Sway

Cua Driver finds Sway's windows through Sway's IPC. It needs, in the
daemon's environment:

- `SWAYSOCK`, Sway's IPC socket;
- `CUA_DRIVER_RS_ENABLE_WAYLAND=1`;
- `WAYLAND_DISPLAY`, `XDG_SESSION_TYPE=wayland` and
  `XDG_CURRENT_DESKTOP=sway`;
- a working accessibility bus, and no `DISPLAY`.

Without `SWAYSOCK`, windows come back with no process and no bounds, and
every tool that targets a window refuses: "no trusted Wayland compositor
adapter can confirm exact target window". The same in 0.28.3 and 0.32.0.

With it:

| Tool | Measured |
| --- | --- |
| `list_windows` | 15 to 19 ms; pids, Sway's window rectangles, and Sway's container IDs as window IDs |
| `launch_app` | 280 ms for gtk4-demo, its window listed at once |
| Accessibility tree | gtk4-demo, 70 elements in 119 ms; Chrome, 46 elements in 134 ms |
| Screenshot | 25 ms |
| Type text | 170 to 187 ms, through Wayland's virtual keyboard |
| A key | about 20 ms |
| Click at pixels | 80 to 82 ms, through Wayland's virtual pointer |
| Click an element with an action | 66 ms (a Chrome button) |

- Input goes only to the focused window. Background delivery is refused
  ("the requested target has no focus-free input backend"), and Cua
  refuses before doing anything, so bb-box's foreground retry
  ([015](../decisions/015-computer-use-through-cua-driver.md)) runs. Typing
  into a floating window behind another worked (186 ms): Cua brings it to
  the front first.
- Clicking an element with no accessibility action, such as a GTK tab,
  fails: Cua falls back to X11 ("AT-SPI element click failed: cannot
  inject input: X11 connection failed"). Clicking the centre of the
  element's frame, in window pixels, works (82 ms, the tab selected).
  Cua's frames are in screen pixels; the window's origin from
  `list_windows` turns them into window pixels. Cua takes pixels only after
  a `get_window_state` with a screenshot on the same connection.
- **One X11 window breaks it.** While an Xwayland window is open,
  `list_windows` returns every window, Wayland ones too, with no process
  and no bounds, as without `SWAYSOCK`. Closing it brings them back. The
  same in 0.28.3 and 0.32.0.
- The accessibility bus: `at-spi-bus-launcher` named its socket `bus_99`
  after the `DISPLAY=:99` it inherited from the X11 desktop. A second
  launcher with the same `DISPLAY` removed that socket when it exited, and
  Cua then failed with "AT-SPI connect failed". `systemctl --user restart
  at-spi-dbus-bus.service` fixed it. A Wayland desktop has no `DISPLAY`
  and one launcher.
- A `list_windows` took 3 s while GNOME's portals were still running in
  the same session. With them gone it was back to 16 ms.

### Cua on GNOME

It works, at about 720 ms per foreground action, after:

- Cua's GNOME Shell extension (`winrects@cua`);
- the GNOME and GTK portals, with `XDG_CURRENT_DESKTOP=GNOME` in the
  bus's activation environment;
- the one-time Remote Desktop consent, after which Cua keeps a token;
- a focused window, and an extension that leaves the overview at start.

## The GPU

On the GPU desktop box, no Wayland compositor could use the GPU:

- NVIDIA's GBM backend loads, then gives up: the `nvidia-drm` device
  answers its `GET_DEV_INFO` ioctl with `supports_alloc=0`, which it does
  when `nvidia-drm` runs without `modeset=1`.
- libgbm then falls back to Mesa's `kms_swrast`, which cannot allocate on
  a render node, so Sway's output never commits.
- wlroots' Vulkan renderer fails too: NVIDIA's Vulkan lacks
  `VK_EXT_external_memory_dma_buf`, probably for the same reason.
- GNOME Shell, KWin and NVIDIA's own Wayland clients need GBM or dma-buf
  from `nvidia-drm` as well.
- Xorg with NVIDIA's driver
  ([006](../decisions/006-gpu-desktop-on-xorg.md)) is unaffected: NVIDIA's
  X driver does not allocate through `nvidia-drm`.

The host had `nvidia_drm` loaded with `modeset=N` and `fbdev=Y`. Its
parameter is readable only by root on the host:

```sh
cat /sys/module/nvidia_drm/parameters/modeset
```

In a box it cannot be read, even with sudo, but the render node answers
the ioctl. With driver 580.142 the reply is nine 32-bit fields:

```python
import fcntl, os, struct
fd = os.open("/dev/dri/renderD128", os.O_RDWR)
buf = bytearray(36)
# DRM_IOWR(DRM_COMMAND_BASE + DRM_NVIDIA_GET_DEV_INFO, 36 bytes)
fcntl.ioctl(fd, (3 << 30) | (36 << 16) | (0x64 << 8) | 0x43, buf)
gpu_id, primary_index, supports_alloc = struct.unpack("<9I", buf)[:3]
```

The fix is `options nvidia-drm modeset=1` in `/etc/modprobe.d/`, then a
reboot, or a reload of `nvidia_drm` while nothing uses it. Recent drivers
default to `modeset=1`.

## Method

- **Frames shown.** A Python RFB client asks for the encodings noVNC asks
  for: Tight, JPEG quality and compression levels, and the size
  pseudo-encodings. It decodes only the Tight rectangles that cover the
  probe's barcode (fill, JPEG and basic with a palette, copy or gradient
  filters, keeping Tight's four zlib streams), reads the 16 bits, and
  counts distinct frame numbers a second. Two red squares mark where the
  code starts.
- **Feel.** The same client sends a key, a wheel step, a key chord or a
  pointer drag, then times the first update with pixels and when updates
  settle (no update for 0.25 s). It waits for 0.4 s with no updates
  before each action. The compositor and the VNC server were pinned to 4
  or 8 cores, and the client to another.
- **First full frame.** The time from launch, or from connecting, to the
  first update covering every pixel. wayvnc answers the first full request
  with its size alone, so the client asks again until the pixels cover the
  screen.

## Sources

- [Sway](https://github.com/swaywm/sway) and
  [wayvnc](https://github.com/any1/wayvnc).
- [Waybar](https://github.com/Alexays/Waybar).
- [TigerVNC 1.16 release news](https://www.phoronix.com/news/TigerVNC-1.16).
- [TigerVNC pull request 1947, w0vncserver](https://github.com/TigerVNC/tigervnc/pull/1947).
- [Cua](https://github.com/trycua/cua).
