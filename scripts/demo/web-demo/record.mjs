import { createRequire } from "node:module";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const usage = "usage: node record.mjs <steps.mjs> <take dir> [--theme dark|light] [--cdp http://127.0.0.1:9222]";
const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    theme: { type: "string", default: "dark" },
    cdp: { type: "string", default: process.env.WEB_DEMO_CDP_URL ?? "http://127.0.0.1:9222" },
  },
});
const [stepsPath, takeDir] = positionals;
if (!stepsPath || !takeDir || !["dark", "light"].includes(options.theme)) {
  console.error(usage);
  process.exit(2);
}

const defaultScript = {
  viewport: { width: 1280, height: 800 },
  scale: 2,
  settleMs: 1500,
  leadInMs: 1200,
  tailMs: 500,
  pointer: { start: { x: 900, y: 520 }, glideMs: 520, restMs: 100 },
  jpegQuality: 92,
  pageTextEveryMs: 500,
};

function importPlaywright() {
  const searchFrom = [process.cwd(), process.env.WEB_DEMO_TOOLS ?? `${homedir()}/.web-demo`];
  for (const directory of searchFrom) {
    try {
      return createRequire(`${resolve(directory)}/`)("playwright");
    } catch {}
  }
  throw new Error(`Playwright not found from ${searchFrom.join(" or ")}. Run install-tools.sh first.`);
}

const pointerSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path d="M4 2.5v17.2l4.6-4.3 3 6.6 2.9-1.3-3-6.5 6.3-.2z" fill="#0a0a0a" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

function placePointer({ svg, start, glideMs, x, y }) {
  let pointer = document.getElementById("web-demo-pointer");
  if (!pointer) {
    pointer = document.createElement("div");
    pointer.id = "web-demo-pointer";
    pointer.innerHTML = svg;
    Object.assign(pointer.style, {
      position: "fixed",
      left: "0",
      top: "0",
      zIndex: "2147483647",
      pointerEvents: "none",
      transform: `translate(${start.x}px, ${start.y}px)`,
      transition: `transform ${glideMs}ms cubic-bezier(0.23, 1, 0.32, 1)`,
      filter: "drop-shadow(0 1px 2px rgb(0 0 0 / 0.4))",
    });
  }
  if (!pointer.isConnected) {
    document.body.appendChild(pointer);
    pointer.getBoundingClientRect();
  }
  if (x !== undefined) pointer.style.transform = `translate(${x - 4}px, ${y - 3}px)`;
}

function startScreencast(cdp, framesDir, size, jpegQuality) {
  const frames = [];
  let count = 0;
  cdp.on("Page.screencastFrame", async (frame) => {
    const name = `f${String(count++).padStart(5, "0")}.jpg`;
    writeFileSync(`${framesDir}/${name}`, Buffer.from(frame.data, "base64"));
    frames.push({ name, at: frame.metadata.timestamp });
    await cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
  });
  return cdp
    .send("Page.startScreencast", { format: "jpeg", quality: jpegQuality, maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 })
    .then(() => frames);
}

function visiblePageText() {
  const values = [...document.querySelectorAll("input, textarea")].map((field) => field.value).filter(Boolean);
  return [document.title, document.body.innerText, ...values].join("\n");
}

function samplePageText(page, everyMs) {
  const samples = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const text = await page.evaluate(visiblePageText).catch(() => null);
      if (text !== null && text !== samples.at(-1)?.text) samples.push({ at: Date.now() / 1000, text });
      await new Promise((done) => setTimeout(done, everyMs));
    }
  })();
  return async () => {
    running = false;
    await loop;
    return samples;
  };
}

function demoFor({ page, script, theme }) {
  const events = [];
  const speedUps = [];
  const posters = [];
  const now = () => Date.now() / 1000;
  const pause = (ms) => page.waitForTimeout(ms);
  const pointer = { svg: pointerSvg, ...script.pointer };

  async function glideTo(locator, { timeout = 120000 } = {}) {
    await locator.waitFor({ state: "visible", timeout });
    const box = await locator.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.evaluate(placePointer, { ...pointer, x, y });
    await pause(pointer.glideMs + pointer.restMs);
    return { x, y };
  }

  return {
    page,
    theme,
    pause,
    glideTo,
    mark(label) {
      events.push({ label, at: now() });
      console.log(`${label} @${events.length > 1 ? (events.at(-1).at - events[0].at).toFixed(1) : "0.0"}`);
    },
    async click(locator, options) {
      const { x, y } = await glideTo(locator, options);
      await page.mouse.click(x, y);
    },
    async type(text, { delayMs = 42 } = {}) {
      await page.keyboard.type(text, { delay: delayMs });
    },
    async press(key) {
      await page.keyboard.press(key);
    },
    async wait(condition, { speedUp = 1, keepStartMs = 600, keepEndMs = 400 } = {}) {
      const from = now();
      const result = await (typeof condition === "function" ? condition() : condition);
      const to = now();
      if (speedUp > 1) speedUps.push({ from: from + keepStartMs / 1000, to: to - keepEndMs / 1000, times: speedUp });
      return result;
    },
    poster({ afterMs = 0, name = "poster" } = {}) {
      posters.push({ name, at: now() + afterMs / 1000 });
    },
    recorded: () => ({ events, speedUps, posters }),
  };
}

const steps = (await import(pathToFileURL(resolve(stepsPath)).href)).default;
const script = { ...defaultScript, ...steps, pointer: { ...defaultScript.pointer, ...steps?.pointer } };
if (typeof script.run !== "function" || !script.url) throw new Error(`${stepsPath} must export default { url, run(demo) }.`);
const size = { width: script.viewport.width * script.scale, height: script.viewport.height * script.scale };

const { chromium } = importPlaywright();
const browser = await chromium.connectOverCDP(options.cdp);
const context = browser.contexts()[0];
const page = context.pages()[0] ?? (await context.newPage());
const cdp = await context.newCDPSession(page);
await cdp.send("Emulation.setDeviceMetricsOverride", { ...script.viewport, deviceScaleFactor: script.scale, mobile: false });
await page.emulateMedia({ colorScheme: options.theme });

await page.goto(script.url, { waitUntil: "networkidle" });
if (script.prepare) await script.prepare({ page, theme: options.theme });
await page.waitForTimeout(script.settleMs);
await page.evaluate(placePointer, { svg: pointerSvg, ...script.pointer });

const demo = demoFor({ page, script, theme: options.theme });
const framesDir = `${takeDir}/frames`;
rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });
const frames = await startScreencast(cdp, framesDir, size, script.jpegQuality);
const stopSampling = samplePageText(page, script.pageTextEveryMs);
const measured = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio }));
demo.mark("start");
await page.waitForTimeout(script.leadInMs);

let failure;
try {
  await script.run(demo);
} catch (error) {
  failure = error;
}
demo.mark("end");
await cdp.send("Page.stopScreencast");
const pageText = await stopSampling();
await page.waitForTimeout(script.tailMs);
writeFileSync(`${takeDir}/page-text.json`, JSON.stringify(pageText, null, 1));

const take = { steps: resolve(stepsPath), theme: options.theme, viewport: script.viewport, scale: script.scale, measured, ...demo.recorded(), frames };
writeFileSync(`${takeDir}/take.json`, JSON.stringify(take, null, 1));
console.log(`${frames.length} frames, ${(take.events.at(-1).at - take.events[0].at).toFixed(1)} s, viewport ${measured.width}x${measured.height}@${measured.scale}, in ${takeDir}`);
await browser.close().catch(() => {});
if (failure) {
  console.error(`The steps failed: ${failure.stack ?? failure}`);
  process.exit(1);
}
