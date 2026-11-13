# 099 results: ffmpeg for clips on every kind

Measured on 13 November 2026, on real boxes, with BB Box 0.2.0's tool for the start, the captions and the device's actions, and this decision's code for the stop.

## What each kind had, and what 0.2.0 made

| Kind and where | The box's ffmpeg | 0.2.0's stop |
| --- | --- | --- |
| android, Proxmox QEMU, Ubuntu 24.04, x86_64 | none | "has no ffmpeg, which making a device's clip needs" |
| ios, shared slot on a Namespace Mac, macOS 26.3.1 | none | "has no ffmpeg, which making a device's clip needs" |
| ios, shared slot on a Mac of the SSH host pool, macOS 27.2.1 | Homebrew 9.0.2, without drawtext | a clip with no captions |
| macos-desktop, Namespace, macOS 26.3.1 | Homebrew 8.0.1, without drawtext | a clip with no captions |
| linux-desktop-cpu, Docker, Ubuntu 24.04 | Ubuntu's 6.1.1, with drawtext | a captioned clip |

On both Macs, the caption script ended on `NSInvalidArgumentException: -[__NSArrayM setObject:atIndexedSubscript:]: object cannot be nil`. In osascript there, `String()` of the NSString it read gave `[id __NSCFString]`, while `.js` and `ObjC.unwrap` gave the text.

## The pinned builds

| Build | Download | Unpacked | ffmpeg's drawtext and libx264 |
| --- | --- | --- | --- |
| BtbN 9.0.2, linux64, GPL | 151,017,172 bytes, `.tar.xz` | ffmpeg and ffprobe, 173 MB each; glibc and the kernel only | both |
| BtbN 9.0.2, linuxarm64, GPL | 127,445,692 bytes | not run here | |
| Martin Riedl 9.0.2, macOS arm64 | 28,395,699 and 28,317,701 bytes, `.zip` each | 66 MB each; system frameworks only, signed with the hardened runtime | both |

## With this decision

| Kind and where | ffmpeg for the clip | Fetch | Stop: frame or analyse | Make the clip | Clip |
| --- | --- | --- | --- | --- | --- |
| android, Proxmox QEMU, 8 cores | fetched 9.0.2 | 9.2 s, 10.5 s in an earlier run | 3.1 s | 0.8 s | 10.0 s of 64.5 s, 1080x1600, 2 steps captioned |
| ios, Namespace slot | fetched 9.0.2 | 1.4 s, 2.0 s earlier | 2.5 s | 1.2 s | 9.1 s of 56.1 s, 1080x1600, 2 steps captioned |
| ios, SSH host pool slot | its own Homebrew 9.0.2 | none, 0.1 s to check | 2.0 s | 0.8 s | 5.8 s of 56.3 s, 1080x1600, 2 steps captioned |
| macos-desktop, Namespace, 4 cores | its own Homebrew 8.0.1 | none | 1.8 s | 2.0 s | 6.9 s of 39.6 s, 1280x834, 2 steps captioned |
| linux-desktop-cpu, Docker, 4 cores | its own 6.1.1 | none | 1.2 s | 7.8 s | 6.5 s of 38.3 s, 1280x758, 2 steps captioned |

A second recording on the Android box found the fetched build kept, in 0.04 s. A slot user on a shared Mac fetched with no root.
