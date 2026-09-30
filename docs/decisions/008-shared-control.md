# 008: You and the agent share one desktop, with one controller at a time

Status: accepted, 30 September 2026.

## Context

You watch the agent work and sometimes take over: to log in, to fix a dialog,
or to show it something. Two drivers at once corrupt each other's input, and a
resize under the agent breaks the coordinates it is using.

Input could be filtered in the box, in front of the VNC server, or in the
plugin's desktop relay, which every viewer already goes through.

## Decision

- Each desktop box has one owner of input: the agent (the default), you, or
  nobody while control changes hands. The plugin holds it in memory only.
- Every viewer always sees the desktop. Only input is owned.
- The agent drives through computer use inside the box. You drive through the
  stream. The stream never carries the agent's input.
- **The relay filters input, not the box.** For each viewer's connection it
  drops the input messages of anyone who is not the owner, and passes
  everything else, so they keep watching. For RFB that is KeyEvent (4),
  PointerEvent (5), ClientCutText (6), xvp (250), SetDesktopSize (251) and the
  QEMU messages (255). This works the same for every backend and OS, with
  nothing to install in the box.
- **Taking control:**
  1. the owner becomes nobody, and new computer-use calls are refused at once;
  2. calls already running get up to 5 s to finish;
  3. the computer-use service is stopped. Apps it started, such as Chrome,
     stay in your desktop session, so you and later the agent keep using them;
  4. you become the owner.
- **While you hold control,** computer-use calls fail at once with a clear
  message saying you have control, and the agent waits or does other work. On
  the first call after you hand back, computer use starts again.
- **Handing back:** the relay releases any keys and mouse buttons your
  connection still holds down, then the agent becomes the owner.
- **Anything stale goes back to the agent:** a take that fails, a holder whose
  viewer has been gone for 60 s, or a restart of the plugin.
- **Resizing** is allowed only while you hold control. The desktop returns to
  its default size when you hand back.

## Consequences

- You can open a box in several tabs; only the tab that took control sends
  input.
- Pausing the agent is the only part in the box, and it is written once per
  OS. On Linux the computer-use service runs in its own cgroup: take freezes
  and kills that cgroup, after moving the apps it started into the desktop
  session's cgroup. This works in an unprivileged container with a delegated
  cgroup v2 subtree. Windows and macOS need their own way.
- A closed browser never leaves a box stuck under your control.
- The viewer must take the screen ID for SetDesktopSize from the server's
  ExtendedDesktopSize rectangle. Screen ID 0 did not resize and appeared to
  restart the desktop. noVNC already does this.
- A simpler option, not tested, is a view-only VNC password for viewers and a
  reconnect with the full password on take. It needs a VNC server with
  view-only passwords, so the relay filter is kept as the general way.
