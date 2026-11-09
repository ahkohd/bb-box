# 076: A recording is cut to its actions, and its captions keep clear

Status: accepted, 9 November 2026.
Extends [073](073-recordings-draw-the-pointer-keys-and-zooms-from-the-event-log.md), and supersedes its
cutting only still stretches where bb-box draws the pointer, captions that
keep their places, and the 1.5 seconds out before typing into a field just
clicked. Supersedes parts of [075](075-a-window-is-zoomed-once-it-has-painted-and-a-result-fades.md):
a result that fades after 2.5 seconds, and a zoom left out when its window
is one flat tone after a click in its field.

## Context

A taste review of a 60 second Linux clip, made by `box_record` from an
agent turn, scored it 5 out of 10. The pointer, rings, pills and frame were
close to a polished screen recorder. The editing was not: about 25 seconds
showed nothing happening.

Still stretches were cut only where no pixel changed for a second. A text
field's caret blinks every half second, so a focused editor was never
still, and a recording of one kept every pause the agent took between its
calls. A result then stayed held for up to 2.5 seconds of reading time.

## Decision

### Idle stretches are cut

Where bb-box draws the pointer from its samples and the stop's analysis
ran, a stretch is idle when nothing happens in it for more than a second:
no caption, no click, scroll, key or typing, no pointer movement, and no
change on the screen larger than 0.3% of it. A blinking caret, a clock or
a spinner is smaller than that. Each idle stretch keeps its first half
second, as a still stretch does, and a quarter of a second before what
comes next. Glides, rings, drags, pills' first second and camera moves are
never cut, as before. This replaces the still stretches there; elsewhere,
the still stretches are cut as before. `stills: "keep"` keeps both.

A result, or a warning in its place, is held for reading at most 1 second,
and a warning stays until the next step as a result does.
A step's caption stays up until the next step, so its reading time runs
until then, through its result and that result's hold: a step is held only
when that whole span is shorter than its reading time. A device's note of
a lost stretch is still held for its full reading time.

### The clip starts on the first action and fades out after the last

Where idle stretches are cut, the clip starts 0.2 seconds before its first
caption, input, pointer movement or notable change, keeping the glide to a
first click. It ends 1.5 seconds after the last result, input or pointer
movement: the moment is held for 1 second, then the whole picture, captions
too, fades over 0.5 seconds to the frame's background, or black without a
frame. That last result is not held further. A recording stopped sooner is
padded with its last frame. Trimming the ends shows no skip mark. With
`stills: "keep"` the ends stay, and the clip still fades out.

### Captions and changes are placed to the frame

A caption is placed on the capture's own timeline, the platform's
first-frame lag after the box's start time, as inputs already were. The
pass that finds what changed reads every frame of the capture rather than
four a second, and the brightness is still read four times a second. Before,
a change could be placed up to 0.125 seconds after the frame it came from,
and a caption 0.09 seconds late, so a result held as the agent gave it could
show the effect of its next action. Measured on the Linux showcase in a
Docker box of 8 cores, 11.3 seconds recorded at 1280 by 720: the pass took
0.18 seconds before and 0.24 seconds now, over 3 runs each, and found 40
changes instead of 24. Ctrl+A was logged at 3.862 seconds and selected the
line at 3.867, and Cancel at 5.396 seconds closed its dialog at 5.400: input
and picture agree to the frame. On X11, ffmpeg's own first-frame time came
0.088 to 0.090 seconds after the start time, over 3 runs, as 073 measured.

### Typing into a clicked field is zoomed

Typing that follows a click in the same field within 2 seconds is framed on
that field, as soon as the window had settled before the click. What
changes on the screen after the click, such as the typed line, the window's
title and a panel's list of windows in one changed region, is not taken
for the window painting, and a flat white editor is not taken for a blank
window. Only the part of a changed region inside the field is the typed
text.

Whether a window has painted is judged on the clicked window's own frame
when the opening covers it, not on the changed region, which also takes in
a panel's list of windows and so is mostly bare desktop: a small window on a
dark desktop read as blank, and its zoom was left out. Typing into a field
just clicked eases in as soon as the camera is back out from a change
elsewhere, without the 1.5 seconds that other zooms wait, so the line is
framed as it lands.

A zoom is held for 1.5 seconds after it lands, even when waiting for paint
made it land after its group's last event. A zoom that would be seen for
less than 0.6 seconds before something opens elsewhere is left out, so it
neither pumps nor keeps the camera out for the next one. The paint check
reads the screen from the window's opening, so a window that painted at
once is zoomed without waiting for a later reading.

### A move ends by the result it would freeze

A result's hold freezes the picture, camera and all. A camera move that a
result would interrupt, 0.3 seconds or more after the move starts, now ends
at that result, so the held frame is a settled framing rather than half a
zoom. The move is then shorter than 0.9 seconds, at least 0.3.

### A window resized as it opens is still opening

A window-sized change that overlaps a window's opening and comes within
1 second of it is part of that opening, as when an app restores its size or
an agent resizes the window it launched. The previous framing holds until
the last such change has been quiet for 0.4 seconds, as 075 holds it for
paint.

### A result stays, and captions crossfade

A result stays until the next step starts, or the clip ends. With idle
stretches cut, that is seldom more than a few seconds, and a result that
fades early leaves its step alone, as if it were still pending. Each
caption, warning, key pill and skip mark fades in and out over 0.2 seconds,
so one step crossfades into the next. The speed mark, shown all along, does
not fade. Each fading pill is its still image looped from its own start, so
the box decodes it only while it shows.

### No Typing pill for a line a result takes over

When a typing call's text lands within 0.1 seconds, as a paste or an
accessibility insert does, and a result follows within 0.5 seconds, its
Typing pill is left out. It would arrive with the result and linger as a
third row with nothing to accompany.

### A click that closes its window rings before it goes

A click's window goes on the click when a change covering most of it comes
from 0.1 seconds before the click to 0.5 seconds after, and the agent's next
action in a window is in another one, or there is none. A window that
appears or is uncovered then, and is acted in next, is not going. The click
is then placed so its ring ends one frame of the capture before that
change: at most 0.5 seconds earlier, and at least
0.1 seconds after the action before it and a frame after the window last
opened or changed size. The pointer's glide, the ring and
the hand move with it. The ring's stages from the change on are not drawn,
and a ring with none left is not drawn at all.

### The camera pans rather than pumps

After a zoomed group, the camera stays in and pans to the next group when
the next view overlaps this one and the time between them, less the idle
stretches that are cut, is at most the group gap of 3 seconds. Views that do
not overlap still pan only within 1.5 seconds, as before. If the camera
stays in for a group that is then left out, such as a window that never
paints, it zooms out from where it would have.

### Each step's captions take the clearer side

The captions of a step, from its step caption to the next one, go where
they cover less of what changes during it, as the camera shows it: the
changed regions larger than 0.3% and at most half of the screen, the
elements clicked, and the typed text. The side the agent asked for at the
start is kept unless it covers something and covers more than 1.25 times
what the other side would. Key pills, warnings and the skip marks move with
the captions. The overlap is measured against a guess of the caption's
width, 0.55 of the font size a character, as the box measures the text only
when it draws the pills.

## Consequences

The Linux showcase's typing, Ctrl+A and Ctrl+S steps are readable at 1280
pixels wide; before, a late zoom on a closed window kept the camera out
until 4 seconds after the typing.

A dialog whose name field is at the top has its step at the bottom, and a
change that fills more than half the screen counts for neither side.

An agent does not pause between steps for the viewer, and a clip of a
focused editor is as tight as one of a still screen. A pointer moving over
a still screen is kept, as the sampler sees it. A change smaller than 0.3%
of the screen in an idle stretch can be cut, such as a small label that
changes long after the action that caused it.
