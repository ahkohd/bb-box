# What bb-box asks of BB

bb-box builds on BB rather than around it
([002](decisions/002-bb-is-the-coordinator.md)). These are the BB features it
needs and does not have yet, checked against BB 0.44.0 (plugin SDK and
server protocol 219). They are drafts until filed with BB.

| Request | Status | Without it |
| --- | --- | --- |
| [BB's host app on Windows](#1-bbs-host-app-on-windows) | draft | Windows boxes cannot enrol |
| [Send backlog on plugin WebSockets](#2-send-backlog-on-plugin-websockets) | draft | the desktop relay cannot slow down for a slow viewer |

## 1. BB's host app on Windows

**What bb-box needs.** Windows boxes that enrol as BB machines, like Linux and
macOS boxes. Then a thread's Git credentials and machine variables reach its
Windows box, and a child thread can run there, for example to build and test
a Windows app.

**What BB does now.**

- `bb-app`'s `package.json` declares `"os": ["darwin", "linux"]`.
- The machine installer is a POSIX sh script. On any other system it stops
  with "bb machine installation supports macOS and Linux only."
- The host daemon runs as a systemd user service on Linux or a launchd agent
  on macOS.
- A machine provider's `bootstrap` runs the installer through the provider's
  executor as `sh -c`.

**What we ask.**

1. A Windows installer, in PowerShell, that enrols a machine the way the sh
   installer does, including the same skip when the host app is already
   installed.
2. `bb-app` published with Windows builds of its native modules, for x86_64
   first.
3. The host daemon running as the logged-in user in the desktop session, for
   example as a scheduled task at logon, rather than as a service in session 0.
   Threads then reach the desktop the user sees.
4. `experimental_machines.bootstrap` choosing the installer by the machine's
   OS, so a provider's executor can run PowerShell.

**Until then.** Windows boxes run commands, copy files and stream their
desktop through bb-box's own transports. They do not get the thread's Git
credentials and machine variables from BB, and child threads cannot run on
them. The panel says so on each Windows box.

## 2. Send backlog on plugin WebSockets

**What bb-box needs.** The desktop relay copies a box's stream to each viewer
through a plugin WebSocket route. When a viewer's network is slower than the
stream, the relay should see its own backlog, so it can stop reading from the
box and let the stream protocol slow down.

**What BB does now.** The plugin socket has `send`, `close` and `readyState`.
`send` returns nothing, and there is no `bufferedAmount`, so the plugin cannot
tell how much is queued for the viewer.

**What we ask.** Either `bufferedAmount` on the plugin socket, as in the
browser's WebSocket, or a `send` that returns a promise which resolves when the
data has been handed to the network.

**Until then.** The relay copies bytes as they come and leaves flow control to
the stream protocol end to end ([007](decisions/007-desktop-stream-is-a-typed-transport.md)).
RFB paces updates end to end, through the viewer's update requests or
TigerVNC's congestion control, which keeps the backlog small. Selkies'
WebSocket mode is not measured yet.

## Checked, no request needed

- **Subprotocols.** BB's WebSocket server answers with the first subprotocol
  the client asks for, which is what Selkies' client needs.

## Possible later

- **One daemon at enrolment.** The installer starts a temporary daemon to
  join, then installs the service and waits for it to connect again. If timing
  a real enrolment shows that this handover is a large part of it, bb-box will
  ask for the installer to start the service directly. The enrolment research
  measures it first.
