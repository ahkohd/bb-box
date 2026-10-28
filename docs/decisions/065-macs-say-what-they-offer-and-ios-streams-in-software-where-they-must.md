# 065: Macs say what they offer, and iOS streams in software where they must

Status: proposed, 28 October 2026. Extends [064](064-ios-shared-hosts.md):
its decision 14, "Namespace hosts stay off", and its unit 7. Measured on a
Namespace Mac on 28 October 2026; the raw numbers are in
[measurements.txt](065-macs-say-what-they-offer/measurements.txt), and the
harness is [software.ts](../../scripts/measure/ios/software.ts).

## Context

064 turned Namespace hosts off by hand, because the Namespace Mac M18
measured, an Apple M4 Pro VM, had no H.264 encoder: idb's stream failed
with VideoToolbox error -12915, and an ios box there could not be watched.
The owner's direction of 28 October 2026: shared iOS hosts must not be off
on Namespace. bb-box should know what each Mac can do by measuring it, and
stream in software where a Mac has no encoder, as Android does.

## What was measured

On a Namespace Mac taken on 28 October 2026, 6 cores and 14 GiB, macOS
26.3.1, Xcode 26.1.1, an iPhone 17 Pro on iOS 26.2, busy with a page that
changes every frame:

- **This Namespace Mac has a hardware encoder.** It is an Apple M5 Max VM,
  not M18's M4 Pro. A VideoToolbox session that requires hardware opened
  and gave 141 full-size frames a second, 398 at a half. idb's stream gave
  two busy devices 54 to 57 frames a second at a half and at full size.
  So Namespace gives Macs of either kind, and only a measurement of each
  Mac can say which.
- **idb's raw stream is too costly to encode from.** idb sends BGRA frames
  (format `rbga`) with rows padded to 64 bytes; its format 4 is H.264, not
  I420. Through its gRPC socket into Node and on to `bb-box-h264`, one
  device took 1.4 cores at a half (idb_companion 0.58, Node 0.60, the
  encoder 0.21), and full size reached only 11 to 18 frames a second, with
  taps shown 282 to 449 ms after they were sent. The window, frame size and
  encoder made no difference: idb's transfer of about 200 MB a second is the
  limit.
- **The device's framebuffer can be read directly.** CoreSimulator gives
  each booted device's screen as a shared IOSurface, 1206x2622 BGRA, as
  idb_companion reads it. `bb-box-h264` reads it, scales it to the step with
  vImage, converts it to I420 and encodes it, in one process, with no idb
  stream and no copy through Node. Two busy devices at once, x264, 1
  thread:

| Step | Frame | Frames a second | Cores, each | Encode, median | Mbit/s |
| --- | --- | --- | --- | --- | --- |
| A third | 402x872 | 45.8 and 46.0 | 0.10 | 2.0 ms | 3.1 |
| A half | 602x1310 | 46.4 and 46.3 | 0.17 | 3.5 ms | 5.3 |
| Two thirds | 804x1748 | 47.2 and 47.2 | 0.27 | 5.7 ms | 6.3 |
| Full | 1206x2622 | 50.7 and 50.5 | 0.45 | 8.9 ms | 6.8 |

  One device alone with OpenH264 gave 48 to 51 frames a second at each
  step, 0.14 to 0.63 of a core. The first frame came 123 to 145 ms after
  the encoder started. The frames a second are the device's own: the busy
  page drew 46 to 53 a second in this VM. The worst gap between frames was
  29 to 41 ms.

Not yet measured: a tap's time to the panel through the software path, and
the same on the Tart Mac with hardware turned off. Both are B's live check;
a tap's frame cannot be told apart in the encoder's output, so it is timed
in the panel, as 064's unit 1 timed it.

## Decisions

### A. Each Mac says what it offers, measured

1. **A capability report per Mac,** in `src/core/mac-capabilities.ts`: can
   it run the iOS Simulator (Xcode and an available iOS runtime), has it a
   hardware H.264 encoder, and has it a software one (`bb-box-h264`, with
   x264 or OpenH264). Each part is yes, no or not known yet, with the words
   that say why and when it was measured.
2. **A probe measures it,** where the devices run: a short script and a
   VideoToolbox check in Swift, compiled once on each Mac and kept by its
   hash. The check opens a session that requires hardware and encodes a few
   frames, about a tenth of a second, so it can run while streams run. A
   software encoder is one that `bb-box-h264 --version` names.
3. **Where each backend measures:** the pool on each Mac at its survey, as
   the box user that slots run beside; Tart on each Mac, whose encoder its
   VMs share (064's E1), and in the iOS image's VM at the image's check,
   which its record keeps and which wins over the Mac's; Namespace on each
   Mac it starts, kept per chip, since its Macs come and go.
4. **Shown everywhere a person or agent looks.** box_list's offers say what
   the Macs behind them offer, without naming a Mac; box_status says how an
   ios box's video is encoded; the doctor has a check per Mac.
5. **Used by placement.** A backend lends ios slots only on a Mac that
   can run the iOS Simulator and stream it, by hardware or software. A Mac
   not yet measured is measured before it lends.
6. **Used by the encoder ledger.** A Mac with no hardware encoder has no
   hardware budget; its streams count against its CPU (B).

### B. A software encoder for iOS streams

7. **The frame source is the device's framebuffer,** read by
   `bb-box-h264 --simulator <udid>`, not idb's raw stream. It polls the
   surface's seed up to 60 times a second and encodes only a changed
   frame, or a key frame when asked. The step changes by a command on its
   input, `Z`, which restarts the encoder at the new size with a key frame.
   This uses CoreSimulator's private interface, as idb_companion does; a
   later Xcode that changes it fails the probe, and the Mac then streams by
   hardware only, or reports that it cannot stream.
8. **Built on the Mac, with the same licence choice as Android:** x264
   where the operator's build compiles it from source, OpenH264 from Cisco's
   binary otherwise. bb-box never ships an x264 binary. The iOS image, the
   pool's setup and a Namespace host's start build it with
   `setup/android/build-h264.sh`, which now builds on macOS on arm64.
9. **Hardware first, software as the fallback.** The device server uses
   idb's H.264 stream where the Mac has a hardware encoder, and the
   framebuffer and `bb-box-h264` where it has none, or where idb's stream
   fails with a VideoToolbox error. A setting forces software, for tests.
10. **The ledger counts a software stream as CPU.** Its cost is measured:
    the encoder reports each frame's time, and the device server sends
    the cores it used over the last 10 s. A Mac's software budget is a
    quarter of its cores; over it, passive viewers step down first, in
    064's order. For sizing (064 F-9 item 7) before any stream, a slot on a
    software Mac is a stream at a half at 60 frames a second, about 0.2 of
    a core (the table above), beside a busy device's 1.3.

### C. Namespace hosts (064 unit 7)

11. **On by the capability report, not a hand switch.** The Namespace
    backend lends slots when its Macs can run the iOS Simulator and stream,
    as last measured. `ios-hosts-on` stays as an operator's way to turn
    them off, true by default. A new host's Mac is measured before its
    first slot; a Mac that cannot stream is deleted and the report updated.
12. **A host is made as 064 says:** idb_companion, the lists and seeds from
    their pins, its runtime checked and named, `bb-box-h264` built, the
    helper installed; `ending` an hour before the plan's longest life; the
    workspace's only Mac taken by it, which the Namespace guide says.

## Consequences

- 064's decision 14 is superseded: Namespace hosts are on wherever a
  Namespace Mac can stream, by its own encoder or in software.
- A Mac without an encoder streams at about 46 to 51 frames a second at any
  step, for 0.1 to 0.45 of a core a busy device, so a 6-core Namespace Mac
  holds about 3 busy devices, as 064's `most` for Namespace already says.
- The software path rests on CoreSimulator's private interface. The probe,
  not a version check, guards it.
- `064-results.md` gains a section per phase, as earlier units did.
