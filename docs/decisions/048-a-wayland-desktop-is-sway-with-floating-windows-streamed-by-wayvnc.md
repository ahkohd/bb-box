# 048: A Wayland desktop is Sway with floating windows, streamed by wayvnc

Status: accepted, 2 October 2026. Extends
[027](027-a-kind-says-when-it-has-a-desktop.md): new desktop kinds, named
by its rule; [021](021-desktop-resize-through-the-backend.md): the backend
resizes a Wayland display; [015](015-computer-use-through-cua-driver.md):
Cua Driver on Wayland, with a fallback for element clicks; and
[006](006-gpu-desktop-on-xorg.md): a Wayland desktop on the GPU, later, needs
a host setting that 006's Xorg path does not.

## Context

#45 asked for a Linux desktop on Wayland, where GTK 4, GPUI and Chrome draw
natively, and where apps that need Wayland can be built and tested. bb-box's
Linux desktops are X11: XFCE on Xorg with the GPU, or on Xtigervnc.

[The research](../research/wayland-desktop.md) ran headless compositors in
a CPU desktop box and a GPU desktop box on Proxmox LXC, Ubuntu 24.04. Each
was streamed to RFB viewers, driven by Cua Driver 0.28.3, the template's
pin, and measured with a GPUI app that scrolls a list every frame.

| | Sway 1.9, streamed by wayvnc 0.7.2 | GNOME Shell 46, streamed by TigerVNC 1.16's `w0vncserver` |
| --- | --- | --- |
| Packages | Ubuntu's | `w0vncserver` built from source |
| Start | 0.13 s from launch to the first full frame | on the bus 0.24 s after launch; first full frame 0.72 s after connecting |
| Resize | `swaymsg`, 2 to 5 ms, any size; a viewer has the new size within 0.1 s | none: the virtual monitor has one mode, and `w0vncserver` refuses a viewer's resize |
| Frames | paced at 60 Hz; a viewer sees 58 to 60 a second with `-f 60` | unpaced: the GPUI app draws 190 to 205 a second in a window; a viewer sees about 54 |
| CPU while the GPUI app animates | app 0.5 to 1.3 cores, Sway under 0.1 | app 1.0 to 1.7 cores, gnome-shell 1.2 to 1.9 |
| Memory | Sway 42 to 77 MB, wayvnc 44 to 125 MB | gnome-shell 368 to 381 MB, its portals 256 to 270 MB |
| Key, wheel and resize, to the first update | 31, 34 and 37 ms | 22, 32 and 51 ms |
| Shared viewers | yes | yes |
| Sign-in | Apple Diffie-Hellman (type 30), with a user and password; no VNC password (type 2) | VNC password (type 2) |
| Cua, per action | 16 to 187 ms | about 720 ms |
| What Cua needs | its environment, and a start after Sway | its GNOME Shell extension, both portals, a one-time consent and an extension that leaves the overview |
| Windows | floating, with title bars and a taskbar, once configured | GNOME's |

Also found:

- **One X11 window breaks Cua on Sway.** While any Xwayland window is open,
  Cua lists every window with no process and no bounds, and refuses every
  action that targets one. The same in Cua 0.28.3 and 0.32.0.
- **Chrome 154 runs natively** when `XDG_SESSION_TYPE=wayland` is in its
  environment, and maps its window in 0.21 s, against 0.44 s through
  Xwayland.
- **Cua clicks an element with no accessibility action through X11**, and
  so fails on Wayland. A click at the centre of the element's frame works.
- **A second accessibility bus launcher with the same `DISPLAY`** removed
  the first one's socket when it exited, and Cua lost the tree.
- **The relay's sign-in already speaks type 30**, written for macOS: with
  wayvnc it signs in and has the screen's size 155 ms after connecting.
- **No Wayland compositor draws on the test host's GPUs.** Its
  `nvidia-drm` module is loaded without `modeset=1`, so NVIDIA's GBM
  allocates nothing. Xorg (006) does not need it. Changing it needs a
  reboot of the host, or a reload of the module while nothing uses the
  GPUs. The operator has deferred it.
- **Hyprland cannot run without a DRM device.** Hyprland 0.56 allocates
  buffers only through GBM or DRM dumb buffers, so in a CPU box it stops at
  start with "no allocator available". Projects whose Linux side drives
  Hyprland, such as a tool that shares a keyboard and mouse, need it.
- KWin was not tried: Ubuntu 24.04 has Plasma 5.27, and Cua has no KWin
  adapter. gnome-remote-desktop allows one viewer at a time.

## Decision

**A Wayland desktop is Sway, headless, with floating windows, streamed by
wayvnc.** It is a kind of its own. The X11 desktops stay as they are.

**Kinds.**

- `linux-desktop-wayland-cpu`, first: a Linux desktop on Wayland, drawn by
  the CPU. Label "Linux desktop on Wayland"; description "A Linux desktop
  on Wayland (Sway), drawn by the CPU, for computer use, browsers and apps
  built for Wayland. X11-only apps do not run there." No GPU, one RFB
  display, Cua, `enrol` true, Docker as on `linux-desktop-cpu`.
- Later, by the same rule: `linux-desktop-wayland` on the GPU,
  `linux-arm64-desktop-wayland-cpu` on Tart
  ([040](040-linux-on-arm64-has-kinds-of-its-own.md)),
  `linux-desktop-hyprland` and perhaps `linux-desktop-gnome`.
- A kind, not a feature of `linux-desktop-cpu`'s offers: offers of one
  kind must agree on what the agent relies on
  ([012](012-offers-may-add-features.md)), and an agent that asks for
  `linux-desktop-cpu` relies on X11.
- An agent asking for a desktop gets X11 unless it names a Wayland kind.

**The compositor.** Sway 1.9 from Ubuntu, in the `desktop` template built
with a Wayland option.

- `bb-box-display.service` runs Sway as the box user, with
  `WLR_BACKENDS=headless`, `WLR_LIBINPUT_NO_DEVICES=1`,
  `WLR_RENDERER=pixman` and `SWAYSOCK=/run/bb-box/sway.sock`. `display
  wait` waits for Sway's IPC, then writes `WAYLAND_DISPLAY` and `SWAYSOCK`
  to `/run/bb-box/display.env`, which SSH commands and the units already
  read.
- The session's environment: `XDG_SESSION_TYPE=wayland`,
  `XDG_CURRENT_DESKTOP=sway`, and no `DISPLAY` anywhere: not in
  `/etc/environment`, `/etc/environment.d` or a unit. Sway's config imports
  `WAYLAND_DISPLAY`, `SWAYSOCK` and the two `XDG_` variables into the box
  user's systemd and D-Bus activation environments, so the one
  accessibility bus and apps started through D-Bus see them.
- Its config, `/etc/bb-box/sway.conf`:
  - `output HEADLESS-1 mode` with `DISPLAY_GEOMETRY`, 1920x1080 by
    default;
  - floating windows by default, so apps open at their own size, centred,
    as on a normal desktop, with title bars Sway draws:
    `for_window [all] floating enable`, `default_border normal 2`,
    `default_floating_border normal 2` and `floating_modifier Mod4 normal`;
  - Waybar, as `bar { swaybar_command waybar }`, with its `wlr/taskbar`
    and clock modules: a click on a window's button brings it to the front;
  - `xwayland disable`, while one X11 window breaks Cua. X11-only apps,
    such as xterm, Java AWT and Swing, Wine and older Electron apps, need
    `linux-desktop-cpu`.
- An app launcher on the bar and a Wayland terminal are chosen and checked
  in the template's PR. The template's GTK apps, such as Thunar and its
  terminal, run natively.
- Chrome needs nothing new: the session's `XDG_SESSION_TYPE` makes it
  native, and the template's wrapper keeps its flags.

**The stream.** wayvnc 0.7.2 from Ubuntu.

- `bb-box-vnc.service` runs `wayvnc -f 60 -o HEADLESS-1 -C
  /run/bb-box/wayvnc.conf 0.0.0.0 5900` as the box user, after Sway and
  bound to it, with `Restart=always`. wayvnc's default of 30 frames a
  second halves what a viewer sees of an animation.
- wayvnc once exited without a word during the resize tests, and not in
  38 cycles after. Its unit starts it again, and its first full frame is
  back in about 125 ms, within the 5 s a viewer has to come back
  ([043](043-a-viewer-has-5-s-to-come-back-after-the-box-ends-its-connection.md)).
- Shared viewers work as today, so a person and the agent watch together
  ([020](020-control-belongs-to-a-viewer.md)).

**Sign-in.** wayvnc offers no VNC password (type 2). With `enable_auth`,
`username=box`, the password and `relax_encryption=true` it offers Apple
Diffie-Hellman (type 30), which the relay already speaks.

- The unit writes `wayvnc.conf`, mode 0600, from
  `/var/lib/bb-box/vnc-password` before it starts.
- The display's `open()` returns `auth: {type: "apple", user: "box",
  password}`, where X11 displays return `vnc-password`. Viewers sign in to
  the relay as before.

**Resize.** wayvnc refuses a viewer's resize, so the display is
`resizable` through the backend (021).

- `resize()` runs `display resize <W>x<H>` in the box. It sets
  `swaymsg output HEADLESS-1 mode <W>x<H>`, then moves and shrinks each
  floating window into the new size, less the bar, in one `swaymsg`
  command. Both took 19 to 20 ms. Any size above the backend's minimum
  works, so viewers get their exact size.
- A floating window's size in `resize set` includes its title bar. The
  research has the fitting step.

**Computer use.** Cua Driver at the template's pin, in the box user's
`bb-box-cua-driver.service`, as on X11, with:

- `/run/bb-box/display.env`, for `WAYLAND_DISPLAY` and `SWAYSOCK`;
- `CUA_DRIVER_RS_ENABLE_WAYLAND=1`, `XDG_SESSION_TYPE=wayland` and
  `XDG_CURRENT_DESKTOP=sway`;
- a start after Sway: the display unit's `ExecStartPost` restarts it, as
  the XFCE session's does, and stops it when Sway stops;
- one accessibility bus, the user manager's, with no `DISPLAY` in its
  environment. The template's check fails if Cua's tree of a GTK 4 window
  is empty.

Without `SWAYSOCK`, Cua cannot tell windows apart and refuses. Input goes
only to the focused window, so typing and keys go in the foreground: Cua
refuses the background first, and bb-box tries again in the foreground, as
015 has it. Cua brings the window to the front before it types.

**An element click with no action.** When Cua refuses a click on an
element because it cannot inject input, `computer.ts` clicks the centre of
the element's frame instead:

- the frame is in screen pixels, and the window's origin from
  `list_windows` turns it into window pixels;
- Cua takes pixels only after a `get_window_state` with a screenshot on
  the same connection, so bb-box reads the window first when its session
  has not;
- the result says that bb-box clicked the element's centre, so the agent
  knows it was a click by position;
- it applies to any kind where Cua refuses this way, and only to elements
  that have a frame.

**Backends.**

1. Proxmox LXC, first: a template flavour `desktop-wayland-cpu`, built by
   `build.sh desktop <vmid> --cpu --wayland`, listed in the settings with
   its own templates. The doctor calls them "CPU Wayland desktop"
   templates.
2. Docker: an image `bbbox/linux-desktop-wayland:1`, from the same
   customize script. Its start script runs Sway, wayvnc and Cua as it runs
   the X11 desktop's.
3. Tart on arm64 later, once Sway, wayvnc and Cua's arm64 build are
   checked in a Linux VM there.

**What stays X11.** `linux-desktop` and `linux-desktop-cpu`, with XFCE, on
every backend that offers them; the GPU path on Xorg (006); X11-only apps;
and the templates and images that serve them.

**Later, once the host's `nvidia-drm` has `modeset=1`.** Both of these
wait for the operator.

- `linux-desktop-wayland`: Sway's GLES2 renderer on the box's GPU, from a
  `desktop-wayland` template flavour built with `--gpu`.
  - `build.sh` refuses to build that flavour while
    `/sys/module/nvidia_drm/parameters/modeset` on the host is not `Y`,
    and says how to set it: `options nvidia-drm modeset=1` in
    `/etc/modprobe.d/`, a new initramfs where the module loads from it, then
    a reboot or a reload of the module with nothing on the GPUs.
    `setup-host.sh` reports the setting.
  - A box cannot read that file. Its display script asks the render node
    instead, with `nvidia-drm`'s `GET_DEV_INFO` ioctl (the research has
    it): `supports_alloc` is 0 without `modeset=1`. Then it falls back to
    the CPU with the reason `nvidia-drm-modeset`, which `displayReason()`
    words as "The host's nvidia-drm module runs without modeset=1, so
    Wayland cannot draw on the GPU".
  - As every GPU on the host has that reason, the backend tries no other
    GPU: it releases the box and reports the fix, and the doctor warns
    with the last box that saw it, as its API cannot read the host.
  - Then check: Sway on NVIDIA's GBM, its first frame and its memory on
    the GPU; GPU clients through EGL, Vulkan and dma-buf (vkcube, a GPUI
    app, Chrome); several Wayland desktops on one GPU; wayvnc's capture
    cost from the GPU's buffers; and that an X11 GPU desktop still starts
    and resizes.
- `linux-desktop-hyprland`, for projects whose Linux side drives Hyprland:
  - Hyprland's DRM backend needs the GPU's card node and a seat, such as
    seatd in the box. Whether several boxes can share one card is to be
    checked. A virtual DRM device on the host, such as vkms, might let it
    run on the CPU; that is untested, and a host change too.
  - Cua 0.28.3 has a Hyprland adapter, but its own notes call it
    experimental: windows are found through an optional Hyprland plugin
    built for the exact Hyprland version, and its input is qualified for
    two apps. Computer use there is unproven.
  - Sway already offers the protocols such projects often need: wlroots'
    virtual pointer and data control, and the virtual keyboard. Code that
    uses only those may run on `linux-desktop-wayland-cpu` now; code that
    uses Hyprland's IPC needs Hyprland.

**GNOME, considered.** GNOME Shell with `w0vncserver` works, and a person
who wants GNOME itself may get `linux-desktop-gnome` later. It would:

- build `w0vncserver` from TigerVNC 1.16, until Ubuntu packages it;
- accept the portal's consent once in the template, and keep its token;
- install Cua's GNOME Shell extension and one that leaves the overview;
- not be resizable: viewers scale its fixed size;
- cost about 650 MB, and unpaced frames while an app animates.

## Consequences

- An agent can ask for a Wayland desktop and have GTK 4, GPUI and Chrome
  apps draw natively, with Cua at 16 to 187 ms an action.
- People get a desktop they know: windows open at their own size, with
  title bars, and a taskbar. Resizing the viewer takes about 20 ms in the
  box.
- X11-only apps do not run on the Wayland kinds, and the kind's
  description says so. The X11 kinds are unchanged.
- One more template and one more Docker image to build and keep current.
- bb-box tracks Cua: when a release lists windows with Xwayland open,
  Xwayland can be turned on, and the element-click fallback stays for
  apps without actions.
- The GPU Wayland kind and Hyprland wait for the host's `modeset=1`.
- Qt and Electron apps were not measured.

### Plan of PRs

1. **The kind**: `linux-desktop-wayland-cpu` in `KIND_INFO`, offered by
   nothing yet.
2. **The template**: `build.sh --wayland` and the Wayland variant of
   `customize-desktop.sh`: Sway, Waybar, wayvnc, a launcher and terminal,
   the display script with `wait` and `resize`, the units, the environment
   without `DISPLAY`, and `fetch-artifacts.sh` for `desktop-wayland-cpu`.
   Its check: a first frame through type 30, a resize, Cua's trees of a
   GTK 4 window and Chrome, and no Xwayland.
3. **The LXC backend**: the `desktop-wayland-cpu` flavour, its offer and
   settings, `auth` of type `apple`, `resize()` through `display resize`,
   and its doctor name.
4. **`computer.ts`**: the click at an element's centre, with tests against
   a fake Cua.
5. **Conformance**: the kind in the suite, with a resize and computer use.
6. **Docker**: the `bbbox/linux-desktop-wayland:1` image and its offer.
7. **Docs**: the architecture, the setup guides and the kinds table, with
   each PR.

After `modeset=1`: the `nvidia-drm` checks in `setup-host.sh`, `build.sh`,
the display script and the doctor; the `linux-desktop-wayland` kind; then
Hyprland. Tart's arm64 kind when a person asks for it.
