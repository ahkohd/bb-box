import { GrpcClient } from "../../../src/device/grpc.ts";
import { streamOutput } from "../../../src/device/idb.ts";
import { encode } from "../../../src/device/protobuf.ts";
import { GRPC_METHODS, IDB_SCHEMA } from "../../../src/device/schemas.ts";
const started = performance.now();
const client = new GrpcClient({ socket: process.argv[2]! });
async function* requests() { yield encode(IDB_SCHEMA, "idb.VideoStreamRequest", { start: { format: 0, compression_quality: 0.2, scale_factor: 1 } }); await new Promise(() => {}); }
for await (const message of client.call(GRPC_METHODS.idb.videoStream, requests(), {})) {
  if (streamOutput(message).data) { console.log(`first frame ${Math.round(performance.now() - started)} ms after connecting`); process.exit(0); }
}
