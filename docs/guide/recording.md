# Recordings

An agent can record a desktop box while it works and show you the clip in the thread, rather than describe what it did. When it tests something, it captions each step and its result, so you can see what it checked and whether it passed.

![An agent tests TextEdit on a Mac box: each step and its result are captioned at the top, and a mark in the corner shows where a still stretch was cut](../media/recording.webp)

## What a clip shows

A clip shows the box's whole screen, up to 1280 pixels wide.

Still stretches, where nothing on the screen moves, are cut to half a second, so a long session makes a short clip. Where a cut skips 3 seconds or more, a small mark in a bottom corner shows the real time skipped, such as "▶▶ 14 s later", for about a second. A clip the agent speeds up to 2x or 4x shows its speed in that corner the whole time.

When an agent tests something, it captions each check:

- the step, at the top of the video, with a blue ▶, such as "It opens the notes file in TextEdit"
- the result, under the step, with a green tick if it passed or a red cross if it failed, such as "TextEdit shows notes.txt, empty"

The next step replaces both. Each caption stays up long enough to read, even where still stretches are cut or the clip plays faster.

![A step and its result captioned at the top of a Mac desktop, with marks for a cut and for the clip's speed above the Dock](../media/recording-step.png)

The agent can put the captions at the bottom of the video instead, above the Dock or taskbar, with the step above its result. It does this when what it tests is near the top of the screen, such as a menu bar or a window's title. The marks then go to a top corner.

The page under the clip lists the steps, each with its result and its real time in the recording. Select a step to play the clip from there.

## Asking an agent for a recording

Ask in your own words. For example:

- "Record your test run with each step."
- "Record yourself setting up the app, at 2x."
- "Record the menu bar check, with the captions at the bottom."
- "Record it without cutting the pauses."

Agents record with the `box_record` tool. See [agent tools](../reference/tools.md#box_record).

## Sharing a clip

A clip is an MP4 file in the thread's storage folder. The captions and marks are part of the video, so they stay when you share the file. The list of steps is only on the page in the thread.

## Limits

- A recording runs for at most 5 minutes. It then stops by itself, and the agent still gets the clip.
- Only a desktop box can be recorded: Linux, on X11 or Wayland, macOS or Windows.
- On Windows, still stretches are cut and a clip can play faster, but there are no captions or marks yet.

## What it costs a box

While it records, a box uses about a tenth of a core on an X11 or Windows desktop, a quarter of a core on macOS, and two thirds of a core on Wayland.
