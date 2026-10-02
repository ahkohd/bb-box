// Renders every preview scene with headless Chrome, in both themes, into
// the directory given (default scripts/preview/out). Run from the repository
// root after `bb plugin build`; needs google-chrome, python3 and Node 22.
// It drives Chrome over its debugging protocol, waits for the harness to
// say it is ready, and clips the screenshot to the frame.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = process.argv[2] ?? "scripts/preview/out";
const only = process.argv[3] ? process.argv[3].split(",") : null;
const SCENES = [
  "panel-empty", "panel-nobackend", "panel-list", "panel-list-narrow", "panel-list-open", "panel-runs-on", "panel-problems", "panel-chooser", "panel-chooser-on", "panel-chooser-filter", "panel-chooser-profile", "panel-chooser-display", "panel-chooser-windows", "panel-chooser-narrow", "panel-chooser-custom", "panel-refused", "panel-menu", "panel-release",
  "desktop-connecting", "desktop-stopped", "desktop-released", "desktop-chooser", "boxes-page", "boxes-page-empty", "boxes-page-starting", "terminal", "terminal-ended", "terminal-stopped", "settings", "settings-machines-empty", "settings-machines-add", "settings-setup", "settings-setup-off", "settings-kind", "settings-kind-short",
];
const PORT = 8765;
const DEBUG = 9222;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir(out, { recursive: true });
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { stdio: "ignore" });
// A profile of its own, so a run killed half-way leaves nothing for the next to trip on.
const profile = await mkdtemp(join(tmpdir(), "bb-box-preview-"));
const chrome = spawn("google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${profile}`, `--remote-debugging-port=${DEBUG}`, "--window-size=1200,1200", "about:blank"], { stdio: "ignore" });
process.on("exit", () => {
  server.kill();
  chrome.kill();
  void rm(profile, { recursive: true, force: true });
});
for (let tries = 0; ; tries++) {
  try {
    await fetch(`http://127.0.0.1:${DEBUG}/json/version`);
    break;
  } catch {
    if (tries > 50) throw new Error("Chrome did not open its debugging port.");
    await sleep(200);
  }
}

/** One page over the debugging protocol. */
async function openPage() {
  const target = await (await fetch(`http://127.0.0.1:${DEBUG}/json/new?about:blank`, { method: "PUT" })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  return { send, evaluate, close: () => socket.close() };
}

const page = await openPage();
await page.send("Page.enable");
await page.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 1200, deviceScaleFactor: 2, mobile: false });
let count = 0;
for (const scene of SCENES) {
  if (only && !only.includes(scene)) continue;
  for (const theme of ["dark", "light"]) {
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 1200, deviceScaleFactor: 2, mobile: false });
    await page.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/scripts/preview/index.html?${scene}-${theme}#${scene}&${theme}` });
    let ready = false;
    for (let tries = 0; tries < 150 && !ready; tries++) {
      await sleep(200);
      ready = await page.evaluate("document.documentElement.dataset.ready === '1'").catch(() => false);
    }
    if (!ready) {
      console.error(`not ready: ${scene} ${theme}: ${await page.evaluate("document.documentElement.dataset.error ?? 'no error'").catch(() => "unknown")}`);
      continue;
    }
    await sleep(300);
    // The viewport is sized to the frame, so fixed overlays such as menus and
    // popovers land where they would in BB, and the clip is the frame. It
    // stays wider than BB's compact breakpoint, so menus and popovers keep
    // their desktop form rather than becoming bottom sheets.
    const box = await page.evaluate("(() => { const r = document.getElementById('frame').getBoundingClientRect(); return { x: 0, y: 0, width: Math.ceil(r.width + 32), height: Math.ceil(Math.min(r.height + 32, 1600)) }; })()");
    // A scene may ask for a narrow viewport (`viewport`), for the layout under Tailwind's sm breakpoint.
    const least = await page.evaluate("(window.__scene && window.__scene.viewport) || 820");
    await page.send("Emulation.setDeviceMetricsOverride", { width: Math.max(box.width, least), height: box.height, deviceScaleFactor: 2, mobile: false });
    await sleep(300);
    const shot = await page.send("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 2 } });
    await writeFile(`${out}/${scene}-${theme}.png`, Buffer.from(shot.data, "base64"));
    count++;
  }
}
page.close();
console.log(`${count} screenshots in ${out}`);
process.exit(0);
