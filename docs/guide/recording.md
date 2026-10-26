# Recordings

An agent can record a desktop box, or the phone or tablet of a device box, while it works and show you the clip in the thread, rather than describe what it did. When it tests something, it captions each step and its result, so you can see what it checked and whether it passed.

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

## Recording a device

On an iOS or Android box, a recording shows the device's own screen, not the host's desktop. It needs no viewer open in the panel.

- The device is drawn in its frame, as the panel draws it, and turns in the clip when it turns. A foldable shows its fold.
- Each touch, by the agent or by you, shows as a circle where it landed.
- The captions sit in a band above the device, or below it, so they never cover the app.
- The clip is at most 1280 pixels wide and 1600 pixels tall. When the device turns during a recording, the clip is sized for both shapes, so the device keeps one size throughout.
- If the device restarts, or bb-box's device server in the box restarts, the clip holds the last picture across the gap and says what happened there, such as "The device restarted here". If the box stops, the recording ends there.

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
- Only a desktop box or a device box can be recorded: Linux, on X11 or Wayland, macOS, Windows, iOS or Android.

## What it costs a box

While it records, a box uses about a tenth of a core on an X11 or Windows desktop, a quarter of a core on macOS, and two thirds of a core on Wayland. A device box copies the stream it already encodes for the panel, which added about 0.2% of a core on an iOS box. An `ios` box's recording asks for its device's video at two thirds of the device's size at least, which still fills the clip, at most 1,600 pixels tall; a panel open on it at a larger size makes it larger. The work comes at the stop: framing a minute of an iPhone took 5 to 8 seconds there, and making the clip about 2 more.
