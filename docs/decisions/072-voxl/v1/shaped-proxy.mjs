import { createServer, connect } from "node:net";

const [listenText, targetText] = process.argv.slice(2);
const listenPort = Number(listenText ?? 7001);
const targetPort = Number(targetText ?? 7000);
const megabitsPerSecond = Number(process.env.RATE_MBIT ?? 10);
const roundTripMs = Number(process.env.RTT_MS ?? 40);
const oneWayMs = roundTripMs / 2;
const bytesPerMs = (megabitsPerSecond * 1e6) / 8 / 1000;

function delayed(destination) {
  const queue = [];
  let timer = null;
  const pump = () => {
    timer = null;
    const now = performance.now();
    while (queue.length && queue[0].due <= now) destination.write(queue.shift().chunk);
    if (queue.length) timer = setTimeout(pump, Math.max(0, queue[0].due - now));
  };
  return (chunk) => {
    queue.push({ chunk, due: performance.now() + oneWayMs });
    if (!timer) timer = setTimeout(pump, oneWayMs);
  };
}

function bottleneck(destination) {
  const queue = [];
  let linkFreeAt = 0;
  let timer = null;
  const pump = () => {
    timer = null;
    const now = performance.now();
    while (queue.length && queue[0].due <= now) destination.write(queue.shift().chunk);
    if (queue.length) timer = setTimeout(pump, Math.max(0, queue[0].due - now));
  };
  return (chunk) => {
    const now = performance.now();
    linkFreeAt = Math.max(linkFreeAt, now) + chunk.length / bytesPerMs;
    queue.push({ chunk, due: linkFreeAt + oneWayMs });
    if (!timer) timer = setTimeout(pump, Math.max(0, queue[0].due - now));
  };
}

createServer((client) => {
  const upstream = connect({ host: "127.0.0.1", port: targetPort });
  client.setNoDelay(true);
  upstream.setNoDelay(true);
  const toUpstream = delayed(upstream);
  const toClient = bottleneck(client);
  client.on("data", toUpstream);
  upstream.on("data", toClient);
  const end = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", end);
  upstream.on("error", end);
  client.on("close", end);
  upstream.on("close", end);
}).listen(listenPort, "127.0.0.1", () => console.log(`shaped ${megabitsPerSecond} Mbit/s, ${roundTripMs} ms round trip, on ${listenPort} to ${targetPort}`));
