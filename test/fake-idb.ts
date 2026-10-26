import { appendFileSync, rmSync } from "node:fs";
import { createServer } from "node:http2";
import { parseArgs } from "node:util";
import { Deframer, frame } from "../src/device/grpc.ts";
import { decode, encode } from "../src/device/protobuf.ts";
import { GRPC_METHODS, IDB_SCHEMA } from "../src/device/schemas.ts";
import { evenScaled, spsOfSize } from "./sps.ts";

const IPHONE_SPS = "27640032ac13142404c0149e6a9a80868083c2010898";
const START = Uint8Array.of(0, 0, 0, 1);
const PPS = Uint8Array.of(0x68, 0xee, 0x3c, 0x80);
const IDR = Uint8Array.of(0x65, 0x88, 0x84, 0x00, 0x21);
const DELTA = Uint8Array.of(0x41, 0x9a, 0x02, 0x04);

function annexB(...units: Uint8Array[]): Uint8Array {
  return Uint8Array.from(units.flatMap((unit) => [...START, ...unit]));
}

const KEY_FRAME = annexB(Buffer.from(IPHONE_SPS, "hex"), PPS, IDR);

function keyFrameAt(scale: number): Uint8Array {
  return scale === 1 ? KEY_FRAME : annexB(spsOfSize(evenScaled(1206, scale), evenScaled(2622, scale)), PPS, IDR);
}
const DELTA_FRAME = annexB(DELTA);

function payload(data: Uint8Array): Buffer {
  return Buffer.from(frame(encode(IDB_SCHEMA, "idb.VideoStreamResponse", { payload: { data } })));
}

const { values } = parseArgs({ options: { udid: { type: "string" }, "grpc-domain-sock": { type: "string" } }, strict: false });
const socket = String(values["grpc-domain-sock"]);
const log = process.env.FAKE_IDB_LOG;
const still = process.env.FAKE_IDB_STILL === "1";
const note = (line: string) => log && appendFileSync(log, `${process.pid} ${line}\n`);

let orientation = 1;

rmSync(socket, { force: true });
const server = createServer();
server.on("stream", (stream, headers) => {
  const path = String(headers[":path"]);
  const deframer = new Deframer();
  const ok = () => {
    stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
    stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
  };
  if (path === GRPC_METHODS.idb.videoStream) {
    let messages = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    stream.on("error", () => undefined);
    stream.on("close", () => timer && clearInterval(timer));
    stream.on("data", (chunk: Buffer) => {
      const received = deframer.push(new Uint8Array(chunk));
      const first = messages === 0 ? received[0] : undefined;
      messages += received.length;
      if (messages >= 1 && first && !timer) {
        const asked = decode(IDB_SCHEMA, "idb.VideoStreamRequest", first) as { start?: { scale_factor?: number } };
        const scale = asked.start?.scale_factor ?? 1;
        note(`stream ${values.udid} scale ${Math.round(scale * 1000) / 1000}`);
        ok();
        stream.write(payload(keyFrameAt(scale)));
        timer = setInterval(() => !still && stream.write(payload(DELTA_FRAME)), 30);
      } else if (messages >= 2) {
        if (timer) clearInterval(timer);
        stream.end();
      }
    });
    return;
  }
  if (path === GRPC_METHODS.idb.hid) {
    stream.on("error", () => undefined);
    stream.on("data", (chunk: Buffer) => {
      for (const message of deframer.push(new Uint8Array(chunk))) note(`hid ${JSON.stringify(decode(IDB_SCHEMA, "idb.HIDEvent", message))}`);
    });
    stream.on("end", () => {
      ok();
      stream.end(Buffer.from(frame(new Uint8Array(0))));
    });
    return;
  }
  const asked: Uint8Array[] = [];
  stream.on("data", (chunk: Buffer) => asked.push(...deframer.push(new Uint8Array(chunk))));
  stream.on("end", () => {
    ok();
    if (path === GRPC_METHODS.idb.setOrientation) {
      const to = (decode(IDB_SCHEMA, "idb.SetOrientationRequest", asked[0] ?? new Uint8Array(0)) as { orientation?: number }).orientation ?? 0;
      orientation = to + 1;
      note(`orientation ${to}`);
      stream.end(Buffer.from(frame(new Uint8Array(0))));
    } else if (path === GRPC_METHODS.idb.getOrientation) stream.end(Buffer.from(frame(encode(IDB_SCHEMA, "idb.GetOrientationResponse", { orientation }))));
    else if (path === GRPC_METHODS.idb.screenshot) stream.end(Buffer.from(frame(encode(IDB_SCHEMA, "idb.ScreenshotResponse", { image_data: Uint8Array.of(137, 80, 78, 71) }))));
    else stream.end(Buffer.from(frame(new Uint8Array(0))));
  });
});
server.listen(socket, () => note(`listening ${values.udid} at ${Date.now()}`));
process.on("SIGTERM", () => process.exit(0));
