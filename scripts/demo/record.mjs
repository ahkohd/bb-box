import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
const out = process.argv[2] ?? "take";
mkdirSync(`${out}/frames`, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.DEMO_CDP_URL ?? "http://127.0.0.1:9222");
const context = browser.contexts()[0];
const page = context.pages()[0];
await page.emulateMedia({ colorScheme: process.env.DEMO_THEME === "light" ? "light" : "dark" });
const pause = (ms) => page.waitForTimeout(ms);
const events = [];
const mark = (label) => { events.push({ label, at: Date.now() / 1000 }); console.log(label); };

await page.goto(process.env.DEMO_BB_URL ?? "http://localhost:4999/", { waitUntil: "networkidle" });
await pause(1500);

const pointer = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path d="M4 2.5v17.2l4.6-4.3 3 6.6 2.9-1.3-3-6.5 6.3-.2z" fill="#0a0a0a" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
await page.evaluate((svg) => {
  const cursor = document.createElement("div");
  cursor.id = "demo-pointer";
  cursor.innerHTML = svg;
  Object.assign(cursor.style, { position: "fixed", left: "0", top: "0", zIndex: "2147483647", pointerEvents: "none", transform: "translate(900px, 520px)", transition: "transform 520ms cubic-bezier(0.23, 1, 0.32, 1)", filter: "drop-shadow(0 1px 2px rgb(0 0 0 / 0.4))" });
  document.body.appendChild(cursor);
}, pointer);

async function glideTo(locator) {
  await locator.waitFor({ state: "visible", timeout: 120000 });
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.evaluate(([px, py]) => {
    const cursor = document.getElementById("demo-pointer");
    if (!cursor.isConnected) document.body.appendChild(cursor);
    cursor.style.transform = `translate(${px - 4}px, ${py - 3}px)`;
  }, [x, y]);
  await pause(620);
  return { x, y };
}
async function click(locator) {
  const { x, y } = await glideTo(locator);
  await page.mouse.click(x, y);
}

const cdp = await context.newCDPSession(page);
let count = 0;
const frames = [];
cdp.on("Page.screencastFrame", async (frame) => {
  const name = `f${String(count++).padStart(5, "0")}.jpg`;
  writeFileSync(`${out}/frames/${name}`, Buffer.from(frame.data, "base64"));
  frames.push({ name, at: frame.metadata.timestamp });
  await cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 2560, maxHeight: 1600, everyNthFrame: 1 });
mark(`start ${await page.evaluate(() => `${innerWidth}x${innerHeight}@${devicePixelRatio}`)}`);
await pause(1200);

await click(page.getByRole("textbox", { name: "Ask anything." }));
await pause(300);
mark("type");
await page.keyboard.type("Get a Linux desktop box and open getbb.app on it.", { delay: 42 });
await pause(500);
await page.keyboard.press("Enter");
mark("sent");
await page.getByText(/is open on/).first().waitFor({ timeout: 240000 });
mark("agent done");
const desktopBox = /is open on (\S+?)'s desktop/.exec(await page.getByText(/is open on/).first().textContent())[1];
await pause(1200);

await click(page.getByRole("button", { name: "Show right panel (Ctrl + J)" }));
await pause(700);
mark("panel");
await click(page.getByRole("button", { name: "Open new tab (Ctrl + T)" }));
await pause(500);
await click(page.getByRole("button", { name: "Box", exact: true }));
await pause(1500);
mark("box panel");
await click(page.getByRole("button", { name: "Open desktop" }).first());
mark("desktop");
await pause(2500);
await click(page.getByRole("button", { name: "Maximize pane" }));
mark("maximized");
await pause(1500);
await click(page.getByRole("button", { name: "Machine status" }));
await pause(900);
const monitorHeader = page.locator("[data-bb-box-monitor-header]");
await click(monitorHeader.getByRole("button", { name: "Machine", exact: true }));
await pause(500);
await click(page.getByRole("listbox", { name: "Machines" }).locator("[data-machine-index]").filter({ hasText: desktopBox }).first());
mark("monitor");
await pause(4000);
await click(page.getByRole("button", { name: "Hide machine status" }));
await pause(600);
await click(page.getByRole("button", { name: "Restore split" }));
await pause(900);

await click(page.getByRole("button", { name: "Box", exact: true }));
await pause(900);
mark("new box");
await click(page.getByRole("button", { name: "New box" }));
await pause(1600);
await click(page.getByRole("button", { name: "Create box" }));
mark("created");
await page.getByRole("button", { name: "Open terminal" }).nth(1).waitFor({ timeout: 120000 });
await page.getByText(/Ready in/).nth(1).waitFor({ timeout: 120000 });
mark("server ready");
await pause(1500);
await click(page.getByRole("button", { name: "Open terminal" }).nth(1));
await page.getByText("Connected").first().waitFor({ timeout: 60000 });
await pause(1500);
await click(page.locator(".xterm").last());
mark("terminal");
await page.keyboard.type("uname -sm && nproc", { delay: 70 });
await pause(300);
await page.keyboard.press("Enter");
await pause(3000);
mark("end");
await cdp.send("Page.stopScreencast");
await pause(500);
writeFileSync(`${out}/frames.json`, JSON.stringify({ frames, events }, null, 1));
console.log(`frames ${frames.length}`);
await browser.close().catch(() => {});
