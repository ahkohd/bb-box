import type { ByteChannel } from "../transports/types.ts";
import { rgbaPng } from "./png.ts";
import { BoxWebSocket, WebSocketError, type Message } from "./websocket.ts";
import { VOXL_PING_VERB, VOXL_PONG_VERB } from "./voxl-verbs.ts";

export { VOXL_PING_VERB, VOXL_PONG_VERB };
export const VOXL_PATH = "/ws";

export const VOXL_VIDEO = 0x01;
export const VOXL_AUDIO = 0x02;
export const VOXL_CURSOR = 0x03;
export const VOXL_CLIPBOARD_IMAGE = 0x04;
export const VOXL_CLIPBOARD_IMAGE_UP = 0x11;
export const VOXL_VIDEO_HEADER_BYTES = 16;

export const VIEWER_VIDEO = 4;
export const VIEWER_H264 = 1;
export const VIEWER_VIDEO_HEADER_BYTES = 12;
const HEADER_SHRINK = VOXL_VIDEO_HEADER_BYTES - VIEWER_VIDEO_HEADER_BYTES;
const CURSOR_PIXELS_AT = 14;
export const CLIPBOARD_CHUNK_BYTES = Math.floor((16 * 1024) / 3) * 3;
export const CLIPBOARD_MAX_BYTES = 64 * 1024 * 1024;
const POINTER_BUTTONS = 3;
const WHEEL_BITS: readonly { readonly bit: number; readonly dx: number; readonly dy: number }[] = [
  { bit: 3, dx: 0, dy: -1 },
  { bit: 4, dx: 0, dy: 1 },
  { bit: 5, dx: -1, dy: 0 },
  { bit: 6, dx: 1, dy: 0 },
];
const MOST_WHEEL_NOTCHES = 64;
const TRANSPARENT_PIXEL = new Uint8Array(4);

export type OpenVoxl = (signal: AbortSignal) => Promise<ByteChannel>;

export interface VoxlViewer {
  send(message: Message): void;
  close(code: number, reason: string): void;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export type VoxlServerText =
  | { readonly t: "hello"; readonly w: number; readonly h: number; readonly stripes?: readonly (readonly number[])[] }
  | { readonly t: "ping"; readonly s: number }
  | { readonly t: "clip"; readonly d: string }
  | { readonly t: "close" }
  | { readonly t: "other" };

export function parseServerText(text: string): VoxlServerText {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (value.t === "hello" && Number.isInteger(value.w) && Number.isInteger(value.h)) return { t: "hello", w: value.w as number, h: value.h as number, stripes: Array.isArray(value.stripes) ? (value.stripes as number[][]) : undefined };
    if (value.t === "ping" && typeof value.s === "number" && Number.isFinite(value.s)) return { t: "ping", s: value.s };
    if (value.t === "clip" && typeof value.d === "string") return { t: "clip", d: value.d };
    if (value.t === "close") return { t: "close" };
  } catch {
    return { t: "other" };
  }
  return { t: "other" };
}

export function fullFrameId(shortId: number, lastSent: number): number {
  return (lastSent - ((lastSent - shortId) & 0xffff)) >>> 0;
}

export function viewerFrame(voxl: Uint8Array, size: Size): { readonly frame: Uint8Array; readonly id: number; readonly key: boolean } | null {
  if (voxl[0] !== VOXL_VIDEO || voxl.byteLength <= VOXL_VIDEO_HEADER_BYTES) return null;
  const view = new DataView(voxl.buffer, voxl.byteOffset, voxl.byteLength);
  const stripes = voxl[11]!;
  if (stripes > 1) return null;
  const key = (voxl[1]! & 1) === 1;
  const id = view.getUint32(2);
  const frame = voxl.subarray(HEADER_SHRINK);
  const out = new DataView(frame.buffer, frame.byteOffset, VIEWER_VIDEO_HEADER_BYTES);
  out.setUint8(0, VIEWER_VIDEO);
  out.setUint8(1, (VIEWER_H264 << 4) | (key ? 1 : 0));
  out.setUint16(2, id & 0xffff);
  out.setUint16(4, 0);
  out.setUint16(6, size.width);
  out.setUint16(8, size.height);
  out.setUint16(10, 0);
  return { frame, id, key };
}

export function cursorText(voxl: Uint8Array): string | null {
  if (voxl[0] !== VOXL_CURSOR || voxl.byteLength < CURSOR_PIXELS_AT) return null;
  const view = new DataView(voxl.buffer, voxl.byteOffset, voxl.byteLength);
  const width = view.getUint16(2);
  const height = view.getUint16(4);
  const hotx = view.getUint16(6);
  const hoty = view.getUint16(8);
  const hidden = width === 0 || height === 0;
  if (!hidden && voxl.byteLength < CURSOR_PIXELS_AT + width * height * 4) return null;
  const png = hidden ? rgbaPng(1, 1, TRANSPARENT_PIXEL) : rgbaPng(width, height, voxl.subarray(CURSOR_PIXELS_AT, CURSOR_PIXELS_AT + width * height * 4));
  return `cursor,${JSON.stringify({ curdata: png.toString("base64"), hotx: hidden ? 0 : hotx, hoty: hidden ? 0 : hoty })}`;
}

export function clipboardTexts(text: string): string[] {
  return [`clipboard,${Buffer.from(text, "utf8").toString("base64")}`];
}

export function clipboardImageTexts(png: Uint8Array, chunk = CLIPBOARD_CHUNK_BYTES): string[] {
  const mime = "image/png";
  if (png.byteLength <= chunk) return [`clipboard_binary,${mime},${Buffer.from(png).toString("base64")}`];
  const texts = [`clipboard_start,${mime},${png.byteLength}`];
  for (let offset = 0; offset < png.byteLength; offset += chunk) texts.push(`clipboard_data,${Buffer.from(png.subarray(offset, offset + chunk)).toString("base64")}`);
  texts.push("clipboard_finish");
  return texts;
}

function verbOf(text: string): string {
  const comma = text.indexOf(",");
  const space = text.indexOf(" ");
  const ends = [comma, space].filter((at) => at >= 0);
  return ends.length ? text.slice(0, Math.min(...ends)) : text;
}

const WATCHING_VERBS = new Set(["CLIENT_FRAME_ACK", "START_VIDEO", "STOP_VIDEO", "REQUEST_KEYFRAME", VOXL_PONG_VERB]);
const INPUT_VERBS = new Set(["kd", "ku", "kr", "m", "m2", "cw", "cb", "cws", "cbs", "cwd", "cbd", "cwe", "cbe"]);

export type ViewerMessageKind = "watching" | "input" | "resize" | "drop";

export function viewerMessageKind(text: string): ViewerMessageKind {
  if (/^r,\d{1,5}x\d{1,5}$/.test(text)) return "resize";
  const verb = verbOf(text);
  if (WATCHING_VERBS.has(verb)) return "watching";
  if (INPUT_VERBS.has(verb)) return "input";
  return "drop";
}

interface Transfer {
  readonly text: boolean;
  readonly mime: string;
  readonly size: number;
  readonly parts: Uint8Array[];
  received: number;
}

export type ToVoxl = string | Uint8Array;

export class ViewerInput {
  #mask = 0;
  readonly #held = new Set<number>();
  #pointer = { x: 0, y: 0 };
  readonly #transfers = new Map<string, Transfer>();

  get holding(): boolean {
    return this.#held.size > 0 || (this.#mask & ((1 << POINTER_BUTTONS) - 1)) !== 0;
  }

  release(): ToVoxl[] {
    const wasHolding = this.holding;
    this.#held.clear();
    this.#mask = 0;
    return wasHolding ? ["r"] : [];
  }

  translate(text: string): ToVoxl[] {
    const fields = text.split(",");
    const verb = fields[0]!;
    const number = (at: number) => Number(fields[at]);
    switch (verb) {
      case "kd":
      case "ku": {
        const keysym = number(1);
        if (!Number.isInteger(keysym) || keysym < 0) return [];
        if (verb === "kd") this.#held.add(keysym);
        else this.#held.delete(keysym);
        return [`k,${keysym},${verb === "kd" ? 1 : 0}`];
      }
      case "kr":
        return this.release();
      case "m": {
        const [x, y, mask] = [number(1), number(2), number(3)];
        if (![x, y].every((value) => Number.isInteger(value) && value >= 0)) return [];
        this.#pointer = { x, y };
        return [`m,${x},${y}`, ...this.#buttons(Number.isInteger(mask) ? mask : this.#mask, 1)];
      }
      case "m2": {
        const [mask, count] = [number(3), number(4)];
        if (!Number.isInteger(mask)) return [];
        return this.#buttons(mask, Number.isInteger(count) && count > 0 ? Math.min(count, MOST_WHEEL_NOTCHES) : 1);
      }
      case "cw":
        return this.#clipboard(true, "text/plain", fields.slice(1).join(","));
      case "cb":
        return this.#clipboard(false, fields[1] ?? "", fields.slice(2).join(","));
      case "cws":
      case "cbs": {
        const text = verb === "cws";
        const id = fields[1] ?? "";
        const size = Number(text ? fields[2] : fields[3]);
        if (!id || !Number.isInteger(size) || size < 0 || size > CLIPBOARD_MAX_BYTES) return [];
        this.#transfers.set(id, { text, mime: text ? "text/plain" : (fields[2] ?? ""), size, parts: [], received: 0 });
        return [];
      }
      case "cwd":
      case "cbd": {
        const transfer = this.#transfers.get(fields[1] ?? "");
        if (!transfer) return [];
        const part = Buffer.from(fields.slice(2).join(","), "base64");
        transfer.received += part.byteLength;
        if (transfer.received > transfer.size) this.#transfers.delete(fields[1] ?? "");
        else transfer.parts.push(part);
        return [];
      }
      case "cwe":
      case "cbe": {
        const id = fields[1] ?? "";
        const transfer = this.#transfers.get(id);
        this.#transfers.delete(id);
        if (!transfer || transfer.received !== transfer.size) return [];
        const bytes = Buffer.concat(transfer.parts);
        return this.#clipboardBytes(transfer.text, transfer.mime, bytes);
      }
      default:
        return [];
    }
  }

  #clipboard(text: boolean, mime: string, base64: string): ToVoxl[] {
    return this.#clipboardBytes(text, mime, Buffer.from(base64, "base64"));
  }

  #clipboardBytes(text: boolean, mime: string, bytes: Uint8Array): ToVoxl[] {
    if (text) return [`c,${Buffer.from(bytes).toString("utf8")}`];
    if (mime !== "image/png" || !bytes.byteLength) return [];
    const message = new Uint8Array(bytes.byteLength + 1);
    message[0] = VOXL_CLIPBOARD_IMAGE_UP;
    message.set(bytes, 1);
    return [message];
  }

  #buttons(mask: number, notches: number): ToVoxl[] {
    const out: ToVoxl[] = [];
    const was = this.#mask;
    for (let bit = 0; bit < POINTER_BUTTONS; bit++) {
      const down = (mask >> bit) & 1;
      if (((was >> bit) & 1) !== down) out.push(`b,${bit + 1},${down}`);
    }
    for (const wheel of WHEEL_BITS) {
      if ((mask >> wheel.bit) & 1 && !((was >> wheel.bit) & 1)) out.push(`s,${wheel.dx * notches},${wheel.dy * notches}`);
    }
    this.#mask = mask;
    return out;
  }
}

export interface VoxlRelayOptions {
  readonly viewer: VoxlViewer;
  readonly open: OpenVoxl;
  mayInput(): boolean;
  onSize?(size: Size): void;
  onResize?(size: Size): void;
  onEnd?(by: "viewer" | "box", error: Error | null): void;
  keyLog?(line: string): void;
  readonly connectTimeoutMs?: number;
}

export class VoxlRelay {
  readonly #options: VoxlRelayOptions;
  readonly #socket: Promise<BoxWebSocket>;
  readonly #input = new ViewerInput();
  #ended = false;
  #size: Size | null = null;
  #lastSent: number | null = null;
  #early: ToVoxl[] | null = [];

  constructor(options: VoxlRelayOptions) {
    this.#options = options;
    this.#socket = (async () => {
      const signal = AbortSignal.timeout(options.connectTimeoutMs ?? 20_000);
      return BoxWebSocket.upgrade(await options.open(signal), { host: "localhost", path: VOXL_PATH, signal });
    })();
    this.#socket.catch(() => undefined);
    void this.#pump();
  }

  get size(): Size | null {
    return this.#size;
  }

  get holding(): boolean {
    return this.#input.holding;
  }

  async #pump(): Promise<void> {
    let socket: BoxWebSocket;
    try {
      socket = await this.#socket;
    } catch (error) {
      await this.#end("box", error instanceof Error ? error : new Error(String(error)));
      return;
    }
    try {
      for (const message of this.#early ?? []) await socket.send(message);
      this.#early = null;
      for (let message = await socket.next(); message !== null && !this.#ended; message = await socket.next()) this.#toViewer(message);
      const closed = socket.closedWith;
      await this.#end("box", closed && closed.code !== 1000 && closed.code !== 1005 ? new WebSocketError(`The box's voxl closed the connection (${closed.code}).`) : null);
    } catch (error) {
      await this.#end("box", error instanceof Error ? error : new Error(String(error)));
    }
  }

  #toViewer(message: Message): void {
    if (typeof message === "string") {
      this.#serverText(parseServerText(message));
      return;
    }
    switch (message[0]) {
      case VOXL_VIDEO: {
        if (!this.#size) return;
        const translated = viewerFrame(message, this.#size);
        if (!translated) return;
        this.#lastSent = translated.id;
        this.#options.viewer.send(translated.frame);
        return;
      }
      case VOXL_CURSOR: {
        const text = cursorText(message);
        if (text) this.#options.viewer.send(text);
        return;
      }
      case VOXL_CLIPBOARD_IMAGE:
        if (this.#options.mayInput() && message.byteLength > 1) for (const text of clipboardImageTexts(message.subarray(1))) this.#options.viewer.send(text);
        return;
      default:
        return;
    }
  }

  #serverText(message: VoxlServerText): void {
    switch (message.t) {
      case "hello": {
        const size = { width: message.w, height: message.h };
        const changed = !this.#size || this.#size.width !== size.width || this.#size.height !== size.height;
        this.#size = size;
        this.#lastSent = null;
        if (changed && size.width && size.height) this.#options.onSize?.(size);
        return;
      }
      case "ping":
        this.#options.viewer.send(`${VOXL_PING_VERB},${message.s}`);
        return;
      case "clip":
        if (this.#options.mayInput()) for (const text of clipboardTexts(message.d)) this.#options.viewer.send(text);
        return;
      case "close":
        void this.#end("box", new WebSocketError("The box's voxl dropped this viewer, which had fallen too far behind."));
        return;
      case "other":
        return;
    }
  }

  async #toBox(messages: readonly ToVoxl[]): Promise<void> {
    if (this.#early) {
      this.#early.push(...messages);
      return;
    }
    const socket = await this.#socket;
    for (const message of messages) await socket.send(message).catch(() => undefined);
  }

  async receive(message: Message): Promise<void> {
    if (this.#ended || typeof message !== "string") return;
    switch (viewerMessageKind(message)) {
      case "watching":
        await this.#toBox(this.#watching(message));
        return;
      case "resize": {
        if (!this.#options.mayInput()) return;
        const [width, height] = message.slice(2).split("x").map(Number) as [number, number];
        this.#options.onResize?.({ width, height });
        return;
      }
      case "input": {
        const key = /^(kd|ku|kr)\b/.test(message);
        if (!this.#options.mayInput()) {
          if (key) this.#options.keyLog?.(`dropped, as the viewer has no control: ${message}`);
          return;
        }
        if (key) this.#options.keyLog?.(`to the box: ${message}, at ${Date.now() % 100_000} ms`);
        await this.#toBox(this.#input.translate(message));
        return;
      }
      case "drop":
        return;
    }
  }

  #watching(text: string): ToVoxl[] {
    const verb = verbOf(text);
    switch (verb) {
      case "CLIENT_FRAME_ACK": {
        const id = Number(text.split(" ")[1]);
        if (this.#lastSent === null || !Number.isInteger(id) || id < 0 || id > 0xffff) return [];
        return [`a,${fullFrameId(id, this.#lastSent)}`];
      }
      case "START_VIDEO":
        return ["v,1"];
      case "STOP_VIDEO":
        return ["v,0"];
      case "REQUEST_KEYFRAME":
        return ["kf"];
      case VOXL_PONG_VERB: {
        const sent = text.slice(VOXL_PONG_VERB.length + 1);
        return /^\d{1,20}$/.test(sent) ? [`po,${sent}`] : [];
      }
      default:
        return [];
    }
  }

  async release(): Promise<void> {
    const messages = this.#input.release();
    if (messages.length) await this.#toBox(messages);
  }

  close(): Promise<void> {
    return this.#end("viewer", null);
  }

  async #end(by: "viewer" | "box", error: Error | null): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    if (by === "viewer") {
      const messages = this.#input.release();
      if (messages.length && !this.#early) {
        const socket = await this.#socket.catch(() => null);
        for (const message of messages) await socket?.send(message).catch(() => undefined);
      }
    }
    await this.#socket.then((socket) => socket.close()).catch(() => undefined);
    if (by === "box") this.#options.viewer.close(error ? 1011 : 1000, (error?.message ?? "The box's desktop closed the connection.").slice(0, 120));
    this.#options.onEnd?.(by, error);
  }
}
