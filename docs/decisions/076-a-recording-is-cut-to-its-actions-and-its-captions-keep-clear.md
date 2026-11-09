# 076: A recording is cut to its actions, and its captions keep clear

Status: accepted, 9 November 2026.
Extends [073](073-recordings-draw-the-pointer-keys-and-zooms-from-the-event-log.md).

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

A result is held for reading at most 1 second.

## Consequences

An agent does not pause between steps for the viewer, and a clip of a
focused editor is as tight as one of a still screen. A pointer moving over
a still screen is kept, as the sampler sees it. A change smaller than 0.3%
of the screen in an idle stretch can be cut, such as a small label that
changes long after the action that caused it.
