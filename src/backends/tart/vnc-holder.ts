// The VNC holder for a Tart macOS VM's run (#406). Tart's VNC server, the
// Virtualization framework's, crashes the VM on a second VNC connection in a
// run, even after the first has closed. So a holder on the Mac makes the
// run's one connection, keeps it until the run ends, and serves any number
// of viewers on a unix socket that only the Mac's host user can open. It
// never connects again; a new run gets a new holder (holderScript).
//
// It reads each of the server's messages whole, and keeps exactly one update
// request outstanding, as a VNC viewer does, whether anyone watches or not:
// Tart answers requests in order, and one for changes only when the screen
// changes. It draws each update on its own copy of the screen, CopyRect too,
// and notes for each viewer what changed since its last update. A viewer gets
// an update only when it has asked for one, as noVNC does after each, with
// all it missed, from the screen as it is: so a slow viewer gets fewer
// updates that are current, rather than a queue (056). A viewer that joins
// has the whole screen to come, so its first update is the screen, and the
// holder never asks Tart for anything for a viewer. It asks for the whole
// screen only at the start and after a new size. Viewers' input goes
// upstream as it is.
//
// Tart's server does not send the pixel format a client asks for: red and
// blue came out swapped. So the holder keeps the server's own format, as its
// ServerInit gives it, asks for raw pixels, and puts each pixel's bytes in
// noVNC's order itself. A viewer gets them as Zlib rects, on a zlib stream of
// its own, with the cursor's pixels in that order too.
//
// Python 3.9, as Xcode's command line tools give it, with nothing else. It
// reads the run's VNC URL from Tart's output, so the password is never on a
// command line, and answers VNC authentication with DES through openssl.

/** The holder's source, written to the Mac for each run. It has no line `BBBOX_HOLDER`, which ends it in holderScript's heredoc. */
export const VNC_HOLDER_PY = String.raw`# bb-box's VNC holder for one run of a Tart macOS VM (#406).
#
#   python3 holder.py <tart run output> <socket> <status file>
#
# The status file says "ready <width>x<height>" once viewers can connect,
# and "ended <reason>" once the holder has stopped.
import asyncio
import os
import re
import struct
import subprocess
import sys
import zlib

# noVNC's: 32 bits a pixel, depth 24, little-endian true colour, 8 bits a channel, red lowest: bytes red, green, blue, unused.
PIXEL_FORMAT = bytes([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0])
# CopyRect, Raw, DesktopSize, LastRect, Cursor. Tart's server ends the VM on an update request without DesktopSize.
ENCODINGS = [1, 0, -223, -224, -239]
ZLIB = 6
# A viewer's changed rects, at most, before they are the one rect around them all.
MAX_CHANGED = 32


def vnc_response(challenge, password):
    # DES keyed by the password's first 8 bytes, each byte's bits reversed. Triple DES with the key three times is DES.
    key = bytearray(8)
    given = password.encode()[:8]
    key[: len(given)] = given
    key = bytes(int("{:08b}".format(byte)[::-1], 2) for byte in key)
    done = subprocess.run(
        ["openssl", "enc", "-des-ede3", "-nopad", "-K", (key * 3).hex()],
        input=challenge, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True,
    )
    return done.stdout[:16]


def inside(rect, other):
    return other[0] <= rect[0] and other[1] <= rect[1] and rect[0] + rect[2] <= other[0] + other[2] and rect[1] + rect[3] <= other[1] + other[3]


class Viewer:
    def __init__(self, writer):
        self.writer = writer
        # What changed since its last update, which it has not had.
        self.changed = []
        self.resized = False
        self.cursor = True
        # It asked for an update and has not had it.
        self.asked = False
        # Fastest: a viewer's first screen is deflated as it joins.
        self.deflate = zlib.compressobj(1)

    def change(self, x, y, width, height):
        if not width or not height:
            return
        rect = (x, y, width, height)
        if any(inside(rect, other) for other in self.changed):
            return
        self.changed = [other for other in self.changed if not inside(other, rect)] + [rect]
        if len(self.changed) > MAX_CHANGED:
            left = min(r[0] for r in self.changed)
            top = min(r[1] for r in self.changed)
            right = max(r[0] + r[2] for r in self.changed)
            bottom = max(r[1] + r[3] for r in self.changed)
            self.changed = [(left, top, right - left, bottom - top)]

    def send(self, data):
        if not self.writer.is_closing():
            self.writer.write(data)


class Holder:
    def __init__(self, output, socket_path, status_path):
        self.output = output
        self.socket_path = socket_path
        self.status_path = status_path
        self.viewers = set()
        # Where red, green and blue are in each of the server's 4-byte pixels.
        self.order = (0, 1, 2)
        self.cursor = None
        # The screen, in noVNC's pixel format, once Tart has sent all of it at its size.
        self.screen = None
        self.whole = False
        # The one outstanding request is for the whole screen.
        self.asked_whole = False

    def status(self, text):
        with open(self.status_path + ".new", "w") as file:
            file.write(text + "\n")
        os.replace(self.status_path + ".new", self.status_path)

    def url(self):
        with open(self.output) as file:
            found = re.findall(r"vnc://:([^@\s]*)@127\.0\.0\.1:(\d+)", file.read())
        if not found:
            raise RuntimeError("the run's output has no VNC URL")
        password, port = found[-1]
        return int(port), password

    async def run(self):
        server = None
        reason = "Tart's VNC server closed the connection, as when the run ends"
        try:
            port, password = self.url()
            self.reader, self.writer = await asyncio.open_connection("127.0.0.1", port)
            await self.sign_in(password)
            if os.path.exists(self.socket_path):
                os.unlink(self.socket_path)
            server = await asyncio.start_unix_server(self.serve, path=self.socket_path)
            os.chmod(self.socket_path, 0o600)
            self.status("ready %dx%d" % (self.width, self.height))
            await self.pump()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        except Exception as error:
            reason = str(error) or type(error).__name__
        finally:
            if server:
                server.close()
            for viewer in list(self.viewers):
                viewer.writer.close()
            if os.path.exists(self.socket_path):
                os.unlink(self.socket_path)
            self.status("ended " + reason)

    async def reason(self):
        length = struct.unpack(">I", await self.reader.readexactly(4))[0]
        return (await self.reader.readexactly(min(length, 65536))).decode(errors="replace")

    async def sign_in(self, password):
        r, w = self.reader, self.writer
        version = re.match(rb"RFB (\d{3})\.(\d{3})\n", await r.readexactly(12))
        if not version:
            raise RuntimeError("Tart's VNC server does not speak RFB")
        minor = 8 if int(version.group(2)) >= 8 else 7 if int(version.group(2)) >= 7 else 3
        w.write(b"RFB 003.%03d\n" % minor)
        if minor == 3:
            chosen = struct.unpack(">I", await r.readexactly(4))[0]
            if chosen == 0:
                raise RuntimeError("Tart's VNC server refused the connection: " + await self.reason())
        else:
            count = (await r.readexactly(1))[0]
            if count == 0:
                raise RuntimeError("Tart's VNC server refused the connection: " + await self.reason())
            offered = await r.readexactly(count)
            chosen = 2 if 2 in offered else 1 if 1 in offered else 0
            if not chosen:
                raise RuntimeError("Tart's VNC server offers no security type the holder answers: %s" % list(offered))
            w.write(bytes([chosen]))
        if chosen == 2:
            w.write(vnc_response(await r.readexactly(16), password))
        if chosen == 2 or minor == 8:
            if struct.unpack(">I", await r.readexactly(4))[0] != 0:
                raise RuntimeError("Tart's VNC server refused the password" + (": " + await self.reason() if minor == 8 else ""))
        w.write(b"\x01")
        init = await r.readexactly(24)
        self.width, self.height = struct.unpack(">HH", init[:4])
        self.name = await r.readexactly(struct.unpack(">I", init[20:24])[0])
        self.screen = bytearray(self.width * self.height * 4)
        bits, depth, big, true_colour = init[4:8]
        maxima = struct.unpack(">HHH", init[8:14])
        shifts = init[14:17]
        if bits == 32 and true_colour and maxima == (255, 255, 255) and sorted(shifts) in ([0, 8, 16], [8, 16, 24]):
            # The server's own format, whose bytes the holder reorders.
            self.order = tuple(3 - shift // 8 if big else shift // 8 for shift in shifts)
        else:
            # A format the holder cannot reorder: ask for noVNC's, and pass the pixels on as they come.
            w.write(b"\x00\x00\x00\x00" + PIXEL_FORMAT)
        w.write(struct.pack(">BxH", 2, len(ENCODINGS)) + b"".join(struct.pack(">i", e) for e in ENCODINGS))
        self.request(whole=True)
        await w.drain()

    async def pump(self):
        r = self.reader
        while True:
            kind = (await r.readexactly(1))[0]
            if kind == 0:
                await self.update()
            elif kind == 1:
                head = await r.readexactly(5)
                self.broadcast(b"\x01" + head + await r.readexactly(6 * struct.unpack(">H", head[3:5])[0]))
            elif kind == 2:
                self.broadcast(b"\x02")
            elif kind == 3:
                head = await r.readexactly(7)
                self.broadcast(b"\x03" + head + await r.readexactly(struct.unpack(">I", head[3:7])[0]))
            else:
                raise RuntimeError("Tart's VNC server sent message type %d, which the holder cannot read" % kind)

    async def update(self):
        r = self.reader
        count = struct.unpack(">xH", await r.readexactly(3))[0]
        answered_whole = self.asked_whole
        changed = []
        cursor = resized = False
        read = 0
        # A count of 65535 ends with LastRect.
        while count == 0xFFFF or read < count:
            read += 1
            head = await r.readexactly(12)
            x, y, width, height, encoding = struct.unpack(">HHHHi", head)
            if encoding == -224:
                break
            if encoding == 0:
                self.draw(x, y, width, height, self.reorder(await r.readexactly(width * height * 4)))
                changed.append((x, y, width, height))
            elif encoding == 1:
                source = struct.unpack(">HH", await r.readexactly(4))
                self.draw(x, y, width, height, self.pixels(source[0], source[1], width, height))
                changed.append((x, y, width, height))
            elif encoding == -223:
                # A new size: the screen is drawn again, from the next whole one.
                self.width, self.height = width, height
                self.screen = bytearray(width * height * 4)
                resized = True
            elif encoding == -239:
                body = self.reorder(await r.readexactly(width * height * 4)) + await r.readexactly((width + 7) // 8 * height)
                self.cursor = head + body
                cursor = True
            else:
                raise RuntimeError("Tart's VNC server sent rect encoding %d, which the holder did not ask for" % encoding)
        if resized:
            self.whole = False
        elif answered_whole:
            self.whole = True
        for viewer in self.viewers:
            if resized:
                viewer.resized = True
                viewer.changed = [(0, 0, self.width, self.height)]
            for rect in changed:
                viewer.change(*rect)
            viewer.cursor = viewer.cursor or cursor
        self.request(whole=not self.whole)
        for viewer in list(self.viewers):
            self.answer(viewer)

    def reorder(self, data):
        # Each pixel's red, green and blue bytes, from the server's places to noVNC's.
        if self.order == (0, 1, 2):
            return data
        red, green, blue = self.order
        pixels = bytearray(len(data))
        pixels[0::4] = data[red::4]
        pixels[1::4] = data[green::4]
        pixels[2::4] = data[blue::4]
        return pixels

    def draw(self, x, y, width, height, pixels):
        # A rect's pixels on the screen, as far as the screen goes.
        pixels = memoryview(pixels)
        row = width * 4
        cut = max(0, min(width, self.width - x)) * 4
        for line in range(max(0, min(height, self.height - y))):
            at = ((y + line) * self.width + x) * 4
            self.screen[at : at + cut] = pixels[line * row : line * row + cut]

    def pixels(self, x, y, width, height):
        # A rect of the screen, row by row.
        if x == 0 and width == self.width:
            return bytes(self.screen[y * width * 4 : (y + height) * width * 4])
        return b"".join(self.screen[((y + line) * self.width + x) * 4 : ((y + line) * self.width + x + width) * 4] for line in range(height))

    def answer(self, viewer):
        # An update for a viewer that has asked, once there is a whole screen and something it has not had.
        if not viewer.asked or not self.whole or not (viewer.changed or viewer.resized or (viewer.cursor and self.cursor)):
            return
        rects = []
        if viewer.resized:
            rects.append(struct.pack(">HHHHi", 0, 0, self.width, self.height, -223))
        if viewer.cursor and self.cursor:
            rects.append(self.cursor)
        for x, y, width, height in viewer.changed:
            data = viewer.deflate.compress(self.pixels(x, y, width, height)) + viewer.deflate.flush(zlib.Z_SYNC_FLUSH)
            rects.append(struct.pack(">HHHHiI", x, y, width, height, ZLIB, len(data)) + data)
        viewer.asked, viewer.changed, viewer.resized, viewer.cursor = False, [], False, False
        viewer.send(struct.pack(">BxH", 0, len(rects)) + b"".join(rects))

    def broadcast(self, data):
        for viewer in list(self.viewers):
            viewer.send(data)

    def request(self, whole=False):
        # The one outstanding request, sent after the sign-in and after each update.
        self.asked_whole = whole
        self.writer.write(struct.pack(">BBHHHH", 3, 0 if whole else 1, 0, 0, self.width, self.height))

    async def serve(self, reader, writer):
        viewer = Viewer(writer)
        try:
            writer.write(b"RFB 003.008\n")
            await reader.readexactly(12)
            writer.write(b"\x01\x01")
            if (await reader.readexactly(1))[0] != 1:
                return
            writer.write(struct.pack(">I", 0))
            await reader.readexactly(1)
            writer.write(struct.pack(">HH", self.width, self.height) + PIXEL_FORMAT + struct.pack(">I", len(self.name)) + self.name)
            # All of the screen at the size it was told is to come.
            viewer.change(0, 0, self.width, self.height)
            self.viewers.add(viewer)
            while True:
                kind = (await reader.readexactly(1))[0]
                if kind == 0:
                    # SetPixelFormat: the format is the holder's.
                    await reader.readexactly(19)
                elif kind == 2:
                    # SetEncodings: the encodings are the holder's.
                    await reader.readexactly(4 * struct.unpack(">xH", await reader.readexactly(3))[0])
                elif kind == 3:
                    # An update request, answered from the screen: for changes since its last, or for all of it.
                    if not (await reader.readexactly(9))[0]:
                        viewer.change(0, 0, self.width, self.height)
                    viewer.asked = True
                    self.answer(viewer)
                elif kind == 4:
                    self.writer.write(b"\x04" + await reader.readexactly(7))
                elif kind == 5:
                    self.writer.write(b"\x05" + await reader.readexactly(5))
                elif kind == 6:
                    head = await reader.readexactly(7)
                    self.writer.write(b"\x06" + head + await reader.readexactly(abs(struct.unpack(">i", head[3:7])[0])))
                elif kind == 251:
                    # SetDesktopSize, which Tart's server ignores.
                    head = await reader.readexactly(7)
                    await reader.readexactly(16 * head[5])
                else:
                    # A message the holder cannot read ends this viewer's connection, not the run's.
                    return
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            self.viewers.discard(viewer)
            writer.close()


if __name__ == "__main__":
    output, socket_path, status_path = sys.argv[1:4]
    asyncio.run(Holder(output, socket_path, status_path).run())
`;

/**
 * A viewer's end of the holder's socket, run on the Mac for each viewer with
 * the socket's path: it copies stdin to the socket and the socket to stdout.
 * When the viewer goes, its SSH session's stdin ends, and the bridge closes
 * the socket, so the holder stops serving it at once. `nc -U` would keep it
 * open, and the holder would go on sending it every update. It has no single
 * quotes, so it goes in single quotes as it is.
 */
export const VNC_BRIDGE_PY = String.raw`import os, socket, sys, threading
connection = socket.socket(socket.AF_UNIX)
connection.connect(sys.argv[1])
def up():
    try:
        while True:
            data = os.read(0, 65536)
            if not data:
                break
            connection.sendall(data)
    finally:
        connection.shutdown(socket.SHUT_RDWR)
threading.Thread(target=up, daemon=True).start()
while True:
    data = connection.recv(65536)
    if not data:
        break
    os.write(1, data)
`;
