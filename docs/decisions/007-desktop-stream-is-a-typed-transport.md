# 007: The desktop stream is a typed transport, relayed through the plugin

Status: accepted, 30 September 2026. Research:
[desktop streaming](../research/desktop-streaming.md).

## Context

BB's app talks only to the BB server, and boxes usually sit on a private
network. A plugin can serve a WebSocket route, but routes match exact paths
and carry TCP only. Linux, Windows and macOS offer different remote desktop
protocols.

## Decision

- A kind declares its stream: a type (`rfb` now, `selkies` or `rdp` later),
  a port, and whether it can resize.
- The plugin serves one WebSocket route, `/desktop?box=<id>`. For each
  viewer it opens a byte channel to the box's stream port through the box's
  transports and copies bytes both ways. It never decodes pixels.
- The panel loads the client for the stream type. The clients ship with the
  plugin, because a route cannot serve a box's own web pages.
- First type: RFB (VNC) with noVNC. Every planned OS offers it, including
  Windows, Tart macOS VMs and physical Macs (Screen Sharing).
- Selkies 2.0 over WebSockets for Linux desktops once its GPU experiment
  passes.
- No WebRTC: its media needs UDP or TURN, which a plugin route cannot carry.

## Consequences

- The core never names VNC, Selkies or a display server.
- Every viewer adds one connection through the BB server, whose network and
  CPU carry the stream.
- The relay has no `bufferedAmount`, so it stays a pass-through and flow
  control stays end to end in the stream protocol. A BB feature request asks
  for `bufferedAmount`.
- RDP needs a gateway or a client in the panel. That is a later decision.
