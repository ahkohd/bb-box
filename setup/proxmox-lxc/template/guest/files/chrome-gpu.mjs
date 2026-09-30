// bb-box: print Chrome's GPU status from the DevTools protocol (SystemInfo.getInfo).
// usage: node chrome-gpu.mjs [port]   (Chrome started with --remote-debugging-port)
const port = process.argv[2] ?? "9222";
const deadline = Date.now() + 20000;
let version;
while (!version) {
  try {
    version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  } catch {
    if (Date.now() > deadline) throw new Error("Chrome's DevTools endpoint did not answer");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
const reply = await new Promise((resolve) => {
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id === 1) resolve(message);
  };
  ws.send(JSON.stringify({ id: 1, method: "SystemInfo.getInfo" }));
});
ws.close();
const gpu = reply.result.gpu;
const active = gpu.devices.find((device) => device.active) ?? gpu.devices[0];
console.log(
  JSON.stringify({
    browser: version.Browser,
    renderer: gpu.auxAttributes?.glRenderer,
    gl: gpu.auxAttributes?.glImplementationParts,
    device: `${active.vendorString || active.vendorId} ${active.deviceString || active.deviceId} ${active.driverVendor} ${active.driverVersion}`,
    featureStatus: gpu.featureStatus,
  }),
);
