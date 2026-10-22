# Windows on a Mac: QEMU's D-Bus display (#885)

A spike, on 22 October 2026, on a Mac with Apple silicon, with QEMU 11.1.1 as
bb-box runs it (from Nix, with GLib 2.88), and a `windows-arm64-desktop` box
of the image built on 19 October. The prototype is
[`qemu-dbus-display/listener.c`](qemu-dbus-display/listener.c), a throwaway C
program on GLib's GDBus. Build it with
`cc listener.c $(pkgconf --cflags --libs gio-unix-2.0)`.

## What works

- **QEMU runs `-display dbus,p2p=yes` beside its `-vnc`.** The VNC display,
  QMP and the guest stay as they were.
- **A listener connects with no D-Bus daemon.** It works like this:
  - Over QMP, `getfd` passes one end of a socket pair, and
    `add_client {"protocol": "@dbus-display"}` hands it to QEMU.
  - On that peer-to-peer connection, the listener authenticates as the client
    (EXTERNAL) and calls `RegisterListener(h)` on
    `/org/qemu/Display1/Console_0` with a second socket.
  - QEMU is the authentication server on that second socket too, so the
    listener authenticates as the client there as well. It exports
    `/org/qemu/Display1/Listener`, which QEMU then calls.
- **The screen comes as shared memory, on macOS too.** If the listener lists
  `org.qemu.Display1.Listener.Unix.Map` in its `Interfaces` property, QEMU
  sends `ScanoutMap(fd, offset, 1280, 800, stride 5120, x8r8g8b8)`, which
  `mmap` maps, then `UpdateMap(x, y, w, h)` for each region the guest flushes,
  with no pixels in the message.
- **Input goes through D-Bus.** `org.qemu.Display1.Keyboard.Press` and
  `Release` take QEMU key numbers, and `org.qemu.Display1.Mouse.SetAbsPosition`
  moves the pointer.

## Numbers

| | QEMU's VNC | D-Bus listener |
| --- | --- | --- |
| Updates a second, full-screen canvas animation in Edge, which itself drew 64 frames a second | 27.2 (mean gap 36.7 ms, longest 70 ms) | 36.3 (mean gap 27.5 ms, longest 62 ms) |
| Key press to the first update, in Notepad, 20 presses | not measured here | median 34.4 ms, 19.7 to 120.6 ms |
| Pointer move to the first update, 40 moves | | median 35.0 ms, longest 51.6 ms |
| While the screen is still | the refresh slows to every 3 s | nothing comes, and the next change comes at once |

The D-Bus display has no refresh timer: it gives every flush the guest
makes. Windows still flushes about 36 times a second while Edge draws 64.
The cap is probably the virtio-gpu display driver's, as the change in
QEMU's display path did not lift it; this spike did not find out more.

## What it means for bb-box-stream's qemu mode

- **Frames.**
  - Map the scanout's file descriptor.
  - On each `UpdateMap`, copy the rectangle into the encoder's pixel buffer,
    as the VNC reader copies raw pixels now, but without the socket.
    Encoding straight from the mapped memory would tear, as QEMU writes into
    it as the guest flushes.
  - A new `ScanoutMap` comes with a new descriptor at each mode change, so
    the helper maps it again and starts a new encoder session at the new
    size.
- **The pointer.**
  - Windows' display driver draws the pointer into the picture: moves give
    56x46 updates, and QEMU sent `MouseSet` only once, with the pointer off.
    So the video shows the pointer without bb-box-stream.exe's report.
  - Where the pointer is can still come from the input bb-box sends, and the
    picture shows moves Windows makes itself.
- **Input.** Keys and the pointer can go through D-Bus. There is then no need
  to send input through VNC to keep its refresh fast. VNC stays for noVNC
  viewers and anything else that uses it.
- **Resizes.**
  - `Console.SetUIInfo` is accepted, but Windows' driver ignores it. Resizes
    stay as now: a listed mode set in Windows, then a new `ScanoutMap`.
  - Two oddities in the spike: setting 1024x768 gave a 1280x1024 surface, and
    Windows then refused 1280x800 with `DISP_CHANGE_BADMODE`.
- **The D-Bus client.** The helper needs one.
  - Linking GLib ties it to Nix or Homebrew paths on the Mac.
  - A small D-Bus wire implementation in Swift needs: peer-to-peer only,
    EXTERNAL, file descriptors over the socket, and about eight messages.
  - The QMP side is `getfd` and `add_client` on the VM's existing QMP socket.

## Risks

- **Saved warm VMs.** They were saved with `-display none`. Restoring one
  with `-display dbus` was not tried. If it fails, warm VMs are retired once
  on the upgrade, as bb-box already does when QEMU's version changes.
- **A QEMU update.** `org.qemu.Display1` has been stable since QEMU 7, but
  `ScanoutMap` on macOS depends on QEMU's shareable surfaces. A conformance
  check on the fake QEMU, and one live check after each QEMU update, should
  guard it. A Tart update does not touch this path.
- **The guest's cap of about 36 frames a second** stays whatever QEMU sends.

## Go or no-go

**Go, medium: about a week.** The frame rate rises by about a third, from 27
to 36 a second, short of 60. The larger gains:

- no idle slowdown;
- no VNC refresh timer to keep busy with input;
- no VNC stalls on the video path;
- no raw pixels through a socket;
- the pointer in the picture.

The work:

1. A Swift peer-to-peer D-Bus client in bb-box-stream: authentication,
   marshalling of the few messages, and file descriptors.
2. The listener: `ScanoutMap` and `UpdateMap` copied into the encoder's
   buffers, and new sessions at mode changes.
3. Input through D-Bus.
4. `-display dbus,p2p=yes` in `qemuStartScript`.
5. A check that saved warm VMs restore with it.
6. Tests against a fake D-Bus peer.

No-go only if 36 frames a second is not worth a week. Lifting the guest's
cap would be its own spike, on the virtio-gpu display driver.
