// bb-box: sign in to the desktop's VNC server as the relay does, and time the
// first full frame. With a user and password it answers Apple's
// authentication (type 30), which wayvnc offers; with neither, type None.
// Prints {types, width, height, signInMs, firstFrameMs} as JSON. With --hold
// it then stays connected, following the screen's changes and size, until it
// is stopped, as a person's viewer through the relay does. With --init-only
// it reads only ServerInit's size, as the relay's desktopSize() does (021).
// usage: node rfb-probe.mjs [--user <user> --password-file <file>] [--port 5900] [--hold | --init-only]
import { createCipheriv, createDiffieHellman, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";

const arg = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const user = arg("--user", null);
const passwordFile = arg("--password-file", null);
const password = passwordFile ? readFileSync(passwordFile, "utf8").trim() : null;
const port = Number(arg("--port", "5900"));
const hold = process.argv.includes("--hold");
const initOnly = process.argv.includes("--init-only");

const socket = net.connect(port, "127.0.0.1");
let buffer = Buffer.alloc(0);
let waiting = null;
socket.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (waiting && buffer.length >= waiting.n) {
    const { n, resolve } = waiting;
    waiting = null;
    const head = buffer.subarray(0, n);
    buffer = buffer.subarray(n);
    resolve(head);
  }
});
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
socket.on("error", (error) => fail(`connection: ${error.message}`));
socket.on("close", () => waiting && fail("the server closed the connection"));
const timer = setTimeout(() => fail("timed out after 20 s"), 20000);
timer.unref();
const read = (n) =>
  new Promise((resolve) => {
    if (buffer.length >= n) {
      const head = buffer.subarray(0, n);
      buffer = buffer.subarray(n);
      resolve(head);
    } else waiting = { n, resolve };
  });
const padded = (bytes, length) => (bytes.length >= length ? bytes : Buffer.concat([Buffer.alloc(length - bytes.length), bytes]));

const start = performance.now();
const version = (await read(12)).toString();
if (!/^RFB 003\.\d{3}\n$/.test(version)) fail(`not RFB: ${JSON.stringify(version)}`);
socket.write("RFB 003.008\n");
const count = (await read(1))[0];
if (count === 0) fail("the server refused the connection");
const types = [...(await read(count))];
const chosen = user && password ? 30 : 1;
if (!types.includes(chosen)) fail(`the server does not offer type ${chosen}; it offers ${types.join(", ")}`);
socket.write(Buffer.of(chosen));
if (chosen === 30) {
  // Diffie-Hellman in the server's group; the shared secret's MD5 is the
  // AES-128 key for the user and the password, each ended by a zero in 64
  // bytes of noise.
  const head = await read(4);
  const keyLength = head.readUInt16BE(2);
  const prime = await read(keyLength);
  const serverKey = await read(keyLength);
  const dh = createDiffieHellman(prime, head.subarray(0, 2));
  const publicKey = padded(dh.generateKeys(), keyLength);
  const secret = padded(dh.computeSecret(serverKey), keyLength);
  const credentials = randomBytes(128);
  Buffer.from(user).copy(credentials, 0);
  credentials[Buffer.byteLength(user)] = 0;
  Buffer.from(password).copy(credentials, 64);
  credentials[64 + Buffer.byteLength(password)] = 0;
  const cipher = createCipheriv("aes-128-ecb", createHash("md5").update(secret).digest(), null).setAutoPadding(false);
  socket.write(Buffer.concat([cipher.update(credentials), cipher.final(), publicKey]));
}
const result = (await read(4)).readUInt32BE(0);
if (result !== 0) fail(`sign-in refused: ${(await read((await read(4)).readUInt32BE(0))).toString()}`);
const signInMs = Math.round(performance.now() - start);

socket.write(Buffer.of(1)); // shared
const init = await read(24);
let width = init.readUInt16BE(0);
let height = init.readUInt16BE(2);
const bytesPerPixel = init[4] / 8;
await read(init.readUInt32BE(20)); // the desktop's name
if (initOnly) {
  console.log(JSON.stringify({ types, width, height, signInMs }));
  socket.destroy();
  process.exit(0);
}
// SetEncodings: Raw, and the desktop-size pseudo-encodings, without which
// wayvnc closes a viewer when the screen's size changes.
const encodings = Buffer.alloc(4 + 3 * 4);
encodings.writeUInt8(2, 0);
encodings.writeUInt16BE(3, 2);
[0, -308, -223].forEach((encoding, i) => encodings.writeInt32BE(encoding, 4 + i * 4));
socket.write(encodings);
const request = (incremental) => {
  const message = Buffer.alloc(10);
  message.writeUInt8(3, 0);
  message.writeUInt8(incremental ? 1 : 0, 1);
  message.writeUInt16BE(width, 6);
  message.writeUInt16BE(height, 8);
  return message;
};
// wayvnc answers a full request with the screen's size alone, so the first
// request is full and the next ones incremental, until the pixels cover the
// screen. A new size starts the count again. Held, it goes on until stopped.
let covered = 0;
let requests = 0;
let shown = false;
while (covered < width * height || hold) {
  if (covered >= width * height && !shown) {
    console.log(JSON.stringify({ types, width, height, signInMs, firstFrameMs: Math.round(performance.now() - start) }));
    clearTimeout(timer);
    shown = true;
  }
  socket.write(request(requests++ > 0));
  const type = (await read(1))[0];
  if (type === 0) {
    const rects = (await read(3)).readUInt16BE(1);
    for (let i = 0; i < rects; i++) {
      const rect = await read(12);
      const w = rect.readUInt16BE(4);
      const h = rect.readUInt16BE(6);
      const encoding = rect.readInt32BE(8);
      if (encoding === -223 || encoding === -308) {
        // ExtendedDesktopSize: the number of screens, 3 bytes of padding, 16 bytes a screen.
        if (encoding === -308) await read(3 + 16 * (await read(1))[0]);
        if (w !== width || h !== height) covered = 0;
        width = w;
        height = h;
        continue;
      }
      if (encoding !== 0) fail(`encoding ${encoding}, not Raw`);
      await read(w * h * bytesPerPixel);
      covered += w * h;
    }
  } else if (type === 2) {
    // Bell
  } else if (type === 3) {
    await read((await read(7)).readUInt32BE(3));
  } else fail(`server message ${type}`);
}
if (!shown) console.log(JSON.stringify({ types, width, height, signInMs, firstFrameMs: Math.round(performance.now() - start) }));
socket.destroy();
process.exit(0);
