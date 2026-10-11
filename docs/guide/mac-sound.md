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
