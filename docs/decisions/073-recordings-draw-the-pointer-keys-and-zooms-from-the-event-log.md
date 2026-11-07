# 073: Recordings draw the pointer, keys and zooms from the event log

Status: accepted, 7 November 2026, for the launch polish. Extends
[059](059-agents-record-their-desktop-box-with-box-record.md).

## Context

The owner, on 7 November: "show keypress, nice zooms ... like screen studio,
the screen recording tool should be very polished, custom nice cursor etc".

A clip today is the box's whole screen scaled to 1280 wide, with the
screen's own small pointer, at 15 frames a second. On a 1920 by 1080
desktop a window of 640 by 480 is a third of the clip's width, and its text
is hard to read. Nothing shows what the agent clicked or pressed, and
background clicks and typing, which most of Cua's are, show no pointer at
all.

What is logged today: the step captions, in the box (`events`, the box's
clock). Nothing of the pointer, clicks or keys. What could be:

- **The agent's actions.** `computer_act` and `computer_type` know each
  click's button and count, its place on the screen, the element's frame,
  its role and name, each chord, and how many characters were typed.
- **A person's input.** Both relays already parse each pointer message
  (place and buttons) and each key (keysym, down or up) of the viewer with
  control.
- **The real pointer, in the box.** X11 answers `XQueryPointer` (place and
  buttons) to any client; macOS's `NSEvent` gives the pointer and its
  buttons without a grant; Windows gives `GetCursorPos` and
  `GetAsyncKeyState`. Sway 1.11 images have `bb-box-cursor` (060), which
  gives places only.

Measured in a Proxmox LXC X11 desktop, 8 cores, ffmpeg 6.1.1, an 8 s
capture at 1920 by 1080:

| What | Time |
| --- | --- |
| Crop size changed each frame by `sendcmd`, then scaled | under 1 frame a second: ruled out |
| Crop place only, by `sendcmd` | 0.31 s |
| `zoompan`, zoom and place as expressions of time, to 1280 by 720 at 30 fps | 0.93 s |
| `perspective`, the same as a subpixel warp, then scaled | 3.7 s |
| A drawn pointer moved by `sendcmd`, 6 ring overlays, then `zoompan`, encoded | 1.6 s |
| Still stretches found (today) | 0.15 s |
| The same, with changed regions at a quarter size | 0.22 s |
| The capture's first frame after the box's `start` time, 5 runs | 0.090 to 0.092 s |

## Decision

### Everything is drawn at the stop, from one event log

While recording, bb-box logs events; at the stop it plans the clip in the
plugin, in TypeScript, and the box draws it with ffmpeg, as the captions are
drawn today. Nothing is drawn live, and the capture is as cheap as before.

The log has three sources, all put on the capture's timeline:

1. **The agent's computer use**, logged by the plugin as each action is
   done: clicks (button, count, place, the element's frame), scrolls,
   chords, and typing (a count of characters, the element's frame, and
   whether it is secret). The plugin's clock is put on the box's by a probe
   at the start (the box's time against the midpoint of the round trip, the
   best of two).
2. **A person's input through the relay** while they have control: pointer
   places and buttons, and keys, sorted at once into chords, named keys and
   "typing". Each relay tells the log when it lets go of the keys the viewer
   holds, on a key reset and when the viewer's connection ends, and bb-box
   does on each change of control: the log then forgets every modifier held,
   so a key after them is never read as a shortcut.
3. **The box's pointer sampler**, beside the capture, 30 times a second,
   writing a line only when the place or buttons change.

The log of the first two is in the plugin's memory: a restart of bb-box
while recording loses it, and the clip is made from the sampler alone.

### What is drawn

- **The pointer.** The screen's own pointer is left out of the capture
  where the box samples it, and bb-box draws a larger arrow, about a
  thirtieth of the screen's height, no shadow. It is in the style of
  Bibata Modern, but bb-box's own: no file, path or geometry of Bibata's,
  which is GPL-3.0. Seven corners, each rounded by its own fillet, an
  outline of even width, about a twelfth of its height, and edges softened
  over 0.9 px. It comes in two inks: dark with a light outline, and light
  with a dark outline. It follows the latest source that moved it. A jump, as the agent's clicks
  are, glides over 0.5 s to arrive as the click lands, on the web-demo
  skill's curve, `cubic-bezier(0.23, 1, 0.32, 1)`. A person's motion is
  smoothed over five frames, centred, so it does not lag.
- **Which ink.** The stop's pass that finds still stretches also writes
  the screen's brightness, a grid of 16 by 9 cells, once a second. The
  pointer is dark over a cell lighter than 150 of 255 and light over one
  darker than 105, keeps its ink in between, and never changes for less
  than 0.5 s, so it does not flicker. With no grid, the capture's average
  brightness chooses.
- **Clicks.** A ring grows and fades over 0.4 s where each click lands, in
  the pointer's inks as it is there: a band of its fill between thin edges
  of its outline's ink, blue for a right click, two rings 0.12 s apart for
  a double click. While a button is held, a soft
  disc stays under the pointer, so a drag shows as one.
- **Keys.** A chord or a named key (Enter, Tab, Escape, arrows, F-keys,
  Home, End, Page Up and Down, Delete) shows as a small pill, "Ctrl+S" or
  "⌘K", for 1.2 s after its last press. The same key pressed again within
  0.8 s counts up, "↓ ×3". Typing shows one pill, "Typing", from its first
  key to 0.6 s after its last; Backspace within it is part of it.
- **Where pills go.** Centred at the bottom, above a dock or taskbar, or at
  the top below the captions when the captions are at the bottom or the
  pointer is in the bottom fifth of the picture.
- **Framing**, on by default: the screen inset by 3.5% of the clip's
  width on a plain background, with corners rounded to 1% of the width,
  no shadow. The background is near-black, `#161618`, or near-white,
  `#ececee`, whichever is nearer the capture's average brightness.
  Captions, cut marks and speed marks keep their places, restyled to the
  same flat pills.
- **30 frames a second** for the clip, so the pointer and zoom move
  smoothly; the capture stays at 15.

### Typed text is never shown, and secrets are not zoomed

The log never holds a typed character: the agent's text is reduced to its
length, and a person's printable keys to "typing", before they are logged.
A pill says "Typing", never what was typed.

Whether a key is a shortcut or types a character is decided before
anything is logged, from the modifiers held as each way into the box names
them:

- A shortcut needs a command modifier: Ctrl, Command, Super, or Alt where it
  does not make characters. Its key must be a named key, Space, or one
  ASCII letter, digit or symbol; any other character is typing.
- Shift alone makes characters, and so do AltGr and its kin
  (`ISO_Level3_Shift`, `ISO_Level5_Shift`, `Mode_switch`), Option on a
  macOS desktop, and, on a Windows desktop only, Ctrl with Alt, which is
  AltGr there. A key with any of them is typing, unless it is a named key
  such as an arrow. On Linux, X11 or Wayland, AltGr is a key of its own, so
  Ctrl+Alt+T is a shortcut and shows its pill.
- Through noVNC in a Mac's browser, Option comes as `Mode_switch` or
  `ISO_Level3_Shift`. bb-box's viewer sends a macOS desktop Command and
  Option as its server names them: Meta and Alt, or Alt and Meta where the
  server takes Alt as Command, as Tart's does (its display's `macKeys`).
  The log reads each relay's keys with its desktop's naming.
- An agent's chord with a modifier bb-box does not know, such as AltGr, is
  typing.
- A composition's keys are typing, whatever is held, and never a pill:
  GTK's code point entry on Linux, Ctrl+Shift+U and the hex digits after
  it, until Space, Enter or Escape, or until Ctrl and Shift are let go
  after a digit; IBus's Ctrl+Shift+E emoji entry, until Enter or Escape;
  the Compose key and the next 3 keys; a dead key and the next one; and an
  input method's keys, such as Kanji or Hangul, until Enter or Escape. The
  key that starts one counts too. Letting go of the held keys ends it, as
  for modifiers. When in doubt, a key is a count, not a chord.
- The lock keys are not logged.

Typing shows a pill, and its frame or the text it makes can draw a zoom,
only when the agent types into an element it named by reference, and that
element is not secret. Typing is secret when its element's role says
password or secure (AT-SPI's "password text", macOS's secure text field),
its name says password, passcode, passphrase, PIN, secret, token or API
key, or the text looks like a key: 16 characters or more with no space and
three kinds of character, or a known prefix such as `sk-`, `ghp_`, `AKIA`
or `-----BEGIN`.

Where bb-box cannot tell the field, the typing counts as secret: a person's
typing through a relay, the agent's typing into a window's focused element
or whatever has the focus, and the agent's single keys. Privacy wins over
polish there. What the app itself draws is in the picture as it was, as
today.

### Zoom

On by default; `zoom: false` at the stop turns it off.

- **Focus** comes from real events only: clicks, drags, scrolls and typing
  that is not secret. Typing's focus is its element's frame, or else the
  region that changed on the screen while it went on, or else the pointer.
  Chords keep a zoom but do not move it.
- **Groups.** Events less than 3 s apart form a group. A group's view is
  its events' bounds, a quarter larger on each side, at most 2x and at
  least 1.3x, else no zoom: a single click zooms 1.8x. The view stays on
  the screen.
- **Moves** take 0.9 s, eased in and out (cubic): in, to arrive 0.15 s
  before the group's first event; out, 1.5 s after its last. When the next
  group starts soon after, the view pans to it instead of zooming out.
- **Out early** when a change covers more than 40% of the screen, or
  more than a tenth of it falls outside the view, so a dialog that opens
  elsewhere is seen. The zoom ends as the change happens: the group is
  split there, even with its clicks still to come, and the view moves out
  without panning on. It stays out for at least 1.5 s after it arrives.
  The events after the change are grouped and framed afresh; a group the
  view could reach only after its last event is not zoomed.
- **An action's own result is not outside.** A change that touches the
  window an action was in, within 0.5 s of it, is that action's result and
  keeps the zoom: the typed line, even where the panel's changed title
  merges with it into one region, or a window moving as it is dragged.
  The log carries the window of each of the agent's clicks, scrolls and
  typing; without one, the element's frame or the click's place stands in,
  and a drag's start and end. A change elsewhere, or later, still ends the
  zoom. One that opens over the same window within the half second, as a
  dialog can, keeps it.
- **Still while reading.** A caption's hold, a still frame, holds the view
  too.
- **Cuts keep the motion.** A cut still stretch is trimmed so it never
  takes a pointer glide, a ring, a pill's first second or a zoom move.

### Platforms

| Desktop | Screen's pointer | Sampler |
| --- | --- | --- |
| Linux X11 | left out (`x11grab -draw_mouse 0`) | `XQueryPointer` through Python's ctypes, in every image |
| Linux Wayland | as the recorder draws it | none yet; `bb-box-cursor` could give places, not buttons |
| macOS | left out (`-capture_cursor 0`) | `NSEvent` through JavaScript for Automation |
| Windows | left out (`gdigrab -draw_mouse 0`) | `GetCursorPos` and `GetAsyncKeyState` in PowerShell, in the desktop session |
| iOS, Android | none | the touches, as today |

Where no sampler runs, the screen's own pointer stays in the picture, as
the recorder captures it, and bb-box draws only the rings, pills and zoom.

On macOS and Windows, Cua Driver draws its own agent cursor on the screen
for each action. While recording, bb-box hides it, so it draws the same
pointer on every platform. Cua 0.30 owns the cursor per lifecycle session:
bb-box starts a session of its own, `bb-box-` and 8 hex digits, sets
`set_agent_cursor_enabled` false in it, and names it on each call whose
tool takes a session (38 of Cua 0.30.4's 58 tools). The hiding lasts as
long as the capture: at the stop, or at the 5-minute limit if no stop comes
first, bb-box sets the cursor shown again, and a later connection to the
driver keeps it shown. A failed or cancelled hide leaves the session unused,
so the driver's own cursor shows. Whether the cursor stayed hidden for the
whole capture is kept apart from whether it is hidden now, so a stop after
the limit still draws bb-box's pointer for that capture. bb-box keeps
using the session after the capture, as Cua's element
references belong to the session that read them: ending it made the next
click on a ref fail. A new connection to the driver starts the session
again with the cursor as it was, and so does a call the driver refuses as
the session ended. Measured on a Tart macOS box and a Proxmox Windows box,
both Cua 0.30.4: with the cursor hidden, a click showed no agent cursor in
a screenshot taken at once; shown again, it did, and a ref read while
hidden still clicked.

Where the driver cannot hide it, as one without sessions, or the session
is lost while recording, the clip keeps Cua's cursor, and bb-box draws only
the real pointer, from the samples, and only once it first moves, as when a
person has control: two arrows for one action would mislead. On Windows,
Cua's badge beside its cursor shows the session's name when the cursor
shows, outside recordings.

The first frame comes after the box's `start` time by a lag each platform
sets: 0.09 s on X11, measured over 5 runs; the same on Wayland, and 0.1 s
on macOS and Windows, not yet measured.

### Cost, said at the stop

The stop's answer gives the time of each part: stopping and finding
still stretches, planning, drawing and encoding, and copying.

## Order of work

1. The event log, the planner and its tests; Linux X11; the tool's `zoom`
   and `frame` options and the timings. Done.
2. macOS, on a Tart box. Done.
3. Windows. Done, checked by its scripts on a Proxmox box.
4. The guide and its images. Done.
5. The rounded pointer in two inks, its rings, and Cua's cursor hidden while
   recording on macOS and Windows. Done, the pointer re-recorded on Linux
   X11 and the hiding driven live on macOS and Windows.
6. Wayland: a sampler from `bb-box-cursor`, once its pointer in the
   capture is known.
7. Device boxes: key pills, then zoom. Not in this delivery: their clips
   are as before.

## Rejected

- **Drawing live**, in the capture: it costs the box while it records,
  and a live zoom could not see what comes next.
- **Changing the crop's size each frame**: ffmpeg rebuilds the filters
  after it, at under a frame a second.
- **`perspective` for subpixel zooms**: four times `zoompan`'s time. At
  30 fps `zoompan`'s whole-pixel steps show only while the view moves.
- **Showing typed text**, even shortened: it is the only way a secret
  could reach a clip from bb-box's own drawing.
