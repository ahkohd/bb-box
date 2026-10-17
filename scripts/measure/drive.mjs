// Drives one viewer in headless Chrome over CDP (port 9222) through BB's
// server, for a desktop showing scene.html (060): idle, then text sharpness
// against web/ref.png, a drag of the block, wheel scrolling with keys, and
// keys alone. Sharpness is measured still and halfway through the drag.
// Waits for ./go, made once the viewer has control. Writes raw-<label>.json.
// usage: BOX=<id> VIEWER=<id> [REFRESH=viewer] [QUALITY=<0-9>] [WS=<url>] [DRAG_Y=<css px>] node drive.mjs <video|vnc> <label> <width>x<height> <scale>
import { existsSync, writeFileSync } from "node:fs";
const [kind, label, size, scale = "1"] = process.argv.slice(2);
const [width, height] = size.split("x").map(Number);
const target = await (await fetch("http://127.0.0.1:9222/json/new?about:blank", { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const waits = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
// REFRESH and QUALITY: the box's display refresh and quality, as the panel reads them.
const q = new URLSearchParams({ kind, box: process.env.BOX, viewer: process.env.VIEWER, scale, refresh: process.env.REFRESH ?? "", quality: process.env.QUALITY ?? "", dragY: process.env.DRAG_Y ?? "", ...(process.env.WS ? { ws: process.env.WS } : {}) });
await send("Page.navigate", { url: `http://127.0.0.1:7000/page.html?${q}` });
const t0 = Date.now();
while (!(await ev("window.ready === true && window.connected()").catch(() => false))) {
  if (Date.now() - t0 > 40000) { console.log(JSON.stringify({ label, error: "not connected" })); process.exit(1); }
  await sleep(250);
}
writeFileSync("connected", String(Date.now()));
while (!process.env.NO_GO && !existsSync("go")) await sleep(200);
await ev("window.control(), true");
const s = Number(scale);
await ev(`window.click(${Math.round(40 * s)}, ${Math.round(height - 60 * s)})`);
await sleep(1500);
const clock = await ev("[Date.now(), performance.now()]");
const at = () => ev("performance.now()");
const phases = {};
phases.idle = [await at()]; await sleep(3000); phases.idle.push(await at());
// Sharpness of each region: the fixed text, the coloured text, and the block's coloured text.
const sharpness = () => ev(`(async () => { const out = {}; for (const name of ["text", "colour", "moving"]) out[name] = await window.ssim(name); return out; })()`).catch((error) => `error ${error.message}`);
const ssim = await sharpness();
// The text's sharpness again halfway through the drag: the picture in motion, which the encoder may blur.
phases.drag = [await at()]; await ev("window.dragging = window.drag(10), true"); await sleep(5000);
const ssimDrag = await sharpness();
await ev("window.dragging"); phases.drag.push(await at());
await sleep(1500);
phases.scroll = [await at()]; await ev("window.scroll(10)"); phases.scroll.push(await at());
await sleep(1500);
phases.keys = [await at()];
for (let i = 0; i < 15; i++) { await ev("window.press(), true"); await sleep(400); }
phases.keys.push(await at());
await sleep(500);
const raw = await ev("JSON.stringify({ log: window.log, rowsLog: window.rowsLog, moves: window.moves, presses: window.presses, bytes: window.bytes, encodings: window.encodings ?? null })");
writeFileSync(`raw-${label}.json`, JSON.stringify({ label, kind, size, scale: s, clock, phases, ssim, ssimDrag, ...JSON.parse(raw) }));
console.log(JSON.stringify({ label, kind, ssim, ssimDrag, clock }));
process.exit(0);
