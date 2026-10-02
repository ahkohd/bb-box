// The RFB (VNC) protocol, as much as the desktop relay needs: the box's
// security handshake, answered with its VNC password or as its user with
// Apple's authentication (047), and the client's messages, parsed so the
// relay can drop input from viewers without control. The relay never decodes
// the server's messages or pixels (011).

import { createCipheriv, createDiffieHellman, createHash, randomBytes } from "node:crypto";
import type { DisplayAuth } from "../transports/types.ts";

export const VERSION_3_8 = "RFB 003.008\n";
const SECURITY_NONE = 1;
const SECURITY_VNC = 2;
/** Apple's authentication, which macOS Screen Sharing asks for. */
const SECURITY_APPLE = 30;
/** The longest user or password Apple's authentication carries, in UTF-8. */
const APPLE_TEXT_BYTES = 63;
const APPLE_NONE = "The box's desktop asks for a user and password, and its backend gave none.";
/** Longest reason or desktop name the relay reads. */
const MAX_TEXT_BYTES = 64 * 1024;
/** A pseudo-encoding that makes PointerEvent 7 bytes long when its top bit is set. */
const EXTENDED_MOUSE_BUTTONS = -316;
export const EXTENDED_DESKTOP_SIZE = -308;
/**
 * The plain DesktopSize pseudo-encoding. The Virtualization framework's VNC
 * server, which Tart's macOS VMs use, ends the VM when a client asks for a
 * framebuffer update without it.
 */
export const DESKTOP_SIZE = -223;

export class RfbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RfbError";
  }
}

/** Reads exact numbers of bytes from a stream. */
export class StreamReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer: Uint8Array = new Uint8Array(0);

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  async read(length: number): Promise<Uint8Array> {
    while (this.#buffer.byteLength < length) {
      const { value, done } = await this.#reader.read();
      if (done) throw new RfbError("The box closed the connection.");
      this.#buffer = concat(this.#buffer, value);
    }
    const head = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return head;
  }

  /** Whatever has arrived: what was left over first, then each chunk as it comes. Null at the end. */
  async next(): Promise<Uint8Array | null> {
    if (this.#buffer.byteLength) {
      const rest = this.#buffer;
      this.#buffer = new Uint8Array(0);
      return rest;
    }
    const { value, done } = await this.#reader.read();
    return done ? null : value;
  }

  cancel(): void {
    void this.#reader.cancel().catch(() => undefined);
  }
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.byteLength) return b;
  const joined = new Uint8Array(a.byteLength + b.byteLength);
  joined.set(a);
  joined.set(b, a.byteLength);
  return joined;
}

function u32(bytes: Uint8Array, at = 0): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at);
}

async function readText(reader: StreamReader): Promise<string> {
  const length = u32(await reader.read(4));
  if (length > MAX_TEXT_BYTES) throw new RfbError(`The box sent a text of ${length} bytes, more than the relay reads.`);
  return new TextDecoder().decode(await reader.read(length));
}

/** A 3.x version from "RFB 003.008\n", or null for anything else. */
export function parseVersion(bytes: Uint8Array): number | null {
  const text = new TextDecoder().decode(bytes);
  const match = /^RFB 003\.(\d{3})\n$/.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * The answer to a VNC authentication challenge: the challenge encrypted with
 * DES, keyed by the password's first 8 bytes with each byte's bits reversed.
 * Single DES is only in OpenSSL's legacy provider, and triple DES with one
 * key repeated is the same cipher.
 */
export function vncResponse(challenge: Uint8Array, password: string): Uint8Array {
  const key = new Uint8Array(8);
  key.set(new TextEncoder().encode(password).subarray(0, 8));
  for (let index = 0; index < 8; index++) {
    let byte = key[index]!;
    let reversed = 0;
    for (let bit = 0; bit < 8; bit++) {
      reversed = (reversed << 1) | (byte & 1);
      byte >>= 1;
    }
    key[index] = reversed;
  }
  const cipher = createCipheriv("des-ede3-ecb", Buffer.concat([key, key, key]), null);
  cipher.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([cipher.update(challenge), cipher.final()]));
}

/**
 * Apple's answer, as noVNC gives it: Diffie-Hellman in the server's group,
 * whose shared secret's MD5 is an AES-128 key, then the user and password,
 * each ended by a zero in 64 bytes of noise, encrypted with it. The answer is
 * those 128 bytes, then the relay's public key.
 */
function appleResponse(generator: Uint8Array, prime: Uint8Array, serverKey: Uint8Array, user: string, password: string): Uint8Array {
  const credentials = randomBytes(128);
  for (const [at, value] of [
    [0, user],
    [64, password],
  ] as const) {
    const bytes = new TextEncoder().encode(value);
    if (bytes.byteLength > APPLE_TEXT_BYTES) throw new RfbError(`The box user's name or password is longer than the ${APPLE_TEXT_BYTES} bytes Apple's authentication carries.`);
    credentials.set(bytes, at);
    credentials[at + bytes.byteLength] = 0;
  }
  let publicKey: Uint8Array;
  let secret: Uint8Array;
  try {
    const dh = createDiffieHellman(prime, generator);
    publicKey = padded(dh.generateKeys(), prime.byteLength);
    secret = padded(dh.computeSecret(serverKey), prime.byteLength);
  } catch (error) {
    throw new RfbError(`The box's desktop sent a Diffie-Hellman key the relay cannot use: ${error instanceof Error ? error.message : String(error)}`);
  }
  const cipher = createCipheriv("aes-128-ecb", createHash("md5").update(secret).digest(), null).setAutoPadding(false);
  return concat(concat(cipher.update(credentials), cipher.final()), publicKey);
}

/** A big-endian number with zeros in front, to `length` bytes. */
function padded(bytes: Uint8Array, length: number): Uint8Array {
  if (bytes.byteLength >= length) return bytes;
  const out = new Uint8Array(length);
  out.set(bytes, length - bytes.byteLength);
  return out;
}

/**
 * Does the box's side of the handshake up to its security result, answering
 * VNC authentication with the password, and Apple's with the user and
 * password. Writes go straight to `write`.
 */
export async function boxHandshake(reader: StreamReader, write: (bytes: Uint8Array) => Promise<void>, auth: DisplayAuth): Promise<void> {
  const version = parseVersion(await reader.read(12));
  if (version === null || version < 3) throw new RfbError("The box's desktop does not speak RFB 3.");
  // 3.889 is macOS Screen Sharing, which speaks 3.8.
  const minor = version >= 8 ? 8 : version >= 7 ? 7 : 3;
  await write(new TextEncoder().encode(`RFB 003.00${minor}\n`));

  let chosen: number;
  if (minor === 3) {
    chosen = u32(await reader.read(4));
    if (chosen === 0) throw new RfbError(`The box's desktop refused the connection: ${await readText(reader)}`);
  } else {
    const count = (await reader.read(1))[0]!;
    if (count === 0) throw new RfbError(`The box's desktop refused the connection: ${await readText(reader)}`);
    const offered = [...(await reader.read(count))];
    if (auth.type === "apple" && offered.includes(SECURITY_APPLE)) chosen = SECURITY_APPLE;
    else if (auth.type === "vnc-password" && offered.includes(SECURITY_VNC)) chosen = SECURITY_VNC;
    else if (offered.includes(SECURITY_NONE)) chosen = SECURITY_NONE;
    else if (offered.includes(SECURITY_VNC)) throw new RfbError("The box's desktop asks for a VNC password, and its backend gave none.");
    else if (offered.includes(SECURITY_APPLE)) throw new RfbError(APPLE_NONE);
    else throw new RfbError(`The box's desktop offers no security type the relay can answer (it offers ${offered.join(", ")}).`);
    await write(Uint8Array.of(chosen));
  }

  let refused = "refused the connection";
  if (chosen === SECURITY_VNC) {
    if (auth.type !== "vnc-password") throw new RfbError("The box's desktop asks for a VNC password, and its backend gave none.");
    await write(vncResponse(await reader.read(16), auth.password));
    refused = "refused its VNC password";
  } else if (chosen === SECURITY_APPLE) {
    if (auth.type !== "apple") throw new RfbError(APPLE_NONE);
    const head = await reader.read(4);
    const keyLength = new DataView(head.buffer, head.byteOffset, 4).getUint16(2);
    const prime = await reader.read(keyLength);
    const serverKey = await reader.read(keyLength);
    await write(appleResponse(head.subarray(0, 2), prime, serverKey, auth.user, auth.password));
    refused = `refused the sign-in of user ${auth.user}`;
  } else if (chosen !== SECURITY_NONE) {
    throw new RfbError(`The box's desktop chose security type ${chosen}, which the relay cannot answer.`);
  }
  // Before 3.8 there is no result for type None.
  if (chosen === SECURITY_NONE && minor < 8) return;
  const result = u32(await reader.read(4));
  if (result === 0) return;
  const reason = minor === 8 ? await readText(reader).catch(() => "") : "";
  throw new RfbError(`The box's desktop ${refused}${reason ? `: ${reason}` : "."}`);
}


export interface ServerInit {
  readonly width: number;
  readonly height: number;
  /** The whole message, to pass to the viewer. */
  readonly bytes: Uint8Array;
}

export async function readServerInit(reader: StreamReader): Promise<ServerInit> {
  const head = await reader.read(24);
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const nameLength = view.getUint32(20);
  if (nameLength > MAX_TEXT_BYTES) throw new RfbError(`The box sent a desktop name of ${nameLength} bytes, more than the relay reads.`);
  const name = await reader.read(nameLength);
  return { width: view.getUint16(0), height: view.getUint16(2), bytes: concat(head, name) };
}

/** What the relay does with a client message. */
export type MessageClass =
  /** Passes from every viewer: formats, encodings, update requests, fences. */
  | "pass"
  /** Keys, pointer, clipboard writes, desktop power and the QEMU messages: only from the viewer with control. */
  | "input"
  /** SetDesktopSize: only from the viewer with control. */
  | "resize";

export type ClientMessage =
  | { readonly type: "key"; readonly bytes: Uint8Array; readonly down: boolean; readonly keysym: number }
  | { readonly type: "qemu-key"; readonly bytes: Uint8Array; readonly down: boolean; readonly keysym: number; readonly keycode: number }
  | { readonly type: "pointer"; readonly bytes: Uint8Array; readonly mask: number; readonly x: number; readonly y: number }
  | { readonly type: "resize"; readonly bytes: Uint8Array; readonly width: number; readonly height: number; readonly screen: Screen | null }
  | { readonly type: "other"; readonly bytes: Uint8Array; readonly class: MessageClass };

/** The first screen of a SetDesktopSize, whose ID a later resize must use. */
export interface Screen {
  readonly id: number;
  readonly flags: number;
}

const CLIPBOARD_NOTIFY = 1 << 27;
const CLIPBOARD_PROVIDE = 1 << 28;

/**
 * Splits the bytes a viewer sends after its ClientInit into whole messages.
 * Viewers may split or join messages across WebSocket frames. An unknown
 * message type throws, since the relay cannot tell where it ends.
 */
export class ClientParser {
  #buffer: Uint8Array = new Uint8Array(0);

  push(bytes: Uint8Array): ClientMessage[] {
    this.#buffer = concat(this.#buffer, bytes);
    const messages: ClientMessage[] = [];
    for (;;) {
      const message = this.#next();
      if (!message) break;
      messages.push(message);
    }
    return messages;
  }

  #take(length: number): Uint8Array | null {
    if (this.#buffer.byteLength < length) return null;
    const bytes = this.#buffer.slice(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return bytes;
  }

  #need(length: number): DataView | null {
    return this.#buffer.byteLength < length ? null : new DataView(this.#buffer.buffer, this.#buffer.byteOffset, this.#buffer.byteLength);
  }

  #next(): ClientMessage | null {
    const head = this.#need(1);
    if (!head) return null;
    const type = head.getUint8(0);
    switch (type) {
      case 0: // SetPixelFormat
        return this.#other(20, "pass");
      case 2: {
        // SetEncodings. ExtendedMouseButtons is removed, so a PointerEvent is always 6 bytes.
        const view = this.#need(4);
        if (!view) return null;
        const count = view.getUint16(2);
        const bytes = this.#take(4 + 4 * count);
        if (!bytes) return null;
        const encodings = new DataView(bytes.buffer);
        const kept: number[] = [];
        for (let index = 0; index < count; index++) {
          const encoding = encodings.getInt32(4 + 4 * index);
          if (encoding !== EXTENDED_MOUSE_BUTTONS) kept.push(encoding);
        }
        return { type: "other", bytes: count === kept.length ? bytes : setEncodings(kept), class: "pass" };
      }
      case 3: // FramebufferUpdateRequest
        return this.#other(10, "pass");
      case 4: {
        const bytes = this.#take(8);
        if (!bytes) return null;
        const view = new DataView(bytes.buffer);
        return { type: "key", bytes, down: view.getUint8(1) !== 0, keysym: view.getUint32(4) };
      }
      case 5: {
        const bytes = this.#take(6);
        if (!bytes) return null;
        const view = new DataView(bytes.buffer);
        return { type: "pointer", bytes, mask: view.getUint8(1), x: view.getUint16(2), y: view.getUint16(4) };
      }
      case 6: {
        // ClientCutText. A negative length is the extended clipboard, whose
        // first 4 bytes say what the message does.
        const view = this.#need(8);
        if (!view) return null;
        const length = view.getInt32(4);
        const size = Math.abs(length);
        if (size > 64 * 1024 * 1024) throw new RfbError("The viewer sent a clipboard larger than 64 MiB.");
        if (length < 0 && size < 4) throw new RfbError("The viewer sent an extended clipboard message without its flags.");
        const bytes = this.#take(8 + size);
        if (!bytes) return null;
        const writes = length >= 0 || (new DataView(bytes.buffer).getUint32(8) & (CLIPBOARD_NOTIFY | CLIPBOARD_PROVIDE)) !== 0;
        return { type: "other", bytes, class: writes ? "input" : "pass" };
      }
      case 150: // EnableContinuousUpdates
        return this.#other(10, "pass");
      case 248: {
        // ClientFence: 3 padding bytes, u32 flags, u8 length, the payload.
        const view = this.#need(9);
        if (!view) return null;
        return this.#other(9 + view.getUint8(8), "pass");
      }
      case 250: // xvp: shut down, reboot or reset the machine
        return this.#other(4, "input");
      case 251: {
        // SetDesktopSize: padding, u16 width, u16 height, u8 screens, padding, 16 bytes a screen.
        const view = this.#need(8);
        if (!view) return null;
        const screens = view.getUint8(6);
        const bytes = this.#take(8 + 16 * screens);
        if (!bytes) return null;
        const message = new DataView(bytes.buffer);
        return {
          type: "resize",
          bytes,
          width: message.getUint16(2),
          height: message.getUint16(4),
          screen: screens ? { id: message.getUint32(8), flags: message.getUint32(20) } : null,
        };
      }
      case 255: {
        const view = this.#need(2);
        if (!view) return null;
        const subtype = view.getUint8(1);
        if (subtype === 0) {
          const bytes = this.#take(12);
          if (!bytes) return null;
          const message = new DataView(bytes.buffer);
          return { type: "qemu-key", bytes, down: message.getUint16(2) !== 0, keysym: message.getUint32(4), keycode: message.getUint32(8) };
        }
        if (subtype === 1) {
          const audio = this.#need(4);
          if (!audio) return null;
          return this.#other(audio.getUint16(2) === 2 ? 10 : 4, "input");
        }
        throw new RfbError(`The viewer sent a QEMU message of subtype ${subtype}, which the relay does not know.`);
      }
      default:
        throw new RfbError(`The viewer sent an RFB message of type ${type}, which the relay does not know.`);
    }
  }

  #other(length: number, kind: MessageClass): ClientMessage | null {
    const bytes = this.#take(length);
    return bytes ? { type: "other", bytes, class: kind } : null;
  }
}

export function setEncodings(encodings: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(4 + 4 * encodings.length);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 2);
  view.setUint16(2, encodings.length);
  encodings.forEach((encoding, index) => view.setInt32(4 + 4 * index, encoding));
  return bytes;
}

export function keyEvent(down: boolean, keysym: number): Uint8Array {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 4);
  view.setUint8(1, down ? 1 : 0);
  view.setUint32(4, keysym);
  return bytes;
}

export function qemuKeyEvent(down: boolean, keysym: number, keycode: number): Uint8Array {
  const bytes = new Uint8Array(12);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 255);
  view.setUint8(1, 0);
  view.setUint16(2, down ? 1 : 0);
  view.setUint32(4, keysym);
  view.setUint32(8, keycode);
  return bytes;
}

export function pointerEvent(mask: number, x: number, y: number): Uint8Array {
  const bytes = new Uint8Array(6);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 5);
  view.setUint8(1, mask);
  view.setUint16(2, x);
  view.setUint16(4, y);
  return bytes;
}

/** A SetDesktopSize with one screen of the whole size, or with none. */
export function setDesktopSize(width: number, height: number, screen: Screen | null): Uint8Array {
  const bytes = new Uint8Array(screen ? 8 + 16 : 8);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 251);
  view.setUint16(2, width);
  view.setUint16(4, height);
  if (!screen) return bytes;
  view.setUint8(6, 1);
  view.setUint32(8, screen.id);
  view.setUint16(16, width);
  view.setUint16(18, height);
  view.setUint32(20, screen.flags);
  return bytes;
}

/** The viewer's side of the handshake: RFB 3.8 with security type None only. */
export const VIEWER_SECURITY = Uint8Array.of(1, SECURITY_NONE);
export const SECURITY_OK = Uint8Array.of(0, 0, 0, 0);

/** A 3.8 security failure with its reason, which noVNC shows. */
export function securityFailure(reason: string): Uint8Array {
  const text = new TextEncoder().encode(reason);
  const bytes = new Uint8Array(8 + text.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, text.byteLength);
  bytes.set(text, 8);
  return bytes;
}
