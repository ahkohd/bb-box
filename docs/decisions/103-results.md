# 103: Results

Measured on 14 November 2026 on Namespace Macs: Apple M5 Pro (Virtual), 4 cores, macOS 26.3.1, Xcode 26.1.1 with iOS 17.5, 18.6, 26.0, 26.1 and 26.2. BB Box 0.2.4.

## The fault, reproduced

| Step | What BB Box recorded |
| --- | --- |
| A `macos` box on Namespace, kept a few minutes | The iOS Simulator with all five runtimes; video by its hardware H.264 encoder |
| A fresh `macos` box, released 1 s after it was ready | "No iOS Simulator (Xcode 26.1.1 has no iOS runtime); video by software (OpenH264), as it has no hardware H.264 encoder". `ios` left Namespace's kinds, and the doctor said no shared iOS host could start |

The hardware encoder in the bad report was not measured, not "no": that Mac was not counted among those without one.

## When the first runtime list answers

| Measured | First `simctl list runtimes` | Answer |
| --- | --- | --- |
| BB Box's own probe on a fresh Mac, started about 15 s after boot | still running 34 s after boot | five runtimes |
| A list 11 s after a restart | 4 s | five runtimes |
| The probe before this change, started as soon as Namespace's guest agent ran after a restart | the whole probe took 7 s | five runtimes; hardware encoder |
| The probe after this change, started the same way, its encoder check built afresh | the whole probe took 18 s, with no list again | five runtimes; hardware encoder |

No list came back empty. The window is the first list's wait, during which a release cuts the probe short.

## A probe cut short on a real Mac

Each probe ran with the simulator service stopped first, and was killed 1.2 s in, inside its first runtime list. Each printed the chip, macOS and Xcode lines and nothing more.

| Probe output | Read before this change | Read after it | After it, beside the last whole measurement |
| --- | --- | --- | --- |
| Before this change, cut short | No iOS Simulator (Xcode 26.1.1 has no iOS runtime); lends no `ios` slot | Not known | The iOS Simulator with all five runtimes; hardware encoder; measured again at the next chance |
| After this change, cut short | No iOS Simulator (Xcode 26.1.1 has no iOS runtime); lends no `ios` slot | Not known | The same |
| After this change, whole | The iOS Simulator; hardware encoder | The iOS Simulator; hardware encoder | Replaces the last measurement |
