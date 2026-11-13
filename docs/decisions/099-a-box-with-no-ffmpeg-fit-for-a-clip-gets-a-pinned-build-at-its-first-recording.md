# 099: A box with no ffmpeg fit for a clip gets a pinned build at its first recording

Status: accepted, 13 November 2026. Extends [059](059-agents-record-their-desktop-box-with-box-record.md) and [063](063-device-boxes.md). Measurements are in [099-results.md](099-results.md).

## Context

`box_record` makes its clip inside the box, with the box's own ffmpeg: it frames a device's video, cuts still stretches, draws the captions and encodes the MP4. A desktop image brings an ffmpeg, as its capture needs one. A device box's host did not always have one:

- the Android template has no ffmpeg, so an Android box gave no clip at all
- a shared iOS host on Namespace has no ffmpeg, so an iOS slot there gave no clip
- a Mac of the SSH host pool has Homebrew's ffmpeg, from its setup script

Every Mac, with Homebrew's ffmpeg or with none, also lost the captions. That was not the ffmpeg: a Mac draws each caption with AppKit through osascript, and the script read its list of words with `String()` of an NSString. On macOS 26 and 27 that gives `[id __NSCFString]`, not the text, so the words and their font were nil, and osascript ended on "object cannot be nil".

A recording must work on every kind, with no image rebuild and no root on a shared host, where a slot's user cannot install anything.

## Decision

- When a recording starts, on a device box and on a Linux or macOS desktop, BB Box checks the box's own ffmpeg and ffprobe. The pair serves when ffmpeg has libx264 and the overlay, geq, freezedetect and tpad filters, and on Linux drawtext, which draws the captions there, and when the two encode one frame with libx264 and read it back, each within 30 seconds. A Mac draws its captions with AppKit, so Homebrew's ffmpeg serves.
- When none fits, BB Box fetches its pinned build for the box's OS and architecture. It checks each download against its SHA-256, makes the test frame, records the two files' checksums, and puts the pair in place whole by renaming one folder, `~/.bb-box/ffmpeg/<build>`. A failed step is an error, and no pair is offered. An earlier build that still works stays until the new one is in place, and serves if the fetch fails. It needs no root.
- The cache folder is the box user's alone, mode 700. BB Box refuses a cache folder that is a link or another user's. At each recording it uses a cached build only while its files match the checksums taken when it was put in place, and the build makes the test frame.
- Readiness says which pair it chose, by its paths, and the scripts that make the clip run that pair. Only a start fetches: a stop chooses among the box's own and cached pairs.
- The pinned builds are GPL builds, fetched from their publishers by the box itself. BB Box does not redistribute them:
  - Linux on x86_64 and arm64: BtbN's FFmpeg-Builds 9.0.2, from the dated GitHub release that the Windows images already pin
  - macOS on arm64: Martin Riedl's FFmpeg builds 9.0.2, which link only the system's frameworks
- A device box that cannot get a fit ffmpeg refuses the start, with the reason and what to do, before the device records. A desktop whose ffmpeg cannot draw the captions starts anyway, as its capture works, and its answer says the clip will have no step captions, and why. A desktop with no ffmpeg at all is refused at the start, as before: it has nothing to capture its screen with, and its image brings ffmpeg.
- The Mac's caption script reads its words with `.js`, and treats a nil font as missing, falling back to the system font.
- The doctor reports recordings for each kind: what `box_record` makes there, what it needs, and what the kind's last recording start found, including a Windows desktop's, which uses its image's ffmpeg.
- The clip's page in the thread fits its frame: the video keeps at least 55% of its height, with its shape, and the step list scrolls in the rest. An upright clip's frame, its steps included, is at most 460 pixels tall, which fits the chat of a window 800 pixels tall, 570 pixels above the message box, with the agent's rows under it; so a phone's clip shows whole in the chat and in the side panel. A landscape clip keeps its height, and its step list shows up to 4 steps.

## Consequences

- The first recording on an Android box takes about 9 to 11 seconds more, to fetch and unpack 151 MB. On a Namespace iOS slot it took 1.4 to 2 seconds for 57 MB. Each new slot user fetches again, as a slot's home goes with it.
- A box must reach github.com, for Linux, or ffmpeg.martin-riedl.de, for macOS, the first time. One that cannot is told so at the start.
- The fetched build takes about 345 MB of disk on Linux and 132 MB on macOS.
- Each start and stop checks the chosen pair again: the test frame, and for a cached build its checksums. On Linux that rehashes 345 MB.
- A new pinned build is a change to `src/core/record-ffmpeg.ts`, with its URLs and SHA-256 sums. The decision to draw captions in BB Box itself, which would remove drawtext and AppKit from the box, is left for later.
