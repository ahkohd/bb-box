# 075: A window is zoomed once it has painted, and a result fades

Status: accepted, 9 November 2026.
Supersedes parts of [073](073-recordings-draw-the-pointer-keys-and-zooms-from-the-event-log.md):
easing in on a window as soon as its place is known, a result caption
that stays until the next step, and a warning beside a result for the
same moment.

## Context

A Linux clip zoomed into a window that was still a white rectangle, and
into a Save dialog while it was only half drawn. The step caption from
the first check stayed on through later actions, because nothing
replaced it, and the result stayed for the rest of the clip. The same
cancel was captioned twice, once as a warning and once as a failure.
On a white page the I-beam had a faint square behind it, the bounds of
the cursor picture after ffmpeg laid it on the capture.

## Decision

The camera does not ease in on a window that has just opened until that
window has painted. A change the size of a window, covering what the
zoom is for, holds the previous framing until the change has been quiet
for 0.4 seconds. Where the screen's brightness is known and that region
is still one flat tone, or the picture is still changing from one
reading to the next, the framing stays until a reading has settled.
The zoom is left out if the region stays flat. The move starts only then.

A step caption runs until the next step, so it changes with the step.
A pass or a fail fades after 2.5 seconds. A warning and a result within
1.2 seconds are one caption. When that moment is a cancel the step
asked for, the caption is not a failure.

The cursor is scaled with its alpha and laid on with ffmpeg's automatic
format, so a transparent part of the picture does not leave a square.
A capture that is still an empty file 8 seconds after it starts is
stopped, including its pointer sampler.

## Consequences

A dialog is seen at the previous framing while it paints, then the
camera eases in. A white page that was already on screen is not treated
as unpainted. A long step still needs the agent to send the next step
when the work changes. A cancel the step asked for does not count as a
failed check on the page under the clip.
