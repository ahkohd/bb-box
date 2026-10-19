// bb-box: asks the box's Selkies for video, as its one page (a lone
// role=viewer page gets none), and says what came in that time, for the
// desktop check (#863).
//   node selkies-probe.mjs <port> <seconds>
// Prints {"frames":n,"keys":n,"kbytes":n}; exits 1 when Selkies does not answer.
const [port = "5980", seconds = "3"] = process.argv.slice(2);
const socket = new WebSocket(`ws://127.0.0.1:${port}/api/websockets`);
socket.binaryType = "arraybuffer";
let frames = 0;
let keys = 0;
let bytes = 0;
let mode = false;
socket.onmessage = (event) => {
  if (typeof event.data === "string") {
    if (event.data.startsWith("MODE")) {
      mode = true;
      socket.send(`SETTINGS,${JSON.stringify({ displayId: "primary" })}`);
      socket.send("START_VIDEO");
    }
    return;
  }
  const data = new Uint8Array(event.data);
  if (data[0] !== 4) return;
  frames++;
  bytes += data.length;
  if ((data[1] & 1) === 1) keys++;
};
socket.onerror = () => {
  console.log(`no answer from Selkies on 127.0.0.1:${port}`);
  process.exit(1);
};
setTimeout(() => {
  console.log(JSON.stringify({ frames, keys, kbytes: Math.round(bytes / 1024) }));
  socket.close();
  process.exit(mode ? 0 : 1);
}, Number(seconds) * 1000);
