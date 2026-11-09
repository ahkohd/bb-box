# 079: A click ring fades, and a large field zooms on its line

Status: accepted, 8 November 2026.
Supersedes parts of [073](073-recordings-draw-the-pointer-keys-and-zooms-from-the-event-log.md):
the soft disc under a button held still, and a typing zoom that uses
the whole field when that field would not zoom.

## Context

A Linux clip drawn the 073 way left a grey disc under the I-beam for
several seconds. The sampler had seen the button stay down without the
pointer moving, and that counted as a drag, so the disc stayed. The same
clip never eased in. The text field was the whole editor, and a change
that repainted the field was taken as the line, so the frame was too
large to zoom.

## Decision

A click's ring is a band. It grows and fades within 0.4 seconds, and the
picture turns it off with the filter, so a missed command cannot leave it
on. It is never a filled disc.

A press is a drag only when the pointer moves. A button held still is a
click: one ring, no disc. The disc shows only while the pointer is moving
with the button held.

Typing still frames the region that changed, and keeps that region in the
picture. A change that repaints most of a tall field is not that region.
When the field itself would zoom below 1.3x, the focus is a line at the
caret, narrow enough to zoom, so a button, a field and a dialog each ease
in, and the camera eases out between them.

## Consequences

A long line that the screen really changed is still contained, even below
1.3x, so it is not cropped. A field bb-box cannot see a line in is framed
on the caret rather than left at the whole screen. The guide says the
same.
