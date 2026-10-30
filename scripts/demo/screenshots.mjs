import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "screenshots";
mkdirSync(out, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.DEMO_CDP_URL ?? "http://127.0.0.1:9222");
const context = browser.contexts()[0];
const page = context.pages()[0];
await page.emulateMedia({ colorScheme: "dark" });
const pause = (ms) => page.waitForTimeout(ms);
const shoot = async (name) => {
  await page.mouse.move(1279, 799);
  await pause(800);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(name);
};
const button = (name, options = {}) => page.getByRole("button", { name, ...options });

await page.goto(process.env.DEMO_BB_URL ?? "http://localhost:4999/", { waitUntil: "networkidle" });
await pause(1500);
await page.getByRole("textbox", { name: "Ask anything." }).click();
await page.keyboard.type("Get a Linux desktop box and open getbb.app on it.");
await page.keyboard.press("Enter");
await page.getByText(/is open on/).first().waitFor({ timeout: 240000 });
await pause(1000);

await button("Show right panel (Ctrl + J)").click();
await pause(600);
await button("Open new tab (Ctrl + T)").click();
await pause(400);
await button("Box", { exact: true }).click();
await pause(800);
await button("Maximize pane").click();
await pause(1200);

await button("New box").click();
await pause(1500);
await shoot("new-box-form");

await button("Create box").click();
await page.getByRole("button", { name: "Open terminal" }).nth(1).waitFor({ timeout: 120000 });
await page.getByText(/BB machine in/).nth(1).waitFor({ timeout: 120000 });
await pause(1500);
await shoot("box-panel");

await button("Open desktop").first().click();
await pause(6000);
await shoot("desktop-box");

await button("Box", { exact: true }).click();
await pause(800);
await button("Open terminal").nth(1).click();
await page.getByText("Connected").first().waitFor({ timeout: 60000 });
await pause(1500);
await page.locator(".xterm").last().click();
await page.keyboard.type("uname -sm && nproc", { delay: 40 });
await page.keyboard.press("Enter");
await pause(2000);
await shoot("terminal-box");

await button("Box", { exact: true }).click();
await pause(800);
const desktopBox = (await page.locator('button[aria-label$=": details"]').first().getAttribute("aria-label")).replace(/: details$/, "");
await button("Open terminal").first().click();
await page.getByText("Connected").first().waitFor({ timeout: 60000 });
await pause(1500);
await page.locator(".xterm").last().click();
await page.keyboard.type("clear; sudo apt-get install -y -qq stress-ng >/dev/null 2>&1; stress-ng --cpu 3 --vm 1 --vm-bytes 3G --timeout 120s >/dev/null 2>&1 &", { delay: 10 });
await page.keyboard.press("Enter");
await pause(25000);

await button("Desktop", { exact: true }).click();
await pause(1500);
await button("Machine status").click();
await pause(1500);
await button("Machine", { exact: true }).click();
await pause(800);
await page.getByRole("listbox", { name: "Machines" }).locator("[data-machine-index]").filter({ hasText: desktopBox }).first().click();
await pause(15000);
await button("Open", { exact: true }).click();
await pause(1000);
await page.screenshot({ path: `${out}/monitor.png` });
console.log("monitor");

await page.keyboard.press("Escape");
await pause(500);
await button("Box", { exact: true }).click();
await pause(800);
await button("Machine", { exact: true }).click();
await pause(800);
await page.getByRole("listbox", { name: "Machines" }).locator("[data-machine-index]").first().click();
await pause(8000);
await page.getByRole("button", { name: /^Threads on / }).click();
await pause(1000);
const around = async (locator) => locator.boundingBox();
const panel = await around(page.locator("[data-bb-box-monitor-shell]"));
const menu = await around(page.getByRole("menu"));
const left = Math.min(panel.x, menu.x) - 8;
const top = Math.min(panel.y, menu.y) - 8;
const right = Math.max(panel.x + panel.width, menu.x + menu.width) + 8;
const bottom = Math.min(panel.y + 260, 800);
await page.screenshot({ path: `${out}/monitor-threads.png`, clip: { x: left, y: top, width: right - left, height: bottom - top } });
console.log("monitor-threads");

await browser.close().catch(() => {});
