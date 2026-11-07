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
   "typing".
3. **The box's pointer sampler**, beside the capture, 30 times a second,
   writing a line only when the place or buttons change.

The log of the first two is in the plugin's memory: a restart of bb-box
while recording loses it, and the clip is made from the sampler alone.

### What is drawn

- **The pointer.** The screen's own pointer is left out of the capture
  where the box samples it, and bb-box draws a larger arrow, about a
  thirtieth of the screen's height, black with a white edge, no shadow. It
  follows the latest source that moved it. A jump, as the agent's clicks
  are, glides over 0.5 s to arrive as the click lands, on the web-demo
  skill's curve, `cubic-bezier(0.23, 1, 0.32, 1)`. A person's motion is
  smoothed over five frames, centred, so it does not lag.
- **Clicks.** A ring grows and fades over 0.4 s where each click lands:
  white with a dark edge for a left click, blue for a right click, two
  rings 0.12 s apart for a double click. While a button is held, a soft
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
A pill says "Typing", never what was typed. A key with only Shift is
typing, and so is Option with a key on a Mac, which types characters.

Typing is secret, and shows no pill and draws no zoom, when its element's
role says password or secure (AT-SPI's "password text", macOS's secure text
field), its name says password, passcode, passphrase, PIN, secret, token or
API key, or the text looks like a key: 16 characters or more with no space
and three kinds of character, or a known prefix such as `sk-`, `ghp_`,
`AKIA` or `-----BEGIN`. What the app itself draws is in the picture as it
was, as today.

### Zoom

On by default; `zoom: false` at the stop turns it off.

- **Focus** comes from real events only: clicks, drags, scrolls and typing.
  Typing's focus is its element's frame, or else the region that changed
  on the screen while it went on, or else the pointer. Chords keep a zoom
  but do not move it.
- **Groups.** Events less than 3 s apart form a group. A group's view is
  its events' bounds, a quarter larger on each side, at most 2x and at
  least 1.3x, else no zoom: a single click zooms 1.8x. The view stays on
  the screen.
- **Moves** take 0.9 s, eased in and out (cubic): in, to arrive 0.15 s
  before the group's first event; out, 1.5 s after its last. When the next
  group starts soon after, the view pans to it instead of zooming out.
- **Out early** when a change covers more than 40% of the screen, or
  more than a tenth of it falls outside the view, so a dialog that opens
  elsewhere is seen.
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
for each action, so the picture has the agent's pointer already. There
bb-box draws only the real pointer, from the samples, and only once it
first moves, as when a person has control: two arrows for one action would
mislead. Hiding Cua's cursor while recording, so bb-box draws the agent's,
is for later: Cua 0.30 can, per session.

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
5. Wayland: a sampler from `bb-box-cursor`, once its pointer in the
   capture is known.
6. Device boxes: key pills, then zoom. Not in this delivery: their clips
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
