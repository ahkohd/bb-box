import { readFileSync } from "node:fs";
import { GrpcClient } from "../../../src/device/grpc.ts";
import { screenshot } from "../../../src/device/idb.ts";
const targets = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as { socket: string }[];
const client = new GrpcClient({ socket: targets[0]!.socket });
const times: number[] = [];
let bytes = 0;
for (let index = 0; index < Number(process.argv[3] ?? 10); index++) {
  const started = performance.now();
  const png = await screenshot(client);
  times.push(performance.now() - started);
  bytes = png.byteLength;
  await new Promise((resolve) => setTimeout(resolve, 200));
}
times.sort((a, b) => a - b);
console.log(`${process.argv[4] ?? "shots"}: ${times.length} screenshots, median ${times[Math.floor(times.length / 2)]!.toFixed(0)} ms, worst ${times.at(-1)!.toFixed(0)} ms, ${bytes} bytes`);
client.close();
process.exit(0);
