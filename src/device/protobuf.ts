export type ScalarType = "double" | "float" | "int32" | "int64" | "uint32" | "uint64" | "sint32" | "bool" | "string" | "bytes" | "enum";

export interface FieldSpec {
  readonly name: string;
  readonly number: number;
  readonly type: ScalarType | "message";
  readonly message?: string;
  readonly repeated?: boolean;
  readonly oneof?: string;
}

export type Schema = Readonly<Record<string, readonly FieldSpec[]>>;

export type ProtoValue = number | boolean | string | Uint8Array | ProtoMessage | readonly ProtoValue[];
export interface ProtoMessage {
  readonly [field: string]: ProtoValue | undefined;
}

const VARINT = 0;
const FIXED64 = 1;
const LENGTH = 2;
const FIXED32 = 5;

export class ProtobufError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtobufError";
  }
}

class Writer {
  readonly #chunks: Uint8Array[] = [];
  #size = 0;

  #push(bytes: Uint8Array): void {
    this.#chunks.push(bytes);
    this.#size += bytes.byteLength;
  }

  varint(value: bigint): void {
    const bytes: number[] = [];
    let rest = BigInt.asUintN(64, value);
    while (rest >= 0x80n) {
      bytes.push(Number(rest & 0x7fn) | 0x80);
      rest >>= 7n;
    }
    bytes.push(Number(rest));
    this.#push(Uint8Array.from(bytes));
  }

  tag(number: number, wire: number): void {
    this.varint(BigInt((number << 3) | wire));
  }

  fixed64(value: number): void {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    this.#push(bytes);
  }

  fixed32(value: number): void {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, value, true);
    this.#push(bytes);
  }

  bytes(value: Uint8Array): void {
    this.varint(BigInt(value.byteLength));
    this.#push(value);
  }

  done(): Uint8Array {
    const out = new Uint8Array(this.#size);
    let at = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  }
}

function wireOf(type: FieldSpec["type"]): number {
  switch (type) {
    case "double":
      return FIXED64;
    case "float":
      return FIXED32;
    case "string":
    case "bytes":
    case "message":
      return LENGTH;
    default:
      return VARINT;
  }
}

function isDefault(value: ProtoValue): boolean {
  if (typeof value === "number") return value === 0 && !Object.is(value, -0);
  if (typeof value === "boolean") return !value;
  if (typeof value === "string") return value === "";
  if (value instanceof Uint8Array) return value.byteLength === 0;
  return false;
}

function scalarVarint(type: ScalarType, value: ProtoValue, path: string): bigint {
  if (type === "bool") {
    if (typeof value !== "boolean") throw new ProtobufError(`${path} must be true or false.`);
    return value ? 1n : 0n;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) throw new ProtobufError(`${path} must be a whole number.`);
  if (type === "sint32") return BigInt(value >= 0 ? value * 2 : -value * 2 - 1);
  if ((type === "uint32" || type === "uint64") && value < 0) throw new ProtobufError(`${path} must not be negative.`);
  return BigInt(value);
}

function writeScalar(writer: Writer, field: FieldSpec, value: ProtoValue, path: string): void {
  switch (field.type) {
    case "double":
      if (typeof value !== "number") throw new ProtobufError(`${path} must be a number.`);
      writer.fixed64(value);
      return;
    case "float":
      if (typeof value !== "number") throw new ProtobufError(`${path} must be a number.`);
      writer.fixed32(value);
      return;
    case "string":
      if (typeof value !== "string") throw new ProtobufError(`${path} must be text.`);
      writer.bytes(new TextEncoder().encode(value));
      return;
    case "bytes":
      if (!(value instanceof Uint8Array)) throw new ProtobufError(`${path} must be bytes.`);
      writer.bytes(value);
      return;
    case "message":
      throw new ProtobufError(`${path} is a message.`);
    default:
      writer.varint(scalarVarint(field.type, value, path));
  }
}

const PACKABLE = new Set<FieldSpec["type"]>(["double", "float", "int32", "int64", "uint32", "uint64", "sint32", "bool", "enum"]);

function writeMessage(schema: Schema, name: string, value: ProtoMessage, writer: Writer, path: string): void {
  const fields = schema[name];
  if (!fields) throw new ProtobufError(`The codec has no message ${name}.`);
  const known = new Set(fields.map((field) => field.name));
  for (const key of Object.keys(value)) if (value[key] !== undefined && !known.has(key)) throw new ProtobufError(`${path} has no field ${key}.`);
  const oneofs = new Map<string, string>();
  for (const field of [...fields].sort((a, b) => a.number - b.number)) {
    const given = value[field.name];
    if (given === undefined) continue;
    const at = `${path}.${field.name}`;
    if (field.oneof) {
      const other = oneofs.get(field.oneof);
      if (other) throw new ProtobufError(`${path} sets both ${other} and ${field.name}, of one oneof.`);
      oneofs.set(field.oneof, field.name);
    }
    if (field.repeated) {
      if (!Array.isArray(given)) throw new ProtobufError(`${at} must be a list.`);
      const items = given as readonly ProtoValue[];
      if (!items.length) continue;
      if (PACKABLE.has(field.type)) {
        const packed = new Writer();
        items.forEach((item, index) => writeScalar(packed, field, item, `${at}[${index}]`));
        writer.tag(field.number, LENGTH);
        writer.bytes(packed.done());
        continue;
      }
      items.forEach((item, index) => writeOne(schema, field, item, writer, `${at}[${index}]`));
      continue;
    }
    if (field.type !== "message" && !field.oneof && isDefault(given)) continue;
    writeOne(schema, field, given, writer, at);
  }
}

function writeOne(schema: Schema, field: FieldSpec, value: ProtoValue, writer: Writer, path: string): void {
  writer.tag(field.number, wireOf(field.type));
  if (field.type !== "message") {
    writeScalar(writer, field, value, path);
    return;
  }
  if (typeof value !== "object" || value === null || value instanceof Uint8Array || Array.isArray(value)) throw new ProtobufError(`${path} must be a message.`);
  const inner = new Writer();
  writeMessage(schema, field.message!, value as ProtoMessage, inner, path);
  writer.bytes(inner.done());
}

export function encode(schema: Schema, name: string, value: ProtoMessage): Uint8Array {
  const writer = new Writer();
  writeMessage(schema, name, value, writer, name);
  return writer.done();
}

class Reader {
  readonly #bytes: Uint8Array;
  #at: number;
  readonly #end: number;

  constructor(bytes: Uint8Array, at = 0, end = bytes.byteLength) {
    this.#bytes = bytes;
    this.#at = at;
    this.#end = end;
  }

  get done(): boolean {
    return this.#at >= this.#end;
  }

  varint(): bigint {
    let value = 0n;
    let shift = 0n;
    for (;;) {
      if (this.#at >= this.#end) throw new ProtobufError("A varint runs past the message's end.");
      const byte = this.#bytes[this.#at++]!;
      value |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return value;
      shift += 7n;
      if (shift > 63n) throw new ProtobufError("A varint is longer than 10 bytes.");
    }
  }

  take(length: number): Uint8Array {
    if (this.#at + length > this.#end) throw new ProtobufError("A field runs past the message's end.");
    const bytes = this.#bytes.subarray(this.#at, this.#at + length);
    this.#at += length;
    return bytes;
  }

  skip(wire: number): void {
    if (wire === VARINT) this.varint();
    else if (wire === FIXED64) this.take(8);
    else if (wire === LENGTH) this.take(Number(this.varint()));
    else if (wire === FIXED32) this.take(4);
    else throw new ProtobufError(`Wire type ${wire} is not one the codec reads.`);
  }
}

function varintValue(type: ScalarType, raw: bigint): number | boolean {
  switch (type) {
    case "bool":
      return raw !== 0n;
    case "int32":
    case "enum":
      return Number(BigInt.asIntN(32, raw));
    case "uint32":
      return Number(BigInt.asUintN(32, raw));
    case "sint32": {
      const n = Number(BigInt.asUintN(32, raw));
      return n & 1 ? -((n + 1) / 2) : n / 2;
    }
    case "int64":
      return Number(BigInt.asIntN(64, raw));
    default:
      return Number(BigInt.asUintN(64, raw));
  }
}

function readScalar(reader: Reader, type: ScalarType, wire: number): ProtoValue {
  if (type === "double") return new DataView(Uint8Array.from(reader.take(8)).buffer).getFloat64(0, true);
  if (type === "float") return new DataView(Uint8Array.from(reader.take(4)).buffer).getFloat32(0, true);
  if (type === "string") return new TextDecoder().decode(reader.take(Number(reader.varint())));
  if (type === "bytes") return Uint8Array.from(reader.take(Number(reader.varint())));
  if (wire !== VARINT) throw new ProtobufError(`A ${type} came as wire type ${wire}.`);
  return varintValue(type, reader.varint());
}

function readMessage(schema: Schema, name: string, bytes: Uint8Array): ProtoMessage {
  const fields = schema[name];
  if (!fields) throw new ProtobufError(`The codec has no message ${name}.`);
  const byNumber = new Map(fields.map((field) => [field.number, field]));
  const out: Record<string, ProtoValue> = {};
  const reader = new Reader(bytes);
  while (!reader.done) {
    const key = Number(reader.varint());
    const number = key >>> 3;
    const wire = key & 7;
    const field = byNumber.get(number);
    if (!field) {
      reader.skip(wire);
      continue;
    }
    if (field.oneof) for (const other of fields) if (other.oneof === field.oneof && other.name !== field.name) delete out[other.name];
    if (field.type === "message") {
      const value = readMessage(schema, field.message!, reader.take(Number(reader.varint())));
      if (field.repeated) out[field.name] = [...((out[field.name] as ProtoValue[] | undefined) ?? []), value];
      else out[field.name] = value;
      continue;
    }
    if (field.repeated) {
      const list = [...((out[field.name] as ProtoValue[] | undefined) ?? [])];
      if (wire === LENGTH && PACKABLE.has(field.type)) {
        const packed = reader.take(Number(reader.varint()));
        const inner = new Reader(packed);
        const innerWire = wireOf(field.type);
        while (!inner.done) list.push(readScalar(inner, field.type, innerWire));
      } else list.push(readScalar(reader, field.type, wire));
      out[field.name] = list;
      continue;
    }
    out[field.name] = readScalar(reader, field.type, wire);
  }
  return out;
}

export function decode(schema: Schema, name: string, bytes: Uint8Array): ProtoMessage {
  return readMessage(schema, name, bytes);
}
