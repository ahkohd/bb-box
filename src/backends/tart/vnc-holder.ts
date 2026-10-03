// The VNC holder for a Tart macOS VM's run (#406). Tart's VNC server, the
// Virtualization framework's, crashes the VM on a second VNC connection in a
// run, even after the first has closed. So a holder on the Mac makes the
// run's one connection, keeps it until the run ends, and serves any number
// of viewers on a unix socket that only the Mac's host user can open. It
// never connects again; a new run gets a new holder (holderScript).
//
// It sets one pixel format and its own encodings upstream, reads each of the
// server's messages whole, and gives each viewer whole messages from the
// first update it asks for, with the size and cursor of the moment and a
// whole screen. ZRLE's zlib stream is per connection, so it inflates the
// server's once and deflates it again for each viewer. Viewers' input goes
// upstream as it is.
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

# noVNC's: 32 bits a pixel, depth 24, little-endian true colour, 8 bits a channel, red lowest.
PIXEL_FORMAT = bytes([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0])
# ZRLE, CopyRect, Raw, DesktopSize, LastRect, Cursor. Tart's server ends the VM on an update request without DesktopSize.
ENCODINGS = [16, 1, 0, -223, -224, -239]
# A viewer this far behind is dropped rather than held in memory.
MAX_BEHIND = 64 * 1024 * 1024


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


class Viewer:
    def __init__(self, writer):
        self.writer = writer
        self.watching = False
        self.deflate = zlib.compressobj()

    def send(self, data):
        if self.writer.is_closing():
            return
        if self.writer.transport.get_write_buffer_size() > MAX_BEHIND:
            self.writer.close()
            return
        self.writer.write(data)


class Holder:
    def __init__(self, output, socket_path, status_path):
        self.output = output
        self.socket_path = socket_path
        self.status_path = status_path
        self.viewers = set()
        self.inflate = zlib.decompressobj()
        self.cursor = None

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
        w.write(b"\x00\x00\x00\x00" + PIXEL_FORMAT)
        w.write(struct.pack(">BxH", 2, len(ENCODINGS)) + b"".join(struct.pack(">i", e) for e in ENCODINGS))
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
        rects = []
        # A count of 65535 ends with LastRect.
        while count == 0xFFFF or len(rects) < count:
            head = await r.readexactly(12)
            width, height, encoding = struct.unpack(">HHi", head[4:])
            if encoding == -224:
                break
            if encoding == 16:
                size = struct.unpack(">I", await r.readexactly(4))[0]
                rects.append((head, None, self.inflate.decompress(await r.readexactly(size))))
                continue
            if encoding == 0:
                body = await r.readexactly(width * height * 4)
            elif encoding == 1:
                body = await r.readexactly(4)
            elif encoding == -223:
                self.width, self.height = width, height
                body = b""
            elif encoding == -239:
                body = await r.readexactly(width * height * 4 + (width + 7) // 8 * height)
                self.cursor = head + body
            else:
                raise RuntimeError("Tart's VNC server sent rect encoding %d, which the holder did not ask for" % encoding)
            rects.append((head, body, None))
        for viewer in list(self.viewers):
            if not viewer.watching:
                continue
            parts = [struct.pack(">BxH", 0, len(rects))]
            for head, body, tiles in rects:
                if tiles is None:
                    parts.append(head + body)
                else:
                    data = viewer.deflate.compress(tiles) + viewer.deflate.flush(zlib.Z_SYNC_FLUSH)
                    parts.append(head + struct.pack(">I", len(data)) + data)
            viewer.send(b"".join(parts))
        self.request()

    def broadcast(self, data):
        for viewer in list(self.viewers):
            if viewer.watching:
                viewer.send(data)

    def request(self, whole=False):
        # After each update, the next changes, while anyone watches; Tart
        # answers those only when the screen changes. A viewer that joins asks
        # for the whole screen at once, which Tart answers straight away.
        if not whole and not any(viewer.watching for viewer in self.viewers):
            return
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
                    await reader.readexactly(9)
                    if not viewer.watching:
                        # From here the viewer gets every update, the first a whole screen, and the cursor first of all.
                        viewer.watching = True
                        if self.cursor:
                            viewer.send(struct.pack(">BxH", 0, 1) + self.cursor)
                        self.request(whole=True)
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
