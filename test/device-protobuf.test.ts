import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Http2Server } from "node:http2";
import type { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";
import { Deframer, GrpcClient, GrpcError, frame } from "../src/device/grpc.ts";
import { decode, encode, ProtobufError, type FieldSpec, type ProtoMessage, type ProtoValue, type Schema } from "../src/device/protobuf.ts";
import { EMULATOR_SCHEMA, GRPC_METHODS, IDB_SCHEMA } from "../src/device/schemas.ts";

const PROTOS = new URL("./fixtures/proto/", import.meta.url);
const SCALARS = new Set(["double", "float", "int32", "int64", "uint32", "uint64", "sint32", "bool", "string", "bytes"]);

interface ParsedField {
  readonly name: string;
  readonly number: number;
  readonly type: string;
  readonly repeated: boolean;
  readonly oneof: string | null;
}

interface ParsedProto {
  readonly messages: Map<string, ParsedField[]>;
  readonly enums: Set<string>;
  readonly rpcs: Set<string>;
}

function parseProto(text: string): ParsedProto {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const tokens = clean.match(/[A-Za-z_][A-Za-z0-9_.]*|-?\d+(?:\.\d+)?|"[^"]*"|[{}=;[\]<>,()]/g) ?? [];
  const messages = new Map<string, ParsedField[]>();
  const enums = new Set<string>();
  const rpcs = new Set<string>();
  const scopes: { readonly kind: "message" | "oneof" | "enum" | "service" | "block"; readonly name: string }[] = [];
  let pkg = "";
  let service = "";
  const scopeName = () => [pkg, ...scopes.filter((scope) => scope.kind === "message").map((scope) => scope.name)].filter(Boolean).join(".");
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at]!;
    const inEnum = scopes.at(-1)?.kind === "enum";
    if (token === "}") {
      scopes.pop();
      continue;
    }
    if (inEnum) {
      if (token === "{") scopes.push({ kind: "block", name: "" });
      continue;
    }
    if (token === "{") {
      scopes.push({ kind: "block", name: "" });
      continue;
    }
    if (token === "package") {
      pkg = tokens[++at]!;
      continue;
    }
    if (token === "syntax" || token === "import" || token === "option" || token === "reserved") {
      while (tokens[at] !== ";") at++;
      continue;
    }
    if (token === "message" || token === "enum" || token === "oneof" || token === "service") {
      const name = tokens[++at]!;
      at++;
      if (token === "message") messages.set(`${scopeName()}.${name}`.replace(/^\./, ""), []);
      if (token === "enum") enums.add(`${scopeName()}.${name}`.replace(/^\./, ""));
      if (token === "service") service = name;
      scopes.push({ kind: token, name });
      continue;
    }
    if (token === "rpc") {
      rpcs.add(`/${pkg}.${service}/${tokens[at + 1]}`);
      while (tokens[at] !== ";" && tokens[at] !== "{") at++;
      if (tokens[at] === "{") scopes.push({ kind: "block", name: "" });
      continue;
    }
    const top = scopes.at(-1);
    if (!top || (top.kind !== "message" && top.kind !== "oneof")) continue;
    if (token === "map") {
      while (tokens[at] !== ";") at++;
      continue;
    }
    const repeated = token === "repeated";
    const type = repeated || token === "optional" ? tokens[++at]! : token;
    const name = tokens[++at]!;
    if (tokens[++at] !== "=") continue;
    const number = Number(tokens[++at]);
    while (tokens[at] !== ";") at++;
    messages.get(scopeName())!.push({ name, number, type, repeated, oneof: top.kind === "oneof" ? top.name : null });
  }
  return { messages, enums, rpcs };
}

function resolve(proto: ParsedProto, scope: string, type: string): { readonly type: FieldSpec["type"]; readonly message?: string } {
  if (SCALARS.has(type)) return { type: type as FieldSpec["type"] };
  const parts = scope.split(".");
  for (let depth = parts.length; depth >= 0; depth--) {
    const candidate = [...parts.slice(0, depth), type].join(".");
    if (proto.enums.has(candidate)) return { type: "enum" };
    if (proto.messages.has(candidate)) return { type: "message", message: candidate };
  }
  throw new Error(`${type} is not found from ${scope}`);
}

function checkSchema(schema: Schema, proto: ParsedProto): number {
  let checked = 0;
  for (const [name, fields] of Object.entries(schema)) {
    const declared = proto.messages.get(name);
    assert.ok(declared, `${name} is in the .proto file`);
    for (const field of fields) {
      const own: ParsedField | undefined = declared.find((each) => each.number === field.number);
      assert.ok(own, `${name} has field number ${field.number}`);
      const resolved = resolve(proto, name, own.type);
      assert.deepEqual(
        { name: field.name, type: field.type, message: field.message, repeated: !!field.repeated, oneof: field.oneof ?? null },
        { name: own.name, type: resolved.type, message: resolved.message, repeated: own.repeated, oneof: own.oneof },
        `${name}.${own.name}`,
      );
      checked++;
    }
  }
  return checked;
}

const EMULATOR_PROTO = parseProto(readFileSync(new URL("emulator_controller.proto", PROTOS), "utf8"));
const IDB_PROTO = parseProto(readFileSync(new URL("idb.proto", PROTOS), "utf8"));

function schemaFor(message: string): Schema {
  return message.startsWith("idb.") ? IDB_SCHEMA : EMULATOR_SCHEMA;
}

function revive(schema: Schema, message: string, json: Readonly<Record<string, unknown>>): ProtoMessage {
  const fields = schema[message]!;
  const out: Record<string, ProtoValue> = {};
  for (const [key, value] of Object.entries(json)) {
    const field = fields.find((each) => each.name === key)!;
    const one = (item: unknown): ProtoValue =>
      field.type === "message" ? revive(schema, field.message!, item as Record<string, unknown>) : field.type === "bytes" ? new Uint8Array(Buffer.from((item as { base64: string }).base64, "base64")) : (item as ProtoValue);
    out[key] = field.repeated ? (value as unknown[]).map(one) : one(value);
  }
  return out;
}

function withDefaults(schema: Schema, message: string, value: ProtoMessage): ProtoMessage {
  const out: Record<string, ProtoValue> = {};
  for (const [key, given] of Object.entries(value)) {
    const field = schema[message]!.find((each) => each.name === key)!;
    out[key] = field.type === "message" ? (field.repeated ? (given as ProtoMessage[]).map((item) => withDefaults(schema, field.message!, item)) : withDefaults(schema, field.message!, given as ProtoMessage)) : given!;
  }
  return out;
}

const GOLDEN = JSON.parse(readFileSync(new URL("./fixtures/device-protobuf.json", import.meta.url), "utf8")) as {
  readonly protoc: string;
  readonly cases: readonly { readonly message: string; readonly text: string; readonly value: Record<string, unknown>; readonly hex: string }[];
};

describe("the device server's protobuf codec", () => {
  test("has the field numbers, types and oneofs of idb 1.7.7's and emulator 37.2.12.0's .proto files", () => {
    assert.ok(checkSchema(EMULATOR_SCHEMA, EMULATOR_PROTO) >= 40);
    assert.ok(checkSchema(IDB_SCHEMA, IDB_PROTO) >= 30);
  });

  test("calls rpcs that the services declare", () => {
    for (const path of Object.values(GRPC_METHODS.emulator)) assert.ok(EMULATOR_PROTO.rpcs.has(path), path);
    for (const path of Object.values(GRPC_METHODS.idb)) assert.ok(IDB_PROTO.rpcs.has(path), path);
  });

  for (const golden of GOLDEN.cases) {
    test(`encodes and decodes ${golden.message} { ${golden.text.slice(0, 50)} } as protoc does`, () => {
      const schema = schemaFor(golden.message);
      const value = revive(schema, golden.message, golden.value);
      assert.equal(Buffer.from(encode(schema, golden.message, value)).toString("hex"), golden.hex, GOLDEN.protoc);
      assert.deepEqual(decode(schema, golden.message, Buffer.from(golden.hex, "hex")), withDefaults(schema, golden.message, value));
    });
  }

  test("refuses two fields of one oneof, a field it does not have, and a negative unsigned number", () => {
    assert.throws(() => encode(IDB_SCHEMA, "idb.HIDEvent", { press: {}, delay: {} }), ProtobufError);
    assert.throws(() => encode(IDB_SCHEMA, "idb.Point", { z: 1 }), ProtobufError);
    assert.throws(() => encode(EMULATOR_SCHEMA, "android.emulation.control.ImageFormat", { width: -1 }), ProtobufError);
  });

  test("skips fields it does not know, as a newer emulator may send", () => {
    const withUnknown = Buffer.concat([Buffer.from("0a0161", "hex"), Buffer.from("f80601", "hex"), Buffer.from("8207026869", "hex")]);
    assert.deepEqual(decode(EMULATOR_SCHEMA, "android.emulation.control.ClipData", withUnknown), { text: "a" });
  });
});

describe("the device server's gRPC client", () => {
  let server: Http2Server;
  const seen: { path: string; authorization: string | undefined; messages: Uint8Array[] }[] = [];
  after(() => server?.close());

  async function listening(): Promise<string> {
    server = createServer();
    server.on("stream", (stream, headers) => {
      const path = String(headers[":path"]);
      const call = { path, authorization: headers.authorization as string | undefined, messages: [] as Uint8Array[] };
      seen.push(call);
      const deframer = new Deframer();
      stream.on("data", (chunk: Buffer) => call.messages.push(...deframer.push(new Uint8Array(chunk))));
      stream.on("end", () => {
        if (path === "/android.emulation.control.EmulatorController/getClipboard") {
          stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
          stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
          stream.end(Buffer.from(frame(encode(EMULATOR_SCHEMA, "android.emulation.control.ClipData", { text: "copied" }))));
        } else if (path === "/android.emulation.control.EmulatorController/streamScreenshot") {
          stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
          stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
          const images = [1, 2, 3].map((seq) => frame(encode(EMULATOR_SCHEMA, "android.emulation.control.Image", { seq, image: new Uint8Array([seq]) })));
          stream.write(Buffer.concat([Buffer.from(images[0]!), Buffer.from(images[1]!.subarray(0, 3))]));
          stream.end(Buffer.concat([Buffer.from(images[1]!.subarray(3)), Buffer.from(images[2]!)]));
        } else if (path === "/idb.CompanionService/hid") {
          stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
          stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
          stream.end(Buffer.from(frame(new Uint8Array(0))));
        } else {
          stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": "16", "grpc-message": encodeURIComponent("no token, or a wrong one") }, { endStream: true });
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  test("makes unary, server-streaming and client-streaming calls with a token, and gives the status's words", async () => {
    const client = new GrpcClient({ tcp: await listening() });
    const metadata = { authorization: "Bearer token-of-this-start" };
    const clip = await client.unary(GRPC_METHODS.emulator.getClipboard, new Uint8Array(0), { metadata });
    assert.deepEqual(decode(EMULATOR_SCHEMA, "android.emulation.control.ClipData", clip), { text: "copied" });
    const seqs: ProtoValue[] = [];
    for await (const image of client.call(GRPC_METHODS.emulator.streamScreenshot, [encode(EMULATOR_SCHEMA, "android.emulation.control.ImageFormat", { format: 2 })], { metadata })) seqs.push(decode(EMULATOR_SCHEMA, "android.emulation.control.Image", image).seq!);
    assert.deepEqual(seqs, [1, 2, 3]);
    const touch = (x: number) => encode(IDB_SCHEMA, "idb.HIDEvent", { press: { action: { touch: { point: { x, y: 10 } } } } });
    async function* touches() {
      yield touch(1);
      yield touch(2);
    }
    for await (const _ of client.call(GRPC_METHODS.idb.hid, touches())) void _;
    assert.equal(seen.find((call) => call.path === GRPC_METHODS.idb.hid)?.messages.length, 2);
    assert.equal(seen[0]?.authorization, "Bearer token-of-this-start");
    await assert.rejects(client.unary(GRPC_METHODS.emulator.sendTouch, new Uint8Array(0)), (error: unknown) => error instanceof GrpcError && error.status === 16 && error.message === "no token, or a wrong one");
    client.close();
  });
});
