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

- When a recording starts, on a device box and on a Linux or macOS desktop, BB Box checks the box's own ffmpeg and ffprobe. They serve when they have libx264 and the overlay, geq, freezedetect and tpad filters, and on Linux drawtext, which draws the captions there. A Mac draws its captions with AppKit, so Homebrew's ffmpeg serves.
- When none fits, BB Box fetches its pinned build for the box's OS and architecture into the box user's home, `~/.bb-box/ffmpeg/bin`, checks each download against its SHA-256, and keeps it for later recordings. It needs no root. The clip's scripts put that folder first on their `PATH`.
- The pinned builds are GPL builds, fetched from their publishers by the box itself. BB Box does not redistribute them:
  - Linux on x86_64 and arm64: BtbN's FFmpeg-Builds 9.0.2, from the dated GitHub release that the Windows images already pin
  - macOS on arm64: Martin Riedl's FFmpeg builds 9.0.2, which link only the system's frameworks
- A device box that cannot get a fit ffmpeg refuses the start, with the reason and what to do, before the device records. A desktop starts anyway, as its capture works, and its answer says the clip will have no step captions, and why.
- The Mac's caption script reads its words with `.js`, and treats a nil font as missing, falling back to the system font.
- The doctor reports recordings for each kind: what `box_record` makes there, what it needs, and what the kind's last recording start found.
- The clip's page in the thread fits its frame: the video takes the height the step list leaves and keeps its shape. A preview's video is at most 560 pixels tall, so a phone's portrait clip shows whole in the chat and in the side panel. A landscape desktop clip keeps its height.

## Consequences

- The first recording on an Android box takes about 9 to 11 seconds more, to fetch and unpack 151 MB. On a Namespace iOS slot it took 1.4 to 2 seconds for 57 MB. Each new slot user fetches again, as a slot's home goes with it.
- A box must reach github.com, for Linux, or ffmpeg.martin-riedl.de, for macOS, the first time. One that cannot is told so at the start.
- The fetched build takes about 345 MB of disk on Linux and 132 MB on macOS.
- A new pinned build is a change to `src/core/record-ffmpeg.ts`, with its URLs and SHA-256 sums. The decision to draw captions in BB Box itself, which would remove drawtext and AppKit from the box, is left for later.
