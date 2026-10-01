# 021: A desktop whose VNC server cannot resize is resized by its backend

Status: accepted, 30 September 2026. Partly supersedes
[006](006-gpu-desktop-on-xorg.md): the GPU desktop's screen can resize.
Extends [011](011-interface-v1.md) and
[020](020-control-belongs-to-a-viewer.md). Extended by
[039](039-windows-desktops-are-clones-of-a-template-that-is-not-generalized.md):
Windows' console resizes through the backend.

## Context

006 said the GPU desktop cannot resize, because Xorg on the GPU has no RandR
outputs. The X screen can resize, but `x0vncserver` cannot do it for a viewer:

| Check | Where | Result |
| --- | --- | --- |
| `xrandr --fb 1280x800` | a real `linux-desktop` box | exit 0; `xdpyinfo` then shows 1280x800 |
| A viewer's SetDesktopSize | a real box, and TigerVNC 1.16.2 on Xvfb | refused in under 1 ms: ExtendedDesktopSize reason 1, status 3 (invalid layout) |
| `xrandr --fb` while a viewer is connected | TigerVNC 1.16.2 on Xvfb | the viewer gets ExtendedDesktopSize reason 0 with the new size about 5 ms later |

In TigerVNC 1.16.2, `x0vncserver` sets a viewer's size by giving each screen
a RandR output, and with no outputs it answers "invalid". It follows any
change to the root window's size and sends the new size to every viewer.

noVNC 1.7.0 sends one SetDesktopSize at a time and sends the next only after
the server answers the last (reason 1). An update with reason 0 resizes its
canvas. The relay passes the box's messages undecoded, so it cannot make up
that answer.

A fixed 1920x1080 desktop in a small panel is hard to read
([desktop streaming](../research/desktop-streaming.md)), and `linux-desktop`
is the default desktop.

## Decision

- A display may offer `resize(size, signal)`, which sets its size the
  backend's own way. A backend offers it only for a display whose stream
  server does not act on SetDesktopSize. A display with `resize` is
  `resizable`.
- The relay still passes the holder's SetDesktopSize to the box, whose
  refusal answers noVNC. When the display has `resize`, the relay also calls
  it with the size asked for. The new size reaches every viewer when the
  stream server follows the screen.
- One resize of a box runs at a time. A request that arrives meanwhile
  replaces any request still waiting, so only the latest size is applied.
- Hand-back sets the size back over a connection of the relay's own (020),
  then with `resize` when the display has it. A `linux-desktop` box can come
  back on the CPU after a stop and start (006), where Xtigervnc takes
  SetDesktopSize and `xrandr --fb` cannot shrink the screen below its output.
- Proxmox LXC gives `linux-desktop` a `resize` that runs
  `xrandr --fb <width>x<height>` on display `:99` as the box user over SSH,
  with no size cap, and sets `resizable: true` again. Back on the CPU it
  does nothing, as Xtigervnc has taken the SetDesktopSize.
  `linux-desktop-cpu` keeps SetDesktopSize.
- The conformance suite checks `resize` where a display offers it, as core
  uses it: after a SetDesktopSize and `resize`, a new connection's
  ServerInit gives the new size.

## Consequences

- The GPU desktop fits the viewer while you hold control, as the CPU desktop
  does now.
- The app and noVNC do not change. The browser console shows noVNC's
  "Server did not accept the resize request" warning on each resize.
- Each resize runs one SSH command, so it takes about half a second (an
  acquire's SSH step takes 0.45 s), against a few milliseconds on Xtigervnc.
- Resizes still pass only from the viewer that holds control, and hand-back
  still restores the agent's size (008, 020). On a GPU desktop hand-back
  opens one VNC connection, whose SetDesktopSize the box refuses, before it
  resizes.
- The same hook serves any backend whose stream server shows a screen it did
  not make, such as `x0vncserver` on a real machine's display.
- `xrandr --fb` on the CPU path would race the viewer. noVNC sends a resize
  every 100 ms while the panel is dragged, and Xtigervnc takes each in about
  1 ms, so an older size over SSH can land after a newer one. Below the
  screen's output, `xrandr --fb` exits 1 but still shrinks the screen and
  leaves its only output disconnected until the next SetDesktopSize
  (TigerVNC 1.16.2).
- Checked on a real `linux-desktop` box on 30 September:

  | Check | Result |
  | --- | --- |
  | `xrandr` limits | 8x8 to 32767x32767 |
  | 2560x1440, past the configured 1920x1080 | works |
  | 1233x677, an odd size | works |
  | XFCE's panel | follows each width, and back on restore |
  | Chrome after a resize | GPU compositing still on |
