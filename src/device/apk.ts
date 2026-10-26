import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_ENTRY = 0x02014b50;
const LOCAL_ENTRY = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;
const MANIFEST = "AndroidManifest.xml";
const STRING_POOL = 0x0001;
const START_ELEMENT = 0x0102;
const UTF8_STRINGS = 0x100;
const NO_STRING = 0xffffffff;

function zipEntry(zip: Buffer, wanted: string): Buffer | null {
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
    if (zip.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end < 0) return null;
  const entries = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let entry = 0; entry < entries && at + 46 <= zip.length; entry++) {
    if (zip.readUInt32LE(at) !== CENTRAL_ENTRY) return null;
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    if (name === wanted) {
      if (zip.readUInt32LE(local) !== LOCAL_ENTRY) return null;
      const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const bytes = zip.subarray(data, data + compressed);
      if (method === STORED) return bytes;
      if (method === DEFLATED) return inflateRawSync(bytes);
      return null;
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function poolStrings(xml: Buffer, at: number): readonly string[] {
  const headerSize = xml.readUInt16LE(at + 2);
  const count = xml.readUInt32LE(at + 8);
  const flags = xml.readUInt32LE(at + 16);
  const stringsStart = at + xml.readUInt32LE(at + 20);
  const utf8 = (flags & UTF8_STRINGS) !== 0;
  const strings: string[] = [];
  for (let index = 0; index < count; index++) {
    let from = stringsStart + xml.readUInt32LE(at + headerSize + index * 4);
    if (utf8) {
      from += xml[from]! & 0x80 ? 2 : 1;
      const bytes = xml[from]! & 0x80 ? ((xml[from]! & 0x7f) << 8) | xml[from + 1]! : xml[from]!;
      from += xml[from]! & 0x80 ? 2 : 1;
      strings.push(xml.toString("utf8", from, from + bytes));
    } else {
      let units = xml.readUInt16LE(from);
      from += 2;
      if (units & 0x8000) {
        units = ((units & 0x7fff) << 16) | xml.readUInt16LE(from);
        from += 2;
      }
      strings.push(xml.toString("utf16le", from, from + units * 2));
    }
  }
  return strings;
}

export function manifestPackage(xml: Buffer): string | null {
  let strings: readonly string[] = [];
  let at = xml.readUInt16LE(2);
  while (at + 8 <= xml.length) {
    const type = xml.readUInt16LE(at);
    const size = xml.readUInt32LE(at + 4);
    if (size < 8) return null;
    if (type === STRING_POOL) strings = poolStrings(xml, at);
    if (type === START_ELEMENT) {
      const attributesAt = at + 16 + xml.readUInt16LE(at + 24);
      const attributeSize = xml.readUInt16LE(at + 26);
      const attributes = xml.readUInt16LE(at + 28);
      for (let index = 0; index < attributes; index++) {
        const attribute = attributesAt + index * attributeSize;
        if (strings[xml.readUInt32LE(attribute + 4)] !== "package") continue;
        const raw = xml.readUInt32LE(attribute + 8);
        return raw === NO_STRING ? null : (strings[raw] ?? null);
      }
      return null;
    }
    at += size;
  }
  return null;
}

export async function apkPackage(path: string): Promise<string | null> {
  try {
    const manifest = zipEntry(await readFile(path), MANIFEST);
    return manifest ? manifestPackage(manifest) : null;
  } catch {
    return null;
  }
}
