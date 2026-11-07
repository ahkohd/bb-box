const [port = "5981", seconds = "3"] = process.argv.slice(2);
const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
socket.binaryType = "arraybuffer";
const VIDEO = 1;
let frames = 0;
let keys = 0;
let bytes = 0;
let hello = null;
socket.onmessage = (event) => {
  if (typeof event.data === "string") {
    const message = JSON.parse(event.data);
    if (message.t === "hello") {
      hello = `${message.w}x${message.h}`;
      socket.send("v,1");
    }
    if (message.t === "ping") socket.send(`po,${message.s}`);
    return;
  }
  const data = new Uint8Array(event.data);
  if (data[0] !== VIDEO || data.length < 16) return;
  frames++;
  bytes += data.length;
  if ((data[1] & 1) === 1) keys++;
  socket.send(`a,${new DataView(data.buffer, data.byteOffset).getUint32(2)}`);
};
socket.onerror = () => {
  console.log(`no answer from voxl on 127.0.0.1:${port}`);
  process.exit(1);
};
setTimeout(() => {
  console.log(JSON.stringify({ size: hello, frames, keys, kbytes: Math.round(bytes / 1024) }));
  socket.close();
  process.exit(hello ? 0 : 1);
}, Number(seconds) * 1000);
