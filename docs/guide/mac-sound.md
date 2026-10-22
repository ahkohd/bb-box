# Sound and the microphone on Mac boxes

A macOS box on Tart can hear and play sound, so a test can speak to an app and record what it plays. Nobody has to approve anything first.

## The microphone

The box's default input is BlackHole 2ch, a virtual audio device. What is played to its output comes back as the microphone. To feed speech to an app in the box, run:

```sh
say -a BlackHole "Hello from the test"
```

The app listening on the default input hears it. A VM that can be suspended has no audio input device of its own, so BlackHole is its microphone.

## Apps an agent starts

An app that `box_run` starts in the desktop session (`desktop: true`) has the microphone, the camera and the system's audio without a prompt. bb-box's launcher starts it, and macOS treats the launcher as the app's responsible process, as it treats Terminal for what Terminal starts.

An app opened with `open -a` is its own responsible process, so macOS asks about it. Computer use can answer the prompt.

## Where this comes from

The macOS image sets this up when it is made. See [the Tart setup guide](../../setup/tart/README.md#macos).

## On a Mac of the SSH host pool

A Mac of the SSH host pool has BlackHole 2ch as its input too: its setup
installs it, and `say -a BlackHole` feeds it speech in the same way. On a
Mac with System Integrity Protection off, a command `box_run` runs has the
microphone and the camera with no prompt. A program started as its own
responsible process, such as an app opened with `open`, needs `box_grant`
for them, and `box_grant`'s `system-audio` to record the system's audio.
The Mac has a camera only if one is attached, such as a USB webcam.
