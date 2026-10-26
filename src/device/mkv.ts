import { closeSync, openSync, writeSync } from "node:fs";
import { NAL_TYPES, nalUnits, type NalUnit } from "./annexb.ts";

const IDS = {
  ebml: 0x1a45dfa3,
  ebmlVersion: 0x4286,
  ebmlReadVersion: 0x42f7,
  ebmlMaxIdLength: 0x42f2,
  ebmlMaxSizeLength: 0x42f3,
  docType: 0x4282,
  docTypeVersion: 0x4287,
  docTypeReadVersion: 0x4285,
  segment: 0x18538067,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  muxingApp: 0x4d80,
  writingApp: 0x5741,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackUid: 0x73c5,
  trackType: 0x83,
  codecId: 0x86,
  codecPrivate: 0x63a2,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  cluster: 0x1f43b675,
  timecode: 0xe7,
  simpleBlock: 0xa3,
} as const;

const UNKNOWN_SIZE = Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
const MOST_BLOCK_OFFSET_MS = 30_000;
const VIDEO_TRACK = 1;
const KEY_FLAG = 0x80;

function idBytes(id: number): Uint8Array {
  const bytes: number[] = [];
  for (let rest = id; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return Uint8Array.from(bytes);
}

export function sizeBytes(size: number): Uint8Array {
  let length = 1;
  while (size >= 2 ** (7 * length) - 1) length++;
  const bytes = new Uint8Array(length);
  let rest = size;
  for (let at = length - 1; at >= 0; at--) {
    bytes[at] = rest & 0xff;
    rest = Math.floor(rest / 256);
  }
  bytes[0] = (bytes[0] ?? 0) | (0x80 >> (length - 1));
  return bytes;
}

function joined(parts: readonly Uint8Array[]): Uint8Array {
  const whole = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.byteLength;
  }
  return whole;
}

function element(id: number, body: Uint8Array): Uint8Array {
  return joined([idBytes(id), sizeBytes(body.byteLength), body]);
}

function unsigned(id: number, value: number): Uint8Array {
  const bytes: number[] = [];
  for (let rest = value; rest > 0 || !bytes.length; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return element(id, Uint8Array.from(bytes));
}

function textElement(id: number, value: string): Uint8Array {
  return element(id, new TextEncoder().encode(value));
}

function master(id: number, children: readonly Uint8Array[]): Uint8Array {
  return element(id, joined(children));
}

export function avcConfiguration(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  return joined([Uint8Array.of(1, sps[1] ?? 0, sps[2] ?? 0, sps[3] ?? 0, 0xff, 0xe1, sps.byteLength >> 8, sps.byteLength & 0xff), sps, Uint8Array.of(1, pps.byteLength >> 8, pps.byteLength & 0xff), pps]);
}

export function lengthPrefixed(units: readonly NalUnit[]): Uint8Array {
  const kept = units.filter((unit) => unit.type !== NAL_TYPES.delimiter);
  return joined(kept.flatMap((unit) => [Uint8Array.of(unit.body.byteLength >>> 24, (unit.body.byteLength >> 16) & 0xff, (unit.body.byteLength >> 8) & 0xff, unit.body.byteLength & 0xff), unit.body]));
}

export interface ParameterSets {
  readonly sps: Uint8Array;
  readonly pps: Uint8Array;
}

export function parameterSetsOf(units: readonly NalUnit[]): ParameterSets | null {
  const sps = units.find((unit) => unit.type === NAL_TYPES.sps);
  const pps = units.find((unit) => unit.type === NAL_TYPES.pps);
  return sps && pps ? { sps: sps.body, pps: pps.body } : null;
}

export class MkvWriter {
  readonly #fd: number;
  #clusterAt: number | null = null;
  #lastAt = 0;
  #closed = false;

  private constructor(fd: number) {
    this.#fd = fd;
  }

  static open(path: string, size: { readonly width: number; readonly height: number }, sets: ParameterSets): MkvWriter {
    const fd = openSync(path, "w", 0o600);
    const writer = new MkvWriter(fd);
    const header = master(IDS.ebml, [
      unsigned(IDS.ebmlVersion, 1),
      unsigned(IDS.ebmlReadVersion, 1),
      unsigned(IDS.ebmlMaxIdLength, 4),
      unsigned(IDS.ebmlMaxSizeLength, 8),
      textElement(IDS.docType, "matroska"),
      unsigned(IDS.docTypeVersion, 4),
      unsigned(IDS.docTypeReadVersion, 2),
    ]);
    const info = master(IDS.info, [unsigned(IDS.timecodeScale, 1_000_000), textElement(IDS.muxingApp, "bb-box-device"), textElement(IDS.writingApp, "bb-box-device")]);
    const track = master(IDS.trackEntry, [
      unsigned(IDS.trackNumber, VIDEO_TRACK),
      unsigned(IDS.trackUid, 1),
      unsigned(IDS.trackType, 1),
      textElement(IDS.codecId, "V_MPEG4/ISO/AVC"),
      element(IDS.codecPrivate, avcConfiguration(sets.sps, sets.pps)),
      master(IDS.video, [unsigned(IDS.pixelWidth, size.width), unsigned(IDS.pixelHeight, size.height)]),
    ]);
    writer.#write(joined([header, idBytes(IDS.segment), UNKNOWN_SIZE, info, master(IDS.tracks, [track])]));
    return writer;
  }

  #write(bytes: Uint8Array): void {
    let at = 0;
    while (at < bytes.byteLength) at += writeSync(this.#fd, bytes, at, bytes.byteLength - at);
  }

  write(atMs: number, key: boolean, annexB: Uint8Array): void {
    if (this.#closed) return;
    const at = Math.max(this.#lastAt, Math.round(atMs));
    const parts: Uint8Array[] = [];
    if (this.#clusterAt === null || key || at - this.#clusterAt > MOST_BLOCK_OFFSET_MS) {
      this.#clusterAt = at;
      parts.push(idBytes(IDS.cluster), UNKNOWN_SIZE, unsigned(IDS.timecode, at));
    }
    const offset = at - this.#clusterAt;
    const data = lengthPrefixed(nalUnits(annexB));
    parts.push(element(IDS.simpleBlock, joined([Uint8Array.of(0x80 | VIDEO_TRACK, (offset >> 8) & 0xff, offset & 0xff, key ? KEY_FLAG : 0), data])));
    this.#write(joined(parts));
    this.#lastAt = at;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    closeSync(this.#fd);
  }
}
